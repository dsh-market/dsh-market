/**
 * Pinning a GitHub install target after resolving HEAD through a region's mirror.
 *
 * Every assertion here is about a way the rewrite must NOT happen, because
 * that is where the risk is. A rewrite that loses the commit pin installs
 * fine and then reports no version forever; a rewrite applied to a subpath
 * entry would install the wrong package outright; and a prefix-proxied
 * tarball is no longer recognized as git-hosted by pnpm 11, so its missing
 * integrity field makes the profile fail closed (#385).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acceleratedTarget, resolveHeadCommit } from '../src/accelerate.ts'
import { resetGithubRoutePreferences } from '../src/regions.ts'

const SHA = 'b0e6c57ebeeb4796017864f5cd5c66e6ba0899ec'
const CHINA = { DSHM_GITHUB_PROXY: 'https://gh.test' }

/** A realistic git ref advertisement: pkt-line framing around the refs. */
function refAdvertisement(sha: string): string {
  return '001e# service=git-upload-pack\n0000'
    + `0155${sha} HEAD\0multi_ack thin-pack side-band side-band-64k ofs-delta\n`
    + `003f${sha} refs/heads/main\n0000`
}

/** Stub the SHA lookup with a given outcome. */
function stubResolve(outcome: 'refs' | 'http-error' | 'throw' | 'garbage'): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input)
    // The lookup travels the proxy too — resolving the commit against an
    // origin the user cannot reach would defeat the whole exercise. It is
    // git's ref advertisement rather than the REST API, because the API
    // through this proxy rate-limits (measured: 200, 200, 403) and would
    // silently drop installs back to the slow route.
    expect(url.startsWith('https://gh.test/https://github.com/')).toBe(true)
    expect(url).toContain('info/refs?service=git-upload-pack')
    if (outcome === 'throw') throw new Error('network down')
    if (outcome === 'http-error') return new Response('nope', { status: 502 })
    if (outcome === 'garbage') return new Response('<html>proxy error</html>', { status: 200 })
    return new Response(refAdvertisement(SHA), { status: 200 })
  }))
}

beforeEach(() => { vi.unstubAllGlobals(); resetGithubRoutePreferences() })
afterEach(() => { vi.unstubAllGlobals(); resetGithubRoutePreferences(); vi.useRealTimers() })

describe('acceleratedTarget', () => {
  it('leaves everything alone in a region with no mirror', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('should not be called') }))
    await expect(acceleratedTarget('github:o/r', 'global', {})).resolves.toBe('github:o/r')
  })

  it('uses the mirror to resolve HEAD but keeps pnpm on an integrity-safe github target (#385)', async () => {
    stubResolve('refs')
    await expect(acceleratedTarget('github:o/r', 'china', CHINA)).resolves
      .toBe(`github:o/r#${SHA}`)
  })

  it('picks HEAD out of the advertisement, not the first sha it sees', async () => {
    // The payload carries the same sha twice here, but a repo whose default
    // branch is not the first ref would list a different one first — reading
    // position rather than the HEAD marker would pin the wrong commit.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `001e# service=git-upload-pack\n0000003f${'a'.repeat(40)} refs/heads/other\n`
      + `0155${SHA} HEAD\0multi_ack\n0000`,
      { status: 200 },
    )))
    await expect(acceleratedTarget('github:o/r', 'china', CHINA)).resolves.toContain(SHA)
  })

  it('never rewrites a subpath entry', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('should not be called') }))
    // A tarball URL has nowhere to say "only this directory". Rewriting one
    // of these would install the whole repo under the subpackage's name.
    await expect(acceleratedTarget('github:o/r#path:/packages/x', 'china', CHINA)).resolves
      .toBe('github:o/r#path:/packages/x')
  })

  it('never rewrites an npm target', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('should not be called') }))
    await expect(acceleratedTarget('dsh-loop', 'china', CHINA)).resolves.toBe('dsh-loop')
    await expect(acceleratedTarget('@scope/pkg', 'china', CHINA)).resolves.toBe('@scope/pkg')
  })

  for (const outcome of ['http-error', 'throw', 'garbage'] as const) {
    it(`falls back to the direct target when the lookup ${outcome}s`, async () => {
      // Acceleration is an optimisation. An optimisation that can fail an
      // install is a bug, so every failure path ends at the original spec.
      stubResolve(outcome)
      await expect(acceleratedTarget('github:o/r', 'china', CHINA)).resolves.toBe('github:o/r')
    })
  }

  it('refuses a short or non-hex ref rather than installing an unpinned tarball', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('001e# service=git-upload-pack\n0000b0e6c57 HEAD\0\n0000', { status: 200 })))
    // The lockfile reader matches exactly 40 hex characters. Anything else
    // would install and then report no version for the life of the plugin.
    await expect(acceleratedTarget('github:o/r', 'china', CHINA)).resolves.toBe('github:o/r')
  })

  it('falls through transport errors and 200 HTML pages to the next service route', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      seen.push(url)
      if (url.startsWith('https://github.com/')) throw new Error('direct blocked')
      if (url.startsWith('https://gh-proxy.com/')) {
        return new Response('<!doctype html><title>temporary proxy error</title>', {
          status: 200, headers: { 'content-type': 'text/html' },
        })
      }
      return new Response(refAdvertisement(SHA), { status: 200 })
    }))

    await expect(resolveHeadCommit('o/r', 'china', {})).resolves.toBe(SHA)
    expect(seen.map(url => url.split('/https://')[0])).toEqual([
      'https://github.com/o/r/info/refs?service=git-upload-pack',
      'https://gh-proxy.com',
      'https://ghfast.top',
    ])
  })

  it('remembers a successful git route, but stops on a valid advertisement missing the requested ref', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      seen.push(url)
      if (!url.startsWith('https://ghfast.top/')) throw new Error('unavailable')
      return new Response(refAdvertisement(SHA), { status: 200 })
    }))
    await expect(resolveHeadCommit('o/r', 'china', {})).resolves.toBe(SHA)
    seen.length = 0
    await expect(resolveHeadCommit('o/r', 'china', {}, 'does-not-exist')).resolves.toBeNull()
    // The last successful route is tried first. Its payload is a valid ref
    // advertisement, so an absent branch is an authoritative miss rather
    // than a reason to ask mirrors for a different answer.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^https:\/\/ghfast\.top\//)
  })

  it('gives each candidate its own timeout so one hung route cannot consume every fallback', async () => {
    vi.useFakeTimers()
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input)
      seen.push(url)
      if (seen.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
        })
      }
      return Promise.resolve(new Response(refAdvertisement(SHA), { status: 200 }))
    }))

    const pending = resolveHeadCommit('o/r', 'china', {})
    await vi.advanceTimersByTimeAsync(6000)
    await expect(pending).resolves.toBe(SHA)
    expect(seen).toHaveLength(2)
  })
})
