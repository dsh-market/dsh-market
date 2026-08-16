/**
 * Client-side installed-state matching (#15): one identity algorithm shared
 * by the discover badge, the installed tab, and the theme tab. Scenarios
 * contributed by @yanshuai2002's matching spec. Each case is built so only
 * ONE identity path can produce the match — a broken path cannot hide
 * behind a working fallback.
 */

import { describe, expect, it } from 'vitest'
import {
  entryForDep, extractReadmeImages, isInstalled, matchInstalledName, orderedCategories, pageItems, safeScreenshots, themePlugins, visiblePlugins,
} from '../src/client/market-data.ts'
import type { RegistryPlugin } from '../src/client/market-data.ts'

function plugin(partial: Partial<RegistryPlugin>): RegistryPlugin {
  return { name: 'x', owner: 'o', url: 'https://github.com/o/x', category: 'tool', ...partial }
}

describe('matchInstalledName / isInstalled', () => {
  it('matches through each identity path exclusively; never by prefix', () => {
    // NAME path (scoped, registry npm field unset; url points elsewhere).
    expect(matchInstalledName(
      plugin({ name: '@scope/plug', url: 'https://github.com/other/elsewhere' }),
      { '@scope/plug': '^1.0.0' },
    )).toBe('@scope/plug')

    // NAME path, case-normalized (no repo/npm fallback available).
    expect(matchInstalledName(
      plugin({ name: 'Dsh-Loop', url: 'https://github.com/other/elsewhere' }),
      { 'dsh-loop': '^1.0.0' },
    )).toBe('dsh-loop')

    // REPO path, case-normalized (key and name share nothing; URL vs github: spec).
    expect(matchInstalledName(
      plugin({ name: 'entry-name', url: 'https://github.com/VLLN/Dsh-Navbar' }),
      { 'some-key': 'github:vlln/dsh-navbar#main' },
    )).toBe('some-key')

    // REPO path reached from a scoped dependency KEY (@owner/name → owner/name).
    expect(matchInstalledName(
      plugin({ name: 'pretty-name', url: 'https://github.com/scope/plug' }),
      { '@scope/plug': '^1.0.0' },
    )).toBe('@scope/plug')

    // REPO path extracted from a monorepo /tree/ url.
    expect(matchInstalledName(
      plugin({ name: 'theme-x', url: 'https://github.com/o/collection/tree/main/packages/theme-x' }),
      { 'installed-key': 'github:o/collection#path:/packages/theme-x' },
    )).toBe('installed-key')

    // Monorepo siblings never cross-match: same repo, different subpath.
    expect(isInstalled(
      plugin({ name: 'mono#plug-b', url: 'https://github.com/m/mono/tree/main/packages/plug-b' }),
      { 'plug-a': 'github:m/mono#path:/packages/plug-a' },
    )).toBe(false)

    // Identities are exact — a mere name prefix must NOT match.
    expect(isInstalled(
      plugin({ name: 'dsh-loop', url: 'https://github.com/o/dsh-loop' }),
      { 'dsh-loop-extended': '^1.0.0' },
    )).toBe(false)
  })

  it('repo evidence beats a name coincidence — same-named entries from different repos never cross-match (#66)', () => {
    // The curated registry really lists both: two distinct dsh-usage-stats.
    const installed = { 'dsh-usage-stats': 'github:Make0209/dsh-usage-stats' }
    expect(matchInstalledName(
      plugin({ name: 'dsh-usage-stats', url: 'https://github.com/Make0209/dsh-usage-stats' }), installed,
    )).toBe('dsh-usage-stats')
    // The OTHER repo's card must not read as installed, despite the equal name.
    expect(matchInstalledName(
      plugin({ name: 'dsh-usage-stats', url: 'https://github.com/Ychris12138/dsh-usage-stats' }), installed,
    )).toBeNull()
    // …and the installed dep resolves back to the repo it came from.
    const plugins = [
      plugin({ name: 'dsh-usage-stats', url: 'https://github.com/Ychris12138/dsh-usage-stats' }),
      plugin({ name: 'dsh-usage-stats', url: 'https://github.com/Make0209/dsh-usage-stats' }),
    ]
    expect(entryForDep(plugins, 'dsh-usage-stats', 'github:make0209/dsh-usage-stats')?.url)
      .toBe('https://github.com/Make0209/dsh-usage-stats')
    // An npm-installed dep carries no repo evidence — the name path stands (#15).
    expect(matchInstalledName(
      plugin({ name: 'dsh-usage-stats', url: 'https://github.com/Ychris12138/dsh-usage-stats' }),
      { 'dsh-usage-stats': '^1.0.0' },
    )).toBe('dsh-usage-stats')
  })
})

describe('entryForDep', () => {
  it('resolves an installed dependency back to its registry entry (npm and github-spec paths)', () => {
    const plugins = [
      plugin({ name: 'a', url: 'https://github.com/o/a' }),
      plugin({ name: 'b', url: 'https://github.com/o/b', npm: 'b-npm' }),
    ]
    expect(entryForDep(plugins, 'b-npm', '^1.0.0')?.name).toBe('b')
    expect(entryForDep(plugins, 'anything', 'github:o/a#main')?.name).toBe('a')
    expect(entryForDep(plugins, 'unknown', '^1.0.0')).toBeUndefined()
  })
})

describe('discover list (visiblePlugins)', () => {
  const CATALOG: RegistryPlugin[] = [
    plugin({ name: 'dsh-loop', owner: 'alice', category: 'tool', stars: 50, added: '2026-08-01', description: { zh: '循环执行任务', en: 'Loop task runner' } }),
    plugin({ name: 'dsh-notify', owner: 'bob', category: 'tool', stars: 120, added: '2026-08-10', description: { zh: '桌面通知', en: 'Desktop notifications' } }),
    plugin({ name: 'whale-skin', owner: 'carol', category: 'theme', stars: 80, added: '2026-08-14', description: { zh: '鲸鱼主题', en: 'Whale theme' } }),
    plugin({ name: 'no-stars', owner: 'dave', category: 'memory', added: '2026-07-01', description: { en: 'Vector memory store' } }),
  ]

  it('searches across name, owner, and the localized description, case-insensitively', () => {
    expect(visiblePlugins(CATALOG, { category: 'all', query: 'LOOP', lang: 'en', sort: 'x' }).map(p => p.name)).toEqual(['dsh-loop'])
    expect(visiblePlugins(CATALOG, { category: 'all', query: 'carol', lang: 'en', sort: 'x' }).map(p => p.name)).toEqual(['whale-skin'])
    // zh UI searches the zh description; en falls back when zh is absent.
    expect(visiblePlugins(CATALOG, { category: 'all', query: '通知', lang: 'zh', sort: 'x' }).map(p => p.name)).toEqual(['dsh-notify'])
    expect(visiblePlugins(CATALOG, { category: 'all', query: 'vector', lang: 'zh', sort: 'x' }).map(p => p.name)).toEqual(['no-stars'])
    // Empty query = everything, registry order preserved.
    expect(visiblePlugins(CATALOG, { category: 'all', query: '  ', lang: 'en', sort: 'x' })).toHaveLength(4)
  })

  it('filters by category and combines with search', () => {
    expect(visiblePlugins(CATALOG, { category: 'tool', query: '', lang: 'en', sort: 'x' }).map(p => p.name)).toEqual(['dsh-loop', 'dsh-notify'])
    expect(visiblePlugins(CATALOG, { category: 'tool', query: 'notify', lang: 'en', sort: 'x' }).map(p => p.name)).toEqual(['dsh-notify'])
    expect(visiblePlugins(CATALOG, { category: 'ghost-cat', query: '', lang: 'en', sort: 'x' })).toEqual([])
  })

  it('sorts by stars or publish date, ascending and descending', () => {
    expect(visiblePlugins(CATALOG, { category: 'all', query: '', lang: 'en', sort: 'stars-desc' }).map(p => p.name))
      .toEqual(['dsh-notify', 'whale-skin', 'dsh-loop', 'no-stars'])
    expect(visiblePlugins(CATALOG, { category: 'all', query: '', lang: 'en', sort: 'stars-asc' }).map(p => p.name))
      .toEqual(['no-stars', 'dsh-loop', 'whale-skin', 'dsh-notify'])
    expect(visiblePlugins(CATALOG, { category: 'all', query: '', lang: 'en', sort: 'added-desc' }).map(p => p.name))
      .toEqual(['whale-skin', 'dsh-notify', 'dsh-loop', 'no-stars'])
    expect(visiblePlugins(CATALOG, { category: 'all', query: '', lang: 'en', sort: 'added-asc' }).map(p => p.name))
      .toEqual(['no-stars', 'dsh-loop', 'dsh-notify', 'whale-skin'])
  })

  it('themePlugins lists only themes, most-starred first', () => {
    const themes = themePlugins([...CATALOG, plugin({ name: 'starless-theme', category: 'theme' })])
    expect(themes.map(p => p.name)).toEqual(['whale-skin', 'starless-theme'])
  })

  it('orderedCategories pulls the active chip forward only while collapsed', () => {
    const cats = ['tool', 'theme', 'memory']
    expect(orderedCategories(cats, 'memory', false)).toEqual(['memory', 'tool', 'theme'])
    expect(orderedCategories(cats, 'memory', true)).toEqual(cats)
    expect(orderedCategories(cats, 'all', false)).toEqual(cats)
  })

  it('filters by the published-within window', () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
    const list = [
      plugin({ name: 'recent', added: daysAgo(3) }),
      plugin({ name: 'week-old', added: daysAgo(10) }),
      plugin({ name: 'month-old', added: daysAgo(45) }),
      plugin({ name: 'no-date' }),
    ]
    // 7-day window keeps only the 3-day-old plugin.
    expect(visiblePlugins(list, { category: 'all', query: '', lang: 'en', sort: 'x', sinceDays: 7 }).map(p => p.name))
      .toEqual(['recent'])
    // 30-day window keeps 3 and 10 days; the 45-day-old and dateless drop out.
    expect(visiblePlugins(list, { category: 'all', query: '', lang: 'en', sort: 'x', sinceDays: 30 }).map(p => p.name))
      .toEqual(['recent', 'week-old'])
    // No window keeps everything, including the dateless entry.
    expect(visiblePlugins(list, { category: 'all', query: '', lang: 'en', sort: 'x' }).map(p => p.name))
      .toEqual(['recent', 'week-old', 'month-old', 'no-date'])
  })
})

describe('discover pager (pageItems)', () => {
  it('lists every page when few enough to show without ellipses', () => {
    expect(pageItems(1, 1)).toEqual([1])
    expect(pageItems(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('windows around the current page with leading/trailing ellipses', () => {
    expect(pageItems(1, 17)).toEqual([1, 2, 3, 4, 5, '…', 17])
    expect(pageItems(9, 17)).toEqual([1, '…', 8, 9, 10, '…', 17])
    expect(pageItems(17, 17)).toEqual([1, '…', 13, 14, 15, 16, 17])
  })
})

describe('screenshots (#61)', () => {
  it('safeScreenshots keeps only https GitHub-hosted raster images, deduped and capped', () => {
    expect(safeScreenshots([
      'https://raw.githubusercontent.com/o/r/main/a.png',
      'https://raw.githubusercontent.com/o/r/main/a.png', // dupe
      'https://user-images.githubusercontent.com/1/shot.gif',
      'https://evil.example/track.png',                    // host not allowlisted
      'http://raw.githubusercontent.com/o/r/main/b.png',   // not https
      'https://raw.githubusercontent.com/o/r/main/logo.svg', // svg = logo/badge noise
      42,
    ])).toEqual([
      'https://raw.githubusercontent.com/o/r/main/a.png',
      'https://user-images.githubusercontent.com/1/shot.gif',
    ])
    expect(safeScreenshots(undefined)).toEqual([])
    // capped at 6
    const many = Array.from({ length: 9 }, (_, i) => `https://raw.githubusercontent.com/o/r/main/s${i}.png`)
    expect(safeScreenshots(many)).toHaveLength(6)
  })

  it('extractReadmeImages handles markdown + html forms and resolves relative paths', () => {
    const md = [
      '# my-plugin',
      '[![npm](https://img.shields.io/npm/v/x)](https://npmjs.com/x)', // badge → host filtered
      '![demo](assets/demo.png)',
      '![abs](/docs/abs.png)',
      '<img src="./assets/two.png" width="600">',
      '![ext](https://user-images.githubusercontent.com/1/ext.png)',
      '![logo](assets/logo.svg)', // svg filtered
    ].join('\n')
    expect(extractReadmeImages(md, 'o', 'r', null)).toEqual([
      'https://raw.githubusercontent.com/o/r/HEAD/assets/demo.png',
      'https://raw.githubusercontent.com/o/r/HEAD/docs/abs.png',
      'https://raw.githubusercontent.com/o/r/HEAD/assets/two.png',
      'https://user-images.githubusercontent.com/1/ext.png',
    ])
    // Monorepo subpath README: relative paths resolve against the subdir.
    expect(extractReadmeImages('![s](shot.png)', 'o', 'r', 'packages/plug-a')).toEqual([
      'https://raw.githubusercontent.com/o/r/HEAD/packages/plug-a/shot.png',
    ])
    expect(extractReadmeImages('no images here', 'o', 'r', null)).toEqual([])
  })
})
