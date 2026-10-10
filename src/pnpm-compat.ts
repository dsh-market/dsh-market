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
 * - modules dir built by pnpm 9, then pnpm 10/11 mutate it: a modules-layout
 *   compatibility error (public-hoist-pattern on Unix; virtual-store path
 *   length can be the first mismatch pnpm reports on Windows).
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
    | 'ignored-builds' | 'git-prepare-not-allowed' | 'git-prepare-failed' | 'tarball-url-mismatch'
    | 'fetch-404' | 'no-matching-version' | 'transient-network' | 'fetch-timeout'
    | 'unexpected-store' | 'patch-failed' | 'unused-patch' | 'missing-tarball-integrity' | 'windows-file-locked'
    | 'profile-file-locked'
    | 'pnpm-unusable' | 'missing-local-dependency' | 'unparseable-build-key' | 'native-oom' | 'ssh-auth-failed'
    | 'lockfile-broken' | 'lockfile-outdated' | 'pnpm-stalled'
  /** Bilingual, actionable message shown to the user instead of the raw wall of text. */
  message: string
  /** True when re-running `pnpm install` in the profile is the documented recovery. */
  recoverable: boolean
  /**
   * Show this message INSTEAD of the captured output, not after it.
   *
   * Normally the raw text is worth keeping: it is pnpm's own account of what
   * happened, and the explanation sits under it. Set only where the captured
   * bytes carry nothing a user can read — cmd.exe writes its errors in the
   * OEM code page, which arrives here as replacement characters, so pasting
   * them under an explanation adds noise and hides the explanation (#502).
   */
  replaceOutput?: boolean
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
 * Every package pnpm named as having no lockfile integrity, in order.
 *
 * Two shapes, because pnpm 11 rewrote this diagnostic and the market has to
 * read both (verified against 10.28.2 / 11.21.0 / 11.22.0):
 *
 * - Up to pnpm 11.20, one package per error, quoted with its full URL:
 *   `Cannot install package "name@https://…": its lockfile entry has no
 *   "integrity" field`.
 * - From pnpm 11.21, a supply-chain policy pass verifies the WHOLE lockfile
 *   up front and reports every violator at once, as indented
 *   `  name@version <reason>` lines under an `N lockfile entries failed
 *   verification:` header (pnpm's own `formatEntry`; the mixed-code variant
 *   inserts `[MISSING_TARBALL_INTEGRITY]` before the reason).
 *
 * Only the first shape was recognized, so on current pnpm the market fell
 * back to a message that said an entry was bad without saying which one —
 * and since pnpm refuses even to uninstall the offender, naming it is the
 * whole of the user's recovery path (#422).
 *
 * The name is still never guessed. A candidate counts only when it carries a
 * version-shaped suffix, which is what keeps a bare URL out and stops
 * `alias@npm:real@1.0.0` from being read as `real` — `:` and `/` are absent
 * from the version character class, and the lookbehind rejects a name that
 * is really the tail of a longer token.
 * @param diagnostic - decoded pnpm output.
 * @returns the distinct package names, or an empty array when none is unambiguous.
 */
function integrityViolators(diagnostic: string): string[] {
  const NAME = String.raw`(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*`
  const found: string[] = []
  const add = (name: string | undefined): void => {
    if (name !== undefined && !found.includes(name)) found.push(name)
  }
  add(new RegExp(String.raw`Cannot (?:install|fetch) package\s+"(${NAME})@https?:\/\/[^"\s]+"(?: from the lockfile)?:\s*(?:its lockfile entry|it) has no "integrity" field`, 'i')
    .exec(diagnostic)?.[1])
  const listed = new RegExp(
    String.raw`(?<![\w./:@-])(${NAME})@[A-Za-z0-9._+-]+(?:\s+\[MISSING_TARBALL_INTEGRITY\])? has no "integrity" field`,
    'gi',
  )
  for (const match of diagnostic.matchAll(listed)) add(match[1])
  return found
}

/**
 * Map a failed pnpm run's combined output to a known failure mode.
 *
 * dsh's own wrapper line ("dsh: pnpm failed in profile directory …") names no
 * cause, so the market must recognize pnpm's real diagnostics itself (#20).
 * @param output - stdout+stderr of the failed run.
 * @param exitCode - the run's exit status, when the caller has it (null when
 *   the process was signalled). Only a
 *   failure whose whole signal IS the status reads it (#502); everything else
 *   is recognized from what pnpm said.
 * @returns the classified failure, or null when unrecognized (raw output is then shown as-is).
 */
export function classifyPnpmFailure(output: string, exitCode?: number | null): PnpmFailure | null {
  // #817: the host's silence watchdog (@deepseek-ai/dsh-plugin-manager,
  // `idleTimeoutMs`, 10 minutes by default) killed pnpm. Checked first: it is
  // the last thing that happened, so whatever pnpm printed before is not the
  // cause. The usual culprit is a dependency's install script downloading a
  // binary from a host this network cannot reach — the reporter's cloudflared
  // postinstall fetching from GitHub Releases — so the last lifecycle line
  // pnpm printed names the package that went quiet.
  const stalled = /printed nothing for (\d+)ms and was terminated/.exec(output)
  if (stalled !== null) {
    const minutes = Math.max(1, Math.round(Number(stalled[1]) / 60000))
    const scripts = [...output.matchAll(/node_modules[\\/]((?:@[^\\/\s]+[\\/])?[^\\/\s]+) (?:pre|post)?install[:$]/g)]
    const culprit = scripts.at(-1)?.[1]?.replace('\\', '/')
    return {
      code: 'pnpm-stalled',
      recoverable: false,
      message: culprit !== undefined
        ? `依赖 ${culprit} 的安装脚本 ${minutes} 分钟没有任何输出，被终止了，什么都没装上。这类脚本通常在从网上下载文件，多半是当前网络连不上下载地址；插件本身没有问题。换个网络或开启代理后重试；仍然不行就联系插件作者。 / the install script of the dependency ${culprit} printed nothing for ${minutes} minutes and was stopped, so nothing was installed. Scripts like this usually download a file, and this network most likely cannot reach where it comes from; the plugin itself is not at fault. Try again on another network or through a proxy, and contact the plugin's author if it still fails.`
        : `pnpm ${minutes} 分钟没有任何输出，被终止了，什么都没装上。通常是网络卡住了。检查网络后重试。 / pnpm printed nothing for ${minutes} minutes and was stopped, so nothing was installed. This usually means the network stalled. Check the connection and try again.`,
    }
  }
  if (output.includes('ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF')
    || output.includes('ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF')) {
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
    const modulesDir = /The dependencies at "([^"]+)"/.exec(output)?.[1]
    const detail = linked !== undefined && wanted !== undefined
      ? `\n  node_modules → ${linked}\n  pnpm 现在想用 / pnpm now wants → ${wanted}`
      : ''
    // DSH Desktop installs market plugins in a staging workspace under
    // $DSH_HOME/profiles/.generations/staging/. When that staging tree
    // carries no pnpm-workspace.yaml of its own, pnpm resolves the
    // workspace root by walking the ancestor chain — and a
    // pnpm-workspace.yaml ABOVE the staging tree (a home folder used as a
    // pnpm workspace is the usual one) claims the install together with
    // ITS store. The profile's own node_modules is not the one that
    // mismatched, so the ordinary profile-relink advice is wrong here.
    // Match only .generations/staging — a .generations/live path is not
    // the disposable staging workspace.
    if (modulesDir !== undefined && /[/\\]\.generations[/\\]staging[/\\]/.test(modulesDir)) {
      return {
        code: 'unexpected-store',
        recoverable: false,
        message: `桌面端的插件安装暂存目录（.generations/staging）被上层的 pnpm workspace 接管（通常是 ~/pnpm-workspace.yaml，它的 node_modules 链到另一个 store），pnpm 因此拒绝在暂存目录里安装。这不是 profile 的 node_modules。处理办法（任选其一）：用那个上层 workspace 自己的 pnpm 大版本重新链接它的 node_modules；或不需要那份祖先 workspace 的话，删掉它的 pnpm-workspace.yaml。暂存目录 → ${modulesDir}${detail} / the desktop client's install staging directory (.generations/staging) was claimed by a pnpm workspace above it (usually ~/pnpm-workspace.yaml, whose node_modules links a different pnpm store), so pnpm refuses to install there. This is not the profile's node_modules. Fix (any one): relink that outer workspace's node_modules with its own pnpm major; or remove that ancestor pnpm-workspace.yaml if you do not need it. Staging directory → ${modulesDir}${detail}`,
      }
    }
    return {
      code: 'unexpected-store',
      recoverable: false,
      message: `这个 profile 的 node_modules 链接到的 pnpm store，和 pnpm 现在解析出的 store 不是同一个，pnpm 因此拒绝这个 profile 的所有安装与卸载。典型触发是把 $DSH_HOME 迁到另一个挂载点：迁盘前建的 node_modules 记着旧盘上的 store，而 pnpm 会按新的挂载点自动改选一个（#244 的另一种触发，见 #715）。${detail}\n持久的修法：把**记录里的那个** store 写进 profile 的 pnpm-workspace.yaml（顶层、驼峰）：\n\n  storeDir: <上面第一个路径>\n\n加完不用重装任何东西——包本来就在那个 store 里，直接重试即可（dsh 运行时可能占用文件，必要时先退出 dsh）。\n注意 \`pnpm install --store-dir <路径>\` **不是修复**：它只对那一次命令生效，也不会改写 node_modules/.modules.yaml 里的记录，所以下一条命令会报同样的错（pnpm 11.7 与 11.22 实测）。\n想改用 pnpm 现在解析出的那个 store 也行，但那要求清空并重装整个 node_modules（包全部重新下载），代价由你决定。 / this profile's node_modules is linked to a different pnpm store than the one pnpm now resolves, so pnpm refuses every install and uninstall for it. The usual trigger is moving $DSH_HOME to another mount point: a node_modules built before the move records the old disk's store while pnpm re-selects one for the new mount.${detail}\nDurable fix: write the store from the RECORD into the profile's pnpm-workspace.yaml (top level, camelCase):\n\n  storeDir: <the first path above>\n\nNothing has to be reinstalled — the packages are already in that store — so just retry (stop dsh first if files are locked).\nNote that \`pnpm install --store-dir <path>\` is NOT a fix: it applies to that one command and does not rewrite the record in node_modules/.modules.yaml, so the next command fails exactly the same way (measured on pnpm 11.7 and 11.22).\nSwitching to the store pnpm now resolves is also possible, but it requires purging and reinstalling the whole node_modules (every package re-downloaded) — your call, not the market's.`,
    }
  }
  // #367: pnpm verifies every tarball resolution in the lockfile before it
  // performs ANY add/remove. One old or half-written entry without an
  // integrity hash therefore blocks unrelated plugin operations too.
  //
  // Do not auto-repair this. Computing and writing a hash means choosing to
  // trust the bytes currently served by the URL, which is a supply-chain
  // decision the market cannot safely make for the user. So the ONE thing
  // this message has to get right is WHICH entry to remove — see
  // integrityViolators for why that was previously lost on pnpm 11.
  if (output.includes('ERR_PNPM_MISSING_TARBALL_INTEGRITY')) {
    const named = integrityViolators(withDecodedPnpmDiagnostics(output))
    // Only a single unambiguous name goes in `pkg`: callers treat it as "the
    // package this failure is about", which a list is not.
    const pkg = named.length === 1 ? named[0] : undefined
    const zh = named.length === 0 ? '' : `（${named.join('、')}）`
    const en = named.length === 0 ? '' : ` (${named.join(', ')})`
    return {
      code: 'missing-tarball-integrity',
      recoverable: false,
      pkg,
      message: `profile 的 pnpm-lock.yaml 里有 tarball 依赖${zh}缺少 integrity，pnpm 因此拒绝这个 profile 里的所有安装和卸载——包括卸载它自己，所以装不回来也删不掉。这种条目通常是旧版市场留下的：它把 GitHub 插件写成了带镜像前缀的 tarball 地址，pnpm 认不出那是 GitHub，就要求一个它自己从不为 GitHub 源写入的校验值。新版市场改为交给 pnpm 原生的 GitHub 地址，不会再产生这种条目（#385）。请在 pnpm-lock.yaml 里删掉上面点名的那条依赖记录后重试，市场会用当前方式把它重新装回来；不要删整个 pnpm-lock.yaml，那会让其余插件全部重新解析版本。市场不会自动为未经验证的字节生成校验值 / a tarball dependency${en} in this profile's pnpm-lock.yaml has no integrity, so pnpm refuses every install and uninstall in this profile — including uninstalling that dependency itself, so it can be neither repaired nor removed. Entries like this usually come from an older market version, which installed GitHub plugins from a mirror-prefixed tarball URL: pnpm cannot tell that is GitHub, so it demands a checksum it never writes for GitHub sources. Current versions hand pnpm its own native GitHub target instead and no longer produce such entries (#385). Delete the named dependency's entry from pnpm-lock.yaml and retry — the market will reinstall it the current way. Do not delete the whole pnpm-lock.yaml; that re-resolves the versions of every other plugin too. The market will not generate a checksum for unverified bytes automatically`,
    }
  }
  // #455 by @Asheblog: pnpm 11's supply-chain check compares every lockfile tarball URL
  // against the registry's published metadata. A lockfile generated against
  // registry.npmjs.org fails wholesale when the profile resolves a mirror
  // registry (npmmirror), because the mirror's metadata names its own
  // tarball host. pnpm refuses every operation while the mismatch stands,
  // and the same check runs inside a git-hosted package's own build — which
  // is how a floating github: dependency can break updates of unrelated
  // plugins (the inner failure surfaces as ERR_PNPM_PREPARE_PACKAGE).
  if (output.includes('ERR_PNPM_TARBALL_URL_MISMATCH')) {
    const diagnostic = withDecodedPnpmDiagnostics(output)
    const NAME = String.raw`(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*`
    const named = [...diagnostic.matchAll(new RegExp(String.raw`(?<![\w./:@-])(${NAME})@[A-Za-z0-9._+-]+ has a tarball URL`, 'gi'))]
      .map(match => match[1])
      .filter((name, index, all) => all.indexOf(name) === index)
    const pkg = named.length === 1 ? named[0] : undefined
    const zh = named.length === 0 ? '' : `（${named.join('、')}）`
    const en = named.length === 0 ? '' : ` (${named.join(', ')})`
    return {
      code: 'tarball-url-mismatch',
      recoverable: false,
      ...(pkg === undefined ? {} : { pkg }),
      message: `pnpm-lock.yaml 里有一些条目的 tarball 地址与当前 registry 发布的元数据不一致${zh}，pnpm 11 的供应链检查因此拒绝这个 profile 里的所有操作。这通常发生在镜像 registry（如 npmmirror）与用 npmjs.org 生成的 lockfile 相遇时——例如某个 git 插件仓库自带的 lockfile。可以按 pnpm 的提示执行 pnpm clean --lockfile 后重新安装，或把 registry 切回生成该 lockfile 的源 / some entries in pnpm-lock.yaml have tarball URLs that do not match the current registry's published metadata${en}; pnpm 11's supply-chain check therefore refuses every operation in this profile. This usually happens when a mirror registry (e.g. npmmirror) meets a lockfile generated against npmjs.org — for example a git-hosted plugin repository's own lockfile. Run pnpm clean --lockfile and reinstall as pnpm suggests, or switch the registry back to the source the lockfile was generated against`,
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
  // #740 by @lws2004: the other half of the story above. `patchedDependencies`
  // keys on `pkg@exactVersion`, and once the installed version moves past that
  // key pnpm 12 treats the stale patch as a HARD error: it writes NOTHING at
  // all. So an update of that plugin is refused in full — the version stays
  // where it was, the market's own log holds only exit=1, and the user reads
  // "the update did not apply" for what is really a patch that no longer
  // matches. Unlike ERR_PNPM_PATCH_FAILED there is no unpatched install to
  // discover later, which makes this the more confusing of the two. The patch
  // is the user's, so the market names the entries and says where to fix them
  // rather than guessing a retarget.
  if (output.includes('ERR_PNPM_UNUSED_PATCH')) {
    // `[^\n"]+`: the same sentence also arrives inside the ndjson stream,
    // where it ends at a quote rather than at the line — matching to the line
    // end there captured `"}}` as part of the package name.
    const unused = /The following patches were not used:\s*([^\n"]+)/
      .exec(withDecodedPnpmDiagnostics(output))?.[1]
    const named = unused === undefined
      ? []
      : unused.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
    const which = named.length === 0 ? '' : `（${named.join('、')}）`
    const whichEn = named.length === 0 ? '' : ` (${named.join(', ')})`
    return {
      code: 'unused-patch',
      recoverable: false,
      pkg: named.length === 1 ? named[0] : undefined,
      message: `profile 里的 pnpm 补丁有一条已经用不上了${which}：patchedDependencies 是按「包名@精确版本」钉的，而这次要装的版本已经越过它，pnpm 12 因此判定整条命令失败——它什么都没写，所以看起来像「点了更新没反应」。要么把补丁更新到新版本、并把 profile package.json 里 pnpm.patchedDependencies 的键改成「包名@新版本」，要么在新版本已经自带这个修复时直接删掉这一条和对应的补丁文件 / a pnpm patch in this profile is no longer used${whichEn}: patchedDependencies keys on "package@exactVersion", and the version being installed has moved past that key, so pnpm 12 fails the WHOLE command and writes nothing at all — which is why the update looks like it simply did not apply. Either retarget the patch to the new version and change its pnpm.patchedDependencies key in the profile's package.json to "package@newVersion", or — when the new release already carries that fix — drop the entry and its patch file`,
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
  // --config.minimum-release-age=0 retry, automated in withHoistRecovery.
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
  // #701: pnpm 12's native engine (pnpm-native) aborting on an allocation it
  // cannot get — "memory allocation of 5368709120 bytes failed", Windows exit
  // 3221226505 (0xC0000409, how a Rust abort ends there). Reported with an
  // A/B: on pnpm 12.5.1 every run with `autoInstallPeers: false` in the
  // workspace file (DSH writes it into every profile) aborted at ~5 GB peak
  // RSS, every run without it passed at ~80 MB, with free memory to spare.
  // Nothing about the plugin being installed; not something a retry of the
  // same command changes on the reporter's data, so none is attempted.
  if (/memory allocation of \d+ bytes failed/.test(output) || exitCode === 3221226505) {
    return {
      code: 'native-oom',
      recoverable: false,
      message: 'pnpm 12 的原生引擎在处理这个 profile 时耗尽了内存并中止——和要安装的插件无关。在 pnpm 修复之前，请改用 pnpm 11（npm install -g pnpm@11）后再试。 / pnpm 12\'s native engine ran out of memory on this profile and aborted — the plugin being installed is not the cause. Until pnpm fixes it, switch to pnpm 11 (npm install -g pnpm@11) and try again.',
    }
  }
  // #698: pnpm 10.26+ and 11.0–11.5 read an allowBuilds key as
  // `name@<version union>`, so a git or archive source there fails the WHOLE
  // workspace file — every pnpm command in the profile, not the one plugin.
  // Named separately from any install failure because the cure is in the
  // profile's own pnpm-workspace.yaml, which withHoistRecovery repairs.
  {
    const found = /ERR_PNPM_INVALID_VERSION_UNION[\s\S]*?Found: \\?"([^"\\]+)\\?"/.exec(output)
    if (found !== null && /@(?:git\+|https?:)/.test(found[1]!.slice(1))) {
      return {
        code: 'unparseable-build-key',
        recoverable: false,
        pkg: found[1],
        message: `这个版本的 pnpm 读不懂 allowBuilds 里的 git 来源键（${found[1]}），整个 profile 的包操作都会因此失败 / this pnpm version cannot read a git-source key in allowBuilds (${found[1]}), which fails every package operation in the profile`,
      }
    }
  }
  // #596: the ssh half of #587. git asks for a passphrase (or a host-key
  // confirmation) on a terminal a spawned child does not have; the market
  // closes that prompt with `BatchMode=yes` so the question becomes a fast
  // failure instead of a fifteen-minute hang. This is that failure, and it
  // needs its own message because git's own words send the reader to the
  // wrong place: `Permission denied (publickey)` reads as "your key is
  // wrong", and the key is usually fine — it wants a passphrase, and the
  // channel that would have asked for it is exactly what was shut.
  if (/Permission denied \(publickey\)|Could not read from remote repository/.test(output)) {
    return {
      code: 'ssh-auth-failed',
      recoverable: false,
      message: 'git 无法在无人值守的情况下完成 SSH 认证。如果你的 SSH key 设了密码，请用 ssh-agent（ssh-add），或自己设置 GIT_SSH_COMMAND 指向你的命令，市场不会覆盖它。 / git could not complete SSH authentication unattended. If your SSH key has a passphrase, use ssh-agent (ssh-add), or set GIT_SSH_COMMAND to your own command — the market leaves yours alone.',
    }
  }
  if (output.includes('ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED')) {
    return {
      code: 'git-prepare-not-allowed',
      recoverable: false,
      message: '这个 git 插件需要在安装时执行构建脚本，被 pnpm 默认拦截。点击「允许构建脚本并重试」放行后重试即可 / this git-hosted plugin needs to run its build script at install time, which pnpm blocks by default — click "Allow build scripts and retry" to approve and retry',
    }
  }
  // #455 by @Asheblog: a git-hosted package with a prepare/prepack script failed its own
  // build. pnpm runs `pnpm install` inside the fetched repository and
  // rethrows the inner failure as ERR_PNPM_PREPARE_PACKAGE with only a
  // one-line summary — the inner diagnostics (which package, which registry)
  // are not propagated, so the user sees "pnpm install Exit status 1" with no
  // cause. The most common cause on pnpm 11 is the repository's own
  // pnpm-lock.yaml failing the supply-chain check against a mirror registry
  // (tarball URLs pointing at registry.npmjs.org while the profile resolves
  // npmmirror); the repository's build script itself failing, or a network
  // problem, are the other ones.
  if (output.includes('ERR_PNPM_PREPARE_PACKAGE')) {
    const diagnostic = withDecodedPnpmDiagnostics(output)
    const named = /Failed to prepare git-hosted package fetched from "https:\/\/codeload\.github\.com\/[^"]+":\s*((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@[A-Za-z0-9._+-]+/i
      .exec(diagnostic)?.[1]
    const zh = named === undefined ? '' : `（${named}）`
    const en = named === undefined ? '' : ` (${named})`
    return {
      code: 'git-prepare-failed',
      recoverable: false,
      ...(named === undefined ? {} : { pkg: named }),
      message: `git 插件${zh}在安装时需要执行它自己仓库里的构建脚本（pnpm install），但构建失败了。最常见的原因是仓库自带的 pnpm-lock.yaml 与你的 registry 不兼容：lockfile 里的 tarball 地址指向 registry.npmjs.org，而你的 registry 是镜像（如 npmmirror），pnpm 11 的供应链检查会拒绝整个 lockfile；也可能是仓库的构建脚本本身报错或网络问题。可以先把这个依赖固定到已知可用的 commit（github:owner/repo#<commit>）再更新其他插件，或临时把 registry 切到 npmjs.org 重试 / a git-hosted plugin${en} failed to run its own build (pnpm install) during install. The most common cause is the repository's pnpm-lock.yaml being incompatible with your registry: its tarball URLs point at registry.npmjs.org while your registry is a mirror (e.g. npmmirror), which pnpm 11's supply-chain check rejects; the repository's build script itself failing, or a network problem, are the other causes. Pin that dependency to a known-good commit (github:owner/repo#<commit>) before updating other plugins, or temporarily switch the registry to npmjs.org and retry`,
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
  // #569: a host peer that only ever published pre-releases (e.g.
  // `@deepseek-ai/dsh-tools` with nothing above `-rc.*`) resolves to NO
  // stable version, and pnpm reports ERR_PNPM_NO_MATCHING_VERSION — the
  // package exists, the requested range matches nothing. This is the same
  // unpublished-host-peer shape #289 recovers from, just with a different
  // error code, so the classifier names it separately and the #289 retry
  // shares it via install.ts's gate. Real output (pnpm 12.4.1): see
  // tests/pnpm-compat.spec.ts, which pins this wording.
  if (output.includes('ERR_PNPM_NO_MATCHING_VERSION')) {
    const pkg = /No matching version found for\s+((?:@[^/\s]+\/)?[^@\s]+)@/.exec(output)?.[1]
      ?? /GET\s+\S*\/([^/\s]+):/.exec(output)?.[1].replace(/%2[Ff]/g, '/')
    const zh = pkg === undefined ? '' : `（${pkg}）`
    const en = pkg === undefined ? '' : ` (${pkg})`
    const hostPeer = pkg !== undefined && HOST_NAMESPACE_RE.test(pkg)
    return {
      code: 'no-matching-version',
      recoverable: false,
      pkg,
      message: hostPeer
        ? `插件声明依赖的宿主包${zh}在 registry 上没有满足其版本范围的发布版（宿主运行时会自带它，npm 上不会出现这个版本）。市场会自动重试一次，放行这条 peer 依赖 / a plugin's declared host peer${en} has no published version satisfying its range — the runtime provides it, so npm carries no such version. The market retries once with that peer exempted from auto-install`
        : `插件声明的一个依赖版本范围在 registry 上没有可满足的版本${zh}，通常是该版本被弃用或从未发布 / a dependency of this plugin declared a version range with no matching release on the registry${en} — the range resolves to nothing (withdrawn or never published)`,
    }
  }
  // #808 by @Tofu707: the profile's own pnpm-lock.yaml is what is wrong, in
  // two shapes that pnpm reports with two codes and two different repairs, so
  // they are classified apart rather than merged into one answer.
  //
  // `lockfile-outdated` is tested first, because its anchor is a code and
  // nothing else. The sentence pnpm prints here also arrives WRAPPED across
  // lines in the human reporter ("… is not up" / "to date with
  // package.json."), so keying on that sentence instead of the code would miss
  // the form users actually see.
  //
  // The two failures do not happen in a fixed order, so nothing here — and
  // nothing in either message — claims which one a user meets first.
  //
  // `recoverable: false` on both: repeating the same command cannot help, the
  // lockfile has to change first.
  if (output.includes('ERR_PNPM_OUTDATED_LOCKFILE')) {
    return {
      code: 'lockfile-outdated',
      recoverable: false,
      message: 'profile 的 pnpm-lock.yaml 与 package.json 对不上：锁文件里记的 specifier 和 manifest 里声明的不是同一个，pnpm 因此在 frozen-lockfile 这一步直接拒绝，什么都没装。先备份一份 pnpm-lock.yaml，再在 profile 目录里重新生成锁文件（pnpm 最后一行会给出它自己那一版的命令；pnpm install --lockfile-only 也让锁文件与 package.json 对齐）后重试。这与「锁文件里缺条目」是两个不同的报错、对应两种不同的修法，两条命令不要互相套用（#808） / this profile\'s pnpm-lock.yaml does not match package.json: the specifier recorded in the lockfile is not the one the manifest declares, so pnpm refuses at the frozen-lockfile check and installs nothing. Back up pnpm-lock.yaml first, then regenerate the lockfile in the profile directory (pnpm\'s last line names the command for its own version; pnpm install --lockfile-only also realigns the lockfile with package.json) and retry. This is a different error with a different repair from a lockfile that is missing an entry — do not apply one repair to the other',
    }
  }
  // `lockfile-broken` is the lockfile contradicting ITSELF: an importer names
  // a dependency that has no entry under `packages:`. pnpm 11 and 12 word it
  // identically and both carry the code, so the rule keys on the code and on
  // pnpm's own phrase — and deliberately NOT on pnpm's closing `help:` line,
  // which drifts: 11.24.0 offers `pnpm install --no-frozen-lockfile` for this
  // failure while 12.8.1 offers `pnpm install --fix-lockfile` (and for the
  // outdated failure above it offers a third command again, `--lockfile-only`).
  // Measured 2026-10-08 against 11.24.0 and 12.8.1.
  //
  // Both shapes reach here whichever stream pnpm used. Market commands run with
  // `--reporter=ndjson`, and in that same measurement 11.24.0 wrote the error
  // record to stdout as one JSON line while 12.8.1 wrote nothing to stdout at
  // all (0 bytes) and put the error block on stderr as plain text.
  // withDecodedPnpmDiagnostics lifts the message out of the first form, and
  // both forms then carry these two strings verbatim.
  //
  // The missing entry is named in the message but deliberately NOT put in
  // `pkg`: callers read `pkg` as "the package this failure is about" and act on
  // it (the #289 peer retry, the #65 ghost-entry advice), and neither applies —
  // the repair is in the lockfile, not in the manifest entry.
  if (output.includes('ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY') || /Broken lockfile/.test(output)) {
    const broken = /no entry for '?([^'\s]+@[^'\s]+)'? in pnpm-lock\.yaml/i
      .exec(withDecodedPnpmDiagnostics(output))?.[1]
    const zh = broken === undefined ? '' : `（${broken}）`
    const en = broken === undefined ? '' : ` (${broken})`
    return {
      code: 'lockfile-broken',
      recoverable: false,
      message: `profile 的 pnpm-lock.yaml 自相矛盾：有个依赖在 importers 里记着，packages 里却没有它的条目${zh}，pnpm 因此在真正写 node_modules 的那一步拒绝整个命令。先备份一份 pnpm-lock.yaml；在 importers 下删掉这个依赖的那条记录（它的名字、specifier、version 三行），再在 profile 目录里执行 pnpm install --no-frozen-lockfile --lockfile-only，然后重试。不要用 pnpm 提示的 --fix-lockfile：在 12.x 上它修不好这种状态（11.x 上能修，所以那条提示只在 12.x 的 help 里出现，照它走会把 12.x 用户送到一条一定失败的命令上）。不要删掉整个 pnpm-lock.yaml，那会把其余插件的版本一起重新解析（#808） / this profile\'s pnpm-lock.yaml contradicts itself: a dependency is recorded in importers but has no entry under packages${en}, so pnpm refuses the whole command at the step that actually writes node_modules. Back up pnpm-lock.yaml first; remove that dependency\'s record from importers (its name, specifier and version lines); then run pnpm install --no-frozen-lockfile --lockfile-only in the profile directory and retry. Do not use the --fix-lockfile that pnpm itself suggests: on 12.x it does not repair this state (it does on 11.x, which is why that suggestion only appears in 12.x\'s help, and following it sends a 12.x user to a command that always fails). Do not delete the whole pnpm-lock.yaml either: that re-resolves every other plugin\'s version too (#808)`,
    }
  }
  // #786 follow-up: pnpm could not replace one of the profile's own files —
  // `package.json`, `pnpm-lock.yaml` — or the lockfile it keeps INSIDE
  // `node_modules/.pnpm/lock.yaml`. None of these is a package directory.
  //
  // pnpm writes all of them through its bundled `write-file-atomic`, which does
  // ONE rename and no retry (measured on the bundled 11.7.0: the temp name is
  // `<file>.<hash>`, e.g. `pnpm-lock.yaml.3015012533`). Any momentary holder —
  // Defender scanning the just-written file, the Windows indexer, an editor —
  // fails the entire run. Measured on the reporter's own profile: 4 identical
  // `add` runs, the 4th failed this way and an immediate 5th succeeded.
  //
  // The `.pnpm/lock.yaml` shape is the SAME failure, not a lesser one: pnpm's
  // `writeLockfiles` writes the wanted lockfile and the current one through the
  // same write-file-atomic inside one `Promise.all` (pnpm 11.7.0, both the
  // equal-lockfile and the differing one branch). So a lock on the temp name
  // `…\.pnpm\lock.yaml.<hash>` fails the run exactly like a lock on
  // `pnpm-lock.yaml` — and answering it as the package-directory case below
  // would roll the profile's lockfile back over a `node_modules` that already
  // holds the new build, which is the desync this whole branch exists to stop.
  //
  // This must be answered BEFORE the package-directory branch below, whose
  // pattern is broad enough to swallow it: that branch blames the running host
  // for holding the plugin's files open and tells the user to quit DSH, which
  // is wrong here (nothing about the plugin is locked) and is the most
  // expensive advice available for a failure that a plain retry clears.
  //
  // `recoverable: false`, like the other same-argv retries (`transient-network`,
  // `fetch-timeout`): that flag means "re-running `pnpm install` is the
  // documented recovery", and no code reads it to decide a retry — the retry is
  // keyed on this code in `withHoistRecovery`. Marking it true would invite a
  // future reader to rebuild `node_modules` over a one-file rename.
  if (/(?:ERR_PNPM_)?EPERM[^\n]*rename[^\n]*(?:[\\/](?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)\.\d+|[\\/]\.pnpm[\\/]lock\.yaml\.\d+)/i.test(
    withDecodedPnpmDiagnostics(output),
  )) {
    return {
      code: 'profile-file-locked',
      recoverable: false,
      message: 'pnpm 写入 package.json 或 pnpm-lock.yaml 时被 Windows 拒绝了一下——通常是杀毒软件或索引服务正好在读这个刚写完的文件。插件本身没有被占用；市场已经自动重试过一次，还是失败，请再试一次 / Windows briefly refused pnpm\'s write of package.json or pnpm-lock.yaml — usually antivirus or the search indexer reading the file pnpm had just written. Nothing about the plugin is locked; the market already retried once and it still failed, so try again',
    }
  }
  // #389 by @qq1054435284: on Windows, pnpm stages the new version in a
  // sibling `<name>_tmp_<pid>_<n>` directory and renames it over the old one.
  // Windows refuses that rename while any file underneath the target is open,
  // and the process holding them is usually the one asking. POSIX does not
  // have this problem: replacing an open file there leaves the old inode
  // alive for whoever still holds it.
  //
  // Worded for the RENAME, not for an update (#441 by @yandidan1). The
  // reporter met this while INSTALLING — a reinstall of a plugin they had
  // just uninstalled — and was told their update had not applied, that their
  // existing version was intact, and to disable the plugin under Installed,
  // which they had already removed. The package pnpm names here is also not
  // necessarily a plugin: theirs was `node-hid`, a dependency.
  //
  // The native-module sentence is the part that makes the advice usable in
  // that case. Node never unloads a native addon: once a `.node` is loaded
  // there is no dlclose, so disabling the plugin, unmounting it, or
  // uninstalling it cannot release the file — only ending the process does.
  // That is why "uninstall, then install again" fails on Windows for those
  // plugins while it works for every other one.
  //
  // Not retried automatically. A retry from inside the same process cannot
  // win, because that process is the thing holding the handles; retrying
  // would only turn one clear failure into several slow ones. So this names
  // the cause and the ways out instead of guessing.
  // pnpm 12 (the native CLI) says it differently and carries no ERR_PNPM_
  // code: `failed to remove existing directory "…" prior to swap: …` — same
  // refused swap over the open directory, so the same answer.
  //
  // A Windows EPERM on a PROFILE file is NOT this case, and is answered
  // separately just above. pnpm's own write-file-atomic performs one rename
  // with no retry (measured on the bundled 11.7.0), so an antivirus scan, a
  // file indexer, or any process touching pnpm-lock.yaml for an instant fails
  // the whole run — after pnpm has already built and linked the new commit.
  // Reporting that as "the running host holds the plugin's files open" gave the
  // worst available advice (quit DSH), because the interference is momentary
  // and the next attempt succeeds.
  if (/ERR_PNPM_EPERM|EPERM: operation not permitted, rename|failed to remove existing directory .* prior to swap/i.test(output)) {
    // Read through the NDJSON reporter like the integrity classifier does:
    // in production this arrives JSON-escaped, so every separator is doubled
    // and a single-character class silently matches nothing.
    const diagnostic = withDecodedPnpmDiagnostics(output)
    const pkg = /node_modules[\\/]+((?:@[a-z0-9][a-z0-9._-]*[\\/]+)?[a-z0-9][a-z0-9._-]*)_tmp_\d+/i
      .exec(diagnostic)?.[1]?.replace(/\\+/g, '/')
    const zh = pkg === undefined ? '' : `（${pkg}）`
    const en = pkg === undefined ? '' : ` (${pkg})`
    return {
      code: 'windows-file-locked',
      recoverable: false,
      ...(pkg === undefined ? {} : { pkg }),
      message: `Windows 不允许替换正在被打开的文件。pnpm 要用新目录替换${zh === '' ? '一个已装好的包' : ` ${pkg!}`}，而它的文件正被运行中的 DeepSeek Harness 打开着，改名因此失败，这一步没有生效。\n要注意的是：pnpm 在重试改名之前会尽量把目标目录清掉，所以**被占用文件旁边的内容可能已经被删**——不一定只是「没换成」而已。市场遇到这种失败时不再尝试回滚（同一个改名会撞同一批句柄），而是把 package.json 与 pnpm-lock.yaml 恢复成操作前的样子，并检查原构建的入口是否还在——结论以那次检查为准。\n如果这个包带原生模块（.node 文件，例如 node-hid 这类），那么只停用、甚至卸载插件而不退出程序都不够：原生模块一旦被加载，在进程退出前都不会释放。刚卸载完立刻重装同一个插件在 Windows 上失败，通常就是这个原因。\n注意：这个包被锁住的时候，这个配置下**其他**插件的安装也会一起失败，不只是用到它的那一个。\n可行的做法：完全退出 DeepSeek Harness（不是刷新页面），重新启动后再操作一次；或退出后在命令行执行。如果重启后同一个包又被启动时加载、仍然失败，就先停用加载它的插件，再重启，操作完成后再启用它。杀毒软件或文件索引临时占用目录也会报同样的错，若都不适用可稍后重试。 / Windows will not replace a file that is open. pnpm tried to swap a new directory over${en === '' ? ' an installed package' : en}, whose files the running DeepSeek Harness holds open, so the rename failed and this step did not apply. Note that pnpm clears as much of the target directory as it can before retrying the rename, so content BESIDE the file it could not remove may already be gone — this is not always only "the swap did not happen". On this failure the market no longer attempts a rollback (the same rename would meet the same open handles); it restores package.json and pnpm-lock.yaml to how they were and then checks whether the previous build still has a loadable entry — that check is the answer. If that package ships a native module (a .node file, node-hid and friends), disabling the plugin — even uninstalling it — without quitting is not enough: once a native module is loaded it is not released until the process exits, which is the usual reason reinstalling a plugin right after uninstalling it fails on Windows. While that package is locked, every OTHER plugin operation that has to rewrite packages in this profile fails with it, not only the ones that use it. What works: quit DeepSeek Harness completely (not a page refresh), start it again, and repeat the operation; or run it from the command line with the app closed. If the same package is loaded at startup again and the retry still fails, disable the plugin that loads it, restart, update, and enable it again afterwards. Antivirus or a file indexer holding the directory produces the same error, so a later retry is worth trying if neither applies.`,
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
  // Reported by @screamff on #436: a `file:` dependency whose tarball or
  // directory is no longer on disk. pnpm re-resolves every direct dependency
  // before ANY mutation, so one dead local path blocks every install and
  // uninstall in the profile — including uninstalling the market, which is
  // what the reporter was trying to do. Same family as the #65 ghost
  // registry entry; the local form has its own error, and it names the PATH
  // rather than the package, which is why "a plugin is missing" was never a
  // usable description of it.
  //
  // Measured on pnpm 10.28.2 and 11.21.0 (both exit 254): the wording only
  // differs in how the code is bracketed, and both carry the path and the
  // "direct dependency" line. Both are required — an ENOENT from a build
  // script is a different failure and must not wear this explanation.
  const localMiss = /ENOENT: no such file or directory, open '([^']+)'/.exec(output)
  if (localMiss !== null && output.includes('while installing a direct dependency')) {
    return {
      code: 'missing-local-dependency',
      recoverable: false,
      message: `profile 里有一个从本地文件安装的插件，它的文件已经不在了（${localMiss[1]}）。pnpm 在做任何改动前都会重新解析全部直接依赖，所以这一条会挡住这个 profile 里的所有安装和卸载——包括卸载别的插件。请在 profile 的 package.json 的 dependencies 里删掉值等于上面这个路径的那一行（或在市场的「已安装」里卸载它），然后重试。 / a plugin in this profile was installed from a local file that no longer exists (${localMiss[1]}). pnpm re-resolves every direct dependency before making any change, so this one entry blocks every install and uninstall in the profile — including uninstalling other plugins. Remove the dependency whose value is that path from the profile's package.json (or uninstall it from the market's Installed list) and retry.`,
    }
  }
  // #502 by @Ztyss: a pnpm WAS found on PATH and could not be started.
  //
  // Different from `pnpm-missing` in the one way that matters to the user:
  // the market's own setup does not fix it, because as far as PATH is
  // concerned pnpm is already there. The reported case is a `pnpm.cmd`
  // wrapper built out of environment variables that only exist in its
  // installer's own process — expanded in the market's child process it
  // collapses to an empty command, and cmd.exe answers 9009 with its message
  // in the OEM code page, which reaches us as replacement characters. Three
  // updates in a row failed showing the user nothing but that.
  //
  // 9009 is cmd.exe's "command not found" and is language-independent, so it
  // leads; the text forms catch the same failure in a log with no exit code.
  //
  // #509 by @awslmowms added the other way a present pnpm fails to run: the
  // spawn itself is refused, and dsh's wrapper rethrows Node's error
  // verbatim — `EACCES, syscall: 'spawnSync pnpm'` on Ubuntu. Same class
  // (pnpm is there, it will not run, and the market's own setup cannot help)
  // but a different repair, so the message names the reason it was given.
  //
  // Last in the chain deliberately: pnpm's own errors never exit 9009 and
  // never fail to spawn, and anything pnpm actually said has matched above.
  const spawnRefused = /spawnSync pnpm/.test(output)
    ? /EACCES/.test(output) ? 'EACCES' : /ENOENT/.test(output) ? 'ENOENT' : 'unknown'
    : null
  const cmdNotFound = exitCode === 9009
    || /is not recognized as an internal or external command|不是内部或外部命令|不是內部或外部命令/.test(output)
  if (cmdNotFound || spawnRefused !== null) {
    // Each cause gets the repair that fits it. One generic sentence would
    // send the EACCES reporter hunting for a missing wrapper variable and
    // the Windows reporter reaching for chmod.
    const why = spawnRefused === 'EACCES'
      ? {
          zh: '系统拒绝执行它（EACCES，权限不足）。多半是那个文件没有执行权限，或者它所在的分区是以 noexec 挂载的。用 `ls -l $(command -v pnpm)` 看一眼权限位，必要时 `chmod +x`；如果 pnpm 装在 noexec 的分区上，换个位置重装。',
          en: 'the system refused to execute it (EACCES, permission denied). Usually the file has no execute permission, or it lives on a partition mounted noexec. Check the permission bits with `ls -l $(command -v pnpm)` and `chmod +x` if needed; if pnpm sits on a noexec partition, reinstall it elsewhere.',
        }
      : spawnRefused === 'ENOENT'
        ? {
            zh: '要执行的文件已经不在了（ENOENT）。PATH 里那条记录指向的 pnpm 被删掉或改名了，重新装一次 pnpm 即可。',
            en: 'the file it tried to execute is gone (ENOENT). The pnpm that entry on PATH points at has been deleted or renamed; reinstall pnpm.',
          }
        : {
            zh: '命令行没能把它启动起来（退出码 9009）。可能是它其实没装好，也可能它是一个包装脚本、而脚本需要的环境变量在市场启动的子进程里不存在。',
            en: "the command line could not launch it (exit code 9009). Either it is not installed properly, or it is a wrapper script whose required environment variables are missing in the market's child process.",
          }
    return {
      code: 'pnpm-unusable',
      recoverable: false,
      replaceOutput: true,
      message: `找不到能用的 pnpm，插件没有任何改动。系统里确实有一个 pnpm，但${why.zh}\n在终端里执行一次 \`pnpm --version\` 可以确认：那里同样失败，说明要修的是这台机器上的 pnpm；那里正常，说明是启动市场的方式带来的环境差异，改用普通的 \`dsh web\` 启动可以绕开。 / pnpm could not be started, and nothing was changed. A pnpm does exist on PATH, but ${why.en}\nRun \`pnpm --version\` in a terminal to check: failing there too means pnpm itself needs fixing on this machine; working there means the difference comes from how the market was launched, and starting dsh with a plain \`dsh web\` avoids it.`,
    }
  }
  return null
}
