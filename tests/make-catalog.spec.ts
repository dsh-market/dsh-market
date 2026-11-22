/**
 * scripts/make-catalog.mjs: entries in, a catalog the market can load out.
 *
 * The function is driven with a fake lookup, and the whole script is run once
 * against a local registry stand-in to prove the command line and the output
 * file. The output is then read back by the market's own file-catalog reader,
 * so "valid plugins.json" means what the market means by it.
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- plain .mjs script, no types
import { buildCatalog, readNpmrc, repositoryUrl } from '../scripts/make-catalog.mjs'
import { loadExtra } from '../src/catalogs.ts'

type Lookup = (url: string, headers: Record<string, string>) => Promise<unknown>

const MANIFESTS: Record<string, unknown> = {
  'https://registry.npmjs.org/dsh-loop/latest': {
    name: 'dsh-loop', version: '1.2.3', description: 'Loop a task',
    repository: { type: 'git', url: 'git+https://github.com/someone/dsh-loop.git' },
  },
  'https://npm.acme.internal/%40acme%2Fbadge/latest': {
    name: '@acme/badge', version: '0.4.0', description: 'Show a badge', repository: 'git@git.acme.internal:tools/badge.git',
  },
  'https://raw.githubusercontent.com/acme/theme/HEAD/package.json': { name: 'dsh-theme-acme', description: 'Company theme' },
}

describe('buildCatalog', () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchJson: Lookup = async (url, headers) => {
    seen.push({ url, headers })
    if (url in MANIFESTS) return MANIFESTS[url]
    throw new Error('HTTP 404')
  }
  const npmrc = readNpmrc('@acme:registry=https://npm.acme.internal/\n//npm.acme.internal/:_authToken=tok-1\n')

  it('fills name, link and description from the package, and lets the entry override them', async () => {
    const catalog = await buildCatalog({
      label: { zh: 'Acme 内部', en: 'Acme internal' },
      plugins: [
        { npm: 'dsh-loop', category: 'tools' },
        { npm: '@acme/badge', category: ['hr', 'tools'], description: { zh: '工牌', en: 'Badge' } },
        { repo: 'https://github.com/acme/theme', category: 'themes' },
      ],
    }, { fetchJson, npmrc, today: '2026-11-22' })
    expect(catalog).toMatchObject({ updated: '2026-11-22', count: 3, label: { zh: 'Acme 内部', en: 'Acme internal' } })
    expect(catalog.plugins[0]).toMatchObject({
      name: 'dsh-loop', npm: 'dsh-loop', url: 'https://github.com/someone/dsh-loop', owner: 'someone',
      category: 'tools', description: { zh: 'Loop a task', en: 'Loop a task' }, version: '1.2.3', install: 'dsh-loop',
    })
    expect(catalog.plugins[1]).toMatchObject({
      name: 'badge', npm: '@acme/badge', url: 'https://git.acme.internal/tools/badge', owner: 'acme',
      category: ['hr', 'tools'], description: { zh: '工牌', en: 'Badge' },
    })
    expect(catalog.plugins[2]).toMatchObject({ name: 'dsh-theme-acme', npm: null, url: 'https://github.com/acme/theme', owner: 'acme' })
    expect(Object.keys(catalog.categories).sort()).toEqual(['hr', 'themes', 'tools'])
  })

  it('reads a scoped package from its own registry, with its credential, and a public one without', async () => {
    seen.length = 0
    await buildCatalog([{ npm: '@acme/badge', category: 'hr' }, { npm: 'dsh-loop', category: 'tools' }], { fetchJson, npmrc })
    expect(seen[0]).toEqual({ url: 'https://npm.acme.internal/%40acme%2Fbadge/latest', headers: { authorization: 'Bearer tok-1' } })
    expect(seen[1]).toEqual({ url: 'https://registry.npmjs.org/dsh-loop/latest', headers: {} })
  })

  it('does not look anything up offline, and then needs the entry to say everything', async () => {
    seen.length = 0
    const done = await buildCatalog([{ npm: 'x-plugin', name: 'x', url: 'https://x.example', description: 'X', category: 'tools' }], { offline: true, fetchJson })
    expect(seen).toHaveLength(0)
    expect(done.plugins[0]).toMatchObject({ name: 'x', url: 'https://x.example', description: { en: 'X' } })
    await expect(buildCatalog([{ npm: 'dsh-loop', category: 'tools' }], { offline: true, fetchJson }))
      .rejects.toThrow(/entry 1.*no description/)
  })

  it('stops with the entry number and what is missing, instead of guessing', async () => {
    await expect(buildCatalog([{ npm: 'dsh-loop' }], { fetchJson })).rejects.toThrow(/entry 1 \(dsh-loop\): no category/)
    await expect(buildCatalog([{ category: 'tools' }], { fetchJson })).rejects.toThrow(/entry 1: no name/)
    await expect(buildCatalog([{ npm: 'not a name', category: 'tools' }], { fetchJson })).rejects.toThrow(/entry 1.*not a valid npm package name/)
    await expect(buildCatalog([{ npm: 'dsh-missing', category: 'tools' }], { fetchJson })).rejects.toThrow(/entry 1: could not read dsh-missing/)
    await expect(buildCatalog({ nope: true }, { fetchJson })).rejects.toThrow(/list/)
  })

  it('understands the repository spellings package.json uses', () => {
    expect(repositoryUrl('github:o/r')).toBe('https://github.com/o/r')
    expect(repositoryUrl('o/r')).toBe('https://github.com/o/r')
    expect(repositoryUrl({ url: 'git+ssh://git@host.example/o/r.git' })).toBe('https://host.example/o/r')
    expect(repositoryUrl('git://host.example/o/r.git#main')).toBe('https://host.example/o/r')
    expect(repositoryUrl('nonsense')).toBeNull()
  })
})

describe('the command line', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dshm-make-catalog-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('writes a plugins.json the market itself accepts', async () => {
    // The stand-in registry runs in this process, so the script must be a
    // child that does not block the event loop (TESTING.md).
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ name: 'dsh-loop', version: '1.0.0', description: 'Loop', repository: 'github:someone/dsh-loop' }))
      void request
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const entries = join(dir, 'entries.json')
      const out = join(dir, 'plugins.json')
      writeFileSync(entries, JSON.stringify([{ npm: 'dsh-loop', category: 'tools' }]))
      const status = await new Promise<number | null>(resolve => {
        const child = spawn(process.execPath, ['scripts/make-catalog.mjs', entries, '-o', out, '--label', 'Demo', '--registry', `http://127.0.0.1:${String(port)}`], {
          env: { ...process.env, HOME: dir, USERPROFILE: dir }, stdio: 'ignore',
        })
        child.on('close', resolve)
      })
      expect(status).toBe(0)
      const written = JSON.parse(readFileSync(out, 'utf8')) as { count: number; label: unknown }
      expect(written.count).toBe(1)
      expect(written.label).toEqual({ zh: 'Demo', en: 'Demo' })
      const loaded = await loadExtra({ id: 'demo', kind: 'user', label: { zh: 'x', en: 'x' }, file: out, headers: {} })
      expect(loaded.info).toMatchObject({ status: 'ok', count: 1, label: { zh: 'Demo', en: 'Demo' } })
      expect(loaded.registry!.plugins[0]).toMatchObject({ name: 'dsh-loop', url: 'https://github.com/someone/dsh-loop' })
    } finally {
      server.close()
    }
  })
})
