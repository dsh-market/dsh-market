import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

const state = vi.hoisted(() => ({
  mounts: [] as { host: unknown; config: Record<string, unknown>; runtime?: unknown }[],
  routeDisposals: 0,
  runtimeDisposals: 0,
  runtime: {
    runPlugin: () => Promise.resolve({}),
    probePnpm: () => Promise.resolve(true),
    provisionPnpm: () => Promise.resolve({ ok: true }),
    cancelActive: () => false,
    dispose: () => {
      state.runtimeDisposals += 1
      return Promise.resolve()
    },
  },
  factoryArgs: [] as unknown[][],
}))

vi.mock('../src/dsh-cli.ts', () => ({
  createDesktopPluginRuntime: (...args: unknown[]) => {
    state.factoryArgs.push(args)
    return state.runtime
  },
}))

vi.mock('../src/routes.ts', () => ({
  mountMarketRoutes: (host: unknown, config: Record<string, unknown>, runtime?: unknown) => {
    state.mounts.push({ host, config, runtime })
    return () => { state.routeDisposals += 1 }
  },
}))

import { apply } from '../src/index.ts'

class FakeContext {
  readonly injectCalls: string[][] = []
  readonly effects: { label: string; dispose: () => void | Promise<void> }[] = []

  constructor(private readonly services: Record<string, unknown>) {
    Object.assign(this, services)
  }

  get(name: string): unknown {
    return this.services[name]
  }

  inject(deps: string[], callback: (ctx: FakeContext) => void): void {
    this.injectCalls.push(deps)
    if (deps.every(name => this.services[name] !== undefined)) callback(this)
  }

  effect(callback: () => (() => void | Promise<void>), label: string): void {
    this.effects.push({ label, dispose: callback() })
  }
}

beforeEach(() => {
  state.mounts = []
  state.routeDisposals = 0
  state.runtimeDisposals = 0
  state.factoryArgs = []
})

describe('host adaptation', () => {
  it('preserves the ordinary DSH profile and CLI runtime fallback', () => {
    const ctx = new FakeContext({ webServer: {}, loader: {} })
    apply(ctx as never, { profile: 'team', allowRestart: true })

    // The host pair is what the routes wait on; `settings` is the optional
    // wiring behind the settings card, which no-ops on a host that never
    // provides it. What this guards is the absence of the Desktop services:
    // the ordinary path must not wait on a shell that is not there.
    expect(ctx.injectCalls[0]).toEqual(['webServer', 'loader'])
    expect(ctx.injectCalls.flat()).not.toContain('desktopPnpm')
    expect(ctx.injectCalls.flat()).not.toContain('desktopProfiles')
    expect(state.factoryArgs).toEqual([])
    expect(state.mounts).toHaveLength(1)
    expect(state.mounts[0]).toMatchObject({
      config: { profile: 'team', allowRestart: true },
      runtime: undefined,
    })
  })

  it('uses the immutable Desktop profile and waits for desktopPnpm in a nested injection', async () => {
    const desktopPnpm = { runPlugin: vi.fn() }
    const ctx = new FakeContext({
      webServer: {},
      loader: {},
      desktopProfiles: { current: { name: '工作 profile', dir: '/private/dsh/desktop' } },
      desktopPnpm,
    })
    apply(ctx as never, { profile: 'must-not-win', allowRestart: true })

    expect(ctx.injectCalls).toEqual([['webServer', 'loader'], ['desktopPnpm'], ['settings']])
    expect(state.factoryArgs).toEqual([[desktopPnpm, '/private/dsh/desktop']])
    expect(state.mounts).toHaveLength(1)
    expect(state.mounts[0]).toMatchObject({
      config: {
        profile: '工作 profile',
        profileDirectory: '/private/dsh/desktop',
        allowRestart: false,
      },
      runtime: state.runtime,
    })

    expect(ctx.effects).toHaveLength(1)
    await ctx.effects[0].dispose()
    expect(state.routeDisposals).toBe(1)
    expect(state.runtimeDisposals).toBe(1)
  })

  it('uses the documented pre-Loader desktopProfiles discriminator and never falls back to ambient CLI', () => {
    const ctx = new FakeContext({
      webServer: {},
      loader: {},
      desktopProfiles: { current: { name: 'desktop', dir: '/private/dsh/desktop' } },
    })
    apply(ctx as never)

    expect(ctx.injectCalls).toEqual([['webServer', 'loader'], ['desktopPnpm']])
    expect(state.mounts).toEqual([])
    expect(state.factoryArgs).toEqual([])
  })
})

describe('unconfigured allowRestart stays undefined so detection can decide (#229)', () => {
  it('does not collapse an absent allowRestart into an explicit true', () => {
    // restartAllowed() distinguishes "the operator said nothing" (where a
    // detected supervisor turns restart off) from "the operator said yes"
    // (which overrules detection). A `?? true` here would erase that
    // distinction before it ever reached the check — the whole detection
    // would silently no-op on exactly the hosts it exists for.
    const ctx = new FakeContext({ webServer: {}, loader: {} })
    apply(ctx as never)

    expect(state.mounts).toHaveLength(1)
    expect(state.mounts[0].config.allowRestart).toBeUndefined()
  })

  it('still forwards an explicit setting verbatim, either way', () => {
    for (const allowRestart of [true, false]) {
      state.mounts = []
      const ctx = new FakeContext({ webServer: {}, loader: {} })
      apply(ctx as never, { allowRestart })
      expect(state.mounts[0].config.allowRestart).toBe(allowRestart)
    }
  })
})

// Only storage is substituted: namespace resolution, describe, writes and
// scoped disposal all run through the host's real SettingsProvider/Cordis.
describe('host settings registration (#516)', () => {
  const ns = 'dsh-market' as SettingsNamespace
  let root: Context
  let document: Record<string, unknown>

  class MemorySettings extends SettingsProvider {
    readonly writable = true
    async load() { return document }
    async persist(namespace: SettingsNamespace, section: Record<string, unknown>) {
      document = { ...document, [namespace]: structuredClone(section) }
    }
  }

  beforeEach(() => {
    document = { [ns]: { allowRestart: true }, unrelated: { keep: 'me' } }
    root = new Context()
    root.provide('webServer', {})
    root.provide('loader', {})
  })
  afterEach(async () => { await root.fiber.dispose() })

  async function settings() {
    await vi.waitFor(() => { expect(root.get('settings')).toBeDefined() })
    return root.get('settings') as SettingsProvider
  }

  function desktop() {
    root.provide('desktopProfiles', { current: { name: 'desktop', dir: '/isolated/desktop' } })
    return root.provide('desktopPnpm', { runPlugin: vi.fn() })
  }

  it('serves a Desktop namespace without offering or enabling restart, including reloads', async () => {
    desktop()
    let provider = root.plugin(MemorySettings)
    const service = await settings()
    let market = root.plugin(ctx => apply(ctx, { allowRestart: true, profile: 'ignored' }))
    await vi.waitFor(() => { expect(state.mounts).toHaveLength(1) })
    const config = state.mounts[0].config
    expect(service.describe().map(view => view.ns)).toEqual([ns])
    const schema = service.describe()[0].schema as { refs: Record<string, { dict: object }> }
    expect(Object.values(schema.refs).map(ref => ref.dict)).toEqual([{}])
    expect(config).toMatchObject({ allowRestart: false, profile: 'desktop', profileDirectory: '/isolated/desktop' })

    for (const allowRestart of [false, true]) {
      await service.update(ns, { allowRestart })
      expect(config.allowRestart).toBe(false)
    }
    expect(document.unrelated).toEqual({ keep: 'me' })
    await provider.dispose()
    expect(service.describe()).toEqual([])
    expect(config.allowRestart).toBe(false)
    expect(state.routeDisposals).toBe(0)
    expect(state.runtimeDisposals).toBe(0)

    provider = root.plugin(MemorySettings)
    const reloaded = await settings()
    await vi.waitFor(() => { expect(reloaded.describe().map(view => view.ns)).toEqual([ns]) })
    expect(config.allowRestart).toBe(false)
    await market.dispose()
    expect(reloaded.describe()).toEqual([])
    expect(state.routeDisposals).toBe(1)
    expect(state.runtimeDisposals).toBe(1)

    market = root.plugin(ctx => apply(ctx, { allowRestart: true }))
    await vi.waitFor(() => { expect(state.mounts).toHaveLength(2) })
    expect(reloaded.describe().map(view => view.ns)).toEqual([ns])
    expect(state.mounts[1].config.allowRestart).toBe(false)
    await market.dispose()
    expect(reloaded.describe()).toEqual([])
    expect(state.routeDisposals).toBe(2)
    expect(state.runtimeDisposals).toBe(2)
  })

  it('preserves Web saved values, live updates and the entry fallback on settings unload', async () => {
    const provider = root.plugin(MemorySettings)
    const service = await settings()
    root.plugin(ctx => apply(ctx, { allowRestart: false }))
    await vi.waitFor(() => { expect(state.mounts).toHaveLength(1) })
    const config = state.mounts[0].config
    expect(service.describe().map(view => view.ns)).toEqual([ns])
    expect(config.allowRestart).toBe(true)
    await service.update(ns, { allowRestart: false })
    await vi.waitFor(() => { expect(config.allowRestart).toBe(false) })
    await service.update(ns, { allowRestart: true })
    await vi.waitFor(() => { expect(config.allowRestart).toBe(true) })
    await provider.dispose()
    expect(config.allowRestart).toBe(false)
    expect(state.routeDisposals).toBe(0)
  })

  it('retires the namespace with desktopPnpm and mounts it once on recovery', async () => {
    const removePnpm = desktop()
    root.plugin(MemorySettings)
    const service = await settings()
    root.plugin(ctx => apply(ctx))
    await vi.waitFor(() => { expect(service.describe().map(view => view.ns)).toEqual([ns]) })
    removePnpm()
    await vi.waitFor(() => {
      expect(service.describe()).toEqual([])
      expect(state.routeDisposals).toBe(1)
      expect(state.runtimeDisposals).toBe(1)
    })
    root.provide('desktopPnpm', { runPlugin: vi.fn() })
    await vi.waitFor(() => { expect(state.mounts).toHaveLength(2) })
    expect(service.describe().map(view => view.ns)).toEqual([ns])
    expect(state.mounts[1].config).toMatchObject({
      allowRestart: false, profile: 'desktop', profileDirectory: '/isolated/desktop',
    })
  })

  it.each([false, true])('mounts without settings and registers when the service arrives (desktop=%s)', async (isDesktop) => {
    if (isDesktop) desktop()
    root.plugin(ctx => apply(ctx, { allowRestart: true }))
    await vi.waitFor(() => { expect(state.mounts).toHaveLength(1) })
    expect(state.mounts[0].config.allowRestart).toBe(!isDesktop)
    root.plugin(MemorySettings)
    const service = await settings()
    await vi.waitFor(() => { expect(service.describe().map(view => view.ns)).toEqual([ns]) })
    expect(state.mounts).toHaveLength(1)
    expect(state.mounts[0].config.allowRestart).toBe(!isDesktop)
  })
})
