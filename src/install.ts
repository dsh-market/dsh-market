/**
 * Install orchestration: collection-repo retargeting, post-install
 * validation that keeps broken pieces from bricking the next boot, and
 * update staleness detection. Every function takes the plugin runner as a
 * parameter so tests can substitute a recording fake.
 */

import { closeSync, existsSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { InstallResult, PluginRunner } from './dsh-cli.ts'
import { findDshInstallDir } from './dsh-install.ts'
import { classifyPnpmFailure, HOST_NAMESPACE_RE, isTransientPnpmFailure } from './pnpm-compat.ts'
import { conflictingEntryIds, dropFromManifest, hasDshManifest, hasLoadableEntry, mergeDuplicateReleaseAgeExcludes, pluginSubdirs, profileDir, readGitResolutionCommit, readInstalled, readInstalledVersion, readLockCommits, readManifestDeps, readProfileBundles, dropUnparseableBuildKeys } from './profile.ts'
import { logEvent } from './log.ts'
import { registryNameOf } from './official-desktop.ts'
import { hostedRepoKey } from './sources.ts'
import { cleanOrphanedIgnored, cleanOrphanedStore } from './store.ts'

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
 *
 * `marketFlags: false` says the host runs pnpm itself and takes no options
 * from us (the official Desktop bridge, #732). The four recoveries below
 * each decorate a command with an option, so on such a host they are skipped
 * rather than sent and refused — and because their classifier messages say
 * the market retried, the note appended at the end says it did not.
 */
export async function withHoistRecovery(
  run: PluginRunner,
  profile: string,
  pluginArgs: string[],
  profileDirectory?: string,
  options: { releaseAgeBypass?: boolean; marketFlags?: boolean; preserveProfilePolicy?: boolean } = {},
): Promise<InstallResult> {
  const marketFlags = options.marketFlags !== false
  // An already verified mature update must not rewrite the user's workspace
  // policy as a side effect of market-level recovery (#991).
  const repairProfilePolicy = options.preserveProfilePolicy !== true
  /** The option a recovery step needed and this host does not accept (#732). */
  let unavailableOption: string | null = null
  // Before the FIRST run, not after a failure: the shadowed duplicate rule
  // (#732) hurts pnpm while it RESOLVES the dependency graph, so merging it
  // first is what keeps the command from failing at all — and it costs one
  // small file read. Every verb that resolves the graph is covered, not just
  // add and remove: an `install` or an in-place `update` reads the same key.
  const verb = pluginArgs.find(argument => !argument.startsWith('-'))
  if (repairProfilePolicy && (verb === 'add' || verb === 'remove' || verb === 'install' || verb === 'update')) {
    const merged = mergeDuplicateReleaseAgeExcludes(profile, profileDirectory)
    if (merged.length > 0) {
      logEvent('warn', 'install', `minimumReleaseAgeExclude held several rules for ${merged.join(', ')}, and pnpm honours only the FIRST per name (#732) — merged each package's rules into one, before running`)
    }
  }
  let result = await run(profile, pluginArgs)
  const ok = (r: InstallResult): boolean => r.exitCode === 0 && !r.timedOut && !r.cancelled
  // A shadowed rule written DURING the run is its own evidence (#732). The
  // file was merged just before the run, so a duplicate now means pnpm — or
  // the host driving it — appended one while this command ran, and every
  // retry would trip on it. The repair below in the release-age branch only
  // fired when pnpm's error text reached us; the official desktop host hands
  // back its own message and `packageResult.output`, which need not carry
  // `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, so the line the host had just
  // appended stayed dead (@Mlte0907, 1.66.7). The merge is a no-op when
  // nothing is duplicated, so asking it costs one file read.
  let repairedDuringRun = false
  if (repairProfilePolicy && !ok(result) && !result.cancelled && (pluginArgs[0] === 'add' || pluginArgs[0] === 'remove')) {
    const mergedNow = mergeDuplicateReleaseAgeExcludes(profile, profileDirectory)
    if (mergedNow.length > 0) {
      repairedDuringRun = true
      logEvent('warn', 'install', `a second minimumReleaseAgeExclude rule for ${mergedNow.join(', ')} was appended during the run, and pnpm honours only the first, shadowing it (#732) — merged them into one and retrying once`)
      result = await run(profile, pluginArgs)
    }
  }
  if (!ok(result) && !result.cancelled && !repairedDuringRun) {
    const failure = classifyPnpmFailure(`${result.stderr}\n${result.stdout}`, result.exitCode)
    if (failure?.code === 'unparseable-build-key' && repairProfilePolicy) {
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
      if (!marketFlags) {
        unavailableOption = '--no-frozen-lockfile'
      } else {
        logEvent('warn', 'install', `modules dir was built by a different pnpm major — rebuilding (pnpm install) and retrying once`)
        // --no-frozen-lockfile: the market runs pnpm with CI=true (TTY hangs),
        // where a lockfile written by the old major would otherwise be refused.
        const rebuild = await run(profile, ['install', '--no-frozen-lockfile'])
        if (ok(rebuild)) result = await run(profile, pluginArgs)
      }
    } else if (
      failure?.code === 'release-age-violation'
      && (pluginArgs[0] === 'add' || pluginArgs[0] === 'remove')
    ) {
      // The repair ran before this command, so a rewrite here means pnpm wrote
      // one of the two broken shapes DURING it — appending a shadowed rule
      // (#732) or extending a version union (#733). Either way the same
      // rewrite fixes it, needs no option at all, and so also works on the
      // desktop bridge that refuses options. Retry the SAME argv afterwards.
      const mergedNow = repairProfilePolicy ? mergeDuplicateReleaseAgeExcludes(profile, profileDirectory) : []
      if (mergedNow.length > 0) {
        logEvent('warn', 'install', `pnpm appended a second minimumReleaseAgeExclude rule for ${mergedNow.join(', ')} and honours only the first, shadowing its own entry (#732) — merged them into one and retrying once`)
        result = await run(profile, pluginArgs)
      } else if (options.releaseAgeBypass === false || options.preserveProfilePolicy === true) {
        // Fresh installs (#594) and mature updates/recovery (#991) never
        // bypass age enforcement. Preserve the native failure and policy.
      } else if (!marketFlags) {
        unavailableOption = RELEASE_AGE_OVERRIDE
      } else if (pluginArgs.includes(RELEASE_AGE_OVERRIDE)) {
        // Already carrying it (a caller's forced retry): nothing left to add.
      } else {
        logEvent('warn', 'install', `a too-young release blocks pnpm's lockfile verification (#39) — retrying once with ${RELEASE_AGE_OVERRIDE}`)
        result = await run(profile, [pluginArgs[0], RELEASE_AGE_OVERRIDE, ...pluginArgs.slice(1)])
      }
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
      if (!marketFlags) {
        unavailableOption = AUTO_INSTALL_PEERS_OFF
      } else {
        logEvent('warn', 'install', `${failure.pkg ?? 'a host package'} is a peer the runtime provides and npm does not carry (#289) — retrying once with ${AUTO_INSTALL_PEERS_OFF}`)
        result = await run(profile, [pluginArgs[0], AUTO_INSTALL_PEERS_OFF, ...pluginArgs.slice(1)])
      }
    } else if (failure?.code === 'profile-file-locked') {
      // #786 follow-up: the profile's own file was momentarily held, so the
      // SAME argv succeeds — no option is needed, which also means this works
      // on the desktop bridge that refuses market options (#732).
      //
      // Covers both lockfiles pnpm writes through the same no-retry atomic
      // rename: the profile's `pnpm-lock.yaml` and the one inside
      // `node_modules/.pnpm/lock.yaml`.
      //
      // Retried here rather than in the route because `pnpmBlockedByOpenFiles`
      // and the route's rollback both read the FINAL result: leaving this
      // unretried made the route treat a transient lock as "the running host
      // holds the plugin's files open", restore package.json and pnpm-lock.yaml
      // — and thereby throw away a lockfile that already pointed at the newly
      // built commit, which is what left the profile desynchronized.
      logEvent('warn', 'install', `pnpm was momentarily refused on a profile file (antivirus or indexer) — retrying the same command once (#786)`)
      result = await run(profile, pluginArgs)
    } else if (failure?.code === 'transient-network'
      && (pluginArgs[0] === 'add' || pluginArgs[0] === 'remove')
    ) {
      // #83: pnpm replays the whole tree, so any existing dependency's
      // momentary network hiccup fails the run — and a plain retry succeeds.
      // Do that retry ourselves instead of reporting a false failure.
      logEvent('warn', 'install', `transient network failure while pnpm replayed the dependency tree (#83) — retrying once`)
      result = await run(profile, pluginArgs)
    } else if (
      failure?.code === 'exact-version-missing'
      && (pluginArgs[0] === 'add' || pluginArgs[0] === 'remove' || pluginArgs[0] === 'update')
    ) {
      // #927: market pinned name@x.y.z from /latest, but this registry's
      // packument (often a mirror) does not list that version yet. Same argv
      // once more gives pnpm a chance to re-fetch; if it still fails the
      // classifier's message names "try later / switch Download region".
      logEvent('warn', 'install', `exact version missing on this registry's packument (#927) — retrying once to re-fetch`)
      result = await run(profile, pluginArgs)
    } else if (
      failure?.code === 'fetch-timeout'
      && (pluginArgs[0] === 'add' || pluginArgs[0] === 'remove')
      && !pluginArgs.includes(FETCH_TIMEOUT_OVERRIDE)
    ) {
      // Large tarball / slow network: pnpm's default 60s per-request limit
      // aborted the download. A plain retry fails again at the same limit,
      // so retry once with a longer fetchTimeout.
      if (!marketFlags) {
        unavailableOption = FETCH_TIMEOUT_OVERRIDE
      } else {
        logEvent('warn', 'install', `pnpm's per-request fetch timeout aborted a large download — retrying once with ${FETCH_TIMEOUT_OVERRIDE}`)
        result = await run(profile, [pluginArgs[0], FETCH_TIMEOUT_OVERRIDE, ...pluginArgs.slice(1)])
      }
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
    } else {
      // Nothing matched. Two things may still say what went wrong, and pnpm's
      // own words come FIRST (#808).
      //
      // pnpm's structured error arrives in its ndjson stream, which never
      // reaches stderr. Without it the user sees the tail of dsh's wrapper
      // output ("pnpm failed in profile directory …"), byte-identical for
      // every possible cause — why #244, #192 and #138 all read as "the UI
      // shows a stack tail". An unrecognized error is where the raw text is
      // worth the most: a classified one has a written explanation, this one
      // has only pnpm's own words.
      //
      // The CLI's diagnostics file (`dsh: pnpm failed; diagnostics: <path>`,
      // #672) used to carry the whole pnpm run. It no longer does: dsh now
      // pipes pnpm's output straight to the market, and the file keeps only
      // execa's one-line summary ("Command failed with exit code 1: pnpm add
      // …"). Showing it INSTEAD of pnpm's error — which is what an either/or
      // here did — put that summary in front of the user and hid the real
      // cause behind it. Its path is still worth printing for a report, so it
      // stays, after the error.
      const blocks: string[] = []
      if (result.pnpmError !== undefined && result.pnpmError !== '') {
        const code = result.pnpmErrorCode === undefined ? '' : `${result.pnpmErrorCode}: `
        blocks.push(`${code}${result.pnpmError}`)
      }
      if (diagnostics !== null) blocks.push(`--- dsh diagnostics (${diagnostics.path}) ---\n${diagnostics.text}`)
      if (blocks.length > 0) result = { ...result, stderr: `${result.stderr}\n\n${blocks.join('\n\n')}` }
    }
  }
  if (!marketFlags && !ok(result) && !result.cancelled
    && classifyPnpmFailure(`${result.stderr}\n${result.stdout}`, result.exitCode)?.code === 'windows-file-locked') {
    // The classified text offers "run it from the command line with the app
    // closed". On the official desktop app that is the one thing the market
    // does not do for the user — it never falls back to `dsh plugin --profile
    // desktop`, which is forbidden there — so the advice sent the reporter to a
    // door the market itself keeps shut (#798). Say what to do instead: the
    // app's own Plugins page runs the same managed pipeline.
    //
    // Not for the market itself: Settings → Plugins has no update entry for a
    // package already in the profile (#909). That note would send a self-update
    // to a shut door (#982).
    const lockedTarget = pluginArgs.find(argument => !argument.startsWith('-') && argument !== verb) ?? ''
    const lockedName = registryNameOf(lockedTarget) ?? lockedTarget
    if (lockedName !== 'dshmarket' && lockedName !== 'dsh-market') {
      result = {
        ...result,
        stderr: `${result.stderr}\n\n这是官方桌面端：上面「在命令行执行」这一条在这里用不了，请改在应用自己的「设置 → 插件」里操作（退出重启后，或先停用加载该包的插件再重启）。 / This is the official desktop app: the "run it from the command line" option above is not available here — use the app's own Settings → Plugins instead (after restarting, or after disabling the plugin that loads this package and restarting).`,
      }
    }
  }
  if (unavailableOption !== null && !ok(result) && !result.cancelled) {
    // #732: this step was skipped because the host runs pnpm itself and takes
    // no options from us — but the classified message above says the market
    // retried. Say that it did not, or the user reads a retry that never
    // happened and looks for the wrong cause.
    //
    // The wait on a fresh release is the one of these where "no retry" leaves
    // the user with nothing to do at all: the plugin IS published, pnpm just
    // will not take it yet. #852 pointed at plain `dsh web`, but the desktop
    // profile is host-managed — that door is shut (#909). Say the wait, and
    // when pnpm named the publish time, how long is left (#919).
    //
    // Drop the classifier's "market already retried" sentence first: it was
    // appended above and is false on this host, and the client prefers
    // body.error / that classified half over a note tacked on afterwards.
    let note: string
    if (unavailableOption === RELEASE_AGE_OVERRIDE) {
      const classified = classifyPnpmFailure(`${result.stderr}\n${result.stdout}`, result.exitCode)
      if (classified?.code === 'release-age-violation') {
        const cut = result.stderr.lastIndexOf(classified.message)
        if (cut !== -1) {
          result = { ...result, stderr: result.stderr.slice(0, cut).trimEnd() }
        }
      }
      const windowMs = readMinimumReleaseAgeMs(profile, profileDirectory)
      const captured = `${result.stderr}\n${result.stdout}`
      const remaining = windowMs === null
        ? null
        : remainingReleaseAgeWait(captured, Date.now(), windowMs)
      const wait = remaining === null ? { zh: '', en: '' } : formatRemainingReleaseAgeWait(remaining)
      // #944: pnpm verifies the WHOLE lockfile, so the entry it refuses need
      // not be the one this command asked for. When it names a different
      // package, saying "this plugin's new version is too young" is wrong
      // twice over — it blames an innocent package, and it attaches the
      // remaining wait to that package's version rather than the offender's.
      // Name the offender instead, and offer the one-line remedy the reporter
      // used in place of waiting. Nothing is claimed when the output names no
      // package, or names the one being installed: that path keeps #919's note.
      const target = pluginArgs.find(argument => !argument.startsWith('-') && argument !== verb) ?? ''
      const targetName = registryNameOf(target) ?? target
      const refused = refusedReleaseAgePackage(captured)
      if (refused !== null && targetName !== '' && refused.name !== targetName) {
        note = `拦住你的是 ${refused.name}@${refused.version}，不是你要装的这个插件：pnpm 在改动前校验整个 lockfile，而这个版本还在本机的新版本等待期内（#944）。官方桌面端不接受临时放行，所以这里没有自动重试。**等 ${refused.name}@${refused.version} 过了等待期再更新一次即可**${wait.zh}；想现在就装，在 profile 的 pnpm-workspace.yaml 里 minimumReleaseAgeExclude 中**这个名字的那一行**（没有就新增一行）追加 \` || ${refused.version}\`——带引号的行要加在引号里面。不要另开一行同名规则：pnpm 只读第一条（#883）。 / What is holding you is ${refused.name}@${refused.version}, not the plugin you asked to install: pnpm verifies the whole lockfile before any change, and that version is still inside this machine's fresh-release wait (#944). The official desktop app takes no one-shot bypass, so no automatic retry happens here. **Update again once ${refused.name}@${refused.version} is past the wait**${wait.en}; to install right now, append \` || ${refused.version}\` to the row for \`${refused.name}\` under minimumReleaseAgeExclude in the profile's pnpm-workspace.yaml — inside the quotes when the row is quoted, and in a new row only if none exists. Do not add a second row for the same name: pnpm reads only the first (#883).`
      } else {
        note = `这个插件的新版本比本机的新版本等待期还新，所以现在装不了（改别的插件也会被拦住）。官方桌面端不接受临时放行，所以这里没有自动重试。**等这个版本过了等待期再更新一次即可**${wait.zh}。过了等待期后再在市场点一次更新。 / The plugin's new version is younger than this machine's fresh-release wait, so the install was refused (a change to another plugin too). The official desktop app takes no one-shot bypass, so no automatic retry happens here. **Update again once the version is past the wait**${wait.en}. Try the market update again after the wait.`
      }
    } else {
      note = `这台宿主（官方桌面端）自己执行安装，不接受市场附加的 pnpm 参数（${unavailableOption}），所以这一步没有自动重试。 / This host (the official desktop app) runs the install itself and takes no pnpm options from the market (${unavailableOption}), so that automatic retry could not be attempted.`
    }
    result = { ...result, stderr: `${result.stderr}\n\n${note}` }
  }
  // pnpm can append a second rule even on success (#883, #878), including
  // after a recovery retry or an official Desktop manager install. Repair
  // the final file now, before another plugin operation reads it; a successful
  // command must never be retried just because its exclusions needed merging.
  if (repairProfilePolicy && ok(result) && (verb === 'add' || verb === 'remove' || verb === 'install' || verb === 'update')) {
    try {
      const merged = mergeDuplicateReleaseAgeExcludes(profile, profileDirectory)
      if (merged.length > 0) {
        logEvent('warn', 'install', `merged duplicate minimumReleaseAgeExclude rules for ${merged.join(', ')} after success (#883, #878)`)
      }
    } catch (error) {
      logEvent('warn', 'install', `could not merge minimumReleaseAgeExclude after success (#883, #878): ${String(error)}`)
    }
  }
  // After every mutation — success, failure, and cancel. Garbage lands in
  // `.ignored` on the NEXT pnpm run, so a success-only hook would miss the
  // run that just moved it there (#974). Must not fail the user's command.
  try {
    const removed = cleanOrphanedIgnored(profileDir(profile, profileDirectory))
    if (removed.length > 0) {
      logEvent('info', 'install',
        `removed ${removed.length} quarantined dir(s) from node_modules/.ignored: ${removed.slice(0, 3).join(', ')}${removed.length > 3 ? ', …' : ''}`)
    }
  } catch { /* cleanup must never fail the install */ }
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
 * Whether pnpm refused a too-young release without writing to the profile.
 *
 * Same nature as wroteNothing / pnpmNeverStarted for the update route's
 * rollback (#919): pnpm DID start, read the lockfile, then exited 1 on
 * ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION (or the sibling mature-match /
 * resolution-policy shapes). Nothing was installed or removed, so restoring
 * "the previous build" is alarm about an untouched profile — and on the
 * official desktop bridge it pairs every wait with a false
 * "restoration could not be verified" line that covers the real reason.
 * @param result - the failed run.
 * @returns true when the failure is pnpm's fresh-release gate.
 */
export function pnpmRefusedYoungRelease(result: InstallResult): boolean {
  return classifyPnpmFailure(`${result.stderr}\n${result.stdout}`, result.exitCode)?.code === 'release-age-violation'
}

/** pnpm's default minimumReleaseAge window (1440 minutes). */
const DEFAULT_RELEASE_AGE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * The profile's fresh-release wait window in ms (#919).
 *
 * Reads `minimumReleaseAge` (minutes) from pnpm-workspace.yaml, then
 * `minimum-release-age` from `.npmrc`. A key that is present but not a
 * number returns null — callers must not invent a remaining wait. When
 * neither file names the key, pnpm's default 1440 minutes applies.
 */
export function readMinimumReleaseAgeMs(profile: string, explicitDir?: string): number | null {
  const dir = profileDir(profile, explicitDir)
  const fromWorkspace = readReleaseAgeMinutesFromWorkspace(dir)
  if (fromWorkspace === 'invalid') return null
  if (typeof fromWorkspace === 'number') return fromWorkspace * 60 * 1000
  const fromNpmrc = readReleaseAgeMinutesFromNpmrc(dir)
  if (fromNpmrc === 'invalid') return null
  if (typeof fromNpmrc === 'number') return fromNpmrc * 60 * 1000
  return DEFAULT_RELEASE_AGE_WINDOW_MS
}

/** @returns minutes, `'invalid'` when the key is present but unreadable, or null when absent. */
function readReleaseAgeMinutesFromWorkspace(dir: string): number | 'invalid' | null {
  let yaml: string
  try { yaml = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8') } catch { return null }
  if (!/^minimumReleaseAge\s*:/m.test(yaml)) return null
  const match = /^minimumReleaseAge:\s*(\d+)\s*(?:#.*)?$/m.exec(yaml)
  if (match === null) return 'invalid'
  const minutes = Number(match[1])
  return Number.isFinite(minutes) ? minutes : 'invalid'
}

/** @returns minutes, `'invalid'` when the key is present but unreadable, or null when absent. */
function readReleaseAgeMinutesFromNpmrc(dir: string): number | 'invalid' | null {
  let npmrc: string
  try { npmrc = readFileSync(join(dir, '.npmrc'), 'utf8') } catch { return null }
  if (!/^minimum-release-age\s*=/m.test(npmrc)) return null
  const match = /^minimum-release-age\s*=\s*(\d+)\s*(?:#.*)?$/m.exec(npmrc)
  if (match === null) return 'invalid'
  const minutes = Number(match[1])
  return Number.isFinite(minutes) ? minutes : 'invalid'
}

/**
 * The `name@version` pnpm actually refused, when its refusal named one (#944).
 *
 * {@link remainingReleaseAgeWait} reads only the timestamp on the same line,
 * which is fine while the offender IS the package being installed. It is not
 * always: a plugin install can be refused by a DIFFERENT, younger package that
 * is already in the lockfile, because pnpm verifies the whole lockfile before
 * any mutation (#39). #944 hit exactly that — updating `dsh-cost-meter` failed
 * with `dshmarket@1.66.44` named in the error, and the note then told the user
 * to wait out *the plugin's* version, which was not the version holding them.
 *
 * Only the entry pnpm prints in its violation line is read (`  <name>@<version>
 * was published at …`), so this cannot invent an offender from unrelated text.
 * Null when no such line is present — callers must then keep their existing
 * wording rather than guess.
 */
export function refusedReleaseAgePackage(output: string): { name: string, version: string } | null {
  const match = /^\s*((?:@[^/\s@]+\/)?[^@\s/]+)@(\d[^\s]*?)\s+was published at /im.exec(output)
  if (match === null) return null
  const name = match[1] ?? ''
  const version = match[2] ?? ''
  return name === '' || version === '' ? null : { name, version }
}

/**
 * How long is left in the fresh-release wait, when pnpm named the publish
 * time in its refusal (#919). Null when the output has no usable timestamp.
 */
export function remainingReleaseAgeWait(
  output: string,
  now = Date.now(),
  windowMs = DEFAULT_RELEASE_AGE_WINDOW_MS,
): number | null {
  const match = /published at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i.exec(output)
  if (match === null) return null
  const published = Date.parse(match[1]!)
  if (!Number.isFinite(published)) return null
  return Math.max(0, published + windowMs - now)
}

/** Human remaining-wait fragment for the desktop release-age note. */
function formatRemainingReleaseAgeWait(remainingMs: number): { zh: string, en: string } {
  if (remainingMs <= 0) {
    return { zh: '（现在再试一次即可）', en: ' (try again now)' }
  }
  const hours = Math.max(1, Math.ceil(remainingMs / (60 * 60 * 1000)))
  return {
    zh: `（大约还剩 ${hours} 小时）`,
    en: ` (about ${hours} hour${hours === 1 ? '' : 's'} left)`,
  }
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
 * Whether a failed run is the running host colliding with a second profile
 * boot (#975).
 *
 * Market install / update / uninstall spawn `dsh plugin …`. On a live
 * `dsh web` that child can boot the profile again, bind the same port, and
 * exit 1 AFTER pnpm has already written. The signature is DSH's own boot
 * failure — `listen EADDRINUSE` plus `Full diagnostics` pointing at a
 * `startup-*.log` — not a pnpm classifier code. All three pieces are
 * required so a stray EADDRINUSE or an unrelated diagnostics line cannot
 * flip a real failure into success.
 */
export function isHostPortCollision(result: { stdout: string; stderr: string }): boolean {
  const text = `${result.stderr}\n${result.stdout}`
  return /listen EADDRINUSE/i.test(text)
    && /Full diagnostics/i.test(text)
    && /startup-\S+\.log/i.test(text)
}

/**
 * Whether this install left at least one new, loadable plugin on disk (#975).
 *
 * Read-only half of the #18 guard: a name that landed without a dsh surface
 * or entry is not this operation's intent, so the caller still rolls back.
 * The route then runs the full validator on the success path.
 */
export function installApplied(profile: string, before: ReadonlySet<string>, explicitDir?: string): boolean {
  const dir = profileDir(profile, explicitDir)
  return Object.keys(readInstalled(profile, dir)).some((name) => {
    if (before.has(name)) return false
    const packageDir = join(dir, 'node_modules', name)
    return hasDshManifest(packageDir) && hasLoadableEntry(dir, name)
  })
}

/**
 * Whether this update changed the installed version or git commit (#975).
 *
 * Same question `isStaleUpdate` asks, but a missing after-value is "did not
 * land", not "not stale". The package must still be on disk.
 *
 * Git commits use the same two reads as `gitIdentityCommit` in routes.ts:
 * `type: git` first, then the archive/codeload URL a floating `github:`
 * install actually leaves.
 */
export function updateApplied(check: {
  profile: string
  name: string
  isGit: boolean
  beforeVersion: string | null
  beforeCommit: string | null
  spec?: string
  explicitDir?: string
}): boolean {
  const dir = profileDir(check.profile, check.explicitDir)
  if (!existsSync(join(dir, 'node_modules', check.name, 'package.json'))) return false
  const afterVersion = readInstalledVersion(check.profile, check.name, dir)
  if (check.isGit) {
    const afterCommit = check.spec === undefined
      ? null
      : installedGitCommit(check.profile, check.spec, dir)
    if (check.beforeCommit !== null && afterCommit !== null && afterCommit !== check.beforeCommit) return true
    return check.beforeVersion !== null && afterVersion !== null && afterVersion !== check.beforeVersion
  }
  return check.beforeVersion !== null && afterVersion !== null && afterVersion !== check.beforeVersion
}

/** Commit on disk for `spec` — `type: git`, then archive/codeload. */
function installedGitCommit(profile: string, spec: string, explicitDir: string): string | null {
  const fromGit = readGitResolutionCommit(profile, spec, explicitDir)
  if (fromGit !== null) return fromGit
  const key = hostedRepoKey(spec)
  return key === null ? null : readLockCommits(profile, explicitDir).get(key) ?? null
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
  const text = (result.stderr || result.stdout).trim()
  if (text.length <= limit) return text
  const tail = text.slice(-limit)
  // Cut at a sentence end instead of mid-word, and say that something was
  // dropped (#852). The market appends its own explanation to pnpm's output,
  // and this tail is catalogued into user-facing sentences — including inside
  // a parenthesis. A blunt cut landed inside the previous sentence and welded
  // the fragment to the next one: the reporter's log read
  // `（is, export the log and report it这台宿主…`, which is not a sentence in
  // either language and says nothing about what to do.
  const sentenceEnd = /[.!?。！？]["')\]）]?[\s\n]+/gu
  const match = sentenceEnd.exec(tail)
  if (match !== null) {
    const rest = tail.slice(match.index + match[0].length).trim()
    // A boundary so near the end would leave a word or two; the raw tail is
    // more use than the stub.
    if (rest.length >= 40) return `… ${rest}`
  }
  return `…${tail.trim()}`
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
    // The host install tree is passed too (#906): a carrier mounting only
    // in-box packages resolves nowhere under the profile, and judging it by
    // that alone deleted a package the host had just installed correctly.
    if (!hasDshManifest(packageDir) || !hasLoadableEntry(dir, n, hostDirectory ?? findDshInstallDir())) {
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
 * The allowBuilds key pnpm derives for one ignored build — its own
 * `allowBuildKeyFromIgnoredBuild`, transcribed.
 *
 * pnpm keeps the whole dep path when what follows the name's `@` is not a
 * semver version (a git remote, a codeload archive, a tarball URL — all of them
 * contain `:`, `/` or `#`), and collapses to the bare name otherwise. It writes
 * the result into `allowBuilds` and matches an existing entry against it
 * verbatim, so the market has to agree with it exactly: a bare name authorizes
 * a registry dependency and nothing else, while a git dependency is authorized
 * only by its full `name@git+…#<sha>` dep path.
 */
export function allowBuildKeyFromIgnoredBuild(depPath: string): string {
  const at = depPath.lastIndexOf('@')
  if (at <= 0) return depPath
  const version = depPath.slice(at + 1)
  return version !== '' && /[:/#]/.test(version) ? depPath : depPath.slice(0, at)
}

/**
 * The packages pnpm reported as having their build scripts ignored, each with
 * the allowBuilds key pnpm itself keys that decision by.
 *
 * pnpm prints the dependency's full dep path — `name@git+https://…#<sha>` for
 * a git source, `name@1.2.3` for a registry one — and `parseIgnoredBuilds`
 * below has always collapsed both to the bare name. That is right for a
 * registry dependency and drops the only key a git dependency is authorized
 * by, which is what left approve-and-retry unable to make progress on one.
 *
 * `name` is what the approve-builds route matches its request against; `key`
 * is the entry to write. They are equal for a registry dependency.
 *
 * Entries may also arrive inside pnpm's ndjson error line, where the sentence
 * is followed by `","code":…`; the walk stops at the first character no dep
 * path can contain, so the surrounding JSON is not swallowed.
 */
export function parseIgnoredBuildEntries(stdout: string, stderr: string): Array<{ name: string; key: string }> {
  const m = /Ignored build scripts:?\s*([^\n]+)/i.exec(`${stdout}\n${stderr}`)
  if (m === null) return []
  const found: Array<{ name: string; key: string }> = []
  for (const chunk of m[1].split(',')) {
    // A dep path ends at whitespace, a JSON quote (plain or escaped) or the
    // closing brace of the ndjson error object; the human line adds a period.
    const walked = /^[^\s"\\}]*/.exec(chunk.trim())
    const entry = (walked === null ? '' : walked[0]).replace(/\.$/, '')
    if (entry === '') continue
    const at = entry.lastIndexOf('@')
    const name = at > 0 ? entry.slice(0, at) : entry
    if (name !== '' && !found.some(seen => seen.name === name)) {
      found.push({ name, key: allowBuildKeyFromIgnoredBuild(entry) })
    }
  }
  return found
}

/**
 * Package names pnpm reported as having their build scripts ignored
 * ("Ignored build scripts: esbuild, koffi."). Empty when none.
 * (#6 by @qichuang321.)
 */
export function parseIgnoredBuilds(stdout: string, stderr: string): string[] {
  return parseIgnoredBuildEntries(stdout, stderr).map(entry => entry.name)
}
