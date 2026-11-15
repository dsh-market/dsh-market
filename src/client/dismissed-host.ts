/**
 * The host rows the user already cleared (#1184).
 *
 * Every finished row in the operations panel is a projection of the host's
 * own `/dsh-market/status` answer, not a record this page owns: "clear
 * settled" and "dismiss" can only stop THIS page from drawing it. Before
 * #1184 that decision lived in a `useRef`, so the next mount — a reload, or
 * leaving the market and coming back — started with an empty set and the host
 * quietly put the same rows back on screen. The user had cleared them; the
 * page had simply forgotten.
 *
 * So the set is written down, next to the market's other page-local
 * bookkeeping (`dshm-drain-v1`, `dshm-settled-v1`). It is not market state:
 * nothing survives a profile reset here, and a different browser profile
 * clearing its own rows must not hide them in this one.
 *
 * The ids are the host's `operationId`s, which is also why the list can be
 * capped without losing anything current: an id is only ever asked about
 * while the host still reports that operation.
 */

/** Where the cleared host rows are kept. */
export const DISMISSED_HOST_STORAGE_KEY = 'dshm-dismissed-host-v1'

/**
 * How many cleared ids are remembered. A session produces a handful; the cap
 * exists because this key is never cleared by the user, and a list that grows
 * for years is a slow leak in a place nobody looks (the same reasoning as
 * `SETTLED_LIMIT` in operations.ts).
 */
export const DISMISSED_HOST_LIMIT = 100

/** Oldest first, newest last: the order that makes a cap drop the oldest. */
function read(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_HOST_STORAGE_KEY)
    if (raw === null) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    // Storage is user-writable and outlives this code, so nothing in it is
    // trusted: only non-empty strings survive, duplicates collapse.
    const out: string[] = []
    for (const item of parsed) {
      if (typeof item !== 'string' || item === '' || out.includes(item)) continue
      out.push(item)
    }
    return out.slice(-DISMISSED_HOST_LIMIT)
  } catch {
    // Storage unavailable (private mode, quota, a hand-edited key): the page
    // behaves exactly as it did before #1184 rather than failing to render.
    return []
  }
}

function write(ids: readonly string[]): void {
  try {
    localStorage.setItem(DISMISSED_HOST_STORAGE_KEY, JSON.stringify(ids.slice(-DISMISSED_HOST_LIMIT)))
  } catch { /* storage unavailable — memory still hides the row for this mount */ }
}

let cache: Set<string> | null = null

/**
 * The ids to keep off screen, read once per page. The component holds this
 * set for the lifetime of the mount and asks it on every status poll, so the
 * parse happens once instead of once per render.
 */
export function dismissedHostIdSet(): Set<string> {
  cache ??= new Set(read())
  return cache
}

/** The user cleared this host row: it must stay cleared across a reload. */
export function rememberDismissedHostId(id: string): void {
  if (id === '') return
  const ids = [...dismissedHostIdSet()]
  if (ids.includes(id)) return
  ids.push(id)
  cache = new Set(ids.slice(-DISMISSED_HOST_LIMIT))
  write([...cache])
}

/** Drop the memoized set so a test can start from another storage state. */
export function resetDismissedHostCache(): void {
  cache = null
}
