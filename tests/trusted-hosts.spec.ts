/**
 * The wiring that feeds the origin fence (#729).
 *
 * `tests/http.spec.ts` covers the fence itself and `tests/flows.spec.ts` drives
 * real routes through it -- but both hand it its authorities with
 * `setTrustedHostsSource(...)` directly, so neither can see WHEN the market
 * reads them from the host. That is the whole bug: the read was correct and
 * landed too early.
 *
 * The host provides `connection` behind its own async init, so the market's
 * mount (`inject(['webServer', 'loader'])`) wins the race and the one read it
 * took saw `undefined`. The [] fallback then made "not asked yet" and "none
 * declared" the same fence, and every mutating route answered 403 on a
 * deployment reached by a name for the life of the process.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { sameOrigin } from '../src/http.ts'
import { useTrustedHosts } from '../src/index.ts'

const request = (host: string) => ({ headers: { host, origin: `https://${host}` } }) as never
const installed: Array<() => void> = []
afterEach(() => { while (installed.length > 0) installed.pop()!() })

/** A host context whose services arrive when the host's init finishes. */
function contextWith(services: Record<string, unknown>) {
  return { get: (name: string) => services[name] } as never
}

describe('the host authorities are read per request', () => {
  it('picks the service up when it arrives after the market mounted', () => {
    const services: Record<string, unknown> = {}
    installed.push(useTrustedHosts(contextWith(services)))

    // Mount time: the host has not published the service yet, so a name is not
    // yet ours and the rebinding defence stays where it was.
    expect(sameOrigin(request('dsh.example.org'))).toBe(false)

    // The host's init lands. Nothing tells the market; the next request decides.
    services.connection = { trustedHosts: ['dsh.example.org'] }
    expect(sameOrigin(request('dsh.example.org'))).toBe(true)
    expect(sameOrigin(request('still-undeclared.example.org'))).toBe(false)

    // And it keeps listening: a declaration that changes later is honoured too.
    services.connection = { trustedHosts: ['dsh.example.org:8443'] }
    expect(sameOrigin(request('dsh.example.org:8443'))).toBe(true)
    expect(sameOrigin(request('dsh.example.org'))).toBe(false)
  })

  it('falls back to loopback-only while the host has no such service', () => {
    const services: Record<string, unknown> = {}
    installed.push(useTrustedHosts(contextWith(services)))
    expect(sameOrigin(request('127.0.0.1:3081'))).toBe(true)
    expect(sameOrigin(request('dsh.example.org'))).toBe(false)
    // A host service that exists but carries nothing valid is the same answer.
    services.connection = { trustedHosts: 'dsh.example.org' }
    expect(sameOrigin(request('dsh.example.org'))).toBe(false)
  })

  it('goes back to the previous source when its effect is disposed', () => {
    const services: Record<string, unknown> = { connection: { trustedHosts: ['dsh.example.org'] } }
    const restore = useTrustedHosts(contextWith(services))
    expect(sameOrigin(request('dsh.example.org'))).toBe(true)
    restore()
    expect(sameOrigin(request('dsh.example.org'))).toBe(false)
  })
})

describe('the listener bind host is trusted, as the host fence does', () => {
  it('accepts the bind IP literal the webserver publishes, on any port', () => {
    const services: Record<string, unknown> = { webServer: { host: '100.126.218.120' } }
    installed.push(useTrustedHosts(contextWith(services)))

    // No connection service at all: the host's own fence still accepts the
    // bind address, and the market's must agree.
    expect(sameOrigin(request('100.126.218.120:3080'))).toBe(true)
    expect(sameOrigin(request('10.1.2.3:3080'))).toBe(false)

    // A later connection declaration widens, never narrows, the bind host.
    services.connection = { trustedHosts: ['dsh.example.org'] }
    expect(sameOrigin(request('100.126.218.120:3080'))).toBe(true)
    expect(sameOrigin(request('dsh.example.org'))).toBe(true)
    expect(sameOrigin(request('10.1.2.3:3080'))).toBe(false)
  })

  it('does not trust an all-interfaces bind literal an older host reports', () => {
    for (const host of ['0.0.0.0', '::']) {
      installed.push(useTrustedHosts(contextWith({ webServer: { host } })))
      expect(sameOrigin(request('0.0.0.0:3080'))).toBe(false)
      expect(sameOrigin(request('[::]:3080'))).toBe(false)
    }
  })

  it('normalizes the bind host like the host fence does', () => {
    const services: Record<string, unknown> = { webServer: { host: 'fe80::1%en0' } }
    installed.push(useTrustedHosts(contextWith(services)))
    // A browser dials the literal bracketed, on whatever port it bound.
    expect(sameOrigin(request('[fe80::1]:3080'))).toBe(true)
    // Another interface of the same machine is still a different authority.
    expect(sameOrigin(request('[fe80::2]:3080'))).toBe(false)
  })
})
