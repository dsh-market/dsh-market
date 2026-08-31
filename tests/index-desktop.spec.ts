import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    apply(ctx as never, {
      profile: 'team',
      allowRestart: true,
      additionalRegistryUrls: ['https://catalog.aiko.test/plugins.json'],
    })

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
      config: {
        profile: 'team',
        allowRestart: true,
        additionalRegistryUrls: ['https://catalog.aiko.test/plugins.json'],
      },
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

    expect(ctx.injectCalls).toEqual([['webServer', 'loader'], ['desktopPnpm']])
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
