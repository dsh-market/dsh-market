/**
 * Private npm registries, read from the same `.npmrc` files pnpm reads.
 *
 * pnpm already handles installs: it reads the profile's `.npmrc` and
 * `~/.npmrc` itself, so nothing here touches how a package is installed. What
 * pnpm cannot do is answer the market's OWN requests — update checks,
 * versions, changelog, release age, compatibility — and those used to go to
 * the download region's registry for every package. For `@acme/plugin` with
 * `@acme:registry=https://npm.acme.internal/` in an `.npmrc`, that meant
 * asking the public registry about a package it has never heard of.
 *
 * Two small rules fix that, and nothing else changes:
 *
 * - {@link registryFor}: a scoped package goes to its scope's registry; every
 *   other package keeps the registry the market was already using.
 * - {@link authorizationFor}: a request to a registry that an `.npmrc` routes
 *   a scope to carries the credential the `.npmrc` holds for it.
 *
 * Precedence is the profile's `.npmrc` over `~/.npmrc`, per key.
 *
 * The unscoped `registry=` line is read from the PROFILE's `.npmrc` only. A
 * profile `.npmrc` is deliberate configuration for that profile (a company
 * registry for everything), so the market asks the same registry pnpm
 * installs from. `~/.npmrc` is not read for it: it is the user's own file,
 * shared with every other tool, and the market's default route stays the
 * download region's. An administrator's policy `mirrors.npm` outranks both.
 *
 * Credentials are attached only to registries the profile configuration
 * routes to (a scope, or that profile default), so a publish token for
 * registry.npmjs.org in `~/.npmrc` is never sent by the market just because
 * it exists.
 *
 * A credential never leaves this module except as the header value handed to
 * {@link marketFetch}; nothing here logs one.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getPolicy } from './policy.ts'

interface Credential {
  /** Value for the Authorization header. */
  header: string
}

export interface NpmrcConfig {
  /** `@scope` -> registry base URL, no trailing slash. */
  scopes: Map<string, string>
  /** The unscoped `registry=`, no trailing slash; only meaningful from the profile's file. */
  defaultRegistry?: string
  /** Nerf-darted registry (`//host/path/`) -> credential. */
  credentials: Map<string, Credential>
  /** Variables a credential line referenced that are not set — names only. */
  missingEnv: string[]
}

/** `//host[:port]/path/` form npm keys credentials by. */
export function nerfDart(url: string): string | null {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`
    return `//${parsed.host}${path}`
  } catch {
    return null
  }
}

function unquote(value: string): string {
  const text = value.trim()
  if (text.length >= 2 && (text.startsWith('"') && text.endsWith('"') || text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * Parse one `.npmrc`. Lines are `key=value`; `;` and `#` start a comment line.
 * `${NAME}` is expanded from `env`, as npm does; a line that needs a variable
 * that is not set is dropped (and the name reported) rather than becoming an
 * empty, wrong credential.
 */
export function parseNpmrc(text: string, env: NodeJS.ProcessEnv = process.env): NpmrcConfig {
  const scopes = new Map<string, string>()
  let defaultRegistry: string | undefined
  const missingEnv: string[] = []
  const raw = new Map<string, string>()
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith(';') || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    const key = trimmed.slice(0, at).trim()
    let value = unquote(trimmed.slice(at + 1))
    let dropped = false
    value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, name: string) => {
      const found = env[name]
      if (found === undefined || found === '') {
        dropped = true
        if (!missingEnv.includes(name)) missingEnv.push(name)
        return ''
      }
      return found
    })
    if (dropped) continue
    raw.set(key, value)
  }
  const authByRegistry = new Map<string, { token?: string; basic?: string; user?: string; password?: string }>()
  const slot = (registry: string) => {
    const existing = authByRegistry.get(registry)
    if (existing !== undefined) return existing
    const created = {}
    authByRegistry.set(registry, created)
    return created as { token?: string; basic?: string; user?: string; password?: string }
  }
  for (const [key, value] of raw) {
    if (key === 'registry') {
      try {
        const url = new URL(value)
        if (url.protocol === 'https:' || url.protocol === 'http:') defaultRegistry = url.href.replace(/\/+$/u, '')
      } catch { /* not a URL: pnpm will say so */ }
      continue
    }
    const scope = /^(@[A-Za-z0-9._~-]+):registry$/u.exec(key)
    if (scope !== null) {
      try {
        const url = new URL(value)
        if (url.protocol === 'https:' || url.protocol === 'http:') scopes.set(scope[1]!.toLowerCase(), url.href.replace(/\/+$/u, ''))
      } catch { /* not a URL: ignore the line, as npm would fail it later */ }
      continue
    }
    if (!key.startsWith('//')) continue
    const colon = key.lastIndexOf(':')
    const field = key.slice(colon + 1)
    if (!['_authToken', '_auth', 'username', '_password'].includes(field)) continue
    const base = key.slice(0, colon)
    const entry = slot(base.endsWith('/') ? base : `${base}/`)
    if (field === '_authToken') entry.token = value
    else if (field === '_auth') entry.basic = value
    else if (field === 'username') entry.user = value
    else entry.password = value
  }
  const credentials = new Map<string, Credential>()
  for (const [registry, entry] of authByRegistry) {
    if (entry.token !== undefined && entry.token !== '') credentials.set(registry, { header: `Bearer ${entry.token}` })
    else if (entry.basic !== undefined && entry.basic !== '') credentials.set(registry, { header: `Basic ${entry.basic}` })
    else if (entry.user !== undefined && entry.password !== undefined) {
      // npm stores `_password` base64-encoded; Basic wants user:password.
      const password = Buffer.from(entry.password, 'base64').toString('utf8')
      credentials.set(registry, { header: `Basic ${Buffer.from(`${entry.user}:${password}`).toString('base64')}` })
    }
  }
  return { scopes, credentials, missingEnv, ...(defaultRegistry === undefined ? {} : { defaultRegistry }) }
}

/** The per-key union, `over` winning. */
export function mergeNpmrc(base: NpmrcConfig, over: NpmrcConfig): NpmrcConfig {
  return {
    scopes: new Map([...base.scopes, ...over.scopes]),
    ...((over.defaultRegistry ?? base.defaultRegistry) === undefined ? {} : { defaultRegistry: (over.defaultRegistry ?? base.defaultRegistry)! }),
    credentials: new Map([...base.credentials, ...over.credentials]),
    missingEnv: [...new Set([...base.missingEnv, ...over.missingEnv])],
  }
}

/** The registry for one package, given a config; `fallback` for everything else. */
export function registryIn(config: NpmrcConfig, name: string, fallback: string, defaultLocked = false): string {
  if (name.startsWith('@')) {
    const scope = name.split('/')[0]!.toLowerCase()
    const own = config.scopes.get(scope)
    if (own !== undefined) return own
  }
  // The profile's own default, unless an administrator's policy fixed the registry.
  if (!defaultLocked && config.defaultRegistry !== undefined) return config.defaultRegistry
  return fallback.replace(/\/+$/u, '')
}

/**
 * The Authorization header for a URL, or null. Only registries that some scope
 * points at are eligible (see the module note), matched the way npm matches:
 * the longest nerf-darted prefix of the URL.
 */
export function authorizationIn(config: NpmrcConfig, url: string): string | null {
  if ((config.scopes.size === 0 && config.defaultRegistry === undefined) || config.credentials.size === 0) return null
  const target = nerfDart(url)
  if (target === null) return null
  const routed = new Set<string>()
  if (config.defaultRegistry !== undefined) {
    const key = nerfDart(config.defaultRegistry)
    if (key !== null) routed.add(key)
  }
  for (const registry of config.scopes.values()) {
    const key = nerfDart(registry)
    if (key !== null) routed.add(key)
  }
  let best: string | null = null
  for (const key of config.credentials.keys()) {
    if (!routed.has(key) || !target.startsWith(key)) continue
    if (best === null || key.length > best.length) best = key
  }
  return best === null ? null : config.credentials.get(best)!.header
}

let profileDir: string | null = null
/** Home override for tests; null means the real one. */
let homeOverride: string | null = null
const RECHECK_MS = 2_000
let loaded: { at: number; where: string; stamp: string; config: NpmrcConfig } | null = null

/** Tell this module which profile's `.npmrc` is the first one to read. */
export function setNpmrcProfileDir(dir: string | null): void {
  profileDir = dir
  loaded = null
}

/** Tests only. */
export function setNpmrcHome(dir: string | null): void {
  homeOverride = dir
  loaded = null
}

function npmrcFiles(env: NodeJS.ProcessEnv): string[] {
  const user = env.npm_config_userconfig?.trim() || env.NPM_CONFIG_USERCONFIG?.trim() || join(homeOverride ?? homedir(), '.npmrc')
  return [user, ...(profileDir === null ? [] : [join(profileDir, '.npmrc')])]
}

/** The merged config in force: `~/.npmrc` first, the profile's over it. */
export function currentNpmrc(env: NodeJS.ProcessEnv = process.env, now: number = performance.now()): NpmrcConfig {
  const files = npmrcFiles(env)
  const where = files.join('|')
  if (loaded !== null && loaded.where === where && now - loaded.at < RECHECK_MS) return loaded.config
  const stamp = files.map(file => {
    try {
      const info = statSync(file)
      return `${file}:${String(info.mtimeMs)}:${String(info.size)}`
    } catch { return `${file}:-` }
  }).join('|')
  if (loaded !== null && loaded.where === where && loaded.stamp === stamp) {
    loaded = { ...loaded, at: now }
    return loaded.config
  }
  let config: NpmrcConfig = { scopes: new Map(), credentials: new Map(), missingEnv: [] }
  for (const [index, file] of files.entries()) {
    if (!existsSync(file)) continue
    try {
      const parsed = parseNpmrc(readFileSync(file, 'utf8'), env)
      // Only the profile's file (the one after ~/.npmrc) may name the default registry.
      if (index === 0) delete parsed.defaultRegistry
      config = mergeNpmrc(config, parsed)
    } catch { /* an unreadable .npmrc is no .npmrc; pnpm will say why */ }
  }
  loaded = { at: now, where, stamp, config }
  return config
}

/** The registry the market should ask about `name`. */
export function registryFor(name: string, fallback: string): string {
  return registryIn(currentNpmrc(), name, fallback, getPolicy().mirrors.npm !== undefined)
}

/** Authorization header for a URL on a scope-routed registry, or null. */
export function authorizationFor(url: string): string | null {
  return authorizationIn(currentNpmrc(), url)
}
