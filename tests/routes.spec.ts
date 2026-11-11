/**
 * HTTP route contract tests for the issue #98 routes — src/routes.ts. Each
 * test mounts marketRoutes against a STUB host (capturing webServer.register)
 * plus a temp profile fixture, then drives the captured handlers with fake
 * IncomingMessage / ServerResponse objects. No server socket, no pnpm, no
 * network — the same surface the real harness host provides, so the method /
 * Allow, origin, body-validation, 422 and write-lock contracts of the 5 new
 * routes are pinned without spawning a process.
 *
 * The 6 routes covered here: /dsh-market/check, /bundle-order, /snapshots,
 * /restore-snapshot, /delete-snapshot and /presets. Presets have no import
 * or export of their own — Backup & Restore already carries a profile off
 * the machine, and a second export in another tab would only make the user
 * choose between two overlapping file formats.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dump } from 'js-yaml'
import { mountMarketRoutes, type MarketHost } from '../src/routes.ts'
import { sameOrigin } from '../src/http.ts'
import { readMarketState, writeMarketState } from '../src/hot.ts'
import { configurePersistentLog, readPersistentLog } from '../src/log.ts'
import * as orderApi from '../src/order.ts'
import * as registryApi from '../src/registry.ts'
import { DiscoveryManifestIndex } from '../src/discovery-compatibility.ts'
import type { PluginCommandRuntime } from '../src/dsh-cli.ts'

type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>

// --- harness ---------------------------------------------------------------

/** Same-origin pair used by every successful mutating request. */
const ORIGIN = 'http://127.0.0.1:3080'
const HOST = '127.0.0.1:3080'

/**
 * Mount the market routes against a stub host. The returned `routes` map is
 * keyed by path so tests can invoke each handler directly.
 */
function mount(commandRuntime?: PluginCommandRuntime): { host: MarketHost; routes: Map<string, RouteHandler> } {
  const routes = new Map<string, RouteHandler>()
  const host: MarketHost = {
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
    // No loader entries and no hot-mounting in these contract tests.
    loader: { entries: () => [] },
    plugin: () => ({ await: async () => undefined, dispose: async () => undefined }),
  }
  // A pinned region: with `region` undefined the market starts a background
  // probe that writes `.dsh-market/state.json` a few milliseconds later, on
  // whatever machine runs the suite. Two tests here put a DIRECTORY at that
  // path on purpose (an unreadable state file), and the probe's write landed
  // in the middle of them — an EEXIST nobody could reproduce locally (#1144).
  mountMarketRoutes(host, { profile: 'web', region: 'global' }, commandRuntime)
  return { host, routes }
}

/** Capture the status/headers/body of one handler invocation. */
interface Captured {
  status: number
  headers: Record<string, string | number | string[]>
  body: string
  json(): unknown
}

function makeResponse(): { response: ServerResponse; captured: () => Captured } {
  let status = 0
  let headers: Record<string, string | number | string[]> = {}
  let body = ''
  const response = {
    writeHead(s: number, h?: Record<string, string | number | string[]>): unknown {
      status = s
      if (h !== undefined) headers = h
      return response
    },
    end(chunk?: unknown): void {
      if (typeof chunk === 'string') body = chunk
    },
  }
  return {
    response: response as unknown as ServerResponse,
    captured: () => ({
      status,
      headers,
      body,
      json: () => (body === '' ? undefined : JSON.parse(body) as unknown),
    }),
  }
}

interface RequestOpts {
  method: string
  url: string
  origin?: string
  host?: string
  /** JSON body, serialized by the harness. */
  body?: unknown
  /** Verbatim body bytes (malformed JSON / empty stream cases). */
  rawBody?: string
  /** Peer address the download/restart fences read; loopback unless a test says otherwise. */
  remoteAddress?: string
}

/** A fake IncomingMessage: headers + an async-iterable body (readJsonBody's only needs). */
function makeRequest(opts: RequestOpts): IncomingMessage {
  const headers: Record<string, string> = {}
  if (opts.origin !== undefined) headers.origin = opts.origin
  if (opts.host !== undefined) headers.host = opts.host
  const chunks: Buffer[] = []
  if (opts.rawBody !== undefined) chunks.push(Buffer.from(opts.rawBody))
  else if (opts.body !== undefined) chunks.push(Buffer.from(JSON.stringify(opts.body)))
  const request = {
    method: opts.method,
    url: opts.url,
    headers,
    // Loopback by default, like the browser this route serves: the download
    // fence reads `socket.remoteAddress`, and a request without a socket made
    // that path throw instead of answering.
    socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next: async (): Promise<IteratorResult<Buffer>> =>
          i < chunks.length ? { done: false, value: chunks[i++]! } : { done: true, value: undefined },
      }
    },
  } as unknown as IncomingMessage
  return request
}

/** Run one route handler to completion and return its captured response. */
async function hit(routes: Map<string, RouteHandler>, path: string, opts: RequestOpts): Promise<Captured> {
  const handler = routes.get(path)
  if (handler === undefined) throw new Error(`route not mounted: ${path}`)
  const { response, captured } = makeResponse()
  await handler(makeRequest(opts), response)
  return captured()
}

const jsonBody = (res: Captured): Record<string, unknown> => res.json() as Record<string, unknown>

/** Same-origin POST options (success-path default). */
function post(path: string, body: unknown): RequestOpts {
  return { method: 'POST', url: path, origin: ORIGIN, host: HOST, body }
}

/**
 * A request whose body stream never ends until `finish()` is called. Used to
 * hold the direct-write lock deterministically: restore-snapshot /
 * delete-snapshot acquire the lock BEFORE awaiting the body,
 * so a pending body keeps `writing` true until the test releases it.
 */
function makePendingRequest(path: string): { request: IncomingMessage; finish: () => void } {
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  let yielded = false
  const request = {
    method: 'POST',
    url: path,
    headers: { origin: ORIGIN, host: HOST },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      await gate
      if (!yielded) {
        yielded = true
        yield Buffer.from('{}')
      }
    },
  } as unknown as IncomingMessage
  return { request, finish }
}

/** Let pending micro/macrotasks flush (lock acquisition, state writes). */
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

// --- profile fixture --------------------------------------------------------

let tmp: string
/** Active profile dir: $DSH_HOME/profiles/web (profileDir derivation). */
let dir: string
let routes: Map<string, RouteHandler>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dshm-routes-'))
  process.env.DSH_HOME = tmp
  dir = join(tmp, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  routes = mount().routes
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(tmp, { recursive: true, force: true })
})

/** Write the profile manifest with the given bundle stack. */
function writeProfile(bundles: string[]): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'web-profile',
    dsh: { profile: { bundles } },
    dependencies: Object.fromEntries(bundles.map(name => [name, '^1.0.0'])),
  }, null, 2))
}

/** Write one bundle package (manifest + patch) into the profile's node_modules. */
function writeBundle(name: string, opts: { order?: { before?: string[]; after?: string[] }; entries?: Array<{ id: string; name?: string }> } = {}): void {
  const entries = opts.entries ?? [{ id: `${name.replace(/^@[^/]+\//, '')}-entry`, name }]
  const pkgDir = join(dir, 'node_modules', name)
  mkdirSync(pkgDir, { recursive: true })
  const bundle: Record<string, unknown> = { patch: './cordis.patch.yml' }
  if (opts.order !== undefined) bundle.order = opts.order
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    dsh: { bundle },
  }, null, 2))
  writeFileSync(join(pkgDir, 'cordis.patch.yml'), dump([{ insert: entries }]))
}

/** Standard healthy fixture: official + two distinct community bundles. */
function writeStandardProfile(): void {
  writeProfile(['@deepseek-ai/dsh-base', 'alpha', 'beta'])
  writeBundle('@deepseek-ai/dsh-base')
  writeBundle('alpha')
  writeBundle('beta')
}

// --- tests ------------------------------------------------------------------

describe('method & Allow contract', () => {
  it.each([
    ['/dsh-market/check', 'POST', 'GET'],
    ['/dsh-market/discovery-compatibility', 'GET', 'POST'],
    ['/dsh-market/bundle-order', 'GET', 'POST'],
    ['/dsh-market/snapshots', 'DELETE', 'GET, POST'],
    ['/dsh-market/restore-snapshot', 'GET', 'POST'],
    ['/dsh-market/host-recovery', 'POST', 'GET'],
    ['/dsh-market/host-recovery/restore', 'GET', 'POST'],
    ['/dsh-market/delete-snapshot', 'GET', 'POST'],
    ['/dsh-market/presets', 'DELETE', 'GET, POST'],
  ])('answers 405 with an Allow header on %s', async (path, method, allow) => {
    const res = await hit(routes, path as string, { method: method as string, url: path as string })
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe(allow)
  })
})

describe('origin enforcement (POST routes)', () => {
  const mutating: Array<[string, unknown]> = [
    ['/dsh-market/discovery-compatibility', { packages: [] }],
    ['/dsh-market/bundle-order', { order: ['beta', 'alpha'] }],
    ['/dsh-market/snapshots', undefined],
    ['/dsh-market/restore-snapshot', { snapshot: 'snapshot-x' }],
    ['/dsh-market/host-recovery/restore', { name: 'cordis.patch.yml.bak-1' }],
    ['/dsh-market/delete-snapshot', { snapshot: 'snapshot-x' }],
    ['/dsh-market/presets', { action: 'save', name: 'p' }],
  ]

  it.each(mutating)('rejects a cross-origin POST %s with 403', async (path, body) => {
    const res = await hit(routes, path as string, {
      method: 'POST',
      url: path as string,
      origin: 'http://evil.example',
      host: HOST,
      body,
    })
    expect(res.status).toBe(403)
    expect(jsonBody(res)).toEqual({ error: 'untrusted origin' })
  })

  it.each(mutating)('accepts a POST %s with no Origin header at all (#648)', async (path, body) => {
    // The Desktop app's proxy strips Origin before forwarding, so its
    // requests arrive exactly like this. They must reach the route: refusing
    // the header's absence answered 403 to every Desktop mutation while
    // protecting nothing a browser-driven cross-site POST (the case just
    // above, still refused) does not already cover.
    //
    // `not.toBe(403)` rather than 200 on purpose: this fixture may fail the
    // request for its own reasons, and the assertion is about the origin
    // gate, not about the route's outcome.
    const res = await hit(routes, path as string, { method: 'POST', url: path as string, host: HOST, body })
    expect(res.status).not.toBe(403)
    expect(jsonBody(res)).not.toEqual({ error: 'untrusted origin' })
  })

  it('passes a matching Origin through (same-origin success path)', async () => {
    writeStandardProfile()
    const res = await hit(routes, '/dsh-market/bundle-order', post('/dsh-market/bundle-order', { order: ['beta', 'alpha'] }))
    expect(res.status).toBe(200)
  })
})

describe('body validation — 400 contracts', () => {
  it('discovery compatibility bounds and validates npm package names', async () => {
    for (const body of [
      null,
      [],
      {},
      { packages: 'plugin-a' },
      { packages: ['https://evil.example/package'] },
      { packages: Array.from({ length: 65 }, (_, index) => `plugin-${String(index)}`) },
    ]) {
      const res = await hit(
        routes,
        '/dsh-market/discovery-compatibility',
        post('/dsh-market/discovery-compatibility', body),
      )
      expect(res.status).toBe(400)
      expect(String(jsonBody(res).error)).toMatch(/packages must be an array/)
    }
  })

  it('discovery compatibility accepts an empty bounded batch without network access', async () => {
    const res = await hit(
      routes,
      '/dsh-market/discovery-compatibility',
      post('/dsh-market/discovery-compatibility', { packages: [] }),
    )
    expect(res.status).toBe(200)
    expect(jsonBody(res).plugins).toEqual({})
  })

  it('reads GitHub requirements only from current catalog entries, using their own archive', async () => {
    const entry = { name: 'WhaleMaid', owner: 'owner', url: 'https://github.com/owner/whale/tree/main/packages/host',
      tarball: 'https://github.com/owner/whale/releases/latest/download/full.tgz',
      category: 'workflow', description: { en: 'Whale.' }, install: '', added: '2026-10-26' }
    const registry = vi.spyOn(registryApi, 'loadRegistry').mockResolvedValue({
      name: 'catalog', updated: '2026-10-26', count: 1, categories: {}, plugins: [entry],
    })
    const lookup = vi.spyOn(DiscoveryManifestIndex.prototype, 'lookupGitHub').mockResolvedValue({
      [entry.url]: { version: '1.2.1', enginesDsh: '0.2.1-rc.2 || 0.2.1-rc.3', peerDependencies: {} },
    })
    try {
      const res = await hit(routes, '/dsh-market/discovery-compatibility',
        post('/dsh-market/discovery-compatibility', { packages: [], entries: [entry.url] }))
      expect(res.status).toBe(200)
      expect(jsonBody(res).plugins[entry.url]).toMatchObject({
        basis: 'manifest', requirement: '0.2.1-rc.2 || 0.2.1-rc.3',
      })
      expect(lookup).toHaveBeenCalledWith([entry])
      lookup.mockClear()
      const foreign = await hit(routes, '/dsh-market/discovery-compatibility',
        post('/dsh-market/discovery-compatibility', { packages: [], entries: ['https://github.com/other/unlisted'] }))
      expect(foreign.status).toBe(400)
      expect(lookup).not.toHaveBeenCalled()
    } finally { registry.mockRestore(); lookup.mockRestore() }
  })

  it('bounds mixed GitHub/npm batches and refuses non-GitHub manifest URLs before lookup', async () => {
    for (const entries of [['http://127.0.0.1/package.json'], ['https://github.com/o/r/tree/main/../secret'],
      Array.from({ length: 64 }, (_, i) => `https://github.com/owner/plugin-${String(i)}`)]) {
      const res = await hit(routes, '/dsh-market/discovery-compatibility',
        post('/dsh-market/discovery-compatibility', { packages: ['plugin-a'], entries }))
      expect(res.status).toBe(400)
    }
  })

  it('bundle-order refuses a null / non-object / non-string-array order', async () => {
    writeStandardProfile()
    // A well-formed array that is NOT a permutation (e.g. ['alpha']) is a 422
    // trial/merge rejection — the 400 contract covers shape violations only.
    const cases: Array<[unknown, RegExp]> = [
      [null, /JSON body is required/],
      [{}, /order must be an array/],
      [{ order: 'alpha' }, /order must be an array/],
      [{ order: ['alpha', 42] }, /order must be an array/],
    ]
    for (const [body, pattern] of cases) {
      const res = await hit(routes, '/dsh-market/bundle-order', post('/dsh-market/bundle-order', body))
      expect(res.status, `body ${JSON.stringify(body)}`).toBe(400)
      expect(String(jsonBody(res).error)).toMatch(pattern)
    }

    // …while a non-permutation STRING array is refused by the trial gate (422).
    const incomplete = await hit(routes, '/dsh-market/bundle-order', post('/dsh-market/bundle-order', { order: ['alpha'] }))
    expect(incomplete.status).toBe(422)
  })

  it('restore-snapshot refuses a missing / empty / non-string snapshot id', async () => {
    const cases: Array<[unknown, RegExp]> = [
      [null, /snapshot id is required/],
      [{}, /snapshot id is required/],
      [{ snapshot: '' }, /snapshot id is required/],
      [{ snapshot: 42 }, /snapshot id is required/],
    ]
    for (const [body, pattern] of cases) {
      const res = await hit(routes, '/dsh-market/restore-snapshot', post('/dsh-market/restore-snapshot', body))
      expect(res.status, `body ${JSON.stringify(body)}`).toBe(400)
      expect(String(jsonBody(res).error)).toMatch(pattern)
    }
  })

  it('presets refuses a null body, a missing action and an unknown action', async () => {
    const nullBody = await hit(routes, '/dsh-market/presets', post('/dsh-market/presets', null))
    expect(nullBody.status).toBe(400)
    const noAction = await hit(routes, '/dsh-market/presets', post('/dsh-market/presets', {}))
    expect(noAction.status).toBe(400)
    const badAction = await hit(routes, '/dsh-market/presets', post('/dsh-market/presets', { action: 'explode' }))
    expect(badAction.status).toBe(400)
    expect(String(jsonBody(badAction).error)).toMatch(/save \| preview \| apply \| delete/)
  })

  it('previewing a preset that does not exist is 422, not a 500', async () => {
    const res = await hit(routes, '/dsh-market/presets', post('/dsh-market/presets', { action: 'preview', name: 'ghost' }))
    expect(res.status).toBe(422)
    expect(jsonBody(res)).toMatchObject({ ok: false })
  })

  it('delete-snapshot refuses a missing id and a traversal-shaped id', async () => {
    const missing = await hit(routes, '/dsh-market/delete-snapshot', post('/dsh-market/delete-snapshot', {}))
    expect(missing.status).toBe(400)
    // The traversal-shaped id passes the route's string check but is refused
    // by deleteSnapshot's id validation BEFORE touching the filesystem — the
    // route reports it as a plain not-found (ok:false, 400).
    const traversal = await hit(routes, '/dsh-market/delete-snapshot', post('/dsh-market/delete-snapshot', { snapshot: '../escape' }))
    expect(traversal.status).toBe(400)
    expect(jsonBody(traversal)).toMatchObject({ ok: false, error: 'snapshot not found / 快照不存在' })
    const traversal2 = await hit(routes, '/dsh-market/delete-snapshot', post('/dsh-market/delete-snapshot', { snapshot: 'snapshot-../../etc/passwd' }))
    expect(traversal2.status).toBe(400)
  })

  it('an unparseable byte stream is refused without touching the profile (500 — parse error)', async () => {
    // Documented contract edge: JSON.parse failures surface as 500 (server-side
    // parse error) rather than 400 — the intentional 400 shapes are the JSON
    // `null` / malformed-value cases above. Nothing may be written either way.
    writeProfile(['@deepseek-ai/dsh-base', 'alpha', 'beta'])
    const before = readFileSync(join(dir, 'package.json'), 'utf8')
    const res = await hit(routes, '/dsh-market/bundle-order', {
      method: 'POST',
      url: '/dsh-market/bundle-order',
      origin: ORIGIN,
      host: HOST,
      rawBody: '{oops',
    })
    expect(res.status).toBe(500)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
  })
})

describe('GET /dsh-market/check — report contract', () => {
  it('returns the full analysis report on a healthy profile', async () => {
    writeStandardProfile()
    const res = await hit(routes, '/dsh-market/check', { method: 'GET', url: '/dsh-market/check' })
    expect(res.status).toBe(200)
    const report = res.json() as {
      profile: string
      scannedAt: number
      bundles: Array<{ name: string; kind: string }>
      rows: unknown[]
      duplicates: unknown[]
      duplicateNames: unknown[]
      overrides: unknown[]
      orphans: unknown[]
      peerMismatches: unknown[]
      multiVersion: unknown[]
      orderConflicts: unknown[]
      suggestedOrder: { ok: true; order: string[] } | null
      summary: { ok: boolean; errors: string[]; warnings: string[] }
    }
    expect(report.profile).toBe(dir)
    expect(typeof report.scannedAt).toBe('number')
    expect(report.bundles.map(b => b.name)).toEqual(['@deepseek-ai/dsh-base', 'alpha', 'beta'])
    expect(report.bundles[0]?.kind).toBe('official')
    expect(report.bundles[1]?.kind).toBe('community')
    // Every phase-1 collection is present (client depends on these fields).
    for (const key of ['rows', 'duplicates', 'duplicateNames', 'overrides', 'orphans',
      'peerMismatches', 'multiVersion', 'orderConflicts'] as const) {
      expect(Array.isArray(report[key]), key).toBe(true)
    }
    // Healthy profile, no declared rules → no suggestion (issue #125 review).
    expect(report.suggestedOrder).toBeNull()
    expect(report.summary).toEqual({ ok: true, errors: [], warnings: [] })
  })

  it('#201: attaches optional + classifyPeer verdict to every peer row', async () => {
    writeProfile(['@deepseek-ai/dsh-base', 'alpha'])
    writeBundle('@deepseek-ai/dsh-base')
    writeBundle('alpha')
    // alpha declares three peers: a belowMin risk, an optional mismatch and
    // one that cannot be resolved from anywhere (host-only package, absent).
    const alphaDir = join(dir, 'node_modules', 'alpha')
    writeFileSync(join(alphaDir, 'package.json'), JSON.stringify({
      name: 'alpha', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
      peerDependencies: {
        '@deepseek-ai/dsh-tools': '^0.1.0-rc.7',
        '@deepseek-ai/cordis': '^4.0.2',
        '@deepseek-ai/absent-host-only': '^0.1.0',
      },
      peerDependenciesMeta: {
        '@deepseek-ai/cordis': { optional: true },
      },
    }, null, 2))
    const writeResolved = (name: string, version: string) => {
      const pkgDir = join(dir, 'node_modules', name)
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version }, null, 2))
    }
    writeResolved('@deepseek-ai/dsh-tools', '0.1.0-rc.6')
    writeResolved('@deepseek-ai/cordis', '4.0.1')

    const res = await hit(routes, '/dsh-market/check', { method: 'GET', url: '/dsh-market/check' })
    expect(res.status).toBe(200)
    const report = res.json() as {
      peerMismatches: Array<{
        plugin: string; name: string; resolved: string | null; satisfied: boolean | null
        optional?: boolean
        verdict: { kind: string; risk?: { direction: string }; warning?: { reason: string } }
      }>
    }
    expect(report.peerMismatches).toHaveLength(3)
    const risk = report.peerMismatches.find(row => row.name === '@deepseek-ai/dsh-tools')
    // `optional` is OMITTED rather than false on a row the plugin did not
    // mark (#275), so absence is the assertion — the verdict beside it is
    // what proves the row was classified as non-optional and not skipped.
    expect(risk?.optional).toBeUndefined()
    expect(risk?.verdict).toMatchObject({ kind: 'risk', risk: { direction: 'belowMin' } })
    const optional = report.peerMismatches.find(row => row.name === '@deepseek-ai/cordis')
    expect(optional?.optional).toBe(true)
    expect(optional?.verdict).toMatchObject({ kind: 'warning', warning: { reason: 'optional' } })
    const absent = report.peerMismatches.find(row => row.name === '@deepseek-ai/absent-host-only')
    expect(absent?.satisfied).toBeNull()
    expect(absent?.verdict).toMatchObject({ kind: 'none' })
  })

  it('reports bundle-order rule violations in orderConflicts', async () => {
    writeProfile(['@deepseek-ai/dsh-base', 'alpha', 'beta'])
    writeBundle('@deepseek-ai/dsh-base')
    // alpha declares "load after beta", but the current order puts alpha first.
    writeBundle('alpha', { order: { after: ['beta'] } })
    writeBundle('beta')

    const res = await hit(routes, '/dsh-market/check', { method: 'GET', url: '/dsh-market/check' })
    const report = res.json() as { orderConflicts: Array<{ name: string; reason: string }>; summary: { warnings: string[] } }
    expect(res.status).toBe(200)
    expect(report.orderConflicts.map(c => c.name)).toEqual(['alpha'])
    expect(report.orderConflicts[0]?.reason).toContain('must load after beta')
    expect(report.summary.warnings.some(w => w.includes('violates declared rules'))).toBe(true)
  })
})

describe('GET /dsh-market/installed — local repository evidence', () => {
  it('returns package repository identities without changing the installed map', async () => {
    const target = join(tmp, 'dsh-vision-bridge')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: {
      'dsh-vision-bridge': `link:${target}`,
    } }))
    writeFileSync(join(target, 'package.json'), JSON.stringify({
      name: 'dsh-vision-bridge',
      repository: 'github:GXX182/dsh-vision-bridge',
    }))

    const res = await hit(routes, '/dsh-market/installed', { method: 'GET', url: '/dsh-market/installed' })
    expect(res.status).toBe(200)
    expect(jsonBody(res)).toMatchObject({
      installed: { 'dsh-vision-bridge': `link:${target}` },
      repoIdentities: { 'dsh-vision-bridge': ['gxx182/dsh-vision-bridge'] },
      repoHints: {},
    })
  })

  it('reports the source of a plugin installed from a Release archive URL (#1147)', async () => {
    // A plugin published only as a GitHub Release tarball installs as a plain
    // https spec, which repoOfTarget deliberately refuses (that answer decides
    // where future updates come from). Reporting nothing here left the client
    // with no identity at all, so with a same-named catalog row present it
    // could not say which one was installed: Discover kept offering Install
    // and the Installed tab showed the bare package name.
    const spec = 'https://github.com/StarWind97/dsh-fatfish-notes/releases/download/v0.6.0/dsh-fatfish-notes-0.6.0.tgz'
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-fatfish-notes': spec } }))

    const res = await hit(routes, '/dsh-market/installed', { method: 'GET', url: '/dsh-market/installed' })
    expect(res.status).toBe(200)
    expect(jsonBody(res)).toMatchObject({
      installed: { 'dsh-fatfish-notes': spec },
      repoIdentities: { 'dsh-fatfish-notes': ['starwind97/dsh-fatfish-notes'] },
    })
  })
})

describe('GET /dsh-market/backup — a failure says why (#55)', () => {
  // kettly1260 hit "Error: HTTP 500" and asked how to find out more: the route
  // did answer with the reason, the client threw it away. Both ends are
  // asserted here — the body carries the reason, and the log carries it too so
  // a report can include it.
  it('names the cap when the profile has more configuration files than a backup holds', async () => {
    writeStandardProfile()
    for (let i = 0; i < 300; i++) writeFileSync(join(dir, `conf-${String(i)}.yml`), `key: ${String(i)}\n`)
    configurePersistentLog(join(tmp, 'log.ndjson'))
    let res: Captured
    try {
      res = await hit(routes, '/dsh-market/backup', { method: 'GET', url: '/dsh-market/backup', host: HOST })
    } finally { configurePersistentLog(null) }
    expect(res.status).toBe(500)
    const body = JSON.parse(res.body) as { error: string }
    expect(body.error).toContain('配置文件超过 256 个')
    expect(body.error).toContain('export selected plugins instead')
    expect(readPersistentLog(join(tmp, 'log.ndjson')).join('\n')).toContain('"event":"backup"')
  })

  it('still exports a profile inside the cap', async () => {
    writeStandardProfile()
    const res = await hit(routes, '/dsh-market/backup', { method: 'GET', url: '/dsh-market/backup', host: HOST })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).files.length).toBeGreaterThan(0)
  })
})

describe('POST /dsh-market/dismiss-broken (#763)', () => {
  // #763: the removed-declaration notice is durable on purpose — it is the only
  // thing left that can say why a plugin vanished. But when the plugin is gone
  // from the catalog too, the one action it offered ("Find this plugin")
  // searches for nothing, and the notice is a banner no user can remove. The
  // entry has to stay explainable AND escapable: the user is allowed to stop
  // being told, without the market pretending the plugin was repaired.

  const BROKEN = { reason: 'incomplete-build-locked', at: '2026-09-29T00:00:00.000Z' } as const

  /** Seed two notices on disk, then re-mount so the routes read them at boot. */
  function seedBroken(a: string, b: string): void {
    writeStandardProfile()
    writeMarketState(dir, {
      disabled: new Set(), groups: {}, groupOrder: [],
      brokenPlugins: {
        [a]: { spec: 'github:o/alpha', ...BROKEN },
        [b]: { spec: 'github:o/beta', ...BROKEN },
      },
    })
    routes = mount().routes
  }

  const listed = async (): Promise<Record<string, unknown>> =>
    jsonBody(await hit(routes, '/dsh-market/installed', { method: 'GET', url: '/dsh-market/installed' }))
      .brokenPlugins as Record<string, unknown>

  it('keeps a cancel-caused removal across a restart, and keeps its reason (#663)', async () => {
    // The notice is what explains the plugin's absence after the next start,
    // and the next start is exactly when state.json is read back from disk. A
    // reason the reader does not know is dropped there, which would make the
    // cancel case vanish on restart — the one moment it was written for.
    writeStandardProfile()
    writeMarketState(dir, {
      disabled: new Set(), groups: {}, groupOrder: [],
      brokenPlugins: { 'dsh-pet': { spec: '^0.3.5', reason: 'incomplete-build-cancelled', at: '2026-10-08T00:27:20.000Z' } },
    })
    routes = mount().routes

    expect(await listed()).toMatchObject({ 'dsh-pet': { spec: '^0.3.5', reason: 'incomplete-build-cancelled' } })
  })

  it('removes only the named notice and leaves the others standing', async () => {
    seedBroken('dsh-alpha', 'dsh-beta')
    expect(Object.keys(await listed()).sort()).toEqual(['dsh-alpha', 'dsh-beta'])

    const res = await hit(routes, '/dsh-market/dismiss-broken', post('/dsh-market/dismiss-broken', { name: 'dsh-alpha' }))

    expect(res.status).toBe(200)
    expect(jsonBody(res)).toMatchObject({ ok: true })
    // The other notice is a different plugin's absence and still needs saying.
    expect(Object.keys(await listed())).toEqual(['dsh-beta'])
    // ...and the same on disk, not only in the reply.
    expect(Object.keys(readMarketState(dir).brokenPlugins ?? {})).toEqual(['dsh-beta'])
  })

  it('survives a reload, so dismissing is not undone by the next start (#763)', async () => {
    // The reporter refreshed the page, restarted DSH, updated the market itself
    // and installed other plugins: the notice was still there. This is the half
    // a reply-only fix would miss — the dismissal has to be persisted, not held
    // in the in-memory state the request happened to touch.
    seedBroken('dsh-alpha', 'dsh-beta')
    await hit(routes, '/dsh-market/dismiss-broken', post('/dsh-market/dismiss-broken', { name: 'dsh-alpha' }))

    // A fresh mount is a fresh boot reading state.json: nothing in memory.
    routes = mount().routes
    expect(Object.keys(await listed())).toEqual(['dsh-beta'])
    expect('dsh-alpha' in readMarketState(dir).brokenPlugins!).toBe(false)
  })

  it('keeps the reinstall auto-clear contract working alongside it (#663)', async () => {
    // Two ways an entry leaves this map, and they must not fight: the market
    // drops it when the plugin comes back, the user drops it when they stop
    // wanting to hear about it. A dismiss must not resurrect a notice that
    // install already cleared, and must not be blocked by one.
    seedBroken('dsh-alpha', 'dsh-beta')
    await hit(routes, '/dsh-market/dismiss-broken', post('/dsh-market/dismiss-broken', { name: 'dsh-alpha' }))

    const res = await hit(routes, '/dsh-market/dismiss-broken', post('/dsh-market/dismiss-broken', { name: 'dsh-beta' }))

    // The last notice cleared must not leave an empty object behind claiming
    // there is something broken: the notice is driven by keys existing.
    expect(res.status).toBe(200)
    expect(jsonBody(res)).toMatchObject({ ok: true, brokenPlugins: {} })
    expect(await listed()).toEqual({})
    expect(readMarketState(dir).brokenPlugins).toBeUndefined()
    expect('brokenPlugins' in readRawState()).toBe(false)
  })

  it('is idempotent and never invents a notice for a name that has none', async () => {
    seedBroken('dsh-alpha', 'dsh-beta')
    await hit(routes, '/dsh-market/dismiss-broken', post('/dsh-market/dismiss-broken', { name: 'dsh-alpha' }))

    // Dismissing twice must be a no-op, not a second write that could race.
    const again = await hit(routes, '/dsh-market/dismiss-broken', post('/dsh-market/dismiss-broken', { name: 'dsh-alpha' }))

    expect(again.status).toBe(200)
    expect(jsonBody(again)).toMatchObject({ ok: true })
    // A name that was never broken is not an error either: the client and the
    // user can both be out of date, and refusing would strand the button.
    const absent = await hit(routes, '/dsh-market/dismiss-broken', post('/dsh-market/dismiss-broken', { name: 'dsh-never-existed' }))
    expect(absent.status).toBe(200)
    expect(Object.keys(await listed())).toEqual(['dsh-beta'])
  })

  it('a dismiss that removes nothing does not touch the file or the log (#763 review)', async () => {
    // The log is the durable record of what the market did (#663), and the
    // reporter had to export one to get an answer. A line saying "the user hid
    // the notice for X" for a name that had no notice is a false statement in
    // the one file that is supposed to be true — and it is written on every
    // double-click and every out-of-date client.
    // Names unique to this spec: the in-memory log is shared across a test
    // file, so a bare count of the event would also count the other specs here.
    const mine = 'dsh-noop-probe'
    seedBroken(mine, 'dsh-beta')
    const dismiss = (name: string) =>
      hit(routes, '/dsh-market/dismiss-broken', post('/dsh-market/dismiss-broken', { name }))
    // The export renders every entry twice (a JSON line and a readable one), so
    // count the machine form only — one event is one of those.
    const linesFor = (body: string) =>
      body.split('\n').filter(line => line.includes('"event":"broken-notice-dismissed"') && line.includes(mine))

    // One real dismissal, to establish the line that must NOT grow after this.
    await dismiss(mine)
    const logsAfterReal = (await hit(routes, '/dsh-market/logs', { method: 'GET', url: '/dsh-market/logs' })).body
    expect(linesFor(logsAfterReal)).toHaveLength(1)
    expect(logsAfterReal).toContain('broken-notice-dismissed')
    const stateAfterReal = readFileSync(join(dir, '.dsh-market', 'state.json'), 'utf8')

    // The same name again, and a name that never had a notice.
    await dismiss(mine)
    await dismiss('dsh-never-existed')

    const logsAfterNoop = (await hit(routes, '/dsh-market/logs', { method: 'GET', url: '/dsh-market/logs' })).body
    expect(linesFor(logsAfterNoop)).toHaveLength(1)
    // ...and the state file is byte-identical: a no-op that rewrote it would be
    // indistinguishable from a real change to anyone reading the file later.
    expect(readFileSync(join(dir, '.dsh-market', 'state.json'), 'utf8')).toBe(stateAfterReal)
    // Still the authoritative list, and the other notice untouched.
    expect(Object.keys(await listed())).toEqual(['dsh-beta'])
  })

  it('refuses a cross-origin dismiss and validates the name', async () => {
    seedBroken('dsh-alpha', 'dsh-beta')

    const cross = await hit(routes, '/dsh-market/dismiss-broken', {
      method: 'POST', url: '/dsh-market/dismiss-broken', origin: 'http://evil.example', host: HOST, body: { name: 'dsh-alpha' },
    })
    expect(cross.status).toBe(403)
    expect(jsonBody(cross)).toEqual({ error: 'untrusted origin' })

    for (const body of [null, {}, { name: '' }, { name: '   ' }, { name: 42 }, { name: 'x'.repeat(215) }]) {
      const res = await hit(routes, '/dsh-market/dismiss-broken', post('/dsh-market/dismiss-broken', body))
      expect(res.status).toBe(400)
    }
    // A rejected request must not have removed anything.
    expect(Object.keys(await listed()).sort()).toEqual(['dsh-alpha', 'dsh-beta'])
  })

  it('answers GET with 405 rather than pretending the notice is dismissable that way', async () => {
    seedBroken('dsh-alpha', 'dsh-beta')
    const res = await hit(routes, '/dsh-market/dismiss-broken', { method: 'GET', url: '/dsh-market/dismiss-broken' })
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe('POST')
  })

  it('does not touch the leftover directory or the rest of the state (#763)', async () => {
    // The notice explains an absence; dismissing it is a statement about the
    // message, not a repair. Deleting the directory here would destroy the
    // only thing the user can reinstall from, and would make "dismiss" mean
    // two different things to the profile.
    seedBroken('dsh-alpha', 'dsh-beta')
    const leftover = join(dir, 'node_modules', 'dsh-alpha')
    mkdirSync(leftover, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'web-profile', dependencies: { 'dsh-beta': '^1.0.0' } }))

    await hit(routes, '/dsh-market/dismiss-broken', post('/dsh-market/dismiss-broken', { name: 'dsh-alpha' }))

    expect(existsSync(leftover)).toBe(true)
    // The profile's own declarations are not this route's business either.
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies).toEqual({ 'dsh-beta': '^1.0.0' })
  })

  it('records the dismissal in the log without claiming the plugin was fixed', async () => {
    // log.ndjson is the durable record of what the market did (#663). Wording
    // matters here: "repaired" or "reinstalled" would be a false statement the
    // user reads later, when they open the very directory this left in place.
    seedBroken('dsh-alpha', 'dsh-beta')
    await hit(routes, '/dsh-market/dismiss-broken', post('/dsh-market/dismiss-broken', { name: 'dsh-alpha' }))

    const res = await hit(routes, '/dsh-market/logs', { method: 'GET', url: '/dsh-market/logs' })
    expect(res.body).toContain('dsh-alpha')
    expect(res.body).not.toMatch(/repaired|已修复|reinstalled|已重装/)
  })
})

/** Raw state.json on disk, so a test can assert a key is absent, not just empty. */
function readRawState(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, '.dsh-market', 'state.json'), 'utf8')) as Record<string, unknown>
}

describe('POST /dsh-market/bundle-order', () => {
  it('applies a valid community reorder: 200 with the merged stack, manifest rewritten', async () => {
    // #125/#126: the in-route pre-write safety net is the profile backup, and
    // a persistent snapshot is auto-created before the write (issue #126).
    writeStandardProfile()
    const res = await hit(routes, '/dsh-market/bundle-order', post('/dsh-market/bundle-order', { order: ['beta', 'alpha'] }))
    expect(res.status).toBe(200)
    const body = jsonBody(res)
    expect(body.ok).toBe(true)
    expect(body.bundles).toEqual(['@deepseek-ai/dsh-base', 'beta', 'alpha'])

    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'beta', 'alpha'])
  })

  it('persists a profile snapshot BEFORE the write (issue #126: recoverable reorder)', async () => {
    writeStandardProfile()
    const res = await hit(routes, '/dsh-market/bundle-order', post('/dsh-market/bundle-order', { order: ['beta', 'alpha'] }))
    expect(res.status).toBe(200)
    const body = jsonBody(res)
    expect(body.ok).toBe(true)
    // The response carries the pre-write snapshot id.
    expect(typeof body.snapshot).toBe('string')
    expect(String(body.snapshot)).toMatch(/^snapshot-/)
    // The snapshot was persisted BEFORE the write: it captures the ORIGINAL
    // order [alpha, beta], so restoring it reverts the reorder.
    const snapDir = join(dir, '.dsh-market', 'snapshots')
    const snapFiles = readdirSync(snapDir).filter(f => f.endsWith('.json'))
    expect(snapFiles).toHaveLength(1)
    const snap = JSON.parse(readFileSync(join(snapDir, snapFiles[0]!), 'utf8')) as { files: Array<{ path: string; json: { dsh?: { profile?: { bundles?: string[] } } } }> }
    const manifestJson = snap.files.find(f => f.path === 'package.json')
    expect(manifestJson?.json.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', 'alpha', 'beta'])
  })

  it('refuses to reorder when the full pre-write composition cannot be captured', async () => {
    writeStandardProfile()
    mkdirSync(join(dir, '.dsh-market', 'state.json'), { recursive: true })
    const before = readFileSync(join(dir, 'package.json'), 'utf8')

    const res = await hit(routes, '/dsh-market/bundle-order', post('/dsh-market/bundle-order', { order: ['beta', 'alpha'] }))
    expect(res.status).toBe(400)
    expect(String(jsonBody(res).error)).toContain('.dsh-market/state.json could not be read')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
    expect(existsSync(join(dir, '.dsh-market', 'snapshots'))).toBe(false)
  })

  it('reorders from malformed optional state and snapshots its observable absence', async () => {
    writeStandardProfile()
    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
    writeFileSync(join(dir, '.dsh-market', 'state.json'), '{ broken')

    const res = await hit(routes, '/dsh-market/bundle-order', post('/dsh-market/bundle-order', { order: ['beta', 'alpha'] }))
    expect(res.status).toBe(200)
    const id = String(jsonBody(res).snapshot)
    const snapshot = JSON.parse(readFileSync(join(dir, '.dsh-market', 'snapshots', `${id}.json`), 'utf8')) as {
      files: Array<{ path: string; absent?: true }>
    }
    expect(snapshot.files).toContainEqual({ path: '.dsh-market/state.json', absent: true })
    expect(readFileSync(join(dir, '.dsh-market', 'state.json'), 'utf8')).toBe('{ broken')
  })

  it('refuses a rule-violating order with 422 + conflicts', async () => {
    writeProfile(['@deepseek-ai/dsh-base', 'alpha', 'beta'])
    writeBundle('@deepseek-ai/dsh-base')
    writeBundle('alpha', { order: { after: ['beta'] } })
    writeBundle('beta')
    const before = readFileSync(join(dir, 'package.json'), 'utf8')

    const res = await hit(routes, '/dsh-market/bundle-order', post('/dsh-market/bundle-order', { order: ['alpha', 'beta'] }))
    expect(res.status).toBe(422)
    const body = jsonBody(res)
    expect(String(body.error)).toMatch(/violates declared before\/after rules/)
    expect(Array.isArray(body.conflicts)).toBe(true)
    // Refused BEFORE the write: manifest and snapshot dir untouched.
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
    expect(existsSync(join(dir, '.dsh-market', 'snapshots'))).toBe(false)
  })

  it('refuses an order that would not boot with 422 + trial errors', async () => {
    // Both bundles insert the SAME loader entry id → the composed tree would
    // fail to boot → trial validation refuses the order before any write.
    writeProfile(['@deepseek-ai/dsh-base', 'alpha', 'beta'])
    writeBundle('@deepseek-ai/dsh-base')
    writeBundle('alpha', { entries: [{ id: 'dup-entry', name: 'alpha' }] })
    writeBundle('beta', { entries: [{ id: 'dup-entry', name: 'beta' }] })
    const before = readFileSync(join(dir, 'package.json'), 'utf8')

    const res = await hit(routes, '/dsh-market/bundle-order', post('/dsh-market/bundle-order', { order: ['beta', 'alpha'] }))
    expect(res.status).toBe(422)
    const body = jsonBody(res)
    expect(String(body.error)).toMatch(/trial validation failed/)
    expect(Array.isArray((body.trial as { errors?: unknown[] }).errors)).toBe(true)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
  })

  it('answers 409 while another write holds the direct-write lock, then succeeds after release', async () => {
    writeStandardProfile()
    // restore-snapshot takes the lock BEFORE reading the body — a pending body
    // pins `writing` until the test releases it.
    const pending = makePendingRequest('/dsh-market/restore-snapshot')
    const inflight = routes.get('/dsh-market/restore-snapshot')!
    const captured = makeResponse()
    const pendingRun = inflight(pending.request, captured.response)

    // Synchronous up to the first await → the lock is already held.
    const snap = await hit(routes, '/dsh-market/snapshots', post('/dsh-market/snapshots', undefined))
    expect(snap.status).toBe(409)
    expect(jsonBody(snap)).toEqual({ error: 'another plugin operation is running', busy: true })

    const order = await hit(routes, '/dsh-market/bundle-order', post('/dsh-market/bundle-order', { order: ['beta', 'alpha'] }))
    expect(order.status).toBe(409)

    // The update route gained the same `writing` guard (issue #98 analysis).
    const upd = await hit(routes, '/dsh-market/update', post('/dsh-market/update', { name: 'alpha' }))
    expect(upd.status).toBe(409)

    // Release the lock → the same write succeeds.
    pending.finish()
    await pendingRun
    expect(captured.captured().status).toBe(400) // the released body {} → missing snapshot id

    const after = await hit(routes, '/dsh-market/snapshots', post('/dsh-market/snapshots', undefined))
    expect(after.status).toBe(200)
  })

  it('answers 409 while a pnpm operation holds the install lock', async () => {
    writeStandardProfile()
    // A hanging runPlugin keeps `installing` true for the duration of the
    // test: uninstall sets the flag, then awaits the (never-settling) stub.
    const hanging: PluginCommandRuntime = {
      runPlugin: async () => new Promise<never>(() => { /* never settles */ }),
      probePnpm: async () => true,
      provisionPnpm: async () => ({ ok: true }),
      cancelActive: () => false,
    }
    routes = mount(hanging).routes

    const uninstallRun = routes.get('/dsh-market/uninstall')!(makeRequest(post('/dsh-market/uninstall', { name: 'alpha' })), makeResponse().response)
    void uninstallRun
    await tick() // flush the microtasks up to the hanging runPlugin

    const snap = await hit(routes, '/dsh-market/snapshots', post('/dsh-market/snapshots', undefined))
    expect(snap.status).toBe(409)
    expect(jsonBody(snap)).toEqual({ error: 'another plugin operation is running', busy: true })

    const order = await hit(routes, '/dsh-market/bundle-order', post('/dsh-market/bundle-order', { order: ['beta', 'alpha'] }))
    expect(order.status).toBe(409)

    // update distinguishes the two locks in its message.
    const upd = await hit(routes, '/dsh-market/update', post('/dsh-market/update', { name: 'alpha' }))
    expect(upd.status).toBe(409)
    expect(jsonBody(upd)).toEqual({ error: 'another install is already running', busy: true })
  })

  it('restores the profile from the pre-write backup when the write throws (auto-rollback)', async () => {
    // #125 hardening (lesson from #122): if the manifest write throws
    // mid-flight, the route must roll the profile back from the backup it
    // took before writing — a broken order must never stop DSH from starting.
    writeStandardProfile()
    const before = readFileSync(join(dir, 'package.json'), 'utf8')
    const spy = vi.spyOn(orderApi, 'applyBundleOrder').mockImplementation(() => {
      throw new Error('simulated disk failure')
    })
    try {
      const res = await hit(routes, '/dsh-market/bundle-order', post('/dsh-market/bundle-order', { order: ['beta', 'alpha'] }))
      expect(res.status).toBe(500)
      expect(String(jsonBody(res).error)).toMatch(/simulated disk failure/)
    } finally {
      spy.mockRestore()
    }
    // The pre-write backup was restored: the manifest is semantically
    // identical to the pre-request state (the backup format re-serializes
    // package.json from its parsed JSON, so bytes may differ by formatting).
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).toEqual(JSON.parse(before))
    expect((JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }).dsh.profile.bundles)
      .toEqual(['@deepseek-ai/dsh-base', 'alpha', 'beta'])
  })
})

/**
 * The same-origin gate every mutating route calls before doing anything —
 * the reason a page on another site cannot POST an install at the local
 * server. It was only ever reached through whole-route tests, which meant
 * the unparseable-Origin path was never observed: a mutation making the
 * catch return true (trusting a malformed Origin) failed nothing.
 */
describe('sameOrigin', () => {
  const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage

  it('accepts an Origin whose host matches the Host header', () => {
    expect(sameOrigin(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }))).toBe(true)
    // Scheme is not part of the comparison; host:port is.
    expect(sameOrigin(req({ host: 'localhost:3080', origin: 'https://localhost:3080' }))).toBe(true)
  })

  it('refuses a different host, or the same host on a different port', () => {
    expect(sameOrigin(req({ host: '127.0.0.1:3080', origin: 'http://evil.example' }))).toBe(false)
    expect(sameOrigin(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' }))).toBe(false)
  })

  it('allows a request with no Origin at all (#648)', () => {
    // INVERTED from what this asserted before, and the reason matters: the
    // rule used to be "a mutating POST must carry Origin". Browsers do send
    // it on every POST, so its absence means the caller is not a page — and
    // a non-browser client can forge any Origin. Refusing the absence was
    // therefore not a protection, while the Desktop app's proxy strips the
    // header before forwarding and every Desktop mutation met 403.
    expect(sameOrigin(req({ host: '127.0.0.1:3080' }))).toBe(true)
    expect(sameOrigin(req({ host: '127.0.0.1:3080', origin: undefined as never }))).toBe(true)
    expect(sameOrigin(req({}))).toBe(true)
    // An Origin that is PRESENT but unparseable is still refused — including
    // the empty string, which is a malformed header rather than an absent
    // one. Only true absence is what a stripping proxy produces.
    expect(sameOrigin(req({ host: '127.0.0.1:3080', origin: '' }))).toBe(false)
    // And a present Origin still needs a Host to compare against.
    expect(sameOrigin(req({ origin: 'http://127.0.0.1:3080' }))).toBe(false)
  })

  it('refuses a DNS-rebinding request, where Origin and Host agree on the attacker (#678)', () => {
    // The attack the equality check cannot see: the page is served from
    // evil.com, that name resolves to 127.0.0.1, and the browser therefore
    // connects to the loopback listener while sending Origin AND Host as
    // evil.com. Equality holds for the attacker; Host is the only part of
    // it they cannot forge, so it is what has to name a loopback authority.
    expect(sameOrigin(req({ host: 'evil.com', origin: 'http://evil.com' }))).toBe(false)
    expect(sameOrigin(req({ host: 'evil.com:3080', origin: 'http://evil.com:3080' }))).toBe(false)
    // …including when the attacker omits Origin, which no browser does.
    expect(sameOrigin(req({ host: 'evil.com' }))).toBe(false)
  })

  it('accepts every loopback spelling, because that is what the UI is served from', () => {
    for (const host of ['127.0.0.1:3080', 'localhost:3080', '[::1]:3080']) {
      expect(sameOrigin(req({ host, origin: `http://${host}` })), host).toBe(true)
    }
    // `localhost.evil.com` is a subdomain, not `localhost`.
    expect(sameOrigin(req({ host: 'localhost.evil.com', origin: 'http://localhost.evil.com' }))).toBe(false)
  })

  it('still refuses a page whose Origin is present and different', () => {
    // The half that has to survive: this is the CSRF case, and a browser
    // always sends Origin here, so the check still sees it.
    expect(sameOrigin(req({ host: '127.0.0.1:3080', origin: 'http://evil.example' }))).toBe(false)
    expect(sameOrigin(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' }))).toBe(false)
  })

  it('still refuses a sandboxed origin, which is present-but-unparseable', () => {
    // `Origin: null` comes from a sandboxed iframe or a data: document. It is
    // NOT an absent header, and reading it as one would reopen the CSRF hole
    // this check exists for.
    expect(sameOrigin(req({ host: '127.0.0.1:3080', origin: 'null' }))).toBe(false)
    expect(sameOrigin(req({ host: '127.0.0.1:3080', origin: 'about:blank' }))).toBe(false)
  })

  it('refuses an Origin that does not parse, rather than trusting it', () => {
    for (const origin of ['not a url', '://', 'http://', '']) {
      expect(sameOrigin(req({ host: '127.0.0.1:3080', origin })), origin).toBe(false)
    }
  })
})
describe('GET/POST /dsh-market/snapshots', () => {
  it('lists an empty snapshot set, creates one, lists it again', async () => {
    writeStandardProfile()
    const empty = await hit(routes, '/dsh-market/snapshots', { method: 'GET', url: '/dsh-market/snapshots' })
    expect(empty.status).toBe(200)
    expect(jsonBody(empty)).toEqual({ snapshots: [] })

    const created = await hit(routes, '/dsh-market/snapshots', post('/dsh-market/snapshots', undefined))
    expect(created.status).toBe(200)
    const body = jsonBody(created)
    expect(body.ok).toBe(true)
    const snapshot = (body.snapshot ?? {}) as { format: string; version: number; id: string; createdAt: number; files: unknown[] }
    expect(snapshot.format).toBe('dsh-market/profile-snapshot')
    expect(snapshot.version).toBe(2)
    expect(snapshot.id).toMatch(/^snapshot-/)
    expect(typeof snapshot.createdAt).toBe('number')
    expect(snapshot.files.map((f: { path: string }) => f.path)).toEqual(['package.json', 'cordis.patch.yml', '.dsh-market/state.json'])

    const listed = await hit(routes, '/dsh-market/snapshots', { method: 'GET', url: '/dsh-market/snapshots' })
    expect((jsonBody(listed).snapshots as unknown[]).length).toBe(1)
  })

  it('answers 400 when the profile has no package.json', async () => {
    // No fixture at all: createProfileSnapshot cannot snapshot a manifest-less dir.
    const res = await hit(routes, '/dsh-market/snapshots', post('/dsh-market/snapshots', undefined))
    expect(res.status).toBe(400)
    expect(String(jsonBody(res).error)).toMatch(/package\.json is missing/)
  })

  it('answers 400 when an existing composition file cannot be captured', async () => {
    writeStandardProfile()
    mkdirSync(join(dir, 'cordis.patch.yml'))

    const res = await hit(routes, '/dsh-market/snapshots', post('/dsh-market/snapshots', undefined))
    expect(res.status).toBe(400)
    expect(String(jsonBody(res).error)).toContain('cordis.patch.yml could not be read')
  })

  it('captures malformed optional state as absent instead of blocking snapshots', async () => {
    writeStandardProfile()
    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
    writeFileSync(join(dir, '.dsh-market', 'state.json'), '{ broken')

    const res = await hit(routes, '/dsh-market/snapshots', post('/dsh-market/snapshots', undefined))
    expect(res.status).toBe(200)
    const snapshot = jsonBody(res).snapshot as { files: Array<{ path: string; absent?: true }> }
    expect(snapshot.files).toContainEqual({ path: '.dsh-market/state.json', absent: true })
    expect(readFileSync(join(dir, '.dsh-market', 'state.json'), 'utf8')).toBe('{ broken')
  })
})

describe('POST /dsh-market/restore-snapshot & /dsh-market/delete-snapshot', () => {
  it('round-trips: create → corrupt the order → restore → delete', async () => {
    writeStandardProfile()
    const created = await hit(routes, '/dsh-market/snapshots', post('/dsh-market/snapshots', undefined))
    const id = (jsonBody(created).snapshot as { id: string }).id

    // Corrupt the manifest (swap the community order by hand).
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'web-profile',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'beta', 'alpha'] } },
    }, null, 2))
    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
    writeFileSync(join(dir, 'cordis.patch.yml'), 'later patch\n')
    writeFileSync(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ disabled: ['later'] }))

    const restored = await hit(routes, '/dsh-market/restore-snapshot', post('/dsh-market/restore-snapshot', { snapshot: id }))
    expect(restored.status).toBe(200)
    const restoredBody = jsonBody(restored)
    expect(restoredBody.ok).toBe(true)
    expect(restoredBody.restored).toEqual(['package.json', 'cordis.patch.yml', '.dsh-market/state.json'])
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'alpha', 'beta'])
    expect(existsSync(join(dir, 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(dir, '.dsh-market', 'state.json'))).toBe(false)

    const deleted = await hit(routes, '/dsh-market/delete-snapshot', post('/dsh-market/delete-snapshot', { snapshot: id }))
    expect(deleted.status).toBe(200)
    expect(jsonBody(deleted)).toMatchObject({ ok: true, snapshot: id })

    const listed = await hit(routes, '/dsh-market/snapshots', { method: 'GET', url: '/dsh-market/snapshots' })
    expect(jsonBody(listed)).toEqual({ snapshots: [] })
  })

  it('restore of an unknown snapshot answers 400', async () => {
    const res = await hit(routes, '/dsh-market/restore-snapshot', post('/dsh-market/restore-snapshot', { snapshot: 'snapshot-does-not-exist' }))
    expect(res.status).toBe(400)
    expect(String(jsonBody(res).error)).toMatch(/snapshot not found/)
  })

  it('delete of an unknown snapshot answers 400', async () => {
    const res = await hit(routes, '/dsh-market/delete-snapshot', post('/dsh-market/delete-snapshot', { snapshot: 'snapshot-does-not-exist' }))
    expect(res.status).toBe(400)
    expect(String(jsonBody(res).error)).toMatch(/snapshot not found/)
  })
})

describe('market state publication (#582 narrowest point)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dshm-state-'))
    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const statePath = () => join(dir, '.dsh-market', 'state.json')

  it('leaves no half-written file and no temporary behind', () => {
    writeMarketState(dir, { disabled: new Set(['a']), groups: {}, groupOrder: [] })
    expect(readMarketState(dir).disabled.has('a')).toBe(true)
    expect(readdirSync(join(dir, '.dsh-market')).some(name => name.endsWith('.new'))).toBe(false)
  })

  it('writes through a symlinked state file instead of replacing the link (#582)', () => {
    const real = join(dir, 'state-elsewhere.json')
    writeFileSync(real, JSON.stringify({ disabled: ['keep'] }))
    symlinkSync(real, statePath())
    writeMarketState(dir, { disabled: new Set(['a', 'keep']), groups: {}, groupOrder: [] })
    expect(lstatSync(statePath()).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(real, 'utf8')).disabled).toEqual(['a', 'keep'])
  })

  it('says so when the state file cannot be read, instead of silently coming back empty', () => {
    // Every disable, group, favourite and exemption lives in this file. Coming
    // back empty silently reads as "my plugins switched themselves back on".
    writeFileSync(statePath(), '{"disabled": ["a"')
    configurePersistentLog(join(dir, 'log.ndjson'))
    try {
      expect(readMarketState(dir).disabled.size).toBe(0)
    } finally { configurePersistentLog(null) }
    // The log is the only trace: the next write replaces the damaged file.
    const logged = readPersistentLog(join(dir, 'log.ndjson')).join('\n')
    expect(logged).toContain('market state could not be read')
    // A warning, not an info line: it is the only trace this happened.
    expect(logged).toContain('"level":"warn"')
  })
})

describe('a client that reads its config from a name nothing serves (#810)', () => {
  /** A bundle package that also ships a client bundle (what the scan reads). */
  function writeClientBundle(name: string, source: string): void {
    writeBundle(name)
    const pkgDir = join(dir, 'node_modules', name)
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      dsh: Record<string, unknown>
    }
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      ...manifest,
      exports: { './client': './lib/client.js' },
      dsh: { ...manifest.dsh, client: { platform: 'web' } },
    }))
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    writeFileSync(join(pkgDir, 'lib', 'client.js'), source)
  }

  const getInstalled = async (): Promise<Record<string, unknown>> =>
    jsonBody(await hit(routes, '/dsh-market/installed', { method: 'GET', url: '/dsh-market/installed' }))

  it('names the package and the entry id it should have asked for', async () => {
    // The reported shape: the client asks for its PACKAGE name while its own
    // entry id is something else. The row needs both — the mistake to be
    // believable and the value to write instead.
    writeProfile(['alpha'])
    writeClientBundle('alpha', 'var NAMESPACE = "alpha"\nctx.configForms.get(NAMESPACE)')

    expect((await getInstalled()).configNamespaces).toEqual([
      { name: 'alpha', namespaces: ['alpha'], ownEntryIds: ['alpha-entry'] },
    ])
  })

  it('stays quiet when an entry id answers to that name, whoever declares it', async () => {
    // Served by ANOTHER package's row counts: a carrier bundle mounts ids of
    // its own, and judging by the asking package's ids alone would flag it.
    writeProfile(['alpha', 'beta'])
    writeBundle('beta', { entries: [{ id: 'shared-entry', name: 'beta' }] })
    writeClientBundle('alpha', 'ctx.configForms.get("shared-entry")')

    expect((await getInstalled()).configNamespaces).toBeUndefined()
  })

  it('reports the same finding on the diagnostics page', async () => {
    // The page composes the host layers as well, so it is the wider of the
    // two judgements; a finding on the row is a finding here.
    writeProfile(['alpha'])
    writeClientBundle('alpha', 'ctx.configForms.get("alpha-panel")')

    const body = jsonBody(await hit(routes, '/dsh-market/check', { method: 'GET', url: '/dsh-market/check' }))
    expect(body.configNamespaces).toEqual([
      { name: 'alpha', namespaces: ['alpha-panel'], ownEntryIds: ['alpha-entry'] },
    ])
  })

  it('is absent from a healthy profile, so the row renders nothing', async () => {
    writeStandardProfile()
    expect((await getInstalled()).configNamespaces).toBeUndefined()
    const body = jsonBody(await hit(routes, '/dsh-market/check', { method: 'GET', url: '/dsh-market/check' }))
    expect(body.configNamespaces).toEqual([])
  })
})

// --- #875: the host's own recovery moved the profile patch aside ---

/** The stub `sanitizeProfile` writes, and the user patch it displaced. */
const USER_PATCH_ROWS = [
  '- insert:',
  '    - id: llm-deepseek',
  '- id: permission',
  '  disabled: false',
  '',
].join('\n')

describe('host recovery (#875)', () => {
  const BACKUP = 'cordis.patch.yml.bak-1792065596554'

  it('answers with the wipe shape and restores the patch it names', async () => {
    writeProfile(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    writeFileSync(join(dir, 'cordis.patch.yml'), '# recovered\n')
    writeFileSync(join(dir, BACKUP), USER_PATCH_ROWS)

    const view = await hit(routes, '/dsh-market/host-recovery', { method: 'GET', url: '/dsh-market/host-recovery' })
    expect(view.status).toBe(200)
    expect(view.json()).toMatchObject({ offerRestore: true, lostRowIds: ['llm-deepseek', 'permission'] })

    const res = await hit(routes, '/dsh-market/host-recovery/restore', post('/dsh-market/host-recovery/restore', { name: BACKUP }))
    expect(res.status).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, restored: { rows: 2 } })
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(USER_PATCH_ROWS)

    const after = await hit(routes, '/dsh-market/host-recovery', { method: 'GET', url: '/dsh-market/host-recovery' })
    expect(after.json()).toMatchObject({ offerRestore: false })
  })

  it('says nothing on a profile its own recovery never touched', async () => {
    writeProfile(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const res = await hit(routes, '/dsh-market/host-recovery', { method: 'GET', url: '/dsh-market/host-recovery' })
    expect(res.status).toBe(200)
    expect(res.json()).toMatchObject({ offerRestore: false, backups: [] })
  })

  it('refuses a backup name that is not one of the files beside the patch', async () => {
    writeProfile(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    writeFileSync(join(dir, 'cordis.patch.yml'), '# recovered\n')
    writeFileSync(join(dir, BACKUP), USER_PATCH_ROWS)
    const res = await hit(routes, '/dsh-market/host-recovery/restore', post('/dsh-market/host-recovery/restore', { name: '../package.json' }))
    expect(res.status).toBe(400)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe('# recovered\n')
  })

  it('rejects a body that names no backup at all', async () => {
    const res = await hit(routes, '/dsh-market/host-recovery/restore', post('/dsh-market/host-recovery/restore', {}))
    expect(res.status).toBe(400)
  })
})
