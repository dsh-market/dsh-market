/**
 * Persistent log sink: every market event survives the process, capped and
 * sanitized, and the export carries prior sessions alongside this one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { configurePersistentLog, exportLogs, logEvent, readPersistentLog } from '../src/log.ts'

vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>()
  return { ...os, homedir: vi.fn(os.homedir) }
})

let home: string
let logFile: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshm-log-'))
  logFile = join(home, '.dsh-market', 'log.ndjson')
})
afterEach(() => {
  configurePersistentLog(null)
  vi.mocked(homedir).mockReset()
  rmSync(home, { recursive: true, force: true })
})

describe('home path redaction (#907)', () => {
  const windowsHome = String.raw`C:\Users\Alice.test+(dev)`
  const variants = [
    [String.raw`C:\Users\Alice.test+(dev)\private`, String.raw`~\private`],
    ['C:/Users/Alice.test+(dev)/private', '~/private'],
    [String.raw`C:/Users\Alice.test+(dev)/private`, '~/private'],
    ['c:/uSeRs/ALICE.TEST+(DEV)/private', '~/private'],
  ] as const

  it.each(variants)('masks %s on write, in headers and snapshots, and in historical logs', (path, masked) => {
    vi.mocked(homedir).mockReturnValue(windowsHome)
    configurePersistentLog(logFile)
    logEvent('info', 'home-907', `link:${path}\nforged\r\u0000 sk-abcdefgh12345678 api-key=secret`)
    const entry = JSON.parse(readPersistentLog(logFile)[0]!) as { detail: string }
    expect(entry.detail).toBe(`link:${masked}forged sk-*** api-key=***`)
    expect(exportLogs({ host: path }, [`dependency: link:${path}`])).toContain(`host: ${masked}`)
    expect(exportLogs({}, [`dependency: link:${path}`])).toContain(`dependency: link:${masked}`)
    expect(exportLogs({})).toContain(`home-907: link:${masked}forged sk-*** api-key=***`)

    // Simulate an old process that persisted the original, unsanitized data.
    const historical = JSON.stringify({ detail: `link:${path} token=secret` })
    writeFileSync(logFile, historical + '\n')
    const exported = exportLogs({}, [], readPersistentLog(logFile))
    const prior = exported.split('## previous sessions (persisted log)\n')[1]!.split('\n')[0]!
    expect(prior).not.toContain('Alice')
    expect(prior).not.toContain('ALICE')
    expect(prior).not.toContain('secret')
    expect(prior).toContain(`link:${JSON.stringify(masked).slice(1, -1)}`)
    // Exporting older data does not rewrite the user's log file.
    expect(readFileSync(logFile, 'utf8')).toBe(historical + '\n')
  })

  it('matches only the home directory, including a bare home, and leaves other paths and text intact', () => {
    vi.mocked(homedir).mockReturnValue(windowsHome)
    const unchanged = [
      'link:C:/Users/Bob/private', 'link:D:/work/private',
      'C:/Users/Alice.test+(dev)-other/private', 'C:/Users/Alice.test+(dev).backup/private',
      'prefixC:/Users/Alice.test+(dev)/private', 'D:/copy/C:/Users/Alice.test+(dev)/private',
      'Alice.test+(dev) is a user',
    ]
    expect(exportLogs({}, unchanged)).toContain(unchanged.join('\n'))
    expect(exportLogs({}, [`home: "${windowsHome}"`, `(${windowsHome})`, windowsHome])).toContain('home: "~"\n(~)\n~')
  })

  it('keeps POSIX homes case-sensitive and does not reinterpret backslashes', () => {
    vi.mocked(homedir).mockReturnValue('/home/alice.test+(dev)')
    const unchanged = ['/home/Alice.test+(dev)/private', '/home/alice.test+(dev)-other/private',
      String.raw`\home\alice.test+(dev)\private`, '/copy/home/alice.test+(dev)/private']
    expect(exportLogs({}, unchanged)).toContain(unchanged.join('\n'))
    expect(exportLogs({}, ['link:/home/alice.test+(dev)/private'])).toContain('link:~/private')
  })

  it('handles UNC Windows homes with equivalent separators and case', () => {
    vi.mocked(homedir).mockReturnValue(String.raw`\\server\share\Alice`)
    expect(exportLogs({}, ['link://SERVER/share/aLiCe/private'])).toContain('link:~/private')
    expect(exportLogs({}, ['link://server/share/Alice-other/private'])).toContain('link://server/share/Alice-other/private')
  })

  it('still masks home paths in file URLs (#907)', () => {
    vi.mocked(homedir).mockReturnValue(windowsHome)
    expect(exportLogs({}, ['file:///c:/users/ALICE.TEST+(dev)/private'])).toContain('file:///~/private')
    vi.mocked(homedir).mockReturnValue('/home/alice')
    expect(exportLogs({}, ['file:///home/alice/private'])).toContain('file://~/private')
  })

  it.each([
    ['C:\\Users\\Alice\\', String.raw`c:/Users\ALICE\private`, String.raw`~\private`],
    ['C:/Users/Alice/', 'c:/USERS/alice/private', '~/private'],
    ['/home/alice/', '/home/alice/private', '~/private'],
  ])('normalizes the trailing separator in %s before masking events and history (#907)', (directory, path, masked) => {
    vi.mocked(homedir).mockReturnValue(directory)
    configurePersistentLog(logFile)
    logEvent('info', 'trailing-home', `link:${path}\nforged token=secret`)
    const entry = JSON.parse(readPersistentLog(logFile)[0]!) as { detail: string }
    expect(entry.detail).toBe(`link:${masked}forged token=***`)
    expect(exportLogs({ host: path! }, [path!])).toContain(`host: ${masked}\n`)
    expect(exportLogs({}, [path!])).toContain(`## profile state\n${masked}\n`)
    expect(exportLogs({})).toContain(`trailing-home: link:${masked}forged token=***`)

    const historical = JSON.stringify({ detail: path }) + '\n'
    writeFileSync(logFile, historical)
    const prior = exportLogs({}, [], readPersistentLog(logFile)).split('## previous sessions (persisted log)\n')[1]!.split('\n')[0]!
    expect(JSON.parse(prior)).toEqual({ detail: masked })
    expect(readFileSync(logFile, 'utf8')).toBe(historical)
  })

  it.each([
    ['C:\\', String.raw`C:\private`, String.raw`~\private`],
    ['C:/', 'c:/private', '~/private'],
    ['\\\\server\\share\\', '//SERVER/share/private', '~/private'],
    ['/', '/home/alice/private', '/home/alice/private'],
  ])('preserves the path semantics of root home %s (#907)', (directory, path, expected) => {
    vi.mocked(homedir).mockReturnValue(directory)
    expect(exportLogs({}, [path!])).toContain(`## profile state\n${expected}\n`)
    const unchanged = ['C:relative', 'D:/private', '//server/share-other/private', 'ordinary text']
    expect(exportLogs({}, unchanged)).toContain(unchanged.join('\n'))
  })
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
    //
    // 2100 events of 205 bytes cross the cap exactly twice (near 1280 and
    // 1920; a third would need about 2560): once to prove the trim runs while
    // the process lives, once more to prove a trimmed file keeps holding it.
    // Every event is its own open/write/close, so more events only slow the
    // test down on a busy machine (#801).
    configurePersistentLog(logFile)
    for (let i = 0; i < 2100; i++) logEvent('error', 'install', `${'x'.repeat(120)} ${i}`)
    expect(statSync(logFile).size).toBeLessThanOrEqual(256 * 1024)
    // Still usable, and still holding the NEWEST events rather than the oldest.
    const lines = readPersistentLog(logFile)
    expect(lines.length).toBeGreaterThan(0)
    expect(JSON.parse(lines[lines.length - 1]!).detail).toContain('2099')
  })

  it('counts the cap in bytes, so CJK detail cannot overshoot it', () => {
    // JSON.stringify keeps CJK unescaped: each character is 3 bytes on disk
    // and 1 in `string.length`. A line here is about 680 bytes and 280
    // characters, so 450 events write about 300 KB while a character count
    // stays near 125K and never reaches the trim.
    configurePersistentLog(logFile)
    for (let i = 0; i < 450; i++) logEvent('error', 'install', `${'安装失败：'.repeat(40)} ${i}`)
    expect(statSync(logFile).size).toBeLessThanOrEqual(256 * 1024)
    const lines = readPersistentLog(logFile)
    expect(JSON.parse(lines[lines.length - 1]!).detail).toContain('449')
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
