/** Real routes, hotMount and profile files; only the registry and loader boundary are controlled. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountMarketRoutes, type MarketHost } from '../src/routes.ts'
import { hotUnmount, listHotMounts, readMarketState, writeMarketState } from '../src/hot.ts'
import type { LoaderEntry } from '../src/themes.ts'

const ioFault = vi.hoisted(() => ({ suffix: '', remaining: 0, onFailure: undefined as (() => void) | undefined }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: (from: string, to: string) => {
    if (ioFault.remaining > 0 && String(to).endsWith(ioFault.suffix)) {
      ioFault.remaining--
      ioFault.onFailure?.()
      throw Object.assign(new Error('injected publication failure'), { code: 'EACCES' })
    }
    return actual.renameSync(from, to)
  } }
})
const catalog = vi.hoisted(() => ({ themes: [] as string[] }))
vi.mock('../src/registry.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/registry.ts')>(),
  loadRegistry: async () => ({ plugins: catalog.themes.map(name => ({ name, url: `https://github.com/o/${name}`, category: 'theme' })), categories: {}, count: 0, updated: '' }),
}))
vi.mock('@deepseek-ai/cordis-plugin-include', () => ({ Include: class { write() {} } }))

let dir: string
let dispose: () => void
let dispatch: (path: string, body?: unknown) => Promise<{ status: number; json: any }>
let stop: (() => Promise<void>) | undefined
let rejectDispose: boolean
let reject: boolean
let activate: (() => Promise<void>) | undefined
let pluginEvent: Parameters<NonNullable<MarketHost['on']>>[1]
let entries: LoaderEntry[]
const patch = '- id: bad\n  disabled: true\n- id: child\n  disabled: true\n# keep this setting\n- id: neighbour\n  config:\n    limit: 7\n'
function boot() {
  const routes = new Map<string, Parameters<MarketHost['webServer']['register']>[0]['handler']>()
  const host: MarketHost = {
    webServer: { register: route => { routes.set(route.path, route.handler); return () => {} } },
    loader: { entries: () => entries },
    plugin: () => ({ await: async () => { await activate?.(); if (reject) throw new Error('loader entries failed to apply') }, dispose: () => { if (rejectDispose) throw new Error('dispose rejected'); return stop?.() } }),
    on: (_event, callback) => { pluginEvent = callback; return () => {} },
  }
  dispose = mountMarketRoutes(host, { profile: 'web', profileDirectory: dir, region: 'global' })
  dispatch = async (path, body) => {
    let status = 0
    let json: any
    await routes.get(`/dsh-market/${path}`)!({
      method: body === undefined ? 'GET' : 'POST', url: `/dsh-market/${path}`,
      headers: { host: 'localhost:3080', origin: 'http://localhost:3080' },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
    } as never, {
      writeHead(code: number) { status = code }, end(text: string) { json = JSON.parse(text) },
    } as never)
    return { status, json }
  }
}
function seed(off = ['bad']) {
  writeMarketState(dir, { disabled: new Set(off), groups: { work: ['bad', 'good'] }, groupOrder: ['work'], notes: { bad: 'retain' }, favorites: ['https://github.com/o/good'], channel: 'beta' })
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dshm-575-'))
  stop = undefined
  rejectDispose = false
  reject = true
  activate = undefined
  ioFault.remaining = 0
  ioFault.suffix = ''
  ioFault.onFailure = undefined
  catalog.themes = []
  entries = []
  for (const name of ['bad', 'good']) {
    mkdirSync(join(dir, 'node_modules', name), { recursive: true })
    writeFileSync(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(dir, 'node_modules', name, 'cordis.patch.yml'), `- insert:\n    - id: ${name}\n      name: ${name}\n${name === 'bad' ? '    - id: child\n      name: child\n' : ''}`)
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { bad: '1.0.0', good: '1.0.0' }, dsh: { profile: { bundles: ['bad', 'good'] } } }))
  writeFileSync(join(dir, 'cordis.patch.yml'), patch)
  seed()
  boot()
  // Let the boot disable replay settle before injecting entries.
  await new Promise(resolve => setTimeout(resolve, 0))
})
afterEach(async () => {
  vi.useRealTimers()
  dispose()
  stop = undefined
  rejectDispose = false
  for (const name of listHotMounts()) await hotUnmount(name)
  rmSync(dir, { recursive: true, force: true })
})
const toggle = (enabled = true) => dispatch('toggle', { name: 'bad', enabled })
const stateText = () => readFileSync(join(dir, '.dsh-market', 'state.json'), 'utf8')

describe('failed enable preserves the requested profile (#575)', () => {
  it('keeps the multi-row patch and market state unchanged after loader rejection, including a fresh service', async () => {
    const before = stateText()
    const result = await toggle()
    expect(result.status).toBe(502)
    expect(result.json.disabled).toContain('bad')
    expect(stateText()).toBe(before)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    expect(result.json.restart).toBe(false)
    expect(result.json.refresh).toBe(false)
    dispose(); boot()
    const listed = await dispatch('installed')
    expect(listed.json.disabled).toContain('bad')
    expect(listed.json.activation.bad.state).toBe('disabled')
    reject = false
    expect((await toggle()).status).toBe(200) // failed request released the lock
  })

  it('preserves absence from the market set when only the patch disabled the plugin', async () => {
    dispose(); seed([]); boot()
    const before = stateText()
    expect((await toggle()).status).toBe(502)
    expect(stateText()).toBe(before)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    expect((await dispatch('installed')).json.activation.bad.state).toBe('disabled')
  })

  it('commits a successful live enable, preserves unrelated fields, and makes repeat requests idempotent', async () => {
    reject = false
    expect((await toggle()).status).toBe(200)
    expect(readMarketState(dir).disabled.has('bad')).toBe(false)
    expect(readMarketState(dir).notes).toEqual({ bad: 'retain' })
    expect(readMarketState(dir).channel).toBe('beta')
    const after = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    expect(after).not.toContain('disabled: true')
    expect(after).toContain('limit: 7')
    expect((await toggle()).status).toBe(200)
    // enableRow may add an explicit override after removing a disable block;
    // subsequent requests must not append duplicate overrides.
    const forced = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    expect(forced.match(/- id: bad\n/g)).toHaveLength(1)
    expect((await toggle()).status).toBe(200)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(forced)
    expect((await toggle(false)).status).toBe(200)
    expect(readMarketState(dir).disabled.has('bad')).toBe(true)
  })

  it('retains deferred activation for complex carrier patches', async () => {
    writeFileSync(join(dir, 'node_modules/bad/cordis.patch.yml'), '- insert:\n    - id: bad\n      name: bad\n- id: neighbour\n  disabled: true\n')
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    manifest.dsh.profile.bundles = ['good']
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    const result = await toggle()
    expect(result.status).toBe(502) // existing public ok=false means not live
    expect(result.json.restart).toBe(true)
    expect(readMarketState(dir).disabled.has('bad')).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dsh.profile.bundles).toContain('bad')
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).not.toContain('- id: bad\n  disabled: true')
  })

  it('rolls back entry options and a partially created fiber after entry.update rejects', async () => {
    const entry: LoaderEntry = {
      options: { name: 'bad', disabled: true },
      update: async options => {
        entry.options.disabled = options.disabled
        entry.fiber = options.disabled ? undefined : {}
        if (!options.disabled) throw new Error('entry apply rejected')
      },
    }
    entries.push(entry)
    const before = stateText()
    const result = await toggle()
    expect(result.status).toBe(502)
    expect(entry.options.disabled).toBe(true)
    expect(entry.fiber).toBeUndefined()
    expect(stateText()).toBe(before)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
  })

  it('keeps failed group members disabled while committing successful members', async () => {
    dispose(); seed(['bad', 'good']); boot()
    await new Promise(resolve => setTimeout(resolve, 0))
    const good: LoaderEntry = { options: { name: 'good', disabled: true }, update: async options => { good.options.disabled = options.disabled; good.fiber = options.disabled ? undefined : {} } }
    entries.push(good)
    const result = await dispatch('groups', { action: 'toggle', name: 'work', enabled: true })
    expect(result.status).toBe(400)
    expect(readMarketState(dir).disabled).toEqual(new Set(['bad']))
    expect(result.json.restartMembers).not.toContain('bad')
    const after = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    expect(after).toContain(patch.trim())
    expect(after).toContain('- id: good\n  disabled: false')
  })
  it('does not re-add a carrier whose existing entry fails activation', async () => {
    writeFileSync(join(dir, 'node_modules/bad/cordis.patch.yml'), '- insert:\n    - id: bad\n      name: bad\n- id: neighbour\n  disabled: true\n')
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    manifest.dsh.profile.bundles = ['good']
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    entries.push({ options: { name: 'bad', disabled: true }, update: async options => { if (!options.disabled) throw new Error('cannot apply carrier') } })
    const before = readFileSync(join(dir, 'package.json'), 'utf8')
    expect((await toggle()).status).toBe(502)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
  })

  it('reports invalid patch input without claiming complete success', async () => {
    reject = false
    const invalid = '- insert: [unterminated\n'
    writeFileSync(join(dir, 'cordis.patch.yml'), invalid)
    const result = await toggle()
    expect(result.status).toBe(502)
    expect(result.json.ok).toBe(false)
    expect(result.json.patchWrite.ok).toBe(false)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(invalid)
  })

  it('reports state write errors and keeps the shared disable set unchanged', async () => {
    reject = false
    const statePath = join(dir, '.dsh-market/state.json')
    rmSync(statePath)
    mkdirSync(statePath) // deterministic write rejection, including when tests run as root
    const result = await toggle()
    expect(result.status).toBe(502)
    expect(result.json.reason).toBeTruthy()
    expect(listHotMounts()).not.toContain('bad')
    expect((await dispatch('installed')).json.disabled).toContain('bad')
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    rmSync(statePath, { recursive: true })
    expect((await toggle(false)).status).toBe(200)
  })

  it('allows the requested activation past the self-healing disable guard, then restores the guard after failure', async () => {
    const updates: (boolean | null)[] = []
    const entry: LoaderEntry = {
      options: { name: 'bad', disabled: true },
      update: async options => {
        updates.push(options.disabled)
        entry.options.disabled = options.disabled
        entry.fiber = options.disabled ? undefined : {}
        if (!options.disabled) pluginEvent({ entry })
      },
    }
    entries.push(entry)
    expect((await toggle()).status).toBe(200)
    expect(updates).toEqual([null])
    expect(entry.fiber).toBeDefined()
    expect((await toggle(false)).status).toBe(200)
    entry.update = async options => {
      entry.options.disabled = options.disabled
      entry.fiber = options.disabled ? undefined : {}
      if (!options.disabled) throw new Error('apply rejected')
    }
    expect((await toggle()).status).toBe(502)
    entry.fiber = {}
    pluginEvent({ entry })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(entry.options.disabled).toBe(true)
    expect(entry.fiber).toBeUndefined()
  })

  it('preflights invalid patch data before activating or persisting anything', async () => {
    reject = false
    writeFileSync(join(dir, 'cordis.patch.yml'), '- insert: [unterminated\n')
    const before = stateText()
    expect((await toggle()).json.ok).toBe(false)
    expect(listHotMounts()).not.toContain('bad')
    expect(stateText()).toBe(before)
  })

  it('persists group disables to the same patch layer as individual toggles', async () => {
    const result = await dispatch('groups', { action: 'toggle', name: 'work', enabled: false })
    expect(result.status).toBe(200)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toContain('- id: good\n  disabled: true')
    reject = false
    expect((await dispatch('groups', { action: 'toggle', name: 'work', enabled: true })).status).toBe(200)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).not.toContain('disabled: true')
  })

  it.each(['toggle', 'use-skin', 'groups'])('restores the old theme when activation fails through %s', async path => {
    catalog.themes = ['bad', 'good']
    const good: LoaderEntry = { options: { name: 'good', disabled: null }, fiber: {}, update: async options => { good.options.disabled = options.disabled; good.fiber = options.disabled ? undefined : {} } }
    entries.push(good)
    const before = stateText()
    const body = path === 'groups' ? { action: 'toggle', name: 'work', enabled: true } : { name: 'bad', enabled: true }
    // The group only targets the failing theme; the other is globally active.
    if (path === 'groups') {
      await dispatch('groups', { action: 'set-members', name: 'work', members: ['bad'] })
    }
    const snapshot = stateText()
    const result = await dispatch(path, body)
    expect(result.json.ok).toBe(false)
    expect(good.fiber).toBeDefined()
    expect(good.options.disabled).toBeNull()
    expect(stateText()).toBe(path === 'groups' ? snapshot : before)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
  })

  it('writes old/new theme patch choices together on a successful switch', async () => {
    catalog.themes = ['bad', 'good']
    reject = false
    const good: LoaderEntry = { options: { name: 'good', disabled: null }, fiber: {}, update: async options => { good.options.disabled = options.disabled; good.fiber = options.disabled ? undefined : {} } }
    entries.push(good)
    expect((await dispatch('use-skin', { name: 'bad' })).status).toBe(200)
    expect(good.fiber).toBeUndefined()
    expect(readMarketState(dir).disabled).toEqual(new Set(['good']))
    const text = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    expect(text).toContain('- id: good\n  disabled: true')
    expect(text).not.toContain('- id: bad\n  disabled: true')
  })

  it('restores patch and runtime when state publication fails after live activation', async () => {
    reject = false
    const before = stateText()
    ioFault.suffix = 'state.json'; ioFault.remaining = 1
    const result = await toggle()
    expect(result.status).toBe(502)
    expect(result.json.reason).toContain('publication failure')
    expect(stateText()).toBe(before)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    expect(listHotMounts()).not.toContain('bad')
    expect(readdirSync(join(dir, '.dsh-market')).filter(name => name.startsWith('toggle-') || name.endsWith('.tmp'))).toEqual([])
    expect(readdirSync(dir).filter(name => name.startsWith('.dshm-toggle-'))).toEqual([])
  })

  it('restores carrier membership and every patch row after a late state failure', async () => {
    writeFileSync(join(dir, 'node_modules/bad/cordis.patch.yml'), '- insert:\n    - id: bad\n      name: bad\n- id: neighbour\n  disabled: true\n')
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    manifest.dsh.profile.bundles = ['good']
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    const before = readFileSync(join(dir, 'package.json'), 'utf8')
    ioFault.suffix = 'state.json'; ioFault.remaining = 1
    expect((await toggle()).status).toBe(502)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    expect(readMarketState(dir).disabled.has('bad')).toBe(true)
  })

  it('preserves an external edit made while activation is pending and unwinds the new mount', async () => {
    reject = false
    const edited = patch + '# edited externally while loading\n'
    activate = async () => { writeFileSync(join(dir, 'cordis.patch.yml'), edited) }
    const result = await toggle()
    expect(result.status).toBe(502)
    expect(result.json.reason).toContain('profile changed during activation')
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(edited)
    expect(readMarketState(dir).disabled.has('bad')).toBe(true)
    expect(listHotMounts()).not.toContain('bad')
  })

  it('restores the old theme when committing its replacement fails', async () => {
    catalog.themes = ['bad', 'good']
    reject = false
    const good: LoaderEntry = { options: { name: 'good', disabled: null }, fiber: {}, update: async options => { good.options.disabled = options.disabled; good.fiber = options.disabled ? undefined : {} } }
    entries.push(good)
    const before = stateText()
    ioFault.suffix = 'state.json'; ioFault.remaining = 1
    const result = await dispatch('use-skin', { name: 'bad' })
    expect(result.status).toBe(502)
    expect(good.fiber).toBeDefined()
    expect(good.options.disabled).toBeNull()
    expect(listHotMounts()).not.toContain('bad')
    expect(stateText()).toBe(before)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
  })

  it.each(['groups', 'use-skin'])('serializes %s with ordinary toggles', async path => {
    reject = false
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    activate = async () => { entered(); await gate }
    const pending = toggle()
    await waiting
    try {
      expect((await dispatch(path, path === 'groups' ? { action: 'toggle', name: 'work', enabled: false } : { name: 'good' })).status).toBe(409)
    } finally { release() }
    expect((await pending).status).toBe(200)
  })

  it('preserves unrelated choices saved externally before the next request', async () => {
    reject = false
    writeMarketState(dir, { ...readMarketState(dir), disabled: new Set(['bad', 'unrelated']), groups: { external: ['good'] }, groupOrder: ['external'] })
    expect((await toggle()).status).toBe(200)
    const saved = readMarketState(dir)
    expect(saved.disabled).toEqual(new Set(['unrelated']))
    expect(saved.groups).toEqual({ external: ['good'] })
    expect(saved.groupOrder).toEqual(['external'])
  })

  it('validates and restores owned bundle children whose loader names differ from the package', async () => {
    reject = false
    const first: LoaderEntry = { options: { id: 'bundle:bad', name: 'file:///first.js', disabled: true }, update: async options => { first.options.disabled = options.disabled; first.fiber = options.disabled ? undefined : {} } }
    const child: LoaderEntry = { options: { id: 'bundle:child', name: 'child-package', disabled: true }, update: async options => { child.options.disabled = options.disabled; child.fiber = options.disabled ? undefined : {}; if (!options.disabled) throw new Error('child apply rejected') } }
    entries.push(first, child)
    const before = stateText()
    const result = await toggle()
    expect(result.status).toBe(502)
    expect(result.json.reason).toContain('child apply rejected')
    for (const entry of entries) {
      expect(entry.fiber).toBeUndefined()
      expect(entry.options.disabled).toBe(true)
    }
    expect(stateText()).toBe(before)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0).each(['cordis.patch.yml', '.dsh-market/state.json', 'package.json'])('rejects a read-only %s before activation', async file => {
    reject = false
    if (file === 'package.json') {
      writeFileSync(join(dir, 'node_modules/bad/cordis.patch.yml'), '- insert:\n    - id: bad\n      name: bad\n- id: neighbour\n  disabled: true\n')
      const manifest = JSON.parse(readFileSync(join(dir, file), 'utf8'))
      manifest.dsh.profile.bundles = ['good']
      writeFileSync(join(dir, file), JSON.stringify(manifest))
    }
    const before = stateText()
    const original = readFileSync(join(dir, file), 'utf8')
    activate = vi.fn(async () => {})
    chmodSync(join(dir, file), 0o400)
    try {
      const result = await toggle()
      expect(result.status).toBe(502)
      expect(result.json.reason).toContain('EACCES')
      expect(activate).not.toHaveBeenCalled()
      expect(stateText()).toBe(before)
      expect(readFileSync(join(dir, file), 'utf8')).toBe(original)
      expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
      expect(listHotMounts()).not.toContain('bad')
    } finally { chmodSync(join(dir, file), 0o600) }
  })

  it('rejects a disable whose hot handle cannot stop and permits a later retry', async () => {
    reject = false
    expect((await toggle()).status).toBe(200)
    const before = stateText()
    const patchBefore = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    rejectDispose = true
    const result = await toggle(false)
    expect(result.status).toBe(502)
    expect(result.json.reason).toContain('dispose rejected')
    expect(listHotMounts()).toContain('bad')
    expect(stateText()).toBe(before)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patchBefore)
    expect((await toggle()).json.reason).toContain('runtime state is uncertain')
    rejectDispose = false
    expect((await toggle(false)).status).toBe(200)
    expect(listHotMounts()).not.toContain('bad')
  })

  it('does not start a replacement theme when the old hot theme cannot stop', async () => {
    reject = false
    expect((await dispatch('toggle', { name: 'good', enabled: true })).status).toBe(200)
    catalog.themes = ['good', 'bad']
    const before = stateText()
    rejectDispose = true
    activate = vi.fn(async () => {})
    const result = await dispatch('use-skin', { name: 'bad' })
    expect(result.status).toBe(502)
    expect(result.json.reason).toContain('dispose rejected')
    expect(activate).not.toHaveBeenCalled()
    expect(listHotMounts()).toContain('good')
    expect(listHotMounts()).not.toContain('bad')
    expect(stateText()).toBe(before)
  })

  it('reports a failed hot-handle cleanup during persistence recovery', async () => {
    reject = false
    rejectDispose = true
    const before = stateText()
    ioFault.suffix = 'state.json'; ioFault.remaining = 1
    const result = await toggle()
    expect(result.status).toBe(502)
    expect(result.json.reason).toContain('runtime restoration failed')
    expect(result.json.reason).toContain('dispose rejected')
    expect(listHotMounts()).toContain('bad')
    expect(stateText()).toBe(before)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    expect((await toggle()).json.reason).toContain('runtime state is uncertain')
    rejectDispose = false
    expect((await toggle(false)).status).toBe(200)
    expect(listHotMounts()).not.toContain('bad')
  })

  it.each(['fulfill', 'reject'])('bounds a hung hot disposal, releases the lock, and handles late %s', async outcome => {
    reject = false
    expect((await toggle()).status).toBe(200)
    let finish!: () => void
    stop = vi.fn(() => new Promise<void>((resolve, reject) => { finish = () => outcome === 'fulfill' ? resolve() : reject(new Error('late disposal rejection')) }))
    const before = stateText()
    vi.useFakeTimers()
    let result: Awaited<ReturnType<typeof toggle>> | undefined
    const pending = toggle(false).then(value => { result = value })
    await vi.advanceTimersByTimeAsync(10_001)
    expect(result?.status).toBe(502)
    expect(result?.json.reason).toContain('did not settle')
    expect(stateText()).toBe(before)
    expect((await toggle(false)).json.reason).toContain('still pending')
    expect(stop).toHaveBeenCalledTimes(1)
    finish()
    await pending
    await vi.advanceTimersByTimeAsync(0)
    stop = undefined
    expect((await toggle(false)).status).toBe(200)
  })

  it('bounds a hung entry enable and rejects overlapping updates until it settles', async () => {
    let finish!: () => void
    const entry: LoaderEntry = { options: { name: 'bad', disabled: true }, update: vi.fn(() => new Promise<void>(resolve => { finish = resolve })) }
    entries.push(entry)
    const before = stateText()
    vi.useFakeTimers()
    let result: Awaited<ReturnType<typeof toggle>> | undefined
    const pending = toggle().then(value => { result = value })
    await vi.advanceTimersByTimeAsync(10_001)
    expect(result?.status).toBe(502)
    expect(result?.json.reason).toContain('did not settle')
    expect(stateText()).toBe(before)
    expect((await toggle()).status).toBe(502)
    expect(entry.update).toHaveBeenCalledTimes(1)
    finish()
    await pending
    await vi.advanceTimersByTimeAsync(0)
    expect((await toggle()).json.reason).toContain('runtime state is uncertain')
    entry.update = async options => { entry.options.disabled = options.disabled; entry.fiber = options.disabled ? undefined : {} }
    expect((await toggle(false)).status).toBe(200)
    expect((await toggle()).status).toBe(200)
  })

  it('bounds hung entry restoration and leaves the next route usable', async () => {
    const entry: LoaderEntry = { options: { name: 'bad', disabled: true }, update: async options => {
      entry.options.disabled = options.disabled
      entry.fiber = {}
      if (!options.disabled) throw new Error('apply failed')
      return new Promise<void>(() => {})
    } }
    entries.push(entry)
    const before = stateText()
    vi.useFakeTimers()
    let result: Awaited<ReturnType<typeof toggle>> | undefined
    void toggle().then(value => { result = value })
    await vi.advanceTimersByTimeAsync(10_001)
    expect(result?.status).toBe(502)
    expect(result?.json.reason).toContain('restoration failed')
    expect(result?.json.reason).toContain('did not settle')
    expect(stateText()).toBe(before)
    expect((await toggle()).status).toBe(502)
  })

  it('bounds a hung explicit entry disable without persisting an off choice', async () => {
    seed([])
    const entry: LoaderEntry = { options: { name: 'bad', disabled: null }, fiber: {}, update: async () => new Promise<void>(() => {}) }
    entries.push(entry)
    const before = stateText()
    vi.useFakeTimers()
    let result: Awaited<ReturnType<typeof toggle>> | undefined
    void toggle(false).then(value => { result = value })
    await vi.advanceTimersByTimeAsync(10_001)
    expect(result?.status).toBe(502)
    expect(result?.json.reason).toContain('did not settle')
    expect(stateText()).toBe(before)
    expect((await toggle(false)).status).toBe(502)
  })

  it('bounds hot cleanup during write recovery without leaving the route locked', async () => {
    reject = false
    stop = () => new Promise<void>(() => {})
    const before = stateText()
    ioFault.suffix = 'state.json'; ioFault.remaining = 1
    vi.useFakeTimers()
    let result: Awaited<ReturnType<typeof toggle>> | undefined
    void toggle().then(value => { result = value })
    await vi.advanceTimersByTimeAsync(10_001)
    expect(result?.status).toBe(502)
    expect(result?.json.reason).toContain('runtime restoration failed')
    expect(result?.json.reason).toContain('did not settle')
    expect(stateText()).toBe(before)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    expect((await toggle(false)).json.reason).toContain('still pending')
  })

  it('preserves file symlinks while publishing the chosen state', async () => {
    reject = false
    const patchPath = join(dir, 'cordis.patch.yml')
    const statePath = join(dir, '.dsh-market/state.json')
    const patchTarget = join(dir, 'linked-patch.yml')
    const stateTarget = join(dir, 'linked-state.json')
    writeFileSync(patchTarget, readFileSync(patchPath))
    writeFileSync(stateTarget, readFileSync(statePath))
    rmSync(patchPath); rmSync(statePath)
    symlinkSync(patchTarget, patchPath, 'file'); symlinkSync(stateTarget, statePath, 'file')
    expect((await toggle()).status).toBe(200)
    expect(lstatSync(patchPath).isSymbolicLink()).toBe(true)
    expect(lstatSync(statePath).isSymbolicLink()).toBe(true)
    expect(readFileSync(patchTarget, 'utf8')).not.toContain('disabled: true')
    expect(JSON.parse(readFileSync(stateTarget, 'utf8')).disabled).not.toContain('bad')
  })

  it('reports restoration failure without overwriting an edit made after publication', async () => {
    reject = false
    const patchPath = join(dir, 'cordis.patch.yml')
    let edited = ''
    ioFault.suffix = 'state.json'; ioFault.remaining = 1
    ioFault.onFailure = () => {
      edited = readFileSync(patchPath, 'utf8') + '# external edit after publication\n'
      writeFileSync(patchPath, edited)
    }
    const result = await toggle()
    expect(result.status).toBe(502)
    expect(result.json.reason).toContain('profile restoration failed')
    expect(readFileSync(patchPath, 'utf8')).toBe(edited)
    expect(readMarketState(dir).disabled.has('bad')).toBe(true)
    expect(listHotMounts()).not.toContain('bad')
  })

  it('exposes failed old-theme restoration through the group response', async () => {
    catalog.themes = ['bad', 'good']
    const good: LoaderEntry = { options: { name: 'good', disabled: null }, fiber: {}, update: async options => {
      good.options.disabled = options.disabled
      good.fiber = undefined
      if (!options.disabled) throw new Error('old theme could not be restored')
    } }
    entries.push(good)
    expect((await dispatch('groups', { action: 'set-members', name: 'work', members: ['bad'] })).status).toBe(200)
    const before = stateText()
    const result = await dispatch('groups', { action: 'toggle', name: 'work', enabled: true })
    expect(result.status).toBe(400)
    expect(result.json.error).toContain('runtime restoration failed')
    expect(stateText()).toBe(before)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
  })

})
