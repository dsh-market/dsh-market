// @vitest-environment jsdom
/**
 * The jsdom lane has to have a working `localStorage`.
 *
 * Node 26 publishes a `localStorage` accessor of its own, behind
 * `--localstorage-file`, and it wins over the window jsdom installs: without
 * the flag the spec sees `undefined`, so `localStorage.clear()` throws
 * `Cannot read properties of undefined` and 64 client specs fail on a machine
 * where nothing in the repo changed. `tests/setup/jsdom-storage.ts` puts
 * jsdom's own `Storage` back.
 *
 * Only `localStorage` needs that: `sessionStorage` and `StorageEvent` are
 * untouched by the shadowing, which is why this file asserts them separately
 * — a repair that broke either while fixing the other would otherwise pass.
 */
import { describe, expect, it } from 'vitest'

describe('the jsdom lane has a working localStorage', () => {
  it('is defined at all', () => {
    // The exact failure mode: `undefined`, and the first `setItem`/`clear` in
    // any client spec throwing `Cannot read properties of undefined`.
    expect(localStorage).toBeDefined()
  })

  it('reads and writes', () => {
    localStorage.setItem('market', 'yes')
    expect(localStorage.getItem('market')).toBe('yes')
    expect(localStorage.length).toBe(1)
    expect(localStorage.key(0)).toBe('market')
    localStorage.removeItem('market')
    expect(localStorage.length).toBe(0)
  })

  it('is the window storage, not a stand-in', () => {
    // The specs store values the app later reads through the same object; a
    // second implementation would satisfy the calls above and still be wrong.
    expect(localStorage).toBe((window as unknown as { localStorage: Storage }).localStorage)
    expect(localStorage).toBeInstanceOf(Storage)
  })

  it('keeps the sibling the shadowing never touched working', () => {
    sessionStorage.setItem('receipt', 'abc')
    expect(sessionStorage.getItem('receipt')).toBe('abc')
    sessionStorage.clear()
    expect(sessionStorage.length).toBe(0)
    expect(typeof StorageEvent).toBe('function')
  })
})