/**
 * Update detection: per-plugin comparison of what the profile has against
 * the source of truth — git HEAD for github installs, the npm latest
 * dist-tag for registry installs — with a TTL cache.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { JSON_SCHEMA, load } from 'js-yaml'
import { DIST_TAG, type Channel } from './channels.ts'
import { resolveHeadCommit } from './accelerate.ts'
import { marketFetch } from './net.ts'
import { activeRegion, githubRoutesFor, rememberGithubRoute, throughProxy, type Region } from './regions.ts'
import type { GitToNpmMigration, NpmRenameMigration } from './source-migration.ts'
import { readMinimumReleaseAgeMs } from './install.ts'
import { isStableReleaseVersion, selectMatureUpdate, type MatureUpdateSelection, type NpmPackument } from './release-candidates.ts'
import { hasDshManifest, profileDir, readGitResolutionCommit, readInstalled, readInstalledVersion, readLockCommits, readProfileBundles } from './profile.ts'
import { userPatchPackageReferences } from './patch.ts'
import { catalogRepoKey, gitCommitOfTarget, gitRefOfTarget, gitUploadPackUrl, hasSemverSelector, hostedRepoKey, githubCommitOfTarget, githubRefOfTarget, isGenerationLink, isGitHostedSpec, lookupRepoFromUrl, parseGitHubRemote, repoOfTarget } from './sources.ts'

export interface UpdateStatus {
  /**
   * `generation` is a `link:` the desktop host wrote (#497): the host
   * installs it and reconciles it at startup, so the market names a newer
   * release under `latest` and never offers to apply it. For that kind
   * `latest` is null when the installed build is current or nothing newer
   * can be confirmed.
   */
  kind: 'github' | 'npm' | 'linked' | 'generation'
  version: string | null
  current: string | null
  latest: string | null
  /**
   * A NEWER version exists. Forwards only, always — every caller reads it
   * as "there is an upgrade" and labels a button accordingly.
   */
  updateAvailable: boolean
  /** Exact mature npm stable target for Desktop; `latest` remains the registry tag. */
  eligibleVersion?: string
  /**
   * HEAD of the chosen line for a floating git install whose repository has
   * moved without publishing: newer commits exist (current ≠ latest) but the
   * version did not advance, so #824's rule answers `updateAvailable: false`
   * — the update channel installs releases, not arbitrary branch heads.
   *
   * This field keeps the fact visible instead of collapsing it into "up to
   * date": the market shows "有新提交（未发版）<short sha>" so a user who
   * DOES want the unreleased bits knows a rebuild-installed row is behind,
   * while everyone else is not nagged by a permanent update button.
   */
  unreleasedCommit?: string
  /**
   * This package is a plain dependency, not a plugin: no `dsh` field, not in
   * `dsh.profile.bundles`, and no row of the user's own patch loads it
   * (#793). A newer release can exist and is reported as `latest`, but it is
   * never `updateAvailable` — the update channel installs a BUNDLE, and
   * handing it a package with no bundle patch is refused by the host as
   * `not-bundle` after the run, with a rollback message that reads as though
   * the profile were damaged when nothing was touched.
   */
  notAPlugin?: true
  /**
   * A newer build exists on a tag other than `latest` (#867).
   *
   * Some packages leave `latest` pointing at an older line than the one they
   * actually publish on: `@deepseek-ai/dsh-experimental-agent-team-profile`
   * answers `latest` with 0.1.5-alpha.2 while `alpha` is 0.2.1-alpha.4, so a
   * user who installed 0.2.1-alpha.2 reads "up to date" while the line they
   * are following has moved. Named, and never `updateAvailable`: the market's
   * channels are the market's own, and this is the fact, not an upgrade the
   * market decided to offer.
   */
  newerPrerelease?: string
  /** Taking this update replaces a local package source with its matched online release. */
  restoreRequired?: boolean
  /**
   * Independent, explicit source switch offered for an installed profile: a
   * verified legacy Git install (#461), or an npm install whose package was
   * renamed and no longer resolves (#1012).
   */
  sourceMigration?: GitToNpmMigration | NpmRenameMigration
  /**
   * A newer release exists but this profile's `minimumReleaseAge` will not let
   * pnpm install it yet (#945). The official Desktop takes no one-shot bypass,
   * so offering the update there means offering a button that is guaranteed
   * to fail; the market names the wait instead. `updateAvailable` can still
   * be true if `eligibleVersion` names a different, already mature upgrade.
   * `until` is when the newer held release should become installable.
   */
  heldUpdate?: { latest: string; until: string; estimated?: true }
  /**
   * The version this package's channel points at, when it differs from what
   * is installed and is NOT newer.
   *
   * A separate field rather than a second meaning for `updateAvailable`,
   * which was tried and leaked immediately: the market page has three
   * consumers of that flag (the header banner, "update all", the row
   * button) and all three announced a DOWNGRADE as "a new version is
   * available". One field, one meaning; a caller that has not been taught
   * about channel switches simply does not offer one.
   *
   * Only a channel-following package can be in this state, and it is the
   * state that used to be unreachable: picking "stable" while a prerelease
   * was installed compared 1.13.1 against 1.14.0-beta.1, found nothing
   * newer, and answered "up to date" — so there was no way back off a
   * channel the user had just left.
   */
  channelSwitch?: string
}

/**
 * Whether a direct dependency is a plugin the update channel can apply (#793).
 *
 * The update path installs a BUNDLE: it re-adds the package and lets the host
 * compose its patch. A direct dependency that is only a library or a CLI
 * (`@mnemon-dev/mnemon` — a `bin` and no `dsh` field) is listed because it is
 * in `package.json`, and nothing before this asked what it was, so a newer
 * release made it "updatable" and the click ended in the host's `not-bundle`.
 *
 * Three independent facts each count as "this is a plugin", and a package
 * must have none of them to be left out:
 *
 *  - its own manifest declares a `dsh` field;
 *  - the profile lists it in `dsh.profile.bundles`;
 *  - a row of the user's own `cordis.patch.yml` loads it by name — a package
 *    can be a real, working plugin while declaring nothing itself (the
 *    official `@deepseek-ai/dsh-tools` has no `dsh` field and is loaded by the
 *    base patch), and treating that as a library would silently stop
 *    offering its updates.
 *
 * Every uncertainty resolves toward "is a plugin": an unreadable patch, an
 * unreadable manifest, a package that is not installed yet. This only ever
 * REMOVES an offer, so being unsure has to leave the offer standing — the
 * old behaviour — rather than hide an update the user wanted.
 */
export function isUpdatablePlugin(activeProfileDir: string, name: string, bundles: ReadonlySet<string>): boolean {
  const dir = join(activeProfileDir, 'node_modules', name)
  if (!existsSync(join(dir, 'package.json'))) return true
  if (hasDshManifest(dir)) return true
  if (bundles.has(name)) return true
  const references = userPatchPackageReferences(join(activeProfileDir, 'cordis.patch.yml'), name)
  return references === null || references.length > 0
}

const UPDATES_TTL_MS = 30 * 60 * 1000
const GIT_REMOTE_HEAD_TIMEOUT_MS = 6000
let updatesCache: { key: string; at: number; recheckAt: number; data: Record<string, UpdateStatus> } | null = null

/**
 * HEAD for an arbitrary smart-HTTP git remote (Gitea, GitLab, …). Same
 * advertisement format as GitHub's info/refs; kept here so accelerate.ts
 * does not need to import sources.ts.
 */
export async function resolveGitRemoteHead(spec: string, ref?: string): Promise<string | null> {
  const url = gitUploadPackUrl(spec)
  if (url === null) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GIT_REMOTE_HEAD_TIMEOUT_MS)
  try {
    const res = await marketFetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'git/2.40.0' },
    })
    if (!res.ok) return null
    const body = await res.text()
    const contentType = res.headers?.get?.('content-type')?.toLowerCase() ?? ''
    if (contentType.includes('text/html')
      || !body.includes('# service=git-upload-pack')
      || !/[0-9a-f]{40} (?:HEAD|refs\/(?:heads|tags)\/)/u.test(body)) {
      return null
    }
    if (ref === undefined) {
      const found = /([0-9a-f]{40}) HEAD/.exec(body)
      return found === null ? null : found[1]!
    }
    const quoted = ref.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)
    for (const namespace of ['heads', 'tags']) {
      // An annotated tag is advertised TWICE: the tag OBJECT on
      // `refs/tags/<t>`, and the COMMIT it points at on `refs/tags/<t>^{}`.
      // A lockfile records the commit, so resolving the tag object can never
      // equal it — the row reports an update forever, and applying it
      // reinstalls the same commit. The peeled ref has to win, and only the
      // tag namespace has one (#597 resolved this on the GitHub path; this is
      // the same fact on the smart-HTTP path).
      if (namespace === 'tags') {
        const peeled = new RegExp(String.raw`([0-9a-f]{40}) refs/tags/${quoted}\^\{\}`, 'u').exec(body)
        if (peeled !== null) return peeled[1]!
      }
      const found = new RegExp(String.raw`([0-9a-f]{40}) refs/${namespace}/${quoted}(?![^\s])`, 'u').exec(body)
      if (found !== null) return found[1]!
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

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

/**
 * The npm registry update checks read, no trailing slash.
 *
 * Module state driven from the routes, like `updatesCache` beside it, rather
 * than a parameter on all five call sites: the registry is a property of the
 * running market, not of any one question asked of it, and threading it
 * through would put the same value in five signatures and every test that
 * calls them.
 */
let registryBase = 'https://registry.npmjs.org'

/**
 * Point update checks at a registry. Called when the download region
 * resolves and whenever it changes.
 *
 * Dropping the cache is the load-bearing half. A mirror can lag the official
 * registry by minutes, so answers gathered from one are not answers from the
 * other — keeping them across a switch would report a version this registry
 * cannot yet serve.
 */
export function setUpdateRegistry(base: string): void {
  const next = base.replace(/\/+$/, '')
  if (next === registryBase) return
  registryBase = next
  updatesCache = null
}

/** A registry URL for `path`, on whichever registry is currently in force. */
function npmUrl(path: string): string {
  return `${registryBase}/${path}`
}

type ReleaseAgeExclusions = { exemptPackage: boolean; exemptVersions: Set<string> }
type ReleaseAgePolicyRead =
  | { kind: 'supported'; exclusions: ReleaseAgeExclusions }
  | { kind: 'unknown' }

/** Read observable profile policy; do not infer effective external settings. */
function readReleaseAgeExclusions(dir: string, name: string): ReleaseAgePolicyRead {
  const unknown = { kind: 'unknown' } as const
  // The Desktop manager owns the pnpm process/environment. An effective setting
  // outside the profile cannot be inferred from workspace files.
  const nativeTransitiveSetting = (key: string, value: string | undefined): boolean => {
    const normalized = key.replace(/[-_]/g, '').toLowerCase()
    return (normalized === 'minimumreleaseagestrict' || normalized === 'minimumreleaseageignoremissingtime')
      && /^(?:true|false)$/i.test(value?.trim() ?? '')
  }
  for (const [key, value] of Object.entries(process.env)) {
    const setting = /(?:^|_)(minimum[-_]?release[-_]?age[\w-]*)/i.exec(key)
    if (setting !== null && !nativeTransitiveSetting(setting[1]!, value)) return unknown
  }
  let source: string
  try { source = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') source = ''
    else return unknown
  }
  let npmrc: string
  try { npmrc = readFileSync(join(dir, '.npmrc'), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') npmrc = ''
    else return unknown
  }
  // Security settings in .npmrc may have independent precedence and spelling;
  // never guess which value the official Desktop's pnpm will actually use.
  for (const setting of npmrc.matchAll(/^\s*(minimum[-_]?release[-_]?age[^\s=]*)\s*=([^\r\n]*)/gmi)) {
    if (!nativeTransitiveSetting(setting[1]!, setting[2])) return unknown
  }
  let doc: unknown
  try { doc = load(source, { schema: JSON_SCHEMA }) } catch { return unknown }
  if (doc === null || doc === undefined) doc = {}
  if (typeof doc !== 'object' || Array.isArray(doc)) return unknown
  const policy = doc as Record<string, unknown>
  if (policy.minimumReleaseAgeStrict !== undefined && typeof policy.minimumReleaseAgeStrict !== 'boolean') return unknown
  if (policy.minimumReleaseAgeIgnoreMissingTime !== undefined && typeof policy.minimumReleaseAgeIgnoreMissingTime !== 'boolean') return unknown
  // #991 approved: verify the selected top-level timestamp ourselves. Native
  // pnpm owns transitive resolution, missing-time handling and persisted
  // exemptions, including under its implicit/default non-strict policy.
  const entries = policy.minimumReleaseAgeExclude
  if (entries === undefined) return { kind: 'supported', exclusions: { exemptPackage: false, exemptVersions: new Set() } }
  if (!Array.isArray(entries) || !entries.every(value => typeof value === 'string')) return unknown
  // pnpm 11 evaluates rules in order and stops at the FIRST name match, even
  // when its version union does not contain the version being installed.
  let matched = false
  let selected: { exemptPackage: boolean; exemptVersions: Set<string> } = { exemptPackage: false, exemptVersions: new Set() }
  for (const entry of entries as string[]) {
    const at = entry.indexOf('@', entry.startsWith('@') ? 1 : 0)
    const packageName = at < 0 ? entry : entry.slice(0, at)
    const scopeWildcard = /^@[A-Za-z0-9._~-]+\/\*$/.test(packageName)
    if (!scopeWildcard && !/^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/.test(packageName)) return unknown
    if (scopeWildcard && at >= 0) return unknown // pnpm forbids wildcard names with version unions.
    const applies = scopeWildcard ? name.startsWith(packageName.slice(0, -1)) : packageName === name
    if (at < 0) {
      if (applies && !matched) { selected = { exemptPackage: true, exemptVersions: new Set() }; matched = true }
      continue
    }
    const selectors = entry.slice(at + 1).split(/[ \t]*\|\|[ \t]*/)
    if (selectors.some(version => !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version))) return unknown
    if (applies && !matched) { selected = { exemptPackage: false, exemptVersions: new Set(selectors) }; matched = true }
  }
  return { kind: 'supported', exclusions: selected }
}

export interface DesktopMatureResult {
  candidate: string | null
  latest: string | null
  heldUpdate?: { latest: string; until: string; estimated?: true }
  nextMaturityAt: number | null
  reason: string
}

/** Shared fresh registry/policy verification for listing and locked execution. */
export async function resolveDesktopMatureUpdate(name: string, installed: string | null, profile: string, activeProfileDir: string, endpointLatest: string | null, maxVersion?: string): Promise<DesktopMatureResult> {
  const now = Date.now()
  const empty = (reason: string): DesktopMatureResult => ({ candidate: null, latest: endpointLatest, reason, nextMaturityAt: null })
  const windowMs = readMinimumReleaseAgeMs(profile, activeProfileDir)
  const policy = readReleaseAgeExclusions(activeProfileDir, name)
  const uncertain = (reason: string): DesktopMatureResult => ({
    ...empty(reason),
    ...(isUpgrade(installed, endpointLatest) ? { heldUpdate: {
      latest: endpointLatest!, until: new Date(now + UNKNOWN_PUBLISH_HOLD_MS).toISOString(), estimated: true as const,
    } } : {}),
  })
  // A missing /latest answer provides no independent registry identity check.
  if (endpointLatest === null) return uncertain('latest-unavailable')
  if (windowMs === null || policy.kind === 'unknown') return uncertain('policy-unknown')
  let selection: MatureUpdateSelection | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const suffix = attempt === 0 ? '' : `?t=${String(Date.now())}`
      const packument = (await fetchJson(npmUrl(`${encodeURIComponent(name)}${suffix}`))) as NpmPackument
      selection = selectMatureUpdate(packument, installed, now, {
        minimumReleaseAgeMs: windowMs,
        latestFromEndpoint: endpointLatest,
        ...(maxVersion === undefined ? {} : { maxVersion }),
        ...policy.exclusions,
      })
      if (selection.reason !== 'inconsistent' && !(selection.held !== null && selection.latestMaturityAt === null)) break
    } catch { /* Retry once against a potentially stale mirror. */ }
  }
  if (selection === null) return uncertain('registry-unavailable')
  if (selection.reason === 'inconsistent') return uncertain('inconsistent')
  const held = selection.held
  const until = selection.latestMaturityAt
  return {
    candidate: selection.candidate, latest: selection.latest, reason: selection.reason,
    nextMaturityAt: selection.nextMaturityAt,
    ...(held === null ? {} : { heldUpdate: {
      latest: held,
      until: new Date(until !== null && until > now ? until : now + UNKNOWN_PUBLISH_HOLD_MS).toISOString(),
      ...(until === null || until <= now ? { estimated: true as const } : {}),
    } }),
  }
}

async function fetchJson(url: string): Promise<unknown> {
  // Through the proxy when one is configured: Node's global fetch ignores
  // HTTP_PROXY, so on a machine whose route out is a local proxy every
  // update check silently took the slow path — or none at all.
  const res = await marketFetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-market' },
    signal: AbortSignal.timeout(10_000),
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
    const doc = (await fetchJson(npmUrl(`${encodeURIComponent(name)}`))) as {
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

/**
 * When a specific version was published, from the packument's own time map
 * (#945). Null when the registry cannot answer — callers must not claim a
 * wait on null.
 */
/**
 * How long a hold stands when the registry cannot say when a version was
 * published. Bounded rather than the full window: the usual cause is a mirror
 * that has served the new `/latest` but not yet the packument entry (#961,
 * #927 measured 14 minutes, #961 observed 27), and by the next poll the real
 * timestamp is there and the hold is recomputed from it. A registry that never
 * ships a time map keeps holding — the safe direction, and the one the market
 * chose after #945.
 */
const UNKNOWN_PUBLISH_HOLD_MS = 30 * 60 * 1000

type PublishAge = { kind: 'at'; at: number } | { kind: 'unknown' }

/**
 * When a version was published, retried once when the packument does not say.
 *
 * A missing `time[version]` is NOT evidence that the release is old — on a
 * mirror mid-sync it is the opposite: `/latest` already answers the new
 * version while the full document still lags (#961). The second attempt asks
 * with a cache-buster because the first answer is exactly what a warm edge
 * cache serves.
 */
async function npmPublishAge(name: string, version: string): Promise<PublishAge> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const query = attempt === 0 ? '' : `?t=${String(Date.now())}`
      const doc = (await fetchJson(npmUrl(`${encodeURIComponent(name)}${query}`))) as {
        time?: Record<string, string>
      }
      const published = doc.time?.[version]
      if (published !== undefined) {
        const at = Date.parse(published)
        return Number.isFinite(at) ? { kind: 'at', at } : { kind: 'unknown' }
      }
    } catch { /* retry once below */ }
  }
  return { kind: 'unknown' }
}

/** The registry's current `latest` version for a package, or null when it can't be read. */
/**
 * The version a channel subscriber should be offered: the newest build in
 * the set that channel is willing to receive.
 *
 * A channel is a SET, not a tag. Someone on beta has not stopped accepting
 * releases — they accept releases and prereleases — so beta means
 * {latest, beta} and dev means {latest, beta, dev}. Reading it as one tag
 * gets a real case wrong: once 1.14.0 ships, `beta` still points at
 * 1.14.0-beta.1 until the next prerelease is cut, and following that tag
 * literally would walk a subscriber BACKWARDS onto a build their channel
 * has already moved past.
 *
 * The nesting is also what makes a channel leavable. Going backwards is
 * only ever offered when the user narrows the set — picking stable while a
 * prerelease is installed drops `beta` out of it, so the answer becomes
 * `latest` and the market can finally offer the way back. That case used to
 * be unreachable: comparing 1.13.1 against an installed 1.14.0-beta.1 found
 * nothing newer and answered "up to date", so the control the user had just
 * used appeared to do nothing.
 *
 * @param stable - the `latest` version, already fetched by the caller.
 */
export async function versionOnChannel(
  name: string,
  channel: Channel,
  stable: string | null,
): Promise<string | null> {
  let best = stable
  for (const tag of EXTRA_TAGS[channel]) {
    const candidate = await tagVersion(name, tag)
    if (candidate !== null && (best === null || isUpgrade(best, candidate))) best = candidate
  }
  return best
}

/** Tags a channel adds on top of `latest`, widest channel last. */
const EXTRA_TAGS: Record<Channel, string[]> = {
  stable: [],
  beta: [DIST_TAG.beta],
  dev: [DIST_TAG.beta, DIST_TAG.dev],
}

/** One dist-tag's version, or null when it isn't published or can't be read. */
async function tagVersion(name: string, tag: string): Promise<string | null> {
  try {
    const meta = (await fetchJson(npmUrl(`${encodeURIComponent(name)}/${tag}`))) as { version?: string }
    return typeof meta.version === 'string' ? meta.version : null
  } catch {
    // An unpublished tag is the ordinary case for a channel nobody has cut
    // a build on yet, and a registry hiccup must not take the whole update
    // check down with it.
    return null
  }
}

export async function fetchNpmLatest(name: string): Promise<string | null> {
  try {
    const meta = (await fetchJson(npmUrl(`${encodeURIComponent(name)}/latest`))) as { version?: string }
    if (typeof meta.version === 'string') return meta.version
  } catch {
    // Fall through to the full packument (#932).
  }
  // #932: the `/latest` shortcut can fail on its own — measured HTTP 429 from
  // registry.npmjs.org while the full packument answered 200 with the same
  // dist-tag. Returning null there made a fresh install fall back to the bare
  // name, and pnpm's fresh-release hold then installed an OLDER version than
  // the catalog and the confirmation screen had just shown. The packument is
  // a bigger read, so it is only asked when the shortcut failed.
  try {
    const doc = (await fetchJson(npmUrl(encodeURIComponent(name)))) as { 'dist-tags'?: { latest?: unknown } }
    const latest = doc['dist-tags']?.latest
    return typeof latest === 'string' ? latest : null
  } catch {
    return null
  }
}

/**
 * Tags a package may publish a prerelease line under, in no order — the
 * versions decide. DSH's own packages use `next` and `alpha`; `beta` and
 * `canary` are the other two conventions in the wild. Short on purpose:
 * every tag that does not exist costs one 404.
 */
const PRERELEASE_TAGS = ['next', 'alpha', 'beta', 'canary'] as const

/**
 * The newest build above `installed` that some tag other than `latest`
 * points at, or null (#867).
 *
 * A fact about the registry, not a channel decision: this is what makes the
 * difference visible to someone whose installed pin is ahead of `latest`
 * without the market volunteering anyone's prerelease as an update.
 */
export async function newerPrereleaseFor(name: string, installed: string | null): Promise<string | null> {
  if (installed === null) return null
  const versions = await Promise.all(PRERELEASE_TAGS.map(async tag => {
    try {
      const meta = (await fetchJson(npmUrl(`${encodeURIComponent(name)}/${tag}`))) as { version?: string }
      return typeof meta.version === 'string' ? meta.version : null
    } catch {
      return null
    }
  }))
  let best: string | null = null
  for (const version of versions) {
    if (version === null || !isUpgrade(installed, version)) continue
    if (best === null || isUpgrade(best, version)) best = version
  }
  return best
}

/** How long one raw-file route may take before the next candidate is tried. */
const RAW_VERSION_TIMEOUT_MS = 6_000

/**
 * The GitHub repo a spec installs from, plus the subpath whose `package.json`
 * describes the installed package (#824), or null when the spec is not a
 * GitHub one.
 *
 * Only GitHub gets its version read over the network: `raw.githubusercontent.com`
 * is the raw spelling this market already speaks (a plugin page's README, a
 * restore's manifest) and the only one with a per-region escape route. A
 * gitlab or gitee install keeps the commit comparison, because inventing
 * another host's raw URL would buy a failed request instead of a verdict.
 */
function githubRawTargetOf(spec: string): { repo: string; subpath: string | null } | null {
  // `github:owner/repo` and `git+https://github.com/…` — the spelling the
  // market itself writes for a floating install, which is the #824 case —
  // both answer here, as does the codeload archive URL older regional
  // installs carry. GitHub matches owner/repo case-insensitively, so the
  // normalized casing is safe in a raw URL.
  const repo = parseGitHubRemote(spec)?.repo.toLowerCase()
    ?? repoOfTarget(spec)?.split('#')[0]
    ?? null
  if (repo === null) return null
  const hash = spec.indexOf('#')
  const match = hash === -1 ? null : /(?:^|&)path:\/([^&\s]+)/.exec(spec.slice(hash + 1))
  return { repo, subpath: match === null ? null : match[1]! }
}

/**
 * The `version` the repository publishes at the head of its default branch,
 * or null when it cannot be read (#824).
 *
 * Route handling mirrors `resolveHeadCommit`: the region's candidates in
 * order, the last verified winner first, and that winner remembered for the
 * next check. Every failure — no candidate answers, a repo with no
 * `package.json`, a body that is not JSON — is null, so the caller falls back
 * to comparing commits rather than claiming the install is current.
 */
async function remoteGitVersion(spec: string, region: Region): Promise<string | null> {
  const target = githubRawTargetOf(spec)
  if (target === null) return null
  const file = target.subpath === null ? 'package.json' : `${target.subpath}/package.json`
  const url = `https://raw.githubusercontent.com/${target.repo}/HEAD/${file}`
  for (const route of githubRoutesFor('raw', region)) {
    try {
      const res = await marketFetch(throughProxy(route, url), {
        headers: { accept: 'application/json', 'user-agent': 'dsh-market' },
        signal: AbortSignal.timeout(RAW_VERSION_TIMEOUT_MS),
      })
      if (!res.ok) continue
      const doc = await res.json() as { version?: unknown }
      const version = typeof doc.version === 'string' ? doc.version.trim() : ''
      if (version === '') continue
      rememberGithubRoute('raw', route)
      return version
    } catch {
      // This route did not answer; the next candidate may.
    }
  }
  return null
}

/**
 * Whether the repository's own `version` says there is something to install,
 * for a git install that follows whatever the default branch points at (#824).
 *
 * A floating git install has no release boundary: every commit the branch
 * gains makes the commit comparison unequal, so the row advertised "有新版本"
 * forever while pnpm would install the same version the plugin's own updater
 * had already put on disk. That is the mirror image of #446/#597 — those
 * compared commits against a ref the user never chose; this one degrades the
 * ref the user did choose, where "the line moved" is not the same question as
 * "there is something new to install".
 *
 * @returns true/false when both versions are readable and comparable, and
 *   null when the question cannot be answered that way: no installed version,
 *   a spec that names a branch or tag on purpose (that line IS the user's
 *   choice), a non-GitHub host, an unreachable raw file, or a version on
 *   either side that is not semver. On null the caller must compare commits —
 *   never read null as "current", or a private host would stop reporting
 *   updates altogether.
 */
async function gitVersionUpdate(
  spec: string,
  installedVersion: string | null,
  region: Region,
): Promise<boolean | null> {
  if (installedVersion === null) return null
  // `#branch`, `#tag`, and `#semver:` installs chose a line of their own: a
  // new commit on it is exactly what those users asked to hear about (#446).
  // `refOfFragment` skips `semver:` ranges (they compare against the default
  // branch), so they need their own probe — otherwise a range pinned at ^2
  // with a 3.0.0 at HEAD would advertise an install the range cannot produce.
  const explicitRef = spec.startsWith('github:') ? githubRefOfTarget(spec) : gitRefOfTarget(spec)
  if (explicitRef !== null || hasSemverSelector(spec)) return null
  const remoteVersion = await remoteGitVersion(spec, region)
  if (remoteVersion === null) return null
  const compared = compareVersions(remoteVersion, installedVersion)
  return compared === null ? null : compared > 0
}

/**
 * A held update whose window has passed is available again. The cache lives
 * 30 minutes; without this a user would watch "in about 1 hour" sit there
 * after the hour ended, and could not update until the TTL happened to turn
 * over. Pure: returns the same map when nothing expired.
 */
/**
 * When the profile's fresh-release wait ends for `latest`, or null when the
 * release is old enough to install now (or the registry cannot say).
 */
type ReleaseAgeHold = { until: string; estimated: boolean } | 'past' | null

async function releaseAgeHold(name: string, latest: string | null, profile: string, activeProfileDir: string): Promise<ReleaseAgeHold> {
  if (latest === null) return null
  const windowMs = readMinimumReleaseAgeMs(profile, activeProfileDir)
  if (windowMs === null) return null
  const age = await npmPublishAge(name, latest)
  if (age.kind === 'unknown') {
    // Fail CLOSED (#961). Returning null here meant "no wait needed", so a
    // mirror that had not synced its packument yet let a 13-minute-old release
    // through the gate #945 built — and on the official Desktop there is no
    // bypass to fall back on, so the click could only fail.
    return { until: new Date(Date.now() + UNKNOWN_PUBLISH_HOLD_MS).toISOString(), estimated: true }
  }
  const until = age.at + windowMs
  return until > Date.now() ? { until: new Date(until).toISOString(), estimated: false } : 'past'
}

/** A hold expiration invalidates evidence; it cannot itself authorize an install. */
function nextHoldRecheck(data: Record<string, UpdateStatus>): number {
  return Math.min(...Object.values(data).flatMap(status => status.heldUpdate === undefined ? [] : [Date.parse(status.heldUpdate.until)]))
}

function profilePolicyFingerprint(dir: string): string {
  const hash = createHash('sha256')
  for (const filename of ['pnpm-workspace.yaml', '.npmrc', 'package.json']) {
    hash.update(filename)
    try { hash.update(readFileSync(join(dir, filename))) } catch { hash.update('unavailable') }
  }
  // Otherwise an environment override appearing between refreshes could reuse
  // a formerly eligible target from the 30-minute update cache.
  for (const [key, value] of Object.entries(process.env).filter(([key]) => /(?:^|_)minimum[-_]?release[-_]?age/i.test(key)).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(key)
    hash.update(value ?? '')
  }
  return hash.digest('hex')
}

/** Per-plugin update checks; a failed check reports no update rather than failing the listing. */
export async function checkUpdates(
  profile: string,
  force = false,
  explicitDir?: string,
  /**
   * Packages that follow a release channel instead of plain `latest`. Only
   * ever the market itself: opting into early builds is volunteering to try
   * THIS plugin early, not a licence to pull every other author's
   * unreleased work.
   */
  channelFor: ReadonlyMap<string, Channel> = new Map(),
  /**
   * Curated npm sources for the installs that carry no registry spec of
   * their own: `file:` packages matched to the market catalog (#429) and
   * the generations the desktop host links in (#497). Any other `link:` is
   * a development workspace and is never opted into online updates.
   */
  onlineSourceFor: ReadonlyMap<string, string> = new Map(),
  /**
   * Registry names an archive-URL install may be checked against, keyed by
   * the GitHub repo (`owner/repo`) the archive came from (#768). Without an
   * entry that owns both the repo and the name, the npm fallback would
   * compare the install with whatever package merely shares its name.
   */
  catalogNpmByRepo: ReadonlyMap<string, string> = new Map(),
  /**
   * Hold back releases that this profile's `minimumReleaseAge` will refuse
   * (#945). Only true where the install path has no bypass: the official
   * Desktop's manager takes no pnpm options, while the CLI path retries once
   * with `--config.minimum-release-age=0` and CAN install a young release.
   * Hiding those on the CLI would suppress updates that work.
   */
  options: { holdYoungReleases?: boolean } = {},
): Promise<Record<string, UpdateStatus>> {
  const activeProfileDir = profileDir(profile, explicitDir)
  // The channel is part of the key: switching to betas has to change the
  // answer immediately, and a cache keyed on the profile alone would serve
  // the stable verdict for the rest of the TTL — reading as "the setting did
  // nothing".
  const cacheKey = `${activeProfileDir}\u0000${options.holdYoungReleases === true ? 'hold' : 'any'}\u0000${[...channelFor].map(([n, c]) => `${n}:${c}`).sort().join(',')}\u0000${[...onlineSourceFor].map(([n, s]) => `${n}:${s}`).sort().join(',')}\u0000${[...catalogNpmByRepo].map(([n, s]) => `${n}:${s}`).sort().join(',')}\u0000${options.holdYoungReleases === true ? profilePolicyFingerprint(activeProfileDir) : ''}`
  if (!force && updatesCache?.key === cacheKey && Date.now() < updatesCache.recheckAt) {
    return updatesCache.data
  }
  const installed = readInstalled(profile, activeProfileDir)
  const lockCommits = readLockCommits(profile, activeProfileDir)
  const result: Record<string, UpdateStatus> = {}
  let nextCandidateMaturityAt = Infinity
  await Promise.all(Object.entries(installed).map(async ([name, spec]) => {
    const version = readInstalledVersion(profile, name, activeProfileDir)
    const normalizedSpec = spec.toLowerCase()
    if (normalizedSpec.startsWith('file:')) {
      const onlineSource = onlineSourceFor.get(name)
      if (onlineSource !== undefined) {
        const latest = await fetchNpmLatest(onlineSource)
        const upgrade = isUpgrade(version, latest)
        const hold = upgrade && options.holdYoungReleases === true
          ? await releaseAgeHold(onlineSource, latest, profile, activeProfileDir)
          : null
        const held = hold !== null && hold !== 'past'
        result[name] = {
          kind: 'linked', version, current: version, latest,
          updateAvailable: upgrade && !held,
          ...(held ? { heldUpdate: { latest: latest!, until: hold.until, ...(hold.estimated ? { estimated: true as const } : {}) } } : {}),
          ...(upgrade ? { restoreRequired: true } : {}),
        }
        return
      }
      result[name] = { kind: 'linked', version, current: null, latest: null, updateAvailable: false }
      return
    }
    if (normalizedSpec.startsWith('link:')) {
      if (isGenerationLink(spec)) {
        // The desktop host's production install, not a checkout (#497): it
        // came from the registry and has a release history to compare
        // against. Reported, never offered — the host reconciles `live/`
        // against its own desired.json at startup, so an update applied
        // here would appear to work and silently revert on the next boot.
        // Only a release that is actually newer is named; current and
        // unknown both read as null, so a lagging `latest` tag (#64) can't
        // advertise a downgrade either.
        const onlineSource = onlineSourceFor.get(name)
        const stable = onlineSource === undefined ? null : await fetchNpmLatest(onlineSource)
        const channel = channelFor.get(name)
        const newest = channel === undefined || onlineSource === undefined
          ? stable
          : await versionOnChannel(onlineSource, channel, stable)
        result[name] = {
          kind: 'generation', version, current: version,
          latest: isUpgrade(version, newest) ? newest : null,
          updateAvailable: false,
        }
        return
      }
      result[name] = { kind: 'linked', version, current: null, latest: null, updateAvailable: false }
      return
    }
    // The repo behind the spec, in every supported spelling. Older regional
    // installs can carry a proxied codeload URL rather than a `github:`
    // shortcut, and asking only about the shortcut sent those through the npm
    // branch below — where a GitHub-only plugin
    // either 404s or, far worse, matches an unrelated package that happens
    // to share its name.
    const repo = repoOfTarget(spec)?.split('#')[0] ?? null
    try {
      if (repo !== null) {
        // A proxied legacy URL or exact `github:#sha` carries its pin in the
        // spec; a mutable `github:` shortcut keeps it in the lockfile. Prefer
        // the spec because it is authoritative even if the lockfile is stale.
        const current = githubCommitOfTarget(spec) ?? lockCommits.get(`github.com/${repo}`) ?? null
        // git's own ref advertisement, NOT api.github.com/repos/…/commits.
        // The REST API allows 60 requests an hour per IP unauthenticated,
        // shared across every plugin AND every check — a handful of
        // github-installed plugins exhausts it and the whole list silently
        // stops reporting updates (#349). The ref endpoint git itself uses
        // has no such quota; this is the same call `acceleratedTarget`
        // already makes to resolve a commit for the China region.
        // Ask about the ref the install actually names. Answering with the
        // default branch for a `#branch` install compares two lines that
        // never converge, so the row reported an update forever (#446).
        const latest = await resolveHeadCommit(
          repo, activeRegion(), process.env, githubRefOfTarget(spec) ?? undefined,
        )
        // A floating install has no release boundary: the commit comparison
        // alone advertised "有新版本" forever on a branch that moved without
        // publishing (#824). The repository's own version decides when both
        // sides are readable; commits decide everything else.
        const byVersion = await gitVersionUpdate(spec, version, activeRegion())
        result[name] = {
          kind: 'github', version, current, latest,
          updateAvailable: byVersion ?? (current !== null && latest !== null && current !== latest),
          ...(byVersion === false && current !== null && latest !== null && current !== latest
            ? { unreleasedCommit: latest } : {}),
        }
      } else if (isGitHostedSpec(spec)) {
        // Private / self-hosted git (Gitea, GitLab, raw git+https). Never ask
        // npm by package name — a colliding registry package would be offered
        // as an update and then installed over the git source (#525).
        // Reuse kind `github` as "git-sourced" so the existing Installed UI
        // keeps treating the row as a VCS install without a client change.
        // Three readings, because pnpm records a git install in three
        // different ways: the spec's own pin, a `type: git` resolution for a
        // cloned remote, and — for the hosts that serve an archive tarball —
        // the commit inside that tarball's URL (#637).
        const archiveKey = hostedRepoKey(spec)
        const current = gitCommitOfTarget(spec)
          ?? readGitResolutionCommit(profile, spec, activeProfileDir)
          ?? (archiveKey === null ? null : lockCommits.get(archiveKey) ?? null)
        // Ask about the ref the install actually names, exactly as the
        // github branch above does (#446).
        const latest = await resolveGitRemoteHead(spec, gitRefOfTarget(spec) ?? undefined)
        // Same rule as the github branch above (#824): the repository's own
        // version decides when both sides are readable, commits otherwise.
        const byVersion = await gitVersionUpdate(spec, version, activeRegion())
        result[name] = {
          kind: 'github', version, current, latest,
          updateAvailable: byVersion ?? (current !== null && latest !== null && current !== latest),
          ...(byVersion === false && current !== null && latest !== null && current !== latest
            ? { unreleasedCommit: latest } : {}),
        }
      } else {
        // A URL install (release archive, self-hosted tarball) has no
        // registry identity of its own. Checking npm by name alone pairs it
        // with whatever package shares that name (#768), so only proceed
        // when a catalog entry owns both the repo the archive came from and
        // this name; otherwise report no update rather than a false one.
        if (/^https?:/i.test(spec)) {
          const repo = lookupRepoFromUrl(spec)
          const repoKey = repo === null ? null : catalogRepoKey(repo)
          if (repoKey === null || catalogNpmByRepo.get(repoKey) !== name) {
            result[name] = { kind: 'npm', version, current: version, latest: null, updateAvailable: false }
            return
          }
        }
        const meta = (await fetchJson(npmUrl(`${encodeURIComponent(name)}/latest`))) as { version?: string }
        const stable = typeof meta.version === 'string' ? meta.version : null
        const channel = channelFor.get(name)
        const latest = channel === undefined ? stable : await versionOnChannel(name, channel, stable)
        // Forwards is an update; a difference in the other direction is a
        // channel switch and is reported as one, under its own field.
        const upgrade = isUpgrade(version, latest)
        const sideways = channel !== undefined && !upgrade
          && version !== null && latest !== null && version !== latest
        // Only asked when the answer could differ from "up to date": a pin
        // that carries a prerelease tag, or one sitting ABOVE `latest` — the
        // two shapes that mean the user is on a line `latest` does not name.
        // Everything else keeps paying nothing for a field it cannot use.
        const mayFollowATag = !upgrade
          && (version?.includes('-') === true || (stable !== null && version !== null && isUpgrade(stable, version) === false && stable !== version))
        const newerPrerelease = mayFollowATag ? await newerPrereleaseFor(name, version) : null
        const desktopStable = options.holdYoungReleases === true && channel === undefined
          && isStableReleaseVersion(version)
          && !/^https?:/i.test(spec) && !spec.includes(':') && !spec.includes('/')
        const mature = desktopStable && upgrade
          ? await resolveDesktopMatureUpdate(name, version, profile, activeProfileDir, stable)
          : null
        if (mature?.nextMaturityAt !== null && mature?.nextMaturityAt !== undefined) {
          nextCandidateMaturityAt = Math.min(nextCandidateMaturityAt, mature.nextMaturityAt)
        }
        const hold = mature === null && upgrade && options.holdYoungReleases === true
          ? await releaseAgeHold(name, latest, profile, activeProfileDir) : null
        const held = mature?.heldUpdate !== undefined || (hold !== null && hold !== 'past')
        result[name] = {
          kind: 'npm', version, current: version, latest,
          updateAvailable: mature === null ? upgrade && !held : mature.candidate !== null,
          ...(mature?.candidate !== null && mature?.candidate !== undefined ? { eligibleVersion: mature.candidate } : {}),
          ...(mature?.heldUpdate !== undefined ? { heldUpdate: mature.heldUpdate }
            : hold !== null && hold !== 'past' ? { heldUpdate: { latest: latest!, until: hold.until, ...(hold.estimated ? { estimated: true as const } : {}) } } : {}),
          ...(newerPrerelease === null ? {} : { newerPrerelease }),
          ...(sideways ? { channelSwitch: latest } : {}),
        }
      }
    } catch {
      result[name] = { kind: (spec.startsWith('github:') || isGitHostedSpec(spec)) ? 'github' : 'npm', version, current: null, latest: null, updateAvailable: false }
    }
  }))
  // A plain dependency can have a newer release; it is just not an update the
  // market can apply (#793). Judged once, after every branch above has said
  // what it found, so no source kind (npm, github, git host) can slip past.
  const composed = new Set(readProfileBundles(activeProfileDir))
  for (const [name, status] of Object.entries(result)) {
    if (status.updateAvailable !== true || isUpdatablePlugin(activeProfileDir, name, composed)) continue
    result[name] = { ...status, updateAvailable: false, notAPlugin: true }
  }
  const now = Date.now()
  updatesCache = { key: cacheKey, at: now, recheckAt: Math.min(now + UPDATES_TTL_MS, nextHoldRecheck(result), nextCandidateMaturityAt), data: result }
  return result
}
