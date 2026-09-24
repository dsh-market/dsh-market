/**
 * The recovery surface a failed market restart leaves behind.
 *
 * Why this exists: a restart button is only as good as what happens when the
 * replacement does not come up. DSH's boot is all-or-nothing — the loader
 * mounts every entry, then `assertEntriesActivated` throws for the first one
 * that failed, so ONE broken plugin means `dsh web` exits and the browser is
 * left holding a dead origin. The market's own UI dies with the host it was
 * serving from, and the only way back used to be editing cordis.patch.yml by
 * hand.
 *
 * So the detached restart helper (src/restart.ts) hands off to THIS module
 * when the replacement it spawned never bound the port. This process is not
 * part of the DSH tree, does not need the tree to load, and takes over the
 * very origin the browser is already polling — which is what lets the market
 * page still open in that tab offer a way out instead of a timeout, and lets
 * a fresh visit to the URL find one too.
 *
 * What it does NOT do: it never boots DSH itself, never edits anything but
 * the profile's own patch layer (plus `dsh.profile.bundles` for a
 * disable-carrier), and never talks to the network. Its whole job is to take
 * the user's choice of "which plugins should be on at the next start", write
 * it through the same durable path the market's own toggles use, and then get
 * out of the way so the real host can bind the port.
 *
 * Security posture: loopback only, same-origin enforced on every mutating
 * request (a cross-site form post carries a foreign Origin and is refused),
 * and the write set is not free input — only the plugin names this process
 * was handed when the restart was scheduled can be switched.
 */

import { spawn } from 'node:child_process'
import { appendFileSync, openSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonBody, sameOrigin, sendJson } from './http.ts'
import { disableRow, enableRow } from './patch.ts'
import { addProfileBundle, removeProfileBundle } from './profile.ts'

/** How long the replacement gets to bind the port before it is a failure. */
const BOOT_TIMEOUT_MS = 45_000

/**
 * How long a replacement must keep answering before its boot counts as up.
 *
 * "Something is listening on the port" is NOT the question, and answering it
 * that way shipped a real false positive: a boot that fails the activation
 * audit has ALREADY bound the web port by the time the audit runs — the tree
 * mounts, the server listens, and only then does DSH refuse the whole
 * composition and exit. The recovery page therefore reported "booted" while
 * dsh was in the middle of dying again, and exited, leaving the user with a
 * dead origin and no surface. Found by the demo plugin, reproduced by the
 * timeline in the recovery log (bound at +3.7s, dead moments later).
 *
 * So a boot is up only once the port has answered CONTINUOUSLY for this long:
 * far longer than an audit takes to reject a tree, and much shorter than a
 * user would notice. A healthy host answers for as long as it runs.
 */
const BOOT_SETTLE_MS = 8_000

/** How long a released port is given to come free before a rebind is hopeless. */
const PORT_FREE_TIMEOUT_MS = 30_000

/**
 * How long the recovery surface stays up with nobody asking for it.
 *
 * It holds the port the real host needs, so a forgotten recovery page must
 * not become "my dsh cannot start any more". A request resets the clock, and
 * the page offers an explicit release as well.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000

/** Bound on the log tail carried in the payload and shown in the page. */
const FAILURE_TAIL_LIMIT = 4000

/** One installed plugin as the recovery surface is allowed to see it. */
export interface RecoveryPlugin {
  /** The installed package name — the only identity a write accepts. */
  name: string
  /** Loader row ids this package owns in the profile patch layer. */
  rows: string[]
  /** Whether it stands enabled for the next boot. */
  enabled: boolean
  /** Host infrastructure: switching it off breaks the chain itself. */
  protected: boolean
  /** A bundle whose patch disables rows it does not own (see the toggle route). */
  carrier: boolean
  /** Whether this surface may switch it at all. */
  toggleable: boolean
  /** Why not, when `toggleable` is false; shown instead of a checkbox. */
  note?: string
}

/**
 * Everything the recovery process needs, written by the market BEFORE the
 * restart (so it survives the host it describes) and read by the helper's
 * handoff.
 */
export interface RecoveryConfig {
  /** The origin the browser is polling; null when it could not be read. */
  port: number | null
  profile: string
  profileDir: string
  patchPath: string
  /** Boot id of the process that scheduled the restart. */
  bootId: string
  marketVersion: string
  scheduledAt: string
  logs: { out: string; err: string }
  /** The replacement invocation, already platform-resolved (see respawnInvocation). */
  spawn: { file: string; args: string[]; viaShell: boolean; detached: boolean }
  cwd: string
  plugins: RecoveryPlugin[]
  /** Overridable for tests and for operators who want the port back sooner. */
  idleTimeoutMs?: number
  /** How long a boot must keep answering before it counts as up (see BOOT_SETTLE_MS). */
  settleMs?: number
}

/** One plugin the boot refused to activate, as the log named it. */
export interface BootFailureEntry {
  /** The loader entry name, verbatim — not yet matched to a package. */
  name: string
  /** The reason the log gave, on one line. */
  reason: string
  kind: 'failed' | 'pending' | 'unresolved'
}

/** What a failed boot's log says, reduced to what the UI can act on. */
export interface BootFailure {
  /** One line naming the shape of the failure. */
  summary: string
  entries: BootFailureEntry[]
  /** The tail of the log, for the "what exactly happened" block. */
  tail: string
}

/** What one plugin's switch did (or why it could not). */
export interface RecoveryChange {
  name: string
  from: boolean
  to: boolean
  error?: string
}

/**
 * Read the last failure DSH wrote into the replacement's log.
 *
 * The shapes come from @deepseek-ai/dsh-app-boot, which is the only thing
 * that writes them: `assertEntriesLoaded` names unresolved modules as
 * `plugin(s) failed to load: a, b`, and `assertEntriesActivated` prints
 * `N entries did not activate` followed by one `<entry>: <reason>` line per
 * failure — each reason being a stack, so every continuation line is
 * indented. `boot()` then wraps the whole thing, and the CLI's fail-loud
 * handler writes that wrapper to stderr, which the helper redirected to a
 * file. Parsing the LAST marker is deliberate: after a recovery restart
 * succeeds in writing a fix and the replacement fails again, the log holds
 * both failures and only the newest one describes the tree as it stands.
 *
 * Anything unrecognized degrades to the log tail with no named entries,
 * because "we could not tell which plugin" must not read as "no plugin
 * failed".
 * @param text - the replacement's captured stderr (and stdout), verbatim.
 * @returns the failure, with entries matched to names rather than packages.
 */
export function parseBootFailure(text: string): BootFailure {
  const normalized = text.replace(/\r\n/gu, '\n')
  const tail = normalized.length > FAILURE_TAIL_LIMIT
    ? normalized.slice(normalized.length - FAILURE_TAIL_LIMIT)
    : normalized

  const markers: Array<{ index: number; kind: 'unresolved' | 'inactive' | 'apply' }> = []
  for (const match of normalized.matchAll(/plugin\(s\) failed to load:/gu)) {
    if (match.index !== undefined) markers.push({ index: match.index, kind: 'unresolved' })
  }
  for (const match of normalized.matchAll(/\d+ entr(?:y|ies) did not activate/gu)) {
    if (match.index !== undefined) markers.push({ index: match.index, kind: 'inactive' })
  }
  // The shape a real composition actually produces: the profile's tree hangs
  // off ONE include entry, so a plugin that throws while the tree is being
  // applied surfaces as an include-apply failure rather than as the audit's
  // list. The chain repeats itself (include → the row → the plugin), each
  // level naming the one below it, so the LAST occurrence is the plugin.
  for (const match of normalized.matchAll(/failed to apply loader entry [^\s(]+ \([^)]+\):/gu)) {
    if (match.index !== undefined) markers.push({ index: match.index, kind: 'apply' })
  }
  markers.sort((a, b) => a.index - b.index)
  const last = markers[markers.length - 1]
  if (last === undefined) {
    const firstLine = normalized.split('\n').map(line => line.trim()).filter(line => line !== '').pop() ?? ''
    return {
      summary: firstLine.slice(0, 300),
      entries: [],
      tail,
    }
  }

  const entries: BootFailureEntry[] = []
  const from = last.index
  const rest = normalized.slice(from)
  if (last.kind === 'apply') {
    // failed to apply loader entry <id> (<name>): <reason> — the id is what
    // the patch layer writes, the name is what the loader loaded.
    const info = /^failed to apply loader entry ([^\s(]+) \(([^)]+)\):\s*([^\n]*)/u.exec(rest)
    const name = (info?.[2] ?? info?.[1] ?? '').trim()
    const reason = (info?.[3] ?? '').trim()
    if (name !== '') {
      entries.push({
        name,
        reason: reason === '' ? 'the entry failed to apply at boot' : reason.slice(0, 200),
        kind: 'failed',
      })
    }
  } else if (last.kind === 'unresolved') {
    // `plugin(s) failed to load: a, b; Cordis startup failed because ...`
    const list = /plugin\(s\) failed to load:\s*([^\n;]*)/u.exec(rest)
    for (const raw of (list?.[1] ?? '').split(',')) {
      const name = raw.trim()
      if (name !== '') entries.push({ name, reason: 'failed to load (module could not be resolved)', kind: 'unresolved' })
    }
  } else {
    const lines = rest.split('\n')
    // The count line ends the marker; failures start on the next line.
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      if (line.trim() === '') {
        if (entries.length > 0) break
        continue
      }
      // Indented lines are the previous failure's stack, never a new entry.
      if (/^\s/u.test(line)) continue
      if (line.startsWith('[') || line.startsWith('dsh: ')) break
      const entry = /^(\S.*?):\s+(\S.*)$/u.exec(line)
      if (entry === null) break
      const reason = entry[2] ?? ''
      entries.push({
        name: entry[1] ?? '',
        reason: reason.slice(0, 200),
        kind: reason.startsWith('pending') ? 'pending' : 'failed',
      })
      if (entries.length >= 50) break
    }
  }

  const count = entries.length
  const names = entries.map(entry => entry.name).join(', ')
  const summary = last.kind === 'unresolved'
    ? `${String(count)} plugin(s) failed to load: ${names}`
    : last.kind === 'apply'
      ? `plugin entry failed to apply: ${names}`
      : `${String(count)} plugin entr${count === 1 ? 'y' : 'ies'} did not activate: ${names}`
  return { summary, entries, tail }
}

/**
 * Match the names a failure used to the plugins a write can name.
 *
 * DSH reports the LOADER entry name, which is the package name for a bundle
 * row and a path for a local include; the market's inventory is keyed by
 * package name and row id. The three comparisons below are the shapes that
 * actually occur: an exact package name, an exact row id (a package may
 * insert a row under another name), and a path whose basename without
 * extension is the package. Unmatched names are returned as well, so the UI
 * can say "DSH named this one and we cannot switch it" rather than silently
 * dropping the only clue the user has.
 * @param plugins - the inventory handed to this process.
 * @param failure - the parsed failure.
 * @returns implicated plugin names and the names that matched nothing.
 */
export function matchFailureToPlugins(
  plugins: readonly RecoveryPlugin[],
  failure: BootFailure,
): { implicated: Set<string>; reasons: Map<string, BootFailureEntry>; unmatched: BootFailureEntry[] } {
  const implicated = new Set<string>()
  const reasons = new Map<string, BootFailureEntry>()
  const unmatched: BootFailureEntry[] = []
  for (const entry of failure.entries) {
    const name = entry.name
    const bare = name.replace(/^file:\/\//u, '').replace(/^\.\//u, '').replace(/[?#].*$/u, '')
    const segments = bare.split(/[\\/]+/u).filter(segment => segment !== '')
    const base = segments[segments.length - 1] ?? bare
    const stem = base.replace(/\.(?:js|mjs|cjs|ts)$/u, '')
    const hit = plugins.find(plugin => plugin.name === name
      || plugin.rows.includes(name)
      || plugin.name === bare
      || plugin.name === base
      // A loader entry named by PATH still says which package it came from:
      // the package is a directory in that path (or the file is named after
      // it). `index` is excluded because every package has one.
      || segments.includes(plugin.name)
      || (stem !== 'index' && plugin.name.split('/').pop() === stem))
    if (hit === undefined) unmatched.push(entry)
    else {
      implicated.add(hit.name)
      if (!reasons.has(hit.name)) reasons.set(hit.name, entry)
    }
  }
  return { implicated, reasons, unmatched }
}

/** The plugin view the UI renders: inventory plus what the failure implicated. */
export interface RecoveryPluginView extends RecoveryPlugin {
  /**
   * The switch position the surface OPENS on, not the plugin's current state.
   * For a plugin this boot blamed — and that can be switched at all — the fix
   * is "off", so the box starts off: that is the contract the failure prompt
   * makes ("the plugins DSH blamed are marked red and left unticked"), and
   * leaving the user to untick a red row by hand is a weaker one.
   */
  enabled: boolean
  implicated: boolean
  /** The reason the boot named, when it named this plugin. */
  reason?: string
}

/** The whole payload both surfaces (the live page and the standalone one) read. */
export interface RecoveryPayload {
  ok: true
  recovery: true
  profile: string
  bootId: string
  scheduledAt: string
  marketVersion: string
  failure: BootFailure
  plugins: RecoveryPluginView[]
  /** Names DSH blamed that this surface cannot switch. */
  unmatched: BootFailureEntry[]
  /** Write errors from the last apply, when the choice could not be written in full. */
  lastErrors: string[]
  logPath: string
}

/**
 * Build the payload from the config and the parsed failure.
 * @param config - the recovery config written before the restart.
 * @param failure - the failure parsed from the replacement's log.
 * @param lastErrors - write errors from the previous apply, if it did not land.
 * @returns the payload both surfaces render.
 */
export function recoveryPayload(
  config: RecoveryConfig,
  failure: BootFailure,
  lastErrors: readonly string[] = [],
): RecoveryPayload {
  const { implicated, reasons, unmatched } = matchFailureToPlugins(config.plugins, failure)
  return {
    ok: true,
    recovery: true,
    profile: config.profile,
    bootId: config.bootId,
    scheduledAt: config.scheduledAt,
    marketVersion: config.marketVersion,
    failure,
    plugins: config.plugins.map((plugin) => {
      const reason = reasons.get(plugin.name)?.reason
      const blamed = implicated.has(plugin.name)
      return {
        ...plugin,
        // Blame is a recommendation and the recommendation is OFF — see
        // RecoveryPluginView.enabled. A plugin that cannot be switched keeps
        // its state: there is nothing the user could do with another position.
        enabled: blamed && plugin.toggleable ? false : plugin.enabled,
        implicated: blamed,
        ...(reason === undefined ? {} : { reason }),
      }
    }),
    unmatched,
    lastErrors: [...lastErrors],
    logPath: config.logs.err,
  }
}

/**
 * Write one desired enable set through the durable layer.
 *
 * `enabled` is the FULL desired state, not a delta: the UI sends what its
 * checkboxes say, and only the differences are written. That is what makes
 * "uncheck everything I just installed, keep the rest" one request, and it is
 * also why a plugin the UI did not mention keeps whatever it had.
 *
 * A disable-carrier moves in and out of `dsh.profile.bundles` as well, the
 * same way the market's toggle route does it (its rows are not the only
 * effect it has). Failures are collected rather than thrown: a partial write
 * must be reported, not swallowed, and the caller then refuses to restart
 * into a composition it could not fully express.
 * @param config - the recovery config.
 * @param enabled - names to leave enabled; every other toggleable plugin is disabled.
 * @returns the changes attempted and the errors, if any.
 */
export async function applyRecovery(
  config: RecoveryConfig,
  enabled: readonly string[],
): Promise<{ ok: boolean; changes: RecoveryChange[]; errors: string[] }> {
  const keep = new Set(enabled)
  const changes: RecoveryChange[] = []
  const errors: string[] = []
  for (const plugin of config.plugins) {
    if (!plugin.toggleable) continue
    const want = keep.has(plugin.name)
    if (want === plugin.enabled) continue
    let error: string | null = null
    if (plugin.carrier) {
      try {
        if (want) addProfileBundle(config.profileDir, plugin.name)
        else removeProfileBundle(config.profileDir, plugin.name)
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
      }
    }
    if (error === null) {
      for (const row of plugin.rows) {
        const result = want ? await enableRow(config.patchPath, row) : await disableRow(config.patchPath, row)
        if (!result.ok) {
          error = result.reason ?? 'the patch layer refused the write'
          break
        }
      }
    }
    if (error !== null) errors.push(`${plugin.name}: ${error}`)
    changes.push({ name: plugin.name, from: plugin.enabled, to: want, ...(error === null ? {} : { error }) })
    // The tree the NEXT failure describes is the one just written: keeping
    // the intent here means a second failed boot shows the switches as the
    // user left them rather than as they were before the write.
    if (error === null) plugin.enabled = want
  }
  return { ok: errors.length === 0, changes, errors }
}

/** Probe one loopback port the way the restart helper does (connect, not bind). */
export function portListening(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const probe = connect({ host: '127.0.0.1', port })
    let settled = false
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      probe.destroy()
      resolvePromise(value)
    }
    probe.on('connect', () => { done(true) })
    probe.on('error', () => { done(false) })
    setTimeout(() => { done(false) }, timeoutMs)
  })
}

const sleep = (ms: number): Promise<void> => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

/** Append one diagnosis line to the recovery's own log, never throwing. */
function note(config: RecoveryConfig, line: string): void {
  try {
    appendFileSync(`${config.logs.err}.recovery.log`, `[dsh-market recovery] ${new Date().toISOString()} ${line}\n`)
  } catch { /* the log is a convenience, not a contract */ }
}

/**
 * Start the replacement and watch whether it takes the port.
 *
 * The caller has already released the listener by the time this runs — the
 * replacement cannot bind otherwise. A child that exits is a verdict on its
 * own and returns immediately: waiting out the full timeout for a process
 * that is already gone is the difference between a recovery page in five
 * seconds and one in forty-five, and the market page's own poll has a
 * deadline, and only once the answer has been STEADY — see BOOT_SETTLE_MS.
 * @param config - the recovery config (spawn invocation and port).
 * @returns whether the replacement really came up.
 */
export async function respawnAndWatch(config: RecoveryConfig): Promise<boolean> {
  if (config.port === null) return false
  let child
  try {
    child = spawn(config.spawn.file, config.spawn.args, {
      cwd: config.cwd,
      detached: config.spawn.detached,
      stdio: ['ignore', openSync(config.logs.out, 'a'), openSync(config.logs.err, 'a')],
      env: process.env,
      shell: config.spawn.viaShell,
      // The recovery server runs without a console (it is spawned detached by
      // the helper), so a console child would be handed a new, visible one
      // (#624). Same flag the restart helper uses for this reason; on POSIX it
      // is inert.
      windowsHide: true,
    })
  } catch (cause) {
    note(config, `could not start the replacement: ${cause instanceof Error ? cause.message : String(cause)}`)
    return false
  }
  let exited = false
  child.on('error', (cause) => {
    exited = true
    note(config, `could not start the replacement: ${cause.message}`)
  })
  child.on('exit', () => { exited = true })
  child.unref()
  const settleMs = config.settleMs ?? BOOT_SETTLE_MS
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  let answeringSince: number | null = null
  while (Date.now() < deadline) {
    if (await portListening(config.port)) {
      if (answeringSince === null) answeringSince = Date.now()
      else if (Date.now() - answeringSince >= settleMs) return true
    } else {
      // Whatever answered is gone again: either the audit rejected the tree
      // after the port came up, or the process died before it got that far.
      answeringSince = null
      if (exited) return false
    }
    await sleep(300)
  }
  note(config, `the replacement did not stay up on port ${String(config.port)} within ${String(BOOT_TIMEOUT_MS / 1000)}s`)
  return false
}

/** Wait for a port to stop answering, so a new listener can take it. */
async function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (await portListening(port)) {
    if (Date.now() > deadline) return false
    await sleep(250)
  }
  return true
}

/**
 * Mask what a bug report must not carry, without flattening the file.
 *
 * log.ts's sanitize() does the masking half and strips control characters on
 * purpose: its input is a one-line event detail, where an embedded newline is
 * log injection. This one's input is a captured process log, where the
 * newlines ARE the structure — running it through that function would produce
 * one unreadable line, which is the opposite of what the export is for.
 */
function redactLog(text: string): string {
  return text
    .replaceAll(homedir(), '~')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_***')
    .replace(/npm_[A-Za-z0-9]{16,}/g, 'npm_***')
    .replace(/bearer\s+\S+/giu, 'Bearer ***')
    .replace(/(authorization|token|apikey|api-key|password)(["':=\s]+)\S+/giu, '$1$2***')
}

/** Read the replacement's log; a missing or unreadable file reads as empty. */
function readLog(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Bilingual copy for the standalone page (the market page has its own). */
const PAGE_TEXT = {
  zh: {
    title: 'DeepSeek Harness 启动失败',
    lead: '市场触发的重启没能起来，dsh 已退出。下面勾选下次启动要启用的插件——报错的插件已经标红并取消勾选。',
    failed: '本次启动报错的插件',
    plugins: '已安装插件（勾选 = 下次启动启用）',
    protected: '宿主基础设施，不能关闭',
    notToggleable: '无法在此关闭',
    none: '没有解析到具体是哪个插件报的错，下面是 dsh 的原始输出。',
    unmatched: 'DSH 点名但本页无法关闭的条目：',
    apply: '保存并重启',
    applying: '正在写入并重启…',
    restarting: '重启中：dsh 起来后本页会自动刷新；若又失败，会带着新的报错回到这里。',
    release: '释放端口并退出',
    log: '完整日志',
    error: '操作失败',
    idle: '长时间无人操作后本页会自动释放端口。',
    changes: '将要改动：',
    nothing: '没有需要改动的插件，直接重启。',
    writeFailed: '上次的选择没能完整写入，因此没有重启：',
  },
  en: {
    title: 'DeepSeek Harness failed to start',
    lead: 'The restart the market triggered never came up, and dsh has exited. Tick the plugins to enable at the next start — the ones the boot blamed are highlighted in red and left unticked.',
    failed: 'Blamed by this boot',
    plugins: 'Installed plugins (ticked = enabled at the next start)',
    protected: 'host infrastructure — cannot be switched off',
    notToggleable: 'cannot be switched off here',
    none: 'The log did not name a plugin; the raw output is below.',
    unmatched: 'Named by DSH but not switchable here:',
    apply: 'Save and restart',
    applying: 'Writing and restarting…',
    restarting: 'Restarting: this page reloads itself once dsh is up; if it fails again you come back here with the new error.',
    release: 'Release the port and quit',
    log: 'Full log',
    error: 'The operation failed',
    idle: 'This page releases the port on its own after a long idle period.',
    changes: 'Changes:',
    nothing: 'Nothing to change — restarting.',
    writeFailed: 'The last choice could not be written in full, so nothing was restarted:',
  },
} as const

type PageLang = keyof typeof PAGE_TEXT

/** JSON safe to embed inside a <script> element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, '\\u003c')
}

/**
 * The standalone recovery page.
 *
 * A separate document rather than a React tree on purpose: the market's
 * bundle lives in the composition that just failed to boot, so the one thing
 * this page must not depend on is the composition. It reads its state from
 * the JSON endpoints and renders the checklist with the same colours as the
 * market page.
 * @param lang - which copy to serve.
 */
export function recoveryPageHtml(lang: PageLang): string {
  const text = PAGE_TEXT[lang]
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${text.title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 32px 20px; font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         background: #f6f7f9; color: #111827; }
  @media (prefers-color-scheme: dark) { body { background: #16181d; color: #e5e7eb; } }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .lead { opacity: .8; margin: 0 0 16px; }
  .err { border: 1px solid #dc2626; border-radius: 8px; padding: 12px; margin: 0 0 16px; background: rgba(220,38,38,.06); }
  .err b { color: #dc2626; }
  pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; opacity: .85; margin: 8px 0 0; max-height: 240px; overflow: auto; }
  h2 { font-size: 13px; text-transform: none; opacity: .7; margin: 20px 0 8px; font-weight: 600; }
  ul { list-style: none; margin: 0; padding: 0; border: 1px solid rgba(128,128,128,.3); border-radius: 8px; overflow: hidden; }
  li { display: flex; gap: 10px; align-items: flex-start; padding: 8px 12px; border-top: 1px solid rgba(128,128,128,.18); }
  li:first-child { border-top: 0; }
  li.blamed { background: rgba(220,38,38,.08); box-shadow: inset 3px 0 0 #dc2626; }
  li.disabled { opacity: .55; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
  .reason { display: block; font-size: 12px; color: #dc2626; word-break: break-word; }
  .note { font-size: 12px; opacity: .65; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 16px; }
  button { font: inherit; padding: 7px 14px; border-radius: 8px; border: 1px solid rgba(128,128,128,.4); background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  button[disabled] { opacity: .5; cursor: default; }
  .changes { font-size: 12px; opacity: .8; margin-top: 8px; }
  .hidden { display: none; }
</style>
</head>
<body>
<main>
  <h1>${text.title}</h1>
  <p class="lead">${text.lead}</p>
  <div class="err" id="err"><b id="errTitle">…</b><pre id="tail"></pre></div>
  <div class="err hidden" id="writeErr"><b id="writeErrTitle"></b><pre id="writeErrDetail"></pre></div>
  <h2 id="blamedHeading">${text.failed}</h2>
  <ul id="list"></ul>
  <p class="note" id="unmatched"></p>
  <div class="changes" id="changes"></div>
  <div class="row">
    <button class="primary" id="apply">${text.apply}</button>
    <button id="release">${text.release}</button>
  </div>
  <p class="note" id="status"></p>
  <p class="note">${text.idle} <span id="logPath"></span></p>
</main>
<script>
(function () {
  var T = ${scriptJson(text)}
  var state = null
  var list = document.getElementById('list')
  var status = document.getElementById('status')
  var changes = document.getElementById('changes')

  function render() {
    if (state === null) return
    document.getElementById('errTitle').textContent = state.failure.summary || T.none
    document.getElementById('tail').textContent = state.failure.tail || ''
    if (state.lastErrors && state.lastErrors.length > 0) {
      document.getElementById('writeErr').classList.remove('hidden')
      document.getElementById('writeErrTitle').textContent = T.writeFailed
      document.getElementById('writeErrDetail').textContent = state.lastErrors.join('\n')
    }
    document.getElementById('logPath').textContent = state.logPath ? T.log + ': ' + state.logPath : ''
    document.getElementById('blamedHeading').textContent = state.failure.entries.length > 0 ? T.failed : T.plugins
    if (state.unmatched.length > 0) {
      document.getElementById('unmatched').textContent = T.unmatched + ' ' + state.unmatched.map(function (e) { return e.name }).join(', ')
    }
    list.textContent = ''
    state.plugins.forEach(function (p) {
      var li = document.createElement('li')
      if (p.implicated) li.className = 'blamed'
      if (!p.toggleable || p.protected) li.className += ' disabled'
      var box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = p.enabled
      box.disabled = !p.toggleable
      box.setAttribute('data-name', p.name)
      box.addEventListener('change', updateChanges)
      var body = document.createElement('div')
      var name = document.createElement('code')
      name.textContent = p.name
      body.appendChild(name)
      if (p.reason) {
        var why = document.createElement('span')
        why.className = 'reason'
        why.textContent = p.reason
        body.appendChild(why)
      }
      if (!p.toggleable) {
        var note = document.createElement('span')
        note.className = 'note'
        note.textContent = p.protected ? T.protected : (p.note || T.notToggleable)
        body.appendChild(note)
      }
      li.appendChild(box)
      li.appendChild(body)
      list.appendChild(li)
    })
    updateChanges()
  }

  function desired() {
    var out = []
    var boxes = list.querySelectorAll('input[type=checkbox]')
    for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) out.push(boxes[i].getAttribute('data-name'))
    return out
  }

  function updateChanges() {
    if (state === null) return
    var want = desired()
    var lines = []
    state.plugins.forEach(function (p) {
      if (!p.toggleable) return
      var on = want.indexOf(p.name) !== -1
      if (on !== p.enabled) lines.push((on ? '+ ' : '- ') + p.name)
    })
    changes.textContent = lines.length === 0 ? T.nothing : T.changes + ' ' + lines.join(', ')
  }

  function waitForHost() {
    status.textContent = T.restarting
    var deadline = Date.now() + 180000
    var tick = function () {
      if (Date.now() > deadline) return
      fetch('/dsh-market/status', { cache: 'no-store' })
        .then(function (res) { return res.ok ? res.json() : null })
        .then(function (body) { if (body !== null) location.reload(); else setTimeout(tick, 2000) })
        .catch(function () { setTimeout(tick, 2000) })
    }
    setTimeout(tick, 2000)
  }

  document.getElementById('apply').addEventListener('click', function () {
    var button = document.getElementById('apply')
    button.disabled = true
    status.textContent = T.applying
    fetch('/dsh-market/recovery/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: desired() })
    }).then(function (res) { return res.json().then(function (body) { return { status: res.status, body: body } }) })
      .then(function (result) {
        if (result.status !== 200 || result.body.ok !== true) {
          button.disabled = false
          status.textContent = T.error + ': ' + (result.body.error || (result.body.errors || []).join('; '))
          return
        }
        waitForHost()
      })
      .catch(function () { waitForHost() })
  })

  document.getElementById('release').addEventListener('click', function () {
    var button = document.getElementById('release')
    button.disabled = true
    fetch('/dsh-market/recovery/release', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function () { status.textContent = T.release })
      .catch(function () { status.textContent = T.release })
  })

  fetch('/dsh-market/recovery', { cache: 'no-store' })
    .then(function (res) { return res.json() })
    .then(function (body) { state = body; render() })
    .catch(function () { status.textContent = T.error })
})()
</script>
</body>
</html>
`
}

/**
 * What the person looking at the surface decided.
 *
 * The enable set travels WITH the decision, because the process that shows
 * the checklist is not the process that writes it: `runRecovery` does the
 * single patch-layer write the user asked for, and it can only do that if the
 * ticks reach it. (They did not, once: the surface recorded the choice, went
 * straight to booting the unchanged composition, and came back with the same
 * error — the demo plugin's run is what exposed it.)
 */
export type RecoveryDecision =
  | { kind: 'apply'; enabled: string[] }
  | { kind: 'released' }
  | { kind: 'idle' }

/** The parts of the recovery server a test (or the CLI) needs to drive it. */
export interface RecoveryServer {
  server: Server
  port: number
  url: string
  close: () => Promise<void>
  /**
   * Resolves when the surface is done being shown: the user asked for the
   * chosen composition to be written and booted (with the enable set they
   * left ticked), asked for the port back, or simply walked away.
   */
  finished: Promise<RecoveryDecision>
}

/** Whether the request came from this machine's own browser session. */
function loopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Which copy the browser asked for, by its own Accept-Language. */
function pageLang(request: IncomingMessage): PageLang {
  const header = request.headers['accept-language'] ?? ''
  return /(^|[,;\s])zh\b/iu.test(header) ? 'zh' : 'en'
}

/**
 * Serve the recovery surface on the port the failed host left behind.
 * @param config - the recovery config written before the restart.
 * @param failure - the failure parsed from the replacement's log.
 * @param options - test seams: an explicit port, and an idle timeout override.
 * @returns the running server and the outcome it settles on.
 */
export async function startRecoveryServer(
  config: RecoveryConfig,
  failure: BootFailure,
  options: { port?: number; idleTimeoutMs?: number; lastErrors?: readonly string[] } = {},
): Promise<RecoveryServer> {
  let currentFailure = failure
  let applyRequested: ((enabled: string[]) => void) | null = null
  let releaseRequested: (() => void) | null = null
  let applying = false
  const idleTimeoutMs = options.idleTimeoutMs ?? config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  let idleTimer: NodeJS.Timeout | null = null
  let idleOut: (() => void) | null = null

  const server = createServer((request, response) => {
    void handle(request, response)
  })

  const touch = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { idleOut?.() }, idleTimeoutMs)
    idleTimer.unref()
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    touch()
    const url = request.url ?? '/'
    const path = url.split('?')[0] ?? '/'
    if (!loopback(request)) {
      response.writeHead(403)
      response.end('loopback only')
      return
    }
    if (path === '/' || path === '/index.html') {
      response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' })
      response.end(recoveryPageHtml(pageLang(request)))
      return
    }
    if (path === '/favicon.ico') {
      response.writeHead(204)
      response.end()
      return
    }
    if (path === '/dsh-market/recovery') {
      sendJson(response, 200, recoveryPayload(config, currentFailure, options.lastErrors ?? []))
      return
    }
    // The market page in the tab that started the restart keeps polling this
    // exact path. Answering it in the host's own shape is what turns "timed
    // out waiting for DeepSeek Harness to start" into an option the user can
    // actually click.
    if (path === '/dsh-market/status') {
      sendJson(response, 200, {
        ok: true,
        boot: config.bootId,
        recovery: true,
        applying,
        version: config.marketVersion,
        profile: config.profile,
        failure: {
          summary: currentFailure.summary,
          entries: currentFailure.entries.map(entry => entry.name),
          plugins: matchFailureToPlugins(config.plugins, currentFailure).implicated.size,
        },
      })
      return
    }
    // The failure banner's own "export log" button fetches this path. A
    // failure nobody can attach to a bug report is half a failure, and the
    // process that holds the evidence is this one.
    if (path === '/dsh-market/logs') {
      const body = [
        '# dsh-market recovery surface',
        `profile: ${config.profile}`,
        `market: ${config.marketVersion}`,
        `restart scheduled: ${config.scheduledAt}`,
        `boot id that failed: ${config.bootId}`,
        `failure: ${currentFailure.summary}`,
        '',
        '## replacement host stdout',
        readLog(config.logs.out),
        '## replacement host stderr',
        readLog(config.logs.err),
        '## recovery surface notes',
        readLog(`${config.logs.err}.recovery.log`),
      ].join('\n')
      response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
      response.end(redactLog(body))
      return
    }
    // An older page bundle (or a user who clicked the pending-restart banner
    // again) would otherwise post here and be told "not found" by a server
    // that knows exactly what happened.
    if (path === '/dsh-market/restart') {
      sendJson(response, 409, {
        error: 'the host is not running: the last start failed, so there is nothing to restart — use the recovery page to adjust plugins / 宿主未在运行：上次启动失败，请用恢复页调整插件',
      })
      return
    }
    if (path === '/dsh-market/recovery/apply' || path === '/dsh-market/recovery/release') {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'untrusted origin' })
        return
      }
      if (path.endsWith('/release')) {
        sendJson(response, 200, { ok: true })
        response.on('finish', () => { releaseRequested?.() })
        return
      }
      let body: unknown
      try {
        body = await readJsonBody(request)
      } catch (cause) {
        sendJson(response, 400, { error: cause instanceof Error ? cause.message : 'bad request body' })
        return
      }
      const requested = (body as { enabled?: unknown } | null)?.enabled
      const enabled = Array.isArray(requested) ? requested.filter((name): name is string => typeof name === 'string') : []
      applying = true
      sendJson(response, 200, { ok: true, applying: true })
      response.on('finish', () => { applyRequested?.(enabled) })
      return
    }
    sendJson(response, 404, { error: 'not found' })
  }

  const port = options.port ?? config.port
  if (port === null) throw new Error('dsh-market recovery: no port to serve on')
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { resolvePromise() })
  })
  touch()

  let finished: RecoveryDecision | null = null
  let resolveFinished: (value: RecoveryDecision) => void = () => {}
  const finishedPromise = new Promise<RecoveryDecision>((resolvePromise) => { resolveFinished = resolvePromise })

  const closeServer = async (): Promise<void> => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    await new Promise<void>((resolvePromise) => { server.close(() => { resolvePromise() }) })
    if (finished === null) {
      finished = { kind: 'released' }
      resolveFinished(finished)
    }
  }

  idleOut = () => {
    if (finished !== null) return
    note(config, 'idle timeout — releasing the port')
    finished = { kind: 'idle' }
    resolveFinished(finished)
    void closeServer()
  }
  releaseRequested = () => {
    if (finished !== null) return
    note(config, 'release requested from the recovery page')
    finished = { kind: 'released' }
    resolveFinished(finished)
    void closeServer()
  }
  applyRequested = (enabled) => {
    note(config, `the user kept ${String(enabled.length)} plugin(s) enabled — writing the choice`)
    if (finished !== null) return
    finished = { kind: 'apply', enabled }
    resolveFinished(finished)
    void closeServer()
  }

  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port
  return {
    server,
    port: boundPort,
    url: `http://127.0.0.1:${String(boundPort)}/`,
    close: closeServer,
    finished: finishedPromise,
  }
}

/**
 * The recovery process end to end: parse the log, serve the surface, and on a
 * user's decision write the choice down and try the boot again — rebinding
 * and starting over when the new composition fails too, because the second
 * failure is the one that says the first guess was wrong.
 * @param config - the recovery config written before the restart.
 * @param facts - what the helper observed (exit code, whether it ever bound).
 * @param options - test seams.
 * @returns the outcome, for the CLI's exit code.
 */
export async function runRecovery(
  config: RecoveryConfig,
  facts: { exitCode: number | null; bound: boolean } = { exitCode: null, bound: false },
  options: { port?: number; idleTimeoutMs?: number } = {},
): Promise<'booted' | 'released' | 'idle'> {
  let failure = parseBootFailure(readLog(config.logs.err))
  if (failure.summary === '' && !facts.bound) {
    failure = {
      ...failure,
      summary: facts.exitCode === null
        ? 'the replacement exited before it bound the port'
        : `the replacement exited with code ${String(facts.exitCode)} before it bound the port`,
    }
  }
  note(config, `recovery surface starting on port ${String(options.port ?? config.port)} — ${failure.summary}`)
  const servePort = options.port ?? config.port
  /** Write errors from the previous apply; they travel into the next payload. */
  let writeErrors: string[] = []
  for (;;) {
    // A failed attempt may still be holding the port while it disposes: binding
    // over it would fail, and the surface the user is looking at would vanish
    // instead of coming back with the new error.
    if (servePort !== null && servePort !== 0 && !(await waitForPortFree(servePort, PORT_FREE_TIMEOUT_MS))) {
      note(config, `port ${String(servePort)} never came free — nothing left to serve on`)
      return 'released'
    }
    const surface = await startRecoveryServer(config, failure, { ...options, lastErrors: writeErrors })
    const outcome = await surface.finished
    if (outcome.kind !== 'apply') return outcome.kind
    // THE WRITE. The surface only collected the ticks; this is where they
    // become patch-layer rows (and, for a disable-carrier, a bundle-stack
    // change). Without it the user's decision is thrown away and the same
    // broken composition is booted again — the bug the demo plugin found.
    const applied = await applyRecovery(config, outcome.enabled)
    if (!applied.ok) {
      // A partial write leaves the profile neither as the user asked nor as it
      // was, so booting it would be booting a guess. Come back to the surface
      // with the errors instead, and let the user retry or fix the patch file.
      writeErrors = [...applied.errors]
      for (const error of applied.errors) note(config, `could not write the choice: ${error}`)
      note(config, 'the choice could not be written in full — back to the recovery surface')
      continue
    }
    writeErrors = []
    note(config, `wrote ${String(applied.changes.length)} change(s): ${applied.changes.map(change => (change.to ? '+' : '-') + change.name).join(', ') || 'none'}`)
    const booted = await respawnAndWatch(config)
    if (booted) {
      note(config, 'the replacement came up and stayed up — recovery surface exiting')
      return 'booted'
    }
    failure = parseBootFailure(readLog(config.logs.err))
    note(config, `the replacement failed again — ${failure.summary}`)
  }
}

/**
 * The script entry: `node lib/recovery.js <config.json> [--exit=N] [--bound=0|1]`.
 * @param argv - arguments after the node executable and this script.
 */
export async function runRecoveryCli(argv: readonly string[]): Promise<void> {
  const configPath = argv.find(argument => !argument.startsWith('--'))
  if (configPath === undefined) {
    process.stderr.write('dsh-market recovery: needs a config path\n')
    process.exitCode = 1
    return
  }
  let config: RecoveryConfig
  try {
    config = JSON.parse(readFileSync(resolve(configPath), 'utf8')) as RecoveryConfig
  } catch (cause) {
    process.stderr.write(`dsh-market recovery: unreadable config ${configPath}: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    process.exitCode = 1
    return
  }
  if (config.port === null) {
    note(config, 'no port was known when the restart was scheduled — no recovery surface to serve')
    return
  }
  const exitArg = argv.find(argument => argument.startsWith('--exit='))
  const boundArg = argv.find(argument => argument.startsWith('--bound='))
  const exitCode = exitArg === undefined ? null : Number(exitArg.slice('--exit='.length))
  const bound = boundArg?.slice('--bound='.length) === '1'
  try {
    const outcome = await runRecovery(config, {
      exitCode: exitCode === null || Number.isNaN(exitCode) ? null : exitCode,
      bound,
    })
    note(config, `recovery surface finished: ${outcome}`)
  } catch (cause) {
    // Nobody is watching this process's stderr (the helper starts it with
    // stdio ignored), so a failure that is not written down here is a failure
    // the user meets as a browser that cannot connect, with no explanation.
    note(config, `recovery surface failed: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`)
    process.exitCode = 1
  }
}

/* v8 ignore start -- the self-executing guard is exercised by the smoke test, not by the unit lane. */
const invoked = process.argv[1]
if (invoked !== undefined) {
  const self = fileURLToPath(import.meta.url)
  const same = process.platform === 'win32'
    ? resolve(invoked).toLowerCase() === resolve(self).toLowerCase()
    : resolve(invoked) === resolve(self)
  if (same) void runRecoveryCli(process.argv.slice(2))
}
/* v8 ignore stop */
