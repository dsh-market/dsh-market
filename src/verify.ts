/**
 * Post-install activation verification (P0-2): what "installed" actually
 * means for a package in a dsh profile.
 *
 * The ground truth is the same manifest the dsh CLI reconciles:
 * `<profile>/package.json` → `dsh.profile.bundles`. A package is a
 * profile-layer plugin only when its name is in that list; a package
 * without `dsh.bundle` in its own manifest is never reconciled there and
 * therefore never activates through the normal boot path (client-only
 * plugins get a market-owned shim mount instead).
 *
 * State taxonomy (IMPROVEMENT-PLAN P0-2):
 *   live    – mounted into the running composition (hot mount present)
 *   restart – installed and will activate on the next boot, but not live now
 *   inert   – installed but never a profile-layer plugin (no dsh.bundle)
 *   broken  – installed but validation failed (no dsh surface / no entry
 *             artifact) — the next boot could fail
 *   missing – not present in node_modules
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listHotMounts, parseSimplePatch } from './hot.ts'
import { entryArtifactExists, hasDshManifest, profileDir } from './profile.ts'

export type ActivationState = 'live' | 'restart' | 'inert' | 'broken' | 'missing'

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
): ActivationResult {
  const activeProfileDir = profileDir(profile, explicitDir)
  const bundles = readBundles(profile, activeProfileDir)
  const inBundles = bundles.has(name)
  const dsh = readPkgDsh(profile, name, activeProfileDir)

  if (dsh === null) {
    return { state: 'missing', reasons: ['未安装 / not installed'], bundle: inBundles, hot: false }
  }

  const dir = join(activeProfileDir, 'node_modules', name)
  if (!hasDshManifest(dir)) {
    return {
      state: 'broken',
      reasons: ['该包未声明 dsh 元数据,不会在启动时加载 / this package declares no dsh metadata and will never load'],
      bundle: inBundles,
      hot: false,
    }
  }
  if (!entryArtifactExists(dir)) {
    return {
      state: 'broken',
      reasons: [
        '声明的入口产物缺失(源码检出或构建被拦),下次启动会失败 / the declared entry artifact is missing (source-only checkout or blocked build) — the next boot would fail',
      ],
      bundle: inBundles,
      hot: false,
    }
  }

  if (liveIncludes(live, name)) {
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
