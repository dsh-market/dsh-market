/**
 * The official desktop runtime updates other plugins through the host's
 * `updateBundle` (dsh 0.2.2+) or remove-then-install (0.2.1). Neither is
 * safe for the running market: it must remain installed if an update fails.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createOfficialDesktopRuntime,
  forgetRestartPending,
  type ManagedBundleRow,
  type ManagedUpdateResult,
  type OfficialPluginManagerLike,
} from '../src/official-desktop.ts'
import { progress } from '../src/dsh-cli.ts'
import { PendingUpdateJournal, pendingUpdatesFile } from '../src/pending-updates.ts'
import { setActiveRegion } from '../src/regions.ts'

const roots: string[] = []

beforeEach(() => {
  vi.stubEnv('DSHM_NPM_MIRROR', '')
  setActiveRegion('global')
  forgetRestartPending()
})

afterEach(() => {
  setActiveRegion('global')
  vi.unstubAllEnvs()
  vi.useRealTimers()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A profile directory with an installed bundle, the way pnpm leaves it. */
function profile(version = '1.0.0', name = 'example'): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-official-update-'))
  roots.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dependencies: { [name]: version },
    dsh: { profile: { bundles: [name] } },
  }))
  const packageDir = join(dir, 'node_modules', name)
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version, dsh: { bundle: {} } }))
  return dir
}

const ok = { application: 'applied', packageResult: { exitCode: 0, output: 'installed' } }
const row = (over: Partial<ManagedBundleRow> = {}): ManagedBundleRow =>
  ({ name: 'example', installed: true, version: '1.0.0', source: 'example@1.0.0', update: 'registry', ...over })
const updated = (over: Partial<ManagedUpdateResult> = {}): ManagedUpdateResult => ({
  from: '1.0.0', to: '2.0.0', step: 'install', result: { ...ok, changed: true, stage: 'enable', target: 'example' }, ...over,
})

function host(options: { rows?: ManagedBundleRow[]; update?: ReturnType<typeof vi.fn> | null } = {}) {
  const updateBundle = options.update === undefined ? vi.fn(async () => updated()) : options.update
  const service = {
    installBundle: vi.fn(async () => ({ ...ok })),
    removeBundle: vi.fn(async () => ({ application: 'applied', packageResult: { exitCode: 0, output: 'removed' } })),
    cancelInstall: vi.fn(async () => ({ status: 'cancelled' })),
    listBundles: vi.fn(async () => options.rows ?? [row()]),
    ...(updateBundle === null ? {} : { updateBundle }),
  }
  return service as typeof service & OfficialPluginManagerLike
}

const alreadyInstalled = { application: 'failed', error: { code: 'already-installed' } }
const journalOf = (dir: string): PendingUpdateJournal => new PendingUpdateJournal(pendingUpdatesFile(dir))

/** A launcher pnpm stand-in: capture the install arguments and place the supplied package in the profile. */
function overlayInstalling(manifest: object) {
  const script = `
    const { writeFileSync } = require('node:fs')
    writeFileSync('overlay-args.json', JSON.stringify(process.argv.slice(2)))
    writeFileSync('node_modules/dshmarket/package.json', process.argv[1])
  `
  return { command: process.execPath, args: ['-e', script, JSON.stringify(manifest)], env: {} }
}

describe('an update through the host\'s updateBundle (dsh 0.2.2+)', () => {
  it('is ONE manager call, with no removal and no install of its own', async () => {
    const dir = profile()
    const service = host()
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir)
    try {
      const result = await runtime.runPlugin('desktop', ['add', 'example@2.0.0'])
      expect(result).toMatchObject({ exitCode: 0, cancelled: false, timedOut: false, stdout: 'installed' })
      expect(service.updateBundle).toHaveBeenCalledTimes(1)
      expect(service.updateBundle).toHaveBeenCalledWith('example', '2.0.0', { requestId: expect.any(String) })
      expect(service.removeBundle).not.toHaveBeenCalled()
      expect(service.installBundle).not.toHaveBeenCalled()
      // The record that brackets the call is gone once the host answered.
      expect(journalOf(dir).list()).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it('takes a 0.14-style row (`updatable: true`, no `update`) as a registry bundle, and still declines when it is not (#909)', async () => {
    const legacy = (over: Partial<ManagedBundleRow>): ManagedBundleRow => {
      const { update: _update, ...rest } = row(over)
      return rest
    }
    for (const [rows, calls] of [
      [[legacy({ updatable: true })], 1],
      [[legacy({ updatable: false })], 0],
      [[legacy({})], 0],
      // A host that says how it updates is believed over the boolean.
      [[row({ update: 'git', updatable: true })], 0],
    ] as const) {
      const service = host({ rows: [...rows] })
      const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
      try {
        await runtime.runPlugin('desktop', ['add', 'example@2.0.0'])
        expect(service.updateBundle).toHaveBeenCalledTimes(calls)
      } finally {
        await runtime.dispose()
      }
    }
  })

  it('passes the market\'s download mirror as the registry asked first', async () => {
    vi.stubEnv('DSHM_NPM_MIRROR', 'https://mirror.example/npm')
    const service = host()
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    try {
      await runtime.runPlugin('desktop', ['add', 'example@2.0.0'])
      expect(service.updateBundle).toHaveBeenCalledWith('example', '2.0.0', {
        requestId: expect.any(String), registry: 'https://mirror.example/npm',
      })
    } finally {
      await runtime.dispose()
    }
  })

  it('journals around the call, so a host that dies mid-update is repaired from disk on the next start', async () => {
    const dir = profile()
    let during: unknown[] = []
    const service = host({
      update: vi.fn(async () => {
        during = journalOf(dir).list()
        return updated()
      }),
    })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir)
    try {
      await runtime.runPlugin('desktop', ['add', 'example@2.0.0'])
      expect(during).toMatchObject([{ name: 'example', from: '1.0.0', to: '2.0.0', spec: 'example@2.0.0' }])
    } finally {
      await runtime.dispose()
    }
  })

  it('says which step the host is on, and stops listening afterwards', async () => {
    const stops = vi.fn()
    let listener: (step: string) => void = () => {}
    const seen: string[] = []
    const service = host({
      update: vi.fn(async () => {
        listener('removing')
        seen.push(progress.lastLine)
        listener('installing')
        seen.push(progress.lastLine)
        return updated()
      }),
    })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile(), null, {
      watchUpdateSteps: (requestId, next) => {
        expect(requestId).toEqual(expect.any(String))
        listener = next
        return stops
      },
    })
    try {
      await runtime.runPlugin('desktop', ['add', 'example@2.0.0'])
      expect(seen[0]).toContain('停掉旧版本')
      expect(seen[1]).toContain('安装新版本')
      expect(stops).toHaveBeenCalledTimes(1)
    } finally {
      await runtime.dispose()
    }
  })

  it('says the new build is already running when the host swapped it in (applied), and not when it only landed (restart-required)', async () => {
    // The update route turns this into "live" instead of "restart to apply",
    // and stops remembering the plugin as stale for every later page load.
    const applied = host()
    const landed = host({
      update: vi.fn(async () => updated({ result: { application: 'restart-required', changed: true, stage: 'enable', target: 'example', packageResult: { exitCode: 0, output: 'done' } } })),
    })
    const first = createOfficialDesktopRuntime(() => applied, 'desktop', profile())
    const second = createOfficialDesktopRuntime(() => landed, 'desktop', profile())
    try {
      await expect(first.runPlugin('desktop', ['add', 'example@2.0.0'])).resolves.toMatchObject({ exitCode: 0, liveSwap: true })
      const result = await second.runPlugin('desktop', ['add', 'example@2.0.0'])
      expect(result.exitCode).toBe(0)
      expect(result.liveSwap).toBeUndefined()
    } finally {
      await first.dispose()
      await second.dispose()
    }
  })

  it('reports a restart-first state as success and remembers it for the next refusal', async () => {
    const service = host({
      update: vi.fn(async () => updated({ result: { application: 'restart-required', changed: true, stage: 'enable', target: 'example', packageResult: { exitCode: 0, output: 'done' } } })),
    })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    try {
      await expect(runtime.runPlugin('desktop', ['add', 'example@2.0.0'])).resolves.toMatchObject({ exitCode: 0 })
    } finally {
      await runtime.dispose()
    }
  })
})

describe('an update on a host without updateBundle (dsh 0.2.1)', () => {
  it('keeps the remove-then-install pair, and never calls what is not there', async () => {
    const dir = profile()
    const service = host({ update: null })
    service.installBundle.mockResolvedValueOnce(alreadyInstalled as never)
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir)
    try {
      await expect(runtime.runPlugin('desktop', ['add', 'example@2.0.0'])).resolves.toMatchObject({ exitCode: 0 })
      expect(service.removeBundle).toHaveBeenCalledWith('example')
      expect(service.installBundle).toHaveBeenCalledTimes(2)
      // Not even listing: the old path starts from the install, as it always did.
      expect(service.listBundles).not.toHaveBeenCalled()
      expect(journalOf(dir).list()).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })
})

describe('what stays on the remove-then-install path even on a new host', () => {
  async function takesOldPath(service: ReturnType<typeof host>, spec: string, dir = profile()): Promise<void> {
    service.installBundle.mockResolvedValueOnce(alreadyInstalled as never)
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir)
    try {
      await expect(runtime.runPlugin('desktop', ['add', spec])).resolves.toMatchObject({ exitCode: 0 })
      expect(service.updateBundle).not.toHaveBeenCalled()
      expect(service.removeBundle).toHaveBeenCalledWith('example')
    } finally {
      await runtime.dispose()
    }
  }

  it('a version that is not newer (the update route\'s own rollback to the build before)', async () => {
    await takesOldPath(host(), 'example@1.0.0')
  })

  it('an older version', async () => {
    await takesOldPath(host({ rows: [row({ version: '3.0.0' })] }), 'example@2.0.0')
  })

  it('a dist-tag or a range, which names no exact version', async () => {
    await takesOldPath(host(), 'example@latest')
  })

  it('a bundle the host does not list as updatable', async () => {
    const { update: _update, ...unlisted } = row()
    await takesOldPath(host({ rows: [unlisted] }), 'example@2.0.0')
  })

  it('a host that cannot list its bundles', async () => {
    const service = host()
    service.listBundles.mockRejectedValueOnce(new Error('profile unreadable'))
    await takesOldPath(service, 'example@2.0.0')
  })

  it('a refusal at the host\'s own target check, which changed nothing', async () => {
    const service = host({
      update: vi.fn(async () => updated({
        step: 'check',
        result: { application: 'failed', changed: false, stage: 'install', target: 'example', error: { code: 'invalid-spec', diagnostic: 'x' } },
      })),
    })
    service.installBundle.mockResolvedValueOnce(alreadyInstalled as never)
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    try {
      await expect(runtime.runPlugin('desktop', ['add', 'example@2.0.0'])).resolves.toMatchObject({ exitCode: 0 })
      expect(service.updateBundle).toHaveBeenCalledTimes(1)
      expect(service.removeBundle).toHaveBeenCalledWith('example')
    } finally {
      await runtime.dispose()
    }
  })
})

describe('the market updating itself', () => {
  const market = (name: string) => row({ name })
  const target = { name: 'dshmarket', version: '2.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }

  it('refuses a registry target the host marks incompatible before starting pnpm', async () => {
    const dir = profile('1.0.0', target.name)
    const pkg = join(dir, 'node_modules', target.name, 'package.json')
    const before = readFileSync(pkg, 'utf8')
    const service = {
      ...host({ rows: [market(target.name)] }),
      listVersions: vi.fn(async () => ({
        status: 'listed' as const, registry: 'https://registry.example/npm', versions: [{
          version: target.version, bundle: true,
          incompatible: { name: target.name, version: target.version, runtimeVersion: '0.2.2', requirements: { 'engines.dsh': '>=1' } },
        }],
      })),
    }
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir, overlayInstalling(target))
    try {
      const result = await runtime.runPlugin('desktop', ['add', 'dshmarket@2.0.0'])
      expect(result.refusalCode).toBe('incompatible-version')
      expect(existsSync(join(dir, 'overlay-args.json'))).toBe(false)
      expect(readFileSync(pkg, 'utf8')).toBe(before)
      expect(journalOf(dir).list()).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it('keeps a newer build installed from Settings while the market was looking up its target', async () => {
    const dir = profile('1.0.0', target.name)
    const pkg = join(dir, 'node_modules', target.name, 'package.json')
    const service = {
      ...host({ rows: [market(target.name)] }),
      listVersions: async () => {
        writeFileSync(pkg, JSON.stringify({ ...target, version: '3.0.0' }))
        return { status: 'listed' as const, registry: null, versions: [target] }
      },
    }
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir, overlayInstalling(target))
    try {
      const result = await runtime.runPlugin('desktop', ['add', 'dshmarket@2.0.0'])
      expect(result.wroteNothing).toBe(true)
      expect(existsSync(join(dir, 'overlay-args.json'))).toBe(false)
      expect(JSON.parse(readFileSync(pkg, 'utf8')).version).toBe('3.0.0')
    } finally {
      await runtime.dispose()
    }
  })

  it('saves the exact registry version using the registry that answered the host check', async () => {
    vi.stubEnv('DSHM_NPM_MIRROR', 'https://first.example/npm')
    const dir = profile('1.0.0', target.name)
    const registry = 'https://fallback.example/npm'
    const service = {
      ...host({ rows: [market(target.name)] }),
      listVersions: vi.fn(async () => ({
        status: 'listed' as const, registry, versions: [{ version: target.version, bundle: true }],
      })),
    }
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir, overlayInstalling(target))
    try {
      await expect(runtime.runPlugin('desktop', ['add', 'dshmarket@2.0.0'])).resolves.toMatchObject({ exitCode: 0 })
      expect(service.listVersions).toHaveBeenCalledWith('dshmarket', { registry: 'https://first.example/npm' })
      const args = JSON.parse(readFileSync(join(dir, 'overlay-args.json'), 'utf8'))
      expect(args).toEqual(expect.arrayContaining(['add', 'dshmarket@2.0.0', '--save-exact', `--registry=${registry}`]))
      expect(service.updateBundle).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
    }
  })

  it('never starts pnpm if the user cancels while the host is looking up the target', async () => {
    const dir = profile('1.0.0', target.name)
    let finishLookup!: () => void
    const gate = new Promise<void>(resolve => { finishLookup = resolve })
    const service = {
      ...host({ rows: [market(target.name)] }),
      listVersions: vi.fn(async () => {
        await gate
        return { status: 'listed' as const, registry: null, versions: [{ version: target.version, bundle: true }] }
      }),
    }
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir, overlayInstalling(target))
    try {
      const update = runtime.runPlugin('desktop', ['add', 'dshmarket@2.0.0'])
      await vi.waitFor(() => expect(service.listVersions).toHaveBeenCalled())
      expect(runtime.cancelActive()).toBe(true)
      finishLookup()
      await expect(update).resolves.toMatchObject({ cancelled: true })
      expect(existsSync(join(dir, 'overlay-args.json'))).toBe(false)
    } finally {
      finishLookup()
      await runtime.dispose()
    }
  })

  it('leaves the profile and its live writer alone when starting an overlay', async () => {
    const dir = profile('1.0.0', target.name)
    const lock = join(dir, 'package.json.lock')
    const owner = `${process.pid}\n`
    writeFileSync(lock, owner)
    const service = host({ rows: [market(target.name)] })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir, overlayInstalling(target))
    try {
      const result = await runtime.runPlugin('desktop', ['add', 'dshmarket@2.0.0'])
      expect(result).toMatchObject({ exitCode: 1, wroteNothing: true })
      expect(existsSync(join(dir, 'overlay-args.json'))).toBe(false)
      expect(readFileSync(lock, 'utf8')).toBe(owner)
      expect(service.updateBundle).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
    }
  })

  it.each([{ ...target, name: 'unexpected' }, { name: target.name, version: target.version }])(
    'rejects a package with the target version but the wrong identity or no bundle declaration (%j)', async manifest => {
      const dir = profile('1.0.0', target.name)
      const service = host({ rows: [market(target.name)] })
      const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir, overlayInstalling(manifest))
      try {
        const result = await runtime.runPlugin('desktop', ['add', 'dshmarket@2.0.0'])
        expect(result.exitCode).not.toBe(0)
        expect(service.updateBundle).not.toHaveBeenCalled()
      } finally {
        await runtime.dispose()
      }
    })

  it.each(['dshmarket', 'dsh-market'])('preserves the installed %s when its replacement cannot be installed (#1328)', async name => {
    const from = '1.84.2'
    const to = '1.85.0'
    const dir = profile(from, name)
    const manifest = join(dir, 'package.json')
    const packageDir = join(dir, 'node_modules', name)
    // Model Desktop successfully removing the running market, then failing
    // both the install and its rollback. A missing market cannot replay its journal.
    const service = host({
      rows: [row({ name, version: from })],
      update: vi.fn(async () => {
        writeFileSync(manifest, JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }))
        rmSync(packageDir, { recursive: true })
        const failure = { application: 'failed', stage: 'install', changed: false, target: name, error: { code: 'operation-error' } }
        return updated({ from, to, step: 'install', result: failure, restore: failure })
      }),
    })
    service.installBundle.mockResolvedValue(alreadyInstalled as never)
    const pnpm = { command: process.execPath, args: ['-e', 'process.exit(1)'], env: {} }
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir, pnpm)
    try {
      const result = await runtime.runPlugin('desktop', ['add', `${name}@${to}`])
      expect(result.exitCode).not.toBe(0)
      const pkgFile = join(packageDir, 'package.json')
      expect({
        profile: JSON.parse(readFileSync(manifest, 'utf8')),
        version: existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, 'utf8')).version : null,
        pending: journalOf(dir).list().map(({ from, to, step }) => ({ from, to, step })),
        repairOnRestart: result.repairOnRestart,
      }).toEqual({
        profile: { dependencies: { [name]: from }, dsh: { profile: { bundles: [name] } } },
        version: from,
        pending: [],
        repairOnRestart: undefined,
      })
      expect(service.updateBundle).not.toHaveBeenCalled()
      expect(service.removeBundle).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
    }
  })

  it.each(['0.2.1', '0.2.2+'])('gives a manual recovery hint on %s when the host has no overlay pnpm', async version => {
    const name = 'dshmarket'
    const dir = profile('1.0.0', name)
    const service = host({ rows: [market(name)], ...(version === '0.2.1' ? { update: null } : {}) })
    service.installBundle.mockResolvedValueOnce(alreadyInstalled as never)
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir)
    try {
      const result = await runtime.runPlugin('desktop', ['add', 'dshmarket@2.0.0'])
      expect(result.refusalCode).toBe('market-self-update')
      expect(result.stderr).toContain('pnpm add dshmarket@2.0.0')
      expect(result.repairOnRestart).toBeUndefined()
      expect(service.installBundle).toHaveBeenCalledTimes(1)
      if (service.updateBundle) expect(service.updateBundle).not.toHaveBeenCalled()
      expect(service.removeBundle).not.toHaveBeenCalled()
      expect(journalOf(dir).list()).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it('lets a host without launcher pnpm install over the existing registry bundle when supported', async () => {
    const dir = profile('1.0.0', 'dshmarket')
    const service = host({ rows: [market('dshmarket')] })
    service.installBundle.mockImplementationOnce(async () => {
      writeFileSync(join(dir, 'node_modules', 'dshmarket', 'package.json'), JSON.stringify({ name: 'dshmarket', version: '2.0.0' }))
      return { ...ok }
    })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir)
    try {
      const result = await runtime.runPlugin('desktop', ['add', 'dshmarket@2.0.0'])
      expect(result.exitCode).toBe(0)
      expect(service.installBundle).toHaveBeenCalledWith('dshmarket@2.0.0', { requestId: expect.any(String) })
      expect(service.updateBundle).not.toHaveBeenCalled()
      expect(service.removeBundle).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
    }
  })
})

describe('every way the in-place update can fail says what happened and what to do', () => {
  /** Run one update whose host answers with `answer`, and hand back what the route would read. */
  async function failWith(answer: ManagedUpdateResult) {
    const dir = profile()
    const service = host({ update: vi.fn(async () => answer) })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir)
    try {
      const result = await runtime.runPlugin('desktop', ['add', 'example@2.0.0'])
      return { result, service, dir }
    } finally {
      await runtime.dispose()
    }
  }
  const failed = (over: Record<string, unknown>) => ({ application: 'failed', changed: false, stage: 'install', target: 'example', ...over })

  it('the registry does not answer: nothing changed, and the host\'s reason is kept', async () => {
    const { result, service, dir } = await failWith(updated({
      step: 'check',
      result: failed({ error: { code: 'operation-error', diagnostic: 'ERR_PNPM_FETCH_FAIL could not reach the registry' } }),
    }))
    expect(result.exitCode).not.toBe(0)
    expect(result.wroteNothing).toBe(true)
    expect(result.stderr).toContain('现在的版本不受影响')
    expect(result.stderr).toContain('ERR_PNPM_FETCH_FAIL could not reach the registry')
    expect(result.stderr).not.toMatch(/^\{/)
    expect(service.removeBundle).not.toHaveBeenCalled()
    expect(journalOf(dir).list()).toEqual([])
  })

  it('a check that finds no bundle hands the update to the ordinary path (pnpm\'s cache can hide `dsh`)', async () => {
    // Measured on dsh 0.2.2-rc.5 + the Tencent mirror: the host's `pnpm view`
    // answered from pnpm's install cache, which has no `dsh` field, for every
    // plugin not republished since it was installed.
    const service = host({ update: vi.fn(async () => updated({ step: 'check', result: failed({ error: { code: 'not-bundle' } }) })) })
    service.installBundle.mockResolvedValueOnce(alreadyInstalled as never)
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    try {
      await expect(runtime.runPlugin('desktop', ['add', 'example@2.0.0'])).resolves.toMatchObject({ exitCode: 0 })
      expect(service.updateBundle).toHaveBeenCalledTimes(1)
      expect(service.removeBundle).toHaveBeenCalledWith('example')
    } finally {
      await runtime.dispose()
    }
  })

  it('the running DSH rejects the version', async () => {
    const { result } = await failWith(updated({ step: 'check', result: failed({ error: { code: 'incompatible-version' } }) }))
    expect(result.wroteNothing).toBe(true)
    expect(result.stderr).toContain('不兼容')
  })

  it('an install that landed another version (a version still inside the fresh-release wait)', async () => {
    const { result } = await failWith(updated({
      result: failed({ stage: 'install', error: { code: 'unexpected-package' }, packageResult: { exitCode: 0, output: 'ok' } }),
      restore: { application: 'applied' },
    }))
    expect(result.stderr).toContain('新版本等待期')
    expect(result.stderr).toContain('旧版本还在')
    expect(result.refusalCode).toBe('unexpected-package')
  })

  it('a release-age refusal from pnpm keeps pnpm\'s own output where the update route classifies it', async () => {
    const output = 'ERR_PNPM_NO_MATURE_MATCHING_VERSION  Version 2.0.0 (released 3 minutes ago) of example does not meet the minimumReleaseAge constraint'
    const { result } = await failWith(updated({
      result: failed({ stage: 'install', error: { code: 'operation-error', diagnostic: output }, packageResult: { exitCode: 1, output } }),
      restore: { application: 'applied' },
    }))
    expect(result.exitCode).not.toBe(0)
    // The route reads pnpm's refusal from stdout to tell a young release from
    // a broken install (#919); it must still be there.
    expect(result.stdout).toContain('minimumReleaseAge')
  })

  it('the new version fails to start and the old one is put back: nothing for the route to roll back', async () => {
    const { result, service, dir } = await failWith(updated({
      result: failed({ stage: 'enable', error: { code: 'operation-error', diagnostic: 'bundle patch cannot load' }, packageResult: { exitCode: 0, output: 'ok' } }),
      restore: { application: 'applied' },
    }))
    expect(result.exitCode).not.toBe(0)
    expect(result.wroteNothing).toBe(true)
    expect(result.stderr).toContain('bundle patch cannot load')
    expect(result.stderr).toContain('旧版本已经装回')
    expect(result.stderr).toContain('The old version was put back')
    // The route's own rollback would be a second remove-and-install on a
    // profile the host already restored.
    expect(service.removeBundle).not.toHaveBeenCalled()
    expect(service.installBundle).not.toHaveBeenCalled()
    expect(journalOf(dir).list()).toEqual([])
  })

  it('neither version could be installed: the record stays, aimed at the OLD version, and the route is told not to touch it', async () => {
    const { result, service, dir } = await failWith(updated({
      result: failed({ stage: 'install', error: { code: 'operation-error', diagnostic: 'registry down' }, packageResult: { exitCode: 1, output: 'down' } }),
      restore: { application: 'failed', error: { code: 'operation-error' } },
    }))
    expect(result.exitCode).not.toBe(0)
    expect(result.repairOnRestart).toBe(true)
    expect(result.wroteNothing).toBe(false)
    expect(result.stderr).toContain('这个插件现在是缺的')
    expect(result.stderr).toContain('1.0.0')
    expect(service.installBundle).not.toHaveBeenCalled()
    expect(journalOf(dir).list()).toMatchObject([{ name: 'example', to: '1.0.0', spec: 'example@1.0.0' }])
  })

  it('a cancelled install is cancelled, not failed, and leaves the profile whole', async () => {
    const { result, dir } = await failWith(updated({
      result: failed({ application: 'cancelled', stage: 'install' }),
      restore: { application: 'applied' },
    }))
    expect(result.cancelled).toBe(true)
    expect(result.wroteNothing).toBe(true)
    expect(journalOf(dir).list()).toEqual([])
  })

  it('the host refuses to stop the plugin: untouched, and the restart-first answer after an update already landed', async () => {
    const dir = profile()
    const service = host()
    service.updateBundle
      .mockResolvedValueOnce(updated({ result: { application: 'restart-required', changed: true, stage: 'enable', target: 'example', packageResult: { exitCode: 0, output: 'done' } } }))
      .mockResolvedValueOnce(updated({ step: 'remove', result: { application: 'failed', changed: false, stage: 'remove', target: 'example', error: { code: 'bundle-in-use' } } }))
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir)
    try {
      await runtime.runPlugin('desktop', ['add', 'example@2.0.0'])
      const second = await runtime.runPlugin('desktop', ['add', 'example@3.0.0'])
      expect(second.needsRestart).toBe(true)
      expect(second.wroteNothing).toBe(true)
      expect(second.stderr).toContain('重启后再点')
    } finally {
      await runtime.dispose()
    }
  })

  it('a call that throws before it changed anything is not left as a pending update', async () => {
    const dir = profile()
    const service = host({ update: vi.fn(async () => { throw Object.assign(new Error('unavailable'), { code: 'PLUGIN_MANAGER_UNAVAILABLE' }) }) })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir)
    try {
      const result = await runtime.runPlugin('desktop', ['add', 'example@2.0.0'])
      expect(result.exitCode).not.toBe(0)
      // The disk still holds 1.0.0, so there is nothing to repair.
      expect(journalOf(dir).list()).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it('a host that never answers: the market stops waiting, and the record is kept for the next start', async () => {
    vi.useFakeTimers()
    const dir = profile()
    const service = host({ update: vi.fn(() => new Promise<ManagedUpdateResult>(() => {})) })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir)
    try {
      const running = runtime.runPlugin('desktop', ['add', 'example@2.0.0'])
      await vi.advanceTimersByTimeAsync(3 * 660_000 + 1)
      const result = await running
      expect(result.repairOnRestart).toBe(true)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('更新')
      expect(journalOf(dir).list()).toMatchObject([{ name: 'example', from: '1.0.0', to: '2.0.0' }])
      expect(existsSync(pendingUpdatesFile(dir))).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })
})

describe('a Git bundle', () => {
  const sha1 = 'a'.repeat(40)
  const sha2 = 'b'.repeat(40)
  const gitRow = (): ManagedBundleRow => row({ name: 'gitplug', version: '1.0.0', source: `github:o/r#${sha1}`, update: 'git' })

  it('passes the Git spec it was asked for, with the version that commit holds', async () => {
    const service = host({ rows: [gitRow()] })
    const gitVersionAt = vi.fn(async () => '1.1.0')
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile(), null, { gitVersionAt })
    try {
      await expect(runtime.runPlugin('desktop', ['add', `github:o/r#${sha2}`])).resolves.toMatchObject({ exitCode: 0 })
      expect(gitVersionAt).toHaveBeenCalledWith(`github:o/r#${sha2}`)
      expect(service.updateBundle).toHaveBeenCalledWith('gitplug', '1.1.0', { requestId: expect.any(String), spec: `github:o/r#${sha2}` })
      expect(service.installBundle).not.toHaveBeenCalled()
      expect(service.removeBundle).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
    }
  })

  it('protects a market installed from Git and verifies the version at the requested commit (#1328)', async () => {
    const dir = profile('1.0.0', 'dshmarket')
    const service = host({ rows: [{ ...gitRow(), name: 'dshmarket' }] })
    // The overlay exits successfully but leaves the old version on disk.
    const pnpm = overlayInstalling({ name: 'dshmarket', version: '1.0.0', dsh: { bundle: {} } })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir, pnpm, { gitVersionAt: async () => '1.1.0' })
    try {
      const result = await runtime.runPlugin('desktop', ['add', `github:o/r#${sha2}`])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('1.1.0')
      const args = JSON.parse(readFileSync(join(dir, 'overlay-args.json'), 'utf8'))
      expect(args).toContain(`github:o/r#${sha2}`)
      expect(args).not.toContain('--save-exact')
      expect(service.updateBundle).not.toHaveBeenCalled()
      expect(service.removeBundle).not.toHaveBeenCalled()
      expect(journalOf(dir).list()).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it('preserves the pinned Git source in the manual hint when the market cannot overlay it', async () => {
    const dir = profile('1.0.0', 'dshmarket')
    const service = host({ rows: [{ ...gitRow(), name: 'dshmarket' }] })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir, null, { gitVersionAt: async () => '1.1.0' })
    const spec = `github:o/r#${sha2}`
    try {
      const result = await runtime.runPlugin('desktop', ['add', spec])
      expect(result.refusalCode).toBe('market-self-update')
      expect(result.stderr).toContain(spec)
      expect(service.updateBundle).not.toHaveBeenCalled()
      expect(service.installBundle).not.toHaveBeenCalled()
      expect(service.removeBundle).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
    }
  })

  it('does not guess a version: when the commit\'s version cannot be read it installs the way it always did', async () => {
    const service = host({ rows: [gitRow()] })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile(), null, { gitVersionAt: async () => null })
    try {
      await runtime.runPlugin('desktop', ['add', `github:o/r#${sha2}`])
      expect(service.updateBundle).not.toHaveBeenCalled()
      expect(service.installBundle).toHaveBeenCalledWith(`github:o/r#${sha2}`, { requestId: expect.any(String) })
    } finally {
      await runtime.dispose()
    }
  })

  it('a floating spec, or another repository, is not an update of this bundle', async () => {
    const service = host({ rows: [gitRow()] })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile(), null, { gitVersionAt: async () => '1.1.0' })
    try {
      await runtime.runPlugin('desktop', ['add', 'github:o/r'])
      await runtime.runPlugin('desktop', ['add', `github:other/repo#${sha2}`])
      expect(service.updateBundle).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
    }
  })

  it('the same repository spelled as an https address matches', async () => {
    const service = host({ rows: [{ ...gitRow(), source: `git+https://github.com/o/r.git#${sha1}` }] })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile(), null, { gitVersionAt: async () => '1.1.0' })
    try {
      await runtime.runPlugin('desktop', ['add', `github:o/r#${sha2}`])
      expect(service.updateBundle).toHaveBeenCalledTimes(1)
    } finally {
      await runtime.dispose()
    }
  })
})
