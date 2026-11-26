/**
 * Land a different build of the market on disk while a host runs it, the way
 * a self-update does: a tarball of the packed working tree, rewritten to a
 * newer version, added with `dsh plugin add`. Shared by the self-reload specs.
 */

import { exec, execSync, spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { compareVersions } from '../../src/updates.ts'
import { dshCommand } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

const execAsync = promisify(exec)

/** Read the CLI version independently of the market operation under test. */
export function dshHostVersion(): string | null {
  const command = dshCommand()
  if (command === null) return null
  const probe = spawnSync(command, ['--version'], {
    shell: true, encoding: 'utf8', timeout: 30_000, cwd: process.env.DSHM_E2E_DSH_CWD,
  })
  const version = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/.exec(`${probe.stdout ?? ''}\n${probe.stderr ?? ''}`)?.[0]
  if (probe.status !== 0 || version === undefined) throw new Error('could not read the DSH host version')
  return version
}

/** First published DSH HMR with both runExclusive and reconcileProfile. */
export function hostCanSwap(): boolean {
  const version = dshHostVersion()
  if (version === null) return false
  const comparison = compareVersions(version, '0.2.1-alpha.3')
  if (comparison === null) throw new Error(`unrecognised DSH version: ${version}`)
  return comparison >= 0
}

export interface BuildOptions {
  /** A route only this build has. */
  newRoute?: string
  /** The build throws the moment it is loaded. */
  breakImport?: boolean
  /** The build loads fine and throws when started. */
  breakApply?: boolean
  /**
   * Give every file whose content did not change the identity it had (same
   * inode and time), the way pnpm's hard links from its store do on Linux.
   * The host replaces a module only when its file's identity changed, so this
   * is the difference between "every module is replaced" (a copying or
   * cloning pnpm, as on macOS) and "only the changed ones are" — the case
   * where state kept by an UNCHANGED module has to be right.
   */
  keepIdentity?: boolean
}

const baseTarballs = new Map<string, string>()

/** The tarball the scaffold installed from: the first one it packed, kept. */
function baseTarball(scaffold: WebScaffold): string {
  let known = baseTarballs.get(scaffold.home)
  if (known === undefined) {
    known = join(scaffold.home, readdirSync(scaffold.home).find(n => /^dshmarket-.*\.tgz$/.test(n))!)
    baseTarballs.set(scaffold.home, known)
  }
  return known
}

export function baseVersion(scaffold: WebScaffold): string {
  return (JSON.parse(execSync(`tar xzOf ${JSON.stringify(baseTarball(scaffold))} package/package.json`, { encoding: 'utf8' })) as { version: string }).version
}

/**
 * @param n - 1 for the first build landed on this scaffold, then 2, 3 ...;
 * it becomes the patch version above the base build.
 * @returns the version that landed.
 */
export async function landBuild(scaffold: WebScaffold, n: number, options: BuildOptions = {}): Promise<string> {
  const base = baseVersion(scaffold)
  const [major, minor, patch] = base.split('.').map(Number)
  const version = `${String(major)}.${String(minor)}.${String(patch! + n)}`
  const work = join(scaffold.home, `build-${String(n)}`)
  mkdirSync(work)
  execSync(`tar xzf ${JSON.stringify(baseTarball(scaffold))} -C ${JSON.stringify(work)}`)
  const manifestPath = join(work, 'package', 'package.json')
  writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace(/"version": "[^"]+"/, `"version": "${version}"`))
  // The page compares the version baked into its own bundle with the server's.
  const clientPath = join(work, 'package', 'client', 'client.js')
  if (existsSync(clientPath)) {
    writeFileSync(clientPath, readFileSync(clientPath, 'utf8').split(`"${base}"`).join(`"${version}"`))
  }
  const entry = join(work, 'package', 'lib', 'index.js')
  let source = readFileSync(entry, 'utf8')
  if (options.newRoute !== undefined) {
    source = source.replace('export function apply(', 'function applyBase(')
      + `
export function apply(ctx, config) {
  applyBase(ctx, config)
  ctx.inject(['webServer'], (host) => {
    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: ${JSON.stringify(options.newRoute)},
      handler: (request, response) => { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('new-build ${version}') },
    }), 'e2e: route that only the new build has')
  })
}
`
  }
  if (options.breakApply === true) {
    source = source.replace('export function apply(', 'function applyBase(')
      + "\nexport function apply() { throw new Error('e2e: this build cannot start') }\n"
  }
  if (options.breakImport === true) source += "\nthrow new Error('e2e: this build cannot be loaded')\n"
  writeFileSync(entry, source)
  const tarball = join(scaffold.home, `dshmarket-${version}.tgz`)
  execSync(`tar czf ${JSON.stringify(tarball)} -C ${JSON.stringify(work)} package`)
  const installedLib = join(scaffold.home, 'profiles', 'web', 'node_modules', 'dshmarket', 'lib')
  const kept = join(scaffold.home, `identity-${String(n)}`)
  if (options.keepIdentity === true) {
    mkdirSync(kept)
    for (const name of readdirSync(installedLib).filter(file => file.endsWith('.js'))) linkSync(join(installedLib, name), join(kept, name))
  }
  // The install may request packages from the fixture registry in this
  // process. Keep the event loop free to serve those requests.
  await execAsync(`${dshCommand()} plugin --profile web add ${JSON.stringify(tarball)}`, {
    env: { ...process.env, DSH_HOME: scaffold.home, CI: 'true' },
    cwd: process.env.DSHM_E2E_DSH_CWD ?? process.cwd(),
    timeout: 300_000,
  })
  if (options.keepIdentity === true) {
    for (const name of readdirSync(kept)) {
      const now = join(installedLib, name)
      if (!existsSync(now) || !readFileSync(now).equals(readFileSync(join(kept, name)))) continue
      rmSync(now)
      linkSync(join(kept, name), now)
    }
  }
  return version
}
