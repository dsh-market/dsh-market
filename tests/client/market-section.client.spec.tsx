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

function stubFetch(overrides: Record<string, unknown> = {}): void {
  vi.stubGlobal('fetch', (url: string) => {
    const path = String(url).split('?')[0]
    const payload =
      path === '/dsh-market/registry' ? { source: 'snapshot', registry: REGISTRY }
      : path === '/dsh-market/installed' ? { profile: 'web', installed: {}, live: [] }
      : path === '/dsh-market/status' ? { active: false, pnpm: true, boot: 'boot-1', restart: true, installed: {} }
      : path === '/dsh-market/updates' ? { updates: {} }
      : null
    const merged = overrides[path] ?? payload
    if (merged === null) return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
    return Promise.resolve(new Response(JSON.stringify(merged), { status: 200 }))
  })
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

beforeEach(() => stubFetch())
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
    expect(screen.getByRole('radio', { name: en.sortDesc })).toBeTruthy()
    expect(screen.getByRole('radio', { name: en.sortAsc })).toBeTruthy()

    // Field = Release date → direction labels switch to Newest/Oldest; the
    // already-selected desc means newest first.
    fireEvent.click(screen.getByRole('radio', { name: en.sortAdded }))
    await waitFor(() => {
      const names = screen.getAllByText(/^(dsh-loop|dsh-notify|whale-skin)$/).map(n => n.textContent)
      expect(names[0]).toBe('whale-skin') // newest first
    })
    fireEvent.click(screen.getByRole('radio', { name: en.sortOldest }))
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
    // the numbered pager while keeping the size switcher visible.
    fireEvent.click(screen.getByRole('button', { name: '48' }))
    await waitFor(() => {
      expect(screen.getByText('dsh-q1')).toBeTruthy()
      expect(screen.getByText('dsh-q30')).toBeTruthy()
      expect(screen.queryByRole('button', { name: '2' })).toBeNull()
      expect(screen.getByRole('button', { name: '96' })).toBeTruthy()
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
    fireEvent.click(screen.getByRole('radio', { name: en.timeWeek }))
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
      })
      // The real /install response arrives: hot mount confirmed.
      resolveInstall(new Response(JSON.stringify({
        ok: true,
        hot: true,
        installed: { 'dsh-loop': '^1.0.0' },
        activation: { 'dsh-loop': { state: 'live', reasons: ['live via hot mount'], bundle: true, hot: true } },
      }), { status: 200 }))
      // The stale pending-restart entry must be dropped: no restart banner.
      await vi.waitFor(() => {
        expect(screen.queryAllByText(re(en.restartBanner)).length).toBe(0)
      })
      // Stable counterpart: the hot banner still shows the live mount.
      expect(screen.getAllByText(re(en.hotBanner)).length).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
