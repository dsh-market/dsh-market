// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createElement, useSyncExternalStore } from 'react'
import type { ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installPluginsUpdateIndicator } from '../../src/client/PluginsUpdateIndicator.tsx'
import { updateNotifications, notificationNames, notifyUpdatePreferencesChanged } from '../../src/client/update-notifications.ts'
import { en, zh } from '../../src/client/locales.ts'

interface Entry {
  component: ComponentType<{ size?: number; active?: boolean }>
  options: { name: string; id: string; priority?: number; order?: number; label?: string | (() => string) }
  inject?: unknown
}

/** The public list-slot semantics, including synchronous notification as a stricter lifecycle case. */
class Slots {
  rows: Entry[] = []
  revision = 0
  listeners = new Map<string, Set<() => void>>()
  failInjection: string | undefined
  failRegistration: string | undefined
  deferInjection: string | undefined
  pendingInjections = new Map<string, () => void>()
  inject(slot: string, callback: () => () => void) {
    if (slot === this.failInjection) throw new Error('slot injection unavailable')
    if (slot === this.deferInjection) {
      let stop: (() => void) | undefined
      this.pendingInjections.set(slot, () => { stop = callback() })
      return () => { this.pendingInjections.delete(slot); stop?.() }
    }
    return callback()
  }
  flushInjection(slot: string) {
    const start = this.pendingInjections.get(slot)
    this.pendingInjections.delete(slot)
    start?.()
  }
  register(options: Entry['options'], component: Entry['component']) {
    if (options.name === this.failRegistration) throw new Error('slot registration unavailable')
    if (this.rows.some(row => row.options.name === options.name && row.options.id === options.id
      && (row.options.priority ?? 0) === (options.priority ?? 0))) throw new Error('occupied priority')
    const entry = { options, component }
    this.rows.push(entry)
    this.emit(options.name)
    return () => {
      if (!this.rows.includes(entry)) return
      this.rows = this.rows.filter(row => row !== entry)
      this.emit(options.name)
    }
  }
  entries(slot: string) { return this.rows.filter(row => row.options.name === slot).sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0)) }
  entriesOfSlot(slot: string) {
    const seen = new Set<string>()
    return this.entries(slot).filter(row => { if (seen.has(row.options.id)) return false; seen.add(row.options.id); return true })
  }
  subscribe(slot: string, listener: () => void) {
    const set = this.listeners.get(slot) ?? new Set<() => void>()
    set.add(listener)
    this.listeners.set(slot, set)
    return () => { set.delete(listener) }
  }
  emit(slot: string) {
    this.revision += 1
    for (const listener of [...this.listeners.get(slot) ?? []]) listener()
  }
}

let stopStore: (() => void) | undefined
afterEach(() => { cleanup(); stopStore?.(); stopStore = undefined; sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function setup(withOriginal = true, options: { omitActive?: boolean; active?: boolean; failInjection?: string; failRegistration?: string; deferInjection?: string } = {}) {
  let count = 1
  let target = '1.1.0'
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    enabled: true, intervalHours: 6, checking: false, checkedAt: 100, lastSuccessAt: 100, nextCheckAt: 200,
    stale: false, error: null, updates: Object.fromEntries(Array.from({ length: count }, (_, i) => [`plugin-${i}`, {
      kind: 'npm', current: '1.0.0', latest: target, eligibleVersion: target, updateAvailable: true,
    }])),
    boot: 'boot-1', updateExempt: [], disabled: [], blocked: [],
  }))))
  stopStore = updateNotifications.start()
  await updateNotifications.refresh()
  const slots = new Slots()
  const localeListeners = new Set<() => void>()
  let language = 'en'
  const locale = {
    subscribe: (listener: () => void) => { localeListeners.add(listener); return () => { localeListeners.delete(listener) } },
    getSnapshot: () => ({ active: language }),
  }
  const label = () => language === 'zh' ? '插件' : 'Plugins'
  const navigate = vi.fn()
  const Icon = ({ size, active }: { size?: number; active?: boolean }) => <svg data-original-plugins-icon="" width={size} data-active={String(active)} />
  const addOriginal = () => slots.register({ name: 'sidebar.panellist', id: 'plugins', order: 4, label }, Icon)
  let removeOriginal = withOriginal ? addOriginal() : () => {}
  slots.failInjection = options.failInjection
  slots.failRegistration = options.failRegistration
  slots.deferInjection = options.deferInjection
  const t = (key: string) => (language === 'zh' ? zh : en)[key] ?? key
  const stopIndicator = installPluginsUpdateIndicator({ slots }, t, locale)
  let hostActive = options.omitActive === true ? undefined : options.active ?? false
  function Shell({ active }: { active: boolean | undefined }) {
    useSyncExternalStore(listener => slots.subscribe('sidebar.panellist', listener), () => slots.revision)
    useSyncExternalStore(locale.subscribe, () => locale.getSnapshot().active)
    return <>
      {slots.entriesOfSlot('sidebar.panellist').map(entry => {
        const text = typeof entry.options.label === 'function' ? entry.options.label() : entry.options.label
        return <button key={entry.options.id} aria-label={text} aria-current={active ? 'page' : undefined} onClick={() => navigate(entry.options.id)}>
          <span aria-hidden="true">{createElement(entry.component, { size: 20, ...(active === undefined ? {} : { active }) })}</span><span>{text}</span>
        </button>
      })}
      {slots.entriesOfSlot('shell.overlay').map(entry => createElement(entry.component, { key: entry.options.id }))}
    </>
  }
  const view = render(<Shell active={hostActive} />)
  navigate.mockImplementation(() => { hostActive = true; view.rerender(<Shell active={hostActive} />) })
  return {
    slots, label, navigate, view, stopIndicator,
    setCount: async (next: number) => { count = next; await act(async () => { await updateNotifications.refresh() }) },
    setVersion: async (next: string) => { target = next; await act(async () => { await updateNotifications.refresh() }) },
    setActive: (active: boolean | undefined) => act(() => { hostActive = active; view.rerender(<Shell active={hostActive} />) }),
    setLocale: (next: string) => act(() => { language = next; for (const listener of localeListeners) listener() }),
    removeOriginal: () => act(() => { removeOriginal() }),
    addOriginal: () => act(() => { removeOriginal = addOriginal() }),
  }
}

describe('Plugins update indicator', () => {
  it('decorates the original icon with live counts and preserves label, order, navigation and locale', async () => {
    const b = await setup()
    const winner = b.slots.entriesOfSlot('sidebar.panellist')[0]
    expect(winner.options.label).toBe(b.label)
    expect(winner.options.order).toBe(4)
    expect(b.view.getAllByRole('button')).toHaveLength(1)
    expect(b.view.container.querySelector('[data-original-plugins-icon]')?.getAttribute('width')).toBe('20')
    expect(b.view.container.querySelector('[data-original-plugins-icon]')?.getAttribute('data-active')).toBe('false')
    expect(b.view.container.querySelector('[data-dsh-market-update-dot]')?.getAttribute('data-update-count')).toBe('1')
    await b.setCount(3)
    expect(b.view.container.querySelector('[data-dsh-market-update-dot]')?.getAttribute('data-update-count')).toBe('3')
    expect(b.view.getByRole('status').textContent).toContain('3')
    expect(b.view.getByRole('status').closest('[aria-hidden="true"]')).toBeNull()
    b.setLocale('zh')
    expect(b.view.getByRole('button', { name: '插件' })).toBeTruthy()
    expect(b.view.getByRole('status').textContent).toBe(zh.updateNotificationsAnnouncement.replace('{count}', '3'))
    fireEvent.click(b.view.getByRole('button', { name: '插件' }))
    expect(b.navigate).toHaveBeenCalledExactlyOnceWith('plugins')
    expect(b.view.getByRole('button', { name: '插件' }).getAttribute('aria-current')).toBe('page')
    expect(b.view.container.querySelector('[data-dsh-market-update-dot]')).toBeNull()
    expect(b.view.getByRole('status').textContent).toBe('')
    act(() => b.stopIndicator())
  })

  it('acknowledges only the host active panel and alerts again for a new version after leaving', async () => {
    const b = await setup()
    // A swallowed click is not a visit. The host still owns navigation.
    b.navigate.mockImplementationOnce(() => {})
    fireEvent.click(b.view.getByRole('button', { name: 'Plugins' }))
    expect(b.view.container.querySelector('[data-dsh-market-update-dot]')).not.toBeNull()
    fireEvent.click(b.view.getByRole('button', { name: 'Plugins' }))
    expect(b.view.container.querySelector('[data-dsh-market-update-dot]')).toBeNull()
    expect(b.view.getByRole('status').textContent).toBe('')
    expect(notificationNames(updateNotifications.getSnapshot())).toEqual(['plugin-0'])
    b.setActive(false)
    await b.setVersion('1.1.0')
    expect(b.view.container.querySelector('[data-dsh-market-update-dot]')).toBeNull()
    await b.setVersion('1.2.0')
    expect(b.view.container.querySelector('[data-dsh-market-update-dot]')).not.toBeNull()
    expect(b.view.getByRole('status').textContent).toContain('1')
    act(() => b.stopIndicator())
  })

  it('keeps arrivals quiet while Plugins is active and leaves their update offers available', async () => {
    const b = await setup(true, { active: true })
    expect(b.view.container.querySelector('[data-dsh-market-update-dot]')).toBeNull()
    await b.setVersion('1.2.0')
    expect(b.view.container.querySelector('[data-dsh-market-update-dot]')).toBeNull()
    expect(b.view.getByRole('status').textContent).toBe('')
    expect(notificationNames(updateNotifications.getSnapshot())).toEqual(['plugin-0'])
    b.setActive(false)
    expect(b.view.container.querySelector('[data-dsh-market-update-dot]')).toBeNull()
    act(() => b.stopIndicator())
  })

  it('keeps the original icon quiet when the host does not report its active panel', async () => {
    const b = await setup(true, { omitActive: true })
    expect(b.view.container.querySelector('[data-original-plugins-icon]')).not.toBeNull()
    expect(b.view.container.querySelector('[data-dsh-market-update-dot]')).toBeNull()
    expect(b.view.getByRole('status').textContent).toBe('')
    b.setActive(false)
    expect(b.view.container.querySelector('[data-dsh-market-update-dot]')).not.toBeNull()
    act(() => b.stopIndicator())
  })

  it('updates the shared count immediately after a same-boot dismissal', async () => {
    const b = await setup()
    act(() => {
      sessionStorage.setItem('dshm-updates-ignored', JSON.stringify({ boot: 'boot-1', names: ['plugin-0'] }))
      notifyUpdatePreferencesChanged()
    })
    expect(b.view.container.querySelector('[data-dsh-market-update-dot]')).toBeNull()
    expect(b.view.getByRole('status').textContent).toBe('')
    act(() => b.stopIndicator())
  })

  it('restores the exact original registration and removes announcements on disposal', async () => {
    const b = await setup()
    act(() => b.stopIndicator())
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(1)
    expect(b.view.container.querySelector('[data-original-plugins-icon]')).not.toBeNull()
    expect(b.view.container.querySelector('[data-dsh-market-plugins-indicator]')).toBeNull()
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
    await b.setCount(2)
    expect(b.view.container.querySelector('[data-dsh-market-update-dot]')).toBeNull()
  })

  it('does not invent a launcher and follows the native entry losing and regaining access', async () => {
    const b = await setup(false)
    expect(b.view.queryByRole('button')).toBeNull()
    expect(b.view.getByRole('status').textContent).toBe('')
    b.addOriginal()
    expect(b.view.getByRole('button', { name: 'Plugins' })).toBeTruthy()
    expect(b.view.container.querySelector('[data-dsh-market-update-dot]')).not.toBeNull()
    b.removeOriginal()
    expect(b.view.queryByRole('button')).toBeNull()
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(0)
    act(() => b.stopIndicator())
  })

  it('backs off from a competing override and returns when it leaves, with synchronous host notifications', async () => {
    const b = await setup()
    let stopOther!: () => void
    act(() => { stopOther = b.slots.register({ name: 'sidebar.panellist', id: 'plugins', priority: -2, label: 'Other' }, () => <svg data-other-icon="" />) })
    expect(b.view.container.querySelector('[data-other-icon]')).not.toBeNull()
    expect(b.view.container.querySelector('[data-dsh-market-plugins-indicator]')).toBeNull()
    expect(b.view.getByRole('status').textContent).toBe('')
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(2)
    act(() => stopOther())
    expect(b.view.container.querySelector('[data-dsh-market-update-dot]')).not.toBeNull()
    act(() => b.stopIndicator())
  })

  it.each([
    { failInjection: 'sidebar.panellist' }, { failInjection: 'shell.overlay' },
    { failRegistration: 'sidebar.panellist' }, { failRegistration: 'shell.overlay' },
  ])('quietly restores the native entry after a slot failure: %j', async options => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const b = await setup(true, options)
    expect(b.view.getByRole('button', { name: 'Plugins' })).toBeTruthy()
    expect(b.view.container.querySelector('[data-original-plugins-icon]')).not.toBeNull()
    expect(b.view.container.querySelector('[data-dsh-market-plugins-indicator]')).toBeNull()
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(1)
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    fireEvent.click(b.view.getByRole('button', { name: 'Plugins' }))
    expect(b.navigate).toHaveBeenCalledExactlyOnceWith('plugins')
    act(() => { b.stopIndicator(); b.stopIndicator() })
  })

  it('quietly removes an attached decoration if a later overlay injection fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const b = await setup(true, { deferInjection: 'shell.overlay', failRegistration: 'shell.overlay' })
    expect(b.view.container.querySelector('[data-dsh-market-update-dot]')).not.toBeNull()
    expect(() => act(() => b.slots.flushInjection('shell.overlay'))).not.toThrow()
    expect(b.view.container.querySelector('[data-original-plugins-icon]')).not.toBeNull()
    expect(b.view.container.querySelector('[data-dsh-market-plugins-indicator]')).toBeNull()
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(1)
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    act(() => b.stopIndicator())
  })

  it('skips hosts without the public shadowing API and icons with their own injected business state', async () => {
    const register = vi.fn()
    expect(() => installPluginsUpdateIndicator({ slots: { register, inject: vi.fn() } }, key => key, {
      subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }),
    })()).not.toThrow()
    expect(register).not.toHaveBeenCalled()
    const b = await setup(false)
    b.slots.rows.push({ options: { name: 'sidebar.panellist', id: 'plugins', label: 'Plugins' }, component: () => <svg />, inject: () => ({ private: true }) })
    act(() => b.slots.emit('sidebar.panellist'))
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(1)
    expect(b.view.container.querySelector('[data-dsh-market-update-dot]')).toBeNull()
    act(() => b.stopIndicator())
  })
})
