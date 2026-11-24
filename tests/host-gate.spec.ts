/**
 * The host's own request gate in front of every market route (#603).
 *
 * The market registers exact routes on the bare webServer, which the host's
 * `/api` fence and browser login never see. With the login on, a client that
 * holds no session could read the market's state and install or remove
 * plugins — code execution on the machine, for anyone who can reach a
 * deployment behind a proxy or a tunnel. The host publishes the check its own
 * API runs, `connection.requestRejection(request)`; the market now asks it.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { refuseUnadmitted, setRequestGateSource } from '../src/http.ts'
import { useTrustedHosts } from '../src/index.ts'

function response() {
  const sent: { status?: number; body?: string } = {}
  return {
    sent,
    writeHead(status: number) { sent.status = status },
    end(body?: string) { sent.body = body },
  }
}
const request = { headers: { host: '127.0.0.1:3080' } } as never

const restores: Array<() => void> = []
afterEach(() => { while (restores.length > 0) restores.pop()!() })

describe('refuseUnadmitted', () => {
  it('lets everything through on a host that publishes no gate (0.1.0-rc.8)', () => {
    restores.push((() => { const previous = setRequestGateSource(() => undefined); return () => setRequestGateSource(previous) })())
    const res = response()
    expect(refuseUnadmitted(request, res as never)).toBe(false)
    expect(res.sent.status).toBeUndefined()
  })

  it('answers the host\'s 401 itself and says what to do', () => {
    const previous = setRequestGateSource(() => () => 401)
    restores.push(() => setRequestGateSource(previous))
    const res = response()
    expect(refuseUnadmitted(request, res as never)).toBe(true)
    expect(res.sent.status).toBe(401)
    expect(res.sent.body).toContain('dsh web')
    expect(res.sent.body).toContain('登录')
  })

  it('passes a request the host admits', () => {
    const previous = setRequestGateSource(() => () => undefined)
    restores.push(() => setRequestGateSource(previous))
    expect(refuseUnadmitted(request, response() as never)).toBe(false)
  })

  it('refuses when the host gate itself throws, instead of failing open', () => {
    const previous = setRequestGateSource(() => () => { throw new Error('host bug') })
    restores.push(() => setRequestGateSource(previous))
    const res = response()
    expect(refuseUnadmitted(request, res as never)).toBe(true)
    expect(res.sent.status).toBe(403)
  })
})

describe('the gate is the host connection service\'s own, read per request', () => {
  // A context holding `services` and declaring what it has: `inject` runs its
  // callback only when every dependency is present, exactly as Cordis does, so
  // a host missing one keeps the gate it had instead of losing it.
  const contextWith = (services: Record<string, unknown>) => {
    const own: Record<string, unknown> = {
      get: (name: string) => services[name],
      inject: (deps: string[], callback: (scoped: unknown) => unknown) => {
        let subscription: { dispose: () => void } | undefined
        if (deps.every(dep => dep in services)) {
          const disposer = callback(own) as (() => void) | undefined
          subscription = { dispose: () => { disposer?.() } }
        }
        return subscription ?? { dispose: () => undefined }
      },
    }
    return own as never
  }

  it('calls requestRejection on the service, with the service as `this`', () => {
    const services: Record<string, unknown> = {}
    restores.push(useTrustedHosts(contextWith(services)))
    // Before the host's async init lands: no gate yet, nothing refused.
    expect(refuseUnadmitted(request, response() as never)).toBe(false)
    const connection = {
      trustedHosts: [],
      authenticated: false,
      requestRejection(this: { authenticated: boolean }) { return this.authenticated ? undefined : 401 },
    }
    services.connection = connection
    const res = response()
    expect(refuseUnadmitted(request, res as never)).toBe(true)
    expect(res.sent.status).toBe(401)
    connection.authenticated = true
    expect(refuseUnadmitted(request, response() as never)).toBe(false)
  })

  it('uses connection.admit when the host no longer has requestRejection (#1289)', () => {
    const seen: Array<{ url: string; method: string }> = []
    const connection = {
      mode: 'reject' as 'reject' | 'allow',
      admit(this: { mode: string }, facts: { url: string; method: string }) {
        seen.push(facts)
        return this.mode === 'allow' ? { peer: {} } : { rejection: 401 }
      },
    }
    restores.push(useTrustedHosts(contextWith({ connection })))
    const res = response()
    expect(refuseUnadmitted({ ...request, url: '/dsh-market/status', headers: { host: 'localhost:8080' }, method: 'GET', socket: {} } as never, res as never)).toBe(true)
    expect(res.sent.status).toBe(401)
    expect(seen[0]).toMatchObject({ url: 'http://localhost:8080/dsh-market/status', method: 'GET' })
    connection.mode = 'allow'
    expect(refuseUnadmitted(request, response() as never)).toBe(false)
  })

  it('refuses when admit throws or answers nothing, instead of letting the request through', () => {
    restores.push(useTrustedHosts(contextWith({ connection: { admit: () => undefined } })))
    const res = response()
    expect(refuseUnadmitted(request, res as never)).toBe(true)
    expect(res.sent.status).toBe(403)
  })

  it('goes back to the previous source when its effect is disposed', () => {
    const restore = useTrustedHosts(contextWith({ connection: { requestRejection: () => 401 } }))
    expect(refuseUnadmitted(request, response() as never)).toBe(true)
    restore()
    expect(refuseUnadmitted(request, response() as never)).toBe(false)
  })
})

/**
 * The gate above is the host's `connection.admit`, and `admit` verifies the
 * login through `connection.authentication` — a service property Cordis
 * resolves through the context the connection was READ from, not the one that
 * provided it. A reader that never declared the registry makes that read
 * throw, and the fence turns a throw into 403: every route refused for a
 * signed-in browser, on every host that dropped `requestRejection` (#1299).
 *
 * A fake context cannot show this — the throw only exists in real Cordis — so
 * this case builds the host from the real Context and the real Service base,
 * with the same dependency shape as dsh-client-connection.
 */
describe('the gate is read from a scope that declared the login registry', () => {
  class Authentication extends Service {
    constructor(ctx: Context) { super(ctx, 'connection.authentication') }
    // The registry sees the facts `admissionFacts` builds, not the raw
    // request: the session cookie arrives in `headers`.
    authenticate(facts: { headers?: { cookie?: string } }) {
      return facts.headers?.cookie === 'dsh_session=valid' ? { peer: {} } : { rejection: 401 }
    }
  }
  class Connection extends Service {
    static inject = ['connection.authentication']
    authentication: Authentication
    constructor(ctx: Context) {
      super(ctx, 'connection')
      this.authentication = (ctx as unknown as Record<string, Authentication>)['connection.authentication']
    }
    /** The host's own `admit`: the fence, then the registry above. */
    admit(facts: { headers?: { cookie?: string } }) { return this.authentication.authenticate(facts) }
  }
  class WebServer extends Service {
    constructor(ctx: Context) { super(ctx, 'webServer') }
  }

  const admitted = (session: string) => ({
    ...request,
    headers: { host: '127.0.0.1:3080', cookie: `dsh_session=${session}` },
    socket: {},
  }) as never

  async function market() {
    const root = new Context()
    await root.plugin(Authentication)
    await root.plugin(Connection)
    await root.plugin(WebServer)
    let restore: (() => void) | undefined
    // The market's own context: it declared `webServer`, never the registry.
    await root.plugin({
      inject: ['webServer'],
      apply(ctx: Context) { restore = useTrustedHosts(ctx) },
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    return { root, restore: () => { restore?.() } }
  }

  it('admits a signed-in browser and still answers 401 without one', async () => {
    const { root, restore } = await market()
    try {
      expect(refuseUnadmitted(admitted('valid'), response() as never)).toBe(false)
      const res = response()
      expect(refuseUnadmitted(admitted('absent'), res as never)).toBe(true)
      expect(res.sent.status).toBe(401)
    } finally {
      restore()
      await root.fiber.dispose()
    }
  })
})
