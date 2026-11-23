/**
 * "Open this plugin's install dialog" from outside the market page: the
 * `/find-plugin` card in the chat.
 *
 * The card cannot reach the market's state, and the market page may not even
 * be mounted yet when the button is pressed (the host navigates there first).
 * So the request waits here until a mounted market claims it, once its
 * catalog has loaded and it can find the entry by repository URL.
 */
type Listener = () => void

let pending: { url: string; at: number } | null = null
const listeners = new Set<Listener>()

/** How long a request waits for a market to claim it. */
const TTL_MS = 30_000

export function requestOpenPlugin(url: string): void {
  pending = { url, at: Date.now() }
  for (const listener of [...listeners]) listener()
}

/** The catalog URL a market should open, or null. Expired requests are dropped. */
export function pendingOpenPlugin(): string | null {
  if (pending !== null && Date.now() - pending.at > TTL_MS) pending = null
  return pending?.url ?? null
}

/** Claim it: the first market to open the dialog clears the request. */
export function claimOpenPlugin(url: string): boolean {
  if (pendingOpenPlugin() !== url) return false
  pending = null
  return true
}

export function subscribeOpenPlugin(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
