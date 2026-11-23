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
  const contextWith = (services: Record<string, unknown>) => ({ get: (name: string) => services[name] }) as never

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
