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
/**
 * Directories that are caches by name, wherever they sit.
 *
 * The market's own cache is `.dsh-market` (skipped above), but another
 * component writes `<profile>/cache` — not hidden, so the dot rule below let
 * it through and the whole thing was read as configuration. With a few
 * multi-megabyte json files in there the profile could not be backed up at
 * all, and the error blamed the profile's own configuration (#1064).
 *
 * Only the exporter skips these; `validatedBackup` still accepts a document
 * that carries them, because backups written before this rule put them in.
 */
const SKIP_DIRS = new Set(['cache'])
/**
 * Said when the profile does not fit: the way out has to be one that works.
 *
 * The old sentence offered "只导出选中的插件" unconditionally, but that path
 * walks the same profile once "包含配置文件" is ticked and fails with the
 * same words (#1064) — so it now names the trap as well.
 */
const EXPORT_SELECTED_ZH = '可以改成只导出选中的插件，并且别勾「包含配置文件」，那会撞同一个上限'
const EXPORT_SELECTED_EN = 'export selected plugins instead, and leave "Include config files" unticked — ticking it hits the same cap'
const BACKUP_TOO_LARGE = `这个 profile 的配置超过 ${MAX_BACKUP_BYTES / (1024 * 1024)} MB，整份备份放不下。${EXPORT_SELECTED_ZH}。 / this profile's configuration is larger than ${MAX_BACKUP_BYTES / (1024 * 1024)} MB, which is too much for one whole-profile backup; ${EXPORT_SELECTED_EN}.`
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
    // Any .bak marker, not just the numeric-suffixed one this codebase
    // writes. Recovery and the host's own repair paths leave other shapes —
    // `package.json.bak-asm`, `cordis.patch.yml.rp-merged.bak` — and a
    // backup that carried them restored them too, so the profile came back
    // with the wreckage that made it need repairing (#205 by @Rudyy898).
    if (SKIP_NAMES.has(entry.name) || /\.bak\b/.test(entry.name)) continue
    // Plugin caches live in hidden directories (`.dsh-mattskillsdeck-cache`,
    // `.plugin-manager`, …). Walking them counted megabytes of logs as
    // "configuration" and blew the 2 MB cap (#972). Hidden FILES stay —
    // `.env` and `.npmrc` are real profile config.
    if (entry.isDirectory() && entry.name.startsWith('.')) continue
    // Same rule, one name the dot check cannot cover (#1064).
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
    const path = resolve(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) files.push(...profileFiles(root, path))
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'))
    // Told in the user's words, with the way out: this is the cap a heavy
    // profile actually hits, and the per-plugin export is the answer.
    if (files.length > MAX_FILES) {
      throw new Error(`这个 profile 的配置文件超过 ${MAX_FILES} 个，整份备份放不下。${EXPORT_SELECTED_ZH}。 / this profile has more than ${MAX_FILES} configuration files, which is too many for one whole-profile backup; ${EXPORT_SELECTED_EN}.`)
    }
  }
  return files
}

/** Serialize every profile file except dependencies, lock state, and market cache. */
export interface BackupOptions {
  /** Partial export: only these plugins (dependency names) are kept. */
  includeDeps?: string[]
  /**
   * With includeDeps, also carry the profile's other configuration files.
   * Config files are profile-scoped and cannot be attributed to individual
   * plugins, so this is all-or-nothing — the UI warns about secrets before
   * enabling it (the backup itself is one-to-one, never masked).
   */
  includeConfig?: boolean
}

/**
 * Serialize every profile file except dependencies, lock state, and market
 * cache — or, with {@link BackupOptions.includeDeps}, only the manifest with
 * the selected plugins (plus, optionally, the other config files).
 */
export function createProfileBackup(profile: string, explicitDir?: string, opts?: BackupOptions): ProfileBackup {
  const root = resolve(explicitDir ?? profileDir(profile))
  const manifestFile = resolve(root, 'package.json')
  if (!existsSync(manifestFile)) throw new Error('profile package.json is missing')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>

  if (opts?.includeDeps !== undefined) {
    const include = new Set(opts.includeDeps)
    if (include.size === 0) throw new Error('no plugins selected')
    const dependencies = manifest.dependencies === null || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)
      ? {}
      : manifest.dependencies as Record<string, unknown>
    const filteredDeps: Record<string, unknown> = {}
    for (const [name, spec] of Object.entries(dependencies)) if (include.has(name)) filteredDeps[name] = spec
    const dsh = manifest.dsh === null || typeof manifest.dsh !== 'object' || Array.isArray(manifest.dsh)
      ? undefined
      : manifest.dsh as { profile?: unknown }
    const profileBlock = dsh?.profile === null || typeof dsh?.profile !== 'object' || Array.isArray(dsh?.profile)
      ? undefined
      : dsh.profile as { bundles?: unknown }
    const bundles = Array.isArray(profileBlock?.bundles) ? profileBlock.bundles as unknown[] : []
    const filteredBundles = bundles.filter((name): name is string => typeof name === 'string' && include.has(name))
    if (Object.keys(filteredDeps).length === 0 && filteredBundles.length === 0) {
      throw new Error('none of the selected plugins are in this profile')
    }
    const filteredManifest: Record<string, unknown> = { ...manifest }
    filteredManifest.dependencies = filteredDeps
    if (dsh !== undefined) {
      filteredManifest.dsh = { ...dsh, profile: { ...(profileBlock ?? {}), bundles: filteredBundles } }
    }
    const files: BackupFile[] = [{ path: 'package.json', json: filteredManifest }]
    if (opts.includeConfig === true) {
      for (const path of profileFiles(root).sort()) {
        if (path === 'package.json') continue
        files.push({ path, lines: readFileSync(resolve(root, path), 'utf8').split(/\r?\n/) })
      }
    }
    const partial: ProfileBackup = { format: BACKUP_FORMAT, version: 0.2, createdAt: new Date().toISOString(), profile, files }
    if (Buffer.byteLength(JSON.stringify(partial)) > MAX_BACKUP_BYTES) throw new Error(BACKUP_TOO_LARGE)
    return partial
  }

  const files: BackupFile[] = profileFiles(root).sort().map((path) => {
    const content = readFileSync(resolve(root, path), 'utf8')
    return path === 'package.json'
      ? { path, json: JSON.parse(content) as Record<string, unknown> }
      : { path, lines: content.split(/\r?\n/) }
  })
  if (!files.some(file => file.path === 'package.json')) throw new Error('profile package.json is missing')
  const backup: ProfileBackup = { format: BACKUP_FORMAT, version: 0.2, createdAt: new Date().toISOString(), profile, files }
  if (Buffer.byteLength(JSON.stringify(backup)) > MAX_BACKUP_BYTES) throw new Error(BACKUP_TOO_LARGE)
  return backup
}

export function validatedBackup(value: unknown): ProfileBackup {
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
    const parts = normalized.split('/')
    if (parts.some(part => SKIP_NAMES.has(part))) throw new Error(`excluded backup path: ${path}`)
    // Official exports before #972 carried plugin cache/log dirs whenever
    // they still fit under 2 MB. Those files are not configuration; dropping
    // them keeps the rest of the backup restorable. Names this exporter has
    // never written (SKIP_NAMES) still refuse the document.
    if (parts.some((part, index) => part.startsWith('.') && index < parts.length - 1)) continue
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
  /** The Location header, for the GET redirect loop in downloadWebdav. */
  location?: string
}

async function webdavRequest(
  url: string,
  username: string,
  password: string,
  method: 'GET' | 'PUT' | 'MKCOL',
  body?: string,
): Promise<WebdavResponse> {
  const parsed = new URL(url)
  // SSRF hardening (review #63): https-only by default, and always refuse
  // private/link-local targets — so a same-origin script cannot tunnel into
  // the host network. Besides the obvious metadata surfaces (169.254.169.254),
  // loopback matters because other services on this machine may expose HTTP
  // APIs of their own.
  if (parsed.protocol === 'http:') throw new Error('WebDAV requires an https:// URL')
  if (parsed.protocol !== 'https:') throw new WebdavUrlError('webdav_bad_url', 'invalid WebDAV URL')
  if (parsed.username !== '' || parsed.password !== '') throw new WebdavUrlError('webdav_bad_url', 'invalid WebDAV URL')
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
      response.once('end', () => resolveRequest({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks),
        ...(typeof response.headers.location === 'string' ? { location: response.headers.location } : {}),
      }))
    })
    request.once('error', reject)
    request.end(body)
  })
}

/**
 * Ancestor collection URLs of a WebDAV file, outermost first.
 * `https://dav.example/a/b/x.json` → [`https://dav.example/a/`, `https://dav.example/a/b/`].
 * The server root itself is never included — it always exists, and some
 * providers reject MKCOL on it.
 */
export function webdavParentCollections(url: string): string[] {
  let parsed: URL
  try { parsed = new URL(url) } catch { return [] }
  const parts = parsed.pathname.split('/').filter(part => part !== '')
  parts.pop() // the file itself
  const collections: string[] = []
  let path = ''
  for (const part of parts) {
    path += `/${part}`
    collections.push(`${parsed.origin}${path}/`)
  }
  return collections
}

/**
 * Upload the backup, creating missing parent collections first (#102).
 *
 * WebDAV servers do not create intermediate collections implicitly, so a PUT
 * into a folder that does not exist yet fails — Jianguoyun answers 404, which
 * read as "sync is broken" rather than "make the folder first". MKCOL on an
 * existing collection answers 405, which is success for our purposes; any
 * other failure is left to the PUT to report, since some providers restrict
 * MKCOL while still accepting the upload.
 */
export async function uploadWebdav(url: string, username: string, password: string, backup: ProfileBackup): Promise<void> {
  for (const collection of webdavParentCollections(url)) {
    try {
      await webdavRequest(collection, username, password, 'MKCOL')
    } catch { /* fall through: the PUT below reports the real problem */ }
  }
  const response = await webdavRequest(url, username, password, 'PUT', JSON.stringify(backup))
  if (response.status < 200 || response.status >= 300) {
    throw new Error(describeUploadFailure(response.status))
  }
}

/**
 * What an upload failure means, in the three things a report needs (#1058).
 *
 * A bare `HTTP 401` is the worst of them: it is by far the most common
 * answer, it happens for a reason the user can fix in one field, and the
 * message said nothing about either. The password is deliberately never
 * stored, so "re-entered after a page reload" is the ordinary cause, not an
 * edge case.
 *
 * @param status - the HTTP status the PUT answered with.
 * @returns a bilingual sentence: what happened, why, and what to do.
 */
function describeUploadFailure(status: number): string {
  if (status === 401) {
    return 'WebDAV 上传被拒绝（HTTP 401）：服务端不认这个用户名或密码。密码不会保存到磁盘，刷新页面或重启后需要重新输入；填好后点「上传备份」重试。 / The WebDAV server rejected these credentials (HTTP 401). The password is never stored, so it has to be entered again after a reload or restart; fill it in and press Upload backup.'
  }
  if (status === 403) {
    return 'WebDAV 上传被拒绝（HTTP 403）：凭据有效，但这个账号没有写入该路径的权限。换一个可写的目录，或检查服务商的权限设置。 / The WebDAV server refused the write (HTTP 403): the credentials are valid but this account cannot write to that path. Use a writable folder, or check the provider\'s permissions.'
  }
  if (status === 404) {
    return 'WebDAV upload failed: HTTP 404 — the target folder does not exist and could not be created. Some providers (e.g. Jianguoyun) refuse files at the root: use a path inside a folder, e.g. https://dav.example.com/dsh/backup.json / 目标目录不存在且无法自动创建；部分服务商（如坚果云）不允许在根目录放文件，请使用形如 https://dav.example.com/dsh/backup.json 的子目录路径'
  }
  return `WebDAV upload failed: HTTP ${status}`
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
    if (!isPublicTarget(bare)) throw privateResolution(bare, bare)
    return { address: bare, family }
  }
  if (!isPublicHostname(bare)) throw new WebdavUrlError('webdav_bad_url', 'invalid WebDAV URL')
  const addresses = await lookup(bare, { all: true, verbatim: true })
  if (addresses.length === 0) {
    throw new WebdavUrlError('webdav_unresolvable',
      `域名 ${bare} 没有解析出任何地址，市场无法连接。请检查域名拼写和本机 DNS。 / ${bare} did not resolve to any address, so the market could not connect. Check the hostname and the machine's DNS.`)
  }
  const unsafe = addresses.find(({ address }) => !isPublicTarget(address))
  if (unsafe !== undefined) throw privateResolution(bare, unsafe.address)
  const selected = addresses[0]
  if (selected.family !== 4 && selected.family !== 6) {
    throw new WebdavUrlError('webdav_unresolvable', `域名 ${bare} 的解析结果不可用 / the addresses ${bare} resolved to are not usable`)
  }
  return { address: selected.address, family: selected.family }
}

/**
 * How many redirects a download will follow before giving up. Providers use
 * one hop (WebDAV endpoint -> signed CDN link); five tolerates a CDN's own
 * indirection without letting two servers ping-pong forever.
 */
const MAX_REDIRECTS = 5

/**
 * Why a WebDAV target was refused, when the answer is not "the URL is wrong"
 * (#999).
 *
 * The gate used to answer `invalid WebDAV URL` for every branch — a non-https
 * scheme, embedded credentials, a `.local` name, an empty DNS answer and a
 * private resolution all read the same. That made one very common setup
 * undebuggable: a proxy client in fake-ip mode (Clash/Mihomo, the default for
 * most Chinese setups) answers `198.18.x.x` for every proxied hostname, so
 * every WebDAV target was refused with a message pointing at the URL.
 */
export type WebdavUrlErrorCode = 'webdav_bad_url' | 'webdav_unresolvable' | 'webdav_private_resolution'

export class WebdavUrlError extends Error {
  constructor(readonly code: WebdavUrlErrorCode, message: string, readonly address?: string) {
    super(message)
    this.name = 'WebdavUrlError'
  }
}

/** The refusal a private or reserved resolution deserves: what, why, and the way out. */
function privateResolution(hostname: string, address: string): WebdavUrlError {
  return new WebdavUrlError('webdav_private_resolution',
    `WebDAV 域名 ${hostname} 解析到私有或保留地址 ${address}，市场不会连过去。如果你在用 fake-ip 模式的代理（Clash/Mihomo 默认如此，任何域名都答成 198.18.x.x），请把这个域名加入代理的 fake-ip-filter 列表，或改用它的真实地址，然后重试。 / The WebDAV host ${hostname} resolved to ${address}, a private or reserved address, so the market did not connect. If you use a proxy in fake-ip mode (Clash/Mihomo answers 198.18.x.x for every proxied name), add this host to its fake-ip-filter list or use its real address, then try again.`,
    address)
}

export async function downloadWebdav(url: string, username: string, password: string): Promise<unknown> {
  // Some providers answer a WebDAV GET with 302 to a time-limited signed CDN
  // link while accepting PUT directly on the same path (#480 by @zhyx1996,
  // measured against 123pan) — so upload worked and restore failed with
  // "HTTP 302". Only GET follows: the upload path is direct on every
  // provider seen, and replaying a PUT body across redirects is a can of
  // worms nothing currently needs opened.
  //
  // Every hop goes back through webdavRequest, so the full SSRF gate —
  // https-only, no credentials in the URL, resolvePublicAddress with the
  // rebinding-safe direct-IP connect — is re-run per target, not only on the
  // first one. A redirect is the server choosing the next URL; trusting it
  // half as much as the user's own input would invert the threat model.
  //
  // Credentials do NOT cross origins. The signed link authorizes itself;
  // forwarding Basic auth to whatever host the server named would hand the
  // user's WebDAV password to a third party on the server's say-so.
  let currentUrl = url
  let response = await webdavRequest(currentUrl, username, password, 'GET')
  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    if (response.status !== 301 && response.status !== 302 && response.status !== 303
      && response.status !== 307 && response.status !== 308) break
    if (response.location === undefined) break
    const next = new URL(response.location, currentUrl)
    const sameOrigin = next.origin === new URL(currentUrl).origin
    currentUrl = next.toString()
    response = sameOrigin
      ? await webdavRequest(currentUrl, username, password, 'GET')
      : await webdavRequest(currentUrl, '', '', 'GET')
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(response.status === 404
      ? 'WebDAV download failed: HTTP 404 — no backup at that path yet. Upload one first, and check the URL points at the backup FILE (…/dsh/backup.json), not its folder / 该路径下还没有备份文件。请先执行一次上传，并确认地址指向备份文件本身（…/dsh/backup.json）而不是目录'
      : `WebDAV download failed: HTTP ${response.status}`)
  }
  // Validate strictly server-side so the fetch result is never a generic
  // echo of an internal response: restore only accepts real backups.
  const body = JSON.parse(response.body.toString('utf8')) as unknown
  validatedBackup(body)
  return body
}

export interface PluginSelection {
  deps: Record<string, string>
  bundles: string[]
}

/**
 * The selected plugins' dependency specs and bundle entries from a backup's
 * manifest. Only string specs survive — everything else in the manifest is
 * untrusted and ignored (partial restore touches nothing but these).
 */
export function extractPluginSelection(backup: ProfileBackup, includeDeps: string[]): PluginSelection {
  const manifest = backup.files.find(file => file.path === 'package.json' && 'json' in file)
  if (manifest === undefined || !('json' in manifest)) throw new Error('backup has no package.json')
  const include = new Set(includeDeps)
  const json = manifest.json
  const dependencies = json.dependencies === null || typeof json.dependencies !== 'object' || Array.isArray(json.dependencies)
    ? {}
    : json.dependencies as Record<string, unknown>
  const deps: Record<string, string> = {}
  for (const [name, spec] of Object.entries(dependencies)) {
    if (typeof spec === 'string' && include.has(name)) deps[name] = spec
  }
  const dsh = json.dsh === null || typeof json.dsh !== 'object' || Array.isArray(json.dsh)
    ? undefined
    : json.dsh as { profile?: unknown }
  const profileBlock = dsh?.profile === null || typeof dsh?.profile !== 'object' || Array.isArray(dsh?.profile)
    ? undefined
    : dsh.profile as { bundles?: unknown }
  const bundles = Array.isArray(profileBlock?.bundles) ? profileBlock.bundles as unknown[] : []
  return {
    deps,
    bundles: bundles.filter((name): name is string => typeof name === 'string' && include.has(name)),
  }
}

/**
 * Merge a backup's manifest into the profile's current manifest so a restore
 * never deletes plugins the target machine already has: current deps stay,
 * backup specs win on name conflicts; bundle lists are unioned. When
 * `selection` is given, only the selected plugins are merged in.
 */
/**
 * Dependencies whose spec points at an absolute local path — `link:/Users/…`
 * or `file:/home/…` (#205 by @Rudyy898).
 *
 * These are perfectly valid on the machine that wrote them and meaningless
 * anywhere else, so a backup carrying one restores a manifest that `pnpm
 * install` cannot satisfy: the path does not exist on the new machine and
 * the whole restore fails on it.
 *
 * Reported, NOT rewritten. Turning `link:/Users/me/dev/plugin` into
 * something portable means deciding where those files should live and
 * whether to carry them at all, which is a design question and not
 * something a restore should answer on the user's behalf. Naming them lets
 * the operator decide before the install runs — which is the part that was
 * missing.
 *
 * Relative `file:./vendor/x` specs are left alone: they resolve against the
 * profile directory, which the restore recreates, so they travel fine.
 */
export function unportableDeps(dependencies: unknown): Array<{ name: string; spec: string }> {
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) return []
  const found: Array<{ name: string; spec: string }> = []
  for (const [name, raw] of Object.entries(dependencies as Record<string, unknown>)) {
    if (typeof raw !== 'string') continue
    const match = /^(?:link|file):(.+)$/i.exec(raw)
    if (match === null) continue
    let path = match[1]
    try { path = decodeURIComponent(path) } catch { /* keep the literal spec */ }
    // POSIX absolute, Windows drive-letter, or UNC — every shape that names
    // a location outside this profile.
    if (/^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path)) found.push({ name, spec: raw })
  }
  return found
}

export function mergeRestoreManifest(
  backupManifest: Record<string, unknown>,
  current: Record<string, unknown>,
  selection?: PluginSelection,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...backupManifest }
  const backupDeps = backupManifest.dependencies === null || typeof backupManifest.dependencies !== 'object' || Array.isArray(backupManifest.dependencies)
    ? {}
    : backupManifest.dependencies as Record<string, unknown>
  const backupBundles = Array.isArray((backupManifest.dsh as { profile?: { bundles?: unknown } } | undefined)?.profile?.bundles)
    ? ((backupManifest.dsh as { profile: { bundles: unknown[] } }).profile.bundles)
    : []
  const currentDeps = current.dependencies === null || typeof current.dependencies !== 'object' || Array.isArray(current.dependencies)
    ? {}
    : current.dependencies as Record<string, unknown>
  const currentBundles = Array.isArray((current.dsh as { profile?: { bundles?: unknown } } | undefined)?.profile?.bundles)
    ? ((current.dsh as { profile: { bundles: unknown[] } }).profile.bundles)
    : []

  // Deps: keep the target's, overlay the backup's (or only the selection).
  const deps: Record<string, unknown> = { ...currentDeps }
  const sourceDeps = selection !== undefined ? selection.deps : backupDeps
  for (const [name, spec] of Object.entries(sourceDeps)) deps[name] = spec
  merged.dependencies = deps

  // Bundles: union of target and backup (or selection), de-duplicated.
  const bundles = new Set<string>()
  for (const name of currentBundles) if (typeof name === 'string') bundles.add(name)
  const sourceBundles = selection !== undefined ? selection.bundles : backupBundles
  for (const name of sourceBundles) if (typeof name === 'string') bundles.add(name)

  const currentDsh = current.dsh === null || typeof current.dsh !== 'object' || Array.isArray(current.dsh)
    ? undefined
    : current.dsh as { profile?: unknown }
  const currentProfile = currentDsh?.profile === null || typeof currentDsh?.profile !== 'object' || Array.isArray(currentDsh?.profile)
    ? undefined
    : currentDsh.profile as Record<string, unknown>
  const backupDsh = merged.dsh === null || typeof merged.dsh !== 'object' || Array.isArray(merged.dsh)
    ? undefined
    : merged.dsh as { profile?: unknown }
  const backupProfile = backupDsh?.profile === null || typeof backupDsh?.profile !== 'object' || Array.isArray(backupDsh?.profile)
    ? undefined
    : backupDsh.profile as Record<string, unknown>

  const profileMerged: Record<string, unknown> = { ...(backupProfile ?? {}), ...(currentProfile ?? {}), bundles: [...bundles] }
  const dshMerged: Record<string, unknown> = { ...(backupDsh ?? {}), ...(currentDsh ?? {}), profile: profileMerged }
  merged.dsh = dshMerged
  return merged
}

/**
 * Dependencies a restore must leave at the spec the target already has — the
 * market itself, while it is the package running the restore.
 *
 * A restore applies the backup's manifest through `pnpm install`, which
 * rewrites whatever that manifest pins. When the backup was written by a
 * different market version, that install replaces THIS package's files under
 * the live module: the mixed state the update route refuses (#608), made
 * worse here because the code answering the restore request is the code being
 * swapped out. The running spec therefore wins, and the backup's spec is
 * returned so the caller can report it — the update flow can apply it later,
 * with its restart and rollback machinery.
 *
 * Only string specs take part: anything else is not a pin this can compare.
 */
export function pinRunningDeps(
  merged: Record<string, unknown>,
  current: Record<string, unknown>,
  names: ReadonlySet<string>,
): { dependencies: Record<string, unknown>; pinned: Array<{ name: string; from: string; to: string }> } {
  const mergedDeps = merged.dependencies === null || typeof merged.dependencies !== 'object' || Array.isArray(merged.dependencies)
    ? {}
    : merged.dependencies as Record<string, unknown>
  const currentDeps = current.dependencies === null || typeof current.dependencies !== 'object' || Array.isArray(current.dependencies)
    ? {}
    : current.dependencies as Record<string, unknown>
  const dependencies: Record<string, unknown> = { ...mergedDeps }
  const pinned: Array<{ name: string; from: string; to: string }> = []
  for (const name of names) {
    const wanted = mergedDeps[name]
    const running = currentDeps[name]
    if (typeof wanted !== 'string' || typeof running !== 'string' || wanted === running) continue
    dependencies[name] = running
    pinned.push({ name, from: wanted, to: running })
  }
  return { dependencies, pinned }
}
