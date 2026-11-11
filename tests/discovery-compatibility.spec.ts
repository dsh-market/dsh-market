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

function facts(over: Partial<NpmManifestFacts> = {}): NpmManifestFacts {
  return {
    version: '1.0.0',
    enginesDsh: null,
    peerDependencies: {},
    ...over,
  }
}

describe('deriveHostCompatibility', () => {
  it('recognizes explicit equality peers and refuses hosts outside the exact pin', () => {
    const declared = facts({ peerDependencies: { '@deepseek-ai/dsh-tools': '=0.2.0-rc.2' } })
    expect(deriveHostCompatibility(declared, '0.2.0-rc.2', HOST_PACKAGES).status).toBe('compatible')
    expect(deriveHostCompatibility(declared, '0.2.0-rc.1', HOST_PACKAGES).status).toBe('incompatible')
    expect(deriveHostCompatibility(declared, '0.2.0-rc.3', HOST_PACKAGES).status).toBe('incompatible')
  })

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

  it('refuses a peer that declared the previous DSH release line (#756 shape)', () => {
    // `^0.1.x` under a 0.2 host: the declared line is behind us, and dsh's own
    // gate — node-semver over the same bounds — refuses the release. The
    // leniency above must not stretch here, or one install produces two
    // contradicting verdicts: compatible in the market, then "installation
    // rejected" from the gate.
    const result = deriveHostCompatibility(facts({
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.1-rc.2' },
    }), '0.2.0-rc.2', HOST_PACKAGES)
    expect(result.status).toBe('incompatible')
    expect(result.basis).toBe('manifest')
    expect(result.requirement).toBe('^0.1.1-rc.2')
  })

  it('still admits a host on the declared line whose prerelease the gate cannot match', () => {
    // The leniency the rule above carves out of: 0.1.2-alpha.2 is on the 0.1
    // line the range named, and fails the range only because the comparator's
    // prerelease sits on the 0.1.1 tuple. That mismatch says nothing about
    // whether the plugin loads, so it stays compatible.
    const result = deriveHostCompatibility(facts({
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.1-rc.2' },
    }), '0.1.2-alpha.2', HOST_PACKAGES)
    expect(result.status).toBe('compatible')
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

  it('judges a partial bound the way the gate does instead of calling it unknown', () => {
    // `<0.3` is the connector-family shape satisfiesRange learned to read in
    // #1130; discovery parsed only full X.Y.Z bounds and fell back to unknown.
    const partial = facts({ peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.5 <0.3' } })
    const full = facts({ peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.5 <0.3.0' } })
    for (const host of ['0.1.2', '0.3.1']) {
      expect(deriveHostCompatibility(partial, host, HOST_PACKAGES).status).toBe('incompatible')
      expect(deriveHostCompatibility(full, host, HOST_PACKAGES).status).toBe('incompatible')
    }
    expect(deriveHostCompatibility(partial, '0.2.4', HOST_PACKAGES).status).toBe('compatible')
    // `<0.3` ends before 0.3.0's prereleases, as node-semver's `<0.3.0-0` does.
    expect(deriveHostCompatibility(partial, '0.3.0-rc.1', HOST_PACKAGES).status).toBe('incompatible')
    expect(deriveHostCompatibility(facts({
      peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.2.0-rc.0 <0.3' },
    }), '0.1.7-rc.2', HOST_PACKAGES).status).toBe('incompatible')
  })

  it('keeps a partial caret ceiling as lenient as a full one', () => {
    // `^0.1` names the 0.1 line like `^0.1.0`: past that line is the #756
    // break, still on it is not a confirmed mismatch.
    const caret = facts({ peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1' } })
    expect(deriveHostCompatibility(caret, '0.2.0-rc.2', HOST_PACKAGES).status).toBe('incompatible')
    expect(deriveHostCompatibility(caret, '0.1.9', HOST_PACKAGES).status).toBe('compatible')
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

  it('retries a raw manifest read instead of reporting an unknown requirement (#1148)', async () => {
    // The report measured exactly this: `raw.githubusercontent.com` answered
    // ECONNRESET with no proxy and 200 through one while the catalog and the
    // registry were fine. One miss used to end the read, and the card then
    // said the host requirement was unknown although the release declares one.
    const directory = mkdtempSync(join(tmpdir(), 'dshm-discovery-'))
    directories.push(directory)
    const cache = join(directory, '.dsh-market', 'discovery.json')
    const urls: string[] = []
    const flaky = async (url: string): Promise<Response> => {
      urls.push(url)
      if (urls.length === 1) throw new Error('read ECONNRESET')
      return new Response(JSON.stringify({
        version: '1.0.0', engines: { dsh: '0.2.2-rc.1' },
      }), { status: 200 })
    }
    const index = new DiscoveryManifestIndex(cache, { fetcher: flaky, now: () => 1_000 })
    const source = { url: 'https://github.com/acme/dsh-notes' } as never
    const facts = (await index.lookupGitHub([source]))['https://github.com/acme/dsh-notes']!
    expect(facts).toMatchObject({ enginesDsh: '0.2.2-rc.1' })
    expect(urls[0]).toBe(urls[1])
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

describe('findCompatibleVersion (#581)', () => {
  const HOST = '0.1.5-rc.3'
  const packument = (versions: Record<string, Record<string, unknown>>): typeof fetch =>
    (async () => new Response(JSON.stringify({ versions }), { status: 200 })) as unknown as typeof fetch

  it('finds the compatible dsh-sidenote release declared with an explicit equality union', () => {
    const legacyRange = '=0.2.0-rc.2 || =0.2.1-rc.2 || =0.2.1-rc.3'
    return expect(findCompatibleVersion(
      'dsh-sidenote', '0.2.0-rc.2', new Set([...HOST_PACKAGES, '@deepseek-ai/dsh-client-ui-primitives']), 'https://registry.example',
      packument({
        '0.7.6': {
          version: '0.7.6',
          engines: { dsh: legacyRange },
          peerDependencies: { '@deepseek-ai/dsh-client-ui-primitives': legacyRange },
        },
        '0.8.0': { version: '0.8.0', engines: { dsh: '>=0.2.1-rc.2 <0.2.2-0' } },
      }),
    )).resolves.toBe('0.7.6')
  })

  it('returns the newest release whose own declaration this host satisfies', () => {
    return expect(findCompatibleVersion(
      'dsh-loop', HOST, HOST_PACKAGES, 'https://registry.example',
      packument({
        '1.0.0': { version: '1.0.0', engines: { dsh: '>=0.1.0' } },
        '1.1.0': { version: '1.1.0', engines: { dsh: '>=0.1.4' } },
        '2.0.0': { version: '2.0.0', engines: { dsh: '>=0.1.7' } },
      }),
    )).resolves.toBe('1.1.0')
  })

  it('skips a release whose requirement cannot be judged rather than calling it compatible', () => {
    // `unknown` is not a small `incompatible`: it is "nobody said". Pinning a
    // release on the strength of a missing declaration is the guess this
    // whole check exists to avoid.
    return expect(findCompatibleVersion(
      'dsh-loop', HOST, HOST_PACKAGES, 'https://registry.example',
      packument({
        '1.0.0': { version: '1.0.0', engines: { dsh: '>=0.1.4' } },
        // No engine, no lockstep peers, and a peer dependency this host does
        // not carry at the version declared.
        '1.1.0': { version: '1.1.0', peerDependencies: { '@deepseek-ai/dsh-tools': '^9.0.0' } },
      }),
    )).resolves.toBe('1.0.0')
  })

  it('honours the floor an update needs, so a downgrade is never offered', () => {
    return expect(findCompatibleVersion(
      'dsh-loop', HOST, HOST_PACKAGES, 'https://registry.example',
      packument({
        '1.0.0': { version: '1.0.0', engines: { dsh: '>=0.1.0' } },
        '1.5.0': { version: '1.5.0', engines: { dsh: '>=0.1.4' } },
        '2.0.0': { version: '2.0.0', engines: { dsh: '>=9.0.0' } },
      }),
      '1.5.0',
    )).resolves.toBeNull()
  })

  it('orders prereleases properly instead of skipping them', () => {
    // The host line is often a prerelease and plugins declare against it by
    // name; skipping prereleases would report "none found" where the answer
    // exists. Ordering is what keeps a release above its own prereleases.
    return expect(findCompatibleVersion(
      'dsh-loop', HOST, HOST_PACKAGES, 'https://registry.example',
      packument({
        '1.0.0-rc.1': { version: '1.0.0-rc.1', engines: { dsh: '>=0.1.0' } },
        '1.0.0': { version: '1.0.0', engines: { dsh: '>=0.1.0' } },
      }),
    )).resolves.toBe('1.0.0')
  })

  it('answers null when the registry cannot be read', () => {
    const failing = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    return expect(findCompatibleVersion('dsh-loop', HOST, HOST_PACKAGES, 'https://registry.example', failing))
      .resolves.toBeNull()
  })
})

describe('lookupVersion', () => {
  // The outer `directories` list belongs to another describe; this one cleans
  // up after itself.
  const temporary: string[] = []
  afterEach(() => {
    for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  /** A cache path of its own, removed after the test. */
  function tempCache(): string {
    const directory = mkdtempSync(join(tmpdir(), 'dshm-discovery-'))
    temporary.push(directory)
    return join(directory, '.dsh-market', 'discovery.json')
  }

  function indexWith(fetcher: (url: string) => Promise<Response>, now = 1_000, cache = tempCache()): DiscoveryManifestIndex {
    return new DiscoveryManifestIndex(cache, { fetcher, now: () => now })
  }

  it('asks the registry for the named release, not for latest', async () => {
    // The install route judges the release it is about to install (#581): a
    // `latest` read refuses the compatible older release the dialog just
    // resolved, so the URL itself is the behaviour under test.
    const urls: string[] = []
    const index = indexWith(async (url) => {
      urls.push(url)
      return new Response(JSON.stringify({ version: '1.0.0', engines: { dsh: '>=0.1.0' } }), { status: 200 })
    })

    expect(await index.lookupVersion('plugin-a', '1.0.0', 'https://registry.example'))
      .toEqual({ version: '1.0.0', enginesDsh: '>=0.1.0', peerDependencies: {} })
    expect(urls).toEqual(['https://registry.example/plugin-a/1.0.0'])
  })

  it('encodes a scoped name and a version npm would reject raw', async () => {
    const urls: string[] = []
    const index = indexWith(async (url) => {
      urls.push(url)
      return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 })
    })

    await index.lookupVersion('@scope/plugin', '1.0.0+build.7', 'https://registry.example')
    expect(urls).toEqual(['https://registry.example/%40scope%2Fplugin/1.0.0%2Bbuild.7'])
  })

  it('stays out of the index, its cache and its failure bookkeeping', async () => {
    // Three reasons, all load-bearing: a version-keyed cache would grow with
    // every release anyone pinned to answer a once-per-install question; a
    // successful version lookup must not become the package's cached facts,
    // because the index answers a DIFFERENT question (latest); and a
    // pre-flight verdict must not decide what the diagnostics panel sees next
    // (#619), so even an unreadable release leaves no failure cooldown.
    const urls: string[] = []
    const cache = tempCache()
    const index = indexWith(async (url) => {
      urls.push(url)
      if (url.endsWith('/does-not-exist')) return new Response('{"error":"not found"}', { status: 404 })
      return new Response(JSON.stringify({ version: url.endsWith('/1.0.0') ? '1.0.0' : '2.0.0' }), { status: 200 })
    }, 1_000, cache)

    expect((await index.lookupVersion('plugin-a', '1.0.0', 'https://registry.example'))?.version).toBe('1.0.0')
    expect(await index.lookupVersion('plugin-a', 'does-not-exist', 'https://registry.example')).toBeNull()
    // The `latest` lookup still goes to the network — nothing was cached for
    // this package, and the 404 left no cooldown behind.
    const latest = await index.lookup(['plugin-a'], 'https://registry.example')
    expect(latest['plugin-a']?.version).toBe('2.0.0')
    expect(urls).toEqual([
      'https://registry.example/plugin-a/1.0.0',
      'https://registry.example/plugin-a/does-not-exist',
      'https://registry.example/plugin-a/latest',
    ])

    // And the durable cache holds the `latest` facts under the package's name,
    // not the pinned release's.
    const again = indexWith(async () => { throw new Error('the durable cache should answer') }, 1_001, cache)
    expect((await again.lookup(['plugin-a'], 'https://registry.example'))['plugin-a']?.version).toBe('2.0.0')
  })

  it('answers null, not a verdict, when the release cannot be read', async () => {
    const offline = indexWith(async () => { throw new Error('offline') })
    expect(await offline.lookupVersion('plugin-a', '1.0.0', 'https://registry.example')).toBeNull()

    const missing = indexWith(async () => new Response('nope', { status: 500 }))
    expect(await missing.lookupVersion('plugin-a', '1.0.0', 'https://registry.example')).toBeNull()

    const malformed = indexWith(async () => new Response('not json', { status: 200 }))
    expect(await malformed.lookupVersion('plugin-a', '1.0.0', 'https://registry.example')).toBeNull()
  })
})
