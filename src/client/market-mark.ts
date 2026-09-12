/**
 * The market's block mark as geometry rather than as a component.
 *
 * Two consumers draw this mark and they must not drift:
 *
 * - `MarketLogo` (MarketSection.tsx) renders it inside the section as an
 *   ordinary React SVG in `currentColor`, including the animated variant;
 * - `settings-nav-icon.ts` serialises it into a CSS mask for the settings
 *   navigation glyph, which cannot use `currentColor` (a mask is an
 *   independent image) and so needs it as standalone markup.
 *
 * Keeping the numbers here means a change to the mark is one edit, and the
 * suite can hold both renderings to the same source.
 *
 * The mark is the brand asset in `assets/logo.svg`: an 8-cell grid plus the
 * block being plugged into its empty corner, offset and tilted 9°.
 */

/** Side of one block, and its corner radius. */
export const MARK_BLOCK_SIZE = 3.3
export const MARK_BLOCK_RADIUS = 0.53

/** The square every coordinate in the mark is expressed in. */
export const MARK_VIEW_BOX = 16

/** The eight grid cells, row-major. The ninth slot stays empty on purpose. */
export const MARK_GRID_BLOCKS: readonly { readonly x: number; readonly y: number }[] = [
  { x: 1.96, y: 3.36 }, { x: 5.71, y: 3.36 },
  { x: 1.96, y: 7.11 }, { x: 5.71, y: 7.11 }, { x: 9.46, y: 7.11 },
  { x: 1.96, y: 10.86 }, { x: 5.71, y: 10.86 }, { x: 9.46, y: 10.86 },
]

/**
 * The block being plugged in: OUTSIDE the grid's empty corner, offset
 * (+1.28, -1.27) and tilted 9deg, exactly as in assets/logo.svg. The earlier
 * icon sat it neatly in the empty slot, which reads as one crooked tile
 * rather than a block arriving — the whole idea of the mark, and the reason
 * it no longer matched the GitHub logo.
 */
export const MARK_PLUG_BLOCK = {
  x: 10.74,
  y: 2.09,
  degrees: 9,
  /** Rotation origin: the plug block's own centre. */
  originX: 12.39,
  originY: 3.74,
} as const
