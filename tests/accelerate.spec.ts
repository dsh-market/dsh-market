/**
 * Rewriting a GitHub install target onto a region's mirror.
 *
 * Every assertion here is about a way the rewrite must NOT happen, because
 * that is where the risk is. A rewrite that loses the commit pin installs
 * fine and then reports no version forever; a rewrite applied to a subpath
 * entry would install the wrong package outright; and a rewrite that can
 * fail an install has turned an optimisation into a bug.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acceleratedTarget } from '../src/accelerate.ts'

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

beforeEach(() => { vi.unstubAllGlobals() })
afterEach(() => { vi.unstubAllGlobals() })

describe('acceleratedTarget', () => {
  it('leaves everything alone in a region with no mirror', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('should not be called') }))
    await expect(acceleratedTarget('github:o/r', 'global', {})).resolves.toBe('github:o/r')
  })

  it('rewrites a bare repo to a commit-pinned tarball on the mirror', async () => {
    stubResolve('refs')
    await expect(acceleratedTarget('github:o/r', 'china', CHINA)).resolves
      .toBe(`https://gh.test/https://codeload.github.com/o/r/tar.gz/${SHA}`)
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
})
