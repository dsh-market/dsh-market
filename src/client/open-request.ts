/**
 * "Open this plugin's install dialog" from outside the market page: the
 * `/find-plugin` card in the chat, or the AI search results.
 *
 * The card cannot reach the market's state, and the market page may not even
 * be mounted yet when the button is pressed (the host navigates there first).
 * So the request waits here until a mounted market claims it, once its
 * catalog has loaded and it can find the entry by name.
 */
type Listener = () => void

let pending: { name: string; at: number } | null = null
const listeners = new Set<Listener>()

/** How long a request waits for a market to claim it. */
const TTL_MS = 30_000

export function requestOpenPlugin(name: string): void {
  pending = { name, at: Date.now() }
  for (const listener of [...listeners]) listener()
}

/** The name a market should open, or null. Expired requests are dropped. */
export function pendingOpenPlugin(): string | null {
  if (pending !== null && Date.now() - pending.at > TTL_MS) pending = null
  return pending?.name ?? null
}

/** Claim it: the first market to open the dialog clears the request. */
export function claimOpenPlugin(name: string): void {
  if (pending?.name === name) pending = null
}

export function subscribeOpenPlugin(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
