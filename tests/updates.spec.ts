/**
 * Version-direction unit tests for update detection (#64).
 *
 * The reported failure: `@deepseek-ai/dsh-web-fetch-http` was pinned at
 * 0.1.0-rc.6 while the registry's `latest` dist-tag was still on the first
 * release, 0.0.1-rc.5. Detection compared with `!==`, so the older tag read
 * as "an update", and applying it downgraded the profile until it wouldn't
 * boot. Direction — not inequality — is what decides.
 */

import { describe, expect, it } from 'vitest'
import { compareVersions, isUpgrade } from '../src/updates.ts'

describe('compareVersions', () => {
  it('orders by major, minor, then patch', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0)
    expect(compareVersions('1.2.3', '1.2.10')).toBeLessThan(0)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('compares numerically, not lexically', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0)
  })

  it('ranks a release above any prerelease of the same core', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
  })

  it('orders prerelease identifiers per semver precedence', () => {
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc')).toBeGreaterThan(0)
    // Numeric identifiers rank below alphanumeric ones.
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
  })

  it('reproduces the precedence chain from the semver spec', () => {
    const ordered = [
      '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta',
      '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0',
    ]
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareVersions(ordered[i], ordered[i + 1])).toBeLessThan(0)
      expect(compareVersions(ordered[i + 1], ordered[i])).toBeGreaterThan(0)
    }
  })

  it('ignores build metadata', () => {
    expect(compareVersions('1.2.3+build.5', '1.2.3')).toBe(0)
  })

  it('returns null when either side is not plain semver', () => {
    expect(compareVersions('^1.2.3', '1.2.3')).toBeNull()
    expect(compareVersions('1.2', '1.2.3')).toBeNull()
    expect(compareVersions('latest', '1.2.3')).toBeNull()
  })
})

describe('isUpgrade', () => {
  it('reports an upgrade only when latest is genuinely newer', () => {
    expect(isUpgrade('1.0.0', '1.2.0')).toBe(true)
    expect(isUpgrade('1.0.0-rc.1', '1.0.0')).toBe(true)
  })

  it('does not treat an equal version as an update', () => {
    expect(isUpgrade('1.2.0', '1.2.0')).toBe(false)
  })

  it('does not treat a LOWER latest dist-tag as an update (#64)', () => {
    // The exact versions from the report.
    expect(isUpgrade('0.1.0-rc.6', '0.0.1-rc.5')).toBe(false)
    expect(isUpgrade('2.0.0', '1.9.9')).toBe(false)
  })

  it('reports no update when a version is missing or undecidable', () => {
    expect(isUpgrade(null, '1.2.0')).toBe(false)
    expect(isUpgrade('1.0.0', null)).toBe(false)
    expect(isUpgrade('not-a-version', '1.2.0')).toBe(false)
  })
})
