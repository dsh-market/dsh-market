/**
 * Web e2e: the release channel is remembered across a real restart.
 *
 * No browser here — the claim under test is about a FILE and a process, and
 * the unit lane cannot make it. There the whole of hot.ts is a stand-in, so
 * "the choice was persisted" was measured against an object in the same
 * worker that had just been told; the first version shipped with the route
 * writing nothing at all and four route tests passing over it.
 *
 * `restart()` is the assertion: dsh is stopped and recomposed from disk, so
 * the only thing that can carry the answer between the two processes is
 * what actually landed in state.json.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dshAvailable, launchMarketScaffold } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

const HAS_DSH = dshAvailable()

describe.skipIf(!HAS_DSH)('web e2e: release channel', () => {
  let scaffold: WebScaffold

  beforeAll(async () => { scaffold = await launchMarketScaffold() }, 300_000)
  afterAll(async () => { await scaffold?.close() })

  const statePath = (): string => join(scaffold.home, 'profiles', 'web', '.dsh-market', 'state.json')

  const readState = (): Record<string, unknown> =>
    JSON.parse(readFileSync(statePath(), 'utf8')) as Record<string, unknown>

  /** POST as the market's own page does — the route requires a same origin. */
  const setChannel = async (channel: string): Promise<number> => {
    const res = await fetch(`${scaffold.baseUrl}/dsh-market/channel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: scaffold.baseUrl },
      body: JSON.stringify({ channel }),
    })
    return res.status
  }

  const channelNow = async (): Promise<unknown> => {
    const res = await fetch(`${scaffold.baseUrl}/dsh-market/status`, { cache: 'no-store' })
    return ((await res.json()) as { channel?: unknown }).channel
  }

  it('records nothing until the user picks, and derives from the build', async () => {
    // The packed build under test is a prerelease, so a market that had
    // written a default would be indistinguishable from one that derived
    // the answer. The FILE is what separates them.
    expect(await channelNow()).toBe('beta')
    if (existsSync(statePath())) expect('channel' in readState()).toBe(false)
  })

  it('writes the choice to disk and answers with it after a real restart', async () => {
    // 'stable' on a prerelease build is the load-bearing direction: it is
    // the only answer that cannot be re-derived, so it is the only one that
    // proves the choice was remembered rather than recomputed.
    expect(await setChannel('stable')).toBe(200)
    expect(readState().channel).toBe('stable')

    await scaffold.restart()
    expect(await channelNow()).toBe('stable')
  }, 300_000)

  it('carries the way back onto the channel too', async () => {
    expect(await setChannel('beta')).toBe(200)
    expect(readState().channel).toBe('beta')

    await scaffold.restart()
    expect(await channelNow()).toBe('beta')
  }, 300_000)

  it('refuses a channel it does not have', async () => {
    expect(await setChannel('nightly')).toBe(400)
    // A rejected value must not have been written on the way to being
    // rejected — the file is read back at every boot with no second check.
    expect(readState().channel).toBe('beta')
  })
})
