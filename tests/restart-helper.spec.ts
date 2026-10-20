/**
 * The detached restart helper, tested by RUNNING it.
 *
 * #177: on Windows the helper slept a flat 1500ms, spawned the replacement,
 * and swallowed the result. The old process had exited but its listening
 * socket had not been released, so the replacement died instantly with
 * EADDRINUSE and nothing was written anywhere — the restart button appeared
 * to do nothing, every time.
 *
 * Every piece of that helper read correctly on its own, which is why this
 * spec starts a real server, holds the port, and runs the real helper source
 * against it. Asserting on the generated string would only prove the string
 * contains the words.
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { restartHelperSource, servingPort } from '../src/restart.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const done of cleanups.splice(0)) await done()
})

/** Occupy a port the way the outgoing DSH does, and hand back a release. */
async function hold(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = createServer(socket => socket.end())
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  let closed = false
  const release = async (): Promise<void> => {
    if (closed) return
    closed = true
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  cleanups.push(release)
  return { port, release }
}

/**
 * Run the helper with a stand-in "DSH" that only records that it started.
 * The marker file is the evidence: its absence means the helper is still
 * waiting, its presence means it launched.
 */
function runHelper(port: number | null, marker: string, logs: { out: string; err: string }): { kill: () => void } {
  const source = restartHelperSource(
    {
      file: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
      viaShell: false,
      detached: false,
    },
    { cwd: process.cwd() },
    logs,
    port,
  )
  const child = spawn(process.execPath, ['-e', source], { stdio: 'ignore' })
  cleanups.push(() => { child.kill() })
  return { kill: () => { child.kill() } }
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Poll until the predicate holds, or give up — never a bare sleep. */
async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await wait(100)
  }
  return predicate()
}

describe('restartHelperSource (#177)', () => {
  it('carries the replacement pid into the handoff, for the surface to wait on (#719)', () => {
    // The window itself (45s, matching the budget src/recovery.ts allows a
    // boot) is a constant in the generated source and is covered behaviourally
    // from the other side, in tests/boot-recovery.spec.ts: a live replacement
    // keeps the port. What has to be wired here is the pid — without it the
    // surface can only guess "dead" from "not listening yet", which is the
    // guess that deadlocked #719.
    const source = restartHelperSource(
      { file: process.execPath, args: ['-e', 'process.exit(1)'], viaShell: false, detached: false },
      { cwd: process.cwd() },
      { out: '/tmp/out.log', err: '/tmp/err.log' },
      1234,
      { script: '/tmp/recovery.js', config: '/tmp/recovery.json' },
    )
    expect(source).toContain('const upBy = Date.now() + 45000 + SETTLE_MS')
    expect(source).toContain('replacementPid = child.pid ?? null')
    expect(source).toContain('"--pid=" + String(replacementPid ?? 0)')
  })

  it('does not start the replacement while the old port is still held', async () => {
    const { port, release } = await hold()
    const dir = mkdtempSync(join(tmpdir(), 'dshm-restart-'))
    const marker = join(dir, 'started.txt')
    runHelper(port, marker, { out: join(dir, 'out.log'), err: join(dir, 'err.log') })

    // Comfortably past the 1500ms the old helper waited before spawning
    // regardless of the port — this is the exact window in which it produced
    // an EADDRINUSE the user never saw.
    await wait(2500)
    expect(existsSync(marker), 'the replacement started while the port was still in use').toBe(false)

    await release()
    expect(await until(() => existsSync(marker), 8000), 'the replacement never started after the port freed').toBe(true)
  }, 30_000)

  it('starts promptly once nothing is listening', async () => {
    const { port, release } = await hold()
    await release()
    const dir = mkdtempSync(join(tmpdir(), 'dshm-restart-'))
    const marker = join(dir, 'started.txt')
    runHelper(port, marker, { out: join(dir, 'out.log'), err: join(dir, 'err.log') })
    // Waiting for a free port must not become its own delay.
    expect(await until(() => existsSync(marker), 8000)).toBe(true)
  }, 30_000)

  it('records a replacement that started and then died, instead of swallowing it', async () => {
    // The old helper wrapped the whole thing in `catch {}`. A restart that
    // fails leaves nobody to report it — the process that would have logged
    // it is the one that just exited — so the helper has to.
    //
    // The port is FREE here on purpose: holding it would make the helper
    // report "still in use" and this spec would pass without ever reaching
    // the check it exists for.
    const { port, release } = await hold()
    await release()
    const dir = mkdtempSync(join(tmpdir(), 'dshm-restart-'))
    const errLog = join(dir, 'err.log')
    const source = restartHelperSource(
      { file: process.execPath, args: ['-e', 'process.exit(1)'], viaShell: false, detached: false },
      { cwd: process.cwd() },
      { out: join(dir, 'out.log'), err: errLog },
      port,
    )
    const quick = source.replace('Date.now() + 45000', 'Date.now() + 1200')
    const child = spawn(process.execPath, ['-e', quick], { stdio: 'ignore' })
    cleanups.push(() => { child.kill() })

    const wrote = await until(() => existsSync(errLog) && readFileSync(errLog, 'utf8').includes('never came up on port'), 15_000)
    expect(wrote, 'a replacement that died left no trace anywhere').toBe(true)
  }, 30_000)

  /**
   * A replacement whose only job is to take the port and then stop answering,
   * like a boot whose activation audit refuses the tree after the web server
   * has already bound. `dieAfterMs = 0` keeps it up instead.
   */
  function writeReplacement(dir: string): string {
    const script = join(dir, 'replacement.cjs')
    writeFileSync(script, [
      "const net = require('node:net')",
      'const server = net.createServer(socket => socket.end())',
      // A cold start binds late; the delay is a seam so the spec does not have
      // to sit through a real one (#854).
      "const delay = Number(process.env.DSHM_PROBE_DELAY_MS || 0)",
      "setTimeout(() => server.listen(Number(process.env.DSHM_PROBE_PORT), '127.0.0.1'), delay)",
      'const die = Number(process.env.DSHM_PROBE_DIE_MS || 0)',
      'if (die > 0) setTimeout(() => process.exit(1), delay + die)',
    ].join('\n'))
    return script
  }

  /** A stand-in recovery server: proves the handoff happened. */
  function writeRecoveryFixture(dir: string): { script: string; config: string; marker: string } {
    const config = join(dir, 'recovery.json')
    writeFileSync(config, '{}')
    const script = join(dir, 'fixture-recovery.cjs')
    writeFileSync(script, [
      "const fs = require('node:fs')",
      "fs.writeFileSync(process.argv[2] + '.ran', JSON.stringify(process.argv.slice(2)))",
    ].join('\n'))
    return { script, config, marker: config + '.ran' }
  }

  function runHelperWith(
    port: number,
    dir: string,
    dieAfterMs: number,
    settleMs: number,
    withRecovery: boolean,
    windows: { up?: number; hard?: number; listenDelayMs?: number } = {},
  ): string {
    const errLog = join(dir, 'err.log')
    const previousPort = process.env.DSHM_PROBE_PORT
    const previousDie = process.env.DSHM_PROBE_DIE_MS
    const previousDelay = process.env.DSHM_PROBE_DELAY_MS
    process.env.DSHM_PROBE_PORT = String(port)
    process.env.DSHM_PROBE_DIE_MS = String(dieAfterMs)
    process.env.DSHM_PROBE_DELAY_MS = String(windows.listenDelayMs ?? 0)
    cleanups.push(() => {
      if (previousPort === undefined) delete process.env.DSHM_PROBE_PORT
      else process.env.DSHM_PROBE_PORT = previousPort
      if (previousDie === undefined) delete process.env.DSHM_PROBE_DIE_MS
      else process.env.DSHM_PROBE_DIE_MS = previousDie
      if (previousDelay === undefined) delete process.env.DSHM_PROBE_DELAY_MS
      else process.env.DSHM_PROBE_DELAY_MS = previousDelay
    })
    const recovery = withRecovery ? writeRecoveryFixture(dir) : null
    const source = restartHelperSource(
      { file: process.execPath, args: [writeReplacement(dir)], viaShell: false, detached: false },
      { cwd: dir },
      { out: join(dir, 'out.log'), err: errLog },
      port,
      recovery === null ? null : { script: recovery.script, config: recovery.config },
    )
    // The settle window is the seam: shortening it keeps the spec fast without
    // changing the rule under test.
    const quick = source.replace('const SETTLE_MS = 8000', `const SETTLE_MS = ${String(settleMs)}`)
      .replace('Date.now() + 45000', `Date.now() + ${String(windows.up ?? 4000)}`)
      .replace('Date.now() + 240000', `Date.now() + ${String(windows.hard ?? 20000)}`)
    const child = spawn(process.execPath, ['-e', quick], { stdio: 'ignore' })
    cleanups.push(() => { child.kill() })
    return errLog
  }

  it('keeps the port for a replacement that is still starting past the window (#854)', async () => {
    // The report: after the market rewrote node_modules, a Windows cold start
    // took ~63s, the helper gave up at 53s and handed port 3080 to the
    // recovery surface, and the host — still booting the whole time — died on
    // EADDRINUSE when it finally reached its own bind. The window is a budget
    // for "has it come up", not a verdict on "is it dead": a replacement that
    // has NOT exited keeps the port.
    const { port, release } = await hold()
    await release()
    const dir = mkdtempSync(join(tmpdir(), 'dshm-restart-'))
    // Binds at 2500ms, i.e. well after the 800ms window, and never exits.
    const errLog = runHelperWith(port, dir, 0, 1000, false, { up: 800, hard: 8000, listenDelayMs: 2500 })
    // The helper creates this file when it spawns; reading before that is the
    // ordinary case here, not an error.
    const log = (): string => { try { return readFileSync(errLog, 'utf8') } catch { return '' } }

    expect(await until(() => log().includes('still starting'), 4000),
      'the helper never said it was waiting for a live replacement').toBe(true)
    expect(log(), 'a running replacement was written off as dead').not.toContain('never came up')

    // And it is recognized as up once it binds — the wait has to end in
    // success, not in a handoff that never happened.
    expect(await until(() => log().includes('replacement started'), 4000)).toBe(true)
    await wait(2500)
    expect(log()).not.toContain('never came up')
  }, 30_000)

  it('does not call a boot up just because the port answered once', async () => {
    // The failure this handoff exists for: an activation failure binds the
    // web port BEFORE the audit refuses the tree. Judging on a single answer
    // therefore reported success, and the recovery surface never started —
    // module-resolution failures were covered here, activation failures were
    // not. The port has to stay up for the settle window instead.
    const { port, release } = await hold()
    await release()
    const dir = mkdtempSync(join(tmpdir(), 'dshm-settle-'))
    // Holds the port for 700ms, then exits: shorter than the 1500ms settle.
    const errLog = runHelperWith(port, dir, 700, 1500, true)
    const wrote = await until(() => existsSync(errLog) && readFileSync(errLog, 'utf8').includes('never came up on port'), 20_000)
    expect(wrote, 'a replacement that bound the port and died was called up').toBe(true)
    const handed = await until(() => existsSync(join(dir, 'recovery.json.ran')), 10_000)
    expect(handed, 'the recovery surface was never started for a bind-then-die boot').toBe(true)
  }, 40_000)

  it('stays out of the way when the port really does stay up', async () => {
    const { port, release } = await hold()
    await release()
    const dir = mkdtempSync(join(tmpdir(), 'dshm-stays-'))
    const errLog = runHelperWith(port, dir, 0, 300, true)
    // Give it well past the settle window, then check nothing was handed off.
    await wait(3000)
    expect(existsSync(join(dir, 'recovery.json.ran')), 'a healthy boot started the recovery surface').toBe(false)
    expect(readFileSync(errLog, 'utf8')).not.toContain('never came up on port')
  }, 30_000)

  it('records a replacement that could not be started at all', async () => {
    // spawn reports a missing executable through an asynchronous `error`
    // event, which the try/catch around it never sees. Without a listener
    // this failure is precisely as silent as #177 itself.
    const dir = mkdtempSync(join(tmpdir(), 'dshm-restart-'))
    const errLog = join(dir, 'err.log')
    const source = restartHelperSource(
      { file: join(dir, 'no-such-dsh-binary'), args: [], viaShell: false, detached: false },
      { cwd: process.cwd() },
      { out: join(dir, 'out.log'), err: errLog },
      null,
    )
    const child = spawn(process.execPath, ['-e', source], { stdio: 'ignore' })
    cleanups.push(() => { child.kill() })

    const wrote = await until(() => existsSync(errLog) && readFileSync(errLog, 'utf8').includes('could not start'), 15_000)
    expect(wrote, 'a restart that never launched left no trace anywhere').toBe(true)
  }, 30_000)

  it('falls back to the old fixed delay when the port is unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-restart-'))
    const marker = join(dir, 'started.txt')
    runHelper(null, marker, { out: join(dir, 'out.log'), err: join(dir, 'err.log') })
    expect(await until(() => existsSync(marker), 8000)).toBe(true)
  }, 30_000)
})

describe('servingPort', () => {
  it('prefers the listening port over a proxied Host (#859)', () => {
    // The shape #859 measured: Host is the public name with the proxy's port,
    // the server listens on 3080. Handing 8443 to the restart helper made it
    // probe a port something else was already answering on.
    expect(servingPort({ headers: { host: 'dsh.example.com:8443' }, socket: { localPort: 3080 } })).toBe(3080)
    // A socket without a usable local port keeps the old Host reading.
    expect(servingPort({ headers: { host: 'dsh.example.com:8443' }, socket: {} })).toBe(8443)
    expect(servingPort({ headers: { host: '127.0.0.1:3080' }, socket: { localPort: 0 } })).toBe(3080)
  })

  it('reads the port the browser actually reached us on', () => {
    expect(servingPort({ headers: { host: '127.0.0.1:3080' } })).toBe(3080)
    expect(servingPort({ headers: { host: 'localhost:8080' } })).toBe(8080)
  })

  it('answers null rather than guessing', () => {
    // A default-port host carries none, and the helper's fallback delay is
    // the right behaviour there — inventing 80 would make it wait on a port
    // this process never held.
    expect(servingPort({ headers: { host: 'localhost' } })).toBeNull()
    expect(servingPort({ headers: {} })).toBeNull()
    expect(servingPort({ headers: { host: '127.0.0.1:99999' } })).toBeNull()
  })
})
