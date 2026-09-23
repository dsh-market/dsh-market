/**
 * Registry-source knowledge: how a curated registry entry's URL maps to an
 * installable pnpm target. Pure string logic, no I/O.
 */

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function validSubpath(subpath: string): boolean {
  if (!/^[A-Za-z0-9_./-]+$/.test(subpath)) return false
  return !subpath.split('/').some(seg => seg === '' || seg === '.' || seg === '..')
}

/** Registry tarball names must be plain npm package names, nothing fancier. */
export const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/**
 * A curated, prebuilt GitHub Release archive accepted as a pnpm target —
 * but only one belonging to `repo`, the entry's own `owner/name`.
 *
 * The binding is the whole point. `npm` gets the same treatment one branch
 * up (repo-verified, "name-squatting protection"); without it here, an entry
 * could name a trusted repo and install an archive from somewhere else:
 *
 *     url:     https://github.com/good/plugin
 *     tarball: https://github.com/evil/repo/releases/download/v1/p.tgz
 *
 * That is also why the release CDNs (`objects.githubusercontent.com`,
 * `release-assets.githubusercontent.com`) are not accepted: their paths
 * carry no owner or repo, so there is nothing to bind the archive to and no
 * way to tell whose release it is. All 70 entries carrying `tarball` today
 * use github.com and match their own repo, so nothing real is turned away.
 */
function releaseTarballTarget(value: unknown, repo: string): string | null {
  if (typeof value !== 'string') return null
  const target = value.trim()
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null
  if (!url.pathname.endsWith('.tgz') && !url.pathname.endsWith('.tar.gz')) return null
  // /{owner}/{repo}/releases/... — the two leading segments must be the
  // entry's own. GitHub treats them case-insensitively, so we do too.
  const segments = url.pathname.split('/').filter(segment => segment !== '')
  if (segments.length < 4 || segments[2] !== 'releases') return null
  return `${segments[0]}/${segments[1]}`.toLowerCase() === repo.toLowerCase() ? target : null
}

/**
 * Parse a registry source url: a github repo, optionally with a
 * `/tree/<branch>/<subpath>` suffix (how the curated list links monorepo
 * subpackages, e.g. dsh-plugins#theme-gallery).
 */
export function parseSourceUrl(url: string): { repo: string; subpath: string | null } | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/tree\/[^/]+\/(.+?))?\/?$/.exec(url)
  if (m === null || !REPO_RE.test(m[1])) return null
  const subpath = m[2] ?? null
  if (subpath !== null) {
    // No empty/dot segments: `..` would escape the repo in the #path: selector.
    if (!validSubpath(subpath)) return null
  }
  return { repo: m[1], subpath }
}

function repoFromParts(owner: string, name: string): { repo: string } | null {
  const repoName = name.replace(/\.git$/i, '')
  const repo = `${owner}/${repoName}`
  return REPO_RE.test(repo) ? { repo } : null
}

/** Parse repository forms accepted by package.json.repository. */
export function parseGitHubRepository(value: string): { repo: string } | null {
  const input = value.trim()
  const shortcut = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#.*)?$/i.exec(input)
  if (shortcut !== null) return repoFromParts(shortcut[1]!, shortcut[2]!)

  const remote = input.replace(/^git\+/i, '')
  const web = /^(?:https?|git|ssh):\/\/(?:git@)?github\.com[/:]([^/]+)\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(remote)
  const scp = /^git@github\.com:([^/]+)\/([^/?#]+)$/i.exec(remote)
  const match = web ?? scp
  return match === null ? null : repoFromParts(match[1]!, match[2]!)
}

/**
 * Parse a Git remote. Unlike package metadata, a local origin may contain a
 * proxy prefix (for example `https://proxy/https://github.com/o/r.git`). In
 * that case only the last GitHub occurrence is considered.
 */
export function parseGitHubRemote(url: string): { repo: string } | null {
  const exact = parseGitHubRepository(url)
  if (exact !== null) return exact
  const matches = [...url.matchAll(/github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=$|[/?#])/ig)]
  const match = matches.at(-1)
  return match === undefined ? null : repoFromParts(match[1]!, match[2]!)
}

/** Normalized repo identity shared by server discovery and client matching. */
export function githubRepoIdentity(url: string, directory?: string | null): string | null {
  const source = parseGitHubRepository(url)
  if (source === null) return null
  const repo = source.repo.toLowerCase()
  if (directory === undefined || directory === null || directory.trim() === '') return repo
  const subpath = directory.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
  return validSubpath(subpath) ? `${repo}#path:/${subpath.toLowerCase()}` : null
}

/**
 * Repository evidence used for installed-source matching. A monorepo package
 * contributes both its collection root and exact subpath, mirroring the
 * identities extracted from `github:owner/repo#path:/package` specs.
 */
export function githubRepoIdentities(url: string, directory?: string | null): string[] {
  const identity = githubRepoIdentity(url, directory)
  if (identity === null) return []
  const pathAt = identity.indexOf('#path:/')
  return pathAt === -1 ? [identity] : [identity.slice(0, pathAt), identity]
}

/** Weak identity hints from a local Git origin; never used to reject a unique match. */
export function githubRemoteIdentities(url: string, directory?: string | null): string[] {
  const source = parseGitHubRemote(url)
  if (source === null) return []
  return githubRepoIdentities(`https://github.com/${source.repo}`, directory)
}

/** GitHub `owner/repo` for a registry URL, or null when it is not a GitHub repo URL. */
export function repoOf(url: string): string | null {
  return parseSourceUrl(url)?.repo ?? null
}

/**
 * A commit-pinned codeload tarball URL, optionally behind a prefix proxy.
 *
 * Pinned to a SHA rather than `HEAD` on purpose. pnpm records whatever URL
 * it was given, and the profile's version detection reads the installed
 * commit back out of the lockfile by matching `codeload.github.com/owner/
 * repo/tar.gz/<40 hex>` (src/profile.ts). A `HEAD` URL installs fine and
 * then reports no version forever, which is a worse outcome than being slow.
 *
 * @param repo - `owner/repo`.
 * @param sha - full 40-character commit SHA.
 * @param proxy - prefix proxy, or null to address codeload directly.
 */
export function codeloadTarball(repo: string, sha: string, proxy: string | null): string {
  const direct = `https://codeload.github.com/${repo}/tar.gz/${sha}`
  return proxy === null ? direct : `${proxy}/${direct}`
}

/**
 * The GitHub source behind an install target, in whatever spelling that
 * target uses — `owner/repo` in its ORIGINAL case, plus any `#path:`
 * subpath.
 *
 * Current installs use `github:` shortcuts. Older regional installs can
 * still carry a prefix-proxied codeload tarball, so both spellings resolve
 * here during update, duplicate detection, and recovery.
 */
function githubShortcut(spec: string): { repo: string; subpath: string | null } | null {
  const shortcut = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:#(.*))?$/.exec(spec)
  if (shortcut === null) return null
  // Any non-path fragment is accepted (`#semver:`, a bare ref) because only
  // `path:` changes which plugin this is; the rest select a version of the
  // same one. pnpm permits a revision and subpath together as
  // `#<revision>&path:/sub`, which is what a mirror-resolved collection
  // install uses (#385).
  let subpath: string | null = null
  for (const selector of (shortcut[2] ?? '').split('&')) {
    const pathMatch = /^path:\/(.+)$/.exec(selector)
    if (pathMatch === null) continue
    const candidate = pathMatch[1]!
    if (subpath !== null || !validSubpath(candidate)) return null
    subpath = candidate
  }
  return { repo: shortcut[1]!, subpath }
}

function repoFromTarget(spec: string): { repo: string; subpath: string | null } | null {
  const shortcut = githubShortcut(spec)
  if (shortcut !== null) return shortcut
  // A codeload tarball, direct or proxied. Matched as a substring for the
  // same reason profile.ts does: the proxy sits in FRONT of the real URL,
  // so anchoring the pattern would see only the proxy's own hostname.
  const tarball = /codeload\.github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/tar\.gz\/[0-9a-f]{40}/.exec(spec)
  if (tarball !== null) return { repo: tarball[1]!, subpath: null }
  return null
}

/**
 * Extract a GitHub repo URL from a URL that may be a Release asset tarball
 * (the format used by the catalog: releases/latest/download/ or
 * releases/download/vX.Y.Z/).
 *
 * THIS IS FOR DISPLAY/LOOKUP PURPOSES ONLY — e.g., finding update notes for a
 * plugin installed via npm. It MUST NOT be used for any decision that affects
 * installation, rollback, duplicate detection, or build-script approval.
 * Those paths use `repoFromTarget` / `repoOfTarget` which are stricter and
 * intentionally do NOT recognize Release asset URLs (because the same asset
 * URL can serve different bytes at different times).
 */
export function lookupRepoFromUrl(url: string): string | null {
  // A GitHub Release asset tarball (used by the catalog), e.g.
  // https://github.com/owner/repo/releases/latest/download/name.tgz
  // https://github.com/owner/repo/releases/download/v1.0.0/name.tgz
  const releaseAsset = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/releases\/(?:latest\/download|download\/[^/]+)\/[^/]+\.(?:tgz|tar\.gz)/i.exec(url)
  if (releaseAsset !== null) return `https://github.com/${releaseAsset[1]!}`
  return null
}

/**
 * Normalized identity of an install target, for comparing two targets that
 * may be spelled differently — lowercased, matching `githubRepoIdentity`.
 *
 * @returns the identity, or null when the spec is not a GitHub source (an
 * npm package name, a `file:` link, anything else).
 */
export function repoOfTarget(spec: string): string | null {
  const parsed = repoFromTarget(spec)
  if (parsed === null) return null
  const repo = parsed.repo.toLowerCase()
  return parsed.subpath === null ? repo : `${repo}#path:/${parsed.subpath.toLowerCase()}`
}

/**
 * The branch or tag a GitHub spec selects, or null for the default branch.
 *
 * Update detection has to ask about the same ref the install used, or it
 * compares the installed commit against a line the user never chose (#446).
 * A commit pin yields null: the answer for a pinned install is the default
 * branch, which is what "is there something newer" means there.
 */
export function githubRefOfTarget(spec: string): string | null {
  return spec.startsWith('github:') ? refOfFragment(spec) : null
}

/**
 * The same question for every OTHER git source — a host shorthand or a plain
 * remote URL.
 *
 * Their update check asks the remote for `HEAD`, which is the default branch.
 * For an install that selected a branch or tag, that compares the installed
 * commit against a line the user never chose: the row then offers an update
 * forever, and the update itself re-resolves inside the same selector and
 * never moves. That is #446, reached from a different direction.
 */
export function gitRefOfTarget(spec: string): string | null {
  if (!isGitHostedSpec(spec) || spec.startsWith('github:')) return null
  return refOfFragment(spec)
}

/** The branch or tag a `#…` fragment selects, or null for the default branch. */
function refOfFragment(spec: string): string | null {
  const fragmentAt = spec.indexOf('#')
  if (fragmentAt === -1) return null
  for (const selector of spec.slice(fragmentAt + 1).split('&')) {
    if (selector === '' || selector.startsWith('path:/')) continue
    if (/^[0-9a-f]{40}$/i.test(selector)) continue
    // A commit pin and a semver range both mean "the default branch is the
    // line to compare against".
    if (selector.startsWith('semver:')) continue
    return selector
  }
  return null
}

/**
 * An immutable GitHub commit already carried by an install target.
 *
 * Build-script approval on pnpm below 11.21 needs the exact commit-pinned
 * codeload key. Re-resolving HEAD after an install can race a repository push
 * and approve a different URL, so consume an existing pin whenever the spec
 * has one (#285/#385).
 */
export function githubCommitOfTarget(spec: string): string | null {
  const shortcut = githubShortcut(spec)
  const revision = shortcut === null ? null : /^github:[^#]+#([0-9a-f]{40})(?:&|$)/.exec(spec)
  if (revision !== null) return revision[1]!
  const tarball = /codeload\.github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/tar\.gz\/([0-9a-f]{40})(?:[?#][^\s]*)?$/.exec(spec)
  return tarball === null ? null : tarball[1]!
}

/**
 * Pin a GitHub shortcut to one immutable commit without losing its subpath.
 * Revision selectors are replaced; one valid `path:` selector is preserved.
 */
export function githubTargetAtCommit(spec: string, sha: string): string | null {
  if (!/^[0-9a-f]{40}$/.test(sha)) return null
  const parsed = githubShortcut(spec)
  if (parsed === null) return null
  return `github:${parsed.repo}#${sha}${parsed.subpath === null ? '' : `&path:/${parsed.subpath}`}`
}

/**
 * The allowBuilds key that actually authorizes a git-hosted dependency's
 * build scripts. Verified against pnpm 11.21 (#68 by @yzr278892): for a
 * `github:owner/repo` install, a bare `name: true` entry does NOT match —
 * pnpm's own hint names a commit-pinned codeload URL that changes on every
 * push; the stable form that matches is `name@git+https://github.com/owner/repo.git`.
 *
 * A legacy China-region install may address the SAME repo through a proxied
 * codeload URL, and must authorize under the same key: the plugin a user
 * approved build scripts for does not become a different plugin because its
 * stored source spelling differs.
 *
 * @param name - installed package name.
 * @param spec - the dependency spec from package.json, or the install target.
 * @returns the stable key, or null when the spec is not a git source pnpm
 *   installs as one (an npm name, a local path, the scp-like `git@host:` form).
 */
export function gitAllowBuildsKey(name: string, spec: string): string | null {
  const parsed = repoFromTarget(spec)
  // Original case, not the normalized identity: this key is matched by pnpm
  // as a literal string, so it has to name the repo the way the spec did.
  // Subpath entries authorize under the repo itself — the `#path:` selector
  // picks a directory out of the same download.
  if (parsed !== null) return `${name}@git+https://github.com/${parsed.repo}.git`
  // Every other git host takes the same shape — the clone URL of the source.
  // Being GitHub-only here was a hole, not a scope: a gitlab/bitbucket or
  // self-hosted plugin with a build script got no key at all, so the "allow
  // build scripts and retry" button wrote the bare name, which pnpm ignores
  // (#68/#69), and the retry failed exactly as before. Measured on pnpm
  // 12.4.1: `name@git+https://bitbucket.org/owner/repo.git` and
  // `name@git+file:///…/repo.git` each authorize the build; the bare name
  // does not.
  const shorthand = parseHostShorthand(spec)
  if (shorthand !== null) return `${name}@git+https://${shorthand.host}/${shorthand.path}.git`
  const remote = gitRemoteSpelling(spec)
  return remote === null ? null : `${name}@${remote}`
}

/**
 * The OTHER allowBuilds key form, for pnpm below 11.21 (#285 by @omdsh-dev,
 * following #267).
 *
 * The stable `name@git+https://…` key above is what pnpm 11.21+ matches, and
 * it is the better key precisely because it does not change when the
 * repository is pushed to. Older pnpm does not match it at all: 11.8.0 — the
 * version DSH Desktop still bundles — matches only the commit-pinned
 * codeload URL it names in its own `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`
 * message. On those versions the "allow build scripts and retry" button
 * could never work, because the key it wrote was one pnpm would never read.
 *
 * Both are written. The pinned form goes stale the moment the repository
 * moves, which is why it cannot REPLACE the stable one — but a stale entry
 * costs a line in a YAML file, and a missing one costs the user the only
 * button that could have unblocked them.
 *
 * @param sha - the commit the install will actually fetch.
 * @returns the key, or null when the spec is not github-hosted.
 */
export function codeloadAllowBuildsKey(name: string, spec: string, sha: string): string | null {
  const parsed = repoFromTarget(spec)
  if (parsed === null || !/^[0-9a-f]{40}$/.test(sha)) return null
  return `${name}@https://codeload.github.com/${parsed.repo}/tar.gz/${sha}`
}

/**
 * The pinned allowBuilds key for a NON-GitHub git source — the other half of
 * the pair `codeloadAllowBuildsKey` gives GitHub, for the same reason (#285):
 * the stable clone-URL key is what pnpm 12 matches, while pnpm 11.8.0 — the
 * version DSH Desktop bundles — matches only the commit-pinned id it names in
 * its own error.
 *
 * Measured on 11.8.0: the stable key leaves a bitbucket install's build
 * ignored, and `name@https://bitbucket.org/owner/repo/get/<sha>.tar.gz`
 * authorizes it; for a plain remote the working key is
 * `name@git+<remote>#<sha>`. Like the codeload one this goes stale the moment
 * the repository is pushed to, which is why it is written ALONGSIDE the
 * stable key and never instead of it.
 */
export function pinnedGitAllowBuildsKey(name: string, spec: string, sha: string): string | null {
  if (!/^[0-9a-f]{40}$/.test(sha)) return null
  const shorthand = parseHostShorthand(spec)
  if (shorthand !== null) {
    // GitHub keeps `codeloadAllowBuildsKey`, which knows the proxied spelling
    // a region install carries.
    if (shorthand.scheme === 'github') return null
    const repo = shorthand.path.split('/').pop()!
    // The archive each host serves — the id pnpm gives the dependency, and
    // the key its own hint names. Both URLs are pnpm 11/12's spelling, read
    // off real lockfiles. pnpm 9/10 fetch GitLab through its REST API
    // instead, but those majors gate builds with `onlyBuiltDependencies`
    // rather than the `allowBuilds` map this key is written into (measured on
    // 10.34.5), so their spelling is not this function's business.
    return shorthand.scheme === 'bitbucket'
      ? `${name}@https://${shorthand.host}/${shorthand.path}/get/${sha}.tar.gz`
      : `${name}@https://${shorthand.host}/${shorthand.path}/-/archive/${sha}/${repo}-${sha}.tar.gz`
  }
  const remote = gitRemoteSpelling(spec)
  return remote === null ? null : `${name}@${remote}#${sha}`
}

/**
 * The pnpm install target for a registry entry. Repo-verified npm packages
 * win, followed by author-supplied prebuilt GitHub Release tarballs; both avoid
 * full-repo downloads and local build scripts.
 * @returns the target spec, or null when the source url is unsupported.
 */
export function installTargetFor(entry: { url: string; npm?: unknown; tarball?: unknown }): string | null {
  const source = parseSourceUrl(entry.url)
  if (source === null) return null
  if (typeof entry.npm === 'string' && NPM_NAME_RE.test(entry.npm)) return entry.npm
  const tarball = releaseTarballTarget(entry.tarball, source.repo)
  if (tarball !== null) return tarball
  return source.subpath !== null
    ? `github:${source.repo}#path:/${source.subpath}`
    : `github:${source.repo}`
}

/** True for profile specs that are a local checkout or tarball, not a registry pin. */
export function isLocalSpec(spec: string): boolean {
  return /^(?:link|file):/i.test(spec)
}

/**
 * The host shorthands pnpm reads as a git source — and writes BACK into
 * package.json in place of whatever URL the install was typed with.
 * Measured on pnpm 12.4.1, one real repository per host, both directions:
 *
 * | shorthand    | installed as                                     | manifest after                 | lockfile resolution                        |
 * | ------------ | ------------------------------------------------ | ------------------------------ | ------------------------------------------ |
 * | `github:`    | `git+https://github.com/sindresorhus/p-limit.git` | `github:sindresorhus/p-limit`  | `codeload.github.com/o/r/tar.gz/<sha>`     |
 * | `gitlab:`    | `git+https://gitlab.com/gitlab-org/frontend/eslint-plugin.git` | `gitlab:gitlab-org/frontend/eslint-plugin` | `gitlab.com/<path>/-/archive/<sha>/…` |
 * | `bitbucket:` | `git+https://bitbucket.org/atlassian/aui.git`     | `bitbucket:atlassian/aui`      | `bitbucket.org/o/r/get/<sha>.tar.gz`       |
 *
 * The manifest column is the same on 9.15.4, 10.34.5 and 11.8.0 (measured:
 * every major writes the shorthand back). The lockfile column is NOT —
 * 9 and 10 fetch GitLab through its REST API — which is why reading the
 * commit is a table of its own, in `ARCHIVE_COMMIT_SHAPES` (profile.ts).
 *
 * That is the whole set on this pnpm, and the negative half was measured
 * too: `gist:` and `sourcehut:` — hosts `hosted-git-info` knows — are NOT
 * git sources here. On 12.4.1 `gist:<id>` is looked up on the registry
 * (`registry…/gist%3A<id>`, 404) and `sourcehut:~me/plug` is refused as an
 * invalid package name; neither reaches git, so listing them would route a
 * registry install down the git path. Their answer is per-version — pnpm 9
 * writes `sourcehut:…` into the manifest as a `link:` — which is exactly why
 * this is a table to re-measure and extend, not another `if`.
 *
 * A shorthand in a manifest is no evidence that pnpm put it there: users
 * write `gitlab:owner/repo` by hand as well, and the two are identical in
 * the file. Everything below therefore judges by shape, never by origin.
 *
 * GitLab is the one host with nested groups, so its path is not
 * `owner/repo` — `gitlab:group/subgroup/repo` is a real installable
 * spelling, and the measured example above is one.
 */
const HOST_SHORTHANDS: ReadonlyMap<string, { readonly host: string; readonly nested: boolean }> = new Map([
  ['github', { host: 'github.com', nested: false }],
  ['bitbucket', { host: 'bitbucket.org', nested: false }],
  ['gitlab', { host: 'gitlab.com', nested: true }],
])

/** The shorthand scheme a spec opens with, whatever follows it. */
function hostShorthandScheme(spec: string): string | null {
  const scheme = /^([A-Za-z]+):/.exec(spec.trim())?.[1]?.toLowerCase() ?? null
  return scheme !== null && HOST_SHORTHANDS.has(scheme) ? scheme : null
}

export interface HostShorthand {
  /** Lowercased scheme, i.e. the manifest's own spelling of the host. */
  scheme: string
  /** The host that scheme resolves to. */
  host: string
  /** `owner/repo`, or a nested group path on GitLab. No `.git`, no fragment. */
  path: string
  /** Everything after `#`, empty when the spec carries no selector. */
  fragment: string
}

/**
 * Split `<scheme>:<path>[#<selector>]` into its parts, or null when the spec
 * is not one of the shorthands above or its path does not fit that host's
 * shape. Used where a URL or an identity has to be BUILT from the spec;
 * classification asks `hostShorthandScheme`, which is deliberately looser
 * because pnpm hands the whole scheme to git regardless of what follows.
 */
export function parseHostShorthand(spec: string): HostShorthand | null {
  const parsed = /^([A-Za-z]+):([^#\s]+)(?:#(.*))?$/.exec(spec.trim())
  if (parsed === null) return null
  const scheme = parsed[1]!.toLowerCase()
  const entry = HOST_SHORTHANDS.get(scheme)
  if (entry === undefined) return null
  const path = parsed[2]!.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  const segments = path.split('/')
  if (entry.nested ? segments.length < 2 : segments.length !== 2) return null
  // `.` and `..` pass the charset but are path traversal, not repository
  // names: the shorthand's clone URL is built from this, and a host would
  // resolve `owner/../other` to a different project of its own.
  if (!segments.every(seg => /^[A-Za-z0-9_.-]+$/.test(seg) && seg !== '.' && seg !== '..')) return null
  return { scheme, host: entry.host, path, fragment: parsed[3] ?? '' }
}

/**
 * `host/path`, lowercased: the identity a git-hosted install keeps across
 * its spellings — the shorthand, the clone URL it was typed as, and the
 * archive tarball pnpm resolved it to.
 *
 * Host-qualified on purpose. `owner/repo` alone is not an identity: the
 * same pair exists on github.com, gitlab.com and bitbucket.org, and a bare
 * key would let one host's commit answer for another host's plugin.
 *
 * This answers "which repository is this", not "is this a git source" — it
 * will happily key a registry tarball URL by its host. Ask `isGitHostedSpec`
 * first, the way every caller here does.
 */
export function hostedRepoKey(spec: string): string | null {
  const shorthand = parseHostShorthand(spec)
  if (shorthand !== null) return `${shorthand.host}/${shorthand.path}`.toLowerCase()
  // Codeload before the generic URL below: a legacy region-proxied install
  // carries the real URL AFTER the proxy's own, and the proxy is not the
  // host of the repository.
  const github = repoFromTarget(spec)
  if (github !== null) return `github.com/${github.repo}`.toLowerCase()
  let remote = spec.trim().replace(/^git\+/i, '')
  const scp = /^git@([^/\s:]+):(.+)$/.exec(remote)
  if (scp !== null) remote = `https://${scp[1]}/${scp[2]!.replace(/^\/+/, '')}`
  let url: URL
  try {
    url = new URL(remote.split('#')[0]!)
  } catch {
    return null
  }
  if (!/^(?:https?|ssh|git):$/i.test(url.protocol)) return null
  const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  if (path === '') return null
  if (!path.split('/').every(seg => /^[A-Za-z0-9_.-]+$/.test(seg))) return null
  // `host`, not `hostname`: a port is part of the identity. Two self-hosted
  // instances on one machine are two hosts, and the lockfile side keys by
  // whatever the URL says — dropping the port here would both miss that key
  // and let `git.example.com:9443` answer with `git.example.com`'s commit.
  return `${url.host}/${path}`.toLowerCase()
}

/**
 * True when the install came from a git remote — host shorthands, codeload
 * tarballs, and any other host (Gitea, GitLab self-host, raw `git+https://…`).
 *
 * Update detection used to ask only `repoOfTarget` (GitHub spellings). A
 * private-host URL then fell through to the npm branch and was looked up by
 * package name; a colliding registry package read as an "update" and
 * `name@latest` replaced the git install (#525).
 */
export function isGitHostedSpec(spec: string): boolean {
  const s = spec.trim()
  if (s === '' || isLocalSpec(s)) return false
  // A host shorthand pnpm parses as a git source. Matched by scheme alone,
  // the way `github:` always was: pnpm hands the whole scheme to git no
  // matter what follows, so even a malformed path is not an npm name — and
  // being sent to npm by name is the failure this predicate exists to stop.
  if (hostShorthandScheme(s) !== null) return true
  if (repoFromTarget(s) !== null) return true
  if (/^git\+/i.test(s) || /^git:\/\//i.test(s) || /^ssh:\/\//i.test(s)) return true
  if (/^git@[^/\s:]+:\S+/.test(s)) return true
  // https://host/…/repo.git with optional fragment / query — not a Release
  // archive and not a bare registry name.
  if (/^https?:\/\/[^\s]+\/[^\s]+?\.git(?:[#?].*)?$/i.test(s)) return true
  // Same shape without the `.git` suffix (Gitea/GitLab often omit it).
  if (looksLikeHttpsGitRemote(s)) return true
  return false
}

/**
 * `https://host/owner/repo` (optional `.git`, fragment, query) that is not an
 * npm registry, Release archive, or codeload tarball.
 */
function looksLikeHttpsGitRemote(spec: string): boolean {
  const bare = spec.trim().split(/[?#]/)[0] ?? ''
  let url: URL
  try {
    url = new URL(bare)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (host === 'registry.npmjs.org' || host.endsWith('.npmjs.org')) return false
  if (host === 'registry.npmmirror.com' || host === 'cdn.npmmirror.com') return false
  if (host === 'codeload.github.com') return false
  if (/\.(?:tgz|tar\.gz|zip)$/i.test(url.pathname)) return false
  if (/\/(?:releases|archive)\//i.test(url.pathname)) return false
  // Exactly owner/repo — deeper paths are too ambiguous to treat as git.
  const segments = url.pathname.split('/').filter(seg => seg !== '')
  if (segments.length !== 2) return false
  const repo = segments[1]!.replace(/\.git$/i, '')
  return /^[A-Za-z0-9_.-]+$/.test(segments[0]!) && /^[A-Za-z0-9_.-]+$/.test(repo)
}

/**
 * Immutable commit already carried by a non-shortcut git URL (`…git#<sha>`).
 * GitHub shortcuts keep using `githubCommitOfTarget`.
 */
export function gitCommitOfTarget(spec: string): string | null {
  const github = githubCommitOfTarget(spec)
  if (github !== null) return github
  const hash = spec.indexOf('#')
  if (hash === -1) return null
  const frag = spec.slice(hash + 1).split(/[?&]/)[0] ?? ''
  return /^[0-9a-f]{40}$/i.test(frag) ? frag.toLowerCase() : null
}

/**
 * Pin a non-shortcut git URL to one immutable commit: the remote as spelled,
 * with any ref, pin or selector fragment replaced by the commit, which pnpm
 * re-resolves to exactly that commit. GitHub shortcuts and codeload URLs keep
 * `githubTargetAtCommit` (#632).
 *
 * Three spellings are refused rather than promised:
 * - a `path:` selector, because the `&` that carries it alongside a commit is
 *   outside the host's target grammar;
 * - the scp-like `git@host:owner/repo.git`, which pnpm does not read as a git
 *   source at all — measured on 9.15.4 and 12.4.1, `pnpm add git@host:o/r.git`
 *   exits 0 having written a `link:` dependency literally named `git`;
 * - a bare `https://host/owner/repo.git`, which pnpm 12 clones but pnpm 11 —
 *   what DSH Desktop still bundles — downloads as a tarball; it is returned
 *   with the `git+` prefix that means the same thing to both.
 */
export function gitTargetAtCommit(spec: string, sha: string): string | null {
  if (!/^[0-9a-f]{40}$/.test(sha)) return null
  if (!isGitHostedSpec(spec) || spec.startsWith('github:') || repoFromTarget(spec) !== null) return null
  const shorthand = parseHostShorthand(spec)
  if (shorthand !== null) {
    // The shorthand pinned to the commit. pnpm keeps that spelling verbatim
    // and resolves it to exactly that commit — measured on 12.4.1: `pnpm add
    // gitlab:gitlab-org/frontend/eslint-plugin#<sha>` left the pin in the
    // manifest and wrote the archive tarball of that sha into the lockfile.
    // A `path:` selector is refused rather than guessed: the
    // `#<ref>&path:/sub` grammar is measured on `github:` only, and a
    // rollback that silently restores a sibling package is worse than one
    // that declines.
    return /(?:^|&)path:/.test(shorthand.fragment) ? null : `${shorthand.scheme}:${shorthand.path}#${sha}`
  }
  const hash = spec.indexOf('#')
  if (hash !== -1 && /(?:^|&)path:/.test(spec.slice(hash + 1))) return null
  const remote = gitRemoteSpelling(spec)
  return remote === null ? null : `${remote}#${sha}`
}

/**
 * The remote as pnpm spells it: no fragment, and `git+` in front of a plain
 * `https://` so pnpm 11 and 12 both read it as a git source rather than a
 * tarball. Null for anything that is not a git transport — including the
 * scp-like `git@host:owner/repo.git`, which pnpm does not read as git at all.
 * The transports are the ones `gitTargetAtCommit` already accepted; this
 * function was factored out of it and must not widen them.
 */
function gitRemoteSpelling(spec: string): string | null {
  const trimmed = spec.trim()
  if (!/^(?:git\+)?(?:https?|ssh|git):\/\//i.test(trimmed)) return null
  const hash = trimmed.indexOf('#')
  const remote = hash === -1 ? trimmed : trimmed.slice(0, hash)
  return /^https?:\/\//i.test(remote) ? `git+${remote}` : remote
}

/**
 * pnpm add target for updating a non-shortcut git install: drop a full-SHA
 * pin so the remote re-resolves to HEAD, keep any branch/tag fragment.
 * GitHub-hosted `git+https://github.com/…` is rewritten to `github:` — the
 * market's canonical spelling — so a successful update rematerializes the
 * dependency that way and later check/update/rollback can use the first-class
 * GitHub path. This turn still installs through the generic-git target slot
 * (no region acceleration on the rewritten shortcut itself).
 *
 * A gitlab/bitbucket shorthand is sent BACK to pnpm as the same shorthand,
 * and deliberately not rewritten to `git+https://host/owner/repo.git`. Both
 * install (measured on 12.4.1), but pnpm writes the shorthand into the
 * manifest either way — so rewriting would send one spelling and get the
 * other one back, leaving the target we sent, the manifest we then read, the
 * duplicate-install guard and the allowBuilds key disagreeing about what was
 * installed. Passthrough keeps all four on the single spelling pnpm itself
 * settles on.
 */
export function gitUpdateTarget(spec: string): string | null {
  if (!isGitHostedSpec(spec) || spec.startsWith('github:') || repoFromTarget(spec) !== null) return null
  const github = parseGitHubRemote(spec)
  if (github !== null) {
    const hash = spec.indexOf('#')
    if (hash === -1) return `github:${github.repo}`
    const frag = spec.slice(hash + 1).split(/[?&]/)[0] ?? ''
    if (/^[0-9a-f]{40}$/i.test(frag)) return `github:${github.repo}`
    // Preserve branch/tag / path selectors the same way githubUpdateTarget does
    // for shortcuts — only full-SHA pins are dropped.
    if (frag.startsWith('path:/') || frag.startsWith('semver:')) {
      return `github:${github.repo}#${frag}`
    }
    if (frag !== '') return `github:${github.repo}#${frag}`
    return `github:${github.repo}`
  }
  const hash = spec.indexOf('#')
  if (hash === -1) return spec
  const fragment = spec.slice(hash + 1)
  // A `path:` selector is what picks this package out of a monorepo. Dropping
  // the commit pin drops the whole fragment with it, and the install that
  // follows is the repository ROOT — a different package wearing the same
  // name. Keep the spec whole instead: the update then re-resolves in place
  // and reports "already current", which is honest, where the strip silently
  // replaced the plugin.
  if (/(?:^|&)path:/.test(fragment)) return spec
  const frag = fragment.split(/[?&]/)[0] ?? ''
  return /^[0-9a-f]{40}$/i.test(frag) ? spec.slice(0, hash) : spec
}

/**
 * Smart-HTTP info/refs URL for a git-hosted install target, or null when the
 * transport cannot be probed with `fetch` (scp / git:// / ssh://).
 * Userinfo is stripped so update checks do not resend embedded credentials.
 */
export function gitUploadPackUrl(spec: string): string | null {
  const shorthand = parseHostShorthand(spec)
  // A shorthand's own clone URL, where the `.git` suffix is not decoration:
  // measured on gitlab.com, `…/group/repo/info/refs?service=git-upload-pack`
  // answers 301 to the project page, while `…/group/repo.git/info/refs`
  // answers the ref advertisement. bitbucket.org answers both, so the one
  // spelling serves every host in the table.
  let remote = shorthand !== null
    ? `https://${shorthand.host}/${shorthand.path}.git`
    : spec.trim().replace(/^git\+/i, '')
  const scp = /^git@([^:]+):(.+)$/.exec(remote)
  if (scp !== null) remote = `https://${scp[1]}/${scp[2]!.replace(/^\/*/, '')}`
  const hash = remote.indexOf('#')
  if (hash !== -1) remote = remote.slice(0, hash)
  const query = remote.indexOf('?')
  if (query !== -1) remote = remote.slice(0, query)
  let url: URL
  try {
    url = new URL(remote)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  url.username = ''
  url.password = ''
  const base = url.toString().replace(/\/+$/, '')
  return `${base}/info/refs?service=git-upload-pack`
}

/**
 * A `link:` that points into a generation the desktop host materialised
 * (#497): `link:../.generations/live/<pkg>+<version>+<hash>/node_modules/<pkg>`.
 * That is the host's production install, not a developer's checkout — it
 * came from the registry and has releases to compare against. The host
 * recognises its own installs by the `.generations/live/` segment, and no
 * hand-written link ever lands under that directory, so the same test is
 * enough here.
 */
export function isGenerationLink(spec: string): boolean {
  return /^link:/i.test(spec) && /(?:^|[\\/])\.generations[\\/]live[\\/]/i.test(spec)
}

export { findCatalogEntryForLocal, resolveCatalogRestore } from './catalog-local-match.ts'

/**
 * pnpm add target for restoring a local checkout onto a catalog entry.
 * When the catalog only lists the collection root but the checkout declared
 * `repository.directory`, keep that subdirectory — otherwise we install the
 * repo tarball and get the wrong package name (and its build scripts).
 */
export function restoreTargetForLocal(
  entry: { url: string; npm?: unknown },
  identities: readonly string[] = [],
): string | null {
  const base = installTargetFor(entry)
  if (base === null) return null
  if (!base.startsWith('github:') || base.includes('#path:/')) return base
  const repo = base.slice('github:'.length).toLowerCase()
  for (const raw of identities) {
    const id = raw.toLowerCase()
    const prefix = `${repo}#path:/`
    if (!id.startsWith(prefix)) continue
    const subpath = id.slice(prefix.length)
    if (validSubpath(subpath)) return `github:${base.slice('github:'.length)}#path:/${subpath}`
  }
  return base
}

/**
 * Dependency names that use pnpm's `workspace:` protocol.
 * Those specs only resolve inside the author's monorepo; a git `#path:`
 * install into a profile cannot see the sibling packages. pnpm installs
 * optional dependencies and auto-installs peers too, so all three maps are
 * scanned; devDependencies are never installed and stay out.
 */
export function workspaceProtocolDeps(manifest: unknown): string[] {
  if (typeof manifest !== 'object' || manifest === null) return []
  const seen = new Set<string>()
  const names: string[] = []
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const deps = (manifest as Partial<Record<typeof field, unknown>>)[field]
    if (typeof deps !== 'object' || deps === null) continue
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof spec === 'string' && spec.startsWith('workspace:') && !seen.has(name)) {
        seen.add(name)
        names.push(name)
      }
    }
  }
  return names
}

/** Git subdirectory restores cannot satisfy `workspace:` dependencies. npm can. */
export function restoreBlockedByWorkspace(target: string, workspaceDeps: readonly string[]): boolean {
  return workspaceDeps.length > 0 && target.startsWith('github:')
}

/**
 * The name an entry is ALREADY installed under, or null — the server-side
 * duplicate guard (#27): the same plugin listed under an alias entry must
 * never install twice (two loader entries with one id brick the next boot).
 *
 * Identity is subpath-aware so monorepo siblings stay independent: an entry
 * with a /tree/ subpath identifies as repo#path:/sub (never the bare repo),
 * while an installed dependency contributes its bare repo AND its #path:
 * form — so a collection root still matches the pieces it was retargeted
 * into, but two different subpackages of one repo never cross-match.
 */
export function findInstalledAlias(
  entry: { name: string; npm?: unknown; url: string },
  installed: Record<string, string>,
): string | null {
  const source = parseSourceUrl(entry.url)
  const entryRepoId = source === null
    ? null
    : source.subpath === null
      ? source.repo.toLowerCase()
      : `${source.repo.toLowerCase()}#path:/${source.subpath.toLowerCase()}`
  const ids = new Set<string>([entry.name.toLowerCase()])
  if (typeof entry.npm === 'string' && entry.npm !== '') ids.add(entry.npm.toLowerCase())
  if (entryRepoId !== null) ids.add(entryRepoId)
  for (const [name, spec] of Object.entries(installed)) {
    const dep = new Set<string>([name.toLowerCase()])
    const scoped = /^@([^/]+)\/(.+)$/.exec(name)
    if (scoped !== null) dep.add(`${scoped[1]}/${scoped[2]}`.toLowerCase())
    const repoId = repoOfTarget(spec)
    if (repoId !== null) {
      dep.add(repoId.split('#path:/')[0]!)
      dep.add(repoId)
      // Repo evidence on both sides is decisive (#66): the curated registry
      // lists distinct plugins under one name (both dsh-usage-stats, four
      // dsh-memory…), so a github-installed dependency is the entry's plugin
      // only if the REPOS agree — a bare name coincidence must not count.
      if (entryRepoId !== null) {
        if (dep.has(entryRepoId)) return name
        continue
      }
    }
    for (const id of dep) if (ids.has(id)) return name
  }
  return null
}
