/**
 * Install orchestration: collection-repo retargeting, post-install
 * validation that keeps broken pieces from bricking the next boot, and
 * update staleness detection. Every function takes the plugin runner as a
 * parameter so tests can substitute a recording fake.
 */

import { closeSync, existsSync, lstatSync, openSync, readlinkSync, readSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { InstallResult, PluginRunner } from './dsh-cli.ts'
import { findDshInstallDir } from './dsh-install.ts'
import { classifyPnpmFailure, HOST_NAMESPACE_RE, isTransientPnpmFailure } from './pnpm-compat.ts'
import { conflictingEntryIds, dropFromManifest, hasDshManifest, hasLoadableEntry, pluginSubdirs, profileDir, readInstalled, readManifestDeps, readProfileBundles, dropUnparseableBuildKeys } from './profile.ts'
import { logEvent } from './log.ts'
import { cleanOrphanedStore } from './store.ts'

/**
 * One-shot bypass for pnpm's fresh-release hold; scoped to a single command.
 *
 * Spelled like the .npmrc key, not the camelCase pnpm-workspace.yaml one:
 * from pnpm 12.3.0 (the native CLI) `--config.minimumReleaseAge=0` is
 * silently ignored — no unknown-option error — so the retry ran without the
 * bypass and failed exactly like the first attempt (#600).
 * `--config.minimum-release-age=0` is honoured by pnpm 10, 11 and 12 alike.
 * That is specific to this key, not a rule for `--config.*`: the native CLI
 * ignores `--config.fetch-timeout` in both spellings, which is why
 * FETCH_TIMEOUT_OVERRIDE below is not respelled here (#615).
 */
export const RELEASE_AGE_OVERRIDE = '--config.minimum-release-age=0'

/**
 * Longer per-request fetch timeout for one retried command. pnpm's default
 * 60-second limit aborts large tarball downloads (github: sources fetch the
 * WHOLE repo even for a `#path:` subdirectory plugin) on slow networks; a
 * plain retry fails again at the same limit, so the recovery re-runs with
 * this override once. Scoped to a single command like RELEASE_AGE_OVERRIDE.
 *
 * pnpm 12 ignores this flag on the command line in either spelling (#615).
 * On the CLI runner, runDshPlugin repeats every `--config.<key>` override
 * as PNPM_CONFIG_<KEY>, which pnpm 11 and 12 both read, so the retried
 * command really does get the longer limit there. The Desktop runtime hands
 * its host argv only, so on a Desktop host the retry still depends on that
 * host's pnpm reading the flag. The flag stays: pnpm 11 and earlier read
 * it, and it costs nothing on the versions that do not.
 */
export const FETCH_TIMEOUT_OVERRIDE = '--config.fetchTimeout=600000'

/**
 * Stop pnpm downloading a plugin's peer dependencies (#289 by @00080000).
 *
 * The last resort for a peer that cannot be downloaded because it does not
 * exist on any registry: the dsh runtime injects several `@deepseek-ai/*`
 * packages and never publishes them, and since pnpm 8 `auto-install-peers`
 * defaults on, so pnpm walks the peer list and 404s on one.
 *
 * Only on the retry, never by default. Turning it off wholesale would also
 * stop pnpm installing the peers a plugin legitimately needs from npm, and
 * that failure would surface much later — as a missing module at runtime
 * rather than a clear error at install time. Narrow beats early here.
 *
 * Verified against pnpm 10.29.3: `peerDependencyRules.ignoreMissing` does
 * NOT prevent the fetch (it only silences the warning), so this flag is the
 * only lever that actually works.
 *
 * pnpm 12 ignores this flag on the command line too (12.4.1 auto-installs
 * the peer regardless); runDshPlugin repeats it as
 * PNPM_CONFIG_AUTO_INSTALL_PEERS, which 12 reads (#615).
 */
export const AUTO_INSTALL_PEERS_OFF = '--config.auto-install-peers=false'

/**
 * Whether an unresolvable package is a host peer pnpm went looking for on
 * its own, rather than something the profile actually asks for.
 *
 * The same 404 means two different things and wants two different answers.
 * A `@deepseek-ai/*` package that IS in the profile manifest is a ghost
 * entry — left by an earlier failed operation, or hand-added — and the user
 * has to remove that line; retrying would only fail again. One that is NOT
 * in the manifest was never asked for by anybody: pnpm reached it by walking
 * an installed plugin's peerDependencies, which in this ecosystem name what
 * the runtime provides rather than what npm carries.
 *
 * Reading the manifest is what separates them, so this cannot live in the
 * pure classifier.
 */
export function isUnpublishedHostPeer(
  pkg: string | undefined,
  profile: string,
  explicitDir?: string,
): boolean {
  if (pkg === undefined || !HOST_NAMESPACE_RE.test(pkg)) return false
  return !Object.hasOwn(readManifestDeps(profile, explicitDir), pkg)
}

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
 *
 * The release-age bypass can be declined (`releaseAgeBypass: false`). Its
 * safety argument above assumes the young package is already installed; a
 * fresh install pinned to the registry's latest (#594) is the one case
 * where it is not — there the bypass would be what installs the young
 * version, over a minimumReleaseAge the profile set on purpose — so the
 * install route declines it and falls back to the bare name instead.
 */
export async function withHoistRecovery(
  run: PluginRunner,
  profile: string,
  pluginArgs: string[],
  profileDirectory?: string,
  options: { releaseAgeBypass?: boolean } = {},
): Promise<InstallResult> {
  let result = await run(profile, pluginArgs)
  const ok = (r: InstallResult): boolean => r.exitCode === 0 && !r.timedOut && !r.cancelled
  if (!ok(result) && !result.cancelled) {
    const failure = classifyPnpmFailure(`${result.stderr}\n${result.stdout}`, result.exitCode)
    if (failure?.code === 'unparseable-build-key') {
      // The profile's own allowBuilds block is what fails, so no retry of the
      // same command can pass until it is repaired (#698). Drop only the
      // source-form keys this pnpm cannot parse — bare names stay, and on
      // these versions a bare name is what authorizes a git dependency — then
      // run the command once more.
      const removed = dropUnparseableBuildKeys(profile, profileDirectory)
      if (removed.length > 0) {
        logEvent('warn', 'install', `this pnpm cannot parse git-source allowBuilds keys; removed ${removed.join(', ')} from pnpm-workspace.yaml and retrying once (#698)`)
        result = await run(profile, pluginArgs)
      }
    } else if (failure?.code === 'hoist-pattern-diff') {
      logEvent('warn', 'install', `modules dir was built by a different pnpm major — rebuilding (pnpm install) and retrying once`)
      // --no-frozen-lockfile: the market runs pnpm with CI=true (TTY hangs),
      // where a lockfile written by the old major would otherwise be refused.
      const rebuild = await run(profile, ['install', '--no-frozen-lockfile'])
      if (ok(rebuild)) result = await run(profile, pluginArgs)
    } else if (
      failure?.code === 'release-age-violation'
      && options.releaseAgeBypass !== false
      && (pluginArgs[0] === 'add' || pluginArgs[0] === 'remove')
      && !pluginArgs.includes(RELEASE_AGE_OVERRIDE)
    ) {
      logEvent('warn', 'install', `a too-young release blocks pnpm's lockfile verification (#39) — retrying once with ${RELEASE_AGE_OVERRIDE}`)
      result = await run(profile, [pluginArgs[0], RELEASE_AGE_OVERRIDE, ...pluginArgs.slice(1)])
    } else if (
      (failure?.code === 'fetch-404' || failure?.code === 'no-matching-version')
      && isUnpublishedHostPeer(failure.pkg, profile, profileDirectory)
      && (pluginArgs[0] === 'add' || pluginArgs[0] === 'remove')
      && !pluginArgs.includes(AUTO_INSTALL_PEERS_OFF)
    ) {
      // The plugin is fine; pnpm went looking for a package the host injects
      // and npm has never carried. Every fresh profile hits this, whatever
      // the plugin, so failing here would be failing for something the user
      // cannot fix and did not cause.
      logEvent('warn', 'install', `${failure.pkg ?? 'a host package'} is a peer the runtime provides and npm does not carry (#289) — retrying once with ${AUTO_INSTALL_PEERS_OFF}`)
      result = await run(profile, [pluginArgs[0], AUTO_INSTALL_PEERS_OFF, ...pluginArgs.slice(1)])
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
    const diagnostics = diagnosticsTail(result)
    const failure = classifyPnpmFailure(`${result.stderr}\n${result.stdout}`, result.exitCode)
    if (failure !== null) {
      result = {
        ...result,
        stderr: failure.replaceOutput === true ? failure.message : `${result.stderr}\n\n${failure.message}`,
        ...(failure.replaceOutput === true ? { stdout: '' } : {}),
      }
    } else if (diagnostics !== null) {
      // The dsh CLI redirects the whole pnpm run into a file and leaves one
      // line on stderr: `dsh: pnpm failed; diagnostics: <path>` (its own
      // literal message). Everything a user or a report needs is in that
      // file, so show its tail rather than the one line (#672).
      result = { ...result, stderr: `${result.stderr}\n\n--- dsh diagnostics (${diagnostics.path}) ---\n${diagnostics.text}` }
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
 * The tail of the diagnostics file the dsh CLI pointed at, when it pointed at
 * one (#672).
 *
 * `dsh plugin` writes pnpm's entire output to a file and prints only
 * `dsh: pnpm failed; diagnostics: <path>`. For a failure the market cannot
 * classify, that line is all it has — the reasons people reported (#244,
 * #192, #138) were all "the UI shows one unhelpful line" for causes that
 * were written down somewhere the UI never looked.
 *
 * Bounded on purpose: absolute paths only, a regular file, and at most the
 * last {@link DIAGNOSTICS_TAIL_BYTES}. The path comes from our own child, but
 * the market only ever needs the end of a log, and reading an arbitrary
 * amount of an arbitrary file is not worth anything it could add.
 *
 * @returns the path and the text, or null when the output names no readable
 *   diagnostics file.
 */
export function diagnosticsTail(result: { stdout: string; stderr: string }): { path: string; text: string } | null {
  const match = /(?:^|\n)\s*dsh: [^\n]*diagnostics:\s*(\S+)\s*$/m.exec(result.stderr)
    ?? /(?:^|\n)\s*dsh: [^\n]*diagnostics:\s*(\S+)\s*$/m.exec(result.stdout)
  if (match === null) return null
  const path = match[1]!
  if (!isAbsolute(path)) return null
  try {
    if (!statSync(path).isFile()) return null
    const size = statSync(path).size
    const start = Math.max(0, size - DIAGNOSTICS_TAIL_BYTES)
    const handle = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(DIAGNOSTICS_TAIL_BYTES, size))
      readSync(handle, buffer, 0, buffer.length, start)
      const text = buffer.toString('utf8').trim()
      return text === '' ? null : { path, text }
    } finally {
      closeSync(handle)
    }
  } catch {
    return null
  }
}

/** How much of a diagnostics file is worth showing. */
const DIAGNOSTICS_TAIL_BYTES = 8192

/**
 * Whether pnpm never started at all, so the profile cannot have been touched.
 *
 * Worth its own question because the update route answers a failed run by
 * reinstalling the previous build and reporting loudly when it cannot verify
 * that (#502 by @Ztyss): three updates in a row told the user their profile
 * might be broken and to inspect it before restarting, when in fact nothing
 * had been written — the command line could not launch pnpm, so package.json
 * and node_modules were exactly as they had been.
 * @param result - the failed run.
 * @returns true when the failure happened before pnpm could run.
 */
export function pnpmNeverStarted(result: InstallResult): boolean {
  return classifyPnpmFailure(`${result.stderr}\n${result.stdout}`, result.exitCode)?.code === 'pnpm-unusable'
}

/**
 * Whether pnpm failed because the running host holds the package's files
 * open, so nothing pnpm runs from inside that host can replace them.
 *
 * Worth asking for the same reason as pnpmNeverStarted: the update route
 * answers a failed run by reinstalling the previous build, and that reinstall
 * performs the very rename that just failed, against the same open handles
 * (#608 by @Euezb). It cannot win — pnpm retries the rename for about three
 * minutes before giving up — and the route then told the user their profile
 * might be broken and to inspect it before restarting, when nothing had been
 * reinstalled and the previous build was still there to be checked.
 * @param result - the failed run.
 * @returns true when pnpm was stopped by files the host holds open.
 */
export function pnpmBlockedByOpenFiles(result: InstallResult): boolean {
  return classifyPnpmFailure(`${result.stderr}\n${result.stdout}`, result.exitCode)?.code === 'windows-file-locked'
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
      // A China-region root may already carry the commit resolved through
      // the mirror (`#<sha>`). pnpm's fragment grammar joins the subpath as
      // another selector with `&`; a second `#` produces an invalid target.
      const subTarget = `${target}${target.includes('#') ? '&' : '#'}path:/${sub}`
      const result = await run(profile, ['add', subTarget])
      if (result.exitCode !== 0 || result.timedOut) {
        allOk = false
        logEvent('error', 'install',
          `${subTarget}: exit=${String(result.exitCode)}${result.timedOut ? ' TIMEOUT' : ''} — ${(result.stderr || result.stdout).slice(-220)}`)
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
  run: PluginRunner, profile: string, before: Set<string>, explicitDir?: string, hostDirectory?: string | null,
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
      await removeAndReconcile(run, profile, dir, n, hostDirectory)
      continue
    }
    const clash = conflictingEntryIds(dir, n, existingBundles)
    if (clash.length > 0) {
      // Keeping it would make the NEXT BOOT fail outright (#122).
      conflicts.push(...clash.map(hit => ({ name: n, ...hit })))
      removedBroken.push(n)
      logEvent('error', 'install',
        `${n}: loader entry id conflict with ${clash[0].owner} (${clash.map(hit => hit.id).join(', ')}) — removing, it would break the next boot`)
      await removeAndReconcile(run, profile, dir, n, hostDirectory)
      continue
    }
    keep.push(n)
  }
  return { added: addedNow, keep, removedBroken, conflicts }
}

/**
 * Run one removal this validation triggered and reconcile the manifest by
 * disk truth afterwards.
 *
 * The plugin command reconciles `dsh.profile.bundles` only when pnpm exits
 * 0, and a remove can fail AFTER completing every persistent step — the #65
 * write-order family — or exit 0 with the reconcile still not reflected in
 * the manifest. Either way the bundle row left behind names a package the
 * next boot cannot resolve, and the loader dies on the first such row: the
 * whole profile, not just this plugin, refuses to start, with the market's
 * own page unreachable. Disk truth decides the repair, deliberately: a
 * package that is gone gets its manifest rows dropped so the boot stays
 * loadable, while a package still on disk keeps them, because a retry needs
 * something to retry against.
 * @param run - the plugin runner, as the caller received it.
 * @param profile - the profile name for manifest writes.
 * @param dir - the profile directory the validation reads.
 * @param name - the package being removed.
 * @param hostDirectory - the DSH host deployment directory whose node_modules
 * may hold a bridge link for this package (#662); resolved when omitted.
 */
async function removeAndReconcile(run: PluginRunner, profile: string, dir: string, name: string, hostDirectory: string | null = findDshInstallDir()): Promise<void> {
  const result = await run(profile, ['remove', name])
  const gone = !existsSync(join(dir, 'node_modules', name, 'package.json'))
  if (gone) {
    removeDanglingHostBridge(name, dir, hostDirectory)
    if (dropFromManifest(profile, name, dir)) {
      logEvent('error', 'install',
        `${name}: remove ${result.exitCode === 0 ? 'skipped the manifest reconcile' : `failed (exit ${String(result.exitCode)})`} but the package is gone from disk — dropped its dependency/bundle rows so the next boot stays loadable`)
    }
    return
  }
  if (result.exitCode !== 0 || result.timedOut || result.cancelled) {
    logEvent('error', 'install',
      `${name}: remove failed (exit ${String(result.exitCode)})${result.timedOut ? ' timed out' : ''}${result.cancelled ? ' cancelled' : ''} and the package is still installed — its rows stay in the manifest; retry the uninstall`)
  }
}

/**
 * The node_modules root of the DSH host deployment `directory` belongs to.
 *
 * CLI layouts install the host as `<prefix>/node_modules/@deepseek-ai/dsh`,
 * so the shared root is two dirname steps up; a flat Desktop layout keeps
 * the host package at the deployment root (#662's
 * `<desktop-app>\dependencies\dsh`), with its pnpm-managed node_modules
 * directly beside its package.json. `dshHostInfo()` already distinguishes
 * the two — this is pure path arithmetic on whichever directory it returned.
 */
export function hostNodeModulesRoot(directory: string): string {
  const segments = directory.split(/[/\\]+/).filter(segment => segment !== '')
  const n = segments.length
  if (n >= 3 && segments[n - 3].toLowerCase() === 'node_modules' && segments[n - 2].toLowerCase() === '@deepseek-ai') {
    return resolve(dirname(dirname(directory)))
  }
  return resolve(directory, 'node_modules')
}

/**
 * Normalize a link target for path comparison: restore the UNC device form
 * (`\\?\UNC\server\share` back to `\\server\share` — stripped of its prefix
 * it is no longer absolute and resolve() would re-root it against the
 * cwd), then remove the NT device prefixes `\\?\` and the subst-style
 * `\??\` mklink stores. Measured on Node 24/win32: readlinkSync returns
 * the plain absolute path, so these branches only matter for links created
 * outside Node — but a comparison must not silently miss because of them.
 */
export function normalizedLinkTarget(target: string): string {
  return target
    .replace(/^\\\\\?\\UNC\\/, '\\\\')
    .replace(/^(?:\\\\\?\\|\\\?\?\\)/, '')
}

/**
 * Whether a link target names the profile's copy of a package. Junction
 * targets keep the case they were created with, so the comparison is
 * case-insensitive on win32, where the filesystem itself is.
 */
function pointsAtProfilePackage(target: string, expected: string): boolean {
  const left = resolve(normalizedLinkTarget(target))
  const right = resolve(expected)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Remove the host-side bridge link a confirmed uninstall leaves dangling
 * (#662). The official boot projects profile packages into the host
 * deployment's node_modules as links (Junction or SymbolicLink — lstat
 * reports both as symlinks) and never reclaims them, and `dsh plugin
 * remove` knows nothing about them, so without this the link outlives the
 * package it pointed at and every tool that lstats its way through
 * node_modules (rg first among them) fails on it.
 *
 * The gate is deliberately total: only `<host node_modules>/<name>` is ever
 * touched, only when that entry is a link whose normalized target is
 * exactly this profile's copy of `name`, and only when that copy is really
 * gone — a live bridge for a package that is still installed must survive.
 * A null `hostDirectory` (no host locatable — a plain `dsh web` from a
 * global install) is a documented no-op.
 *
 * @returns whether a dangling bridge was removed. Never throws: the removal
 * this cleans up after already succeeded, and a cleanup failure must not
 * fail the uninstall that triggered it.
 */
export function removeDanglingHostBridge(name: string, profileDirectory: string, hostDirectory: string | null): boolean {
  if (hostDirectory === null) return false
  const bridge = join(hostNodeModulesRoot(hostDirectory), name)
  const unlinked = join(profileDirectory, 'node_modules', name)
  try {
    if (!lstatSync(bridge).isSymbolicLink()) return false
    // The gone-check mirrors removeAndReconcile's manifest truth: a package
    // whose package.json is gone is uninstalled even if an empty directory
    // lingered behind, and its bridge is exactly the dangling link #662 is
    // about.
    if (!pointsAtProfilePackage(readlinkSync(bridge), unlinked) || existsSync(join(unlinked, 'package.json'))) return false
    // No `recursive`: rmSync on a link unlinks the link itself only
    // (measured on win32/Node 24 for live and dangling junctions and dir
    // symlinks), and leaving it off keeps a race that swaps the link for a
    // real directory from ever deleting that directory's tree.
    rmSync(bridge, { force: true })
  } catch (error) {
    // ENOENT is the ordinary "no bridge there" answer (and a lost race
    // while unlinking); anything else is worth a line in the log.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logEvent('warn', 'uninstall', `${name}: host bridge cleanup skipped — ${error instanceof Error ? error.message : String(error)}`)
    }
    return false
  }
  logEvent('info', 'uninstall', `${name}: removed the dangling host bridge the boot projection left at ${bridge}`)
  return true
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
 * The allowBuilds key pnpm itself printed for a prepare refusal, when it
 * printed one (#698).
 *
 * pnpm 11 ends ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED with the exact line to
 * add — measured on 11.8.0 against the reported plugin:
 *
 *     For example:
 *     allowBuilds:
 *       @dsh-external/dsh-super-injector@https://codeload.github.com/…/tar.gz/<sha>: true
 *
 * For a TRANSITIVE git dependency that key is the only knowledge anyone has
 * of its source: the package is in neither node_modules, package.json nor
 * the catalog. pnpm 10 prints an `onlyBuiltDependencies` example with the
 * bare name instead, and gets null here — the bare name is what it needs.
 *
 * @returns the key, or null when the output carries no allowBuilds example.
 */
export function parsePrepareKey(stdout: string, stderr: string): string | null {
  // ndjson carries this inside a JSON string: quotes and newlines escaped.
  const text = `${stdout}\n${stderr}`.replace(/\\"/g, '"').replace(/\\n/g, '\n')
  const m = /For example:\s*\n\s*allowBuilds:\s*\n[ \t]+("?)([^\s"]+)\1:\s*true/.exec(text)
  return m === null ? null : m[2]!
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
