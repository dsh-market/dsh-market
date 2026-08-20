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
  /**
   * npm downloads in the last 30 days, when the entry has a published
   * package. Absent means "no npm package" — a coverage gap, not a zero.
   */
  downloads?: number | null
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

/** Strong repo identities discovered for local link:/file: dependencies (#141). */
export type InstalledRepoIdentities = Record<string, string[]>

/** Weak Git-origin hints used only to disambiguate multiple same-named entries. */
export type InstalledRepoHints = Record<string, string[]>

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
  /** The market's own version — rendered in the heading so screenshots carry it. */
  version?: string
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
  /** Strong source identities for local link:/file: dependencies (#141). */
  repoIdentities?: InstalledRepoIdentities
  /** Weak local Git-origin hints; never used to reject a unique match. */
  repoHints?: InstalledRepoHints
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
  // A description can mention a CLI only to say it is NOT required. Treating
  // that as positive evidence labels web plugins as terminal-only. Strip
  // bounded negated clauses before applying the deliberately broad heuristic;
  // the package name remains untouched and therefore stays strong evidence.
  const positiveDesc = desc
    .replace(/\b(?:no|without)\b[^.!?;:，。！？；\n]{0,80}\b(?:tui|cli|tty|terminal)\b/gi, '')
    .replace(/(?:无需|无须|不需要|不用)[^。！？；\n]{0,48}(?:tui|cli|tty|terminal|终端|命令行)/gi, '')
  return /\b(tui|cli|tty|terminal)\b|终端|命令行/i.test(plugin.name + ' ' + positiveDesc)
}

/** Sortable field for the Discover list. */
export type SortField = 'downloads' | 'stars' | 'added'
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
 * Whether a catalog entry IS the market itself. The catalog still carries
 * it — nothing about the data changes, and the Installed tab still shows it
 * — this is purely "a store has no reason to sell itself to someone already
 * standing in it."
 */
export function isMarketItself(plugin: Pick<RegistryPlugin, 'name' | 'npm'>): boolean {
  return plugin.name === 'dsh-market' || plugin.npm === 'dshmarket'
}

/**
 * The discover list: category filter, then the published-within window, then
 * search across name / owner / localized description, then the selected sort.
 * Pure — the section renders exactly this.
 */
export function visiblePlugins(plugins: RegistryPlugin[], options: ListQuery): RegistryPlugin[] {
  const query = options.query.trim().toLowerCase()
  const list = plugins.filter((p) => {
    if (isMarketItself(p)) return false
    if (options.category !== 'all' && p.category !== options.category) return false
    if (options.sinceDays !== undefined && !withinDays(p.added, options.sinceDays)) return false
    if (query === '') return true
    const desc = (p.description && (p.description[options.lang] || p.description.en)) || ''
    return p.name.toLowerCase().includes(query)
      || p.owner.toLowerCase().includes(query)
      || desc.toLowerCase().includes(query)
  })
  // A github:-only entry has no npm package and therefore no download count
  // at all — that is a coverage gap, not a "0 downloads" verdict, and must
  // not be read as less popular than a package that genuinely has zero.
  // Such entries always sort after every entry WITH a real count, in either
  // direction, and are ordered against each other by star count — the only
  // signal available for them — rather than left in an arbitrary tie.
  const hasDownloads = (p: RegistryPlugin): p is RegistryPlugin & { downloads: number } => typeof p.downloads === 'number'
  if (options.sort === 'downloads-desc') {
    return [...list].sort((a, b) => {
      if (hasDownloads(a) && hasDownloads(b)) return b.downloads - a.downloads
      if (hasDownloads(a)) return -1
      if (hasDownloads(b)) return 1
      return (b.stars ?? -1) - (a.stars ?? -1)
    })
  }
  if (options.sort === 'downloads-asc') {
    return [...list].sort((a, b) => {
      if (hasDownloads(a) && hasDownloads(b)) return a.downloads - b.downloads
      if (hasDownloads(a)) return -1
      if (hasDownloads(b)) return 1
      return (a.stars ?? -1) - (b.stars ?? -1)
    })
  }
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
 * Category chip order: collapsed with an active non-'all' chip that would
 * otherwise be clipped out of the two-row preview, the active one moves to
 * the front so it stays visible.
 *
 * Reported as "点了某个分类，标签就跑到前面来了，好奇怪": the earlier version
 * moved the active chip to the front unconditionally, so clicking a category
 * that was ALREADY visible inside the two rows still reshuffled it — and
 * every chip after it — for no reason, since nothing was at risk of being
 * hidden. `visibleCount` is how many chips (the 'all' chip included) the
 * two-row clip fits; a category already within that budget in its natural
 * position is left exactly where it was.
 *
 * `visibleCount === null` (not yet measured, e.g. the very first collapsed
 * render) keeps the old unconditional behaviour: with no measurement to
 * check against, guaranteeing visibility is the safe default.
 */
export function orderedCategories(
  categories: string[],
  active: string,
  open: boolean,
  visibleCount: number | null = null,
): string[] {
  if (open || active === 'all') return categories
  if (visibleCount !== null) {
    // One slot of the budget is always the 'all' chip itself.
    const budget = Math.max(0, visibleCount - 1)
    const naturalIndex = categories.indexOf(active)
    if (naturalIndex !== -1 && naturalIndex < budget) return categories
  }
  return [active, ...categories.filter(id => id !== active)]
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

const REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#path:\/[A-Za-z0-9_./-]+)?$/

function addRepoIdentities(ids: Set<string>, values: readonly string[]): void {
  for (const value of values) {
    if (!REPO_ID_RE.test(value)) continue
    const subpath = value.split('#path:/')[1]
    if (subpath !== undefined && subpath.split('/').some(seg => seg === '' || seg === '.' || seg === '..')) continue
    ids.add(value.toLowerCase())
  }
}

function depIdentities(name: string, spec: string, repoIdentities: readonly string[] = []): Set<string> {
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
  addRepoIdentities(ids, repoIdentities)
  return ids
}

/**
 * Repo identities stated by the dependency SPEC itself (github: installs) —
 * hard evidence of where the package came from, unlike the name-derived
 * mirror in depIdentities, which is only a matching aid.
 */
function depRepoIds(spec: string, repoIdentities: readonly string[] = []): Set<string> {
  const ids = new Set<string>()
  const m = /github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:#path:\/([A-Za-z0-9_./-]+))?/i.exec(spec)
  if (m !== null) {
    ids.add(m[1]!.toLowerCase())
    if (m[2] !== undefined) ids.add(`${m[1]!.toLowerCase()}#path:/${m[2].toLowerCase()}`)
  }
  addRepoIdentities(ids, repoIdentities)
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
function sameSourceConflict(plugin: RegistryPlugin, spec: string, repoIdentities: readonly string[] = []): boolean {
  const entry = entryRepoIds(plugin)
  const dep = depRepoIds(spec, repoIdentities)
  if (entry.size === 0 || dep.size === 0) return false
  for (const id of dep) if (entry.has(id)) return false
  return true
}

function repoHintMatches(plugin: RegistryPlugin, hints: readonly string[]): boolean {
  const entry = entryRepoIds(plugin)
  const values = new Set<string>()
  addRepoIdentities(values, hints)
  for (const id of values) if (entry.has(id)) return true
  return false
}

function looseMatchCount(plugins: RegistryPlugin[], name: string): number {
  return plugins.filter(plugin => looseMatches(plugin, name)).length
}

function looseMatches(plugin: RegistryPlugin, name: string): boolean {
  const dep = depIdentities(name, '')
  for (const id of entryIdentities(plugin)) if (dep.has(id)) return true
  return false
}

/** The installed dependency name a registry entry corresponds to, or null. */
export function matchInstalledName(
  plugin: RegistryPlugin,
  installed: InstalledMap,
  repoIdentities: InstalledRepoIdentities = {},
  plugins?: RegistryPlugin[],
  repoHints: InstalledRepoHints = {},
): string | null {
  const ids = entryIdentities(plugin)
  for (const [name, spec] of Object.entries(installed)) {
    const repos = repoIdentities[name] ?? []
    if (depRepoIds(String(spec), repos).size === 0 && plugins !== undefined && looseMatchCount(plugins, name) > 1
      && !repoHintMatches(plugin, repoHints[name] ?? [])) continue
    if (sameSourceConflict(plugin, String(spec), repos)) continue
    for (const id of depIdentities(name, String(spec), repos)) {
      if (ids.has(id)) return name
    }
  }
  return null
}

/** The registry entry an installed dependency corresponds to, or undefined. */
export function entryForDep(
  plugins: RegistryPlugin[],
  name: string,
  spec: string,
  repoIdentities: readonly string[] = [],
  repoHints: readonly string[] = [],
): RegistryPlugin | undefined {
  if (depRepoIds(String(spec), repoIdentities).size === 0 && looseMatchCount(plugins, name) > 1) {
    const hinted = plugins.find(plugin => repoHintMatches(plugin, repoHints) && looseMatches(plugin, name))
    if (hinted === undefined) return undefined
  }
  const ids = depIdentities(name, String(spec), repoIdentities)
  return plugins.find((plugin) => {
    if (sameSourceConflict(plugin, String(spec), repoIdentities)) return false
    for (const id of entryIdentities(plugin)) if (ids.has(id)) return true
    return false
  })
}

export function isInstalled(
  plugin: RegistryPlugin,
  installed: InstalledMap,
  repoIdentities: InstalledRepoIdentities = {},
  plugins?: RegistryPlugin[],
  repoHints: InstalledRepoHints = {},
): boolean {
  return matchInstalledName(plugin, installed, repoIdentities, plugins, repoHints) !== null
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

/**
 * The human-readable part of a failed command's output.
 *
 * pnpm's ndjson reporter writes one JSON object per progress tick, and a
 * large `github:` download emits thousands of them. When a failure matches
 * none of the known signatures there is no diagnosis to show, so the UI
 * falls back to the tail of stdout/stderr — which for exactly that case is
 * 600 characters of `{"name":"pnpm:fetching-progress","downloaded":…}`.
 * The user is handed machine noise at the one moment they need a sentence
 * (#148, and the same shape behind #161).
 *
 * Progress objects are dropped; anything else — including JSON carrying a
 * real message — is kept, because an unrecognized failure is precisely when
 * throwing information away is most expensive.
 */
export function humanOutput(raw: string): string {
  const lines = raw.split(/\r?\n/)
  const kept: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (!trimmed.startsWith('{')) { kept.push(line); continue }
    try {
      const parsed = JSON.parse(trimmed) as { name?: unknown; err?: unknown; message?: unknown }
      const name = typeof parsed.name === 'string' ? parsed.name : ''
      // Keep anything that carries a diagnosis, drop pure progress chatter.
      if (parsed.err !== undefined || typeof parsed.message === 'string') { kept.push(line); continue }
      if (name.startsWith('pnpm:')) continue
      kept.push(line)
    } catch {
      kept.push(line)
    }
  }
  return kept.join('\n').trim()
}

/**
 * The plugin's own name, for display.
 *
 * The catalog's `name` is an IDENTITY, and for the 104 entries that live in
 * a repository holding several plugins it is a compound one:
 * `dsh-web-ui#packages/dsh-web-ui-all`. Shown verbatim it puts a repository
 * path in front of a user who did not ask about repositories — and worse, it
 * disagrees with the market's own installed list, which reads names out of
 * the profile manifest and calls the same plugin `dsh-web-ui-all`. The same
 * thing had two names either side of the Install button.
 *
 * A card answers two questions: who made it, and what is it called. The
 * author is drawn beside their avatar as one unit, so the title is free to
 * be just the plugin. Duplicate titles across authors are fine — the byline
 * is what separates them — which is why this does not try to keep the
 * repository as a qualifier.
 *
 * The repository name IS the plugin name in the ordinary case, because a
 * repository holding one plugin is named after it. Only the compound form
 * needs unpicking, and its last segment is the plugin's own directory.
 *
 * Not a substitute for the identity: every key, lookup and install still
 * uses `name` unchanged.
 */
export function pluginName(name: string): string {
  const hash = name.indexOf('#')
  if (hash === -1) return name
  const sub = name.slice(hash + 1)
  const leaf = sub.slice(sub.lastIndexOf('/') + 1)
  // A sub-path that is empty or trailing-slashed tells us nothing; the
  // repository half is a better answer than an empty title.
  return leaf === '' ? name.slice(0, hash) : leaf
}

/**
 * Compact display for a count that can run into the tens of thousands
 * (npm downloads, star counts): "11.9k" instead of "11862". Reported —
 * the raw number made the card byline visibly cramped once downloads was
 * added alongside stars.
 *
 * Below 1000 the exact number is shown; a small count is exactly the case
 * where the precision matters and abbreviating it buys nothing.
 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return String(n)
  const k = Math.round(n / 100) / 10
  return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}k`
}
