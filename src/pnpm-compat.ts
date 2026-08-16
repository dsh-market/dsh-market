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
export interface PnpmFailure {
  code: 'adding-to-root' | 'not-a-workspace' | 'hoist-pattern-diff' | 'pnpm-missing' | 'release-age-violation'
    | 'ignored-builds' | 'git-prepare-not-allowed' | 'fetch-404' | 'transient-network' | 'fetch-timeout'
  /** Bilingual, actionable message shown to the user instead of the raw wall of text. */
  message: string
  /** True when re-running `pnpm install` in the profile is the documented recovery. */
  recoverable: boolean
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
