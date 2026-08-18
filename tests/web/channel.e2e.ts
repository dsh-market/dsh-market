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
import { resolveChannel } from '../../src/channels.ts'
import { marketVersion } from '../../src/routes.ts'
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
  const post = async (path: string, payload: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${scaffold.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: scaffold.baseUrl },
      body: JSON.stringify(payload),
    })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  }

  const setChannel = async (channel: string): Promise<number> =>
    (await post('/dsh-market/channel', { channel })).status

  const statusNow = async (): Promise<any> => {
    const res = await fetch(`${scaffold.baseUrl}/dsh-market/status`, { cache: 'no-store' })
    return await res.json()
  }

  const channelNow = async (): Promise<unknown> => {
    const res = await fetch(`${scaffold.baseUrl}/dsh-market/status`, { cache: 'no-store' })
    return ((await res.json()) as { channel?: unknown }).channel
  }

  // The pack step builds the tarball from THIS checkout, in this same
  // process, so `marketVersion()` reads the identical version that ends up
  // installed. Which of 'stable'/'beta' is "the derived default" and which
  // is "the one that can only appear if it was actually persisted" flips
  // depending on whether the checkout is a prerelease — hardcoding either
  // broke the first time main was tagged a stable release (1.14.0), because
  // the literal that used to be load-bearing became indistinguishable from
  // the default it was supposed to prove was NOT being used.
  const derived = resolveChannel(undefined, marketVersion())
  const other = derived === 'stable' ? 'beta' : 'stable'

  it('records nothing until the user picks, and derives from the build', async () => {
    // A market that had written a default would be indistinguishable from
    // one that derived the answer. The FILE is what separates them.
    expect(await channelNow()).toBe(derived)
    if (existsSync(statePath())) expect('channel' in readState()).toBe(false)
  })

  it('writes the choice to disk and answers with it after a real restart', async () => {
    // `other` is the load-bearing direction on THIS checkout: it is the one
    // answer derivation could never produce on its own, so it is the only
    // one that proves the choice was remembered rather than recomputed.
    expect(await setChannel(other)).toBe(200)
    expect(readState().channel).toBe(other)

    await scaffold.restart()
    expect(await channelNow()).toBe(other)
  }, 300_000)

  it('carries the way back onto the channel too', async () => {
    expect(await setChannel(derived)).toBe(200)
    expect(readState().channel).toBe(derived)

    await scaffold.restart()
    expect(await channelNow()).toBe(derived)
  }, 300_000)

  it('refuses a channel it does not have', async () => {
    expect(await setChannel('nightly')).toBe(400)
    // A rejected value must not have been written on the way to being
    // rejected — the file is read back at every boot with no second check.
    expect(readState().channel).toBe(derived)
  })
})

describe.skipIf(!HAS_DSH)('web e2e: the dev channel', () => {
  let scaffold: WebScaffold

  beforeAll(async () => { scaffold = await launchMarketScaffold() }, 300_000)
  afterAll(async () => { await scaffold?.close() })

  const statePath = (): string => join(scaffold.home, 'profiles', 'web', '.dsh-market', 'state.json')
  const readState = (): Record<string, unknown> =>
    existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), 'utf8')) as Record<string, unknown> : {}

  const post = async (path: string, payload: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${scaffold.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: scaffold.baseUrl },
      body: JSON.stringify(payload),
    })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  }
  const statusNow = async (): Promise<any> =>
    await (await fetch(`${scaffold.baseUrl}/dsh-market/status`, { cache: 'no-store' })).json()

  it('is offered by a real host with no opt-in of any kind', async () => {
    // It was behind a stored developer mode for one version. Nothing has to
    // be switched on any more — the label carries the warning instead.
    expect((await statusNow()).channels).toEqual(['stable', 'beta', 'dev'])
  })

  it('is selected, written down, and survives a real restart', async () => {
    expect((await post('/dsh-market/channel', { channel: 'dev' })).status).toBe(200)
    expect(readState().channel).toBe('dev')

    await scaffold.restart()
    expect((await statusNow()).channel).toBe('dev')
  }, 300_000)

  it('refuses a channel that does not exist, without writing it', async () => {
    expect((await post('/dsh-market/channel', { channel: 'nightly' })).status).toBe(400)
    expect(readState().channel).toBe('dev')
  })
})
