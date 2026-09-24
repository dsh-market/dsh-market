/**
 * Process layer: re-invoking the dsh CLI that launched this host, spawning
 * `dsh plugin` commands with timeouts and live progress, and provisioning
 * pnpm. This is the only module that starts child processes.
 *
 * Installs run through node:child_process, not ctx.shell: the shell service is
 * the agent's sandboxed executor and denies writes to the profile directory.
 */

import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { logEvent } from './log.ts'
import { createProgressTracker, type ProgressPhase } from './ndjson.ts'
import { pluginArgsFor } from './pnpm-compat.ts'
import { isDshProfileName, profileDir } from './profile.ts'
import { activeRegion, DEFAULT_NPM_REGISTRY, routesFor, type Region } from './regions.ts'
import { NPM_NAME_RE } from './sources.ts'
import { fetchNpmLatest } from './updates.ts'

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
export function proxyEnvForPnpm(env: NodeJS.ProcessEnv = process.env, region: Region = 'global'): NodeJS.ProcessEnv {
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
  // Three consumers, three vocabularies, one proxy. The market's own fetch
  // reads the standard vars (and, since #263, npm config too); pnpm reads
  // ONLY npm config; and `git` — which pnpm shells out to for every
  // git-hosted plugin — reads only the standard vars and never npm config.
  // Translating one direction left the third out: registry installs went
  // through the proxy while git installs went direct and failed with
  // "Failed to connect to github.com:443" (#274 by @rucsocial).
  //
  // Same precedence as undici's EnvHttpProxyAgent (lowercase over
  // uppercase, https falling back to http).
  const stdHttps = pick('https_proxy', 'HTTPS_PROXY') ?? pick('http_proxy', 'HTTP_PROXY')
  const stdHttp = pick('http_proxy', 'HTTP_PROXY') ?? stdHttps
  if (stdHttps !== null && !has('npm_config_https_proxy')) out.npm_config_https_proxy = stdHttps
  if (stdHttp !== null && !has('npm_config_proxy')) out.npm_config_proxy = stdHttp
  const stdNoProxy = pick('no_proxy', 'NO_PROXY')
  if (stdNoProxy !== null && !has('npm_config_noproxy')) out.npm_config_noproxy = stdNoProxy

  // The other direction, and ONLY when the standard vocabulary is empty.
  // A proxy known solely to npm config is the case that stranded git; if
  // the caller has said anything in the standard vars, that is their
  // statement about what git should do and copying npm's answer over it
  // would invent a setting they did not make — notably an HTTP_PROXY for
  // someone who deliberately proxied https only.
  if (stdHttps === null && stdHttp === null) {
    const npmHttps = pick('npm_config_https_proxy') ?? pick('npm_config_proxy')
    const npmHttp = pick('npm_config_proxy') ?? npmHttps
    if (npmHttps !== null) out.HTTPS_PROXY = npmHttps
    if (npmHttp !== null) out.HTTP_PROXY = npmHttp
    const npmNoProxy = pick('npm_config_noproxy')
    if (npmNoProxy !== null && stdNoProxy === null) out.NO_PROXY = npmNoProxy
  }
  // The download region's npm mirror, when it has one.
  //
  // Last, and conditionally: a registry the caller already named is their
  // statement about where packages come from, and a region setting must not
  // overrule it. Same rule the proxy translation above follows, for the same
  // reason — this function's job is to fill silence, not to overwrite speech.
  const mirror = routesFor(region).npmRegistry
  if (mirror !== DEFAULT_NPM_REGISTRY && !has('npm_config_registry')) {
    // npm's own config convention terminates the registry with a slash;
    // pnpm accepts either, but writing it the conventional way keeps the
    // value recognizable to anyone reading the spawned process's env.
    out.npm_config_registry = `${mirror}/`
  }
  return out
}

/**
 * Directories to append to PATH so a spawned pnpm can be found (#32, #38,
 * #167, #292).
 *
 * A GUI or desktop launch inherits none of the shell profile, so PATH holds
 * whatever the launcher had — usually not the directory the user's package
 * manager lives in. The market appends the places it is actually installed
 * to rather than telling the user to fix their environment.
 *
 * Windows used to get only the Node directory, which made the market's own
 * advice unfollowable: the error it prints recommends installing pnpm with
 * `iwr https://get.pnpm.io/install.ps1`, and then it did not look where that
 * installer puts it (#292). Both Windows layouts are covered now — the
 * standalone installer's `%LOCALAPPDATA%\pnpm`, and `%APPDATA%\npm` where
 * `npm i -g pnpm` writes `pnpm.cmd`.
 *
 * `PNPM_HOME` comes first on every platform: the installer sets it, so it is
 * the one answer that is right even when the layout is not the default one.
 *
 * @param platform - `process.platform`, injectable for tests.
 * @param env - environment, for PNPM_HOME and the Windows app-data roots.
 * @param home - home directory, injectable for tests.
 */
export function toolSearchDirs(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const dirs: string[] = []
  const pnpmHome = (env.PNPM_HOME ?? '').trim()
  if (pnpmHome !== '') dirs.push(pnpmHome)
  if (platform === 'win32') {
    const local = (env.LOCALAPPDATA ?? '').trim()
    const roaming = (env.APPDATA ?? '').trim()
    if (local !== '') dirs.push(join(local, 'pnpm'))
    if (roaming !== '') dirs.push(join(roaming, 'npm'))
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'))
    // Where the standalone installer lands when PNPM_HOME is unset.
    dirs.push(join(home, 'Library', 'pnpm'), join(home, '.local', 'share', 'pnpm'))
  }
  dirs.push(nodeBinDir, ...extraPathDirs)
  // Deduped: PNPM_HOME usually names one of the defaults below it, and a
  // list that says the same directory twice reads as carelessness in the
  // one place a user goes looking for an answer.
  return [...new Set(dirs.filter(dir => dir.trim() !== ''))]
}

/**
 * Stop git asking for credentials down a channel nobody is listening on
 * (#587).
 *
 * `CI=true` below is the same defence one layer up, and pnpm reads it. git
 * does not — it has its own switch, and it was not set. The gap only opens
 * when a spec reaches pnpm's git fetcher instead of the codeload tarball
 * path `accelerate.ts` describes: `github:owner/repo#path:/sub` is one, and
 * pnpm really does shell out to `git` for it, trying HTTPS first.
 *
 * git's credential prompt opens the controlling terminal, not stdin. There
 * is no terminal here, so the question is never seen and never answered:
 * the reporter caught `git.exe` alive for eight minutes having burned 0.05s
 * of CPU, and only the fifteen-minute install timeout ended it. Refusing
 * the prompt turns that into a fast, readable failure.
 *
 * It is a default, not an override: a value the caller set wins, and blank
 * counts as unset because an empty `GIT_TERMINAL_PROMPT` is not a setting
 * git can parse either. Credential helpers and `GIT_ASKPASS` are untouched
 * and still answer first — this closes only the terminal fallback, which is
 * precisely the branch that cannot work from a spawned child.
 *
 * Scope, stated plainly because it is narrower than the issue title
 * suggests: this is the HTTPS half, and the FIRST attempt HTTPS is. Measured
 * with a `GIT_SSH_COMMAND` sentinel that always fails: pnpm's clone of a
 * `github:owner/repo#path:/sub` spec succeeds without ever calling it, so
 * ssh is the fallback that runs after HTTPS fails — which is the private
 * repository case, not the common one.
 *
 * The ssh half (#596, @JINITAIMI121) is a policy decision, and it is made
 * here: `BatchMode=yes`, so a passphrase or host-key question fails fast
 * instead of waiting on a terminal nobody is watching. The cost is real and
 * is why it is conditional — `BatchMode` also disables `SSH_ASKPASS`, so a
 * key that NEEDS a passphrase stops prompting even where something could
 * have answered, and the install fails where it used to work.
 *
 * So it is set only when the user has expressed NO ssh preference at all:
 * `GIT_SSH_COMMAND` and `GIT_SSH` in the environment, and `core.sshCommand`
 * in git config — the three ordinary ways to choose an identity, and
 * `GIT_SSH_COMMAND` would silently override all three (measured: with
 * `core.sshCommand` set, ours wins and theirs is never run). A user who
 * has an agent or a specific key configured keeps exactly what they have;
 * the prompt is closed for everyone else, and `classifyPnpmFailure` says
 * what to do if that turns out to be the passphrase case.
 */
let coreSshCommandProbe: string | null | undefined

/**
 * `core.sshCommand` from the user's git configuration, or null.
 *
 * The third place an ssh identity hides, and the one the environment cannot
 * show: `git config --get` answers it. Memoized for the process — a user
 * does not reconfigure git mid-install, and this runs on every spawn.
 *
 * @returns the configured command, or null when git has none (including
 *   when git is absent — an unreadable answer is not a choice).
 */
export function probeCoreSshCommand(env?: NodeJS.ProcessEnv): string | null {
  // Memoized only for the caller that has no opinion: a test that supplies
  // its own environment is asking a different question and must get the
  // fresh answer.
  if (env === undefined && coreSshCommandProbe !== undefined) return coreSshCommandProbe ?? null
  try {
    const out = spawnSync('git', ['config', '--get', 'core.sshCommand'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(env === undefined ? {} : { env }),
      // A user's git may be a shim that prints to a console; nothing here
      // wants a window.
      windowsHide: true,
    })
    const answer = out.status === 0 && typeof out.stdout === 'string' && out.stdout.trim() !== ''
      ? out.stdout.trim()
      : null
    if (env === undefined) coreSshCommandProbe = answer
    return answer
  } catch {
    if (env === undefined) coreSshCommandProbe = null
    return null
  }
}

export function gitEnvForPnpm(
  env: NodeJS.ProcessEnv = process.env,
  coreSshCommand: string | null = probeCoreSshCommand(),
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  // Blank counts as unset: an empty value is not a setting git can parse.
  const speaks = (value: string | undefined): boolean => (value ?? '').trim() !== ''
  if (!speaks(env.GIT_TERMINAL_PROMPT)) out.GIT_TERMINAL_PROMPT = '0'
  const choseElsewhere = speaks(env.GIT_SSH_COMMAND) || speaks(env.GIT_SSH) || speaks(coreSshCommand ?? '')
  if (!choseElsewhere) out.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes'
  return out
}

/**
 * Every `--config.<key>=<value>` override in the argv, repeated as the
 * `PNPM_CONFIG_<KEY>` environment variable that pnpm 12 still reads.
 *
 * pnpm 12 ignores some `--config.<key>` overrides on the command line, in
 * either spelling, without a word: `fetchTimeout` (#615; measured on
 * 12.2.1, 12.3.0 and 12.4.1) and `auto-install-peers` (12.4.1 auto-installs
 * the peer with the flag present and not with the variable), so the retries
 * that carry them ran exactly like the first attempt. `PNPM_CONFIG_*` is
 * honoured by 11.8, 11.21 and 12.4 alike, so the argument stays for the
 * versions that read it and the variable carries the same value for the
 * ones that do not. Scoped to the run that carries the flag; nothing is set
 * otherwise, so a user's own values are untouched on every other run. Keys
 * are accepted in either spelling, so respelling a constant (as #600 did
 * for the release-age one) cannot silently drop the variable.
 */
export function pnpmConfigEnvForArgs(pluginArgs: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const arg of pluginArgs) {
    const match = /^--config\.([A-Za-z][A-Za-z0-9-]*)=(\S+)$/.exec(arg)
    if (match === null) continue
    const key = match[1]!.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toUpperCase()
    env[`PNPM_CONFIG_${key}`] = match[2]!
  }
  return env
}

function spawnEnv(): NodeJS.ProcessEnv {
  // pnpm v10+ blocks forever on a silent interactive prompt without a TTY;
  // CI mode forces it to act or fail instead of asking.
  const separator = process.platform === 'win32' ? ';' : ':'
  // A packaged host ships its runtime rather than relying on PATH, and says
  // where it is through the invocation's own `env` (#653). That environment
  // goes FIRST so its bundled Node wins on a machine where nothing else is
  // on the process PATH — and it reaches every child, including the
  // `dsh plugin` forwarder, which is the only way an install can run there.
  const hostEnv = hostPackageManager?.env ?? {}
  const parts = `${hostEnv.PATH ?? ''}${separator}${process.env.PATH ?? ''}`
    .split(separator).filter(part => part !== '')
  for (const bin of toolSearchDirs()) {
    if (!parts.includes(bin)) parts.push(bin)
  }
  // hostEnv follows process.env. PATH is `parts` below: host entries, then
  // the inherited PATH. That PATH is never empty, so dropping the host
  // entries whenever it is already set would leave the bundled Node off
  // the path (#653).
  return {
    ...process.env,
    ...hostEnv,
    ...proxyEnvForPnpm(process.env, activeRegion()),
    ...gitEnvForPnpm(process.env),
    CI: 'true',
    PATH: parts.join(separator),
  }
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

/**
 * Whether a profile name can cross the rare Windows `dsh.cmd` fallback.
 *
 * cmd.exe expands percent-delimited environment variables even inside a
 * quoted argument. Keep that fallback to names made only of letters, marks,
 * numbers, spaces, dots, underscores, and hyphens. The normal direct-Node
 * launcher remains argv-safe and accepts every DSH-valid profile name.
 */
export function isCmdSafeProfileName(profile: string): boolean {
  return isDshProfileName(profile) && /^[\p{L}\p{M}\p{N}._ -]+$/u.test(profile)
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
 * `shell: false`. Hide consoles when the host itself has no console (#530).
 */
function spawnShim(file: string, args: readonly string[], options: SpawnShimOptions): ChildProcess {
  const { viaShell = false, ...spawnOptions } = options
  if (!viaShell) {
    return spawn(file, [...args], { ...spawnOptions, shell: false, windowsHide: true })
  }
  if (process.platform !== 'win32') {
    return spawn(file, [...args], { ...spawnOptions, shell: false, windowsHide: true })
  }
  return spawn(COMSPEC, ['/d', '/s', '/c', `"${cmdCommandLine([file, ...args])}"`], {
    ...spawnOptions,
    shell: false,
    windowsVerbatimArguments: true,
    windowsHide: true,
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
  /**
   * pnpm's OWN error message and code, from its structured ndjson stream
   * (#244).
   *
   * Without this the only thing a failure could report was the tail of
   * stderr — which for a market install is dsh's wrapper line, "pnpm failed
   * in profile directory …", identical for every possible cause. pnpm's
   * real error never went to stderr at all; it goes to the ndjson stdout
   * this already parses for progress, and was being thrown away on the way
   * out. Three separate reports (#244, #192, #138) are all "the UI shows a
   * stack tail and nothing else".
   */
  pnpmError?: string
  pnpmErrorCode?: string
  /**
   * Exact npm version this Desktop run actually handed to the host (#496).
   *
   * Anywhere Labs' install boundary rewrites a floating dist-tag (or bare
   * name) to `name@x.y.z` with its own registry fetch. The update route
   * normally pins that version itself before `add`, so this field matches
   * the request and is unused for verification. It matters when registry
   * metadata was unavailable and the add still carried `@latest`/`@beta`:
   * verification then adopts this pin instead of leaving the expected
   * version unset. When the route already sent an exact pin, callers must
   * keep that pin authoritative and must not let this field lower it.
   */
  resolvedNpmVersion?: string
}

/** The shape every orchestration function takes to run plugin commands (injectable in tests). */
export type PluginRunner = (profile: string, pluginArgs: string[]) => Promise<InstallResult>

/** Package-operation boundary consumed by the HTTP route layer. */
export interface PluginCommandRuntime {
  runPlugin: PluginRunner
  probePnpm(): Promise<boolean>
  provisionPnpm(): Promise<{ ok: boolean; hint?: string }>
  cancelActive(): boolean
  /** Whether this host can execute an immutable rollback add target. */
  supportsExactRollbackTarget?(target: string): boolean
}

/** One running package operation, however it was started. */
export interface DesktopPnpmHandleLike {
  readonly stdout: NodeJS.ReadableStream
  readonly stderr: NodeJS.ReadableStream
  readonly done: Promise<{
    readonly exitCode: number | null
    readonly signal: NodeJS.Signals | null
  }>
  cancel(): void
}

/**
 * Structural subset of DSH Desktop's public `desktopPnpm` contract.
 *
 * Anywhere Labs' DSH Desktop is ONE third-party client among several, and
 * this interface exists only for it. Nothing here is part of the official
 * DSH protocol — `desktopPnpm`, `installPlugin` and the install boundary
 * below appear nowhere in `@deepseek-ai/*`. Every other client the market
 * runs under, including other desktop apps, installs through the ordinary
 * `dsh plugin --profile <p> add` CLI, and so does the market itself when
 * none of these services are present.
 *
 * That is why every member past `runPlugin` is optional and reached by
 * feature detection. A host that does not publish one simply never enters
 * the branch, and the ordinary path it already used stays untouched — the
 * cost of accommodating one vendor must not be paid by the others, or by
 * the far larger number of people on plain `dsh web`.
 */
export interface DesktopPnpmLike {
  runPlugin(
    args: readonly string[],
    invokingDir: string,
    signal?: AbortSignal,
  ): DesktopPnpmHandleLike

  /**
   * Desktop 2.x refuses `add` through `runPlugin` — "plugin add must use the
   * recoverable install boundary" (#215, #219, #272) — and offers this
   * instead, which their launcher enables only for the selected market
   * provider. Same arguments, same handle, no recovery receipt and no
   * write-ahead log for the caller to reconcile.
   *
   * Optional because it is theirs: absent on every other host, including
   * the other third-party desktop client in #292, which installs perfectly
   * well through the ordinary CLI.
   *
   * Read from their published source rather than assumed: it accepts ONLY
   * `add` with exactly one target of the form `name@exact.version`
   * (`validateExternalMarketInstallArgs` in dsh-plugin-desktop/src/pnpm.ts).
   * A `github:owner/repo` target is rejected before any process starts, so
   * the 1085 catalog entries with no npm package — 57% of it — cannot be
   * installed on that host by any spelling this market could send. That is
   * a gap in their contract, not something to work around here.
   */
  runExternalMarketPluginInstall?(
    args: readonly string[],
    invokingDir: string,
    signal?: AbortSignal,
  ): DesktopPnpmHandleLike
}

/** An npm name with a fully pinned version — the only target their boundary takes. */
const EXACT_NPM_TARGET_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/**
 * Rewrite an `add` argv into the shape Anywhere Labs' install boundary
 * accepts, or null when it cannot be expressed there.
 *
 * Their validator wants exactly one target of the form `name@1.2.3` — not a
 * bare name, not `@latest`, and not a `github:` source (read from
 * `validateExternalMarketInstallArgs`, dsh-plugin-desktop/src/pnpm.ts). The
 * market prefers to send an already-resolved `name@x.y.z` for npm updates
 * (#496); a bare name or dist-tag still needs resolving here when some other
 * path hands one over.
 *
 * Returning null is a normal outcome, not a failure: a github-sourced plugin
 * has no `name@version` spelling at all. The caller falls back to the
 * ordinary path, which on that host reports their own refusal — an accurate
 * message about their contract, rather than one this package invented.
 */
/**
 * Added to a refusal from a host whose install boundary only takes
 * `name@exact.version`. Their message is accurate and stays first; this says
 * which property of the plugin put it out of reach, because the user picked a
 * card and has no way to know the difference from the outside (#138).
 */
const NPM_ONLY_HOST_NOTE
  = '这个桌面客户端只能安装已发布到 npm 的插件，而该插件仅提供 GitHub 源，因此装不了——这是客户端的安装边界，不是插件或市场的问题。'
  + '可以改用普通 dsh web 安装，或请插件作者发布 npm 包。 / '
  + 'This desktop client can only install plugins published to npm, and this one is GitHub-only, so it cannot be installed here. '
  + 'That is the client\'s install boundary, not a fault in the plugin or the market. '
  + 'Install it from plain dsh web instead, or ask the author to publish to npm.'

async function exactNpmArgs(args: readonly string[]): Promise<{
  args: string[]
  resolvedNpmVersion: string
} | null> {
  const targets = args.slice(1).filter(argument => !argument.startsWith('-'))
  const target = targets[0]
  if (targets.length !== 1 || target === undefined) return null
  if (EXACT_NPM_TARGET_RE.test(target)) {
    // Already exact — still report the pin so update verification can align
    // with what this host will install, not with a separate `latest` fetch.
    return { args: [...args], resolvedNpmVersion: target.slice(target.lastIndexOf('@') + 1) }
  }
  // A bare name, or one pinned to a dist-tag. Only a registry package can be
  // resolved; `github:owner/repo` and file paths stop here.
  const at = target.lastIndexOf('@')
  const name = at > 0 ? target.slice(0, at) : target
  if (!NPM_NAME_RE.test(name)) return null
  const version = await fetchNpmLatest(name)
  if (version === null) return null
  const rewritten = `${name}@${version}`
  if (!EXACT_NPM_TARGET_RE.test(rewritten)) return null
  logEvent('info', 'install', `desktop install boundary needs an exact version: ${target} -> ${rewritten}`)
  return {
    args: args.map(argument => (argument === target ? rewritten : argument)),
    resolvedNpmVersion: version,
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
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
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
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
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

/**
 * The package manager the host itself supplies, as the launcher hands it
 * over (`profileContext.packageManager`).
 *
 * This is not a PATH executable. A packaged host ships its own runtime and
 * describes it as a whole invocation — command, args AND env — because each
 * part carries meaning: the desktop host passes the location of its embedded
 * Node through `env`, so an implementation that keeps only `command` reaches
 * a tool it still cannot execute, which is the reported failure (#653).
 */
export interface HostPackageManager {
  readonly command: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
}

let hostPackageManager: HostPackageManager | null = null

/** Whether the host-supplied package manager answered `--version`. */
let hostPnpmReady = false

/**
 * Why the host-supplied package manager failed — kept apart from the PATH
 * probe's own failure so a hint can name the component that actually failed.
 */
let hostProbeFailure: { command: string; output: string } | null = null

/**
 * Register the host's package manager for this process, or clear it with
 * `null`. Cached probe answers are dropped only when the invocation really
 * changes, so a repeated mount does not re-probe a toolchain that works.
 */
export function setHostPackageManager(invocation: HostPackageManager | null): void {
  const previous = hostPackageManager
  const unchanged = previous === invocation || (
    previous !== null && invocation !== null &&
    previous.command === invocation.command &&
    previous.args.length === invocation.args.length &&
    previous.args.every((arg, index) => arg === invocation.args[index])
  )
  if (unchanged) return
  hostPackageManager = invocation
  hostPnpmReady = false
  pnpmReady = false
  pnpmProbeFailure = null
  hostProbeFailure = null
}

/** The host-supplied package manager, for callers that must name it. */
export function hostPackageManagerInvocation(): HostPackageManager | null {
  return hostPackageManager
}

/** Why the host-supplied package manager last failed, or null. */
export function lastHostPackageManagerFailure(): { command: string; output: string } | null {
  return hostProbeFailure
}

/** Whether `pnpm` resolves on PATH; success is cached, absence is re-probed. */
let pnpmReady = false

/**
 * Why the last probe said no.
 *
 * `missing` and `failed` are different problems with different fixes, and
 * collapsing both into `false` made the market give one answer to both: it
 * told a user whose pnpm ran perfectly from their shell to go set PNPM_HOME
 * (#228). A binary that IS on the path and exits non-zero — a corepack shim
 * that cannot reach the network to fetch pnpm itself is the common one —
 * needs its own output shown, not a path to fix that is already right.
 */
let pnpmProbeFailure: { kind: 'missing' | 'failed'; output: string } | null = null

/** Why `pnpm --version` last failed, or null when it has not failed. */
export function lastPnpmProbeFailure(): { kind: 'missing' | 'failed'; output: string } | null {
  return pnpmProbeFailure
}

/**
 * Probe the host-supplied package manager: `<command> <args…> --version`,
 * with the invocation's own environment (see spawnEnv). Its answers are
 * cached exactly like the PATH probe's.
 */
function probeHostPackageManager(): Promise<boolean> {
  if (hostPnpmReady) return Promise.resolve(true)
  const invocation = hostPackageManager
  if (invocation === null) return Promise.resolve(false)
  return new Promise((resolvePromise) => {
    const child = spawnShim(invocation.command, [...invocation.args, '--version'], {
      stdio: ['ignore', 'pipe', 'pipe'], viaShell: winCmdShim, env: spawnEnv(),
    })
    let output = ''
    const collect = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-2000) }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (error) => {
      hostProbeFailure = { command: invocation.command, output: error.message }
      resolvePromise(false)
    })
    child.on('close', (code) => {
      hostPnpmReady = code === 0
      hostProbeFailure = hostPnpmReady ? null : { command: invocation.command, output: output.trim() }
      resolvePromise(hostPnpmReady)
    })
  })
}

/**
 * Whether a package manager is usable — the host-supplied one first.
 *
 * The tiers are ordered by what the machine can actually run: a packaged
 * host's bundled runtime exists whether or not PATH was inherited from a
 * shell, and on the reported machine only that tier can work at all (#653).
 * A host tier that fails falls through to the PATH probe, so a host that
 * publishes a broken invocation cannot make things worse than they were.
 */
export function probePnpm(): Promise<boolean> {
  if (pnpmReady || hostPnpmReady) return Promise.resolve(true)
  // Deliberately not `async`: with no host tier this returns the PATH probe's
  // own promise, so the observable timing of every existing caller is exactly
  // what it was before this tier existed.
  if (hostPackageManager === null) return probePnpmOnPath()
  return probeHostPackageManager().then(ready => ready ? true : probePnpmOnPath())
}

/** Probe `pnpm --version` on PATH. */
function probePnpmOnPath(): Promise<boolean> {
  if (pnpmReady) return Promise.resolve(true)
  return new Promise((resolvePromise) => {
    // Piped, not ignored: the output of a pnpm that exists but will not run
    // IS the explanation, and throwing it away is what left #228 with a
    // failure nobody could act on.
    const child = spawnShim('pnpm', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], viaShell: winCmdShim, env: spawnEnv() })
    let output = ''
    const collect = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-2000) }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (error) => {
      pnpmProbeFailure = { kind: 'missing', output: error.message }
      resolvePromise(false)
    })
    child.on('close', (code) => {
      pnpmReady = code === 0
      pnpmProbeFailure = pnpmReady ? null : { kind: 'failed', output: output.trim() }
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
  // A host that ships a package manager has nothing to provision, and asking
  // corepack or npm to fetch another one cannot help: on the reported machine
  // both are unreachable, which is precisely why the host bundles a runtime
  // (#653). Probe what we were handed and report that honestly rather than
  // running two commands that cannot succeed.
  if (hostPackageManager !== null) {
    if (await probePnpm()) return { ok: true }
    return { ok: false, hint: hostPackageManagerHint() }
  }
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
    const root = prefix.code === 0 ? prefix.output.trim().split('\n').pop() ?? '' : ''
    // `npm prefix -g` already is the executable directory on Windows
    // (`pnpm.cmd` lives directly under it). Unix keeps shims in `bin/`.
    const bin = root === '' ? '' : process.platform === 'win32' ? root : join(root, 'bin')
    if (bin !== '' && isAbsolute(bin) && !extraPathDirs.includes(bin)) {
      extraPathDirs.push(bin)
      logEvent('info', 'setup-pnpm', `added npm's global bin to the probe path: ${bin}`)
      if (await probePnpm()) return { ok: true }
      extraPathDirs.pop()
    }
  }
  const npmFound = toolOnPath('npm')
  if (!npmFound) logEvent('warn', 'setup-pnpm', `npm is not on any searched path (node lives in ${nodeBinDir})`)
  return { ok: false, hint: provisionHint(corepack.output, npm.output, npmFound, lastPnpmProbeFailure()) }
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
 * Why a host-supplied package manager will not run.
 *
 * Separate from `provisionHint` on purpose: nothing was provisioned and
 * nothing is misinstalled, so every PATH-shaped explanation (install it,
 * set PNPM_HOME, restart dsh) is advice for a problem this user does not
 * have (#653). Name the invocation the host published, because that is what
 * has to change.
 * @returns a bilingual, actionable hint.
 */
function hostPackageManagerHint(): string {
  const invocation = hostPackageManager
  const command = invocation === null ? '' : invocation.command
  const args = invocation === null ? '' : invocation.args.join(' ')
  const failure = hostProbeFailure
  const detail = failure === null || failure.output === '' ? '' : `\n\n${failure.output}`
  return `这台机器的宿主自己带了一个包管理器，dsh 进程优先用它，但它连 \`--version\` 都跑不起来——所以这次不是你装错了东西，设 PNPM_HOME 也没有用。宿主给的调用是：${command} ${args}。常见原因是宿主的内嵌运行时目录被移动、被清理，或正处在升级中途。请重启宿主（桌面端）让它重新注入运行时；这条链只负责使用宿主给的运行时，没有它时会照旧回落到 PATH 上的 pnpm。原始输出：${detail} / The host supplies its own package manager and this dsh process prefers it, but it cannot even run \`--version\` — so nothing is misinstalled and PNPM_HOME will not help. The host published: ${command} ${args}. The usual cause is the host's bundled runtime having been moved, cleaned up, or caught mid-upgrade. Restart the host so it injects its runtime again; this tier only consumes what the host publishes and still falls back to a PATH pnpm without it. Its output:${detail}`
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
export function provisionHint(
  corepackOutput: string,
  npmOutput: string,
  npmFound = true,
  probeFailure: { kind: 'missing' | 'failed'; output: string } | null = null,
): string | undefined {
  // Node itself unreachable: pointing the user back at this same button
  // would be a dead end (#32). `npmFound` answers this from disk, so it
  // holds on a Windows console that reports the same thing in a codepage we
  // cannot read (#167); the ENOENT match stays for callers without it.
  if (!npmFound || (/ENOENT/.test(corepackOutput) && /ENOENT/.test(npmOutput))) {
    // The searched list is spelled out because the previous wording named
    // only the Node directory, which was both incomplete and unhelpful: a
    // user who HAD installed pnpm could not tell whether we looked in the
    // right place (#292). And the restart note matters — the installer sets
    // PNPM_HOME for new sessions, so a dsh already running cannot see it.
    const searched = toolSearchDirs().join(process.platform === 'win32' ? ' ; ' : ' : ')
    return `这台机器的 dsh 进程找不到 npm/corepack（图形界面或桌面端启动时不继承终端 PATH）——多半是宿主内置的 Node 运行时不带 npm。已找过：${searched}。请改从终端启动 dsh，或单独装一个 pnpm：Windows 用 iwr https://get.pnpm.io/install.ps1 -useb | iex，macOS/Linux 用 brew install pnpm。装完后请重启 dsh——安装器只对新开的会话生效，正在运行的进程看不到它 / This dsh process cannot find npm/corepack (GUI and desktop launches skip your shell PATH); a bundled Node runtime without npm is the usual cause. Searched: ${searched}. Start dsh from a terminal, or install pnpm on its own: \`iwr https://get.pnpm.io/install.ps1 -useb | iex\` (Windows) or \`brew install pnpm\` (macOS/Linux). Restart dsh afterwards — the installer only affects new sessions, so an already-running process cannot see it`
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
  // Everything reported success and pnpm still will not run (#228 by
  // @ZhengXin1023: corepack exit=0, npm -g exit=0, npm found — and the
  // install button stayed locked with nothing said).
  //
  // This used to return undefined, which left the case that most needs an
  // explanation with none: the user is told "setup failed" while every step
  // they can see succeeded, and their complaint was exactly that — "又不告诉
  // 我怎么手动配置". Whatever the cause, the actionable question is the same
  // one, so ask it: where is pnpm, and is that anywhere this process looks?
  // pnpm IS on the path and exits non-zero. Telling this user to fix PNPM_HOME
  // would be advice for the opposite problem — theirs runs fine from a shell,
  // which is exactly what #228 reported. Its own output is the explanation.
  if (probeFailure?.kind === 'failed') {
    const detail = probeFailure.output === '' ? '' : `\n\n${probeFailure.output}`
    // pnpm's own output names the culprit, and the reported case is not the
    // shim (#653): `env: node:` is the interpreter lookup of a
    // `#!/usr/bin/env node` shebang, so pnpm is here and could not start
    // because THIS PROCESS has no node on PATH — a launch that never
    // inherited a shell profile. Sending that user to check corepack's
    // network is advice for a different machine.
    if (/^\s*env:\s*node:/m.test(probeFailure.output)) {
      return `找到 pnpm 了，但运行 \`pnpm --version\` 失败，而它自己的输出已经说明了原因：env: node: No such file or directory。这不是 corepack 要联网下载的问题，是 node 不在这个进程的 PATH 上——pnpm 的真身是 \`#!/usr/bin/env node\` 脚本，env 找不到任何 node 就启动不了它。典型场景是 node 装在 brew 的 keg-only 目录或用户目录里、只由 shell 配置注入 PATH，而这个宿主是图形界面启动的，继承不到那份配置。两条路：从终端启动 dsh（继承 shell 的 PATH），或让宿主提供它自带的运行时。pnpm 的原始输出：${detail} / pnpm was found but \`pnpm --version\` fails, and its own output says why: env: node: No such file or directory. That is not the corepack shim failing to reach the network — node is missing from THIS process's PATH. pnpm itself is a \`#!/usr/bin/env node\` script, so env cannot start it without one. The usual shape is node installed keg-only (brew) or under a user directory and injected only by a shell profile, with the host launched from a GUI. Two ways out: start dsh from a terminal, or have the host supply its own runtime. pnpm's own output:${detail}`
    }
    return `找到 pnpm 了，但运行 \`pnpm --version\` 失败——所以问题不在路径上，设 PNPM_HOME 没有用。最常见的原因是 corepack 的 shim 需要联网下载 pnpm 本体，而这台机器下不到。请在终端执行一次 \`pnpm --version\`：如果同样失败，按它的提示修（受限网络可用 \`brew install pnpm\` 或 \`npm i -g pnpm --registry <你的镜像>\` 装一个完整的 pnpm，绕开 shim）；如果在终端里正常，说明 dsh 进程的环境和你的终端不同，请从该终端启动 dsh。pnpm 的原始输出：${detail} / pnpm was found, but \`pnpm --version\` fails — so this is not a path problem and PNPM_HOME will not help. The usual cause is a corepack shim that has to download pnpm itself and cannot reach the network. Run \`pnpm --version\` in a terminal: if it fails the same way, follow what it says (on a restricted network install a real pnpm with \`brew install pnpm\` or \`npm i -g pnpm --registry <your mirror>\` to bypass the shim); if it works there, the dsh process has a different environment than your shell — start dsh from that terminal. pnpm's own output:${detail}`
  }
  const searched = toolSearchDirs().join(process.platform === 'win32' ? ' ; ' : ' : ')
  const locate = process.platform === 'win32' ? 'where pnpm' : 'which pnpm'
  return `pnpm 装好了，但这个 dsh 进程仍然启动不了它——安装步骤都成功，只是装到的位置不在它搜索的范围内。已找过：${searched}。请在终端执行 \`${locate}\` 看 pnpm 实际在哪：如果它不在上面这些目录里，把该目录设为 PNPM_HOME 后重启 dsh（\`export PNPM_HOME=<那个目录>\`），或者干脆从一个能直接运行 pnpm 的终端里启动 dsh。注意必须重启——正在运行的进程读不到新设的环境变量 / pnpm is installed but this dsh process still cannot start it: every step succeeded, the binary just landed somewhere this process does not look. Searched: ${searched}. Run \`${locate}\` in a terminal to see where pnpm actually is; if that directory is not in the list above, set PNPM_HOME to it and restart dsh (\`export PNPM_HOME=<that directory>\`), or simply start dsh from a terminal where \`pnpm\` already runs. The restart matters — a running process cannot see a newly set variable`
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
const NDJSON_COMMANDS = new Set(['add', 'remove', 'install', 'update'])

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
  if (viaShell && !isCmdSafeProfileName(profile)) {
    const error = `dsh-market: profile name ${JSON.stringify(profile)} cannot cross the Windows cmd.exe fallback safely; relaunch DSH through its Node entry point, or use a profile name containing only letters, numbers, spaces, dots, underscores, and hyphens`
    logEvent('error', 'install', error)
    return Promise.resolve({ exitCode: 1, timedOut: false, stdout: '', stderr: error, cancelled: false })
  }
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
      env: { ...spawnEnv(), ...pnpmConfigEnvForArgs(pluginArgs) },
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
      const { error: pnpmError, errorCode: pnpmErrorCode } = tracker.snapshot
      resolvePromise({
        exitCode: code,
        timedOut,
        stdout,
        stderr,
        cancelled: cancelRequested,
        ...(pnpmError !== null ? { pnpmError } : {}),
        ...(pnpmErrorCode !== null ? { pnpmErrorCode } : {}),
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
    let handle: DesktopPnpmHandleLike
    /** Set when this host only installs npm packages and the target is not one. */
    let boundaryRefusesTarget = false
    /** Exact npm pin the install boundary actually sent (#496). */
    let resolvedNpmVersion: string | undefined
    try {
      // `add` goes through Anywhere Labs' install boundary when that host
      // publishes one, because their Desktop rejects `add` on `runPlugin`
      // outright. Feature-detected, never assumed: this method is theirs
      // alone, and on every other client — including the other desktop app
      // in #292 — the ordinary call below is what runs, unchanged.
      const boundary = prepared.args[0] === 'add' ? service.runExternalMarketPluginInstall : undefined
      const viaBoundary = boundary === undefined ? null : await exactNpmArgs(prepared.args)
      // A host that publishes the boundary accepts ONLY `name@exact.version`
      // through it, so a github-sourced plugin has nowhere to go: the
      // fallback below is a call that host refuses outright. Their refusal is
      // accurate but says nothing about why THIS plugin, and roughly half the
      // catalog has no npm package — reported in #138 after the user found
      // out by clicking Install and reading `exit 127`.
      boundaryRefusesTarget = boundary !== undefined && viaBoundary === null
      if (viaBoundary !== null) resolvedNpmVersion = viaBoundary.resolvedNpmVersion
      handle = boundary === undefined || viaBoundary === null
        ? service.runPlugin(prepared.args, invokingDir, abort.signal)
        : boundary.call(service, viaBoundary.args, invokingDir, abort.signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const busy = /another desktop pnpm operation is already running/i.test(message)
      return {
        exitCode: 127,
        timedOut: false,
        stdout: '',
        stderr: boundaryRefusesTarget ? `${message}\n${NPM_ONLY_HOST_NOTE}` : message,
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
        const { error: pnpmError, errorCode: pnpmErrorCode } = tracker.snapshot
        return {
          exitCode: outcome.exitCode,
          timedOut,
          stdout,
          stderr,
          cancelled: active.userCancelled,
          ...(ignoredBuilds.length > 0 ? { ignoredBuilds } : {}),
          ...(pnpmError !== null ? { pnpmError } : {}),
          ...(pnpmErrorCode !== null ? { pnpmErrorCode } : {}),
          ...(resolvedNpmVersion !== undefined ? { resolvedNpmVersion } : {}),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        progress.error = tracker.snapshot.error
        const detail = `${stderr}${stderr === '' ? '' : '\n'}${message}`
        return {
          exitCode: 127,
          timedOut,
          stdout,
          stderr: boundaryRefusesTarget ? `${detail}\n${NPM_ONLY_HOST_NOTE}` : detail,
          cancelled: active.userCancelled,
          ...(resolvedNpmVersion !== undefined ? { resolvedNpmVersion } : {}),
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
    // Anywhere Labs' optional external boundary accepts exact npm targets
    // only. Every Desktop host without that boundary retains the ordinary
    // CLI grammar, including immutable Git and archive targets.
    supportsExactRollbackTarget: target => TARGET_RE.test(target)
      && (service.runExternalMarketPluginInstall === undefined || EXACT_NPM_TARGET_RE.test(target)),
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
