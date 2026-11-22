/**
 * Version pins from the organization's policy: the one release a package may
 * install, and the newest an update may offer. Real policy file, real update
 * check against a stubbed registry.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkUpdates, fetchNpmLatest, invalidateUpdates } from '../src/updates.ts'
import { clientPolicy, pinnedVersion, readPolicyFields, resetPolicyCache } from '../src/policy.ts'
import { mergeSources } from '../src/catalogs.ts'
import type { Registry, RegistryPlugin } from '../src/registry.ts'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dshm-pins-'))
  vi.stubEnv('DSH_HOME', join(tmp, 'home'))
  vi.stubEnv('DSH_MARKET_POLICY', '')
  resetPolicyCache()
  invalidateUpdates()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  resetPolicyCache()
  rmSync(tmp, { recursive: true, force: true })
})

const policy = (doc: unknown): void => {
  const file = join(tmp, 'policy.json')
  writeFileSync(file, JSON.stringify(doc))
  vi.stubEnv('DSH_MARKET_POLICY', file)
  resetPolicyCache()
}

describe('reading pins', () => {
  it('keeps npm names with exact versions, and says what it ignored', () => {
    const read = readPolicyFields({ pins: { 'dsh-notify-me': '1.21.6', '@acme/x': '2.0.0-rc.1', 'bad name': '1.0.0', 'dsh-y': '^1.0.0', 'dsh-z': 3 } }, '/p.json')
    expect(read.pins).toEqual({ 'dsh-notify-me': '1.21.6', '@acme/x': '2.0.0-rc.1' })
    expect(read.problems).toHaveLength(3)
    expect(readPolicyFields({ pins: ['x'] }, '/p.json').problems).toHaveLength(1)
  })

  it('finds a pin by package name, case-insensitively', () => {
    const read = readPolicyFields({ pins: { '@acme/tool': '1.2.3' } }, '/p.json')
    expect(pinnedVersion('@ACME/Tool', read)).toBe('1.2.3')
    expect(pinnedVersion('@acme/other', read)).toBeUndefined()
    expect(pinnedVersion(null, read)).toBeUndefined()
  })
})

describe('what a pin does to the update check', () => {
  function profile(installed: string, windowMinutes?: number): string {
    const dir = join(tmp, 'profiles', 'web')
    mkdirSync(join(dir, 'node_modules', 'widget'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { widget: '^1.0.0' } }))
    writeFileSync(join(dir, 'node_modules', 'widget', 'package.json'), JSON.stringify({ name: 'widget', version: installed, dsh: {} }))
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    if (windowMinutes !== undefined) writeFileSync(join(dir, 'pnpm-workspace.yaml'), `minimumReleaseAge: ${String(windowMinutes)}\nminimumReleaseAgeIgnoreMissingTime: false\n`)
    return dir
  }
  /** The registry calls 1.3.0 newest, and has older releases, all long published. */
  function registry(): void {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const body = String(url).endsWith('/widget/latest')
        ? { version: '1.3.0' }
        : {
            'dist-tags': { latest: '1.3.0' },
            versions: { '1.0.0': {}, '1.1.0': {}, '1.2.0': {}, '1.3.0': {} },
            time: { '1.0.0': '2026-01-01T00:00:00.000Z', '1.1.0': '2026-01-02T00:00:00.000Z', '1.2.0': '2026-01-03T00:00:00.000Z', '1.3.0': '2026-01-04T00:00:00.000Z' },
          }
      return new Response(JSON.stringify(body), { status: 200 })
    }))
  }

  it('without a pin the registry decides', async () => {
    registry()
    const result = await checkUpdates('web', true, profile('1.0.0'))
    expect(result.widget).toMatchObject({ latest: '1.3.0', updateAvailable: true })
  })

  it('offers an update only up to the pin', async () => {
    policy({ pins: { widget: '1.1.0' } })
    registry()
    const result = await checkUpdates('web', true, profile('1.0.0'))
    expect(result.widget).toMatchObject({ latest: '1.1.0', updateAvailable: true })
  })

  it('offers nothing once the pin is installed, and never a downgrade below it', async () => {
    policy({ pins: { widget: '1.1.0' } })
    registry()
    expect((await checkUpdates('web', true, profile('1.1.0'))).widget?.updateAvailable).toBe(false)
    invalidateUpdates()
    const ahead = await checkUpdates('web', true, profile('1.2.0'))
    expect(ahead.widget?.updateAvailable).toBe(false)
  })

  it('caps the mature-release choice on the official desktop path at the pin too', async () => {
    policy({ pins: { widget: '1.1.0' } })
    registry()
    const result = await checkUpdates('web', true, profile('1.0.0', 1440), new Map(), new Map(), new Map(), { holdYoungReleases: true })
    expect(result.widget).toMatchObject({ updateAvailable: true, eligibleVersion: '1.1.0' })
  })

  it('answers "newest" with the pin and does not ask the registry', async () => {
    policy({ pins: { widget: '1.1.0' } })
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect(await fetchNpmLatest('widget')).toBe('1.1.0')
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('what a pin does to the list the page shows', () => {
  const entry = (name: string, npm: string | null, version: string): RegistryPlugin => ({
    name, owner: 'o', url: `https://repo.acme.internal/${name}`, category: 'tools', description: { en: name }, npm, install: name,
    added: '2026-01-01', version,
  })
  const registry: Registry = { updated: 'u', count: 2, categories: {}, plugins: [entry('a', 'dsh-a', '9.9.9'), entry('b', 'dsh-b', '1.0.0')] }

  it('shows the pinned version, and marks the entry as pinned', () => {
    const merged = mergeSources({
      publicRegistry: registry, publicInfo: null, extras: [], allow: null, pins: { 'dsh-a': '1.21.6' },
    })
    expect(merged.plugins.find(p => p.name === 'a')).toMatchObject({ version: '1.21.6', pinned: '1.21.6' })
    expect(merged.plugins.find(p => p.name === 'b')).not.toHaveProperty('pinned')
  })

  it('does not let a catalog claim a pin for itself', () => {
    const forged = { ...entry('c', 'dsh-c', '1.0.0'), pinned: '0.0.1' }
    const merged = mergeSources({ publicRegistry: { ...registry, plugins: [forged] }, publicInfo: null, extras: [], allow: null, pins: {} })
    // a public entry is passed through untouched; the pin is only ever the policy's
    expect(merged.plugins).toHaveLength(1)
  })

  it('tells the page only about what was turned off', () => {
    expect(clientPolicy(readPolicyFields({}, '/p.json'))).toEqual({})
    expect(clientPolicy(readPolicyFields({ comments: false }, '/p.json'))).toEqual({ comments: false })
    expect(clientPolicy(readPolicyFields({ externalImages: false, comments: false }, '/p.json'))).toEqual({ externalImages: false, comments: false })
  })
})
