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
import { describeFetchFailure, forgetCatalog, loadRegistry } from '../src/registry.ts'
import { configuredProxy, marketFetch } from '../src/net.ts'

/**
 * undici stands in for the real outbound path. `marketFetch` routes through
 * EnvHttpProxyAgent only when a proxy is configured, and the assertion that
 * matters is exactly which proxy URLs the agent was built with —
 * npm_config_* is invisible to EnvHttpProxyAgent, so the explicit handoff
 * is what makes the npm fallback real instead of a name the failure message
 * claims was tried.
 */
const undici = vi.hoisted(() => ({
  fetch: vi.fn(async () => new Response('ok', { status: 200 })),
  EnvHttpProxyAgent: vi.fn(function (this: unknown, opts?: unknown) {
    return { opts }
  }),
}))

vi.mock('undici', () => ({
  fetch: undici.fetch,
  EnvHttpProxyAgent: undici.EnvHttpProxyAgent,
}))

const CATALOG = {
  updated: '2026-08-18',
  count: 1,
  categories: { tools: { en: 'Tools', zh: '工具' } },
  plugins: [{
    name: 'dsh-loop', owner: 'someone', url: 'https://example.com', category: 'tools',
    description: { en: 'a plugin' }, install: 'dsh-loop', added: '2026-01-01',
  }],
}

/** Every proxy variable — standard and npm's own config — so one test's environment cannot leak into another. */
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'npm_config_https_proxy', 'npm_config_proxy', 'npm_config_noproxy'] as const
let savedProxy: Record<string, string | undefined> = {}

beforeEach(() => {
  forgetCatalog()
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

/** Headers sent on each call, in order — what a conditional request needs. */
let sent: Array<Record<string, string>> = []

/** A fetch that plays the given script, one entry per call. */
function scriptedFetch(...answers: Array<Response | Error>): ReturnType<typeof vi.fn> {
  let call = 0
  sent = []
  const stub = vi.fn((_url: unknown, init?: { headers?: Record<string, string> }) => {
    sent.push({ ...init?.headers })
    const answer = answers[Math.min(call, answers.length - 1)]
    call += 1
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer.clone())
  })
  vi.stubGlobal('fetch', stub)
  return stub
}

/** A 200 carrying the validators the real origin serves. */
const okTagged = (body: unknown, etag: string | null, modified?: string): Response => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (etag !== null) headers.etag = etag
  if (modified !== undefined) headers['last-modified'] = modified
  return new Response(JSON.stringify(body), { status: 200, headers })
}

/** What the origin sends when nothing changed: a status and no body at all. */
const notModified = (): Response => new Response(null, { status: 304 })

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

  it('normalizes legacy and multi-value categories in declaration order', async () => {
    const catalog = {
      ...CATALOG,
      count: 2,
      categories: { tools: { en: 'Tools' }, skill: { en: 'Skills' } },
      plugins: [
        CATALOG.plugins[0],
        { ...CATALOG.plugins[0], name: 'dsh-skills', category: [null, 'skill', 'tools', 'skill'] },
      ],
    }
    scriptedFetch(ok(catalog))

    const registry = await loadRegistry()
    expect(registry.plugins.map(plugin => plugin.category)).toEqual([
      ['tools'],
      ['skill', 'tools'],
    ])
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

  it('refuses a plugin with no usable category', async () => {
    scriptedFetch(ok({
      ...CATALOG,
      plugins: [{ ...CATALOG.plugins[0], category: [null, '', 42] }],
    }))
    await expect(loadRegistry()).rejects.toThrow(/no usable category/)
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

describe('loadRegistry download regions', () => {
  /** A fetch that answers per-URL rather than per-call. */
  function byUrl(plan: Array<[RegExp, Response | Error]>): ReturnType<typeof vi.fn> {
    const stub = vi.fn((url: unknown) => {
      const entry = plan.find(([pattern]) => pattern.test(String(url)))
      if (entry === undefined) return Promise.reject(new Error(`unexpected request: ${String(url)}`))
      const answer = entry[1]
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer.clone())
    })
    vi.stubGlobal('fetch', stub)
    return stub
  }

  it('reads the catalog from the official domain in the global region', async () => {
    const stub = byUrl([[/awesome-dsh-plugin\.com/, ok(CATALOG)]])
    await loadRegistry('global')
    expect(String(stub.mock.calls[0]?.[0])).toContain('awesome-dsh-plugin.com')
  })

  it('asks the published package first in the china region', async () => {
    // It rides the same mirror as the plugins themselves, so it needs no
    // service that did not already have to work.
    const stub = byUrl([[/mirrors\.cloud\.tencent\.com/, new Error('fetch failed')], [/./, ok(CATALOG)]])
    await loadRegistry('china')
    expect(String(stub.mock.calls[0]?.[0])).toContain('mirrors.cloud.tencent.com')
    expect(String(stub.mock.calls[0]?.[0])).toContain('dsh-plugin-catalog')
  })

  it('walks the whole list rather than giving up at the first dead source', async () => {
    // The catalog is the FIRST request the market makes. A mirror going down
    // must mean a slow market, not an empty one.
    const stub = byUrl([
      [/mirrors\.cloud\.tencent\.com/, new Error('fetch failed')],
      [/awesome-dsh-plugin\.com/, ok(CATALOG)],
    ])
    const registry = await loadRegistry('china')
    expect(registry.plugins).toHaveLength(1)
    // Two attempts at the package, then the origin.
    expect(stub).toHaveBeenCalledTimes(3)
  })

  it('reports every attempt it made when the whole list fails', async () => {
    byUrl([[/./, new Error('fetch failed')]])
    await expect(loadRegistry('china')).rejects.toThrow(/4 attempts/)
  })

  it('never sends one origin the validator another one issued', async () => {
    // A validator is scoped to the URL that issued it. Carried across a
    // region switch it could earn a 304 from an origin whose body we have
    // never seen, and the market would render a catalog it never received.
    byUrl([[/awesome-dsh-plugin\.com/, okTagged(CATALOG, 'W/"one"')]])
    await loadRegistry('global')
    const stub = byUrl([
      [/mirrors\.cloud\.tencent\.com/, new Error('fetch failed')],
      [/awesome-dsh-plugin\.com/, ok(CATALOG)],
    ])
    await loadRegistry('china')
    const etagOf = (call: unknown[]): string | undefined =>
      ((call[1] ?? {}) as { headers?: Record<string, string> }).headers?.['if-none-match']
    // The package is a DIFFERENT source, so the origin's ETag must not ride
    // along on it — that is the request that could earn a "not modified"
    // from something whose body we have never seen.
    for (const call of stub.mock.calls.filter(c => String(c[0]).includes('mirrors.cloud.tencent.com'))) {
      expect(etagOf(call)).toBeUndefined()
    }
    // The origin, though, is the same URL in both regions. Re-sending the
    // validator it issued is exactly what it is for; withholding it would
    // re-download a megabyte to be told nothing changed.
    const originCall = stub.mock.calls.find(c => String(c[0]).includes('awesome-dsh-plugin.com'))
    expect(etagOf(originCall!)).toBe('W/"one"')
  })
})

describe('loadRegistry revalidation', () => {
  // Always ASK, never re-download what has not changed. This is not the
  // cache that was removed: that one skipped the request and answered from
  // memory, asserting freshness without checking. Here the origin confirms
  // it on every call — measured against the live one, 295 KB and 1.3s
  // unconditional against 0 bytes and 0.5s for a 304.

  it('asks unconditionally when it has nothing to revalidate', async () => {
    scriptedFetch(okTagged(CATALOG, 'W/"abc"'))
    await loadRegistry()
    expect(sent[0]).toEqual({})
  })

  it('offers the validator it was given, and reuses the body on 304', async () => {
    const stub = scriptedFetch(okTagged(CATALOG, 'W/"abc"'), notModified())
    const first = await loadRegistry()
    const second = await loadRegistry()

    expect(sent[1]?.['if-none-match']).toBe('W/"abc"')
    expect(stub).toHaveBeenCalledTimes(2) // the request still happens, every time
    expect(second).toEqual(first)
    expect(second.plugins).toHaveLength(1)
  })

  it('does NOT answer a network failure from what it last served', async () => {
    // The whole difference between revalidating and falling back. A 304 is
    // the origin saying "still current"; an unreachable origin has said
    // nothing at all, and handing back the last catalog there would rebuild
    // the snapshot this replaced — with the added cruelty of looking
    // perfectly healthy.
    scriptedFetch(okTagged(CATALOG, 'W/"abc"'))
    await loadRegistry()

    scriptedFetch(new Error('getaddrinfo ENOTFOUND awesome-dsh-plugin.com'))
    await expect(loadRegistry()).rejects.toThrow(/ENOTFOUND/)
  })

  it('takes the new catalog, and revalidates against the new tag next time', async () => {
    scriptedFetch(okTagged(CATALOG, 'W/"old"'))
    await loadRegistry()

    const grown = { ...CATALOG, plugins: [...CATALOG.plugins, { ...CATALOG.plugins[0]!, name: 'dsh-two' }] }
    scriptedFetch(okTagged(grown, 'W/"new"'), notModified())
    expect((await loadRegistry()).plugins).toHaveLength(2)
    expect(sent[0]?.['if-none-match']).toBe('W/"old"')

    // A validator that stuck at the old value would make the origin resend
    // the whole catalog forever — the saving would silently stop working.
    expect((await loadRegistry()).plugins).toHaveLength(2)
    expect(sent[1]?.['if-none-match']).toBe('W/"new"')
  })

  it('falls back to the date when the origin offers no ETag', async () => {
    scriptedFetch(okTagged(CATALOG, null, 'Tue, 18 Aug 2026 11:46:08 GMT'), notModified())
    await loadRegistry()
    await loadRegistry()
    expect(sent[1]).toEqual({ 'if-modified-since': 'Tue, 18 Aug 2026 11:46:08 GMT' })
  })

  it('sends only one validator, never both', async () => {
    // An origin given both must satisfy both. With a weak ETag — which is
    // exactly what this origin serves (`W/"6a844600-11111a"`) — that turns
    // a match into a full 200 and quietly undoes the saving.
    scriptedFetch(okTagged(CATALOG, 'W/"abc"', 'Tue, 18 Aug 2026 11:46:08 GMT'), notModified())
    await loadRegistry()
    await loadRegistry()
    expect(sent[1]).toEqual({ 'if-none-match': 'W/"abc"' })
  })

  it('treats a 304 it did not ask for as a failure', async () => {
    // Unreachable in practice, since a validator is what provokes one. It
    // would otherwise surface as a parse error on an empty body, which
    // names neither the cause nor anything the user could act on.
    scriptedFetch(notModified())
    await expect(loadRegistry()).rejects.toThrow(/nothing to revalidate/)
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
  it('prefers the https proxy, which is what governs the catalog', () => {
    process.env.HTTP_PROXY = 'http://three:3'
    expect(configuredProxy()).toBe('http://three:3')
    process.env.HTTPS_PROXY = 'http://two:2'
    expect(configuredProxy()).toBe('http://two:2')
  })

  // Windows environment variables are case-INSENSITIVE: `https_proxy` and
  // `HTTPS_PROXY` are one variable there, so the second assignment below is
  // not a second variable and there is no precedence left to observe. CI
  // caught this by failing on exactly that line — the distinction is real
  // on POSIX and absent on Windows, and a test cannot assert both.
  it.skipIf(process.platform === 'win32')('lets lowercase win, as undici does', () => {
    // Not the order that reads best — the order undici actually uses
    // (`https_proxy ?? HTTPS_PROXY`), since this answer is what the failure
    // message claims was tried. Verified against a real CONNECT listener,
    // not inferred: with both set, the lowercase one receives the connect.
    process.env.HTTPS_PROXY = 'http://upper:1'
    process.env.https_proxy = 'http://lower:2'
    expect(configuredProxy()).toBe('http://lower:2')
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

  it('defaults a scheme-less proxy to http', () => {
    // Windows proxy fields and npm config both commonly store host:port.
    // URL-based proxy agents require a scheme and otherwise throw before
    // the catalog request starts (#450).
    process.env.HTTPS_PROXY = '127.0.0.1:7890'
    expect(configuredProxy()).toBe('http://127.0.0.1:7890')
  })

  it('preserves an explicitly configured proxy scheme', () => {
    process.env.HTTPS_PROXY = 'socks5://proxy.corp.example:1080'
    expect(configuredProxy()).toBe('socks5://proxy.corp.example:1080')
  })

  it('uses npm_config_https_proxy when the standard variables are not set', () => {
    // The machine that reported this: its proxy was configured with
    // `npm config set proxy` (common on Windows), so it exists as
    // npm_config_* and nowhere else. Every npm-based tool works; the
    // catalog fetch still tried the direct route and timed out.
    process.env.npm_config_https_proxy = 'http://npm:1'
    expect(configuredProxy()).toBe('http://npm:1')
  })

  it('falls back to npm_config_proxy for the https catalog, as undici does', () => {
    // npm's https-proxy falls back to its plain proxy value; report the
    // proxy that is actually in use rather than "no proxy" while one is
    // plainly configured.
    process.env.npm_config_proxy = 'http://npm:2'
    expect(configuredProxy()).toBe('http://npm:2')
  })

  it('prefers a standard proxy over npm config', () => {
    // npm_config_* is a fallback source, never an override: a process
    // whose environment carries http_proxy has decided, and the market
    // must not second-guess it with the machine's npm config.
    process.env.HTTPS_PROXY = 'http://std:1'
    process.env.npm_config_https_proxy = 'http://npm:1'
    expect(configuredProxy()).toBe('http://std:1')
  })

  it('treats empty npm proxy values as unset, like the standard ones', () => {
    process.env.npm_config_https_proxy = ''
    process.env.npm_config_proxy = ''
    expect(configuredProxy()).toBeNull()
  })
})

describe('marketFetch', () => {
  beforeEach(() => {
    undici.fetch.mockClear()
    undici.EnvHttpProxyAgent.mockClear()
  })

  it('hands npm-config proxies to the agent explicitly — EnvHttpProxyAgent cannot see them', async () => {
    // The trap this guards: configuredProxy() alone would make the failure
    // message claim a proxy was tried while `new EnvHttpProxyAgent()` with
    // no arguments still reads only http(s)_proxy and goes direct.
    process.env.npm_config_https_proxy = 'proxy.corp.example:8080'
    await marketFetch('https://catalog.example/plugins.json')
    expect(undici.EnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: undefined,
      httpsProxy: 'http://proxy.corp.example:8080',
    })
    expect(undici.fetch).toHaveBeenCalledWith(
      'https://catalog.example/plugins.json',
      expect.objectContaining({ dispatcher: expect.any(Object) }),
    )
  })

  it('stays on the global fetch when there is no proxy anywhere', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))
    await marketFetch('https://catalog.example/plugins.json')
    expect(undici.fetch).not.toHaveBeenCalled()
  })
})
