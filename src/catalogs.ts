/**
 * Catalog sources beyond the public one: an organization's own list of
 * plugins, in the same shape as the public `plugins.json`.
 *
 * Where they come from:
 * - the policy file's `catalogs` (locked; the user cannot remove them), and
 * - the user's own, added in the market's settings (stored in the profile's
 *   market state) unless the policy says `"userCatalogs": false`.
 *
 * This module holds everything about them EXCEPT the public catalog, whose
 * fetch path (and its 304 validator) stays in src/registry.ts exactly as it
 * was. `loadRegistry` there calls in here only when something is configured;
 * with nothing configured it never gets here, which is what makes "no policy,
 * no user catalogs" the same requests as before.
 *
 * ## Failure
 *
 * A source that cannot be read costs the user that source, not the market:
 * every source is fetched on its own, what loaded is merged, and each failure
 * is reported per source as a code plus detail (`SourceError`) for the UI to
 * say in the user's language. Secrets: header values and `.npmrc` tokens are
 * never put into a message — {@link scrub} removes any configured header value
 * and URL credentials from every failure text before it leaves this module.
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BODY_STALL_TIMEOUT_MS, HEADERS_TIMEOUT_MS, readBodyWhileProgressing } from './body-progress.ts'
import { expandHomePath } from './home-paths.ts'
import { logEvent } from './log.ts'
import { marketFetch } from './net.ts'
import { isInsideOfflineRoot, resolveBundleFile } from './offline.ts'
import {
  asLabel, CATALOG_ID_RE, expandEnv, getPolicy, globMatch, pinnedVersion, PUBLIC_SOURCE_ID, type LocalizedLabel, type Policy,
} from './policy.ts'
import type { Registry, RegistryPlugin } from './registry.ts'

/** A saved user catalog: a URL or an absolute file path, nothing secret. */
export interface UserCatalog {
  id: string
  url?: string
  file?: string
}

export const MAX_USER_CATALOGS = 8

export type SourceErrorCode =
  | 'network' | 'timeout' | 'auth' | 'http' | 'invalid' | 'empty' | 'file' | 'env' | 'policy'

/** What went wrong with one source: a code the UI words, plus a short detail. */
export interface SourceError {
  code: SourceErrorCode
  detail: string
}

/** What the settings list and the Discover banner know about one source. No secrets, ever. */
export interface SourceInfo {
  id: string
  kind: 'public' | 'policy' | 'user'
  label: LocalizedLabel
  /** Host and path (or file path) for display; no credentials, no query. */
  where: string
  /** `off`: the policy turned the public catalog off. */
  status: 'ok' | 'failed' | 'off'
  count: number
  /** Entries skipped because they were not usable (no name, no link, no category). */
  skipped: number
  error?: SourceError
  /** Set by the organization: the user cannot remove or switch it. */
  locked: boolean
  /** Its entries install from package files shipped with it, not from a registry. */
  offline?: true
}

/** The public catalog's label, as plugin cards and the source list show it. */
export const PUBLIC_LABEL: LocalizedLabel = { zh: '公开目录', en: 'Public catalog' }

/** A source ready to fetch: what to read, and the headers it needs. */
export interface ExtraSource {
  id: string
  kind: 'policy' | 'user'
  label: LocalizedLabel
  url?: string
  file?: string
  /** Unexpanded; `${ENV}` is expanded per request. */
  headers: Record<string, string>
}

// ---------------------------------------------------------------------------
// Configuration: policy + the user's saved catalogs.

let userCatalogs: UserCatalog[] = []

/** Replace the user's saved catalogs (read from the profile's market state). */
export function setUserCatalogs(list: readonly UserCatalog[]): void {
  userCatalogs = [...list]
}

export function currentUserCatalogs(): readonly UserCatalog[] {
  return userCatalogs
}

export interface CatalogConfig {
  policy: Policy
  publicEnabled: boolean
  extras: ExtraSource[]
  /** Anything beyond "the public catalog and nothing else". */
  active: boolean
  /** Changes whenever what would be fetched (or filtered) changes. */
  signature: string
}

/** Where a user catalog reads from, with the host's own tilde forms expanded. */
function userSource(entry: UserCatalog): ExtraSource {
  const fallback = fallbackLabel(entry)
  return {
    id: entry.id,
    kind: 'user',
    label: fallback,
    ...(entry.url !== undefined ? { url: entry.url } : {}),
    ...(entry.file !== undefined ? { file: entry.file } : {}),
    headers: {},
  }
}

/** Host name or file name: a label for a catalog that did not name itself. */
export function fallbackLabel(entry: Pick<UserCatalog, 'url' | 'file'>): LocalizedLabel {
  let text = ''
  if (entry.url !== undefined) {
    try { text = new URL(entry.url).hostname } catch { text = '' }
  } else if (entry.file !== undefined) {
    text = basename(entry.file, extname(entry.file))
  }
  text = text === '' ? 'catalog' : text.slice(0, 40)
  return { zh: text, en: text }
}

/** The sources and filters in force right now. Cheap: the policy is cached. */
export function catalogConfig(): CatalogConfig {
  const policy = getPolicy()
  const extras: ExtraSource[] = policy.catalogs.map(entry => ({
    id: entry.id,
    kind: 'policy',
    label: entry.label,
    ...(entry.url !== undefined ? { url: entry.url } : {}),
    ...(entry.file !== undefined ? { file: entry.file } : {}),
    headers: entry.headers,
  }))
  if (policy.userCatalogs) {
    const taken = new Set(extras.map(source => source.id))
    for (const entry of userCatalogs) {
      if (!taken.has(entry.id)) extras.push(userSource(entry))
    }
  }
  const active = extras.length > 0 || !policy.publicCatalog || policy.allow !== null || Object.keys(policy.pins).length > 0
  return {
    policy,
    publicEnabled: policy.publicCatalog,
    extras,
    active,
    signature: JSON.stringify([
      policy.publicCatalog, policy.allow, policy.pins,
      extras.map(source => [source.id, source.url ?? null, source.file ?? null, source.headers]),
    ]),
  }
}

// ---------------------------------------------------------------------------
// Failures, without secrets.

/** Remove URL credentials, query strings, and any configured header value from a text. */
export function scrub(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('***')
    // `Bearer abc` is configured whole, but a server may echo only the token.
    const token = /^\s*(?:bearer|basic|token)\s+(\S+)\s*$/iu.exec(secret)?.[1]
    if (token !== undefined && token.length >= 4) out = out.split(token).join('***')
  }
  return out
    .replace(/(\bhttps?:\/\/)[^\s/@]+@/giu, '$1***@')
    .replace(/(\bhttps?:\/\/[^\s?#]+)\?[^\s#]*/giu, '$1?***')
}

/** The plain location of a source for display: host and path, or the file path. */
export function displayWhere(source: Pick<ExtraSource, 'url' | 'file'>): string {
  if (source.file !== undefined) return source.file
  if (source.url === undefined) return ''
  try {
    const url = new URL(source.url)
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`
  } catch {
    return ''
  }
}

function failure(error: unknown, secrets: readonly string[]): SourceError {
  if (error instanceof SourceFailure) return { code: error.code, detail: scrub(error.detail, secrets).slice(0, 200) }
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : ''
  const detail = scrub(cause !== '' && /fetch failed/iu.test(message) ? cause : message, secrets).slice(0, 200)
  if (name === 'TimeoutError' || /timeout|timed out|no new data/iu.test(message)) return { code: 'timeout', detail }
  return { code: 'network', detail }
}

class SourceFailure extends Error {
  readonly code: SourceErrorCode
  readonly detail: string
  constructor(code: SourceErrorCode, detail: string) {
    super(`${code}: ${detail}`)
    this.code = code
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// Reading one source.

interface Cached {
  /** What the validator belongs to: the location and the expanded headers. */
  stamp: string
  etag: string | null
  modified: string | null
  /** File sources: change detection. */
  fileStamp: string | null
  digest: string
  registry: Registry
  label: LocalizedLabel | null
  skipped: number
  offline: boolean
}

const cache = new Map<string, Cached>()
const lastLogged = new Map<string, string>()

/** Drop every validator, so the next read of each source is unconditional. */
export function forgetExtraCatalogs(): void {
  cache.clear()
}

/**
 * A git source an entry may install from, as pnpm's spec, or null.
 *
 * https and ssh remotes (plus plain http for hosts that only speak it), an
 * optional `#ref`. A password in the address is refused: a catalog is shared
 * text, and a secret does not belong in it. ssh keys are the machine's own.
 */
export function normalizeGitSpec(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  const ref = '(?:#[A-Za-z0-9][A-Za-z0-9._/@^~+-]{0,120})?'
  let spec: string | null = null
  if (new RegExp(`^git\\+(?:https?|ssh)://[^\\s#@:/]+(?::\\d+)?(?:/[^\\s#]*)?${ref}$`, 'u').test(text.replace(/\/\/[^\s/@]*@/u, '//'))) spec = text
  else if (new RegExp(`^(?:https?|ssh)://[^\\s#]+\\.git${ref}$`, 'u').test(text.replace(/\/\/[^\s/@]*@/u, '//'))) spec = `git+${text}`
  else {
    const scp = new RegExp(`^([A-Za-z0-9._-]+)@([A-Za-z0-9][A-Za-z0-9.-]*):([^\\s#]+)(${ref})$`, 'u').exec(text)
    if (scp !== null) spec = `git+ssh://${scp[1]!}@${scp[2]!}/${scp[3]!}${scp[4] ?? ''}`
  }
  if (spec === null) return null
  try {
    const url = new URL(spec.replace(/^git\+/u, '').replace(/#.*$/u, ''))
    if (url.password !== '' || (url.protocol !== 'ssh:' && url.username !== '')) return null
    // A host that starts with a dash would be read as an option by git.
    if (!/^[A-Za-z0-9[]/u.test(url.hostname)) return null
  } catch { return null }
  return spec
}

/** Entries a private catalog may carry, made safe to hand to the rest of the market. */
function cleanEntries(value: unknown, baseDir?: string): { plugins: RegistryPlugin[]; skipped: number; categories: Record<string, Record<string, string>>; updated: string; label: LocalizedLabel | null } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SourceFailure('invalid', 'not a catalog document')
  const doc = value as Record<string, unknown>
  if (!Array.isArray(doc.plugins)) throw new SourceFailure('invalid', 'no "plugins" list')
  const plugins: RegistryPlugin[] = []
  let skipped = 0
  const today = new Date().toISOString().slice(0, 10)
  for (const raw of doc.plugins as unknown[]) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { skipped += 1; continue }
    const entry = raw as Record<string, unknown>
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    const url = typeof entry.url === 'string' ? entry.url.trim() : ''
    const categories = (Array.isArray(entry.category) ? entry.category : [entry.category])
      .filter((item): item is string => typeof item === 'string' && item !== '')
    if (name === '' || !/^https?:\/\//iu.test(url) || categories.length === 0) { skipped += 1; continue }
    const npm = typeof entry.npm === 'string' && entry.npm !== '' ? entry.npm : null
    const description = typeof entry.description === 'string'
      ? { zh: entry.description, en: entry.description }
      : entry.description !== null && typeof entry.description === 'object' && !Array.isArray(entry.description)
        ? Object.fromEntries(Object.entries(entry.description as Record<string, unknown>).filter(([, text]) => typeof text === 'string')) as Record<string, string>
        : {}
    // A catalog cannot claim to be another source: the market stamps `source`
    // itself after the merge, so a stray one is dropped here.
    const {
      source: _claimed, offlineTarball: _offline, pinned: _pinned, git: _git, tarball: declaredTarball, screenshots: _shots, ...rest
    } = entry as Record<string, unknown>
    // A package file that ships with the catalog: resolved here, once, against
    // the catalog's own directory, and kept as an absolute path the install
    // reads. The request never names a path; a bad one skips the entry.
    let offlineTarball: string | undefined
    if (typeof declaredTarball === 'string' && baseDir !== undefined && !/^https?:/iu.test(declaredTarball)) {
      const resolved = resolveBundleFile(baseDir, declaredTarball)
      if (resolved === null) { skipped += 1; continue }
      offlineTarball = resolved
    }
    const git = normalizeGitSpec(entry.git)
    if (entry.git !== undefined && git === null) { skipped += 1; continue }
    const screenshots = Array.isArray(entry.screenshots)
      ? entry.screenshots.filter((item): item is string => typeof item === 'string' && /^https:\/\//iu.test(item)).slice(0, 6)
      : []
    plugins.push({
      ...rest,
      name,
      owner: typeof entry.owner === 'string' ? entry.owner : '',
      url,
      category: categories.length === 1 ? categories[0]! : categories,
      description,
      npm,
      install: typeof entry.install === 'string' && entry.install !== '' ? entry.install : npm ?? name,
      added: typeof entry.added === 'string' ? entry.added : today,
      ...(typeof declaredTarball === 'string' && offlineTarball === undefined ? { tarball: declaredTarball } : {}),
      ...(offlineTarball === undefined ? {} : { offlineTarball }),
      ...(git === null ? {} : { git }),
      ...(screenshots.length === 0 ? {} : { screenshots }),
    } as RegistryPlugin)
  }
  const categories: Record<string, Record<string, string>> = {}
  if (doc.categories !== null && typeof doc.categories === 'object' && !Array.isArray(doc.categories)) {
    for (const [id, label] of Object.entries(doc.categories as Record<string, unknown>)) {
      const parsed = asLabel(label)
      if (parsed !== null) categories[id] = parsed
    }
  }
  return {
    plugins,
    skipped,
    categories,
    updated: typeof doc.updated === 'string' ? doc.updated : '',
    label: asLabel(doc.label ?? doc.name),
  }
}

function digestOf(bytes: string): string {
  return createHash('sha1').update(bytes).digest('hex').slice(0, 16)
}

/**
 * Read one source. Throws a {@link SourceFailure} the caller turns into an
 * error shown for this source only.
 *
 * `fresh` skips the validator: adding a catalog must test the real thing.
 */
async function readSource(
  source: ExtraSource, fresh: boolean, env: NodeJS.ProcessEnv,
): Promise<{ cached: Cached; secrets: string[] }> {
  const secrets: string[] = []
  const headers: Record<string, string> = {}
  const missing: string[] = []
  for (const [name, template] of Object.entries(source.headers)) {
    const expanded = expandEnv(template, env)
    missing.push(...expanded.missing)
    headers[name] = expanded.value
    if (expanded.value !== '') secrets.push(expanded.value)
  }
  if (missing.length > 0) {
    throw new SourceFailure('env', [...new Set(missing)].join(', '))
  }
  const previous = fresh ? undefined : cache.get(source.id)

  if (source.file !== undefined) {
    // A directory is an unpacked bundle: its catalog is `plugins.json` inside.
    const file = (() => {
      try { return statSync(source.file).isDirectory() ? join(source.file, 'plugins.json') : source.file } catch { return source.file }
    })()
    let info
    try { info = statSync(file) } catch (error) {
      throw new SourceFailure('file', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found' : error instanceof Error ? error.message : String(error))
    }
    const fileStamp = `${String(info.mtimeMs)}:${String(info.size)}`
    const stamp = `file:${file}`
    if (previous !== undefined && previous.stamp === stamp && previous.fileStamp === fileStamp) return { cached: previous, secrets }
    let text: string
    try { text = readFileSync(file, 'utf8') } catch (error) {
      throw new SourceFailure('file', error instanceof Error ? error.message : String(error))
    }
    return { cached: remember(source, stamp, null, null, fileStamp, text, previous, dirname(file)), secrets }
  }

  const url = source.url!
  const stamp = `url:${url}:${digestOf(JSON.stringify(headers))}`
  const reusable = previous !== undefined && previous.stamp === stamp ? previous : undefined
  const sent: Record<string, string> = { ...headers }
  if (reusable?.etag != null) sent['if-none-match'] = reusable.etag
  else if (reusable?.modified != null) sent['if-modified-since'] = reusable.modified
  const controller = new AbortController()
  const deadline = setTimeout(() => {
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
  }, HEADERS_TIMEOUT_MS)
  let res: Response
  try {
    res = await marketFetch(url, { signal: controller.signal, headers: sent })
  } finally {
    clearTimeout(deadline)
  }
  if (res.status === 304 && reusable !== undefined) return { cached: reusable, secrets }
  if (res.status === 401 || res.status === 403) throw new SourceFailure('auth', String(res.status))
  if (!res.ok) throw new SourceFailure('http', String(res.status))
  const text = new TextDecoder().decode(await readBodyWhileProgressing(res, BODY_STALL_TIMEOUT_MS, 'the catalog'))
  return {
    cached: remember(source, stamp, res.headers.get('etag'), res.headers.get('last-modified'), null, text, previous),
    secrets,
  }
}

function remember(
  source: ExtraSource, stamp: string, etag: string | null, modified: string | null, fileStamp: string | null,
  text: string, previous: Cached | undefined, baseDir?: string,
): Cached {
  const digest = digestOf(text)
  // The same content is the same object: nothing downstream (the discovery
  // snapshot, the client's generation check) should see a change that is not one.
  if (previous !== undefined && previous.stamp === stamp && previous.digest === digest) {
    const kept = { ...previous, etag, modified, fileStamp }
    cache.set(source.id, kept)
    return kept
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch {
    throw new SourceFailure('invalid', 'not JSON')
  }
  const clean = cleanEntries(parsed, baseDir)
  if (clean.plugins.length === 0) throw new SourceFailure('empty', clean.skipped > 0 ? `${String(clean.skipped)} unusable entries` : '')
  const registry: Registry = {
    updated: clean.updated,
    count: clean.plugins.length,
    categories: clean.categories,
    plugins: clean.plugins,
  }
  const cached: Cached = { stamp, etag, modified, fileStamp, digest, registry, label: clean.label, skipped: clean.skipped, offline: clean.plugins.some(plugin => plugin.offlineTarball !== undefined) }
  cache.set(source.id, cached)
  return cached
}

export interface ExtraResult {
  info: SourceInfo
  registry: Registry | null
}

/** Read one source and report it; never throws. */
export async function loadExtra(source: ExtraSource, options: { fresh?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<ExtraResult> {
  const base = {
    id: source.id,
    kind: source.kind,
    where: displayWhere(source),
    locked: source.kind === 'policy',
  } as const
  const secrets = Object.values(source.headers)
  try {
    const { cached } = await readSource(source, options.fresh === true, options.env ?? process.env)
    lastLogged.delete(source.id)
    // A user's catalog may name itself; the organization's label always wins.
    const label = source.kind === 'user' && cached.label !== null ? cached.label : source.label
    return {
      info: { ...base, label, status: 'ok', count: cached.registry.plugins.length, skipped: cached.skipped, ...(cached.offline ? { offline: true as const } : {}) },
      registry: cached.registry,
    }
  } catch (error) {
    const reported = failure(error, secrets)
    const line = `${reported.code}:${reported.detail}`
    if (lastLogged.get(source.id) !== line) {
      lastLogged.set(source.id, line)
      logEvent('warn', 'catalog', `catalog source "${source.id}" (${base.where}) could not be read — ${reported.code}${reported.detail === '' ? '' : `: ${reported.detail}`}`)
    }
    return {
      info: { ...base, label: source.label, status: 'failed', count: 0, skipped: 0, error: reported },
      registry: null,
    }
  }
}

// ---------------------------------------------------------------------------
// Merging and filtering.

/** Whether the policy's `allow` list lets this entry be shown and installed. */
export function entryAllowed(entry: Pick<RegistryPlugin, 'name' | 'npm'>, allow: readonly string[] | null): boolean {
  if (allow === null) return true
  const names = [entry.name, typeof entry.npm === 'string' ? entry.npm : ''].filter(name => name !== '')
  return allow.some(pattern => names.some(name => globMatch(pattern, name)))
}

export interface MergeInput {
  /** The public catalog, or null when it is off or failed. */
  publicRegistry: Registry | null
  publicInfo: SourceInfo | null
  /** In priority order: policy catalogs, then the user's. */
  extras: readonly { info: SourceInfo; registry: Registry | null }[]
  allow: readonly string[] | null
  /** The administrator's exact-version pins by npm package name. */
  pins?: Readonly<Record<string, string>>
}

/**
 * Combine the sources. Pure.
 *
 * - The same repository URL, or the same npm package, in two sources: the
 *   private one wins (earlier private sources before later ones). One plugin
 *   must not appear as two cards because two catalogs both list it.
 * - Private entries come first: they are why the organization set this up.
 * - Categories merge; a category id a private entry uses that nothing
 *   describes shows under its own id.
 * - `source` is stamped here on every private entry, and removed from public
 *   ones, so a catalog cannot pass itself off as another source.
 * - `allow` filters the union; `pins` fix the version an entry shows and installs.
 */
export function mergeSources(input: MergeInput): Registry {
  const taken = new Set<string>()
  const takenNpm = new Set<string>()
  const merged: RegistryPlugin[] = []
  const categories: Registry['categories'] = {}
  const infos: SourceInfo[] = []
  if (input.publicInfo !== null) infos.push(input.publicInfo)
  for (const { info, registry } of input.extras) {
    infos.push(info)
    if (registry === null) continue
    for (const plugin of registry.plugins) {
      const key = plugin.url.toLowerCase()
      const npm = typeof plugin.npm === 'string' ? plugin.npm.toLowerCase() : ''
      if (taken.has(key) || (npm !== '' && takenNpm.has(npm))) continue
      taken.add(key)
      if (npm !== '') takenNpm.add(npm)
      merged.push({ ...plugin, source: { id: info.id, label: info.label } })
    }
  }
  const publicPlugins = (input.publicRegistry?.plugins ?? []).flatMap(plugin => {
    if (taken.has(plugin.url.toLowerCase())) return []
    if (typeof plugin.npm === 'string' && takenNpm.has(plugin.npm.toLowerCase())) return []
    if (plugin.source === undefined) return [plugin]
    const { source: _stray, ...rest } = plugin
    return [rest as RegistryPlugin]
  })
  Object.assign(categories, input.publicRegistry?.categories ?? {})
  for (const { registry } of input.extras) {
    for (const [id, label] of Object.entries(registry?.categories ?? {})) categories[id] ??= label
  }
  const pins = input.pins ?? {}
  const plugins = [...merged, ...publicPlugins].filter(plugin => entryAllowed(plugin, input.allow)).map(plugin => {
    const pin = typeof plugin.npm === 'string' && Object.keys(pins).length > 0 ? pinnedVersion(plugin.npm, { pins } as Policy) : undefined
    // A pinned entry shows the pinned version, and says why.
    return pin === undefined ? plugin : { ...plugin, version: pin, pinned: pin }
  })
  for (const plugin of plugins) {
    const ids = Array.isArray(plugin.category) ? plugin.category : [plugin.category]
    for (const id of ids) categories[id] ??= { zh: id, en: id }
  }
  const extraDigest = digestOf(JSON.stringify(input.extras.map(({ info, registry }) => [info.id, registry?.plugins ?? null])))
  const updated = input.publicRegistry === null
    ? `private-${extraDigest}`
    : input.extras.some(({ registry }) => registry !== null) ? `${input.publicRegistry.updated}+${extraDigest}` : input.publicRegistry.updated
  return { updated, count: plugins.length, categories, plugins, sources: infos }
}

// ---------------------------------------------------------------------------
// The user's own "add a catalog".

/** What a person typed into the add box, as a source, or why not. */
export function parseCatalogInput(text: string): { url?: string; file?: string } | { error: 'empty' | 'credentials' | 'unrecognized' } {
  const value = text.trim()
  if (value === '') return { error: 'empty' }
  if (/^https?:\/\//iu.test(value)) {
    try {
      const url = new URL(value)
      if (url.username !== '' || url.password !== '') return { error: 'credentials' }
      return { url: url.href }
    } catch {
      return { error: 'unrecognized' }
    }
  }
  if (/^file:\/\//iu.test(value)) {
    try { return { file: fileURLToPath(value) } } catch { return { error: 'unrecognized' } }
  }
  const expanded = expandHomePath(value)
  if (isAbsolute(expanded)) return { file: expanded }
  return { error: 'unrecognized' }
}

/** A stable id for a user catalog, so adding the same thing twice is one entry. */
export function userCatalogId(entry: { url?: string; file?: string }): string {
  return `user-${digestOf(entry.url ?? entry.file ?? '').slice(0, 8)}`
}

/** Read a candidate once, for the add box: the count on success, the reason on failure. */
export async function probeCatalog(
  entry: { url?: string; file?: string }, env: NodeJS.ProcessEnv = process.env,
): Promise<ExtraResult> {
  const id = userCatalogId(entry)
  return await loadExtra({
    id, kind: 'user', label: fallbackLabel(entry), ...entry, headers: {},
  }, { fresh: true, env })
}

/** The shape the id of a saved catalog must have; stored state is untrusted. */
export function validUserCatalog(value: unknown): UserCatalog | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const url = typeof raw.url === 'string' ? parseCatalogInput(raw.url) : null
  const file = typeof raw.file === 'string' && isAbsolute(raw.file) ? raw.file : null
  if ((url === null) === (file === null)) return null
  const where = url !== null ? ('url' in url ? { url: url.url } : null) : { file: file! }
  if (where === null) return null
  const id = userCatalogId(where)
  if (!CATALOG_ID_RE.test(id) || id === PUBLIC_SOURCE_ID) return null
  return { id, ...where }
}
