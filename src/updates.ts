/**
 * Update detection: per-plugin comparison of what the profile has against
 * the source of truth — git HEAD for github installs, the npm latest
 * dist-tag for registry installs — with a TTL cache.
 */

import { profileDir, readInstalled, readInstalledVersion, readLockCommits } from './profile.ts'

export interface UpdateStatus {
  kind: 'github' | 'npm' | 'linked'
  version: string | null
  current: string | null
  latest: string | null
  updateAvailable: boolean
}

const UPDATES_TTL_MS = 30 * 60 * 1000
let updatesCache: { key: string; at: number; data: Record<string, UpdateStatus> } | null = null

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseSemver(v: string): { core: number[]; pre: string[] } | null {
  const m = SEMVER.exec(v.trim())
  if (m === null) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? [] : m[4].split('.') }
}

/**
 * Semver precedence: negative / 0 / positive like a comparator, or null when
 * either side isn't a plain semver version. Build metadata is ignored, a
 * release outranks any prerelease of the same core, and prerelease
 * identifiers compare numerically when both are numeric (so `rc.10` > `rc.9`).
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (pa === null || pb === null) return null
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i]
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) return Number(x) - Number(y)
    if (nx !== ny) return nx ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * True only when the registry's `latest` is semantically HIGHER than what the
 * profile has (#64 by @ZeroOrigin64). A plain `!==` also fires when a
 * package's `latest` dist-tag is left pointing at an OLDER release than the
 * pinned install — clicking "update" then rewrote the exact pin to `@latest`
 * and downgraded the profile until it no longer booted.
 *
 * Undecidable inputs (missing or non-semver versions) report no update:
 * without a direction we cannot promise the "update" isn't a downgrade.
 */
export function isUpgrade(installed: string | null, latest: string | null): boolean {
  if (installed === null || latest === null) return false
  const cmp = compareVersions(latest, installed)
  return cmp !== null && cmp > 0
}

/** Drop the cached listing (after a successful install/update/uninstall). */
export function invalidateUpdates(): void {
  updatesCache = null
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-market' },
    signal: AbortSignal.timeout(4000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as unknown
}

/**
 * Evidence check behind the "wait a day" stale diagnosis (#45): whether the
 * package's CURRENT latest release was published recently enough to sit
 * inside pnpm's default fresh-release window. pnpm's silent hold leaves no
 * trace in its output, so the publish time is the only verifiable signal.
 * @returns true/false when the npm time metadata answers, null when it
 *   can't be determined (offline, unpublished, non-npm) — callers must NOT
 *   claim the safety wait on null.
 */
export async function latestPublishedRecently(name: string, windowMs = 26 * 60 * 60 * 1000): Promise<boolean | null> {
  try {
    const doc = (await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`)) as {
      'dist-tags'?: Record<string, string>
      time?: Record<string, string>
    }
    const latest = doc['dist-tags']?.latest
    const published = latest !== undefined ? doc.time?.[latest] : undefined
    if (published === undefined) return null
    const age = Date.now() - Date.parse(published)
    return Number.isFinite(age) ? age < windowMs : null
  } catch {
    return null
  }
}

/** The registry's current `latest` version for a package, or null when it can't be read. */
/**
 * The version a beta subscriber should be offered: whichever of the `beta`
 * and `latest` dist-tags is actually newer.
 *
 * A beta tag is not automatically ahead. Once 1.14.0 ships, `beta` still
 * points at 1.14.0-beta.1 until someone publishes the next prerelease — and
 * offering that as an "update" would walk a subscriber backwards. Comparing
 * is the only correct reading of "give me the newest thing available to me".
 * @param stable - the `latest` version, already fetched by the caller.
 */
export async function preferBeta(name: string, stable: string | null): Promise<string | null> {
  try {
    const meta = (await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/beta`)) as { version?: string }
    const beta = typeof meta.version === 'string' ? meta.version : null
    if (beta === null) return stable
    if (stable === null) return beta
    return isUpgrade(stable, beta) ? beta : stable
  } catch {
    // No beta published yet is the normal case, and a registry hiccup must
    // not take the ordinary update check down with it.
    return stable
  }
}

export async function fetchNpmLatest(name: string): Promise<string | null> {
  try {
    const meta = (await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`)) as { version?: string }
    return typeof meta.version === 'string' ? meta.version : null
  } catch {
    return null
  }
}

/** Per-plugin update checks; a failed check reports no update rather than failing the listing. */
export async function checkUpdates(
  profile: string,
  force = false,
  explicitDir?: string,
  /**
   * Packages whose updates may come from the `beta` dist-tag. Only ever the
   * market itself: opting into prereleases is volunteering to try THIS
   * plugin early, not a licence to pull every other author's unreleased work.
   */
  betaFor: ReadonlySet<string> = new Set(),
): Promise<Record<string, UpdateStatus>> {
  const activeProfileDir = profileDir(profile, explicitDir)
  // The channel is part of the key: switching to betas has to change the
  // answer immediately, and a cache keyed on the profile alone would serve
  // the stable verdict for the rest of the TTL — reading as "the setting did
  // nothing".
  const cacheKey = `${activeProfileDir}\u0000${[...betaFor].sort().join(',')}`
  if (!force && updatesCache?.key === cacheKey && Date.now() - updatesCache.at < UPDATES_TTL_MS) {
    return updatesCache.data
  }
  const installed = readInstalled(profile, activeProfileDir)
  const lockCommits = readLockCommits(profile, activeProfileDir)
  const result: Record<string, UpdateStatus> = {}
  await Promise.all(Object.entries(installed).map(async ([name, spec]) => {
    const version = readInstalledVersion(profile, name, activeProfileDir)
    if (spec.startsWith('link:') || spec.startsWith('file:')) {
      result[name] = { kind: 'linked', version, current: null, latest: null, updateAvailable: false }
      return
    }
    const gh = /^(?:github:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#.*)?$/.exec(spec)
    try {
      if (spec.startsWith('github:') && gh !== null) {
        const current = lockCommits.get(gh[1].toLowerCase()) ?? null
        const head = (await fetchJson(`https://api.github.com/repos/${gh[1]}/commits/HEAD`)) as { sha?: string }
        const latest = typeof head.sha === 'string' ? head.sha : null
        result[name] = {
          kind: 'github', version, current, latest,
          updateAvailable: current !== null && latest !== null && current !== latest,
        }
      } else {
        const meta = (await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`)) as { version?: string }
        const stable = typeof meta.version === 'string' ? meta.version : null
        const latest = betaFor.has(name) ? await preferBeta(name, stable) : stable
        result[name] = {
          kind: 'npm', version, current: version, latest,
          updateAvailable: isUpgrade(version, latest),
        }
      }
    } catch {
      result[name] = { kind: spec.startsWith('github:') ? 'github' : 'npm', version, current: null, latest: null, updateAvailable: false }
    }
  }))
  updatesCache = { key: cacheKey, at: Date.now(), data: result }
  return result
}
