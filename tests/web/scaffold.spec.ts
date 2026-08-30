import type { Page } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import {
  createStartupOutputCapture,
  exchangeProcessLaunchToken,
  openMarketPage,
  processLaunchUrlFromOutput,
  redactAuthenticationSecrets,
  withFailureCleanup,
} from './scaffold.ts'

const baseUrl = 'http://127.0.0.1:43123'
const expires = 'Wed, 01 Jan 2031 00:00:00 GMT'

function sessionCookie(value = 'session-value'): string {
  return `dsh-auth-test=${value}; Max-Age=2592000; Path=/; Expires=${expires}; HttpOnly; SameSite=Strict`
}

function exchangeResponse(options: {
  status?: number
  location?: string
  cookie?: string
  body?: string
} = {}): Response {
  const headers = new Headers()
  if (options.location !== null) headers.set('location', options.location ?? '/')
  if (options.cookie !== null) headers.append('set-cookie', options.cookie ?? sessionCookie())
  return new Response(options.body ?? 'discarded exchange body', {
    status: options.status ?? 303,
    headers,
  })
}

function fakePage(
  addCookies: ReturnType<typeof vi.fn> = vi.fn(async () => {}),
): { page: Page; addCookies: ReturnType<typeof vi.fn>; goto: ReturnType<typeof vi.fn> } {
  const goto = vi.fn(async () => null)
  return {
    page: {
      context: () => ({ addCookies }),
      goto,
    } as unknown as Page,
    addCookies,
    goto,
  }
}

function asFetch(mock: ReturnType<typeof vi.fn>): typeof fetch {
  return mock as unknown as typeof fetch
}

describe('alpha process launch URL capture', () => {
  it('keeps the latest valid same-origin root and accepts a legacy plain root', () => {
    const output = [
      'dsh web: http://127.0.0.1:43123/?token=first-launch',
      'dsh web: https://example.test/?token=foreign',
      'dsh web: http://127.0.0.1:43123/?token=latest-launch',
    ].join('\n')
    expect(processLaunchUrlFromOutput(baseUrl, output))
      .toBe('http://127.0.0.1:43123/?token=latest-launch')
    expect(processLaunchUrlFromOutput(baseUrl, 'dsh web: http://127.0.0.1:43123/'))
      .toBe('http://127.0.0.1:43123/')
  })

  it('rejects foreign origins, non-root paths, fragments, extra query input, and malformed lines', () => {
    const output = [
      'dsh web: https://example.test/?token=stolen',
      'dsh web: http://127.0.0.1:43123/not-root?token=wrong',
      'dsh web: http://127.0.0.1:43123/?token=wrong#fragment',
      'dsh web: http://127.0.0.1:43123/?token=right&next=wrong',
      'dsh web: definitely-not-a-url',
    ].join('\n')
    expect(processLaunchUrlFromOutput(baseUrl, output)).toBeNull()
  })

  it('retains a split launch line before a noisy tail rolls it out of diagnostics', () => {
    const capture = createStartupOutputCapture(baseUrl, 128)
    capture.push('ordinary startup\ndsh web: http://127.0.0.1:43123/?token=split-')
    expect(capture.processLaunchUrl).toBeNull()
    capture.push(`across-chunks\n${'noisy tail '.repeat(80)}`)
    expect(capture.processLaunchUrl)
      .toBe('http://127.0.0.1:43123/?token=split-across-chunks')
    expect(capture.outputTail).toContain('?token=<redacted>')
    expect(capture.outputTail).not.toContain('split-across-chunks')
    expect(capture.outputTail).not.toContain('across-chunks')
  })

  it('never exposes an incomplete launch line through the diagnostic tail', () => {
    const capture = createStartupOutputCapture(baseUrl, 32)
    capture.push('safe completed line\n')
    capture.push('dsh web: http://127.0.0.1:43123/?token=bare-suffix-must-not-escape')
    expect(capture.processLaunchUrl).toBeNull()
    expect(capture.outputTail).toBe('safe completed line\n')
    expect(capture.outputTail).not.toContain('bare-suffix-must-not-escape')
  })

  it('updates retained state only when a newer valid completed line arrives', () => {
    const capture = createStartupOutputCapture(baseUrl)
    capture.push('dsh web: http://127.0.0.1:43123/?token=first\n')
    capture.push('dsh web: https://foreign.test/?token=ignored\n')
    expect(capture.processLaunchUrl).toBe('http://127.0.0.1:43123/?token=first')
    capture.push('dsh web: http://127.0.0.1:43123/?token=sec')
    expect(capture.processLaunchUrl).toBe('http://127.0.0.1:43123/?token=first')
    capture.push('ond\n')
    expect(capture.processLaunchUrl).toBe('http://127.0.0.1:43123/?token=second')
  })

  it('redacts launch tokens, Cookie values, Set-Cookie values, and exact bare secrets', () => {
    expect(redactAuthenticationSecrets(
      'GET /?token=launch-secret; Set-Cookie: dsh-auth-x=session-secret; Cookie: dsh-auth-x=session-secret',
      ['launch-secret', 'session-secret'],
    )).not.toMatch(/launch-secret|session-secret/u)
  })
})

describe('failed boot ownership', () => {
  it('cleans the spawned child, registry, and initial home exactly once without retaining a cause', async () => {
    const stopChild = vi.fn(async () => {})
    const closeRegistry = vi.fn(async () => {})
    const removeHome = vi.fn()
    let caught: unknown
    try {
      await withFailureCleanup(
        async () => await withFailureCleanup(
          async () => { throw new Error(`boot timeout at ${baseUrl}/?token=cleanup-secret`) },
          stopChild,
          ['cleanup-secret'],
        ),
        async () => {
          try {
            await closeRegistry()
          } finally {
            removeHome()
          }
        },
      )
    } catch (error) {
      caught = error
    }
    expect(stopChild).toHaveBeenCalledOnce()
    expect(closeRegistry).toHaveBeenCalledOnce()
    expect(removeHome).toHaveBeenCalledOnce()
    expect(caught).toBeInstanceOf(Error)
    const reconstructed = caught as Error & { cause?: unknown }
    expect(reconstructed.message).not.toContain('cleanup-secret')
    expect(reconstructed.message).toContain('?token=<redacted>')
    expect(reconstructed.cause).toBeUndefined()
  })

  it('does not clean a successful boot attempt', async () => {
    const cleanup = vi.fn(async () => {})
    await expect(withFailureCleanup(async () => 'ready', cleanup)).resolves.toBe('ready')
    expect(cleanup).not.toHaveBeenCalled()
  })
})

describe('Node-only alpha process launch token exchange', () => {
  it('validates the manual 303, parses the exact cookie, and consumes the response body', async () => {
    const response = exchangeResponse()
    const fetch_ = vi.fn(async () => response)
    const result = await exchangeProcessLaunchToken(
      baseUrl,
      `${baseUrl}/?token=process-launch-secret`,
      asFetch(fetch_),
    )

    expect(fetch_).toHaveBeenCalledWith(`${baseUrl}/?token=process-launch-secret`, {
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    })
    expect(result).toEqual({
      cookie: {
        name: 'dsh-auth-test',
        value: 'session-value',
        url: `${baseUrl}/`,
        expires: Date.parse(expires) / 1000,
        httpOnly: true,
        secure: false,
        sameSite: 'Strict',
      },
    })
    expect(response.bodyUsed).toBe(true)
  })

  it('retains legacy plain-host behavior without making an exchange', async () => {
    const fetch_ = vi.fn()
    expect(await exchangeProcessLaunchToken(baseUrl, `${baseUrl}/`, asFetch(fetch_))).toBeNull()
    expect(fetch_).not.toHaveBeenCalled()
  })

  it('rejects foreign redirects and unsafe cookie scope or attributes', async () => {
    const foreign = vi.fn(async () => exchangeResponse({ location: 'https://example.test/' }))
    await expect(exchangeProcessLaunchToken(
      baseUrl,
      `${baseUrl}/?token=redirect-secret`,
      asFetch(foreign),
    )).rejects.toThrow('redirected outside the clean root')

    const domainCookie = vi.fn(async () => exchangeResponse({
      cookie: `${sessionCookie()}; Domain=example.test`,
    }))
    await expect(exchangeProcessLaunchToken(
      baseUrl,
      `${baseUrl}/?token=cookie-scope-secret`,
      asFetch(domainCookie),
    )).rejects.toThrow('non-host-only cookie')
  })

  it('seeds the parsed cookie and navigates only to the clean base URL', async () => {
    const response = exchangeResponse()
    const fetch_ = vi.fn(async () => response)
    const { page, addCookies, goto } = fakePage()
    await openMarketPage(page, {
      baseUrl,
      processLaunchUrl: `${baseUrl}/?token=process-launch-secret`,
    }, asFetch(fetch_))

    expect(addCookies).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({
      name: 'dsh-auth-test',
      value: 'session-value',
      url: `${baseUrl}/`,
      httpOnly: true,
      sameSite: 'Strict',
    })])
    expect(goto).toHaveBeenCalledExactlyOnceWith(baseUrl, { waitUntil: 'load' })
    expect(JSON.stringify(goto.mock.calls)).not.toMatch(/process-launch-secret|session-value/u)
  })

  it('fully redacts both credentials from seeding failures and drops the original cause', async () => {
    const token = 'never-print-this-process-token'
    const session = 'never-print-this-session-cookie'
    const fetch_ = vi.fn(async () => exchangeResponse({ cookie: sessionCookie(session) }))
    const original = new Error(`seed failed for ${session} from ${baseUrl}/?token=${token}`, {
      cause: new Error(`nested ${token} ${session}`),
    })
    const { page, goto } = fakePage(vi.fn(async () => { throw original }))
    let caught: unknown
    try {
      await openMarketPage(page, { baseUrl, processLaunchUrl: `${baseUrl}/?token=${token}` }, asFetch(fetch_))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    const redacted = caught as Error & { cause?: unknown }
    expect(redacted.message).not.toMatch(/never-print-this/u)
    expect(redacted.message).toContain('<redacted>')
    expect(redacted.cause).toBeUndefined()
    expect(goto).not.toHaveBeenCalled()
  })

  it('redacts a returned cookie even when exchange validation fails', async () => {
    const session = 'returned-cookie-must-not-leak'
    const fetch_ = vi.fn(async () => exchangeResponse({
      status: 401,
      cookie: sessionCookie(session),
    }))
    let caught: unknown
    try {
      await exchangeProcessLaunchToken(
        baseUrl,
        `${baseUrl}/?token=launch-token-must-not-leak`,
        asFetch(fetch_),
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    const redacted = caught as Error & { cause?: unknown }
    expect(redacted.message).not.toMatch(/must-not-leak/u)
    expect(redacted.cause).toBeUndefined()
  })

  it('reads the refreshed process launch URL on each open after a restart', async () => {
    let current = `${baseUrl}/?token=first-process-launch`
    const fetch_ = vi.fn(async (url: string | URL | Request) => {
      const value = String(url).includes('first-process-launch') ? 'first-session' : 'second-session'
      return exchangeResponse({ cookie: sessionCookie(value) })
    })
    const { page, addCookies, goto } = fakePage()
    const scaffold = {
      baseUrl,
      get processLaunchUrl() { return current },
    }

    await openMarketPage(page, scaffold, asFetch(fetch_))
    current = `${baseUrl}/?token=second-process-launch`
    await openMarketPage(page, scaffold, asFetch(fetch_))

    expect(fetch_.mock.calls.map(call => call[0])).toEqual([
      `${baseUrl}/?token=first-process-launch`,
      `${baseUrl}/?token=second-process-launch`,
    ])
    expect(addCookies.mock.calls.map(call => call[0][0].value)).toEqual(['first-session', 'second-session'])
    expect(goto.mock.calls).toEqual([
      [baseUrl, { waitUntil: 'load' }],
      [baseUrl, { waitUntil: 'load' }],
    ])
  })
})
