/**
 * Layer 3 — the REAL update chain, against a running host.
 *
 * install.e2e.ts proves a plugin can be put in place and made live. What it
 * cannot answer is what happens to a plugin that is ALREADY live when its
 * files are replaced underneath it, and that is where the update bugs live:
 * #491 (a loader entry re-imported into a mix of old and new instances),
 * #495 (a second update of something already current), #496 (a version
 * resolved twice and rolled back for disagreeing with itself).
 *
 * The one question a fake host can never settle is whether the RUNNING
 * process picked up the new files. The market's `activation[name].state` is
 * its own inference about that — the inference #103, #135 and #147 all got
 * wrong — so it is asserted against the fixture's marker, never trusted as
 * ground truth. The marker names the version of the module the process is
 * actually serving.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dshAvailable, launchMarketScaffold } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

const HAS_DSH = dshAvailable()
const A = 'dshm-e2e-fixture-a'

describe.skipIf(!HAS_DSH).sequential('web e2e: the real update chain', () => {
  let scaffold: WebScaffold
  let base: string

  beforeAll(async () => {
    // The same fixture twice: 1.0.0 to install, 2.0.0 to update to. 1.0.0 is
    // `latest` to begin with, because installing by name resolves the tag —
    // and because that is the user's actual position: running whatever was
    // current when they installed.
    scaffold = await launchMarketScaffold({
      fixtures: [{ dir: 'fixture-a', version: '2.0.0' }, { dir: 'fixture-a', version: '1.0.0' }],
    })
    base = scaffold.baseUrl
  }, 600_000)

  afterAll(async () => { await scaffold?.close() })

  const post = async (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify(body),
    })

  const get = async (path: string): Promise<any> => (await fetch(`${base}${path}`)).json()

  /** The version the RUNNING process is serving, or null when not live. */
  const liveVersion = (): string | null => {
    const marker = join(scaffold.home, `e2e-${A}.alive`)
    return existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null
  }

  it('installs the fixture at 1.0.0 and runs it', async () => {
    const installed = await post('/dsh-market/install', { url: `https://github.com/dshm-e2e/${A}` })
    expect(installed.status).toBe(200)
    expect(liveVersion()).toBe('1.0.0')
  }, 300_000)

  it('offers 2.0.0 as an update once it is published', async () => {
    scaffold.publish(A, '2.0.0')
    const updates = await get('/dsh-market/updates?force=1')
    expect(updates.updates[A]).toMatchObject({ kind: 'npm', current: '1.0.0', latest: '2.0.0', updateAvailable: true })
  }, 120_000)

  it('replaces the files but leaves the running process on the old module', async () => {
    const updated = await post('/dsh-market/update', { name: A })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ ok: true })

    // 2.0.0 is on disk…
    const installedPkg = JSON.parse(
      readFileSync(join(scaffold.home, 'profiles', 'web', 'node_modules', A, 'package.json'), 'utf8'),
    ) as { version: string }
    expect(installedPkg.version).toBe('2.0.0')

    // …and the process is still serving 1.0.0, because replacing a package
    // on disk does not unload the module Node already imported. This is the
    // fact the market's "restart to apply" verdict rests on; measuring it
    // here is what makes that verdict a claim about the host rather than
    // about our model of it.
    expect(liveVersion()).toBe('1.0.0')
  }, 300_000)

  it('says so, rather than reporting the update as live', async () => {
    // #491: the danger is a host that re-imports the entry into a process
    // still holding the old instances. If this host ever starts doing that,
    // the marker above flips to 2.0.0 and this suite fails loudly — which is
    // the point of writing the marker with a version rather than a
    // timestamp.
    const state = await get('/dsh-market/installed')
    expect(state.activation[A]?.state).toBe('restart')
    expect(state.activation[A]?.hot).toBe(false)
  }, 120_000)

  it('keeps saying so across a page refresh, not just in the update reply', async () => {
    // The reply is a one-shot; the listing is what every later page load
    // reads. Recomputing activation from the loader's inventory alone made
    // the notice disappear on refresh, leaving a plugin that serves its old
    // build looking finished and current.
    const again = await get('/dsh-market/installed')
    expect(again.activation[A]?.state).toBe('restart')
    expect(liveVersion()).toBe('1.0.0')
  }, 120_000)

  it('is live on the new build after a restart, with the notice gone', async () => {
    await scaffold.restart()
    expect(liveVersion()).toBe('2.0.0')
    const state = await get('/dsh-market/installed')
    expect(state.activation[A]?.state).toBe('live')
  }, 300_000)

  it('treats a second update of the now-current plugin as a skip, not a failure (#495)', async () => {
    const again = await post('/dsh-market/update', { name: A })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ ok: true, skipped: 'current', version: '2.0.0' })
  }, 300_000)
})
