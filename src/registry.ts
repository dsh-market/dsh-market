/**
 * Registry access: the curated list from awesome-dsh-plugin.com, fetched
 * fresh on every request. See `loadRegistry` for why there is nothing
 * behind it any more.
 */

import { configuredProxy, marketFetch } from './net.ts'

export interface RegistryPlugin {
  name: string
  owner: string
  url: string
  category: string
  description: Record<string, string>
  npm?: string | null
  stars?: number | null
  install: string
  added: string
  /**
   * Catalog-side deprecation flags (#60): supplied by awesome-dsh-plugin,
   * absent for every normal entry — the market only consumes them, so a
   * catalog without the fields behaves exactly as before.
   */
  deprecated?: boolean
  /** Catalog name of the suggested replacement plugin, when deprecated. */
  replacement?: string
}

export interface Registry {
  updated: string
  count: number
  categories: Record<string, Record<string, string>>
  plugins: RegistryPlugin[]
}

/**
 * Where the curated list comes from. Overridable through the process
 * environment ONLY — the layer-3 e2e points it at a local fixture catalog so
 * the install route can be driven end to end without publishing anything.
 *
 * This does not weaken the install route's registry check. That check exists
 * to stop a malicious PAGE from POSTing an arbitrary source at the local
 * server; a page cannot set environment variables, and anyone who can set
 * this process's environment already controls the process. What the override
 * changes is WHICH list is curated, never WHETHER the check runs.
 */
const REGISTRY_URL = process.env.DSHM_REGISTRY_URL ?? 'https://awesome-dsh-plugin.com/plugins.json'

/**
 * How long to wait for the catalog.
 *
 * Generous on purpose. It used to be 4s with a bundled snapshot behind it,
 * so a slow link quietly became a 39%-smaller catalog. Now that a failure is
 * reported rather than papered over, cutting off a link that WOULD have
 * answered is the expensive mistake — 282KB over TLS from a far-away network
 * is not a 4-second job.
 */
const FETCH_TIMEOUT_MS = 15_000

/**
 * The catalog, fetched every time it is asked for.
 *
 * There used to be three answers here — live, a one-hour in-memory cache,
 * and a snapshot bundled into the npm package — and only the first was
 * correct. The other two were indistinguishable from it on screen, so a
 * machine that could not reach the registry browsed the publish-time file
 * (839 entries against 1367 live, and frozen forever for anyone on an older
 * release), while a machine that COULD reach it still saw an hour-old
 * listing of a catalog that grows by ~250 entries a day.
 *
 * For a catalog, stale is not a degraded answer, it is a wrong one: a plugin
 * published this morning reads as "does not exist". So there is one source
 * now, and a failure is a failure — the caller reports it and offers a
 * retry, which is a state the user can act on.
 * @throws when the catalog cannot be fetched or does not look like one.
 */
export async function loadRegistry(): Promise<Registry> {
  const started = Date.now()
  let last: unknown
  // Two attempts. A catalog fetch crossing a long, lossy path fails
  // transiently often enough that one retry is worth more than the second
  // or two it costs — and with nothing behind this call any more, a
  // transient failure is a market with no plugins in it.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await marketFetch(REGISTRY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
      const data = (await res.json()) as Registry
      if (!Array.isArray(data.plugins) || data.plugins.length === 0) throw new Error('the catalog came back empty')
      return data
    } catch (error) {
      last = error
    }
  }
  throw new Error(describeFetchFailure(last, Date.now() - started))
}

/**
 * A catalog failure with the facts needed to classify it, in the message
 * itself.
 *
 * The market shows this string and the log export carries it, so it is the
 * whole of what a bug report will contain. "The operation was aborted due to
 * timeout" alone cannot distinguish a slow link from a blocked one from a
 * proxy this process cannot use — and Node's `fetch` ignores HTTP_PROXY
 * entirely (measured on Node 25), so a machine whose only route out is a
 * proxy fails here every time while every other tool on it works.
 */
export function describeFetchFailure(error: unknown, elapsedMs: number): string {
  const reason = error instanceof Error ? error.message : String(error)
  const proxy = configuredProxy()
  const parts = [`${reason} (${String(Math.round(elapsedMs / 1000))}s, 2 attempts)`]
  if (proxy !== null) {
    parts.push(`tried through the configured proxy ${proxy.replace(/\/\/[^@]*@/u, '//***@')}`)
  }
  return parts.join(' · ')
}
