// @vitest-environment jsdom
/**
 * Layer-2 component specs (harness convention: jsdom pragma +
 * testing-library against the REAL component with the REAL locale dicts and
 * the REAL ui-primitives package). The host boundary is the four fetch
 * endpoints, stubbed with fixture payloads.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketSection, resetMarketPortalHost, resetThemePreviewCache } from '../../src/client/MarketSection.tsx'
import { resetScreenshotsCache } from '../../src/client/market-data.ts'
import { en } from '../../src/client/locales.ts'

const REGISTRY = {
  updated: '', count: 4,
  categories: { tools: { en: 'Tools', zh: '工具' }, skill: { en: 'Skills', zh: '技能包' }, theme: { en: 'Themes', zh: '主题' } },
  plugins: [
    { name: 'dsh-loop', owner: 'alice', url: 'https://github.com/alice/dsh-loop', category: ['tools', 'skill'], npm: 'dsh-loop', stars: 50, added: '2026-08-01', description: { en: 'Loop task runner', zh: '循环执行' }, install: '' },
    { name: 'dsh-notify', owner: 'bob', url: 'https://github.com/bob/dsh-notify', category: 'tools', npm: null, stars: 120, added: '2026-08-10', description: { en: 'Desktop notifications', zh: '桌面通知' }, install: '' },
    { name: 'whale-skin', owner: 'carol', url: 'https://github.com/carol/whale-skin', category: 'theme', npm: null, stars: 80, added: '2026-08-14', description: { en: 'Whale theme', zh: '鲸鱼主题' }, install: '' },
  ],
}

/** Every fetch the component made, for asserting request payloads. */
let fetchCalls: Array<{ path: string; method: string; body: unknown }> = []

function stubFetch(overrides: Record<string, unknown> = {}, mountPath = '') {
  fetchCalls = []
  const mock = vi.fn((input: unknown, init?: RequestInit) => {
    const path = String(input).split('?')[0]
    const route = mountPath !== '' && path.startsWith(`${mountPath}/`)
      ? path.slice(mountPath.length)
      : path
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    fetchCalls.push({ path, method, body })
    const payload =
      route === '/dsh-market/registry' ? { source: 'live', registry: REGISTRY }
      : route === '/dsh-market/installed' ? { profile: 'web', installed: {}, live: [], disabled: [], groups: {}, groupOrder: [] }
      : route === '/dsh-market/status' ? { active: false, pnpm: true, boot: 'boot-1', restart: true, installed: {} }
      : route === '/dsh-market/updates' ? { updates: {} }
      : route === '/dsh-market/toggle' ? { ok: true, disabled: [], live: [], activation: {} }
      : route === '/dsh-market/groups' ? { ok: true, groups: {}, groupOrder: [], disabled: [] }
      : null
    const merged = overrides[path] ?? overrides[route] ?? payload
    if (merged === null) return Promise.reject(new Error(`unstubbed fetch: ${String(input)}`))
    const result = typeof merged === 'function' ? (merged as (requestBody?: unknown) => unknown)(body) : merged
    const status = result !== null && typeof result === 'object' && '__status' in result && typeof (result as { __status?: unknown }).__status === 'number'
      ? (result as { __status: number }).__status
      : 200
    return Promise.resolve(new Response(JSON.stringify(result), { status }))
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

// Snapshot objects must be referentially stable — useSyncExternalStore
// treats a fresh object per call as an endless change feed.
const LOCALE_SNAPSHOT = { active: 'en' }

/** Escape a locale string so it can be used inside a RegExp literal. */
const re = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

function props() {
  return {
    t: (key: string) => (en as Record<string, string>)[key] ?? key,
    locale: { subscribe: () => () => {}, getSnapshot: () => LOCALE_SNAPSHOT },
    theme: { setTheme: () => {} },
    themeStore: { subscribe: () => () => {}, getSnapshot: () => null },
  }
}

/**
 * Card names in VISUAL (ranked) order, reassembled from the masonry columns.
 *
 * Masonry deals cards alternately into two flex columns, so DOM order is
 * column-major (0,2,4… then 1,3,5…) while what the user reads is still
 * left-to-right, top-to-bottom. Ranking is what these tests are about, so
 * they assert the visual order and this puts it back together — walking the
 * raw DOM would assert the layout's implementation instead of its result.
 */
function rankedNames(container: HTMLElement): Array<string | undefined> {
  const themeGallery = container.querySelector('[class*="themeGallery"]')
  if (themeGallery !== null) {
    return [...themeGallery.querySelectorAll('[class*="nm"]')].map(el => el.textContent?.trim())
  }
  const columns = [...container.querySelectorAll('[class*="masonryCol"]')]
    .map(col => [...col.querySelectorAll('[class*="nm"]')].map(el => el.textContent?.trim()))
  const out: Array<string | undefined> = []
  for (let row = 0; row < Math.max(0, ...columns.map(col => col.length)); row++) {
    for (const col of columns) if (row < col.length) out.push(col[row])
  }
  return out
}

beforeEach(() => { stubFetch(); resetScreenshotsCache(); resetThemePreviewCache() })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('api() base resolution (#345)', () => {
  /** Behind a reverse proxy that mounts dsh under a prefix, a root-absolute
   * `/dsh-market/...` resolves against the ORIGIN and misses the prefix rule,
   * so the panel rendered and every request in it 404'd. Anchoring on the
   * document directory fixes that WITHOUT changing anything at the root,
   * which is where nearly everyone runs. */
  const base = () => document.querySelector('base')

  afterEach(() => { base()?.remove() })

  it('is unchanged at the root, which must not regress', async () => {
    const { api } = await import('../../src/client/market-data.ts')
    expect(api('/dsh-market/installed')).toBe('/dsh-market/installed')
  })

  it('follows the prefix the page is served under', async () => {
    const { api } = await import('../../src/client/market-data.ts')
    const tag = document.createElement('base')
    tag.setAttribute('href', 'http://host.example/app/my-dsh/')
    document.head.appendChild(tag)
    expect(api('/dsh-market/installed')).toBe('/app/my-dsh/dsh-market/installed')
    // Arbitrary depth, and a leading slash in the argument is not special.
    tag.setAttribute('href', 'http://host.example/user/a/b/')
    expect(api('dsh-market/status')).toBe('/user/a/b/dsh-market/status')
  })

  it('keeps newer changelog and note requests under that prefix too', async () => {
    const tag = document.createElement('base')
    tag.setAttribute('href', 'http://host.example/app/my-dsh/')
    document.head.appendChild(tag)
    const fetchMock = stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0' },
        live: ['dsh-loop'],
        disabled: [],
        notes: {},
      },
      '/dsh-market/updates': {
        updates: {
          'dsh-loop': {
            kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true,
          },
        },
      },
      '/dsh-market/changelog': {
        kind: 'release',
        release: {
          tag: 'v1.2.0', name: 'Subpath release', publishedAt: null, url: null, body: 'Subpath release notes',
        },
      },
      '/dsh-market/note': (body: any) => ({
        ok: true,
        notes: { [body.name]: String(body.text).trim() },
      }),
    }, '/app/my-dsh')

    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))

    fireEvent.click(await screen.findByRole('button', { name: en.noteAdd }))
    fireEvent.change(screen.getByPlaceholderText(en.notePlaceholder), { target: { value: 'for project A' } })
    fireEvent.click(screen.getByRole('button', { name: en.noteSave }))
    expect(await screen.findByText('for project A')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.notesLink) }))
    expect(await screen.findByText('Subpath release notes')).toBeTruthy()

    expect(fetchCalls).toContainEqual({
      path: '/app/my-dsh/dsh-market/note',
      method: 'POST',
      body: { name: 'dsh-loop', text: 'for project A' },
    })
    expect(fetchCalls).toContainEqual({
      path: '/app/my-dsh/dsh-market/changelog',
      method: 'GET',
      body: undefined,
    })
    expect(fetchCalls.some(call => call.path === '/dsh-market/note')).toBe(false)
    expect(fetchCalls.some(call => call.path === '/dsh-market/changelog')).toBe(false)
    expect(fetchMock.mock.calls.some(([url]) =>
      url === '/app/my-dsh/dsh-market/changelog?name=dsh-loop')).toBe(true)
  })

  it('leaves no root-absolute endpoint anywhere in the client source', () => {
    // #345 has now been fixed twice. The first fix converted every endpoint
    // that existed; changelog and personal notes were written afterwards, as
    // ordinary-looking `fetch('/dsh-market/…')` calls, and escaped to the
    // origin root again (#407). Nothing about writing that line looks wrong,
    // and nothing fails until someone is behind a path-prefixed proxy — the
    // one population that cannot see this test, or fix it.
    //
    // So the invariant is checked over the SOURCE rather than per endpoint:
    // a per-call test can only cover calls somebody thought to add.
    const offenders: string[] = []
    for (const file of readdirSync(resolve('src/client'))) {
      if (!/\.tsx?$/.test(file)) continue
      const lines = readFileSync(resolve('src/client', file), 'utf8').split('\n')
      lines.forEach((line, index) => {
        // Prose about the bug is allowed to name the shape it describes; only
        // code counts. Comment lines in this codebase are `//`, `/*` or ` *`.
        const code = line.trim()
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return
        // The literal INSIDE an api() call is the correct shape — that is the
        // whole point of the helper — so remove those before looking at what
        // is left. What is left is a path the browser would resolve itself.
        const bare = code.replace(/\bapi\(\s*(['"`])\/?[^'"`]*\1\s*\)/g, 'api(…)')
        if (/['"`]\/dsh-market\//.test(bare)) offenders.push(`${file}:${index + 1}: ${code}`)
      })
    }
    expect(
      offenders,
      `route these through api() — a root-absolute path resolves against the origin, not the mount:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})

describe('MarketSection (jsdom)', () => {
  it('renders the catalog with install buttons once the registry loads', async () => {
    render(<MarketSection {...props()} />)
    expect(await screen.findByText('dsh-loop')).toBeTruthy()
    expect(screen.getByText('dsh-notify')).toBeTruthy()
    // Theme entries carry an Install button too (discover tab shows all).
    expect(screen.getAllByRole('button', { name: en.install }).length).toBeGreaterThanOrEqual(3)
  })

  it('opens Discover with the host-provided plugin query', async () => {
    render(<MarketSection {...props()} preferredSubsectionId="discover:dsh-loop" />)

    expect(await screen.findByText('dsh-loop')).toBeTruthy()
    expect(screen.getByRole('button', { name: en.tabDiscover }).className).toMatch(/\bon\b|_on_/)
    expect(screen.getByPlaceholderText(en.searchPh)).toHaveProperty('value', 'dsh-loop')
    expect(screen.queryByText('dsh-notify')).toBeNull()
  })

  it('opens Installed with the host-provided plugin query', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0', 'dsh-notify': '^1.0.0' },
        live: ['dsh-loop', 'dsh-notify'],
        disabled: [],
        groups: {},
        groupOrder: [],
      },
    })

    render(<MarketSection {...props()} preferredSubsectionId="installed:dsh-loop" />)

    const installedTab = await screen.findByRole('button', { name: /Installed/ })
    expect(installedTab.className).toMatch(/\bon\b|_on_/)
    expect(screen.getByPlaceholderText(en.searchPh)).toHaveProperty('value', 'dsh-loop')
    expect(await screen.findByText('dsh-loop')).toBeTruthy()
    expect(screen.queryByText('dsh-notify')).toBeNull()
  })

  it('handles a later host navigation request without remounting', async () => {
    const { rerender } = render(
      <MarketSection {...props()} preferredSubsectionId="discover:dsh-loop" />,
    )
    expect(await screen.findByText('dsh-loop')).toBeTruthy()

    rerender(<MarketSection {...props()} preferredSubsectionId="discover:whale-skin" />)

    await waitFor(() => {
      expect(screen.getByPlaceholderText(en.searchPh)).toHaveProperty('value', 'whale-skin')
    })
    expect(await screen.findByText('whale-skin')).toBeTruthy()
    expect(screen.queryByText('dsh-loop')).toBeNull()
  })

  it('handles the same destination again after the host clears the request', async () => {
    const { rerender } = render(
      <MarketSection {...props()} preferredSubsectionId="discover:dsh-loop" />,
    )
    const search = await screen.findByPlaceholderText(en.searchPh)
    expect(search).toHaveProperty('value', 'dsh-loop')

    rerender(<MarketSection {...props()} />)
    fireEvent.change(search, { target: { value: 'whale-skin' } })
    expect(search).toHaveProperty('value', 'whale-skin')

    rerender(<MarketSection {...props()} preferredSubsectionId="discover:dsh-loop" />)
    await waitFor(() => {
      expect(search).toHaveProperty('value', 'dsh-loop')
    })
  })

  it('ignores empty and unknown host destinations without resetting the current view', async () => {
    const { rerender } = render(<MarketSection {...props()} />)
    const search = await screen.findByPlaceholderText(en.searchPh)
    fireEvent.change(search, { target: { value: 'whale-skin' } })
    expect(search).toHaveProperty('value', 'whale-skin')

    rerender(<MarketSection {...props()} preferredSubsectionId="" />)
    expect(search).toHaveProperty('value', 'whale-skin')

    rerender(<MarketSection {...props()} preferredSubsectionId="future:plugin" />)
    expect(search).toHaveProperty('value', 'whale-skin')
  })

  /** #256 / #365: the title has always opened the repo, but `color:inherit`
   * with no underline meant nothing said so until the cursor was already on
   * it. The link now carries a GitHub mark and names its destination, so it
   * is findable without hovering every card to look for one. */
  it('gives every card title a visible, named link to its repository', async () => {
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    for (const plugin of REGISTRY.plugins) {
      const own = screen.getAllByLabelText(`${plugin.name} — ${en.repoLink}`)
      expect(own.length).toBeGreaterThan(0)
      for (const link of own) {
        expect(link.getAttribute('target')).toBe('_blank')
        expect(link.getAttribute('rel')).toBe('noreferrer')
        // The GitHub mark rides the title's own line — a second link on a
        // row of its own would cost every card head the height the grid was
        // tuned for.
        const mark = link.querySelector('svg[aria-hidden="true"]')
        expect(mark).toBeTruthy()
        expect(mark?.getAttribute('viewBox')).toBe('0 0 16 16')
        expect(link.textContent).toContain(plugin.name)
        // The tooltip still carries the RAW catalog identity. For a compound
        // entry (owner#packages/x) the card shows only the short name, so
        // this attribute is the one place the full identity is readable —
        // 1.23.0 replaced it with the link wording and lost it.
        expect(link.getAttribute('title')).toBe(plugin.name)
        expect(link.getAttribute('href')).toBe(plugin.url)
      }
    }
  })

  it('groups Backup & Restore and Diagnostics under an Advanced tab, not as top-level peers', async () => {
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')

    // Not top-level anymore.
    expect(screen.queryByRole('button', { name: en.tabBackup })).toBeNull()
    expect(screen.queryByRole('button', { name: en.tabDiagnostics })).toBeNull()

    // Clicking Advanced defaults to the first sub-tab (Backup & Restore).
    fireEvent.click(screen.getByRole('button', { name: en.tabAdvanced }))
    expect(screen.getByRole('button', { name: en.tabAdvanced }).className).toMatch(/\bon\b|_on_/)
    const backupSubTab = screen.getByRole('button', { name: en.tabBackup })
    expect(backupSubTab.className).toMatch(/\bon\b|_on_/)
    screen.getByText(en.backupLocal)

    // Switching the sub-tab keeps Advanced itself active.
    fireEvent.click(screen.getByRole('button', { name: en.tabDiagnostics }))
    expect(screen.getByRole('button', { name: en.tabAdvanced }).className).toMatch(/\bon\b|_on_/)
    expect(screen.getByRole('button', { name: en.tabDiagnostics }).className).toMatch(/\bon\b|_on_/)
    expect(screen.getByRole('button', { name: en.tabBackup }).className).not.toMatch(/\bon\b|_on_/)
  })

  it('scrolls the shared body back to the top when switching tabs', async () => {
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    const scroller = container.querySelector('[data-dsh-market-root] > [class*="body"]') as HTMLElement
    expect(scroller).toBeTruthy()

    scroller.scrollTop = 800
    fireEvent.scroll(scroller)
    expect(screen.getByRole('button', { name: en.backTop })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(scroller.scrollTop).toBe(0)
    expect(screen.queryByRole('button', { name: en.backTop })).toBeNull()

    scroller.scrollTop = 800
    fireEvent.click(screen.getByRole('button', { name: en.tabDiscover }))
    expect(scroller.scrollTop).toBe(0)

    scroller.scrollTop = 800
    fireEvent.click(screen.getByRole('button', { name: en.tabAdvanced }))
    expect(scroller.scrollTop).toBe(0)
  })

  it('scrolls the shared body back to the top when switching Discover categories', async () => {
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    const scroller = container.querySelector('[data-dsh-market-root] > [class*="body"]') as HTMLElement
    expect(scroller).toBeTruthy()

    scroller.scrollTop = 800
    fireEvent.scroll(scroller)
    expect(screen.getByRole('button', { name: en.backTop })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Tools' }))
    expect(scroller.scrollTop).toBe(0)
    expect(screen.queryByRole('button', { name: en.backTop })).toBeNull()
    await waitFor(() => expect(screen.queryByText('whale-skin')).toBeNull())
  })

  it('marks only the repository-matched card for a same-named local link (#141)', async () => {
    const plugins = [
      { name: 'dsh-vision-bridge', owner: 'ximengxiaolan', url: 'https://github.com/ximengxiaolan/dsh-vision-bridge', category: 'tools', npm: null, description: { en: 'Other bridge' }, install: '' },
      { name: 'dsh-vision-bridge', owner: 'GXX182', url: 'https://github.com/GXX182/dsh-vision-bridge', category: 'tools', npm: null, description: { en: 'Local bridge' }, install: '' },
    ]
    stubFetch({
      '/dsh-market/registry': {
        source: 'snapshot',
        registry: { updated: '', count: 2, categories: REGISTRY.categories, plugins },
      },
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-vision-bridge': 'link:D:/pro/dsh/dsh-vision-bridge' },
        repoIdentities: { 'dsh-vision-bridge': ['gxx182/dsh-vision-bridge'] },
        live: [],
      },
    })

    render(<MarketSection {...props()} />)
    const own = await screen.findByText('GXX182')
    const other = await screen.findByText('ximengxiaolan')
    const ownCard = own.closest('div[class*="card"]') as HTMLElement
    const otherCard = other.closest('div[class*="card"]') as HTMLElement
    expect(within(ownCard).getByText(en.alreadyInstalled)).toBeTruthy()
    expect(within(otherCard).getByRole('button', { name: en.install })).toBeTruthy()
    expect(within(otherCard).queryByText(en.alreadyInstalled)).toBeNull()
  })

  it('shows shared host dependency findings from the installed snapshot', async () => {
    const findings = Array.from({ length: 7 }, (_, index) => ({
      code: 'shared-host-package-dependency',
      severity: 'warning',
      subject: { kind: 'package', name: `plugin-${String(index + 1)}` },
      evidence: {
        basis: 'manifest-declaration',
        dependency: '@deepseek-ai/dsh-tools',
        declaredRange: `^0.${String(index + 1)}.0`,
        declaredIn: 'dependencies',
      },
    }))
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-excel-chat': '^0.33.0' },
        live: [],
        diagnostics: {
          schema: 'dsh-market/diagnostics/v1',
          findings: [
            ...findings,
            {
              code: 'shared-host-package-dependency',
              severity: 'error',
              subject: { kind: 'package', name: 'wrong-severity-plugin' },
              evidence: {
                basis: 'manifest-declaration',
                dependency: '@deepseek-ai/dsh-tools',
                declaredRange: '^0.0.1-rc.1',
                declaredIn: 'dependencies',
              },
            },
            {
              code: 'shared-host-package-dependency',
              severity: 'warning',
              subject: { kind: 'package', name: 'missing-basis-plugin' },
              evidence: {
                dependency: '@deepseek-ai/dsh-tools',
                declaredRange: '^0.0.1-rc.1',
                declaredIn: 'dependencies',
              },
            },
          ],
        },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    expect(screen.queryByText(en.hostDependencyWarning)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Installed/ }))
    expect(await screen.findByText(en.hostDependencyWarning)).toBeTruthy()
    expect(screen.getByText('plugin-1 → @deepseek-ai/dsh-tools@^0.1.0')).toBeTruthy()
    expect(screen.getByText('plugin-5 → @deepseek-ai/dsh-tools@^0.5.0')).toBeTruthy()
    expect(screen.queryByText(/plugin-6 →/)).toBeNull()
    expect(screen.queryByText(/plugin-7 →/)).toBeNull()
    expect(screen.getByText(en.hostDependencyMore.replace('{0}', '2'))).toBeTruthy()
    expect(screen.queryByText(/wrong-severity-plugin/)).toBeNull()
    expect(screen.queryByText(/missing-basis-plugin/)).toBeNull()
  })

  it('search narrows the grid to matching plugins', async () => {
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: 'notify' } })
    await waitFor(() => {
      expect(screen.queryByText('dsh-loop')).toBeNull()
      expect(screen.getByText('dsh-notify')).toBeTruthy()
    })
  })

  it('renders every category and finds a plugin through its second category', async () => {
    render(<MarketSection {...props()} />)
    const name = await screen.findByText('dsh-loop')
    let card: HTMLElement | null = name
    while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
      card = card.parentElement
    }
    card = card?.parentElement ?? null
    expect(within(card!).getByText('Tools')).toBeTruthy()
    expect(within(card!).getByText('Skills')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: 'Skills' } })
    await waitFor(() => {
      expect(screen.getByText('dsh-loop')).toBeTruthy()
      expect(screen.queryByText('dsh-notify')).toBeNull()
    })
    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
    await waitFor(() => {
      expect(screen.getByText('dsh-loop')).toBeTruthy()
      expect(screen.queryByText('dsh-notify')).toBeNull()
    })
  })

  it('category pills filter and the filter panel sorts by field + direction', async () => {
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: 'Themes' }))
    await waitFor(() => {
      expect(screen.queryByText('dsh-loop')).toBeNull()
      expect(screen.getByText('whale-skin')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: /^All \(\d/ }))

    // Default field is Stars → direction labels are Ascending/Descending.
    fireEvent.click(screen.getByRole('button', { name: en.filter }))
    expect(screen.getByRole('menuitem', { name: en.sortDesc })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: en.sortAsc })).toBeTruthy()

    // Field = Release date → direction labels switch to Newest/Oldest; the
    // already-selected desc means newest first. The menu stays open across
    // selections, so the re-rendered items are still queryable in place.
    fireEvent.click(screen.getByRole('menuitem', { name: en.sortAdded }))
    await waitFor(() => {
      const names = screen.getAllByText(/^(dsh-loop|dsh-notify|whale-skin)$/).map(n => n.textContent)
      expect(names[0]).toBe('whale-skin') // newest first
    })
    fireEvent.click(screen.getByRole('menuitem', { name: en.sortOldest }))
    await waitFor(() => {
      const names = screen.getAllByText(/^(dsh-loop|dsh-notify|whale-skin)$/).map(n => n.textContent)
      expect(names[0]).toBe('dsh-loop') // oldest first
    })
  })

  it('the install dialog opens with Confirm/Cancel and closes on cancel', async () => {
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getAllByRole('button', { name: en.install })[0])
    expect(await screen.findByRole('button', { name: en.confirmInstall })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    await waitFor(() => expect(screen.queryByRole('button', { name: en.confirmInstall })).toBeNull())
  })

  it('export log is a real button with visible feedback (#84)', async () => {
    stubFetch({ '/dsh-market/logs': 'log-lines' })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    const exportButton = screen.getByRole('button', { name: en.exportLog })
    fireEvent.click(exportButton)
    // Success feedback appears as a Toast (body portal, no layout impact),
    // then the button returns to idle.
    await waitFor(() => { expect(screen.getByText(en.exportedLog)).toBeTruthy() })
  })

  it('the exported file carries the browser section, not just the server one', async () => {
    // The wiring, not the helper — self-check.client.spec.ts covers the lines
    // themselves. What this proves is that they reach the file a reporter
    // actually attaches to an issue, which is the entire point of collecting
    // them: #293 and #384 both stalled on evidence that existed in the page
    // and never made it into the export.
    let saved = ''
    // Patch only the two statics. Replacing the whole `URL` global breaks
    // api(), which calls `new URL(...)` — the market stops resolving its own
    // endpoints and the test fails for a reason that has nothing to do with
    // what it is testing.
    const realCreate = URL.createObjectURL
    const realRevoke = URL.revokeObjectURL
    URL.createObjectURL = (blob: Blob) => { void blob.text().then((text) => { saved = text }); return 'blob:stub' }
    URL.revokeObjectURL = () => {}
    try {
      stubFetch({ '/dsh-market/logs': 'log-lines' })
      render(<MarketSection {...props()} />)
      await screen.findByText('dsh-loop')
      fireEvent.click(screen.getByRole('button', { name: en.exportLog }))
      await waitFor(() => { expect(screen.getByText(en.exportedLog)).toBeTruthy() })
      await waitFor(() => { expect(saved).toContain('## browser') })
      expect(saved).toContain('portal containers:')
      expect(saved).toContain('client bundle evaluations:')
      // The server half is still there — this appends, it does not replace.
      expect(saved).toContain('log-lines')
    } finally {
      URL.createObjectURL = realCreate
      URL.revokeObjectURL = realRevoke
    }
  })

  it('shows curated registry screenshots in the dialog, and README-extracted ones as fallback (#61)', async () => {
    const CURATED = 'https://raw.githubusercontent.com/alice/dsh-loop/main/assets/demo.png'
    const registry = JSON.parse(JSON.stringify(REGISTRY))
    registry.plugins[0].screenshots = [CURATED, 'https://evil.example/track.png']
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const path = String(url).split('?')[0]
      if (path === '/dsh-market/registry') return Promise.resolve(new Response(JSON.stringify({ source: 'live', registry }), { status: 200 }))
      if (path === '/dsh-market/installed') return Promise.resolve(new Response(JSON.stringify({ profile: 'web', installed: {}, live: [] }), { status: 200 }))
      if (path === '/dsh-market/status') return Promise.resolve(new Response(JSON.stringify({ active: false, pnpm: true, boot: 'boot-1', installed: {} }), { status: 200 }))
      if (path === '/dsh-market/updates') return Promise.resolve(new Response(JSON.stringify({ updates: {} }), { status: 200 }))
      // README fallback for dsh-notify (no curated screenshots).
      if (path === 'https://raw.githubusercontent.com/bob/dsh-notify/HEAD/README.md') {
        return Promise.resolve(new Response('# dsh-notify\n![shot](assets/notify.png)', { status: 200 }))
      }
      return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
    }))
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')

    // Grid order is by stars — walk up from the name to the card's own button.
    const installButtonOf = (name: string) => {
      let card: HTMLElement | null = screen.getByText(name)
      while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
        card = card.parentElement
      }
      return within(card!).getAllByRole('button', { name: en.install })[0]!
    }

    // Curated: the allowlisted screenshot renders, the third-party host never does.
    fireEvent.click(installButtonOf('dsh-loop'))
    await screen.findByRole('button', { name: en.confirmInstall })
    await waitFor(() => {
      const srcs = [...document.querySelectorAll('img')].map(img => img.getAttribute('src'))
      // The strip proxies through images.weserv.nl for a resized render —
      // the ORIGINAL curated url is embedded as its `url` query param.
      expect(srcs.some(src => src?.includes(encodeURIComponent(CURATED.replace(/^https?:\/\//, ''))))).toBe(true)
      expect(srcs).not.toContain('https://evil.example/track.png')
      expect(srcs.some(src => src?.includes('evil.example'))).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    await waitFor(() => expect(screen.queryByRole('button', { name: en.confirmInstall })).toBeNull())

    // Fallback: dsh-notify's dialog extracts from its README, path resolved to raw.
    fireEvent.click(installButtonOf('dsh-notify'))
    await screen.findByRole('button', { name: en.confirmInstall })
    await waitFor(() => {
      const srcs = [...document.querySelectorAll('img')].map(img => img.getAttribute('src'))
      const extracted = 'https://raw.githubusercontent.com/bob/dsh-notify/HEAD/assets/notify.png'
      expect(srcs.some(src => src?.includes(encodeURIComponent(extracted.replace(/^https?:\/\//, ''))))).toBe(true)
    })
  })

  it('imports a backup as a grey installed-list preview without restoring it', async () => {
    const fetchMock = stubFetch({
      '/dsh-market/installed': {
        profile: 'web', installed: { 'already-here': '^1.0.0', 'ghost-dependency': '^1.0.0' }, present: ['already-here'], live: [],
      },
    })
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    // Backup & Restore lives under the Advanced tab, defaulting to it on entry.
    fireEvent.click(screen.getByRole('button', { name: en.tabAdvanced }))
    const backup = {
      format: 'dsh-profile-backup', version: 0.2, files: [
        { path: 'package.json', json: { dependencies: { 'already-here': '^1.0.0', 'ghost-dependency': '^1.0.0', 'missing-backup': '^2.0.0' } } },
      ],
    }
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [{ text: () => Promise.resolve(JSON.stringify(backup)) }] } })

    expect(await screen.findByText('missing-backup')).toBeTruthy()
    expect(screen.getAllByText(en.notInstalled)).toHaveLength(2)
    expect(screen.getByText('ghost-dependency').closest('[class*="irowMissing"]')).toBeTruthy()
    expect(screen.getByText('already-here').closest('[class*="irowMissing"]')).toBeNull()
    expect(screen.getByRole('button', { name: en.restoreStart })).toBeTruthy()
    expect(fetchMock.mock.calls.some(([url]) => url === '/dsh-market/restore')).toBe(false)
  })

  it('shows a running update in the Tasks panel (#295)', async () => {
    // The panel answers "what is running right now", and an update is one of
    // the things that runs. `OperationKind` has carried 'update' since the
    // panel was written — only the enqueue was missing, so "update all" left
    // the panel empty while several plugins were mid-flight.
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-market/updates': { updates: { 'dsh-loop': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
      '/dsh-market/update': { ok: true, activation: {} },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('button', { name: en.update }))

    // The panel names the plugin being updated, not just "something running".
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(en.opTitle) }))
    await waitFor(() => {
      const panel = document.querySelector('[class*="opPanel"]')
      expect(panel, 'the Tasks panel did not open').toBeTruthy()
      expect(panel!.textContent).toContain('dsh-loop')
    })
  })

  it('a stale update response arms the Update-now button (#22 flow)', async () => {
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-market/updates': { updates: { 'dsh-loop': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
      '/dsh-market/update': { ok: false, stale: true, error: 'too fresh — wait or update now' },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    const updateButton = await screen.findByRole('button', { name: en.update })
    fireEvent.click(updateButton)
    // The 502-stale path surfaces the plain-words error plus the one-time bypass.
    expect(await screen.findByRole('button', { name: en.updateNow })).toBeTruthy()
  })

  it('a busy-agent update response names the running agent instead of the generic busy message', async () => {
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-market/updates': { updates: { 'dsh-loop': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
      '/dsh-market/update': {
        ok: false,
        agentsBusy: true,
        runningAgents: ['main'],
        error: 'agents are running',
        __status: 409,
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    const updateButton = await screen.findByRole('button', { name: en.update })
    fireEvent.click(updateButton)
    expect(await screen.findByText(`${en.agentBusyUpdate} (main)`)).toBeTruthy()
    expect(screen.queryByText(en.busyWait)).toBeNull()
  })

  it('shows a compatibility-risk banner after an update and rolls back on demand (#195)', async () => {
    const fetchMock = stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-market/updates': { updates: { 'dsh-loop': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
      '/dsh-market/update': {
        ok: true,
        activation: { 'dsh-loop': { state: 'restart', hot: false, bundle: true, reasons: ['restart to apply'] } },
        compatibility: {
          code: 'soft-incompatible',
          risks: [{ plugin: 'dsh-loop', peer: '@deepseek-ai/dsh-settings', range: '^0.1.0-rc.7', resolved: '0.1.0-rc.6', direction: 'belowMin' }],
          rollbackId: 'rollback-1',
        },
      },
      '/dsh-market/rollback': { ok: true, rolledBack: true },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    const updateButton = await screen.findByRole('button', { name: en.update })
    fireEvent.click(updateButton)
    expect(await screen.findByText(en.compatRiskBanner)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.rollbackNow }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/dsh-market/rollback')).toBe(true)
    })
    expect(screen.queryByText(en.compatRiskBanner)).toBeNull()
  })

  it('does not offer a rollback action when the server could not capture an exact source', async () => {
    const rollbackUnavailable = '更新前版本为 v1.0.0，但无法确认精确来源。 / The previous version was v1.0.0, but its exact source could not be verified.'
    const fetchMock = stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-market/updates': { updates: { 'dsh-loop': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
      '/dsh-market/update': {
        ok: true,
        activation: { 'dsh-loop': { state: 'restart', hot: false, bundle: true, reasons: ['restart to apply'] } },
        compatibility: {
          code: 'soft-incompatible',
          risks: [{ plugin: 'dsh-loop', peer: '@deepseek-ai/dsh-settings', range: '^0.1.0-rc.7', resolved: '0.1.0-rc.6', direction: 'belowMin' }],
          rollbackUnavailable,
        },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('button', { name: en.update }))

    expect(await screen.findByText(en.compatRiskBannerNoRollback)).toBeTruthy()
    expect(screen.getByText(rollbackUnavailable)).toBeTruthy()
    expect(screen.queryByText(en.rollbackUnavailable)).toBeNull()
    expect(screen.queryByRole('button', { name: en.rollbackNow })).toBeNull()
    expect(fetchMock.mock.calls.some(([url]) => url === '/dsh-market/rollback')).toBe(false)
  })

  it('falls back to the generic rollback explanation for an older server', async () => {
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-market/updates': { updates: { 'dsh-loop': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
      '/dsh-market/update': {
        ok: true,
        activation: { 'dsh-loop': { state: 'restart', hot: false, bundle: true, reasons: ['restart to apply'] } },
        compatibility: {
          code: 'soft-incompatible',
          risks: [{ plugin: 'dsh-loop', peer: '@deepseek-ai/dsh-settings', range: '^0.1.0-rc.7', resolved: '0.1.0-rc.6', direction: 'belowMin' }],
        },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('button', { name: en.update }))

    expect(await screen.findByText(en.rollbackUnavailable)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.rollbackNow })).toBeNull()
  })

  it('paginates the discover grid and navigates by page number', async () => {
    const plugins = Array.from({ length: 30 }, (_, i) => ({
      name: 'dsh-p' + (i + 1),
      owner: 'alice',
      url: 'https://github.com/alice/dsh-p' + (i + 1),
      category: 'tools',
      npm: null,
      stars: 30 - i,
      added: '2026-08-01',
      description: { en: 'Plugin ' + (i + 1) },
      install: '',
    }))
    stubFetch({
      '/dsh-market/registry': {
        source: 'snapshot',
        registry: { updated: '', count: 30, categories: { tools: { en: 'Tools', zh: '工具' } }, plugins },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-p1')
    // Hot sort (stars desc) keeps dsh-p1..dsh-p24 on page 1; page 2 is hidden.
    expect(screen.getByText('dsh-p24')).toBeTruthy()
    expect(screen.queryByText('dsh-p25')).toBeNull()
    // The numbered pager jumps to page 2 and back.
    fireEvent.click(screen.getByRole('button', { name: '2' }))
    await waitFor(() => {
      expect(screen.getByText('dsh-p25')).toBeTruthy()
      expect(screen.queryByText('dsh-p1')).toBeNull()
    })
    fireEvent.click(screen.getByRole('button', { name: en.prevPage }))
    await waitFor(() => expect(screen.getByText('dsh-p1')).toBeTruthy())
  })

  it('switches page size and exposes first/last shortcuts', async () => {
    const plugins = Array.from({ length: 30 }, (_, i) => ({
      name: 'dsh-q' + (i + 1),
      owner: 'bob',
      url: 'https://github.com/bob/dsh-q' + (i + 1),
      category: 'tools',
      npm: null,
      stars: 30 - i,
      added: '2026-08-01',
      description: { en: 'Plugin ' + (i + 1) },
      install: '',
    }))
    stubFetch({
      '/dsh-market/registry': {
        source: 'snapshot',
        registry: { updated: '', count: 30, categories: { tools: { en: 'Tools', zh: '工具' } }, plugins },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-q1')
    // First/last shortcuts jump straight to the edges.
    expect(screen.getByRole('button', { name: en.firstPage })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.lastPage }))
    await waitFor(() => expect(screen.getByText('dsh-q30')).toBeTruthy())
    // A larger page size collapses the 30 plugins to a single page and hides
    // the numbered pager while keeping the size switcher visible. The
    // switcher is a primitives Menu: open it, then pick 48.
    fireEvent.click(screen.getByRole('button', { name: en.perPage + ' 24' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '48' }))
    await waitFor(() => {
      expect(screen.getByText('dsh-q1')).toBeTruthy()
      expect(screen.getByText('dsh-q30')).toBeTruthy()
      expect(screen.queryByRole('button', { name: '2' })).toBeNull()
      expect(screen.getByRole('button', { name: en.perPage + ' 48' })).toBeTruthy()
    })
  })

  it('the published-within filter keeps only recent plugins', async () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
    const plugins = [
      { name: 'dsh-fresh', owner: 'a', url: 'https://github.com/a/dsh-fresh', category: 'tools', npm: null, stars: 10, added: daysAgo(2), description: { en: 'Fresh' }, install: '' },
      { name: 'dsh-stale', owner: 'b', url: 'https://github.com/b/dsh-stale', category: 'tools', npm: null, stars: 20, added: daysAgo(60), description: { en: 'Stale' }, install: '' },
    ]
    stubFetch({
      '/dsh-market/registry': {
        source: 'snapshot',
        registry: { updated: '', count: 2, categories: { tools: { en: 'Tools', zh: '工具' } }, plugins },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-fresh')
    expect(screen.getByText('dsh-stale')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.filter }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.timeWeek }))
    await waitFor(() => {
      expect(screen.getByText('dsh-fresh')).toBeTruthy()
      expect(screen.queryByText('dsh-stale')).toBeNull()
    })
  })
})

describe('stuck pending recovery (#32)', () => {
  it('a restored pending install that never landed resets to an error instead of "installing" forever', async () => {
    vi.useFakeTimers()
    try {
      // A previous page load started an install whose response was lost.
      sessionStorage.setItem('dshm-pending', JSON.stringify({ url: 'https://github.com/alice/dsh-loop' }))
      render(<MarketSection {...props()} />)
      await vi.waitFor(() => { screen.getByText('dsh-loop') })
      await vi.waitFor(() => { screen.getByRole('button', { name: `${en.opInstalling} 1/1` }) })
      fireEvent.click(screen.getByRole('button', { name: `${en.opInstalling} 1/1` }))
      const panel = document.querySelector('[class*="opPanel"]')
      expect(panel?.textContent).toContain('dsh-loop')
      // Host stays idle and the plugin never appears in installed: two polls
      // (2s apart) must conclude the install died and release the button.
      await vi.advanceTimersByTimeAsync(2100)
      await vi.advanceTimersByTimeAsync(2100)
      expect(sessionStorage.getItem('dshm-pending')).toBeNull()
      expect(screen.getByText(new RegExp(en.installFail))).toBeTruthy()
      expect(panel?.textContent).not.toContain('dsh-loop')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('lost install progress (config page reopened)', () => {
  it('keeps the recovered install task aligned with the host lifecycle', async () => {
    vi.useFakeTimers()
    try {
      // Keep the original URL-only marker shape so updates from an older
      // client recover too; the catalog supplies the task's display name.
      sessionStorage.setItem('dshm-pending', JSON.stringify({ url: 'https://github.com/alice/dsh-loop' }))
      let settled = false
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        const path = String(url).split('?')[0]
        const payload =
          path === '/dsh-market/registry' ? { source: 'live', registry: REGISTRY }
          : path === '/dsh-market/installed' ? { profile: 'web', installed: {}, live: [], disabled: [], groups: {}, groupOrder: [] }
          : path === '/dsh-market/status' ? {
              active: !settled, busy: !settled, pnpm: true, boot: 'boot-1', restart: true,
              installed: settled ? { 'dsh-loop': '^1.0.0' } : {},
            }
          : path === '/dsh-market/updates' ? { updates: {} }
          : null
        if (payload === null) return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
      }))
      render(<MarketSection {...props()} />)
      await vi.waitFor(() => { screen.getByRole('button', { name: en.installing }) })
      fireEvent.click(screen.getByRole('button', { name: `${en.opInstalling} 1/1` }))
      const panel = document.querySelector('[class*="opPanel"]')
      expect(panel, 'the Tasks panel did not open').toBeTruthy()
      expect(panel!.textContent).toContain('dsh-loop')

      settled = true
      await vi.advanceTimersByTimeAsync(2100)
      await vi.waitFor(() => {
        expect(sessionStorage.getItem('dshm-pending')).toBeNull()
        expect(panel!.textContent).not.toContain('dsh-loop')
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('lost update progress (config page reopened)', () => {
  it('keeps the recovered update task aligned with the host lifecycle', async () => {
    vi.useFakeTimers()
    try {
      // A previous page load started an update, then the config page closed
      // before the response arrived. The marker survives the unmount, so a
      // reopen restores the running row instead of losing its progress.
      sessionStorage.setItem('dshm-updating', JSON.stringify({ name: 'dsh-loop' }))
      let settled = false
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        const path = String(url).split('?')[0]
        const payload =
          path === '/dsh-market/registry' ? { source: 'live', registry: REGISTRY }
          : path === '/dsh-market/installed' ? { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [], disabled: [], groups: {}, groupOrder: [] }
          : path === '/dsh-market/status' ? {
              active: !settled, busy: !settled, pnpm: true, boot: 'boot-1', restart: true,
              installed: { 'dsh-loop': '^1.0.0' },
              phase: settled ? null : 'downloading', currentPackage: settled ? null : 'is-odd@3.0.1', done: settled ? 0 : 3,
            }
          : path === '/dsh-market/updates' ? { updates: {} }
          : null
        if (payload === null) return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
      }))
      render(<MarketSection {...props()} />)
      fireEvent.click(screen.getByRole('button', { name: new RegExp(re(en.tabInstalled)) }))
      // The restored marker re-renders the running row and its live progress.
      await vi.waitFor(() => { screen.getByRole('button', { name: en.updating }) })
      fireEvent.click(screen.getByRole('button', { name: re(en.opInstalling) }))
      const panel = document.querySelector('[class*="opPanel"]')
      expect(panel, 'the Tasks panel did not open').toBeTruthy()
      expect(panel!.textContent).toContain('dsh-loop')
      await vi.advanceTimersByTimeAsync(2100)
      await vi.waitFor(() => { screen.getByText(/Downloading · is-odd@3\.0\.1 · 3 packages processed/) })
      // The host finishes the update; two idle polls hand the row back.
      settled = true
      await vi.advanceTimersByTimeAsync(2100)
      await vi.advanceTimersByTimeAsync(2100)
      await vi.waitFor(() => {
        expect(sessionStorage.getItem('dshm-updating')).toBeNull()
        expect(screen.queryByRole('button', { name: en.updating })).toBeNull()
        expect(panel!.textContent).not.toContain('dsh-loop')
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('P1-6 structured progress', () => {
  it('shows the pnpm phase + package + count, and a disabled cancel button while cancelling', async () => {
    vi.useFakeTimers()
    try {
      // A previous page load started an install whose response was lost.
      sessionStorage.setItem('dshm-pending', JSON.stringify({ url: 'https://github.com/alice/dsh-loop' }))
      stubFetch({
        '/dsh-market/status': {
          active: true, phase: 'downloading', done: 3, currentPackage: 'is-odd@3.0.1',
          size: 1000, downloaded: 400, cancelling: true, installed: {},
          pnpm: true, boot: 'boot-1', restart: true,
        },
      })
      render(<MarketSection {...props()} />)
      await vi.waitFor(() => { screen.getByText('dsh-loop') })
      await vi.advanceTimersByTimeAsync(2100)
      await vi.waitFor(() => {
        expect(screen.getByText(/Downloading · is-odd@3\.0\.1 · 3 packages processed/)).toBeTruthy()
      })
      const cancel = screen.getByRole('button', { name: en.cancelling })
      expect((cancel as HTMLButtonElement).disabled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('P0-2 activation states in the Installed tab', () => {
  it('chips only the states the switch does not already show', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0', 'whale-skin': '^1.0.0' },
        live: ['whale-skin'],
        activation: {
          'dsh-loop': { state: 'restart', reasons: ['in the bundle layer but not hot-mounted — it activates on restart'], bundle: true, hot: false },
          'whale-skin': { state: 'live', reasons: ['live via its bundle patch'], bundle: true, hot: true },
        },
      },
      '/dsh-market/updates': { updates: {} },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await screen.findByText(en.stateRestart)
    // "Installed but not active yet" is news and keeps its chip. "Active" is
    // exactly what the switch beside it means, so a chip repeating it made the
    // row state one fact twice and left the reader pairing them up.
    expect(screen.queryByText(en.stateLive)).toBeNull()
    expect(screen.getAllByText(en.switchOnLabel).length).toBeGreaterThan(0)
    // The reason is behind a disclosure; the chip itself must not claim success.
    expect(screen.getByText(en.stateRestart).textContent).toContain(en.stateRestart)
  })
})

describe('the installed row states a version once', () => {
  it('drops a plain range beside the resolved version, keeps a source spec', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0', 'dsh-notify': 'github:bob/dsh-notify' },
        live: ['dsh-loop', 'dsh-notify'],
        activation: {
          'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true },
          'dsh-notify': { state: 'live', reasons: [], bundle: true, hot: true },
        },
      },
      '/dsh-market/updates': { updates: { 'dsh-loop': { version: '1.0.0', kind: 'npm', updateAvailable: false } } },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await screen.findByText(re('v1.0.0'))

    // "^1.0.0" under "v1.0.0" is the same fact twice.
    expect(screen.queryByText('^1.0.0')).toBeNull()
    // A github: spec is the only place the row says where it came from.
    expect(screen.getByText('github:bob/dsh-notify')).toBeTruthy()
  })
})

describe('#60 enable/disable switches in the Installed tab', () => {
  function installedStub(overrides: Record<string, unknown>): void {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0' },
        live: [],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: {
          'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true },
        },
        ...overrides,
      },
    })
  }

  it('renders an on switch for a live plugin and posts the disable toggle', async () => {
    installedStub({})
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    const sw = await screen.findByRole('switch', { name: en.disable + ' dsh-loop' })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    await waitFor(() => {
      const toggle = fetchCalls.find(c => c.path === '/dsh-market/toggle')
      expect(toggle?.body).toEqual({ name: 'dsh-loop', enabled: false })
    })
  })

  /** #299: the switch and the row tag both say the new state, but they sit in
   * a row the user may have scrolled past, so a mis-click went unnoticed for
   * half a day. The toast is fixed on screen — that is the part that catches
   * it — and it carries the consequence, not just the new state. */
  it('toasts the plugin name and what a disable actually did', async () => {
    installedStub({})
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('switch', { name: en.disable + ' dsh-loop' }))
    expect(await screen.findByText('dsh-loop ' + en.toastToggledOff)).toBeTruthy()
  })

  it('toasts a re-enable without the stopped-working wording', async () => {
    installedStub({ live: [], disabled: ['dsh-loop'] })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('switch', { name: en.enable + ' dsh-loop' }))
    expect(await screen.findByText('dsh-loop ' + en.toastToggledOn)).toBeTruthy()
    expect(screen.queryByText('dsh-loop ' + en.toastToggledOff)).toBeNull()
  })

  it('shows the disabled state with an off switch and hides the restart label', async () => {
    installedStub({
      live: [],
      disabled: ['dsh-loop'],
      activation: {
        'dsh-loop': { state: 'restart', reasons: ['in the bundle layer but not hot-mounted'], bundle: true, hot: false },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(await screen.findByText(en.disabledState)).toBeTruthy()
    const sw = screen.getByRole('switch', { name: en.enable + ' dsh-loop' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    // The disabled chip replaces the misleading "restart to apply" label.
    expect(screen.queryByText(en.stateRestart)).toBeNull()
  })

  it('omits switches for inert and broken plugins', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0', 'whale-skin': '^1.0.0' },
        live: [],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: {
          'dsh-loop': { state: 'inert', reasons: ['no dsh.bundle'], bundle: false, hot: false },
          'whale-skin': { state: 'broken', reasons: ['no dsh metadata'], bundle: false, hot: false },
        },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(await screen.findByText(en.stateInert)).toBeTruthy()
    expect(screen.getByText(en.stateBroken)).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('never lists the market itself in the Installed tab — it manages itself from its own settings card', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { dshmarket: '^1.5.0', 'dsh-loop': '^1.0.0' },
        live: ['dshmarket', 'dsh-loop'],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: {
          dshmarket: { state: 'live', reasons: [], bundle: true, hot: true },
          'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true },
        },
      },
    })
    render(<MarketSection {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    // A real plugin is installed alongside the market — its row shows,
    // proving the list isn't just empty, but the market's own row does not.
    await screen.findByText('dsh-loop')
    expect(screen.queryByText('dshmarket')).toBeNull()
    // The tab's own count badge counts the one real plugin, not the market too.
    expect(screen.getByRole('button', { name: /^Installed \(1\)/ })).toBeTruthy()
  })

  it('shows the Installed empty state when the market is the only thing "installed"', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { dshmarket: '^1.5.0' },
        live: ['dshmarket'],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: { dshmarket: { state: 'live', reasons: [], bundle: true, hot: true } },
      },
    })
    render(<MarketSection {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(await screen.findByText(en.installedEmpty)).toBeTruthy()
    expect(screen.queryByText('dshmarket')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Installed \(\d/ })).toBeNull()
  })

  it('shows the pending-restart banner when a toggle needs a boot to apply', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0' },
        live: ['dsh-loop'],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: { 'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true } },
      },
      '/dsh-market/toggle': () => ({
        ok: true,
        name: 'dsh-loop',
        enabled: false,
        disabled: ['dsh-loop'],
        live: [],
        restart: true,
        activation: { 'dsh-loop': { state: 'disabled', reasons: ['disabled'], bundle: true, hot: false } },
      }),
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    const sw = await screen.findByRole('switch', { name: en.disable + ' dsh-loop' })
    fireEvent.click(sw)
    await waitFor(() => {
      expect(screen.getAllByText(re(en.restartBanner)).length).toBeGreaterThan(0)
    })
    // The toggle joins the persisted pending-restart set under the boot.
    await waitFor(() => {
      expect(sessionStorage.getItem('dshm-restart')).toContain('"toggled":1')
    })
  })

  it('shows the refresh banner when a client-part toggle needs a reload', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0' },
        live: ['dsh-loop'],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: { 'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true } },
      },
      '/dsh-market/toggle': () => ({
        ok: true,
        name: 'dsh-loop',
        enabled: false,
        disabled: ['dsh-loop'],
        live: [],
        restart: false,
        refresh: true,
        activation: { 'dsh-loop': { state: 'disabled', reasons: ['disabled'], bundle: true, hot: false } },
      }),
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    const sw = await screen.findByRole('switch', { name: en.disable + ' dsh-loop' })
    fireEvent.click(sw)
    await waitFor(() => {
      expect(screen.getAllByText(re(en.refreshBanner)).length).toBeGreaterThan(0)
    })
    // No restart banner — the toggle itself went live.
    expect(screen.queryAllByText(re(en.restartBanner)).length).toBe(0)
  })

  it('merges a hot install and a toggle-refresh into ONE banner instead of stacking two ("三个状态横幅")', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-notify': '^1.0.0' },
        live: ['dsh-notify'],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: { 'dsh-notify': { state: 'live', reasons: [], bundle: true, hot: true } },
      },
      '/dsh-market/install': () => ({
        ok: true,
        hot: true,
        installed: { 'dsh-notify': '^1.0.0', 'dsh-loop': '^1.0.0' },
        activation: { 'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true } },
      }),
      '/dsh-market/toggle': () => ({
        ok: true,
        name: 'dsh-notify',
        enabled: false,
        disabled: ['dsh-notify'],
        live: [],
        restart: false,
        refresh: true,
        activation: { 'dsh-notify': { state: 'disabled', reasons: ['disabled'], bundle: true, hot: false } },
      }),
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')

    const installButtonOf = (name: string) => {
      let card: HTMLElement | null = screen.getByText(name)
      while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
        card = card.parentElement
      }
      return within(card!).getAllByRole('button', { name: en.install })[0]!
    }
    fireEvent.click(installButtonOf('dsh-loop'))
    await screen.findByRole('button', { name: en.confirmInstall })
    fireEvent.click(screen.getByRole('button', { name: en.confirmInstall }))
    await waitFor(() => expect(screen.getAllByText(re(en.refreshBanner)).length).toBeGreaterThan(0))

    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    const sw = await screen.findByRole('switch', { name: en.disable + ' dsh-notify' })
    fireEvent.click(sw)

    await waitFor(() => {
      // Both changes pending a reload, but ONE banner — the count reflects
      // both plugins, not two separate near-identical strips stacked up.
      const banners = screen.getAllByText(re(en.refreshBanner))
      expect(banners.length).toBe(1)
      expect(banners[0]!.textContent).toContain('2')
    })
  })
})

/** #340: the banner counts what the page has not caught up with, and both
 * of its sets were append-only — nothing anywhere removed a name. Install
 * then uninstall and the page is level again, with nothing left for a
 * refresh to show, yet it kept asking. It was reporting session history,
 * not pending work. */
describe('refresh banner falls back when the change is undone (#340)', () => {
  it('stops asking after the installed plugin is uninstalled again', async () => {
    let present: Record<string, string> = {}
    stubFetch({
      '/dsh-market/installed': () => ({
        profile: 'web', installed: present, live: Object.keys(present), disabled: [],
        activation: { 'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true } },
      }),
      '/dsh-market/install': () => {
        present = { 'dsh-loop': '^1.0.0' }
        return { ok: true, hot: true, installed: present }
      },
      '/dsh-market/uninstall': () => { present = {}; return { ok: true, hot: true } },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    // The card for THIS plugin, not whichever Install button sorts first —
    // installing one plugin and uninstalling another would prove nothing.
    let card: HTMLElement | null = screen.getByText('dsh-loop')
    while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
      card = card.parentElement
    }
    fireEvent.click(within(card!).getAllByRole('button', { name: en.install })[0]!)
    fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))
    await waitFor(() => expect(screen.getAllByText(re(en.refreshBanner)).length).toBe(1))

    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click((await screen.findAllByRole('button', { name: en.uninstall }))[0]!)
    await screen.findByText(re(en.uninstallConfirmDesc))
    // The modal's confirm carries the same label as the row's trigger, so it
    // is the LAST one on screen once the dialog is open.
    fireEvent.click(screen.getAllByRole('button', { name: en.uninstall }).at(-1)!)

    await waitFor(() => expect(screen.queryAllByText(re(en.refreshBanner))).toHaveLength(0))
  })

  it('still stops asking when the undone plugin has a client part', async () => {
    // Same shape as the test above, except the route now answers
    // `refresh: true` because the package declares dsh.client. Installing and
    // uninstalling inside one page still nets to zero: the client bundle was
    // never injected, so the banner was asking the user to reload IN ORDER TO
    // get it, and after the uninstall there is nothing to reload for.
    let present: Record<string, string> = {}
    stubFetch({
      '/dsh-market/installed': () => ({
        profile: 'web', installed: present, live: Object.keys(present), disabled: [],
        activation: { 'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true } },
      }),
      '/dsh-market/install': () => {
        present = { 'dsh-loop': '^1.0.0' }
        return { ok: true, hot: true, installed: present }
      },
      '/dsh-market/uninstall': () => { present = {}; return { ok: true, hot: true, refresh: true } },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    let card: HTMLElement | null = screen.getByText('dsh-loop')
    while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
      card = card.parentElement
    }
    fireEvent.click(within(card!).getAllByRole('button', { name: en.install })[0]!)
    fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))
    await waitFor(() => expect(screen.getAllByText(re(en.refreshBanner)).length).toBe(1))

    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click((await screen.findAllByRole('button', { name: en.uninstall }))[0]!)
    await screen.findByText(re(en.uninstallConfirmDesc))
    fireEvent.click(screen.getAllByRole('button', { name: en.uninstall }).at(-1)!)

    await waitFor(() => expect(screen.queryAllByText(re(en.refreshBanner))).toHaveLength(0))
  })

  it('asks for a reload when a plugin the page had loaded is uninstalled (#415)', async () => {
    // Installed BEFORE this page loaded, so its client bundle is injected and
    // still on screen after the package is gone. Exactly one banner, and it
    // is the refresh one: a hot uninstall needs no host restart.
    stubFetch({
      '/dsh-market/installed': () => ({
        profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: ['dsh-loop'], disabled: [],
        activation: { 'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true } },
      }),
      '/dsh-market/uninstall': () => ({ ok: true, hot: true, refresh: true }),
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click((await screen.findAllByRole('button', { name: en.uninstall }))[0]!)
    await screen.findByText(re(en.uninstallConfirmDesc))
    fireEvent.click(screen.getAllByRole('button', { name: en.uninstall }).at(-1)!)

    await waitFor(() => expect(screen.getAllByText(re(en.refreshBanner)).length).toBe(1))
    // Not two. A restart banner here would be the "为啥有三个状态横幅啊" shape.
    expect(screen.queryAllByText(re(en.restartBanner)).length).toBe(0)
  })

  it('leaves a non-hot uninstall with only its restart banner (#415)', async () => {
    // The other arm: a removal that needs a host restart already tells the
    // user to restart, and a restart reloads the page. Adding a reload banner
    // beside it asks twice for one action.
    stubFetch({
      '/dsh-market/installed': () => ({
        profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: ['dsh-loop'], disabled: [],
        activation: { 'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: false } },
      }),
      '/dsh-market/uninstall': () => ({ ok: true, hot: false }),
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click((await screen.findAllByRole('button', { name: en.uninstall }))[0]!)
    await screen.findByText(re(en.uninstallConfirmDesc))
    fireEvent.click(screen.getAllByRole('button', { name: en.uninstall }).at(-1)!)

    await waitFor(() => expect(screen.getAllByText(re(en.restartBanner)).length).toBe(1))
    expect(screen.queryAllByText(re(en.refreshBanner)).length).toBe(0)
  })

  it('stops asking when a switch is put back where the page found it', async () => {
    let disabled: string[] = []
    stubFetch({
      '/dsh-market/installed': () => ({
        profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: ['dsh-loop'], disabled,
        activation: { 'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true } },
      }),
      '/dsh-market/toggle': (body: any) => {
        disabled = body.enabled ? [] : ['dsh-loop']
        return { ok: true, disabled, live: body.enabled ? ['dsh-loop'] : [], refresh: true }
      },
    })
    render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))

    fireEvent.click(await screen.findByRole('switch', { name: en.disable + ' dsh-loop' }))
    await waitFor(() => expect(screen.getAllByText(re(en.refreshBanner)).length).toBe(1))

    // Back to the position the page was rendered with: nothing to show.
    fireEvent.click(await screen.findByRole('switch', { name: en.enable + ' dsh-loop' }))
    await waitFor(() => expect(screen.queryAllByText(re(en.refreshBanner))).toHaveLength(0))
  })
})

/** #342 / #343: a scoped package name is what tells two installed plugins
 * apart, and the ellipsis removed exactly the end that distinguishes them —
 * `@deepseek-ai/dsh-client-ui-…` next to `@dsh-external/dsh-sessi…` are both
 * just prefixes. */
describe('long installed names stay readable (#342, #343)', () => {
  const LONG = '@deepseek-ai/dsh-client-ui-settings-plugins-extended'

  it('does not truncate, and names itself on hover either way', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web', installed: { [LONG]: '^1.0.0' }, live: [LONG], disabled: [],
      },
    })
    const { container } = render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    await screen.findByText(LONG)

    const cell = container.querySelector('[class*="irowNameText"]')!
    expect(cell.textContent).toBe(LONG)
    const link = cell.querySelector('a')
    if (link !== null) expect(link.getAttribute('title')).toBe(LONG)
  })
})

/** #347: a catalog description answers "what is this", written by its author
 * for strangers and often not in the reader's language. It cannot answer "why
 * did I install this", which is what someone with forty plugins is asking. */
describe('plugin notes (#347)', () => {
  const installedStub = (notes: Record<string, string> = {}) => stubFetch({
    '/dsh-market/installed': () => ({
      profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: ['dsh-loop'], disabled: [], notes,
    }),
    '/dsh-market/note': (body: any) => ({
      ok: true,
      // Mirrors the route: trimmed, and empty clears rather than storing blank.
      notes: String(body.text).trim() === '' ? {} : { [body.name]: String(body.text).trim() },
    }),
  })

  it('shows the author description until a note replaces it', async () => {
    installedStub()
    render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    expect(await screen.findByText('Loop task runner')).toBeTruthy()

    const addNote = screen.getByRole('button', { name: en.noteAdd })
    // #399: this must read as an action, not as a third piece of the author
    // description. The original/mine toggle deliberately remains quiet text.
    expect(addNote.className).toMatch(/noteAction/)
    fireEvent.click(addNote)
    fireEvent.change(screen.getByPlaceholderText(en.notePlaceholder), { target: { value: 'for project A' } })
    fireEvent.click(screen.getByRole('button', { name: en.noteSave }))

    // The note takes the description's place rather than sitting beside it.
    expect((await screen.findByText('for project A')).className).toMatch(/noteMine/)
    expect(screen.getByRole('button', { name: en.noteEdit }).className).toMatch(/noteAction/)
    await waitFor(() => expect(screen.queryByText('Loop task runner')).toBeNull())
  })

  it('keeps the original one click away, and puts it back', async () => {
    installedStub({ 'dsh-loop': 'for project A' })
    render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    await screen.findByText('for project A')

    fireEvent.click(screen.getByRole('button', { name: en.noteSeeTheirs }))
    expect(await screen.findByText('Loop task runner')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.noteSeeMine }))
    expect(await screen.findByText('for project A')).toBeTruthy()
  })

  it('clearing a note restores the author description', async () => {
    installedStub({ 'dsh-loop': 'for project A' })
    render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    await screen.findByText('for project A')

    fireEvent.click(screen.getByRole('button', { name: en.noteEdit }))
    fireEvent.change(screen.getByPlaceholderText(en.notePlaceholder), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: en.noteSave }))

    expect(await screen.findByText('Loop task runner')).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.noteSeeTheirs })).toBeNull()
  })
})

describe('#60 catalog deprecation', () => {
  const DEPRECATED_REGISTRY = {
    updated: '', count: 3,
    categories: { tools: { en: 'Tools', zh: '工具' } },
    plugins: [
      { name: 'dsh-old', owner: 'alice', url: 'https://github.com/alice/dsh-old', category: 'tools', npm: 'dsh-old', stars: 5, added: '2026-01-01', description: { en: 'Legacy runner', zh: '旧插件' }, install: '', deprecated: true, replacement: 'dsh-new' },
      { name: 'dsh-new', owner: 'bob', url: 'https://github.com/bob/dsh-new', category: 'tools', npm: 'dsh-new', stars: 20, added: '2026-08-01', description: { en: 'Modern runner', zh: '新插件' }, install: '' },
      { name: 'dsh-plain', owner: 'carol', url: 'https://github.com/carol/dsh-plain', category: 'tools', npm: null, stars: 3, added: '2026-07-01', description: { en: 'Plain plugin', zh: '普通插件' }, install: '' },
    ],
  }
  const contains = (text: string) => (content: string) => content.includes(text)

  it('shows the deprecated badge on the discover card and warns in the install dialog', async () => {
    stubFetch({ '/dsh-market/registry': { source: 'snapshot', registry: DEPRECATED_REGISTRY } })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-old')
    expect(screen.getByText(en.deprecatedBadge)).toBeTruthy()
    expect(screen.getByText(contains(en.deprecatedWarn))).toBeTruthy()
    // Open dsh-old's own install dialog: it carries the deprecation warning
    // plus the replacement name/link.
    const oldCard = screen.getByText('dsh-old').closest('[class*="card"]') as HTMLElement
    fireEvent.click(within(oldCard).getByRole('button', { name: en.install }))
    expect(await screen.findByText('Install dsh-old?')).toBeTruthy()
    expect(screen.getAllByText(contains(en.deprecatedWarn)).length).toBeGreaterThan(0)
    // The card behind the modal and the modal itself both carry the link.
    expect(screen.getAllByText(en.replacementHint + ' dsh-new').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  })

  it('installed rows warn and offer view/install replacement entries', async () => {
    stubFetch({
      '/dsh-market/registry': { source: 'snapshot', registry: DEPRECATED_REGISTRY },
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-old': '^1.0.0' },
        live: ['dsh-old'],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: { 'dsh-old': { state: 'live', reasons: [], bundle: true, hot: true } },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-old')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(await screen.findByText(contains(en.deprecatedWarn))).toBeTruthy()
    expect(screen.getByText(en.deprecatedBadge)).toBeTruthy()
    // View replacement jumps to the Discover tab with the new plugin focused.
    fireEvent.click(screen.getByRole('button', { name: en.viewReplacement }))
    await waitFor(() => expect(screen.getByText('dsh-new')).toBeTruthy())
    expect((screen.getByPlaceholderText(en.searchPh) as HTMLInputElement).value).toBe('dsh-new')
  })

  it('install replacement opens the confirm dialog for the new plugin', async () => {
    stubFetch({
      '/dsh-market/registry': { source: 'snapshot', registry: DEPRECATED_REGISTRY },
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-old': '^1.0.0' },
        live: ['dsh-old'],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: { 'dsh-old': { state: 'live', reasons: [], bundle: true, hot: true } },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-old')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    const installReplacement = await screen.findByRole('button', { name: en.installReplacement })
    fireEvent.click(installReplacement)
    expect(await screen.findByText('Install dsh-new?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  })
})

describe('#60 groups view', () => {
  /** Stateful fake: mirrors the server-side group/toggle semantics in memory. */
  function makeFake(installed: Record<string, string>) {
    const state = { disabled: [] as string[], groups: {} as Record<string, string[]>, groupOrder: [] as string[] }
    const activation: Record<string, unknown> = {}
    for (const name of Object.keys(installed)) {
      activation[name] = { state: 'live', reasons: [], bundle: true, hot: true }
    }
    stubFetch({
      '/dsh-market/installed': () => ({
        profile: 'web',
        installed,
        live: [],
        disabled: [...state.disabled],
        groups: JSON.parse(JSON.stringify(state.groups)),
        groupOrder: [...state.groupOrder],
        activation,
      }),
      '/dsh-market/toggle': (body: any) => {
        const index = state.disabled.indexOf(body.name)
        if (body.enabled === true && index !== -1) state.disabled.splice(index, 1)
        if (body.enabled === false && index === -1) state.disabled.push(body.name)
        return { ok: true, disabled: [...state.disabled], live: [], activation: {} }
      },
      '/dsh-market/groups': (body: any) => {
        if (body.action === 'create') { state.groups[body.name] = []; state.groupOrder.push(body.name) }
        if (body.action === 'rename') {
          state.groups[body.newName] = state.groups[body.name] ?? []
          delete state.groups[body.name]
          const index = state.groupOrder.indexOf(body.name)
          if (index !== -1) state.groupOrder[index] = body.newName
        }
        if (body.action === 'delete') {
          delete state.groups[body.name]
          state.groupOrder = state.groupOrder.filter(g => g !== body.name)
        }
        if (body.action === 'set-members') {
          state.groups[body.name] = body.members.filter((m: string) => installed[m] !== undefined && m !== 'dshmarket')
        }
        if (body.action === 'toggle') {
          for (const member of state.groups[body.name] ?? []) {
            const index = state.disabled.indexOf(member)
            if (body.enabled === true && index !== -1) state.disabled.splice(index, 1)
            if (body.enabled === false && index === -1) state.disabled.push(member)
          }
        }
        return {
          ok: true,
          groups: JSON.parse(JSON.stringify(state.groups)),
          groupOrder: [...state.groupOrder],
          disabled: [...state.disabled],
        }
      },
    })
    return state
  }

  async function openGroupsView(): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('button', { name: en.tabGroups }))
  }

  it('creates, assigns, removes, renames and deletes groups through the route', async () => {
    makeFake({ 'dsh-loop': '^1.0.0', 'dsh-notify': '^1.0.0' })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    await openGroupsView()
    expect(await screen.findByText(en.noGroups)).toBeTruthy()

    // Create.
    fireEvent.click(screen.getByRole('button', { name: en.groupNew }))
    fireEvent.change(screen.getByPlaceholderText(en.groupNamePh), { target: { value: 'work' } })
    fireEvent.click(screen.getByRole('button', { name: en.groupCreate }))
    expect(await screen.findByText('work')).toBeTruthy()

    // Assign dsh-loop into the group from the ungrouped list.
    const loopRow = screen.getByText('dsh-loop').closest('[class*="irow"]') as HTMLElement
    fireEvent.click(within(loopRow).getByRole('button', { name: en.groupAssign }))
    fireEvent.change(within(loopRow).getByRole('combobox'), { target: { value: 'work' } })
    fireEvent.click(within(loopRow).getByRole('button', { name: en.groupAssign }))
    await waitFor(() => {
      const row = screen.getByText('dsh-loop').closest('[class*="groupMember"]') as HTMLElement | null
      expect(row).not.toBeNull()
    })

    // Remove it again.
    const memberRow = screen.getByText('dsh-loop').closest('[class*="groupMember"]') as HTMLElement
    fireEvent.click(within(memberRow).getByRole('button', { name: en.groupRemove }))
    await waitFor(() => expect(screen.getByText(en.groupEmpty)).toBeTruthy())

    // Rename.
    const groupRow = screen.getByText('work').closest('[class*="groupRow"]') as HTMLElement
    fireEvent.click(within(groupRow).getByRole('button', { name: en.groupRename }))
    fireEvent.change(within(groupRow).getByPlaceholderText(en.groupNamePh), { target: { value: 'daily' } })
    fireEvent.click(within(groupRow).getByRole('button', { name: en.groupRename }))
    expect(await screen.findByText('daily')).toBeTruthy()
    expect(screen.queryByText('work')).toBeNull()

    // Delete.
    const dailyRow = screen.getByText('daily').closest('[class*="groupRow"]') as HTMLElement
    fireEvent.click(within(dailyRow).getByRole('button', { name: en.groupDelete }))
    fireEvent.click(within(dailyRow).getByRole('button', { name: en.groupConfirmDelete }))
    expect(await screen.findByText(en.noGroups)).toBeTruthy()
  })

  it('group switch derives mixed from members and batch-toggles the group', async () => {
    const state = makeFake({ 'dsh-loop': '^1.0.0', 'dsh-notify': '^1.0.0' })
    state.groups['work'] = ['dsh-loop', 'dsh-notify']
    state.groupOrder.push('work')
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    await openGroupsView()
    const groupSwitch = await screen.findByRole('switch', { name: en.disable + ' work' })
    expect(groupSwitch.getAttribute('aria-checked')).toBe('true')

    // Toggle one member off in the list view → the group reads mixed.
    fireEvent.click(screen.getByRole('button', { name: en.tabList }))
    fireEvent.click(await screen.findByRole('switch', { name: en.disable + ' dsh-loop' }))
    await waitFor(() => {
      const toggle = fetchCalls.find(c => c.path === '/dsh-market/toggle')
      expect(toggle?.body).toEqual({ name: 'dsh-loop', enabled: false })
    })
    fireEvent.click(screen.getByRole('button', { name: en.tabGroups }))
    const mixed = await screen.findByRole('switch', { name: en.enable + ' work' })
    expect(mixed.getAttribute('aria-checked')).toBe('mixed')
    expect(screen.getByText(en.groupMixed)).toBeTruthy()

    // Clicking the mixed switch enables the whole group.
    fireEvent.click(mixed)
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: en.disable + ' work' }).getAttribute('aria-checked')).toBe('true')
    })
    // The batch enable lands in every member row: dsh-loop is back on.
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: en.disable + ' dsh-loop' }).getAttribute('aria-checked')).toBe('true')
    })
    // And switching it off disables every member at once.
    fireEvent.click(screen.getByRole('switch', { name: en.disable + ' work' }))
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: en.enable + ' work' }).getAttribute('aria-checked')).toBe('false')
    })
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: en.enable + ' dsh-loop' }).getAttribute('aria-checked')).toBe('false')
    })
  })

  it('group member rows carry a live switch that toggles the member', async () => {
    const state = makeFake({ 'dsh-loop': '^1.0.0', 'dsh-notify': '^1.0.0' })
    state.groups['work'] = ['dsh-loop', 'dsh-notify']
    state.groupOrder.push('work')
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    await openGroupsView()

    const memberSwitch = await screen.findByRole('switch', { name: en.disable + ' dsh-loop' })
    expect(memberSwitch.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(memberSwitch)
    await waitFor(() => {
      const toggle = fetchCalls.find(c => c.path === '/dsh-market/toggle' && c.body?.name === 'dsh-loop')
      expect(toggle?.body).toEqual({ name: 'dsh-loop', enabled: false })
    })
    // The stateful fake persists the choice; the member row flips to off.
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: en.enable + ' dsh-loop' }).getAttribute('aria-checked')).toBe('false')
    })
    expect(screen.getByText(en.disabledState)).toBeTruthy()
  })

  it('the Add plugin button lists installed plugins and adds them via set-members', async () => {
    const state = makeFake({ 'dsh-loop': '^1.0.0', 'dsh-notify': '^1.0.0' })
    state.groups['work'] = ['dsh-loop']
    state.groupOrder.push('work')
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    await openGroupsView()

    // Only dsh-notify is a candidate: dsh-loop is already a member.
    fireEvent.click(await screen.findByRole('button', { name: en.groupAdd }))
    const addButtons = screen.getAllByRole('button', { name: en.groupAdd })
    expect(addButtons.length).toBe(2) // header toggle + the candidate row
    fireEvent.click(addButtons[1])
    await waitFor(() => {
      const set = fetchCalls.find(c => c.path === '/dsh-market/groups' && c.body?.action === 'set-members')
      expect(set?.body).toEqual({ action: 'set-members', name: 'work', members: ['dsh-loop', 'dsh-notify'] })
    })
    // The added plugin now renders inside the group's member list.
    await waitFor(() => {
      const row = screen.getByText('dsh-notify').closest('[class*="groupMember"]') as HTMLElement | null
      expect(row).not.toBeNull()
    })
  })

  it('disables Add theme when the group already holds a theme', async () => {
    const state = makeFake({ 'dsh-loop': '^1.0.0', 'whale-skin': '^1.0.0' })
    state.groups['looks'] = ['whale-skin']
    state.groupOrder.push('looks')
    render(<MarketSection {...props()} />)
    await screen.findByText('whale-skin')
    await openGroupsView()
    const addTheme = await screen.findByRole('button', { name: en.groupAddTheme })
    expect((addTheme as HTMLButtonElement).disabled).toBe(true)
    // Ordinary plugin adds stay available.
    expect((screen.getByRole('button', { name: en.groupAdd }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('Add theme lists installed theme plugins and adds one via set-members', async () => {
    const state = makeFake({ 'dsh-loop': '^1.0.0', 'whale-skin': '^1.0.0' })
    state.groups['looks'] = ['dsh-loop']
    state.groupOrder.push('looks')
    render(<MarketSection {...props()} />)
    await screen.findByText('whale-skin')
    await openGroupsView()

    fireEvent.click(await screen.findByRole('button', { name: en.groupAddTheme }))
    const themeAddButtons = screen.getAllByRole('button', { name: en.groupAddTheme })
    expect(themeAddButtons.length).toBe(2) // header toggle + the theme candidate
    fireEvent.click(themeAddButtons[1])
    await waitFor(() => {
      const set = fetchCalls.find(c => c.path === '/dsh-market/groups' && c.body?.action === 'set-members')
      expect(set?.body).toEqual({ action: 'set-members', name: 'looks', members: ['dsh-loop', 'whale-skin'] })
    })
    // Once the group holds a theme, the Add theme button disables.
    await waitFor(() => {
      expect((screen.getByRole('button', { name: en.groupAddTheme }) as HTMLButtonElement).disabled).toBe(true)
    })
  })
})

describe('status-poll / install-response race (#73)', () => {
  it('clears the premature pending-restart entry once the install response confirms a hot mount', async () => {
    vi.useFakeTimers()
    try {
      // The /install response is held open (deferred) while the status poll runs.
      let resolveInstall: (value: Response) => void = () => {}
      const installGate = new Promise<Response>(res => { resolveInstall = res })
      vi.stubGlobal('fetch', (url: string) => {
        const path = String(url).split('?')[0]
        const payload =
          path === '/dsh-market/registry' ? { source: 'live', registry: REGISTRY }
          : path === '/dsh-market/installed' ? { profile: 'web', installed: {}, live: [] }
          // Poll recovery precondition: host idle AND dsh-loop already installed.
          : path === '/dsh-market/status' ? { active: false, pnpm: true, boot: 'boot-1', restart: true, installed: { 'dsh-loop': '^1.0.0' } }
          : path === '/dsh-market/updates' ? { updates: {} }
          : path === '/dsh-market/install' ? installGate
          : null
        if (payload === null) return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
        if (payload instanceof Promise) return payload
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
      })
      render(<MarketSection {...props()} />)
      await vi.waitFor(() => { screen.getByText('dsh-loop') })
      // The module-level installed cache from earlier tests can briefly make
      // dsh-loop look already-installed (no Install button); wait until the
      // mount-time refreshInstalled applies the empty fixture.
      await vi.waitFor(() => { screen.getByRole('button', { name: en.tabInstalled }) })
      // Grid order is by stars, not registry order — target dsh-loop's own card.
      let card: HTMLElement | null = screen.getByText('dsh-loop')
      while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
        card = card.parentElement
      }
      expect(card).not.toBeNull()
      fireEvent.click(within(card!).getByRole('button', { name: en.install }))
      await vi.waitFor(() => { screen.getByRole('button', { name: en.confirmInstall }) })
      fireEvent.click(screen.getByRole('button', { name: en.confirmInstall }))
      // The /install response is still pending; the 2s status poll now sees
      // idle + installed and the recovery path counts dsh-loop as a pending
      // restart even though the mount may still come back hot.
      await vi.advanceTimersByTimeAsync(2100)
      await vi.waitFor(() => {
        expect(screen.getAllByText(re(en.restartBanner)).length).toBeGreaterThan(0)
        // The premature entry must also be persisted under the current boot.
        expect(sessionStorage.getItem('dshm-restart')).toContain('dsh-loop')
      })
      // The real /install response arrives: hot mount confirmed.
      resolveInstall(new Response(JSON.stringify({
        ok: true,
        hot: true,
        installed: { 'dsh-loop': '^1.0.0' },
        activation: { 'dsh-loop': { state: 'live', reasons: ['live via hot mount'], bundle: true, hot: true } },
      }), { status: 200 }))
      // The stale pending-restart entry must be dropped — both in memory (no
      // restart banner) and in the persisted session state.
      await vi.waitFor(() => {
        expect(screen.queryAllByText(re(en.restartBanner)).length).toBe(0)
        expect(sessionStorage.getItem('dshm-restart')).toBeNull()
      })
      // Stable counterpart: the (now-merged) refresh banner still shows the live mount.
      expect(screen.getAllByText(re(en.refreshBanner)).length).toBeGreaterThan(0)
      // A same-boot remount must not resurrect the banner from stale storage.
      cleanup()
      sessionStorage.removeItem('dshm-tab')
      render(<MarketSection {...props()} />)
      await vi.waitFor(() => { screen.getByRole('button', { name: en.tabInstalled }) })
      await vi.waitFor(() => {
        expect(screen.queryAllByText(re(en.restartBanner)).length).toBe(0)
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('uninstall confirmation Modal', () => {
  const installedFixture = {
    '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
    '/dsh-market/updates': { updates: {} },
  }

  it('cancel does not call the uninstall API', async () => {
    const fetchMock = stubFetch(installedFixture)
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('button', { name: en.uninstall }))
    // Modal opens with the confirmation copy.
    expect(await screen.findByText(re(en.uninstallConfirmDesc))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    await waitFor(() => expect(screen.queryByText(re(en.uninstallConfirmDesc))).toBeNull())
    expect(fetchMock.mock.calls.some(([url]) => url === '/dsh-market/uninstall')).toBe(false)
  })

  it('confirming in the Modal calls the uninstall API', async () => {
    const fetchMock = stubFetch(installedFixture)
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('button', { name: en.uninstall }))
    const dialog = await screen.findByRole('dialog', { name: re(en.uninstall + ' dsh-loop?') })
    fireEvent.click(within(dialog).getByRole('button', { name: en.uninstall }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/dsh-market/uninstall')).toBe(true))
  })
})

describe('installed masonry layout (#273)', () => {
  it('packs installed rows into independent masonry columns (#273)', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { alpha: '^1.0.0', beta: '^1.0.0', gamma: '^1.0.0', delta: '^1.0.0' },
        live: [],
      },
      '/dsh-market/updates': { updates: {} },
    })
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await screen.findByText('delta')

    const columns = [...container.querySelectorAll('[class*="masonryCol"]')]
    expect(columns).toHaveLength(2)
    expect(columns[0]?.textContent).toContain('alpha')
    expect(columns[0]?.textContent).toContain('gamma')
    expect(columns[0]?.textContent).not.toContain('beta')
    expect(columns[1]?.textContent).toContain('beta')
    expect(columns[1]?.textContent).toContain('delta')
    expect(columns[1]?.textContent).not.toContain('alpha')
  })

  it('keeps the mobile layout full-width and in source order (#273)', async () => {
    const media = {
      matches: false,
      media: '(min-width: 681px)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    }
    vi.stubGlobal('matchMedia', vi.fn(() => media))
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { alpha: '^1.0.0', beta: '^1.0.0', gamma: '^1.0.0', delta: '^1.0.0' },
        live: [],
      },
      '/dsh-market/updates': { updates: {} },
    })

    const { container } = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await screen.findByText('delta')

    const columns = [...container.querySelectorAll('[class*="masonryCol"]')] as HTMLElement[]
    expect(columns).toHaveLength(1)
    // The width is a stylesheet rule now, not an inline style, so there is
    // nothing here for jsdom to read — the order assertion below is the part
    // that would actually break if the single-column path regressed.
    expect([...columns[0]!.querySelectorAll('[class*="irowNameText"]')].map(row => row.textContent?.trim()))
      .toEqual(['alpha', 'beta', 'gamma', 'delta'])
  })
})

describe('local-dev restore', () => {
  it('confirms before switching a catalog-matched local package to its online source', async () => {
    stubFetch({
      '/dsh-market/registry': {
        source: 'live',
        registry: {
          ...REGISTRY,
          plugins: [
            ...REGISTRY.plugins,
            {
              name: 'dsh-better-sidebar', owner: 'flaqai',
              url: 'https://github.com/flaqai/dsh-better-sidebar',
              category: 'tools', npm: 'dsh-better-sidebar', stars: 20,
              added: '2026-08-20', description: { en: 'Better sidebar', zh: '侧边栏增强' }, install: '',
            },
          ],
        },
      },
      '/dsh-market/installed': {
        profile: 'web', installed: { 'dsh-better-sidebar': 'file:/plugins/dsh-better-sidebar-0.16.1.tgz' }, live: [],
      },
      '/dsh-market/updates': {
        updates: {
          'dsh-better-sidebar': {
            kind: 'linked', version: '0.16.1', current: '0.16.1', latest: '0.17.1',
            updateAvailable: true, restoreRequired: true,
          },
        },
      },
      '/dsh-market/update': { ok: true },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(screen.queryByRole('button', { name: en.restore })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: en.restoreOnline }))
    expect(await screen.findByText(en.restoreHint)).toBeTruthy()
    expect(fetchCalls.some(call => call.path === '/dsh-market/update')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en.restoreContinue }))
    await waitFor(() => {
      expect(fetchCalls.some(call =>
        call.path === '/dsh-market/update'
        && call.body?.name === 'dsh-better-sidebar'
        && call.body?.restore === true,
      )).toBe(true)
    })
  })

  it('leaves source switches out of Update all', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: {
          'dsh-loop': '^1.0.0',
          'dsh-notify': '^1.0.0',
          'dsh-better-sidebar': 'file:/plugins/dsh-better-sidebar-0.16.1.tgz',
        },
        live: [],
      },
      '/dsh-market/updates': {
        updates: {
          'dsh-loop': { kind: 'npm', version: '1.0.0', latest: '1.1.0', updateAvailable: true },
          'dsh-notify': { kind: 'npm', version: '1.0.0', latest: '1.1.0', updateAvailable: true },
          'dsh-better-sidebar': {
            kind: 'linked', version: '0.16.1', latest: '0.17.1',
            updateAvailable: true, restoreRequired: true,
          },
        },
      },
      '/dsh-market/update': { ok: true },
    })
    render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Update all \(2\)/ }))
    await waitFor(() => {
      expect(fetchCalls.filter(call => call.path === '/dsh-market/update')).toHaveLength(2)
    })
    expect(fetchCalls.filter(call => call.path === '/dsh-market/update').map(call => call.body?.name).sort())
      .toEqual(['dsh-loop', 'dsh-notify'])
    expect(fetchCalls.some(call => call.body?.restore === true)).toBe(false)
  })

  it('asks in the red banner before swapping a linked plugin to the catalog', async () => {
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': 'link:../dsh-loop' }, live: [] },
      '/dsh-market/updates': { updates: { 'dsh-loop': { kind: 'linked', version: '1.0.0', updateAvailable: false } } },
      '/dsh-market/update': { ok: true },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(await screen.findByRole('button', { name: en.uninstall })).toBeTruthy()
    expect(await screen.findByText(en.linkedDev)).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: en.restore }))
    expect(await screen.findByText(en.restoreHint)).toBeTruthy()
    expect(fetchCalls.some(call => call.path === '/dsh-market/update')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en.restoreContinue }))
    await waitFor(() => {
      expect(fetchCalls.some(call =>
        call.path === '/dsh-market/update' && call.body?.name === 'dsh-loop' && call.body?.restore === true,
      )).toBe(true)
    })
  })

  it('does not arm continue when the linked plugin is not in the catalog', async () => {
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'mystery-plug': 'link:../mystery' }, live: [] },
      '/dsh-market/updates': { updates: { 'mystery-plug': { kind: 'linked', updateAvailable: false } } },
    })
    render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    expect(await screen.findByText('mystery-plug')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: en.restore }))
    expect(await screen.findByText(en.restoreNoCatalog)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.restoreContinue })).toBeNull()
    expect(fetchCalls.some(call => call.path === '/dsh-market/update')).toBe(false)
    expect(screen.getByRole('button', { name: en.uninstall })).toBeTruthy()
  })

  /** #314: the failure is read in the operations panel, and the way out was a
   * banner elsewhere on the page — the message said "click the button above"
   * to someone who could not see one. The record that reports the block now
   * carries the approval itself. */
  it('puts the build approval on the failed record, not only in a banner', async () => {
    stubFetch({
      '/dsh-market/install': {
        ok: false,
        ignoredBuilds: ['node-pty'],
        error: 'blocked by pnpm',
        __status: 502,
      },
      '/dsh-market/approve-builds': { ok: true, approved: ['node-pty'] },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getAllByRole('button', { name: en.install })[0])
    fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))

    // Two of them now: the banner, and the one on the record in the panel.
    // The panel one is the point — it sits beside the sentence naming it.
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: en.approveBuilds }).length).toBeGreaterThan(1)
    })
    // A blocked build offers approval INSTEAD of a bare retry, which would
    // just hit the same wall.
    expect(screen.queryByRole('button', { name: en.opRetry })).toBeNull()

    fireEvent.click(screen.getAllByRole('button', { name: en.approveBuilds }).at(-1)!)
    await waitFor(() => {
      expect(fetchCalls.some(call => call.path === '/dsh-market/approve-builds')).toBe(true)
      expect(fetchCalls.filter(call => call.path === '/dsh-market/install').length).toBeGreaterThanOrEqual(2)
    })
  })

  it('retries a blocked restore with restore:true after approving builds', async () => {
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': 'link:../dsh-loop' }, live: [] },
      '/dsh-market/updates': { updates: { 'dsh-loop': { kind: 'linked', updateAvailable: false } } },
      '/dsh-market/update': {
        ok: false,
        ignoredBuilds: ['dsh-cowork'],
        error: 'not in the allowBuilds allowlist',
        __status: 502,
      },
      '/dsh-market/approve-builds': { ok: true, approved: ['dsh-cowork'] },
    })
    render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('button', { name: en.restore }))
    fireEvent.click(await screen.findByRole('button', { name: en.restoreContinue }))
    expect(await screen.findByText(re(en.buildsSkipped))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.approveBuilds }))
    await waitFor(() => {
      const retries = fetchCalls.filter(call => call.path === '/dsh-market/update')
      expect(retries.length).toBeGreaterThanOrEqual(2)
      expect(retries.at(-1)?.body).toMatchObject({ name: 'dsh-loop', restore: true })
    })
  })
})

describe('per-tab search boxes', () => {
  it('the installed tab has its own search that narrows the list', async () => {
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0', 'whale-skin': '^1.0.0' }, live: [] },
      '/dsh-market/updates': { updates: {} },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await screen.findByText('whale-skin')
    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: 'whale' } })
    await waitFor(() => {
      expect(screen.getByText('whale-skin')).toBeTruthy()
      expect(screen.queryByText('dsh-loop')).toBeNull()
    })
    // Clearing restores both rows.
    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: '' } })
    await waitFor(() => expect(screen.getByText('dsh-loop')).toBeTruthy())
  })

  it('the themes tab has its own search that narrows the theme grid', async () => {
    // Snapshot object must be referentially stable (see LOCALE_SNAPSHOT above).
    const THEME_SNAPSHOT = { preference: 'light', themes: [] as Array<{ id: string }> }
    render(<MarketSection {...{
      ...props(),
      themeStore: { subscribe: () => () => {}, getSnapshot: () => THEME_SNAPSHOT },
    }} />)
    await screen.findByText('dsh-loop')
    // The Themes tab button and the theme category pill share the same label;
    // the tab comes first in DOM order.
    fireEvent.click(screen.getAllByRole('button', { name: en.tabThemes })[0])
    await screen.findByText('whale-skin')
    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: 'zzz-no-match' } })
    await waitFor(() => expect(screen.queryByText('whale-skin')).toBeNull())
    expect(screen.getByText(en.empty)).toBeTruthy()
  })

  it('the themes tab uses one large preview per card and opens the full gallery', async () => {
    const shotA = 'https://raw.githubusercontent.com/carol/whale-skin/main/assets/light.png'
    const shotB = 'https://raw.githubusercontent.com/carol/whale-skin/main/assets/dark.png'
    const registry = JSON.parse(JSON.stringify(REGISTRY))
    registry.plugins[2].screenshots = [shotA, shotB]
    stubFetch({ '/dsh-market/registry': { source: 'live', registry } })
    const THEME_SNAPSHOT = { preference: 'light', themes: [] as Array<{ id: string }> }
    const { container } = render(<MarketSection {...{
      ...props(),
      themeStore: { subscribe: () => () => {}, getSnapshot: () => THEME_SNAPSHOT },
    }} />)

    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getAllByRole('button', { name: en.tabThemes })[0])
    await screen.findByText('whale-skin')

    expect(container.querySelectorAll('[class*="themeGallery"]').length).toBe(1)
    expect(container.querySelectorAll('img[class*="cardShot"]').length).toBe(0)
    expect(screen.getByText(en.themePreviewCount.replace('{0}', '2'))).toBeTruthy()
    expect(screen.getByText(en.themeResultCount.replace('{0}', '1'))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: `${en.themePreview} whale-skin` }))
    await waitFor(() => expect(document.querySelector('[class*="lightboxImg"]')).toBeTruthy())
    expect((document.querySelector('[class*="lightboxImg"]') as HTMLImageElement).src).toBe(shotA)
  })

  it('fills a missing theme cover from README and chooses the complete landscape screenshot', async () => {
    const logo = 'https://raw.githubusercontent.com/carol/whale-skin/HEAD/assets/logo.png'
    const fragment = 'https://raw.githubusercontent.com/carol/whale-skin/HEAD/assets/settings-screenshot.png'
    const complete = 'https://raw.githubusercontent.com/carol/whale-skin/HEAD/docs/theme-preview.png'
    const readmeUrl = 'https://raw.githubusercontent.com/carol/whale-skin/HEAD/README.md'
    const readme = [
      '# whale-skin',
      '![project logo](assets/logo.png)',
      '## Screenshots',
      '![settings screenshot](assets/settings-screenshot.png)',
      '![Full theme preview](docs/theme-preview.png)',
    ].join('\n')
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const path = String(url).split('?')[0]
      const payload =
        path === '/dsh-market/registry' ? { source: 'live', registry: REGISTRY }
        : path === '/dsh-market/installed' ? { profile: 'web', installed: {}, live: [], disabled: [] }
        : path === '/dsh-market/status' ? { active: false, pnpm: true, boot: 'boot-1', installed: {} }
        : path === '/dsh-market/updates' ? { updates: {} }
        : null
      if (payload !== null) return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
      if (path === readmeUrl) return Promise.resolve(new Response(readme, { status: 200 }))
      return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
    }))
    class ProbeImage {
      naturalWidth = 0
      naturalHeight = 0
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      referrerPolicy = ''
      decoding = ''
      set src(value: string) {
        if (value.includes(encodeURIComponent(fragment.replace(/^https?:\/\//, '')))) {
          this.naturalWidth = 150
          this.naturalHeight = 240
        } else if (value.includes(encodeURIComponent(complete.replace(/^https?:\/\//, '')))) {
          this.naturalWidth = 427
          this.naturalHeight = 240
        } else if (value.includes(encodeURIComponent(logo.replace(/^https?:\/\//, '')))) {
          this.naturalWidth = 240
          this.naturalHeight = 240
        }
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('Image', ProbeImage)
    const THEME_SNAPSHOT = { preference: 'light', themes: [] as Array<{ id: string }> }
    const { container } = render(<MarketSection {...{
      ...props(),
      themeStore: { subscribe: () => () => {}, getSnapshot: () => THEME_SNAPSHOT },
    }} />)

    await screen.findByText('dsh-loop')
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([url]) => url === readmeUrl)).toBe(false)
    fireEvent.click(screen.getAllByRole('button', { name: en.tabThemes })[0])
    const cover = await screen.findByRole('button', { name: `${en.themePreview} whale-skin` })
    await waitFor(() => {
      const image = cover.querySelector('img')
      expect(image?.src).toContain(encodeURIComponent(complete.replace(/^https?:\/\//, '')))
      expect(image?.src).not.toContain(encodeURIComponent(fragment.replace(/^https?:\/\//, '')))
    })
    expect(container.querySelectorAll('[class*="themeCoverEmpty"]').length).toBe(0)

    fireEvent.click(cover)
    await waitFor(() => expect(document.querySelector('[class*="lightboxImg"]')).toBeTruthy())
    expect((document.querySelector('[class*="lightboxImg"]') as HTMLImageElement).src).toBe(complete)
  })

  it('lets the user enter and exit the themes full-screen gallery', async () => {
    const THEME_SNAPSHOT = { preference: 'light', themes: [] as Array<{ id: string }> }
    const { container } = render(<MarketSection {...{
      ...props(),
      themeStore: { subscribe: () => () => {}, getSnapshot: () => THEME_SNAPSHOT },
    }} />)

    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getAllByRole('button', { name: en.tabThemes })[0])
    await screen.findByText('whale-skin')

    const root = container.querySelector('[data-dsh-market-root]') as HTMLElement
    expect(root.getAttribute('data-dsh-market-fullscreen')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.themeFullscreen }))
    expect(root.getAttribute('data-dsh-market-fullscreen')).toBe('true')
    expect(screen.getByRole('button', { name: en.themeExitFullscreen })).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(root.getAttribute('data-dsh-market-fullscreen')).toBeNull())
  })

  it('the themes tab sorts through the same filter menu as Discover, on its own independent state', async () => {
    // Three themes with a deliberate stars-vs-downloads inversion, so a
    // default (downloads-desc) order and a stars-desc order cannot pass for
    // each other — a sort that silently did nothing would look identical
    // under a single-signal fixture.
    const registry = JSON.parse(JSON.stringify(REGISTRY))
    registry.plugins = [
      // Both tabs get their own downloads-vs-stars inversion, so each tab's
      // order is a distinct observable fact rather than one shared ranking.
      { name: 'tool-a', owner: 'x', url: 'https://github.com/x/tool-a', category: 'tools', npm: 'tool-a', stars: 5, downloads: 900, added: '2026-08-01', description: { en: 'A', zh: 'A' }, install: '' },
      { name: 'tool-b', owner: 'y', url: 'https://github.com/y/tool-b', category: 'tools', npm: 'tool-b', stars: 500, downloads: 10, added: '2026-08-02', description: { en: 'B', zh: 'B' }, install: '' },
      { name: 'theme-a', owner: 'x', url: 'https://github.com/x/theme-a', category: 'theme', npm: 'theme-a', stars: 5, downloads: 900, added: '2026-08-01', description: { en: 'A', zh: 'A' }, install: '' },
      { name: 'theme-b', owner: 'y', url: 'https://github.com/y/theme-b', category: 'theme', npm: 'theme-b', stars: 500, downloads: 10, added: '2026-08-02', description: { en: 'B', zh: 'B' }, install: '' },
    ]
    stubFetch({ '/dsh-market/registry': { source: 'live', registry } })
    const THEME_SNAPSHOT = { preference: 'light', themes: [] as Array<{ id: string }> }
    const { container } = render(<MarketSection {...{
      ...props(),
      themeStore: { subscribe: () => () => {}, getSnapshot: () => THEME_SNAPSHOT },
    }} />)
    const names = () => rankedNames(container)

    await screen.findByText('tool-a')
    // Discover's own default (downloads-desc; equal counts keep registry
    // order). Discover's category is 'all', so the themes appear here too —
    // this is the full expected ordering, not a tools-only subset.
    expect(names()).toEqual(['tool-a', 'theme-a', 'tool-b', 'theme-b'])

    fireEvent.click(screen.getAllByRole('button', { name: en.tabThemes })[0])
    await screen.findByText('theme-a')
    // Same default here, and the tools-category entries stay out entirely.
    expect(names()).toEqual(['theme-a', 'theme-b'])

    // The Themes tab has its own Filter button (the Discover tab is unmounted).
    fireEvent.click(screen.getByRole('button', { name: en.filter }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.sortStars }))
    // Stars invert the order — proof the menu drives THIS tab's list.
    await waitFor(() => expect(names()).toEqual(['theme-b', 'theme-a']))

    // ...and Discover is untouched by that choice: separate state, not shared.
    fireEvent.click(screen.getByRole('button', { name: en.tabDiscover }))
    await screen.findByText('tool-a')
    expect(names()).toEqual(['tool-a', 'theme-a', 'tool-b', 'theme-b'])
  })

  it('the themes tab paginates once the theme list outgrows one page', async () => {
    // 30 themes against the 24-per-page default: page 1 holds exactly 24 and
    // page 2 the remaining 6, which a single un-paged grid could not produce.
    const registry = JSON.parse(JSON.stringify(REGISTRY))
    registry.plugins = Array.from({ length: 30 }, (_, i) => ({
      name: `theme-${String(i).padStart(2, '0')}`,
      owner: 'x',
      url: `https://github.com/x/theme-${String(i).padStart(2, '0')}`,
      category: 'theme',
      npm: `theme-${String(i).padStart(2, '0')}`,
      // Descending downloads so the default sort matches the name order.
      stars: 0, downloads: 1000 - i, added: '2026-08-01',
      description: { en: 'T', zh: 'T' }, install: '',
    }))
    stubFetch({ '/dsh-market/registry': { source: 'live', registry } })
    const THEME_SNAPSHOT = { preference: 'light', themes: [] as Array<{ id: string }> }
    const { container } = render(<MarketSection {...{
      ...props(),
      themeStore: { subscribe: () => () => {}, getSnapshot: () => THEME_SNAPSHOT },
    }} />)
    // No non-theme entry to wait on here, so wait for the tab button itself
    // (the Themes tab only renders once the catalog resolved).
    await waitFor(() => expect(screen.getAllByRole('button', { name: en.tabThemes }).length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByRole('button', { name: en.tabThemes })[0])
    await screen.findByText('theme-00')

    const names = () => rankedNames(container)
    expect(names().length).toBe(24)
    expect(names()[0]).toBe('theme-00')
    expect(screen.getByText(en.pageInfo.replace('{0}', '1').replace('{1}', '2'))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: re(en.nextPage) }))
    await waitFor(() => expect(names().length).toBe(6))
    expect(names()[0]).toBe('theme-24')
  })

  it('themes tab: an active theme card offers Deactivate and posts the disable toggle', async () => {
    // jsdom navigations are not implemented and its location is
    // non-configurable — swap in a plain object so the auto-refresh path
    // can be asserted.
    const reload = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload },
      configurable: true,
    })
    // Stateful fake: mirrors the server-side toggle semantics for one theme.
    const state = { installed: { 'whale-skin': 'github:carol/whale-skin' }, live: ['whale-skin'], disabled: [] as string[] }
    stubFetch({
      '/dsh-market/installed': () => ({ profile: 'web', installed: state.installed, live: state.live, disabled: state.disabled, groups: {}, groupOrder: [] }),
      '/dsh-market/toggle': (body: any) => {
        if (body?.enabled === false) state.disabled.push(String(body.name))
        else state.disabled = state.disabled.filter(n => n !== body?.name)
        state.live = state.disabled.includes('whale-skin') ? [] : ['whale-skin']
        return { ok: true, disabled: state.disabled, live: state.live, activation: {} }
      },
    })
    const THEME_SNAPSHOT = { preference: 'light', themes: [] as Array<{ id: string }> }
    render(<MarketSection {...{
      ...props(),
      themeStore: { subscribe: () => () => {}, getSnapshot: () => THEME_SNAPSHOT },
    }} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getAllByRole('button', { name: en.tabThemes })[0])
    await screen.findByText('whale-skin')
    // Mounted (live) theme: Active badge plus a Deactivate button.
    expect(screen.getByText(en.themeActive)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.themeDeactivate }))
    await waitFor(() => {
      const toggle = fetchCalls.find(c => c.path === '/dsh-market/toggle')
      expect(toggle?.body).toEqual({ name: 'whale-skin', enabled: false })
    })
    // The response flips the card to the disabled state: no Active badge,
    // Disabled hint, and Apply (re-activate) instead of Deactivate.
    await waitFor(() => expect(screen.queryByText(en.themeActive)).toBeNull())
    expect(screen.getByText(en.disabledState)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.themeApply })).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.themeDeactivate })).toBeNull()
    // Card-level deactivate auto-reloads into the Themes tab (mirrors the
    // use-skin reload on activate) with no stale toast resurrecting.
    expect(reload).toHaveBeenCalled()
    expect(sessionStorage.getItem('dshm-tab')).toBe('themes')
    expect(sessionStorage.getItem('dshm-toast')).toBeNull()
  })

  it('themes tab: a disabled theme drops the Active badge and shows the Disabled hint', async () => {
    // Boot manifest still lists the theme (bundle-layer entries persist),
    // but the disabled set must win — the stale-badge regression case.
    stubFetch({
      '/dsh-market/installed': () => ({ profile: 'web', installed: { 'whale-skin': 'github:carol/whale-skin' }, live: [], disabled: ['whale-skin'], groups: {}, groupOrder: [] }),
    })
    const THEME_SNAPSHOT = { preference: 'light', themes: [] as Array<{ id: string }> }
    render(<MarketSection {...{
      ...props(),
      themeStore: { subscribe: () => () => {}, getSnapshot: () => THEME_SNAPSHOT },
    }} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getAllByRole('button', { name: en.tabThemes })[0])
    await screen.findByText('whale-skin')
    expect(screen.queryByText(en.themeActive)).toBeNull()
    expect(screen.queryByRole('button', { name: en.themeDeactivate })).toBeNull()
    expect(screen.getByText(en.disabledState)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.themeApply })).toBeTruthy()
  })
})

describe('lost install response (#100)', () => {
  it('a rejected install fetch keeps the pending state and the poll recovery lands the success — no false failure', async () => {
    vi.useFakeTimers()
    try {
      // Phase 1: the /install connection DIES (proxy/loopback reset) while
      // the server keeps installing. Status still shows nothing installed.
      let installedNow: Record<string, string> = {}
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        const path = String(url).split('?')[0]
        if (path === '/dsh-market/install') return Promise.reject(new TypeError('network connection was lost'))
        const payload =
          path === '/dsh-market/registry' ? { source: 'live', registry: REGISTRY }
          : path === '/dsh-market/installed' ? { profile: 'web', installed: installedNow, live: [] }
          : path === '/dsh-market/status' ? { active: false, busy: false, pnpm: true, boot: 'boot-1', restart: true, installed: installedNow }
          : path === '/dsh-market/updates' ? { updates: {} }
          : null
        if (payload === null) return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
      }))
      render(<MarketSection {...props()} />)
      await vi.waitFor(() => { screen.getByText('dsh-loop') })
      await vi.waitFor(() => { screen.getByRole('button', { name: en.tabInstalled }) })
      const installButtonOf = (name: string) => {
        let card: HTMLElement | null = screen.getByText(name)
        while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
          card = card.parentElement
        }
        return within(card!).getAllByRole('button', { name: en.install })[0]!
      }
      fireEvent.click(installButtonOf('dsh-loop'))
      await vi.waitFor(() => { screen.getByRole('button', { name: en.confirmInstall }) })
      fireEvent.click(screen.getByRole('button', { name: en.confirmInstall }))
      // The install fetch rejects; the old code showed "install failed" here.
      await vi.advanceTimersByTimeAsync(100)
      expect(screen.queryByText(new RegExp(en.installFail))).toBeNull()
      expect(sessionStorage.getItem('dshm-pending')).toContain('dsh-loop')

      // Phase 2: the server finishes minutes later; the next poll sees the
      // plugin installed and the recovery path completes the flow quietly.
      installedNow = { 'dsh-loop': '^1.0.0' }
      await vi.advanceTimersByTimeAsync(4500)
      await vi.waitFor(() => {
        expect(sessionStorage.getItem('dshm-pending')).toBeNull()
        expect(screen.queryByText(new RegExp(en.installFail))).toBeNull()
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('standing restart notice for host-reported pending plugins', () => {
  function stubWithActivation(boot: string) {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const path = String(url).split('?')[0]
      const installed = { 'dsh-loop': '^1.0.0' }
      const payload =
        path === '/dsh-market/registry' ? { source: 'live', registry: REGISTRY }
        : path === '/dsh-market/installed' ? {
            profile: 'web', installed, live: [],
            // The host says: installed, will activate on restart.
            activation: { 'dsh-loop': { state: 'restart', reasons: ['in the bundle layer'], bundle: true, hot: false } },
          }
        : path === '/dsh-market/status' ? { active: false, busy: false, pnpm: true, boot, restart: true, installed }
        : path === '/dsh-market/updates' ? { updates: {} }
        : null
      if (payload === null) return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
    }))
  }

  it('shows the notice after a reload with no session memory, and can be dismissed', async () => {
    // The gap this closes: install, reload, and the page told you a restart
    // was needed while offering nothing to press.
    stubWithActivation('boot-1')
    render(<MarketSection {...props()} />)
    await waitFor(() => { expect(screen.getAllByText(re(en.restartBanner)).length).toBeGreaterThan(0) })
    expect(screen.getByRole('button', { name: en.restartNow })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.dismissNotice }))
    await waitFor(() => { expect(screen.queryAllByText(re(en.restartBanner)).length).toBe(0) })
    expect(sessionStorage.getItem('dshm-restart-dismissed')).toBe('boot-1')
  })

  it('reappears on the next boot, because the restart never happened', async () => {
    sessionStorage.setItem('dshm-restart-dismissed', 'boot-1')
    stubWithActivation('boot-2')
    render(<MarketSection {...props()} />)
    await waitFor(() => { expect(screen.getAllByText(re(en.restartBanner)).length).toBeGreaterThan(0) })
  })

  it('stays quiet when nothing is pending', async () => {
    stubFetch()
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    expect(screen.queryAllByText(re(en.restartBanner)).length).toBe(0)
  })
})

describe('boot-scoped update reminder dismissals (#419)', () => {
  const installed = {
    dshmarket: '^1.38.0',
    'dsh-loop': '^1.0.0',
    'dsh-notify': '^1.0.0',
  }
  const updateStatuses = {
    dshmarket: { kind: 'npm', current: '1.38.0', latest: '1.39.0', updateAvailable: true },
    'dsh-loop': { kind: 'npm', current: '1.0.0', latest: '1.1.0', updateAvailable: true },
    'dsh-notify': { kind: 'npm', current: '1.0.0', latest: '1.1.0', updateAvailable: true },
  }

  function stubUpdateReminders(boot = 'boot-1') {
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed, live: Object.keys(installed) },
      '/dsh-market/status': { active: false, busy: false, pnpm: true, boot, restart: true, installed },
      '/dsh-market/updates': { updates: updateStatuses },
    })
  }

  const installedTab = () => screen.getByRole('button', { name: /^Installed \(2\)/ })
  const updateDot = () => installedTab().querySelector('[class*="dot"]')

  it('dismisses one plugin without hiding its Installed-row information or update action', async () => {
    stubUpdateReminders()
    render(<MarketSection {...props()} />)
    expect(await screen.findByRole('button', { name: /Update all \(2\)/ })).toBeTruthy()
    expect(updateDot()).toBeTruthy()

    fireEvent.click(installedTab())
    fireEvent.click(await screen.findByRole('button', { name: `${en.ignoreUpdateNotice} dsh-loop` }))

    expect(JSON.parse(sessionStorage.getItem('dshm-updates-ignored')!)).toEqual({
      boot: 'boot-1', names: ['dsh-loop'],
    })
    expect(await screen.findByText(en.updateNoticeIgnored)).toBeTruthy()
    // Ignoring means "do not prompt", not "remove the update".
    expect(screen.getAllByRole('button', { name: en.update })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: re(en.notesLink) })).toHaveLength(2)
    // dsh-notify is still unignored, so the tab continues to carry its dot.
    expect(updateDot()).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Update all \(2\)/ })).toBeNull()
  })

  it('ignores all current reminders while preserving the complete Installed update list', async () => {
    stubUpdateReminders()
    render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: en.ignoreAllUpdateNotices }))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: en.marketUpdate })).toBeNull()
      expect(screen.queryByRole('button', { name: /Update all/ })).toBeNull()
      expect(updateDot()).toBeNull()
    })
    expect(new Set(JSON.parse(sessionStorage.getItem('dshm-updates-ignored')!).names))
      .toEqual(new Set(['dshmarket', 'dsh-loop', 'dsh-notify']))

    fireEvent.click(installedTab())
    expect(await screen.findAllByText(en.updateNoticeIgnored)).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: en.update })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: re(en.notesLink) })).toHaveLength(2)
  })

  it('keeps reminders dismissed after a page remount in the same boot', async () => {
    stubUpdateReminders('boot-1')
    const first = render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: en.ignoreAllUpdateNotices }))
    await waitFor(() => expect(updateDot()).toBeNull())
    first.unmount()

    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: en.ignoreAllUpdateNotices })).toBeNull()
      expect(screen.queryByRole('button', { name: en.marketUpdate })).toBeNull()
      expect(screen.queryByRole('button', { name: /Update all/ })).toBeNull()
      expect(updateDot()).toBeNull()
    })
  })

  it('invalidates an old dismissal after the host boot changes', async () => {
    sessionStorage.setItem('dshm-updates-ignored', JSON.stringify({
      boot: 'boot-1', names: ['dshmarket', 'dsh-loop', 'dsh-notify'],
    }))
    stubUpdateReminders('boot-2')
    render(<MarketSection {...props()} />)

    expect(await screen.findByRole('button', { name: en.ignoreAllUpdateNotices })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.marketUpdate })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Update all \(2\)/ })).toBeTruthy()
    expect(updateDot()).toBeTruthy()
    expect(sessionStorage.getItem('dshm-updates-ignored')).toBeNull()
  })

  it('fails open when the stored dismissal is malformed', async () => {
    sessionStorage.setItem('dshm-updates-ignored', '{not-json')
    stubUpdateReminders()
    render(<MarketSection {...props()} />)

    expect(await screen.findByRole('button', { name: en.ignoreAllUpdateNotices })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Update all \(2\)/ })).toBeTruthy()
    expect(updateDot()).toBeTruthy()
    expect(sessionStorage.getItem('dshm-updates-ignored')).toBeNull()
  })
})

/**
 * The pnpm setup banner (#142). Before any plugin can be installed the
 * market may have to provision pnpm, and the banner is the whole interface
 * for that: it offers the one-click fix, and after a failed attempt it has
 * to stop offering it and point at the log instead — a button that keeps
 * failing is worse than no button.
 *
 * Neither state was asserted; a mutation audit could invert the condition
 * that hides the button and nothing failed.
 */
describe('pnpm setup banner', () => {
  const notReady = { active: false, pnpm: false, boot: 'boot-1', restart: true, installed: {} }

  it('offers the one-click fix while setup is still worth trying', async () => {
    stubFetch({ '/dsh-market/status': notReady })
    render(<MarketSection {...props()} />)
    await waitFor(() => expect(screen.getByText(re(en.envMissing))).toBeTruthy())
    expect(screen.getByRole('button', { name: re(en.envFix) })).toBeTruthy()
  })

  it('after a failed setup, explains and stops offering the button', async () => {
    stubFetch({ '/dsh-market/status': notReady, '/dsh-market/setup-pnpm': { ok: false, error: 'no Node found' } })
    render(<MarketSection {...props()} />)
    await waitFor(() => expect(screen.getByText(re(en.envMissing))).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: re(en.envFix) }))
    await waitFor(() => expect(screen.getByText(re(en.envFixFail))).toBeTruthy())
    // The retry button is gone, and the host's reason is surfaced verbatim.
    expect(screen.queryByRole('button', { name: re(en.envFix) })).toBeNull()
    expect(screen.getByText(re('no Node found'))).toBeTruthy()
  })

  it('clears the banner when setup succeeds', async () => {
    stubFetch({ '/dsh-market/status': notReady, '/dsh-market/setup-pnpm': { ok: true } })
    render(<MarketSection {...props()} />)
    await waitFor(() => expect(screen.getByText(re(en.envMissing))).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: re(en.envFix) }))
    await waitFor(() => expect(screen.queryByText(re(en.envMissing))).toBeNull())
    expect(screen.queryByText(re(en.envFixFail))).toBeNull()
  })
})

/**
 * A failed install has to END. #138 reported the opposite: the spinner ran
 * forever with no message, while pnpm had already refused the spec
 * instantly. This is the plain case — the host answered, and it answered
 * "no". A LOST response is deliberately NOT this case (#100: pnpm often
 * keeps working after the connection drops, so the status poll decides);
 * its recovery has its own spec above.
 *
 * Both halves matter. Releasing the button without showing why leaves the
 * user guessing; showing the error while the row still says "installing"
 * leaves them waiting for something that already finished.
 */
describe('a failed install releases the UI and says why', () => {
  const failure = {
    ok: false,
    error: '[ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER] "whatever" isn\'t supported by any available resolver.',
  }

  it('stops the spinner and surfaces the host error', async () => {
    stubFetch({ '/dsh-market/install': failure })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')

    fireEvent.click(screen.getAllByRole('button', { name: en.install })[0])
    fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))

    // The reason reaches the page verbatim — a resolver error names the spec
    // that was refused, which is the only clue the user has.
    await waitFor(() => expect(screen.getByText(re('isn\'t supported by any available resolver'))).toBeTruthy())
    // ...and nothing is left claiming to be in progress.
    expect(screen.queryByRole('button', { name: en.installing })).toBeNull()
    expect(screen.getAllByRole('button', { name: en.install }).length).toBeGreaterThan(0)
  })
})

/**
 * A loader-id clash (#122) is the one install failure the user can act on:
 * in a single profile the plugins cannot coexist, so the choice is which one
 * to keep. The decision lives in the activity panel, which no page change can
 * take away; the card keeps only a marker pointing at it.
 */
describe('a loader-id clash becomes a decision in the activity panel', () => {
  const clash = {
    ok: false,
    conflictGroups: [{ owner: 'dsh-tui-core', ids: ['storage', 'terminal'] }],
    error: 'PROSE-FALLBACK-FOR-LOGS',
  }

  /** Install the first card, then follow its marker into the panel. */
  const installFirstCard = async () => {
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getAllByRole('button', { name: en.install })[0])
    fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))
    // The card must say something: one that looks untouched invites pressing
    // Install again, which is how the same clash gets hit twice.
    fireEvent.click(await screen.findByRole('button', { name: re(en.opBlockedCard) }))
    await screen.findByText(re(en.conflictBody))
  }

  it('names the clashing plugin, and keeps entry ids out of the decision', async () => {
    stubFetch({ '/dsh-market/install': clash })
    await installFirstCard()

    expect(screen.getByText('dsh-tui-core')).toBeTruthy()
    // Entry ids are evidence, not part of the choice: a reader deciding which
    // plugin to keep does not need them, so they live behind the disclosure.
    expect(screen.queryByText(re('storage, terminal'))).toBeNull()
    fireEvent.click(screen.getByText(en.conflictDetails))
    expect(screen.getByText(re('storage, terminal'))).toBeTruthy()
    // "Nothing was changed" is what keeps this from reading as "something was
    // removed and I do not know what" — it rides on the status line now,
    // rather than as a row of its own inside the decision.
    expect(screen.getByText(re(en.opNeedsChoice))).toBeTruthy()
    // The record survives a page change, which is the whole reason it moved
    // off the card.
    fireEvent.click(screen.getByRole('button', { name: en.tabInstalled }))
    expect(screen.getByText(re(en.conflictBody))).toBeTruthy()
    // The host still sends a prose string for logs; rendering it as well
    // would report the same failure twice, in two different registers.
    expect(screen.queryByText(re('PROSE-FALLBACK-FOR-LOGS'))).toBeNull()
  })

  it('lists one row per owner when a candidate clashes with several at once', async () => {
    stubFetch({ '/dsh-market/install': { ok: false, conflictGroups: [
      { owner: 'dsh-tui-core', ids: ['storage'] },
      { owner: 'dsh-panel-kit', ids: ['panel'] },
    ] } })
    await installFirstCard()

    // Both owners, each with only the id it actually declares — the whole
    // point of grouping rather than listing every id against the first name.
    expect(screen.getByText('dsh-tui-core')).toBeTruthy()
    expect(screen.getByText('dsh-panel-kit')).toBeTruthy()
    // Grouping still holds under the disclosure: each owner keeps only the
    // ids it actually declares.
    fireEvent.click(screen.getByText(en.conflictDetails))
    expect(screen.getByText(re('dsh-tui-core: storage'))).toBeTruthy()
    expect(screen.getByText(re('dsh-panel-kit: panel'))).toBeTruthy()
  })

  it('draws the outcome on the plugins, and flips it with the choice', async () => {
    // Stating a consequence beside a list leaves the reader to apply it. Here
    // the list IS the consequence: the side that loses is struck through and
    // tagged, so the choice can be read without parsing a sentence.
    stubFetch({ '/dsh-market/install': clash })
    await installFirstCard()

    // Scoped to the decision: the plugin name also appears on the card.
    const decision = screen.getByText(re(en.conflictBody)).parentElement as HTMLElement
    const rowOf = (name: string) => within(decision).getByTitle(name).closest('div')?.parentElement
    // Default keeps what is installed: the candidate is the one dropped.
    expect(rowOf('dsh-notify')?.textContent).toContain(en.conflictOutcomeSkip)
    expect(rowOf('dsh-tui-core')?.textContent).toContain(en.conflictOutcomeKeep)

    fireEvent.click(screen.getByRole('radio', { name: re(en.conflictSwap) }))
    expect(rowOf('dsh-notify')?.textContent).toContain(en.conflictOutcomeInstall)
    expect(rowOf('dsh-tui-core')?.textContent).toContain(en.conflictOutcomeRemove)
  })

  it('closes on Escape, on an outside click, and from its own header', async () => {
    // Re-pressing the control that opened a popover is the one dismissal
    // route nobody looks for, so it cannot be the only one.
    stubFetch({ '/dsh-market/install': clash })
    await installFirstCard()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText(re(en.conflictBody))).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: re(en.opBlockedCard) }))
    await screen.findByText(re(en.conflictBody))
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByText(re(en.conflictBody))).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: re(en.opBlockedCard) }))
    await screen.findByText(re(en.conflictBody))
    fireEvent.click(screen.getByRole('button', { name: en.opClose }))
    await waitFor(() => expect(screen.queryByText(re(en.conflictBody))).toBeNull())
  })

  it('defaults to the outcome that changes nothing, and confirming it uninstalls nothing', async () => {
    // The destructive option is one click away, so the default carries the
    // whole safety of this screen: confirming without touching it must not
    // remove a working plugin.
    stubFetch({ '/dsh-market/install': clash, '/dsh-market/uninstall': { ok: true, installed: {} } })
    await installFirstCard()

    expect((screen.getByRole('radio', { name: re(en.conflictKeep) }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: re(en.conflictSwap) }) as HTMLInputElement).checked).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    await waitFor(() => expect(screen.queryByText(en.conflictTitle)).toBeNull())
    expect(fetchCalls.filter(call => call.path === '/dsh-market/uninstall')).toEqual([])
  })

  it('swaps: uninstalls what clashed, then retries the install', async () => {
    let installs = 0
    stubFetch({
      '/dsh-market/install': () => {
        installs += 1
        return installs === 1 ? clash : { ok: true, hot: true, activation: {}, installed: {} }
      },
      '/dsh-market/uninstall': { ok: true, hot: true, installed: {} },
    })
    await installFirstCard()

    // The safe outcome is preselected, so the swap only happens once the
    // user actively moves off it.
    fireEvent.click(screen.getByRole('radio', { name: re(en.conflictSwap) }))
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))

    await waitFor(() => expect(installs).toBe(2))
    expect(fetchCalls.filter(call => call.path === '/dsh-market/uninstall').map(call => call.body))
      .toEqual([{ name: 'dsh-tui-core' }])
  })

  it('names the plugins already removed when the swap dies part-way', async () => {
    // The honest half: nothing reinstalls them, so a bare "failed" would
    // leave the user guessing which of their plugins survived.
    let removes = 0
    stubFetch({
      '/dsh-market/install': { ok: false, conflictGroups: [
        { owner: 'a-plug', ids: ['x'] },
        { owner: 'b-plug', ids: ['y'] },
      ] },
      '/dsh-market/uninstall': () => {
        removes += 1
        return removes === 1 ? { ok: true, installed: {} } : { ok: false, error: 'EBUSY' }
      },
    })
    await installFirstCard()

    fireEvent.click(screen.getByRole('radio', { name: re(en.conflictSwap) }))
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))

    // Reported once, in the panel: the page banner no longer echoes an
    // operation's outcome now that a record owns it.
    await waitFor(() => expect(screen.getByText(re(en.conflictReplaceFailed))).toBeTruthy())
    expect(screen.getByText(re('a-plug'))).toBeTruthy()
  })
})

/**
 * The category row's height cap belongs to the MEASURING pass and nowhere
 * else. That pass renders every chip so their offsets can be counted, and
 * clipping hides the tall row for the frame it exists; keeping the cap while
 * the user has the row OPEN clips the rows they just asked to see. With the
 * catalog at 20 categories that showed two rows out of six and read as
 * "expanding does nothing" / "the categories were never updated".
 */
describe('category row expansion', () => {
  const CATS = {
    ui: { en: 'UI', zh: 'UI' }, usage: { en: 'Usage', zh: '用量' },
    theme: { en: 'Theme', zh: '主题' }, model: { en: 'Model', zh: '模型' },
    session: { en: 'Session', zh: '会话' }, memory: { en: 'Memory', zh: '记忆' },
    tools: { en: 'Tools', zh: '工具' }, browser: { en: 'Browser', zh: '浏览器' },
    vision: { en: 'Vision', zh: '视觉' }, voice: { en: 'Voice', zh: '语音' },
  }

  it('drops the height cap once the row is open', async () => {
    stubFetch({ '/dsh-market/registry': { source: 'snapshot', registry: { ...REGISTRY, categories: CATS } } })
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')

    const wrap = () => container.querySelector('[class*="catsWrap"]')
    // jsdom reports zero layout, so measurement never resolves and the row
    // stays in its measuring state — which is exactly the state that must
    // still clip. The assertion that matters is what OPEN does to it.
    fireEvent.click(screen.getByLabelText(re(en.catsMore)))
    await waitFor(() => expect(screen.getByLabelText(re(en.catsLess))).toBeTruthy())
    expect(wrap()?.className, 'open must not carry the measuring clip').not.toMatch(/catsCollapsed/)

    fireEvent.click(screen.getByLabelText(re(en.catsLess)))
    await waitFor(() => expect(screen.getByLabelText(re(en.catsMore))).toBeTruthy())
  })

  it('renders every category once open', async () => {
    stubFetch({ '/dsh-market/registry': { source: 'snapshot', registry: { ...REGISTRY, categories: CATS } } })
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')

    fireEvent.click(screen.getByLabelText(re(en.catsMore)))
    await waitFor(() => expect(screen.getByLabelText(re(en.catsLess))).toBeTruthy())
    // Scoped to the chips: names like "Theme" also label a tab, and a
    // document-wide lookup would pass on the wrong element.
    const chipLabels = [...container.querySelectorAll('[data-chip="1"]')].map(el => el.textContent?.trim())
    for (const label of ['UI', 'Usage', 'Theme', 'Model', 'Session', 'Memory', 'Tools', 'Browser', 'Vision', 'Voice']) {
      expect(chipLabels, `${label} missing from: ${chipLabels.join(', ')}`).toContain(label)
    }
  })

  it('does not auto-collapse when there is too little to scroll for the collapse to hold (#266)', async () => {
    // The loop this prevents: collapsing shrinks the sticky header, which
    // shrinks the scrollable content; with barely more content than
    // viewport that drops scrollHeight below the scroll position, the
    // browser clamps scrollTop, the sentinel slides back into view, the row
    // re-expands, the content grows back — and it starts over. Reported as
    // the category bar flapping and the list refusing to scroll, and
    // reproduced in a browser as scrollTop 78 → 0 snapping one row back to
    // four.
    const offsetTopDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')
    const offsetHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset.chip !== '1') return 0
        const siblings = [...(this.parentElement?.children ?? [])]
          .filter((el): el is HTMLElement => (el as HTMLElement).dataset?.chip === '1')
        return Math.floor(siblings.indexOf(this) / 4) * 32
      },
    })
    // The category wrap reports a real height; the scroller reports barely
    // any overflow. That pairing is exactly the unstable case.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.className.includes('catsWrap') ? 90 : 26 },
    })
    const scrollHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    const clientHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 560 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 520 })

    let onChange: ((entry: { isIntersecting: boolean }) => void) | null = null
    class FakeIntersectionObserver {
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) { onChange = entry => cb([entry]) }
      observe(): void {}
      disconnect(): void { onChange = null }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)

    try {
      stubFetch({ '/dsh-market/registry': { source: 'snapshot', registry: { ...REGISTRY, categories: CATS } } })
      const { container } = render(<MarketSection {...props()} />)
      await screen.findByText('dsh-loop')
      const chipCount = () => container.querySelectorAll('[data-chip="1"]').length

      fireEvent.click(screen.getByLabelText(re(en.catsMore)))
      await waitFor(() => expect(screen.getByLabelText(re(en.catsLess))).toBeTruthy())
      const openCount = chipCount()
      expect(openCount).toBe(11)

      // Scrolled past the sentinel — but only 40px of overflow against a
      // 90px category row, so collapsing could not survive its own effect.
      onChange!({ isIntersecting: false })
      await waitFor(() => expect(screen.getByLabelText(re(en.catsLess))).toBeTruthy())
      expect(chipCount(), 'a collapse that cannot hold must not happen at all').toBe(openCount)
    } finally {
      if (offsetTopDesc) Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTopDesc)
      if (offsetHeightDesc) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeightDesc)
      // DELETE when there was no own descriptor, don't just skip: jsdom
      // defines these on Element.prototype, so getOwnPropertyDescriptor on
      // HTMLElement.prototype returns undefined and a `if (desc)` restore
      // leaves the stub in place — poisoning every later test in the file.
      if (scrollHeightDesc) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeightDesc)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
      if (clientHeightDesc) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeightDesc)
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
    }
  })

  it('keeps the scroller opted out of scroll anchoring, which the auto-collapse cannot survive (#395)', () => {
    // Honest about its reach: jsdom does no layout and implements no scroll
    // anchoring, so this cannot reproduce #395 — the browser behaviour was
    // measured by hand (see the rule's own comment in Market.module.css).
    // What it CAN do is stop the declaration from being dropped by someone
    // tidying the rule, which is the realistic way this regresses: the line
    // looks like a no-op, and the bug it prevents only appears with the
    // category row open, on a scroller with real overflow, in Chrome.
    // Resolved from the project root, not import.meta.url: under the jsdom
    // environment `new URL(rel, import.meta.url)` throws on jsdom's Location.
    const css = readFileSync(resolve('src/client/Market.module.css'), 'utf8')
    const body = /^\.body\{([^}]*)\}/mu.exec(css)
    expect(body, '.body rule not found in Market.module.css').not.toBeNull()
    expect(body![1]!).toContain('overflow-anchor:none')
  })

  it('shrinks the open, multi-row category list to one row while the sticky header is pinned by scroll, and restores it once unstuck (#188)', async () => {
    // jsdom lays out nothing — every element reports offsetTop/offsetHeight
    // 0, which is exactly why the sibling "renders every category" test above
    // can only assert on the OPEN state, not on row counts. Here the one-row
    // vs two-row split is the thing under test, so it has to be given real
    // numbers to fit against: four ~32px rows of chips, simulated via a
    // prototype override restored at the end of the test.
    const offsetTopDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')
    const offsetHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset.chip !== '1') return 0
        const siblings = [...(this.parentElement?.children ?? [])]
          .filter((el): el is HTMLElement => (el as HTMLElement).dataset?.chip === '1')
        return Math.floor(siblings.indexOf(this) / 4) * 32
      },
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.className.includes('catsWrap') ? 90 : 26 },
    })
    // A genuinely long list. jsdom lays nothing out, so without these the
    // scroller reports zero overflow — which the #266 guard correctly reads
    // as "collapsing here could not hold" and skips, making this test about
    // a case that no longer exists.
    const scrollHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    const clientHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 4000 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 520 })

    let onChange: ((entry: { isIntersecting: boolean }) => void) | null = null
    class FakeIntersectionObserver {
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
        onChange = entry => cb([entry])
      }
      observe(): void {}
      disconnect(): void { onChange = null }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)

    try {
      stubFetch({ '/dsh-market/registry': { source: 'snapshot', registry: { ...REGISTRY, categories: CATS } } })
      const { container } = render(<MarketSection {...props()} />)
      await screen.findByText('dsh-loop')

      const chipCount = () => container.querySelectorAll('[data-chip="1"]').length

      fireEvent.click(screen.getByLabelText(re(en.catsMore)))
      await waitFor(() => expect(screen.getByLabelText(re(en.catsLess))).toBeTruthy())
      const openCount = chipCount()
      expect(openCount).toBe(11) // "all" pill + 10 categories, fully open

      expect(onChange, 'the sticky sentinel must be observed').not.toBeNull()

      // Sentinel scrolled out of view above the scroll root: the header is now stuck.
      onChange!({ isIntersecting: false })
      await waitFor(() => expect(chipCount()).toBeLessThan(openCount))
      // Squeezed to the one-row budget (2 categories, reserving a slot for
      // the chevron), not the two-row budget (6) the plain collapsed state
      // would use — proves the stuck path swapped budgets, not just re-ran
      // the ordinary collapse.
      expect(chipCount()).toBe(3) // "all" pill + 2 categories
      // The auto-collapse is a REAL catsOpen flip, so the chevron now reads
      // "more" (collapsed), not "less" — and, critically, clicking it must
      // still work. An earlier version computed a display-only "effectively
      // open" value while leaving catsOpen genuinely true, so the chevron's
      // click handler toggled a value the render path had stopped
      // consulting — clicking it while stuck did nothing visible (reported:
      // "吸顶滚动了之后，展开没反应了").
      const moreButton = screen.getByLabelText(re(en.catsMore))
      fireEvent.click(moreButton)
      await waitFor(() => expect(chipCount()).toBe(openCount))
      expect(screen.getByLabelText(re(en.catsLess))).toBeTruthy()

      // An explicit re-open while still stuck must survive scrolling back to
      // the top — the auto-collapse must not fight the user's own choice.
      onChange!({ isIntersecting: true })
      await waitFor(() => expect(chipCount()).toBe(openCount))
      expect(screen.getByLabelText(re(en.catsLess))).toBeTruthy()
    } finally {
      if (offsetTopDesc) Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTopDesc)
      if (offsetHeightDesc) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeightDesc)
      if (scrollHeightDesc) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeightDesc)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
      if (clientHeightDesc) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeightDesc)
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
    }
  })
})

describe('card thumbnail + lightbox (curated screenshots only)', () => {
  const SHOT_A = 'https://raw.githubusercontent.com/alice/dsh-loop/main/assets/a.png'
  const SHOT_B = 'https://raw.githubusercontent.com/alice/dsh-loop/main/assets/b.png'
  /** Mirrors CardShot's own thumbUrl(): the card renders a resized proxy, not the original. */
  const cardThumb = (src: string) => `https://images.weserv.nl/?url=${encodeURIComponent(src.replace(/^https?:\/\//, ''))}&h=200&fit=inside&we=1`

  function registryWithShots() {
    const registry = JSON.parse(JSON.stringify(REGISTRY))
    registry.plugins[0].screenshots = [SHOT_A, SHOT_B]
    registry.plugins[0].downloads = 4200
    registry.plugins[0].install = 'dsh plugin --profile web add github:alice/dsh-loop'
    return registry
  }

  it('shows a scrollable thumbnail strip only on the card with curated screenshots', async () => {
    stubFetch({ '/dsh-market/registry': { source: 'live', registry: registryWithShots() } })
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')

    const shots = container.querySelectorAll('img[class*="cardShot"]')
    // dsh-loop has two curated screenshots, dsh-notify and whale-skin have
    // none — both of dsh-loop's shots render (a scrollable strip, not a
    // single cropped/cycling image), nothing from the other two cards.
    expect(shots.length).toBe(2)
    expect(shots[0]?.getAttribute('src')).toBe(cardThumb(SHOT_A))
    expect(shots[1]?.getAttribute('src')).toBe(cardThumb(SHOT_B))
  })

  it('portals into a container of its own, never straight into document.body (#293)', async () => {
    // The host's settings dialog is a separate React root that also portals
    // to document.body. Two roots adding and removing children of the SAME
    // container interleave in an order neither models: the host's root then
    // calls removeChild for a node this one already moved, React throws
    // NotFoundError, the settings.section slot catches it, and the panel
    // goes blank. Three reporters hit that (#293, #286, #241).
    //
    // The fix is structural, so this asserts the structure — the crash
    // itself depends on mount ordering that varies per host and cannot be
    // pinned down in jsdom.
    resetMarketPortalHost()
    stubFetch({ '/dsh-market/registry': { source: 'live', registry: registryWithShots() } })
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(container.querySelector('img[class*="cardShot"]')!)
    const img = await waitFor(() => {
      const found = document.querySelector('[class*="lightboxImg"]')
      expect(found).toBeTruthy()
      return found as HTMLElement
    })

    const own = document.querySelector('[data-dsh-market-portal]')
    expect(own, 'no owned portal container was created').toBeTruthy()
    expect(own!.contains(img), 'the lightbox mounted outside the container this package owns').toBe(true)
    // And it is body's LAST child: the stacking guarantee the portal exists
    // for, which a plain z-index cannot win against another portal.
    expect(document.body.lastElementChild).toBe(own)
  })

  it('keeps one container, last in body, across repeated opens', async () => {
    // The container is created during render (createPortal needs a target) but
    // MOVED into body from a layout effect — see useMarketPortalHost. What is
    // observable from here is the invariant that move exists to hold: exactly
    // one container, always body's last child, however many times the preview
    // is opened. A second container, or one that drifts off the end, is the
    // shared-child-list churn between two React roots that #293 was about.
    resetMarketPortalHost()
    stubFetch({ '/dsh-market/registry': { source: 'live', registry: registryWithShots() } })
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')

    for (let i = 0; i < 3; i++) {
      fireEvent.click(container.querySelector('img[class*="cardShot"]')!)
      await waitFor(() => expect(document.querySelector('[class*="lightboxImg"]')).toBeTruthy())
      expect(document.querySelectorAll('[data-dsh-market-portal]').length,
        'a second portal container was created').toBe(1)
      expect(document.body.lastElementChild,
        'the container drifted off the end of body').toBe(document.querySelector('[data-dsh-market-portal]'))
      fireEvent.click(document.querySelector('[class*="lightboxClose"]')!)
      await waitFor(() => expect(document.querySelector('[class*="lightboxImg"]')).toBeNull())
    }
  })

  it('opens a lightbox on click, at the clicked shot, and wraps prev/next around the ends', async () => {
    stubFetch({ '/dsh-market/registry': { source: 'live', registry: registryWithShots() } })
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')

    fireEvent.click(container.querySelector('img[class*="cardShot"]')!)
    // The lightbox portals into a container this package owns (so it always stacks above the
    // Settings Modal, which portals there too) — no longer inside `container`.
    await waitFor(() => expect(document.querySelector('[class*="lightboxImg"]')).toBeTruthy())
    const img = () => document.querySelector('[class*="lightboxImg"]') as HTMLImageElement
    expect(img().src).toBe(SHOT_A)

    fireEvent.click(document.querySelector('[class*="lightboxNext"]')!)
    expect(img().src).toBe(SHOT_B)
    // Two shots total — next again wraps back to the first, not off the end.
    fireEvent.click(document.querySelector('[class*="lightboxNext"]')!)
    expect(img().src).toBe(SHOT_A)
    // Prev from the first wraps to the last, the same way.
    fireEvent.click(document.querySelector('[class*="lightboxPrev"]')!)
    expect(img().src).toBe(SHOT_B)
  })

  it('does not auto-advance the lightbox — a full-bleed preview stays put until the viewer moves on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      stubFetch({ '/dsh-market/registry': { source: 'live', registry: registryWithShots() } })
      const { container } = render(<MarketSection {...props()} />)
      await vi.waitFor(() => expect(screen.queryByText('dsh-loop')).toBeTruthy())

      fireEvent.click(container.querySelector('img[class*="cardShot"]')!)
      await vi.waitFor(() => expect(document.querySelector('[class*="lightboxImg"]')).toBeTruthy())
      const img = () => document.querySelector('[class*="lightboxImg"]') as HTMLImageElement
      expect(img().src).toBe(SHOT_A)
      await vi.advanceTimersByTimeAsync(10_000)
      // The preview is on demand: nothing may page past the shot the viewer
      // is reading. Manual navigation (arrows/dots/keys) is what moves it.
      expect(img().src).toBe(SHOT_A)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes only the lightbox on Escape, leaving the dialog underneath open', async () => {
    stubFetch({ '/dsh-market/registry': { source: 'live', registry: registryWithShots() } })
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')

    fireEvent.click(container.querySelector('img[class*="cardShot"]')!)
    await waitFor(() => expect(document.querySelector('[class*="lightboxImg"]')).toBeTruthy())
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[class*="lightboxImg"]')).toBeNull())
    // The market section itself (rendered before the click) is still there —
    // a real host regression had one Escape close both layers at once.
    expect(screen.getByText('dsh-loop')).toBeTruthy()
  })

  it('does not auto-cycle the card thumbnail strip — scrolling, not a timer, is how you see more than one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      stubFetch({ '/dsh-market/registry': { source: 'live', registry: registryWithShots() } })
      const { container } = render(<MarketSection {...props()} />)
      await vi.waitFor(() => expect(screen.queryByText('dsh-loop')).toBeTruthy())

      const srcs = () => [...container.querySelectorAll('img[class*="cardShot"]')].map(el => (el as HTMLImageElement).src)
      expect(srcs()).toEqual([cardThumb(SHOT_A), cardThumb(SHOT_B)])
      await vi.advanceTimersByTimeAsync(10_000)
      // Both shots are still there, in the same order — nothing cycled away.
      expect(srcs()).toEqual([cardThumb(SHOT_A), cardThumb(SHOT_B)])
    } finally {
      vi.useRealTimers()
    }
  })

  it('sets no thumbnail src at all until the card scrolls near the viewport, then loads the resized proxy', async () => {
    // jsdom has no real IntersectionObserver, and CardShot's hook falls back
    // to eager (near=true) rather than fail closed when one is unavailable —
    // exactly right for jsdom itself, but it means every OTHER test in this
    // file only proves "renders once visible", never "withholds until then".
    // This is the one test that supplies a controllable observer to prove
    // the gate itself: a card scrolled off-screen must not even set `src`
    // (no request queued), and must load the small proxy once it does.
    // The sticky category header observes its own sentinel with a real
    // IntersectionObserver too, so a single "last constructed wins" fake
    // would just as easily capture THAT one instead of CardShot's — key by
    // the observed element instead, found once `observe` is actually called.
    let onCardShotsChange: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null
    class FakeIntersectionObserver {
      #cb: (entries: Array<{ isIntersecting: boolean }>) => void
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) { this.#cb = cb }
      observe(target: Element): void {
        if (target.className.toString().includes('cardShots')) onCardShotsChange = this.#cb
      }
      disconnect(): void {}
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)

    stubFetch({ '/dsh-market/registry': { source: 'live', registry: registryWithShots() } })
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')

    const shots = () => [...container.querySelectorAll('img[class*="cardShot"]')]
    expect(shots().every(el => el.getAttribute('src') === null)).toBe(true)

    expect(onCardShotsChange, 'CardShot must observe its own strip element').not.toBeNull()
    onCardShotsChange!([{ isIntersecting: true }])
    await waitFor(() => expect(shots()[0]?.getAttribute('src')).toBe(cardThumb(SHOT_A)))
    expect(shots()[1]?.getAttribute('src')).toBe(cardThumb(SHOT_B))
  })

  it('the confirm dialog shows the card\'s own byline — owner, downloads, stars, date, category', async () => {
    stubFetch({ '/dsh-market/registry': { source: 'live', registry: registryWithShots() } })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')

    const installButtonOf = (name: string) => {
      let card: HTMLElement | null = screen.getByText(name)
      while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
        card = card.parentElement
      }
      return within(card!).getAllByRole('button', { name: en.install })[0]!
    }
    fireEvent.click(installButtonOf('dsh-loop'))
    await screen.findByRole('button', { name: en.confirmInstall })

    // The card behind the dialog carries the same fields — scope to the
    // dialog so this proves the MODAL shows them, not just the grid.
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('alice')).toBeTruthy()
    expect(dialog.getByText(/4\.2k/)).toBeTruthy()
    expect(dialog.getByText(/50/)).toBeTruthy()
    expect(dialog.getByText(/2026-08-01/)).toBeTruthy()
    expect(dialog.getByText('Tools')).toBeTruthy()
  })

  it('lets the "Install command" row expand by clicking its title text, not only its icon (expandOnRowClick)', async () => {
    const registry = registryWithShots()
    const installCmd = registry.plugins[0].install as string
    stubFetch({ '/dsh-market/registry': { source: 'live', registry } })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')

    const installButtonOf = (name: string) => {
      let card: HTMLElement | null = screen.getByText(name)
      while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
        card = card.parentElement
      }
      return within(card!).getAllByRole('button', { name: en.install })[0]!
    }
    fireEvent.click(installButtonOf('dsh-loop'))
    await screen.findByRole('button', { name: en.confirmInstall })

    expect(screen.queryByText(installCmd)).toBeNull()
    fireEvent.click(screen.getByText(re(en.cmdDetails)))
    await waitFor(() => expect(screen.getByText(installCmd)).toBeTruthy())
  })

  it('offers a Retry button on a catalog load failure, which re-fetches and recovers (#188)', async () => {
    let calls = 0
    stubFetch({
      '/dsh-market/registry': () => {
        calls++
        return calls === 1
          ? { __status: 500, error: 'HTTP 500' }
          : { source: 'live', registry: REGISTRY }
      },
    })
    render(<MarketSection {...props()} />)

    await screen.findByText(en.loadFail)
    expect(screen.getByText('HTTP 500')).toBeTruthy()
    expect(calls).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: en.loadRetry }))

    await screen.findByText('dsh-loop')
    expect(screen.queryByText(en.loadFail)).toBeNull()
    expect(calls).toBe(2)
  })
})

describe('card owner name and description overflow', () => {
  it('carries the full owner name in a title attribute, even once CSS ellipsizes it', async () => {
    stubFetch({ '/dsh-market/registry': { source: 'live', registry: REGISTRY } })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')

    const card = screen.getByText('dsh-loop').closest('[class*="card"]') as HTMLElement
    const owner = within(card).getByText('alice')
    expect(owner.getAttribute('title')).toBe('alice')
  })

  it('clamps a long description by default and shows nothing to expand for a short one', async () => {
    stubFetch({ '/dsh-market/registry': { source: 'live', registry: REGISTRY } })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')

    // jsdom never lays anything out, so scrollHeight === clientHeight (both
    // 0) for every element — the real "does this overflow 5 lines" check
    // can only be exercised with the two properties stubbed, done below.
    expect(screen.queryByLabelText(re(en.descExpand))).toBeNull()
  })

  it('offers an expand/collapse toggle only once the clamped text actually overflows, and it flips the clamp', async () => {
    const scrollHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    const clientHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.className.includes('desc') ? 90 : 0 },
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.className.includes('desc') ? 54 : 0 },
    })
    try {
      stubFetch({ '/dsh-market/registry': { source: 'live', registry: REGISTRY } })
      const { container } = render(<MarketSection {...props()} />)
      await screen.findByText('dsh-loop')

      const toggle = screen.getAllByLabelText(re(en.descExpand))[0]!
      const desc = () => container.querySelector('[class*="desc"]:not([class*="descTight"])')
      expect(desc()?.className).toMatch(/descClamp/)

      fireEvent.click(toggle)
      await waitFor(() => expect(screen.queryAllByLabelText(re(en.descCollapse)).length).toBeGreaterThan(0))
      expect(desc()?.className).not.toMatch(/descClamp/)

      fireEvent.click(screen.getAllByLabelText(re(en.descCollapse))[0]!)
      await waitFor(() => expect(screen.queryAllByLabelText(re(en.descExpand)).length).toBeGreaterThan(0))
      expect(desc()?.className).toMatch(/descClamp/)
    } finally {
      if (scrollHeightDesc) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeightDesc)
      if (clientHeightDesc) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeightDesc)
    }
  })
})
