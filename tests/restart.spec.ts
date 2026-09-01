/**
 * #40: the one-click restart must not leave the replacement host
 * console-less on Windows. A `detached` spawn maps to DETACHED_PROCESS (no
 * console at all), after which every console child the host spawns (e.g.
 * DSH sandbox tool runners) pops a visible window. The fix: launch the
 * replacement through `powershell -WindowStyle Hidden`, which gives it a
 * HIDDEN console that children inherit. POSIX keeps the plain detached
 * spawn (process groups, no console concept).
 */

import { describe, expect, it } from 'vitest'
import { detectedDebugger, detectedSupervisor, respawnInvocation, restartAllowed, trustedDownloadRequest, trustedRestartRequest } from '../src/restart.ts'

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
    expect(detectedSupervisor({ INVOCATION_ID: 'abc123' }, 4242)).toBeNull()
    expect(detectedSupervisor({ JOURNAL_STREAM: '8:12345' }, 4242)).toBeNull()
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
