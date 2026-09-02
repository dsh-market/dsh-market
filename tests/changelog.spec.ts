/**
 * Update notes (#294): the commit-tail slicing that turns the catalog's
 * one-size-fits-all probe into a per-user interval, the delivery route
 * (npm package first, origin fallback) with its version-keyed cache, and the
 * never-throws contract of the composed notes — every failure degrades to the
 * next tier, ending in a neutral `kind: 'none'`.
 */

import { gzipSync } from 'node:zlib'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateUpdateNotes, loadUpdateNotes, sliceCommitsAt, updateNotesFor } from '../src/changelog.ts'
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
  } = {}): void {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/dsh-plugin-updates/latest')) {
        if (options.metaStatus !== undefined) return new Response('no', { status: options.metaStatus })
        return new Response(JSON.stringify({
          version: '2026.8.26.1',
          dist: { tarball: `${url.replace(/\/latest$/, '')}/-/dsh-plugin-updates-2026.8.26.1.tgz` },
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

  it('answers none without erroring when nothing answers at all', async () => {
    writeProfile(dir, { 'some-plugin': 'github:o/r' })
    stubWorld({ originStatus: 500, headSha: null })
    await expect(updateNotesFor('web', dir, 'some-plugin')).resolves.toEqual({ kind: 'none' })
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
})
