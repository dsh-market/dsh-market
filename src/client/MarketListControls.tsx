/**
 * List chrome shared by the Discover / Favorites / Themes / Installed tabs: pagination hooks, filter and sort menus, pager, load-more and empty-result rows.
 */

import { useMemo, useState } from 'react'
import { Button, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  SORT_DIR_OPTIONS,
  SORT_FIELD_OPTIONS,
  TIME_OPTIONS,
} from './market-constants.ts'
import {
  type InstalledSort,
  pageItems,
  type SortDir,
  type SortField,
  type TimeRange,
  type Translate,
} from './market-data.ts'
import {
  IconChevronDownOutline14,
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconChevronUpOutline14,
} from './icons.ts'
import css from './Market.module.css'

/** Reset before effects can use the new query with the previous page or limit. */
function useResettableCount(initial: number, deps: readonly unknown[]) {
  const [count, setCount] = useState(initial)
  const [previousDeps, setPreviousDeps] = useState(deps)
  if (deps.length !== previousDeps.length || deps.some((value, index) => !Object.is(value, previousDeps[index]))) {
    setPreviousDeps(deps)
    setCount(initial)
  }
  return [count, setCount] as const
}

/**
 * Page/page-size state shared by every paged list in this file (Discover,
 * Themes) — each caller owns its OWN instance (their filters are
 * independent, a search in one tab has no business resetting the other's
 * page), but the mechanics (clamp against a shrinking list, reset to page 1
 * when the filters that produced `count` change, scroll back to the top of
 * the shared body on any page move) are one implementation, not two.
 */
export function usePagination(count: number, resetDeps: readonly unknown[], scrollToTop: () => void): {
  currentPage: number
  totalPages: number
  pageSize: number
  goToPage: (next: number) => void
  changePageSize: (size: number) => void
} {
  const [page, setPage] = useResettableCount(1, resetDeps)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const totalPages = Math.max(1, Math.ceil(count / pageSize))
  // Clamp in case the list shrank while the user was on a later page.
  const currentPage = Math.min(page, totalPages)
  const goToPage = (next: number) => {
    setPage(Math.max(1, Math.min(next, totalPages)))
    scrollToTop()
  }
  const changePageSize = (size: number) => {
    setPageSize(size)
    setPage(1)
    scrollToTop()
  }
  return { currentPage, totalPages, pageSize, goToPage, changePageSize }
}

/**
 * A growing window for the Plugins page tab.
 *
 * The catalog is already in memory; the page number existed to cap the DOM.
 * On a page that scrolls with the host, turning the page jumps back to the
 * top. Appending a chunk leaves the reader where they are. A filter change
 * starts over, the same moment `usePagination` returns to page 1.
 */
export function useShownCount(count: number, resetDeps: readonly unknown[], chunk: number): {
  shown: number
  more: number
  loadMore: () => void
} {
  const [limit, setLimit] = useResettableCount(chunk, resetDeps)
  const shown = Math.min(count, limit)
  return {
    shown,
    more: Math.max(0, count - shown),
    loadMore: () => { setLimit(current => current + chunk) },
  }
}

/**
 * The sort/time-range dropdown (primitives Menu): three independent option
 * groups, ids namespaced so one onSelect routes by prefix. Owns its own
 * open state — a caller wires only the sort VALUES, not the dropdown's UI
 * state, so Discover and Themes can each mount one without threading an
 * extra `filterOpen`/`setFilterOpen` pair through their own state.
 */
export function FilterMenu({
  sortField, sortDir, timeRange, hostVersion, compatibleWithHost,
  onSortField, onSortDir, onTimeRange, onCompatibleWithHost, t,
}: {
  sortField: SortField
  sortDir: SortDir
  timeRange: TimeRange
  hostVersion?: string | null
  compatibleWithHost?: boolean
  onSortField: (field: SortField) => void
  onSortDir: (dir: SortDir) => void
  onTimeRange: (range: TimeRange) => void
  onCompatibleWithHost?: (enabled: boolean) => void
  t: Translate
}) {
  const [open, setOpen] = useState(false)
  // Direction labels adapt to the field: stars → asc/desc, added → oldest/newest.
  const sortDirLabel = (dir: SortDir): string =>
    sortField === 'added'
      ? dir === 'desc' ? 'sortNewest' : 'sortOldest'
      : dir === 'desc' ? 'sortDesc' : 'sortAsc'
  const items = useMemo<MenuEntry[]>(() => [
    { type: 'label', id: 'f-sort', text: t('filterSort') },
    ...SORT_FIELD_OPTIONS.map(opt => ({ id: 'field:' + opt.key, label: t(opt.label) })),
    { type: 'separator', id: 'f-sep1' },
    { type: 'label', id: 'f-dir', text: t('filterDir') },
    ...SORT_DIR_OPTIONS.map(dir => ({ id: 'dir:' + dir, label: t(sortDirLabel(dir)) })),
    { type: 'separator', id: 'f-sep2' },
    { type: 'label', id: 'f-time', text: t('filterTime') },
    ...TIME_OPTIONS.map(opt => ({ id: 'time:' + opt.key, label: t(opt.label) })),
    ...(onCompatibleWithHost === undefined ? [] : [
      { type: 'separator' as const, id: 'f-sep3' },
      { type: 'label' as const, id: 'f-host', text: t('filterHost') },
      { id: 'host:all', label: t('hostAll') },
      {
        id: 'host:compatible',
        label: hostVersion === undefined
          ? t('hostDetecting')
          : hostVersion === null
            ? t('hostUnknown')
            : t('hostCompatible').replace('{0}', hostVersion),
      },
    ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sortDirLabel closes only over sortField, already a dep.
  ], [t, sortField, hostVersion, onCompatibleWithHost])
  const selectedIds = useMemo(
    () => [
      'field:' + sortField,
      'dir:' + sortDir,
      'time:' + timeRange,
      ...(onCompatibleWithHost === undefined
        ? []
        : [compatibleWithHost === true ? 'host:compatible' : 'host:all']),
    ],
    [sortField, sortDir, timeRange, compatibleWithHost, onCompatibleWithHost])
  const onSelect = (id: string) => {
    if (id.startsWith('field:')) onSortField(id.slice(6) as SortField)
    else if (id.startsWith('dir:')) onSortDir(id.slice(4) as SortDir)
    else if (id.startsWith('time:')) onTimeRange(id.slice(5) as TimeRange)
    else if (id === 'host:all') onCompatibleWithHost?.(false)
    else if (id === 'host:compatible' && typeof hostVersion === 'string') onCompatibleWithHost?.(true)
  }
  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      onSelect={onSelect}
      selectedIds={selectedIds}
      align="end"
      portal
      anchor={(
        <Button
          variant="outline"
          size="sm"
          icon={open ? <IconChevronUpOutline14 size={14} /> : <IconChevronDownOutline14 size={14} />}
          onClick={() => setOpen(o => !o)}
        >{t('filter')}</Button>
      )}
      items={items}
    />
  )
}

/**
 * The installed list's own order (#1142).
 *
 * Deliberately NOT the market's `FilterMenu`: that one sorts by downloads,
 * stars or the catalog's collection date, and an installed package has none
 * of the three. Same primitive, four options, one value — the list's order
 * is a single choice, not a field plus a direction.
 */
export function InstalledSortMenu({ value, onChange, t }: { value: InstalledSort; onChange: (sort: InstalledSort) => void; t: Translate }) {
  const [open, setOpen] = useState(false)
  const items = useMemo<MenuEntry[]>(() => [
    { type: 'label', id: 'is-label', text: t('installedSortLabel') },
    { id: 'installed:default', label: t('installedSortDefault') },
    { id: 'installed:name', label: t('installedSortName') },
    { id: 'installed:newest', label: t('installedSortNewest') },
    { id: 'installed:oldest', label: t('installedSortOldest') },
  ], [t])
  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      selectedIds={['installed:' + value]}
      onSelect={id => onChange(id.slice('installed:'.length) as InstalledSort)}
      align="end"
      portal
      anchor={(
        <Button
          variant="outline"
          size="sm"
          icon={open ? <IconChevronUpOutline14 size={14} /> : <IconChevronDownOutline14 size={14} />}
          onClick={() => setOpen(openNow => !openNow)}
        >{t('installedSort')}</Button>
      )}
      items={items}
    />
  )
}

/** Keep an empty search actionable without changing the user's sort or block list. */
export function EmptyResults({ message, onClear, t }: {
  message: 'empty' | 'blockedFilteredEmpty' | 'hostFilterEmpty'
  onClear?: () => void
  t: Translate
}) {
  return <div className={css.empty}>
    <div>{t(message)}</div>
    {onClear && <Button variant="outline" size="sm" className={css.retryBtn} onClick={onClear}>
      {t('clearFilters')}
    </Button>}
  </div>
}

/** Prev/numbered/next controls plus a per-page-size menu — one
 * implementation for every paged list, driven entirely by `usePagination`'s
 * return value. Owns its own page-size dropdown open state for the same
 * reason `FilterMenu` owns its own.
 *
 * Layout: the numbered cluster (`.pagerPages`) centers in the row and the
 * page-info + page-size menu (`.pagerMeta`) sit on the right, all on ONE
 * line. The host settings dialog gives this row ~556px (800px panel − 188px
 * section nav − 48px options padding − 8px body padding), which fits only a
 * compact pager: `pageItems` caps the numbered window (its 1 and N are
 * always present, so skipping to either end stays one click away) and
 * `.pager`/`.pagerPages` are nowrap with tight paddings — a wrapping pager
 * reads as broken here. */
/** Plugins tab: one more chunk, in place. Settings and the sidebar keep Pager. */
export function LoadMore({ more, onLoad, t }: { more: number; onLoad: () => void; t: Translate }) {
  if (more <= 0) return null
  return (
    <div className={css.loadMore}>
      <Button variant="outline" size="sm" onClick={onLoad}>{t('loadMore')}</Button>
    </div>
  )
}

export function Pager({ currentPage, totalPages, pageSize, onGoToPage, onChangePageSize, t }: {
  currentPage: number
  totalPages: number
  pageSize: number
  onGoToPage: (page: number) => void
  onChangePageSize: (size: number) => void
  t: Translate
}) {
  const [sizeOpen, setSizeOpen] = useState(false)
  return (
    <div className={css.pager}>
      <div className={css.pagerPages}>
        {totalPages > 1 && (
          <>
            <Button
              variant="outline"
              size="sm"
              icon={<IconChevronLeftOutline14 size={14} />}
              disabled={currentPage === 1}
              onClick={() => onGoToPage(currentPage - 1)}
            >{t('prevPage')}</Button>
            {pageItems(currentPage, totalPages).map((item, i) => (
              item === '…'
                ? <span key={'e' + i} className={css.pageEllipsis}>…</span>
                : (
                    <Button
                      key={item}
                      variant={item === currentPage ? 'primary' : 'outline'}
                      size="sm"
                      onClick={() => onGoToPage(item)}
                    >{item}</Button>
                  )
            ))}
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage === totalPages}
              onClick={() => onGoToPage(currentPage + 1)}
            >{t('nextPage')}<IconChevronRightOutline14 size={14} /></Button>
          </>
        )}
      </div>
      <div className={css.pagerMeta}>
        {totalPages > 1 && <span className={css.pageInfo}>{t('pageInfo').replace('{0}', String(currentPage)).replace('{1}', String(totalPages))}</span>}
        <Menu
          open={sizeOpen}
          onClose={() => setSizeOpen(false)}
          onSelect={id => {
            onChangePageSize(Number(id))
            // primitives Menu does not close itself on select (FilterMenu
            // stays open on purpose for multi-pick). Page size is one shot;
            // leaving it open after scrollToTop parks the panel mid-list.
            setSizeOpen(false)
          }}
          selectedId={String(pageSize)}
          align="end"
          portal
          anchor={(
            <Button
              variant="outline"
              size="sm"
              icon={<IconChevronDownOutline14 size={14} />}
              onClick={() => setSizeOpen(o => !o)}
            >{t('perPage') + ' ' + pageSize}</Button>
          )}
          items={PAGE_SIZES.map(size => ({ id: String(size), label: String(size) }))}
        />
      </div>
    </div>
  )
}
