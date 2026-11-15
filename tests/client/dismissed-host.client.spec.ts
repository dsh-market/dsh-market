// @vitest-environment jsdom
/**
 * "Clear settled" has to survive a reload (#1184).
 *
 * Unit-level on purpose: the row itself is a projection of the host's
 * `/status` answer, so driving this through the market's DOM would test the
 * stubbed poll more than the decision. What the bug was about is exactly one
 * fact — the set of cleared ids lived in a `useRef` and vanished with the
 * mount — and that is what these cases pin.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DISMISSED_HOST_LIMIT, DISMISSED_HOST_STORAGE_KEY,
  dismissedHostIdSet, rememberDismissedHostId, resetDismissedHostCache,
} from '../../src/client/dismissed-host.ts'

/** A reload: the cache goes, storage stays. */
function reload(): Set<string> {
  resetDismissedHostCache()
  return dismissedHostIdSet()
}

beforeEach(() => {
  localStorage.clear()
  resetDismissedHostCache()
})

describe('cleared host rows', () => {
  it('keeps a cleared id across a reload', () => {
    rememberDismissedHostId('op-1')
    expect([...reload()]).toEqual(['op-1'])
  })

  it('keeps several ids in the order they were cleared', () => {
    rememberDismissedHostId('op-1')
    rememberDismissedHostId('op-2')
    expect([...reload()]).toEqual(['op-1', 'op-2'])
  })

  it('does not grow for a row cleared twice', () => {
    rememberDismissedHostId('op-1')
    rememberDismissedHostId('op-1')
    expect([...reload()]).toEqual(['op-1'])
  })

  it('ignores an empty id instead of storing a row no host will report', () => {
    rememberDismissedHostId('')
    expect(reload().size).toBe(0)
    expect(localStorage.getItem(DISMISSED_HOST_STORAGE_KEY)).toBeNull()
  })

  it('drops the oldest ids once the cap is reached', () => {
    for (let index = 0; index <= DISMISSED_HOST_LIMIT; index += 1) rememberDismissedHostId(`op-${String(index)}`)
    const ids = [...reload()]
    expect(ids).toHaveLength(DISMISSED_HOST_LIMIT)
    expect(ids).not.toContain('op-0')
    expect(ids.at(-1)).toBe(`op-${String(DISMISSED_HOST_LIMIT)}`)
  })

  it('reads nothing from a key this code did not write', () => {
    localStorage.setItem(DISMISSED_HOST_STORAGE_KEY, 'not json at all')
    expect(reload().size).toBe(0)
  })

  it('keeps only strings from a hand-edited array', () => {
    localStorage.setItem(DISMISSED_HOST_STORAGE_KEY, JSON.stringify(['op-1', 42, null, '', 'op-1', { id: 'op-2' }]))
    expect([...reload()]).toEqual(['op-1'])
  })

  it('stays usable when storage refuses to answer', () => {
    // Private mode and a full quota both throw here. The page still has to
    // hide the row for this mount — that is what it did before the fix.
    const get = Object.getOwnPropertyDescriptor(Storage.prototype, 'getItem')
    const set = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')
    Object.defineProperty(Storage.prototype, 'getItem', { configurable: true, value: () => { throw new Error('denied') } })
    Object.defineProperty(Storage.prototype, 'setItem', { configurable: true, value: () => { throw new Error('denied') } })
    try {
      expect(reload().size).toBe(0)
      expect(() => { rememberDismissedHostId('op-1') }).not.toThrow()
      expect([...dismissedHostIdSet()]).toEqual(['op-1'])
    } finally {
      if (get !== undefined) Object.defineProperty(Storage.prototype, 'getItem', get)
      if (set !== undefined) Object.defineProperty(Storage.prototype, 'setItem', set)
    }
  })
})
