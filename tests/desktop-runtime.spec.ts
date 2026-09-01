import { PassThrough } from 'node:stream'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDesktopPluginRuntime,
  progress,
  type DesktopPnpmLike,
} from '../src/dsh-cli.ts'

const roots: string[] = []

function profileFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-desktop-profile-'))
  roots.push(dir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"dependencies":{}}')
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  return dir
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('DSH Desktop package runtime', () => {
  it('uses the host profile directory and streams one managed runPlugin operation', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let resolveDone!: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
      resolveDone = resolve
    })
    const calls: { args: readonly string[]; dir: string; signal?: AbortSignal }[] = []
    const service: DesktopPnpmLike = {
      runPlugin(args, dir, signal) {
        calls.push({ args, dir, signal })
        return { stdout, stderr, done, cancel: () => {} }
      },
    }
    const dir = profileFixture()
    const runtime = createDesktopPluginRuntime(service, dir, '/tmp', 10_000)
    const resultPromise = runtime.runPlugin('must-not-select-a-profile', ['add', 'example-plugin'])
    stdout.write('{"name":"pnpm:progress","packageId":"example-plugin@1.0.0","status":"resolved"}\n')
    stderr.write('checking package\n')
    resolveDone({ exitCode: 0, signal: null })

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      stderr: 'checking package\n',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual(['add', '-w', 'example-plugin', '--reporter=ndjson'])
    expect(calls[0].dir).toBe('/tmp')
    expect(calls[0].signal).toBeInstanceOf(AbortSignal)
    expect(progress.active).toBe(false)
  })

  it('cancels and awaits the owned operation during teardown, then rejects reuse', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let resolveDone!: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
      resolveDone = resolve
    })
    let cancelled = 0
    const service: DesktopPnpmLike = {
      runPlugin() {
        return {
          stdout,
          stderr,
          done,
          cancel: () => {
            cancelled += 1
            resolveDone({ exitCode: null, signal: 'SIGTERM' })
          },
        }
      },
    }
    const runtime = createDesktopPluginRuntime(service, profileFixture(), '/tmp', 10_000)
    const resultPromise = runtime.runPlugin('desktop', ['remove', 'example-plugin'])
    await runtime.dispose()

    expect(cancelled).toBe(1)
    await expect(resultPromise).resolves.toMatchObject({ exitCode: null, cancelled: false })
    await expect(runtime.runPlugin('desktop', ['update'])).resolves.toMatchObject({
      exitCode: 127,
      stderr: expect.stringContaining('disposed'),
    })
  })

  it('marks an explicit UI cancellation without provisioning system pnpm', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let resolveDone!: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
      resolveDone = resolve
    })
    const service: DesktopPnpmLike = {
      runPlugin() {
        return {
          stdout,
          stderr,
          done,
          cancel: () => resolveDone({ exitCode: null, signal: 'SIGTERM' }),
        }
      },
    }
    const runtime = createDesktopPluginRuntime(service, profileFixture(), '/tmp', 10_000)
    const resultPromise = runtime.runPlugin('desktop', ['update'])
    expect(await runtime.probePnpm()).toBe(true)
    await expect(runtime.provisionPnpm()).resolves.toEqual({ ok: true })
    expect(runtime.cancelActive()).toBe(true)
    await expect(resultPromise).resolves.toMatchObject({ cancelled: true, timedOut: false })
  })

  it('preserves the Desktop generation-wide busy signal', async () => {
    const service: DesktopPnpmLike = {
      runPlugin() {
        throw new Error('dsh-plugin-desktop: another desktop pnpm operation is already running')
      },
    }
    const runtime = createDesktopPluginRuntime(service, profileFixture(), '/tmp', 10_000)
    await expect(runtime.runPlugin('desktop', ['update'])).resolves.toMatchObject({
      exitCode: 127,
      busy: true,
      cancelled: false,
    })
  })

  it('cancels the operation handle when the market timeout expires', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let resolveDone!: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
      resolveDone = resolve
    })
    let cancelled = 0
    const service: DesktopPnpmLike = {
      runPlugin() {
        return {
          stdout,
          stderr,
          done,
          // Deliberately ignore AbortSignal: the returned handle remains the
          // required process-tree cancellation contract.
          cancel: () => {
            cancelled += 1
            resolveDone({ exitCode: null, signal: 'SIGTERM' })
          },
        }
      },
    }
    const runtime = createDesktopPluginRuntime(service, profileFixture(), '/tmp', 5)

    await expect(runtime.runPlugin('desktop', ['update'])).resolves.toMatchObject({
      exitCode: null,
      timedOut: true,
      cancelled: false,
    })
    expect(cancelled).toBe(1)
  })
})

describe('Anywhere Labs install boundary (#215, #219, #272)', () => {
  /** A service exposing both entry points, recording which one was used. */
  function boundaryService(): {
    service: DesktopPnpmLike
    plain: { args: readonly string[] }[]
    boundary: { args: readonly string[] }[]
  } {
    const plain: { args: readonly string[] }[] = []
    const boundary: { args: readonly string[] }[] = []
    const handle = () => ({
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      done: Promise.resolve({ exitCode: 0, signal: null }),
      cancel: () => {},
    })
    return {
      plain,
      boundary,
      service: {
        runPlugin(args) { plain.push({ args }); return handle() },
        runExternalMarketPluginInstall(args) { boundary.push({ args }); return handle() },
      },
    }
  }

  it('sends add through the boundary, with the version their validator demands', async () => {
    // Their Desktop rejects `add` on runPlugin outright, and the boundary it
    // offers instead accepts ONLY `name@1.2.3` — not a bare name, which is
    // what the market sends for a registry plugin. Read from their published
    // validateExternalMarketInstallArgs, not assumed.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '2.3.4' }), { status: 200 })))
    const { service, plain, boundary } = boundaryService()
    const runtime = createDesktopPluginRuntime(service, profileFixture(), '/tmp', 10_000)
    await runtime.runPlugin('web', ['add', 'example-plugin'])
    expect(plain, 'add went down the path their host refuses').toHaveLength(0)
    expect(boundary[0]?.args).toContain('example-plugin@2.3.4')
    await runtime.dispose()
  })

  it('reports the exact rollback targets its host boundary can execute', async () => {
    const { service } = boundaryService()
    const restricted = createDesktopPluginRuntime(service, profileFixture(), '/tmp', 10_000)
    expect(restricted.supportsExactRollbackTarget?.('example-plugin@1.2.3')).toBe(true)
    expect(restricted.supportsExactRollbackTarget?.('github:owner/repo#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false)
    expect(restricted.supportsExactRollbackTarget?.('https://github.com/o/r/releases/download/v1.0.0/plugin.tgz')).toBe(false)
    await restricted.dispose()

    const ordinary = createDesktopPluginRuntime({
      runPlugin() {
        return {
          stdout: new PassThrough(), stderr: new PassThrough(),
          done: Promise.resolve({ exitCode: 0, signal: null }), cancel: () => {},
        }
      },
    }, profileFixture(), '/tmp', 10_000)
    expect(ordinary.supportsExactRollbackTarget?.('github:owner/repo#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true)
    await ordinary.dispose()
  })

  /** #138: falling back is right, but their refusal ("must use the
   * recoverable install boundary", exit 127) is accurate about their contract
   * and silent about why THIS plugin. Roughly half the catalog has no npm
   * package, and a card gives the user no way to tell from the outside. */
  it('says why a github-only plugin is out of reach on an npm-only host', async () => {
    const plain: { args: readonly string[] }[] = []
    const service: DesktopPnpmLike = {
      runPlugin(args) {
        plain.push({ args })
        throw new Error('plugin add must use the recoverable install boundary')
      },
      runExternalMarketPluginInstall() { throw new Error('should not be reached') },
    }
    const runtime = createDesktopPluginRuntime(service, profileFixture(), '/tmp', 10_000)
    const result = await runtime.runPlugin('web', ['add', 'github:owner/repo'])
    expect(result.exitCode).toBe(127)
    // Their sentence stays, and stays first.
    expect(result.stderr).toContain('recoverable install boundary')
    // Ours names the property that put the plugin out of reach, and where to
    // go instead — neither of which their message can know.
    expect(result.stderr).toContain('npm')
    expect(result.stderr).toContain('dsh web')
    await runtime.dispose()
  })

  it('adds nothing when the ordinary path is all there ever was', async () => {
    // No boundary published: this is every other client, and a failure there
    // must not acquire an explanation about a contract they do not have.
    const service: DesktopPnpmLike = {
      runPlugin() { throw new Error('some unrelated desktop failure') },
    }
    const runtime = createDesktopPluginRuntime(service, profileFixture(), '/tmp', 10_000)
    const result = await runtime.runPlugin('web', ['add', 'github:owner/repo'])
    expect(result.stderr).toBe('some unrelated desktop failure')
    await runtime.dispose()
  })

  it('leaves every other command on the ordinary path', async () => {
    const { service, plain, boundary } = boundaryService()
    const runtime = createDesktopPluginRuntime(service, profileFixture(), '/tmp', 10_000)
    await runtime.runPlugin('web', ['remove', 'example-plugin'])
    expect(boundary).toHaveLength(0)
    expect(plain).toHaveLength(1)
    await runtime.dispose()
  })

  it('does not divert a github source it cannot express there', async () => {
    // `github:owner/repo` has no `name@version` spelling, so their boundary
    // would reject it before starting anything. Falling back means their own
    // refusal reaches the user — an accurate account of their contract
    // rather than an error this package invented.
    const { service, plain, boundary } = boundaryService()
    const runtime = createDesktopPluginRuntime(service, profileFixture(), '/tmp', 10_000)
    await runtime.runPlugin('web', ['add', 'github:owner/repo'])
    expect(boundary).toHaveLength(0)
    expect(plain[0]?.args).toContain('github:owner/repo')
    await runtime.dispose()
  })

  it('uses the ordinary path on a host that has no such boundary', async () => {
    // Every other client — including the other third-party desktop app in
    // #292 — installs through the ordinary CLI. Accommodating one vendor
    // must not change what the rest do.
    const plain: { args: readonly string[] }[] = []
    const service: DesktopPnpmLike = {
      runPlugin(args) {
        plain.push({ args })
        return {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          done: Promise.resolve({ exitCode: 0, signal: null }),
          cancel: () => {},
        }
      },
    }
    const runtime = createDesktopPluginRuntime(service, profileFixture(), '/tmp', 10_000)
    await runtime.runPlugin('web', ['add', 'example-plugin'])
    expect(plain[0]?.args).toContain('example-plugin')
    await runtime.dispose()
  })
})
