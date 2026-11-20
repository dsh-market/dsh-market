/**
 * Profile-level fresh-release blockers (#1252): what the market learns from
 * the first pnpm refusal, how long it believes it, and how it is told.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  UNKNOWN_BLOCKER_TTL_MS, activeReleaseBlockers, clearReleaseBlockers, forgetReleaseBlockerMemory, headlineBlocker,
  parseReleaseAgeBlockers, recordReleaseBlockers, releaseBlockedMessage,
} from '../src/release-blockers.ts'
import { applyProfileBlockers, type UpdateStatus } from '../src/updates.ts'

const DAY = 24 * 60 * 60 * 1000

/** pnpm 11.28.5's output from the report, as written in pnpm.log. */
const REPORTED = [
  '✗ Lockfile failed supply-chain policy check (229 entries in 3.8s)',
  '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 6 lockfile entries failed verification:',
  '  dsh-mobile-plugin@0.5.71 was published at 2026-11-18T04:56:47.000Z,',
  '  within the minimumReleaseAge cutoff',
  '  dsh-mobile-tailcat-darwin-arm64@1.1.4 was published at 2026-11-18T05:10:00.000Z,',
  '  within the minimumReleaseAge cutoff',
  '  dsh-mobile-tailcat-win32-x64@1.1.4 was published at 2026-11-18T05:10:00.000Z,',
  '  within the minimumReleaseAge cutoff',
].join('\n')

describe('parseReleaseAgeBlockers (#1252)', () => {
  const now = Date.parse('2026-11-18T09:00:00Z')

  it('reads every refused entry with its publish time and when its wait ends', () => {
    const blockers = parseReleaseAgeBlockers(REPORTED, DAY, now)
    expect(blockers).toEqual([
      { name: 'dsh-mobile-plugin', version: '0.5.71', publishedAt: '2026-11-18T04:56:47.000Z', readyAt: '2026-11-19T04:56:47.000Z' },
      { name: 'dsh-mobile-tailcat-darwin-arm64', version: '1.1.4', publishedAt: '2026-11-18T05:10:00.000Z', readyAt: '2026-11-19T05:10:00.000Z' },
      { name: 'dsh-mobile-tailcat-win32-x64', version: '1.1.4', publishedAt: '2026-11-18T05:10:00.000Z', readyAt: '2026-11-19T05:10:00.000Z' },
    ])
  })

  it('expands the brace form the report abbreviated and reads scoped names', () => {
    const output = [
      '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 3 lockfile entries failed verification:',
      '  dsh-mobile-tailcat-{darwin-arm64,linux-x64}@1.1.4 was published at 2026-11-18T05:10:00.000Z,',
      '  @scope/pkg@2.0.0-beta.1 was published at 2026-11-18T06:00:00.000Z,',
    ].join('\n')
    expect(parseReleaseAgeBlockers(output, DAY, now).map(b => `${b.name}@${b.version}`)).toEqual([
      'dsh-mobile-tailcat-darwin-arm64@1.1.4', 'dsh-mobile-tailcat-linux-x64@1.1.4', '@scope/pkg@2.0.0-beta.1',
    ])
  })

  it('records an unreadable time as unknown instead of guessing', () => {
    const output = [
      '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:',
      '  dsh-mobile-plugin@0.5.71 was published at yesterday-ish,',
    ].join('\n')
    expect(parseReleaseAgeBlockers(output, DAY, now)).toEqual([
      { name: 'dsh-mobile-plugin', version: '0.5.71', publishedAt: null, readyAt: null },
    ])
  })

  it('keeps the end unknown when the profile window cannot be read', () => {
    expect(parseReleaseAgeBlockers(REPORTED, null, now)[0]).toMatchObject({
      publishedAt: '2026-11-18T04:56:47.000Z', readyAt: null,
    })
  })

  it('does not trust a window that would already be over (the market and pnpm read different waits)', () => {
    expect(parseReleaseAgeBlockers(REPORTED, 60 * 1000, now)[0]).toMatchObject({ readyAt: null })
  })

  it('ignores refusals that are not about the lockfile', () => {
    expect(parseReleaseAgeBlockers('[ERR_PNPM_NO_MATURE_MATCHING_VERSION] Version 2.0.0 (released 5 minutes ago) of foo does not meet the minimumReleaseAge', DAY, now)).toEqual([])
    expect(parseReleaseAgeBlockers('  foo@1.0.0 was published at 2026-11-18T04:56:47.000Z', DAY, now)).toEqual([])
    expect(parseReleaseAgeBlockers('', DAY, now)).toEqual([])
  })
})

describe('the blocker store (#1252)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dshm-blockers-')); forgetReleaseBlockerMemory() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); forgetReleaseBlockerMemory() })

  const blocker = (readyAt: string | null, name = 'dsh-mobile-plugin', version = '0.5.71') =>
    ({ name, version, publishedAt: null, readyAt })

  it('holds a blocker until its wait ends, then lets go on its own', () => {
    const t0 = Date.parse('2026-11-18T09:00:00Z')
    recordReleaseBlockers(dir, [blocker('2026-11-19T04:56:47.000Z')], t0)
    expect(activeReleaseBlockers(dir, t0 + 1000)).toHaveLength(1)
    expect(activeReleaseBlockers(dir, Date.parse('2026-11-19T04:56:46Z'))).toHaveLength(1)
    expect(activeReleaseBlockers(dir, Date.parse('2026-11-19T04:56:47Z'))).toEqual([])
  })

  it('believes an unknown end only for a short while (same as #961)', () => {
    const t0 = Date.parse('2026-11-18T09:00:00Z')
    recordReleaseBlockers(dir, [blocker(null)], t0)
    expect(activeReleaseBlockers(dir, t0 + UNKNOWN_BLOCKER_TTL_MS - 1)).toHaveLength(1)
    expect(activeReleaseBlockers(dir, t0 + UNKNOWN_BLOCKER_TTL_MS)).toEqual([])
  })

  it('is cleared by a mutation that went through', () => {
    recordReleaseBlockers(dir, [blocker('2999-01-01T00:00:00.000Z')])
    clearReleaseBlockers(dir)
    expect(activeReleaseBlockers(dir)).toEqual([])
  })

  it('lets go of a version the lockfile no longer pins, and keeps the rest', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), [
      "packages:",
      "  dsh-mobile-plugin@0.5.72:",
      "    resolution: {}",
      "  '@scope/pkg@2.0.0':",
      "    resolution: {}",
    ].join('\n'))
    recordReleaseBlockers(dir, [
      blocker('2999-01-01T00:00:00.000Z', 'dsh-mobile-plugin', '0.5.71'),
      blocker('2999-01-01T00:00:00.000Z', '@scope/pkg', '2.0.0'),
    ])
    // 0.5.71 is gone (the lockfile now says 0.5.72); a prefix of a longer version does not count as present either.
    expect(activeReleaseBlockers(dir).map(b => `${b.name}@${b.version}`)).toEqual(['@scope/pkg@2.0.0'])
  })

  it('survives a restart', () => {
    recordReleaseBlockers(dir, [blocker('2999-01-01T00:00:00.000Z')])
    forgetReleaseBlockerMemory()
    expect(activeReleaseBlockers(dir)).toMatchObject([{ name: 'dsh-mobile-plugin', version: '0.5.71' }])
  })

  it('names the unknown one first, otherwise the last to end', () => {
    expect(headlineBlocker([blocker('2999-01-01T00:00:00.000Z', 'a'), blocker('2999-06-01T00:00:00.000Z', 'b')])?.name).toBe('b')
    expect(headlineBlocker([blocker('2999-06-01T00:00:00.000Z', 'b'), blocker(null, 'c')])?.name).toBe('c')
    expect(headlineBlocker([])).toBeNull()
  })
})

describe('the words (#1252)', () => {
  it('names the package and the time, in both languages', () => {
    const message = releaseBlockedMessage({ name: 'dsh-mobile-plugin', version: '0.5.71', publishedAt: null, readyAt: '2026-11-19T04:56:47.000Z' })
    const [zh, en] = message.split(' / ')
    expect(zh).toMatch(/^要等 dsh-mobile-plugin 0\.5\.71 满安全等待期（约 \d\d-\d\d \d\d:\d\d）后才能更新/)
    expect(en).toMatch(/dsh-mobile-plugin 0\.5\.71 has passed the safety wait \(about \d\d-\d\d \d\d:\d\d\)/)
  })

  it('says the time is unknown when it is', () => {
    const message = releaseBlockedMessage({ name: 'dsh-mobile-plugin', version: '0.5.71', publishedAt: null, readyAt: null })
    expect(message).toContain('时间未知')
    expect(message).toContain('time unknown')
    expect(message).not.toMatch(/约 \d/)
  })
})

describe('applyProfileBlockers (#1252)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dshm-blockers-')); forgetReleaseBlockerMemory() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); forgetReleaseBlockerMemory() })

  const status = (over: Partial<UpdateStatus> = {}): UpdateStatus =>
    ({ kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true, ...over })

  it('turns offered updates into a named wait, and leaves the rest alone', () => {
    recordReleaseBlockers(dir, [{ name: 'dsh-mobile-plugin', version: '0.5.71', publishedAt: null, readyAt: '2999-01-01T00:00:00.000Z' }])
    const upToDate = status({ updateAvailable: false, latest: '1.0.0' })
    const held = status({ updateAvailable: false, heldUpdate: { latest: '1.3.0', until: '2999-01-01T00:00:00.000Z' } })
    const out = applyProfileBlockers({ a: status(), b: upToDate, c: held }, dir)
    expect(out.a).toMatchObject({ updateAvailable: false, profileBlocked: { name: 'dsh-mobile-plugin', version: '0.5.71', readyAt: '2999-01-01T00:00:00.000Z' } })
    expect(out.b).toBe(upToDate)
    // The per-target hold (#945) keeps its own field and meaning.
    expect(out.c).toBe(held)
    expect(out.c!.profileBlocked).toBeUndefined()
  })

  it('offers the update again once the wait is over', () => {
    const t0 = Date.parse('2026-11-18T09:00:00Z')
    recordReleaseBlockers(dir, [{ name: 'x', version: '1.0.0', publishedAt: null, readyAt: '2026-11-18T10:00:00.000Z' }], t0)
    const offered = { a: status() }
    expect(applyProfileBlockers(offered, dir, t0 + 1000).a!.updateAvailable).toBe(false)
    expect(applyProfileBlockers(offered, dir, Date.parse('2026-11-18T10:00:01Z'))).toBe(offered)
  })

  it('does nothing when nothing is blocked', () => {
    const offered = { a: status() }
    expect(applyProfileBlockers(offered, dir)).toBe(offered)
  })

  it('holds only the offered updates the caller says the blocker stops', () => {
    recordReleaseBlockers(dir, [{ name: 'x', version: '1.0.0', publishedAt: null, readyAt: '2999-01-01T00:00:00.000Z' }])
    const offered = { a: status(), b: status({ kind: 'github' }) }
    const out = applyProfileBlockers(offered, dir, Date.now(), name => name === 'b')
    expect(out.a).toBe(offered.a)
    expect(out.b).toMatchObject({ updateAvailable: false, profileBlocked: { name: 'x', version: '1.0.0' } })
    expect(applyProfileBlockers(offered, dir, Date.now(), () => false)).toBe(offered)
  })
})
