/**
 * Ink tokens are not surfaces (#731).
 *
 * `--dsw-alias-brand-primary` and `--dsw-alias-label-primary` resolve to an INK
 * colour: near-black in the light theme, near-white in the dark one. The
 * host uses them for text and strokes; the surface they sit on is a different
 * token. The market had `brand-primary` as a badge *background* with a
 * hardcoded #fff label, so on 0.1.7 — where brand-primary is #f9fafb — the
 * diagnostics badges were white on white and simply invisible. The same rule
 * was hiding an avatar letter on `bg-layer-2`, which is white in the light
 * theme.
 *
 * The host ships `button-primary-fill` + `label-primary-foreground` for a
 * filled surface, and `label-primary` for ink on a plain one. This test keeps
 * the market's stylesheet from hardcoding the text colour of a themed surface:
 * that is the shape the bug took, and it is the shape a theme bug always
 * takes — it looks right in the theme the author was looking at.
 *
 * Deliberately NOT checked: a `brand-primary` *background* on its own. The ink
 * colour is the correct fill for a progress bar or a 9% tint, and the market
 * uses it that way; only pairing it with an assumed text colour is wrong.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(new URL('../src/client/Market.module.css', import.meta.url), 'utf8')

/** Declarations of one rule body, as `property: value` pairs. */
function declarations(body: string): Array<[string, string]> {
  return body.split(';').filter(Boolean).map(declaration => {
    const colon = declaration.indexOf(':')
    return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()]
  })
}

const RULES = [...CSS.matchAll(/\.([A-Za-z0-9_]+)\{([^}]*)\}/gu)].map(match => ({
  selector: match[1]!,
  body: match[2]!,
}))

const LITERAL_INK = /^(#fff(?:fff)?|#000(?:000)?|white|black)$/i

describe('the stylesheet does not paint with ink', () => {
  it('never hardcodes the text colour of a themed surface', () => {
    // A literal colour survives any theme whose surface happens to suit it, and
    // disappears on the first one that does not.
    const offenders = RULES.flatMap(({ selector, body }) => {
      const decls = declarations(body)
      const surface = decls.some(([property, value]) => /^background(-color)?$/.test(property)
        && /var\(--dsw-alias-/.test(value))
      const literal = decls.some(([property, value]) => property === 'color' && LITERAL_INK.test(value))
      return surface && literal ? [selector] : []
    })
    expect(offenders).toEqual([])
  })
})

/**
 * No blurred backdrop anywhere in this stylesheet.
 *
 * A `backdrop-filter` costs a blurred backdrop surface per paint. On the
 * Linux desktop shell (WebKitGTK rendering through shared memory, Skia on the
 * CPU — no GPU path) the theme grid paid it once per card: 24 covers, each
 * with a badge over a screenshot. The web process then allocated ~115 MB/s
 * while the page was stuck — 600 MB → 3 GB in 21 s — and because the shell
 * hosts the whole UI in one web view inside one cgroup, the window, the
 * compositor and the tray went with it; the machine had to be rebooted.
 *
 * Measured on dshmarket 1.66.47: removing this one declaration from
 * `.themePreviewAction,.themePreviewCount` is the difference between that and
 * a flat ~740 MB. The badge keeps its 78%-opaque scrim, so the label stays
 * legible without the blur.
 */
describe('the stylesheet does not ask for a blurred backdrop', () => {
  it('never declares a backdrop filter', () => {
    const offenders = RULES.flatMap(({ selector, body }) =>
      body.includes('backdrop-filter') ? [selector] : [])
    expect(offenders).toEqual([])
  })
})

/**
 * Card chrome comes from the host's own card (#964).
 *
 * The host's plugin list and settings cards are drawn with one pair of tokens
 * — `settings-card-fill` / `settings-card-stroke`, a 20px radius — and a 0.5px
 * hairline. The market had invented a 1px `border-l2` box at 12px, which on a
 * Retina display reads as a 2-device-pixel grey frame next to the host's
 * hairline: the section looked pasted into the page rather than part of it.
 *
 * The tokens are asserted rather than the literal values because the point is
 * that the market stops choosing its own card surface: the host can retune the
 * card without this stylesheet following.
 */
describe('page-level cards wear the host card chrome', () => {
  const card = RULES.find(rule => rule.selector === 'card')

  it('fills and strokes the card with the host settings-card tokens', () => {
    expect(card, 'the .card rule is missing').toBeDefined()
    expect(card!.body).toContain('var(--dsw-alias-settings-card-fill')
    expect(card!.body).toContain('var(--dsw-alias-settings-card-stroke')
  })

  it('uses the host radius scale and a hairline, not a bespoke box', () => {
    expect(card!.body).toContain('border-radius:var(--dsw-radius-xl')
    expect(card!.body).not.toMatch(/border:\s*1px/)
  })
})

/**
 * Two-up discover cards cannot take the host plugin-row type scale (#996).
 * That row is one column; these cards are ~260px. 13px copy and 16px
 * padding wrap the author / downloads / description into extra lines.
 * Hairline tokens stay; the measure goes back to what fit the grid.
 */
describe('discover cards keep the two-up measure', () => {
  const desc = RULES.find(rule => rule.selector === 'desc')
  const owner = RULES.find(rule => rule.selector === 'owner' && rule.body.includes('font-size'))
  const star = RULES.find(rule => rule.selector === 'star')
  const grid = RULES.find(rule => rule.selector === 'grid')
  const discoverCard = RULES.find(rule => rule.selector === 'card')

  it('keeps description and byline at the pre-996 size', () => {
    expect(desc?.body).toMatch(/font-size:\s*12px/)
    expect(owner?.body).toMatch(/font-size:\s*11px/)
    expect(star?.body).toMatch(/font-size:\s*11px/)
  })

  it('does not grow the card padding or the grid gap', () => {
    expect(discoverCard!.body).toMatch(/padding:\s*12px 14px/)
    expect(grid?.body).toMatch(/gap:\s*10px/)
  })
})

/**
 * The animated mark is one gesture, not two animations (#964 follow-up).
 *
 * It has two parts — the grid's breath and the block that plugs into the empty
 * corner — and they only read as one thing because the block arrives *behind*
 * the wave. Give them independent durations and they drift apart within a
 * couple of cycles; then the block lands after the wave it is supposed to
 * follow, which is exactly the "two unrelated loops" the pairing exists to
 * avoid. So both halves take their duration from `--dshm-cycle` and neither may
 * restate it.
 *
 * The reduced-motion split is asserted for the opposite reason: the two forms
 * *must* differ there. The ambient mark is decoration and stops; the loading
 * mark is the only signal that something is happening, so it keeps breathing.
 */
/**
 * Every rule in the file, with selector LISTS split apart, over the stylesheet
 * with its comments removed.
 *
 * `RULES` above keeps one selector per entry and so cannot see `.a,.b{...}`
 * from the `.a` side — which is exactly how the mark's halves are declared. The
 * comments have to go first: the rule text is everything since the last `}`,
 * so a comment sitting directly above a rule is read as part of its selector
 * and the rule silently disappears from this scan.
 */
const CSS_WITHOUT_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//gu, '')
const BLOCKS = [...CSS_WITHOUT_COMMENTS.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map(match => ({
  selectors: match[1]!.split(',').map(selector => selector.trim().replace(/^\./u, '')),
  body: match[2]!,
}))

function animationValues(selector: string): string[] {
  return BLOCKS
    .filter(block => block.selectors.includes(selector))
    .map(block => declarations(block.body).find(([property]) => property === 'animation')?.[1])
    .filter((value): value is string => value !== undefined)
}

describe('the animated mark keeps both halves on one clock', () => {
  const halves = ['logoCell', 'logoPlug'] as const

  it('takes the wave and the block from the same cycle variable', () => {
    for (const half of halves) {
      const declared = animationValues(half).filter(value => value.includes('dshmMark'))
      expect(declared.length, `.${half} has no mark animation`).toBeGreaterThan(0)
      for (const value of declared) expect(value).toContain('var(--dshm-cycle)')
    }
  })

  it('never restates the cycle as a literal on either half', () => {
    const restated = halves
      .flatMap(half => animationValues(half))
      .filter(value => value.includes('dshmMark') && /\d*\.?\d+m?s\b/.test(value))
    expect(restated).toEqual([])
  })

  it('stops the ambient form but keeps the loading form moving', () => {
    const start = CSS.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(start, 'there is no reduced-motion block').toBeGreaterThan(-1)
    // to the end of that at-rule, by brace depth
    let depth = 0
    let end = start
    for (let i = CSS.indexOf('{', start); i < CSS.length; i++) {
      if (CSS[i] === '{') depth += 1
      else if (CSS[i] === '}') { depth -= 1; if (depth === 0) { end = i; break } }
    }
    const block = CSS.slice(start, end)
    expect(block).toContain('.logoPlugAmbient{animation:none}')
    expect(block).toMatch(/\.logoPlug\{animation:dshmPlugFade/)
  })
})
