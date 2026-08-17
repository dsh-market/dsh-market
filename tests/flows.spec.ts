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
/** Fail the next add with exit 1 and this stderr (e.g. ERR_PNPM_IGNORED_BUILDS, #68/#69). */
  failNextAddStderrOnce: '',
  /**
   * Fail the next npm add with exit 1 and this stderr AFTER writing
   * package.json/node_modules — pnpm's real order (#65, #69): the manifest
   * is written before registry fetches and the build-script check run.
   */
  failAfterWriteStderrOnce: '',
  /** Make restore's bulk install fail so its per-plugin fallback is exercised. */
  failInstallOnce: false,
  captureBundlesOnNextAdd: false,
  bundlesBeforeFallbackAdd: null as string[] | null,
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
    if (cmd === 'install') {
      if (fake.failInstallOnce) {
        fake.failInstallOnce = false
        return { ...ok, exitCode: 1, stderr: 'dsh: pnpm failed in profile directory' }
      }
      return ok
    }
    if (cmd === 'add' && fake.captureBundlesOnNextAdd) {
      fake.captureBundlesOnNextAdd = false
      const manifest = readManifest() as { dsh?: { profile?: { bundles?: string[] } } }
      fake.bundlesBeforeFallbackAdd = [...(manifest.dsh?.profile?.bundles ?? [])]
    }
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
    if (fake.failNextAddStderrOnce !== '') {
      const stderr = fake.failNextAddStderrOnce
      fake.failNextAddStderrOnce = ''
      return { exitCode: 1, timedOut: false, stdout: '', stderr, cancelled: false }
    }
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
    if (fake.failAfterWriteStderrOnce !== '') {
      const stderr = fake.failAfterWriteStderrOnce
      fake.failAfterWriteStderrOnce = ''
      return { exitCode: 1, timedOut: false, stdout: '', stderr, cancelled: false }
    }
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
const hot = vi.hoisted(() => ({
  mounts: [] as string[],
  disabled: new Set<string>(),
  groups: {} as Record<string, string[]>,
  groupOrder: [] as string[],
  failNext: false,
}))
vi.mock('../src/hot.ts', () => ({
  cleanHotDir: () => {},
  readDisabledThemes: () => hot.disabled,
  writeDisabledThemes: (_dir: string, set: Set<string>) => { hot.disabled = new Set(set) },
  readDisabled: () => hot.disabled,
  writeDisabled: (_dir: string, set: Set<string>) => { hot.disabled = new Set(set) },
  readMarketState: () => ({ disabled: hot.disabled, groups: hot.groups, groupOrder: hot.groupOrder }),
  writeMarketState: (_dir: string, state: { disabled: Set<string>; groups: Record<string, string[]>; groupOrder: string[] }) => {
    hot.disabled = new Set(state.disabled)
    hot.groups = state.groups
    hot.groupOrder = state.groupOrder
  },
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
    { name: 'dsh-excel-chat', owner: 'hccccc01333', url: 'https://github.com/hccccc01333/dsh-excel-chat', category: 'tool', npm: null, description: {}, install: '', added: '' },
    { name: 'dshmarket', owner: 'dsh-market', url: 'https://github.com/dsh-market/dsh-market', category: 'tool', npm: 'dshmarket', description: {}, install: '', added: '' },
    // #27 shape: the same repo listed twice under different names.
    { name: 'dsh-share', owner: 'h', url: 'https://github.com/h/dsh-share', category: 'tool', npm: 'dsh-share', description: {}, install: '', added: '' },
    { name: '@dsh-external/dsh-share', owner: 'h', url: 'https://github.com/h/dsh-share', category: 'tool', npm: null, description: {}, install: '', added: '' },
    { name: 'dsh-security-audit', owner: 'omdsh-dev', url: 'https://github.com/omdsh-dev/dsh-security-audit', category: 'tool', npm: null, description: {}, install: '', added: '' },
    // #66 shape: two DISTINCT plugins listed under one name (real examples:
    // dsh-usage-stats ×2, dsh-memory ×4 in the live registry).
    { name: 'dsh-usage-stats', owner: 'a1', url: 'https://github.com/a1/dsh-usage-stats', category: 'tool', npm: null, description: {}, install: '', added: '' },
    { name: 'dsh-usage-stats', owner: 'a2', url: 'https://github.com/a2/dsh-usage-stats', category: 'tool', npm: null, description: {}, install: '', added: '' },
    { name: 'dsh-blue-whale', owner: 'o', url: 'https://github.com/o/blue-whale', category: 'tool', npm: null, description: {}, install: '', added: '' },
    { name: 'dsh-patchy', owner: 'o', url: 'https://github.com/o/dsh-patchy', category: 'tool', npm: null, description: {}, install: '', added: '' },
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

function createTestbed(
  config: { profile?: string; allowRestart?: boolean; profileDirectory?: string } = {},
  runtime?: Parameters<typeof mountMarketRoutes>[2],
): Testbed {
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
  const dispose = mountMarketRoutes(host as never, { profile: 'web', ...config }, runtime)
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
  fake.failNextAddStderrOnce = ''
  fake.failAfterWriteStderrOnce = ''
  fake.failInstallOnce = false
  fake.captureBundlesOnNextAdd = false
  fake.bundlesBeforeFallbackAdd = null
  fake.running = false
  fake.calls = []
  restartCalls.count = 0
  hot.mounts = []
  hot.disabled = new Set()
  hot.groups = {}
  hot.groupOrder = []
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

describe('host-provided profile and package-operation seams', () => {
  it('uses the explicit profile directory and injected status/setup/cancel operations', async () => {
    bed.dispose()
    const explicitDir = join(home, 'desktop-owned-profile')
    mkdirSync(explicitDir, { recursive: true })
    writeFileSync(join(explicitDir, 'package.json'), '{"dependencies":{"desktop-only":"1.0.0"}}')
    writeFileSync(join(explicitDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    fake.profileDir = explicitDir
    const probe = vi.fn(() => Promise.resolve(true))
    const provision = vi.fn(() => Promise.resolve({ ok: true }))
    const cancel = vi.fn(() => true)
    bed = createTestbed(
      { profile: '工作 profile', profileDirectory: explicitDir, allowRestart: false },
      { runPlugin: vi.fn() as never, probePnpm: probe, provisionPnpm: provision, cancelActive: cancel },
    )

    const installed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(installed.json).toMatchObject({
      profile: '工作 profile',
      installed: { 'desktop-only': '1.0.0' },
    })
    const exported = await bed.dispatch('GET', '/dsh-market/backup')
    const exportedManifest = exported.json.files.find((file: { path: string }) => file.path === 'package.json')
    expect(exportedManifest.json.dependencies).toEqual({ 'desktop-only': '1.0.0' })
    const status = await bed.dispatch('GET', '/dsh-market/status')
    expect(status.json).toMatchObject({ pnpm: true, restart: false, installed: { 'desktop-only': '1.0.0' } })
    expect(probe).toHaveBeenCalledOnce()
    expect((await bed.dispatch('POST', '/dsh-market/setup-pnpm', {})).json.ok).toBe(true)
    expect(provision).toHaveBeenCalledOnce()
    expect((await bed.dispatch('POST', '/dsh-market/cancel', {})).status).toBe(200)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('maps a generation-wide Desktop package-operation gate to conflict', async () => {
    bed.dispose()
    bed = createTestbed({}, {
      runPlugin: () => Promise.resolve({
        exitCode: 127,
        timedOut: false,
        stdout: '',
        stderr: 'another desktop pnpm operation is already running',
        cancelled: false,
        busy: true,
      }),
      probePnpm: () => Promise.resolve(true),
      provisionPnpm: () => Promise.resolve({ ok: true }),
      cancelActive: () => false,
    })

    const result = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(result.status).toBe(409)
    expect(result.json).toMatchObject({ ok: false, busy: true })
  })

  it('writes build approvals and git keys only in the host-authoritative Desktop profile', async () => {
    bed.dispose()
    const explicitDir = join(home, 'desktop-owned-profile')
    mkdirSync(join(explicitDir, 'node_modules', 'dsh-blue-whale'), { recursive: true })
    writeFileSync(join(explicitDir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-blue-whale': 'github:o/blue-whale' },
    }))
    writeFileSync(join(explicitDir, 'node_modules', 'dsh-blue-whale', 'package.json'), '{"name":"dsh-blue-whale"}')
    writeFileSync(join(explicitDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    fake.profileDir = explicitDir
    bed = createTestbed({ profile: '工作 profile', profileDirectory: explicitDir, allowRestart: false })

    const approve = await bed.dispatch('POST', '/dsh-market/approve-builds', { packages: ['dsh-blue-whale'] })
    expect(approve.status).toBe(200)
    expect(approve.json.approved).toContain('dsh-blue-whale')
    expect(approve.json.approved).toContain('dsh-blue-whale@git+https://github.com/o/blue-whale.git')
    const desktopYaml = readFileSync(join(explicitDir, 'pnpm-workspace.yaml'), 'utf8')
    expect(desktopYaml).toContain('dsh-blue-whale@git+https://github.com/o/blue-whale.git: true')
    expect(readFileSync(join(profileDir('web'), 'pnpm-workspace.yaml'), 'utf8')).not.toContain('dsh-blue-whale')
  })

  it('rolls a failed Desktop install back in the host-authoritative profile only', async () => {
    bed.dispose()
    const explicitDir = join(home, 'desktop-owned-profile')
    mkdirSync(explicitDir, { recursive: true })
    writeFileSync(join(explicitDir, 'package.json'), JSON.stringify({ dependencies: { 'desktop-only': '1.0.0' } }))
    writeFileSync(join(explicitDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    fake.profileDir = explicitDir
    fake.npm['dsh-loop'] = {
      latest: '1.0.0',
      versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } },
    }
    fake.failAfterWriteStderrOnce = '[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/ghost: Not Found - 404'
    bed = createTestbed({ profile: '工作 profile', profileDirectory: explicitDir, allowRestart: false })

    const result = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(result.status).toBe(502)
    const desktopManifest = JSON.parse(readFileSync(join(explicitDir, 'package.json'), 'utf8'))
    expect(desktopManifest.dependencies).toEqual({ 'desktop-only': '1.0.0' })
    const ordinaryManifest = JSON.parse(readFileSync(join(profileDir('web'), 'package.json'), 'utf8'))
    expect(ordinaryManifest.dependencies).toEqual({})
  })

  it('restores the previous Desktop pin when an update fails after a partial manifest write', async () => {
    bed.dispose()
    const explicitDir = join(home, 'desktop-owned-profile')
    mkdirSync(join(explicitDir, 'node_modules', 'dsh-loop'), { recursive: true })
    writeFileSync(join(explicitDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-loop': '^1.0.0' } }))
    writeFileSync(join(explicitDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    writeFileSync(join(explicitDir, 'node_modules', 'dsh-loop', 'package.json'), JSON.stringify({
      name: 'dsh-loop', version: '1.0.0', dsh: {}, main: 'lib/index.js',
    }))
    fake.profileDir = explicitDir
    fake.npm['dsh-loop'] = {
      latest: '1.2.0',
      versions: { '1.2.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } },
    }
    fake.failAfterWriteStderrOnce = '[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/ghost: Not Found - 404'
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ version: '1.2.0' }), { status: 200 })))
    bed = createTestbed({ profile: '工作 profile', profileDirectory: explicitDir, allowRestart: false })

    const result = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(result.status).toBe(502)
    const desktopManifest = JSON.parse(readFileSync(join(explicitDir, 'package.json'), 'utf8'))
    expect(desktopManifest.dependencies).toEqual({ 'dsh-loop': '^1.0.0' })
    const ordinaryManifest = JSON.parse(readFileSync(join(profileDir('web'), 'package.json'), 'utf8'))
    expect(ordinaryManifest.dependencies).toEqual({})
  })

  it('applies the same-name different-repo guard to the host-authoritative Desktop profile', async () => {
    bed.dispose()
    const explicitDir = join(home, 'desktop-owned-profile')
    mkdirSync(explicitDir, { recursive: true })
    writeFileSync(join(explicitDir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-usage-stats': 'github:a1/dsh-usage-stats' },
    }))
    writeFileSync(join(explicitDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    fake.profileDir = explicitDir
    bed = createTestbed({ profile: '工作 profile', profileDirectory: explicitDir, allowRestart: false })

    const result = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/a2/dsh-usage-stats' })
    expect(result.status).toBe(400)
    expect(String(result.json.error)).toContain('同名冲突')
    expect(fake.calls).toEqual([])
    const desktopManifest = JSON.parse(readFileSync(join(explicitDir, 'package.json'), 'utf8'))
    expect(desktopManifest.dependencies['dsh-usage-stats']).toBe('github:a1/dsh-usage-stats')
  })
})

describe('backup and restore (#55)', () => {
  it('exports profile config, restores it, and reinstalls the dependency list', async () => {
    writeFileSync(join(profileDir('web'), 'cordis.patch.yml'), '- config: original')
    const exported = await bed.dispatch('GET', '/dsh-market/backup')
    expect(exported.status).toBe(200)
    expect(exported.json.format).toBe('dsh-profile-backup')
    expect(exported.json.files.some((file: { path: string }) => file.path === 'pnpm-lock.yaml')).toBe(false)

    writeFileSync(join(profileDir('web'), 'cordis.patch.yml'), '- config: changed')
    const restored = await bed.dispatch('POST', '/dsh-market/restore', { backup: exported.json })
    expect(restored.status).toBe(200)
    expect(restored.json.ok).toBe(true)
    expect(readFileSync(join(profileDir('web'), 'cordis.patch.yml'), 'utf8')).toBe('- config: original')
    expect(fake.calls.at(-1)?.[0]).toBe('install')
  })

  it('rejects cross-origin restore requests', async () => {
    expect((await bed.dispatch('POST', '/dsh-market/restore', { backup: {} }, { crossOrigin: true })).status).toBe(403)
  })

  it('continues with remaining plugins when one dependency fails', async () => {
    const exported = await bed.dispatch('GET', '/dsh-market/backup')
    const manifest = exported.json.files.find((file: { path: string }) => file.path === 'package.json').json
    manifest.dependencies = { missing: '^1.0.0', 'dsh-loop': '^1.0.0' }
    manifest.dsh = { profile: { bundles: ['missing', 'dsh-loop'] } }
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    fake.failInstallOnce = true
    fake.captureBundlesOnNextAdd = true

    const restored = await bed.dispatch('POST', '/dsh-market/restore', { backup: exported.json })
    expect(restored.status).toBe(200)
    expect(restored.json.errors).toEqual([expect.objectContaining({ name: 'missing' })])
    expect(installedSpec('missing')).toBeUndefined()
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')
    expect(fake.bundlesBeforeFallbackAdd).toEqual([])
    const finalManifest = JSON.parse(readFileSync(join(profileDir('web'), 'package.json'), 'utf8'))
    expect(finalManifest.dsh.profile.bundles).toEqual(['dsh-loop'])
    // install fails once (store probe), add of the missing dep fails (store
    // probe again), then dsh-loop adds cleanly.
    expect(fake.calls.slice(-5).map(call => call[0])).toEqual(['install', 'store', 'add', 'store', 'add'])
  })
})

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

  it('reports host contracts declared as normal dependencies without rejecting the plugin', async () => {
    fake.npm['dsh-loop'] = {
      latest: '1.0.0',
      versions: {
        '1.0.0': {
          manifest: {
            dsh: {},
            main: 'lib/index.js',
            dependencies: {
              '@deepseek-ai/dsh-attachment': '^0.0.1-rc.1',
              '@deepseek-ai/dsh-llm': '^0.0.1-rc.1',
              '@deepseek-ai/dsh-system-prompt': '^0.0.1-rc.1',
              '@deepseek-ai/dsh-tools': '^0.0.1-rc.1',
            },
          },
          artifacts: ['lib/index.js'],
        },
      },
    }

    const installed = await bed.dispatch('POST', '/dsh-market/install', {
      url: 'https://github.com/o/dsh-loop',
    })
    expect(installed.status).toBe(200)
    expect(installed.json.ok).toBe(true)
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')
    expect(fake.calls.some(call => call[0] === 'remove' && call[1] === 'dsh-loop')).toBe(false)

    const profileManifest = JSON.parse(readFileSync(join(fake.profileDir, 'package.json'), 'utf8'))
    profileManifest.dependencies['plain-helper'] = '^1.0.0'
    writeFileSync(join(fake.profileDir, 'package.json'), JSON.stringify(profileManifest))
    mkdirSync(join(fake.profileDir, 'node_modules', 'plain-helper'), { recursive: true })
    writeFileSync(join(fake.profileDir, 'node_modules', 'plain-helper', 'package.json'), JSON.stringify({
      name: 'plain-helper',
      dependencies: { '@deepseek-ai/cordis': '^4.0.1' },
    }))

    const profilePath = join(fake.profileDir, 'package.json')
    const pluginPath = join(fake.profileDir, 'node_modules', 'dsh-loop', 'package.json')
    const profileBefore = readFileSync(profilePath)
    const pluginBefore = readFileSync(pluginPath)
    const listed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(listed.json.diagnostics.schema).toBe('dsh-market/diagnostics/v1')
    expect(listed.json.diagnostics.findings).toHaveLength(4)
    expect(listed.json.diagnostics.findings).toContainEqual(expect.objectContaining({
      code: 'shared-host-package-dependency',
      subject: { kind: 'package', name: 'dsh-loop' },
      evidence: {
        basis: 'manifest-declaration',
        dependency: '@deepseek-ai/dsh-tools',
        declaredRange: '^0.0.1-rc.1',
        declaredIn: 'dependencies',
      },
    }))
    expect(listed.json.diagnostics.findings.some((finding: { subject: { name: string } }) =>
      finding.subject.name === 'plain-helper',
    )).toBe(false)
    expect(readFileSync(profilePath)).toEqual(profileBefore)
    expect(readFileSync(pluginPath)).toEqual(pluginBefore)
  })

  it('does not diagnose in-box bundles hidden from the community installed set', async () => {
    const profilePath = join(fake.profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(profilePath, 'utf8'))
    manifest.dependencies['@deepseek-ai/dsh-base'] = '0.1.0-rc.6'
    writeFileSync(profilePath, JSON.stringify(manifest))
    const baseDir = join(fake.profileDir, 'node_modules', '@deepseek-ai', 'dsh-base')
    mkdirSync(baseDir, { recursive: true })
    writeFileSync(join(baseDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-base',
      version: '0.1.0-rc.6',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      dependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.6' },
    }))

    const listed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(listed.json.installed['@deepseek-ai/dsh-base']).toBeUndefined()
    expect(listed.json.diagnostics.findings).toEqual([])
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

  it('rolls back manifest residue when the add fails after pnpm wrote package.json (#65)', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    // pnpm writes the manifest, then fails resolving another (ghost/private)
    // direct dependency — the classic #65 shape.
    fake.failAfterWriteStderrOnce = '[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/@deepseek-ai%2Fdsh-client-ui-theme-toggle: Not Found - 404'
    const r = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(r.status).toBe(502)
    // The failed run's manifest write is rolled back — no ghost entry left
    // to break every later pnpm operation.
    expect(installedSpec('dsh-loop')).toBeUndefined()
    // The classification names the unresolvable package, decoded.
    expect(String(r.json.stderr)).toContain('@deepseek-ai/dsh-client-ui-theme-toggle')
    expect(String(r.json.stderr)).toContain('幽灵依赖')
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

  it('inspects the current dsh-excel-chat bundle after collection retargeting', async () => {
    fake.repos['github:hccccc01333/dsh-excel-chat'] = {
      name: 'vera',
      manifest: {
        name: 'vera',
        version: '0.34.1',
        private: true,
        dependencies: {
          '@deepseek-ai/cordis': '^4.0.1',
          exceljs: '^4.4.0',
          fflate: '^0.8.3',
        },
      },
      junkChildren: ['bundle'],
    }
    fake.repos['github:hccccc01333/dsh-excel-chat#path:/bundle'] = {
      name: 'dsh-excel-chat',
      manifest: {
        name: 'dsh-excel-chat',
        version: '0.34.1',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        main: 'dist/index.js',
        dependencies: { exceljs: '^4.4.0', fflate: '^0.8.3' },
        peerDependencies: {
          '@deepseek-ai/cordis': '^4.0.1',
          '@deepseek-ai/dsh-attachment': '^0.1.0-rc.6',
          '@deepseek-ai/dsh-llm': '^0.1.0-rc.6',
          '@deepseek-ai/dsh-system-prompt': '^0.1.0-rc.6',
          '@deepseek-ai/dsh-tools': '^0.1.0-rc.6',
        },
      },
      artifacts: ['dist/index.js'],
    }

    const installed = await bed.dispatch('POST', '/dsh-market/install', {
      url: 'https://github.com/hccccc01333/dsh-excel-chat',
    })
    expect(installed.status).toBe(200)
    expect(installedSpec('vera')).toBeUndefined()
    expect(installedSpec('dsh-excel-chat')).toBeDefined()

    const listed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(listed.json.diagnostics.schema).toBe('dsh-market/diagnostics/v1')
    expect(listed.json.diagnostics.findings).toEqual([])
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

  it('restores the previous pin when an update fails after pnpm wrote the bumped spec (#65)', async () => {
    advanceNpmLatest('1.2.0')
    fake.failAfterWriteStderrOnce = '[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/some-ghost-dep: Not Found - 404'
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(r.status).toBe(502)
    // pnpm had already bumped the spec to ^1.2.0 before failing; the
    // rollback restores the pre-update pin.
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')
  })

  it('surfaces blocked build scripts during an update so the approve banner can retry it (#69)', async () => {
    advanceNpmLatest('1.2.0')
    // A leftover invalid allowBuilds entry (pnpm's placeholder bug, #56)
    // makes the update's `add` re-evaluate a git-hosted dep and hard-fail.
    fake.failNextAddStderrOnce = '[ERR_PNPM_IGNORED_BUILDS]\nIgnored build scripts: dsh-github-intelligence@https://codeload.github.com/zoahdev/dsh-github-intelligence/tar.gz/abc123.'
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(r.status).toBe(502)
    expect(r.json.ok).toBe(false)
    // The blocked package (bare name), so the client shows approve-and-retry.
    expect(r.json.ignoredBuilds).toEqual(['dsh-github-intelligence'])
    // The bilingual classification is appended to the raw stack.
    expect(String(r.json.stderr)).toContain('允许构建脚本并重试')
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

  it('refuses a same-named plugin from a DIFFERENT repo with an honest name-conflict error (#66)', async () => {
    fake.repos['github:a1/dsh-usage-stats'] = { name: 'dsh-usage-stats', manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] }
    const first = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/a1/dsh-usage-stats' })
    expect(first.json.ok).toBe(true)
    // The other same-named plugin is NOT "the same plugin already installed"
    // (that message would be a lie) — but pnpm would silently replace a1's
    // dependency entry, so the install is refused as a name conflict.
    const second = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/a2/dsh-usage-stats' })
    expect(second.status).toBe(400)
    expect(String(second.json.error)).toContain('同名冲突')
    // a1's install is untouched.
    expect(installedSpec('dsh-usage-stats')).toBe('github:a1/dsh-usage-stats')
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

  it('status reports the route-level operation lock as busy while an install is in flight (#91)', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    let release!: () => void
    fake.gate = new Promise<void>((resolvePromise) => { release = resolvePromise })
    const install = bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
    // The window #91 hit: the fake runner is "idle" from the progress
    // tracker's view, but the route still holds the lock — status must say
    // busy so the client neither offers restart nor declares the install done.
    const during = await bed.dispatch('GET', '/dsh-market/status')
    expect(during.json.busy).toBe(true)
    release()
    fake.gate = null
    await install
    const after = await bed.dispatch('GET', '/dsh-market/status')
    expect(after.json.busy).toBe(false)
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

  it('surfaces a git-prepare rejection and approves the not-yet-installed package via the curated registry (#68)', async () => {
    // pnpm's fetcher rejects a git-hosted package with a prepare script
    // BEFORE it lands in node_modules — nothing to existsSync against.
    fake.failNextAddStderrOnce = '[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from "https://codeload.github.com/omdsh-dev/dsh-security-audit/tar.gz/abc123": The git-hosted package "dsh-security-audit@2.8.0" needs to execute build scripts but is not in the "allowBuilds" allowlist.'
    const first = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/omdsh-dev/dsh-security-audit' })
    expect(first.status).toBe(502)
    expect(first.json.ignoredBuilds).toEqual(['dsh-security-audit'])
    // The bilingual classification replaces the raw stack as the lead hint.
    expect(String(first.json.stderr)).toContain('允许构建脚本并重试')

    // Approval is anchored to the curated registry (the package exists in
    // neither node_modules nor package.json) and writes the stable git key —
    // the only form pnpm matches for a git-hosted dep.
    const approve = await bed.dispatch('POST', '/dsh-market/approve-builds', { packages: ['dsh-security-audit'] })
    expect(approve.status).toBe(200)
    expect(approve.json.approved).toContain('dsh-security-audit@git+https://github.com/omdsh-dev/dsh-security-audit.git')
    const yaml = readFileSync(join(profileDir('web'), 'pnpm-workspace.yaml'), 'utf8')
    expect(yaml).toContain('dsh-security-audit@git+https://github.com/omdsh-dev/dsh-security-audit.git: true')

    // The retry (the banner re-runs the install) now succeeds.
    fake.repos['github:omdsh-dev/dsh-security-audit'] = {
      name: 'dsh-security-audit', manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'],
    }
    const retry = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/omdsh-dev/dsh-security-audit' })
    expect(retry.status).toBe(200)
    expect(retry.json.ok).toBe(true)
  })

  it('writes the stable git allowBuilds key for an installed github-sourced dependency (#69)', async () => {
    fake.repos['github:o/blue-whale'] = { name: 'dsh-blue-whale', manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/blue-whale' })
    expect(installedSpec('dsh-blue-whale')).toBe('github:o/blue-whale')
    // Approving the bare name (what pnpm's error reports) must also write
    // the `name@git+https://…` key — a bare entry does not authorize a
    // git-hosted dep (verified against pnpm 11.21 in #68/#69).
    const approve = await bed.dispatch('POST', '/dsh-market/approve-builds', { packages: ['dsh-blue-whale'] })
    expect(approve.status).toBe(200)
    const yaml = readFileSync(join(profileDir('web'), 'pnpm-workspace.yaml'), 'utf8')
    expect(yaml).toMatch(/allowBuilds:[\s\S]*  dsh-blue-whale: true/)
    expect(yaml).toContain('dsh-blue-whale@git+https://github.com/o/blue-whale.git: true')
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

describe('generic enable/disable toggle (#60)', () => {
  function installNpm(name: string, dsh: Record<string, unknown> = {}): Promise<void> {
    fake.npm[name] = {
      latest: '1.0.0',
      versions: { '1.0.0': { manifest: { dsh, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } },
    }
    return bed.dispatch('POST', '/dsh-market/install', { url: `https://github.com/o/${name}` }).then(() => undefined)
  }

  it('toggles a hot-mounted plugin off and back on, persisting the disable list', async () => {
    await installNpm('dsh-loop')
    expect(hot.mounts).toEqual(['dsh-loop'])

    const off = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: false })
    expect(off.status).toBe(200)
    expect(off.json.ok).toBe(true)
    expect(hot.mounts).toEqual([])
    expect(hot.disabled.has('dsh-loop')).toBe(true)
    expect(off.json.disabled).toContain('dsh-loop')

    const listed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(listed.json.disabled).toContain('dsh-loop')
    expect(listed.json.activation['dsh-loop'].state).not.toBe('live')

    const on = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: true })
    expect(on.status).toBe(200)
    expect(hot.mounts).toEqual(['dsh-loop'])
    expect(hot.disabled.has('dsh-loop')).toBe(false)
    expect(on.json.activation['dsh-loop'].state).toBe('live')
  })

  it('toggles a bundle-layer entry through setEntryDisabled', async () => {
    fake.repos['github:o/blue-whale'] = {
      name: 'dsh-blue-whale',
      manifest: { dsh: { bundle: { patch: './x.yml' } }, main: 'lib/index.js' },
      artifacts: ['lib/index.js'],
    }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/blue-whale' })
    hot.mounts = [] // bundle-layer: loaded by the loader, never a hot mount
    const entry = {
      options: { id: 'dsh-blue-whale', name: 'dsh-blue-whale', disabled: null as boolean | null },
      fiber: {} as unknown,
      update: vi.fn(async (options: { disabled: boolean | null }) => {
        entry.options.disabled = options.disabled
        if (options.disabled === true) entry.fiber = undefined
        else entry.fiber = {}
      }),
    }
    bed.loaderEntries.push(entry)

    const off = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-blue-whale', enabled: false })
    expect(off.status).toBe(200)
    expect(entry.options.disabled).toBe(true)
    expect(entry.fiber).toBeUndefined()
    expect(hot.disabled.has('dsh-blue-whale')).toBe(true)

    const on = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-blue-whale', enabled: true })
    expect(on.status).toBe(200)
    expect(entry.options.disabled).toBeNull()
    expect(entry.fiber).toBeDefined()
    expect(hot.disabled.has('dsh-blue-whale')).toBe(false)
  })

  it('writes the user patch layer on toggle (port of dsh-plugin-hub); activation reads disabled', async () => {
    // A bundle-layer plugin with a real insert row.
    fake.repos['github:o/dsh-patchy'] = {
      name: 'dsh-patchy',
      manifest: { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'lib/index.js' },
      artifacts: ['lib/index.js', 'cordis.patch.yml'],
    }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-patchy' })
    hot.mounts = []
    // The fake install writes an EMPTY patch artifact; give it the real row
    // and mirror the loader entry the boot would create.
    const patchFile = join(profileDir('web'), 'node_modules', 'dsh-patchy', 'cordis.patch.yml')
    writeFileSync(patchFile, "- insert:\n    - id: dsh-patchy\n      name: 'dsh-patchy'\n")
    bed.loaderEntries.push({
      options: { id: 'dsh-patchy', name: 'dsh-patchy', disabled: null as boolean | null },
      fiber: {},
      update: async (options: { disabled: boolean | null }) => {
        const target = bed.loaderEntries.find(e => e.options.name === 'dsh-patchy')!
        target.options.disabled = options.disabled
        target.fiber = options.disabled === true ? undefined : {}
      },
    })

    const off = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-patchy', enabled: false })
    expect(off.status).toBe(200)
    const userPatch = join(profileDir('web'), 'cordis.patch.yml')
    expect(readFileSync(userPatch, 'utf8')).toContain('- id: dsh-patchy\n  disabled: true\n')
    expect(off.json.patchWrite.ok).toBe(true)
    // Disabled plugins read as disabled, never "restart to apply".
    expect(off.json.activation['dsh-patchy'].state).toBe('disabled')

    const listed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(listed.json.patch.disables).toContain('dsh-patchy')
    expect(listed.json.patchDisabled).toContain('dsh-patchy')
    expect(listed.json.activation['dsh-patchy'].state).toBe('disabled')

    const on = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-patchy', enabled: true })
    expect(on.status).toBe(200)
    expect(readFileSync(userPatch, 'utf8')).not.toContain('dsh-patchy')
    expect(on.json.activation['dsh-patchy'].state).toBe('live')
    // The live fiber followed the switch — no restart needed.
    expect(on.json.restart).toBe(false)
    // Bundle-only plugin (no dsh.client) — no page refresh needed either.
    expect(on.json.refresh).toBe(false)
  })

  it('reports restart when the disable leaves the live fiber up', async () => {
    await installNpm('dsh-loop')
    hot.mounts = [] // only the loader entry is live
    bed.loaderEntries.push({
      options: { id: 'dsh-loop', name: 'dsh-loop', disabled: null as boolean | null },
      fiber: {},
      // The live drive cannot bring the fiber down (retries exhaust).
      update: async () => {},
    })
    const off = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: false })
    expect(off.status).toBe(200)
    expect(off.json.ok).toBe(true)
    expect(off.json.restart).toBe(true)
    // The choice is still durable (state.json; the next boot applies it).
    expect(hot.disabled.has('dsh-loop')).toBe(true)
  })

  it('reports restart + the reason when enabling cannot hot-mount', async () => {
    await installNpm('dsh-loop')
    await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: false })
    hot.failNext = true // hotMount fails with a restart-required reason
    const on = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: true })
    expect(on.status).toBe(502)
    expect(on.json.ok).toBe(false)
    expect(on.json.restart).toBe(true)
    expect(on.json.reason).toMatch(/cannot hot-mount|restart/)
  })

  it('toggles a client-only shim (dsh.client without dsh.bundle) through the hot path', async () => {
    await installNpm('dsh-loop', { client: './client.js' })
    expect(hot.mounts).toEqual(['dsh-loop'])
    const off = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: false })
    expect(off.status).toBe(200)
    expect(hot.mounts).toEqual([])
    expect(hot.disabled.has('dsh-loop')).toBe(true)
    // The client part is injected into the page — a refresh is prompted.
    expect(off.json.refresh).toBe(true)
    const on = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: true })
    expect(on.status).toBe(200)
    expect(hot.mounts).toEqual(['dsh-loop'])
    expect(hot.disabled.has('dsh-loop')).toBe(false)
  })

  it('enabling a theme through the generic toggle keeps the Themes-page exclusivity', async () => {
    for (const name of ['theme-a', 'theme-b']) {
      fake.repos[`github:o/${name}`] = { name, manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] }
      await bed.dispatch('POST', '/dsh-market/install', { url: `https://github.com/o/${name}` })
    }
    expect(hot.mounts).toEqual(['theme-b'])
    const r = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'theme-a', enabled: true })
    expect(r.status).toBe(200)
    expect(hot.mounts).toEqual(['theme-a'])
    expect(hot.disabled.has('theme-b')).toBe(true)
    expect(hot.disabled.has('theme-a')).toBe(false)
  })

  it('rejects the market itself, unknown plugins, and cross-origin toggles', async () => {
    expect((await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dshmarket', enabled: false })).status).toBe(400)
    expect((await bed.dispatch('POST', '/dsh-market/toggle', { name: 'ghost', enabled: true })).status).toBe(400)
    expect((await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: false }, { crossOrigin: true })).status).toBe(403)
  })

  it('uninstall clears the disable flag; a reinstall starts enabled', async () => {
    await installNpm('dsh-loop')
    await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: false })
    expect(hot.disabled.has('dsh-loop')).toBe(true)
    const uninstall = await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })
    expect(uninstall.status).toBe(200)
    expect(hot.disabled.has('dsh-loop')).toBe(false)
    const reinstall = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(reinstall.status).toBe(200)
    expect(hot.disabled.has('dsh-loop')).toBe(false)
    expect(hot.mounts).toEqual(['dsh-loop'])
  })
})

describe('disable-list replay at boot (#60)', () => {
  it('re-applies persisted disables to bundle-layer entries after the boot shim resolves', async () => {
    // A previous session left theme-a disabled; the replay must put the
    // bundle-layer entry back down (client-only shims are skipped inside
    // mountClientOnlyDeps, covered by the real-module spec).
    hot.disabled = new Set(['theme-a'])
    const entry = {
      options: { id: 'theme-a', name: 'theme-a', disabled: null as boolean | null },
      fiber: {} as unknown,
      update: vi.fn(async (options: { disabled: boolean | null }) => {
        entry.options.disabled = options.disabled
        if (options.disabled === true) entry.fiber = undefined
      }),
    }
    const bed2 = createTestbed()
    bed2.loaderEntries.push(entry)
    // mountClientOnlyDeps resolves immediately; flush the replay microtask.
    await new Promise(resolvePromise => setTimeout(resolvePromise, 0))
    expect(entry.options.disabled).toBe(true)
    expect(entry.fiber).toBeUndefined()
    bed2.dispose()
  })
})

describe('custom groups (#60)', () => {
  async function seedMembers(): Promise<void> {
    fake.npm['dsh-loop'] = {
      latest: '1.0.0',
      versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } },
    }
    fake.npm['dsh-share'] = {
      latest: '0.2.0',
      versions: { '0.2.0': { manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] } },
    }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/h/dsh-share' })
  }

  it('create/rename/delete lifecycle keeps groups and groupOrder consistent', async () => {
    const created = await bed.dispatch('POST', '/dsh-market/groups', { action: 'create', name: 'work' })
    expect(created.status).toBe(200)
    expect(created.json.groups).toEqual({ work: [] })
    expect(created.json.groupOrder).toEqual(['work'])

    expect((await bed.dispatch('POST', '/dsh-market/groups', { action: 'create', name: 'work' })).status).toBe(400)
    expect((await bed.dispatch('POST', '/dsh-market/groups', { action: 'create', name: '../evil' })).status).toBe(400)

    const renamed = await bed.dispatch('POST', '/dsh-market/groups', { action: 'rename', name: 'work', newName: 'daily' })
    expect(renamed.status).toBe(200)
    expect(renamed.json.groups).toEqual({ daily: [] })
    expect(renamed.json.groupOrder).toEqual(['daily'])

    const deleted = await bed.dispatch('POST', '/dsh-market/groups', { action: 'delete', name: 'daily' })
    expect(deleted.status).toBe(200)
    expect(deleted.json.groups).toEqual({})
    expect(deleted.json.groupOrder).toEqual([])
    expect((await bed.dispatch('POST', '/dsh-market/groups', { action: 'delete', name: 'ghost' })).status).toBe(400)
    expect((await bed.dispatch('POST', '/dsh-market/groups', { action: 'explode' })).status).toBe(400)
  })

  it('set-members keeps only installed plugins and uninstall prunes membership', async () => {
    await seedMembers()
    await bed.dispatch('POST', '/dsh-market/groups', { action: 'create', name: 'work' })
    const set = await bed.dispatch('POST', '/dsh-market/groups', {
      action: 'set-members', name: 'work', members: ['dsh-loop', 'dsh-share', 'ghost', 'dshmarket'],
    })
    expect(set.status).toBe(200)
    expect(set.json.groups.work.sort()).toEqual(['dsh-loop', 'dsh-share'])
    expect(set.json.groups.work).not.toContain('dshmarket')

    await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })
    const listed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(listed.json.groups.work).toEqual(['dsh-share'])
  })

  it('group toggle enables/disables every member as a batch', async () => {
    await seedMembers()
    await bed.dispatch('POST', '/dsh-market/groups', { action: 'create', name: 'work' })
    await bed.dispatch('POST', '/dsh-market/groups', { action: 'set-members', name: 'work', members: ['dsh-loop', 'dsh-share'] })

    const off = await bed.dispatch('POST', '/dsh-market/groups', { action: 'toggle', name: 'work', enabled: false })
    expect(off.status).toBe(200)
    expect(off.json.disabled.sort()).toEqual(['dsh-loop', 'dsh-share'])
    expect(hot.mounts).toEqual([])

    const on = await bed.dispatch('POST', '/dsh-market/groups', { action: 'toggle', name: 'work', enabled: true })
    expect(on.status).toBe(200)
    expect(on.json.disabled).toEqual([])
    expect(hot.mounts.sort()).toEqual(['dsh-loop', 'dsh-share'])
  })

  it('group switch matches individually toggled plugins (mixed then all-off)', async () => {
    await seedMembers()
    await bed.dispatch('POST', '/dsh-market/groups', { action: 'create', name: 'work' })
    await bed.dispatch('POST', '/dsh-market/groups', { action: 'set-members', name: 'work', members: ['dsh-loop', 'dsh-share'] })
    // One member off individually → the group is mixed (derived, not stored).
    await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: false })
    expect(hot.disabled).toEqual(new Set(['dsh-loop']))
    // Group off = same outcome as toggling each member individually.
    const off = await bed.dispatch('POST', '/dsh-market/groups', { action: 'toggle', name: 'work', enabled: false })
    expect(off.json.disabled.sort()).toEqual(['dsh-loop', 'dsh-share'])
    const on = await bed.dispatch('POST', '/dsh-market/groups', { action: 'toggle', name: 'work', enabled: true })
    expect(on.json.disabled).toEqual([])
  })

  it('rejects a second theme in one group', async () => {
    for (const name of ['theme-a', 'theme-b']) {
      fake.repos[`github:o/${name}`] = { name, manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] }
      await bed.dispatch('POST', '/dsh-market/install', { url: `https://github.com/o/${name}` })
    }
    await bed.dispatch('POST', '/dsh-market/groups', { action: 'create', name: 'looks' })
    const both = await bed.dispatch('POST', '/dsh-market/groups', {
      action: 'set-members', name: 'looks', members: ['theme-a', 'theme-b'],
    })
    expect(both.status).toBe(400)
    expect(String(both.json.error)).toMatch(/at most one theme/)
    const one = await bed.dispatch('POST', '/dsh-market/groups', {
      action: 'set-members', name: 'looks', members: ['theme-a'],
    })
    expect(one.status).toBe(200)
    expect(one.json.groups.looks).toEqual(['theme-a'])
  })

  it('group toggle enables a theme member with global exclusivity', async () => {
    for (const name of ['theme-a', 'theme-b']) {
      fake.repos[`github:o/${name}`] = { name, manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] }
      await bed.dispatch('POST', '/dsh-market/install', { url: `https://github.com/o/${name}` })
    }
    expect(hot.mounts).toEqual(['theme-b']) // later install auto-activated
    await bed.dispatch('POST', '/dsh-market/groups', { action: 'create', name: 'looks' })
    await bed.dispatch('POST', '/dsh-market/groups', { action: 'set-members', name: 'looks', members: ['theme-a'] })

    const on = await bed.dispatch('POST', '/dsh-market/groups', { action: 'toggle', name: 'looks', enabled: true })
    expect(on.status).toBe(200)
    // Enabling the group's theme deactivates the previously active theme-b.
    expect(hot.mounts).toEqual(['theme-a'])
    expect(hot.disabled.has('theme-b')).toBe(true)
    expect(hot.disabled.has('theme-a')).toBe(false)

    const off = await bed.dispatch('POST', '/dsh-market/groups', { action: 'toggle', name: 'looks', enabled: false })
    expect(off.status).toBe(200)
    expect(hot.disabled.has('theme-a')).toBe(true)
  })
})
