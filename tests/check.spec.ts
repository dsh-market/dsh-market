/**
 * Unit tests for the profile composition diagnostics (issue #98, phase 1) —
 * src/check.ts. Pure filesystem analysis, exercised against per-test tmpdir
 * fixtures (same pattern as tests/profile.spec.ts): the profile directory is
 * constructed manually under a mkdtemp tmpdir, and DSH_HOME is pointed there
 * so the home-level cordis.patch.yml layer can never leak into a test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump } from 'js-yaml'
import {
  analyzeProfile,
  compareSemver,
  corePackageNames,
  satisfiesRange,
} from '../src/check.ts'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dshm-check-'))
  process.env.DSH_HOME = tmp
})
afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(tmp, { recursive: true, force: true })
})

/** A fresh profile directory inside the per-test tmpdir. */
function pdir(name = 'profile'): string {
  return join(tmp, name)
}

/** Write the profile manifest (package.json) into `dir`. */
function writeProfile(dir: string, manifest: unknown): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
}

/** Write a package manifest at base/node_modules/<name>. */
function writePackage(base: string, name: string, manifest: unknown): string {
  const dir = join(base, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  return dir
}

/** Write a dsh bundle package (dsh.bundle.patch entry-list) at base/node_modules/<name>. */
function writeBundle(base: string, name: string, version: string, patch: unknown[]): string {
  const dir = writePackage(base, name, {
    name,
    version,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  writeFileSync(join(dir, 'cordis.patch.yml'), dump(patch))
  return dir
}

describe('bundle stack (#98 diagnostics)', () => {
  it('keeps dsh.profile.bundles order and classifies official vs community', () => {
    const dir = pdir()
    writeProfile(dir, {
      name: 'web-profile',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-market'] } },
      dependencies: { '@deepseek-ai/dsh-base': '^4.0.1', 'dsh-market': '^1.9.0' },
    })
    writeBundle(dir, '@deepseek-ai/dsh-base', '4.0.1', [
      { insert: [{ id: 'dsh-base', name: 'dsh-base' }] },
    ])
    writeBundle(dir, 'dsh-market', '1.9.0', [
      { insert: [{ id: 'dsh-market', name: 'dshmarket' }] },
    ])

    const report = analyzeProfile(dir)

    // Order comes straight from dsh.profile.bundles.
    expect(report.bundles.map(b => b.name)).toEqual(['@deepseek-ai/dsh-base', 'dsh-market'])
    // Classification: in-box dsh bundle vs community plugin.
    expect(report.bundles[0]?.kind).toBe('official')
    expect(report.bundles[1]?.kind).toBe('community')
    // Dependency spec and resolved location.
    expect(report.bundles[0]?.source).toBe('^4.0.1')
    expect(report.bundles[1]?.source).toBe('^1.9.0')
    expect(report.bundles[0]?.directory).not.toBeNull()
    expect(report.bundles[0]?.patchPath).not.toBeNull()
    expect(report.bundles[0]?.error).toBeNull()
    // Loader entries collected from each layer's patch, in stack order.
    expect(report.bundles[0]?.entries).toEqual(['dsh-base'])
    expect(report.bundles[1]?.entries).toEqual(['dsh-market'])
    expect(report.rows.map(r => r.id)).toEqual(['dsh-base', 'dsh-market'])
    expect(report.summary.ok).toBe(true)
  })

  it('flags a bundle whose package directory is missing as a boot failure', () => {
    const dir = pdir()
    writeProfile(dir, {
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'missing-bundle'] } },
      dependencies: { '@deepseek-ai/dsh-base': '^4.0.1', 'missing-bundle': '^1.0.0' },
    })
    writeBundle(dir, '@deepseek-ai/dsh-base', '4.0.1', [{ insert: [{ id: 'x' }] }])

    const report = analyzeProfile(dir)
    const missing = report.bundles.find(b => b.name === 'missing-bundle')
    expect(missing).toBeDefined()
    expect(missing?.directory).toBeNull()
    expect(missing?.error).not.toBeNull()
    expect(report.summary.errors.some(e => e.includes('missing-bundle'))).toBe(true)
    expect(report.summary.ok).toBe(false)
  })
})

describe('workspace-root hoisted bundles (#98 review B1)', () => {
  it('resolves a bundle that physically lives only in the parent node_modules', () => {
    // dsh layouts share <profiles>/node_modules as the workspace root: the
    // bundle package is NOT inside the profile's own node_modules, only at
    // tmp/node_modules/bundle-a. createRequire's upward search (the same
    // resolution the boot uses) must find it.
    const dir = pdir() // tmp/profile
    writeProfile(dir, {
      name: 'web-profile',
      dsh: { profile: { bundles: ['bundle-a'] } },
      dependencies: { 'bundle-a': '^1.0.0' },
    })
    const root = join(tmp, 'node_modules', 'bundle-a')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'bundle-a',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(root, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'a-entry', name: 'bundle-a' }] },
    ]))
    // Guard the fixture itself: the profile must NOT carry a local copy.
    expect(existsSync(join(dir, 'node_modules', 'bundle-a'))).toBe(false)

    const report = analyzeProfile(dir)
    const bundle = report.bundles[0]
    expect(bundle?.name).toBe('bundle-a')
    expect(bundle?.error).toBeNull()
    expect(bundle?.parseError).toBeNull()
    expect(bundle?.entries).toEqual(['a-entry'])
    expect(bundle?.directory).toBe(root)
    expect(report.rows.map(r => r.id)).toEqual(['a-entry'])
    expect(report.summary.ok).toBe(true)
  })
})

describe('duplicate loader entry ids (#98 boot failure)', () => {
  it('detects an id inserted by both a bundle patch and the user cordis.patch.yml', () => {
    const dir = pdir()
    writeProfile(dir, {
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      dependencies: { '@deepseek-ai/dsh-base': '^4.0.1' },
    })
    writeBundle(dir, '@deepseek-ai/dsh-base', '4.0.1', [
      { insert: [{ id: 'shared-entry', name: 'from-bundle' }] },
    ])
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'shared-entry', name: 'from-user' }] },
    ]))

    const report = analyzeProfile(dir)
    const dup = report.duplicates.find(d => d.id === 'shared-entry')
    expect(dup).toBeDefined()
    expect(dup?.id).toBe('shared-entry')
    expect(dup?.count).toBe(2)
    expect(dup?.layers).toContain('@deepseek-ai/dsh-base')
    expect(dup?.layers).toContain('user-patch')
    expect(report.summary.errors.some(e => e.includes('duplicate'))).toBe(true)
    expect(report.summary.ok).toBe(false)
  })
})

describe('core package shadowing (#98 repro scenario)', () => {
  it('flags a plugin pulling @deepseek-ai/dsh-tools whose hoisted copy shadows the host version', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    // The dsh-excel-chat failure mode: the plugin declares a core host
    // package as an ordinary dependency.
    writePackage(dir, 'dsh-excel-chat', {
      name: 'dsh-excel-chat',
      version: '1.0.0',
      dependencies: { '@deepseek-ai/dsh-tools': '^0.0.1-rc.1' },
    })
    // The plugin's copy hoisted to the profile root.
    writePackage(dir, '@deepseek-ai/dsh-tools', {
      name: '@deepseek-ai/dsh-tools',
      version: '0.0.1-rc.1',
    })
    // A fake host installation with the real (different) core version.
    const host = join(tmp, 'host-install')
    writePackage(host, '@deepseek-ai/dsh-tools', {
      name: '@deepseek-ai/dsh-tools',
      version: '0.1.0-rc.6',
    })
    mkdirSync(host, { recursive: true })
    writeFileSync(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))

    const report = analyzeProfile(dir, { dshInstallDir: host })
    const issue = report.coreDeps.find(
      d => d.plugin === 'dsh-excel-chat' && d.name === '@deepseek-ai/dsh-tools',
    )
    expect(issue).toBeDefined()
    expect(issue?.spec).toBe('^0.0.1-rc.1')
    expect(issue?.section).toBe('dependencies')
    expect(issue?.hoisted).toBe('0.0.1-rc.1')
    expect(issue?.nested).toBeNull()
    expect(issue?.host).toBe('0.1.0-rc.6')
    expect(issue?.shadowing).toBe(true)
    expect(report.summary.errors.some(e => e.includes('shadowing'))).toBe(true)
    expect(report.summary.ok).toBe(false)
  })
})

describe('duplicate loader entry names (#98 opt: runtime shadowing)', () => {
  it('detects two rows sharing one name across layers (not a boot failure, but a warning)', () => {
    const dir = pdir()
    writeProfile(dir, {
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      dependencies: { '@deepseek-ai/dsh-base': '^4.0.1' },
    })
    writeBundle(dir, '@deepseek-ai/dsh-base', '4.0.1', [
      { insert: [{ id: 'one', name: 'same-plugin' }] },
    ])
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'two', name: 'same-plugin' }] },
    ]))

    const report = analyzeProfile(dir)
    const dup = report.duplicateNames.find(d => d.name === 'same-plugin')
    expect(dup).toBeDefined()
    expect(dup?.count).toBe(2)
    expect(dup?.layers).toContain('@deepseek-ai/dsh-base')
    expect(dup?.layers).toContain('user-patch')
    // Distinct ids, so NOT a boot failure — only a runtime-shadowing warning.
    expect(report.summary.errors.some(e => e.includes('duplicate loader entry id'))).toBe(false)
    expect(report.summary.warnings.some(w => w.includes('duplicate loader entry name'))).toBe(true)
  })
})

describe('peer checks cover every plugin (#98 opt: plugin-to-plugin peers)', () => {
  it('flags a peer mismatch on a NON-core package', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writePackage(dir, 'plugin-a', {
      name: 'plugin-a',
      version: '1.0.0',
      peerDependencies: { 'community-lib': '^2.0.0' },
    })
    writePackage(dir, 'community-lib', { name: 'community-lib', version: '1.5.0' })

    const report = analyzeProfile(dir)
    const mismatch = report.peerMismatches.find(
      m => m.plugin === 'plugin-a' && m.name === 'community-lib',
    )
    expect(mismatch).toBeDefined()
    expect(mismatch?.satisfied).toBe(false)
    expect(report.summary.warnings.some(w => w.includes('community-lib'))).toBe(true)
  })

  it('reports a peer dependency that is not installed at all (info-level, no summary warning)', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writePackage(dir, 'plugin-b', {
      name: 'plugin-b',
      version: '1.0.0',
      peerDependencies: { 'missing-peer': '^1.0.0' },
    })

    const report = analyzeProfile(dir)
    const mismatch = report.peerMismatches.find(
      m => m.plugin === 'plugin-b' && m.name === 'missing-peer',
    )
    expect(mismatch).toBeDefined()
    expect(mismatch?.resolved).toBeNull()
    expect(mismatch?.satisfied).toBeNull()
    // Un-evaluable peers stay in the list but do not pollute the summary.
    expect(report.summary.warnings.some(w => w.includes('missing-peer'))).toBe(false)
  })
})

describe('suggestedOrder (#98 opt: LOOT-style auto-fix)', () => {
  it('suggests a compliant community order when rules are violated', () => {
    const dir = pdir()
    writeProfile(dir, {
      dsh: { profile: { bundles: ['a', 'b'] } },
      dependencies: {},
    })
    // b declares after a → current order [a, b] already satisfies it; force a
    // violation by having a declare after b with order [a, b].
    writeBundle(dir, 'a', '1.0.0', [{ insert: [{ id: 'a' }] }])
    writeBundle(dir, 'b', '1.0.0', [{ insert: [{ id: 'b' }] }])
    writeFileSync(join(dir, 'node_modules', 'a', 'package.json'), JSON.stringify({
      name: 'a',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml', order: { after: ['b'] } } },
    }))

    const report = analyzeProfile(dir)
    expect(report.suggestedOrder?.ok).toBe(true)
    if (report.suggestedOrder?.ok === true) {
      expect(report.suggestedOrder.order).toEqual(['b', 'a'])
    }
    // The violation itself surfaces as a warning + orderConflicts.
    expect(report.orderConflicts.some(c => c.name === 'a')).toBe(true)
  })
})

describe('peer range mismatch', () => {
  // ^0.1.0 := >=0.1.0 <0.2.0 (exclusive upper bound), so resolved 0.2.0
  // must be reported as unsatisfied.
  it('marks satisfied=false when resolved 0.2.0 is outside ^0.1.0', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writePackage(dir, 'plugin-x', {
      name: 'plugin-x',
      version: '1.0.0',
      peerDependencies: { '@deepseek-ai/dsh-llm': '^0.1.0' },
    })
    // Resolved core version hoisted at the profile root.
    writePackage(dir, '@deepseek-ai/dsh-llm', {
      name: '@deepseek-ai/dsh-llm',
      version: '0.2.0',
    })

    const report = analyzeProfile(dir)
    const mismatch = report.peerMismatches.find(
      m => m.plugin === 'plugin-x' && m.name === '@deepseek-ai/dsh-llm',
    )
    expect(mismatch).toBeDefined()
    expect(mismatch?.range).toBe('^0.1.0')
    expect(mismatch?.resolved).toBe('0.2.0')
    expect(mismatch?.satisfied).toBe(false)
    expect(report.summary.warnings.some(w => w.includes('does not match'))).toBe(true)
  })
})

describe('pnpm-lock.yaml multi-version core packages', () => {
  it('reports both lockfile resolutions of @deepseek-ai/dsh-tools', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writeFileSync(join(dir, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '  .:',
      '    dependencies:',
      "      '@deepseek-ai/dsh-tools':",
      '        specifier: ^0.0.1-rc.1',
      '        version: 0.0.1-rc.1',
      '',
      'packages:',
      "  '@deepseek-ai/dsh-tools@0.0.1-rc.1':",
      '    version: 0.0.1-rc.1',
      "  '@deepseek-ai/dsh-tools@0.1.0-rc.6':",
      '    version: 0.1.0-rc.6',
      '',
    ].join('\n'))

    const report = analyzeProfile(dir)
    const mv = report.multiVersion.find(m => m.name === '@deepseek-ai/dsh-tools')
    expect(mv).toBeDefined()
    expect(mv?.versions).toEqual(['0.0.1-rc.1', '0.1.0-rc.6'])
    expect(mv?.versions.length).toBe(2)
    expect(report.summary.errors.some(e => e.includes('multiple versions of core package'))).toBe(true)
    expect(report.summary.ok).toBe(false)
  })
})

describe('satisfiesRange', () => {
  it('matches caret ranges', () => {
    expect(satisfiesRange('1.2.3', '^1.2.0')).toBe(true)
    expect(satisfiesRange('1.9.9', '^1.2.0')).toBe(true)
    expect(satisfiesRange('1.1.9', '^1.2.0')).toBe(false)
    expect(satisfiesRange('2.0.1', '^1.2.0')).toBe(false)
    // Regression: the npm upper bound is EXCLUSIVE — versions exactly at the
    // next breaking bump must not satisfy (previously wrongly accepted).
    expect(satisfiesRange('2.0.0', '^1.2.0')).toBe(false)
    expect(satisfiesRange('0.2.0', '^0.1.0')).toBe(false)
    expect(satisfiesRange('0.0.4', '^0.0.3')).toBe(false)
  })

  it('matches tilde ranges', () => {
    expect(satisfiesRange('1.2.0', '~1.2.0')).toBe(true)
    expect(satisfiesRange('1.2.9', '~1.2.0')).toBe(true)
    expect(satisfiesRange('1.1.9', '~1.2.0')).toBe(false)
    expect(satisfiesRange('1.3.1', '~1.2.0')).toBe(false)
    // Regression: same exclusive-upper-bound rule for ~ (next minor bump).
    expect(satisfiesRange('1.3.0', '~1.2.0')).toBe(false)
    expect(satisfiesRange('0.2.0', '~0.1.0')).toBe(false)
  })

  it('matches >= and exact ranges', () => {
    expect(satisfiesRange('1.2.0', '>=1.2.0')).toBe(true)
    expect(satisfiesRange('1.2.3', '>=1.2.0')).toBe(true)
    expect(satisfiesRange('1.1.9', '>=1.2.0')).toBe(false)
    expect(satisfiesRange('1.2.3', '1.2.3')).toBe(true)
    expect(satisfiesRange('1.2.4', '1.2.3')).toBe(false)
  })

  it('handles prerelease comparisons against caret ranges', () => {
    expect(satisfiesRange('0.1.0-rc.6', '^0.1.0-rc.6')).toBe(true)
    expect(satisfiesRange('0.1.0', '^0.1.0-rc.6')).toBe(true)
    expect(satisfiesRange('0.0.1-rc.1', '^0.1.0-rc.6')).toBe(false)
    expect(satisfiesRange('0.2.1', '^0.1.0-rc.6')).toBe(false)
  })

  it('matches wildcard, compound and || ranges; unknown ranges are null', () => {
    expect(satisfiesRange('1.2.3', '*')).toBe(true)
    expect(satisfiesRange('1.5.0', '>=1.2.0 <2.0.0')).toBe(true)
    expect(satisfiesRange('2.1.0', '>=1.2.0 <2.0.0')).toBe(false)
    expect(satisfiesRange('2.0.0', '^1.0.0 || ^2.0.0')).toBe(true)
    expect(satisfiesRange('0.5.0', '^1.0.0 || ^2.0.0')).toBe(false)
    expect(satisfiesRange('1.2.3', 'workspace:*')).toBeNull()
  })
})

describe('compareSemver', () => {
  it('compares releases, prereleases and prerelease ordering', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
    expect(compareSemver('1.2.3', '1.2.4')).toBe(-1)
    expect(compareSemver('1.2.3', '1.2.2')).toBe(1)
    expect(compareSemver('1.0.0', '0.9.9')).toBe(1)
    // Prerelease of the same base sorts below the release.
    expect(compareSemver('0.1.0-rc.6', '0.1.0')).toBe(-1)
    expect(compareSemver('0.1.0', '0.1.0-rc.6')).toBe(1)
    expect(compareSemver('0.1.0-rc.6', '0.1.0-rc.6')).toBe(0)
    expect(compareSemver('0.1.0-rc.6', '0.1.0-rc.7')).toBe(-1)
    // Comparator contract is the SIGN (callers sort / test >=0): the raw
    // numeric difference (10-6=4) is not normalized to ±1 by check.ts.
    expect(compareSemver('0.1.0-rc.10', '0.1.0-rc.6')).toBeGreaterThan(0)
  })
})

describe('corePackageNames', () => {
  it('reads the host install inventory plus the curated seed', () => {
    const host = join(tmp, 'host-install')
    writePackage(host, '@deepseek-ai/dsh-tools', { name: '@deepseek-ai/dsh-tools', version: '0.1.0-rc.6' })
    writePackage(host, '@deepseek-ai/cordis-plugin-timer', { name: '@deepseek-ai/cordis-plugin-timer', version: '4.0.1' })
    writePackage(host, '@deepseek-ai/notcore', { name: '@deepseek-ai/notcore', version: '1.0.0' })
    mkdirSync(host, { recursive: true })
    writeFileSync(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))

    const core = corePackageNames(host)
    expect(core.has('@deepseek-ai/dsh-tools')).toBe(true) // install inventory (dsh*)
    expect(core.has('@deepseek-ai/cordis-plugin-timer')).toBe(true) // install inventory (cordis*)
    expect(core.has('@deepseek-ai/dsh')).toBe(true) // install manifest name
    expect(core.has('@deepseek-ai/notcore')).toBe(false) // scope names without dsh/cordis prefix
    expect(core.has('@deepseek-ai/dsh-llm')).toBe(true) // curated seed fallback
  })

  it('falls back to the curated seed when no install dir is readable', () => {
    const core = corePackageNames(null)
    expect(core.has('@deepseek-ai/dsh-tools')).toBe(true)
    expect(core.has('@deepseek-ai/dsh-llm')).toBe(true)
    expect(core.has('@deepseek-ai/dsh')).toBe(true)
  })
})
