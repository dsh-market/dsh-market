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
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
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
export function secretFileCount(profile: string, explicitDir?: string): number {
  let count = 0
  for (const path of profileFiles(explicitDir ?? profileDir(profile))) {
    if (SECRET_FILE_HINTS.test(path)) count += 1
  }
  return count
}

export type BackupFile =
  | { path: 'package.json'; json: Record<string, unknown> }
  | { path: string; lines: string[] }

export interface ProfileBackup {
  format: typeof BACKUP_FORMAT
  version: 0.2
  createdAt: string
  profile: string
  files: BackupFile[]
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
export function createProfileBackup(profile: string, explicitDir?: string): ProfileBackup {
  const root = resolve(explicitDir ?? profileDir(profile))
  const files: BackupFile[] = profileFiles(root).sort().map((path) => {
    const content = readFileSync(resolve(root, path), 'utf8')
    return path === 'package.json'
      ? { path, json: JSON.parse(content) as Record<string, unknown> }
      : { path, lines: content.split(/\r?\n/) }
  })
  if (!files.some(file => file.path === 'package.json')) throw new Error('profile package.json is missing')
  const backup: ProfileBackup = { format: BACKUP_FORMAT, version: 0.2, createdAt: new Date().toISOString(), profile, files }
  if (Buffer.byteLength(JSON.stringify(backup)) > MAX_BACKUP_BYTES) throw new Error('profile configuration is too large to back up')
  return backup
}

function validatedBackup(value: unknown): ProfileBackup {
  if (value === null || typeof value !== 'object') throw new Error('invalid backup')
  const backup = value as Partial<ProfileBackup>
  if (backup.format !== BACKUP_FORMAT || backup.version !== 0.2 || !Array.isArray(backup.files)) {
    throw new Error('unsupported backup format')
  }
  if (backup.files.length > MAX_FILES) throw new Error('invalid backup contents')
  const files: BackupFile[] = []
  const paths = new Set<string>()
  for (const value of backup.files as unknown[]) {
    if (value === null || typeof value !== 'object') throw new Error('invalid backup contents')
    const file = value as { path?: unknown; json?: unknown; lines?: unknown }
    const path = file.path
    if (typeof path !== 'string') throw new Error('invalid backup contents')
    if (path === '' || isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error(`unsafe backup path: ${path}`)
    const normalized = path.replaceAll('\\', '/')
    if (normalized.split('/').some(part => SKIP_NAMES.has(part))) throw new Error(`excluded backup path: ${path}`)
    if (paths.has(normalized)) throw new Error(`duplicate backup path: ${path}`)
    paths.add(normalized)
    if (path === 'package.json') {
      if (file.json === null || typeof file.json !== 'object' || Array.isArray(file.json)) throw new Error('backup package.json is invalid')
      files.push({ path, json: file.json as Record<string, unknown> })
    } else {
      if (!Array.isArray(file.lines) || !file.lines.every(line => typeof line === 'string')) throw new Error(`invalid file content: ${path}`)
      files.push({ path, lines: file.lines as string[] })
    }
  }
  if (!files.some(file => file.path === 'package.json')) throw new Error('invalid backup contents')
  if (Buffer.byteLength(JSON.stringify(backup)) > MAX_BACKUP_BYTES) throw new Error('backup is too large')
  return { ...backup, files } as ProfileBackup
}

/** Atomically overwrite backed-up files and return a rollback for install failure. */
export function restoreProfileBackup(profile: string, value: unknown, explicitDir?: string): { files: number; rollback(): void } {
  const backup = validatedBackup(value)
  const root = resolve(explicitDir ?? profileDir(profile))
  const previous = new Map<string, Buffer | null>()
  mkdirSync(root, { recursive: true })
  const rollback = (): void => {
    for (const [target, content] of previous) {
      if (content === null) rmSync(target, { force: true })
      else writeFileSync(target, content)
    }
  }
  try {
    for (const file of backup.files) {
      const { path } = file
      const target = resolve(root, path)
      if (!target.startsWith(root + sep)) throw new Error(`unsafe backup path: ${path}`)
      ensureSafeParent(root, dirname(target), path)
      if (existsSync(target) && !lstatSync(target).isFile()) throw new Error(`backup path is not a file: ${path}`)
      previous.set(target, existsSync(target) ? readFileSync(target) : null)
      const temp = `${target}.dsh-restore-${String(process.pid)}`
      writeFileSync(temp, 'json' in file ? `${JSON.stringify(file.json, null, 2)}\n` : file.lines.join('\n'), 'utf8')
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

/** Create missing parents one level at a time and refuse existing symlinks. */
function ensureSafeParent(root: string, parent: string, backupPath: string): void {
  const relativeParent = relative(root, parent)
  if (relativeParent === '') return
  let current = root
  for (const part of relativeParent.split(sep)) {
    current = resolve(current, part)
    if (!existsSync(current)) {
      mkdirSync(current)
      continue
    }
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe backup path: ${backupPath}`)
  }
}

interface PublicAddress {
  address: string
  family: 4 | 6
}

interface WebdavResponse {
  status: number
  body: Buffer
}

async function webdavRequest(
  url: string,
  username: string,
  password: string,
  method: 'GET' | 'PUT',
  body?: string,
): Promise<WebdavResponse> {
  const parsed = new URL(url)
  // SSRF hardening (review #63): https-only by default, and always refuse
  // private/link-local targets — so a same-origin script cannot tunnel into
  // the host network. Besides the obvious metadata surfaces (169.254.169.254),
  // loopback matters because other services on this machine may expose HTTP
  // APIs of their own.
  if (parsed.protocol === 'http:') throw new Error('WebDAV requires an https:// URL')
  if (parsed.protocol !== 'https:') throw new Error('invalid WebDAV URL')
  if (parsed.username !== '' || parsed.password !== '') throw new Error('invalid WebDAV URL')
  const address = await resolvePublicAddress(parsed.hostname)
  const headers: Record<string, string> = { host: parsed.host }
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(Buffer.byteLength(body))
  }
  if (username !== '') headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`

  // Connect to the address that was checked above instead of resolving the
  // hostname a second time. This closes the DNS-rebinding window between the
  // allow/deny decision and the actual socket connection.
  return await new Promise<WebdavResponse>((resolveRequest, reject) => {
    const originalHostname = unbracketedHostname(parsed.hostname)
    const request = httpsRequest({
      protocol: 'https:',
      hostname: address.address,
      family: address.family,
      port: parsed.port === '' ? 443 : Number(parsed.port),
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers,
      servername: isIP(originalHostname) === 0 ? originalHostname : undefined,
      signal: AbortSignal.timeout(30_000),
    }, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      const maxBytes = method === 'GET' ? MAX_BACKUP_BYTES : 64 * 1024
      response.once('error', reject)
      const declared = Number(response.headers['content-length'])
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.destroy(new Error('WebDAV response is too large'))
        return
      }
      response.on('data', (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += value.byteLength
        if (size > maxBytes) {
          response.destroy(new Error('WebDAV response is too large'))
          return
        }
        chunks.push(value)
      })
      response.once('end', () => resolveRequest({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }))
    })
    request.once('error', reject)
    request.end(body)
  })
}

export async function uploadWebdav(url: string, username: string, password: string, backup: ProfileBackup): Promise<void> {
  const response = await webdavRequest(url, username, password, 'PUT', JSON.stringify(backup))
  if (response.status < 200 || response.status >= 300) throw new Error(`WebDAV upload failed: HTTP ${response.status}`)
}

/** Refuse non-global IPv4 targets, including metadata and carrier NAT ranges. */
export function isPublicIpv4(ip: string): boolean {
  const octets = ip.split('.').map(Number)
  if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = octets
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && (b === 0 || b === 168)) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  return true
}

/** Only public internet target hostnames are reachable for WebDAV. */
export function isPublicHostname(hostname: string): boolean {
  const lower = unbracketedHostname(hostname).toLowerCase()
  const bare = lower.endsWith('.') ? lower.slice(0, -1) : lower
  return bare !== '' && bare !== 'localhost' && bare !== 'metadata.google.internal'
    && !bare.endsWith('.localhost') && !bare.endsWith('.internal') && !bare.endsWith('.local')
}

/**
 * Whether a WebDAV hostname may be fetched: public https targets only.
 * Exported for tests.
 */
export function isPublicTarget(hostname: string): boolean {
  const bare = unbracketedHostname(hostname)
  const family = isIP(bare)
  if (family === 4) return isPublicIpv4(bare)
  if (family === 6) return isPublicIpv6(bare)
  return isPublicHostname(bare)
}

/** Only global-unicast IPv6 is usable for a server-side WebDAV connection. */
export function isPublicIpv6(ip: string): boolean {
  const bare = unbracketedHostname(ip)
  if (isIP(bare) !== 6) return false
  const first = Number.parseInt(bare.split(':', 1)[0] || '0', 16)
  return Number.isFinite(first) && first >= 0x2000 && first <= 0x3fff
}

function unbracketedHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/** Resolve once, reject every unsafe answer, and return the address to pin. */
export async function resolvePublicAddress(hostname: string): Promise<PublicAddress> {
  const bare = unbracketedHostname(hostname)
  const family = isIP(bare)
  if (family === 4 || family === 6) {
    if (!isPublicTarget(bare)) throw new Error('invalid WebDAV URL')
    return { address: bare, family }
  }
  if (!isPublicHostname(bare)) throw new Error('invalid WebDAV URL')
  const addresses = await lookup(bare, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicTarget(address))) {
    throw new Error('invalid WebDAV URL')
  }
  const selected = addresses[0]
  if (selected.family !== 4 && selected.family !== 6) throw new Error('invalid WebDAV URL')
  return { address: selected.address, family: selected.family }
}

export async function downloadWebdav(url: string, username: string, password: string): Promise<unknown> {
  const response = await webdavRequest(url, username, password, 'GET')
  if (response.status < 200 || response.status >= 300) throw new Error(`WebDAV download failed: HTTP ${response.status}`)
  // Validate strictly server-side so the fetch result is never a generic
  // echo of an internal response: restore only accepts real backups.
  const body = JSON.parse(response.body.toString('utf8')) as unknown
  validatedBackup(body)
  return body
}
