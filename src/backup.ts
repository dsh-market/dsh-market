/**
 * Portable profile backups: configuration only, never installed packages.
 *
 * The profile directory is plain user data — aside from package.json it can
 * hold API keys (config.toml), tokens, or the WebDAV password when stored
 * server-side. Backups therefore behave like `dsh export` and carry the same
 * credential-warning disclaimer in the UI (review #63).
 */

import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { profileDir } from './profile.ts'

export const BACKUP_FORMAT = 'dsh-profile-backup'
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024
const MAX_FILES = 256
const SKIP_NAMES = new Set(['node_modules', '.dsh-market', '.git', 'pnpm-lock.yaml'])
/** File names that routinely contain credentials (backup exports).
 *  Values are never masked in place — the export is one-to-one for
 *  faithful restores — but presence is surfaced by the UI warning. */
export const SECRET_FILE_HINTS = /(^|\/)(config\.toml|\.env(\.\w+)?|secrets?\.\w+t?j?s?o?n|pnpm-workspace\.yaml)$/i

/** Count of exported files whose names look like they carry credentials. */
export function secretFileCount(profile: string): number {
  let count = 0
  for (const path of profileFiles(profileDir(profile))) {
    if (SECRET_FILE_HINTS.test(path)) count += 1
  }
  return count
}

export interface ProfileBackup {
  format: typeof BACKUP_FORMAT
  version: 1
  createdAt: string
  profile: string
  files: Record<string, string>
}

function profileFiles(root: string, dir = root): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name) || /\.bak-\d+$/.test(entry.name)) continue
    const path = resolve(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) files.push(...profileFiles(root, path))
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'))
    if (files.length > MAX_FILES) throw new Error(`profile has more than ${MAX_FILES} configuration files`)
  }
  return files
}

/** Serialize every profile file except dependencies, lock state, and market cache. */
export function createProfileBackup(profile: string): ProfileBackup {
  const root = profileDir(profile)
  const files: Record<string, string> = {}
  for (const path of profileFiles(root).sort()) files[path] = readFileSync(resolve(root, path)).toString('base64')
  if (files['package.json'] === undefined) throw new Error('profile package.json is missing')
  const backup: ProfileBackup = { format: BACKUP_FORMAT, version: 1, createdAt: new Date().toISOString(), profile, files }
  if (Buffer.byteLength(JSON.stringify(backup)) > MAX_BACKUP_BYTES) throw new Error('profile configuration is too large to back up')
  return backup
}

function validatedBackup(value: unknown): ProfileBackup {
  if (value === null || typeof value !== 'object') throw new Error('invalid backup')
  const backup = value as Partial<ProfileBackup>
  if (backup.format !== BACKUP_FORMAT || backup.version !== 1 || backup.files === null || typeof backup.files !== 'object') {
    throw new Error('unsupported backup format')
  }
  if (Object.keys(backup.files).length > MAX_FILES || backup.files['package.json'] === undefined) throw new Error('invalid backup contents')
  for (const [path, content] of Object.entries(backup.files)) {
    if (path === '' || isAbsolute(path) || path.split(/[\\/]/).includes('..') || typeof content !== 'string') throw new Error(`unsafe backup path: ${path}`)
    const normalized = path.replaceAll('\\', '/')
    if (normalized.split('/').some(part => SKIP_NAMES.has(part))) throw new Error(`excluded backup path: ${path}`)
    const bytes = Buffer.from(content, 'base64')
    if (bytes.toString('base64') !== content) throw new Error(`invalid file encoding: ${path}`)
  }
  try { JSON.parse(Buffer.from(backup.files['package.json'], 'base64').toString('utf8')) } catch { throw new Error('backup package.json is invalid') }
  if (Buffer.byteLength(JSON.stringify(backup)) > MAX_BACKUP_BYTES) throw new Error('backup is too large')
  return backup as ProfileBackup
}

/** Atomically overwrite backed-up files and return a rollback for install failure. */
export function restoreProfileBackup(profile: string, value: unknown): { files: number; rollback(): void } {
  const backup = validatedBackup(value)
  const root = profileDir(profile)
  const previous = new Map<string, Buffer | null>()
  mkdirSync(root, { recursive: true })
  const rollback = (): void => {
    for (const [target, content] of previous) {
      if (content === null) rmSync(target, { force: true })
      else writeFileSync(target, content)
    }
  }
  try {
    for (const [path, content] of Object.entries(backup.files)) {
      const target = resolve(root, path)
      if (!target.startsWith(root + sep)) throw new Error(`unsafe backup path: ${path}`)
      if (existsSync(target) && !lstatSync(target).isFile()) throw new Error(`backup path is not a file: ${path}`)
      previous.set(target, existsSync(target) ? readFileSync(target) : null)
      mkdirSync(dirname(target), { recursive: true })
      const temp = `${target}.dsh-restore-${String(process.pid)}`
      writeFileSync(temp, Buffer.from(content, 'base64'))
      renameSync(temp, target)
    }
  } catch (error) {
    rollback()
    throw error
  }
  return {
    files: previous.size,
    rollback,
  }
}

function webdavRequest(url: string, username: string, password: string, init: RequestInit): Promise<Response> {
  const parsed = new URL(url)
  // SSRF hardening (review #63): https-only by default, and always refuse
  // private/link-local targets — so a same-origin script cannot tunnel into
  // the host network. Besides the obvious metadata surfaces (169.254.169.254),
  // loopback matters because other services on this machine may expose HTTP
  // APIs of their own.
  if (parsed.protocol === 'http:') throw new Error('WebDAV requires an https:// URL')
  if (parsed.protocol !== 'https:') throw new Error('invalid WebDAV URL')
  if (!isPublicTarget(parsed.hostname)) throw new Error('invalid WebDAV URL')
  if (parsed.username !== '' || parsed.password !== '') throw new Error('invalid WebDAV URL')
  const headers = new Headers(init.headers)
  if (username !== '') headers.set('authorization', `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`)
  return fetch(parsed, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(30_000) })
}

export async function uploadWebdav(url: string, username: string, password: string, backup: ProfileBackup): Promise<void> {
  const response = await webdavRequest(url, username, password, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(backup),
  })
  if (!response.ok) throw new Error(`WebDAV upload failed: HTTP ${response.status}`)
}

const blockedNetworkPrefixes: Record<string, string[]> = {
  '10.': ['10.'],
  '172.16.': ['172.16.', '172.17.', '172.18.', '172.19.', '172.2', '172.30.', '172.31.'],
  '192.168.': ['192.168.'],
  '169.254.': ['169.254.'],
  '127.0.0.': ['127.0.0.'],
  '0.0.0.0': ['0.0.0.0'],
}

function blockedIpv4(ip: string, octets: string[]): boolean {
  return octets.some(range => ip.startsWith(range))
}

/** Refuse loopback, RFC1918, and link-local IPv4 targets (SSRF review #63). */
export function isPublicIpv4(ip: string): boolean {
  const octets = ip.split('.')
  if (octets.length !== 4 || octets.some(part => part === '' || !/^\d{1,3}$/.test(part))) return false
  const prefixes = blockedNetworkPrefixes[`${octets[0]}.`] ?? blockedNetworkPrefixes[`${octets[0]}.${octets[1]}.`] ?? blockedNetworkPrefixes[`${octets[0]}.${octets[1]}.${octets[2]}.`]
  return prefixes === undefined || !blockedIpv4(ip, prefixes)
}

/** Only public internet target hostnames are reachable for WebDAV. */
export function isPublicHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  const bare = lower.endsWith('.') ? lower.slice(0, -1) : lower
  return bare !== 'localhost' && bare !== 'metadata.google.internal' && !bare.endsWith('.localhost') && !bare.endsWith('.internal')
}

/**
 * Whether a WebDAV hostname may be fetched: public https targets only.
 * Exported for tests.
 */
export function isPublicTarget(hostname: string): boolean {
  if (isPublicHostname(hostname)) return true
  const ipv6 = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
  try {
    return ipv6.includes(':') ? !isPrivateIpv6(ipv6) : isPublicIpv4(hostname)
  } catch {
    return false
  }
}

function isPrivateIpv6(ip: string): boolean {
  return ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe8') || ip.startsWith('fe9')
    || ip.startsWith('fea') || ip.startsWith('feb') || ip.startsWith('::') || ip.startsWith('0:') || ip.startsWith('::1')
}

export async function downloadWebdav(url: string, username: string, password: string): Promise<unknown> {
  const response = await webdavRequest(url, username, password, { method: 'GET' })
  if (!response.ok) throw new Error(`WebDAV download failed: HTTP ${response.status}`)
  if (Number(response.headers.get('content-length')) > MAX_BACKUP_BYTES) throw new Error('WebDAV backup is too large')
  if (response.body === null) throw new Error('WebDAV returned an empty response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BACKUP_BYTES) {
      await reader.cancel()
      throw new Error('WebDAV backup is too large')
    }
    chunks.push(value)
  }
  // Validate strictly server-side so the fetch result is never a generic
  // echo of an internal response: restore only accepts real backups.
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  validatedBackup(body)
  return body
}
