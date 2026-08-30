/**
 * Unit tests for trial boot validation (issue #98, phase 3) — src/trial.ts.
 * Replays the profile composition under a candidate community-bundle order and
 * reports anything that would break the boot (duplicate loader ids, missing
 * bundles, unparseable patches). Exercised against per-test tmpdir fixtures.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump } from 'js-yaml'
import { trialValidate } from '../src/trial.ts'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dshm-trial-'))
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

/** Write the profile manifest with the given bundle stack. */
function writeProfile(dir: string, bundles: string[]): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'web-profile',
    dsh: { profile: { bundles } },
    dependencies: Object.fromEntries(bundles.map(name => [name, '^1.0.0'])),
  }, null, 2))
}

/** Write a dsh bundle package (dsh.bundle.patch entry-list) at base/node_modules/<name>. */
function writeBundle(base: string, name: string, version: string, patch: unknown[]): string {
  const dir = join(base, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(join(dir, 'cordis.patch.yml'), dump(patch))
  return dir
}

describe('shared DSH home resolution', () => {
  it('does not compose the process directory as home when DSH_HOME is empty', () => {
    const dir = pdir('blank-home-profile')
    const cwd = pdir('blank-home-cwd')
    const previousCwd = process.cwd()
    writeProfile(dir, [])
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'blank-home-trap', name: 'must-not-load' }] },
    ]))
    process.env.DSH_HOME = ''

    try {
      process.chdir(cwd)
      const result = trialValidate(dir, [], { dshInstallDir: null })
      expect(result.rows.map(row => row.id)).not.toContain('blank-home-trap')
    } finally {
      process.chdir(previousCwd)
    }
  })
})

/** #369: on DSH Desktop the in-box bundles come from the app bundle, and the
 * install directory is not discoverable from process.argv[1]. Trial
 * validation then judged the profile unbootable and the update route rolled
 * a good build back — the reporter's own `dsh --dump-config` exited 0 on the
 * same profile, with the files already updated on disk. */
describe('an unlocatable in-box bundle must not fail the trial (#369)', () => {
  it('passes the trial, so a legitimate update is not rolled back', () => {
    const dir = pdir()
    writeProfile(dir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-smooth-stream'])
    // Only the community plugin is on disk — the Desktop shape exactly.
    writeBundle(dir, 'dsh-smooth-stream', '0.4.1', [{ insert: [{ id: 'smooth', name: 'dsh-smooth-stream' }] }])

    const result = trialValidate(dir, ['dsh-smooth-stream'], {
      dshInstallDir: null,
      homeDir: join(tmp, 'empty-home'),
    })

    expect(result.errors.map(e => e.message).join('\n')).not.toMatch(/is not installed/)
    expect(result.ok, 'a passing composition was called unbootable').toBe(true)
  })

  it('ignores a stale profile copy that the hidden in-box host outranks', () => {
    const dir = pdir()
    writeProfile(dir, ['@deepseek-ai/dsh-base', 'dsh-smooth-stream'])
    const stale = join(dir, 'node_modules', '@deepseek-ai', 'dsh-base')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-base',
      version: '0.0.1',
      dsh: {},
    }))
    writeBundle(dir, 'dsh-smooth-stream', '0.4.1', [{ insert: [{ id: 'smooth' }] }])

    const result = trialValidate(dir, ['dsh-smooth-stream'], {
      dshInstallDir: null,
      homeDir: join(tmp, 'empty-home'),
    })

    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('detects conflicts through the healed parent fallback behind a stale direct shadow', () => {
    const dir = pdir('profiles/web')
    writeProfile(dir, ['@deepseek-ai/dsh-base', 'dsh-smooth-stream'])
    const stale = join(dir, 'node_modules', '@deepseek-ai', 'dsh-base')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-base',
      version: '0.0.1',
      dsh: {},
    }))
    writeBundle(
      join(tmp, 'profiles'),
      '@deepseek-ai/dsh-base',
      '4.0.1',
      [{ insert: [{ id: 'shared-entry', name: 'host-base' }] }],
    )
    writeBundle(dir, 'dsh-smooth-stream', '0.4.1', [
      { insert: [{ id: 'shared-entry', name: 'smooth' }] },
    ])

    const result = trialValidate(dir, ['dsh-smooth-stream'], {
      dshInstallDir: null,
      homeDir: join(tmp, 'empty-home'),
    })

    expect(result.ok).toBe(false)
    expect(result.errors.some(issue => issue.message.includes('duplicate'))).toBe(true)
    expect(result.duplicates).toHaveLength(1)
    expect(result.duplicates[0]).toMatchObject({
      id: 'shared-entry',
      count: 2,
      layers: ['@deepseek-ai/dsh-base', 'dsh-smooth-stream'],
    })
  })

  it('still fails the trial for a COMMUNITY bundle that really is absent', () => {
    const dir = pdir()
    writeProfile(dir, ['@deepseek-ai/dsh-base', 'ghost-bundle'])

    const result = trialValidate(dir, ['ghost-bundle'], {
      dshInstallDir: null,
      homeDir: join(tmp, 'empty-home'),
    })

    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.layer === 'ghost-bundle')).toBe(true)
  })
})

describe('trialValidate (#98 trial boot)', () => {
  it('flags a candidate order where two bundles insert the same loader entry id', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha', 'beta'])
    writeBundle(dir, 'alpha', '1.0.0', [{ insert: [{ id: 'dup-entry', name: 'alpha' }] }])
    writeBundle(dir, 'beta', '1.0.0', [{ insert: [{ id: 'dup-entry', name: 'beta' }] }])

    const result = trialValidate(dir, ['beta', 'alpha'])
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.message.includes('duplicate'))).toBe(true)
    expect(result.duplicates).toHaveLength(1)
    expect(result.duplicates[0]?.id).toBe('dup-entry')
    expect(result.duplicates[0]?.count).toBe(2)
    expect(result.duplicates[0]?.layers).toEqual(['beta', 'alpha'])
  })

  it('flags a bundle whose package is listed but not installed', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha', 'beta'])
    writeBundle(dir, 'alpha', '1.0.0', [{ insert: [{ id: 'alpha-entry' }] }])
    // beta is in dsh.profile.bundles but has no node_modules directory.

    const result = trialValidate(dir, ['alpha', 'beta'])
    expect(result.ok).toBe(false)
    const issue = result.errors.find(e => e.layer === 'beta')
    expect(issue?.message).toContain('not installed')
  })

  it('resolves a bundle hoisted only to the workspace root node_modules (#98 review B1)', () => {
    // dsh layouts share <profiles>/node_modules as the workspace root: the
    // bundle package lives at tmp/node_modules/bundle-a, NOT inside the
    // profile's own node_modules. The trial replays the same resolution as
    // the check report (buildBundleLayers / createRequire upward search), so
    // it must accept the candidate instead of reporting the bundle missing.
    const dir = pdir() // tmp/profile
    writeProfile(dir, ['bundle-a'])
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

    const result = trialValidate(dir, ['bundle-a'])
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.rows.map(r => r.id)).toEqual(['a-entry'])
    expect(result.rows[0]?.layer).toBe('bundle-a')
  })

  it('flags an unparseable patch and a missing declared patch', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha', 'beta'])
    // alpha: patch file exists but is a YAML mapping, not an entry list.
    const alphaDir = writeBundle(dir, 'alpha', '1.0.0', [{ insert: [{ id: 'alpha-entry' }] }])
    writeFileSync(join(alphaDir, 'cordis.patch.yml'), 'foo: bar')
    // beta: declares a patch that does not exist on disk.
    const betaDir = join(dir, 'node_modules', 'beta')
    mkdirSync(betaDir, { recursive: true })
    writeFileSync(join(betaDir, 'package.json'), JSON.stringify({
      name: 'beta',
      version: '1.0.0',
      dsh: { bundle: { patch: './missing.yml' } },
    }))

    const result = trialValidate(dir, ['alpha', 'beta'])
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.layer === 'alpha' && e.message.includes('not a valid entry list'))).toBe(true)
    expect(result.errors.some(e => e.layer === 'beta' && e.message.includes('missing'))).toBe(true)
  })

  it('flags an unparseable user cordis.patch.yml', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha'])
    writeBundle(dir, 'alpha', '1.0.0', [{ insert: [{ id: 'alpha-entry' }] }])
    writeFileSync(join(dir, 'cordis.patch.yml'), 'foo: bar')

    const result = trialValidate(dir, ['alpha'])
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.layer === 'user-patch' && e.message.includes('not a valid entry list'))).toBe(true)
  })

  it('accepts a legal permutation and reports the composed rows in candidate order', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha', 'beta'])
    writeBundle(dir, 'alpha', '1.0.0', [{ insert: [{ id: 'alpha-entry', name: 'alpha' }] }])
    writeBundle(dir, 'beta', '1.0.0', [{ insert: [{ id: 'beta-entry', name: 'beta' }] }])

    const result = trialValidate(dir, ['beta', 'alpha'])
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.duplicates).toEqual([])
    expect(result.rows.map(r => r.id)).toEqual(['beta-entry', 'alpha-entry'])
    expect(result.rows.map(r => r.layer)).toEqual(['beta', 'alpha'])
  })

  it('keeps official in-box bundles leading under the candidate order', () => {
    const dir = pdir()
    writeProfile(dir, ['@deepseek-ai/dsh-base', 'alpha', 'beta'])
    writeBundle(dir, '@deepseek-ai/dsh-base', '4.0.1', [{ insert: [{ id: 'base-entry', name: 'dsh-base' }] }])
    writeBundle(dir, 'alpha', '1.0.0', [{ insert: [{ id: 'alpha-entry', name: 'alpha' }] }])
    writeBundle(dir, 'beta', '1.0.0', [{ insert: [{ id: 'beta-entry', name: 'beta' }] }])

    const result = trialValidate(dir, ['beta', 'alpha'], { dshInstallDir: dir })
    expect(result.ok).toBe(true)
    expect(result.rows.map(r => r.id)).toEqual(['base-entry', 'beta-entry', 'alpha-entry'])
  })

  it('rejects candidate orders that do not match the current bundle set', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha', 'beta'])
    writeBundle(dir, 'alpha', '1.0.0', [{ insert: [{ id: 'alpha-entry' }] }])
    writeBundle(dir, 'beta', '1.0.0', [{ insert: [{ id: 'beta-entry' }] }])

    // Unknown bundle: mergeOrder rejects it as not reorderable, before any layer work.
    const unknown = trialValidate(dir, ['alpha', 'unknown'])
    expect(unknown.ok).toBe(false)
    expect(unknown.errors.some(e => e.layer === '(order)' && e.message.includes('unknown'))).toBe(true)

    // Duplicates trip mergeOrder's duplicate check.
    const dup = trialValidate(dir, ['alpha', 'alpha'])
    expect(dup.ok).toBe(false)
    expect(dup.errors.some(e => e.layer === '(order)' && e.message.includes('duplicate'))).toBe(true)

    // Omissions trip mergeOrder's permutation check.
    const omit = trialValidate(dir, ['alpha'])
    expect(omit.ok).toBe(false)
    expect(omit.errors.some(e => e.layer === '(order)' && e.message.includes('exactly the current community bundles'))).toBe(true)
  })

  it('reports what the reorder changes: overrides / orphans / duplicates introduced by the candidate (issue #125 review)', () => {
    // beta inserts the entry id `shared`; alpha's patch row patches it. Under
    // the CURRENT order [alpha, beta] alpha's patch runs before beta's insert,
    // so it is an orphan; under the CANDIDATE [beta, alpha] it resolves and
    // becomes an override (alpha overrides beta's row).
    const dir = pdir()
    writeProfile(dir, ['alpha', 'beta'])
    writeBundle(dir, 'alpha', '1.0.0', [{ id: 'shared' }])
    writeBundle(dir, 'beta', '1.0.0', [{ insert: [{ id: 'shared', name: 'beta' }] }])

    const result = trialValidate(dir, ['beta', 'alpha'])
    expect(result.ok).toBe(true)
    // The candidate introduces an override that the current composition lacks.
    expect(result.diff.overrides.some(o => o.id === 'shared' && o.layer === 'alpha' && o.overriddenLayers.includes('beta'))).toBe(true)
    // The candidate has no new orphans (the orphan existed only under the
    // current order) and no new duplicate loader ids.
    expect(result.diff.orphans).toEqual([])
    expect(result.diff.duplicates).toEqual([])
  })
})
