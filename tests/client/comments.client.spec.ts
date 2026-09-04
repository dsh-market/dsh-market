/**
 * The three surfaces that show a plugin's comments — this market, the
 * dshmarket.com detail page, and the awesome-dsh-plugin catalog page — only
 * share one discussion while they agree on the repository ids and on the term.
 * Nothing at runtime notices when they stop agreeing: giscus happily opens a
 * second, empty thread and reports no error. These tests are the only place
 * that disagreement becomes visible, so they read the real files rather than
 * restating the values.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GISCUS, commentsDiscussionUrl, commentsTerm, giscusLang, pluginSlug } from '../../src/client/comments.ts'

const root = new URL('../../', import.meta.url)

describe('giscus configuration', () => {
  it('matches the config the static site is built with', async () => {
    const site = (await import(new URL('site/comments.mjs', root).href)).default
    expect(site.enabled).toBe(true)
    expect({
      repo: site.repo,
      repoId: site.repoId,
      category: site.category,
      categoryId: site.categoryId,
    }).toEqual({ ...GISCUS })
  })
})

describe('pluginSlug', () => {
  it('is the repository path for a whole-repo plugin', () => {
    expect(pluginSlug('https://github.com/owner/dsh-plugin-x')).toBe('owner/dsh-plugin-x')
  })

  it('qualifies a subdirectory entry so one repo can hold several plugins', () => {
    expect(pluginSlug('https://github.com/owner/repo/tree/main/packages/a')).toBe('owner/repo--packages-a')
    expect(pluginSlug('https://github.com/owner/repo/tree/main/packages/b')).toBe('owner/repo--packages-b')
  })

  it('ignores the ref, so a repo that renames its branch keeps its thread', () => {
    expect(pluginSlug('https://github.com/o/r/tree/master/p')).toBe(pluginSlug('https://github.com/o/r/tree/main/p'))
  })

  it('agrees with the site builder over the whole real catalog', () => {
    // The builder is plain node ESM with side effects at import time, so its
    // slugOf is lifted out by source rather than imported. If that function is
    // reworded this test fails loudly, which is the point.
    const src = readFileSync(fileURLToPath(new URL('scripts/build-site.mjs', root)), 'utf8')
    const body = /function slugOf\(p\) \{([\s\S]*?)\n\}/.exec(src)
    expect(body, 'slugOf not found in scripts/build-site.mjs').not.toBeNull()
    // eslint-disable-next-line no-new-func
    const slugOf = new Function('p', body![1]!) as (p: { url: string }) => string

    const snap = JSON.parse(readFileSync(fileURLToPath(new URL('data/registry-snapshot.json', root)), 'utf8'))
    const plugins: { url: string }[] = snap.plugins ?? []
    expect(plugins.length).toBeGreaterThan(100)

    const disagree = plugins.filter(p => slugOf(p) !== pluginSlug(p.url)).map(p => p.url)
    expect(disagree).toEqual([])

    // A collision would mean two plugins sharing one comment thread.
    const seen = new Map<string, string>()
    const collisions: string[] = []
    for (const p of plugins) {
      const term = commentsTerm(p.url)
      const prev = seen.get(term)
      if (prev !== undefined && prev !== p.url) collisions.push(`${term}: ${prev} vs ${p.url}`)
      else seen.set(term, p.url)
    }
    expect(collisions).toEqual([])
  })
})

describe('commentsDiscussionUrl', () => {
  it('searches GitHub for the exact shared discussion term', () => {
    const href = new URL(commentsDiscussionUrl('https://github.com/owner/repo/tree/main/packages/a'))
    expect(href.origin + href.pathname).toBe(
      'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/discussions',
    )
    expect(href.searchParams.get('discussions_q')).toBe('"plugin:owner/repo--packages-a"')
  })
})

describe('giscusLang', () => {
  it('maps this plugin\'s codes onto giscus\'s own', () => {
    expect(giscusLang('zh')).toBe('zh-CN')
    expect(giscusLang('en')).toBe('en')
    // Anything unrecognised gets a real locale rather than a blank widget.
    expect(giscusLang('de')).toBe('en')
  })
})
