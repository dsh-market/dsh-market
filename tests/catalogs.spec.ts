/**
 * Catalog sources beyond the public one: merging, the allowlist, reading a
 * file or URL, failure per source, and what never leaks.
 *
 * Two layers, both real code: the pure merge/filter functions in
 * src/catalogs.ts, and `loadRegistry` in src/registry.ts driven through a
 * stubbed network and real files. The last block pins the promise the whole
 * feature rests on — with nothing configured, `loadRegistry` is the public
 * path it always was.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const undici = vi.hoisted(() => ({
  fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (vi.isMockFunction(globalThis.fetch)) return globalThis.fetch(input, init)
    return new Response('ok', { status: 200 })
  }),
  EnvHttpProxyAgent: vi.fn(function (this: unknown) { return {} }),
  Agent: vi.fn(function (this: unknown) { return {} }),
}))
vi.mock('undici', () => undici)

import {
  catalogConfig, entryAllowed, loadExtra, mergeSources, parseCatalogInput, probeCatalog, scrub,
  setUserCatalogs, userCatalogId, validUserCatalog, forgetExtraCatalogs,
  type SourceInfo,
} from '../src/catalogs.ts'
import { CatalogLoadError, forgetCatalog, loadRegistry, type Registry, type RegistryPlugin } from '../src/registry.ts'
import { resetPolicyCache } from '../src/policy.ts'
import { exportLogs } from '../src/log.ts'

const plugin = (name: string, url: string, extra: Partial<RegistryPlugin> = {}): RegistryPlugin => ({
  name, owner: 'o', url, category: 'tools', description: { en: name }, npm: name, install: name, added: '2026-01-01', ...extra,
})
const catalog = (plugins: RegistryPlugin[], categories: Registry['categories'] = { tools: { en: 'Tools', zh: '工具' } }): Registry => ({
  updated: '2026-08-18', count: plugins.length, categories, plugins,
})
const info = (id: string, extra: Partial<SourceInfo> = {}): SourceInfo => ({
  id, kind: 'policy', label: { zh: id, en: id }, where: '', status: 'ok', count: 0, skipped: 0, locked: true, ...extra,
})

describe('entryAllowed', () => {
  it('lets everything through without an allowlist, and matches npm name or entry name by glob', () => {
    expect(entryAllowed({ name: 'x', npm: 'x' }, null)).toBe(true)
    expect(entryAllowed({ name: 'notify', npm: '@acme/notify' }, ['@acme/*'])).toBe(true)
    expect(entryAllowed({ name: 'dsh-notify-me', npm: null }, ['dsh-notify-me'])).toBe(true)
    expect(entryAllowed({ name: 'other', npm: '@evil/other' }, ['@acme/*', 'dsh-notify-me'])).toBe(false)
    expect(entryAllowed({ name: 'anything', npm: 'anything' }, [])).toBe(false)
  })
})

describe('mergeSources', () => {
  const acme = info('acme', { label: { zh: 'Acme 内部', en: 'Acme internal' } })

  it('puts private entries first, tags them, and keeps public ones untagged', () => {
    const merged = mergeSources({
      publicRegistry: catalog([plugin('pub-a', 'https://github.com/o/pub-a')]),
      publicInfo: info('public', { kind: 'public' }),
      extras: [{ info: acme, registry: catalog([plugin('@acme/x', 'https://git.acme/x')]) }],
      allow: null,
    })
    expect(merged.plugins.map(entry => entry.name)).toEqual(['@acme/x', 'pub-a'])
    expect(merged.plugins[0]!.source).toEqual({ id: 'acme', label: { zh: 'Acme 内部', en: 'Acme internal' } })
    expect(merged.plugins[1]).not.toHaveProperty('source')
    expect(merged.count).toBe(2)
    expect(merged.sources?.map(source => source.id)).toEqual(['public', 'acme'])
  })

  it('lets a private entry win over the public one for the same repository, case-insensitively', () => {
    const merged = mergeSources({
      publicRegistry: catalog([plugin('pub', 'https://github.com/Acme/Plug')]),
      publicInfo: info('public', { kind: 'public' }),
      extras: [{ info: acme, registry: catalog([plugin('plug', 'https://github.com/acme/plug', { description: { en: 'private copy' } })]) }],
      allow: null,
    })
    expect(merged.plugins).toHaveLength(1)
    expect(merged.plugins[0]!.description.en).toBe('private copy')
    expect(merged.plugins[0]!.source?.id).toBe('acme')
  })

  it('shows one card when two catalogs list the same npm package under different links', () => {
    const merged = mergeSources({
      publicRegistry: catalog([plugin('dsh-lessons', 'https://github.com/o/lessons', { npm: 'dsh-lessons' }), plugin('other', 'https://github.com/o/other', { npm: 'other' })]),
      publicInfo: info('public', { kind: 'public' }),
      extras: [{ info: acme, registry: catalog([plugin('dsh-lessons', 'https://repo.acme/lessons', { npm: 'DSH-Lessons', description: { en: 'private copy' } })]) }],
      allow: null,
    })
    expect(merged.plugins.map(entry => [entry.name, entry.source?.id])).toEqual([['dsh-lessons', 'acme'], ['other', undefined]])
    expect(merged.plugins[0]!.description.en).toBe('private copy')
  })

  it('lets an earlier private source win over a later one', () => {
    const merged = mergeSources({
      publicRegistry: null,
      publicInfo: null,
      extras: [
        { info: acme, registry: catalog([plugin('p', 'https://x/p', { description: { en: 'first' } })]) },
        { info: info('user-1', { kind: 'user' }), registry: catalog([plugin('p', 'https://x/p', { description: { en: 'second' } })]) },
      ],
      allow: null,
    })
    expect(merged.plugins.map(entry => entry.description.en)).toEqual(['first'])
  })

  it('never lets a catalog claim to be another source', () => {
    const forged = plugin('forged', 'https://x/f', { source: { id: 'public', label: { en: 'Public' } } })
    const merged = mergeSources({
      publicRegistry: catalog([plugin('pub', 'https://github.com/o/pub', { source: { id: 'acme', label: { en: 'Acme' } } })]),
      publicInfo: info('public', { kind: 'public' }),
      extras: [{ info: acme, registry: catalog([forged]) }],
      allow: null,
    })
    expect(merged.plugins.find(entry => entry.name === 'forged')!.source?.id).toBe('acme')
    expect(merged.plugins.find(entry => entry.name === 'pub')).not.toHaveProperty('source')
  })

  it('merges categories and gives a category nothing describes its own id as the label', () => {
    const merged = mergeSources({
      publicRegistry: catalog([plugin('pub', 'https://github.com/o/pub')]),
      publicInfo: info('public', { kind: 'public' }),
      extras: [{
        info: acme,
        registry: catalog(
          [plugin('a', 'https://x/a', { category: ['tools', 'in-house'] }), plugin('b', 'https://x/b', { category: 'hr' })],
          { hr: { en: 'People', zh: '人事' }, tools: { en: 'Should not replace' } },
        ),
      }],
      allow: null,
    })
    expect(merged.categories.tools).toEqual({ en: 'Tools', zh: '工具' })
    expect(merged.categories.hr).toEqual({ en: 'People', zh: '人事' })
    expect(merged.categories['in-house']).toEqual({ zh: 'in-house', en: 'in-house' })
  })

  it('filters the union by the allowlist', () => {
    const merged = mergeSources({
      publicRegistry: catalog([plugin('dsh-notify-me', 'https://github.com/o/n'), plugin('dsh-other', 'https://github.com/o/o')]),
      publicInfo: info('public', { kind: 'public' }),
      extras: [{ info: acme, registry: catalog([plugin('@acme/ok', 'https://x/ok'), plugin('@evil/no', 'https://x/no')]) }],
      allow: ['@acme/*', 'dsh-notify-me'],
    })
    expect(merged.plugins.map(entry => entry.name).sort()).toEqual(['@acme/ok', 'dsh-notify-me'])
    expect(merged.count).toBe(2)
  })

  it('changes `updated` when a private catalog changes, so clients drop what they cached', () => {
    const base = { publicRegistry: catalog([plugin('pub', 'https://github.com/o/pub')]), publicInfo: info('public', { kind: 'public' }), allow: null }
    const one = mergeSources({ ...base, extras: [{ info: acme, registry: catalog([plugin('a', 'https://x/a')]) }] })
    const two = mergeSources({ ...base, extras: [{ info: acme, registry: catalog([plugin('a', 'https://x/a'), plugin('b', 'https://x/b')]) }] })
    expect(one.updated).not.toBe(two.updated)
    expect(one.updated.startsWith('2026-08-18')).toBe(true)
  })
})

describe('adding a catalog by hand', () => {
  it('reads a URL, a file path, a file: URL and a ~ path, and refuses the rest', () => {
    expect(parseCatalogInput(' https://plugins.acme.internal/plugins.json ')).toEqual({ url: 'https://plugins.acme.internal/plugins.json' })
    expect(parseCatalogInput('/opt/acme/plugins.json')).toEqual({ file: '/opt/acme/plugins.json' })
    expect(parseCatalogInput('file:///opt/acme/plugins.json')).toEqual({ file: '/opt/acme/plugins.json' })
    expect(parseCatalogInput('~/plugins.json')).toMatchObject({ file: expect.stringMatching(/\/plugins\.json$/) })
    expect(parseCatalogInput('')).toEqual({ error: 'empty' })
    expect(parseCatalogInput('plugins.json')).toEqual({ error: 'unrecognized' })
    expect(parseCatalogInput('ftp://x/y')).toEqual({ error: 'unrecognized' })
    expect(parseCatalogInput('https://user:pass@x.example/p.json')).toEqual({ error: 'credentials' })
  })

  it('gives the same input the same id, and validates stored state as untrusted', () => {
    const id = userCatalogId({ url: 'https://a.example/p.json' })
    expect(id).toMatch(/^user-[0-9a-f]{8}$/)
    expect(userCatalogId({ url: 'https://a.example/p.json' })).toBe(id)
    expect(validUserCatalog({ id: 'whatever', url: 'https://a.example/p.json' })).toEqual({ id, url: 'https://a.example/p.json' })
    expect(validUserCatalog({ file: 'relative.json' })).toBeNull()
    expect(validUserCatalog({ url: 'javascript:alert(1)' })).toBeNull()
    expect(validUserCatalog({ url: 'https://a.example/p.json', file: '/x.json' })).toBeNull()
    expect(validUserCatalog('nope')).toBeNull()
  })
})

describe('scrub', () => {
  it('removes configured secrets, URL credentials and query strings from a message', () => {
    const text = 'GET https://u:pw@host.example/p.json?token=abc123 failed: Bearer s3cr3t-token rejected'
    const out = scrub(text, ['Bearer s3cr3t-token'])
    expect(out).not.toContain('s3cr3t-token')
    expect(out).not.toContain('abc123')
    expect(out).not.toContain('pw@')
    expect(out).toContain('host.example/p.json')
  })
})

// --------------------------------------------------------------------------
// Reading real files and a stubbed network.

let tmp: string
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...process.env, ...extra })
const writeJson = (name: string, doc: unknown): string => {
  const file = join(tmp, name)
  writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc))
  return file
}
const PRIVATE_DOC = {
  updated: '2026-09-01',
  label: { zh: '公司目录', en: 'Company catalog' },
  categories: { hr: { en: 'People', zh: '人事' } },
  plugins: [
    { name: 'badge', url: 'https://git.acme/badge', category: 'hr', npm: '@acme/badge', description: 'Show a badge' },
    { name: 'payroll', url: 'https://git.acme/payroll', category: ['hr'], description: { en: 'Payroll', zh: '工资' } },
    { name: 'broken-no-category', url: 'https://git.acme/x' },
    { url: 'https://git.acme/nameless', category: 'hr' },
    { name: 'bad-link', url: 'javascript:alert(1)', category: 'hr' },
  ],
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dshm-catalogs-'))
  forgetCatalog()
  resetPolicyCache()
  setUserCatalogs([])
  vi.stubEnv('DSH_HOME', join(tmp, 'home'))
  vi.stubEnv('DSH_MARKET_POLICY', '')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  setUserCatalogs([])
  resetPolicyCache()
  rmSync(tmp, { recursive: true, force: true })
})

/** A fetch answering by URL fragment; records every call. */
let calls: Array<{ url: string; headers: Record<string, string> }> = []
function routedFetch(routes: Record<string, () => Response | Error>): void {
  calls = []
  vi.stubGlobal('fetch', vi.fn((url: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), headers: { ...init?.headers } })
    for (const [fragment, answer] of Object.entries(routes)) {
      if (String(url).includes(fragment)) {
        const made = answer()
        return made instanceof Error ? Promise.reject(made) : Promise.resolve(made)
      }
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  }))
}
const json = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
const PUBLIC = catalog([plugin('pub-a', 'https://github.com/o/pub-a')])

function writePolicy(doc: unknown): string {
  const file = writeJson('policy.json', doc)
  vi.stubEnv('DSH_MARKET_POLICY', file)
  resetPolicyCache()
  return file
}

describe('reading one source', () => {
  it('reads a file catalog, keeps usable entries, and counts what it skipped', async () => {
    const file = writeJson('plugins.json', PRIVATE_DOC)
    const result = await loadExtra({ id: 'acme', kind: 'policy', label: { zh: 'A', en: 'A' }, file, headers: {} })
    expect(result.info).toMatchObject({ status: 'ok', count: 2, skipped: 3, locked: true, where: file })
    expect(result.registry!.plugins.map(entry => entry.name)).toEqual(['badge', 'payroll'])
    // shorthand description and missing fields are filled in, not rejected
    expect(result.registry!.plugins[0]).toMatchObject({ description: { zh: 'Show a badge', en: 'Show a badge' }, install: '@acme/badge', owner: '' })
  })

  it('lets a user catalog name itself, but the organization\'s label always wins', async () => {
    const file = writeJson('plugins.json', PRIVATE_DOC)
    const user = await loadExtra({ id: 'user-1', kind: 'user', label: { zh: 'x', en: 'x' }, file, headers: {} })
    expect(user.info.label).toEqual({ zh: '公司目录', en: 'Company catalog' })
    const policy = await loadExtra({ id: 'acme', kind: 'policy', label: { zh: 'Acme 内部', en: 'Acme internal' }, file, headers: {} })
    expect(policy.info.label).toEqual({ zh: 'Acme 内部', en: 'Acme internal' })
  })

  it('reads a file again when it changes, and not before', async () => {
    const file = writeJson('plugins.json', PRIVATE_DOC)
    const source = { id: 'acme', kind: 'policy' as const, label: { zh: 'A', en: 'A' }, file, headers: {} }
    const first = await loadExtra(source)
    expect((await loadExtra(source)).registry).toBe(first.registry)
    writeJson('plugins.json', { ...PRIVATE_DOC, plugins: [PRIVATE_DOC.plugins[0]] })
    utimesSync(file, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000))
    const changed = await loadExtra(source)
    expect(changed.registry).not.toBe(first.registry)
    expect(changed.info.count).toBe(1)
  })

  it('explains each way a source can fail with a code the page can word', async () => {
    const source = (file: string) => ({ id: 'acme', kind: 'policy' as const, label: { zh: 'A', en: 'A' }, file, headers: {} })
    expect((await loadExtra(source(join(tmp, 'missing.json')))).info.error).toMatchObject({ code: 'file' })
    expect((await loadExtra(source(writeJson('junk.json', 'not json')))).info.error).toMatchObject({ code: 'invalid' })
    expect((await loadExtra(source(writeJson('shape.json', { nope: 1 })))).info.error).toMatchObject({ code: 'invalid' })
    expect((await loadExtra(source(writeJson('empty.json', { plugins: [] })))).info.error).toMatchObject({ code: 'empty' })
    expect((await loadExtra(source(writeJson('unusable.json', { plugins: [{ name: 'x' }] })))).info.error).toMatchObject({ code: 'empty' })
    forgetExtraCatalogs()
  })

  it('sends the headers with ${ENV} expanded, and revalidates with the validator it was given', async () => {
    routedFetch({ 'acme.internal': () => json(PRIVATE_DOC, { etag: '"v1"' }) })
    const source = {
      id: 'acme', kind: 'policy' as const, label: { zh: 'A', en: 'A' },
      url: 'https://plugins.acme.internal/plugins.json',
      headers: { Authorization: 'Bearer ${ACME_TOKEN}' },
    }
    const first = await loadExtra(source, { env: env({ ACME_TOKEN: 'tok-9f8e7d' }) })
    expect(first.info.status).toBe('ok')
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok-9f8e7d')
    routedFetch({ 'acme.internal': () => new Response(null, { status: 304 }) })
    const second = await loadExtra(source, { env: env({ ACME_TOKEN: 'tok-9f8e7d' }) })
    expect(calls[0]!.headers['if-none-match']).toBe('"v1"')
    expect(second.registry).toBe(first.registry)
    // another credential is another identity: the validator is not shared
    routedFetch({ 'acme.internal': () => json(PRIVATE_DOC) })
    await loadExtra(source, { env: env({ ACME_TOKEN: 'someone-else' }) })
    expect(calls[0]!.headers['if-none-match']).toBeUndefined()
  })

  it('names a missing environment variable instead of sending a half-made credential', async () => {
    routedFetch({ 'acme.internal': () => json(PRIVATE_DOC) })
    const result = await loadExtra({
      id: 'acme', kind: 'policy', label: { zh: 'A', en: 'A' }, url: 'https://plugins.acme.internal/p.json',
      headers: { Authorization: 'Bearer ${NOT_SET_ANYWHERE}' },
    }, { env: env() })
    expect(result.info.error).toEqual({ code: 'env', detail: 'NOT_SET_ANYWHERE' })
    expect(calls).toHaveLength(0)
  })

  it('never puts a token in the result, the thrown reason, or the log', async () => {
    const token = 'tok-SECRET-0123456789'
    routedFetch({ 'acme.internal': () => new Response('denied', { status: 401 }) })
    const source = {
      id: 'acme', kind: 'policy' as const, label: { zh: 'A', en: 'A' },
      url: 'https://plugins.acme.internal/p.json?key=QUERYSECRET',
      headers: { Authorization: `Bearer ${token}` },
    }
    const denied = await loadExtra(source, { env: env() })
    expect(denied.info.error).toEqual({ code: 'auth', detail: '401' })
    routedFetch({ 'acme.internal': () => new Error(`socket hang up while sending Bearer ${token} to https://u:pw@plugins.acme.internal/p.json?key=QUERYSECRET`) })
    forgetExtraCatalogs()
    const broken = await loadExtra({ ...source, id: 'acme2' }, { env: env() })
    for (const output of [JSON.stringify(denied.info), JSON.stringify(broken.info), exportLogs({})]) {
      expect(output).not.toContain(token)
      expect(output).not.toContain('QUERYSECRET')
      expect(output).not.toContain('pw@')
    }
    expect(broken.info.status).toBe('failed')
  })

  it('tests a candidate once, without a validator, for the add box', async () => {
    const file = writeJson('plugins.json', PRIVATE_DOC)
    const result = await probeCatalog({ file })
    expect(result.info).toMatchObject({ status: 'ok', count: 2 })
    const missing = await probeCatalog({ file: join(tmp, 'nope.json') })
    expect(missing.registry).toBeNull()
    expect(missing.info.error?.code).toBe('file')
  })
})

describe('loadRegistry with more than the public catalog', () => {
  it('is exactly the public path when nothing is configured', async () => {
    routedFetch({ 'awesome-dsh-plugin.com': () => json(PUBLIC) })
    expect(catalogConfig().active).toBe(false)
    const registry = await loadRegistry('global')
    expect(registry).not.toHaveProperty('sources')
    expect(registry.plugins).toHaveLength(1)
    expect(registry.plugins[0]).not.toHaveProperty('source')
    expect(calls.map(call => call.url)).toEqual(['https://awesome-dsh-plugin.com/plugins.json'])
    // the same validator dance as before: the second read revalidates
    routedFetch({ 'awesome-dsh-plugin.com': () => new Response(null, { status: 304 }) })
    expect(await loadRegistry('global')).toBe(registry)
  })

  it('merges a policy catalog with the public one and tags only the private entries', async () => {
    const file = writeJson('plugins.json', PRIVATE_DOC)
    writePolicy({ catalogs: [{ id: 'acme', label: { zh: 'Acme 内部', en: 'Acme internal' }, file }] })
    routedFetch({ 'awesome-dsh-plugin.com': () => json(PUBLIC) })
    const registry = await loadRegistry('global')
    expect(registry.plugins.map(entry => [entry.name, entry.source?.id])).toEqual([
      ['badge', 'acme'], ['payroll', 'acme'], ['pub-a', undefined],
    ])
    expect(registry.sources?.map(source => [source.id, source.status, source.count])).toEqual([
      ['public', 'ok', 1], ['acme', 'ok', 2],
    ])
    expect(registry.categories.hr).toEqual({ en: 'People', zh: '人事' })
  })

  it('keeps the public catalog and its 304 validator working beside a private source', async () => {
    const file = writeJson('plugins.json', PRIVATE_DOC)
    writePolicy({ catalogs: [{ id: 'acme', label: 'Acme', file }] })
    routedFetch({ 'awesome-dsh-plugin.com': () => json(PUBLIC, { etag: '"pub1"' }) })
    const first = await loadRegistry('global')
    routedFetch({ 'awesome-dsh-plugin.com': () => new Response(null, { status: 304 }) })
    const second = await loadRegistry('global')
    expect(calls[0]!.headers['if-none-match']).toBe('"pub1"')
    expect(second).toBe(first)
  })

  it('shows the private entries and the public failure when only the public catalog is down', async () => {
    writePolicy({ catalogs: [{ id: 'acme', label: 'Acme', file: writeJson('plugins.json', PRIVATE_DOC) }] })
    routedFetch({ '': () => new Error('getaddrinfo ENOTFOUND awesome-dsh-plugin.com') })
    const registry = await loadRegistry('global')
    expect(registry.plugins.map(entry => entry.name)).toEqual(['badge', 'payroll'])
    expect(registry.sources?.find(source => source.id === 'public')).toMatchObject({ status: 'failed', error: { code: 'network' } })
    expect(registry.sources?.find(source => source.id === 'acme')?.status).toBe('ok')
  })

  it('keeps the public catalog and reports the private one when only that is down', async () => {
    writePolicy({ catalogs: [{ id: 'acme', label: 'Acme', file: join(tmp, 'missing.json') }] })
    routedFetch({ 'awesome-dsh-plugin.com': () => json(PUBLIC) })
    const registry = await loadRegistry('global')
    expect(registry.plugins.map(entry => entry.name)).toEqual(['pub-a'])
    expect(registry.sources?.find(source => source.id === 'acme')).toMatchObject({ status: 'failed', error: { code: 'file' } })
  })

  it('throws, with every source\'s answer, only when nothing loaded', async () => {
    writePolicy({ catalogs: [{ id: 'acme', label: 'Acme', file: join(tmp, 'missing.json') }] })
    routedFetch({ '': () => new Error('offline') })
    const failure = await loadRegistry('global').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CatalogLoadError)
    expect((failure as CatalogLoadError).sources.map(source => [source.id, source.status])).toEqual([['public', 'failed'], ['acme', 'failed']])
  })

  it('does not contact the public catalog when the policy turns it off', async () => {
    writePolicy({ publicCatalog: false, catalogs: [{ id: 'acme', label: 'Acme', file: writeJson('plugins.json', PRIVATE_DOC) }] })
    routedFetch({})
    const registry = await loadRegistry('global')
    expect(calls).toHaveLength(0)
    expect(registry.plugins.map(entry => entry.name)).toEqual(['badge', 'payroll'])
    expect(registry.sources?.find(source => source.id === 'public')).toBeUndefined()
  })

  it('applies the allowlist to what it returns, public entries included', async () => {
    writePolicy({
      allow: ['badge', 'pub-*'],
      catalogs: [{ id: 'acme', label: 'Acme', file: writeJson('plugins.json', PRIVATE_DOC) }],
    })
    routedFetch({ 'awesome-dsh-plugin.com': () => json(catalog([plugin('pub-a', 'https://github.com/o/a'), plugin('dsh-other', 'https://github.com/o/b')])) })
    const registry = await loadRegistry('global')
    expect(registry.plugins.map(entry => entry.name).sort()).toEqual(['badge', 'pub-a'])
  })

  it('applies an allowlist even to the public catalog alone', async () => {
    writePolicy({ allow: ['nothing-matches'] })
    routedFetch({ 'awesome-dsh-plugin.com': () => json(PUBLIC) })
    expect((await loadRegistry('global')).plugins).toEqual([])
  })

  it('adds the user\'s catalogs, and ignores them when the policy forbids it', async () => {
    const file = writeJson('mine.json', PRIVATE_DOC)
    setUserCatalogs([{ id: userCatalogId({ file }), file }])
    routedFetch({ 'awesome-dsh-plugin.com': () => json(PUBLIC) })
    const registry = await loadRegistry('global')
    expect(registry.plugins.filter(entry => entry.source !== undefined).map(entry => entry.source!.id)).toEqual([userCatalogId({ file }), userCatalogId({ file })])
    expect(registry.sources?.find(source => source.kind === 'user')).toMatchObject({ status: 'ok', locked: false })

    forgetCatalog()
    writePolicy({ userCatalogs: false })
    const locked = await loadRegistry('global')
    expect(locked.plugins.some(entry => entry.source !== undefined)).toBe(false)
  })

  it('returns the same object while no source changed, so what is cached on it stays valid', async () => {
    writePolicy({ catalogs: [{ id: 'acme', label: 'Acme', file: writeJson('plugins.json', PRIVATE_DOC) }] })
    routedFetch({ 'awesome-dsh-plugin.com': () => json(PUBLIC, { etag: '"e"' }) })
    const first = await loadRegistry('global')
    routedFetch({ 'awesome-dsh-plugin.com': () => new Response(null, { status: 304 }) })
    expect(await loadRegistry('global')).toBe(first)
  })

  it('follows a policy mirror for the public catalog', async () => {
    writePolicy({ mirrors: { catalog: 'https://mirror.acme.internal/plugins.json' } })
    routedFetch({ 'mirror.acme.internal': () => json(PUBLIC), 'awesome-dsh-plugin.com': () => new Error('must not be asked') })
    await loadRegistry('global')
    expect(calls.map(call => call.url)).toEqual(['https://mirror.acme.internal/plugins.json'])
  })
})

describe('the policy file on disk, end to end', () => {
  it('a directory of catalogs next to the policy needs nothing but the file paths', async () => {
    mkdirSync(join(tmp, 'catalogs'))
    writeFileSync(join(tmp, 'catalogs', 'a.json'), JSON.stringify(PRIVATE_DOC))
    writePolicy({ publicCatalog: false, catalogs: [{ id: 'a', label: 'A', file: join(tmp, 'catalogs', 'a.json') }] })
    expect((await loadRegistry('global')).count).toBe(2)
  })
})
