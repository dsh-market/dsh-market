/**
 * HTTP route contract tests for the issue #98 diagnostics route — GET
 * /dsh-market/check in src/routes.ts. Each test mounts marketRoutes against a
 * STUB host (capturing webServer.register) plus a temp profile fixture, then
 * drives the captured handler with fake IncomingMessage / ServerResponse
 * objects. No server socket, no pnpm, no network — the same surface the real
 * harness host provides, so the method/Allow, origin, body and report
 * contracts of the diagnostics route are pinned without spawning a process.
 *
 * The ordering / snapshot / preset routes (and their contract tests) live on
 * their own branches — this diagnostics branch keeps only the check route.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dump } from 'js-yaml'
import { mountMarketRoutes, type MarketHost } from '../src/routes.ts'

type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>

// --- harness ---------------------------------------------------------------

/**
 * Mount the market routes against a stub host. The returned `routes` map is
 * keyed by path so tests can invoke each handler directly.
 */
function mount(): { host: MarketHost; routes: Map<string, RouteHandler> } {
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
  mountMarketRoutes(host, { profile: 'web' })
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

describe('method & Allow contract — GET /dsh-market/check', () => {
  it.each([
    ['/dsh-market/check', 'POST', 'GET'],
  ])('answers 405 with an Allow header on %s', async (path, method, allow) => {
    const res = await hit(routes, path as string, { method: method as string, url: path as string })
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe(allow)
  })
})

describe('origin contract — GET /dsh-market/check (read route, not origin-gated)', () => {
  it('serves a GET carrying a foreign Origin header', async () => {
    writeStandardProfile()
    const res = await hit(routes, '/dsh-market/check', { method: 'GET', url: '/dsh-market/check', origin: 'http://evil.example' })
    expect(res.status).toBe(200)
  })

  it('serves a GET with no Origin header at all', async () => {
    writeStandardProfile()
    const res = await hit(routes, '/dsh-market/check', { method: 'GET', url: '/dsh-market/check' })
    expect(res.status).toBe(200)
  })
})

describe('body contract — GET /dsh-market/check (GET-only, body never read)', () => {
  it('answers 405 for a POST carrying a JSON body', async () => {
    const res = await hit(routes, '/dsh-market/check', { method: 'POST', url: '/dsh-market/check', body: { anything: true } })
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe('GET')
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
    expect(report.suggestedOrder).toEqual({ ok: true, order: ['alpha', 'beta'] })
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
