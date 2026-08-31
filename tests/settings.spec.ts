/**
 * The market's own settings section: what makes `allowRestart` a switch on
 * the plugin configuration page instead of a hand-edited YAML line.
 *
 * Only what a unit can honestly decide lives here: the schema's defaults,
 * and that the settings service is an OPTIONAL injection so a host without
 * one (every dsh before 0.1.0-rc.7) mounts everything else unchanged.
 *
 * Whether the namespace actually reaches a real host is asserted in layer 3
 * against real dsh, not against a hand-written stand-in of the settings
 * service — a fake would only prove this code agrees with my reading of a
 * contract I did not write.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installMarketSettings, MarketSettings } from '../src/settings.ts'

/** Minimal cordis stand-in recording the optional `settings` injection. */
function fakeContext(hasSettings: boolean) {
  const injected: string[][] = []
  const ctx = {
    injected,
    inject(services: string[], callback: (scoped: unknown) => void) {
      injected.push(services)
      if (hasSettings && services.includes('settings')) callback(ctx)
    },
    settings: hasSettings ? {} : undefined,
    effect: (run: () => unknown) => { run() },
    on: () => () => {},
  }
  return ctx
}

describe('MarketSettings schema', () => {
  it('defaults allowRestart to on', () => {
    expect(MarketSettings({}).allowRestart).toBe(true)
  })

  it('accepts an explicit off', () => {
    expect(MarketSettings({ allowRestart: false }).allowRestart).toBe(false)
  })

  it('defaults buildEnv to nothing', () => {
    expect(MarketSettings({}).buildEnv).toEqual({})
  })

  it('accepts a pinned build environment (#336)', () => {
    expect(MarketSettings({ buildEnv: { CC: '/usr/bin/gcc-11', CXX: '/usr/bin/g++-11' } }).buildEnv)
      .toEqual({ CC: '/usr/bin/gcc-11', CXX: '/usr/bin/g++-11' })
  })

  it('claims only what this namespace actually stores', () => {
    // The release channel was in here for one version, and it made this a
    // SECOND writer for a value that lives in the market's state.json. The
    // routes read the saved channel off disk at mount and `onChange` — which
    // cannot see that file — assigned its own idea of the field straight
    // back over it, so the user's choice survived until the next settings
    // event and no further.
    //
    // A schema field is a claim of ownership, so this asserts the claim
    // stays narrow — widening it silently is exactly how that happened.
    // The one deliberate widening is `buildEnv` (issue #336), whose whole
    // point is to be edited at runtime on hosts whose process environment
    // cannot be controlled from a shell; it has its own ownership guarantee
    // (its merge precedence in src/dsh-cli.ts spawnEnv). Everything else in
    // here is a regression, and the consequence itself is caught in layer 3
    // (tests/web/channel.e2e.ts) against a real settings service, per this
    // file's own rule about not hand-writing a stand-in for a contract we
    // did not author.
    expect(Object.keys(MarketSettings({}))).toEqual(['allowRestart', 'buildEnv'])
  })
})

describe('installMarketSettings', () => {
  it('asks for the settings service optionally, never as a hard dependency', () => {
    const ctx = fakeContext(false)
    installMarketSettings(ctx as never, { allowRestart: true })
    // A host without the service must still mount everything else: the
    // registration rides its own scoped fiber.
    expect(ctx.injected.flat()).toContain('settings')
    expect(ctx.injected.flat()).not.toContain('webServer')
  })

  it('syncs a pinned buildEnv into the live config the routes read (#336)', () => {
    // The routes read `resolved.buildEnv` live through the spawnEnv source,
    // so a settings edit must land on that object — not on a copy made at
    // registration. Same contract `allowRestart` already holds.
    let stored: MarketSettings = { allowRestart: true, buildEnv: { CC: '/usr/bin/gcc-11', CXX: '/usr/bin/g++-11' } }
    let notify: () => void = () => {}
    const scope = {
      get: () => stored,
      watch: (listener: () => void) => { notify = listener },
    }
    const ctx = {
      injected: [] as string[][],
      inject(services: string[], callback: (scoped: unknown) => void) {
        ctx.injected.push(services)
        if (services.includes('settings')) {
          callback({ settings: { register: () => scope }, effect: (run: () => unknown) => run() })
        }
      },
      effect: (run: () => unknown) => { run() },
      on: () => () => {},
    }
    const resolved: { allowRestart?: boolean; buildEnv?: Record<string, string> } = { allowRestart: true }
    installMarketSettings(ctx as never, resolved)
    expect(resolved.buildEnv).toEqual({ CC: '/usr/bin/gcc-11', CXX: '/usr/bin/g++-11' })
    // A later edit reaches the same object — the settings service calls the
    // registered watcher on every commit, which is what re-syncs the config.
    stored = { allowRestart: true, buildEnv: { CC: '/usr/bin/gcc-11' } }
    notify()
    expect(resolved.buildEnv).toEqual({ CC: '/usr/bin/gcc-11' })
  })

  it('takes nothing from @deepseek-ai/dsh-settings at runtime', () => {
    // dsh 0.1.2-alpha.1 deleted `installSettingsSection` and moved
    // `settingsNamespace` elsewhere. This module imported both, and the
    // result was not a missing feature — it was the HOST FAILING TO BOOT:
    //
    //   SyntaxError: The requested module '@deepseek-ai/dsh-settings' does
    //   not provide an export named 'installSettingsSection'
    //
    // That is the distinction this guard exists for. `ctx.inject` degrades
    // quietly when a SERVICE is absent, which is the graceful path this file
    // already tests above. An ESM import of a missing EXPORT cannot degrade
    // at all: it throws while the module is being evaluated, cordis reports
    // a failed entry, and dsh exits 1 with the market installed. A plugin
    // must never be able to stop the host from starting.
    //
    // The service is the stable surface — `settings.register(ns, schema,
    // { base })` is byte-identical in 0.1.0-rc.7 and 0.1.2-alpha.2 — so the
    // rule is simply: reach the settings service through injection, never
    // through this package's exports. Scanned rather than mocked, because
    // this is a fact about our own source, not a claim about their contract
    // (see the note at the top of this file).
    const source = readFileSync(resolve('src/settings.ts'), 'utf8')
    const runtimeImports = [...source.matchAll(/^import\s+(?!type\b)(.+?)\s+from\s+'([^']+)'/gmu)]
      .filter(match => match[2]!.startsWith('@deepseek-ai/dsh-settings'))
    expect(runtimeImports.map(match => match[0]), 'import the settings SERVICE via ctx.inject instead').toEqual([])
  })
})
