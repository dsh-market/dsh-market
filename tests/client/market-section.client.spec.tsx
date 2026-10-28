// @vitest-environment jsdom
/**
 * Layer-2 component specs (harness convention: jsdom pragma +
 * testing-library against the REAL component with the REAL locale dicts and
 * the REAL ui-primitives package). The host boundary is the four fetch
 * endpoints, stubbed with fixture payloads.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketSection, OwnerAvatar, resetHostCompatibilityCache, resetMarketPortalHost, resetThemePreviewCache } from '../../src/client/MarketSection.tsx'
import css from '../../src/client/Market.module.css'
import { downloadStatsText } from '../../src/client/download-stats.ts'
import { createHostNavigation } from '../../src/client/host-navigation.ts'
import { SEARCH_DELAY_MS } from '../../src/client/SearchInput.tsx'
import {
  pluginScreenshotCandidates, resetGithubRouting, resetScreenshotsCache, restartHintKey, setGithubRoutes,
} from '../../src/client/market-data.ts'
import { en, zh } from '../../src/client/locales.ts'

describe('Issue #991 approval target and queue feedback', () => {
  describe.each(['en', 'zh'])('visible update explanation in %s', (lang) => {
    const dict = lang === 'zh' ? zh : en
    const snapshot = { active: lang }
    afterEach(() => { vi.restoreAllMocks() })
    const localizedProps = () => ({ ...props(),
      t: (key: string) => (dict as Record<string, string>)[key] ?? key,
      locale: { subscribe: () => () => {}, getSnapshot: () => snapshot },
    })

    it.each(['known', 'estimated', 'invalid', 'missing', 'mature'])('links the %s latest wait to the exact install target', async (timing) => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-26T00:00:00Z'))
      const mature = timing === 'mature'
      const until = timing === 'invalid' ? 'unknown' : timing === 'missing' ? undefined : '2026-10-26T04:30:00Z'
      stubFetch({
        '/dsh-market/installed': { profile: 'desktop', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
        '/dsh-market/updates': { updates: { 'dsh-loop': {
          kind: 'npm', current: '1.0.0', latest: mature ? '1.1.0' : '1.2.0', eligibleVersion: '1.1.0', updateAvailable: true,
          ...(!mature ? { heldUpdate: { latest: '1.2.0', until, ...(timing === 'estimated' ? { estimated: true } : {}) } } : {}),
        } } },
        '/dsh-market/update': { ok: true },
      })
      render(<MarketSection {...localizedProps()} />)
      fireEvent.click(await screen.findByRole('button', { name: new RegExp(dict.tabInstalled) }))
      const button = await screen.findByRole('button', { name: `${dict.update} v1.1.0` })
      if (mature) {
        expect(screen.queryByText(/先更新到|Update to .* for now/)).toBeNull()
        expect(screen.queryByText(dict.updateHeldTag)).toBeNull()
      } else {
        const expected = timing === 'known'
          ? lang === 'zh' ? '最新版 v1.2.0 刚发布，还要约 5 小时。先更新到 v1.1.0。' : 'Latest v1.2.0 was just released; about 5 hours to wait. Update to v1.1.0 for now.'
          : lang === 'zh' ? '最新版 v1.2.0 的发布时间暂不确定，还需等待。先更新到 v1.1.0。' : 'The release time of latest v1.2.0 is unknown, so it still needs to wait. Update to v1.1.0 for now.'
        const explanation = screen.getByText(expected)
        expect(explanation.getAttribute('title')).toBeNull()
        expect(explanation.textContent).not.toMatch(/pnpm|NaN|profile|\/latest/)
        expect(screen.getByText(dict.updateHeldTag)).toBeTruthy()
        if (timing !== 'known') expect(explanation.textContent).not.toMatch(/\d+\s*(?:hours?|小时)/)
      }
      fireEvent.click(button)
      await waitFor(() => expect(fetchCalls.filter(call => call.path === '/dsh-market/update').map(call => call.body))
        .toEqual([{ name: 'dsh-loop', eligibleVersion: '1.1.0' }]))
    })

    it.each(['batch', 'restored queue'])('submits exact eligibleVersion through %s', async (entry) => {
      if (entry === 'restored queue') localStorage.setItem('dshm-queue-v1', JSON.stringify([
        { kind: 'update', name: 'dsh-loop', updateOptions: { eligibleVersion: '1.1.0' } },
      ]))
      stubFetch({
        '/dsh-market/installed': { profile: 'desktop', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
        '/dsh-market/updates': { updates: { 'dsh-loop': {
          kind: 'npm', current: '1.0.0', latest: '1.2.0', eligibleVersion: '1.1.0', updateAvailable: true,
          heldUpdate: { latest: '1.2.0', until: '2026-10-27T00:00:00Z' },
        } } },
        '/dsh-market/update': { ok: true },
      })
      render(<MarketSection {...localizedProps()} />)
      if (entry === 'batch') fireEvent.click(await screen.findByRole('button', { name: new RegExp(dict.updateAll) }))
      await waitFor(() => expect(fetchCalls.filter(call => call.path === '/dsh-market/update').map(call => call.body))
        .toEqual([{ name: 'dsh-loop', eligibleVersion: '1.1.0' }]), { timeout: 8000 })
    })
  })

  it.each(['banner', 'panel', 'reloaded panel'])('keeps the original approval target through the %s and receives staleTarget 409', async (entry) => {
    let eligibleVersion = '1.1.0'
    let attempts = 0
    let staleReplies = 0
    stubFetch({
      '/dsh-market/installed': { profile: 'desktop', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-market/updates': () => ({ updates: { 'dsh-loop': {
        kind: 'npm', current: '1.0.0', latest: '1.3.0', eligibleVersion, updateAvailable: true,
      } } }),
      '/dsh-market/update': (body: unknown) => {
        if (++attempts === 1) return { ok: false, ignoredBuilds: ['node-pty'], error: 'blocked by pnpm', __status: 502 }
        if ((body as { eligibleVersion?: string }).eligibleVersion !== eligibleVersion) {
          staleReplies++
          return { ok: false, staleTarget: true, error: 'The eligible update target changed. Refresh and choose again.', __status: 409 }
        }
        return { ok: true }
      },
      '/dsh-market/approve-builds': { ok: true },
    })
    const view = render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Update v1.1.0' }))
    await screen.findByText(re(en.buildsSkipped))
    const original = { force: false, restore: false, eligibleVersion: '1.1.0' }
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem('dshm-settled-v1') ?? '[]')
      expect(saved[0]?.updateOptions).toEqual(original)
      expect(saved[0]?.blockedBuilds).toEqual(['node-pty'])
    })
    eligibleVersion = '1.2.0'
    if (entry === 'reloaded panel') {
      view.unmount()
      render(<MarketSection {...props()} />)
    }
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await screen.findByRole('button', { name: 'Update v1.2.0' })
    const refreshes = fetchCalls.filter(call => call.path === '/dsh-market/updates').length
    if (entry === 'banner') {
      const banner = screen.getByText(re(en.buildsSkipped)).parentElement!
      fireEvent.click(within(banner).getByRole('button', { name: en.approveBuilds }))
    } else {
      if (!document.querySelector('[class*="opPanel"]')) fireEvent.click(screen.getByRole('button', { name: en.opTitle }))
      const panel = document.querySelector('[class*="opPanel"]') as HTMLElement
      fireEvent.click(within(panel).getByRole('button', { name: en.approveBuilds }))
    }
    await waitFor(() => {
      const requests = fetchCalls.filter(call => call.path === '/dsh-market/update')
      expect(requests).toHaveLength(2)
      expect(requests[1].body).toEqual({ name: 'dsh-loop', eligibleVersion: '1.1.0' })
      expect(staleReplies).toBe(1)
      expect(fetchCalls.filter(call => call.path === '/dsh-market/updates').length).toBeGreaterThan(refreshes)
      expect(JSON.parse(localStorage.getItem('dshm-settled-v1') ?? '[]').at(-1)).toMatchObject({ state: 'failed' })
    })
    expect(screen.getAllByText('The eligible update target changed. Refresh and choose again.').length).toBeGreaterThan(0)
    expect(localStorage.getItem('dshm-queue-v1')).toBeNull()
  })

  it.each(['en', 'zh'])('explains a restored queue target change in %s while an update remains available', async (lang) => {
    localStorage.setItem('dshm-queue-v1', JSON.stringify([{
      kind: 'update', name: 'dsh-loop', updateOptions: { eligibleVersion: '1.1.0' },
    }]))
    stubFetch({
      '/dsh-market/installed': { profile: 'desktop', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-market/updates': { updates: { 'dsh-loop': { kind: 'npm', eligibleVersion: '1.2.0', updateAvailable: true } } },
    })
    const dict = lang === 'zh' ? zh : en
    const localeSnapshot = { active: lang }
    render(<MarketSection {...props()} t={key => (dict as Record<string, string>)[key] ?? key}
      locale={{ subscribe: () => () => {}, getSnapshot: () => localeSnapshot }} />)
    const message = lang === 'zh' ? '更新目标已变化，已跳过。请重新选择更新。' : 'The update target changed, so this task was skipped. Choose the update again.'
    expect(await screen.findByText(message)).toBeTruthy()
    expect(screen.queryByText(dict.agentQueueStaleNoUpdate)).toBeNull()
    expect(fetchCalls.some(call => call.path === '/dsh-market/update')).toBe(false)
  })
})

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
      route === '/dsh-market/registry' ? { source: 'live', registry: REGISTRY, hostVersion: '0.1.2-alpha.2' }
      : route === '/dsh-market/discovery-compatibility' ? {
          hostVersion: '0.1.2-alpha.2',
          plugins: Object.fromEntries(((body as { packages?: string[] } | undefined)?.packages ?? []).map(name => [name, {
            status: 'unknown', basis: 'undeclared', requirement: null, declarations: [],
          }])),
        }
      : route === '/dsh-market/installed' ? { profile: 'web', installed: {}, live: [], disabled: [], groups: {}, groupOrder: [], favorites: [], blocked: [] }
      : route === '/dsh-market/status' ? { active: false, pnpm: true, boot: 'boot-1', restart: true, installed: {} }
      : route === '/dsh-market/updates' ? { updates: {} }
      : route === '/dsh-market/toggle' ? { ok: true, disabled: [], live: [], activation: {} }
      : route === '/dsh-market/groups' ? { ok: true, groups: {}, groupOrder: [], disabled: [] }
      : route === '/dsh-market/favorite' ? { ok: true, favorites: [] }
      : route === '/dsh-market/block' ? { ok: true, blocked: [] }
      : route === '/dsh-market/dismiss-broken' ? { ok: true, brokenPlugins: {} }
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

/** Open the "···" menu on one installed row, found by walking up from its name. */
async function openRowMenu(name: string) {
  let row: HTMLElement | null = (await screen.findAllByText(name)).at(-1) ?? null
  while (row !== null && within(row).queryByRole('button', { name: en.groupMore }) === null) row = row.parentElement
  fireEvent.click(within(row!).getByRole('button', { name: en.groupMore }))
}

/** "重启前不再提醒" for one row, from its menu. */
async function ignoreRowUntilRestart(name: string) {
  await openRowMenu(name)
  fireEvent.click(await screen.findByRole('menuitem', { name: en.ignoreUpdateNotice }))
}

/** Installed-card uninstall lives in the card menu. The confirm dialog is still a button. */
async function openCardUninstall() {
  fireEvent.click((await screen.findAllByRole('button', { name: en.groupMore }))[0]!)
  fireEvent.click(await screen.findByRole('menuitem', { name: en.uninstall }))
}

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

/**
 * A working `localStorage`, installed per test.
 *
 * The ambient one is not usable here: Node ships its own `localStorage` when
 * the runner is started with `--localstorage-file` (vitest does, and without a
 * path), and that object shadows jsdom's — it has `getItem`/`setItem` but no
 * `clear`, so every test in this file failed in `afterEach` the moment one
 * touched it. The queue is persistent behaviour, so its tests need storage
 * that behaves like a browser's, not whatever global happens to be winning.
 */
function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => { map.delete(key) },
    setItem: (key: string, value: string) => { map.set(key, String(value)) },
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage())
  stubFetch(); resetGithubRouting(); resetScreenshotsCache(); resetThemePreviewCache()
  resetHostCompatibilityCache()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  resetGithubRouting()
})

describe('WebDAV daily backup (#868)', () => {
  const day = 24 * 60 * 60 * 1000
  const now = 1_800_000_000_000
  const config = { url: 'https://dav.example/dsh/backup.json', username: 'alice', auto: true }
  const requests = () => fetchCalls.filter(call => call.path === '/dsh-market/webdav')

  beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(now) })
  afterEach(() => { vi.restoreAllMocks() })

  async function openBackup() {
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: en.tabAdvanced }))
  }

  it.each([
    ['URL', en.webdavUrl, 'https://dav.example/dsh/edited.json'],
    ['username', en.webdavUser, 'bob'],
    ['password', en.webdavPassword, 'session-secret'],
  ])('editing the %s after a failed daily backup does not retry it', async (_field, placeholder, value) => {
    localStorage.setItem('dshm-webdav', JSON.stringify(config))
    stubFetch({ '/dsh-market/webdav': { __status: 500, error: 'daily backup failed' } })
    const view = render(<MarketSection {...props()} />)
    await openBackup()
    await screen.findByText('Error: daily backup failed')
    expect(requests()).toHaveLength(1)
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } })
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value: `${value}x` } })
    // A new translation callback must not become an automatic-backup trigger either.
    view.rerender(<MarketSection {...props()} />)
    await act(async () => {})
    expect(requests()).toHaveLength(1)
    expect(localStorage.getItem('dshm-webdav-last')).toBeNull()
    // A failed request releases the lock so an explicit retry still works.
    fireEvent.click(screen.getByRole('button', { name: en.webdavUpload }))
    await act(async () => {})
    expect(requests()).toHaveLength(2)
  })

  it('says what the address field wants, in the words the reporter had to guess (#868)', async () => {
    // "说明里面没有写清楚备份是个文件" — the field carried a placeholder and
    // nothing else, so the shape (file, name included) and the reason the name
    // cannot float were both left to trial and error.
    localStorage.setItem('dshm-webdav', JSON.stringify(config))
    stubFetch({ '/dsh-market/webdav': { ok: true } })
    render(<MarketSection {...props()} />)
    await openBackup()
    expect(await screen.findByText(new RegExp(en.webdavPathHint))).toBeTruthy()
    expect(screen.getByText(new RegExp(en.webdavPathHint)).textContent).toContain('name included')
  })

  it.each([
    ['no previous success', null, true],
    ['less than 24 hours', now - day + 1, false],
    ['exactly 24 hours', now - day, true],
    ['more than 24 hours', now - day - 1, true],
  ])('checks the original daily threshold on mount: %s', async (_label, last, due) => {
    localStorage.setItem('dshm-webdav', JSON.stringify(config))
    if (last !== null) localStorage.setItem('dshm-webdav-last', String(last))
    stubFetch({ '/dsh-market/webdav': { ok: true } })
    render(<MarketSection {...props()} />)
    await openBackup()
    expect(requests()).toHaveLength(due ? 1 : 0)
    if (due) await waitFor(() => expect(localStorage.getItem('dshm-webdav-last')).toBe(String(now)))
  })

  it('does not overlap daily uploads during StrictMode replay, editing or off/on toggles', async () => {
    localStorage.setItem('dshm-webdav', JSON.stringify(config))
    const fallback = stubFetch()
    let finish!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { finish = resolve })
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
      if (String(input) !== '/dsh-market/webdav') return fallback(input, init)
      fetchCalls.push({ path: String(input), method: init!.method!, body: JSON.parse(String(init!.body)) })
      return pending
    })
    render(<StrictMode><MarketSection {...props()} /></StrictMode>)
    await openBackup()
    expect(requests()).toHaveLength(1)
    fireEvent.change(screen.getByPlaceholderText(en.webdavUrl), { target: { value: `${config.url}x` } })
    fireEvent.change(screen.getByPlaceholderText(en.webdavUser), { target: { value: 'bob' } })
    fireEvent.change(screen.getByPlaceholderText(en.webdavPassword), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('checkbox', { name: en.autoBackup }))
    fireEvent.click(screen.getByRole('checkbox', { name: en.autoBackup }))
    expect(requests()).toHaveLength(1)
    expect(localStorage.getItem('dshm-webdav-last')).toBeNull()
    await act(async () => { finish(new Response(JSON.stringify({ ok: true }))) })
    await screen.findByText(en.backupDone)
    expect(localStorage.getItem('dshm-webdav-last')).toBe(String(now))
    fireEvent.click(screen.getByRole('checkbox', { name: en.autoBackup }))
    fireEvent.click(screen.getByRole('checkbox', { name: en.autoBackup }))
    expect(requests()).toHaveLength(1)
  })

  it('does not start a backup when an enabled but empty URL is filled in', async () => {
    localStorage.setItem('dshm-webdav', JSON.stringify({ ...config, url: '' }))
    stubFetch({ '/dsh-market/webdav': { ok: true } })
    const view = render(<MarketSection {...props()} />)
    await openBackup()
    expect(requests()).toHaveLength(0)
    fireEvent.change(screen.getByPlaceholderText(en.webdavUrl), { target: { value: config.url } })
    fireEvent.change(screen.getByPlaceholderText(en.webdavPassword), { target: { value: 'secret' } })
    await act(async () => {})
    expect(requests()).toHaveLength(0)
    // The next opening still performs the due daily backup with saved settings.
    view.unmount()
    render(<MarketSection {...props()} />)
    await openBackup()
    expect(requests()).toHaveLength(1)
    expect(requests()[0]?.body).toEqual({ action: 'backup', url: config.url, username: config.username, password: '' })
  })

  it('uses current settings when enabled and still supports manual upload and restore without storing passwords', async () => {
    localStorage.setItem('dshm-webdav', JSON.stringify({ ...config, auto: false, password: 'old-secret' }))
    const backup = {
      format: 'dsh-profile-backup', version: 0.2,
      files: [{ path: 'package.json', json: { dependencies: { 'webdav-plugin': '^1.0.0' } } }],
    }
    stubFetch({ '/dsh-market/webdav': { ok: true, backup }, '/dsh-market/restore': { ok: true } })
    render(<MarketSection {...props()} />)
    await openBackup()
    expect((screen.getByPlaceholderText(en.webdavPassword) as HTMLInputElement).value).toBe('')
    const editedUrl = 'https://dav.example/dsh/edited.json'
    fireEvent.change(screen.getByPlaceholderText(en.webdavUrl), { target: { value: editedUrl } })
    fireEvent.change(screen.getByPlaceholderText(en.webdavUser), { target: { value: 'bob' } })
    fireEvent.change(screen.getByPlaceholderText(en.webdavPassword), { target: { value: 'session-secret' } })
    expect(requests()).toHaveLength(0)
    expect(JSON.parse(localStorage.getItem('dshm-webdav')!)).toEqual({ url: editedUrl, username: 'bob', auto: false })
    fireEvent.click(screen.getByRole('checkbox', { name: en.autoBackup }))
    await screen.findByText(en.backupDone)
    const body = { action: 'backup', url: editedUrl, username: 'bob', password: 'session-secret' }
    expect(requests().map(call => call.body)).toEqual([body])
    expect(JSON.parse(localStorage.getItem('dshm-webdav')!)).toEqual({ url: editedUrl, username: 'bob', auto: true })
    fireEvent.click(screen.getByRole('button', { name: en.webdavUpload }))
    await waitFor(() => expect(screen.getByRole('button', { name: en.webdavUpload }).hasAttribute('disabled')).toBe(false))
    expect(requests().map(call => call.body)).toEqual([body, body])
    fireEvent.click(screen.getByRole('button', { name: en.webdavRestore }))
    await screen.findByText('webdav-plugin')
    expect(requests().at(-1)?.body).toEqual({ ...body, action: 'restore' })
    expect(screen.getByRole('button', { name: en.restoreStart })).toBeTruthy()
    expect(fetchCalls.some(call => call.path === '/dsh-market/restore')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en.restoreStart }))
    fireEvent.click(await screen.findByRole('button', { name: en.confirm, exact: true }))
    await screen.findByText(en.restoreDone)
    expect(fetchCalls.find(call => call.path === '/dsh-market/restore')?.body).toEqual({ backup })
    expect(localStorage.getItem('dshm-webdav')).not.toContain('secret')
  })
})

describe('search input scheduling', () => {
  it('keeps the list unchanged while typing and filters after a pause', async () => {
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    const before = rankedNames(container)
    const input = screen.getByPlaceholderText(en.searchPh) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'loop' } })
    expect(input.value).toBe('loop')
    expect(rankedNames(container)).toEqual(before)
    await waitFor(() => expect(rankedNames(container)).toEqual(['dsh-loop']))
    fireEvent.change(input, { target: { value: '' } })
    expect(rankedNames(container)).toEqual(before)
  })
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

  describe('notes the market does not hold (#819)', () => {
    const ZH_LOCALE = { active: 'zh' }
    function openNotes(changelog: object, dict: Record<string, string> = en): Promise<HTMLElement> {
      stubFetch({
        '/dsh-market/installed': {
          profile: 'web', installed: { 'dsh-codearts-auth': 'git+https://gitee.com/o/r.git' }, live: [], disabled: [], notes: {},
        },
        '/dsh-market/updates': {
          updates: { 'dsh-codearts-auth': { kind: 'github', current: 'a'.repeat(40), latest: 'b'.repeat(40), updateAvailable: true } },
        },
        '/dsh-market/changelog': changelog,
      })
      const localized = dict === en ? {} : {
        t: (key: string) => dict[key] ?? key,
        locale: { subscribe: () => () => {}, getSnapshot: () => ZH_LOCALE },
      }
      render(<MarketSection {...props()} {...localized} preferredSubsectionId="installed" />)
      return screen.findByRole('button', { name: new RegExp(dict.notesLink!) }).then((button) => {
        fireEvent.click(button)
        return button
      })
    }

    it('says the market has none yet and links to the repository, instead of blaming the plugin', async () => {
      await openNotes({ kind: 'source', reason: 'missing', sourceUrl: 'https://gitee.com/o/r' })
      expect(await screen.findByText(new RegExp(en.notesSource))).toBeTruthy()
      expect(screen.getByRole('link', { name: en.notesSourceLink }).getAttribute('href')).toBe('https://gitee.com/o/r')
      expect(screen.queryByText(en.notesNone)).toBeNull()
    })

    it('says a non-GitHub source cannot be read, rather than that it is not collected yet', async () => {
      // #819's actual case: the dialog on a gitee install. "not collected
      // yet" reads as something that may arrive later, and for this source
      // nothing ever will — the feed is built from GitHub.
      await openNotes({ kind: 'source', reason: 'unreadable', sourceUrl: 'https://gitee.com/o/r' })
      expect(await screen.findByText(new RegExp(en.notesSourceUnreadable))).toBeTruthy()
      expect(screen.queryByText(new RegExp(en.notesSource))).toBeNull()
      expect(screen.queryByText(new RegExp(en.notesLoadFail))).toBeNull()
      expect(screen.getByRole('link', { name: en.notesSourceLink }).getAttribute('href')).toBe('https://gitee.com/o/r')
    })

    it('calls a failed load passing, and still links to the repository', async () => {
      await openNotes({ kind: 'source', reason: 'unavailable', sourceUrl: 'https://gitee.com/o/r' })
      expect(await screen.findByText(new RegExp(en.notesLoadFail))).toBeTruthy()
      expect(screen.queryByText(new RegExp(en.notesSource))).toBeNull()
      expect(screen.getByRole('link', { name: en.notesSourceLink })).toBeTruthy()
    })

    it('offers a next step when there is nothing to link to', async () => {
      await openNotes({ kind: 'source', reason: 'missing', sourceUrl: null })
      expect(await screen.findByText(new RegExp(en.notesSourceNoLink))).toBeTruthy()
      expect(screen.queryByRole('link', { name: en.notesSourceLink })).toBeNull()
    })

    it('joins the two Chinese sentences without a space, and the English ones with one', async () => {
      await openNotes({ kind: 'source', reason: 'missing', sourceUrl: null }, zh)
      const zhLine = await screen.findByText(new RegExp(zh.notesSourceNoLink))
      expect(zhLine.textContent).toBe(`${zh.notesSource}${zh.notesSourceNoLink}`)
      cleanup()
      await openNotes({ kind: 'source', reason: 'missing', sourceUrl: null })
      const enLine = await screen.findByText(new RegExp(en.notesSourceNoLink))
      expect(enLine.textContent).toBe(`${en.notesSource} ${en.notesSourceNoLink}`)
    })

    it('does not render a link that is not http(s)', async () => {
      await openNotes({ kind: 'source', reason: 'missing', sourceUrl: 'javascript:alert(1)' })
      expect(await screen.findByText(new RegExp(en.notesSourceNoLink))).toBeTruthy()
      expect(screen.queryByRole('link', { name: en.notesSourceLink })).toBeNull()
    })
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
  it('offers the top update-all button when exactly one plugin is updatable (#555)', async () => {
    stubFetch({
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
    })
    render(<MarketSection {...props()} />)
    expect(await screen.findByRole('button', { name: /Update all \(1\)/ })).toBeTruthy()
  })

  it('renders the catalog with install buttons once the registry loads', async () => {
    render(<MarketSection {...props()} />)
    expect(await screen.findByText('dsh-loop')).toBeTruthy()
    expect(screen.getByText('dsh-notify')).toBeTruthy()
    // Theme entries carry an Install button too (discover tab shows all).
    expect(screen.getAllByRole('button', { name: en.install }).length).toBeGreaterThanOrEqual(3)
  })

  it('hides host-incompatible plugins by default, and says how many it hid (#872)', async () => {
    // The report measured the default list on a live 0.2.0-rc.2 host: 175
    // discovered plugins, 45 declaring that host. The filter existed but was
    // opt-in, so the default list was mostly entries that cannot be
    // installed, with nothing at list level saying so.
    stubFetch({
      '/dsh-market/discovery-compatibility': {
        hostVersion: '0.1.2-alpha.2',
        plugins: {
          'dsh-loop': { status: 'incompatible', basis: 'manifest', requirement: '^0.9.0', declarations: ['^0.9.0'] },
        },
      },
    })
    render(<MarketSection {...props()} />)

    // The gated entry is gone; the ones that declare nothing stay (the
    // filter hides what is CONFIRMED incompatible, not what is silent).
    // The scan answers asynchronously, so the line that reports it is also
    // the signal that the filter has been applied.
    await waitFor(() => { if (!document.body.textContent?.includes('Hidden') && !document.body.textContent?.includes('Hid')) throw new Error('x') }, { timeout: 2000 }).catch(() => {})
    expect(await screen.findByText(en.hostFilterActive.replace('{0}', '0.1.2-alpha.2').replace('{1}', '1'))).toBeTruthy()
    expect(screen.queryByText('dsh-loop')).toBeNull()
    expect(screen.getByText('dsh-notify')).toBeTruthy()

    // Turning it off brings the entry back AND sticks: a user who disagreed
    // with the default must not be argued with on every page load.
    fireEvent.click(screen.getByRole('button', { name: en.filter }))
    fireEvent.click(await screen.findByText(en.hostAll))
    await waitFor(() => expect(screen.getByText('dsh-loop')).toBeTruthy())
    expect(localStorage.getItem('dshm-host-filter')).toBe('all')
  })

  it('reuses host-compatibility results across remounts so the sidebar page does not rescan (#846)', async () => {
    stubFetch({
      '/dsh-market/discovery-compatibility': {
        hostVersion: '0.1.2-alpha.2',
        plugins: {
          'dsh-loop': { status: 'incompatible', basis: 'manifest', requirement: '^0.9.0', declarations: ['^0.9.0'] },
        },
      },
    })
    const note = en.hostFilterActive.replace('{0}', '0.1.2-alpha.2').replace('{1}', '1')
    const { unmount } = render(<MarketSection {...props()} />)
    expect(await screen.findByText(note)).toBeTruthy()
    const callsBeforeRemount = fetchCalls.filter(call => call.path.includes('discovery-compatibility')).length
    expect(callsBeforeRemount).toBeGreaterThan(0)
    unmount()
    const marked = fetchCalls.length
    render(<MarketSection {...props()} />)
    expect(await screen.findByText(note)).toBeTruthy()
    expect(screen.queryByText('dsh-loop')).toBeNull()
    expect(
      fetchCalls.slice(marked).filter(call => call.path.includes('discovery-compatibility')),
      'remount must not POST discovery-compatibility again for names already scanned',
    ).toEqual([])
  })

  it('keeps update badges painted across remounts so the sidebar entry matches settings (#846)', async () => {
    stubFetch({
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
    })
    const { unmount } = render(<MarketSection {...props()} />)
    expect(await screen.findByRole('button', { name: /Update all \(1\)/ })).toBeTruthy()
    unmount()
    // No network yet — the button must still come from the shared cache, not
    // wait on /dsh-market/updates the way an empty remount used to.
    render(<MarketSection {...props()} />)
    expect(screen.getByRole('button', { name: /Update all \(1\)/ })).toBeTruthy()
  })

  it('keeps the header package version across remounts (#846)', async () => {
    stubFetch({ '/dsh-market/status': { active: false, pnpm: true, boot: 'boot-1', restart: true, installed: {}, version: '1.66.28' } })
    const { unmount } = render(<MarketSection {...props()} />)
    expect(await screen.findByText('v1.66.28')).toBeTruthy()
    unmount()
    render(<MarketSection {...props()} />)
    expect(screen.getByText('v1.66.28')).toBeTruthy()
  })

  it('drops host-compatibility results when the host version changes (#846)', async () => {
    stubFetch({
      '/dsh-market/registry': { source: 'live', registry: REGISTRY, hostVersion: '0.1.2-alpha.2' },
      '/dsh-market/discovery-compatibility': {
        hostVersion: '0.1.2-alpha.2',
        plugins: {
          'dsh-loop': { status: 'incompatible', basis: 'manifest', requirement: '^0.9.0', declarations: ['^0.9.0'] },
        },
      },
    })
    const { unmount } = render(<MarketSection {...props()} />)
    expect(await screen.findByText(en.hostFilterActive.replace('{0}', '0.1.2-alpha.2').replace('{1}', '1'))).toBeTruthy()
    expect(screen.queryByText('dsh-loop')).toBeNull()
    const compatBefore = fetchCalls.filter(call => call.path.includes('discovery-compatibility')).length
    unmount()
    stubFetch({
      '/dsh-market/registry': { source: 'live', registry: REGISTRY, hostVersion: '0.2.0-rc.2' },
      '/dsh-market/discovery-compatibility': {
        hostVersion: '0.2.0-rc.2',
        plugins: {
          'dsh-loop': { status: 'compatible', basis: 'manifest', requirement: '*', declarations: ['*'] },
        },
      },
    })
    render(<MarketSection {...props()} />)
    expect(await screen.findByText(en.hostFilterActive.replace('{0}', '0.2.0-rc.2').replace('{1}', '0'))).toBeTruthy()
    expect(screen.getByText('dsh-loop')).toBeTruthy()
    expect(fetchCalls.filter(call => call.path.includes('discovery-compatibility')).length).toBeGreaterThan(0)
    expect(compatBefore).toBeGreaterThan(0)
  })

  it('finishes the host-filter note after a remount mid-scan instead of freezing on 「正在检查」(#846)', async () => {
    // Unmounting mid-flight used to drop setStates while names stayed
    // "requested" — the next mount skipped them and froze at e.g. 665/2455.
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const compatBody = {
      hostVersion: '0.1.2-alpha.2',
      plugins: {
        'pkg-a': { status: 'compatible', basis: 'manifest', requirement: '*', declarations: ['*'] },
        'pkg-b': { status: 'incompatible', basis: 'manifest', requirement: '^9.0.0', declarations: ['^9.0.0'] },
      },
    }
    stubFetch({
      '/dsh-market/registry': {
        source: 'live', hostVersion: '0.1.2-alpha.2',
        registry: {
          ...REGISTRY,
          count: 2,
          plugins: [
            { name: 'pkg-a', owner: 'a', url: 'https://github.com/a/a', category: 'tools', npm: 'pkg-a', stars: 1, added: '2026-08-01', description: { en: 'A', zh: 'A' }, install: '' },
            { name: 'pkg-b', owner: 'b', url: 'https://github.com/b/b', category: 'tools', npm: 'pkg-b', stars: 1, added: '2026-08-01', description: { en: 'B', zh: 'B' }, install: '' },
          ],
        },
      },
    })
    const baseFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).split('?')[0] ?? ''
      if (path.endsWith('/dsh-market/discovery-compatibility')) {
        calls += 1
        if (calls === 1) await gate
        return new Response(JSON.stringify(compatBody), { status: 200 })
      }
      return baseFetch(input, init)
    })
    const { unmount } = render(<MarketSection {...props()} />)
    await screen.findByText('pkg-a')
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(1))
    unmount()
    render(<MarketSection {...props()} />)
    await act(async () => { release() })
    expect(await screen.findByText(en.hostFilterActive.replace('{0}', '0.1.2-alpha.2').replace('{1}', '1'))).toBeTruthy()
    expect(screen.queryByText(/Checking host requirements|正在检查宿主要求/)).toBeNull()
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
  it('shows the mapped product name on a subdirectory card and install dialog without changing its target', async () => {
    const plugin = {
      name: 'dsh-plugin-compat-check#plugin', owner: 'lcy0121',
      npm: 'dsh-plugin-compat-check', category: 'tools',
      url: 'https://github.com/lcy0121/dsh-plugin-compat-check/tree/main/plugin',
      description: { en: 'Installed-plugin compatibility checks' }, install: '', added: '2026-10-17',
    }
    stubFetch({
      '/dsh-market/registry': { source: 'live', registry: { ...REGISTRY, plugins: [plugin] } },
      '/dsh-market/install': { cancelled: true },
    })
    render(<MarketSection {...props()} />)
    const links = await screen.findAllByRole('link', { name: `${plugin.name} — ${en.repoLink}` })
    for (const link of links) {
      expect(link.textContent?.trim()).toBe('dsh-plugin-compat-check')
      expect(link.getAttribute('title')).toBe('dsh-plugin-compat-check#plugin')
      expect(link.getAttribute('href')).toBe('https://github.com/lcy0121/dsh-plugin-compat-check/tree/main/plugin')
    }
    fireEvent.click(screen.getAllByRole('button', { name: en.install, exact: true })[0]!)
    expect(await screen.findByRole('dialog', { name: `${en.confirmTitle} dsh-plugin-compat-check?` })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.confirmInstall }))
    await waitFor(() => expect(fetchCalls.find(call => call.path === '/dsh-market/install')?.body).toEqual({
      url: 'https://github.com/lcy0121/dsh-plugin-compat-check/tree/main/plugin',
    }))
  })

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

  it('shows why an export failed instead of only the status code (#55)', async () => {
    // kettly1260 saw "Error: HTTP 500" and could not tell what to do. The route
    // had answered with the reason; the download dropped it.
    stubFetch({
      '/dsh-market/backup': { __status: 500, error: '这个 profile 的配置文件超过 256 个，整份备份放不下。可以只导出选中的插件。' },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: en.tabAdvanced }))
    fireEvent.click(await screen.findByRole('button', { name: en.backupDownload }))
    const banner = await screen.findByText(/配置文件超过 256 个/)
    expect(banner.textContent).toContain(en.backupExportFailed)
    expect(screen.queryByText(/HTTP 500/)).toBeNull()
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

  it('closes an open card menu when the list scrolls, instead of letting it ride out over the sticky header', async () => {
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-market/updates': { updates: {} },
    })
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    const scroller = container.querySelector('[data-dsh-market-root] > [class*="body"]') as HTMLElement

    const card = screen.getByText('Loop task runner').closest('[class*="card"]') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: en.groupMore }))
    expect(screen.getByRole('menuitem', { name: en.blockAdd })).toBeTruthy()
    scroller.scrollTop = 120
    fireEvent.scroll(scroller)
    expect(screen.queryByRole('menuitem', { name: en.blockAdd })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click((await screen.findAllByRole('button', { name: en.groupMore }))[0]!)
    expect(await screen.findByRole('menuitem', { name: en.uninstall })).toBeTruthy()
    scroller.scrollTop = 120
    fireEvent.scroll(scroller)
    expect(screen.queryByRole('menuitem', { name: en.uninstall })).toBeNull()
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

  it('reads and displays GitHub host requirements, including incompatible-host filtering', async () => {
    localStorage.setItem('dshm-host-filter', 'all')
    const url = 'https://github.com/owner/whale/tree/master/packages/host'
    const range = '0.2.1-rc.2 || 0.2.1-rc.3'
    stubFetch({
      '/dsh-market/registry': {
        hostVersion: '0.2.1-rc.4',
        registry: { ...REGISTRY, count: 1, plugins: [{ ...REGISTRY.plugins[0], name: 'WhaleMaid', npm: null, url }] },
      },
      '/dsh-market/discovery-compatibility': {
        hostVersion: '0.2.1-rc.4',
        plugins: { [url]: { status: 'incompatible', basis: 'manifest', requirement: range,
          declarations: [{ kind: 'engine', range }] } },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('WhaleMaid')
    const badge = await screen.findByText(en.hostRequirement.replace('{0}', range))
    expect(badge.getAttribute('data-status')).toBe('incompatible')
    expect(fetchCalls.some(call => call.path === '/dsh-market/discovery-compatibility'
      && (call.body as { entries?: string[] }).entries?.includes(url))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.filter }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.hostCompatible.replace('{0}', '0.2.1-rc.4') }))
    await waitFor(() => expect(screen.queryByText('WhaleMaid')).toBeNull())
  })

  it('labels manifest requirements and filters only confirmed host mismatches', async () => {
    const plugins = [
      { ...REGISTRY.plugins[0], name: 'matches', npm: 'matches', url: 'https://github.com/a/matches' },
      { ...REGISTRY.plugins[0], name: 'mismatch', npm: 'mismatch', url: 'https://github.com/a/mismatch' },
      { ...REGISTRY.plugins[0], name: 'undeclared', npm: 'undeclared', url: 'https://github.com/a/undeclared' },
      { ...REGISTRY.plugins[0], name: 'github-only', npm: null, url: 'https://github.com/a/github-only' },
    ]
    stubFetch({
      '/dsh-market/registry': {
        source: 'live',
        hostVersion: '0.1.2-alpha.2',
        registry: { ...REGISTRY, count: plugins.length, plugins },
      },
      '/dsh-market/discovery-compatibility': (body: any) => ({
        hostVersion: '0.1.2-alpha.2',
        plugins: Object.fromEntries(body.packages.map((name: string) => [name, name === 'undeclared'
          ? { status: 'unknown', basis: 'undeclared', requirement: null, declarations: [] }
          : {
              status: name === 'mismatch' ? 'incompatible' : 'compatible',
              basis: 'manifest',
              requirement: '^0.1.2-alpha.2',
              declarations: [{ kind: 'peer', package: '@deepseek-ai/dsh-tools', range: '^0.1.2-alpha.2' }],
            }])),
      }),
    })

    render(<MarketSection {...props()} />)
    await screen.findByText('mismatch')
    await screen.findAllByText(en.hostRequirement.replace('{0}', '^0.1.2-alpha.2'))
    expect(screen.getByText(en.hostRequirementUndeclared)).toBeTruthy()
    expect(screen.getByText(en.hostRequirementUnavailable)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.filter }))
    fireEvent.click(screen.getByRole('menuitem', {
      name: en.hostCompatible.replace('{0}', '0.1.2-alpha.2'),
    }))
    await waitFor(() => {
      expect(screen.queryByText('mismatch')).toBeNull()
      expect(screen.getByText('matches')).toBeTruthy()
      expect(screen.getByText('undeclared')).toBeTruthy()
      expect(screen.getByText('github-only')).toBeTruthy()
    })
    expect(fetchCalls.some(call => call.path === '/dsh-market/discovery-compatibility'
      && call.method === 'POST'
      && Array.isArray((call.body as { packages?: unknown })?.packages))).toBe(true)
  })

  it('reports an unknown host version and does not enable a pretend compatibility filter', async () => {
    stubFetch({
      '/dsh-market/registry': { source: 'live', hostVersion: null, registry: REGISTRY },
      '/dsh-market/discovery-compatibility': (body: any) => ({
        hostVersion: null,
        plugins: Object.fromEntries(body.packages.map((name: string) => [name, {
          status: 'unknown',
          basis: 'manifest',
          requirement: '^0.1.2-alpha.2',
          declarations: [{ kind: 'engine', range: '^0.1.2-alpha.2' }],
        }])),
      }),
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: en.filter }))
    const unknown = screen.getByRole('menuitem', { name: en.hostUnknown })
    fireEvent.click(unknown)
    expect(screen.getByText('dsh-loop')).toBeTruthy()
    expect(screen.queryByText(/Filtering for DSH/)).toBeNull()
  })

  it('the install dialog opens with Confirm/Cancel and closes on cancel', async () => {
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getAllByRole('button', { name: en.install })[0])
    expect(await screen.findByRole('button', { name: en.confirmInstall })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    await waitFor(() => expect(screen.queryByRole('button', { name: en.confirmInstall })).toBeNull())
  })

  it('the install dialog reads the blurb as body text and keeps download methodology on the mark (#739)', async () => {
    const plugin = {
      name: 'dsh-loop', owner: 'alice', url: 'https://github.com/alice/dsh-loop',
      category: ['tools'], npm: 'dsh-loop', stars: 50, added: '2026-08-01', version: '1.2.3',
      downloads: 162500, downloadsStart: '2026-08-01', downloadsEnd: '2026-08-28', downloadsCheckedAt: '2026-08-28',
      description: { en: 'Loop task runner', zh: '循环执行' }, install: 'dsh plugin install dsh-loop',
      capabilities: ['network'],
    }
    const tip = downloadStatsText(plugin, key => en[key])!
    stubFetch({
      '/dsh-market/registry': {
        source: 'live',
        hostVersion: '0.1.2-alpha.2',
        registry: { ...REGISTRY, count: 1, plugins: [plugin] },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    // The card still uses the compact blurb. The methodology is not a paragraph.
    expect(screen.getByText('Loop task runner').classList.contains(css.desc)).toBe(true)
    expect(screen.queryByText(/Not lifetime downloads/)).toBeNull()
    expect(screen.queryByText('2026-08-01')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.install }))
    await screen.findByRole('button', { name: en.confirmInstall })

    const blurbs = screen.getAllByText('Loop task runner')
    expect(blurbs.some(el => el.classList.contains(css.desc))).toBe(true)
    const dialogBlurb = blurbs.find(el => el.classList.contains(css.confirmDesc))
    expect(dialogBlurb).toBeTruthy()
    expect(dialogBlurb!.classList.contains(css.desc)).toBe(false)

    const body = document.getElementsByClassName(css.confirmBody)[0] as HTMLElement
    const byline = body.getElementsByClassName(css.byline)[0] as HTMLElement
    expect(byline.textContent).toContain('alice')
    expect(byline.textContent).toContain('v1.2.3')
    expect(byline.textContent).toContain('162.5k')
    expect(byline.textContent).toContain('2026-08-01')
    expect(screen.getByTitle(en.published).textContent).toContain('2026-08-01')
    expect(screen.queryByText(`${en.published} 2026-08-01`)).toBeNull()

    expect(screen.queryByText(/Not lifetime downloads/)).toBeNull()
    const marks = screen.getAllByLabelText(tip)
    expect(marks.length).toBeGreaterThanOrEqual(1)
    expect(marks.every(el => el.tabIndex === 0)).toBe(true)

    expect(document.getElementsByClassName(css.confirmFold).length).toBe(1)
    expect(body.getElementsByClassName(css.confirmPanel).length).toBe(2)
    expect(screen.queryByText(en.installCaution)).toBeNull()
    expect(screen.getAllByText('Tools').length).toBeGreaterThanOrEqual(1)
  })

  const stubTerminalPlugin = () => stubFetch({
    '/dsh-market/registry': {
      source: 'live',
      hostVersion: '0.1.2-alpha.2',
      registry: {
        ...REGISTRY,
        count: 1,
        plugins: [{
          name: 'dsh-tui', owner: 'alice', url: 'https://github.com/alice/dsh-tui',
          category: 'tools', npm: null, stars: 1, added: '2026-08-01',
          description: { en: 'A terminal UI', zh: '终端界面' }, install: 'dsh plugin install dsh-tui',
          capabilities: ['shell'],
        }],
      },
    },
  })

  it('shows Before you install for a terminal plugin, with the guide link beside the startup line (#739)', async () => {
    stubTerminalPlugin()
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-tui')
    fireEvent.click(screen.getByRole('button', { name: en.install }))
    expect(await screen.findByText(en.installCaution)).toBeTruthy()
    expect(screen.getByText(en.terminalCautionTitle)).toBeTruthy()
    const link = screen.getByRole('link', { name: en.terminalCautionLink })
    expect(link.getAttribute('href')).toBe('https://github.com/alice/dsh-tui#readme')
    const foot = link.closest(`.${css.installCautionFoot}`)
    expect(foot).toBeTruthy()
    expect(foot?.textContent).toContain(en.terminalCautionStartup)
  })

  it('still shows the startup line when the description claims a CLI surface (#739, #931)', async () => {
    // #739 pinned "a description mentioning a CLI counts". #931 showed that
    // rule fires on web plugins whose repository happens to ship a CLI too,
    // so the evidence is now a phrase that asserts THIS plugin's surface —
    // here "CLI-only" instead of the old bare "Supports a CLI flag".
    stubFetch({
      '/dsh-market/registry': {
        source: 'live',
        hostVersion: '0.1.2-alpha.2',
        registry: {
          ...REGISTRY,
          count: 1,
          plugins: [{
            name: 'note-tool', owner: 'alice', url: 'https://github.com/alice/note-tool',
            category: 'tools', npm: null, stars: 1, added: '2026-08-01',
            description: { en: 'A CLI-only note tool', zh: '命令行工具，管理笔记' }, install: 'dsh plugin install note-tool',
          }],
        },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('note-tool')
    fireEvent.click(screen.getByRole('button', { name: en.install }))
    expect(await screen.findByText(en.terminalCautionTitle)).toBeTruthy()
    expect(screen.getByRole('link', { name: en.terminalCautionLink })).toBeTruthy()
    expect(screen.getByText(en.terminalCautionStartup)).toBeTruthy()
  })

  it('opens the next install dialog with both folds collapsed (#739)', async () => {
    stubTerminalPlugin()
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-tui')
    fireEvent.click(screen.getByRole('button', { name: en.install }))
    fireEvent.click(await screen.findByText(en.capabilityTitle))
    fireEvent.click(screen.getByText(en.cmdDetails))
    expect(screen.getByText(en.capShell)).toBeTruthy()
    expect(screen.getByText('dsh plugin install dsh-tui')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))

    fireEvent.click(screen.getByRole('button', { name: en.install }))
    await screen.findByText(en.capabilityTitle)
    expect(screen.queryByText(en.capShell)).toBeNull()
    expect(screen.queryByText('dsh plugin install dsh-tui')).toBeNull()
  })

  /** defineProperty is not covered by vi.unstubAllGlobals, so put the
   * originals back or the next test inherits this clipboard. */
  const stubCopy = (writeText: ReturnType<typeof vi.fn>, exec?: ReturnType<typeof vi.fn>) => {
    const prevClip = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const prevExec = Object.getOwnPropertyDescriptor(document, 'execCommand')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    if (exec !== undefined) Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: exec })
    return () => {
      if (prevClip !== undefined) Object.defineProperty(navigator, 'clipboard', prevClip)
      else Reflect.deleteProperty(navigator, 'clipboard')
      if (exec !== undefined) {
        if (prevExec !== undefined) Object.defineProperty(document, 'execCommand', prevExec)
        else Reflect.deleteProperty(document, 'execCommand')
      }
    }
  }

  it('copies the install command from its icon (#739)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const restore = stubCopy(writeText)
    try {
      stubTerminalPlugin()
      render(<MarketSection {...props()} />)
      await screen.findByText('dsh-tui')
      fireEvent.click(screen.getByRole('button', { name: en.install }))
      fireEvent.click(await screen.findByText(en.cmdDetails))
      const copy = screen.getByRole('button', { name: en.cmdCopy })
      fireEvent.click(copy)
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('dsh plugin install dsh-tui'))
      expect(await screen.findByRole('status')).toHaveProperty('textContent', en.cmdCopied)
      expect(document.activeElement).toBe(copy)
    } finally {
      restore()
    }
  })

  it('falls back to execCommand inside the click when writeText rejects (#739)', async () => {
    let copiedDuringClick = false
    const writeText = vi.fn().mockImplementation(() => {
      expect(copiedDuringClick).toBe(true)
      return Promise.reject(new Error('denied'))
    })
    const exec = vi.fn(() => {
      copiedDuringClick = true
      return true
    })
    const restore = stubCopy(writeText, exec)
    try {
      stubTerminalPlugin()
      render(<MarketSection {...props()} />)
      await screen.findByText('dsh-tui')
      fireEvent.click(screen.getByRole('button', { name: en.install }))
      fireEvent.click(await screen.findByText(en.cmdDetails))
      const copy = screen.getByRole('button', { name: en.cmdCopy })
      fireEvent.click(copy)
      expect(await screen.findByRole('status')).toHaveProperty('textContent', en.cmdCopied)
      expect(exec).toHaveBeenCalledWith('copy')
      expect(document.activeElement).toBe(copy)
    } finally {
      restore()
    }
  })

  it('does not show copied when the clipboard and execCommand both fail (#739)', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    const exec = vi.fn(() => false)
    const restore = stubCopy(writeText, exec)
    try {
      stubTerminalPlugin()
      render(<MarketSection {...props()} />)
      await screen.findByText('dsh-tui')
      fireEvent.click(screen.getByRole('button', { name: en.install }))
      fireEvent.click(await screen.findByText(en.cmdDetails))
      const copy = screen.getByRole('button', { name: en.cmdCopy })
      fireEvent.click(copy)
      await waitFor(() => expect(writeText).toHaveBeenCalled())
      expect(screen.queryByRole('status')).toBeNull()
      expect(exec).toHaveBeenCalledWith('copy')
      expect(document.activeElement).toBe(copy)
    } finally {
      restore()
    }
  })

  it('offers the release a hold kept back, and installs it when asked (#635)', async () => {
    let installs = 0
    stubFetch({
      '/dsh-market/install': () => {
        installs += 1
        return installs === 1
          ? { ok: true, hot: false, heldRelease: { latest: '2.0.0', installed: '1.0.0', because: 'minimumReleaseAge' } }
          : { ok: true, hot: false }
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getAllByRole('button', { name: en.install })[0])
    fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))

    await waitFor(() => expect(fetchCalls.filter(c => c.path === '/dsh-market/install').length).toBe(1))
    // Open the Tasks panel: that is where a record lives once it settles.
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(en.opTitle) }))

    // A success with a caveat, not a failure: the plugin IS installed, so the
    // row keeps its ✓ and says which release the profile held back.
    const notice = en.heldReleaseNotice.replace('{0}', '2.0.0').replace('{1}', '1.0.0')
    await waitFor(() => {
      const panel = document.querySelector('[class*="opPanel"]')
      expect(panel, 'the Tasks panel did not open').toBeTruthy()
      expect(panel!.textContent).toContain(notice)
    })

    fireEvent.click(screen.getByRole('button', { name: en.heldReleaseAction.replace('{0}', '2.0.0') }))
    await waitFor(() => {
      const posts = fetchCalls.filter(call => call.path === '/dsh-market/install')
      expect(posts.length).toBe(2)
      // The click is what carries the intent the server refuses to assume.
      expect(posts[1]?.body).toMatchObject({ force: true })
    })
  })

  it('offers the newest release this host supports, and installs THAT one (#581)', async () => {
    let installs = 0
    stubFetch({
      '/dsh-market/install': () => {
        installs += 1
        return installs === 1
          ? { __status: 400, hostIncompatible: { name: 'dsh-loop', npmName: 'dsh-loop', version: '2.0.0', requirement: '>=0.1.7', hostVersion: '0.1.5-rc.3' } }
          : { ok: true, hot: false }
      },
      '/dsh-market/find-compatible': { compatibleVersion: '1.2.0', upgradeOnly: false },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getAllByRole('button', { name: en.install })[0])
    fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))

    // The refusal states the way out in the same breath: a version that
    // declares this host, named on the button that acts on it.
    // A regex: the dialog's description carries the refusal AND the way out
    // in one text node, so an exact-string matcher can never see the second
    // line on its own.
    await screen.findByText(/You can install 1\.2\.0/)
    fireEvent.click(screen.getByRole('button', { name: en.hostIncompatibleInstallCompat.replace('{version}', '1.2.0') }))

    await waitFor(() => {
      const posts = fetchCalls.filter(call => call.path === '/dsh-market/install')
      expect(posts.length).toBe(2)
      // Pinned to the version that was found, and NOT forced: the user took
      // the safe road, and the route judges the release it is given.
      expect(posts[1]?.body).toMatchObject({ version: '1.2.0' })
      expect((posts[1]?.body as { force?: boolean }).force).toBeUndefined()
    })
  })

  it('says so when nothing declares this host, instead of offering a dead end (#581)', async () => {
    stubFetch({
      '/dsh-market/install': { __status: 400, hostIncompatible: { name: 'dsh-loop', npmName: 'dsh-loop', version: '2.0.0', requirement: '>=0.1.7', hostVersion: '0.1.5-rc.3' } },
      '/dsh-market/find-compatible': { compatibleVersion: null, upgradeOnly: false },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getAllByRole('button', { name: en.install })[0])
    fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))

    await screen.findByText(/No version declares support for this DSH/)
    // The gamble is still there, and still the ghost of the three.
    expect(screen.getByRole('button', { name: en.hostIncompatibleInstallAnyway })).toBeTruthy()
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

  it('preserves README media for the same catalog generation and refreshes a newer one (#439)', async () => {
    const pluginUrl = 'https://github.com/bob/dsh-notify'
    const readmeUrl = 'https://raw.githubusercontent.com/bob/dsh-notify/HEAD/README.md'
    const oldShot = 'https://raw.githubusercontent.com/bob/dsh-notify/HEAD/assets/old.png'
    const newShot = 'https://raw.githubusercontent.com/bob/dsh-notify/HEAD/assets/new.png'
    let registryCalls = 0
    let readmeCalls = 0
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const path = String(url).split('?')[0]
      if (path === '/dsh-market/registry') {
        registryCalls += 1
        const registry = JSON.parse(JSON.stringify(REGISTRY))
        const sameGeneration = registryCalls <= 2
        registry.updated = sameGeneration ? '2026-09-03T00:00:00Z' : '2026-09-03T01:00:00Z'
        registry.plugins = [{
          ...registry.plugins[1],
          url: pluginUrl,
          category: 'theme',
          description: {
            en: registryCalls === 1
              ? 'First catalog generation'
              : registryCalls === 2 ? 'Same catalog generation' : 'Second catalog generation',
            zh: '',
          },
        }]
        return Promise.resolve(new Response(JSON.stringify({ source: 'live', registry }), { status: 200 }))
      }
      const payload =
        path === '/dsh-market/installed' ? { profile: 'web', installed: {}, live: [], disabled: [] }
        : path === '/dsh-market/status' ? { active: false, pnpm: true, boot: 'boot-1', installed: {} }
        : path === '/dsh-market/updates' ? { updates: {} }
        : null
      if (payload !== null) return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
      if (path === readmeUrl) {
        readmeCalls += 1
        const filename = readmeCalls === 1 ? 'old.png' : 'new.png'
        return Promise.resolve(new Response(`## Screenshots\n![Plugin screenshot](assets/${filename})`, { status: 200 }))
      }
      return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
    }))
    class ProbeImage {
      naturalWidth = 427
      naturalHeight = 240
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      referrerPolicy = ''
      decoding = ''
      set src(_value: string) { queueMicrotask(() => this.onload?.()) }
    }
    vi.stubGlobal('Image', ProbeImage)
    const themeSnapshot = { preference: 'light', themes: [] as Array<{ id: string }> }
    const componentProps = {
      ...props(),
      themeStore: { subscribe: () => () => {}, getSnapshot: () => themeSnapshot },
    }

    const installButton = () => {
      let card: HTMLElement | null = screen.getByText('dsh-notify')
      while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
        card = card.parentElement
      }
      return within(card!).getByRole('button', { name: en.install })
    }
    const dialogHasShot = (shot: string) => {
      const encoded = encodeURIComponent(shot.replace(/^https?:\/\//, ''))
      return [...screen.getByRole('dialog').querySelectorAll('img')]
        .some(image => image.src.includes(encoded))
    }

    const closeDialog = async () => {
      fireEvent.click(screen.getByRole('button', { name: en.cancel }))
      await waitFor(() => expect(screen.queryByRole('button', { name: en.confirmInstall })).toBeNull())
    }
    const themeCoverHasShot = (shot: string) => {
      const encoded = encodeURIComponent(shot.replace(/^https?:\/\//, ''))
      return screen.getByRole('button', { name: `${en.themePreview} dsh-notify` })
        .querySelector('img')?.src.includes(encoded) === true
    }

    const first = render(<MarketSection {...componentProps} />)
    await screen.findByText('First catalog generation')
    fireEvent.click(installButton())
    await screen.findByRole('button', { name: en.confirmInstall })
    await waitFor(() => expect(dialogHasShot(oldShot)).toBe(true))
    await closeDialog()

    // Opening the same dialog again within one catalog generation is still
    // a cache hit; accepting a new catalog is the invalidation boundary.
    fireEvent.click(installButton())
    await screen.findByRole('button', { name: en.confirmInstall })
    await waitFor(() => expect(dialogHasShot(oldShot)).toBe(true))
    expect(readmeCalls).toBe(1)
    await closeDialog()
    fireEvent.click(screen.getAllByRole('button', { name: en.tabThemes })[0]!)
    await waitFor(() => expect(themeCoverHasShot(oldShot)).toBe(true))
    first.unmount()

    // A successful reload of the same generation preserves both caches.
    const same = render(<MarketSection {...componentProps} />)
    await screen.findByText('Same catalog generation')
    fireEvent.click(installButton())
    await screen.findByRole('button', { name: en.confirmInstall })
    await waitFor(() => expect(dialogHasShot(oldShot)).toBe(true))
    expect(readmeCalls).toBe(1)
    await closeDialog()
    fireEvent.click(screen.getAllByRole('button', { name: en.tabThemes })[0]!)
    await waitFor(() => expect(themeCoverHasShot(oldShot)).toBe(true))
    same.unmount()

    render(<MarketSection {...componentProps} />)
    await screen.findByText('Second catalog generation')
    fireEvent.click(installButton())
    await screen.findByRole('button', { name: en.confirmInstall })
    await waitFor(() => expect(dialogHasShot(newShot)).toBe(true))
    expect(dialogHasShot(oldShot)).toBe(false)
    await closeDialog()
    fireEvent.click(screen.getAllByRole('button', { name: en.tabThemes })[0]!)
    await waitFor(() => expect(themeCoverHasShot(newShot)).toBe(true))
    expect(themeCoverHasShot(oldShot)).toBe(false)
    expect(registryCalls).toBe(3)
    expect(readmeCalls).toBe(2)
  })

  it('falls through bad raw routes, rejects a 200 HTML error page, and reuses the winner', async () => {
    setGithubRoutes({
      raw: ['https://bad.example', 'https://html.example', null],
      avatar: [null],
    })
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.startsWith('https://bad.example/')) return new Response('down', { status: 502 })
      if (url.startsWith('https://html.example/')) {
        return new Response('<html><title>proxy error</title></html>', {
          status: 200, headers: { 'content-type': 'text/html' },
        })
      }
      return new Response('# plugin\n![preview](assets/demo.png)', {
        status: 200, headers: { 'content-type': 'text/plain' },
      })
    }))

    const first = await pluginScreenshotCandidates({
      name: 'one', owner: 'alice', url: 'https://github.com/alice/one', screenshots: [],
    } as never)
    expect(first[0]?.src).toBe('https://raw.githubusercontent.com/alice/one/HEAD/assets/demo.png')
    expect(calls).toHaveLength(3)

    calls.length = 0
    resetScreenshotsCache()
    await pluginScreenshotCandidates({
      name: 'two', owner: 'alice', url: 'https://github.com/alice/two', screenshots: [],
    } as never)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe('https://raw.githubusercontent.com/alice/two/HEAD/README.md')
  })

  it('times out one hung README route without consuming the direct fallback', async () => {
    vi.useFakeTimers()
    try {
      setGithubRoutes({ raw: ['https://hung.example', null], avatar: [null] })
      let attempts = 0
      vi.stubGlobal('fetch', vi.fn((_input: string | URL, init?: RequestInit) => {
        attempts++
        if (attempts === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
          })
        }
        return Promise.resolve(new Response('# plugin\n![preview](assets/demo.png)', { status: 200 }))
      }))
      const pending = pluginScreenshotCandidates({
        name: 'timeout', owner: 'alice', url: 'https://github.com/alice/timeout', screenshots: [],
      } as never)
      await vi.advanceTimersByTimeAsync(6000)
      await expect(pending).resolves.toHaveLength(1)
      expect(attempts).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('tries avatar routes in order and remembers the one that loads', () => {
    setGithubRoutes({ raw: [null], avatar: ['https://bad.example', 'https://good.example', null] })
    const first = render(<OwnerAvatar name="dsh-loop" owner="alice" />)
    let avatar = first.container.querySelector('img')!
    expect(avatar.src).toContain('https://bad.example/https://avatars.githubusercontent.com/alice')
    fireEvent.error(avatar)
    avatar = first.container.querySelector('img')!
    expect(avatar.src).toContain('https://good.example/https://avatars.githubusercontent.com/alice')
    fireEvent.load(avatar)
    first.unmount()

    const second = render(<OwnerAvatar name="dsh-notify" owner="bob" />)
    avatar = second.container.querySelector('img')!
    expect(avatar.src).toContain('https://good.example/https://avatars.githubusercontent.com/bob')
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

  it('keeps the Tasks entry wrapped so opening the panel does not shift the tab row', async () => {
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    const entry = await screen.findByRole('button', { name: new RegExp(`^${en.opTitle}$`) })
    const wrapBefore = entry.parentElement
    expect(wrapBefore?.className, 'idle Tasks entry must sit in .opWrap for stable tab-row spacing').toMatch(/opWrap/)
    fireEvent.click(entry)
    await screen.findByText(en.opEmpty)
    expect(entry.parentElement, 'opening the panel must not drop the .opWrap wrapper').toBe(wrapBefore)
    expect(entry.parentElement?.className).toMatch(/opWrap/)
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

  it('shows a fresh release as waiting instead of offering a failing update (#945)', async () => {
    // The official Desktop cannot bypass minimumReleaseAge, so an update
    // offered inside the window is a button that fails by construction. The
    // row says when it opens instead.
    const until = new Date(Date.now() + 5 * 3_600_000).toISOString()
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-market/updates': {
        updates: {
          'dsh-loop': {
            kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0',
            updateAvailable: false, heldUpdate: { latest: '1.2.0', until },
          },
        },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))

    expect(await screen.findByText(en.updateHeldTag)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.update })).toBeNull()
  })

  it('marks a hold the registry could not timestamp as estimated (#961)', async () => {
    // Mid-sync the mirror answers /latest but not the packument entry; the
    // market holds anyway and says it is a guess, rather than claiming a
    // window it cannot know.
    const until = new Date(Date.now() + 25 * 60_000).toISOString()
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-market/updates': {
        updates: {
          'dsh-loop': {
            kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0',
            updateAvailable: false, heldUpdate: { latest: '1.2.0', until, estimated: true },
          },
        },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))

    const tag = await screen.findByText(en.updateHeldTag)
    expect(tag.getAttribute('title')).toMatch(/mirror|镜像/)
    expect(tag.getAttribute('title')).toMatch(/minute|分钟/)
    expect(screen.queryByRole('button', { name: en.update })).toBeNull()
  })

  it('names a newer prerelease instead of "up to date", and installs that exact version (#867)', async () => {
    // The pinned install is AHEAD of npm's `latest` (0.2.1-alpha.2 vs
    // 0.1.5-alpha.2), which means the reader follows a line `latest` does not
    // name. "Up to date" is true against the tag and false for them, so the
    // card says which build their line published and leaves the click to them.
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '0.2.1-alpha.2' }, live: [] },
      '/dsh-market/updates': {
        updates: {
          'dsh-loop': {
            kind: 'npm', version: '0.2.1-alpha.2', current: '0.2.1-alpha.2',
            latest: '0.1.5-alpha.2', updateAvailable: false, newerPrerelease: '0.2.1-alpha.4',
          },
        },
      },
      '/dsh-market/update': { ok: true, activation: {} },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(await screen.findByText(re(en.newerPrereleaseAvailable.replace('{0}', '0.2.1-alpha.4')))).toBeTruthy()
    expect(screen.queryByText(en.upToDate)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.install }))
    await waitFor(() => {
      const update = fetchCalls.find(call => call.path === '/dsh-market/update')
      expect(update, 'the install never asked the update route').toBeTruthy()
      expect(update!.body).toMatchObject({ name: 'dsh-loop', compatVersion: '0.2.1-alpha.4' })
    })
  })

  it('re-enables Restart now when a completed update leaves the last status poll busy (#440)', async () => {
    vi.useFakeTimers()
    try {
      let operationStarted = false
      let updateSettled = false
      let busyStatusObserved = false
      let resolveUpdate!: (response: Response) => void
      const updateResponse = new Promise<Response>((resolve) => { resolveUpdate = resolve })

      vi.stubGlobal('fetch', vi.fn((url: string) => {
        const path = String(url).split('?')[0]
        if (path === '/dsh-market/update') {
          operationStarted = true
          return updateResponse
        }
        const payload =
          path === '/dsh-market/registry' ? { source: 'live', registry: REGISTRY }
          : path === '/dsh-market/installed' ? {
              profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [], disabled: [], groups: {}, groupOrder: [],
            }
          : path === '/dsh-market/status' ? (() => {
              const busy = operationStarted && !updateSettled
              if (busy) busyStatusObserved = true
              return {
                active: busy, busy, pnpm: true, boot: 'boot-1', restart: true,
                installed: { 'dsh-loop': '^1.0.0' },
              }
            })()
          : path === '/dsh-market/updates' ? {
              updates: {
                'dsh-loop': {
                  kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true,
                },
              },
            }
          : null
        if (payload === null) return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
      }))

      render(<MarketSection {...props()} />)
      await vi.waitFor(() => { screen.getByText('dsh-loop') })
      fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
      await vi.waitFor(() => { screen.getByRole('button', { name: en.update }) })
      fireEvent.click(screen.getByRole('button', { name: en.update }))

      // Observe the route-level mutation lock while the request is in flight.
      // The successful response then arrives before another status poll can
      // publish busy=false, which is the real ordering reported in #440.
      await vi.advanceTimersByTimeAsync(2100)
      expect(busyStatusObserved).toBe(true)
      updateSettled = true
      resolveUpdate(new Response(JSON.stringify({
        ok: true,
        activation: {
          'dsh-loop': { state: 'restart', hot: false, bundle: true, reasons: ['restart to apply'] },
        },
      }), { status: 200 }))

      await vi.waitFor(() => {
        expect(screen.getAllByText(re(en.restartBanner)).length).toBeGreaterThan(0)
      })
      expect((screen.getByRole('button', { name: en.restartNow }) as HTMLButtonElement).disabled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('labels a plugin loaded by the user\'s own setup as such, not as inactive (#813)', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [],
        activation: { 'dsh-loop': { state: 'inert', loadedByProfile: true, hot: false, bundle: true, reasons: ['loaded by your setup'] } },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    // A fact about where it comes from, not news: no warning chip, and the
    // reason stays one click away like every non-live row's.
    await screen.findByText(en.actWhy)
    expect(screen.queryByText(en.stateInert)).toBeNull()
    expect(screen.queryByText(re(en.restartBanner))).toBeNull()
  })

  it('does not list a plain dependency as a plugin, nor offer to uninstall it (#857)', async () => {
    // The reported shape: zustand / bufferutil / utf-8-validate sit in
    // node_modules because other plugins need them, and the installed list
    // rendered each one as a card whose uninstall button really removes it.
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web', installed: { 'dsh-loop': '^1.0.0', zustand: '^5.0.15' }, live: [], disabled: [],
        activation: {
          'dsh-loop': { state: 'live', hot: true, bundle: true, reasons: ['live via its bundle patch'] },
          zustand: { state: 'inert', dependencyOf: 'dsh-loop', hot: false, bundle: false, reasons: ['a plain dependency with no dsh metadata'] },
        },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    // Counted, so a shorter list does not read as packages going missing...
    await screen.findByText(en.installedDependencyNote.replace('{0}', '1'))
    // ...but not listed, and therefore with no uninstall path to find.
    expect(screen.queryByText('zustand')).toBeNull()
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

  it('shows a failed update instead of leaving the row unchanged (#448)', async () => {
    // #448: the update failed (pnpm exit 1), the profile was rolled back,
    // log.ndjson recorded both — and the card said nothing, so the user
    // pressed update again. Whatever else happens, a failure has to be
    // visible on the surface the user is looking at.
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-market/updates': { updates: { 'dsh-loop': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
      '/dsh-market/update': { ok: false, error: 'ERR_PNPM_PREPARE_PACKAGE: the build script failed' },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('button', { name: en.update }))

    const banner = await screen.findByText(/ERR_PNPM_PREPARE_PACKAGE/)
    expect(banner).toBeTruthy()
    expect(banner.textContent).toContain('dsh-loop')
  })

  it('shows the route\'s sentence whole — the old 600-character tail cut its Chinese half off (#848)', async () => {
    // The market writes its diagnosis as one bilingual sentence: Chinese
    // first, then English. The row kept the LAST 600 characters of what it
    // had, so a message longer than that arrived as its English tail with the
    // half a Chinese reader needs already gone — for the classifier's
    // `unused-patch` sentence (771 characters) the Chinese was cut inside its
    // first clause, and with it the two ways out.
    // Referentially stable, like LOCALE_SNAPSHOT: useSyncExternalStore reads a
    // fresh object as a change on every render and loops until React throws.
    const ZH = { active: 'zh' }
    const message = 'profile 里的 pnpm 补丁有一条已经用不上了（dsh-loop@1.1.0）：patchedDependencies 是按「包名@精确版本」钉的，而这次要装的版本已经越过它，pnpm 12 因此判定整条命令失败——它什么都没写，所以看起来像「点了更新没反应」。要么把补丁更新到新版本、并把 profile package.json 里 pnpm.patchedDependencies 的键改成「包名@新版本」，要么在新版本已经自带这个修复时直接删掉这一条和对应的补丁文件 / a pnpm patch in this profile is no longer used (dsh-loop@1.1.0): patchedDependencies keys on "package@exactVersion", and the version being installed has moved past that key, so pnpm 12 fails the WHOLE command and writes nothing at all — which is why the update looks like it simply did not apply. Either retarget the patch to the new version and change its pnpm.patchedDependencies key in the profile\'s package.json to "package@newVersion", or — when the new release already carries that fix — drop the entry and its patch file'
    // Meaningful only while the message is longer than the window that used to
    // clip it: shorten the fixture and this test stops testing anything.
    expect(message.length).toBeGreaterThan(600)
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-market/updates': { updates: { 'dsh-loop': { kind: 'npm', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
      '/dsh-market/update': { ok: false, error: message, stderr: 'ERR_PNPM_UNUSED_PATCH\n    at resolveDependencies2 (pnpm.mjs:177458:5)' },
    })
    render(<MarketSection {...props()} locale={{ subscribe: () => () => {}, getSnapshot: () => ZH }} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('button', { name: en.update }))

    // The opening clause AND the clause that says what to do: a tail clip kept
    // neither, and the row must not fall back to pnpm's stack either.
    const shown = await screen.findByText(/pnpm 补丁有一条已经用不上了/)
    expect(shown.textContent).toContain('直接删掉这一条和对应的补丁文件')
    expect(shown.textContent).not.toContain('resolveDependencies2')
  })

  it('a busy-agent update response queues instead of naming the running agent', async () => {
    // Queue-era: a 409 agentsBusy update becomes a `queued` record the drain
    // runs when agents go idle — the old "names the agent in a failure" copy
    // is replaced by the queue copy.
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
    // Queued, not failed: the record line carries the queue copy (with the
    // position suffix), so assert on the panel text rather than one element.
    await waitFor(() => {
      const panel = document.querySelector('[class*="opPanel"]')
      expect(panel, 'the Tasks panel did not open').toBeTruthy()
      expect(panel!.textContent).toContain(en.opQueued)
    })
    expect(screen.queryByText(en.busyWait)).toBeNull()
  })

  it.each(['update', 'uninstall'] as const)('confirms a queued %s only after the risk modal, without leaking consent (#779)', async kind => {
    for (const wording of ['会话', '中途报错', '取消']) expect(zh.agentsRunningRisk).toContain(wording)
    for (const wording of ['sessions', 'fail mid-turn', 'Cancel']) expect(en.agentsRunningRisk).toContain(wording)
    const path = `/dsh-market/${kind}`
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-market/updates': { updates: { 'dsh-loop': { kind: 'npm', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
      '/dsh-market/status': { active: false, busy: false, pnpm: true, boot: 'boot-1', restart: true, installed: {}, runningAgents: ['main'] },
      [path]: { ok: false, agentsBusy: true, runningAgents: ['main'], __status: 409 },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    if (kind === 'update') {
      fireEvent.click(await screen.findByRole('button', { name: en.update }))
    } else {
      await openRowMenu('dsh-loop')
      fireEvent.click(await screen.findByRole('menuitem', { name: en.uninstall }))
      fireEvent.click(await screen.findByRole('button', { name: en.uninstall }))
    }
    const posts = () => fetchCalls.filter(call => call.path === path && call.method === 'POST')
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0]!.body).toEqual({ name: 'dsh-loop' })
    const label = kind === 'update' ? en.opUpdateNow : en.opUninstallNow
    fireEvent.click(await screen.findByRole('button', { name: label }))
    const dialog = await screen.findByRole('dialog', { name: re(en.agentsRunningConfirm) })
    expect(within(dialog).getByText(en.agentsRunningRisk)).toBeTruthy()
    expect(posts()).toHaveLength(1)
    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: re(en.agentsRunningConfirm) })).toBeNull())
    expect(posts()).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: label }))
    const reopened = await screen.findByRole('dialog', { name: re(en.agentsRunningConfirm) })
    fireEvent.click(within(reopened).getByRole('button', { name: label }))
    await waitFor(() => expect(posts()).toHaveLength(2))
    expect(posts()[1]!.body).toEqual({ name: 'dsh-loop', confirmAgentsRunning: true })
    await waitFor(() => expect(JSON.parse(localStorage.getItem('dshm-queue-v1') ?? '[]')).toEqual([
      expect.objectContaining({ kind, name: 'dsh-loop' }),
    ]))
    expect(localStorage.getItem('dshm-queue-v1')).not.toContain('confirmAgentsRunning')
    // Even a re-queued confirmed request needs a new decision next time.
    fireEvent.click(await screen.findByRole('button', { name: label }))
    await screen.findByRole('dialog', { name: re(en.agentsRunningConfirm) })
    expect(posts()).toHaveLength(2)
  })

  it('preserves queued update force, restore and compatVersion through busy confirmation (#779)', async () => {
    const updateOptions = { force: true, restore: true, compatVersion: '1.1.0' }
    localStorage.setItem('dshm-queue-v1', JSON.stringify([{ kind: 'update', name: 'dsh-loop', updateOptions }]))
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': 'link:../dsh-loop' }, live: [] },
      '/dsh-market/updates': { updates: { 'dsh-loop': { kind: 'linked', updateAvailable: false } } },
      '/dsh-market/status': { active: false, busy: false, pnpm: true, boot: 'boot-1', restart: true, installed: {}, runningAgents: ['main'] },
      '/dsh-market/update': { ok: true, activation: {} },
    })
    render(<MarketSection {...props()} />)
    await screen.findAllByText('dsh-loop')
    const runNow = await screen.findByRole('button', { name: en.opUpdateNow })
    expect(JSON.parse(localStorage.getItem('dshm-queue-v1') ?? '[]')).toEqual([
      expect.objectContaining({ kind: 'update', name: 'dsh-loop', updateOptions }),
    ])
    expect(localStorage.getItem('dshm-queue-v1')).not.toContain('confirmAgentsRunning')
    fireEvent.click(runNow)
    const dialog = await screen.findByRole('dialog', { name: re(en.agentsRunningConfirm) })
    expect(fetchCalls.filter(call => call.path === '/dsh-market/update')).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: en.opUpdateNow }))
    await waitFor(() => expect(fetchCalls).toContainEqual({
      path: '/dsh-market/update', method: 'POST',
      body: { name: 'dsh-loop', ...updateOptions, confirmAgentsRunning: true },
    }))
  })

  it('queues an install when agents are busy instead of failing it', async () => {
    // Agents-busy is a queue, not a failure: the 409 becomes a `queued`
    // record the drain runs once agents go idle, and the card shows the
    // queued badge rather than the clash/failure marker.
    stubFetch({
      '/dsh-market/install': {
        ok: false,
        agentsBusy: true,
        runningAgents: ['main'],
        error: 'agents are running',
        __status: 409,
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    const installButtons = screen.getAllByRole('button', { name: en.install })
    fireEvent.click(installButtons[0]!)
    fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))
    // The queued record lands in the Tasks panel with its queued line…
    // (the entry reads "Installing 0/1" while one record is queued, and both
    // the row status and the card badge say "Queued").
    // The 409 handler opens the panel itself; just wait for the queued rows.
    await waitFor(() => {
      const panel = document.querySelector('[class*="opPanel"]')
      expect(panel, 'the Tasks panel did not open').toBeTruthy()
      expect(panel!.textContent).toContain(en.opQueued)
    })
    // …and the card answers "queued" instead of "cannot install".
    // (getAllBy: both the panel row status and the card badge render it.)
    expect((await screen.findAllByText(en.queuedBadge)).length).toBeGreaterThan(0)
    expect(screen.queryByText(en.opBlockedCard)).toBeNull()
  })

  it('says what is holding a queued row, and does not claim to be installing (#752)', async () => {
    // The row said only "Queued · ahead: N", which reads as an operation that
    // is merely last in line — and the entry above it said "Installing 0/1",
    // a contradiction the reader cannot resolve: nothing is installing, and
    // the guard will not let it start until the running work ends.
    stubFetch({
      '/dsh-market/install': {
        ok: false,
        agentsBusy: true,
        runningAgents: ['session-a', 'session-b', 'session-c'],
        error: 'agents are running',
        __status: 409,
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    const installButtons = screen.getAllByRole('button', { name: en.install })
    fireEvent.click(installButtons[0]!)
    fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))
    await waitFor(() => {
      const panel = document.querySelector('[class*="opPanel"]')
      expect(panel, 'the Tasks panel did not open').toBeTruthy()
      // The blocker, with the count the host named…
      expect(panel!.textContent).toContain(en.opQueuedWaitingAgents.replace('{0}', '3'))
      // …and the batch line names the wait instead of "Installing 0/1".
      expect(panel!.textContent).toContain(en.opWaitingAgents.replace('{0}', '1'))
      expect(panel!.textContent).not.toContain(`${en.opInstalling} 0/`)
      expect(panel!.textContent).toContain(en.opLeaveHintAgents)
    })
  })

  it('retries a legacy busy-agent install on "run now" without risk confirmation (#779)', async () => {
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      const path = String(input).split('?')[0]
      const method = (init?.method ?? 'GET').toUpperCase()
      if (path === '/dsh-market/registry') {
        return Promise.resolve(new Response(JSON.stringify({ source: 'live', registry: REGISTRY }), { status: 200 }))
      }
      if (path === '/dsh-market/installed') {
        return Promise.resolve(new Response(JSON.stringify({ profile: 'web', installed: {}, live: [] }), { status: 200 }))
      }
      if (path === '/dsh-market/updates') {
        return Promise.resolve(new Response(JSON.stringify({ updates: {} }), { status: 200 }))
      }
      if (path === '/dsh-market/status') {
        return Promise.resolve(new Response(JSON.stringify({
          active: false, busy: false, pnpm: true, boot: 'boot-1', restart: true, installed: {},
          runningAgents: ['session-a', 'session-b'],
        }), { status: 200 }))
      }
      if (path === '/dsh-market/install' && method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({
          ok: false, agentsBusy: true, runningAgents: ['session-a', 'session-b'], error: 'agents are running',
        }), { status: 409 }))
      }
      return Promise.reject(new Error(`unstubbed fetch: ${String(input)}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      localStorage.clear()
      render(<MarketSection {...props()} />)
      await screen.findByText('dsh-loop')
      const installButtons = screen.getAllByRole('button', { name: en.install })
      fireEvent.click(installButtons[0]!)
      fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))
      const runNow = await screen.findByRole('button', { name: en.opRunNow })
      const before = fetchMock.mock.calls.filter(([url, init]) =>
        String(url).endsWith('/dsh-market/install') && (init?.method ?? 'GET').toUpperCase() === 'POST',
      ).length

      fireEvent.click(runNow)

      await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) =>
        String(url).endsWith('/dsh-market/install') && (init?.method ?? 'GET').toUpperCase() === 'POST',
      )).toHaveLength(before + 1))
      expect(screen.queryByRole('dialog', { name: re(en.agentsRunningConfirm) })).toBeNull()
      expect(screen.queryByText(en.queuedRunBlocked.replace('{0}', '2'))).toBeNull()
      expect(document.querySelector('[class*="opPanel"]')!.textContent).toContain(en.opQueued)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not refuse "run now" with the busy sample from the operation that just ended (#845 review)', async () => {
    // liuwenji007's finding on #845: the settle branch cleared `hostBusy` but
    // left `statusRef.current.busy` as sampled DURING that operation, and
    // #845's own change removed the idle poll that used to correct it within
    // 2 s. The reproducer's shape: finish an update, queue the next one while
    // an agent is running, click 立即执行 — and be told 「另一个安装、更新或卸载还在进行」
    // about a host that is idle (clicking again 2 s later works, because the
    // drain's next tick refreshes the ref).
    let statusCalls = 0
    let installPosts = 0
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      const path = String(input).split('?')[0]
      const method = (init?.method ?? 'GET').toUpperCase()
      const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))
      if (path === '/dsh-market/registry') return json({ source: 'live', registry: REGISTRY, hostVersion: '0.1.2-alpha.2' })
      if (path === '/dsh-market/installed') return json({ profile: 'web', installed: {}, live: [], disabled: [], groups: {}, groupOrder: [], favorites: [], blocked: [] })
      if (path === '/dsh-market/updates') return json({ updates: {} })
      if (path === '/dsh-market/status') {
        statusCalls += 1
        // The only sample that ever lands is the one taken WHILE the install
        // runs. Everything after that hangs, so nothing can quietly refresh
        // the ref — which is the state the report describes.
        return statusCalls === 1
          ? json({ active: true, busy: true, pnpm: true, boot: 'boot-1', restart: true, installed: {} })
          : new Promise<Response>(() => { /* no further sample */ })
      }
      if (path === '/dsh-market/install' && method === 'POST') {
        installPosts += 1
        if (installPosts === 1) {
          // Slow enough that the 2 s progress poll samples it, then it settles
          // on its own response.
          return new Promise<Response>(resolve => {
            setTimeout(() => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })), 2300)
          })
        }
        if (installPosts === 2) {
          // The second install is refused because a session is running, so its
          // row goes to the queue with a 立即执行 button.
          return json({ ok: false, agentsBusy: true, runningAgents: ['session-a'], error: 'agents are running' }, 409)
        }
        return json({ ok: true })
      }
      return Promise.reject(new Error(`unstubbed fetch: ${String(input)}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      localStorage.clear()
      render(<MarketSection {...props()} />)
      await screen.findByText('dsh-loop')

      // One install, sampled busy while it runs, settled by its own response.
      fireEvent.click(screen.getAllByRole('button', { name: en.install })[0]!)
      fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))
      await waitFor(() => expect(statusCalls).toBeGreaterThan(0), { timeout: 5000 })
      // Let the install settle (its own response, 2.3 s) — the card's button
      // is disabled until then, which is why the next click waits.
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 2600)) })

      // The next one is refused for the running session -> queued row.
      fireEvent.click(screen.getAllByRole('button', { name: en.install })[1]!)
      fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))
      const runNow = await screen.findByRole('button', { name: en.opRunNow }, { timeout: 5000 })

      const before = installPosts
      fireEvent.click(runNow)

      await waitFor(() => expect(installPosts).toBe(before + 1))
      expect(screen.queryByText(en.queuedRunBusy)).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the other rows queued when a batch of "run now" is clicked at once (#775)', async () => {
    // Reported: four installs sat queued behind a running agent. The sessions
    // were cancelled, all four rows were told to "run now", and only the first
    // reached pnpm — the rest came back with the host's lock refusal ("another
    // install is already running" / 409 without agentsBusy) and were recorded
    // as FAILURES. A failure is not part of the durable queue (only `queued`
    // rows persist), so the restart that ends the first install took the other
    // three off the panel for good.
    //
    // /status is left in flight on purpose. The drain samples it every 2s and
    // the user's clicks landed in the window between the idle sample and the
    // next tick; statusRef's initial { busy: false, runningAgents: [] } IS that
    // sample. Freezing the poll also keeps the drain out of the way, so the
    // test measures the run-now path instead of racing a timer — and it means
    // a fix that only consults the polled `busy` (stale by up to 2s, the exact
    // window this happens in) cannot pass.
    let inFlight = 0
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      const path = String(input).split('?')[0]
      const method = (init?.method ?? 'GET').toUpperCase()
      const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))
      if (path === '/dsh-market/registry') {
        return json({ source: 'live', registry: REGISTRY, hostVersion: '0.1.2-alpha.2' })
      }
      if (path === '/dsh-market/installed') {
        return json({ profile: 'web', installed: {}, live: [], disabled: [], groups: {}, groupOrder: [], favorites: [], blocked: [] })
      }
      if (path === '/dsh-market/updates') return json({ updates: {} })
      if (path === '/dsh-market/status') return new Promise<Response>(() => { /* see above */ })
      if (path === '/dsh-market/install' && method === 'POST') {
        // The host's mutation lock: one operation at a time, and a second
        // request is refused immediately instead of queueing (routes.ts
        // withMutationLock). The first install never returns — it is still
        // running, which is the state the user clicked the other rows in.
        if (inFlight > 0) return json({ error: 'another install is already running' }, 409)
        inFlight += 1
        return new Promise<Response>(() => {})
      }
      return Promise.reject(new Error(`unstubbed fetch: ${String(input)}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      localStorage.setItem('dshm-queue-v1', JSON.stringify([
        { kind: 'install', name: 'dsh-loop', url: 'https://github.com/alice/dsh-loop' },
        { kind: 'install', name: 'dsh-notify', url: 'https://github.com/bob/dsh-notify' },
      ]))
      render(<MarketSection {...props()} />)
      // findAll, not find: the restored queue row carries the same name as the
      // catalog card, and which of the two lands first is a timing detail.
      await screen.findAllByText('dsh-loop')
      const rowFor = (name: string): HTMLElement => {
        const row = [...document.querySelectorAll('[class*="opRow"]')].find(el => el.textContent?.includes(name))
        expect(row, `no Tasks row for ${name}`).toBeTruthy()
        return row as HTMLElement
      }
      await waitFor(() => {
        expect(within(rowFor('dsh-loop')).queryByRole('button', { name: en.opRunNow })).not.toBeNull()
        expect(within(rowFor('dsh-notify')).queryByRole('button', { name: en.opRunNow })).not.toBeNull()
      })

      // The batch of clicks the user made, one per row.
      fireEvent.click(within(rowFor('dsh-loop')).getByRole('button', { name: en.opRunNow }))
      fireEvent.click(within(rowFor('dsh-notify')).getByRole('button', { name: en.opRunNow }))

      // The batch does not fire requests it knows cannot succeed: the lock is
      // visibly held here, so the second click is answered rather than sent —
      // #752's rule, applied to the other guard. Sending it is what produced
      // the three "another install is still running" rows in the report.
      expect(fetchMock.mock.calls.filter(([url, init]) =>
        String(url).endsWith('/dsh-market/install') && (init?.method ?? 'GET').toUpperCase() === 'POST',
      )).toHaveLength(1)

      // The second row is still the user's pending work…
      await waitFor(() => {
        expect(within(rowFor('dsh-notify')).queryByRole('button', { name: en.opRunNow })).not.toBeNull()
      })
      expect(document.querySelector('[class*="opPanel"]')!.textContent).not.toContain(en.busyWait)
      // …which is also what lets it survive the restart the first install ends
      // with: only `queued` rows are persisted, so a failure here IS the loss.
      expect(JSON.parse(localStorage.getItem('dshm-queue-v1') ?? '[]'))
        .toEqual([expect.objectContaining({ kind: 'install', name: 'dsh-notify' })])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('re-queues an install the host refuses while its lock is held, instead of failing it (#775)', async () => {
    // The other 409 the host can answer with: the mutation lock is held, by an
    // operation this page did not start (or one whose row is already gone).
    // The refusal happens before pnpm is touched, so it is a deferral — and a
    // deferral recorded as a failure is not part of the durable queue, so the
    // next restart drops the user's install. The drain has to pick it up.
    let attempts = 0
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      const path = String(input).split('?')[0]
      const method = (init?.method ?? 'GET').toUpperCase()
      const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))
      if (path === '/dsh-market/registry') {
        return json({ source: 'live', registry: REGISTRY, hostVersion: '0.1.2-alpha.2' })
      }
      if (path === '/dsh-market/installed') {
        return json({ profile: 'web', installed: {}, live: [], disabled: [], groups: {}, groupOrder: [], favorites: [], blocked: [] })
      }
      if (path === '/dsh-market/updates') return json({ updates: {} })
      if (path === '/dsh-market/status') {
        return json({ active: false, busy: false, pnpm: true, boot: 'boot-1', restart: true, installed: {}, runningAgents: [] })
      }
      if (path === '/dsh-market/install' && method === 'POST') {
        attempts += 1
        if (attempts === 1) return json({ error: 'another install is already running' }, 409)
        return json({ ok: true, hot: false })
      }
      return Promise.reject(new Error(`unstubbed fetch: ${String(input)}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      localStorage.setItem('dshm-queue-v1', JSON.stringify([
        { kind: 'install', name: 'dsh-loop', url: 'https://github.com/alice/dsh-loop' },
      ]))
      render(<MarketSection {...props()} />)
      await screen.findAllByText('dsh-loop')
      // The drain's first attempt is refused by the lock…
      await waitFor(() => expect(attempts).toBe(1), { timeout: 8000 })
      const panelText = () => document.querySelector('[class*="opPanel"]')!.textContent ?? ''
      expect(panelText()).not.toContain(en.busyWait)
      expect(JSON.parse(localStorage.getItem('dshm-queue-v1') ?? '[]'))
        .toEqual([expect.objectContaining({ name: 'dsh-loop' })])
      // …and the next tick runs it, because the row was never declared dead.
      await waitFor(() => expect(attempts).toBe(2), { timeout: 8000 })
      await waitFor(() => expect(panelText()).toContain(en.opDoneRefresh), { timeout: 8000 })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('drains a queued install even while agents remain busy (#779)', async () => {
    // NOTE: no fake timers here — the drain fires on a real 2s interval and
    // the install POST resolves on the microtask queue. Fake timers freeze
    // the real-interval drain while waitFor's own timers fight it.
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      const path = String(input).split('?')[0]
      const method = (init?.method ?? 'GET').toUpperCase()
      if (path === '/dsh-market/registry') {
        return Promise.resolve(new Response(JSON.stringify({ source: 'live', registry: REGISTRY }), { status: 200 }))
      }
      if (path === '/dsh-market/installed') {
        return Promise.resolve(new Response(JSON.stringify({ profile: 'web', installed: {}, live: [] }), { status: 200 }))
      }
      if (path === '/dsh-market/updates') {
        return Promise.resolve(new Response(JSON.stringify({ updates: {} }), { status: 200 }))
      }
      if (path === '/dsh-market/status') {
        return Promise.resolve(new Response(JSON.stringify({
          active: false, busy: false, pnpm: true, boot: 'boot-1', restart: true, installed: {},
          runningAgents: ['main'],
        }), { status: 200 }))
      }
      if (path === '/dsh-market/install' && method === 'POST') {
        const count = fetchMock.mock.calls.filter(([url, init]) =>
          String(url).endsWith('/dsh-market/install') && (init?.method ?? 'GET').toUpperCase() === 'POST',
        ).length
        // A legacy host can still refuse; the drain retries the install even
        // while /status continues reporting the running agent.
        if (count === 1) {
          return Promise.resolve(new Response(JSON.stringify({
            ok: false, agentsBusy: true, runningAgents: ['main'], error: 'agents are running',
          }), { status: 409 }))
        }
        return Promise.resolve(new Response(JSON.stringify({ ok: true, hot: false }), { status: 200 }))
      }
      return Promise.reject(new Error(`unstubbed fetch: ${String(input)}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      localStorage.clear()
      render(<MarketSection {...props()} />)
      await screen.findByText('dsh-loop')
      // Queue one install while the agent is busy.
      const installButtons = screen.getAllByRole('button', { name: en.install })
      fireEvent.click(installButtons[0]!)
      fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))
      // First attempt hits the busy agent and queues…
      await waitFor(() => {
        const panel = document.querySelector('[class*="opPanel"]')
        expect(panel!.textContent).toContain(en.opQueued)
      })
      // …the drain fires and the install succeeds without waiting for idle.
      // (A non-hot success needs a refresh, so the record reads
      // "Installed · refresh the page to apply", not "Done".)
      await waitFor(() => {
        expect(fetchMock.mock.calls.filter(([url, init]) =>
          String(url).endsWith('/dsh-market/install') && (init?.method ?? 'GET').toUpperCase() === 'POST',
        )).toHaveLength(2)
      }, { timeout: 8000 })
      await waitFor(() => {
        const panel = document.querySelector('[class*="opPanel"]')
        expect(panel!.textContent).toContain(en.opDoneRefresh)
      }, { timeout: 8000 })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('leaves an idle page alone — no /status poll without a queued record (#838)', async () => {
    // The drain's own comment has always claimed "an idle page makes no
    // requests", and the loop fetched /status on every tick before asking
    // whether anything was queued: an open market tab polled the host every
    // 2 s for as long as it stayed open, with nothing to drain. Real timers,
    // as in the test above — the loop runs on a real interval and fake ones
    // would freeze it. The two drain tests above are the other half of this
    // assertion: with a record queued, the loop still fires.
    stubFetch()
    localStorage.clear()
    render(<MarketSection {...props()} />)
    await screen.findAllByText('dsh-loop')
    const statusCalls = () => fetchCalls.filter(call => call.path === '/dsh-market/status').length
    // Let the mount settle before sampling, so a late first load cannot be
    // mistaken for a tick of the drain.
    await new Promise(resolve => setTimeout(resolve, 300))
    const atRest = statusCalls()
    // Longer than one 2 s interval, so an ungated loop would have fired.
    await new Promise(resolve => setTimeout(resolve, 2600))
    expect(statusCalls()).toBe(atRest)
  })

  it('keeps a queued install across remounts via localStorage', async () => {
    stubFetch({
      '/dsh-market/install': {
        ok: false,
        agentsBusy: true,
        runningAgents: ['main'],
        error: 'agents are running',
        __status: 409,
      },
    })
    localStorage.clear()
    const first = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    const installButtons = screen.getAllByRole('button', { name: en.install })
    fireEvent.click(installButtons[0]!)
    fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))
    await waitFor(() => {
      const panel = document.querySelector('[class*="opPanel"]')
      expect(panel!.textContent).toContain(en.opQueued)
    })
    // A remount (settings dialog closed and reopened) restores the queue —
    // restore opens the panel itself, so wait for the queued row.
    first.unmount()
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    await waitFor(() => {
      const panel = document.querySelector('[class*="opPanel"]')
      expect(panel, 'the Tasks panel did not open').toBeTruthy()
      expect(panel!.textContent).toContain(en.opQueued)
    })
    expect(JSON.parse(localStorage.getItem('dshm-queue-v1') ?? '[]')).toHaveLength(1)
  })

  describe('finished operations across a reload', () => {
    /** The Install button on one card, found by walking up from its name. */
    const installButtonOf = (name: string) => {
      let card: HTMLElement | null = screen.getByText(name)
      while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
        card = card.parentElement
      }
      return within(card!).getAllByRole('button', { name: en.install })[0]!
    }

    /**
     * A failed install is the row a reload used to eat: the card is back to
     * "Install", the plugin is not in Installed (the host rolled it back), and
     * the approval that was the only way forward disappeared with the row.
     */
    const failedInstall = {
      id: 'op-4',
      kind: 'install',
      name: 'dsh-loop',
      url: 'https://github.com/alice/dsh-loop',
      state: 'failed',
      reason: 'pnpm refused to run node-pty build scripts',
      blockedBuilds: ['node-pty'],
    }

    it('restores a failed install row with its way out after a reload', async () => {
      localStorage.setItem('dshm-settled-v1', JSON.stringify([failedInstall]))
      stubFetch({
        '/dsh-market/install': { ok: true, hot: false },
        '/dsh-market/approve-builds': { ok: true, approved: ['node-pty'] },
      })
      render(<MarketSection {...props()} />)
      await screen.findByText('dsh-loop')
      // The card keeps the marker it had before the reload...
      expect(await screen.findByRole('button', { name: en.opBlockedCard })).toBeTruthy()
      // ...but the panel is not opened for the user; the row waits behind it.
      expect(document.querySelector('[class*="opPanel"]')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: en.opTitle }))
      const panel = document.querySelector('[class*="opPanel"]')
      expect(panel!.textContent).toContain('dsh-loop')
      expect(panel!.textContent).toContain(failedInstall.reason)
      // The way out travels with the record: one click approves and retries.
      fireEvent.click(within(panel as HTMLElement).getByRole('button', { name: en.approveBuilds }))
      await waitFor(() => {
        expect(fetchCalls.some(call => call.path === '/dsh-market/approve-builds')).toBe(true)
        expect(fetchCalls.some(call => call.path === '/dsh-market/install' && call.method === 'POST')).toBe(true)
      })
    })

    it('ignores an unusable stored history without crashing or inventing a row', async () => {
      localStorage.setItem('dshm-settled-v1', '{not json')
      render(<MarketSection {...props()} />)
      await screen.findByText('dsh-loop')
      // The entry stays quiet, and opening it shows the ordinary empty state.
      fireEvent.click(screen.getByRole('button', { name: en.opTitle }))
      const panel = document.querySelector('[class*="opPanel"]')
      expect(panel!.textContent).toContain(en.opEmpty)
      // The bad value is dropped instead of being re-parsed on every mount.
      expect(localStorage.getItem('dshm-settled-v1')).toBeNull()
    })

    it('restores a finished row without re-asking for a refresh already taken', async () => {
      localStorage.setItem('dshm-settled-v1', JSON.stringify([{
        id: 'op-2', kind: 'update', name: 'dsh-loop', state: 'done', needsRefresh: true,
      }]))
      render(<MarketSection {...props()} />)
      await screen.findByText('dsh-loop')
      fireEvent.click(screen.getByRole('button', { name: en.opTitle }))
      const panel = document.querySelector('[class*="opPanel"]')
      expect(panel!.textContent).toContain('dsh-loop')
      expect(panel!.textContent).toContain(en.opDone)
      // The reload already applied the change; offering Refresh would loop.
      expect(within(panel as HTMLElement).queryByRole('button', { name: en.refresh })).toBeNull()
    })

    it('persists a row that finishes now, and clearing it empties the stored copy', async () => {
      stubFetch({
        '/dsh-market/install': {
          ok: false, ignoredBuilds: ['node-pty'], error: 'blocked by pnpm', __status: 502,
        },
      })
      render(<MarketSection {...props()} />)
      await screen.findByText('dsh-loop')
      fireEvent.click(installButtonOf('dsh-loop'))
      fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))
      // The failure is written the moment the row becomes terminal...
      await waitFor(() => {
        const stored = JSON.parse(localStorage.getItem('dshm-settled-v1') ?? '[]') as Array<Record<string, unknown>>
        expect(stored).toHaveLength(1)
        expect(stored[0]).toMatchObject({ state: 'failed', name: 'dsh-loop', blockedBuilds: ['node-pty'] })
      })
      // ...and "clear finished" empties it through the same records state.
      const panel = document.querySelector('[class*="opPanel"]')
      expect(panel, 'the failed row did not open the panel').toBeTruthy()
      fireEvent.click(within(panel as HTMLElement).getByRole('button', { name: en.opClear }))
      await waitFor(() => expect(localStorage.getItem('dshm-settled-v1')).toBeNull())
    })
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

  it('reports a same-name row as informational, with no rollback (#913)', async () => {
    // The #913 shape: the install mounts a second instance of an existing
    // plugin name from a bundle patch. Both rows can load, so the banner must
    // not promise that one wins, and nothing is armed for rollback.
    const fetchMock = stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-market/updates': { updates: { 'dsh-loop': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
      '/dsh-market/update': {
        ok: true,
        activation: { 'dsh-loop': { state: 'restart', hot: false, bundle: true, reasons: ['restart to apply'] } },
        compatibility: {
          code: 'soft-incompatible',
          risks: [],
          shadowedNames: [{ name: '@deepseek-ai/dsh-skill-filesystem', layers: ['bundle:dsh-base', 'bundle:dsh-loop'], count: 2 }],
        },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('button', { name: en.update }))

    expect(await screen.findByText(en.shadowNameBanner)).toBeTruthy()
    // #913: the copy no longer claims only one of the two rows will load.
    expect(en.shadowNameBanner).not.toContain('only one will load')
    expect(screen.queryByRole('button', { name: en.rollbackNow })).toBeNull()
    expect(screen.queryByText(en.rollbackUnavailable)).toBeNull()
    expect(fetchMock.mock.calls.some(([url]) => url === '/dsh-market/rollback')).toBe(false)
  })

  it('does not offer a rollback action when the server could not capture an exact source', async () => {
    const rollbackUnavailable = '更新前版本为 v1.0.0，但无法确认精确来源。 / The previous version was v1.0.0, but its exact source could not be verified.'
    const englishHalf = 'The previous version was v1.0.0, but its exact source could not be verified.'
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
    expect(screen.getByText(englishHalf)).toBeTruthy()
    expect(screen.queryByText(rollbackUnavailable)).toBeNull()
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

  it('switches page size and keeps direct 1/N page access in the numbered window', async () => {
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
    // The numbered window always exposes 1 and N, so both ends stay one
    // click away without separate «/» glyphs crowding the single-line row.
    expect(screen.getByRole('button', { name: '1' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '2' }))
    await waitFor(() => expect(screen.getByText('dsh-q30')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '1' }))
    await waitFor(() => expect(screen.getByText('dsh-q1')).toBeTruthy())
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
      // Selecting a size must close the menu — otherwise scroll-to-top leaves
      // the panel floating over the list.
      expect(screen.queryByRole('menuitem', { name: '24' })).toBeNull()
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
    const { container } = render(<MarketSection {...props()} />)
    await waitFor(() => expect(rankedNames(container)).toContain('dsh-fresh'))
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

describe('an install with no structured phase (the desktop manager)', () => {
  /** The status the desktop manager reports: one fixed line, no phase. */
  function runningFor(seconds: number): void {
    stubFetch({
      '/dsh-market/status': {
        active: true, seconds, lastLine: '桌面端的插件管理器正在处理 / The desktop app\'s plugin manager is working on it',
        installed: {}, pnpm: true, boot: 'boot-1', restart: true,
      },
    })
  }

  it('shows its line in the page language, and only says a wait is normal once it is long (#1011)', async () => {
    vi.useFakeTimers()
    try {
      sessionStorage.setItem('dshm-pending', JSON.stringify({ url: 'https://github.com/alice/dsh-loop' }))
      runningFor(12)
      render(<MarketSection {...props()} />)
      await vi.waitFor(() => { screen.getByText('dsh-loop') })
      await vi.advanceTimersByTimeAsync(2100)
      await vi.waitFor(() => {
        expect(screen.getByText(/The desktop app's plugin manager is working on it \(12s\)$/)).toBeTruthy()
      })
      // A short wait is normal and says nothing more.
      expect(screen.queryByText(re(en.progressSlow))).toBeNull()

      runningFor(412)
      await vi.advanceTimersByTimeAsync(2100)
      await vi.waitFor(() => {
        expect(screen.getByText(re(en.progressSlow))).toBeTruthy()
      })
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

  it('shows a declared library as shared code, keeps updates, and explains uninstall consequences (#995)', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web', installed: { 'dsh-shared': '^0.1.7' }, live: [], disabled: ['dsh-shared'],
        groups: {}, groupOrder: [],
        activation: {
          'dsh-shared': { state: 'inert', library: true, reasons: ['供其他插件使用，无需启用 / for other plugins to use; no need to enable it'], bundle: false, hot: false },
        },
      },
      '/dsh-market/updates': { updates: { 'dsh-shared': { kind: 'npm', version: '0.1.7', current: '0.1.7', latest: '0.1.8', updateAvailable: true } } },
      '/dsh-market/update': { ok: true, activation: { 'dsh-shared': { state: 'inert', library: true, reasons: ['for other plugins to use'], bundle: false, hot: false } } },
    })
    render(<MarketSection {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await screen.findByText('dsh-shared')

    expect(screen.getByText('Library')).toBeTruthy()
    expect(screen.getByText('Shared code for other plugins. No need to enable it.')).toBeTruthy()
    expect(screen.queryByText(en.stateInert)).toBeNull()
    expect(screen.queryByText(en.switchOnLabel)).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.update }))
    expect(await screen.findByText('✓ Updated')).toBeTruthy()
    expect(screen.queryByText(en.updated)).toBeNull()

    await openCardUninstall()
    expect(screen.getByText('Removing this library may stop plugins that use it from starting.')).toBeTruthy()
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
describe("the host's own page for a plugin (dsh 0.2.1+)", () => {
  /** One installed plugin, live, with the host offering its navigation service. */
  function renderInstalled(navigation?: { openBundle: (name: string) => void }) {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0' },
        live: ['dsh-loop'],
        disabled: [],
        groups: {},
        groupOrder: [],
      },
    })
    const store = createHostNavigation()
    if (navigation !== undefined) store.attach(navigation)
    const element = render(<MarketSection {...props()} hostNavigation={store} />)
    return { ...element, store }
  }

  it('opens the bundle on the host when the service is there', async () => {
    const opened: string[] = []
    renderInstalled({ openBundle: name => opened.push(name) })
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await openRowMenu('dsh-loop')
    fireEvent.click(await screen.findByRole('menuitem', { name: en.openInHostPage }))
    expect(opened).toEqual(['dsh-loop'])
  })

  it('offers nothing on a host that never provides the service', async () => {
    // Every dsh before 0.2.1, and any host whose plugin manager is not
    // mounted. An entry that cannot do anything is worse than no entry.
    renderInstalled()
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await openRowMenu('dsh-loop')
    expect(screen.queryByRole('menuitem', { name: en.openInHostPage })).toBeNull()
  })

  it('offers it to a menu already on screen when the service arrives late', async () => {
    // The manager's client half can load after this panel; a menu drawn from a
    // setup-time snapshot would never show the action on a host that has it.
    const opened: string[] = []
    const { store } = renderInstalled()
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await openRowMenu('dsh-loop')
    expect(screen.queryByRole('menuitem', { name: en.openInHostPage })).toBeNull()
    store.attach({ openBundle: name => opened.push(name) })
    fireEvent.click(await screen.findByRole('menuitem', { name: en.openInHostPage }))
    expect(opened).toEqual(['dsh-loop'])
  })
})

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
    await openCardUninstall()
    await screen.findByText(re(en.uninstallConfirmDesc))
    fireEvent.click(screen.getByRole('button', { name: en.uninstall }))

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
    await openCardUninstall()
    await screen.findByText(re(en.uninstallConfirmDesc))
    fireEvent.click(screen.getByRole('button', { name: en.uninstall }))

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
    await openCardUninstall()
    await screen.findByText(re(en.uninstallConfirmDesc))
    fireEvent.click(screen.getByRole('button', { name: en.uninstall }))

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
    await openCardUninstall()
    await screen.findByText(re(en.uninstallConfirmDesc))
    fireEvent.click(screen.getByRole('button', { name: en.uninstall }))

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

describe('card hover does not cover footer actions (#1021)', () => {
  it('does not open a covering introduction, and comments and favorite still work', async () => {
    // #996's hover peek portaled a sheet over the card after 420ms. The
    // title and Install stayed visible; comments and favorite sit in the
    // footer, under that sheet. Resting on a card must not create the
    // sheet, and both footer actions must still do their job.
    render(<MarketSection {...props()} />)
    const name = await screen.findByText('dsh-loop')
    const card = name.closest('[class*="card"]') as HTMLElement
    expect(within(card).getByRole('button', { name: en.favoriteAdd })).toBeTruthy()
    expect(within(card).getByRole('button', { name: en.comments })).toBeTruthy()

    vi.useFakeTimers()
    try {
      fireEvent.pointerEnter(card)
      await act(async () => { await vi.advanceTimersByTimeAsync(420) })
      expect(document.querySelector('[class*="introPanel"]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }

    fireEvent.click(within(card).getByRole('button', { name: en.favoriteAdd }))
    await waitFor(() => {
      const call = fetchCalls.find(c => c.path === '/dsh-market/favorite')
      expect(call?.body).toEqual({ url: 'https://github.com/alice/dsh-loop', favorited: true })
    })
    fireEvent.click(within(card).getByRole('button', { name: en.comments }))
    await screen.findByRole('dialog', { name: `${en.commentsTitle} — dsh-loop` })
  })
})

describe('discover card download count stays compact', () => {
  it('shows the count on the card; the period stays in the tooltip', async () => {
    // #996 put " / 30d" on every byline. That string is already in the
    // tooltip, and on a two-up card it wraps the author row onto three lines.
    const plugin = {
      ...REGISTRY.plugins[0]!,
      downloads: 182400,
      downloadsStart: '2026-09-01',
      downloadsEnd: '2026-09-30',
      downloadsCheckedAt: '2026-10-01',
    }
    stubFetch({
      '/dsh-market/registry': {
        source: 'live',
        hostVersion: '0.1.2-alpha.2',
        registry: { ...REGISTRY, count: 1, plugins: [plugin] },
      },
    })
    render(<MarketSection {...props()} />)
    const card = (await screen.findByText('dsh-loop')).closest('[class*="card"]') as HTMLElement
    expect(within(card).getByText('· ↓ 182.4k')).toBeTruthy()
    expect(within(card).queryByText(re(en.downloadsPeriod))).toBeNull()
    const tip = downloadStatsText(plugin, props().t)
    expect(tip).toBeTruthy()
    expect(within(card).getByLabelText(tip!)).toBeTruthy()
  })
})

describe('favorites (#414)', () => {
  function favoritesStub(initial: string[] = [], installed: Record<string, string> = {}) {
    const state = { favorites: [...initial] }
    stubFetch({
      '/dsh-market/installed': () => ({
        profile: 'web', installed, live: Object.keys(installed), disabled: [], groups: {}, groupOrder: [], favorites: [...state.favorites],
      }),
      '/dsh-market/favorite': (body: any) => {
        const url = String(body.url)
        if (body.favorited === true) {
          if (!state.favorites.includes(url)) state.favorites.push(url)
        } else {
          state.favorites = state.favorites.filter(entry => entry !== url)
        }
        return { ok: true, favorites: [...state.favorites] }
      },
    })
    return state
  }

  it('bookmarks a discover card and POSTs favorited:true', async () => {
    favoritesStub()
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    const card = screen.getByText('Loop task runner').closest('[class*="card"]') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: en.favoriteAdd }))
    await waitFor(() => {
      const call = fetchCalls.find(c => c.path === '/dsh-market/favorite')
      expect(call?.body).toEqual({ url: 'https://github.com/alice/dsh-loop', favorited: true })
    })
    expect(screen.getByRole('button', { name: en.favoriteRemove })).toBeTruthy()
  })

  it('adds an installed plugin to favorites from its row menu (#785)', async () => {
    // The complaint: a favorite could only be made from Discover, so the user
    // had to install a plugin, decide it was worth keeping, and then find it
    // again in the catalog. The installed row knows which catalog entry it is,
    // which is the key the Favorites tab resolves by (#414).
    favoritesStub([], { 'dsh-loop': '^1.0.0' })
    render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    await screen.findByText('dsh-loop')

    await openRowMenu('dsh-loop')
    fireEvent.click(await screen.findByRole('menuitem', { name: en.favoriteAdd }))

    await waitFor(() => {
      const call = fetchCalls.find(c => c.path === '/dsh-market/favorite')
      expect(call?.body).toEqual({ url: 'https://github.com/alice/dsh-loop', favorited: true })
    })
    // The row now offers the way back, and the Favorites tab has it.
    await openRowMenu('dsh-loop')
    await screen.findByRole('menuitem', { name: en.favoriteRemove })
  })

  it('offers no favorite action for an installed plugin the catalog does not carry (#785)', async () => {
    // Favourites are keyed by catalog url; without an entry there is nothing
    // the Favorites tab could show, so the action would be a dead end.
    favoritesStub([], { 'dsh-unknown': '^1.0.0' })
    render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    await screen.findByText('dsh-unknown')

    await openRowMenu('dsh-unknown')

    expect(screen.queryByRole('menuitem', { name: en.favoriteAdd })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: en.favoriteRemove })).toBeNull()
    // The other curation action is still there — this removed one entry, not the menu.
    expect(screen.getByRole('menuitem', { name: en.blockAdd })).toBeTruthy()
  })

  it('lists only favorited plugins on the favorites tab', async () => {
    favoritesStub(['https://github.com/bob/dsh-notify'])
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: re(en.tabFavorites) }))
    await screen.findByText('dsh-notify')
    expect(screen.queryByText('dsh-loop')).toBeNull()
  })

  it('loads host-requirement badges on the favorites tab', async () => {
    // Discover only fetches compatibility for the current page (24). Put the
    // favorite past that window so favorites must request it itself — otherwise
    // the badge would already be warm from discover and this would not catch
    // the missing favorites load.
    const fillers = Array.from({ length: 30 }, (_, i) => ({
      ...REGISTRY.plugins[0],
      name: `filler-${String(i).padStart(2, '0')}`,
      npm: `filler-${String(i).padStart(2, '0')}`,
      url: `https://github.com/fill/filler-${String(i).padStart(2, '0')}`,
      stars: 1000 - i,
      added: '2026-08-01',
    }))
    const favorite = {
      ...REGISTRY.plugins[0],
      name: 'fav-only',
      npm: 'fav-only',
      url: 'https://github.com/fav/fav-only',
      stars: 1,
      added: '2026-07-01',
    }
    const plugins = [...fillers, favorite]
    stubFetch({
      '/dsh-market/registry': {
        source: 'live',
        hostVersion: '0.1.2-alpha.2',
        registry: { ...REGISTRY, count: plugins.length, plugins },
      },
      '/dsh-market/installed': {
        profile: 'web', installed: {}, live: [], disabled: [], groups: {}, groupOrder: [],
        favorites: [favorite.url],
      },
      '/dsh-market/discovery-compatibility': (body: any) => ({
        hostVersion: '0.1.2-alpha.2',
        plugins: Object.fromEntries(body.packages.map((name: string) => [name, {
          status: 'compatible',
          basis: 'manifest',
          requirement: name === 'fav-only' ? '^9.9.9' : '^0.1.2-alpha.2',
          declarations: [{ kind: 'peer', package: '@deepseek-ai/dsh-tools', range: name === 'fav-only' ? '^9.9.9' : '^0.1.2-alpha.2' }],
        }])),
      }),
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('filler-00')
    expect(screen.queryByText('fav-only')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: re(en.tabFavorites) }))
    await screen.findByText('fav-only')
    await waitFor(() => {
      expect(fetchCalls.some(call =>
        call.path === '/dsh-market/discovery-compatibility'
        && call.method === 'POST'
        && Array.isArray((call.body as { packages?: unknown })?.packages)
        && ((call.body as { packages: string[] }).packages).includes('fav-only'))).toBe(true)
    })
    await screen.findByText(en.hostRequirement.replace('{0}', '^9.9.9'))
    expect(screen.queryByText(en.hostRequirementLoading)).toBeNull()
  })

  it('removing a favorite drops it from the favorites tab', async () => {
    const state = favoritesStub(['https://github.com/alice/dsh-loop'])
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: re(en.tabFavorites) }))
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: en.favoriteRemove }))
    await waitFor(() => expect(state.favorites).toEqual([]))
    expect(screen.getByText(en.favoritesEmpty)).toBeTruthy()
  })

  it('groups favorites into plugin and theme sections', async () => {
    favoritesStub([
      'https://github.com/alice/dsh-loop',
      'https://github.com/carol/whale-skin',
    ])
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: re(en.tabFavorites) }))
    await screen.findByText('dsh-loop')
    await screen.findByText('whale-skin')
    expect(screen.getByText(en.favoritesPluginsSection.replace('{0}', '1'))).toBeTruthy()
    expect(screen.getByText(en.favoritesThemesSection.replace('{0}', '1'))).toBeTruthy()
  })

  it('shows stale empty state when every favorite left the catalog', async () => {
    favoritesStub(['https://github.com/ghost/removed-plugin'])
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: re(en.tabFavorites) }))
    expect(await screen.findByText(en.favoritesStaleEmpty)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.favoritesClearStale })).toBeTruthy()
  })
})

describe('blocked plugins (#657)', () => {
  function blockedStub(initial: string[] = []) {
    const state = { blocked: [...initial] }
    stubFetch({
      '/dsh-market/installed': () => ({
        profile: 'web', installed: {}, live: [], disabled: [], groups: {}, groupOrder: [],
        favorites: [], blocked: [...state.blocked],
      }),
      '/dsh-market/block': (body: any) => {
        const name = String(body.name)
        if (body.blocked === true) {
          if (!state.blocked.includes(name)) state.blocked.push(name)
        } else {
          state.blocked = state.blocked.filter(entry => entry !== name)
        }
        return { ok: true, blocked: [...state.blocked] }
      },
    })
    return state
  }

  it('hides a plugin from Discover via the card menu, and says where to undo it', async () => {
    blockedStub()
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    const card = screen.getByText('Loop task runner').closest('[class*="card"]') as HTMLElement
    expect(within(card).queryByRole('button', { name: en.blockAdd })).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: en.groupMore }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.blockAdd }))
    await waitFor(() => {
      const call = fetchCalls.find(c => c.path === '/dsh-market/block')
      expect(call?.body).toEqual({ name: 'dsh-loop', blocked: true })
    })
    await waitFor(() => expect(screen.queryByText('Loop task runner')).toBeNull())
    expect(await screen.findByText(en.blockMoved)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.tabBlocked + ' (1)' }))
    const hidden = (await screen.findByText('Loop task runner')).closest('[class*="card"]') as HTMLElement
    fireEvent.click(within(hidden).getByRole('button', { name: en.groupMore }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.blockRemove }))
    await waitFor(() => expect(screen.getByText(en.blockedEmpty)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: en.tabDiscover }))
    expect(await screen.findByText('Loop task runner')).toBeTruthy()
  })

  it('skips a hidden plugin from Update all, and still offers it on its own row', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0', 'dsh-notify': '^1.0.0', 'dsh-third': '^1.0.0' },
        live: [],
        disabled: [],
        blocked: ['dsh-third'],
      },
      '/dsh-market/updates': {
        updates: {
          'dsh-loop': { kind: 'npm', version: '1.0.0', latest: '1.1.0', updateAvailable: true },
          'dsh-notify': { kind: 'npm', version: '1.0.0', latest: '1.1.0', updateAvailable: true },
          'dsh-third': { kind: 'npm', version: '1.0.0', latest: '1.1.0', updateAvailable: true },
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
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    let row: HTMLElement | null = await screen.findByText('dsh-third')
    while (row !== null && within(row).queryByRole('button', { name: en.update }) === null) row = row.parentElement
    expect(within(row!).getByRole('button', { name: en.update })).toBeTruthy()
  })

  it('treats a linked checkout and its catalog package name as one block', async () => {
    const fork = {
      name: 'loop-repo', owner: 'alice', url: 'https://github.com/alice/loop-repo', category: 'tools',
      npm: 'dsh-loop-pkg', stars: 1, added: '2026-08-01', description: { en: 'Forked loop', zh: '分叉循环' }, install: '',
    }
    const state = { blocked: ['dsh-loop-pkg'] }
    stubFetch({
      '/dsh-market/registry': {
        source: 'live',
        registry: { ...REGISTRY, plugins: [...REGISTRY.plugins, fork] },
      },
      '/dsh-market/installed': () => ({
        profile: 'web',
        installed: { 'my-loop': 'link:../my-loop', 'dsh-notify': '^1.0.0' },
        live: [],
        disabled: [],
        blocked: [...state.blocked],
        repoIdentities: { 'my-loop': ['alice/loop-repo'] },
      }),
      '/dsh-market/updates': {
        updates: {
          'my-loop': { kind: 'linked', version: '1.0.0', latest: '1.1.0', updateAvailable: true },
          'dsh-notify': { kind: 'npm', version: '1.0.0', latest: '1.1.0', updateAvailable: true },
        },
      },
      '/dsh-market/block': (body: any) => {
        const name = String(body.name)
        if (body.blocked === true) {
          if (!state.blocked.includes(name)) state.blocked.push(name)
        } else {
          state.blocked = state.blocked.filter(entry => entry !== name)
        }
        return { ok: true, blocked: [...state.blocked] }
      },
      '/dsh-market/update': { ok: true },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    expect(screen.queryByText('Forked loop')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: 'Forked loop' } })
    expect(await screen.findByText(en.blockedFilteredEmpty)).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: /Update all \(1\)/ }))
    await waitFor(() => {
      expect(fetchCalls.filter(call => call.path === '/dsh-market/update').map(call => call.body?.name)).toEqual(['dsh-notify'])
    })
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    let row: HTMLElement | null = await screen.findByText('my-loop')
    while (row !== null && within(row).queryByRole('button', { name: en.groupMore }) === null) row = row.parentElement
    fireEvent.click(within(row!).getByRole('button', { name: en.groupMore }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.blockRemove }))
    await waitFor(() => {
      const call = fetchCalls.find(c => c.path === '/dsh-market/block')
      expect(call?.body).toEqual({ name: 'dsh-loop-pkg', blocked: false })
    })
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
    // description: its own control with a plus mark. The original/mine toggle
    // deliberately remains quiet text.
    expect(addNote.className).toMatch(/noteAdd/)
    expect(addNote.querySelector('svg')).toBeTruthy()
    fireEvent.click(addNote)
    fireEvent.change(screen.getByPlaceholderText(en.notePlaceholder), { target: { value: 'for project A' } })
    fireEvent.click(screen.getByRole('button', { name: en.noteSave }))

    // The note takes the description's place rather than sitting beside it.
    expect((await screen.findByText('for project A')).className).toMatch(/noteMine/)
    expect(screen.getByRole('button', { name: en.noteEdit }).className).toMatch(/noteAdd/)
    await waitFor(() => expect(screen.queryByText('Loop task runner')).toBeNull())
  })

  it('does not save while an IME is still composing', async () => {
    installedStub()
    render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('button', { name: en.noteAdd }))
    const input = screen.getByPlaceholderText(en.notePlaceholder)
    fireEvent.change(input, { target: { value: 'xiangmu' } })
    // Enter here picks the pinyin candidate; the note is not finished.
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(fetchCalls.some(call => call.path === '/dsh-market/note')).toBe(false)
    expect(screen.getByPlaceholderText(en.notePlaceholder)).toBeTruthy()

    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(fetchCalls.some(call => call.path === '/dsh-market/note')).toBe(true))
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

  it('shows add-note even when the plugin has no catalog description (#458)', async () => {
    stubFetch({
      '/dsh-market/registry': {
        source: 'snapshot',
        registry: {
          updated: '', count: 1,
          categories: { tools: { en: 'Tools', zh: '工具' } },
          plugins: [
            { name: 'dsh-local', owner: 'alice', url: 'https://github.com/alice/dsh-local', category: 'tools', npm: 'dsh-local', stars: 1, added: '2026-08-01', description: { en: '', zh: '' }, install: '' },
          ],
        },
      },
      '/dsh-market/installed': () => ({
        profile: 'web', installed: { 'dsh-local': 'link:../dsh-local' }, live: ['dsh-local'], disabled: [], notes: {},
      }),
      '/dsh-market/note': (body: any) => ({
        ok: true,
        notes: String(body.text).trim() === '' ? {} : { [body.name]: String(body.text).trim() },
      }),
    })
    render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    await screen.findByText('dsh-local')

    const addNote = screen.getByRole('button', { name: en.noteAdd })
    expect(addNote.className).toMatch(/noteAdd/)
    fireEvent.click(addNote)
    fireEvent.change(screen.getByPlaceholderText(en.notePlaceholder), { target: { value: 'local dev fork' } })
    fireEvent.click(screen.getByRole('button', { name: en.noteSave }))

    expect((await screen.findByText('local dev fork')).className).toMatch(/noteMine/)
    expect(screen.getByRole('button', { name: en.noteEdit }).className).toMatch(/noteAdd/)
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
    // Deprecated alone opens the caution block (#739); the terminal lines
    // stay out because this plugin is not a terminal one.
    expect(screen.getByText(en.installCaution)).toBeTruthy()
    expect(screen.queryByText(en.terminalCautionTitle)).toBeNull()
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
  it('labels an ungrouped declared library as a library (#995)', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web', installed: { 'dsh-shared': '^0.1.7' }, live: [], disabled: [],
        groups: {}, groupOrder: [],
        activation: {
          'dsh-shared': { state: 'inert', library: true, reasons: ['for other plugins to use'], bundle: false, hot: false },
        },
      },
    })
    render(<MarketSection {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(screen.getByRole('button', { name: en.tabGroups }))

    const row = (await screen.findByText('dsh-shared')).closest('[class*="ungroupedRow"]') as HTMLElement
    expect(within(row).getByText(en.stateLibrary)).toBeTruthy()
    expect(within(row).queryByText(en.groupStateInert)).toBeNull()
  })

  it('keeps a plugin\'s description beside its name once it is in a group (#1006)', async () => {
    // Moving a plugin into a group used to drop everything but its name; it
    // came back only when the plugin was taken out again. The user's own note
    // wins over the catalog text, as it does in "Ungrouped".
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web', installed: { 'dsh-unlisted': '^1.0.0', 'dsh-notify': '^1.0.0' },
        live: ['dsh-unlisted', 'dsh-notify'], disabled: [], notes: { 'dsh-notify': 'my own reminder' },
        groups: { work: ['dsh-unlisted', 'dsh-notify'] }, groupOrder: ['work'],
        activation: {
          'dsh-unlisted': { state: 'live', reasons: [], bundle: true, hot: true },
          'dsh-notify': { state: 'live', reasons: [], bundle: true, hot: true },
        },
      },
    })
    render(<MarketSection {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(screen.getByRole('button', { name: en.tabGroups }))

    const noted = (await screen.findByText('dsh-notify')).closest('[class*="groupMember"]') as HTMLElement
    expect(within(noted).getByText('my own reminder')).toBeTruthy()
    // A member with nothing to say stays a bare row rather than growing an empty gap.
    const bare = screen.getByText('dsh-unlisted').closest('[class*="groupMember"]') as HTMLElement
    expect(bare.querySelector('[class*="ungroupedDesc"]')).toBeNull()
  })

  it('does not offer library switches in a group (#995)', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web', installed: { 'dsh-loop': '^1.0.0', 'dsh-shared': '^0.1.7' },
        live: ['dsh-loop'], disabled: [], groups: { work: ['dsh-loop', 'dsh-shared'] }, groupOrder: ['work'],
        activation: {
          'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true },
          'dsh-shared': { state: 'inert', library: true, reasons: ['used by other plugins'], bundle: false, hot: false },
        },
      },
    })
    render(<MarketSection {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(screen.getByRole('button', { name: en.tabGroups }))

    expect(await screen.findByText('dsh-shared')).toBeTruthy()
    expect(screen.getByRole('switch', { name: en.disable + ' work' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: en.disable + ' dsh-loop' })).toBeTruthy()
    expect(screen.queryByRole('switch', { name: en.disable + ' dsh-shared' })).toBeNull()
  })

  /** Stateful fake: mirrors the server-side group/toggle semantics in memory. */
  function makeFake(installed: Record<string, string>, activationOverride?: Record<string, unknown>) {
    const state = { disabled: [] as string[], groups: {} as Record<string, string[]>, groupOrder: [] as string[] }
    const activation: Record<string, unknown> = {}
    for (const name of Object.keys(installed)) {
      activation[name] = { state: 'live', reasons: [], bundle: true, hot: true }
    }
    if (activationOverride !== undefined) Object.assign(activation, activationOverride)
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

    // Leaving the inline editor restores the New group button.
    fireEvent.click(screen.getByRole('button', { name: en.groupNew }))
    fireEvent.change(screen.getByPlaceholderText(en.groupNamePh), { target: { value: 'draft' } })
    fireEvent.focusOut(screen.getByPlaceholderText(en.groupNamePh))
    expect(screen.getByRole('button', { name: en.groupNew })).toBeTruthy()
    expect(screen.queryByPlaceholderText(en.groupNamePh)).toBeNull()

    // Create.
    fireEvent.click(screen.getByRole('button', { name: en.groupNew }))
    fireEvent.change(screen.getByPlaceholderText(en.groupNamePh), { target: { value: 'work' } })
    fireEvent.click(screen.getByRole('button', { name: en.groupCreate }))
    expect(await screen.findByText('work')).toBeTruthy()

    // Assign dsh-loop into the group from the ungrouped list.
    const loopRow = screen.getByText('dsh-loop').closest('[class*="groupMember"]') as HTMLElement
    fireEvent.click(within(loopRow).getByRole('button', { name: en.groupAssign }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'work' }))
    await waitFor(() => {
      const row = screen.getByText('dsh-loop').closest('[class*="groupMember"]') as HTMLElement | null
      expect(row).not.toBeNull()
    })

    // Remove it again.
    const memberRow = screen.getByText('dsh-loop').closest('[class*="groupMember"]') as HTMLElement
    fireEvent.click(within(memberRow).getByRole('button', { name: en.groupRemove }))
    await waitFor(() => expect(screen.getByText(en.groupEmpty)).toBeTruthy())

    // Rename via overflow menu.
    const groupRow = screen.getByText('work').closest('[class*="groupRow"]') as HTMLElement
    fireEvent.click(within(groupRow).getByRole('button', { name: en.groupMore }))
    fireEvent.click(await screen.findByRole('menuitem', { name: en.groupRename }))
    const renameDialog = await screen.findByRole('dialog')
    fireEvent.change(within(renameDialog).getByPlaceholderText(en.groupNamePh), { target: { value: 'daily' } })
    fireEvent.click(within(renameDialog).getByRole('button', { name: en.groupRenameSave }))
    expect(await screen.findByText('daily')).toBeTruthy()
    expect(screen.queryByText('work')).toBeNull()

    // Delete via overflow menu + confirm.
    const dailyRow = screen.getByText('daily').closest('[class*="groupRow"]') as HTMLElement
    fireEvent.click(within(dailyRow).getByRole('button', { name: en.groupMore }))
    fireEvent.click(await screen.findByRole('menuitem', { name: en.groupDelete }))
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

  it('the Add members button lists installed plugins and adds them via set-members', async () => {
    const state = makeFake({ 'dsh-loop': '^1.0.0', 'dsh-notify': '^1.0.0' })
    state.groups['work'] = ['dsh-loop']
    state.groupOrder.push('work')
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    await openGroupsView()

    // Only dsh-notify is a candidate: dsh-loop is already a member.
    fireEvent.click(await screen.findByRole('button', { name: en.groupAdd }))
    const addDialog = await screen.findByRole('dialog')
    fireEvent.click(within(addDialog).getByRole('checkbox', { name: /dsh-notify/ }))
    fireEvent.click(within(addDialog).getByRole('button', { name: en.groupAddConfirm.replace('{0}', '1') }))
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

  it('keeps themes out of the plugin member picker', async () => {
    const state = makeFake({ 'dsh-loop': '^1.0.0', 'whale-skin': '^1.0.0' })
    state.groups['looks'] = []
    state.groupOrder.push('looks')
    render(<MarketSection {...props()} />)
    await screen.findByText('whale-skin')
    await openGroupsView()
    fireEvent.click(await screen.findByRole('button', { name: en.groupAdd }))
    const addDialog = await screen.findByRole('dialog')
    expect(within(addDialog).queryByRole('checkbox', { name: /whale-skin/ })).toBeNull()
    expect(within(addDialog).getByRole('checkbox', { name: /dsh-loop/ })).toBeTruthy()
  })

  it('chooses one theme for a group from the theme slot', async () => {
    const state = makeFake({ 'dsh-loop': '^1.0.0', 'whale-skin': '^1.0.0' })
    state.groups['looks'] = ['dsh-loop']
    state.groupOrder.push('looks')
    render(<MarketSection {...props()} />)
    await screen.findByText('whale-skin')
    await openGroupsView()

    fireEvent.click(await screen.findByRole('button', { name: en.groupPickTheme }))
    const themeDialog = await screen.findByRole('dialog')
    fireEvent.click(within(themeDialog).getByRole('radio', { name: /whale-skin/ }))
    fireEvent.click(within(themeDialog).getByRole('button', { name: en.groupThemeUse }))
    await waitFor(() => {
      const set = fetchCalls.find(c => c.path === '/dsh-market/groups' && c.body?.action === 'set-members')
      expect(set?.body).toEqual({ action: 'set-members', name: 'looks', members: ['dsh-loop', 'whale-skin'] })
    })
    fireEvent.click(await screen.findByRole('button', { name: en.groupChangeTheme }))
    const again = await screen.findByRole('dialog')
    expect(within(again).getByText(en.groupThemeCurrent)).toBeTruthy()
    fireEvent.click(within(again).getByRole('button', { name: en.groupThemeRemove }))
    await waitFor(() => {
      const set = fetchCalls.filter(c => c.path === '/dsh-market/groups' && c.body?.action === 'set-members')
      expect(set.at(-1)?.body).toEqual({ action: 'set-members', name: 'looks', members: ['dsh-loop'] })
    })
  })

  it('dismisses a pending group delete', async () => {
    const state = makeFake({ 'dsh-loop': '^1.0.0' })
    state.groups['work'] = ['dsh-loop']
    state.groupOrder.push('work')
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    await openGroupsView()
    const groupRow = screen.getByText('work').closest('[class*="groupRow"]') as HTMLElement
    fireEvent.click(within(groupRow).getByRole('button', { name: en.groupMore }))
    fireEvent.click(await screen.findByRole('menuitem', { name: en.groupDelete }))
    fireEvent.click(within(groupRow).getByRole('button', { name: en.cancel }))
    expect(within(groupRow).getByRole('button', { name: en.groupMore })).toBeTruthy()
    expect(within(groupRow).queryByRole('button', { name: en.groupConfirmDelete })).toBeNull()
  })

  it('shows the real activation state instead of Active for an inert plugin', async () => {
    makeFake(
      { 'dsh-loop': '^1.0.0' },
      { 'dsh-loop': { state: 'inert', reasons: [], bundle: false, hot: false } },
    )
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    await openGroupsView()
    const row = screen.getByText('dsh-loop').closest('[class*="ungroupedRow"]') as HTMLElement
    expect(within(row).getByText(en.groupStateInert)).toBeTruthy()
    expect(within(row).queryByText(en.stateLive)).toBeNull()
  })

  it('filters the groups view from the installed search box', async () => {
    makeFake({ 'dsh-loop': '^1.0.0', 'dsh-notify': '^1.0.0' })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    await openGroupsView()
    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: 'notify' } })
    await waitFor(() => {
      expect(screen.queryByText('dsh-loop')).toBeNull()
      expect(screen.getByText('dsh-notify')).toBeTruthy()
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

describe('incompatible install (#758)', () => {
  it('does not ask for a restart when the installed plugin cannot run on this dsh', async () => {
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: {}, live: [] },
      // Keep the host-side pending-restart fallback out of the assertion.
      '/dsh-market/status': { active: false, pnpm: true, boot: 'boot-1', restart: false, installed: {} },
      '/dsh-market/updates': { updates: {} },
      '/dsh-market/install': {
        ok: true,
        hot: false,
        installed: { 'dsh-loop': '^1.0.0' },
        activation: {
          'dsh-loop': { state: 'incompatible', hot: false, bundle: true, reasons: ['needs a newer dsh; upgrading dsh will not help'] },
        },
      },
    })
    render(<MarketSection {...props()} />)
    await vi.waitFor(() => { screen.getByText('dsh-loop') })
    // Same installed-cache caveat as the #73 spec above.
    await vi.waitFor(() => { screen.getByRole('button', { name: en.tabInstalled }) })
    let card: HTMLElement | null = screen.getByText('dsh-loop')
    while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
      card = card.parentElement
    }
    expect(card).not.toBeNull()
    fireEvent.click(within(card!).getByRole('button', { name: en.install }))
    await vi.waitFor(() => { screen.getByRole('button', { name: en.confirmInstall }) })
    fireEvent.click(screen.getByRole('button', { name: en.confirmInstall }))
    // Wait until the install response has been fully applied: the card tells
    // the user why the plugin cannot run. Only then is the banner count
    // meaningful — checking too early passes on the unfixed code too.
    await vi.waitFor(() => {
      expect(screen.getAllByText(re(en.stateIncompatible)).length).toBeGreaterThan(0)
    })
    expect(fetchCalls.some(call => call.path === '/dsh-market/install')).toBe(true)
    // The install succeeded, but no restart can make this plugin run —
    // the banner would promise a fix that never comes.
    expect(screen.queryAllByText(re(en.restartBanner)).length).toBe(0)
    expect(sessionStorage.getItem('dshm-restart') ?? '').not.toContain('dsh-loop')
  })
})

describe('landing tab after an install (#825)', () => {
  it('opens on Discover the next time, not on Installed', async () => {
    // The success path wrote the one-shot "open on Installed" key without
    // reloading, so it waited in sessionStorage and the NEXT visit to the
    // market landed on Installed. Only a reload hands a tab over.
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: {}, live: [] },
      '/dsh-market/updates': { updates: {} },
      '/dsh-market/install': {
        ok: true,
        hot: true,
        installed: { 'dsh-loop': '^1.0.0' },
        activation: { 'dsh-loop': { state: 'live', hot: true, bundle: true, reasons: ['live via hot mount'] } },
      },
    })
    render(<MarketSection {...props()} />)
    await vi.waitFor(() => { screen.getByText('dsh-loop') })
    await vi.waitFor(() => { screen.getByRole('button', { name: en.tabInstalled }) })
    let card: HTMLElement | null = screen.getByText('dsh-loop')
    while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
      card = card.parentElement
    }
    fireEvent.click(within(card!).getByRole('button', { name: en.install }))
    await vi.waitFor(() => { screen.getByRole('button', { name: en.confirmInstall }) })
    fireEvent.click(screen.getByRole('button', { name: en.confirmInstall }))
    await vi.waitFor(() => {
      expect(fetchCalls.some(call => call.path === '/dsh-market/install')).toBe(true)
      expect(screen.getAllByText(re(en.refreshBanner)).length).toBeGreaterThan(0)
    })
    expect(sessionStorage.getItem('dshm-tab')).toBeNull()
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
    await openCardUninstall()
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
    await openCardUninstall()
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

  it('prioritizes updatable plugins at the top of the installed list', async () => {
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
      '/dsh-market/updates': {
        updates: {
          gamma: { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '2.0.0', updateAvailable: true },
        },
      },
    })
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await screen.findByText('gamma')

    const columns = [...container.querySelectorAll('[class*="masonryCol"]')] as HTMLElement[]
    expect([...columns[0]!.querySelectorAll('[class*="irowNameText"]')].map(row => row.textContent?.trim()))
      .toEqual(['gamma', 'alpha', 'beta', 'delta'])
  })

  it('lists enabled plugins ahead of disabled ones (#745)', async () => {
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
        disabled: ['beta'],
      },
      '/dsh-market/updates': {
        updates: {
          // A pending update on a DISABLED row must not lift it over any
          // enabled one: it sorts inside the group it lands in.
          beta: { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '2.0.0', updateAvailable: true },
        },
      },
    })
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await screen.findByText('delta')

    const columns = [...container.querySelectorAll('[class*="masonryCol"]')] as HTMLElement[]
    expect(columns).toHaveLength(1)
    expect([...columns[0]!.querySelectorAll('[class*="irowNameText"]')].map(row => row.textContent?.trim()))
      .toEqual(['alpha', 'gamma', 'delta', 'beta'])
  })

  it('reorders once when the update check lands, then holds (#631)', async () => {
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

    // `/installed` is a local read; `/updates` probes every package over the
    // network. The list is therefore ALWAYS painted before the update answer
    // exists, and holding an order fixed against that answer would leave the
    // feature permanently inert. This gate reproduces that ordering exactly:
    // the first updates request stays pending until the test releases it.
    const installedMapFixture = { alpha: '^1.0.0', beta: '^1.0.0', gamma: '^1.0.0', delta: '^1.0.0' }
    const baseFetch = stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: installedMapFixture,
        live: [],
      },
      // Status must agree with the installed listing. When it disagrees, the
      // poll calls refreshInstalled(), which hands `installed` a fresh
      // identity and re-runs the ordering memo for a reason that has nothing
      // to do with this behaviour — masking the very freeze under test.
      '/dsh-market/status': { active: false, pnpm: true, boot: 'boot-1', restart: true, installed: installedMapFixture },
    })
    let releaseUpdates: () => void = () => {}
    const updatesGate = new Promise<void>(resolve => { releaseUpdates = resolve })
    let firstUpdates = true
    vi.stubGlobal('fetch', vi.fn((input: unknown, init?: RequestInit) => {
      const path = String(input).split('?')[0]
      if (path === '/dsh-market/updates' && firstUpdates) {
        firstUpdates = false
        return updatesGate.then(() => new Response(JSON.stringify({
          updates: { gamma: { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '2.0.0', updateAvailable: true } },
        }), { status: 200 }))
      }
      return baseFetch(input, init)
    }))

    const { container } = render(<MarketSection {...props()} preferredSubsectionId="installed" />)
    await screen.findByText('delta')

    const names = () => [...container.querySelectorAll('[class*="masonryCol"] [class*="irowNameText"]')]
      .map(row => row.textContent?.trim())
    // Painted before the check answers: manifest order, no sorting invented.
    expect(names()).toEqual(['alpha', 'beta', 'gamma', 'delta'])

    // The check lands — this is the one moment the order is allowed to move.
    // Flushed with `act`, NOT `waitFor`: waiting lets the 2s status poll fire,
    // and a poll can hand `installed` a fresh identity, which re-runs the memo
    // for an unrelated reason and would let this test pass without the fix.
    await act(async () => { releaseUpdates() })
    await act(async () => {})
    expect(names()).toEqual(['gamma', 'alpha', 'beta', 'delta'])

    // ...and then it holds. A filter round trip must not reshuffle rows.
    const searchInput = screen.getByPlaceholderText(en.searchPh)
    fireEvent.change(searchInput, { target: { value: 'a' } })
    fireEvent.change(searchInput, { target: { value: '' } })
    expect(names()).toEqual(['gamma', 'alpha', 'beta', 'delta'])

    // Dismissing the update must not reshuffle them either. `ignoredUpdateSet`
    // sits deliberately OUTSIDE the ordering's dependencies: a dismissed row
    // keeps its place rather than sliding down under a pointer that is already
    // aiming at the row below. (The other inputs are the reason a second
    // `/updates` payload is not asserted here: every path that refetches one
    // also hands `installed` a fresh identity — the poll does it through
    // `refreshInstalled()` — so that case would report the memo re-running for
    // an unrelated reason, not the freeze under test.)
    await ignoreRowUntilRestart('gamma')
    await act(async () => {})
    expect(names()).toEqual(['gamma', 'alpha', 'beta', 'delta'])
  })
})

describe('a plugin whose settings read a name nothing serves (#810)', () => {
  // The reported shape: `dsh-comfyui-canvas`'s client asks its config from
  // "dsh-comfyui-canvas" while its own entry id is "comfyui-canvas", so its
  // settings read nothing and its panel falls back to a hardcoded port. The
  // row has to carry both halves — what it asks for, and what it should.
  const installed = {
    profile: 'web', installed: { 'dsh-comfyui-canvas': '^0.1.13' }, live: [], disabled: [], groups: {}, groupOrder: [], favorites: [],
    configNamespaces: [{
      name: 'dsh-comfyui-canvas',
      namespaces: ['dsh-comfyui-canvas'],
      ownEntryIds: ['comfyui-canvas'],
    }],
  }

  it('names the mistake and the value to write instead', async () => {
    stubFetch({ '/dsh-market/installed': installed })

    render(<MarketSection {...props()} preferredSubsectionId="installed" />)

    // Found by its own sentence: the package name alone is on the row below
    // this banner too, which is why the assertion cannot key on it.
    const notice = await screen.findByText(/cannot read its config/)
    expect(notice.textContent).toContain('dsh-comfyui-canvas')
    expect(notice.textContent).toContain('comfyui-canvas')
    // The consequence and whose problem it is, not just the fact: a user who
    // cannot tell "the plugin is broken" from "DSH is broken" is stuck.
    expect(notice.textContent).toContain('cannot read its config')
    expect(notice.textContent).toContain('the market cannot change it')
  })

  it('says nothing at all when no plugin has the problem', async () => {
    stubFetch({
      '/dsh-market/installed': { ...installed, configNamespaces: undefined },
    })

    render(<MarketSection {...props()} preferredSubsectionId="installed" />)

    await screen.findByText('dsh-comfyui-canvas')
    expect(screen.queryByText(new RegExp(re('cannot read its config').source))).toBeNull()
  })
})

describe('a plugin the market had to stop declaring (#663)', () => {
  // The plugin is NOT in `installed` — that is the whole point: the
  // declaration is gone, so nothing else in the UI can explain it.
  const brokenInstalled = {
    profile: 'web', installed: {}, live: [], disabled: [], groups: {}, groupOrder: [], favorites: [],
    brokenPlugins: { 'dsh-pet': { spec: '^1.4.0', reason: 'incomplete-build-locked', at: '2026-09-24T00:00:00.000Z' } },
  }

  it('names no cause when the removal followed a cancel (#663)', async () => {
    // A cancel that landed mid-swap leaves the same empty shell as the
    // open-file refusal, but nothing told the market WHY pnpm was stuck. The
    // locked wording ("the running DSH blocked the update") would state a
    // cause that was never observed.
    stubFetch({
      '/dsh-market/installed': {
        ...brokenInstalled,
        brokenPlugins: { 'dsh-pet': { spec: '^1.4.0', reason: 'incomplete-build-cancelled', at: '2026-10-08T00:00:00.000Z' } },
      },
    })

    render(<MarketSection {...props()} preferredSubsectionId="installed" />)

    await screen.findByText(en.brokenPluginTitleCancelled.replace('{0}', 'dsh-pet'))
    expect(screen.getByText(en.brokenPluginBodyCancelled)).toBeTruthy()
    expect(screen.queryByText(en.brokenPluginBody)).toBeNull()
  })

  it('says what happened instead of leaving the plugin silently gone', async () => {
    stubFetch({ '/dsh-market/installed': brokenInstalled })

    render(<MarketSection {...props()} preferredSubsectionId="installed" />)

    await screen.findByText(en.brokenPluginTitle.replace('{0}', 'dsh-pet'))
    expect(screen.getByText(en.brokenPluginBody)).toBeTruthy()
    // Rendered even though the list is empty: a plugin that was the only one
    // installed leaves "no plugins yet" and this notice side by side, and the
    // notice is the only half telling the truth.
    expect(screen.getByText(en.installedEmpty)).toBeTruthy()
  })

  it('leads to the catalog entry, where installing it again is one click', async () => {
    stubFetch({ '/dsh-market/installed': brokenInstalled })

    render(<MarketSection {...props()} preferredSubsectionId="installed" />)
    const action = await screen.findByRole('button', { name: en.brokenPluginAction })
    fireEvent.click(action)

    // The query the user needs, already typed: a name they may not remember,
    // now that the installed row that carried it is gone.
    expect((screen.getByPlaceholderText(en.searchPh) as HTMLInputElement).value).toBe('dsh-pet')
  })

  it('takes the notice away when the plugin comes back', async () => {
    // Reinstalled: declared again, healthy, and no longer in brokenPlugins.
    // The market drops the entry server-side on a successful install, and the
    // client reads it from the same refresh every install already triggers —
    // so the notice leaves with the plugin's return, not on the next reload.
    const answered = [
      brokenInstalled,
      { ...brokenInstalled, installed: { 'dsh-pet': '^1.4.0' }, brokenPlugins: {} },
    ]
    let call = 0
    stubFetch({ '/dsh-market/installed': () => answered[Math.min(call++, answered.length - 1)] })

    render(<MarketSection {...props()} preferredSubsectionId="installed" />)
    await screen.findByText(en.brokenPluginTitle.replace('{0}', 'dsh-pet'))

    // Re-entering the tab is what the client does after any operation.
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await waitFor(() => {
      expect(screen.queryByText(en.brokenPluginTitle.replace('{0}', 'dsh-pet'))).toBeNull()
    })
  })
})

describe('a removed-declaration notice the user can put away (#763)', () => {
  // The notice is durable on purpose, but the reporter's plugin was gone from
  // the catalog, so "Find this plugin" searched for nothing and the banner was
  // unremovable — surviving refresh, restart, updating the market itself, and
  // every other plugin operation. Hiding the message has to be a thing the user
  // can do, and it must not read as "this plugin is fixed".

  const brokenInstalled = {
    profile: 'web', installed: {}, live: [], disabled: [], groups: {}, groupOrder: [], favorites: [],
    brokenPlugins: { 'dsh-pet': { spec: '^1.4.0', reason: 'incomplete-build-locked', at: '2026-09-24T00:00:00.000Z' } },
  }
  const twoBroken = {
    ...brokenInstalled,
    brokenPlugins: {
      ...brokenInstalled.brokenPlugins,
      'dsh-ours': { spec: 'github:o/ours', reason: 'incomplete-build-locked', at: '2026-09-24T00:00:00.000Z' },
    },
  }

  /**
   * The notice row for one plugin, so a shared button label stays unambiguous.
   * The title's parent holds the text only; the row is its grandparent, which is
   * where the actions live.
   */
  function brokenRow(name: string): HTMLElement {
    const text = screen.getByText(en.brokenPluginTitle.replace('{0}', name)).closest('div')
    if (text === null) throw new Error(`no notice text for ${name}`)
    const row = text.parentElement
    if (row === null) throw new Error(`no notice row for ${name}`)
    return row
  }

  it('offers the way out next to the existing search, and keeps the search', async () => {
    stubFetch({ '/dsh-market/installed': brokenInstalled })

    render(<MarketSection {...props()} preferredSubsectionId="installed" />)
    await screen.findByText(en.brokenPluginTitle.replace('{0}', 'dsh-pet'))

    // Both, not either: one finds the plugin back, the other says the user is
    // done hearing about it. Taking the notice away is not the same decision.
    expect(screen.getByRole('button', { name: en.brokenPluginAction })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.brokenPluginDismiss })).toBeTruthy()
  })

  it('names what the action does — it does not say the plugin was fixed', async () => {
    // The copy is the only thing standing between "hide this message" and
    // "this is sorted". A user who reads the button as a repair will not go
    // looking for the directory that is still on disk.
    expect(en.brokenPluginDismiss).toMatch(/stop showing|dismiss|hide/i)
    expect(en.brokenPluginDismiss).not.toMatch(/fix|repair|reinstall|remove plugin/i)
    expect(zh.brokenPluginDismiss).not.toMatch(/修复|重装|已解决|卸载/)
  })

  it('takes only that notice away, and the other one stays', async () => {
    const answered = [twoBroken, { ...twoBroken, brokenPlugins: { 'dsh-ours': twoBroken.brokenPlugins['dsh-ours'] } }]
    let call = 0
    stubFetch({
      '/dsh-market/installed': () => answered[Math.min(call++, answered.length - 1)],
      '/dsh-market/dismiss-broken': { ok: true, brokenPlugins: { 'dsh-ours': twoBroken.brokenPlugins['dsh-ours'] } },
    })

    render(<MarketSection {...props()} preferredSubsectionId="installed" />)
    await screen.findByText(en.brokenPluginTitle.replace('{0}', 'dsh-pet'))
    expect(screen.getByText(en.brokenPluginTitle.replace('{0}', 'dsh-ours'))).toBeTruthy()

    // Scoped to this plugin's own row: with two notices on screen the two
    // buttons carry the same label, and clicking "the first one" would be
    // asserting an implementation detail of the list order.
    fireEvent.click(within(brokenRow('dsh-pet')).getByRole('button', { name: en.brokenPluginDismiss }))

    await waitFor(() => {
      expect(screen.queryByText(en.brokenPluginTitle.replace('{0}', 'dsh-pet'))).toBeNull()
    })
    // A different plugin's absence is still a fact the user has not been told
    // is no longer worth telling.
    expect(screen.getByText(en.brokenPluginTitle.replace('{0}', 'dsh-ours'))).toBeTruthy()
    expect(fetchCalls).toContainEqual(
      expect.objectContaining({ path: '/dsh-market/dismiss-broken', method: 'POST', body: { name: 'dsh-pet' } }),
    )
  })

  it('puts the notice back when the dismiss fails, and says why', async () => {
    // A dismissal that silently did nothing is worse than no button at all: the
    // user would believe they had been told the truth about their own profile.
    stubFetch({
      '/dsh-market/installed': brokenInstalled,
      '/dsh-market/dismiss-broken': { __status: 500, error: 'state.json is locked' },
    })

    render(<MarketSection {...props()} preferredSubsectionId="installed" />)
    await screen.findByText(en.brokenPluginTitle.replace('{0}', 'dsh-pet'))

    fireEvent.click(screen.getByRole('button', { name: en.brokenPluginDismiss }))

    await waitFor(() => {
      expect(screen.getByText(en.brokenPluginTitle.replace('{0}', 'dsh-pet'))).toBeTruthy()
    })
    // The server's own reason, next to a notice that is still on screen. It is
    // the only part of the failure the user can act on, so it is shown verbatim.
    await waitFor(() => {
      expect(screen.getByText(/state\.json is locked/)).toBeTruthy()
    })
  })

  it('restores a failed dismiss even when a later one on another plugin succeeded', async () => {
    // Two notices, two clicks. B's reply lands first and succeeds; A's arrives
    // later and FAILS. A must come back, and B must stay gone.
    //
    // A single generation counter across both names is what breaks this: B
    // becomes the newest generation, so A's failure is discarded and A stays
    // hidden in the panel while the server still has it. The user is then told
    // nothing is wrong and has to reload to find out.
    const pet = twoBroken.brokenPlugins['dsh-pet']
    const base = stubFetch({ '/dsh-market/installed': twoBroken })
    let releaseA = (): void => {}
    const aPending = new Promise<void>((resolve) => { releaseA = resolve })
    let calls = 0
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
      if (!String(input).endsWith('/dsh-market/dismiss-broken')) return base(input, init)
      calls += 1
      const name = (init?.body !== undefined ? JSON.parse(String(init.body)) as { name: string } : { name: '' }).name
      if (name === 'dsh-pet') {
        // A: slow, and it fails.
        return aPending.then(() => new Response(JSON.stringify({ error: 'state.json is locked' }), { status: 500 }))
      }
      // B: immediate success, answering with the server's remaining map.
      return Promise.resolve(new Response(JSON.stringify({ ok: true, brokenPlugins: { 'dsh-pet': pet } }), { status: 200 }))
    })

    render(<MarketSection {...props()} preferredSubsectionId="installed" />)
    await screen.findByText(en.brokenPluginTitle.replace('{0}', 'dsh-pet'))
    await screen.findByText(en.brokenPluginTitle.replace('{0}', 'dsh-ours'))

    fireEvent.click(within(brokenRow('dsh-pet')).getByRole('button', { name: en.brokenPluginDismiss }))
    fireEvent.click(within(brokenRow('dsh-ours')).getByRole('button', { name: en.brokenPluginDismiss }))
    await act(async () => { await new Promise((r) => { setTimeout(r, 0) }) })
    expect(calls).toBe(2)

    // B's success already landed; now let A's failure arrive.
    await act(async () => { releaseA(); await aPending; await new Promise((r) => { setTimeout(r, 0) }) })

    // A is back, with its own record and its own reason.
    expect(screen.getByText(en.brokenPluginTitle.replace('{0}', 'dsh-pet'))).toBeTruthy()
    await screen.findByText(/state\.json is locked/)
    // ...and B stayed dismissed. B's success is not undone by A's late failure,
    // and A's failure did not bring B back either.
    expect(screen.queryByText(en.brokenPluginTitle.replace('{0}', 'dsh-ours'))).toBeNull()
  })

  it('does not let a stale dismiss reply erase a notice the panel already knows about', async () => {
    // The server has other ways to add a record than this panel: a failed
    // update drops one (#663). A reply is a snapshot from the moment the
    // request ran, so it can be missing a record the panel has since learned
    // about. Adopting that map wholesale would drop it — the user would never
    // be told about a plugin that just broke.
    //
    // The skew is set up directly: the panel loads with a third record, and the
    // server's reply does not have it, which is what an out-of-date reply looks
    // like from here.
    const withNewcomer = {
      ...twoBroken,
      brokenPlugins: { ...twoBroken.brokenPlugins, 'dsh-newcomer': { spec: '^2.0.0', reason: 'incomplete-build-locked', at: '2026-09-29T00:00:00.000Z' } },
    }
    const base = stubFetch({ '/dsh-market/installed': withNewcomer })
    let release = (): void => {}
    const pending = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
      if (!String(input).endsWith('/dsh-market/dismiss-broken')) return base(input, init)
      return pending.then(() => new Response(
        // A reply from before `dsh-newcomer` was ever recorded.
        JSON.stringify({ ok: true, brokenPlugins: { 'dsh-ours': twoBroken.brokenPlugins['dsh-ours'] } }), { status: 200 },
      ))
    })

    render(<MarketSection {...props()} preferredSubsectionId="installed" />)
    await screen.findByText(en.brokenPluginTitle.replace('{0}', 'dsh-pet'))
    expect(screen.getByText(en.brokenPluginTitle.replace('{0}', 'dsh-newcomer'))).toBeTruthy()

    fireEvent.click(within(brokenRow('dsh-pet')).getByRole('button', { name: en.brokenPluginDismiss }))
    await act(async () => { release(); await pending; await new Promise((r) => { setTimeout(r, 0) }) })

    // The dismissal stuck...
    expect(screen.queryByText(en.brokenPluginTitle.replace('{0}', 'dsh-pet'))).toBeNull()
    // ...and the reply did not take the other two with it.
    expect(screen.getByText(en.brokenPluginTitle.replace('{0}', 'dsh-newcomer'))).toBeTruthy()
    expect(screen.getByText(en.brokenPluginTitle.replace('{0}', 'dsh-ours'))).toBeTruthy()
  })

  it('re-applies the dismissal when a stale /installed read puts the notice back', async () => {
    // An operation re-reads `/installed` when it finishes (that read is what
    // keeps the rest of the list trustworthy). A read already in flight when
    // the user clicks dismiss is a snapshot from before the click, so it can
    // still carry the notice — and it lands AFTER the optimistic removal.
    //
    // Success cannot simply "keep what we did": by the time the server says
    // yes, the panel may have been re-populated by that older read. The server
    // is now clear while the notice is on screen again and the user is told
    // nothing. So success deletes its own key once more — that one name only,
    // never the reply's whole map.
    const listing = {
      profile: 'web', installed: { 'dsh-ours': '^1.0.0' }, live: ['dsh-ours'], disabled: [], groups: {}, groupOrder: [], favorites: [], blocked: [],
      brokenPlugins: { 'dsh-pet': { spec: '^1.4.0', reason: 'incomplete-build-locked', at: '2026-09-24T00:00:00.000Z' } },
    }
    const base = stubFetch({
      '/dsh-market/installed': listing,
      '/dsh-market/updates': { updates: { 'dsh-ours': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
      '/dsh-market/update': { ok: true },
    })
    let releaseDismiss = (): void => {}
    const dismissPending = new Promise<void>((resolve) => { releaseDismiss = resolve })
    let releaseStaleRead = (): void => {}
    const staleReadPending = new Promise<void>((resolve) => { releaseStaleRead = resolve })
    let installedCalls = 0
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
      const path = String(input).split('?')[0]
      if (path === '/dsh-market/dismiss-broken') {
        return dismissPending.then(() => new Response(JSON.stringify({ ok: true, brokenPlugins: {} }), { status: 200 }))
      }
      if (path === '/dsh-market/installed') {
        installedCalls += 1
        if (installedCalls === 1) return base(input, init)
        // The read the update kicked off: it started before the dismissal, so
        // it still reports the notice.
        return staleReadPending.then(() => new Response(JSON.stringify(listing), { status: 200 }))
      }
      return base(input, init)
    })

    render(<MarketSection {...props()} preferredSubsectionId="installed" />)
    await screen.findByText(en.brokenPluginTitle.replace('{0}', 'dsh-pet'))
    const update = await screen.findByRole('button', { name: en.update })

    // The update's own re-read is now in flight, and held.
    fireEvent.click(update)
    await waitFor(() => { expect(installedCalls).toBeGreaterThan(1) })

    // The user dismisses the notice while that older read is still out.
    fireEvent.click(within(brokenRow('dsh-pet')).getByRole('button', { name: en.brokenPluginDismiss }))
    await waitFor(() => {
      expect(screen.queryByText(en.brokenPluginTitle.replace('{0}', 'dsh-pet'))).toBeNull()
    })

    // ...and the older read lands, putting the notice back.
    await act(async () => { releaseStaleRead(); await staleReadPending; await new Promise((r) => { setTimeout(r, 0) }) })
    expect(screen.getByText(en.brokenPluginTitle.replace('{0}', 'dsh-pet'))).toBeTruthy()

    // Now the server answers, and it agrees the notice is gone.
    await act(async () => { releaseDismiss(); await dismissPending; await new Promise((r) => { setTimeout(r, 0) }) })

    // The panel must agree with the server, not with its own older read.
    await waitFor(() => {
      expect(screen.queryByText(en.brokenPluginTitle.replace('{0}', 'dsh-pet'))).toBeNull()
    })
  })

  it('ignores a stale dismiss reply for a plugin that is already gone (#763)', async () => {
    // Both replies are successes here, and the first is deliberately the slower
    // one: it still lists dsh-ours, because at the moment that request ran the
    // second notice had not been dismissed yet. Applying a whole-map reply from
    // after the second click would put back a row the user just put away.
    const ours = twoBroken.brokenPlugins['dsh-ours']
    const base = stubFetch({ '/dsh-market/installed': twoBroken })
    let releaseFirst = (): void => {}
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve })
    let dismisses = 0
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
      if (!String(input).endsWith('/dsh-market/dismiss-broken')) return base(input, init)
      dismisses += 1
      const isFirst = dismisses === 1
      const body = isFirst ? { 'dsh-ours': ours } : {}
      if (!isFirst) return Promise.resolve(new Response(JSON.stringify({ ok: true, brokenPlugins: body }), { status: 200 }))
      // Resolved only when the test says so, so the reply order is fixed
      // rather than left to timer jitter.
      return firstPending.then(() => new Response(JSON.stringify({ ok: true, brokenPlugins: body }), { status: 200 }))
    })

    render(<MarketSection {...props()} preferredSubsectionId="installed" />)
    await screen.findByText(en.brokenPluginTitle.replace('{0}', 'dsh-pet'))
    await screen.findByText(en.brokenPluginTitle.replace('{0}', 'dsh-ours'))

    fireEvent.click(within(brokenRow('dsh-pet')).getByRole('button', { name: en.brokenPluginDismiss }))
    fireEvent.click(within(brokenRow('dsh-ours')).getByRole('button', { name: en.brokenPluginDismiss }))
    // The second reply lands first; only now is the stale one allowed to arrive.
    await act(async () => { releaseFirst(); await firstPending; await new Promise((r) => { setTimeout(r, 0) }) })

    // Both gone, and neither resurrected by the other's reply.
    await waitFor(() => {
      expect(screen.queryByText(en.brokenPluginTitle.replace('{0}', 'dsh-pet'))).toBeNull()
    })
    expect(screen.queryByText(en.brokenPluginTitle.replace('{0}', 'dsh-ours'))).toBeNull()
  })

  it('leaves the notice alone for a plugin that is merely outdated', async () => {
    // The dismiss control belongs to the removed-declaration notice only. An
    // ordinary "there is a newer version" row is a different fact with its own
    // affordances, and giving it this button would be a way to make a normal
    // state unreadable.
    //
    // Anchored on the ordinary row actually being there: without that, this
    // would also pass on a panel that rendered nothing at all, which is the
    // version of the test that proved nothing.
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web', installed: { 'dsh-pet': '^1.0.0' }, live: [], disabled: [], groups: {}, groupOrder: [], favorites: [], blocked: [],
        brokenPlugins: {},
      },
      '/dsh-market/updates': { updates: { 'dsh-pet': { kind: 'npm', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
    })

    render(<MarketSection {...props()} preferredSubsectionId="installed" />)

    // The ordinary row's real affordances, present and accounted for.
    expect(await screen.findByRole('button', { name: en.update })).toBeTruthy()
    expect(screen.getByRole('button', { name: re(en.notesLink) })).toBeTruthy()
    // The panel named the real version, so this really is an update row and
    // not an empty list that happens to lack a dismiss button.
    expect(screen.getByText(en.hostUpdateReady.replace('{0}', 'v1.2.0'))).toBeTruthy()
    // Same plugin, and it is on screen — as an installed row with an update
    // pending. What it must NOT carry is the removed-declaration notice: the
    // title is a different string from the row name, so this can tell the two
    // apart rather than just finding the name somewhere.
    expect(screen.getByText('dsh-pet')).toBeTruthy()
    expect(screen.queryByText(en.brokenPluginTitle.replace('{0}', 'dsh-pet'))).toBeNull()
    // ...and so no way to dismiss one.
    expect(screen.queryByRole('button', { name: en.brokenPluginDismiss })).toBeNull()
  })
})

describe('browser page translation (#293)', () => {
  it('marks the market subtree untranslatable, so a translated page cannot unmount it', () => {
    // Chrome and Edge translate by REPLACING text nodes. React then tries to
    // remove a node its parent no longer has, throws NotFoundError, and the
    // whole section unmounts — the blank panel, with the export-log button
    // gone with it, which is why every log requested from that state came
    // back empty. @apdc111 identified it on #293 after the same shape went
    // unreproduced in #286 and #241.
    stubFetch({})
    render(<MarketSection {...props()} />)
    const root = document.querySelector('[data-dsh-market-root]')
    expect(root).toBeTruthy()
    expect(root?.getAttribute('translate')).toBe('no')
    // `notranslate` says the same thing to engines older than the attribute.
    expect(root?.className).toContain('notranslate')
  })
})

describe('local-dev restore', () => {
  /** Restore lives in the row's more menu: it replaces the checkout and cannot be undone. */
  async function chooseRestoreRelease() {
    fireEvent.click((await screen.findAllByRole('button', { name: en.groupMore }))[0]!)
    const item = await screen.findByRole('menuitem', { name: en.restoreOnline })
    await waitFor(() => {
      expect(item.hasAttribute('disabled') || item.getAttribute('aria-disabled') === 'true').toBe(false)
    })
    fireEvent.click(item)
  }

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
    fireEvent.click(await screen.findByRole('button', { name: en.restoreOnline }))
    expect(await screen.findByText((content: string) => content.includes(en.restoreNameOnlyHint.slice(0, 40)))).toBeTruthy()
    expect(fetchCalls.some(call => call.path === '/dsh-market/update')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en.restoreProceed }))
    await waitFor(() => {
      expect(fetchCalls.some(call =>
        call.path === '/dsh-market/update'
        && call.body?.name === 'dsh-better-sidebar'
        && call.body?.restore === true,
      )).toBe(true)
    })
  })

  it('lets a replaceable local package silence its reminder, with one switch entry', async () => {
    // It has a release feed (restoreRequired + updateAvailable) and so counts
    // toward reminders; hiding the saved exemption would leave no way out.
    stubFetch({
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
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(await screen.findByRole('button', { name: en.restoreOnline })).toBeTruthy()
    await openRowMenu('dsh-better-sidebar')
    expect(await screen.findByRole('menuitem', { name: en.updateExemptAdd })).toBeTruthy()
    // The action band already carries the switch; the menu does not repeat it.
    expect(screen.queryByRole('menuitem', { name: en.restoreOnline })).toBeNull()
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

  it('skips disabled plugins from Update all', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0', 'dsh-notify': '^1.0.0', 'dsh-third': '^1.0.0' },
        live: [],
        disabled: ['dsh-third'],
      },
      '/dsh-market/updates': {
        updates: {
          'dsh-loop': { kind: 'npm', version: '1.0.0', latest: '1.1.0', updateAvailable: true },
          'dsh-notify': { kind: 'npm', version: '1.0.0', latest: '1.1.0', updateAvailable: true },
          'dsh-third': { kind: 'npm', version: '1.0.0', latest: '1.1.0', updateAvailable: true },
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
  })

  it('says a name-only catalog match is unverified, and names whose plugin it is (#485)', async () => {
    // The local copy declares no repository, so the catalog row below agreed
    // on nothing but the package name — and its owner may be a stranger.
    // Presenting that as "restore to your online source" is how @liuwenji007's
    // fork was offered a different author's plugin of the same name.
    stubFetch({
      '/dsh-market/registry': {
        source: 'live',
        registry: {
          ...REGISTRY,
          plugins: [
            ...REGISTRY.plugins,
            {
              name: 'dsh-humanizer', owner: 'lynote-ai', url: 'https://github.com/lynote-ai/dsh-humanizer',
              category: 'tools', npm: 'dsh-humanizer', stars: 3,
              added: '2026-08-20', description: { en: 'Humanizer', zh: '拟人化' }, install: '',
            },
          ],
        },
      },
      '/dsh-market/installed': {
        profile: 'web', installed: { 'dsh-humanizer': 'link:/Users/me/dsh-humanizer' }, live: [],
      },
      '/dsh-market/updates': { updates: { 'dsh-humanizer': { kind: 'linked', version: '0.1.0', updateAvailable: false } } },
      '/dsh-market/update': { ok: true },
    })
    render(<MarketSection {...props()} />)
    // Wait for the CATALOG, not just the installed list: the restore dialog
    // needs it to resolve an entry, and clicking before it lands is a no-op
    // that reads as "the button did nothing".
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await chooseRestoreRelease()
    expect(await screen.findByText((content: string) => content.includes(en.restoreNameOnlyHint.slice(0, 40)))).toBeTruthy()
    // The owner is on screen to be checked against, not buried in a link.
    expect(await screen.findByText((content: string) => content.includes('lynote-ai'))).toBeTruthy()
    // A distinctive PHRASE, not a prefix: the name-only hint quotes the plain
    // one's first sentence verbatim, so a prefix match cannot tell them apart.
    expect(screen.queryByText((content: string) => content.includes('installs the online version'))).toBeNull()
  })

  it('asks in a modal before swapping a linked plugin to the catalog', async () => {
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': 'link:../dsh-loop' }, live: [] },
      '/dsh-market/updates': { updates: { 'dsh-loop': { kind: 'linked', version: '1.0.0', updateAvailable: false } } },
      '/dsh-market/update': { ok: true },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(await screen.findByText(`v1.0.0 · ${en.linkedDev}`)).toBeTruthy()
    // `../dsh-loop` is relative to the profile; a copied copy would point nowhere.
    expect(screen.getByText('../dsh-loop')).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.copyPath })).toBeNull()
    // No release feed behind a checkout: the saved do-not-remind has nothing to act on.
    fireEvent.click((await screen.findAllByRole('button', { name: en.groupMore }))[0]!)
    expect(await screen.findByRole('menuitem', { name: en.uninstall })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: en.updateExemptAdd })).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: en.groupMore })[0]!)
    await chooseRestoreRelease()
    expect(await screen.findByText((content: string) => content.includes(en.restoreNameOnlyHint.slice(0, 40)))).toBeTruthy()
    expect(fetchCalls.some(call => call.path === '/dsh-market/update')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en.restoreProceed }))
    await waitFor(() => {
      expect(fetchCalls.some(call =>
        call.path === '/dsh-market/update' && call.body?.name === 'dsh-loop' && call.body?.restore === true,
      )).toBe(true)
    })
  })

  it('shows the tail of a checkout path and copies the whole path', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    const prevClip = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      stubFetch({
        '/dsh-market/installed': { profile: 'web', installed: { 'mystery-plug': 'link:/Users/me/work/plugins/mystery-plug' }, live: [] },
        '/dsh-market/updates': { updates: { 'mystery-plug': { kind: 'linked', version: '0.1.14', updateAvailable: false } } },
      })
      render(<MarketSection {...props()} />)
      fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
      const path = await screen.findByText('…/plugins/mystery-plug')
      expect(path.getAttribute('title')).toBe('/Users/me/work/plugins/mystery-plug')
      expect(screen.getByText(`v0.1.14 · ${en.linkedDev}`)).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: en.copyPath }))
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('/Users/me/work/plugins/mystery-plug'))
      expect(await screen.findByText(en.pathCopied)).toBeTruthy()
    } finally {
      if (prevClip !== undefined) Object.defineProperty(navigator, 'clipboard', prevClip)
      else Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  it('clamps an installed description to three lines with an expand toggle', async () => {
    const scrollHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    const clientHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 200 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 54 })
    try {
      stubFetch({
        '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
        '/dsh-market/updates': { updates: { 'dsh-loop': { kind: 'npm', version: '1.0.0', updateAvailable: false } } },
      })
      const { container } = render(<MarketSection {...props()} />)
      await screen.findByText('dsh-loop')
      fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
      await waitFor(() => expect(container.querySelector('[class*="descClamp3"]')).toBeTruthy())
      let row: HTMLElement | null = container.querySelector('[class*="descClamp3"]')
      while (row !== null && within(row).queryByRole('button', { name: en.descMore }) === null) row = row.parentElement
      fireEvent.click(within(row!).getByRole('button', { name: en.descMore }))
      await waitFor(() => expect(within(row!).queryByRole('button', { name: en.descCollapse })).toBeTruthy())
      expect(row!.querySelector('[class*="descClamp3"]')).toBeNull()
    } finally {
      if (scrollHeightDesc) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeightDesc)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
      if (clientHeightDesc) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeightDesc)
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
    }
  })

  it('names a newer release for a host-installed generation without a button (#497)', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-loop': 'link:../.generations/live/dsh-loop+1.0.0+7aba605c3145/node_modules/dsh-loop' },
        live: [],
      },
      '/dsh-market/updates': {
        updates: { 'dsh-loop': { kind: 'generation', version: '1.0.0', current: '1.0.0', latest: '1.1.0', updateAvailable: false } },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(await screen.findByText(en.hostUpdateReady.replace('{0}', '1.1.0'))).toBeTruthy()
    // The host reconciles its generations at startup: an update applied here
    // would silently revert, and a restore would tear down the host's own
    // install. Neither is offered, and the row is not tagged as local work.
    expect(screen.queryByRole('button', { name: en.update })).toBeNull()
    expect(screen.queryByRole('button', { name: en.restoreOnline })).toBeNull()
    expect(screen.queryByText(en.linkedDev)).toBeNull()
    openRowMenu('dsh-loop')
    expect(screen.queryByRole('menuitem', { name: en.restoreOnline })).toBeNull()
  })

  it('does not offer restore when the linked plugin is not in the catalog', async () => {
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'mystery-plug': 'link:../mystery' }, live: [] },
      '/dsh-market/updates': { updates: { 'mystery-plug': { kind: 'linked', updateAvailable: false } } },
    })
    render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    expect(await screen.findByText('mystery-plug')).toBeTruthy()
    await chooseRestoreRelease()
    expect(await screen.findByText(en.restoreNoCatalog)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.restoreProceed })).toBeNull()
    expect(fetchCalls.some(call => call.path === '/dsh-market/update')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en.gotIt }))
    expect(screen.queryByText(en.restoreNoCatalog)).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: en.groupMore })[0]!)
    expect(screen.getByRole('menuitem', { name: en.uninstall })).toBeTruthy()
  })

  it('does not offer restore when the linked fork disagrees with the only same-named catalog entry', async () => {
    stubFetch({
      '/dsh-market/registry': {
        source: 'snapshot',
        registry: {
          updated: '', count: 1,
          categories: { tools: { en: 'Tools', zh: '工具' } },
          plugins: [
            {
              name: 'dsh-humanizer', owner: 'lynote-ai',
              url: 'https://github.com/lynote-ai/dsh-humanizer',
              category: 'tools', npm: 'dsh-humanizer', stars: 1,
              added: '2026-01-01', description: { en: 'Catalog copy', zh: '目录版' }, install: '',
            },
          ],
        },
      },
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-humanizer': 'link:../dsh-humanizer' },
        live: [],
        repoIdentities: { 'dsh-humanizer': ['handsomeliu/dsh-humanizer'] },
      },
      '/dsh-market/updates': { updates: { 'dsh-humanizer': { kind: 'linked', updateAvailable: false } } },
    })
    render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    await chooseRestoreRelease()
    expect(await screen.findByText(en.restoreNoMatch)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.restoreProceed })).toBeNull()
    expect(fetchCalls.some(call => call.path === '/dsh-market/update')).toBe(false)
    expect(screen.queryByText('Catalog copy')).toBeNull()
  })

  it('dismissing the restore modal does not call update', async () => {
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': 'link:../dsh-loop' }, live: [] },
      '/dsh-market/updates': { updates: { 'dsh-loop': { kind: 'linked', updateAvailable: false } } },
      '/dsh-market/update': { ok: true },
    })
    render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    await chooseRestoreRelease()
    expect(await screen.findByText((content: string) => content.includes(en.restoreNameOnlyHint.slice(0, 40)))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(screen.queryByText((content: string) => content.includes(en.restoreNameOnlyHint.slice(0, 40)))).toBeNull()
    expect(fetchCalls.some(call => call.path === '/dsh-market/update')).toBe(false)
  })

  it('deprecated installed rows still show replacement actions, with restore in the menu', async () => {
    const DEPRECATED_WITH_REPLACEMENT = {
      updated: '', count: 2,
      categories: { tools: { en: 'Tools', zh: '工具' } },
      plugins: [
        { name: 'dsh-old', owner: 'alice', url: 'https://github.com/alice/dsh-old', category: 'tools', npm: 'dsh-old', stars: 5, added: '2026-01-01', description: { en: 'Legacy', zh: '旧' }, install: '', deprecated: true, replacement: 'dsh-new' },
        { name: 'dsh-new', owner: 'bob', url: 'https://github.com/bob/dsh-new', category: 'tools', npm: 'dsh-new', stars: 20, added: '2026-08-01', description: { en: 'Modern', zh: '新' }, install: '' },
      ],
    }
    stubFetch({
      '/dsh-market/registry': { source: 'snapshot', registry: DEPRECATED_WITH_REPLACEMENT },
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-old': 'link:../dsh-old' }, live: [] },
      '/dsh-market/updates': { updates: { 'dsh-old': { kind: 'linked', updateAvailable: false } } },
    })
    render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    expect(await screen.findByRole('button', { name: en.viewReplacement })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.installReplacement })).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: en.groupMore })[0]!)
    expect(screen.getByRole('menuitem', { name: en.restoreOnline })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: en.uninstall })).toBeTruthy()
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
    await chooseRestoreRelease()
    fireEvent.click(await screen.findByRole('button', { name: en.restoreProceed }))
    expect(await screen.findByText(re(en.buildsSkipped))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.approveBuilds }))
    await waitFor(() => {
      const retries = fetchCalls.filter(call => call.path === '/dsh-market/update')
      expect(retries.length).toBeGreaterThanOrEqual(2)
      expect(retries.at(-1)?.body).toMatchObject({ name: 'dsh-loop', restore: true })
    })
  })
})

describe('search clear controls (#524)', () => {
  /**
   * Every tab's search box is the same component, so these go through the
   * rendered market rather than mounting it directly: what a reader gets is a
   * field on a page, and the bug this replaced was one of placement inside
   * that page — a control that lived outside the component could only reset
   * the committed query, and only if every call site remembered to render it.
   */
  // Referentially stable, like LOCALE_SNAPSHOT: useSyncExternalStore reads a
  // fresh object as a change on every render and loops until React throws.
  const THEME_SNAPSHOT = { preference: 'light', themes: [] as Array<{ id: string }> }
  const ZH_SNAPSHOT = { active: 'zh' }

  function searchTabProps() {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0', 'dsh-notify': '^1.0.0', 'whale-skin': '^1.0.0' },
        live: [], disabled: [], groups: {}, groupOrder: [],
        favorites: REGISTRY.plugins.map(plugin => plugin.url),
      },
    })
    return {
      ...props(),
      themeStore: { subscribe: () => () => {}, getSnapshot: () => THEME_SNAPSHOT },
    }
  }

  it('clears the Discover search and brings back the filtered-out results (#524)', async () => {
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    const input = screen.getByPlaceholderText(en.searchPh)
    fireEvent.change(input, { target: { value: 'loop' } })
    await waitFor(() => expect(screen.queryByText('dsh-notify')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: en.clearSearch }))

    expect(input).toHaveProperty('value', '')
    expect(await screen.findByText('dsh-notify')).toBeTruthy()
    expect(screen.getByText('dsh-loop')).toBeTruthy()
  })

  it('clears a query that has not been committed yet, and cancels it', async () => {
    // The clear control exists for the field as it LOOKS: between a keystroke
    // and SearchInput's 250ms commit, the box holds text the parent has not
    // heard about. Clearing there must empty the box now and must not let the
    // pending query land afterwards — clearing and then watching the list
    // re-filter itself would be worse than not clearing at all.
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    const input = screen.getByPlaceholderText(en.searchPh)
    fireEvent.change(input, { target: { value: 'loop' } })
    fireEvent.click(screen.getByRole('button', { name: en.clearSearch }))
    expect(input).toHaveProperty('value', '')

    await new Promise(resolve => setTimeout(resolve, SEARCH_DELAY_MS + 100))
    expect(screen.getByText('dsh-notify')).toBeTruthy()
    expect(screen.getByText('dsh-loop')).toBeTruthy()
  })

  it.each([
    { tab: 'Discover', label: en.tabDiscover, placeholder: en.searchPh, result: 'dsh-loop', query: 'loop' },
    { tab: 'Favorites', label: en.tabFavorites, placeholder: en.searchFavoritesPh, result: 'dsh-loop', query: 'loop' },
    { tab: 'Themes', label: en.tabThemes, placeholder: en.searchPh, result: 'whale-skin', query: 'whale' },
    { tab: 'Installed', label: en.tabInstalled, placeholder: en.searchPh, result: 'dsh-loop', query: 'loop' },
  ])('$tab shows the clear control only when there is something to clear, and returns focus', async ({ label, placeholder, result, query }) => {
    render(<MarketSection {...searchTabProps()} />)
    await screen.findByText('dsh-loop')
    // The Themes category pill carries the same label as the Themes tab; the tab is first.
    fireEvent.click(screen.getAllByRole('button', { name: re(label) })[0])
    await screen.findByText(result)
    const input = screen.getByPlaceholderText(placeholder)
    expect(input.tagName).toBe('INPUT')
    // A plugin name is not prose: no red squiggles under dsh-session-manager.
    expect(input.getAttribute('spellcheck')).toBe('false')
    expect(screen.queryByRole('button', { name: en.clearSearch })).toBeNull()

    fireEvent.change(input, { target: { value: 'zzz-no-match' } })
    await waitFor(() => expect(screen.queryByText(result)).toBeNull())
    const clear = screen.getByRole('button', { name: en.clearSearch })
    // A real button, so Enter and Space activate it without extra key handling.
    expect(clear.getAttribute('type')).toBe('button')
    clear.focus()
    fireEvent.click(clear)
    expect(input).toHaveProperty('value', '')
    expect(document.activeElement).toBe(input)
    expect(screen.queryByRole('button', { name: en.clearSearch })).toBeNull()
    expect(await screen.findByText(result)).toBeTruthy()

    // Whitespace is a query as far as the box is concerned: it is on screen,
    // so it can be cleared.
    fireEvent.change(input, { target: { value: query } })
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: en.clearSearch }))
    expect(input).toHaveProperty('value', '')
    expect(screen.queryByRole('button', { name: en.clearSearch })).toBeNull()
  })

  it('clears only the tab in view, leaving the other three queries alone', async () => {
    render(<MarketSection {...searchTabProps()} />)
    await screen.findByText('dsh-loop')
    const searches = [
      { label: en.tabDiscover, placeholder: en.searchPh, query: 'loop' },
      { label: en.tabFavorites, placeholder: en.searchFavoritesPh, query: 'notify' },
      { label: en.tabThemes, placeholder: en.searchPh, query: 'whale' },
      { label: en.tabInstalled, placeholder: en.searchPh, query: 'loop' },
    ]
    for (const { label, placeholder, query } of searches) {
      fireEvent.click(screen.getAllByRole('button', { name: re(label) })[0])
      fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value: query } })
      // Each box commits on a 250ms debounce, and a box that unmounts
      // mid-debounce deliberately drops its pending query (SearchInput's
      // cancel-on-unmount). Let each one settle, or this asserts that loss
      // instead of the preservation it is about.
      await new Promise(resolve => setTimeout(resolve, SEARCH_DELAY_MS + 50))
    }
    fireEvent.click(screen.getAllByRole('button', { name: re(en.tabInstalled) })[0])
    fireEvent.click(screen.getByRole('button', { name: en.clearSearch }))
    expect(screen.getByPlaceholderText(en.searchPh)).toHaveProperty('value', '')
    expect(screen.queryByRole('button', { name: en.clearSearch })).toBeNull()

    for (const { label, placeholder, query } of searches.slice(0, 3)) {
      fireEvent.click(screen.getAllByRole('button', { name: re(label) })[0])
      expect(screen.getByPlaceholderText(placeholder)).toHaveProperty('value', query)
      expect(screen.getByRole('button', { name: en.clearSearch })).toBeTruthy()
    }
  })

  it('names the control in the reader\'s language', async () => {
    const marketProps = props()
    const { rerender } = render(<MarketSection {...marketProps} />)
    await screen.findByText('dsh-loop')
    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: 'loop' } })
    expect(screen.getByRole('button', { name: en.clearSearch })).toBeTruthy()

    rerender(<MarketSection {...marketProps}
      t={key => (zh as Record<string, string>)[key] ?? key}
      locale={{ subscribe: () => () => {}, getSnapshot: () => ZH_SNAPSHOT }}
    />)
    const input = screen.getByPlaceholderText(zh.searchPh)
    expect(input).toHaveProperty('value', 'loop')
    expect(screen.queryByRole('button', { name: en.clearSearch })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.clearSearch }))
    expect(input).toHaveProperty('value', '')
    expect(await screen.findByText('dsh-notify')).toBeTruthy()
  })
})

describe('a queued operation only runs while it still applies (#523)', () => {
  /**
   * The queue drains with no confirmation — that is what queueing is — so a
   * row restored from an old session is a destructive operation launched from
   * a stale decision: queue an uninstall at 10:00, remove the plugin by hand,
   * open the market at 15:00 and it would run. Each kind has to be true NOW,
   * and a row that is not is reported instead of executed.
   */
  const seedQueue = (rows: unknown[]): void => localStorage.setItem('dshm-queue-v1', JSON.stringify(rows))
  const postsTo = (mock: { mock: { calls: unknown[][] } }, path: string): number =>
    mock.mock.calls.filter(([url, init]) => String(url).endsWith(path)
      && ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'POST').length
  const panelText = (): string => document.querySelector('[class*="opPanel"]')?.textContent ?? ''

  it('does not uninstall what is no longer installed, and says why', async () => {
    const fetchMock = stubFetch() // nothing installed
    seedQueue([{ kind: 'uninstall', name: 'dsh-loop' }])
    render(<MarketSection {...props()} />)
    // The restored row carries the name too, so the wait is for presence
    // rather than for a unique match.
    await screen.findAllByText('dsh-loop')
    await waitFor(() => expect(panelText()).toContain(en.agentQueueStaleGone))
    expect(postsTo(fetchMock, '/dsh-market/uninstall')).toBe(0)
  })

  it('does not update what has no update any more, and says why', async () => {
    const fetchMock = stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [], disabled: [], groups: {}, groupOrder: [], favorites: [] },
      '/dsh-market/updates': { updates: {} },
    })
    seedQueue([{ kind: 'update', name: 'dsh-loop' }])
    render(<MarketSection {...props()} />)
    // Installed entries render twice (the card and the installed roster), so
    // this waits for presence rather than uniqueness.
    await screen.findAllByText('dsh-loop')
    // The action must not run — that is the whole point — and what happened
    // has to be visible: a skip notice, not a silent disappearance.
    await waitFor(() => expect(panelText()).toMatch(/skipped/u))
    // Wait out the drain's tick before claiming nothing ran: a row wrongly
    // left in the queue fires on it, and asserting earlier would miss exactly
    // the bug this test pins.
    await new Promise(resolve => setTimeout(resolve, 2_600))
    expect(postsTo(fetchMock, '/dsh-market/update')).toBe(0)
    expect(localStorage.getItem('dshm-queue-v1')).toBeNull()
  })

  it('still runs a queued uninstall while the plugin is installed', async () => {
    // The other half of the rule: the check must not reject a row that IS
    // still true, or the queue would quietly stop working for the case it was
    // built for.
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [], disabled: [], groups: {}, groupOrder: [], favorites: [] },
      '/dsh-market/uninstall': { ok: true, agentsBusy: true, runningAgents: ['main'], error: 'agents are running', __status: 409 },
    })
    seedQueue([{ kind: 'uninstall', name: 'dsh-loop' }])
    render(<MarketSection {...props()} />)
    await screen.findAllByText('dsh-loop')
    await waitFor(() => expect(panelText()).toContain(en.opQueued))
    expect(panelText()).not.toContain(en.agentQueueStaleGone)
  })
})

describe('capability disclosure (#401)', () => {
  /**
   * The scan result lives in the detail dialog and nowhere else.
   *
   * It used to sit on both cards. It moved because a line every card carries is
   * a line nobody reads — and the one line worth stopping for (a script that
   * runs as you install) was lost among the ones that only describe what
   * plugins normally do. So these tests hold the card staying silent, the
   * dialog leading with the install-time warning, the credentials red line
   * and dynamic code standing in front of a closed fold, the full capability
   * list one click away with the blind spot always printed, and the three
   * states ("detected", "nothing found", "never scanned") staying three
   * sentences.
   */
  const base = {
    name: 'dsh-probe-target', owner: 'alice', url: 'https://github.com/alice/dsh-probe-target',
    category: 'tools', npm: null, stars: 1, added: '2026-09-01',
    description: { en: 'Target', zh: '目标' }, install: '',
  }

  function withEntry(extra: Record<string, unknown>): void {
    const plugins = [{ ...base, ...extra }]
    stubFetch({
      '/dsh-market/registry': { source: 'live', hostVersion: '0.1.2-alpha.2', registry: { ...REGISTRY, count: plugins.length, plugins } },
    })
  }

  /** Open the card's install dialog — where the disclosure now lives. */
  async function openDetail() {
    let card: HTMLElement | null = screen.getByText('dsh-probe-target')
    while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) card = card.parentElement
    fireEvent.click(within(card!).getAllByRole('button', { name: en.install })[0]!)
    await screen.findByRole('button', { name: en.confirmInstall })
    return within(screen.getByRole('dialog'))
  }

  it('says nothing about the scan on the card — not the facts, not the warning', async () => {
    withEntry({
      capabilities: ['shell', 'network'],
      capabilityRedLines: ['reads credentials/secrets AND has network access', 'runs code at install time (postinstall)'],
      capabilityCheckedAt: '2026-09-24T12:00:00Z',
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-probe-target')
    expect(screen.queryByText(en.capabilityTitle)).toBeNull()
    expect(screen.queryByText(en.capShell)).toBeNull()
    expect(screen.queryByText(en.capRedCredentialsNetwork)).toBeNull()
    expect(screen.queryByText(en.capRedInstallScriptScripts.replace('{0}', 'postinstall'))).toBeNull()
  })

  it('shows the same nothing on the Themes card as on the Discover card', async () => {
    withEntry({ category: 'theme', capabilities: ['shell', 'network'], capabilityRedLines: [] })
    render(<MarketSection {...props()} preferredSubsectionId="themes" />)
    await screen.findAllByText('dsh-probe-target')
    expect(screen.queryByText(en.capabilityTitle)).toBeNull()
    expect(screen.queryByText(en.capShell)).toBeNull()
  })

  it('puts a credentials red line in front of the fold, and keeps the capability list one click away', async () => {
    withEntry({
      capabilities: ['shell', 'fs-write', 'network', 'credentials'],
      capabilityRedLines: ['reads credentials/secrets AND has network access', 'runs code at install time (postinstall)'],
      capabilityCheckedAt: '2026-09-24T12:00:00Z',
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-probe-target')
    const dialog = await openDetail()

    // Install-time stays on its own warning line. The combination sentence
    // stands in front of the fold. The chip that would repeat it, and every
    // other capability, wait inside.
    expect(dialog.getByText(en.capRedInstallScriptScripts.replace('{0}', 'postinstall'))).toBeTruthy()
    expect(dialog.getByText(en.capabilityAhead)).toBeTruthy()
    expect(dialog.getByText(en.capRedCredentialsNetwork)).toBeTruthy()
    expect(dialog.queryByText(en.capCredentials)).toBeNull()
    expect(dialog.queryByText(en.capShell)).toBeNull()
    // The blind spot is printed before anything is opened.
    expect(dialog.getByText(en.capabilityNote)).toBeTruthy()
    expect(dialog.queryByText(en.capabilityScannedAt.replace('{0}', '2026-09-24'))).toBeNull()

    fireEvent.click(dialog.getByText(en.capabilityTitle))
    expect(dialog.getByText(en.capCredentials)).toBeTruthy()
    expect(dialog.getByText(en.capShell)).toBeTruthy()
    expect(dialog.getByText(en.capFsWrite)).toBeTruthy()
    expect(dialog.getByText(en.capabilityScannedAt.replace('{0}', '2026-09-24')).classList.contains(css.capCaveatAt)).toBe(true)
    // Disclosure, never verdict.
    expect(dialog.queryByText(/^safe$/i)).toBeNull()
  })

  it('prints the blind spot on a dialog with nothing in front of the list', async () => {
    // Without this line, a dialog that shows no facts reads as a clean scan.
    withEntry({ capabilities: ['fs-read', 'network'], capabilityRedLines: [] })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-probe-target')
    const dialog = await openDetail()
    expect(dialog.queryByText(en.capabilityAhead)).toBeNull()
    expect(dialog.getByText(en.capabilityNote)).toBeTruthy()
  })

  it('translates every rule family the scanner can emit', async () => {
    // Five shapes, one per family. Two of them used to fall through to the
    // scanner's English on a Chinese card.
    const families: Array<[string, string]> = [
      ['reads credentials/secrets AND has network access', en.capRedCredentialsNetwork],
      ['uses plaintext http:// to schemas.example.org', en.capRedPlaintextHttp.replace('{0}', 'schemas.example.org')],
      ['uses literal IP 169.254.169.254 for network access', en.capRedLiteralIp.replace('{0}', '169.254.169.254')],
      ['runs code at install time (postinstall, preinstall)', en.capRedInstallScriptScripts.replace('{0}', 'postinstall, preinstall')],
      ['tampers with a core bundle (overrides bundle @deepseek-ai/dsh-base)', en.capRedCoreOverride.replace('{0}', '@deepseek-ai/dsh-base')],
    ]
    withEntry({ capabilities: ['network'], capabilityRedLines: families.map(([line]) => line) })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-probe-target')
    const dialog = await openDetail()
    fireEvent.click(dialog.getByText(en.capabilityTitle))
    for (const [, label] of families) expect(dialog.getByText(label)).toBeTruthy()
  })

  it('says whether a core part is overridden or disabled, instead of leaving the verb in English', async () => {
    // These two sentences are the only core-tamper details the scanner emits.
    // The verb is the fact a reader has to weigh before installing; a translation
    // that still says "overrides bundle" has not translated it.
    const override = 'tampers with a core bundle (overrides bundle @deepseek-ai/dsh-base)'
    const disable = 'tampers with a core bundle (disables bundle @deepseek-ai/dsh-core)'
    withEntry({
      capabilities: ['host-runtime'],
      capabilityRedLines: [override, disable],
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-probe-target')
    const dialog = await openDetail()
    expect(dialog.getByText(en.capRedCoreOverride.replace('{0}', '@deepseek-ai/dsh-base'))).toBeTruthy()
    expect(dialog.getByText(en.capRedCoreDisable.replace('{0}', '@deepseek-ai/dsh-core'))).toBeTruthy()
    expect(dialog.queryByText(/overrides bundle/)).toBeNull()
    expect(dialog.queryByText(/disables bundle/)).toBeNull()
  })

  it('keeps an unrecognized core-bundle detail on the generic sentence', async () => {
    // Not a shape the scanner emits. The two known details name the verb;
    // anything else stays on the generic sentence instead of being guessed
    // into an override or a disable.
    withEntry({
      capabilities: ['host-runtime'],
      capabilityRedLines: ['tampers with a core bundle (dsh-base)'],
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-probe-target')
    const dialog = await openDetail()
    expect(dialog.getByText(en.capRedCoreTamperDetail.replace('{0}', 'dsh-base'))).toBeTruthy()
    expect(dialog.queryByText(en.capRedCoreOverride.replace('{0}', 'dsh-base'))).toBeNull()
    expect(dialog.queryByText(en.capRedCoreDisable.replace('{0}', 'dsh-base'))).toBeNull()
  })

  it('counts what the fold holds in its title, and groups it by what it touches', async () => {
    withEntry({
      capabilities: ['fs-read', 'network', 'shell', 'credentials', 'dynamic-code', 'writes-clipboard'],
      capabilityRedLines: [],
      capabilityCheckedAt: '2026-09-24T12:00:00Z',
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-probe-target')
    const dialog = await openDetail()
    // Closed, the title already says how much is inside and how much of it is uncommon.
    expect(dialog.getByText(en.capabilityCountUncommon.replace('{0}', '6').replace('{1}', '2'))).toBeTruthy()
    expect(dialog.queryByText(en.capGroupFiles)).toBeNull()

    fireEvent.click(dialog.getByText(en.capabilityTitle))
    for (const key of ['capGroupFiles', 'capGroupNetwork', 'capGroupRun', 'capGroupKeys', 'capGroupOther'] as const) {
      expect(dialog.getByText(en[key])).toBeTruthy()
    }
    expect(dialog.queryByText(en.capGroupHost)).toBeNull()
    expect(dialog.getByText(en.capCredentials).classList.contains(css.capChipUncommon)).toBe(true)
    expect(dialog.getByText(en.capShell).classList.contains(css.capChipUncommon)).toBe(false)
    expect(dialog.getByText('writes-clipboard').classList.contains(css.capChipUncommon)).toBe(false)
    expect(dialog.getByText(en.capabilityUncommonLegend)).toBeTruthy()
  })

  it('drops the uncommon half of the title and the legend when nothing uncommon was found', async () => {
    withEntry({ capabilities: ['fs-read', 'network'], capabilityRedLines: [] })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-probe-target')
    const dialog = await openDetail()
    expect(dialog.getByText(en.capabilityCount.replace('{0}', '2'))).toBeTruthy()
    fireEvent.click(dialog.getByText(en.capabilityTitle))
    expect(dialog.queryByText(en.capabilityUncommonLegend)).toBeNull()
  })

  it('separates "nothing found" from "never scanned"', async () => {
    withEntry({ capabilities: [], capabilityRedLines: [] })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-probe-target')
    let dialog = await openDetail()
    expect(dialog.queryByText(en.capabilityNone)).toBeNull()
    fireEvent.click(dialog.getByText(en.capabilityTitle))
    expect(dialog.getByText(en.capabilityNone)).toBeTruthy()
    expect(dialog.queryByText(en.capabilityUnchecked)).toBeNull()
    cleanup()

    // Never scanned: the panel's frame, with the state in plain sight. No fold
    // that opens onto one sentence, and no blind-spot note about a scan that
    // did not happen.
    withEntry({})
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-probe-target')
    dialog = await openDetail()
    const unchecked = dialog.getByText(en.capabilityUnchecked)
    expect(unchecked.closest('[data-state]')?.getAttribute('data-state')).toBe('unchecked')
    expect(dialog.getByText(en.capabilityTitle).closest('button')).toBeNull()
    expect(dialog.queryByText(en.capabilityNote)).toBeNull()
    expect(dialog.queryByText(en.capabilityNone)).toBeNull()
  })

  it('puts dynamic code in front, and leaves a host-runtime dependency in the fold', async () => {
    // host-runtime is a package.json dependency on a DSH host package, not a
    // change to DSH — the install-time core-tamper line is the one that is.
    withEntry({
      capabilities: ['shell', 'fs-read', 'credentials', 'dynamic-code', 'host-runtime', 'writes-clipboard'],
      capabilityRedLines: [],
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-probe-target')
    const dialog = await openDetail()
    expect(dialog.getByText(en.capabilityAhead)).toBeTruthy()
    expect(dialog.getByText(en.capDynamicCode)).toBeTruthy()
    expect(dialog.queryByText(en.capHostRuntime)).toBeNull()
    expect(dialog.queryByText(en.capCredentials)).toBeNull()
    expect(dialog.queryByText('writes-clipboard')).toBeNull()
    fireEvent.click(dialog.getByText(en.capabilityTitle))
    expect(dialog.getByText(en.capHostRuntime)).toBeTruthy()
    expect(dialog.getByText(en.capCredentials)).toBeTruthy()
    expect(dialog.getByText('writes-clipboard')).toBeTruthy()
    expect(dialog.getByText(en.capShell)).toBeTruthy()
  })

  it('keeps the fold closed when the scan found only ordinary capabilities', async () => {
    withEntry({ capabilities: ['fs-read', 'network', 'shell'], capabilityRedLines: [] })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-probe-target')
    const dialog = await openDetail()
    expect(dialog.queryByText(en.capabilityAhead)).toBeNull()
    expect(dialog.queryByText(en.capFsRead)).toBeNull()
    expect(dialog.queryByText(en.capShell)).toBeNull()
    fireEvent.click(dialog.getByText(en.capabilityTitle))
    expect(dialog.getByText(en.capFsRead)).toBeTruthy()
    expect(dialog.getByText(en.capNetwork)).toBeTruthy()
    expect(dialog.getByText(en.capShell)).toBeTruthy()
  })

  it('keeps plaintext-http and literal-IP lines in the fold, not in front of it', async () => {
    // Each names one address matched from source text — often a schema URL in
    // a bundled library. Standing beside the credentials line, they would read
    // as the same kind of fact.
    withEntry({
      capabilities: ['network'],
      capabilityRedLines: [
        'reads credentials/secrets AND has network access',
        'uses plaintext http:// to schemas.example.org',
        'uses literal IP 169.254.169.254 for network access',
      ],
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-probe-target')
    const dialog = await openDetail()
    expect(dialog.getByText(en.capRedCredentialsNetwork)).toBeTruthy()
    expect(dialog.queryByText(en.capRedPlaintextHttp.replace('{0}', 'schemas.example.org'))).toBeNull()
    expect(dialog.queryByText(en.capRedLiteralIp.replace('{0}', '169.254.169.254'))).toBeNull()
    fireEvent.click(dialog.getByText(en.capabilityTitle))
    expect(dialog.getByText(en.capRedPlaintextHttp.replace('{0}', 'schemas.example.org'))).toBeTruthy()
    expect(dialog.getByText(en.capRedLiteralIp.replace('{0}', '169.254.169.254'))).toBeTruthy()
  })

  it('shows only plaintext-http in the fold when it is the only red line', async () => {
    withEntry({ capabilities: ['network'], capabilityRedLines: ['uses plaintext http:// to schemas.example.org'] })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-probe-target')
    const dialog = await openDetail()
    expect(dialog.queryByText(en.capabilityAhead)).toBeNull()
    fireEvent.click(dialog.getByText(en.capabilityTitle))
    expect(dialog.getByText(en.capRedPlaintextHttp.replace('{0}', 'schemas.example.org'))).toBeTruthy()
  })

  it('shows a capability name this build has no label for, rather than dropping it', async () => {
    // An unlabelled fact is still a fact: a missing chip would read as "does
    // not do that" — the one failure mode a disclosure must not have.
    // dynamic-code is in front; the unknown name stays in the list, under its
    // own spelling.
    withEntry({ capabilities: ['dynamic-code', 'writes-clipboard'], capabilityRedLines: [] })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-probe-target')
    const dialog = await openDetail()
    expect(dialog.getByText(en.capDynamicCode)).toBeTruthy()
    expect(dialog.queryByText('writes-clipboard')).toBeNull()
    fireEvent.click(dialog.getByText(en.capabilityTitle))
    expect(dialog.getByText('writes-clipboard')).toBeTruthy()
  })

  it('leaves a red line it cannot translate in the scanner own words', async () => {
    withEntry({ capabilities: ['network'], capabilityRedLines: ['POSTs telemetry to a collector'] })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-probe-target')
    const dialog = await openDetail()
    expect(dialog.getByText('POSTs telemetry to a collector')).toBeTruthy()
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

  it('settles the live install task the poll recovers, so the entry stops claiming it is running (#904)', async () => {
    // The same lost-response path as above, one layer up: the poll is the only
    // witness that the install landed. It released the card's busy state, but
    // the record `doInstall` put in the Tasks panel was still `running`, so the
    // entry kept saying "Installing 1/1" for the rest of the mount. A remount
    // used to mask it: `records` is React state, and only FINISHED rows are
    // restored from storage, so a `running` row still vanished with the mount.
    vi.useFakeTimers()
    try {
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
      let card: HTMLElement | null = screen.getByText('dsh-loop')
      while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
        card = card.parentElement
      }
      fireEvent.click(within(card!).getAllByRole('button', { name: en.install })[0]!)
      await vi.waitFor(() => { screen.getByRole('button', { name: en.confirmInstall }) })
      fireEvent.click(screen.getByRole('button', { name: en.confirmInstall }))
      await vi.advanceTimersByTimeAsync(100)
      await vi.waitFor(() => { screen.getByRole('button', { name: `${en.opInstalling} 1/1` }) })

      installedNow = { 'dsh-loop': '^1.0.0' }
      await vi.advanceTimersByTimeAsync(4500)
      await vi.waitFor(() => { expect(sessionStorage.getItem('dshm-pending')).toBeNull() })

      // The operation is over; the Tasks entry must say so on its own.
      expect(screen.queryByRole('button', { name: `${en.opInstalling} 1/1` })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: en.opTitle }))
      const panel = document.querySelector('[class*="opPanel"]')
      expect(panel?.textContent).toContain('dsh-loop')
      expect(panel?.textContent).toContain(en.opDoneRefresh)
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases the live install task when the lost install never lands (#904)', async () => {
    // The mirror outcome of the poll recovery: two idle polls conclude the
    // install died. The banner says so, but the record must stop running too —
    // otherwise the entry is left claiming "Installing 1/1" over a failure.
    vi.useFakeTimers()
    try {
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        const path = String(url).split('?')[0]
        if (path === '/dsh-market/install') return Promise.reject(new TypeError('network connection was lost'))
        const payload =
          path === '/dsh-market/registry' ? { source: 'live', registry: REGISTRY }
          : path === '/dsh-market/installed' ? { profile: 'web', installed: {}, live: [] }
          : path === '/dsh-market/status' ? { active: false, busy: false, pnpm: true, boot: 'boot-1', restart: true, installed: {} }
          : path === '/dsh-market/updates' ? { updates: {} }
          : null
        if (payload === null) return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
      }))
      render(<MarketSection {...props()} />)
      await vi.waitFor(() => { screen.getByText('dsh-loop') })
      await vi.waitFor(() => { screen.getByRole('button', { name: en.tabInstalled }) })
      let card: HTMLElement | null = screen.getByText('dsh-loop')
      while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
        card = card.parentElement
      }
      fireEvent.click(within(card!).getAllByRole('button', { name: en.install })[0]!)
      await vi.waitFor(() => { screen.getByRole('button', { name: en.confirmInstall }) })
      fireEvent.click(screen.getByRole('button', { name: en.confirmInstall }))
      await vi.advanceTimersByTimeAsync(100)
      await vi.waitFor(() => { screen.getByRole('button', { name: `${en.opInstalling} 1/1` }) })

      await vi.advanceTimersByTimeAsync(2100)
      await vi.advanceTimersByTimeAsync(2100)
      await vi.waitFor(() => { expect(sessionStorage.getItem('dshm-pending')).toBeNull() })

      expect(screen.queryByRole('button', { name: `${en.opInstalling} 1/1` })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: en.opTitle }))
      const panel = document.querySelector('[class*="opPanel"]')
      expect(panel?.textContent).toContain('dsh-loop')
      expect(panel?.textContent).toContain(en.installFail)
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

  it('shows the restart banner but hides the button while the host is debugged (#447)', async () => {
    stubWithActivation('boot-1')
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const path = String(url).split('?')[0]
      const installed = { 'dsh-loop': '^1.0.0' }
      const payload =
        path === '/dsh-market/registry' ? { source: 'live', registry: REGISTRY }
        : path === '/dsh-market/installed' ? {
            profile: 'web', installed, live: [],
            activation: { 'dsh-loop': { state: 'restart', reasons: ['in the bundle layer'], bundle: true, hot: false } },
          }
        : path === '/dsh-market/status' ? { active: false, busy: false, pnpm: true, boot: 'boot-1', restart: true, debugger: 'inspector', installed }
        : path === '/dsh-market/updates' ? { updates: {} }
        : null
      if (payload === null) return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
    }))
    render(<MarketSection {...props()} />)
    await waitFor(() => { expect(screen.getAllByText(re(en.restartBanner)).length).toBeGreaterThan(0) })
    expect(screen.queryByRole('button', { name: en.restartNow })).toBeNull()
  })

  describe('which explanation the restart banner carries (#782)', () => {
    // The order IS the behaviour, and three states have each added a branch to
    // the same ternary. A debugger outranks everything (the host will not stop);
    // a proxy outranks a supervisor (the request cannot pass at all, whatever
    // owns restarts); a supervisor outranks the plain how-to.
    const base = { debuggerLatch: null, restartReachable: true, supervisor: null }

    it('picks each reason on its own', () => {
      expect(restartHintKey(base)).toBe('restartHint')
      expect(restartHintKey({ ...base, supervisor: 'systemd' })).toBe('restartHintSupervised')
      expect(restartHintKey({ ...base, restartReachable: false })).toBe('restartHintViaProxy')
      expect(restartHintKey({ ...base, debuggerLatch: 'inspector' })).toBe('restartHintDebugged')
    })

    it('resolves two reasons at once in that order', () => {
      expect(restartHintKey({ debuggerLatch: 'inspector', restartReachable: false, supervisor: 'systemd' })).toBe('restartHintDebugged')
      expect(restartHintKey({ debuggerLatch: null, restartReachable: false, supervisor: 'systemd' })).toBe('restartHintViaProxy')
    })

    it('says the reason, the cause and the way out in plain words, in both languages', () => {
      // AGENTS.md: what happened, why, what to do now — and say it to someone
      // who is not an operator.
      expect(zh.restartHintViaProxy).toContain('代理')
      expect(zh.restartHintViaProxy).toContain('本机直连')
      expect(zh.restartHintViaProxy).toContain('kubectl rollout restart')
      expect(en.restartHintViaProxy).toContain('proxy or gateway')
      expect(en.restartHintViaProxy).toContain('direct local connection')
      expect(en.restartHintViaProxy).toContain('kubectl rollout restart')
    })
  })

  describe('behind a reverse proxy the restart can never pass the fence (#782)', () => {
    // The report: behind an Ingress the banner rendered "restart now" and every
    // click answered 403 — the one button in the market that was enabled and
    // could not succeed, with nothing saying so beforehand. The status poll now
    // says whether a restart from THIS page could pass; the banner follows it.
    function stubStatus(extra: Record<string, unknown>) {
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        const path = String(url).split('?')[0]
        const installed = { 'dsh-loop': '^1.0.0' }
        const payload =
          path === '/dsh-market/registry' ? { source: 'live', registry: REGISTRY }
          : path === '/dsh-market/installed' ? {
              profile: 'web', installed, live: [],
              activation: { 'dsh-loop': { state: 'restart', reasons: ['in the bundle layer'], bundle: true, hot: false } },
            }
          : path === '/dsh-market/status' ? { active: false, busy: false, pnpm: true, boot: 'boot-1', restart: true, installed, ...extra }
          : path === '/dsh-market/updates' ? { updates: {} }
          : null
        if (payload === null) return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
      }))
    }

    it('keeps the banner, drops the button, and puts the reason in the hint', async () => {
      stubStatus({ restartReachable: false })
      render(<MarketSection {...props()} />)
      await waitFor(() => { expect(screen.getAllByText(re(en.restartBanner)).length).toBeGreaterThan(0) })
      // The fact that a restart is needed is still stated — only the impossible
      // action goes. A banner that vanished would hide the fact itself.
      expect(screen.queryByRole('button', { name: en.restartNow })).toBeNull()
      // What the hint SAYS is pinned below, on the pure function that picks it.
    })

    it('keeps the button on an ordinary local host, where the signal is true', async () => {
      stubStatus({ restartReachable: true })
      render(<MarketSection {...props()} />)
      await waitFor(() => { expect(screen.getAllByText(re(en.restartBanner)).length).toBeGreaterThan(0) })
      expect(screen.getByRole('button', { name: en.restartNow })).toBeTruthy()
    })

    it('keeps the button when an older host does not report the signal at all', async () => {
      // Only an explicit false removes the action. Absent reads as "reachable":
      // the old behaviour, never a button taken away on a guess.
      stubStatus({})
      render(<MarketSection {...props()} />)
      await waitFor(() => { expect(screen.getAllByText(re(en.restartBanner)).length).toBeGreaterThan(0) })
      expect(screen.getByRole('button', { name: en.restartNow })).toBeTruthy()
    })
  })
})

describe('a shell that runs the host as its child process owns the restart', () => {
  // A Tauri/Electron shell that spawned `dsh web` restarts by stopping the
  // process it started and relaunching its own window. The market's own route
  // spawns a detached helper instead — a second lifecycle competing with the
  // shell's for one port. Where the shell publishes its bridge, the button
  // asks the shell and never touches the host route.
  function stubStatus(extra: Record<string, unknown> = {}) {
    const installed = { 'dsh-loop': '^1.0.0' }
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web', installed, live: [],
        activation: { 'dsh-loop': { state: 'restart', reasons: ['in the bundle layer'], bundle: true, hot: false } },
      },
      '/dsh-market/status': { active: false, busy: false, pnpm: true, boot: 'boot-1', restart: true, installed, ...extra },
      '/dsh-market/updates': { updates: {} },
    })
  }

  afterEach(() => { Reflect.deleteProperty(window, '__dshHostShell') })

  it('asks the shell, and never posts to the host restart route', async () => {
    const shellRestart = vi.fn()
    Reflect.set(window, '__dshHostShell', { restart: shellRestart })
    stubStatus()
    render(<MarketSection {...props()} />)
    await waitFor(() => { expect(screen.getAllByText(re(en.restartBanner)).length).toBeGreaterThan(0) })

    fireEvent.click(screen.getByRole('button', { name: en.restartNow }))

    await waitFor(() => { expect(shellRestart).toHaveBeenCalledTimes(1) })
    expect(fetchCalls.some(call => call.path === '/dsh-market/restart')).toBe(false)
  })

  it('falls back to the host route when the shell bridge is absent', async () => {
    stubStatus()
    render(<MarketSection {...props()} />)
    await waitFor(() => { expect(screen.getAllByText(re(en.restartBanner)).length).toBeGreaterThan(0) })

    fireEvent.click(screen.getByRole('button', { name: en.restartNow }))

    await waitFor(() => {
      expect(fetchCalls.some(call => call.path === '/dsh-market/restart' && call.method === 'POST')).toBe(true)
    })
  })

  it('falls back to the host route when the shell bridge throws', async () => {
    // A bridge that throws is not a restart. Silently reporting success would
    // leave the page "restarting" forever against a host that never stopped.
    Reflect.set(window, '__dshHostShell', { restart: () => { throw new Error('bridge is gone') } })
    stubStatus()
    render(<MarketSection {...props()} />)
    await waitFor(() => { expect(screen.getAllByText(re(en.restartBanner)).length).toBeGreaterThan(0) })

    fireEvent.click(screen.getByRole('button', { name: en.restartNow }))

    await waitFor(() => {
      expect(fetchCalls.some(call => call.path === '/dsh-market/restart' && call.method === 'POST')).toBe(true)
    })
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
    await ignoreRowUntilRestart('dsh-loop')

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

  it('a saved do-not-remind list quiets prompts without hiding the update', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web', installed, live: Object.keys(installed),
        updateExempt: ['dsh-loop'],
      },
      '/dsh-market/status': { active: false, busy: false, pnpm: true, boot: 'boot-1', restart: true, installed },
      '/dsh-market/updates': { updates: updateStatuses },
    })
    render(<MarketSection {...props()} />)

    expect(await screen.findByRole('button', { name: /Update all \(1\)/ })).toBeTruthy()
    expect(updateDot()).toBeTruthy()

    fireEvent.click(installedTab())
    expect(await screen.findByRole('button', { name: `${en.updateExemptRestore} dsh-loop` })).toBeTruthy()
    expect(screen.getByText(en.updateExemptMark)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: en.update })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: re(en.notesLink) })).toHaveLength(2)
    // A saved exemption already covers the boot dismissal, so the menu drops it.
    await openRowMenu('dsh-loop')
    expect(await screen.findByRole('menuitem', { name: en.updateExemptRemove })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: en.ignoreUpdateNotice })).toBeNull()
    await openRowMenu('dsh-loop')
    await openRowMenu('dsh-notify')
    expect(await screen.findByRole('menuitem', { name: en.ignoreUpdateNotice })).toBeTruthy()
  })

  it('names the new version on the row and undoes a boot dismissal', async () => {
    stubUpdateReminders()
    render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Installed/ }))
    expect(await screen.findAllByText(en.hostUpdateReady.replace('{0}', 'v1.1.0'))).toHaveLength(2)

    await ignoreRowUntilRestart('dsh-loop')
    expect(await screen.findByText(en.updateNoticeIgnored)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: `${en.updateExemptRestore} dsh-loop` }))

    await waitFor(() => expect(screen.queryByText(en.updateNoticeIgnored)).toBeNull())
    expect(screen.queryByRole('button', { name: `${en.updateExemptRestore} dsh-loop` })).toBeNull()
    expect(JSON.parse(sessionStorage.getItem('dshm-updates-ignored')!)).toEqual({ boot: 'boot-1', names: [] })
    expect(await screen.findByRole('button', { name: /Update all \(2\)/ })).toBeTruthy()
  })

  it('says the branch has unreleased commits instead of claiming it is up to date (#824 follow-up)', async () => {
    // A floating git row whose repository moved without publishing: the market
    // offers no update, and "Up to date" was the wrong fact — the install IS
    // behind, it is just behind an unreleased commit.
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed, live: Object.keys(installed) },
      '/dsh-market/status': { active: false, busy: false, pnpm: true, boot: 'boot-1', restart: true, installed },
      '/dsh-market/updates': {
        updates: {
          'dsh-loop': { kind: 'github', version: '1.0.0', current: 'aaaaaaa', latest: 'bbbbbbb7c1d2e3f40516', updateAvailable: false, unreleasedCommit: 'bbbbbbb7c1d2e3f40516' },
          'dsh-notify': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.0.0', updateAvailable: false },
        },
      },
    })
    render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Installed/ }))
    expect(await screen.findByText(en.unreleasedCommits.replace('{0}', 'bbbbbbb'))).toBeTruthy()
    // The row that HAS a release is untouched, and neither row offers a button.
    expect(screen.getAllByText(en.upToDate)).toHaveLength(1)
    expect(screen.queryByRole('button', { name: en.update })).toBeNull()
  })

  it('keeps the saved mark on an up-to-date row, and adds no status line to other up-to-date rows', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web', installed, live: Object.keys(installed),
        updateExempt: ['dsh-loop'],
      },
      '/dsh-market/status': { active: false, busy: false, pnpm: true, boot: 'boot-1', restart: true, installed },
      '/dsh-market/updates': {
        updates: {
          'dsh-loop': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.0.0', updateAvailable: false },
          'dsh-notify': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.0.0', updateAvailable: false },
        },
      },
    })
    render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Installed/ }))
    expect(await screen.findByText(en.updateExemptMark)).toBeTruthy()
    expect(screen.getByRole('button', { name: `${en.updateExemptRestore} dsh-loop` })).toBeTruthy()
    expect(screen.queryByRole('button', { name: re(en.notesLink) })).toBeNull()
    expect(screen.queryByRole('button', { name: re(en.ignoreUpdateNotice) })).toBeNull()
    expect(screen.getAllByText(en.upToDate)).toHaveLength(2)
  })

  it('saves the choice from the row menu and says the new version stays listed', async () => {
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed, live: Object.keys(installed) },
      '/dsh-market/status': { active: false, busy: false, pnpm: true, boot: 'boot-1', restart: true, installed },
      '/dsh-market/updates': { updates: updateStatuses },
      '/dsh-market/update-exempt': (body: any) => ({
        ok: true,
        updateExempt: body?.exempt === true ? [body.name] : [],
      }),
    })
    render(<MarketSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Installed/ }))
    let row: HTMLElement | null = await screen.findByText('dsh-loop')
    while (row !== null && within(row).queryByRole('button', { name: en.groupMore }) === null) row = row.parentElement
    fireEvent.click(within(row!).getByRole('button', { name: en.groupMore }))
    fireEvent.click(await screen.findByRole('menuitem', { name: en.updateExemptAdd }))

    await waitFor(() => {
      const call = fetchCalls.find(entry => entry.path === '/dsh-market/update-exempt')
      expect(call?.body).toEqual({ name: 'dsh-loop', exempt: true })
    })
    expect(await screen.findByText(en.updateExemptOn)).toBeTruthy()
    const mark = screen.getByRole('button', { name: `${en.updateExemptRestore} dsh-loop` })
    expect(screen.getAllByRole('button', { name: en.update })).toHaveLength(2)

    fireEvent.click(mark)
    await waitFor(() => {
      const calls = fetchCalls.filter(entry => entry.path === '/dsh-market/update-exempt')
      expect(calls.at(-1)?.body).toEqual({ name: 'dsh-loop', exempt: false })
    })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: `${en.updateExemptRestore} dsh-loop` })).toBeNull()
    })
    expect(screen.getAllByRole('button', { name: en.update })).toHaveLength(2)
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

  it('remeasures the collapsed budget when the category wrap grows wider (#846 sidebar)', async () => {
    // The sidebar page is often much wider than the settings dialog. Without
    // a resize pass, a budget measured at the first (narrow or zero) width
    // leaves a half-empty category row on the wide panel.
    let chipsPerRow = 4
    let wrapWidth = 400
    const offsetTopDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')
    const offsetHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    const clientWidthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset.chip !== '1') return 0
        const siblings = [...(this.parentElement?.children ?? [])]
          .filter((el): el is HTMLElement => (el as HTMLElement).dataset?.chip === '1')
        return Math.floor(siblings.indexOf(this) / chipsPerRow) * 32
      },
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.className.includes('catsWrap') ? 90 : 26 },
    })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) { return this.className.includes('catsWrap') ? wrapWidth : 300 },
    })
    let resizeCats: (width: number) => void = () => { throw new Error('cats wrap is not observed') }
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (!(target instanceof HTMLElement) || !target.className.includes('catsWrap')) return
        resizeCats = width => {
          wrapWidth = width
          chipsPerRow = width >= 800 ? 8 : 4
          this.callback([
            { target, contentRect: { width } } as ResizeObserverEntry,
          ], this as unknown as ResizeObserver)
        }
      }
      unobserve() {}
      disconnect() {}
    })
    try {
      stubFetch({ '/dsh-market/registry': { source: 'snapshot', registry: { ...REGISTRY, categories: CATS } } })
      const { container } = render(<MarketSection {...props()} />)
      await screen.findByText('dsh-loop')
      const chipCount = () => container.querySelectorAll('[data-chip="1"]').length
      // 4/row × 1 row → 4 fit → 3 categories + 「全部」.
      await waitFor(() => expect(chipCount()).toBe(4))
      act(() => resizeCats(900))
      // 8/row × 1 row → 7 categories + 「全部」.
      await waitFor(() => expect(chipCount()).toBe(8))
    } finally {
      if (offsetTopDesc) Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTopDesc)
      else Reflect.deleteProperty(HTMLElement.prototype, 'offsetTop')
      if (offsetHeightDesc) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeightDesc)
      else Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight')
      if (clientWidthDesc) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidthDesc)
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
      vi.unstubAllGlobals()
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

  it('pads the scroller\'s end past the floating back-to-top button, so the last card\'s ··· menu is never trapped under it (#765)', () => {
    // jsdom does no layout, so the overlap itself cannot be observed here.
    // The three numbers that decide it all live in the stylesheet: the
    // button's inset, its size, and the scroller's bottom padding.
    const css = readFileSync(resolve('src/client/Market.module.css'), 'utf8')
    const rule = (sel: string) => {
      const m = new RegExp(`^\\.${sel}\\{([^}]*)\\}`, 'mu').exec(css)
      expect(m, `.${sel} rule not found in Market.module.css`).not.toBeNull()
      return m![1]!
    }
    const px = (decls: string, prop: string) => {
      const m = new RegExp(`(?:^|[;{\\s])${prop}:([^;]+)`, 'u').exec(decls)
      expect(m, `${prop} not declared`).not.toBeNull()
      return m![1]!.trim().split(/\s+/u).map(v => Number.parseFloat(v))
    }
    const [, , padBottom] = px(rule('body'), 'padding')
    const [scrollPadBottom] = px(rule('body'), 'scroll-padding-bottom')
    const [inset] = px(rule('top'), 'bottom')
    const [height] = px(rule('topBtn'), 'height')
    const clearance = inset! + height!
    expect(padBottom).toBeGreaterThan(clearance)
    expect(scrollPadBottom).toBeGreaterThan(clearance)
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
      // Squeezed to the one-row budget — the same row the collapsed state
      // uses, chevron included in its own cell beside the wrap rather than
      // taking a chip slot.
      expect(chipCount()).toBe(4) // "all" pill + 3 categories
      // Auto-collapse is render-derived (`catsExpanded = stuckExpanded` while
      // pinned, starting false) — not a follow-up catsOpen flip. Chevron still
      // tracks catsExpanded, and clicking it while stuck must keep working
      // (earlier display-only overrides left catsOpen true and ignored the
      // click — "吸顶滚动了之后，展开没反应了").
      const moreButton = screen.getByLabelText(re(en.catsMore))
      fireEvent.click(moreButton)
      await waitFor(() => expect(chipCount()).toBe(openCount))
      expect(screen.getByLabelText(re(en.catsLess))).toBeTruthy()

      // An explicit re-open while still stuck must survive scrolling back to
      // the top — catsOpen stays aligned with the chevron so unstuck keeps
      // the open row.
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

  function stubWindowControlsOverlay(initialHeight: number) {
    let height = initialHeight
    let visible = true
    const listeners = new Set<EventListener>()
    const emit = () => { for (const listener of [...listeners]) listener(new Event('geometrychange')) }
    const overlay = {
      get visible() { return visible },
      getTitlebarAreaRect: vi.fn(() => ({ height })),
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        if (type === 'geometrychange') listeners.add(listener)
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        if (type === 'geometrychange') listeners.delete(listener)
      }),
    }
    const mockedNavigator = Object.create(navigator) as Navigator & { windowControlsOverlay: typeof overlay }
    Object.defineProperty(mockedNavigator, 'windowControlsOverlay', { configurable: true, value: overlay })
    vi.stubGlobal('navigator', mockedNavigator)
    return {
      overlay,
      setHeight(next: number) {
        height = next
        emit()
      },
      setVisible(next: boolean) {
        visible = next
        emit()
      },
    }
  }

  it('labels the rolling download count and exposes source dates on cards and install details', async () => {
    const registry = registryWithShots()
    Object.assign(registry.plugins[0], {
      downloadsStart: '2026-08-25', downloadsEnd: '2026-09-23', downloadsCheckedAt: '2026-09-24',
    })
    stubFetch({ '/dsh-market/registry': { source: 'live', registry } })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    const count = screen.getByLabelText(/npm rolling 30-day downloads: 4200/)
    expect(count.textContent).toBe('· ↓ 4.2k')
    expect(count.getAttribute('tabindex')).toBe('0')
    expect(count.getAttribute('aria-label')).toContain('2026-08-25 to 2026-09-23')
    expect(count.getAttribute('aria-label')).toContain('2026-09-24')
    let card: HTMLElement | null = screen.getByText('dsh-loop')
    while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) card = card.parentElement
    fireEvent.click(within(card!).getAllByRole('button', { name: en.install })[0]!)
    await screen.findByRole('button', { name: en.confirmInstall })
    // The dialog carries the methodology on its own download mark, not as a
    // second paragraph in the body (#739).
    const dialog = within(screen.getByRole('dialog'))
    const dialogCount = dialog.getByLabelText(/npm rolling 30-day downloads: 4200/)
    expect(dialogCount.getAttribute('tabindex')).toBe('0')
    expect(dialogCount.getAttribute('aria-label')?.toLowerCase()).toContain('not lifetime downloads or unique users')
    expect(dialogCount.getAttribute('aria-label')).toContain('2026-09-24')
    expect(dialog.queryByText(/Source checked at: 2026-09-24/)).toBeNull()
  })

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

  it('leaves the close button on its normal CSS inset when there is no native titlebar overlay', async () => {
    stubFetch({ '/dsh-market/registry': { source: 'live', registry: registryWithShots() } })
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')

    fireEvent.click(container.querySelector('img[class*="cardShot"]')!)
    const close = await waitFor(() => {
      const found = document.querySelector('[class*="lightboxClose"]') as HTMLButtonElement | null
      expect(found).toBeTruthy()
      return found!
    })
    // No inline override means the stylesheet's 16px inset remains the one
    // source of truth in an ordinary browser.
    expect(close.style.top).toBe('')
  })

  it('keeps the close button below the native titlebar and follows geometry changes (#384)', async () => {
    const controls = stubWindowControlsOverlay(42)
    stubFetch({ '/dsh-market/registry': { source: 'live', registry: registryWithShots() } })
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')

    fireEvent.click(container.querySelector('img[class*="cardShot"]')!)
    const close = await waitFor(() => {
      const found = document.querySelector('[class*="lightboxClose"]') as HTMLButtonElement | null
      expect(found).toBeTruthy()
      return found!
    })
    // Real official-shell report: 42px native band + the existing 16px visual
    // inset. The whole 36px control now starts below the band, not inside it.
    expect(close.style.top).toBe('58px')

    act(() => controls.setHeight(36))
    await waitFor(() => expect(close.style.top).toBe('52px'))

    // A shell can turn the overlay off. Its previous geometry must not leave
    // a stale desktop offset behind when the native overlay is no longer visible.
    act(() => controls.setVisible(false))
    await waitFor(() => expect(close.style.top).toBe(''))

    // Visible again but with no reserved band is the same browser fallback.
    act(() => { controls.setVisible(true); controls.setHeight(0) })
    await waitFor(() => expect(close.style.top).toBe(''))

    fireEvent.click(close)
    await waitFor(() => expect(document.querySelector('[class*="lightboxImg"]')).toBeNull())
    expect(controls.overlay.removeEventListener).toHaveBeenCalledWith('geometrychange', expect.any(Function))
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


describe('Git to npm source migration (#461)', () => {
  it.each([false, true])('requires source and busy-risk confirmations for migration (busy=%s, #779)', async busy => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-loop': 'github:alice/dsh-loop' },
        live: ['dsh-loop'],
        disabled: [],
        groups: {},
        groupOrder: [],
      },
      '/dsh-market/updates': {
        updates: {
          'dsh-loop': {
            kind: 'github',
            version: '1.0.0',
            current: 'a'.repeat(40),
            latest: 'a'.repeat(40),
            updateAvailable: false,
            sourceMigration: {
              kind: 'git-to-npm',
              repo: 'alice/dsh-loop',
              target: '@alice/dsh-loop',
            },
          },
        },
      },
      '/dsh-market/migrate-source': (body: unknown) => busy && (body as { confirmAgentsRunning?: boolean }).confirmAgentsRunning !== true
        ? { ok: false, agentsBusy: true, runningAgents: ['main'], __status: 409 }
        : {
          ok: true,
          from: { name: 'dsh-loop', source: 'github:alice/dsh-loop' },
          to: { name: '@alice/dsh-loop', source: 'npm' },
          activation: {},
          warnings: [],
        },
    })

    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))

    fireEvent.click(await screen.findByRole('button', { name: en.migrateNpm }))
    const dialog = await screen.findByRole('dialog', { name: re(en.migrateTitle) })
    expect(within(dialog).getByText(/github:alice\/dsh-loop/)).toBeTruthy()
    expect(within(dialog).getByText('@alice/dsh-loop')).toBeTruthy()
    expect(fetchCalls.some(call => call.path.endsWith('/dsh-market/migrate-source'))).toBe(false)

    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
    await waitFor(() => expect(screen.queryByText(en.migrateTitle)).toBeNull())
    expect(fetchCalls.some(call => call.path.endsWith('/dsh-market/migrate-source'))).toBe(false)

    fireEvent.click(await screen.findByRole('button', { name: en.migrateNpm }))
    const reopened = await screen.findByRole('dialog', { name: re(en.migrateTitle) })
    fireEvent.click(within(reopened).getByRole('button', { name: en.migrateContinue }))

    await waitFor(() => {
      expect(fetchCalls).toContainEqual({
        path: '/dsh-market/migrate-source',
        method: 'POST',
        body: { name: 'dsh-loop' },
      })
    })
    if (busy) {
      const posts = () => fetchCalls.filter(call => call.path === '/dsh-market/migrate-source' && call.method === 'POST')
      const risk = await screen.findByRole('dialog', { name: re(en.agentsRunningConfirm) })
      expect(within(risk).getByText(en.agentsRunningRisk)).toBeTruthy()
      expect(posts()).toHaveLength(1)
      fireEvent.click(within(risk).getByRole('button', { name: en.cancel }))
      await waitFor(() => expect(screen.queryByRole('dialog', { name: re(en.agentsRunningConfirm) })).toBeNull())
      expect(posts()).toHaveLength(1)

      fireEvent.click(await screen.findByRole('button', { name: en.migrateNpm }))
      const source = await screen.findByRole('dialog', { name: re(en.migrateTitle) })
      fireEvent.click(within(source).getByRole('button', { name: en.migrateContinue }))
      const retryRisk = await screen.findByRole('dialog', { name: re(en.agentsRunningConfirm) })
      expect(posts()).toHaveLength(2)
      fireEvent.click(within(retryRisk).getByRole('button', { name: en.opUpdateNow }))
      await waitFor(() => expect(posts()).toHaveLength(3))
      expect(posts()[2]!.body).toEqual({ name: 'dsh-loop', confirmAgentsRunning: true })
    }
  })
})

describe('npm rename migration (#1012)', () => {
  // The successor carries the new npm name while the profile still holds the
  // former one: the host refuses to install it beside that install, because
  // both would register the same loader rows (#122).
  const SUCCESSOR = {
    name: 'dsh-renamed',
    owner: 'alice',
    url: 'https://github.com/alice/dsh-renamed',
    category: ['tools'],
    npm: '@scope/dsh-renamed',
    stars: 50,
    added: '2026-08-01',
    description: { en: 'Renamed plugin', zh: '改名的插件' },
    install: '',
  }
  const FORMER = 'dsh-renamed-old'

  it('follows an install refusal into the rename dialog and runs the migration', async () => {
    stubFetch({
      '/dsh-market/registry': {
        source: 'live',
        hostVersion: '0.1.2-alpha.2',
        registry: { ...REGISTRY, count: 1, plugins: [SUCCESSOR] },
      },
      '/dsh-market/installed': {
        profile: 'web',
        installed: { [FORMER]: '^0.9.6' },
        live: [FORMER],
        disabled: [],
        groups: {},
        groupOrder: [],
        favorites: [],
        blocked: [],
      },
      // What the host answers when the successor would collide with the
      // install it is meant to replace: not a plain failure, a rename question.
      '/dsh-market/install': {
        __status: 409,
        ok: false,
        error: 'name conflict',
        migration: { from: FORMER, target: '@scope/dsh-renamed' },
      },
      '/dsh-market/migrate-source': {
        ok: true,
        from: { name: FORMER, source: '^0.9.6' },
        to: { name: '@scope/dsh-renamed', source: 'npm' },
        activation: {},
        warnings: [],
      },
    })

    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-renamed')
    fireEvent.click(screen.getAllByRole('button', { name: en.install })[0]!)
    fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))

    // The refusal is a question with one answer: the dialog names both
    // packages, and its note is reassurance rather than a warning — a rename
    // cannot touch data the plugin saved itself (#4).
    const dialog = await screen.findByRole('dialog', { name: re(en.renameTitle) })
    expect(within(dialog).getByText(`${FORMER}: ^0.9.6`)).toBeTruthy()
    expect(within(dialog).getByText('@scope/dsh-renamed')).toBeTruthy()
    const note = within(dialog).getByText(en.renameWarning)
    expect(note.classList.contains(css.migrationNote)).toBe(true)
    expect(note.classList.contains(css.migrationWarning)).toBe(false)
    // Opening the dialog decides nothing; only the confirm button runs the
    // transaction, which is the whole reason the host refused in the first place.
    expect(fetchCalls.some(call => call.path === '/dsh-market/migrate-source')).toBe(false)

    fireEvent.click(within(dialog).getByRole('button', { name: en.renameContinue }))
    await waitFor(() => {
      expect(fetchCalls).toContainEqual({
        path: '/dsh-market/migrate-source',
        method: 'POST',
        body: { name: FORMER, kind: 'npm-rename', to: '@scope/dsh-renamed' },
      })
    })
  })
})

describe('restart banner counts only restart-requiring updates (#558)', () => {
  const INSTALLED = { profile: 'web', installed: { 'dsh-loop': '^1.0.0', 'whale-skin': '^1.0.0' }, live: ['dsh-loop', 'whale-skin'], disabled: [], groups: {}, groupOrder: [], favorites: [] }
  const STATUS = { active: false, busy: false, pnpm: true, boot: 'boot-1', restart: true, installed: { 'dsh-loop': '^1.0.0', 'whale-skin': '^1.0.0' } }
  const UPDATES = {
    updates: {
      'dsh-loop': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true },
      'whale-skin': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.1.0', updateAvailable: true },
    },
  }

  /** One plugin the host parks behind a restart, one client-only that goes
    * live immediately — the exact mix reported in #558. */
  function stubMixedUpdateResponses() {
    stubFetch({
      '/dsh-market/installed': INSTALLED,
      '/dsh-market/status': STATUS,
      '/dsh-market/updates': UPDATES,
      '/dsh-market/update': (body: unknown) => {
        const name = (body as { name?: string }).name
        return {
          ok: true,
          activation: name === 'dsh-loop'
            ? { 'dsh-loop': { state: 'restart', hot: false, bundle: true, reasons: ['restart to apply'] } }
            : { 'whale-skin': { state: 'inert', hot: true, bundle: false, reasons: ['client-only, live on refresh'] } },
        }
      },
    })
  }

  const gotoInstalled = async () => {
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await screen.findAllByRole('button', { name: en.update }, { timeout: 5000 })
    return (name: string) => {
      const rows = [...document.querySelectorAll<HTMLElement>('div[class*="irow"]')]
        .filter(r => within(r).queryByRole('button', { name: en.update }) && (r.textContent ?? '').includes(name))
      const row = rows[rows.length - 1]
      if (!row) throw new Error(`no installed row found for ${name}`)
      return within(row).getByRole('button', { name: en.update })
    }
  }

  it('counts a client-only update as a change but not as restart-pending', async () => {
    stubMixedUpdateResponses()
    const updateOnRow = await gotoInstalled()

    fireEvent.click(updateOnRow('dsh-loop'))
    await screen.findByText(re(en.updated))
    fireEvent.click(updateOnRow('whale-skin'))
    await waitFor(() => {
      expect(screen.getAllByText(re(en.updated)).length).toBeGreaterThanOrEqual(2)
    })

    // Both changes are done, but only one needs a restart: the banner must
    // show the host-agreeing count (1), not the completed-change count (2).
    const banner = await screen.findByText(re(en.restartBanner))
    expect(within(banner).getByText('1')).toBeTruthy()
  })

  it('counts an update with no activation evidence as restart-pending (#558)', async () => {
    // The conservative default the gate exists for: when the host reports no
    // activation for the plugin at all, the update must still land in the
    // restart count — under-reporting tells the user "no restart needed"
    // while the old build is what answers.
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: ['dsh-loop'], disabled: [], groups: {}, groupOrder: [], favorites: [] },
      '/dsh-market/status': { active: false, busy: false, pnpm: true, boot: 'boot-1', restart: true, installed: { 'dsh-loop': '^1.0.0' } },
      '/dsh-market/updates': { updates: { 'dsh-loop': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
      '/dsh-market/update': { ok: true },
    })

    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await screen.findByRole('button', { name: en.update })
    fireEvent.click(screen.getByRole('button', { name: en.update }))
    await screen.findByText(re(en.updated))

    const banner = await screen.findByText(re(en.restartBanner))
    expect(within(banner).getByText('1')).toBeTruthy()
  })

  it('keeps the banner consistent across a session loss (#558)', async () => {
    stubMixedUpdateResponses()
    const updateOnRow = await gotoInstalled()

    fireEvent.click(updateOnRow('dsh-loop'))
    await screen.findByText(re(en.updated))
    fireEvent.click(updateOnRow('whale-skin'))
    await waitFor(() => {
      expect(screen.getAllByText(re(en.updated)).length).toBeGreaterThanOrEqual(2)
    })

    // Session storage lost (new tab): the host count is the only evidence
    // left and must agree with what the banner showed before the loss.
    sessionStorage.clear()
    await waitFor(() => {
      const banner = screen.getByText(re(en.restartBanner))
      expect(within(banner).getByText('1')).toBeTruthy()
    })
  })
})


describe('Update all button visible for a single updatable plugin (#555)', () => {
  function stubSingleUpdatable() {
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: ['dsh-loop'], disabled: [], groups: {}, groupOrder: [], favorites: [] },
      '/dsh-market/status': { active: false, busy: false, pnpm: true, boot: 'boot-1', restart: true, installed: { 'dsh-loop': '^1.0.0' } },
      '/dsh-market/updates': { updates: { 'dsh-loop': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
    })
  }

  it('shows the Update all button when only one plugin is updatable', async () => {
    stubSingleUpdatable()
    render(<MarketSection {...props()} />)
    const btn = await screen.findByRole('button', { name: /Update all \(1\)/ })
    expect(btn).toBeTruthy()
  })
})

describe('catalog version in discover byline (#348)', () => {
  it('shows v{version} when the catalog supplies a string, and omits null/absent', async () => {
    const registry = JSON.parse(JSON.stringify(REGISTRY))
    registry.plugins[0].version = '1.2.3'
    registry.plugins[1].version = null
    stubFetch({ '/dsh-market/registry': { source: 'live', registry, hostVersion: '0.1.2-alpha.2' } })
    render(<MarketSection {...props()} />)
    const loop = (await screen.findByText('dsh-loop')).closest('[class*="card"]') as HTMLElement
    const notify = screen.getByText('dsh-notify').closest('[class*="card"]') as HTMLElement
    expect(within(loop).getByText('· v1.2.3')).toBeTruthy()
    expect(within(notify).queryByText(/^· v/)).toBeNull()
  })

  it('says the number comes from the catalog, with the date it was built (#712)', async () => {
    // Reported as "the card shows v0.3.4 but npm has v0.3.6". The number is
    // the catalog's copy, refreshed daily, and the tooltip used to call it
    // "npm latest" — which is how a data-age question becomes a bug report.
    const registry = JSON.parse(JSON.stringify(REGISTRY))
    registry.plugins[0].version = '1.2.3'
    registry.updated = '2026-09-24'
    stubFetch({ '/dsh-market/registry': { source: 'live', registry, hostVersion: '0.1.2-alpha.2' } })
    render(<MarketSection {...props()} />)
    const mark = await screen.findByText('· v1.2.3')
    fireEvent.mouseEnter(mark)
    const tip = await screen.findByText(/2026-09-24/)
    // The test's locale is English; assert the claim, not the translation.
    expect(tip.textContent).toMatch(/catalog's last refresh/)
    expect(tip.textContent).not.toMatch(/^npm latest$/)
  })

  it('falls back to "updates daily" when the catalog carries no date', async () => {
    const registry = JSON.parse(JSON.stringify(REGISTRY))
    registry.plugins[0].version = '1.2.3'
    registry.updated = ''
    stubFetch({ '/dsh-market/registry': { source: 'live', registry, hostVersion: '0.1.2-alpha.2' } })
    render(<MarketSection {...props()} />)
    const mark = await screen.findByText('· v1.2.3')
    fireEvent.mouseEnter(mark)
    const tip = await screen.findByText(/updates daily/)
    expect(tip.textContent).not.toMatch(/\(\)/)
  })
})

describe('recently added Discover row (#780)', () => {
  const now = Date.parse('2026-09-30T12:00:00Z')
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString()
  const entry = (name: string, downloads: number | null, stars: number, added = daysAgo(2)) => ({
    name, owner: 'alice', url: `https://github.com/alice/${name}`, category: 'tools',
    npm: downloads === null ? null : name, downloads, stars, added,
    description: { en: `${name} description` }, install: '',
  })
  const rows = () => [
    entry('github-low', null, 5), entry('zero', 0, 2),
    entry('cutoff', 10, 999, daysAgo(7)), entry('github-high', null, 500),
    entry('recent-high', 900, 1), entry('old-high', 9999, 1000, daysAgo(7) + 'invalid'),
    entry('old', 8000, 1000, daysAgo(7 + 1 / 86_400_000)),
    entry('future', 7000, 1000, daysAgo(-1)), entry('undated', 6000, 1000, ''),
  ]
  const recentNames = ['recent-high', 'cutoff', 'zero', 'github-high', 'github-low']
  const registry = (plugins = rows()) => ({
    source: 'live', hostVersion: '0.1.2-alpha.2',
    registry: { ...REGISTRY, count: plugins.length, plugins },
  })
  const recent = () => screen.getByRole('region', { name: en.recentlyAdded })
  const names = (element: HTMLElement) => [...element.querySelectorAll<HTMLAnchorElement>(`.${css.nmLink}`)]
    .map(link => link.getAttribute('aria-label')?.replace(/ — .*$/, '') ?? '')
  const expectHidden = () => expect(screen.queryByRole('region', { name: en.recentlyAdded })).toBeNull()

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('shows recent plugins as one compact strip, not full cards', async () => {
    const plugins = rows().map(plugin => plugin.name === 'recent-high'
      ? { ...plugin, screenshots: ['https://example.com/recent-high.png'] }
      : plugin)
    stubFetch({ '/dsh-market/registry': registry(plugins) })
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByRole('region', { name: en.recentlyAdded })
    expect(recent().getAttribute('aria-labelledby')).toBe('dshm-recently-added')
    expect(within(recent()).getByRole('heading', { name: en.recentlyAdded }).id).toBe('dshm-recently-added')
    // The strip is a teaser, not a second copy of the masonry: equal-height
    // tiles, no screenshots. Extra entries live in a quiet horizontal scroll
    // so the block stays one row tall.
    expect(names(recent())).toEqual(recentNames)
    expect(within(recent()).getAllByRole('button', { name: en.install })).toHaveLength(recentNames.length)
    expect(recent().querySelectorAll(`.${css.recentTile}`)).toHaveLength(recentNames.length)
    expect(recent().querySelector(`.${css.card}`)).toBeNull()
    expect(recent().querySelector(`.${css.cardShot}`)).toBeNull()
    expect(within(recent()).queryByRole('button', { name: en.comments })).toBeNull()
    expect(within(recent()).getByText('recent-high description')).toBeTruthy()
    expect(rankedNames(container)[0]).toBe('old-high')
    // A heading plus the strip, not a second catalog row. The scrollbar
    // is the break; a hairline under it was a second divider.
    expect(recent().className).toContain(css.recentBlock)
    expect(within(recent()).queryByText(en.timeWeek)).toBeNull()
  })

  it('puts the avatar on the same row as the name, not beside the whole tile', async () => {
    stubFetch({ '/dsh-market/registry': registry() })
    render(<MarketSection {...props()} />)
    await screen.findByRole('region', { name: en.recentlyAdded })
    const tile = recent().querySelector(`.${css.recentTile}`)!
    const title = tile.querySelector(`.${css.recentTitle}`)!
    const bottom = tile.querySelector(`.${css.recentBottom}`)!
    const avatar = tile.querySelector(`.${css.recentAv}`)
    const name = within(tile).getByRole('link')
    const install = within(tile).getByRole('button', { name: en.install })
    const more = within(tile).getByRole('button', { name: en.groupMore })
    const desc = within(tile).getByText('recent-high description')
    // Avatar, name and install share the top row so the description can
    // start at the left edge instead of indenting under the name.
    expect(title.contains(avatar)).toBe(true)
    expect(title.contains(name)).toBe(true)
    expect(title.contains(install)).toBe(true)
    expect(title.contains(desc)).toBe(false)
    expect(bottom.contains(desc)).toBe(true)
    expect(bottom.contains(more)).toBe(true)
    expect(title.querySelector(`.${css.recentName}`)?.contains(name)).toBe(true)
  })

  it('keeps install on the title row and the menu on the bottom row when there is no description', async () => {
    stubFetch({ '/dsh-market/registry': registry([{ ...entry('recent-high', 900, 1), description: { en: '' } }]) })
    render(<MarketSection {...props()} />)
    await screen.findByRole('region', { name: en.recentlyAdded })
    const tile = recent().querySelector(`.${css.recentTile}`)!
    const title = tile.querySelector(`.${css.recentTitle}`)!
    const bottom = tile.querySelector(`.${css.recentBottom}`)!
    expect(title.contains(within(tile).getByRole('link'))).toBe(true)
    expect(title.contains(within(tile).getByRole('button', { name: en.install }))).toBe(true)
    expect(bottom.contains(within(tile).getByRole('button', { name: en.groupMore }))).toBe(true)
    expect(tile.querySelector(`.${css.recentDesc}`)).toBeNull()
  })

  it('keeps the full name and description available on hover', async () => {
    stubFetch({ '/dsh-market/registry': registry() })
    render(<MarketSection {...props()} />)
    await screen.findByRole('region', { name: en.recentlyAdded })
    const first = recent().querySelector(`.${css.recentTile}`)!
    const name = within(first).getByRole('link')
    const desc = within(first).getByText('recent-high description')
    // Native title is the beige system bubble; the host Tooltip is the one
    // that matches the rest of the page.
    expect(name.getAttribute('title')).toBeNull()
    expect(desc.getAttribute('title')).toBeNull()
    fireEvent.mouseEnter(name)
    expect(screen.queryByRole('tooltip')).toBeNull()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)) })
    expect(screen.queryByRole('tooltip')).toBeNull()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    expect(screen.getByRole('tooltip').textContent).toBe('recent-high')
    fireEvent.mouseLeave(name)
    fireEvent.mouseEnter(desc)
    expect(screen.queryByRole('tooltip')).toBeNull()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)) })
    expect(screen.queryByRole('tooltip')).toBeNull()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    expect(screen.getByRole('tooltip').textContent).toBe('recent-high description')
    fireEvent.mouseLeave(desc)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('keeps extra recent tiles on a quiet horizontal scroll, capped at eight', async () => {
    const extra = Array.from({ length: 10 }, (_, index) => entry(`recent-extra-${index}`, 800 - index, 1))
    stubFetch({ '/dsh-market/registry': registry([...rows(), ...extra]) })
    render(<MarketSection {...props()} />)
    await screen.findByRole('region', { name: en.recentlyAdded })
    const row = recent().querySelector('#dshm-recent-grid')!
    // The teaser is one row: overflow, not a second catalog page and not a
    // width-clipped subset mouse users would never reach. waitFor: a prior
    // test may have left the module catalog cache at five entries.
    expect(row.className).toContain(css.recentRow)
    await waitFor(() => {
      expect(recent().querySelectorAll(`.${css.recentTile}`)).toHaveLength(8)
    })
    expect(names(recent())).toEqual(['recent-high', ...extra.slice(0, 7).map(plugin => plugin.name)])
  })

  it('keeps extra tiles reachable by a quiet horizontal scroll that still peeks', () => {
    // jsdom does no layout, so peek and overflow cannot be observed on the
    // node. The contract lives in the stylesheet: overflow-x auto (not
    // hidden, not a hidden scrollbar), tiles that do not shrink, and a
    // 3.25-wide formula so ~800px still shows a sliver of the next card.
    const sheet = readFileSync(resolve('src/client/Market.module.css'), 'utf8')
    const rule = (sel: string) => {
      const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const match = new RegExp(`^\\.${escaped}\\{([^}]*)\\}`, 'mu').exec(sheet)
      expect(match, `.${sel} rule not found in Market.module.css`).not.toBeNull()
      return match![1]!
    }
    const row = rule('recentRow')
    expect(row).toContain('overflow-x:auto')
    expect(row).not.toContain('overflow:hidden')
    expect(row).toContain('scrollbar-width:thin')
    expect(row).not.toContain('scrollbar-width:none')
    const tiles = rule('recentRow > *')
    expect(tiles).toContain('flex:0 0 auto')
    expect(tiles).toContain('/ 3.25)')
    expect(tiles).toContain('min-width:220px')
    const collapsed = rule('recentRow.recentCollapsed')
    expect(collapsed).toContain('overflow:hidden')
  })

  it('shows the recent strip again after retrying a failed catalog refresh', async () => {
    stubFetch({ '/dsh-market/registry': registry() })
    render(<MarketSection {...props()} />)
    await screen.findByRole('region', { name: en.recentlyAdded })
    cleanup()
    stubFetch({ '/dsh-market/registry': { __status: 503, error: 'catalog unavailable' } })
    render(<MarketSection {...props()} />)
    await screen.findByText('catalog unavailable')
    expectHidden()
    stubFetch({ '/dsh-market/registry': registry() })
    fireEvent.click(screen.getByRole('button', { name: en.loadRetry }))
    await screen.findByRole('region', { name: en.recentlyAdded })
    expect(names(recent())).toEqual(recentNames)
  })

  it('opens only one menu for either copy of a recent plugin', async () => {
    stubFetch({ '/dsh-market/registry': registry([entry('duplicated-recent', 100, 1)]) })
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByRole('region', { name: en.recentlyAdded })
    const recentMore = within(recent()).getByRole('button', { name: en.groupMore })
    const mainMore = within(container.querySelector(`.${css.masonry}`)!).getByRole('button', { name: en.groupMore })
    for (const [opened, other] of [[recentMore, mainMore], [mainMore, recentMore]] as const) {
      fireEvent.click(opened)
      expect(screen.getAllByRole('menu')).toHaveLength(1)
      expect(opened.getAttribute('aria-expanded')).toBe('true')
      expect(other.getAttribute('aria-expanded')).toBe('false')
      fireEvent.click(opened)
      expect(screen.queryByRole('menu')).toBeNull()
      expect(opened.getAttribute('aria-expanded')).toBe('false')
    }
  })

  it('uses a seven-day downloads/Stars rank without changing the main default or selected sort', async () => {
    stubFetch({ '/dsh-market/registry': registry() })
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByRole('region', { name: en.recentlyAdded })
    expect(names(recent())).toEqual(recentNames)
    // Old, future and dateless entries still belong to the all-time main list.
    expect(rankedNames(container)).toEqual([
      'old-high', 'old', 'future', 'undated', 'recent-high', 'cutoff', 'zero', 'github-high', 'github-low',
    ])
    fireEvent.click(screen.getByRole('button', { name: en.filter }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.sortStars }))
    await waitFor(() => {
      const main = rankedNames(container)
      expect(main.indexOf('cutoff')).toBeLessThan(main.indexOf('recent-high'))
    })
    // The block is the DEFAULT view's teaser and ignores the sort, so it steps
    // aside once the user asks for an order: left above the list it hid the
    // reorder behind a screenful of unchanged cards (#1016).
    expect(screen.queryByRole('region', { name: en.recentlyAdded })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.filter }))
  })

  it('appears only without a search, category or time filter, and only in Discover', async () => {
    stubFetch({ '/dsh-market/registry': registry() })
    const themeSnapshot = { preference: 'light', themes: [] as Array<{ id: string }> }
    render(<MarketSection {...props()} themeStore={{ subscribe: () => () => {}, getSnapshot: () => themeSnapshot }} />)
    await screen.findByRole('region', { name: en.recentlyAdded })
    const search = screen.getByPlaceholderText(en.searchPh)
    fireEvent.change(search, { target: { value: 'recent-high' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(expectHidden)
    fireEvent.change(search, { target: { value: '' } })
    await screen.findByRole('region', { name: en.recentlyAdded })
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }))
    expectHidden()
    fireEvent.click(screen.getByRole('button', { name: /^All \(\d/ }))
    await screen.findByRole('region', { name: en.recentlyAdded })
    fireEvent.click(screen.getByRole('button', { name: en.filter }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.timeWeek }))
    expectHidden()
    fireEvent.click(screen.getByRole('menuitem', { name: en.timeAll }))
    await screen.findByRole('region', { name: en.recentlyAdded })
    // A chosen order is one more narrowing: this block is the default view's
    // teaser, not a header on a sorted list (#1016).
    fireEvent.click(screen.getByRole('menuitem', { name: en.sortStars }))
    expectHidden()
    fireEvent.click(screen.getByRole('menuitem', { name: en.sortDownloads }))
    await screen.findByRole('region', { name: en.recentlyAdded })
    fireEvent.click(screen.getByRole('button', { name: en.filter }))
    for (const tab of [en.tabThemes, en.tabFavorites, en.tabInstalled, en.tabBlocked, en.tabAdvanced]) {
      fireEvent.click(within(document.getElementsByClassName(css.tabs)[0] as HTMLElement).getByRole('button', { name: tab }))
      expectHidden()
      fireEvent.click(screen.getByRole('button', { name: en.tabDiscover }))
      await screen.findByRole('region', { name: en.recentlyAdded })
    }
  })

  it('hides an empty recent selection, including when its only recent entry is hidden', async () => {
    stubFetch({ '/dsh-market/registry': registry([entry('old-only', 100, 1, daysAgo(8))]) })
    render(<MarketSection {...props()} />)
    await screen.findByText('old-only')
    expectHidden()
    cleanup()
    stubFetch({
      '/dsh-market/registry': registry([entry('hidden-recent', 100, 1), entry('old-only', 100, 1, daysAgo(8))]),
      '/dsh-market/installed': {
        profile: 'web', installed: {}, live: [], disabled: [], groups: {}, groupOrder: [],
        favorites: [], blocked: ['hidden-recent'],
      },
    })
    render(<MarketSection {...props()} />)
    await waitFor(() => {
      expect(screen.getByText('old-only')).toBeTruthy()
      expect(screen.queryByText('hidden-recent')).toBeNull()
      expectHidden()
    })
  })

  it('loads an off-page recent card requirement and opens its real install dialog', async () => {
    const plugins = [
      ...Array.from({ length: 24 }, (_, index) => entry(`old-${index}`, 1000 - index, 1, daysAgo(30))),
      entry('off-page-recent', 1, 1),
    ]
    stubFetch({
      '/dsh-market/registry': registry(plugins),
      '/dsh-market/discovery-compatibility': (body: unknown) => ({
        hostVersion: '0.1.2-alpha.2',
        plugins: Object.fromEntries(((body as { packages: string[] }).packages).map(name => [name, {
          status: 'compatible', basis: 'manifest', requirement: '^0.1.2-alpha.2',
          declarations: [{ kind: 'engine', range: '^0.1.2-alpha.2' }],
        }])),
      }),
    })
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByRole('region', { name: en.recentlyAdded })
    expect(names(recent())).toEqual(['off-page-recent'])
    expect(rankedNames(container)).toEqual(plugins.slice(0, 24).map(plugin => plugin.name))
    expect(screen.getByRole('button', { name: en.nextPage })).toBeTruthy()
    await waitFor(() => {
      expect(fetchCalls.some(call => call.path === '/dsh-market/discovery-compatibility'
        && (call.body as { packages?: string[] } | undefined)?.packages?.includes('off-page-recent'))).toBe(true)
    })
    fireEvent.click(within(recent()).getByRole('button', { name: en.install }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('off-page-recent description')).toBeTruthy()
    expect(dialog.getByTitle('Date added').textContent).toContain(daysAgo(2))
    expect(dialog.getByRole('button', { name: en.confirmInstall })).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: en.cancel }))
    await waitFor(() => expect(screen.queryByRole('button', { name: en.confirmInstall })).toBeNull())
  })

  it('calls catalog dates Date added / 收录时间 in both locale keys', () => {
    expect([en.recentlyAdded, zh.recentlyAdded]).toEqual(['Recently added', '最近收录'])
    expect([en.sortAdded, en.published]).toEqual(['Date added', 'Date added'])
    expect([zh.sortAdded, zh.published]).toEqual(['收录时间', '收录时间'])
  })
})

describe('empty filter recovery', () => {
  it('clears Discover search and category without changing the chosen sort', async () => {
    stubFetch({ '/dsh-market/installed': { profile: 'web', installed: {}, live: [], blocked: ['whale-skin'] } })
    const { container } = render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
    fireEvent.click(screen.getByRole('button', { name: en.filter }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.sortStars }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.sortAsc }))
    fireEvent.click(screen.getByRole('button', { name: en.filter }))
    const input = screen.getByPlaceholderText(en.searchPh) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'not-a-plugin' } })
    await screen.findByText(en.empty)
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await screen.findByText('dsh-notify')
    expect(screen.queryByText('whale-skin')).toBeNull()
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('')
    expect(rankedNames(container)).toEqual(['dsh-loop', 'dsh-notify'])
  })

  it('recovers from an empty time range and cancels a pending search draft', async () => {
    const plugins = REGISTRY.plugins.map(plugin => ({ ...plugin, added: '2020-01-01' }))
    stubFetch({ '/dsh-market/registry': { source: 'live', registry: { ...REGISTRY, plugins } } })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: en.filter }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.timeWeek }))
    await screen.findByText(en.empty)
    const input = screen.getByPlaceholderText(en.searchPh) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'pending-query' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(input.value).toBe('')
    await screen.findByText('dsh-loop')
    await new Promise(resolve => setTimeout(resolve, SEARCH_DELAY_MS * 2))
    expect(screen.getByText('dsh-loop')).toBeTruthy()
  })

  it('clears Themes filters independently of Discover', async () => {
    const snapshot = { preference: 'light', themes: [] as Array<{ id: string }> }
    render(<MarketSection {...props()} themeStore={{ subscribe: () => () => {}, getSnapshot: () => snapshot }} />)
    await screen.findByText('dsh-loop')
    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: 'loop' } })
    await waitFor(() => expect(screen.queryByText('dsh-notify')).toBeNull())
    fireEvent.click(screen.getAllByRole('button', { name: en.tabThemes })[0]!)
    await screen.findByText('whale-skin')
    const input = screen.getByPlaceholderText(en.searchPh) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'missing-theme' } })
    await screen.findByText(en.empty)
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await screen.findByText('whale-skin')
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
    fireEvent.click(screen.getByRole('button', { name: en.tabDiscover }))
    expect((screen.getByPlaceholderText(en.searchPh) as HTMLInputElement).value).toBe('loop')
    expect(screen.getByText('dsh-loop')).toBeTruthy()
    expect(screen.queryByText('dsh-notify')).toBeNull()
  })

  it('does not offer a filter reset for an empty catalog', async () => {
    stubFetch({ '/dsh-market/registry': { source: 'live', registry: { ...REGISTRY, count: 0, plugins: [] } } })
    render(<MarketSection {...props()} />)
    await screen.findByText(en.empty)
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
  })
})

describe('sidebar shortcut tip (#846)', () => {
  function fakeSidebar(options: { supported?: boolean; enabled?: boolean; ready?: boolean } = {}): {
    supported(): boolean
    enabled(): boolean
    ready(): boolean
    set(next: boolean): Promise<boolean>
    subscribe(listener: () => void): () => void
    settle(): void
    sets: boolean[]
  } {
    let enabled = options.enabled === true
    let ready = options.ready !== false
    const listeners = new Set<() => void>()
    const sets: boolean[] = []
    const notify = (): void => { for (const listener of listeners) listener() }
    return {
      sets,
      supported: () => options.supported !== false,
      enabled: () => enabled,
      ready: () => ready,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      settle: () => { ready = true; notify() },
      set: async (next) => {
        sets.push(next)
        enabled = next
        ready = true
        notify()
        return next
      },
    }
  }

  it('offers the shortcut on the settings page when the sidebar is off', async () => {
    const sidebar = fakeSidebar()
    render(<MarketSection {...props()} sidebar={sidebar} surface="settings" />)
    expect(await screen.findByText(en.sidebarTip)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.setSidebarOn }))
    await waitFor(() => { expect(sidebar.sets).toEqual([true]) })
    expect(screen.queryByText(en.sidebarTip)).toBeNull()
  })

  it('waits until the saved choice is known before offering the tip', async () => {
    const sidebar = fakeSidebar({ ready: false })
    render(<MarketSection {...props()} sidebar={sidebar} surface="settings" />)
    await screen.findByText(en.nav)
    expect(screen.queryByText(en.sidebarTip)).toBeNull()
    act(() => { sidebar.settle() })
    expect(await screen.findByText(en.sidebarTip)).toBeTruthy()
  })

  it('stays quiet on the sidebar page and when the shortcut is already on', async () => {
    const off = fakeSidebar()
    const { rerender } = render(<MarketSection {...props()} sidebar={off} surface="sidebar" />)
    await screen.findByText(en.nav)
    expect(screen.queryByText(en.sidebarTip)).toBeNull()

    rerender(<MarketSection {...props()} sidebar={fakeSidebar({ enabled: true })} surface="settings" />)
    expect(screen.queryByText(en.sidebarTip)).toBeNull()
  })

  it('does not return after the user dismissed it', () => {
    localStorage.setItem('dshm-sidebar-tip-dismissed', '1')
    render(<MarketSection {...props()} sidebar={fakeSidebar()} surface="settings" />)
    expect(screen.queryByText(en.sidebarTip)).toBeNull()
  })

  it('hides the tip for good when the user dismisses it', async () => {
    render(<MarketSection {...props()} sidebar={fakeSidebar()} surface="settings" />)
    fireEvent.click(await screen.findByRole('button', { name: en.sidebarTipDismiss }))
    expect(localStorage.getItem('dshm-sidebar-tip-dismissed')).toBe('1')
    expect(screen.queryByText(en.sidebarTip)).toBeNull()
  })
})

describe('最近收录 collapses and hides (#940)', () => {
  // The block only renders for entries added in the last 7 days, so the dates
  // are relative to the run, not fixed literals.
  const today = new Date().toISOString().slice(0, 10)
  const RECENT_REGISTRY = {
    updated: '', count: 3,
    categories: REGISTRY.categories,
    plugins: [
      { name: 'dsh-loop', owner: 'alice', url: 'https://github.com/alice/dsh-loop', category: ['tools'], npm: 'dsh-loop', stars: 50, added: today, description: { en: 'Loop task runner', zh: '循环执行' }, install: '' },
      { name: 'dsh-notify', owner: 'bob', url: 'https://github.com/bob/dsh-notify', category: 'tools', npm: null, stars: 120, added: today, description: { en: 'Desktop notifications', zh: '桌面通知' }, install: '' },
      { name: 'whale-skin', owner: 'carol', url: 'https://github.com/carol/whale-skin', category: 'theme', npm: null, stars: 80, added: '2020-01-01', description: { en: 'Whale theme', zh: '鲸鱼主题' }, install: '' },
    ],
  }
  function mount() {
    stubFetch({ '/dsh-market/registry': { source: 'live', registry: RECENT_REGISTRY, hostVersion: '0.1.2-alpha.2' } })
    return render(<MarketSection {...props()} />)
  }
  const gridOf = (container: HTMLElement) => container.querySelector('#dshm-recent-grid')

  it('collapses in place and keeps the grid mounted', async () => {
    const { container } = mount()
    const toggle = await screen.findByRole('button', { name: new RegExp(en.recentlyAdded) })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(gridOf(container)).toBeTruthy()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // Clipped, not unmounted: the strip stays in the tree so expanding it
    // does not rebuild the tiles.
    expect(gridOf(container)).toBeTruthy()
    expect(gridOf(container)!.className).toContain(css.recentCollapsed)
    expect(localStorage.getItem('dshm-recent-collapsed')).toBe('1')
  })

  it('hides the whole block and restores it from the one-line button', async () => {
    const { container } = mount()
    fireEvent.click(await screen.findByRole('button', { name: en.recentHide }))
    expect(gridOf(container)).toBeNull()
    expect(localStorage.getItem('dshm-recent-hidden')).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: en.recentShow }))
    expect(gridOf(container)).toBeTruthy()
    expect(localStorage.getItem('dshm-recent-hidden')).toBe('0')
  })

  it('points the restore row the same way as a collapsed heading', async () => {
    mount()
    const toggle = await screen.findByRole('button', { name: new RegExp(en.recentlyAdded) })
    const openIcon = toggle.querySelector('svg')!.innerHTML
    fireEvent.click(toggle)
    const closedIcon = toggle.querySelector('svg')!.innerHTML
    expect(closedIcon).not.toBe(openIcon)
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: en.recentHide }))
    // Down is "already open". This row is closed; it must match the
    // collapsed heading (right), not the expanded one.
    expect(screen.getByRole('button', { name: en.recentShow }).querySelector('svg')!.innerHTML).toBe(closedIcon)
  })

  it('opens the tiles when bringing the hidden block back', async () => {
    const { container } = mount()
    const toggle = await screen.findByRole('button', { name: new RegExp(en.recentlyAdded) })
    fireEvent.click(toggle)
    expect(gridOf(container)!.className).toContain(css.recentCollapsed)
    fireEvent.click(screen.getByRole('button', { name: en.recentHide }))
    fireEvent.click(screen.getByRole('button', { name: en.recentShow }))
    // "Show recently added" means see the tiles, not land on another
    // collapsed heading that has to be clicked again.
    expect(gridOf(container)!.className).not.toContain(css.recentCollapsed)
    expect(screen.getByRole('button', { name: new RegExp(en.recentlyAdded) }).getAttribute('aria-expanded')).toBe('true')
    expect(localStorage.getItem('dshm-recent-collapsed')).toBe('0')
  })

  it('remembers a hidden block across a remount, then opens it', async () => {
    localStorage.setItem('dshm-recent-collapsed', '1')
    localStorage.setItem('dshm-recent-hidden', '1')
    const { container } = mount()
    const restore = await screen.findByRole('button', { name: en.recentShow })
    expect(gridOf(container)).toBeNull()
    fireEvent.click(restore)
    expect(gridOf(container)!.className).not.toContain(css.recentCollapsed)
    expect(localStorage.getItem('dshm-recent-hidden')).toBe('0')
    expect(localStorage.getItem('dshm-recent-collapsed')).toBe('0')
  })

  it('keeps a collapsed-only choice across a remount', async () => {
    localStorage.setItem('dshm-recent-collapsed', '1')
    const { container } = mount()
    const toggle = await screen.findByRole('button', { name: new RegExp(en.recentlyAdded) })
    expect(screen.queryByRole('button', { name: en.recentShow })).toBeNull()
    expect(gridOf(container)!.className).toContain(css.recentCollapsed)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('when DSH has unloaded the market (#962)', () => {
  it('says the market stopped and that a restart brings it back, instead of loading forever', async () => {
    // The host reloaded its plugins and did not mount the market again: every
    // market route answers 404 while the page's own client keeps running.
    stubFetch({
      '/dsh-market/registry': { __status: 404 },
      '/dsh-market/status': { __status: 404 },
    })
    render(<MarketSection {...props()} />)

    expect(await screen.findByText(en.marketGoneTitle)).toBeTruthy()
    expect(screen.getByText(en.marketGoneBody)).toBeTruthy()
    // Neither the spinner nor the retry: nothing on this page can fix it, and
    // a Retry button that 404s every time is a loop with no way out.
    expect(screen.queryByText(en.loading)).toBeNull()
    expect(screen.queryByRole('button', { name: en.loadRetry })).toBeNull()
  })

  it('settles an install whose answer was lost with the routes, and leaves nothing pending', async () => {
    vi.useFakeTimers()
    try {
      let installStarted = false
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        const path = String(url).split('?')[0]
        if (path === '/dsh-market/install') {
          installStarted = true
          // The host unloaded the market mid-install: the response never comes.
          return new Promise<Response>(() => {})
        }
        if (path === '/dsh-market/status' && installStarted) {
          return Promise.resolve(new Response('', { status: 404 }))
        }
        const payload =
          path === '/dsh-market/registry' ? { source: 'live', registry: REGISTRY, hostVersion: '0.1.2-alpha.2' }
          : path === '/dsh-market/installed' ? { profile: 'web', installed: {}, live: [], disabled: [], groups: {}, groupOrder: [], favorites: [], blocked: [] }
          : path === '/dsh-market/status' ? { active: false, pnpm: true, boot: 'boot-1', restart: true, installed: {} }
          : path === '/dsh-market/updates' ? { updates: {} }
          : path === '/dsh-market/discovery-compatibility' ? { hostVersion: '0.1.2-alpha.2', plugins: {} }
          : null
        if (payload === null) return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
      }))

      render(<MarketSection {...props()} />)
      await vi.waitFor(() => { screen.getByText('dsh-loop') })
      fireEvent.click(screen.getAllByRole('button', { name: en.install })[0]!)
      await vi.waitFor(() => { screen.getByRole('button', { name: en.confirmInstall }) })
      fireEvent.click(screen.getByRole('button', { name: en.confirmInstall }))
      await vi.waitFor(() => { expect(installStarted, 'the install never started').toBe(true) })
      await vi.advanceTimersByTimeAsync(2100)

      await vi.waitFor(() => { screen.getAllByText(en.marketGoneTitle) })
      // The "install in progress" marker must not survive: a remount would
      // otherwise restore the row and spin on a host that is not there.
      expect(sessionStorage.getItem('dshm-pending')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('OwnerAvatar icon', () => {
  it('prefers the catalog-declared icon over the owner avatar', () => {
    const icon = 'https://raw.githubusercontent.com/alice/dsh-loop/main/assets/icon.png'
    const { container } = render(<OwnerAvatar name="dsh-loop" owner="alice" icon={icon} />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(icon)
  })

  it('refuses an icon outside the GitHub image hosts and falls back', () => {
    const { container } = render(
      <OwnerAvatar name="dsh-loop" owner="" icon="https://evil.example/icon.png" />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('L')
  })
})
