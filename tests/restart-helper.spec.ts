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
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
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
    const quick = source.replace('Date.now() + 20000', 'Date.now() + 1200')
    const child = spawn(process.execPath, ['-e', quick], { stdio: 'ignore' })
    cleanups.push(() => { child.kill() })

    const wrote = await until(() => existsSync(errLog) && readFileSync(errLog, 'utf8').includes('did not bind'), 15_000)
    expect(wrote, 'a replacement that died left no trace anywhere').toBe(true)
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
