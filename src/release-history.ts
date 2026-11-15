import type { ReleaseNotes } from './changelog.ts'
import { marketFetch } from './net.ts'
import { isStableReleaseVersion } from './release-candidates.ts'
import { compareVersions } from './updates.ts'

interface HistoryRelease extends ReleaseNotes {
  tag: string
  commit: string | null
}

interface RepositoryHistory {
  complete: boolean
  releases: HistoryRelease[]
}

export interface ReleaseHistory {
  items: VersionedRelease[]
  partial: boolean
}

type VersionedRelease = ReleaseNotes & { version: string }

export interface ReleaseHistorySource {
  repo: string
  packageName: string
  allowPlainTag: boolean
}

const MAX_BYTES = 1_048_576
const MAX_RELEASES = 256
const MAX_CACHED_REPOS = 32
const HISTORY_TTL_MS = 60 * 60 * 1000
const RETRY_MS = 30_000
const cache = new Map<string, { expires: number; result: Promise<RepositoryHistory | null> }>()

export function isCommitId(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value)
}

export function invalidateReleaseHistory(): void {
  cache.clear()
}

function asRelease(value: unknown): HistoryRelease | null {
  if (value === null || typeof value !== 'object') return null
  const { tag, body, name, publishedAt, url, commit } = value as Partial<Record<keyof HistoryRelease, unknown>>
  if (typeof tag !== 'string' || tag.length > 256 || typeof body !== 'string') return null
  return {
    tag, body,
    name: typeof name === 'string' ? name : null,
    publishedAt: typeof publishedAt === 'string' ? publishedAt : null,
    url: typeof url === 'string' ? url : null,
    commit: typeof commit === 'string' && isCommitId(commit) ? commit.toLowerCase() : null,
  }
}

/** Only the built catalog origin and a validated repository path can be fetched. */
async function fetchHistory(origin: string, repo: string): Promise<RepositoryHistory | null> {
  const url = new URL(`release-history/v1/${repo}.json`, origin)
  const response = await marketFetch(url.href, {
    signal: AbortSignal.timeout(5_000),
    headers: { accept: 'application/json', 'user-agent': 'dsh-market' },
  })
  if (response.body === null) return null
  if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body.cancel()
    return null
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let json = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) {
        await reader.cancel()
        return null
      }
      json += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
  const data = JSON.parse(json + decoder.decode()) as { repo?: unknown; complete?: unknown; releases?: unknown }
  if (data?.repo !== repo || !Array.isArray(data.releases) || data.releases.length > MAX_RELEASES) return null
  const releases = data.releases.map(asRelease).filter((release): release is HistoryRelease => release !== null)
  return { releases, complete: data.complete === true && releases.length === data.releases.length }
}

export function loadReleaseHistory(origin: string, repo: string): Promise<RepositoryHistory | null> {
  if (!/^[a-z0-9-]+\/[a-z0-9_.-]+$/.test(repo) || repo.endsWith('/.') || repo.endsWith('/..')) {
    return Promise.resolve(null)
  }
  const key = `${origin}\n${repo}`
  const hit = cache.get(key)
  if (hit !== undefined && Date.now() < hit.expires) return hit.result
  cache.delete(key)
  const entry = {
    expires: Date.now() + HISTORY_TTL_MS,
    result: fetchHistory(origin, repo).catch(() => null).then(result => {
      if (result === null) entry.expires = Date.now() + RETRY_MS
      return result
    }),
  }
  cache.set(key, entry)
  if (cache.size > MAX_CACHED_REPOS) cache.delete(cache.keys().next().value!)
  return entry.result
}

/** A sibling's version or a number embedded in an unrelated tag is not a package release. */
export function packageReleaseVersion(tag: string | null, source: ReleaseHistorySource): string | null {
  if (tag === null) return null
  const separator = ['@', '-', '/'].find(mark => tag.startsWith(source.packageName + mark))
  if (separator === undefined && !source.allowPlainTag) return null
  const version = (separator === undefined ? tag : tag.slice(source.packageName.length + 1)).replace(/^v/, '')
  return isStableReleaseVersion(version) ? version : null
}

/** Installed and target versions are given by npm, or by exact release-tag SHAs for Git. */
export function releaseHistoryBetween(
  data: RepositoryHistory | null,
  source: ReleaseHistorySource,
  installed: string,
  target: string,
  current: string | null,
): { history: ReleaseHistory; targetVersion: string | null; targetCommit: string | null; preview: VersionedRelease | null } {
  const versions = new Map<string, HistoryRelease | null>()
  for (const release of data?.releases ?? []) {
    const version = packageReleaseVersion(release.tag, source)
    if (version !== null) versions.set(version, versions.has(version) ? null : release)
  }

  const gitTarget = isCommitId(target)
  const anchors = gitTarget && current !== null && versions.get(installed)?.commit === current.toLowerCase()
    ? [...versions].filter(([version, release]) => release?.commit === target.toLowerCase()
      && (compareVersions(version, installed) ?? 0) > 0)
    : []
  const targetVersion = gitTarget ? anchors.length === 1 ? anchors[0]![0] : null : target
  const items: ReleaseHistory['items'] = []
  let preview: VersionedRelease | null = null
  let missing = targetVersion === null
  if (targetVersion !== null) {
    missing = !versions.get(targetVersion)?.body.trim()
    for (const [version, release] of versions) {
      if ((compareVersions(version, installed) ?? 0) <= 0) continue
      const beyond = (compareVersions(version, targetVersion) ?? 0) > 0
      if (release === null) {
        if (!beyond) missing = true
        continue
      }
      const { tag, name, publishedAt, url, body } = release
      const item = { version, tag, name, publishedAt, url, body }
      if (beyond) {
        if (preview === null || (compareVersions(version, preview.version) ?? 0) > 0) preview = item
      } else {
        items.push(item)
        if (body.trim() === '') missing = true
      }
    }
    items.sort((a, b) => compareVersions(b.version, a.version) ?? 0)
  }
  return {
    history: { items, partial: data?.complete !== true || missing },
    targetVersion,
    targetCommit: gitTarget ? target : versions.get(target)?.commit ?? null,
    preview,
  }
}
