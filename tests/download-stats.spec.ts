import { describe, expect, it } from 'vitest'
import { downloadStatsText } from '../src/client/download-stats.ts'
import { en, zh } from '../src/client/locales.ts'
import type { Translate } from '../src/client/market-data.ts'

const english: Translate = key => en[key]
const chinese: Translate = key => zh[key]

describe('download statistic disclosure', () => {
  it('uses exact source values and explains rolling counts in both languages', () => {
    const stats = { downloads: 12345, downloadsStart: '2026-08-25', downloadsEnd: '2026-09-23', downloadsCheckedAt: '2026-09-24' }
    for (const t of [english, chinese]) {
      const text = downloadStatsText(stats, t)!
      expect(text).toContain('12345')
      expect(text).toContain(stats.downloadsStart)
      expect(text).toContain(stats.downloadsEnd)
      expect(text).toContain(stats.downloadsCheckedAt)
      expect(text).not.toContain('12.3k')
    }
    expect(downloadStatsText(stats, english)).toContain('not lifetime downloads or unique users')
    expect(downloadStatsText(stats, chinese)).toContain('非累计下载量')
  })

  it('retains zero and does not fabricate dates for legacy counts', () => {
    const text = downloadStatsText({ downloads: 0 }, english)
    expect(text).toContain('downloads: 0')
    expect(text).toContain(en.downloadsWindowUnknown)
    expect(text).toContain(en.downloadsCheckedUnknown)
  })

  it.each([undefined, null, -1, NaN, Infinity, 1.5])('omits an unknown or invalid count (%s)', downloads => {
    expect(downloadStatsText({ downloads }, english)).toBeNull()
  })

  it.each([
    { downloadsStart: '2026-08-25' },
    { downloadsEnd: '2026-09-23' },
    { downloadsStart: '2026-02-30', downloadsEnd: '2026-03-01' },
    { downloadsStart: '2026-09-23', downloadsEnd: '2026-08-25' },
    { downloadsStart: '<script>', downloadsEnd: '2026-09-23' },
  ])('reports incomplete/invalid/reversed windows as unknown: %j', fields => {
    expect(downloadStatsText({ downloads: 7, ...fields }, english)).toContain(en.downloadsWindowUnknown)
  })

  it('preserves a supplied UTC check timestamp without substituting fetch time', () => {
    expect(downloadStatsText({ downloads: 7, downloadsCheckedAt: '2026-09-24T10:20:30.000Z' }, english))
      .toContain('2026-09-24T10:20:30.000Z')
    for (const downloadsCheckedAt of ['yesterday', '2026-02-30', '2026-09-24T99:00:00Z']) {
      expect(downloadStatsText({ downloads: 7, downloadsCheckedAt }, english)).toContain(en.downloadsCheckedUnknown)
    }
  })
})
