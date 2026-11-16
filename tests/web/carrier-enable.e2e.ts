/** Real host regression: a carrier switched off in the market can be enabled
 * through the official manager and survives a fresh composition. The control
 * fixture calls the actual host service; no guessed YAML writer is involved. */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dshAvailable, dshCommand, launchMarketScaffold } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

const CARRIER = 'dshm-e2e-fixture-carrier-enable'
const CONTROL = 'dshm-e2e-fixture-carrier-enable-control'
const DEPENDENT = 'dshm-e2e-fixture-carrier-enable-dependent'

describe.skipIf(!dshAvailable()).sequential('web e2e: official carrier re-enable (#1242)', () => {
  let scaffold: WebScaffold
  beforeAll(async () => {
    scaffold = await launchMarketScaffold({ fixtures: ['fixture-carrier-enable/dependent', 'fixture-carrier-enable', 'fixture-carrier-enable/control'] })
  }, 600_000)
  afterAll(async () => { await scaffold?.close() })

  const post = (path: string, body: unknown): Promise<Response> => scaffold.api(path, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: scaffold.baseUrl }, body: JSON.stringify(body),
  })
  const waitFor = async (predicate: () => boolean, detail: string): Promise<void> => {
    const deadline = Date.now() + 20_000
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(detail)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  const profile = (): string => join(scaffold.home, 'profiles', 'web')
  const bundles = (): string[] => JSON.parse(readFileSync(join(profile(), 'package.json'), 'utf8')).dsh.profile.bundles as string[]
  const disabled = (): string[] => JSON.parse(readFileSync(join(profile(), '.dsh-market', 'state.json'), 'utf8')).disabled as string[]
  const marker = (component: string): string => join(scaffold.home, `e2e-carrier-enable-${component}.alive`)
  const markerPid = (component: string): number | null => {
    try { return JSON.parse(readFileSync(marker(component), 'utf8')).pid as number } catch { return null }
  }

  it('keeps the root component, subpath gate, and dependent plugin enabled after restart', async ctx => {
    const command = dshCommand()
    const version = command === null ? '' : spawnSync(command, ['--version'], {
      shell: true, encoding: 'utf8', timeout: 30_000, cwd: process.env.DSHM_E2E_DSH_CWD,
    }).stdout ?? ''
    if (/(?:^|[\s/])0\.1\./u.test(version)) ctx.skip('The 0.1 host has no official pluginManager service; this contract is tested on 0.2 hosts.')

    for (const name of [CONTROL, DEPENDENT, CARRIER]) {
      const response = await post('/dsh-market/install', { url: `https://github.com/dshm-e2e/${name}` })
      const body = await response.text()
      expect(`${response.status} ${body.slice(0, 1000)}`).toMatch(/^200 /u)
    }
    await scaffold.restart()
    const capabilitiesFile = join(scaffold.home, 'carrier-enable-control.ready.json')
    await waitFor(() => existsSync(capabilitiesFile), 'the official manager control fixture never loaded')
    const capabilities = JSON.parse(readFileSync(capabilitiesFile, 'utf8')) as { supported: boolean }
    expect(capabilities.supported, 'this host must expose the actual package and component enable methods').toBe(true)
    for (const component of ['native', 'gate', 'dependent']) {
      await waitFor(() => markerPid(component) !== null, `${component} never became live`)
    }
    expect(JSON.parse(readFileSync(marker('dependent'), 'utf8')).policyReady).toBe(true)

    const off = await post('/dsh-market/toggle', { name: CARRIER, enabled: false })
    expect(off.status).toBe(200)
    expect(disabled()).toContain(CARRIER)
    expect(bundles()).not.toContain(CARRIER)
    const offPatch = readFileSync(join(profile(), 'cordis.patch.yml'), 'utf8')

    const id = `enable-${Date.now()}`
    const responseFile = join(scaffold.home, 'carrier-enable-control.response.json')
    const requestFile = join(scaffold.home, 'carrier-enable-control.request.json')
    writeFileSync(requestFile, JSON.stringify({ id }))
    await waitFor(() => {
      if (!existsSync(responseFile)) return false
      try { return JSON.parse(readFileSync(responseFile, 'utf8')).id === id } catch { return false }
    }, 'the official manager did not finish enabling the carrier')
    const responseText = readFileSync(responseFile, 'utf8')
    const enabled = JSON.parse(responseText) as { ok: boolean; executions: number; rows: { moduleName: string }[]; error?: string }
    expect(enabled.error).toBeUndefined()
    expect(enabled.ok).toBe(true)
    expect(enabled.executions).toBe(1)
    expect(existsSync(requestFile)).toBe(false)
    expect(enabled.rows.map(row => row.moduleName).sort()).toEqual([CARRIER, `${CARRIER}/gate`].sort())
    const enabledPatch = readFileSync(join(profile(), 'cordis.patch.yml'), 'utf8')
    expect(bundles()).toContain(CARRIER)

    const beforePids = Object.fromEntries(['native', 'gate', 'dependent'].map(component => [component, markerPid(component)]))
    await scaffold.restart()
    for (const component of ['native', 'gate', 'dependent']) {
      await waitFor(() => {
        const pid = markerPid(component)
        return pid !== null && pid !== beforePids[component]
      }, `${component} did not load in the restarted host`)
    }
    expect(JSON.parse(readFileSync(marker('dependent'), 'utf8')).policyReady).toBe(true)
    expect(existsSync(requestFile)).toBe(false)
    expect(readFileSync(responseFile, 'utf8')).toBe(responseText)
    await waitFor(() => !disabled().includes(CARRIER) || !bundles().includes(CARRIER), 'the market boot replay never reconciled carrier state')
    expect(bundles()).toContain(CARRIER)
    expect(disabled()).not.toContain(CARRIER)
    // Check the user-visible restart outcome first: a regression must fail
    // on the plugin being removed, not just on the chosen YAML spelling.
    // The real writer keeps named rows. Bare id/disabled rows disappear,
    // leaving the market no newer explicit decision to follow.
    expect(offPatch).toContain(`name: '${CARRIER}'`)
    expect(offPatch).toContain(`name: '${CARRIER}/gate'`)
    expect(enabledPatch).toContain('disabled: false')
    // The carrier's own patch and its foreign injection are still in force.
    const installed = await (await scaffold.api('/dsh-market/installed')).json() as { activation: Record<string, { state: string }> }
    expect(installed.activation[CARRIER]?.state).toBe('live')
  }, 600_000)
})
