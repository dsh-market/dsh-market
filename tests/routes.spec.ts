/**
 * HTTP route contract tests for the issue #98 routes — src/routes.ts. Each
 * test mounts marketRoutes against a STUB host (capturing webServer.register)
 * plus a temp profile fixture, then drives the captured handlers with fake
 * IncomingMessage / ServerResponse objects. No server socket, no pnpm, no
 * network — the same surface the real harness host provides, so the method /
 * Allow, origin, body-validation, 422 and write-lock contracts of the new
 * routes are pinned without spawning a process.
 *
 * The new routes (vs. the PR-A branch base): /dsh-market/check (PR-A) and
 * /dsh-market/bundle-order (PR-B). The snapshots & presets routes ship in
 * later stacked PRs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dump } from 'js-yaml'
import { mountMarketRoutes, type MarketHost } from '../src/routes.ts'
import * as orderApi from '../src/order.ts'
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
  mountMarketRoutes(host, { profile: 'web' }, commandRuntime)
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
 * hold the direct-write lock deterministically: bundle-order acquires the
 * lock BEFORE awaiting the body, so a pending body keeps `writing` true until
 * the test releases it.
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

describe('method & Allow contract (new routes)', () => {
  it.each([
    ['/dsh-market/check', 'POST', 'GET'],
    ['/dsh-market/bundle-order', 'GET', 'POST'],
  ])('answers 405 with an Allow header on %s', async (path, method, allow) => {
    const res = await hit(routes, path as string, { method: method as string, url: path as string })
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe(allow)
  })
})

describe('origin enforcement (mutating routes)', () => {
  const mutating: Array<[string, unknown]> = [
    ['/dsh-market/bundle-order', { order: ['beta', 'alpha'] }],
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

  it.each(mutating)('rejects a POST %s with no Origin header at all', async (path, body) => {
    const res = await hit(routes, path as string, { method: 'POST', url: path as string, host: HOST, body })
    expect(res.status).toBe(403)
  })

  it('passes a matching Origin through (same-origin success path)', async () => {
    writeStandardProfile()
    const res = await hit(routes, '/dsh-market/bundle-order', post('/dsh-market/bundle-order', { order: ['beta', 'alpha'] }))
    expect(res.status).toBe(200)
  })
})

describe('body validation — 400 contracts', () => {
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

describe('POST /dsh-market/bundle-order', () => {
  it('applies a valid community reorder: 200 with the merged stack, manifest rewritten', async () => {
    writeStandardProfile()
    const res = await hit(routes, '/dsh-market/bundle-order', post('/dsh-market/bundle-order', { order: ['beta', 'alpha'] }))
    expect(res.status).toBe(200)
    const body = jsonBody(res)
    expect(body.ok).toBe(true)
    expect(body.bundles).toEqual(['@deepseek-ai/dsh-base', 'beta', 'alpha'])

    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'beta', 'alpha'])
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
    // Refused BEFORE the write: manifest untouched.
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
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
    // bundle-order takes the lock BEFORE reading the body — a pending body
    // pins `writing` until the test releases it.
    const pending = makePendingRequest('/dsh-market/bundle-order')
    const inflight = routes.get('/dsh-market/bundle-order')!
    const captured = makeResponse()
    const pendingRun = inflight(pending.request, captured.response)

    // Synchronous up to the first await → the lock is already held.
    const concurrent = await hit(routes, '/dsh-market/bundle-order', post('/dsh-market/bundle-order', { order: ['beta', 'alpha'] }))
    expect(concurrent.status).toBe(409)
    expect(jsonBody(concurrent)).toEqual({ error: 'another plugin operation is running' })

    // The update route gained the same `writing` guard (issue #98 analysis).
    const upd = await hit(routes, '/dsh-market/update', post('/dsh-market/update', { name: 'alpha' }))
    expect(upd.status).toBe(409)

    // Release the lock → the pending request completes with its '{}' body,
    // which is missing the order → 400.
    pending.finish()
    await pendingRun
    expect(captured.captured().status).toBe(400)

    const after = await hit(routes, '/dsh-market/bundle-order', post('/dsh-market/bundle-order', { order: ['beta', 'alpha'] }))
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

    const order = await hit(routes, '/dsh-market/bundle-order', post('/dsh-market/bundle-order', { order: ['beta', 'alpha'] }))
    expect(order.status).toBe(409)
    expect(jsonBody(order)).toEqual({ error: 'another plugin operation is running' })

    // update distinguishes the two locks in its message.
    const upd = await hit(routes, '/dsh-market/update', post('/dsh-market/update', { name: 'alpha' }))
    expect(upd.status).toBe(409)
    expect(jsonBody(upd)).toEqual({ error: 'another install is already running' })
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
