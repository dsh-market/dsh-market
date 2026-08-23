/**
 * Choosing a download region by measuring rather than guessing.
 *
 * The rule under test is "whichever registry answers first wins", and the
 * cases that matter are the ones a time-zone lookup would get wrong: a
 * machine in China behind a working proxy (official answers first — stay
 * global) and a machine that genuinely cannot reach the official registry
 * (mirror answers — switch). Both are expressed here as which stubbed fetch
 * resolves, because that is exactly the signal the real probe reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { probeRegion, resolveRegion } from '../src/region-probe.ts'
import { routesFor } from '../src/regions.ts'

const OFFICIAL = routesFor('global', {}).npmRegistry
const MIRROR = routesFor('china', {}).npmRegistry

/** A fetch that answers per-host, with an optional delay before answering. */
function stubFetch(plan: Record<string, { ok: boolean; delayMs?: number }>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: { signal?: AbortSignal }) => {
    const url = String(input)
    const key = Object.keys(plan).find(base => url.startsWith(base))
    const entry = key === undefined ? undefined : plan[key]
    if (entry === undefined) throw new Error(`unexpected request: ${url}`)
    if (entry.delayMs !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, entry.delayMs)
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) })
      })
    }
    if (!entry.ok) throw new Error('network down')
    return new Response('{"version":"1.0.0"}', { status: 200 })
  }))
}

beforeEach(() => { vi.unstubAllGlobals() })
afterEach(() => { vi.unstubAllGlobals() })

describe('probeRegion', () => {
  it('stays global when the official registry answers first', async () => {
    // The case a time zone gets wrong: a mainland machine whose proxy makes
    // the official registry perfectly fast has no reason to be on mirrors.
    stubFetch({ [OFFICIAL]: { ok: true }, [MIRROR]: { ok: true, delayMs: 50 } })
    await expect(probeRegion(1000, {})).resolves.toBe('global')
  })

  it('switches to china when only the mirror answers', async () => {
    stubFetch({ [OFFICIAL]: { ok: false }, [MIRROR]: { ok: true } })
    await expect(probeRegion(1000, {})).resolves.toBe('china')
  })

  it('switches to china when the mirror answers first', async () => {
    stubFetch({ [OFFICIAL]: { ok: true, delayMs: 60 }, [MIRROR]: { ok: true } })
    await expect(probeRegion(1000, {})).resolves.toBe('china')
  })

  it('stays global when nothing answers at all', async () => {
    // An unreachable network is not evidence for changing routes. Sending a
    // fully offline machine to mirrors would be a guess dressed as a finding.
    stubFetch({ [OFFICIAL]: { ok: false }, [MIRROR]: { ok: false } })
    await expect(probeRegion(1000, {})).resolves.toBe('global')
  })

  it('stays global when everything is merely slow', async () => {
    stubFetch({ [OFFICIAL]: { ok: true, delayMs: 500 }, [MIRROR]: { ok: true, delayMs: 500 } })
    await expect(probeRegion(60, {})).resolves.toBe('global')
  })

  it('asks each region for the same small document, not the full packument', async () => {
    stubFetch({ [OFFICIAL]: { ok: true }, [MIRROR]: { ok: true, delayMs: 30 } })
    await probeRegion(1000, {})
    const calls = vi.mocked(globalThis.fetch).mock.calls.map(call => String(call[0]))
    expect(calls).toHaveLength(2)
    // `/latest` is a few KB; the bare package name is ~320KB. A probe that
    // downloads a third of a megabyte to answer "which is closer" has cost
    // more than the answer is worth.
    for (const url of calls) expect(url.endsWith('/dshmarket/latest')).toBe(true)
  })
})

describe('resolveRegion', () => {
  it('does not probe when a region is already on record', async () => {
    stubFetch({})
    await expect(resolveRegion('china', 1000, {})).resolves.toEqual({ region: 'china', probed: false })
    // A market that re-probes every boot can silently change routes between
    // runs, which makes "it was fast yesterday" impossible to investigate.
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled()
  })

  it('probes and reports that it did when nothing has decided one', async () => {
    stubFetch({ [OFFICIAL]: { ok: false }, [MIRROR]: { ok: true } })
    await expect(resolveRegion(undefined, 1000, {})).resolves.toEqual({ region: 'china', probed: true })
  })
})
