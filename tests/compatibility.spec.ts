import { describe, expect, it } from 'vitest'
import {
  classifyPeer,
  introducedDuplicateNames,
  introducedRisks,
  type CompatibilityAssessment,
} from '../src/compatibility.ts'

function risk(direction: 'belowMin' | 'aboveMax', over: Partial<{ plugin: string; peer: string; range: string; resolved: string }> = {}) {
  return {
    plugin: over.plugin ?? 'dsh-client-auto-continue',
    peer: over.peer ?? '@deepseek-ai/dsh-settings',
    range: over.range ?? '^0.1.0-rc.7',
    resolved: over.resolved ?? '0.1.0-rc.6',
    direction,
  }
}

describe('classifyPeer', () => {
  it('flags the environment as too old for the declared minimum (the rc.6/rc.7 incident)', () => {
    const verdict = classifyPeer(
      'dsh-client-auto-continue', '@deepseek-ai/dsh-settings',
      '^0.1.0-rc.7', '0.1.0-rc.6', false,
    )
    expect(verdict).toMatchObject({ kind: 'risk', risk: risk('belowMin') })
  })

  it('passes when the resolved version satisfies the declared range', () => {
    expect(classifyPeer('p', 'dsh-settings', '^0.1.0-rc.7', '0.1.0-rc.7', false)).toMatchObject({ kind: 'none' })
  })

  it('does not flag a newer environment against a sloppy caret range', () => {
    // ^0.0.1 resolves to 0.1.0-rc.6 in real profiles; it is a warning, not a risk.
    const verdict = classifyPeer('p', 'dsh-tools', '^0.0.1', '0.1.0-rc.6', false)
    expect(verdict).toMatchObject({
      kind: 'warning',
      warning: { reason: 'aboveMax' },
    })
  })

  it('ignores the npm star-range prerelease artifact', () => {
    expect(classifyPeer('p', 'dsh-agent', '*', '0.1.0-rc.7', false)).toMatchObject({ kind: 'none' })
  })

  it('flags an exact pin when the resolved version is newer', () => {
    const verdict = classifyPeer('p', 'dsh-invariants', '0.1.0-rc.6', '0.1.0-rc.7', false)
    expect(verdict).toMatchObject({ kind: 'risk', risk: risk('aboveMax', { plugin: 'p', peer: 'dsh-invariants', range: '0.1.0-rc.6', resolved: '0.1.0-rc.7' }) })
  })

  it('flags an explicit upper bound when the resolved version exceeds it', () => {
    const verdict = classifyPeer('p', 'dsh-settings', '>=0.1.0-rc.7 <0.2.0', '0.2.0', false)
    expect(verdict).toMatchObject({ kind: 'risk', risk: risk('aboveMax', { plugin: 'p', peer: 'dsh-settings', range: '>=0.1.0-rc.7 <0.2.0', resolved: '0.2.0' }) })
  })

  it('never treats an optional peer as a risk', () => {
    const verdict = classifyPeer('p', 'dsh-tools', '^0.1.0-rc.8', '0.1.0-rc.6', true)
    expect(verdict).toMatchObject({ kind: 'warning', warning: { reason: 'optional' } })
  })

  it('returns none for unparseable ranges and missing resolutions', () => {
    expect(classifyPeer('p', 'x', 'workspace:*', '1.0.0', false)).toMatchObject({ kind: 'none' })
    expect(classifyPeer('p', 'x', '^1.0.0', null, false)).toMatchObject({ kind: 'none' })
  })
})

describe('introducedRisks', () => {
  it('returns only risks that appear after the mutation', () => {
    const before: CompatibilityAssessment = { risks: [], warnings: [], duplicateNames: [] }
    const after: CompatibilityAssessment = {
      risks: [risk('belowMin')],
      warnings: [],
      duplicateNames: [],
    }
    expect(introducedRisks(before, after)).toHaveLength(1)
    expect(introducedRisks(after, after)).toHaveLength(0)
  })

  it('treats a risk that merely changed wording as pre-existing', () => {
    const before: CompatibilityAssessment = { risks: [risk('belowMin', { range: '^0.1.0-rc.7' })], warnings: [] }
    const after: CompatibilityAssessment = { risks: [risk('belowMin', { range: '^0.1.0-rc.7' })], warnings: [] }
    expect(introducedRisks(before, after)).toHaveLength(0)
  })
})

describe('introducedDuplicateNames (#230)', () => {
  const dup = (name: string, layers: string[], count = 2) => ({ name, layers, count })
  const assessment = (duplicateNames: ReturnType<typeof dup>[]): CompatibilityAssessment =>
    ({ risks: [], warnings: [], duplicateNames })

  it('reports a collision the operation introduced', () => {
    const before = assessment([])
    const after = assessment([dup('memory-evolve', ['bundle:dsh-web-app', 'user-patch'])])
    expect(introducedDuplicateNames(before, after)).toEqual([
      dup('memory-evolve', ['bundle:dsh-web-app', 'user-patch']),
    ])
  })

  it('stays silent about a collision the profile already had', () => {
    // duplicateNames is informational precisely because a messy-but-working
    // profile can carry these indefinitely. Re-reporting a pre-existing one
    // would put the operator in front of a problem they did not just cause
    // — and offer a rollback that would not remove it.
    const existing = assessment([dup('memory-evolve', ['bundle:a', 'user-patch'])])
    expect(introducedDuplicateNames(existing, existing)).toEqual([])
  })

  it('keys on the NAME, so a pre-existing collision spreading to another layer stays silent', () => {
    // Same collision, now across three layers. It is worse, but it is not
    // new, and rolling back this operation would not clear it.
    const before = assessment([dup('memory-evolve', ['bundle:a', 'user-patch'], 2)])
    const after = assessment([dup('memory-evolve', ['bundle:a', 'bundle:b', 'user-patch'], 3)])
    expect(introducedDuplicateNames(before, after)).toEqual([])
  })

  it('separates a newly introduced name from pre-existing ones in the same profile', () => {
    const before = assessment([dup('old-clash', ['bundle:a', 'user-patch'])])
    const after = assessment([
      dup('old-clash', ['bundle:a', 'user-patch']),
      dup('new-clash', ['bundle:b', 'user-patch']),
    ])
    expect(introducedDuplicateNames(before, after).map(entry => entry.name)).toEqual(['new-clash'])
  })
})
