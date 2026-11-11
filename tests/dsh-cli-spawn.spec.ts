import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: childProcess.spawn }))

// Exercise the real callers and shim, mocking only the OS process boundary.
// Explicit close/data events keep cancellation and timeout tests deterministic.
function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 530,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  })
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const originalArgv = process.argv
const originalExecArgv = process.execArgv
let home: string
let child: ReturnType<typeof fakeChild>

function platform(value: string) {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value })
}

beforeEach(() => {
  vi.resetModules()
  childProcess.spawn.mockReset()
  child = fakeChild()
  childProcess.spawn.mockImplementation(() => childProcess.spawn.mock.calls.length === 1 ? child : fakeChild())
  home = mkdtempSync(join(tmpdir(), 'dsh-market-spawn-'))
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('ComSpec', 'cmd.exe')
  vi.stubEnv('DSH_MARKET_INSTALL_TIMEOUT_MS', '1000')
  process.argv = [process.execPath, 'desktop-host.js']
  process.execArgv = []
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  process.argv = originalArgv
  process.execArgv = originalExecArgv
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.resetModules()
  rmSync(home, { recursive: true, force: true })
})

// Keep inherited environment values out of assertion diffs (they can hold
// credentials), while checking the caller's environment still reaches spawn.
function expectSpawn(index: number, file: string, args: string[], extra = {}) {
  const [actualFile, actualArgs, { env, ...options }] = childProcess.spawn.mock.calls[index]!
  expect([actualFile, actualArgs]).toEqual([file, args])
  expect(options).toEqual({
    stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true, ...extra,
  })
  expect(env.CI).toBe('true')
  expect(env.DSH_HOME === home).toBe(true)
  expect(typeof env.PATH).toBe('string')
}

function expectTaskkill(index: number) {
  expect(childProcess.spawn.mock.calls[index]).toEqual([
    'taskkill', ['/pid', '530', '/t', '/f'], { stdio: 'ignore', windowsHide: true },
  ])
  expect(child.kill).not.toHaveBeenCalled()
}

// Official launcher contract: deepseek-ai/deepseek-harness at
// dsh-v0.2.0-rc.2, apps/desktop/cli/{dsh,dsh.cmd} and
// apps/desktop-host/src/cli.ts. This covers launcher identity, not #975's bind.
describe('Web profiles launched by the bundled Desktop CLI', () => {
  describe.each(['win32', 'linux', 'darwin'])('%s', (os) => {
    describe.each(['/', '\\'])('%s entry separators', (separator) => {
      it.each([
        ['add', '@scope/plugin@1.0.0'],
        ['add', '--force', '@scope/plugin@2.0.0'],
        ['remove', '@scope/plugin'],
        ['install'],
      ])('keeps the original carrier for %j instead of selecting a PATH dsh', async (...args) => {
        platform(os)
        // This path is deliberately not a physical directory. Electron can read
        // the entry inside app.asar, but the OS cannot chdir into the archive.
        const entry = [home, 'Application with spaces', 'resources', 'app.asar', 'dsh',
          'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'].join(separator)
        process.argv = [process.execPath, entry, 'web', '--no-open']
        process.execArgv = ['--expose-internals', '--no-warnings']
        vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
        const { runDshPlugin, nodeExecutable, progress } = await import('../src/dsh-cli.ts')
        const result = runDshPlugin('web', args)
        child.emit('close', 0)
        await expect(result).resolves.toMatchObject({ exitCode: 0, cancelled: false, timedOut: false })
        expectSpawn(0, nodeExecutable(), [
          '--expose-internals', '--no-warnings', resolve(entry),
          'plugin', '--profile', 'web', ...args, '--reporter=ndjson',
        ], { cwd: undefined, detached: os !== 'win32' })
        expect(childProcess.spawn.mock.calls[0]![2].env.ELECTRON_RUN_AS_NODE).toBe('1')
        expect(progress.active).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
      })
    })

    it('inherits the launcher cwd for a bin.js entry inside an .asar archive (#1146)', async () => {
      platform(os)
      // Community desktop shells keep the DSH CLI itself inside the packaged
      // asar (deepseek-harness-pkg-<platform>.asar) instead of shipping a
      // dsh-desktop-host carrier, so the generic bin.js branch must not hand
      // the archive's virtual directory to the child as its cwd.
      const entry = join(home, 'dependencies', 'dsh', 'deepseek-harness-pkg-windows.asar',
        'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      process.argv = [process.execPath, entry, 'web', '--no-open']
      process.execArgv = ['--no-warnings']
      vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
      const { dshArgv, nodeExecutable, runDshPlugin } = await import('../src/dsh-cli.ts')
      expect(dshArgv()).toEqual({
        file: nodeExecutable(), args: ['--no-warnings', resolve(entry)], cwd: undefined, viaShell: false,
      })
      const result = runDshPlugin('web', ['install'])
      child.emit('close', 0)
      await expect(result).resolves.toMatchObject({ exitCode: 0, cancelled: false, timedOut: false })
      expectSpawn(0, nodeExecutable(), [
        '--no-warnings', resolve(entry), 'plugin', '--profile', 'web', 'install', '--reporter=ndjson',
      ], { cwd: undefined, detached: os !== 'win32' })
    })

    it.each(['failure', 'error', 'cancel', 'timeout'])('preserves the %s outcome', async (outcome) => {
      platform(os)
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
      process.argv = [process.execPath, join(home, 'node_modules', '@deepseek-ai',
        'dsh-desktop-host', 'lib', 'cli.js'), 'web']
      const { runDshPlugin, cancelActive, progress } = await import('../src/dsh-cli.ts')
      const result = runDshPlugin('web', ['install'])
      child.stderr.emit('data', Buffer.from('listen EADDRINUSE 127.0.0.1:3080'))
      if (outcome === 'cancel') expect(cancelActive()).toBe(true)
      if (outcome === 'timeout') vi.advanceTimersByTime(1000)
      if (outcome === 'error') child.emit('error', new Error('spawn ENOENT'))
      else child.emit('close', 1)
      await expect(result).resolves.toMatchObject({
        exitCode: outcome === 'error' ? 127 : 1,
        cancelled: outcome === 'cancel',
        timedOut: outcome === 'timeout',
        stderr: expect.stringContaining('EADDRINUSE'),
      })
      expect(progress.active).toBe(false)
      expect(progress.cancelling).toBe(false)
      expect(cancelActive()).toBe(false)
      // POSIX deliberately retains the process-group SIGKILL escalation.
      vi.advanceTimersByTime(5000)
      expect(vi.getTimerCount()).toBe(0)
      kill.mockRestore()
    })
  })

  describe.each(['win32', 'linux', 'darwin'])('%s entry boundaries', (os) => {
    it.each([
      ['another-app', 'lib', 'cli.js'],
      ['@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'],
      ['node_modules', '@other', 'dsh-desktop-host', 'lib', 'cli.js'],
      ['node_modules', '@deepseek-ai', 'other-host', 'lib', 'cli.js'],
      ['node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.ts'],
      ['node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'nested', 'cli.js'],
      ['node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js.backup'],
    ])('keeps PATH fallback for %j', async (...parts) => {
      platform(os)
      process.argv = [process.execPath, join(home, ...parts)]
      const { dshArgv, runDshPlugin } = await import('../src/dsh-cli.ts')
      expect(dshArgv()).toEqual({ file: 'dsh', args: [], cwd: undefined, viaShell: os === 'win32' })
      const result = runDshPlugin('web', ['install'])
      child.emit('close', 0)
      await result
      if (os === 'win32') {
        expectSpawn(0, 'cmd.exe', ['/d', '/s', '/c', '"dsh plugin --profile web install --reporter=ndjson"'], {
          cwd: undefined, detached: false, windowsVerbatimArguments: true,
        })
      } else {
        expectSpawn(0, 'dsh', ['plugin', '--profile', 'web', 'install', '--reporter=ndjson'], {
          cwd: undefined, detached: true,
        })
      }
    })

    describe.each(['absolute', 'relative'])('%s entry', (kind) => {
      it.each(['bin.js', 'bin.ts', 'dsh'])('preserves the existing %s entry and loader flags', async (name) => {
        platform(os)
        const entry = kind === 'absolute' ? join(home, 'source checkout', name) : join('source checkout', name)
        process.argv = [process.execPath, entry, 'web']
        process.execArgv = ['--import', 'tsx/esm', '--expose-internals']
        const { dshArgv, nodeExecutable, runDshPlugin } = await import('../src/dsh-cli.ts')
        expect(dshArgv()).toEqual({
          file: nodeExecutable(), args: [...process.execArgv, resolve(entry)], cwd: dirname(resolve(entry)), viaShell: false,
        })
        const result = runDshPlugin('web', ['install'])
        child.emit('close', 0)
        await result
        expectSpawn(0, nodeExecutable(), [
          ...process.execArgv, resolve(entry), 'plugin', '--profile', 'web', 'install', '--reporter=ndjson',
        ], { cwd: dirname(resolve(entry)), detached: os !== 'win32' })
      })
    })
  })
})

describe('--config overrides reach pnpm as environment variables (#615)', () => {
  it('sets PNPM_CONFIG_* only on the run that carries the override', async () => {
    platform('linux')
    const { runDshPlugin } = await import('../src/dsh-cli.ts')
    const retried = runDshPlugin('web', ['add', '--config.fetchTimeout=600000', '@scope/plugin@^1.0.0'])
    child.emit('close', 0)
    await retried
    const [, , retriedOptions] = childProcess.spawn.mock.calls[0]!
    expect(retriedOptions.env.PNPM_CONFIG_FETCH_TIMEOUT).toBe('600000')
    expect(retriedOptions.env.PNPM_CONFIG_AUTO_INSTALL_PEERS).toBeUndefined()

    const peers = runDshPlugin('web', ['add', '--config.auto-install-peers=false', '@scope/plugin@^1.0.0'])
    childProcess.spawn.mock.results[1]!.value.emit('close', 0)
    await peers
    const [, , peersOptions] = childProcess.spawn.mock.calls[1]!
    expect(peersOptions.env.PNPM_CONFIG_AUTO_INSTALL_PEERS).toBe('false')
    expect(peersOptions.env.PNPM_CONFIG_FETCH_TIMEOUT).toBeUndefined()

    const plain = runDshPlugin('web', ['add', '@scope/plugin@^1.0.0'])
    childProcess.spawn.mock.results[2]!.value.emit('close', 0)
    await plain
    const [, , plainOptions] = childProcess.spawn.mock.calls[2]!
    expect(plainOptions.env.PNPM_CONFIG_FETCH_TIMEOUT).toBeUndefined()
    expect(plainOptions.env.PNPM_CONFIG_AUTO_INSTALL_PEERS).toBeUndefined()
  })
})

describe('background process consoles (#530)', () => {
  describe.each(['win32', 'linux'])('%s', (os) => {
    describe.each(['node', 'fallback'])('%s launcher', (launcher) => {
      it.each([
        ['install', ['add', '@scope/plugin@^1.0.0']],
        ['update', ['add', '--force', '@scope/plugin@2.0.0']],
        ['uninstall', ['remove', '@scope/plugin']],
      ])('hides the %s process without changing argv or spawn semantics', async (_operation, args) => {
        platform(os)
        const entry = join(home, 'DSH with spaces', 'bin.js')
        if (launcher === 'node') {
          process.argv = [process.execPath, entry]
          process.execArgv = ['--no-warnings']
        }
        const { runDshPlugin, nodeExecutable } = await import('../src/dsh-cli.ts')
        const result = runDshPlugin('工作 profile', args)
        child.stdout.emit('data', Buffer.from('progress\n'))
        child.stderr.emit('data', Buffer.from('diagnostic\n'))
        child.emit('close', 0)
        await expect(result).resolves.toMatchObject({
          exitCode: 0, timedOut: false, cancelled: false,
          stdout: 'progress\n', stderr: 'diagnostic\n',
        })
        expect(childProcess.spawn).toHaveBeenCalledTimes(1)
        const options = { cwd: launcher === 'node' ? dirname(entry) : undefined, detached: os !== 'win32' }
        if (launcher === 'node') {
          expectSpawn(0, nodeExecutable(), [
            '--no-warnings', entry, 'plugin', '--profile', '工作 profile', ...args, '--reporter=ndjson',
          ], options)
        } else if (os === 'win32') {
          // Independent expected command lines also pin quoting of spaces
          // and the caret-bearing semver range at the actual spawn boundary.
          const tail = args[1] === '@scope/plugin@^1.0.0'
            ? 'add "@scope/plugin@^1.0.0"' : args.join(' ')
          expectSpawn(0, 'cmd.exe', [
            '/d', '/s', '/c', `"dsh plugin --profile "工作 profile" ${tail} --reporter=ndjson"`,
          ], { ...options, windowsVerbatimArguments: true })
        } else {
          expectSpawn(0, 'dsh', ['plugin', '--profile', '工作 profile', ...args, '--reporter=ndjson'], options)
        }
        expect(vi.getTimerCount()).toBe(0)
      })
    })

    it('hides the pnpm availability probe', async () => {
      platform(os)
      const { probePnpm } = await import('../src/dsh-cli.ts')
      const result = probePnpm()
      child.emit('close', 0)
      await expect(result).resolves.toBe(true)
      if (os === 'win32') {
        expectSpawn(0, 'cmd.exe', ['/d', '/s', '/c', '"pnpm --version"'], { windowsVerbatimArguments: true })
      } else {
        expectSpawn(0, 'pnpm', ['--version'])
      }
    })
  })

  it('keeps the defensive non-Windows shim branch hidden and shell-free', async () => {
    platform('win32')
    const { probePnpm } = await import('../src/dsh-cli.ts')
    // winCmdShim is captured on import; change the platform afterwards to
    // exercise spawnShim's defensive viaShell-on-non-Windows branch.
    platform('linux')
    const result = probePnpm()
    child.emit('close', 0)
    await expect(result).resolves.toBe(true)
    expectSpawn(0, 'pnpm', ['--version'])
  })

  it('hides provisioning and its timeout cleanup before falling back to npm', async () => {
    platform('win32')
    const { provisionPnpm } = await import('../src/dsh-cli.ts')
    const result = provisionPnpm()
    vi.advanceTimersByTime(59_999)
    expect(childProcess.spawn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    child.emit('close', 1)
    // Let provisionPnpm enter each awaited probe/command before closing it.
    await Promise.resolve()
    childProcess.spawn.mock.results[2]!.value.emit('close', 1)
    await Promise.resolve()
    childProcess.spawn.mock.results[3]!.value.emit('close', 0)
    await Promise.resolve()
    childProcess.spawn.mock.results[4]!.value.emit('close', 0)
    await expect(result).resolves.toEqual({ ok: true })
    expect(childProcess.spawn).toHaveBeenCalledTimes(5)
    expectSpawn(0, 'cmd.exe', ['/d', '/s', '/c', '"corepack enable pnpm"'], { windowsVerbatimArguments: true })
    expectTaskkill(1)
    expectSpawn(2, 'cmd.exe', ['/d', '/s', '/c', '"pnpm --version"'], { windowsVerbatimArguments: true })
    expectSpawn(3, 'cmd.exe', ['/d', '/s', '/c', '"npm install -g pnpm"'], { windowsVerbatimArguments: true })
    expectSpawn(4, 'cmd.exe', ['/d', '/s', '/c', '"pnpm --version"'], { windowsVerbatimArguments: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['cancel', 'timeout'])('hides taskkill during plugin %s and preserves the result', async (reason) => {
    platform('win32')
    const { runDshPlugin, cancelActive, progress } = await import('../src/dsh-cli.ts')
    const result = runDshPlugin('web', ['add', '@scope/plugin'])
    if (reason === 'cancel') {
      expect(cancelActive()).toBe(true)
      expect(progress.cancelling).toBe(true)
    } else {
      vi.advanceTimersByTime(999)
      expect(childProcess.spawn).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1)
    }
    child.emit('close', 1)
    await expect(result).resolves.toMatchObject({
      exitCode: 1, cancelled: reason === 'cancel', timedOut: reason === 'timeout',
    })
    expect(childProcess.spawn).toHaveBeenCalledTimes(2)
    expectTaskkill(1)
    expect(cancelActive()).toBe(false)
    expect(progress.active).toBe(false)
    expect(progress.cancelling).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['%USERPROFILE%', '@scope/plugin'],
    ['web', '@scope/plugin&whoami'],
  ])('still rejects unsafe shim input: %s / %s', async (profile, target) => {
    platform('win32')
    const { runDshPlugin } = await import('../src/dsh-cli.ts')
    await expect(runDshPlugin(profile, ['add', target])).resolves.toMatchObject({ exitCode: 1 })
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })
})
