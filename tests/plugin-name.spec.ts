/**
 * The card title: the plugin's own name, not its catalog identity.
 *
 * Every case below is a real entry from the live catalog (1393 entries,
 * 104 of them compound), because the shapes here were not designed — they
 * arrived, and two upstream conventions arrived with them.
 */

import { describe, expect, it } from 'vitest'
import { pluginName } from '../src/client/market-data.ts'

describe('pluginName', () => {
  it('leaves an ordinary plugin alone', () => {
    // 93% of the catalog. A repository holding one plugin is named after
    // it, so the identity already IS the name.
    expect(pluginName('dsh-loop')).toBe('dsh-loop')
    expect(pluginName('dshmarket')).toBe('dshmarket')
  })

  it('takes the plugin out of a repository that holds several', () => {
    // Both upstream conventions, which differ for no reason anyone chose:
    // one writes the sub-package, the other writes its path. They describe
    // the same plugin and now render identically.
    expect(pluginName('dsh-web-ui#packages/dsh-web-ui-all')).toBe('dsh-web-ui-all')
    expect(pluginName('dsh-web-ui#dsh-web-ui-all')).toBe('dsh-web-ui-all')
    expect(pluginName('dsh-plugins#src/plugins/dsh-plugin-setting-mcp')).toBe('dsh-plugin-setting-mcp')
  })

  it('matches what the installed list already calls the same plugin', () => {
    // The bug this exists for: the installed tab reads names out of the
    // profile manifest, so one plugin was `dsh-web-ui#packages/dsh-web-ui-all`
    // before the Install button and `dsh-web-ui-all` after it.
    expect(pluginName('dsh-web-ui#packages/dsh-web-ui-all')).toBe('dsh-web-ui-all')
  })

  it('keeps duplicates rather than qualifying them', () => {
    // Two authors may ship a plugin of the same name; the byline separates
    // them. Re-attaching the repository to keep titles unique would put the
    // structure back on screen to solve a problem the avatar already solves.
    expect(pluginName('a-repo#dsh-usage')).toBe('dsh-usage')
    expect(pluginName('b-repo#dsh-usage')).toBe('dsh-usage')
  })

  it('answers something rather than nothing for a malformed identity', () => {
    // A title is a required element of the card; an empty one is a broken
    // row, not a tidy one.
    expect(pluginName('repo#')).toBe('repo')
    expect(pluginName('repo#packages/')).toBe('repo')
    expect(pluginName('#')).toBe('')
  })
})
