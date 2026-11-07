import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUpdateNotificationMonitor, UPDATE_CHECK_INTERVAL_MS, UPDATE_CHECK_START_DELAY_MS } from '../src/update-notifications.ts'
import { readMarketState, writeMarketState } from '../src/hot.ts'
import type { UpdateStatus } from '../src/updates.ts'

const available = (version = '1.0.0', latest = '2.0.0'): UpdateStatus => ({ kind: 'npm', version, current: version, latest, updateAvailable: true })
const unavailable: UpdateStatus = { kind: 'npm', version: '1.0.0', current: null, latest: null, updateAvailable: false, checkError: 'unavailable' }

function setup(enabled = true) {
  let context = 'web:stable'
  let packages: Record<string, string> = { widget: 'npm:widget@1.0.0' }
  let preferences = { updateExempt: [] as string[], disabled: [] as string[], blocked: [] as string[] }
  const check = vi.fn(async (_force: boolean): Promise<{ updates: Record<string, UpdateStatus>; error?: string }> => ({ updates: { widget: available() } }))
  const monitor = createUpdateNotificationMonitor({
    boot: 'boot-a', enabled, inventory: () => ({ context, packages }),
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

  it('retains confirmed package results on partial failures and backs off', async () => {
    const { monitor, check, setPackages } = setup()
    setPackages({ widget: 'npm:widget@1.0.0', other: 'npm:other@1.0.0' })
    check.mockResolvedValueOnce({ updates: { widget: available(), other: available() } })
    await monitor.check(true)
    const lastSuccessAt = monitor.snapshot().lastSuccessAt
    check.mockResolvedValue({ updates: { widget: unavailable, other: available('1.0.0', '3.0.0') } })
    await vi.advanceTimersByTimeAsync(1000)
    await monitor.check(true)
    expect(monitor.snapshot()).toMatchObject({ stale: true, lastSuccessAt, nextCheckAt: 1_061_000,
      updates: { widget: { ...available(), checkError: 'unavailable' }, other: available('1.0.0', '3.0.0') } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(monitor.snapshot().nextCheckAt).toBe(1_181_000)
    expect(check).toHaveBeenLastCalledWith(true)
    check.mockResolvedValue({ updates: { widget: { ...available(), updateAvailable: false, latest: '1.0.0' }, other: available() } })
    await monitor.check(true)
    expect(monitor.snapshot()).toMatchObject({ stale: false, error: null, updates: { widget: { updateAvailable: false } } })
    expect(monitor.snapshot().updates.widget?.checkError).toBeUndefined()
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
      writeMarketState(dir, { disabled: new Set(), groups: {}, groupOrder: [], backgroundUpdateChecks: false })
      writeMarketState(dir, { disabled: new Set(['other']), groups: {}, groupOrder: [] })
      expect(readMarketState(dir).backgroundUpdateChecks).toBe(false)
      writeMarketState(dir, { ...readMarketState(dir), backgroundUpdateChecks: true })
      expect(readMarketState(dir).backgroundUpdateChecks).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
