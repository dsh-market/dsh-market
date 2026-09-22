/**
 * Icon alias resolution for host 0.1.7's …14/…16 → …Regular/…Medium rename (#671).
 */
import { describe, expect, it } from 'vitest'
import { ICON_ALIASES, missingIcons, resolveIcon } from '../../src/client/icons.ts'

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
