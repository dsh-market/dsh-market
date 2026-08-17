// @vitest-environment jsdom
/**
 * Layer-2 component specs (harness convention: jsdom pragma +
 * testing-library against the REAL component with the REAL locale dicts and
 * the REAL ui-primitives package). The host boundary is the four fetch
 * endpoints, stubbed with fixture payloads.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketSection } from '../../src/client/MarketSection.tsx'
import { resetScreenshotsCache } from '../../src/client/market-data.ts'
import { en } from '../../src/client/locales.ts'

const REGISTRY = {
  updated: '', count: 4,
  categories: { tools: { en: 'Tools', zh: '工具' }, theme: { en: 'Themes', zh: '主题' } },
  plugins: [
    { name: 'dsh-loop', owner: 'alice', url: 'https://github.com/alice/dsh-loop', category: 'tools', npm: 'dsh-loop', stars: 50, added: '2026-08-01', description: { en: 'Loop task runner', zh: '循环执行' }, install: '' },
    { name: 'dsh-notify', owner: 'bob', url: 'https://github.com/bob/dsh-notify', category: 'tools', npm: null, stars: 120, added: '2026-08-10', description: { en: 'Desktop notifications', zh: '桌面通知' }, install: '' },
    { name: 'whale-skin', owner: 'carol', url: 'https://github.com/carol/whale-skin', category: 'theme', npm: null, stars: 80, added: '2026-08-14', description: { en: 'Whale theme', zh: '鲸鱼主题' }, install: '' },
  ],
}

/** Every fetch the component made, for asserting request payloads. */
let fetchCalls: Array<{ path: string; method: string; body: unknown }> = []

function stubFetch(overrides: Record<string, unknown> = {}) {
  fetchCalls = []
  const mock = vi.fn((input: unknown, init?: RequestInit) => {
    const path = String(input).split('?')[0]
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    fetchCalls.push({ path, method, body })
    const payload =
      path === '/dsh-market/registry' ? { source: 'snapshot', registry: REGISTRY }
      : path === '/dsh-market/installed' ? { profile: 'web', installed: {}, live: [], disabled: [], groups: {}, groupOrder: [] }
      : path === '/dsh-market/status' ? { active: false, pnpm: true, boot: 'boot-1', restart: true, installed: {} }
      : path === '/dsh-market/updates' ? { updates: {} }
      : path === '/dsh-market/toggle' ? { ok: true, disabled: [], live: [], activation: {} }
      : path === '/dsh-market/groups' ? { ok: true, groups: {}, groupOrder: [], disabled: [] }
      : null
    const merged = overrides[path] ?? payload
    if (merged === null) return Promise.reject(new Error(`unstubbed fetch: ${String(input)}`))
    const result = typeof merged === 'function' ? (merged as (requestBody?: unknown) => unknown)(body) : merged
    return Promise.resolve(new Response(JSON.stringify(result), { status: 200 }))
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

beforeEach(() => { stubFetch(); resetScreenshotsCache() })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('MarketSection (jsdom)', () => {
  it('renders the catalog with install buttons once the registry loads', async () => {
    render(<MarketSection {...props()} />)
    expect(await screen.findByText('dsh-loop')).toBeTruthy()
    expect(screen.getByText('dsh-notify')).toBeTruthy()
    // Theme entries carry an Install button too (discover tab shows all).
    expect(screen.getAllByRole('button', { name: en.install }).length).toBeGreaterThanOrEqual(3)
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

  it('category pills filter and the filter panel sorts by field + direction', async () => {
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: 'Themes' }))
    await waitFor(() => {
      expect(screen.queryByText('dsh-loop')).toBeNull()
      expect(screen.getByText('whale-skin')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'All' }))

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
    expect(await screen.findByRole('button', { name: en.confirm })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    await waitFor(() => expect(screen.queryByRole('button', { name: en.confirm })).toBeNull())
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

  it('shows curated registry screenshots in the dialog, and README-extracted ones as fallback (#61)', async () => {
    const CURATED = 'https://raw.githubusercontent.com/alice/dsh-loop/main/assets/demo.png'
    const registry = JSON.parse(JSON.stringify(REGISTRY))
    registry.plugins[0].screenshots = [CURATED, 'https://evil.example/track.png']
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const path = String(url).split('?')[0]
      if (path === '/dsh-market/registry') return Promise.resolve(new Response(JSON.stringify({ source: 'snapshot', registry }), { status: 200 }))
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
    await screen.findByRole('button', { name: en.confirm })
    await waitFor(() => {
      const srcs = [...document.querySelectorAll('img')].map(img => img.getAttribute('src'))
      expect(srcs).toContain(CURATED)
      expect(srcs).not.toContain('https://evil.example/track.png')
    })
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    await waitFor(() => expect(screen.queryByRole('button', { name: en.confirm })).toBeNull())

    // Fallback: dsh-notify's dialog extracts from its README, path resolved to raw.
    fireEvent.click(installButtonOf('dsh-notify'))
    await screen.findByRole('button', { name: en.confirm })
    await waitFor(() => {
      const srcs = [...document.querySelectorAll('img')].map(img => img.getAttribute('src'))
      expect(srcs).toContain('https://raw.githubusercontent.com/bob/dsh-notify/HEAD/assets/notify.png')
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
    fireEvent.click(screen.getByRole('button', { name: en.tabBackup }))
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
      // Host stays idle and the plugin never appears in installed: two polls
      // (2s apart) must conclude the install died and release the button.
      await vi.advanceTimersByTimeAsync(2100)
      await vi.advanceTimersByTimeAsync(2100)
      expect(sessionStorage.getItem('dshm-pending')).toBeNull()
      expect(screen.getByText(new RegExp(en.installFail))).toBeTruthy()
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
  it('renders the four-state chip with the server reasons', async () => {
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
    expect(screen.getByText(en.stateLive)).toBeTruthy()
    // The reason is behind a disclosure; the chip itself must not claim success.
    expect(screen.getByText(en.stateRestart).textContent).toContain(en.stateRestart)
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

  it('the market row shows a disabled switch with an explanation instead of calling the API', async () => {
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
    const sw = await screen.findByRole('switch', { name: en.marketNoToggle })
    expect(screen.getByText('dshmarket')).toBeTruthy()
    expect((sw as HTMLButtonElement).disabled).toBe(true)
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    // A disabled control never bounces a rejected request off the server.
    expect(fetchCalls.some(c => c.path === '/dsh-market/toggle')).toBe(false)
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
          path === '/dsh-market/registry' ? { source: 'snapshot', registry: REGISTRY }
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
      await vi.waitFor(() => { screen.getByRole('button', { name: en.confirm }) })
      fireEvent.click(screen.getByRole('button', { name: en.confirm }))
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
      // Stable counterpart: the hot banner still shows the live mount.
      expect(screen.getAllByText(re(en.hotBanner)).length).toBeGreaterThan(0)
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
          path === '/dsh-market/registry' ? { source: 'snapshot', registry: REGISTRY }
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
      await vi.waitFor(() => { screen.getByRole('button', { name: en.confirm }) })
      fireEvent.click(screen.getByRole('button', { name: en.confirm }))
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
        path === '/dsh-market/registry' ? { source: 'snapshot', registry: REGISTRY }
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
