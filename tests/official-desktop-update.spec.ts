/**
 * The official desktop runtime updates through the host's own `updateBundle`
 * (dsh 0.2.2+) and keeps the market's remove-then-install pair for hosts that
 * lack it (0.2.1). Every assertion here is one a runtime that always took the
 * old path would fail: the in-place call is counted, and remove/install are
 * asserted ABSENT on the new path and PRESENT on the old one.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

/** A profile directory with `example` installed at 1.0.0, the way pnpm leaves it. */
function profile(version = '1.0.0'): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-official-update-'))
  roots.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dependencies: { example: version },
    dsh: { profile: { bundles: ['example'] } },
  }))
  const packageDir = join(dir, 'node_modules', 'example')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'example', version, dsh: { bundle: {} } }))
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

  it.each(['dshmarket', 'dsh-market'])('goes through the host too (%s), and the result says the running market was replaced', async name => {
    // With HMR the host removes the running bundle before it installs the new
    // one, so the instance that asked is disposed by the time the call answers.
    // The route has to know, or it asks the dead instance for services and
    // turns a finished update into a 500 (measured on a real host).
    const service = host({ rows: [market(name)] })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    try {
      const result = await runtime.runPlugin('desktop', ['add', `${name}@2.0.0`])
      expect(result.exitCode).toBe(0)
      expect(result.selfSwapped).toBe(true)
      expect(service.updateBundle).toHaveBeenCalledWith(name, '2.0.0', { requestId: expect.any(String) })
      expect(service.removeBundle).not.toHaveBeenCalled()
      expect(service.installBundle).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
    }
  })

  it('is NOT flagged as replaced when the host installed over it without HMR (it is still running)', async () => {
    const service = host({
      rows: [market('dshmarket')],
      update: vi.fn(async () => updated({ result: { application: 'restart-required', changed: true, stage: 'enable', target: 'dshmarket', packageResult: { exitCode: 0, output: 'done' } } })),
    })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    try {
      const result = await runtime.runPlugin('desktop', ['add', 'dshmarket@2.0.0'])
      expect(result.exitCode).toBe(0)
      expect(result.selfSwapped).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  })

  it('a new build that cannot start: the host put the old market back, and the dead instance still answers from the result', async () => {
    const service = host({
      rows: [market('dshmarket')],
      update: vi.fn(async () => updated({
        result: { application: 'failed', changed: false, stage: 'enable', target: 'dshmarket', error: { code: 'operation-error', diagnostic: 'bundle patch cannot load' } },
        restore: { application: 'applied' },
      })),
    })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    try {
      const result = await runtime.runPlugin('desktop', ['add', 'dshmarket@2.0.0'])
      expect(result.exitCode).not.toBe(0)
      expect(result.selfSwapped).toBe(true)
      expect(result.wroteNothing).toBe(true)
      expect(result.stderr).toContain('旧版本已经装回')
    } finally {
      await runtime.dispose()
    }
  })

  it('a host without updateBundle (0.2.1) keeps the market\'s own overlay and never removes it (#900, #982)', async () => {
    const service = host({ update: null, rows: [market('dshmarket')] })
    service.installBundle.mockResolvedValueOnce(alreadyInstalled as never)
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    try {
      const result = await runtime.runPlugin('desktop', ['add', 'dshmarket@2.0.0'])
      expect(result.refusalCode).toBe('market-self-update')
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

  it('the market itself: a check that finds no bundle falls back to the overlay, never to a removal', async () => {
    const service = host({
      rows: [row({ name: 'dshmarket' })],
      update: vi.fn(async () => updated({ step: 'check', result: failed({ target: 'dshmarket', error: { code: 'not-bundle' } }) })),
    })
    service.installBundle.mockResolvedValueOnce(alreadyInstalled as never)
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    try {
      await runtime.runPlugin('desktop', ['add', 'dshmarket@2.0.0'])
      expect(service.updateBundle).toHaveBeenCalledTimes(1)
      expect(service.removeBundle).not.toHaveBeenCalled()
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
