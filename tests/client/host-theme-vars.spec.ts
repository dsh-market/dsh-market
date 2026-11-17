/**
 * Every CSS variable the market's client reads must exist (#805).
 *
 * `var(--name, fallback)` never fails loudly: a name the host does not define
 * silently becomes its fallback, on every host, forever. That is how #805's
 * fix shipped doing nothing. It pointed eleven monospace rules at
 * `--dsw-alias-font-mono`, a name the host's theme has never defined, so
 * Windows kept falling back to SimSun — while the theme's real code-font
 * token, `--ds-font-family-code`, was there all along (the reporter named it in
 * the issue). `--dsw-alias-border-default` was the same mistake: undefined, so
 * three borders stayed light grey in dark mode.
 *
 * The list of names the host defines is generated from the published
 * `@deepseek-ai/dsh-client-ui-theme` (see the fixture's header). A name the
 * market defines for itself (`--fold-*`) is fine too.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CLIENT = join(__dirname, '..', '..', 'src', 'client')
const sources = readdirSync(CLIENT)
  .filter(name => /\.(css|tsx?)$/.test(name))
  .map(name => ({ name, text: readFileSync(join(CLIENT, name), 'utf8') }))

const hostDefined = new Set(
  readFileSync(join(__dirname, '..', 'fixtures', 'host-theme-custom-properties.txt'), 'utf8')
    .split('\n').map(line => line.trim()).filter(line => line.startsWith('--')),
)
/**
 * Published by the host's layout frame rather than its theme, so the theme
 * fixture cannot list them. Each is documented in `dsh-client-ui-layout`'s
 * README and read the same way by the host's own pages.
 */
const layoutDefined = new Set(['--dsh-frame-top-clearance'])
for (const name of layoutDefined) hostDefined.add(name)
/**
 * Supplied by a theme at runtime, and deliberately NOT declared by the market:
 * a local declaration would shadow the inherited value, which is the whole
 * point of the hook. A theme sets them as inline custom properties on the page
 * root (or in any rule above the market) when it makes the host's page colour
 * transparent — see the sticky rows' comment in `Market.module.css` (#1237).
 */
const themeSupplied = new Set(['--dshm-sticky-bg', '--dshm-stuck-bg'])
for (const name of themeSupplied) hostDefined.add(name)
const marketDefined = new Set(sources.flatMap(({ text }) => [...text.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map(match => match[1]!)))

describe('the CSS variables the market reads', () => {
  it('are all defined — by the host theme or by the market itself', () => {
    const undefinedUses = sources.flatMap(({ name, text }) =>
      [...text.matchAll(/var\((--[a-zA-Z0-9-]+)/g)]
        .map(match => match[1]!)
        .filter(variable => !hostDefined.has(variable) && !marketDefined.has(variable))
        .map(variable => `${name}: ${variable}`))

    expect([...new Set(undefinedUses)]).toEqual([])
  })

  it('reads the host theme\'s own code font for every monospace rule', () => {
    const css = readFileSync(join(CLIENT, 'Market.module.css'), 'utf8')
    const stacks = [...css.matchAll(/font-family:([^;}]*)/g)].map(match => match[1]!)
    const monospace = stacks.filter(stack => /monospace/.test(stack))

    expect(monospace.length).toBeGreaterThan(0)
    for (const stack of monospace) {
      expect(stack).toContain('var(--ds-font-family-code')
      // A host without the theme still gets a Windows monospace font before
      // the generic one, which on Simplified-Chinese Windows is SimSun.
      expect(stack).toMatch(/Consolas[^)]*monospace\)$/)
    }
  })

  /**
   * The theme hooks (#1237) have to be the last fallback of every surface that
   * can sit over the cards, and the stuck one has to be reachable — a hook the
   * stylesheet names in its comment but not in its `background` fixes nothing.
   */
  it('routes every sticky surface through the theme hooks, unstuck and stuck', () => {
    const css = readFileSync(join(CLIENT, 'Market.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    // Discover's .stickyHead, then .head and .cats on the Plugins tab.
    const resting = [...css.matchAll(/background:var\(--dshm-sticky-bg,var\(--dsw-alias-bg-base,#fff\)\)/g)]
    expect(resting).toHaveLength(3)
    for (const row of ['head', 'cats']) {
      expect(css).toMatch(new RegExp(
        `\\.${row}\\[data-dshm-stuck="true"\\][^{]*\\{[^}]*background:var\\(--dshm-stuck-bg,var\\(--dshm-sticky-bg`,
      ))
    }
    // Neither hook may be declared here: a local declaration would shadow the
    // value a theme sets above the market, which is the only way it can arrive.
    for (const hook of ['--dshm-sticky-bg', '--dshm-stuck-bg']) {
      expect(css).not.toMatch(new RegExp(`${hook}\\s*:`))
    }
  })
})
