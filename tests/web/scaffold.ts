/**
 * Web e2e scaffold (harness convention): boot a REAL dsh web composition in
 * a throwaway DSH_HOME with the packed market installed, and hand the
 * caller a base url + console tripwire. Playwright is used as a library by
 * the specs; this file owns only the host side.
 *
 * The dsh CLI is resolved from DSHM_E2E_DSH (a full command line, e.g.
 * "node --import tsx/esm /path/to/deepseek-harness/apps/cli/src/bin.ts")
 * or a bare `dsh` on PATH. Without either, specs skip.
 */

import { execSync, spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { packFixture, startFixtureRegistry } from './registry.ts'
import type { FixtureRegistry } from './registry.ts'

// fileURLToPath, not .pathname: on Windows the pathname carries a leading
// slash (`/D:/a/repo`), and resolving that yields a directory that does not
// exist. Node then reports the failure as ENOENT on cmd.exe — the shell it
// never got to run — which is what made the first Windows e2e run look like
// a missing shell rather than a bad cwd.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Working directory for dsh invocations — source launches need their repo
 * root so `--import tsx/esm` resolves; a global dsh doesn't care. */
const DSH_CWD = process.env.DSHM_E2E_DSH_CWD ?? REPO_ROOT

/** The dsh launch command, or null when no dsh is reachable (specs skip). */
export function dshCommand(): string | null {
  const explicit = process.env.DSHM_E2E_DSH
  if (explicit !== undefined && explicit !== '') return explicit
  const probe = spawnSync('dsh', ['--version'], { shell: true, stdio: 'ignore', timeout: 30_000 })
  return probe.status === 0 ? 'dsh' : null
}

/**
 * Whether the e2e specs can run — and, where they are supposed to be
 * ENFORCING something, whether their absence is an error.
 *
 * Skipping is right on a contributor's machine that has no dsh. It is a trap
 * in CI: this lane installs the CLI itself, so if that step ever breaks (a
 * pinned prerelease unpublished, a registry hiccup) every spec would skip and
 * the job would still go green — reporting "e2e passed" for a run that
 * asserted nothing. CI sets DSHM_E2E_REQUIRED=1 to make that loud.
 */
export function dshAvailable(): boolean {
  if (dshCommand() !== null) return true
  if (process.env.DSHM_E2E_REQUIRED === '1') {
    throw new Error(
      'DSHM_E2E_REQUIRED=1 but no dsh CLI is reachable — the e2e lane would have skipped every spec and passed green',
    )
  }
  return false
}

export interface WebScaffold {
  baseUrl: string
  home: string
  /** Stop dsh and boot it again on the same DSH_HOME, same port. */
  restart(): Promise<void>
  close(): Promise<void>
}

export interface ScaffoldOptions {
  /**
   * Fixture directories under `tests/web/fixtures` to publish to a local
   * npm registry and list in a curated catalog the market is pointed at.
   * With this set the specs can drive the REAL install route end to end.
   */
  fixtures?: string[]
}

function run(command: string, env: NodeJS.ProcessEnv, cwd: string = REPO_ROOT): void {
  execSync(command, { env, stdio: 'pipe', timeout: 300_000, cwd })
}

/**
 * Pack the working tree and boot `dsh --profile web` on a free port inside
 * a temp DSH_HOME with the market installed from the tarball.
 */
export async function launchMarketScaffold(options: ScaffoldOptions = {}): Promise<WebScaffold> {
  const command = dshCommand()
  if (command === null) throw new Error('no dsh available — set DSHM_E2E_DSH')
  const home = mkdtempSync(join(tmpdir(), 'dshm-e2e-home-'))
  let env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home, CI: 'true' }

  // prepack builds lib/ + client and runs the preflight guard. The market's
  // own install resolves from the real npm registry — it has dependencies.
  run('npm pack --pack-destination ' + JSON.stringify(home), env)
  const tarball = join(home, readdirSync(home).find(name => name.endsWith('.tgz'))!)
  run(`${command} plugin --profile web add ${JSON.stringify(tarball)}`, env, DSH_CWD)

  // Only now redirect pnpm at the fixture registry, so the fixtures the
  // specs install go through real resolution without touching the network.
  let registry: FixtureRegistry | null = null
  if (options.fixtures !== undefined && options.fixtures.length > 0) {
    registry = await startFixtureRegistry(options.fixtures.map(dir => packFixture(dir, home)))
    writeFileSync(
      join(home, 'profiles', 'web', '.npmrc'),
      // minimum-release-age=0: a fixture "published" seconds ago would
      // otherwise trip pnpm 11's fresh-release hold (#39).
      `registry=${registry.npmUrl}\nminimum-release-age=0\n`,
    )
    // npm_config_registry OUTRANKS .npmrc, and `npm run test:web` puts the
    // caller's registry there — so the file alone silently sends pnpm to the
    // public registry, where a fixture does not exist. Set both.
    env = { ...env, DSHM_REGISTRY_URL: registry.catalogUrl, npm_config_registry: registry.npmUrl }
  }

  const port = 3200 + Math.floor(Math.random() * 500)
  const baseUrl = `http://127.0.0.1:${String(port)}`

  /** Spawn dsh and wait until the market answers, or explain why it never did.
   * `--no-open` (dsh >= 0.1.0-rc.8) is required here: without it, boot tries
   * to launch a system browser, which on a headless CI runner (confirmed on
   * Windows) left orphaned browser processes and the status endpoint never
   * answering — surfacing as a "dsh boot timeout" with nothing actually
   * wrong in this repo. */
  const boot = async (): Promise<ChildProcess> => {
    const process_ = spawn(`${command} --profile web --port ${String(port)} --no-open`, {
      shell: true,
      cwd: DSH_CWD,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX only: this exists so the negative-pid kill above can address
      // the whole process group. On Windows it maps to DETACHED_PROCESS —
      // no console at all, which is the very thing #40 had to undo — and
      // buys nothing, since taskkill /T walks the tree by pid.
      detached: process.platform !== 'win32',
    })
    let output = ''
    const capture = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-8192) }
    process_.stdout?.on('data', capture)
    process_.stderr?.on('data', capture)
    const deadline = Date.now() + 120_000
    for (;;) {
      if (process_.exitCode !== null) throw new Error(`dsh exited ${String(process_.exitCode)}:\n${output.slice(-2000)}`)
      try {
        const res = await fetch(`${baseUrl}/dsh-market/status`, { signal: AbortSignal.timeout(2000) })
        if (res.ok) break
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`dsh boot timeout:\n${output.slice(-2000)}`)
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1000))
    }
    return process_
  }

  /**
   * Stop dsh and everything it spawned.
   *
   * `process.kill(-pid)` addresses a process GROUP, which Windows does not
   * have — it throws there, and the fallback kills only the shell wrapper,
   * leaving the real dsh process alive and holding the port. In CI that is
   * a hung job, not a failed one. taskkill /T walks the tree instead.
   */
  const stop = async (process_: ChildProcess): Promise<void> => {
    const pid = process_.pid
    if (pid === undefined) return
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
      return
    }
    try { process.kill(-pid, 'SIGTERM') } catch { process_.kill('SIGTERM') }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1500))
    try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
  }

  let child = await boot()

  return {
    baseUrl,
    home,
    /**
     * Stop dsh and start it again on the same DSH_HOME. This is the only way
     * to observe what the market's file-level work actually did: the profile
     * is recomposed from disk, so a patch layer that hot-mount never touched
     * takes effect, and a profile the install logic bricked fails to come up
     * at all (the real consequence #122 guards against).
     */
    restart: async () => {
      await stop(child)
      child = await boot()
    },
    close: async () => {
      await registry?.close()
      await stop(child)
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/** Fail the spec on any console error — the harness console-tripwire pattern. */
export function watchConsole(page: Page): { errors(): string[] } {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => { errors.push(String(error)) })
  return { errors: () => [...errors] }
}
