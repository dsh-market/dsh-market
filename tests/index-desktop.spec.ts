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
  officialFactoryArgs: [] as unknown[][],
  packageManagers: [] as unknown[],
}))

vi.mock('../src/dsh-cli.ts', () => ({
  createDesktopPluginRuntime: (...args: unknown[]) => {
    state.factoryArgs.push(args)
    return state.runtime
  },
  setHostPackageManager: (invocation: unknown) => {
    state.packageManagers.push(invocation)
  },
}))

vi.mock('../src/official-desktop.ts', () => ({
  createOfficialDesktopRuntime: (...args: unknown[]) => {
    state.officialFactoryArgs.push(args)
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
  state.officialFactoryArgs = []
  state.packageManagers = []
})

describe('profile the launcher booted (#639)', () => {
  const launcher = { name: 'desktop', dir: '/home/u/.dsh/profiles/desktop' }
  // A profile the dsh CLI can launch. It cannot be named `desktop`: the CLI
  // refuses that name outright, so a `desktop` profile only ever comes from
  // the Electron app (#702). "Ordinary launcher profile" cases use this.
  const ordinary = { name: 'work', dir: '/home/u/.dsh/profiles/work' }

  it('routes a `desktop` profile to the official manager even without an app.asar anchor (#702)', () => {
    // The CLI rejects the profile by NAME (`profile.toLowerCase() ===
    // "desktop"`, @deepseek-ai/dsh 0.1.7-alpha.2). Keying detection on an
    // install-anchor shape let a host with a different layout fall through
    // to the CLI and fail every install.
    const ctx = new FakeContext({ webServer: {}, loader: {}, profileContext: launcher })

    apply(ctx as never)

    expect(state.officialFactoryArgs).toHaveLength(1)
    expect(state.mounts[0].config).toMatchObject({ profile: 'desktop', desktopHost: true, allowRestart: false })
  })

  it('matches the name case-insensitively, as the CLI does', () => {
    const ctx = new FakeContext({ webServer: {}, loader: {}, profileContext: { name: 'Desktop', dir: '/home/u/.dsh/profiles/Desktop' } })

    apply(ctx as never)

    expect(state.officialFactoryArgs).toHaveLength(1)
  })

  it('does not call an ordinary launcher profile a desktop shell', () => {
    // The launcher hands every profile its own directory, so the capability
    // bits must not read that directory as "a Desktop shell serves us" (#639
    // follow-up).
    const ctx = new FakeContext({ webServer: {}, loader: {}, profileContext: ordinary })

    apply(ctx as never)

    expect(state.mounts[0].config.profileDirectory).toBe(ordinary.dir)
    expect(state.mounts[0].config.desktopHost).toBeUndefined()
    expect(state.officialFactoryArgs).toHaveLength(0)
  })

  it('uses the official manager rather than the forbidden CLI for Electron desktop', () => {
    // The official desktop host starts a profile through the launcher's node
    // entry: no `--profile` on argv, no `desktopProfiles` service. The market
    // used to answer `web` and write every install there.
    const ctx = new FakeContext({
      webServer: {}, loader: {},
      profileContext: { ...launcher, installAnchor: '/Applications/DSH.app/Contents/Resources/app.asar/dsh/package.json' },
    })

    apply(ctx as never)

    expect(state.mounts).toHaveLength(1)
    expect(state.mounts[0].config).toMatchObject({
      profile: 'desktop',
      profileDirectory: '/home/u/.dsh/profiles/desktop',
    })
    expect(state.mounts[0].runtime).toBe(state.runtime)
    expect(state.officialFactoryArgs).toHaveLength(1)
    expect(state.officialFactoryArgs[0]?.slice(1)).toEqual(['desktop', launcher.dir])
    expect(state.mounts[0].config).toMatchObject({ desktopHost: true, allowRestart: false })
  })

  it("uses the launcher's installation anchor for bundled package checks", () => {
    const ctx = new FakeContext({
      webServer: {}, loader: {},
      profileContext: { ...launcher, installAnchor: '/Applications/DSH.app/Contents/Resources/app.asar/dsh/package.json' },
    })
    apply(ctx as never)
    expect(state.mounts[0].config.dshInstallDir).toBe('/Applications/DSH.app/Contents/Resources/app.asar/dsh')
  })

  it('lets an explicit cordis.yml profile win, and never carries the other profile\'s directory', () => {
    const ctx = new FakeContext({ webServer: {}, loader: {}, profileContext: launcher })

    apply(ctx as never, { profile: 'team' })

    expect(state.mounts[0].config).toMatchObject({ profile: 'team' })
    expect(state.mounts[0].config.profileDirectory).toBeUndefined()
  })

  it('falls back to the flag and then to web when the launcher says nothing usable', () => {
    for (const context of [undefined, {}, { name: '  ', dir: '/d' }, { name: '../escape', dir: '/d' }, { name: 'ok', dir: '' }]) {
      state.mounts = []
      const ctx = new FakeContext({ webServer: {}, loader: {}, ...(context === undefined ? {} : { profileContext: context }) })

      apply(ctx as never)

      expect(state.mounts[0].config, `context=${JSON.stringify(context)}`).toMatchObject({ profile: 'web' })
      expect(state.mounts[0].config.profileDirectory).toBeUndefined()
    }
  })

  it('prefers the launcher over a --profile flag on this process', () => {
    const argv = process.argv
    process.argv = [...argv, '--profile', 'from-flag']
    try {
      const ctx = new FakeContext({ webServer: {}, loader: {}, profileContext: launcher })
      apply(ctx as never)
      expect(state.mounts[0].config).toMatchObject({ profile: 'desktop' })
    } finally {
      process.argv = argv
    }
  })

  it('still reads the flag when the launcher service is absent', () => {
    const argv = process.argv
    process.argv = [...argv, '--profile', 'from-flag']
    try {
      const ctx = new FakeContext({ webServer: {}, loader: {} })
      apply(ctx as never)
      expect(state.mounts[0].config).toMatchObject({ profile: 'from-flag' })
      expect(state.mounts[0].config.profileDirectory).toBeUndefined()
    } finally {
      process.argv = argv
    }
  })

  it('leaves a Desktop shell that provides desktopProfiles on its own path', () => {
    const ctx = new FakeContext({
      webServer: {}, loader: {}, desktopPnpm: {},
      profileContext: launcher,
      desktopProfiles: { current: { name: 'shell', dir: '/shell/dir' } },
    })

    apply(ctx as never)

    expect(state.mounts[0].config).toMatchObject({ profile: 'shell', profileDirectory: '/shell/dir', desktopHost: true })
  })
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

describe('the launcher\'s own package manager (#653)', () => {
  // Not `desktop`: that name only ever comes from the Electron app, whose
  // installs go through the app's plugin manager and never through pnpm
  // (#702). These cases are about the CLI path, which is where a launcher's
  // own package manager is used.
  const published = {
    name: 'work',
    dir: '/home/u/.dsh/profiles/work',
    packageManager: {
      command: '/Applications/DSH.app/Contents/Resources/runtime/node',
      args: ['/Applications/DSH.app/Contents/Resources/runtime/pnpm.mjs'],
      env: { PATH: '/Applications/DSH.app/Contents/Resources/runtime', DSH_BUNDLED: '1' },
    },
  }

  it('registers the published invocation, environment included', () => {
    // The invocation is the whole tuple: the host names its bundled node AND
    // the PATH its child processes need. Keeping only the command would leave
    // a tool this process still cannot execute — the reported failure.
    const ctx = new FakeContext({ webServer: {}, loader: {}, profileContext: published })

    apply(ctx as never)

    expect(state.packageManagers).toEqual([{
      command: '/Applications/DSH.app/Contents/Resources/runtime/node',
      args: ['/Applications/DSH.app/Contents/Resources/runtime/pnpm.mjs'],
      env: { PATH: '/Applications/DSH.app/Contents/Resources/runtime', DSH_BUNDLED: '1' },
    }])
  })

  it('registers nothing when the launcher publishes nothing', () => {
    const ctx = new FakeContext({ webServer: {}, loader: {}, profileContext: { name: 'web', dir: '/d' } })

    apply(ctx as never)

    expect(state.packageManagers).toEqual([null])
  })

  it.each([
    ['no command', { args: [], env: {} }],
    ['blank command', { command: '   ', args: [], env: {} }],
    ['non-string command', { command: 7, args: [], env: {} }],
    ['missing args', { command: 'node' }],
    ['non-array args', { command: 'node', args: 'pnpm' }],
    ['non-string args', { command: 'node', args: ['pnpm', 1] }],
    ['string env', { command: 'node', args: [], env: 'PATH=/' }],
    ['null env', { command: 'node', args: [], env: null }],
    ['array env', { command: 'node', args: [], env: [] }],
    ['not an object', 'node'],
    ['null', null],
  ])('discards the whole invocation when it is malformed: %s', (_case, packageManager) => {
    // Half an invocation is worse than none: it would aim the probe at a
    // command it cannot run and keep the PATH fallback from ever being tried.
    const ctx = new FakeContext({
      webServer: {}, loader: {}, profileContext: { name: 'work', dir: '/d', packageManager },
    })

    apply(ctx as never)

    expect(state.packageManagers).toEqual([null])
  })

  it('drops non-string environment values instead of handing them to spawn', () => {
    const ctx = new FakeContext({
      webServer: {},
      loader: {},
      profileContext: {
        name: 'work',
        dir: '/d',
        packageManager: { command: 'node', args: [], env: { KEEP: 'yes', DROP_NUMBER: 7, DROP_OBJECT: {} } },
      },
    })

    apply(ctx as never)

    expect(state.packageManagers).toEqual([{ command: 'node', args: [], env: { KEEP: 'yes' } }])
  })
})
