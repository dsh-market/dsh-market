/**
 * Optional, read-only compatibility evidence published by upstream-radar.
 *
 * This is deliberately separate from the curated registry: a slow, missing,
 * malformed, or stale evidence feed must never hide plugins or block an
 * install. The registry answers "what may be installed"; this feed only adds
 * a dated observation about one exact artifact/runtime cell.
 */

import { marketFetch } from './net.ts'
import { activeRegion, routesFor, throughProxy } from './regions.ts'
import { normalizeCatalogUrl } from './catalog-identity.ts'

export const COMPATIBILITY_EVIDENCE_SCHEMA = 'dsh-market/compatibility-evidence/v1' as const
export const RADAR_FEED_SCHEMA = 'upstream-radar.dsh-directory-compatibility-feed/v1alpha1' as const
export const RADAR_FEED_URL = 'https://raw.githubusercontent.com/MicroMilo/upstream-radar/main/feeds/dsh-plugin-compatibility.json'
export const RADAR_PROJECT_URL = 'https://github.com/MicroMilo/upstream-radar'

// Separate from the catalog request, so waiting here never delays browsing or
// installing. Eight seconds survived the same long-path connection where a
// measured 3-second cap intermittently hid a healthy 15 KB feed.
const FETCH_TIMEOUT_MS = 8_000
const MAX_FEED_BYTES = 1_000_000
const MAX_PLUGINS = 5_000
const MAX_CELLS_PER_PLUGIN = 32

export type CompatibilityEvidenceStatus =
  | 'observed-compatible'
  | 'observed-incompatible'
  | 'needs-review'

export interface CompatibilityEvidenceCell {
  artifact: string
  dshVersion: string
  nodeMajor: number
  executionPlane: string
  profile: string
  status: CompatibilityEvidenceStatus
  observedAt: string
  recheckDueAt: string
  reason: string
}

export interface CompatibilityEvidenceEntry {
  /** Exact awesome-dsh-plugin entry identity, including a monorepo subpath. */
  catalogUrl: string
  status: CompatibilityEvidenceStatus
  cells: CompatibilityEvidenceCell[]
  evidenceUrl: string
}

export interface CompatibilityEvidencePayload {
  schema: typeof COMPATIBILITY_EVIDENCE_SCHEMA
  generatedAt: string
  source: {
    name: 'upstream-radar'
    url: string
    projectUrl: string
  }
  boundary: string
  entries: CompatibilityEvidenceEntry[]
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function boundedString(value: unknown, label: string, maximum = 2_048): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string no longer than ${String(maximum)} characters`)
  }
  return value
}

function timestamp(value: unknown, label: string): { value: string; time: number } {
  const text = boundedString(value, label, 64)
  const time = Date.parse(text)
  if (!Number.isFinite(time)) throw new Error(`${label} must be an ISO timestamp`)
  return { value: text, time }
}

function parseStatus(value: unknown, label: string): CompatibilityEvidenceStatus {
  if (value === 'observed-compatible' || value === 'observed-incompatible' || value === 'needs-review') return value
  throw new Error(`${label} is unsupported`)
}

function aggregateStatus(cells: readonly CompatibilityEvidenceCell[]): CompatibilityEvidenceStatus {
  if (cells.some(cell => cell.status === 'observed-incompatible')) return 'observed-incompatible'
  if (cells.some(cell => cell.status === 'needs-review')) return 'needs-review'
  return 'observed-compatible'
}

/** Parse, bound, and remove stale cells from a Radar directory feed. */
export function parseCompatibilityEvidenceFeed(input: unknown, now = Date.now()): CompatibilityEvidencePayload {
  const root = object(input, 'compatibility feed')
  if (root.schema !== RADAR_FEED_SCHEMA) throw new Error(`compatibility feed schema must be ${RADAR_FEED_SCHEMA}`)
  const generatedAt = timestamp(root.generatedAt, 'compatibility feed generatedAt').value
  const producer = object(root.producer, 'compatibility feed producer')
  if (producer.name !== 'upstream-radar' || producer.repository !== RADAR_PROJECT_URL || producer.license !== 'Apache-2.0') {
    throw new Error('compatibility feed producer is not the expected Apache-2.0 upstream-radar source')
  }
  if (!Array.isArray(root.plugins) || root.plugins.length > MAX_PLUGINS) {
    throw new Error(`compatibility feed plugins must be an array no longer than ${String(MAX_PLUGINS)}`)
  }

  const entries: CompatibilityEvidenceEntry[] = []
  const identities = new Set<string>()
  for (const [pluginIndex, value] of root.plugins.entries()) {
    const plugin = object(value, `plugins[${String(pluginIndex)}]`)
    const rawCatalogUrl = boundedString(plugin.catalogUrl, `plugins[${String(pluginIndex)}].catalogUrl`)
    const catalogUrl = normalizeCatalogUrl(rawCatalogUrl)
    if (catalogUrl === null) throw new Error(`plugins[${String(pluginIndex)}].catalogUrl must be an exact credential-free GitHub URL`)
    if (identities.has(catalogUrl)) throw new Error(`duplicate compatibility catalog identity: ${catalogUrl}`)
    identities.add(catalogUrl)
    if (!Array.isArray(plugin.cells) || plugin.cells.length > MAX_CELLS_PER_PLUGIN) {
      throw new Error(`plugins[${String(pluginIndex)}].cells must be a bounded array`)
    }

    const cells: CompatibilityEvidenceCell[] = []
    for (const [cellIndex, cellValue] of plugin.cells.entries()) {
      const label = `plugins[${String(pluginIndex)}].cells[${String(cellIndex)}]`
      const cell = object(cellValue, label)
      const expires = timestamp(cell.recheckDueAt, `${label}.recheckDueAt`)
      // Stale evidence is absence, never a pass, failure, or review warning.
      if (expires.time <= now) continue
      const observedAt = timestamp(cell.observedAt, `${label}.observedAt`)
      if (observedAt.time > expires.time) throw new Error(`${label}.observedAt must not follow recheckDueAt`)
      const artifact = object(cell.artifact, `${label}.artifact`)
      const dsh = object(cell.dsh, `${label}.dsh`)
      if (dsh.package !== '@deepseek-ai/dsh') throw new Error(`${label}.dsh.package must be @deepseek-ai/dsh`)
      const runtime = object(cell.runtime, `${label}.runtime`)
      const nodeMajor = Number(runtime.nodeMajor)
      if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 16 || nodeMajor > 64) {
        throw new Error(`${label}.runtime.nodeMajor must be a bounded integer`)
      }
      cells.push({
        artifact: boundedString(artifact.spec, `${label}.artifact.spec`, 512),
        dshVersion: boundedString(dsh.version, `${label}.dsh.version`, 128),
        nodeMajor,
        executionPlane: boundedString(cell.executionPlane, `${label}.executionPlane`, 64),
        profile: boundedString(cell.profile, `${label}.profile`, 64),
        status: parseStatus(cell.status, `${label}.status`),
        observedAt: observedAt.value,
        recheckDueAt: expires.value,
        reason: boundedString(cell.reason, `${label}.reason`),
      })
    }
    if (cells.length === 0) continue
    cells.sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))
    entries.push({
      catalogUrl,
      status: aggregateStatus(cells),
      cells,
      // Never let a fetched document choose where the market sends a user.
      evidenceUrl: `${RADAR_PROJECT_URL}/blob/main/feeds/dsh-plugin-compatibility.md`,
    })
  }

  return {
    schema: COMPATIBILITY_EVIDENCE_SCHEMA,
    generatedAt,
    source: { name: 'upstream-radar', url: RADAR_FEED_URL, projectUrl: RADAR_PROJECT_URL },
    boundary: 'Dated exact-artifact/runtime observations only; not a security review, endorsement, or install gate.',
    entries,
  }
}

/** Fetch one optional evidence snapshot. Callers decide how to fail open. */
export async function loadCompatibilityEvidence(now = Date.now()): Promise<CompatibilityEvidencePayload> {
  // Follow the market's selected GitHub route so the optional evidence is
  // not silently global-only on mainland profiles.
  const fetchUrl = throughProxy(routesFor(activeRegion()).githubProxy, RADAR_FEED_URL)
  const response = await marketFetch(fetchUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
  })
  if (!response.ok) throw new Error(`compatibility evidence HTTP ${String(response.status)}`)
  const declaredSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > MAX_FEED_BYTES) throw new Error('compatibility evidence exceeds 1 MB')
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_FEED_BYTES) throw new Error('compatibility evidence exceeds 1 MB')
  return parseCompatibilityEvidenceFeed(JSON.parse(text) as unknown, now)
}
