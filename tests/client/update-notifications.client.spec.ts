// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createUpdateNotificationsStore, ignoredUpdatesForBoot, notificationNames,
} from '../../src/client/update-notifications.ts'
import type { UpdateNotificationSnapshot } from '../../src/update-notifications.ts'

const snapshot = (patch: Partial<UpdateNotificationSnapshot> = {}): UpdateNotificationSnapshot => ({
  enabled: true, intervalHours: 6, checking: false, checkedAt: 100, lastSuccessAt: 100, nextCheckAt: 200,
  stale: false, error: null, boot: 'host-1', updates: {}, updateExempt: [], disabled: [], blocked: [], ...patch,
})
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
afterEach(() => { sessionStorage.clear(); vi.useRealTimers() })

describe('shared update notification snapshot', () => {
  it('starts with automatic checks off and a six-hour interval', () => {
    const store = createUpdateNotificationsStore(vi.fn())
    expect(store.getSnapshot()).toMatchObject({ enabled: false, intervalHours: 6, loaded: false })
  })

  it.each([6, 12, 72, 168] as const)('saves the %s-hour interval without enabling checks', async intervalHours => {
    const request = vi.fn().mockResolvedValue(response(snapshot({ enabled: false, intervalHours })))
    const store = createUpdateNotificationsStore(request)
    await store.setIntervalHours(intervalHours)
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ intervalHours }) })
    expect(store.getSnapshot()).toMatchObject({ enabled: false, intervalHours, loaded: true })
  })

  it('keeps the saved interval while saving and after a rejected save', async () => {
    let rejectSave!: (reason: Error) => void
    const request = vi.fn().mockResolvedValueOnce(response(snapshot({ enabled: false, intervalHours: 12 })))
      .mockImplementationOnce(() => new Promise<Response>((_, reject) => { rejectSave = reject }))
    const store = createUpdateNotificationsStore(request)
    await store.refresh()
    const save = store.setIntervalHours(168)
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    expect(store.getSnapshot()).toMatchObject({ enabled: false, intervalHours: 12 })
    rejectSave(new Error('offline'))
    await expect(save).rejects.toThrow('offline')
    expect(store.getSnapshot()).toMatchObject({ enabled: false, intervalHours: 12, stale: true })
  })

  it.each([0, 24, '6', null])('rejects an invalid response interval %s', async intervalHours => {
    const request = vi.fn().mockResolvedValueOnce(response(snapshot({ intervalHours: 72 })))
      .mockResolvedValueOnce(response({ ...snapshot(), intervalHours }))
    const store = createUpdateNotificationsStore(request)
    await store.refresh()
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ intervalHours: 72, stale: true })
  })

  it('preserves legacy server results and toggles without allowing interval saves', async () => {
    const { intervalHours: _interval, ...legacy } = snapshot({ enabled: true, updates: { alpha: { updateAvailable: true } } })
    const request = vi.fn().mockResolvedValueOnce(response(legacy))
      .mockResolvedValueOnce(response({ ...legacy, enabled: false }))
    const store = createUpdateNotificationsStore(request)
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ enabled: true, intervalHours: null, loaded: true, stale: false })
    expect(notificationNames(store.getSnapshot())).toEqual(['alpha'])
    await store.setEnabled(false)
    expect(store.getSnapshot()).toMatchObject({ enabled: false, intervalHours: null, stale: false })
    await expect(store.setIntervalHours(12)).rejects.toThrow('does not support')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('polls only the local read endpoint without a page and stops after its final owner leaves', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => response(snapshot()))
    const store = createUpdateNotificationsStore(request)
    const stopFirst = store.start()
    const stopSecond = store.start()
    await store.refresh()
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.every(call => call[1]?.method === undefined)).toBe(true)
    expect(String(request.mock.calls[0]?.[0])).toContain('/dsh-market/update-notifications')
    stopFirst()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(request).toHaveBeenCalledTimes(3)
    stopSecond()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(request).toHaveBeenCalledTimes(3)
    expect(store.getSnapshot().loaded).toBe(false)
  })

  it('keeps known updates after offline, invalid and legacy-shaped answers', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response(snapshot({ updates: { alpha: { updateAvailable: true } } })))
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response(snapshot({ updates: { alpha: { kind: 'generation', latest: 42 } as never } })))
    const store = createUpdateNotificationsStore(request)
    await store.refresh()
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(store.refresh()).resolves.toMatchObject({ stale: true, loaded: true })
      expect(notificationNames(store.getSnapshot())).toEqual(['alpha'])
      expect(store.getSnapshot().lastSuccessAt).toBe(100)
    }
  })

  it('posts only explicit checks/settings and ignores an older GET arriving after a save', async () => {
    let resolveRead!: (value: Response) => void
    const request = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? Promise.resolve(response(snapshot({ enabled: false, updates: { beta: { updateAvailable: true } } })))
      : new Promise<Response>(resolve => { resolveRead = resolve }))
    const store = createUpdateNotificationsStore(request)
    const oldRead = store.refresh()
    await store.setEnabled(false)
    resolveRead(response(snapshot()))
    await oldRead
    expect(store.getSnapshot().enabled).toBe(false)
    expect(notificationNames(store.getSnapshot())).toEqual(['beta'])
    await store.check()
    expect(request.mock.calls.filter(call => call[1]?.method === 'POST').map(call => JSON.parse(String(call[1]?.body))))
      .toEqual([{ enabled: false }, { check: true }])
  })

  it('reports a failed user command but keeps the previous good snapshot', async () => {
    const request = vi.fn().mockResolvedValueOnce(response(snapshot({ updates: { alpha: { updateAvailable: true } } })))
      .mockResolvedValueOnce(response({ error: 'offline' }, 503))
    const store = createUpdateNotificationsStore(request)
    await store.refresh()
    await expect(store.check()).rejects.toThrow('503')
    expect(notificationNames(store.getSnapshot())).toEqual(['alpha'])
    expect(store.getSnapshot().stale).toBe(true)
  })

  it('coalesces preference changes but reads again when a save finishes during the trailing GET', async () => {
    const replies: Array<(value: Response) => void> = []
    const request = vi.fn(() => new Promise<Response>(resolve => { replies.push(resolve) }))
    const store = createUpdateNotificationsStore(request)
    const oldRead = store.refresh()
    const changed = store.refreshAfterChange()
    expect(store.refreshAfterChange()).toBe(changed)
    expect(request).toHaveBeenCalledTimes(1)
    replies.shift()!(response(snapshot({ updates: { alpha: { updateAvailable: true } } })))
    await oldRead
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    // The preference POST completes after the second GET already captured
    // its response, so its successful-save notification needs a final read.
    expect(store.refreshAfterChange()).toBe(changed)
    replies.shift()!(response(snapshot({ updates: { alpha: { updateAvailable: true } } })))
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3))
    replies.shift()!(response(snapshot({ updates: { alpha: { updateAvailable: true } }, updateExempt: ['alpha'] })))
    await changed
    expect(notificationNames(store.getSnapshot())).toEqual([])
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls.every(call => call[1]?.method === undefined)).toBe(true)
  })

  it('aborts in-flight reads on unload and does not publish their late results', async () => {
    let resolveRead!: (value: Response) => void
    const request = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(resolve => { resolveRead = resolve }))
    const store = createUpdateNotificationsStore(request)
    const stop = store.start()
    const pending = store.refresh()
    const signal = request.mock.calls[0][1]?.signal
    stop()
    expect(signal?.aborted).toBe(true)
    resolveRead(response(snapshot({ updates: { alpha: { updateAvailable: true } } })))
    await pending
    expect(store.getSnapshot().updates).toEqual({})
    expect(store.getSnapshot().loaded).toBe(false)
  })

  it('shares boot dismissals and completed updates without clearing them before the boot is known', () => {
    sessionStorage.setItem('dshm-updates-ignored', JSON.stringify({ boot: 'host-1', names: ['ignored'] }))
    sessionStorage.setItem('dshm-restart', JSON.stringify({ boot: 'host-1', updated: ['dshmarket', 'done'] }))
    expect(ignoredUpdatesForBoot('')).toEqual([])
    expect(notificationNames(snapshot({ boot: '' }))).toEqual([])
    expect(ignoredUpdatesForBoot('host-1')).toEqual(['ignored'])
    const statuses = Object.fromEntries(['ignored', 'done', 'dshmarket', 'exempt', 'disabled', 'blocked', 'library', 'ordinary', 'generation']
      .map(name => [name, name === 'generation' ? { kind: 'generation', latest: '2.0.0' } : { updateAvailable: true, ...(name === 'library' ? { notAPlugin: true } : {}) }]))
    const data = snapshot({ updates: statuses, updateExempt: ['exempt'], disabled: ['disabled'], blocked: ['blocked'] })
    expect(notificationNames(data)).toEqual(['generation', 'ordinary'])
    expect(notificationNames({ ...data, enabled: false })).toEqual(['generation', 'ordinary'])
    expect(notificationNames({ ...data, boot: 'host-2' })).toEqual(['done', 'dshmarket', 'generation', 'ignored', 'ordinary'])
    expect(JSON.parse(sessionStorage.getItem('dshm-updates-ignored')!).boot).toBe('host-1')
    expect(ignoredUpdatesForBoot('host-2')).toEqual([])
    expect(sessionStorage.getItem('dshm-updates-ignored')).toBeNull()
  })
})
