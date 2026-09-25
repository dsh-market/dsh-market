/**
 * The origin fence (#678, #729).
 *
 * Two jobs, and they pull against each other: refuse a page that is not ours
 * (DNS rebinding sends a matching Origin/Host pair, so the Host authority is
 * the only thing that decides), and accept the deployment's OWN names —
 * `dsh web --trusted-host`, a reverse proxy, a LAN name — which DSH publishes
 * to its plugins and which the market, registering `exact` routes on the bare
 * webServer, cannot inherit from DSH's `/api` fence.
 *
 * The pair of tests that matter are "undeclared name refused" and "declared
 * name accepted": dropping the first makes the fence useless, dropping the
 * second makes every write 403 on a proxied deployment, which is #729.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { sameOrigin, setTrustedHostsSource } from '../src/http.ts'

const request = (headers: Record<string, string>) => ({ headers }) as never
const previousSources: Array<() => readonly string[]> = []
/** The setter returns the previous SOURCE (the dsh-cli.ts contract), not a restore closure. */
const declare = (...entries: string[]): void => { previousSources.push(setTrustedHostsSource(() => entries)) }
afterEach(() => {
  while (previousSources.length > 0) setTrustedHostsSource(previousSources.pop()!)
})

describe('sameOrigin', () => {
  it('accepts loopback with no declaration at all', () => {
    expect(sameOrigin(request({ host: '127.0.0.1:3081', origin: 'http://127.0.0.1:3081' }))).toBe(true)
    expect(sameOrigin(request({ host: 'localhost:3080' }))).toBe(true)
  })

  it('refuses a name nobody declared — the rebinding defence', () => {
    // The reported repro: a page on the deployment's own name is exactly what
    // an attacker's page looks like, so this stays refused until the operator
    // has said the name is theirs.
    expect(sameOrigin(request({ host: 'dsh.example.org', origin: 'https://dsh.example.org' }))).toBe(false)
  })

  it('accepts the deployment name the host declared', () => {
    declare('dsh.example.org')
    expect(sameOrigin(request({ host: 'dsh.example.org', origin: 'https://dsh.example.org' }))).toBe(true)
    // A port-less entry matches any port: that is the shape the CLI derives
    // for IP-literal LAN serving, where the bound port may be OS-assigned.
    expect(sameOrigin(request({ host: 'dsh.example.org:8443', origin: 'https://dsh.example.org:8443' }))).toBe(true)
  })

  it('keeps an explicit-port entry to that exact authority', () => {
    declare('dsh.example.org:8443')
    expect(sameOrigin(request({ host: 'dsh.example.org:8443', origin: 'https://dsh.example.org:8443' }))).toBe(true)
    expect(sameOrigin(request({ host: 'dsh.example.org:9999', origin: 'https://dsh.example.org:9999' }))).toBe(false)
  })

  it('still refuses a declared authority used from another origin', () => {
    declare('dsh.example.org')
    expect(sameOrigin(request({ host: 'dsh.example.org', origin: 'https://evil.example' }))).toBe(false)
  })

  it('refuses what the browser calls cross-site, declaration or not', () => {
    declare('dsh.example.org')
    expect(sameOrigin(request({ host: 'dsh.example.org', 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(sameOrigin(request({ host: '127.0.0.1:3081', 'sec-fetch-site': 'cross-site' }))).toBe(false)
  })

  it('refuses a malformed declaration rather than matching loosely', () => {
    declare('dsh.example.org/path', 'not a host')
    expect(sameOrigin(request({ host: 'dsh.example.org' }))).toBe(false)
  })

  it('goes back to loopback-only when the source is put back', () => {
    const previous = setTrustedHostsSource(() => ['dsh.example.org'])
    expect(sameOrigin(request({ host: 'dsh.example.org' }))).toBe(true)
    setTrustedHostsSource(previous)
    expect(sameOrigin(request({ host: 'dsh.example.org' }))).toBe(false)
  })
})
