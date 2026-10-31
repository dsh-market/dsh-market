import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { catalogReleaseManifest, deriveHostCompatibility, DiscoveryManifestIndex } from '../src/discovery-compatibility.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const manifest = { version: '1.2.1', engines: { dsh: '0.2.1-rc.2 || 0.2.1-rc.3' } }
const entry = { url: 'https://github.com/owner/whale/tree/master/packages/host' }
function cacheFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dshm-github-'))
  directories.push(directory)
  return join(directory, 'facts.json')
}

describe('GitHub discovery host requirements', () => {
  it('uses catalog host declarations only for the exact pinned install artifact', () => {
    const source = { url: 'https://github.com/owner/whale', tarball: 'https://github.com/owner/whale/releases/download/v1.3.0/full.tgz' }
    const facts = { tarball: source.tarball, version: '1.3.0', enginesDsh: '0.2.1-rc.5', peerDependencies: {} }
    expect(catalogReleaseManifest({ ...source, releaseManifest: facts })).toMatchObject({ version: '1.3.0', enginesDsh: '0.2.1-rc.5' })
    const result = deriveHostCompatibility(catalogReleaseManifest({ ...source, releaseManifest: facts }), '0.2.1-rc.5', new Set())
    expect(result).toMatchObject({ status: 'compatible', requirement: '0.2.1-rc.5', basis: 'manifest' })
    for (const tarball of [source.tarball.replace('1.3.0', '1.4.0'), source.tarball.replace('/owner/', '/other/'), source.tarball.replace('/download/v1.3.0/', '/latest/download/')])
      expect(catalogReleaseManifest({ ...source, tarball, releaseManifest: facts })).toBeNull()
    expect(catalogReleaseManifest({ ...source, releaseManifest: { ...facts, enginesDsh: 5 } })).toBeNull()
  })

  it('reads the linked monorepo manifest, caches facts and evaluates each host separately', async () => {
    const calls: string[] = []
    const cache = cacheFile()
    const fetcher = async (url: string): Promise<Response> => {
      calls.push(url)
      return Response.json(manifest)
    }
    const index = new DiscoveryManifestIndex(cache, { fetcher })
    const facts = (await index.lookupGitHub([entry]))[entry.url]!
    expect(calls).toEqual(['https://raw.githubusercontent.com/owner/whale/master/packages/host/package.json'])
    expect(deriveHostCompatibility(facts, '0.2.1-rc.2', new Set()).status).toBe('compatible')
    expect(deriveHostCompatibility(facts, '0.2.1-rc.3', new Set()).status).toBe('compatible')
    expect(deriveHostCompatibility(facts, '0.2.1-rc.4', new Set()).status).toBe('incompatible')
    expect(deriveHostCompatibility(facts, '0.2.1-rc.3', new Set()).requirement).toBe(manifest.engines.dsh)
    const fresh = new DiscoveryManifestIndex(cache, { fetcher })
    await fresh.lookupGitHub([entry])
    expect(calls).toHaveLength(1)
  })

  it('reads the selected release tag rather than a newer default branch', async () => {
    const calls: string[] = []
    const index = new DiscoveryManifestIndex(cacheFile(), { fetcher: async (url) => {
      calls.push(url)
      return Response.json(url.includes('/releases/latest') ? { tag_name: 'v1.2.1' } : manifest)
    } })
    const source = { ...entry, tarball: 'https://github.com/owner/whale/releases/latest/download/full.tgz' }
    expect((await index.lookupGitHub([source]))[entry.url]?.enginesDsh).toBe(manifest.engines.dsh)
    expect(calls).toEqual([
      'https://api.github.com/repos/owner/whale/releases/latest',
      'https://raw.githubusercontent.com/owner/whale/v1.2.1/packages/host/package.json',
    ])
    await index.lookupGitHub([{ ...entry, tarball: 'https://github.com/owner/whale/releases/download/v1.2.0/full.tgz' }])
    expect(calls.at(-1)).toBe('https://raw.githubusercontent.com/owner/whale/v1.2.0/packages/host/package.json')
  })

  it('does not read foreign archives or path escapes, or turn a failed read into an undeclared requirement', async () => {
    const calls: string[] = []
    const index = new DiscoveryManifestIndex(cacheFile(), { fetcher: async (url) => {
      calls.push(url)
      return new Response('not found', { status: 404 })
    } })
    const foreign = { ...entry, tarball: 'https://github.com/other/whale/releases/download/v1/full.tgz' }
    const escape = { url: 'https://github.com/owner/whale/tree/main/../other' }
    expect(await index.lookupGitHub([foreign, escape])).toEqual({ [entry.url]: null, [escape.url]: null })
    expect(calls).toEqual([])
    const facts = (await index.lookupGitHub([entry]))[entry.url] ?? null
    expect(deriveHostCompatibility(facts, '0.2.1-rc.3', new Set())).toMatchObject({ status: 'unknown', basis: 'unavailable' })
    expect(calls).toHaveLength(1)
  })
})
