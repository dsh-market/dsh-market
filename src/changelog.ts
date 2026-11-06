/**
 * Update notes: what changed between an installed version and HEAD.
 *
 * Every byte of GitHub data comes from the catalog side's daily probe,
 * published as the `dsh-plugin-updates` package (origin fallback
 * `updates.json` beside `plugins.json`). The market asks GitHub for nothing:
 * anonymous REST quota is shared per egress IP and already unreliable behind
 * common proxies, and this data is wanted by thousands of markets but
 * produced perfectly well once a day by one probe.
 *
 * What the catalog cannot know is where each user's installed version sits,
 * so slicing the commit tail at that boundary happens here: the same sha the
 * update check resolved (`current`) marks where "new" begins. A tail that
 * does not contain it means the range is wider than the tail — those are
 * labelled recent commits rather than pretending to be an exact interval.
 * npm installs with neither notes nor commits fall back to npm publish times,
 * and a plugin nothing answers for gets a neutral "no notes" — absence of
 * release notes is the ordinary condition of small plugins, not a defect.
 * A plugin installed from any other source the notes hold nothing for gets
 * `source` instead: its history is where it came from, and the market says
 * it has none on hand rather than that the plugin publishes none (#819).
 */

import { absoluteTarballUrl, fileFromTarball } from './catalog-npm.ts'
import { marketFetch } from './net.ts'
import { activeRegion, routesFor } from './regions.ts'
import { profileDir, readGitResolutionCommit, readInstalled, readInstalledRepoEvidence, readInstalledVersion, readLockCommits } from './profile.ts'
import { githubRepoOfRemote, hostedRepoKey, isGitHostedSpec, lookupRepoFromUrl, parseHostShorthand, parseSourceUrl, repoOf, repoOfTarget } from './sources.ts'
import { checkUpdates, compareVersions } from './updates.ts'
import { loadRegistry, type RegistryPlugin } from './registry.ts'

const UPDATES_PACKAGE = 'dsh-plugin-updates'
const UPDATES_FILE = 'package/updates.json'
/** The origin copy sits beside plugins.json on the catalog host. */
const ORIGIN_UPDATES = process.env.DSHM_UPDATES_ORIGIN ?? 'https://awesome-dsh-plugin.com/updates.json'
/** Notes are produced daily; re-checking hourly bounds staleness without churn. */
const NOTES_TTL_MS = 60 * 60 * 1000
const TIMEOUT_MS = 15_000

export interface ReleaseNotes {
  tag: string | null
  name: string | null
  publishedAt: string | null
  url: string | null
  body: string
}

export interface CommitNote {
  sha: string
  message: string
  date: string | null
}

interface UpdatesEntry {
  release?: ReleaseNotes | null
  commits?: CommitNote[]
}

interface UpdatesPayload {
  count?: number
  updates?: Record<string, UpdatesEntry>
}

let notesCache: { at: number; data: UpdatesPayload } | null = null

/**
 * The update-notes payload from whichever route the region serves.
 *
 * Same source order as the catalog itself — the npm package first where one
 * exists (its mirror reach is the reason the package exists), then the
 * origin. Version-keyed like the catalog too: an unchanged payload costs one
 * packument read per TTL, not a tarball.
 */
export async function loadUpdateNotes(force = false): Promise<UpdatesPayload> {
  if (!force && notesCache !== null && Date.now() - notesCache.at < NOTES_TTL_MS) {
    return notesCache.data
  }
  const routes = routesFor(activeRegion())
  const attempt = async (): Promise<UpdatesPayload> => {
    // The npm package, on the region's registry — mirrors rewrite dist.tarball
    // to themselves, so following that field keeps the download local.
    const metaRes = await marketFetch(`${routes.npmRegistry}/${encodeURIComponent(UPDATES_PACKAGE)}/latest`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json', 'user-agent': 'dsh-market' },
    })
    if (!metaRes.ok) throw new Error(`HTTP ${String(metaRes.status)} reading ${UPDATES_PACKAGE} metadata`)
    const meta = await metaRes.json() as { dist?: { tarball?: unknown } }
    const tarball = typeof meta.dist?.tarball === 'string' ? meta.dist.tarball : null
    if (tarball === null) throw new Error(`${UPDATES_PACKAGE} names no tarball`)
    // A registry under a path prefix may answer with a relative tarball, the
    // same case the catalog route resolves (#1117).
    const tarRes = await marketFetch(absoluteTarballUrl(tarball, routes.npmRegistry), { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!tarRes.ok) throw new Error(`HTTP ${String(tarRes.status)} reading ${UPDATES_PACKAGE} tarball`)
    const bytes = fileFromTarball(Buffer.from(await tarRes.arrayBuffer()), UPDATES_FILE)
    if (bytes === null) throw new Error(`${UPDATES_PACKAGE} carries no ${UPDATES_FILE}`)
    return JSON.parse(bytes.toString('utf8')) as UpdatesPayload
  }
  const attemptOrigin = async (): Promise<UpdatesPayload> => {
    const res = await marketFetch(ORIGIN_UPDATES, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json', 'user-agent': 'dsh-market' },
    })
    if (!res.ok) throw new Error(`HTTP ${String(res.status)} reading ${ORIGIN_UPDATES}`)
    return await res.json() as UpdatesPayload
  }
  // Two independent sources, each tried twice — the same retry economics as
  // the catalog loader, for the same transient-loss reasons.
  let lastError: unknown = null
  for (const attemptFn of [attempt, attemptOrigin]) {
    for (let i = 0; i < 2; i++) {
      try {
        const data = await attemptFn()
        notesCache = { at: Date.now(), data }
        return data
      } catch (error) {
        lastError = error
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('update notes unavailable')
}

/** Drop the cached payload (nothing currently invalidates it mid-process). */
export function invalidateUpdateNotes(): void {
  notesCache = null
}

/**
 * Slice the commit tail at the installed sha.
 *
 * @returns the commits newer than `installed`, and whether the boundary was
 *   actually found — `found === false` means the range is wider than the tail
 *   (or history diverged), so callers must label the result "recent" rather
 *   than exact.
 */
export function sliceCommitsAt(items: CommitNote[], installed: string | null): { items: CommitNote[]; found: boolean } {
  if (installed === null) return { items, found: false }
  const out: CommitNote[] = []
  for (const commit of items) {
    if (commit.sha === installed) return { items: out, found: true }
    out.push(commit)
  }
  return { items: out, found: false }
}

/**
 * The version a release tag names, when it names one.
 *
 * Tags come as `v1.2.3`, `1.2.3`, `@scope/pkg@1.2.3` or `pkg-v1.2.3`; the
 * FIRST semver-shaped run is the version in all of them. A tag that names no
 * version (`nightly`) returns null, and callers must treat "unknown" as "do
 * not judge" rather than "older".
 */
export function releaseVersionOf(tag: string | null): string | null {
  if (tag === null) return null
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(tag)
  return match?.[1] ?? null
}

/** The repo url key an entry's update notes live under, or null. */
export function repoKeyOf(spec: string): string | null {
  const repo = githubIdentityOf(spec)?.split('#')[0] ?? null
  return repo === null ? null : `https://github.com/${repo}`
}

/**
 * `owner/repo[#path:/sub]`, lowercased, for a spec that installs from GitHub.
 *
 * `repoOfTarget` reads the `github:` and codeload spellings. pnpm writes a
 * GitHub install back into the manifest as `git+https://github.com/…` (#803),
 * so that spelling is read here too, subpath selector included (#819).
 */
function githubIdentityOf(spec: string): string | null {
  const direct = repoOfTarget(spec)
  if (direct !== null) return direct
  const repo = githubRepoOfRemote(spec)
  if (repo === null) return null
  const hash = spec.indexOf('#')
  const subpath = hash === -1
    ? undefined
    : /(?:^|&)path:\/*([^&]*?)\/*(?:&|$)/.exec(spec.slice(hash + 1))?.[1]
  const root = repo.toLowerCase()
  return subpath === undefined || subpath === '' ? root : `${root}#path:/${subpath.toLowerCase()}`
}

/**
 * The npm package an install spec resolves through the registry, or null when
 * it names another source — a git remote, a tarball URL, a workspace link.
 *
 * Only these may be answered with npm publish times. Asking npm about any
 * other install by its dependency name finds whatever unrelated package holds
 * that name there (#819, the same fall-through #525 closed for updates).
 */
function npmPackageOf(name: string, spec: string): string | null {
  const s = spec.trim()
  const alias = /^npm:((?:@[^/@\s]+\/)?[^@\s]+)(?:@.*)?$/i.exec(s)
  if (alias !== null) return alias[1]!
  if (isGitHostedSpec(s)) return null
  if (/^catalog:/i.test(s)) return name
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null
  return name
}

/**
 * The web page of the repository a git spec installs from, or null.
 *
 * What the dialog can point at when the market cannot read a source's notes
 * itself. The owner/repo casing is kept: not every host matches paths
 * case-insensitively the way GitHub does.
 */
export function sourceWebUrl(spec: string): string | null {
  if (!isGitHostedSpec(spec)) return null
  const shorthand = parseHostShorthand(spec)
  if (shorthand !== null) return `https://${shorthand.host}/${shorthand.path}`
  const github = repoOfTarget(spec)
  if (github !== null) return `https://github.com/${github.split('#')[0]}`
  let remote = spec.trim().replace(/^git\+/i, '')
  const scp = /^git@([^/\s:]+):(.+)$/.exec(remote)
  if (scp !== null) remote = `https://${scp[1]}/${scp[2]!.replace(/^\/+/, '')}`
  // npm also accepts the scp colon inside an ssh URL (`ssh://git@host:org/repo`),
  // which `URL` rejects as a non-numeric port.
  const sshScp = /^ssh:\/\/(?:[^@/\s]+@)?([^/\s:]+):(?!\d+(?:\/|$))(.+)$/i.exec(remote)
  if (sshScp !== null) remote = `https://${sshScp[1]}/${sshScp[2]!.replace(/^\/+/, '')}`
  let url: URL
  try {
    url = new URL(remote.split('#')[0]!)
  } catch {
    return null
  }
  const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  // A leading `~` is a user namespace on hosts such as sourcehut.
  if (path === '' || !path.split('/').every((seg, i) => /^[A-Za-z0-9_.-]+$/.test(i === 0 ? seg.replace(/^~/, '') : seg) && seg !== '.' && seg !== '..')) return null
  // An ssh/git port is the transport's, not the web server's.
  if (/^https?:$/i.test(url.protocol)) return `${url.protocol}//${url.host}/${path}`
  if (/^(?:ssh|git):$/i.test(url.protocol)) return `https://${url.hostname}/${path}`
  return null
}

/**
 * Look an entry up by its catalog url.
 *
 * The catalog keys entries by the url as listed (author's casing preserved);
 * the market resolves repos to lowercase (as every other consumer of
 * `repoOfTarget` sees them). Match case-insensitively so the two sides never
 * disagree over a capital letter.
 */
export function entryForRepo(payload: UpdatesPayload, key: string): UpdatesEntry | undefined {
  const direct = payload.updates?.[key]
  if (direct !== undefined) return direct
  const lower = key.toLowerCase()
  for (const [k, v] of Object.entries(payload.updates ?? {})) {
    if (k.toLowerCase() === lower) return v
  }
  return undefined
}

/**
 * Publish times for an npm package's recent versions, newest first.
 *
 * The last resort before "no notes": authors who ship neither releases nor
 * informative commits still usually tag versions, and "0.4.0 landed three
 * days ago" beats nothing. Reads the full packument once and caches it —
 * the doc is heavy, and a user may open the dialog twice.
 */
const timesCache = new Map<string, { at: number; data: { version: string; date: string }[] }>()
const TIMES_TTL_MS = 30 * 60 * 1000

export async function npmPublishTimes(name: string): Promise<{ version: string; date: string }[]> {
  const hit = timesCache.get(name)
  if (hit !== undefined && Date.now() - hit.at < TIMES_TTL_MS) return hit.data
  const registry = routesFor(activeRegion()).npmRegistry
  const res = await marketFetch(`${registry}/${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json', 'user-agent': 'dsh-market' },
  })
  if (!res.ok) throw new Error(`HTTP ${String(res.status)} reading ${name}`)
  const doc = await res.json() as { time?: Record<string, string> }
  const time = doc.time ?? {}
  const data = Object.entries(time)
    .filter(([version]) => version !== 'created' && version !== 'modified')
    .sort(([, a], [, b]) => Date.parse(b) - Date.parse(a))
    .slice(0, 5)
    .map(([version, date]) => ({ version, date }))
  timesCache.set(name, { at: Date.now(), data })
  return data
}

/** A probe entry the dialog can actually render — an empty object is a miss. */
function usableNotes(entry: UpdatesEntry | undefined): boolean {
  if (entry === undefined) return false
  if (entry.release != null && (entry.release.body !== '' || entry.release.tag !== null)) return true
  return (entry.commits?.length ?? 0) > 0
}

/**
 * The catalog row for an npm install.
 *
 * The profile dependency key is the npm package name. The catalog `name`
 * often is not: a monorepo entry is `repo#subpath`, and a scoped package's
 * catalog name drops the scope (#746). `npm` is the identity the install
 * used, so it wins; a bare `name` match remains for entries that publish
 * under their catalog name. Several hits are disambiguated by the installed
 * repository, and an ambiguous set is left unresolved (#598).
 */
function catalogEntryForNpmInstall(
  plugins: readonly RegistryPlugin[],
  name: string,
  evidence: () => { identities: readonly string[] },
): RegistryPlugin | undefined {
  const byNpm = plugins.filter(p => p.npm === name)
  const candidates = byNpm.length > 0 ? byNpm : plugins.filter(p => p.name === name)
  if (candidates.length <= 1) return candidates[0]
  const identities = evidence().identities
  const matches = candidates.filter(p => identities.some(
    id => repoOf(p.url)?.toLowerCase() === id.split('#')[0]!.toLowerCase(),
  ))
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * The catalog row for a `github:…#path:` install.
 *
 * `repoKeyOf` keeps only the repository root, while a monorepo entry's notes
 * are stored under its `/tree/<ref>/<subpath>` url (#746). The spec's subpath
 * selects the row. Two rows with one subpath are not guessed between.
 */
function catalogEntryForGitSubpath(plugins: readonly RegistryPlugin[], spec: string): RegistryPlugin | undefined {
  const identity = githubIdentityOf(spec)
  const marker = identity?.indexOf('#path:/') ?? -1
  if (identity === null || marker === -1) return undefined
  const repo = identity.slice(0, marker)
  const subpath = identity.slice(marker + '#path:/'.length)
  const matches = plugins.filter(p => {
    const source = parseSourceUrl(p.url)
    return source?.subpath != null
      && source.repo.toLowerCase() === repo
      && source.subpath.toLowerCase() === subpath
  })
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * The catalog row for a git install from a host other than GitHub.
 *
 * Matched by repository, never by package name: the name is the one thing a
 * git install shares with unrelated packages, and a same-named row from
 * another repository would show that plugin's notes as this one's (#819).
 */
function catalogEntryForGitSource(plugins: readonly RegistryPlugin[], spec: string): RegistryPlugin | undefined {
  const repo = hostedRepoKey(spec)
  if (repo === null) return undefined
  const matches = plugins.filter(p => hostedRepoKey(p.url) === repo)
  return matches.length === 1 ? matches[0] : undefined
}

/** Everything the dialog renders for one plugin, already resolved. */
export interface UpdateNotes {
  kind: 'release' | 'commits' | 'npm' | 'source' | 'none'
  /** Present for `release`: the author's own notes for the latest release. */
  release?: ReleaseNotes
  /** Present for `commits`: the tail, sliced when the boundary was found. */
  commits?: { items: CommitNote[]; found: boolean }
  /** Present for `npm`: recent versions with their publish dates. */
  npmTimes?: { version: string; date: string }[]
  /** Present for `source`: the repository page to read changes on, or null. */
  sourceUrl?: string | null
  /**
   * Present for `source`: `missing` when the notes loaded without this
   * plugin, `unavailable` when they could not be loaded at all — a passing
   * failure, not a fact about the plugin — and `unreadable` when the source is
   * one the market can never read, so waiting will not help (#819).
   */
  reason?: 'missing' | 'unavailable' | 'unreadable'
}

/**
 * Resolve the notes for one installed plugin, or `{ kind: 'none' }`.
 *
 * Never throws: every failure along the way degrades to the next tier, the
 * same contract the issue promised — a dialog that cannot load its data shows
 * a neutral statement, not an error.
 */
export async function updateNotesFor(
  profile: string,
  explicitDir: string | undefined,
  name: string,
): Promise<UpdateNotes> {
  const activeProfileDir = profileDir(profile, explicitDir)
  const spec = readInstalled(profile, activeProfileDir)[name]
  if (spec === undefined || spec.startsWith('link:') || spec.startsWith('file:')) {
    return { kind: 'none' }
  }
  const npmName = npmPackageOf(name, spec)
  // A Release-asset spec carries the repo in the URL itself. An npm
  // version range carries nothing, so `specKey` stays null and the catalog
  // lookup below is what finds the repository.
  const specKey = repoKeyOf(spec) ?? lookupRepoFromUrl(spec)
  // The market holds no notes for this install, but its history is still
  // readable where it came from: say which, and point there.
  //
  // Notes come from the catalog's own release feed, which is built from
  // GitHub, so a gitee or self-hosted git install has no feed to find:
  // "the market has not collected this one yet" would promise something that
  // cannot happen, and the reader waits for it (#819). Those say the source
  // cannot be read instead. The url is the same either way — the repository
  // is where the answer actually is.
  const unreadableSource = githubIdentityOf(spec) === null && isGitHostedSpec(spec)
  const fromSource = (reason: 'missing' | 'unavailable'): UpdateNotes => ({
    kind: 'source',
    reason: unreadableSource ? 'unreadable' : reason,
    sourceUrl: sourceWebUrl(spec) ?? specKey,
  })
  try {
    const payload = await loadUpdateNotes()
    let key = specKey
    let entry = key === null ? undefined : entryForRepo(payload, key)
    // The catalog is how an npm install, a git install off GitHub, or a
    // `#path:` install whose notes live under a /tree/ url finds a key the
    // spec itself does not name. A root github spec already is that key.
    // Loading the catalog on a root miss would wait out its timeout to
    // answer "no notes".
    const offGithub = specKey === null && npmName === null && isGitHostedSpec(spec)
    const needsCatalog = (specKey === null && (npmName !== null || offGithub))
      || (githubIdentityOf(spec)?.includes('#path:/') ?? false)
    if (!usableNotes(entry) && needsCatalog) {
      try {
        const registry = await loadRegistry()
        const plugin = specKey !== null
          ? catalogEntryForGitSubpath(registry.plugins, spec)
          : npmName !== null
            ? catalogEntryForNpmInstall(
                registry.plugins,
                npmName,
                () => readInstalledRepoEvidence(profile, name, spec, explicitDir),
              )
            : catalogEntryForGitSource(registry.plugins, spec)
        if (plugin !== undefined) {
          const catalogEntry = entryForRepo(payload, plugin.url)
          // An empty row does not become the key. Publish times for an npm
          // install follow from `specKey` staying null, and a subpath install
          // keeps the root key so a sibling's notes are not borrowed.
          if (usableNotes(catalogEntry)) {
            key = plugin.url
            entry = catalogEntry
          }
        }
      } catch {
        // Catalog unavailable; the tiers below still answer.
      }
    }
    // Both tiers below need the installed sha for github-kind installs.
    // For Release asset URLs and catalog lookups, checkUpdates doesn't
    // recognize the spec, so we read the lockfile directly using the repo key.
    // `repoOf` drops a `/tree/<ref>/<subpath>` suffix; slicing the url at `#`
    // would look the commit up under `owner/repo/tree/...` and miss it.
    // A `git+https://github.com/…` install pnpm cloned rather than downloaded
    // is a `type: git` lock entry, not an archive URL.
    let current: string | null = null
    if (key !== null && key.startsWith('https://github.com/')) {
      const repo = (repoOf(key) ?? key.slice('https://github.com/'.length).split('#')[0]!).toLowerCase()
      current = readLockCommits(profile, activeProfileDir).get(`github.com/${repo}`)
        ?? readGitResolutionCommit(profile, spec, explicitDir)
    } else {
      const statuses = await checkUpdates(profile, false, explicitDir).catch(() => null)
      current = statuses?.[name]?.current ?? null
    }

    if (entry?.release !== undefined && entry.release !== null && (entry.release.body !== '' || entry.release.tag !== null)) {
      // The release feed is a DAILY snapshot while the update target is read
      // live from npm, so the snapshot's newest release is often the version
      // already installed (or older). Showing it next to "1.66.39 → 1.66.40"
      // describes a change the user already has (#925). When the release
      // names a version no newer than the installed one AND a better tier
      // exists, take the better tier: the commit tail is sliced at this
      // install's sha, and npm publish times are newer than the install by
      // construction. With nothing better, the stale release still beats an
      // empty dialog.
      const installed = readInstalledVersion(profile, name, activeProfileDir)
      const released = releaseVersionOf(entry.release.tag)
      const behind = installed !== null && released !== null
        && (compareVersions(released, installed) ?? 0) <= 0
      const hasCommits = (entry.commits?.length ?? 0) > 0
      if (!(behind && (hasCommits || (specKey === null && npmName !== null)))) {
        return { kind: 'release', release: entry.release }
      }
    }
    if (entry?.commits !== undefined && entry.commits.length > 0) {
      return { kind: 'commits', commits: sliceCommitsAt(entry.commits, current) }
    }
    if (specKey === null && npmName !== null) {
      // An npm install whose catalog row is missing or its probe has no
      // notes: publish times remain.
      return { kind: 'npm', npmTimes: await npmPublishTimes(npmName) }
    }
    // Every other source has its history where it came from. Only a probe
    // that ran and found nothing — releases 404 AND an empty log — means the
    // plugin really publishes nothing.
    if (entry === undefined) return fromSource('missing')
    return { kind: 'none' }
  } catch {
    return npmName === null ? fromSource('unavailable') : { kind: 'none' }
  }
}
