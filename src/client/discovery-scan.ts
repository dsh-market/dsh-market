import { api, hostCompatibilityKey, type HostCompatibility, type HostCompatibilityMap, type Registry, type RegistryPlugin } from './market-data.ts'
import { isExactReleaseVersion } from '../release-candidates.ts'
import { NPM_NAME_RE } from '../sources.ts'

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
  gone: boolean
  hostVersion: string | null | undefined
  verdicts: HostCompatibilityMap
  total: number
  attempted: number
  scanning: boolean
}

interface Batch {
  entries: Entry[]
  context: number
  kind: 'full' | 'visible' | 'retry'
  run: number
}

type CatalogLoad = 'loaded' | 'superseded' | 'gone'

function initialPreference(): boolean {
  try { return localStorage.getItem(HOST_FILTER_KEY) !== 'all' } catch { return true }
}

function describeEntry(plugin: RegistryPlugin): Entry | null {
  const key = hostCompatibilityKey(plugin)
  if (key === null) return null
  const version = typeof plugin.version === 'string' ? plugin.version.trim() : ''
  if (!key.startsWith('https://')) {
    if (!NPM_NAME_RE.test(key)) return null
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

/** Shared by Settings and the sidebar. Only dispatched entries occupy a slot. */
export class DiscoveryScan {
  private snapshot: Snapshot | undefined
  private readonly listeners = new Set<() => void>()
  private entries = new Map<string, Entry>()
  private results = new Map<string, Result>()
  private readonly demand = new Map<object, readonly string[]>()
  private readonly inFlight = new Map<Entry, Batch>()
  private full: Batch | undefined
  private visible: Batch | undefined
  private hostVersion: Snapshot['hostVersion']
  private catalog: Registry | null = null
  private boot: string | undefined
  private enabled: boolean | undefined
  private context = 0
  private run = 0
  private catalogRequest = 0
  private resumeRequest: { id: number; result: Promise<CatalogLoad> } | undefined
  private catalogRefreshUsed = false
  private active = false
  private gone = false
  private cursor = 0
  private queue: Entry[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private verdictsChanged = false

  constructor(private readonly onCatalogGenerationChange: () => void) {}

  getSnapshot = (): Snapshot => {
    return this.snapshot ??= {
      enabled: this.enabled ??= initialPreference(),
      catalog: null, gone: false, hostVersion: undefined, verdicts: Object.create(null), total: 0,
      attempted: 0, scanning: false,
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  reset() {
    this.stop()
    this.active = false
    this.gone = false
    this.context += 1
    this.hostVersion = undefined
    this.catalog = null
    this.catalogRequest += 1
    this.resumeRequest = undefined
    this.boot = undefined
    this.enabled = undefined
    this.entries.clear()
    this.results.clear()
    this.demand.clear()
    this.inFlight.clear()
    this.catalogRefreshUsed = false
    this.full = this.visible = undefined
    this.verdictsChanged = false
    this.snapshot = undefined
  }

  setEnabled(enabled: boolean) {
    if (this.getSnapshot().enabled === enabled) return
    try { localStorage.setItem(HOST_FILTER_KEY, enabled ? 'compatible' : 'all') } catch { /* storage is optional */ }
    this.enabled = enabled
    if (enabled) {
      this.allowRetry(this.entries.keys())
      this.restart()
      if ([...this.results.values()].some(result => result.verdict.catalogChanged === true)) {
        this.refreshCatalog()
      }
    } else {
      this.stop()
    }
    this.update()
  }

  private async loadCatalog(): Promise<CatalogLoad> {
    const request = ++this.catalogRequest
    const response = await fetch(api('/dsh-market/registry'), { cache: 'no-store' })
    if (request !== this.catalogRequest) return 'superseded'
    if (response.status === 404) {
      this.setUnavailable()
      return 'gone'
    }
    const body = (await response.json().catch(() => ({}))) as {
      registry?: Registry
      hostVersion?: Snapshot['hostVersion']
      error?: string
    }
    if (request !== this.catalogRequest) return 'superseded'
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`)
    if (body.registry === undefined) throw new Error('the catalog response carried no data')
    const host = body.hostVersion
    this.setCatalog(body.registry, typeof host === 'string' || host === null ? host : undefined)
    return 'loaded'
  }

  private setCatalog(catalog: Registry, hostVersion: Snapshot['hostVersion']) {
    if (catalog.updated !== this.catalog?.updated) this.onCatalogGenerationChange()
    this.catalog = catalog
    const reconnecting = !this.active
    this.active = true
    this.gone = false
    const next = new Map<string, Entry>()
    for (const plugin of catalog.plugins) {
      const described = describeEntry(plugin)
      if (described === null || next.has(described.key)) continue
      const previous = this.entries.get(described.key)
      next.set(described.key, previous?.fingerprint === described.fingerprint ? previous : described)
    }
    const changed = next.size !== this.entries.size || [...next].some(([key, entry]) => this.entries.get(key) !== entry)
    this.entries = next
    const hostChanged = hostVersion !== undefined && hostVersion !== this.hostVersion
    if (hostChanged) {
      this.hostVersion = hostVersion
      this.invalidate()
    }
    if (changed) {
      for (const [key, result] of this.results) {
        if (next.get(key) === result.entry) continue
        this.results.delete(key)
        this.verdictsChanged = true
      }
    }
    if ((changed || hostChanged || reconnecting) && this.getSnapshot().enabled) this.restart(false)
    this.markOversizedEntries()
    if ([...this.results.values()].some(result => result.verdict.catalogChanged === true)) this.refreshCatalog()
    this.update()
  }

  setBoot(boot: string) {
    const previous = this.boot
    this.boot = boot
    if (previous === undefined || previous === boot) return
    this.invalidate()
    this.markOversizedEntries()
    if (this.getSnapshot().enabled) this.restart()
    this.update()
  }

  setUnavailable() {
    if (this.gone) return
    this.active = false
    this.gone = true
    this.stop()
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

  setDemand(owner: object, keys: readonly string[]) {
    const before = this.demand.get(owner) ?? []
    this.demand.set(owner, keys)
    // Revisited rows may retry after their cooldown. A rerender with the same
    // rows never spends another automatic attempt.
    this.allowRetry(keys.filter(key => !before.includes(key)))
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

  private restart(newRun = true) {
    if (newRun) {
      this.run += 1
      this.catalogRefreshUsed = false
    }
    this.queue = [...this.entries.values()]
    this.cursor = 0
  }

  private stop() {
    this.run += 1
    this.catalogRefreshUsed = false
    this.queue = []
    this.cursor = 0
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private visibleKeys(): string[] {
    return [...new Set([...this.demand.values()].flat())]
  }

  private update() {
    const previous = this.getSnapshot()
    const enabled = this.enabled ?? previous.enabled
    const now = Date.now()
    let expired = false
    for (const [key, result] of this.results) {
      if (result.expiresAt > now) continue
      this.results.delete(key)
      expired = true
      this.verdictsChanged = true
    }
    if (expired && enabled) this.restart(false)
    this.pump()
    let verdicts = previous.verdicts
    if (this.verdictsChanged) {
      verdicts = Object.create(null)
      for (const [key, result] of this.results) verdicts[key] = result.verdict
      this.verdictsChanged = false
    }
    const scanning = this.active && enabled && (this.cursor < this.queue.length
      || this.full?.run === this.run || this.visible?.kind === 'visible')
    if (previous.enabled === enabled && previous.catalog === this.catalog && previous.gone === this.gone
      && previous.hostVersion === this.hostVersion
      && previous.verdicts === verdicts && previous.total === this.entries.size
      && previous.attempted === this.results.size && previous.scanning === scanning) return
    this.snapshot = {
      enabled, catalog: this.catalog, gone: this.gone, hostVersion: this.hostVersion, verdicts,
      total: this.entries.size, attempted: this.results.size, scanning,
    }
    for (const listener of this.listeners) listener()
  }

  private pump() {
    if (!this.active) return
    const enabled = this.enabled ?? this.getSnapshot().enabled
    const now = Date.now()
    const available = (entry: Entry): boolean => this.inFlight.get(entry)?.context !== this.context
    const needsLookup = (entry: Entry): boolean => {
      const result = this.results.get(entry.key)
      return result === undefined || result.expiresAt <= now
    }
    if (this.visible === undefined) {
      const entries = this.visibleKeys().flatMap(key => {
        const entry = this.entries.get(key)
        return entry !== undefined && available(entry) ? [entry] : []
      })
      const fresh = this.visibleBatch(entries.filter(needsLookup))
      if (fresh.length > 0) this.dispatch(fresh, 'visible')
      else if (enabled) {
        const retry = this.visibleBatch(entries.filter(entry => {
          const result = this.results.get(entry.key)
          return result !== undefined && result.retryAt <= now && !result.automaticRetryUsed
        }))
        if (retry.length > 0) this.dispatch(retry, 'retry')
      }
    }
    if (enabled && this.full === undefined) {
      const chunk: Entry[] = []
      let bytes = 0
      while (this.cursor < this.queue.length && chunk.length < BATCH_SIZE) {
        const entry = this.queue[this.cursor]!
        if (this.entries.get(entry.key) === entry && available(entry) && needsLookup(entry)) {
          if (bytes + entry.bytes > BATCH_BYTES) break
          bytes += entry.bytes
          chunk.push(entry)
        }
        this.cursor += 1
      }
      if (chunk.length > 0) this.dispatch(chunk, 'full')
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
    if (!this.active || !(this.enabled ?? this.getSnapshot().enabled) || this.visible !== undefined) return
    let next = Infinity
    for (const key of this.visibleKeys()) {
      const result = this.results.get(key)
      if (result === undefined || result.automaticRetryUsed || this.inFlight.has(result.entry)) continue
      next = Math.min(next, result.retryAt)
    }
    if (Number.isFinite(next)) this.timer = setTimeout(() => this.pump(), Math.max(0, next - Date.now()))
  }

  private dispatch(entries: Entry[], kind: Batch['kind']) {
    const batch = { entries, kind, context: this.context, run: this.run }
    if (kind === 'full') this.full = batch
    else this.visible = batch
    for (const entry of entries) this.inFlight.set(entry, batch)
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
    if (this.full === batch) this.full = undefined
    if (this.visible === batch) this.visible = undefined
    for (const entry of batch.entries) {
      if (this.inFlight.get(entry) === batch) this.inFlight.delete(entry)
    }
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
        if (batch.kind !== 'full' || this.getSnapshot().enabled) this.refreshCatalog()
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
        entry, verdict, retryAt, automaticRetryUsed: batch.kind === 'retry',
        expiresAt: verdict.basis !== 'unavailable' && entry.expires ? now + MUTABLE_SOURCE_TTL_MS : Infinity,
      })
      this.verdictsChanged = true
    }
    if (catalogChanged && (batch.kind !== 'full' || this.getSnapshot().enabled)) this.refreshCatalog()
    this.update()
  }

  private refreshCatalog() {
    if (!this.active || this.catalogRefreshUsed) return
    this.catalogRefreshUsed = true
    void this.loadCatalog().catch(() => {
      // Preserve the rendered list. The next explicit scan may refresh again.
    })
  }
}
