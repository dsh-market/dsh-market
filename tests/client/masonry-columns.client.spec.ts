import { describe, expect, it } from 'vitest'
import { masonryColumnCount } from '../../src/client/market-data.ts'

describe('masonryColumnCount', () => {
  it('caps at maxColumns even when the width would fit more', () => {
    // Old formula: floor((width+10)/290) could reach 3 on a wide sidebar.
    expect(masonryColumnCount(900, 2, 290)).toBe(2)
    expect(masonryColumnCount(900, 3, 290)).toBe(3)
  })

  it('stays at least 1 and grows with width under the cap', () => {
    expect(masonryColumnCount(200, 2, 290)).toBe(1)
    expect(masonryColumnCount(590, 2, 290)).toBe(2)
  })

  it('keeps a two-column floor when asked', () => {
    expect(masonryColumnCount(200, 3, 290, 2)).toBe(2)
    expect(masonryColumnCount(0, 3, 290, 2)).toBe(2)
  })
})
