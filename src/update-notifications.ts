/** Shared, read-only update checks for every market surface in one profile. */
import type { UpdateStatus } from './updates.ts'

export const UPDATE_CHECK_START_DELAY_MS = 30_000
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000
const RETRY_BASE_MS = 60_000

/** Notification data; reading a snapshot never contacts an update source. */
export interface UpdateNotificationSnapshot {
  enabled: boolean
  checking: boolean
  checkedAt: number | null
  lastSuccessAt: number | null
  nextCheckAt: number | null
  stale: boolean
  error: string | null
  updates: Record<string, UpdateStatus>
  boot: string
  updateExempt: string[]
  disabled: string[]
  blocked: string[]
}

export interface UpdateNotificationInventory {
  /** Includes the profile and release channel; a change invalidates all results. */
  context: string
  /** Per-package source, installed version and locked commit identity. */
  packages: Record<string, string>
}

interface MonitorDependencies {
  boot: string
  enabled: boolean
  inventory(): UpdateNotificationInventory
  preferences(): Pick<UpdateNotificationSnapshot, 'updateExempt' | 'disabled' | 'blocked'>
  check(force: boolean): Promise<{ updates: Record<string, UpdateStatus>; error?: string }>
}

export interface UpdateNotificationMonitor {
  snapshot(): UpdateNotificationSnapshot
  check(force?: boolean): Promise<Record<string, UpdateStatus>>
  setEnabled(enabled: boolean): void
  dispose(): void
}

/** Start one profile-scoped timer; callers own persistence of the enabled choice. */
export function createUpdateNotificationMonitor(deps: MonitorDependencies): UpdateNotificationMonitor {
  let enabled = deps.enabled
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let nextCheckAt: number | null = null
  let checkedAt: number | null = null
  let lastSuccessAt: number | null = null
  let error: string | null = null
  let stale = false
  let failures = 0
  let updates: Record<string, UpdateStatus> = {}
  let identity = deps.inventory()
  let pending: Promise<Record<string, UpdateStatus>> | null = null
  let pendingForced = false
  let queuedForce: Promise<Record<string, UpdateStatus>> | null = null

  const reconcile = (): UpdateNotificationInventory => {
    const current = deps.inventory()
    if (current.context !== identity.context) {
      updates = {}
      checkedAt = null
      lastSuccessAt = null
      error = null
      stale = true
    } else {
      const kept: Record<string, UpdateStatus> = {}
      for (const [name, status] of Object.entries(updates)) {
        if (current.packages[name] !== undefined && current.packages[name] === identity.packages[name]) kept[name] = status
        else stale = true
      }
      if (Object.keys(current.packages).some(name => current.packages[name] !== identity.packages[name])) stale = true
      updates = kept
    }
    identity = current
    return current
  }

  const stopTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    nextCheckAt = null
  }

  const schedule = (delay: number): void => {
    stopTimer()
    if (disposed || !enabled) return
    nextCheckAt = Date.now() + delay
    timer = setTimeout(() => { void check(stale) }, delay)
    timer.unref?.()
  }

  const check = (force = false): Promise<Record<string, UpdateStatus>> => {
    if (disposed) return Promise.resolve({ ...updates })
    if (pending !== null) {
      if (!force || pendingForced) return pending
      // A manual refresh arriving during a cache-eligible read must still
      // bypass that cache, once. Several such callers share the follow-up.
      queuedForce ??= pending.then(() => check(true)).finally(() => { queuedForce = null })
      return queuedForce
    }
    stopTimer()
    const started = reconcile()
    pendingForced = force || stale
    // Scheduling into a microtask also makes simultaneous callers share the
    // promise before input gathering starts.
    pending = Promise.resolve().then(async () => {
      try {
        const result = await deps.check(pendingForced)
        if (disposed) return { ...updates }
        const current = reconcile()
        const next = { ...updates }
        let incomplete = result.error !== undefined
        for (const [name, status] of Object.entries(result.updates)) {
          if (current.context !== started.context || current.packages[name] === undefined
            || current.packages[name] !== started.packages[name]) {
            incomplete = true
            continue
          }
          if (status.checkError !== undefined) {
            incomplete = true
            next[name] = { ...(updates[name] ?? status), checkError: status.checkError,
              ...(status.sourceMigration === undefined ? {} : { sourceMigration: status.sourceMigration }) }
          } else {
            next[name] = status
          }
        }
        if (Object.keys(current.packages).some(name => result.updates[name] === undefined
          || current.context !== started.context || current.packages[name] !== started.packages[name])) incomplete = true
        updates = next
        checkedAt = Date.now()
        stale = incomplete
        error = incomplete ? result.error ?? 'Some plugin updates could not be checked. Try again later.' : null
        if (!incomplete) lastSuccessAt = checkedAt
        failures = incomplete ? failures + 1 : 0
      } catch {
        if (disposed) return { ...updates }
        reconcile()
        updates = Object.fromEntries(Object.entries(updates).map(([name, status]) => [name, { ...status, checkError: 'unavailable' as const }]))
        checkedAt = Date.now()
        stale = true
        error = 'Plugin updates could not be checked. Try again later.'
        failures += 1
      } finally {
        pending = null
        if (!disposed) schedule(failures > 0
          ? Math.min(UPDATE_CHECK_INTERVAL_MS, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 5))
          : UPDATE_CHECK_INTERVAL_MS)
      }
      return { ...updates }
    })
    return pending
  }

  schedule(UPDATE_CHECK_START_DELAY_MS)
  return {
    snapshot: () => {
      reconcile()
      return {
        enabled, checking: pending !== null, checkedAt, lastSuccessAt, nextCheckAt,
        stale, error, updates: { ...updates }, boot: deps.boot, ...deps.preferences(),
      }
    },
    check,
    setEnabled: value => {
      if (enabled === value || disposed) return
      enabled = value
      stopTimer()
      if (enabled && pending === null) schedule(UPDATE_CHECK_START_DELAY_MS)
    },
    dispose: () => {
      disposed = true
      stopTimer()
    },
  }
}
