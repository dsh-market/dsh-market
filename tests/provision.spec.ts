/**
 * One-click pnpm setup (#149): a successful install must not be reported as
 * a failure just because the new binary is not on the PATH this process
 * already resolved.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: childProcess.spawn }))

/**
 * The command a spawn call really represents. On Windows the market routes
 * shim-able tools through `cmd.exe /d /s /c "<command line>"` (#80), so the
 * `file` argument is COMSPEC and the real command lives in the last arg —
 * matching on `file` alone silently misses every case there.
 */
function commandOf(file: string, args: readonly string[]): string {
  if (!/cmd(\.exe)?$/i.test(file)) return [file, ...args].join(' ')
  const line = String(args[args.length - 1] ?? '')
  return line.replace(/^"|"$/g, '')
}

/** One fake child: exits with `code` after emitting `stdout`. */
function fakeChild(code: number, stdout = ''): EventEmitter & Record<string, unknown> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  const out = Readable.from(stdout === '' ? [] : [Buffer.from(stdout)])
  child.stdout = out
  child.stderr = Readable.from([])
  // `close` must come AFTER the stream has handed its data to the collector,
  // or runQuiet resolves with empty output and every output-based branch
  // (the npm prefix, the ENOENT hint) silently misreads.
  out.once('end', () => setImmediate(() => child.emit('close', code)))
  if (stdout === '') setImmediate(() => child.emit('close', code))
  return child
}

beforeEach(() => {
  childProcess.spawn.mockReset()
  vi.resetModules()
})

describe('provisionPnpm (#149)', () => {
  it('succeeds when pnpm only becomes visible via npm\'s global bin', async () => {
    // The reported shape: corepack exit=0, npm -g exit=0 — the install
    // WORKED — yet `pnpm --version` still fails, because the binary landed
    // in a prefix this process never had on PATH.
    const calls: string[][] = []
    const globalBin = process.platform === 'win32' ? 'C:\\npm-prefix' : '/opt/custom-prefix'
    childProcess.spawn.mockImplementation((file: string, args: string[], options: { env?: Record<string, string> }) => {
      const command = commandOf(file, args)
      calls.push([command])
      if (command.startsWith('corepack')) return fakeChild(0)
      if (command.startsWith('npm install')) return fakeChild(0)
      if (command.startsWith('npm prefix')) return fakeChild(0, `${globalBin}\n`)
      // pnpm runs only once the discovered bin dir is on the spawn PATH.
      const path = options.env?.PATH ?? ''
      return fakeChild(path.includes(globalBin) ? 0 : 1)
    })

    const { provisionPnpm } = await import('../src/dsh-cli.ts')
    await expect(provisionPnpm()).resolves.toEqual({ ok: true })
    // It asked npm where it installed, rather than giving up.
    expect(calls.some(call => call[0].startsWith('npm prefix'))).toBe(true)
  })

  it('still reports failure — with a hint — when pnpm genuinely cannot run', async () => {
    childProcess.spawn.mockImplementation((file: string, args: string[]) => {
      const command = commandOf(file, args)
      if (command.startsWith('corepack')) return fakeChild(1, 'spawn corepack ENOENT')
      if (command.startsWith('npm install')) return fakeChild(1, 'spawn npm ENOENT')
      if (command.startsWith('npm prefix')) return fakeChild(1)
      return fakeChild(1)
    })

    const { provisionPnpm } = await import('../src/dsh-cli.ts')
    const result = await provisionPnpm()
    expect(result.ok).toBe(false)
    expect(result.hint).toContain('找不到 Node')
  })
})
