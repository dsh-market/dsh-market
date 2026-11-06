import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catalogReleaseSourceOf, publishedReleaseUpdate } from '../src/release-updates.ts'
import { checkUpdates } from '../src/updates.ts'

const entry = { url: 'https://github.com/o/whale/tree/main/packages/host', npm: null, tarball: 'https://github.com/o/whale/releases/latest/download/full.tgz' }
const source = { repo: 'o/whale', asset: 'full.tgz', manifest: 'packages/host/package.json' }
const target = 'https://github.com/o/whale/releases/download/v1.2.3/full.tgz'
let dir: string | undefined
afterEach(() => { vi.unstubAllGlobals(); if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined })

function released(manifest = { name: 'dsh-whale', version: '1.2.3' }, location = 'https://github.com/o/whale/releases/tag/v1.2.3') {
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url === 'https://github.com/o/whale/releases/latest' && init?.method === 'HEAD') return new Response(null, { status: 302, headers: { location } })
    if (url === 'https://raw.githubusercontent.com/o/whale/v1.2.3/packages/host/package.json') return new Response(JSON.stringify(manifest))
    if (url === target && init?.method === 'HEAD') return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset' } })
    throw Error(`Unexpected fetch ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('catalog-owned release archive updates', () => {
  it('binds the catalog asset and monorepo manifest, including a previously pinned release', () => {
    expect(catalogReleaseSourceOf(entry.tarball, entry)).toEqual(source)
    expect(catalogReleaseSourceOf('https://github.com/o/whale/releases/download/v1.2.1/full.tgz', entry)).toEqual(source)
  })
  it.each([
    'https://github.com/other/whale/releases/latest/download/full.tgz',
    'https://github.com/o/whale/releases/latest/download/another.tgz',
    'https://github.com/o/whale/releases/latest/download/full.tgz?other=1',
    'https://files.example.com/full.tgz',
  ])('does not authorize a different installed source: %s', spec => {
    expect(catalogReleaseSourceOf(spec, entry)).toBeNull()
  })
  it('leaves pinned catalog archives and explicit npm migrations alone', () => {
    expect(catalogReleaseSourceOf(entry.tarball, { ...entry, tarball: target })).toBeNull()
    expect(catalogReleaseSourceOf(entry.tarball, { ...entry, npm: 'dsh-whale' })).toBeNull()
  })
  it('uses a published tag and its matching package rather than main or npm', async () => {
    const fetch = released()
    expect(await publishedReleaseUpdate(source, 'dsh-whale')).toEqual({ version: '1.2.3', target })
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it.each([
    { name: 'different-plugin', version: '1.2.3' },
    { name: 'dsh-whale', version: '1.2.4' },
  ])('refuses a released manifest that does not identify this exact package version', async manifest => {
    released(manifest)
    expect(await publishedReleaseUpdate(source, 'dsh-whale')).toBeNull()
  })
  it('refuses a latest redirect to another repository', async () => {
    released(undefined, 'https://github.com/other/repo/releases/tag/v1.2.3')
    expect(await publishedReleaseUpdate(source, 'dsh-whale')).toBeNull()
  })
  it('does not claim a published target when the release lookup is offline', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    expect(await publishedReleaseUpdate(source, 'dsh-whale')).toBeNull()
  })
  it('offers a newer complete archive without querying a same-named npm package', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dshm-release-update-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-whale': entry.tarball } }))
    const installed = join(dir, 'node_modules/dsh-whale')
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'dsh-whale', version: '1.2.1', dsh: {} }))
    const fetch = released()
    const updates = await checkUpdates('web', true, dir, new Map(), new Map(), new Map(), { releaseSources: new Map([['dsh-whale', source]]) })
    expect(updates['dsh-whale']).toMatchObject({ current: '1.2.1', latest: '1.2.3', updateAvailable: true })
    expect(fetch.mock.calls.every(([url]) => !String(url).includes('registry.'))).toBe(true)
  })
})
