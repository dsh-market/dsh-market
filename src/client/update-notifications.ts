/** One local snapshot shared by the market page, settings and sidebar. */
import { useSyncExternalStore } from 'react'
import type { UpdateNotificationSnapshot } from '../update-notifications.ts'
import { api, readSession } from './market-data.ts'

export type { UpdateNotificationSnapshot }

const IGNORED_UPDATES_SESSION_KEY = 'dshm-updates-ignored'
const RESTART_SESSION_KEY = 'dshm-restart'
const POLL_MS = 30_000

export interface UpdateNotificationsState extends UpdateNotificationSnapshot {
  /** False until the local notification endpoint has answered successfully. */
  loaded: boolean
}

const initialState = (): UpdateNotificationsState => ({
  enabled: true, checking: false, checkedAt: null, lastSuccessAt: null,
  nextCheckAt: null, stale: false, error: null, updates: {}, boot: '',
  updateExempt: [], disabled: [], blocked: [], loaded: false,
})

function readIgnoredUpdates(boot: string, clearStale: boolean): string[] {
  if (boot === '') return []
  const saved = readSession(IGNORED_UPDATES_SESSION_KEY)
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)
    || saved.boot !== boot || !Array.isArray(saved.names)
    || !saved.names.every((name: unknown) => typeof name === 'string' && name !== '')) {
    if (clearStale) {
      try { sessionStorage.removeItem(IGNORED_UPDATES_SESSION_KEY) } catch { /* Storage can be unavailable; reminders remain visible. */ }
    }
    return []
  }
  return [...new Set(saved.names as string[])]
}

/** Called after the host reports its current boot; retire old dismissals then. */
export function ignoredUpdatesForBoot(boot: string): string[] {
  return readIgnoredUpdates(boot, true)
}

/** The attention count excludes dismissed, disabled and already-completed updates. */
export function notificationNames(snapshot: UpdateNotificationSnapshot): string[] {
  const restart = readSession(RESTART_SESSION_KEY)
  const updated: string[] = restart?.boot === snapshot.boot && Array.isArray(restart.updated)
    ? restart.updated.filter((name: unknown): name is string => typeof name === 'string') : []
  const quiet = new Set([
    ...snapshot.updateExempt, ...snapshot.disabled, ...snapshot.blocked,
    // A cached sidebar snapshot can lag behind the page's newer boot. Reading
    // its count must never erase a dismissal already saved for that new boot.
    ...readIgnoredUpdates(snapshot.boot, false), ...updated,
  ])
  return Object.entries(snapshot.updates).filter(([name, status]) => !quiet.has(name)
    && status.notAPlugin !== true
    && (status.updateAvailable === true || (status.kind === 'generation' && status.latest != null)))
    .map(([name]) => name).sort()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isUpdateStatus(value: unknown): boolean {
  return isRecord(value)
    && ['updateAvailable', 'notAPlugin', 'restoreRequired'].every(key => value[key] === undefined || typeof value[key] === 'boolean')
    && ['current', 'latest', 'version'].every(key => value[key] === undefined || value[key] === null || typeof value[key] === 'string')
    && ['kind', 'eligibleVersion'].every(key => value[key] === undefined || typeof value[key] === 'string')
    && (value.checkError === undefined || value.checkError === 'unavailable')
}

/** Reject a malformed local response instead of replacing a useful cached result. */
function readSnapshot(value: unknown): UpdateNotificationSnapshot {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || typeof value.checking !== 'boolean'
    || typeof value.stale !== 'boolean' || typeof value.boot !== 'string'
    || !(value.error === null || typeof value.error === 'string')
    || !['checkedAt', 'lastSuccessAt', 'nextCheckAt'].every(key => value[key] === null || (typeof value[key] === 'number' && Number.isFinite(value[key])))
    || !['updateExempt', 'disabled', 'blocked'].every(key => Array.isArray(value[key]) && value[key].every((name: unknown) => typeof name === 'string'))
    || !isRecord(value.updates) || !Object.values(value.updates).every(isUpdateStatus)) {
    throw new Error('The update notification response was incomplete. Try checking again.')
  }
  return value as unknown as UpdateNotificationSnapshot
}

export interface UpdateNotificationsStore {
  getSnapshot(): UpdateNotificationsState
  subscribe(listener: () => void): () => void
  /** Acquire the local poller; the final disposer aborts requests and clears it. */
  start(): () => void
  /** Read cached host data only; this never starts a registry check. */
  refresh(): Promise<UpdateNotificationsState>
  /** Read after a local preference change, following any read already in flight. */
  refreshAfterChange(): Promise<UpdateNotificationsState>
  /** An explicit user action starts or joins the host's check. */
  check(): Promise<UpdateNotificationsState>
  setEnabled(enabled: boolean): Promise<UpdateNotificationsState>
  preferencesChanged(): void
}

/** The injectable transport keeps request ordering and teardown independently testable. */
export function createUpdateNotificationsStore(request: typeof fetch = (...args) => fetch(...args)): UpdateNotificationsStore {
  let state = initialState()
  const listeners = new Set<() => void>()
  let owners = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let read: Promise<UpdateNotificationsState> | undefined
  let command: Promise<UpdateNotificationsState> | undefined
  let afterChange: Promise<UpdateNotificationsState> | undefined
  let changeRevision = 0
  let lifecycle = 0
  let requestSequence = 0
  const controllers = new Set<AbortController>()

  const publish = (next: UpdateNotificationsState): void => {
    state = next
    for (const listener of [...listeners]) listener()
  }
  const run = async (body?: { enabled?: boolean; check?: true }): Promise<UpdateNotificationsState> => {
    const generation = lifecycle
    const sequence = ++requestSequence
    const controller = new AbortController()
    controllers.add(controller)
    try {
      const response = await request(api('/dsh-market/update-notifications'), {
        cache: 'no-store', signal: controller.signal,
        ...(body === undefined ? {} : {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        }),
      })
      if (!response.ok) throw new Error(`Update check unavailable (${response.status}). Try again.`)
      const next = readSnapshot(await response.json())
      if (generation === lifecycle && sequence === requestSequence) publish({ ...next, loaded: true })
    } catch (error) {
      if (generation !== lifecycle || controller.signal.aborted) return state
      if (sequence === requestSequence) publish({ ...state, stale: true, error: error instanceof Error ? error.message : String(error) })
      if (body !== undefined) throw error
    } finally {
      controllers.delete(controller)
    }
    return state
  }
  const refresh = (): Promise<UpdateNotificationsState> => {
    if (command !== undefined) return command.catch(() => state)
    if (read === undefined) {
      const pending = run()
      read = pending
      void pending.finally(() => { if (read === pending) read = undefined })
    }
    return read
  }
  const mutate = (body: { enabled?: boolean; check?: true }): Promise<UpdateNotificationsState> => {
    const previous = command
    const generation = lifecycle
    const pending = (previous === undefined ? Promise.resolve() : previous.catch(() => state))
      .then(() => generation === lifecycle ? run(body) : state)
    command = pending
    void pending.then(
      () => { if (command === pending) command = undefined },
      () => { if (command === pending) command = undefined },
    )
    return pending
  }
  const refreshAfterChange = (): Promise<UpdateNotificationsState> => {
    changeRevision += 1
    if (afterChange !== undefined) return afterChange
    const generation = lifecycle
    const pending = Promise.resolve().then(async () => {
      while (generation === lifecycle) {
        // A request already underway can have captured the preferences before
        // their save. Concurrent changes while waiting share the next read.
        await (command ?? read)?.catch(() => state)
        if (generation !== lifecycle) return state
        const revision = changeRevision
        await refresh()
        if (revision === changeRevision) return state
        // A save completed during that read: one further read answers it.
      }
      return state
    })
    afterChange = pending
    void pending.finally(() => { if (afterChange === pending) afterChange = undefined })
    return pending
  }
  const preferencesChanged = (): void => { publish({ ...state }) }
  const storageChanged = (event: StorageEvent): void => {
    if (event.key === null || event.key === IGNORED_UPDATES_SESSION_KEY || event.key === RESTART_SESSION_KEY) preferencesChanged()
  }
  return {
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    start: () => {
      owners += 1
      if (owners === 1) {
        void refresh()
        timer = setInterval(() => { void refresh() }, POLL_MS)
        if (typeof window !== 'undefined') window.addEventListener('storage', storageChanged)
      }
      let released = false
      return () => {
        if (released) return
        released = true
        owners -= 1
        if (owners !== 0) return
        if (timer !== undefined) clearInterval(timer)
        timer = undefined
        if (typeof window !== 'undefined') window.removeEventListener('storage', storageChanged)
        lifecycle += 1
        requestSequence += 1
        for (const controller of controllers) controller.abort()
        controllers.clear()
        read = undefined
        command = undefined
        afterChange = undefined
        publish(initialState())
      }
    },
    refresh,
    refreshAfterChange,
    check: () => mutate({ check: true }),
    setEnabled: enabled => mutate({ enabled }),
    preferencesChanged,
  }
}

export const updateNotifications = createUpdateNotificationsStore()
export const getUpdateNotificationsSnapshot = updateNotifications.getSnapshot
export const subscribeUpdateNotifications = updateNotifications.subscribe
export const refreshUpdateNotifications = updateNotifications.refresh
export const refreshUpdateNotificationsAfterChange = updateNotifications.refreshAfterChange
export const checkUpdateNotifications = updateNotifications.check
export const setUpdateNotificationsEnabled = updateNotifications.setEnabled
export const notifyUpdatePreferencesChanged = updateNotifications.preferencesChanged

export function useUpdateNotifications(): UpdateNotificationsState {
  return useSyncExternalStore(subscribeUpdateNotifications, getUpdateNotificationsSnapshot, getUpdateNotificationsSnapshot)
}
