/**
 * The Market settings section: Discover / Themes / Installed tabs over the
 * /dsh-market/* host routes, with install/update/uninstall flows and the
 * pending-restart bookkeeping in sessionStorage.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { Button, IconChevronDownOutline14, IconChevronUpOutline14, IconSearchOutline16, Input, Modal, Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Market.module.css'
import {
  avatarColor, entryForDep, isInstalled, looksTerminal, matchInstalledName, orderedCategories,
  pageItems, pluginScreenshots, readSession, repoOf, themePlugins as themePluginsOf, themeSwatch, TIME_RANGE_DAYS, visiblePlugins,
} from './market-data.ts'
import type {
  ActivationInfo, ActivationState, InstalledMap, MarketStatus, Registry, RegistryPlugin,
  SortDir, SortField, ThemeSnapshot, TimeRange, Translate, UpdateStatus,
} from './market-data.ts'

/** The state label + dot for one activation result (P0-2). */
function activationMeta(state: ActivationState, t: Translate): { label: string; dot: 'done' | 'warning' | 'error' } {
  if (state === 'live') return { label: t('stateLive'), dot: 'done' }
  if (state === 'restart') return { label: t('stateRestart'), dot: 'warning' }
  if (state === 'inert') return { label: t('stateInert'), dot: 'warning' }
  if (state === 'broken') return { label: t('stateBroken'), dot: 'error' }
  return { label: '—', dot: 'warning' }
}

function phaseLabel(phase: NonNullable<MarketStatus['phase']>, t: Translate): string {
  if (phase === 'resolving') return t('phaseResolving')
  if (phase === 'downloading') return t('phaseDownloading')
  if (phase === 'linking') return t('phaseLinking')
  return t('phaseBuilding')
}

/**
 * Card avatar: the plugin owner's GitHub avatar (no API, browser-cached),
 * falling back to the initial-letter tile when it can't load.
 */
function OwnerAvatar({ name, owner }: { name: string; owner: string }) {
  const [failed, setFailed] = useState(false)
  if (failed || owner === '') {
    return (
      <div className={css.av} style={{ background: avatarColor(name) }}>
        {name.replace(/^dsh[-_]/i, '').charAt(0).toUpperCase() || 'P'}
      </div>
    )
  }
  return (
    <img
      className={css.av}
      src={`https://github.com/${encodeURIComponent(owner)}.png?size=96`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

/**
 * AppStore-style screenshot strip in the install detail dialog (#61).
 * Curated registry screenshots win; otherwise images are extracted from the
 * repo README. Requests start only once the dialog opens; failures — no
 * README, no images, broken links — degrade to rendering nothing at all.
 */
function ScreenshotStrip({ plugin }: { plugin: RegistryPlugin }) {
  const [shots, setShots] = useState<string[]>([])
  const [broken, setBroken] = useState<string[]>([])
  useEffect(() => {
    let live = true
    setShots([])
    setBroken([])
    pluginScreenshots(plugin).then((list) => { if (live) setShots(list) })
    return () => { live = false }
  }, [plugin])
  const visible = shots.filter(src => !broken.includes(src))
  if (visible.length === 0) return null
  return (
    <div className={css.shots}>
      {visible.map(src => (
        <img
          key={src}
          className={css.shot}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setBroken(prev => prev.includes(src) ? prev : prev.concat(src))}
        />
      ))}
    </div>
  )
}

/**
 * Official-style market glyph: the shared block-grid brand mark converted to
 * the official monochrome icon form (16×16, fill="currentColor") so it
 * follows the active theme. Mirrors the settings-nav glyph used for the
 * "market" section id.
 */
function MarketLogo({ size = 16, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style={style}>
      <path fill="currentColor" d="M2.35 1.75H4.95A0.6 0.6 0 0 1 5.55 2.35V4.95A0.6 0.6 0 0 1 4.95 5.55H2.35A0.6 0.6 0 0 1 1.75 4.95V2.35A0.6 0.6 0 0 1 2.35 1.75ZM6.7 1.75H9.3A0.6 0.6 0 0 1 9.9 2.35V4.95A0.6 0.6 0 0 1 9.3 5.55H6.7A0.6 0.6 0 0 1 6.1 4.95V2.35A0.6 0.6 0 0 1 6.7 1.75ZM2.35 6.1H4.95A0.6 0.6 0 0 1 5.55 6.7V9.3A0.6 0.6 0 0 1 4.95 9.9H2.35A0.6 0.6 0 0 1 1.75 9.3V6.7A0.6 0.6 0 0 1 2.35 6.1ZM6.7 6.1H9.3A0.6 0.6 0 0 1 9.9 6.7V9.3A0.6 0.6 0 0 1 9.3 9.9H6.7A0.6 0.6 0 0 1 6.1 9.3V6.7A0.6 0.6 0 0 1 6.7 6.1ZM11.05 6.1H13.65A0.6 0.6 0 0 1 14.25 6.7V9.3A0.6 0.6 0 0 1 13.65 9.9H11.05A0.6 0.6 0 0 1 10.45 9.3V6.7A0.6 0.6 0 0 1 11.05 6.1ZM2.35 10.45H4.95A0.6 0.6 0 0 1 5.55 11.05V13.65A0.6 0.6 0 0 1 4.95 14.25H2.35A0.6 0.6 0 0 1 1.75 13.65V11.05A0.6 0.6 0 0 1 2.35 10.45ZM6.7 10.45H9.3A0.6 0.6 0 0 1 9.9 11.05V13.65A0.6 0.6 0 0 1 9.3 14.25H6.7A0.6 0.6 0 0 1 6.1 13.65V11.05A0.6 0.6 0 0 1 6.7 10.45ZM11.05 10.45H13.65A0.6 0.6 0 0 1 14.25 11.05V13.65A0.6 0.6 0 0 1 13.65 14.25H11.05A0.6 0.6 0 0 1 10.45 13.65V11.05A0.6 0.6 0 0 1 11.05 10.45Z" />
      <path fill="currentColor" d="M11.05 1.75H13.65A0.6 0.6 0 0 1 14.25 2.35V4.95A0.6 0.6 0 0 1 13.65 5.55H11.05A0.6 0.6 0 0 1 10.45 4.95V2.35A0.6 0.6 0 0 1 11.05 1.75Z" transform="rotate(9 12.35 3.65)" />
    </svg>
  )
}

/**
 * Module-scope caches so re-entering the section renders instantly instead
 * of refetching and rebuilding from a spinner (#30 by @StarsTom). Module
 * state survives section switches; a background refetch keeps it current.
 */
let cachedRegistry: Registry | null = null
let cachedInstalled: InstalledMap | null = null

/** Discover grid page-size choices — the catalog grows daily, so cap each page. */
const PAGE_SIZES = [24, 48, 96]
const DEFAULT_PAGE_SIZE = 24
const WEBDAV_STORAGE_KEY = 'dshm-webdav'

function savedWebdav(): { url: string; username: string; password: string; auto: boolean } {
  try {
    const value = JSON.parse(localStorage.getItem(WEBDAV_STORAGE_KEY) ?? '{}') as Record<string, unknown>
    return {
      url: typeof value.url === 'string' ? value.url : '',
      username: typeof value.username === 'string' ? value.username : '',
      // The password never persists in the browser: plugins run same-origin
      // with dshmarket, so a stored password would be readable by any plugin
      // client on this host and become the weakest credential in the profile
      // (review #63). It lives in server config / memory only.
      password: '',
      auto: value.auto === true,
    }
  } catch {
    return { url: '', username: '', password: '', auto: false }
  }
}

function backupDependencies(value: unknown): InstalledMap {
  if (value === null || typeof value !== 'object') throw new Error('invalid backup')
  const backup = value as { format?: unknown; version?: unknown; files?: unknown }
  if (backup.format !== 'dsh-profile-backup' || backup.version !== 0.2) throw new Error('unsupported backup format')
  const files = backup.files
  if (!Array.isArray(files)) throw new Error('unsupported backup format')
  const manifest = files.find(file => file !== null && typeof file === 'object' && (file as { path?: unknown }).path === 'package.json') as { json?: unknown } | undefined
  if (manifest?.json === null || typeof manifest?.json !== 'object' || Array.isArray(manifest.json)) throw new Error('backup package.json is invalid')
  const dependencies = (manifest.json as { dependencies?: unknown }).dependencies
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) return {}
  if (!Object.values(dependencies).every(spec => typeof spec === 'string')) throw new Error('backup dependencies are invalid')
  return dependencies as InstalledMap
}

/** Sort field choices in the filter panel. */
const SORT_FIELD_OPTIONS: ReadonlyArray<{ key: SortField; label: string }> = [
  { key: 'stars', label: 'sortStars' },
  { key: 'added', label: 'sortAdded' },
]

/** Sort direction choices in the filter panel (labels depend on the field). */
const SORT_DIR_OPTIONS: ReadonlyArray<SortDir> = ['desc', 'asc']

/** Published-within choices in the filter panel. */
const TIME_OPTIONS: ReadonlyArray<{ key: TimeRange; label: string }> = [
  { key: 'all', label: 'timeAll' },
  { key: 'day', label: 'timeDay' },
  { key: 'week', label: 'timeWeek' },
  { key: 'month', label: 'timeMonth' },
  { key: 'quarter', label: 'timeQuarter' },
  { key: 'year', label: 'timeYear' },
]

export interface MarketSectionProps {
  t: Translate
  locale: {
    subscribe(callback: () => void): () => void
    getSnapshot(): { active: string }
  }
  theme: { setTheme(id: string): void }
  themeStore: {
    subscribe(callback: () => void): () => void
    getSnapshot(): ThemeSnapshot | null
  }
}

export function MarketSection(props: MarketSectionProps) {
  const t = props.t
  const initialWebdav = useMemo(savedWebdav, [])
  const localeSnap = useSyncExternalStore(
    cb => props.locale.subscribe(cb),
    () => props.locale.getSnapshot(),
  )
  const lang = String(localeSnap.active).toLowerCase().startsWith('zh') ? 'zh' : 'en'
  // null when the composition has no theme service — the Themes tab hides.
  const themeSnap = useSyncExternalStore(
    props.themeStore.subscribe,
    props.themeStore.getSnapshot,
  )
  const [data, setData] = useState<Registry | null>(cachedRegistry)
  const [loadError, setLoadError] = useState(false)
  const [installed, setInstalledState] = useState<InstalledMap>(cachedInstalled ?? {})
  const setInstalled = useCallback((value: InstalledMap) => { cachedInstalled = value; setInstalledState(value) }, [])
  const [installedFiles, setInstalledFiles] = useState<string[]>([])
  const [skins, setSkins] = useState<string[]>([])
  const [tab, setTab] = useState(() => {
    const saved = sessionStorage.getItem('dshm-tab')
    if (saved !== null) sessionStorage.removeItem('dshm-tab')
    return saved || 'discover'
  })
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('all')
  const [confirming, setConfirming] = useState<RegistryPlugin | null>(null)
  const [busyUrl, setBusyUrl] = useState<string | null>(null)
  /** Consecutive idle polls with a pending install that never landed (#32). */
  const idleStrikes = useRef(0)
  const [doneUrls, setDoneUrls] = useState<string[]>([])
  const [installError, setInstallError] = useState<string | null>(null)
  const [updates, setUpdates] = useState<Record<string, UpdateStatus>>({})
  const [updatingName, setUpdatingName] = useState<string | null>(null)
  // Plugin blocked by pnpm's fresh-release safety wait; arms the update-now button.
  const [staleName, setStaleName] = useState<string | null>(null)
  /** 1-based discover page; reset to 1 whenever the list shape changes. */
  const [page, setPage] = useState(1)
  /** Cards per discover page; changing it jumps back to page 1. */
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)

  /** Determinate percent parsed from pnpm's Progress line, when available. */
  const [progressPct, setProgressPct] = useState<number | null>(null)
  /**
   * Blocked build scripts from the last install or update: enables
   * approve-and-retry (#6; updates in #69). Exactly one of `plugin`
   * (retry installs it) / `updateName` (retry re-runs the update) is set.
   */
  const [buildsSkipped, setBuildsSkipped] = useState<{ plugin?: RegistryPlugin; updateName?: string; names: string[] } | null>(null)
  const [updatingAll, setUpdatingAll] = useState(false)
  const [updatedNames, setUpdatedNames] = useState<string[]>([])
  const [hotUrls, setHotUrls] = useState<string[]>([])
  const [hotNames, setHotNames] = useState<string[]>([])
  const [progressLine, setProgressLine] = useState<string | null>(null)
  /** Per-package activation states from /dsh-market/installed + operations. */
  const [activations, setActivations] = useState<Record<string, ActivationInfo>>({})
  /** Structured progress from pnpm ndjson (P1-6). */
  const [progressPhase, setProgressPhase] = useState<MarketStatus['phase']>(null)
  const [progressCurrent, setProgressCurrent] = useState<string | null>(null)
  const [progressDone, setProgressDone] = useState(0)
  const [cancelling, setCancelling] = useState(false)
  /** Non-live activation results from the last operation, shown as a banner. */
  const [activationWarnings, setActivationWarnings] = useState<{ name: string; info: ActivationInfo }[]>([])
  const [removeArmed, setRemoveArmed] = useState<string | null>(null)
  const [removingName, setRemovingName] = useState<string | null>(null)
  const [removedCount, setRemovedCount] = useState(0)
  const [envReady, setEnvReady] = useState(true)
  const [envFixing, setEnvFixing] = useState(false)
  const [envFailed, setEnvFailed] = useState(false)
  const [bootId, setBootId] = useState<string | null>(null)
  /** One-click restart (#14 by @ysyyhhh): server capability + in-flight state. */
  const [restartEnabled, setRestartEnabled] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [showTop, setShowTop] = useState(false)
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupMessage, setBackupMessage] = useState<string | null>(null)
  const [backupRestored, setBackupRestored] = useState(false)
  const [pendingBackup, setPendingBackup] = useState<unknown>(null)
  const [pendingDependencies, setPendingDependencies] = useState<InstalledMap>({})
  const [webdavUrl, setWebdavUrl] = useState(initialWebdav.url)
  const [webdavUser, setWebdavUser] = useState(initialWebdav.username)
  const [webdavPassword, setWebdavPassword] = useState(initialWebdav.password)
  const [autoBackup, setAutoBackup] = useState(initialWebdav.auto)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [sortField, setSortField] = useState<SortField>('stars')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  /** Direction labels adapt to the field: stars → asc/desc, added → oldest/newest. */
  const sortDirLabel = (dir: SortDir): string =>
    sortField === 'added'
      ? dir === 'desc' ? 'sortNewest' : 'sortOldest'
      : dir === 'desc' ? 'sortDesc' : 'sortAsc'
  const [timeRange, setTimeRange] = useState<TimeRange>('all')
  const [filterOpen, setFilterOpen] = useState(false)
  const filterWrapRef = useRef<HTMLDivElement | null>(null)
  const [catsOpen, setCatsOpen] = useState(false)
  // How many category pills fit in the two collapsed rows (measured once —
  // the settings panel width is fixed); null = measuring render with all
  // pills clamped, then slice so the chevron flows inline after the last one.
  const [visibleCats, setVisibleCats] = useState<number | null>(null)
  const catsWrapRef = useRef<HTMLDivElement | null>(null)

  const refreshInstalled = useCallback((force?: boolean) => {
    fetch('/dsh-market/installed', { cache: 'no-store' })
      .then(res => res.json())
      .then(body => {
        setInstalled(body.installed || {})
        setInstalledFiles(Array.isArray(body.present) ? body.present : Object.keys(body.installed || {}))
        setSkins(body.live || [])
        if (body.activation && typeof body.activation === 'object') setActivations(body.activation)
      })
      .catch(() => {})
    fetch('/dsh-market/updates' + (force === true ? '?force=1' : ''), { cache: 'no-store' })
      .then(res => res.json())
      .then(body => setUpdates(body.updates || {}))
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetch('/dsh-market/registry', { cache: 'no-store' })
      .then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json() })
      .then(body => { cachedRegistry = body.registry; setData(body.registry) })
      .catch(() => setLoadError(true))
    fetch('/dsh-market/status', { cache: 'no-store' })
      .then(res => res.json())
      .then(status => {
        setEnvReady(status.pnpm !== false)
        if (typeof status.boot === 'string') setBootId(status.boot)
        setRestartEnabled(status.restart === true)
      })
      .catch(() => {})
    refreshInstalled()
  }, [refreshInstalled])

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
    if (typeof saved.removed === 'number' && saved.removed > 0) setRemovedCount(saved.removed)
  }, [bootId])

  useEffect(() => {
    if (bootId === null) return
    if (doneUrls.length === 0 && updatedNames.length === 0 && removedCount === 0) {
      // Nothing pending: drop any stale entry (e.g. a hot mount cleared the
      // only doneUrl) so a same-boot remount cannot resurrect the banner (#73).
      sessionStorage.removeItem('dshm-restart')
      return
    }
    sessionStorage.setItem('dshm-restart', JSON.stringify({
      boot: bootId,
      doneUrls,
      updated: updatedNames,
      removed: removedCount,
    }))
  }, [bootId, doneUrls, updatedNames, removedCount])

  const fixEnv = useCallback(() => {
    setEnvFixing(true)
    setEnvFailed(false)
    fetch('/dsh-market/setup-pnpm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
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
    if (pending !== null && typeof pending.url === 'string') setBusyUrl(pending.url)
  }, [])

  useEffect(() => {
    if (busyUrl === null && updatingName === null) {
      setProgressLine(null)
      setProgressPhase(null)
      setProgressCurrent(null)
      setProgressDone(0)
      setCancelling(false)
      return
    }
    const timer = setInterval(() => {
      fetch('/dsh-market/status', { cache: 'no-store' })
        .then(res => res.json())
        .then(status => {
          if (status.active) {
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
              setProgressLine((status.lastLine || '…') + '  (' + status.seconds + 's)')
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
            setInstalled(status.installed || {})
            const pending = readSession('dshm-pending')
            if (pending !== null && busyUrl !== null) {
              const nowInstalled = data !== null && data.plugins.some(p =>
                p.url === busyUrl && isInstalled(p, status.installed || {}))
              if (nowInstalled) {
                idleStrikes.current = 0
                sessionStorage.removeItem('dshm-pending')
                setDoneUrls(urls => urls.includes(busyUrl) ? urls : urls.concat(busyUrl))
                setBusyUrl(null)
              } else if (++idleStrikes.current >= 2) {
                // Host is idle and the plugin never landed: the install died
                // (e.g. exit 127) with its response lost. Without this the
                // button says "installing" forever — across reloads (#32).
                idleStrikes.current = 0
                sessionStorage.removeItem('dshm-pending')
                setBusyUrl(null)
                setInstallError(t('installFail') + ' — ' + t('exportLog'))
              }
            }
          }
        })
        .catch(() => {})
    }, 2000)
    return () => clearInterval(timer)
  }, [busyUrl, updatingName, data])

  const plugins = useMemo(
    () => (data === null ? [] : visiblePlugins(data.plugins, {
      category: cat, query: q, lang,
      sort: `${sortField}-${sortDir}`,
      sinceDays: timeRange === 'all' ? undefined : TIME_RANGE_DAYS[timeRange],
    })),
    [data, q, cat, lang, sortField, sortDir, timeRange])

  useEffect(() => { setPage(1) }, [q, cat, sortField, sortDir, timeRange])

  // Close the filter panel when the pointer leaves it.
  useEffect(() => {
    if (!filterOpen) return
    const onDown = (event: MouseEvent) => {
      if (filterWrapRef.current !== null && !filterWrapRef.current.contains(event.target as Node)) {
        setFilterOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [filterOpen])

  const totalPages = Math.max(1, Math.ceil(plugins.length / pageSize))
  // Clamp in case the list shrank while the user was on a later page.
  const currentPage = Math.min(page, totalPages)
  const pagePlugins = plugins.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  const scrollToTop = () => {
    const el = bodyRef.current
    if (el) {
      // jsdom (tests) lacks Element.scrollTo — fall back to the assignment.
      if (typeof el.scrollTo === 'function') el.scrollTo({ top: 0, behavior: 'smooth' })
      else el.scrollTop = 0
    }
  }

  const goToPage = (next: number) => {
    setPage(Math.max(1, Math.min(next, totalPages)))
    scrollToTop()
  }

  const changePageSize = (size: number) => {
    setPageSize(size)
    setPage(1)
    scrollToTop()
  }

  const doInstall = useCallback((plugin: RegistryPlugin) => {
    setBuildsSkipped(null)
    setConfirming(null)
    setInstallError(null)
    setActivationWarnings([])
    setBusyUrl(plugin.url)
    sessionStorage.setItem('dshm-pending', JSON.stringify({ url: plugin.url }))
    fetch('/dsh-market/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: plugin.url }),
    })
      .then(res => res.json().then(body => ({ status: res.status, body })))
      .then(({ status, body }) => {
        sessionStorage.removeItem('dshm-pending')
        if (status === 200 && body.ok && body.hot && plugin.category === 'theme') {
          // Themes auto-activate on install; reload straight into the Themes
          // tab so the new look is on screen immediately.
          sessionStorage.setItem('dshm-toast', JSON.stringify([plugin.name]))
          sessionStorage.setItem('dshm-tab', 'themes')
          location.reload()
          return
        }
        if (body.cancelled === true) {
          // User-cancelled: quiet reset, nothing to report.
          refreshInstalled()
          if (body.partial === true) setInstallError(t('partialNote'))
          return
        }
        if (status === 200 && body.ok) {
          sessionStorage.setItem('dshm-tab', 'installed')
          if (body.activation && typeof body.activation === 'object') {
            setActivations(prev => ({ ...prev, ...body.activation }))
            const warns = Object.entries(body.activation as Record<string, ActivationInfo>)
              .filter(([, info]) => info.state !== 'live' && info.state !== 'missing')
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
          } else {
            setDoneUrls(urls => urls.includes(plugin.url) ? urls : urls.concat(plugin.url))
          }
          refreshInstalled()
        } else {
          if (status === 409) {
            setInstallError(t('busyWait'))
            return
          }
          if (Array.isArray(body.ignoredBuilds) && body.ignoredBuilds.length > 0) {
            setBuildsSkipped({ plugin, names: body.ignoredBuilds.map(String) })
          }
          const text = (v: unknown) => typeof v === 'string' ? v : (v && typeof (v as any).text === 'string') ? (v as any).text : v == null ? '' : JSON.stringify(v)
          const detail = text(body.error) || [text(body.stderr), text(body.stdout)].filter(Boolean).join('\n').trim() || ('exit ' + body.exitCode)
          setInstallError(t('installFail') + ': ' + plugin.name + ' — ' + detail.trim().slice(-600))
        }
      })
      .catch(error => {
        sessionStorage.removeItem('dshm-pending')
        setInstallError(t('installFail') + ': ' + String(error))
      })
      .finally(() => setBusyUrl(null))
  }, [refreshInstalled, t])

  /**
   * Restart the host and reload once the boot id changes (#14 by @ysyyhhh).
   * The 202 races the process's SIGTERM, so network errors on the initial
   * request are expected and treated as "restart under way".
   */
  const doRestart = useCallback(() => {
    if (bootId === null || restarting) return
    const previousBoot = bootId
    setRestarting(true)
    setInstallError(null)
    const awaitNewBoot = () => {
      const deadline = Date.now() + 60000
      const poll = () => {
        fetch('/dsh-market/status', { cache: 'no-store' })
          .then(res => res.json())
          .then((next) => {
            if (typeof next.boot === 'string' && next.boot !== previousBoot) {
              location.reload()
              return
            }
            retry()
          })
          .catch(retry)
      }
      const retry = () => {
        if (Date.now() > deadline) {
          setRestarting(false)
          setInstallError(t('restartTimeout'))
          return
        }
        setTimeout(poll, 1500)
      }
      poll()
    }
    fetch('/dsh-market/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(res => res.json().then(body => ({ status: res.status, body })))
      .then(({ status, body }) => {
        if (status !== 202 || body.ok !== true) {
          setRestarting(false)
          setInstallError(t('restartFail') + ': ' + String(body.error || ('HTTP ' + String(status))))
          return
        }
        awaitNewBoot()
      })
      .catch(awaitNewBoot) // the host may die mid-response; keep polling
  }, [bootId, restarting, t])

  /** Cancel the running plugin command (#6 by @qichuang321). */
  const doCancel = useCallback(() => {
    fetch('/dsh-market/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .catch(() => {})
  }, [])

  const doUpdate = useCallback((name: string, force = false) => {
    setInstallError(null)
    setActivationWarnings([])
    setStaleName(null)
    setUpdatingName(name)
    return fetch('/dsh-market/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(force ? { name, force: true } : { name }),
    })
      .then(res => res.json().then(body => ({ status: res.status, body })))
      .then(({ status, body }) => {
        if (body.cancelled === true) {
          refreshInstalled()
          if (body.partial === true) setInstallError(t('partialNote'))
          return
        }
        if (status === 200 && body.ok) {
          setUpdatedNames(names => names.concat(name))
          if (body.activation && typeof body.activation === 'object') {
            setActivations(prev => ({ ...prev, ...body.activation }))
          }
          refreshInstalled()
        } else {
          if (status === 409) { setInstallError(t('busyWait')); return }
          if (body.stale === true) setStaleName(name)
          // Blocked build scripts during an update (#69): same
          // approve-and-retry banner as the install flow, retrying the update.
          if (Array.isArray(body.ignoredBuilds) && body.ignoredBuilds.length > 0) {
            setBuildsSkipped({ updateName: name, names: body.ignoredBuilds.map(String) })
          }
          const text = (v: unknown) => typeof v === 'string' ? v : (v && typeof (v as any).text === 'string') ? (v as any).text : v == null ? '' : JSON.stringify(v)
          const detail = text(body.error) || [text(body.stderr), text(body.stdout)].filter(Boolean).join('\n').trim() || ('exit ' + body.exitCode)
          setInstallError(t('updateFail') + ': ' + name + ' — ' + detail.trim().slice(-600))
        }
      })
      .catch(error => setInstallError(t('updateFail') + ': ' + String(error)))
      .finally(() => setUpdatingName(null))
  }, [refreshInstalled, t])

  const doUseSkin = useCallback((name: string) => {
    setInstallError(null)
    fetch('/dsh-market/use-skin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then(res => res.json().then(body => ({ status: res.status, body })))
      .then(({ status, body }) => {
        if (status === 200 && body.ok) {
          sessionStorage.setItem('dshm-toast', JSON.stringify([name]))
          sessionStorage.setItem('dshm-toast-mode', 'theme')
          sessionStorage.setItem('dshm-tab', 'themes')
          location.reload()
        } else {
          setInstallError(String(body.error || 'failed'))
        }
      })
      .catch(error => setInstallError(String(error)))
  }, [])

  const doUninstall = useCallback((name: string) => {
    setRemoveArmed(null)
    setInstallError(null)
    setActivationWarnings([])
    setRemovingName(name)
    return fetch('/dsh-market/uninstall', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then(res => res.json().then(body => ({ status: res.status, body })))
      .then(({ status, body }) => {
        if (status === 200 && body.ok) {
          if (!body.hot) setRemovedCount(n => n + 1)
          refreshInstalled()
        } else {
          if (body.cancelled === true) {
            refreshInstalled()
            if (body.partial === true) setInstallError(t('partialNote'))
            return
          }
          const text = (v: unknown) => typeof v === 'string' ? v : (v && typeof (v as any).text === 'string') ? (v as any).text : v == null ? '' : JSON.stringify(v)
          setInstallError((text(body.error) || text(body.stderr) || 'error').trim().slice(-600))
        }
      })
      .catch(error => setInstallError(String(error)))
      .finally(() => setRemovingName(null))
  }, [refreshInstalled])

  // The market itself stays out of the batch: its update reloads this page
  // mid-run, which would strand the remaining items.
  const selfName = installed['dshmarket'] !== undefined ? 'dshmarket' : 'dsh-market'
  const updatableNames = Object.keys(installed).filter(
    name => name !== selfName && !updatedNames.includes(name) && updates[name] && updates[name].updateAvailable,
  )

  const doUpdateAll = useCallback(() => {
    const names = updatableNames.slice()
    setUpdatingAll(true)
    const next = () => {
      const name = names.shift()
      if (name === undefined) {
        setUpdatingAll(false)
        return
      }
      doUpdate(name).then(next, next)
    }
    next()
  }, [updatableNames, doUpdate])

  const finishRestore = useCallback((body: { errors?: unknown }) => {
    const errors = Array.isArray(body.errors) ? body.errors as { name?: unknown; error?: unknown }[] : []
    if (errors.length > 0) {
      window.alert(`${t('restorePartial')}\n\n${errors.map(item => `${String(item.name)}: ${String(item.error)}`).join('\n')}`)
    }
    setBackupRestored(true)
    setBackupMessage(t('restoreDone'))
    if (errors.length === 0) {
      setPendingBackup(null)
      setPendingDependencies({})
    }
    refreshInstalled(true)
  }, [refreshInstalled, t])

  const previewBackup = useCallback((backup: unknown) => {
    const dependencies = backupDependencies(backup)
    setPendingBackup(backup)
    setPendingDependencies(dependencies)
    setBackupMessage(t('restorePreviewDone'))
    setTab('installed')
  }, [t])

  const restoreBackup = useCallback(() => {
    if (pendingBackup === null) return Promise.resolve()
    if (!window.confirm(t('restoreConfirm'))) return Promise.resolve()
    setBackupBusy(true)
    setBackupMessage(null)
    return fetch('/dsh-market/restore', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backup: pendingBackup }),
    }).then(async response => {
      const body = await response.json()
      if (!response.ok) throw new Error(String(body.error || 'restore failed'))
      finishRestore(body)
    }).catch(error => setBackupMessage(String(error))).finally(() => setBackupBusy(false))
  }, [finishRestore, pendingBackup, t])

  const runWebdav = useCallback((action: 'backup' | 'restore') => {
    if (webdavUrl.trim() === '') return
    setBackupBusy(true)
    setBackupMessage(null)
    fetch('/dsh-market/webdav', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, url: webdavUrl.trim(), username: webdavUser, password: webdavPassword }),
    }).then(async response => {
      const body = await response.json()
      if (!response.ok) throw new Error(String(body.error || 'WebDAV failed'))
      if (action === 'restore') {
        previewBackup(body.backup)
      }
      if (action === 'backup') {
        try { localStorage.setItem('dshm-webdav-last', String(Date.now())) } catch { /* storage unavailable */ }
        setBackupMessage(t('backupDone'))
      }
    }).catch(error => setBackupMessage(String(error))).finally(() => setBackupBusy(false))
  }, [previewBackup, t, webdavPassword, webdavUrl, webdavUser])

  useEffect(() => {
    // Persist only the non-secret WebDAV settings; the password stays
    // server-side/in-memory (see savedWebdav). Storage itself may be
    // unavailable (e.g. the client test env), so never let it crash the UI.
    try {
      localStorage.setItem(WEBDAV_STORAGE_KEY, JSON.stringify({ url: webdavUrl, username: webdavUser, auto: autoBackup }))
    } catch { /* storage unavailable — config just won't survive reload */ }
    if (!autoBackup || webdavUrl.trim() === '') return
    let last = 0
    try {
      last = Number(localStorage.getItem('dshm-webdav-last')) || 0
    } catch { /* ignore */ }
    if (Date.now() - last >= 24 * 60 * 60 * 1000) runWebdav('backup')
  }, [autoBackup, runWebdav, webdavUrl, webdavUser])

  const pendingRestart = doneUrls.length + updatedNames.length + removedCount + (backupRestored ? 1 : 0)
  const displayedInstalled = pendingBackup === null ? installed : { ...pendingDependencies, ...installed }
  const missingRestoreCount = Object.keys(pendingDependencies).filter(name => !installedFiles.includes(name)).length
  const hasUpdates = Object.keys(installed).some(
    name => !updatedNames.includes(name) && updates[name] && updates[name].updateAvailable,
  )

  /** Live status line: structured phase, or the human-line fallback. */
  const phasePart = progressPhase != null
    ? phaseLabel(progressPhase, t)
      + (progressCurrent !== null ? ' · ' + progressCurrent : '')
      + (progressDone > 0 ? ' · ' + t('packagesDone').replace('{0}', String(progressDone)) : '')
    : progressLine || t('progressHint')
  const progressText = cancelling ? t('cancelling') + ' · ' + phasePart : phasePart

  const themePlugins = data === null ? [] : themePluginsOf(data.plugins)

  const pluginCard = (p: RegistryPlugin) => {
    const desc = (p.description && (p.description[lang] || p.description.en)) || ''
    const done = doneUrls.includes(p.url) || hotUrls.includes(p.url)
    const already = isInstalled(p, installed)
    const busy = busyUrl === p.url
    return (
      <div key={p.url} className={css.card}>
        <div className={css.row1}>
          <OwnerAvatar name={p.name} owner={p.owner || ''} />
          <div style={{ minWidth: 0 }}>
            <div className={css.nm}>{p.name}</div>
            <div className={css.owner}>
              {p.owner}
              {typeof p.stars === 'number' && <span className={css.star}>{' · ★ ' + p.stars}</span>}
              {p.added && <span className={css.star}>{' · ' + t('published') + ' ' + p.added}</span>}
            </div>
          </div>
          <span className={css.grow} />
          <a className={css.src} href={p.url} target="_blank" rel="noreferrer" style={{ alignSelf: 'flex-start', flexShrink: 0 }}>{t('viewSource')}</a>
        </div>
        <div className={css.desc}>{desc}</div>
        <div className={css.foot}>
          <span className={css.tag}>
            {(data!.categories[p.category] && (data!.categories[p.category]![lang] || data!.categories[p.category]!.en)) || p.category}
          </span>
          <span className={css.grow} />
          {done
            ? <span className={css.okState}>{t('installedBadge')}</span>
            : already
              ? <span className={css.okState}>{t('alreadyInstalled')}</span>
              : busy
                ? <Button variant="primary" size="sm" disabled>{t('installing')}</Button>
                : (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busyUrl !== null || !envReady}
                      onClick={() => setConfirming(p)}
                    >{t('install')}</Button>
                  )}
        </div>
        {busy && (
          <div className={css.progress}>
            <span className={css.spin} />
            <code className={css.grow}>{progressText}</code>
            {progressPct !== null && <span className={css.pct}>{progressPct}%</span>}
            <button type="button" className={css.cancelBtn} disabled={cancelling} onClick={doCancel}>
              {cancelling ? t('cancelling') : t('cancelOp')}
            </button>
            <div className={css.bar}>
              <div
                className={progressPct !== null ? css.barFill : `${css.barFill} ${css.barWave}`}
                style={progressPct !== null ? { width: `${progressPct}%` } : undefined}
              />
            </div>
          </div>
        )}
      </div>
    )
  }

  const installedNameOf = (p: RegistryPlugin) => matchInstalledName(p, installed)

  // Plugins loaded at boot (bundle-layer skins) aren't in the shim list but
  // are just as live; the boot manifest is the page's own record of them.
  const bootEntries = (typeof window !== 'undefined' && window.__DSH_BOOT__ && Array.isArray(window.__DSH_BOOT__.entries))
    ? window.__DSH_BOOT__.entries
    : []

  // Unified card for the Themes tab: install → use/in-use → uninstall.
  const themePluginCard = (p: RegistryPlugin) => {
    const instName = installedNameOf(p)
    if (instName === null) return pluginCard(p)
    const mounted = skins.includes(instName) || bootEntries.some(e => e.id === instName)
    const desc = (p.description && (p.description[lang] || p.description.en)) || ''
    return (
      <div key={p.url} className={css.card}>
        <div className={css.row1}>
          <OwnerAvatar name={p.name} owner={p.owner || ''} />
          <div style={{ minWidth: 0 }}>
            <div className={css.nm}>{p.name}</div>
            <div className={css.owner}>
              {p.owner}
              {typeof p.stars === 'number' && <span className={css.star}>{' · ★ ' + p.stars}</span>}
              {p.added && <span className={css.star}>{' · ' + t('published') + ' ' + p.added}</span>}
            </div>
          </div>
          <span className={css.grow} />
          <a className={css.src} href={p.url} target="_blank" rel="noreferrer" style={{ alignSelf: 'flex-start', flexShrink: 0 }}>{t('viewSource')}</a>
        </div>
        <div className={css.desc}>{desc}</div>
        <div className={css.foot}>
          <span className={css.grow} />
          {removingName === instName
            ? <Button variant="outline" size="sm" className={css.dangerBtn} disabled>{t('uninstalling')}</Button>
            : removeArmed === instName
              ? (
                  <Button
                    variant="primary"
                    size="sm"
                    className={css.dangerArmed}
                    onClick={() => doUninstall(instName).then(() => {
                      if (mounted) {
                        sessionStorage.setItem('dshm-tab', 'themes')
                        location.reload()
                      }
                    })}
                  >{t('confirmRemove')}</Button>
                )
              : <Button variant="outline" size="sm" className={css.dangerBtn} onClick={() => setRemoveArmed(instName)}>{t('uninstall')}</Button>}
          {mounted
            ? <span className={css.okState}>{t('themeActive')}</span>
            : <Button variant="primary" size="sm" onClick={() => doUseSkin(instName)}>{t('themeApply')}</Button>}
        </div>
      </div>
    )
  }

  const themeCard = (id: string, label: string, swatch: string[]) => {
    const active = themeSnap !== null && themeSnap.preference === id
    return (
      <div key={'th-' + id} className={css.card}>
        <div className={css.swatches}>{swatch.map((c, i) => <i key={i} style={{ background: c }} />)}</div>
        <div className={css.foot}>
          <span className={css.nm}>{label}</span>
          <span className={css.grow} />
          {active
            ? <span className={css.okState}>{t('themeActive')}</span>
            : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => { try { props.theme.setTheme(id) } catch (error) { setInstallError(String(error)) } }}
                >{t('themeApply')}</Button>
              )}
        </div>
      </div>
    )
  }

  const categories = data === null ? [] : Object.keys(data.categories)

  useLayoutEffect(() => { setVisibleCats(null) }, [lang, categories.length])
  useLayoutEffect(() => {
    if (catsOpen || visibleCats !== null) return
    const el = catsWrapRef.current
    if (el === null) return
    const chips = [...el.children].filter((c): c is HTMLElement => (c as HTMLElement).dataset?.chip === '1')
    if (chips.length === 0) return
    const first = chips[0]!
    const rowThreeTop = first.offsetTop + (first.offsetHeight + 6) * 2 - 3
    let fits = 0
    for (const chip of chips) { if (chip.offsetTop < rowThreeTop) fits += 1 }
    // Reserve the tail slot of row two for the chevron itself.
    setVisibleCats(fits >= chips.length ? fits : Math.max(1, fits - 1))
  }, [catsOpen, visibleCats, data])

  return (
    <div className={css.root}>
      <div className={css.head}>
        <div className={css.titleRow}>
          <MarketLogo size={22} style={{ flexShrink: 0 }} />
          <h2 className={css.title}>{t('nav')}</h2>
          {(() => {
            const self = installed['dshmarket'] !== undefined ? 'dshmarket' : 'dsh-market'
            return updates[self] && updates[self].updateAvailable && !updatedNames.includes(self)
              && (
                <Button
                  variant="primary"
                  size="sm"
                  className={css.warnBtn}
                  disabled={updatingName !== null || busyUrl !== null}
                  onClick={() => { setTab('installed'); doUpdate(self) }}
                >{updatingName === self ? t('updating') : t('marketUpdate')}</Button>
              )
          })()}
          {updatableNames.length >= 2 && (
            <Button
              variant="primary"
              size="sm"
              className={css.warnBtn}
              disabled={updatingAll || updatingName !== null || busyUrl !== null || removingName !== null}
              onClick={() => { setTab('installed'); doUpdateAll() }}
            >{updatingAll ? t('updating') : t('updateAll') + ' (' + updatableNames.length + ')'}</Button>
          )}
        </div>
        <div className={css.sub}>
          {t('subtitle') + (data ? ' · ' + data.count : '') + ' · '}
          <a className={css.src} href="/dsh-market/logs" download="dsh-market-log.txt">{t('exportLog')}</a>
        </div>
        <div className={css.tabs}>
          <button className={tab === 'discover' ? `${css.tab} ${css.on}` : css.tab} onClick={() => setTab('discover')}>{t('tabDiscover')}</button>
          {themeSnap !== null && <button className={tab === 'themes' ? `${css.tab} ${css.on}` : css.tab} onClick={() => setTab('themes')}>{t('tabThemes')}</button>}
          <button className={tab === 'installed' ? `${css.tab} ${css.on}` : css.tab} onClick={() => { setTab('installed'); refreshInstalled(true) }}>
            {t('tabInstalled') + (Object.keys(installed).length > 0 ? ' (' + Object.keys(installed).length + ')' : '')}
            {hasUpdates && <StateDot state="error" size={7} className={css.dot} />}
          </button>
          <button className={tab === 'backup' ? `${css.tab} ${css.on}` : css.tab} onClick={() => setTab('backup')}>{t('tabBackup')}</button>
          <span className={css.grow} />
          {tab !== 'backup' && <Input className={css.searchInline} icon={<IconSearchOutline16 size={14} />} placeholder={t('searchPh')} value={q} onChange={e => setQ(e.target.value)} />}
        </div>
        {!envReady && (
          <div className={css.restart}>
            <span>🧩</span>
            <span className={css.grow}>{envFailed ? t('envFixFail') : t('envMissing')}</span>
            {!envFailed && (
              <Button variant="primary" size="sm" disabled={envFixing} onClick={fixEnv}>
                {envFixing ? t('envFixing') : t('envFix')}
              </Button>
            )}
          </div>
        )}
        {tab === 'installed' && pendingBackup !== null && (
          <div className={css.restart}>
            <span>↺</span>
            <span className={css.grow}>{t('restoreMissing').replace('{0}', String(missingRestoreCount))}</span>
            <Button variant="primary" size="sm" disabled={backupBusy} onClick={restoreBackup}>
              {backupBusy ? t('backupWorking') : t('restoreStart')}
            </Button>
          </div>
        )}
        {hotUrls.length > 0 && (
          <div className={css.restart}>
            <span>✨</span>
            <span className={css.grow}><b>{hotUrls.length}</b> {t('hotBanner')}</span>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                sessionStorage.setItem('dshm-toast', JSON.stringify(hotNames))
                sessionStorage.setItem('dshm-tab', 'installed')
                location.reload()
              }}
            >{t('refresh')}</Button>
          </div>
        )}
        {pendingRestart > 0 && (
          <div className={css.restart}>
            <span>🔄</span>
            <span className={css.grow}><b>{pendingRestart}</b> {t('restartBanner')}</span>
            <span title={t('restartHint')}>ℹ️</span>
            {restartEnabled && (
              <Button
                variant="primary"
                size="sm"
                disabled={restarting || busyUrl !== null || updatingName !== null || removingName !== null}
                onClick={doRestart}
              >{restarting ? t('restarting') : t('restartNow')}</Button>
            )}
          </div>
        )}
        {activationWarnings.length > 0 && (
          <div className={css.restart}>
            <span>⚠️</span>
            <span className={css.grow}>
              {activationWarnings.map(({ name, info }) => (
                <div key={name}>
                  <b>{name}</b> — {activationMeta(info.state, t).label}
                  {info.reasons.length > 0 && <span className={css.spec}>（{info.reasons.join(' / ')}）</span>}
                </div>
              ))}
            </span>
          </div>
        )}
      </div>
      {buildsSkipped !== null && (
        <div className={css.restart}>
          <span className={css.grow}>{t('buildsSkipped')} {buildsSkipped.names.join(', ')}</span>
          <Button
            size="sm"
            disabled={busyUrl !== null}
            onClick={() => {
              const { plugin, updateName, names } = buildsSkipped
              setBuildsSkipped(null)
              fetch('/dsh-market/approve-builds', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ packages: names }),
              })
                .then(res => res.json())
                .then((body) => {
                  if (!body.ok) setInstallError(String(body.error || 'approve failed'))
                  else if (plugin !== undefined) doInstall(plugin)
                  else if (updateName !== undefined) doUpdate(updateName)
                })
                .catch(error => setInstallError(String(error)))
            }}
          >{t('approveBuilds')}</Button>
        </div>
      )}
      {installError !== null && (
        <div className={css.err}>
          {installError}
          {staleName !== null && (
            <div className={css.staleAction}>
              <Button size="sm" onClick={() => doUpdate(staleName, true)}>{t('updateNow')}</Button>
            </div>
          )}
        </div>
      )}
      <div
        className={css.body}
        ref={bodyRef}
        onScroll={e => setShowTop(e.currentTarget.scrollTop > 400)}
      >
        {tab === 'backup'
          ? (
              <div className={css.backupGrid}>
                <section className={css.backupCard}>
                  <h3>{t('backupLocal')}</h3>
                  <p>{t('backupHint')}</p>
                  <p className={css.backupWarn}>{t('credsWarning')}</p>
                  <div className={css.backupActions}>
                    <a className={`${css.backupButton} ${css.backupPrimary}`} href="/dsh-market/backup" download aria-disabled={backupBusy}>{t('backupDownload')}</a>
                    <label className={css.backupButton} aria-disabled={backupBusy}>
                      {backupBusy ? t('backupWorking') : t('backupImport')}
                      <input
                        type="file"
                        accept="application/json,.json"
                        disabled={backupBusy}
                        onChange={event => {
                          const file = event.currentTarget.files?.[0]
                          event.currentTarget.value = ''
                          if (file !== undefined) file.text().then(text => previewBackup(JSON.parse(text))).catch(error => setBackupMessage(String(error)))
                        }}
                      />
                    </label>
                  </div>
                </section>
                <section className={css.backupCard}>
                  <h3>{t('webdav')}</h3>
                  <select
                    className={css.backupInput}
                    aria-label={t('webdavPreset')}
                    defaultValue=""
                    onChange={event => {
                      const urls: Record<string, string> = {
                        jianguoyun: 'https://dav.jianguoyun.com/dav/dsh-profile-backup.json',
                        koofr: 'https://app.koofr.net/dav/Koofr/dsh-profile-backup.json',
                        nextcloud: 'https://nextcloud.example/remote.php/dav/files/USERNAME/dsh-profile-backup.json',
                      }
                      if (urls[event.target.value] !== undefined) setWebdavUrl(urls[event.target.value]!)
                    }}
                  >
                    <option value="">{t('webdavPreset')}</option>
                    <option value="jianguoyun">坚果云 / Nutstore</option>
                    <option value="koofr">Koofr</option>
                    <option value="nextcloud">Nextcloud</option>
                  </select>
                  <input className={css.backupInput} type="url" value={webdavUrl} placeholder={t('webdavUrl')} onChange={e => setWebdavUrl(e.target.value)} />
                  <input className={css.backupInput} autoComplete="username" value={webdavUser} placeholder={t('webdavUser')} onChange={e => setWebdavUser(e.target.value)} />
                  <input className={css.backupInput} type="password" autoComplete="current-password" value={webdavPassword} placeholder={t('webdavPassword')} onChange={e => setWebdavPassword(e.target.value)} />
                  <div className={css.backupActions}>
                    <Button variant="primary" size="sm" disabled={backupBusy || webdavUrl.trim() === ''} onClick={() => runWebdav('backup')}>{backupBusy ? t('backupWorking') : t('webdavUpload')}</Button>
                    <Button variant="outline" size="sm" disabled={backupBusy || webdavUrl.trim() === ''} onClick={() => runWebdav('restore')}>{t('webdavRestore')}</Button>
                  </div>
                  <label className={css.backupCheck}><input type="checkbox" checked={autoBackup} onChange={e => setAutoBackup(e.target.checked)} />{t('autoBackup')}</label>
                  <p>{t('webdavNote')}</p>
                  <p className={css.backupWarn}>{t('credsWarning')}</p>
                </section>
                {backupMessage !== null && <div className={css.backupMessage}>{backupMessage}</div>}
              </div>
            )
          : tab === 'discover'
          ? loadError
            ? <div className={css.empty}>{t('loadFail')}</div>
            : data === null
              ? <div className={css.loading}><span className={css.spin} />{t('loading')}</div>
              : (
                  <>
                    <div className={css.cats}>
                      <div className={css.catsRow}>
                      <div ref={catsWrapRef} className={catsOpen || visibleCats === null ? `${css.catsWrap} ${css.catsCollapsed}` : css.catsWrap}>
                        {(() => {
                          // Collapsed, the selected category is pulled to the front so it never hides.
                          const ordered = orderedCategories(categories, cat, catsOpen)
                          const shown = catsOpen || visibleCats === null ? ordered : ordered.slice(0, Math.max(0, visibleCats - 1))
                          return (
                            <>
                              <Pill data-chip="1" active={cat === 'all'} onClick={() => setCat('all')}>{t('all')}</Pill>
                              {shown.map(id => (
                                <Pill
                                  key={id}
                                  data-chip="1"
                                  active={cat === id}
                                  onClick={() => setCat(id)}
                                >{(data.categories[id] && (data.categories[id]![lang] || data.categories[id]!.en)) || id}</Pill>
                              ))}
                              <Button
                                variant="ghost"
                                size="sm"
                                className={css.catsToggle}
                                icon={catsOpen ? <IconChevronUpOutline14 size={14} /> : <IconChevronDownOutline14 size={14} />}
                                aria-label={catsOpen ? t('catsLess') : t('catsMore')}
                                onClick={() => setCatsOpen(o => !o)}
                              />
                            </>
                          )
                        })()}
                      </div>
                      <div className={css.filterWrap} ref={filterWrapRef}>
                        <button
                          type="button"
                          className={filterOpen ? `${css.filterBtn} ${css.filterBtnOn}` : css.filterBtn}
                          onClick={() => setFilterOpen(o => !o)}
                        >{t('filter')}
                          {filterOpen ? <IconChevronUpOutline14 size={14} /> : <IconChevronDownOutline14 size={14} />}
                        </button>
                        {filterOpen && (
                          <div className={css.filterPanel}>
                            <div className={css.filterGroup}>
                              <div className={css.filterTitle}>{t('filterSort')}</div>
                              {SORT_FIELD_OPTIONS.map(opt => (
                                <label key={opt.key} className={css.filterOption}>
                                  <input
                                    type="radio"
                                    name="dshm-sort-field"
                                    checked={sortField === opt.key}
                                    onChange={() => setSortField(opt.key)}
                                  />
                                  <span>{t(opt.label)}</span>
                                </label>
                              ))}
                            </div>
                            <div className={css.filterGroup}>
                              <div className={css.filterTitle}>{t('filterDir')}</div>
                              {SORT_DIR_OPTIONS.map(dir => (
                                <label key={dir} className={css.filterOption}>
                                  <input
                                    type="radio"
                                    name="dshm-sort-dir"
                                    checked={sortDir === dir}
                                    onChange={() => setSortDir(dir)}
                                  />
                                  <span>{t(sortDirLabel(dir))}</span>
                                </label>
                              ))}
                            </div>
                            <div className={css.filterGroup}>
                              <div className={css.filterTitle}>{t('filterTime')}</div>
                              {TIME_OPTIONS.map(opt => (
                                <label key={opt.key} className={css.filterOption}>
                                  <input
                                    type="radio"
                                    name="dshm-time"
                                    checked={timeRange === opt.key}
                                    onChange={() => setTimeRange(opt.key)}
                                  />
                                  <span>{t(opt.label)}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                      </div>
                    </div>
                    {plugins.length === 0
                      ? <div className={css.empty}>{t('empty')}</div>
                      : (
                          <>
                            <div className={css.grid}>{pagePlugins.map(pluginCard)}</div>
                            <div className={css.pager}>
                              <div className={css.pagerPages}>
                                {totalPages > 1 && (
                                  <>
                                    <button type="button" className={css.pageBtn} disabled={currentPage === 1} onClick={() => goToPage(1)} aria-label={t('firstPage')}>«</button>
                                    <button type="button" className={css.pageBtn} disabled={currentPage === 1} onClick={() => goToPage(currentPage - 1)}>{t('prevPage')}</button>
                                    {pageItems(currentPage, totalPages).map((item, i) => (
                                      item === '…'
                                        ? <span key={'e' + i} className={css.pageEllipsis}>…</span>
                                        : (
                                            <button
                                              key={item}
                                              type="button"
                                              className={item === currentPage ? `${css.pageBtn} ${css.pageOn}` : css.pageBtn}
                                              onClick={() => goToPage(item)}
                                            >{item}</button>
                                          )
                                    ))}
                                    <button type="button" className={css.pageBtn} disabled={currentPage === totalPages} onClick={() => goToPage(currentPage + 1)}>{t('nextPage')}</button>
                                    <button type="button" className={css.pageBtn} disabled={currentPage === totalPages} onClick={() => goToPage(totalPages)} aria-label={t('lastPage')}>»</button>
                                    <span className={css.pageInfo}>{t('pageInfo').replace('{0}', String(currentPage)).replace('{1}', String(totalPages))}</span>
                                  </>
                                )}
                              </div>
                              <div className={css.pagerSize}>
                                <span className={css.sizeLabel}>{t('perPage')}</span>
                                {PAGE_SIZES.map(size => (
                                  <button
                                    key={size}
                                    type="button"
                                    className={size === pageSize ? `${css.sizeBtn} ${css.sizeOn}` : css.sizeBtn}
                                    onClick={() => changePageSize(size)}
                                  >{size}</button>
                                ))}
                              </div>
                            </div>
                          </>
                        )}
                  </>
                )
          : tab === 'themes' && themeSnap !== null
            ? (
                <>
                  {/* Light/dark/system live in the official Appearance setting; this
                    tab only shows what that setting can't: registered third-party
                    palettes (none in the wild yet) and installable theme plugins. */}
                  {(() => {
                    const extra = themeSnap.themes.filter(def => def.id !== 'light' && def.id !== 'dark')
                    return extra.length > 0 && (
                      <div className={`${css.grid} ${css.themesGrid}`}>
                        {extra.map(def => themeCard(def.id, def.id, themeSwatch(def)))}
                      </div>
                    )
                  })()}
                  {data === null
                    ? <div className={css.loading}><span className={css.spin} />{t('loading')}</div>
                    : themePlugins.length === 0
                      ? <div className={css.empty}>{t('themeEmpty')}</div>
                      : <div className={css.grid}>{themePlugins.map(themePluginCard)}</div>}
                </>
              )
            : Object.keys(displayedInstalled).length === 0
              ? <div className={css.empty}>{t('installedEmpty')}</div>
              : Object.entries(displayedInstalled).map(([name, spec]) => {
                  const missing = pendingBackup !== null && !installedFiles.includes(name)
                  const entry = data === null ? undefined : entryForDep(data.plugins, name, String(spec))
                  const status = updates[name]
                  const act = activations[name]
                  const meta = act !== undefined ? activationMeta(act.state, t) : null
                  const version = status && status.version ? 'v' + status.version : ''
                  const specText = String(spec)
                  const ghSpec = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#|$)/.exec(specText)
                  const repoUrl = entry !== undefined ? entry.url : ghSpec !== null ? 'https://github.com/' + ghSpec[1] : null
                  return (
                    <div key={name} className={missing ? `${css.irow} ${css.irowMissing}` : css.irow}>
                      <div style={{ minWidth: 0 }}>
                        <div className={css.nm}>{name}{version && <span className={css.owner}>{' ' + version}</span>}</div>
                        {repoUrl !== null
                          ? <a className={`${css.spec} ${css.src}`} href={repoUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-block' }}>{specText}</a>
                          : <div className={css.spec}>{specText}</div>}
                        {entry !== undefined && (
                          <div className={`${css.desc} ${css.descTight}`}>
                            {(entry.description && (entry.description[lang] || entry.description.en)) || ''}
                          </div>
                        )}
                        {act !== undefined && meta !== null && (
                          <div className={css.act}>
                            <span
                              className={meta.dot === 'done' ? css.actLive : meta.dot === 'error' ? css.actBroken : css.actWarn}
                            >
                              <StateDot state={meta.dot} size={7} />
                              {meta.label}
                            </span>
                            {act.state !== 'live' && act.reasons.length > 0 && (
                              <details className={css.actWhy}>
                                <summary>{t('actWhy')}</summary>
                                <div className={css.spec}>{act.reasons.join(' / ')}</div>
                              </details>
                            )}
                          </div>
                        )}
                        {updatingName === name && (
                          <div className={css.progress}>
                            <span className={css.spin} />
                            <code className={css.grow}>{progressText}</code>
                            {progressPct !== null && <span className={css.pct}>{progressPct}%</span>}
                            <button type="button" className={css.cancelBtn} disabled={cancelling} onClick={doCancel}>
                              {cancelling ? t('cancelling') : t('cancelOp')}
                            </button>
                            <div className={css.bar}>
                              <div
                                className={progressPct !== null ? css.barFill : `${css.barFill} ${css.barWave}`}
                                style={progressPct !== null ? { width: `${progressPct}%` } : undefined}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                      <span className={css.grow} />
                      {repoUrl !== null && <a className={css.src} href={repoUrl + '#readme'} target="_blank" rel="noreferrer">{t('readme')}</a>}
                      {missing
                        ? <span className={css.owner}>{t('notInstalled')}</span>
                        : updatedNames.includes(name)
                        ? <span className={css.okState}>{act?.state === 'live' ? t('updatedLive') : t('updated')}</span>
                        : updatingName === name
                          ? <Button variant="primary" size="sm" className={css.warnBtn} disabled>{t('updating')}</Button>
                          : status && status.updateAvailable
                            ? (
                                <Button
                                  variant="primary"
                                  size="sm"
                                  className={css.warnBtn}
                                  disabled={updatingName !== null}
                                  onClick={() => doUpdate(name)}
                                >{t('update')}</Button>
                              )
                            : status && status.kind === 'linked'
                              ? <span className={css.owner}>{t('linkedDev')}</span>
                              : <span className={css.owner}>{t('upToDate')}</span>}
                      {!missing && name !== 'dsh-market' && name !== 'dshmarket' && (
                        removingName === name
                          ? <Button variant="outline" size="sm" className={css.dangerBtn} disabled>{t('uninstalling')}</Button>
                          : removeArmed === name
                            ? (
                                <Button
                                  variant="primary"
                                  size="sm"
                                  className={css.dangerArmed}
                                  onClick={() => doUninstall(name)}
                                  onMouseLeave={() => setRemoveArmed(null)}
                                >{t('confirmRemove')}</Button>
                              )
                            : (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className={css.dangerBtn}
                                  disabled={removingName !== null || busyUrl !== null || updatingName !== null}
                                  onClick={() => setRemoveArmed(name)}
                                >{t('uninstall')}</Button>
                              )
                      )}
                    </div>
                  )
                })}
      </div>
      {showTop && (
        <button
          className={css.top}
          title={t('backTop')}
          onClick={() => { const el = bodyRef.current; if (el) el.scrollTo({ top: 0, behavior: 'smooth' }) }}
        >↑</button>
      )}
      {confirming !== null && (
        <Modal
          open
          onClose={() => setConfirming(null)}
          title={t('confirmTitle') + ' ' + confirming.name + '?'}
          description={(confirming.description && (confirming.description[lang] || confirming.description.en)) || ''}
          footer={(
            <>
              <Button variant="ghost" onClick={() => setConfirming(null)}>{t('cancel')}</Button>
              <Button variant="primary" onClick={() => doInstall(confirming)}>{t('confirm')}</Button>
            </>
          )}
        >
          <ScreenshotStrip plugin={confirming} />
          <details className={css.cmdDetails}>
            <summary className={css.cmdSummary}>{t('cmdDetails')}</summary>
            <div className={css.cmd}>{confirming.install}</div>
          </details>
          {looksTerminal(confirming, lang) && (
            <p className={css.warnLine}>
              {'🖥️ ' + t('terminalWarn') + ' '}
              <a className={css.src} href={confirming.url + '#readme'} target="_blank" rel="noreferrer">{t('readme')}</a>
            </p>
          )}
          <p className={css.modalNote}>{'⚠️ ' + t('confirmWarn')}</p>
        </Modal>
      )}
    </div>
  )
}
