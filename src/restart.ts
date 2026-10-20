/**
 * Self-restart: relaunch the exact DSH invocation that booted this host so
 * pending (non-hot) plugin changes take effect without the user leaving the
 * UI. Contributed in #14 by @ysyyhhh; ported onto the layered architecture.
 *
 * Safety model: the endpoint accepts only same-origin requests whose Host
 * names an authority this deployment serves — a loopback authority reached
 * directly (no forwarding headers), or a name the host DECLARED
 * (`dsh web --trusted-host <name>`), which is how a deployment behind a
 * tunnel or a reverse proxy is reached. It refuses while a plugin operation
 * runs, and deployments under a supervisor (systemd/launchd/pm2) can disable
 * the whole feature with `allowRestart: false` — the supervisor owns restarts.
 */

import { spawn } from 'node:child_process'
import { declaredTrustedHosts, loopbackAuthority, trustedAuthority } from './http.ts'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import inspector from 'node:inspector'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage } from 'node:http'
import { dshArgv, nodeExecutable } from './dsh-cli.ts'
import type { RecoveryConfig } from './recovery.ts'

/**
 * What a caller has to know to schedule a restart with a recovery surface:
 * the plugin inventory and the profile paths, but NOT the port, the log
 * files, or the respawn invocation — those are decided here, where the
 * restart actually happens, so no caller can get them subtly wrong.
 */
export type RecoveryHandoffConfig = Omit<RecoveryConfig, 'port' | 'logs' | 'spawn' | 'cwd'>

/** Vitest / flows can pin detection without opening a real inspector port. */
let debuggerOverride: 'inspector' | null | undefined

/** @internal test hook — production callers use detectedDebugger() only. */
export function setDetectedDebuggerOverride(value: 'inspector' | null | undefined): void {
  debuggerOverride = value
}

const INSPECT_ARG_PREFIXES = ['--inspect', '--inspect-brk', '--inspect-port', '--inspect-wait'] as const

function tokenHasInspectFlag(token: string): boolean {
  for (const prefix of INSPECT_ARG_PREFIXES) {
    if (token === prefix || token.startsWith(`${prefix}=`)) return true
  }
  if (token === '--debug-brk' || token.startsWith('--debug-brk=')) return true
  if (token === '--debug' || token.startsWith('--debug=')) return true
  return false
}

function argvHasInspectFlag(tokens: readonly string[]): boolean {
  for (const token of tokens) {
    if (tokenHasInspectFlag(token)) return true
  }
  return false
}

/**
 * The process supervisor running this host, when one can be identified —
 * `null` when nothing says so.
 *
 * This exists because the failure it prevents is the worst one the market
 * can cause. Under systemd's default `KillMode=control-group`, everything in
 * the unit's cgroup dies with the main process — including the detached
 * helper that was supposed to bring the replacement up. So "restart" killed
 * a production service and nothing came back (#229 by @SkillBase-Al: "杀死了
 * 服务但是无法重复启动服务"). `allowRestart: false` was always the documented
 * answer, but it is opt-in, and nothing told the operator to opt in until
 * after they had already lost the service.
 *
 * TWO signals are required, and the second is the whole reason this function
 * is not a one-line env check. `INVOCATION_ID` is INHERITED: every
 * descendant of a systemd unit carries it, which on Linux includes an
 * ordinary desktop terminal (its shell descends from a user-session unit)
 * and a CI runner (the agent is a unit — this repo's own smoke test caught
 * that). Treating inheritance as ownership would disable the button for a
 * large population of hosts where it works fine, which is a worse bug than
 * the one being fixed.
 *
 * The parent test is what distinguishes being the unit's own main process
 * from merely descending from one: a terminal's node has the shell as its
 * parent and a runner's has the agent. It used to be `ppid === 1`, which is
 * only true for SYSTEM units. A per-user unit's service is forked by that
 * user's manager instance — `systemd --user`, an ordinary PID — so user-unit
 * hosts read as unsupervised, and one-click restart killed them for good
 * (#471 by @automagik-genie, with the journal to prove the whole chain:
 * clean SIGTERM exit → `Restart=on-failure` does not fire → `KillMode=mixed`
 * SIGKILLs the detached helper before it can spawn the replacement). So the
 * parent counts as a manager when it is PID 1 or its comm is `systemd` —
 * the one name both manager instances share and the false-positive parents
 * (shells, CI agents) never carry. `/proc` is Linux-only, which is exactly
 * as wide as systemd itself; anywhere it cannot be read the answer stays
 * "not a manager".
 *
 * Scoped to systemd on purpose. pm2 sets `pm_id`, but it is inherited the
 * same way and pm2's God daemon — not PID 1 — is the parent, so there is no
 * equivalent second signal; a guess there would reintroduce exactly the
 * false positive this pair exists to avoid. launchd has no marker at all.
 * Both still need the explicit setting: detection is a safety net over the
 * documented option, never a replacement for it.
 */
export function detectedSupervisor(
  env: NodeJS.ProcessEnv = process.env,
  ppid: number = process.ppid,
  parentComm: (pid: number) => string | null = readParentComm,
): string | null {
  const set = (name: string): boolean => (env[name] ?? '') !== ''
  if (!set('INVOCATION_ID') && !set('JOURNAL_STREAM')) return null
  if (ppid === 1 || parentComm(ppid) === 'systemd') return 'systemd'
  return null
}

/** The comm of `pid` from /proc, or null wherever that cannot be read. */
function readParentComm(pid: number): string | null {
  try {
    return readFileSync(`/proc/${String(pid)}/comm`, 'utf8').trim()
  } catch {
    return null
  }
}

/**
 * Whether this host process is under a debugger, when one can be identified —
 * `'inspector'` or `null`.
 *
 * Parallel to `detectedSupervisor()` (#229): a runtime latch for the restart
 * route and status poll, NOT an entry in `restartAllowed()`. Folding it into
 * `restartAllowed()` would write `allowRestart: false` through the settings
 * page while a debug session is open, and the switch would stay off after
 * the debugger detaches (#447).
 *
 * An explicit `allowRestart: true` does NOT override this latch either —
 * unlike systemd, there is no documented deployment shape where killing a
 * debug-attached host from the market UI is the right answer.
 *
 * Primary signal: `inspector.url()` is set (covers `--inspect` at boot,
 * `inspector.open()`, and SIGUSR1 attach). Secondary: inspect-family flags
 * in `execArgv` and `NODE_OPTIONS`, matched by token prefix — not a
 * `/inspect/` substring, so script paths like `.../inspect-tool.js` do not
 * false-positive. Includes `--inspect-wait` for Node versions that expose it
 * as a distinct flag before `inspector.url()` is populated.
 *
 * Accepted false positive (same trade as #229 not guessing pm2): a host left
 * listening on an inspector port — including `NODE_OPTIONS=--inspect` with
 * nobody attached — is treated as debug-owned and gets no one-click restart.
 */
export function detectedDebugger(
  inspectorUrl: string | undefined = inspector.url(),
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string = process.env.NODE_OPTIONS ?? '',
): 'inspector' | null {
  if (debuggerOverride !== undefined) return debuggerOverride
  if (inspectorUrl !== undefined && inspectorUrl !== '') return 'inspector'
  if (argvHasInspectFlag(execArgv)) return 'inspector'
  const options = nodeOptions.trim()
  if (options !== '' && argvHasInspectFlag(options.split(/\s+/u))) return 'inspector'
  return null
}

/**
 * Self-restart is enabled by default, disabled by an explicit false — and
 * disabled by DEFAULT under a detected supervisor, which owns restarts and
 * whose process group would take the replacement helper down with it.
 *
 * An explicit `true` still wins: an operator who has configured their unit
 * for it (`KillMode=process`, or a wrapper that survives) is making a
 * statement about their own deployment, and this should not overrule it.
 */
export function restartAllowed(
  config: { allowRestart?: boolean },
  env: NodeJS.ProcessEnv = process.env,
  ppid: number = process.ppid,
): boolean {
  if (config.allowRestart !== undefined) return config.allowRestart
  return detectedSupervisor(env, ppid) === null
}

/**
 * The port this process is serving on, read off the request that asked for
 * the restart.
 *
 * The alternative is to parse it out of the launch argv, which is wrong for
 * every host that binds from config or an env var. The Host header is what
 * the browser actually reached us on, so it is the port the replacement has
 * to take over — and it is already validated against Origin by the guard
 * below before any of this runs.
 * @returns the port, or null when the header carries none (a default port).
 */
export function servingPort(request: Pick<IncomingMessage, 'headers'> & { socket?: { localPort?: unknown } }): number | null {
  // The port this process is actually listening on (#859): behind a tunnel
  // the Host carries the proxy's port (dsh.example.com:8443), and handing
  // that to the restart helper makes it probe and bind the proxy instead of
  // the server it is replacing. The socket's local port is the listener's
  // own; Host stays as the fallback for a request object without one.
  const localPort = request.socket?.localPort
  if (typeof localPort === 'number' && Number.isInteger(localPort) && localPort > 0 && localPort < 65536) return localPort
  const host = request.headers.host
  if (host === undefined) return null
  const match = /:(\d{1,5})$/u.exec(host)
  if (match === null) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

/**
 * The part of the restart fence that does not depend on `Origin`: a loopback
 * peer, no forwarding trace, and a Host that names a loopback authority.
 *
 * One function so the route that ENFORCES the fence and the status poll that
 * PREDICTS it cannot drift apart (#782). It deliberately leaves `Origin` out:
 * a same-origin GET — which is what the status poll is — carries none, so a
 * prediction that required it would call every ordinary local request
 * impossible and take the button away from everyone.
 */
function directLoopbackRequest(request: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  // Any forwarding trace means the loopback peer is a proxy, not the user.
  if (request.headers.forwarded !== undefined
    || request.headers['x-forwarded-for'] !== undefined
    || request.headers['x-real-ip'] !== undefined) return false
  // A loopback PEER is not enough: a DNS-rebinding page reaches 127.0.0.1
  // through a name it controls, so the address proves nothing and Host/Origin
  // both carry the attacker's domain (#678). Host is what the attack cannot
  // forge, so it has to name a loopback authority.
  return loopbackAuthority(request.headers.host)
}

/**
 * Whether the request's Host names an authority the HOST declared —
 * `dsh web --trusted-host <name>` — as the ordinary route fence reads it.
 *
 * A declared authority is the operator's own statement about the name this
 * deployment serves. It is the same statement the host's own fence already
 * accepts for every other request on the host, and the same one `sameOrigin`
 * accepts for the market's ordinary routes (#729): a deployment reached by a
 * name is not a stranger to itself.
 *
 * A LOOPBACK authority is deliberately not this path. The lane deployments
 * declare `127.0.0.1` alongside their public name, and a loopback Host is the
 * direct path's business — where the peer's address is checked as well. This
 * path is only for a name the deployment answers to on the network.
 */
function declaredAuthority(request: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  const host = request.headers.host
  if (host === undefined) return false
  if (loopbackAuthority(host)) return false
  return trustedAuthority(host, declaredTrustedHosts())
}

/**
 * Whether the request names an authority this deployment serves, and is not
 * a cross-site request.
 *
 * Two shapes, and a deployment has to be one of them:
 *
 * - DIRECT: a loopback peer, no forwarding trace, and a loopback Host. The
 *   peer proves the request did not come through a proxy, and the Host proves
 *   it did not come through a name the attacker controls (#678).
 * - THROUGH THE PERIMETER: a Host the host DECLARED. The peer is then the
 *   proxy (a tunnel, an Ingress) and a forwarding trace is expected rather
 *   than suspicious, so the peer is not what decides — the declared Host is.
 *
 * What still holds in both: the Host is the header an attacker's page cannot
 * forge, an undeclared name is refused, and a browser that labels the request
 * cross-site is refused outright — exactly as the host's own fence and
 * `sameOrigin` do.
 */
function servedAuthority(request: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  if (declaredAuthority(request)) return true
  return directLoopbackRequest(request)
}

/**
 * Whether an `Origin` header names the same authority as the `Host` header.
 *
 * The `null` origin (a sandboxed iframe, a `data:` document) is a
 * present-but-unparseable origin and is refused; an absent Origin is the
 * caller's decision, not this function's.
 */
function sameAuthorityOrigin(origin: string | undefined, host: string): boolean {
  if (origin === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

/**
 * Whether a restart request made from the same page as THIS request could pass
 * the fence (#782): the answer the status poll reports so the banner can say
 * why there is no button, instead of rendering one that always answers 403.
 *
 * Read off the request that asked for status, not off configuration. Behind an
 * Ingress or any reverse proxy the restart POST arrives from the same page over
 * the same path, so it fails for the same reasons this request shows — a proxy
 * peer, forwarding headers, a non-loopback Host. It is a prediction, never a
 * grant: the route still runs the full fence, including `Origin`, on the POST.
 *
 * A deployment that DECLARES its public name answers it truthfully now: the
 * status poll sees the declared Host and reports the restart as reachable,
 * exactly as the route will judge it.
 */
export function restartReachableFrom(request: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  return servedAuthority(request)
}

/**
 * Whether the request has the exact shape dsh Desktop's own document proxy
 * forwards: a loopback peer, no forwarding headers, and **neither** `Host`
 * nor `Origin`.
 *
 * The desktop app strips `origin`/`host` (and cookies) before forwarding to
 * the internal host (#648), so that absence is the trusted desktop shape
 * rather than a missing signal. It is also not something a browser can
 * produce — every browser request carries `Host` — so a rebinding page or a
 * cross-site POST still lands on the strict path below, carrying the
 * attacker's own names (#678). A local non-browser client could omit both,
 * but such a client can equally set them correctly, so this widens nothing
 * against the threats the fence exists for.
 */
function desktopForwardedRequest(request: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  if (request.headers.forwarded !== undefined
    || request.headers['x-forwarded-for'] !== undefined
    || request.headers['x-real-ip'] !== undefined) return false
  return request.headers.host === undefined && request.headers.origin === undefined
}

/**
 * Whether a self-uninstall request may proceed.
 *
 * Same door as the restart route, plus the desktop proxy's headerless shape
 * (#903): on Desktop the market's own card is the place users go to remove it,
 * and the fence was refusing every such click because the proxy had stripped
 * the very headers it required. Restart keeps the stricter predicate — it
 * spawns a replacement host, which is not something a desktop-managed profile
 * should get from here.
 */
export function trustedSelfUninstallRequest(request: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  return trustedRestartRequest(request) || desktopForwardedRequest(request)
}

/**
 * Whether the request that asked for status could uninstall the market (#903).
 *
 * The prediction, like the restart one, leaves `Origin` out: the status poll
 * is a same-origin GET and carries none, so a prediction that required one
 * would hide the button on every deployment that has a declared authority —
 * the same shape the route accepts.
 */
export function selfUninstallReachableFrom(request: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  return servedAuthority(request) || desktopForwardedRequest(request)
}

/** Whether a process-control request came from this Web host on loopback. */
export function trustedRestartRequest(request: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  if (!servedAuthority(request)) return false
  const host = request.headers.host
  if (host === undefined) return false
  // Process control always carries an Origin: the button is a page's own
  // request, and a request without one is not a page's request.
  return sameAuthorityOrigin(request.headers.origin, host)
}

/**
 * Whether a download navigation may fetch a sensitive GET export.
 * Browsers do NOT send an Origin header on same-origin GET navigations
 * (`<a href="/..." download>`), so unlike process-control requests a missing
 * Origin is the NORMAL shape of a user-initiated download and must pass.
 * Keep the rest of the posture: the Host must name an authority this
 * deployment serves (loopback, or one the host declared), and — when an
 * Origin IS present (fetch/CORS attempts) — it must still match Host so a
 * cross-origin page cannot read the export.
 */
export function trustedDownloadRequest(request: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  if (!servedAuthority(request)) return false
  const host = request.headers.host
  if (host === undefined) return false
  const origin = request.headers.origin
  if (origin === undefined) return true // plain browser download navigation
  return sameAuthorityOrigin(origin, host)
}

/** The exact boot invocation the detached restart helper replays. */
export function restartLaunch(): { file: string; args: string[]; cwd: string; viaShell: boolean } {
  const launch = dshArgv()
  return {
    ...launch,
    args: [...launch.args, ...process.argv.slice(2)],
    cwd: launch.cwd ?? process.cwd(),
  }
}

/**
 * Platform-correct spawn invocation for the replacement host (#40 by
 * @1123762794): on Windows a `detached` spawn maps to DETACHED_PROCESS — the
 * new host gets NO console, and every console child it later spawns (e.g.
 * DSH sandbox tool runners) pops a visible node window. Wrapping the launch
 * in `powershell -WindowStyle Hidden` gives the host a HIDDEN console that
 * children inherit instead. POSIX keeps the plain detached spawn.
 *
 * The helper that runs this invocation spawns it with `windowsHide`, because
 * the helper has no console of its own to hand down and Windows would
 * otherwise create a visible one for PowerShell (#624).
 */
export function respawnInvocation(
  launch: { file: string; args: string[]; viaShell: boolean },
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; viaShell: boolean; detached: boolean } {
  if (platform !== 'win32') {
    return { file: launch.file, args: launch.args, viaShell: launch.viaShell, detached: true }
  }
  // PowerShell single-quoting: only embedded single quotes need escaping
  // (doubled). Name the cmd shim explicitly: invoking bare `dsh` lets
  // PowerShell prefer dsh.ps1, which a default Restricted execution policy
  // refuses before the replacement can start (#397). `dsh.cmd` is produced
  // by the same npm install and is not governed by PowerShell script policy.
  const quote = (part: string): string => `'${part.replace(/'/g, "''")}'`
  const file = launch.viaShell && !/\.(?:cmd|bat)$/iu.test(launch.file)
    ? `${launch.file}.cmd`
    : launch.file
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
      [`& ${quote(file)}`, ...launch.args.map(quote)].join(' ')],
    viaShell: false,
    detached: false,
  }
}

/** What scheduleRestart reports back to the caller for logging/response. */
export interface RestartResult {
  pid: number
  helperPid: number | undefined
  logOut: string
  logErr: string
  /** The recovery handoff, when one was written for this restart. */
  recovery: { config: string; script: string } | null
}

/**
 * Where the recovery script lives beside this module.
 *
 * The built layout is `lib/restart.js` + `lib/recovery.js`, and the source
 * layout has no runnable sibling at all (a spawned `node` cannot load a `.ts`
 * file), so the answer is the built path or nothing. Nothing is a supported
 * outcome, not a failure: the helper then behaves exactly as it did before the
 * recovery surface existed — it notes the failure and exits — and every test
 * that drives the handoff passes its own script instead of relying on a build
 * having happened.
 * @returns the absolute path, or null when this checkout has no built copy.
 */
export function recoveryScriptPath(): string | null {
  try {
    const candidate = fileURLToPath(new URL('./recovery.js', import.meta.url))
    return existsSync(candidate) ? candidate : null
  } catch {
    return null
  }
}

/**
 * Source for the detached helper that outlives this process and brings the
 * replacement up.
 *
 * Extracted so the waiting can be tested by RUNNING it, which is the only
 * way this class of bug shows itself: every part of the old helper looked
 * right in isolation.
 *
 * What it fixes (#177, reported on Windows 11, reproducible every time): the
 * helper slept a flat 1500ms and spawned. The old process had exited, but
 * the listening socket had not been released yet, so the replacement died
 * instantly with EADDRINUSE — and the spawn was wrapped in `catch {}`, so
 * nothing was written anywhere. The user saw a restart button that did
 * nothing. The docstring above it even claimed the helper "waits for our
 * port to free up"; it never did.
 *
 * So: wait for the port to actually go quiet, then start, then CHECK that
 * something came up, and write a diagnosis when it did not. A restart that
 * fails must leave evidence — this one is invisible by construction, since
 * the process that would have logged it is the one that just exited.
 * @param port - the port the replacement must bind; when unknown, the helper
 *   falls back to the old fixed delay, which is better than nothing.
 */
export function restartHelperSource(
  spawned: { file: string; args: string[]; viaShell: boolean; detached: boolean },
  launch: { cwd: string },
  logs: { out: string; err: string },
  port: number | null,
  recovery: { script: string; config: string } | null = null,
): string {
  return [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    `const file = ${JSON.stringify(spawned.file)}`,
    `const args = ${JSON.stringify(spawned.args)}`,
    `const cwd = ${JSON.stringify(launch.cwd)}`,
    `const viaShell = ${JSON.stringify(spawned.viaShell)}`,
    `const detached = ${JSON.stringify(spawned.detached)}`,
    `const logOut = ${JSON.stringify(logs.out)}`,
    `const logErr = ${JSON.stringify(logs.err)}`,
    `const port = ${JSON.stringify(port)}`,
    `const recoveryScript = ${JSON.stringify(recovery?.script ?? null)}`,
    `const recoveryConfig = ${JSON.stringify(recovery?.config ?? null)}`,
    'const sleep = (ms) => new Promise(r => setTimeout(r, ms))',
    'const note = (line) => { try { fs.appendFileSync(logErr, `[dsh-market] ${line}\n`) } catch {} }',
    // How the helper itself ended. A restart that fails leaves this file as
    // the only account of what happened, and "the helper vanished" and "the
    // helper exited" are different bugs with the same symptom.
    'process.on("exit", (code) => note("helper exiting (code " + code + ")"))',
    'process.on("uncaughtException", (error) => note("helper crashed: " + (error && error.stack ? error.stack : error)))',
    'process.on("unhandledRejection", (error) => note("helper rejection: " + (error && error.stack ? error.stack : error)))',
    // "Free" means nothing accepts a connection. Checked by connecting rather
    // than by binding: binding to test would itself hold the port for the
    // moment the replacement needs it.
    'const listening = () => new Promise((resolve) => {',
    '  const probe = net.connect({ host: "127.0.0.1", port })',
    '  const done = (value) => { probe.destroy(); resolve(value) }',
    '  probe.on("connect", () => done(true))',
    '  probe.on("error", () => done(false))',
    '  setTimeout(() => done(false), 500)',
    '})',
    // The recovery surface is a separate process on purpose: it has to
    // outlive this helper AND the DSH package tree it protects, and it must
    // be startable when the composition that just failed is the market's own.
    // A script that cannot be spawned degrades to the pre-recovery behaviour
    // — one line in the log — rather than to no restart at all.
    // How the replacement ended, when it ended before it bound the port.
    // Top level rather than inside main() because the handoff reads it.
    'let exited = null',
    // The pid of the replacement, so the recovery surface can refuse to take
    // the port while that process is still alive (#719). Passed as an argument
    // rather than through the config: the config is written before the spawn.
    'let replacementPid = null',
    'const handOff = async () => {',
    '  if (!recoveryScript || !recoveryConfig) return',
    '  try {',
    // windowsHide with the detached spawn: this helper has no console, so a
    // console program spawned from it is handed a new, visible one (#624).
    // Measured on Windows 11: the flag combination is accepted and the child
    // runs (the two flags are documented as mutually exclusive on MSDN, so
    // the probe matters more than the docs here).
    '    const child = spawn(process.execPath, [recoveryScript, recoveryConfig, "--exit=" + String(exited), "--bound=0", "--pid=" + String(replacementPid ?? 0)], { detached: true, stdio: "ignore", env: process.env, windowsHide: true })',
    '    child.on("error", (error) => note(`could not start the recovery surface: ${error && error.message ? error.message : error}`))',
    '    child.unref()',
    '    note("the replacement never came up — starting the recovery surface")',
    '  } catch (error) {',
    '    note(`could not start the recovery surface: ${error && error.message ? error.message : error}`)',
    '  }',
    '}',
    'const main = async () => {',
    // Stage lines, not debugging: a restart that fails leaves this file as the
    // only account of what the helper did, and "the replacement never came up"
    // reads very differently depending on whether the port was ever released.
    '  note(`helper up (pid ${process.pid}) for port ${port}`)',
    '  if (port) {',
    '    const until = Date.now() + 30000',
    '    while (Date.now() < until && await listening()) await sleep(250)',
    '    if (await listening()) note(`port ${port} was still in use after 30s; starting anyway`)',
    // A released socket can still be in TIME_WAIT for a moment on Windows.
    '    await sleep(300)',
    '    note(`port ${port} is free; starting the replacement`)',
    '  } else {',
    '    await sleep(1500)',
    '  }',
    '  let child',
    '  try {',
    '    const out = fs.openSync(logOut, "a")',
    '    const err = fs.openSync(logErr, "a")',
    // windowsHide (#624 by @davidekingsss): this helper is itself detached,
    // so on Windows it has no console, and a console program spawned from a
    // console-less parent is given a NEW, visible one — the "Windows
    // PowerShell" window that owns the replacement and takes it down when
    // closed. `-WindowStyle Hidden` cannot hide it: that flag governs the
    // window PowerShell would create, not the console the spawn handed it.
    // CREATE_NO_WINDOW keeps the console but never shows it, and the host's
    // own console children inherit that hidden console rather than popping
    // windows of their own (measured by the reporter with a console-less
    // launcher: one PseudoConsoleWindow without the flag, none with it).
    '    child = spawn(file, args, { cwd, detached, stdio: ["ignore", out, err], env: process.env, shell: viaShell, windowsHide: true })',
    // spawn reports a missing or unexecutable file ASYNCHRONOUSLY; the
    // try/catch below only covers the synchronous throw, so without this
    // listener that failure is exactly as silent as the bug being fixed.
    '    child.on("error", (error) => note(`could not start the replacement: ${error && error.message ? error.message : error}`))',
    // A replacement that has already exited is a verdict, not a wait: polling
    // out the whole window for a process that is gone is the difference
    // between a recovery page in seconds and one after twenty, and the market
    // page's own poll is racing that same clock.
    '    child.on("exit", (code) => { exited = code === null ? -1 : code })',
    '    child.unref()',
    '    replacementPid = child.pid ?? null',
    '    note(`replacement started (pid ${child.pid})`)',
    '  } catch (error) {',
    '    note(`could not start the replacement: ${error && error.message ? error.message : error}`)',
    '    return',
    '  }',
    // Outliving the spawn matters on Windows: a helper that exits the
    // instant it has spawned can take the replacement with it, because the
    // child is in its process group and has not detached yet. The port path
    // below already lingers while it polls; this is the same guarantee for
    // the path that has no port to poll. CI on windows-latest caught it —
    // locally it passes either way.
    "  if (!port) { await sleep(3000); return }",
    // Success is not 'the port answered once'. A boot that fails its
    // activation audit has ALREADY bound the web port by the time the audit
    // runs — the tree mounts, the server listens, and only then does DSH
    // refuse the whole composition and exit. Judging on a single answer
    // therefore reports success for a harness that is mid-collapse, and the
    // recovery surface never starts: exactly the failure this handoff exists
    // for. The port has to answer CONTINUOUSLY for SETTLE_MS instead, which
    // is far longer than an audit takes to refuse a tree and much shorter
    // than a user would notice. (src/recovery.ts keeps the same rule for the
    // boots it supervises.)
    '  const SETTLE_MS = 8000',
    // 45s, not 20s: this window has to outlast a real cold start, and on a
    // source-run host with a large plugin tree the webserver binds at ~42-45s
    // (measured, #719). At 20s the helper gave up while the replacement was
    // still starting, handed the port to the recovery surface, and the
    // replacement then died on EADDRINUSE — a deadlock nothing could break.
    // Matches BOOT_TIMEOUT_MS in src/recovery.ts, which is the same budget
    // seen from the other side. A replacement that EXITS still ends this
    // early (the `exited` break below), so a genuinely failed boot is not
    // made slower by the wider backstop.
    '  const startedAt = Date.now()',
    '  const upBy = Date.now() + 45000 + SETTLE_MS',
    // #854: the window is a budget for "has it come up", NOT a verdict on
    // "is it dead". A cold start right after the market rewrote node_modules
    // can outlast it (measured on Windows: bind at ~63s with a scanner on the
    // fresh files), and handing the port over while the replacement is still
    // RUNNING is what turns a slow boot into the deadlock #719 removed: the
    // surface takes port 3080, the host reaches its own bind and dies on
    // EADDRINUSE, and nothing can come back. So a replacement that has NOT
    // exited keeps the port, up to a hard cap; one that has exited still ends
    // the wait immediately, which is the failed-boot case.
    '  const hardBy = Date.now() + 240000',
    '  let steadySince = null',
    '  let announcedWait = false',
    '  while (true) {',
    '    if (await listening()) {',
    '      if (steadySince === null) steadySince = Date.now()',
    '      else if (Date.now() - steadySince >= SETTLE_MS) return',
    '    } else {',
    '      steadySince = null',
    '      if (exited !== null) break',
    '      const now = Date.now()',
    '      if (now >= hardBy) break',
    '      if (now >= upBy && !announcedWait) {',
    '        announcedWait = true',
    // The numbers are computed, not typed twice: a log line that drifts from
    // the constants it describes is worse than no line at all.
    '        note(`the replacement is still starting after ${String(Math.round((upBy - startedAt) / 1000))}s and has not exited — waiting up to ${String(Math.round((hardBy - startedAt) / 1000))}s for it rather than taking its port (it would die on EADDRINUSE)`)',
    '      }',
    '    }',
    '    await sleep(500)',
    '  }',
    '  note(`the replacement never came up on port ${port}${exited === null ? " (it is still running, so the recovery surface waits for it to exit before binding)" : ` (it exited with code ${exited})`} — see the output log beside this one`)',
    // The host is not coming back on its own. Everything the user can still
    // do about it lives in the recovery surface, so start it while the
    // browser tab that asked for the restart is still open.
    '  await handOff()',
    '}',
    'main()',
  ].join('\n')
}

/**
 * Relaunch this exact DSH entry after a detached handoff, then stop this
 * process. The helper outlives us (detached + unref), waits for our port to
 * be released before starting the replacement, and logs under tmpdir.
 *
 * When a recovery config is supplied it is written out BEFORE the helper
 * starts, because it describes the state of the world this process is about
 * to leave behind: the plugin inventory as the live loader sees it, and the
 * exact invocation the replacement needs. Nothing downstream could
 * reconstruct either — the process that knows them is the one being replaced.
 * @param port - the port this process is serving on, so the helper can wait
 *   for it rather than guessing at a delay.
 * @param recovery - what the recovery surface needs, when the restart should
 *   leave one behind; omitted by callers that do not want one.
 */
export function scheduleRestart(port: number | null = null, recovery?: RecoveryHandoffConfig): RestartResult {
  const launch = restartLaunch()
  const spawned = respawnInvocation(launch)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const logOut = join(tmpdir(), `dsh-market-restart-${stamp}.out.log`)
  const logErr = join(tmpdir(), `dsh-market-restart-${stamp}.err.log`)
  let handoff: { script: string; config: string } | null = null
  const script = recoveryScriptPath()
  // No port means no origin to serve the recovery page on, and no script
  // means no recovery server to serve it with; in both cases the helper keeps
  // its pre-recovery behaviour instead of leaving a config file nobody reads.
  if (recovery !== undefined && port !== null && script !== null) {
    const configPath = join(tmpdir(), `dsh-market-restart-${stamp}.recovery.json`)
    try {
      writeFileSync(configPath, JSON.stringify({
        ...recovery,
        port,
        logs: { out: logOut, err: logErr },
        spawn: spawned,
        cwd: launch.cwd,
      }, null, 2))
      handoff = { script, config: configPath }
    } catch {
      handoff = null
    }
  }
  const helper = spawn(nodeExecutable(), ['-e', restartHelperSource(spawned, launch, { out: logOut, err: logErr }, port, handoff)], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  helper.unref()
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500)
  return { pid: process.pid, helperPid: helper.pid, logOut, logErr, recovery: handoff }
}
