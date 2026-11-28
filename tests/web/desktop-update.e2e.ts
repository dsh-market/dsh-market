/**
 * Layer 3 — the official-desktop branch against a REAL host's plugin manager.
 *
 * `dsh web` does not take the official branch by itself: that branch is for
 * the Electron app, whose profile is called `desktop` (the host refuses to
 * boot one by that name). The scaffold's `officialDesktop` option gets the
 * same code path on a plain host — the market's own config names the profile
 * `desktop`, `profiles/desktop` points at the real one — so every install,
 * update and removal of another plugin goes through `ctx.get('pluginManager')`.
 * The market itself can overlay its files using pnpm supplied by Desktop.
 *
 * What it pins, on whatever host `DSHM_E2E_DSH` names:
 *
 * - dsh 0.2.2+ (has `updateBundle`): an update is ONE manager call, the new
 *   build is running afterwards without a restart (the fixture's liveness
 *   marker names the running version), and an install that fails leaves the
 *   old version running, with a message that says so.
 * - From 0.2.1-alpha.3 the market can remove and reinstall a plugin live.
 * - From 0.1.6-alpha.2 the manager can replace a build for the next start.
 * - Earlier hosts have no manager: the market directs users to Settings.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compareVersions } from '../../src/updates.ts'
import { dshHostVersion } from './market-build.ts'
import { dshAvailable, launchMarketScaffold } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

const HAS_DSH = dshAvailable()
const A = 'dshm-e2e-fixture-a'

/** Choose the expected contract independently of the operation being tested. */
function desktopUpdateMode(): 'settings' | 'restart' | 'reinstall' | 'in-place' {
  const version = dshHostVersion()
  if (version === null) throw new Error('could not read the DSH host version')
  const before = (first: string): boolean => {
    const order = compareVersions(version, first)
    if (order === null) throw new Error(`unrecognised DSH version: ${version}`)
    return order < 0
  }
  if (before('0.1.6-alpha.2')) return 'settings'
  if (before('0.2.1-alpha.3')) return 'restart'
  if (before('0.2.2-alpha.2')) return 'reinstall'
  return 'in-place'
}
const mode = HAS_DSH ? desktopUpdateMode() : null

describe.skipIf(!HAS_DSH).sequential('web e2e: the official desktop branch drives the real plugin manager', () => {
  let scaffold: WebScaffold
  let base: string

  beforeAll(async () => {
    scaffold = await launchMarketScaffold({
      officialDesktop: true,
      fixtures: [
        // `latest` is the last entry until a spec moves it.
        { dir: 'fixture-a', version: '1.0.0' },
        { dir: 'fixture-a', version: '1.1.0' },
        { dir: 'fixture-a', version: '1.1.5' },
        // A release whose bundle patch names a file it does not ship: pnpm
        // installs it fine and the host cannot load it, so the install fails
        // AFTER the old version was taken out.
        { dir: 'fixture-a', version: '1.2.0', manifest: { dsh: { bundle: { patch: './missing.patch.yml' } } } },
      ],
    })
    base = scaffold.baseUrl
    scaffold.publish(A, '1.0.0')
  }, 600_000)

  afterAll(async () => { await scaffold?.close() })

  const post = async (path: string, body: unknown): Promise<Response> =>
    scaffold.api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify(body),
    })

  const settle = async (): Promise<void> => {
    for (let attempt = 0; attempt < 90; attempt++) {
      const status = (await (await scaffold.api('/dsh-market/status')).json()) as { busy?: boolean; active?: boolean }
      if (status.busy !== true && status.active !== true) return
      await new Promise(done => setTimeout(done, 1000))
    }
    throw new Error('the operation never settled')
  }

  const profile = (): string => join(scaffold.home, 'profiles', 'web')
  const diskVersion = (): string | null => {
    try {
      return (JSON.parse(readFileSync(join(profile(), 'node_modules', A, 'package.json'), 'utf8')) as { version: string }).version
    } catch { return null }
  }
  /** The version the fixture says it is RUNNING, or null while it is not loaded. */
  const runningVersion = (): string | null => {
    const marker = join(scaffold.home, `e2e-${A}.alive`)
    return existsSync(marker) ? readFileSync(marker, 'utf8') : null
  }
  const waitFor = async <T>(read: () => T, done: (value: T) => boolean, what: string): Promise<T> => {
    let last = read()
    for (let attempt = 0; attempt < 60 && !done(last); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500))
      last = read()
    }
    if (!done(last)) throw new Error(`${what}: still ${JSON.stringify(last)}`)
    return last
  }
  const marketLog = async (): Promise<string> => (await scaffold.api('/dsh-market/logs')).text()
  const journal = (): string => {
    const file = join(profile(), '.dsh-market', 'pending-updates.json')
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  }

  it('installs through the desktop manager or directs the user to Settings when it is absent', async () => {
    const status = await (await scaffold.api('/dsh-market/status')).json() as { desktopHost?: boolean }
    expect(status.desktopHost).toBe(true)
    const response = await post('/dsh-market/install', { url: `https://github.com/dshm-e2e/${A}` })
    const body = await response.text()
    if (mode === 'settings') {
      expect(response.status, body).toBe(502)
      expect(JSON.parse(body)).toMatchObject({ ok: false, exitCode: 127, stderr: expect.stringContaining('Settings → Plugins') })
      await settle()
      expect(diskVersion()).toBeNull()
      expect(runningVersion()).toBeNull()
      expect(JSON.parse(readFileSync(join(profile(), 'package.json'), 'utf8')).dependencies).not.toHaveProperty(A)
      return
    }
    expect(response.status, body).toBe(200)
    await settle()
    expect(diskVersion()).toBe('1.0.0')
    expect(await waitFor(runningVersion, value => value !== null, 'the plugin starting')).toBe('1.0.0')
    // The host mounted it; the market must not mount a second copy beside it
    // (its own hot mount is only for hosts that do not replay installs).
    if (mode === 'in-place') {
      const log = await marketLog()
      expect(log).toContain('adopted instead of mounting a second copy')
      expect(log).not.toMatch(/hot.?mount(ed)? (failed|retained)/i)
    }
  })

  it.skipIf(mode === 'settings')('updates the installed version and activates it live on hosts that support it', async () => {
    scaffold.publish(A, '1.1.0')
    const response = await post('/dsh-market/update', { name: A })
    const body = await response.text()
    expect(response.status, body).toBe(200)
    if (mode === 'in-place') {
      // The host swapped the build into the running process, so the market
      // must not tell the user a restart is needed (it used to, and kept
      // saying so on every later page load).
      const reply = JSON.parse(body) as { activation?: Record<string, { state: string }> }
      expect(reply.activation?.[A]?.state).toBe('live')
    }
    await settle()
    expect(diskVersion()).toBe('1.1.0')
    expect(journal(), 'a settled update leaves nothing for the next start to repair').not.toContain(A)
    const log = await marketLog()
    if (mode === 'in-place') expect(log).toContain(`${A} 1.0.0 -> 1.1.0: asking the host to update it in place`)
    else expect(log).not.toContain('asking the host to update it in place')
    // Ground truth, not the market's own inference: the module the host is
    // serving changes immediately only on hosts that can replace it live.
    const expected = mode === 'restart' ? '1.0.0' : '1.1.0'
    expect(await waitFor(runningVersion, value => value === expected, 'the running build')).toBe(expected)
  })

  it.skipIf(mode === 'settings')('keeps a plugin switched off through an update and loads it when switched on', async () => {
    // The market's own switch (patch rows + its state file) and the host's
    // swap both act on the same plugin: if the host's reinstall brought the
    // old rows back, the plugin would come up on its own after an update.
    const toggle = async (enabled: boolean): Promise<void> => {
      const response = await post('/dsh-market/toggle', { name: A, enabled })
      expect(response.status, await response.clone().text()).toBe(200)
    }
    await toggle(false)
    await waitFor(runningVersion, value => value === null, 'the plugin stopping')
    scaffold.publish(A, '1.1.5')
    const response = await post('/dsh-market/update', { name: A })
    expect(response.status, await response.clone().text()).toBe(200)
    await settle()
    expect(diskVersion()).toBe('1.1.5')
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(runningVersion(), 'an update must not switch a plugin back on').toBeNull()
    await toggle(true)
    const expected = mode === 'restart' ? '1.0.0' : '1.1.5'
    expect(await waitFor(runningVersion, value => value === expected, 'the enabled build starting')).toBe(expected)
  })

  it.skipIf(mode === 'settings')('puts the old version back, and says so, when the new one cannot start', async () => {
    scaffold.publish(A, '1.2.0')
    const response = await post('/dsh-market/update', { name: A })
    const body = await response.text()
    expect(response.status, body).toBeGreaterThanOrEqual(400)
    await settle()
    // Two valid updates may still be waiting for a restart. A failed third
    // update must restore the last build on disk, even in that state.
    expect(diskVersion(), body).toBe('1.1.5')
    expect(loadYaml(readFileSync(join(profile(), 'pnpm-lock.yaml'), 'utf8'))).toMatchObject({
      importers: { '.': { dependencies: { [A]: { version: '1.1.5' } } } },
    })
    expect(journal()).not.toContain('"to": "1.2.0"')
    if (mode === 'restart') {
      expect(runningVersion()).toBe('1.0.0')
      await scaffold.restart()
    }
    expect(await waitFor(runningVersion, value => value === '1.1.5', 'the old build running again')).toBe('1.1.5')
    // A failure with only a code is not a message (AGENTS.md): it names what
    // happened, and it does not blame a profile that was put back.
    expect(body).not.toMatch(/^\{"code"/)
    if (mode === 'in-place') {
      expect(await marketLog()).toContain(`${A}: the host answered at step install`)
      // What happened (it did not start), what became of the old version, in
      // the words the user reads — not a code and not a stack.
      expect(body).toContain('旧版本已经装回')
      expect(body).toContain('The old version was put back')
    }
  })
})

describe.skipIf(!HAS_DSH).sequential('web e2e: a desktop self-update keeps the installed market', () => {
  let scaffold: WebScaffold
  let base: string
  // Versions that were never published: the public registry has no 9.x, so a
  // resolution that leaked there would fail loudly instead of installing a
  // real release that happens to share the number.
  const current = '9.0.1'
  const next = '9.0.2'
  // The published dsh CLI has no launcher pnpm. Set this when running with
  // the Desktop app's own CLI, which supplies its bundled pnpm to the market.
  const launcherPnpm = process.env.DSHM_E2E_DESKTOP_PNPM === '1'

  beforeAll(async () => {
    scaffold = await launchMarketScaffold({
      officialDesktop: true,
      fixtures: ['fixture-a'],
      selfVersions: [current, next],
    })
    base = scaffold.baseUrl
  }, 600_000)

  afterAll(async () => { await scaffold?.close() })

  const post = async (path: string, body: unknown): Promise<Response> =>
    scaffold.api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify(body),
    })
  const status = async (): Promise<{ version?: string; desktopHost?: boolean; selfReload?: boolean; selfManaged?: boolean }> =>
    (await scaffold.api('/dsh-market/status')).json() as never
  const diskVersion = (): string => (JSON.parse(readFileSync(
    join(scaffold.home, 'profiles', 'web', 'node_modules', 'dshmarket', 'package.json'), 'utf8',
  )) as { version: string }).version
  const journal = (): string => {
    const file = join(scaffold.home, 'profiles', 'web', '.dsh-market', 'pending-updates.json')
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  }
  const profileManifest = () => JSON.parse(readFileSync(join(scaffold.home, 'profiles', 'web', 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } }
  }
  const waitFor = async <T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> => {
    let last = await read()
    for (let attempt = 0; attempt < 60 && !done(last); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500))
      last = await read()
    }
    if (!done(last)) throw new Error(`${what}: still ${JSON.stringify(last)}`)
    return last
  }

  it.skipIf(mode !== 'in-place')('keeps the market when neither the new nor the old build can be installed (#1328)', async () => {
    const workspace = join(scaffold.home, 'profiles', 'web', 'pnpm-workspace.yaml')
    const previous = existsSync(workspace) ? readFileSync(workspace, 'utf8') : null
    const manifest = profileManifest()
    // Both builds depend on js-yaml. Only the already-installed files work
    // now: if the host removes them, even restoring the old version will fail.
    writeFileSync(workspace, `${previous ?? ''}\noverrides:\n  "dshmarket>js-yaml": "npm:${A}@99.0.0"\n`)
    try {
      scaffold.publish('dshmarket', next)
      const response = await post('/dsh-market/update', { name: 'dshmarket' })
      const body = await response.text()
      expect(response.status, body).toBe(502)
      if (launcherPnpm) expect(body).toContain('ERR_PNPM_NO_MATCHING_VERSION')
      expect(diskVersion()).toBe(current)
      expect(profileManifest()).toMatchObject({ dependencies: manifest.dependencies, dsh: { profile: { bundles: manifest.dsh.profile.bundles } } })
      expect(journal()).not.toContain('dshmarket')
      expect((await status()).version).toBe(current)
    } finally {
      if (previous === null) rmSync(workspace)
      else writeFileSync(workspace, previous)
    }
  })

  it('updates without unloading itself, or keeps the old version when it cannot (#1328)', async () => {
    const before = await status()
    expect(before).toMatchObject({ desktopHost: true, selfManaged: true, version: current })
    scaffold.publish('dshmarket', next)
    const response = await post('/dsh-market/update', { name: 'dshmarket' })
    const body = await response.text()
    const manifest = profileManifest()
    expect(manifest.dsh.profile.bundles).toContain('dshmarket')
    expect(manifest.dependencies).toHaveProperty('dshmarket')
    expect(journal()).not.toContain('dshmarket')
    if (mode === 'settings' || (mode !== 'restart' && !launcherPnpm)) {
      // Live managers unload the caller in updateBundle or removeBundle.
      // Without launcher pnpm the old market must keep answering.
      expect(response.status, body).toBe(502)
      expect(JSON.parse(body)).toMatchObject(mode === 'settings'
        ? { ok: false, exitCode: 127, stderr: expect.stringContaining('Settings → Plugins') }
        : { ok: false, failureCode: 'market-self-update' })
      expect(diskVersion()).toBe(current)
      expect((await status()).version).toBe(current)
      return
    }
    expect(response.status, body).toBe(200)
    const reply = JSON.parse(body) as { ok?: boolean; selfSwapped?: boolean }
    expect(reply.ok).toBe(true)
    expect(reply.selfSwapped).not.toBe(true)
    expect(diskVersion()).toBe(next)
    expect((await status()).version).toBe(current)
    await scaffold.restart()
    expect((await status()).version).toBe(next)
  })

  it.skipIf(mode === 'settings')('keeps serving after the update attempt and can install another plugin', async () => {
    const idle = await waitFor(async () => status(), value => (value as { busy?: boolean }).busy !== true, 'the new instance going idle')
    expect(idle).toMatchObject({ busy: false })
    const installed = await post('/dsh-market/install', { url: 'https://github.com/dshm-e2e/dshm-e2e-fixture-a' })
    expect(installed.status, await installed.clone().text()).toBe(200)
  })
})
