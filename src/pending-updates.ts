/**
 * The journal for the desktop manager's only update shape: remove, then add.
 *
 * dsh 0.2.1's plugin manager has no in-place update (#896): `add` on a package
 * the profile already declares is refused before pnpm runs. Every update on
 * that host is therefore two operations — `removeBundle` and `installBundle` —
 * and the first one writes the profile. When the host's own reload never
 * returns (its reconciliation awaits plugin lifecycles with no deadline), the
 * removal is already on disk and the replacement never runs: after the next
 * restart the plugin is simply gone (#928).
 *
 * This journal is written BEFORE the removal and cleared only once the install
 * settles. The next start reads it and puts back whatever is missing, so an
 * interrupted update ends as "installed, one restart later" instead of as a
 * plugin the user has to notice is gone.
 *
 * The file lives beside the market's other per-profile state
 * (`<profile>/.dsh-market/`), not in the market's memory and not in DSH home:
 * a profile copied or reset elsewhere must not inherit another profile's
 * unfinished update, and a test that builds a throwaway profile must not touch
 * the real one.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logEvent } from './log.ts'
import { readInstalledManifest, readInstalledVersion, readManifestDeps, readProfileBundles } from './profile.ts'

/** One removal that has not been answered by a settled install. */
export interface PendingUpdate {
  id: string
  profile: string
  name: string
  /** Version present before the removal; empty when the manifest could not tell. */
  from: string
  /** Exact version being installed; empty when the spec was a range or tag. */
  to: string
  /** The spec the user's update targeted, used when `to` is not exact. */
  spec: string
  step: 'removing' | 'installing'
  attempts: number
  startedAt: string
}

export interface PendingUpdateInput {
  profile: string
  name: string
  from: string
  to: string
  spec: string
}

interface PendingUpdateState {
  version: 1
  operations: PendingUpdate[]
}

const STATE_VERSION = 1 as const

/**
 * The per-profile journal file.
 *
 * The market's other durable per-profile state (`state.json`, `log.ndjson`)
 * already lives in this directory, so this needs no new location, no DSH home
 * resolution, and no path handed down from the host.
 */
export function pendingUpdatesFile(profileDirectory: string): string {
  return join(profileDirectory, '.dsh-market', 'pending-updates.json')
}

export class PendingUpdateJournal {
  constructor(readonly file: string) {}

  static forProfile(profileDirectory: string): PendingUpdateJournal {
    return new PendingUpdateJournal(pendingUpdatesFile(profileDirectory))
  }

  list(): PendingUpdate[] {
    return this.read().operations
  }

  /**
   * Record an update that is about to unload its plugin. Upserts by
   * profile+name: a retry of the same update replaces the earlier record
   * instead of leaving a second one to repair on the next start.
   */
  begin(input: PendingUpdateInput): PendingUpdate {
    const state = this.read()
    const existing = state.operations.find(entry => entry.profile === input.profile && entry.name === input.name)
    if (existing !== undefined) {
      Object.assign(existing, input, { step: 'removing' as const, startedAt: new Date().toISOString() })
      this.write(state)
      return existing
    }
    const record: PendingUpdate = {
      id: randomUUID(),
      ...input,
      step: 'removing',
      attempts: 0,
      startedAt: new Date().toISOString(),
    }
    state.operations.push(record)
    this.write(state)
    return record
  }

  mark(id: string, step: PendingUpdate['step']): void {
    const state = this.read()
    const record = state.operations.find(entry => entry.id === id)
    if (record === undefined) return
    record.step = step
    this.write(state)
  }

  /** The install settled: there is nothing left to repair for this package. */
  finish(id: string): void {
    const state = this.read()
    const remaining = state.operations.filter(entry => entry.id !== id)
    if (remaining.length === state.operations.length) return
    this.write({ version: STATE_VERSION, operations: remaining })
  }

  /**
   * Drop any record for one package. An explicit uninstall supersedes an
   * interrupted update; repairing afterwards would resurrect a plugin the
   * user just removed on purpose.
   */
  forget(profile: string, name: string): void {
    const state = this.read()
    const remaining = state.operations.filter(entry => entry.profile !== profile || entry.name !== name)
    if (remaining.length === state.operations.length) return
    this.write({ version: STATE_VERSION, operations: remaining })
  }

  /** Count a start that could not settle it, without forgetting the record. */
  bump(id: string): void {
    const state = this.read()
    const record = state.operations.find(entry => entry.id === id)
    if (record === undefined) return
    record.attempts += 1
    this.write(state)
  }

  private read(): PendingUpdateState {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PendingUpdateState> | null
      if (parsed !== null && parsed.version === STATE_VERSION && Array.isArray(parsed.operations)) {
        // A record written by an older shape is dropped rather than trusted:
        // repairing from half a record can reinstall the wrong package.
        const operations = (parsed.operations as PendingUpdate[]).filter(entry =>
          typeof entry === 'object' && entry !== null
          && typeof entry.id === 'string'
          && typeof entry.profile === 'string'
          && typeof entry.name === 'string')
        return { version: STATE_VERSION, operations }
      }
    } catch { /* missing, unreadable, or corrupt: nothing can be repaired from it */ }
    return { version: STATE_VERSION, operations: [] }
  }

  /** Same-directory replace: a crash mid-write leaves the previous journal, not half a record. */
  private write(state: PendingUpdateState): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`)
    renameSync(temp, this.file)
  }
}

/** A desktop-manager call that did not settle within its deadline. */
export class DeadlineExceeded extends Error {
  constructor(readonly label: string, readonly ms: number) {
    super(`${label} did not settle within ${ms} ms`)
    this.name = 'DeadlineExceeded'
  }
}

/**
 * Bound a manager call that the host should answer but may never do.
 *
 * The host's reconciliation has no deadline of its own, so a plugin whose
 * lifecycle never settles takes the promise with it: the route waits forever
 * and the UI keeps saying "updating". A deadline cannot cancel the host, but
 * it ends the market's wait, and the journal makes the next start finish the
 * job.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DeadlineExceeded(label, ms)), ms)
        // Never keep a finished process alive just to reject a promise.
        ;(timer as { unref?: () => void }).unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The subset of the desktop manager repair needs; structural on purpose. */
export interface RepairManager {
  installBundle(
    spec: string,
    options?: { requestId?: string },
  ): Promise<{ application: string; error?: unknown; packageResult?: { exitCode: number | null } }>
  /**
   * Optional so a minimal manager still works. Needed when the interrupted
   * update died between its install being refused and its removal landing:
   * the dependency line is still there, so `add` answers `already-installed`.
   */
  removeBundle?(name: string): Promise<{ application: string; error?: unknown }>
}

export interface RepairOptions {
  profile: string
  profileDirectory: string
  manager: RepairManager
  journal?: PendingUpdateJournal
  timeoutMs?: number
}

export type RepairFailureCause =
  | 'version-changed' | 'refused' | 'not-composed' | 'timeout' | 'unknown' | 'abandoned'
  /** The reinstall did not run, but the build from before the update is installed and loaded. */
  | 'kept-old'

export interface RepairReport {
  /** Packages a previous start removed and this one put back. */
  reinstalled: string[]
  /** Records that needed no work: the profile already held a settled version. */
  finished: string[]
  failed: Array<{ name: string; reason: string; cause: RepairFailureCause }>
  /** Packages the market has stopped retrying by itself (see MAX_AUTO_REPAIR_ATTEMPTS). */
  abandoned: string[]
}

export const REPAIR_INSTALL_TIMEOUT_MS = 300_000

/**
 * How many starts may each spend up to REPAIR_INSTALL_TIMEOUT_MS trying to put
 * one package back before the market stops trying by itself.
 *
 * Retrying is right while the cause might be transient (offline, a registry
 * briefly down, the host still shutting down). It stops being right when every
 * start pays the full timeout for a spec that will never install — the shape a
 * reporter lived through on the Desktop host (#1061: five days of failing
 * reinstalls on every boot, all of it invisible). The record is kept, so the
 * package is not forgotten; only the automatic attempt stops, and the user is
 * told where to act.
 */
export const MAX_AUTO_REPAIR_ATTEMPTS = 3

/** What the user is told once the cap is reached: what, why, and what to do. */
function gaveUpCopy(name: string, attempts: number): string {
  return `${name} 还没装回来：之前 ${String(attempts)} 次启动都没能装好，市场不再自动重试。请到「设置 → 插件」重新安装它 / ${name} is still missing: ${String(attempts)} starts could not reinstall it, so the market stopped retrying — reinstall it from Settings → Plugins`
}

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/** The manager's own code, when it named one, so a log line says why and not just "refused". */
function withCode(message: string, code: string | undefined): string {
  return code === undefined ? message : `${message} [${code}]`
}

function managerSucceeded(result: { application: string }): boolean {
  return result.application === 'applied'
    || result.application === 'restart-required'
    || result.application === 'overridden'
}

/**
 * Whether this profile is actually composed with the package.
 *
 * `readInstalledVersion` only looks at node_modules, and the half-removed
 * state #928 describes is exactly "still on disk, no longer declared" —
 * treating that as settled cleared the record while the plugin was not
 * composed at all (#949 review). Being declared is necessary but not
 * sufficient: a package that loads through the bundle layer is composed only
 * when the profile lists it in `dsh.profile.bundles`, and the desktop manager
 * can fail at its application stage AFTER writing the build and the
 * dependency but BEFORE that row (#928) — the reporter's restart restored
 * files and dependencies, left `dsh.profile.bundles` without the name, and
 * the record said "recorded as finished".
 *
 * The row is required only of a package that declares `dsh.bundle`: a
 * client-only package has no bundle layer to be listed in, and demanding the
 * row of one would reinstall it on every start.
 */
function composed(profile: string, profileDirectory: string, name: string): boolean {
  if (!Object.hasOwn(readManifestDeps(profile, profileDirectory), name)) return false
  const manifest = readInstalledManifest(profile, name, profileDirectory)
  const dsh = (manifest as { dsh?: { bundle?: unknown } } | null)?.dsh
  if (dsh?.bundle === undefined) return true
  return readProfileBundles(profileDirectory).includes(name)
}

/**
 * Drop a profile write lock whose owner is gone.
 *
 * A host killed mid-update leaves `<profile>/package.json.lock` naming a PID
 * that no longer exists; the repair's reinstall then waits out the full lock
 * timeout and fails, every start (#914's premise, applied to this path). A
 * live PID — including this very process — is never touched.
 */
export function clearStaleProfileLock(profileDirectory: string): boolean {
  const file = join(profileDirectory, 'package.json.lock')
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return false
  }
  const pid = Number(raw.trim())
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    // EPERM means the process exists and belongs to someone else.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
  }
  try {
    unlinkSync(file)
    logEvent('warn', 'update-repair', `cleared a stale profile write lock left by pid ${String(pid)}`)
    return true
  } catch {
    return false
  }
}

/**
 * Finish or forget every update an earlier run left half-applied.
 *
 * Called once the composition has settled. A record is resolved by looking at
 * what is actually on disk, never by what the interrupted call intended:
 *
 * - the requested version, or the version from before, is installed: the
 *   profile is coherent, drop the record;
 * - nothing is installed: the removal won, put the package back;
 * - some other version is installed: the user may have chosen it, so leave it
 *   alone and keep the record for the log instead of fighting them.
 */
export async function repairInterruptedUpdates(options: RepairOptions): Promise<RepairReport> {
  const journal = options.journal ?? PendingUpdateJournal.forProfile(options.profileDirectory)
  const report: RepairReport = { reinstalled: [], finished: [], failed: [], abandoned: [] }
  const pending = journal.list().filter(entry => entry.profile === options.profile)
  for (const entry of pending) {
    const installed = readInstalledVersion(options.profile, entry.name, options.profileDirectory)
    const settled = composed(options.profile, options.profileDirectory, entry.name)
    // Settled means every half agrees: the build is on disk, the profile
    // declares it, and a bundle-layer package is listed as one. "On disk but
    // no longer composed" is the interrupted removal itself, so it falls
    // through to the reinstall.
    if (installed !== null && settled && (entry.to === '' || installed === entry.to || installed === entry.from)) {
      journal.finish(entry.id)
      report.finished.push(entry.name)
      continue
    }
    if (installed !== null && settled) {
      journal.bump(entry.id)
      report.failed.push({
        name: entry.name,
        cause: 'version-changed',
        reason: `installed version ${installed} is neither ${entry.from || 'the previous build'} nor ${entry.to || 'the requested build'}`,
      })
      continue
    }
    if (entry.attempts >= MAX_AUTO_REPAIR_ATTEMPTS) {
      // Not bumped: the count is already the reason this start does nothing,
      // and growing it would re-log the same sentence on every boot.
      if (entry.attempts === MAX_AUTO_REPAIR_ATTEMPTS) {
        logEvent('error', 'update-repair', gaveUpCopy(entry.name, entry.attempts))
      }
      report.failed.push({ name: entry.name, reason: gaveUpCopy(entry.name, entry.attempts), cause: 'abandoned' })
      report.abandoned.push(entry.name)
      continue
    }
    const spec = entry.to === '' ? entry.spec : `${entry.name}@${entry.to}`
    let cause: RepairFailureCause = 'unknown'
    let lastCode: string | undefined
    try {
      // The interrupted update may have died holding the profile lock; its
      // owner is gone by now, and without this the install below waits out
      // the whole timeout on every start.
      clearStaleProfileLock(options.profileDirectory)
      const timeoutMs = options.timeoutMs ?? REPAIR_INSTALL_TIMEOUT_MS
      const install = (): ReturnType<RepairManager['installBundle']> => withDeadline(
        options.manager.installBundle(spec, { requestId: randomUUID() }), timeoutMs, `reinstall ${spec}`)
      let result: Awaited<ReturnType<RepairManager['installBundle']>>
      try {
        result = await install()
      } catch (error) {
        if (errorCodeOf(error) !== 'already-installed') throw error
        result = { application: 'failed', error }
      }
      if (result.application === 'failed' && errorCodeOf(result.error) === 'already-installed'
        && options.manager.removeBundle !== undefined) {
        // The same two steps the normal update takes (#896): the interrupted
        // update stopped before its removal landed, so the dependency is
        // still declared and `add` is refused. Finish the removal, then add.
        const removed = await withDeadline(options.manager.removeBundle(entry.name), timeoutMs, `remove ${entry.name}`)
        if (removed.application === 'failed' || removed.application === 'cancelled') {
          lastCode = errorCodeOf(removed.error)
          cause = 'refused'
          throw new Error(withCode(`the desktop app could not remove the old build first (${removed.application})`, lastCode))
        }
        journal.mark(entry.id, 'installing')
        result = await install()
      }
      lastCode = errorCodeOf(result.error)
      if (!managerSucceeded(result)) {
        // A failed application can still be a written package: pnpm may have
        // installed the new build while only the live start failed — which is
        // exactly the plugin whose teardown is still stuck. The disk is the
        // authority, not the application stage.
        const after = readInstalledVersion(options.profile, entry.name, options.profileDirectory)
        if (after === null || (entry.to !== '' && after !== entry.to)) {
          // The update never landed but the build from before is installed and
          // loaded: nothing is broken and nothing is left to repair, so this
          // is neither a refusal nor a reason to count toward giving up. The
          // user can run the update again from the market.
          if (entry.from !== '' && after === entry.from && composed(options.profile, options.profileDirectory, entry.name)) {
            journal.finish(entry.id)
            report.failed.push({
              name: entry.name,
              cause: 'kept-old',
              reason: withCode(`still on ${after}; the update to ${entry.to || spec} did not run (${result.application})`, lastCode),
            })
            logEvent('warn', 'update-repair',
              withCode(`${entry.name}: the interrupted update did not finish and ${after} is still installed and loaded; the update can be retried from the market (${result.application})`, lastCode))
            continue
          }
          cause = 'refused'
          throw new Error(withCode(`the desktop app refused the reinstall (${result.application})`, lastCode))
        }
        // The files landing is not the same answer as the plugin loading:
        // this manager failed at the application stage, which is the step
        // that writes `dsh.profile.bundles` (#928). Finishing here cleared
        // the record for a package the host still would not compose.
        if (!composed(options.profile, options.profileDirectory, entry.name)) {
          cause = 'not-composed'
          throw new Error(withCode(`the desktop app wrote ${after} but did not compose it — no dsh.profile.bundles row`, lastCode))
        }
        journal.finish(entry.id)
        report.reinstalled.push(entry.name)
        logEvent('warn', 'update-repair',
          `${entry.name}: the interrupted update had already written ${after}; recorded as finished`)
        continue
      }
      journal.finish(entry.id)
      report.reinstalled.push(entry.name)
      logEvent('warn', 'update-repair',
        `${entry.name}: the previous update was interrupted after removing it; reinstalled ${spec} on this start`)
    } catch (error) {
      journal.bump(entry.id)
      const reason = error instanceof Error ? error.message : String(error)
      report.failed.push({ name: entry.name, reason, cause: error instanceof DeadlineExceeded ? 'timeout' : cause })
      logEvent('error', 'update-repair',
        `${entry.name}: could not finish the interrupted update (${reason}); the next start will try again`)
    }
  }
  return report
}
