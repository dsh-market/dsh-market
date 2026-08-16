/**
 * Unit tests for the read-only bundle-ordering helpers (issue #98,
 * diagnostics) — src/order.ts. The write side (mergeOrder / applyBundleOrder)
 * lives on the ordering branch. Pure filesystem logic, exercised against
 * per-test tmpdir fixtures (same pattern as tests/check.spec.ts): the profile
 * directory is constructed manually under a mkdtemp tmpdir and DSH_HOME is
 * pointed there so the home-level patch layer can never leak into a test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
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

  it('keeps unconstrained bundles in their relative order', () => {
    const rules = [{ name: 'x', after: ['y'], before: [] }]
    const result = suggestOrder(['a', 'x', 'b', 'y'], rules)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.order.indexOf('y')).toBeLessThan(result.order.indexOf('x'))
      // Unconstrained bundles sort deterministically by name (input order no
      // longer matters — the result is a UNIQUE canonical order).
      expect(result.order.indexOf('a')).toBeLessThan(result.order.indexOf('b'))
    }
    // The same input order shifted produces the SAME canonical result, so
    // re-clicking auto-sort after a manual tweak restores it.
    const again = suggestOrder(['b', 'x', 'y', 'a'], rules)
    if (again.ok && result.ok) expect(again.order).toEqual(result.order)
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

  it('puts a bundle after the bundles it depends on (dependency edges)', () => {
    // a depends on b, b depends on c ⇒ order must be c, b, a.
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ]
    const result = suggestOrder(['a', 'b', 'c'], [], edges)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.order.indexOf('c')).toBeLessThan(result.order.indexOf('b'))
      expect(result.order.indexOf('b')).toBeLessThan(result.order.indexOf('a'))
    }
  })

  it('combines before/after rules with dependency edges and reports cycles', () => {
    // Rule: c before a. Dependencies: a→b. Both satisfied by b, c, a… and c
    // before a means c, a order; deps force b before a → b, c, a.
    const rules = [{ name: 'c', before: ['a'], after: [] }]
    const edges = [{ from: 'a', to: 'b' }]
    const result = suggestOrder(['a', 'b', 'c'], rules, edges)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.order.indexOf('b')).toBeLessThan(result.order.indexOf('a'))
      expect(result.order.indexOf('c')).toBeLessThan(result.order.indexOf('a'))
    }
    // Mutual dependency → cycle.
    const cycle = suggestOrder(['a', 'b'], [], [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ])
    expect(cycle.ok).toBe(false)
  })

  it('ignores dependency edges to unlisted bundles', () => {
    const result = suggestOrder(['a', 'b'], [], [{ from: 'a', to: 'ghost' }])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.order.sort()).toEqual(['a', 'b'])
  })
})
