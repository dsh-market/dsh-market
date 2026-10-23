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
 *   incompatible – the host's own boot gate will skip it on EVERY boot: its
 *             dsh peer range excludes the running runtime (#757). Restarting
 *             can never activate it — "restart to apply" would be a lie.
 *   inert   – installed but not a profile-layer plugin (plain dependency, or
 *             client-only — the market shim-mounts those at boot)
 *   broken  – would fail to load: listed as a bundle without a dsh surface,
 *             or a declared entry artifact that is missing
 *   missing – not present in node_modules
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { Script } from 'node:vm'
import { join } from 'node:path'
import { listHotMounts, parseSimplePatch } from './hot.ts'
import { userPatchPackageReferences } from './patch.ts'
import { nameMatchesPackage } from './entry-identity.ts'
import { bundlePatchInsertedIds, declaredBundlePatchFiles, hasDshManifest, hasLoadableEntry, pluginSubdirs, profileDir, readInstalled } from './profile.ts'
import { compareSemver, composeLayers, parsePatchFile, satisfiesRange } from './check.ts'
import { dshHostInfo } from './dsh-install.ts'

export type ActivationState = 'live' | 'restart' | 'incompatible' | 'inert' | 'broken' | 'missing' | 'disabled'

export interface ActivationResult {
  state: ActivationState
  /** Bilingual, user-facing explanations (zh / en joined with " / "). */
  reasons: string[]
  /** True when the package is in the profile's `dsh.profile.bundles`. */
  bundle: boolean
  /** True when the package is live in the running composition. */
  hot: boolean
  /**
   * The installed package that declares this one, when this package is a
   * plain library somebody else pulled in rather than a plugin the user
   * chose (#634). Only ever set on `inert`.
   */
  dependencyOf?: string
  /**
   * Set on `inert` when the package's own bundle patch loads nothing but the
   * user's own patch names it somewhere — an Agent preset's plugin row, say
   * (#813). The market cannot see those trees, so it neither promises a
   * restart nor calls the plugin off; it says where the plugin comes from.
   */
  loadedByProfile?: true
  /** The package explicitly declares itself a library, without a plugin surface. */
  library?: true
}

/**
 * Whether every bundle patch the package declares parses to an empty list.
 *
 * Such a bundle row loads nothing at boot: listing it in `dsh.profile.bundles`
 * or taking it out changes nothing, so neither "restart to apply" nor the
 * #696 "removed from bundles means off" inference applies to it (#813). A
 * patch that is missing or unreadable is NOT empty — other verdicts own it.
 */
export function bundlePatchIsEmpty(packageDir: string): boolean {
  const files = declaredBundlePatchFiles(packageDir)
  return files.length > 0 && files.every(file => parsePatchFile(file)?.length === 0)
}

/**
 * Whether the profile's own `cordis.patch.yml` names this package anywhere,
 * at any depth — including rows nested in another plugin's config, such as
 * an Agent preset's `plugins:` list, which never enter the host loader.
 * Evidence of where the plugin comes from, not of whether it is running.
 */
function profilePatchMentions(activeProfileDir: string, name: string): boolean {
  const rows = parsePatchFile(join(activeProfileDir, 'cordis.patch.yml'))
  if (rows === null) return false
  const seen = new Set<unknown>()
  const visit = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return false
    seen.add(value)
    if (Array.isArray(value)) return value.some(visit)
    const row = value as Record<string, unknown>
    if (nameMatchesPackage(row.name, name)) return true
    return Object.values(row).some(visit)
  }
  return rows.some(visit)
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
  kind?: unknown
}

/** Manifest-only library declaration; observed loader activity can override its status. */
export function isDeclaredLibraryDsh(dsh: PkgDsh | null | undefined): boolean {
  return dsh?.kind === 'library' && dsh.bundle === undefined && dsh.client === undefined
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
  for (const name of live) if (nameMatchesPackage(name, packageName)) return true
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
/**
 * Whether the profile's OWN `cordis.patch.yml` inserts this package by name.
 *
 * A third evidence source beside the loader inventory and the package's own
 * manifest, and the one that was missing (#165): a plugin the user wired up
 * themselves declares nothing, is not hot-mounted until the next boot, and so
 * fell through to `broken` — the market told them the install had failed
 * verification while the plugin was, in fact, working.
 *
 * Read with the same parser the uninstall guard uses. Unreadable returns
 * null, which is treated here as NO evidence rather than as evidence: this
 * only ever upgrades a verdict away from `broken`, so being unsure has to
 * leave the stricter answer standing.
 */
function patchLoads(activeProfileDir: string, name: string): boolean {
  const references = userPatchPackageReferences(join(activeProfileDir, 'cordis.patch.yml'), name)
  return references !== null && references.length > 0
}

/**
 * What the running host is, for the #757 boot-gate prediction.
 *
 * The host loader (evaluatePluginCompatibility in @deepseek-ai/dsh-app-boot)
 * semver-checks every bundle's `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`
 * peerDependencies against the runtime version and silently SKIPS the
 * bundles that fail — on every boot. From the market's side the bundle
 * layer still declares the plugin while the loader inventory never shows
 * it, so it reads exactly like "will activate on restart"… forever. A
 * profile may carry a compatibility.json whose `pkg@version` keys list
 * host versions allowed to load anyway (the host's
 * readProfileVersionExemptions); the market mirrors both halves.
 */
export interface HostRuntimeFacts {
  /** @deepseek-ai/dsh-app-boot version the host runs; null = unknown. */
  runtimeVersion: string | null
  /** `pkg@version` → host versions allowed to load despite the range. */
  exemptions: Record<string, readonly string[]>
}

/** One dsh peer requirement the running host provably fails. */
export interface PeerGate {
  peer: string
  range: string
  runtimeVersion: string
  /** True when the runtime sits BELOW the range's floor — upgrading the host can satisfy it (#758). */
  hostTooOld: boolean
}

const isDshPeer = (peer: string): boolean => peer === '@deepseek-ai/dsh' || peer.startsWith('@deepseek-ai/dsh-')

/**
 * Predict the host's boot gate for one installed package. Returns the first
 * dsh peer the running runtime fails, or null when the next boot would load
 * it — or when we cannot tell (unknown runtime, unparseable range), because
 * uncertainty must keep the old verdict, not invent a harsher one (#757).
 *
 * satisfiesRange runs with includePrerelease — the host's own semantics,
 * since every published host line is itself a prerelease — and an EMPTY
 * range counts as failing, mirroring the host: absence of a requirement is
 * not permission.
 *
 * Known differences from the host's verdict, kept deliberate (#758): the
 * runtime version comes from the @deepseek-ai/dsh-app-boot package.json
 * this tree can locate, not the host's self-reported getDshRuntimeVersion;
 * when no host is locatable the gate stands aside and the real boot still
 * applies its own. Exemptions mirror readProfileVersionExemptions from the
 * profile's compatibility.json. The FIRST failing dsh peer decides, as the
 * host's skip does — only the reported culprit may differ when several
 * peers fail at once.
 */
export function hostPeerGate(activeProfileDir: string, name: string, facts: HostRuntimeFacts): PeerGate | null {
  return peerGateAt(join(activeProfileDir, 'node_modules', name), name, facts)
}

/**
 * The unmet requirement, if any, and the remedy side it points at.
 *
 * Which side of the range the runtime sits on decides the remedy: below the
 * floor, upgrading the host genuinely helps; above the cap (#757's own
 * shape) no upgrade can satisfy it, and suggesting one points the wrong way
 * (#758).
 */
function unmetOf(peer: string, range: string, runtimeVersion: string): PeerGate {
  const floor = /[0-9]+\.[0-9]+\.[0-9]+[-+0-9A-Za-z.]*/.exec(range)
  const hostTooOld = floor !== null && compareSemver(runtimeVersion, floor[0]) < 0
  return { peer, range, runtimeVersion, hostTooOld }
}

/** Same prediction for a patch plugin resolved outside the profile's flat node_modules. */
function peerGateAt(packageDir: string, name: string, facts: HostRuntimeFacts): PeerGate | null {
  if (facts.runtimeVersion === null) return null
  let manifest: {
    version?: unknown
    engines?: Record<string, unknown>
    peerDependencies?: Record<string, unknown>
  }
  try {
    manifest = JSON.parse(
      readFileSync(join(packageDir, 'package.json'), 'utf8'),
    )
  } catch {
    return null
  }
  const version = typeof manifest.version === 'string' ? manifest.version : ''
  if (version !== '' && (facts.exemptions[`${name}@${version}`] ?? []).includes(facts.runtimeVersion)) {
    return null
  }
  // An own `engines.dsh` range decides ALONE and peerDependencies are then
  // ignored — the host's rule, read from unmetRequirements in
  // @deepseek-ai/dsh-app-boot, and the reason a gate that only read peers
  // was too lenient on 62 of 2796 (package, runtime) pairs measured over the
  // live catalog: `dsh-file-explorer-kit` (engines.dsh ^0.1.1) and
  // `dsh-workspace-kit` (^0.1.2-rc.1) declare NO dsh peer at all, so the
  // family that refuses them was invisible here and the card promised a
  // restart the host would not honour. A non-string range throws inside the
  // host's own evaluator; that is not a verdict this can predict, so the
  // old answer stands (#757).
  const engines = manifest.engines?.dsh
  if (engines !== undefined) {
    if (typeof engines !== 'string') return null
    const range = engines.trim()
    // `workspace:` is substituted only for PEERS: the host counts it as an
    // unmet range for engines, so an empty or invalid range stays unmet too.
    const satisfied = range === '' ? false : satisfiesRange(facts.runtimeVersion, range, { includePrerelease: true })
    return satisfied ? null : unmetOf('engines.dsh', range, facts.runtimeVersion)
  }
  for (const [peer, requirement] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!isDshPeer(peer) || typeof requirement !== 'string') continue
    const range = requirement.trim()
    const satisfied = range === '' ? false : satisfiesRange(facts.runtimeVersion, range, { includePrerelease: true })
    if (satisfied === false) return unmetOf(peer, range, facts.runtimeVersion)
  }
  return null
}

/**
 * #867: only the bundle's own effective loader rows are evidence, never its
 * ordinary dependency closure or arbitrary names in plugin configuration.
 * Compose every declared file together so later disables take effect. An
 * unreadable file or an expression-gated row gives no rejection evidence.
 */
function bundleRowPeerGate(
  packageDir: string,
  activeProfileDir: string,
  facts: HostRuntimeFacts,
): { name: string; gate: PeerGate } | null {
  if (facts.runtimeVersion === null) return null
  try {
    const patches = declaredBundlePatchFiles(packageDir).map(parsePatchFile)
    if (patches.some(rows => rows === null)) return null
    const { resolvableRows } = composeLayers([{
      label: 'bundle', kind: 'bundle', patches: patches.flatMap(rows => rows ?? []), parseError: null,
    }])
    const checked = new Set<string>()
    for (const row of resolvableRows) {
      if (row.activation !== 'required' || typeof row.name !== 'string') continue
      // Bare npm names and subpath entries only. Relative files, builtins,
      // aliases and expressions need runtime resolution; do not guess.
      if (/^[.#/\\]|[:\\]/u.test(row.name) || isBuiltin(row.name)) continue
      const parts = row.name.split('/')
      const name = parts.slice(0, row.name.startsWith('@') ? 2 : 1).join('/')
      if (!/^(?:@[\w.-]+\/)?[\w-][\w.-]*$/u.test(name) || checked.has(name)) continue
      checked.add(name)
      const directory = resolveBundleRowPackage(packageDir, activeProfileDir, name)
      if (directory === null) continue
      const gate = peerGateAt(directory, name, facts)
      if (gate !== null) return { name, gate }
    }
  } catch { /* malformed or cyclic patch data — no reliable prediction */ }
  return null
}

/**
 * Probe Node's search paths, without resolving an entry or requiring a
 * package.json export. The real bundle path reaches pnpm's adjacent and
 * nested dependencies; the profile anchor also covers workspace hoisting.
 * Stop at a present directory even if its manifest is missing: a broken
 * nearer copy must not borrow an incompatible manifest from a fallback.
 */
function resolveBundleRowPackage(packageDir: string, activeProfileDir: string, name: string): string | null {
  const bundleAnchor = join(realpathSync(packageDir), 'package.json')
  const manifest = JSON.parse(readFileSync(bundleAnchor, 'utf8')) as {
    name?: string; dependencies?: Record<string, unknown>; peerDependencies?: Record<string, unknown>
  }
  // The host publishes dependencies carried by selected bundles into its
  // profile resolution. A stray nested copy not declared by this bundle is
  // no evidence of what a profile row will import.
  const carried = manifest.name === name || Object.hasOwn(manifest.dependencies ?? {}, name)
    || Object.hasOwn(manifest.peerDependencies ?? {}, name)
  const profileAnchor = join(activeProfileDir, 'package.json')
  for (const anchor of carried ? [bundleAnchor, profileAnchor] : [profileAnchor]) {
    for (const searchPath of createRequire(anchor).resolve.paths(name) ?? []) {
      const candidate = join(searchPath, name)
      try {
        if (statSync(candidate).isDirectory()) return candidate
      } catch { /* try the next Node search path */ }
    }
  }
  return null
}

/** The way out of a peer gate, in the direction the versions allow (#758). */
export function peerGateRemedy(gate: PeerGate): { zh: string; en: string } {
  if (gate.hostTooOld) {
    return {
      zh: '升级 dsh、等插件更新适配或装回旧版本',
      en: 'upgrade dsh, wait for an updated release, or go back to the previous version',
    }
  }
  return {
    zh: '等插件更新适配或装回旧版本;升级 dsh 解决不了',
    en: 'wait for an updated release or go back to the previous version — upgrading dsh will not help',
  }
}

let cachedRuntimeVersion: string | null | undefined

/**
 * Discover the host runtime version once per process. Prefers the package
 * the host itself versions its runtime by (@deepseek-ai/dsh-app-boot, the
 * getDshRuntimeVersion source); falls back to the CLI package version,
 * which ships on the same line. null when no host is locatable at all
 * (tests, plain node) — which disables the gate.
 */
function discoverRuntimeVersion(): string | null {
  if (cachedRuntimeVersion !== undefined) return cachedRuntimeVersion
  const host = dshHostInfo()
  let version: string | null = null
  if (host !== null) {
    // The dsh package directory itself (a normal install) has the runtime
    // as a sibling; a Desktop shell root keeps it under node_modules.
    const candidates = [
      join(host.directory, 'node_modules', '@deepseek-ai', 'dsh-app-boot'),
      join(host.directory, '..', 'dsh-app-boot'),
    ]
    for (const dir of candidates) {
      try {
        const v = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version
        if (typeof v === 'string' && v !== '') { version = v; break }
      } catch { /* try the next layout */ }
    }
    if (version === null) version = host.version
  }
  cachedRuntimeVersion = version
  return version
}

/**
 * The production HostRuntimeFacts: the discovered runtime version plus the
 * profile's own exemption list. Re-read per call so an edited
 * compatibility.json takes effect without a market restart.
 */
export function defaultHostRuntimeFacts(activeProfileDir: string): HostRuntimeFacts {
  let exemptions: Record<string, readonly string[]> = {}
  try {
    const raw = JSON.parse(readFileSync(join(activeProfileDir, 'compatibility.json'), 'utf8')) as Record<string, unknown>
    exemptions = Object.fromEntries(
      Object.entries(raw).filter((entry): entry is [string, readonly string[]] =>
        Array.isArray(entry[1]) && entry[1].every(x => typeof x === 'string')),
    )
  } catch { /* no exemption file — nothing may bypass the gate */ }
  return { runtimeVersion: discoverRuntimeVersion(), exemptions }
}

export function verifyActivation(
  profile: string,
  name: string,
  live: ReadonlySet<string> = new Set(listHotMounts()),
  explicitDir?: string,
  isDisabled = false,
  hostFacts?: HostRuntimeFacts,
  loaderObserved = false,
): ActivationResult {
  const activeProfileDir = profileDir(profile, explicitDir)
  const bundles = readBundles(profile, activeProfileDir)
  const inBundles = bundles.has(name)
  const dsh = readPkgDsh(profile, name, activeProfileDir)

  if (dsh === null) {
    return { state: 'missing', reasons: ['未安装 / not installed'], bundle: inBundles, hot: false }
  }
  const declaredLibrary = isDeclaredLibraryDsh(dsh)
  // A loader entry can remain after its fiber is switched off. Retain that
  // evidence so an observed library can be re-enabled after disabling it.
  const loaderLive = liveIncludes(live, name) || carriedRowLive(live, activeProfileDir, name)

  // A user-disabled plugin reads as disabled, never as "restart to apply":
  // the switch state (market disable list or the user patch layer) is the
  // dominant fact, and the loader keeps it off on every boot.
  if (isDisabled && (!declaredLibrary || loaderLive || loaderObserved)) {
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
    if (inBundles && !patchLoads(activeProfileDir, name)) {
      return {
        state: 'broken',
        reasons: ['已列入 profile bundle 层但未声明 dsh 元数据,加载会失败 / listed in the profile bundle layer but declares no dsh metadata — loading it fails'],
        bundle: true,
        hot: false,
      }
    }
    if (inBundles) {
      return {
        state: 'restart',
        reasons: ['由你自己的 cordis.patch.yml 按名加载,重启后生效 / loaded by name from your own cordis.patch.yml — live after a restart'],
        bundle: true,
        hot: false,
      }
    }
    // A collection repository's ROOT package says nothing about itself and
    // holds the plugins one level down (#892). Installed whole — which the
    // market used to do before it learned to retarget one, and which a user
    // can still do by hand — it lands on this list as "installed, not in
    // effect" with no way out of that sentence. Name the plugins it does
    // carry and the way to install one: the dead end is the bug.
    const carried = pluginSubdirs(dir)
    const shown = carried.slice(0, 3).join('、')
    const more = carried.length > 3 ? `等 ${carried.length} 个` : ''
    const shownEn = carried.slice(0, 3).join(', ')
    const moreEn = carried.length > 3 ? ` and ${carried.length - 3} more` : ''
    return {
      state: 'inert',
      reasons: [carried.length > 0
        ? `这是集合仓库的根包,本身不是插件。可安装的子包：${shown}${more}。请装子包而不是它(仓库地址后加 #path:/子包目录) / this is a collection repository's root package, not a plugin itself; install one of its plugins instead — ${shownEn}${moreEn} — by adding #path:/<subdirectory> to the repository URL`
        : '普通依赖(未声明 dsh 元数据),不是 profile 层插件;若它由某个 bundle patch 按名加载,启动后会显示为已加载 / a plain dependency with no dsh metadata — not a profile-layer plugin; if some bundle patch loads it by name it will read as live once running'],
      bundle: false,
      hot: false,
    }
  }
  // A declared library is shared code, not a plugin waiting to start. This
  // manifest fact does not overrule an observed loader entry or a real plugin
  // surface, and a library need not have a loadable plugin entry artifact.
  if (!loaderLive && !loaderObserved && declaredLibrary) {
    return {
      state: 'inert',
      library: true,
      reasons: ['供其他插件使用，无需启用 / for other plugins to use; no need to enable it'],
      bundle: inBundles,
      hot: false,
    }
  }
  // Carrier bundles (#103) ship no entry of their own — what they mount is
  // the point — so judge by "is anything loadable", not by this package's
  // own artifact.
  if (!loaderLive && !hasLoadableEntry(activeProfileDir, name) && !patchLoads(activeProfileDir, name)) {
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

  // An empty bundle patch (#813): the bundle row brings nothing in, so a
  // restart cannot change the verdict and "restart to apply" would stand
  // forever. Say where the plugin comes from instead, when the profile's own
  // patch names it; otherwise nothing loads it, and that is the truth.
  if (dsh.client === undefined && bundlePatchIsEmpty(dir)) {
    return profilePatchMentions(activeProfileDir, name)
      ? {
          state: 'inert',
          loadedByProfile: true,
          reasons: ['它自带的 bundle 补丁是空的，由你的配置（例如 Agent 预设）加载；市场看不到它是否正在运行 / its own bundle patch is empty, so your own setup (an Agent preset, for example) loads it; the market cannot see whether it is running'],
          bundle: inBundles,
          hot: false,
        }
      : {
          state: 'inert',
          reasons: ['它自带的 bundle 补丁是空的，你的配置里也没有引用它，所以不会加载 / its own bundle patch is empty and your setup does not reference it, so nothing loads it'],
          bundle: inBundles,
          hot: false,
        }
  }

  if (inBundles) {
    // #757: "restart to apply" is only honest when the next boot would
    // actually load the bundle. The host skips bundles whose dsh peer
    // range excludes the running runtime — predict that verdict here so
    // the plugin reads as incompatible instead of promising a restart
    // that cannot fix it.
    const facts = hostFacts ?? defaultHostRuntimeFacts(activeProfileDir)
    const gate = hostPeerGate(activeProfileDir, name, facts)
    if (gate !== null) {
      const remedy = peerGateRemedy(gate)
      return {
        state: 'incompatible',
        reasons: [
          `新版本要求宿主 ${gate.range},当前运行 ${gate.runtimeVersion},重启也不会生效;${remedy.zh} / the new version needs host ${gate.range}, but this host runs ${gate.runtimeVersion} — a restart will not activate it; ${remedy.en}`,
        ],
        bundle: true,
        hot: false,
      }
    }
    const child = bundleRowPeerGate(dir, activeProfileDir, facts)
    if (child !== null) {
      const { gate, name: plugin } = child
      const remedy = gate.hostTooOld
        ? { zh: '升级 dsh，或更新此插件包以匹配当前 dsh', en: 'upgrade dsh, or update this bundle to match the current dsh' }
        : { zh: '更新此插件包，或安装与当前 dsh 兼容的版本；升级 dsh 解决不了', en: 'update this bundle or install a version compatible with the current dsh — upgrading dsh will not help' }
      return {
        state: 'incompatible',
        reasons: [
          `它加载的插件 ${plugin} 要求 ${gate.peer} ${gate.range}，当前 dsh 为 ${gate.runtimeVersion}，重启也不会生效；${remedy.zh} / its plugin ${plugin} requires ${gate.peer} ${gate.range}, but dsh runs ${gate.runtimeVersion} — a restart will not activate it; ${remedy.en}`,
        ],
        bundle: true,
        hot: false,
      }
    }
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

/**
 * The client bundle path a package's `exports["./client"]` names, relative
 * to the package root — or `null` when it cannot be resolved CONFIDENTLY.
 *
 * Returning null is the important half. This feeds a post-install check
 * whose only job is to catch a corrupt bundle, and a resolver that guessed
 * wrong would report a healthy plugin as broken — worse than the silence it
 * replaces. So every shape this does not fully understand resolves to null
 * and the check simply does not run: unresolvable is not evidence of damage.
 *
 * Handles the two shapes real plugins ship: a plain string, and a
 * conditional object. For the object, only `browser` and `default` are
 * consulted — those are the conditions the host's client loader actually
 * activates; `import`/`require` describe a Node resolution this file is not
 * modelling, and picking one of those could name a different artifact.
 * Nested conditions recurse; anything else (arrays, non-relative targets)
 * gives up.
 */
export function clientBundlePath(exportsField: unknown, depth = 0): string | null {
  if (depth > 4) return null
  if (typeof exportsField === 'string') {
    // Only a relative in-package path. A bare specifier or URL is a shape
    // this resolver does not model.
    return exportsField.startsWith('./') ? exportsField : null
  }
  if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)) return null
  const conditions = exportsField as Record<string, unknown>
  for (const key of ['browser', 'default']) {
    if (conditions[key] === undefined) continue
    const resolved = clientBundlePath(conditions[key], depth + 1)
    if (resolved !== null) return resolved
  }
  return null
}

/** What a bundle check concluded. `ok` covers "fine" AND "could not tell". */
export interface BundleCheck {
  ok: boolean
  /** Populated only when the file was found AND failed to parse. */
  reason: string | null
}

/**
 * One assignment of a string literal to a name, and the `configForms.get`
 * call sites (#810).
 *
 * The namespace a client asks its config from is a PROFILE ENTRY ID, not a
 * package name. A client that writes the package name reads nothing: the
 * settings document has no entry under it, the call returns empty, and the
 * plugin degrades silently — blank or unwritable settings forms, and in the
 * reported case a panel stuck on a hardcoded fallback port. Nothing logs it,
 * and nothing on the market side noticed.
 *
 * `configForms.get` is matched by name, so an aliased receiver
 * (`const forms = ctx.configForms; forms.get("x")`) is not seen — the same
 * honesty as the syntax check above: this reports what it can prove, and
 * says nothing otherwise.
 */
const STRING_ASSIGNMENT = /(?:^|[^\w$.])(?:var|let|const)?\s*([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"\\\n]*)\2/gu
const CONFIG_FORMS_GET = /configForms\s*\.\s*get\s*\(\s*(?:([A-Za-z_$][\w$]*)|(['"])([^'"\\\n]*)\2)\s*\)/gu

/** A value that is a plain loader entry id: a backslash means it is not one. */
function plainNamespace(value: string): string | null {
  return value !== '' && value.length <= 200 && !value.includes('\\') && /^[\w@/.:-]+$/u.test(value) ? value : null
}

/**
 * Every namespace a client bundle asks its config from (#810).
 *
 * One level of constant propagation, as asked for in the report: the plugin
 * that started this writes `var NAMESPACE = "dsh-comfyui-canvas"` and calls
 * `configForms.get(NAMESPACE)`, so a literal-only scan would miss the very
 * case the check exists for. A name assigned twice is dropped rather than
 * guessed at — which value it holds at the call site is not decidable from
 * text alone, and a wrong guess here would be reported as a plugin defect.
 */
export function configFormNamespaces(source: string): string[] {
  // Measured on a 750KB bundle: these scans cost ~9ms, because both walk
  // every character, and this runs on a request the market polls. Almost no
  // client mentions configForms at all, and — an order of magnitude rarer —
  // almost none of those calls a method on it: for both, this pair of plain
  // substring searches IS the whole cost (0.23ms measured), and only a client
  // that actually asks for a config pays for a scan.
  if (!source.includes('configForms') || !source.includes('configForms.get')) return []
  const constants = new Map<string, string | null>()
  for (const match of source.matchAll(STRING_ASSIGNMENT)) {
    const name = match[1]!
    const value = plainNamespace(match[3]!)
    constants.set(name, constants.has(name) || value === null ? null : value)
  }
  const namespaces = new Set<string>()
  for (const match of source.matchAll(CONFIG_FORMS_GET)) {
    // A namespace is a loader entry id: no escapes, no whitespace runs, no
    // arbitrary length. Anything else is not this pattern and stays out.
    const value = plainNamespace(match[3] ?? '') ?? constants.get(match[1]!) ?? null
    if (value !== null) namespaces.add(value)
  }
  return [...namespaces]
}

/** A package whose client asks for a namespace nothing in the composition serves (#810). */
export interface UnservedConfigNamespace {
  /** The installed package whose client bundle asks. */
  name: string
  /** The namespaces it asks for that no loader entry id answers to. */
  namespaces: string[]
  /** Entry ids this package's own patch declares — the value it meant. */
  ownEntryIds: string[]
}

/** The client bundle of an installed package, read; null when it has none to read. */
function readClientBundle(profile: string, name: string, explicitDir?: string): string | null {
  const root = join(profileDir(profile, explicitDir), 'node_modules', name)
  let manifest: { dsh?: { client?: unknown }; exports?: unknown }
  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as typeof manifest
  } catch {
    return null
  }
  if (manifest.dsh?.client === undefined) return null
  const exportsField = manifest.exports
  const relative = exportsField !== null && typeof exportsField === 'object' && !Array.isArray(exportsField)
    ? clientBundlePath((exportsField as Record<string, unknown>)['./client'])
    : null
  if (relative === null) return null
  try {
    return readFileSync(join(root, relative), 'utf8')
  } catch {
    return null
  }
}

/**
 * Installed plugins whose client reads its config from a name nothing serves
 * (#810).
 *
 * `served` is the entry id set of the WHOLE composition — deliberately not
 * this package's own ids: a package may legitimately mount another one
 * (carrier form), and judging by own ids alone would flag those. `ownIdsOf`
 * answers what the package itself declares, which is the value to write
 * instead — the report asked for the correct spelling to be shown, not just
 * the mistake.
 *
 * The scan reads one bundle per installed plugin. Measured against the same
 * cost the syntax sweep above already pays (0.40ms per plugin on a 385KB
 * bundle), so a 30-plugin profile is ~12ms — this runs on a request a user
 * made, not in a loop.
 */
export function findUnservedConfigNamespaces(
  profile: string,
  served: ReadonlySet<string>,
  ownIdsOf: (name: string) => string[],
  explicitDir?: string,
): UnservedConfigNamespace[] {
  const found: UnservedConfigNamespace[] = []
  for (const name of Object.keys(readInstalled(profile, explicitDir))) {
    const source = readClientBundle(profile, name, explicitDir)
    if (source === null) continue
    const unserved = configFormNamespaces(source).filter(namespace => !served.has(namespace))
    if (unserved.length === 0) continue
    found.push({ name, namespaces: unserved, ownEntryIds: ownIdsOf(name) })
  }
  return found
}

/**
 * Whether a package's client bundle still parses as JavaScript (#222).
 *
 * pnpm can leave a half-written or patch-mangled bundle behind — the report
 * describes a profile whose client bundle was broken after an update. The
 * browser is where that surfaces today, as a blank settings page long after
 * the operation reported success, with nothing connecting the two.
 *
 * `vm.Script` COMPILES without executing: it catches the syntax damage this
 * is looking for and never runs plugin code, so a hostile bundle gains
 * nothing. A missing `dsh.client`, an unresolvable exports field, or a file
 * that is simply absent all return ok — this check only ever fires on a file
 * it actually read and actually failed to parse. Everything ambiguous stays
 * silent, because a false "your plugin is corrupt" is the one outcome worse
 * than not checking.
 */
/**
 * V8's wording when a classic-script parse trips over module syntax.
 *
 * Matched on the message because there is no flag-free way to compile a
 * module here (`SourceTextModule` needs --experimental-vm-modules, which the
 * host process does not set). If V8 ever rewords these, the failure mode is
 * the false positive we had before rather than a missed real break — the
 * safer direction of the two.
 */
const MODULE_SYNTAX_ERROR = /Unexpected token 'export'|Cannot use import statement outside a module|await is only valid in async functions and the top level bodies of modules/

/**
 * Every installed plugin whose client bundle will not parse (#222 by
 * @MicroMilo).
 *
 * The per-package check above only ever looked at what an operation added,
 * which misses the failure that was actually reported: pnpm re-extracts the
 * WHOLE tree on any install, so updating one plugin can restore another
 * plugin's pristine — and broken — bundle, or fail to re-apply a patch that
 * was holding it together. The damage then surfaces at the next boot as
 * "failed to load plugins", with nothing connecting it to the install that
 * caused it.
 *
 * Cheap enough to run on every operation: 0.40ms per plugin including the
 * read (measured on a 385KB bundle), so a 30-plugin profile costs ~12ms
 * against an install that takes seconds.
 *
 * Silent on ESM bundles, like the per-package check it calls — see there for
 * why. Widening the sweep is exactly what would have turned that one false
 * "corrupt" into one per ESM plugin in the profile.
 *
 * Callers compare a before-list with an after-list rather than reporting
 * this one directly — a profile can carry a broken bundle indefinitely, and
 * re-reporting a problem the user already had would put them in front of
 * something this operation did not cause and cannot undo.
 */
export function brokenClientBundles(profile: string, explicitDir?: string): { name: string; reason: string }[] {
  const broken: { name: string; reason: string }[] = []
  for (const name of Object.keys(readInstalled(profile, explicitDir))) {
    const check = checkClientBundle(profile, name, explicitDir)
    if (!check.ok) broken.push({ name, reason: check.reason ?? 'parse failed' })
  }
  return broken
}

/** Bundles broken after an operation that were intact before it. */
export function newlyBrokenBundles(
  before: readonly { name: string; reason: string }[],
  after: readonly { name: string; reason: string }[],
): { name: string; reason: string }[] {
  const seen = new Set(before.map(entry => entry.name))
  return after.filter(entry => !seen.has(entry.name))
}

export function checkClientBundle(profile: string, name: string, explicitDir?: string): BundleCheck {
  // Declared but absent is verifyActivation's territory (a missing entry
  // artifact is already `broken` there); duplicating it here would report one
  // problem twice in two different vocabularies — so the reader's null covers
  // both "no client bundle" and "declared but unreadable" with the same ok.
  const source = readClientBundle(profile, name, explicitDir)
  if (source === null) return { ok: true, reason: null }
  try {
    new Script(source, { filename: `${name}/client` })
    return { ok: true, reason: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // `new Script` compiles a CLASSIC script, so perfectly valid module
    // syntax is a SyntaxError to it: `export`, `import`, and top-level
    // `await` all throw. This package ships CJS, which is why nobody noticed
    // — but a plugin whose client bundle is ESM was being told its file was
    // corrupt, and offered a rollback for a file that is fine.
    //
    // That is the exact outcome this check's own contract forbids: a false
    // "your plugin is corrupt" is worse than not checking. Module syntax
    // means "cannot judge with this parser", not "broken".
    if (MODULE_SYNTAX_ERROR.test(message)) return { ok: true, reason: null }
    return { ok: false, reason: message }
  }
}
