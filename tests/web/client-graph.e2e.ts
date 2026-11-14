/**
 * Layer 3 — a plugin that has a browser half (`dsh.client`) and was switched
 * on LIVE must leave the page's client graph when it is switched off (#1188).
 *
 * The host serves the page its list of client plugins (`window.__DSH_BOOT__`,
 * inlined in the index document). A package leaves that list only when no
 * loader entry for it is still live, so "the host half stopped" and "the page
 * stopped loading it" are two facts, and only the second is what the user
 * sees: a plugin that replaces part of the page stayed on screen after the
 * market reported it off, even across a reload, until the host restarted.
 *
 * Ground truth for both halves: the fixture logs apply/dispose, and the page
 * HTML says whether the graph still names it.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dshAvailable, launchMarketScaffold } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

const CLIENT = 'dshm-e2e-fixture-client'

describe.skipIf(!dshAvailable()).sequential('web e2e: the client graph follows a live toggle (#1188)', () => {
  let scaffold: WebScaffold

  beforeAll(async () => {
    scaffold = await launchMarketScaffold({ fixtures: ['fixture-client'] })
  }, 600_000)
  afterAll(async () => { await scaffold?.close() })

  const post = (path: string, body: unknown): Promise<Response> =>
    scaffold.api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: scaffold.baseUrl },
      body: JSON.stringify(body),
    })

  const settle = async (): Promise<void> => {
    for (let attempt = 0; attempt < 90; attempt++) {
      const status = (await (await scaffold.api('/dsh-market/status')).json()) as { busy?: boolean; active?: boolean }
      if (status.busy !== true && status.active !== true) return
      await new Promise(done => setTimeout(done, 2000))
    }
    throw new Error('operation never settled')
  }

  /** Whether the page the host serves still lists the plugin's browser half. */
  const pageLoadsIt = async (): Promise<boolean> => (await (await scaffold.api('/')).text()).includes(CLIENT)

  /** What the host half did, in order: `apply` / `dispose`. */
  const hostHistory = (): string[] =>
    readFileSync(join(scaffold.home, 'client-fixture.log'), 'utf8').split('\n').filter(Boolean)

  const toggle = async (enabled: boolean): Promise<void> => {
    const response = await post('/dsh-market/toggle', { name: CLIENT, enabled })
    expect(response.status).toBe(200)
    await settle()
  }

  it('stops serving the browser half after: off, restart, live on, live off', async () => {
    const install = await post('/dsh-market/install', { url: `https://github.com/dshm-e2e/${CLIENT}` })
    expect(install.status).toBe(200)
    await settle()
    expect(await pageLoadsIt()).toBe(true)

    // The path that already worked: an entry the host composed itself.
    await toggle(false)
    expect(await pageLoadsIt()).toBe(false)

    // Off survives a restart, so turning it on again has no host entry to
    // flip and takes the market's own live mount — the path of the report.
    await scaffold.restart()
    expect(await pageLoadsIt()).toBe(false)
    await toggle(true)
    expect(await pageLoadsIt()).toBe(true)

    await toggle(false)
    // The host half really stopped...
    expect(hostHistory().at(-1)).toBe('dispose')
    // ...and the page no longer fetches the browser half either.
    expect(await pageLoadsIt()).toBe(false)
  }, 600_000)
})
