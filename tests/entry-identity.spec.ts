/**
 * The rule three call sites used to restate (#646).
 *
 * These are the answer shapes a bundle patch's `name:` rows take in the
 * wild, plus the near-misses that must NOT match. The `/` bound and the
 * "not a package name at all" cases are the ones a relaxed matcher gets
 * wrong, so they are asserted rather than assumed.
 */

import { describe, expect, it } from 'vitest'
import { entryMatchesPackage, nameMatchesPackage, packageOfEntryName } from '../src/entry-identity.ts'

describe('nameMatchesPackage', () => {
  it('matches the bare package name — the shape most plugins use', () => {
    expect(nameMatchesPackage('dsh-chat-import', 'dsh-chat-import')).toBe(true)
    expect(nameMatchesPackage('@deepseek-ai/dsh-context', '@deepseek-ai/dsh-context')).toBe(true)
  })

  it('matches a subpath entry inside the package (#646, the aegis shape)', () => {
    expect(nameMatchesPackage('aegis/extensions/dsh/index.js', 'aegis')).toBe(true)
    expect(nameMatchesPackage('toolshrink/harness', 'toolshrink')).toBe(true)
    expect(nameMatchesPackage('my-plugin/dist/host.js', 'my-plugin')).toBe(true)
    expect(nameMatchesPackage('@scope/pkg/dist/index.js', '@scope/pkg')).toBe(true)
  })

  it('does not match a differently-named package that shares a prefix', () => {
    // The `/` bound is the whole reason this is a shared function rather
    // than `startsWith`: without it, disabling `aegis` would take down
    // `aegis-extra` with it.
    expect(nameMatchesPackage('toolshrink-extra', 'toolshrink')).toBe(false)
    expect(nameMatchesPackage('aegis-foo/bar.js', 'aegis')).toBe(false)
    expect(nameMatchesPackage('@scope/pkg-extra', '@scope/pkg')).toBe(false)
  })

  it('does not match nothing, or a longer name that only starts the same', () => {
    expect(nameMatchesPackage(undefined, 'aegis')).toBe(false)
    expect(nameMatchesPackage('', 'aegis')).toBe(false)
    expect(nameMatchesPackage('aegis', 'aegis/extensions')).toBe(false)
  })
})

describe('entryMatchesPackage', () => {
  it('reads the name off a loader entry, and survives a missing shape', () => {
    expect(entryMatchesPackage({ options: { name: 'aegis/extensions/dsh/index.js' } }, 'aegis')).toBe(true)
    expect(entryMatchesPackage({ options: { name: 'other' } }, 'aegis')).toBe(false)
    expect(entryMatchesPackage({}, 'aegis')).toBe(false)
  })
})

describe('packageOfEntryName', () => {
  it('is the inverse: a subpath entry names the package it lives in', () => {
    expect(packageOfEntryName('aegis/extensions/dsh/index.js')).toBe('aegis')
    expect(packageOfEntryName('my-plugin/dist/host.js')).toBe('my-plugin')
    expect(packageOfEntryName('@scope/pkg/dist/index.js')).toBe('@scope/pkg')
  })

  it('has no package to name for a bare package name', () => {
    // Not an error: it already IS the package name, and returning it here
    // would make every caller add a name it already has.
    expect(packageOfEntryName('aegis')).toBe(null)
    expect(packageOfEntryName('@scope/pkg')).toBe(null)
  })

  it('refuses names that are not npm packages rather than guessing', () => {
    // A guess here would add a "package" that does not exist to the live
    // set, and a bogus live entry is worse than a missing one.
    expect(packageOfEntryName('./relative.js')).toBe(null)
    expect(packageOfEntryName('/abs/path.js')).toBe(null)
    expect(packageOfEntryName('file:///tmp/x.js')).toBe(null)
    expect(packageOfEntryName('https://example.com/x.js')).toBe(null)
    expect(packageOfEntryName('cordis:include')).toBe(null)
    expect(packageOfEntryName('')).toBe(null)
  })
})
