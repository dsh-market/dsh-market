/**
 * The market replaces its OWN server half in the running process.
 *
 * The problem this covers: the market updates itself by replacing its files,
 * and the Node module already imported keeps running. The page then loads the
 * NEW client, which calls routes only the new server has. `POST
 * /dsh-market/reload-self` swaps the new server half in through the host's own
 * module replacement (`hmr.reconcileProfile`), with no DSH restart.
 *
 * Only a real host can answer the questions that matter here — whether the
 * process really kept running, whether the other plugins really stayed up, and
 * what the host does when the new build is broken — so every claim below is
 * measured against one, not inferred from the market's own report.
 *
 * "Updating the market" is simulated the way it lands on disk: a tarball of
 * the working-tree build, rewritten to a newer version, is added with `dsh
 * plugin add` while the host runs. A tarball is also how a route that exists
 * only in the NEW build is introduced: the old instance has never heard of it.
 */

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { dshAvailable, dshCommand, launchMarketScaffold } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

const HAS_DSH = dshAvailable()
const A = 'dshm-e2e-fixture-a'
const CLIENT = 'dshm-e2e-fixture-client'
/** The same package with no host half declared: only the market's own shim can serve it. */
const CLIENT_ONLY = 'dshm-e2e-fixture-shim'

/**
 * Whether this host line can replace modules in place: `reconcileProfile` on
 * the HMR service arrived in 0.2.1-rc.1 (0.2.1-alpha.x and everything before
 * has only the configuration half, measured on the published packages). The
 * market decides by looking at the service, not at a version — this only
 * tells the spec what to expect.
 */
function hostCanSwap(): boolean {
  const command = dshCommand()
  if (command === null) return false
  const probe = spawnSync(command, ['--version'], {
    shell: true, encoding: 'utf8', timeout: 30_000, cwd: process.env.DSHM_E2E_DSH_CWD,
  })
  const found = /(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?/.exec(`${probe.stdout ?? ''}${probe.stderr ?? ''}`)
  if (found === null) return false
  const [major, minor, patch] = [Number(found[1]), Number(found[2]), Number(found[3])]
  if (major > 0 || minor > 2 || (minor === 2 && patch > 1)) return true
  if (minor !== 2 || patch !== 1) return false
  return found[4] === undefined || (found[4] === 'rc' && Number(found[5]) >= 1)
}
const HOST_CAN_SWAP = HAS_DSH && hostCanSwap()

describe.skipIf(!HAS_DSH || HOST_CAN_SWAP).sequential('web e2e: a host that cannot replace modules says so', () => {
  let scaffold: WebScaffold

  beforeAll(async () => { scaffold = await launchMarketScaffold() }, 600_000)
  afterAll(async () => { await scaffold?.close() })

  it('reports selfReload false and answers the reload request with 501', async () => {
    const status = await (await scaffold.api('/dsh-market/status')).json() as { selfReload?: boolean }
    expect(status.selfReload).toBe(false)
    const res = await scaffold.api('/dsh-market/reload-self', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: scaffold.baseUrl },
      body: '{}',
    })
    expect(res.status).toBe(501)
    expect(await res.json()).toMatchObject({ ok: false, state: 'unsupported' })
  }, 120_000)
})

describe.skipIf(!HOST_CAN_SWAP).sequential('web e2e: the market reloads its own server half', () => {
  let scaffold: WebScaffold
  let base: string
  let counter = 0

  beforeAll(async () => {
    scaffold = await launchMarketScaffold({
      fixtures: [
        'fixture-a',
        'fixture-client',
        'fixture-clientonly',
      ],
    })
    base = scaffold.baseUrl
  }, 600_000)

  afterAll(async () => { await scaffold?.close() })

  const post = (path: string, body: unknown = {}): Promise<Response> =>
    scaffold.api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify(body),
    })
  const get = async (path: string): Promise<any> => (await scaffold.api(path)).json()
  const status = (): Promise<{ version: string; boot: string; selfReload: boolean }> => get('/dsh-market/status')

  /** The OS process id the market runs in; the boot id is `<pid>-<time>`. */
  const pidOf = (boot: string): string => boot.split('-')[0]!

  const profileDir = (): string => join(scaffold.home, 'profiles', 'web')
  const marker = (): string => join(scaffold.home, `e2e-${A}.alive`)
  const baseTarball = (): string => join(scaffold.home, readdirSync(scaffold.home).find(n => /^dshmarket-.*\.tgz$/.test(n))!)
  const baseVersion = (): string =>
    (JSON.parse(execSync(`tar xzOf ${JSON.stringify(baseTarball())} package/package.json`, { encoding: 'utf8' })) as { version: string }).version

  /**
   * Land a different build of the market on disk, the way an update does:
   * `dsh plugin add` of a tarball, while the host is running.
   *
   * `newRoute` appears only in this build; `breakImport` makes the build throw
   * the moment it is loaded; `breakApply` loads fine and throws when started.
   *
   * `keepIdentity` gives every file whose content did not change the identity
   * it had (same inode and time), the way pnpm's hard links from its store do
   * on Linux. The host replaces a module only when its file's identity
   * changed, so this is the difference between "every module is replaced"
   * (what a copying or cloning pnpm, as on macOS, gives) and "only the changed
   * ones are" — the case where state kept by an UNCHANGED module has to be
   * right, because that module survives the swap.
   */
  const landBuild = (options: { newRoute?: string; breakImport?: boolean; breakApply?: boolean; keepIdentity?: boolean } = {}): string => {
    counter += 1
    const [major, minor, patch] = baseVersion().split('.').map(Number)
    const version = `${String(major)}.${String(minor)}.${String(patch! + counter)}`
    const work = join(scaffold.home, `build-${String(counter)}`)
    mkdirSync(work)
    execSync(`tar xzf ${JSON.stringify(baseTarball())} -C ${JSON.stringify(work)}`)
    const manifestPath = join(work, 'package', 'package.json')
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace(/"version": "[^"]+"/, `"version": "${version}"`))
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
    const installedLib = join(profileDir(), 'node_modules', 'dshmarket', 'lib')
    const kept = join(scaffold.home, `identity-${String(counter)}`)
    if (options.keepIdentity === true) {
      mkdirSync(kept)
      for (const name of readdirSync(installedLib).filter(file => file.endsWith('.js'))) linkSync(join(installedLib, name), join(kept, name))
    }
    execSync(`${dshCommand()} plugin --profile web add ${JSON.stringify(tarball)}`, {
      env: { ...process.env, DSH_HOME: scaffold.home, CI: 'true' },
      cwd: process.env.DSHM_E2E_DSH_CWD ?? process.cwd(),
      stdio: 'pipe',
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

  const routeAnswers = async (path: string): Promise<string | null> => {
    const res = await scaffold.api(path)
    return res.status === 200 ? await res.text() : null
  }

  let bootBefore = ''
  let markerBefore = 0

  it('serves the old build, and says it can reload itself', async () => {
    const s = await status()
    expect(s.selfReload).toBe(true)
    bootBefore = s.boot
    const installed = await post('/dsh-market/install', { url: `https://github.com/dshm-e2e/${A}` })
    expect(installed.status).toBe(200)
    const client = await post('/dsh-market/install', { url: `https://github.com/dshm-e2e/${CLIENT}` })
    expect(client.status).toBe(200)
    expect(existsSync(marker())).toBe(true)
    markerBefore = statSync(marker()).mtimeMs
  }, 300_000)

  it('is stuck on the old server half after a self-update, until it reloads', async () => {
    const before = (await status()).version
    const version = landBuild({ newRoute: '/dsh-market/e2e-new-only' })
    // The files are new. The process is not: the new route does not exist and
    // /status still names the old build — the page-versus-server mismatch.
    expect(await routeAnswers('/dsh-market/e2e-new-only')).toBeNull()
    expect((await status()).version).toBe(before)
    expect(JSON.parse(readFileSync(join(profileDir(), 'node_modules', 'dshmarket', 'package.json'), 'utf8')).version).toBe(version)
  }, 300_000)

  it('reload-self swaps the new server half in, in the same process', async () => {
    const res = await post('/dsh-market/reload-self')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; state: string; to: string }
    expect(body).toMatchObject({ ok: true, state: 'reloaded' })

    const after = await status()
    expect(after.version).toBe(body.to)
    expect(await routeAnswers('/dsh-market/e2e-new-only')).toBe(`new-build ${body.to}`)
    // No restart: the same operating-system process answered both.
    expect(pidOf(after.boot)).toBe(pidOf(bootBefore))
    expect(after.selfReload).toBe(true)
  }, 120_000)

  it('leaves the other plugins running, untouched', async () => {
    expect(existsSync(marker()), 'the plugin was stopped by the swap').toBe(true)
    // The marker is written when the plugin starts: a restart would move it.
    expect(statSync(marker()).mtimeMs).toBe(markerBefore)
    const state = await get('/dsh-market/installed')
    expect(state.activation[A]?.state).toBe('live')
    const log = readFileSync(join(scaffold.home, 'client-fixture.log'), 'utf8').trim().split('\n')
    expect(log, 'the client plugin was started or stopped again').toEqual(['apply'])
  }, 60_000)

  it('answers a second reload of the same files as already current', async () => {
    const res = await post('/dsh-market/reload-self')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, state: 'current' })
  }, 60_000)

  it('swaps a second time, from the build the first swap brought in', async () => {
    const version = landBuild({ newRoute: '/dsh-market/e2e-newer-only' })
    const res = await post('/dsh-market/reload-self')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, state: 'reloaded', to: version })
    expect(await routeAnswers('/dsh-market/e2e-newer-only')).toBe(`new-build ${version}`)
    expect((await status()).version).toBe(version)
    expect(pidOf((await status()).boot)).toBe(pidOf(bootBefore))
    expect(statSync(marker()).mtimeMs).toBe(markerBefore)
  }, 300_000)

  let servingVersion = ''

  it('refuses a build that cannot load, and the running market keeps serving', async () => {
    servingVersion = (await status()).version
    const broken = landBuild({ newRoute: '/dsh-market/e2e-never-seen', breakImport: true })
    const res = await post('/dsh-market/reload-self')
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ ok: false, state: 'refused' })

    // The old instance never stopped: same version, same routes, same process.
    const after = await status()
    expect(after.version).toBe(servingVersion)
    expect(after.version).not.toBe(broken)
    expect(await routeAnswers('/dsh-market/e2e-newer-only')).toBe(`new-build ${servingVersion}`)
    expect(await routeAnswers('/dsh-market/e2e-never-seen')).toBeNull()
    expect(pidOf(after.boot)).toBe(pidOf(bootBefore))
    // And it did not leave its test copy behind in the package directory.
    expect(readdirSync(join(profileDir(), 'node_modules')).filter(n => n.startsWith('.dsh-market-reload'))).toEqual([])
  }, 300_000)

  it('recovers: a good build after the refused one swaps in normally', async () => {
    const version = landBuild({ newRoute: '/dsh-market/e2e-recovered' })
    const res = await post('/dsh-market/reload-self')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, state: 'reloaded', to: version })
    expect(await routeAnswers('/dsh-market/e2e-recovered')).toBe(`new-build ${version}`)
    expect(pidOf((await status()).boot)).toBe(pidOf(bootBefore))
  }, 300_000)

  it('says so when a build loads but cannot start, and a restart recovers', async () => {
    // The one failure a test-load cannot see: the host stops the old market
    // before it can learn that the new one will not start, and keeps no copy
    // of the old code. The answer must be the truth, not a success.
    landBuild({ breakApply: true })
    const res = await post('/dsh-market/reload-self')
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ ok: false, state: 'failed', serving: false })
    expect((await scaffold.api('/dsh-market/status')).status, 'no market instance should be serving').not.toBe(200)

    // The host is still up and the other plugins are untouched.
    expect(existsSync(marker())).toBe(true)
    expect(statSync(marker()).mtimeMs).toBe(markerBefore)

    // A good build on disk and a restart: the market is back.
    const version = landBuild({ newRoute: '/dsh-market/e2e-after-restart' })
    await scaffold.restart()
    expect((await status()).version).toBe(version)
    expect(await routeAnswers('/dsh-market/e2e-after-restart')).toBe(`new-build ${version}`)
  }, 600_000)

  it('keeps a client-only plugin served: the market\'s own shim for it is rebuilt by the new instance', async () => {
    // Client-only packages (a browser half, no host half) have no loader entry
    // of their own; the market mounts a stand-in under its OWN instance so the
    // host will serve their bundle. That stand-in dies with the instance, and
    // the state that says "already mounted" must die with it — otherwise the
    // new instance trusts a mount that no longer exists and the plugin quietly
    // disappears from the page.
    const pageLoads = async (): Promise<boolean> => (await (await scaffold.api('/')).text()).includes(CLIENT_ONLY)
    const installed = await post('/dsh-market/install', { url: `https://github.com/dshm-e2e/${CLIENT_ONLY}` })
    expect(installed.status).toBe(200)
    await vi.waitFor(async () => { expect(await pageLoads()).toBe(true) }, { timeout: 30_000, interval: 500 })
    const bootAtStart = (await status()).boot

    const version = landBuild({ newRoute: '/dsh-market/e2e-client-only', keepIdentity: true })
    const res = await post('/dsh-market/reload-self')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, state: 'reloaded', to: version })
    expect(pidOf((await status()).boot)).toBe(pidOf(bootAtStart))

    await vi.waitFor(async () => { expect(await pageLoads(), 'the page stopped serving the plugin').toBe(true) }, { timeout: 20_000, interval: 500 })
  }, 600_000)

  it('keeps a plugin that the market itself mounted live (a mount that dies with the market\'s own instance)', async () => {
    // The market's own mounts hang off the market's instance, so they are torn
    // down with it. This is the state that has to be handed over: after the
    // swap the plugin must be up again, exactly once, with the page still
    // listing its browser half. Reached the way a user reaches it — off,
    // restart (the off survives), then on: that path has no host entry to flip,
    // so the market mounts it itself (client-graph.e2e.ts, #1188).
    const settle = async (): Promise<void> => {
      for (let attempt = 0; attempt < 90; attempt++) {
        const s = (await get('/dsh-market/status')) as { busy?: boolean; active?: boolean }
        if (s.busy !== true && s.active !== true) return
        await new Promise(done => setTimeout(done, 1000))
      }
      throw new Error('operation never settled')
    }
    const pageLoadsIt = async (): Promise<boolean> => (await (await scaffold.api('/')).text()).includes(CLIENT)
    const history = (): string[] => readFileSync(join(scaffold.home, 'client-fixture.log'), 'utf8').split('\n').filter(Boolean)

    expect((await post('/dsh-market/toggle', { name: CLIENT, enabled: false })).status).toBe(200)
    await settle()
    await scaffold.restart()
    expect((await post('/dsh-market/toggle', { name: CLIENT, enabled: true })).status).toBe(200)
    await settle()
    expect(await pageLoadsIt()).toBe(true)
    expect(history().at(-1)).toBe('apply')
    const liveBefore = ((await get('/dsh-market/installed')) as { live?: string[] }).live ?? []
    expect(liveBefore, 'the market must hold this one as a live mount of its own').toContain(CLIENT)
    const bootAtStart = (await status()).boot

    const version = landBuild({ newRoute: '/dsh-market/e2e-live-mount', keepIdentity: true })
    const res = await post('/dsh-market/reload-self')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, state: 'reloaded', to: version })
    expect(pidOf((await status()).boot)).toBe(pidOf(bootAtStart))

    // Up again, and listed again — however the new instance got it there.
    await vi.waitFor(async () => { expect(await pageLoadsIt()).toBe(true) }, { timeout: 15_000, interval: 500 })
    await settle()
    expect(history().at(-1), 'the plugin is down after the swap').toBe('apply')
    // Exactly once: a second copy would be the duplicate mount #1137 describes.
    const applies = history().filter(line => line === 'apply').length
    const disposes = history().filter(line => line === 'dispose').length
    expect(applies - disposes, 'more than one copy of the plugin is running').toBe(1)
    const after = (await get('/dsh-market/installed')) as { live?: string[]; activation?: Record<string, { state?: string }> }
    expect(after.activation?.[CLIENT]?.state).toBe('live')

    // And the new instance still controls it: turning it off must stop it. A
    // market that remembers a mount its replaced instance tore down would
    // "unmount" a handle that is already gone and leave the plugin running.
    expect((await post('/dsh-market/toggle', { name: CLIENT, enabled: false })).status).toBe(200)
    await settle()
    expect(history().at(-1), 'the new instance could not switch the plugin off').toBe('dispose')
    expect(await pageLoadsIt()).toBe(false)
  }, 600_000)

  it('refuses a cross-origin request', async () => {
    const res = await scaffold.api('/dsh-market/reload-self', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: '{}',
    })
    expect(res.status).toBe(403)
  }, 60_000)

  it('answers a GET with 405, like every other action', async () => {
    expect((await scaffold.api('/dsh-market/reload-self')).status).toBe(405)
  }, 60_000)

  it('also swaps under the Desktop wiring, and stays off the restart path', async () => {
    // The Desktop shell's services as a non-operational fixture (the same one
    // desktop-settings.e2e.ts uses): the market takes its Desktop branch, which
    // never offers a restart. This does NOT prove the real Electron app — see
    // the note in the report — only that nothing in the market's Desktop branch
    // stands in the way of the swap.
    const dir = profileDir()
    writeFileSync(join(dir, 'desktop-reload-fixture.mjs'), `
export function apply(ctx) {
  ctx.provide('desktopProfiles', { current: { name: 'desktop-test', dir: ${JSON.stringify(dir)} } })
  ctx.provide('desktopPnpm', { runPlugin() { throw new Error('package operations forbidden in this test') } })
}
`)
    writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify([
      { insert: [{ id: 'desktop-services-test', name: './desktop-reload-fixture.mjs' }] },
      { id: 'dsh-market', inject: ['desktopProfiles', 'desktopPnpm'] },
    ]))
    await scaffold.restart()
    const before = await status()
    expect(before.selfReload).toBe(true)
    const capabilities = await get('/dsh-market/api/v1/capabilities')
    expect(capabilities).toMatchObject({ runtime: 'desktop', restart: { supported: false, managedBy: 'desktop-host' } })
    const bootBeforeSwap = before.boot

    const version = landBuild({ newRoute: '/dsh-market/e2e-desktop-new' })
    const res = await post('/dsh-market/reload-self')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, state: 'reloaded', to: version })
    expect(await routeAnswers('/dsh-market/e2e-desktop-new')).toBe(`new-build ${version}`)
    const after = await status()
    expect(after.version).toBe(version)
    expect(pidOf(after.boot)).toBe(pidOf(bootBeforeSwap))
    expect(await get('/dsh-market/api/v1/capabilities')).toMatchObject({ runtime: 'desktop', restart: { supported: false } })
  }, 600_000)
})
