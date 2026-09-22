/**
 * Icon alias resolution for host 0.1.7's …14/…16 → …Regular/…Medium rename (#671).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ICON_ALIASES,
  isIconComponent,
  missingIcons,
  resolveIcon,
} from '../../src/client/icons.ts'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function loadIconFixture(version: string): Set<string> {
  const raw = JSON.parse(readFileSync(join(fixturesDir, `primitives-icons-${version}.json`), 'utf8')) as {
    icons: string[]
  }
  return new Set(raw.icons)
}

/** Build a primitives-shaped module whose Icon* keys are stub components. */
function moduleFromNames(names: Set<string>): Record<string, unknown> {
  const mod: Record<string, unknown> = {}
  for (const name of names) mod[name] = () => null
  return mod
}

describe('resolveIcon (#671)', () => {
  it('prefers the 0.1.7 weight name when both spellings exist', () => {
    const newer = (): null => null
    const older = (): null => null
    expect(resolveIcon({
      IconWarningOutlineMedium: newer,
      IconWarningOutline16: older,
    }, 'IconWarningOutlineMedium', 'IconWarningOutline16')).toBe(newer)
  })

  it('falls back to the pre-0.1.7 size name on older hosts', () => {
    const older = (): null => null
    expect(resolveIcon({
      IconWarningOutline16: older,
    }, 'IconWarningOutlineMedium', 'IconWarningOutline16')).toBe(older)
  })

  it('accepts a host that only ships the new names', () => {
    const newer = (): null => null
    expect(resolveIcon({
      IconChevronDownOutlineRegular: newer,
    }, 'IconChevronDownOutlineRegular', 'IconChevronDownOutline14')).toBe(newer)
  })

  it('returns null when neither spelling exists', () => {
    expect(resolveIcon({}, 'IconWarningOutlineMedium', 'IconWarningOutline16')).toBeNull()
    expect(resolveIcon({ IconWarningOutline16: 1 }, 'IconWarningOutlineMedium', 'IconWarningOutline16')).toBeNull()
  })

  it('accepts memo / forwardRef-shaped exports, not only plain functions', () => {
    const memoLike = { $$typeof: Symbol.for('react.memo'), type: () => null }
    const forwardLike = { $$typeof: Symbol.for('react.forward_ref'), render: () => null }
    expect(isIconComponent(memoLike)).toBe(true)
    expect(isIconComponent(forwardLike)).toBe(true)
    expect(resolveIcon({
      IconWarningOutlineMedium: memoLike,
    }, 'IconWarningOutlineMedium', 'IconWarningOutline16')).toBe(memoLike)
    expect(resolveIcon({
      IconWarningOutline16: forwardLike,
    }, 'IconWarningOutlineMedium', 'IconWarningOutline16')).toBe(forwardLike)
  })
})

describe('missingIcons (#671)', () => {
  it('reports nothing when every alias resolves via the new name', () => {
    const mod: Record<string, unknown> = {}
    for (const [, newer] of ICON_ALIASES) mod[newer] = () => null
    expect(missingIcons(mod)).toEqual([])
  })

  it('reports nothing when every alias resolves via the old name', () => {
    const mod: Record<string, unknown> = {}
    for (const [, , older] of ICON_ALIASES) mod[older] = () => null
    expect(missingIcons(mod)).toEqual([])
  })

  it('names icons that exist under neither spelling', () => {
    const mod: Record<string, unknown> = {}
    for (const [, newer, older] of ICON_ALIASES) {
      if (older === 'IconWarningOutline16') continue
      mod[newer] = () => null
    }
    expect(missingIcons(mod)).toEqual(['IconWarningOutline16'])
  })
})

describe('real package export tables (#671)', () => {
  it('resolves every market icon against the 0.1.6-alpha.2 export list', () => {
    const names = loadIconFixture('0.1.6-alpha.2')
    for (const [, newer, older] of ICON_ALIASES) {
      expect(names.has(older), `pre-0.1.7 export missing: ${older}`).toBe(true)
      expect(names.has(newer), `0.1.6 must not yet ship ${newer}`).toBe(false)
    }
    expect(missingIcons(moduleFromNames(names))).toEqual([])
  })

  it('resolves every market icon against the 0.1.7-alpha.1 export list', () => {
    const names = loadIconFixture('0.1.7-alpha.1')
    for (const [, newer, older] of ICON_ALIASES) {
      expect(names.has(newer), `0.1.7 export missing: ${newer}`).toBe(true)
      expect(names.has(older), `0.1.7 must not keep ${older}`).toBe(false)
    }
    expect(missingIcons(moduleFromNames(names))).toEqual([])
  })
})
