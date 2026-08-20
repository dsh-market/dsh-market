/**
 * Process layer: re-invoking the dsh CLI that launched this host, spawning
 * `dsh plugin` commands with timeouts and live progress, and provisioning
 * pnpm. This is the only module that starts child processes.
 *
 * Installs run through node:child_process, not ctx.shell: the shell service is
 * the agent's sandboxed executor and denies writes to the profile directory.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { logEvent } from './log.ts'
import { createProgressTracker, type ProgressPhase } from './ndjson.ts'
import { pluginArgsFor } from './pnpm-compat.ts'
import { profileDir } from './profile.ts'

// 15 min default (slow networks + git installs), overridable for CI/tests.
// (#6 by @qichuang321.)
/**
 * macOS apps launched from Finder/Dock inherit a minimal PATH without the
 * shell profile — Homebrew/npm/corepack all vanish and every install dies
 * with ENOENT/127 (#32, #38). Append the well-known bin directories so the
 * market's children find their tools regardless of how dsh was started.
 */
/**
 * Directories discovered at runtime that hold a usable pnpm — currently
 * npm's global bin, learned after a successful one-click setup (#149).
 * Every later spawn sees them, so the market does not have to be restarted
 * for the pnpm it just installed to become visible.
 */
const extraPathDirs: string[] = []

/**
 * The real Node executable for spawning children. On Android the kernel runs
 * node through the dynamic linker, so `process.execPath` is
 * `/apex/.../linker64` — spawning IT with `--expose-internals` makes the
 * linker treat the flag as the program path and die with
 * `error: expected absolute path: "--expose-internals"`. `process.argv0`
 * carries the real node binary; prefer it whenever it is an existing
 * absolute path, and fall back to execPath everywhere else.
 * @param argv0 - `process.argv0`, injectable for tests.
 * @param execPath - `process.execPath`, injectable for tests.
 */
export function nodeExecutable(argv0: string | undefined = process.argv0, execPath: string = process.execPath): string {
  if (argv0 !== undefined && argv0 !== '' && isAbsolute(argv0) && existsSync(argv0))
    return argv0
  return execPath
}

/**
 * The directory holding the Node binary running this process. `npm`,
 * `npm.cmd` and `corepack` are installed alongside it by every official Node
 * distribution, so it is the one place the toolchain can be looked for
 * without guessing — and unlike a PATH entry it cannot be absent, because
 * this process is executing out of it.
 *
 * #167: a Windows desktop host spawned dsh without the Node install
 * directory on PATH. Node itself was running (v24.18.1 in the log) while
 * both `corepack` and `npm` came back "not recognized as an internal or
 * external command", so the one-click setup had no way to succeed.
 */
export const nodeBinDir = dirname(nodeExecutable())

/**
 * Translate the machine's proxy environment into the ONE form pnpm reads.
 *
 * `HTTPS_PROXY` / `http_proxy` are what every other tool honours, and what
 * `net.ts` already routes the market's own catalog fetches through — but
 * pnpm ignores them completely. It reads npm config, so a proxy reaches it
 * only as `npm_config_https_proxy` / `npm_config_proxy` (or an .npmrc entry,
 * which is the user's file and not ours to rewrite).
 *
 * That gap is why the market could load its catalog through a proxy and
 * then hang installing anything at all — reported four separate times
 * (#148, #161, #188, #232), always from a network that needs one.
 *
 * An `npm_config_*` value the caller already set always wins: it is the more
 * specific statement of intent, and on Windows env keys are case-insensitive
 * so the check has to be too. NO_PROXY is forwarded verbatim because pnpm
 * reads `npm_config_noproxy` and a host excluding its own registry mirror
 * must keep excluding it.
 */
export function proxyEnvForPnpm(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const has = (name: string): boolean => {
    const wanted = name.toLowerCase()
    return Object.keys(env).some(key => key.toLowerCase() === wanted && (env[key] ?? '').trim() !== '')
  }
  const pick = (...names: string[]): string | null => {
    for (const name of names) {
      const raw = env[name]
      if (raw !== undefined && raw.trim() !== '') return raw.trim()
    }
    return null
  }
  const out: NodeJS.ProcessEnv = {}
  // Same precedence as undici's EnvHttpProxyAgent (lowercase over uppercase,
  // https falling back to http), so pnpm goes where the catalog fetch went.
  const https = pick('https_proxy', 'HTTPS_PROXY') ?? pick('http_proxy', 'HTTP_PROXY')
  const http = pick('http_proxy', 'HTTP_PROXY') ?? https
  if (https !== null && !has('npm_config_https_proxy')) out.npm_config_https_proxy = https
  if (http !== null && !has('npm_config_proxy')) out.npm_config_proxy = http
  const noProxy = pick('no_proxy', 'NO_PROXY')
  if (noProxy !== null && !has('npm_config_noproxy')) out.npm_config_noproxy = noProxy
  return out
}

function spawnEnv(): NodeJS.ProcessEnv {
  // pnpm v10+ blocks forever on a silent interactive prompt without a TTY;
  // CI mode forces it to act or fail instead of asking.
  const separator = process.platform === 'win32' ? ';' : ':'
  const parts = (process.env.PATH ?? '').split(separator).filter(part => part !== '')
  const candidates = process.platform === 'win32'
    ? [nodeBinDir, ...extraPathDirs]
    : ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), nodeBinDir, ...extraPathDirs]
  for (const bin of candidates) {
    if (!parts.includes(bin)) parts.push(bin)
  }
  return { ...process.env, ...proxyEnvForPnpm(), CI: 'true', PATH: parts.join(separator) }
}

const INSTALL_TIMEOUT_MS = Number(process.env.DSH_MARKET_INSTALL_TIMEOUT_MS) || 15 * 60 * 1000

/**
 * Windows npm/corepack/pnpm are `.cmd` shims. Node's `spawn` without a shell
 * cannot start them (ENOENT / EINVAL). Same pattern as dsh's `plugin` forwarder.
 */
export const winCmdShim = process.platform === 'win32'

/** Characters cmd.exe treats as syntax even inside a token. */
const CMD_METACHARS = /[\s"&|<>^()%!]/

/**
 * Quote one argv token for a cmd.exe `/c` command line. cmd only groups with
 * double quotes, so a token that needs quoting gets wrapped and embedded
 * quotes are doubled.
 */
export function quoteCmdArg(arg: string): string {
  if (!CMD_METACHARS.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

/**
 * Build a cmd.exe command line from argv. Only the Windows shim path uses
 * this: cmd re-parses the joined string, so every token is quoted before
 * joining.
 */
export function cmdCommandLine(argv: readonly string[]): string {
  return argv.map(quoteCmdArg).join(' ')
}

/** cmd.exe resolved once; the Windows shim path only. */
const COMSPEC = process.env.ComSpec ?? 'cmd.exe'

/** Spawn options plus the explicit shim switch used by callers. */
type SpawnShimOptions = SpawnOptions & { viaShell?: boolean }

/**
 * Spawn a command, avoiding Node's deprecated `shell: true` + argv
 * combination (DEP0190). Windows `.cmd` shims cannot start without a shell,
 * so the shim path routes through `cmd.exe /d /s /c` with an explicitly
 * built, quoted command line; every other invocation spawns directly with
 * `shell: false`.
 */
function spawnShim(file: string, args: readonly string[], options: SpawnShimOptions): ChildProcess {
  const { viaShell = false, ...spawnOptions } = options
  if (!viaShell) {
    return spawn(file, [...args], { ...spawnOptions, shell: false })
  }
  if (process.platform !== 'win32') {
    return spawn(file, [...args], { ...spawnOptions, shell: false })
  }
  return spawn(COMSPEC, ['/d', '/s', '/c', `"${cmdCommandLine([file, ...args])}"`], {
    ...spawnOptions,
    shell: false,
    windowsVerbatimArguments: true,
  })
}

/**
 * Argv re-invoking the CLI that launched this host process, so installs work
 * whether dsh runs from a global bin, a local install, or repo source
 * (`node --import tsx/esm .../bin.ts`). Falls back to a PATH `dsh`.
 */
export function dshArgv(): { file: string; args: string[]; cwd: string | undefined; viaShell: boolean } {
  const entry = process.argv[1]
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    // Absolute paths are required: source launches (`pnpm dsh`) pass a
    // relative entry, which the child resolves against its OWN cwd and dies
    // with MODULE_NOT_FOUND (#13). cwd near the entry keeps execArgv imports
    // (tsx/esm) resolvable on source launches.
    const abs = resolve(entry)
    return { file: nodeExecutable(), args: [...process.execArgv, abs], cwd: dirname(abs), viaShell: false }
  }
  // Bare `dsh` is a .cmd shim on Windows that only a shell can start (#13).
  return { file: 'dsh', args: [], cwd: undefined, viaShell: winCmdShim }
}

/** Outcome of one spawned plugin command. */
export interface InstallResult {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  /** True when the run ended because the user cancelled it. */
  cancelled: boolean
  /** Desktop's generation-wide package-operation gate rejected the start. */
  busy?: boolean
  /** Package names pnpm reported as having ignored build scripts (ndjson). */
  ignoredBuilds?: string[]
}

/** The shape every orchestration function takes to run plugin commands (injectable in tests). */
export type PluginRunner = (profile: string, pluginArgs: string[]) => Promise<InstallResult>

/** Package-operation boundary consumed by the HTTP route layer. */
export interface PluginCommandRuntime {
  runPlugin: PluginRunner
  probePnpm(): Promise<boolean>
  provisionPnpm(): Promise<{ ok: boolean; hint?: string }>
  cancelActive(): boolean
}

/** Structural subset of DSH Desktop's public `desktopPnpm` contract. */
export interface DesktopPnpmLike {
  runPlugin(
    args: readonly string[],
    invokingDir: string,
    signal?: AbortSignal,
  ): {
    readonly stdout: NodeJS.ReadableStream
    readonly stderr: NodeJS.ReadableStream
    readonly done: Promise<{
      readonly exitCode: number | null
      readonly signal: NodeJS.Signals | null
    }>
    cancel(): void
  }
}

/** Desktop runtime also owns cleanup of any operation started by this fiber. */
export interface DesktopPluginRuntime extends PluginCommandRuntime {
  dispose(): Promise<void>
}

/**
 * Kill a spawned child and, on Windows, its whole process tree — `kill()`
 * there only terminates the wrapper, leaving pnpm children running.
 * (Contributed in #7 by @mraing.)
 */
export function killChild(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
      return
    } catch { /* fall through */ }
  }
  child.kill('SIGKILL')
}

/** The child of the operation currently running, for /dsh-market/cancel. */
let activeChild: ChildProcess | null = null
let cancelRequested = false

interface ActiveDesktopOperation {
  readonly owner: symbol
  readonly cancel: () => void
  readonly done: Promise<InstallResult>
  userCancelled: boolean
}

let activeDesktopOperation: ActiveDesktopOperation | null = null

/**
 * Kill a child and its whole tree, gracefully where the platform allows:
 * taskkill /T /F on Windows (plain kill() leaves pnpm children running),
 * SIGTERM with a 5s SIGKILL escalation elsewhere so pnpm can clean up.
 * (Cancel flow contributed in #6 by @qichuang321.)
 */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
      return
    } catch { /* fall through */ }
  }
  // POSIX: the dsh wrapper runs pnpm as a grandchild (spawnSync), which a
  // plain child.kill() leaves running — it keeps our stdio pipes open, so
  // the close event never fires and the market looks stuck "installing".
  // The child is spawned detached as its own process GROUP; kill the group.
  const signalTree = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return
    try { process.kill(-child.pid, signal) } catch {
      try { child.kill(signal) } catch { /* already gone */ }
    }
  }
  signalTree('SIGTERM')
  const escalate = setTimeout(() => signalTree('SIGKILL'), 5000)
  escalate.unref?.()
}

/**
 * Cancel the plugin command currently running.
 * @returns true when there was one to cancel.
 */
export function cancelActive(): boolean {
  if (activeDesktopOperation !== null) {
    activeDesktopOperation.userCancelled = true
    progress.cancelling = true
    activeDesktopOperation.cancel()
    return true
  }
  if (activeChild === null) return false
  cancelRequested = true
  progress.cancelling = true
  killTree(activeChild)
  return true
}

/** Whether `pnpm` resolves on PATH; success is cached, absence is re-probed. */
let pnpmReady = false

/** Probe `pnpm --version` on PATH. */
export function probePnpm(): Promise<boolean> {
  if (pnpmReady) return Promise.resolve(true)
  return new Promise((resolvePromise) => {
    const child = spawnShim('pnpm', ['--version'], { stdio: 'ignore', viaShell: winCmdShim, env: spawnEnv() })
    child.on('error', () => resolvePromise(false))
    child.on('close', (code) => {
      pnpmReady = code === 0
      resolvePromise(pnpmReady)
    })
  })
}

function runQuiet(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawnShim(file, args, {
      env: spawnEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      viaShell: winCmdShim,
    })
    let output = ''
    const timer = setTimeout(() => killChild(child), timeoutMs)
    const collect = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-8 * 1024) }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (error) => { clearTimeout(timer); resolvePromise({ code: 127, output: error.message }) })
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, output }) })
  })
}

/**
 * Provision pnpm without user involvement: corepack (ships with Node) first,
 * a global npm install as fallback.
 * @returns true when `pnpm --version` succeeds afterwards.
 */
export async function provisionPnpm(): Promise<{ ok: boolean; hint?: string }> {
  const corepack = await runQuiet('corepack', ['enable', 'pnpm'], 60 * 1000)
  logEvent(corepack.code === 0 ? 'info' : 'warn', 'setup-pnpm', `corepack enable: exit=${String(corepack.code)} ${corepack.output.slice(-200)}`)
  if (await probePnpm()) return { ok: true }
  const npm = await runQuiet('npm', ['install', '-g', 'pnpm'], 3 * 60 * 1000)
  logEvent(npm.code === 0 ? 'info' : 'error', 'setup-pnpm', `npm -g: exit=${String(npm.code)} ${npm.output.slice(-200)}`)
  if (await probePnpm()) return { ok: true }
  // The install SUCCEEDED but the new binary is somewhere this process does
  // not look (#149: corepack exit=0, npm -g exit=0, and the market still
  // said "setup failed"). npm knows where it just put it, so ask — and if
  // pnpm runs from there, remember that directory for every later spawn
  // instead of telling the user a successful install failed.
  if (npm.code === 0 || corepack.code === 0) {
    const prefix = await runQuiet('npm', ['prefix', '-g'], 30 * 1000)
    const bin = prefix.code === 0 ? join(prefix.output.trim().split('\n').pop() ?? '', 'bin') : ''
    if (bin !== '' && isAbsolute(bin) && !extraPathDirs.includes(bin)) {
      extraPathDirs.push(bin)
      logEvent('info', 'setup-pnpm', `added npm's global bin to the probe path: ${bin}`)
      if (await probePnpm()) return { ok: true }
      extraPathDirs.pop()
    }
  }
  const npmFound = toolOnPath('npm')
  if (!npmFound) logEvent('warn', 'setup-pnpm', `npm is not on any searched path (node lives in ${nodeBinDir})`)
  return { ok: false, hint: provisionHint(corepack.output, npm.output, npmFound) }
}

/** Executable suffixes a bare command name can carry on this platform. */
const EXECUTABLE_SUFFIXES = process.platform === 'win32'
  ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(part => part !== '')
  : ['']

/**
 * Whether a bare command name resolves to a file on the PATH the market
 * hands its children.
 *
 * The market cannot read the reason a spawn failed out of the child's
 * message: cmd.exe reports a missing command in the console's ANSI codepage
 * ("'npm' 不是内部或外部命令" on a Chinese Windows), which is neither the
 * string `ENOENT` nor even valid UTF-8 — so the #32 hint, written against
 * Node's own ENOENT wording, could never fire on Windows and the user was
 * left with no guidance at all (#167). Looking on disk answers the same
 * question in every locale.
 */
export function toolOnPath(name: string): boolean {
  const separator = process.platform === 'win32' ? ';' : ':'
  for (const dir of (spawnEnv().PATH ?? '').split(separator)) {
    if (dir === '') continue
    for (const suffix of EXECUTABLE_SUFFIXES) {
      if (existsSync(join(dir, name + suffix))) return true
    }
  }
  return false
}

/**
 * Why the one-click pnpm setup failed, in terms the user can act on.
 *
 * Every one of these was a real report where the market said only "自动准备
 * 没成功" while the log held the actual cause: EEXIST (#142 — corepack had
 * already placed a pnpm shim, so `npm -g` refused to overwrite it), EPERM
 * (#108 — Node installed somewhere the user cannot write), ENOENT (#32 —
 * a GUI launch with no Node on PATH at all).
 * @returns a bilingual, actionable hint, or undefined when unrecognized.
 */
export function provisionHint(corepackOutput: string, npmOutput: string, npmFound = true): string | undefined {
  // Node itself unreachable: pointing the user back at this same button
  // would be a dead end (#32). `npmFound` answers this from disk, so it
  // holds on a Windows console that reports the same thing in a codepage we
  // cannot read (#167); the ENOENT match stays for callers without it.
  if (!npmFound || (/ENOENT/.test(corepackOutput) && /ENOENT/.test(npmOutput))) {
    return `这台机器的 dsh 进程找不到 npm/corepack（图形界面或桌面端启动时不继承终端 PATH）。已在 Node 自己的目录里找过（${nodeBinDir}）也没有——多半是宿主内置的 Node 运行时不带 npm。请改从终端启动 dsh，或单独装一个 pnpm：Windows 用 iwr https://get.pnpm.io/install.ps1 -useb | iex，macOS/Linux 用 brew install pnpm / This dsh process cannot find npm/corepack (GUI and desktop launches skip your shell PATH). The directory Node itself runs from (${nodeBinDir}) was searched too — a bundled Node runtime without npm is the usual cause. Start dsh from a terminal, or install pnpm on its own: \`iwr https://get.pnpm.io/install.ps1 -useb | iex\` (Windows) or \`brew install pnpm\` (macOS/Linux)`
  }
  if (/EEXIST|already exists|--force to overwrite/i.test(npmOutput)) {
    return 'pnpm 的可执行文件已存在（通常是 corepack 先放好了同名 shim），npm 拒绝覆盖。在终端里执行其一即可：corepack prepare pnpm@latest --activate（推荐，直接激活已有 shim）或 npm i -g pnpm --force / A pnpm executable already exists (usually a corepack shim), so npm refused to overwrite it. Run one of these in a terminal: `corepack prepare pnpm@latest --activate` (preferred — activates the shim already there) or `npm i -g pnpm --force`'
  }
  if (/EPERM|EACCES|permission denied|as root\/Administrator/i.test(`${corepackOutput}\n${npmOutput}`)) {
    return '没有权限写入 Node 的安装目录。请用管理员/sudo 执行一次 npm i -g pnpm，或改用无需写系统目录的安装方式：macOS/Linux 用 brew install pnpm，Windows 用 iwr https://get.pnpm.io/install.ps1 -useb | iex / No permission to write into the Node install directory. Run `npm i -g pnpm` once as Administrator/sudo, or install pnpm without touching system dirs: `brew install pnpm` (macOS/Linux) or `iwr https://get.pnpm.io/install.ps1 -useb | iex` (Windows)'
  }
  // Network-shaped failures: the corepack shim downloads pnpm on first run,
  // so a blocked registry or proxy leaves a shim that never works. The
  // button cannot fix that; a full install (or a mirror) can.
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|proxy|certificate/i.test(`${corepackOutput}\n${npmOutput}`)) {
    return '装 pnpm 时网络失败。若你在受限网络下，corepack 的 shim 也下载不到 pnpm 本体——请改用完整安装或指定镜像：brew install pnpm（macOS/Linux），或 npm i -g pnpm --registry <你的镜像> / Network failure while installing pnpm. On a restricted network the corepack shim cannot download pnpm either — install it fully or point at a mirror: `brew install pnpm`, or `npm i -g pnpm --registry <your mirror>`'
  }
  return undefined
}

/** Live progress of the running plugin command, for the status route. */
export interface InstallProgress {
  active: boolean
  target: string
  startedAt: number
  lastLine: string
  /** Parsed from pnpm's ndjson stage events; null when none arrived. */
  phase: ProgressPhase
  /** Distinct packages resolved/fetched so far. */
  done: number
  total: number | null
  currentPackage: string | null
  downloaded: number | null
  size: number | null
  /** True when structured ndjson progress has been observed. */
  ndjson: boolean
  /** Last fatal error from the stream (only meaningful after a failure). */
  error: string | null
  /** True from the moment the user asks to cancel until the run ends. */
  cancelling: boolean
}

/** Singleton progress state; the status route reads it, runDshPlugin writes it. */
export const progress: InstallProgress = {
  active: false,
  target: '',
  startedAt: 0,
  lastLine: '',
  phase: null,
  done: 0,
  total: null,
  currentPackage: null,
  downloaded: null,
  size: null,
  ndjson: false,
  error: null,
  cancelling: false,
}

/** Identifies this host process; the client scopes its pending-restart flags to it. */
export const BOOT_ID = `${String(process.pid)}-${String(Date.now())}`

/**
 * Central allowlist for every spawn target, regardless of which route built
 * it (defense in depth on top of per-route validation — the win32 bare-dsh
 * fallback runs through a shell). Suggested in #16 by @anupamme.
 *
 * `^`, `~` and `=` are intentionally allowed: restore/install flows turn
 * manifest specs such as "dsh-better-sidebar": "^0.14.0" into targets like
 * `dsh-better-sidebar@^0.14.0`, and regex-valid semver ranges must not be
 * mistaken for shell injection (whitespace and shell metacharacters remain
 * rejected — the win32 bare-dsh fallback is the reason to keep them out).
 */
export const TARGET_RE = /^[A-Za-z0-9@:./_#+~^=-]+$/

/** Mutating pnpm commands get the structured reporter appended. */
const NDJSON_COMMANDS = new Set(['add', 'remove', 'install'])

/** Apply profile-specific pnpm compatibility and the structured reporter. */
function preparePluginArgs(profileDirectory: string, pluginArgs: readonly string[]): {
  args: string[]
  target: string
} | { error: string } {
  let args = pluginArgsFor(profileDirectory, [...pluginArgs])
  const target = args[args.length - 1] ?? ''
  if (!TARGET_RE.test(target)) {
    return { error: `unsafe plugin target rejected: ${JSON.stringify(target)}` }
  }
  if (NDJSON_COMMANDS.has(args[0])) args = [...args, '--reporter=ndjson']
  return { args, target }
}

/** Reset the singleton status snapshot before one operation starts. */
function beginProgress(target: string): ReturnType<typeof createProgressTracker> {
  progress.active = true
  progress.target = target
  progress.startedAt = Date.now()
  progress.lastLine = ''
  progress.phase = null
  progress.done = 0
  progress.total = null
  progress.currentPackage = null
  progress.downloaded = null
  progress.size = null
  progress.ndjson = false
  progress.error = null
  progress.cancelling = false
  return createProgressTracker()
}

/**
 * Line-buffered progress feed: pnpm's ndjson reporter emits one JSON object
 * per line on stdout, and chunk boundaries can split a line. Human fallback
 * lines (older pnpm without structured events) still update `lastLine`.
 */
function makeProgressFeeder(tracker: ReturnType<typeof createProgressTracker>): (chunk: string) => void {
  let lineBuffer = ''
  return (chunk: string): void => {
    lineBuffer += chunk
    let nl: number
    while ((nl = lineBuffer.indexOf('\n')) !== -1) {
      const line = lineBuffer.slice(0, nl)
      lineBuffer = lineBuffer.slice(nl + 1)
      const trimmed = line.trim()
      if (trimmed === '') continue
      tracker.feed(trimmed)
      // Human lines never start with '{'; JSON lines are consumed by the tracker.
      if (!trimmed.startsWith('{')) progress.lastLine = trimmed.slice(0, 200)
    }
  }
}

/** Run one `dsh plugin --profile <p> …` command with timeout and progress tracking. */
export function runDshPlugin(profile: string, pluginArgs: string[]): Promise<InstallResult> {
  const { file, args, cwd, viaShell } = dshArgv()
  const prepared = preparePluginArgs(profileDir(profile), pluginArgs)
  if ('error' in prepared) {
    logEvent('error', 'install', prepared.error)
    return Promise.resolve({ exitCode: 1, timedOut: false, stdout: '', stderr: prepared.error, cancelled: false })
  }
  pluginArgs = prepared.args
  const tracker = beginProgress(prepared.target)
  const feed = makeProgressFeeder(tracker)
  return new Promise((resolvePromise) => {
    const child = spawnShim(file, [...args, 'plugin', '--profile', profile, ...pluginArgs], {
      cwd,
      // pnpm v10 blocks forever on a silent interactive prompt without a TTY
      // (observed on re-add over a pinned git spec); CI mode forces it to act
      // or fail instead of asking.
      env: spawnEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      viaShell,
      // Own process group on POSIX so cancel/timeout can kill the whole
      // tree (dsh wrapper + pnpm grandchild) with one group signal.
      detached: process.platform !== 'win32',
    })
    activeChild = child
    cancelRequested = false
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, INSTALL_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout = (stdout + text).slice(-256 * 1024)
      feed(text)
      syncProgress(tracker)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr = (stderr + text).slice(-64 * 1024)
      feed(text)
      syncProgress(tracker)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      progress.active = false
      progress.cancelling = false
      if (activeChild === child) activeChild = null
      resolvePromise({ exitCode: 127, timedOut: false, stdout, stderr: `${stderr}\n${error.message}`, cancelled: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      progress.active = false
      progress.cancelling = false
      if (activeChild === child) activeChild = null
      const failed = code !== 0 || timedOut
      if (failed) progress.error = tracker.snapshot.error
      const ignoredBuilds = tracker.snapshot.ignoredBuilds
      resolvePromise({
        exitCode: code,
        timedOut,
        stdout,
        stderr,
        cancelled: cancelRequested,
        ...(ignoredBuilds.length > 0 ? { ignoredBuilds } : {}),
      })
    })
  })
}

/**
 * Adapt DSH Desktop's generation-scoped package manager to the existing
 * market runner. There is no runtime import or dependency on Desktop: the
 * Host supplies this public service only when the package is mounted there.
 */
export function createDesktopPluginRuntime(
  service: DesktopPnpmLike,
  activeProfileDir: string,
  invokingDir = process.cwd(),
  timeoutMs = INSTALL_TIMEOUT_MS,
): DesktopPluginRuntime {
  if (!isAbsolute(activeProfileDir) || activeProfileDir.includes('\0')) {
    throw new Error('dsh-market: Desktop profile directory must be an absolute path without NUL')
  }
  if (!isAbsolute(invokingDir) || invokingDir.includes('\0')) {
    throw new Error('dsh-market: Desktop invoking directory must be an absolute path without NUL')
  }
  const owner = Symbol('dsh-market desktop runtime')
  let closed = false

  const runPlugin: PluginRunner = async (_profile, pluginArgs) => {
    if (closed) {
      return {
        exitCode: 127,
        timedOut: false,
        stdout: '',
        stderr: 'dsh-market: Desktop package runtime is disposed',
        cancelled: false,
      }
    }
    const prepared = preparePluginArgs(activeProfileDir, pluginArgs)
    if ('error' in prepared) {
      logEvent('error', 'install', prepared.error)
      return { exitCode: 1, timedOut: false, stdout: '', stderr: prepared.error, cancelled: false }
    }

    const abort = new AbortController()
    let handle: ReturnType<DesktopPnpmLike['runPlugin']>
    try {
      handle = service.runPlugin(prepared.args, invokingDir, abort.signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const busy = /another desktop pnpm operation is already running/i.test(message)
      return {
        exitCode: 127,
        timedOut: false,
        stdout: '',
        stderr: message,
        cancelled: false,
        ...(busy ? { busy: true } : {}),
      }
    }

    const tracker = beginProgress(prepared.target)
    const feed = makeProgressFeeder(tracker)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const collectStdout = (chunk: string | Buffer): void => {
      const text = chunk.toString()
      stdout = (stdout + text).slice(-256 * 1024)
      feed(text)
      syncProgress(tracker)
    }
    const collectStderr = (chunk: string | Buffer): void => {
      const text = chunk.toString()
      stderr = (stderr + text).slice(-64 * 1024)
      feed(text)
      syncProgress(tracker)
    }
    handle.stdout.on('data', collectStdout)
    handle.stderr.on('data', collectStderr)

    let active!: ActiveDesktopOperation
    let timer: NodeJS.Timeout | undefined
    const done = (async (): Promise<InstallResult> => {
      try {
        const outcome = await handle.done
        const failed = outcome.exitCode !== 0 || outcome.signal !== null || timedOut
        if (failed) progress.error = tracker.snapshot.error
        const ignoredBuilds = tracker.snapshot.ignoredBuilds
        return {
          exitCode: outcome.exitCode,
          timedOut,
          stdout,
          stderr,
          cancelled: active.userCancelled,
          ...(ignoredBuilds.length > 0 ? { ignoredBuilds } : {}),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        progress.error = tracker.snapshot.error
        return {
          exitCode: 127,
          timedOut,
          stdout,
          stderr: `${stderr}${stderr === '' ? '' : '\n'}${message}`,
          cancelled: active.userCancelled,
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        progress.active = false
        progress.cancelling = false
        handle.stdout.off('data', collectStdout)
        handle.stderr.off('data', collectStderr)
        if (activeDesktopOperation === active) activeDesktopOperation = null
      }
    })()
    active = { owner, cancel: () => { handle.cancel() }, done, userCancelled: false }
    activeDesktopOperation = active
    timer = setTimeout(() => {
      timedOut = true
      abort.abort(new Error('dsh-market: Desktop package operation timed out'))
      // The public handle owns an explicit process-tree cancellation path.
      // Use it as well as AbortSignal so a structurally compatible provider
      // that does not observe the signal cannot strand the route or teardown.
      handle.cancel()
    }, timeoutMs)
    timer.unref?.()
    return done
  }

  const cancelOwned = (userCancelled: boolean): boolean => {
    const active = activeDesktopOperation
    if (active?.owner !== owner) return false
    if (userCancelled) active.userCancelled = true
    progress.cancelling = true
    active.cancel()
    return true
  }

  return {
    runPlugin,
    // The service is backed by Desktop's packaged pnpm; system discovery and
    // global provisioning are neither needed nor allowed in this mode.
    probePnpm: () => Promise.resolve(true),
    provisionPnpm: () => Promise.resolve({ ok: true }),
    cancelActive: () => cancelOwned(true),
    dispose: async () => {
      closed = true
      const active = activeDesktopOperation
      if (active?.owner !== owner) return
      cancelOwned(false)
      await active.done.catch(() => {})
    },
  }
}

/** Copy the tracker's snapshot into the singleton the status route reads. */
function syncProgress(tracker: ReturnType<typeof createProgressTracker>): void {
  const snap = tracker.snapshot
  progress.phase = snap.phase
  progress.done = snap.done
  progress.total = snap.total
  progress.currentPackage = snap.currentPackage
  progress.downloaded = snap.downloaded
  progress.size = snap.size
  progress.ndjson = snap.seen
  if (snap.error !== null) progress.error = snap.error
}
