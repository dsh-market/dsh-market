/**
 * The REAL registry module and the outbound-HTTP helper under it.
 *
 * Everywhere else in the suite `loadRegistry` is mocked — which is right for
 * the route specs and useless here, because the whole of this change lives
 * in what the real function does when the network misbehaves. The catalog
 * lost its in-memory cache and its bundled snapshot in this version, so the
 * fetch path is no longer one source among three: it is the only one, and a
 * failure of it is now visible to the user instead of being papered over.
 *
 * `fetch` is stubbed rather than a server being started: the point of every
 * assertion below is which call is made and what is done with the answer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeFetchFailure, loadRegistry } from '../src/registry.ts'
import { configuredProxy } from '../src/net.ts'

const CATALOG = {
  updated: '2026-08-18',
  count: 1,
  categories: { tools: { en: 'Tools', zh: '工具' } },
  plugins: [{
    name: 'dsh-loop', owner: 'someone', url: 'https://example.com', category: 'tools',
    description: { en: 'a plugin' }, install: 'dsh-loop', added: '2026-01-01',
  }],
}

/** Every proxy variable, so one test's environment cannot leak into another. */
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const
let savedProxy: Record<string, string | undefined> = {}

beforeEach(() => {
  savedProxy = {}
  for (const key of PROXY_VARS) {
    savedProxy[key] = process.env[key]
    delete process.env[key]
  }
})
afterEach(() => {
  for (const key of PROXY_VARS) {
    if (savedProxy[key] === undefined) delete process.env[key]
    else process.env[key] = savedProxy[key]
  }
  vi.unstubAllGlobals()
})

/** A fetch that plays the given script, one entry per call. */
function scriptedFetch(...answers: Array<Response | Error>): ReturnType<typeof vi.fn> {
  let call = 0
  const stub = vi.fn(() => {
    const answer = answers[Math.min(call, answers.length - 1)]
    call += 1
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer.clone())
  })
  vi.stubGlobal('fetch', stub)
  return stub
}

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('loadRegistry', () => {
  it('goes to the network every single time it is asked', async () => {
    // The one-hour cache is gone deliberately. The catalog grows by roughly
    // 250 entries a day, so an hour-old listing answers "does this plugin
    // exist" wrongly — and did so while looking identical to a live one.
    const stub = scriptedFetch(ok(CATALOG))
    await loadRegistry()
    await loadRegistry()
    await loadRegistry()
    expect(stub).toHaveBeenCalledTimes(3)
  })

  it('retries once before giving up', async () => {
    const stub = scriptedFetch(new Error('fetch failed'), ok(CATALOG))
    const registry = await loadRegistry()
    expect(registry.plugins).toHaveLength(1)
    expect(stub).toHaveBeenCalledTimes(2)
  })

  it('gives up after the second attempt rather than hammering', async () => {
    const stub = scriptedFetch(new Error('fetch failed'))
    await expect(loadRegistry()).rejects.toThrow(/fetch failed/)
    expect(stub).toHaveBeenCalledTimes(2)
  })

  it('reports a failure instead of answering with an empty catalog', async () => {
    // The bundled snapshot used to answer here. Its absence is the feature:
    // a market showing zero plugins and a market that could not reach the
    // registry are different situations, and only one of them is the user's
    // to act on. Silence would report the wrong one.
    scriptedFetch(new Error('getaddrinfo ENOTFOUND awesome-dsh-plugin.com'))
    await expect(loadRegistry()).rejects.toThrow(/ENOTFOUND/)
  })

  it('treats a non-2xx answer as a failure, not as a catalog', async () => {
    scriptedFetch(new Response('<html>502 Bad Gateway</html>', { status: 502 }))
    await expect(loadRegistry()).rejects.toThrow(/HTTP 502/)
  })

  it('refuses a well-formed response with no plugins in it', async () => {
    // A CDN serving a truncated or placeholder file parses fine. Accepting
    // it would replace the catalog with nothing and call that success.
    scriptedFetch(ok({ ...CATALOG, plugins: [] }))
    await expect(loadRegistry()).rejects.toThrow(/came back empty/)
  })

  it('carries the reason, the elapsed time and the attempt count', async () => {
    // This string is the whole of what a bug report will contain: it is what
    // the market puts on screen and what the log export ships. "The
    // operation was aborted due to timeout" on its own — the exact text a
    // reporter sent us — cannot tell a slow link from a blocked one.
    scriptedFetch(new Error('The operation was aborted due to timeout'))
    await expect(loadRegistry()).rejects.toThrow(/aborted due to timeout.*\ds, 2 attempts/s)
  })
})

describe('describeFetchFailure', () => {
  it('names the proxy it went through, because that is the surprising part', () => {
    // Node's global fetch ignores HTTP_PROXY entirely, so before this
    // version a machine whose only route out was a proxy failed here every
    // time while every other tool on it worked. Whether the proxy was used
    // is the first thing anyone needs to know from the message.
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7897'
    expect(describeFetchFailure(new Error('timeout'), 15_000))
      .toBe('timeout (15s, 2 attempts) · tried through the configured proxy http://127.0.0.1:7897')
  })

  it('says nothing about a proxy when there is none', () => {
    expect(describeFetchFailure(new Error('timeout'), 3000)).toBe('timeout (3s, 2 attempts)')
  })

  it('redacts credentials embedded in the proxy URL', () => {
    // Users paste this message into issues. A corporate proxy URL routinely
    // carries a domain login, and it would go straight into a public tracker.
    process.env.HTTPS_PROXY = 'http://alice:hunter2@proxy.corp.example:8080'
    const message = describeFetchFailure(new Error('ECONNREFUSED'), 1000)
    expect(message).toContain('//***@proxy.corp.example:8080')
    expect(message).not.toContain('hunter2')
    expect(message).not.toContain('alice')
  })

  it('survives something thrown that is not an Error', () => {
    expect(describeFetchFailure('just a string', 0)).toBe('just a string (0s, 2 attempts)')
  })
})

describe('configuredProxy', () => {
  it('resolves exactly the way EnvHttpProxyAgent does', () => {
    // Not the order that reads best — the order undici actually uses, since
    // this answer is what the failure message claims was tried. undici
    // reads `https_proxy ?? HTTPS_PROXY`, so LOWERCASE wins; asserting the
    // intuitive opposite would only have restated our own code.
    process.env.http_proxy = 'http://four:4'
    process.env.HTTP_PROXY = 'http://three:3'
    expect(configuredProxy()).toBe('http://four:4')
    process.env.HTTPS_PROXY = 'http://two:2'
    expect(configuredProxy()).toBe('http://two:2')
    process.env.https_proxy = 'http://one:1'
    expect(configuredProxy()).toBe('http://one:1')
  })

  it('falls back to the http proxy for the https catalog, as undici does', () => {
    // `this[kHttpsProxyAgent] = this[kHttpProxyAgent]` when no https proxy
    // is set. Reporting "no proxy" here would be wrong: one is in use.
    process.env.HTTP_PROXY = 'http://three:3'
    expect(configuredProxy()).toBe('http://three:3')
  })

  it('treats an empty value as unset instead of masking the http proxy', () => {
    // `export HTTPS_PROXY=` is how people turn a proxy off, and undici's
    // truthiness test falls through to HTTP_PROXY. A `??` chain does not —
    // it stops at the first DEFINED value and answers "no proxy" while one
    // is plainly configured.
    process.env.HTTPS_PROXY = ''
    process.env.HTTP_PROXY = 'http://real:1'
    expect(configuredProxy()).toBe('http://real:1')
  })

  it('treats a whitespace-only value as unset', () => {
    // Wider than undici on purpose: it would pass '   ' to `new URL()` and
    // throw out of the agent constructor, taking down a fetch that has
    // nothing wrong with it.
    process.env.HTTPS_PROXY = '   '
    expect(configuredProxy()).toBeNull()
  })

  it('trims a stray newline, which a shell heredoc leaves behind', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7897\n'
    expect(configuredProxy()).toBe('http://127.0.0.1:7897')
  })
})
