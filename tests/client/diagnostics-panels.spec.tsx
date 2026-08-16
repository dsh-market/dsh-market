// @vitest-environment jsdom
/**
 * Portable render tests for the issue #98 phase 2 Diagnostics panel: the
 * community-bundle ordering block (orderConflicts, drag & drop draft, Apply
 * order, auto-sort) and the AI-fix clipboard flow, plus the read-only
 * same-name rows. The host boundary is stubbed with a URL-routing fetch mock
 * (GET /dsh-market/check, POST /dsh-market/bundle-order) — no real profile,
 * no absolute machine paths, so this runs on any environment/CI. The phase 3
 * snapshots & rollback and plugin presets panels ship in later stacked PRs
 * and must NOT be present here.
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
  peerMismatches: [],
  multiVersion: [],
  summary: { ok: true, errors: [], warnings: [] },
  orderConflicts: [
    { name: 'alpha', reason: 'must load after beta, but beta is currently before/equal (position 1 vs 0)' },
  ],
  duplicateNames: [
    { name: 'shared-name', layers: ['alpha', 'beta'], count: 2 },
  ],
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

interface ApiOverrides {
  check?: unknown
  /** Override the POST /dsh-market/bundle-order response (defaults to 200 ok). */
  bundleOrder?: { status?: number; body?: unknown }
}

/**
 * URL-routing fetch stub. Records every call so tests can assert request
 * shapes; GET /dsh-market/check returns the routed fixture, POST
 * /dsh-market/bundle-order answers { ok: true }.
 */
function stubApi(overrides: ApiOverrides = {}) {
  const mock = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === '/dsh-market/check') return Promise.resolve(json(overrides.check ?? CHECK_REPORT))
    if (url === '/dsh-market/bundle-order') {
      const resp = overrides.bundleOrder
      if (resp !== undefined) {
        return Promise.resolve(new Response(JSON.stringify(resp.body), { status: resp.status ?? 200 }))
      }
      return Promise.resolve(json({ ok: true, bundles: ['@deepseek-ai/dsh-base', 'beta', 'alpha'] }))
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

describe('Diagnostics panels (jsdom, #98 phase 2)', () => {
  it('renders ordering conflicts and same-name rows as read-only info', async () => {
    const { mock } = stubApi()
    render(<Diagnostics t={t} />)
    await waitFor(() => expect(screen.queryByText(t('checkLoading'))).toBeNull())
    expect(mock.mock.calls.length).toBe(1)

    // Ordering-conflict rows render read-only: `name — reason`.
    expect(screen.getByText(t('orderConflicts'))).toBeTruthy()
    expect(screen.getByText(/^alpha — must load after beta/)).toBeTruthy()

    // Same-name rows render in the neutral informational style (no ⚠).
    expect(screen.getByText(t('duplicateNames'))).toBeTruthy()
    expect(screen.getByText(/^shared-name × 2 — alpha \/ beta$/)).toBeTruthy()

    // The phase 3 snapshot/preset panels are NOT part of PR-B.
    expect(screen.queryByRole('button', { name: t('snapSection') })).toBeNull()
    expect(screen.queryByRole('button', { name: t('presetSection') })).toBeNull()
  })

  it('drag & drop reorders the local draft only; "Apply order" POSTs the new order', async () => {
    const { calls, posts } = await renderLoaded()

    // The ordering panel is collapsed by default (compact diagnostics); expand it.
    const orderHeader = screen.getByText(t('orderSection'))
    fireEvent.click(orderHeader)
    await waitFor(() => {
      const body = orderHeader.closest('section')?.querySelector('[class*="collapseBody"]') as HTMLElement | null
      expect(body?.style.display).not.toBe('none')
    })

    const orderSection = screen.getByText(t('orderSection')).closest('section') as HTMLElement
    const rows = () => Array.from(orderSection.querySelectorAll('.' + css.diagRow))
    expect(rows()).toHaveLength(2)

    // Drag alpha (row 0) onto beta (row 1) — draft-only: no POST yet.
    fireEvent.dragStart(rows()[0]!, { dataTransfer: {} })
    fireEvent.dragOver(rows()[1]!, { dataTransfer: {} })
    fireEvent.drop(rows()[1]!, { dataTransfer: {} })
    fireEvent.dragEnd(rows()[1]!, { dataTransfer: {} })
    expect(posts('/dsh-market/bundle-order').length).toBe(0)

    // The local draft reordered to beta, alpha (row order in the DOM).
    await waitFor(() => {
      const text = rows().map(row => row.textContent ?? '')
      expect(text[0]).toContain('beta')
      expect(text[1]).toContain('alpha')
    })

    // Applying the order persists the draft via POST /dsh-market/bundle-order.
    fireEvent.click(screen.getByRole('button', { name: t('orderApply') }))
    await waitFor(() => expect(posts('/dsh-market/bundle-order').length).toBe(1))
    expect(JSON.parse(String(posts('/dsh-market/bundle-order')[0]?.[1]?.body))).toEqual({ order: ['beta', 'alpha'] })

    // Success triggers onRefresh → the check report is re-fetched.
    await waitFor(() => expect(calls('/dsh-market/check').length).toBeGreaterThanOrEqual(2))
  })

  it('shows no auto-sort / apply-suggested button when the host reports no ordering rules', async () => {
    await renderLoaded()
    // CHECK_REPORT carries no suggestedOrder → nothing to suggest and no
    // auto-sort affordance at all (#125: only a DIFFERING suggestion shows the
    // apply-suggested button; the already-optimal text is kept).
    const section = screen.getByText(t('orderSection')).closest('section') as HTMLElement
    fireEvent.click(screen.getByText(t('orderSection')))
    await waitFor(() => {
      const body = section.querySelector('[class*="collapseBody"]') as HTMLElement | null
      expect(body?.style.display).not.toBe('none')
    })
    expect(within(section).queryByRole('button', { name: t('orderAutoSort') })).toBeNull()
    expect(within(section).queryByRole('button', { name: t('orderSuggestApply') })).toBeNull()
  })

  it('shows the apply-suggested button only when a different suggested order exists', async () => {
    const expand = async () => {
      const section = screen.getByText(t('orderSection')).closest('section') as HTMLElement
      fireEvent.click(screen.getByText(t('orderSection')))
      await waitFor(() => {
        const body = section.querySelector('[class*="collapseBody"]') as HTMLElement | null
        expect(body?.style.display).not.toBe('none')
      })
      return section
    }

    // A suggested order that differs from the current community order → button.
    stubApi({ check: { ...CHECK_REPORT, suggestedOrder: { ok: true, order: ['beta', 'alpha'] } } })
    render(<Diagnostics t={t} />)
    await waitFor(() => expect(screen.queryByText(t('checkLoading'))).toBeNull())
    const differSection = await expand()
    expect(within(differSection).getByRole('button', { name: t('orderSuggestApply') })).toBeTruthy()
    cleanup()
    vi.unstubAllGlobals()

    // A suggested order equal to the current one → already-optimal text, no buttons.
    stubApi({ check: { ...CHECK_REPORT, suggestedOrder: { ok: true, order: ['alpha', 'beta'] } } })
    render(<Diagnostics t={t} />)
    await waitFor(() => expect(screen.queryByText(t('checkLoading'))).toBeNull())
    const equalSection = await expand()
    expect(within(equalSection).queryByRole('button', { name: t('orderSuggestApply') })).toBeNull()
    expect(within(equalSection).queryByRole('button', { name: t('orderAutoSort') })).toBeNull()
    expect(within(equalSection).getByText(t('orderAlreadyOptimal'))).toBeTruthy()
  })

  it('shows the composition diff hint when static validation rejects an apply', async () => {
    stubApi({
      bundleOrder: {
        status: 422,
        body: {
          error: 'trial validation failed — would not boot / 试启动校验失败',
          trial: {
            errors: [{ layer: 'alpha', message: 'duplicate loader entry id "x"' }],
            warnings: [],
            diff: {
              overrides: [{ id: 'x', layer: 'alpha', overriddenLayers: ['beta'] }],
              orphans: [{ id: 'y', layer: 'beta', reason: 'patch target not found' }],
              duplicates: [{ id: 'x', layers: ['alpha', 'beta'], count: 2 }],
            },
          },
        },
      },
    })
    render(<Diagnostics t={t} />)
    await waitFor(() => expect(screen.queryByText(t('checkLoading'))).toBeNull())

    // Expand the ordering panel, then apply the manual draft → the host
    // rejects with 422 + the candidate diff.
    const section = screen.getByText(t('orderSection')).closest('section') as HTMLElement
    fireEvent.click(screen.getByText(t('orderSection')))
    await waitFor(() => {
      const body = section.querySelector('[class*="collapseBody"]') as HTMLElement | null
      expect(body?.style.display).not.toBe('none')
    })
    fireEvent.click(within(section).getByRole('button', { name: t('orderApply') }))
    await waitFor(() => expect(screen.getByText(t('orderTrialFail').replace('{0}', 'duplicate loader entry id "x"'))).toBeTruthy())
    // The diff hint line: 1 override, 1 orphan, 1 duplicate.
    expect(screen.getByText(t('orderDiffHint').replace('{0}', '1').replace('{1}', '1').replace('{2}', '1'))).toBeTruthy()
  })

  it('AI fix copies the diagnostics prompt to the clipboard and confirms', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    // A HARD issue (duplicate entries) makes the AI-fix button visible —
    // purely informational reports keep it hidden (conservative UX).
    stubApi({
      check: { ...CHECK_REPORT, duplicates: [{ id: 'dup-entry', layers: ['alpha'], count: 2 }] },
    })
    render(<Diagnostics t={t} />)
    await waitFor(() => expect(screen.queryByText(t('checkLoading'))).toBeNull())

    const fixButton = screen.getByRole('button', { name: t('aiFix') })
    fireEvent.click(fixButton)

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    // The prompt carries the diagnostics (order conflict + profile + scope).
    const prompt = String(writeText.mock.calls[0]?.[0])
    expect(prompt).toContain('/synthetic/profiles/web')
    expect(prompt).toContain('alpha')
    expect(prompt).toContain('must load after beta')
    expect(prompt).toContain(t('aiFixConservative').slice(0, 20))
    await waitFor(() => expect(screen.getByText(t('aiFixCopied'))).toBeTruthy())
  })

  it('AI-fix without a clipboard API shows the prompt in a copyable text block', async () => {
    // Regression for the #98 AI-fix fallback: when navigator.clipboard is
    // unavailable, the built prompt renders as a selectable <textarea> so the
    // user can still copy it by hand.
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    stubApi({
      check: { ...CHECK_REPORT, duplicates: [{ id: 'dup-entry', layers: ['alpha'], count: 2 }] },
    })
    const { container } = render(<Diagnostics t={t} />)
    await waitFor(() => expect(screen.queryByText(t('checkLoading'))).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: t('aiFix') }))
    await waitFor(() => expect(screen.getByText(t('aiFixFail'))).toBeTruthy())
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    expect(textarea.readOnly).toBe(true)
    expect(textarea.value).toContain('/synthetic/profiles/web')
    expect(textarea.value).toContain('must load after beta')
    expect(textarea.value).toContain(t('aiFixConservative').slice(0, 20))
    // The clipboard path was skipped → no success toast.
    expect(screen.queryByText(t('aiFixCopied'))).toBeNull()
  })

  it('AI-fix falls back to the text block when the clipboard promise rejects', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('permission denied')))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    stubApi({
      check: { ...CHECK_REPORT, duplicates: [{ id: 'dup-entry', layers: ['alpha'], count: 2 }] },
    })
    const { container } = render(<Diagnostics t={t} />)
    await waitFor(() => expect(screen.queryByText(t('checkLoading'))).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: t('aiFix') }))
    await waitFor(() => expect(screen.getByText(t('aiFixFail'))).toBeTruthy())
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    expect(textarea.readOnly).toBe(true)
    expect(textarea.value).toContain('/synthetic/profiles/web')
    expect(textarea.value).toContain('must load after beta')
    expect(textarea.value).toContain(t('aiFixConservative').slice(0, 20))
    // The clipboard path failed → no success toast.
    expect(screen.queryByText(t('aiFixCopied'))).toBeNull()
  })

  it('AI-fix works without the removed workspaces prop (clipboard-only contract)', async () => {
    // Diagnostics previously took a workspaces.startSession prop for the AI-fix
    // button; the #98 change removed it (clipboard-first flow). Rendering with
    // `t` only must mount and the fix flow must succeed through the clipboard.
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    stubApi({
      check: { ...CHECK_REPORT, duplicates: [{ id: 'dup-entry', layers: ['alpha'], count: 2 }] },
    })
    render(<Diagnostics t={t} />)
    await waitFor(() => expect(screen.queryByText(t('checkLoading'))).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: t('aiFix') }))
    await waitFor(() => expect(screen.getByText(t('aiFixCopied'))).toBeTruthy())
    expect(writeText).toHaveBeenCalledTimes(1)
  })
})
