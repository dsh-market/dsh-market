/**
 * Market lists and install: the derived Discover/Favorites/Themes lists with pagination, file download and the install flow.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  type ActivationInfo,
  api,
  blockAliases,
  catalogEntryForInstalled,
  type DrainOperationWire,
  failureText,
  hostCompatibilityKey,
  matchInstalledName,
  pluginCategories,
  pluginsForFavorites,
  type RegistryPlugin,
  staleFavoriteUrls,
  TIME_RANGE_DAYS,
  visiblePlugins,
} from './market-data.ts'
import { drop, enqueue, type OperationRecord, patch as patchRecord } from './operations.ts'
import { blockedSessions, readRecentFlag, withoutHostProjection, writeRecentFlag } from './market-helpers.ts'
import { withSponsoredFirst } from './sponsored-plugins.ts'
import { DEFAULT_PAGE_SIZE, RECENT_COLLAPSED_KEY, RECENT_HIDDEN_KEY, RECENT_STRIP_LIMIT } from './market-constants.ts'
import { usePagination, useShownCount } from './MarketListControls.tsx'
import { discoveryScan } from './MarketImages.tsx'
import type { CompatibilityNotice, ConflictNotice, MarketSectionProps } from './market-types.ts'
import type { MarketStateCtx } from './market-state.tsx'
import type { MarketSyncCtx } from './market-sync.ts'

type MarketInstallIn = { props: MarketSectionProps }
  & Pick<MarketStateCtx,
    'blockedNames' | 'cat' | 'source' | 'compatibilityDemandOwner' | 'compatibleWithHost' | 'data' |
    'favSortDir' | 'favSortField' | 'favTimeRange' | 'favoriteUrls' | 'hostCompatibility' |
    'installed' | 'lang' | 'marketGone' | 'nextRecordId' | 'q' | 'qFavorites' | 'qThemes' |
    'refreshInstalled' | 'repoHints' | 'repoIdentities' | 'setActivationWarnings' | 'setActivations' |
    'setBuildsSkipped' | 'setBusyUrl' | 'setCompatibilityNotice' | 'setConfirming' | 'setDoneUrls' |
    'setHostIncompatible' | 'setHotNames' | 'setHotUrls' | 'setInstallError' | 'setMigrationConfirm' |
    'setOperationsOpen' | 'setRecords' | 'setReplacing' | 'setRollingBack' | 'sortDir' | 'sortField' |
    'statusRef' | 'surface' | 't' | 'tab' | 'themeSortDir' | 'themeSortField' | 'themeTimeRange' |
    'timeRange'>
  & Pick<MarketSyncCtx,
    'blockedNameSet' | 'favoriteUrlSet' | 'rememberDrainMarker' | 'scrollToTop'>

/** derived lists and pagination, download and install. */
export function useMarketInstall(c: MarketInstallIn) {
  const {
    blockedNameSet, blockedNames, cat, source, compatibilityDemandOwner, compatibleWithHost, data,
    favSortDir, favSortField, favTimeRange, favoriteUrlSet, favoriteUrls, hostCompatibility,
    installed, lang, marketGone, nextRecordId, q, qFavorites, qThemes, refreshInstalled,
    rememberDrainMarker, repoHints, repoIdentities, scrollToTop, setActivationWarnings,
    setActivations, setBuildsSkipped, setBusyUrl, setCompatibilityNotice, setConfirming, setDoneUrls,
    setHostIncompatible, setHotNames, setHotUrls, setInstallError, setMigrationConfirm,
    setOperationsOpen, setRecords, setReplacing, setRollingBack, sortDir, sortField, statusRef,
    surface, t, tab, themeSortDir, themeSortField, themeTimeRange, timeRange,
  } = c
// Rows for the current query, before the plugins the user banned are taken
  // out, and before the host filter (#872).
  //
  // The host filter is deliberately NOT part of this pass. `hostCompatibility`
  // arrives in batches while the page loads, and folding it into the query
  // rebuilt this list on every arrival — which re-ran the whole-catalog block
  // scan below. Measured against a 9.7k-entry catalog: 433 ms of main thread
  // per arrival, 227–433 ms per scroll step (#1097). Screening by host is a
  // map lookup per row, so it runs after that scan instead of feeding it.
  const pluginsAll = useMemo(() => {
    if (data === null) return [] as RegistryPlugin[]
    const query = {
      category: cat, source, query: q, lang, categories: data.categories,
      sort: `${sortField}-${sortDir}` as `${typeof sortField}-${typeof sortDir}`,
      sinceDays: timeRange === 'all' ? undefined : TIME_RANGE_DAYS[timeRange],
    }
    return visiblePlugins(data.plugins, { ...query, compatibleWithHost: false })
  },
    [data, q, cat, source, lang, sortField, sortDir, timeRange])
  // One plugin can be stored under the installed name or the catalog name.
  // Both have to hide the card and skip Update all (#657).
  // With nothing blocked — the default — the answer is false for every entry,
  // and it is decided before the matching below could change it: the matching
  // is an ARGUMENT, so without this it ran for the whole catalog first and only
  // then was asked of an empty set (#1097, ~730 ms at 9.9k entries).
  const pluginBlocked = (plugin: RegistryPlugin): boolean =>
    blockedNameSet.size > 0
    && blockAliases(plugin, matchInstalledName(plugin, installed, repoIdentities, data?.plugins, repoHints))
      .some(name => blockedNameSet.has(name))
  // Memoized because one call walks the WHOLE catalog
  // (`catalogEntryForInstalled` → `entryForDep` → `sameSourceConflict` per
  // entry), and the update reminders below ask about one installed package at
  // a time, in three filtered lists, on every render. That was 227–433 ms of
  // main thread per scroll step at 9.7k catalog entries × 28 installed
  // packages (#1097). The answers only change with the inputs below.
  const installedBlocked = useMemo(() => {
    const compute = (name: string): boolean => {
      if (blockedNameSet.has(name)) return true
      if (data === null) return false
      const spec = installed[name]
      if (spec === undefined) return false
      const entry = catalogEntryForInstalled(data.plugins, name, String(spec), repoIdentities[name], repoHints[name])
      return entry !== undefined && blockAliases(entry, name).some(alias => blockedNameSet.has(alias))
    }
    const cache = new Map<string, boolean>()
    return (name: string): boolean => {
      const hit = cache.get(name)
      if (hit !== undefined) return hit
      const value = compute(name)
      cache.set(name, value)
      return value
    }
  }, [data, blockedNameSet, installed, repoIdentities, repoHints])
  const blockToggleName = (aliases: readonly string[]): string =>
    aliases.find(name => blockedNameSet.has(name)) ?? aliases[0]!
  const pluginsUnblocked = useMemo(
    () => pluginsAll.filter(plugin => !pluginBlocked(plugin)),
    // pluginBlocked closes over the installed map and the catalog match.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pluginsAll, blockedNameSet, installed, repoIdentities, data, repoHints])
  // A sort the user chose is a request to see the list in THAT order, and
  // this block ignores the sort by design (it is "what was added in the last
  // seven days", ordered by downloads). Left in place it sits between the
  // control and the list it just reordered: on a 1166px window it fills the
  // screen, so switching to Stars looked like it did nothing (#1016). The
  // block is a front-page teaser for the unfiltered default view — one more
  // narrowing, alongside query, category and time range.
  const recentlyAdded = useMemo(
    () => data === null || tab !== 'discover' || q.trim() !== '' || cat !== 'all' || source !== 'all' || timeRange !== 'all'
      || sortField !== 'downloads' || sortDir !== 'desc'
      ? []
      : withSponsoredFirst(data.plugins, visiblePlugins(data.plugins, {
          category: 'all', query: '', lang, sort: 'downloads-desc', sinceDays: 7,
        }).filter(plugin => !pluginBlocked(plugin)), plugin => !pluginBlocked(plugin)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, tab, q, cat, source, timeRange, sortField, sortDir, lang, blockedNameSet, installed, repoIdentities, repoHints])
  const [recentCollapsed, setRecentCollapsed] = useState(() => readRecentFlag(RECENT_COLLAPSED_KEY))
  const [recentHidden, setRecentHidden] = useState(() => readRecentFlag(RECENT_HIDDEN_KEY))
  const toggleRecentCollapsed = useCallback(() => {
    const next = !recentCollapsed
    setRecentCollapsed(next)
    writeRecentFlag(RECENT_COLLAPSED_KEY, next)
  }, [recentCollapsed])
  const hideRecent = useCallback(() => {
    setRecentHidden(true)
    writeRecentFlag(RECENT_HIDDEN_KEY, true)
  }, [])
  const showRecent = useCallback(() => {
    setRecentHidden(false)
    writeRecentFlag(RECENT_HIDDEN_KEY, false)
    // The one-line control is "show recently added", not "restore the
    // previous fold". Landing on a collapsed heading would be a second
    // click to see the tiles.
    setRecentCollapsed(false)
    writeRecentFlag(RECENT_COLLAPSED_KEY, false)
  }, [])
  // Fix the slice before compatibility resolves. Hiding a card must not
  // pull in an unchecked replacement and start another batch.
  const discoverResetDeps = [q, cat, source, sortField, sortDir, timeRange]
  const { currentPage, totalPages, pageSize, goToPage, changePageSize } =
    usePagination(pluginsUnblocked.length, discoverResetDeps, scrollToTop)
  const discoverMore = useShownCount(pluginsUnblocked.length, discoverResetDeps, DEFAULT_PAGE_SIZE)
  const basePage = surface === 'plugins'
    ? pluginsUnblocked.slice(0, discoverMore.shown)
    : pluginsUnblocked.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const baseRecent = recentlyAdded.slice(0, RECENT_STRIP_LIMIT)
  const hostVerdict = (plugin: RegistryPlugin) => {
    const key = hostCompatibilityKey(plugin)
    return key === null ? undefined : hostCompatibility[key]
  }
  const compatible = (plugin: RegistryPlugin): boolean =>
    !compatibleWithHost || hostVerdict(plugin)?.status !== 'incompatible'
  const pagePlugins = basePage.filter(compatible)
  const recentPlugins = baseRecent.filter(compatible)
  const hasRecent = recentPlugins.length > 0
  // A catalog card can appear both in the grid and in the recent strip.
  // Keep distinct cards in counts even when they share the same lookup key.
  const discoverCandidates = [...new Set([...basePage, ...(!recentHidden && !recentCollapsed ? baseRecent : [])])]
  const pageHostPackages = [...new Set(discoverCandidates.map(hostCompatibilityKey).filter(key => key !== null))]
  const pageVerdicts = discoverCandidates.map(hostVerdict)
  const loadedHostPackages = pageHostPackages.filter(key => hostCompatibility[key] !== undefined).length
  const hostHiddenCount = pageVerdicts.filter(verdict => verdict?.status === 'incompatible').length
  const hostUnavailableCount = pageVerdicts.filter(verdict => verdict?.basis === 'unavailable').length

  const themePluginsAll = useMemo(
    () => (data === null ? [] : visiblePlugins(data.plugins, {
      category: 'theme', query: qThemes, lang, categories: data.categories,
      sort: `${themeSortField}-${themeSortDir}`,
      sinceDays: themeTimeRange === 'all' ? undefined : TIME_RANGE_DAYS[themeTimeRange],
    })),
    [data, qThemes, lang, themeSortField, themeSortDir, themeTimeRange])
  const themePlugins = useMemo(
    () => themePluginsAll.filter(plugin => !pluginBlocked(plugin)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themePluginsAll, blockedNameSet, installed, repoIdentities, data, repoHints])
  const blockedPlugins = useMemo(
    () => (data === null ? [] : data.plugins.filter(plugin => pluginBlocked(plugin))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, blockedNameSet, installed, repoIdentities, repoHints])
  const blockedMissing = useMemo(
    () => {
      const covered = new Set(blockedPlugins.flatMap(plugin =>
        blockAliases(plugin, matchInstalledName(plugin, installed, repoIdentities, data?.plugins, repoHints))))
      return blockedNames.filter(name => !covered.has(name))
    },
    [blockedNames, blockedPlugins, installed, repoIdentities, data, repoHints])
  const themePagination = usePagination(
    themePlugins.length, [qThemes, themeSortField, themeSortDir, themeTimeRange], scrollToTop)
  const themeMore = useShownCount(
    themePlugins.length, [qThemes, themeSortField, themeSortDir, themeTimeRange], DEFAULT_PAGE_SIZE)
  const themePagePlugins = surface === 'plugins'
    ? themePlugins.slice(0, themeMore.shown)
    : themePlugins.slice(
      (themePagination.currentPage - 1) * themePagination.pageSize, themePagination.currentPage * themePagination.pageSize)

  const favoriteListed = useMemo(
    () => (data === null ? [] : pluginsForFavorites(data.plugins, favoriteUrlSet, {
      query: qFavorites, lang, categories: data.categories,
      sort: `${favSortField}-${favSortDir}`,
      sinceDays: favTimeRange === 'all' ? undefined : TIME_RANGE_DAYS[favTimeRange],
    })),
    [data, qFavorites, lang, favoriteUrlSet, favSortField, favSortDir, favTimeRange])
  const favoritePlugins = useMemo(
    () => favoriteListed.filter(p => !pluginCategories(p).includes('theme')),
    [favoriteListed])
  const favoriteThemes = useMemo(
    () => favoriteListed.filter(p => pluginCategories(p).includes('theme')),
    [favoriteListed])
  const favResetDeps = [qFavorites, favSortField, favSortDir, favTimeRange] as const
  const favoritePluginPagination = usePagination(
    favoritePlugins.length, favResetDeps, scrollToTop)
  const favoriteThemePagination = usePagination(
    favoriteThemes.length, favResetDeps, scrollToTop)
  const favoritePluginMore = useShownCount(favoritePlugins.length, favResetDeps, DEFAULT_PAGE_SIZE)
  const favoriteThemeMore = useShownCount(favoriteThemes.length, favResetDeps, DEFAULT_PAGE_SIZE)
  const favoritePagePlugins = surface === 'plugins'
    ? favoritePlugins.slice(0, favoritePluginMore.shown)
    : favoritePlugins.slice(
      (favoritePluginPagination.currentPage - 1) * favoritePluginPagination.pageSize,
      favoritePluginPagination.currentPage * favoritePluginPagination.pageSize)
  const favoritePageThemes = surface === 'plugins'
    ? favoriteThemes.slice(0, favoriteThemeMore.shown)
    : favoriteThemes.slice(
      (favoriteThemePagination.currentPage - 1) * favoriteThemePagination.pageSize,
      favoriteThemePagination.currentPage * favoriteThemePagination.pageSize)
  // Installed rows need the same discovery-compatibility scan as Discover /
  // Favorites so an incompatible plugin can say why it cannot run — without
  // waiting for the user to open the catalog first.
  // Only keys DiscoveryScan can describe. A bare installed name is dropped by
  // the scanner (no catalog entry) — demanding it left the chip on Loading forever.
  const installedHostPackages = useMemo(
    () => [...new Set(Object.entries(installed).flatMap(([name, spec]) => {
      const entry = data === null
        ? undefined
        : catalogEntryForInstalled(data.plugins, name, String(spec), repoIdentities[name], repoHints[name])
      if (entry === undefined) return []
      const key = hostCompatibilityKey(entry)
      return key === null ? [] : [key]
    }))],
    [installed, data, repoIdentities, repoHints],
  )
  // Favorites reuse pluginCard (and its host-requirement badge). Discover
  // already loads compatibility for the current page; without the same
  // fetch here the badge stays on "Reading host requirement…" forever.
  const compatibilityKeys = (marketGone ? [] : tab === 'discover' ? pageHostPackages
    : tab === 'favorites' ? favoritePagePlugins.map(hostCompatibilityKey).filter(key => key !== null)
    : tab === 'installed' ? installedHostPackages
    : []).join('\u0000')
  useEffect(() => {
    discoveryScan.setDemand(compatibilityDemandOwner.current, data, compatibilityKeys === '' ? [] : compatibilityKeys.split('\u0000'))
  }, [data, compatibilityKeys])
  useEffect(() => {
    const owner = compatibilityDemandOwner.current
    return () => { discoveryScan.removeDemand(owner) }
  }, [])
  const favoriteStale = useMemo(
    () => (data === null ? [] : staleFavoriteUrls(favoriteUrls, data.plugins)),
    [data, favoriteUrls])
  const favoritesAllStale = favoriteUrls.length > 0
    && favoriteStale.length === favoriteUrls.length
    && qFavorites.trim() === ''
  /** Tab badge counts catalog-visible bookmarks once the registry is loaded. */
  const favoriteTabCount = data === null ? favoriteUrls.length : favoriteListed.length

  /** Download a host endpoint as a file — primitives Button can't be an <a download>.
   * Prefers the server's Content-Disposition filename (e.g. the timestamped
   * backup export) and falls back to the caller's name. */
  const downloadFile = useCallback((url: string, filename: string, failureLabel?: string) => {
    fetch(url)
      .then(async res => {
        if (!res.ok) {
          // The server's body carries WHY it failed (a profile with too many
          // config files, an unreadable one, …). Showing only the status left
          // the user with "HTTP 500" and nothing to do about it.
          const detail = await res.json().then(
            (body: { error?: unknown }) => typeof body.error === 'string' && body.error !== '' ? body.error : null,
            () => null,
          )
          throw new Error(`${failureLabel ?? ''}${detail ?? 'HTTP ' + res.status}`)
        }
        const disposition = res.headers.get('content-disposition')
        if (disposition !== null) {
          const match = /filename="?([^";]+)"?/.exec(disposition)
          if (match !== null && match[1] !== undefined && match[1] !== '') filename = match[1]
        }
        return res.blob()
      })
      .then(blob => {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = filename
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 2000)
      })
      .catch(error => setInstallError(String(error)))
  }, [])

  const doRollback = useCallback((rollbackId: string) => {
    setRollingBack(true)
    setInstallError(null)
    fetch(api('/dsh-market/rollback'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rollbackId }),
    })
      .then(res => res.json().then(body => ({ status: res.status, body })))
      .then(({ status, body }) => {
        if (status === 200 && body.ok) {
          setCompatibilityNotice(null)
          refreshInstalled()
        } else {
          setInstallError(String(body.error || body.detail || 'rollback failed'))
        }
      })
      .catch(error => setInstallError(String(error)))
      .finally(() => setRollingBack(false))
  }, [refreshInstalled])

  const compatibilitySummary = (risks: CompatibilityNotice['risks']): string => {
    if (risks.length === 0) return ''
    const first = risks[0]
    return `${first.plugin}: ${first.peer} ${first.range} vs ${first.resolved}`
  }

  /** Which name now resolves from two layers, and which layers those are. */
  const shadowSummary = (entries: NonNullable<CompatibilityNotice['shadowedNames']>): string => {
    if (entries.length === 0) return ''
    const first = entries[0]
    const rest = entries.length > 1 ? ` (+${entries.length - 1})` : ''
    return `${first.name} — ${first.layers.join(' / ')}${rest}`
  }

  const doInstall = useCallback((plugin: RegistryPlugin, force = false, version?: string, preferReject = false) => {
    setBuildsSkipped(null)
    setConfirming(null)
    setInstallError(null)
    setActivationWarnings([])
    setBusyUrl(plugin.url)
    // One record per attempt. A retry appends rather than reusing the old
    // one, so the card resolves to the newest and its Install button returns.
    const recordId = nextRecordId()
    setRecords(list => enqueue(list, {
      id: recordId, kind: 'install', name: plugin.name, url: plugin.url, state: 'running',
    }))
    sessionStorage.setItem('dshm-pending', JSON.stringify({ url: plugin.url, name: plugin.name }))
    fetch(api('/dsh-market/install'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `version` when the refusal dialog found a release this host supports:
      // the route pins THAT release instead of resolving the newest one —
      // which is the release that was just refused (#581).
      body: JSON.stringify({
        url: plugin.url,
        ...(force ? { force: true } : {}),
        ...(version !== undefined ? { version } : {}),
        ...(statusRef.current.agentDrain && !preferReject ? { busyPolicy: 'drain' } : {}),
      }),
    })
      .then(res => res.json().then(body => ({ status: res.status, body })))
      .then(({ status, body }) => {
        setBusyUrl(null)
        sessionStorage.removeItem('dshm-pending')
        if (status === 202 && typeof body.operationId === 'string') {
          const operation = body.operation as DrainOperationWire | undefined
          setRecords(list => patchRecord(withoutHostProjection(list, body.operationId, recordId), recordId, {
            state: 'queued',
            hostOperationId: body.operationId,
            ...(operation?.wait === null || operation?.wait === undefined
              ? {}
              : { blockedBy: operation.wait.activeAgentIds, waitSince: operation.wait.since }),
            reason: operation?.wait === null || operation?.wait === undefined
              ? t('agentBusyQueued')
              : t('agentDrainWaiting').replace('{0}', String(operation.wait.activeCount)),
          }))
          rememberDrainMarker({ operationId: body.operationId, kind: 'install', name: plugin.name, url: plugin.url })
          setOperationsOpen(true)
          return
        }
        if (status === 200 && body.ok && body.hot && pluginCategories(plugin).includes('theme')) {
          // Themes auto-activate on install; reload straight into the Themes
          // tab so the new look is on screen immediately.
          sessionStorage.setItem('dshm-toast', JSON.stringify([plugin.name]))
          sessionStorage.setItem('dshm-tab', 'themes')
          location.reload()
          return
        }
        if (body.cancelled === true) {
          // User-cancelled: quiet reset, nothing to report.
          setRecords(list => drop(list, recordId))
          refreshInstalled()
          if (body.partial === true) setInstallError(t('partialNote'))
          return
        }
        if (status === 200 && body.ok) {
          if (body.activation && typeof body.activation === 'object') {
            setActivations(prev => ({ ...prev, ...body.activation }))
            const warns = Object.entries(body.activation as Record<string, ActivationInfo>)
              .filter(([, info]) => info.state !== 'live' && info.state !== 'missing' && info.loadedByProfile !== true && info.library !== true)
              .map(([name, info]) => ({ name, info }))
            setActivationWarnings(warns)
          }
          if (body.hot) {
            // The status-poll recovery path may have already counted this URL
            // as pending-restart before the install response confirmed a hot
            // mount; a hot plugin must not stay in doneUrls (#73).
            setDoneUrls(urls => urls.filter(url => url !== plugin.url))
            setHotUrls(urls => urls.includes(plugin.url) ? urls : urls.concat(plugin.url))
            setHotNames(names => names.includes(plugin.name) ? names : names.concat(plugin.name))
          } else if (body.activation?.[plugin.name]?.state !== 'incompatible' && body.activation?.[plugin.name]?.library !== true) {
            // An incompatible plugin stays incompatible across restarts, so
            // "restart to apply" would promise a fix no restart can deliver;
            // the activation warning on the installed card already says what
            // to do instead.
            setDoneUrls(urls => urls.includes(plugin.url) ? urls : urls.concat(plugin.url))
          }
          if (body.compatibility?.code === 'soft-incompatible') {
            setCompatibilityNotice(body.compatibility as CompatibilityNotice)
          }
          // `warned` keeps the ✓: the plugin IS installed, so calling a
          // compatibility risk a failure would misreport what happened.
          setRecords(list => patchRecord(list, recordId, body.heldRelease !== undefined
            // The plugin is installed and works; the profile's own
            // minimumReleaseAge is why it is not the newest one. A `warned`
            // keeps the ✓ that the install earned, and the record carries the
            // version the hold refused so the row can offer it (#635).
            ? {
                state: 'warned',
                reason: t('heldReleaseNotice')
                  .replace('{0}', String(body.heldRelease.latest))
                  .replace('{1}', String(body.heldRelease.installed ?? '')),
                heldRelease: body.heldRelease,
              }
            : body.compatibility?.code === 'soft-incompatible'
              && (body.compatibility.risks.length > 0 || (body.compatibility.brokenBundles?.length ?? 0) > 0)
              ? { state: 'warned', reason: t('compatRiskBanner') }
              : { state: 'done', needsRefresh: body.hot !== true }))
          refreshInstalled()
        } else {
          // The Host lost the drain capability between the status sample and
          // this request. Fall back to the ordinary reject path once, which
          // keeps the current 409/queue guidance on that Host (FR-9).
          if (body.unsupported === true) {
            setRecords(list => drop(list, recordId))
            doInstall(plugin, force, version, true)
            return
          }
          // A rename the catalog declares and this profile still holds under
          // the former name (#1012): the host refuses to install the successor
          // beside it, because both would register the same loader rows and
          // the next start would refuse the tree (#122). That refusal is a
          // question with one answer, not a failure to report — the record is
          // replaced by the migration dialog, and its answer runs the same
          // transaction that carries switches, groups and notes across.
          if (body.agentsBusy !== true && body.migration && typeof body.migration === 'object') {
            const { from, target } = body.migration as { from?: unknown; target?: unknown }
            if (typeof from === 'string' && typeof target === 'string') {
              setRecords(list => drop(list, recordId))
              setMigrationConfirm({ name: from, source: String(installed[from] ?? ''), target, kind: 'npm-rename' })
              setOperationsOpen(true)
              return
            }
          }
          if (status === 409) {
            if (body.failureCode === 'AGENT_BARRIER_LOST') {
              // An Agent resumed before the Host could start the file change.
              // Nothing changed; retrying is a new decision, not a queue item.
              setRecords(list => patchRecord(list, recordId, {
                state: 'failed',
                reason: String(body.error ?? t('installFail')),
              }))
              setOperationsOpen(true)
              return
            }
            if (body.targetChanged === true) {
              // The Host refused before accepting the drain: the release it
              // would have installed changed while the confirmation sat.
              // That is a failure to report, not a lock to queue behind.
              setRecords(list => patchRecord(list, recordId, {
                state: 'failed',
                reason: String(body.error ?? t('installFail')),
              }))
              setOperationsOpen(true)
              return
            }
            if (body.agentsBusy === true) {
              // Agents-busy is a queue, not a failure: keep the record as
              // `queued` so the drain below runs it when agents go idle.
              // The host changed nothing (it refuses before touching pnpm),
              // so there is nothing to roll back and nothing to decide — but
              // the row has to say what is holding it, or "queued" reads as
              // "waiting its turn" while it never moves at all (#752).
              setRecords(list => patchRecord(list, recordId, {
                state: 'queued',
                reason: t('agentBusyQueued'),
                blockedBy: blockedSessions(body),
              }))
              setOperationsOpen(true)
              return
            }
            // The host's mutation lock is the other 409, and it is a deferral
            // for the same reason: it refuses BEFORE touching pnpm, so nothing
            // failed and nothing changed. Recording it as `failed` is what
            // lost the rest of a batch of "run now" clicks — a failure is not
            // part of the durable queue, and the restart that ends the
            // operation holding the lock reloads the page and takes the row
            // with it. `queued` means the drain runs it when the lock is free,
            // and the position on the row already says where it sits relative
            // to the one ahead.
            setRecords(list => patchRecord(list, recordId, { state: 'queued' }))
            setOperationsOpen(true)
            return
          }
          // A clash is not a failure to report and forget: the host already
          // reverted it, so what remains is a decision. `input` keeps the
          // record in the panel until the user answers it.
          if (Array.isArray(body.conflictGroups) && body.conflictGroups.length > 0) {
            setRecords(list => patchRecord(list, recordId, {
              state: 'input', conflicts: body.conflictGroups as ConflictNotice['groups'],
            }))
            // Raise the panel for anything that needs an answer. A red dot on
            // a closed panel is not a report; out of sight is out of mind.
            setOperationsOpen(true)
            return
          }
          // A host-compatibility refusal is not a failure to report and
          // forget: the host already stopped it, so what remains is a
          // decision with two facts on the table and a way past (#404,
          // extended to fresh installs). `input` keeps the record in the
          // panel until the user answers it.
          if (body.hostIncompatible && typeof body.hostIncompatible === 'object') {
            const notice = body.hostIncompatible as { name?: unknown; version?: unknown; requirement?: unknown; hostVersion?: unknown; npmName?: unknown }
            setRecords(list => drop(list, recordId))
            setHostIncompatible({
              kind: 'install',
              name: String(notice.name ?? plugin.name),
              version: String(notice.version ?? ''),
              requirement: typeof notice.requirement === 'string' ? notice.requirement : null,
              hostVersion: typeof notice.hostVersion === 'string' ? notice.hostVersion : null,
              npmName: typeof notice.npmName === 'string' ? notice.npmName : (typeof plugin.npm === 'string' ? plugin.npm : null),
              plugin,
            })
            return
          }
          const blocked = Array.isArray(body.ignoredBuilds) ? body.ignoredBuilds.map(String) : []
          if (blocked.length > 0) setBuildsSkipped({ plugin, names: blocked })
          const text = (v: unknown) => typeof v === 'string' ? v : (v && typeof (v as any).text === 'string') ? (v as any).text : v == null ? '' : JSON.stringify(v)
          const orphans = Array.isArray(body.orphanBundles) ? body.orphanBundles.map(String) : []
          // `failureText` keeps a route's own sentence whole and clips only
          // pnpm's own output (#848).
          const failure = failureText(body)
          // The profile will not boot as it stands (#339). Said FIRST, because
          // it outranks whatever else went wrong: a plugin that failed to
          // install is recoverable, a profile that cannot start is not — and
          // the user would otherwise meet it as a Node stack trace after the
          // next restart, with nothing linking it to this operation.
          // A stale catalog entry (#346) is said before pnpm's own wording,
          // which for that failure reads like the user broke something.
          const staleEntry = typeof body.staleEntry === 'string' ? body.staleEntry : null
          const detail = [
            orphans.length > 0 ? `${t('orphanBundle')} ${orphans.join(', ')}` : null,
            staleEntry,
            failure,
          ].filter(Boolean).join('\n')
          // Carry the blocked names onto the record too: the panel is where
          // this failure is read, so it is where the one-click way out has to
          // be (#314). The reason stays bilingual; the panel localizes it.
          // Bounded from the FRONT: every piece here is one of our own
          // sentences now (pnpm's output was clipped inside `failureText`), and
          // the tail clip this used to do is what cut the Chinese half off a
          // bilingual sentence (#848).
          setRecords(list => patchRecord(list, recordId, {
            state: 'failed', reason: detail.trim().slice(0, 1200),
            ...(blocked.length > 0 ? { blockedBuilds: blocked } : {}),
          }))
          setOperationsOpen(true)
        }
      })
      .catch(() => {
        // #100: a long install can outlive its HTTP response (loopback
        // stacks and proxies reset idle connections) while pnpm keeps
        // working server-side — declaring failure here produced a false
        // "install failed, export the log" with an EMPTY log (the route
        // only logs when it finishes), followed by the plugin quietly
        // appearing minutes later. Keep dshm-pending and the busy button
        // instead, and let the status poll decide: its recovery path marks
        // success once the plugin lands (busy-aware since #91) and strikes
        // out genuinely dead installs (#32).
      })
  }, [nextRecordId, refreshInstalled, rememberDrainMarker, t, installed])

  /**
   * Resolve a loader-id clash the only way one profile allows: uninstall the
   * plugins holding the ids, then retry the install. Sequential because each
   * route takes the host's mutation lock, so a parallel burst would 409.
   *
   * A failure part-way leaves plugins already gone. Nothing reinstalls them
   * automatically (a rollback would itself be an install that can fail), so
   * the message names them — reporting only "failed" would leave the user
   * guessing which of their plugins survived.
   */
  const doReplace = useCallback(async (record: OperationRecord, plugin: RegistryPlugin) => {
    setInstallError(null)
    setReplacing(true)
    const removed: string[] = []
    try {
      for (const group of record.conflicts ?? []) {
        const response = await fetch(api('/dsh-market/uninstall'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: group.owner }),
        })
        const body = await response.json() as { ok?: boolean; error?: unknown; stderr?: unknown }
        if (response.status !== 200 || body.ok !== true) {
          const detail = failureText(body, { tail: 400, fallback: 'error' }).trim()
          const reason = removed.length === 0
            ? `${t('installFail')}: ${group.owner} — ${detail}`
            : `${t('conflictReplaceFailed')} ${removed.join(', ')} — ${detail}`
          setRecords(list => patchRecord(list, record.id, { state: 'failed', conflicts: undefined, reason }))
          setOperationsOpen(true)
          refreshInstalled()
          return
        }
        removed.push(group.owner)
      }
    } finally {
      setReplacing(false)
    }
    // The clash record is done with; the retry opens its own, so the card
    // resolves to the new attempt rather than the answered decision.
    setRecords(list => drop(list, record.id))
    refreshInstalled()
    doInstall(plugin)
  }, [doInstall, refreshInstalled, t])
  return {
    basePage, blockToggleName, blockedMissing, blockedPlugins, changePageSize, compatibilitySummary,
    currentPage, discoverMore, doInstall, doReplace, doRollback, downloadFile, favoriteListed,
    favoritePagePlugins, favoritePageThemes, favoritePluginMore, favoritePluginPagination,
    favoritePlugins, favoriteStale, favoriteTabCount, favoriteThemeMore, favoriteThemePagination,
    favoriteThemes, favoritesAllStale, goToPage, hasRecent, hideRecent, hostHiddenCount,
    hostUnavailableCount, installedBlocked, loadedHostPackages, pageHostPackages, pagePlugins,
    pageSize, pluginsAll, pluginsUnblocked, recentCollapsed, recentHidden, recentPlugins,
    shadowSummary, showRecent, themeMore, themePagePlugins, themePagination, themePlugins,
    themePluginsAll, toggleRecentCollapsed, totalPages,
  } as const
}

export type MarketInstallCtx = ReturnType<typeof useMarketInstall>
