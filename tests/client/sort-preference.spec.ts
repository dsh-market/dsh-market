// @vitest-environment jsdom
/**
 * A list's order has to survive a reload (#1142).
 *
 * The request that reopened the issue was one sentence — pick `stars` once and
 * `downloads` is back next time — and what it describes is exactly one fact:
 * the choice lived in `useState` and nothing else. This file pins the storage
 * half (defaults, per-key fallback, merge across two clicks, a file this code
 * did not write); the wiring half is covered by the market's own specs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SORT_PREFERENCE_KEY,
  readInstalledSort,
  readSortChoice,
  rememberInstalledSort,
  rememberSortChoice,
} from '../../src/client/sort-preference.ts'

const DEFAULTS = { field: 'downloads', dir: 'desc' } as const

beforeEach(() => {
  localStorage.clear()
})

describe('a list order across a reload', () => {
  it('starts every list at the defaults when nothing was stored', () => {
    expect(readSortChoice('discover')).toEqual(DEFAULTS)
    expect(readSortChoice('themes')).toEqual(DEFAULTS)
    expect(readSortChoice('favorites')).toEqual(DEFAULTS)
    expect(readInstalledSort()).toBe('default')
  })

  it('keeps a chosen field', () => {
    rememberSortChoice('discover', { field: 'stars' })
    expect(readSortChoice('discover')).toEqual({ field: 'stars', dir: 'desc' })
  })

  it('keeps the field when the direction is chosen afterwards', () => {
    // The two clicks arrive as two calls; the second must not reset the first.
    rememberSortChoice('discover', { field: 'stars' })
    rememberSortChoice('discover', { dir: 'asc' })
    expect(readSortChoice('discover')).toEqual({ field: 'stars', dir: 'asc' })
  })

  it('keeps the direction when the field is chosen afterwards', () => {
    rememberSortChoice('themes', { field: 'added', dir: 'asc' })
    rememberSortChoice('themes', { field: 'stars' })
    expect(readSortChoice('themes')).toEqual({ field: 'stars', dir: 'asc' })
  })

  it('does not let one list overwrite another', () => {
    // One key holds all four, so a write has to merge rather than replace.
    rememberSortChoice('discover', { field: 'stars' })
    rememberSortChoice('themes', { field: 'added', dir: 'asc' })
    rememberSortChoice('favorites', { field: 'downloads', dir: 'asc' })
    rememberInstalledSort('oldest')
    expect(readSortChoice('discover')).toEqual({ field: 'stars', dir: 'desc' })
    expect(readSortChoice('themes')).toEqual({ field: 'added', dir: 'asc' })
    expect(readSortChoice('favorites')).toEqual({ field: 'downloads', dir: 'asc' })
    expect(readInstalledSort()).toBe('oldest')
  })

  it('round-trips every installed order', () => {
    for (const choice of ['name', 'newest', 'oldest', 'default'] as const) {
      rememberInstalledSort(choice)
      expect(readInstalledSort()).toBe(choice)
    }
  })
})

describe('a value this code did not write', () => {
  it('falls back per key, keeping the half that is still a known value', () => {
    // A hand-edited file is not a reason to lose a choice it does record.
    localStorage.setItem(SORT_PREFERENCE_KEY, JSON.stringify({ discover: { field: 'stars', dir: 'sideways' } }))
    expect(readSortChoice('discover')).toEqual({ field: 'stars', dir: 'desc' })
  })

  it('reads nothing from a field or direction that is not in the list', () => {
    localStorage.setItem(SORT_PREFERENCE_KEY, JSON.stringify({ discover: { field: 'popularity', dir: 'asc' } }))
    expect(readSortChoice('discover')).toEqual({ field: 'downloads', dir: 'asc' })
  })

  it('reads nothing from an installed order that is not in the list', () => {
    localStorage.setItem(SORT_PREFERENCE_KEY, JSON.stringify({ installed: 'recent' }))
    expect(readInstalledSort()).toBe('default')
  })

  it('survives a value that is not JSON at all, and repairs it on the next write', () => {
    localStorage.setItem(SORT_PREFERENCE_KEY, 'not-json')
    expect(readSortChoice('discover')).toEqual(DEFAULTS)
    rememberSortChoice('discover', { field: 'stars' })
    expect(JSON.parse(localStorage.getItem(SORT_PREFERENCE_KEY) ?? 'null')).toEqual({ discover: { field: 'stars', dir: 'desc' } })
  })

  it('survives an array where the object should be', () => {
    localStorage.setItem(SORT_PREFERENCE_KEY, JSON.stringify(['stars']))
    expect(readSortChoice('discover')).toEqual(DEFAULTS)
    expect(readInstalledSort()).toBe('default')
  })
})

describe('storage that refuses to write', () => {
  it('still returns the defaults instead of throwing', () => {
    // Private mode, or a full quota: the market must keep working, and the
    // order it already shows is just not remembered.
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => { rememberSortChoice('discover', { field: 'stars' }) }).not.toThrow()
    expect(() => { rememberInstalledSort('newest') }).not.toThrow()
    expect(readSortChoice('discover')).toEqual(DEFAULTS)
    setItem.mockRestore()
  })
})
