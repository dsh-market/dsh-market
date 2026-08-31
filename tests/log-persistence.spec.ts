/**
 * Persistent log sink: every market event survives the process, capped and
 * sanitized, and the export carries prior sessions alongside this one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { configurePersistentLog, exportLogs, logEvent, readPersistentLog } from '../src/log.ts'

let home: string
let logFile: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshm-log-'))
  logFile = join(home, '.dsh-market', 'log.ndjson')
})
afterEach(() => {
  configurePersistentLog(null)
  rmSync(home, { recursive: true, force: true })
})

describe('persistent log sink', () => {
  it('appends sanitized events as ndjson and reads the tail back', () => {
    configurePersistentLog(logFile)
    logEvent('warn', 'install', `failed under ${join(homedir(), '.dsh', 'profiles', 'web')} with token sk-abcdefgh12345678`)
    const lines = readPersistentLog(logFile)
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0]!) as { detail: string }
    // The redaction folds the home prefix to `~` and leaves the rest of the
    // path exactly as the machine writes it — a log pasted into an issue
    // should read like the reporter's own filesystem. So the expectation has
    // to be built the same way rather than hardcoding a POSIX separator,
    // which is what made this fail on Windows only.
    expect(entry.detail).toContain(join('~', '.dsh', 'profiles', 'web'))
    expect(entry.detail).not.toContain('sk-abcdefgh12345678')
  })

  it('trims an oversized file to its newest half on configure', () => {
    mkdirSync(join(home, '.dsh-market'), { recursive: true })
    writeFileSync(logFile, `${'x'.repeat(64)}\n`.repeat(6000))
    configurePersistentLog(logFile)
    const trimmed = readFileSync(logFile, 'utf8')
    expect(trimmed.length).toBeLessThanOrEqual(128 * 1024 + 128)
    expect(trimmed.endsWith('x\n')).toBe(true)
  })

  it('holds the cap while the process keeps running, not only at mount', () => {
    // Trimming only on configure left the ceiling unenforced for the life of
    // a process. Measured before the fix: 20k events grew the file to 3.2 MB.
    // A retry loop is precisely the case that logs hardest and never restarts,
    // so the process that most needs this log is the one that would blow it up.
    configurePersistentLog(logFile)
    for (let i = 0; i < 6000; i++) logEvent('error', 'install', `${'x'.repeat(120)} ${i}`)
    expect(statSync(logFile).size).toBeLessThanOrEqual(256 * 1024)
    // Still usable, and still holding the NEWEST events rather than the oldest.
    const lines = readPersistentLog(logFile)
    expect(lines.length).toBeGreaterThan(0)
    expect(JSON.parse(lines[lines.length - 1]!).detail).toContain('5999')
  })

  it('keeps exportLogs readable with and without prior sessions', () => {
    configurePersistentLog(logFile)
    logEvent('error', 'install', 'remove failed (exit 1) but the package is gone')
    configurePersistentLog(null)
    logEvent('info', 'uninstall', 'a fresh process event')
    const exported = exportLogs({ 'dsh-market': 'test' }, ['bundles (1):', '  plug-a: NOT RESOLVED'], readPersistentLog(logFile))
    expect(exported).toContain('## previous sessions (persisted log)')
    expect(exported).toContain('remove failed (exit 1)')
    expect(exported).toContain('## events this session')
    expect(exported).toContain('a fresh process event')
    expect(exportLogs({}, [], readPersistentLog(join(home, 'absent.ndjson')))).not.toContain('previous sessions')
  })
})

describe('exported timestamps say which clock they are on (#449)', () => {
  const withOffset = async (minutes: number, zone: string): Promise<string> => {
    const realOffset = Date.prototype.getTimezoneOffset
    const realFormat = Intl.DateTimeFormat
    // getTimezoneOffset is minutes to ADD to local to reach UTC, so UTC+8
    // reports -480. Stub the platform rather than the module: the note is
    // computed from the runtime's own clock, which is the thing under test.
    Date.prototype.getTimezoneOffset = function () { return -minutes }
    Intl.DateTimeFormat = function () {
      return { resolvedOptions: () => ({ timeZone: zone }) }
    } as unknown as typeof Intl.DateTimeFormat
    try {
      return exportLogs({ 'dsh-market': 'test' })
    } finally {
      Date.prototype.getTimezoneOffset = realOffset
      Intl.DateTimeFormat = realFormat
    }
  }

  it('does the arithmetic for the reader instead of leaving a bare Z', async () => {
    // #449: a UTC+8 reporter saw 07:32 for something they watched happen at
    // 15:32 and could not tell whether the log was skewed or their machine
    // was. Lines stay UTC on purpose — one clock across reporters — so the
    // header has to be what closes that gap.
    const text = await withOffset(480, 'Asia/Shanghai')
    expect(text).toContain('timestamps: UTC')
    expect(text).toContain('UTC+08:00')
    expect(text).toContain('Asia/Shanghai')
    expect(text).toContain('add 8h for local time')
  })

  it('points the other way west of Greenwich, and keeps half-hour zones exact', async () => {
    expect(await withOffset(-300, 'America/New_York')).toContain('UTC-05:00')
    expect(await withOffset(-300, 'America/New_York')).toContain('subtract 5h for local time')
    // A whole-hour shift would be wrong for the zones that are not on one.
    expect(await withOffset(330, 'Asia/Kolkata')).toContain('add 5h30m for local time')
  })

  it('says nothing at all when the machine is already on UTC', async () => {
    // A note that reduces to "add 0h" is noise in an artifact people read
    // under pressure.
    expect(await withOffset(0, 'UTC')).not.toContain('timestamps: UTC —')
  })
})
