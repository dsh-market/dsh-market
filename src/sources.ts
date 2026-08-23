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
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

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
 * One plugin now has two spellings depending on the download region: the
 * `github:` shortcut and a proxied codeload tarball. Both have to resolve
 * here, or switching regions makes every installed plugin look like a
 * different one.
 */
function repoFromTarget(spec: string): { repo: string; subpath: string | null } | null {
  const shortcut = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:#(.*))?$/.exec(spec)
  if (shortcut !== null) {
    // Any fragment is accepted (`#path:`, `#semver:`, a bare ref) because
    // only `#path:` changes which plugin this is; the rest select a version
    // of the same one.
    const pathMatch = /^path:\/(.+)$/.exec(shortcut[2] ?? '')
    const subpath = pathMatch === null ? null : pathMatch[1]!
    return { repo: shortcut[1]!, subpath: subpath !== null && validSubpath(subpath) ? subpath : null }
  }
  // A codeload tarball, direct or proxied. Matched as a substring for the
  // same reason profile.ts does: the proxy sits in FRONT of the real URL,
  // so anchoring the pattern would see only the proxy's own hostname.
  const tarball = /codeload\.github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/tar\.gz\/[0-9a-f]{40}/.exec(spec)
  return tarball === null ? null : { repo: tarball[1]!, subpath: null }
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
 * The allowBuilds key that actually authorizes a git-hosted dependency's
 * build scripts. Verified against pnpm 11.21 (#68 by @yzr278892): for a
 * `github:owner/repo` install, a bare `name: true` entry does NOT match —
 * pnpm's own hint names a commit-pinned codeload URL that changes on every
 * push; the stable form that matches is `name@git+https://github.com/owner/repo.git`.
 *
 * A China-region install addresses the SAME repo through a proxied codeload
 * URL, and must authorize under the same key: the plugin a user approved
 * build scripts for does not become a different plugin because the bytes
 * arrived by another route.
 *
 * @param name - installed package name.
 * @param spec - the dependency spec from package.json, or the install target.
 * @returns the stable key, or null when the spec is not github-hosted.
 */
export function gitAllowBuildsKey(name: string, spec: string): string | null {
  const parsed = repoFromTarget(spec)
  // Original case, not the normalized identity: this key is matched by pnpm
  // as a literal string, so it has to name the repo the way the spec did.
  // Subpath entries authorize under the repo itself — the `#path:` selector
  // picks a directory out of the same download.
  return parsed === null ? null : `${name}@git+https://github.com/${parsed.repo}.git`
}

/**
 * The OTHER allowBuilds key form, for pnpm below 11.21 (#285 by @omdsh-dev,
 * following #267).
 *
 * The stable `name@git+https://…` key above is what pnpm 11.21+ matches, and
 * it is the better key precisely because it does not change when the
 * repository is pushed to. Older pnpm does not match it at all: 11.7.0 — the
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
 * The pnpm install target for a registry entry. Registry tarballs beat
 * full-repo GitHub downloads: smaller, prebuilt, and CDN/mirror served. The
 * npm name comes from our curated registry, which only maps repo-verified
 * packages (name-squatting protection).
 * @returns the target spec, or null when the source url is unsupported.
 */
export function installTargetFor(entry: { url: string; npm?: unknown }): string | null {
  const source = parseSourceUrl(entry.url)
  if (source === null) return null
  if (typeof entry.npm === 'string' && NPM_NAME_RE.test(entry.npm)) return entry.npm
  return source.subpath !== null
    ? `github:${source.repo}#path:/${source.subpath}`
    : `github:${source.repo}`
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
    const m = /github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:#path:\/([A-Za-z0-9_./-]+))?/i.exec(spec)
    if (m !== null) {
      dep.add(m[1].toLowerCase())
      if (m[2] !== undefined) dep.add(`${m[1].toLowerCase()}#path:/${m[2].toLowerCase()}`)
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
