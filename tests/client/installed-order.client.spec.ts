// @vitest-environment jsdom
/**
 * The installed list's own order (#1142).
 *
 * Unit-level for the same reason as the queued-rows spec: the interesting
 * decision is a comparator's answer, and driving it through the rendered list
 * would only ever show the order that happened to win — the two directions
 * differ by one sign and look identical on screen.
 *
 * The rule these cases protect is that "unknown" never moves. A row with no
 * install time sits last whichever way the arrow points; flipping the sort
 * must not lift a package whose date nobody recorded above one whose date the
 * market wrote down.
 */
import { describe, expect, it } from 'vitest'
import { compareInstalledRows, installedDateText, type InstalledSort } from '../../src/client/market-data.ts'

const row = (name: string, installedAt?: string) => ({ name, installedAt })

function order(sort: InstalledSort, rows: { name: string; installedAt?: string }[]): string[] {
  return [...rows].sort((a, b) => compareInstalledRows(sort, a, b)).map(entry => entry.name)
}

describe('compareInstalledRows', () => {
  it('leaves the order alone in the default mode', () => {
    // The caller owns the meaningful part (running above switched off, #745);
    // this comparator must not have a second opinion about it.
    expect(order('default', [row('b', '2026-01-01T00:00:00Z'), row('a', '2026-02-01T00:00:00Z')])).toEqual(['b', 'a'])
  })

  it('sorts by name', () => {
    expect(order('name', [row('dsh-zeta'), row('dsh-alpha'), row('dsh-beta')])).toEqual(['dsh-alpha', 'dsh-beta', 'dsh-zeta'])
  })

  it('sorts newest first', () => {
    const rows = [row('old', '2026-01-01T00:00:00Z'), row('new', '2026-06-01T00:00:00Z'), row('mid', '2026-03-01T00:00:00Z')]
    expect(order('newest', rows)).toEqual(['new', 'mid', 'old'])
  })

  it('sorts oldest first', () => {
    const rows = [row('old', '2026-01-01T00:00:00Z'), row('new', '2026-06-01T00:00:00Z'), row('mid', '2026-03-01T00:00:00Z')]
    expect(order('oldest', rows)).toEqual(['old', 'mid', 'new'])
  })

  it('puts the undated row last in both directions', () => {
    const rows = [row('unknown'), row('dated-old', '2026-01-01T00:00:00Z'), row('dated-new', '2026-06-01T00:00:00Z')]
    expect(order('newest', rows)).toEqual(['dated-new', 'dated-old', 'unknown'])
    expect(order('oldest', rows)).toEqual(['dated-old', 'dated-new', 'unknown'])
  })

  it('puts every undated row last, by name among themselves', () => {
    const rows = [row('zzz'), row('dated', '2026-01-01T00:00:00Z'), row('aaa')]
    expect(order('newest', rows)).toEqual(['dated', 'aaa', 'zzz'])
  })

  it('breaks a tie on the name so the order does not depend on the input', () => {
    const same = '2026-05-05T00:00:00Z'
    expect(order('newest', [row('b', same), row('a', same)])).toEqual(['a', 'b'])
    expect(order('oldest', [row('b', same), row('a', same)])).toEqual(['a', 'b'])
  })

  it('treats an unparseable stamp as unknown rather than as date zero', () => {
    // `Date.parse('yesterday')` is NaN; comparing NaN against a number is
    // false in both directions, which is how a junk value ends up interleaved
    // with real dates instead of last.
    const rows = [row('junk', 'yesterday'), row('dated', '2026-01-01T00:00:00Z')]
    expect(order('newest', rows)).toEqual(['dated', 'junk'])
    expect(order('oldest', rows)).toEqual(['dated', 'junk'])
  })
})

describe('installedDateText', () => {
  it('shows the date in the reader timezone, not the UTC one', () => {
    // Built from local parts on purpose: the row has to read as the day the
    // user installed it, and a late-evening install is a different date in
    // UTC for half the world.
    const local = new Date(2026, 10, 12, 23, 30)
    expect(installedDateText(local.toISOString())).toBe('2026-11-12')
  })

  it('returns nothing when the market has no stamp', () => {
    expect(installedDateText(undefined)).toBeNull()
    expect(installedDateText('not a date')).toBeNull()
  })
})
