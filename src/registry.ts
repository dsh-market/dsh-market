/**
 * Registry access: the curated list from awesome-dsh-plugin.com, fetched
 * fresh on every request. See `loadRegistry` for why there is nothing
 * behind it any more.
 */

import { logEvent } from './log.ts'
import { configuredProxy, marketFetch } from './net.ts'
import { catalogFromPackage } from './catalog-npm.ts'
import { activeRegion, catalogSourcesFor, routesFor, type CatalogSource, type Region } from './regions.ts'

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
   * Catalog-side deprecation flags (#60): supplied by awesome-dsh-plugin,
   * absent for every normal entry — the market only consumes them, so a
   * catalog without the fields behaves exactly as before.
   */
  deprecated?: boolean
  /** Catalog name of the suggested replacement plugin, when deprecated. */
  replacement?: string
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
 * How long to wait for the catalog to START answering.
 *
 * Headers arrive in one burst or not at all, so a fixed budget still fits
 * them. This used to cover the whole fetch, which was fine at 282KB and is
 * wrong now that the catalog runs past a megabyte: on a lossy proxied link
 * the body keeps trickling long after 15s, and a total timer cuts off a
 * download that was still moving and would have finished (measured: killed
 * at 15s on both attempts, 89.9s end-to-end when allowed to run). The body
 * is read under a stall watchdog instead — see readBodyWhileProgressing.
 */
const HEADERS_TIMEOUT_MS = 15_000

/**
 * How long the body may stay SILENT before we give up on it.
 *
 * Deliberately not a total budget. As long as bytes keep arriving, however
 * slowly, the read continues; the watchdog only fires on a download that has
 * actually stopped, which is the one failure a slow link cannot fake.
 */
const BODY_STALL_TIMEOUT_MS = 15_000

/**
 * How long the whole body may take, however much progress it keeps making.
 *
 * The stall watchdog can only act on a pause, so a mirror that sends one
 * byte inside every 15s window would hold the read open forever. 10 minutes
 * is ~7x the slowest measured full download (89.9s); a body still going
 * after that is broken, not slow, and the byte count in the message says
 * which of the two it was.
 */
const BODY_TOTAL_CEILING_MS = 600_000

/**
 * The most body bytes to accept before declaring the response not a catalog.
 *
 * The catalog passed 5 MB in September 2026; 256 MB is ~48x that — years of
 * headroom — and still a hard bound on memory, because the whole body is
 * buffered before parsing and a mirror streaming garbage at line speed
 * would otherwise grow that buffer until the process dies. backup.ts and
 * gist.ts cap their downloads for the same reason.
 */
const MAX_CATALOG_BODY_BYTES = 256 * 1024 * 1024

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
let served: {
  /** Which source issued this, so a validator is never sent to another one. */
  key: string
  etag: string | null
  modified: string | null
  /** The published version, for the npm route — its equivalent of an ETag. */
  version: string | null
  data: Registry
} | null = null

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
    return { ...plugin, category }
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
  served = null
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
  const started = Date.now()
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
  const ownSources = routesFor(region).catalog.length
  const catalogSources = catalogSourcesFor(region)
  for (const [sourceIndex, source] of catalogSources.entries()) {
    const key = sourceKey(source)
    const servedBy = <T>(data: T): T => {
      if (sourceIndex >= ownSources) {
        logEvent('warn', 'registry', `catalog: the ${region} sources did not answer; read the catalog package from ${key} instead (#891)`)
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
        const reusable = served?.key === key ? served : null
        if (source.kind === 'npm') {
          const { version, data } = await catalogFromPackage(
            source.registry, source.pkg, reusable?.version ?? undefined,
          )
          // `data === null` means the published version is the one in hand.
          if (data === null && reusable !== null) return servedBy(reusable.data)
          if (data === null) throw new Error('the catalog package reported no change with nothing to reuse')
          const parsed = asRegistry(data)
          served = { key, etag: null, modified: null, version, data: parsed }
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
        served = {
          key, etag: res.headers.get('etag'), modified: res.headers.get('last-modified'), version: null, data,
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

/**
 * Read a catalog body under a stall watchdog instead of a total budget.
 *
 * One timer for the whole fetch was the mistake both before and after #188:
 * at 4s it hid slowness behind a stale snapshot, at 15s it kills downloads
 * that are still moving. On a lossy proxied link the catalog body trickles
 * for far longer than 15s while never once going silent — measured 89.9s
 * end-to-end for a body the 15s cutoff had declared dead twice. This reader
 * lets a moving body run as long as it keeps moving, in either direction's
 * sense of "slow", and ends one that goes quiet for `stallMs` with a message
 * that says what actually happened and how much had arrived.
 *
 * The rejection comes from here, not from an abort: undici's abort message
 * ("This operation was aborted") cannot tell a user anything actionable, and
 * a bug report containing this string will contain the byte count too.
 *
 * Two backstops keep "still moving" from meaning "forever", because the
 * watchdog can only see pauses: a total ceiling for a body that trickles
 * without ever pausing, and a size cap for one that outruns any catalog.
 */
function readBodyWhileProgressing(res: Response, stallMs: number): Promise<Uint8Array> {
  // The stand-in closes at once, so an absent body reads as "no body"
  // below instead of parking this reader on a stream that never ends.
  const reader = (res.body ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })).getReader()
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let received = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      clearTimeout(ceiling)
      // Tell the origin we are done with the socket; its refusal is not ours to report.
      reader.cancel().catch(() => {})
      if (error !== undefined) reject(error)
      // An empty body otherwise surfaces as a JSON parse error, which tells
      // the user nothing about the network that caused it.
      else if (received === 0) reject(new Error('the catalog response carried no body'))
      else resolve(concatBytes(chunks))
    }
    const ceiling = setTimeout(
      () => {
        finish(new DOMException(
          `the catalog download did not finish within ${String(Math.round(BODY_TOTAL_CEILING_MS / 1000))}s (received ${String(received)} bytes)`,
          'TimeoutError',
        ))
      },
      BODY_TOTAL_CEILING_MS,
    )
    const arm = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(
        () => {
          finish(new DOMException(
            `no new data for ${String(Math.round(stallMs / 1000))}s while downloading the catalog (received ${String(received)} bytes)`,
            'TimeoutError',
          ))
        },
        stallMs,
      )
    }
    const step = (): void => {
      reader.read().then((r) => {
        if (settled) return
        if (r.done || r.value === undefined) {
          finish()
          return
        }
        chunks.push(r.value)
        received += r.value.byteLength
        if (received > MAX_CATALOG_BODY_BYTES) {
          finish(new Error(
            `the catalog response grew past ${String(MAX_CATALOG_BODY_BYTES / 1024 / 1024)} MB without ending (received ${String(received)} bytes)`,
          ))
          return
        }
        arm()
        step()
      }, (error: unknown) => {
        finish(error instanceof Error ? error : new Error(String(error)))
      })
    }
    arm()
    step()
  })
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const all = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let at = 0
  for (const chunk of chunks) {
    all.set(chunk, at)
    at += chunk.byteLength
  }
  return all
}
