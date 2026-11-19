/**
 * Timing budgets, storage keys, page sizes and sort/time option lists used across the Market section.
 */

import type { SortDir, SortField, TimeRange } from './market-data.ts'

/** After this long without a structured phase, the install line adds a note that waiting is normal (#1011). */
export const SLOW_INSTALL_SECONDS = 90
/** How long the page keeps asking for a market DSH unloaded, and how long one ask may take (#1151). */
export const RECONNECT_BUDGET_MS = 90_000
export const RECONNECT_REQUEST_MS = 4000
export const UPDATE_CHECK_REQUEST_MS = 30_000
export const IGNORED_UPDATES_SESSION_KEY = 'dshm-updates-ignored'

/** Discover grid page-size choices — the catalog grows daily, so cap each page. */
export const PAGE_SIZES = [24, 48, 96]
export const DEFAULT_PAGE_SIZE = 24
export const WEBDAV_STORAGE_KEY = 'dshm-webdav'

/** Same cap as `MAX_NOTE` in hot.ts; the server trims anything longer. */
export const NOTE_MAX = 200

/** Sort field choices in the filter panel. */
export const SORT_FIELD_OPTIONS: ReadonlyArray<{ key: SortField; label: string }> = [
  { key: 'downloads', label: 'sortDownloads' },
  { key: 'stars', label: 'sortStars' },
  { key: 'added', label: 'sortAdded' },
]

/** Sort direction choices in the filter panel (labels depend on the field). */
export const SORT_DIR_OPTIONS: ReadonlyArray<SortDir> = ['desc', 'asc']

/** Published-within choices in the filter panel. */
export const TIME_OPTIONS: ReadonlyArray<{ key: TimeRange; label: string }> = [
  { key: 'all', label: 'timeAll' },
  { key: 'day', label: 'timeDay' },
  { key: 'week', label: 'timeWeek' },
  { key: 'month', label: 'timeMonth' },
  { key: 'quarter', label: 'timeQuarter' },
  { key: 'year', label: 'timeYear' },
]

/**
 * 最近收录 display preferences: collapsed / hidden (#940).
 *
 * The block only appears on the discover tab with an empty search and both
 * filters on "all", so it cannot be avoided without changing what the user is
 * looking at. It is a one-row teaser, not a second catalog. Both states
 * are display preferences, not profile settings: since 0.1.7 the settings
 * surface is deliberately just `allowRestart`.
 *
 * When localStorage is unavailable, the preference falls
 * back to the default, and the default is "expanded and shown".
 */
export const RECENT_COLLAPSED_KEY = 'dshm-recent-collapsed'
export const RECENT_HIDDEN_KEY = 'dshm-recent-hidden'
/** Cap for the Discover teaser. Extra tiles live in a quiet horizontal
 * scroll so the block stays one row tall. */
export const RECENT_STRIP_LIMIT = 8

/** "不再提示" on the settings-page sidebar tip. A missing store means show it. */
export const SIDEBAR_TIP_KEY = 'dshm-sidebar-tip-dismissed'
