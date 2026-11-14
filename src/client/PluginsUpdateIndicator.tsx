/** Decorate the host's existing Plugins icon without replacing its button or page. */
import { createElement, useLayoutEffect, useSyncExternalStore } from 'react'
import type { ComponentType, CSSProperties } from 'react'
import { isIconComponent } from './icons.ts'
import type { Translate } from './market-data.ts'
import { acknowledgeUpdateNotifications, unseenNotificationNames, useUpdateNotifications } from './update-notifications.ts'

interface IconOwnerProps { size?: number; active?: boolean }
interface SlotEntry {
  component: unknown
  options: { id?: string; order?: number; priority?: number; label?: string | (() => string) }
  locale?: string
  inject?: unknown
  store?: unknown
  children?: Record<string, unknown>
}
interface NotificationSlots {
  inject(slot: string, callback: () => (() => void)): unknown
  register(options: Record<string, unknown>, component: ComponentType<IconOwnerProps>): unknown
  entries(slot: string): readonly SlotEntry[]
  entriesOfSlot(slot: string): readonly SlotEntry[]
  subscribe(slot: string, callback: () => void): () => void
}
interface LocaleSource {
  subscribe(callback: () => void): () => void
  getSnapshot(): { active: string }
}

const DOT_STYLE: CSSProperties = {
  position: 'absolute', right: -2, top: -2, width: 6, height: 6, borderRadius: '50%',
  background: 'var(--dsw-alias-state-error-primary, #e5484d)',
  boxShadow: '0 0 0 1.5px var(--dsw-alias-bg-base, #fff)', pointerEvents: 'none',
}
const ANNOUNCEMENT_STYLE: CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap', border: 0,
}

/** The host may mount more than one responsive sidebar; any active copy is a visit. */
function createIconActivity() {
  const instances = new Map<symbol, boolean | undefined>()
  const listeners = new Set<() => void>()
  let current: boolean | undefined
  const publish = () => {
    const values = [...instances.values()]
    const next = values.includes(true) ? true : values.includes(false) ? false : undefined
    if (next === current) return
    current = next
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    track: (active: boolean | undefined) => {
      const key = Symbol()
      instances.set(key, active)
      publish()
      return () => { instances.delete(key); publish() }
    },
  }
}
type IconActivity = ReturnType<typeof createIconActivity>

function PluginsUpdateIcon({ original: Original, owner, activity }: {
  original: ComponentType<IconOwnerProps>; owner: IconOwnerProps; activity: IconActivity
}) {
  const snapshot = useUpdateNotifications()
  useLayoutEffect(() => activity.track(owner.active), [activity, owner.active])
  // A click can be cancelled by the host. Only its public active-panel prop
  // confirms the visit. Acknowledge before paint, including results arriving
  // while Plugins remains open, without changing the available update offers.
  useLayoutEffect(() => {
    if (owner.active === true) acknowledgeUpdateNotifications(snapshot)
  }, [owner.active, snapshot])
  const count = owner.active === false ? unseenNotificationNames(snapshot).length : 0
  return <span data-dsh-market-plugins-indicator="" style={{ position: 'relative', display: 'inline-flex', lineHeight: 0 }}>
    <Original {...owner} />
    {count > 0 ? <span data-dsh-market-update-dot="" data-update-count={count} aria-hidden="true" style={DOT_STYLE} /> : null}
  </span>
}

function UpdateAnnouncement({ t, locale, activity }: { t: Translate; locale: LocaleSource; activity: IconActivity }) {
  useSyncExternalStore(listener => locale.subscribe(listener), () => locale.getSnapshot().active, () => locale.getSnapshot().active)
  const active = useSyncExternalStore(activity.subscribe, activity.getSnapshot, activity.getSnapshot)
  const snapshot = useUpdateNotifications()
  // Missing active props (or a missing native launcher) cannot confirm a
  // visit. Keep that optional integration quiet rather than strand a badge.
  const count = active === false ? unseenNotificationNames(snapshot).length : 0
  return <span role="status" aria-live="polite" aria-atomic="true" data-dsh-market-update-announcement="" style={ANNOUNCEMENT_STYLE}>
    {count > 0 ? t('updateNotificationsAnnouncement').replace('{count}', String(count)) : ''}
  </span>
}

/** Newer slot registries explicitly expose shadowing winners; older hosts keep their icon. */
function supportsDecoration(slots: unknown): slots is NotificationSlots {
  if (slots === null || typeof slots !== 'object') return false
  return ['inject', 'register', 'entries', 'entriesOfSlot', 'subscribe']
    .every(name => typeof (slots as Record<string, unknown>)[name] === 'function')
}

/**
 * Only a presentation-only native icon is wrapped. Its own injected business
 * face, store or child slots are never called or copied into another entry.
 */
function canWrap(entry: SlotEntry): boolean {
  return isIconComponent(entry.component) && entry.inject === undefined && entry.store === undefined
    && (entry.children === undefined || Object.keys(entry.children).length === 0)
}

export function installPluginsUpdateIndicator(
  host: { slots: unknown }, t: Translate, locale: LocaleSource,
): () => void {
  if (!supportsDecoration(host.slots)) return () => {}
  const slots = host.slots
  let disposed = false
  let stopIcon: (() => void) | undefined
  let stopAnnouncement: (() => void) | undefined
  const controllers: Array<() => void> = []
  const activity = createIconActivity()
  const quietly = (stop: (() => void) | undefined): void => { try { stop?.() } catch { /* Optional host integration. */ } }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    quietly(stopIcon)
    quietly(stopAnnouncement)
    for (const stop of controllers.splice(0).reverse()) quietly(stop)
  }

  const install = (slot: string, callback: () => () => void): void => {
    if (disposed) return
    const off = slots.inject(slot, () => {
      if (disposed) return () => {}
      // Slot owners can appear after installation; their deferred callback
      // needs the same rollback as a synchronous registration failure.
      try { return callback() } catch { dispose(); return () => {} }
    })
    if (typeof off === 'function') {
      if (disposed) quietly(off as () => void)
      else controllers.push(off as () => void)
    }
  }
  try {
    install('sidebar.panellist', () => {
      let original: SlotEntry | undefined
      let Decoration: ComponentType<IconOwnerProps> | undefined
      let stopDecoration: (() => void) | undefined
      let closed = false
      let reconciling = false
      let changedWhileReconciling = false
      const remove = (): void => {
        const stop = stopDecoration
        stopDecoration = undefined
        Decoration = undefined
        original = undefined
        quietly(stop)
      }
      const reconcile = (): void => {
        if (closed || disposed) return
        if (reconciling) { changedWhileReconciling = true; return }
        reconciling = true
        try {
          const entries = slots.entries('sidebar.panellist').filter(entry => entry.options.id === 'plugins' && entry.component !== Decoration)
          const next = entries.length === 1 && (entries[0].options.priority ?? 0) === 0 && canWrap(entries[0]) ? entries[0] : undefined
          if (next === original) return
          remove()
          if (next === undefined) return
          const active = slots.entriesOfSlot('sidebar.panellist').find(entry => entry.options.id === 'plugins')
          if (active !== next) return
          const Original = next.component as ComponentType<IconOwnerProps>
          Decoration = owner => createElement(PluginsUpdateIcon, { original: Original, owner, activity })
          const off = slots.register({
            name: 'sidebar.panellist', id: 'plugins', priority: -1,
            ...(next.options.order === undefined ? {} : { order: next.options.order }),
            ...(next.options.label === undefined ? {} : { label: next.options.label }),
            ...(next.locale === undefined ? {} : { locale: next.locale }),
          }, Decoration)
          original = next
          stopDecoration = typeof off === 'function' ? off as () => void : undefined
        } catch {
          dispose()
        } finally {
          reconciling = false
          if (changedWhileReconciling) {
            changedWhileReconciling = false
            queueMicrotask(reconcile)
          }
        }
      }
      const unsubscribe = slots.subscribe('sidebar.panellist', reconcile)
      stopIcon = () => { closed = true; quietly(unsubscribe); remove() }
      reconcile()
      return stopIcon
    })
    install('shell.overlay', () => {
      const off = slots.register({ name: 'shell.overlay', id: 'dsh-market-update-announcement' },
        () => createElement(UpdateAnnouncement, { t, locale, activity }))
      stopAnnouncement = typeof off === 'function' ? off as () => void : () => {}
      return stopAnnouncement
    })
  } catch {
    dispose()
  }
  return dispose
}
