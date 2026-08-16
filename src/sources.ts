/**
 * Registry-source knowledge: how a curated registry entry's URL maps to an
 * installable pnpm target. Pure string logic, no I/O.
 */

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

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
    if (!/^[A-Za-z0-9_./-]+$/.test(subpath)) return null
    // No empty/dot segments: `..` would escape the repo in the #path: selector.
    if (subpath.split('/').some(seg => seg === '' || seg === '.' || seg === '..')) return null
  }
  return { repo: m[1], subpath }
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
