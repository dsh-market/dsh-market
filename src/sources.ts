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
 * The allowBuilds key that actually authorizes a git-hosted dependency's
 * build scripts. Verified against pnpm 11.21 (#68 by @yzr278892): for a
 * `github:owner/repo` install, a bare `name: true` entry does NOT match —
 * pnpm's own hint names a commit-pinned codeload URL that changes on every
 * push; the stable form that matches is `name@git+https://github.com/owner/repo.git`.
 * @param name - installed package name.
 * @param spec - the dependency spec from package.json, or the install target.
 * @returns the stable key, or null when the spec is not github-hosted.
 */
export function gitAllowBuildsKey(name: string, spec: string): string | null {
  const m = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:#.*)?$/.exec(spec)
  if (m === null) return null
  return `${name}@git+https://github.com/${m[1]}.git`
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

/** True for profile specs that are a local checkout or tarball, not a registry pin. */
export function isLocalSpec(spec: string): boolean {
  return /^(?:link|file):/i.test(spec)
}

/**
 * Keys a catalog URL contributes to restore matching.
 * A `/tree/` entry is ONLY its exact `#path:` id — never the bare repo —
 * so a collection-root identity cannot select a sibling subpackage.
 */
function catalogMatchKeys(url: string): { path: string | null; repo: string | null } {
  const source = parseSourceUrl(url)
  if (source === null) return { path: null, repo: null }
  const repo = source.repo.toLowerCase()
  return source.subpath === null
    ? { path: null, repo }
    : { path: `${repo}#path:/${source.subpath.toLowerCase()}`, repo: null }
}

/**
 * The catalog entry a locally linked / file: install should restore to.
 * Exact `#path:` identities win, then collection-root identities against
 * root-only catalog rows, then a unique name/npm match. Same-named forks
 * without identities or a matching hint stay unmatched rather than guessing.
 */
export function findCatalogEntryForLocal<T extends { name: string; npm?: string | null; url: string }>(
  plugins: readonly T[],
  name: string,
  identities: readonly string[] = [],
  hints: readonly string[] = [],
): T | null {
  const nameKey = name.toLowerCase()
  const byName = plugins.filter(plugin =>
    plugin.name.toLowerCase() === nameKey
    || (typeof plugin.npm === 'string' && plugin.npm.toLowerCase() === nameKey),
  )
  const identitySet = new Set(identities.map(value => value.toLowerCase()))
  const hintSet = new Set(hints.map(value => value.toLowerCase()))
  if (identitySet.size > 0) {
    const pathHit = plugins.find(plugin => {
      const keys = catalogMatchKeys(plugin.url)
      return keys.path !== null && identitySet.has(keys.path)
    })
    if (pathHit !== undefined) return pathHit
    const rootHit = plugins.find(plugin => {
      const keys = catalogMatchKeys(plugin.url)
      return keys.repo !== null && identitySet.has(keys.repo)
    })
    if (rootHit !== undefined) return rootHit
  }
  if (byName.length === 1) return byName[0]!
  if (byName.length > 1 && hintSet.size > 0) {
    const hinted = byName.find((plugin) => {
      const keys = catalogMatchKeys(plugin.url)
      return (keys.path !== null && hintSet.has(keys.path)) || (keys.repo !== null && hintSet.has(keys.repo))
    })
    if (hinted !== undefined) return hinted
  }
  return null
}

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
 * install into a profile cannot see the sibling packages.
 */
export function workspaceProtocolDeps(manifest: unknown): string[] {
  if (typeof manifest !== 'object' || manifest === null) return []
  const deps = (manifest as { dependencies?: unknown }).dependencies
  if (typeof deps !== 'object' || deps === null) return []
  const names: string[] = []
  for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
    if (typeof spec === 'string' && spec.startsWith('workspace:')) names.push(name)
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
