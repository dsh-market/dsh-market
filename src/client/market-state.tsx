/**
 * Market state: the cross-mount caches, the update-check store, and the hook that owns the section's state and the status poll.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  type ActivationInfo,
  api,
  type GistExportResult,
  type InstalledMap,
  type InstalledRepoHints,
  type InstalledRepoIdentities,
  type InstalledSort,
  type InstallStamp,
  localizeBilingual,
  type MarketStatus,
  marketUiLocale,
  pluginName,
  queuedRowApplies,
  type RegistryPlugin,
  type SharedHostPackageDependencyFinding,
  type SortDir,
  type SortField,
  type TimeRange,
  type UpdateStatus,
} from './market-data.ts'
import { discoveryScan, OwnerAvatar } from './MarketImages.tsx'
import {
  notifyUpdatePreferencesChanged,
  refreshUpdateNotificationsAfterChange,
  type UpdateNotificationsState,
  useUpdateNotifications,
} from './update-notifications.ts'
import { type OperationRecord, restoreSettled, serializeSettled, SETTLED_STORAGE_KEY } from './operations.ts'
import type { RecoveryView } from './RecoveryPanel.tsx'
import { exportMarketLog } from './self-check.ts'
import { claimOpenPlugin, pendingOpenPlugin, subscribeOpenPlugin } from './open-request.ts'
import { readInstalledSort, readSortChoice, rememberInstalledSort, rememberSortChoice } from './sort-preference.ts'
import {
  installedRepoHints,
  installedRepoIdentities,
  isInstalledSnapshot,
  isRecordOfRecords,
  localDescriptionsFromUnknown,
  readSidebarTipDismissed,
  readUpdateStatuses,
  savedWebdav,
} from './market-helpers.ts'
import type { CompatibilityNotice, MarketSectionProps, SourceMigrationConfirm } from './market-types.ts'
import type { ResolvedNotes } from './MarketNotes.tsx'
import { UPDATE_CHECK_REQUEST_MS } from './market-constants.ts'
import { isHostDependencyFinding } from './MarketStatusParts.tsx'

/**
 * Module-scope caches so re-entering the section renders instantly instead
 * of refetching and rebuilding from a spinner (#30 by @StarsTom). Module
 * state survives section switches; a background refetch keeps it current.
 *
 * #846 adds the sidebar page as a second mount of MarketSection. Anything
 * that paints buttons or badges (updates, live/disabled, tab counts, host
 * filter) has to live here too — otherwise each open starts from empty and
 * the Installed tab's red dot / 「更新」buttons flash off then on, and the
 * two entries disagree until both refetches finish.
 */
let cachedInstalled: InstalledMap | null = null
let cachedLocalDescriptions: Record<string, string> = {}
let cachedRepoIdentities: InstalledRepoIdentities | null = null
let cachedRepoHints: InstalledRepoHints | null = null
interface UpdateCheckSnapshot {
  updates: Record<string, UpdateStatus>
  installed: InstalledMap
  ready: boolean
  /** null for a whole request failure, a set for failed packages only. */
  failed: ReadonlySet<string> | null
}

const emptyUpdateCheck: UpdateCheckSnapshot = { updates: {}, installed: {}, ready: false, failed: new Set() }
let updateCheckSnapshot = emptyUpdateCheck
export let updateCheckBoot: string | null = null
let updateCheckRequest = 0
let updateCheckCommitted = 0
let installedCheckCommitted = 0
const updateCheckListeners = new Set<() => void>()
/** A manual check on either surface fences older background samples on both. */
const pendingUpdateNotificationReads = new Set<number>()

function getUpdateCheckSnapshot() { return updateCheckSnapshot }

function subscribeUpdateCheck(listener: () => void): () => void {
  updateCheckListeners.add(listener)
  return () => { updateCheckListeners.delete(listener) }
}

function publishUpdateCheck(snapshot: UpdateCheckSnapshot): void {
  updateCheckSnapshot = snapshot
  for (const listener of updateCheckListeners) listener()
}

function releaseUpdateNotificationRead(request: number): void {
  if (pendingUpdateNotificationReads.delete(request)) publishUpdateCheck({ ...updateCheckSnapshot })
}

function resetUpdateCheck(boot: string | null): void {
  pendingUpdateNotificationReads.clear()
  updateCheckBoot = boot
  updateCheckCommitted = ++updateCheckRequest
  installedCheckCommitted = updateCheckRequest
  publishUpdateCheck(emptyUpdateCheck)
}

export function observeUpdateCheckBoot(boot: string, previous: string | null): boolean {
  if (previous !== updateCheckBoot) return false
  if (updateCheckBoot === null) updateCheckBoot = boot
  if (updateCheckBoot === boot) return false
  resetUpdateCheck(boot)
  return true
}

let cachedInstalledReady = false
let cachedSkins: string[] = []
let cachedDisabledNames: string[] = []
let cachedInstalledFiles: string[] = []
let cachedFavoriteUrls: string[] = []
let cachedBlockedNames: string[] = []
let cachedInstalledBundles: string[] = []
let cachedActivations: Record<string, ActivationInfo> = {}
/** Market package version from /status — the 「v1.66.x」 next to the title. */
let cachedMarketVersion: string | null = null

/** Keep a React state setter and its module cache in lockstep. */
function cacheState<T>(write: (value: T) => void, setState: (value: T | ((current: T) => T)) => void) {
  return (value: T | ((current: T) => T)): void => {
    setState(current => {
      const next = typeof value === 'function' ? (value as (current: T) => T)(current) : value
      write(next)
      return next
    })
  }
}

/** Test helper: drop the shared surface caches between cases. */
export function resetHostCompatibilityCache(): void {
  discoveryScan.reset()
  resetUpdateCheck(null)
  cachedInstalledReady = false
  cachedLocalDescriptions = {}
  cachedSkins = []
  cachedDisabledNames = []
  cachedInstalledFiles = []
  cachedFavoriteUrls = []
  cachedBlockedNames = []
  cachedInstalledBundles = []
  cachedActivations = {}
  cachedMarketVersion = null
}

function applyUpdateCheck(request: number, received: Record<string, UpdateStatus> | null, installed: InstalledMap | null): void {
  if (request < updateCheckCommitted) return
  updateCheckCommitted = request
  const previous = updateCheckSnapshot
  const hasSameSpec = (name: string) => installed?.[name] !== undefined && installed[name] === previous.installed[name]
  if (received === null) {
    // A failed response says nothing about eligibility. A fresh installed list
    // can still rule out rows for older installs or removed programs.
    const updates = installed === null ? previous.updates
      : Object.fromEntries(Object.entries(previous.updates).filter(([name]) => hasSameSpec(name)))
    publishUpdateCheck({ ...previous, updates, installed: installed ?? previous.installed, failed: null })
    return
  }
  const failed = new Set<string>()
  const updates = Object.fromEntries(Object.entries(received).map(([name, status]) => {
    if (status.checkFailed !== true && status.checkError !== 'unavailable') return [name, status]
    failed.add(name)
    const confirmed = previous.updates[name]
    // A name can be reinstalled with a different source or local version.
    if (hasSameSpec(name) && confirmed?.checkFailed !== true && confirmed?.checkError !== 'unavailable' && typeof status.version === 'string'
      && status.version === confirmed?.version && status.kind === confirmed.kind) return [name, confirmed]
    return [name, status]
  }))
  publishUpdateCheck({ updates, installed: installed ?? {}, ready: installed !== null, failed })
}

type MarketStateIn = { props: MarketSectionProps }

/** state declarations, caches, status polling. */
export function useMarketState(c: MarketStateIn) {
  const { props } = c
const t = props.t
  const initialWebdav = useMemo(savedWebdav, [])
  const localeSnap = useSyncExternalStore(
    cb => props.locale.subscribe(cb),
    () => props.locale.getSnapshot(),
  )
  const uiLocale = marketUiLocale(localeSnap.active)
  const lang = uiLocale === 'zh-CN' ? 'zh' : 'en'
  const surface = props.surface ?? 'settings'
  const sidebar = props.sidebar
  // The host's own page for a bundle (dsh 0.2.1+). Subscribed rather than read
  // once: the service arrives with the host's plugin manager, which may load
  // after this panel is already on screen.
  const notificationSnapshot = useUpdateNotifications()
  const latestNotification = useRef(notificationSnapshot)
  latestNotification.current = notificationSnapshot
  const hostNavigation = props.hostNavigation
  const openInHost = useSyncExternalStore(
    cb => hostNavigation?.subscribe(cb) ?? (() => {}),
    () => hostNavigation?.get(),
  )
  const [sidebarSnap, setSidebarSnap] = useState(() => ({
    supported: sidebar?.supported() === true,
    enabled: sidebar?.enabled() === true,
    ready: sidebar?.ready() === true,
  }))
  const [sidebarTipDismissed, setSidebarTipDismissed] = useState(readSidebarTipDismissed)
  const [sidebarTipSaving, setSidebarTipSaving] = useState(false)
  const [sidebarTipError, setSidebarTipError] = useState<string | null>(null)
  useEffect(() => {
    if (sidebar === undefined) return undefined
    const sync = (): void => {
      setSidebarSnap({
        supported: sidebar.supported(),
        enabled: sidebar.enabled(),
        ready: sidebar.ready(),
      })
    }
    sync()
    return sidebar.subscribe(sync)
  }, [sidebar])
  // Wait for load(): until then enabled is the default off, not a known choice.
  const showSidebarTip = surface === 'settings'
    && sidebarSnap.ready
    && sidebarSnap.supported
    && !sidebarSnap.enabled
    && !sidebarTipDismissed
  const enableSidebar = useCallback(() => {
    if (sidebar === undefined) return
    setSidebarTipError(null)
    setSidebarTipSaving(true)
    void sidebar.set(true).catch((cause: unknown) => {
      setSidebarTipError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => { setSidebarTipSaving(false) })
  }, [sidebar])
  // null when the composition has no theme service — the Themes tab hides.
  const themeSnap = useSyncExternalStore(
    props.themeStore.subscribe,
    props.themeStore.getSnapshot,
  )
  const compatibility = useSyncExternalStore(discoveryScan.subscribe, discoveryScan.getSnapshot)
  const { catalog: data, enabled: compatibleWithHost, hostVersion, verdicts: hostCompatibility } = compatibility
  const [loadError, setLoadError] = useState<string | null>(null)
  /**
   * The host answered 404 on one of the market's own routes (#962).
   *
   * That is not a failed request: it means DSH reloaded its plugins and did
   * not mount the market again, so nothing on this page can reach the host —
   * not the catalog, not the operation lock, not the restart route. The page
   * already on screen keeps rendering (it is a client-side app), which is
   * exactly why it owes the user this sentence instead of a spinner.
   */
  const [marketGone, setMarketGone] = useState(false)
  const [startupRepair, setStartupRepair] = useState<MarketStatus['startupRepair']>()
  const [checkoutRecovery, setCheckoutRecovery] = useState<MarketStatus['checkoutRecovery']>()
  const repairStatusRequest = useRef(0)
  // Whether the page is still trying to reach the market again, and how many
  // times the user asked it to start over (#1151).
  const [reconnecting, setReconnecting] = useState(true)
  const [reconnectRound, setReconnectRound] = useState(0)
  const [installed, setInstalledState] = useState<InstalledMap>(cachedInstalled ?? {})
  const [localDescriptions, setLocalDescriptionsState] = useState<Record<string, string>>(() => cachedLocalDescriptions)
  const setLocalDescriptions = useCallback(cacheState(value => { cachedLocalDescriptions = value }, setLocalDescriptionsState), [])
  const [repoIdentities, setRepoIdentitiesState] = useState<InstalledRepoIdentities>(cachedRepoIdentities ?? {})
  const setRepoIdentities = useCallback((value: InstalledRepoIdentities) => {
    cachedRepoIdentities = value
    setRepoIdentitiesState(value)
  }, [])
  const [repoHints, setRepoHintsState] = useState<InstalledRepoHints>(cachedRepoHints ?? {})
  const setRepoHints = useCallback((value: InstalledRepoHints) => {
    cachedRepoHints = value
    setRepoHintsState(value)
  }, [])
  const [installedFiles, setInstalledFilesState] = useState<string[]>(() => cachedInstalledFiles)
  const setInstalledFiles = useCallback(cacheState(value => { cachedInstalledFiles = value }, setInstalledFilesState), [])
  const [skins, setSkinsState] = useState<string[]>(() => cachedSkins)
  const setSkins = useCallback(cacheState(value => { cachedSkins = value }, setSkinsState), [])
  const [tab, setTab] = useState(() => {
    const saved = sessionStorage.getItem('dshm-tab')
    if (saved !== null) sessionStorage.removeItem('dshm-tab')
    return saved || 'discover'
  })
  const [q, setQ] = useState('')
  const [discoverSearchReset, resetDiscoverSearch] = useState(0)
  const [installedSearchReset, resetInstalledSearch] = useState(0)
  /** Per-tab searches stay independent: discover / themes / installed. */
  const [qThemes, setQThemes] = useState('')
  const [themeSearchReset, resetThemeSearch] = useState(0)
  const [qFavorites, setQFavorites] = useState('')
  const [qInstalled, setQInstalled] = useState('')
  const [cat, setCat] = useState('all')
  /** Which catalog Discover is narrowed to; 'all' unless more than one is loaded. */
  const [source, setSource] = useState('all')
  // FLAQ Desktop supplies this for onboarding/feature navigation; upstream dsh web omits it, so ordinary web opens intentionally leave this effect idle.
  useEffect(() => {
    const target = props.preferredSubsectionId
    if (target === undefined) return
    const separator = target.indexOf(':')
    const kind = separator === -1 ? target : target.slice(0, separator)
    const value = separator === -1 ? '' : target.slice(separator + 1)
    if (kind === 'installed') {
      setTab('installed')
      setQInstalled(value)
      resetInstalledSearch(n => n + 1)
    } else if (kind === 'discover') {
      setTab('discover')
      setCat('all')
      setSource('all')
      setQ(value)
      resetDiscoverSearch(n => n + 1)
    }
  }, [props.preferredSubsectionId])
  const [confirming, setConfirming] = useState<RegistryPlugin | null>(null)
  // A plugin someone asked to open from outside this page (the /find-plugin
  // card, AI search): show its install dialog once the catalog can name it.
  const openRequest = useSyncExternalStore(subscribeOpenPlugin, pendingOpenPlugin, () => null)
  useEffect(() => {
    if (openRequest === null || data === null) return
    const entry = data.plugins.find(plugin => plugin.name === openRequest || plugin.npm === openRequest)
    if (entry === undefined) return
    claimOpenPlugin(openRequest)
    setTab('discover')
    setConfirming(entry)
  }, [openRequest, data])
  /** The plugin whose comment thread is open, or null. */
  const [commentsFor, setCommentsFor] = useState<RegistryPlugin | null>(null)
  
  /**
   * Every mutating operation the user started. Records outlive the card that
   * started them, so paginating or searching cannot take a pending decision
   * off screen — and finished records outlive the page load too (see the
   * settled restore below); one still moving or waiting on a decision does not.
   */
  const [records, setRecords] = useState<OperationRecord[]>([])
  const recordSeq = useRef(0)
  /** The synthetic install task rebuilt from dshm-pending after a remount. */
  const recoveredInstall = useRef<{ id: string; url: string; name?: string } | null>(null)
  /** The local task tracking dshm-updating, either awaiting its reply or recovering it. */
  const pendingUpdate = useRef<{ recordId: string; recovering: boolean } | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      pendingUpdate.current = null
    }
  }, [])
  /**
   * The install queue: agents-busy 409s become `queued` records instead of
   * failures, and drain automatically when agents go idle (see drainQueue).
   * Persisted in localStorage so a refresh keeps the queue; only `queued`
   * records persist — `running` recovery stays on the dshm-pending paths.
   */
  const updateCheck = useSyncExternalStore(subscribeUpdateCheck, getUpdateCheckSnapshot)
  const { updates } = updateCheck
  /**
   * The release in this profile that is still inside the safety wait, as last
   * heard from the server (#1252). pnpm refuses every change while it holds,
   * so a batch or the queue stops at the first such refusal instead of trying
   * each plugin in turn. The update check is the authority: whatever it says
   * next replaces this. A list that still offers an update beside a held row
   * comes from a host whose update route takes the offered ones past the
   * wait, so that list stops nothing and the held rows say why on their own.
   */
  const profileBlockRef = useRef<{ name: string; version: string; readyAt: string | null } | null>(null)
  const { profileBlocked, listChecked } = useMemo(() => {
    const failed = updateCheck.failed
    const rows = Object.entries(updates)
    // A row whose check failed in this read keeps its last good answer
    // (applyUpdateCheck), which can still offer an update the server now
    // holds, so only the rows this read checked say whether an update is
    // offered beside a held one. A read that checked no row (the request
    // failed, or every row's check did) leaves the rows as earlier reads
    // answered them.
    const checked = failed === null ? [] : rows.filter(([name]) => !failed.has(name))
    const offered = (checked.length > 0 ? checked : rows).some(([, status]) => status.updateAvailable === true)
    return {
      profileBlocked: offered ? null : rows.find(([, status]) => status.profileBlocked !== undefined)?.[1].profileBlocked ?? null,
      listChecked: checked.length > 0,
    }
  }, [updates, updateCheck.failed])
  // Every new list (a new `updates` object) that checked a row replaces what
  // a refusal set here, also when `profileBlocked` stays null, so Update all
  // and the queue do what the rows on screen say: on such a host the list
  // read after a floating git row was refused holds that row alone and
  // offers the rest. A read that checked no row says nothing about the wait,
  // so the stop stays until one does.
  useEffect(() => {
    if (listChecked) profileBlockRef.current = profileBlocked
  }, [listChecked, profileBlocked, updates])
  /**
   * The host answered an update with "restart first" (#1253): an earlier one in
   * this run already moved the loaded packages, and every later one would be
   * refused the same way. Tied to the host's boot id, so a restart ends it.
   */
  const [restartHold, setRestartHold] = useState<{ boot: string | null } | null>(null)
  const restartHoldRef = useRef(false)
  const queueRestoredRef = useRef(false)
  const [installedReady, setInstalledReady] = useState(cachedInstalledReady)
  useEffect(() => {
    if (queueRestoredRef.current) return
    let saved: unknown = null
    try {
      saved = JSON.parse(localStorage.getItem('dshm-queue-v1') ?? 'null')
    } catch { saved = null }
    if (!Array.isArray(saved) || saved.length === 0) {
      queueRestoredRef.current = true
      return
    }
    if (data === null) return
    // Cached or not-yet-loaded maps cannot judge a replacement's saved queue.
    if (saved.some(row => row?.kind === 'update' || row?.kind === 'uninstall') && !installedReady) return
    if (saved.some(row => row?.kind === 'update' && (
      !updateCheck.ready || updateCheck.failed === null || updateCheck.failed.has(row.name)
    ))) return
    queueRestoredRef.current = true
    // Claim the saved rows synchronously once they have enough evidence to
    // restore, so a second mounted surface cannot restore the same tasks.
    try { localStorage.removeItem('dshm-queue-v1') } catch { /* storage unavailable */ }
    /**
     * A queued row may only run while the world it was queued in still holds.
     *
     * It drains with no confirmation — that is what queueing is — so a row
     * that has gone stale is a destructive operation launched from an old
     * decision: queue an uninstall at 10:00, uninstall it by hand (or change
     * your mind), open the market at 15:00 and it runs. Each kind therefore
     * has to be true RIGHT NOW, and a row that no longer is gets REPORTED
     * rather than executed or silently dropped — the user queued it, so the
     * user is told what became of it.
     */
    const judged = (saved as unknown[]).flatMap((entry): Array<
      { ok: true; row: { kind: OperationRecord['kind']; name: string; url?: string; updateOptions: OperationRecord['updateOptions'] } }
      | { ok: false; kind: OperationRecord['kind']; name: string; url?: string; reason: string }
    > => {
      if (entry === null || typeof entry !== 'object') return []
      const row = entry as Record<string, unknown>
      const kindRaw = row.kind
      if (kindRaw !== 'install' && kindRaw !== 'update' && kindRaw !== 'uninstall') return []
      if (typeof row.name !== 'string' || row.name === '') return []
      if (row.url !== undefined && typeof row.url !== 'string') return []
      const kind: OperationRecord['kind'] = kindRaw
      const name = row.name
      const url = typeof row.url === 'string' ? row.url : undefined
      const stale = (reason: string) => [{ ok: false as const, kind, name, url, reason }]
      const options = row.updateOptions !== null && typeof row.updateOptions === 'object'
        ? row.updateOptions as Record<string, unknown> : {}
      const verdict = queuedRowApplies({ kind, name, restore: options.restore === true,
        ...(typeof options.eligibleVersion === 'string' ? { eligibleVersion: options.eligibleVersion } : {}),
        ...(url === undefined ? {} : { url }) }, { installed, updates, plugins: data.plugins })
      if (verdict !== null) return stale(verdict === 'target-changed'
        ? localizeBilingual('更新目标已变化，已跳过。请重新选择更新。 / The update target changed, so this task was skipped. Choose the update again.', lang)
        : verdict === 'gone' ? t('agentQueueStaleGone') : t('agentQueueStaleNoUpdate'))
      if (kind === 'install' && url === undefined) return []
      const updateOptions = kind === 'update' ? {
        force: options.force === true,
        restore: options.restore === true,
        ...(typeof options.compatVersion === 'string' ? { compatVersion: options.compatVersion } : {}),
        ...(typeof options.eligibleVersion === 'string' ? { eligibleVersion: options.eligibleVersion } : {}),
      } : undefined
      return [{ ok: true as const, row: { kind, name, ...(url === undefined ? {} : { url }), updateOptions } }]
    })
    const valid = judged.flatMap(verdict => verdict.ok ? [verdict.row] : [])
    const stale = judged.flatMap(verdict => verdict.ok ? [] : [verdict])
    if (valid.length === 0 && stale.length === 0) {
      return
    }
    setRecords(prev => {
      const kept = [...prev]
      for (const entry of valid) {
        const dup = kept.some(record =>
          record.state === 'queued'
          && record.kind === entry.kind
          && record.name === entry.name
          && (entry.kind !== 'install' || record.url === entry.url))
        if (dup) continue
        recordSeq.current += 1
        kept.push({
          id: `op-${String(recordSeq.current)}`,
          kind: entry.kind,
          name: entry.name,
          ...(entry.url === undefined ? {} : { url: entry.url }),
          ...(entry.updateOptions === undefined ? {} : { updateOptions: entry.updateOptions }),
          state: 'queued',
          reason: t('agentBusyQueued'),
        })
      }
      for (const row of stale) {
        recordSeq.current += 1
        kept.push({
          id: `op-${String(recordSeq.current)}`,
          kind: row.kind,
          name: row.name,
          ...(row.url === undefined ? {} : { url: row.url }),
          // Reported, not executed and not hidden: the row is the user's, and
          // "we did not do this, here is why" is the only honest end for it.
          state: 'failed',
          reason: row.reason,
        })
      }
      return kept
    })
    setOperationsOpen(true)
  }, [data, t, lang, installedReady, installed, updateCheck, updates])
  useEffect(() => {
    // Never write before the restore has read. On the first render `records`
    // is empty, and this effect would then delete the stored queue that the
    // restore — which waits for the catalog — is about to load: every refresh
    // with a cold catalog silently lost the user's queued work. The restore is
    // this queue's only reader, so waiting for it is also what makes the
    // consume safe.
    if (!queueRestoredRef.current) return
    try {
      const queued = records
        // Host-owned rows are persisted by the Host, not replayed from this
        // key: writing them here would let a later page run the operation
        // itself and bypass the maintenance barrier (#411).
        .filter(record => record.state === 'queued' && record.hostOperationId === undefined)
        .map(record => ({ kind: record.kind, name: record.name, ...(record.url === undefined ? {} : { url: record.url }), ...(record.updateOptions === undefined ? {} : { updateOptions: record.updateOptions }) }))
      if (queued.length === 0) localStorage.removeItem('dshm-queue-v1')
      else localStorage.setItem('dshm-queue-v1', JSON.stringify(queued))
    } catch { /* storage unavailable */ }
  }, [records])
  /**
   * Finished rows survive a page load — and only finished rows.
   *
   * A failed operation is the one thing the panel cannot recover by itself:
   * after a reload the card is back to "Install", the plugin is not in
   * Installed (the host rolled the change back), and the sentence naming what
   * went wrong — plus the build-script approval that is the way out of it
   * (#314) — lived only in React state.
   *
   * The queue key owns `queued`, the dshm-pending markers own `running`, and
   * this key owns the rows that already ended. Unlike a queued row, a finished
   * one has nothing left to judge, so the restore waits for nothing — not even
   * the catalog.
   */
  const settledRestoredRef = useRef(false)
  /** The restore's merge has not reached a render yet; see the write below. */
  const settledMergePendingRef = useRef(false)
  useEffect(() => {
    if (settledRestoredRef.current) return
    settledRestoredRef.current = true
    let saved: string | null = null
    try { saved = localStorage.getItem(SETTLED_STORAGE_KEY) } catch { saved = null }
    const restored = restoreSettled(saved)
    if (restored.length === 0) return
    // Ids came from a previous mount's counter. Continue past them, or the next
    // operation reuses an id and drop/patch would address two rows at once.
    for (const record of restored) {
      const match = /^op-(\d+)$/.exec(record.id)
      if (match !== null) recordSeq.current = Math.max(recordSeq.current, Number(match[1]))
    }
    settledMergePendingRef.current = true
    setRecords(prev => {
      const known = new Set(prev.map(record => record.id))
      const missing = restored.filter(record => !known.has(record.id))
      return missing.length === 0 ? prev : [...prev, ...missing]
    })
  }, [])
  useEffect(() => {
    // Never write before the restore has read, and never write the pre-restore
    // list: on the first render `records` is empty, so a write here would
    // replace the stored rows with nothing just as the restore put them back.
    // (The queue's restore has the same hazard, for the same reason.)
    if (!settledRestoredRef.current) return
    if (settledMergePendingRef.current) {
      settledMergePendingRef.current = false
      return
    }
    try {
      const settled = serializeSettled(records)
      if (settled.length === 0) localStorage.removeItem(SETTLED_STORAGE_KEY)
      else localStorage.setItem(SETTLED_STORAGE_KEY, JSON.stringify(settled))
    } catch { /* storage unavailable — the rows just won't survive a reload */ }
  }, [records])
  /** Raised by the card marker, so "查看详情" lands on the record itself. */
  const [operationsOpen, setOperationsOpen] = useState(false)
  const openOperations = useCallback(() => setOperationsOpen(true), [])
  /**
   * Two plugins can ship under one name from different authors, so a roster
   * row that shows only the package name cannot tell the user which of their
   * plugins a swap would uninstall. Resolve through the catalog for the
   * author and avatar a card would show, and fall back to the bare name for
   * anything installed outside it.
   */
  const describePlugin = useCallback((name: string) => {
    const entry = data?.plugins.find(plugin => plugin.npm === name || plugin.name === name)
    if (entry === undefined) return { title: name }
    return {
      title: pluginName(entry.name, entry.npm),
      author: entry.owner === '' ? undefined : entry.owner,
      avatar: <OwnerAvatar name={entry.name} owner={entry.owner || ''} icon={entry.icon ?? undefined} />,
    }
  }, [data])
  /** Ids are sequential rather than random so a replayed session is stable. */
  const nextRecordId = useCallback(() => {
    recordSeq.current += 1
    return `op-${String(recordSeq.current)}`
  }, [])
  const [replacing, setReplacing] = useState(false)
  /** Shared by every screenshot source (card thumbnail, dialog strip). */
  const [lightbox, setLightbox] = useState<{ shots: string[]; index: number } | null>(null)
  const openLightbox = (shots: string[], index: number): void => setLightbox({ shots, index })
  const [themesFullscreen, setThemesFullscreen] = useState(false)
  const [busyUrl, setBusyUrl] = useState<string | null>(null)
  /** Consecutive idle polls with a pending install that never landed (#32). */
  const idleStrikes = useRef(0)
  /** Same idle-strike bookkeeping for an update whose response was lost. */
  const updateIdleStrikes = useRef(0)
  const [doneUrls, setDoneUrls] = useState<string[]>([])
  const [installError, setInstallError] = useState<string | null>(null)
  /**
   * The recovery surface, when a restart this page asked for did not come
   * back. Non-null means the origin answering /dsh-market/* is the recovery
   * server, not the host — see RecoveryPanel.tsx.
   */
  const [recovery, setRecovery] = useState<RecoveryView | null>(null)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [recoveryKeep, setRecoveryKeep] = useState<Record<string, boolean>>({})
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const [favoriteError, setFavoriteError] = useState<string | null>(null)
  /** Ignores out-of-order /dsh-market/favorite responses after a newer toggle. */
  const favoriteOpGen = useRef(0)
  const [blockError, setBlockError] = useState<string | null>(null)
  const [updateExemptError, setUpdateExemptError] = useState<string | null>(null)
  const [updateExemptNotice, setUpdateExemptNotice] = useState<string | null>(null)
  const updateExemptOpGen = useRef(0)
  /** Shown once a hide sticks, so the card vanishing has a place to look. */
  const [blockNotice, setBlockNotice] = useState<string | null>(null)
  /** Ignores out-of-order /dsh-market/block responses after a newer toggle. */
  const blockOpGen = useRef(0)
  const [pluginMenuUrl, setPluginMenuUrl] = useState<string | null>(null)
  const [installedMenuName, setInstalledMenuName] = useState<string | null>(null)
  const [clearingStale, setClearingStale] = useState(false)
  
  const [compatibilityNotice, setCompatibilityNotice] = useState<CompatibilityNotice | null>(null)
  const [rollingBack, setRollingBack] = useState(false)
  /** Log export lifecycle for visible feedback (#84): idle → busy → done/fail. */
  const [exportState, setExportState] = useState<'idle' | 'busy' | 'done' | 'fail'>('idle')

  /**
   * Programmatic log download with explicit feedback (#84) — the plain
   * `<a download>` gave no sign anything happened, and the error banner's
   * "export the log" wording pointed at text that was not clickable at all.
   * Success/failure surface as a primitives Toast (body portal, no layout
   * impact) instead of inline text.
   */
  const doExportLog = useCallback(() => {
    setExportState('busy')
    // The composing lives in self-check.ts: the error boundary offers this
    // same download, and a crashed market is exactly when the log matters.
    exportMarketLog().then(() => setExportState('done'), () => setExportState('fail'))
  }, [])
  /** Stable onDone for the export Toast — a fresh closure per render would
   * reset the Toast's auto-dismiss timer on every parent re-render. */
  const exportToastDone = useCallback(() => setExportState('idle'), [])
  const favoriteErrorDone = useCallback(() => setFavoriteError(null), [])
  const blockErrorDone = useCallback(() => setBlockError(null), [])
  const blockNoticeDone = useCallback(() => setBlockNotice(null), [])
  const updateExemptErrorDone = useCallback(() => setUpdateExemptError(null), [])
  const updateExemptNoticeDone = useCallback(() => setUpdateExemptNotice(null), [])
  /** Update reminders dismissed for this host boot. The Installed tab still
   * shows these plugins and their update actions; only proactive prompts use
   * this set. */
  const [ignoredUpdateNames, setIgnoredUpdateNames] = useState<string[]>([])
  useEffect(() => { notifyUpdatePreferencesChanged() }, [ignoredUpdateNames])
  const [updatingName, setUpdatingName] = useState<string | null>(null)
  /** Update-notes dialog (#294): which row opened it, and what it resolved to. */
  const [notesFor, setNotesFor] = useState<{ name: string; current: string | null; latest: string | null; target: string | null; repoUrl: string | null } | null>(null)
  const [updateNotes, setUpdateNotes] = useState<ResolvedNotes | null>(null)
  const [notesState, setNotesState] = useState<'loading' | 'ready' | 'fail'>('loading')
  const notesRequest = useRef<AbortController | null>(null)
  useEffect(() => () => notesRequest.current?.abort(), [])
  // Plugin blocked by pnpm's fresh-release safety wait; arms the update-now button.
  const [staleName, setStaleName] = useState<string | null>(null)
  // Local link:/file: restore — a modal asks before swapping to the catalog.
  const [restoreConfirm, setRestoreConfirm] = useState<{ name: string; entry: RegistryPlugin; verified: boolean } | null>(null)
  /** A release whose declared host requirement this host does not meet (#404). kind distinguishes the update dialog from the fresh-install dialog. */
  const [hostIncompatible, setHostIncompatible] = useState<
    {
      kind: 'update' | 'install'
      name: string
      version: string
      requirement: string | null
      hostVersion: string | null
      /** The npm package the search runs on; null when the entry has no npm name. */
      npmName: string | null
      /** Kept for the install path: the card this refusal came from. */
      plugin: RegistryPlugin | null
    } | null
  >(null)
  /**
   * The answer to "the newest release is too new for this host — what CAN I
   * install?" (#581). The dialog asks as soon as it opens, because that
   * question is the only way out it can offer: the alternative the route
   * gives (install anyway) is a decision about breaking the host, and most
   * users reaching this dialog have no way to weigh it.
   */
  // The found version carries its maturity too: a release can declare this
  // host and still be inside the release-age wait, and promising an update
  // that the server will refuse turns the dialog's one way out into a dead
  // end.
  const [findingCompat, setFindingCompat] = useState<
    | { status: 'idle' | 'loading' | 'not-found' | 'error' }
    | {
        status: 'found'
        version: string
        /** true = installable now, false = held, null = the host could not say. */
        installable: boolean | null
        releaseAgeMs: number | null
        nextMaturityAt: string | null
      }
  >({ status: 'idle' })
  const [compatRetry, setCompatRetry] = useState(0)
  // Ask the moment the dialog opens: "which version still works" is the one
  // answer that turns a refusal into a choice, and the route can only give it
  // for a plugin the catalog carries by npm name.
  useEffect(() => {
    if (hostIncompatible === null || hostIncompatible.npmName === null) {
      setFindingCompat({ status: 'idle' })
      return
    }
    const controller = new AbortController()
    setFindingCompat({ status: 'loading' })
    fetch(api('/dsh-market/find-compatible'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ npmName: hostIncompatible.npmName, upgradeOnly: hostIncompatible.kind === 'update' }),
      signal: controller.signal,
    })
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json() as {
          compatibleVersion?: string | null
          maturity?: { installable?: unknown; releaseAgeMs?: unknown; nextMaturityAt?: unknown } | null
        }
      })
      .then(data => {
        if (controller.signal.aborted) return
        if (!(typeof data.compatibleVersion === 'string' && data.compatibleVersion !== '')) {
          setFindingCompat({ status: 'not-found' })
          return
        }
        const maturity = data.maturity !== null && typeof data.maturity === 'object' ? data.maturity : null
        setFindingCompat({
          status: 'found',
          version: data.compatibleVersion,
          installable: typeof maturity?.installable === 'boolean' ? maturity.installable : null,
          releaseAgeMs: typeof maturity?.releaseAgeMs === 'number' ? maturity.releaseAgeMs : null,
          nextMaturityAt: typeof maturity?.nextMaturityAt === 'string' ? maturity.nextMaturityAt : null,
        })
      })
      .catch(() => { if (!controller.signal.aborted) setFindingCompat({ status: 'error' }) })
    return () => controller.abort()
  }, [hostIncompatible, compatRetry])
  // Older hosts answer find-compatible without a maturity object; the update
  // list already knows the same fact as heldUpdate, so fall back to it rather
  // than promising a version this host would refuse.
  const hostCompatHeldUpdate = hostIncompatible === null ? undefined : updates[hostIncompatible.npmName ?? '']
  const hostCompatHeld = findingCompat.status === 'found' && (
    findingCompat.installable === false ||
    (findingCompat.installable === null && hostCompatHeldUpdate?.heldUpdate !== undefined &&
      hostCompatHeldUpdate.heldUpdate.latest === findingCompat.version &&
      Date.parse(hostCompatHeldUpdate.heldUpdate.until) > Date.now())
  )
  const hostCompatNextMaturityAt = findingCompat.status === 'found' && findingCompat.installable === null
    ? hostCompatHeldUpdate?.heldUpdate?.until ?? null
    : findingCompat.status === 'found' ? findingCompat.nextMaturityAt : null
  const hostCompatHeldHours = hostCompatHeld && hostCompatNextMaturityAt !== null
    ? Math.max(1, Math.ceil((Date.parse(hostCompatNextMaturityAt) - Date.now()) / 3_600_000))
    : null
  const hostCompatWindowHours = findingCompat.status === 'found' && findingCompat.releaseAgeMs !== null
    ? Math.max(1, Math.round(findingCompat.releaseAgeMs / 3_600_000))
    : 24

  const [restoreBlocked, setRestoreBlocked] = useState<{ name: string; reason: 'no-catalog' | 'repo-mismatch' } | null>(null)
  // Snapshot the source switch the user agreed to review; later renders must not change it under the dialog.
  const [migrationConfirm, setMigrationConfirm] = useState<SourceMigrationConfirm | null>(null)

  /** Determinate percent parsed from pnpm's Progress line, when available. */
  const [progressPct, setProgressPct] = useState<number | null>(null)
  /**
   * Blocked build scripts from the last install or update: enables
   * approve-and-retry (#6; updates in #69). Exactly one of `plugin`
   * (retry installs it) / `updateName` (retry re-runs the update) is set.
   */
  const [buildsSkipped, setBuildsSkipped] = useState<{ plugin?: RegistryPlugin; updateName?: string; names: string[]; updateOptions?: OperationRecord['updateOptions'] } | null>(null)
  const [updatingAll, setUpdatingAll] = useState(false)
  const [updatedNames, setUpdatedNames] = useState<string[]>([])
  // #558: session-tracked updates the host actually parked behind a restart.
  // Kept separate from `updatedNames`, which doubles as the row-level
  // "updated" marker and therefore also records client-only updates that go
  // live without a restart.
  const [restartNames, setRestartNames] = useState<string[]>([])
  const [hotUrls, setHotUrls] = useState<string[]>([])
  const [hotNames, setHotNames] = useState<string[]>([])
  const [progressLine, setProgressLine] = useState<string | null>(null)
  /** Per-package activation states from /dsh-market/installed + operations. */
  const [activations, setActivationsState] = useState<Record<string, ActivationInfo>>(() => cachedActivations)
  const setActivations = useCallback(cacheState(value => { cachedActivations = value }, setActivationsState), [])
  /** #60: persisted disable list + custom groups, straight from /installed. */
  const [disabledNames, setDisabledNamesState] = useState<string[]>(() => cachedDisabledNames)
  const setDisabledNames = useCallback(cacheState(value => { cachedDisabledNames = value }, setDisabledNamesState), [])
  /** The user's own note per plugin (#347): package name → text. */
  const [notes, setNotes] = useState<Record<string, string>>({})
  /**
   * When this market installed/updated each package (#1142). Only packages
   * the market itself installed have an entry: the CLI and the host's own
   * plugins page leave nothing on disk that says when, and the row shows
   * `—` rather than guessing from a directory mtime pnpm rewrites.
   */
  const [installTimes, setInstallTimes] = useState<Record<string, InstallStamp>>({})
  /**
   * How the installed list is ordered (#1142). Its own value, NOT the
   * market's `SortField`: that one is downloads/stars/added, and none of the
   * three exist for an installed package — `added` is the catalog's
   * collection date, which is a different question from when the user
   * installed it. The choice outlives this mount (#1142) — the mirror effect
   * below keeps it in localStorage.
   */
  const [installedSort, setInstalledSort] = useState<InstalledSort>(() => readInstalledSort())
  /** Catalog URLs bookmarked for later install (#414). */
  const [favoriteUrls, setFavoriteUrlsState] = useState<string[]>(() => cachedFavoriteUrls)
  const setFavoriteUrls = useCallback(cacheState(value => { cachedFavoriteUrls = value }, setFavoriteUrlsState), [])
  /** Package names the user hid from Discover (#657). */
  const [blockedNames, setBlockedNamesState] = useState<string[]>(() => cachedBlockedNames)
  const setBlockedNames = useCallback(cacheState(value => { cachedBlockedNames = value }, setBlockedNamesState), [])
  const [updateExemptNames, setUpdateExemptNames] = useState<string[]>([])
  useEffect(() => {
    void refreshUpdateNotificationsAfterChange()
  }, [updateExemptNames, disabledNames, blockedNames])
  /** Rows the user asked to show the AUTHOR's description on, despite a note. */
  const [showTheirs, setShowTheirs] = useState<string[]>([])
  /** The row whose note is being edited, and the text in the box. */
  const [notingName, setNotingName] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  /** The disable set as of the first load; null until it arrives. */
  const loadedDisabled = useRef<Set<string> | null>(null)
  /**
   * Patch-layer flags (port of dsh-plugin-hub): packages whose bundle rows
   * the user patch layer disables / force-enables. The UI treats them as the
   * real switch state so hand-edited cordis.patch.yml toggles are visible.
   */
  const [patchDisabledNames, setPatchDisabledNames] = useState<string[]>([])
  /** Bundle packages DSH's own plugin page turned off by leaving them out of dsh.profile.bundles (#696). */
  const [unbundledNames, setUnbundledNames] = useState<string[]>([])
  const [groups, setGroups] = useState<Record<string, string[]>>({})
  const [groupOrder, setGroupOrder] = useState<string[]>([])
  /** Installed-tab sub-view: flat list or groups (All-plugins was removed —
   * it duplicated the Discover tab). */
  const [installedView, setInstalledView] = useState<'list' | 'groups'>('list')
  const [togglingName, setTogglingName] = useState<string | null>(null)
  // Group editor state (create / rename / delete / assign).
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const [renamingValue, setRenamingValue] = useState('')
  const [deletingGroup, setDeletingGroup] = useState<string | null>(null)
  /** Open add-members picker for this group name. Plugins only. */
  const [addPanel, setAddPanel] = useState<string | null>(null)
  const [addQuery, setAddQuery] = useState('')
  const [addSelected, setAddSelected] = useState<string[]>([])
  /** Group whose single theme slot is being chosen. */
  const [themePanel, setThemePanel] = useState<string | null>(null)
  const [themePick, setThemePick] = useState<string | null>(null)
  const [groupMenuFor, setGroupMenuFor] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const [assignFor, setAssignFor] = useState<string | null>(null)
  /** Structured progress from pnpm ndjson (P1-6). */
  const [progressPhase, setProgressPhase] = useState<MarketStatus['phase']>(null)
  const [progressCurrent, setProgressCurrent] = useState<string | null>(null)
  const [progressDone, setProgressDone] = useState(0)
  const [cancelling, setCancelling] = useState(false)
  /** Server-side operation lock from /dsh-market/status (#91). */
  const [hostBusy, setHostBusy] = useState(false)
  /**
   * The market's own version, shown beside the heading. Most bug reports
   * arrive as a photo of the screen, and without a version in frame the
   * first reply always has to ask which one it was.
   */
  const [version, setVersionState] = useState<string | null>(() => cachedMarketVersion)
  const setVersion = useCallback(cacheState(value => { cachedMarketVersion = value }, setVersionState), [])
  /**
   * The catalog's own build date (#712). The version on a card is the
   * catalog's copy, not a live npm lookup, so a plugin published after the
   * last refresh shows the older number — the tooltip has to say so, or
   * "npm latest" beside a number that is not npm's latest is a bug report
   * waiting to be filed. Null until the catalog answers.
   */
  const catalogUpdated = data?.updated?.trim() || null
  const catalogVersionTip = useMemo(
    () => (catalogUpdated === null
      ? t('catalogVersionUndated')
      : t('catalogVersionDated').replace('{0}', catalogUpdated)),
    [catalogUpdated, t],
  )
  /** Non-live activation results from the last operation, shown as a banner. */
  const [activationWarnings, setActivationWarnings] = useState<{ name: string; info: ActivationInfo }[]>([])
  /**
   * Installed plugins whose client asks for a config namespace nothing serves
   * (#810). Server-computed, because the answer needs one client bundle read
   * per plugin and the client cannot see a bundle's contents.
   */
  const [configNamespaceIssues, setConfigNamespaceIssues] = useState<Array<{ name: string; namespaces: string[]; ownEntryIds: string[] }>>([])
  const [hostDependencyFindings, setHostDependencyFindings] = useState<SharedHostPackageDependencyFinding[]>([])
  /** Plugin name awaiting uninstall confirmation (Modal). */
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null)
  const [agentsConfirm, setAgentsConfirm] = useState<{ name: string; kind: 'update' | 'uninstall'; run: () => void } | null>(null)
  const [removingName, setRemovingName] = useState<string | null>(null)
  const [removedCount, setRemovedCount] = useState(0)
  /** Toggles whose live fiber did not follow the switch — restart to apply. */
  const [toggleRestart, setToggleRestart] = useState(0)
  /** Last completed toggle, shown as a toast (#299). The switch and the row
   * tag already say the new state, but both live in a row the user may have
   * scrolled past — a mis-click there goes unnoticed. The toast is fixed on
   * screen, so it is the part that actually catches an accident. */
  const [toggled, setToggled] = useState<{ name: string; enabled: boolean } | null>(null)
  const toggledDone = useCallback(() => setToggled(null), [])
  /**
   * Dismissal of the host-reported restart notice, keyed to the current boot
   * so it reappears after a restart that did not happen and after any new
   * change. sessionStorage, not local: closing the tab is a fresh start.
   */
  const [restartNoticeDismissed, setRestartNoticeDismissed] = useState(false)
  /** Client-part plugins toggled this session — their UI needs a refresh. */
  const [refreshNames, setRefreshNames] = useState<string[]>([])
  const [envReady, setEnvReady] = useState(true)
  /**
   * Packages the market stopped declaring because their build could no longer
   * compose (#663). They are gone from the installed list — this is the only
   * thing that can say why, so it is read from `/status` on every poll rather
   * than folded into a one-shot reply.
   */
  const [brokenPlugins, setBrokenPlugins] = useState<Record<string, { spec?: string; reason?: string }>>({})
  const brokenPluginNames = useMemo(() => Object.keys(brokenPlugins), [brokenPlugins])
  const [dismissBrokenError, setDismissBrokenError] = useState<string | null>(null)
  /**
   * Per plugin, not one counter for the panel (#763 review).
   *
   * A shared generation made a second plugin's success swallow the first one's
   * FAILURE, so a notice the server still had stayed hidden on screen with no
   * error — the panel claimed a state the server did not have. Each name
   * carries its own counter, so only a LATER click on the SAME plugin can
   * supersede this one, and a different plugin's reply never can.
   */
  const dismissBrokenGen = useRef(new Map<string, number>())
  /**
   * Bumped by every authoritative `/installed` read. A dismiss whose reply
   * arrives after one was overtaken by that read: the panel is already showing
   * the server's truth, and rolling this failure back would put back a record
   * the read has since settled.
   */
  const installedReadGen = useRef(0)
  /** Rows with a dismiss in flight, so one row cannot queue two. */
  const [dismissingBroken, setDismissingBroken] = useState<ReadonlySet<string>>(() => new Set())
  const [envFixing, setEnvFixing] = useState(false)
  const [envFailed, setEnvFailed] = useState(false)
  const [bootId, setBootId] = useState<string | null>(null)
  const bootIdRef = useRef<string | null>(null)
  useEffect(() => {
    bootIdRef.current = bootId
    // A new host process ends the hold: its packages resolve afresh (#1253).
    restartHoldRef.current = restartHold !== null && restartHold.boot === bootId
  }, [bootId, restartHold])
  /** One-click restart (#14 by @ysyyhhh): server capability + in-flight state. */
  const [restartEnabled, setRestartEnabled] = useState(false)
  /** Supervisor the host detected around itself, when it named one (#229). */
  const [supervisor, setSupervisor] = useState<string | null>(null)
  /** Debugger latch when one-click restart must not kill the host (#447). */
  const [debuggerLatch, setDebuggerLatch] = useState<string | null>(null)
  // False when this page reaches dsh through a proxy: a restart from here is refused
  // every time, so the banner says so instead of offering a button (#782).
  const [restartReachable, setRestartReachable] = useState(true)
  const [restarting, setRestarting] = useState(false)
  const [showTop, setShowTop] = useState(false)
  const [backupBusy, setBackupBusy] = useState(false)
  const webdavInFlight = useRef(false)
  const [backupMessage, setBackupMessage] = useState<string | null>(null)
  const [backupRestored, setBackupRestored] = useState(false)
  const [pendingBackup, setPendingBackup] = useState<unknown>(null)
  const [pendingDependencies, setPendingDependencies] = useState<InstalledMap>({})
  const [webdavUrl, setWebdavUrl] = useState(initialWebdav.url)
  const [webdavUser, setWebdavUser] = useState(initialWebdav.username)
  const [webdavPassword, setWebdavPassword] = useState(initialWebdav.password)
  /**
   * Auto-backup found a configured username but no password (#1058).
   *
   * The password is never written to browser storage (deliberate), so after a
   * reload it is gone — and the daily upload then ran with an empty password
   * and failed with a bare `HTTP 401` every time the market opened. A missing
   * password is not a failure to retry blindly; it is a state the card should
   * say out loud and the auto-run should not enter.
   */
  const [webdavNeedsPassword, setWebdavNeedsPassword] = useState(false)
  const [autoBackup, setAutoBackup] = useState(initialWebdav.auto)
  // #1058: opt-in "remember password". The password itself stays on the
  // server side; the client only learns whether one is kept, and for which
  // address. undefined = not answered yet.
  const [webdavSaved, setWebdavSaved] = useState<{ remembered: boolean; url?: string; username?: string } | undefined>(undefined)
  const [rememberPassword, setRememberPassword] = useState(false)
  const webdavKept = webdavSaved?.remembered === true && webdavSaved.url === webdavUrl.trim() && webdavSaved.username === webdavUser
  const webdavPasswordUsable = webdavPassword !== '' || webdavKept
  /** GitHub token — session memory only, never written to any storage. */
  const [gistToken, setGistToken] = useState('')
  /** Gist id — persisted across reloads (non-sensitive: the Gist itself is private). */
  const [gistId, setGistId] = useState(() => {
    try { return localStorage.getItem('dshm-gist-id') ?? '' } catch { return '' }
  })
  /** Export mode: 'update' PATCHes the Gist in the field, 'create' makes a new one. */
  const [gistMode, setGistMode] = useState<'update' | 'create'>(() => {
    try { return localStorage.getItem('dshm-gist-id') ? 'update' : 'create' } catch { return 'create' }
  })
  const [gistBusy, setGistBusy] = useState(false)
  const [gistMessage, setGistMessage] = useState<string | null>(null)
  const [gistOk, setGistOk] = useState(false)
  const [gistResult, setGistResult] = useState<GistExportResult | null>(null)
  /** Export picker: open state, selected plugin names, include-config flag. */
  const [exportOpen, setExportOpen] = useState(false)
  const [exportSelection, setExportSelection] = useState<Set<string>>(new Set())
  const [exportIncludeConfig, setExportIncludeConfig] = useState(false)
  /** Export failure shown INSIDE the picker so it is never hidden behind it. */
  const [exportError, setExportError] = useState<string | null>(null)
  /** Bundle-only plugin names from /dsh-market/installed (picker list). */
  const [installedBundles, setInstalledBundlesState] = useState<string[]>(() => cachedInstalledBundles)
  const setInstalledBundles = useCallback(cacheState(value => { cachedInstalledBundles = value }, setInstalledBundlesState), [])
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const headRef = useRef<HTMLDivElement | null>(null)
  // Captured while the host page is scrolling — NOT read from scrollTop after
  // a tab/category swap. The new list is often shorter, the browser clamps
  // to 0 before this layout effect, and recomputing the pin from that 0
  // sent the page back to the host title.
  const pluginsYRef = useRef(0)
  const headFloorRef = useRef<number | null>(null)
  const catsFloorRef = useRef<number | null>(null)
  const restoringStickRef = useRef(false)
  /** Hidden file input behind the Import button (a Button can't host an <input>). */
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [sortField, setSortField] = useState<SortField>(() => readSortChoice('discover').field)
  const [sortDir, setSortDir] = useState<SortDir>(() => readSortChoice('discover').dir)
  const [timeRange, setTimeRange] = useState<TimeRange>('all')
  const setCompatibleWithHost = useCallback((next: boolean) => { discoveryScan.setEnabled(next) }, [])
  /** The profile this page is running in, for the manual command's own
   * `--profile` token (#872). The catalog's is always `web`. */
  const [profileName, setProfileName] = useState<string | null>(null)
  const compatibilityDemandOwner = useRef({})
  const [catsOpen, setCatsOpen] = useState(false)
  /** Themes tab: independent from Discover's sort/time state above — a
   * search or sort choice in one tab has no business resetting the other. */
  const [themeSortField, setThemeSortField] = useState<SortField>(() => readSortChoice('themes').field)
  const [themeSortDir, setThemeSortDir] = useState<SortDir>(() => readSortChoice('themes').dir)
  const [themeTimeRange, setThemeTimeRange] = useState<TimeRange>('all')
  const [favSortField, setFavSortField] = useState<SortField>(() => readSortChoice('favorites').field)
  const [favSortDir, setFavSortDir] = useState<SortDir>(() => readSortChoice('favorites').dir)
  const [favTimeRange, setFavTimeRange] = useState<TimeRange>('all')
  /**
   * Each list's order is a display preference, not a profile setting (#1142):
   * the choice used to live only in this component's state, so a tab switch or
   * a reload put every list back on its default. The mirror writes the value
   * that is on screen, which is why it also runs on the first render — a fresh
   * profile records the default it started from, a reloaded one records the
   * choice it restored, and neither can drift from what the user is seeing.
   *
   * localStorage rather than state.json: the same line the catalog's
   * compatibility filter (`dshm-host-filter`) and the "recently added" flags
   * (#940) take.
   */
  useEffect(() => {
    rememberSortChoice('discover', { field: sortField, dir: sortDir })
    rememberSortChoice('themes', { field: themeSortField, dir: themeSortDir })
    rememberSortChoice('favorites', { field: favSortField, dir: favSortDir })
    rememberInstalledSort(installedSort)
  }, [sortField, sortDir, themeSortField, themeSortDir, favSortField, favSortDir, installedSort])
  /** WebDAV provider-preset dropdown (primitives Menu). */
  const [presetOpen, setPresetOpen] = useState(false)
  /** Install-command disclosure inside the confirm dialog. */
  const [cmdOpen, setCmdOpen] = useState(false)
  const [capsOpen, setCapsOpen] = useState(false)
  // The capability list and the install command start closed for each plugin.
  // The lines in front of them are already visible; opening the list is a
  // separate question.
  useEffect(() => {
    setCapsOpen(false)
    setCmdOpen(false)
  }, [confirming])
  /** Per-row "why is it not live" disclosure (installed tab). */
  const [whyOpen, setWhyOpen] = useState<string | null>(null)
  /** Restore-confirm dialog (replaces window.confirm). */
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false)
  /** Plugins that failed to install during a restore (replaces window.alert). */
  const [restoreErrors, setRestoreErrors] = useState<string[]>([])
  // How many category pills fit in ONE row (measured; the panel width is
  // fixed). Collapsed shows that row; expanded shows them all. null = the
  // measuring render, where every pill is painted so the widths can be read.
  const [visibleCats, setVisibleCats] = useState<number | null>(null)
  const catsWrapRef = useRef<HTMLDivElement | null>(null)
  // Whether the sticky header is currently pinned to the top of the scroll
  // area. Tracked via a sentinel just above it rather than a scrollTop
  // threshold: the threshold would have to hard-code the header's offset
  // (padding, sticky `top`), which drifts silently whenever that CSS
  // changes. The sentinel just reports what's actually true on screen.
  const [catsStuck, setCatsStuck] = useState(false)
  /** While the sticky header is pinned, expansion is this flag — not
   * `catsOpen`. Becoming stuck collapses on the SAME render (stuckExpanded
   * starts false) instead of a follow-up `useLayoutEffect` that flipped
   * `catsOpen` and forced a second commit; that delayed height change is
   * what lined up with the host Settings dialog hitching after tab 收放.
   * An explicit chevron click while stuck sets this true and keeps
   * `catsOpen` in sync so unstuck restores the user's choice. */
  const [stuckExpanded, setStuckExpanded] = useState(false)
  const [catsSentinel, setCatsSentinel] = useState<HTMLDivElement | null>(null)
  /**
   * Latest /status sample for the queue drain: `busy` gates pnpm execution,
   * `runningAgents` gates the agent-file guard. A ref (not state) because the
   * drain interval is mount-once and must never read a stale closure.
   */
  const statusRef = useRef<{ busy: boolean; runningAgents: string[]; agentDrain: boolean; boot: string | null }>({
    busy: false,
    runningAgents: [],
    agentDrain: false,
    boot: null,
  })
  /** True while the drain is executing one queued request (no parallel starts). */
  const drainingRef = useRef(false)

  const mounted = useRef(false)
  const refreshRequest = useRef(0)
  const refreshInFlight = useRef(false)
  const bridgedNotification = useRef<UpdateNotificationsState | null>(null)
  const notificationReads = useRef(new Set<number>())
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      refreshRequest.current = 0
      refreshInFlight.current = false
      for (const request of notificationReads.current) releaseUpdateNotificationRead(request)
      notificationReads.current.clear()
    }
  }, [])

  const refreshInstalled = useCallback((force?: boolean, notification?: UpdateNotificationsState) => {
    if (!mounted.current) return
    const request = ++updateCheckRequest
    const boot = updateCheckBoot
    refreshRequest.current = request
    refreshInFlight.current = true
    if (notification === undefined) {
      bridgedNotification.current = latestNotification.current
      notificationReads.current.add(request)
      pendingUpdateNotificationReads.add(request)
    }
    const ownsRefresh = () => mounted.current && refreshRequest.current === request
    const isCurrent = () => ownsRefresh() && (boot === null || boot === updateCheckBoot)
      && (notification === undefined || updateCheckBoot === null || notification.boot === updateCheckBoot)
    setCheckingUpdates(true)
    const requestOptions = { cache: 'no-store', signal: AbortSignal.timeout(UPDATE_CHECK_REQUEST_MS) } as const
    const installRead = fetch(api('/dsh-market/installed'), requestOptions)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
        return res.json()
      })
      .then(body => {
        if (!isCurrent() || !isInstalledSnapshot(body?.installed)) return null
        const installed = body.installed
        // Each surface renders its own installed list. A newer update check
        // in a sibling surface can supersede the shared update response only.
        if (request >= installedCheckCommitted) {
          cachedInstalled = installed
          installedCheckCommitted = request
        }
        setInstalledState(installed)
        if (notification !== undefined) {
          cachedInstalledReady = true
          setInstalledReady(true)
          return installed
        }
        setLocalDescriptions(localDescriptionsFromUnknown(body.descriptions))
        setRepoIdentities(installedRepoIdentities(body.repoIdentities))
        setRepoHints(installedRepoHints(body.repoHints))
        setInstalledFiles(Array.isArray(body.present) ? body.present : Object.keys(installed))
        setSkins(body.live || [])
        if (Array.isArray(body.disabled)) {
          setDisabledNames(body.disabled)
          // The switch positions this page was BUILT with. A toggle away from
          // them needs a refresh; a toggle back to them does not, and the
          // banner has to be able to say so (#340).
          if (loadedDisabled.current === null) loadedDisabled.current = new Set(body.disabled as string[])
        }
        if (body.notes !== null && typeof body.notes === 'object' && !Array.isArray(body.notes)) {
          setNotes(body.notes as Record<string, string>)
        }
        if (body.installTimes !== null && typeof body.installTimes === 'object' && !Array.isArray(body.installTimes)) {
          const stamps: Record<string, InstallStamp> = {}
          for (const [name, raw] of Object.entries(body.installTimes as Record<string, unknown>)) {
            if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
            const record = raw as { installedAt?: unknown; updatedAt?: unknown }
            const installedAt = typeof record.installedAt === 'string' ? record.installedAt : undefined
            const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : undefined
            if (installedAt === undefined && updatedAt === undefined) continue
            stamps[name] = { ...(installedAt === undefined ? {} : { installedAt }), ...(updatedAt === undefined ? {} : { updatedAt }) }
          }
          setInstallTimes(stamps)
        }
        if (Array.isArray(body.patchDisabled)) setPatchDisabledNames(body.patchDisabled)
        if (typeof body.profile === 'string') setProfileName(body.profile)
        if (Array.isArray(body.unbundled)) setUnbundledNames(body.unbundled)
        setConfigNamespaceIssues(Array.isArray(body.configNamespaces)
          ? body.configNamespaces.filter((item: unknown): item is { name: string; namespaces: string[]; ownEntryIds: string[] } =>
              typeof item === 'object' && item !== null
              && typeof (item as { name?: unknown }).name === 'string'
              && Array.isArray((item as { namespaces?: unknown }).namespaces))
          : [])
        if (body.groups && typeof body.groups === 'object') setGroups(body.groups)
        if (Array.isArray(body.groupOrder)) setGroupOrder(body.groupOrder)
        if (Array.isArray(body.favorites)) setFavoriteUrls(body.favorites.filter((url: unknown): url is string => typeof url === 'string'))
        if (Array.isArray(body.blocked)) setBlockedNames(body.blocked.filter((name: unknown): name is string => typeof name === 'string'))
        if (Array.isArray(body.updateExempt)) setUpdateExemptNames(body.updateExempt.filter((name: unknown): name is string => typeof name === 'string'))
        setInstalledBundles(Array.isArray(body.bundles) ? body.bundles.filter((name: unknown): name is string => typeof name === 'string') : [])
        if (body.activation && typeof body.activation === 'object') setActivations(body.activation)
        const findings = body.diagnostics?.schema === 'dsh-market/diagnostics/v1'
          && Array.isArray(body.diagnostics.findings)
          ? body.diagnostics.findings.filter(isHostDependencyFinding)
          : []
        setBrokenPlugins(isRecordOfRecords(body.brokenPlugins) ? body.brokenPlugins : {})
        installedReadGen.current += 1
        setHostDependencyFindings(findings)
        cachedInstalledReady = true
        setInstalledReady(true)
        return installed
      })
      .catch(() => null)
    const updateRead = notification !== undefined
      ? Promise.resolve(notification.updates)
      : fetch(api('/dsh-market/updates') + (force === true ? '?force=1' : ''), requestOptions)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
        return res.json()
      })
      .then(readUpdateStatuses)
      .catch(() => {
        // Expose a failed update check even when /installed is still loading.
        // Reconcile any retained entries when that read has settled.
        if (isCurrent()) applyUpdateCheck(request, null, null)
        if (ownsRefresh()) { refreshInFlight.current = false; setCheckingUpdates(false) }
        return null
      })
    void Promise.all([updateRead, installRead]).then(([received, installed]) => {
      if (isCurrent()) {
        if (notification?.checkedAt === null && request >= updateCheckCommitted) {
          updateCheckCommitted = request
          publishUpdateCheck({ ...emptyUpdateCheck, installed: installed ?? {} })
        } else {
          applyUpdateCheck(request, received, installed)
          // A partial failure still carries successful results for other
          // packages. Only an unclassified failure makes the whole check unknown.
          if (notification?.error != null && request === updateCheckCommitted
            && updateCheckSnapshot.failed?.size === 0) {
            publishUpdateCheck({ ...updateCheckSnapshot, failed: null })
          }
        }
      }
      if (notification === undefined) {
        const release = () => {
          notificationReads.current.delete(request)
          releaseUpdateNotificationRead(request)
        }
        // A sample received during this check predates its result. Keep both
        // surfaces fenced until a trailing local read has passed any older GET.
        if (ownsRefresh()) void refreshUpdateNotificationsAfterChange().finally(release)
        else release()
      }
      if (ownsRefresh()) { refreshInFlight.current = false; setCheckingUpdates(false) }
    })
  }, [setActivations, setBlockedNames, setDisabledNames, setFavoriteUrls, setInstalledBundles, setInstalledFiles, setLocalDescriptions, setSkins])

  // A background result reuses the shared update snapshot, but still pairs it
  // with a fresh local inventory before restoring queued work. This reads no
  // update source and never starts a second scheduler. Manual checks keep their
  // request/boot fences and finish before a background sample is considered.
  useEffect(() => {
    if (!notificationSnapshot.loaded || notificationSnapshot.readFailed || notificationSnapshot.checking
      || refreshInFlight.current || pendingUpdateNotificationReads.size > 0
      || (updateCheckBoot !== null && notificationSnapshot.boot !== updateCheckBoot)) return
    const previous = bridgedNotification.current
    if (previous?.updates === notificationSnapshot.updates && previous.checkedAt === notificationSnapshot.checkedAt
      && previous.error === notificationSnapshot.error && previous.boot === notificationSnapshot.boot) return
    bridgedNotification.current = notificationSnapshot
    refreshInstalled(undefined, notificationSnapshot)
  }, [notificationSnapshot, checkingUpdates, updateCheck, refreshInstalled])

  /**
   * Host-owned deferred operations (#411).
   *
   * These rows are projections of `/status`, never entries in the client
   * queue: the Host owns the maintenance holds, and re-running a row here
   * would start a second mutation outside that barrier. `dshm-drain-v1`
   * remembers only which operations this page asked for, so a Host restart can
   * say "that one was cancelled" instead of leaving the user to guess.
   */
  const settledHostRef = useRef(new Set<string>())
  return {
    activationWarnings, activations, addPanel, addQuery, addSelected, agentsConfirm, assignFor,
    autoBackup, backupBusy, backupMessage, backupRestored, blockError, blockErrorDone, blockNotice,
    blockNoticeDone, blockOpGen, blockedNames, bodyRef, bootId, bootIdRef, brokenPluginNames,
    brokenPlugins, buildsSkipped, busyUrl, cancelling, capsOpen, cat, catalogVersionTip,
    catsFloorRef, catsOpen, catsSentinel, catsStuck, catsWrapRef, checkingUpdates, checkoutRecovery,
    clearingStale, cmdOpen, collapsedGroups, commentsFor, compatibility, compatibilityDemandOwner,
    compatibilityNotice, compatibleWithHost, configNamespaceIssues, confirming, creatingGroup, data,
    debuggerLatch, deletingGroup, describePlugin, disabledNames, discoverSearchReset,
    dismissBrokenError, dismissBrokenGen, dismissingBroken, doExportLog, doneUrls, drainingRef,
    enableSidebar, envFailed, envFixing, envReady, exportError, exportIncludeConfig, exportOpen,
    exportSelection, exportState, exportToastDone, favSortDir, favSortField, favTimeRange,
    favoriteError, favoriteErrorDone, favoriteOpGen, favoriteUrls, fileInputRef, findingCompat,
    gistBusy, gistId, gistMessage, gistMode, gistOk, gistResult, gistToken, groupMenuFor, groupOrder,
    groups, headFloorRef, headRef, hostBusy, hostCompatHeld, hostCompatHeldHours,
    hostCompatWindowHours, hostCompatibility, hostDependencyFindings, hostIncompatible, hostVersion,
    hotNames, hotUrls, idleStrikes, ignoredUpdateNames, installError, installTimes, installed,
    installedBundles, installedFiles, installedMenuName, installedReadGen, installedSearchReset,
    installedSort, installedView, lang, lightbox, loadError, loadedDisabled, localDescriptions,
    marketGone, migrationConfirm, mounted, mountedRef, newGroupName, nextRecordId, noteDraft, notes,
    notesFor, notesRequest, notesState, notificationSnapshot, notingName, openInHost, openLightbox,
    openOperations, operationsOpen, patchDisabledNames, pendingBackup, pendingDependencies,
    pendingUpdate, pluginMenuUrl, pluginsYRef, presetOpen, profileBlockRef, profileBlocked,
    profileName, progressCurrent, progressDone, progressLine, progressPct, progressPhase, q,
    qFavorites, qInstalled, qThemes, reconnectRound, reconnecting, records, recoveredInstall,
    recovery, recoveryBusy, recoveryKeep, recoveryOpen, refreshInstalled, refreshNames,
    refreshRequest, rememberPassword, removeConfirm, removedCount, removingName, renamingGroup,
    renamingValue, repairStatusRequest, replacing, repoHints, repoIdentities, resetDiscoverSearch,
    resetThemeSearch, restartEnabled, restartHold, restartHoldRef, restartNames,
    restartNoticeDismissed, restartReachable, restarting, restoreBlocked, restoreConfirm,
    restoreConfirmOpen, restoreErrors, restoringStickRef, rollingBack, rootRef,
    setActivationWarnings, setActivations, setAddPanel, setAddQuery, setAddSelected,
    setAgentsConfirm, setAssignFor, setAutoBackup, setBackupBusy, setBackupMessage,
    setBackupRestored, setBlockError, setBlockNotice, setBlockedNames, setBootId, setBrokenPlugins,
    setBuildsSkipped, setBusyUrl, setCancelling, setCapsOpen, setCat, setSource, source, setCatsOpen, setCatsSentinel,
    setCatsStuck, setCheckingUpdates, setCheckoutRecovery, setClearingStale, setCmdOpen,
    setCollapsedGroups, setCommentsFor, setCompatRetry, setCompatibilityNotice,
    setCompatibleWithHost, setConfirming, setCreatingGroup, setDebuggerLatch, setDeletingGroup,
    setDisabledNames, setDismissBrokenError, setDismissingBroken, setDoneUrls, setEnvFailed,
    setEnvFixing, setEnvReady, setExportError, setExportIncludeConfig, setExportOpen,
    setExportSelection, setFavSortDir, setFavSortField, setFavTimeRange, setFavoriteError,
    setFavoriteUrls, setGistBusy, setGistId, setGistMessage, setGistMode, setGistOk, setGistResult,
    setGistToken, setGroupMenuFor, setGroupOrder, setGroups, setHostBusy, setHostIncompatible,
    setHotNames, setHotUrls, setIgnoredUpdateNames, setInstallError, setInstalledMenuName,
    setInstalledSort, setInstalledView, setLightbox, setLoadError, setMarketGone,
    setMigrationConfirm, setNewGroupName, setNoteDraft, setNotes, setNotesFor, setNotesState,
    setNotingName, setOperationsOpen, setPendingBackup, setPendingDependencies, setPluginMenuUrl,
    setPresetOpen, setProgressCurrent, setProgressDone, setProgressLine, setProgressPct,
    setProgressPhase, setQ, setQFavorites, setQInstalled, setQThemes, setReconnectRound,
    setReconnecting, setRecords, setRecovery, setRecoveryBusy, setRecoveryKeep, setRecoveryOpen,
    setRefreshNames, setRememberPassword, setRemoveConfirm, setRemovedCount, setRemovingName,
    setRenamingGroup, setRenamingValue, setReplacing, setRestartEnabled, setRestartHold,
    setRestartNames, setRestartNoticeDismissed, setRestartReachable, setRestarting,
    setRestoreBlocked, setRestoreConfirm, setRestoreConfirmOpen, setRestoreErrors, setRollingBack,
    setShowTheirs, setShowTop, setSidebarTipDismissed, setSkins, setSortDir, setSortField,
    setStaleName, setStartupRepair, setStuckExpanded, setSupervisor, setTab, setThemePanel,
    setThemePick, setThemeSortDir, setThemeSortField, setThemeTimeRange, setThemesFullscreen,
    setTimeRange, setToggleRestart, setToggled, setTogglingName, setUpdateExemptError,
    setUpdateExemptNames, setUpdateExemptNotice, setUpdateNotes, setUpdatedNames, setUpdatingAll,
    setUpdatingName, setVersion, setVisibleCats, setWebdavNeedsPassword, setWebdavPassword,
    setWebdavSaved, setWebdavUrl, setWebdavUser, setWhyOpen, settledHostRef, showSidebarTip,
    showTheirs, showTop, sidebarTipError, sidebarTipSaving, skins, sortDir, sortField, staleName,
    startupRepair, statusRef, stuckExpanded, supervisor, surface, t, tab, themePanel, themePick,
    themeSearchReset, themeSnap, themeSortDir, themeSortField, themeTimeRange, themesFullscreen,
    timeRange, toggleRestart, toggled, toggledDone, togglingName, uiLocale, unbundledNames,
    updateCheck, updateExemptError, updateExemptErrorDone, updateExemptNames, updateExemptNotice,
    updateExemptNoticeDone, updateExemptOpGen, updateIdleStrikes, updateNotes, updatedNames, updates,
    updatingAll, updatingName, version, visibleCats, webdavInFlight, webdavNeedsPassword,
    webdavPassword, webdavPasswordUsable, webdavSaved, webdavUrl, webdavUser, whyOpen,
  } as const
}

export type MarketStateCtx = ReturnType<typeof useMarketState>
