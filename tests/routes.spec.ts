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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dump } from 'js-yaml'
import { mountMarketRoutes, type MarketHost } from '../src/routes.ts'
import { sameOrigin } from '../src/http.ts'
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

describe('method & Allow contract (6 new routes)', () => {
  it.each([
    ['/dsh-market/check', 'POST', 'GET'],
    ['/dsh-market/bundle-order', 'GET', 'POST'],
    ['/dsh-market/snapshots', 'DELETE', 'GET, POST'],
    ['/dsh-market/restore-snapshot', 'GET', 'POST'],
    ['/dsh-market/delete-snapshot', 'GET', 'POST'],
    ['/dsh-market/presets', 'DELETE', 'GET, POST'],
  ])('answers 405 with an Allow header on %s', async (path, method, allow) => {
    const res = await hit(routes, path as string, { method: method as string, url: path as string })
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe(allow)
  })
})

describe('origin enforcement (mutating routes)', () => {
  const mutating: Array<[string, unknown]> = [
    ['/dsh-market/bundle-order', { order: ['beta', 'alpha'] }],
    ['/dsh-market/snapshots', undefined],
    ['/dsh-market/restore-snapshot', { snapshot: 'snapshot-x' }],
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
})

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
    expect(jsonBody(snap)).toEqual({ error: 'another plugin operation is running' })

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
    expect(jsonBody(snap)).toEqual({ error: 'another plugin operation is running' })

    const order = await hit(routes, '/dsh-market/bundle-order', post('/dsh-market/bundle-order', { order: ['beta', 'alpha'] }))
    expect(order.status).toBe(409)

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

  it('refuses a request with no Origin or no Host', () => {
    // Unlike the download navigation, a mutating POST must carry Origin.
    expect(sameOrigin(req({ host: '127.0.0.1:3080' }))).toBe(false)
    expect(sameOrigin(req({ origin: 'http://127.0.0.1:3080' }))).toBe(false)
    expect(sameOrigin(req({}))).toBe(false)
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
