/**
 * Client-side installed-state matching (#15): one identity algorithm shared
 * by the discover badge, the installed tab, and the theme tab. Scenarios
 * contributed by @yanshuai2002's matching spec. Each case is built so only
 * ONE identity path can produce the match — a broken path cannot hide
 * behind a working fallback.
 */

import { describe, expect, it } from 'vitest'
import {
  entryForDep, extractReadmeImageCandidates, extractReadmeImages, formatCount, groupSwitchState, installedForCatalog, isInstalled, isMarketItself, looksTerminal, matchInstalledName, orderedCategories, pageItems, pluginCategories, pluginsForFavorites, previewDimensionScore, rankThemeScreenshots, safeScreenshots, staleFavoriteUrls, themePlugins, visiblePlugins, humanOutput} from '../src/client/market-data.ts'
import type { RegistryPlugin, ScreenshotCandidate } from '../src/client/market-data.ts'

function plugin(partial: Partial<RegistryPlugin>): RegistryPlugin {
  return { name: 'x', owner: 'o', url: 'https://github.com/o/x', category: 'tool', ...partial }
}

describe('looksTerminal', () => {
  it('does not label a web plugin as terminal-only when the description says a CLI is not required', () => {
    expect(looksTerminal(plugin({
      name: 'dsh-codex-subscription',
      description: { en: 'ChatGPT OAuth provider for DSH; no API key or Codex CLI required.' },
    }), 'en')).toBe(false)

    expect(looksTerminal(plugin({
      name: 'dsh-codex-subscription',
      description: { zh: '在 DSH 网页版中使用 Codex；无需 API Key 或 Codex CLI。' },
    }), 'zh')).toBe(false)
  })

  it('still warns for plugins that positively target a terminal surface', () => {
    expect(looksTerminal(plugin({ name: 'dsh-tui' }), 'en')).toBe(true)
    expect(looksTerminal(plugin({ description: { zh: '为 DSH 提供命令行界面。' } }), 'zh')).toBe(true)
  })
})

describe('installedForCatalog', () => {
  it('adds Bundle presence without replacing dependency specs', () => {
    expect(installedForCatalog(
      { managed: '^2.0.0', shared: 'workspace:*' },
      ['host-provided', 'shared'],
    )).toEqual({
      'host-provided': '*',
      shared: 'workspace:*',
      managed: '^2.0.0',
    })
  })
})

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

  it('uses local repo evidence to disambiguate same-named link installs (#141)', () => {
    const installed = { 'dsh-vision-bridge': 'link:D:/pro/dsh/dsh-vision-bridge' }
    const repoIdentities = { 'dsh-vision-bridge': ['gxx182/dsh-vision-bridge'] }
    const plugins = [
      plugin({ name: 'dsh-vision-bridge', url: 'https://github.com/GXX182/dsh-vision-bridge' }),
      plugin({ name: 'dsh-vision-bridge', url: 'https://github.com/ximengxiaolan/dsh-vision-bridge' }),
    ]

    expect(matchInstalledName(
      plugins[0]!,
      installed,
      repoIdentities,
    )).toBe('dsh-vision-bridge')
    expect(matchInstalledName(
      plugins[1]!,
      installed,
      repoIdentities,
    )).toBeNull()

    // With no strong identity the client admits ambiguity instead of marking
    // every same-named catalog entry as installed.
    expect(matchInstalledName(plugins[0]!, installed, {}, plugins)).toBeNull()
    expect(matchInstalledName(plugins[1]!, installed, {}, plugins)).toBeNull()
    expect(entryForDep(plugins, 'dsh-vision-bridge', installed['dsh-vision-bridge']!)).toBeUndefined()
  })

  it('uses a weak Git-origin hint only among duplicate candidates', () => {
    const installed = { 'dsh-vision-bridge': 'link:D:/src/dsh-vision-bridge' }
    const plugins = [
      plugin({ name: 'dsh-vision-bridge', url: 'https://github.com/gxx182/dsh-vision-bridge' }),
      plugin({ name: 'dsh-vision-bridge', url: 'https://github.com/other/dsh-vision-bridge' }),
    ]
    const hints = { 'dsh-vision-bridge': ['gxx182/dsh-vision-bridge'] }

    expect(matchInstalledName(plugins[0]!, installed, {}, plugins, hints)).toBe('dsh-vision-bridge')
    expect(matchInstalledName(plugins[1]!, installed, {}, plugins, hints)).toBeNull()
    expect(entryForDep(plugins, 'dsh-vision-bridge', installed['dsh-vision-bridge']!, [], hints['dsh-vision-bridge'])).toBe(plugins[0])
  })

  it('keeps a unique loose name match when no repository identity exists', () => {
    const installed = { 'dsh-vision-bridge': 'link:D:/src/dsh-vision-bridge' }
    const only = plugin({ name: 'dsh-vision-bridge', url: 'https://github.com/other/dsh-vision-bridge' })

    expect(matchInstalledName(only, installed, {}, [only])).toBe('dsh-vision-bridge')
    expect(entryForDep([only], 'dsh-vision-bridge', installed['dsh-vision-bridge']!)).toBe(only)
    expect(isInstalled(only, installed, {}, [only])).toBe(true)
  })

  it('keeps the unique loose name match when a weak hint disagrees', () => {
    const installed = { 'dsh-vision-bridge': 'link:D:/src/dsh-vision-bridge' }
    const only = plugin({ name: 'dsh-vision-bridge', url: 'https://github.com/other/dsh-vision-bridge' })
    const hints = { 'dsh-vision-bridge': ['gxx182/dsh-vision-bridge'] }

    expect(matchInstalledName(only, installed, {}, [only], hints)).toBe('dsh-vision-bridge')
    expect(entryForDep([only], 'dsh-vision-bridge', installed['dsh-vision-bridge']!, [], hints['dsh-vision-bridge'])).toBe(only)
  })

  it('rejects malformed repository identities from local package metadata', () => {
    const name = 'dsh-vision-bridge'
    const installed = { [name]: 'link:D:/src/dsh-vision-bridge' }
    const plugins = [
      plugin({ name, url: 'https://example.invalid/first' }),
      plugin({ name, url: 'https://example.invalid/second' }),
    ]
    const repoIdentities = { [name]: ['not a repo id', 'a/b/c/d'] }

    expect(matchInstalledName(plugins[0]!, installed, repoIdentities, plugins)).toBeNull()
    expect(entryForDep(plugins, name, installed[name]!, repoIdentities[name])).toBeUndefined()
  })

  it('rejects repository identities with traversal segments', () => {
    const name = 'dsh-vision-bridge'
    const installed = { [name]: 'link:D:/src/dsh-vision-bridge' }
    const plugins = [
      plugin({ name, url: 'https://example.invalid/first' }),
      plugin({ name, url: 'https://example.invalid/second' }),
    ]
    const repoIdentities = { [name]: ['owner/repo#path:/../../x'] }

    expect(matchInstalledName(plugins[0]!, installed, repoIdentities, plugins)).toBeNull()
    expect(entryForDep(plugins, name, installed[name]!, repoIdentities[name])).toBeUndefined()
  })

  it('matches local monorepo evidence the same way as a github:#path spec', () => {
    const root = plugin({ name: 'collection', url: 'https://github.com/o/collection' })
    const exact = plugin({
      name: 'plugin-a',
      url: 'https://github.com/o/collection/tree/main/packages/plugin-a',
    })
    const sibling = plugin({
      name: 'plugin-b',
      url: 'https://github.com/o/collection/tree/main/packages/plugin-b',
    })
    const installed = { 'plugin-a': 'link:D:/src/collection/packages/plugin-a' }
    const repoIdentities = {
      'plugin-a': ['o/collection', 'o/collection#path:/packages/plugin-a'],
    }

    expect(matchInstalledName(root, installed, repoIdentities)).toBe('plugin-a')
    expect(matchInstalledName(exact, installed, repoIdentities)).toBe('plugin-a')
    expect(matchInstalledName(sibling, installed, repoIdentities)).toBeNull()

    const sha = 'b0e6c57ebeeb4796017864f5cd5c66e6ba0899ec'
    const pinned = { 'plugin-a': `github:o/collection#${sha}&path:/packages/plugin-a` }
    expect(matchInstalledName(root, pinned)).toBe('plugin-a')
    expect(matchInstalledName(exact, pinned)).toBe('plugin-a')
    expect(matchInstalledName(sibling, pinned)).toBeNull()
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
    plugin({ name: 'dsh-loop', owner: 'alice', category: ['tool', 'skill', 'tool'], stars: 50, added: '2026-08-01', description: { zh: '循环执行任务', en: 'Loop task runner' } }),
    plugin({ name: 'dsh-notify', owner: 'bob', category: 'tool', stars: 120, added: '2026-08-10', description: { zh: '桌面通知', en: 'Desktop notifications' } }),
    plugin({ name: 'whale-skin', owner: 'carol', category: 'theme', stars: 80, added: '2026-08-14', description: { zh: '鲸鱼主题', en: 'Whale theme' } }),
    plugin({ name: 'no-stars', owner: 'dave', category: 'memory', added: '2026-07-01', description: { en: 'Vector memory store' } }),
  ]

  it('searches package identities, owners, and every localized description case-insensitively', () => {
    expect(visiblePlugins(CATALOG, { category: 'all', query: 'LOOP', lang: 'en', sort: 'x' }).map(p => p.name)).toEqual(['dsh-loop'])
    expect(visiblePlugins(CATALOG, { category: 'all', query: 'carol', lang: 'en', sort: 'x' }).map(p => p.name)).toEqual(['whale-skin'])
    // The current locale ranks higher, but other translations remain searchable.
    expect(visiblePlugins(CATALOG, { category: 'all', query: '通知', lang: 'zh', sort: 'x' }).map(p => p.name)).toEqual(['dsh-notify'])
    expect(visiblePlugins(CATALOG, { category: 'all', query: '循环', lang: 'en', sort: 'x' }).map(p => p.name)).toEqual(['dsh-loop'])
    expect(visiblePlugins(CATALOG, { category: 'all', query: 'vector', lang: 'zh', sort: 'x' }).map(p => p.name)).toEqual(['no-stars'])
    expect(visiblePlugins([
      plugin({ name: 'friendly-title', npm: '@scope/dsh-mcp-tools' }),
    ], { category: 'all', query: 'mcp tools', lang: 'en', sort: 'x' }).map(p => p.name)).toEqual(['friendly-title'])
    // Empty query = everything, registry order preserved.
    expect(visiblePlugins(CATALOG, { category: 'all', query: '  ', lang: 'en', sort: 'x' })).toHaveLength(4)
  })

  it('ranks package-name relevance before popularity and uses the selected sort as a tie-breaker', () => {
    const rows: RegistryPlugin[] = [
      plugin({ name: 'popular-agent', downloads: 500_000, description: { en: 'MCP integration for agents' } }),
      plugin({ name: 'dsh-mcp-panel', downloads: 50 }),
      plugin({ name: 'dsh-mcp-connector', downloads: 3_200 }),
    ]
    expect(visiblePlugins(rows, {
      category: 'all', query: 'mcp', lang: 'en', sort: 'downloads-desc',
    }).map(p => p.name)).toEqual([
      'dsh-mcp-connector',
      'dsh-mcp-panel',
      'popular-agent',
    ])
  })

  it('normalizes punctuation and keeps exact package names ahead of longer prefixes', () => {
    const rows: RegistryPlugin[] = [
      plugin({ name: 'dsh-mcp-connector-guide', downloads: 50_000 }),
      plugin({ name: 'dsh-mcp-connector', downloads: 10 }),
    ]
    expect(visiblePlugins(rows, {
      category: 'all', query: 'DSH MCP connector', lang: 'en', sort: 'downloads-desc',
    }).map(p => p.name)).toEqual(['dsh-mcp-connector', 'dsh-mcp-connector-guide'])
  })

  it('treats adjacent Han and Latin terms like their space-separated forms', () => {
    const rows: RegistryPlugin[] = [
      plugin({ name: 'compact-panel', downloads: 1, description: { zh: 'MCP面板' } }),
      plugin({ name: 'expanded-panel', downloads: 100_000, description: { zh: 'MCP 运行状态面板' } }),
      plugin({ name: 'market-tools', downloads: 80_000, description: { zh: 'MCP Server 市场' } }),
    ]
    const names = (query: string) => visiblePlugins(rows, {
      category: 'all', query, lang: 'zh', sort: 'downloads-desc',
    }).map(p => p.name)

    // The compact field is an exact match and remains ahead of the much more
    // popular expanded description. Both query spellings return the same set
    // in the same order, so the rule applies to indexed fields and queries.
    expect(names('MCP面板')).toEqual(['compact-panel', 'expanded-panel'])
    expect(names('MCP 面板')).toEqual(names('MCP面板'))
    expect(names('MCP市场')).toEqual(['market-tools'])
    expect(names('MCP 市场')).toEqual(names('MCP市场'))
  })

  it('recognizes Han-to-Latin and number-to-Han boundaries without crossing fields', () => {
    const rows: RegistryPlugin[] = [
      plugin({ name: 'compact-reverse', downloads: 1, description: { zh: '管理API' } }),
      plugin({ name: 'expanded-reverse', downloads: 90_000, description: { zh: '统一管理 API 服务' } }),
      plugin({ name: 'oauth-guide', description: { zh: 'OAuth2授权指南' } }),
      // `API` and `管理` exist, but not in the same field. Boundary splitting
      // must not weaken the existing same-field requirement.
      plugin({ name: 'split-fields', owner: 'API team', description: { zh: '统一管理' } }),
    ]
    const names = (query: string) => visiblePlugins(rows, {
      category: 'all', query, lang: 'zh', sort: 'downloads-desc',
    }).map(p => p.name)

    expect(names('管理API')).toEqual(['compact-reverse', 'expanded-reverse'])
    expect(names('管理 API')).toEqual(names('管理API'))
    expect(names('OAuth2授权')).toEqual(['oauth-guide'])
    expect(names('OAuth2 授权')).toEqual(names('OAuth2授权'))
    expect(names('API管理')).not.toContain('split-fields')
  })

  it('treats punctuation-only input as no search and keeps multi-word matches within one field', () => {
    const rows: RegistryPlugin[] = [
      plugin({ name: 'task-helper', description: { en: 'Runner utilities' } }),
      plugin({ name: 'workflow-loop', description: { en: 'Task runner for projects' } }),
    ]
    expect(visiblePlugins(rows, {
      category: 'all', query: '---', lang: 'en', sort: 'x',
    })).toHaveLength(2)
    expect(visiblePlugins(rows, {
      category: 'all', query: 'task runner', lang: 'en', sort: 'x',
    }).map(p => p.name)).toEqual(['workflow-loop'])
  })

  it('filters by any category and keeps legacy string categories working', () => {
    expect(pluginCategories(CATALOG[0]!)).toEqual(['tool', 'skill'])
    expect(pluginCategories(CATALOG[1]!)).toEqual(['tool'])
    expect(visiblePlugins(CATALOG, { category: 'tool', query: '', lang: 'en', sort: 'x' }).map(p => p.name)).toEqual(['dsh-loop', 'dsh-notify'])
    expect(visiblePlugins(CATALOG, { category: 'skill', query: '', lang: 'en', sort: 'x' }).map(p => p.name)).toEqual(['dsh-loop'])
    expect(visiblePlugins(CATALOG, { category: 'tool', query: 'notify', lang: 'en', sort: 'x' }).map(p => p.name)).toEqual(['dsh-notify'])
    expect(visiblePlugins(CATALOG, { category: 'ghost-cat', query: '', lang: 'en', sort: 'x' })).toEqual([])
  })

  it('searches category ids and every localized category label', () => {
    const categories = { skill: { en: 'Skills', zh: '技能包' } }
    expect(visiblePlugins(CATALOG, { category: 'all', query: 'skill', lang: 'en', categories, sort: 'x' }).map(p => p.name)).toEqual(['dsh-loop'])
    expect(visiblePlugins(CATALOG, { category: 'all', query: 'Skills', lang: 'en', categories, sort: 'x' }).map(p => p.name)).toEqual(['dsh-loop'])
    expect(visiblePlugins(CATALOG, { category: 'all', query: '技能包', lang: 'en', categories, sort: 'x' }).map(p => p.name)).toEqual(['dsh-loop'])
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

  it('sorts by npm downloads, with no-npm entries falling back to stars', () => {
    // Mixed on purpose: some entries have a real download count, some have
    // none at all (no npm package — awesome-dsh-plugin publishes `null` for
    // those, never a fabricated 0). A github:-only plugin must never read as
    // "less popular than a package with genuinely 0 downloads" — it sinks
    // below every entry WITH a count, in both directions, and among itself
    // and other no-download entries falls back to star count, the only
    // signal that exists for them.
    // Array order deliberately disagrees with the expected result on both
    // axes (the no-download pair is listed fewer-stars-first, the opposite
    // of the star order the fallback must produce) — a mutant that quietly
    // stops re-sorting and just keeps original array order would otherwise
    // pass by coincidence.
    const mixed: RegistryPlugin[] = [
      plugin({ name: 'no-npm-fewer-stars', stars: 20 }), // downloads absent
      plugin({ name: 'few-downloads', stars: 900, downloads: 50 }),
      plugin({ name: 'no-npm-more-stars', stars: 300 }), // downloads absent
      plugin({ name: 'many-downloads', stars: 10, downloads: 5000 }),
    ]
    expect(visiblePlugins(mixed, { category: 'all', query: '', lang: 'en', sort: 'downloads-desc' }).map(p => p.name))
      .toEqual(['many-downloads', 'few-downloads', 'no-npm-more-stars', 'no-npm-fewer-stars'])
    expect(visiblePlugins(mixed, { category: 'all', query: '', lang: 'en', sort: 'downloads-asc' }).map(p => p.name))
      .toEqual(['few-downloads', 'many-downloads', 'no-npm-fewer-stars', 'no-npm-more-stars'])
  })

  it('treats an npm package with genuinely zero downloads as real data, not as absent', () => {
    // 0 is a fact this month taught us, not a coverage gap — it must rank
    // BELOW a package with any real downloads, but still ABOVE a github:-only
    // entry that was never eligible for a count at all.
    // zero-downloads is given FEWER stars than no-npm-package on purpose: if
    // 0 were ever treated as "no data" and fell back to the star ordering
    // alongside no-npm-package, the higher-star no-npm-package would rank
    // first — the opposite of what real data (even a real zero) must do.
    const rows: RegistryPlugin[] = [
      plugin({ name: 'has-downloads', stars: 1, downloads: 5 }),
      plugin({ name: 'zero-downloads', stars: 10, downloads: 0 }),
      plugin({ name: 'no-npm-package', stars: 500 }),
    ]
    expect(visiblePlugins(rows, { category: 'all', query: '', lang: 'en', sort: 'downloads-desc' }).map(p => p.name))
      .toEqual(['has-downloads', 'zero-downloads', 'no-npm-package'])
  })

  it('themePlugins lists only themes, most-starred first', () => {
    const themes = themePlugins([...CATALOG, plugin({ name: 'starless-theme', category: 'theme' })])
    expect(themes.map(p => p.name)).toEqual(['whale-skin', 'starless-theme'])
  })

  it('pluginsForFavorites keeps only bookmarked catalog entries', () => {
    const rows = [
      plugin({ name: 'dsh-loop', url: 'https://github.com/o/dsh-loop' }),
      plugin({ name: 'dsh-notify', url: 'https://github.com/o/dsh-notify' }),
    ]
    const urls = new Set(['https://github.com/o/dsh-loop', 'https://github.com/ghost/gone'])
    const listed = pluginsForFavorites(rows, urls, { query: '', lang: 'en', sort: 'stars-desc' })
    expect(listed.map(p => p.name)).toEqual(['dsh-loop'])
  })

  it('staleFavoriteUrls lists bookmarks with no catalog row', () => {
    const rows = [plugin({ name: 'dsh-loop', url: 'https://github.com/o/dsh-loop' })]
    expect(staleFavoriteUrls(
      ['https://github.com/o/dsh-loop', 'https://github.com/ghost/gone'],
      rows,
    )).toEqual(['https://github.com/ghost/gone'])
  })

  it('orderedCategories pulls the active chip forward only while collapsed', () => {
    const cats = ['tool', 'theme', 'memory']
    // No visibleCount given: the conservative default, as if nothing had
    // been measured yet.
    expect(orderedCategories(cats, 'memory', false)).toEqual(['memory', 'tool', 'theme'])
    expect(orderedCategories(cats, 'memory', true)).toEqual(cats)
    expect(orderedCategories(cats, 'all', false)).toEqual(cats)
  })

  it('orderedCategories leaves an already-visible chip exactly where it was', () => {
    // Reported as "点了某个分类，标签就跑到前面来了，好奇怪": picking a
    // category that the two-row clip already shows still reshuffled it (and
    // every chip after it) for nothing — nothing was ever going to be
    // hidden. visibleCount=3 means the clip fits 3 chips total, one of them
    // the 'all' pill, leaving a budget of 2 real categories.
    const cats = ['tool', 'theme', 'memory']
    expect(orderedCategories(cats, 'tool', false, 3)).toEqual(cats) // index 0, in budget
    expect(orderedCategories(cats, 'theme', false, 3)).toEqual(cats) // index 1, in budget
  })

  it('orderedCategories still rescues a chip the clip would hide', () => {
    // 'memory' sits at natural index 2, outside a budget of 2 — without the
    // rescue it would be invisible after collapsing, which is the whole
    // reason this function exists.
    const cats = ['tool', 'theme', 'memory']
    expect(orderedCategories(cats, 'memory', false, 3)).toEqual(['memory', 'tool', 'theme'])
  })

  it('orderedCategories treats a zero or negative budget as fully clipped', () => {
    // visibleCount of 0 or 1 leaves no room for any real category (the
    // budget is visibleCount - 1, for the 'all' pill) — every pick must
    // still be rescued to the front, never silently left off-screen.
    const cats = ['tool', 'theme', 'memory']
    expect(orderedCategories(cats, 'tool', false, 0)).toEqual(['tool', 'theme', 'memory'])
    expect(orderedCategories(cats, 'tool', false, 1)).toEqual(['tool', 'theme', 'memory'])
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

  it('host filtering removes only confirmed mismatches and keeps unknown entries visible', () => {
    const rows = [
      plugin({ name: 'matches', npm: 'matches' }),
      plugin({ name: 'mismatch', npm: 'mismatch' }),
      plugin({ name: 'undeclared', npm: 'undeclared' }),
      plugin({ name: 'not-loaded-yet', npm: 'not-loaded-yet' }),
      plugin({ name: 'github-only', npm: null }),
    ]
    const base = { basis: 'manifest' as const, requirement: '^0.1.2-alpha.2', declarations: [] }
    const hostCompatibility = {
      matches: { ...base, status: 'compatible' as const },
      mismatch: { ...base, status: 'incompatible' as const },
      undeclared: { status: 'unknown' as const, basis: 'undeclared' as const, requirement: null, declarations: [] },
    }

    expect(visiblePlugins(rows, {
      category: 'all', query: '', lang: 'en', sort: 'x', hostCompatibility, compatibleWithHost: false,
    }).map(plugin => plugin.name)).toEqual(rows.map(plugin => plugin.name))
    expect(visiblePlugins(rows, {
      category: 'all', query: '', lang: 'en', sort: 'x', hostCompatibility, compatibleWithHost: true,
    }).map(plugin => plugin.name)).toEqual(['matches', 'undeclared', 'not-loaded-yet', 'github-only'])
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

describe('group switch derivation (#60)', () => {
  it('derives on/off/mixed/empty from members vs the disable list', () => {
    expect(groupSwitchState([], new Set())).toBe('empty')
    expect(groupSwitchState(undefined, new Set(['a']))).toBe('empty')
    expect(groupSwitchState(['a', 'b'], new Set())).toBe('on')
    expect(groupSwitchState(['a', 'b'], new Set(['a', 'b']))).toBe('off')
    expect(groupSwitchState(['a', 'b'], new Set(['a']))).toBe('mixed')
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

  it('extractReadmeImages ranks screenshot evidence ahead of title logos and keeps scanning past six images', () => {
    const md = [
      '# my-plugin',
      '[![npm](https://img.shields.io/npm/v/x)](https://npmjs.com/x)', // badge → host filtered
      ...Array.from({ length: 7 }, (_, i) => `![project logo](assets/logo-${i}.png)`),
      '## Screenshots / 截图',
      '<img src="./assets/settings-fragment.png" alt="settings screenshot" width="420" height="900">',
      '![Full theme preview](/docs/full-preview.png "Showcase")',
      '![Conversation screen](https://user-images.githubusercontent.com/1/conversation.png)',
    ].join('\n')
    expect(extractReadmeImages(md, 'o', 'r', null)).toEqual([
      'https://raw.githubusercontent.com/o/r/HEAD/docs/full-preview.png',
      'https://user-images.githubusercontent.com/1/conversation.png',
    ])
    expect(extractReadmeImageCandidates(md, 'o', 'r', null).every(candidate => !candidate.src.includes('logo'))).toBe(true)
    // Monorepo subpath README: relative paths resolve against the subdir.
    expect(extractReadmeImages('![s](shot.png)', 'o', 'r', 'packages/plug-a')).toEqual([
      'https://raw.githubusercontent.com/o/r/HEAD/packages/plug-a/shot.png',
    ])
    expect(extractReadmeImages('no images here', 'o', 'r', null)).toEqual([])
  })

  it('dimension ranking rejects logos, portrait fragments, tiny images, and panoramic strips', () => {
    const candidates: ScreenshotCandidate[] = [
      { src: 'portrait', semanticScore: 150, order: 0, curated: false },
      { src: 'logo', semanticScore: 140, order: 1, curated: false },
      { src: 'strip', semanticScore: 130, order: 2, curated: false },
      { src: 'full', semanticScore: 90, order: 3, curated: false },
      { src: 'full-43', semanticScore: 70, order: 4, curated: false },
      { src: 'tiny', semanticScore: 200, order: 5, curated: false },
    ]
    const ranked = rankThemeScreenshots(candidates, [
      { src: 'portrait', width: 180, height: 240 },
      { src: 'logo', width: 240, height: 240 },
      { src: 'strip', width: 640, height: 150 },
      { src: 'full', width: 427, height: 240 },
      { src: 'full-43', width: 320, height: 240 },
      { src: 'tiny', width: 260, height: 146 },
    ])
    expect(ranked).toEqual(['full', 'full-43'])
    expect(previewDimensionScore(427, 240)).not.toBeNull()
    expect(previewDimensionScore(240, 240)).toBeNull()
  })
})

/**
 * A failed install's user-visible text. pnpm's ndjson reporter emits one
 * JSON object per progress tick, so a large `github:` download produces
 * thousands; when the failure matches no known signature there is no
 * diagnosis to show and the UI falls back to the tail of the output —
 * handing the user 600 characters of `{"name":"pnpm:fetching-progress"}`
 * at the one moment they need a sentence (#148, same shape behind #161).
 */
describe('humanOutput', () => {
  it('drops pnpm progress chatter', () => {
    const raw = [
      'Progress: resolved 1, reused 0',
      '{"time":1786951840209,"name":"pnpm:fetching-progress","downloaded":45573678,"status":"in_progress"}',
      '{"time":1786951840710,"name":"pnpm:fetching-progress","downloaded":45596968,"status":"in_progress"}',
      'ERR_PNPM_SOMETHING  the thing that actually went wrong',
    ].join('\n')
    expect(humanOutput(raw)).toBe('Progress: resolved 1, reused 0\nERR_PNPM_SOMETHING  the thing that actually went wrong')
  })

  it('keeps JSON that carries a diagnosis', () => {
    // An unrecognized failure is exactly when discarding information costs
    // the most, so only pure progress objects are dropped.
    const raw = [
      '{"name":"pnpm:fetching-progress","downloaded":1}',
      '{"name":"pnpm:error","err":{"code":"ERR_PNPM_FETCH_404"}}',
      '{"level":"error","message":"tarball not found"}',
    ].join('\n')
    const out = humanOutput(raw)
    expect(out).toContain('ERR_PNPM_FETCH_404')
    expect(out).toContain('tarball not found')
    expect(out).not.toContain('fetching-progress')
  })

  it('leaves ordinary output and malformed lines alone', () => {
    expect(humanOutput('plain error\n{not json\n')).toBe('plain error\n{not json')
    expect(humanOutput('')).toBe('')
  })
})

describe('formatCount', () => {
  it('shows the exact number under 1000, where precision is the point', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
  })

  it('abbreviates 1000 and above to one decimal, dropping a trailing .0', () => {
    expect(formatCount(1000)).toBe('1k')
    expect(formatCount(1086)).toBe('1.1k')
    expect(formatCount(11862)).toBe('11.9k')
    expect(formatCount(20006)).toBe('20k')
    expect(formatCount(999_999)).toBe('1000k')
  })
})

describe('isMarketItself / visiblePlugins excludes the market from Discover', () => {
  it('matches the market by catalog name or npm package, not by owner or category', () => {
    expect(isMarketItself(plugin({ name: 'dsh-market', npm: undefined }))).toBe(true)
    expect(isMarketItself(plugin({ name: 'anything', npm: 'dshmarket' }))).toBe(true)
    expect(isMarketItself(plugin({ name: 'dsh-market-clone', npm: 'not-dshmarket' }))).toBe(false)
  })

  it('never appears in the discover list, even with no filter applied at all', () => {
    const withSelf = [
      plugin({ name: 'dsh-market', npm: 'dshmarket', category: 'market' }),
      plugin({ name: 'dsh-loop', category: 'tool' }),
    ]
    // A store has no reason to sell itself to someone already standing in
    // it — this holds regardless of category/search, so no query is needed
    // to prove it; the plain, unfiltered listing already excludes it.
    expect(visiblePlugins(withSelf, { category: 'all', query: '', lang: 'en', sort: 'x' }).map(p => p.name))
      .toEqual(['dsh-loop'])
  })
})

describe('installed-state matching stays cheap as the catalog grows (#262)', () => {
  // "插件页面非常卡". A profile from the reporter put looseMatchCount at 2.9
  // seconds — 28% of the whole trace. It answers "how many catalog entries
  // could this installed dependency be?", which depends only on the catalog
  // and the name, yet it ran once per installed dependency PER RENDERED
  // CARD, each time scanning every entry. cards × installed × catalog, on
  // every render.
  const catalog = (n: number): RegistryPlugin[] =>
    Array.from({ length: n }, (_, i) => plugin({
      name: `pkg-${i}`, npm: `pkg-${i}`, url: `https://github.com/o${i}/pkg-${i}`,
    }))

  it('makes a RE-render cheap, which is what scrolling actually costs', () => {
    // The property to pin is not "fast" (a wall-clock budget would flake on
    // a slow box) but "the catalog is scanned once, not once per render".
    // Scrolling re-renders the list repeatedly; before the memo every one of
    // those repeated the full cards × installed × catalog scan, so a second
    // render cost exactly as much as the first.
    //
    // Sized and sampled for a noisy CI machine: a big catalog so the first
    // render's work dwarfs fixed overhead, and the FASTEST of several warm
    // renders, so one unlucky GC pause cannot decide the verdict. A first
    // attempt at 2000 entries and a single sample measured 50x locally and
    // 4.7x on CI — the signal was real, the sampling was not.
    const plugins = catalog(8000)
    const installed: Record<string, string> = {}
    for (let i = 0; i < 24; i++) installed[`pkg-${i}`] = '^1.0.0'
    const render = (): number => {
      const t0 = performance.now()
      for (const p of plugins.slice(0, 48)) isInstalled(p, installed, {}, plugins, {})
      return performance.now() - t0
    }
    const first = render()
    let warm = Infinity
    for (let i = 0; i < 5; i++) warm = Math.min(warm, render())
    // Real ratio is in the hundreds; anything under 10x means the
    // per-render catalog scan is back.
    expect(first / Math.max(warm, 0.001)).toBeGreaterThan(10)
  })

  it('still answers identically for an ambiguous name, memo or not', () => {
    // The memo must not change WHAT is matched — two entries share the
    // `shared` identity, so the ambiguity guard must still refuse to guess.
    const plugins = [
      plugin({ name: 'shared', npm: 'shared', url: 'https://github.com/a/shared' }),
      plugin({ name: 'shared-too', npm: 'shared', url: 'https://github.com/b/shared-too' }),
    ]
    const installed = { shared: '^1.0.0' }
    // Repeated calls exercise the cached path; the verdict must not drift.
    for (let i = 0; i < 3; i++) {
      expect(isInstalled(plugins[0]!, installed, {}, plugins, {})).toBe(false)
      expect(isInstalled(plugins[1]!, installed, {}, plugins, {})).toBe(false)
    }
    // ...and a repo hint still resolves it, from the cached path too.
    expect(isInstalled(plugins[0]!, installed, {}, plugins, { shared: ['a/shared'] })).toBe(true)
  })

  it('does not leak a count between two different catalogs', () => {
    // Keyed on the array identity: a refetched catalog is a new array, so a
    // stale count from the previous one must never be reused.
    const before = [plugin({ name: 'solo', npm: 'solo', url: 'https://github.com/a/solo' })]
    const installed = { solo: '^1.0.0' }
    expect(isInstalled(before[0]!, installed, {}, before, {})).toBe(true)
    const after = [
      plugin({ name: 'solo', npm: 'solo', url: 'https://github.com/a/solo' }),
      plugin({ name: 'solo-two', npm: 'solo', url: 'https://github.com/b/solo-two' }),
    ]
    // Now ambiguous in the NEW catalog — the old count of 1 must not survive.
    expect(isInstalled(after[0]!, installed, {}, after, {})).toBe(false)
  })
})
