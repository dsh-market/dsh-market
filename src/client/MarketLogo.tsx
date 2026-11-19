/**
 * The Market logo mark and the GitHub repo mark.
 */

import type { CSSProperties } from 'react'
import { MARK_BLOCK_RADIUS, MARK_BLOCK_SIZE, MARK_GRID_BLOCKS, MARK_PLUG_BLOCK, MARK_VIEW_BOX } from './market-mark.ts'
import css from './Market.module.css'

/**
 * Official-style market glyph: the shared block-grid brand mark converted to
 * the official monochrome icon form (16×16, fill="currentColor") so it
 * follows the active theme. Mirrors the settings-nav glyph used for the
 * "market" section id — both now draw the geometry in market-mark.ts, so the
 * nav entry and the section it opens cannot drift apart.
 *
 * Two animated forms, differing in what they are for rather than in looks:
 *
 * - `animated` — the loading state. Motion is the whole signal, so under
 *   `prefers-reduced-motion` it still moves, just without displacement.
 * - `ambient` — the section's own heading mark. Decoration, so the same
 *   preference stops it dead.
 *
 * Both draw the one timeline in the stylesheet: the grid breathes along the
 * diagonal and the block rides in behind that wave. They share `--dshm-cycle`
 * so the block cannot arrive after the wave it is supposed to follow.
 */
export function MarketLogo({ size = 16, style, animated = false, ambient = false }: {
  size?: number
  style?: CSSProperties
  animated?: boolean
  ambient?: boolean
}) {
  const moving = animated || ambient
  return (
    <svg width={size} height={size} viewBox={`0 0 ${MARK_VIEW_BOX} ${MARK_VIEW_BOX}`} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style={style}>
      <g fill="currentColor">
        {MARK_GRID_BLOCKS.map(block => (
          <rect
            key={`${block.x},${block.y}`}
            className={moving ? css.logoCell : undefined}
            style={moving ? { '--dshm-wave': block.wave } as CSSProperties : undefined}
            x={block.x} y={block.y} width={MARK_BLOCK_SIZE} height={MARK_BLOCK_SIZE} rx={MARK_BLOCK_RADIUS}
          />
        ))}
      </g>
      {/* The block being plugged in: OUTSIDE the grid's empty corner, offset
          (+1.28, -1.27) and tilted 9deg, exactly as in assets/logo.svg. The
          earlier icon sat it neatly in the empty slot, which reads as one
          crooked tile rather than a block arriving — the whole idea of the
          mark, and the reason it no longer matched the GitHub logo.

          The tilt stays a presentation attribute even in the animated forms:
          a CSS animation outranks it while running, and when the animation is
          suppressed (reduced motion) the attribute is what leaves the block in
          its drawn position instead of sitting square in the corner. */}
      <rect
        className={animated ? css.logoPlug : ambient ? css.logoPlugAmbient : undefined}
        x={MARK_PLUG_BLOCK.x} y={MARK_PLUG_BLOCK.y} width={MARK_BLOCK_SIZE} height={MARK_BLOCK_SIZE} rx={MARK_BLOCK_RADIUS} fill="currentColor"
        transform={`rotate(${MARK_PLUG_BLOCK.degrees} ${MARK_PLUG_BLOCK.originX} ${MARK_PLUG_BLOCK.originY})`}
      />
    </svg>
  )
}

/**
 * GitHub mark beside catalog card titles (#256, #365). Catalog intake in
 * awesome-dsh-plugin rejects any entry whose `url` is not
 * `https://github.com/owner/repo` (scripts/lib/entries.mjs), so this renders
 * unconditionally — not a bet that today's snapshot happens to be all
 * GitHub. The generic outbound arrow did not say so until hover. This rides
 * the title's own line — no second link, no extra row.
 */
export function GithubRepoMark({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  )
}
