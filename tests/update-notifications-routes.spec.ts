import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mountMarketRoutes, type MarketHost } from '../src/routes.ts'
import { readMarketState, writeMarketState } from '../src/hot.ts'
import { createProfileSnapshot } from '../src/snapshot.ts'
import { setRequestGateSource } from '../src/http.ts'
import * as registry from '../src/registry.ts'
import * as updates from '../src/updates.ts'
import { UPDATE_CHECK_INTERVAL_HOURS } from '../src/update-notification-settings.ts'
import type { UpdateNotificationSnapshot } from '../src/update-notifications.ts'

const PATH = '/dsh-market/update-notifications'
type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
let dir: string
let dispose: () => void
let handlers: Map<string, Handler>
let host: MarketHost

function profile(dependencies: Record<string, string> = { widget: '^1.0.0' }, bundles = Object.keys(dependencies)): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies, dsh: { profile: { bundles } } }))
}

async function hit(method: string, path = PATH, body?: unknown, origin = 'http://localhost:3080') {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as IncomingMessage
  request.method = method
  request.url = path
  request.headers = { host: 'localhost:3080', origin }
  let status = 0
  let data = ''
  const response = {
    writeHead: (code: number) => { status = code },
    end: (chunk?: string) => { data = chunk ?? '' },
  } as unknown as ServerResponse
  await handlers.get(path.split('?')[0]!)!(request, response)
  return { status, json: data === '' ? null : JSON.parse(data) as UpdateNotificationSnapshot & { updates: Record<string, updates.UpdateStatus>; error?: string } }
}

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'dshm-notification-routes-'))
  profile()
  mkdirSync(join(dir, 'node_modules/widget'), { recursive: true })
  writeFileSync(join(dir, 'node_modules/widget/package.json'), JSON.stringify({ name: 'widget', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(dir, 'node_modules/widget/cordis.patch.yml'), '- insert:\n    - id: widget\n      name: widget\n')
  vi.spyOn(registry, 'loadRegistry').mockResolvedValue({ updated: '', count: 0, categories: {}, plugins: [] })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '2.0.0' }))))
  updates.invalidateUpdates()
  handlers = new Map()
  host = {
    webServer: { register: route => { handlers.set(route.path, route.handler); return () => { handlers.delete(route.path) } } },
    loader: { entries: () => [] },
    plugin: () => ({ await: async () => {}, dispose: async () => {} }),
  }
  dispose = mountMarketRoutes(host, { profile: 'web', profileDirectory: dir, region: 'global' })
})

afterEach(() => {
  dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('update notification HTTP routes', () => {
  it('scopes read receipts to a stable opaque profile identity across remounts', async () => {
    const first = (await hit('GET')).json.profileKey
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(first).not.toContain(dir)
    dispose()
    dispose = mountMarketRoutes(host, { profile: 'web', profileDirectory: dir, region: 'global' })
    expect((await hit('GET')).json.profileKey).toBe(first)

    dispose()
    const otherProfile = join(dir, 'other-profile')
    mkdirSync(otherProfile)
    writeFileSync(join(otherProfile, 'package.json'), JSON.stringify({ dependencies: {} }))
    dispose = mountMarketRoutes(host, { profile: 'web', profileDirectory: otherProfile, region: 'global' })
    expect((await hit('GET')).json.profileKey).not.toBe(first)
    expect(registry.loadRegistry).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('defaults to off and starts checking only after explicit opt-in', async () => {
    const first = await hit('GET')
    expect(first.status).toBe(200)
    expect(first.json).toMatchObject({ enabled: false, intervalHours: 6, checking: false, checkedAt: null, nextCheckAt: null, updates: {} })
    expect(registry.loadRegistry).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60_000)
    expect(registry.loadRegistry).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    await hit('POST', PATH, { enabled: true })
    await vi.advanceTimersByTimeAsync(30_000)
    const checked = await hit('GET')
    expect(checked.json).toMatchObject({ stale: false, updates: { widget: { latest: '2.0.0', updateAvailable: true } } })
    const calls = vi.mocked(fetch).mock.calls.length
    await hit('GET')
    await hit('GET')
    expect(fetch).toHaveBeenCalledTimes(calls)
  })

  it('shares a forced check between the legacy page and the global notification request', async () => {
    const realCheck = updates.checkUpdates
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const check = vi.spyOn(updates, 'checkUpdates').mockImplementation(async (...args) => { await gate; return realCheck(...args) })
    const requests = Promise.all([
      hit('GET', '/dsh-market/updates?force=1'), hit('POST', PATH, { check: true }),
    ])
    await vi.advanceTimersByTimeAsync(1)
    release()
    const [page, notification] = await requests
    expect(check).toHaveBeenCalledTimes(1)
    expect(page.status).toBe(200)
    expect(page.json.updates.widget).toMatchObject({ latest: '2.0.0', updateAvailable: true })
    expect(notification.json.updates).toEqual(page.json.updates)
  })

  it('keeps last-good results during source failures and removes externally changed installations', async () => {
    await hit('POST', PATH, { check: true })
    vi.mocked(fetch).mockRejectedValue(new Error('offline'))
    const failed = await hit('POST', PATH, { check: true })
    expect(failed.json).toMatchObject({ stale: true, updates: { widget: { latest: '2.0.0', updateAvailable: true, checkFailed: true, checkError: 'unavailable' } } })
    const legacyFailed = await hit('GET', '/dsh-market/updates')
    expect(legacyFailed.json.updates).toEqual(failed.json.updates)
    vi.mocked(fetch).mockImplementation(async () => Response.json({ version: '3.0.0' }))
    const recovered = await hit('GET', '/dsh-market/updates')
    expect(recovered.json.updates.widget).toMatchObject({ latest: '3.0.0', updateAvailable: true })
    expect(recovered.json.updates.widget?.checkFailed).toBeUndefined()
    expect(recovered.json.updates.widget?.checkError).toBeUndefined()
    expect((await hit('GET')).json).toMatchObject({ stale: false, error: null, updates: recovered.json.updates })
    profile({ widget: 'github:different/source' })
    expect((await hit('GET')).json.updates).toEqual({})
    profile({})
    expect((await hit('GET')).json.updates).toEqual({})
  })

  it('returns current exemptions, hidden rows, and host-disabled bundles without a network check', async () => {
    await hit('POST', PATH, { check: true })
    writeMarketState(dir, { disabled: new Set(), groups: {}, groupOrder: [], updateExempt: ['widget'], blocked: ['hidden'] })
    profile({ widget: '^1.0.0' }, [])
    const result = await hit('GET')
    expect(result.json).toMatchObject({ updateExempt: ['widget'], blocked: ['hidden'], disabled: ['widget'] })
    profile()
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: widget\n  disabled: true\n')
    expect((await hit('GET')).json.disabled).toContain('widget')
  })

  it('resolves blocked catalog aliases from the current installed source without fetching', async () => {
    profile({ widget: 'file:./widget' })
    const installedManifest = join(dir, 'node_modules/widget/package.json')
    const writeManifest = (repo: string) => writeFileSync(installedManifest, JSON.stringify({
      name: 'widget', version: '1.0.0', repository: `https://github.com/${repo}`,
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeManifest('owner/widget')
    vi.mocked(registry.loadRegistry).mockResolvedValue({ updated: '', count: 1, categories: {}, plugins: [{
      name: 'catalog-widget', npm: 'published-widget', owner: 'owner', url: 'https://github.com/owner/widget',
      category: 'other', description: { en: 'widget' }, install: '', added: '',
    }] })
    const checked = await hit('POST', PATH, { check: true })
    expect(checked.json.updates.widget).toMatchObject({ latest: '2.0.0', updateAvailable: true, restoreRequired: true })
    writeMarketState(dir, { disabled: new Set(), groups: {}, groupOrder: [], blocked: ['published-widget', 'absent'] })
    const catalogCalls = vi.mocked(registry.loadRegistry).mock.calls.length
    const fetchCalls = vi.mocked(fetch).mock.calls.length
    expect((await hit('GET')).json.blocked).toEqual(['published-widget', 'absent', 'widget'])
    // The spec and directory are unchanged, but this is now another fork.
    writeManifest('different/widget')
    const replaced = await hit('GET')
    expect(replaced.json.blocked).toEqual(['published-widget', 'absent'])
    expect(replaced.json.updates).toEqual({})
    expect(replaced.json.stale).toBe(true)
    profile({ widget: 'github:owner/widget' })
    expect((await hit('GET')).json.blocked).toContain('widget')
    profile({ widget: 'github:different/widget' })
    expect((await hit('GET')).json.blocked).not.toContain('widget')
    profile({})
    expect((await hit('GET')).json.blocked).toEqual(['published-widget', 'absent'])
    expect(registry.loadRegistry).toHaveBeenCalledTimes(catalogCalls)
    expect(fetch).toHaveBeenCalledTimes(fetchCalls)
  })

  it.each([
    { enabled: false, intervalHours: 72 as const },
    { enabled: true, intervalHours: 12 as const },
    { enabled: undefined, intervalHours: undefined },
  ])('applies restored notification settings to the live monitor: %j', async saved => {
    writeMarketState(dir, { disabled: new Set(), groups: {}, groupOrder: [],
      backgroundUpdateChecks: saved.enabled, backgroundUpdateIntervalHours: saved.intervalHours })
    const captured = createProfileSnapshot(dir)
    expect(captured.ok).toBe(true)
    if (!captured.ok) throw new Error(captured.error)
    // Change both choices after capture, then restore through the real route.
    await hit('POST', PATH, { enabled: saved.enabled !== true, intervalHours: 168 })
    const restored = await hit('POST', '/dsh-market/restore-snapshot', { snapshot: captured.snapshot.id })
    expect(restored.status).toBe(200)
    expect(readMarketState(dir).backgroundUpdateChecks).toBe(saved.enabled)
    expect(readMarketState(dir).backgroundUpdateIntervalHours).toBe(saved.intervalHours)
    expect((await hit('GET')).json).toMatchObject({ enabled: saved.enabled === true,
      intervalHours: saved.intervalHours ?? 6, nextCheckAt: saved.enabled === true ? Date.now() + 30_000 : null })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(registry.loadRegistry).toHaveBeenCalledTimes(saved.enabled === true ? 1 : 0)
    if (saved.enabled === true) {
      expect((await hit('GET')).json.nextCheckAt).toBe(Date.now() + saved.intervalHours! * 60 * 60_000)
    }
  })

  it('persists the switch and validates requests before changing it', async () => {
    expect((await hit('POST', PATH, { enabled: false })).json).toMatchObject({ enabled: false, nextCheckAt: null })
    expect(readMarketState(dir).backgroundUpdateChecks).toBe(false)
    expect((await hit('POST', PATH, { enabled: 'true' })).status).toBe(400)
    expect((await hit('POST', PATH, {})).status).toBe(400)
    expect((await hit('DELETE')).status).toBe(405)
    expect((await hit('POST', PATH, { enabled: true }, 'https://foreign.example')).status).toBe(403)
    expect(readMarketState(dir).backgroundUpdateChecks).toBe(false)
    expect((await hit('POST', PATH, { check: true })).json).toMatchObject({ enabled: false, nextCheckAt: null, updates: { widget: { updateAvailable: true } } })
  })

  it.each(UPDATE_CHECK_INTERVAL_HOURS)('persists a %s-hour interval independently of the switch and across restart', async intervalHours => {
    const changed = await hit('POST', PATH, { intervalHours })
    expect(changed.status).toBe(200)
    expect(changed.json).toMatchObject({ enabled: false, intervalHours, nextCheckAt: null, checkedAt: null })
    expect(readMarketState(dir).backgroundUpdateIntervalHours).toBe(intervalHours)
    expect(fetch).not.toHaveBeenCalled()
    dispose()
    dispose = mountMarketRoutes(host, { profile: 'web', profileDirectory: dir, region: 'global' })
    expect((await hit('GET')).json).toMatchObject({ enabled: false, intervalHours, nextCheckAt: null })
    await hit('POST', PATH, { enabled: true })
    await vi.advanceTimersByTimeAsync(30_000)
    expect((await hit('GET')).json.nextCheckAt).toBe(Date.now() + intervalHours * 60 * 60_000)
  })

  it.each([null, 0, -1, 1, 6.5, 24, 169, '6', [], {}, true])('rejects invalid intervals atomically: %j', async intervalHours => {
    expect((await hit('POST', PATH, { enabled: true, intervalHours, check: true })).status).toBe(400)
    expect((await hit('GET')).json).toMatchObject({ enabled: false, intervalHours: 6, checkedAt: null, nextCheckAt: null })
    expect(readMarketState(dir).backgroundUpdateChecks).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([true, false])('retains an explicit legacy switch (%s) and uses 6 hours when the interval is missing', async enabled => {
    dispose()
    writeMarketState(dir, { disabled: new Set(), groups: {}, groupOrder: [], backgroundUpdateChecks: enabled })
    dispose = mountMarketRoutes(host, { profile: 'web', profileDirectory: dir, region: 'global' })
    expect((await hit('GET')).json).toMatchObject({ enabled, intervalHours: 6, checkedAt: null })
    expect((await hit('GET')).json.nextCheckAt).toBe(enabled ? Date.now() + 30_000 : null)
  })

  it('uses the host authentication gate for both snapshot reads and check requests', async () => {
    const previous = setRequestGateSource(() => () => 401)
    try {
      expect((await hit('GET')).status).toBe(401)
      expect((await hit('POST', PATH, { check: true })).status).toBe(401)
      expect(registry.loadRegistry).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    } finally { setRequestGateSource(previous) }
  })

  it('marks unavailable catalog inputs stale instead of claiming every source was checked', async () => {
    vi.mocked(registry.loadRegistry).mockRejectedValue(new Error('catalog offline'))
    const result = await hit('POST', PATH, { check: true })
    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({ stale: true, lastSuccessAt: null, updates: { widget: { updateAvailable: true, checkFailed: true, checkError: 'unavailable' } } })
    expect(result.json.error).not.toBeNull()
  })

  it.each([
    { spec: '^1.0.0', migration: { kind: 'npm-rename', from: 'widget', target: 'new-widget' } },
    { spec: 'github:owner/widget', migration: { kind: 'git-to-npm', repo: 'owner/widget', target: 'new-widget' } },
  ])('keeps $migration.kind hints in the shared snapshot after a background refresh', async ({ spec, migration }) => {
    profile({ widget: spec })
    vi.mocked(registry.loadRegistry).mockResolvedValue({ updated: '', count: 1, categories: {}, plugins: [{
      name: 'new-widget', npm: 'new-widget', owner: 'owner', url: 'https://github.com/owner/widget',
      category: 'other', description: { en: 'widget' }, install: '', added: '', previousNpm: ['widget'],
    }] })
    await hit('POST', PATH, { enabled: true })
    const page = await hit('GET', '/dsh-market/updates?force=1')
    expect(page.json.updates.widget?.sourceMigration).toEqual(migration)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000)
    expect((await hit('GET')).json.updates.widget?.sourceMigration).toEqual(migration)
    vi.mocked(registry.loadRegistry).mockRejectedValue(new Error('offline'))
    const stale = await hit('POST', PATH, { check: true })
    expect(stale.json.stale).toBe(true)
    expect(stale.json.updates.widget?.sourceMigration).toEqual(migration)
  })
})
