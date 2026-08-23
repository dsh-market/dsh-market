/**
 * Reading the catalog out of a published npm package.
 *
 * The tar reader is hand-written — the format is 512-byte headers and a
 * reader for one known filename is shorter than the argument for adding a
 * dependency to a plugin's runtime — so it is tested against tarballs built
 * here byte by byte, not against a fixture somebody once generated.
 *
 * The other half is the mirror behaviour that made this route worth building
 * at all: `dist.tarball` is rewritten by mirrors to point at themselves, and
 * FOLLOWING that field rather than composing a URL is what keeps the
 * download on the mirror instead of bouncing back to the origin registry.
 */

import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogFromPackage, fileFromTarball } from '../src/catalog-npm.ts'

const CATALOG = { updated: '2026-08-22', count: 1, categories: {}, plugins: [{ name: 'p' }] }

/** One tar entry: a 512-byte header followed by NUL-padded content. */
function tarEntry(name: string, body: Buffer, type = '0'): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('000644 \0', 100, 8, 'ascii')
  // Octal size, NUL-terminated, exactly as GNU tar writes it.
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
  header.write(type, 156, 1, 'ascii')
  // A correct checksum is not required by this reader, but writing one keeps
  // these fixtures readable by real tar if anyone ever dumps them.
  header.write('        ', 148, 8, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512)
  body.copy(padded)
  return Buffer.concat([header, padded])
}

/** A gzipped tar of the given entries, terminated the way tar terminates. */
function tarball(entries: Array<[string, string] | [string, string, string]>): Buffer {
  const blocks = entries.map(([name, body, type]) => tarEntry(name, Buffer.from(body, 'utf8'), type))
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

describe('fileFromTarball', () => {
  it('finds the file it was asked for, whatever surrounds it', () => {
    const gz = tarball([
      ['package/package.json', '{"name":"x"}'],
      ['package/README.md', '# hi'],
      ['package/plugins.json', JSON.stringify(CATALOG)],
    ])
    expect(JSON.parse(fileFromTarball(gz, 'package/plugins.json')!.toString())).toEqual(CATALOG)
  })

  it('returns null rather than the wrong file when the name is absent', () => {
    const gz = tarball([['package/README.md', '# hi']])
    expect(fileFromTarball(gz, 'package/plugins.json')).toBeNull()
  })

  it('reads content whose length is not a multiple of the block size', () => {
    // The padding arithmetic is the part that silently corrupts everything
    // after the first ragged entry, so the entry before the wanted one is
    // deliberately ragged here.
    const gz = tarball([['package/a.txt', 'x'.repeat(513)], ['package/plugins.json', '{"ok":true}']])
    expect(fileFromTarball(gz, 'package/plugins.json')!.toString()).toBe('{"ok":true}')
  })

  it('skips directory entries with a matching name', () => {
    // A directory header carries a zero size and would otherwise return an
    // empty buffer that parses as nothing.
    const gz = tarball([['package/plugins.json', '', '5'], ['package/plugins.json', '{"real":true}']])
    expect(fileFromTarball(gz, 'package/plugins.json')!.toString()).toBe('{"real":true}')
  })

  it('accepts a NUL type byte, which is also a regular file', () => {
    const gz = tarball([['package/plugins.json', '{"ok":1}', '\0']])
    expect(fileFromTarball(gz, 'package/plugins.json')!.toString()).toBe('{"ok":1}')
  })
})

describe('catalogFromPackage', () => {
  const REGISTRY = 'https://mirror.test/npm'
  let requested: string[] = []

  /** Serve package metadata and a tarball, with the mirror's own rewriting. */
  function stub(options: {
    version?: string
    tarballHost?: string
    entries?: Array<[string, string]>
    metaStatus?: number
    tarStatus?: number
  } = {}): void {
    requested = []
    const version = options.version ?? '2026.8.22'
    const tarballUrl = `${options.tarballHost ?? REGISTRY}/awesome-dsh-plugin/-/awesome-dsh-plugin-${version}.tgz`
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      requested.push(url)
      if (url.endsWith('/latest')) {
        if (options.metaStatus !== undefined) return new Response('no', { status: options.metaStatus })
        return new Response(JSON.stringify({ version, dist: { tarball: tarballUrl } }), { status: 200 })
      }
      if (options.tarStatus !== undefined) return new Response('no', { status: options.tarStatus })
      const entries = options.entries ?? [['package/plugins.json', JSON.stringify(CATALOG)]]
      return new Response(tarball(entries), { status: 200 })
    }))
  }

  beforeEach(() => { vi.unstubAllGlobals() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('reads the catalog and reports the version it came from', async () => {
    stub()
    await expect(catalogFromPackage(REGISTRY, 'awesome-dsh-plugin')).resolves
      .toEqual({ version: '2026.8.22', data: CATALOG })
  })

  it('follows dist.tarball onto the mirror instead of composing an origin URL', async () => {
    // This is the whole reason the npm route works from behind a slow link:
    // a mirror rewrites the field to its own host. Composing a URL from the
    // package name would send the download back to registry.npmjs.org.
    stub({ tarballHost: 'https://mirror.test/npm' })
    await catalogFromPackage(REGISTRY, 'awesome-dsh-plugin')
    expect(requested[1]).toContain('mirror.test')
    expect(requested[1]).not.toContain('registry.npmjs.org')
  })

  it('skips the download when the published version is the one already held', async () => {
    stub({ version: '2026.8.22' })
    const result = await catalogFromPackage(REGISTRY, 'awesome-dsh-plugin', '2026.8.22')
    expect(result).toEqual({ version: '2026.8.22', data: null })
    // Metadata only. Re-fetching a package we already hold would give back
    // most of the bytes this route exists to save.
    expect(requested).toHaveLength(1)
  })

  it('downloads when the published version has moved on', async () => {
    stub({ version: '2026.8.23' })
    const result = await catalogFromPackage(REGISTRY, 'awesome-dsh-plugin', '2026.8.22')
    expect(result.data).toEqual(CATALOG)
    expect(requested).toHaveLength(2)
  })

  for (const [label, options] of [
    ['the metadata is unreadable', { metaStatus: 503 }],
    ['the tarball is unreadable', { tarStatus: 404 }],
    ['the package carries no plugins.json', { entries: [['package/README.md', '# hi']] as Array<[string, string]> }],
  ] as const) {
    it(`throws so the caller can fall back when ${label}`, async () => {
      stub(options)
      await expect(catalogFromPackage(REGISTRY, 'awesome-dsh-plugin')).rejects.toThrow()
    })
  }

  it('throws when the metadata names no tarball at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 })))
    await expect(catalogFromPackage(REGISTRY, 'awesome-dsh-plugin')).rejects.toThrow(/no version or tarball/)
  })
})
