/** One local snapshot shared by the market page, settings and sidebar. */
import { useSyncExternalStore } from 'react'
import type { UpdateNotificationSnapshot as ServerUpdateNotificationSnapshot } from '../update-notifications.ts'
import { DEFAULT_UPDATE_CHECK_INTERVAL_HOURS, isUpdateCheckIntervalHours, type UpdateCheckIntervalHours } from '../update-notification-settings.ts'
import { api, readSession } from './market-data.ts'

// Older hot-loaded servers have no configurable interval. Keep their results
// without presenting a setting they cannot save.
export interface UpdateNotificationSnapshot extends Omit<ServerUpdateNotificationSnapshot, 'intervalHours'> {
  intervalHours: UpdateCheckIntervalHours | null
}

const IGNORED_UPDATES_SESSION_KEY = 'dshm-updates-ignored'
const RESTART_SESSION_KEY = 'dshm-restart'
const SEEN_UPDATES_KEY_PREFIX = 'dshm-updates-seen:'
const POLL_MS = 30_000

export interface UpdateNotificationsState extends UpdateNotificationSnapshot {
  /** False until the local notification endpoint has answered successfully. */
  loaded: boolean
  /** The last local request failed; retained data is not a fresh server sample. */
  readFailed: boolean
}

const initialState = (): UpdateNotificationsState => ({
  enabled: false, intervalHours: DEFAULT_UPDATE_CHECK_INTERVAL_HOURS, checking: false, checkedAt: null, lastSuccessAt: null,
  nextCheckAt: null, stale: false, error: null, updates: {}, boot: '',
  updateExempt: [], disabled: [], blocked: [], loaded: false, readFailed: false,
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

interface SeenScope { key: string; persistent: boolean }
// Storage can be unavailable in a restricted webview. Keep acknowledgements
// effective for this client lifetime; readable invalid records still fail open.
const seenInMemory = new Map<string, Set<string>>()
const unpersistedSeen = new Set<string>()

function seenScope(snapshot: UpdateNotificationSnapshot): SeenScope | null {
  const persistent = typeof snapshot.profileKey === 'string' && snapshot.profileKey !== ''
  if (!persistent && snapshot.boot === '') return null
  // The endpoint separates reverse-proxy deployments on the same origin;
  // profileKey is opaque and never stores the host's filesystem path here.
  return {
    key: SEEN_UPDATES_KEY_PREFIX + JSON.stringify([api('/dsh-market/update-notifications'),
      persistent ? 'profile' : 'boot', persistent ? snapshot.profileKey : snapshot.boot]),
    persistent,
  }
}

function seenStorage(scope: SeenScope): Storage {
  return scope.persistent ? localStorage : sessionStorage
}

function readSeen(scope: SeenScope): Set<string> {
  if (unpersistedSeen.has(scope.key)) return seenInMemory.get(scope.key) ?? new Set()
  try {
    const raw = seenStorage(scope).getItem(scope.key)
    if (raw === null) {
      seenInMemory.delete(scope.key)
      return new Set()
    }
    const saved: unknown = JSON.parse(raw)
    if (!isRecord(saved) || saved.version !== 1 || !Array.isArray(saved.fingerprints)
      || !saved.fingerprints.every(value => typeof value === 'string' && value !== '')) {
      seenInMemory.delete(scope.key)
      return new Set()
    }
    const fingerprints = new Set<string>(saved.fingerprints)
    seenInMemory.set(scope.key, fingerprints)
    return fingerprints
  } catch (error) {
    // A malformed JSON record is not evidence that an update was seen.
    if (error instanceof SyntaxError) {
      seenInMemory.delete(scope.key)
      return new Set()
    }
    return seenInMemory.get(scope.key) ?? new Set()
  }
}

function updateFingerprint(snapshot: UpdateNotificationSnapshot, name: string): string {
  const status = snapshot.updates[name]!
  const migration = status.sourceMigration
  return JSON.stringify([
    name, status.kind ?? null, status.current ?? null, status.version ?? null,
    status.eligibleVersion ?? status.latest ?? null, status.restoreRequired === true,
    migration?.kind === 'git-to-npm'
      ? [migration.kind, migration.repo, migration.target]
      : migration?.kind === 'npm-rename' ? [migration.kind, migration.from, migration.target] : null,
  ])
}

/** Sidebar attention is unread state; the pending update list stays intact. */
export function unseenNotificationNames(snapshot: UpdateNotificationSnapshot): string[] {
  const names = notificationNames(snapshot)
  const scope = seenScope(snapshot)
  if (scope === null) return names
  const seen = readSeen(scope)
  return names.filter(name => !seen.has(updateFingerprint(snapshot, name)))
}

/** Returns true only when the visit acknowledged at least one new update. */
function acknowledgeSnapshot(snapshot: UpdateNotificationSnapshot): boolean {
  const scope = seenScope(snapshot)
  if (scope === null) return false
  const saved = readSeen(scope)
  const seen = new Set(saved)
  for (const name of notificationNames(snapshot)) seen.add(updateFingerprint(snapshot, name))
  if (seen.size === saved.size) return false
  seenInMemory.set(scope.key, seen)
  try {
    seenStorage(scope).setItem(scope.key, JSON.stringify({ version: 1, fingerprints: [...seen] }))
    unpersistedSeen.delete(scope.key)
  } catch {
    // A full quota can block writes while reads still work. Remember that
    // the in-memory receipt is newer than the unchanged stored record.
    unpersistedSeen.add(scope.key)
  }
  return true
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
    && (value.checkFailed === undefined || value.checkFailed === true)
}

/** Reject a malformed local response instead of replacing a useful cached result. */
function readSnapshot(value: unknown): UpdateNotificationSnapshot {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || (value.intervalHours !== undefined && !isUpdateCheckIntervalHours(value.intervalHours)) || typeof value.checking !== 'boolean'
    || (value.profileKey !== undefined && (typeof value.profileKey !== 'string' || value.profileKey === ''))
    || typeof value.stale !== 'boolean' || typeof value.boot !== 'string'
    || !(value.error === null || typeof value.error === 'string')
    || !['checkedAt', 'lastSuccessAt', 'nextCheckAt'].every(key => value[key] === null || (typeof value[key] === 'number' && Number.isFinite(value[key])))
    || !['updateExempt', 'disabled', 'blocked'].every(key => Array.isArray(value[key]) && value[key].every((name: unknown) => typeof name === 'string'))
    || !isRecord(value.updates) || !Object.values(value.updates).every(isUpdateStatus)) {
    throw new Error('The update notification response was incomplete. Try checking again.')
  }
  return { ...value, intervalHours: value.intervalHours ?? null } as unknown as UpdateNotificationSnapshot
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
  setIntervalHours(intervalHours: UpdateCheckIntervalHours): Promise<UpdateNotificationsState>
  /** Acknowledge the updates visible when the host's Plugins page was entered. */
  acknowledge(snapshot?: UpdateNotificationSnapshot): void
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
  const run = async (body?: { enabled?: boolean; intervalHours?: UpdateCheckIntervalHours; check?: true }): Promise<UpdateNotificationsState> => {
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
      if (generation === lifecycle && sequence === requestSequence) publish({ ...next, loaded: true, readFailed: false })
    } catch (error) {
      if (generation !== lifecycle || controller.signal.aborted) return state
      if (sequence === requestSequence) publish({ ...state, readFailed: true, stale: true, error: error instanceof Error ? error.message : String(error) })
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
  const mutate = (body: { enabled?: boolean; intervalHours?: UpdateCheckIntervalHours; check?: true }): Promise<UpdateNotificationsState> => {
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
    if (event.key === null) {
      seenInMemory.clear()
      unpersistedSeen.clear()
    } else if (event.key.startsWith(SEEN_UPDATES_KEY_PREFIX)) {
      seenInMemory.delete(event.key)
      unpersistedSeen.delete(event.key)
    }
    if (event.key === null || event.key === IGNORED_UPDATES_SESSION_KEY || event.key === RESTART_SESSION_KEY
      || event.key.startsWith(SEEN_UPDATES_KEY_PREFIX)) preferencesChanged()
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
    setIntervalHours: intervalHours => state.intervalHours === null
      ? Promise.reject(new Error('This server does not support changing the check interval. Restart Harness to use this setting.'))
      : mutate({ intervalHours }),
    acknowledge: (snapshot = state) => { if (acknowledgeSnapshot(snapshot)) preferencesChanged() },
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
export const setUpdateNotificationsIntervalHours = updateNotifications.setIntervalHours
export const notifyUpdatePreferencesChanged = updateNotifications.preferencesChanged
export const acknowledgeUpdateNotifications = updateNotifications.acknowledge

export function useUpdateNotifications(): UpdateNotificationsState {
  return useSyncExternalStore(subscribeUpdateNotifications, getUpdateNotificationsSnapshot, getUpdateNotificationsSnapshot)
}
