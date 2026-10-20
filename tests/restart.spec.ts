/**
 * #40: the one-click restart must not leave the replacement host
 * console-less on Windows. A `detached` spawn maps to DETACHED_PROCESS (no
 * console at all), after which every console child the host spawns (e.g.
 * DSH sandbox tool runners) pops a visible window. The fix: launch the
 * replacement through `powershell -WindowStyle Hidden`, which gives it a
 * HIDDEN console that children inherit. POSIX keeps the plain detached
 * spawn (process groups, no console concept).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { detectedDebugger, detectedSupervisor, respawnInvocation, restartAllowed, restartReachableFrom, selfUninstallReachableFrom, trustedDownloadRequest, trustedRestartRequest, trustedSelfUninstallRequest } from '../src/restart.ts'
import { setTrustedHostsSource } from '../src/http.ts'

const LAUNCH = { file: 'C:\\Program Files\\nodejs\\node.exe', args: ['--import', 'tsx/esm', 'bin.ts', '--profile', 'web'], viaShell: false }

describe('respawnInvocation (#40)', () => {
  it('wraps the win32 relaunch in powershell -WindowStyle Hidden (hidden console, not none)', () => {
    const spawned = respawnInvocation(LAUNCH, 'win32')
    expect(spawned.file).toBe('powershell.exe')
    expect(spawned.args.slice(0, 4)).toEqual(['-NoProfile', '-WindowStyle', 'Hidden', '-Command'])
    // The inner command line must carry the full original invocation,
    // single-quoted so spaces in paths survive PowerShell parsing.
    expect(spawned.args[4]).toBe("& 'C:\\Program Files\\nodejs\\node.exe' '--import' 'tsx/esm' 'bin.ts' '--profile' 'web'")
    // DETACHED_PROCESS is exactly the flag that caused #40.
    expect(spawned.detached).toBe(false)
    expect(spawned.viaShell).toBe(false)
  })

  it('escapes embedded single quotes PowerShell-style (doubled)', () => {
    const spawned = respawnInvocation({ file: "C:\\it's here\\dsh.cmd", args: [], viaShell: true }, 'win32')
    expect(spawned.args[4]).toBe("& 'C:\\it''s here\\dsh.cmd'")
  })

  it('names the cmd shim explicitly so Restricted policy cannot select dsh.ps1 (#397)', () => {
    const spawned = respawnInvocation({ file: 'dsh', args: ['web'], viaShell: true }, 'win32')
    expect(spawned.args[4]).toBe("& 'dsh.cmd' 'web'")
  })

  it('keeps the plain detached spawn on POSIX', () => {
    const spawned = respawnInvocation({ file: 'node', args: ['bin.ts'], viaShell: false }, 'darwin')
    expect(spawned).toEqual({ file: 'node', args: ['bin.ts'], viaShell: false, detached: true })
  })
})

/**
 * The backup export is a GET navigation (`<a href="/dsh-market/backup"
 * download>`), and browsers do NOT send an Origin header on same-origin GET
 * navigations — so the download trust check must treat a missing Origin as
 * the normal user-initiated shape, unlike process control.
 */
describe('trustedDownloadRequest', () => {
  const req = (headers: Record<string, string>, remoteAddress = '127.0.0.1') =>
    ({ headers, socket: { remoteAddress } }) as unknown as Parameters<typeof trustedDownloadRequest>[0]

  it('accepts a plain download navigation without an Origin header', () => {
    expect(trustedDownloadRequest(req({ host: '127.0.0.1:3080' }))).toBe(true)
  })

  it('accepts a same-origin Origin header (fetch-style request)', () => {
    expect(trustedDownloadRequest(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }))).toBe(true)
  })

  it('refuses a cross-origin Origin so another page cannot read the export', () => {
    expect(trustedDownloadRequest(req({ host: '127.0.0.1:3080', origin: 'http://evil.example' }))).toBe(false)
    expect(trustedDownloadRequest(req({ host: '127.0.0.1:3080', origin: 'not a url' }))).toBe(false)
  })

  it('keeps the process-control posture: loopback peer, no proxy headers', () => {
    expect(trustedDownloadRequest(req({ host: 'x' }, '192.168.1.5'))).toBe(false)
    expect(trustedDownloadRequest(req({ host: 'x' }, '10.0.0.2'))).toBe(false)
    expect(trustedDownloadRequest(req({ host: 'x', forwarded: 'for=1.2.3.4' }))).toBe(false)
    expect(trustedDownloadRequest(req({ host: 'x', 'x-forwarded-for': '1.2.3.4' }))).toBe(false)
    expect(trustedDownloadRequest(req({ host: 'x', 'x-real-ip': '1.2.3.4' }))).toBe(false)
    expect(trustedDownloadRequest(req({}, '127.0.0.1'))).toBe(false) // Host required
  })
})

/**
 * The gate on the one-click restart endpoint — the market's only route that
 * relaunches the host process. Three independent conditions have to hold,
 * and each was reachable only through the flow suite's HTTP tests, so a
 * mutation that trusted a MALFORMED Origin broke nothing: the catch's
 * `return false` was never observed.
 */
/**
 * Self-uninstall shares the restart fence, plus the one shape dsh Desktop's
 * own proxy forwards: loopback peer, no forwarding trace, and neither `Host`
 * nor `Origin` (#648, #903).
 */
describe('trustedSelfUninstallRequest', () => {
  const req = (headers: Record<string, string>, remoteAddress = '127.0.0.1') =>
    ({ headers, socket: { remoteAddress } }) as unknown as Parameters<typeof trustedSelfUninstallRequest>[0]
  const ok = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }

  it('accepts the desktop proxy shape and everything the restart fence accepts', () => {
    expect(trustedSelfUninstallRequest(req({}))).toBe(true)
    expect(trustedSelfUninstallRequest(req(ok))).toBe(true)
    expect(selfUninstallReachableFrom(req({}))).toBe(true)
    // The restart button stays on the stricter answer: a second host is not
    // something a desktop-managed profile should get from here.
    expect(restartReachableFrom(req({}))).toBe(false)
  })

  it('refuses the desktop shape from anything but a direct loopback peer', () => {
    expect(trustedSelfUninstallRequest(req({}, '192.168.1.5'))).toBe(false)
    for (const header of ['forwarded', 'x-forwarded-for', 'x-real-ip']) {
      expect(trustedSelfUninstallRequest(req({ [header]: 'for=1.2.3.4' })), header).toBe(false)
    }
  })

  it('refuses a half-header request: one name present means a browser or a proxy', () => {
    expect(trustedSelfUninstallRequest(req({ host: '127.0.0.1:3080' }))).toBe(false)
    expect(trustedSelfUninstallRequest(req({ origin: 'http://127.0.0.1:3080' }))).toBe(false)
    expect(trustedSelfUninstallRequest(req({ ...ok, origin: 'http://evil.example' }))).toBe(false)
  })
})

describe('trustedRestartRequest', () => {
  const req = (headers: Record<string, string>, remoteAddress = '127.0.0.1') =>
    ({ headers, socket: { remoteAddress } }) as unknown as Parameters<typeof trustedRestartRequest>[0]
  const ok = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }

  it('accepts a same-origin request from a direct loopback peer', () => {
    expect(trustedRestartRequest(req(ok))).toBe(true)
    expect(trustedRestartRequest(req(ok, '::1'))).toBe(true)
    expect(trustedRestartRequest(req(ok, '::ffff:127.0.0.1'))).toBe(true)
  })

  it('refuses a peer that is not loopback', () => {
    expect(trustedRestartRequest(req(ok, '192.168.1.5'))).toBe(false)
    expect(trustedRestartRequest(req(ok, '10.0.0.2'))).toBe(false)
    // A socket with no remoteAddress at all — built directly, since passing
    // undefined through `req` would just take its default.
    const noPeer = { headers: ok, socket: {} } as unknown as Parameters<typeof trustedRestartRequest>[0]
    expect(trustedRestartRequest(noPeer)).toBe(false)
  })

  it('refuses anything carrying a forwarding trace — the peer is a proxy', () => {
    for (const header of ['forwarded', 'x-forwarded-for', 'x-real-ip']) {
      expect(trustedRestartRequest(req({ ...ok, [header]: 'for=1.2.3.4' })), header).toBe(false)
    }
  })

  it('refuses a missing, cross-origin or MALFORMED Origin', () => {
    expect(trustedRestartRequest(req({ host: '127.0.0.1:3080' }))).toBe(false)
    expect(trustedRestartRequest(req({ ...ok, origin: 'http://evil.example' }))).toBe(false)
    // Unparseable: the catch must refuse, not fall through to trusting it.
    expect(trustedRestartRequest(req({ ...ok, origin: 'not a url' }))).toBe(false)
    expect(trustedRestartRequest(req({ ...ok, origin: '' }))).toBe(false)
  })

  it('refuses a non-http scheme even when the host matches', () => {
    expect(trustedRestartRequest(req({ ...ok, origin: 'file://127.0.0.1:3080' }))).toBe(false)
    expect(trustedRestartRequest(req({ ...ok, origin: 'javascript://127.0.0.1:3080' }))).toBe(false)
  })

  it('refuses when the Host header is absent', () => {
    expect(trustedRestartRequest(req({ origin: 'http://127.0.0.1:3080' }))).toBe(false)
  })
})

describe('restartReachableFrom — the prediction shares the fence, it does not copy it (#782)', () => {
  /**
   * The report: behind an Ingress the banner rendered a "restart now" button
   * that could never succeed — every POST answered 403 — and nothing said so in
   * advance. The status poll can answer "could a restart from this page pass the
   * fence?", but only if it asks the SAME question the route asks. Two copies of
   * the loopback rules would drift; this pins that they cannot.
   */
  const req = (headers: Record<string, string>, remoteAddress = '127.0.0.1') =>
    ({ headers, socket: { remoteAddress } }) as unknown as Parameters<typeof restartReachableFrom>[0]
  const direct = { host: '127.0.0.1:3080' }

  it('is true for a direct local request, WITHOUT an Origin — a same-origin GET carries none', () => {
    // A prediction that demanded Origin would call every ordinary local status
    // poll impossible and take the button away from everyone.
    expect(restartReachableFrom(req(direct))).toBe(true)
    expect(restartReachableFrom(req({ host: 'localhost:3080' }, '::1'))).toBe(true)
  })

  it('is false for the reported Ingress shape: proxy peer, forwarding headers, public Host', () => {
    const ingress = { host: 'dsh.example.com', 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9', 'x-forwarded-proto': 'https' }
    expect(restartReachableFrom(req(ingress, '10.42.0.17'))).toBe(false)
  })

  it('fails on EACH criterion alone, so a partly-proxied deployment is not told yes', () => {
    expect(restartReachableFrom(req(direct, '10.42.0.17')), 'non-loopback peer').toBe(false)
    expect(restartReachableFrom(req({ ...direct, 'x-forwarded-for': '1.2.3.4' })), 'forwarding header').toBe(false)
    expect(restartReachableFrom(req({ host: 'dsh.example.com' })), 'public Host on a loopback peer (rebinding)').toBe(false)
  })

  it('never says yes where the route would say no — one-directional by construction', () => {
    // The route fence is the prediction PLUS an Origin condition, so over every
    // combination the route may only accept a request the prediction accepts.
    const peers = ['127.0.0.1', '::1', '10.0.0.2']
    const hosts: Array<string | undefined> = ['127.0.0.1:3080', 'localhost:3080', 'dsh.example.com', undefined]
    const origins: Array<string | undefined> = [undefined, 'http://127.0.0.1:3080', 'http://dsh.example.com', 'not a url']
    const forwards: Array<Record<string, string>> = [{}, { 'x-forwarded-for': '1.2.3.4' }, { forwarded: 'for=1.2.3.4' }, { 'x-real-ip': '1.2.3.4' }]
    let checked = 0
    for (const peer of peers) for (const host of hosts) for (const origin of origins) for (const forward of forwards) {
      const headers: Record<string, string> = { ...forward }
      if (host !== undefined) headers.host = host
      if (origin !== undefined) headers.origin = origin
      const request = req(headers, peer)
      if (trustedRestartRequest(request)) expect(restartReachableFrom(request), JSON.stringify({ peer, headers })).toBe(true)
      checked += 1
    }
    expect(checked).toBe(peers.length * hosts.length * origins.length * forwards.length)
  })
})

describe('supervisor detection gates self-restart (#229)', () => {
  // Under systemd's default KillMode=control-group the whole cgroup dies
  // with the main process — including the detached helper that was meant to
  // bring the replacement up. Reported as "杀死了服务但是无法重复启动服务":
  // the market killed a production service and nothing came back.
  // allowRestart:false was always the answer, but it was opt-in and nothing
  // told the operator to opt in until after they had lost the service.
  it('names systemd only when this process IS the unit, not merely descended from one', () => {
    // ppid 1 = systemd forked us as a service's main process.
    expect(detectedSupervisor({ INVOCATION_ID: 'abc123' }, 1)).toBe('systemd')
    expect(detectedSupervisor({ JOURNAL_STREAM: '8:12345' }, 1)).toBe('systemd')
    expect(detectedSupervisor({}, 1)).toBeNull()
    // Present-but-empty is not a marker: an exported-and-cleared variable
    // must not read as "supervised".
    expect(detectedSupervisor({ INVOCATION_ID: '' }, 1)).toBeNull()
  })

  it('does NOT claim systemd for a mere descendant of a unit — the env var is inherited', () => {
    // The failure this guards is the one this repo's own restart smoke test
    // caught: a CI runner is a systemd unit, so its jobs inherit
    // INVOCATION_ID, as does any terminal descended from a user-session
    // unit. Reading inheritance as ownership would hide the button on a
    // large population of hosts where restart works fine — a worse bug than
    // the one being fixed.
    //
    // The parent's comm is injected: on the Linux CI runner the default
    // implementation would read the REAL /proc entry of whatever happens to
    // own pid 4242, and the assertion would depend on the runner's process
    // table.
    expect(detectedSupervisor({ INVOCATION_ID: 'abc123' }, 4242, () => 'bash')).toBeNull()
    expect(detectedSupervisor({ JOURNAL_STREAM: '8:12345' }, 4242, () => 'Runner.Worker')).toBeNull()
    // No /proc to consult (macOS, or the pid vanished) keeps the old answer.
    expect(detectedSupervisor({ INVOCATION_ID: 'abc123' }, 4242, () => null)).toBeNull()
  })

  it('names systemd for a per-user unit, whose manager is not PID 1 (#471)', () => {
    // A user unit's service is forked by that user's `systemd --user`
    // instance — an ordinary pid. Reading that as "unsupervised" is how
    // one-click restart killed a user-unit host for good: clean SIGTERM
    // exit, Restart=on-failure does not fire, KillMode=mixed SIGKILLs the
    // detached helper before it can spawn the replacement.
    expect(detectedSupervisor({ INVOCATION_ID: 'abc123' }, 1759, () => 'systemd')).toBe('systemd')
    expect(detectedSupervisor({ JOURNAL_STREAM: '8:1' }, 1759, () => 'systemd')).toBe('systemd')
    // The comm alone is not enough — the env marker is still required, so a
    // bare child of some unrelated process named systemd does not count.
    expect(detectedSupervisor({}, 1759, () => 'systemd')).toBeNull()
  })

  it('defaults restart OFF under a detected supervisor and ON without one', () => {
    expect(restartAllowed({}, {}, 1)).toBe(true)
    expect(restartAllowed({}, { INVOCATION_ID: 'abc123' }, 1)).toBe(false)
    // Inherited marker, ordinary parent: still allowed.
    expect(restartAllowed({}, { INVOCATION_ID: 'abc123' }, 4242)).toBe(true)
  })

  it('lets an explicit setting win in BOTH directions', () => {
    // An operator whose unit is configured for it (KillMode=process, or a
    // wrapper that survives) is describing their own deployment; detection
    // is a default, not an override.
    expect(restartAllowed({ allowRestart: true }, { INVOCATION_ID: 'abc123' }, 1)).toBe(true)
    // ...and the documented opt-out still works with no supervisor detected.
    expect(restartAllowed({ allowRestart: false }, {}, 4242)).toBe(false)
  })
})

describe('debugger detection gates self-restart (#447)', () => {
  it('names inspector when inspector.url() is set', () => {
    expect(detectedDebugger('ws://127.0.0.1:9229/uuid', [], '')).toBe('inspector')
  })

  it('detects inspect-family flags in execArgv by token prefix', () => {
    expect(detectedDebugger(undefined, ['--inspect=9229'], '')).toBe('inspector')
    expect(detectedDebugger(undefined, ['--inspect-brk'], '')).toBe('inspector')
    expect(detectedDebugger(undefined, ['--inspect-port=9230'], '')).toBe('inspector')
    expect(detectedDebugger(undefined, ['--inspect-wait'], '')).toBe('inspector')
    expect(detectedDebugger(undefined, ['--debug-brk'], '')).toBe('inspector')
  })

  it('detects inspect flags in NODE_OPTIONS', () => {
    expect(detectedDebugger(undefined, [], '--inspect=9229')).toBe('inspector')
    expect(detectedDebugger(undefined, [], 'NODE_OPTIONS unrelated --inspect-brk')).toBe('inspector')
  })

  it('does not false-positive on unrelated argv tokens', () => {
    expect(detectedDebugger(undefined, ['--enable-source-maps'], '')).toBeNull()
    expect(detectedDebugger(undefined, ['/path/to/inspect-tool.js'], '')).toBeNull()
    expect(detectedDebugger(undefined, [], '')).toBeNull()
  })

  it('does not fold into restartAllowed — explicit allowRestart stays true', () => {
    expect(restartAllowed({ allowRestart: true }, {}, 4242)).toBe(true)
    expect(detectedDebugger('ws://127.0.0.1:9229/uuid', [], '')).toBe('inspector')
  })
})

/**
 * A deployment that DECLARES the name it serves — `dsh web --trusted-host
 * dsh.example.com` — reaches its own market through a tunnel or a reverse
 * proxy: the peer is the proxy, not the user, and the Host is the declared
 * name.
 *
 * The fence used to refuse that shape as "not a same-origin loopback
 * request" while every ORDINARY route answered 200, because `sameOrigin`
 * already honoured the declaration (#729) and the privileged routes did not.
 * The visible effect was a deployment whose export, self-uninstall and
 * restart buttons were all dead, with an error naming a rule the user could
 * not satisfy — the user has no way to make the tunnel's peer loopback.
 */
describe('a declared authority is this deployment\'s own authority', () => {
  const previousSources: Array<() => readonly string[]> = []
  const declare = (...entries: string[]): void => {
    previousSources.push(setTrustedHostsSource(() => entries))
  }
  afterEach(() => {
    while (previousSources.length > 0) setTrustedHostsSource(previousSources.pop()!)
  })

  const req = (headers: Record<string, string>, remoteAddress = '127.0.0.1') =>
    ({ headers, socket: { remoteAddress } }) as unknown as Parameters<typeof trustedDownloadRequest>[0]
  // The shape a tunnel delivers: the peer is the proxy's own address, the
  // forwarding trace is present, and the Host is the public name.
  const tunnel = { host: 'dsh.example.com', 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9' }
  const peer = '10.88.0.1'

  it('lets the backup export through the declared name', () => {
    declare('dsh.example.com')
    // A download navigation carries no Origin — the normal shape of the
    // button that asks for it.
    expect(trustedDownloadRequest(req(tunnel, peer))).toBe(true)
    // A fetch-style request carries one, and it has to name this authority.
    expect(trustedDownloadRequest(req({ ...tunnel, origin: 'https://dsh.example.com' }, peer))).toBe(true)
  })

  it('still refuses a foreign name, however it arrives', () => {
    declare('dsh.example.com')
    expect(trustedDownloadRequest(req({ ...tunnel, host: 'evil.example.com' }, peer))).toBe(false)
    expect(trustedDownloadRequest(req({ host: 'evil.example.com' }))).toBe(false)
    // A declared neighbour is not a wildcard: the trust is the exact name.
    expect(trustedDownloadRequest(req({ ...tunnel, host: 'other.example.com' }, peer))).toBe(false)
  })

  it('still refuses a cross-origin reader of the export', () => {
    declare('dsh.example.com')
    expect(trustedDownloadRequest(req({ ...tunnel, origin: 'https://evil.example.com' }, peer))).toBe(false)
    expect(trustedDownloadRequest(req({ ...tunnel, origin: 'not a url' }, peer))).toBe(false)
    // `Origin: null` is a present-but-unparseable origin, not an absent one.
    expect(trustedDownloadRequest(req({ ...tunnel, origin: 'null' }, peer))).toBe(false)
  })

  it('still refuses a browser that labels the request cross-site', () => {
    declare('dsh.example.com')
    expect(trustedDownloadRequest(req({ ...tunnel, 'sec-fetch-site': 'cross-site' }, peer))).toBe(false)
  })

  it('keeps the loopback Host on the direct path — a remote peer cannot borrow it', () => {
    // The lane deployments declare `127.0.0.1` next to their public name; a
    // loopback Host still has to arrive from a loopback peer.
    declare('dsh.example.com', '127.0.0.1')
    expect(trustedDownloadRequest(req({ host: '127.0.0.1:3080' }, peer))).toBe(false)
    expect(trustedDownloadRequest(req({ host: '127.0.0.1:3080' }))).toBe(true)
  })

  it('lets a same-origin restart through the declared name', () => {
    declare('dsh.example.com')
    expect(trustedRestartRequest(req({ ...tunnel, origin: 'https://dsh.example.com' }, peer))).toBe(true)
    expect(trustedSelfUninstallRequest(req({ ...tunnel, origin: 'https://dsh.example.com' }, peer))).toBe(true)
    expect(restartReachableFrom(req(tunnel, peer))).toBe(true)
    expect(selfUninstallReachableFrom(req(tunnel, peer))).toBe(true)
  })

  it('refuses a restart whose Origin names another authority', () => {
    declare('dsh.example.com')
    expect(trustedRestartRequest(req({ ...tunnel, origin: 'https://evil.example.com' }, peer))).toBe(false)
    // Process control always carries an Origin.
    expect(trustedRestartRequest(req(tunnel, peer))).toBe(false)
  })

  it('refuses a restart on a foreign name', () => {
    declare('dsh.example.com')
    expect(trustedRestartRequest(req({ ...tunnel, host: 'evil.example.com', origin: 'https://evil.example.com' }, peer))).toBe(false)
    expect(restartReachableFrom(req({ ...tunnel, host: 'evil.example.com' }, peer))).toBe(false)
  })

  it('refuses everything when the host declares nothing', () => {
    declare()
    expect(trustedDownloadRequest(req(tunnel, peer))).toBe(false)
    expect(trustedRestartRequest(req({ ...tunnel, origin: 'https://dsh.example.com' }, peer))).toBe(false)
    expect(restartReachableFrom(req(tunnel, peer))).toBe(false)
  })

  it('never says yes where the route would say no — one-directional by construction', () => {
    declare('dsh.example.com')
    const peers = ['127.0.0.1', '::1', '10.88.0.1']
    const hosts: Array<string | undefined> = ['127.0.0.1:3080', 'localhost:3080', 'dsh.example.com', 'evil.example.com', undefined]
    const origins: Array<string | undefined> = [undefined, 'https://dsh.example.com', 'https://evil.example.com', 'not a url']
    const forwards: Array<Record<string, string>> = [{}, { 'x-forwarded-for': '1.2.3.4' }, { forwarded: 'for=1.2.3.4' }, { 'x-real-ip': '1.2.3.4' }]
    let checked = 0
    for (const peerAddress of peers) for (const host of hosts) for (const origin of origins) for (const forward of forwards) {
      const headers: Record<string, string> = { ...forward }
      if (host !== undefined) headers.host = host
      if (origin !== undefined) headers.origin = origin
      const request = req(headers, peerAddress)
      if (trustedRestartRequest(request)) expect(restartReachableFrom(request), JSON.stringify({ peerAddress, headers })).toBe(true)
      // Whatever the download fence accepts, the request came in under an
      // authority this deployment serves: a loopback one, or a declared one.
      if (trustedDownloadRequest(request)) {
        expect(servedAuthorityOf(headers.host), JSON.stringify({ peerAddress, headers })).toBe(true)
      }
      checked += 1
    }
    expect(checked).toBe(peers.length * hosts.length * origins.length * forwards.length)
  })
})

/** The authorities the deployment serves: loopback, or the declared name. */
function servedAuthorityOf(host: string | undefined): boolean {
  if (host === undefined) return false
  return host === '127.0.0.1:3080' || host === 'localhost:3080' || host === 'dsh.example.com'
}
