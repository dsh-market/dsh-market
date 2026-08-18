/**
 * The built client bundle is a COMMITTED and PUBLISHED artifact, so it has to
 * be byte-identical no matter whose machine built it — normalize-client-
 * banner.mjs says so in its own header, and preflight enforces the parts of
 * that contract it can see.
 *
 * The CSS module class map was a hole in it: tsdown emits the keys in an
 * unstable order, so two consecutive builds of identical source differed by
 * ~265 lines. `prepare` runs the build on a plain `npm install`, which means
 * every contributor's working tree acquired that diff without them editing
 * anything — three open PRs carried it, all conflicting on a generated file.
 *
 * Determinism itself is verified by building repeatedly, which is far too
 * slow for a unit spec. What is checked here is the transform: that it sorts
 * what it must, leaves alone what it must not, and preserves the two
 * properties the rest of the pipeline depends on — line count (for sourcemap
 * validity) and comma placement (for the file parsing at all).
 */

import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain .mjs build script, no types
import { sortClassMaps } from '../scripts/sort-class-maps.mjs'

const sort = sortClassMaps as (code: string) => { code: string; sorted: number }

describe('sortClassMaps', () => {
  it('orders a CSS module class map and leaves the last entry comma-free', () => {
    const input = [
      '\t\t{',
      '\t\t\t"swatches": "SOz1_a_swatches",',
      '\t\t\t"bar": "SOz1_a_bar",',
      '\t\t\t"cats": "SOz1_a_cats"',
      '\t\t}',
    ].join('\n')

    const { code, sorted } = sort(input)
    expect(sorted).toBe(3)
    expect(code.split('\n')).toEqual([
      '\t\t{',
      '\t\t\t"bar": "SOz1_a_bar",',
      '\t\t\t"cats": "SOz1_a_cats",',
      '\t\t\t"swatches": "SOz1_a_swatches"',
      '\t\t}',
    ])
  })

  it('keeps the comma on position, not on the entry that moved (measured bug)', () => {
    // The first version of this transform required a trailing comma, so the
    // final entry never joined the run. Whichever key randomly landed last
    // stayed pinned while the rest sorted around it, and the build was still
    // two lines different every time — 4 lines of diff instead of 265, which
    // looks fixed until you diff twice.
    const input = [
      '\t\t\t"zeta": "P_zeta",',
      '\t\t\t"alpha": "P_alpha"',
    ].join('\n')

    const { code } = sort(input)
    expect(code).toBe('\t\t\t"alpha": "P_alpha",\n\t\t\t"zeta": "P_zeta"')
    // Sorting an already-sorted map is a no-op, so a second build of the same
    // source cannot differ from the first — the property that matters.
    expect(sort(code).code).toBe(code)
  })

  it('never reorders a map that is not a CSS class map', () => {
    // The locale tables live in the same bundle and have the same line shape.
    // A looser "sort any object literal" rule would churn them too, and
    // silently reorder text a human maintains against the source.
    const locales = [
      '\t\t\t"install": "安装",',
      '\t\t\t"cancel": "取消",',
      '\t\t\t"about": "关于"',
    ].join('\n')
    expect(sort(locales)).toEqual({ code: locales, sorted: 0 })

    // A value that merely CONTAINS the key is not the `<prefix><key>` shape.
    const nearMiss = [
      '\t\t\t"zeta": "zeta_suffix",',
      '\t\t\t"alpha": "alpha_suffix"',
    ].join('\n')
    expect(sort(nearMiss).sorted).toBe(0)

    // An identity map (value === key) reached through a line whose value does
    // NOT end with its key. Without the shape check on the run's first line
    // the prefix degrades to the empty string, and every `"x": "x"` line
    // after it then satisfies `value === prefix + key` and gets swallowed
    // into the run — reordering a map that is not a class map at all.
    const identity = [
      '\t\t\t"abc": "xyz",',
      '\t\t\t"foo": "foo",',
      '\t\t\t"bar": "bar"',
    ].join('\n')
    expect(sort(identity)).toEqual({ code: identity, sorted: 0 })
  })

  it('preserves the line count, which the sourcemap depends on', () => {
    // normalize-client-banner.mjs folds the three-line banner into one line
    // by blanking the other two rather than deleting them, precisely so the
    // sourcemap stays valid. A reorder that changed the line count would
    // break the same invariant from the other end.
    const input = [
      '\t\t\t"c": "X_c",',
      '\t\t\t"a": "X_a",',
      '\t\t\t"b": "X_b"',
      '\t\t}',
      '\t\tconst other = 1',
    ].join('\n')
    expect(sort(input).code.split('\n')).toHaveLength(input.split('\n').length)
  })

  it('does not merge two adjacent maps with different prefixes', () => {
    // Two CSS modules emitted back to back must stay separate objects; a run
    // that spanned both would move keys across an object boundary and
    // produce a bundle that no longer parses.
    //
    // The first run ends WITH a comma here, which is the case that separates
    // preserving each position's comma from inferring it as "all but the
    // last". Inference drops that comma and the bundle stops parsing; the
    // shape is unremarkable enough that only an explicit case pins it.
    const input = [
      '\t\t\t"z": "A_z",',
      '\t\t\t"y": "A_y",',
      '\t\t\t"q": "B_q",',
      '\t\t\t"p": "B_p"',
    ].join('\n')
    const { code } = sort(input)
    expect(code.split('\n')).toEqual([
      '\t\t\t"y": "A_y",',
      '\t\t\t"z": "A_z",',
      '\t\t\t"p": "B_p",',
      '\t\t\t"q": "B_q"',
    ])
  })

  it('does not merge runs that share a prefix but sit at different depths', () => {
    // Same prefix, different indent — two different objects. Merging them
    // would sort keys across the boundary AND carry each line's own indent
    // with it, leaving a jumble that reads as corruption in review.
    const input = [
      '\t\t\t"z": "A_z",',
      '\t\t"y": "A_y"',
    ].join('\n')
    expect(sort(input)).toEqual({ code: input, sorted: 0 })
  })
})
