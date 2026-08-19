import { describe, expect, it } from 'vitest'
import {
  classifyPeer,
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
    const before: CompatibilityAssessment = { risks: [], warnings: [] }
    const after: CompatibilityAssessment = {
      risks: [risk('belowMin')],
      warnings: [],
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
