/**
 * Outbound HTTP for the market's own server-side calls.
 *
 * Node's global `fetch` ignores `HTTP_PROXY` / `HTTPS_PROXY` entirely
 * (measured on Node 25: a request with an unreachable proxy configured still
 * succeeds directly, and setting `NODE_USE_ENV_PROXY` at runtime changes
 * nothing — it is read at startup). On a machine whose route out is a local
 * proxy, that is not a slowdown but a different network: the catalog fetch
 * took 9.9s direct on a reporter's machine, seconds from the 15s timeout,
 * while their proxy sat unused a millisecond away.
 *
 * `setGlobalDispatcher` from the `undici` PACKAGE cannot fix this, because
 * `globalThis.fetch` runs on Node's INTERNAL copy of undici — a different
 * instance. Verified: with a dispatcher installed, a global fetch still
 * produced no CONNECT at a local proxy, while undici's own fetch produced
 * `CONNECT awesome-dsh-plugin.com:443`.
 *
 * So the market calls undici's fetch with an explicit dispatcher. The scope
 * is deliberate: only requests made by this module change, and the host's
 * own networking is left exactly as the host configured it.
 */

import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici'

/**
 * The proxy this process would use for the catalog, if any.
 *
 * This mirrors `EnvHttpProxyAgent`'s own resolution deliberately, rather
 * than picking the order that reads best, because the same answer does two
 * jobs: it decides whether to route through undici at all, and it is what
 * the failure message CLAIMS was tried. A helper that named a proxy undici
 * would not have used would put a false statement in every bug report.
 *
 * Three details are undici's, not ours (env-http-proxy-agent.js):
 *   - lowercase wins over uppercase (`https_proxy ?? HTTPS_PROXY`)
 *   - an https request falls back to the http proxy when no https one is set
 *   - the value is tested for truthiness, so `HTTPS_PROXY=` — which is how
 *     people turn a proxy off — falls through instead of masking HTTP_PROXY
 *
 * Blank-is-unset is ours, and only widens that last one: undici would hand a
 * whitespace-only value to `new URL()` and throw out of the constructor.
 */
export function configuredProxy(): string | null {
  const pick = (raw: string | undefined): string | null =>
    raw === undefined || raw.trim() === '' ? null : raw.trim()
  const https = pick(process.env.https_proxy ?? process.env.HTTPS_PROXY)
  return https ?? pick(process.env.http_proxy ?? process.env.HTTP_PROXY)
}

/**
 * Built once and reused: an agent per request would drop connection reuse,
 * and this one reads NO_PROXY as well, so a host that excludes its own
 * registry mirror keeps being excluded.
 */
let agent: EnvHttpProxyAgent | null = null

/**
 * Fetch through the proxy this machine is configured to use.
 *
 * Falls back to the global fetch when no proxy is set, which keeps the
 * ordinary case on the runtime's own path rather than routing it through a
 * second HTTP stack for no reason.
 */
export async function marketFetch(
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
): Promise<Response> {
  if (configuredProxy() === null) return await fetch(url, init)
  agent ??= new EnvHttpProxyAgent()
  return await undiciFetch(url, { ...init, dispatcher: agent }) as unknown as Response
}
