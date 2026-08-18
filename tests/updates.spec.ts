/**
 * Version-direction unit tests for update detection (#64).
 *
 * The reported failure: `@deepseek-ai/dsh-web-fetch-http` was pinned at
 * 0.1.0-rc.6 while the registry's `latest` dist-tag was still on the first
 * release, 0.0.1-rc.5. Detection compared with `!==`, so the older tag read
 * as "an update", and applying it downgraded the profile until it wouldn't
 * boot. Direction — not inequality — is what decides.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkUpdates, compareVersions, isUpgrade } from '../src/updates.ts'

describe('compareVersions', () => {
  it('orders by major, minor, then patch', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0)
    expect(compareVersions('1.2.3', '1.2.10')).toBeLessThan(0)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('compares numerically, not lexically', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0)
  })

  it('ranks a release above any prerelease of the same core', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
  })

  it('orders prerelease identifiers per semver precedence', () => {
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc')).toBeGreaterThan(0)
    // Numeric identifiers rank below alphanumeric ones.
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
  })

  it('reproduces the precedence chain from the semver spec', () => {
    const ordered = [
      '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta',
      '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0',
    ]
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareVersions(ordered[i], ordered[i + 1])).toBeLessThan(0)
      expect(compareVersions(ordered[i + 1], ordered[i])).toBeGreaterThan(0)
    }
  })

  it('ignores build metadata', () => {
    expect(compareVersions('1.2.3+build.5', '1.2.3')).toBe(0)
  })

  it('returns null when either side is not plain semver', () => {
    expect(compareVersions('^1.2.3', '1.2.3')).toBeNull()
    expect(compareVersions('1.2', '1.2.3')).toBeNull()
    expect(compareVersions('latest', '1.2.3')).toBeNull()
  })
})

describe('isUpgrade', () => {
  it('reports an upgrade only when latest is genuinely newer', () => {
    expect(isUpgrade('1.0.0', '1.2.0')).toBe(true)
    expect(isUpgrade('1.0.0-rc.1', '1.0.0')).toBe(true)
  })

  it('does not treat an equal version as an update', () => {
    expect(isUpgrade('1.2.0', '1.2.0')).toBe(false)
  })

  it('does not treat a LOWER latest dist-tag as an update (#64)', () => {
    // The exact versions from the report.
    expect(isUpgrade('0.1.0-rc.6', '0.0.1-rc.5')).toBe(false)
    expect(isUpgrade('2.0.0', '1.9.9')).toBe(false)
  })

  it('reports no update when a version is missing or undecidable', () => {
    expect(isUpgrade(null, '1.2.0')).toBe(false)
    expect(isUpgrade('1.0.0', null)).toBe(false)
    expect(isUpgrade('not-a-version', '1.2.0')).toBe(false)
  })
})

/**
 * checkUpdates itself — the resolution around those comparisons. Only the
 * pure helpers above had unit coverage; the github branch (pinned commit vs
 * the repo's HEAD) reached the suite solely through whole-route flow tests,
 * where a mutation could drop the sha check or invert the availability
 * condition and nothing failed.
 *
 * Getting this wrong is not cosmetic: a plugin that reads "up to date" when
 * it is not never surfaces its fix, and one that always claims an update
 * makes the button lie on every poll.
 */
describe('checkUpdates — github pins', () => {
  const HEAD = 'a'.repeat(40)
  const OLD = 'b'.repeat(40)
  let home: string

  /** Profile with one github-installed plugin pinned at `commit`. */
  function profileWith(spec: string, commit: string | null): string {
    const dir = join(mkdtempSync(join(tmpdir(), 'dshm-upd-')), 'profiles', 'web')
    mkdirSync(join(dir, 'node_modules', 'themer'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { themer: spec } }))
    writeFileSync(join(dir, 'node_modules', 'themer', 'package.json'), JSON.stringify({ name: 'themer', version: '1.0.0' }))
    writeFileSync(join(dir, 'pnpm-lock.yaml'), commit === null ? 'lockfileVersion: 9\n'
      : `  resolution: {tarball: https://codeload.github.com/owner/themer/tar.gz/${commit}}\n`)
    return dir
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dshm-updhome-'))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ sha: HEAD }),
    })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(home, { recursive: true, force: true })
  })

  it('flags an update when the pinned commit differs from HEAD', async () => {
    const result = await checkUpdates('web', true, profileWith('github:owner/themer', OLD))
    expect(result.themer).toMatchObject({ kind: 'github', current: OLD, latest: HEAD, updateAvailable: true })
  })

  it('reports no update when the pin already IS HEAD', async () => {
    const result = await checkUpdates('web', true, profileWith('github:owner/themer', HEAD))
    expect(result.themer).toMatchObject({ current: HEAD, latest: HEAD, updateAvailable: false })
  })

  it('claims no update when the pin is unknown — an unknown is not a difference', async () => {
    // No lockfile entry: `current` is null. Reporting an update here would
    // offer a reinstall the user cannot evaluate.
    const result = await checkUpdates('web', true, profileWith('github:owner/themer', null))
    expect(result.themer).toMatchObject({ current: null, latest: HEAD, updateAvailable: false })
  })

  it('claims no update when the API answers without a usable sha', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })))
    expect(await checkUpdates('web', true, profileWith('github:owner/themer', OLD)))
      .toMatchObject({ themer: { latest: null, updateAvailable: false } })

    // A sha of the wrong TYPE is the case a truthiness check would let
    // through: it is not a commit, so it cannot mean "newer".
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ sha: 12345 }) })))
    expect(await checkUpdates('web', true, profileWith('github:owner/themer', OLD)))
      .toMatchObject({ themer: { latest: null, updateAvailable: false } })
  })

  it('treats a bare owner/repo spec as npm, not as a github pin', async () => {
    // pnpm accepts the shorthand, and it parses as a repo — but without the
    // `github:` prefix the package came from the registry, so asking GitHub
    // for a HEAD commit would compare two unrelated things.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ version: '1.0.0' }) })))
    const result = await checkUpdates('web', true, profileWith('owner/themer', OLD))
    expect(result.themer).toMatchObject({ kind: 'npm' })
  })

  it('never offers an update for a linked or file: dependency', async () => {
    for (const spec of ['link:../themer', 'file:/tmp/themer.tgz']) {
      const result = await checkUpdates('web', true, profileWith(spec, OLD))
      expect(result.themer, spec).toMatchObject({ kind: 'linked', updateAvailable: false })
    }
  })
})

describe('preferBeta (release channel)', () => {
  it('offers the prerelease only when it is actually newer', async () => {
    // The trap: a `beta` dist-tag is NOT automatically ahead. Once 1.14.0
    // ships, `beta` still points at 1.14.0-beta.1 until someone publishes the
    // next prerelease — and offering that as an update walks a subscriber
    // backwards, which is the opposite of what opting in asked for.
    //
    // This is why a channel is a SET rather than a tag: beta means
    // {latest, beta} and you get the newest of them, so a lagging beta tag
    // never drags anyone back.
    const { versionOnChannel } = await import('../src/updates.ts')
    const answer = (beta: string | null) => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
        JSON.stringify(beta === null ? {} : { version: beta }), { status: 200 },
      ))))
      return versionOnChannel('dshmarket', 'beta', '1.14.0')
    }
    await expect(answer('1.15.0-beta.1')).resolves.toBe('1.15.0-beta.1') // ahead → take it
    await expect(answer('1.14.0-beta.1')).resolves.toBe('1.14.0')        // behind → keep stable
    await expect(answer(null)).resolves.toBe('1.14.0')                   // none published yet
  })

  it('falls back to stable when the beta tag cannot be read', async () => {
    // A package with no beta tag 404s, which is the ordinary case, not an
    // error worth failing the whole update check over.
    const { versionOnChannel } = await import('../src/updates.ts')
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('HTTP 404'))))
    await expect(versionOnChannel('dshmarket', 'beta', '1.14.0')).resolves.toBe('1.14.0')
    // ...and with nothing on either side it stays honest about knowing nothing.
    await expect(versionOnChannel('dshmarket', 'beta', null)).resolves.toBeNull()
  })

  it('the stable channel is exactly latest, which is what makes it leavable', async () => {
    // The narrow end of the nesting. On stable the beta tag is not in the
    // set at all, so an installed prerelease is simply not what the channel
    // points at — and THAT is the difference the market can act on. Reading
    // "newest available" here instead would keep answering "up to date" and
    // the user could never get back off beta.
    const { versionOnChannel } = await import('../src/updates.ts')
    const fetchSpy = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ version: '9.9.9-beta.1' }), { status: 200 })))
    vi.stubGlobal('fetch', fetchSpy)
    await expect(versionOnChannel('dshmarket', 'stable', '1.13.1')).resolves.toBe('1.13.1')
    expect(fetchSpy, 'the stable channel asked about a tag outside its own set').not.toHaveBeenCalled()
  })

  it('the dev channel takes the newest of latest, beta and dev', async () => {
    const { versionOnChannel } = await import('../src/updates.ts')
    const at: Record<string, string> = { beta: '1.14.0-beta.9', dev: '1.15.0-dev.20260818-abc1234' }
    vi.stubGlobal('fetch', vi.fn((url: unknown) => {
      const tag = String(url).split('/').pop() ?? ''
      return Promise.resolve(new Response(JSON.stringify({ version: at[tag] }), { status: 200 }))
    }))
    await expect(versionOnChannel('dshmarket', 'dev', '1.13.1')).resolves.toBe('1.15.0-dev.20260818-abc1234')

    // ...and a dev tag left behind by a merged branch must not drag anyone
    // back either — the same rule that protects beta subscribers.
    at.dev = '1.12.0-dev.20260101-0000000'
    await expect(versionOnChannel('dshmarket', 'dev', '1.13.1')).resolves.toBe('1.14.0-beta.9')
  })
})

describe('checkUpdates — the channel is part of the cache key', () => {
  it('re-resolves when the beta opt-in changes, without waiting out the TTL', async () => {
    // The listing is cached per profile for minutes. The channel can change
    // WITHOUT the route that clears that cache: the host's own settings page
    // writes MarketSettings directly, and `onChange` updates the resolved
    // config in place. Keyed on the profile alone, the market would keep
    // answering for the previous channel until the TTL expired — a setting
    // that appears to do nothing, which is the hardest kind to report.
    const dir = join(mkdtempSync(join(tmpdir(), 'dshm-chan-')), 'profiles', 'web')
    mkdirSync(join(dir, 'node_modules', 'dshmarket'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { dshmarket: '^1.0.0' } }))
    writeFileSync(join(dir, 'node_modules', 'dshmarket', 'package.json'), JSON.stringify({ name: 'dshmarket', version: '1.0.0' }))

    const asked: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      asked.push(String(url))
      return { ok: true, status: 200, json: async () => ({ version: String(url).endsWith('/beta') ? '2.0.0-beta.1' : '1.5.0' }) }
    }))

    const stable = await checkUpdates('web', false, dir)
    expect(stable['dshmarket']?.latest).toBe('1.5.0')
    expect(asked.some(url => url.endsWith('/beta'))).toBe(false)

    asked.length = 0
    const beta = await checkUpdates('web', false, dir, new Map([['dshmarket', 'beta' as const]]))
    expect(asked.some(url => url.endsWith('/beta')), 'served the cached stable answer to a beta subscriber').toBe(true)
    expect(beta['dshmarket']?.latest).toBe('2.0.0-beta.1')

    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('updateAvailable means NEWER, and only that', () => {
  const bed = (installedVersion: string, tags: Record<string, string>) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'dshm-dir-')), 'profiles', 'web')
    mkdirSync(join(dir, 'node_modules', 'dshmarket'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { dshmarket: '^1.0.0' } }))
    writeFileSync(join(dir, 'node_modules', 'dshmarket', 'package.json'), JSON.stringify({ name: 'dshmarket', version: installedVersion }))
    vi.stubGlobal('fetch', vi.fn((url: unknown) => {
      const tag = String(url).split('/').pop() ?? ''
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ version: tags[tag] }) })
    }))
    return dir
  }

  it('reports a backwards move as a channel switch, never as an update', async () => {
    // Shipped broken for one build: `updateAvailable` was made true in BOTH
    // directions so the card could offer the way back off a channel. The
    // market page reads that flag in three places it was never taught about
    // — the header banner, "update all", and the row button — and every one
    // of them announced a downgrade as "a new version is available", on a
    // dev build whose own channel had nothing newer in it.
    const dir = bed('1.15.0-dev.202608181407-2fad14a', { latest: '1.13.1', beta: '1.14.0-beta.2' })
    try {
      const row = (await checkUpdates('web', true, dir, new Map([['dshmarket', 'stable' as const]])))['dshmarket']
      expect(row?.updateAvailable, 'a downgrade was reported as an update').toBe(false)
      expect(row?.channelSwitch).toBe('1.13.1')
    } finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('offers no switch when the channel already points at what is installed', async () => {
    const dir = bed('1.14.0-beta.2', { latest: '1.13.1', beta: '1.14.0-beta.2' })
    try {
      const row = (await checkUpdates('web', true, dir, new Map([['dshmarket', 'beta' as const]])))['dshmarket']
      expect(row?.updateAvailable).toBe(false)
      expect(row?.channelSwitch).toBeUndefined()
    } finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('still calls a genuine upgrade an update, with no switch alongside it', async () => {
    const dir = bed('1.13.1', { latest: '1.13.1', beta: '1.14.0-beta.2' })
    try {
      const row = (await checkUpdates('web', true, dir, new Map([['dshmarket', 'beta' as const]])))['dshmarket']
      expect(row?.updateAvailable).toBe(true)
      expect(row?.latest).toBe('1.14.0-beta.2')
      expect(row?.channelSwitch).toBeUndefined()
    } finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('never offers a switch for a package that does not follow a channel', async () => {
    // Only the market follows one. An ordinary plugin whose `latest` went
    // backwards is #64's case, and its answer is to refuse, not to offer.
    const dir = bed('2.0.0', { latest: '1.0.0' })
    try {
      const row = (await checkUpdates('web', true, dir))['dshmarket']
      expect(row?.updateAvailable).toBe(false)
      expect(row?.channelSwitch).toBeUndefined()
    } finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) }
  })
})
