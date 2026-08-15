/**
 * WhaleHarness audit access: fetch https://whaleharness.com/audit.json with
 * an in-memory TTL cache, falling back to the bundled snapshot when offline,
 * timed out, or malformed. Matching is case-insensitive on owner/repo and a
 * monorepo /tree/ subpath falls back to its repo-level verdict.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { repoOf } from './sources.ts'

/** A verdict is one of the audit's three states. */
export type Verdict = 'PASS' | 'REJECT' | 'UNEVALUATED'

export interface AuditEntry {
  repo: string
  version?: string
  commit?: string
  verdict: Verdict
  issues?: string[]
}

export interface Audit {
  auditor?: string
  site?: string
  method?: string
  generated_at?: string
  entries: AuditEntry[]
}

const AUDIT_URL = 'https://whaleharness.com/audit.json'
const TTL_MS = 60 * 60 * 1000

let cache: { at: number; data: Audit } | null = null

function snapshot(): Audit {
  const path = fileURLToPath(new URL('../data/audit-snapshot.json', import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as Audit
}

/**
 * Load the audit, preferring a healthy live fetch, then the in-memory cache,
 * then the bundled snapshot. Any network error, timeout, or malformed payload
 * degrades silently — the caller must never see a throw for audit data.
 */
export async function loadAudit(): Promise<{ audit: Audit; source: 'live' | 'cache' | 'snapshot' }> {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return { audit: cache.data, source: 'cache' }
  }
  try {
    const res = await fetch(AUDIT_URL, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = (await res.json()) as Audit
    if (!Array.isArray(data.entries)) throw new Error('invalid audit payload')
    cache = { at: Date.now(), data }
    return { audit: data, source: 'live' }
  } catch {
    return { audit: cache?.data ?? snapshot(), source: cache ? 'cache' : 'snapshot' }
  }
}

/**
 * The verdict for a registry URL, or null when the repo has no entry (and for
 * non-GitHub URLs). Matching is case-insensitive; a /tree/ subpath resolves
 * through the repo-level entry, never a subpackage-level one.
 */
export function verdictOf(url: string, audit: Audit | null): Verdict | null {
  if (audit === null) return null
  const repo = repoOf(url)
  if (repo === null) return null
  const key = repo.toLowerCase()
  const entry = audit.entries.find(e => e.repo.toLowerCase() === key)
  return entry?.verdict ?? null
}

/** A repo-keyed verdict map (repo lowercased) for the client payload. */
export function verdictMap(audit: Audit): Record<string, Verdict> {
  const map: Record<string, Verdict> = {}
  for (const entry of audit.entries) map[entry.repo.toLowerCase()] = entry.verdict
  return map
}
