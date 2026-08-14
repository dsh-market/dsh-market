/**
 * HTTP routes bridging the browser market UI to the host: registry fallback,
 * installed-plugin listing, and the install executor.
 *
 * Security: the install route executes a shell command, so it accepts only
 * same-origin POSTs and only sources present in the curated registry.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadRegistry } from './registry.ts'
import { cleanHotDir, hotMount, hotUnmount } from './hot.ts'
import { exportLogs, logEvent } from './log.ts'

export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

export interface MarketHost {
  webServer: WebServerService
  plugin(plugin: unknown, config: unknown): { await(): Promise<unknown>; dispose(): Promise<unknown> | void }
  logger?: { info?(message: string): void; warn(message: string): void }
}

export interface MarketConfig {
  /** Profile the market installs into; matches the profile serving this UI. */
  profile: string
}

const PROFILE_RE = /^[A-Za-z0-9_-]+$/
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Argv re-invoking the CLI that launched this host process, so installs work
 * whether dsh runs from a global bin, a local install, or repo source
 * (`node --import tsx/esm .../bin.ts`). Falls back to a PATH `dsh`.
 *
 * Installs run through node:child_process, not ctx.shell: the shell service is
 * the agent's sandboxed executor and denies writes to the profile directory.
 */
function dshArgv(): { file: string; args: string[]; cwd: string | undefined } {
  const entry = process.argv[1]
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    // cwd near the entry keeps execArgv imports (tsx/esm) resolvable on source launches.
    return { file: process.execPath, args: [...process.execArgv, entry], cwd: dirname(entry) }
  }
  return { file: 'dsh', args: [], cwd: undefined }
}

interface InstallResult {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

type ToolResolution =
  | { type: 'shell'; name: string }
  | { type: 'path'; file: string }
  | { type: 'cmdshim'; file: string }

/**
 * Locate a CLI tool on Windows. `npm`/`corepack`/`pnpm` ship as `.cmd` shims
 * (no `.exe`), which node:child_process cannot exec directly and which a bare
 * `spawn` cannot find when the Node install dir isn't on PATH. Lookup order:
 * the Node install directory (shims live next to node.exe), then PATH dirs.
 */
function resolveTool(name: string): ToolResolution {
  if (process.platform !== 'win32') return { type: 'shell', name }
  const candidates = [join(dirname(process.execPath), `${name}.cmd`)]
  for (const dir of (process.env.Path ?? process.env.PATH ?? '').split(';')) {
    if (dir !== '') candidates.push(join(dir, `${name}.cmd`), join(dir, `${name}.exe`))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return /\.exe$/i.test(candidate)
        ? { type: 'path', file: candidate }
        : { type: 'cmdshim', file: candidate }
    }
  }
  return { type: 'shell', name }
}

/**
 * Spawn a CLI tool that node:child_process could otherwise not start on
 * Windows: `.cmd`/`.bat` shims must run through cmd.exe, and a shim path
 * containing spaces needs the outer-quote wrapper because cmd /c strips the
 * first and last quote of the line.
 */
function spawnTool(name: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  const resolved = resolveTool(name)
  if (process.platform !== 'win32' || resolved.type === 'path') {
    return spawn(resolved.type === 'path' ? resolved.file : resolved.name, args, options)
  }
  const argLine = args.map((arg) => /[ \t&|<>^()"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg).join(' ')
  const cmdline = resolved.type === 'cmdshim'
    ? (argLine === '' ? `""${resolved.file}""` : `""${resolved.file}" ${argLine}"`)
    : (argLine === '' ? resolved.name : `${resolved.name} ${argLine}`)
  return spawn('cmd.exe', ['/d', '/s', '/c', cmdline], { ...options, windowsVerbatimArguments: true })
}

/** Kill a spawned child and, on Windows, its whole process tree. */
function killChild(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    } catch { /* best effort */ }
  } else {
    child.kill('SIGKILL')
  }
}

/** Whether `pnpm` resolves on PATH; success is cached, absence is re-probed. */
let pnpmReady = false

function probePnpm(): Promise<boolean> {
  if (pnpmReady) return Promise.resolve(true)
  return new Promise((resolvePromise) => {
    const child = spawnTool('pnpm', ['--version'], { stdio: 'ignore' })
    child.on('error', () => resolvePromise(false))
    child.on('close', (code) => {
      pnpmReady = code === 0
      resolvePromise(pnpmReady)
    })
  })
}

function runQuiet(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawnTool(file, args, { env: { ...process.env, CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => killChild(child), timeoutMs)
    const collect = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-8 * 1024) }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (error) => { clearTimeout(timer); resolvePromise({ code: 127, output: error.message }) })
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, output }) })
  })
}

/**
 * Provision pnpm without user involvement: corepack (ships with Node) first,
 * a global npm install as fallback.
 * @returns true when `pnpm --version` succeeds afterwards.
 */
async function provisionPnpm(): Promise<boolean> {
  const corepack = await runQuiet('corepack', ['enable', 'pnpm'], 60 * 1000)
  logEvent(corepack.code === 0 ? 'info' : 'warn', 'setup-pnpm', `corepack enable: exit=${String(corepack.code)} ${corepack.output.slice(-200)}`)
  if (await probePnpm()) return true
  const npm = await runQuiet('npm', ['install', '-g', 'pnpm'], 3 * 60 * 1000)
  logEvent(npm.code === 0 ? 'info' : 'error', 'setup-pnpm', `npm -g: exit=${String(npm.code)} ${npm.output.slice(-200)}`)
  return probePnpm()
}

/** Live progress of the running plugin command, for the status route. */
interface InstallProgress {
  active: boolean
  target: string
  startedAt: number
  lastLine: string
}

const progress: InstallProgress = { active: false, target: '', startedAt: 0, lastLine: '' }

/** Identifies this host process; the client scopes its pending-restart flags to it. */
const BOOT_ID = `${String(process.pid)}-${String(Date.now())}`

function trackProgress(chunk: string): void {
  const lines = chunk.split('\n').map(l => l.trim()).filter(l => l !== '')
  if (lines.length > 0) progress.lastLine = lines[lines.length - 1].slice(0, 200)
}

function runDshPlugin(profile: string, pluginArgs: string[]): Promise<InstallResult> {
  const { file, args, cwd } = dshArgv()
  progress.active = true
  progress.target = pluginArgs[pluginArgs.length - 1] ?? ''
  progress.startedAt = Date.now()
  progress.lastLine = ''
  return new Promise((resolvePromise) => {
    const child = spawn(file, [...args, 'plugin', '--profile', profile, ...pluginArgs], {
      cwd,
      // pnpm v10 blocks forever on a silent interactive prompt without a TTY
      // (observed on re-add over a pinned git spec); CI mode forces it to act
      // or fail instead of asking.
      env: { ...process.env, CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killChild(child)
    }, INSTALL_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout = (stdout + text).slice(-256 * 1024)
      trackProgress(text)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr = (stderr + text).slice(-64 * 1024)
      trackProgress(text)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      progress.active = false
      resolvePromise({ exitCode: 127, timedOut: false, stdout, stderr: `${stderr}\n${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      progress.active = false
      resolvePromise({ exitCode: code, timedOut, stdout, stderr })
    })
  })
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 4096) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function profileDir(profile: string): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'profiles', profile)
}

/** Community dependencies of the profile (official in-box scope filtered out). */
function readInstalled(profile: string): Record<string, string> {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir(profile), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const installed: Record<string, string> = {}
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (!name.startsWith('@deepseek-ai/')) installed[name] = spec
    }
    return installed
  } catch {
    return {}
  }
}

/** GitHub `owner/repo` for a registry URL, or null when it is not a GitHub repo URL. */
function repoOf(url: string): string | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)\/?$/.exec(url)
  if (m === null || !REPO_RE.test(m[1])) return null
  return m[1]
}

/** Pinned commit per `owner/repo` from the profile lockfile's codeload tarball URLs. */
function readLockCommits(profile: string): Map<string, string> {
  const commits = new Map<string, string>()
  try {
    const lock = readFileSync(join(profileDir(profile), 'pnpm-lock.yaml'), 'utf8')
    for (const m of lock.matchAll(/codeload\.github\.com\/([^/\s]+\/[^/\s]+)\/tar\.gz\/([0-9a-f]{40})/g)) {
      commits.set(m[1].toLowerCase(), m[2])
    }
  } catch { /* no lockfile — no git installs to report */ }
  return commits
}

function readInstalledVersion(profile: string, name: string): string | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDir(profile), 'node_modules', name, 'package.json'), 'utf8'),
    ) as { version?: string }
    return manifest.version ?? null
  } catch {
    return null
  }
}

export interface UpdateStatus {
  kind: 'github' | 'npm' | 'linked'
  version: string | null
  current: string | null
  latest: string | null
  updateAvailable: boolean
}

const UPDATES_TTL_MS = 30 * 60 * 1000
let updatesCache: { at: number; data: Record<string, UpdateStatus> } | null = null

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-market' },
    signal: AbortSignal.timeout(4000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as unknown
}

/** Per-plugin update checks; a failed check reports no update rather than failing the listing. */
async function checkUpdates(profile: string, force = false): Promise<Record<string, UpdateStatus>> {
  if (!force && updatesCache && Date.now() - updatesCache.at < UPDATES_TTL_MS) return updatesCache.data
  const installed = readInstalled(profile)
  const lockCommits = readLockCommits(profile)
  const result: Record<string, UpdateStatus> = {}
  await Promise.all(Object.entries(installed).map(async ([name, spec]) => {
    const version = readInstalledVersion(profile, name)
    if (spec.startsWith('link:') || spec.startsWith('file:')) {
      result[name] = { kind: 'linked', version, current: null, latest: null, updateAvailable: false }
      return
    }
    const gh = /^(?:github:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#.*)?$/.exec(spec)
    try {
      if (spec.startsWith('github:') && gh !== null) {
        const current = lockCommits.get(gh[1].toLowerCase()) ?? null
        const head = (await fetchJson(`https://api.github.com/repos/${gh[1]}/commits/HEAD`)) as { sha?: string }
        const latest = typeof head.sha === 'string' ? head.sha : null
        result[name] = {
          kind: 'github', version, current, latest,
          updateAvailable: current !== null && latest !== null && current !== latest,
        }
      } else {
        const meta = (await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`)) as { version?: string }
        const latest = typeof meta.version === 'string' ? meta.version : null
        result[name] = {
          kind: 'npm', version, current: version, latest,
          updateAvailable: version !== null && latest !== null && version !== latest,
        }
      }
    } catch {
      result[name] = { kind: spec.startsWith('github:') ? 'github' : 'npm', version, current: null, latest: null, updateAvailable: false }
    }
  }))
  updatesCache = { at: Date.now(), data: result }
  return result
}

/**
 * Register the market's HTTP routes.
 * @param host - Acquired webServer + shell services.
 * @param config - Validated market configuration.
 * @returns Disposer removing every registered route.
 */
export function mountMarketRoutes(host: MarketHost, config: MarketConfig): () => void {
  if (!PROFILE_RE.test(config.profile)) {
    throw new Error(`dsh-market: invalid profile name: ${config.profile}`)
  }
  // Boot-time wipe: stale hot-mount inputs from a previous session must never
  // survive into a composition where the bundle layer already covers them.
  cleanHotDir(profileDir(config.profile))
  let installing = false

  const disposers = [
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/registry',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        try {
          const { registry, source } = await loadRegistry()
          sendJson(response, 200, { source, registry })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/installed',
      handler: (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        sendJson(response, 200, { profile: config.profile, installed: readInstalled(config.profile) })
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/status',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        sendJson(response, 200, {
          active: progress.active,
          target: progress.target,
          seconds: progress.active ? Math.round((Date.now() - progress.startedAt) / 1000) : 0,
          lastLine: progress.lastLine,
          pnpm: await probePnpm(),
          boot: BOOT_ID,
          installed: readInstalled(config.profile),
        })
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/logs',
      handler: (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        let version = 'unknown'
        try {
          version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? version
        } catch { /* export still works without the version line */ }
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="dsh-market-log.txt"',
        })
        response.end(exportLogs({
          'dsh-market': version,
          platform: `${process.platform} ${process.arch}`,
          node: process.version,
          profile: config.profile,
        }))
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/updates',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        try {
          const force = (request.url ?? '').includes('force=1')
          sendJson(response, 200, { updates: await checkUpdates(config.profile, force) })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/update',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        if (installing) {
          sendJson(response, 409, { error: 'another install is already running' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { name?: unknown }
          const name = typeof body.name === 'string' ? body.name : ''
          const spec = readInstalled(config.profile)[name]
          if (spec === undefined) {
            sendJson(response, 400, { error: 'plugin is not installed' })
            return
          }
          if (spec.startsWith('link:') || spec.startsWith('file:')) {
            sendJson(response, 400, { error: 'locally linked plugins update from their checkout' })
            return
          }
          // Re-running add re-resolves the source: git HEAD for github specs,
          // dist-tag latest for registry installs.
          const target = spec.startsWith('github:') ? spec.replace(/#.*$/, '') : `${name}@latest`
          installing = true
          try {
            const result = await runDshPlugin(config.profile, ['add', target])
            const ok = result.exitCode === 0 && !result.timedOut
            if (ok) updatesCache = null
            logEvent(ok ? 'info' : 'error', 'update',
              `${name} -> ${target} exit=${String(result.exitCode)}${result.timedOut ? ' TIMEOUT' : ''}${ok ? '' : ` stderr=${result.stderr.slice(-300)}`}`)
            sendJson(response, ok ? 200 : 502, {
              ok,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              stdout: result.stdout,
              stderr: result.stderr,
              installed: readInstalled(config.profile),
            })
          } finally {
            installing = false
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          host.logger?.warn(`[dsh-market] update failed: ${message}`)
          logEvent('error', 'update', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/setup-pnpm',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          sendJson(response, 200, { ok: await provisionPnpm() })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/uninstall',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        if (installing) {
          sendJson(response, 409, { error: 'another install is already running' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { name?: unknown }
          const name = typeof body.name === 'string' ? body.name : ''
          if (name === 'dsh-market' || name === 'dshmarket') {
            sendJson(response, 400, { error: 'the market cannot uninstall itself; use the dsh CLI' })
            return
          }
          if (readInstalled(config.profile)[name] === undefined) {
            sendJson(response, 400, { error: 'plugin is not installed' })
            return
          }
          installing = true
          try {
            const result = await runDshPlugin(config.profile, ['remove', name])
            const ok = result.exitCode === 0 && !result.timedOut
            let hot = false
            if (ok) {
              updatesCache = null
              hot = await hotUnmount(name)
            }
            logEvent(ok ? 'info' : 'error', 'uninstall',
              `${name} exit=${String(result.exitCode)}${ok ? ` live-removed=${String(hot)}` : ` stderr=${result.stderr.slice(-300)}`}`)
            sendJson(response, ok ? 200 : 502, {
              ok,
              hot,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              installed: readInstalled(config.profile),
            })
          } finally {
            installing = false
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          host.logger?.warn(`[dsh-market] uninstall failed: ${message}`)
          logEvent('error', 'uninstall', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/install',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        if (installing) {
          sendJson(response, 409, { error: 'another install is already running' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { url?: unknown }
          const url = typeof body.url === 'string' ? body.url : ''
          const { registry } = await loadRegistry()
          const entry = registry.plugins.find(p => p.url.toLowerCase() === url.toLowerCase())
          if (entry === undefined) {
            logEvent('warn', 'install-rejected', `not in curated registry: ${url.slice(0, 120)}`)
            sendJson(response, 400, { error: 'plugin is not in the curated registry' })
            return
          }
          const repo = repoOf(entry.url)
          if (repo === null) {
            sendJson(response, 400, { error: 'unsupported source url' })
            return
          }
          // Registry tarballs beat full-repo GitHub downloads: smaller,
          // prebuilt, and CDN/mirror served. The npm name comes from our
          // curated registry, which only maps repo-verified packages.
          const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
          const target = typeof entry.npm === 'string' && NPM_NAME_RE.test(entry.npm)
            ? entry.npm
            : `github:${repo}`
          installing = true
          try {
            const before = new Set(Object.keys(readInstalled(config.profile)))
            const result = await runDshPlugin(config.profile, ['add', target])
            const ok = result.exitCode === 0 && !result.timedOut
            if (ok) updatesCache = null
            const installed = readInstalled(config.profile)
            let hot = false
            if (ok) {
              const added = Object.keys(installed).filter(name => !before.has(name))
              if (added.length > 0) {
                const results = await Promise.all(
                  added.map(name => hotMount(host, profileDir(config.profile), name)),
                )
                hot = results.every(Boolean)
              }
            }
            logEvent(ok ? 'info' : 'error', 'install',
              `${target} exit=${String(result.exitCode)}${result.timedOut ? ' TIMEOUT' : ''}${ok ? ` hot=${String(hot)}` : ` stderr=${result.stderr.slice(-300)}`}`)
            sendJson(response, ok ? 200 : 502, {
              ok,
              hot,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              stdout: result.stdout,
              stderr: result.stderr,
              installed,
            })
          } finally {
            installing = false
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          host.logger?.warn(`[dsh-market] install failed: ${message}`)
          logEvent('error', 'install', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),
  ]

  return () => {
    for (const dispose of disposers) dispose()
  }
}
