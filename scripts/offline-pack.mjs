#!/usr/bin/env node
/**
 * Pack a private catalog and the package files it lists into one archive, for
 * machines that cannot reach npm.
 *
 *   node scripts/offline-pack.mjs --catalog plugins.json --out acme-offline.tgz
 *
 * `plugins.json` is a catalog (see make-catalog.mjs). For each entry:
 *
 * - `npm`: the release is downloaded from the registry (`version` in the entry,
 *   else `latest`), its integrity checked, and stored as `tarballs/<file>.tgz`.
 *   Scoped names use `@scope:registry=` and the token from ~/.npmrc.
 * - `git`: the repository is cloned (shallow, at the `#ref` if there is one)
 *   and archived as it is. A git archive is SOURCE: it only installs offline
 *   if the repository commits what it runs.
 *
 * The catalog inside the archive has the same entries with `tarball:
 * "./tarballs/<file>.tgz"` and no `npm`/`git`, and `name` set to the package's
 * own name, so the market recognizes the installed plugin. In the market:
 * Settings > Advanced > Plugin catalogs > Import offline bundle. A policy
 * file may also point a catalog `file` at an unpacked copy of the directory.
 *
 * Packages that have dependencies are packed alone and reported: those
 * dependencies are fetched at install time, so the machine still needs a
 * registry for them. Nothing is written back and no token is printed.
 *
 * Options: --registry <url> (default registry for unscoped names)
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { readNpmrc } from './make-catalog.mjs'

/** A minimal ustar writer: regular files only, names well under 100 bytes. */
export function makeTar(files) {
  const blocks = []
  for (const { name, data } of files) {
    if (Buffer.byteLength(name) > 100) throw new Error(`${name}: file name too long for a bundle`)
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136)
    header.write('        ', 148)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

const safeFile = (name, version) => `${name.replace(/^@/u, '').replace(/[/\\]/gu, '-')}-${version}.tgz`.replace(/[^A-Za-z0-9._@+-]/gu, '_')

function checkIntegrity(buffer, dist) {
  if (typeof dist?.integrity === 'string' && dist.integrity.startsWith('sha512-')) {
    return createHash('sha512').update(buffer).digest('base64') === dist.integrity.slice('sha512-'.length)
  }
  if (typeof dist?.shasum === 'string') return createHash('sha1').update(buffer).digest('hex') === dist.shasum
  return true
}

/**
 * Build the bundle's files.
 * @param catalog - parsed catalog (object with `plugins`, or a list).
 * @param io - `{ fetchJson(url, headers), fetchBuffer(url, headers), archiveGit(spec) -> { buffer, manifest }, registry, npmrc, log }`.
 * @returns `{ files, catalog, notes }`
 */
export async function packBundle(catalog, io) {
  const doc = Array.isArray(catalog) ? { plugins: catalog } : catalog
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.plugins)) throw new Error('the catalog must be a list, or an object with a "plugins" list')
  const registry = (io.registry ?? 'https://registry.npmjs.org').replace(/\/+$/u, '')
  const npmrc = io.npmrc ?? { scopes: new Map(), auth: new Map() }
  const notes = []
  const files = []
  const plugins = []
  const used = new Set()
  const nerf = (url) => { const u = new URL(url); return `//${u.host}${u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`}` }
  const headersFor = (url) => {
    const found = [...npmrc.auth].filter(([key]) => nerf(url).startsWith(key)).sort((a, b) => b[0].length - a[0].length)[0]
    return found === undefined ? {} : { authorization: found[1] }
  }
  for (const [index, entry] of doc.plugins.entries()) {
    const where = `entry ${String(index + 1)}`
    let buffer
    let manifest
    if (typeof entry.npm === 'string' && entry.npm !== '') {
      const base = (entry.npm.startsWith('@') ? npmrc.scopes.get(entry.npm.split('/')[0]) : undefined) ?? registry
      const url = `${base}/${encodeURIComponent(entry.npm)}/${encodeURIComponent(typeof entry.version === 'string' && entry.version !== '' ? entry.version : 'latest')}`
      try {
        manifest = await io.fetchJson(url, headersFor(url))
        const tarballUrl = manifest?.dist?.tarball
        if (typeof tarballUrl !== 'string') throw new Error('the registry named no tarball')
        buffer = await io.fetchBuffer(tarballUrl, headersFor(tarballUrl))
        if (!checkIntegrity(buffer, manifest.dist)) throw new Error('the download does not match its published checksum')
      } catch (error) {
        throw new Error(`${where} (${entry.npm}): ${error.message}`)
      }
    } else if (typeof entry.git === 'string' && entry.git !== '') {
      try {
        ;({ buffer, manifest } = await io.archiveGit(entry.git))
      } catch (error) {
        throw new Error(`${where} (${entry.git}): ${error.message}`)
      }
      notes.push(`${where}: packed from source — it installs offline only if the repository commits what it runs`)
    } else {
      throw new Error(`${where}: needs "npm" or "git"`)
    }
    const name = typeof manifest?.name === 'string' ? manifest.name : (entry.npm ?? entry.name)
    const version = typeof manifest?.version === 'string' ? manifest.version : 'unknown'
    let file = safeFile(name, version)
    for (let n = 2; used.has(file); n++) file = safeFile(`${name}-${String(n)}`, version)
    used.add(file)
    files.push({ name: `tarballs/${file}`, data: buffer })
    const deps = Object.keys(manifest?.dependencies ?? {})
    if (deps.length > 0) notes.push(`${where} (${name}): ${String(deps.length)} dependencies are not in the bundle and are fetched when it is installed`)
    const { npm: _npm, git: _git, offlineTarball: _o, pinned: _p, source: _s, ...rest } = entry
    plugins.push({ ...rest, name, version, tarball: `./tarballs/${file}` })
  }
  const out = { ...doc, updated: new Date().toISOString().slice(0, 10), count: plugins.length, plugins }
  files.unshift({ name: 'plugins.json', data: Buffer.from(`${JSON.stringify(out, null, 2)}\n`) })
  return { files, catalog: out, notes, archive: () => gzipSync(makeTar(files)) }
}

/** Real git: shallow clone, then `git archive` of what was checked out. */
function archiveGitReal(spec) {
  const [remote, ref] = spec.replace(/^git\+/u, '').split('#')
  const dir = mkdtempSync(join(tmpdir(), 'dshm-offline-git-'))
  try {
    const clone = spawnSync('git', ['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), remote, dir], { encoding: 'utf8' })
    if (clone.status !== 0) throw new Error(`git clone failed: ${clone.stderr.trim().split('\n').pop()}`)
    const archive = spawnSync('git', ['archive', '--format=tar', '--prefix=package/', 'HEAD'], { cwd: dir, maxBuffer: 1 << 30 })
    if (archive.status !== 0) throw new Error('git archive failed')
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return { buffer: gzipSync(archive.stdout), manifest }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main() {
  const args = process.argv.slice(2)
  const opt = (name) => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1] }
  const catalogPath = opt('--catalog')
  const out = opt('--out')
  if (catalogPath === null || out === null) {
    console.log('usage: node scripts/offline-pack.mjs --catalog plugins.json --out acme-offline.tgz [--registry url]')
    process.exit(2)
  }
  const npmrcPath = join(homedir(), '.npmrc')
  const npmrc = existsSync(npmrcPath) ? readNpmrc(readFileSync(npmrcPath, 'utf8')) : { scopes: new Map(), auth: new Map() }
  const get = async (url, headers) => {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    return response
  }
  const bundle = await packBundle(JSON.parse(readFileSync(catalogPath, 'utf8')), {
    registry: opt('--registry') ?? undefined,
    npmrc,
    fetchJson: async (url, headers) => await (await get(url, { accept: 'application/json', ...headers })).json(),
    fetchBuffer: async (url, headers) => Buffer.from(await (await get(url, headers)).arrayBuffer()),
    archiveGit: archiveGitReal,
  })
  writeFileSync(out, bundle.archive())
  console.error(`wrote ${out}: ${String(bundle.catalog.count)} plugins, ${String(bundle.files.length - 1)} package files`)
  for (const note of bundle.notes) console.error(`note: ${note}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`offline-pack: ${error.message}`)
    process.exit(1)
  })
}
