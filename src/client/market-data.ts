/**
 * Response shapes of the /dsh-market/* host routes plus the pure helpers the
 * Market UI shares between its section and toast components.
 */

import type { DiagnosticReportV1 } from '../diagnostics.ts'
export type { SharedHostPackageDependencyFinding } from '../diagnostics.ts'

/** Localized text keyed by language ('zh' / 'en'). */
export type LocalizedText = Record<string, string | undefined>

/** One registry entry from /dsh-market/registry. */
export interface RegistryPlugin {
  name: string
  owner: string
  url: string
  npm?: string
  category: string
  description?: LocalizedText
  stars?: number
  added?: string
  install?: string
  /**
   * Catalog-side deprecation flags (#60): absent for every normal entry, so
   * catalogs without the fields render exactly as before.
   */
  deprecated?: boolean
  /** Catalog name of the suggested replacement plugin, when deprecated. */
  replacement?: string
  /** Author-curated screenshot URLs from the registry (#61); optional. */
  screenshots?: string[]
}

/** The catalog payload under `registry` in /dsh-market/registry. */
export interface Registry {
  count: number
  categories: Record<string, LocalizedText>
  plugins: RegistryPlugin[]
}

/** Profile dependency map: package name → install spec. */
export type InstalledMap = Record<string, string>

/** Response of the /dsh-market/gist export action. */
export interface GistExportResult {
  ok: boolean
  gistId: string
  gistUrl: string
}

/** Per-package update status from /dsh-market/updates. */
export interface UpdateStatus {
  updateAvailable?: boolean
  version?: string
  kind?: string
}

/** Poll payload from /dsh-market/status. */
export interface MarketStatus {
  active?: boolean
  lastLine?: string
  seconds?: number
  installed?: InstalledMap
  pnpm?: boolean
  boot?: string
  /** pnpm ndjson stage, when the structured reporter produced events. */
  phase?: 'resolving' | 'downloading' | 'linking' | 'building' | null
  done?: number
  total?: number | null
  currentPackage?: string | null
  downloaded?: number | null
  size?: number | null
  /** True once the user asked to cancel and the host is killing the run. */
  cancelling?: boolean
  /**
   * The route-level operation lock (#91): stays true through install
   * post-processing after pnpm already exited (progress.active false).
   * Restart must not be offered while it is held.
   */
  busy?: boolean
}

/** Post-install activation state (P0-2), per installed package. */
export type ActivationState = 'live' | 'restart' | 'inert' | 'broken' | 'missing' | 'disabled'

export interface ActivationInfo {
  state: ActivationState
  reasons: string[]
  bundle: boolean
  hot: boolean
}

/** The /dsh-market/installed payload (fields the market UI consumes). */
export interface InstalledPayload {
  profile?: string
  installed: InstalledMap
  activation?: Record<string, ActivationInfo>
  diagnostics?: DiagnosticReportV1
  live?: string[]
  /** Plugins the user switched off; persisted across restarts (#60). */
  disabled?: string[]
  /**
   * Packages whose bundle rows the user patch layer (cordis.patch.yml)
   * disables / force-enables (port of dsh-plugin-hub). Covers toggles made
   * OUTSIDE the market — hand-edited patch files, the dsh CLI — which the
   * market's own disable list never sees.
   */
  patchDisabled?: string[]
  patchForced?: string[]
  /** Custom plugin groups: group name → member package names. */
  groups?: Record<string, string[]>
  /** Display order of group names. */
  groupOrder?: string[]
}

/**
 * A group's derived switch state: all members enabled / all disabled /
 * mixed / no members. Pure — the UI renders exactly this and the group
 * switch itself is never persisted (#60).
 */
export type GroupSwitchState = 'on' | 'off' | 'mixed' | 'empty'

export function groupSwitchState(members: string[] | undefined, disabled: ReadonlySet<string>): GroupSwitchState {
  const list = members ?? []
  if (list.length === 0) return 'empty'
  let anyOn = false
  let anyOff = false
  for (const member of list) {
    if (disabled.has(member)) anyOff = true
    else anyOn = true
  }
  return anyOn && anyOff ? 'mixed' : anyOff ? 'off' : 'on'
}

/** Registered theme definition surfaced by the theme service snapshot. */
export interface ThemeDef {
  id: string
  colorScheme?: string
  tokens?: Record<string, string | undefined>
}

/** Theme service snapshot; null when the composition has no theme service. */
export interface ThemeSnapshot {
  preference: string
  themes: ThemeDef[]
}

/** Bound locale translator for the dsh-market namespace. */
export type Translate = (key: string) => string

export function avatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return 'hsl(' + (((hash % 360) + 360) % 360) + ' 55% 52%)'
}

export function readSession(key: string): any {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null') } catch { return null }
}

/** Heuristic: plugins that target a terminal surface rather than the web UI. */
export function looksTerminal(plugin: RegistryPlugin, lang: string): boolean {
  const desc = (plugin.description && (plugin.description[lang] || plugin.description.en)) || ''
  return /\b(tui|cli|tty|terminal)\b|终端|命令行/i.test(plugin.name + ' ' + desc)
}

/** Sortable field for the Discover list. */
export type SortField = 'stars' | 'added'
/** Sort direction: desc = newest/most first, asc = oldest/least first. */
export type SortDir = 'desc' | 'asc'
/** Combined sort key sent to visiblePlugins. */
export type SortKey = `${SortField}-${SortDir}`

/** Recency windows for the "published within" filter. */
export type TimeRange = 'all' | 'day' | 'week' | 'month' | 'quarter' | 'year'

/** Days per TimeRange (`all` has no cutoff and is handled by the caller). */
export const TIME_RANGE_DAYS: Record<Exclude<TimeRange, 'all'>, number> = {
  day: 1,
  week: 7,
  month: 30,
  quarter: 90,
  year: 365,
}

/** True when `added` is a date within the last `days` days (inclusive). */
export function withinDays(added: string | undefined, days: number): boolean {
  if (added === undefined || added === '') return false
  const time = Date.parse(added)
  if (Number.isNaN(time)) return false
  const age = Date.now() - time
  return age >= 0 && age <= days * 86_400_000
}

/** Filters and sort order driving the discover list. */
export interface ListQuery {
  /** Active category id, or 'all'. */
  category: string
  /** Raw search input (trimmed and lowercased internally). */
  query: string
  /** UI language for description matching ('zh' / 'en'). */
  lang: string
  /** 'stars-desc' | 'stars-asc' | 'added-desc' | 'added-asc'; anything else keeps registry order. */
  sort: string
  /** Keep only plugins published within the last N days; undefined = any time. */
  sinceDays?: number
}

/**
 * The discover list: category filter, then the published-within window, then
 * search across name / owner / localized description, then the selected sort.
 * Pure — the section renders exactly this.
 */
export function visiblePlugins(plugins: RegistryPlugin[], options: ListQuery): RegistryPlugin[] {
  const query = options.query.trim().toLowerCase()
  const list = plugins.filter((p) => {
    if (options.category !== 'all' && p.category !== options.category) return false
    if (options.sinceDays !== undefined && !withinDays(p.added, options.sinceDays)) return false
    if (query === '') return true
    const desc = (p.description && (p.description[options.lang] || p.description.en)) || ''
    return p.name.toLowerCase().includes(query)
      || p.owner.toLowerCase().includes(query)
      || desc.toLowerCase().includes(query)
  })
  if (options.sort === 'stars-desc') {
    return [...list].sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1))
  }
  if (options.sort === 'stars-asc') {
    return [...list].sort((a, b) => (a.stars ?? -1) - (b.stars ?? -1))
  }
  if (options.sort === 'added-desc') {
    return [...list].sort((a, b) => String(b.added).localeCompare(String(a.added)))
  }
  if (options.sort === 'added-asc') {
    return [...list].sort((a, b) => String(a.added).localeCompare(String(b.added)))
  }
  return list
}

/** The themes tab listing: theme category only, most-starred first. */
export function themePlugins(plugins: RegistryPlugin[]): RegistryPlugin[] {
  return plugins.filter(p => p.category === 'theme').sort((a, b) => (b.stars || 0) - (a.stars || 0))
}

/**
 * Category chip order: collapsed with an active non-'all' chip, the active
 * one moves to the front so it stays visible inside the two-row clip.
 */
export function orderedCategories(categories: string[], active: string, open: boolean): string[] {
  return open || active === 'all' ? categories : [active, ...categories.filter(id => id !== active)]
}

/**
 * Page-number list for the discover pager. With few pages it is simply
 * 1..total; with many it windows around the current page and inserts '…'
 * so a 400-plugin catalog stays a compact `1 … 4 5 6 … 17` instead of a
 * long row of numbered buttons. Always begins with 1 and ends with total.
 */
export function pageItems(current: number, total: number): Array<number | '…'> {
  if (total <= 7) {
    const all: number[] = []
    for (let i = 1; i <= total; i++) all.push(i)
    return all
  }
  const items: Array<number | '…'> = [1]
  let start = Math.max(2, current - 1)
  let end = Math.min(total - 1, current + 1)
  if (current <= 4) end = 5
  if (current >= total - 3) start = total - 4
  if (start > 2) items.push('…')
  for (let i = start; i <= end; i++) items.push(i)
  if (end < total - 1) items.push('…')
  items.push(total)
  return items
}

/**
 * Unified installed-state matching (#15): both sides collapse to lowercase
 * identity sets — the registry entry contributes its bare name, npm name and
 * owner/repo; the dependency contributes its key and the repo inside its
 * spec — and any exact intersection counts. Exact equality, not substrings,
 * so prefix-related repo names cannot cross-match.
 */
function entryIdentities(plugin: RegistryPlugin): Set<string> {
  const ids = new Set<string>([plugin.name.toLowerCase()])
  if (plugin.npm) ids.add(plugin.npm.toLowerCase())
  // Subpath-aware: a /tree/ entry identifies as repo#path:/sub, never the
  // bare repo — two subpackages of one monorepo must not cross-match.
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/tree\/[^/]+\/(.+?))?\/?$/.exec(plugin.url)
  if (m !== null) {
    ids.add(m[2] !== undefined ? `${m[1]!.toLowerCase()}#path:/${m[2].toLowerCase()}` : m[1]!.toLowerCase())
  }
  return ids
}

function depIdentities(name: string, spec: string): Set<string> {
  const ids = new Set<string>([name.toLowerCase()])
  // A scoped npm key usually mirrors owner/repo — expose that identity so an
  // npm-installed plugin still matches an entry whose npm field is unset.
  const scoped = /^@([^/]+)\/(.+)$/.exec(name)
  if (scoped !== null) ids.add(`${scoped[1]!.toLowerCase()}/${scoped[2]!.toLowerCase()}`)
  const match = /github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:#path:\/([A-Za-z0-9_./-]+))?/i.exec(spec)
  if (match !== null) {
    ids.add(match[1]!.toLowerCase())
    if (match[2] !== undefined) ids.add(`${match[1]!.toLowerCase()}#path:/${match[2].toLowerCase()}`)
  }
  return ids
}

/**
 * Repo identities stated by the dependency SPEC itself (github: installs) —
 * hard evidence of where the package came from, unlike the name-derived
 * mirror in depIdentities, which is only a matching aid.
 */
function depSpecRepoIds(spec: string): Set<string> {
  const ids = new Set<string>()
  const m = /github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:#path:\/([A-Za-z0-9_./-]+))?/i.exec(spec)
  if (m !== null) {
    ids.add(m[1]!.toLowerCase())
    if (m[2] !== undefined) ids.add(`${m[1]!.toLowerCase()}#path:/${m[2].toLowerCase()}`)
  }
  return ids
}

/** Repo identity of a registry entry's source url (repo or repo#path form). */
function entryRepoIds(plugin: RegistryPlugin): Set<string> {
  const ids = new Set<string>()
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/tree\/[^/]+\/(.+?))?\/?$/.exec(plugin.url)
  if (m !== null) {
    ids.add(m[2] !== undefined ? `${m[1]!.toLowerCase()}#path:/${m[2].toLowerCase()}` : m[1]!.toLowerCase())
  }
  return ids
}

/**
 * The curated registry lists distinct plugins sharing one name — twelve
 * name-groups at the time of #66 (both dsh-usage-stats, four dsh-memory…).
 * A name coincidence must not survive contradicting repo evidence: when the
 * dependency's spec pins a github repo AND the entry states one, the repos
 * decide — the loose name/npm identities only apply when at least one side
 * carries no repo evidence (npm installs, non-github entries).
 */
function sameSourceConflict(plugin: RegistryPlugin, spec: string): boolean {
  const entry = entryRepoIds(plugin)
  const dep = depSpecRepoIds(spec)
  if (entry.size === 0 || dep.size === 0) return false
  for (const id of dep) if (entry.has(id)) return false
  return true
}

/** The installed dependency name a registry entry corresponds to, or null. */
export function matchInstalledName(plugin: RegistryPlugin, installed: InstalledMap): string | null {
  const ids = entryIdentities(plugin)
  for (const [name, spec] of Object.entries(installed)) {
    if (sameSourceConflict(plugin, String(spec))) continue
    for (const id of depIdentities(name, String(spec))) {
      if (ids.has(id)) return name
    }
  }
  return null
}

/** The registry entry an installed dependency corresponds to, or undefined. */
export function entryForDep(plugins: RegistryPlugin[], name: string, spec: string): RegistryPlugin | undefined {
  const ids = depIdentities(name, String(spec))
  return plugins.find((plugin) => {
    if (sameSourceConflict(plugin, String(spec))) return false
    for (const id of entryIdentities(plugin)) if (ids.has(id)) return true
    return false
  })
}

export function isInstalled(plugin: RegistryPlugin, installed: InstalledMap): boolean {
  return matchInstalledName(plugin, installed) !== null
}

/**
 * The header brand mark now lives in MarketSection.tsx as an inline SVG
 * (official-style monochrome glyph, fill="currentColor") so it follows the
 * active theme; the colored assets/logo.svg tile is no longer inlined here.
 */

/** Four representative colors for a theme card's preview strip. */
export function themeSwatch(def: ThemeDef): string[] {
  const tk = def.tokens || {}
  const pick = (names: string[]) => { for (const n of names) { if (tk[n]) return tk[n]! } return null }
  const dark = def.colorScheme === 'dark'
  return [
    pick(['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1']) || (dark ? '#0f1115' : '#ffffff'),
    pick(['--dsw-alias-bg-layer-2', '--dsw-alias-bg-overlay']) || (dark ? '#1a1d23' : '#f3f4f6'),
    pick(['--dsw-alias-brand-primary']) || '#4f6ef7',
    pick(['--dsw-alias-label-primary']) || (dark ? '#e5e7eb' : '#1f2328'),
  ]
}

// ------------------------------------------------------------- screenshots

/**
 * Image hosts screenshots may load from (#61) — GitHub's own hosting only.
 * Any other host is dropped BEFORE an <img> is created: a screenshot URL is
 * a request carrying the user's IP, so registry data and README content are
 * both treated as untrusted here, matching the upstream build gate.
 */
const SCREENSHOT_HOSTS = new Set([
  'raw.githubusercontent.com',
  'user-images.githubusercontent.com',
  'camo.githubusercontent.com',
  'github.com',
])

const MAX_SCREENSHOTS = 6

/** Keep only https URLs on allowlisted image hosts; SVG dropped (logos/badges). */
export function safeScreenshots(urls: unknown): string[] {
  if (!Array.isArray(urls)) return []
  const safe: string[] = []
  for (const value of urls) {
    if (typeof value !== 'string') continue
    let parsed: URL | null = null
    try { parsed = new URL(value) } catch { continue }
    if (parsed.protocol !== 'https:' || !SCREENSHOT_HOSTS.has(parsed.hostname)) continue
    if (/\.svg$/i.test(parsed.pathname)) continue
    if (!safe.includes(value)) safe.push(value)
    if (safe.length >= MAX_SCREENSHOTS) break
  }
  return safe
}

/**
 * Image URLs extracted from a repo README, in document order — the fallback
 * when an entry has no curated screenshots (#61). Markdown and <img> forms;
 * relative paths resolve against the README's directory on
 * raw.githubusercontent.com; badges fall out naturally (shields.io etc. are
 * not allowlisted) and SVG is skipped as logo/badge noise.
 */
export function extractReadmeImages(markdown: string, owner: string, repo: string, subpath: string | null): string[] {
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${subpath === null ? '' : subpath + '/'}`
  const found: string[] = []
  const push = (raw: string) => {
    const src = raw.trim().replace(/^<|>$/g, '')
    if (src === '' || src.startsWith('data:')) return
    let absolute: string
    if (/^https?:\/\//i.test(src)) {
      absolute = src
    } else if (src.startsWith('/')) {
      absolute = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD${src}`
    } else {
      try { absolute = new URL(src, base).href } catch { return }
    }
    found.push(absolute)
  }
  // One pass over both forms so the result keeps document order.
  for (const m of markdown.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)|<img[^>]*\ssrc=["']([^"']+)["']/gi)) {
    push(m[1] ?? m[2]!)
  }
  return safeScreenshots(found)
}

const readmeShotsCache = new Map<string, Promise<string[]>>()

/** Test hook: the cache is module-level and outlives component unmounts. */
export function resetScreenshotsCache(): void {
  readmeShotsCache.clear()
}

/**
 * Screenshots for a plugin: the registry's curated list when present,
 * otherwise lazily extracted from the repo README. Only ever called AFTER
 * the user opens the detail dialog — browsing the list must make zero
 * external requests. Failures resolve to [] (silent degradation).
 */
export function pluginScreenshots(plugin: RegistryPlugin): Promise<string[]> {
  const curated = safeScreenshots(plugin.screenshots)
  if (curated.length > 0) return Promise.resolve(curated)
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/tree\/[^/]+\/(.+?))?\/?$/.exec(plugin.url)
  if (m === null) return Promise.resolve([])
  const [, owner, repo, subpath = null] = m
  const cacheKey = plugin.url
  const cached = readmeShotsCache.get(cacheKey)
  if (cached !== undefined) return cached
  const fetchReadme = async (path: string | null): Promise<string | null> => {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${path === null ? '' : path + '/'}README.md`)
      return res.ok ? await res.text() : null
    } catch {
      return null
    }
  }
  const task = (async () => {
    // Monorepo subpath entries prefer their own README, falling back to the
    // repo root; shots in the subpath README resolve against its directory.
    const sub = subpath === null ? null : await fetchReadme(subpath)
    if (sub !== null) return extractReadmeImages(sub, owner!, repo!, subpath)
    const root = await fetchReadme(null)
    return root === null ? [] : extractReadmeImages(root, owner!, repo!, null)
  })().catch(() => [] as string[])
  readmeShotsCache.set(cacheKey, task)
  return task
}
