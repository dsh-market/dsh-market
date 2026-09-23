/**
 * Profile filesystem reads — everything the market learns from a dsh
 * profile directory (manifest, lockfile, installed package trees). Pure
 * functions of the directory contents; no processes, no network.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { resolveDshHome } from './home-paths.ts'
import { githubRemoteIdentities, githubRepoIdentities, isGitHostedSpec, repoOfTarget } from './sources.ts'

/**
 * Whether a profile name follows DSH's own directory-name contract.
 *
 * Keep this aligned with `@deepseek-ai/dsh-app-boot`'s
 * `resolveProfileDir`: dots, spaces, and Unicode are ordinary name
 * characters; only empty, traversal-shaped, launcher-owned, or
 * separator-bearing names are refused.
 */
export function isDshProfileName(profile: string): boolean {
  return profile !== ''
    && profile !== '.'
    && profile !== '..'
    && profile !== 'node_modules'
    && !profile.includes('/')
    && !profile.includes('\\')
    && !profile.includes('\0')
}

/**
 * Resolve a profile name to its directory under DSH_HOME (default ~/.dsh).
 * An explicit directory is used by hosts, such as DSH Desktop, that own the
 * active profile location rather than deriving it from process environment.
 */
export function profileDir(profile: string, explicitDir?: string): string {
  if (explicitDir !== undefined) return explicitDir
  if (!isDshProfileName(profile)) throw new Error(`dsh-market: invalid profile name ${JSON.stringify(profile)}`)
  return join(resolveDshHome(), 'profiles', profile)
}

/**
 * The in-box bundles dsh's profile templates install themselves — the ONLY
 * names the market hides from the installed list. Community plugins may
 * legitimately publish under the official scope (#28), so a whole-scope
 * filter would make them invisible and fail install validation.
 * (Diagnosis and fix proposed in #28 by @Lograthmic.)
 */
export const INBOX_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
])

/** Community dependencies of the profile (in-box bundles filtered out). */
export function readInstalled(profile: string, explicitDir?: string): Record<string, string> {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir(profile, explicitDir), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const installed: Record<string, string> = {}
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (!INBOX_BUNDLES.has(name)) installed[name] = spec
    }
    return installed
  } catch {
    return {}
  }
}

/**
 * RAW dependency map of the profile manifest — including the in-box bundles
 * readInstalled() filters out. This is the rollback snapshot (#65): restoring
 * a filtered view would delete @deepseek-ai/dsh-base and friends.
 */
export function readManifestDeps(profile: string, explicitDir?: string): Record<string, string> {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir(profile, explicitDir), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    return { ...manifest.dependencies }
  } catch {
    return {}
  }
}

/**
 * For each installed package, the OTHER installed package that declares it —
 * as a dependency or a peer dependency — in its own manifest.
 *
 * pnpm's auto-install-peers writes a plugin's peers into the profile manifest
 * as direct dependencies, so a native binding a plugin needs shows up in the
 * installed list looking exactly like a plugin the user chose (#634). What
 * separates them is that somebody else asked for it.
 *
 * Ownership is decided by the first owner in sorted order, so the answer does
 * not depend on the manifest's key order. A package that declares itself is
 * ignored, and so is a cycle's other half once one owner is chosen.
 */
export function readDependencyOwners(
  profile: string,
  names: readonly string[],
  explicitDir?: string,
): Record<string, string> {
  const installed = new Set(names)
  const owners: Record<string, string> = {}
  for (const owner of [...names].sort()) {
    const manifest = readInstalledManifest(profile, owner, explicitDir)
    if (typeof manifest !== 'object' || manifest === null) continue
    const declared = manifest as { dependencies?: unknown; peerDependencies?: unknown }
    for (const field of [declared.dependencies, declared.peerDependencies]) {
      if (typeof field !== 'object' || field === null) continue
      for (const dependency of Object.keys(field as Record<string, unknown>)) {
        if (dependency === owner || !installed.has(dependency)) continue
        owners[dependency] ??= owner
      }
    }
  }
  return owners
}

/** Exact rollback state owned by one profile package operation. */
export interface ProfileManifestSnapshot {
  dependencies: Record<string, string>
  profileBundles: { present: false } | { present: true; value: unknown }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read dependencies and the exact `dsh.profile.bundles` field before a package operation. */
export function readProfileManifestSnapshot(profile: string, explicitDir?: string): ProfileManifestSnapshot {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir(profile, explicitDir), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: unknown }
    }
    const profileManifest = objectRecord(manifest.dsh?.profile)
    const present = profileManifest !== undefined && Object.hasOwn(profileManifest, 'bundles')
    return {
      dependencies: { ...manifest.dependencies },
      profileBundles: present
        ? { present: true, value: structuredClone(profileManifest.bundles) }
        : { present: false },
    }
  } catch {
    return { dependencies: {}, profileBundles: { present: false } }
  }
}

/** String package names carried by one valid bundle-list value. */
function bundleNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : []
}

/**
 * Restore the profile manifest fields a package operation may mutate:
 * `dependencies` and `dsh.profile.bundles`. pnpm and `dsh plugin add` can
 * write both before a later fetch or build-script failure (#65, #69, #339),
 * leaving either an unresolvable dependency or a bundle the next boot cannot
 * activate. Every unrelated manifest field remains untouched. The lockfile is
 * left as-is; pnpm reconciles it from the manifest on the next run.
 *
 * The write is atomic because rollback runs after another operation already
 * failed; a partial repair must not turn a valid profile into invalid JSON.
 * @returns names whose entries were dropped or reverted, empty when nothing changed.
 */
export function restoreProfileManifest(
  profile: string,
  snapshot: ProfileManifestSnapshot,
  explicitDir?: string,
): string[] {
  const file = join(profileDir(profile, explicitDir), 'package.json')
  let manifest: {
    dependencies?: Record<string, string>
    dsh?: unknown
  }
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8')) as typeof manifest
  } catch {
    return []
  }
  const current = manifest.dependencies ?? {}
  const touched = new Set<string>()
  for (const name of Object.keys(current)) {
    if (current[name] !== snapshot.dependencies[name]) touched.add(name)
  }
  for (const name of Object.keys(snapshot.dependencies)) {
    if (current[name] !== snapshot.dependencies[name]) touched.add(name)
  }

  const currentDsh = objectRecord(manifest.dsh)
  const currentProfile = objectRecord(currentDsh?.profile)
  const currentBundles = currentProfile !== undefined && Object.hasOwn(currentProfile, 'bundles')
    ? { present: true as const, value: currentProfile.bundles }
    : { present: false as const }
  const bundlesChanged = currentBundles.present !== snapshot.profileBundles.present
    || (currentBundles.present && snapshot.profileBundles.present
      && !isDeepStrictEqual(currentBundles.value, snapshot.profileBundles.value))
  if (bundlesChanged) {
    const currentNames = new Set(currentBundles.present ? bundleNames(currentBundles.value) : [])
    const snapshotNames = new Set(snapshot.profileBundles.present ? bundleNames(snapshot.profileBundles.value) : [])
    let namedBundleChange = false
    for (const name of currentNames) {
      if (!snapshotNames.has(name)) {
        touched.add(name)
        namedBundleChange = true
      }
    }
    for (const name of snapshotNames) {
      if (!currentNames.has(name)) {
        touched.add(name)
        namedBundleChange = true
      }
    }
    // Presence, order, duplicates, or a malformed non-array value can differ
    // without changing the set of package names. Still report that rollback.
    if (!namedBundleChange) touched.add('dsh.profile.bundles')
  }
  if (touched.size === 0) return []
  manifest.dependencies = { ...snapshot.dependencies }
  if (snapshot.profileBundles.present) {
    const dsh = currentDsh ?? {}
    const profileManifest = currentProfile ?? {}
    manifest.dsh = dsh
    dsh.profile = profileManifest
    profileManifest.bundles = structuredClone(snapshot.profileBundles.value)
  } else if (currentProfile !== undefined) {
    delete currentProfile.bundles
  }
  writeManifestAtomic(file, manifest)
  return [...touched]
}

/**
 * Remove a package from BOTH manifest lists — dependencies and
 * dsh.profile.bundles. The uninstall counterpart of restoreProfileManifest:
 * pnpm can fail a remove after deleting node_modules but before saving
 * package.json (the #65 write-order's mirror image — a file locked mid-
 * unlink aborts the run), leaving the manifest pointing at a package that
 * no longer exists on disk. The next boot then fails to activate the ghost
 * dependency. When disk truth says the package is gone, this finishes the
 * removal the CLI could not. Every other manifest field is untouched.
 *
 * Written atomically because it runs only after something already went wrong
 * mid-uninstall, so it is the worst place to leave a half-written manifest.
 * @returns true when either list still mentioned the package.
 */
export function dropFromManifest(profile: string, name: string, explicitDir?: string): boolean {
  const file = join(profileDir(profile, explicitDir), 'package.json')
  let manifest: { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8')) as typeof manifest
  } catch {
    return false
  }
  let touched = false
  if (manifest.dependencies !== undefined && manifest.dependencies[name] !== undefined) {
    delete manifest.dependencies[name]
    touched = true
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.includes(name)) {
    manifest.dsh!.profile!.bundles = bundles.filter(bundle => bundle !== name)
    touched = true
  }
  if (!touched) return false
  writeManifestAtomic(file, manifest)
  return true
}

/** The version actually present in the profile's node_modules, or null. */
export function readInstalledVersion(profile: string, name: string, explicitDir?: string): string | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDir(profile, explicitDir), 'node_modules', name, 'package.json'), 'utf8'),
    ) as { version?: string }
    return manifest.version ?? null
  } catch {
    return null
  }
}

/**
 * The `name` in the package.json of the directory a dependency is installed
 * under, or null. DSH Desktop requires it to equal the dependency key (#694).
 */
export function readInstalledPackageName(profile: string, name: string, explicitDir?: string): string | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDir(profile, explicitDir), 'node_modules', name, 'package.json'), 'utf8'),
    ) as { name?: unknown }
    return typeof manifest.name === 'string' ? manifest.name : null
  } catch {
    return null
  }
}

/** The installed package manifest, or null when absent or malformed. */
export function readInstalledManifest(profile: string, name: string, explicitDir?: string): unknown | null {
  try {
    return JSON.parse(
      readFileSync(join(profileDir(profile, explicitDir), 'node_modules', name, 'package.json'), 'utf8'),
    ) as unknown
  } catch {
    return null
  }
}

/**
 * Whether a package or one of its direct dependencies (including
 * optionalDependencies) ships a native addon.
 *
 * The question behind it: can unloading this plugin actually free its files?
 * For ordinary JavaScript, yes — and on POSIX it does not even matter,
 * because replacing an open file leaves the old inode to whoever holds it.
 * For a native addon it is no on both counts: Node has no dlclose, so once a
 * `.node` is loaded the process holds it until it exits. On Windows that
 * turns "uninstall, then install again" into an EPERM on the rename, which
 * is what @yandidan1 hit with node-hid (#441) — and no amount of disabling,
 * unmounting or uninstalling from inside the running process can fix it.
 *
 * Deliberately a cheap structural check rather than a scan. Walking a
 * dependency's tree for `*.node` means recursing through packages that can
 * be tens of thousands of files, on the uninstall path, to answer a question
 * three `existsSync` calls answer for every native module built or shipped
 * the conventional way: node-gyp's `build/Release`, prebuild's `prebuilds/`,
 * and the `binding.gyp` that names the addon in the first place.
 *
 * Direct `dependencies` and `optionalDependencies` are included because
 * that is where these live: the plugin is JavaScript and the addon is a
 * package it depends on, hoisted to the profile root beside it.
 * optionalDependencies is the same kind of direct declaration —
 * SinglePlayer ships node-hid there (#441), and asking only `dependencies`
 * treated that uninstall as ordinary JavaScript.
 * @param profile - profile name.
 * @param name - the installed package to ask about.
 * @param explicitDir - resolved profile directory, when the caller has it.
 * @returns true when a native addon is present in the package or a direct (optional) dependency.
 */
export function holdsNativeAddon(profile: string, name: string, explicitDir?: string): boolean {
  const modules = join(profileDir(profile, explicitDir), 'node_modules')
  const shipsAddon = (packageName: string): boolean => {
    const dir = join(modules, packageName)
    return existsSync(join(dir, 'build', 'Release'))
      || existsSync(join(dir, 'prebuilds'))
      || existsSync(join(dir, 'binding.gyp'))
  }
  if (shipsAddon(name)) return true
  const manifest = readInstalledManifest(profile, name, explicitDir)
  if (manifest === null || typeof manifest !== 'object') return false
  const names: string[] = []
  for (const block of [
    (manifest as { dependencies?: unknown }).dependencies,
    (manifest as { optionalDependencies?: unknown }).optionalDependencies,
  ]) {
    if (block === null || typeof block !== 'object') continue
    for (const dependency of Object.keys(block as Record<string, unknown>)) {
      if (PACKAGE_NAME_RE.test(dependency)) names.push(dependency)
    }
  }
  return names.some(shipsAddon)
}

const PACKAGE_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i

function localSpecDirectory(root: string, spec: string): string | null {
  const match = /^(?:link|file):(.+)$/i.exec(spec)
  if (match === null) return null
  let path = match[1]!
  try { path = decodeURIComponent(path) } catch { /* keep the literal pnpm path */ }
  // file:// URLs are uncommon in profile manifests; reject them rather than
  // guessing across platforms. Normal pnpm link:/file: directory specs reach
  // this code as absolute or profile-relative filesystem paths.
  if (path.startsWith('//')) return null
  const candidate = isAbsolute(path) ? path : resolve(root, path)
  try {
    return statSync(candidate).isDirectory() ? realpathSync(candidate) : null
  } catch {
    return null
  }
}

function installedPackageDirectory(root: string, name: string): string | null {
  try {
    const candidate = join(root, 'node_modules', name)
    return statSync(candidate).isDirectory() ? realpathSync(candidate) : null
  } catch {
    return null
  }
}

function manifestAt(dir: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as unknown
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function manifestRepository(manifest: Record<string, unknown> | null): { url: string; directory: string | null } | null {
  const repository = manifest?.repository
  if (typeof repository === 'string') return { url: repository, directory: null }
  if (typeof repository !== 'object' || repository === null) return null
  const value = repository as Record<string, unknown>
  if (typeof value.url !== 'string') return null
  return { url: value.url, directory: typeof value.directory === 'string' ? value.directory : null }
}

function gitConfigPath(marker: string, worktreeRoot: string): string | null {
  try {
    if (statSync(marker).isDirectory()) {
      const direct = join(marker, 'config')
      return existsSync(direct) ? direct : null
    }
    const pointer = /^gitdir:\s*(.+)$/im.exec(readFileSync(marker, 'utf8'))
    if (pointer === null) return null
    const gitDir = resolve(worktreeRoot, pointer[1]!.trim())
    const direct = join(gitDir, 'config')
    if (existsSync(direct)) return direct
    const commonDir = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
    const common = join(resolve(gitDir, commonDir), 'config')
    return existsSync(common) ? common : null
  } catch {
    return null
  }
}

function originFromConfig(file: string): string | null {
  try {
    let origin = false
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const section = /^\s*\[remote\s+"([^"]+)"\]\s*$/.exec(line)
      if (section !== null) {
        origin = section[1] === 'origin'
        continue
      }
      if (!origin) continue
      const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line)
      if (url !== null) return url[1]!
    }
  } catch { /* unreadable git metadata carries no identity */ }
  return null
}

function gitCheckout(start: string): { root: string; origin: string } | null {
  let current = start
  while (true) {
    const marker = join(current, '.git')
    if (existsSync(marker)) {
      const config = gitConfigPath(marker, current)
      const origin = config === null ? null : originFromConfig(config)
      return origin === null ? null : { root: current, origin }
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function checkoutSubpath(root: string, packageDir: string): string | null {
  const value = relative(root, packageDir).replaceAll('\\', '/')
  return value === '' || value === '.' || value.startsWith('../') ? null : value
}

/**
 * Strong repository identities for a locally linked dependency (#141).
 * Explicit github: specs already carry this evidence; only link:/file: need
 * filesystem discovery. This compatibility wrapper returns only declared
 * package.json identities; Git origins are exposed separately as hints.
 */
export function readInstalledRepoIdentities(
  profile: string,
  name: string,
  spec: string,
  explicitDir?: string,
): string[] {
  return readInstalledRepoEvidence(profile, name, spec, explicitDir).identities
}

export interface InstalledRepoEvidence {
  identities: string[]
  hints: string[]
}

/**
 * Discover declared repository identities and weaker local-origin hints. A
 * package.json repository declaration is authoritative; Git origin is only a
 * disambiguation hint because a checkout may legitimately point at a fork.
 *
 * Read for local AND registry specs, but never for a spec that already names
 * its own source (#544 by @QinYupan; boundary from @bulingbuling688 in #548).
 *
 * The bug: two same-named catalog entries and an ordinary npm install. The
 * manifest's `repository` — `git+https://github.com/MrmoLabs/dsh-mermaid.git`
 * — is the one fact that says WHICH of the two is installed, and it sits in
 * the same package.json for an npm install as for a local one. This returned
 * empty for anything not `link:`/`file:`, so the client fell back to name
 * matching, found two candidates, and matched NEITHER: the Discover card kept
 * offering Install on a plugin that was running.
 *
 * Why a `github:`/URL install must NOT be read the same way: its spec already
 * states the source, and the manifest can disagree with it. A fork installed
 * as `github:myfork/plugin` usually still declares the UPSTREAM repository,
 * because almost nobody edits that field when forking. Adding it as an
 * identity made the upstream's card read as installed — measured, and the
 * same mistake as #485: a weaker signal allowed to outvote a definite one.
 * The first version of this fix widened to every spec kind and had exactly
 * that hole.
 *
 * What stays local-only for the same reason it always was: the git-origin
 * hint (there is no checkout to read for a registry install) and the local
 * source directory walk.
 */
export function readInstalledRepoEvidence(
  profile: string,
  name: string,
  spec: string,
  explicitDir?: string,
): InstalledRepoEvidence {
  if (!PACKAGE_NAME_RE.test(name)) return { identities: [], hints: [] }
  const local = /^(?:link|file):/i.test(spec)
  // A spec that names its own source is the authority on it; see above. It
  // is also the ANSWER, not just the thing not to second-guess: deriving
  // nothing left a plugin installed from a URL — the shape a China-region
  // install produces, `https://<proxy>/https://codeload.github.com/o/r/
  // tar.gz/<sha>` — with no identity at all, so its catalog card never read
  // as installed (#432's symptom; its proposed mechanism, a `file:` spec
  // with a sibling url-<hash>.json, is not the layout the current dsh CLI
  // writes — measured, the spec keeps the https URL).
  //
  // The URL still must not be resolved through the package's OWN manifest:
  // a fork installed as `github:myfork/plugin` carries upstream's repository
  // field, and trusting it made upstream's card read as installed (#580).
  if (!local && (isGitHostedSpec(spec) || /^https?:/i.test(spec.trim()))) {
    const repo = repoOfTarget(spec)
    return repo === null ? { identities: [], hints: [] } : { identities: [repo], hints: [] }
  }
  const root = profileDir(profile, explicitDir)
  const sourceDir = local ? localSpecDirectory(root, spec) : null
  const installedDir = installedPackageDirectory(root, name)
  const manifestDir = installedDir ?? sourceDir
  const manifest = manifestDir === null ? readInstalledManifest(profile, name, explicitDir) : manifestAt(manifestDir)
  const repository = manifestRepository(
    typeof manifest === 'object' && manifest !== null ? manifest as Record<string, unknown> : null,
  )
  const checkoutDir = sourceDir ?? (installedDir !== null && /^(?:link):/i.test(spec) ? installedDir : null)
  const checkout = checkoutDir === null ? null : gitCheckout(checkoutDir)

  if (repository !== null) {
    const identities = githubRepoIdentities(repository.url, repository.directory)
    if (identities.length > 0) return { identities, hints: [] }
  }

  if (checkout !== null) {
    return { identities: [], hints: githubRemoteIdentities(checkout.origin, checkoutSubpath(checkout.root, checkoutDir!)) }
  }

  // node_modules is intentionally not searched upward for .git: a copied
  // file: package may sit inside an unrelated profile checkout. Only the
  // explicit local source directory is valid Git-origin evidence.
  return { identities: [], hints: [] }
}

/**
 * Where each git host puts the commit in the archive tarball it serves.
 * Every capture is `1` host, `2` repo path, `3` commit.
 *
 * Measured on every major the market supports (9.15.4 / 10.34.5 / 11.8.0 /
 * 12.4.1): an install from github.com, gitlab.com or bitbucket.org resolves
 * to an archive of that host and writes NO `type: git` entry, which is why
 * `readGitResolutionCommit` cannot see any of them. The URL is not the same
 * on every major, which is what the GitLab pair below is about.
 *
 * The host comes out of the URL rather than being assumed from the shape,
 * so a self-hosted GitLab — which serves the same `/-/archive/` path — keys
 * under its own hostname instead of sharing gitlab.com's.
 */
const ARCHIVE_COMMIT_SHAPES: readonly RegExp[] = [
  // GitHub. Matched as a substring, not anchored, because a region proxy sits
  // in FRONT of the real URL: anchoring would only ever see the proxy's own
  // hostname, while the literal `codeload.github.com` here cannot be anything
  // but the repository's host.
  /(codeload\.github\.com)\/([^/\s]+\/[^/\s]+)\/tar\.gz\/([0-9a-f]{40})/g,
  // GitLab: `…/<group>/<repo>/-/archive/<sha>/<repo>-<sha>.tar.gz`, where the
  // group may itself be nested. The path excludes `:` so that a proxied URL
  // cannot be read as one long group path under the proxy's hostname — the
  // match then starts at the inner URL instead, which is the real host.
  /https?:\/\/([^/\s]+)\/([^:\s]+?)\/-\/archive\/([0-9a-f]{40})\//g,
  // Bitbucket: `…/<owner>/<repo>/get/<sha>.tar.gz`.
  /https?:\/\/([^/\s]+)\/([^/\s]+\/[^/\s]+)\/get\/([0-9a-f]{40})\.tar\.gz/g,
  // GitLab as pnpm 9 and 10 fetch it — the REST API instead of the project
  // archive, with the repository percent-encoded into one path segment and
  // the commit in the query:
  // `…/api/v4/projects/<owner>%2F<repo>/repository/archive.tar.gz?sha=<sha>`.
  // Same repository, same commit, different URL; the decode below puts it
  // back under the same key as the 11/12 shape.
  /https?:\/\/([^/\s]+)\/api\/v4\/projects\/([^/\s?]+)\/repository\/archive[^\s?]*\?sha=([0-9a-f]{40})/g,
]

/**
 * The repository path a shape captured. Percent-decoded because pnpm 9/10
 * encode the whole `owner/repo` into one segment; the other shapes carry no
 * `%` at all, so decoding them is a no-op.
 */
function archivePath(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * Pinned commit per `host/owner/repo` from the archive tarball URLs in the
 * profile lockfile.
 *
 * Keyed by host, not by `owner/repo` alone: gitlab.com and bitbucket.org
 * hand out the same short owner/repo names GitHub does, and an unqualified
 * key would let one host's commit answer for a plugin installed from
 * another — reporting a rollback or an update check against a repository
 * the user never installed. `hostedRepoKey` builds the same key from a
 * spec, and is how callers should look one up.
 */
export function readLockCommits(profile: string, explicitDir?: string): Map<string, string> {
  const commits = new Map<string, string>()
  try {
    const lock = readFileSync(join(profileDir(profile, explicitDir), 'pnpm-lock.yaml'), 'utf8')
    for (const shape of ARCHIVE_COMMIT_SHAPES) {
      for (const m of lock.matchAll(shape)) {
        // codeload is GitHub's download host, not a repository host of its
        // own: the identity of `codeload.github.com/o/r` is `github.com/o/r`.
        const host = m[1]!.toLowerCase() === 'codeload.github.com' ? 'github.com' : m[1]!.toLowerCase()
        commits.set(`${host}/${archivePath(m[2]!).toLowerCase()}`, m[3]!.toLowerCase())
      }
    }
  } catch { /* no lockfile — no git installs to report */ }
  return commits
}

/**
 * Commit recorded for a non-codeload git resolution (`type: git` in pnpm's
 * lockfile). Matched against the install spec so a Gitea/GitLab URL can
 * compare HEAD without mistaking a same-named npm package (#525).
 *
 * Two packages of one monorepo resolve from the SAME remote and differ only
 * by pnpm's `path:` selector, so the spec's subpath has to match too — and
 * when the spec names no subpath while several entries of that remote do,
 * there is no answer rather than the first sibling's commit (#632).
 */
export function readGitResolutionCommit(
  profile: string,
  spec: string,
  explicitDir?: string,
): string | null {
  const want = normalizeGitRepoKey(spec)
  if (want === null) return null
  const wantPath = gitSubpathSelector(spec)
  const matches: string[] = []
  try {
    const lock = readFileSync(join(profileDir(profile, explicitDir), 'pnpm-lock.yaml'), 'utf8')
    for (const m of lock.matchAll(
      /resolution:\s*\{([^}]*)\}/g,
    )) {
      const body = m[1]!
      const commit = /\bcommit:\s*([0-9a-f]{40})\b/i.exec(body)
      const repo = /\brepo:\s*([^\s,}]+)/.exec(body)
      if (commit === null || repo === null) continue
      if (normalizeGitRepoKey(repo[1]!) !== want) continue
      const entryPath = /\bpath:\s*([^\s,}]+)/.exec(body)?.[1]?.replace(/^\/+|\/+$/g, '').toLowerCase() ?? null
      if (wantPath !== null) {
        if (entryPath === wantPath) return commit[1]!.toLowerCase()
        continue
      }
      matches.push(commit[1]!.toLowerCase())
    }
  } catch { /* no lockfile */ }
  // Exactly one entry for this remote is an identity; several are siblings
  // of one monorepo and none of them is THIS package's commit.
  return matches.length === 1 ? matches[0]! : null
}

/** The `path:` selector of a git spec, normalized for comparison. */
function gitSubpathSelector(spec: string): string | null {
  const hash = spec.indexOf('#')
  if (hash === -1) return null
  const selector = /(?:^|&)path:([^&]*)/.exec(spec.slice(hash + 1))?.[1]
  if (selector === undefined) return null
  const trimmed = selector.replace(/^\/+|\/+$/g, '').toLowerCase()
  return trimmed === '' ? null : trimmed
}

/** Lowercased transport-agnostic key for comparing two git remote spellings. */
function normalizeGitRepoKey(spec: string): string | null {
  let remote = spec.trim().replace(/^git\+/i, '')
  const scp = /^git@([^:]+):(.+)$/.exec(remote)
  if (scp !== null) remote = `https://${scp[1]}/${scp[2]!.replace(/^\/*/, '')}`
  const hash = remote.indexOf('#')
  if (hash !== -1) remote = remote.slice(0, hash)
  const query = remote.indexOf('?')
  if (query !== -1) remote = remote.slice(0, query)
  remote = remote.replace(/\/+$/, '').toLowerCase()
  if (!/^https?:\/\//.test(remote) && !remote.includes('.git')) return null
  return remote
}

/** True when the installed package's manifest declares a dsh plugin surface. */
export function hasDshManifest(dir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh?: unknown }
    return manifest.dsh !== undefined
  } catch {
    return false
  }
}

/**
 * True when the package's declared entry artifact actually exists — github
 * source checkouts of build-required plugins ship no lib/, and promoting one
 * into the bundle layer bricks the next boot (ERR_MODULE_NOT_FOUND kills the
 * whole profile, #18).
 */
export function entryArtifactExists(dir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      main?: string
      exports?: Record<string, unknown> | string
    }
    const candidates: string[] = []
    if (typeof manifest.main === 'string') candidates.push(manifest.main)
    const rootExport = typeof manifest.exports === 'string'
      ? manifest.exports
      : (manifest.exports as Record<string, unknown> | undefined)?.['.']
    if (typeof rootExport === 'string') candidates.push(rootExport)
    else if (rootExport !== null && typeof rootExport === 'object') {
      for (const value of Object.values(rootExport)) if (typeof value === 'string') candidates.push(value)
    }
    if (candidates.length === 0) candidates.push('index.js')
    return candidates.some(rel => existsSync(join(dir, rel)))
  } catch {
    return false
  }
}

/**
 * Package names a bundle patch mounts — the `name:` rows of the package's
 * declared `dsh.bundle.patch` file. Line-wise on purpose: the strict
 * hot-mount parser rejects config/expression rows, but for "what does this
 * bundle bring in" any name row counts.
 */
export function bundlePatchTargets(dir: string): string[] {
  return readBundlePatchRows(dir).names
}

/**
 * Loader entry ids a bundle patch inserts. Cordis refuses to boot a tree
 * with a duplicate entry id ("duplicate loader entry id: storage", #122), so
 * these are what two bundles can collide on.
 */
export function bundlePatchEntryIds(dir: string): string[] {
  return readBundlePatchRows(dir).ids
}

/**
 * Loader entry ids the patch INSERTS — the rows the package owns, as opposed
 * to rows of OTHER plugins it merely configures (#147).
 *
 * A bundle patch has two kinds of entry:
 *
 *     - insert:                     ← rows this package brings into the tree
 *         - id: vision-router
 *           name: dsh-vision-router
 *     - id: attachment-local        ← someone else's row, only reconfigured
 *       config: { maxImageBytes: … }
 *
 * Treating both as "this package's rows" made disabling one plugin write
 * `disabled: true` onto the official rows it tuned — killing attachments and
 * the DeepSeek model with it.
 */
export function bundlePatchInsertedIds(dir: string): string[] {
  return readBundlePatchRows(dir).insertedIds
}

/**
 * `name:` and `id:` rows of the package's declared bundle patch. Line-wise
 * on purpose: the strict hot-mount parser rejects config/expression rows,
 * but for "what does this bundle bring in" any row counts. `insertedIds` is
 * the subset nested under an `insert:` key (#147).
 */
/**
 * Rows of one patch file. Exported because a package may ship its patch at
 * the conventional path INSTEAD of declaring `dsh.bundle.patch`, and the
 * patch layer has to read that one by the same rules — a second hand-rolled
 * scan drifted from this one and re-introduced #147 on that path (it closed
 * the insert block only on `id:` lines, so `- disable:` followed by nested
 * ids claimed the neighbour's rows).
 */
export function parsePatchRows(text: string): { names: string[]; ids: string[]; insertedIds: string[] } {
  const names: string[] = []
  const ids: string[] = []
  const insertedIds: string[] = []
  {
    // `insert:` opens a nested list; every id below it, at deeper
    // indentation, is a row this package brings in. A row at or above the
    // `insert:` indentation closes the block — those target OTHER plugins.
    let insertIndent: number | null = null
    // CRLF too, for consistency with the hot-mount parser, which a
    // Windows-authored patch genuinely broke. Here it changes no outcome
    // today — every row pattern below is `^`-anchored and a comment line
    // always starts with `#`, so an unstripped comment matches nothing —
    // and it is deliberately NOT covered by a spec, because a test that
    // passes with or without the change tests nothing.
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '')
      if (line.trim() === '') continue
      const indent = line.length - line.trimStart().length
      if (insertIndent !== null && indent <= insertIndent && !/^\s*-?\s*(id|name|config):/u.test(line)) {
        insertIndent = null
      }
      if (/^\s*-?\s*insert:\s*$/u.test(line)) {
        insertIndent = indent
        continue
      }
      const name = /^\s*-?\s*name:\s*['"]?([^'"\s]+)/.exec(line)
      if (name !== null && !names.includes(name[1])) names.push(name[1])
      const id = /^\s*-?\s*id:\s*['"]?([^'"\s]+)/.exec(line)
      if (id !== null) {
        if (!ids.includes(id[1])) ids.push(id[1])
        // A top-level `- id:` row closes any open insert block: it is a
        // sibling of `- insert:`, not a member of it.
        if (insertIndent !== null && indent > insertIndent) {
          if (!insertedIds.includes(id[1])) insertedIds.push(id[1])
        } else if (indent <= (insertIndent ?? -1)) {
          insertIndent = null
        }
      }
    }
  }
  return { names, ids, insertedIds }
}

/** Rows of the patch a package DECLARES through `dsh.bundle.patch`. */
/**
 * Where a package's bundle patch lives, according to the package itself.
 *
 * `dsh.bundle.patch` is the package's own declaration and the only place the
 * answer is written down: the path may be a subdirectory (`aegis` declares
 * `./extensions/dsh/cordis.patch.yml`), not just the package root. Callers
 * that assumed the root file made a plugin with a declared patch look like
 * one with none (#646) — so the resolution rule lives here, once.
 *
 * @param dir - the installed package directory.
 * @returns the declared patch file's path, or null when the manifest names
 *   none (or the manifest cannot be read).
 */
export function declaredBundlePatchFile(dir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: unknown } }
    }
    const declared = manifest.dsh?.bundle?.patch
    if (typeof declared !== 'string' || declared === '') return null
    return join(dir, declared)
  } catch {
    return null
  }
}

function readBundlePatchRows(dir: string): { names: string[]; ids: string[]; insertedIds: string[] } {
  const empty = { names: [], ids: [], insertedIds: [] }
  const file = declaredBundlePatchFile(dir)
  if (file === null) return empty
  try {
    return parsePatchRows(readFileSync(file, 'utf8'))
  } catch {
    return empty
  }
}

/** The profile manifest's `dsh.profile.bundles` — what the CLI reconciled. */
export function readProfileBundles(profileDirectory: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDirectory, 'package.json'), 'utf8')) as {
      dsh?: { profile?: { bundles?: unknown } }
    }
    const bundles = manifest.dsh?.profile?.bundles
    return Array.isArray(bundles) ? bundles.filter((name): name is string => typeof name === 'string') : []
  } catch {
    return []
  }
}

/**
 * Write the profile manifest atomically: a temp file in the same directory is
 * written first, then renamed over package.json, so a crash mid-toggle never
 * leaves a half-written manifest (the same guarantee order.ts's writer gives
 * the reorder path). The trailing newline + 2-space indent match how every
 * other writer in this repo serializes the manifest.
 */
function writeManifestAtomic(manifestPath: string, manifest: unknown): void {
  const temp = `${manifestPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(temp, manifestPath)
}

/**
 * Drop one bundle from the profile manifest's `dsh.profile.bundles`, leaving
 * the package installed as a dependency. This is the carrier-bundle half of a
 * toggle-off (#224): a bundle whose patch reconfigures plugins it does NOT own
 * (dsh-postgres-backends disables session-persistence-jsonl and reroutes
 * storage-domain) keeps applying those side-effect rows on every boot while it
 * stays in the stack, and the #147 ownership rule deliberately never writes
 * them — so removing the bundle from the stack is the only thing that stops
 * them all at once. The package itself stays installed; enabling re-adds it.
 * @returns true when the bundle was present and removed.
 */
export function removeProfileBundle(profileDirectory: string, name: string): boolean {
  const manifestPath = join(profileDirectory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dsh?: { profile?: { bundles?: unknown } }
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return false
  const next = bundles.filter((entry): entry is string => typeof entry !== 'string' || entry !== name)
  if (next.length === bundles.length) return false
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  manifest.dsh.profile.bundles = next
  writeManifestAtomic(manifestPath, manifest)
  return true
}

/**
 * Re-add a bundle to `dsh.profile.bundles` after a carrier toggle-off (#224).
 * Idempotent: a bundle already present is left untouched. The name is appended
 * (the install flow appends too); the loader re-validates ordering on the next
 * composition, so a declared before/after rule surfaces there rather than here.
 * @returns true when the bundle was added, false when it was already present.
 */
export function addProfileBundle(profileDirectory: string, name: string): boolean {
  const manifestPath = join(profileDirectory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dsh?: { profile?: { bundles?: unknown } }
  }
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const existing = manifest.dsh.profile.bundles
  const bundles = Array.isArray(existing) ? existing.filter((entry): entry is string => typeof entry === 'string') : []
  if (bundles.includes(name)) return false
  bundles.push(name)
  manifest.dsh.profile.bundles = bundles
  writeManifestAtomic(manifestPath, manifest)
  return true
}

/**
 * Loader entry ids a newly added package would collide on with bundles the
 * profile ALREADY loads (#122).
 *
 * Cordis hard-fails the whole tree on a duplicate id, so this is not a
 * cosmetic conflict: installing a TUI bundle into a web profile (both
 * declare `id: storage`) leaves DSH unable to start at all, with an error
 * naming neither plugin. Checked against the profile's own bundle list so a
 * package is never compared with itself.
 * @returns colliding ids mapped to the already-installed bundle that owns them.
 */
export function conflictingEntryIds(
  profileDirectory: string,
  candidate: string,
  installedBundles: readonly string[],
): { id: string; owner: string }[] {
  // INSERTED ids on both sides, not every id in the file. What bricks the
  // next boot is two entries created under one id; a row that merely
  // CONFIGURES another plugin's entry creates nothing, so counting it here
  // refuses a legitimate plugin outright — the same distinction #147 drew
  // for the disable path, which this guard was left out of.
  const mine = bundlePatchInsertedIds(join(profileDirectory, 'node_modules', candidate))
  if (mine.length === 0) return []
  const conflicts: { id: string; owner: string }[] = []
  for (const bundle of installedBundles) {
    if (bundle === candidate) continue
    const theirs = new Set(bundlePatchInsertedIds(join(profileDirectory, 'node_modules', bundle)))
    for (const id of mine) {
      if (theirs.has(id) && !conflicts.some(hit => hit.id === id)) conflicts.push({ id, owner: bundle })
    }
  }
  return conflicts
}

/**
 * Whether the loader has anything to load for this package: its own entry
 * artifact, or — for CARRIER bundles — patch rows naming other packages that
 * do have one.
 *
 * Carriers are why `entryArtifactExists` alone is the wrong test (#103):
 * `@linxin666/dsh-skins` ships skin assets plus a patch mounting
 * `@linxin666/dsh-client-ui-skin-center`, and declares no main/exports/
 * index.js of its own. Judged by its own entry it looks like the
 * source-only checkout the #18 guard removes — so the market both flagged it
 * broken AND uninstalled it right after installing.
 * @param profileDirectory - resolved profile directory (host-authoritative under Desktop).
 * @param name - installed package name.
 */
export function hasLoadableEntry(profileDirectory: string, name: string): boolean {
  const dir = join(profileDirectory, 'node_modules', name)
  if (entryArtifactExists(dir)) return true
  // A carrier is only sound when something it mounts is itself loadable.
  // Targets resolve hoisted (the dsh profile default), nested under the
  // carrier, or — #203 — one level up: pnpm hoists shared/in-box packages to
  // `<profiles>/node_modules` when the profile is a workspace member, the
  // same workspace-root fallback readProfileVisibleVersion (check.ts) already
  // uses. A carrier naming an in-box package (@deepseek-ai/dsh-mcp-client and
  // similar) resolves there and nowhere this function used to look, so pnpm
  // exiting 0 was immediately followed by the market removing what it had
  // just, correctly, installed.
  const workspaceRoot = dirname(profileDirectory)
  return bundlePatchTargets(dir)
    .filter(target => target !== name)
    .some(target => entryArtifactExists(join(profileDirectory, 'node_modules', target))
      || entryArtifactExists(join(dir, 'node_modules', target))
      || entryArtifactExists(join(workspaceRoot, 'node_modules', target)))
}

/** Plugin subdirectories (depth 2) of a collection checkout, as relative paths. */
export function pluginSubdirs(root: string): string[] {
  const found: string[] = []
  let level1: string[] = []
  try {
    level1 = readdirSync(root, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && /^[A-Za-z0-9_.-]+$/.test(dirent.name) && dirent.name !== 'node_modules')
      .map(dirent => dirent.name)
  } catch {
    return found
  }
  for (const sub of level1) {
    if (hasDshManifest(join(root, sub))) {
      found.push(sub)
      continue
    }
    try {
      for (const inner of readdirSync(join(root, sub), { withFileTypes: true })) {
        if (!inner.isDirectory() || !/^[A-Za-z0-9_.-]+$/.test(inner.name) || inner.name === 'node_modules') continue
        if (hasDshManifest(join(root, sub, inner.name))) found.push(`${sub}/${inner.name}`)
      }
    } catch { /* unreadable level — skip */ }
    if (found.length >= 8) break
  }
  return found.slice(0, 8)
}

/**
 * Allow the given packages' build scripts in the profile's
 * pnpm-workspace.yaml `allowBuilds` block (the key dsh profiles use),
 * merging with existing entries and leaving the rest of the yaml intact.
 * (#6 by @qichuang321.)
 * @returns every package now allowed.
 */
/**
 * Quote a YAML block-mapping key when a plain scalar would be invalid.
 * Scoped npm names start with `@` — a reserved YAML indicator — so an
 * unquoted `@scope/pkg: true` entry breaks the whole pnpm-workspace.yaml
 * for every later pnpm run in the profile (and for the market itself).
 * Keys containing `: ` or ending with `:` are quoted for the same reason;
 * git keys like `name@git+https://…` keep their existing plain form.
 */
function quoteYamlKey(key: string): string {
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(key) || /:(\s|$)/.test(key)) {
    return `'${key.replace(/'/g, "''")}'`
  }
  return key
}

/**
 * Allow the given packages' build scripts in the profile's
 * pnpm-workspace.yaml `allowBuilds` block (the key dsh profiles use),
 * merging with existing entries and leaving the rest of the yaml intact.
 * (#6 by @qichuang321.)
 * @returns every package now allowed.
 */
export function setAllowBuilds(profile: string, packages: string[], explicitDir?: string): string[] {
  const file = join(profileDir(profile, explicitDir), 'pnpm-workspace.yaml')
  let yaml = ''
  try { yaml = readFileSync(file, 'utf8') } catch { /* created below */ }
  // `\r?\n`, not `\n`: a CRLF pnpm-workspace.yaml (every Windows editor, and
  // git with core.autocrlf=true) put a `\r` between `allowBuilds:` and the
  // newline, so the old pattern never matched an EXISTING block and appended
  // a second one. Two top-level `allowBuilds:` keys is invalid YAML, and pnpm
  // then refuses every install in that profile — not just the one that
  // triggered it (#231 by @MichengAI).
  const blockRe = /allowBuilds:[ \t]*\r?\n((?:[ \t]+[^\r\n]*\r?\n?)*)/g
  const map: Record<string, string> = {}
  // Every block, not just the first: a profile already broken by the bug
  // above carries two, and merging them is what repairs it — dropping the
  // extra silently would also drop whatever approvals it held.
  const blockMatches = [...yaml.matchAll(blockRe)]
  const blockMatch = blockMatches[0] ?? null
  for (const match of blockMatches) {
    for (const line of match[1].split(/\r?\n/)) {
      // The key itself may contain colons: git-hosted deps are only matched
      // by a `name@git+https://…` key (#68). The anchored boolean tail makes
      // the split land on the LAST colon, never inside a `://` — and doubles
      // as the placeholder filter: pnpm's failed-install bug (#11535, seen
      // in our #56) writes a literal "set this to true or false" value,
      // which breaks every later approval until the entry is dropped.
      const m = /^[ \t]+(\S.*?)\s*:\s*(true|false)?\s*$/.exec(line)
      if (m === null || m[1] === '') continue
      // Entries this fix wrote may carry single/double quotes around the key
      // (reserved indicators like `@` cannot start a plain scalar); strip
      // them so the map key is the bare package name and a later rewrite
      // never nests quotes.
      let key = m[1]
      if (key.length >= 2
        && (key[0] === "'" && key[key.length - 1] === "'" || key[0] === '"' && key[key.length - 1] === '"')) {
        key = key.slice(1, -1)
      }
      map[key] = m[2] ?? 'true'
    }
  }
  // What may be written, and nothing else. The allowlist is not a host
  // trust boundary — every key here is derived from the profile's OWN
  // manifest or the curated catalog — it is what stops a caller writing
  // arbitrary text into a file pnpm parses, so each form is spelled out
  // exactly rather than loosened into "anything with a URL in it".
  //
  // A path segment must start with something other than a dot, which is how
  // `..` traversal would otherwise enter a shape that looks like a repo.
  const SEG = '[A-Za-z0-9_-][A-Za-z0-9_.-]*'
  const NAME = '[A-Za-z0-9@/_.-]+'
  const SHA = '[0-9a-f]{40}'
  // The stable clone-URL key: github's (#68) and, since #637, every other
  // host's — pnpm keys a git dependency by the remote it would clone, whoever
  // serves it. Optionally pinned to a commit, which is the form pnpm 11.8.0
  // names for a plain remote. https only: the market installs from https
  // remotes, and an http key would authorize a source it never writes.
  //
  // The `.git` suffix is optional because pnpm keys the remote exactly as it
  // was spelled: measured on 12.4.1, a remote installed without `.git`
  // authorizes under `name@git+…/repo` and NOT under `…/repo.git`, so
  // requiring the suffix dropped a correctly derived key on its way out, and
  // appending it would have written one pnpm never reads.
  const GIT_KEY_RE = new RegExp(
    `^${NAME}@git\\+https://[A-Za-z0-9_.-]+(?::\\d{1,5})?/${SEG}(?:/${SEG})*(?:\\.git)?(?:#${SHA})?$`,
  )
  // The commit-pinned download a host serves, which is what pnpm below 11.21
  // matches instead (#285): codeload for github, the project archive for
  // gitlab.com and bitbucket.org (#637). Each branch names its host and its
  // exact path shape.
  const ARCHIVE_KEY_RE = new RegExp(
    `^${NAME}@https://(?:`
    + `codeload\\.github\\.com/${SEG}/${SEG}/tar\\.gz/${SHA}`
    + `|bitbucket\\.org/${SEG}/${SEG}/get/${SHA}\\.tar\\.gz`
    + `|gitlab\\.com/${SEG}(?:/${SEG})+/-/archive/${SHA}/${SEG}-${SHA}\\.tar\\.gz`
    + ')$',
  )
  for (const pkg of packages) {
    if (/^[A-Za-z0-9@/_.-]+$/.test(pkg) || GIT_KEY_RE.test(pkg) || ARCHIVE_KEY_RE.test(pkg)) map[pkg] = 'true'
  }
  // Write back in the file's OWN line ending. Rewriting a CRLF workspace
  // file with LF would leave it mixed, which is the same class of mess this
  // fix exists to clean up.
  const eol = /\r\n/.test(yaml) ? '\r\n' : '\n'
  const block = Object.entries(map).map(([k, v]) => `  ${quoteYamlKey(k)}: ${v}`).join(eol)
  const blockText = `allowBuilds:${eol}${block}${eol}`
  let next: string
  if (blockMatch === null) {
    next = `${yaml.replace(/\r?\n?$/, eol)}${blockText}`
  } else {
    // The merged block replaces the first occurrence; any further ones are
    // the duplicates this bug created and are dropped — their entries are
    // already folded into `map` above, so nothing is lost.
    let seen = 0
    next = yaml.replace(blockRe, () => (seen++ === 0 ? blockText : ''))
  }
  writeFileSync(file, next)
  return Object.keys(map)
}
