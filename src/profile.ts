/**
 * Profile filesystem reads — everything the market learns from a dsh
 * profile directory (manifest, lockfile, installed package trees). Pure
 * functions of the directory contents; no processes, no network.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Resolve a profile name to its directory under DSH_HOME (default ~/.dsh).
 * An explicit directory is used by hosts, such as DSH Desktop, that own the
 * active profile location rather than deriving it from process environment.
 */
export function profileDir(profile: string, explicitDir?: string): string {
  if (explicitDir !== undefined) return explicitDir
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'profiles', profile)
}

/**
 * The in-box bundles dsh's profile templates install themselves — the ONLY
 * names the market hides from the installed list. Community plugins may
 * legitimately publish under the official scope (#28), so a whole-scope
 * filter would make them invisible and fail install validation.
 * (Diagnosis and fix proposed in #28 by @Lograthmic.)
 */
const INBOX_BUNDLES = new Set([
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
 * Restore the profile manifest's dependency map to a pre-operation snapshot,
 * leaving every other manifest field untouched. pnpm writes package.json
 * BEFORE it finishes installing (#65, #69: a 404/blocked-build failure lands
 * after the write), so a failed add leaves ghost dependencies that break
 * every later pnpm run — and pnpm itself can no longer remove them (the same
 * failure re-fires on any mutation). Direct manifest surgery is the only
 * reliable rollback; the lockfile is left as-is (pnpm reconciles it from the
 * manifest on the next run).
 * @returns names whose entries were dropped or reverted, empty when nothing changed.
 */
export function restoreManifestDeps(profile: string, snapshot: Record<string, string>, explicitDir?: string): string[] {
  const file = join(profileDir(profile, explicitDir), 'package.json')
  let manifest: { dependencies?: Record<string, string> }
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string> }
  } catch {
    return []
  }
  const current = manifest.dependencies ?? {}
  const touched = new Set<string>()
  for (const name of Object.keys(current)) if (current[name] !== snapshot[name]) touched.add(name)
  for (const name of Object.keys(snapshot)) if (current[name] !== snapshot[name]) touched.add(name)
  if (touched.size === 0) return []
  manifest.dependencies = { ...snapshot }
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  return [...touched]
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

/** Pinned commit per `owner/repo` from the profile lockfile's codeload tarball URLs. */
export function readLockCommits(profile: string, explicitDir?: string): Map<string, string> {
  const commits = new Map<string, string>()
  try {
    const lock = readFileSync(join(profileDir(profile, explicitDir), 'pnpm-lock.yaml'), 'utf8')
    for (const m of lock.matchAll(/codeload\.github\.com\/([^/\s]+\/[^/\s]+)\/tar\.gz\/([0-9a-f]{40})/g)) {
      commits.set(m[1].toLowerCase(), m[2])
    }
  } catch { /* no lockfile — no git installs to report */ }
  return commits
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
export function setAllowBuilds(profile: string, packages: string[], explicitDir?: string): string[] {
  const file = join(profileDir(profile, explicitDir), 'pnpm-workspace.yaml')
  let yaml = ''
  try { yaml = readFileSync(file, 'utf8') } catch { /* created below */ }
  const blockRe = /allowBuilds:\n((?:[ \t]+[^\n]*\n?)*)/
  const map: Record<string, string> = {}
  const blockMatch = blockRe.exec(yaml)
  if (blockMatch !== null) {
    for (const line of blockMatch[1].split('\n')) {
      // The key itself may contain colons: git-hosted deps are only matched
      // by a `name@git+https://…` key (#68). The anchored boolean tail makes
      // the split land on the LAST colon, never inside a `://` — and doubles
      // as the placeholder filter: pnpm's failed-install bug (#11535, seen
      // in our #56) writes a literal "set this to true or false" value,
      // which breaks every later approval until the entry is dropped.
      const m = /^[ \t]+(\S.*?)\s*:\s*(true|false)?\s*$/.exec(line)
      if (m === null || m[1] === '') continue
      map[m[1]] = m[2] ?? 'true'
    }
  }
  // Bare package names, or the server-derived stable git form
  // `name@git+https://github.com/owner/repo.git` (#68) — nothing else.
  const GIT_KEY_RE = /^[A-Za-z0-9@/_.-]+@git\+https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/
  for (const pkg of packages) {
    if (/^[A-Za-z0-9@/_.-]+$/.test(pkg) || GIT_KEY_RE.test(pkg)) map[pkg] = 'true'
  }
  const block = Object.entries(map).map(([k, v]) => `  ${k}: ${v}`).join('\n')
  const blockText = `allowBuilds:\n${block}\n`
  writeFileSync(file, blockMatch !== null ? yaml.replace(blockRe, blockText) : `${yaml.replace(/\n?$/, '\n')}${blockText}`)
  return Object.keys(map)
}
