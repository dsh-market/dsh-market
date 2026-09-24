import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deriveHostCompatibility,
  DiscoveryManifestIndex,
  findCompatibleVersion,
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

describe('compatible version lookup', () => {
  it('checks only versions newer than the installed release for updates', async () => {
    const fetcher = async () => new Response(JSON.stringify({ versions: {
      '0.1.15': { version: '0.1.15', engines: { dsh: '>=0.1.0' } },
      '0.1.18': { version: '0.1.18', engines: { dsh: '>=99.0.0' } },
      '0.1.19': { version: '0.1.19', engines: { dsh: '>=99.0.0' } },
    } }), { status: 200 })
    expect(await findCompatibleVersion('plugin-a', '0.1.5', HOST_PACKAGES, 'https://registry.example', fetcher))
      .toBe('0.1.15')
    expect(await findCompatibleVersion('plugin-a', '0.1.5', HOST_PACKAGES, 'https://registry.example', fetcher, '0.1.18'))
      .toBeNull()
  })
})

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

describe('manifestFacts reads both host-requirement shapes (#577)', () => {
  it('reads dsh.engines.dsh when the top-level engines field is absent', () => {
    expect(manifestFacts({
      version: '0.3.20',
      dsh: { engines: { dsh: ' >=0.1.5-rc.1 ' } },
    })).toEqual({
      version: '0.3.20',
      enginesDsh: '>=0.1.5-rc.1',
      peerDependencies: {},
    })
  })

  it('prefers the top-level engines.dsh when a manifest carries both shapes', () => {
    expect(manifestFacts({
      version: '1.0.0',
      engines: { dsh: '^0.1.2-alpha.2' },
      dsh: { engines: { dsh: '>=0.1.5-rc.1' } },
    })).toEqual({
      version: '1.0.0',
      enginesDsh: '^0.1.2-alpha.2',
      peerDependencies: {},
    })
  })

  it('stays null when neither shape declares a host requirement', () => {
    expect(manifestFacts({
      version: '1.0.0',
      dsh: { engines: { node: '>=20' } },
    })).toEqual({
      version: '1.0.0',
      enginesDsh: null,
      peerDependencies: {},
    })
  })
})

describe('DiscoveryManifestIndex', () => {
  const directories: string[] = []
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it('refreshes the visible release instead of showing a day-old catalog version', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dshm-discovery-'))
    directories.push(directory)
    let latest = '0.19.1'
    let calls = 0
    const index = new DiscoveryManifestIndex(join(directory, 'facts.json'), {
      fetcher: async () => {
        calls += 1
        return new Response(JSON.stringify({ version: latest, peerDependencies: {
          '@deepseek-ai/dsh-settings': latest === '0.19.1' ? '^0.1.5-rc.1' : '^0.1.7-rc.1',
        } }), { status: 200 })
      },
      now: () => 1_000,
    })
    expect((await index.lookup(['dsh-better-sidebar'], 'https://registry.example'))['dsh-better-sidebar']?.version).toBe('0.19.1')
    latest = '0.21.1'
    expect((await index.lookup(['dsh-better-sidebar'], 'https://registry.example', { refresh: true }))['dsh-better-sidebar'])
      .toMatchObject({ version: '0.21.1', peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.7-rc.1' } })
    expect(calls).toBe(2)
  })

  it('does not fall back to an old version when the live refresh fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dshm-discovery-'))
    directories.push(directory)
    let online = true
    const index = new DiscoveryManifestIndex(join(directory, 'facts.json'), {
      fetcher: async () => {
        if (!online) throw new Error('offline')
        return new Response(JSON.stringify({ version: '0.19.1' }), { status: 200 })
      },
      now: () => 1_000,
    })
    await index.lookup(['dsh-better-sidebar'], 'https://registry.example')
    online = false
    expect((await index.lookup(['dsh-better-sidebar'], 'https://registry.example', { refresh: true }))['dsh-better-sidebar']).toBeNull()
    expect((await index.lookup(['dsh-better-sidebar'], 'https://registry.example'))['dsh-better-sidebar']).toBeNull()
  })

  it('checks the exact install target without trusting or replacing cached latest facts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dshm-discovery-'))
    directories.push(directory)
    const urls: string[] = []
    const index = new DiscoveryManifestIndex(join(directory, 'facts.json'), {
      fetcher: async (url) => {
        urls.push(url)
        const version = url.endsWith('/latest') ? '0.19.1' : '0.21.1'
        return new Response(JSON.stringify({ version, peerDependencies: {
          '@deepseek-ai/dsh-settings': version === '0.19.1' ? '^0.1.5-rc.1' : '^0.1.7-rc.1',
        } }), { status: 200 })
      },
      now: () => 1_000,
    })
    await index.lookup(['dsh-better-sidebar'], 'https://registry.example')
    const target = await index.lookupVersion('dsh-better-sidebar', '0.21.1', 'https://registry.example')
    expect(target?.version).toBe('0.21.1')
    expect(deriveHostCompatibility(target, '0.1.5-rc.2', HOST_PACKAGES).status).toBe('incompatible')
    expect((await index.lookup(['dsh-better-sidebar'], 'https://registry.example'))['dsh-better-sidebar']?.version).toBe('0.19.1')
    expect(urls).toEqual(['https://registry.example/dsh-better-sidebar/latest', 'https://registry.example/dsh-better-sidebar/0.21.1'])
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

  it('an advisory pre-flight leaves no failure cooldown behind (#619)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dshm-discovery-'))
    directories.push(directory)
    const cache = join(directory, '.dsh-market', 'discovery.json')

    let online = false
    let asked = 0
    const index = new DiscoveryManifestIndex(cache, {
      fetcher: async () => {
        asked += 1
        if (!online) throw new Error('offline')
        return new Response(JSON.stringify({ version: '2.0.0' }), { status: 200 })
      },
      now: () => 1_000,
    })

    // The install guard runs its pre-flight while the registry is unreachable.
    expect(await index.lookup(['plugin-a'], 'https://registry.example', { record: false }))
      .toEqual({ 'plugin-a': null })

    // The panel asks afterwards, with the registry back up. A recorded failure
    // would answer null for the whole cooldown — that is the dsh-market#614
    // shape: an install whose advice was never asked for decided the verdict
    // of the next question.
    online = true
    expect((await index.lookup(['plugin-a'], 'https://registry.example'))['plugin-a'])
      .toMatchObject({ version: '2.0.0' })
    expect(asked).toBe(2)
  })

  it('an advisory pre-flight does not seed the durable cache either (#619)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dshm-discovery-'))
    directories.push(directory)
    const cache = join(directory, '.dsh-market', 'discovery.json')

    let served = 0
    const index = new DiscoveryManifestIndex(cache, {
      fetcher: async () => {
        served += 1
        return new Response(JSON.stringify({ version: served === 1 ? '1.0.0' : '2.0.0' }), { status: 200 })
      },
      now: () => 1_000,
    })

    // The guard looks while the target's latest is still 1.0.0.
    expect((await index.lookup(['plugin-a'], 'https://registry.example', { record: false }))['plugin-a'])
      .toMatchObject({ version: '1.0.0' })

    // The panel asks after 2.0.0 shipped and has to see 2.0.0, not the version
    // the pre-flight happened to pin.
    expect((await index.lookup(['plugin-a'], 'https://registry.example'))['plugin-a'])
      .toMatchObject({ version: '2.0.0' })
    expect(served).toBe(2)
  })
})

describe('host-compatibility declaration semantics (Phase 1 additions)', () => {
  it('derives incompatible from an engine-only declaration the host does not satisfy', () => {
    const result = deriveHostCompatibility(
      facts({ enginesDsh: '^0.1.1-rc.2' }),
      '0.1.0-alpha.1',
      HOST_PACKAGES,
    )
    expect(result.status).toBe('incompatible')
    expect(result.basis).toBe('manifest')
    expect(result.requirement).toBe('^0.1.1-rc.2')
  })

  it('is conjunctive: one failing peer refuses even when engines.dsh passes', () => {
    const result = deriveHostCompatibility(
      facts({
        enginesDsh: '>=0.1.0',
        peerDependencies: {
          '@deepseek-ai/dsh-settings': '^0.1.1-rc.2',
          '@deepseek-ai/dsh-tools': '^99.0.0',
        },
      }),
      '0.1.2-alpha.2',
      HOST_PACKAGES,
    )
    expect(result.status).toBe('incompatible')
    expect(result.basis).toBe('manifest')
    // All three declarations surface in the human-readable requirement.
    expect(result.requirement).toContain('>=0.1.0')
    expect(result.requirement).toContain('^0.1.1-rc.2')
    expect(result.requirement).toContain('^99.0.0')
  })

  it('ignores non-lockstep @deepseek-ai peers that are not host packages', () => {
    const result = deriveHostCompatibility(
      facts({
        enginesDsh: '>=0.1.0',
        peerDependencies: {
          // Shipped by the plugin but not part of the host's lockstep line:
          // not a declaration about the host, must not change the verdict.
          '@deepseek-ai/foo-extra': '^1.0.0',
          '@deepseek-ai/cordis': '^4.0.1',
          '@deepseek-ai/schemastery': '^3.18.1',
        },
      }),
      '0.1.2-alpha.2',
      HOST_PACKAGES,
    )
    expect(result.status).toBe('compatible')
    expect(result.basis).toBe('manifest')
    expect(result.requirement).toBe('>=0.1.0') // only the engine declaration remains
  })
})
