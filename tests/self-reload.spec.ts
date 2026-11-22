/**
 * The market reloads its own server half (src/self-reload.ts, and the
 * `/dsh-market/reload-self` route that drives it).
 *
 * The orchestration is tested here with a fake host; what the real host does
 * with the call — evicting modules, stopping and starting the loader entry —
 * is tests/web/self-reload.e2e.ts, against a real `dsh web`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mountMarketRoutes, marketVersion, type MarketHost } from '../src/routes.ts'
import {
  asHmr,
  claimInstance,
  currentInstance,
  preflightBuild,
  reloadSelf,
  selfReloadReply,
  type HmrLike,
  type InstanceRecord,
  type SelfReloadOutcome,
} from '../src/self-reload.ts'

const fakeReport = { warnings: [] as string[], pending: [] as { url: string; reason: string }[] }

describe('asHmr', () => {
  it('accepts a service that can run exclusively and reconcile', () => {
    const hmr = { runExclusive: vi.fn(), reconcileProfile: vi.fn() }
    expect(asHmr(hmr)).toBe(hmr)
  })

  it('refuses an older host whose hmr service has no reconcileProfile', () => {
    expect(asHmr({ runExclusive: vi.fn() })).toBeUndefined()
    expect(asHmr({ reconcileProfile: vi.fn() })).toBeUndefined()
    expect(asHmr(undefined)).toBeUndefined()
    expect(asHmr(null)).toBeUndefined()
    expect(asHmr('hmr')).toBeUndefined()
  })
})

describe('claimInstance', () => {
  afterEach(() => {
    // Leave no record behind for the next spec.
    claimInstance('cleanup').release()
  })

  it('names the instance that claimed last', () => {
    const first = claimInstance('1.0.0')
    expect(currentInstance()).toEqual({ id: first.id, version: '1.0.0' })
    const second = claimInstance('1.0.1')
    expect(currentInstance()).toEqual({ id: second.id, version: '1.0.1' })
    expect(second.id).not.toBe(first.id)
  })

  it('lets an instance release only its own claim', () => {
    const old = claimInstance('1.0.0')
    const next = claimInstance('1.0.1')
    // The replaced instance finishes disposing after its replacement has
    // announced itself: it must not erase the record that is now true.
    old.release()
    expect(currentInstance()).toEqual({ id: next.id, version: '1.0.1' })
    next.release()
    expect(currentInstance()).toBeUndefined()
  })

  it('is visible through the registered symbol, outside any module', () => {
    const claim = claimInstance('2.0.0')
    const holder = globalThis as unknown as Record<symbol, InstanceRecord | undefined>
    expect(holder[Symbol.for('dsh-market.serving-instance')]).toEqual({ id: claim.id, version: '2.0.0' })
  })
})

describe('reloadSelf', () => {
  /** A serving record the test moves by hand, like the real instances do. */
  let serving: InstanceRecord | undefined

  function deps(overrides: Partial<Parameters<typeof reloadSelf>[0]> & { hmr?: HmrLike | undefined } = {}) {
    const { hmr: hmrOverride, ...rest } = overrides
    const hmr = 'hmr' in overrides
      ? hmrOverride
      : {
          runExclusive: <T>(operation: () => Promise<T>) => operation(),
          reconcileProfile: vi.fn(async () => {
            serving = { id: 'new', version: '2.0.0' }
            return fakeReport
          }),
        } satisfies HmrLike
    return {
      hmr: () => hmr,
      runningVersion: '1.0.0',
      installedVersion: () => '2.0.0',
      packageDir: () => '/profile/node_modules/dshmarket',
      instanceId: 'old',
      serving: () => serving,
      preflight: async () => ({ ok: true as const, checked: true }),
      settleMs: 30,
      queueWaitMs: 40,
      ...rest,
    }
  }

  beforeEach(() => { serving = { id: 'old', version: '1.0.0' } })

  it('reports an unsupported host without touching anything', async () => {
    const preflight = vi.fn()
    const outcome = await reloadSelf(deps({ hmr: undefined, preflight }))
    expect(outcome).toEqual({ state: 'unsupported', reason: 'no-hmr' })
    expect(preflight).not.toHaveBeenCalled()
  })

  it('reports a market that is not an installed package', async () => {
    expect(await reloadSelf(deps({ installedVersion: () => null }))).toEqual({ state: 'unsupported', reason: 'not-installed' })
  })

  it('does nothing when the files on disk are the version already running', async () => {
    const hmr = { runExclusive: vi.fn(), reconcileProfile: vi.fn() }
    const outcome = await reloadSelf(deps({ hmr, installedVersion: () => '1.0.0' }))
    expect(outcome).toEqual({ state: 'current', version: '1.0.0' })
    expect(hmr.runExclusive).not.toHaveBeenCalled()
  })

  it('swaps through the host, inside its exclusive section, and confirms by the instance record', async () => {
    const calls: string[] = []
    const hmr: HmrLike = {
      runExclusive: async operation => { calls.push('enter'); const value = await operation(); calls.push('leave'); return value },
      reconcileProfile: async () => { calls.push('reconcile'); serving = { id: 'new', version: '2.0.0' }; return fakeReport },
    }
    const outcome = await reloadSelf(deps({ hmr }))
    expect(outcome).toEqual({ state: 'reloaded', from: '1.0.0', to: '2.0.0' })
    expect(calls).toEqual(['enter', 'reconcile', 'leave'])
  })

  it('tests the new build BEFORE asking the host to stop the running one', async () => {
    const order: string[] = []
    const hmr: HmrLike = {
      runExclusive: operation => operation(),
      reconcileProfile: async () => { order.push('reconcile'); serving = { id: 'new', version: '2.0.0' }; return fakeReport },
    }
    await reloadSelf(deps({ hmr, preflight: async () => { order.push('preflight'); return { ok: true, checked: true } } }))
    expect(order).toEqual(['preflight', 'reconcile'])
  })

  it('refuses a build that cannot load, and never asks the host to replace anything', async () => {
    const hmr = { runExclusive: vi.fn(), reconcileProfile: vi.fn() }
    const log = vi.fn()
    const outcome = await reloadSelf(deps({
      hmr,
      log,
      preflight: async () => ({ ok: false, detail: 'Cannot find package js-yaml' }),
    }))
    expect(outcome).toEqual({ state: 'refused', detail: 'Cannot find package js-yaml' })
    expect(hmr.runExclusive).not.toHaveBeenCalled()
    expect(serving?.id, 'the running instance must stay the one serving').toBe('old')
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('Cannot find package js-yaml'))
  })

  it('goes ahead, and says so in the log, when the new build could not be test-loaded', async () => {
    const log = vi.fn()
    const outcome = await reloadSelf(deps({ log, preflight: async () => ({ ok: true, checked: false }) }))
    expect(outcome.state).toBe('reloaded')
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('could not be test-loaded'))
  })

  it('says a restart is needed when the host kept the old code, and the old instance still serves', async () => {
    // The host could not compare or evict modules (its loader has no access to
    // Node's module cache): nothing was stopped, nothing is lost.
    const hmr: HmrLike = {
      runExclusive: operation => operation(),
      reconcileProfile: async () => ({ warnings: [], pending: [], restartReason: 'module-comparison' }),
    }
    const outcome = await reloadSelf(deps({ hmr }))
    expect(outcome).toMatchObject({ state: 'restart-needed' })
    expect((outcome as { detail: string }).detail).toContain('module-comparison')
  })

  it('names the module the host is holding when it reports pending changes', async () => {
    const hmr: HmrLike = {
      runExclusive: operation => operation(),
      reconcileProfile: async () => ({ warnings: [], pending: [{ url: 'file:///x/lib/a.js', reason: 'host-module' }] }),
    }
    const outcome = await reloadSelf(deps({ hmr }))
    expect(outcome).toMatchObject({ state: 'restart-needed' })
    expect((outcome as { detail: string }).detail).toContain('host-module')
  })

  it('treats a failure before anything stopped as "restart needed", not as a broken market', async () => {
    const hmr: HmrLike = {
      runExclusive: operation => operation(),
      reconcileProfile: async () => { throw new Error('patch file unreadable') },
    }
    const outcome = await reloadSelf(deps({ hmr }))
    expect(outcome).toEqual({ state: 'restart-needed', detail: 'patch file unreadable' })
  })

  it('reports a failed start honestly: nothing is serving', async () => {
    const hmr: HmrLike = {
      runExclusive: operation => operation(),
      reconcileProfile: async () => {
        serving = undefined // the old instance is gone, the new one never claimed
        throw new Error('e2e: this build cannot start')
      },
    }
    const outcome = await reloadSelf(deps({ hmr }))
    expect(outcome).toEqual({ state: 'failed', detail: 'e2e: this build cannot start', serving: false })
  })

  it('reports a host that said "done" while no instance came up', async () => {
    const hmr: HmrLike = {
      runExclusive: operation => operation(),
      reconcileProfile: async () => { serving = undefined; return fakeReport },
    }
    expect(await reloadSelf(deps({ hmr }))).toEqual({ state: 'failed', detail: 'the new version did not start serving', serving: false })
  })

  it('waits briefly for the new instance to announce itself after the host is done', async () => {
    const hmr: HmrLike = {
      runExclusive: operation => operation(),
      reconcileProfile: async () => {
        serving = undefined
        setTimeout(() => { serving = { id: 'new', version: '2.0.0' } }, 10)
        return fakeReport
      },
    }
    expect(await reloadSelf(deps({ hmr, settleMs: 500 }))).toEqual({ state: 'reloaded', from: '1.0.0', to: '2.0.0' })
  })

  it('reports "queued" when another host operation holds the queue, and still lets the swap run', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const reconcile = vi.fn(async () => { serving = { id: 'new', version: '2.0.0' }; return fakeReport })
    const hmr: HmrLike = {
      runExclusive: async operation => { await held; return operation() },
      reconcileProfile: reconcile,
    }
    const outcome = await reloadSelf(deps({ hmr, queueWaitMs: 20 }))
    expect(outcome).toEqual({ state: 'queued' })
    expect(reconcile).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => { expect(reconcile).toHaveBeenCalledOnce() })
  })
})

describe('selfReloadReply', () => {
  const every: SelfReloadOutcome[] = [
    { state: 'unsupported', reason: 'no-hmr' },
    { state: 'unsupported', reason: 'not-installed' },
    { state: 'current', version: '1.0.0' },
    { state: 'refused', detail: 'boom' },
    { state: 'reloaded', from: '1.0.0', to: '1.0.1' },
    { state: 'restart-needed', detail: 'host-module' },
    { state: 'queued' },
    { state: 'failed', detail: 'boom', serving: false },
  ]

  it('maps every outcome to a status that matches its ok flag', () => {
    for (const outcome of every) {
      const { status, body } = selfReloadReply(outcome)
      expect(body.state, JSON.stringify(outcome)).toBe(outcome.state)
      expect(status >= 200 && status < 300, JSON.stringify(outcome)).toBe(body.ok === true)
    }
  })

  it('gives every failure the three things: what happened, why, what now', () => {
    for (const outcome of every.filter(item => selfReloadReply(item).body.ok === false)) {
      const { body } = selfReloadReply(outcome)
      const text = String(body.error)
      expect(text, JSON.stringify(outcome)).toContain(' / ')
      // The next step is always named: restart, or update again.
      expect(text, JSON.stringify(outcome)).toMatch(/重启|再更新|restart|Update again/)
    }
  })

  it('does not tell the reader a failed swap lost data, or that the market works when it does not', () => {
    expect(String(selfReloadReply({ state: 'failed', detail: 'x', serving: false }).body.error)).toMatch(/不可用|unavailable/)
    expect(String(selfReloadReply({ state: 'restart-needed', detail: 'x' }).body.error)).toMatch(/旧版|old one keeps working/)
  })
})

describe('preflightBuild', () => {
  let work: string
  let packageDir: string

  function writePackage(files: Record<string, string>, manifest: Record<string, unknown> = {}): void {
    mkdirSync(join(packageDir, 'lib'), { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'dshmarket', version: '2.0.0', type: 'module', main: 'lib/index.js', ...manifest }))
    for (const [name, text] of Object.entries(files)) writeFileSync(join(packageDir, 'lib', name), text)
  }

  const leftovers = (): string[] => readdirSync(join(work, 'node_modules')).filter(name => name.startsWith('.dsh-market-reload'))

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'dshm-preflight-'))
    packageDir = join(work, 'node_modules', 'dshmarket')
  })
  afterEach(() => {
    try { chmodSync(join(work, 'node_modules'), 0o755) } catch { /* never created */ }
    rmSync(work, { recursive: true, force: true })
  })

  it('accepts a build whose whole module graph loads, and removes its test copy', async () => {
    writePackage({
      'index.js': "import { helper } from './helper.js'\nexport const name = 'x'\nexport function apply() { return helper() }\n",
      'helper.js': 'export const helper = () => 1\n',
    })
    expect(await preflightBuild(packageDir)).toEqual({ ok: true, checked: true })
    expect(leftovers()).toEqual([])
  })

  it('evaluates the files as they are NOW, not a cached earlier copy', async () => {
    // The whole point of loading a private copy: the same path loaded twice
    // would be served from Node's cache and could never notice a changed file.
    writePackage({ 'index.js': 'export function apply() {}\n' })
    expect((await preflightBuild(packageDir)).ok).toBe(true)
    writePackage({ 'index.js': "export function apply() {}\nthrow new Error('now broken')\n" })
    expect(await preflightBuild(packageDir)).toEqual({ ok: false, detail: expect.stringContaining('now broken') })
  })

  it('refuses a build that throws when loaded, naming the reason', async () => {
    writePackage({ 'index.js': "throw new Error('cannot be loaded')\n" })
    expect(await preflightBuild(packageDir)).toEqual({ ok: false, detail: expect.stringContaining('cannot be loaded') })
    expect(leftovers()).toEqual([])
  })

  it('refuses a build with a syntax error in a file it imports', async () => {
    writePackage({ 'index.js': "import './broken.js'\nexport function apply() {}\n", 'broken.js': 'export const = 1\n' })
    const verdict = await preflightBuild(packageDir)
    expect(verdict.ok).toBe(false)
    expect(leftovers()).toEqual([])
  })

  it('refuses a build that imports a package that is not there', async () => {
    writePackage({ 'index.js': "import 'dsh-market-test-package-that-does-not-exist'\nexport function apply() {}\n" })
    const verdict = await preflightBuild(packageDir)
    expect(verdict.ok).toBe(false)
    expect((verdict as { detail: string }).detail).toContain('dsh-market-test-package-that-does-not-exist')
  })

  it('resolves the build\'s own dependencies the way the real package would', async () => {
    const dependency = join(work, 'node_modules', 'preflight-dep')
    mkdirSync(dependency, { recursive: true })
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'preflight-dep', version: '1.0.0', type: 'module', main: 'index.js' }))
    writeFileSync(join(dependency, 'index.js'), 'export const dep = 1\n')
    writePackage({ 'index.js': "import { dep } from 'preflight-dep'\nexport function apply() { return dep }\n" })
    expect(await preflightBuild(packageDir)).toEqual({ ok: true, checked: true })
  })

  it('refuses a build with no plugin entry', async () => {
    writePackage({ 'index.js': 'export const name = "x"\n' })
    expect(await preflightBuild(packageDir)).toEqual({ ok: false, detail: expect.stringContaining('apply') })
  })

  it('refuses a package whose entry file is missing', async () => {
    writePackage({})
    expect(await preflightBuild(packageDir)).toEqual({ ok: false, detail: expect.stringContaining('lib/index.js') })
  })

  it('refuses a package directory that cannot be read', async () => {
    expect((await preflightBuild(join(work, 'nowhere'))).ok).toBe(false)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('goes ahead unchecked when it cannot write a copy beside the package', async () => {
    writePackage({ 'index.js': 'export function apply() {}\n' })
    chmodSync(join(work, 'node_modules'), 0o555)
    expect(await preflightBuild(packageDir)).toEqual({ ok: true, checked: false })
    expect(existsSync(packageDir)).toBe(true)
  })
})

describe('POST /dsh-market/reload-self and selfReload in /status', () => {
  type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  let dir: string
  let handlers: Map<string, Handler>
  let services: Record<string, unknown>
  let disposeRoutes: () => Promise<void>
  let reconcile: ReturnType<typeof vi.fn>

  function installMarket(version: string, entry = 'export function apply() {}\n'): void {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { dshmarket: version }, dsh: { profile: { bundles: ['dshmarket'] } } }))
    mkdirSync(join(dir, 'node_modules', 'dshmarket', 'lib'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'dshmarket', 'package.json'), JSON.stringify({ name: 'dshmarket', version, type: 'module', main: 'lib/index.js' }))
    writeFileSync(join(dir, 'node_modules', 'dshmarket', 'lib', 'index.js'), entry)
  }

  async function hit(method: string, path: string, origin = 'http://localhost:3080') {
    const request = Readable.from([Buffer.from('{}')]) as IncomingMessage
    request.method = method
    request.url = path
    request.headers = { host: 'localhost:3080', origin }
    ;(request as unknown as { socket: unknown }).socket = { remoteAddress: '127.0.0.1' }
    let status = 0
    let data = ''
    const response = {
      writeHead: (code: number) => { status = code },
      setHeader: () => {},
      end: (chunk?: string) => { data = chunk ?? '' },
    } as unknown as ServerResponse
    await handlers.get(path)!(request, response)
    return { status, json: data === '' ? null : JSON.parse(data) as Record<string, unknown> }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dshm-reload-route-'))
    handlers = new Map()
    reconcile = vi.fn(async () => {
      // What the real host does: the old instance goes, the new one announces.
      await disposeRoutes()
      claimInstance('9.9.9')
      return fakeReport
    })
    services = {
      hmr: { runExclusive: <T>(operation: () => Promise<T>) => operation(), reconcileProfile: reconcile },
      profileContext: { name: 'web', dir },
    }
    installMarket('9.9.9')
    const host: MarketHost = {
      webServer: { register: route => { handlers.set(route.path, route.handler); return () => { handlers.delete(route.path) } } },
      loader: { entries: () => [] },
      plugin: () => ({ await: async () => {}, dispose: async () => {} }),
      get: name => services[name],
    }
    disposeRoutes = mountMarketRoutes(host, { profile: 'web', profileDirectory: dir, region: 'global' })
  })

  afterEach(async () => {
    await disposeRoutes()
    claimInstance('cleanup').release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports selfReload true on a host that can replace modules and an installed market', async () => {
    expect((await hit('GET', '/dsh-market/status')).json?.selfReload).toBe(true)
  })

  it('reports selfReload false without the hmr service, or with a configuration-only one', async () => {
    delete services.hmr
    expect((await hit('GET', '/dsh-market/status')).json?.selfReload).toBe(false)
    services.hmr = { runExclusive: vi.fn() }
    expect((await hit('GET', '/dsh-market/status')).json?.selfReload).toBe(false)
  })

  it('reports selfReload false without the launcher profile, which reconcileProfile requires', async () => {
    delete services.profileContext
    expect((await hit('GET', '/dsh-market/status')).json?.selfReload).toBe(false)
  })

  it('reports selfReload false when the market is not an installed package of this profile', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: {} }))
    expect((await hit('GET', '/dsh-market/status')).json?.selfReload).toBe(false)
  })

  it('answers only POST', async () => {
    expect((await hit('GET', '/dsh-market/reload-self')).status).toBe(405)
  })

  it('refuses a cross-origin request before doing anything', async () => {
    expect((await hit('POST', '/dsh-market/reload-self', 'https://evil.example')).status).toBe(403)
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('answers 501 with a way out on a host that cannot replace modules', async () => {
    delete services.hmr
    const reply = await hit('POST', '/dsh-market/reload-self')
    expect(reply.status).toBe(501)
    expect(reply.json).toMatchObject({ ok: false, state: 'unsupported' })
    expect(String(reply.json?.error)).toMatch(/重启 DSH|Restart DSH/)
  })

  it('answers "current" when the files on disk are the version already running', async () => {
    installMarket(marketVersion())
    const reply = await hit('POST', '/dsh-market/reload-self')
    expect(reply.status).toBe(200)
    expect(reply.json).toMatchObject({ ok: true, state: 'current', version: marketVersion() })
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('swaps in the new version and answers from the instance that was replaced', async () => {
    const reply = await hit('POST', '/dsh-market/reload-self')
    expect(reply.status).toBe(200)
    expect(reply.json).toMatchObject({ ok: true, state: 'reloaded', from: marketVersion(), to: '9.9.9' })
    expect(reconcile).toHaveBeenCalledOnce()
    expect(currentInstance()?.version).toBe('9.9.9')
  })

  it('refuses a build that cannot load, with the running market untouched', async () => {
    installMarket('9.9.9', "throw new Error('broken release')\n")
    const reply = await hit('POST', '/dsh-market/reload-self')
    expect(reply.status).toBe(422)
    expect(reply.json).toMatchObject({ ok: false, state: 'refused' })
    expect(String(reply.json?.detail)).toContain('broken release')
    expect(reconcile).not.toHaveBeenCalled()
    expect(handlers.has('/dsh-market/status'), 'the running instance must still be serving').toBe(true)
  })

  it('answers a second request with 409 while a swap is in progress', async () => {
    let finish!: () => void
    const held = new Promise<void>(resolve => { finish = resolve })
    reconcile.mockImplementation(async () => {
      await held
      await disposeRoutes()
      claimInstance('9.9.9')
      return fakeReport
    })
    const first = hit('POST', '/dsh-market/reload-self')
    // Let the first request take the lock and reach the host.
    await vi.waitFor(() => { expect(reconcile).toHaveBeenCalledOnce() })
    const second = await hit('POST', '/dsh-market/reload-self')
    expect(second.status).toBe(409)
    expect(second.json).toMatchObject({ busy: true })
    finish()
    expect((await first).status).toBe(200)
    expect(reconcile).toHaveBeenCalledOnce()
  })

  it('releases its claim on the serving instance when the routes are disposed', async () => {
    expect(currentInstance()).toBeDefined()
    await disposeRoutes()
    expect(currentInstance()).toBeUndefined()
  })
})
