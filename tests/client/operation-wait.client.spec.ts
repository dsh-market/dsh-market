// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  operationWaitKey, readOperationWait, saveOperationWait, subscribeOperationWait,
} from '../../src/client/operation-wait.ts'

function createStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear() { values.clear() },
    getItem(key) { return values.get(String(key)) ?? null },
    key(index) { return Array.from(values.keys())[index] ?? null },
    removeItem(key) { values.delete(String(key)) },
    setItem(key, value) { values.set(String(key), String(value)) },
  }
}

describe('operation wait preference', () => {
  let storage: Storage
  let base: HTMLBaseElement
  let unsubscribers: Array<() => void>

  function subscribe(listener: () => void): () => void {
    const unsubscribe = subscribeOperationWait(listener)
    unsubscribers.push(unsubscribe)
    return unsubscribe
  }

  beforeEach(() => {
    storage = createStorage()
    vi.stubGlobal('localStorage', storage)
    base = document.createElement('base')
    base.href = 'https://example.test/'
    document.head.prepend(base)
    unsubscribers = []
  })

  afterEach(() => {
    unsubscribers.forEach(unsubscribe => unsubscribe())
    base.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('defaults to wait when no preference exists', () => {
    expect(storage.getItem(operationWaitKey())).toBeNull()
    expect(readOperationWait()).toBe('wait')
  })

  it.each(['', 'ASK', 'ask ', 'null', 'undefined', 'true'])('defaults to wait for invalid stored value %j', value => {
    storage.setItem(operationWaitKey(), value)
    expect(readOperationWait()).toBe('wait')
  })

  it('persists ask and reads it after the module is reloaded', async () => {
    saveOperationWait('ask')
    expect(storage.getItem(operationWaitKey())).toBe('ask')

    vi.resetModules()
    const reloaded = await import('../../src/client/operation-wait.ts')
    expect(reloaded.readOperationWait()).toBe('ask')
  })

  it('isolates preferences between mount paths on the same origin', () => {
    base.href = 'https://example.test/first/'
    expect(operationWaitKey()).toBe('dshm-operation-wait:/first/dsh-market')
    saveOperationWait('ask')

    base.href = 'https://example.test/second/'
    expect(operationWaitKey()).toBe('dshm-operation-wait:/second/dsh-market')
    expect(readOperationWait()).toBe('wait')
    saveOperationWait('wait')

    base.href = 'https://example.test/first/'
    expect(readOperationWait()).toBe('ask')
    expect(storage.getItem('dshm-operation-wait:/second/dsh-market')).toBe('wait')
  })

  it('defaults to wait when accessing localStorage throws', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('Storage is unavailable', 'SecurityError') },
    })
    expect(readOperationWait()).toBe('wait')
  })

  it('defaults to wait when reading from storage throws', () => {
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage is unavailable', 'SecurityError')
    })
    expect(readOperationWait()).toBe('wait')
  })

  it('propagates quota errors without changing the stored value or notifying subscribers', () => {
    storage.setItem(operationWaitKey(), 'wait')
    const listener = vi.fn()
    subscribe(listener)
    const error = new DOMException('Storage quota exceeded', 'QuotaExceededError')
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw error })

    expect(() => saveOperationWait('ask')).toThrow(error)
    expect(storage.getItem(operationWaitKey())).toBe('wait')
    expect(listener).not.toHaveBeenCalled()
  })

  it('notifies same-window subscribers after each successful save', () => {
    const observed: string[] = []
    subscribe(() => observed.push(readOperationWait()))

    saveOperationWait('ask')
    expect(observed).toEqual(['ask'])
    saveOperationWait('wait')
    expect(observed).toEqual(['ask', 'wait'])
  })

  it('notifies subscribers on storage events and removes only the unsubscribed listener', () => {
    const first = vi.fn(() => readOperationWait())
    const second = vi.fn(() => readOperationWait())
    const unsubscribeFirst = subscribe(first)
    const unsubscribeSecond = subscribe(second)
    const key = operationWaitKey()

    storage.setItem(key, 'ask')
    window.dispatchEvent(new StorageEvent('storage', { key, oldValue: null, newValue: 'ask' }))
    expect(first).toHaveReturnedWith('ask')
    expect(second).toHaveReturnedWith('ask')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    unsubscribeFirst()
    saveOperationWait('wait')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
    expect(second).toHaveLastReturnedWith('wait')

    storage.setItem(key, 'ask')
    window.dispatchEvent(new StorageEvent('storage', { key, oldValue: 'wait', newValue: 'ask' }))
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(3)
    expect(second).toHaveLastReturnedWith('ask')

    unsubscribeSecond()
    saveOperationWait('wait')
    window.dispatchEvent(new StorageEvent('storage', { key }))
    expect(second).toHaveBeenCalledTimes(3)
  })
})
