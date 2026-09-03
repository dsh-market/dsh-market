import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deriveHostCompatibility,
  DiscoveryManifestIndex,
  manifestFacts,
  type NpmManifestFacts,
} from '../src/discovery-compatibility.ts'

const HOST_PACKAGES = new Set([
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
])

function facts(over: Partial<NpmManifestFacts> = {}): NpmManifestFacts {
  return {
    version: '1.0.0',
    enginesDsh: null,
    peerDependencies: {},
    ...over,
  }
}

describe('deriveHostCompatibility', () => {
  it('uses engines.dsh and lockstep DSH peers while excluding Cordis and schemastery', () => {
    const result = deriveHostCompatibility(facts({
      enginesDsh: '>=0.1.1-rc.2',
      peerDependencies: {
        '@deepseek-ai/dsh-settings': '^0.1.1-rc.2',
        '@deepseek-ai/cordis': '^4.0.1',
        '@deepseek-ai/schemastery': '^3.18.1',
      },
    }), '0.1.2-alpha.2', HOST_PACKAGES)

    expect(result.status).toBe('compatible')
    expect(result.declarations).toEqual([
      { kind: 'engine', range: '>=0.1.1-rc.2' },
      { kind: 'peer', package: '@deepseek-ai/dsh-settings', range: '^0.1.1-rc.2' },
    ])
    expect(result.requirement).toBe('>=0.1.1-rc.2 ∩ ^0.1.1-rc.2')
  })

  it('includes prerelease hosts across base-version tuples', () => {
    // npm semver needs includePrerelease for the all-prerelease DSH line:
    // strict admission would reject alpha.2 solely because the comparator's
    // prerelease happens to be attached to 0.1.1 rather than 0.1.2.
    const result = deriveHostCompatibility(facts({
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.1-rc.2' },
    }), '0.1.2-alpha.2', HOST_PACKAGES)
    expect(result.status).toBe('compatible')
  })

  it('does not turn a sloppy peer caret ceiling into a confirmed mismatch', () => {
    const result = deriveHostCompatibility(facts({
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.0.1' },
    }), '0.1.2-alpha.2', HOST_PACKAGES)
    expect(result.status).toBe('compatible')
    expect(result.requirement).toBe('^0.0.1')
  })

  it('makes conflicting declarations incompatible and malformed-only matches unknown', () => {
    const conflicting = deriveHostCompatibility(facts({
      enginesDsh: '>=0.1.2-alpha.2',
      peerDependencies: { '@deepseek-ai/dsh-tools': '<0.1.2-alpha.2' },
    }), '0.1.2-alpha.2', HOST_PACKAGES)
    expect(conflicting.status).toBe('incompatible')

    const malformed = deriveHostCompatibility(facts({
      enginesDsh: 'catalog:current',
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.1-rc.2' },
    }), '0.1.2-alpha.2', HOST_PACKAGES)
    expect(malformed.status).toBe('unknown')
    expect(malformed.requirement).toContain('catalog:current')
  })

  it('keeps missing data, missing declarations, and an unknown host distinct', () => {
    expect(deriveHostCompatibility(null, '0.1.2-alpha.2', HOST_PACKAGES))
      .toMatchObject({ status: 'unknown', basis: 'unavailable', requirement: null })
    expect(deriveHostCompatibility(facts(), '0.1.2-alpha.2', HOST_PACKAGES))
      .toMatchObject({ status: 'unknown', basis: 'undeclared', requirement: null })
    expect(deriveHostCompatibility(facts({ enginesDsh: '^0.1.2-alpha.2' }), null, HOST_PACKAGES))
      .toMatchObject({ status: 'unknown', basis: 'manifest', requirement: '^0.1.2-alpha.2' })
  })
})

describe('manifestFacts', () => {
  it('retains only bounded string declarations from the public manifest', () => {
    expect(manifestFacts({
      version: ' 1.2.3 ',
      engines: { node: '>=20', dsh: ' ^0.1.2-alpha.2 ' },
      peerDependencies: {
        '@deepseek-ai/dsh-tools': '^0.1.2-alpha.2',
        'community-library': '^9.0.0',
        broken: 42,
      },
      scripts: { postinstall: 'do-not-cache-me' },
    })).toEqual({
      version: '1.2.3',
      enginesDsh: '^0.1.2-alpha.2',
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.2-alpha.2' },
    })
  })
})

describe('DiscoveryManifestIndex', () => {
  const directories: string[] = []
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it('bounds concurrency and reuses the durable cache in a new index', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dshm-discovery-'))
    directories.push(directory)
    const cache = join(directory, '.dsh-market', 'discovery.json')
    let calls = 0
    let active = 0
    let peak = 0
    const fetcher = async (url: string): Promise<Response> => {
      calls += 1
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      const name = decodeURIComponent(url.split('/').at(-2) ?? '')
      return new Response(JSON.stringify({
        version: '1.0.0',
        peerDependencies: { '@deepseek-ai/dsh-tools': `^0.1.${String(name.length)}-rc.1` },
      }), { status: 200 })
    }
    const first = new DiscoveryManifestIndex(cache, { fetcher, now: () => 1_000, concurrency: 2 })
    const [firstBatch, secondBatch] = await Promise.all([
      first.lookup(['plugin-a', 'plugin-b'], 'https://registry.example'),
      first.lookup(['plugin-c'], 'https://registry.example'),
    ])
    const loaded = { ...firstBatch, ...secondBatch }
    expect(Object.keys(loaded)).toHaveLength(3)
    expect(calls).toBe(3)
    expect(peak).toBe(2)

    const second = new DiscoveryManifestIndex(cache, {
      fetcher: async () => { throw new Error('the durable cache should answer') },
      now: () => 1_001,
      concurrency: 2,
    })
    expect(await second.lookup(['plugin-a', 'plugin-b', 'plugin-c'], 'https://registry.example'))
      .toEqual(loaded)
  })

  it('does not persist a registry failure as an undeclared manifest', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dshm-discovery-'))
    directories.push(directory)
    const cache = join(directory, '.dsh-market', 'discovery.json')
    const failed = new DiscoveryManifestIndex(cache, {
      fetcher: async () => { throw new Error('offline') },
      now: () => 1_000,
    })
    expect(await failed.lookup(['plugin-a'], 'https://registry.example')).toEqual({ 'plugin-a': null })

    let retried = 0
    const recovered = new DiscoveryManifestIndex(cache, {
      fetcher: async () => {
        retried += 1
        return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 })
      },
      now: () => 1_001,
    })
    expect((await recovered.lookup(['plugin-a'], 'https://registry.example'))['plugin-a'])
      .toMatchObject({ version: '1.0.0' })
    expect(retried).toBe(1)
  })
})
