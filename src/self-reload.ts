/**
 * Reload the market's OWN server half inside the running DSH process.
 *
 * Why this exists: the market updates itself by replacing its files, and the
 * Node module it already imported keeps running. The browser, meanwhile, loads
 * the NEW client bundle, which calls routes the old process does not have (the
 * host answers 405 with an empty body). The only cure used to be a restart,
 * and on DSH Desktop even that is not ours to do (`allowRestart: false`).
 *
 * How: not by re-importing ourselves — Node never re-evaluates a module at a
 * URL it has already loaded, and a cache-busted URL only renews the entry
 * file while every sibling it imports stays the old one. The host already
 * solves exactly this for every plugin: `hmr.reconcileProfile()` (the service
 * `@deepseek-ai/dsh-hmr` publishes as `ctx.hmr`, present from DSH 0.2.1)
 * compares the files of every loaded module with the disk, evicts the ones
 * that changed together with their importers, stops the loader entries that
 * ran them and starts those entries again from the new files. The market is a
 * loader entry like any other, so it is replaced the same way. This module is
 * the orchestration around that one call.
 *
 * The part that is ours, and the reason this is more than one call:
 *
 * - The request that asks for the swap is served by the instance about to be
 *   replaced. Its closure outlives its own disposal (the HTTP response object
 *   belongs to the web server, not to the plugin), so the SAME request can
 *   still report how the swap went.
 * - The host does not restore the old code when the new code cannot start: it
 *   evicts the old modules without a backup. So the new build is imported
 *   first, from a private copy at a path Node has never seen, and the swap is
 *   only asked for when that worked. A build that cannot even load never
 *   replaces a market that is running fine.
 * - Which instance is serving is a fact held outside every module — on
 *   `globalThis` under a registered symbol — because the module that would
 *   hold it is exactly what gets replaced.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The slice of the host's `hmr` service this relies on. */
export interface HmrLike {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>
  reconcileProfile(requiredIds?: readonly string[]): Promise<{
    warnings: readonly string[]
    /** Changed modules that keep running their old code until a restart. */
    pending: readonly { url: string; reason: string }[]
    /** Why every change waits for a restart, when the host could not compare modules at all. */
    restartReason?: string
  }>
}

/**
 * The host's HMR service when it can replace modules, otherwise undefined.
 * Checked by shape: DSH 0.2.0 and earlier publish an `hmr` service without
 * `reconcileProfile`, and a call into it would fail after we had decided to
 * go ahead.
 */
export function asHmr(value: unknown): HmrLike | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as { runExclusive?: unknown; reconcileProfile?: unknown }
  return typeof candidate.runExclusive === 'function' && typeof candidate.reconcileProfile === 'function'
    ? value as HmrLike
    : undefined
}

// ── Which instance is serving ─────────────────────────────────────────────

const INSTANCE_KEY = Symbol.for('dsh-market.serving-instance')

/** The instance that registered its routes last. */
export interface InstanceRecord {
  id: string
  version: string
}

type InstanceHolder = { [INSTANCE_KEY]?: InstanceRecord }

let instanceSequence = 0

/**
 * Announce this instance as the one serving. Returns the id to compare
 * against, and a release that only clears the record when it is still this
 * instance's own — a late release from a replaced instance must not erase the
 * record its replacement has already written.
 */
export function claimInstance(version: string): { id: string; release(): void } {
  instanceSequence += 1
  const id = `${String(process.pid)}-${String(Date.now())}-${String(instanceSequence)}-${Math.random().toString(16).slice(2, 8)}`
  const holder = globalThis as InstanceHolder
  holder[INSTANCE_KEY] = { id, version }
  return {
    id,
    release: () => {
      if (holder[INSTANCE_KEY]?.id === id) delete holder[INSTANCE_KEY]
    },
  }
}

/** The instance serving right now, or undefined while none is. */
export function currentInstance(): InstanceRecord | undefined {
  return (globalThis as InstanceHolder)[INSTANCE_KEY]
}

// ── Trying the new build before committing to it ──────────────────────────

/** Verdict of {@link preflightBuild}. */
export type Preflight =
  | { ok: true; checked: boolean }
  | { ok: false; detail: string }

let preflightSequence = 0

/**
 * Whether the package now on disk can be loaded at all.
 *
 * Imports a private copy of its `lib/` from a path nobody has imported, so
 * the whole module graph is evaluated fresh and any failure — a syntax error,
 * a dependency that is missing, a top-level throw — surfaces here, while the
 * running market is still untouched. The copy sits NEXT TO the package so
 * bare imports resolve through the same `node_modules` chain as the real one,
 * and is deleted again afterwards; the host forgets files that disappeared.
 *
 * What it cannot see: a build that loads fine and then fails inside `apply`.
 * That is only learnable by running it.
 *
 * `checked: false` means the check could not be run (the directory is not
 * writable); the caller proceeds, because refusing every reload on a
 * read-only profile would make the feature useless there.
 */
export async function preflightBuild(packageDir: string): Promise<Preflight> {
  let real: string
  let main: string
  try {
    real = realpathSync(packageDir)
    const manifest = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')) as { main?: unknown; version?: unknown }
    main = typeof manifest.main === 'string' ? manifest.main : 'index.js'
  } catch (error) {
    return { ok: false, detail: `the installed package cannot be read — ${messageOf(error)}` }
  }
  if (!existsSync(join(real, main))) return { ok: false, detail: `the entry file ${main} is missing` }
  preflightSequence += 1
  const copy = join(dirname(real), `.dsh-market-reload-${String(process.pid)}-${String(preflightSequence)}`)
  try {
    mkdirSync(copy, { recursive: true })
    cpSync(join(real, 'package.json'), join(copy, 'package.json'))
    cpSync(join(real, dirname(main)), join(copy, dirname(main)), {
      recursive: true,
      // Declarations are not loaded and a second copy of them is dead weight.
      filter: source => {
        const base = basename(source)
        return base !== 'types' && base !== 'node_modules' && !base.endsWith('.d.ts')
      },
    })
  } catch {
    rmSync(copy, { recursive: true, force: true })
    return { ok: true, checked: false }
  }
  try {
    const loaded = await import(/* @vite-ignore */ pathToFileURL(join(copy, main)).href) as { apply?: unknown }
    if (typeof loaded.apply !== 'function') return { ok: false, detail: 'the new build does not export a plugin entry (apply)' }
    return { ok: true, checked: true }
  } catch (error) {
    return { ok: false, detail: messageOf(error) }
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  // The copy's own path means nothing to the reader; the file name does.
  return text.replace(/\.dsh-market-reload-\d+-\d+/g, 'the new build').slice(0, 400)
}

// ── The swap ──────────────────────────────────────────────────────────────

/** What a reload attempt came to. */
export type SelfReloadOutcome =
  /** The host cannot replace modules (or the market is not an installed package here). */
  | { state: 'unsupported'; reason: 'no-hmr' | 'not-installed' }
  /** The files on disk are the version already running: nothing to do. */
  | { state: 'current'; version: string }
  /** The new build cannot load. The running market was not touched. */
  | { state: 'refused'; detail: string }
  /** The new server half is serving. */
  | { state: 'reloaded'; from: string; to: string }
  /** The host could not replace the module; the running market is untouched. */
  | { state: 'restart-needed'; detail: string }
  /** Another host operation holds the reload queue; the swap will run when it ends. */
  | { state: 'queued' }
  /** The swap started and went wrong. `serving` says whether any instance is up. */
  | { state: 'failed'; detail: string; serving: boolean }

export interface SelfReloadDeps {
  /** The host's HMR service, read at call time. */
  hmr: () => HmrLike | undefined
  /** The version this process is running. */
  runningVersion: string
  /** The version of the files on disk, or null when the market is not an installed package. */
  installedVersion: () => string | null
  /** Where the installed package lives. */
  packageDir: () => string
  /** This instance's id, from {@link claimInstance}. */
  instanceId: string
  /** The instance serving now; injectable for the specs. */
  serving?: () => InstanceRecord | undefined
  /** Defaults to {@link preflightBuild}. */
  preflight?: (packageDir: string) => Promise<Preflight>
  /** How long to wait for the host's reload queue before reporting `queued`. */
  queueWaitMs?: number
  /** How long to wait for the new instance to announce itself once the host reports done. */
  settleMs?: number
  log?: (level: 'info' | 'warn', detail: string) => void
}

const DEFAULT_QUEUE_WAIT_MS = 60_000
const DEFAULT_SETTLE_MS = 5_000

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * Ask the host to replace this market with the version on disk.
 *
 * The caller has already refused when an operation is running: a swap ends
 * the instance that would have finished it. Nothing here writes a file.
 */
export async function reloadSelf(deps: SelfReloadDeps): Promise<SelfReloadOutcome> {
  const log = deps.log ?? (() => {})
  const serving = deps.serving ?? currentInstance
  const hmr = deps.hmr()
  if (hmr === undefined) return { state: 'unsupported', reason: 'no-hmr' }
  const target = deps.installedVersion()
  if (target === null) return { state: 'unsupported', reason: 'not-installed' }
  if (target === deps.runningVersion) return { state: 'current', version: target }

  const verdict = await (deps.preflight ?? preflightBuild)(deps.packageDir())
  if (!verdict.ok) {
    log('warn', `reload to ${target} refused, the new build does not load: ${verdict.detail}`)
    return { state: 'refused', detail: verdict.detail }
  }
  if (!verdict.checked) log('warn', `reload to ${target}: the new build could not be test-loaded first`)

  log('info', `reloading ${deps.runningVersion} -> ${target}`)
  const queueWaitMs = deps.queueWaitMs ?? DEFAULT_QUEUE_WAIT_MS
  const swap = hmr.runExclusive(() => hmr.reconcileProfile())
  // The swap itself is never abandoned: it was asked for, and running it a
  // little late is what the user wants. Only the WAITING for it has a limit.
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = await Promise.race([
    swap.then(report => ({ report }), (error: unknown) => ({ error })),
    new Promise<'queued'>(resolve => { timer = setTimeout(() => { resolve('queued') }, queueWaitMs) }),
  ]).finally(() => { clearTimeout(timer) })
  if (waited === 'queued') {
    void swap.catch((error: unknown) => { log('warn', `queued reload failed: ${messageOf(error)}`) })
    return { state: 'queued' }
  }
  if ('error' in waited) {
    const detail = messageOf(waited.error)
    const stillOurs = serving()?.id === deps.instanceId
    log('warn', `reload to ${target} failed${stillOurs ? ' (the running market was not touched)' : ''}: ${detail}`)
    return stillOurs
      ? { state: 'restart-needed', detail }
      : { state: 'failed', detail, serving: serving() !== undefined }
  }

  // The host says it is done. Believe the instance record, not the report: the
  // new instance announces itself when its routes are up, which is the fact
  // that matters.
  const deadline = Date.now() + (deps.settleMs ?? DEFAULT_SETTLE_MS)
  for (;;) {
    const now = serving()
    if (now !== undefined && now.id !== deps.instanceId) {
      log('info', `reloaded to ${now.version}`)
      return { state: 'reloaded', from: deps.runningVersion, to: now.version }
    }
    if (Date.now() >= deadline) break
    await sleep(100)
  }
  const now = serving()
  if (now?.id === deps.instanceId) {
    // Nothing was replaced: the host could not compare or evict the modules
    // (a loader without access to Node's module cache, a host-owned module).
    const why = waited.report.restartReason !== undefined
      ? `the host could not replace modules (${waited.report.restartReason})`
      : waited.report.pending.length > 0
        ? `the host keeps ${String(waited.report.pending.length)} changed module(s) until a restart (${waited.report.pending[0]!.reason})`
        : 'the host reported done but the old code is still running'
    log('warn', `reload to ${target}: ${why}`)
    return { state: 'restart-needed', detail: why }
  }
  const detail = 'the new version did not start serving'
  log('warn', `reload to ${target}: ${detail}`)
  return { state: 'failed', detail, serving: false }
}

/**
 * The HTTP answer for an outcome. Every failure says what happened, why and
 * what to do now, in the project's two-language style; the state code is for
 * the page, which decides what to offer next.
 */
export function selfReloadReply(outcome: SelfReloadOutcome): { status: number; body: Record<string, unknown> } {
  switch (outcome.state) {
    case 'reloaded':
      return { status: 200, body: { ok: true, state: 'reloaded', from: outcome.from, to: outcome.to } }
    case 'current':
      return { status: 200, body: { ok: true, state: 'current', version: outcome.version } }
    case 'queued':
      return {
        status: 202,
        body: {
          ok: true,
          state: 'queued',
          message: 'DSH 正在处理另一项变更，市场会在它结束后自动换成新版。 / DSH is busy with another change. The market will switch to the new version when it finishes.',
        },
      }
    case 'unsupported':
      return {
        status: 501,
        body: {
          ok: false,
          state: 'unsupported',
          error: outcome.reason === 'no-hmr'
            ? '这个 DSH 版本不能原地换上新版市场。重启 DSH 就会用上新版。 / This DSH version cannot switch to the new market in place. Restart DSH to use it.'
            : '市场不是作为插件装在这里的，没有新版文件可换。要用磁盘上的文件，请重启 DSH。 / The market is not installed as a plugin here, so there is no new version to switch to. Restart DSH to run what is on disk.',
        },
      }
    case 'refused':
      return {
        status: 422,
        body: {
          ok: false,
          state: 'refused',
          detail: outcome.detail,
          error: '新版本没能加载，已保留正在运行的版本，它照常可用。请再更新一次；重启 DSH 能看到具体原因。 / The new version could not load, so the running one was kept and still works. Update again, or restart DSH to see why.',
        },
      }
    case 'restart-needed':
      return {
        status: 502,
        body: {
          ok: false,
          state: 'restart-needed',
          detail: outcome.detail,
          error: 'DSH 这次没能换上新版，当前仍是旧版，功能照常。重启 DSH 就会用上新版。 / DSH could not switch to the new version this time. The old one keeps working. Restart DSH to use the new one.',
        },
      }
    case 'failed':
      return {
        status: 502,
        body: {
          ok: false,
          state: 'failed',
          serving: outcome.serving,
          detail: outcome.detail,
          error: '切换到新版时出了问题，市场暂时不可用。重启 DSH 即可恢复。 / Switching to the new version went wrong and the market is unavailable. Restart DSH to recover.',
        },
      }
  }
}
