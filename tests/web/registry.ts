/**
 * A real npm registry, served from disk, plus the market's curated catalog.
 *
 * Why this exists: the install route only accepts sources present in the
 * curated registry (a deliberate control — see routes.ts), and
 * `installTargetFor` maps an entry to an npm name or a `github:` spec. So a
 * fixture cannot be driven through the real install path as a local tarball;
 * it has to be a package pnpm can genuinely RESOLVE. Serving a packument and
 * tarball over localhost makes it exactly that — the market, pnpm and cordis
 * all take the ordinary code path, and nothing has to be published.
 *
 * Unknown packages redirect upstream so pnpm can still replay the rest of
 * the dependency tree (the market's own deps) when it verifies the lockfile.
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Registry, RegistryPlugin } from '../../src/registry.ts'

// fileURLToPath, not .pathname — see the note in scaffold.ts: a Windows
// pathname keeps its leading slash and resolves to a nonexistent directory.
const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures', import.meta.url))
const UPSTREAM = 'https://registry.npmjs.org'

export interface ServedPackage {
  name: string
  tarball: string
  manifest: Record<string, unknown>
}

/**
 * Pack a fixture directory into `destination` and describe it for the
 * registry. Uses `npm pack` so the tarball layout is the real thing.
 */
export function packFixture(dir: string, destination: string, version?: string): ServedPackage {
  // A second version of the same fixture is packed from a COPY with its
  // version rewritten, so one fixture directory can play both sides of an
  // update. Copying rather than editing in place keeps the checked-in
  // fixture at its own version, which several specs install by name.
  const source = version === undefined
    ? join(FIXTURE_ROOT, dir)
    : versionedCopy(dir, destination, version)
  // execSync, not execFileSync: on Windows `npm` is npm.cmd, a batch shim
  // that cannot be spawned without a shell — the same trap the market's own
  // tool spawning handles (#2/#3/#5/#80). Node reports it as ENOENT on
  // `npm`, which reads like a missing install rather than a missing shell.
  execSync(`npm pack --pack-destination ${JSON.stringify(destination)}`, { cwd: source, stdio: 'pipe' })
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as Record<string, unknown>
  const prefix = `${String(manifest.name)}-${String(manifest.version)}`
  const file = readdirSync(destination).find(entry => entry.startsWith(prefix) && entry.endsWith('.tgz'))
  if (file === undefined) throw new Error(`npm pack produced no tarball for ${dir}`)
  return { name: String(manifest.name), tarball: join(destination, file), manifest }
}

/** The same fixture directory at a different version, in a temp copy. */
function versionedCopy(dir: string, destination: string, version: string): string {
  const target = join(destination, `${dir}@${version}`)
  cpSync(join(FIXTURE_ROOT, dir), target, { recursive: true })
  const manifestPath = join(target, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`)
  return target
}

/** A catalog entry pointing at a served package, shaped like a real one. */
export function catalogEntry(pkg: ServedPackage): RegistryPlugin {
  return {
    name: pkg.name,
    owner: 'dshm-e2e',
    // Never fetched: `npm` takes precedence in installTargetFor. It only has
    // to parse as a source url so the entry passes the route's checks.
    url: `https://github.com/dshm-e2e/${pkg.name}`,
    npm: pkg.name,
    category: 'testing',
    description: { en: `e2e fixture ${pkg.name}`, zh: `e2e 夹具 ${pkg.name}` },
    install: pkg.name,
    added: '2026-01-01',
  }
}

export interface FixtureRegistry {
  /** Value for the profile's `registry=` — pnpm resolves fixtures here. */
  npmUrl: string
  /** Value for DSHM_REGISTRY_URL — the market's curated catalog. */
  catalogUrl: string
  /**
   * Move a package's `latest` dist-tag, the way an author publishing a new
   * release does.
   *
   * A spec that wants to test UPDATING cannot simply serve two versions and
   * install the older one: installing by name resolves `latest`. Publishing
   * in two steps is also what actually happens to a user — they are running
   * the version that was current when they installed.
   */
  setLatest(name: string, version: string): void
  close(): Promise<void>
}

export async function startFixtureRegistry(packages: ServedPackage[]): Promise<FixtureRegistry> {
  // One catalog entry per NAME, not per served package: a fixture published
  // at two versions is still one plugin, and listing it twice would make the
  // market's own duplicate handling the thing under test.
  const names = [...new Set(packages.map(pkg => pkg.name))]
  const catalog: Registry = {
    updated: '2026-01-01',
    count: names.length,
    categories: { testing: { en: 'Testing', zh: '测试' } },
    plugins: names.map(name => catalogEntry(packages.find(pkg => pkg.name === name)!)),
  }

  const latestFor = new Map<string, string>()
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/plugins.json') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(catalog))
      return
    }
    const tarball = packages.find(pkg => url.pathname === `/${pkg.name}/-/${basename(pkg.tarball)}`)
    if (tarball !== undefined) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(readFileSync(tarball.tarball))
      return
    }
    // `/{name}/latest` and `/{name}/{version}` are the abbreviated manifest
    // endpoints, and the market's update check reads the first of them —
    // serving only the full packument sent every fixture update check
    // upstream to the public registry, where it 404s and the market
    // truthfully reports "no update" for a package that exists only here.
    const abbreviated = packages.filter(candidate => {
      const prefix = `/${candidate.name}/`
      return url.pathname.startsWith(prefix) && !url.pathname.startsWith(`${prefix}-/`)
    })
    if (abbreviated.length > 0) {
      const wanted = url.pathname.slice(`/${abbreviated[0]!.name}/`.length)
      const version = wanted === 'latest'
        ? latestFor.get(abbreviated[0]!.name) ?? String(abbreviated[abbreviated.length - 1]!.manifest.version)
        : wanted
      const pkg = abbreviated.find(candidate => String(candidate.manifest.version) === version)
      if (pkg === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'version not found' }))
        return
      }
      const bytes = readFileSync(pkg.tarball)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        ...pkg.manifest,
        dist: {
          tarball: `http://127.0.0.1:${String(addressPort(server))}/${pkg.name}/-/${basename(pkg.tarball)}`,
          shasum: createHash('sha1').update(bytes).digest('hex'),
          integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        },
      }))
      return
    }
    const served = packages.filter(
      candidate => url.pathname === `/${candidate.name}` || url.pathname === `/${encodeURIComponent(candidate.name)}`,
    )
    if (served.length === 0) {
      response.writeHead(302, { location: `${UPSTREAM}${url.pathname}` })
      response.end()
      return
    }
    const port = addressPort(server)
    const versions: Record<string, unknown> = {}
    for (const pkg of served) {
      const bytes = readFileSync(pkg.tarball)
      versions[String(pkg.manifest.version)] = {
        ...pkg.manifest,
        dist: {
          tarball: `http://127.0.0.1:${String(port)}/${pkg.name}/-/${basename(pkg.tarball)}`,
          shasum: createHash('sha1').update(bytes).digest('hex'),
          integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        },
      }
    }
    // The LAST one listed is `latest` until a spec moves the tag, so the
    // order fixtures are passed in spells the starting point rather than a
    // version-compare rule this file would have to keep true.
    const latest = latestFor.get(served[0]!.name) ?? String(served[served.length - 1]!.manifest.version)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      name: served[0]!.name,
      'dist-tags': { latest },
      // Real packuments carry publish times, and the market reads them
      // (#45) before offering an update. Dated in the past so a fixture
      // "published" this second is not held back as too young.
      time: Object.fromEntries(Object.keys(versions).map(v => [v, '2026-01-01T00:00:00.000Z'])),
      versions,
    }))
  })

  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => { done() }))
  const base = `http://127.0.0.1:${String(addressPort(server))}`
  return {
    npmUrl: `${base}/`,
    catalogUrl: `${base}/plugins.json`,
    setLatest: (name: string, version: string): void => { latestFor.set(name, version) },
    close: () => new Promise<void>(done => { server.close(() => { done() }) }),
  }
}

function addressPort(server: Server): number {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('registry server has no port')
  return address.port
}
