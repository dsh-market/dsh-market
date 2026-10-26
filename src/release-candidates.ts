/** Issue #991: pure, fail-closed selector for official Desktop npm stable updates. */
export interface NpmPackument {
  versions?: Record<string, unknown>
  time?: Record<string, unknown>
  'dist-tags'?: Record<string, unknown>
}

export interface MatureUpdatePolicy {
  minimumReleaseAgeMs: number
  exemptPackage?: boolean
  exemptVersions?: ReadonlySet<string>
  latestFromEndpoint?: string | null
  /** Existing compatibility dialog may request a lower stable release. */
  maxVersion?: string
}

export interface MatureUpdateSelection {
  candidate: string | null
  latest: string | null
  held: string | null
  reason: 'eligible' | 'current' | 'held' | 'unknown-age' | 'inconsistent' | 'invalid-installed' | 'policy-unknown'
  nextMaturityAt: number | null
  latestMaturityAt: number | null
}

type Semver = { core: [bigint, bigint, bigint]; prerelease: string[] }

function semver(value: unknown): Semver | null {
  if (typeof value !== 'string') return null
  const matched = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value)
  if (!matched) return null
  const prerelease = matched[4]?.split('.') ?? []
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return null
  return { core: [BigInt(matched[1]!), BigInt(matched[2]!), BigInt(matched[3]!)], prerelease }
}

/** Accept stable SemVer, including build metadata, at both API boundaries. */
export function isStableReleaseVersion(value: unknown): value is string {
  const parsed = semver(value)
  return parsed !== null && parsed.prerelease.length === 0
}

function compare(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) {
    if (a.core[i]! !== b.core[i]!) return a.core[i]! > b.core[i]! ? 1 : -1
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return Math.sign(b.prerelease.length - a.prerelease.length)
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1
    if (xn !== yn) return xn ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

export function strictPublishTime(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  return new Date(timestamp).toISOString().slice(0, 19) === value.slice(0, 19) ? timestamp : null
}

export function selectMatureUpdate(packument: NpmPackument, installed: string | null, now: number, policy: MatureUpdatePolicy): MatureUpdateSelection {
  const latest = typeof packument?.['dist-tags']?.latest === 'string' ? packument['dist-tags'].latest : null
  const empty = (reason: MatureUpdateSelection['reason']): MatureUpdateSelection =>
    ({ candidate: null, latest, held: null, reason, nextMaturityAt: null, latestMaturityAt: null })
  const top = semver(latest)
  if (!top || top.prerelease.length || !packument.versions || !packument.time ||
    typeof packument.versions !== 'object' || typeof packument.time !== 'object' ||
    !Object.hasOwn(packument.versions, latest!) ||
    (policy.latestFromEndpoint != null && policy.latestFromEndpoint !== latest)) return empty('inconsistent')
  const ceiling = policy.maxVersion === undefined ? top : semver(policy.maxVersion)
  if (!ceiling || ceiling.prerelease.length ||
    (policy.maxVersion !== undefined && !Object.hasOwn(packument.versions, policy.maxVersion))) return empty('inconsistent')
  const current = semver(installed)
  if (!current || current.prerelease.length) return empty('invalid-installed')
  const ageMs = policy.minimumReleaseAgeMs
  if (!Number.isSafeInteger(ageMs) || ageMs < 0 || !Number.isFinite(now)) return empty('policy-unknown')
  let candidate: string | null = null
  let candidateSemver: Semver | null = null
  let nextMaturityAt: number | null = null
  for (const version of Object.keys(packument.versions)) {
    const parsed = semver(version)
    if (!parsed || parsed.prerelease.length || compare(parsed, current) <= 0 || compare(parsed, top) > 0 || compare(parsed, ceiling) > 0) continue
    const published = strictPublishTime(packument.time[version])
    const exempt = policy.exemptPackage === true || policy.exemptVersions?.has(version) === true
    // A declared exemption is not evidence for a fabricated or absent timestamp.
    if (published === null || published > now || (!exempt && published > now - ageMs)) {
      if (published !== null && published <= now && Number.isFinite(published + ageMs)) {
        const at = published + ageMs
        if (nextMaturityAt === null || at < nextMaturityAt) nextMaturityAt = at
      }
      continue
    }
    if (candidateSemver === null || compare(parsed, candidateSemver) > 0) {
      candidate = version
      candidateSemver = parsed
    }
  }
  const latestPublished = strictPublishTime(packument.time[latest!])
  const latestExempt = policy.exemptPackage === true || policy.exemptVersions?.has(latest!) === true
  const latestMature = latestPublished !== null && latestPublished <= now &&
    (latestExempt || latestPublished <= now - ageMs)
  return {
    candidate, latest, held: latestMature ? null : latest,
    reason: candidate ? 'eligible' : latestMature ? 'current' : latestPublished === null ? 'unknown-age' : 'held',
    nextMaturityAt,
    latestMaturityAt: latestPublished === null || latestExempt ? null : latestPublished + ageMs,
  }
}
