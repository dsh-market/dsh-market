/**
 * Unit tests for community bundle ordering (issue #98, phase 2) — src/order.ts.
 * Pure filesystem logic, exercised against per-test tmpdir fixtures (same
 * pattern as tests/check.spec.ts): the profile directory is constructed
 * manually under a mkdtemp tmpdir and DSH_HOME is pointed there so the
 * home-level patch layer can never leak into a test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyBundleOrder,
  mergeOrder,
  readBundleRules,
  readBundleStack,
  suggestOrder,
  validateOrder,
} from '../src/order.ts'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dshm-order-'))
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

/** A bundle package that declares only ordering rules (no patch needed here). */
function writeOrderedBundle(base: string, name: string, version: string, order: { before?: string[]; after?: string[] }): string {
  return writePackage(base, name, {
    name,
    version,
    dsh: { bundle: { order } },
  })
}

describe('readBundleStack (#98 order)', () => {
  it('classifies in-box official bundles vs community bundles, keeping manifest order', () => {
    const dir = pdir()
    writeProfile(dir, {
      name: 'web-profile',
      dsh: {
        profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-market', '@deepseek-ai/dsh-web-app', 'demo-plugin'] },
      },
    })

    const stack = readBundleStack(dir)
    expect(stack.bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-market', '@deepseek-ai/dsh-web-app', 'demo-plugin'])
    // Only the three in-box bundles are official; everything else is reorderable.
    expect(stack.community).toEqual(['dsh-market', 'demo-plugin'])
  })

  it('returns an empty stack when the manifest is missing or unreadable', () => {
    const dir = pdir()
    expect(readBundleStack(dir)).toEqual({ bundles: [], community: [] })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{ not json')
    expect(readBundleStack(dir)).toEqual({ bundles: [], community: [] })
  })

  it('drops non-string entries from dsh.profile.bundles', () => {
    const dir = pdir()
    writeProfile(dir, { dsh: { profile: { bundles: ['a', 42, null, 'b'] } } })
    const stack = readBundleStack(dir)
    expect(stack.bundles).toEqual(['a', 'b'])
    expect(stack.community).toEqual(['a', 'b'])
  })
})

describe('readBundleRules (#98 ordering rules)', () => {
  it('parses dsh.bundle.order before/after from installed packages', () => {
    const dir = pdir()
    writeProfile(dir, { dsh: { profile: { bundles: ['alpha', 'beta', 'gamma'] } } })
    writeOrderedBundle(dir, 'alpha', '1.0.0', { after: ['beta'] })
    writeOrderedBundle(dir, 'beta', '1.0.0', { before: ['gamma'], after: ['not-installed-yet'] })
    writePackage(dir, 'gamma', { name: 'gamma', version: '1.0.0' }) // no order declared

    const rules = readBundleRules(dir)
    expect(rules).toEqual([
      { name: 'alpha', after: ['beta'], before: [] },
      { name: 'beta', after: ['not-installed-yet'], before: ['gamma'] },
    ])
  })

  it('ignores unreadable packages, non-object order and empty declarations', () => {
    const dir = pdir()
    writeProfile(dir, { dsh: { profile: { bundles: ['alpha', 'beta', 'gamma'] } } })
    // alpha: package.json missing entirely — no rule.
    // beta: order declared as a scalar, not an object — ignored.
    writePackage(dir, 'beta', { name: 'beta', version: '1.0.0', dsh: { bundle: { order: 'nope' } } })
    // gamma: order object with a non-array `after` — contributes no list.
    writePackage(dir, 'gamma', { name: 'gamma', version: '1.0.0', dsh: { bundle: { order: { after: 'x' } } } })

    expect(readBundleRules(dir)).toEqual([])
  })

  it('drops non-string entries inside before/after lists', () => {
    const dir = pdir()
    writeProfile(dir, { dsh: { profile: { bundles: ['alpha'] } } })
    writePackage(dir, 'alpha', {
      name: 'alpha',
      version: '1.0.0',
      dsh: { bundle: { order: { after: ['beta', 42, null], before: 'nope' } } },
    })

    expect(readBundleRules(dir)).toEqual([{ name: 'alpha', after: ['beta'], before: [] }])
  })
})

describe('validateOrder (#98 before/after enforcement)', () => {
  it('reports a violated after rule with the offending bundle name', () => {
    // alpha must load after beta, but alpha sits first — violated.
    const conflicts = validateOrder(['alpha', 'beta'], [{ name: 'alpha', after: ['beta'], before: [] }])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.name).toBe('alpha')
    expect(conflicts[0]?.reason).toContain('must load after beta')
  })

  it('accepts an order that satisfies every after rule', () => {
    // alpha must load after beta, and beta leads — satisfied.
    expect(validateOrder(['beta', 'alpha'], [{ name: 'alpha', after: ['beta'], before: [] }])).toEqual([])
  })

  it('reports a violated before rule', () => {
    const conflicts = validateOrder(['beta', 'alpha'], [{ name: 'alpha', before: ['beta'], after: [] }])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.name).toBe('alpha')
    expect(conflicts[0]?.reason).toContain('must load before beta')
  })

  it('ignores rules naming bundles outside the order (not-yet-installed rules)', () => {
    const rules = [
      { name: 'alpha', after: ['not-installed'], before: [] },
      { name: 'ghost', after: ['alpha'], before: [] },
    ]
    expect(validateOrder(['alpha', 'beta'], rules)).toEqual([])
  })

  it('reports every violated rule across the stack', () => {
    const conflicts = validateOrder(['alpha', 'beta', 'gamma'], [
      { name: 'alpha', after: ['beta'], before: [] }, // beta must precede alpha — violated
      { name: 'gamma', before: ['beta'], after: [] }, // beta must follow gamma — violated
    ])
    expect(conflicts).toHaveLength(2)
    expect(conflicts.map(c => c.name)).toEqual(['alpha', 'gamma'])
  })
})

describe('applyBundleOrder (#98 manifest write-back)', () => {
  it('keeps official in-box bundles in their exact positions (in-place merge)', () => {
    const dir = pdir()
    writeProfile(dir, {
      name: 'web-profile',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'alpha', 'beta', '@deepseek-ai/dsh-web-app'] } },
    })

    const result = applyBundleOrder(dir, ['beta', 'alpha'])
    expect(result.ok).toBe(true)
    // Community slots are replaced in order; officials never move.
    if (result.ok) expect(result.bundles).toEqual(['@deepseek-ai/dsh-base', 'beta', 'alpha', '@deepseek-ai/dsh-web-app'])
  })

  it('accepts an empty reorder for an all-official stack', () => {
    const dir = pdir()
    writeProfile(dir, { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } })

    const result = applyBundleOrder(dir, [])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.bundles).toEqual(['@deepseek-ai/dsh-base'])
  })

  it('rejects duplicate names without touching the manifest', () => {
    const dir = pdir()
    writeProfile(dir, { dsh: { profile: { bundles: ['alpha', 'beta'] } } })
    const before = readFileSync(join(dir, 'package.json'), 'utf8')

    const result = applyBundleOrder(dir, ['alpha', 'alpha'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('duplicate')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
  })

  it('rejects additions and omissions (must be a permutation)', () => {
    const dir = pdir()
    writeProfile(dir, { dsh: { profile: { bundles: ['alpha', 'beta'] } } })
    const before = readFileSync(join(dir, 'package.json'), 'utf8')

    expect(applyBundleOrder(dir, ['alpha']).ok).toBe(false) // omission
    const added = applyBundleOrder(dir, ['alpha', 'beta', 'gamma'])
    expect(added.ok).toBe(false)
    if (!added.ok) expect(added.error).toContain('exactly the current community bundles')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
  })

  it('rejects names that are not reorderable community bundles', () => {
    const dir = pdir()
    writeProfile(dir, { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'alpha', 'beta'] } } })
    const before = readFileSync(join(dir, 'package.json'), 'utf8')

    const result = applyBundleOrder(dir, ['alpha', 'zzz'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('zzz')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
  })

  it('rewrites only dsh.profile.bundles and preserves every other manifest field', () => {
    const dir = pdir()
    writeProfile(dir, {
      name: 'web-profile',
      version: '1.2.3',
      dependencies: { alpha: '^1.0.0', beta: '^2.0.0' },
      dsh: {
        profile: { bundles: ['alpha', 'beta'], keepMe: { nested: true } },
        client: { inject: ['@deepseek-ai/dsh-client-connection'] },
      },
    })

    const result = applyBundleOrder(dir, ['beta', 'alpha'])
    expect(result.ok).toBe(true)

    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string
      version: string
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[]; keepMe: unknown }; client: { inject: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual(['beta', 'alpha'])
    expect(manifest.name).toBe('web-profile')
    expect(manifest.version).toBe('1.2.3')
    expect(manifest.dependencies).toEqual({ alpha: '^1.0.0', beta: '^2.0.0' })
    expect(manifest.dsh.profile.keepMe).toEqual({ nested: true })
    expect(manifest.dsh.client).toEqual({ inject: ['@deepseek-ai/dsh-client-connection'] })
  })

  it('fails cleanly when the manifest cannot be read', () => {
    const dir = pdir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{ nope')
    const result = applyBundleOrder(dir, [])
    expect(result.ok).toBe(false)
  })
})

describe('mergeOrder (#98 in-place merge)', () => {
  it('replaces community slots in place while officials keep exact positions', () => {
    const merged = mergeOrder(
      ['@deepseek-ai/dsh-base', 'a', 'b', '@deepseek-ai/dsh-web-app', 'c'],
      ['c', 'a', 'b'],
    )
    expect(merged).toEqual({
      ok: true,
      bundles: ['@deepseek-ai/dsh-base', 'c', 'a', '@deepseek-ai/dsh-web-app', 'b'],
    })
  })

  it('rejects duplicates, additions, omissions and official names in the new order', () => {
    expect(mergeOrder(['a', 'b'], ['a', 'a']).ok).toBe(false) // duplicate
    expect(mergeOrder(['a', 'b'], ['a']).ok).toBe(false) // omission
    expect(mergeOrder(['a', 'b'], ['a', 'b', 'c']).ok).toBe(false) // addition
    // Official names are excluded from the community set, so any newOrder
    // containing one is caught by the exact-length check.
    const official = mergeOrder(['@deepseek-ai/dsh-base', 'a'], ['@deepseek-ai/dsh-base', 'a'])
    expect(official.ok).toBe(false)
    if (!official.ok) expect(official.error).toContain('exactly the current community bundles')
    // Arbitrary unknown names at the right length trip the per-name check.
    const unknown = mergeOrder(['a', 'b'], ['a', 'zzz'])
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toContain('zzz')
  })

  it('accepts an empty new order when there are no community bundles', () => {
    expect(mergeOrder(['@deepseek-ai/dsh-base'], [])).toEqual({ ok: true, bundles: ['@deepseek-ai/dsh-base'] })
  })
})

describe('suggestOrder (#98 opt: LOOT-style auto-fix)', () => {
  it('topologically sorts community bundles by before/after rules', () => {
    // b after a  →  a must load before b. d before c → d must load before c.
    const rules = [
      { name: 'b', after: ['a'], before: [] },
      { name: 'd', before: ['c'], after: [] },
    ]
    const result = suggestOrder(['a', 'b', 'c', 'd'], rules)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.order.indexOf('a')).toBeLessThan(result.order.indexOf('b'))
      expect(result.order.indexOf('d')).toBeLessThan(result.order.indexOf('c'))
      expect(result.order.sort()).toEqual(['a', 'b', 'c', 'd'])
    }
  })

  it('keeps unconstrained bundles in their current relative order (minimal change)', () => {
    const rules = [{ name: 'x', after: ['y'], before: [] }]
    const result = suggestOrder(['a', 'x', 'b', 'y'], rules)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.order.indexOf('y')).toBeLessThan(result.order.indexOf('x'))
      // The unconstrained bundles keep their CURRENT relative order — the
      // suggestion is the minimal change the rules force (issue #125 review),
      // never an arbitrary canonical rewrite.
      expect(result.order).toEqual(['a', 'b', 'y', 'x'])
    }
    // The suggestion follows the CURRENT order, not a canonical one: the
    // same rules over a different current order produce a different minimal
    // change.
    const again = suggestOrder(['b', 'x', 'y', 'a'], rules)
    expect(again).toEqual({ ok: true, order: ['b', 'y', 'x', 'a'] })
  })

  it('reports a cycle instead of an order', () => {
    const rules = [
      { name: 'a', before: ['b'], after: [] },
      { name: 'b', before: ['a'], after: [] },
    ]
    const result = suggestOrder(['a', 'b'], rules)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.cycle.length).toBeGreaterThan(0)
  })

  it('ignores rules referencing unlisted bundles and official names', () => {
    const rules = [
      { name: 'a', after: ['not-installed'], before: [] },
      { name: '@deepseek-ai/dsh-base', after: ['x'], before: [] }, // official — not reorderable
    ]
    const result = suggestOrder(['a', 'x'], rules)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.order).toEqual(['a', 'x'])
  })


  it('combines before/after rules across bundles and reports cycles', () => {
    // Rule: c before a → the minimal change moves only what the rule forces.
    const rules = [{ name: 'c', before: ['a'], after: [] }]
    const result = suggestOrder(['a', 'b', 'c'], rules)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.order.indexOf('c')).toBeLessThan(result.order.indexOf('a'))
    }
    // A rule cycle has no compliant order.
    const cycle = suggestOrder(['a', 'b'], [
      { name: 'a', before: ['b'], after: [] },
      { name: 'b', before: ['a'], after: [] },
    ])
    expect(cycle.ok).toBe(false)
  })

})

  it('returns null when no declared rule applies (nothing to suggest)', () => {
    expect(suggestOrder(['a', 'b'], [])).toBeNull()
    // Rules naming bundles outside the current stack are not active either.
    expect(suggestOrder(['a', 'b'], [{ name: 'ghost', after: ['x'], before: [] }])).toBeNull()
  })