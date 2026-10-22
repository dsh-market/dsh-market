import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOfficialDesktopRuntime, type OfficialPluginManagerLike } from '../src/official-desktop.ts'
import type { HostPackageManager } from '../src/dsh-cli.ts'
import { PendingUpdateJournal, pendingUpdatesFile } from '../src/pending-updates.ts'
import { withHoistRecovery } from '../src/install.ts'
import { routesFor, setActiveRegion } from '../src/regions.ts'

const roots: string[] = []

beforeEach(() => {
  vi.stubEnv('DSHM_NPM_MIRROR', '')
  setActiveRegion('global')
})

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-official-'))
  roots.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { example: '1.0.0', gitplug: 'github:o/r' } }))
  return dir
}

afterEach(() => {
  setActiveRegion('global')
  vi.unstubAllEnvs()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})


/** Put a package in the profile's node_modules, the way pnpm would have. */
function installed(dir: string, name: string, version: string): void {
  const packageDir = join(dir, 'node_modules', name)
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version }))
}

/** A host pnpm stand-in: `node -e <script> add <spec>` writes the named version. */
function hostPnpmThatAdds(dir: string, script?: string): HostPackageManager {
  const body = script ?? `
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
if (process.argv.includes('--config.minimum-release-age=0')) process.exit(2)
const spec = process.argv[process.argv.indexOf('add') + 1]
const at = spec.indexOf('@', 1)
const name = at === -1 ? spec : spec.slice(0, at)
const version = at === -1 ? '0.0.0' : spec.slice(at + 1)
const pkg = join(${JSON.stringify(dir)}, 'node_modules', name)
mkdirSync(pkg, { recursive: true })
writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, version }))
`
  return { command: process.execPath, args: ['-e', body], env: {} }
}

function manager(): OfficialPluginManagerLike & {
  installBundle: ReturnType<typeof vi.fn>
  removeBundle: ReturnType<typeof vi.fn>
  cancelInstall: ReturnType<typeof vi.fn>
} {
  return {
    installBundle: vi.fn(async () => ({ application: 'restart-required', packageResult: { exitCode: 0, output: 'installed' } })),
    removeBundle: vi.fn(async () => ({ application: 'applied', packageResult: { exitCode: 0, output: 'removed' } })),
    cancelInstall: vi.fn(async () => ({ status: 'cancelled' })),
  }
}

describe('official Electron profile runtime', () => {
  it('merges exclusions appended by a successful manager install before returning (#883, #878)', async () => {
    const dir = profile()
    const workspace = join(dir, 'pnpm-workspace.yaml')
    const initial = 'minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - example@1.0.0\n'
    writeFileSync(workspace, initial)
    const service = manager()
    service.installBundle.mockImplementationOnce(async () => {
      writeFileSync(workspace, `${initial}  - example@2.0.0\n`)
      return { application: 'restart-required', packageResult: { exitCode: 0, output: 'installed' } }
    })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir)
    try {
      const result = await withHoistRecovery(runtime.runPlugin, 'desktop', ['add', 'example@2.0.0'], dir, { marketFlags: false })
      expect(result).toMatchObject({ exitCode: 0, stdout: 'installed', cancelled: false, timedOut: false })
      expect(readFileSync(workspace, 'utf8')).toBe(initial.replace('example@1.0.0', 'example@1.0.0 || 2.0.0'))
      expect(service.installBundle).toHaveBeenCalledTimes(1)
      expect(service.installBundle).toHaveBeenCalledWith('example@2.0.0', { requestId: expect.any(String) })
    } finally {
      await runtime.dispose()
    }
  })

  it('installs through the in-process manager and never the CLI', async () => {
    const service = manager()
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    await expect(runtime.runPlugin('desktop', ['add', 'example@2.0.0'])).resolves.toMatchObject({ exitCode: 0, stdout: 'installed' })
    expect(service.installBundle).toHaveBeenCalledWith('example@2.0.0', { requestId: expect.any(String) })
    await runtime.dispose()
  })

  it('uses the current market mirror for installs, update targets and exact rollback targets (#862)', async () => {
    setActiveRegion('china')
    const service = manager()
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    for (const target of ['example', 'example@2.0.0', 'example@1.0.0']) {
      await expect(runtime.runPlugin('desktop', ['add', target])).resolves.toMatchObject({ exitCode: 0 })
      expect(service.installBundle).toHaveBeenLastCalledWith(target, {
        requestId: expect.any(String), registry: routesFor('china', {}).npmRegistry,
      })
    }
    await runtime.dispose()
  })

  it('applies region switches to the next install without recreating the runtime (#862)', async () => {
    const service = manager()
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    for (const region of ['global', 'china', 'global', 'china'] as const) {
      setActiveRegion(region)
      await runtime.runPlugin('desktop', ['add', 'example@2.0.0'])
      expect(service.installBundle).toHaveBeenLastCalledWith('example@2.0.0', {
        requestId: expect.any(String),
        ...(region === 'global' ? {} : { registry: routesFor(region, {}).npmRegistry }),
      })
    }
    await runtime.dispose()
  })

  it('uses the same npm mirror override as market requests (#862)', async () => {
    setActiveRegion('china')
    vi.stubEnv('DSHM_NPM_MIRROR', 'https://npm.example.test/custom/')
    const service = manager()
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    await runtime.runPlugin('desktop', ['add', '@scope/example@2.0.0'])
    expect(service.installBundle).toHaveBeenCalledWith('@scope/example@2.0.0', {
      requestId: expect.any(String), registry: 'https://npm.example.test/custom',
    })
    await runtime.dispose()
  })

  it('keeps removal and cancellation on their existing manager APIs with a mirror selected', async () => {
    setActiveRegion('china')
    const service = manager()
    let finish!: (result: { application: string }) => void
    service.installBundle.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    const installing = runtime.runPlugin('desktop', ['add', 'example@2.0.0'])
    const options = service.installBundle.mock.calls[0]![1] as { requestId: string }
    expect(options.requestId).toEqual(expect.any(String))
    expect(runtime.cancelActive()).toBe(true)
    expect(service.cancelInstall).toHaveBeenCalledWith(options.requestId)
    finish({ application: 'cancelled' })
    await expect(installing).resolves.toMatchObject({ exitCode: 1, cancelled: true })
    await expect(runtime.runPlugin('desktop', ['remove', 'example'])).resolves.toMatchObject({ exitCode: 0 })
    expect(service.removeBundle).toHaveBeenCalledWith('example')
    expect(service.removeBundle.mock.calls[0]).toEqual(['example'])
    expect(runtime.cancelActive()).toBe(false)
    await runtime.dispose()
  })

  it('refuses another profile, absent service, and unsupported pnpm flags', async () => {
    const service = manager()
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    // The capability the route layer reads to stop decorating commands with
    // options this host refuses (#732).
    expect(runtime.acceptsMarketPnpmFlags).toBe(false)
    await expect(runtime.runPlugin('web', ['add', 'example'])).resolves.toMatchObject({ exitCode: 127 })
    await expect(runtime.runPlugin('desktop', ['add', '--force', 'example'])).resolves.toMatchObject({ exitCode: 127 })
    // The OPERATION is supported; only the option is not — and the message
    // has to say which, or the user goes looking for a broken profile (#732).
    await expect(runtime.runPlugin('desktop', ['add', '--force', 'example']))
      .resolves.toMatchObject({ exitCode: 127, stderr: expect.stringContaining('--force') })
    await expect(runtime.runPlugin('desktop', ['add', '--force', 'example']))
      .resolves.not.toMatchObject({ stderr: expect.stringContaining('this desktop operation is not supported') })
    await expect(runtime.runPlugin('desktop', ['install'])).resolves.toMatchObject({ exitCode: 127 })
    expect(service.installBundle).not.toHaveBeenCalled()
    const missing = createOfficialDesktopRuntime(() => undefined, 'desktop', profile())
    // Absent service: a message the user can act on, pointing at the app's
    // own Plugins page — never the CLI, which refuses this profile by name.
    await expect(missing.runPlugin('desktop', ['add', 'example'])).resolves.toMatchObject({ exitCode: 127, stderr: expect.stringContaining('Settings → Plugins') })
  })

  it('refuses `update` rather than rewriting it to name@latest, and removes through the manager', async () => {
    // `update` reaches a runtime only for #564's in-place re-resolve of a
    // floating git spec. `name@latest` would cross the installed range and
    // ignore the release channel — a different operation — so it is refused
    // with the pointer to the official page instead.
    const service = manager()
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    await expect(runtime.runPlugin('desktop', ['update', 'example'])).resolves.toMatchObject({ exitCode: 127, stderr: expect.stringContaining('Settings → Plugins') })
    expect(service.installBundle).not.toHaveBeenCalled()
    await expect(runtime.runPlugin('desktop', ['remove', 'example'])).resolves.toMatchObject({ exitCode: 0 })
    expect(service.removeBundle).toHaveBeenCalledWith('example')
  })

  it('never reports exit 0 for a failed application, even after a successful pnpm step', async () => {
    // The official ChangeResult: "successful installation can proceed to
    // enablement" — so stage `enable` + application `failed` follows a pnpm
    // run that EXITED 0. Taking packageResult.exitCode there reported the
    // failed enablement as a successful install; every route reads exit 0
    // as success.
    const service = manager()
    service.installBundle.mockResolvedValueOnce({ application: 'failed', stage: 'enable', changed: true, error: 'entry failed to start', packageResult: { exitCode: 0, output: 'Done' } })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    const result = await runtime.runPlugin('desktop', ['add', 'example'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toBe('entry failed to start')
  })

  it('treats `overridden` as a kept change, not a failure', async () => {
    // `changed: true`: the manager persisted it, and a user patch decides
    // whether it runs. Calling that a failure sent the update route into a
    // rollback of a change the manager had kept.
    const service = manager()
    service.installBundle.mockResolvedValueOnce({ application: 'overridden', stage: 'enable', changed: true, packageResult: { exitCode: 0, output: 'Done' } })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    const result = await runtime.runPlugin('desktop', ['add', 'example'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('another layer overrides')
  })

  it('updates an installed plugin by removing it first when the manager says already-installed (#896)', async () => {
    // dsh 0.2.1's manager refuses `add` for any package already in the
    // profile. The app's own Plugins page updates a bundle as
    // remove-then-install for the same reason; without that, the market could
    // not update a single plugin on that host, itself included.
    const service = manager()
    service.installBundle
      .mockResolvedValueOnce({ application: 'failed', error: { code: 'already-installed' }, packageResult: { exitCode: 1, output: '' } })
      .mockResolvedValueOnce({ application: 'applied', packageResult: { exitCode: 0, output: 'installed 1.66.33' } })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    try {
      await expect(runtime.runPlugin('desktop', ['add', 'example@2.0.0'])).resolves
        .toMatchObject({ exitCode: 0, stdout: 'installed 1.66.33' })
      expect(service.removeBundle).toHaveBeenCalledWith('example')
      expect(service.installBundle).toHaveBeenCalledTimes(2)
      expect(service.installBundle).toHaveBeenLastCalledWith('example@2.0.0', { requestId: expect.any(String) })
    } finally {
      await runtime.dispose()
    }
  })

  it('overlays the market with the host pnpm and never removes it (#982, #900)', async () => {
    const dir = profile()
    installed(dir, 'dshmarket', '1.66.36')
    const service = manager()
    service.installBundle.mockResolvedValueOnce({ application: 'failed', error: { code: 'already-installed' } })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir, hostPnpmThatAdds(dir))
    try {
      const result = await runtime.runPlugin('desktop', ['add', 'dshmarket@1.66.48'])
      expect(result.exitCode).toBe(0)
      expect(service.removeBundle).not.toHaveBeenCalled()
      expect(service.installBundle).toHaveBeenCalledTimes(1)
      expect(JSON.parse(readFileSync(join(dir, 'node_modules', 'dshmarket', 'package.json'), 'utf8')).version).toBe('1.66.48')
    } finally {
      await runtime.dispose()
    }
  })

  it('does not pass the one-shot release-age override on that overlay (#944, #982)', async () => {
    const dir = profile()
    const service = manager()
    service.installBundle.mockResolvedValueOnce({ application: 'failed', error: { code: 'already-installed' } })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir, hostPnpmThatAdds(dir))
    try {
      const result = await runtime.runPlugin('desktop', ['add', 'dshmarket@1.66.48'])
      expect(result.exitCode).toBe(0)
      expect(result.stderr).not.toContain('minimum-release-age=0')
    } finally {
      await runtime.dispose()
    }
  })

  it('does not treat exit 0 as success when the disk version did not change (#982)', async () => {
    const dir = profile()
    installed(dir, 'dshmarket', '1.66.36')
    const service = manager()
    service.installBundle.mockResolvedValueOnce({ application: 'failed', error: { code: 'already-installed' } })
    const runtime = createOfficialDesktopRuntime(
      () => service, 'desktop', dir,
      hostPnpmThatAdds(dir, 'process.exit(0)'),
    )
    try {
      const result = await runtime.runPlugin('desktop', ['add', 'dshmarket@1.66.48'])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatch(/没有换成|did not become/)
      expect(JSON.parse(readFileSync(join(dir, 'node_modules', 'dshmarket', 'package.json'), 'utf8')).version).toBe('1.66.36')
    } finally {
      await runtime.dispose()
    }
  })

  it('does not treat a host add that exits 1 as success (#982)', async () => {
    const dir = profile()
    installed(dir, 'dshmarket', '1.66.36')
    const service = manager()
    service.installBundle.mockResolvedValueOnce({ application: 'failed', error: { code: 'already-installed' } })
    const runtime = createOfficialDesktopRuntime(
      () => service, 'desktop', dir,
      hostPnpmThatAdds(dir, 'process.stderr.write("ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION"); process.exit(1)'),
    )
    try {
      const result = await runtime.runPlugin('desktop', ['add', 'dshmarket@1.66.48'])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatch(/等待期|fresh-release wait/)
      expect(JSON.parse(readFileSync(join(dir, 'node_modules', 'dshmarket', 'package.json'), 'utf8')).version).toBe('1.66.36')
    } finally {
      await runtime.dispose()
    }
  })

  it('tells a locked overlay to quit and run pnpm, not to click update again (#982)', async () => {
    // Starting the market loads its files again, so "quit, reopen, click
    // Update" cannot replace them. Settings → Plugins has no update entry
    // (#909). The overlay already ran without the age bypass; this is not
    // an age failure, so that flag must not appear (#944).
    const dir = profile()
    installed(dir, 'dshmarket', '1.66.36')
    const service = manager()
    service.installBundle.mockResolvedValueOnce({ application: 'failed', error: { code: 'already-installed' } })
    const runtime = createOfficialDesktopRuntime(
      () => service, 'desktop', dir,
      hostPnpmThatAdds(dir, 'process.stderr.write("ERR_PNPM_EPERM operation not permitted, rename"); process.exit(1)'),
    )
    try {
      const result = await runtime.runPlugin('desktop', ['add', 'dshmarket@1.66.48'])
      expect(result.exitCode).not.toBe(0)
      expect(result.refusalCode).toBeUndefined()
      expect(result.stderr).toMatch(/完全退出|quit DSH Desktop/)
      expect(result.stderr).toContain('pnpm add dshmarket@1.66.48')
      expect(result.stderr).not.toMatch(/再点一次|update once more/)
      expect(result.stderr).not.toContain('设置 → 插件')
      expect(result.stderr).not.toContain('minimum-release-age=0')
    } finally {
      await runtime.dispose()
    }
  })

  it('does not call a failed overlay "the market cannot update itself" (#982)', async () => {
    // pnpm ran. A leftover market-self-update code tells a client the button
    // cannot work, and the old hint reintroduces the #944 age bypass.
    const dir = profile()
    installed(dir, 'dshmarket', '1.66.36')
    const service = manager()
    service.installBundle.mockResolvedValueOnce({ application: 'failed', error: { code: 'already-installed' } })
    const runtime = createOfficialDesktopRuntime(
      () => service, 'desktop', dir,
      hostPnpmThatAdds(dir, 'process.stderr.write("opaque pnpm failure"); process.exit(1)'),
    )
    try {
      const result = await runtime.runPlugin('desktop', ['add', 'dshmarket@1.66.48'])
      expect(result.exitCode).not.toBe(0)
      expect(result.refusalCode).not.toBe('market-self-update')
      expect(result.stderr).not.toContain('minimum-release-age=0')
      expect(result.stderr).not.toMatch(/不能在自己的请求里更新自己|cannot update itself/)
      expect(result.stderr).toMatch(/没有换上|did not apply/)
    } finally {
      await runtime.dispose()
    }
  })

  it.each(['dshmarket@1.66.36', 'dsh-market@1.66.36'])('never removes the market itself to update it (%s, #900)', async spec => {
    // The manager's removal unloads the bundle from the running composition
    // BEFORE pnpm runs. For the market that is the code performing the update,
    // so the reinstall never happens and the profile is left half-removed.
    const service = manager()
    service.installBundle.mockResolvedValueOnce({ application: 'failed', error: { code: 'already-installed' } })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    try {
      const result = await runtime.runPlugin('desktop', ['add', spec])
      expect(result.exitCode).not.toBe(0)
      expect(result.wroteNothing).toBe(true)
      expect(service.removeBundle).not.toHaveBeenCalled()
      expect(service.installBundle).toHaveBeenCalledTimes(1)
      // Machine-readable (#909), so a client can tell this apart from an
      // ordinary failure instead of parsing the sentence.
      expect(result.refusalCode).toBe('market-self-update')
      // The two paths named before 1.66.40 do not exist on dsh 0.2.1: the
      // CLI refuses `--profile desktop`, and Settings → Plugins has no update
      // entry. Point at the one route a reporter verified (#909).
      expect(result.stderr).toContain(`pnpm add ${spec} --config.minimum-release-age=0`)
      expect(result.stderr).toContain('#909')
      expect(result.stderr).not.toContain('dsh plugin --profile desktop')
    } finally {
      await runtime.dispose()
    }
  })

  it('says what the recommended bypass costs, and how to undo it (#944, #942)', async () => {
    // The hint tells the user to run `pnpm add dshmarket@<v> --config.minimum-release-age=0`.
    // It works — and it leaves the version in the lockfile while it is still
    // inside the wait, so pnpm then refuses EVERY later plugin install/update
    // (#944). The hint named no cost and no remedy, so the user who followed it
    // was left with a profile where nothing could be installed (#942 is the
    // same sentence, reported from the other end).
    const spec = 'dshmarket@1.66.44'
    const service = manager()
    service.installBundle.mockResolvedValueOnce({ application: 'failed', error: { code: 'already-installed' } })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    try {
      const result = await runtime.runPlugin('desktop', ['add', spec])

      // The command itself is kept: a reporter verified it is the only route
      // that works on dsh 0.2.1 (#909). Removing it would trade a documented
      // cost for an undocumented dead end.
      expect(result.stderr).toContain(`pnpm add ${spec} --config.minimum-release-age=0`)
      // ...but the cost is now stated next to it.
      expect(result.stderr).toMatch(/\*\*所有插件\*\*的安装\/更新都会被拦下|so \*\*every\*\* plugin install\/update is refused/)
      expect(result.stderr).toContain('#944')
      // ...together with the one-line remedy, which must land on the SAME-name
      // row: a second row is shadowed by pnpm 11.7.0 (#883), so "add a line"
      // would be advice that does not work.
      expect(result.stderr).toContain('minimumReleaseAgeExclude')
      expect(result.stderr).toMatch(/这个名字的那一行|the row for/)
      expect(result.stderr).toMatch(/\|\| 1\.66\.44/)
      // Scoped rows are written quoted, so "append at end of line" would
      // produce `- '@scope/pkg@1.0.0' || 1.0.1`, which is not YAML. The copy
      // says where the version goes.
      expect(result.stderr).toMatch(/引号里面|inside the quotes/)
      expect(result.stderr).toMatch(/只读第一条|reads only the first/)
    } finally {
      await runtime.dispose()
    }
  })

  it('omits the append remedy when the spec names a dist-tag, not a version', async () => {
    // `routes.ts` falls back to `${name}@${tag}` when registry metadata is
    // unavailable; ` || beta` is not a valid exclusion and pnpm rejects the
    // whole workspace file over it. The cost sentence still applies.
    const service = manager()
    service.installBundle.mockResolvedValueOnce({ application: 'failed', error: { code: 'already-installed' } })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    try {
      const result = await runtime.runPlugin('desktop', ['add', 'dshmarket@beta'])
      expect(result.stderr).toMatch(/\*\*所有插件\*\*|\*\*every\*\*/)
      expect(result.stderr).not.toMatch(/\|\| beta/)
      expect(result.stderr).not.toMatch(/引号里面|inside the quotes/)
    } finally {
      await runtime.dispose()
    }
  })

  it('keeps a scoped package name whole when reinstalling', async () => {
    const service = manager()
    service.installBundle
      .mockResolvedValueOnce({ application: 'failed', error: { code: 'already-installed' }, packageResult: { exitCode: 1, output: '' } })
      .mockResolvedValueOnce({ application: 'applied', packageResult: { exitCode: 0, output: 'ok' } })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    try {
      await runtime.runPlugin('desktop', ['add', '@deepseek-ai/dsh-plugin-x@0.2.1'])
      expect(service.removeBundle).toHaveBeenCalledWith('@deepseek-ai/dsh-plugin-x')
    } finally {
      await runtime.dispose()
    }
  })

  it('reports the removal when the reinstall cannot start', async () => {
    const service = manager()
    service.installBundle.mockResolvedValueOnce({ application: 'failed', error: { code: 'already-installed' }, packageResult: { exitCode: 1, output: '' } })
    // Refused before pnpm: the manager returns a failure with no package result.
    service.removeBundle.mockResolvedValueOnce({ application: 'failed', error: { code: 'bundle-in-use' } })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    try {
      await expect(runtime.runPlugin('desktop', ['add', 'example@2.0.0'])).resolves
        .toMatchObject({ exitCode: 1, stderr: expect.stringContaining('(bundle-in-use)'), wroteNothing: true })
      expect(service.installBundle).toHaveBeenCalledTimes(1)
    } finally {
      await runtime.dispose()
    }
  })

  it('says so when a refusal happened before pnpm ran, and not when it did (#897)', async () => {
    const service = manager()
    // Before pnpm: no packageResult — the profile is untouched.
    service.installBundle.mockResolvedValueOnce({ application: 'failed', error: { code: 'already-installed' } })
    service.removeBundle.mockResolvedValueOnce({ application: 'failed', error: { code: 'already-installed' } })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    try {
      await expect(runtime.runPlugin('desktop', ['add', 'example@2.0.0'])).resolves
        .toMatchObject({ exitCode: 1, wroteNothing: true, stderr: expect.stringContaining('profile 没有任何改动') })
    } finally {
      await runtime.dispose()
    }
  })

  it('does not claim an untouched profile when pnpm did run', async () => {
    const service = manager()
    service.installBundle.mockResolvedValueOnce({
      application: 'failed', error: { code: 'operation-error' }, packageResult: { exitCode: 1, output: 'boom' },
    })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    try {
      const result = await runtime.runPlugin('desktop', ['add', 'example@2.0.0'])
      expect(result.exitCode).toBe(1)
      expect(result.wroteNothing).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  it('treats a pre-install host check as an untouched profile, and names the knob (#912)', async () => {
    // The host checks github.com reachability before it runs pnpm and gives
    // up after five seconds. That is not a write — but the manager attaches a
    // package result, so wroteNothing used to be false and the update route
    // "restored" a profile nothing had touched (#912).
    const service = manager()
    service.installBundle.mockResolvedValueOnce({
      application: 'failed',
      error: { code: 'operation-error', diagnostic: 'dsh: connection to github.com timed out after 5000ms' },
      packageResult: { exitCode: 1, output: '' },
    })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    try {
      const result = await runtime.runPlugin('desktop', ['add', 'example@2.0.0'])
      expect(result.exitCode).toBe(1)
      expect(result.wroteNothing).toBe(true)
      // The five seconds are the host's own check, not the install failing.
      expect(result.stderr).toContain('githubConnectionTimeoutMs')
      expect(result.stderr).toContain('profile 没有任何改动')
    } finally {
      await runtime.dispose()
    }
  })

  it('maps manager failure without reporting success', async () => {
    const service = manager()
    service.installBundle.mockResolvedValueOnce({ application: 'failed', error: { code: 'network' }, packageResult: { exitCode: 1, output: '' } })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    // Unrecognized codes stay as the manager wrote them.
    await expect(runtime.runPlugin('desktop', ['add', 'example'])).resolves.toMatchObject({ exitCode: 1, stderr: '{"code":"network"}' })
  })

  it('journals an update before removing and clears the record once the reinstall settles (#928)', async () => {
    // The two-step update writes the profile at the removal, so the record has
    // to exist BEFORE `removeBundle` is called — a record written after it
    // would never describe the interruption that loses the plugin.
    const dir = profile()
    installed(dir, 'example', '1.0.0')
    const journalFile = pendingUpdatesFile(dir)
    const service = manager()
    service.installBundle.mockResolvedValueOnce({ application: 'failed', error: { code: 'already-installed' }, packageResult: { exitCode: 1, output: '' } })
      .mockResolvedValueOnce({ application: 'applied', packageResult: { exitCode: 0, output: 'installed 2.0.0' } })
    let duringRemoval: unknown
    service.removeBundle.mockImplementationOnce(async () => {
      duringRemoval = JSON.parse(readFileSync(journalFile, 'utf8'))
      return { application: 'applied', packageResult: { exitCode: 0, output: 'removed' } }
    })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir)
    try {
      await expect(runtime.runPlugin('desktop', ['add', 'example@2.0.0'])).resolves.toMatchObject({ exitCode: 0 })
      expect(duringRemoval).toMatchObject({ operations: [expect.objectContaining({ name: 'example', from: '1.0.0', to: '2.0.0', step: 'removing' })] })
      // The install settled, so the next start has nothing to repair.
      expect(JSON.parse(readFileSync(journalFile, 'utf8')).operations).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it('stops waiting when the manager never settles and asks the next start to repair (#928)', async () => {
    // The reported shape: the removal wrote the profile, the host's reload
    // never answered, and the market kept the operation "updating" forever
    // while holding the profile lock. The deadline ends the wait; the record
    // stays for the next start.
    vi.useFakeTimers()
    const dir = profile()
    installed(dir, 'example', '1.0.0')
    const service = manager()
    service.installBundle.mockResolvedValueOnce({ application: 'failed', error: { code: 'already-installed' }, packageResult: { exitCode: 1, output: '' } })
    service.removeBundle.mockImplementationOnce(() => new Promise(() => {}))
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir)
    try {
      const running = runtime.runPlugin('desktop', ['add', 'example@2.0.0'])
      await vi.advanceTimersByTimeAsync(90_000)
      const result = await running
      expect(result).toMatchObject({
        exitCode: 1,
        repairOnRestart: true,
        refusalCode: 'update-incomplete',
        // Not "nothing was written": the removal may already be on disk.
        wroteNothing: false,
      })
      expect(result.stderr).toContain('重新打开 DSH')
      expect(result.stderr).toContain('(update-incomplete)')
      const journal = JSON.parse(readFileSync(pendingUpdatesFile(dir), 'utf8'))
      expect(journal.operations).toMatchObject([{ name: 'example', step: 'removing' }])
    } finally {
      vi.useRealTimers()
      await runtime.dispose()
    }
  })

  it('drops a pending repair when the user uninstalls the package explicitly (#928)', async () => {
    const dir = profile()
    const journal = new PendingUpdateJournal(pendingUpdatesFile(dir))
    journal.begin({ profile: 'desktop', name: 'example', from: '1.0.0', to: '2.0.0', spec: 'example@2.0.0' })
    const service = manager()
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir)
    try {
      await expect(runtime.runPlugin('desktop', ['remove', 'example'])).resolves.toMatchObject({ exitCode: 0 })
      expect(service.removeBundle).toHaveBeenCalledWith('example')
      expect(new PendingUpdateJournal(pendingUpdatesFile(dir)).list()).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it('repairs an interrupted update on demand through the runtime (#928)', async () => {
    const dir = profile()
    const journal = new PendingUpdateJournal(pendingUpdatesFile(dir))
    const record = journal.begin({ profile: 'desktop', name: 'example', from: '1.0.0', to: '2.0.0', spec: 'example@2.0.0' })
    journal.mark(record.id, 'installing')
    const service = manager()
    service.installBundle.mockImplementationOnce(async () => {
      installed(dir, 'example', '2.0.0')
      return { application: 'applied', packageResult: { exitCode: 0, output: 'installed 2.0.0' } }
    })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir)
    try {
      await expect(runtime.repairPendingUpdates()).resolves.toMatchObject({ reinstalled: ['example'], failed: [] })
      expect(service.installBundle).toHaveBeenCalledWith('example@2.0.0', { requestId: expect.any(String) })
      expect(existsSync(pendingUpdatesFile(dir))).toBe(true)
      expect(JSON.parse(readFileSync(pendingUpdatesFile(dir), 'utf8')).operations).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })
})
