/**
 * The operations model behind the market's activity panel: one record per
 * mutating operation (install, update, uninstall), from the moment it is
 * queued until the user clears it.
 *
 * It exists because operation state used to live on the card that started it,
 * which disappears the moment the user paginates, searches, or switches tab —
 * taking any decision attached to it, such as a loader-id clash, along with
 * it. Records live here instead, keyed by their own id, so the card only has
 * to ask "is anything running for this url".
 *
 * Every function is pure so the queue, the aggregate counts, and the
 * three-way visual grouping can be tested without a host or a DOM.
 */

/** What a record does to the profile. */
export type OperationKind = 'install' | 'update' | 'uninstall'

/**
 * Lifecycle of one operation.
 *
 * `input` is not a failure: the host already reverted the change (a clash is
 * detected after pnpm resolves, and the package is removed on the spot), so
 * the profile is intact and the queue moves on. It means the operation cannot
 * finish until the user picks an outcome.
 */
export type OperationState = 'queued' | 'running' | 'input' | 'done' | 'warned' | 'failed'

/** The installed plugins one candidate clashed with, one entry per owner. */
export interface ConflictGroup {
  owner: string
  ids: string[]
}

export interface OperationRecord {
  /** Stable across re-renders; how actions address a record. */
  id: string
  kind: OperationKind
  /** Package name, or the catalog name for an install. */
  name: string
  /** Catalog url, present for installs — what a card is keyed by. */
  url?: string
  /** Original update options survive queueing and build approval; agent consent is never persisted. */
  updateOptions?: { force?: boolean; restore?: boolean; compatVersion?: string | undefined; eligibleVersion?: string }
  state: OperationState
  /** 0-100 while running; null when the host reports no total to divide by. */
  percent?: number | null
  /** The host's latest progress line, shown verbatim under the bar. */
  detail?: string
  /** Set with `input`: the installed plugins that hold the same entry ids. */
  conflicts?: ConflictGroup[]
  /** Set with `warned` or `failed`: one sentence naming what went wrong. */
  reason?: string
  /**
   * Set with `queued` when the host's agent guard is what is holding this
   * record: the sessions that were running when it refused (#752).
   *
   * Without it a queued row said only "queued · N ahead", which reads as an
   * operation that is merely last in line — and the user cannot tell that the
   * line is not moving at all, or why. The guard refuses before touching pnpm
   * ("wait for the running work"), so the count is the whole reason.
   */
  blockedBy?: string[]
  /**
   * Set with `failed` when pnpm refused to run a dependency's build scripts.
   * The way out is one click, so it belongs on the record that reports the
   * failure — the approval banner lives elsewhere on the page, and a reader
   * looking at this row was told to press a button they could not see (#314).
   */
  blockedBuilds?: string[]
  /** Set with `done` when the change needs a page refresh to be visible. */
  needsRefresh?: boolean
  /**
   * Set with `warned` when the profile's own minimumReleaseAge is what kept
   * this install off the newest release (#635).
   *
   * The plugin IS installed and works; it is simply not the newest one, and
   * the hold is the profile's policy rather than a failure. Carried on the
   * record so the row can say both things and offer the version the hold
   * refused — the one action a reader of that row would want.
   */
  heldRelease?: { latest: string; installed: string | null; because: string }
}

/**
 * Visual grouping. Six states are what the code has to distinguish; three are
 * what the panel shows, because a reader scanning icons and colors cannot
 * hold six apart. The distinction inside a bucket is carried by the record's
 * own status line, not by another color.
 */
export type OperationBucket = 'busy' | 'ok' | 'attention'

const BUCKETS: Record<OperationState, OperationBucket> = {
  queued: 'busy',
  running: 'busy',
  input: 'attention',
  failed: 'attention',
  done: 'ok',
  warned: 'ok',
}

/** Which of the three visual groups a state belongs to. */
export function bucketOf(state: OperationState): OperationBucket {
  return BUCKETS[state]
}

/** Whether a record has stopped moving on its own. */
export function isSettled(record: OperationRecord): boolean {
  return record.state === 'done' || record.state === 'warned' || record.state === 'failed'
}

/** Whether a record is waiting on the user rather than on the host. */
export function needsUser(record: OperationRecord): boolean {
  return record.state === 'input'
}

/** Append a record. Ids are supplied by the caller so tests stay deterministic. */
export function enqueue(list: readonly OperationRecord[], record: OperationRecord): OperationRecord[] {
  return [...list, record]
}

/**
 * Apply changes to one record.
 * @returns a new list; unchanged (same contents) when no record matches.
 */
export function patch(
  list: readonly OperationRecord[], id: string, changes: Partial<Omit<OperationRecord, 'id'>>,
): OperationRecord[] {
  return list.map(record => (record.id === id ? { ...record, ...changes } : record))
}

/** Drop one record outright — the panel's per-row dismiss. */
export function drop(list: readonly OperationRecord[], id: string): OperationRecord[] {
  return list.filter(record => record.id !== id)
}

/**
 * Clear finished records, keeping anything still moving or still waiting on
 * the user. A record in `input` survives: the user has not answered it yet,
 * and clearing it would delete the only route back to that decision.
 */
export function clearSettled(list: readonly OperationRecord[]): OperationRecord[] {
  return list.filter(record => !isSettled(record))
}

/**
 * How many queued records sit ahead of this one. The panel shows it because
 * "queued" without a position reads as stuck; the host runs one mutation at a
 * time, so the order shown is the order that will run.
 * @returns the count ahead, or null when the record is not queued.
 */
export function queuePosition(list: readonly OperationRecord[], id: string): number | null {
  const queued = list.filter(record => record.state === 'queued')
  const index = queued.findIndex(record => record.id === id)
  return index < 0 ? null : index
}

export interface OperationSummary {
  running: number
  queued: number
  /**
   * Queued records the host's agent guard refused, out of `queued` (#752).
   *
   * Counted apart because the aggregate line has to be able to say it: with
   * nothing running, "installing 0/3" states a contradiction the user cannot
   * resolve, while "3 waiting for the agents to go idle" names the obstacle.
   */
  blocked: number
  /** Records waiting on a decision. */
  attention: number
  /** Records that finished, however they finished. */
  settled: number
  /** running + queued + settled: the denominator of "3 / 7". */
  total: number
  /** settled + running, the numerator — a running item is the one in flight. */
  progressed: number
}

/**
 * Counts for the panel entry. The entry reports the batch, never one row:
 * one aggregate line beats seven notifications racing each other.
 */
export function summarize(list: readonly OperationRecord[]): OperationSummary {
  let running = 0
  let queued = 0
  let blocked = 0
  let attention = 0
  let settled = 0
  for (const record of list) {
    if (record.state === 'running') running += 1
    else if (record.state === 'queued') {
      queued += 1
      if ((record.blockedBy?.length ?? 0) > 0) blocked += 1
    } else if (needsUser(record)) attention += 1
    else settled += 1
  }
  return {
    running,
    queued,
    blocked,
    attention,
    settled,
    total: running + queued + settled,
    progressed: settled + running,
  }
}

/**
 * Panel order: what needs the user first, then what is still moving, then
 * what is finished. Within a group the original order is kept so a queue
 * reads top-to-bottom in the order it will run.
 */
export function sortForPanel(list: readonly OperationRecord[]): OperationRecord[] {
  const rank = (record: OperationRecord): number =>
    needsUser(record) ? 0 : isSettled(record) ? 2 : 1
  return [...list]
    .map((record, index) => ({ record, index }))
    .sort((a, b) => rank(a.record) - rank(b.record) || a.index - b.index)
    .map(entry => entry.record)
}

/**
 * The record a plugin card should reflect, newest first. A card shows the
 * button state for an operation in flight and a terminal marker for one that
 * ended without installing — without that marker a rejected install leaves
 * the card looking untouched, and the obvious next move is to press Install
 * again.
 */
export function recordForUrl(list: readonly OperationRecord[], url: string): OperationRecord | null {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const record = list[index]
    if (record.url === url) return record
  }
  return null
}

/**
 * Where finished rows survive a page load. Only rows that ended: `queued`
 * belongs to the queue key and `running` to the dshm-pending markers, and an
 * `input` row is a question this session asked, not one a later one can
 * answer.
 */
export const SETTLED_STORAGE_KEY = 'dshm-settled-v1'

/**
 * How many finished rows are kept. Enough to cover a night of failed installs
 * and the way out of each; not enough to grow without bound in a key the user
 * never clears.
 */
export const SETTLED_LIMIT = 20

/**
 * The finished rows worth putting back after a reload, oldest first and newest
 * last, capped to the most recent SETTLED_LIMIT.
 *
 * It keeps only what a restored row needs to be re-rendered and acted on: the
 * id actions address, the kind/name/url the row is about, the terminal state,
 * and the decision or sentence attached to it — the reason it failed, the build
 * scripts awaiting approval, a held release. `detail` is kept for the same
 * reason: it is the row's own report.
 *
 * Failed updates awaiting build approval also keep their original update
 * options so approving after a reload cannot select a different target.
 * `blockedBy` and `conflicts` are deliberately dropped. `needsRefresh` is written so the
 * stored shape stays the record's own, but the restore drops it: only the page
 * that wrote it can still be waiting for that reload.
 */
export function serializeSettled(list: readonly OperationRecord[]): OperationRecord[] {
  return list
    .filter(isSettled)
    .slice(-SETTLED_LIMIT)
    .map(record => ({
      id: record.id,
      kind: record.kind,
      name: record.name,
      ...(record.url === undefined ? {} : { url: record.url }),
      state: record.state,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
      ...(record.detail === undefined ? {} : { detail: record.detail }),
      ...(record.blockedBuilds === undefined ? {} : { blockedBuilds: [...record.blockedBuilds] }),
      ...(record.kind === 'update' && record.state === 'failed' && (record.blockedBuilds?.length ?? 0) > 0 && record.updateOptions !== undefined
        ? { updateOptions: { ...record.updateOptions } } : {}),
      ...(record.needsRefresh === true ? { needsRefresh: true } : {}),
      ...(record.heldRelease === undefined ? {} : { heldRelease: { ...record.heldRelease } }),
    }))
}

/** A non-empty string, or undefined — storage entries are not trusted. */
function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** The string entries of a stored array, or undefined when there are none. */
function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
  return list.length === 0 ? undefined : list
}

/**
 * The release a `warned` row was held back from. Validated as a whole: the row
 * offers it as an action, and half of it would offer the wrong version.
 */
function asHeldRelease(value: unknown): OperationRecord['heldRelease'] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entry = value as Record<string, unknown>
  const latest = asText(entry.latest)
  const because = asText(entry.because)
  const installed = entry.installed === null ? null : asText(entry.installed)
  if (latest === undefined || because === undefined || installed === undefined) return undefined
  return { latest, installed, because }
}

/**
 * One stored row, or null when it is not a finished operation this code can
 * still show. Malformed optional fields are dropped rather than taken as a
 * reason to lose the row: the failure itself is still the only place the user
 * can read what happened.
 */
function restoreSettledRecord(value: unknown): OperationRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const id = asText(row.id)
  const name = asText(row.name)
  const kind = row.kind === 'install' || row.kind === 'update' || row.kind === 'uninstall' ? row.kind : undefined
  const state = row.state === 'done' || row.state === 'warned' || row.state === 'failed' ? row.state : undefined
  if (id === undefined || name === undefined || kind === undefined || state === undefined) return null
  const url = asText(row.url)
  const reason = asText(row.reason)
  const detail = asText(row.detail)
  const blockedBuilds = asStringList(row.blockedBuilds)
  const heldRelease = asHeldRelease(row.heldRelease)
  const options = row.updateOptions !== null && typeof row.updateOptions === 'object' && !Array.isArray(row.updateOptions)
    ? row.updateOptions as Record<string, unknown> : undefined
  const updateOptions = kind === 'update' && state === 'failed' && blockedBuilds !== undefined && options !== undefined ? {
    ...(typeof options.force === 'boolean' ? { force: options.force } : {}),
    ...(typeof options.restore === 'boolean' ? { restore: options.restore } : {}),
    ...(asText(options.compatVersion) === undefined ? {} : { compatVersion: asText(options.compatVersion) }),
    ...(asText(options.eligibleVersion) === undefined ? {} : { eligibleVersion: asText(options.eligibleVersion) }),
  } : undefined
  return {
    id,
    kind,
    name,
    ...(url === undefined ? {} : { url }),
    state,
    ...(reason === undefined ? {} : { reason }),
    ...(detail === undefined ? {} : { detail }),
    ...(blockedBuilds === undefined ? {} : { blockedBuilds }),
    ...(updateOptions === undefined ? {} : { updateOptions }),
    // `needsRefresh` is deliberately not restored: it told the reader of the
    // previous page to reload, and this row is only being read because that
    // reload already happened. Restoring it would ask for a refresh taken.
    ...(heldRelease === undefined ? {} : { heldRelease }),
  }
}

/**
 * Rows read back from storage, or an empty list for anything that cannot be
 * trusted. localStorage is user-writable and outlives versions of this code, so
 * every entry is re-checked instead of cast: an unknown kind, a state that is
 * not terminal, a missing id, or a field of the wrong type must never reach the
 * panel. A malformed value yields no rows rather than throwing — a bad key is a
 * lost history, not a broken market.
 */
export function restoreSettled(raw: unknown): OperationRecord[] {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw) } catch { return [] }
  }
  if (!Array.isArray(parsed)) return []
  const restored: OperationRecord[] = []
  const seen = new Set<string>()
  for (const value of parsed) {
    const record = restoreSettledRecord(value)
    // First occurrence wins, so a corrupted duplicate cannot paint one row twice.
    if (record === null || seen.has(record.id)) continue
    seen.add(record.id)
    restored.push(record)
  }
  return restored.slice(-SETTLED_LIMIT)
}
