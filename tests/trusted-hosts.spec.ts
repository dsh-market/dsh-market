/**
 * Deployment-authority specs — src/trusted-hosts.ts.
 *
 * The mutation fence has to accept the authorities DSH itself serves, because
 * behind a reverse proxy that is the only Host the browser ever sends
 * (`dsh web --trusted-host <name>` + `proxy_set_header Host $http_host`).
 * Without them every install, update and uninstall answered 403
 * `untrusted origin` while every read kept working (#678 follow-up).
 *
 * These specs pin what counts as a declaration, what is refused instead of
 * being narrowed into a grant, and what a host that publishes nothing leaves
 * behind — the loopback-only fence unchanged.
 */

import { describe, expect, it } from 'vitest'
import { authorityParts, resolveTrustedHosts, trustedAuthorities } from '../src/trusted-hosts.ts'

describe('authorityParts', () => {
  it('splits a bare host or host:port', () => {
    expect(authorityParts('dsh.example.org')).toEqual({ host: 'dsh.example.org', port: '' })
    expect(authorityParts('192.168.0.194:3080')).toEqual({ host: '192.168.0.194', port: '3080' })
    expect(authorityParts('[::1]:3080')).toEqual({ host: '[::1]', port: '3080' })
    // WHATWG lowercases the hostname, and a declared name is compared that way.
    expect(authorityParts('DSH.Example.ORG')).toEqual({ host: 'dsh.example.org', port: '' })
    // Surrounding whitespace cannot change which authority is named.
    expect(authorityParts('  dsh.example.org  ')).toEqual({ host: 'dsh.example.org', port: '' })
  })

  it('refuses what parsing would rewrite, rather than narrowing it into a grant', () => {
    for (const entry of [
      'harness.internal/path', // a path is not an authority
      'user@harness.internal', // would grant the hostname buried inside it
      'example.com:080', // zero-padded port would widen an exact-port grant
      'example.com:', // dangling colon: no port at all
      '0x7f.0.0.1', // non-canonical IP spelling
      '::1', // unbracketed IPv6
      'exa mple.com',
      '',
      '   ',
    ]) {
      expect(authorityParts(entry), entry).toBeNull()
    }
  })
})

describe('trustedAuthorities', () => {
  it('trims, deduplicates case-insensitively, and keeps declaration order', () => {
    expect(trustedAuthorities([' b.example ', 'a.example', 'B.EXAMPLE', 'a.example'])).toEqual({
      authorities: ['b.example', 'a.example'],
      rejected: [],
    })
  })

  it('reports entries it refused instead of granting them', () => {
    // A typo that silently granted nothing would be indistinguishable from a
    // fence that is still loopback-only, so refused entries come back out.
    expect(trustedAuthorities(['good.example', 'evil.example/path', '', 42])).toEqual({
      authorities: ['good.example'],
      rejected: ['evil.example/path', '', '42'],
    })
  })
})

describe('resolveTrustedHosts', () => {
  it('reads the host service that carries the --trusted-host list', () => {
    // The shape @deepseek-ai/dsh-web-app publishes on `webRuntime`: the LAN
    // literals it derived, then the operator's own --trusted-host entries.
    const service = { lanAddresses: ['192.168.0.194'], trustedHosts: ['192.168.0.194', 'dsh.example.org'] }
    expect(resolveTrustedHosts(service).authorities).toEqual(['192.168.0.194', 'dsh.example.org'])
  })

  it("unions the market's own config with the host's, host list first", () => {
    expect(resolveTrustedHosts({ trustedHosts: ['dsh.example.org'] }, ['extra.example']).authorities)
      .toEqual(['dsh.example.org', 'extra.example'])
    expect(resolveTrustedHosts(undefined, ['extra.example']).authorities).toEqual(['extra.example'])
  })

  it('contributes nothing — leaving the loopback-only fence — when the host publishes none', () => {
    for (const source of [undefined, null, {}, { trustedHosts: undefined }, { trustedHosts: 'dsh.example.org' }, 7]) {
      expect(resolveTrustedHosts(source).authorities, `source ${JSON.stringify(source)}`).toEqual([])
    }
  })
})
