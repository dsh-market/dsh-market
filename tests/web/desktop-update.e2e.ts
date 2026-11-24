/**
 * Layer 3 — the official-desktop branch against a REAL host's plugin manager.
 *
 * `dsh web` does not take the official branch by itself: that branch is for
 * the Electron app, whose profile is called `desktop` (the host refuses to
 * boot one by that name). The scaffold's `officialDesktop` option gets the
 * same code path on a plain host — the market's own config names the profile
 * `desktop`, `profiles/desktop` points at the real one — so every install,
 * update and removal below goes through `ctx.get('pluginManager')`, never
 * through a pnpm the market spawns.
 *
 * What it pins, on whatever host `DSHM_E2E_DSH` names:
 *
 * - dsh 0.2.2+ (has `updateBundle`): an update is ONE manager call, the new
 *   build is running afterwards without a restart (the fixture's liveness
 *   marker names the running version), and an install that fails leaves the
 *   old version running, with a message that says so.
 * - dsh 0.2.1 (no `updateBundle`): the same user-visible result through the
 *   remove-then-install pair, which the market still owns.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dshAvailable, dshCommand, launchMarketScaffold } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

const HAS_DSH = dshAvailable()
const A = 'dshm-e2e-fixture-a'

/** Whether the host under test ships `updateBundle` (dsh 0.2.2 and later). */
function hostHasUpdateBundle(): boolean {
  const command = dshCommand()
  if (command === null) return false
  const probe = spawnSync(`${command} --version`, { shell: true, encoding: 'utf8', timeout: 60_000 })
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(`${probe.stdout}`)
  if (match === null) return false
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  return major > 0 || minor > 2 || (minor === 2 && patch >= 2)
}

describe.skipIf(!HAS_DSH).sequential('web e2e: the official desktop branch drives the real plugin manager', () => {
  let scaffold: WebScaffold
  let base: string
  const inPlace = HAS_DSH && hostHasUpdateBundle()

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

  it('takes the official branch and installs through the manager', async () => {
    const status = await (await scaffold.api('/dsh-market/status')).json() as { desktopHost?: boolean }
    expect(status.desktopHost).toBe(true)
    const response = await post('/dsh-market/install', { url: `https://github.com/dshm-e2e/${A}` })
    expect(response.status, await response.clone().text()).toBe(200)
    await settle()
    expect(diskVersion()).toBe('1.0.0')
    expect(await waitFor(runningVersion, value => value !== null, 'the plugin starting')).toBe('1.0.0')
    // The host mounted it; the market must not mount a second copy beside it
    // (its own hot mount is only for hosts that do not replay installs).
    if (inPlace) {
      const log = await marketLog()
      expect(log).toContain('adopted instead of mounting a second copy')
      expect(log).not.toMatch(/hot.?mount(ed)? (failed|retained)/i)
    }
  })

  it('updates in place: one manager call, the new build is running without a restart', async () => {
    scaffold.publish(A, '1.1.0')
    const response = await post('/dsh-market/update', { name: A })
    const body = await response.text()
    expect(response.status, body).toBe(200)
    if (inPlace) {
      // The host swapped the build into the running process, so the market
      // must not tell the user a restart is needed (it used to, and kept
      // saying so on every later page load).
      const reply = JSON.parse(body) as { activation?: Record<string, { state: string }> }
      expect(reply.activation?.[A]?.state).toBe('live')
    }
    await settle()
    expect(diskVersion()).toBe('1.1.0')
    // Ground truth, not the market's own inference: the module the host is
    // serving is the new one.
    expect(await waitFor(runningVersion, value => value === '1.1.0', 'the new build running')).toBe('1.1.0')
    expect(journal(), 'a settled update leaves nothing for the next start to repair').not.toContain(A)
    const log = await marketLog()
    if (inPlace) expect(log).toContain(`${A} 1.0.0 -> 1.1.0: asking the host to update it in place`)
    else expect(log).not.toContain('asking the host to update it in place')
  })

  it('keeps a plugin the user switched off OFF through the update, and runs the new build when it is switched on', async () => {
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
    expect(await waitFor(runningVersion, value => value === '1.1.5', 'the new build starting')).toBe('1.1.5')
  })

  it('puts the old version back, and says so, when the new one cannot start', async () => {
    scaffold.publish(A, '1.2.0')
    const response = await post('/dsh-market/update', { name: A })
    const body = await response.text()
    expect(response.status, body).toBeGreaterThanOrEqual(400)
    await settle()
    // Whatever the path, the user is left with the version they had, running.
    expect(diskVersion()).toBe('1.1.5')
    expect(await waitFor(runningVersion, value => value === '1.1.5', 'the old build running again')).toBe('1.1.5')
    expect(journal()).not.toContain('"to": "1.2.0"')
    // A failure with only a code is not a message (AGENTS.md): it names what
    // happened, and it does not blame a profile that was put back.
    expect(body).not.toMatch(/^\{"code"/)
    if (inPlace) {
      expect(await marketLog()).toContain(`${A}: the host answered at step install`)
      // What happened (it did not start), what became of the old version, in
      // the words the user reads — not a code and not a stack.
      expect(body).toContain('旧版本已经装回')
      expect(body).toContain('The old version was put back')
    }
  })
})

describe.skipIf(!HAS_DSH).sequential('web e2e: the market updates ITSELF through the host manager', () => {
  let scaffold: WebScaffold
  let base: string
  // Versions that were never published: the public registry has no 9.x, so a
  // resolution that leaked there would fail loudly instead of installing a
  // real release that happens to share the number.
  const current = '9.0.1'
  const next = '9.0.2'

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
  const inPlace = hostHasUpdateBundle()
  const marketLog = async (): Promise<string> => (await scaffold.api('/dsh-market/logs')).text()
  const journal = (): string => {
    const file = join(scaffold.home, 'profiles', 'web', '.dsh-market', 'pending-updates.json')
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
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

  it('swaps its own server half through the host, answers the request that asked, and keeps serving', async () => {
    const before = await status()
    expect(before).toMatchObject({ desktopHost: true, selfManaged: true, version: current })
    scaffold.publish('dshmarket', next)
    const response = await post('/dsh-market/update', { name: 'dshmarket' })
    const body = await response.text()
    if (!inPlace) {
      // 0.2.1 has no in-place update, and removing the market from inside
      // itself would unload the code that was going to install the new one
      // (#900). With no launcher pnpm on a plain host the market says so,
      // and names the way out; on the Electron app the launcher's pnpm does it.
      expect(response.status).toBe(502)
      expect(JSON.parse(body)).toMatchObject({ ok: false, failureCode: 'market-self-update' })
      return
    }
    // The request that asked is answered by an instance the host has already
    // replaced; it must still be an answer, not a 500.
    expect(response.status, body).toBe(200)
    const reply = JSON.parse(body) as { ok?: boolean; selfSwapped?: boolean; activation?: Record<string, { state: string }> }
    expect(reply.ok).toBe(true)
    expect(diskVersion()).toBe(next)
    if (inPlace) {
      expect(reply.selfSwapped).toBe(true)
      // The new SERVER half is the one answering: its `version` is read from
      // the package.json it was loaded beside, so only a re-evaluated module
      // can say the new number.
      await waitFor(async () => (await status().catch(() => ({ version: undefined }))).version, version => version === next, 'the new server half')
      expect(await marketLog()).not.toContain('inactive context')
      // Nothing is left half-done for the next start to repair.
      expect(journal()).not.toContain('dshmarket')
      // The page's own "apply now" asks the server to swap; there is nothing
      // left to swap, and it says so instead of failing.
      const reload = await post('/dsh-market/reload-self', {})
      expect(await reload.json()).toMatchObject({ ok: true, outcome: 'current', version: next })
    }
  })

  it('does not wedge later operations: the new instance is idle and installs a plugin', async () => {
    if (!inPlace) return
    const idle = await waitFor(async () => status(), value => (value as { busy?: boolean }).busy !== true, 'the new instance going idle')
    expect(idle).toMatchObject({ busy: false })
    const installed = await post('/dsh-market/install', { url: 'https://github.com/dshm-e2e/dshm-e2e-fixture-a' })
    expect(installed.status, await installed.clone().text()).toBe(200)
  })
})
