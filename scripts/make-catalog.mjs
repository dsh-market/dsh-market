#!/usr/bin/env node
/**
 * Make a plugins.json for a private catalog.
 *
 *   node scripts/make-catalog.mjs entries.json -o plugins.json
 *
 * `entries.json` is a list, or an object `{ "label": ..., "categories": ..., "plugins": [...] }`.
 * Each entry names a plugin by its npm package, by its repository, or both:
 *
 *   { "npm": "@acme/dsh-notify", "category": "tools" }
 *   { "npm": "dsh-loop", "category": ["tools", "automation"], "description": "Loop a task" }
 *   { "repo": "https://github.com/acme/dsh-theme", "category": "themes",
 *     "description": { "zh": "公司主题", "en": "Company theme" } }
 *
 * What is missing is read from the package's own `package.json` — name,
 * description, repository — from the npm registry (`/<name>/latest`) or, for a
 * GitHub repository, from raw.githubusercontent.com. Anything you write in the
 * entry wins over what is read. Entries that cannot be completed (no name, no
 * link, no category) stop the run with the entry number; nothing is guessed.
 *
 * Options:
 *   -o, --out <file>      where to write (default: stdout)
 *   --label <text>        what the market calls this catalog (default: the
 *                         object's "label", or none)
 *   --registry <url>      npm registry for unscoped names (default: the
 *                         one in ~/.npmrc, else https://registry.npmjs.org)
 *   --offline             do not look anything up; every entry must carry
 *                         name, url and description itself
 *
 * Scoped packages use `@scope:registry=` from ~/.npmrc, and the token for that
 * registry (`//host/:_authToken=`, `${ENV}` expanded) — the same lines pnpm
 * reads. Nothing is written back and no token is printed.
 *
 * The result is the same shape as the public catalog and loads in the market's
 * Settings → Plugin catalogs, or from a policy file's `catalogs`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u

/** Minimal `.npmrc` read: scope registries and the auth for them. */
export function readNpmrc(text, env = process.env) {
  const scopes = new Map()
  const auth = new Map()
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    const key = trimmed.slice(0, at).trim()
    const value = trimmed.slice(at + 1).trim().replace(/^["']|["']$/gu, '').replace(/\$\{(\w+)\}/gu, (_m, name) => env[name] ?? '')
    const scope = /^(@[^:]+):registry$/u.exec(key)
    if (scope !== null) { scopes.set(scope[1], value.replace(/\/+$/u, '')); continue }
    if (key.endsWith(':_authToken') && key.startsWith('//')) auth.set(key.slice(0, -':_authToken'.length), `Bearer ${value}`)
  }
  return { scopes, auth }
}

function nerf(url) {
  try {
    const parsed = new URL(url)
    return `//${parsed.host}${parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`}`
  } catch {
    return ''
  }
}

function localized(value) {
  if (typeof value === 'string' && value.trim() !== '') return { zh: value.trim(), en: value.trim() }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const out = {}
    for (const [lang, text] of Object.entries(value)) if (typeof text === 'string' && text.trim() !== '') out[lang] = text.trim()
    if (Object.keys(out).length > 0) return { zh: out.zh ?? out.en, en: out.en ?? out.zh, ...out }
  }
  return null
}

/** `git+https://host/o/r.git`, `github:o/r`, `git@host:o/r.git` -> an https page, or null. */
export function repositoryUrl(value) {
  const raw = typeof value === 'string' ? value : value?.url
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  const shortcut = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(text)
  if (shortcut !== null) return `https://github.com/${shortcut[1]}/${shortcut[2]}`
  const scp = /^git@([^:]+):(.+?)(?:\.git)?$/u.exec(text)
  if (scp !== null) return `https://${scp[1]}/${scp[2]}`
  const cleaned = text.replace(/^git\+/u, '').replace(/^git:\/\//u, 'https://').replace(/^ssh:\/\/(?:git@)?/u, 'https://').replace(/#.*$/u, '').replace(/\.git$/u, '')
  return /^https?:\/\//u.test(cleaned) ? cleaned : null
}

/**
 * Build the catalog document.
 * @param input - the parsed entries file.
 * @param options - `{ fetchJson(url, headers) }` to look things up (omit with `offline`), `registry`, `npmrc`, `label`, `offline`, `today`.
 */
export async function buildCatalog(input, options = {}) {
  const doc = Array.isArray(input) ? { plugins: input } : input
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.plugins)) throw new Error('the entries file must be a list, or an object with a "plugins" list')
  const registry = (options.registry ?? 'https://registry.npmjs.org').replace(/\/+$/u, '')
  const npmrc = options.npmrc ?? { scopes: new Map(), auth: new Map() }
  const today = options.today ?? new Date().toISOString().slice(0, 10)

  const registryFor = (name) => (name.startsWith('@') ? npmrc.scopes.get(name.split('/')[0]) : undefined) ?? registry
  const lookup = async (url) => {
    if (options.offline === true || options.fetchJson === undefined) return null
    const headers = {}
    const credential = [...npmrc.auth].filter(([key]) => nerf(url).startsWith(key)).sort((a, b) => b[0].length - a[0].length)[0]
    if (credential !== undefined) headers.authorization = credential[1]
    return await options.fetchJson(url, headers)
  }

  const plugins = []
  const categories = { ...(doc.categories ?? {}) }
  for (const [index, raw] of doc.plugins.entries()) {
    const where = `entry ${String(index + 1)}`
    if (raw === null || typeof raw !== 'object') throw new Error(`${where}: not an object`)
    const npm = typeof raw.npm === 'string' && raw.npm !== '' ? raw.npm : null
    if (npm !== null && !NPM_NAME.test(npm)) throw new Error(`${where}: "${npm}" is not a valid npm package name`)
    let manifest = null
    if (npm !== null) {
      manifest = await lookup(`${registryFor(npm)}/${encodeURIComponent(npm)}/latest`).catch((error) => {
        throw new Error(`${where}: could not read ${npm} from the registry (${error.message})`)
      })
    } else if (typeof raw.repo === 'string') {
      const github = /^https:\/\/github\.com\/([^/]+\/[^/#?]+?)(?:\.git)?\/?$/u.exec(raw.repo)
      if (github !== null) manifest = await lookup(`https://raw.githubusercontent.com/${github[1]}/HEAD/package.json`).catch(() => null)
    }
    const name = (typeof raw.name === 'string' && raw.name !== '' ? raw.name : (manifest?.name ?? npm ?? ''))
    const display = name.replace(/^@[^/]+\//u, '')
    const repo = typeof raw.repo === 'string' ? raw.repo : typeof raw.url === 'string' ? raw.url : null
    const url = repo ?? repositoryUrl(manifest?.repository) ?? (npm !== null ? `${registryFor(npm)}/${npm}` : null)
    const description = localized(raw.description) ?? localized(manifest?.description)
    const category = (Array.isArray(raw.category) ? raw.category : [raw.category]).filter((id) => typeof id === 'string' && id !== '')
    if (display === '') throw new Error(`${where}: no name — give "npm", or "name"`)
    if (url === null) throw new Error(`${where} (${display}): no link — give "repo" or "url"`)
    if (description === null) throw new Error(`${where} (${display}): no description — write one, or publish the package with a description`)
    if (category.length === 0) throw new Error(`${where} (${display}): no category`)
    for (const id of category) categories[id] ??= { zh: id, en: id }
    const owner = typeof raw.owner === 'string' ? raw.owner
      : npm?.startsWith('@') ? npm.slice(1).split('/')[0]
      : (/^https?:\/\/[^/]+\/([^/]+)\//u.exec(url)?.[1] ?? '')
    plugins.push({
      name: display,
      owner,
      url,
      category: category.length === 1 ? category[0] : category,
      description,
      npm,
      install: npm ?? display,
      added: typeof raw.added === 'string' ? raw.added : today,
      ...(typeof manifest?.version === 'string' ? { version: manifest.version } : {}),
    })
  }
  const label = localized(options.label ?? doc.label)
  return {
    updated: today,
    count: plugins.length,
    ...(label === null ? {} : { label }),
    categories,
    plugins,
  }
}

function parseArgs(argv) {
  const args = { input: null, out: null, label: null, registry: null, offline: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-o' || arg === '--out') args.out = argv[++i]
    else if (arg === '--label') args.label = argv[++i]
    else if (arg === '--registry') args.registry = argv[++i]
    else if (arg === '--offline') args.offline = true
    else if (arg === '-h' || arg === '--help') args.help = true
    else if (args.input === null) args.input = arg
    else throw new Error(`unexpected argument: ${arg}`)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true || args.input === null) {
    console.log('usage: node scripts/make-catalog.mjs entries.json [-o plugins.json] [--label text] [--registry url] [--offline]')
    process.exit(args.help === true ? 0 : 2)
  }
  const npmrcPath = join(homedir(), '.npmrc')
  const npmrc = existsSync(npmrcPath) ? readNpmrc(readFileSync(npmrcPath, 'utf8')) : { scopes: new Map(), auth: new Map() }
  const fetchJson = async (url, headers) => {
    const response = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    return await response.json()
  }
  const catalog = await buildCatalog(JSON.parse(readFileSync(args.input, 'utf8')), {
    fetchJson, npmrc, offline: args.offline, ...(args.registry === null ? {} : { registry: args.registry }), ...(args.label === null ? {} : { label: args.label }),
  })
  const text = `${JSON.stringify(catalog, null, 2)}\n`
  if (args.out === null) process.stdout.write(text)
  else {
    writeFileSync(args.out, text)
    console.error(`wrote ${args.out}: ${String(catalog.count)} plugins`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`make-catalog: ${error.message}`)
    process.exit(1)
  })
}
