import { describe, expect, it } from 'vitest'
import {
  COMPATIBILITY_EVIDENCE_SCHEMA,
  parseCompatibilityEvidenceFeed,
  RADAR_FEED_SCHEMA,
  RADAR_PROJECT_URL,
} from '../src/compatibility-evidence.ts'

const NOW = Date.parse('2026-08-23T12:00:00.000Z')

function cell(status: 'observed-compatible' | 'observed-incompatible' | 'needs-review', due = '2026-08-30T00:00:00.000Z') {
  return {
    artifact: { spec: 'example@1.2.3', sha256: 'a'.repeat(64) },
    dsh: { package: '@deepseek-ai/dsh', version: '0.1.1-rc.2' },
    runtime: { nodeMajor: 22, nodeVersion: '22.23.2', platform: 'linux', architecture: 'x64' },
    executionPlane: 'headless', profile: 'headless', status,
    observedAt: '2026-08-23T00:00:00.000Z', recheckDueAt: due,
    reason: `${status} in an isolated runner`,
  }
}

function feed() {
  return {
    schema: RADAR_FEED_SCHEMA,
    generatedAt: '2026-08-23T01:00:00.000Z',
    producer: { name: 'upstream-radar', repository: RADAR_PROJECT_URL, license: 'Apache-2.0' },
    plugins: [
      {
        catalogUrl: 'https://github.com/Example/Mono/tree/main/packages/plugin',
        cells: [cell('observed-compatible'), cell('observed-incompatible', '2026-08-22T00:00:00.000Z')],
      },
      {
        catalogUrl: 'https://github.com/example/review',
        cells: [cell('observed-compatible'), cell('needs-review')],
      },
      { catalogUrl: 'https://github.com/example/unobserved', cells: [] },
    ],
  }
}

describe('compatibility evidence boundary', () => {
  it('publishes only non-stale exact cells and keeps review neutral', () => {
    const parsed = parseCompatibilityEvidenceFeed(feed(), NOW)
    expect(parsed.schema).toBe(COMPATIBILITY_EVIDENCE_SCHEMA)
    expect(parsed.entries).toHaveLength(2)
    expect(parsed.entries[0]?.catalogUrl).toBe('https://github.com/example/mono/tree/main/packages/plugin')
    expect(parsed.entries[0]?.status).toBe('observed-compatible')
    expect(parsed.entries[0]?.cells).toHaveLength(1)
    expect(parsed.entries[1]?.status).toBe('needs-review')
    expect(parsed.boundary).toContain('not a security review')
  })

  it('does not collapse a monorepo child into its repository root', () => {
    const parsed = parseCompatibilityEvidenceFeed(feed(), NOW)
    expect(parsed.entries.some(entry => entry.catalogUrl === 'https://github.com/example/mono')).toBe(false)
  })

  it('rejects ambiguous duplicate identities instead of guessing', () => {
    const duplicate = feed()
    duplicate.plugins.push({
      catalogUrl: 'https://github.com/example/mono/tree/main/packages/plugin/',
      cells: [cell('observed-compatible')],
    })
    expect(() => parseCompatibilityEvidenceFeed(duplicate, NOW)).toThrow(/duplicate compatibility catalog identity/)
  })

  it('rejects a lookalike producer', () => {
    const lookalike = feed()
    lookalike.producer.repository = 'https://github.com/attacker/upstream-radar'
    expect(() => parseCompatibilityEvidenceFeed(lookalike, NOW)).toThrow(/expected Apache-2.0 upstream-radar source/)
  })
})
