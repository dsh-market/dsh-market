/**
 * The market's card on the plugin configuration page (dsh >= 0.1.0-rc.7).
 *
 * It manages the market ITSELF — version, update, remove — when the current
 * profile owns the dependency. A host-provided market keeps only its version
 * display and download-region controls. This page is where a user goes to deal
 * with a plugin,
 * and "which version am I on / update it / get rid of it" is the part of
 * that anybody can act on without knowing how DSH is put together.
 *
 * `allowRestart` deliberately does NOT appear here. It exists for hosts
 * where a supervisor (systemd, launchd, pm2, Docker `restart: always`, a
 * desktop wrapper) owns the process, and its audience is whoever wrote that
 * deployment — a person already editing config, not someone browsing
 * settings. As a switch it read as jargon to everyone else, which is worse
 * than absent: a control you cannot evaluate is a control you cannot safely
 * touch. It remains a config option.
 *
 * ## Why the chrome is hand-built (again), and why it now matches
 *
 * The host's own contract is that "a plugin that ships a browser half owns
 * its own card" — the plugins tab only lays out a flex column and dispatches
 * `settings.plugin.item`. So the container IS ours to draw, and a value
 * import from `dsh-client-ui-settings-plugins` would fail the client
 * bundle-purity gate anyway.
 *
 * What the first version got wrong was drawing something of its own
 * invention: a flat, always-expanded box next to rows that collapse and
 * carry a chevron. The fix is not a different component — `DisclosureRow` is
 * 24px chrome for compact flow rows, a different thing — but the same design
 * tokens, laid out the way the host lays out `PluginCard`. Classes below
 * mirror it one for one, so the market stops looking like it wandered in
 * from another product.
 */

import { createElement as h, Fragment, useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronDownOutline14, IconLoadingOutline16 } from './icons.ts'
import css from './Market.module.css'
import { api, applyGithubRouting } from './market-data.ts'
import type { MarketStatus } from './market-data.ts'
import type { Translate } from './market-data.ts'
import type { SidebarEntry } from './sidebar-entry.ts'
import type { EntryKey, EntryVisibility } from './entry-visibility.ts'

/** Keys the market leaves in the browser; cleared when the user purges. */
const BROWSER_KEYS = ['dshm-webdav', 'dshm-gist-id'] as const

export interface SettingsCardProps {
  t: Translate
  /**
   * Retire the market's own entry in the left settings menu.
   *
   * Called once the package is gone. Leaving "插件市场" in the menu after
   * the user removed it is the card asserting something the profile no
   * longer agrees with — and the section behind it can no longer talk to a
   * server that has disposed its routes.
   */
  onRemoved?: () => void
  /** The opt-in sidebar row (#846); absent, the card offers no switch. */
  sidebar?: SidebarEntry
  /**
   * The two page entries (#1015); absent only when the card is rendered
   * outside index.ts (tests, or a future caller). The card then cannot see
   * the other doors and keeps the legacy unrestricted sidebar switch.
   */
  entries?: EntryVisibility
}

type Channel = 'stable' | 'beta' | 'dev'
type Region = 'global' | 'china'

/** What api('/dsh-market/status') tells this card. */
interface SelfStatus {
  version: string | null
  restart: boolean
  channel: Channel
  /** The channels the SERVER offers; the card never invents its own list. */
  channels: Channel[]
  /** Which mirrors every outbound request uses. */
  region: Region
  /** The regions the SERVER offers, on the same principle as `channels`. */
  regions: Region[]
  /** The region came from the network check, not from the user. */
  regionAuto: boolean
  /** User-maintained fallback prefix, separate from the active learned route. */
  githubProxyCustom: string | null
  /** Environment-owned prefixes are visible but not editable. */
  githubProxyManaged: boolean
  /** Whether the profile package manager owns this market installation. */
  selfManaged: boolean
  /**
   * Whether a remove request from this page could pass the market's own
   * fence (#903). False behind a reverse proxy or a remote host, where the
   * card must not offer a button that can only answer 403.
   */
  selfUninstallReachable: boolean
  /** The effective build environment (composition + card-saved override). */
  buildEnv: Record<string, string>
}

/** The subset of api('/dsh-market/status') this card reads. */
interface StatusBody {
  version?: string
  restart?: boolean
  selfUninstallReachable?: boolean
  channel?: string
  channels?: string[]
  region?: string
  regions?: string[]
  regionAuto?: boolean
  githubProxy?: string | null
  githubRoutes?: MarketStatus['githubRoutes']
  githubProxyCustom?: string | null
  githubProxyManaged?: boolean
  selfManaged?: boolean
  buildEnv?: Record<string, string>
}

/** What api('/dsh-market/updates') says about the market's own row. */
interface SelfUpdate {
  updateAvailable: boolean
  latest: string | null
  /** The channel points at this version, and it is not newer: a switch. */
  channelSwitch: string | null
  /** The current build came from a local package and must switch to the online release. */
  restoreRequired: boolean
  /** A generation the desktop host installed (#497): a newer release is named here, never applied from here. */
  hostManaged: boolean
}

type Phase = 'idle' | 'confirming' | 'working' | 'removed' | 'updated' | 'failed'

/** The market's own row as api('/dsh-market/updates') sends it. */
interface RawUpdate { updateAvailable?: boolean; latest?: string; channelSwitch?: string; restoreRequired?: boolean; kind?: string }

const CHANNELS: Channel[] = ['stable', 'beta', 'dev']
const asChannel = (value: unknown): Channel | null =>
  CHANNELS.includes(value as Channel) ? (value as Channel) : null

const CHANNEL_LABEL: Record<Channel, string> = {
  stable: 'setChannelStable', beta: 'setChannelBeta', dev: 'setChannelDev',
}
const CHANNEL_HINT: Record<Channel, string> = {
  stable: 'setChannelStableHint', beta: 'setChannelBetaHint', dev: 'setChannelDevHint',
}

const REGIONS: Region[] = ['global', 'china']
const asRegion = (value: unknown): Region | null =>
  REGIONS.includes(value as Region) ? (value as Region) : null

const REGION_LABEL: Record<Region, string> = {
  global: 'setRegionGlobal', china: 'setRegionChina',
}
const REGION_HINT: Record<Region, string> = {
  global: 'setRegionGlobalHint', china: 'setRegionChinaHint',
}

/**
 * Read the server's answer, taking the list of channels FROM it.
 *
 * The card does not decide which channels exist: the server is what accepts
 * or refuses a selection, so a card drawing its own list could only ever
 * disagree with it.
 */
function readStatus(body: StatusBody): SelfStatus {
  const offered = (body.channels ?? []).map(asChannel).filter((c): c is Channel => c !== null)
  const regions = (body.regions ?? []).map(asRegion).filter((r): r is Region => r !== null)
  return {
    version: body.version ?? null,
    restart: body.restart === true,
    channel: asChannel(body.channel) ?? 'stable',
    // A host too old to send the list still gets the two that predate it.
    channels: offered.length > 0 ? offered : ['stable', 'beta'],
    region: asRegion(body.region) ?? 'global',
    // A host with no region at all is a host from before this existed. It
    // downloads from the official sources, which is what `global` means, so
    // the row tells the truth about that host rather than hiding.
    regions: regions.length > 0 ? regions : REGIONS,
    regionAuto: body.regionAuto === true,
    githubProxyCustom: typeof body.githubProxyCustom === 'string' ? body.githubProxyCustom : null,
    githubProxyManaged: body.githubProxyManaged === true,
    selfManaged: body.selfManaged !== false,
    selfUninstallReachable: body.selfUninstallReachable !== false,
    buildEnv: body.buildEnv ?? {},
  }
}

/** Render the effective build environment as one `KEY=value` line each. */
export function buildEnvToText(env: Record<string, string>): string {
  return Object.entries(env)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

/** Parse a `KEY=value` block back into a map; blank lines are dropped. */
export function buildEnvFromText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const entry = line.trim()
    if (entry === '') continue
    const at = entry.indexOf('=')
    if (at <= 0) continue
    const key = entry.slice(0, at).trim()
    const value = entry.slice(at + 1).trim()
    if (key === '') continue
    out[key] = value
  }
  return out
}

function readUpdate(own: RawUpdate): SelfUpdate {
  return {
    updateAvailable: own.updateAvailable === true,
    latest: own.latest ?? null,
    channelSwitch: own.channelSwitch ?? null,
    restoreRequired: own.restoreRequired === true,
    hostManaged: own.kind === 'generation',
  }
}

/**
 * Clear the market's browser-side leftovers.
 *
 * These are the only two things the market keeps in the browser, and the
 * server cannot reach either. Neither holds a credential — the WebDAV
 * password is never persisted and a Gist token is read from the environment,
 * never from disk — so this is tidiness, not a security step, and the copy
 * must not imply otherwise.
 */
export function clearBrowserState(storage: Pick<Storage, 'removeItem'>): void {
  for (const key of BROWSER_KEYS) {
    try { storage.removeItem(key) } catch { /* storage unavailable */ }
  }
}

export function SettingsCard({ t, onRemoved, sidebar, entries }: SettingsCardProps): ReactElement | null {
  const [open, setOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // Several cards can be mounted at once (settings list, bundle page, the
  // settings tab), so the disclosure's id has to be per instance.
  const advancedId = useId()
  const [, bumpEntries] = useState(0)
  const [entrySaving, setEntrySaving] = useState(0)
  const [sidebarState, setSidebarState] = useState(() => ({
    supported: sidebar?.supported() === true,
    enabled: sidebar?.enabled() === true,
    shown: sidebar?.shown() === true,
    onlyDoor: sidebar?.onlyDoor() === true,
  }))
  const [sidebarSaving, setSidebarSaving] = useState(false)
  useEffect(() => {
    if (sidebar === undefined) return undefined
    const sync = (): void => {
      setSidebarState({
        supported: sidebar.supported(),
        enabled: sidebar.enabled(),
        shown: sidebar.shown(),
        onlyDoor: sidebar.onlyDoor(),
      })
    }
    sync()
    return sidebar.subscribe(sync)
  }, [sidebar])
  // The two page entries load their saved answers after mount, and their
  // slots may arrive even later. Re-render on either so a switch does not
  // stay disabled (or absent) after the fact.
  useEffect(() => {
    if (entries === undefined) return undefined
    return entries.subscribe(() => { bumpEntries(v => v + 1) })
  }, [entries])
  const [status, setStatus] = useState<SelfStatus | null>(null)
  const [update, setUpdate] = useState<SelfUpdate | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [restoreConfirming, setRestoreConfirming] = useState(false)
  const [purge, setPurge] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [proxyEditing, setProxyEditing] = useState(false)
  const [proxyDraft, setProxyDraft] = useState('')
  const [proxySaving, setProxySaving] = useState(false)
  /** Draft of the build-environment editor (#336), seeded once from status. */
  const [envText, setEnvText] = useState('')
  const envSeeded = useRef(false)
  /**
   * The last self-update was refused by pnpm's fresh-release safety wait
   * (#39). Only the market's own card can update the market, so without a
   * retry here there is NO way to take a just-published version — the
   * discover list's retry button covers every plugin except this one (#255).
   */
  const [stale, setStale] = useState(false)

  // Only once the row is opened: the plugin configuration page renders every
  // card at once, and an update check costs a registry round trip.
  //
  // `open` is the ONLY dependency, and re-entry is guarded by a ref rather
  // than by `status`. Keying it on state the effect itself sets meant the
  // first `setStatus` re-ran the effect, whose cleanup dropped the still
  // in-flight update check — so the update row never appeared. Measured by
  // the spec, not reasoned about.
  const probed = useRef(false)
  useEffect(() => {
    if (!open || probed.current) return
    probed.current = true
    let live = true
    void (async () => {
      try {
        const response = await fetch(api('/dsh-market/status'), { cache: 'no-store' })
        const body = (await response.json()) as StatusBody
        if (live) setStatus(readStatus(body))
        applyGithubRouting(body)
      } catch {
        if (live) {
          setStatus({
            version: null, restart: false, channel: 'stable', channels: ['stable', 'beta'],
            region: 'global', regions: REGIONS, regionAuto: false,
            githubProxyCustom: null, githubProxyManaged: false, selfManaged: true, selfUninstallReachable: true, buildEnv: {},
          })
        }
      }
      try {
        const response = await fetch(api('/dsh-market/updates'), { cache: 'no-store' })
        const body = (await response.json()) as { updates?: Record<string, RawUpdate> }
        const own = body.updates?.['dshmarket'] ?? body.updates?.['dsh-market']
        if (live && own !== undefined) setUpdate(readUpdate(own))
      } catch { /* an update check that fails leaves the row without an offer */ }
    })()
    return () => { live = false }
  }, [open])

  const post = useCallback(async (path: string, payload: unknown): Promise<{ ok?: boolean; error?: string }> => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return (await response.json()) as { ok?: boolean; error?: string }
  }, [])

  const onUpdate = useCallback((force = false) => {
    setRestoreConfirming(false)
    setPhase('working')
    setError(null)
    setStale(false)
    void (async () => {
      try {
        const body = await post(api('/dsh-market/update'), {
          name: 'dshmarket',
          ...(update?.restoreRequired === true ? { restore: true } : {}),
          ...(force ? { force: true } : {}),
        }) as {
          ok?: boolean; error?: string; stale?: boolean
        }
        if (body.ok === true) setPhase('updated')
        else {
          setStale(body.stale === true)
          setError(body.error ?? t('setSelfFailed'))
          setPhase('failed')
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        setPhase('failed')
      }
    })()
  }, [post, t, update?.restoreRequired])

  const onRemove = useCallback(() => {
    setPhase('working')
    setError(null)
    void (async () => {
      try {
        const body = await post(api('/dsh-market/self-uninstall'), { confirm: true, purge })
        if (body.ok === true) {
          if (purge) clearBrowserState(localStorage)
          setPhase('removed')
          onRemoved?.()
        } else { setError(body.error ?? t('setSelfFailed')); setPhase('failed') }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        setPhase('failed')
      }
    })()
  }, [onRemoved, post, purge, t])

  const busy = phase === 'working'
  const version = status?.version ?? null
  // A prerelease says so in its own version string; nothing else has to be
  // consulted to know the running build is one.
  const prerelease = version !== null && version.includes('-')

  /** Re-ask what this channel offers; the previous answer was for another one. */
  const refreshUpdate = useCallback(async (): Promise<void> => {
    const response = await fetch(api('/dsh-market/updates') + '?force=1', { cache: 'no-store' })
    const body = (await response.json()) as { updates?: Record<string, RawUpdate> }
    const own = body.updates?.['dshmarket'] ?? body.updates?.['dsh-market']
    setUpdate(own === undefined ? null : readUpdate(own))
  }, [])

  /**
   * Select a channel — and show the one the SERVER accepted.
   *
   * This used to move the control first and ignore the answer, which was
   * harmless while every channel was permitted. It stopped being harmless
   * the moment one of them can be refused: a 403 would have left "dev"
   * highlighted on a profile that is not on it.
   */
  const onChannel = useCallback((next: Channel) => {
    setError(null)
    void (async () => {
      try {
        const body = await post(api('/dsh-market/channel'), { channel: next }) as { ok?: boolean; error?: string; channel?: string }
        if (body.ok !== true) { setError(body.error ?? t('setSelfFailed')); return }
        setStatus(current => (current === null ? current : { ...current, channel: asChannel(body.channel) ?? next }))
        await refreshUpdate()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  }, [post, refreshUpdate, t])

  /**
   * Select a download region — and show the one the SERVER accepted, on the
   * same reasoning as the channel above.
   *
   * A hand-made choice retires the one-time notice: the market no longer has
   * anything to explain once the user has answered for themselves.
   */
  const onRegion = useCallback((next: Region) => {
    setError(null)
    void (async () => {
      try {
        const body = await post(api('/dsh-market/region'), { region: next }) as { ok?: boolean; error?: string; region?: string }
        if (body.ok !== true) { setError(body.error ?? t('setSelfFailed')); return }
        const accepted = asRegion(body.region) ?? next
        setStatus(current => (current === null ? current : { ...current, region: accepted, regionAuto: false }))
        // Re-read the resolved proxy rather than deriving it here. The card
        // knows which regions exist because the server told it; it must not
        // start knowing what each one RESOLVES to, or the routing table would
        // have a second copy that can disagree with the first.
        try {
          const fresh = await fetch(api('/dsh-market/status'), { cache: 'no-store' })
          const status = (await fresh.json()) as StatusBody
          applyGithubRouting(status)
        } catch { /* images keep the previous route until the next load */ }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  }, [post, t])

  /** Save or clear the single user-facing GitHub escape route. */
  const onGithubProxy = useCallback((proxy: string | null) => {
    setError(null)
    setProxySaving(true)
    void (async () => {
      try {
        const body = await post(api('/dsh-market/github-proxy'), { proxy }) as { ok?: boolean; error?: string }
        if (body.ok !== true) { setError(body.error ?? t('setSelfFailed')); return }
        const fresh = await fetch(api('/dsh-market/status'), { cache: 'no-store' })
        const statusBody = (await fresh.json()) as StatusBody
        setStatus(readStatus(statusBody))
        applyGithubRouting(statusBody)
        setProxyEditing(false)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setProxySaving(false)
      }
    })()
  }, [post, t])
  /**
   * Seed the build-environment editor from the server's effective value —
   * ONCE. The draft is the user's to edit from then on; the status refetch
   * after a save updates it explicitly instead.
   */
  useEffect(() => {
    if (status === null || envSeeded.current) return
    envSeeded.current = true
    setEnvText(buildEnvToText(status.buildEnv))
  }, [status])

  /** Save the draft build environment; an empty list clears it (#336). */
  const onSaveEnv = useCallback(async () => {
    setError(null)
    try {
      const body = await post(api('/dsh-market/build-env'), {
        buildEnv: buildEnvFromText(envText),
      }) as { ok?: boolean; error?: string; buildEnv?: Record<string, string> }
      if (body.ok !== true) { setError(body.error ?? t('setSelfFailed')); return }
      // Reflect exactly what the server applied, not what we sent — the
      // server is the one that dropped blank lines and rejected names.
      setEnvText(buildEnvToText(body.buildEnv ?? {}))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [envText, post, t])

  const onSidebar = useCallback((next: boolean) => {
    if (sidebar === undefined) return
    setError(null)
    setSidebarSaving(true)
    void (async () => {
      try {
        if (!next && entries !== undefined) {
          // The other doors are answered by the controller; re-read them
          // before closing this one, so a change made in another tab is not
          // judged against this card's stale snapshot.
          await entries.load()
          if (!entries.otherDoorOpen('sidebar')) {
            setError(t('setEntryLastDoorHint'))
            return
          }
        }
        await sidebar.set(next)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setSidebarSaving(false)
      }
    })()
  }, [entries, sidebar, t])

  const onEntry = useCallback((key: EntryKey, next: boolean) => {
    if (entries === undefined) return
    setError(null)
    setEntrySaving(count => count + 1)
    void (async () => {
      try {
        await entries.set(key, next)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setEntrySaving(count => count - 1)
      }
    })()
  }, [entries])

  /** One label + hint block with an optional action, the host's row shape. */
  const row = (label: string, hint: string, action: ReactElement | null): ReactElement =>
    h('div', { className: css.setRow },
      h('div', { className: css.setLabelBox },
        h('div', { className: css.setLabel }, label),
        h('div', { className: css.setHint }, hint),
      ),
      action,
    )

  /**
   * A Show/Hide pair. `canHide` disables only the OFF half: the entry that
   * is currently on stays clickable, and the rule "at least one door stays
   * open" is what the OFF button reflects.
   */
  const toggle = (
    on: boolean,
    saving: boolean,
    canHide: boolean,
    labels: { show: string; hide: string },
    pick: (next: boolean) => void,
  ): ReactElement => h('div', { className: css.setSeg },
    ([false, true] as const).map(value => h('button', {
      key: String(value),
      type: 'button',
      className: on === value ? `${css.setSegBtn} ${css.setSegOn}` : css.setSegBtn,
      disabled: busy || saving || (value === false && !canHide),
      'aria-pressed': on === value,
      onClick: () => { if (on !== value) pick(value) },
    }, value ? labels.show : labels.hide)),
  )

  /** One of the two page entries (#1015), with the last-door rule applied. */
  const entryRow = (key: EntryKey, label: string, hint: string, on: boolean): ReactElement => {
    const canHide = entries?.otherDoorOpen(key) === true
    return row(
      label,
      canHide ? hint : `${hint} ${t('setEntryLastDoorHint')}`,
      toggle(on, entriesBusy, canHide, { show: t('setEntryShow'), hide: t('setEntryHide') }, next => onEntry(key, next)),
    )
  }

  // One save at a time across all three switches: two OFF saves in flight
  // would each judge the last-door rule from the state before the other.
  const entriesBusy = entrySaving > 0 || sidebarSaving

  // The page entries and the sidebar row are "advanced discoverability": the
  // default configuration is what almost everyone wants, so all three live
  // behind one collapsed group rather than in the first screen of the card
  // (#1015's review). A switch is offered only where the host declares the
  // seat, and its OFF half is disabled when it is the last open door.
  const entryRows: ReactElement[] = []
  if (entries !== undefined) {
    if (entries.settingsAvailable()) {
      entryRows.push(entryRow('settingsSection', t('setEntrySection'), t('setEntrySectionHint'), entries.settingsSection()))
    }
    if (entries.pluginsTabSupported()) {
      entryRows.push(entryRow('pluginsTab', t('setEntryPluginsTab'), t('setEntryPluginsTabHint'), entries.pluginsTab()))
    }
  }
  if (sidebarState.supported) {
    // Without the entry controller (a host that never mounted it) the card
    // cannot see the other doors, so it keeps the old, unrestricted switch
    // rather than pretending this row is the only one.
    const canHide = entries === undefined || entries.otherDoorOpen('sidebar')
    entryRows.push(row(
      t('setSidebar'),
      sidebarState.onlyDoor
        ? t('setSidebarOnlyDoorHint')
        : canHide ? t('setSidebarHint') : `${t('setSidebarHint')} ${t('setEntryLastDoorHint')}`,
      toggle(
        sidebarState.shown,
        entriesBusy,
        canHide,
        { show: t('setSidebarOn'), hide: t('setSidebarOff') },
        onSidebar,
      ),
    ))
  }
  const advanced = entryRows.length > 0
    ? h('div', { className: css.setAdvanced },
        h('button', {
          type: 'button',
          className: css.setAdvancedHead,
          'aria-expanded': advancedOpen,
          'aria-controls': advancedId,
          'aria-label': t('setAdvanced'),
          onClick: () => { setAdvancedOpen(value => !value) },
        },
          h('div', { className: css.setLabelBox },
            h('div', { className: css.setLabel }, t('setAdvanced')),
            h('div', { className: css.setHint }, t('setAdvancedHint')),
          ),
          h('span', { className: advancedOpen ? `${css.setChevron} ${css.setChevronOpen}` : css.setChevron },
            h(IconChevronDownOutline14, { size: 14 })),
        ),
        advancedOpen
          ? h('div', { id: advancedId, className: css.setAdvancedBody }, entryRows.map((node, index) => h(Fragment, { key: index }, node)))
          : null,
      )
    : null

  // The end state REPLACES the controls rather than sitting beside them: the
  // package is gone from disk, so an update button next to "removed" would
  // offer something that cannot happen.
  const body = phase === 'removed'
    ? row(t('setSelfRemoved'), t('setSelfRemovedHint'), null)
    : h(Fragment, null,
        advanced,
        // Where the same catalog is reachable on a host that reads market
        // indexes (dsh 0.2.1+): a statement, not an action — the address is
        // the whole thing the user needs, and it stays selectable here.
        row(t('setIndexSource'), t('setIndexSourceHint'), null),
        status?.selfManaged === true ? row(
          // An older offer is not an update, and calling it one would have
          // the user click "更新" to go backwards. It IS what picking an
          // earlier channel asked for, so it is offered — under its own name.
          (update?.updateAvailable === true || update?.hostManaged === true) && update.latest !== null
            ? `${t('setSelfUpdateReady')} ${update.latest}`
            : update?.channelSwitch != null
              ? `${t('setChannelSwitch')} ${update.channelSwitch}`
              : t('setSelfUpToDate'),
          phase === 'updated'
            ? t('setSelfUpdatedHint')
            : update?.channelSwitch != null
              ? t('setChannelSwitchHint')
              // Explains what the Update button does — only worth saying
              // when that button is actually on screen. Already up to date,
              // it read as an instruction for an action that wasn't there.
              : update?.updateAvailable === true ? t('setSelfUpdateHint')
                // Named, not offered: the desktop host owns this install.
                : update?.hostManaged === true && update.latest !== null ? t('setSelfHostManagedHint')
                  : t('setSelfUpToDateHint'),
          phase === 'updated'
            ? null
            : update?.updateAvailable === true
              ? h(Button, {
                  variant: 'primary',
                  size: 'sm',
                  disabled: busy,
                  onClick: () => {
                    if (update.restoreRequired) setRestoreConfirming(true)
                    else onUpdate()
                  },
                }, update.restoreRequired ? t('restoreOnline') : t('setSelfUpdate'))
              : update?.channelSwitch != null
                ? h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => onUpdate() }, t('setChannelSwitch'))
                : null,
        ) : null,
        status?.selfManaged === true && restoreConfirming
          ? h('div', { className: css.setConfirm },
              h('div', { className: css.setHint }, t('restoreHint')),
              h('div', { className: css.setActions },
                h(Button, {
                  variant: 'ghost', size: 'sm', onClick: () => { setRestoreConfirming(false) },
                }, t('setSelfCancel')),
                h(Button, {
                  variant: 'primary', size: 'sm', onClick: () => onUpdate(),
                }, t('restoreContinue')),
              ),
            )
          : null,
        status?.selfManaged === true ? row(t('setChannel'), t(CHANNEL_HINT[status.channel]),
          h('div', { className: css.setSeg },
            // Drawn from what the SERVER says is available, so the control
            // can never offer a channel the route would refuse.
            (status?.channels ?? ['stable', 'beta']).map(id => h('button', {
              key: id,
              type: 'button',
              className: status?.channel === id ? `${css.setSegBtn} ${css.setSegOn}` : css.setSegBtn,
              disabled: busy || status === null,
              // The dev option says what it is on hover rather than being
              // hidden behind a switch. A label a user can read beats a gate
              // plus the machinery that maintains it, and the row's own hint
              // repeats it in full once the channel is selected.
              title: id === 'dev' ? t('setChannelDevHint') : undefined,
              onClick: () => { onChannel(id) },
            }, t(CHANNEL_LABEL[id]))),
          )) : null,
        // Getting plugins at all is the market's job; the channel above is
        // which build of the market itself arrives.
        row(
          t('setRegion'),
          // The hint carries the explanation of an automatic choice when
          // there is one to make, and the plain description of the selected
          // region otherwise. One line either way — a notice that pushes the
          // description off screen would trade a permanent answer for a
          // temporary one.
          status?.regionAuto === true
            ? `${t(REGION_HINT[status.region])} ${t('setRegionAuto')}`
            : t(REGION_HINT[status?.region ?? 'global']),
          h('div', { className: css.setSeg },
            (status?.regions ?? REGIONS).map(id => h('button', {
              key: id,
              type: 'button',
              className: status?.region === id ? `${css.setSegBtn} ${css.setSegOn}` : css.setSegBtn,
              disabled: busy || status === null,
              onClick: () => { onRegion(id) },
            }, t(REGION_LABEL[id]))),
          )),
        row(
          t('setGithubProxy'),
          status?.githubProxyManaged === true
            ? t('setGithubProxyManagedHint')
            : status?.githubProxyCustom !== null && status?.githubProxyCustom !== undefined
              ? t('setGithubProxyCustomHint')
              : t('setGithubProxyAutoHint'),
          status?.githubProxyManaged === true
            ? null
            : status?.githubProxyCustom !== null && status?.githubProxyCustom !== undefined
              ? h('div', { className: css.setInlineActions },
                  h(Button, {
                    variant: 'outline', size: 'sm', disabled: proxySaving,
                    onClick: () => { setProxyDraft(status.githubProxyCustom ?? ''); setProxyEditing(true) },
                  }, t('setGithubProxyEdit')),
                  h(Button, {
                    variant: 'ghost', size: 'sm', disabled: proxySaving,
                    onClick: () => { onGithubProxy(null) },
                  }, t('setGithubProxyAuto')),
                )
              : h(Button, {
                  variant: 'outline', size: 'sm', disabled: status === null || proxySaving,
                  onClick: () => { setProxyDraft(''); setProxyEditing(true) },
                }, t('setGithubProxyCustom')),
        ),
        proxyEditing && status?.githubProxyManaged !== true
          ? h('div', { className: css.setProxyEditor },
              h('label', { className: css.setProxyLabel },
                t('setGithubProxyInput'),
                h('input', {
                  className: css.setProxyInput,
                  type: 'url',
                  value: proxyDraft,
                  placeholder: 'https://mirror.example',
                  'aria-label': t('setGithubProxyInput'),
                  disabled: proxySaving,
                  onChange: (event: { currentTarget: { value: string } }) => { setProxyDraft(event.currentTarget.value) },
                }),
              ),
              h('div', { className: css.setInlineActions },
                h(Button, {
                  variant: 'ghost', size: 'sm', disabled: proxySaving,
                  onClick: () => { setProxyEditing(false) },
                }, t('setSelfCancel')),
                h(Button, {
                  variant: 'primary', size: 'sm', disabled: proxySaving || proxyDraft.trim() === '',
                  onClick: () => { onGithubProxy(proxyDraft) },
                }, t('setGithubProxySave')),
              ),
            )
          : null,
        // Build environment (#336): the one place an unshelled host pins
        // CC/CXX for plugin builds. Full-width block, because the editor is
        // a list — a cramped column would teach a one-line-per-row format
        // nobody can read.
        h('div', { className: css.setConfirm },
          h('div', { className: css.setLabel }, t('setBuildEnv')),
          h('div', { className: css.setHint }, t('setBuildEnvHint')),
          h('textarea', {
            className: css.envEditor,
            rows: 3,
            spellCheck: false,
            'aria-label': t('setBuildEnv'),
            value: envText,
            disabled: busy || status === null,
            placeholder: 'CC=/usr/bin/gcc-11\nCXX=/usr/bin/g++-11',
            onChange: (event: { target: { value: string } }) => { setEnvText(event.target.value) },
          }),
          h('div', { className: css.setActions },
            h(Button, {
              variant: 'primary',
              size: 'sm',
              disabled: busy || status === null,
              onClick: () => { void onSaveEnv() },
            }, t('setBuildEnvSave'))),
        ),
        status?.selfManaged === true ? row(t('setSelfRemove'),
          status.selfUninstallReachable ? t('setSelfRemoveHint') : t('setSelfRemoveRemote'),
          status.selfUninstallReachable && phase !== 'confirming' && !busy
            ? h(Button, {
                variant: 'outline',
                size: 'sm',
                className: css.setDanger,
                disabled: busy,
                onClick: () => { setPhase('confirming') },
              }, t('setSelfRemove'))
            : null) : null,
        status?.selfManaged === true && status.selfUninstallReachable && (phase === 'confirming' || busy)
          ? h('div', { className: css.setConfirm },
              h('div', { className: css.setHint }, t('setSelfConfirm')),
              h('label', { className: css.setCheck },
                h('input', { type: 'checkbox', checked: purge, onChange: () => { setPurge(!purge) } }),
                h('span', null, t('setSelfPurge')),
              ),
              // States the consequence of the CURRENT choice, both ways. The
              // default keeps things, and what "keeping" costs — plugins the
              // market switched off stay off, with the UI that could switch
              // them back on about to disappear — is the part a user cannot
              // work out on their own.
              h('div', { className: css.setHint }, purge ? t('setSelfPurgeOn') : t('setSelfPurgeOff')),
              h('div', { className: css.setActions },
                busy
                  ? null
                  : h(Button, {
                      variant: 'ghost',
                      size: 'sm',
                      onClick: () => { setPhase('idle'); setPurge(false) },
                    }, t('setSelfCancel')),
                h(Button, {
                  variant: 'primary',
                  size: 'sm',
                  className: css.setDanger,
                  disabled: busy,
                  icon: busy ? h('span', { className: css.spin }, h(IconLoadingOutline16, { size: 16 })) : undefined,
                  onClick: onRemove,
                }, busy ? t('setSelfWorking') : t('setSelfRemoveConfirm')),
              ),
            )
          : null,
        error !== null ? h('div', { className: css.err }, error) : null,
        // The one place the market can be forced past pnpm's fresh-release
        // wait. Shown only after that specific refusal, never as a default:
        // the wait exists because a version published minutes ago can still
        // be unpublished (#39).
        stale
          ? h('div', { className: css.setActions },
              h(Button, { variant: 'primary', size: 'sm', onClick: () => onUpdate(true) }, t('updateNow')))
          : null,
      )

  return h('div', { className: open ? `${css.setCard} ${css.setCardOpen}` : css.setCard },
    h('button', {
      type: 'button',
      className: css.setHeader,
      'aria-expanded': open,
      onClick: () => { setOpen(!open) },
    },
      h('div', { className: css.setHeadText },
        h('div', { className: css.setName },
          t('nav'),
          version !== null ? h('span', { className: css.version }, ` v${version}`) : null,
          prerelease ? h('span', { className: css.setBetaTag }, t('setChannelBeta')) : null,
        ),
        h('div', { className: css.setDesc }, t('setCardDesc')),
      ),
      h('span', { className: open ? `${css.setChevron} ${css.setChevronOpen}` : css.setChevron },
        h(IconChevronDownOutline14, { size: 14 }),
      ),
    ),
    open ? h('div', { className: css.setBody }, body) : null,
  )
}
