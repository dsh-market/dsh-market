/**
 * Install orchestration: collection-repo retargeting, post-install
 * validation that keeps broken pieces from bricking the next boot, and
 * update staleness detection. Every function takes the plugin runner as a
 * parameter so tests can substitute a recording fake.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { InstallResult, PluginRunner } from './dsh-cli.ts'
import { classifyPnpmFailure, isTransientPnpmFailure } from './pnpm-compat.ts'
import { conflictingEntryIds, hasDshManifest, hasLoadableEntry, pluginSubdirs, profileDir, readInstalled, readProfileBundles } from './profile.ts'
import { logEvent } from './log.ts'
import { cleanOrphanedStore } from './store.ts'

/** One-shot bypass for pnpm's fresh-release hold; scoped to a single command. */
export const RELEASE_AGE_OVERRIDE = '--config.minimumReleaseAge=0'

/**
 * Longer per-request fetch timeout for one retried command. pnpm's default
 * 60-second limit aborts large tarball downloads (github: sources fetch the
 * WHOLE repo even for a `#path:` subdirectory plugin) on slow networks; a
 * plain retry fails again at the same limit, so the recovery re-runs with
 * this override once. Scoped to a single command like RELEASE_AGE_OVERRIDE.
 */
export const FETCH_TIMEOUT_OVERRIDE = '--config.fetchTimeout=600000'

/**
 * Run one plugin command with automatic recovery from three known pnpm traps:
 *
 * - pnpm-major drift (#20 bug 2): a modules directory built by a different
 *   pnpm major fails mutation; pnpm's documented remedy is one `install` to
 *   recreate it — do that silently and retry the original command once.
 * - release-age lockfile lock (#39): once a too-young release is in the
 *   lockfile, pnpm 11 rejects EVERY later add/remove during verification —
 *   retry once with the one-shot minimumReleaseAge bypass (safe: the young
 *   package is already installed; the bypass only lets pnpm touch the
 *   lockfile again).
 * - per-request fetch timeout: large tarballs (github: sources fetch the
 *   whole repo even for a `#path:` subdirectory) on slow networks blow
 *   pnpm's default 60-second limit; a plain retry fails again at the same
 *   limit, so retry once with a longer fetchTimeout.
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
    } else if (
      failure?.code === 'transient-network'
      && (pluginArgs[0] === 'add' || pluginArgs[0] === 'remove')
    ) {
      // #83: pnpm replays the whole tree, so any existing dependency's
      // momentary network hiccup fails the run — and a plain retry succeeds.
      // Do that retry ourselves instead of reporting a false failure.
      logEvent('warn', 'install', `transient network failure while pnpm replayed the dependency tree (#83) — retrying once`)
      result = await run(profile, pluginArgs)
    } else if (
      failure?.code === 'fetch-timeout'
      && (pluginArgs[0] === 'add' || pluginArgs[0] === 'remove')
      && !pluginArgs.includes(FETCH_TIMEOUT_OVERRIDE)
    ) {
      // Large tarball / slow network: pnpm's default 60s per-request limit
      // aborted the download. A plain retry fails again at the same limit,
      // so retry once with a longer fetchTimeout.
      logEvent('warn', 'install', `pnpm's per-request fetch timeout aborted a large download — retrying once with ${FETCH_TIMEOUT_OVERRIDE}`)
      result = await run(profile, [pluginArgs[0], FETCH_TIMEOUT_OVERRIDE, ...pluginArgs.slice(1)])
    }
  }
  if (!ok(result) && !result.cancelled) {
    // A failed, timed-out, or killed run never finishes pnpm's staging, so
    // its store tmp dirs (the WHOLE repo tarball for github: sources) are
    // orphaned — reclaim them now that no pnpm is running. Safe by
    // construction: directories are only removed when their owning pid is
    // gone (the name carries it), so a live download is never touched.
    await cleanOrphanedStore(run, profile)
    const failure = classifyPnpmFailure(`${result.stderr}\n${result.stdout}`)
    if (failure !== null) {
      result = { ...result, stderr: `${result.stderr}\n\n${failure.message}` }
    } else if (result.pnpmError !== undefined && result.pnpmError !== '') {
      // Nothing matched, but pnpm DID say what went wrong — in its ndjson
      // stream, which never reaches stderr. Without this the user is shown
      // the tail of dsh's wrapper output ("pnpm failed in profile
      // directory …"), which is byte-identical for every possible cause and
      // is why #244, #192 and #138 all read as "the UI shows a stack tail".
      //
      // An unrecognized error is exactly the case where the raw text is
      // worth the most: a classified one has a written explanation, this one
      // has only pnpm's own words, and hiding them leaves nothing at all.
      const code = result.pnpmErrorCode === undefined ? '' : `${result.pnpmErrorCode}: `
      result = { ...result, stderr: `${result.stderr}\n\n${code}${result.pnpmError}` }
    }
  }
  return result
}

/**
 * The most specific description of a failed run available, for logs.
 *
 * pnpm's structured error beats the stderr tail whenever there is one — see
 * withHoistRecovery above for why the tail is nearly worthless here.
 */
export function failureDetail(result: InstallResult, limit = 300): string {
  if (result.pnpmError !== undefined && result.pnpmError !== '') {
    const code = result.pnpmErrorCode === undefined ? '' : `${result.pnpmErrorCode}: `
    return `${code}${result.pnpmError}`.slice(0, limit)
  }
  return (result.stderr || result.stdout).slice(-limit)
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
 *
 * Since #122 this also covers duplicate loader entry ids: cordis refuses to
 * load a tree containing two entries with one id, so a TUI bundle landing in
 * a web profile (both declare `id: storage`) leaves DSH unable to START —
 * an error naming neither plugin, from which the market's own page is
 * unreachable. Such a package is removed like any other bricking piece.
 * @returns names added by this run, names kept, names removed as broken,
 * and the id conflicts found. `added` is reported separately from `keep`
 * because an EMPTY `added` is a different failure from "everything added was
 * unloadable": it means the install reported success without touching the
 * profile at all, which is a broken plugin-command channel rather than
 * anything wrong with the plugin (#258).
 */
export async function validateAddedPlugins(
  run: PluginRunner, profile: string, before: Set<string>, explicitDir?: string,
): Promise<{ added: string[]; keep: string[]; removedBroken: string[]; conflicts: { name: string; id: string; owner: string }[] }> {
  const dir = profileDir(profile, explicitDir)
  const addedNow = Object.keys(readInstalled(profile, dir)).filter(n => !before.has(n))
  const keep: string[] = []
  const removedBroken: string[] = []
  const conflicts: { name: string; id: string; owner: string }[] = []
  // Compare against what the profile already loads, minus this install's own
  // additions — two pieces of one plugin are not "already installed".
  const existingBundles = readProfileBundles(dir).filter(name => !addedNow.includes(name))
  for (const n of addedNow) {
    const packageDir = join(dir, 'node_modules', n)
    // hasLoadableEntry, not entryArtifactExists: carrier bundles legitimately
    // ship no entry of their own (#103) and must not be uninstalled here.
    if (!hasDshManifest(packageDir) || !hasLoadableEntry(dir, n)) {
      removedBroken.push(n)
      await run(profile, ['remove', n])
      continue
    }
    const clash = conflictingEntryIds(dir, n, existingBundles)
    if (clash.length > 0) {
      // Keeping it would make the NEXT BOOT fail outright (#122).
      conflicts.push(...clash.map(hit => ({ name: n, ...hit })))
      removedBroken.push(n)
      logEvent('error', 'install',
        `${n}: loader entry id conflict with ${clash[0].owner} (${clash.map(hit => hit.id).join(', ')}) — removing, it would break the next boot`)
      await run(profile, ['remove', n])
      continue
    }
    keep.push(n)
  }
  return { added: addedNow, keep, removedBroken, conflicts }
}

/**
 * Group flat `{id, owner}` conflict hits by the installed plugin that owns
 * them. What the user has to decide is which PLUGINS to uninstall, not which
 * ids to resolve, so one row per owner is the unit the market renders and
 * acts on. Flattening the other way (one row per id) also misattributes when
 * a candidate clashes with several installed plugins at once.
 * @param conflicts flat hits as returned by {@link validateAddedPlugins}.
 * @returns one entry per owner, owners and ids both in first-seen order.
 */
export function groupConflictsByOwner(
  conflicts: readonly { id: string; owner: string }[],
): { owner: string; ids: string[] }[] {
  const byOwner = new Map<string, string[]>()
  for (const hit of conflicts) {
    const ids = byOwner.get(hit.owner)
    if (ids === undefined) byOwner.set(hit.owner, [hit.id])
    else if (!ids.includes(hit.id)) ids.push(hit.id)
  }
  return [...byOwner].map(([owner, ids]) => ({ owner, ids }))
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
  // The market always runs pnpm with --reporter=ndjson, so this sentence
  // usually arrives inside a JSON string with its quotes escaped (#113):
  //   … git-hosted package \"pkg@1.0.0\" needs to execute build scripts …
  // Unescape before matching, or the ndjson path — the ONLY path in
  // production — silently returns null and the approve banner never shows.
  const text = `${stdout}\n${stderr}`.replace(/\\"/g, '"')
  const m = /git-hosted package "([^"]+)" needs to execute build scripts/.exec(text)
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
