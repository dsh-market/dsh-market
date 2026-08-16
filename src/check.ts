/**
 * Profile composition diagnostics — issue #98 (phase 1): the check-only
 * "plugin loading layer and conflict view".
 *
 * Pure filesystem analysis of one dsh profile directory; no processes, no
 * network, no writes. It answers, for the profile the market is serving:
 *
 *  1. What is the actual bundle stack (dsh.profile.bundles order) and where
 *     does each layer come from (official in-box bundle vs community, the
 *     dependency spec, the resolved directory)?
 *  2. Which loader entry ids does the composed tree contain, and are any
 *     duplicated across layers (the "duplicate loader entry id" boot failure
 *     from #98)? Which rows does a later layer override?
 *  3. Does any installed plugin pull a DSH host core package
 *     (@deepseek-ai/dsh, @deepseek-ai/dsh-tools, @deepseek-ai/cordis, …) in
 *     as an ordinary dependency — the dsh-excel-chat failure mode where the
 *     plugin's copy gets hoisted to the profile root and shadows the host's
 *     version (tool calls die, minimal preset fails to mount)?
 *  4. Are there multiple versions of one core package in the lockfile, and
 *     do plugin peerDependencies ranges match the resolved core version?
 *
 * The composition step mirrors @deepseek-ai/dsh-app-boot's applyEntryPatches
 * (same js-yaml dialect incl. `!!js` scalars), so the rows reported here are
 * what actually mounts at boot.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { JSON_SCHEMA, Type, load } from 'js-yaml'
import { readBundleRules, suggestOrder, validateOrder } from './order.ts'

/** Profile bundles that ship with the dsh host and must stay put (#98). */
const INBOX_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
])

/** js-yaml dialect for `!!js` scalars — identical to dsh-app-boot's entryListSchema. */
const jsExpr = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown): boolean => typeof data === 'string',
  construct: (data: unknown): unknown => ({ __jsExpr: String(data) }),
})
const entrySchema = JSON_SCHEMA.extend(jsExpr)

/** Boot-breaking or confirmed problems vs informational warnings. */
export interface CheckSummary {
  ok: boolean
  errors: string[]
  warnings: string[]
}

/** One layer of the bundle stack, in `dsh.profile.bundles` order. */
export interface BundleLayer {
  name: string
  /** Dependency spec from the profile package.json (npm range, git, link:…). */
  source: string
  /** 'official' = in-box dsh bundle; 'community' = everything else. */
  kind: 'official' | 'community'
  /** Resolved package directory; null when the package is not installed. */
  directory: string | null
  /** Absolute path of the layer's patch file; null when undeclared/missing. */
  patchPath: string | null
  /** Why this layer cannot load at boot (missing dir / no dsh.bundle / …). */
  error: string | null
  /** Loader entry ids this bundle's patch inserts. */
  entries: string[]
  /** The patch file exists but could not be parsed as the entry-list dialect. */
  parseError: string | null
  /** Author-declared ordering constraints (issue #98 phase 2), when present. */
  order?: {
    before?: string[]
    after?: string[]
    /** Violated rules for THIS bundle in the current stack order. */
    conflicts?: Array<{ name: string; reason: string }>
  }
}

/** One loader row of the composed tree, with the layer that introduced it. */
export interface LoaderRow {
  id: string
  /** Bundle package name, 'user-patch' (profile cordis.patch.yml) or 'home-patch'. */
  layer: string
  kind: 'insert' | 'patch'
  name?: string
}

/** An id present in more than one composed row — the #98 duplicate-id boot failure. */
export interface DuplicateId {
  id: string
  /** Every layer that inserts/defines this id. */
  layers: string[]
  count: number
}

/** A non-insert patch row that merged into an existing entry (later layer wins). */
export interface OverrideRow {
  id: string
  layer: string
  /** Layers that introduced the targeted entry earlier in the stack. */
  overriddenLayers: string[]
}

/** A patch row that matched nothing at boot (dsh warns and skips it). */
export interface OrphanRow {
  id: string
  layer: string
  reason: string
}

/** An installed plugin pulling a DSH host core package as a dependency. */
export interface CoreDepIssue {
  plugin: string
  name: string
  /** Declared range/spec (dependencies or peerDependencies). */
  spec: string
  section: 'dependencies' | 'peerDependencies'
  /** Version physically hoisted to the profile root node_modules (shadowing copy). */
  hoisted: string | null
  /** Version physically nested under the plugin's own node_modules. */
  nested: string | null
  /** Version the host itself resolves (from the dsh installation). */
  host: string | null
  /** True when a non-host copy shadows a different host version. */
  shadowing: boolean
}

/** A plugin peerDependencies range vs the resolved version. */
export interface PeerMismatch {
  plugin: string
  name: string
  range: string
  resolved: string | null
  /** False = confirmed incompatible; null = could not be evaluated. */
  satisfied: boolean | null
}

/**
 * Distinct loader entries sharing one NAME — the Loader registers plugins by
 * name, so two rows with the same name shadow each other at runtime (the
 * later layer wins), unlike duplicate ids which fail the boot outright.
 */
export interface DuplicateName {
  name: string
  /** Every layer that inserts/defines a row with this name. */
  layers: string[]
  count: number
}

/** Distinct resolved versions of one core package found in the lockfile. */
export interface MultiVersion {
  name: string
  versions: string[]
  /** Version hoisted at the profile root, when present. */
  hoisted: string | null
}

/** The full check report for one profile. */
export interface CheckReport {
  profile: string
  scannedAt: number
  bundles: BundleLayer[]
  rows: LoaderRow[]
  duplicates: DuplicateId[]
  duplicateNames: DuplicateName[]
  overrides: OverrideRow[]
  orphans: OrphanRow[]
  coreDeps: CoreDepIssue[]
  peerMismatches: PeerMismatch[]
  multiVersion: MultiVersion[]
  /** Before/after rule conflicts in the CURRENT bundle order (issue #98 phase 2). */
  orderConflicts: Array<{ name: string; reason: string }>
  /** LOOT-style auto-fix: a community order satisfying every declared rule. */
  suggestedOrder: { ok: true; order: string[] } | { ok: false; cycle: string[] } | null
  summary: CheckSummary
}

export interface CheckOptions {
  /** DSH host installation dir; auto-detected from process.argv when omitted (tests inject it). */
  dshInstallDir?: string
  /** Harness home for the home-level patch layer; defaults to $DSH_HOME or ~/.dsh. */
  homeDir?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Parse one entry-list patch file with the dsh dialect; null when unreadable. */
export function parsePatchFile(path: string): unknown[] | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  try {
    const value = load(text, { schema: entrySchema })
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** Every id in one patch row's insert list, recursively (group configs included). */
function collectInsertIds(rows: unknown[]): string[] {
  const ids: string[] = []
  const walk = (value: unknown): void => {
    if (!Array.isArray(value)) return
    for (const entry of value) {
      if (!isRecord(entry) || typeof entry.id !== 'string') continue
      ids.push(entry.id)
      if (Array.isArray(entry.config)) walk(entry.config)
    }
  }
  for (const patch of rows) {
    if (!isRecord(patch) || !Array.isArray(patch.insert)) continue
    walk(patch.insert)
  }
  return ids
}

/** DSH host core packages: what the dsh installation ships under @deepseek-ai. */
export function corePackageNames(dshInstallDir: string | null): Set<string> {
  const names = new Set<string>([
    // Curated fallback seed (used when the install dir cannot be located).
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-headless',
    '@deepseek-ai/dsh-app-boot',
    '@deepseek-ai/dsh-home-paths',
    '@deepseek-ai/dsh-launch-environment',
    '@deepseek-ai/dsh-cmdline',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-attachment',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-agent-loop',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-subagent',
    '@deepseek-ai/cordis',
    '@deepseek-ai/cordis-plugin-loader',
    '@deepseek-ai/cordis-plugin-include',
    '@deepseek-ai/cordis-plugin-hmr',
    '@deepseek-ai/cordis-plugin-timer',
    '@deepseek-ai/cordis-plugin-group',
  ])
  if (dshInstallDir === null) return names
  try {
    // The install's own node_modules is the authoritative host-core inventory:
    // everything under @deepseek-ai whose bare name starts with dsh or cordis,
    // plus the app package itself.
    for (const entry of readdirSync(join(dshInstallDir, 'node_modules', '@deepseek-ai'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (/^(?:dsh|cordis)/.test(entry.name)) names.add(`@deepseek-ai/${entry.name}`)
    }
  } catch { /* install node_modules unreadable — the curated seed stands */ }
  try {
    const manifest = JSON.parse(readFileSync(join(dshInstallDir, 'package.json'), 'utf8')) as { name?: unknown }
    if (typeof manifest.name === 'string') names.add(manifest.name)
  } catch { /* not a package dir */ }
  return names
}

/**
 * Locate the dsh host installation from the process entry (the same source
 * dsh-cli.ts uses to re-invoke the CLI): walk up from dirname(argv[1]) until
 * a package.json named @deepseek-ai/dsh is found.
 */
export function findDshInstallDir(entry = process.argv[1]): string | null {
  if (entry === undefined) return null
  let dir = resolve(dirname(entry))
  for (let depth = 0; depth < 10; depth += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
      if (manifest.name === '@deepseek-ai/dsh') return dir
    } catch { /* keep walking up */ }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** Version of `name` as physically resolved at `base`/node_modules, or null. */
function readNodeModulesVersion(base: string, name: string): string | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(base, 'node_modules', name, 'package.json'), 'utf8'),
    ) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

/**
 * Resolve one bundle package's directory the way the dsh boot does
 * (dsh-app-boot's resolveBundleDir): probe Node's own node_modules search
 * paths from the installation anchor first, then the profile directory.
 * Node resolution walks upward, so this also finds pnpm's workspace-root
 * hoisting (`<profiles>/node_modules/…` when the profile lives under
 * `<profiles>/<name>`) and matches exactly what the Loader would import.
 */
function resolveBundleDir(anchorPackageJson: string, name: string): string | null {
  let paths: string[] = []
  try {
    paths = createRequire(anchorPackageJson).resolve.paths(name) ?? []
  } catch {
    return null
  }
  for (const searchPath of paths) {
    const candidate = join(searchPath, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return null
}

/**
 * Version of `name` visible to the profile's dependency tree: the profile's
 * own node_modules first, then the workspace root (pnpm hoists shared deps
 * there when the profile is a workspace member — the dsh layout keeps
 * `<profiles>/node_modules` as the shared store for all profiles).
 */
function readProfileVisibleVersion(profileDirectory: string, name: string): string | null {
  const direct = readNodeModulesVersion(profileDirectory, name)
  if (direct !== null) return direct
  const workspaceRoot = dirname(profileDirectory)
  if (workspaceRoot === profileDirectory) return null
  return readNodeModulesVersion(workspaceRoot, name)
}

/** Top-level installed package names (incl. scoped), excluding pnpm internals. */
function installedPackageNames(profileDir: string): string[] {
  const names: string[] = []
  let root: string[]
  try {
    root = readdirSync(join(profileDir, 'node_modules'), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== '.bin' && entry.name !== '.pnpm' && entry.name !== '.dsh-plugin-backups')
      .map(entry => entry.name)
  } catch {
    return names
  }
  for (const name of root) {
    if (!name.startsWith('@')) {
      names.push(name)
      continue
    }
    try {
      for (const scoped of readdirSync(join(profileDir, 'node_modules', name), { withFileTypes: true })) {
        if (scoped.isDirectory()) names.push(`${name}/${scoped.name}`)
      }
    } catch { /* empty scope dir */ }
  }
  return names
}

// --- semver helpers (small subset sufficient for peer range checks) ---

interface Semver {
  major: number
  minor: number
  patch: number
  pre: string[]
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseSemver(value: string): Semver | null {
  const m = SEMVER_RE.exec(value.trim())
  if (m === null) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] === undefined ? [] : m[4].split('.'),
  }
}

function comparePre(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return y === undefined ? 0 : -1 // a has fewer parts → a < b
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) - Number(y) || 0
    if (xn) return -1 // numeric identifiers sort before alphanumeric
    if (yn) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** Compare two semver strings: negative | zero | positive (prerelease < release of same base). */
export function compareSemver(a: string, b: string): number {
  const av = parseSemver(a)
  const bv = parseSemver(b)
  if (av === null || bv === null) return a < b ? -1 : a > b ? 1 : 0
  if (av.major !== bv.major) return av.major - bv.major || 0
  if (av.minor !== bv.minor) return av.minor - bv.minor || 0
  if (av.patch !== bv.patch) return av.patch - bv.patch || 0
  if (av.pre.length === 0 && bv.pre.length === 0) return 0
  if (av.pre.length === 0) return 1 // release > prerelease
  if (bv.pre.length === 0) return -1
  return comparePre(av.pre, bv.pre)
}

function gte(a: Semver, b: Semver): boolean {
  const cmp = compareSemver(`${a.major}.${a.minor}.${a.patch}${a.pre.length > 0 ? `-${a.pre.join('.')}` : ''}`, `${b.major}.${b.minor}.${b.patch}${b.pre.length > 0 ? `-${b.pre.join('.')}` : ''}`)
  return cmp >= 0
}

/** String form of a parsed Semver (the boundary objects carry no prerelease). */
function semverStr(v: Semver): string {
  return `${v.major}.${v.minor}.${v.patch}${v.pre.length > 0 ? `-${v.pre.join('.')}` : ''}`
}

/**
 * Minimal range matcher for the peer-range check: `*`, exact, ^, ~, >=, >,
 * <=, <, whitespace-separated pairs, and `||` alternatives. Anything else
 * returns null (unknown — reported, not asserted).
 */
export function satisfiesRange(version: string, range: string): boolean | null {
  const v = parseSemver(version)
  if (v === null) return null
  const single = (part: string): boolean | null => {
    const p = part.trim()
    if (p === '' || p === '*' || p === 'x' || p === 'X') return true
    const m = /^(\^|~|>=|<=|>|<)?(.*)$/.exec(p)
    const op = m?.[1] ?? ''
    const target = (m?.[2] ?? '').trim()
    const tv = parseSemver(target)
    if (tv === null) return null
    const major = tv.major
    const minor = tv.minor
    const patch = tv.patch
    switch (op) {
      case '':
        return compareSemver(version, target) === 0
      case '>=':
        return gte(v, tv)
      case '<=':
        return gte(tv, v)
      case '>':
        return compareSemver(version, target) > 0
      case '<':
        return compareSemver(version, target) < 0
      case '^': {
        // npm caret semantics: >= given, strictly < the next breaking bump.
        const upper: Semver = major > 0
          ? { major: major + 1, minor: 0, patch: 0, pre: [] }
          : minor > 0
            ? { major: 0, minor: minor + 1, patch: 0, pre: [] }
            : { major: 0, minor: 0, patch: patch + 1, pre: [] }
        return gte(v, tv) && compareSemver(semverStr(upper), version) > 0
      }
      case '~': {
        // npm tilde semantics: >= given, strictly < the next minor.
        const upper: Semver = { major, minor: minor + 1, patch: 0, pre: [] }
        return gte(v, tv) && compareSemver(semverStr(upper), version) > 0
      }
      default:
        return null
    }
  }
  if (range.includes('||')) {
    const outcomes = range.split('||').map(part => single(part))
    if (outcomes.some(out => out === true)) return true
    return outcomes.every(out => out === null) ? null : false
  }
  // Whitespace-separated compound ranges (`>=1 <2`) — all parts must hold.
  const parts = range.trim().split(/\s+/).filter(part => part !== '')
  if (parts.length === 0) return true
  if (parts.length === 1) return single(parts[0] ?? '')
  const results = parts.map(part => single(part ?? ''))
  if (results.some(r => r === null)) return null
  return results.every(r => r === true)
}

// --- composition (mirrors dsh-app-boot applyEntryPatches) ---

interface EntryNode {
  id: string
  name?: string
  layer: string
  group?: boolean
  config?: unknown
}

function findEntry(nodes: EntryNode[], id: string): EntryNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node
    if (node.group === true && Array.isArray(node.config)) {
      const nested = findEntry(node.config as EntryNode[], id)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Flatten a tree of entries (group configs included) into row records. */
function flattenEntries(nodes: EntryNode[]): LoaderRow[] {
  const rows: LoaderRow[] = []
  const walk = (list: EntryNode[]): void => {
    for (const node of list) {
      rows.push({ id: node.id, layer: node.layer, kind: 'insert', name: node.name })
      if (node.group === true && Array.isArray(node.config)) walk(node.config as EntryNode[])
    }
  }
  walk(nodes)
  return rows
}

export interface LayerInput {
  label: string
  kind: 'bundle' | 'user' | 'home'
  patches: unknown[]
  parseError: string | null
}

interface Composed {
  rows: LoaderRow[]
  duplicates: DuplicateId[]
  overrides: OverrideRow[]
  orphans: OrphanRow[]
}

/**
 * Apply the layer stack over an empty root exactly like the dsh boot include.
 * Exported so the trial-start validation (src/trial.ts) can replay the
 * composition with a candidate bundle order BEFORE anything is written.
 */
export function composeLayers(layers: LayerInput[]): Composed {
  const tree: EntryNode[] = []
  const orphans: OrphanRow[] = []
  const overrides: OverrideRow[] = []
  for (const layer of layers) {
    for (const patch of layer.patches) {
      if (!isRecord(patch)) continue
      const { id, insert, name, ...overridesOf } = patch
      if (insert !== undefined) {
        if (!Array.isArray(insert)) {
          orphans.push({ id: String(id ?? '(anonymous)'), layer: layer.label, reason: 'insert is not an array' })
          continue
        }
        const nodes = (insert as unknown[]).filter(isRecord).map((entry): EntryNode | null => {
          if (typeof entry.id !== 'string') return null
          return {
            id: entry.id,
            name: typeof entry.name === 'string' ? entry.name : undefined,
            layer: layer.label,
            group: entry.group === true,
            config: Array.isArray(entry.config) ? entry.config : undefined,
          }
        }).filter((n): n is EntryNode => n !== null)
        if (typeof id === 'string') {
          const target = findEntry(tree, id)
          if (target === undefined) {
            orphans.push({ id, layer: layer.label, reason: 'insert target not found' })
            continue
          }
          if (target.group !== true || !Array.isArray(target.config)) {
            orphans.push({ id, layer: layer.label, reason: 'insert target is not a group' })
            continue
          }
          target.config = [...(target.config as unknown[]), ...nodes]
          continue
        }
        tree.push(...nodes)
        continue
      }
      if (typeof id !== 'string') {
        orphans.push({ id: '(anonymous)', layer: layer.label, reason: 'id required for non-insert patch' })
        continue
      }
      const target = findEntry(tree, id)
      if (target === undefined) {
        orphans.push({ id, layer: layer.label, reason: 'patch target not found' })
        continue
      }
      if (name !== undefined && name !== target.name) {
        orphans.push({ id, layer: layer.label, reason: `name mismatch (expected ${String(target.name)}, got ${String(name)})` })
        continue
      }
      const priorLayers: string[] = []
      for (const node of flattenEntries(tree)) {
        if (node.id === id && !priorLayers.includes(node.layer)) priorLayers.push(node.layer)
      }
      if (priorLayers.some(prior => prior !== layer.label)) {
        overrides.push({ id, layer: layer.label, overriddenLayers: priorLayers.filter(prior => prior !== layer.label) })
      }
      for (const [key, value] of Object.entries(overridesOf)) {
        if (key === 'id') continue
        ;(target as unknown as Record<string, unknown>)[key] = value
      }
    }
  }
  const rows = flattenEntries(tree)
  const byId = new Map<string, string[]>()
  for (const row of rows) {
    const layers = byId.get(row.id) ?? []
    if (!layers.includes(row.layer)) layers.push(row.layer)
    byId.set(row.id, layers)
  }
  const duplicates: DuplicateId[] = []
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
  for (const [id, count] of counts) {
    if (count < 2) continue
    duplicates.push({ id, layers: byId.get(id) ?? [], count })
  }
  duplicates.sort((a, b) => a.id.localeCompare(b.id))
  return { rows, duplicates, overrides, orphans }
}

/** Distinct versions of `@deepseek-ai/{dsh,cordis}*` packages in the lockfile. */
function lockfileCoreVersions(profileDir: string): Map<string, string[]> {
  const found = new Map<string, Set<string>>()
  let text: string
  try {
    text = readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')
  } catch {
    return new Map()
  }
  for (const m of text.matchAll(/(@deepseek-ai\/(?:dsh|cordis)[^@\s'"]*?)@([^\s:'"]+)/g)) {
    const name = m[1] ?? ''
    const version = m[2] ?? ''
    // Registry resolutions only: skip link: and git forms.
    if (!/^\d/.test(version)) continue
    const versions = found.get(name) ?? new Set<string>()
    versions.add(version)
    found.set(name, versions)
  }
  const out = new Map<string, string[]>()
  for (const [name, versions] of found) out.set(name, [...versions].sort(compareSemver))
  return out
}

/**
 * Build the bundle layer stack for a profile under a GIVEN bundle order —
 * the manifest order for analyzeProfile, or a candidate order for trial
 * validation (src/trial.ts). Bundle resolution mirrors the boot exactly:
 * the dsh installation anchor first (in-box bundles always come from the
 * running dsh, never a profile-local copy), then Node's module search from
 * the profile directory (covers community bundles and pnpm workspace-root
 * hoisting). A single code path keeps the check report and the trial
 * validation from ever disagreeing about what a bundle is or where it lives.
 */
export function buildBundleLayers(
  profileDirectory: string,
  bundleNames: string[],
  specs: Record<string, string>,
  dshInstallDir: string | null,
): { bundles: BundleLayer[]; layers: LayerInput[] } {
  const bundles: BundleLayer[] = bundleNames.map((name) => {
    const anchors = [
      dshInstallDir !== null ? join(dshInstallDir, 'package.json') : null,
      join(profileDirectory, 'package.json'),
    ]
    let directory: string | null = null
    for (const anchor of anchors) {
      if (anchor === null) continue
      directory = resolveBundleDir(anchor, name)
      if (directory !== null) break
    }
    const layer: BundleLayer = {
      name,
      source: specs[name] ?? '(not a direct dependency)',
      kind: INBOX_BUNDLES.has(name) ? 'official' : 'community',
      directory,
      patchPath: null,
      error: null,
      entries: [],
      parseError: null,
    }
    if (directory === null) {
      layer.error = 'bundle package is not installed — the profile will fail to boot'
      return layer
    }
    let bundleManifest: { dsh?: { bundle?: { patch?: unknown; order?: unknown } } }
    try {
      bundleManifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as typeof bundleManifest
    } catch {
      layer.error = 'bundle package.json is unreadable'
      return layer
    }
    const declared = bundleManifest.dsh?.bundle?.patch
    if (typeof declared !== 'string') {
      layer.error = 'bundle declares no dsh.bundle.patch — the profile will fail to boot'
      return layer
    }
    const patchPath = join(directory, declared)
    if (!existsSync(patchPath)) {
      layer.error = `declared patch ${declared} is missing — the profile will fail to boot`
      return layer
    }
    layer.patchPath = patchPath
    const patches = parsePatchFile(patchPath)
    if (patches === null) {
      layer.parseError = 'patch file is not a valid entry list'
      return layer
    }
    layer.entries = collectInsertIds(patches)
    const order = bundleManifest.dsh?.bundle?.order
    if (order !== null && typeof order === 'object' && !Array.isArray(order)) {
      const listOf = (value: unknown): string[] | undefined => Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : undefined
      const after = listOf((order as Record<string, unknown>).after)
      const before = listOf((order as Record<string, unknown>).before)
      if (after !== undefined || before !== undefined) {
        layer.order = { ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) }
      }
    }
    return layer
  })
  const layers: LayerInput[] = bundles.map((bundle) => ({
    label: bundle.name,
    kind: 'bundle' as const,
    patches: bundle.patchPath !== null && bundle.parseError === null ? parsePatchFile(bundle.patchPath) ?? [] : [],
    parseError: bundle.parseError,
  }))
  return { bundles, layers }
}

/**
 * Analyze one profile directory (issue #98, phase 1). Pure function of the
 * directory contents — safe to call on every market open.
 */
export function analyzeProfile(profileDirectory: string, options: CheckOptions = {}): CheckReport {
  const dshInstall = options.dshInstallDir ?? findDshInstallDir()
  const home = options.homeDir ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const core = corePackageNames(dshInstall)

  // --- 1. bundle stack ---
  const manifest = (() => {
    try {
      return JSON.parse(readFileSync(join(profileDirectory, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
        dsh?: { profile?: { bundles?: unknown } }
      }
    } catch {
      return null
    }
  })()
  const bundleNames = Array.isArray(manifest?.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter((name): name is string => typeof name === 'string')
    : []
  const specs = manifest?.dependencies ?? {}
  const built = buildBundleLayers(profileDirectory, bundleNames, specs, dshInstall)
  const bundles = built.bundles
  const bundleLayers = built.layers

  // --- 2. composed loader rows / duplicates / overrides / orphans ---
  const layers: LayerInput[] = [...bundleLayers]
  const userPatchPath = join(profileDirectory, 'cordis.patch.yml')
  if (existsSync(userPatchPath)) {
    const patches = parsePatchFile(userPatchPath)
    layers.push({ label: 'user-patch', kind: 'user', patches: patches ?? [], parseError: patches === null ? 'patch file is not a valid entry list' : null })
  }
  const homePatchPath = join(home, 'cordis.patch.yml')
  if (existsSync(homePatchPath)) {
    const patches = parsePatchFile(homePatchPath)
    layers.push({ label: 'home-patch', kind: 'home', patches: patches ?? [], parseError: patches === null ? 'patch file is not a valid entry list' : null })
  }
  const composed = composeLayers(layers)

  // --- 3. core packages pulled in as ordinary dependencies ---
  const coreDeps: CoreDepIssue[] = []
  const peerMismatches: PeerMismatch[] = []
  const seenDeps = new Set<string>()
  for (const plugin of installedPackageNames(profileDirectory)) {
    let pkg: { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
    try {
      pkg = JSON.parse(readFileSync(join(profileDirectory, 'node_modules', plugin, 'package.json'), 'utf8')) as typeof pkg
    } catch {
      continue
    }
    const pluginDir = join(profileDirectory, 'node_modules', plugin)
    for (const section of ['dependencies', 'peerDependencies'] as const) {
      const map = pkg[section]
      if (map === null || typeof map !== 'object') continue
      for (const [name, spec] of Object.entries(map)) {
        if (typeof spec !== 'string') continue
        const key = `${plugin}\u0000${name}\u0000${section}`
        if (seenDeps.has(key)) continue
        seenDeps.add(key)
        const hoisted = readProfileVisibleVersion(profileDirectory, name)
        const nested = readNodeModulesVersion(pluginDir, name)
        const host = dshInstall !== null ? readNodeModulesVersion(dshInstall, name) : null
        const resolved = hoisted ?? nested ?? host
        const isCore = core.has(name)
        if (section === 'dependencies' && isCore) {
          const shadowing = (hoisted ?? nested) !== null && host !== null && (hoisted ?? nested) !== host
          coreDeps.push({
            plugin, name, spec, section,
            hoisted, nested, host, shadowing,
          })
        } else if (section === 'peerDependencies') {
          // Peer checks cover EVERY declared peer, not just host core
          // packages: plugin-to-plugin peer mismatches break runtime
          // registration just as hard (issue #98 optimization round).
          const satisfied = resolved !== null ? satisfiesRange(resolved, spec) : null
          peerMismatches.push({
            plugin, name, range: spec, resolved,
            satisfied: satisfied === null ? null : satisfied,
          })
        }
      }
    }
  }

  // --- 4. multi-version core packages from the lockfile ---
  const multiVersion: MultiVersion[] = []
  for (const [name, versions] of lockfileCoreVersions(profileDirectory)) {
    if (versions.length < 2) continue
    multiVersion.push({ name, versions, hoisted: readProfileVisibleVersion(profileDirectory, name) })
  }
  multiVersion.sort((a, b) => a.name.localeCompare(b.name))

  // --- summary ---
  const errors: string[] = []
  const warnings: string[] = []
  for (const bundle of bundles) {
    if (bundle.error !== null) errors.push(`bundle ${bundle.name}: ${bundle.error}`)
    if (bundle.parseError !== null) errors.push(`bundle ${bundle.name}: ${bundle.parseError}`)
  }
  for (const layer of layers) {
    if (layer.parseError !== null && layer.kind !== 'bundle') errors.push(`${layer.label}: ${layer.parseError}`)
  }
  for (const dup of composed.duplicates) {
    errors.push(`duplicate loader entry id ${JSON.stringify(dup.id)} (${dup.count} rows: ${dup.layers.join(', ')})`)
  }
  for (const orphan of composed.orphans) {
    warnings.push(`${orphan.layer}: ${orphan.id} — ${orphan.reason}`)
  }
  for (const dep of coreDeps) {
    const copies = dep.hoisted ?? dep.nested
    if (dep.shadowing && copies !== null && dep.host !== null) {
      errors.push(`${dep.plugin} pulls core package ${dep.name}@${copies} as a dependency, shadowing the host's ${dep.host}`)
    } else {
      warnings.push(`${dep.plugin} declares core package ${dep.name} in dependencies (${dep.spec}) — prefer peerDependencies`)
    }
  }
  for (const mismatch of peerMismatches) {
    // Only CONFIRMED incompatibilities warn. Un-evaluable peers (sat=null —
    // the peer is supplied by the host, an optional accelerator, or simply
    // absent) stay in the peerMismatches list for the UI but are not noise
    // in the summary (issue #98 optimization round).
    if (mismatch.satisfied === false) {
      warnings.push(`${mismatch.plugin} peer range ${mismatch.name}@${mismatch.range} does not match resolved ${String(mismatch.resolved)}`)
    }
  }
  for (const mv of multiVersion) {
    const line = `${mv.name}: ${mv.versions.join(' / ')}${mv.hoisted !== null ? ` (hoisted ${mv.hoisted})` : ''}`
    if (core.has(mv.name)) errors.push(`multiple versions of core package — ${line}`)
    else warnings.push(`multiple versions of ${line}`)
  }
  // Current-order before/after rule conflicts (issue #98 phase 2): these are
  // informative for the ordering UI; the author-declared rule breaking the
  // CURRENT stack is worth a warning but not a boot failure. Conflicts are
  // exposed both at the report top level and per bundle (order.conflicts) so
  // the ordering panel can render them next to the bundle rows.
  const orderConflicts = validateOrder(bundleNames, readBundleRules(profileDirectory))
  for (const conflict of orderConflicts) {
    warnings.push(`${conflict.name}: ${conflict.reason}`)
  }
  for (const bundle of bundles) {
    const own = orderConflicts.filter(conflict => conflict.name === bundle.name)
    if (own.length > 0) bundle.order = { ...bundle.order, conflicts: own }
  }
  // LOOT-style auto-fix: when rules are violated, suggest a compliant order.
  const suggestedOrder = suggestOrder(bundleNames, readBundleRules(profileDirectory))
  if (suggestedOrder.ok && suggestedOrder.order.join('\u0000') !== bundleNames.filter(name => !INBOX_BUNDLES.has(name)).join('\u0000')) {
    warnings.push('current bundle order violates declared before/after rules — a compliant order is suggested / 当前 bundle 顺序违反声明的 before/after 规则，已给出建议顺序')
  } else if (!suggestedOrder.ok) {
    warnings.push(`before/after rules contain a cycle: ${suggestedOrder.cycle.join(' -> ')} — no compliant order exists / before/after 规则存在循环依赖，无法得出合规顺序`)
  }

  // Duplicate loader NAMES: the Loader registers plugins by name, so two rows
  // with the same name shadow each other at runtime (later layer wins).
  const nameCounts = new Map<string, string[]>()
  for (const row of composed.rows) {
    if (row.name === undefined) continue
    const layers = nameCounts.get(row.name) ?? []
    if (!layers.includes(row.layer)) layers.push(row.layer)
    nameCounts.set(row.name, layers)
  }
  const duplicateNames: DuplicateName[] = []
  for (const [name, layers] of nameCounts) {
    const count = composed.rows.filter(row => row.name === name).length
    if (count < 2) continue
    duplicateNames.push({ name, layers, count })
    warnings.push(`duplicate loader entry name ${JSON.stringify(name)} (${count} rows: ${layers.join(', ')}) — the later layer shadows the earlier one / 重复的 loader 条目名称，后加载者会覆盖先加载者`)
  }
  duplicateNames.sort((a, b) => a.name.localeCompare(b.name))

  return {
    profile: profileDirectory,
    scannedAt: Date.now(),
    bundles,
    rows: composed.rows,
    duplicates: composed.duplicates,
    duplicateNames,
    overrides: composed.overrides,
    orphans: composed.orphans,
    coreDeps,
    peerMismatches,
    multiVersion,
    orderConflicts,
    suggestedOrder,
    summary: {
      ok: errors.length === 0,
      errors,
      warnings,
    },
  }
}
