/**
 * Offline bundles: packing (scripts/offline-pack.mjs), importing (src/offline.ts)
 * and what a catalog read from a bundle may install. The import is the one
 * place the market unpacks an archive it did not make, so most of this file is
 * archives built to misbehave.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync as realpathSyncNative, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error -- plain .mjs script, no types
import { makeTar, packBundle } from '../scripts/offline-pack.mjs'
import { loadExtra } from '../src/catalogs.ts'
import { BundleError, extractBundle, isInsideOfflineRoot, MAX_BUNDLE_FILES, offlineRoot, resolveBundleFile } from '../src/offline.ts'
import { installTargetFor } from '../src/sources.ts'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dshm-offline-'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(tmp, { recursive: true, force: true })
})

/** A ustar archive with whatever type flags and names a test wants — the writer in the script only makes good ones. */
function rawTar(entries: Array<{ name: string; data?: Buffer; type?: string }>): Buffer {
  const blocks: Buffer[] = []
  for (const { name, data = Buffer.alloc(0), type = '0' } of entries) {
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write('0000644\0', 100)
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('        ', 148)
    header.write(type, 156)
    header.write('ustar\0', 257)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}
const gz = (entries: Parameters<typeof rawTar>[0]): Buffer => gzipSync(rawTar(entries))
const CATALOG = Buffer.from(JSON.stringify({ plugins: [] }))
const GOOD = [{ name: 'plugins.json', data: CATALOG }, { name: 'tarballs/a-1.0.0.tgz', data: Buffer.from('tgz') }]

describe('importing a bundle', () => {
  it('unpacks the catalog and the package files under the bundle\'s own directory', () => {
    const root = join(tmp, 'offline')
    const out = extractBundle(gz(GOOD), root)
    expect(out.id).toMatch(/^offline-[0-9a-f]{8}$/)
    expect(out.dir).toBe(join(root, out.id))
    expect(readFileSync(join(out.dir, 'plugins.json')).equals(CATALOG)).toBe(true)
    expect(readFileSync(join(out.dir, 'tarballs', 'a-1.0.0.tgz'), 'utf8')).toBe('tgz')
    // nothing else is left behind
    expect(readdirSync(root)).toEqual([out.id])
  })

  it('makes the same directory for the same bundle, and replaces it for a changed one', () => {
    const root = join(tmp, 'offline')
    const first = extractBundle(gz(GOOD), root)
    expect(extractBundle(gz(GOOD), root).dir).toBe(first.dir)
    expect(extractBundle(gz([...GOOD, { name: 'tarballs/b-1.0.0.tgz', data: Buffer.from('b') }]), root).dir).not.toBe(first.dir)
  })

  it.each([
    ['an absolute path', [{ name: '/etc/cron.d/x', data: Buffer.from('x') }]],
    ['a dot-dot segment', [{ name: 'tarballs/../../escape.tgz', data: Buffer.from('x') }]],
    ['a leading dot-dot', [{ name: '../escape.tgz', data: Buffer.from('x') }]],
    ['a backslash', [{ name: 'tarballs\\evil.tgz', data: Buffer.from('x') }]],
    ['a drive letter', [{ name: 'C:/evil.tgz', data: Buffer.from('x') }]],
  ])('refuses %s, and writes nothing', (_label, extra) => {
    const root = join(tmp, 'offline')
    expect(() => extractBundle(gz([...GOOD, ...extra]), root)).toThrow(BundleError)
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([])
    expect(existsSync(join(tmp, 'escape.tgz'))).toBe(false)
  })

  it.each([['a symlink', '2'], ['a hard link', '1'], ['a character device', '3'], ['a fifo', '6']])('refuses %s', (_label, type) => {
    const root = join(tmp, 'offline')
    expect(() => extractBundle(gz([...GOOD, { name: 'tarballs/link.tgz', type }]), root)).toThrowError(/not a plain file/)
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([])
  })

  it('refuses anything outside the two places a bundle uses', () => {
    for (const name of ['evil.sh', 'tarballs/sub/x.tgz', 'tarballs/readme.txt', 'node_modules/x.tgz', 'plugins.json.bak']) {
      expect(() => extractBundle(gz([...GOOD, { name, data: Buffer.from('x') }]), join(tmp, 'offline')), name).toThrowError(/not part of a bundle/)
    }
  })

  it('refuses a bundle with no catalog, or with a file twice, or with nothing in it', () => {
    expect(() => extractBundle(gz([{ name: 'tarballs/a-1.0.0.tgz', data: Buffer.from('x') }]), join(tmp, 'o'))).toThrowError(/plugins.json is missing/)
    expect(() => extractBundle(gz([...GOOD, GOOD[0]!]), join(tmp, 'o'))).toThrowError(/appears twice/)
    expect(() => extractBundle(gz([]), join(tmp, 'o'))).toThrowError(/no files/)
  })

  it('refuses what is not a gzip archive, or is cut short', () => {
    expect(() => extractBundle(Buffer.from('just some text'), join(tmp, 'o'))).toThrowError(BundleError)
    const cut = gz(GOOD)
    expect(() => extractBundle(cut.subarray(0, 40), join(tmp, 'o'))).toThrowError(BundleError)
  })

  it('caps the number of files', () => {
    const many = [GOOD[0]!, ...Array.from({ length: MAX_BUNDLE_FILES + 1 }, (_, index) => ({ name: `tarballs/p${String(index)}.tgz`, data: Buffer.from('x') }))]
    expect(() => extractBundle(gz(many), join(tmp, 'o'))).toThrowError(/files/)
  })

  it('keeps imported bundles under DSH_HOME, and knows which paths are theirs', () => {
    vi.stubEnv('DSH_HOME', join(tmp, 'home'))
    expect(offlineRoot()).toBe(join(tmp, 'home', 'dsh-market', 'offline'))
    expect(isInsideOfflineRoot(join(tmp, 'home', 'dsh-market', 'offline', 'offline-1', 'plugins.json'))).toBe(true)
    expect(isInsideOfflineRoot(join(tmp, 'home', 'dsh-market', 'offline-evil', 'x'))).toBe(false)
    expect(isInsideOfflineRoot(join(tmp, 'home', 'dsh-market', 'offline', '..', 'telemetry.json'))).toBe(false)
  })
})

describe('resolving a tarball path inside a bundle', () => {
  function bundle(): string {
    const dir = join(tmp, 'bundle')
    mkdirSync(join(dir, 'tarballs'), { recursive: true })
    writeFileSync(join(dir, 'tarballs', 'a-1.0.0.tgz'), 'a')
    return dir
  }

  it('finds a plain file by the exact shape the packer writes', () => {
    const dir = bundle()
    expect(resolveBundleFile(dir, './tarballs/a-1.0.0.tgz')).toBe(join(realpathSyncNative(dir), 'tarballs', 'a-1.0.0.tgz'))
    expect(resolveBundleFile(dir, 'tarballs/a-1.0.0.tgz')).not.toBeNull()
  })

  it.each([
    '/etc/passwd', '../outside.tgz', './tarballs/../../outside.tgz', './tarballs/sub/a.tgz', './tarballs/a-1.0.0.tgz/', './other/a.tgz',
    './tarballs/missing.tgz', 'https://host/a.tgz', '', 42, null,
  ])('refuses %j', (value) => {
    expect(resolveBundleFile(bundle(), value)).toBeNull()
  })

  it('refuses a file that is a link, even one pointing at a real file inside', () => {
    const dir = bundle()
    symlinkSync(join(dir, 'tarballs', 'a-1.0.0.tgz'), join(dir, 'tarballs', 'link.tgz'))
    expect(resolveBundleFile(dir, './tarballs/link.tgz')).toBeNull()
  })

  it('refuses a tarballs directory that is a link to somewhere else', () => {
    const outside = join(tmp, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'x.tgz'), 'x')
    const dir = join(tmp, 'linked')
    mkdirSync(dir)
    symlinkSync(outside, join(dir, 'tarballs'))
    expect(resolveBundleFile(dir, './tarballs/x.tgz')).toBeNull()
  })
})

describe('a catalog read from a bundle', () => {
  const source = (file: string) => ({ id: 'bundle', kind: 'user' as const, label: { zh: 'b', en: 'b' }, file, headers: {} })

  function unpack(plugins: unknown[]): string {
    const dir = join(tmp, 'unpacked')
    mkdirSync(join(dir, 'tarballs'), { recursive: true })
    writeFileSync(join(dir, 'tarballs', 'a-1.0.0.tgz'), 'a')
    writeFileSync(join(dir, 'plugins.json'), JSON.stringify({ label: 'Acme bundle', plugins }))
    return dir
  }
  const entry = (extra: Record<string, unknown>) => ({ name: 'a', url: 'https://repo.acme.internal/a', category: 'tools', description: 'A', ...extra })

  it('gives an entry the absolute path of its package file, and installs from it', async () => {
    const dir = unpack([entry({ tarball: './tarballs/a-1.0.0.tgz', version: '1.0.0' })])
    const result = await loadExtra(source(dir))
    expect(result.info).toMatchObject({ status: 'ok', count: 1, offline: true })
    const plugin = result.registry!.plugins[0]!
    expect(plugin.offlineTarball).toBe(join(realpathSyncNative(dir), 'tarballs', 'a-1.0.0.tgz'))
    expect(plugin).not.toHaveProperty('tarball')
    expect(installTargetFor({ ...plugin, source: { id: 'bundle' } })).toBe(`file:${plugin.offlineTarball}`)
  })

  it('reads a directory as an unpacked bundle, and a file inside it the same way', async () => {
    const dir = unpack([entry({ tarball: './tarballs/a-1.0.0.tgz' })])
    expect((await loadExtra(source(dir))).info.count).toBe(1)
    expect((await loadExtra(source(join(dir, 'plugins.json')))).info.count).toBe(1)
  })

  it('skips an entry whose package file is not a plain file inside the bundle, instead of reading it', async () => {
    const dir = unpack([
      entry({ name: 'good', url: 'https://repo.acme.internal/good', tarball: './tarballs/a-1.0.0.tgz' }),
      entry({ name: 'up', url: 'https://repo.acme.internal/up', tarball: './tarballs/../../../etc/passwd' }),
      entry({ name: 'abs', url: 'https://repo.acme.internal/abs', tarball: '/etc/passwd' }),
      entry({ name: 'gone', url: 'https://repo.acme.internal/gone', tarball: './tarballs/missing.tgz' }),
    ])
    const result = await loadExtra(source(dir))
    expect(result.registry!.plugins.map(p => p.name)).toEqual(['good'])
    expect(result.info.skipped).toBe(3)
  })

  it('does not let a catalog set the path itself', async () => {
    const dir = unpack([entry({ offlineTarball: '/etc/passwd' })])
    const plugin = (await loadExtra(source(dir))).registry!.plugins[0]!
    expect(plugin).not.toHaveProperty('offlineTarball')
    expect(installTargetFor({ ...plugin, source: { id: 'bundle' } })).toBeNull()
  })

  it('does not treat a release URL as a bundle file', async () => {
    const dir = unpack([entry({ tarball: 'https://github.com/o/r/releases/latest/download/a.tgz' })])
    const plugin = (await loadExtra(source(dir))).registry!.plugins[0]!
    expect(plugin).not.toHaveProperty('offlineTarball')
  })
})

describe('packing a bundle', () => {
  const tarball = Buffer.from('pretend this is a tarball')
  const dist = { tarball: 'https://registry.example/a/-/a-1.0.0.tgz', integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}` }
  const io = (overrides: Record<string, unknown> = {}) => ({
    registry: 'https://registry.example',
    fetchJson: async () => ({ name: '@acme/badge', version: '1.0.0', dist }),
    fetchBuffer: async () => tarball,
    archiveGit: async () => ({ buffer: Buffer.from('src'), manifest: { name: 'internal', version: '0.3.0' } }),
    ...overrides,
  })

  it('stores each package and rewrites the catalog to point at it, under the package\'s own name', async () => {
    const bundle = await packBundle({ label: 'Acme', plugins: [{ npm: '@acme/badge', name: 'badge', url: 'https://repo.acme.internal/badge', category: 'hr', description: 'Badge' }] }, io())
    expect(bundle.files.map((file: { name: string }) => file.name)).toEqual(['plugins.json', 'tarballs/acme-badge-1.0.0.tgz'])
    const [out] = bundle.catalog.plugins
    expect(out).toMatchObject({ name: '@acme/badge', version: '1.0.0', tarball: './tarballs/acme-badge-1.0.0.tgz', url: 'https://repo.acme.internal/badge' })
    expect(out).not.toHaveProperty('npm')
  })

  it('makes an archive the market imports and reads, end to end', async () => {
    const bundle = await packBundle({ plugins: [{ npm: '@acme/badge', url: 'https://repo.acme.internal/badge', category: 'hr', description: 'Badge' }] }, io())
    const extracted = extractBundle(bundle.archive(), join(tmp, 'offline'))
    const result = await loadExtra({ id: 'b', kind: 'user', label: { zh: 'b', en: 'b' }, file: extracted.catalogFile, headers: {} })
    expect(result.info).toMatchObject({ status: 'ok', count: 1, offline: true })
    const plugin = result.registry!.plugins[0]!
    expect(readFileSync(plugin.offlineTarball!)).toEqual(tarball)
  })

  it('refuses a download that does not match its published checksum', async () => {
    await expect(packBundle({ plugins: [{ npm: '@acme/badge', category: 'hr', description: 'x', url: 'https://x.example' }] }, io({ fetchBuffer: async () => Buffer.from('tampered') })))
      .rejects.toThrow(/entry 1 \(@acme\/badge\).*checksum/)
  })

  it('names the entry when the registry cannot be read, and when an entry says where to get nothing', async () => {
    await expect(packBundle([{ npm: 'x', category: 'a', description: 'x', url: 'https://x.example' }], io({ fetchJson: async () => { throw new Error('HTTP 404') } })))
      .rejects.toThrow(/entry 1 \(x\): HTTP 404/)
    await expect(packBundle([{ name: 'nothing', category: 'a' }], io())).rejects.toThrow(/entry 1: needs "npm" or "git"/)
  })

  it('says which packages still need a registry for their own dependencies, and that a source archive is source', async () => {
    const withDeps = io({ fetchJson: async () => ({ name: 'dsh-x', version: '1.0.0', dist, dependencies: { left: '1', right: '2' } }) })
    const bundle = await packBundle([
      { npm: 'dsh-x', category: 'a', description: 'x', url: 'https://x.example' },
      { git: 'git+https://repo.acme.internal/internal.git#v0.3.0', category: 'a', description: 'y', url: 'https://repo.acme.internal/internal' },
    ], { ...withDeps, archiveGit: io().archiveGit })
    expect(bundle.notes.join('\n')).toMatch(/2 dependencies are not in the bundle/)
    expect(bundle.notes.join('\n')).toMatch(/packed from source/)
    expect(bundle.catalog.plugins[1]).toMatchObject({ name: 'internal', version: '0.3.0' })
  })

  it('writes a tar the importer reads back byte for byte', () => {
    const files = [{ name: 'plugins.json', data: Buffer.from('{}') }, { name: 'tarballs/x.tgz', data: Buffer.alloc(1500, 7) }]
    const extracted = extractBundle(gzipSync(makeTar(files)), join(tmp, 'rt'))
    expect(readFileSync(join(extracted.dir, 'tarballs', 'x.tgz')).equals(files[1]!.data)).toBe(true)
  })
})
