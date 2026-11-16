/**
 * The sort choice of each list that has a sort control (#1142).
 *
 * Before this module, every list — the catalog, Themes, Favorites, and the
 * installed list — opened at its default order and kept the user's pick only
 * in React state: switching tabs rebuilt the component, and a reload threw the
 * choice away. The report that reopened #1142 is the visible half of that
 * (`stars` today, `downloads` tomorrow); the other three lists had the same
 * hole.
 *
 * These are DISPLAY preferences, not profile settings — the same contract as
 * the catalog's compatibility filter (`dshm-host-filter`) and the "recently
 * added" block's collapsed/hidden flags (#940). `state.json` holds what the market
 * itself has to know (install times, notes, favorites, broken declarations);
 * an ordering only means something to this browser, and putting it in that file
 * would make every unrelated save a way to reset it (the shape #1186 fixed in
 * `installTimes`). When localStorage is unavailable the default order is
 * returned and the choice simply does not survive a reload — the same fallback
 * the two precedents use.
 *
 * One key, not four: a single object means a write of one list cannot drop
 * another's choice, and reading the file once answers every list on mount.
 */

import type { InstalledSort, SortDir, SortField } from './market-data.ts'

/** The lists whose order is a field-plus-direction choice. */
export type SortList = 'discover' | 'themes' | 'favorites'

export interface SortChoice {
  field: SortField
  dir: SortDir
}

/** The one key all four lists share; exported for the specs' assertions. */
export const SORT_PREFERENCE_KEY = 'dshm-sort-v1'

const DEFAULT_CHOICE: SortChoice = { field: 'downloads', dir: 'desc' }

const FIELDS: readonly SortField[] = ['downloads', 'stars', 'added']
const DIRS: readonly SortDir[] = ['desc', 'asc']
const INSTALLED_SORTS: readonly InstalledSort[] = ['default', 'name', 'newest', 'oldest']

/** Whatever is in storage, as an object; anything unreadable reads as empty. */
function readStored(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SORT_PREFERENCE_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    // Unavailable storage, or a hand-edited value that is not JSON: the
    // defaults are a valid answer, and the next write replaces the key.
    return {}
  }
}

/**
 * One list's stored choice, key by key.
 *
 * A half-written entry (`field` but no `dir`, or the reverse) keeps the part
 * that is still a known value and fills the rest from the default: falling back
 * on the whole object would discard a choice the file does record.
 */
function choiceFrom(value: unknown): SortChoice {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_CHOICE
  const record = value as { field?: unknown; dir?: unknown }
  const field = typeof record.field === 'string' ? FIELDS.find(known => known === record.field) : undefined
  const dir = typeof record.dir === 'string' ? DIRS.find(known => known === record.dir) : undefined
  return { field: field ?? DEFAULT_CHOICE.field, dir: dir ?? DEFAULT_CHOICE.dir }
}

/** Replace one entry, leaving every other list's choice where it was. */
function writeStored(list: SortList | 'installed', value: unknown): void {
  try {
    localStorage.setItem(SORT_PREFERENCE_KEY, JSON.stringify({ ...readStored(), [list]: value }))
  } catch {
    // Private mode or a full quota: the order still applies to this session,
    // it just will not be there next time.
  }
}

export function readSortChoice(list: SortList): SortChoice {
  return choiceFrom(readStored()[list])
}

/**
 * Save `patch` on top of the stored choice. The merge base is the file, not
 * the caller's React state: a field click and a direction click arrive as two
 * separate calls, and each one has to keep the other half.
 */
export function rememberSortChoice(list: SortList, patch: Partial<SortChoice>): void {
  const current = readSortChoice(list)
  writeStored(list, { field: patch.field ?? current.field, dir: patch.dir ?? current.dir })
}

export function readInstalledSort(): InstalledSort {
  const value = readStored().installed
  return typeof value === 'string'
    ? INSTALLED_SORTS.find(known => known === value) ?? 'default'
    : 'default'
}

export function rememberInstalledSort(value: InstalledSort): void {
  writeStored('installed', value)
}
