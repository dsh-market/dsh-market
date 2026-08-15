/**
 * Install orchestration: collection-repo retargeting, post-install
 * validation that keeps broken pieces from bricking the next boot, and
 * update staleness detection. Every function takes the plugin runner as a
 * parameter so tests can substitute a recording fake.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { InstallResult, PluginRunner } from './dsh-cli.ts'
import { classifyPnpmFailure } from './pnpm-compat.ts'
import { entryArtifactExists, hasDshManifest, pluginSubdirs, profileDir, readInstalled } from './profile.ts'
import { logEvent } from './log.ts'

/** One-shot bypass for pnpm's fresh-release hold; scoped to a single command. */
export const RELEASE_AGE_OVERRIDE = '--config.minimumReleaseAge=0'

/**
 * Run one plugin command with automatic recovery from two known pnpm traps:
 *
 * - pnpm-major drift (#20 bug 2): a modules directory built by a different
 *   pnpm major fails mutation; pnpm's documented remedy is one `install` to
 *   recreate it — do that silently and retry the original command once.
 * - release-age lockfile lock (#39): once a too-young release is in the
 *   lockfile, pnpm 11 rejects EVERY later add/remove during verification —
 *   retry once with the one-shot minimumReleaseAge bypass (safe: the young
 *   package is already installed; the bypass only lets pnpm touch the
 *   lockfile again).
 *
 * Any recognized failure that survives gets its bilingual explanation
 * appended to stderr so the UI shows an actionable message instead of a
 * wall of text (#20 bug 3). Cancelled runs are never recovered.
 */
export async function withHoistRecovery(run: PluginRunner, profile: string, pluginArgs: string[]): Promise<InstallResult> {
  let result = await run(profile, pluginArgs)
  const ok = (r: InstallResult): boolean => r.exitCode === 0 && !r.timedOut && !r.cancelled
  if (!ok(result) && !result.cancelled) {
    const failure = classifyPnpmFailure(`${result.stderr}\n${result.stdout}`)
    if (failure?.code === 'hoist-pattern-diff') {
      logEvent('warn', 'install', `modules dir was built by a different pnpm major — rebuilding (pnpm install) and retrying once`)
      // --no-frozen-lockfile: the market runs pnpm with CI=true (TTY hangs),
      // where a lockfile written by the old major would otherwise be refused.
      const rebuild = await run(profile, ['install', '--no-frozen-lockfile'])
      if (ok(rebuild)) result = await run(profile, pluginArgs)
    } else if (
      failure?.code === 'release-age-violation'
      && (pluginArgs[0] === 'add' || pluginArgs[0] === 'remove')
      && !pluginArgs.includes(RELEASE_AGE_OVERRIDE)
    ) {
      logEvent('warn', 'install', `a too-young release blocks pnpm's lockfile verification (#39) — retrying once with ${RELEASE_AGE_OVERRIDE}`)
      result = await run(profile, [pluginArgs[0], RELEASE_AGE_OVERRIDE, ...pluginArgs.slice(1)])
    }
  }
  if (!ok(result) && !result.cancelled) {
    const failure = classifyPnpmFailure(`${result.stderr}\n${result.stdout}`)
    if (failure !== null) result = { ...result, stderr: `${result.stderr}\n\n${failure.message}` }
  }
  return result
}

/**
 * Some registry entries point at collection repos whose actual plugin lives
 * in a subdirectory — the root has no package.json (or a workspace root with
 * no dsh surface), and pnpm installs the bare fileset with exit 0. Detect
 * that junk install, drop it, and re-add each plugin subdirectory through
 * pnpm's `#path:` selector (#18).
 * @returns overall success (true when nothing needed retargeting).
 */
export async function retargetCollections(
  run: PluginRunner, profile: string, before: Set<string>, target: string, explicitDir?: string,
): Promise<boolean> {
  if (!target.startsWith('github:')) return true
  const dir = profileDir(profile, explicitDir)
  const junk = Object.keys(readInstalled(profile, dir)).filter((name) => {
    if (before.has(name)) return false
    const root = join(dir, 'node_modules', name)
    if (!existsSync(join(root, 'package.json'))) return true
    return !hasDshManifest(root)
  })
  let allOk = true
  for (const name of junk) {
    const root = join(dir, 'node_modules', name)
    const candidates = pluginSubdirs(root)
    logEvent('info', 'install', `${name}: collection repo (root declares no dsh manifest); plugins inside: ${candidates.join(', ') || 'none'}`)
    await run(profile, ['remove', name])
    if (candidates.length === 0) {
      allOk = false
      continue
    }
    for (const sub of candidates) {
      const result = await run(profile, ['add', `${target}#path:/${sub}`])
      if (result.exitCode !== 0 || result.timedOut) {
        allOk = false
        logEvent('error', 'install',
          `${target}#path:/${sub}: exit=${String(result.exitCode)}${result.timedOut ? ' TIMEOUT' : ''} — ${(result.stderr || result.stdout).slice(-220)}`)
      }
    }
  }
  return allOk
}

/**
 * Fake-success guard (#18): validate every package the install added. A
 * piece without a dsh manifest or without its declared entry artifact
 * (source-only checkout, build blocked by pnpm allowBuilds) would brick the
 * next boot, so it is removed on the spot.
 * @returns names kept and names removed as broken.
 */
export async function validateAddedPlugins(
  run: PluginRunner, profile: string, before: Set<string>, explicitDir?: string,
): Promise<{ keep: string[]; removedBroken: string[] }> {
  const dir = profileDir(profile, explicitDir)
  const addedNow = Object.keys(readInstalled(profile, dir)).filter(n => !before.has(n))
  const keep: string[] = []
  const removedBroken: string[] = []
  for (const n of addedNow) {
    const packageDir = join(dir, 'node_modules', n)
    if (hasDshManifest(packageDir) && entryArtifactExists(packageDir)) {
      keep.push(n)
    } else {
      removedBroken.push(n)
      await run(profile, ['remove', n])
    }
  }
  return { keep, removedBroken }
}

/**
 * Whether a clean-exit update actually changed nothing — pnpm's
 * minimumReleaseAge silently keeps the old version and exits 0 when the new
 * release is "too young" (#13, #22), so a clean exit alone does not mean the
 * update happened.
 */
export function isStaleUpdate(check: {
  isGit: boolean
  beforeVersion: string | null
  afterVersion: string | null
  beforeCommit: string | null
  afterCommit: string | null
}): boolean {
  return check.isGit
    ? check.beforeCommit !== null && check.afterCommit === check.beforeCommit
    : check.beforeVersion !== null && check.afterVersion === check.beforeVersion
}

/**
 * The package pnpm's fetcher refused to prepare because its build script is
 * not allowlisted — `The git-hosted package "name@2.8.0" needs to execute
 * build scripts but is not in the "allowBuilds" allowlist.` Null when the
 * output is not this failure. Unlike ignored-builds, the package is NOT in
 * node_modules yet (the fetcher rejects before materialization, #68).
 */
export function parsePrepareNotAllowed(stdout: string, stderr: string): string | null {
  const m = /git-hosted package "([^"]+)" needs to execute build scripts/.exec(`${stdout}\n${stderr}`)
  if (m === null) return null
  // Strip the trailing @version — the name itself may be scoped (@scope/pkg).
  const raw = m[1].trim()
  const at = raw.lastIndexOf('@')
  return at > 0 ? raw.slice(0, at) : raw
}

/**
 * Package names pnpm reported as having their build scripts ignored
 * ("Ignored build scripts: esbuild, koffi."). Empty when none.
 * (#6 by @qichuang321.)
 */
export function parseIgnoredBuilds(stdout: string, stderr: string): string[] {
  const m = /Ignored build scripts:?\s*([^\n]+)/i.exec(`${stdout}\n${stderr}`)
  if (m === null) return []
  const found: string[] = []
  for (const chunk of m[1].split(',')) {
    // Entries may carry a version suffix and the sentence's final period.
    const trimmed = chunk.trim().replace(/\.$/, '')
    if (trimmed === '') continue
    const at = trimmed.lastIndexOf('@')
    const name = at > 0 ? trimmed.slice(0, at) : trimmed
    if (name !== '' && !found.includes(name)) found.push(name)
  }
  return found
}
