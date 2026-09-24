import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOfficialDesktopRuntime, type OfficialPluginManagerLike } from '../src/official-desktop.ts'

const roots: string[] = []

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-official-'))
  roots.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { example: '1.0.0', gitplug: 'github:o/r' } }))
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

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
  it('installs through the in-process manager and never the CLI', async () => {
    const service = manager()
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    await expect(runtime.runPlugin('desktop', ['add', 'example@2.0.0'])).resolves.toMatchObject({ exitCode: 0, stdout: 'installed' })
    expect(service.installBundle).toHaveBeenCalledWith('example@2.0.0', { requestId: expect.any(String) })
    await runtime.dispose()
  })

  it('refuses another profile, absent service, and unsupported pnpm flags', async () => {
    const service = manager()
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    await expect(runtime.runPlugin('web', ['add', 'example'])).resolves.toMatchObject({ exitCode: 127 })
    await expect(runtime.runPlugin('desktop', ['add', '--force', 'example'])).resolves.toMatchObject({ exitCode: 127 })
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

  it('maps manager failure without reporting success', async () => {
    const service = manager()
    service.installBundle.mockResolvedValueOnce({ application: 'failed', error: { code: 'network' }, packageResult: { exitCode: 1, output: '' } })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    await expect(runtime.runPlugin('desktop', ['add', 'example'])).resolves.toMatchObject({ exitCode: 1, stderr: '{"code":"network"}' })
  })
})
