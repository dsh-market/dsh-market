/**
 * Unit tests for named plugin presets (issue #98, phase 3) — src/presets.ts.
 * Save / list / delete / apply of composition presets, exercised against
 * per-test tmpdir fixtures (same pattern as tests/check.spec.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump } from 'js-yaml'
import { applyPreset, deletePreset, listPresets, previewPreset, savePreset } from '../src/presets.ts'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dshm-preset-'))
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

/** Write the market state.json (disable list + groups). */
function writeState(dir: string, disabled: string[]): void {
  mkdirSync(join(dir, '.dsh-market'), { recursive: true })
  writeFileSync(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ disabled, groups: {}, groupOrder: [] }))
}

/** Write a raw presets.json file. */
function writePresetFile(dir: string, presets: unknown[]): void {
  mkdirSync(join(dir, '.dsh-market'), { recursive: true })
  writeFileSync(join(dir, '.dsh-market', 'presets.json'), JSON.stringify({ presets }))
}

describe('savePreset', () => {
  it('rejects invalid names', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha'])

    expect(savePreset(dir, '', ['alpha'], [])).toMatchObject({ ok: false, error: 'invalid preset name / 组合名称无效' })
    expect(savePreset(dir, 'bad/name', ['alpha'], [])).toMatchObject({ ok: false })
    expect(savePreset(dir, 'with?mark', ['alpha'], [])).toMatchObject({ ok: false })
    expect(savePreset(dir, 'x'.repeat(41), ['alpha'], [])).toMatchObject({ ok: false })
    expect(savePreset(dir, 123 as unknown as string, ['alpha'], [])).toMatchObject({ ok: false })
    expect(listPresets(dir)).toEqual([])
  })

  it('accepts CJK and space/hyphen names and rejects duplicate names', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha'])

    expect(savePreset(dir, '我的组合', ['alpha'], [])).toMatchObject({ ok: true })
    expect(savePreset(dir, 'my combo-1', ['alpha'], [])).toMatchObject({ ok: true })
    expect(savePreset(dir, '我的组合', ['alpha'], [])).toMatchObject({ ok: false, error: 'a preset with this name already exists / 同名组合已存在' })
    expect(listPresets(dir)).toHaveLength(2)
  })

  it('rejects a bundle order that is not an array of names', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha'])

    expect(savePreset(dir, 'combo', 'alpha', [])).toMatchObject({ ok: false })
    expect(savePreset(dir, 'combo', ['alpha', 42], [])).toMatchObject({ ok: false })
    expect(listPresets(dir)).toEqual([])
  })

  it('rejects a bundle order that is not a permutation of the current community bundles (reviewer M3)', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha', 'beta'])

    const permutationError = 'bundle order must be a permutation of the current community bundles / bundle 顺序必须是当前社区 bundle 的排列'
    expect(savePreset(dir, 'omits', ['alpha'], [])).toMatchObject({ ok: false, error: permutationError })
    expect(savePreset(dir, 'dups', ['alpha', 'alpha'], [])).toMatchObject({ ok: false, error: permutationError })
    expect(savePreset(dir, 'unknown', ['alpha', 'zzz'], [])).toMatchObject({ ok: false, error: permutationError })
    expect(savePreset(dir, 'adds', ['alpha', 'beta', 'gamma'], [])).toMatchObject({ ok: false, error: permutationError })
    expect(listPresets(dir)).toEqual([])
  })

  it('persists the preset to .dsh-market/presets.json with a sanitized disabled list', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha', 'beta'])

    expect(savePreset(dir, 'combo', ['beta', 'alpha'], ['p1', '', 42, 'p2'])).toEqual({ ok: true })

    const file = join(dir, '.dsh-market', 'presets.json')
    expect(existsSync(file)).toBe(true)
    const stored = JSON.parse(readFileSync(file, 'utf8')) as {
      presets: { name: string; bundleOrder: string[]; disabled: string[]; createdAt: number }[]
    }
    expect(stored.presets).toHaveLength(1)
    expect(stored.presets[0]?.name).toBe('combo')
    expect(stored.presets[0]?.bundleOrder).toEqual(['beta', 'alpha'])
    expect(stored.presets[0]?.disabled).toEqual(['p1', 'p2'])
    expect(typeof stored.presets[0]?.createdAt).toBe('number')
  })
})

describe('listPresets', () => {
  it('returns presets newest first and skips malformed entries', () => {
    const dir = pdir()
    writePresetFile(dir, [
      { name: 'old', bundleOrder: ['a'], disabled: [], createdAt: 1000 },
      { name: 'new', bundleOrder: ['b'], disabled: [], createdAt: 2000 },
      { name: 'bad' }, // missing bundleOrder/disabled arrays — must be dropped
      'garbage',
    ])

    const list = listPresets(dir)
    expect(list.map(p => p.name)).toEqual(['new', 'old'])
  })

  it('returns [] when the preset file is missing or corrupt', () => {
    const dir = pdir()
    expect(listPresets(dir)).toEqual([])

    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
    writeFileSync(join(dir, '.dsh-market', 'presets.json'), '{ nope')
    expect(listPresets(dir)).toEqual([])
  })
})

describe('deletePreset', () => {
  it('deletes a named preset and keeps the rest', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha'])
    savePreset(dir, 'a', ['alpha'], [])
    savePreset(dir, 'b', ['alpha'], [])

    expect(deletePreset(dir, 'a')).toEqual({ ok: true })
    expect(listPresets(dir).map(p => p.name)).toEqual(['b'])
  })

  it('reports a missing preset and invalid names', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha'])

    expect(deletePreset(dir, 'ghost')).toMatchObject({ ok: false, error: 'preset not found / 组合不存在' })
    expect(deletePreset(dir, 42 as unknown as string)).toMatchObject({ ok: false })
  })
})

describe('applyPreset', () => {
  it('rejects an apply whose candidate order breaks the boot and writes nothing', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha', 'beta'])
    writeBundle(dir, 'alpha', '1.0.0', [{ insert: [{ id: 'dup-entry', name: 'alpha' }] }])
    writeBundle(dir, 'beta', '1.0.0', [{ insert: [{ id: 'dup-entry', name: 'beta' }] }])
    writePresetFile(dir, [{ name: 'broken', bundleOrder: ['beta', 'alpha'], disabled: ['x'], createdAt: 1 }])
    const before = readFileSync(join(dir, 'package.json'), 'utf8')

    const result = applyPreset(dir, 'broken')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('trial validation failed')
    // No write-back on rejection…
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
    // …and the pre-change snapshot is only created after trial validation passes.
    expect(existsSync(join(dir, '.dsh-market', 'snapshots'))).toBe(false)
  })

  it('applies a valid preset: snapshot, bundle order and disabled list', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha', 'beta'])
    writeBundle(dir, 'alpha', '1.0.0', [{ insert: [{ id: 'alpha-entry', name: 'alpha' }] }])
    writeBundle(dir, 'beta', '1.0.0', [{ insert: [{ id: 'beta-entry', name: 'beta' }] }])
    writeState(dir, ['old-disabled'])
    writePresetFile(dir, [{ name: 'good', bundleOrder: ['beta', 'alpha'], disabled: ['new-disabled'], createdAt: 1 }])

    const result = applyPreset(dir, 'good')
    expect(result.ok).toBe(true)
    expect(typeof result.snapshot).toBe('string')
    expect(existsSync(join(dir, '.dsh-market', 'snapshots', `${result.snapshot}.json`))).toBe(true)

    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual(['beta', 'alpha'])

    const state = JSON.parse(readFileSync(join(dir, '.dsh-market', 'state.json'), 'utf8')) as { disabled: string[] }
    expect(state.disabled).toEqual(['new-disabled'])
  })

  it('refuses to apply when the full pre-write composition cannot be captured', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha', 'beta'])
    writeBundle(dir, 'alpha', '1.0.0', [{ insert: [{ id: 'alpha-entry', name: 'alpha' }] }])
    writeBundle(dir, 'beta', '1.0.0', [{ insert: [{ id: 'beta-entry', name: 'beta' }] }])
    writePresetFile(dir, [{ name: 'good', bundleOrder: ['beta', 'alpha'], disabled: [], createdAt: 1 }])
    mkdirSync(join(dir, '.dsh-market', 'state.json'))
    const before = readFileSync(join(dir, 'package.json'), 'utf8')

    const result = applyPreset(dir, 'good')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('.dsh-market/state.json could not be read')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
    expect(existsSync(join(dir, '.dsh-market', 'snapshots'))).toBe(false)
  })

  it('treats malformed optional state as empty and records its absence before applying', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha', 'beta'])
    writeBundle(dir, 'alpha', '1.0.0', [{ insert: [{ id: 'alpha-entry', name: 'alpha' }] }])
    writeBundle(dir, 'beta', '1.0.0', [{ insert: [{ id: 'beta-entry', name: 'beta' }] }])
    writePresetFile(dir, [{ name: 'good', bundleOrder: ['beta', 'alpha'], disabled: ['new-disabled'], createdAt: 1 }])
    writeFileSync(join(dir, '.dsh-market', 'state.json'), '{ broken')

    const result = applyPreset(dir, 'good')
    expect(result.ok).toBe(true)
    const state = JSON.parse(readFileSync(join(dir, '.dsh-market', 'state.json'), 'utf8')) as { disabled: string[] }
    expect(state.disabled).toEqual(['new-disabled'])

    const snapshot = JSON.parse(readFileSync(join(dir, '.dsh-market', 'snapshots', `${result.snapshot}.json`), 'utf8')) as {
      files: Array<{ path: string; absent?: true }>
    }
    expect(snapshot.files).toContainEqual({ path: '.dsh-market/state.json', absent: true })
  })

  it('reports missing presets and invalid names', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha'])

    expect(applyPreset(dir, 'ghost')).toMatchObject({ ok: false, error: 'preset not found / 组合不存在' })
    expect(applyPreset(dir, 42 as unknown as string)).toMatchObject({ ok: false })
  })

  it('previews the change a preset would make, without writing anything', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha', 'beta'])
    writeBundle(dir, 'alpha', '1.0.0', [{ insert: [{ id: 'alpha-entry', name: 'alpha' }] }])
    writeBundle(dir, 'beta', '1.0.0', [{ insert: [{ id: 'beta-entry', name: 'beta' }] }])
    writeState(dir, ['off-a', 'off-b'])
    writePresetFile(dir, [{ name: 'swap', bundleOrder: ['beta', 'alpha'], disabled: ['off-a', 'on-c'], createdAt: 1 }])

    const preview = previewPreset(dir, 'swap')
    expect(preview.ok).toBe(true)
    expect(preview.changes).toEqual({
      reordered: ['alpha', 'beta'], // both move (positions swap)
      enabled: ['off-b'], // disabled now, enabled by the preset
      disabled: ['on-c'], // enabled now, disabled by the preset
      noop: false,
    })
    // Pure read: nothing was written.
    expect(existsSync(join(dir, '.dsh-market', 'snapshots'))).toBe(false)
    expect(existsSync(join(dir, '.dsh-market', 'presets.json'))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toEqual(['alpha', 'beta'])
  })

  it('previews noop for an apply that changes nothing', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha'])
    writeBundle(dir, 'alpha', '1.0.0', [{ insert: [{ id: 'alpha-entry', name: 'alpha' }] }])
    writeState(dir, ['x'])
    writePresetFile(dir, [{ name: 'same', bundleOrder: ['alpha'], disabled: ['x'], createdAt: 1 }])

    const preview = previewPreset(dir, 'same')
    expect(preview.ok).toBe(true)
    expect(preview.changes?.noop).toBe(true)
  })
})

describe('market self-disable guard (#98)', () => {
  it('savePreset never stores the market’s own names in the disabled list', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha'])

    expect(savePreset(dir, 'combo', ['alpha'], ['dsh-market', 'dshmarket', 'x', 'x'])).toEqual({ ok: true })
    const saved = listPresets(dir).find(p => p.name === 'combo')
    expect(saved?.disabled).toEqual(['x'])
  })

  it('applyPreset drops market self-names from the applied disabled list (defense in depth)', () => {
    // A preset (possibly hand-edited or imported from an old export) that
    // carries the market's own name must never switch this page off — the
    // apply path filters it even if it slipped through save/import.
    const dir = pdir()
    writeProfile(dir, ['alpha', 'beta'])
    writeBundle(dir, 'alpha', '1.0.0', [{ insert: [{ id: 'alpha-entry', name: 'alpha' }] }])
    writeBundle(dir, 'beta', '1.0.0', [{ insert: [{ id: 'beta-entry', name: 'beta' }] }])
    writeState(dir, ['off-a'])
    writePresetFile(dir, [{ name: 'guarded', bundleOrder: ['beta', 'alpha'], disabled: ['dsh-market', 'dshmarket', 'on-c'], createdAt: 1 }])

    const result = applyPreset(dir, 'guarded')
    expect(result.ok).toBe(true)
    const state = JSON.parse(readFileSync(join(dir, '.dsh-market', 'state.json'), 'utf8')) as { disabled: string[] }
    expect(state.disabled).toEqual(['on-c'])
    expect(state.disabled).not.toContain('dsh-market')
  })

  it('previewPreset excludes market self-names from the change diff', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha', 'beta'])
    writeBundle(dir, 'alpha', '1.0.0', [{ insert: [{ id: 'alpha-entry', name: 'alpha' }] }])
    writeBundle(dir, 'beta', '1.0.0', [{ insert: [{ id: 'beta-entry', name: 'beta' }] }])
    writeState(dir, ['off-a'])
    writePresetFile(dir, [{ name: 'preview-guard', bundleOrder: ['beta', 'alpha'], disabled: ['dsh-market', 'on-c'], createdAt: 1 }])

    const preview = previewPreset(dir, 'preview-guard')
    expect(preview.ok).toBe(true)
    // The market's own name is not part of what the preset would disable.
    expect(preview.changes?.disabled).toEqual(['on-c'])
    expect(preview.changes?.enabled).toEqual(['off-a'])
  })
})

describe('preset quota (#98)', () => {
  it('savePreset refuses once the store is at the MAX_PRESETS quota', () => {
    const dir = pdir()
    writeProfile(dir, ['alpha'])
    const full = Array.from({ length: 50 }, (_, i) => ({
      name: `p${i}`, bundleOrder: ['alpha'], disabled: [], createdAt: i,
    }))
    writePresetFile(dir, full)

    const result = savePreset(dir, 'overflow', ['alpha'], [])
    expect(result.ok).toBe(false)
    expect(result.error).toContain('preset quota reached')
    expect(listPresets(dir)).toHaveLength(50)
  })

})
