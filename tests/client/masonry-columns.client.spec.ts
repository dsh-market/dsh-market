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
  it.each([
    { name: 'all zero', heights: [0, 0, 0, 0], columns: 2 },
    { name: 'partially zero', heights: [100, 0, 120, 90], columns: 2 },
    { name: 'NaN', heights: [100, Number.NaN, 120, 90], columns: 2 },
    { name: 'negative', heights: [100, -1, 120, 90], columns: 2 },
    { name: 'infinite', heights: [100, Infinity, 120, 90], columns: 2 },
    { name: 'three columns', heights: [0, 0, 0, 0, 0, 0, 0], columns: 3 },
  ])('retains ranked placement when card measurements are incomplete ($name)', ({ heights: unmeasured, columns }) => {
    expect(balanceColumns(unmeasured, columns)).toEqual(unmeasured.map((_h, index) => index % columns))
  })
  it.each([
    [[100, 100, 100, 100], 2, [0, 1, 0, 1]],
    [[100, 100, 20, 90], 2, [0, 1, 0, 1]],
    [[100, 100, 100, 100], 3, [0, 1, 2, 0]],
    [[100, 100], 3, [0, 1]],
  ] as const)('retains the rank-friendly deal when balancing cannot improve the greedy spread (%j, %i columns)', (measured, columns, expected) => {
    expect(balanceColumns(measured, columns)).toEqual(expected)
  })
  it('still improves the greedy spread for genuinely unequal measured heights', () => {
    const measured = [90, 80, 70, 60, 50]
    const depth = [0, 0]
    balanceColumns(measured, 2).forEach((column, i) => { depth[column]! += measured[i]! + 10 })
    // Greedy shortest-column placement finishes at depths 230 and 170.
    expect(Math.abs(depth[0]! - depth[1]!)).toBeLessThan(60)
  })
  it('prefers earlier greedy ranks when equally good improvements are available', () => {
    // Greedy spread is 50. Both [0,0,1,1] and its mirror [1,1,0,0]
    // reduce it to 10, but the former keeps the first card on the left.
    expect(balanceColumns([100, 120, 150, 80], 2)).toEqual([0, 0, 1, 1])
  })
  it('copes with fewer cards than columns and with one column', () => {
    expect(balanceColumns([100], 3)).toHaveLength(1)
    expect(balanceColumns([], 2)).toEqual([])
    expect(balanceColumns([100, 50, 80], 1)).toEqual([0, 0, 0])
  })
})
