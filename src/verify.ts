/**
 * Post-install activation verification (P0-2): what "installed" actually
 * means for a package in a dsh profile.
 *
 * Two sources of truth, in strict order of authority:
 *
 * 1. The LOADER INVENTORY (observed): whatever the loader is running right
 *    now is live, full stop. A plain library with no `dsh` field can be
 *    loaded by name from someone else's bundle patch — the official
 *    dsh-base patch loads `@deepseek-ai/dsh-tools`, which has no `dsh`
 *    field at all — so no manifest check may overrule it (#135).
 * 2. The profile manifest (inferred): `<profile>/package.json` →
 *    `dsh.profile.bundles`, what the dsh CLI reconciled. This predicts what
 *    the NEXT boot will load, and is the only evidence available for a
 *    package that is not currently running.
 *
 * State taxonomy (IMPROVEMENT-PLAN P0-2):
 *   live    – running in the current composition (hot mount or loader entry)
 *   restart – installed and will activate on the next boot, but not live now
 *   inert   – installed but not a profile-layer plugin (plain dependency, or
 *             client-only — the market shim-mounts those at boot)
 *   broken  – would fail to load: listed as a bundle without a dsh surface,
 *             or a declared entry artifact that is missing
 *   missing – not present in node_modules
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listHotMounts, parseSimplePatch } from './hot.ts'
import { bundlePatchInsertedIds, hasDshManifest, hasLoadableEntry, profileDir } from './profile.ts'

export type ActivationState = 'live' | 'restart' | 'inert' | 'broken' | 'missing' | 'disabled'

export interface ActivationResult {
  state: ActivationState
  /** Bilingual, user-facing explanations (zh / en joined with " / "). */
  reasons: string[]
  /** True when the package is in the profile's `dsh.profile.bundles`. */
  bundle: boolean
  /** True when the package is live in the running composition. */
  hot: boolean
}

/** The profile manifest's `dsh.profile.bundles` — what the CLI reconciled. */
function readBundles(profile: string, explicitDir?: string): Set<string> {
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDir(profile, explicitDir), 'package.json'), 'utf8'),
    ) as { dsh?: { profile?: { bundles?: unknown } } }
    const bundles = manifest.dsh?.profile?.bundles
    return new Set(Array.isArray(bundles) ? bundles.filter((n): n is string => typeof n === 'string') : [])
  } catch {
    return new Set()
  }
}

interface PkgDsh {
  bundle?: unknown
  client?: unknown
}

/**
 * True when `live` contains the package itself or a subpath entry of it.
 *
 * The live set (see `liveNames` in routes.ts) holds loader entry names — the
 * `name:` field of each bundle patch row. Bundles usually name the bare
 * package (`dshmarket`, `@scope/pkg`), but may point at a subpath entry
 * (`@vectorize-io/hindsight-coding-agents/dsh`, `aegis/extensions/dsh/index.js`).
 * Either form means the package's fiber is up and it must read as live;
 * a different package sharing a name prefix (`@scope/pkg2` vs `@scope/pkg`)
 * must not — the `/` bound keeps the match a real subpath.
 */
function liveIncludes(live: ReadonlySet<string>, packageName: string): boolean {
  if (live.has(packageName)) return true
  const prefix = `${packageName}/`
  for (const name of live) if (name.startsWith(prefix)) return true
  return false
}

/**
 * True when a loader entry this package's OWN bundle patch inserts is up.
 *
 * A carrier bundle (#103) ships no plugin of its own: its patch mounts
 * ANOTHER package with configuration, so the live entry carries that other
 * package's name and `liveIncludes` can never match. The entry ID is the
 * part that belongs to this package — its patch created it — which is why
 * matching on it is both sufficient and precise: a neighbour that happens
 * to mount the same package does so under a different id.
 *
 * Without this the market kept telling users to restart for a plugin that
 * had been running since the restart (#156).
 */
function carriedRowLive(live: ReadonlySet<string>, profileDirectory: string, packageName: string): boolean {
  try {
    return bundlePatchInsertedIds(join(profileDirectory, 'node_modules', packageName))
      .some(id => live.has(`#${id}`))
  } catch {
    return false
  }
}

function readPkgDsh(profile: string, name: string, explicitDir?: string): PkgDsh | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDir(profile, explicitDir), 'node_modules', name, 'package.json'), 'utf8'),
    ) as { dsh?: PkgDsh }
    return manifest.dsh ?? {}
  } catch {
    return null
  }
}

function patchTextOf(profile: string, name: string, explicitDir?: string): string | null {
  try {
    return readFileSync(join(profileDir(profile, explicitDir), 'node_modules', name, 'cordis.patch.yml'), 'utf8')
  } catch {
    return null
  }
}

/**
 * Verify the activation state of one installed package.
 * @param live - names live in the current composition; defaults to the
 * market's hot-mount table (injectable for tests).
 */
export function verifyActivation(
  profile: string,
  name: string,
  live: ReadonlySet<string> = new Set(listHotMounts()),
  explicitDir?: string,
  isDisabled = false,
): ActivationResult {
  const activeProfileDir = profileDir(profile, explicitDir)
  const bundles = readBundles(profile, activeProfileDir)
  const inBundles = bundles.has(name)
  const dsh = readPkgDsh(profile, name, activeProfileDir)

  if (dsh === null) {
    return { state: 'missing', reasons: ['未安装 / not installed'], bundle: inBundles, hot: false }
  }

  // A user-disabled plugin reads as disabled, never as "restart to apply":
  // the switch state (market disable list or the user patch layer) is the
  // dominant fact, and the loader keeps it off on every boot.
  if (isDisabled) {
    return {
      state: 'disabled',
      reasons: ['已停用(市场开关或补丁层),重启后保持关闭 / disabled (market toggle or the patch layer) — stays off across restarts'],
      bundle: inBundles,
      hot: false,
    }
  }

  const dir = join(activeProfileDir, 'node_modules', name)
  // OBSERVED beats INFERRED (#135): the loader inventory is ground truth, so
  // a package the loader is running is live no matter what its manifest says.
  // Plain library packages legitimately carry no `dsh` field and are still
  // loaded by name from a bundle patch — @deepseek-ai/dsh-tools is loaded by
  // the official dsh-base patch and has no `dsh` field at all — so this check
  // has to come before any manifest-based verdict.
  const loaderLive = liveIncludes(live, name) || carriedRowLive(live, activeProfileDir, name)
  if (!hasDshManifest(dir)) {
    if (loaderLive) {
      return {
        state: 'live',
        reasons: ['已由 Loader 加载(该包未声明 dsh 元数据,由某个 bundle patch 按名加载)/ loaded by the loader (no dsh metadata of its own — a bundle patch loads it by name)'],
        bundle: inBundles,
        hot: true,
      }
    }
    // Not live and no dsh surface: for a package the profile lists as a
    // BUNDLE this is a real defect; for a plain dependency it is normal —
    // most dependencies are libraries, not plugins (#135).
    return inBundles
      ? {
          state: 'broken',
          reasons: ['已列入 profile bundle 层但未声明 dsh 元数据,加载会失败 / listed in the profile bundle layer but declares no dsh metadata — loading it fails'],
          bundle: true,
          hot: false,
        }
      : {
          state: 'inert',
          reasons: ['普通依赖(未声明 dsh 元数据),不是 profile 层插件;若它由某个 bundle patch 按名加载,启动后会显示为已加载 / a plain dependency with no dsh metadata — not a profile-layer plugin; if some bundle patch loads it by name it will read as live once running'],
          bundle: false,
          hot: false,
        }
  }
  // Carrier bundles (#103) ship no entry of their own — what they mount is
  // the point — so judge by "is anything loadable", not by this package's
  // own artifact.
  if (!loaderLive && !hasLoadableEntry(activeProfileDir, name)) {
    return {
      state: 'broken',
      reasons: [
        '声明的入口产物缺失(源码检出或构建被拦),下次启动会失败 / the declared entry artifact is missing (source-only checkout or blocked build) — the next boot would fail',
      ],
      bundle: inBundles,
      hot: false,
    }
  }

  if (loaderLive) {
    const clientOnly = dsh.bundle === undefined && dsh.client !== undefined
    return {
      state: 'live',
      reasons: [
        clientOnly
          ? '已热加载(纯客户端插件 shim)/ live via the client-only shim'
          : '已热加载(bundle patch)/ live via its bundle patch',
      ],
      bundle: inBundles,
      hot: true,
    }
  }

  if (inBundles) {
    const patch = patchTextOf(profile, name, activeProfileDir)
    const complex = patch !== null && parseSimplePatch(patch) === null
    return {
      state: 'restart',
      reasons: [
        complex
          ? 'bundle patch 含配置/表达式,热挂载仅支持纯 insert;重启后由 bundle 层生效 / the bundle patch contains config/expression rows; hot-mount only supports plain inserts — it activates on restart'
          : '已进入 profile bundle 层但本次未能热挂载;重启后生效 / in the bundle layer but not hot-mounted this session — it activates on restart',
      ],
      bundle: true,
      hot: false,
    }
  }

  // Not a profile-layer plugin. Client-only packages never enter bundles
  // (the dsh CLI skips them), so the market shim-mounts them at boot —
  // they still work, but "installed" never means "bundle layer".
  if (dsh.client !== undefined) {
    return {
      state: 'inert',
      reasons: [
        '未声明 dsh.bundle,不会进入 profile bundle 层(纯客户端插件);重启后由市场自动挂载生效 / no dsh.bundle — client-only plugins never enter the bundle layer; the market shim-mounts them at the next boot',
      ],
      bundle: false,
      hot: false,
    }
  }

  return {
    state: 'inert',
    reasons: [
      '未声明 dsh.bundle,已作为普通依赖安装,不会成为 profile 层 / no dsh.bundle — installed as a plain dependency, never a profile-layer plugin',
    ],
    bundle: false,
    hot: false,
  }
}

/**
 * Correct a post-UPDATE verdict for a plugin that was already running.
 *
 * `verifyActivation` answers "is this name in the live loader inventory".
 * That is the right question after an install and the wrong one after an
 * update: the plugin was already live, so the answer stays "live" while the
 * process keeps serving the module it imported at boot. Replacing files under
 * a running composition does not re-import anything.
 *
 * Measured on a real host rather than reasoned about — updating the market
 * from 1.11.3 to 1.12.2 left `/dsh-market/status` reporting 1.11.3 with an
 * unchanged boot id, while the update route called it hot-loaded in the same
 * response. The browser half genuinely does refresh (the host re-serves the
 * client bundle from disk), which is what makes the wrong verdict credible:
 * the UI visibly becomes the new version while the server half does not.
 *
 * Only a plugin that was ALREADY live is affected. One that was missing,
 * broken or disabled beforehand has nothing loaded to shadow the new build,
 * so its fresh mount really does run the new code.
 *
 * Client-only packages are excluded for the same reason from the other end:
 * they have no host half to go stale, and the browser fetches their bundle
 * from disk on the next page load. Telling their users to restart would be
 * #156 again, in a narrower place — see `hasHostHalf`.
 * @param result the verdict computed from the loader inventory
 * @param hostHalfWasLive whether a HOST half was live BEFORE the replacement
 */
export function activationAfterReplace(result: ActivationResult, hostHalfWasLive: boolean): ActivationResult {
  if (!hostHalfWasLive || result.state !== 'live') return result
  return {
    ...result,
    state: 'restart',
    hot: false,
    reasons: ['新版本已就位,但运行中的进程仍在使用启动时加载的旧模块——重启后生效(页面本身会立即变成新版,服务端不会) / the new build is in place, but the running process still serves the module it imported at boot — restart to apply (the page itself updates immediately; the server half does not)'],
  }
}

/**
 * Whether a package has a host (Node) half at all.
 *
 * A `dsh.client`-only package — themes, skins, most pure-UI plugins — runs
 * no server code: the market shim-mounts it so the loader has a live row,
 * and the browser re-fetches its bundle from disk on the next page load. An
 * update to one takes effect on refresh, with no restart to ask for.
 */
export function hasHostHalf(profile: string, name: string, explicitDir?: string): boolean {
  const dsh = readPkgDsh(profile, name, explicitDir)
  if (dsh === null) return false
  // Only a DEFINITE client-only package is excluded — the same test
  // verifyActivation uses for its own verdict. Testing `dsh.bundle` on its
  // own would read a package that declares neither key (`"dsh": {}`, which
  // the bundle layer still loads) as client-only, and quietly disable the
  // correction for it.
  return !(dsh.bundle === undefined && dsh.client !== undefined)
}
