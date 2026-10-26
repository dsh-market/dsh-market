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
import { checkUpdates, compareVersions, fetchNpmLatest, isUpgrade, resolveDesktopMatureUpdate } from '../src/updates.ts'

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
describe('checkUpdates — fresh-release wait (#945)', () => {
  /** An npm-installed plugin in its own profile directory. */
  function npmProfile(windowMinutes?: number, name = 'widget'): string {
    const dir = join(mkdtempSync(join(tmpdir(), 'dshm-upd-')), 'profiles', 'web')
    mkdirSync(join(dir, 'node_modules', name), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { [name]: '^1.0.0' } }))
    writeFileSync(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: {} }))
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    if (windowMinutes !== undefined) writeFileSync(join(dir, 'pnpm-workspace.yaml'), `minimumReleaseAge: ${String(windowMinutes)}\nminimumReleaseAgeIgnoreMissingTime: false\n`)
    return dir
  }

  /** Registry answers: latest 1.1.0, published at `published`. */
  function registry(published: string | undefined, name = 'widget'): void {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const href = String(url)
      const body = href.endsWith(`/${encodeURIComponent(name)}/latest`)
        ? { version: '1.1.0' }
        : { 'dist-tags': { latest: '1.1.0' }, versions: { '1.0.0': {}, '1.1.0': {} },
            time: { '1.0.0': '2026-01-01T00:00:00.000Z', '1.1.0': published } }
      return new Response(JSON.stringify(body), { status: 200 })
    }))
  }

  const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString()

  it('holds an update the profile would refuse, and names when it opens (#945)', async () => {
    const dir = npmProfile(1440)
    registry(hoursAgo(1))
    const result = await checkUpdates('web', true, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })
    expect(result.widget?.updateAvailable).toBe(false)
    expect(result.widget?.latest).toBe('1.1.0')
    expect(result.widget?.heldUpdate?.latest).toBe('1.1.0')
    // 1 hour into a 24-hour window: about 23 hours left.
    const left = Date.parse(result.widget!.heldUpdate!.until) - Date.now()
    expect(left).toBeGreaterThan(22.5 * 3_600_000)
    expect(left).toBeLessThan(23.5 * 3_600_000)
  })

  it('holds a version the mirror has not timestamped yet, and marks the hold estimated (#961)', async () => {
    // Mid-sync: /latest already answers 1.1.0, the packument still has no
    // time['1.1.0']. Reading that as "old enough" let a 13-minute-old release
    // through the gate #945 built, and on the official Desktop the click could
    // only fail.
    const dir = npmProfile(1440)
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const href = String(url)
      const body = href.endsWith('/widget/latest')
        ? { version: '1.1.0' }
        : { 'dist-tags': { latest: '1.0.0' }, time: { '1.0.0': '2026-01-01T00:00:00.000Z' } }
      return new Response(JSON.stringify(body), { status: 200 })
    }))
    const result = await checkUpdates('web', true, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })
    expect(result.widget?.updateAvailable).toBe(false)
    expect(result.widget?.heldUpdate?.estimated).toBe(true)
    const left = Date.parse(result.widget!.heldUpdate!.until) - Date.now()
    // Bounded, not the full 24 hours: the next poll recomputes from the real
    // timestamp once the mirror catches up.
    expect(left).toBeGreaterThan(25 * 60_000)
    expect(left).toBeLessThan(31 * 60_000)
  })

  it('retries the packument before calling the age unknown (#961)', async () => {
    const dir = npmProfile(1440)
    let packuments = 0
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const href = String(url)
      if (href.endsWith('/widget/latest')) return new Response(JSON.stringify({ version: '1.1.0' }), { status: 200 })
      packuments++
      const body = packuments === 1
        ? { 'dist-tags': { latest: '1.1.0' }, versions: { '1.0.0': {}, '1.1.0': {} },
            time: { '1.0.0': '2026-01-01T00:00:00.000Z' } }
        : { 'dist-tags': { latest: '1.1.0' }, versions: { '1.0.0': {}, '1.1.0': {} },
            time: { '1.1.0': hoursAgo(1) } }
      return new Response(JSON.stringify(body), { status: 200 })
    }))
    const result = await checkUpdates('web', true, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })
    expect(packuments).toBe(2)
    // The second answer is the real one: a normal held window, not an estimate.
    expect(result.widget?.heldUpdate?.estimated).toBeUndefined()
    expect(result.widget?.updateAvailable).toBe(false)
  })

  it('still offers it where the install path can bypass the wait (CLI)', async () => {
    // The CLI retries with --config.minimum-release-age=0; hiding the update
    // there would suppress one that actually works.
    const dir = npmProfile(1440)
    registry(hoursAgo(1))
    const result = await checkUpdates('web', true, dir)
    expect(result.widget?.updateAvailable).toBe(true)
    expect(result.widget?.heldUpdate).toBeUndefined()
  })

  it('offers a release that is already past the window', async () => {
    const dir = npmProfile(1440)
    registry(hoursAgo(48))
    const result = await checkUpdates('web', true, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })
    expect(result.widget?.updateAvailable).toBe(true)
    expect(result.widget?.heldUpdate).toBeUndefined()
  })

  it('recomputes a higher candidate when its wait expires, even inside the normal cache TTL', async () => {
    const dir = npmProfile(1440)
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    let packuments = 0
    const young = new Date(now - 23 * 3_600_000).toISOString()
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (String(url).endsWith('/widget/latest')) return new Response(JSON.stringify({ version: '1.2.0' }))
      packuments++
      return new Response(JSON.stringify({
        'dist-tags': { latest: '1.2.0' }, versions: { '1.0.0': {}, '1.1.0': {}, '1.2.0': {} },
        time: { '1.0.0': '2026-01-01T00:00:00.000Z', '1.1.0': '2026-01-01T00:00:00.000Z', '1.2.0': young },
      }))
    }))
    try {
      const first = await checkUpdates('web', true, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })
      expect(first.widget).toMatchObject({ eligibleVersion: '1.1.0', latest: '1.2.0', updateAvailable: true, heldUpdate: { latest: '1.2.0' } })
      expect((await checkUpdates('web', false, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })).widget?.eligibleVersion).toBe('1.1.0')
      expect(packuments).toBe(1)
      now += 2 * 3_600_000
      const second = await checkUpdates('web', false, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })
      expect(second.widget).toMatchObject({ eligibleVersion: '1.2.0', updateAvailable: true })
      expect(second.widget?.heldUpdate).toBeUndefined()
      expect(packuments).toBe(2)
    } finally { clock.mockRestore() }
  })

  it('accepts only a verified exact-version exemption and fails closed on unknown exclusion syntax', async () => {
    const dir = npmProfile(1440)
    registry(hoursAgo(1))
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 1440\nminimumReleaseAgeIgnoreMissingTime: false\nminimumReleaseAgeExclude:\n  - widget@1.1.0\n')
    const allowed = await checkUpdates('web', true, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })
    expect(allowed.widget?.eligibleVersion).toBe('1.1.0')
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 1440\nminimumReleaseAgeIgnoreMissingTime: false\nminimumReleaseAgeExclude:\n  - widget@^1.1.0\n')
    const refused = await checkUpdates('web', false, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })
    expect(refused.widget?.eligibleVersion).toBeUndefined()
    expect(refused.widget?.updateAvailable).toBe(false)
  })

  it('recognizes pnpm 11 scope wildcard exclusions for a scoped plugin', async () => {
    const name = '@dsh991/widget'
    const dir = npmProfile(1440, name)
    registry(hoursAgo(1), name)
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), "minimumReleaseAge: 1440\nminimumReleaseAgeIgnoreMissingTime: false\nminimumReleaseAgeExclude:\n  - '@dsh991/*'\n")
    const result = await checkUpdates('web', true, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })
    expect(result[name]?.eligibleVersion).toBe('1.1.0')
  })

  it('applies pnpm 11 first matching rule: a package exemption wins over later version rules', async () => {
    const dir = npmProfile(1440)
    registry(hoursAgo(1))
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 1440\nminimumReleaseAgeIgnoreMissingTime: false\nminimumReleaseAgeExclude:\n  - widget\n  - widget@1.0.0\n')
    const result = await checkUpdates('web', true, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })
    expect(result.widget?.eligibleVersion).toBe('1.1.0')
  })

  it.each([
    ['minimumReleaseAgeStrict: false\n', 'strict false allows pnpm 11 to auto-write age exclusions'],
    ['minimumReleaseAgeIgnoreMissingTime: true\n', 'missing time bypass affects transitive dependencies'],
  ])('accepts native transitive policy %s (%s) (#991 approved)', async (extra) => {
    const dir = npmProfile(1440)
    registry(hoursAgo(48))
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), `minimumReleaseAge: 1440\n${extra}`)
    const result = await checkUpdates('web', true, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })
    expect(result.widget?.eligibleVersion).toBe('1.1.0')
    expect(result.widget?.updateAvailable).toBe(true)
  })

  it('fails closed for environment policies that override the profile and invalidates the cached target', async () => {
    const dir = npmProfile(1440)
    registry(hoursAgo(48))
    const before = await checkUpdates('web', true, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })
    expect(before.widget?.eligibleVersion).toBe('1.1.0')
    vi.stubEnv('PNPM_CONFIG_MINIMUM_RELEASE_AGE', '10080')
    try {
      const after = await checkUpdates('web', false, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })
      expect(after.widget?.eligibleVersion).toBeUndefined()
      expect(after.widget?.updateAvailable).toBe(false)
    } finally { vi.unstubAllEnvs() }
  })

  it.each(['minimum-release-age-strict', 'minimumReleaseAgeStrict', 'minimum-release-age-ignore-missing-time'])(
    'accepts native transitive npmrc policy %s without changing the top-level wait (#991 approved)', async key => {
      const dir = npmProfile(1440)
      registry(hoursAgo(48))
      writeFileSync(join(dir, '.npmrc'), key + '=false\n')
      const resolved = await resolveDesktopMatureUpdate('widget', '1.0.0', 'web', dir, '1.1.0')
      expect(resolved.candidate).toBe('1.1.0')
      registry(undefined)
      expect((await resolveDesktopMatureUpdate('widget', '1.0.0', 'web', dir, '1.1.0')).candidate).toBeNull()
    },
  )

  it.each(['PNPM_CONFIG_MINIMUM_RELEASE_AGE_STRICT', 'npm_config_minimumReleaseAgeIgnoreMissingTime'])(
    'accepts native transitive environment policy %s and still requires top-level time (#991 approved)', async key => {
      const dir = npmProfile(1440)
      registry(hoursAgo(48))
      expect((await checkUpdates('web', true, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })).widget?.eligibleVersion).toBe('1.1.0')
      vi.stubEnv(key, 'true')
      try {
        expect((await checkUpdates('web', false, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })).widget?.eligibleVersion).toBe('1.1.0')
        registry(undefined)
        expect((await resolveDesktopMatureUpdate('widget', '1.0.0', 'web', dir, '1.1.0')).candidate).toBeNull()
      } finally { vi.unstubAllEnvs() }
    },
  )

  it.each(['minimum-release-age-exclude=widget', 'minimumReleaseAgeExclude[]=widget', 'minimum-release-age-exclude[]=widget', 'minimum-release-age-unknown=true', 'minimum-release-age-strict=invalid'])(
    'refuses unverified external npmrc policy %s (#991 approved)', async policy => {
      const dir = npmProfile(1440)
      registry(hoursAgo(48))
      writeFileSync(join(dir, '.npmrc'), policy + '\n')
      expect((await resolveDesktopMatureUpdate('widget', '1.0.0', 'web', dir, '1.1.0')).reason).toBe('policy-unknown')
    },
  )

  it('offers a mature top-level version with the implicit pnpm 11 default (#991 approved)', async () => {
    const dir = npmProfile()
    registry(hoursAgo(48))
    const result = await checkUpdates('web', true, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })
    expect(result.widget?.eligibleVersion).toBe('1.1.0')
    expect(result.widget?.updateAvailable).toBe(true)
  })

  it.each([
    'minimumReleaseAge: 1440\n',
    'minimumReleaseAge: 1440\nminimumReleaseAgeStrict: true\n',
    'minimumReleaseAgeStrict: true\n',
  ])('accepts native missing-time handling with a known mature top-level timestamp: %s (#991 review)', async yaml => {
    const dir = npmProfile()
    registry(hoursAgo(48))
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), yaml)
    const resolved = await resolveDesktopMatureUpdate('widget', '1.0.0', 'web', dir, '1.1.0')
    expect(resolved.reason).toBe('eligible')
    expect(resolved.candidate).toBe('1.1.0')
    const listed = await checkUpdates('web', true, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })
    expect(listed.widget?.updateAvailable).toBe(true)
    expect(listed.widget?.eligibleVersion).toBe('1.1.0')
  })

  it('retains the mature target when only transitive missing-time handling changes (#991 review)', async () => {
    const dir = npmProfile(1440)
    registry(hoursAgo(48))
    expect((await checkUpdates('web', true, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })).widget?.eligibleVersion).toBe('1.1.0')
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 1440\n')
    const listed = await checkUpdates('web', false, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })
    expect(listed.widget?.updateAvailable).toBe(true)
    expect(listed.widget?.eligibleVersion).toBe('1.1.0')
  })

  it.each([
    ['implicit policy', 'packages:\n  - .\n'],
    ['explicit non-strict policy', 'minimumReleaseAge: 1440\nminimumReleaseAgeStrict: false\n'],
    ['missing-time policy', 'minimumReleaseAge: 1440\nminimumReleaseAgeIgnoreMissingTime: true\n'],
  ])('authorizes a known mature top-level version under native policy: %s (#991)', async (_label, yaml) => {
    const dir = npmProfile()
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), yaml)
    registry(hoursAgo(48))
    const resolved = await resolveDesktopMatureUpdate('widget', '1.0.0', 'web', dir, '1.1.0')
    expect(resolved.reason).toBe('eligible')
    expect(resolved.candidate).toBe('1.1.0')
    const listed = await checkUpdates('web', true, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })
    expect(listed.widget?.updateAvailable).toBe(true)
    expect(listed.widget?.eligibleVersion).toBe('1.1.0')
  })

  it.each(['', 'minimumReleaseAgeStrict: false\n', 'minimumReleaseAgeIgnoreMissingTime: true\n'])(
    'refuses unknown top-level time under native policy %s (#991 approved)', async yaml => {
      const dir = npmProfile()
      writeFileSync(join(dir, 'pnpm-workspace.yaml'), yaml)
      registry(undefined)
      const resolved = await resolveDesktopMatureUpdate('widget', '1.0.0', 'web', dir, '1.1.0')
      expect(resolved.candidate).toBeNull()
      const listed = await checkUpdates('web', true, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })
      expect(listed.widget?.updateAvailable).toBe(false)
      expect(listed.widget?.eligibleVersion).toBeUndefined()
    },
  )

  it.each([
    ['unparseable YAML', 'minimumReleaseAge: [invalid\n'],
    ['invalid strict value', 'minimumReleaseAge: 1440\nminimumReleaseAgeStrict: "false"\n'],
    ['invalid missing-time value', 'minimumReleaseAge: 1440\nminimumReleaseAgeIgnoreMissingTime: "true"\n'],
  ])('keeps unreadable policy unknown and blocked: %s (#991)', async (_label, yaml) => {
    const dir = npmProfile()
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), yaml)
    const resolved = await resolveDesktopMatureUpdate('widget', '1.0.0', 'web', dir, '1.1.0')
    expect(resolved.reason).toBe('policy-unknown')
    expect(resolved.candidate).toBeNull()
  })

  it('rejects a registry latest mismatch without offering a verified candidate', async () => {
    const dir = npmProfile(1440)
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(JSON.stringify(
      String(url).endsWith('/widget/latest') ? { version: '1.2.0' } : {
        'dist-tags': { latest: '1.1.0' }, versions: { '1.0.0': {}, '1.1.0': {} },
        time: { '1.0.0': hoursAgo(72), '1.1.0': hoursAgo(72) },
      },
    ))))
    const result = await checkUpdates('web', true, dir, new Map(), new Map(), new Map(), { holdYoungReleases: true })
    expect(result.widget?.eligibleVersion).toBeUndefined()
    expect(result.widget?.updateAvailable).toBe(false)
  })
})

describe('checkUpdates — github pins', () => {
  const HEAD = 'a'.repeat(40)
  const OLD = 'b'.repeat(40)
  let home: string

  /** Profile with one github-installed plugin pinned at `commit`. */
  function profileWith(spec: string, commit: string | null, version = '1.0.0'): string {
    const dir = join(mkdtempSync(join(tmpdir(), 'dshm-upd-')), 'profiles', 'web')
    mkdirSync(join(dir, 'node_modules', 'themer'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { themer: spec } }))
    writeFileSync(join(dir, 'node_modules', 'themer', 'package.json'), JSON.stringify({ name: 'themer', version, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(dir, 'pnpm-lock.yaml'), commit === null ? 'lockfileVersion: 9\n'
      : `  resolution: {tarball: https://codeload.github.com/owner/themer/tar.gz/${commit}}\n`)
    return dir
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dshm-updhome-'))
    // The github branch reads git's own ref advertisement rather than the
    // REST API, whose 60/hour unauthenticated quota is shared across every
    // plugin and every check (#349). The stub answers in that wire format —
    // `<sha> HEAD\0<capabilities>` — so the parsing is pinned too, and a
    // regression back to a JSON `{sha}` endpoint fails here.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ sha: HEAD }),
      text: async () => String(url).includes('info/refs')
        ? `001e# service=git-upload-pack\n00000155${HEAD} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`
        : '',
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

  it('uses an exact commit carried by the github spec when the lockfile is absent', async () => {
    const result = await checkUpdates('web', true, profileWith(`github:owner/themer#${OLD}`, null))
    expect(result.themer).toMatchObject({ current: OLD, latest: HEAD, updateAvailable: true })
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

  it('offers a catalog-matched local package a published upgrade', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '0.17.1' }), { status: 200 })))
    const result = await checkUpdates(
      'web', true, profileWith('FILE:/tmp/dsh-better-sidebar-0.16.1.tgz', OLD, '0.16.1'),
      new Map(), new Map([['themer', 'dsh-better-sidebar']]),
    )
    expect(result.themer).toMatchObject({
      kind: 'linked', current: '0.16.1', latest: '0.17.1',
      updateAvailable: true, restoreRequired: true,
    })
  })

  // #867: the package's own `latest` tag lagged the line it publishes on
  // (`...-profile`: latest 0.1.5-alpha.2, alpha 0.2.1-alpha.4), so a user
  // pinned at 0.2.1-alpha.2 was told "up to date" while their line moved.
  describe('a newer build than `latest` on another tag (#867)', () => {
    /** Registry stub: a plain name spec, with per-tag answers and a request log. */
    function tagRegistry(tags: Record<string, string | number>): { asked: string[] } {
      const asked: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        const href = String(url)
        asked.push(href)
        const match = /registry\.npmjs\.org\/themer\/([^/?]+)/.exec(href)
        if (match === null) return new Response('{}', { status: 200 })
        const answer = tags[match[1]!]
        if (typeof answer !== 'string') return new Response('not found', { status: typeof answer === 'number' ? answer : 404 })
        return new Response(JSON.stringify({ version: answer }), { status: 200 })
      }))
      return { asked }
    }

    it('names the tag build without offering it as an update', async () => {
      const { asked } = tagRegistry({ latest: '0.1.5-alpha.2', alpha: '0.2.1-alpha.4', next: 404, beta: 404, canary: 404 })
      const result = await checkUpdates('web', true, profileWith('themer', null, '0.2.1-alpha.2'))
      expect(result.themer).toMatchObject({
        kind: 'npm', version: '0.2.1-alpha.2', latest: '0.1.5-alpha.2',
        updateAvailable: false, newerPrerelease: '0.2.1-alpha.4',
      })
      expect(asked.some(url => url.endsWith('/themer/alpha'))).toBe(true)
    })

    it('says nothing when the tag line is not ahead of what is installed', async () => {
      tagRegistry({ latest: '0.1.5-alpha.2', alpha: '0.2.1-alpha.2', next: '0.2.0-rc.2' })
      const result = await checkUpdates('web', true, profileWith('themer', null, '0.2.1-alpha.2'))
      expect(result.themer).toMatchObject({ updateAvailable: false })
      expect(result.themer?.newerPrerelease).toBeUndefined()
    })

    it('picks the highest tag, not the first one that answers', async () => {
      tagRegistry({ latest: '0.1.5-alpha.2', next: '0.2.0-rc.2', alpha: '0.2.1-alpha.4', beta: 404, canary: 404 })
      const result = await checkUpdates('web', true, profileWith('themer', null, '0.2.1-alpha.2'))
      expect(result.themer?.newerPrerelease).toBe('0.2.1-alpha.4')
    })

    it('asks no tag at all for a plain release sitting on latest', async () => {
      // The whole point of the gate: a profile of ordinary plugins pays
      // nothing for a field none of them can use.
      const { asked } = tagRegistry({ latest: '1.0.0' })
      const result = await checkUpdates('web', true, profileWith('themer', null, '1.0.0'))
      expect(result.themer).toMatchObject({ updateAvailable: false })
      expect(asked.filter(url => /\/themer\/(next|alpha|beta|canary)/.test(url))).toEqual([])
    })
  })

  it('keeps local packages without a catalog source and link workspaces local', async () => {
    for (const spec of ['link:../themer', 'file:/tmp/themer.tgz']) {
      const result = await checkUpdates('web', true, profileWith(spec, OLD))
      expect(result.themer, spec).toMatchObject({ kind: 'linked', updateAvailable: false })
    }
  })

  // #497: the desktop host installs through generations — a `link:` into
  // `.generations/live/` — and reconciles them at startup. The market names
  // what is newer and never offers to apply it.
  const GENERATION = 'link:../.generations/live/themer+0.16.1+7aba605c3145/node_modules/themer'

  it('names a newer release for a generation without offering it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '0.17.1' }), { status: 200 })))
    const result = await checkUpdates(
      'web', true, profileWith(GENERATION, OLD, '0.16.1'), new Map(), new Map([['themer', 'themer']]),
    )
    expect(result.themer).toEqual({
      kind: 'generation', version: '0.16.1', current: '0.16.1', latest: '0.17.1', updateAvailable: false,
    })
  })

  it('names nothing for a generation that is current, behind a lagging tag, or unmatched', async () => {
    for (const published of ['0.16.1', '0.15.0']) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: published }), { status: 200 })))
      const result = await checkUpdates(
        'web', true, profileWith(GENERATION, OLD, '0.16.1'), new Map(), new Map([['themer', 'themer']]),
      )
      expect(result.themer, published).toMatchObject({ kind: 'generation', current: '0.16.1', latest: null, updateAvailable: false })
    }
    const unmatched = await checkUpdates('web', true, profileWith(GENERATION, OLD, '0.16.1'))
    expect(unmatched.themer).toMatchObject({ kind: 'generation', current: '0.16.1', latest: null, updateAvailable: false })
  })

  it('names the newest build the channel admits for a generation', async () => {
    // The market is itself a generation on a desktop host; a beta subscriber
    // is told about the prerelease the same way an npm install would be.
    const at: Record<string, string> = { latest: '1.13.1', beta: '1.14.0-beta.1' }
    vi.stubGlobal('fetch', vi.fn((url: unknown) => {
      const tag = String(url).split('/').pop() ?? ''
      return Promise.resolve(new Response(JSON.stringify({ version: at[tag] }), { status: 200 }))
    }))
    const result = await checkUpdates(
      'web', true, profileWith(GENERATION, OLD, '1.13.1'), new Map([['themer', 'beta']]), new Map([['themer', 'themer']]),
    )
    expect(result.themer).toMatchObject({ kind: 'generation', current: '1.13.1', latest: '1.14.0-beta.1', updateAvailable: false })
  })
})

describe('checkUpdates — private git hosts (#525)', () => {
  const HEAD = 'a'.repeat(40)
  const OLD = 'b'.repeat(40)
  let home: string
  const proxyKeys = [
    'http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY',
    'npm_config_proxy', 'npm_config_https_proxy',
  ] as const
  const savedProxy: Record<string, string | undefined> = {}

  function profileWith(spec: string, lockCommit: string | null, version = '1.0.0'): string {
    const dir = join(mkdtempSync(join(tmpdir(), 'dshm-gitea-')), 'profiles', 'web')
    mkdirSync(join(dir, 'node_modules', 'themer'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { themer: spec } }))
    writeFileSync(join(dir, 'node_modules', 'themer', 'package.json'), JSON.stringify({ name: 'themer', version, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    // pnpm's non-GitHub git resolution shape — not a codeload tarball.
    writeFileSync(join(dir, 'pnpm-lock.yaml'), lockCommit === null ? 'lockfileVersion: 9\n'
      : `lockfileVersion: 9\npackages:\n  themer@${spec}:\n    resolution: {commit: ${lockCommit}, repo: ${spec}, type: git}\n`)
    return dir
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dshm-giteahome-'))
    // A proxy in the environment selects EnvHttpProxyAgent inside marketFetch.
    // These cases want the direct agent, so the machine's proxy must not leak in.
    for (const key of proxyKeys) {
      savedProxy[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    for (const key of proxyKeys) {
      if (savedProxy[key] === undefined) delete process.env[key]
      else process.env[key] = savedProxy[key]
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('does not treat a Gitea git+https install as an npm package, even when the name collides (#525)', async () => {
    // The failure mode: repoOfTarget only knows github:/codeload, so a Gitea
    // URL fell through to fetchNpmLatest(name). A same-named registry package
    // then read as "an update", and update-all installed name@latest.
    const gitea = 'git+https://gitea.example.com/me/themer.git'
    let npmHits = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const href = String(url)
      if (href.includes('registry.npmjs.org') || href.includes('/themer/latest')) {
        npmHits += 1
        return { ok: true, status: 200, json: async () => ({ version: '9.9.9' }), text: async () => '' }
      }
      // git advertisement for the private host
      return {
        ok: true, status: 200,
        headers: { get: () => 'application/x-git-upload-pack-advertisement' },
        json: async () => ({}),
        text: async () => `001e# service=git-upload-pack\n00000155${HEAD} HEAD\0multi_ack\n`,
      }
    }))
    const result = await checkUpdates('web', true, profileWith(gitea, OLD))
    expect(npmHits, 'must not ask the npm registry by package name').toBe(0)
    expect(result.themer?.kind).not.toBe('npm')
    expect(result.themer).toMatchObject({
      kind: 'github',
      current: OLD,
      latest: HEAD,
      updateAvailable: true,
    })
  })

  it('reads the peeled commit of an annotated tag, not the tag object (#723)', async () => {
    // A tag-pinned git install advertises the tag OBJECT on `refs/tags/<t>` and
    // the COMMIT on `refs/tags/<t>^{}`. pnpm's lockfile records the commit, so
    // resolving the tag object can never equal it: the row claims an update
    // forever, and applying it reinstalls the same commit and reports "version
    // did not change". #597 fixed this on the GitHub path; the smart-HTTP path
    // used by self-hosted git still matched the tag object first.
    const tagObject = '769ec5e093fb58d694fa8db09a5d555469646b49'
    const commit = 'a3341ec2b28e3fb3b5fc3569012fc39acacc9fb2'
    const gitea = 'git+https://gitea.example.com/me/themer.git#v1.0.0'
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('registry.npmjs.org')) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
      }
      return {
        ok: true, status: 200,
        headers: { get: () => 'application/x-git-upload-pack-advertisement' },
        json: async () => ({}),
        text: async () => `001e# service=git-upload-pack\n0000`
          + `003f${tagObject} refs/tags/v1.0.0\n`
          + `003f${commit} refs/tags/v1.0.0^{}\n`,
      }
    }))
    const result = await checkUpdates('web', true, profileWith(gitea, commit))
    expect(result.themer).toMatchObject({ kind: 'github', current: commit, latest: commit, updateAvailable: false })
  })

  it('still resolves a lightweight tag, which advertises no peeled ref', async () => {
    // The other half of the same contract: preferring `^{}` must not lose the
    // tag that has none.
    const commit = 'a3341ec2b28e3fb3b5fc3569012fc39acacc9fb2'
    const gitea = 'git+https://gitea.example.com/me/themer.git#v1.0.0'
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('registry.npmjs.org')) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
      }
      return {
        ok: true, status: 200,
        headers: { get: () => 'application/x-git-upload-pack-advertisement' },
        json: async () => ({}),
        text: async () => `001e# service=git-upload-pack\n0000` + `003f${commit} refs/tags/v1.0.0\n`,
      }
    }))
    const result = await checkUpdates('web', true, profileWith(gitea, 'ffffffffffffffffffffffffffffffffffffffff'))
    expect(result.themer).toMatchObject({ current: 'ffffffffffffffffffffffffffffffffffffffff', latest: commit, updateAvailable: true })
  })

  it('treats a bare https Gitea remote (no .git suffix) as git, not npm (#525)', async () => {
    const gitea = 'https://gitea.example.com/me/themer'
    let npmHits = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const href = String(url)
      if (href.includes('registry.npmjs.org') || /\/themer\/latest/.test(href)) {
        npmHits += 1
        return { ok: true, status: 200, json: async () => ({ version: '9.9.9' }), text: async () => '' }
      }
      return {
        ok: true, status: 200,
        headers: { get: () => 'application/x-git-upload-pack-advertisement' },
        json: async () => ({}),
        text: async () => `001e# service=git-upload-pack\n00000155${HEAD} HEAD\0multi_ack\n`,
      }
    }))
    const result = await checkUpdates('web', true, profileWith(gitea, OLD))
    expect(npmHits).toBe(0)
    expect(result.themer?.kind).not.toBe('npm')
  })

  // #637: pnpm rewrites a gitlab.com / bitbucket.org install into its own
  // shorthand, and records the commit as an archive tarball rather than a
  // `type: git` resolution. Both halves have to be understood, or the row
  // falls through to npm — and `@gitlab/eslint-plugin`, the package this was
  // first seen with, really exists on the registry.
  function archiveProfile(spec: string, tarball: string): string {
    const dir = join(mkdtempSync(join(tmpdir(), 'dshm-shorthand-')), 'profiles', 'web')
    mkdirSync(join(dir, 'node_modules', 'themer'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { themer: spec } }))
    writeFileSync(join(dir, 'node_modules', 'themer', 'package.json'), JSON.stringify({ name: 'themer', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(dir, 'pnpm-lock.yaml'),
      `lockfileVersion: 9\npackages:\n  themer@${tarball}:\n    resolution: {gitHosted: true, tarball: ${tarball}}\n`)
    return dir
  }

  it.each([
    ['gitlab:me/themer', `https://gitlab.com/me/themer/-/archive/${OLD}/themer-${OLD}.tar.gz`],
    ['bitbucket:me/themer', `https://bitbucket.org/me/themer/get/${OLD}.tar.gz`],
  ])('reads %s as a git source and takes its commit from the archive tarball (#637)', async (spec, tarball) => {
    let npmHits = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const href = String(url)
      if (href.includes('registry.npmjs.org') || /\/themer\/latest/.test(href)) {
        npmHits += 1
        return { ok: true, status: 200, json: async () => ({ version: '9.9.9' }), text: async () => '' }
      }
      return {
        ok: true, status: 200,
        headers: { get: () => 'application/x-git-upload-pack-advertisement' },
        json: async () => ({}),
        text: async () => `001e# service=git-upload-pack\n00000155${HEAD} HEAD\0multi_ack\n`,
      }
    }))
    const result = await checkUpdates('web', true, archiveProfile(spec, tarball))
    expect(npmHits, 'must not ask the npm registry by package name').toBe(0)
    expect(result.themer).toMatchObject({ kind: 'github', current: OLD, latest: HEAD, updateAvailable: true })
  })

  it('compares a branch-pinned shorthand against that branch, not the default one (#446)', async () => {
    // The archive tarball gives `current` the commit of the ref the install
    // selected. Asking the remote for HEAD would answer with the default
    // branch instead — two lines that never converge, so the row would offer
    // an update forever and the update itself would never move.
    const NEXT = 'c'.repeat(40)
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      headers: { get: () => 'application/x-git-upload-pack-advertisement' },
      json: async () => ({}),
      text: async () => `001e# service=git-upload-pack\n00000155${HEAD} HEAD\0multi_ack\n0044${NEXT} refs/heads/next\n`,
    })))
    const dir = archiveProfile('gitlab:me/themer#next', `https://gitlab.com/me/themer/-/archive/${NEXT}/themer-${NEXT}.tar.gz`)
    const result = await checkUpdates('web', true, dir)
    expect(result.themer).toMatchObject({ kind: 'github', current: NEXT, latest: NEXT, updateAvailable: false })
  })

  it('does not let one host answer for a same-named repo on another (#637)', async () => {
    // The lockfile holds bitbucket's commit; the install is the gitlab one.
    // An unqualified owner/repo key would report bitbucket's commit as the
    // gitlab plugin's — and then "no update available" against gitlab's HEAD.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      headers: { get: () => 'application/x-git-upload-pack-advertisement' },
      json: async () => ({}),
      text: async () => `001e# service=git-upload-pack\n00000155${HEAD} HEAD\0multi_ack\n`,
    })))
    const dir = archiveProfile('gitlab:me/themer', `https://bitbucket.org/me/themer/get/${OLD}.tar.gz`)
    const result = await checkUpdates('web', true, dir)
    expect(result.themer?.current).toBeNull()
  })

  it('still treats a bare owner/repo registry shorthand as npm', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ version: '1.0.0' }), text: async () => '',
    })))
    const result = await checkUpdates('web', true, profileWith('owner/themer', OLD))
    expect(result.themer).toMatchObject({ kind: 'npm' })
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
    writeFileSync(join(dir, 'node_modules', 'dshmarket', 'package.json'), JSON.stringify({ name: 'dshmarket', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))

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
    writeFileSync(join(dir, 'node_modules', 'dshmarket', 'package.json'), JSON.stringify({ name: 'dshmarket', version: installedVersion, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
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

describe('checkUpdates — URL installs and catalog authorization (#768)', () => {
  // A Release-archive or plain-URL install reaches the npm fallback by name
  // alone. #768 is what happens when the registry hosts a DIFFERENT plugin
  // under that same name: the fallback offered it as an update, and applying
  // it replaced the tarball install with the registry package. The fallback
  // now needs the catalog to vouch that this repo's npm package IS this
  // installed name before it may compare against npm.
  function urlProfile(spec: string, version = '1.0.0'): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-updates-768-'))
    mkdirSync(join(dir, 'node_modules', 'themer'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { themer: spec } }))
    writeFileSync(join(dir, 'node_modules', 'themer', 'package.json'), JSON.stringify({ name: 'themer', version, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    return dir
  }

  function stubNpmLatest(version: string): { hits: () => number } {
    let npmHits = 0
    vi.stubGlobal('fetch', () => {
      npmHits += 1
      return Promise.resolve(new Response(JSON.stringify({ version }), { status: 200 }))
    })
    return { hits: () => npmHits }
  }

  it('does not offer a registry same-name package to a release-archive install (#768)', async () => {
    const dir = urlProfile('https://github.com/o/themer/releases/download/v1.0.0/themer.tgz')
    const npm = stubNpmLatest('9.9.9')
    try {
      const row = (await checkUpdates('web', true, dir, new Map(), new Map(), new Map()))['themer']
      expect(npm.hits()).toBe(0)
      expect(row).toMatchObject({ kind: 'npm', current: '1.0.0', latest: null, updateAvailable: false })
    } finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('still checks npm when the catalog maps that exact repo to this installed name', async () => {
    // The catalog vouches that `o/themer` ships as the npm package `themer`,
    // so a tarball of that repo updating through npm stays the same source
    // instead of swapping to whatever else answers to the name.
    const dir = urlProfile('https://github.com/o/themer/releases/download/v1.0.0/themer.tgz')
    const npm = stubNpmLatest('9.9.9')
    try {
      const catalogNpmByRepo = new Map([['o/themer', 'themer']])
      const row = (await checkUpdates('web', true, dir, new Map(), new Map(), catalogNpmByRepo))['themer']
      expect(npm.hits()).toBeGreaterThan(0)
      expect(row).toMatchObject({ kind: 'npm', current: '1.0.0', latest: '9.9.9', updateAvailable: true })
    } finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('does not fall back to npm for a tarball served from outside GitHub', async () => {
    // No repo identity at all, so no catalog entry can vouch for it. The
    // answer is "no update" — never "whatever the registry has under this
    // name", which is the #768 replacement in its purest form.
    const dir = urlProfile('https://files.example.com/themer-1.0.0.tgz')
    const npm = stubNpmLatest('9.9.9')
    try {
      const row = (await checkUpdates('web', true, dir, new Map(), new Map(), new Map([['o/themer', 'themer']])))['themer']
      expect(npm.hits()).toBe(0)
      expect(row).toMatchObject({ kind: 'npm', current: '1.0.0', latest: null, updateAvailable: false })
    } finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('checkUpdates — a plain dependency is not an update the market can apply (#793)', () => {
  /**
   * The report: a direct dependency that is only a CLI (`@mnemon-dev/mnemon`,
   * a `bin` and no `dsh` field) was listed as updatable, and every click ended
   * in the host's `not-bundle` followed by a rollback message that read as if
   * the profile had been damaged. Nothing had been touched. The detection layer
   * only asked "is it a direct dependency with a newer release", never "is it
   * a plugin".
   */
  const bed = (manifest: Record<string, unknown>, options: { bundles?: string[]; patch?: string } = {}) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'dshm-plain-')), 'profiles', 'web')
    mkdirSync(join(dir, 'node_modules', 'thing'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { thing: '^0.2.9' },
      ...(options.bundles === undefined ? {} : { dsh: { profile: { bundles: options.bundles } } }),
    }))
    writeFileSync(join(dir, 'node_modules', 'thing', 'package.json'), JSON.stringify({ name: 'thing', version: '0.2.9', ...manifest }))
    if (options.patch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), options.patch)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ version: '0.2.10' }) })))
    return dir
  }
  const check = async (dir: string) => (await checkUpdates('web', true, dir))['thing']

  it('does not offer an update for a CLI with no dsh field, but still names the newer release', async () => {
    const dir = bed({ bin: { thing: './cli.js' } })
    try {
      const row = await check(dir)
      expect(row?.updateAvailable, 'a library was offered as an update').toBe(false)
      expect(row?.notAPlugin).toBe(true)
      // Silence would be a different bug: the user is entitled to know a newer
      // release exists, they just cannot have it applied through this channel.
      expect(row?.latest).toBe('0.2.10')
    } finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('keeps offering a package that declares a dsh surface', async () => {
    const dir = bed({ dsh: { bundle: { patch: './cordis.patch.yml' } } })
    try {
      const row = await check(dir)
      expect(row?.updateAvailable).toBe(true)
      expect(row?.notAPlugin).toBeUndefined()
    } finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('keeps offering a package the profile lists as a bundle, whatever its manifest says', async () => {
    const dir = bed({}, { bundles: ['thing'] })
    try { expect((await check(dir))?.updateAvailable).toBe(true) }
    finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('keeps offering a package one of the user\'s own patch rows loads by name', async () => {
    // A real plugin can declare nothing itself: @deepseek-ai/dsh-tools has no
    // dsh field and is loaded by name from a patch. Calling that "a library"
    // would silently stop offering the updates of something that works.
    const dir = bed({}, { patch: "- insert:\n    - id: thing\n      name: 'thing'\n" })
    try { expect((await check(dir))?.updateAvailable).toBe(true) }
    finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('leaves the offer standing when it cannot tell — an unreadable patch hides nothing', async () => {
    // This rule only ever REMOVES an offer, so uncertainty has to resolve to
    // the old behaviour, not to a quietly missing update.
    const dir = bed({}, { patch: "- insert: [unterminated\n  : : :" })
    try { expect((await check(dir))?.updateAvailable).toBe(true) }
    finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('checkUpdates — a floating git install follows the repository\'s version, not its branch head (#824)', () => {
  /**
   * The report: `dsh-our-free-model` was installed floating
   * (`git+https://github.com/…/dsh-our-free-model.git`, no pin). The plugin's
   * own updater had already put 2.0.0 on disk, and upstream's only changes
   * since were catalog re-signings — commits with the SAME version. The
   * market compared the lockfile commit to the branch HEAD, found them
   * unequal, and advertised "有新版本 <sha>" on every poll, forever, for an
   * update that installs nothing new.
   *
   * The fix asks the only question whose answer means "there is something to
   * install": did the repository's own `version` move? A floating install
   * gets whatever the default branch points at, so the branch moving is not
   * news. Every case where that question cannot be answered — no readable
   * version, a non-GitHub host, a non-semver value, a spec that names its own
   * ref — must fall back to the commit comparison, never to "current".
   */
  const HEAD = 'a'.repeat(40)
  const OLD = 'b'.repeat(40)
  let home: string

  /** Profile with one floating git+https GitHub install at lock commit `commit`. */
  function profileWith(spec: string, commit: string, version = '2.0.0', lockExtra = ''): string {
    const dir = join(mkdtempSync(join(tmpdir(), 'dshm-824-')), 'profiles', 'web')
    mkdirSync(join(dir, 'node_modules', 'themer'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { themer: spec } }))
    writeFileSync(join(dir, 'node_modules', 'themer', 'package.json'), JSON.stringify({ name: 'themer', version, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(dir, 'pnpm-lock.yaml'),
      `lockfileVersion: 9\npackages:\n  themer@${spec}:\n    resolution: {commit: ${commit}, repo: ${spec}, type: git${lockExtra}}\n`)
    return dir
  }

  /**
   * Same, but locked through the codeload tarball the `github:` branch reads
   * `current` from — the shape a real floating `github:owner/repo` install
   * leaves behind, without which that branch cannot see the lock commit and
   * the old code also answered false (so the case would prove nothing).
   */
  function profileWithCodeload(spec: string, commit: string, version = '2.0.0'): string {
    const dir = join(mkdtempSync(join(tmpdir(), 'dshm-824-')), 'profiles', 'web')
    mkdirSync(join(dir, 'node_modules', 'themer'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { themer: spec } }))
    writeFileSync(join(dir, 'node_modules', 'themer', 'package.json'), JSON.stringify({ name: 'themer', version, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(dir, 'pnpm-lock.yaml'),
      `lockfileVersion: 9\n  resolution: {tarball: https://codeload.github.com/owner/themer/tar.gz/${commit}}\n`)
    return dir
  }

  /** Answers the git advertisement with `head` and raw HEAD package.json with `version` (null = unreachable). */
  function stubGitAndRaw(head: string, version: string | null): { rawHits: () => number } {
    let rawHits = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const href = String(url)
      if (href.includes('raw.githubusercontent.com')) {
        rawHits += 1
        return version === null
          ? { ok: false, status: 404, json: async () => ({}) }
          : { ok: true, status: 200, json: async () => ({ version }) }
      }
      return {
        ok: true, status: 200,
        headers: { get: () => 'application/x-git-upload-pack-advertisement' },
        json: async () => ({}),
        text: async () => `001e# service=git-upload-pack\n00000155${head} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`
          + `003f${head} refs/heads/main\n`,
      }
    }))
    return { rawHits: () => rawHits }
  }

  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dshm-824home-')) })
  afterEach(() => { vi.unstubAllGlobals(); rmSync(home, { recursive: true, force: true }) })

  it('stops advertising an update when the branch moved but the version did not (#824)', async () => {
    // The exact shape of the report: lock commit OLD, remote HEAD newer,
    // both sides version 2.0.0. Before the fix this row read
    // updateAvailable: true forever.
    const spec = 'git+https://github.com/zouyuxuan122/dsh-our-free-model.git'
    stubGitAndRaw(HEAD, '2.0.0')
    const result = await checkUpdates('web', true, profileWith(spec, OLD))
    expect(result.themer).toMatchObject({ kind: 'github', version: '2.0.0', current: OLD, latest: HEAD, updateAvailable: false })
    // Not an update, but not "up to date" either: the badge names the
    // unreleased HEAD so a user who wants those commits knows the row lags.
    expect(result.themer.unreleasedCommit).toBe(HEAD)
  })

  it('still advertises the update when the repository published a newer version', async () => {
    const spec = 'git+https://github.com/zouyuxuan122/dsh-our-free-model.git'
    stubGitAndRaw(HEAD, '2.1.0')
    const result = await checkUpdates('web', true, profileWith(spec, OLD))
    expect(result.themer).toMatchObject({ current: OLD, latest: HEAD, updateAvailable: true })
    // A real release is an update; the unreleased-commits badge must not say
    // anything beside it.
    expect(result.themer.unreleasedCommit).toBeUndefined()
  })

  it('does not offer a downgrade when the remote version reads older than the install', async () => {
    // A rolled-back default branch is not an update; only forwards counts,
    // same rule as the npm branch (`isUpgrade`).
    const spec = 'git+https://github.com/zouyuxuan122/dsh-our-free-model.git'
    stubGitAndRaw(HEAD, '1.9.0')
    const result = await checkUpdates('web', true, profileWith(spec, OLD))
    expect(result.themer).toMatchObject({ updateAvailable: false })
  })

  it('applies the same rule to the github: shorthand spelling of a floating install', async () => {
    // #824 also named `github:omdsh-dev/DSH-better-sidebar`: same disease,
    // different spec spelling. The codeload lock entry makes `current`
    // readable, so under the OLD rule this row read current OLD ≠ HEAD →
    // updateAvailable true; only the version rule turns it off.
    stubGitAndRaw(HEAD, '2.0.0')
    const result = await checkUpdates('web', true, profileWithCodeload('github:owner/themer', OLD))
    expect(result.themer).toMatchObject({ kind: 'github', current: OLD, latest: HEAD, updateAvailable: false })
  })

  it('never consults the version of a #semver: range either (#446 shape)', async () => {
    // `#semver:^2.0.0` re-resolves INSIDE the range: a 3.0.0 at HEAD is not
    // installable, so the raw version must not even be requested — it would
    // advertise an update forever. `refOfFragment` skips semver selectors
    // (the range compares against the default branch), so this needs its own
    // probe on top of the `#branch` guard.
    const spec = 'git+https://github.com/zouyuxuan122/dsh-our-free-model.git#semver:^2.0.0'
    const { rawHits } = stubGitAndRaw(HEAD, '3.0.0')
    const result = await checkUpdates('web', true, profileWith(spec, OLD))
    expect(rawHits(), 'a semver range must not trigger a raw version read').toBe(0)
    expect(result.themer).toMatchObject({ current: OLD, latest: HEAD, updateAvailable: true })
  })

  it('falls back to the commit comparison when the raw version cannot be read', async () => {
    // Private repo, no package.json at HEAD, or raw unreachable in this
    // region: "cannot tell" must degrade to the old behaviour, not to
    // "current" — otherwise an unreachable host stops reporting updates.
    const spec = 'git+https://github.com/zouyuxuan122/dsh-our-free-model.git'
    stubGitAndRaw(HEAD, null)
    const result = await checkUpdates('web', true, profileWith(spec, OLD))
    expect(result.themer).toMatchObject({ current: OLD, latest: HEAD, updateAvailable: true })
  })

  it('falls back to the commit comparison when the remote version is not semver', async () => {
    const spec = 'git+https://github.com/zouyuxuan122/dsh-our-free-model.git'
    stubGitAndRaw(HEAD, 'not-a-version')
    const result = await checkUpdates('web', true, profileWith(spec, OLD))
    expect(result.themer).toMatchObject({ updateAvailable: true })
  })

  it('never consults the version of a spec that names its own ref (#446)', async () => {
    // `#branch` chose a line deliberately; a new commit on it is exactly
    // what that user asked to hear about. The raw file must not even be
    // requested.
    const spec = 'git+https://github.com/zouyuxuan122/dsh-our-free-model.git#main'
    const { rawHits } = stubGitAndRaw(HEAD, '2.0.0')
    const result = await checkUpdates('web', true, profileWith(spec, OLD))
    expect(rawHits(), 'a pinned ref must not trigger a raw version read').toBe(0)
    expect(result.themer).toMatchObject({ current: OLD, latest: HEAD, updateAvailable: true })
  })

  it('reads the package.json of the subpath a monorepo spec points at', async () => {
    // `path:/packages/themer` installs from a subdirectory; the version that
    // matters is the one in THAT package.json, not the repo root's.
    const spec = 'github:owner/monorepo#path:/packages/themer'
    let askedFor = ''
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const href = String(url)
      if (href.includes('raw.githubusercontent.com')) {
        askedFor = href
        return { ok: true, status: 200, json: async () => ({ version: '2.0.0' }) }
      }
      return {
        ok: true, status: 200,
        headers: { get: () => 'application/x-git-upload-pack-advertisement' },
        json: async () => ({}),
        text: async () => `001e# service=git-upload-pack\n00000155${HEAD} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`
          + `003f${HEAD} refs/heads/main\n`,
      }
    }))
    const result = await checkUpdates('web', true, profileWith(spec, OLD, '2.0.0', ', path: /packages/themer'))
    expect(askedFor.endsWith('/packages/themer/package.json'), askedFor).toBe(true)
    expect(result.themer).toMatchObject({ updateAvailable: false })
  })
})


describe('fetchNpmLatest — packument fallback (#932)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('falls back to the full packument dist-tag when /latest fails', async () => {
    // Measured in #932: registry.npmjs.org answered 429 to /latest while the
    // packument answered 200 with the same dist-tag. Returning null made the
    // fresh install fall back to the bare name, and pnpm's fresh-release hold
    // installed an OLDER version than the catalog had just shown.
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url))
      if (String(url).endsWith('/dsh-plugin-compat-check/latest')) return new Response('rate limited', { status: 429 })
      return new Response(JSON.stringify({ 'dist-tags': { latest: '0.1.3' } }), { status: 200 })
    }))
    await expect(fetchNpmLatest('dsh-plugin-compat-check')).resolves.toBe('0.1.3')
    expect(calls.some(url => url.endsWith('/dsh-plugin-compat-check'))).toBe(true)
  })

  it('returns null when both reads fail, keeping the old contract', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))
    await expect(fetchNpmLatest('dsh-plugin-compat-check')).resolves.toBeNull()
  })

  it('does not pay for the packument when /latest answers', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ version: '0.1.3' }), { status: 200 })
    }))
    await expect(fetchNpmLatest('dsh-plugin-compat-check')).resolves.toBe('0.1.3')
    expect(calls).toHaveLength(1)
  })
})
