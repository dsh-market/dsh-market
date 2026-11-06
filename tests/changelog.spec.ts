/**
 * Update notes (#294): the commit-tail slicing that turns the catalog's
 * one-size-fits-all probe into a per-user interval, the delivery route
 * (npm package first, origin fallback) with its version-keyed cache, and the
 * never-throws contract of the composed notes — every failure degrades to the
 * next tier, ending in a neutral `kind: 'none'`.
 */

import { gzipSync } from 'node:zlib'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateUpdateNotes, loadUpdateNotes, sliceCommitsAt, sourceWebUrl, updateNotesFor } from '../src/changelog.ts'
import { forgetCatalog } from '../src/registry.ts'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)
const COMMITS = [
  { sha: SHA_C, message: 'third', date: '2026-08-26T03:00:00Z' },
  { sha: SHA_B, message: 'second', date: '2026-08-25T03:00:00Z' },
  { sha: SHA_A, message: 'first', date: '2026-08-24T03:00:00Z' },
]

describe('sliceCommitsAt', () => {
  it('keeps only the commits newer than the installed sha and says the boundary is exact', () => {
    expect(sliceCommitsAt(COMMITS, SHA_B)).toEqual({
      items: [COMMITS[0]],
      found: true,
    })
  })

  it('labels the whole tail as recent when the boundary is outside it', () => {
    // Installed long before any of these commits — or history diverged. Either
    // way nothing here may be presented as "since your version".
    expect(sliceCommitsAt(COMMITS, '0'.repeat(40))).toEqual({ items: COMMITS, found: false })
  })

  it('labels the tail as recent when there is no boundary to seek', () => {
    expect(sliceCommitsAt(COMMITS, null)).toEqual({ items: COMMITS, found: false })
  })
})

describe('loadUpdateNotes', () => {
  const PAYLOAD = { count: 1, updates: { 'https://github.com/o/r': { commits: COMMITS } } }

  /** npm metadata + tarball + origin, each independently breakable. */
  function stub(options: {
    metaStatus?: number
    tarEntries?: Array<[string, string]>
    originStatus?: number
    originBody?: unknown
    /** `dist.tarball` exactly as the registry answers it; absolute by default. */
    tarball?: string
  } = {}): void {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      // Real fetch refuses a relative URL before any request is made.
      if (!URL.canParse(url)) throw new TypeError(`Failed to parse URL from ${url}`)
      if (url.endsWith('/dsh-plugin-updates/latest')) {
        if (options.metaStatus !== undefined) return new Response('no', { status: options.metaStatus })
        return new Response(JSON.stringify({
          version: '2026.8.26.1',
          dist: { tarball: options.tarball ?? `${url.replace(/\/latest$/, '')}/-/dsh-plugin-updates-2026.8.26.1.tgz` },
        }), { status: 200 })
      }
      if (url.includes('.tgz')) {
        const blocks = (options.tarEntries ?? [['package/updates.json', JSON.stringify(PAYLOAD)]])
          .map(([name, body]) => {
            const header = Buffer.alloc(512)
            header.write(name, 0, 100, 'utf8')
            header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
            let sum = 0
            for (const byte of header) sum += byte
            header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
            const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512)
            padded.write(body, 0, 'utf8')
            return Buffer.concat([header, padded])
          })
        return new Response(gzipSync(Buffer.concat(blocks)), { status: 200 })
      }
      if (url.endsWith('updates.json')) {
        if (options.originStatus !== undefined) return new Response('no', { status: options.originStatus })
        return new Response(JSON.stringify(options.originBody ?? PAYLOAD), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }))
  }

  beforeEach(() => {
    invalidateUpdateNotes()
    vi.unstubAllGlobals()
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('reads the package on the region registry', async () => {
    stub()
    await expect(loadUpdateNotes(true)).resolves.toEqual(PAYLOAD)
  })

  it('resolves a relative dist.tarball against the registry (#1117)', async () => {
    // Registries mounted under a path prefix (Nexus, Verdaccio, reverse
    // proxies) answer with a relative tarball. Fetched as is, it threw, and
    // the notes came from the origin copy with nothing logged.
    stub({ tarball: '/dsh-plugin-updates/-/dsh-plugin-updates-2026.8.26.1.tgz' })
    await expect(loadUpdateNotes(true)).resolves.toEqual(PAYLOAD)
    const urls = vi.mocked(globalThis.fetch).mock.calls.map(c => String(c[0]))
    expect(urls.filter(u => u.includes('.tgz'))).toHaveLength(1)
    expect(urls.find(u => u.includes('.tgz'))).toMatch(/^https?:\/\/[^/]+\/dsh-plugin-updates\/-\//u)
    expect(urls.filter(u => u.endsWith('updates.json'))).toHaveLength(0)
  })

  it('falls back to the origin copy when the package cannot be read', async () => {
    stub({ metaStatus: 404 })
    await expect(loadUpdateNotes(true)).resolves.toEqual(PAYLOAD)
  })

  it('serves the cache instead of re-fetching within the TTL', async () => {
    stub()
    await loadUpdateNotes(true)
    const fetchMock = vi.mocked(globalThis.fetch)
    await loadUpdateNotes()
    expect(fetchMock).toHaveBeenCalledTimes(2) // metadata + tarball, once
  })

  it('gives up loudly only after both sources have each had two tries', async () => {
    stub({ metaStatus: 503, originStatus: 503 })
    await expect(loadUpdateNotes(true)).rejects.toThrow()
    const urls = vi.mocked(globalThis.fetch).mock.calls.map(c => String(c[0]))
    expect(urls.filter(u => u.includes('/latest'))).toHaveLength(2)
    expect(urls.filter(u => u.endsWith('updates.json'))).toHaveLength(2)
  })
})

describe('updateNotesFor', () => {
  function writeProfile(dir: string, dependencies: Record<string, string>, lockCommits?: Array<[string, string]>): void {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies }))
    if (lockCommits !== undefined) {
      const lines = lockCommits.map(([repo, sha]) =>
        `  codeload.github.com/${repo}/tar.gz/${sha}`)
      writeFileSync(join(dir, 'pnpm-lock.yaml'),
        `lockfileVersion: '9.0'\n\nsnapshots:\n${lines.join('\n')}\n`)
    }
  }

  /** Serve the updates payload via origin, plus whatever HEAD asks for. */
  function stubWorld(options: { headSha?: string; payload?: object; originStatus?: number }): void {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/dsh-plugin-updates/latest')) return new Response('no', { status: 404 })
      if (url.endsWith('updates.json')) {
        if (options.originStatus !== undefined) return new Response('no', { status: options.originStatus })
        return new Response(JSON.stringify(options.payload ?? {}), { status: 200 })
      }
      if (url.includes('/commits/HEAD')) {
        return new Response(JSON.stringify({ sha: options.headSha ?? null }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }))
  }

  let dir: string
  beforeEach(() => {
    invalidateUpdateNotes()
    forgetCatalog()
    vi.unstubAllGlobals()
    dir = mkdtempSync(join(tmpdir(), 'dshm-notes-'))
  })
  afterEach(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) })

  it('slices release-less repos at the installed sha read from the lockfile', async () => {
    writeProfile(dir, { 'some-plugin': 'github:o/r' }, [['o/r', SHA_B]])
    stubWorld({ headSha: SHA_C, payload: { count: 1, updates: { 'https://github.com/o/r': { commits: COMMITS } } } })
    await expect(updateNotesFor('web', dir, 'some-plugin')).resolves.toEqual({
      kind: 'commits',
      commits: { items: [{ sha: SHA_C, message: 'third', date: '2026-08-26T03:00:00Z' }], found: true },
    })
  })

  it('prefers an author-written release over the commit tail', async () => {
    writeProfile(dir, { 'some-plugin': 'github:o/r' }, [['o/r', SHA_A]])
    stubWorld({
      headSha: 'c',
      payload: {
        count: 1,
        updates: {
          'https://github.com/o/r': {
            release: { tag: 'v2.0.0', name: 'big rewrite', publishedAt: '2026-08-26T00:00:00Z', url: 'https://github.com/o/r/releases/v2.0.0', body: 'notes here' },
            commits: COMMITS,
          },
        },
      },
    })
    const notes = await updateNotesFor('web', dir, 'some-plugin')
    expect(notes.kind).toBe('release')
    expect(notes.release?.body).toBe('notes here')
  })

  it('falls back to the commit tail when the release is not newer than the install (#925)', async () => {
    // The feed is a daily snapshot; the update target is live from npm. So
    // the snapshot's newest release is often what the user already runs —
    // here v2.0.0 against an installed 2.0.0 — and showing it next to
    // "2.0.0 → 2.1.0" describes a change they already have.
    writeProfile(dir, { 'some-plugin': 'github:o/r' }, [['o/r', SHA_B]])
    mkdirSync(join(dir, 'node_modules', 'some-plugin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'some-plugin', 'package.json'), '{"name":"some-plugin","version":"2.0.0"}')
    stubWorld({
      headSha: SHA_C,
      payload: {
        count: 1,
        updates: {
          'https://github.com/o/r': {
            release: { tag: 'v2.0.0', name: 'old news', publishedAt: '2026-08-26T00:00:00Z', url: 'https://github.com/o/r/releases/v2.0.0', body: 'already installed' },
            commits: COMMITS,
          },
        },
      },
    })
    const notes = await updateNotesFor('web', dir, 'some-plugin')
    // The commit tail is sliced at this install's sha, so it describes what
    // actually changed since.
    expect(notes.kind).toBe('commits')
    expect(notes.commits?.items.map(commit => commit.sha)).toEqual([SHA_C])
  })

  it('still prefers a release that IS newer than the installed version (#925)', async () => {
    writeProfile(dir, { 'some-plugin': 'github:o/r' }, [['o/r', SHA_B]])
    mkdirSync(join(dir, 'node_modules', 'some-plugin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'some-plugin', 'package.json'), '{"name":"some-plugin","version":"1.0.0"}')
    stubWorld({
      headSha: SHA_C,
      payload: {
        count: 1,
        updates: {
          'https://github.com/o/r': {
            release: { tag: 'v2.0.0', name: 'big rewrite', publishedAt: '2026-08-26T00:00:00Z', url: 'https://github.com/o/r/releases/v2.0.0', body: 'notes here' },
            commits: COMMITS,
          },
        },
      },
    })
    const notes = await updateNotesFor('web', dir, 'some-plugin')
    expect(notes.kind).toBe('release')
    expect(notes.release?.body).toBe('notes here')
  })

  it('calls the notes unavailable, not missing, when nothing answers at all', async () => {
    writeProfile(dir, { 'some-plugin': 'github:o/r' })
    stubWorld({ originStatus: 500, headSha: null })
    await expect(updateNotesFor('web', dir, 'some-plugin')).resolves.toEqual({
      kind: 'source', reason: 'unavailable', sourceUrl: 'https://github.com/o/r',
    })
  })

  it('does not consult the catalog when a github root install has no probe data', async () => {
    writeProfile(dir, { 'some-plugin': 'github:o/r' })
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/dsh-plugin-updates/latest')) return new Response('no', { status: 404 })
      if (url.endsWith('updates.json')) return new Response(JSON.stringify({ count: 0, updates: {} }), { status: 200 })
      if (url.includes('plugins.json') || url.includes('dsh-plugin-catalog')) {
        return new Response(JSON.stringify({
          plugins: [{ name: 'some-plugin', npm: 'some-plugin', url: 'https://github.com/o/r', category: 'utility' }],
        }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(updateNotesFor('web', dir, 'some-plugin')).resolves.toEqual({
      kind: 'source', reason: 'missing', sourceUrl: 'https://github.com/o/r',
    })
    const urls = fetchMock.mock.calls.map(call => String(call[0]))
    expect(urls.some(url => url.includes('plugins.json') || url.includes('dsh-plugin-catalog'))).toBe(false)
  })

  it('treats locally linked plugins as having no notes rather than asking anything', async () => {
    writeProfile(dir, { 'local-plugin': 'link:/somewhere' })
    const fetchMock = vi.fn(async () => new Response('no', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(updateNotesFor('web', dir, 'local-plugin')).resolves.toEqual({ kind: 'none' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back to catalog lookup when spec is an npm package name', async () => {
    writeProfile(dir, { 'npm-plugin': '@scope/my-plugin' }, [['owner/repo', SHA_B]])
    const payload = { count: 1, updates: { 'https://github.com/owner/repo': { commits: COMMITS } } }
    // Mock both the updates payload AND the catalog fetch
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/dsh-plugin-updates/latest')) return new Response('no', { status: 404 })
      if (url.endsWith('updates.json')) {
        return new Response(JSON.stringify(payload), { status: 200 })
      }
      if (url.includes('/commits/HEAD')) {
        return new Response(JSON.stringify({ sha: SHA_C }), { status: 200 })
      }
      // Catalog fetch - return plugins.json with matching npm name
      // Global region uses https://awesome-dsh-plugin.com/plugins.json
      if (url.includes('awesome-dsh-plugin.com') || url.includes('dsh-plugin-catalog')) {
        return new Response(JSON.stringify({
          plugins: [{ name: 'npm-plugin', npm: '@scope/my-plugin', url: 'https://github.com/owner/repo', category: 'utility' }],
        }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }))
    await expect(updateNotesFor('web', dir, 'npm-plugin')).resolves.toEqual({
      kind: 'commits',
      commits: { items: [{ sha: SHA_C, message: 'third', date: '2026-08-26T03:00:00Z' }], found: true },
    })
  })

  it('uses Release asset URL directly when spec is a Release asset tarball URL', async () => {
    const releaseAssetUrl = 'https://github.com/owner/repo/releases/latest/download/plugin-1.0.0.tgz'
    writeProfile(dir, { 'release-asset-plugin': releaseAssetUrl }, [['owner/repo', SHA_B]])
    const payload = { count: 1, updates: { 'https://github.com/owner/repo': { commits: COMMITS } } }
    stubWorld({ headSha: SHA_C, payload })
    await expect(updateNotesFor('web', dir, 'release-asset-plugin')).resolves.toEqual({
      kind: 'commits',
      commits: { items: [{ sha: SHA_C, message: 'third', date: '2026-08-26T03:00:00Z' }], found: true },
    })
  })

  it('prefers the catalog entry whose repository matches the installed npm package over a same-named entry (#598)', async () => {
    writeProfile(dir, { 'dsh-cost-meter': '^1.7.21' }, [['han-1413141/dsh-cost-meter', SHA_B]])
    mkdirSync(join(dir, 'node_modules', 'dsh-cost-meter'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'dsh-cost-meter', 'package.json'), JSON.stringify({
      name: 'dsh-cost-meter',
      version: '1.7.21',
      repository: { type: 'git', url: 'git+https://github.com/Han-1413141/dsh-cost-meter.git' },
    }))
    const payload = {
      count: 1,
      updates: { 'https://github.com/han-1413141/dsh-cost-meter': { commits: COMMITS } },
    }
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/dsh-plugin-updates/latest')) return new Response('no', { status: 404 })
      if (url.endsWith('updates.json')) return new Response(JSON.stringify(payload), { status: 200 })
      if (url.includes('/commits/HEAD')) return new Response(JSON.stringify({ sha: SHA_C }), { status: 200 })
      if (url.includes('awesome-dsh-plugin.com') || url.includes('plugins.json')) {
        // Two same-named entries; the first one's repo is unrelated to the
        // installed package, so a bare name match would hit it and report
        // "no notes" (#598).
        return new Response(JSON.stringify({
          plugins: [
            { name: 'dsh-cost-meter', npm: 'dsh-cost-meter', url: 'https://github.com/GooDAnDReaDY/dsh-cost-meter', category: 'utility' },
            { name: 'dsh-cost-meter', npm: 'dsh-cost-meter', url: 'https://github.com/Han-1413141/dsh-cost-meter', category: 'utility' },
          ],
        }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }))
    await expect(updateNotesFor('web', dir, 'dsh-cost-meter')).resolves.toEqual({
      kind: 'commits',
      commits: { items: [{ sha: SHA_C, message: 'third', date: '2026-08-26T03:00:00Z' }], found: true },
    })
  })

  it('answers npm publish times when no catalog entry matches the installed repository (#598)', async () => {
    writeProfile(dir, { 'dsh-cost-meter-nomatch': '^1.7.21' }, [['han-1413141/dsh-cost-meter', SHA_B]])
    mkdirSync(join(dir, 'node_modules', 'dsh-cost-meter-nomatch'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'dsh-cost-meter-nomatch', 'package.json'), JSON.stringify({
      name: 'dsh-cost-meter-nomatch',
      version: '1.7.21',
      repository: { type: 'git', url: 'git+https://github.com/Han-1413141/dsh-cost-meter.git' },
    }))
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/dsh-plugin-updates/latest')) return new Response('no', { status: 404 })
      if (url.endsWith('updates.json')) return new Response(JSON.stringify({}), { status: 200 })
      if (url.includes('/commits/HEAD')) return new Response(JSON.stringify({ sha: SHA_C }), { status: 200 })
      if (url.includes('awesome-dsh-plugin.com') || url.includes('plugins.json')) {
        // Same-named entries, neither matching the installed repository.
        return new Response(JSON.stringify({
          plugins: [
            { name: 'dsh-cost-meter-nomatch', npm: 'dsh-cost-meter-nomatch', url: 'https://github.com/GooDAnDReaDY/dsh-cost-meter', category: 'utility' },
            { name: 'dsh-cost-meter-nomatch', npm: 'dsh-cost-meter-nomatch', url: 'https://github.com/Sttrevens/dsh-cost-meter', category: 'utility' },
          ],
        }), { status: 200 })
      }
      if (url.includes('registry.npmjs.org') || url.includes('/dsh-cost-meter-nomatch')) {
        return new Response(JSON.stringify({
          time: { created: '2025-01-01T00:00:00Z', modified: '2026-09-01T00:00:00Z', '1.7.21': '2026-08-01T00:00:00Z', '1.7.22': '2026-09-02T00:00:00Z' },
        }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }))
    const notes = await updateNotesFor('web', dir, 'dsh-cost-meter-nomatch')
    expect(notes.kind).toBe('npm')
    expect(notes.npmTimes?.[0]).toEqual({ version: '1.7.22', date: '2026-09-02T00:00:00Z' })
  })

  const RELEASE = {
    tag: 'v2.3.2',
    name: '2.3.2',
    publishedAt: '2026-09-25T08:32:29Z',
    url: 'https://github.com/owner/monorepo/releases/tag/v2.3.2',
    body: 'tail is clickable again',
  }
  const TREE = 'https://github.com/owner/monorepo/tree/main/packages/pet'

  function stubCatalog(payload: object, plugins: object[], times?: Record<string, string>): void {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/dsh-plugin-updates/latest')) return new Response('no', { status: 404 })
      if (url.endsWith('updates.json')) return new Response(JSON.stringify(payload), { status: 200 })
      if (url.includes('awesome-dsh-plugin.com') || url.includes('plugins.json') || url.includes('dsh-plugin-catalog')) {
        return new Response(JSON.stringify({ plugins }), { status: 200 })
      }
      if (times !== undefined && url.includes('registry.npmjs.org')) {
        return new Response(JSON.stringify({ time: times }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }))
  }

  it('reads release notes for an npm install whose catalog name carries a subpath (#746)', async () => {
    writeProfile(dir, { 'dsh-pet': '^2.3.2' })
    stubCatalog(
      { count: 1, updates: { [TREE]: { release: RELEASE } } },
      [{ name: 'monorepo#pet', npm: 'dsh-pet', url: TREE, category: 'utility' }],
    )
    const notes = await updateNotesFor('web', dir, 'dsh-pet')
    expect(notes.kind).toBe('release')
    expect(notes.release?.body).toBe(RELEASE.body)
  })

  it('reads notes for an npm install whose catalog name is not the scoped package name (#746)', async () => {
    const url = 'https://github.com/owner/dsh-memory'
    writeProfile(dir, { '@scope/dsh-memory': '^1.0.0' })
    stubCatalog(
      { count: 1, updates: { [url]: { release: RELEASE } } },
      [{ name: 'dsh-memory', npm: '@scope/dsh-memory', url, category: 'utility' }],
    )
    await expect(updateNotesFor('web', dir, '@scope/dsh-memory')).resolves.toMatchObject({
      kind: 'release',
      release: { body: RELEASE.body },
    })
  })

  it('prefers the catalog row whose npm field is the installed package (#746)', async () => {
    writeProfile(dir, { 'dsh-pet': '^2.3.2' })
    stubCatalog(
      {
        count: 2,
        updates: {
          'https://github.com/other/dsh-pet': { release: { ...RELEASE, body: 'someone else' } },
          [TREE]: { release: RELEASE },
        },
      },
      [
        { name: 'dsh-pet', npm: 'other-pkg', url: 'https://github.com/other/dsh-pet', category: 'utility' },
        { name: 'monorepo#pet', npm: 'dsh-pet', url: TREE, category: 'utility' },
      ],
    )
    const notes = await updateNotesFor('web', dir, 'dsh-pet')
    expect(notes.kind).toBe('release')
    expect(notes.release?.body).toBe(RELEASE.body)
  })

  it('keeps npm publish times when the matching catalog row has no probe data (#746)', async () => {
    writeProfile(dir, { 'dsh-pet-empty': '^2.3.2' })
    stubCatalog(
      { count: 0, updates: {} },
      [{ name: 'monorepo#pet', npm: 'dsh-pet-empty', url: TREE, category: 'utility' }],
      { created: '2025-01-01T00:00:00Z', modified: '2026-09-01T00:00:00Z', '2.3.2': '2026-09-25T00:00:00Z' },
    )
    const notes = await updateNotesFor('web', dir, 'dsh-pet-empty')
    expect(notes.kind).toBe('npm')
    expect(notes.npmTimes?.[0]).toEqual({ version: '2.3.2', date: '2026-09-25T00:00:00Z' })
  })

  it('slices a subpath entry\'s commits at the repository recorded in the lockfile (#746)', async () => {
    writeProfile(dir, { 'dsh-pet': '^2.3.2' }, [['owner/monorepo', SHA_B]])
    stubCatalog(
      { count: 1, updates: { [TREE]: { commits: COMMITS } } },
      [{ name: 'monorepo#pet', npm: 'dsh-pet', url: TREE, category: 'utility' }],
    )
    await expect(updateNotesFor('web', dir, 'dsh-pet')).resolves.toEqual({
      kind: 'commits',
      commits: { items: [{ sha: SHA_C, message: 'third', date: '2026-08-26T03:00:00Z' }], found: true },
    })
  })

  it('reads the tree-url notes for a github subpath install (#746)', async () => {
    writeProfile(dir, { 'dsh-pet': 'github:owner/monorepo#path:/packages/pet' })
    stubCatalog(
      { count: 1, updates: { [TREE]: { release: RELEASE } } },
      [
        { name: 'monorepo#pet', npm: 'dsh-pet', url: TREE, category: 'utility' },
        { name: 'monorepo#other', npm: 'dsh-other', url: 'https://github.com/owner/monorepo/tree/main/packages/other', category: 'utility' },
      ],
    )
    const notes = await updateNotesFor('web', dir, 'dsh-pet')
    expect(notes.kind).toBe('release')
    expect(notes.release?.body).toBe(RELEASE.body)
  })

  it('does not use a sibling subpath when the installed path has no notes (#746)', async () => {
    const other = 'https://github.com/owner/monorepo/tree/main/packages/other'
    writeProfile(dir, { 'dsh-pet': 'github:owner/monorepo#path:/packages/pet' })
    stubCatalog(
      { count: 1, updates: { [other]: { release: RELEASE } } },
      [
        { name: 'monorepo#pet', npm: 'dsh-pet', url: TREE, category: 'utility' },
        { name: 'monorepo#other', npm: 'dsh-other', url: other, category: 'utility' },
      ],
    )
    await expect(updateNotesFor('web', dir, 'dsh-pet')).resolves.toEqual({
      kind: 'source', reason: 'missing', sourceUrl: 'https://github.com/owner/monorepo',
    })
  })

  it('says "no notes" only when the probe ran and found nothing', async () => {
    writeProfile(dir, { 'some-plugin': 'github:o/r' })
    stubWorld({ payload: { count: 1, updates: { 'https://github.com/o/r': { commits: [] } } } })
    await expect(updateNotesFor('web', dir, 'some-plugin')).resolves.toEqual({ kind: 'none' })
  })
})

/**
 * #819: a plugin installed from gitee showed the publish times of an
 * unrelated npm package that happens to share its name. Only an npm install
 * may be answered from npm; every other source is pointed at instead.
 */
describe('updateNotesFor — sources other than npm (#819)', () => {
  const GITEE = 'git+https://gitee.com/iJetLi/deepseek-harness-codearts.git'
  let dir: string

  /** Origin payload, catalog and npm, recording every URL asked for. */
  function stubAll(options: { payload?: object; plugins?: object[]; times?: Record<string, string> } = {}): () => string[] {
    const asked: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      asked.push(url)
      if (url.endsWith('/dsh-plugin-updates/latest')) return new Response('no', { status: 404 })
      if (url.endsWith('updates.json')) return new Response(JSON.stringify(options.payload ?? { count: 0, updates: {} }), { status: 200 })
      if (url.includes('awesome-dsh-plugin.com') || url.includes('plugins.json') || url.includes('dsh-plugin-catalog')) {
        return new Response(JSON.stringify({ plugins: options.plugins ?? [] }), { status: 200 })
      }
      if (url.includes('registry.npmjs.org')) {
        return new Response(JSON.stringify({ time: options.times ?? { '1.0.261007': '2026-10-07T00:00:00Z' } }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }))
    return () => asked
  }

  /** Whether npm was asked about `name` itself — not the notes package the market reads. */
  function askedNpmFor(asked: string[], name: string): boolean {
    return asked.some(url => url.endsWith(`/${encodeURIComponent(name)}`))
  }

  function writeProfile(dependencies: Record<string, string>, lock?: string): void {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies }))
    if (lock !== undefined) writeFileSync(join(dir, 'pnpm-lock.yaml'), lock)
  }

  beforeEach(() => {
    invalidateUpdateNotes()
    forgetCatalog()
    vi.unstubAllGlobals()
    dir = mkdtempSync(join(tmpdir(), 'dshm-notes-819-'))
  })
  afterEach(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) })

  it('never asks npm about a gitee install, and points at its repository', async () => {
    writeProfile({ 'dsh-codearts-auth': GITEE })
    const asked = stubAll()
    // `unreadable`, not `missing`: the notes feed is built from GitHub, so a
    // gitee install has nothing the market could ever collect. Telling the
    // reader it has "not been collected yet" would be a promise that cannot
    // be kept — the reporter asked for exactly this distinction.
    await expect(updateNotesFor('web', dir, 'dsh-codearts-auth')).resolves.toEqual({
      kind: 'source', reason: 'unreadable', sourceUrl: 'https://gitee.com/iJetLi/deepseek-harness-codearts',
    })
    expect(askedNpmFor(asked(), 'dsh-codearts-auth')).toBe(false)
  })

  it('still points a gitee install at its repository when the notes cannot load', async () => {
    writeProfile({ 'dsh-codearts-auth': GITEE })
    const asked: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      asked.push(String(input))
      return new Response('no', { status: 503 })
    }))
    // Whatever went wrong this time, the answer for this source is the same
    // one it will always be, so it does not turn into "try again later".
    await expect(updateNotesFor('web', dir, 'dsh-codearts-auth')).resolves.toEqual({
      kind: 'source', reason: 'unreadable', sourceUrl: 'https://gitee.com/iJetLi/deepseek-harness-codearts',
    })
    expect(askedNpmFor(asked, 'dsh-codearts-auth')).toBe(false)
  })

  it('keeps "not collected yet" for a GitHub install, which the feed does cover', async () => {
    writeProfile({ 'dsh-other': 'git+https://github.com/someone/dsh-other.git' })
    stubAll()
    await expect(updateNotesFor('web', dir, 'dsh-other')).resolves.toEqual({
      kind: 'source', reason: 'missing', sourceUrl: 'https://github.com/someone/dsh-other',
    })
  })

  it('does not borrow the notes of a same-named catalog plugin from another repository', async () => {
    writeProfile({ 'dsh-codearts-auth': GITEE })
    stubAll({
      payload: { count: 1, updates: { 'https://github.com/weiyou/dsh-codearts-auth': { commits: COMMITS } } },
      plugins: [{ name: 'dsh-codearts-auth', npm: 'dsh-codearts-auth', url: 'https://github.com/weiyou/dsh-codearts-auth', category: 'utility' }],
    })
    await expect(updateNotesFor('web', dir, 'dsh-codearts-auth')).resolves.toMatchObject({ kind: 'source' })
  })

  it('uses the catalog row of the same repository on another host', async () => {
    const url = 'https://gitlab.com/o/r'
    writeProfile({ 'lab-plugin': 'gitlab:o/r' })
    stubAll({
      payload: { count: 1, updates: { [url]: { commits: COMMITS } } },
      plugins: [{ name: 'lab-plugin', npm: 'lab-plugin', url, category: 'utility' }],
    })
    await expect(updateNotesFor('web', dir, 'lab-plugin')).resolves.toMatchObject({ kind: 'commits' })
  })

  it('reads a git+https GitHub install as GitHub, sliced at its cloned commit', async () => {
    const spec = 'git+https://github.com/O/R.git'
    writeProfile({ 'gh-plugin': spec },
      `lockfileVersion: '9.0'\n\npackages:\n  gh-plugin@${spec}:\n    resolution: {commit: ${SHA_B}, repo: https://github.com/O/R.git, type: git}\n`)
    stubAll({ payload: { count: 1, updates: { 'https://github.com/o/r': { commits: COMMITS } } } })
    await expect(updateNotesFor('web', dir, 'gh-plugin')).resolves.toEqual({
      kind: 'commits',
      commits: { items: [{ sha: SHA_C, message: 'third', date: '2026-08-26T03:00:00Z' }], found: true },
    })
  })

  it('reads the tree-url notes of a git+https GitHub subpath install', async () => {
    const tree = 'https://github.com/owner/monorepo/tree/main/packages/pet'
    writeProfile({ 'dsh-pet': 'git+https://github.com/owner/monorepo.git#path:/packages/pet' })
    stubAll({
      payload: { count: 1, updates: { [tree]: { commits: COMMITS } } },
      plugins: [{ name: 'monorepo#pet', npm: 'dsh-pet', url: tree, category: 'utility' }],
    })
    await expect(updateNotesFor('web', dir, 'dsh-pet')).resolves.toMatchObject({ kind: 'commits' })
  })

  it('never asks npm about a tarball URL install', async () => {
    writeProfile({ 'tar-plugin': 'https://example.com/tar-plugin-1.0.0.tgz' })
    const asked = stubAll()
    await expect(updateNotesFor('web', dir, 'tar-plugin')).resolves.toEqual({ kind: 'source', reason: 'missing', sourceUrl: null })
    expect(askedNpmFor(asked(), 'tar-plugin')).toBe(false)
  })

  it('links a GitHub Release asset install to the repository it names', async () => {
    writeProfile({ 'rel-plugin': 'https://github.com/o/r/releases/download/v1/rel-plugin-1.0.0.tgz' })
    const asked = stubAll()
    await expect(updateNotesFor('web', dir, 'rel-plugin')).resolves.toEqual({
      kind: 'source', reason: 'missing', sourceUrl: 'https://github.com/o/r',
    })
    expect(askedNpmFor(asked(), 'rel-plugin')).toBe(false)
  })

  it('treats a catalog: install as npm', async () => {
    writeProfile({ 'cat-plugin': 'catalog:' })
    const asked = stubAll()
    await expect(updateNotesFor('web', dir, 'cat-plugin')).resolves.toMatchObject({ kind: 'npm' })
    expect(askedNpmFor(asked(), 'cat-plugin')).toBe(true)
  })

  it('asks npm about the package an npm: alias really installs', async () => {
    writeProfile({ 'my-alias': 'npm:@scope/real-plugin@^1.0.0' })
    const asked = stubAll()
    const notes = await updateNotesFor('web', dir, 'my-alias')
    expect(notes.kind).toBe('npm')
    expect(askedNpmFor(asked(), '@scope/real-plugin')).toBe(true)
    expect(askedNpmFor(asked(), 'my-alias')).toBe(false)
  })

  it('keeps npm publish times for an ordinary npm install', async () => {
    writeProfile({ 'npm-plugin': '^1.0.0' })
    stubAll()
    await expect(updateNotesFor('web', dir, 'npm-plugin')).resolves.toMatchObject({ kind: 'npm' })
  })
})

describe('sourceWebUrl', () => {
  it.each([
    ['git+https://gitee.com/o/r.git', 'https://gitee.com/o/r'],
    ['git+https://gitee.com/o/r.git#v1.0.0', 'https://gitee.com/o/r'],
    ['git+https://github.com/O/R.git#path:/packages/pet', 'https://github.com/O/R'],
    ['github:o/r#main', 'https://github.com/o/r'],
    ['gitlab:g/s/r', 'https://gitlab.com/g/s/r'],
    ['git@gitee.com:o/r.git', 'https://gitee.com/o/r'],
    ['ssh://git@git.example.com:2222/o/r.git', 'https://git.example.com/o/r'],
    ['git+ssh://git@gitee.com:o/r.git', 'https://gitee.com/o/r'],
    ['git+https://git.sr.ht/~user/repo', 'https://git.sr.ht/~user/repo'],
    ['git+https://gitee.com:8443/o/r.git', 'https://gitee.com:8443/o/r'],
  ])('reads %s as %s', (spec, url) => {
    expect(sourceWebUrl(spec)).toBe(url)
  })

  it('never carries a token from the spec into the link', () => {
    const url = sourceWebUrl('git+https://user:s3cret@gitee.com/o/r.git')
    expect(url).toBe('https://gitee.com/o/r')
  })

  it.each([
    'git+file:///tmp/r.git',
    'git+javascript://x/%0aalert(1)',
    'https://example.com/plugin-1.0.0.tgz',
    '^1.0.0',
  ])('gives no link for %s', (spec) => {
    expect(sourceWebUrl(spec)).toBeNull()
  })
})
