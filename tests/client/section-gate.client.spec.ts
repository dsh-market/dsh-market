/**
 * The orderings, which are the whole difficulty of this gate.
 *
 * Two things decide whether the market's settings entry exists — the host's
 * preference (#602) and this package being removed — and they arrive at
 * different times relative to each other and to the slots service. Every
 * test here is one of those interleavings, because the boolean logic is
 * trivial and the timing is not.
 */

import { describe, expect, it, vi } from 'vitest'
import { createSectionGate } from '../../src/client/section-gate.ts'

/** A gate plus the count of live registrations it has made. */
function harness(): { gate: ReturnType<typeof createSectionGate>; registrations: () => number; live: () => number } {
  let made = 0
  let live = 0
  const gate = createSectionGate(() => {
    made += 1
    live += 1
    return () => { live -= 1 }
  })
  return { gate, registrations: () => made, live: () => live }
}

describe('createSectionGate', () => {
  it('shows the entry by default, once the slots service arrives', () => {
    const { gate, registrations } = harness()
    // Nothing to register through yet: no service, no registration.
    expect(registrations()).toBe(0)
    gate.available()
    expect(registrations()).toBe(1)
    expect(gate.visible()).toBe(true)
  })

  it('registers nothing when the host hid it BEFORE the service arrived', () => {
    // The ordering a naive implementation gets wrong: hide, then the service
    // shows up, and the entry appears anyway — the host's shell renders the
    // market itself, so the user sees a duplicate it explicitly asked not to
    // have. Worse than not supporting the request at all.
    const { gate, registrations } = harness()
    gate.setVisible(false)
    gate.available()
    expect(registrations()).toBe(0)
    expect(gate.visible()).toBe(false)
  })

  it('retracts the entry when the host hides it after the fact', () => {
    const { gate, registrations, live } = harness()
    gate.available()
    gate.setVisible(false)
    expect(gate.visible()).toBe(false)
    expect(live()).toBe(0)
    expect(registrations()).toBe(1)
  })

  it('gives the entry back when the host changes its mind, without registering twice', () => {
    const { gate, registrations, live } = harness()
    gate.available()
    gate.setVisible(false)
    gate.setVisible(true)
    expect(gate.visible()).toBe(true)
    expect(live()).toBe(1)
    // Two registrations total (once initially, once restored) — never two
    // alive at once, which is what a duplicate nav item would be.
    expect(registrations()).toBe(2)
  })

  it('does not re-register on a repeated call with the same answer', () => {
    const { gate, registrations } = harness()
    gate.available()
    gate.setVisible(true)
    gate.setVisible(true)
    expect(registrations()).toBe(1)
  })

  it('cannot be un-retired by a later show: removal is final', () => {
    // The removal flow uses the same gate. If a "show" arriving afterwards
    // could resurrect the entry, the market would put a nav item back for a
    // package the profile no longer has — the card claiming something the
    // profile disagrees with, which is exactly what `retire` prevents.
    const { gate, registrations } = harness()
    gate.available()
    gate.retire()
    expect(gate.visible()).toBe(false)
    gate.setVisible(true)
    expect(registrations()).toBe(1)
    expect(gate.visible()).toBe(false)
  })

  it('honours a hide that arrives after a removal as a no-op', () => {
    const { gate, registrations } = harness()
    gate.available()
    gate.retire()
    gate.setVisible(false)
    gate.setVisible(true)
    expect(registrations()).toBe(1)
    expect(gate.visible()).toBe(false)
  })
})

describe('the service the market publishes for this', () => {
  it('is what a host calls, and reports what the gate did', () => {
    // Mirrors the shape `apply()` publishes on `ctx.provide('market', …)`:
    // the gate is the implementation, this is the surface.
    const { gate } = harness()
    const marketControl = {
      version: 1 as const,
      setSettingsVisible: (visible: boolean): void => { gate.setVisible(visible) },
      settingsVisible: (): boolean => gate.visible(),
    }
    gate.available()
    expect(marketControl.settingsVisible()).toBe(true)
    marketControl.setSettingsVisible(false)
    expect(marketControl.settingsVisible()).toBe(false)
    expect(marketControl.version).toBe(1)
  })

  it('survives a host calling it before the slots service exists', () => {
    const { gate, registrations } = harness()
    const setSettingsVisible = vi.fn((visible: boolean) => { gate.setVisible(visible) })
    setSettingsVisible(false)
    gate.available()
    expect(registrations()).toBe(0)
  })
})
