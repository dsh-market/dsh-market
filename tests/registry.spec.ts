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
import { describeFetchFailure, forgetCatalog, loadRegistry, pluginPreviousNpm } from '../src/registry.ts'
import { exportLogs } from '../src/log.ts'
import { configuredProxy, marketFetch } from '../src/net.ts'

/**
 * undici stands in for the real outbound path. Every `marketFetch` goes
 * through it with an explicit dispatcher (#742): `EnvHttpProxyAgent` when a
 * proxy is configured, a plain `Agent` otherwise. The assertion that matters
 * for a proxy is exactly which URLs the agent was built with — npm_config_*
 * is invisible to EnvHttpProxyAgent, so the explicit handoff is what makes
 * the npm fallback real instead of a name the failure message claims was
 * tried. `fetch` forwards to the global stub when one is installed, so the
 * catalog script below still observes the request.
 */
const undici = vi.hoisted(() => ({
  fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (vi.isMockFunction(globalThis.fetch)) return globalThis.fetch(input, init)
    return new Response('ok', { status: 200 })
  }),
  EnvHttpProxyAgent: vi.fn(function (this: unknown, opts?: unknown) {
    return { opts }
  }),
  Agent: vi.fn(function (this: unknown) {
    return { direct: true }
  }),
}))

vi.mock('undici', () => ({
  fetch: undici.fetch,
  EnvHttpProxyAgent: undici.EnvHttpProxyAgent,
  Agent: undici.Agent,
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
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes through source download dates without inventing them for legacy entries', async () => {
    const stats = { downloads: 42, downloadsStart: '2026-08-25', downloadsEnd: '2026-09-23', downloadsCheckedAt: '2026-09-24' }
    scriptedFetch(ok({
      ...CATALOG,
      count: 2,
      plugins: [{ ...CATALOG.plugins[0], ...stats }, { ...CATALOG.plugins[0], name: 'legacy', downloads: 0 }],
    }))
    const registry = await loadRegistry()
    expect(registry.plugins[0]).toMatchObject(stats)
    expect(registry.plugins[1]).not.toHaveProperty('downloadsStart')
    expect(registry.plugins[1]).not.toHaveProperty('downloadsEnd')
    expect(registry.plugins[1]).not.toHaveProperty('downloadsCheckedAt')
    expect(registry.plugins[1]?.downloads).toBe(0)
  })

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

  it('gives up after the second attempt at each source rather than hammering', async () => {
    // Two sources in the global region's list, two attempts each (#891's
    // package rides the region's own registry, so the region whose own
    // sources work never reaches it — but a dead network reaches it twice).
    const stub = scriptedFetch(new Error('fetch failed'))
    await expect(loadRegistry()).rejects.toThrow(/fetch failed/)
    expect(stub).toHaveBeenCalledTimes(4)
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
    await expect(loadRegistry()).rejects.toThrow(/aborted due to timeout.*\ds, 4 attempts/s)
  })

  /**
   * A successful load used to leave nothing behind, which is what made a slow
   * one impossible to report. #1181 measured thirteen, twenty and forty
   * seconds on the same machine, five minutes on the run that failed, and
   * every export said the buffer starts empty. The line has to be there when
   * it is slow, and absent when it is not — a log that fires on every entry
   * into the market is worse than one that fires on none.
   */
  it('leaves a line when a successful load crossed the slow threshold', async () => {
    scriptedFetch(ok(CATALOG))
    const clock = vi.spyOn(Date, 'now')
    const started = 1_760_000_000_000
    clock.mockReturnValueOnce(started)
    clock.mockReturnValue(started + 6_100)
    await loadRegistry('global')
    expect(exportLogs({})).toContain('answered in 6.1s')
  })

  it('says nothing when the catalog arrives quickly', async () => {
    scriptedFetch(ok(CATALOG))
    const clock = vi.spyOn(Date, 'now')
    const started = 1_760_000_000_000
    clock.mockReturnValueOnce(started)
    clock.mockReturnValue(started + 900)
    // "Says nothing" has to mean "adds nothing", not "adds no line saying
    // 0.9s": the buffer is shared by the whole file, so a slower neighbour's
    // line is still in the export here, and matching on one duration would
    // also accept any other duration the quick path might start printing.
    const before = exportLogs({})
    await loadRegistry('global')
    expect(exportLogs({})).toBe(before)
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
      // The second mirror is dead too — the state #1051 reported: one refused
      // mirror left the origin as the only other host.
      [/registry\.npmmirror\.com/, new Error('fetch failed')],
      [/awesome-dsh-plugin\.com/, ok(CATALOG)],
    ])
    const registry = await loadRegistry('china')
    expect(registry.plugins).toHaveLength(1)
    // Two attempts at each mirror, then the origin.
    expect(stub).toHaveBeenCalledTimes(5)
  })

  it('reports every attempt it made when the whole list fails', async () => {
    byUrl([[/./, new Error('fetch failed')]])
    await expect(loadRegistry('china')).rejects.toThrow(/6 attempts/)
  })

  it('stops at its own region when that region answers (#891)', async () => {
    // The cross-region list is a fallback, not a second opinion: a network
    // where the official domain works must not also fetch a mirror.
    const stub = byUrl([[/awesome-dsh-plugin\.com/, ok(CATALOG)]])
    await loadRegistry('global')
    expect(stub).toHaveBeenCalledTimes(1)
  })

  it('reads on past its own region when every one of its sources is dead (#891)', async () => {
    // The probe that picks a region measures the npm REGISTRY, and the
    // catalog hangs off a second, independently blockable host. So "npm fast,
    // GitHub Pages blocked" — the exact shape the mainland route exists for —
    // measures `global`, whose only source is that host; and because the
    // region is decided once and persisted, nothing ever reconsiders. The
    // catalog's published package is the route that still works.
    const stub = byUrl([[/./, new Error('fetch failed')]])
    await expect(loadRegistry('global')).rejects.toThrow(/4 attempts/)
    const asked = stub.mock.calls.map(call => String(call[0]))
    // The origin twice (global's only own source), then the catalog's
    // published package on the registry the probe measured, twice — and the
    // failure message names it, so the route actually tried is the one a
    // report will show.
    expect(asked[0]).toContain('awesome-dsh-plugin.com')
    expect(asked[2]).toContain('registry.npmjs.org')
    expect(asked[2]).toContain('dsh-plugin-catalog')
  })

  it('says in the log that a configured mirror failed, even when a later source answers (#1117)', async () => {
    // The list is a fallback chain: the first two mirrors are dead, the
    // official host answers, and the market looks perfectly normal. Nothing
    // on screen can show that the mirror this person configured never
    // worked — so the log has to.
    byUrl([
      [/mirrors\.cloud\.tencent\.com/, new Error('getaddrinfo ENOTFOUND mirrors.cloud.tencent.com')],
      [/registry\.npmmirror\.com/, new Error('fetch failed')],
      [/awesome-dsh-plugin\.com/, ok(CATALOG)],
    ])
    const log = await import('../src/log.ts')
    const spy = vi.spyOn(log, 'logEvent').mockImplementation(() => undefined)
    try {
      expect((await loadRegistry('china')).plugins).toHaveLength(1)
      const lines = spy.mock.calls.map(([level, event, detail]) => `${String(level)} ${String(event)} ${String(detail)}`)
      expect(lines.some(line => line.startsWith('warn registry')
        && line.includes('mirrors.cloud.tencent.com')
        && line.includes('reading from a later source'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('stays quiet when the retry is what saved the source (#1117)', async () => {
    // One failure followed by a success on the same source is the retry
    // doing its job. Logging that would put a warning in every imported log.
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(() => {
      calls += 1
      return calls === 1 ? Promise.reject(new Error('fetch failed')) : Promise.resolve(ok(CATALOG).clone())
    }))
    const log = await import('../src/log.ts')
    const spy = vi.spyOn(log, 'logEvent').mockImplementation(() => undefined)
    try {
      expect((await loadRegistry('global')).plugins).toHaveLength(1)
      const lines = spy.mock.calls.map(([level, event, detail]) => `${String(level)} ${String(event)} ${String(detail)}`)
      expect(lines.some(line => line.includes('reading from a later source'))).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps the primary source\'s own reason instead of the fallback\'s (#750)', async () => {
    // The report: the primary was failing for a reason worth acting on (DNS,
    // refusal, 404) while the fallback timed out, and the message named only
    // the timeout — the one failure the user cannot act on, from a mirror they
    // never chose. Which source said what IS the diagnosis, so every failed
    // source has to appear in it.
    byUrl([
      [/mirrors\.cloud\.tencent\.com/, new Error('getaddrinfo ENOTFOUND mirrors.cloud.tencent.com')],
      [/awesome-dsh-plugin\.com/, new Error('no new data for 15s while downloading the catalog (received 4096 bytes)')],
    ])
    const message = await loadRegistry('china').then(
      () => { throw new Error('expected the whole list to fail') },
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    // The last failure keeps the leading slot (that is what the client shows),
    // and the primary's reason is in there too, not discarded.
    expect(message).toContain('no new data for 15s while downloading the catalog')
    expect(message).toContain('earlier:')
    expect(message).toContain('getaddrinfo ENOTFOUND mirrors.cloud.tencent.com')
    expect(message.indexOf('earlier:')).toBeLessThan(message.indexOf('getaddrinfo ENOTFOUND'))
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
    undici.Agent.mockClear()
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

  it('tries straight through when a LOOPBACK proxy refuses the host (#1042)', async () => {
    // The report: the Desktop host runs a proxy on 127.0.0.1 whose port
    // changes every session, allows only its own list of hosts, and answers
    // 403 to any CONNECT for the catalog's domain — while `curl` straight to
    // the same URL worked. A proxy on loopback is on this machine, so the
    // same request may simply be repeated without it.
    process.env.https_proxy = 'http://127.0.0.1:50007'
    undici.fetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const res = await marketFetch('https://awesome-dsh-plugin.com/plugins.json')

    expect(await res.text()).toBe('ok')
    expect(undici.fetch).toHaveBeenCalledTimes(2)
    expect((undici.fetch.mock.calls[1]?.[1] as { dispatcher?: unknown }).dispatcher).toEqual({ direct: true })
  })

  it('never goes around a proxy that is not on this machine', async () => {
    // A proxy elsewhere was configured on purpose; repeating the request
    // directly could put it outside the network that person is meant to be
    // on. The failure has to be reported as it always was.
    process.env.https_proxy = 'http://proxy.corp.example:8080'
    undici.fetch.mockRejectedValueOnce(new TypeError('fetch failed'))

    await expect(marketFetch('https://catalog.example/plugins.json')).rejects.toThrow('fetch failed')

    expect(undici.fetch).toHaveBeenCalledTimes(1)
  })

  it('uses its own dispatcher when no proxy is configured (#742)', async () => {
    // Node 22's global fetch shares a dispatcher symbol with undici 8. After
    // the host's first web_fetch import, that symbol points at a wrapper the
    // builtin fetch cannot decompress, so a direct catalog read comes back
    // as gzip. Carrying an Agent this module created is what keeps the body
    // decoded; calling global fetch, or undici's fetch with no dispatcher,
    // both fail. The agent is reused, so a second call does not build another.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))
    await marketFetch('https://catalog.example/plugins.json')
    await marketFetch('https://catalog.example/plugins.json')
    expect(undici.EnvHttpProxyAgent).not.toHaveBeenCalled()
    const calls = undici.fetch.mock.calls
    expect(calls).toHaveLength(2)
    const first = calls[0]?.[1] as { dispatcher?: unknown } | undefined
    const second = calls[1]?.[1] as { dispatcher?: unknown } | undefined
    expect(first?.dispatcher).toEqual({ direct: true })
    expect(second?.dispatcher).toBe(first?.dispatcher)
  })
})

describe('loadRegistry body deadlines (the catalog outgrew a total one)', () => {
  // The catalog is not the 295 KB file the 15s budget was sized for any
  // more: it passed 5 MB in September 2026, and on an ordinary slow but
  // healthy path (measured ~60 KB/s against 1.22 MB gzipped) the first
  // fetch needs on the order of 90s. A total deadline of 15s, tried twice,
  // makes that first fetch impossible — the market never opens (#188,
  // #750 both measured the same wall from their regions). The two guards
  // below pin the split that fixes it: the server must START answering
  // fast, and after that only silence — not duration — ends the read.
  //
  // Fake timers drive both the chunk schedule and the watchdogs, so no
  // test here waits real seconds. The real-time counterpart of this
  // evidence lives in the linked issue: 15s total budget aborts a flowing
  // body at 15005ms; the same link finishes in 89.9s when allowed to.

  /** A body whose pieces arrive at scripted moments of fake time. */
  const jsonStream = (schedule: Array<{ at: number, piece: string }>): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const { at, piece } of schedule) {
          setTimeout(() => {
            // A reader that gave up cancels the stream; pieces still on the
            // script have nowhere to go and are dropped, not thrown.
            try { controller.enqueue(new TextEncoder().encode(piece)) } catch { /* reader is gone */ }
          }, at)
        }
        const last = schedule[schedule.length - 1]?.at ?? 0
        setTimeout(() => {
          try { controller.close() } catch { /* cancelled already */ }
        }, last + 1)
      },
    })

  /** A body that says one thing and then never speaks again. */
  const stalledStream = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"plugins":')) },
    })

  const streamingOk = (body: ReadableStream<Uint8Array>): Response =>
    new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })

  it('keeps reading a slow body that never stalls, past the old 15s total budget', async () => {
    vi.useFakeTimers()
    try {
      const full = JSON.stringify(CATALOG)
      const piece = Math.ceil(full.length / 20)
      const schedule = Array.from({ length: 20 }, (_, i) => ({
        at: i * 1_000,
        piece: full.slice(i * piece, (i + 1) * piece),
      }))
      scriptedFetch(streamingOk(jsonStream(schedule)))
      const pending = loadRegistry()
      // Chunks land at t=0..19s and the body closes at t=20s: still
      // arriving at t=15s, where the old total budget used to cut it off.
      await vi.advanceTimersByTimeAsync(25_000)
      const registry = await pending
      expect(registry.plugins).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  }, 10_000)

  it('ends a body that goes silent and says so, on every attempt', async () => {
    vi.useFakeTimers()
    try {
      // The origin's two attempts carry the stalled body; the catalog
      // package's two fail on the metadata request that comes before any
      // body, which is a different watchdog's business (#891).
      scriptedFetch(streamingOk(stalledStream()), streamingOk(stalledStream()),
        new Error('fetch failed'), new Error('fetch failed'))
      // Handler first: the rejection lands while the clock is being advanced,
      // and a promise that rejects before anyone is listening takes the whole
      // run down as an unhandled rejection even though the test then passes.
      const rejection = expect(loadRegistry()).rejects.toThrow(/no new data for 15s while downloading the catalog/)
      // One chunk at t=0, then nothing. Silence — not slowness — is what
      // the body deadline is for, and both attempts must end in it.
      await vi.advanceTimersByTimeAsync(33_000)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  }, 8_000)

  it('refuses a body larger than any catalog instead of buffering it all', async () => {
    // 256 MB is the cap the source ships with (MAX_CATALOG_BODY_BYTES).
    // Both places say the number out loud, so resizing one shows the other
    // in review. Before the cap, a firehose mirror was buffered whole,
    // decoded, and died in JSON.parse behind a message about parsing.
    const flood = new Uint8Array(256 * 1024 * 1024 + 1024)
    const firehose = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(flood); controller.close() },
    })
    scriptedFetch(streamingOk(firehose))
    await expect(loadRegistry()).rejects.toThrow(/the catalog response grew past 256 MB/)
  }, 20_000)

  it('ends a body that trickles forever at a 10-minute ceiling, not the stall watchdog', async () => {
    vi.useFakeTimers()
    try {
      // One byte inside every 15s stall window keeps the watchdog quiet
      // forever; without a total ceiling neither this read nor this test
      // would end. Each attempt gets its own trickle, built the moment
      // that attempt starts, so every one is cut by the ceiling at its
      // own 10-minute mark — a scripted replay of one shared body would
      // instead hand the later attempts a fully buffered, parseable copy.
      // The last two bytes land after the ceiling fires; the point is
      // that progress alone cannot save it.
      const schedule = Array.from({ length: 45 }, (_, i) => ({ at: i * 14_000, piece: 'a' }))
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(streamingOk(jsonStream(schedule)))))
      const rejection = expect(loadRegistry()).rejects.toThrow(/did not finish within 600s \(received 43 bytes\)/)
      // Advancing far past the last ceiling is free on fake time and
      // covers however many attempts the retry loop makes.
      await vi.advanceTimersByTimeAsync(5_000_000)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  }, 8_000)

  it('says the response carried no body instead of failing to parse one', async () => {
    scriptedFetch(new Response(null, { status: 200, headers: { 'content-type': 'application/json' } }))
    // Before the guard an empty body surfaced as "Unexpected end of JSON
    // input" — a parse error that told the user nothing about the network.
    await expect(loadRegistry()).rejects.toThrow(/the catalog response carried no body/)
  })
})

describe('pluginPreviousNpm (#1012 P1)', () => {
  it('keeps valid former names and drops anything the runtime cannot trust', async () => {
    expect(pluginPreviousNpm({ name: 'evo', npm: 'dsh-evo-subagent', previousNpm: ['evo-subagent-old', '@scope/legacy'] }))
      .toEqual(['evo-subagent-old', '@scope/legacy'])
  })

  it('drops the entry itself, invalid names and duplicates', async () => {
    expect(pluginPreviousNpm({
      name: 'evo',
      npm: 'dsh-evo-subagent',
      previousNpm: ['EVO', 'dsh-evo-subagent', 'not a name', '', 'old', 'OLD'],
    })).toEqual(['old'])
  })

  it('treats an absent or malformed declaration exactly like no declaration', async () => {
    expect(pluginPreviousNpm({ name: 'evo', npm: 'evo' })).toEqual([])
    expect(pluginPreviousNpm({ name: 'evo', npm: 'evo', previousNpm: 'old' })).toEqual(['old'])
    expect(pluginPreviousNpm({ name: 'evo', npm: 'evo', previousNpm: [] })).toEqual([])
  })
})

