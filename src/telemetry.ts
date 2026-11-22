import { getPolicy } from './policy.ts'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from './home-paths.ts'
import { logEvent } from './log.ts'
import { marketFetch } from './net.ts'

/**
 * The anonymous daily count.
 *
 * One POST per install per UTC day, from the Node side only, carrying five
 * fields (see `Ping`). On a day the user opens the market page, a second POST
 * carries the same five plus `opened: true` — the only thing it adds is that
 * the page was opened, never what was done there. It is on by default and off
 * with one switch in the settings card or with an environment variable.
 * Everything about it is best effort: a failure changes nothing for the user
 * and is never an error.
 */

export const TELEMETRY_URL = 'https://t.dshmarket.com/v1/ping'
const TIMEOUT_MS = 10_000
const START_DELAY_MS = 30_000
const RECHECK_MS = 6 * 60 * 60 * 1000

/** The whole payload. Adding a field here is a privacy change: update SECURITY.md. */
export interface Ping {
  id: string
  v: string
  hv: string | null
  kind: 'desktop' | 'web'
  region: string
  /** Present (and true) only on the day's first open of the market page. */
  opened?: true
}

interface TelemetryState { id?: string; lastDay?: string; lastOpenDay?: string; enabled: boolean }

export function telemetryFile(home: string = resolveDshHome()): string {
  return join(home, 'dsh-market', 'telemetry.json')
}

export function readTelemetryState(file: string = telemetryFile()): TelemetryState {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    return {
      ...(typeof value.id === 'string' && /^[0-9a-f]{32}$/.test(value.id) ? { id: value.id } : {}),
      ...(typeof value.lastDay === 'string' ? { lastDay: value.lastDay } : {}),
      ...(typeof value.lastOpenDay === 'string' ? { lastOpenDay: value.lastOpenDay } : {}),
      enabled: value.enabled !== false,
    }
  } catch { return { enabled: true } }
}

function writeState(state: TelemetryState, file: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(state))
  renameSync(temp, file)
}

/** Turn the count on or off. Keeps the rest of the file; deletes nothing else. */
export function setTelemetryEnabled(enabled: boolean, file: string = telemetryFile()): void {
  writeState({ ...readTelemetryState(file), enabled }, file)
}

const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10)

/** Why nothing may be sent right now, or null. Explicit opt-outs always win. */
export function suppressedBy(env: Record<string, string | undefined>): string | null {
  // An organization that forbids the count wins over the user's own switch.
  if (getPolicy().telemetry === false) return 'organization policy'
  if (env.DSH_MARKET_TELEMETRY === '0') return 'DSH_MARKET_TELEMETRY=0'
  if (env.DO_NOT_TRACK === '1') return 'DO_NOT_TRACK=1'
  // Tests and CI never count, unless a test points the URL at its own server.
  const overridden = (env.DSH_MARKET_TELEMETRY_URL ?? '') !== ''
  if (!overridden && env.CI !== undefined && env.CI !== '' && env.CI !== '0' && env.CI !== 'false') return 'CI'
  if (!overridden && (env.VITEST !== undefined || env.NODE_ENV === 'test')) return 'test run'
  return null
}

export interface HeartbeatOptions {
  version: string
  hostVersion: () => string | null
  kind: () => 'desktop' | 'web'
  region: () => string
  file?: string
  env?: Record<string, string | undefined>
  now?: () => number
  fetch?: typeof marketFetch
}

async function send(options: HeartbeatOptions, opened: boolean): Promise<'sent' | 'skipped' | 'failed'> {
  try {
    const env = options.env ?? process.env
    const file = options.file ?? telemetryFile()
    if (suppressedBy(env) !== null) return 'skipped'
    const state = readTelemetryState(file)
    if (!state.enabled) return 'skipped'
    const day = utcDay((options.now ?? Date.now)())
    if ((opened ? state.lastOpenDay : state.lastDay) === day) return 'skipped'
    const id = state.id ?? randomBytes(16).toString('hex')
    const ping: Ping = {
      id, v: options.version, hv: options.hostVersion(), kind: options.kind(), region: options.region(),
      ...(opened ? { opened: true as const } : {}),
    }
    const response = await (options.fetch ?? marketFetch)(env.DSH_MARKET_TELEMETRY_URL || TELEMETRY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ping),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (response.status < 200 || response.status > 299) return 'failed'
    // Re-read: the user may have turned it off while the request was in flight.
    // An open also counts as today's heartbeat: the server row is the same.
    writeState({ ...readTelemetryState(file), id, lastDay: day, ...(opened ? { lastOpenDay: day } : {}) }, file)
    return 'sent'
  } catch (error) {
    logEvent('info', 'telemetry', `not sent: ${error instanceof Error ? error.message : 'unknown'}`)
    return 'failed'
  }
}

/** Send today's count if it is due. Never throws. */
export function sendHeartbeat(options: HeartbeatOptions): Promise<'sent' | 'skipped' | 'failed'> {
  return send(options, false)
}

/** Note that the market page was opened today, if that has not been sent yet. Never throws. */
export function sendOpened(options: HeartbeatOptions): Promise<'sent' | 'skipped' | 'failed'> {
  return send(options, true)
}

/** Start the schedule: first check after a short delay, then every ~6 hours. */
export function startHeartbeat(options: HeartbeatOptions, delayMs: number = START_DELAY_MS, everyMs: number = RECHECK_MS): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = (): void => {
    if (stopped) return
    void sendHeartbeat(options).finally(() => {
      if (stopped) return
      timer = setTimeout(tick, everyMs)
      timer.unref?.()
    })
  }
  timer = setTimeout(tick, delayMs)
  timer.unref?.()
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer) }
}
