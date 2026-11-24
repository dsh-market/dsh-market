import { afterEach, describe, expect, it, vi } from 'vitest'
import { storedPageSize } from '../../src/client/MarketListControls.tsx'
import { PAGE_SIZE_KEY } from '../../src/client/market-constants.ts'

describe('storedPageSize', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const store = (value: string | null, throws = false) => vi.stubGlobal('localStorage', {
    getItem: () => { if (throws) throw new Error('blocked'); return value },
    setItem: () => {},
  })

  it('returns the size the reader chose last time', () => {
    store('96')
    expect(storedPageSize()).toBe(96)
  })
  it('falls back to 24 when nothing, or something unexpected, is stored', () => {
    store(null)
    expect(storedPageSize()).toBe(24)
    store('50')
    expect(storedPageSize()).toBe(24)
    store('abc')
    expect(storedPageSize()).toBe(24)
  })
  it('falls back to 24 when storage is unavailable', () => {
    store('96', true)
    expect(storedPageSize()).toBe(24)
  })
  it('uses its own key', () => {
    expect(PAGE_SIZE_KEY).toBe('dshm-page-size')
  })
})
