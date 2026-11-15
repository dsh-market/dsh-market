// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createUpdateNotificationsStore, ignoredUpdatesForBoot, notificationNames, unseenNotificationNames,
} from '../../src/client/update-notifications.ts'
import type { UpdateNotificationSnapshot } from '../../src/client/update-notifications.ts'
import type { UpdateStatus } from '../../src/updates.ts'

const snapshot = (patch: Partial<UpdateNotificationSnapshot> = {}): UpdateNotificationSnapshot => ({
  enabled: true, intervalHours: 6, checking: false, checkedAt: 100, lastSuccessAt: 100, nextCheckAt: 200,
  stale: false, error: null, boot: 'host-1', updates: {}, updateExempt: [], disabled: [], blocked: [], ...patch,
})
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const release = (patch: Partial<UpdateStatus> = {}): UpdateStatus => ({
  kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '2.0.0', updateAvailable: true, ...patch,
})
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); localStorage.clear(); vi.useRealTimers() })

describe('shared update notification snapshot', () => {
  it('starts with automatic checks off and a six-hour interval', () => {
    const store = createUpdateNotificationsStore(vi.fn())
    expect(store.getSnapshot()).toMatchObject({ enabled: false, intervalHours: 6, loaded: false, readFailed: false })
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
      .mockResolvedValueOnce(response(snapshot({ updates: { alpha: { updateAvailable: false, checkFailed: false } as never } })))
      .mockResolvedValueOnce(response(snapshot({ error: 'One source failed', stale: true, updates: { alpha: { updateAvailable: true, checkFailed: true } } })))
    const store = createUpdateNotificationsStore(request)
    await store.refresh()
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(store.refresh()).resolves.toMatchObject({ stale: true, loaded: true, readFailed: true })
      expect(notificationNames(store.getSnapshot())).toEqual(['alpha'])
      expect(store.getSnapshot().lastSuccessAt).toBe(100)
    }
    await expect(store.refresh()).resolves.toMatchObject({ loaded: true, readFailed: false, stale: true, error: 'One source failed' })
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

describe('unread plugin update notifications', () => {
  it('acknowledges once without changing the pending list or making a request', () => {
    const request = vi.fn()
    const store = createUpdateNotificationsStore(request)
    const changed = vi.fn()
    store.subscribe(changed)
    const data = snapshot({ profileKey: 'profile-a', updates: { alpha: release() } })
    expect(unseenNotificationNames(data)).toEqual(['alpha'])
    store.acknowledge(data)
    expect(unseenNotificationNames(data)).toEqual([])
    expect(notificationNames(data)).toEqual(['alpha'])
    expect(changed).toHaveBeenCalledTimes(1)
    store.acknowledge(data)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps a seen target quiet across polls, refreshes, checks and the same profile restarting', async () => {
    let data = snapshot({ profileKey: 'persistent-profile', updates: { alpha: release() } })
    const request = vi.fn(async () => response(data))
    const store = createUpdateNotificationsStore(request)
    await store.refresh()
    store.acknowledge()
    data = { ...data, checkedAt: 300, lastSuccessAt: 300, nextCheckAt: 500 }
    await store.refresh()
    await store.check()
    expect(unseenNotificationNames(store.getSnapshot())).toEqual([])
    // A fresh client instance and a new host boot keep the same profile receipt.
    data = { ...data, boot: 'host-2' }
    const reloaded = createUpdateNotificationsStore(request)
    await reloaded.refresh()
    expect(unseenNotificationNames(reloaded.getSnapshot())).toEqual([])
    expect(notificationNames(reloaded.getSnapshot())).toEqual(['alpha'])
    expect(localStorage.length).toBe(1)
    expect(sessionStorage.length).toBe(0)
  })

  it('announces new targets, installed versions and source kinds independently', () => {
    const store = createUpdateNotificationsStore(vi.fn())
    const data = snapshot({ profileKey: 'targets', updates: { alpha: release() } })
    store.acknowledge(data)
    for (const status of [release({ latest: '3.0.0' }), release({ current: '1.1.0', version: '1.1.0' }),
      release({ kind: 'generation', updateAvailable: false }), release({ restoreRequired: true })]) {
      expect(unseenNotificationNames({ ...data, updates: { alpha: status } })).toEqual(['alpha'])
    }
    // A package first appearing after the page was visited has not been seen.
    expect(unseenNotificationNames({ ...data, updates: { ...data.updates, beta: release() } })).toEqual(['beta'])
  })

  it('tracks the installable target while a newer release is held back', () => {
    const store = createUpdateNotificationsStore(vi.fn())
    const data = snapshot({ profileKey: 'mature-target', updates: { alpha: release({ eligibleVersion: '1.5.0' }) } })
    store.acknowledge(data)
    expect(unseenNotificationNames({ ...data, updates: { alpha: release({ eligibleVersion: '1.5.0', latest: '2.1.0' }) } })).toEqual([])
    expect(unseenNotificationNames({ ...data, updates: { alpha: release({ eligibleVersion: '1.6.0' }) } })).toEqual(['alpha'])
  })

  it('retains the receipt across failures without hiding an unseen last-good update', async () => {
    const data = snapshot({ profileKey: 'failed-read', updates: { alpha: release(), beta: release() } })
    const request = vi.fn().mockResolvedValueOnce(response(data)).mockRejectedValueOnce(new Error('offline'))
    const store = createUpdateNotificationsStore(request)
    await store.refresh()
    store.acknowledge({ ...data, updates: { alpha: release() } })
    await store.refresh()
    expect(store.getSnapshot().stale).toBe(true)
    expect(unseenNotificationNames(store.getSnapshot())).toEqual(['beta'])
    expect(unseenNotificationNames({ ...data, stale: true, error: 'offline', updates: {
      alpha: release({ checkError: 'unavailable' }), beta: release({ checkError: 'unavailable' }),
    } })).toEqual(['beta'])
  })

  it('isolates opaque profiles and reverse-proxy endpoints', () => {
    const store = createUpdateNotificationsStore(vi.fn())
    const data = snapshot({ profileKey: 'profile-one', updates: { alpha: release() } })
    store.acknowledge(data)
    expect(unseenNotificationNames({ ...data, profileKey: 'profile-two' })).toEqual(['alpha'])
    const base = document.createElement('base')
    base.href = `${location.origin}/other-harness/`
    document.head.appendChild(base)
    try { expect(unseenNotificationNames(data)).toEqual(['alpha']) } finally { base.remove() }
    expect(unseenNotificationNames(data)).toEqual([])
  })

  it('publishes shared receipt changes from another window until the final owner leaves', async () => {
    const data = snapshot({ profileKey: 'shared-window', updates: { alpha: release() } })
    const request = vi.fn(async () => response(data))
    const store = createUpdateNotificationsStore(request)
    const stop = store.start()
    await store.refresh()
    store.acknowledge()
    const changed = vi.fn()
    store.subscribe(changed)
    const key = localStorage.key(0)!
    localStorage.removeItem(key)
    window.dispatchEvent(new StorageEvent('storage', { key }))
    expect(changed).toHaveBeenCalledTimes(1)
    expect(unseenNotificationNames(store.getSnapshot())).toEqual(['alpha'])
    expect(request).toHaveBeenCalledTimes(1)
    stop()
    changed.mockClear()
    window.dispatchEvent(new StorageEvent('storage', { key }))
    expect(changed).not.toHaveBeenCalled()
  })

  it('uses boot-scoped session receipts when an older server has no profile identity', () => {
    const data = snapshot({ updates: { alpha: release() } })
    createUpdateNotificationsStore(vi.fn()).acknowledge(data)
    expect(unseenNotificationNames(data)).toEqual([])
    expect(unseenNotificationNames({ ...data, boot: 'host-2' })).toEqual(['alpha'])
    expect(unseenNotificationNames({ ...data, boot: '' })).toEqual(['alpha'])
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(1)
  })

  it.each(['{broken', JSON.stringify({ version: 0, fingerprints: [] }), JSON.stringify({ version: 1, fingerprints: [1] })])
    ('fails open for an invalid stored receipt %s', invalid => {
      const store = createUpdateNotificationsStore(vi.fn())
      const data = snapshot({ profileKey: 'invalid-receipt', updates: { alpha: release() } })
      store.acknowledge(data)
      localStorage.setItem(localStorage.key(0)!, invalid)
      expect(unseenNotificationNames(data)).toEqual(['alpha'])
      store.acknowledge(data)
      expect(unseenNotificationNames(data)).toEqual([])
    })

  it.each(['reads', 'writes'])('remembers visits for this client when storage blocks %s', mode => {
    const store = createUpdateNotificationsStore(vi.fn())
    const data = snapshot({ profileKey: `restricted-${mode}`, updates: { alpha: release() } })
    if (mode === 'reads') vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const changed = vi.fn()
    store.subscribe(changed)
    store.acknowledge(data)
    expect(unseenNotificationNames(data)).toEqual([])
    store.acknowledge(data)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(unseenNotificationNames({ ...data, updates: { alpha: release({ latest: '3.0.0' }) } })).toEqual(['alpha'])
  })
})
