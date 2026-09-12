/** #575: an import failure must not become an enabled plugin on the next boot. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dshAvailable, launchMarketScaffold, type WebScaffold } from './scaffold.ts'

const BAD = 'dshm-e2e-failed-enable'
const GOOD = 'dshm-e2e-deferred-enable'
describe.skipIf(!dshAvailable()).sequential('web e2e: failed enable survives restart (#575)', () => {
  let scaffold: WebScaffold
  let dir: string
  let catalogServer: Server
  let themeMode = false
  const request = (path: string, body?: unknown) => fetch(`${scaffold.baseUrl}/dsh-market/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: scaffold.baseUrl, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  beforeAll(async () => {
    catalogServer = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ updated: '2026-09-12', count: 2, categories: {}, plugins: [BAD, GOOD].map(name => ({
        name, owner: 'dshm-e2e', url: `https://github.com/dshm-e2e/${name}`, category: themeMode ? 'theme' : 'testing',
        description: { en: name }, install: name, added: '2026-09-12',
      })) }))
    })
    await new Promise<void>(resolve => catalogServer.listen(0, '127.0.0.1', resolve))
    const address = catalogServer.address()
    if (address === null || typeof address === 'string') throw new Error('catalog address unavailable')
    const previous = process.env.DSHM_REGISTRY_URL
    process.env.DSHM_REGISTRY_URL = `http://127.0.0.1:${address.port}/catalog`
    try { scaffold = await launchMarketScaffold() } finally {
      if (previous === undefined) delete process.env.DSHM_REGISTRY_URL
      else process.env.DSHM_REGISTRY_URL = previous
    }
    dir = join(scaffold.home, 'profiles/web')
    // Put the disables down BEFORE adding either package to the composition.
    // Every write and restart is confined to this scaffold's throwaway home.
    const userPatch = join(dir, 'cordis.patch.yml')
    writeFileSync(userPatch, readFileSync(userPatch, 'utf8').replace(/^\[\]\s*$/m, '') + `\n- id: ${BAD}\n  disabled: true\n- id: ${GOOD}\n  disabled: true\n`)
    for (const name of [BAD, GOOD]) {
      const pkg = join(dir, 'node_modules', name)
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
      writeFileSync(join(pkg, 'index.js'), name === BAD
        ? "import { missingExport575 } from './exports.js'; export function apply() { missingExport575() }\n"
        : "import { writeFileSync, rmSync } from 'node:fs'; import { join } from 'node:path'; export function apply(ctx) { ctx.effect(() => { const file = join(process.env.DSH_HOME, 'deferred-575.alive'); writeFileSync(file, 'live'); return () => rmSync(file, {force:true}) }) }\n")
      writeFileSync(join(pkg, 'exports.js'), 'export const available = true\n')
      // Absolute names let the host import the exact fixture. The good patch
      // carries config, so the market must defer it instead of hot-mounting.
      writeFileSync(join(pkg, 'cordis.patch.yml'), `- insert:\n    - id: ${name}\n      name: '${pathToFileURL(join(pkg, 'index.js')).href}'\n${name === GOOD ? `      config:\n        enabled: true\n- id: ${BAD}\n  disabled: true\n` : ''}`)
    }
    const manifestFile = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    for (const name of [BAD, GOOD]) manifest.dependencies[name] = '1.0.0'
    manifest.dsh.profile.bundles.push(BAD) // GOOD is a disabled carrier; enable must re-add its bundle
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
    writeFileSync(join(dir, '.dsh-market/state.json'), JSON.stringify({ disabled: [BAD, GOOD], groups: {}, groupOrder: [], region: 'global' }))
    await scaffold.restart()
  }, 600_000)
  afterAll(async () => {
    try { await scaffold?.close() } finally {
      if (catalogServer) await new Promise<void>((resolve, reject) => catalogServer.close(error => error ? reject(error) : resolve()))
    }
  })

  it('rejects a real missing-export import and preserves disk state across restart', async () => {
    const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    const state = readFileSync(join(dir, '.dsh-market/state.json'), 'utf8')
    const response = await request('toggle', { name: BAD, enabled: true })
    const result = await response.json() as { ok: boolean; restart: boolean; reason?: string }
    expect(response.status, JSON.stringify(result)).toBe(502)
    expect(result.ok).toBe(false)
    expect(result.restart).toBe(false)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    expect(readFileSync(join(dir, '.dsh-market/state.json'), 'utf8')).toBe(state)
    await scaffold.restart()
    expect((await request('status')).status).toBe(200)
    const installed = await (await request('installed')).json() as { activation: Record<string, { state: string }> }
    expect(installed.activation[BAD].state).toBe('disabled')
  })

  it('still commits a normal deferred enable that really activates after restart', async () => {
    expect(existsSync(join(scaffold.home, 'deferred-575.alive'))).toBe(false)
    const response = await request('toggle', { name: GOOD, enabled: true })
    const result = await response.json() as { ok: boolean; restart: boolean }
    expect(response.status, JSON.stringify(result)).toBe(502)
    expect(result.ok).toBe(false)
    expect(result.restart).toBe(true)
    const state = JSON.parse(readFileSync(join(dir, '.dsh-market/state.json'), 'utf8'))
    expect(state.disabled).not.toContain(GOOD)
    expect(state.disabled).toContain(BAD)
    await scaffold.restart()
    expect((await request('status')).status).toBe(200)
    expect(readFileSync(join(scaffold.home, 'deferred-575.alive'), 'utf8')).toBe('live')
  })
  it('persists a group carrier disable and deferred re-enable across real restarts', async () => {
    expect((await request('groups', { action: 'create', name: 'work' })).status).toBe(200)
    expect((await request('groups', { action: 'set-members', name: 'work', members: [GOOD] })).status).toBe(200)
    expect((await request('groups', { action: 'toggle', name: 'work', enabled: false })).status).toBe(200)
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dsh.profile.bundles).not.toContain(GOOD)
    rmSync(join(scaffold.home, 'deferred-575.alive'), { force: true })
    await scaffold.restart()
    expect(existsSync(join(scaffold.home, 'deferred-575.alive'))).toBe(false)
    const response = await request('groups', { action: 'toggle', name: 'work', enabled: true })
    const result = await response.json() as { restartMembers: string[] }
    expect(response.status, JSON.stringify(result)).toBe(400) // not live yet; accepted deferred member
    expect(result.restartMembers).toContain(GOOD)
    await scaffold.restart()
    expect(readFileSync(join(scaffold.home, 'deferred-575.alive'), 'utf8')).toBe('live')
  })

  it('restores a boot-loaded theme when its replacement really fails to import', async () => {
    themeMode = true
    const before = readFileSync(join(dir, '.dsh-market/state.json'), 'utf8')
    const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    const result = await request('use-skin', { name: BAD })
    expect(result.status, await result.text()).toBe(502)
    expect(readFileSync(join(scaffold.home, 'deferred-575.alive'), 'utf8')).toBe('live')
    expect(readFileSync(join(dir, '.dsh-market/state.json'), 'utf8')).toBe(before)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    await scaffold.restart()
    expect(readFileSync(join(scaffold.home, 'deferred-575.alive'), 'utf8')).toBe('live')
  })

  it('persists a successful theme replacement once the fixture export is repaired', async () => {
    writeFileSync(join(dir, 'node_modules', BAD, 'exports.js'), "import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; export function missingExport575() { writeFileSync(join(process.env.DSH_HOME, 'replacement-575.alive'), 'live') }\n")
    // Start a new module cache while the repaired fixture is still disabled.
    await scaffold.restart()
    expect(existsSync(join(scaffold.home, 'replacement-575.alive'))).toBe(false)
    const response = await request('use-skin', { name: BAD })
    expect(response.status, await response.text()).toBe(200)
    expect(existsSync(join(scaffold.home, 'deferred-575.alive'))).toBe(false)
    expect(readFileSync(join(scaffold.home, 'replacement-575.alive'), 'utf8')).toBe('live')
    const state = JSON.parse(readFileSync(join(dir, '.dsh-market/state.json'), 'utf8'))
    expect(state.disabled).toContain(GOOD)
    expect(state.disabled).not.toContain(BAD)
    rmSync(join(scaffold.home, 'replacement-575.alive'))
    await scaffold.restart()
    expect(existsSync(join(scaffold.home, 'deferred-575.alive'))).toBe(false)
    expect(readFileSync(join(scaffold.home, 'replacement-575.alive'), 'utf8')).toBe('live')
  })

})
