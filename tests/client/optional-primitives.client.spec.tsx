// @vitest-environment jsdom
/**
 * The market uses the host's components when the host has them, and its own
 * markup when it does not (#401 review of UI consistency).
 *
 * The suite runs against 0.1.0-rc.7, which has no `Tag` — so this file mocks
 * one in, and the *fallback* is what the other specs see. Both halves are
 * therefore exercised: here that the host's component is used, there that a
 * host without it still renders the same facts.
 */
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async (importOriginal) => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-client-ui-primitives')>(),
  // A marker an assertion can find: the real one renders a styled span with no
  // handle, and what matters here is WHO rendered the chip, not how it looks.
  Tag: ({ tone, children }: { tone?: string; children?: ReactNode }) =>
    <span data-host-tag={tone ?? 'outline'}>{children}</span>,
  Switch: ({ checked, label }: { checked: boolean; label: string }) =>
    <button type="button" data-host-switch={String(checked)} aria-label={label} />,
  Checkbox: ({ checked, label }: { checked: boolean; label: string }) =>
    <label data-host-checkbox={String(checked)}>{label}</label>,
}))

import { MarketSection, resetMarketPortalHost } from '../../src/client/MarketSection.tsx'
import { UpdateNotificationsPanel } from '../../src/client/UpdateNotificationsPanel.tsx'
import { resetGithubRouting, resetScreenshotsCache } from '../../src/client/market-data.ts'
import { en } from '../../src/client/locales.ts'

const REGISTRY = {
  updated: '', count: 1,
  categories: { tools: { en: 'Tools', zh: '工具' } },
  plugins: [{
    name: 'dsh-tagged', owner: 'alice', url: 'https://github.com/alice/dsh-tagged',
    category: 'tools', npm: null, stars: 1, added: '2026-09-01',
    description: { en: 'Tagged', zh: '带标签' }, install: '',
    capabilities: ['shell', 'network'], capabilityRedLines: [], capabilityCheckedAt: '2026-09-24T00:00:00Z',
  }],
}

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn((input: unknown) => {
    const path = String(input).split('?')[0]
    if (path === '/dsh-market/registry') return Promise.resolve(new Response(JSON.stringify({ source: 'live', hostVersion: '0.1.2-alpha.2', registry: REGISTRY })))
    if (path === '/dsh-market/installed') return Promise.resolve(new Response(JSON.stringify({ profile: 'web', installed: {}, live: [], disabled: [], groups: {}, groupOrder: [], favorites: [] })))
    if (path === '/dsh-market/status') return Promise.resolve(new Response(JSON.stringify({ active: false, pnpm: true, boot: 'boot-1', restart: true, installed: {} })))
    if (path === '/dsh-market/updates') return Promise.resolve(new Response(JSON.stringify({ updates: {} })))
    return Promise.reject(new Error(`unstubbed fetch: ${path}`))
  }))
}

// Stable identity: useSyncExternalStore reads a fresh object per call as an
// endless change feed.
const LOCALE_SNAPSHOT = { active: 'en' }

const props = () => ({
  t: (key: string) => (en as Record<string, string>)[key] ?? key,
  locale: { subscribe: () => () => {}, getSnapshot: () => LOCALE_SNAPSHOT },
  theme: { setTheme: () => {} },
  themeStore: { subscribe: () => () => {}, getSnapshot: () => null },
})

beforeEach(() => { stubFetch(); resetGithubRouting(); resetScreenshotsCache(); resetPortal() })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetGithubRouting() })
function resetPortal(): void { resetMarketPortalHost() }

describe('capability chips on a host that has Tag', () => {
  it('renders them with the host component, not the market own markup', async () => {
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-tagged')
    // The chips live behind the detail dialog's disclosure now, not on the card.
    let card: HTMLElement | null = screen.getByText('dsh-tagged')
    while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) card = card.parentElement
    fireEvent.click(within(card!).getAllByRole('button', { name: en.install })[0]!)
    await screen.findByRole('button', { name: en.confirmInstall })
    fireEvent.click(within(screen.getByRole('dialog')).getByText(en.capabilityTitle))
    const shell = screen.getByText(en.capShell)
    expect(shell.getAttribute('data-host-tag')).toBe('outline')
    expect(screen.getByText(en.capNetwork).getAttribute('data-host-tag')).toBe('outline')
    // The absence state is a quieter fact, so it asks for the quieter tone.
    const none = screen.queryByText(en.capabilityNone)
    expect(none === null || none.getAttribute('data-host-tag') === 'quiet').toBe(true)
  })
})

describe('the on/off control on a host that has Switch', () => {
  it('gives automatic update checks visible text when the host label is accessibility-only', () => {
    render(<UpdateNotificationsPanel
      t={key => (en as Record<string, string>)[key] ?? key} busy={false}
      onUpdate={() => {}} onCheck={async () => {}} onEnabled={async () => {}}
      snapshot={{ enabled: true, checking: false, checkedAt: null, lastSuccessAt: null, nextCheckAt: null,
        stale: false, error: null, boot: 'boot', updates: {}, updateExempt: [], disabled: [], blocked: [] }}
    />)
    expect(screen.getByText(en.updateChecksAutomatic)).toBeTruthy()
    expect(document.querySelector('[data-host-switch]')?.getAttribute('aria-label')).toBe(en.updateChecksAutomatic)
  })

  it('renders the host switch in the installed rows, not the market one', async () => {
    // The host's own plugin list uses `Switch`; the market's rows sit in that
    // list, so they take it too. The market's markup is the fallback (asserted
    // in the main spec, which runs against 0.1.0-rc.7).
    vi.stubGlobal('fetch', vi.fn((input: unknown) => {
      const path = String(input).split('?')[0]
      if (path === '/dsh-market/registry') return Promise.resolve(new Response(JSON.stringify({ source: 'live', hostVersion: '0.1.2-alpha.2', registry: REGISTRY })))
      if (path === '/dsh-market/installed') {
        return Promise.resolve(new Response(JSON.stringify({
          profile: 'web', installed: { 'dsh-tagged': '^1.0.0' }, live: [], disabled: [], groups: {}, groupOrder: [], favorites: [],
          // A switch renders only for a state the market can switch: off, or
          // live/restart. Without this the row is inert and shows a diagnosis
          // instead (#60).
          activation: { 'dsh-tagged': { state: 'live' } },
        })))
      }
      if (path === '/dsh-market/status') return Promise.resolve(new Response(JSON.stringify({ active: false, pnpm: true, boot: 'boot-1', restart: true, installed: { 'dsh-tagged': '^1.0.0' } })))
      if (path === '/dsh-market/updates') return Promise.resolve(new Response(JSON.stringify({ updates: {} })))
      return Promise.reject(new Error(`unstubbed fetch: ${path}`))
    }))
    render(<MarketSection {...props()} preferredSubsectionId="installed" />)
    await screen.findAllByText('dsh-tagged')
    // The update-check preferences also have a switch; assert the installed
    // plugin's control rather than whichever switch happens to render first.
    const pluginSwitch = screen.getByRole('button', { name: /Disable dsh-tagged/ })
    expect(pluginSwitch.hasAttribute('data-host-switch')).toBe(true)
  })
})

describe('labelled checkboxes on a host that has Checkbox', () => {
  it('uses the host checkbox for the market simple labelled ones', async () => {
    // The Advanced tab's auto-backup flag is a plain labelled checkbox, which
    // is exactly what the host's component is for. Its rich-label siblings
    // (the export rows) keep native markup — `HostCheckbox` says why.
    vi.stubGlobal('fetch', vi.fn((input: unknown) => {
      const path = String(input).split('?')[0]
      if (path === '/dsh-market/registry') return Promise.resolve(new Response(JSON.stringify({ source: 'live', hostVersion: '0.1.2-alpha.2', registry: REGISTRY })))
      if (path === '/dsh-market/installed') return Promise.resolve(new Response(JSON.stringify({ profile: 'web', installed: {}, live: [], disabled: [], groups: {}, groupOrder: [], favorites: [] })))
      if (path === '/dsh-market/status') return Promise.resolve(new Response(JSON.stringify({ active: false, pnpm: true, boot: 'boot-1', restart: true, installed: {} })))
      if (path === '/dsh-market/updates') return Promise.resolve(new Response(JSON.stringify({ updates: {} })))
      return Promise.reject(new Error(`unstubbed fetch: ${path}`))
    }))
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-tagged')
    const advanced = screen.getAllByRole('button', { name: /^(Advanced|高级)$/u })
      .find(button => /(^|_)tab(_|$)/u.test(button.className))
    expect(advanced, 'no Advanced tab').toBeTruthy()
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.click(advanced!)
    const boxes = await screen.findAllByText(en.autoBackup)
    expect(boxes.length).toBeGreaterThan(0)
    const host = document.querySelector('[data-host-checkbox]')
    expect(host).toBeTruthy()
    expect(host!.textContent).toBe(en.autoBackup)
  })
})
