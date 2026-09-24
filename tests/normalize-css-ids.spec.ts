/**
 * The one rule in normalize-client-banner.mjs that decides whether two
 * machines produce the same committed bundle.
 *
 * `client/client.js` is committed and CI re-builds it and demands a byte
 * match. The CSS virtual ids in it start life as whatever the bundler
 * resolved on the builder's machine, so this rule rewrites them to one
 * canonical form. When it misses a shape, the consequence is not a wrong
 * bundle — it is a contributor whose PR is red with a diff they did not
 * write and a failure message that only says the artefact does not match.
 * That happened to #563 and #570 with a doubled `src/src/` segment the lazy
 * prefix match walked straight past.
 *
 * The rule is read out of the script rather than duplicated here: a copy
 * would keep passing after the original changed, which is the failure mode
 * this file exists to prevent.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** The live rewrite, lifted from the script by source. */
function normalizeCssIds(code: string): string {
  const source = readFileSync(resolve('scripts/normalize-client-banner.mjs'), 'utf8')
  const rule = /code = code\.replace\((\/\(dsh-css:\)[^\n]*?\/g), \(_all, prefix, _dir, rel\) =>\s*\n?\s*prefix \+ rel\.replaceAll\('\\\\', '\/'\)\)/.exec(source)
  expect(rule, 'the CSS id rewrite was not found in normalize-client-banner.mjs').not.toBeNull()
  // eslint-disable-next-line no-new-func
  const pattern = new Function(`return ${rule![1]!}`)() as RegExp
  return code.replace(pattern, (_all, prefix: string, _dir: string, rel: string) => prefix + rel.replaceAll('\\', '/'))
}

const id = (path: string): string => `//#region \\0dsh-css:${path}\n`
const CANONICAL = id('src/client/Market.module.css.mjs')

describe('CSS virtual id normalization', () => {
  it('collapses a doubled path segment, which is what made two PRs unmergeable', () => {
    // The shape from #563/#570: the builder emitted `src/src/client/…`, the
    // lazy prefix match anchored on the FIRST `src/`, and the segment
    // survived into the committed bundle.
    expect(normalizeCssIds(id('src/src/client/Market.module.css.mjs'))).toBe(CANONICAL)
  })

  it('still strips the absolute prefixes it was written for', () => {
    expect(normalizeCssIds(id('/home/runner/work/dsh-market/dsh-market/src/client/Market.module.css.mjs'))).toBe(CANONICAL)
    expect(normalizeCssIds(id('C:/Users/x/dsh-market/src/client/Market.module.css.mjs'))).toBe(CANONICAL)
    expect(normalizeCssIds(id('C:\\Users\\x\\dsh-market\\src\\client\\Market.module.css.mjs'))).toBe(CANONICAL)
  })

  it('leaves an already-canonical id exactly as it is', () => {
    // Idempotence is the property the committed artefact depends on: the
    // script runs on every build, including builds of an already-normalized
    // tree.
    expect(normalizeCssIds(CANONICAL)).toBe(CANONICAL)
    expect(normalizeCssIds(normalizeCssIds(id('src/src/client/Market.module.css.mjs')))).toBe(CANONICAL)
  })

  it('normalizes every css module, not just the one that happens to exist today', () => {
    expect(normalizeCssIds(id('/abs/src/client/Other.module.css.mjs'))).toBe(id('src/client/Other.module.css.mjs'))
  })

  it('does not rewrite text that merely mentions src/', () => {
    // The bundle carries real strings; the rule is anchored on the
    // `dsh-css:` prefix precisely so it cannot reach them.
    const innocent = 'const help = "see src/client/Market.module.css for the source"\n'
    expect(normalizeCssIds(innocent)).toBe(innocent)
  })
})
