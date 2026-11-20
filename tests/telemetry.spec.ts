import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readTelemetryState, sendHeartbeat, sendOpened, setTelemetryEnabled, suppressedBy, telemetryFile, TELEMETRY_URL, type HeartbeatOptions } from '../src/telemetry.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const ok = (status = 204) => vi.fn(async () => new Response(null, { status })) as unknown as NonNullable<HeartbeatOptions['fetch']>

function setup(extra: Partial<HeartbeatOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-telemetry-'))
  dirs.push(dir)
  const file = telemetryFile(dir)
  const fetch = ok()
  const day = { at: Date.UTC(2026, 10, 20, 12) }
  const options: HeartbeatOptions = {
    version: '1.2.3', hostVersion: () => '0.2.1', kind: () => 'web', region: () => 'china',
    file, env: {}, now: () => day.at, fetch, ...extra,
  }
  return { options, file, fetch: options.fetch as unknown as ReturnType<typeof vi.fn>, day }
}

describe('anonymous usage count', () => {
  it('lives in the market state dir', () => {
    expect(telemetryFile('/h/.dsh')).toBe(join('/h/.dsh', 'dsh-market', 'telemetry.json'))
  })

  it('sends exactly five fields for the daily count', async () => {
    const { options, fetch, file } = setup()
    expect(await sendHeartbeat(options)).toBe('sent')
    const [url, init] = fetch.mock.calls[0] as [string, { method: string; body: string }]
    expect(url).toBe(TELEMETRY_URL)
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['hv', 'id', 'kind', 'region', 'v'])
    expect(body).toMatchObject({ v: '1.2.3', hv: '0.2.1', kind: 'web', region: 'china' })
    expect(body.id).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ id: body.id, lastDay: '2026-11-20', enabled: true })
  })

  it('adds one flag, and only one, on the day the page is opened', async () => {
    const { options, fetch, file } = setup()
    await sendHeartbeat(options)
    expect(await sendOpened(options)).toBe('sent')
    const body = JSON.parse((fetch.mock.calls[1] as [string, { body: string }])[1].body) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['hv', 'id', 'kind', 'opened', 'region', 'v'])
    expect(body.opened).toBe(true)
    expect(readTelemetryState(file)).toMatchObject({ lastDay: '2026-11-20', lastOpenDay: '2026-11-20' })
  })

  it('reports an open once per UTC day, and again the next day', async () => {
    const { options, fetch, day } = setup()
    expect(await sendOpened(options)).toBe('sent')
    expect(await sendOpened(options)).toBe('skipped')
    day.at = Date.UTC(2026, 10, 21, 0, 1)
    expect(await sendOpened(options)).toBe('sent')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('an open on its own already counts as the day\'s heartbeat', async () => {
    const { options, fetch } = setup()
    await sendOpened(options)
    expect(await sendHeartbeat(options)).toBe('skipped')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('an open after turning the count off sends nothing', async () => {
    const { options, fetch, file } = setup()
    setTelemetryEnabled(false, file)
    expect(await sendOpened(options)).toBe('skipped')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not record the open when the request fails', async () => {
    const { options, file } = setup({ fetch: ok(500) })
    expect(await sendOpened(options)).toBe('failed')
    expect(readTelemetryState(file).lastOpenDay).toBeUndefined()
  })

  it('sends a null host version and the desktop kind as they are', async () => {
    const { options, fetch } = setup({ hostVersion: () => null, kind: () => 'desktop' })
    await sendHeartbeat(options)
    expect(JSON.parse((fetch.mock.calls[0] as [string, { body: string }])[1].body)).toMatchObject({ hv: null, kind: 'desktop' })
  })

  it('sends once per UTC day, keeps the same id, and sends again the next day', async () => {
    const { options, fetch, day } = setup()
    expect(await sendHeartbeat(options)).toBe('sent')
    day.at = Date.UTC(2026, 10, 20, 23, 59)
    expect(await sendHeartbeat(options)).toBe('skipped')
    day.at = Date.UTC(2026, 10, 21, 0, 1)
    expect(await sendHeartbeat(options)).toBe('sent')
    expect(fetch).toHaveBeenCalledTimes(2)
    const ids = fetch.mock.calls.map(call => (JSON.parse((call as [string, { body: string }])[1].body) as { id: string }).id)
    expect(ids[0]).toBe(ids[1])
  })

  it('does not record the day when the request fails', async () => {
    const { options, file } = setup({ fetch: ok(500) })
    expect(await sendHeartbeat(options)).toBe('failed')
    expect(readTelemetryState(file).lastDay).toBeUndefined()
    const thrown = setup({ fetch: vi.fn(async () => { throw new Error('offline') }) as never })
    expect(await sendHeartbeat(thrown.options)).toBe('failed')
    expect(existsSync(thrown.file)).toBe(false)
  })

  it('sends nothing when turned off in settings, and keeps the id and day', async () => {
    const { options, fetch, file } = setup()
    await sendHeartbeat(options)
    setTelemetryEnabled(false, file)
    expect(readTelemetryState(file)).toMatchObject({ enabled: false, lastDay: '2026-11-20' })
    options.now = () => Date.UTC(2026, 10, 25)
    expect(await sendHeartbeat(options)).toBe('skipped')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ DSH_MARKET_TELEMETRY: '0' }],
    [{ DO_NOT_TRACK: '1' }],
    [{ CI: 'true' }],
    [{ VITEST: 'true' }],
    [{ NODE_ENV: 'test' }],
  ])('sends nothing under %j', async env => {
    const { options, fetch } = setup({ env })
    expect(await sendHeartbeat(options)).toBe('skipped')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('lets a test opt in with its own URL, but never past an explicit opt-out', async () => {
    const env = { VITEST: 'true', CI: 'true', DSH_MARKET_TELEMETRY_URL: 'http://127.0.0.1:9/ping' }
    const { options, fetch } = setup({ env })
    expect(await sendHeartbeat(options)).toBe('sent')
    expect(fetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9/ping')
    expect(suppressedBy({ ...env, DSH_MARKET_TELEMETRY: '0' })).not.toBeNull()
    expect(suppressedBy({ ...env, DO_NOT_TRACK: '1' })).not.toBeNull()
  })

  it('treats a corrupt state file as the defaults', () => {
    const { file } = setup()
    setTelemetryEnabled(true, file)
    writeFileSync(file, '{nope')
    expect(readTelemetryState(file)).toEqual({ enabled: true })
  })
})
