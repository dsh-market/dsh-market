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
    // The consequence itself is caught in layer 3 (tests/web/channel.e2e.ts)
    // against a real settings service, per this file's own rule about not
    // hand-writing a stand-in for a contract we did not author.
    expect(Object.keys(MarketSettings({}))).toEqual(['allowRestart'])
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
})
