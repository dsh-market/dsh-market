/**
 * One-click pnpm setup (#149): a successful install must not be reported as
 * a failure just because the new binary is not on the PATH this process
 * already resolved.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
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
    const globalPrefix = process.platform === 'win32' ? 'C:\\npm-prefix' : '/opt/custom-prefix'
    const globalBin = process.platform === 'win32' ? globalPrefix : `${globalPrefix}/bin`
    const separator = process.platform === 'win32' ? ';' : ':'
    childProcess.spawn.mockImplementation((file: string, args: string[], options: { env?: Record<string, string> }) => {
      const command = commandOf(file, args)
      calls.push([command])
      if (command.startsWith('corepack')) return fakeChild(0)
      if (command.startsWith('npm install')) return fakeChild(0)
      if (command.startsWith('npm prefix')) return fakeChild(0, `${globalPrefix}\n`)
      // pnpm runs only once the discovered bin dir is on the spawn PATH.
      const path = options.env?.PATH ?? ''
      return fakeChild(path.split(separator).includes(globalBin) ? 0 : 1)
    })

    const { provisionPnpm } = await import('../src/dsh-cli.ts')
    await expect(provisionPnpm()).resolves.toEqual({ ok: true })
    // It asked npm where it installed, rather than giving up.
    expect(calls.some(call => call[0].startsWith('npm prefix'))).toBe(true)
  })

  it('reaches the npm that ships beside the running Node when PATH has none (#167)', async () => {
    // Reported from a desktop host on Windows: Node itself is RUNNING
    // (v24.18.1 in the log), yet both `corepack` and `npm` come back
    // "not recognized as an internal or external command" — the host spawns
    // dsh without the Node install directory on PATH.
    //
    // npm and corepack live in that exact directory, and the Node binary
    // (resolved the same way the market resolves it for its children) is the
    // one path this process can always be sure of, so the setup has no
    // business failing here.
    const nodeDir = dirname((await import('../src/dsh-cli.ts')).nodeExecutable())
    childProcess.spawn.mockImplementation((_file: string, _args: string[], options: { env?: Record<string, string> }) => {
      // The whole toolchain is invisible unless Node's own directory is on
      // the PATH handed to the child — exactly the reported machine. No
      // output on the failing branch: `pnpm --version` is spawned with
      // stdio 'ignore' and never reads its streams, so a fake that produces
      // some would hang instead of failing.
      const path = options.env?.PATH ?? ''
      const separator = process.platform === 'win32' ? ';' : ':'
      return fakeChild(path.split(separator).includes(nodeDir) ? 0 : 1)
    })

    const { provisionPnpm } = await import('../src/dsh-cli.ts')
    await expect(provisionPnpm()).resolves.toEqual({ ok: true })
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
    // Names the toolchain, not "Node": #167's log has Node running at
    // v24.18.1 while npm is what is missing, and a hint that blames the
    // wrong thing sends the user to reinstall something they already have.
    expect(result.hint).toContain('找不到 npm/corepack')
  })

  it('hints on a Windows console whose "not found" is unreadable bytes (#167)', async () => {
    // Verbatim from the reported log: cmd.exe answers in the console's ANSI
    // codepage, so what reaches us is mojibake — no `ENOENT`, no English,
    // nothing to pattern-match. The reporter got an empty hint because of
    // it. Resolution on disk is what has to carry the decision.
    const garbled = "'npm' �����ڲ����ⲿ���Ҳ���ǿ����еĳ������������ļ���"
    const { provisionHint } = await import('../src/dsh-cli.ts')
    expect(provisionHint(garbled, garbled, false)).toContain('找不到 npm/corepack')
    // ...and the same bytes with npm actually present must NOT claim it is
    // missing, or every unrelated failure gets misfiled under this hint.
    expect(provisionHint(garbled, garbled, true)).not.toContain('找不到 npm/corepack')
  })

  it('still says something when every step succeeded and pnpm runs anyway (#228)', async () => {
    // The case that most needs an explanation used to get none: corepack and
    // npm both exit 0, npm is on disk, and the install button stays locked.
    // The reporter's complaint was precisely the silence — "又不告诉我怎么手动
    // 配置". Returning undefined here is what produced that.
    const { provisionHint } = await import('../src/dsh-cli.ts')
    const hint = provisionHint('', 'changed 1 package in 491ms', true)
    expect(hint).toBeDefined()
    // The actionable question, not a restatement of the failure: where is
    // pnpm, and is that anywhere this process looks?
    expect(hint).toMatch(/which pnpm|where pnpm/)
    expect(hint).toContain('PNPM_HOME')
    // And it must not misfile itself as the npm-missing case.
    expect(hint).not.toContain('找不到 npm/corepack')
  })

  it('does not report npm as missing when npm started and died in getcwd (#1270)', async () => {
    // Verbatim shape from the reported log: corepack is genuinely absent
    // (exit=127), and npm RAN and then failed to read the current directory,
    // which the host had deleted. Both outputs carry the word `ENOENT`, and
    // the `ENOENT && ENOENT` test read that as one fact — two unrelated
    // meanings on one token.
    const { provisionHint } = await import('../src/dsh-cli.ts')
    const hint = provisionHint(
      'corepack enable: exit=127 spawn corepack ENOENT',
      "npm error errno: -2, code: 'ENOENT', syscall: 'uv_cwd'\nnpm error Node.js v26.13.1",
      true,
    )
    expect(hint).toBeDefined()
    // npm is on disk, so telling this user it is missing sends them to
    // install a pnpm and abandon their supervisor over a problem they do not
    // have.
    expect(hint).not.toContain('找不到 npm/corepack')
    // The fact that explains the failure has to survive into the hint.
    expect(hint).toContain('uv_cwd')
  })

  it('still names the toolchain when a spawn never found its command (#32)', async () => {
    // What the ENOENT match was written for: neither command could be
    // spawned at all, so "this machine has no npm/corepack" is true and the
    // PATH advice applies.
    const { provisionHint } = await import('../src/dsh-cli.ts')
    expect(provisionHint('spawn corepack ENOENT', 'spawn npm ENOENT', true)).toContain('找不到 npm/corepack')
  })

  it('inherits the working directory while it is still readable (#1270)', async () => {
    // Any cwd it can read has to stay the child's cwd: npm reads a
    // per-project `.npmrc` from there, and quietly moving that lookup is a
    // behaviour change no part of this fix needs.
    const { provisionCwd } = await import('../src/dsh-cli.ts')
    expect(provisionCwd()).toBeUndefined()
  })

  it('falls back to a directory that exists when the working directory is gone (#1270)', async () => {
    // `process.cwd()` throws rather than returning a path that no longer
    // exists, so the check has to be the call itself.
    const { provisionCwd } = await import('../src/dsh-cli.ts')
    const original = process.cwd
    process.cwd = () => {
      throw Object.assign(new Error('ENOENT: no such file or directory, uv_cwd'), {
        code: 'ENOENT',
        syscall: 'uv_cwd',
      })
    }
    try {
      expect(provisionCwd()).toBe(tmpdir())
    } finally {
      process.cwd = original
    }
  })

  it('spawns the provisioning commands where they can actually start (#1270)', async () => {
    // A deleted boot directory is inherited by every child that is not given
    // a cwd, and npm dies in getcwd() before running a line of its own logic.
    // Neither `corepack enable` nor `npm i -g` reads project files, so a
    // known-live directory turns "setup failed" into "pnpm installed".
    const seen: (string | undefined)[] = []
    childProcess.spawn.mockImplementation((file: string, args: string[], options: { cwd?: string }) => {
      const command = commandOf(file, args)
      seen.push(options.cwd)
      if (command.startsWith('corepack')) return fakeChild(1, 'spawn corepack ENOENT')
      if (command.startsWith('npm install')) return fakeChild(1, "code: 'ENOENT', syscall: 'uv_cwd'")
      return fakeChild(1)
    })
    const original = process.cwd
    process.cwd = () => {
      throw Object.assign(new Error('ENOENT: no such file or directory, uv_cwd'), {
        code: 'ENOENT',
        syscall: 'uv_cwd',
      })
    }
    try {
      const { provisionPnpm } = await import('../src/dsh-cli.ts')
      await provisionPnpm()
    } finally {
      process.cwd = original
    }
    expect(seen).toContain(tmpdir())
  })
})
