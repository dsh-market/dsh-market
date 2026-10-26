/** Production selector regression matrix based on research/issue-991/select-mature.test.mjs. */
import { describe, expect, it } from 'vitest'
import { isStableReleaseVersion, selectMatureUpdate, type NpmPackument, type MatureUpdatePolicy } from '../src/release-candidates.ts'

const now = Date.parse('2026-10-25T12:00:00.000Z')
const old = '2026-10-22T00:00:00.000Z'
const fresh = '2026-10-25T11:00:00.000Z'
const policy: MatureUpdatePolicy = { minimumReleaseAgeMs: 1440 * 60_000, latestFromEndpoint: '1.2.0' }

const fixture = (overrides: Partial<NpmPackument> = {}): NpmPackument => ({
  versions: { '1.0.0': {}, '1.1.0': {}, '1.2.0': {} },
  time: { '1.0.0': old, '1.1.0': old, '1.2.0': fresh },
  'dist-tags': { latest: '1.2.0' }, ...overrides,
})
const select = (doc = fixture(), installed = '1.0.0', extra: Partial<MatureUpdatePolicy> = {}) =>
  selectMatureUpdate(doc, installed, now, { ...policy, ...extra })

describe('Issue #991 production mature npm stable selector', () => {
  it('accepts stable build metadata at the API boundary but rejects prerelease', () => {
    expect(isStableReleaseVersion('1.2.3+build.8')).toBe(true)
    expect(isStableReleaseVersion('1.2.3-beta.1')).toBe(false)
    expect(isStableReleaseVersion('01.2.3')).toBe(false)
  })
  it('offers highest mature predecessor while explicitly holding newest', () => {
    const result = select()
    expect(result).toMatchObject({ candidate: '1.1.0', latest: '1.2.0', held: '1.2.0', reason: 'eligible' })
    expect(result.nextMaturityAt).toBe(Date.parse(fresh) + policy.minimumReleaseAgeMs)
  })
  it('holds all young upgrades', () => expect(select(fixture({ time: { '1.0.0': old, '1.1.0': fresh, '1.2.0': fresh } })).candidate).toBeNull())
  it('returns no update when installed is already highest mature', () => expect(select(fixture(), '1.1.0').candidate).toBeNull())
  it('returns no downgrade when installed outranks the latest tag', () => expect(select(fixture(), '1.3.0').candidate).toBeNull())
  it('ranks SemVer instead of publish time', () => expect(select(fixture({ time: { '1.0.0': old, '1.1.0': fresh, '1.2.0': old } })).candidate).toBe('1.2.0'))
  it('rejects missing and invalid publication times', () => {
    expect(select(fixture({ time: { '1.0.0': old, '1.2.0': fresh } })).candidate).toBeNull()
    expect(select(fixture({ time: { '1.0.0': old, '1.1.0': 'yesterday', '1.2.0': fresh } })).candidate).toBeNull()
    expect(select(fixture({ time: { '1.0.0': old, '1.1.0': '2026-02-30T00:00:00Z', '1.2.0': fresh } })).candidate).toBeNull()
  })
  it('does not treat future timestamps as mature', () => {
    expect(select(fixture({ time: { '1.0.0': old, '1.1.0': '2026-10-28T00:00:00Z', '1.2.0': fresh } })).candidate).toBeNull()
  })
  it('rejects mirror latest disagreement both ways', () => {
    expect(select(fixture(), '1.0.0', { latestFromEndpoint: '1.1.0' }).reason).toBe('inconsistent')
    expect(select(fixture(), '1.0.0', { latestFromEndpoint: '1.3.0' }).reason).toBe('inconsistent')
  })
  it('rejects registry tag missing from versions', () => {
    expect(select(fixture({ 'dist-tags': { latest: '1.3.0' } }), '1.0.0', { latestFromEndpoint: '1.3.0' }).reason).toBe('inconsistent')
  })
  it('never offers prerelease on stable', () => {
    const doc = fixture({ versions: { '1.0.0': {}, '1.1.0-beta.1': {}, '1.2.0': {} }, time: { '1.0.0': old, '1.1.0-beta.1': old, '1.2.0': fresh } })
    expect(select(doc).candidate).toBeNull()
  })
  it('respects longer custom wait', () => expect(select(fixture(), '1.0.0', { minimumReleaseAgeMs: 7 * 24 * 3_600_000 }).candidate).toBeNull())
  it('respects exact-version exemption without exempting latest', () => {
    const doc = fixture({ time: { '1.0.0': old, '1.1.0': fresh, '1.2.0': fresh } })
    expect(select(doc, '1.0.0', { exemptVersions: new Set(['1.1.0']) }).candidate).toBe('1.1.0')
  })
  it('honors a verified package-level exclusion', () => expect(select(fixture(), '1.0.0', { exemptPackage: true }).candidate).toBe('1.2.0'))
  it('cannot infer maturity from missing or future timestamps even with an exclusion', () => {
    expect(select(fixture({ time: { '1.0.0': old, '1.2.0': fresh } }), '1.0.0', { exemptPackage: true }).candidate).toBe('1.2.0')
    const absent = fixture({ time: { '1.0.0': old, '1.2.0': fresh } })
    expect(select(absent, '1.0.0', { exemptVersions: new Set(['1.1.0']) }).candidate).toBeNull()
    const future = fixture({ time: { '1.0.0': old, '1.1.0': '2026-10-28T00:00:00Z', '1.2.0': fresh } })
    expect(select(future, '1.0.0', { exemptVersions: new Set(['1.1.0']) }).candidate).toBeNull()
  })
  it('checks an exact compatible lower stable version without treating a young one as exempt', () => {
    expect(select(fixture(), '1.0.0', { maxVersion: '1.1.0' }).candidate).toBe('1.1.0')
    expect(select(fixture(), '1.0.0', { maxVersion: '1.2.0' }).candidate).toBe('1.1.0')
    expect(select(fixture(), '1.0.0', { maxVersion: '1.4.0' }).reason).toBe('inconsistent')
  })
  it('rejects invalid policy and invalid installed version', () => {
    expect(select(fixture(), '1.0.0', { minimumReleaseAgeMs: -1 }).reason).toBe('policy-unknown')
    expect(select(fixture(), 'invalid').reason).toBe('invalid-installed')
  })
  it('keeps a pinned candidate on a new young latest, but recognizes a matured higher candidate', () => {
    const doc = fixture({
      versions: { '1.0.0': {}, '1.1.0': {}, '1.2.0': {}, '1.3.0': {} },
      time: { '1.0.0': old, '1.1.0': old, '1.2.0': fresh, '1.3.0': fresh },
      'dist-tags': { latest: '1.3.0' },
    })
    expect(select(doc, '1.0.0', { latestFromEndpoint: '1.3.0' }).candidate).toBe('1.1.0')
    expect(select(doc, '1.0.0', { latestFromEndpoint: '1.3.0', minimumReleaseAgeMs: 0 }).candidate).toBe('1.3.0')
  })
})
