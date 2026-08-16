// @vitest-environment jsdom
/**
 * Portable render tests for the issue #98 phase 2/3 Diagnostics panels: the
 * community-bundle ordering block (orderConflicts), the collapsible snapshots
 * & rollback panel (snapshot-panel.tsx) and the collapsible plugin presets
 * panel (preset-panel.tsx). The host boundary is stubbed with a URL-routing
 * fetch mock (GET /dsh-market/check, GET+POST /dsh-market/snapshots,
 * POST /dsh-market/restore-snapshot, GET+POST /dsh-market/presets) — no real
 * profile, no absolute machine paths, so this runs on any environment/CI.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Diagnostics } from '../../src/client/Diagnostics.tsx'
import css from '../../src/client/Market.module.css'
import { en } from '../../src/client/locales.ts'

const t = (key: string) => (en as Record<string, string>)[key] ?? key

/** Synthetic check report with two community bundles and one order conflict. */
const CHECK_REPORT = {
  profile: '/synthetic/profiles/web',
  scannedAt: 1780000000000,
  bundles: [
    {
      name: '@deepseek-ai/dsh-base', source: '^4.0.1', kind: 'official',
      directory: '/synthetic/node_modules/@deepseek-ai/dsh-base',
      patchPath: '/synthetic/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml',
      error: null, entries: ['dsh-base'], parseError: null,
    },
    {
      name: 'alpha', source: '^1.0.0', kind: 'community',
      directory: '/synthetic/node_modules/alpha',
      patchPath: '/synthetic/node_modules/alpha/cordis.patch.yml',
      error: null, entries: ['alpha-entry'], parseError: null,
    },
    {
      name: 'beta', source: '^1.0.0', kind: 'community',
      directory: '/synthetic/node_modules/beta',
      patchPath: '/synthetic/node_modules/beta/cordis.patch.yml',
      error: null, entries: ['beta-entry'], parseError: null,
    },
  ],
  rows: [],
  duplicates: [],
  overrides: [],
  orphans: [],
  coreDeps: [],
  peerMismatches: [],
  multiVersion: [],
  summary: { ok: true, errors: [], warnings: [] },
  orderConflicts: [
    { name: 'alpha', reason: 'must load after beta, but beta is currently before/equal (position 1 vs 0)' },
  ],
}

/** Synthetic snapshot list payload (files entries are {path} objects). */
const SNAPSHOTS = {
  snapshots: [
    {
      id: 'snapshot-2025-01-01T00-00-00-000Z',
      createdAt: 1780000000000,
      files: [{ path: 'package.json' }, { path: 'cordis.patch.yml' }],
    },
  ],
}

/** Synthetic preset list payload. */
const PRESETS = {
  presets: [
    { name: 'work', bundleOrder: ['beta', 'alpha'], disabled: [] },
    { name: 'chat', bundleOrder: ['alpha', 'beta', 'gamma'], disabled: ['x'] },
  ],
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

interface ApiOverrides {
  check?: unknown
  snapshots?: unknown
  presets?: unknown
}

/**
 * URL-routing fetch stub. Records every call so tests can assert request
 * shapes; GETs return the routed fixture, POSTs answer { ok: true } (create /
 * restore / preset actions all succeed).
 */
function stubApi(overrides: ApiOverrides = {}) {
  const mock = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === '/dsh-market/check') return Promise.resolve(json(overrides.check ?? CHECK_REPORT))
    if (url === '/dsh-market/snapshots') {
      if (method === 'GET') return Promise.resolve(json(overrides.snapshots ?? SNAPSHOTS))
      return Promise.resolve(json({ ok: true, snapshot: { id: 'snapshot-new', createdAt: 1780000000001, files: [] } }))
    }
    if (url === '/dsh-market/restore-snapshot') {
      return Promise.resolve(json({ ok: true, restored: ['package.json'] }))
    }
    if (url === '/dsh-market/presets') {
      if (method === 'GET') return Promise.resolve(json(overrides.presets ?? PRESETS))
      return Promise.resolve(json({ ok: true }))
    }
    return Promise.resolve(json({ ok: true }))
  })
  vi.stubGlobal('fetch', mock)
  return {
    mock,
    calls: (url: string) => mock.mock.calls.filter(c => String(c[0]) === url),
    gets: (url: string) => mock.mock.calls.filter(c => String(c[0]) === url && (c[1]?.method ?? 'GET') === 'GET'),
    posts: (url: string) => mock.mock.calls.filter(c => String(c[0]) === url && c[1]?.method === 'POST'),
  }
}

/** The collapsible <section> that wraps the given panel heading button. */
function sectionOf(heading: string): HTMLElement {
  const button = screen.getByRole('button', { name: heading })
  const section = button.closest('section')
  expect(section, `collapsible section for "${heading}"`).not.toBeNull()
  return section as HTMLElement
}

/** Render Diagnostics and wait until the check report replaces the loading state. */
async function renderLoaded() {
  const api = stubApi()
  render(<Diagnostics t={t} />)
  await waitFor(() => expect(screen.queryByText(t('checkLoading'))).toBeNull())
  return api
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Diagnostics panels (jsdom, #98 phase 2/3)', () => {
  it('keeps the snapshot/preset sections collapsed without fetching them', async () => {
    const { mock } = await renderLoaded()

    // Only the check report is fetched on mount; the panels are lazy.
    expect(mock.mock.calls.map(c => String(c[0]))).toEqual(['/dsh-market/check'])

    const snapHead = screen.getByRole('button', { name: t('snapSection') })
    const presetHead = screen.getByRole('button', { name: t('presetSection') })
    expect(snapHead.getAttribute('aria-expanded')).toBe('false')
    expect(presetHead.getAttribute('aria-expanded')).toBe('false')
  })

  it('expanding the snapshot section fetches and renders the snapshot list', async () => {
    const { mock, calls } = await renderLoaded()

    fireEvent.click(screen.getByRole('button', { name: t('snapSection') }))
    await waitFor(() => expect(calls('/dsh-market/snapshots').length).toBe(1))

    const head = screen.getByRole('button', { name: t('snapSection') })
    expect(head.getAttribute('aria-expanded')).toBe('true')

    const section = sectionOf(t('snapSection'))
    // Snapshot id + formatted time + captured files.
    expect(within(section).getByText('snapshot-2025-01-01T00-00-00-000Z')).toBeTruthy()
    expect(within(section).getByText(new Date(1780000000000).toLocaleString())).toBeTruthy()
    expect(within(section).getByText(/package\.json, cordis\.patch\.yml/)).toBeTruthy()
  })

  it('creates a snapshot via POST /dsh-market/snapshots and reloads the list', async () => {
    const { gets, posts } = await renderLoaded()
    fireEvent.click(screen.getByRole('button', { name: t('snapSection') }))
    await waitFor(() => expect(gets('/dsh-market/snapshots').length).toBe(1))

    fireEvent.click(within(sectionOf(t('snapSection'))).getByRole('button', { name: t('snapCreate') }))
    await waitFor(() => expect(posts('/dsh-market/snapshots').length).toBe(1))
    expect(posts('/dsh-market/snapshots')[0]?.[1]?.body).toBe('{}')

    await waitFor(() => expect(screen.getByText(t('snapCreated'))).toBeTruthy())
    // The create succeeded → the list is reloaded (a second GET).
    await waitFor(() => expect(gets('/dsh-market/snapshots').length).toBe(2))
  })

  it('restores a snapshot only after inline double confirmation, then refreshes the check report', async () => {
    const { calls, posts } = await renderLoaded()
    fireEvent.click(screen.getByRole('button', { name: t('snapSection') }))
    const section = sectionOf(t('snapSection'))
    await waitFor(() => expect(within(section).getByText('snapshot-2025-01-01T00-00-00-000Z')).toBeTruthy())

    // First click arms the confirm state — no request yet.
    fireEvent.click(within(section).getByRole('button', { name: t('snapRestore') }))
    expect(within(section).getByText(t('snapRestoreConfirmText'))).toBeTruthy()
    expect(posts('/dsh-market/restore-snapshot').length).toBe(0)

    // Cancel leaves everything untouched.
    fireEvent.click(within(section).getByRole('button', { name: t('cancel') }))
    expect(within(section).queryByText(t('snapRestoreConfirmText'))).toBeNull()
    expect(posts('/dsh-market/restore-snapshot').length).toBe(0)

    // Arm again and confirm → POST restore-snapshot with the snapshot id.
    fireEvent.click(within(section).getByRole('button', { name: t('snapRestore') }))
    fireEvent.click(within(section).getByRole('button', { name: t('snapRestoreConfirm') }))
    await waitFor(() => expect(posts('/dsh-market/restore-snapshot').length).toBe(1))
    const post = posts('/dsh-market/restore-snapshot')[0]!
    expect(JSON.parse(String(post[1]?.body))).toEqual({ snapshot: 'snapshot-2025-01-01T00-00-00-000Z' })

    // Success triggers onRefresh → the check report is re-fetched.
    await waitFor(() => expect(calls('/dsh-market/check').length).toBeGreaterThanOrEqual(2))
  })

  it('renders the ordering conflicts from the check report (name — reason)', async () => {
    await renderLoaded()

    const orderSection = screen.getByText(t('orderSection')).closest('section') as HTMLElement
    expect(orderSection).toBeTruthy()
    // Community bundle count in the section heading.
    expect(within(orderSection).getByText('(2)')).toBeTruthy()
    // Conflict row: name — reason.
    expect(within(orderSection).getByText(/^alpha — must load after beta/)).toBeTruthy()
  })

  it('saves the current community order as a preset via POST /dsh-market/presets', async () => {
    const { calls, posts } = await renderLoaded()
    fireEvent.click(screen.getByRole('button', { name: t('presetSection') }))
    await waitFor(() => expect(calls('/dsh-market/presets').length).toBe(1))

    const section = sectionOf(t('presetSection'))
    // List renders preset names and bundle counts.
    expect(within(section).getByText('work')).toBeTruthy()
    expect(within(section).getByText('2 bundles')).toBeTruthy()
    expect(within(section).getByText('chat')).toBeTruthy()

    fireEvent.change(within(section).getByPlaceholderText(t('presetName')), { target: { value: 'combo-x' } })
    fireEvent.click(within(section).getByRole('button', { name: t('presetSave') }))
    await waitFor(() => expect(posts('/dsh-market/presets').length).toBe(1))
    const post = posts('/dsh-market/presets')[0]!
    // bundleOrder is the community bundle order from the check report.
    expect(JSON.parse(String(post[1]?.body))).toEqual({
      action: 'save',
      name: 'combo-x',
      bundleOrder: ['alpha', 'beta'],
      disabled: [],
    })

    await waitFor(() => expect(within(section).getByText(t('presetSaved'))).toBeTruthy())
  })

  it('applies a preset via POST /dsh-market/presets and refreshes the check report', async () => {
    const { calls, posts } = await renderLoaded()
    fireEvent.click(screen.getByRole('button', { name: t('presetSection') }))
    const section = sectionOf(t('presetSection'))
    await waitFor(() => expect(within(section).getByText('work')).toBeTruthy())

    // Two presets → two Apply buttons; scope to the 'work' row.
    const row = within(section).getByText('work').closest('.' + css.presetRow) as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: t('presetApply') }))
    await waitFor(() => expect(posts('/dsh-market/presets').length).toBe(1))
    expect(JSON.parse(String(posts('/dsh-market/presets')[0]?.[1]?.body))).toEqual({ action: 'apply', name: 'work' })

    // Success triggers onRefresh → the check report is re-fetched.
    await waitFor(() => expect(calls('/dsh-market/check').length).toBeGreaterThanOrEqual(2))
  })

  it('deletes a preset after inline double confirmation', async () => {
    const { calls, posts } = await renderLoaded()
    fireEvent.click(screen.getByRole('button', { name: t('presetSection') }))
    const section = sectionOf(t('presetSection'))
    await waitFor(() => expect(within(section).getByText('work')).toBeTruthy())
    const row = () => within(section).getByText('work').closest('.' + css.presetRow) as HTMLElement

    // Arm the confirm state — no request yet.
    fireEvent.click(within(row()).getByRole('button', { name: t('presetDelete') }))
    expect(posts('/dsh-market/presets').length).toBe(0)

    // Cancel.
    fireEvent.click(within(row()).getByRole('button', { name: t('cancel') }))

    // Arm again and confirm → POST {action:'delete'}.
    fireEvent.click(within(row()).getByRole('button', { name: t('presetDelete') }))
    fireEvent.click(within(row()).getByRole('button', { name: t('presetDelete') }))
    await waitFor(() => expect(posts('/dsh-market/presets').length).toBe(1))
    expect(JSON.parse(String(posts('/dsh-market/presets')[0]?.[1]?.body))).toEqual({ action: 'delete', name: 'work' })

    await waitFor(() => expect(within(section).getByText(t('presetDeleted'))).toBeTruthy())
  })
})
