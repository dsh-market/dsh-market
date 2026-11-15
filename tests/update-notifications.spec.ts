import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUpdateNotificationMonitor, UPDATE_CHECK_INTERVAL_MS, UPDATE_CHECK_START_DELAY_MS } from '../src/update-notifications.ts'
import { readMarketState, writeMarketState } from '../src/hot.ts'
import { UPDATE_CHECK_INTERVAL_HOURS, type UpdateCheckIntervalHours } from '../src/update-notification-settings.ts'
import type { UpdateStatus } from '../src/updates.ts'

const available = (version = '1.0.0', latest = '2.0.0'): UpdateStatus => ({ kind: 'npm', version, current: version, latest, updateAvailable: true })
const unavailable: UpdateStatus = { kind: 'npm', version: '1.0.0', current: null, latest: null, updateAvailable: false, checkError: 'unavailable' }

function setup(enabled = true, intervalHours?: UpdateCheckIntervalHours) {
  let context = 'web:stable'
  let packages: Record<string, string> = { widget: 'npm:widget@1.0.0' }
  let preferences = { updateExempt: [] as string[], disabled: [] as string[], blocked: [] as string[] }
  const check = vi.fn(async (_force: boolean): Promise<{ updates: Record<string, UpdateStatus>; error?: string }> => ({ updates: { widget: available() } }))
  const monitor = createUpdateNotificationMonitor({
    boot: 'boot-a', enabled, intervalHours, inventory: () => ({ context, packages }),
    preferences: () => preferences, check,
  })
  return {
    monitor, check,
    setPackages: (value: Record<string, string>) => { packages = value },
    setContext: (value: string) => { context = value },
    setPreferences: (value: typeof preferences) => { preferences = value },
  }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000) })
afterEach(() => { vi.useRealTimers() })

describe('background update notifications', () => {
  it('checks after startup and on the low-frequency timer without any page reads', async () => {
    const { monitor, check } = setup()
    expect(monitor.snapshot()).toMatchObject({ checking: false, checkedAt: null, nextCheckAt: 1_030_000, updates: {} })
    monitor.snapshot()
    expect(check).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_START_DELAY_MS - 1)
    expect(check).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(check).toHaveBeenCalledTimes(1)
    expect(monitor.snapshot()).toMatchObject({ checkedAt: 1_030_000, lastSuccessAt: 1_030_000, stale: false, updates: { widget: available() } })
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(check).toHaveBeenCalledTimes(2)
    monitor.dispose()
  })

  it.each(UPDATE_CHECK_INTERVAL_HOURS)('waits exactly %s hours between completed automatic checks', async intervalHours => {
    const { monitor, check } = setup(true, intervalHours)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_START_DELAY_MS)
    expect(check).toHaveBeenCalledTimes(1)
    expect(monitor.snapshot()).toMatchObject({ intervalHours, nextCheckAt: Date.now() + intervalHours * 60 * 60_000 })
    await vi.advanceTimersByTimeAsync(intervalHours * 60 * 60_000 - 1)
    expect(check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(check).toHaveBeenCalledTimes(2)
    monitor.dispose()
  })

  it('reschedules an active timer with the new interval and removes the old timer', async () => {
    const { monitor, check } = setup(true, 6)
    await monitor.check()
    await vi.advanceTimersByTimeAsync(60_000)
    monitor.setIntervalHours(168)
    const changedAt = Date.now()
    expect(monitor.snapshot().nextCheckAt).toBe(changedAt + 168 * 60 * 60_000)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000)
    expect(check).toHaveBeenCalledTimes(1)
    monitor.setIntervalHours(12)
    expect(monitor.snapshot().nextCheckAt).toBe(Date.now() + 12 * 60 * 60_000)
    await vi.advanceTimersByTimeAsync(12 * 60 * 60_000)
    expect(check).toHaveBeenCalledTimes(2)
    monitor.dispose()
  })

  it('does not opt in when changing cadence and keeps the startup delay when enabled', async () => {
    const { monitor, check } = setup(false)
    monitor.setIntervalHours(72)
    expect(monitor.snapshot()).toMatchObject({ enabled: false, intervalHours: 72, nextCheckAt: null })
    await vi.advanceTimersByTimeAsync(168 * 60 * 60_000)
    expect(check).not.toHaveBeenCalled()
    monitor.setEnabled(true)
    monitor.setIntervalHours(168)
    expect(monitor.snapshot().nextCheckAt).toBe(Date.now() + UPDATE_CHECK_START_DELAY_MS)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_START_DELAY_MS)
    expect(check).toHaveBeenCalledTimes(1)
    expect(monitor.snapshot().nextCheckAt).toBe(Date.now() + 168 * 60 * 60_000)
    monitor.dispose()
  })

  it('applies a changed interval after an in-flight check without overlapping it', async () => {
    const { monitor, check } = setup()
    let resolve!: (value: { updates: Record<string, UpdateStatus> }) => void
    check.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const pending = monitor.check(true)
    await Promise.resolve()
    monitor.setIntervalHours(72)
    expect(monitor.snapshot()).toMatchObject({ checking: true, intervalHours: 72, nextCheckAt: null })
    await vi.advanceTimersByTimeAsync(168 * 60 * 60_000)
    expect(check).toHaveBeenCalledTimes(1)
    resolve({ updates: { widget: available() } })
    await pending
    expect(monitor.snapshot().nextCheckAt).toBe(Date.now() + 72 * 60 * 60_000)
    monitor.dispose()
  })

  it('does not reschedule when disabled during an in-flight check', async () => {
    const { monitor, check } = setup()
    let resolve!: (value: { updates: Record<string, UpdateStatus> }) => void
    check.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const pending = monitor.check(true)
    await Promise.resolve()
    monitor.setEnabled(false)
    monitor.setIntervalHours(168)
    resolve({ updates: { widget: available() } })
    await pending
    expect(monitor.snapshot()).toMatchObject({ enabled: false, intervalHours: 168, nextCheckAt: null, updates: { widget: available() } })
    expect(vi.getTimerCount()).toBe(0)
    monitor.dispose()
  })

  it('caps retries at 30 minutes independently of a long polling interval, then restores it on success', async () => {
    const { monitor, check } = setup(true, 168)
    check.mockRejectedValue(new Error('offline'))
    for (const delay of [1, 2, 4, 8, 16, 30, 30]) {
      await monitor.check(true)
      expect(monitor.snapshot().nextCheckAt).toBe(Date.now() + delay * 60_000)
    }
    check.mockResolvedValue({ updates: { widget: available() } })
    await monitor.check(true)
    expect(monitor.snapshot().nextCheckAt).toBe(Date.now() + 168 * 60 * 60_000)
    monitor.dispose()
  })

  it('shares simultaneous manual checks and keeps force semantics', async () => {
    const { monitor, check } = setup()
    let resolve!: (value: { updates: Record<string, UpdateStatus> }) => void
    check.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const first = monitor.check(true)
    const second = monitor.check(true)
    expect(first).toBe(second)
    await Promise.resolve()
    expect(check).toHaveBeenCalledExactlyOnceWith(true)
    expect(monitor.snapshot().checking).toBe(true)
    resolve({ updates: { widget: available() } })
    await first
    expect(monitor.snapshot().checking).toBe(false)
    monitor.dispose()
  })

  it('queues only one forced refresh behind a cache-eligible read', async () => {
    const { monitor, check } = setup()
    let resolve!: (value: { updates: Record<string, UpdateStatus> }) => void
    check.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const first = monitor.check(false)
    await Promise.resolve()
    const manual = monitor.check(true)
    expect(monitor.check(true)).toBe(manual)
    resolve({ updates: { widget: available() } })
    await Promise.all([first, manual])
    expect(check.mock.calls.map(call => call[0])).toEqual([false, true])
    monitor.dispose()
  })

  it.each([
    ['notification failure marker', unavailable],
    ['upstream failure marker', { ...unavailable, checkError: undefined, checkFailed: true as const }],
  ])('retains confirmed package results on partial failures and backs off (%s)', async (_label, failedStatus) => {
    const { monitor, check, setPackages } = setup()
    setPackages({ widget: 'npm:widget@1.0.0', other: 'npm:other@1.0.0' })
    check.mockResolvedValueOnce({ updates: { widget: available(), other: available() } })
    await monitor.check(true)
    const lastSuccessAt = monitor.snapshot().lastSuccessAt
    check.mockResolvedValue({ updates: { widget: failedStatus, other: available('1.0.0', '3.0.0') } })
    await vi.advanceTimersByTimeAsync(1000)
    await monitor.check(true)
    expect(monitor.snapshot()).toMatchObject({ stale: true, lastSuccessAt, nextCheckAt: 1_061_000,
      updates: { widget: { ...available(), checkFailed: true, checkError: 'unavailable' }, other: available('1.0.0', '3.0.0') } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(monitor.snapshot().nextCheckAt).toBe(1_181_000)
    expect(check).toHaveBeenLastCalledWith(true)
    check.mockResolvedValue({ updates: { widget: { ...available(), updateAvailable: false, latest: '1.0.0' }, other: available() } })
    await monitor.check(true)
    expect(monitor.snapshot()).toMatchObject({ stale: false, error: null, updates: { widget: { updateAvailable: false } } })
    expect(monitor.snapshot().updates.widget?.checkError).toBeUndefined()
    expect(monitor.snapshot().updates.widget?.checkFailed).toBeUndefined()
    monitor.dispose()
  })

  it('keeps last-good data on complete failure without claiming a successful check', async () => {
    const { monitor, check } = setup()
    await monitor.check(true)
    const lastSuccessAt = monitor.snapshot().lastSuccessAt
    check.mockRejectedValue(new Error('offline'))
    await vi.advanceTimersByTimeAsync(1000)
    await monitor.check(true)
    expect(monitor.snapshot()).toMatchObject({ stale: true, checkedAt: 1_001_000, lastSuccessAt,
      updates: { widget: { ...available(), checkError: 'unavailable' } } })
    expect(monitor.snapshot().error).not.toBeNull()
    monitor.dispose()
  })

  it('marks source-input failure stale even when npm checks succeed', async () => {
    const { monitor, check } = setup()
    check.mockResolvedValue({ updates: { widget: available() }, error: 'catalog unavailable' })
    await monitor.check(true)
    expect(monitor.snapshot()).toMatchObject({ stale: true, error: 'catalog unavailable', lastSuccessAt: null })
    monitor.dispose()
  })

  it('prunes removed or replaced packages and refreshes notification preferences on reads', async () => {
    const { monitor, check, setPackages, setPreferences } = setup()
    await monitor.check(true)
    setPreferences({ updateExempt: ['widget'], disabled: ['other'], blocked: ['hidden'] })
    expect(monitor.snapshot()).toMatchObject({ updateExempt: ['widget'], disabled: ['other'], blocked: ['hidden'] })
    setPackages({ widget: 'github:other/source@1.0.0' })
    expect(monitor.snapshot()).toMatchObject({ updates: {}, stale: true })
    check.mockResolvedValue({ updates: { widget: unavailable } })
    await monitor.check(true)
    expect(monitor.snapshot().updates.widget?.updateAvailable).toBe(false)
    setPackages({})
    expect(monitor.snapshot().updates).toEqual({})
    monitor.dispose()
  })

  it('discards delayed results for a replaced source or release channel', async () => {
    const { monitor, check, setPackages, setContext } = setup()
    let resolve!: (value: { updates: Record<string, UpdateStatus> }) => void
    check.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const pending = monitor.check(true)
    await Promise.resolve()
    setPackages({ widget: 'github:replacement/source' })
    setContext('web:beta')
    resolve({ updates: { widget: available() } })
    await pending
    expect(monitor.snapshot()).toMatchObject({ stale: true, lastSuccessAt: null, updates: {} })
    monitor.dispose()
  })

  it('preserves the host-owned newer release without advertising market installation', async () => {
    const { monitor, check } = setup()
    check.mockResolvedValue({ updates: { widget: { ...available(), kind: 'generation', updateAvailable: false } } })
    await monitor.check(true)
    expect(monitor.snapshot().updates.widget).toEqual({ ...available(), kind: 'generation', updateAvailable: false })
    monitor.dispose()
  })

  it('allows manual checks while disabled and does not restart the automatic timer', async () => {
    const { monitor, check } = setup(false)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2)
    expect(check).not.toHaveBeenCalled()
    await monitor.check(true)
    expect(check).toHaveBeenCalledTimes(1)
    expect(monitor.snapshot().nextCheckAt).toBeNull()
    monitor.setEnabled(true)
    expect(monitor.snapshot().nextCheckAt).toBe(Date.now() + UPDATE_CHECK_START_DELAY_MS)
    monitor.setEnabled(false)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(check).toHaveBeenCalledTimes(1)
    monitor.dispose()
  })

  it('does not publish or reschedule a check that finishes after disposal', async () => {
    const { monitor, check } = setup()
    let resolve!: (value: { updates: Record<string, UpdateStatus> }) => void
    check.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const pending = monitor.check(true)
    await Promise.resolve()
    monitor.dispose()
    resolve({ updates: { widget: available() } })
    await pending
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2)
    expect(check).toHaveBeenCalledTimes(1)
    expect(monitor.snapshot()).toMatchObject({ checkedAt: null, nextCheckAt: null, updates: {} })
  })

  it('persists disabling across partial market-state writes and supports re-enabling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-notifications-'))
    try {
      expect(readMarketState(dir).backgroundUpdateChecks).toBeUndefined()
      writeMarketState(dir, { disabled: new Set(), groups: {}, groupOrder: [], backgroundUpdateChecks: false, backgroundUpdateIntervalHours: 72 })
      writeMarketState(dir, { disabled: new Set(['other']), groups: {}, groupOrder: [] })
      expect(readMarketState(dir).backgroundUpdateChecks).toBe(false)
      expect(readMarketState(dir).backgroundUpdateIntervalHours).toBe(72)
      writeMarketState(dir, { ...readMarketState(dir), backgroundUpdateChecks: true })
      expect(readMarketState(dir).backgroundUpdateChecks).toBe(true)
      expect(readMarketState(dir).backgroundUpdateIntervalHours).toBe(72)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it.each([null, 0, -1, 24, 6.5, 169, '6', [], {}, true])('ignores invalid saved intervals (%j) and keeps a legacy opt-in', intervalHours => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-notification-settings-'))
    try {
      mkdirSync(join(dir, '.dsh-market'))
      writeFileSync(join(dir, '.dsh-market/state.json'), JSON.stringify({ backgroundUpdateChecks: true, backgroundUpdateIntervalHours: intervalHours }))
      const state = readMarketState(dir)
      expect(state.backgroundUpdateChecks).toBe(true)
      expect(state.backgroundUpdateIntervalHours).toBeUndefined()
      const { monitor } = setup(state.backgroundUpdateChecks, state.backgroundUpdateIntervalHours)
      expect(monitor.snapshot()).toMatchObject({ enabled: true, intervalHours: 6 })
      monitor.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

})
