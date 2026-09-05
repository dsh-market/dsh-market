/**
 * Layer 3 — the host-version pre-check, against a real dsh.
 *
 * This one NEEDS a real host: the check compares a release's declared DSH
 * requirement against the version of the runtime actually running, and a
 * fake host has no version to report. Under vitest `dshHostInfo()` finds
 * nothing, so the check correctly stands aside and the unit lane can only
 * prove it does not fire. Here it fires.
 *
 * The case is #404's: a plugin release migrated to a host API the user's
 * runtime did not have, floated in on a caret range, installed silently and
 * broke. It declared nothing at the time; the point of #473 is that most
 * releases now do.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dshAvailable, launchMarketScaffold } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

const HAS_DSH = dshAvailable()
const A = 'dshm-e2e-fixture-a'

describe.skipIf(!HAS_DSH).sequential('web e2e: the host-version pre-check (#404)', () => {
  let scaffold: WebScaffold
  let base: string

  beforeAll(async () => {
    // 1.0.0 is installable; 2.0.0 claims to need a DSH that cannot exist.
    // A far-future range rather than a real one so this stays true as the
    // host versions in CI move.
    scaffold = await launchMarketScaffold({
      fixtures: [
        { dir: 'fixture-a', version: '2.0.0', manifest: { engines: { dsh: '>=99.0.0' } } },
        { dir: 'fixture-a', version: '1.0.0' },
      ],
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

  const installedVersion = (): string | null => {
    try {
      return (JSON.parse(readFileSync(
        join(scaffold.home, 'profiles', 'web', 'node_modules', A, 'package.json'),
        'utf8',
      )) as { version: string }).version
    } catch {
      return null
    }
  }

  it('installs 1.0.0, which declares nothing', async () => {
    const installed = await post('/dsh-market/install', { url: `https://github.com/dshm-e2e/${A}` })
    expect(installed.status).toBe(200)
    expect(installedVersion()).toBe('1.0.0')
  }, 300_000)

  it('refuses the update to a release that needs a newer host, and changes nothing', async () => {
    scaffold.publish(A, '2.0.0')
    const refused = await post('/dsh-market/update', { name: A })

    expect(refused.status).toBe(400)
    const body = await refused.json() as { hostIncompatible?: { requirement?: string; hostVersion?: string } }
    expect(body.hostIncompatible).toBeDefined()
    expect(body.hostIncompatible?.requirement).toContain('99')
    // The host's real version, which is the half a fake host cannot supply.
    expect(body.hostIncompatible?.hostVersion).toMatch(/^\d+\.\d+\./)
    // Refused BEFORE the install: the profile is untouched.
    expect(installedVersion()).toBe('1.0.0')
  }, 300_000)

  it('lets the user through when they insist', async () => {
    // The market can be the wrong one here — a bundled host that misreports
    // its version makes a satisfiable requirement look unsatisfied — so the
    // check is a question, not a lock.
    const forced = await post('/dsh-market/update', { name: A, force: true })
    expect(forced.status).toBe(200)
    expect(await forced.json()).toMatchObject({ ok: true })
    expect(installedVersion()).toBe('2.0.0')
  }, 300_000)
})
