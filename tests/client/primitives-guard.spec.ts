/**
 * Host-compatibility guard: on hosts whose injected primitives module
 * predates rc.6, the named exports the market renders with are undefined
 * (the module itself resolves, so the bundle factory succeeds). apply()
 * must detect the gap and skip registration instead of throwing mid-render.
 */
import { describe, expect, it } from 'vitest'
import { missingPrimitives, REQUIRED_PRIMITIVES } from '../../src/client/index.ts'

describe('missingPrimitives', () => {
  it('reports no gaps when every required export exists', () => {
    const mod: Record<string, unknown> = {}
    for (const name of REQUIRED_PRIMITIVES) mod[name] = () => null
    expect(missingPrimitives(mod)).toEqual([])
  })

  it('names the missing exports on an old host', () => {
    const mod: Record<string, unknown> = { Menu: () => null, Toast: () => null }
    expect(missingPrimitives(mod)).toEqual(['DisclosureRow', 'Tooltip'])
  })

  it('reports every requirement when the module is empty', () => {
    expect(missingPrimitives({})).toEqual([...REQUIRED_PRIMITIVES])
  })

  it('accepts a custom requirement list', () => {
    expect(missingPrimitives({ A: 1 }, ['A', 'B', 'C'])).toEqual(['B', 'C'])
  })
})
