/**
 * The market's page-level entrances (#1015): what reaches the two gates,
 * and which answers the UI is allowed to offer.
 *
 * Defaults are shown, saved answers arrive after the slots have been wired,
 * and the host may keep the settings door shut on its own (#602). Every one
 * of those orderings has a test here because each of them can otherwise
 * flash an entry, take away one the user kept, or leave the market with no
 * way in at all.
 */

import { describe, expect, it, vi } from 'vitest'
import { createSectionGate } from '../../src/client/section-gate.ts'
import { createEntryVisibility } from '../../src/client/entry-visibility.ts'

function harness(
  answer: (init?: RequestInit) => { status?: number; body: unknown },
  options: { sidebarSupported?: () => boolean; sidebarShown?: () => boolean } = {},
) {
  const live = { settings: 0, tab: 0 }
  const settingsGate = createSectionGate(() => {
    live.settings += 1
    return () => { live.settings -= 1 }
  })
  const pluginsTabGate = createSectionGate(() => {
    live.tab += 1
    return () => { live.tab -= 1 }
  })
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const { status = 200, body } = answer(init)
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof globalThis.fetch
  const entries = createEntryVisibility({
    settingsGate,
    pluginsTabGate,
    fetch,
    sidebarSupported: options.sidebarSupported ?? (() => false),
    sidebarShown: options.sidebarShown ?? (() => false),
  })
  return { entries, calls, live, fetch }
}

const both = { settingsSection: true, pluginsTab: true }

describe('createEntryVisibility', () => {
  it('registers both entries once their slots arrive', () => {
    const { entries, live } = harness(() => ({ body: both }))
    expect(live).toEqual({ settings: 0, tab: 0 })
    entries.markSettingsSection()
    entries.markPluginsTab()
    expect(live).toEqual({ settings: 1, tab: 1 })
    expect(entries.settingsVisible()).toBe(true)
  })

  it('does not register a door the user turned off, whichever arrives first', async () => {
    const savedOff = () => ({ body: { settingsSection: false, pluginsTab: false } })
    const before = harness(savedOff)
    await before.entries.load()
    before.entries.markSettingsSection()
    before.entries.markPluginsTab()
    expect(before.live).toEqual({ settings: 0, tab: 0 })

    const after = harness(savedOff)
    after.entries.markSettingsSection()
    after.entries.markPluginsTab()
    expect(after.live).toEqual({ settings: 1, tab: 1 })
    await after.entries.load()
    expect(after.live).toEqual({ settings: 0, tab: 0 })
  })

  it('treats an unreadable answer as the shown default', async () => {
    const { entries, live } = harness(() => ({ status: 500, body: { error: 'boom' } }))
    await entries.load()
    entries.markSettingsSection()
    entries.markPluginsTab()
    expect(entries.settingsSection()).toBe(true)
    expect(entries.pluginsTab()).toBe(true)
    expect(live).toEqual({ settings: 1, tab: 1 })
  })

  it('posts one answer and applies the pair the server accepted', async () => {
    const { entries, calls, live } = harness(init => (init?.method === 'POST'
      ? { body: { ok: true, settingsSection: false, pluginsTab: true } }
      : { body: both }), { sidebarSupported: () => true, sidebarShown: () => true })
    entries.markSettingsSection()
    entries.markPluginsTab()
    const seen = vi.fn()
    entries.subscribe(seen)
    await expect(entries.set('settingsSection', false)).resolves.toBe(false)
    expect(calls.at(-1)?.url).toMatch(/\/dsh-market\/entry-visibility$/)
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({ settingsSection: false })
    expect(entries.settingsSection()).toBe(false)
    expect(live).toEqual({ settings: 0, tab: 1 })
    expect(seen).toHaveBeenCalled()
  })

  it('leaves the doors as they were when the save is refused', async () => {
    const { entries, live } = harness(init => (init?.method === 'POST'
      ? { status: 409, body: { error: 'at least one market entry must stay visible' } }
      : { body: both }), { sidebarSupported: () => true, sidebarShown: () => true })
    entries.markSettingsSection()
    await entries.load()
    await expect(entries.set('settingsSection', false)).rejects.toThrow('at least one')
    expect(entries.settingsSection()).toBe(true)
    expect(live.settings).toBe(1)
  })

  it('keeps the host’s own answer when the user asks for the section (#602)', async () => {
    const { entries, live } = harness(() => ({ body: both }))
    entries.markSettingsSection()
    entries.setHostSettingsVisible(false)
    expect(live.settings).toBe(0)
    expect(entries.settingsAvailable()).toBe(false)
    expect(entries.settingsSupported()).toBe(true)

    // The user cannot undo the host's choice by flipping a switch...
    entries.setHostSettingsVisible(true)
    expect(live.settings).toBe(1)

    // ...and the host's own hidden state is what the card can rely on.
    entries.setHostSettingsVisible(false)
    expect(entries.settingsVisible()).toBe(false)
  })

  it('does not let the host show an entry the user turned off', async () => {
    const { entries, live } = harness(init => (init?.method === 'POST'
      ? { body: { ok: true, settingsSection: false, pluginsTab: true } }
      : { body: both }), { sidebarSupported: () => true, sidebarShown: () => true })
    entries.markSettingsSection()
    await entries.load()
    await entries.set('settingsSection', false)
    expect(live.settings).toBe(0)

    // The published contract (UPDATE-API-V1.md): the host's "show" cannot
    // override the user's OFF.
    entries.setHostSettingsVisible(true)
    expect(live.settings).toBe(0)
    expect(entries.settingsVisible()).toBe(false)
  })

  it('counts only doors the host actually declares', async () => {
    const { entries, calls } = harness(() => ({ body: both }))
    entries.markSettingsSection()
    // No Plugins tab on this host, and the row is off: Settings is the only
    // door, so it cannot be turned off.
    expect(entries.pluginsTabSupported()).toBe(false)
    expect(entries.otherDoorOpen('settingsSection')).toBe(false)
    await expect(entries.set('settingsSection', false)).rejects.toThrow('at least one')
    expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(0)

    entries.markPluginsTab()
    expect(entries.otherDoorOpen('settingsSection')).toBe(true)
  })

  it('sees the sidebar row as a door, and sees it close', async () => {
    let sidebarOn = true
    const { entries } = harness(() => ({ body: { settingsSection: false, pluginsTab: false } }), {
      sidebarSupported: () => true,
      sidebarShown: () => sidebarOn,
    })
    entries.markSettingsSection()
    entries.markPluginsTab()
    await entries.load()
    // Both page entries are saved off; the row is the one open door, so the
    // page switches have to see it as their other way in.
    expect(entries.otherDoorOpen('settingsSection')).toBe(true)
    expect(entries.otherDoorOpen('pluginsTab')).toBe(true)
    expect(entries.otherDoorOpen('sidebar')).toBe(false)

    // The card's own state changes live; no refresh is needed here.
    sidebarOn = false
    expect(entries.otherDoorOpen('settingsSection')).toBe(false)
    expect(entries.otherDoorOpen('pluginsTab')).toBe(false)
  })

  it('reports support only once the host declares each slot', () => {
    const { entries } = harness(() => ({ body: both }))
    expect(entries.settingsSupported()).toBe(false)
    expect(entries.pluginsTabSupported()).toBe(false)
    entries.markSettingsSection()
    expect(entries.settingsSupported()).toBe(true)
    expect(entries.pluginsTabSupported()).toBe(false)
    entries.markPluginsTab()
    expect(entries.pluginsTabSupported()).toBe(true)
  })

  it('does not let a slow load overwrite an answer the user just saved', async () => {
    let releaseLoad!: () => void
    const loadGate = new Promise<void>(resolve => { releaseLoad = resolve })
    const settingsGate = createSectionGate(() => () => {})
    const pluginsTabGate = createSectionGate(() => () => {})
    let gets = 0
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
        return new Response(JSON.stringify({ ok: true, settingsSection: false, pluginsTab: true }), { status: 200 })
      }
      gets += 1
      // Only the initial load is held; the pre-save re-read must not make
      // the two promises wait on each other.
      if (gets === 1) await loadGate
      return new Response(JSON.stringify({ settingsSection: true, pluginsTab: true }), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const entries = createEntryVisibility({
      settingsGate,
      pluginsTabGate,
      fetch,
      sidebarSupported: () => true,
      sidebarShown: () => true,
    })
    const loading = entries.load()
    await expect(entries.set('settingsSection', false)).resolves.toBe(false)
    releaseLoad()
    await loading
    expect(entries.settingsSection()).toBe(false)
  })

  it('serializes saves so the second one sees the first one’s answer', async () => {
    // Two OFF saves in flight together would each judge the last-door rule
    // from the world before the other landed. The queue makes the second
    // wait, and the fresh re-read then refuses it locally.
    const server = { settingsSection: true, pluginsTab: true }
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    let posts = 0
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posts += 1
        await firstGate
        Object.assign(server, JSON.parse(String(init?.body)) as { settingsSection?: boolean; pluginsTab?: boolean })
        return new Response(JSON.stringify({ ok: true, ...server }), { status: 200 })
      }
      return new Response(JSON.stringify(server), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const live = { settings: 0, tab: 0 }
    const settingsGate = createSectionGate(() => {
      live.settings += 1
      return () => { live.settings -= 1 }
    })
    const pluginsTabGate = createSectionGate(() => {
      live.tab += 1
      return () => { live.tab -= 1 }
    })
    const entries = createEntryVisibility({
      settingsGate,
      pluginsTabGate,
      fetch,
      sidebarSupported: () => false,
      sidebarShown: () => false,
    })
    entries.markSettingsSection()
    entries.markPluginsTab()

    const first = entries.set('settingsSection', false)
    const second = entries.set('pluginsTab', false)
    releaseFirst()
    await expect(first).resolves.toBe(false)
    await expect(second).rejects.toThrow('at least one')
    expect(posts).toBe(1)
    expect(entries.settingsSection()).toBe(false)
    expect(entries.pluginsTab()).toBe(true)
    expect(live).toEqual({ settings: 0, tab: 1 })
  })

  it('never registers again after the package is removed', () => {
    const { entries, live } = harness(() => ({ body: both }))
    entries.markSettingsSection()
    entries.markPluginsTab()
    expect(live).toEqual({ settings: 1, tab: 1 })
    entries.retire()
    expect(live).toEqual({ settings: 0, tab: 0 })
    entries.markSettingsSection()
    entries.markPluginsTab()
    expect(live).toEqual({ settings: 0, tab: 0 })
  })
})
