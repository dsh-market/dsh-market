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
