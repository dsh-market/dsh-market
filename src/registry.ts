/**
 * Registry access: the curated list from awesome-dsh-plugin.com, fetched
 * fresh on every request. See `loadRegistry` for why there is nothing
 * behind it any more.
 */

import { configuredProxy, marketFetch } from './net.ts'
import { catalogFromPackage } from './catalog-npm.ts'
import { activeRegion, routesFor, type CatalogSource, type Region } from './regions.ts'
import { resolveInstallOrder } from './dependencies.ts'

export interface RegistryPlugin {
  name: string
  owner: string
  url: string
  /** One legacy category id or several category ids. */
  category: string | string[]
  description: Record<string, string>
  npm?: string | null
  tarball?: string | null
  stars?: number | null
  /**
   * npm downloads in the last 30 days, when the entry has a published
   * package. `null`/absent means "no npm package" — a coverage gap, not a
   * zero — so sorting must not read it as "less popular than 0".
   */
  downloads?: number | null
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
  /** Repository URLs of platform plugins that must activate before this entry. */
  requires?: string[]
}

/**
 * Category ids for one catalog entry, de-duplicated in declaration order.
 *
 * Catalog JSON is an external input, so malformed array members are omitted
 * here and an entry with no usable category is rejected by `asRegistry`.
 */
export function pluginCategories(plugin: Pick<RegistryPlugin, 'category'>): string[] {
  const values: unknown[] = Array.isArray(plugin.category) ? plugin.category : [plugin.category]
  const categories: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || value === '' || seen.has(value)) continue
    seen.add(value)
    categories.push(value)
  }
  return categories
}

export interface Registry {
  updated: string
  count: number
  categories: Record<string, Record<string, string>>
  plugins: RegistryPlugin[]
}

/**
 * Where the curated list comes from now lives in the region routing table
 * (src/regions.ts), because it is one of several addresses that move
 * together when a user changes download region.
 *
 * `DSHM_REGISTRY_URL` keeps its meaning there, unchanged: overridable
 * through the process environment ONLY — the layer-3 e2e points it at a
 * local fixture catalog so the install route can be driven end to end
 * without publishing anything.
 *
 * This does not weaken the install route's registry check. That check exists
 * to stop a malicious PAGE from POSTing an arbitrary source at the local
 * server; a page cannot set environment variables, and anyone who can set
 * this process's environment already controls the process. What the override
 * changes is WHICH list is curated, never WHETHER the check runs.
 */

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
 * The catalog we were last served, with the validator identifying it.
 *
 * This is NOT the cache that was removed, and the difference is the whole
 * point. That cache SKIPPED the request for an hour and answered from
 * memory — it asserted freshness without ever asking. This asks the origin
 * every single time; the validator only lets the origin answer "still the
 * same" (304) instead of resending a megabyte. Freshness is verified on
 * every call either way, so `data` below is only ever returned when the
 * server has just confirmed it is current.
 *
 * In memory rather than on disk: a restart is rare enough that paying one
 * full download for it costs nothing, and a file would be one more thing
 * that can be found on a machine and mistaken for the catalog itself.
 *
 * Measured against the live origin (GitHub Pages behind Fastly, which
 * serves both `etag` and `last-modified`): 295 KB and 1.3s unconditional,
 * 0 bytes and 0.5s for a 304. The reporter whose fetch took 9.9s was
 * downloading the full 1.07 MB every time they opened the market.
 */
interface ServedCatalog {
  /** Which source issued this, so a validator is never sent to another one. */
  key: string
  etag: string | null
  modified: string | null
  /** The published version, for the npm route — its equivalent of an ETag. */
  version: string | null
  data: Registry
}

/** Revalidation state is independent per origin when several catalogs are composed. */
const served = new Map<string, ServedCatalog>()

/** Additional required catalogs configured by the active market instance. */
let additionalRegistryUrls: string[] = []

/** Identity of a catalog source, for scoping the validator to its origin. */
function sourceKey(source: CatalogSource): string {
  return source.kind === 'npm' ? `npm:${source.registry}/${source.pkg}` : `url:${source.url}`
}

/** A parsed catalog, or a thrown explanation of why it is not one. */
function asRegistry(value: unknown): Registry {
  const data = value as Registry
  if (!Array.isArray(data.plugins) || data.plugins.length === 0) throw new Error('the catalog came back empty')
  const plugins = data.plugins.map((plugin, index) => {
    const category = pluginCategories(plugin)
    if (category.length === 0) throw new Error(`catalog plugin ${String(index)} carries no usable category`)
    const requires = plugin.requires
    if (requires !== undefined && (!Array.isArray(requires) || requires.some(url => typeof url !== 'string' || !/^https?:\/\//u.test(url)))) {
      throw new Error(`catalog plugin ${String(index)} carries invalid requires URLs`)
    }
    return { ...plugin, category, ...(requires === undefined ? {} : { requires: [...new Set(requires)] }) }
  })
  return { ...data, plugins }
}

/**
 * Drop what we remember, so the next call is unconditional.
 *
 * Exists for tests: the memo is module state, and a spec that asserted a
 * 304 would otherwise leak a validator into the next one.
 */
export function forgetCatalog(): void {
  served.clear()
}

/**
 * Configure catalogs that are merged after the region's official catalog.
 *
 * Every configured catalog is required. Silently omitting an unreachable
 * private catalog would make an internal plugin look unpublished while the
 * market appears healthy.
 *
 * @param values - Absolute HTTP(S) URLs, or undefined to use only the official catalog.
 */
export function setAdditionalRegistryUrls(values: readonly string[] | undefined): void {
  if (values !== undefined && !Array.isArray(values)) {
    throw new Error('dsh-market: additionalRegistryUrls must be an array of URL strings')
  }
  const next: string[] = []
  const seen = new Set<string>()
  for (const value of values ?? []) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error('dsh-market: additionalRegistryUrls must contain non-empty URL strings')
    }
    let parsed: URL
    try {
      parsed = new URL(value.trim())
    } catch {
      throw new Error(`dsh-market: invalid additional registry URL ${JSON.stringify(value)}`)
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`dsh-market: additional registry URL must use HTTP(S): ${JSON.stringify(value)}`)
    }
    const normalized = parsed.toString()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    next.push(normalized)
  }
  additionalRegistryUrls = next
  forgetCatalog()
}

/** Canonical repository identity for merging one entry from several catalogs. */
function pluginIdentity(plugin: RegistryPlugin): string {
  return plugin.url.trim().replace(/\/+$/u, '').toLowerCase()
}

/**
 * Compose independently curated catalogs into one install allowlist.
 * Later catalogs may update metadata for the same repository, but cannot
 * redirect an existing display name to another repository.
 */
function mergeRegistries(registries: readonly Registry[]): Registry {
  if (registries.length === 1) return registries[0]!
  const categories: Registry['categories'] = {}
  const plugins: RegistryPlugin[] = []
  const indexByIdentity = new Map<string, number>()
  const identityByName = new Map<string, string | null>()
  let updated = ''

  for (const registry of registries) {
    Object.assign(categories, registry.categories)
    if (registry.updated > updated) updated = registry.updated
    // Existing catalogs contain a few historical same-name entries. Preserve
    // those within their source; only a LATER catalog redirecting a name is a
    // cross-catalog conflict.
    const priorIdentityByName = new Map(identityByName)
    for (const plugin of registry.plugins) {
      const identity = pluginIdentity(plugin)
      const namedIdentity = priorIdentityByName.get(plugin.name)
      if (priorIdentityByName.has(plugin.name) && namedIdentity !== identity) {
        throw new Error(`catalog conflict: plugin name ${JSON.stringify(plugin.name)} points at more than one repository`)
      }
      const currentIdentity = identityByName.get(plugin.name)
      identityByName.set(
        plugin.name,
        !identityByName.has(plugin.name) || currentIdentity === identity ? identity : null,
      )
      const existing = indexByIdentity.get(identity)
      if (existing === undefined) {
        indexByIdentity.set(identity, plugins.length)
        plugins.push(plugin)
      } else {
        plugins[existing] = plugin
      }
    }
  }
  return { updated, count: plugins.length, categories, plugins }
}

/** Load the first healthy source in one fallback group. */
async function loadRegistryGroup(sources: readonly CatalogSource[], label: string): Promise<Registry> {
  const started = Date.now()
  let last: unknown
  let attempts = 0
  for (const source of sources) {
    const key = sourceKey(source)
    for (let attempt = 0; attempt < 2; attempt++) {
      attempts += 1
      try {
        const reusable = served.get(key) ?? null
        if (source.kind === 'npm') {
          const { version, data } = await catalogFromPackage(
            source.registry, source.pkg, reusable?.version ?? undefined,
          )
          if (data === null && reusable !== null) return reusable.data
          if (data === null) throw new Error('the catalog package reported no change with nothing to reuse')
          const parsed = asRegistry(data)
          served.set(key, { key, etag: null, modified: null, version, data: parsed })
          return parsed
        }
        const headers: Record<string, string> = {}
        if (reusable?.etag != null) headers['if-none-match'] = reusable.etag
        else if (reusable?.modified != null) headers['if-modified-since'] = reusable.modified

        const res = await marketFetch(source.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers })
        if (res.status === 304) {
          if (reusable === null) throw new Error('the catalog answered "not modified" with nothing to revalidate')
          return reusable.data
        }
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
        const data = asRegistry(await res.json())
        served.set(key, {
          key, etag: res.headers.get('etag'), modified: res.headers.get('last-modified'), version: null, data,
        })
        return data
      } catch (error) {
        last = error
      }
    }
  }
  throw new Error(`${label}: ${describeFetchFailure(last, Date.now() - started, attempts)}`)
}

/**
 * The catalog, revalidated every time it is asked for.
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
 * retry, which is a state the user can act on. In particular a network
 * failure is NEVER answered from `served`: an origin that cannot be reached
 * has not confirmed anything, and quietly handing back the last catalog
 * would rebuild exactly the fallback this replaced.
 * @throws when the catalog cannot be fetched or does not look like one.
 */
export async function loadRegistry(region: Region = activeRegion()): Promise<Registry> {
  const groups: Array<{ label: string; sources: CatalogSource[] }> = [
    { label: 'official catalog', sources: routesFor(region).catalog },
    ...additionalRegistryUrls.map(url => ({
      label: `additional catalog ${url}`,
      sources: [{ kind: 'url' as const, url }],
    })),
  ]
  const registries = await Promise.all(groups.map(group => loadRegistryGroup(group.sources, group.label)))
  const registry = mergeRegistries(registries)
  for (const plugin of registry.plugins) resolveInstallOrder(registry.plugins, plugin)
  return registry
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
export function describeFetchFailure(error: unknown, elapsedMs: number, attempts = 2): string {
  const reason = error instanceof Error ? error.message : String(error)
  const proxy = configuredProxy()
  const parts = [`${reason} (${String(Math.round(elapsedMs / 1000))}s, ${String(attempts)} attempts)`]
  if (proxy !== null) {
    parts.push(`tried through the configured proxy ${proxy.replace(/\/\/[^@]*@/u, '//***@')}`)
  }
  return parts.join(' · ')
}
