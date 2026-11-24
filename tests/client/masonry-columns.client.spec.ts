import { describe, expect, it } from 'vitest'
import { balanceColumns, masonryColumnCount } from '../../src/client/market-data.ts'

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

describe('balanceColumns', () => {
  const heights = [210, 354, 228, 325, 163, 217, 300, 336, 354, 210, 192, 210, 318, 246, 217, 192, 181, 354, 181, 354, 228, 192, 181, 181]
  const depths = (placed: number[], columns: number) => {
    const depth = Array.from({ length: columns }, () => 0)
    placed.forEach((column, index) => { depth[column]! += heights[index]! + 10 })
    return depth
  }
  it('ends the columns closer together than dealing alternately', () => {
    const dealt = heights.map((_h, index) => index % 3)
    const spread = (depth: number[]) => Math.max(...depth) - Math.min(...depth)
    expect(spread(depths(balanceColumns(heights, 3), 3))).toBeLessThan(spread(depths(dealt, 3)))
    expect(spread(depths(balanceColumns(heights, 3), 3))).toBeLessThanOrEqual(60)
  })
  it('places every card, and the first cards in rank order go to the shortest column', () => {
    const placed = balanceColumns(heights, 3)
    expect(placed).toHaveLength(heights.length)
    expect(placed.slice(0, 3)).toEqual([0, 1, 2])
  })
  it('copes with fewer cards than columns and with one column', () => {
    expect(balanceColumns([100], 3)).toHaveLength(1)
    expect(balanceColumns([], 2)).toEqual([])
    expect(balanceColumns([100, 50, 80], 1)).toEqual([0, 0, 0])
  })
})
