import { PassThrough } from 'node:stream'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
