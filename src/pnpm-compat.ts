/**
 * pnpm compatibility layer — everything the market needs to know about how
 * different pnpm majors behave inside a dsh profile directory, kept pure and
 * separately testable (test/unit + test/integration exercise this module
 * against real pnpm 9/10/11).
 *
 * Verified behavior matrix (2026-08, pnpm 9.15.9 / 10.28.2 / 11.21.0):
 * - workspace root, `add` without -w:  pnpm 9 fails ERR_PNPM_ADDING_TO_ROOT;
 *   pnpm 10/11 succeed.
 * - `add -w` where NO pnpm-workspace.yaml exists: ALL majors fail with
 *   "--workspace-root may only be used inside a workspace".
 * - modules dir built by pnpm 9, then pnpm 10/11 mutate it:
 *   ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF (defaults drifted between majors).
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'


/**
 * Decide the argv for a `dsh plugin <add|remove> …` call in the given profile.
 *
 * pnpm 9 refuses to add at a workspace root without -w (#17, #20); every
 * pnpm major refuses -w when the directory is NOT a workspace. So the flag
 * is injected exactly when the profile has a pnpm-workspace.yaml.
 * @param profileDir - resolved profile directory (owns pnpm-workspace.yaml, or not).
 * @param pluginArgs - the raw args, e.g. ['add', 'dshmarket@latest'].
 * @returns args with -w injected when — and only when — the profile is a workspace root.
 */
export function pluginArgsFor(profileDir: string, pluginArgs: string[]): string[] {
  if (pluginArgs[0] !== 'add' && pluginArgs[0] !== 'remove') return pluginArgs
  if (!existsSync(join(profileDir, 'pnpm-workspace.yaml'))) return pluginArgs
  return [pluginArgs[0], '-w', ...pluginArgs.slice(1)]
}

/** One recognized pnpm failure, with a bilingual explanation for the UI. */
/**
 * The namespace whose packages the dsh runtime provides rather than npm.
 *
 * A peer dependency on one of these is a statement about the host, not a
 * package to download — and several of them are never published at all.
 */
export const HOST_NAMESPACE_RE = /^@deepseek-ai\//

export interface PnpmFailure {
  code: 'adding-to-root' | 'not-a-workspace' | 'hoist-pattern-diff' | 'pnpm-missing' | 'release-age-violation'
    | 'ignored-builds' | 'git-prepare-not-allowed' | 'fetch-404' | 'transient-network' | 'fetch-timeout'
    | 'unexpected-store' | 'patch-failed' | 'missing-tarball-integrity'
  /** Bilingual, actionable message shown to the user instead of the raw wall of text. */
  message: string
  /** True when re-running `pnpm install` in the profile is the documented recovery. */
  recoverable: boolean
  /**
   * The package pnpm could not resolve, when the failure names one.
   *
   * Exposed because the NAME alone does not say what went wrong: the same
   * 404 is a ghost entry the user must delete when the package is a direct
   * dependency of the profile, and an unpublished host peer the market can
   * retry around when it is not (#289). Only a caller holding the profile
   * manifest can tell those apart, so the classifier reports the fact and
   * leaves the judgement to it.
   */
  pkg?: string
}

/**
 * Momentary network failures — worth exactly one automatic retry (#83).
 * pnpm 5xx fetch codes, its meta-fetch give-up, and the raw socket errors
 * that surface through dsh's wrapper. Permanent shapes (404, auth) are
 * deliberately absent: retrying those just doubles the wait for bad news.
 */
export function isTransientPnpmFailure(output: string): boolean {
  return /ERR_PNPM_FETCH_5\d\d|ERR_PNPM_META_FETCH_FAIL|FetchError|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|socket hang up|network timeout/i.test(output)
}

/**
 * pnpm's per-request fetch timeout: the abort surfaces as a DOMException
 * ("The operation was aborted due to timeout", code 23) through undici —
 * pnpm logs it as `GET … error (23)` before giving up. This is the failure
 * shape for large tarballs (github: sources download the WHOLE repo, even
 * for a `#path:` subdirectory plugin) on slow networks: pnpm's default
 * 60-second limit is simply not enough, so a plain retry fails again at the
 * same limit. The market's recovery re-runs once with a longer
 * fetchTimeout (see withHoistRecovery).
 */
export function isFetchTimeoutFailure(output: string): boolean {
  return /operation was aborted due to timeout|TimeoutError|error \(23\)/i.test(output)
}

/**
 * Add human diagnostics decoded from pnpm's NDJSON reporter to its raw output.
 *
 * Mutating market commands always use `--reporter=ndjson`, so an error's
 * message normally arrives as a JSON string: quotes are escaped and embedded
 * newlines are `\n`. Matching only the raw stream therefore misses the exact
 * production form even when it works against pnpm's pretty reporter.
 */
function withDecodedPnpmDiagnostics(output: string): string {
  const messages: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const event = JSON.parse(trimmed) as { message?: unknown; err?: unknown }
      if (typeof event.message === 'string') messages.push(event.message)
      if (typeof event.err === 'object' && event.err !== null) {
        const message = (event.err as Record<string, unknown>).message
        if (typeof message === 'string') messages.push(message)
      }
    } catch {
      // Human reporter output and truncated NDJSON remain available verbatim.
    }
  }
  return messages.length === 0 ? output : `${output}\n${messages.join('\n')}`
}

/**
 * Map a failed pnpm run's combined output to a known failure mode.
 *
 * dsh's own wrapper line ("dsh: pnpm failed in profile directory …") names no
 * cause, so the market must recognize pnpm's real diagnostics itself (#20).
 * @param output - stdout+stderr of the failed run.
 * @returns the classified failure, or null when unrecognized (raw output is then shown as-is).
 */
export function classifyPnpmFailure(output: string): PnpmFailure | null {
  if (output.includes('ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF')) {
    return {
      code: 'hoist-pattern-diff',
      recoverable: true,
      message: 'profile 的 node_modules 是旧版 pnpm 创建的，与当前 pnpm 的默认配置不兼容，需要重建后重试 / this profile\'s node_modules was created by a different pnpm major; it must be rebuilt (pnpm install) before changes can be applied',
    }
  }
  // #244: the store recorded in node_modules/.modules.yaml is not the one
  // this pnpm resolves by default (a pnpm upgrade, or a machine where
  // ~/.pnpm-store predates the %LOCALAPPDATA% default). pnpm 11's
  // checkCompatibility then refuses EVERY add and remove, so nothing in the
  // market works until the profile is relinked.
  //
  // No automatic recovery, deliberately. The reporter established that on
  // pnpm 11 `store-dir` is honoured from NOTHING but the CLI flag — not the
  // project .npmrc, not the user .npmrc, not pnpm-workspace.yaml in either
  // casing — so the only self-heal available is to re-run with
  // --store-dir pointed at whatever .modules.yaml happens to name. That
  // silently adopts a store path which may be stale, wrong, or on a drive
  // that no longer exists, and it relinks the entire node_modules to do it:
  // a repair that goes wrong here leaves a profile in worse shape than the
  // clear error it replaced. The paths are in the message; the choice is
  // the user's.
  if (output.includes('ERR_PNPM_UNEXPECTED_STORE')) {
    const linked = /currently linked from the store at "([^"]+)"/.exec(output)?.[1]
    const wanted = /wants to use the store at "([^"]+)"/.exec(output)?.[1]
    const detail = linked !== undefined && wanted !== undefined
      ? `\n  node_modules → ${linked}\n  pnpm 现在想用 / pnpm now wants → ${wanted}`
      : ''
    return {
      code: 'unexpected-store',
      recoverable: false,
      message: `这个 profile 的 node_modules 链接到的 pnpm store，和当前 pnpm 默认使用的 store 不是同一个，pnpm 因此拒绝所有安装与卸载。${detail}\n在 profile 目录里执行一次 \`pnpm install --store-dir <上面第一个路径>\` 重新链接即可（dsh 运行时可能占用文件，必要时先退出 dsh）/ this profile's node_modules is linked to a different pnpm store than the one pnpm now resolves, so pnpm refuses every install and uninstall.${detail}\nRelink by running \`pnpm install --store-dir <the first path above>\` once in the profile directory (stop dsh first if files are locked)`,
    }
  }
  // #367: pnpm verifies every tarball resolution in the lockfile before it
  // performs ANY add/remove. One old or half-written entry without an
  // integrity hash therefore blocks unrelated plugin operations too.
  //
  // Do not auto-repair this. Computing and writing a hash means choosing to
  // trust the bytes currently served by the URL, which is a supply-chain
  // decision the market cannot safely make for the user. We only name the
  // package when pnpm emits its canonical quoted `name@https-url` shape;
  // aggregate or reworded diagnostics get the generic message rather than a
  // guessed package name.
  if (output.includes('ERR_PNPM_MISSING_TARBALL_INTEGRITY')) {
    const diagnostic = withDecodedPnpmDiagnostics(output)
    const pkg = /Cannot (?:install|fetch) package\s+"((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@https?:\/\/[^"\s]+"(?: from the lockfile)?:\s*(?:its lockfile entry|it) has no "integrity" field/i.exec(diagnostic)?.[1]
    const zh = pkg === undefined ? '' : `（${pkg}）`
    const en = pkg === undefined ? '' : ` (${pkg})`
    return {
      code: 'missing-tarball-integrity',
      recoverable: false,
      pkg,
      message: `profile 的 pnpm-lock.yaml 里有一个 tarball 依赖${zh}缺少 integrity，pnpm 因此拒绝所有安装和卸载。请先确认 URL 和 tarball 可信，再重新解析/下载该依赖以写入 sha512 integrity，或从可信的 lockfile 版本恢复该字段，然后重试；市场不会自动为未验证的字节生成校验值 / a tarball dependency${en} in this profile's pnpm-lock.yaml has no integrity, so pnpm refuses every install and uninstall. Verify the URL and tarball first, then re-resolve/download that dependency to record a sha512 integrity, or restore the field from a trusted lockfile version before retrying; the market will not generate a checksum for unverified bytes automatically`,
    }
  }
  // #222 by @MicroMilo: a patch in the profile that no longer applies.
  //
  // pnpm exits 1 (verified against 10.29.3) but it has ALREADY written the
  // package — unpatched. So the profile is left holding the pristine version
  // the patch existed to fix, and the damage shows up at the next boot as
  // "failed to load plugins" rather than here, where it happened.
  //
  // Almost always the package moved the file the patch names: the reported
  // case patched `client/client.js` in a package that had started shipping
  // `lib/client.js`. That is not something the market can repair — the patch
  // is the user's, and guessing a new target would be inventing a change
  // they did not write — so it says exactly what is wrong and where.
  if (output.includes('ERR_PNPM_PATCH_FAILED')) {
    const patch = /Could not apply patch (\S+)/.exec(output)?.[1]
    const which = patch === undefined ? '' : `（${patch}）`
    const whichEn = patch === undefined ? '' : ` (${patch})`
    return {
      code: 'patch-failed',
      recoverable: false,
      message: `profile 里的一个 pnpm 补丁打不上了${which}。pnpm 会继续把这个包装上，但装的是没打补丁的原版——通常下次启动才会以「插件加载失败」暴露出来。多半是包升级后挪动了补丁指向的文件（例如补丁改的是 client/client.js，而新版本发的是 lib/client.js）。请更新或删掉这个补丁文件，以及 profile package.json 里 pnpm.patchedDependencies 中对应的那一条 / a pnpm patch in this profile no longer applies${whichEn}. pnpm still installs the package, but unpatched — which usually surfaces at the next boot as "failed to load plugins" rather than here. The usual cause is the package moving the file the patch targets (for example a patch against client/client.js when the release now ships lib/client.js). Update or remove that patch file and its entry under pnpm.patchedDependencies in the profile's package.json`,
    }
  }
  if (output.includes('ERR_PNPM_ADDING_TO_ROOT')) {
    return {
      code: 'adding-to-root',
      recoverable: false,
      message: 'pnpm 拒绝在 workspace 根目录安装（缺少 -w）。这是市场的 bug，请升级 dshmarket 到最新版 / pnpm refused to add at a workspace root (missing -w); this is a market bug — please update dshmarket',
    }
  }
  if (/--workspace-root may only be used inside a workspace/i.test(output)) {
    return {
      code: 'not-a-workspace',
      recoverable: false,
      message: 'profile 目录不是 pnpm workspace，却传入了 -w。这是市场的 bug，请升级 dshmarket 到最新版 / -w was passed but the profile is not a pnpm workspace; this is a market bug — please update dshmarket',
    }
  }
  // #39: once a release younger than minimumReleaseAge is in the lockfile
  // (fresh install or a force-update), pnpm 11 verifies the WHOLE lockfile
  // before ANY later mutation — uninstalling even an unrelated plugin fails
  // (MINIMUM_RELEASE_AGE_VIOLATION), and a later add can fail re-resolving
  // the young dep (NO_MATURE_MATCHING_VERSION). Recovery is a one-shot
  // --config.minimumReleaseAge=0 retry, automated in withHoistRecovery.
  if (output.includes('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION')
    || output.includes('ERR_PNPM_NO_MATURE_MATCHING_VERSION')) {
    return {
      code: 'release-age-violation',
      recoverable: false,
      message: '这个 profile 里有一个刚发布不久的插件版本，pnpm 的安全等待期检查因此拒绝了本次改动（即使改的是别的插件）。市场已自动放行重试一次；若仍看到本条，请导出日志反馈 / a recently-published plugin version in this profile trips pnpm\'s fresh-release safety check, blocking any change (even to other plugins); the market retries once with a one-shot bypass — if you still see this, export the log and report it',
    }
  }
  // #69: pnpm >= 10 blocks dependency build scripts by default. The install
  // route has long surfaced this via the approve-builds banner (#6, #56),
  // but as a hard failure (pnpm 11 exits 1) the raw stack leaked through —
  // and the update route showed it verbatim.
  if (output.includes('ERR_PNPM_IGNORED_BUILDS')) {
    return {
      code: 'ignored-builds',
      recoverable: false,
      message: '有依赖需要执行构建脚本，被 pnpm 默认拦截。点击「允许构建脚本并重试」放行后重试即可 / a dependency needs to run build scripts, which pnpm blocks by default — click "Allow build scripts and retry" to approve and retry',
    }
  }
  // #68: git-hosted packages with a prepare/prepack script are rejected in
  // pnpm's FETCHER, before anything lands in node_modules — so the package
  // the user must approve is not installed yet, and pnpm's own hint names a
  // commit-pinned codeload URL that changes on every push.
  if (output.includes('ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED')) {
    return {
      code: 'git-prepare-not-allowed',
      recoverable: false,
      message: '这个 git 插件需要在安装时执行构建脚本，被 pnpm 默认拦截。点击「允许构建脚本并重试」放行后重试即可 / this git-hosted plugin needs to run its build script at install time, which pnpm blocks by default — click "Allow build scripts and retry" to approve and retry',
    }
  }
  // #65: a dependency that no longer resolves — an unpublished package left
  // in the manifest by an earlier failed operation (pnpm writes package.json
  // before it finishes), or a private-registry package without credentials.
  // pnpm re-resolves EVERY direct dependency on any add, so one ghost entry
  // blocks all later installs, of anything.
  if (output.includes('ERR_PNPM_FETCH_404')) {
    const pkg = /GET\s+\S*\/([^/\s]+):/.exec(output)?.[1].replace(/%2[Ff]/g, '/')
    const zh = pkg === undefined ? '' : `（${pkg}）`
    const en = pkg === undefined ? '' : ` (${pkg})`
    return {
      code: 'fetch-404',
      recoverable: false,
      pkg,
      message: `有一个依赖在 registry 上不存在${zh}，pnpm 因此拒绝任何安装操作。它可能是之前失败操作残留在 profile package.json 里的幽灵依赖（可手动删除该行），也可能是需要登录的私有包 / a dependency cannot be resolved from the registry${en}; pnpm refuses every install while it is present. It may be a ghost entry left in the profile's package.json by an earlier failed operation (remove that line by hand), or a private package needing registry credentials`,
    }
  }
  // #83: pnpm replays the WHOLE dependency tree on every add/remove, so a
  // moment of network flakiness against ANY already-installed dependency
  // (codeload tarball, registry meta) fails the run — and the market then
  // reported "install failed" for a plugin that was perfectly fine, only for
  // a plain retry to succeed seconds later. withHoistRecovery retries once;
  // this message covers the case where the retry lost too.
  if (isTransientPnpmFailure(output)) {
    return {
      code: 'transient-network',
      recoverable: false,
      message: '拉取依赖时网络临时失败（不一定是你正在装的插件——安装会重放整个依赖树，任何一个既有依赖抖动都会中断）。已自动重试一次仍失败，请稍后再试 / a transient network failure while fetching dependencies (not necessarily the plugin you are installing — installs replay the whole dependency tree, so any existing dependency can hiccup); one automatic retry failed too — please try again shortly',
    }
  }
  // pnpm's per-request fetch timeout (#…): large tarballs (github: sources
  // fetch the whole repo even for a `#path:` subdirectory) on slow networks
  // blow pnpm's default 60s limit. A plain retry fails again at the same
  // limit, so withHoistRecovery retries with a longer fetchTimeout.
  if (isFetchTimeoutFailure(output)) {
    return {
      code: 'fetch-timeout',
      recoverable: false,
      message: '下载超时：这个插件的安装包较大（github 源会下载整个仓库）或网络较慢，pnpm 默认的单次请求 60 秒限制不够用。市场已用更长的超时自动重试一次；若仍失败，请稍后再试或检查网络 / download timed out: this plugin ships a large tarball (github sources download the whole repository) or your network is slow, and pnpm\'s default 60-second per-request limit was not enough; the market retries once with a longer timeout — if it still fails, try again later or check the network',
    }
  }
  if (output.includes('pnpm not found on PATH')) {
    return {
      code: 'pnpm-missing',
      recoverable: false,
      message: '找不到 pnpm，请先在市场页顶部一键安装组件 / pnpm is not on PATH — use the one-click setup at the top of the market page',
    }
  }
  return null
}
