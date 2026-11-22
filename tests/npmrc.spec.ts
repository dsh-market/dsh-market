/**
 * Private npm registries from `.npmrc`: parsing, which registry a package
 * goes to, which requests carry a credential, and that the market's fetch
 * actually sends it. Nothing here touches a real network.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const undici = vi.hoisted(() => ({
  fetch: vi.fn(async (_url: unknown, _init?: { headers?: Record<string, string> }) => new Response('{}', { status: 200 })),
  EnvHttpProxyAgent: vi.fn(function (this: unknown) { return {} }),
  Agent: vi.fn(function (this: unknown) { return {} }),
}))
vi.mock('undici', () => undici)

import { marketFetch } from '../src/net.ts'
import {
  authorizationFor, authorizationIn, currentNpmrc, mergeNpmrc, nerfDart, parseNpmrc, registryFor, registryIn,
  setNpmrcHome, setNpmrcProfileDir,
} from '../src/npmrc.ts'
import { fetchNpmLatest } from '../src/updates.ts'

describe('parseNpmrc', () => {
  it('reads scoped registries, ignoring comments, blanks and the unscoped registry', () => {
    const config = parseNpmrc([
      '# a comment', '; another', '',
      'registry=https://registry.npmmirror.com/',
      '@acme:registry=https://npm.acme.internal/',
      '@Other:registry="https://npm.other.example/repo/"',
      'strict-ssl=false',
    ].join('\n'))
    expect([...config.scopes]).toEqual([
      ['@acme', 'https://npm.acme.internal'],
      ['@other', 'https://npm.other.example/repo'],
    ])
  })

  it('reads _authToken, _auth, and username with a base64 _password', () => {
    const config = parseNpmrc([
      '//npm.acme.internal/:_authToken=tok-123',
      '//basic.example/repo/:_auth=dXNlcjpwYXNz',
      '//pw.example:8443/:username=alice',
      `//pw.example:8443/:_password=${Buffer.from('s3cret').toString('base64')}`,
    ].join('\r\n'))
    expect(config.credentials.get('//npm.acme.internal/')?.header).toBe('Bearer tok-123')
    expect(config.credentials.get('//basic.example/repo/')?.header).toBe('Basic dXNlcjpwYXNz')
    expect(config.credentials.get('//pw.example:8443/')?.header).toBe(`Basic ${Buffer.from('alice:s3cret').toString('base64')}`)
  })

  it('prefers a token over the other forms for the same registry', () => {
    const config = parseNpmrc('//h/:_auth=YTpi\n//h/:_authToken=T')
    expect(config.credentials.get('//h/')?.header).toBe('Bearer T')
  })

  it('expands ${ENV} the way npm does, and drops a line whose variable is not set', () => {
    const config = parseNpmrc([
      '//npm.acme.internal/:_authToken=${ACME_TOKEN}',
      '//gone.example/:_authToken=${NOT_SET}',
      '@acme:registry=${ACME_REGISTRY}',
    ].join('\n'), { ACME_TOKEN: 'from-env', ACME_REGISTRY: 'https://npm.acme.internal/' })
    expect(config.credentials.get('//npm.acme.internal/')?.header).toBe('Bearer from-env')
    expect(config.credentials.has('//gone.example/')).toBe(false)
    expect(config.scopes.get('@acme')).toBe('https://npm.acme.internal')
    expect(config.missingEnv).toEqual(['NOT_SET'])
  })

  it('ignores a registry that is not an http(s) URL', () => {
    expect(parseNpmrc('@x:registry=file:///tmp/r\n@y:registry=nonsense').scopes.size).toBe(0)
  })
})

describe('which registry a package goes to', () => {
  const config = parseNpmrc('@acme:registry=https://npm.acme.internal/\n')
  it('sends a scoped package to its scope and everything else to the default', () => {
    expect(registryIn(config, '@acme/plugin', 'https://registry.npmjs.org')).toBe('https://npm.acme.internal')
    expect(registryIn(config, '@ACME/plugin', 'https://registry.npmjs.org')).toBe('https://npm.acme.internal')
    expect(registryIn(config, '@other/plugin', 'https://registry.npmjs.org')).toBe('https://registry.npmjs.org')
    expect(registryIn(config, 'plain', 'https://mirror.example/npm/')).toBe('https://mirror.example/npm')
  })

  it('lets the profile .npmrc override ~/.npmrc per key', () => {
    const merged = mergeNpmrc(
      parseNpmrc('@acme:registry=https://user.example/\n@keep:registry=https://keep.example/\n//user.example/:_authToken=U'),
      parseNpmrc('@acme:registry=https://profile.example/\n//profile.example/:_authToken=P'),
    )
    expect(merged.scopes.get('@acme')).toBe('https://profile.example')
    expect(merged.scopes.get('@keep')).toBe('https://keep.example')
    expect(registryIn(merged, '@acme/x', 'https://d')).toBe('https://profile.example')
  })
})

describe('which requests carry a credential', () => {
  const config = parseNpmrc([
    '@acme:registry=https://npm.acme.internal/repository/npm/',
    '//npm.acme.internal/repository/npm/:_authToken=scoped-token',
    '//registry.npmjs.org/:_authToken=publish-token',
    '//npm.acme.internal/:_authToken=host-wide-token',
  ].join('\n'))

  it('matches the longest registry prefix, for metadata and tarballs alike', () => {
    expect(authorizationIn(config, 'https://npm.acme.internal/repository/npm/@acme%2Fplug')).toBe('Bearer scoped-token')
    expect(authorizationIn(config, 'https://npm.acme.internal/repository/npm/@acme/plug/-/plug-1.0.0.tgz')).toBe('Bearer scoped-token')
  })

  it('never attaches a credential to a registry no scope points at', () => {
    // A publish token for the public registry must not ride along on the
    // market's metadata reads just because it is in ~/.npmrc.
    expect(authorizationIn(config, 'https://registry.npmjs.org/dsh-loop')).toBeNull()
    expect(authorizationIn(config, 'https://npm.acme.internal/other-path/x')).toBeNull()
    expect(authorizationIn(config, 'https://evil.example/repository/npm/x')).toBeNull()
  })

  it('does nothing without a scoped registry', () => {
    expect(authorizationIn(parseNpmrc('//registry.npmjs.org/:_authToken=t'), 'https://registry.npmjs.org/x')).toBeNull()
  })

  it('computes the nerf-dart form npm keys credentials by', () => {
    expect(nerfDart('https://h.example:8443/a/b')).toBe('//h.example:8443/a/b/')
    expect(nerfDart('https://h.example')).toBe('//h.example/')
    expect(nerfDart('not a url')).toBeNull()
  })
})

describe('on disk: profile .npmrc over ~/.npmrc', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dshm-npmrc-'))
    mkdirSync(join(tmp, 'home'))
    mkdirSync(join(tmp, 'profile'))
    // `npx`/`npm run` export the CALLER's userconfig; the home under test must win.
    vi.stubEnv('npm_config_userconfig', '')
    vi.stubEnv('NPM_CONFIG_USERCONFIG', '')
    setNpmrcHome(join(tmp, 'home'))
    setNpmrcProfileDir(join(tmp, 'profile'))
    undici.fetch.mockClear()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    setNpmrcHome(null)
    setNpmrcProfileDir(null)
    rmSync(tmp, { recursive: true, force: true })
  })

  it('resolves a scope from ~/.npmrc, then lets the profile change it', () => {
    writeFileSync(join(tmp, 'home', '.npmrc'), '@acme:registry=https://home.example/\n')
    expect(registryFor('@acme/p', 'https://registry.npmjs.org')).toBe('https://home.example')
    writeFileSync(join(tmp, 'profile', '.npmrc'), '@acme:registry=https://profile.example/\n')
    // The file changed: a re-read happens once the recheck window has passed.
    expect(currentNpmrc(process.env, performance.now() + 10_000).scopes.get('@acme')).toBe('https://profile.example')
  })

  it('has no scopes when neither file exists', () => {
    expect(registryFor('@acme/p', 'https://registry.npmjs.org')).toBe('https://registry.npmjs.org')
    expect(authorizationFor('https://registry.npmjs.org/x')).toBeNull()
  })

  it('sends the credential on the market\'s own request, and leaves a caller-set Authorization alone', async () => {
    writeFileSync(join(tmp, 'profile', '.npmrc'), [
      '@acme:registry=https://npm.acme.internal/', '//npm.acme.internal/:_authToken=tok-xyz',
    ].join('\n'))
    await marketFetch('https://npm.acme.internal/%40acme%2Fplug/latest', { headers: { accept: 'application/json' } })
    expect(undici.fetch.mock.calls[0]![1]!.headers).toEqual({ accept: 'application/json', authorization: 'Bearer tok-xyz' })
    await marketFetch('https://npm.acme.internal/x', { headers: { Authorization: 'Bearer mine' } })
    expect(undici.fetch.mock.calls[1]![1]!.headers).toEqual({ Authorization: 'Bearer mine' })
    await marketFetch('https://registry.npmjs.org/dsh-loop')
    expect(undici.fetch.mock.calls[2]![1]!.headers).toBeUndefined()
  })

  it('asks a scoped package\'s own registry for its latest version, with its credential', async () => {
    writeFileSync(join(tmp, 'profile', '.npmrc'), [
      '@acme:registry=https://npm.acme.internal/', '//npm.acme.internal/:_authToken=tok-xyz',
    ].join('\n'))
    undici.fetch.mockImplementation(async () => new Response(JSON.stringify({ version: '2.3.4' }), { status: 200 }))
    expect(await fetchNpmLatest('@acme/plug')).toBe('2.3.4')
    const [url, init] = undici.fetch.mock.calls[0]!
    expect(String(url)).toBe('https://npm.acme.internal/%40acme%2Fplug/latest')
    expect(init!.headers!.authorization).toBe('Bearer tok-xyz')
    await fetchNpmLatest('plain-pkg')
    expect(String(undici.fetch.mock.calls[1]![0])).toMatch(/^https:\/\/registry\.npmjs\.org\/plain-pkg\//)
    expect(undici.fetch.mock.calls[1]![1]!.headers!.authorization).toBeUndefined()
  })
})
