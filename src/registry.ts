/**
 * Access to the curated list from awesome-dsh-plugin.com. Each new load
 * revalidates the catalog with its source.
 */

import { BODY_STALL_TIMEOUT_MS, HEADERS_TIMEOUT_MS, readBodyWhileProgressing } from './body-progress.ts'
import { logEvent } from './log.ts'
import { configuredProxy, marketFetch } from './net.ts'
import { catalogFromPackage } from './catalog-npm.ts'
import { activeRegion, catalogSourcesFor, routesFor, type CatalogSource, type Region } from './regions.ts'
import { NPM_NAME_RE } from './sources.ts'
import {
  catalogConfig, forgetExtraCatalogs, loadExtra, mergeSources, PUBLIC_LABEL, type ExtraResult, type SourceInfo,
} from './catalogs.ts'

/**
 * How long a successful catalog load may take before it leaves a line behind.
 *
 * A load that fails already documents itself: the thrown message carries the
 * elapsed time and the attempt count. A load that SUCCEEDS carries nothing,
 * so a market that took forty seconds and one that took two produce the same
 * export — "(none — the buffer starts empty on every start)" — and a report
 * cannot tell them apart (#1181: thirteen seconds, twenty, forty on the same
 * machine, five minutes on the run that failed, all with an empty session).
 * The threshold sits above any healthy load, so the ordinary case stays quiet.
 */
const SLOW_CATALOG_MS = 5_000

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
  starsCheckedAt?: string | null
  /** All public Release assets in this repository, lifetime count; never npm's window. */
  githubReleaseDownloads?: number | null
  githubReleaseDownloadsCheckedAt?: string | null
  /** Public package declarations at this exact pinned install tag. */
  releaseManifest?: {
    tarball: string
    checkedAt: string
    version: string | null
    enginesDsh: string | null
    peerDependencies: Record<string, string>
  }
  /**
   * npm downloads in the last 30 days, when the entry has a published
   * package. `null`/absent means "no npm package" — a coverage gap, not a
   * zero — so sorting must not read it as "less popular than 0".
   */
  downloads?: number | null
  /** Source-reported download window (YYYY-MM-DD), not lifetime totals. */
  downloadsStart?: string | null
  downloadsEnd?: string | null
  /** When the source checked this statistic; never the client's fetch time. */
  downloadsCheckedAt?: string | null
  /**
   * Registry `dist-tags.latest` from awesome-dsh-plugin (#348). A string when
   * known; `null`/absent when github-only or not yet backfilled — the UI
   * omits the byline segment rather than showing a placeholder.
   */
  version?: string | null
  /**
   * Catalog-declared storefront tile (icon). Same trust boundary as screenshots:
   * the catalog is untrusted input, so the client re-validates the URL before
   * creating an <img>. Absent = fall back to the owner's GitHub avatar.
   */
  icon?: string | null

  install: string
  added: string
  /**
   * Which catalog this entry came from. Present ONLY on entries from a
   * catalog the organization or the user added; the public catalog's entries
   * carry none, so a plain install looks exactly as it always did. Stamped by
   * the market after merging, never taken from a catalog's own text.
   */
  source?: { id: string; label: Record<string, string> }
  /**
   * Catalog-side deprecation flags (#60): supplied by awesome-dsh-plugin,
   * absent for every normal entry — the market only consumes them, so a
   * catalog without the fields behaves exactly as before.
   */
  deprecated?: boolean
  /** Catalog name of the suggested replacement plugin, when deprecated. */
  replacement?: string
  /**
   * npm package names this entry used BEFORE its current one (#1012).
   *
   * The catalog is the only place a rename can be stated ahead of time: the
   * old name's npm metadata is gone (no dist-tags, no `deprecated` message),
   * so nothing the market can fetch still knows the two names are one plugin.
   * Same trust boundary as `deprecated`/`replacement` — absent for every
   * normal entry, and a catalog without the field behaves exactly as before.
   *
   * Values are validated where they are consumed (normalized by
   * {@link pluginPreviousNpm}, cross-entry rules in scripts/validate-registry.mjs):
   * a former name must never be a live package in the catalog, and one former
   * name may only have one successor.
   */
  previousNpm?: string[]
  /**
   * Capability disclosure (#401): what a static scan of the artifact a user
   * would install reported touching — `shell`, `network`, `credentials`,
   * `fs-read`, `fs-write`, `env`, `llm`, `dynamic-code`, ...
   *
   * Disclosure, not a verdict, and the type says so by being ABSENT when the
   * entry was never scanned: `capabilities: []` means "scanned, nothing
   * detected" and `undefined` means "we could not look". The two render
   * differently (未检出 vs 未扫描) because they are different sentences, and
   * only one of them is a statement about the plugin.
   */
  capabilities?: string[]
  /** Combinations a reader should look at, in the scanner's own words. */
  capabilityRedLines?: string[]
  /** When the scan behind those fields ran (ISO 8601). */
  capabilityCheckedAt?: string | null
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
  /** Per-source status; present only when more than the public catalog is configured. */
  sources?: SourceInfo[]
}

/**
 * Former npm names for one catalog entry, normalized (#1012).
 *
 * Catalog JSON is external input, so a malformed declaration is dropped
 * rather than trusted: only syntactically valid npm names survive, an entry
 * may not list itself (its own `npm` or `name`), and duplicates collapse in
 * declaration order. Cross-entry rules — a former name that is still live
 * elsewhere, or two entries claiming one former name — cannot be judged per
 * entry; the validator enforces them for the catalog, and
 * `findCatalogRename` fails closed on ambiguity at runtime.
 */
export function pluginPreviousNpm(
  plugin: Pick<RegistryPlugin, 'name' | 'npm' | 'previousNpm'>,
): string[] {
  const declared: unknown = plugin.previousNpm
  const values: unknown[] = Array.isArray(declared) ? declared : declared === undefined || declared === null ? [] : [declared]
  const own = new Set<string>([plugin.name.toLowerCase()])
  if (typeof plugin.npm === 'string' && plugin.npm !== '') own.add(plugin.npm.toLowerCase())
  const names: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || value === '' || !NPM_NAME_RE.test(value)) continue
    const key = value.toLowerCase()
    if (own.has(key) || seen.has(key)) continue
    seen.add(key)
    names.push(value)
  }
  return names
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
 * The catalog we were last served, with the validator identifying it.
 *
 * This is NOT the cache that was removed, and the difference is the whole
 * point. That cache SKIPPED the request for an hour and answered from
 * memory — it asserted freshness without ever asking. This asks the origin
 * on each new load; concurrent readers share that validation. The validator
 * lets the origin answer "still the same" (304) instead of resending a megabyte.
 * `data` below is only returned after the origin confirms it is current.
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
let served: {
  /** Which source issued this, so a validator is never sent to another one. */
  key: string
  etag: string | null
  modified: string | null
  /** The published version, for the npm route — its equivalent of an ETag. */
  version: string | null
  data: Registry
} | null = null

let pendingCatalog: { key: string; result: Promise<Registry> } | null = null
// Each new load or explicit reset supersedes the previous cache writer.
let catalogRevision = 0

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
    const previousNpm = pluginPreviousNpm(plugin)
    // An entry with nothing usable to declare looks exactly like one that
    // declared nothing, so the field stays absent rather than becoming [].
    if (previousNpm.length === 0) {
      const { previousNpm: _declared, ...rest } = plugin
      return { ...rest, category }
    }
    return { ...plugin, category, previousNpm }
  })
  return { ...data, plugins }
}

/**
 * Drop the validator and detach any earlier load, so the next call starts an
 * unconditional request. Earlier callers can still receive their own result.
 */
export function forgetCatalog(): void {
  served = null
  pendingCatalog = null
  pendingMerged = null
  lastMerged = null
  forgetExtraCatalogs()
  catalogRevision += 1
}

/**
 * The catalog, revalidated on each new load. Discovery and the update check
 * share a revalidation while it is in flight for the same configured sources.
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
function loadPublicCatalog(region: Region): Promise<Registry> {
  const ownSources = routesFor(region).catalog.length
  const catalogSources = catalogSourcesFor(region)
  const key = JSON.stringify([region, ownSources, catalogSources.map(sourceKey)])
  if (pendingCatalog?.key === key) return pendingCatalog.result

  const revision = ++catalogRevision
  const result = fetchCatalog(region, ownSources, catalogSources, revision).finally(() => {
    if (revision === catalogRevision) pendingCatalog = null
  })
  pendingCatalog = { key, result }
  return result
}

/** Every source failed (or the only one did): the message for the page, and what each source said. */
export class CatalogLoadError extends Error {
  readonly sources: SourceInfo[]
  constructor(message: string, sources: SourceInfo[]) {
    super(message)
    this.name = 'CatalogLoadError'
    this.sources = sources
  }
}

let pendingMerged: { key: string; result: Promise<Registry> } | null = null
/** The last merge, reused while none of its inputs changed (callers key caches on the object). */
let lastMerged: { inputs: unknown[]; allow: string; out: Registry } | null = null

/**
 * The catalog, revalidated on each new load: the public catalog plus whatever
 * the organization's policy and the user added.
 *
 * With nothing configured this IS {@link loadPublicCatalog} — the same
 * requests, the same object — which is the promise that a user with no policy
 * and no extra catalogs sees no change. Otherwise every source is read on its
 * own, in parallel: one that fails costs the user that source and is reported
 * in `sources`, never the others.
 * @throws when nothing could be loaded; {@link CatalogLoadError} carries the per-source detail.
 */
export function loadRegistry(region: Region = activeRegion()): Promise<Registry> {
  const config = catalogConfig()
  if (!config.active) return loadPublicCatalog(region)
  const key = JSON.stringify([region, config.signature])
  if (pendingMerged?.key === key) return pendingMerged.result
  const result = loadMerged(region, config).finally(() => {
    if (pendingMerged?.result === result) pendingMerged = null
  })
  pendingMerged = { key, result }
  return result
}

async function loadMerged(region: Region, config: ReturnType<typeof catalogConfig>): Promise<Registry> {
  const publicLoad: Promise<{ registry: Registry } | { error: unknown }> | null = config.publicEnabled
    ? loadPublicCatalog(region).then(registry => ({ registry }), (error: unknown) => ({ error }))
    : null
  const extras: ExtraResult[] = await Promise.all(config.extras.map(source => loadExtra(source)))
  const publicResult = publicLoad === null ? null : await publicLoad
  const publicRegistry = publicResult !== null && 'registry' in publicResult ? publicResult.registry : null
  const publicInfo: SourceInfo = {
    id: 'public',
    kind: 'public',
    label: PUBLIC_LABEL,
    where: '',
    status: publicResult === null ? 'off' : publicRegistry !== null ? 'ok' : 'failed',
    count: publicRegistry?.plugins.length ?? 0,
    skipped: 0,
    locked: config.policy.publicCatalog === false,
    ...(publicResult !== null && 'error' in publicResult
      ? { error: { code: 'network' as const, detail: (publicResult.error instanceof Error ? publicResult.error.message : String(publicResult.error)).slice(0, 400) } }
      : {}),
  }
  const loaded = extras.filter(extra => extra.registry !== null)
  if (publicRegistry === null && loaded.length === 0) {
    const sources = [...(publicResult === null ? [] : [publicInfo]), ...extras.map(extra => extra.info)]
    // The public catalog's own explanation reads best when it is the only
    // source there is; otherwise name the first thing that broke.
    const message = publicResult !== null && 'error' in publicResult && config.extras.length === 0
      ? (publicResult.error instanceof Error ? publicResult.error.message : String(publicResult.error))
      : sources.map(source => `${source.id}: ${source.error?.code ?? 'off'}${source.error?.detail ? ` ${source.error.detail}` : ''}`).join(' · ')
    throw new CatalogLoadError(message === '' ? 'no catalog is available' : message, sources)
  }
  const inputs: unknown[] = [publicRegistry, ...extras.map(extra => extra.registry)]
  const stamp = JSON.stringify([config.policy.allow, publicInfo, extras.map(extra => extra.info)])
  if (lastMerged !== null && lastMerged.allow === stamp
    && lastMerged.inputs.length === inputs.length && lastMerged.inputs.every((value, index) => value === inputs[index])) {
    return lastMerged.out
  }
  const out = mergeSources({
    publicRegistry,
    publicInfo: publicResult === null ? null : publicInfo,
    extras,
    allow: config.policy.allow,
  })
  lastMerged = { inputs, allow: stamp, out }
  return out
}

async function fetchCatalog(region: Region, ownSources: number, catalogSources: CatalogSource[], revision: number): Promise<Registry> {
  const started = Date.now()
  const previous = served
  let last: unknown
  let attempts = 0
  /**
   * Every source that failed, in order (#750).
   *
   * Only the LAST failure used to be reported, so a primary source that was
   * DNS-blocked, refused, or answering 404 disappeared from the message as
   * soon as the fallback failed too: the user was told about the mirror they
   * never chose (and can do nothing about) and not about the one that broke
   * first. Which source said what IS the diagnosis here — the two fail for
   * different reasons, and usually only one of them is worth acting on.
   */
  const failures: { source: string; reason: string }[] = []
  // Sources in order, each a fallback for the one before it. The catalog is
  // the FIRST request the market makes, so a mirror that has gone down must
  // mean a slow market rather than an empty one — the list ends at the
  // address that has always worked.
  //
  // The list runs one entry past the region's own sources on purpose (#891):
  // the region probe measures the npm registry, so it cannot see a network
  // where npm is fast and the catalog's host is blocked — and the region is
  // decided once and persisted. The catalog's published package, on the
  // registry the probe just proved reachable, is the repair that needs
  // neither the probe nor the decision to change.
  for (const [sourceIndex, source] of catalogSources.entries()) {
    const key = sourceKey(source)
    const servedBy = <T>(data: T): T => {
      if (sourceIndex >= ownSources) {
        logEvent('warn', 'registry', `catalog: the ${region} sources did not answer; read the catalog package from ${key} instead (#891)`)
      }
      // Success is silent by default, which is what makes a slow one
      // undiagnosable: the export says the same thing whether the market
      // appeared in two seconds or in forty (#1181). One line above the
      // threshold, none below it.
      const elapsed = Date.now() - started
      if (elapsed >= SLOW_CATALOG_MS) {
        logEvent('info', 'registry', `catalog: ${key} answered in ${(elapsed / 1000).toFixed(1)}s after ${String(attempts)} request attempt(s)`)
      }
      return data
    }
    // Two attempts each. A catalog fetch crossing a long, lossy path fails
    // transiently often enough that one retry is worth more than the second
    // or two it costs — and with nothing behind this call any more, a
    // transient failure is a market with no plugins in it.
    for (let attempt = 0; attempt < 2; attempt++) {
      attempts += 1
      try {
        // A validator only ever goes back to the source that issued it.
        // Carried across a region switch it could earn a "not modified" from
        // an origin whose body we have never seen.
        const reusable = previous?.key === key ? previous : null
        if (source.kind === 'npm') {
          const { version, data } = await catalogFromPackage(
            source.registry, source.pkg, reusable?.version ?? undefined,
          )
          // `data === null` means the published version is the one in hand.
          if (data === null && reusable !== null) return servedBy(reusable.data)
          if (data === null) throw new Error('the catalog package reported no change with nothing to reuse')
          const parsed = asRegistry(data)
          if (revision === catalogRevision) served = { key, etag: null, modified: null, version, data: parsed }
          return servedBy(parsed)
        }
        // ETag first: it is exact, while a date has one-second resolution and
        // a catalog republished twice within the same second would validate
        // as unchanged. Only one is sent — an origin given both must satisfy
        // both, which turns a weak ETag match into an unnecessary 200.
        const headers: Record<string, string> = {}
        if (reusable?.etag != null) headers['if-none-match'] = reusable.etag
        else if (reusable?.modified != null) headers['if-modified-since'] = reusable.modified

        // Headers and body run on different clocks. The fixed budget covers
        // only the wait for the response to START; the body itself is read
        // under a stall watchdog, because the catalog takes longer than any
        // honest fixed budget on a slow link, and "bytes still moving" is the
        // one signal that separates slow from stuck.
        const controller = new AbortController()
        const headersDeadline = setTimeout(
          () => {
            controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
          },
          HEADERS_TIMEOUT_MS,
        )
        let res: Response
        try {
          res = await marketFetch(source.url, { signal: controller.signal, headers })
        } finally {
          clearTimeout(headersDeadline)
        }
        if (res.status === 304) {
          // Only reachable when we sent a validator, so `reusable` is present.
          // Guarded anyway: answering a 304 with nothing to reuse would
          // otherwise surface as a confusing parse error on an empty body.
          if (reusable === null) throw new Error('the catalog answered "not modified" with nothing to revalidate')
          return servedBy(reusable.data)
        }
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
        const data = asRegistry(JSON.parse(new TextDecoder().decode(
          await readBodyWhileProgressing(res, BODY_STALL_TIMEOUT_MS),
        )))
        if (revision === catalogRevision) {
          served = {
            key, etag: res.headers.get('etag'), modified: res.headers.get('last-modified'), version: null, data,
          }
        }
        return servedBy(data)
      } catch (error) {
        last = error
        failures.push({
          source: sourceKey(source),
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    // Every source here is a fallback for the one before it, so this failure
    // may never reach the screen: the market reads the catalog from the next
    // source and looks fine, while a mirror this person configured and cannot
    // see failing stays broken (#1117). One line per source per load — the
    // full list is still in the thrown message when everything fails.
    const ownFailure = failures.findLast(failure => failure.source === key)
    if (ownFailure !== undefined && sourceIndex + 1 < catalogSources.length) {
      logEvent('warn', 'registry', `catalog: ${key} failed, reading from a later source — ${ownFailure.reason.slice(0, 200)}`)
    }
  }
  throw new Error(describeFetchFailure(last, Date.now() - started, attempts, failures))
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
export function describeFetchFailure(
  error: unknown,
  elapsedMs: number,
  attempts = 2,
  failures: readonly { source: string; reason: string }[] = [],
): string {
  const reason = error instanceof Error ? error.message : String(error)
  const proxy = configuredProxy()
  const parts = [`${reason} (${String(Math.round(elapsedMs / 1000))}s, ${String(attempts)} attempts)`]
  if (proxy !== null) {
    parts.push(`tried through the configured proxy ${proxy.replace(/\/\/[^@]*@/u, '//***@')}`)
  }
  // The sources that failed BEFORE the last one, so the primary's own reason
  // survives into the message instead of being replaced by the fallback's
  // (#750). One entry per source, reasons clipped: this lands in a banner, and
  // the first reason is usually the only actionable one.
  const earlier = failures.slice(0, -1)
  if (earlier.length > 0) {
    parts.push(`earlier: ${earlier.map(entry => `${entry.source} — ${entry.reason.slice(0, 160)}`).join(' · ')}`)
  }
  return parts.join(' · ')
}

