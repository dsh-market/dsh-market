/**
 * The organization policy file: admin-owned, read-only, never written here.
 *
 * Where it lives, first found wins:
 *   1. `DSH_MARKET_POLICY` (an absolute path)
 *   2. macOS / Linux `/etc/dsh-market/policy.json`;
 *      Windows `%ProgramData%\dsh-market\policy.json`
 *   3. `<DSH_HOME>/dsh-market/policy.json`
 *
 * "Employees cannot change it" comes from file permissions on 1 and 2 (a file
 * only an administrator can write). Location 3 sits in the user's own home, so
 * it is for single-user setups and enforces nothing against the user.
 *
 * Every field is optional and an absent file means "no policy": the
 * permissive {@link NO_POLICY}, which is what keeps the market exactly as it
 * was for everyone who configures nothing.
 *
 * Adding a field later (pins, telemetry, comments, externalImages) is one
 * entry in {@link readPolicyFields} and one property on {@link Policy}; the
 * location, caching and failure handling below do not change.
 *
 * ## A policy that cannot be read
 *
 * An unreadable file must not quietly turn into "no policy": an administrator
 * who wrote one expects it to hold. So a file that exists but is not valid
 * JSON applies `allow: []` — browsing keeps working, installing is refused —
 * and says so in {@link Policy.problems} so the settings list can show it.
 * A single bad field is ignored on its own and reported; only `allow` fails
 * closed, since a malformed allowlist read as "no allowlist" is the unsafe
 * direction.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { resolveDshHome } from './home-paths.ts'

/** Text for the languages the market ships, with a fallback for the rest. */
export type LocalizedLabel = Record<string, string>

/** One catalog the policy adds. Headers hold secrets: never log or send them anywhere. */
export interface PolicyCatalog {
  id: string
  label: LocalizedLabel
  url?: string
  file?: string
  /** Raw, `${ENV}` still unexpanded; expand at request time with {@link expandEnv}. */
  headers: Record<string, string>
}

export interface PolicyMirrors {
  catalog?: string
  npm?: string
  githubProxy?: string
}

export interface Policy {
  /** The file this came from, or null when there is no policy. */
  path: string | null
  catalogs: PolicyCatalog[]
  publicCatalog: boolean
  userCatalogs: boolean
  /** Glob list (`*` only); null means "anything that is listed". */
  allow: string[] | null
  mirrors: PolicyMirrors
  /** Plain-language problems with the file, for the settings list. */
  problems: PolicyProblem[]
}

/** One problem, said in both languages the file's administrator might read. */
export interface PolicyProblem { zh: string; en: string }

/** Split the `中文 / English` form the messages below are written in. */
function bilingual(text: string): PolicyProblem {
  const at = text.indexOf(' / ')
  return at < 0 ? { zh: text, en: text } : { zh: text.slice(0, at), en: text.slice(at + 3) }
}

export const NO_POLICY: Policy = Object.freeze({
  path: null,
  catalogs: [],
  publicCatalog: true,
  userCatalogs: true,
  allow: null,
  mirrors: {},
  problems: [],
}) as Policy

export const CATALOG_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
/** The public catalog's own id: reserved, so a private source can never pose as it. */
export const PUBLIC_SOURCE_ID = 'public'

/** Candidate policy files in precedence order. */
export function policyLocations(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = resolveDshHome(),
): string[] {
  const out: string[] = []
  const explicit = env.DSH_MARKET_POLICY?.trim()
  if (explicit !== undefined && explicit !== '') out.push(explicit)
  if (platform === 'win32') {
    const programData = env.ProgramData?.trim()
    if (programData !== undefined && programData !== '') out.push(join(programData, 'dsh-market', 'policy.json'))
  } else {
    out.push('/etc/dsh-market/policy.json')
  }
  out.push(join(home, 'dsh-market', 'policy.json'))
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A label is a string or a per-language object; anything else is no label. */
export function asLabel(value: unknown): LocalizedLabel | null {
  if (typeof value === 'string' && value.trim() !== '') {
    const text = value.trim().slice(0, 60)
    return { zh: text, en: text }
  }
  if (!isRecord(value)) return null
  const out: LocalizedLabel = {}
  for (const [lang, text] of Object.entries(value)) {
    if (typeof text === 'string' && text.trim() !== '') out[lang] = text.trim().slice(0, 60)
  }
  return Object.keys(out).length > 0 ? out : null
}

/** The label to show for a language: that language, then English, then anything. */
export function pickLabel(label: LocalizedLabel, lang: string): string {
  return label[lang] ?? label.en ?? label.zh ?? Object.values(label)[0] ?? ''
}

function asHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

function readCatalogs(value: unknown, problems: string[]): PolicyCatalog[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    problems.push('"catalogs" 不是列表，已忽略 / "catalogs" is not a list and was ignored')
    return []
  }
  const out: PolicyCatalog[] = []
  const seen = new Set<string>([PUBLIC_SOURCE_ID])
  for (const [index, raw] of value.entries()) {
    const where = `catalogs[${String(index)}]`
    if (!isRecord(raw)) { problems.push(`${where} 不是对象，已忽略 / ${where} is not an object and was ignored`); continue }
    const id = typeof raw.id === 'string' ? raw.id : ''
    if (!CATALOG_ID_RE.test(id) || seen.has(id)) {
      problems.push(`${where} 的 id 不合法或重复，已忽略 / ${where} has an invalid or duplicate id and was ignored`)
      continue
    }
    const url = raw.url === undefined ? undefined : asHttpUrl(raw.url)
    const file = typeof raw.file === 'string' && isAbsolute(raw.file) ? raw.file : undefined
    if ((url === undefined) === (file === undefined) || url === null) {
      problems.push(`${where}（${id}）需要一个 url 或一个绝对路径的 file，已忽略 / ${where} (${id}) needs either a url or an absolute file path and was ignored`)
      continue
    }
    const headers: Record<string, string> = {}
    if (isRecord(raw.headers)) {
      for (const [name, text] of Object.entries(raw.headers)) {
        if (/^[A-Za-z0-9-]+$/u.test(name) && typeof text === 'string') headers[name] = text
      }
    }
    seen.add(id)
    out.push({
      id,
      label: asLabel(raw.label) ?? { zh: id, en: id },
      ...(url !== undefined ? { url } : {}),
      ...(file !== undefined ? { file } : {}),
      headers,
    })
  }
  return out
}

function readAllow(value: unknown, problems: string[]): string[] | null {
  if (value === undefined) return null
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    // The unsafe reading of a broken allowlist is "no allowlist".
    problems.push('"allow" 不是文字列表，现在不能安装任何插件 / "allow" is not a list of strings, so nothing can be installed right now')
    return []
  }
  return (value as string[]).map(item => item.trim()).filter(item => item !== '')
}

function readMirrors(value: unknown, problems: string[]): PolicyMirrors {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    problems.push('"mirrors" 不是对象，已忽略 / "mirrors" is not an object and was ignored')
    return {}
  }
  const out: PolicyMirrors = {}
  for (const key of ['catalog', 'npm', 'githubProxy'] as const) {
    const raw = value[key]
    if (raw === undefined) continue
    const url = asHttpUrl(raw)
    if (url === null) {
      problems.push(`mirrors.${key} 不是有效的网址，已忽略 / mirrors.${key} is not a valid URL and was ignored`)
      continue
    }
    out[key] = url.replace(/\/+$/u, '')
  }
  return out
}

/** Interpret a parsed policy document. Pure. */
export function readPolicyFields(doc: unknown, path: string): Policy {
  if (!isRecord(doc)) {
    return { ...NO_POLICY, path, allow: [], problems: [bilingual('策略文件的内容不是一个 JSON 对象，现在不能安装任何插件 / The policy file is not a JSON object, so nothing can be installed right now')] }
  }
  const problems: string[] = []
  const flag = (key: string): boolean => {
    const raw = doc[key]
    if (raw === undefined || typeof raw === 'boolean') return raw !== false
    problems.push(`"${key}" 应该是 true 或 false，已忽略 / "${key}" should be true or false and was ignored`)
    return true
  }
  return {
    path,
    catalogs: readCatalogs(doc.catalogs, problems),
    publicCatalog: flag('publicCatalog'),
    userCatalogs: flag('userCatalogs'),
    allow: readAllow(doc.allow, problems),
    mirrors: readMirrors(doc.mirrors, problems),
    problems: problems.map(bilingual),
  }
}

/** Read the first policy file that exists. Pure apart from the file reads. */
export function loadPolicy(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = resolveDshHome(),
): Policy {
  const path = policyLocations(env, platform, home).find(candidate => existsSync(candidate))
  if (path === undefined) return NO_POLICY
  try {
    return readPolicyFields(JSON.parse(readFileSync(path, 'utf8')) as unknown, path)
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return {
      ...NO_POLICY,
      path,
      allow: [],
      problems: [{
        zh: `策略文件 ${path} 读不了：${why.slice(0, 160)}。出于安全，现在不能安装任何插件，浏览不受影响。请联系管理员修好这个文件。`,
        en: `The policy file ${path} could not be read: ${why.slice(0, 160)}. For safety nothing can be installed right now; browsing still works. Ask your administrator to fix this file.`,
      }],
    }
  }
}

const RECHECK_MS = 2_000
let cached: { at: number; key: string; where: string; policy: Policy } | null = null

/**
 * The policy in force, re-read when the file changes. A stat per couple of
 * seconds rather than per request: the callers sit on hot paths (every
 * outbound request asks for the mirrors).
 */
export function getPolicy(env: NodeJS.ProcessEnv = process.env, now: number = performance.now()): Policy {
  const home = resolveDshHome(undefined, env)
  const candidates = policyLocations(env, process.platform, home)
  const where = candidates.join('|')
  if (cached !== null && cached.where === where && now - cached.at < RECHECK_MS) return cached.policy
  const stamp = candidates.map(candidate => {
    try {
      const info = statSync(candidate)
      return `${candidate}:${String(info.mtimeMs)}:${String(info.size)}`
    } catch {
      return `${candidate}:-`
    }
  }).join('|')
  if (cached !== null && cached.key === stamp) {
    cached = { ...cached, at: now, where }
    return cached.policy
  }
  const policy = loadPolicy(env, process.platform, home)
  cached = { at: now, key: stamp, where, policy }
  return policy
}

/** Forget the cached policy (tests, and after a deliberate re-read). */
export function resetPolicyCache(): void {
  cached = null
}

/**
 * Expand `${NAME}` from the environment, the way npm does. Names with no value
 * are reported rather than silently becoming empty, so the caller can say
 * which variable is missing instead of sending a half-made credential.
 */
export function expandEnv(text: string, env: NodeJS.ProcessEnv = process.env): { value: string; missing: string[] } {
  const missing: string[] = []
  const value = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, name: string) => {
    const found = env[name]
    if (found === undefined || found === '') {
      if (!missing.includes(name)) missing.push(name)
      return ''
    }
    return found
  })
  return { value, missing }
}

/** Glob match with `*` only, case-insensitive (npm names are lowercase). */
export function globMatch(pattern: string, text: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`)).join('.*')}$`, 'iu')
  return re.test(text)
}
