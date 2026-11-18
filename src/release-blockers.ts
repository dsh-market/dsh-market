/**
 * Profile-level fresh-release blockers (#1252).
 *
 * pnpm checks the WHOLE lockfile against `minimumReleaseAge` before it lets
 * any change through. One young entry (say `dsh-mobile-plugin@0.5.71`) makes
 * every update, install and removal of that profile fail, whichever plugin
 * the user clicked. The update check only judges each plugin's own target
 * (#945), so every row still looked updatable.
 *
 * The market does not ask the registry for the publish time of every lockfile
 * entry. It learns from the first refusal instead: pnpm prints each offending
 * `name@version` with its publish time, and that is kept here until the wait
 * ends. No extra registry traffic, and nothing is guessed: a time that cannot
 * be read is recorded as unknown and held for a short, fixed time (#961).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ReleaseBlocker {
  name: string
  version: string
  /** ISO time pnpm printed, or null when it printed none we can read. */
  publishedAt: string | null
  /** ISO time the safety wait ends, or null when it cannot be worked out. */
  readyAt: string | null
}

interface StoredBlocker extends ReleaseBlocker {
  /** Epoch ms the market learned of it; only used to expire an unknown time. */
  learnedAt: number
}

/** How long a blocker with an unknown end time is believed (same as #961). */
export const UNKNOWN_BLOCKER_TTL_MS = 30 * 60 * 1000
const MAX_BLOCKERS = 50
const FILE = join('.dsh-market', 'release-blockers.json')

const ISO_TIME = /\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})/
const LINE = /^\s*((?:@[^/\s@]+\/)?[^\s@]+)@(\d[^\s]*?)\s+was published at\b(.*)$/

/** `a-{x,y}` becomes `a-x`, `a-y`; any other name is returned as is. */
function expandBraces(name: string): string[] {
  const match = /^(.*)\{([^{}]+)\}(.*)$/.exec(name)
  if (match === null) return [name]
  return match[2]!.split(',').map(part => `${match[1]}${part.trim()}${match[3]}`)
}

/**
 * Read the entries pnpm refused out of its violation output.
 * @param output - pnpm's combined stdout and stderr.
 * @param windowMs - the profile's effective wait, or null when it is unknown.
 * @param now - epoch ms, injectable for tests.
 * @returns one blocker per `name@version`; empty when the output names none.
 */
export function parseReleaseAgeBlockers(output: string, windowMs: number | null, now = Date.now()): ReleaseBlocker[] {
  // Only the lockfile verification lists entries that are already in the
  // profile. Any other release-age failure is about a target and says nothing
  // about what else would be refused.
  if (!output.includes('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION') || !/lockfile entr(?:y|ies) failed verification/.test(output)) return []
  const seen = new Set<string>()
  const blockers: ReleaseBlocker[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = LINE.exec(line)
    if (match === null) continue
    const time = ISO_TIME.exec(match[3] ?? '')?.[0]
    const published = time === undefined ? Number.NaN : Date.parse(time)
    const publishedAt = Number.isFinite(published) ? new Date(published).toISOString() : null
    // A window that would already have ended contradicts pnpm's refusal: the
    // market is reading a different wait than pnpm used. Say "unknown" rather
    // than record a wait that is over and would never be believed.
    const ready = publishedAt === null || windowMs === null ? null : published + windowMs
    const readyAt = ready === null || ready <= now ? null : new Date(ready).toISOString()
    for (const name of expandBraces(match[1]!)) {
      const key = `${name}@${match[2]!}`
      if (seen.has(key)) continue
      seen.add(key)
      blockers.push({ name, version: match[2]!, publishedAt, readyAt })
      if (blockers.length >= MAX_BLOCKERS) return blockers
    }
  }
  return blockers
}

const memory = new Map<string, StoredBlocker[]>()

function load(dir: string): StoredBlocker[] {
  const cached = memory.get(dir)
  if (cached !== undefined) return cached
  let loaded: StoredBlocker[] = []
  try {
    const raw = JSON.parse(readFileSync(join(dir, FILE), 'utf8')) as { blockers?: unknown }
    if (Array.isArray(raw.blockers)) {
      loaded = raw.blockers.flatMap((item): StoredBlocker[] => {
        const entry = item as Partial<StoredBlocker> | null
        if (entry === null || typeof entry !== 'object') return []
        if (typeof entry.name !== 'string' || typeof entry.version !== 'string' || typeof entry.learnedAt !== 'number') return []
        return [{
          name: entry.name, version: entry.version, learnedAt: entry.learnedAt,
          publishedAt: typeof entry.publishedAt === 'string' ? entry.publishedAt : null,
          readyAt: typeof entry.readyAt === 'string' ? entry.readyAt : null,
        }]
      })
    }
  } catch { /* no file, or unreadable: start empty */ }
  memory.set(dir, loaded)
  return loaded
}

function save(dir: string, blockers: StoredBlocker[]): void {
  memory.set(dir, blockers)
  try {
    const file = join(dir, FILE)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, JSON.stringify({ blockers }))
  } catch { /* memory still holds it; a restart just relearns on the next refusal */ }
}

/** Remember what pnpm just refused, replacing whatever was known for this profile. */
export function recordReleaseBlockers(dir: string, blockers: readonly ReleaseBlocker[], now = Date.now()): void {
  if (blockers.length === 0) return
  save(dir, blockers.map(blocker => ({ ...blocker, learnedAt: now })))
}

/** Forget every blocker of this profile (a mutation went through without a bypass). */
export function clearReleaseBlockers(dir: string): void {
  if (load(dir).length === 0) return
  save(dir, [])
}

/** Test seam: drop the in-memory copy so the next read comes from disk (a restart). */
export function forgetReleaseBlockerMemory(): void {
  memory.clear()
}

/** Whether the lockfile still pins `name@version`; true when it cannot be read. */
function lockfileStillHas(dir: string, blocker: ReleaseBlocker): boolean {
  let text: string
  try { text = readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8') } catch { return true }
  const escaped = `${blocker.name}@${blocker.version}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[\\s'"/(])${escaped}(?![\\w.+-])`, 'm').test(text)
}

/**
 * The blockers that still hold, with the ended and the departed dropped.
 * A blocker ends at its time, or after {@link UNKNOWN_BLOCKER_TTL_MS} when
 * the time is unknown, or as soon as the lockfile no longer pins it.
 */
export function activeReleaseBlockers(dir: string, now = Date.now()): ReleaseBlocker[] {
  const all = load(dir)
  if (all.length === 0) return []
  const live = all.filter(blocker => (blocker.readyAt === null
    ? blocker.learnedAt + UNKNOWN_BLOCKER_TTL_MS > now
    : Date.parse(blocker.readyAt) > now) && lockfileStillHas(dir, blocker))
  if (live.length !== all.length) save(dir, live)
  return live.map(({ learnedAt: _learnedAt, ...blocker }) => blocker)
}

/** The one blocker to name: an unknown time first (nothing is certain), else the last to end. */
export function headlineBlocker(blockers: readonly ReleaseBlocker[]): ReleaseBlocker | null {
  let best: ReleaseBlocker | null = null
  for (const blocker of blockers) {
    if (blocker.readyAt === null) return blocker
    if (best === null || Date.parse(blocker.readyAt) > Date.parse(best.readyAt!)) best = blocker
  }
  return best
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** `11-19 12:56` in the server's local time. */
function clock(at: string): string {
  const date = new Date(at)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** What the update route says when it declines to start (bilingual, `zh / en`). */
export function releaseBlockedMessage(blocker: ReleaseBlocker): string {
  const what = `${blocker.name} ${blocker.version}`
  if (blocker.readyAt === null) {
    return `要等 ${what} 满安全等待期后才能更新（时间未知）。在那之前，任何插件都更新不了，所以没有开始。 / Updates wait until ${what} has passed the safety wait (time unknown). Until then no plugin can be updated, so nothing was started.`
  }
  const when = clock(blocker.readyAt)
  return `要等 ${what} 满安全等待期（约 ${when}）后才能更新。在那之前，任何插件都更新不了，所以没有开始。 / Updates wait until ${what} has passed the safety wait (about ${when}). Until then no plugin can be updated, so nothing was started.`
}
