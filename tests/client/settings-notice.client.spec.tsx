// @vitest-environment jsdom
/**
 * The "this has moved" line above the market in Settings.
 *
 * It shows only where it is true and useful: the host has the Plugins page
 * tab and the user keeps it on, and only on the Settings surface. Its button
 * takes the user to the market tab on the Plugins page and closes the
 * Settings dialog. The real host's behaviour is asserted by
 * tests/web/settings-notice.e2e.ts; here the host is a few DOM nodes.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement as h, useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/client/index.ts'
import { SettingsNoticeFrame, openMarketTab } from '../../src/client/SettingsNotice.tsx'
import { createHostNavigation } from '../../src/client/host-navigation.ts'
import type { HostNavigation } from '../../src/client/host-navigation.ts'
import { en, ja, zh } from '../../src/client/locales.ts'
import type { EntryVisibility } from '../../src/client/entry-visibility.ts'

const t = (key: string): string => (en as Record<string, string>)[key] ?? key

function entriesOf(state: { supported: boolean; on: boolean }): EntryVisibility & { flip(next: { supported?: boolean; on?: boolean }): void } {
  const listeners = new Set<() => void>()
  return {
    pluginsTabSupported: () => state.supported,
    pluginsTab: () => state.on,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    flip: (next: { supported?: boolean; on?: boolean }) => {
      Object.assign(state, next)
      for (const listener of listeners) listener()
    },
  } as unknown as EntryVisibility & { flip(next: { supported?: boolean; on?: boolean }): void }
}

afterEach(() => { cleanup(); document.body.innerHTML = '' })

describe('copy', () => {
  it('has the same keys in zh, en and ja', () => {
    for (const key of ['noticeText', 'noticeTextManual', 'noticeGo', 'noticeFailed']) {
      for (const dict of [zh, en, ja] as Array<Record<string, string>>) expect(dict[key], key).toBeTruthy()
    }
  })
})

describe('SettingsNoticeFrame: when the line shows', () => {
  const nav = (): ReturnType<typeof createHostNavigation> => {
    const store = createHostNavigation()
    store.attach({ openBundle: () => {}, openList: () => {} })
    return store
  }

  it.each([
    { supported: true, on: true, shown: true },
    { supported: true, on: false, shown: false },
    { supported: false, on: true, shown: false },
    { supported: false, on: false, shown: false },
  ])('Plugins tab supported=$supported, door on=$on -> line shown=$shown', ({ supported, on, shown }) => {
    render(h(SettingsNoticeFrame, { t, entries: entriesOf({ supported, on }), hostNavigation: nav() }, h('p', null, 'the market')))
    expect(screen.getByText('the market')).toBeTruthy()
    expect(screen.queryByText(t('noticeText')) !== null).toBe(shown)
    expect(screen.queryByRole('button', { name: t('noticeGo') }) !== null).toBe(shown)
  })

  it('does not remount the market when the line appears late', () => {
    const entries = entriesOf({ supported: false, on: true })
    const mounts = vi.fn()
    const Market = (): null => { useEffect(() => { mounts() }, []); return null }
    render(h(SettingsNoticeFrame, { t, entries, hostNavigation: nav() }, h(Market)))
    expect(screen.queryByText(t('noticeText'))).toBeNull()
    act(() => { entries.flip({ supported: true }) })
    expect(screen.getByText(t('noticeText'))).toBeTruthy()
    act(() => { entries.flip({ on: false }) })
    expect(screen.queryByText(t('noticeText'))).toBeNull()
    expect(mounts).toHaveBeenCalledTimes(1)
  })

  it('without the navigation service there is no button, and the sentence says where to go', () => {
    render(h(SettingsNoticeFrame, { t, entries: entriesOf({ supported: true, on: true }), hostNavigation: createHostNavigation() }))
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText(t('noticeTextManual'))).toBeTruthy()
  })

  it('a navigation service that predates openList counts as missing', () => {
    const store = createHostNavigation()
    store.attach({ openBundle: () => {} })
    render(h(SettingsNoticeFrame, { t, entries: entriesOf({ supported: true, on: true }), hostNavigation: store }))
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers the button once the service arrives after the first render', () => {
    const store = createHostNavigation()
    render(h(SettingsNoticeFrame, { t, entries: entriesOf({ supported: true, on: true }), hostNavigation: store }))
    expect(screen.queryByRole('button')).toBeNull()
    act(() => { store.attach({ openBundle: () => {}, openList: () => {} }) })
    expect(screen.getByRole('button', { name: t('noticeGo') })).toBeTruthy()
  })
})

/** A Settings dialog holding the line, and a Plugins page that appears on openList. */
function fakeHost(options: { tab?: boolean; closes?: boolean; closeLabel?: boolean } = {}) {
  const { tab = true, closes = true, closeLabel = true } = options
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  const inside = document.createElement('div')
  dialog.appendChild(inside)
  const close = document.createElement('button')
  if (closeLabel) close.setAttribute('aria-label', 'Close')
  close.addEventListener('click', () => { if (closes) dialog.remove() })
  dialog.appendChild(close)
  document.body.appendChild(dialog)
  const events: string[] = []
  const navigation: HostNavigation = {
    openBundle: () => {},
    openList: () => {
      events.push('openList')
      if (!tab) return
      const el = document.createElement('button')
      el.setAttribute('role', 'tab')
      el.id = ':r1:-dsh-market'
      el.setAttribute('aria-selected', 'false')
      el.addEventListener('click', () => { events.push('tab'); el.setAttribute('aria-selected', 'true') })
      document.body.appendChild(el)
    },
  }
  return { dialog, inside, navigation, events }
}

describe('openMarketTab', () => {
  it('opens the Plugins page, selects the market tab, then closes the dialog', async () => {
    const host = fakeHost()
    host.dialog.addEventListener('click', () => {}, true)
    const ok = await openMarketTab(host.navigation, host.inside)
    expect(ok).toBe(true)
    expect(host.events).toEqual(['openList', 'tab'])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('[role="tab"]')?.getAttribute('aria-selected')).toBe('true')
  })

  it('ignores a tab of the same id that sits inside a dialog', async () => {
    const host = fakeHost({ tab: false })
    const own = document.createElement('button')
    own.setAttribute('role', 'tab')
    own.id = 'x-dsh-market'
    host.dialog.appendChild(own)
    const click = vi.fn()
    own.addEventListener('click', click)
    await openMarketTab(host.navigation, host.inside)
    expect(click).not.toHaveBeenCalled()
  })

  it('still counts as arrived when the tab cannot be found (the Plugins page is open)', async () => {
    const host = fakeHost({ tab: false })
    expect(await openMarketTab(host.navigation, host.inside)).toBe(true)
    expect(host.events).toEqual(['openList'])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  }, 10_000)

  it('closes with Escape when the dialog has no close button to find', async () => {
    const host = fakeHost({ closeLabel: false })
    host.dialog.addEventListener('keydown', (event) => { if ((event as KeyboardEvent).key === 'Escape') host.dialog.remove() })
    expect(await openMarketTab(host.navigation, host.inside)).toBe(true)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('reports failure when there is no navigation, so the caller can say so', async () => {
    const host = fakeHost()
    expect(await openMarketTab(undefined, host.inside)).toBe(false)
    expect(await openMarketTab({ openBundle: () => {} }, host.inside)).toBe(false)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('reports failure when the host throws', async () => {
    const host = fakeHost()
    const failing: HostNavigation = { openBundle: () => {}, openList: () => { throw new Error('boom') } }
    expect(await openMarketTab(failing, host.inside)).toBe(false)
  })
})

describe('the button', () => {
  it('goes to the market tab and closes the dialog', async () => {
    const host = fakeHost()
    const store = createHostNavigation()
    store.attach(host.navigation)
    render(h(SettingsNoticeFrame, { t, entries: entriesOf({ supported: true, on: true }), hostNavigation: store }), { container: host.inside })
    fireEvent.click(screen.getByRole('button', { name: t('noticeGo') }))
    expect(screen.getByRole('button', { name: t('noticeGo') }).hasAttribute('disabled')).toBe(true)
    await waitFor(() => { expect(document.querySelector('[role="dialog"]')).toBeNull() })
    expect(host.events).toEqual(['openList', 'tab'])
  })

  it('says what to do when it cannot take the user there', async () => {
    const host = fakeHost({ closes: false })
    const store = createHostNavigation()
    store.attach(host.navigation)
    render(h(SettingsNoticeFrame, { t, entries: entriesOf({ supported: true, on: true }), hostNavigation: store }), { container: host.inside })
    fireEvent.click(screen.getByRole('button', { name: t('noticeGo') }))
    await waitFor(() => { expect(screen.getByText(t('noticeFailed'))).toBeTruthy() }, { timeout: 4000 })
    expect(screen.getByRole('button', { name: t('noticeGo') }).hasAttribute('disabled')).toBe(false)
  }, 10_000)
})

describe('which surface carries the line', () => {
  interface Registration { options: Record<string, unknown>; render: (props?: unknown) => { type?: unknown } }

  function mount(): Registration[] {
    const registrations: Registration[] = []
    apply({
      effect: (run: () => unknown) => { run() },
      on: () => () => {},
      locale: {
        register: () => () => {}, bind: () => (key: string) => key,
        subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }),
      },
      theme: { getTheme: () => null, setTheme: () => {} },
      slots: {
        inject: (slot: string, register: () => unknown) => {
          if (['settings.section', 'plugins.tab'].includes(slot)) register()
        },
        register: (options: Record<string, unknown>, render: Registration['render']) => {
          registrations.push({ options, render })
          return () => {}
        },
      },
      inject: () => {},
    } as unknown as Parameters<typeof apply>[0])
    return registrations
  }

  it('wraps the Settings section only; the Plugins tab and the sidebar render the market bare', () => {
    const registrations = mount()
    const settings = registrations.find(r => r.options.name === 'settings.section')
    const tab = registrations.find(r => r.options.name === 'plugins.tab')
    expect(settings?.render().type).toBe(SettingsNoticeFrame)
    expect(tab).toBeDefined()
    expect(tab?.render().type).not.toBe(SettingsNoticeFrame)
  })
})
