/**
 * Market status sync: drain and repair status, catalog loading, compatibility checks and the sticky-layout effects.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { dismissedHostIdSet } from './dismissed-host.ts'
import {
  api,
  applyGithubRouting,
  type DrainHistoryWire,
  type DrainOperationWire,
  installedForCatalog,
  isInstalled,
  localizeBilingual,
  type MarketStatus,
  readSession,
} from './market-data.ts'
import { drop, enqueue, type OperationRecord, patch as patchRecord } from './operations.ts'
import {
  ignoredUpdatesForBoot,
  notifyUpdatePreferencesChanged,
  refreshUpdateNotifications,
} from './update-notifications.ts'
import css from './Market.module.css'
import { discoveryScan } from './MarketImages.tsx'
import { type MarketStateCtx, observeUpdateCheckBoot, updateCheckBoot } from './market-state.tsx'
import { RECONNECT_BUDGET_MS, RECONNECT_REQUEST_MS, SLOW_INSTALL_SECONDS } from './market-constants.ts'
import { installedMap, sameInstalledMap } from './market-helpers.ts'
import { headPinScrollTop, hostStickyOffset, isPinned, listScroller, markStuck } from './market-scroll.ts'
import type { MarketSectionProps } from './market-types.ts'

type MarketSyncIn = { props: MarketSectionProps }
  & Pick<MarketStateCtx,
    'blockedNames' | 'bodyRef' | 'bootId' | 'busyUrl' | 'cat' | 'catsFloorRef' | 'checkoutRecovery' |
    'compatibility' | 'compatibleWithHost' | 'data' | 'disabledNames' | 'doneUrls' | 'favSortDir' |
    'favSortField' | 'favTimeRange' | 'favoriteUrls' | 'headFloorRef' | 'headRef' | 'idleStrikes' |
    'installed' | 'installedBundles' | 'installedView' | 'lang' | 'lightbox' | 'marketGone' |
    'mounted' | 'mountedRef' | 'patchDisabledNames' | 'pendingUpdate' | 'pluginsYRef' | 'q' |
    'qFavorites' | 'qInstalled' | 'qThemes' | 'reconnectRound' | 'recoveredInstall' |
    'refreshInstalled' | 'refreshRequest' | 'removedCount' | 'removingName' | 'repairStatusRequest' |
    'repoHints' | 'repoIdentities' | 'restartNames' | 'restoringStickRef' | 'rootRef' |
    'setAssignFor' | 'setBootId' | 'setBusyUrl' | 'setCancelling' | 'setCheckingUpdates' |
    'setCheckoutRecovery' | 'setDebuggerLatch' | 'setDoneUrls' | 'setEnvFailed' | 'setEnvFixing' |
    'setEnvReady' | 'setGroupMenuFor' | 'setHostBusy' | 'setIgnoredUpdateNames' | 'setInstallError' |
    'setInstalledMenuName' | 'setLoadError' | 'setMarketGone' | 'setOperationsOpen' |
    'setPluginMenuUrl' | 'setProgressCurrent' | 'setProgressDone' | 'setProgressLine' |
    'setProgressPct' | 'setProgressPhase' | 'setReconnecting' | 'setRecords' | 'setRemovedCount' |
    'setRemovingName' | 'setRestartEnabled' | 'setRestartNames' | 'setRestartNoticeDismissed' |
    'setRestartReachable' | 'setShowTop' | 'setStartupRepair' | 'setSupervisor' |
    'setThemesFullscreen' | 'setToggleRestart' | 'setUpdatedNames' | 'setUpdatingName' |
    'setVersion' | 'settledHostRef' | 'sortDir' | 'sortField' | 'startupRepair' | 'statusRef' |
    'surface' | 't' | 'tab' | 'themeSortDir' | 'themeSortField' | 'themeTimeRange' |
    'themesFullscreen' | 'timeRange' | 'toggleRestart' | 'unbundledNames' | 'updateExemptNames' |
    'updateIdleStrikes' | 'updatedNames' | 'updatingName'>

/** drain/repair status, catalog loading, compatibility checks, sticky layout effects. */
export function useMarketSync(c: MarketSyncIn) {
  const {
    blockedNames, bodyRef, bootId, busyUrl, cat, catsFloorRef, checkoutRecovery, compatibility,
    compatibleWithHost, data, disabledNames, doneUrls, favSortDir, favSortField, favTimeRange,
    favoriteUrls, headFloorRef, headRef, idleStrikes, installed, installedBundles, installedView,
    lang, lightbox, marketGone, mounted, mountedRef, patchDisabledNames, pendingUpdate, pluginsYRef,
    q, qFavorites, qInstalled, qThemes, reconnectRound, recoveredInstall, refreshInstalled,
    refreshRequest, removedCount, removingName, repairStatusRequest, repoHints, repoIdentities,
    restartNames, restoringStickRef, rootRef, setAssignFor, setBootId, setBusyUrl, setCancelling,
    setCheckingUpdates, setCheckoutRecovery, setDebuggerLatch, setDoneUrls, setEnvFailed,
    setEnvFixing, setEnvReady, setGroupMenuFor, setHostBusy, setIgnoredUpdateNames, setInstallError,
    setInstalledMenuName, setLoadError, setMarketGone, setOperationsOpen, setPluginMenuUrl,
    setProgressCurrent, setProgressDone, setProgressLine, setProgressPct, setProgressPhase,
    setReconnecting, setRecords, setRemovedCount, setRemovingName, setRestartEnabled,
    setRestartNames, setRestartNoticeDismissed, setRestartReachable, setShowTop, setStartupRepair,
    setSupervisor, setThemesFullscreen, setToggleRestart, setUpdatedNames, setUpdatingName,
    setVersion, settledHostRef, sortDir, sortField, startupRepair, statusRef, surface, t, tab,
    themeSortDir, themeSortField, themeTimeRange, themesFullscreen, timeRange, toggleRestart,
    unbundledNames, updateExemptNames, updateIdleStrikes, updatedNames, updatingName,
  } = c
const knownHostIdsRef = useRef(new Set<string>())
  /**
   * Host operations the user cleared; a status poll must not add them back —
   * and neither must a reload. The set is read from storage and written back
   * per id, because these rows belong to the host: clearing one only ever
   * hides it here, so a set that lived only in memory brought the row back on
   * the next mount (#1184).
   */
  const dismissedHostRef = useRef(dismissedHostIdSet())
  const drainMarkerRestoredRef = useRef(false)

  const clearDrainMarker = useCallback((operationId: string) => {
    try {
      const raw = localStorage.getItem('dshm-drain-v1')
      if (raw === null) return
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return
      const kept = parsed.filter(entry => (entry as { id?: unknown } | null)?.id !== operationId)
      if (kept.length === 0) localStorage.removeItem('dshm-drain-v1')
      else localStorage.setItem('dshm-drain-v1', JSON.stringify(kept))
    } catch { /* storage unavailable — the Host record is still the source of truth */ }
  }, [])

  const rememberDrainMarker = useCallback((operation: { operationId: string; kind: string; name: string; url?: string }) => {
    try {
      const raw = localStorage.getItem('dshm-drain-v1')
      const parsed = raw === null ? [] : JSON.parse(raw) as unknown
      const list = Array.isArray(parsed) ? parsed : []
      if (list.some(entry => (entry as { id?: unknown } | null)?.id === operation.operationId)) return
      list.push({
        id: operation.operationId,
        kind: operation.kind,
        name: operation.name,
        ...(operation.url === undefined ? {} : { url: operation.url }),
      })
      localStorage.setItem('dshm-drain-v1', JSON.stringify(list))
    } catch { /* storage unavailable — the Host record still projects the row */ }
  }, [])

  /** Mark operations this page started in an earlier boot as cancelled by restart. */
  const restoreDrainMarkers = useCallback((status: MarketStatus) => {
    if (drainMarkerRestoredRef.current) return
    const boot = typeof status.boot === 'string' ? status.boot : null
    if (boot === null) return
    drainMarkerRestoredRef.current = true
    let saved: unknown = null
    try { saved = JSON.parse(localStorage.getItem('dshm-drain-v1') ?? 'null') } catch { saved = null }
    if (!Array.isArray(saved) || saved.length === 0) return
    const entries = saved.filter((entry): entry is { id: string; kind?: unknown; name?: unknown; url?: unknown } => {
      if (entry === null || typeof entry !== 'object') return false
      return typeof (entry as { id?: unknown }).id === 'string'
    })
    const stale = entries.filter(entry => !entry.id.startsWith(`${boot}-`))
    // Same-boot markers stay: the Host record reconstructs an active one, and
    // a later Host restart still needs the marker to say the task was cut off.
    const current = entries.filter(entry => entry.id.startsWith(`${boot}-`))
    if (stale.length > 0) {
      setRecords(previous => {
        let next = previous
        for (const entry of stale) {
          if (dismissedHostRef.current.has(entry.id)) continue
          if (next.some(record => record.hostOperationId === entry.id || record.id === `host-${entry.id}`)) continue
          const kind = entry.kind === 'install' || entry.kind === 'update' || entry.kind === 'uninstall'
            ? entry.kind : 'update'
          next = enqueue(next, {
            id: `host-${entry.id}`,
            kind,
            name: typeof entry.name === 'string' ? entry.name : 'plugin',
            ...(typeof entry.url === 'string' ? { url: entry.url } : {}),
            hostOperationId: entry.id,
            // A Host restart cancelled the task; it did not fail on its own.
            state: 'warned',
            reason: t('agentDrainRestarted'),
          })
        }
        return next
      })
      setOperationsOpen(true)
    }
    try {
      if (current.length > 0) localStorage.setItem('dshm-drain-v1', JSON.stringify(current))
      else localStorage.removeItem('dshm-drain-v1')
    } catch { /* storage unavailable */ }
  }, [t])

  /** Project Host-owned operations into the Tasks panel. */
  const applyDrainStatus = useCallback((status: MarketStatus) => {
    const operations: DrainOperationWire[] = Array.isArray(status.drainOperations) ? status.drainOperations : []
    const history: DrainHistoryWire[] = Array.isArray(status.drainHistory) ? status.drainHistory : []
    if (operations.length === 0 && history.length === 0) return

    // A page reopened while the Host is still working should show the waiting
    // task immediately. Only a newly seen operation raises the panel; a later
    // poll must not reopen it after the user closed it.
    let opened = false
    for (const operation of operations) {
      if (operation.state === 'accepted' || operation.state === 'draining'
        || operation.state === 'queued-for-mutation' || operation.state === 'running'
        || operation.state === 'verifying') {
        if (!knownHostIdsRef.current.has(operation.operationId)) {
          knownHostIdsRef.current.add(operation.operationId)
          opened = true
        }
      }
    }

    for (const operation of operations) {
      if (dismissedHostRef.current.has(operation.operationId)) continue
      if (operation.state !== 'succeeded' && operation.state !== 'failed' && operation.state !== 'cancelled') continue
      clearDrainMarker(operation.operationId)
      if (settledHostRef.current.has(operation.operationId)) continue
      settledHostRef.current.add(operation.operationId)
      if (operation.state === 'succeeded') {
        refreshInstalled()
        if (operation.outcome?.restartRequired === true) {
          setRestartNames(names => names.includes(operation.name) ? names : names.concat(operation.name))
        }
        if (operation.kind === 'update') {
          setUpdatedNames(names => names.includes(operation.name) ? names : names.concat(operation.name))
        }
        if (operation.kind === 'install' && operation.url !== undefined) {
          setDoneUrls(urls => urls.includes(operation.url!) ? urls : urls.concat(operation.url!))
        }
      } else {
        refreshInstalled()
      }
    }

    const hostRecord = (operation: DrainOperationWire): OperationRecord => {
      const base = {
        id: `host-${operation.operationId}`,
        kind: operation.kind,
        name: operation.name,
        ...(operation.url === undefined ? {} : { url: operation.url }),
        hostOperationId: operation.operationId,
      }
      if (operation.state === 'accepted' || operation.state === 'draining' || operation.state === 'queued-for-mutation') {
        return {
          ...base,
          state: 'queued',
          ...(operation.wait === null ? {} : { blockedBy: operation.wait.activeAgentIds, waitSince: operation.wait.since }),
          reason: operation.wait === null
            ? t('agentBusyQueued')
            : t('agentDrainWaiting').replace('{0}', String(operation.wait.activeCount)),
        }
      }
      if (operation.state === 'running') {
        return { ...base, state: 'running', blockedBy: undefined, waitSince: undefined, reason: undefined }
      }
      if (operation.state === 'verifying') {
        return { ...base, state: 'running', detail: t('agentDrainVerifying'), blockedBy: undefined, waitSince: undefined, reason: undefined }
      }
      if (operation.state === 'succeeded') {
        return {
          ...base,
          state: 'done',
          needsRefresh: operation.outcome?.needsRefresh === true,
          blockedBy: undefined,
          waitSince: undefined,
          reason: undefined,
        }
      }
      if (operation.state === 'cancelled') {
        // Cancellation is not a failure (AGENTS.md): keep the row settled and
        // readable without the red attention state.
        return { ...base, state: 'warned', reason: t('agentDrainCancelled'), blockedBy: undefined, waitSince: undefined }
      }
      return {
        ...base,
        state: 'failed',
        reason: operation.failure?.message ?? t('installFail'),
        blockedBy: undefined,
        waitSince: undefined,
      }
    }

    setRecords(previous => {
      let next = previous
      for (const operation of operations) {
        if (dismissedHostRef.current.has(operation.operationId)) continue
        const existing = next.find(record => record.hostOperationId === operation.operationId)
        const desired = hostRecord(operation)
        if (existing === undefined) {
          next = enqueue(next, desired)
        } else {
          const { id: _id, kind: _kind, name: _name, hostOperationId: _host, ...changes } = desired
          next = patchRecord(next, existing.id, changes)
        }
      }
      for (const entry of history) {
        if (dismissedHostRef.current.has(entry.id)) continue
        const id = `host-${entry.id}`
        // A row projected while the operation was active must settle from the
        // journal, not stay queued forever because it already existed.
        const existing = next.find(record => record.id === id || record.hostOperationId === entry.id)
        const changes = entry.state === 'succeeded'
          // The journal does not carry the activation outcome, but a row that
          // already reported "refresh needed" must keep that report: this
          // projection runs after the live operation, not instead of it.
          ? (existing?.needsRefresh === true
              ? { state: 'done' as const, blockedBy: undefined, waitSince: undefined, reason: undefined }
              : { state: 'done' as const, needsRefresh: false, blockedBy: undefined, waitSince: undefined, reason: undefined })
          : {
              state: entry.state === 'cancelled' ? 'warned' as const : 'failed' as const,
              reason: entry.state === 'cancelled' ? t('agentDrainHistoryCancelled') : t('agentDrainHistoryFailedShort'),
              blockedBy: undefined,
              waitSince: undefined,
            }
        if (existing !== undefined) {
          next = patchRecord(next, existing.id, changes)
        } else {
          next = enqueue(next, {
            id,
            kind: entry.kind,
            name: entry.name,
            hostOperationId: entry.id,
            ...changes,
          })
        }
      }
      return next
    })
    if (opened) setOperationsOpen(true)
  }, [clearDrainMarker, refreshInstalled, t])

  /** Active Bundles count as installed in Discover without becoming package-manager targets. */
  const catalogInstalled = useMemo(
    () => installedForCatalog(installed, installedBundles),
    [installed, installedBundles],
  )
  /** Lookup set for the persisted disable list (#60). */
  const disabledSet = useMemo(() => new Set(disabledNames), [disabledNames])
  const favoriteUrlSet = useMemo(() => new Set(favoriteUrls), [favoriteUrls])
  const blockedNameSet = useMemo(() => new Set(blockedNames), [blockedNames])
  const updateExemptSet = useMemo(() => new Set(updateExemptNames), [updateExemptNames])
  /** Effective switch state: market disable list ∪ user-patch-layer disables. */
  const effectiveDisabledSet = useMemo(
    () => new Set([...disabledNames, ...patchDisabledNames, ...unbundledNames]),
    [disabledNames, patchDisabledNames, unbundledNames],
  )

  useEffect(() => {
    if (tab !== 'themes' && themesFullscreen) setThemesFullscreen(false)
  }, [tab, themesFullscreen])

  useEffect(() => {
    if (!themesFullscreen || lightbox !== null) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setThemesFullscreen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [lightbox, themesFullscreen])

  /**
   * The host is no longer serving the market's routes (#962).
   *
   * Only a 404 says this: any other status means the route ran and answered.
   * When it happens mid-operation, the response that would have settled the
   * install was lost with the routes, so the spinner has to be released and
   * the row told what became of it — otherwise it turns until DSH restarts,
   * with the user left to guess whether the plugin landed.
   */
  const noteMarketGone = useCallback(() => {
    if (!mountedRef.current) return
    discoveryScan.setUnavailable()
    refreshRequest.current = 0
    repairStatusRequest.current += 1
    setStartupRepair(undefined)
    setCheckoutRecovery(undefined)
    setCheckingUpdates(false)
    setMarketGone(true)
    setBusyUrl(null)
    setUpdatingName(null)
    pendingUpdate.current = null
    setRemovingName(null)
    setRecords(list => list.map(record =>
      record.state === 'running' || record.state === 'queued'
        ? { ...record, state: 'failed' as const, reason: t('marketGoneRecord') }
        : record))
    try {
      sessionStorage.removeItem('dshm-pending')
      sessionStorage.removeItem('dshm-updating')
    } catch { /* storage unavailable */ }
  }, [t])
  useEffect(() => {
    if (compatibility.gone) noteMarketGone()
  }, [compatibility.gone, noteMarketGone])

  /**
   * The status payload, or `null` when the route answered 404 (#962). Every
   * poll that reads this stops on the null: the market is no longer mounted,
   * so there is no status to read and nothing left to poll for.
   */
  const readMarketStatus = useCallback(async (res: Response, repairRequest?: number): Promise<MarketStatus | null> => {
    if (res.status === 404) {
      if (repairRequest === undefined || repairRequest === repairStatusRequest.current) noteMarketGone()
      return null
    }
    return await res.json() as MarketStatus
  }, [noteMarketGone])

  const applyRepairStatus = useCallback((status: Pick<MarketStatus, 'startupRepair' | 'checkoutRecovery'>, request: number) => {
    if (!mounted.current || request !== repairStatusRequest.current) return
    const report = status.startupRepair
    setStartupRepair(previous =>
      report && previous?.id === report.id && previous.revision > report.revision ? previous : report)
    setCheckoutRecovery(status.checkoutRecovery)
  }, [])

  const refreshRepairStatus = useCallback(async (signal?: AbortSignal) => {
    const request = ++repairStatusRequest.current
    try {
      const res = await fetch(api('/dsh-market/status'), { cache: 'no-store', signal: signal ?? null })
      if (!signal?.aborted && (res.ok || res.status === 404)) {
        const status = await readMarketStatus(res, request)
        if (!signal?.aborted && status !== null) applyRepairStatus(status, request)
      }
    } catch { /* A temporary status failure will be retried while the check is pending. */ }
  }, [readMarketStatus, applyRepairStatus])

  const checkingRepair = startupRepair?.checking === true || checkoutRecovery?.checking === true
  useEffect(() => {
    if (!checkingRepair || marketGone) return
    const controller = new AbortController()
    let timer = setTimeout(() => { void poll() }, 2000)
    async function poll() {
      await refreshRepairStatus(controller.signal)
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll() }, 2000)
    }
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [checkingRepair, marketGone, refreshRepairStatus])

  const wasCheckingCheckout = useRef(false)
  useEffect(() => {
    const checking = checkoutRecovery?.checking === true
    if (wasCheckingCheckout.current && !checking && !marketGone) refreshInstalled()
    wasCheckingCheckout.current = checking
  }, [checkoutRecovery, marketGone, refreshInstalled])

  const loadCatalog = useCallback(() => {
    setLoadError(null)
    return discoveryScan.resume()
      .then((outcome) => {
        if (outcome === 'gone') {
          noteMarketGone()
          throw new Error(t('marketGoneTitle'))
        }
        setLoadError(null)
      })
      // Report WHY. An unreachable catalog used to be answered with a
      // bundled copy, so "cannot reach the registry" and "the catalog is
      // smaller today" looked identical on screen — and the second reading
      // is the one users reached.
      .catch((error: unknown) => { setLoadError(error instanceof Error ? error.message : String(error)) })
  }, [noteMarketGone, t])

  /**
   * Come back when the routes do (#1151).
   *
   * A 404 is how the page learns DSH unloaded the market, but DSH usually
   * mounts it again within seconds: it reloads plugins around an install or
   * an update, and the market is one of them. The page used to stay on "stopped"
   * for good, so the user restarted DSH — which also killed whatever the host
   * was still doing. Read-only on purpose: only `status` is asked, never a
   * request that changes anything, and nothing that was in flight is replayed.
   */
  useEffect(() => {
    if (!marketGone) return
    setReconnecting(true)
    const startedAt = Date.now()
    let wait = 1000
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight: AbortController | undefined
    let stopped = false
    const attempt = async (): Promise<void> => {
      const boot = updateCheckBoot
      const repairRequest = ++repairStatusRequest.current
      inFlight = new AbortController()
      const cutoff = setTimeout(() => inFlight?.abort(), RECONNECT_REQUEST_MS)
      try {
        const res = await fetch(api('/dsh-market/status'), { cache: 'no-store', signal: inFlight.signal })
        const status = res.ok ? await res.json() as Partial<MarketStatus> | null : null
        if (!stopped && status !== null && typeof status === 'object' && typeof status.boot === 'string') {
          applyRepairStatus(status, repairRequest)
          discoveryScan.setBoot(status.boot)
          observeUpdateCheckBoot(status.boot, boot)
          setMarketGone(false)
          void loadCatalog()
          refreshInstalled()
          return
        }
      } catch { /* still gone, or the request was cut off */ } finally {
        clearTimeout(cutoff)
      }
      if (stopped) return
      if (Date.now() - startedAt >= RECONNECT_BUDGET_MS) {
        setReconnecting(false)
        return
      }
      timer = setTimeout(() => { void attempt() }, wait)
      wait = Math.min(wait * 2, 5000)
    }
    timer = setTimeout(() => { void attempt() }, wait)
    return () => {
      stopped = true
      clearTimeout(timer)
      inFlight?.abort()
    }
  }, [marketGone, reconnectRound, loadCatalog, refreshInstalled, applyRepairStatus])

  useEffect(() => {
    void loadCatalog()
    const boot = updateCheckBoot
    const repairRequest = ++repairStatusRequest.current
    fetch(api('/dsh-market/status'), { cache: 'no-store' })
      .then(res => readMarketStatus(res, repairRequest))
      .then(status => {
        if (status === null) return
        applyRepairStatus(status, repairRequest)
        statusRef.current = {
          busy: status.busy === true,
          runningAgents: Array.isArray(status.runningAgents) ? status.runningAgents.map(String) : [],
          agentDrain: status.agentDrain === true,
          boot: typeof status.boot === 'string' ? status.boot : null,
        }
        applyDrainStatus(status)
        restoreDrainMarkers(status)
        setEnvReady(status.pnpm !== false)
        // Applied before anything renders a github.com URL. The catalog this
        // page draws from is a larger request through the same server, so it
        // lands later; and if it ever did not, the status poll re-renders
        // within seconds and the images correct themselves.
        applyGithubRouting(status)
        if (typeof status.boot === 'string') {
          discoveryScan.setBoot(status.boot)
          if (mounted.current && observeUpdateCheckBoot(status.boot, boot)) refreshInstalled()
          setBootId(status.boot)
          setIgnoredUpdateNames(ignoredUpdatesForBoot(status.boot))
          // A dismissal only silences the notice for the boot it was made
          // in: if the user dismissed instead of restarting, the next boot
          // (or a stale dismissal from a previous one) shows it again.
          try {
            setRestartNoticeDismissed(sessionStorage.getItem('dshm-restart-dismissed') === status.boot)
          } catch { /* storage unavailable */ }
        }
        setRestartEnabled(status.restart === true)
        setSupervisor(typeof status.supervisor === 'string' ? status.supervisor : null)
        setDebuggerLatch(typeof status.debugger === 'string' ? status.debugger : null)
        // Only an explicit false takes the button away. Absent (an older host) or
        // anything else keeps it: never remove an action on a guess.
        setRestartReachable(status.restartReachable !== false)
        if (typeof status.version === 'string' && status.version !== '') setVersion(status.version)
      })
      .catch(() => {})
    refreshInstalled()
    void refreshUpdateNotifications()
  }, [applyDrainStatus, refreshInstalled, loadCatalog, readMarketStatus, restoreDrainMarkers, applyRepairStatus])

  // Pending-restart flags survive tab switches and page reloads, scoped to
  // one host process: a different boot id means the restart happened and the
  // stale banner must not resurrect.
  useEffect(() => {
    if (bootId === null) return
    const saved = readSession('dshm-restart')
    if (saved === null) return
    if (saved.boot !== bootId) {
      sessionStorage.removeItem('dshm-restart')
      return
    }
    if (Array.isArray(saved.doneUrls) && saved.doneUrls.length > 0) setDoneUrls(saved.doneUrls)
    if (Array.isArray(saved.updated) && saved.updated.length > 0) setUpdatedNames(saved.updated)
    if (Array.isArray(saved.restartNames) && saved.restartNames.length > 0) setRestartNames(saved.restartNames)
    if (typeof saved.removed === 'number' && saved.removed > 0) setRemovedCount(saved.removed)
    if (typeof saved.toggled === 'number' && saved.toggled > 0) setToggleRestart(saved.toggled)
  }, [bootId])

  useEffect(() => {
    if (bootId === null) return
    if (doneUrls.length === 0 && updatedNames.length === 0 && restartNames.length === 0 && removedCount === 0 && toggleRestart === 0) {
      // Nothing pending: drop any stale entry (e.g. a hot mount cleared the
      // only doneUrl) so a same-boot remount cannot resurrect the banner (#73).
      sessionStorage.removeItem('dshm-restart')
      notifyUpdatePreferencesChanged()
      return
    }
    sessionStorage.setItem('dshm-restart', JSON.stringify({
      boot: bootId,
      doneUrls,
      updated: updatedNames,
      restartNames,
      removed: removedCount,
      toggled: toggleRestart,
    }))
    notifyUpdatePreferencesChanged()
  }, [bootId, doneUrls, updatedNames, restartNames, removedCount, toggleRestart])

  const fixEnv = useCallback(() => {
    setEnvFixing(true)
    setEnvFailed(false)
    fetch(api('/dsh-market/setup-pnpm'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(res => res.json())
      .then(body => {
        if (body.ok) {
          setEnvReady(true)
        } else {
          setEnvFailed(true)
          if (typeof body.error === 'string') setInstallError(body.error)
        }
      })
      .catch(() => setEnvFailed(true))
      .finally(() => setEnvFixing(false))
  }, [])

  // Recover an install whose HTTP response was lost (page navigated away or
  // the connection dropped): the pending marker survives in sessionStorage and
  // the poll below converges the button state from the host's ground truth.
  useEffect(() => {
    const pending = readSession('dshm-pending')
    if (pending !== null && typeof pending.url === 'string') {
      setBusyUrl(pending.url)
      recoveredInstall.current = {
        id: `recovered-install:${pending.url}`,
        url: pending.url,
        ...(typeof pending.name === 'string' && pending.name !== '' ? { name: pending.name } : {}),
      }
    }
    // Same recovery for an update in flight: closing the config page unmounts
    // this section and drops `updatingName` with it, so the running row's
    // progress vanished on reopen. The marker restores the row and the poll
    // below converges it from the host's ground truth.
    const updating = readSession('dshm-updating')
    if (updating !== null && typeof updating.name === 'string' && updating.name !== '') {
      setUpdatingName(updating.name)
      const id = `recovered-update:${updating.name}`
      pendingUpdate.current = { recordId: id, recovering: true }
      setRecords(list => list.some(record =>
        record.kind === 'update' && record.name === updating.name && record.state === 'running')
        ? list
        : enqueue(list, { id, kind: 'update', name: updating.name, state: 'running' }))
    }
  }, [])

  // New markers carry the name and recover immediately. Older markers only
  // carried the URL, so wait for the catalog and resolve the same task from it.
  useEffect(() => {
    const recovered = recoveredInstall.current
    if (recovered === null) return
    const name = recovered.name ?? data?.plugins.find(plugin => plugin.url === recovered.url)?.name
    if (name === undefined) return
    recovered.name = name
    setRecords(list => list.some(record => record.id === recovered.id)
      ? list
      : enqueue(list, {
          id: recovered.id, kind: 'install', name, url: recovered.url, state: 'running',
        }))
  }, [data])

  useEffect(() => {
    // An uninstall in flight is polled like an install or an update: without it
    // nothing asked the host how the operation was going, so a market the host
    // unloaded mid-uninstall never reached the 404 that says so, and the row
    // read "uninstalling" until a restart (#1056).
    if (busyUrl === null && updatingName === null && removingName === null) {
      // `hostBusy` is sampled by the progress poll. A normal update response
      // can settle the local operation before the next poll observes the
      // route lock released, leaving the restart button disabled until this
      // section remounts (#440). With no tracked install/update left, discard
      // that stale sample; the guarded restart route still handles the small
      // post-response lock-release window with its existing 409 retry.
      setHostBusy(false)
      // The same sample is what `runQueuedNow` reads to decide whether the
      // host is free (#845 review). Left in place it answered 「另一个安装、
      // 更新或卸载还在进行」 about an idle host, for the up to 2 s until the
      // drain's next tick — and the idle poll that used to correct it is
      // exactly what #845 removed, so with no queued row it never came back.
      statusRef.current = { ...statusRef.current, busy: false }
      setProgressLine(null)
      setProgressPhase(null)
      setProgressCurrent(null)
      setProgressDone(0)
      setCancelling(false)
      return
    }
    const timer = setInterval(() => {
      const polledUpdate = pendingUpdate.current
      const repairRequest = polledUpdate === null ? undefined : ++repairStatusRequest.current
      fetch(api('/dsh-market/status'), { cache: 'no-store' })
        .then(res => readMarketStatus(res, repairRequest))
        .then(status => {
          // 404: the host unloaded the market, and this poll is the only
          // witness left of the operation it was tracking — noteMarketGone
          // released the button and settled the row (#962).
          if (status === null) return
          if (repairRequest !== undefined && typeof status.boot === 'string') applyRepairStatus(status, repairRequest)
          statusRef.current = {
            busy: status.busy === true,
            runningAgents: Array.isArray(status.runningAgents) ? status.runningAgents.map(String) : [],
            agentDrain: status.agentDrain === true,
            boot: typeof status.boot === 'string' ? status.boot : null,
          }
          applyDrainStatus(status)
          restoreDrainMarkers(status)
          setHostBusy(status.busy === true)
          setDebuggerLatch(typeof status.debugger === 'string' ? status.debugger : null)
          if (status.active) {
            if (pendingUpdate.current === polledUpdate) updateIdleStrikes.current = 0
            setCancelling(status.cancelling === true)
            if (status.phase !== null && status.phase !== undefined) {
              // Structured pnpm progress: stage + current package + count.
              setProgressPhase(status.phase)
              setProgressCurrent(status.currentPackage ?? null)
              setProgressDone(status.done ?? 0)
              setProgressLine(null)
              if (typeof status.size === 'number' && status.size > 0 && typeof status.downloaded === 'number') {
                setProgressPct(Math.max(4, Math.min(96, Math.round(status.downloaded / status.size * 100))))
              }
            } else {
              // The desktop manager reports one fixed line and no phases, so
              // a long wait would otherwise look like a hang. Say it is normal
              // when a dependency downloads or compiles, and what to do if it
              // is not.
              const slow = (status.seconds ?? 0) >= SLOW_INSTALL_SECONDS ? ' · ' + t('progressSlow') : ''
              setProgressLine(localizeBilingual(status.lastLine || '…', lang) + '  (' + status.seconds + 's)' + slow)
              setProgressPhase(null)
              setProgressCurrent(null)
              setProgressDone(0)
              const m = /resolved (\d+), reused (\d+), downloaded (\d+), added (\d+)/.exec(status.lastLine || '')
              if (m !== null && Number(m[1]) > 0) {
                const done = Number(m[2]) + Number(m[3]) + Number(m[4])
                setProgressPct(Math.max(4, Math.min(96, Math.round(done / Number(m[1]) * 100))))
              }
            }
          } else {
            setProgressLine(null)
            setProgressPct(null)
            setProgressPhase(null)
            setProgressCurrent(null)
            setProgressDone(0)
            setCancelling(false)
            const statusInstalled = installedMap(status.installed)
            if (!sameInstalledMap(installed, statusInstalled)) refreshInstalled()
            const pending = readSession('dshm-pending')
            // status.busy (#91): pnpm exited but the install route still
            // holds the operation lock (validation, hot-mount). Neither
            // declare the install done nor count an idle strike yet — a
            // premature banner here invited a restart click into a 409.
            if (pending !== null && busyUrl !== null && status.busy !== true) {
              const url = busyUrl
              const nowInstalled = data !== null && data.plugins.some(p =>
                p.url === url && isInstalled(p, statusInstalled, repoIdentities, data.plugins, repoHints))
              if (nowInstalled) {
                idleStrikes.current = 0
                sessionStorage.removeItem('dshm-pending')
                const recovered = recoveredInstall.current
                if (recovered !== null) {
                  setRecords(list => drop(list, recovered.id))
                  recoveredInstall.current = null
                }
                // This poll is the only witness when the install response was
                // lost (#100): the record `doInstall` created is still
                // `running`, and releasing only the card's busy state leaves
                // the Tasks entry claiming "Installing 1/1" for the rest of
                // the mount. A remount used to hide it — `records` is React
                // state, and a `running` row is still not one of the finished
                // rows restored from storage — so the record has to land here.
                // The install landed, so it does (#904).
                setRecords(list => list.map(record =>
                  record.kind === 'install' && record.url === url && record.state === 'running'
                    ? { ...record, state: 'done' as const, needsRefresh: true }
                    : record))
                setDoneUrls(urls => urls.includes(url) ? urls : urls.concat(url))
                setBusyUrl(null)
              } else if (++idleStrikes.current >= 2) {
                // Host is idle and the plugin never landed: the install died
                // (e.g. exit 127) with its response lost. Without this the
                // button says "installing" forever — across reloads (#32).
                idleStrikes.current = 0
                sessionStorage.removeItem('dshm-pending')
                const recovered = recoveredInstall.current
                if (recovered !== null) {
                  setRecords(list => drop(list, recovered.id))
                  recoveredInstall.current = null
                }
                // Same release for the record this mount created: an install
                // that died without a response must not leave the Tasks entry
                // "Installing 1/1" either (#904).
                setRecords(list => list.map(record =>
                  record.kind === 'install' && record.url === url && record.state === 'running'
                    ? { ...record, state: 'failed' as const, reason: t('installFail') }
                    : record))
                setBusyUrl(null)
                setInstallError(t('installFail') + ' — ' + t('exportLog'))
              }
            }
            // An idle sample can precede a POST reaching the host. Only a
            // lost reply or a remount makes this task eligible for recovery.
            if (pendingUpdate.current !== polledUpdate) return
            if (updatingName === null || status.busy === true || polledUpdate?.recovering === false) {
              updateIdleStrikes.current = 0
              return
            }
            // Two idle polls allow the host time to begin the command.
            if (++updateIdleStrikes.current < 2) return
            updateIdleStrikes.current = 0
            if (polledUpdate !== null) {
              sessionStorage.removeItem('dshm-updating')
              pendingUpdate.current = null
              setRecords(list => list.filter(record => record.id !== polledUpdate.recordId
                || record.state !== 'running' || record.hostOperationId !== undefined))
            }
            setUpdatingName(null)
            refreshInstalled()
          }
        })
        .catch(() => {})
    }, 2000)
    return () => clearInterval(timer)
  }, [applyDrainStatus, applyRepairStatus, busyUrl, updatingName, removingName, data, installed, repoIdentities, repoHints, refreshInstalled, lang, restoreDrainMarkers, t])

  const scrollToTop = () => {
    const el = listScroller(surface, rootRef.current, bodyRef.current, themesFullscreen)
    const root = rootRef.current
    const head = headRef.current
    if (el === null) {
      setShowTop(false)
      return
    }
    // Plugins (not fullscreen): park where the inner tab row sticks. Absolute
    // 0 would unpin it and open the host title again. Settings / sidebar /
    // fullscreen still mean the real top of their own scroller.
    if (surface === 'plugins' && !themesFullscreen && root !== null && head !== null) {
      const target = headPinScrollTop(el, root, head)
      if (typeof el.scrollTo === 'function') el.scrollTo({ top: target, behavior: 'smooth' })
      else el.scrollTop = target
      headFloorRef.current = target > 0 ? target : null
      catsFloorRef.current = null
      pluginsYRef.current = target
    } else if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: 0, behavior: 'smooth' })
    } else {
      el.scrollTop = 0
    }
    setShowTop(false)
  }

  // Settings and the sidebar share `.body` across top tabs AND in-tab list
  // replacements — a new list should start at the top of that scroller.
  // The Plugins page tab shares the host's page scroller (except Themes
  // fullscreen, which is an overlay on `.body` again). Jumping the host to
  // 0 unpins both sticky rows and opens the host title again. Instant (not
  // the smooth scrollToTop used for pagination) so the jump happens before
  // paint. Restore the floor remembered while scrolling, not a pin measured
  // after the browser has already clamped.
  useLayoutEffect(() => {
    const el = listScroller(surface, rootRef.current, bodyRef.current, themesFullscreen)
    const root = rootRef.current
    if (el !== null) {
      if (surface !== 'plugins' || root === null || themesFullscreen) {
        el.scrollTop = 0
      } else {
        const cats = root.querySelector(`.${css.cats}`)
        const max = Math.max(0, el.scrollHeight - el.clientHeight)
        const preferred = cats !== null && catsFloorRef.current !== null
          ? catsFloorRef.current
          : headFloorRef.current !== null
            ? headFloorRef.current
            : pluginsYRef.current
        // Short lists cannot reach a deep floor — fall back to the tab row
        // before giving up, so a filter that empties the grid does not yank
        // the host title open when the tabs can still pin.
        const target = preferred <= max
          ? preferred
          : headFloorRef.current !== null && headFloorRef.current <= max
            ? headFloorRef.current
            : max
        if (cats === null) catsFloorRef.current = null
        restoringStickRef.current = true
        if (target > 0) el.scrollTop = target
        pluginsYRef.current = el.scrollTop
        restoringStickRef.current = false
      }
    }
    setShowTop(false)
  }, [surface, themesFullscreen, tab, q, cat, sortField, sortDir, timeRange, compatibleWithHost, qThemes, themeSortField, themeSortDir, themeTimeRange, qFavorites, favSortField, favSortDir, favTimeRange, qInstalled, installedView])
  // Menus are portaled and would stay put while the host page scrolls. `.body`
  // does not scroll on this surface (unless Themes fullscreen), so the close
  // and the back-to-top affordance listen to the host.
  useEffect(() => {
    if (surface !== 'plugins' || themesFullscreen) return undefined
    const host = listScroller(surface, rootRef.current, null, false)
    if (host === null) return undefined
    const onScroll = (): void => {
      setPluginMenuUrl(null)
      setInstalledMenuName(null)
      setGroupMenuFor(null)
      setAssignFor(null)
      const show = host.scrollTop > 400
      setShowTop(prev => (prev === show ? prev : show))
    }
    onScroll()
    host.addEventListener('scroll', onScroll, { passive: true })
    return () => host.removeEventListener('scroll', onScroll)
  }, [surface, themesFullscreen])
  // Park the market's own tab row just under whatever the host is already
  // pinning. The compact header changes height as the page title leaves, so
  // this re-reads on scroll and resize rather than baking in a pixel value.
  // Fullscreen drops the flatten rules and scrolls inside `.body` instead.
  useLayoutEffect(() => {
    const root = rootRef.current
    /** Drops #1237's stuck marks. Scroll state, so it leaves with the offsets. */
    const clearStuck = (): void => {
      markStuck(headRef.current, false)
      markStuck(root?.querySelector(`.${css.cats}`) ?? null, false)
    }
    if (surface !== 'plugins' || root === null || themesFullscreen) {
      root?.style.removeProperty('--dshm-host-sticky-top')
      root?.style.removeProperty('--dshm-plugins-head-height')
      root?.style.removeProperty('--dshm-empty-view-height')
      clearStuck()
      return undefined
    }
    const host = listScroller(surface, root, null, false)
    if (host === null) {
      root.style.removeProperty('--dshm-host-sticky-top')
      root.style.removeProperty('--dshm-plugins-head-height')
      root.style.removeProperty('--dshm-empty-view-height')
      clearStuck()
      return undefined
    }
    let frame = 0
    const apply = (): void => {
      frame = 0
      const hostTop = hostStickyOffset(host, root)
      const head = headRef.current
      const headHeight = head === null ? 0 : Math.round(head.getBoundingClientRect().height)
      root.style.setProperty('--dshm-host-sticky-top', `${String(hostTop)}px`)
      root.style.setProperty('--dshm-plugins-head-height', `${String(headHeight)}px`)
      // Visible height available to .body > .empty inside the host scroller.
      // Prefer the empty node's top: on Discover, search/cats are flex siblings
      // above it (stickyHead is display:contents), so measuring from .body
      // would make max-height include that chrome and park the tip low.
      // Clamp the top to the scroller so a scrolled-away body does not inflate
      // the slice past the host viewport.
      const body = bodyRef.current
      if (body !== null) {
        const hostRect = host.getBoundingClientRect()
        const empty = body.querySelector(`:scope > .${css.empty}`)
        const topSrc = empty instanceof HTMLElement ? empty : body
        const top = Math.max(hostRect.top, topSrc.getBoundingClientRect().top)
        const view = Math.max(0, Math.round(hostRect.bottom - top))
        root.style.setProperty('--dshm-empty-view-height', `${String(view)}px`)
      }
      const cats = root.querySelector(`.${css.cats}`)
      const catsEl = cats instanceof HTMLElement ? cats : null
      const headPinned = head !== null && isPinned(host, head, hostTop)
      const catsPinned = catsEl !== null && isPinned(host, catsEl, hostTop + headHeight)
      markStuck(head, headPinned)
      markStuck(catsEl, catsPinned)
      if (restoringStickRef.current) return
      const y = host.scrollTop
      // A clamp-to-0 from a shorter list can fire scroll before the restore
      // layout effect. Do not trust y===0 to erase the pin floors, and do
      // not drop them on a one-frame !isPinned — only when the reader has
      // scrolled back above the remembered line.
      if (y > 0) pluginsYRef.current = y
      if (headPinned) {
        headFloorRef.current = headFloorRef.current === null ? y : Math.min(headFloorRef.current, y)
      } else if (headFloorRef.current !== null && y > 0 && y + 4 < headFloorRef.current) {
        // y===0 is often a short-list clamp, not a real scroll to the top —
        // keep the floor so the restore layout effect can still use it.
        headFloorRef.current = null
      }
      if (catsPinned) {
        catsFloorRef.current = catsFloorRef.current === null ? y : Math.min(catsFloorRef.current, y)
      } else if (catsEl === null) {
        catsFloorRef.current = null
      } else if (catsFloorRef.current !== null && y > 0 && y + 4 < catsFloorRef.current) {
        catsFloorRef.current = null
      }
    }
    const schedule = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(apply)
    }
    const clearPinVars = (): void => {
      host.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = 0
      root.style.removeProperty('--dshm-host-sticky-top')
      root.style.removeProperty('--dshm-plugins-head-height')
      root.style.removeProperty('--dshm-empty-view-height')
      clearStuck()
    }
    apply()
    host.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    if (typeof ResizeObserver === 'undefined') {
      return clearPinVars
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(host)
    observer.observe(root)
    const head = headRef.current
    if (head !== null) observer.observe(head)
    return () => {
      observer.disconnect()
      clearPinVars()
    }
  }, [surface, themesFullscreen])
  return {
    applyDrainStatus, blockedNameSet, catalogInstalled, effectiveDisabledSet, favoriteUrlSet, fixEnv,
    loadCatalog, readMarketStatus, refreshRepairStatus, rememberDrainMarker, restoreDrainMarkers,
    scrollToTop, updateExemptSet,
  } as const
}

export type MarketSyncCtx = ReturnType<typeof useMarketSync>
