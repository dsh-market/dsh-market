import { api, hostCompatibilityKey, type HostCompatibility, type HostCompatibilityMap, type Registry, type RegistryPlugin } from './market-data.ts'
import { isExactReleaseVersion } from '../release-candidates.ts'
import { BODY_STALL_TIMEOUT_MS, HEADERS_TIMEOUT_MS, readBodyWhileProgressing } from '../body-progress.ts'

const BATCH_SIZE = 64
// The route accepts up to 32 KiB. Versions and revisions repeat their keys.
const BATCH_BYTES = 32 * 1024 - 128
const UNAVAILABLE_RETRY_MS = 5 * 60_000
const REQUEST_RETRY_MS = 30_000
const MUTABLE_SOURCE_TTL_MS = 24 * 60 * 60_000
const REVISION = /^[a-f0-9]{64}$/
const HOST_FILTER_KEY = 'dshm-host-filter'
const unavailable: HostCompatibility = { status: 'unknown', basis: 'unavailable', requirement: null, declarations: [] }

type Entry = {
  key: string
  fingerprint: string
  npmVersion?: string
  githubRevision?: string
  expires: boolean
  bytes: number
}

interface Result {
  entry: Entry
  verdict: HostCompatibility
  expiresAt: number
  retryAt: number
  automaticRetryUsed: boolean
}

interface Snapshot {
  enabled: boolean
  catalog: Registry | null
  catalogPreview: Registry | null
  gone: boolean
  hostVersion: string | null | undefined
  verdicts: HostCompatibilityMap
}

interface Batch {
  entries: Entry[]
  context: number
  retry: boolean
}

interface Demand {
  catalog: Registry
  keys: readonly string[]
}

type CatalogLoad = 'loaded' | 'superseded' | 'gone'

interface CatalogPage {
  registry: Registry
  hostVersion?: Snapshot['hostVersion']
  snapshot?: string
  page?: number
  pages?: number
}

async function readCatalogPage(page: number, snapshot?: string): Promise<CatalogPage | 'gone' | 'expired'> {
  const query = snapshot === undefined ? '' : '?' + new URLSearchParams({ page: String(page), snapshot })
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController()
    // The first request may wait on the catalog origin. Later pages read only
    // from a local snapshot, so cap the wait for their headers separately.
    const timer = page === 0 ? undefined : setTimeout(() => controller.abort(), HEADERS_TIMEOUT_MS)
    let status: number | undefined
    try {
      const response = await fetch(api('/dsh-market/registry') + query, {
        cache: 'no-store', headers: { 'x-dsh-catalog-paging': '1' }, signal: controller.signal,
      }).finally(() => clearTimeout(timer))
      status = response.status
      if (status === 404 || status === 409) {
        await response.body?.cancel().catch(() => {})
        return status === 404 ? 'gone' : 'expired'
      }
      const bytes = await readBodyWhileProgressing(response, BODY_STALL_TIMEOUT_MS, 'the catalog page')
      const body = JSON.parse(new TextDecoder().decode(bytes)) as Partial<CatalogPage> & { error?: string }
      if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${status}`)
      if (!Array.isArray(body?.registry?.plugins)) throw new Error('the catalog response carried no data')
      if (page !== 0 || body.snapshot !== undefined || body.pages !== undefined) {
        if (typeof body.snapshot !== 'string' || body.page !== page || typeof body.pages !== 'number'
          || !Number.isInteger(body.pages) || body.pages <= page || (snapshot !== undefined && body.snapshot !== snapshot)) {
          throw new Error('the catalog page did not match the current download')
        }
      }
      return body as CatalogPage
    } catch (error) {
      // The first request already has source-side retries. Retry transport
      // errors here, but let an origin's explicit failure reach the user.
      if (attempt >= 2 || (status !== undefined && status >= 400 && (
        page === 0 || (status < 500 && status !== 429)
      ))) throw error
      await new Promise<void>(resolve => setTimeout(resolve, 350 * (attempt + 1)))
    }
  }
}

function initialPreference(): boolean {
  try { return localStorage.getItem(HOST_FILTER_KEY) !== 'all' } catch { return true }
}

function describeEntry(plugin: RegistryPlugin): Entry | null {
  const key = hostCompatibilityKey(plugin)
  if (key === null) return null
  const version = typeof plugin.version === 'string' ? plugin.version.trim() : ''
  if (!key.startsWith('https://')) {
    const npmVersion = isExactReleaseVersion(version) ? version : undefined
    return {
      key, fingerprint: npmVersion ?? '', npmVersion, expires: npmVersion === undefined,
      bytes: entryBytes(key, npmVersion),
    }
  }
  const revision = plugin.compatibilityRevision
  const githubRevision = typeof revision === 'string' && REVISION.test(revision) ? revision : undefined
  return {
    key, fingerprint: githubRevision ?? JSON.stringify([plugin.tarball ?? null, version]),
    githubRevision, expires: true, bytes: entryBytes(key, githubRevision),
  }
}

const encoder = new TextEncoder()

function entryBytes(key: string, hint: string | undefined): number {
  const keyBytes = encoder.encode(JSON.stringify(key)).byteLength
  // The array item and, if applicable, the additional object property.
  return keyBytes + 1 + (hint === undefined ? 0 : keyBytes + encoder.encode(JSON.stringify(hint)).byteLength + 2)
}

function requestBody(entries: readonly Entry[]) {
  const packages = entries.filter(entry => !entry.key.startsWith('https://')).map(entry => entry.key)
  const github = entries.filter(entry => entry.key.startsWith('https://')).map(entry => entry.key)
  const versions = entries.filter(entry => entry.npmVersion !== undefined).map(entry => [entry.key, entry.npmVersion])
  const revisions = entries.filter(entry => entry.githubRevision !== undefined).map(entry => [entry.key, entry.githubRevision])
  return {
    packages,
    ...(github.length > 0 ? { entries: github } : {}),
    ...(versions.length > 0 ? { versions: Object.fromEntries(versions) } : {}),
    ...(revisions.length > 0 ? { githubRevisions: Object.fromEntries(revisions) } : {}),
  }
}

function readVerdict(value: HostCompatibility | undefined | null): HostCompatibility {
  if (value == null
    || !['compatible', 'incompatible', 'unknown'].includes(value.status)
    || !['manifest', 'undeclared', 'unavailable'].includes(value.basis)
    || (value.requirement !== null && typeof value.requirement !== 'string')
    || !Array.isArray(value.declarations)) return unavailable
  return value.basis === 'unavailable' ? {
    ...unavailable,
    ...(value.catalogChanged === true ? { catalogChanged: true } : {}),
    ...(typeof value.retryAfterMs === 'number' && Number.isFinite(value.retryAfterMs) && value.retryAfterMs >= 0
      ? { retryAfterMs: value.retryAfterMs } : {}),
  } : value
}

/** Shares on-demand badge lookups across the three market surfaces. */
export class DiscoveryScan {
  private snapshot: Snapshot | undefined
  private readonly listeners = new Set<() => void>()
  private entries = new Map<string, Entry>()
  private results = new Map<string, Result>()
  private readonly demand = new Map<object, Demand>()
  private pending: Batch | undefined
  private hostVersion: Snapshot['hostVersion']
  private catalog: Registry | null = null
  private catalogPreview: Registry | null = null
  private catalogDownload: { first: CatalogPage; items: Array<RegistryPlugin[] | undefined> } | undefined
  private boot: string | undefined
  private enabled: boolean | undefined
  private context = 0
  private catalogRequest = 0
  private resumeRequest: { id: number; result: Promise<CatalogLoad> } | undefined
  private catalogRefreshUsed = false
  private active = false
  private gone = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private verdictsChanged = false

  constructor(private readonly onCatalogGenerationChange: () => void) {}

  getSnapshot = (): Snapshot => {
    return this.snapshot ??= {
      enabled: this.enabled ??= initialPreference(),
      catalog: null, catalogPreview: null, gone: false, hostVersion: undefined, verdicts: Object.create(null),
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  reset() {
    clearTimeout(this.timer)
    this.timer = undefined
    this.active = false
    this.gone = false
    this.context += 1
    this.hostVersion = undefined
    this.catalog = null
    this.catalogPreview = null
    this.catalogDownload = undefined
    this.catalogRequest += 1
    this.resumeRequest = undefined
    this.boot = undefined
    this.enabled = undefined
    this.entries.clear()
    this.results.clear()
    this.demand.clear()
    this.catalogRefreshUsed = false
    this.pending = undefined
    this.verdictsChanged = false
    this.snapshot = undefined
  }

  setEnabled(enabled: boolean) {
    if (this.getSnapshot().enabled === enabled) return
    try { localStorage.setItem(HOST_FILTER_KEY, enabled ? 'compatible' : 'all') } catch { /* storage is optional */ }
    this.enabled = enabled
    this.catalogRefreshUsed = false
    if (enabled) {
      const keys = this.visibleKeys()
      this.allowRetry(keys)
      if (keys.some(key => this.results.get(key)?.verdict.catalogChanged === true)) this.refreshCatalog()
    }
    this.update()
  }

  private async loadCatalog(): Promise<CatalogLoad> {
    const request = ++this.catalogRequest
    // A retry resumes only missing pages. If the server restarted or discarded
    // the snapshot, start once from a new catalog instead of mixing revisions.
    for (let restart = 0; restart <= 1; restart++) {
      let download = this.catalogDownload
      if (download === undefined) {
        const first = await readCatalogPage(0)
        if (request !== this.catalogRequest) return 'superseded'
        if (first === 'gone') {
          this.setUnavailable()
          return 'gone'
        }
        if (first === 'expired') throw new Error('the catalog changed while loading')
        download = { first, items: [first.registry.plugins] }
        this.catalogDownload = download
      }
      const { first, items } = download
      const pages = first.pages ?? 1
      if (pages > 1 && this.catalog === null) {
        this.catalogPreview = first.registry
        this.update()
      }
      const missing = Array.from({ length: pages }, (_, page) => page).filter(page => items[page] === undefined)
      let expired = false
      for (let offset = 0; offset < missing.length; offset += 3) {
        const batch = missing.slice(offset, offset + 3)
        const results = await Promise.allSettled(batch.map(page => readCatalogPage(page, first.snapshot)))
        if (request !== this.catalogRequest) return 'superseded'
        for (const [index, result] of results.entries()) {
          if (result.status === 'rejected') continue
          if (result.value === 'gone') {
            this.setUnavailable()
            return 'gone'
          }
          if (result.value === 'expired') {
            expired = true
            continue
          }
          if (result.value.pages !== pages) throw new Error('the catalog page count changed while loading')
          items[batch[index]!] = result.value.registry.plugins
        }
        if (expired) break
        const failure = results.find(result => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
      }
      if (expired) {
        this.catalogDownload = undefined
        continue
      }
      const host = first.hostVersion
      this.catalogDownload = undefined
      this.catalogPreview = null
      this.setCatalog({ ...first.registry, plugins: items.flatMap(items => items ?? []) },
        typeof host === 'string' || host === null ? host : undefined)
      return 'loaded'
    }
    throw new Error('the catalog changed while loading')
  }

  private setCatalog(catalog: Registry, hostVersion: Snapshot['hostVersion']) {
    if (catalog.updated !== this.catalog?.updated) this.onCatalogGenerationChange()
    this.catalog = catalog
    this.active = true
    this.gone = false
    const next = new Map<string, Entry>()
    for (const plugin of catalog.plugins) {
      const described = describeEntry(plugin)
      if (described === null || next.has(described.key)) continue
      const previous = this.entries.get(described.key)
      next.set(described.key, previous?.fingerprint === described.fingerprint ? previous : described)
    }
    this.entries = next
    const hostChanged = hostVersion !== undefined && hostVersion !== this.hostVersion
    if (hostChanged) {
      this.hostVersion = hostVersion
      this.invalidate()
    }
    for (const [key, result] of this.results) {
      if (next.get(key) === result.entry) continue
      this.results.delete(key)
      this.verdictsChanged = true
    }
    this.markOversizedEntries()
    this.update()
  }

  setBoot(boot: string) {
    const previous = this.boot
    this.boot = boot
    if (previous === undefined || previous === boot) return
    this.invalidate()
    this.markOversizedEntries()
    this.catalogRefreshUsed = false
    this.update()
  }

  setUnavailable() {
    if (this.gone) return
    this.active = false
    this.gone = true
    this.catalogDownload = undefined
    this.catalogPreview = null
    this.catalogRefreshUsed = false
    this.catalogRequest += 1
    this.invalidate()
    this.update()
  }

  resume() {
    // Simultaneous mounts share a read. Automatic revalidation can still
    // supersede that read when the route reports a newer catalog revision.
    if (this.resumeRequest?.id === this.catalogRequest) return this.resumeRequest.result
    const result = this.loadCatalog().finally(() => {
      if (this.resumeRequest?.result === result) this.resumeRequest = undefined
    })
    this.resumeRequest = { id: this.catalogRequest, result }
    return result
  }

  setDemand(owner: object, catalog: Registry | null, keys: readonly string[]) {
    if (catalog !== this.catalog) return
    const before = this.demand.get(owner)?.keys ?? []
    if (catalog === null || keys.length === 0) this.demand.delete(owner)
    else this.demand.set(owner, { catalog, keys })
    // Revisited rows may retry after their cooldown. A rerender with the same
    // rows never spends another automatic attempt.
    const arrived = keys.filter(key => !before.includes(key))
    this.allowRetry(arrived)
    if (arrived.some(key => this.results.get(key)?.verdict.catalogChanged === true)) {
      this.refreshCatalog()
    }
    this.update()
  }

  removeDemand(owner: object) {
    this.demand.delete(owner)
    this.scheduleRetry()
  }

  private allowRetry(keys: Iterable<string>) {
    for (const key of keys) {
      const result = this.results.get(key)
      if (result !== undefined && Number.isFinite(result.retryAt)) result.automaticRetryUsed = false
    }
  }

  private invalidate() {
    this.context += 1
    this.pending = undefined
    this.results.clear()
    this.verdictsChanged = true
  }

  private markOversizedEntries() {
    for (const entry of this.entries.values()) {
      if (entry.bytes <= BATCH_BYTES) continue
      this.results.set(entry.key, {
        entry, verdict: unavailable, retryAt: Infinity, expiresAt: Infinity, automaticRetryUsed: true,
      })
      this.verdictsChanged = true
    }
  }

  private visibleKeys(): string[] {
    // A new catalog may reorder or remove rows. Wait for each view to report
    // its slice of that catalog before using it to start another batch.
    const keys = new Set<string>()
    for (const demand of this.demand.values()) {
      if (demand.catalog !== this.catalog) continue
      for (const key of demand.keys) keys.add(key)
    }
    return [...keys]
  }

  private update() {
    const previous = this.getSnapshot()
    const enabled = this.enabled ?? previous.enabled
    const now = Date.now()
    for (const [key, result] of this.results) {
      if (result.expiresAt > now) continue
      this.results.delete(key)
      this.verdictsChanged = true
    }
    this.pump()
    let verdicts = previous.verdicts
    if (this.verdictsChanged) {
      verdicts = Object.create(null)
      for (const [key, result] of this.results) verdicts[key] = result.verdict
      this.verdictsChanged = false
    }
    if (previous.enabled === enabled && previous.catalog === this.catalog && previous.catalogPreview === this.catalogPreview && previous.gone === this.gone
      && previous.hostVersion === this.hostVersion && previous.verdicts === verdicts) return
    this.snapshot = {
      enabled, catalog: this.catalog, catalogPreview: this.catalogPreview, gone: this.gone, hostVersion: this.hostVersion, verdicts,
    }
    for (const listener of this.listeners) listener()
  }

  private pump() {
    if (!this.active || this.pending !== undefined) {
      this.scheduleRetry()
      return
    }
    const now = Date.now()
    const entries = this.visibleKeys().flatMap(key => {
      const entry = this.entries.get(key)
      return entry === undefined ? [] : [entry]
    })
    const fresh = this.visibleBatch(entries.filter(entry => {
      const result = this.results.get(entry.key)
      return result === undefined || result.expiresAt <= now
    }))
    if (fresh.length > 0) this.dispatch(fresh, false)
    else if (this.enabled ?? this.getSnapshot().enabled) {
      const retry = this.visibleBatch(entries.filter(entry => {
        const result = this.results.get(entry.key)
        return result !== undefined && result.retryAt <= now && !result.automaticRetryUsed
      }))
      if (retry.length > 0) this.dispatch(retry, true)
    }
    this.scheduleRetry()
  }

  private visibleBatch(entries: Entry[]): Entry[] {
    let bytes = 0
    let end = 0
    for (const entry of entries) {
      bytes += entry.bytes
      if (bytes > BATCH_BYTES || end >= BATCH_SIZE) break
      end += 1
    }
    return entries.slice(0, end)
  }

  private scheduleRetry() {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.active || !(this.enabled ?? this.getSnapshot().enabled) || this.pending !== undefined) return
    let next = Infinity
    for (const key of this.visibleKeys()) {
      const result = this.results.get(key)
      if (result === undefined || result.automaticRetryUsed) continue
      next = Math.min(next, result.retryAt)
    }
    if (Number.isFinite(next)) this.timer = setTimeout(() => this.pump(), Math.max(0, next - Date.now()))
  }

  private dispatch(entries: Entry[], retry: boolean) {
    const batch = { entries, retry, context: this.context }
    this.pending = batch
    void this.request(batch)
  }

  private async request(batch: Batch) {
    let responseBody: { hostVersion?: Snapshot['hostVersion']; plugins?: Record<string, HostCompatibility> } | undefined
    let requestFailed = false
    try {
      const response = await fetch(api('/dsh-market/discovery-compatibility'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody(batch.entries)),
      })
      if (response.status === 404 && batch.context === this.context) this.setUnavailable()
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      responseBody = await response.json()
      if (responseBody?.plugins === null || typeof responseBody?.plugins !== 'object'
        || Array.isArray(responseBody.plugins)) throw new Error('Invalid compatibility response')
    } catch {
      requestFailed = true
    }
    if (this.pending === batch) this.pending = undefined
    if (batch.context !== this.context) {
      this.update()
      return
    }
    // The catalog owns host changes. A delayed batch cannot restore a host
    // value that a newer catalog has already replaced.
    const responseHost = responseBody?.hostVersion
    if ((typeof responseHost === 'string' || responseHost === null) && responseHost !== this.hostVersion) {
      if (this.hostVersion === undefined) this.hostVersion = responseHost
      else {
        if (this.visibleKeys().length > 0) this.refreshCatalog()
        requestFailed = true
      }
    }
    const now = Date.now()
    let catalogChanged = false
    for (const entry of batch.entries) {
      if (this.entries.get(entry.key) !== entry) continue
      const verdict = readVerdict(requestFailed ? undefined : responseBody?.plugins?.[entry.key])
      if (verdict.catalogChanged === true) catalogChanged = true
      const retryAt = verdict.basis !== 'unavailable' || verdict.catalogChanged === true ? Infinity
        : now + (verdict.retryAfterMs ?? (requestFailed ? REQUEST_RETRY_MS : UNAVAILABLE_RETRY_MS))
      this.results.set(entry.key, {
        entry, verdict, retryAt, automaticRetryUsed: batch.retry,
        expiresAt: verdict.basis !== 'unavailable' && entry.expires ? now + MUTABLE_SOURCE_TTL_MS : Infinity,
      })
      this.verdictsChanged = true
    }
    if (catalogChanged && this.visibleKeys().some(key => this.results.get(key)?.verdict.catalogChanged === true)) {
      this.refreshCatalog()
    }
    this.update()
  }

  private refreshCatalog() {
    if (!this.active || this.catalogRefreshUsed) return
    this.catalogRefreshUsed = true
    void this.loadCatalog().catch(() => {
      // Preserve the rendered list. A new visit can revalidate again.
    })
  }
}
