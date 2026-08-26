/**
 * HTTP routes bridging the browser market UI to the host. This layer only
 * parses requests, calls the service modules, and serializes responses —
 * process spawning lives in dsh-cli.ts, filesystem reads in profile.ts,
 * orchestration in install.ts / themes.ts / updates.ts.
 *
 * Security: the install route executes a shell command, so it accepts only
 * same-origin POSTs and only sources present in the curated registry.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { forgetCatalog, loadRegistry, pluginCategories } from './registry.ts'
import {
  cleanHotDir, hotMount, hotUnmount, listHotMounts,
  mountClientOnlyDeps, purgeMarketState, readMarketState, writeMarketState,
} from './hot.ts'
import { createGroup, deleteGroup, removeFromGroups, renameGroup, setGroupMembers } from './groups.ts'
import { exportLogs, logEvent } from './log.ts'
import { diagnosePackageManifests } from './diagnostics.ts'
import {
  BOOT_ID, cancelActive, probePnpm, progress, provisionPnpm, runDshPlugin,
  type PluginCommandRuntime,
} from './dsh-cli.ts'
import { addProfileBundle, dropFromManifest, hasLoadableEntry, INBOX_BUNDLES, isDshProfileName, profileDir, readInstalled, readInstalledManifest, readInstalledRepoEvidence, readInstalledVersion, readLockCommits, readProfileBundles, readProfileManifestSnapshot, removeProfileBundle, restoreProfileManifest, setAllowBuilds, type ProfileManifestSnapshot } from './profile.ts'
import { assessProfile, classifyPeer, introducedDuplicateNames, introducedRisks, type CompatibilityRisk } from './compatibility.ts'
import { runningAgentIds, type AgentsLookup } from './agents.ts'
import { analyzeProfile, type DuplicateName } from './check.ts'
import { applyBundleOrder, mergeOrder, readBundleRules, readBundleStack, validateOrder } from './order.ts'
import { applyPreset, deletePreset, listPresets, previewPreset, savePreset } from './presets.ts'
import { createProfileSnapshot, DEFAULT_MAX_SNAPSHOTS, deleteSnapshot, listSnapshots, restoreSnapshot } from './snapshot.ts'
import { trialValidate } from './trial.ts'
import { codeloadAllowBuildsKey, findCatalogEntryForLocal, findInstalledAlias, gitAllowBuildsKey, installTargetFor, isLocalSpec, NPM_NAME_RE, repoOfTarget, restoreBlockedByWorkspace, restoreTargetForLocal, workspaceProtocolDeps } from './sources.ts'
import { failureDetail, groupConflictsByOwner, isStaleUpdate, parseIgnoredBuilds, parsePrepareNotAllowed, RELEASE_AGE_OVERRIDE, retargetCollections, validateAddedPlugins, withHoistRecovery } from './install.ts'
import { asChannel, CHANNELS, DIST_TAG, resolveChannel, type Channel } from './channels.ts'
import { asRegion, REGIONS, routesFor, setActiveRegion, type Region } from './regions.ts'
import { resolveRegion } from './region-probe.ts'
import { acceleratedTarget, resolveHeadCommit } from './accelerate.ts'
import { checkUpdates, fetchNpmLatest, invalidateUpdates, isUpgrade, latestPublishedRecently, setUpdateRegistry, versionOnChannel } from './updates.ts'
import { createThemeManager, type LoaderEntry } from './themes.ts'
import { readJsonBody, sameOrigin, sendJson } from './http.ts'
import { detectedSupervisor, restartAllowed, scheduleRestart, servingPort, trustedRestartRequest, trustedDownloadRequest } from './restart.ts'
import { activationAfterReplace, brokenClientBundles, checkClientBundle, hasHostHalf, newlyBrokenBundles, verifyActivation } from './verify.ts'
import {
  carrierDisableIds, disableRow, enableRow, findUserPatchPath, isProtectedModule, packagePatchFlags,
  readUserPatchState, removeRowBlocks, rowIdsForPackage, userPatchPackageReferences,
} from './patch.ts'
import {
  createProfileBackup, downloadWebdav, MAX_BACKUP_BYTES, mergeRestoreManifest, restoreProfileBackup, secretFileCount, unportableDeps, uploadWebdav,
  type ProfileBackup,
} from './backup.ts'
import {
  createGist, fitsGistLimit, GistError, gistErrorCode, parseGistId, readGist, resolveGistTokenSource, updateGist, verifyGistToken,
} from './gist.ts'

export type { LoaderEntry } from './themes.ts'
export type { UpdateStatus } from './updates.ts'

export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

export interface MarketHost {
  webServer: WebServerService
  loader: { entries(): Iterable<LoaderEntry> }
  plugin(plugin: unknown, config: unknown): { await(): Promise<unknown>; dispose(): Promise<unknown> | void }
  on?(event: string, callback: (fiber: { entry?: { options?: { name?: string } } }) => void): () => void
  logger?: { info?(message: string): void; warn(message: string): void }
}

export interface MarketConfig {
  /** Profile the market installs into; matches the profile serving this UI. */
  profile: string
  /** Host-authoritative profile directory; ordinary DSH derives it from DSH_HOME. */
  profileDirectory?: string
  /** Detached self-restart is unsafe under systemd/launchd/pm2; operators can disable it (#14). */
  allowRestart?: boolean
  /** Which release channel the market offers ITSELF from; other plugins never follow it. */
  channel?: Channel
  /** Which mirrors every outbound request uses; undefined until decided. */
  region?: Region
  /** Snapshots retained per profile (issue #98); defaults to DEFAULT_MAX_SNAPSHOTS. */
  maxSnapshots?: number
}

/**
 * The market's own version, read once from its installed package.json.
 *
 * The UI puts this in the page heading so a user's screenshot carries it:
 * most bug reports arrive as a photo of the screen, and without a version
 * in frame the first reply always has to ask which one it was.
 */
let cachedVersion: string | null = null
export function marketVersion(): string {
  if (cachedVersion !== null) return cachedVersion
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    cachedVersion = manifest.version ?? 'unknown'
  } catch {
    cachedVersion = 'unknown'
  }
  return cachedVersion
}

/** The market's own package names, as they appear in a profile manifest. */
const SELF_NAMES = new Set(['dshmarket', 'dsh-market'])

/**
 * Rebuild a GitHub target for an update: revision selectors are deliberately
 * dropped so pnpm resolves the repository again, while one valid `path:`
 * selector is kept because it identifies the package inside a monorepo.
 * pnpm permits both in one fragment (`#main&path:/packages/plugin`).
 */
function githubUpdateTarget(spec: string): string {
  const fragmentAt = spec.indexOf('#')
  if (fragmentAt === -1) return spec
  const repo = spec.slice(0, fragmentAt)
  let subpath: string | null = null
  for (const selector of spec.slice(fragmentAt + 1).split('&')) {
    if (!selector.startsWith('path:/')) continue
    const candidate = selector.slice('path:/'.length)
    const valid = /^[A-Za-z0-9_./-]+$/.test(candidate)
      && !candidate.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
    // Multiple path selectors are ambiguous; an invalid selector is never
    // forwarded to the package manager from a hand-edited profile.
    if (subpath !== null || !valid) return repo
    subpath = candidate
  }
  return subpath === null ? repo : `${repo}#path:/${subpath}`
}

/**
 * Whether an installed package declares a client part (`dsh.client`). Its UI
 * is injected into the page, so toggling it needs a browser refresh to show
 * the change — the install flow prompts the same way via the hot banner.
 */
function packageHasClientPart(profileDirectory: string, name: string): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDirectory, 'node_modules', name, 'package.json'), 'utf8'),
    ) as { dsh?: { client?: unknown } }
    return manifest.dsh?.client !== undefined
  } catch {
    return false
  }
}

/**
 * Packages whose build scripts pnpm refused to run, from any of its three
 * reporting shapes: the structured ndjson event (pnpm 11), the human
 * "Ignored build scripts:" line, or the fetcher's git-prepare rejection —
 * which fires BEFORE the package lands in node_modules (#68). Undefined when
 * none, so the field can be spread straight into a JSON response.
 */
function blockedBuilds(result: { ignoredBuilds?: unknown; stdout: string; stderr: string }): string[] | undefined {
  if (Array.isArray(result.ignoredBuilds) && result.ignoredBuilds.length > 0) return result.ignoredBuilds as string[]
  const list = parseIgnoredBuilds(result.stdout, result.stderr)
  if (list.length > 0) return list
  const pending = parsePrepareNotAllowed(result.stdout, result.stderr)
  return pending !== null ? [pending] : undefined
}

/**
 * Register the market's HTTP routes.
 * @param host - Acquired webServer + shell services.
 * @param config - Validated market configuration.
 * @returns Disposer removing every registered route.
 */
export function mountMarketRoutes(
  host: MarketHost,
  config: MarketConfig,
  commandRuntime?: PluginCommandRuntime,
  agentsLookup?: AgentsLookup,
): () => void {
  // An ordinary profile must resolve under DSH_HOME by the same rules as the
  // DSH CLI. A host-authoritative explicit directory (DSH Desktop) does not
  // derive a path from this display/profile name.
  if (config.profileDirectory === undefined && !isDshProfileName(config.profile)) {
    // Loud on the way out. This throw happens inside a cordis effect, which
    // swallows it: the routes silently never mount and EVERY /dsh-market/*
    // request answers 404 with nothing anywhere saying why — the market
    // simply looks broken (#260 by @realguan). The log line is the only
    // thing that turns that into something diagnosable, so it is written
    // before the throw rather than left to a handler that never runs.
    const message = `dsh-market: invalid profile name ${JSON.stringify(config.profile)}; the market's routes were not mounted and every /dsh-market/* request will answer 404. Use the same non-empty, non-traversal profile name accepted by DSH, or pass an explicit profile directory.`
    host.logger?.warn(`[dsh-market] ${message}`)
    logEvent('error', 'mount', message)
    throw new Error(message)
  }
  const activeProfileDir = profileDir(config.profile, config.profileDirectory)
  let agentGuardUnavailableLogged = false
  /** Running-agent ids for the mutation gate; logs once when the host exposes no agents service. */
  const runningAgentsForGuard = (): string[] => {
    const service = agentsLookup?.()
    const ids = runningAgentIds(service)
    if (service === undefined && !agentGuardUnavailableLogged) {
      agentGuardUnavailableLogged = true
      logEvent('warn', 'agent-guard', 'host exposes no agents service — mutations are not guarded while agents run')
    }
    return ids
  }
  /** Whether the host exposes a usable agents service (readable in /status). */
  const agentsGuardAvailable = (): boolean => {
    const service = agentsLookup?.()
    if (service === undefined) return false
    try {
      return Array.isArray(service.list())
    } catch {
      return false
    }
  }
  // The profile's user patch layer (cordis.patch.yml): toggles are written
  // here so DSH's own HMR re-composes the tree (no restart) and the loader
  // re-applies the same choice on every boot (ported from dsh-plugin-hub).
  const userPatchPath = findUserPatchPath(host, activeProfileDir)
  const commands = commandRuntime ?? { runPlugin: runDshPlugin, probePnpm, provisionPnpm, cancelActive }
  // Snapshot retention cap (issue #98 supplement): a finite positive number
  // from the market config wins; anything else falls back to the default.
  const maxSnapshots = typeof config.maxSnapshots === 'number' && Number.isFinite(config.maxSnapshots) && config.maxSnapshots >= 1
    ? Math.floor(config.maxSnapshots)
    : DEFAULT_MAX_SNAPSHOTS
  // Boot-time wipe: stale hot-mount inputs from a previous session must never
  // survive into a composition where the bundle layer already covers them.
  cleanHotDir(activeProfileDir)
  // The user's persisted choices: the generic disable list (legacy
  // disabledSkins loads transparently) plus custom groups. Every toggle,
  // group, install and uninstall mutates this shared state and persists it.
  const marketState = readMarketState(activeProfileDir)
  const disabled = marketState.disabled
  const groups = marketState.groups
  const groupOrder = marketState.groupOrder
  // A choice made in a previous session outranks whatever the entry layer
  // composed, which is only ever a default.
  if (marketState.channel !== undefined) config.channel = marketState.channel
  const activeChannel = (): Channel => resolveChannel(config.channel, marketVersion())

  // The download region: which mirrors every outbound request uses.
  //
  // `global` until something decides otherwise, so nothing waits on the
  // network to start serving. A machine with no region on record gets one
  // probed in the background below; a machine that already has one is
  // routed immediately.
  if (marketState.region !== undefined) config.region = marketState.region
  let region: Region = config.region ?? 'global'
  let regionAuto = marketState.regionAuto === true
  const applyRegion = (next: Region): void => {
    region = next
    // The shared holder every reader consults, plus the one consumer that
    // must also DROP state on a change: update answers gathered from the
    // other registry are not this registry's answers.
    setActiveRegion(next)
    setUpdateRegistry(routesFor(next).npmRegistry)
  }
  applyRegion(region)
  // Probe only when NOTHING has decided a region — not the saved state, and
  // not the composition either. An operator who wrote `region:` into their
  // profile has answered the question the probe exists to ask, and measuring
  // over the top of that answer would quietly override a deliberate choice a
  // few seconds after boot.
  if (config.region === undefined) {
    void resolveRegion(undefined).then(({ region: probed }) => {
      applyRegion(probed)
      regionAuto = true
      // Persisted as the decision, not re-probed each boot: a market that
      // silently changes routes between runs makes "it was fast yesterday"
      // impossible to investigate.
      marketState.region = probed
      marketState.regionAuto = true
      config.region = probed
      writeMarketState(activeProfileDir, marketState)
      // The listing was fetched before the region was known.
      forgetCatalog()
      invalidateUpdates()
    }).catch(() => { /* an undecided region simply stays global */ })
  }
  const themes = createThemeManager(host, config.profile, disabled, activeProfileDir)

  /**
   * Re-sync the live closure state from disk. Snapshot restore writes
   * state.json directly (it must, to survive the next boot), which would
   * leave this in-memory `disabled`/`groups`/`groupOrder` stale —
   * the next toggle/groups write would then overwrite the restored values.
   * The objects are mutated in place (clear + refill) so every captured
   * reference (themes manager, live handlers) sees the fresh state (issue
   * #98 review M2).
   */
  function refreshMarketState(): void {
    const fresh = readMarketState(activeProfileDir)
    disabled.clear()
    for (const name of fresh.disabled) disabled.add(name)
    for (const key of Object.keys(groups)) delete groups[key]
    Object.assign(groups, fresh.groups)
    groupOrder.length = 0
    groupOrder.push(...fresh.groupOrder)
  }

  // Client-only packages (dsh.client without dsh.bundle) are invisible to the
  // bundle layer in every boot; the market shim-mounts them so their client
  // bundles are actually served.
  void mountClientOnlyDeps(host, activeProfileDir).then(async (mounted) => {
    if (mounted.length > 0) logEvent('info', 'boot', `client-only shims mounted: ${mounted.join(', ')}`)
    // Replay the persisted disable list: bundle-layer plugins the user
    // switched away from get live-disabled again (bundle trees are
    // in-memory, so the disable never persists on its own). Client-only
    // shims for disabled plugins were already skipped by mountClientOnlyDeps.
    for (const name of disabled) {
      if (await themes.setEntryDisabled(name, true)) logEvent('info', 'boot', `plugin kept off: ${name}`)
    }
  })

  // Self-healing guard: dsh's own patch overlay can re-update entries during
  // activation and wipe the runtime disabled flag — whenever a fiber comes
  // up for a plugin the user switched off, put it back down.
  host.on?.('internal/plugin', (fiber) => {
    const name = fiber.entry?.options?.name
    if (name !== undefined && disabled.has(name)) void themes.setEntryDisabled(name, true)
  })
  let installing = false
  let restarting = false
  // UI-state flags ONLY: mutual exclusion is enforced by withMutationLock
  // below (one promise chain every mutating route appends to), never by
  // these booleans — a promise-chain serialization cannot be raced by
  // interleaved awaits, and a second mutating request answers 409
  // immediately instead of queueing (issue #125 review).
  let writing = false
  let mutationBusy = false
  /** The shared mutation chain: every mutating operation appends to it. */
  let mutationChain: Promise<unknown> = Promise.resolve()

  /**
   * Run a mutating operation under the shared mutation lock. `kind` selects
   * the UI busy flag (`install` = pnpm operation, `write` = direct profile
   * write) and the 409 message. The operation runs only after every earlier
   * mutation settled (promise chain); while one is in flight a second
   * mutating request answers 409 immediately — the UI polls /status for the
   * busy flag instead of queueing (issue #125 review).
   * @returns the operation's value, or null when the lock was busy (409 sent).
   */
  async function withMutationLock<T>(
    response: ServerResponse,
    kind: 'install' | 'write',
    fn: () => Promise<T> | T,
  ): Promise<T | null> {
    if (mutationBusy) {
      sendJson(response, 409, {
        error: kind === 'install' ? 'another install is already running' : 'another plugin operation is running',
      })
      return null
    }
    mutationBusy = true
    if (kind === 'install') installing = true
    else writing = true
    try {
      const run = mutationChain.then(async () => fn())
      mutationChain = run.catch(() => undefined)
      return await run
    } finally {
      mutationBusy = false
      if (kind === 'install') installing = false
      else writing = false
    }
  }

  /** Dependency diff vs. a pre-operation snapshot (cancel aftermath). */
  function changedSince(before: Record<string, string>): { changed: string[]; partial: boolean } {
    const now = readInstalled(config.profile, activeProfileDir)
    const changed = new Set<string>()
    for (const [name, spec] of Object.entries(now)) if (before[name] !== spec) changed.add(name)
    for (const name of Object.keys(before)) if (now[name] === undefined) changed.add(name)
    return { changed: [...changed], partial: changed.size > 0 }
  }

  /**
   * Apply one enable/disable request: persist the choice in state.json, then
   * drive the live composition. Covers every mount form — hot mounts and
   * client-only shims go through hotUnmount/hotMount, bundle-layer entries
   * through setEntryDisabled. Enabling a THEME goes through the caller's
   * activateTheme instead so the Themes tab's exclusivity stays intact.
   */
  async function setPluginEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; reason?: string }> {
    const dir = activeProfileDir
    if (enabled) disabled.delete(name)
    else disabled.add(name)
    let ok: boolean
    let reason: string | undefined
    if (enabled) {
      if (listHotMounts().includes(name)) {
        ok = true
      } else if (await themes.setEntryDisabled(name, false)) {
        ok = true
      } else {
        const result = await hotMount(host, dir, name)
        ok = result.ok
        reason = result.reason ?? undefined
      }
    } else {
      ok = await hotUnmount(name) || await themes.setEntryDisabled(name, true)
      if (!ok) {
        // Nothing was live (boot-skipped client shim, user-patch-managed
        // entry, or already off): the persisted flag is the contract.
        ok = true
      }
    }
    writeMarketState(dir, { disabled, groups, groupOrder })
    return { ok, reason }
  }

  /**
   * Everything live in the running composition: market hot mounts plus
   * bundle-layer loader entries whose fiber is up (loaded at boot). This is
   * the source of truth for verifyActivation's `live` state — without the
   * loader side, every boot-loaded bundle plugin would read as "restart".
   */
  function liveNames(): Set<string> {
    const live = new Set(listHotMounts())
    for (const entry of host.loader.entries()) {
      if (entry.fiber === undefined) continue
      if (entry.options.name !== undefined) live.add(entry.options.name)
      // Entry IDS too, under a `#` prefix that cannot collide with a package
      // name. A CARRIER bundle's row names the package it mounts, not
      // itself (#156: @tt-a1i/archify-dsh inserts an entry named
      // @deepseek-ai/dsh-skill-filesystem), so its own name never appears
      // here — but the id it created does, and that id is unique to its
      // patch. Verification needs both, and putting them in one set means
      // no call site can pass the names and forget the ids.
      if (entry.options.id !== undefined && entry.options.id !== '') {
        live.add(`#${entry.options.id}`)
        // Loader ids may carry an include prefix (`include:archify-…`).
        const bare = entry.options.id.split(':').pop()
        if (bare !== undefined && bare !== entry.options.id) live.add(`#${bare}`)
      }
    }
    return live
  }

  /**
   * Drop live hot mounts whose package was removed outside the market
   * (e.g. `dsh plugin remove` in a terminal): the stale mount would keep
   * serving a client bundle that 404s after refresh, wedging the page
   * until a restart (#29 by @SunYanbox).
   */
  async function dropStaleHotMounts(): Promise<void> {
    for (const name of listHotMounts()) {
      if (existsSync(join(activeProfileDir, 'node_modules', name, 'package.json'))) continue
      await hotUnmount(name)
      logEvent('warn', 'hot-sweep', `${name}: package removed outside the market — live mount dropped`)
    }
  }

  /** Every plugin command goes through the pnpm-drift recovery wrapper (#20). */
  const runPlugin = (profile: string, args: string[]) => withHoistRecovery(commands.runPlugin, profile, args, activeProfileDir)

  /**
   * Undo a clean-exit update whose new build cannot boot. Restoring only the
   * manifest pin (the original #159 behavior) leaves the bad package files
   * on disk, and the boot resolves bundle patches from node_modules — the
   * next start still fails. Re-run pnpm install against the restored
   * manifest to rematerialize the previous build's files.
   */
  async function rollbackUpdateBuild(name: string, manifestBefore: ProfileManifestSnapshot): Promise<{ ok: boolean; detail: string | null }> {
    const rolledBack = restoreProfileManifest(config.profile, manifestBefore, activeProfileDir)
    if (rolledBack.length === 0) return { ok: true, detail: null }
    // CI=true (the market always runs pnpm that way) turns frozen-lockfile
    // on, and the restored manifest pin now disagrees with the lockfile the
    // bad add just wrote — without the flag this restore run fails with
    // ERR_PNPM_OUTDATED_LOCKFILE (measured). The age override lets pnpm
    // re-resolve a previous release that is still inside its fresh window.
    // Flags come BEFORE the command: preparePluginArgs treats the last arg as
    // the package target and rejects a trailing flag, while pnpm accepts the
    // same flags in front of `install`.
    const reinstall = await runPlugin(config.profile, ['--no-frozen-lockfile', RELEASE_AGE_OVERRIDE, 'install'])
    const ok = reinstall.exitCode === 0 && !reinstall.timedOut && !reinstall.cancelled
    if (ok) logEvent('info', 'update', `${name}: previous build rematerialized (${rolledBack.join(', ')})`)
    return { ok, detail: ok ? null : failureDetail(reinstall) }
  }

  interface PendingRollback {
    id: string
    kind: 'update' | 'install'
    names: string[]
    manifestBefore?: ProfileManifestSnapshot
    /** github: updates must re-add the pre-update commit, not just reinstall. */
    gitTarget?: string
    beforeCommit?: string | null
  }

  const pendingRollbacks = new Map<string, PendingRollback>()
  let rollbackSequence = 0

  function savePendingRollback(record: Omit<PendingRollback, 'id'>): string {
    const id = `rollback-${String(rollbackSequence++)}`
    pendingRollbacks.set(id, { ...record, id })
    return id
  }

  /** Restore a github: update by re-adding the commit captured before the update. */
  async function rollbackGitBuild(
    name: string,
    manifestBefore: ProfileManifestSnapshot,
    target: string,
    beforeCommit: string | null,
  ): Promise<{ ok: boolean; detail: string | null }> {
    if (beforeCommit === null) {
      return { ok: false, detail: 'the previous commit is unknown; nothing to roll back to' }
    }
    restoreProfileManifest(config.profile, manifestBefore, activeProfileDir)
    const add = await runPlugin(config.profile, ['add', RELEASE_AGE_OVERRIDE, `${target}#${beforeCommit}`])
    if (add.exitCode !== 0 || add.timedOut || add.cancelled) {
      return { ok: false, detail: failureDetail(add) }
    }
    // pnpm wrote a commit-pinned spec; the profile's durable spec must stay
    // the original `github:owner/repo` form. The lockfile keeps the restored
    // commit resolution for the next boot.
    restoreProfileManifest(config.profile, manifestBefore, activeProfileDir)
    logEvent('info', 'update-rollback', `${name}: restored github build at ${beforeCommit}`)
    return { ok: true, detail: null }
  }

  async function removeInstalledPackage(name: string): Promise<{ ok: boolean; hot: boolean; detail: string | null }> {
    const result = await runPlugin(config.profile, ['remove', name])
    if (result.exitCode !== 0 || result.timedOut || result.cancelled) {
      return { ok: false, hot: false, detail: failureDetail(result) }
    }
    // Both cleanups run — see the uninstall route's note on #213: a package
    // with two activation sources must not have the second one skipped
    // because the first succeeded.
    const unmounted = await hotUnmount(name)
    const entryDisabled = await themes.setEntryDisabled(name, true)
    const hot = unmounted || entryDisabled
    removeRowBlocks(userPatchPath, rowIdsForPackage(host, activeProfileDir, name))
    disabled.delete(name)
    removeFromGroups({ groups, groupOrder }, name)
    writeMarketState(activeProfileDir, { disabled, groups, groupOrder })
    return { ok: true, hot, detail: null }
  }

  /**
   * Errors the profile analysis reports about the restored composition —
   * a bundle or a user-patch insert naming a package that is not in
   * node_modules. #205: those surfaced only at the NEXT boot, as a Loader
   * ERR_MODULE_NOT_FOUND with nothing tying it to the restore that caused it.
   *
   * Reported, never rolled back. A restore undone halfway can leave someone
   * worse off than the state they were trying to leave, and after a
   * cross-machine restore they still have the old machine to compare against.
   * Naming the packages is what they cannot do for themselves.
   *
   * An analysis that throws is not allowed to fail a restore that already
   * succeeded — the profile is on disk either way.
   */
  function restoredBootErrors(): string[] {
    try {
      return analyzeProfile(activeProfileDir).summary.errors
    } catch (error) {
      logEvent('warn', 'restore', `post-restore analysis failed: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  async function restoreBackup(value: unknown): Promise<{ files: number; errors: { name: string; error: string }[]; unportable?: Array<{ name: string; spec: string }>; bootErrors?: string[] }> {
    if (!await probePnpm()) throw new Error('pnpm is required to restore plugins')
    // Snapshot the target's manifest BEFORE the backup files overwrite it, so
    // the restore can merge rather than replace: plugins the target already
    // has that are NOT in the backup stay installed instead of silently
    // dropping off the manifest (partial exports, issue #89). The mutation
    // lock is owned by withMutationLock now, so no `installing` flag here.
    const manifestBefore = JSON.parse(readFileSync(join(activeProfileDir, 'package.json'), 'utf8')) as Record<string, unknown>
    const restored = restoreProfileBackup(config.profile, value, activeProfileDir)
    try {
      // Merge: current deps stay, backup specs win on name conflicts; bundle
      // lists are unioned. Full exports merge to the backup view unchanged.
      const mergedManifest = mergeRestoreManifest(
        JSON.parse(readFileSync(join(activeProfileDir, 'package.json'), 'utf8')) as Record<string, unknown>,
        manifestBefore,
      )
      writeFileSync(join(activeProfileDir, 'package.json'), `${JSON.stringify(mergedManifest, null, 2)}\n`)
      // Named BEFORE the install runs, because that is the install this
      // will make fail: a `link:/Users/…` spec from another machine points
      // at a path that does not exist here (#205). Reported rather than
      // rewritten — where those files should live is the operator's call.
      const unportable = unportableDeps(mergedManifest.dependencies)
      if (unportable.length > 0) {
        logEvent('warn', 'restore', `machine-specific dependency paths in the restored manifest — ${unportable.map(dep => `${dep.name}: ${dep.spec}`).join('; ')}`)
      }
      const result = await runPlugin(config.profile, ['install'])
      if (result.exitCode === 0 && !result.timedOut && !result.cancelled) {
        invalidateUpdates()
        const bootErrors = restoredBootErrors()
        if (bootErrors.length > 0) {
          logEvent('warn', 'restore', `restored profile will not boot as-is — ${bootErrors.join('; ')}`)
        }
        return { files: restored.files, errors: [], unportable, ...(bootErrors.length > 0 ? { bootErrors } : {}) }
      }

      // A bad dependency makes pnpm abort the whole install. Retry from an
      // empty dependency list so one broken plugin cannot block the rest.
      // activeProfileDir, NOT profileDir(config.profile): in DSH Desktop the
      // profile directory is host-authoritative (#72) and the ambient
      // derivation would edit the WRONG profile's manifest.
      const manifestFile = join(activeProfileDir, 'package.json')
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
        dependencies?: Record<string, string>
        dsh?: { profile?: { bundles?: string[] } }
      }
      const dependencies = Object.entries(manifest.dependencies ?? {})
      const desiredBundles = [...(manifest.dsh?.profile?.bundles ?? [])]
      const dependencyNames = new Set(dependencies.map(([name]) => name))
      manifest.dependencies = {}
      if (Array.isArray(manifest.dsh?.profile?.bundles)) {
        manifest.dsh.profile.bundles = desiredBundles.filter(bundle => !dependencyNames.has(bundle))
      }
      writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
      const errors: { name: string; error: string }[] = []
      let installed = 0
      for (const [name, spec] of dependencies) {
        const target = /^(?:file|link|github|git\+|https?):/.test(spec) ? spec : `${name}@${spec}`
        try {
          const item = await runPlugin(config.profile, ['add', target])
          if (item.exitCode === 0 && !item.timedOut && !item.cancelled
            && existsSync(join(activeProfileDir, 'node_modules', name, 'package.json'))) {
            installed += 1
            if (desiredBundles.includes(name)) {
              const current = JSON.parse(readFileSync(manifestFile, 'utf8')) as typeof manifest
              current.dsh ??= {}
              current.dsh.profile ??= {}
              current.dsh.profile.bundles ??= []
              if (!current.dsh.profile.bundles.includes(name)) current.dsh.profile.bundles.push(name)
              writeFileSync(manifestFile, `${JSON.stringify(current, null, 2)}\n`)
            }
            continue
          }
          errors.push({ name, error: failureDetail(item).trim() || 'pnpm failed' })
        } catch (error) {
          errors.push({ name, error: error instanceof Error ? error.message : String(error) })
        }
        const current = JSON.parse(readFileSync(manifestFile, 'utf8')) as typeof manifest
        if (current.dependencies !== undefined) delete current.dependencies[name]
        writeFileSync(manifestFile, `${JSON.stringify(current, null, 2)}\n`)
      }
      if (installed === 0 && dependencies.length > 0) {
        restored.rollback()
      }
      invalidateUpdates()
      const bootErrors = restoredBootErrors()
      if (bootErrors.length > 0) {
        logEvent('warn', 'restore', `restored profile will not boot as-is — ${bootErrors.join('; ')}`)
      }
      return {
        files: restored.files,
        errors,
        unportable: unportableDeps(manifest.dependencies),
        ...(bootErrors.length > 0 ? { bootErrors } : {}),
      }
    } catch (error) {
      restored.rollback()
      throw error
  }
  }

  const disposers = [
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/backup',
      handler: (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        // Profile exports carry configuration that may include credentials
        // (config.toml, .env, …), so they stay limited to loopback peers
        // without proxy forwarding (review #63). Unlike process control,
        // browsers omit the Origin header on `<a download>` GET navigations,
        // so a missing Origin passes; a present one must still match Host.
        if (!trustedDownloadRequest(request)) {
          sendJson(response, 403, { error: 'backup export is limited to same-origin loopback requests' })
          return
        }
        try {
          const data = createProfileBackup(config.profile, activeProfileDir)
          const backup = JSON.stringify(data, null, 2)
          const timestamp = new Date(data.createdAt).toLocaleString('sv-SE').replace(/\D/g, '')
          response.writeHead(200, {
            'cache-control': 'no-store',
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="dsh-dshmarket-backup-${timestamp}.json"`,
          })
          response.end(backup)
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/restore',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) return sendJson(response, 403, { error: 'untrusted origin' })
        try {
          const body = await readJsonBody(request, MAX_BACKUP_BYTES + 4096) as { backup?: unknown }
          await withMutationLock(response, 'install', async () => {
            sendJson(response, 200, { ok: true, ...await restoreBackup(body.backup) })
          })
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/webdav',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) return sendJson(response, 403, { error: 'untrusted origin' })
        try {
          const body = await readJsonBody(request) as { action?: unknown; url?: unknown; username?: unknown; password?: unknown }
          const url = typeof body.url === 'string' ? body.url : ''
          const username = typeof body.username === 'string' ? body.username : ''
          const password = typeof body.password === 'string' ? body.password : ''
          if (body.action === 'backup') {
            await uploadWebdav(url, username, password, createProfileBackup(config.profile, activeProfileDir))
            sendJson(response, 200, { ok: true })
          } else if (body.action === 'restore') {
            // The preview flow first returns the downloaded backup so the
            // client can show what will be restored; the real restore then
            // posts it to /dsh-market/restore, where downloadWebdav's strict
            // validation guarantees the fetch result is never blindly echoed
            // (review #63).
            sendJson(response, 200, { ok: true, backup: await downloadWebdav(url, username, password) })
          } else sendJson(response, 400, { error: 'invalid WebDAV action' })
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/gist',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) return sendJson(response, 403, { error: 'untrusted origin' })
        // 25 s route-level ceiling: abort the underlying GitHub request too,
        // so the client always gets a definite, structured answer and a
        // wedged gh CLI / slow network can never leave a request running in
        // the background (issue #89; the error carries a code for the UI).
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(new GistError('Gist operation timed out', 'timeout')), 25_000)
        try {
          const body = await readJsonBody(request) as { action?: unknown; token?: unknown; gistId?: unknown; includeDeps?: unknown; includeConfig?: unknown }
          const { token, source } = await resolveGistTokenSource(body.token)
          if (body.action === 'export') {
            const gistIdInput = typeof body.gistId === 'string' ? body.gistId.trim() : ''
            const includeDeps = Array.isArray(body.includeDeps)
              ? body.includeDeps.filter((name): name is string => typeof name === 'string' && name !== '')
              : undefined
            const backup = createProfileBackup(config.profile, activeProfileDir, includeDeps !== undefined
              ? { includeDeps, includeConfig: body.includeConfig === true }
              : undefined)
            const content = JSON.stringify(backup, null, 2)
            if (!fitsGistLimit(content)) throw new Error('backup exceeds the GitHub Gist 1 MB limit')
            const ref = gistIdInput === ''
              ? await createGist(token, content, controller.signal)
              : await updateGist(token, parseGistId(gistIdInput), content, controller.signal)
            sendJson(response, 200, { ok: true, gistId: ref.id, gistUrl: ref.htmlUrl })
          } else if (body.action === 'import') {
            if (typeof body.gistId !== 'string' || body.gistId.trim() === '') throw new Error('gist id is required')
            const backup = await readGist(token, parseGistId(body.gistId), controller.signal)
            // Preview flow, same as WebDAV: the client reviews the backup and
            // posts it to /dsh-market/restore; readGist's strict validation
            // guarantees the fetch result is never blindly echoed.
            sendJson(response, 200, { ok: true, backup })
          } else if (body.action === 'verify') {
            await verifyGistToken(token, controller.signal)
            sendJson(response, 200, { ok: true, source })
          } else sendJson(response, 400, { error: 'invalid Gist action' })
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : String(error), code: gistErrorCode(error) })
        } finally {
          clearTimeout(timer)
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/registry',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        try {
          try {
            sendJson(response, 200, { registry: await loadRegistry() })
          } catch (error) {
            // Say what went wrong. The market used to substitute a bundled
            // copy here, so an unreachable registry looked exactly like a
            // reachable one with fewer plugins in it.
            const message = error instanceof Error ? error.message : String(error)
            logEvent('warn', 'registry', `catalog fetch failed: ${message}`)
            sendJson(response, 502, { error: message })
          }
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/installed',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        await dropStaleHotMounts()
        const installed = readInstalled(config.profile, activeProfileDir)
        const repoIdentities: Record<string, string[]> = {}
        const repoHints: Record<string, string[]> = {}
        for (const [name, spec] of Object.entries(installed)) {
          const evidence = readInstalledRepoEvidence(config.profile, name, spec, activeProfileDir)
          if (evidence.identities.length > 0) repoIdentities[name] = evidence.identities
          if (evidence.hints.length > 0) repoHints[name] = evidence.hints
        }
        const present = Object.keys(installed).filter(
          name => readInstalledVersion(config.profile, name, activeProfileDir) !== null,
        )
        // User-patch-layer state (port of dsh-plugin-hub): rows the user
        // patch disables/force-enables, plus per-package flags so the UI can
        // show toggles made OUTSIDE the market (hand-edited cordis.patch.yml,
        // the dsh CLI) that state.json never sees.
        const patch = readUserPatchState(userPatchPath)
        const patchFlags = packagePatchFlags(host, activeProfileDir, Object.keys(installed), patch)
        const activation: Record<string, ReturnType<typeof verifyActivation>> = {}
        const live = liveNames()
        for (const name of Object.keys(installed)) {
          activation[name] = verifyActivation(config.profile, name, live, activeProfileDir,
            disabled.has(name) || patchFlags.disabled.includes(name))
        }
        const diagnostics = diagnosePackageManifests(Object.keys(installed).map(packageName => ({
          packageName,
          manifest: readInstalledManifest(config.profile, packageName, activeProfileDir),
        })))
        sendJson(response, 200, {
          profile: config.profile,
          installed,
          repoIdentities,
          repoHints,
          present,
          activation,
          diagnostics,
          live: listHotMounts(),
          disabled: [...disabled],
          groups,
          groupOrder,
          patch: { disables: patch.disables, forced: patch.forced, inserts: patch.inserts },
          patchDisabled: patchFlags.disabled,
          patchForced: patchFlags.forced,
          bundles: readProfileBundles(activeProfileDir).filter(name => !INBOX_BUNDLES.has(name)),
        })
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/check',
      handler: (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        try {
          const report = analyzeProfile(activeProfileDir)
          // #201: attach the #200 directional verdict to every peer row so the
          // diagnostics UI can tier risk / warning / info without recomputing
          // (the client cannot see peerDependenciesMeta on disk).
          for (const row of report.peerMismatches) {
            row.verdict = row.satisfied === false
              // `optional` is absent rather than false on a row the plugin
              // did not mark (#275), and absent means not optional.
              ? classifyPeer(row.plugin, row.name, row.range, row.resolved, row.optional === true)
              : { kind: 'none' }
          }
          sendJson(response, 200, report)
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    // Issue #98 phase 2: reorder the community bundles. Official bundles are
    // fixed; the candidate is trial-validated (dry-run composition replay)
    // before the manifest is written — a broken order is refused and the
    // profile is never touched.
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/bundle-order',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        // Mutex with pnpm operations AND other direct writes (issue #98
        // analysis): reordering writes package.json directly; racing an
        // install/update/uninstall — or another direct write — would
        // corrupt the manifest (backup restore uses the same guard). The
        // lock is taken BEFORE the body is read so a slow/pending request
        // cannot interleave with another write either.
        // #125 hardening (lesson from #122: a bad order write can stop DSH
        // from starting): keep a pre-write profile backup and restore it
        // automatically if the write throws mid-flight, and persist a profile
        // snapshot before the write (issue #126) so the change is recoverable
        // from the snapshots tab — the backup is the immediate rollback net.
        let backup: ProfileBackup | null = null
        try {
          await withMutationLock(response, 'write', async () => {
            const body = (await readJsonBody(request)) as { order?: unknown } | null
            if (body === null || typeof body !== 'object') {
              sendJson(response, 400, { error: 'JSON body is required / 需要 JSON body' })
              return
            }
            if (!Array.isArray(body.order) || !body.order.every(item => typeof item === 'string')) {
              sendJson(response, 400, { error: 'order must be an array of bundle names / order 必须是 bundle 名称数组' })
              return
            }
            const order = body.order as string[]
              // Before/after rules (issue #98 phase 2): the merged stack must
              // satisfy every rule the bundles declare. Enforced BEFORE the
              // trial/write so a rule-breaking order is refused outright.
              const stack = readBundleStack(activeProfileDir)
              const merged = mergeOrder(stack.bundles, order)
              if (merged.ok) {
                const conflicts = validateOrder(merged.bundles, readBundleRules(activeProfileDir))
                if (conflicts.length > 0) {
                  logEvent('warn', 'bundle-order', `rejected by before/after rules: ${conflicts.map(c => c.reason).join('; ')}`)
                  sendJson(response, 422, {
                    error: 'the order violates declared before/after rules / 该顺序违反了插件声明的 before/after 规则',
                    conflicts,
                  })
                  return
                }
              }
              const trial = trialValidate(activeProfileDir, order)
              if (!trial.ok) {
                const first = trial.errors[0]
                logEvent('warn', 'bundle-order', `rejected by trial validation: ${first?.message ?? 'unknown'}`)
                sendJson(response, 422, {
                  error: `trial validation failed — ${first?.message ?? 'this order would not boot'} / 试启动校验失败：${first?.message ?? '该顺序无法启动'}`,
                  trial: { errors: trial.errors, warnings: trial.warnings, diff: trial.diff },
                })
                return
              }
              backup = createProfileBackup(config.profile, activeProfileDir)
              // yzke review point 4 (issue #126): persist a profile snapshot BEFORE
              // the write (subject to the maxSnapshots quota), so the change is
              // recoverable from the snapshots tab; the in-process backup above
              // stays as the immediate rollback net (double protection).
              const snapshot = createProfileSnapshot(activeProfileDir, maxSnapshots)
              const applied = applyBundleOrder(activeProfileDir, order)
              if (!applied.ok) {
                sendJson(response, 400, { error: applied.error })
                return
              }
              invalidateUpdates()
              logEvent('info', 'bundle-order', 'applied new community order' + (snapshot !== null ?  (snapshot ) : ''))
              sendJson(response, 200, { ok: true, bundles: applied.bundles, snapshot: snapshot?.id ?? null })
          })
        } catch (error) {
          // The write threw mid-flight: restore the pre-write profile so a
          // broken manifest can never stop DSH from starting (issue #125,
          // lesson from #122). Best-effort — a failing restore must not mask
          // the original error.
          if (backup !== null) {
            try {
              restoreProfileBackup(config.profile, backup, activeProfileDir)
              logEvent('error', 'bundle-order', `write failed — profile restored from pre-write backup: ${error instanceof Error ? error.message : String(error)}`)
            } catch {
              logEvent('error', 'bundle-order', 'write failed AND automatic rollback failed')
            }
          }
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    // Issue #98 phase 3: named plugin presets (bundle order + disable list).
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/presets',
      handler: async (request, response) => {
        if (request.method === 'GET') {
          sendJson(response, 200, { presets: listPresets(activeProfileDir) })
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'GET, POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          // save carries the FULL community order + disabled list, which can
          // exceed the 4KiB default (CJK names are 3 bytes/char).
          const body = (await readJsonBody(request, 256 * 1024)) as { action?: unknown; name?: unknown; bundleOrder?: unknown; disabled?: unknown } | null
          if (body === null || typeof body !== 'object') {
            sendJson(response, 400, { error: 'JSON body is required / 需要 JSON body' })
            return
          }
          const name = body.name
          // Preview is a pure read; save/apply/delete write presets.json,
          // package.json and state.json, so they take the direct-write lock —
          // a concurrent pnpm run or another direct write must not interleave
          // (issue #98 analysis: write-route mutual exclusion).
          if (body.action === 'preview') {
            const previewed = previewPreset(activeProfileDir, name)
            sendJson(response, previewed.ok ? 200 : 422, previewed)
            return
          }
          await withMutationLock(response, 'write', async () => {
            switch (body.action) {
              case 'save': {
                const saved = savePreset(activeProfileDir, name, body.bundleOrder, body.disabled)
                sendJson(response, saved.ok ? 200 : 400, saved)
                return
              }
              case 'apply': {
                const applied = applyPreset(activeProfileDir, name, maxSnapshots)
                if (applied.ok) {
                  invalidateUpdates()
                  refreshMarketState()
                }
                sendJson(response, applied.ok ? 200 : 422, applied)
                return
              }
              case 'delete': {
                const deleted = deletePreset(activeProfileDir, name)
                sendJson(response, deleted.ok ? 200 : 400, deleted)
                return
              }
              default:
                sendJson(response, 400, { error: 'action must be save | preview | apply | delete / action 必须是 save | preview | apply | delete' })
            }
          })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    // Issue #98 phase 3 (#19): profile snapshots — list, create, restore.
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/snapshots',
      handler: async (request, response) => {
        if (request.method === 'GET') {
          sendJson(response, 200, { snapshots: listSnapshots(activeProfileDir) })
          return
        }
        if (request.method === 'POST') {
          if (!sameOrigin(request)) {
            sendJson(response, 403, { error: 'untrusted origin' })
            return
          }
          try {
            await withMutationLock(response, 'write', async () => {
              const snapshot = createProfileSnapshot(activeProfileDir, maxSnapshots)
              sendJson(response, snapshot !== null ? 200 : 400, {
                ok: snapshot !== null,
                ...(snapshot !== null
                  ? { snapshot }
                  : { error: 'profile package.json is missing or unparseable / profile 的 package.json 缺失或无法解析' }),
              })
            })
          } catch (error) {
            sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        response.writeHead(405, { allow: 'GET, POST' })
        response.end()
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/restore-snapshot',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          await withMutationLock(response, 'write', async () => {
            const body = (await readJsonBody(request)) as { snapshot?: unknown } | null
            if (body === null || typeof body !== 'object' || typeof body.snapshot !== 'string' || body.snapshot === '') {
              sendJson(response, 400, { error: 'snapshot id is required / 需要快照 id' })
              return
            }
            const restored = restoreSnapshot(activeProfileDir, body.snapshot)
            if (restored.ok) {
              invalidateUpdates()
              refreshMarketState()
            }
            sendJson(response, restored.ok ? 200 : 400, restored)
          })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    // Issue #98 supplement: delete one snapshot (the cap also prunes old ones
    // automatically, but the user may want to drop a specific snapshot).
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/delete-snapshot',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          await withMutationLock(response, 'write', async () => {
            const body = (await readJsonBody(request)) as { snapshot?: unknown } | null
            if (body === null || typeof body !== 'object' || typeof body.snapshot !== 'string' || body.snapshot === '') {
              sendJson(response, 400, { error: 'snapshot id is required / 需要快照 id' })
              return
            }
            // deleteSnapshot refuses traversal-shaped ids before touching the
            // filesystem (same discipline as restore); a false result means the
            // id is malformed or no such snapshot exists.
            const deleted = deleteSnapshot(activeProfileDir, body.snapshot)
            if (!deleted) {
              sendJson(response, 400, { ok: false, error: 'snapshot not found / 快照不存在' })
              return
            }
            logEvent('info', 'snapshot', `deleted ${body.snapshot}`)
            sendJson(response, 200, { ok: true, snapshot: body.snapshot })
          })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/use-skin',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { name?: unknown }
          const name = typeof body.name === 'string' ? body.name : ''
          const installed = readInstalled(config.profile, activeProfileDir)
          const themeNames = await themes.installedThemeNames()
          if (installed[name] === undefined || !themeNames.has(name)) {
            sendJson(response, 400, { error: 'not an installed theme' })
            return
          }
          const activated = await themes.activateTheme(name)
          logEvent(activated ? 'info' : 'error', 'use-skin', `${name}: ${activated ? 'active' : 'failed'}`)
          sendJson(response, activated ? 200 : 502, { ok: activated, live: listHotMounts() })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logEvent('error', 'use-skin', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/toggle',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { name?: unknown; enabled?: unknown }
          const name = typeof body.name === 'string' ? body.name : ''
          const enabled = body.enabled === true
          if (name === 'dsh-market' || name === 'dshmarket') {
            sendJson(response, 400, { error: 'the market cannot be disabled from its own page; use the dsh CLI' })
            return
          }
          if (readInstalled(config.profile, activeProfileDir)[name] === undefined) {
            sendJson(response, 400, { error: 'plugin is not installed' })
            return
          }
          // Host infrastructure (port of dsh-plugin-hub): switching off the
          // timer/hmr/webserver/storage chain would break the very HMR the
          // patch layer relies on, so those rows refuse to toggle.
          if (isProtectedModule(name)) {
            sendJson(response, 403, {
              error: `${name} 属于宿主基础设施,禁止开关(会破坏热加载/传输/存储链) / ${name} is host infrastructure and cannot be toggled (it would break the hot-reload/transport/storage chain)`,
            })
            return
          }
          let ok: boolean
          let reason: string | undefined
          if (enabled && (await themes.installedThemeNames()).has(name)) {
            // Theme exclusivity stays a Themes-page concern: enabling a theme
            // deactivates the previously active one, so only the last-enabled
            // theme is live (same semantics as use-skin).
            ok = await themes.activateTheme(name)
            if (!ok) reason = 'theme activation failed — restart required / 主题启用失败，需要重启'
          } else {
            const result = await setPluginEnabled(name, enabled)
            ok = result.ok
            reason = result.reason
          }
          // Durable patch-layer write (port of dsh-plugin-hub): the package's
          // bundle rows get 'disabled: true|false' in the user patch layer,
          // which DSH's HMR applies within ~1s AND the loader re-applies on
          // every boot. Client-only packages have no bundle rows — the
          // market's own state.json replay covers those.
          const patchRows = rowIdsForPackage(host, activeProfileDir, name)
          // Disable-carrier (#224): a bundle whose patch DISABLES a plugin it
          // does not own (dsh-postgres-backends disables session-persistence-jsonl).
          // Disabling only its inserted rows leaves that foreign disable applying
          // on every boot — the bundle stays in the stack — so drop it from
          // dsh.profile.bundles entirely, which stops its whole patch at once
          // (including any config side effects it carries). Enabling re-adds it.
          // A bundle that merely reconfigures a neighbour (config without
          // disabled) is NOT dropped: #147 requires disabling it to leave the
          // neighbour live, and the e2e fixture-cross re-enable breaks otherwise.
          const disablesOthers = carrierDisableIds(activeProfileDir, name)
          const isCarrier = disablesOthers.length > 0
          let bundleSwitch: { ok: boolean; reason: string | null } = { ok: true, reason: null }
          if (isCarrier) {
            try {
              if (enabled) addProfileBundle(activeProfileDir, name)
              else removeProfileBundle(activeProfileDir, name)
              logEvent('info', 'toggle', `${name}: disable-carrier ${enabled ? 're-added to' : 'removed from'} dsh.profile.bundles (disables: ${disablesOthers.join(', ')})`)
            } catch (error) {
              bundleSwitch = { ok: false, reason: error instanceof Error ? error.message : String(error) }
              logEvent('warn', 'toggle', `${name}: carrier bundle switch failed — ${bundleSwitch.reason}`)
            }
          }
          let patchWrite: { ok: boolean; reason: string | null } | null = null
          if (patchRows.length > 0) {
            for (const rowId of patchRows) {
              const result = enabled ? await enableRow(userPatchPath, rowId) : await disableRow(userPatchPath, rowId)
              if (!result.ok && patchWrite === null) patchWrite = result
            }
            if (patchWrite === null) {
              logEvent('info', 'toggle', `${name}: patch layer ${enabled ? 'enabled' : 'disabled'} rows ${patchRows.join(', ')}`)
            } else {
              logEvent('warn', 'toggle', `${name}: patch layer write refused — ${patchWrite.reason}`)
            }
          }
          logEvent(ok ? 'info' : 'error', 'toggle', `${name}: ${enabled ? 'on' : 'off'} ok=${String(ok)}`)
          // Activation reads the post-write truth: the switch state OR the
          // patch layer, so a disabled plugin never reports "restart to
          // apply".
          const patchNow = readUserPatchState(userPatchPath)
          const offNow = disabled.has(name) || patchRows.some(id => patchNow.disables.includes(id))
          // When the live composition does not match the requested state
          // (enable failed to hot-mount / disable left the fiber up), the
          // change lands on the next boot via the patch layer + state.json —
          // the client reuses the market's pending-restart banner for it.
          const liveAfter = liveNames().has(name)
          // A carrier toggle moves the bundle in/out of dsh.profile.bundles,
          // which only takes effect on the next composition — always a restart.
          // Non-carrier plugins keep the live-mount based decision.
          const restart = isCarrier ? true : enabled ? !liveAfter : liveAfter
          // A client-part plugin's UI is in the page already — toggling it
          // needs a browser refresh to show the change (same signal the
          // install flow uses for the hot banner).
          const refresh = packageHasClientPart(activeProfileDir, name)
          sendJson(response, ok ? 200 : 502, {
            ok,
            name,
            enabled,
            disabled: [...disabled],
            live: listHotMounts(),
            activation: { [name]: verifyActivation(config.profile, name, liveNames(), activeProfileDir, offNow) },
            reason,
            patchRows,
            patchWrite: patchWrite ?? { ok: true, reason: null },
            carrier: disablesOthers,
            bundleSwitch,
            restart,
            refresh,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logEvent('error', 'toggle', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/groups',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as {
            action?: unknown
            name?: unknown
            newName?: unknown
            members?: unknown
            enabled?: unknown
          }
          const action = typeof body.action === 'string' ? body.action : ''
          const known = action === 'create' || action === 'rename' || action === 'delete'
            || action === 'set-members' || action === 'toggle'
          if (!known) {
            sendJson(response, 400, { ok: false, error: 'unknown group action' })
            return
          }
          const installed = new Set(Object.keys(readInstalled(config.profile, activeProfileDir)))
          // Theme members follow the global one-active-theme rule: a group
          // holds at most one, and enabling one deactivates every other.
          const themeNames = await themes.installedThemeNames()
          let ok = true
          let error: string | undefined
          let restartMembers: string[] = []
          let refreshMembers: string[] = []
          if (action === 'toggle') {
            const name = typeof body.name === 'string' ? body.name : ''
            const enabled = body.enabled === true
            if (groups[name] === undefined) {
              sendJson(response, 400, { ok: false, error: 'group not found / 分组不存在' })
              return
            }
            // Batch toggle: on = every installed member enabled, off = every
            // member disabled. Each member keeps its own persisted flag, so
            // later individual toggles still work (the group switch itself is
            // derived state and never stored).
            const failures: string[] = []
            for (const member of groups[name]) {
              if (!installed.has(member)) continue
              const result = enabled && themeNames.has(member)
                ? { ok: await themes.activateTheme(member), reason: undefined }
                : await setPluginEnabled(member, enabled)
              if (!result.ok) failures.push(member)
              // Same live-mismatch signal as the single toggle: a member
              // whose fiber did not follow the switch needs a boot.
              const liveAfter = liveNames().has(member)
              if ((enabled && !liveAfter) || (!enabled && liveAfter)) restartMembers.push(member)
              // Client-part members need a page refresh to show the change.
              if (packageHasClientPart(activeProfileDir, member)) refreshMembers.push(member)
            }
            ok = failures.length === 0
            if (!ok) error = `failed to ${enabled ? 'enable' : 'disable'}: ${failures.join(', ')}`
          } else {
            const state = { groups, groupOrder }
            const result = action === 'create' ? createGroup(state, body.name)
              : action === 'rename' ? renameGroup(state, body.name, body.newName)
              : action === 'delete' ? deleteGroup(state, body.name)
              : setGroupMembers(state, body.name, body.members, installed, themeNames)
            ok = result.ok
            error = result.error
          }
          if (ok) writeMarketState(activeProfileDir, { disabled, groups, groupOrder })
          logEvent(ok ? 'info' : 'warn', 'groups',
            `${action}${typeof body.name === 'string' ? ' ' + body.name : ''}${ok ? '' : ` — ${error ?? ''}`}`)
          sendJson(response, ok ? 200 : 400, {
            ok,
            error,
            groups,
            groupOrder,
            disabled: [...disabled],
            restartMembers,
            refreshMembers,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logEvent('error', 'groups', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/status',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        await dropStaleHotMounts()
        const installed = readInstalled(config.profile, activeProfileDir)
        sendJson(response, 200, {
          active: progress.active,
          target: progress.target,
          seconds: progress.active ? Math.round((Date.now() - progress.startedAt) / 1000) : 0,
          lastLine: progress.lastLine,
          phase: progress.phase,
          done: progress.done,
          total: progress.total,
          currentPackage: progress.currentPackage,
          downloaded: progress.downloaded,
          size: progress.size,
          ndjson: progress.ndjson,
          error: progress.error,
          cancelling: progress.cancelling,
          // The route-level operation flag, NOT progress.active: after pnpm
          // exits, install post-processing (retarget, validation, hot-mount)
          // still holds the operation lock for a moment — the exact window
          // where clicking the restart banner used to bounce off a 409 (#91).
          busy: installing,
          pnpm: await commands.probePnpm(),
          boot: BOOT_ID,
          agentGuardAvailable: agentsGuardAvailable(),
          // Shown in the page heading so screenshots carry it (#159).
          version: marketVersion(),
          channel: activeChannel(),
          channels: CHANNELS,
          region,
          regions: REGIONS,
          // The prefix the BROWSER should put in front of github.com URLs
          // (avatars, README images). Sent resolved rather than derived from
          // `region` on the client, so the routing table has one home and a
          // change to it cannot leave the two halves disagreeing.
          githubProxy: routesFor(region).githubProxy,
          // Whether the region was decided by the network check rather than
          // by the user — the card explains a choice it made on their behalf
          // exactly once, so nobody has to wonder why downloads moved.
          regionAuto,
          restart: restartAllowed(config),
          // Named so the UI can say WHY the button is gone. A blank
          // "no restart button" is the state #229 reported as broken.
          supervisor: detectedSupervisor(),
          selfManaged: installed.dshmarket !== undefined || installed['dsh-market'] !== undefined,
          installed,
        })
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/logs',
      handler: (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        const version = marketVersion()
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="dsh-market-log.txt"',
        })
        response.end(exportLogs({
          'dsh-market': version,
          platform: `${process.platform} ${process.arch}`,
          node: process.version,
          profile: config.profile,
        }))
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/updates',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        try {
          const force = (request.url ?? '').includes('force=1')
          // Only the market itself follows the channel setting (see
          // MarketSettings.channel): a user opting into betas is volunteering
          // to try THIS plugin early, not to be handed every other author's
          // unreleased work.
          const channel = activeChannel()
          const channelFor = new Map(
            Object.keys(readInstalled(config.profile, activeProfileDir))
              .filter(name => SELF_NAMES.has(name))
              .map(name => [name, channel] as const),
          )
          sendJson(response, 200, { updates: await checkUpdates(config.profile, force, activeProfileDir, channelFor) })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/update',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          await withMutationLock(response, 'install', async () => {
            const body = (await readJsonBody(request)) as { name?: unknown; force?: unknown; restore?: unknown }
            const name = typeof body.name === 'string' ? body.name : ''
            const force = body.force === true
            const restore = body.restore === true
            let spec = readInstalled(config.profile, activeProfileDir)[name]
            if (spec === undefined) {
              sendJson(response, 400, { error: 'plugin is not installed' })
              return
            }
            if (restore && !isLocalSpec(spec)) {
              sendJson(response, 400, { error: 'restore 只适用于 link:/file: 的本地开发安装。 / Restore only applies to locally developed link:/file: installs.' })
              return
            }
            if (restore && SELF_NAMES.has(name)) {
              sendJson(response, 400, { error: '市场自身不做恢复，请继续用 dsh plugin add <tgz> 安装市场。 / The market never restores itself; keep installing it via dsh plugin add <tgz>.' })
              return
            }
            if (isLocalSpec(spec)) {
              if (!restore) {
                sendJson(response, 400, { error: 'locally linked plugins update from their checkout' })
                return
              }
              // Restore replaces the local checkout with the curated source
              // so the ordinary update check can see it again. Same add path
              // as a registry update — only the resolved target changes.
              let catalogTarget: string | null = null
              try {
                const registry = await loadRegistry()
                const evidence = readInstalledRepoEvidence(config.profile, name, spec, activeProfileDir)
                const entry = findCatalogEntryForLocal(registry.plugins, name, evidence.identities, evidence.hints)
                catalogTarget = entry === null ? null : restoreTargetForLocal(entry, evidence.identities)
                const workspaceDeps = workspaceProtocolDeps(readInstalledManifest(config.profile, name, activeProfileDir))
                if (catalogTarget !== null && restoreBlockedByWorkspace(catalogTarget, workspaceDeps)) {
                  sendJson(response, 400, {
                    error: `该插件依赖 monorepo workspace 包（${workspaceDeps.join(', ')}），无法从 Git 子目录单独恢复。请继续用本地开发，或等作者发布 npm 后再恢复。 / This plugin depends on monorepo workspace packages (${workspaceDeps.join(', ')}); a git subdirectory install cannot resolve workspace: protocol. Keep the local checkout, or restore after the author publishes to npm.`,
                  })
                  return
                }
              } catch (error) {
                logEvent('warn', 'update', `${name}: restore catalog lookup failed — ${error instanceof Error ? error.message : String(error)}`)
              }
              if (catalogTarget === null) {
                sendJson(response, 400, {
                  error: '目录里找不到对应的线上版本，无法从本地开发恢复。 / No catalog entry matches this local plugin, so it cannot be restored to a registry install.',
                })
                return
              }
              spec = catalogTarget
            }
            // Replacing a package on disk under a live agent is a mixed-state
            // hazard the "restart" verdict cannot fix: the running module keeps
            // executing while its files change under it, so lazily imported
            // assets and data reads can fail or change version mid-turn.
            // No bypass is offered — the user can wait or cancel the agent.
            const busyAgents = runningAgentsForGuard()
            if (busyAgents.length > 0) {
              logEvent('warn', 'update-blocked', `${name}: refused while agents are running — ${busyAgents.join(', ')}`)
              sendJson(response, 409, {
                error: `有 agent 正在运行（${busyAgents.join(', ')}）。更新会直接替换插件文件，正在工作的 agent 可能在执行中途读到缺失或新版本的文件而报错；请等它完成或取消后再更新。 / ${busyAgents.length === 1 ? 'An agent is running' : 'Agents are running'} (${busyAgents.join(', ')}). Updating replaces plugin files in place, so a working agent can fail or mix versions mid-turn; wait for it to finish (or cancel it) before updating.`,
                agentsBusy: true,
                runningAgents: busyAgents,
              })
              return
            }
            const beforeInstalled = readInstalled(config.profile, activeProfileDir)
            // Re-running add re-resolves the source: git HEAD for github specs,
            // dist-tag latest for registry installs.
            // A GitHub source in EITHER spelling. Under a download region
            // that mirrors GitHub, an installed plugin carries a proxied
            // codeload URL rather than the `github:` shortcut, and asking
            // only about the shortcut sent those down the npm path below —
            // where `name@latest` either fails or, far worse, installs an
            // unrelated package that happens to share the plugin's name.
            // The `github:` shortcut keeps its own handling, fragments and
            // all — `githubUpdateTarget` is what preserves a monorepo
            // `#path:` while dropping revision selectors (#281).
            //
            // A proxied codeload URL is the OTHER spelling of the same
            // source, carried by anything installed under a region that
            // mirrors GitHub. It has no fragment to preserve (subpath entries
            // are never accelerated), so the canonical shortcut is rebuilt
            // from it. Without this branch these fell through to the npm path
            // below, where `name@latest` either fails or — far worse —
            // installs an unrelated package that shares the plugin's name.
            const codeloadRepo = spec.startsWith('github:') ? null : repoOfTarget(spec)
            const gitSpec = spec.startsWith('github:')
              ? githubUpdateTarget(spec)
              : codeloadRepo === null ? null : `github:${codeloadRepo}`
            const isGit = gitSpec !== null
            // `@latest` was hardcoded, so a beta subscriber would have been
            // told an update existed and then handed the stable build. The
            // dist-tag has to follow the same setting the offer came from.
            // The market follows its channel; everything else is `latest`.
            const selfChannel = SELF_NAMES.has(name) ? activeChannel() : null
            const tag = selfChannel === null ? 'latest' : DIST_TAG[selfChannel]
            // Re-accelerated from the unpinned shortcut, never from the
            // installed URL: that one names the commit already on disk, so
            // reusing it would be an update that can never move.
            //
            // A restore is not an update. `spec` by now IS the catalog target
            // the checkout is being put back onto, and it is already exact: a
            // `#path:` on it selects which package, not which version, and a
            // prebuilt Release tarball (#250) is a URL that `@latest` must not
            // be glued onto — only a bare npm name wants the dist-tag.
            // acceleratedTarget returns anything that is not a bare
            // `github:owner/repo` untouched, so passing a restore through it
            // still gets a China-region mirror where one applies and changes
            // nothing where one does not.
            const target = restore
              ? (NPM_NAME_RE.test(spec) ? `${spec}@${tag}` : await acceleratedTarget(spec, region))
              : gitSpec === null
                ? `${name}@${tag}`
                : await acceleratedTarget(gitSpec, region)
            // Never let `@latest` walk a profile BACKWARDS (#64 by @ZeroOrigin64):
            // a package whose latest dist-tag was left on an older release turns
            // this update into a downgrade that also rewrites an exact pin to
            // `@latest`. Detection already hides the button; this guards the
            // route itself. Unreadable versions fall through and update as before.
            //
            // A channel-following package is exempt from the DIRECTION, not
            // from the check. Going backwards is exactly what "put me back on
            // stable" means, and #64 is about a downgrade nobody asked for —
            // so here the guard only refuses when the channel already points
            // at what is installed, and it compares against the target tag
            // rather than `latest`, which is not the tag being installed.
            if (!isGit && !restore) {
              const installedVersion = readInstalledVersion(config.profile, name, activeProfileDir)
              const registryLatest = selfChannel === null
                ? await fetchNpmLatest(name)
                : await versionOnChannel(name, selfChannel, await fetchNpmLatest(name))
              const refuse = selfChannel === null
                ? installedVersion !== null && registryLatest !== null && !isUpgrade(installedVersion, registryLatest)
                : installedVersion !== null && registryLatest !== null && installedVersion === registryLatest
              if (refuse) {
                logEvent('info', 'update', `${name} refused: latest=${registryLatest} is not newer than installed=${installedVersion}`)
                sendJson(response, 400, {
                  error: `已是最新：registry 的 latest 是 ${registryLatest}，不高于已装的 ${installedVersion}，更新会造成降级。 / Already current: the registry's latest (${registryLatest}) is not newer than the installed ${installedVersion}, so updating would downgrade it.`,
                })
                return
              }
            }
            const repoKey = isGit ? spec.slice('github:'.length).replace(/#.*$/, '').toLowerCase() : null
            // Captured BEFORE pnpm replaces the files: afterwards the loader
            // inventory reads exactly the same, because replacing a package
            // on disk does not unload the module the process already imported.
            // A client-only package has no host half to go stale: its bundle
            // is re-fetched from disk on the next page load, so an update to
            // one needs a refresh, not a restart.
            const wasLive = verifyActivation(config.profile, name, liveNames(), activeProfileDir, disabled.has(name)).state === 'live'
              && hasHostHalf(config.profile, name, activeProfileDir)
            const beforeVersion = readInstalledVersion(config.profile, name, activeProfileDir)
            const beforeCommit = repoKey !== null
              ? readLockCommits(config.profile, activeProfileDir).get(repoKey) ?? null
              : null
            // force: the user chose to install a fresh release without the
            // default one-day safety wait; scoped to this single command.
            const addArgs = force ? ['add', RELEASE_AGE_OVERRIDE, target] : ['add', target]
            // Exact manifest snapshot for failure rollback (#65, #339) — the
            // host can write dependencies AND dsh.profile.bundles before a
            // hard-failed add, leaving residue that breaks the next boot.
            pendingRollbacks.clear()
            const compatibilityBefore = assessProfile(config.profile, activeProfileDir)
            // pnpm re-extracts the whole tree on any operation, so a plugin
            // nobody touched can come back pristine-and-broken, or lose a
            // patch that was holding it together (#222). Only what THIS run
            // broke is attributable to it, so the profile is swept before as
            // well as after.
            const bundlesBefore = brokenClientBundles(config.profile, activeProfileDir)
            const manifestBefore = readProfileManifestSnapshot(config.profile, activeProfileDir)
            const result = await runPlugin(config.profile, addArgs)
            const cancelled = result.cancelled
            if ((result.exitCode !== 0 || result.timedOut) && !cancelled) {
              const rolledBack = restoreProfileManifest(config.profile, manifestBefore, activeProfileDir)
              if (rolledBack.length > 0) logEvent('warn', 'update', `${name}: rolled back manifest residue of the failed run: ${rolledBack.join(', ')}`)
            }
            let ok = result.exitCode === 0 && !result.timedOut && !cancelled
            let stale = false
            let activation: Record<string, ReturnType<typeof verifyActivation>> | undefined
            if (ok) {
              if (restore) {
                // Restore succeeds when the spec is no longer local, even if
                // the checkout already sat on the same version as latest.
                const afterSpec = readInstalled(config.profile, activeProfileDir)[name]
                const stillLocal = afterSpec !== undefined && isLocalSpec(afterSpec)
                if (stillLocal) ok = false
              } else {
                stale = isStaleUpdate({
                  isGit,
                  beforeVersion,
                  afterVersion: readInstalledVersion(config.profile, name, activeProfileDir),
                  beforeCommit,
                  afterCommit: repoKey !== null
                    ? readLockCommits(config.profile, activeProfileDir).get(repoKey) ?? null
                    : null,
                })
                if (stale) ok = false
              }
            }
            // The new build has to be loadable (#159). pnpm exits 0 for any
            // tarball it can extract, and the version really did change, so
            // nothing above notices a package that arrived without its entry
            // artifact — a registry mirror serving a source-only tarball for
            // a just-published version is the reported case, a plugin author
            // shipping a broken `files` list is the other one.
            //
            // Activation cannot stand in for this check: a package updating
            // ITSELF still reports live, because the running fiber belongs to
            // the OLD code that is already in memory. The failure only
            // surfaces on the next boot, as a profile that will not start.
            let brokenEntry = false
            let rollbackOk = true
            let rollbackDetail: string | null = null
            if (ok && !hasLoadableEntry(activeProfileDir, name)) {
              brokenEntry = true
              ok = false
              const rollback = await rollbackUpdateBuild(name, manifestBefore)
              rollbackOk = rollback.ok
              rollbackDetail = rollback.detail
              logEvent('error', 'update',
                `${name}: updated build has no loadable entry — ${rollback.ok ? 'previous build restored' : `could not restore previous files: ${rollback.detail ?? 'unknown'}`}`)
            }
            // Composition-level boot check for the remaining brick shapes:
            // duplicate loader entry ids, unparseable bundle patches, or
            // bundle layers that no longer resolve. hasLoadableEntry cannot
            // see these because the entry file exists — the profile still
            // cannot boot until the next start.
            let trialError: string | null = null
            if (ok) {
              const stack = readBundleStack(activeProfileDir)
              const trial = trialValidate(activeProfileDir, stack.community)
              if (!trial.ok) {
                ok = false
                const first = trial.errors[0]?.message ?? 'the composition would not boot'
                const rollback = await rollbackUpdateBuild(name, manifestBefore)
                rollbackOk = rollback.ok
                rollbackDetail = rollback.detail
                trialError = rollback.ok
                  ? `${name} 更新后的组合无法启动（${first}），已自动回滚并恢复原版本文件。 / ${name} updated to a composition that cannot boot (${first}); the previous build was restored.`
                  : `${name} 更新后的组合无法启动（${first}），回滚未能恢复原版本文件（${rollback.detail ?? 'unknown'}）；请运行 dsh plugin --profile ${config.profile} install 手工恢复。 / ${name} updated to a composition that cannot boot (${first}); the previous files could not be restored (${rollback.detail ?? 'unknown'}) — run 'dsh plugin --profile ${config.profile} install' to recover manually.`
                logEvent('error', 'update',
                  `${name}: trial validation failed — ${first}${rollback.ok ? '; previous build restored' : `; could not restore previous files: ${rollback.detail ?? 'unknown'}`}`)
              }
            }
            let compatibility: { code: 'soft-incompatible'; risks: CompatibilityRisk[]; shadowedNames?: DuplicateName[]; brokenBundles?: Array<{ name: string; reason: string }>; rollbackId: string } | undefined
            if (ok) {
              invalidateUpdates()
              activation = {
                [name]: activationAfterReplace(
                  verifyActivation(config.profile, name, liveNames(), activeProfileDir, disabled.has(name)),
                  wasLive,
                ),
              }
              const after = assessProfile(config.profile, activeProfileDir)
              const risks = introducedRisks(compatibilityBefore, after)
              // An update can introduce shadowing too: a bundle migration
              // moves a plugin between layers, which is exactly the shape
              // #230 reported (bundle layer vs user patch layer).
              const shadowed = introducedDuplicateNames(compatibilityBefore, after)
              // See the install route: an update is the operation the #222
              // report actually hit.
              const bundleCheck = checkClientBundle(config.profile, name, activeProfileDir)
              const brokenBundles = newlyBrokenBundles(
                bundlesBefore,
                [
                  ...(bundleCheck.ok ? [] : [{ name, reason: bundleCheck.reason ?? 'parse failed' }]),
                  ...brokenClientBundles(config.profile, activeProfileDir),
                ].filter((entry, index, all) => all.findIndex(other => other.name === entry.name) === index),
              )
              if (risks.length > 0 || shadowed.length > 0 || brokenBundles.length > 0) {
                compatibility = {
                  code: 'soft-incompatible',
                  risks,
                  shadowedNames: shadowed.length > 0 ? shadowed : undefined,
                  brokenBundles: brokenBundles.length > 0 ? brokenBundles : undefined,
                  rollbackId: savePendingRollback({
                    kind: 'update',
                    names: [name],
                    manifestBefore,
                    // Restore must NOT go through rollbackGitBuild: its target
                    // carries #path: (a second # would corrupt the selector),
                    // and the pre-restore state is the local link:/file: spec
                    // that rollbackUpdateBuild rematerializes with pnpm install.
                    ...(isGit && !restore ? { gitTarget: target, beforeCommit } : {}),
                  }),
                }
                if (brokenBundles.length > 0) {
                  logEvent('error', 'update-bundle', `${brokenBundles.map(entry => `${entry.name}: ${entry.reason}`).join('; ')}`)
                }
                if (risks.length > 0) {
                  logEvent('warn', 'update-compat', `${name}: introduced host-compatibility risks — ${risks.map(risk => `${risk.peer}@${risk.range} vs ${risk.resolved}`).join('; ')}`)
                }
                if (shadowed.length > 0) {
                  logEvent('warn', 'update-shadow', `${name}: introduced cross-layer duplicate loader names — ${shadowed.map(entry => `${entry.name} (${entry.layers.join(' + ')})`).join('; ')}`)
                }
              }
            }
            // Diagnose the stale outcome with EVIDENCE (#45 by @ayingQAQ):
            // only blame pnpm's fresh-release wait when the target's latest
            // release really is young; otherwise be honest that the cause is
            // unconfirmed. Git installs never hit the age gate.
            const youngRelease = stale && !isGit ? await latestPublishedRecently(name) : false
            const staleReason = stale ? (youngRelease === true ? 'release-age' : 'unknown') : null
            const staleError = !stale
              ? null
              : staleReason === 'release-age'
                ? '这个新版本刚发布不久。为了安全，系统默认会等它发布满一天后再安装——刚发布的版本偶尔会被发现问题然后撤回。可以明天再试，或点「立即更新」不再等待。 / This version was just released; for safety, installs normally wait about a day after a release. Try again tomorrow, or click "Update now" to install it right away.'
                : '更新命令执行完成，但版本没有变化，原因未能确认。点「立即更新」重试通常能解决；若仍不行，请导出日志反馈。 / The update command completed but the version did not change; the cause could not be confirmed. Clicking "Update now" to retry usually resolves it — if not, export the log and report it.'
            // Actionable, because the user's own recovery is the right one:
            // the bad artifact is cached under its integrity hash, so a plain
            // re-add reuses it — the package has to be removed first.
            const brokenEntryError = !brokenEntry ? null
              : `${name} 更新后缺少入口文件（package.json 的 main/exports 指向的文件不存在），已自动回滚并重新安装原版本文件，下次启动不受影响。这通常是镜像源在新版本刚发布时同步不完整；若仍需这个版本，请先卸载再从官方源重装。 / ${name} arrived without the entry file its package.json points at; the previous build was restored, so the next boot is unaffected. A registry mirror serving an incomplete tarball for a just-published version is the usual cause — remove the package and reinstall from the official registry if you still want this version.${rollbackOk ? '' : ` Rollback could not restore the previous files: ${rollbackDetail ?? ''}`}`

            const cancelDiff = cancelled ? changedSince(beforeInstalled) : null
            // Build-script blocks hit updates too (#69): a leftover invalid
            // allowBuilds entry (pnpm's placeholder bug, #56) or a newly
            // build-required dep fails the add with ERR_PNPM_IGNORED_BUILDS.
            // Reporting the blocked packages here gives the client the same
            // approve-and-retry banner the install flow has had since #6.
            const ignoredBuilds = ok || cancelled ? undefined : blockedBuilds(result)
            logEvent(ok || cancelled ? 'info' : 'error', 'update',
              `${name} -> ${target} exit=${String(result.exitCode)}${result.timedOut ? ' TIMEOUT' : ''}${cancelled ? ' CANCELLED' : ''}${stale ? ` STALE(${staleReason ?? 'unknown'})` : ''}${ok || cancelled ? '' : ` err=${failureDetail(result)}`}`)
            // A user-cancelled run is a quiet outcome, not an error.
            sendJson(response, ok || cancelled ? 200 : result.busy === true ? 409 : 502, {
              ok,
              cancelled: cancelled || undefined,
              busy: result.busy || undefined,
              stale: stale || undefined,
              partial: cancelDiff?.partial,
              changed: cancelDiff?.changed,
              activation,
              compatibility,
              ignoredBuilds,
              staleReason: staleReason ?? undefined,
              error: trialError ?? brokenEntryError ?? staleError ?? undefined,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              stdout: result.stdout,
              stderr: result.stderr,
              installed: readInstalled(config.profile, activeProfileDir),
            })
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          host.logger?.warn(`[dsh-market] update failed: ${message}`)
          logEvent('error', 'update', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/setup-pnpm',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          const result = await commands.provisionPnpm()
          sendJson(response, 200, { ok: result.ok, error: result.hint })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    /**
     * Remove the market itself, from its card on the plugin configuration
     * page. Deliberately NOT the generic uninstall route, which keeps
     * refusing the market: a destructive action on the thing serving the
     * request should be reachable only from the surface built for it, and
     * never as a stray `{ name: "dshmarket" }` on the ordinary path.
     *
     * Removing itself is safe, which is not obvious and was measured before
     * this was written: an already-imported module does not vanish with its
     * files, so the process keeps serving and the response completes
     * normally. The profile boots clean afterwards, with the market's rows
     * gone from `dependencies` and `dsh.profile.bundles`.
     */
    /**
     * Which release channel the market offers ITSELF from.
     *
     * Writable from the card because the settings scope is host-mode only —
     * a browser that is not on loopback never gets one, and the choice would
     * be unreachable there. Same-origin POST, like every other mutation.
     */
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/channel',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { channel?: unknown }
          const wanted = asChannel(body.channel)
          if (wanted === null) {
            sendJson(response, 400, { error: 'channel must be "stable", "beta" or "dev"' })
            return
          }
          config.channel = wanted
          // Persisted with the market's own durable state, so the choice
          // survives a restart — a setting that forgets is a setting the
          // user has to make again every boot.
          marketState.channel = wanted
          writeMarketState(activeProfileDir, marketState)
          // The cached listing was computed for the old channel, so the very
          // next check would answer for a setting that no longer applies.
          invalidateUpdates()
          logEvent('info', 'channel', `release channel set to ${wanted}`)
          sendJson(response, 200, { ok: true, channel: wanted })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    /**
     * Which mirrors every outbound request uses.
     *
     * Beside the channel route rather than in the settings namespace, and
     * for the reason recorded there: a value the market stores in its own
     * state.json cannot also be owned by the settings schema without the two
     * writing over each other.
     */
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/region',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { region?: unknown }
          const wanted = asRegion(body.region)
          if (wanted === null) {
            sendJson(response, 400, { error: 'region must be "global" or "china"' })
            return
          }
          applyRegion(wanted)
          config.region = wanted
          marketState.region = wanted
          // A choice made by hand is no longer the probe's choice, so the
          // one-time explanation stops being offered.
          marketState.regionAuto = undefined
          regionAuto = false
          writeMarketState(activeProfileDir, marketState)
          // Both caches were filled from the other region's origins. The
          // catalog validator in particular is scoped to the URL that issued
          // it and would be meaningless against the new one.
          forgetCatalog()
          invalidateUpdates()
          logEvent('info', 'region', `download region set to ${wanted}`)
          sendJson(response, 200, { ok: true, region: wanted })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/self-uninstall',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        // The same single door the restart route uses — and only it. Both
        // end the market's life in this process, so neither may be driven by
        // a remote or forwarded client. A separate `sameOrigin` call would
        // read as an extra guard while testing nothing: origin-matches-host
        // is already part of what this checks, so no request can fail one
        // and pass the other.
        if (!trustedRestartRequest(request)) {
          sendJson(response, 403, { error: 'self-uninstall is limited to same-origin loopback requests' })
          return
        }
        try {
          await withMutationLock(response, 'install', async () => {
            const body = (await readJsonBody(request)) as { confirm?: unknown; purge?: unknown }
            // An explicit flag, not merely reaching the endpoint: this is the
            // one route whose accidental success cannot be undone from the UI
            // that would have undone it.
            if (body.confirm !== true) {
              sendJson(response, 400, { error: 'self-uninstall requires an explicit confirmation' })
              return
            }
            const installed = readInstalled(config.profile, activeProfileDir)
            const selfName = ['dshmarket', 'dsh-market'].find(candidate => installed[candidate] !== undefined)
            if (selfName === undefined) {
              sendJson(response, 400, { error: 'the market is not an installed dependency of this profile' })
              return
            }

            const result = await runPlugin(config.profile, ['remove', selfName])
            const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled
            if (!ok) {
              // Report what pnpm actually said. A bare "removal failed" on
              // the one action the user cannot retry from a UI that is
              // still there would leave them with nothing to act on.
              const said = (result.stderr.trim() || result.stdout.trim()).slice(-800)
              sendJson(response, 502, {
                ok: false,
                error: said === '' ? 'removing the market failed' : said,
                timedOut: result.timedOut,
                cancelled: result.cancelled,
              })
              return
            }

            // Opt-in cleanup. Rows the market wrote to the USER patch layer
            // outlive it: a plugin switched off here stays off after the
            // market is gone, and the only UI that could switch it back on
            // has just been removed. Only rows belonging to packages on the
            // market's own disable list are touched — a hand-written row is
            // the user's, not ours.
            const purge = body.purge === true
            const restored: string[] = []
            if (purge) {
              for (const name of disabled) {
                const ids = rowIdsForPackage(host, activeProfileDir, name)
                if (ids.length > 0) {
                  removeRowBlocks(userPatchPath, ids)
                  restored.push(name)
                }
              }
              purgeMarketState(activeProfileDir)
            }
            logEvent('info', 'self-uninstall',
              `removed ${selfName}${purge ? `; purged state, restored ${String(restored.length)} disabled plugin(s)` : '; state kept'}`)

            sendJson(response, 200, {
              ok: true,
              removed: selfName,
              purged: purge,
              restored,
              restart: restartAllowed(config),
            })

            // AFTER the response. The package is gone from disk, so the host
            // now 404s on this plugin's client bundle while the loader entry
            // is still live — the shape that wedges the whole page on the
            // next refresh (#37). Disabling our own entry composes the page
            // without the market instead. Deferred because it disposes the
            // context this handler runs in.
            //
            // This is also why nothing here schedules a restart. An earlier
            // version offered one, first as a button in the end state (which
            // could only answer 405, since the disable takes the restart
            // route with it) and then as a checkbox in the confirmation. Both
            // were asking the user to arrange a consequence rather than
            // stating it: the browser drops the market the moment this runs,
            // and the leftover disabled entry is cleared by whatever restart
            // happens next. There is no decision to offer.
            setTimeout(() => {
              void themes.setEntryDisabled(selfName, true).catch(() => { /* a later restart resolves it either way */ })
            }, 0)
          })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/restart',
      handler: (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        // One-click restart contributed in #14 by @ysyyhhh.
        if (!restartAllowed(config)) {
          sendJson(response, 403, { error: 'self-restart is disabled for this host' })
          return
        }
        if (!trustedRestartRequest(request)) {
          sendJson(response, 403, { error: 'restart is limited to same-origin loopback requests' })
          return
        }
        if (writing || installing) {
          sendJson(response, 409, { error: 'cannot restart while a plugin operation is running' })
          return
        }
        if (restarting) {
          sendJson(response, 409, { error: 'restart already scheduled' })
          return
        }
        restarting = true
        try {
          const result = scheduleRestart(servingPort(request))
          logEvent('info', 'restart', `scheduled pid=${String(result.pid)} helper=${String(result.helperPid)}`)
          sendJson(response, 202, { ok: true, boot: BOOT_ID, ...result })
        } catch (error) {
          restarting = false
          const message = error instanceof Error ? error.message : String(error)
          logEvent('error', 'restart', message)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/approve-builds',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          // One-click build-script approval (#6 by @qichuang321): only
          // packages physically present in the profile's installed tree can
          // be allowed — the list is not free input. Presence is checked in
          // node_modules, NOT the dependencies map: pnpm's blocked build
          // scripts are usually TRANSITIVE deps (cloudflared, ssh2,
          // cpu-features…), which never appear in package.json (#56 by
          // @walnut1218).
          // pnpm 11's ndjson `ignored-scripts` event reports version-qualified
          // names (cloudflared@0.7.3); strip the @version suffix so the
          // allowlist keys and node_modules lookups use bare package names.
          const stripVersion = (name: string): string => {
            const at = name.lastIndexOf('@')
            return at > 0 ? name.slice(0, at) : name
          }
          const PKG_RE = /^(@[A-Za-z0-9-~][A-Za-z0-9._~-]*\/)?[A-Za-z0-9-~][A-Za-z0-9._~-]*$/
          const body = (await readJsonBody(request)) as { packages?: unknown }
          const requested = (Array.isArray(body.packages) ? body.packages.map(String).map(stripVersion) : [])
            .filter(name => PKG_RE.test(name))
          const installed = requested
            .filter(name => existsSync(join(activeProfileDir, 'node_modules', name, 'package.json')))
          // Git-hosted plugins rejected by pnpm's FETCHER (#68) exist in
          // neither node_modules nor package.json — the only trusted anchor
          // left is the curated registry itself: a name that resolves to a
          // github-sourced catalog entry may be approved pre-materialization.
          //
          // pnpm only matches a git-hosted dep's allowBuilds entry under its
          // stable `name@git+https://…` key (#68/#69) — a bare name entry is
          // ignored (verified against pnpm 11.21). Derive that key wherever
          // the github source is known: from the profile spec for installed
          // deps, from the curated registry for pending ones. The bare name
          // is kept alongside — it authorizes the npm-sourced case.
          const specs = readInstalled(config.profile, activeProfileDir)
          const packages: string[] = []
          /**
           * Both key forms for one github source (#285).
           *
           * pnpm 11.21+ matches the stable `git+https://…` key; 11.7.0 — what
           * DSH Desktop bundles — matches only a commit-pinned codeload URL,
           * so on those versions the approval button wrote a key pnpm would
           * never read and could never work. The pin is resolved here rather
           * than assumed: `github:owner/repo` names no commit, and the one
           * pnpm will fetch is whatever HEAD is at install time.
           *
           * A pin that cannot be resolved is simply omitted. The stable key
           * still covers modern pnpm, and an approval that authorizes less
           * than hoped is better than one that fails.
           */
          const buildKeys = async (name: string, spec: string): Promise<string[]> => {
            const stable = gitAllowBuildsKey(name, spec)
            if (stable === null) return []
            const repo = repoOfTarget(spec)?.split('#')[0] ?? null
            // A proxied install already carries its commit; only a bare
            // shortcut has to go and ask.
            const pinned = /codeload\.github\.com\/[^/\s]+\/[^/\s]+\/tar\.gz\/([0-9a-f]{40})/.exec(spec)?.[1]
              ?? (repo === null ? null : await resolveHeadCommit(repo, region))
            const codeload = pinned === null || pinned === undefined
              ? null
              : codeloadAllowBuildsKey(name, spec, pinned)
            return codeload === null ? [stable] : [stable, codeload]
          }
          for (const name of requested) {
            if (installed.includes(name)) {
              packages.push(name, ...await buildKeys(name, String(specs[name] ?? '')))
              continue
            }
            if (specs[name] !== undefined) continue
            // The catalog can now FAIL rather than quietly serving a bundled
            // copy, and this key is an optimisation, not a requirement: the
            // bare name already authorizes the npm-sourced case, and a git
            // source that misses its key simply prompts again. Losing the
            // catalog must not turn "allow this build" into a 500.
            let entry
            try {
              entry = (await loadRegistry()).plugins.find(p => p.name === name || p.npm === name)
            } catch (error) {
              logEvent('warn', 'approve-builds', `catalog unavailable, authorizing ${name} by name only: ${error instanceof Error ? error.message : String(error)}`)
              packages.push(name)
              continue
            }
            const target = entry === undefined ? null : installTargetFor(entry)
            const keys = target === null ? [] : await buildKeys(name, target)
            if (keys.length > 0) {
              packages.push(name, ...keys)
            }
          }
          if (packages.length === 0) {
            sendJson(response, 400, { error: 'no installed packages given' })
            return
          }
          const approved = setAllowBuilds(config.profile, packages, activeProfileDir)
          logEvent('info', 'approve-builds', `allowed build scripts: ${approved.join(', ')}`)
          sendJson(response, 200, { ok: true, approved })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logEvent('error', 'approve-builds', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/cancel',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        // Cancel flow contributed in #6 by @qichuang321.
        if (!commands.cancelActive()) {
          sendJson(response, 400, { error: 'no operation is running' })
          return
        }
        logEvent('info', 'cancel', `cancelled ${progress.target || 'operation'}`)
        sendJson(response, 200, { ok: true, cancelled: true, target: progress.target })
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/uninstall',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          await withMutationLock(response, 'install', async () => {
            const body = (await readJsonBody(request)) as { name?: unknown; force?: unknown }
            const name = typeof body.name === 'string' ? body.name : ''
            // Only the INDETERMINATE patch case is forceable, below. A patch
            // that definitely names the package stays refused: there the user
            // has a concrete thing to go fix, so an override would only help
            // them break their next boot.
            const force = body.force === true
            if (name === 'dsh-market' || name === 'dshmarket') {
              sendJson(response, 400, { error: 'the market cannot uninstall itself; use the dsh CLI' })
              return
            }
            if (readInstalled(config.profile, activeProfileDir)[name] === undefined) {
              sendJson(response, 400, { error: 'plugin is not installed' })
              return
            }
            const userPatchReferences = userPatchPackageReferences(userPatchPath, name)
            if (userPatchReferences === null && !force) {
              // Refusing here is right — an unreadable patch might still load
              // the package, and removing it would break the next boot. But
              // refusing with NO way through is the wrong shape: the market
              // cannot say which row to fix, and the moment someone wants to
              // uninstall is usually the moment something is already broken.
              // So this one is forceable, and says so.
              logEvent('warn', 'uninstall-blocked', `${name}: user cordis.patch.yml could not be inspected safely`)
              sendJson(response, 409, {
                error: `无法安全卸载 ${name}：当前 profile 的 cordis.patch.yml 无法读取为有效的补丁列表，因此无法排除它仍在引用该包。请先检查补丁文件；确认无关后可强制卸载。 / Cannot safely uninstall ${name}: this profile's cordis.patch.yml could not be read as a valid patch list, so the market cannot rule out a remaining package reference. Check the patch file; you can force the uninstall once you are sure it is unrelated.`,
                userPatchInspectionFailed: true,
                forceable: true,
              })
              return
            }
            if (userPatchReferences === null) {
              logEvent('warn', 'uninstall', `${name}: forced past an unreadable user cordis.patch.yml`)
            }
            if (userPatchReferences !== null && userPatchReferences.length > 0) {
              const listed = userPatchReferences.join(', ')
              logEvent('warn', 'uninstall-blocked', `${name}: user cordis.patch.yml still inserts ${listed}`)
              sendJson(response, 409, {
                error: `无法卸载 ${name}：当前 profile 的 cordis.patch.yml 仍通过 insert 引用 ${listed}。请先移除这些用户补丁引用再重试；市场不会自动改写用户补丁。 / Cannot uninstall ${name}: this profile's cordis.patch.yml still inserts ${listed}. Remove those user-owned patch references first and retry; the market will not rewrite the user patch automatically.`,
                userPatchReferenced: true,
                patchReferences: userPatchReferences,
              })
              return
            }
            const busyAgents = runningAgentsForGuard()
            if (busyAgents.length > 0) {
              logEvent('warn', 'uninstall-blocked', `${name}: refused while agents are running — ${busyAgents.join(', ')}`)
              sendJson(response, 409, {
                error: `有 agent 正在运行（${busyAgents.join(', ')}）。卸载会修改插件文件，正在工作的 agent 可能在中途报错；请等它完成或取消后再卸载。 / ${busyAgents.length === 1 ? 'An agent is running' : 'Agents are running'} (${busyAgents.join(', ')}). Uninstalling changes plugin files, so a working agent can fail mid-turn; wait for it to finish (or cancel it) before uninstalling.`,
                agentsBusy: true,
                runningAgents: busyAgents,
              })
              return
            }
            pendingRollbacks.clear()
            const beforeInstalled = readInstalled(config.profile, activeProfileDir)
            // isDisabled comes from the patch layer (#130) — keep it while the
            // lock moves into withMutationLock (#125).
            const activation = {
              [name]: verifyActivation(config.profile, name, liveNames(), activeProfileDir, disabled.has(name)),
            }
            const result = await runPlugin(config.profile, ['remove', name])
            const cancelled = result.cancelled
            const ok = result.exitCode === 0 && !result.timedOut && !cancelled
            const cancelDiff = cancelled ? changedSince(beforeInstalled) : null
            // Half-uninstall guard: pnpm can fail a remove AFTER deleting
            // node_modules but BEFORE saving package.json (#65's write-order
            // mirror image — a file locked mid-unlink aborts the run). The
            // manifest would then reference a package that no longer exists,
            // and the next boot fails to activate the ghost dependency.
            // Reconcile from disk truth: when the package is gone, finish
            // the removal the CLI could not; when it is intact, keep the
            // manifest so the user can simply retry.
            const halfGone = !ok && !cancelled
              && !existsSync(join(activeProfileDir, 'node_modules', name, 'package.json'))
            let reconciled = false
            if (halfGone) {
              reconciled = dropFromManifest(config.profile, name, activeProfileDir)
              logEvent('warn', 'uninstall', `${name}: remove failed (exit ${String(result.exitCode)}) but the package is gone from disk; ${reconciled ? 'reconciled manifest lists to match' : 'manifest lists already clean'}`)
            }
            let hot = false
            if (ok || halfGone) {
              invalidateUpdates()
              hot = await hotUnmount(name)
              // Bundle-layer plugins never hot-mount, but their loader entry
              // is still LIVE in this process — after the remove deleted the
              // package, the next refresh would 404 on its client bundle and
              // wedge the whole page until a dsh restart (#37 by
              // @1123762794). Live-disable the entry so the refresh composes
              // without it; after a real restart the entry is gone anyway.
              //
              // Both run, unconditionally. This used to short-circuit on the
              // hot unmount, which is right only while a package has ONE
              // activation source — a package that is both hot-mounted AND
              // reachable through the bundle layer got half its cleanup, and
              // the surviving half is exactly the 404-on-refresh wedge above
              // (#213). setEntryDisabled just scans entries by name and
              // returns false when none match, so calling it after a
              // successful unmount costs a lookup and nothing else.
              const entryDisabled = await themes.setEntryDisabled(name, true)
              hot = hot || entryDisabled
              // Patch-layer rows must not survive the remove either: a
              // `- id: X` + `disabled: true` row for a package that no longer
              // mounts is a boot-time orphan (port of dsh-plugin-hub).
              removeRowBlocks(userPatchPath, rowIdsForPackage(host, activeProfileDir, name))
              // The disable list must not keep a removed plugin: a later
              // reinstall starts enabled. Group memberships follow the same
              // rule so no group toggle ever targets a ghost member.
              disabled.delete(name)
              removeFromGroups({ groups, groupOrder }, name)
              writeMarketState(activeProfileDir, { disabled, groups, groupOrder })
            }
            logEvent(ok || cancelled ? 'info' : 'error', 'uninstall',
              `${name} exit=${String(result.exitCode)}${cancelled ? ' CANCELLED' : ''}${ok ? ` live-removed=${String(hot)}` : cancelled ? '' : ` err=${failureDetail(result)}`}`)
            sendJson(response, ok || cancelled ? 200 : result.busy === true ? 409 : 502, {
              ok,
              cancelled: cancelled || undefined,
              busy: result.busy || undefined,
              // A failed remove whose package vanished from disk was
              // reconciled: the manifest lists match disk truth again, the
              // removal is final (a retry would 400 on "not installed").
              reconciled: reconciled || undefined,
              hot,
              partial: cancelDiff?.partial,
              changed: cancelDiff?.changed,
              // The state of the package that was just removed (captured pre-op).
              activation,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              installed: readInstalled(config.profile, activeProfileDir),
            })
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          host.logger?.warn(`[dsh-market] uninstall failed: ${message}`)
          logEvent('error', 'uninstall', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/rollback',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          await withMutationLock(response, 'install', async () => {
            const body = (await readJsonBody(request)) as { rollbackId?: unknown }
            const id = typeof body.rollbackId === 'string' ? body.rollbackId : ''
            const pending = pendingRollbacks.get(id)
            if (pending === undefined) {
              sendJson(response, 400, { error: 'rollback is not available (it may have been superseded by another operation) / 回滚已不可用（可能已被后续操作覆盖）' })
              return
            }
            let ok = true
            let hot = false
            let detail: string | null = null
            if (pending.kind === 'update') {
              const name = pending.names[0]!
              const result = pending.gitTarget !== undefined
                ? await rollbackGitBuild(name, pending.manifestBefore!, pending.gitTarget, pending.beforeCommit ?? null)
                : await rollbackUpdateBuild(name, pending.manifestBefore!)
              ok = result.ok
              detail = result.detail
            } else {
              for (const name of pending.names) {
                const result = await removeInstalledPackage(name)
                hot ||= result.hot
                if (!result.ok) {
                  ok = false
                  detail = result.detail
                  break
                }
              }
            }
            if (ok) {
              pendingRollbacks.delete(id)
              invalidateUpdates()
              logEvent('info', 'rollback', `${pending.kind}: ${pending.names.join(', ')} restored`)
            } else {
              logEvent('error', 'rollback', `${pending.kind}: ${pending.names.join(', ')} failed — ${detail ?? 'unknown'}`)
            }
            sendJson(response, ok ? 200 : 502, {
              ok,
              rolledBack: ok,
              hot,
              detail: detail ?? undefined,
              installed: readInstalled(config.profile, activeProfileDir),
            })
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          host.logger?.warn(`[dsh-market] rollback failed: ${message}`)
          logEvent('error', 'rollback', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/install',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          await withMutationLock(response, 'install', async () => {
            const body = (await readJsonBody(request)) as { url?: unknown }
            const busyAgents = runningAgentsForGuard()
            if (busyAgents.length > 0) {
              logEvent('warn', 'install-blocked', `refused while agents are running — ${busyAgents.join(', ')}`)
              sendJson(response, 409, {
                error: `有 agent 正在运行（${busyAgents.join(', ')}）。安装会修改插件文件，正在工作的 agent 可能在中途报错；请等它完成或取消后再安装。 / ${busyAgents.length === 1 ? 'An agent is running' : 'Agents are running'} (${busyAgents.join(', ')}). Installing changes plugin files, so a working agent can fail mid-turn; wait for it to finish (or cancel it) before installing.`,
                agentsBusy: true,
                runningAgents: busyAgents,
              })
              return
            }
            const url = typeof body.url === 'string' ? body.url : ''
            const registry = await loadRegistry()
            const entry = registry.plugins.find(p => p.url.toLowerCase() === url.toLowerCase())
            if (entry === undefined) {
              logEvent('warn', 'install-rejected', `not in curated registry: ${url.slice(0, 120)}`)
              sendJson(response, 400, { error: 'plugin is not in the curated registry' })
              return
            }
            const plainTarget = installTargetFor(entry)
            if (plainTarget === null) {
              sendJson(response, 400, { error: 'unsupported source url' })
              return
            }
            // Route a GitHub download through the region's mirror, when there
            // is one and the target can express it. Applied HERE, before the
            // guards below, so every step downstream reasons about the spec
            // that will actually be installed — the duplicate guard and the
            // build-script key both read targets, and both understand either
            // spelling. Returns the original on any failure (see accelerate.ts).
            const target = await acceleratedTarget(plainTarget, region)
            if (target !== plainTarget) {
              logEvent('info', 'region', `${entry.name}: downloading through the ${region} mirror`)
            }
            // Duplicate guard (#27): the same plugin listed under another name
            // (an alias entry pointing at the same repo) must never install
            // twice — two loader entries with one id brick the next boot.
            // Monorepo subpath entries (distinct plugins in one repo) pass:
            // their entry urls differ by subpath and identity is name-based.
            // A dependency left in package.json by a FAILED install (blocked
            // build scripts: pnpm writes the manifest, then exits 1) is NOT a
            // duplicate — it was never activated. Blocking the retry would
            // make the approve-builds flow dead-end, so a leftover that is the
            // SAME package/source (not a repo-only alias of a different entry)
            // and is not yet active (bundle layer or live mount) may be retried.
            const installedNow = readInstalled(config.profile, activeProfileDir)
            const aliasOf = findInstalledAlias(entry, installedNow)
            // When the duplicate guard allows a retry of a leftover dep, that
            // name must be treated as "newly added" by the post-install
            // validation and hot-mount below (it IS in package.json from the
            // failed attempt, so the plain before/after diff would miss it).
            let retryAlias: string | null = null
            if (aliasOf !== null) {
              // Same install? The leftover's own name/spec must match what we
              // are about to add — an npm entry retries under its npm name; a
              // github entry's package.json spec equals the target.
              // Compared as IDENTITIES, not as strings. One GitHub plugin has
              // two spellings depending on the download region — the
              // `github:` shortcut and a proxied codeload tarball — so a
              // literal comparison would call a leftover from before a region
              // switch "a different source" and refuse the retry it exists to
              // allow. `repoOfTarget` returns null for npm names and file
              // links, which fall through to the string comparison below.
              const installedSpec = String(installedNow[aliasOf] ?? '').replace(/^file:/, '')
              const wantedSpec = String(target).replace(/^file:/, '')
              const installedRepo = repoOfTarget(installedSpec)
              const wantedRepo = repoOfTarget(wantedSpec)
              const sameSource = aliasOf.toLowerCase() === (entry.npm ?? '').toLowerCase()
                || (installedRepo !== null && installedRepo === wantedRepo)
                || installedSpec.toLowerCase() === wantedSpec.toLowerCase()
              let active = false
              try {
                const manifest = JSON.parse(readFileSync(join(activeProfileDir, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
                active = (manifest.dsh?.profile?.bundles ?? []).includes(aliasOf) || liveNames().has(aliasOf)
              } catch {
                // unreadable manifest — treat as active to stay safe
                active = true
              }
              if (active || !sameSource) {
                logEvent('warn', 'install-rejected', `${entry.name}: same plugin already installed as ${aliasOf}`)
                sendJson(response, 400, { error: `已以「${aliasOf}」安装过同一个插件，无需重复安装 / this plugin is already installed as "${aliasOf}"` })
                return
              }
              retryAlias = aliasOf
              logEvent('info', 'install', `${entry.name}: ${aliasOf} present but inactive (leftover of a failed install) — retrying`)
            }
            // Name-collision guard (#66): the curated registry lists DISTINCT
            // plugins sharing one name (both dsh-usage-stats, four dsh-memory…).
            // The alias guard above no longer cross-matches them (repo evidence
            // decides), but two packages with one name still cannot coexist —
            // pnpm would silently REPLACE the installed one's dependency entry.
            // Refuse with the honest reason instead.
            if (aliasOf === null) {
              const clashName = [entry.npm, entry.name].find(
                (n): n is string => typeof n === 'string' && n !== '' && installedNow[n] !== undefined,
              )
              if (clashName !== undefined) {
                logEvent('warn', 'install-rejected', `${entry.name}: name collision with installed ${clashName} (${installedNow[clashName]}) from a different source`)
                sendJson(response, 400, {
                  error: `同名冲突：已安装的「${clashName}」来自其他来源，两个同名插件无法共存于一个 profile，请先卸载再安装 / name conflict: an installed plugin already uses the name "${clashName}" but comes from a different source; two plugins with the same name cannot coexist in one profile — uninstall it first`,
                })
                return
              }
            }
            const beforeSpecs = readInstalled(config.profile, activeProfileDir)
            const before = new Set(Object.keys(beforeSpecs))
            if (retryAlias !== null) before.delete(retryAlias)
            pendingRollbacks.clear()
            const compatibilityBefore = assessProfile(config.profile, activeProfileDir)
            // pnpm re-extracts the whole tree on any operation, so a plugin
            // nobody touched can come back pristine-and-broken, or lose a
            // patch that was holding it together (#222). Only what THIS run
            // broke is attributable to it, so the profile is swept before as
            // well as after.
            const bundlesBefore = brokenClientBundles(config.profile, activeProfileDir)
            // Exact manifest snapshot for failure rollback (#65, #339): the
            // host writes dependencies and dsh.profile.bundles before the
            // build-script check / registry fetches run. Either residue can
            // break every later operation or the next boot. Cancelled runs
            // keep their partial state on purpose (the user sees the diff
            // and decides).
            const manifestBefore = readProfileManifestSnapshot(config.profile, activeProfileDir)
            const result = await runPlugin(config.profile, ['add', target])
            const cancelled = result.cancelled
            if ((result.exitCode !== 0 || result.timedOut) && !cancelled) {
              const rolledBack = restoreProfileManifest(config.profile, manifestBefore, activeProfileDir)
              if (rolledBack.length > 0) logEvent('warn', 'install', `${target}: rolled back manifest residue of the failed run: ${rolledBack.join(', ')}`)
            }
            let ok = result.exitCode === 0 && !result.timedOut && !cancelled
            const cancelDiff = cancelled ? changedSince(beforeSpecs) : null
            if (ok) invalidateUpdates()
            if (ok) {
              // Collection repos (e.g. skin monorepos) install as a junk
              // fileset with no root package.json; retarget to the real
              // plugin subdirectories via pnpm's #path: selector.
              ok = await retargetCollections(runPlugin, config.profile, before, target, activeProfileDir)
            }
            // Fake-success guard (#18): a clean exit that added nothing
            // installable must not read as success. Runs even when
            // retargeting partially failed — a broken piece that slipped in
            // must never survive to brick the next boot.
            let notAPlugin = false
            // pnpm exited 0 and the profile did not change at all — a
            // different failure from "what it added was unusable" (#258).
            let addedNothing = false
            let removedBroken: string[] = []
            let conflicts: { name: string; id: string; owner: string }[] = []
            if (result.exitCode === 0 && !result.timedOut && !cancelled) {
              const validated = await validateAddedPlugins(runPlugin, config.profile, before, activeProfileDir)
              removedBroken = validated.removedBroken
              conflicts = validated.conflicts
              if (removedBroken.length > 0) {
                logEvent('warn', 'install', `${target}: removed uninstallable pieces (no dsh manifest or missing build artifacts): ${removedBroken.join(', ')}`)
              }
              if (validated.keep.length === 0) {
                ok = false
                notAPlugin = true
                addedNothing = validated.added.length === 0
                logEvent('error', 'install', addedNothing
                  ? `${target}: the plugin command reported success but added nothing to the profile`
                  : `${target}: nothing installable survived validation (added: ${validated.added.join(', ')})`)
              } else {
                // Partial success across a collection still counts as success.
                ok = true
              }
            }
            const conflictGroups = groupConflictsByOwner(conflicts)
            const installed = readInstalled(config.profile, activeProfileDir)
            let hot = false
            let activation: Record<string, ReturnType<typeof verifyActivation>> | undefined
            let compatibility: { code: 'soft-incompatible'; risks: CompatibilityRisk[]; shadowedNames?: DuplicateName[]; brokenBundles?: Array<{ name: string; reason: string }>; rollbackId: string } | undefined
            let addedPackages: string[] = []
            if (ok) {
              const added = Object.keys(installed).filter(name => !before.has(name))
              addedPackages = added
              if (added.length > 0) {
                // Fresh installs start enabled: drop any stale disable flag
                // (e.g. reinstall after an uninstall while this process kept
                // running) and persist before the activation loop.
                for (const name of added) disabled.delete(name)
                writeMarketState(activeProfileDir, { disabled, groups, groupOrder })
                // Theme installs auto-activate (and deactivate the previous
                // theme) so the result is visible right after the refresh.
                hot = true
                for (const name of added) {
                  const live = pluginCategories(entry).includes('theme')
                    ? await themes.activateTheme(name)
                    : (await hotMount(host, activeProfileDir, name)).ok
                  if (!live) hot = false
                }
                activation = {}
                const live = liveNames()
                for (const name of added) {
                  activation[name] = verifyActivation(config.profile, name, live, activeProfileDir, disabled.has(name))
                }
              }
            }
            if (ok && addedPackages.length > 0) {
              const after = assessProfile(config.profile, activeProfileDir)
              const risks = introducedRisks(compatibilityBefore, after)
              // Cross-layer name shadowing this install introduced (#230).
              // Shares the rollback id with the peer risks when both fire:
              // one operation, one thing to undo.
              const shadowed = introducedDuplicateNames(compatibilityBefore, after)
              // A client bundle that no longer parses (#222): pnpm can leave
              // one half-written or patch-mangled, and today that surfaces
              // as a blank settings page long after the install reported
              // success, with nothing connecting the two.
              const brokenBundles = newlyBrokenBundles(
                bundlesBefore,
                [
                  ...addedPackages
                    .map(pkg => ({ name: pkg, check: checkClientBundle(config.profile, pkg, activeProfileDir) }))
                    .filter(entry => !entry.check.ok)
                    .map(entry => ({ name: entry.name, reason: entry.check.reason ?? 'parse failed' })),
                  ...brokenClientBundles(config.profile, activeProfileDir),
                ].filter((entry, index, all) => all.findIndex(other => other.name === entry.name) === index),
              )
              if (risks.length > 0 || shadowed.length > 0 || brokenBundles.length > 0) {
                compatibility = {
                  code: 'soft-incompatible',
                  risks,
                  shadowedNames: shadowed.length > 0 ? shadowed : undefined,
                  brokenBundles: brokenBundles.length > 0 ? brokenBundles : undefined,
                  rollbackId: savePendingRollback({ kind: 'install', names: addedPackages }),
                }
                if (brokenBundles.length > 0) {
                  logEvent('error', 'install-bundle', `${brokenBundles.map(entry => `${entry.name}: ${entry.reason}`).join('; ')}`)
                }
                if (risks.length > 0) {
                  logEvent('warn', 'install-compat', `${addedPackages.join(', ')}: introduced host-compatibility risks — ${risks.map(risk => `${risk.peer}@${risk.range} vs ${risk.resolved}`).join('; ')}`)
                }
                if (shadowed.length > 0) {
                  logEvent('warn', 'install-shadow', `${addedPackages.join(', ')}: introduced cross-layer duplicate loader names — ${shadowed.map(entry => `${entry.name} (${entry.layers.join(' + ')})`).join('; ')}`)
                }
              }
            }
            logEvent(ok || cancelled ? 'info' : 'error', 'install',
              `${target} exit=${String(result.exitCode)}${result.timedOut ? ' TIMEOUT' : ''}${cancelled ? ' CANCELLED' : ''}${ok ? ` hot=${String(hot)}` : cancelled ? '' : ` err=${failureDetail(result)}`}`)
            const ignoredBuilds = blockedBuilds(result)
            sendJson(response, ok || cancelled ? 200 : result.busy === true ? 409 : 502, {
              ok,
              cancelled: cancelled || undefined,
              busy: result.busy || undefined,
              hot,
              partial: cancelDiff?.partial,
              changed: cancelDiff?.changed,
              activation,
              compatibility,
              ignoredBuilds,
              // Blocked build scripts are expected (pnpm >= 10 blocks them by
              // default): surface the approve-builds banner instead of scaring
              // the user with pnpm's raw stack.
              // A loader-id clash is the most actionable failure of all: the
              // plugin is fine, it just cannot coexist with this profile (#122).
              // The UI renders `conflictGroups`; this string is the fallback
              // for logs and non-UI callers. It attributes each id to the
              // owner that actually declares it — a candidate can clash with
              // several installed plugins at once, and naming only the first
              // owner while listing every id blamed one plugin for another's
              // ids.
              conflictGroups: conflictGroups.length > 0 ? conflictGroups : undefined,
              error: conflictGroups.length > 0
                ? `「${conflicts[0].name}」与已安装的 ${conflictGroups.map(group => `「${group.owner}」（${group.ids.join('、')}）`).join('、')} 占用相同的 loader 条目 id，无法在同一环境中共存——保留会导致 DeepSeek Harness 下次启动失败，因此已自动移除。 / "${conflicts[0].name}" declares the same loader entry id(s) as the installed ${conflictGroups.map(group => `"${group.owner}" (${group.ids.join(', ')})`).join(', ')}; they cannot coexist in one environment — keeping it would stop DeepSeek Harness from starting, so it was removed.`
                : addedNothing
                  // Blaming allowBuilds here sent a reporter chasing a build
                  // step for a plugin that ships a complete lib/ (#258). If
                  // the profile did not change, the plugin is not the thing
                  // that failed — the command that should have installed it
                  // is.
                  ? '安装命令报告成功，但 profile 没有任何变化——插件本身没问题，是执行安装的通道没有真正运行。若使用桌面端，请改用命令行 dsh plugin add 验证，并把导出日志附在 issue 中 / the install command reported success but the profile did not change — the plugin is not at fault, the channel that should have installed it did not actually run. On a desktop build, verify with `dsh plugin add` from a terminal and attach the exported log'
                  : notAPlugin
                    ? 'nothing installable: the plugin(s) need a build step (blocked by default, see allowBuilds) or ship no prebuilt artifacts / 没有可安装的内容：插件需要构建授权（allowBuilds，默认拦截）或未附带构建产物，详见导出日志'
                  : Array.isArray(ignoredBuilds) && ignoredBuilds.length > 0
                  // Names the button but NOT where it is: it was "above",
                  // and this sentence is read inside the operations panel
                  // where the button is not (#314). The panel now carries
                  // the action on this very row, so the text can just say
                  // what to press.
                  ? `构建脚本被 pnpm 默认拦截（${ignoredBuilds.join(', ')}），点击「放行构建脚本并重试」即可放行并重装 / build scripts are blocked by pnpm by default (${ignoredBuilds.join(', ')}); use "Allow build scripts and retry" to approve and reinstall`
                  : undefined,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              stdout: result.stdout,
              stderr: result.stderr,
              installed,
            })
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          host.logger?.warn(`[dsh-market] install failed: ${message}`)
          logEvent('error', 'install', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),
  ]

  return () => {
    for (const dispose of disposers) dispose()
  }
}
