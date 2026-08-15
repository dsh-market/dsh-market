/**
 * UI flow tests: exercise the full browser-driven journeys — browse,
 * install, update-check, update, theme switch, uninstall — through the REAL
 * route/orchestration/profile layers, with only the process and network
 * boundaries replaced:
 *
 * - dsh-cli.ts   → FakeDsh: a programmable executor that performs real
 *                  filesystem effects on a tmp profile (package.json +
 *                  node_modules), with scriptable npm state ("latest is
 *                  1.2.0"), minimumReleaseAge silent-stale mode, and
 *                  hoist-drift failure injection. This is what lets CI test
 *                  the update logic WITHOUT publishing npm versions.
 * - registry.ts  → fixed curated registry (with a theme category)
 * - hot.ts       → in-memory mount table
 * - global fetch → fake npm/github APIs
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------- FakeDsh
// Mutable per-test state driving the fake executor and fake npm API.
const fake = vi.hoisted(() => ({
  profileDir: '',
  /** name → { versions: v→{manifest, artifacts}, latest } */
  npm: {} as Record<string, { versions: Record<string, { manifest: unknown; artifacts?: string[] }>; latest: string }>,
  /** github:owner/repo target → packages it installs (or a junk collection) */
  repos: {} as Record<string, { name: string; manifest: unknown; artifacts?: string[]; junkChildren?: string[] }>,
  /** Simulate pnpm minimumReleaseAge: adds resolve to the ALREADY INSTALLED version, exit 0. */
  staleUpdates: false,
  /** Fail the next N mutating commands with the hoist-pattern drift error. */
  hoistDiffTimes: 0,
  /** Simulate a too-young release in the lockfile (#39): every mutation
   * fails pnpm's supply-chain verification unless the one-shot
   * --config.minimumReleaseAge=0 override is passed (real pnpm 11 behavior
   * pinned in tests/pnpm-behavior.compat.spec.ts). */
  youngLockfile: false,
  /** When set, every command awaits this before acting (concurrency tests). */
  gate: null as Promise<void> | null,
  /** Set by the mocked cancelActive: the in-flight command resolves cancelled. */
  cancelNext: false,
  /** Appended to the next add's stdout (e.g. pnpm's Ignored build scripts line). */
  buildScriptOutputOnce: '',
  /** True while a fake command is in flight (mirrors the real activeChild). */
  running: false,
  calls: [] as string[][],
}))

vi.mock('../src/dsh-cli.ts', () => {
  function writePkg(name: string, manifest: unknown, artifacts: string[] = []): void {
    const root = join(fake.profileDir, 'node_modules', name)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
    for (const rel of artifacts) {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      writeFileSync(join(root, rel), '')
    }
  }
  function readManifest(): { dependencies?: Record<string, string> } {
    return JSON.parse(readFileSync(join(fake.profileDir, 'package.json'), 'utf8'))
  }
  function writeDep(name: string, spec: string): void {
    const manifest = readManifest()
    manifest.dependencies = { ...manifest.dependencies, [name]: spec }
    writeFileSync(join(fake.profileDir, 'package.json'), JSON.stringify(manifest))
  }
  function removeDep(name: string): void {
    const manifest = readManifest()
    if (manifest.dependencies) delete manifest.dependencies[name]
    writeFileSync(join(fake.profileDir, 'package.json'), JSON.stringify(manifest))
    rmSync(join(fake.profileDir, 'node_modules', name), { recursive: true, force: true })
  }
  async function runDshPlugin(_profile: string, args: string[]): Promise<unknown> {
    fake.calls.push(args)
    fake.running = true
    try {
      return await execute(args)
    } finally {
      fake.running = false
    }
  }
  async function execute(args: string[]): Promise<unknown> {
    if (fake.gate !== null) await fake.gate
    if (fake.cancelNext) {
      fake.cancelNext = false
      return { exitCode: null, timedOut: false, stdout: '', stderr: '', cancelled: true }
    }
    const positional = args.filter(a => !a.startsWith('-'))
    const cmd = positional[0]
    const ok = { exitCode: 0, timedOut: false, stdout: '', stderr: '', cancelled: false }
    if (fake.youngLockfile && !args.includes('--config.minimumReleaseAge=0')) {
      return {
        exitCode: 1, timedOut: false, stdout: '', cancelled: false,
        stderr: '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:\n  dsh-loop@1.0.0 was published at 2026-08-15T00:00:00.000Z, within the minimumReleaseAge cutoff',
      }
    }
    if (cmd === 'install') return ok
    if (fake.hoistDiffTimes > 0) {
      fake.hoistDiffTimes--
      return { exitCode: 1, timedOut: false, stdout: '', stderr: 'ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF  Run "pnpm install" to recreate the modules directory.', cancelled: false }
    }
    const target = positional[positional.length - 1]
    if (cmd === 'remove') {
      removeDep(target)
      return ok
    }
    // cmd === 'add'
    if (target.startsWith('github:')) {
      const repo = fake.repos[target]
      if (repo === undefined) return { exitCode: 1, timedOut: false, stdout: '', stderr: `fake dsh: unknown repo ${target}`, cancelled: false }
      writeDep(repo.name, target.split('#')[0])
      writePkg(repo.name, repo.manifest, repo.artifacts)
      for (const child of repo.junkChildren ?? []) {
        mkdirSync(join(fake.profileDir, 'node_modules', repo.name, child), { recursive: true })
        writeFileSync(join(fake.profileDir, 'node_modules', repo.name, child, 'package.json'), '{"dsh":{}}')
      }
      return ok
    }
    const name = target.replace(/@(latest|[\d^~].*)$/, '')
    const pkg = fake.npm[name]
    if (pkg === undefined) return { exitCode: 1, timedOut: false, stdout: '', stderr: `fake dsh: unknown npm package ${name}`, cancelled: false }
    const installedManifestPath = join(fake.profileDir, 'node_modules', name, 'package.json')
    if (fake.staleUpdates && existsSync(installedManifestPath)) {
      // pnpm minimumReleaseAge: "Already up to date", old version kept, exit 0.
      return ok
    }
    const version = pkg.latest
    writeDep(name, `^${version}`)
    writePkg(name, { version, ...(pkg.versions[version].manifest as object) }, pkg.versions[version].artifacts)
    if (fake.buildScriptOutputOnce !== '') {
      const stdout = fake.buildScriptOutputOnce
      fake.buildScriptOutputOnce = ''
      return { ...ok, stdout }
    }
    return ok
  }
  return {
    BOOT_ID: 'test-boot',
    progress: {
      active: false, target: '', startedAt: 0, lastLine: '',
      phase: null, done: 0, total: null, currentPackage: null,
      downloaded: null, size: null, ndjson: false, error: null, cancelling: false,
    },
    probePnpm: () => Promise.resolve(true),
    provisionPnpm: () => Promise.resolve(true),
    killChild: () => {},
    cancelActive: () => { if (!fake.running) return false; fake.cancelNext = true; return true },
    dshArgv: () => ({ file: 'dsh', args: [], cwd: undefined, viaShell: false }),
    winCmdShim: false,
    runDshPlugin,
  }
})

// ---------------------------------------------------------------- fake hot layer
const hot = vi.hoisted(() => ({ mounts: [] as string[], disabled: new Set<string>(), failNext: false }))
vi.mock('../src/hot.ts', () => ({
  cleanHotDir: () => {},
  readDisabledThemes: () => hot.disabled,
  writeDisabledThemes: (_dir: string, set: Set<string>) => { hot.disabled = new Set(set) },
  listHotMounts: () => [...hot.mounts],
  hotMount: (_ctx: unknown, _dir: string, name: string) => {
    if (hot.failNext) {
      hot.failNext = false
      return Promise.resolve({ ok: false, reason: 'test: host cannot hot-mount' })
    }
    hot.mounts.push(name)
    return Promise.resolve({ ok: true, reason: null })
  },
  hotUnmount: (name: string) => {
    const index = hot.mounts.indexOf(name)
    if (index !== -1) hot.mounts.splice(index, 1)
    return Promise.resolve(index !== -1)
  },
  mountClientOnlyDeps: () => Promise.resolve([]),
}))

// ---------------------------------------------------------------- fake restart scheduler
const restartCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('../src/restart.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/restart.ts')>()
  return {
    ...original,
    // The real one SIGTERMs the process — fatal inside a test worker.
    scheduleRestart: () => {
      restartCalls.count += 1
      return { pid: 1, helperPid: 2, logOut: '/tmp/o', logErr: '/tmp/e' }
    },
  }
})

// ---------------------------------------------------------------- fake registry
const REGISTRY = {
  updated: '', count: 3,
  categories: { tool: { en: 'Tools' }, theme: { en: 'Themes' } },
  plugins: [
    { name: 'dsh-loop', owner: 'o', url: 'https://github.com/o/dsh-loop', category: 'tool', npm: 'dsh-loop', description: {}, install: '', added: '' },
    { name: 'theme-a', owner: 'o', url: 'https://github.com/o/theme-a', category: 'theme', npm: null, description: {}, install: '', added: '' },
    { name: 'theme-b', owner: 'o', url: 'https://github.com/o/theme-b', category: 'theme', npm: null, description: {}, install: '', added: '' },
    { name: 'skin-pack', owner: 'o', url: 'https://github.com/o/skin-pack', category: 'theme', npm: null, description: {}, install: '', added: '' },
    { name: 'dshmarket', owner: 'dsh-market', url: 'https://github.com/dsh-market/dsh-market', category: 'tool', npm: 'dshmarket', description: {}, install: '', added: '' },
    // #27 shape: the same repo listed twice under different names.
    { name: 'dsh-share', owner: 'h', url: 'https://github.com/h/dsh-share', category: 'tool', npm: 'dsh-share', description: {}, install: '', added: '' },
    { name: '@dsh-external/dsh-share', owner: 'h', url: 'https://github.com/h/dsh-share', category: 'tool', npm: null, description: {}, install: '', added: '' },
    { name: 'dsh-security-audit', owner: 'omdsh-dev', url: 'https://github.com/omdsh-dev/dsh-security-audit', category: 'tool', npm: null, description: {}, install: '', added: '' },
    { name: 'dsh-blue-whale', owner: 'o', url: 'https://github.com/o/blue-whale', category: 'tool', npm: null, description: {}, install: '', added: '' },
    // Monorepo siblings: distinct plugins sharing one repo.
    { name: 'mono#plug-a', owner: 'm', url: 'https://github.com/m/mono/tree/main/packages/plug-a', category: 'tool', npm: null, description: {}, install: '', added: '' },
    { name: 'mono#plug-b', owner: 'm', url: 'https://github.com/m/mono/tree/main/packages/plug-b', category: 'tool', npm: null, description: {}, install: '', added: '' },
  ],
}
vi.mock('../src/registry.ts', () => ({
  loadRegistry: () => Promise.resolve({ registry: REGISTRY, source: 'snapshot' }),
}))

// ---------------------------------------------------------------- testbed
import { mountMarketRoutes } from '../src/routes.ts'
import { profileDir } from '../src/profile.ts'

type Handler = (request: unknown, response: unknown) => void | Promise<void>

interface Testbed {
  dispatch(method: string, path: string, body?: unknown, options?: { crossOrigin?: boolean; remoteAddress?: string; forwarded?: boolean }): Promise<{ status: number; json: any }>
  loaderEntries: { options: { name: string; disabled?: boolean | null }; fiber?: unknown; update(o: { disabled: boolean | null }): Promise<void> }[]
  dispose(): void
}

function createTestbed(config: { allowRestart?: boolean } = {}): Testbed {
  const routes = new Map<string, Handler>()
  const loaderEntries: Testbed['loaderEntries'] = []
  const host = {
    webServer: {
      register(route: { path: string; handler: Handler }) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    loader: { entries: () => loaderEntries },
    plugin: () => ({ await: () => Promise.resolve(), dispose: () => {} }),
    on: () => () => {},
  }
  const dispose = mountMarketRoutes(host as never, { profile: 'web', ...config })
  async function dispatch(method: string, path: string, body?: unknown, options?: { crossOrigin?: boolean }) {
    const handler = routes.get(path.split('?')[0])
    if (handler === undefined) throw new Error(`no route: ${path}`)
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const request = {
      method, url: path,
      headers: {
        host: 'localhost:3080',
        origin: options?.crossOrigin ? 'https://evil.example' : 'http://localhost:3080',
        ...(options?.forwarded ? { 'x-forwarded-for': '10.0.0.9' } : {}),
      },
      socket: { remoteAddress: options?.remoteAddress ?? '127.0.0.1' },
      async *[Symbol.asyncIterator]() { yield* chunks },
    }
    let status = 0
    let payload = ''
    const response = {
      writeHead(code: number) { status = code },
      end(text?: string) { payload = text ?? '' },
    }
    await handler(request, response)
    let json: any = null
    try { json = JSON.parse(payload) } catch { /* non-JSON (logs route) */ }
    return { status, json }
  }
  return { dispatch, loaderEntries, dispose }
}

// ---------------------------------------------------------------- suite
let home: string
let bed: Testbed

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshm-flow-'))
  process.env.DSH_HOME = home
  const dir = join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"dependencies":{}}')
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  fake.profileDir = dir
  fake.npm = {}
  fake.repos = {}
  fake.staleUpdates = false
  fake.hoistDiffTimes = 0
  fake.youngLockfile = false
  fake.gate = null
  fake.cancelNext = false
  fake.buildScriptOutputOnce = ''
  fake.running = false
  fake.calls = []
  restartCalls.count = 0
  hot.mounts = []
  hot.disabled = new Set()
  hot.failNext = false
  bed = createTestbed()
})
afterEach(() => {
  bed.dispose()
  vi.unstubAllGlobals()
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

function installedSpec(name: string): string | undefined {
  const manifest = JSON.parse(readFileSync(join(profileDir('web'), 'package.json'), 'utf8'))
  return manifest.dependencies?.[name]
}

describe('install flow', () => {
  it('installs a curated plugin end to end and reports it installed', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    const r = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.installed['dsh-loop']).toBe('^1.0.0')
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')
    // Refresh-free activation: the new plugin was hot mounted.
    expect(r.json.hot).toBe(true)
    // P0-2: the operation response carries the per-package activation state.
    expect(r.json.activation['dsh-loop']).toMatchObject({ state: 'live', hot: true })
    const listed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(listed.json.installed['dsh-loop']).toBe('^1.0.0')
    expect(listed.json.activation['dsh-loop'].state).toBe('live')
  })

  it('reports inert activation for a client-only plugin the host cannot hot-mount (P0-2)', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: { client: {} }, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    hot.failNext = true
    const r = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.hot).toBe(false)
    expect(r.json.activation['dsh-loop']).toMatchObject({ state: 'inert', hot: false, bundle: false })
    expect(r.json.activation['dsh-loop'].reasons.join(' ')).toMatch(/dsh\.bundle/)
  })

  it('refuses sources outside the curated registry and cross-origin posts', async () => {
    const outside = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/evil/mal' })
    expect(outside.status).toBe(400)
    const cross = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' }, { crossOrigin: true })
    expect(cross.status).toBe(403)
  })

  it('auto-recovers when the modules dir was built by another pnpm major (#20)', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    fake.hoistDiffTimes = 1
    const r = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    // add(fail) → install --no-frozen-lockfile → add(retry) …
    expect(fake.calls.slice(0, 3).map(c => c.filter(a => !a.startsWith('-')).join(' ')))
      .toEqual(['add dsh-loop', 'install', 'add dsh-loop'])
  })

  it('retargets a collection repo to its contained plugins via #path: (#18)', async () => {
    fake.repos['github:o/skin-pack'] = {
      name: 'skin-pack', manifest: { name: 'skin-pack', private: true }, junkChildren: ['whale-skin'],
    }
    fake.repos['github:o/skin-pack#path:/whale-skin'] = {
      name: 'whale-skin', manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'],
    }
    const r = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/skin-pack' })
    expect(r.status).toBe(200)
    expect(installedSpec('whale-skin')).toBeDefined()
    expect(installedSpec('skin-pack')).toBeUndefined()
  })
})

describe('update flow — no npm publishing required', () => {
  beforeEach(async () => {
    // Seed: dsh-loop 1.0.0 installed; fake npm later advances latest.
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
  })

  function advanceNpmLatest(version: string, publishedHoursAgo = 1): void {
    fake.npm['dsh-loop'].latest = version
    fake.npm['dsh-loop'].versions[version] = { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] }
    const publishedAt = new Date(Date.now() - publishedHoursAgo * 3_600_000).toISOString()
    vi.stubGlobal('fetch', (url: string) => {
      const u = String(url)
      if (u.endsWith('/latest') && u.includes('registry.npmjs.org')) {
        return Promise.resolve(new Response(JSON.stringify({ version }), { status: 200 }))
      }
      if (u.includes('registry.npmjs.org')) {
        // Full metadata doc: dist-tags + publish times (the #45 evidence check).
        return Promise.resolve(new Response(JSON.stringify({
          'dist-tags': { latest: version },
          time: { [version]: publishedAt },
        }), { status: 200 }))
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
    })
  }

  it('flags the update and applies it', async () => {
    advanceNpmLatest('1.2.0')
    const updates = await bed.dispatch('GET', '/dsh-market/updates?force=1')
    expect(updates.json.updates['dsh-loop']).toMatchObject({ kind: 'npm', current: '1.0.0', latest: '1.2.0', updateAvailable: true })
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(installedSpec('dsh-loop')).toBe('^1.2.0')
    expect(r.json.activation['dsh-loop']).toMatchObject({ state: 'live' })
  })

  it('never offers or performs a downgrade when the latest dist-tag is older (#64 by @ZeroOrigin64)', async () => {
    // A package whose `latest` tag was left on its first release while newer
    // prereleases shipped: latest 0.0.1 is BELOW the installed 1.0.0.
    advanceNpmLatest('0.0.1')
    const specBefore = installedSpec('dsh-loop')
    const updates = await bed.dispatch('GET', '/dsh-market/updates?force=1')
    expect(updates.json.updates['dsh-loop']).toMatchObject({ kind: 'npm', current: '1.0.0', latest: '0.0.1', updateAvailable: false })
    // Even called directly, the route refuses rather than rewriting the pin to `@latest`.
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(r.status).toBe(400)
    expect(String(r.json.error)).toContain('0.0.1')
    expect(installedSpec('dsh-loop')).toBe(specBefore)
    expect(fake.calls.some(c => c.includes('dsh-loop@latest'))).toBe(false)
  })

  it('surfaces the silent fresh-release hold as an actionable error, and force applies it (#22)', async () => {
    advanceNpmLatest('1.2.0') // published 1h ago — inside the safety window
    fake.staleUpdates = true // pnpm keeps 1.0.0 and exits 0
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(r.status).toBe(502)
    expect(r.json.ok).toBe(false)
    expect(r.json.stale).toBe(true)
    // Evidence-backed diagnosis (#45): the release really is young.
    expect(r.json.staleReason).toBe('release-age')
    expect(String(r.json.error)).toMatch(/立即更新|Update now/)
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')

    // The user clicks 「立即更新」: force bypasses the wait for THIS command only.
    fake.staleUpdates = false
    const forced = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop', force: true })
    expect(forced.status).toBe(200)
    expect(installedSpec('dsh-loop')).toBe('^1.2.0')
    const lastAdd = fake.calls[fake.calls.length - 1]
    expect(lastAdd).toContain('--config.minimumReleaseAge=0')
  })

  it('does NOT blame the safety wait when the target release is old — honest unknown-cause message (#45)', async () => {
    advanceNpmLatest('1.2.0', 27) // published 27h ago — OUTSIDE the ~24h window
    fake.staleUpdates = true // version still did not move
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(r.status).toBe(502)
    expect(r.json.stale).toBe(true)
    expect(r.json.staleReason).toBe('unknown')
    // No unfounded "just released, wait a day" story…
    expect(String(r.json.error)).not.toMatch(/刚发布|just released/)
    // …but still an actionable next step (retry usually resolves it).
    expect(String(r.json.error)).toMatch(/立即更新|Update now/)
  })
})

describe('theme flow', () => {
  beforeEach(async () => {
    for (const name of ['theme-a', 'theme-b']) {
      fake.repos[`github:o/${name}`] = { name, manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] }
      await bed.dispatch('POST', '/dsh-market/install', { url: `https://github.com/o/${name}` })
    }
  })

  it('installs auto-activate and use-skin keeps themes mutually exclusive', async () => {
    // Installing theme-b (the later one) deactivated theme-a.
    expect(hot.mounts).toEqual(['theme-b'])
    expect(hot.disabled.has('theme-a')).toBe(true)
    // Switch back to theme-a via the UI.
    const r = await bed.dispatch('POST', '/dsh-market/use-skin', { name: 'theme-a' })
    expect(r.status).toBe(200)
    expect(hot.mounts).toEqual(['theme-a'])
    expect(hot.disabled.has('theme-b')).toBe(true)
    expect(hot.disabled.has('theme-a')).toBe(false)
  })

  it('rejects use-skin for non-theme or uninstalled packages', async () => {
    expect((await bed.dispatch('POST', '/dsh-market/use-skin', { name: 'dsh-loop' })).status).toBe(400)
    expect((await bed.dispatch('POST', '/dsh-market/use-skin', { name: 'ghost' })).status).toBe(400)
  })
})

describe('uninstall flow', () => {
  it('removes the plugin (live when hot mounted) and protects the market itself', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    const r = await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })
    expect(r.status).toBe(200)
    expect(r.json.hot).toBe(true)
    expect(installedSpec('dsh-loop')).toBeUndefined()
    expect(hot.mounts).toEqual([])

    expect((await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dshmarket' })).status).toBe(400)
    expect((await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'ghost' })).status).toBe(400)
  })

  it('uninstall succeeds even when the lockfile holds a too-young release (#39)', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    // pnpm 11 verifies the WHOLE lockfile before any mutation; a package
    // published inside the safety window fails that check and bricks every
    // later add/remove until the one-shot override is passed.
    fake.youngLockfile = true
    const r = await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(installedSpec('dsh-loop')).toBeUndefined()
    const removes = fake.calls.filter(c => c[0] === 'remove')
    expect(removes[removes.length - 1]).toContain('--config.minimumReleaseAge=0')
  })
})

describe('duplicate alias guard (#27)', () => {
  it('refuses installing the same repo again under another catalog name', async () => {
    fake.npm['dsh-share'] = { latest: '0.2.0', versions: { '0.2.0': { manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] } } }
    expect((await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/h/dsh-share' })).status).toBe(200)
    // The alias entry (same repo, different display name) must be rejected —
    // a second install would create a duplicate loader entry id and brick boot.
    const dup = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/h/dsh-share' })
    expect(dup.status).toBe(400)
    expect(String(dup.json.error)).toContain('dsh-share')
  })

  it('does NOT block sibling subpackages of one monorepo', async () => {
    fake.repos['github:m/mono#path:/packages/plug-a'] = { name: 'plug-a', manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] }
    fake.repos['github:m/mono#path:/packages/plug-b'] = { name: 'plug-b', manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] }
    expect((await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/m/mono/tree/main/packages/plug-a' })).status).toBe(200)
    const second = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/m/mono/tree/main/packages/plug-b' })
    expect(second.status).toBe(200)
    expect(installedSpec('plug-a')).toBeDefined()
    expect(installedSpec('plug-b')).toBeDefined()
  })
})

describe('market self-update', () => {
  it('the market updates itself through the same flow', async () => {
    fake.npm['dshmarket'] = { latest: '1.0.3', versions: { '1.0.3': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/dsh-market/dsh-market' })
    fake.npm['dshmarket'].latest = '1.2.3'
    fake.npm['dshmarket'].versions['1.2.3'] = { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] }
    vi.stubGlobal('fetch', (url: string) => String(url).includes('registry.npmjs.org')
      ? Promise.resolve(new Response(JSON.stringify({ version: '1.2.3' }), { status: 200 }))
      : Promise.reject(new Error('unexpected fetch')))
    const updates = await bed.dispatch('GET', '/dsh-market/updates?force=1')
    expect(updates.json.updates['dshmarket'].updateAvailable).toBe(true)
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dshmarket' })
    expect(r.status).toBe(200)
    expect(installedSpec('dshmarket')).toBe('^1.2.3')
  })
})

describe('theme update and uninstall', () => {
  beforeEach(async () => {
    fake.repos['github:o/theme-a'] = { name: 'theme-a', manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/theme-a' })
  })

  it('updates a github-installed theme by re-resolving its repo', async () => {
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'theme-a' })
    expect(r.status).toBe(200)
    expect(fake.calls[fake.calls.length - 1]).toContain('github:o/theme-a')
  })

  it('uninstalls the active theme and clears its live mount', async () => {
    expect(hot.mounts).toEqual(['theme-a'])
    const r = await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'theme-a' })
    expect(r.status).toBe(200)
    expect(hot.mounts).toEqual([])
    expect(installedSpec('theme-a')).toBeUndefined()
  })
})

describe('concurrency', () => {
  it('a second install while one is running is refused with 409', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    let release!: () => void
    fake.gate = new Promise<void>((resolvePromise) => { release = resolvePromise })
    const first = bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20)) // let it enter the executor
    const second = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/theme-a' })
    expect(second.status).toBe(409)
    release()
    fake.gate = null
    expect((await first).status).toBe(200)
  })
})

describe('cancel flow (#6)', () => {
  it('cancelling a running install ends it quietly (200 + cancelled, no error)', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    let release!: () => void
    fake.gate = new Promise<void>((resolvePromise) => { release = resolvePromise })
    const install = bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
    const cancel = await bed.dispatch('POST', '/dsh-market/cancel', {})
    expect(cancel.status).toBe(200)
    expect(cancel.json.cancelled).toBe(true)
    release()
    fake.gate = null
    const result = await install
    expect(result.status).toBe(200)
    expect(result.json.ok).toBe(false)
    expect(result.json.cancelled).toBe(true)
    // The fake cancels before acting — nothing was written, so not partial.
    expect(result.json.partial).toBe(false)
    expect(result.json.changed).toEqual([])
    expect(installedSpec('dsh-loop')).toBeUndefined()
  })

  it('cancel with nothing running is a 400', async () => {
    expect((await bed.dispatch('POST', '/dsh-market/cancel', {})).status).toBe(400)
  })
})

describe('build-script approval flow (#6)', () => {
  it('surfaces ignored builds, approve-builds allows only installed packages, and the retry succeeds', async () => {
    fake.npm['dsh-loop'] = {
      latest: '1.0.0',
      versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } },
    }
    fake.buildScriptOutputOnce = 'Ignored build scripts: dsh-loop@1.0.0.'
    const first = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(first.json.ignoredBuilds).toEqual(['dsh-loop'])

    // Approval writes allowBuilds into the profile's pnpm-workspace.yaml…
    const approve = await bed.dispatch('POST', '/dsh-market/approve-builds', { packages: ['dsh-loop', 'ghost-package'] })
    expect(approve.status).toBe(200)
    expect(approve.json.approved).toContain('dsh-loop')
    expect(approve.json.approved).not.toContain('ghost-package')
    const yaml = readFileSync(join(profileDir('web'), 'pnpm-workspace.yaml'), 'utf8')
    expect(yaml).toMatch(/allowBuilds:[\s\S]*dsh-loop: true/)
    // …and the original workspace settings survive.
    expect(yaml).toContain('packages:')
  })

  it('approves TRANSITIVE build deps — in node_modules but not in package.json (#56)', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    // pnpm's blocked build scripts are usually transitive deps (cloudflared,
    // ssh2, cpu-features…) — hoisted into node_modules, absent from the
    // profile's dependencies map.
    mkdirSync(join(profileDir('web'), 'node_modules', 'cloudflared'), { recursive: true })
    writeFileSync(join(profileDir('web'), 'node_modules', 'cloudflared', 'package.json'), '{"name":"cloudflared"}')
    const approve = await bed.dispatch('POST', '/dsh-market/approve-builds', { packages: ['cloudflared', '../evil', 'ghost-package'] })
    expect(approve.status).toBe(200)
    expect(approve.json.approved).toContain('cloudflared')
    expect(approve.json.approved).not.toContain('../evil')
    expect(approve.json.approved).not.toContain('ghost-package')
    const yaml = readFileSync(join(profileDir('web'), 'pnpm-workspace.yaml'), 'utf8')
    expect(yaml).toMatch(/allowBuilds:[\s\S]*cloudflared: true/)
  })
})

describe('official-scope community plugins (#28)', () => {
  it('installs and lists a community plugin named under @deepseek-ai/', async () => {
    fake.repos['github:omdsh-dev/dsh-security-audit'] = {
      name: '@deepseek-ai/dsh-security-audit',
      manifest: { name: '@deepseek-ai/dsh-security-audit', dsh: {}, main: 'lib/index.js' },
      artifacts: ['lib/index.js'],
    }
    const r = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/omdsh-dev/dsh-security-audit' })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.installed['@deepseek-ai/dsh-security-audit']).toBeDefined()
    const listed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(listed.json.installed['@deepseek-ai/dsh-security-audit']).toBeDefined()
  })
})

describe('externally removed hot mounts (#29)', () => {
  it('drops a live mount whose package was removed outside the market', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(hot.mounts).toEqual(['dsh-loop'])
    // Simulate `dsh plugin remove` outside the market: dep + files gone,
    // the in-memory hot mount left behind.
    const manifest = JSON.parse(readFileSync(join(profileDir('web'), 'package.json'), 'utf8'))
    delete manifest.dependencies['dsh-loop']
    writeFileSync(join(profileDir('web'), 'package.json'), JSON.stringify(manifest))
    rmSync(join(profileDir('web'), 'node_modules', 'dsh-loop'), { recursive: true, force: true })

    const listed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(listed.json.live).toEqual([])
    expect(hot.mounts).toEqual([])
  })
})

describe('one-click restart guards (#14)', () => {
  it('schedules exactly once for a trusted loopback request; repeat is 409', async () => {
    const r = await bed.dispatch('POST', '/dsh-market/restart', {})
    expect(r.status).toBe(202)
    expect(r.json.ok).toBe(true)
    expect(restartCalls.count).toBe(1)
    expect((await bed.dispatch('POST', '/dsh-market/restart', {})).status).toBe(409)
    expect(restartCalls.count).toBe(1)
  })

  it('refuses non-loopback peers, forwarded requests, and cross-origin posts', async () => {
    expect((await bed.dispatch('POST', '/dsh-market/restart', {}, { remoteAddress: '192.168.1.7' })).status).toBe(403)
    expect((await bed.dispatch('POST', '/dsh-market/restart', {}, { forwarded: true })).status).toBe(403)
    expect((await bed.dispatch('POST', '/dsh-market/restart', {}, { crossOrigin: true })).status).toBe(403)
    expect(restartCalls.count).toBe(0)
  })

  it('refuses while a plugin operation is running', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    let release!: () => void
    fake.gate = new Promise<void>((resolvePromise) => { release = resolvePromise })
    const install = bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
    expect((await bed.dispatch('POST', '/dsh-market/restart', {})).status).toBe(409)
    release()
    fake.gate = null
    await install
  })

  it('allowRestart: false disables the endpoint and the status capability flag', async () => {
    bed.dispose()
    bed = createTestbed({ allowRestart: false })
    expect((await bed.dispatch('GET', '/dsh-market/status')).json.restart).toBe(false)
    expect((await bed.dispatch('POST', '/dsh-market/restart', {})).status).toBe(403)
    expect(restartCalls.count).toBe(0)
  })
})

describe('bundle-layer uninstall live-disable (#37)', () => {
  it('uninstalling a bundle-layer plugin disables its live loader entry so refresh survives', async () => {
    fake.npm['dsh-blue-whale'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    // Bundle-layer plugins never hot-mount; simulate the live loader entry
    // the running host still holds for it.
    fake.repos['github:o/blue-whale'] = { name: 'dsh-blue-whale', manifest: { dsh: { bundle: { patch: './x.yml' } }, main: 'lib/index.js' }, artifacts: ['lib/index.js'] }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/blue-whale' })
    hot.mounts = [] // bundle-layer: not a hot mount
    const entry = {
      options: { id: 'dsh-blue-whale', name: 'dsh-blue-whale', disabled: null as boolean | null },
      fiber: {} as unknown,
      update: vi.fn(async (options: { disabled: boolean | null }) => {
        entry.options.disabled = options.disabled
        if (options.disabled === true) entry.fiber = undefined
      }),
    }
    bed.loaderEntries.push(entry)

    // The live loader fiber (bundle layer loaded at boot) reads as live too —
    // without it, every boot-loaded bundle plugin would claim "restart".
    const before = await bed.dispatch('GET', '/dsh-market/installed')
    expect(before.json.activation['dsh-blue-whale'].state).toBe('live')

    const r = await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-blue-whale' })
    expect(r.status).toBe(200)
    // The live entry must be down — otherwise the next refresh 404s on the
    // deleted client bundle and the whole page wedges until a dsh restart.
    expect(entry.options.disabled).toBe(true)
    expect(entry.fiber).toBeUndefined()
    expect(r.json.hot).toBe(true)
  })
})
