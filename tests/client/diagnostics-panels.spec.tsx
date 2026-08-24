// @vitest-environment jsdom
/**
 * Portable render tests for the issue #98 phase 2/3 Diagnostics panels: the
 * community-bundle ordering block (orderConflicts) and the collapsible
 * snapshots & rollback panel (snapshot-panel.tsx). The host boundary is
 * stubbed with a URL-routing fetch mock (GET /dsh-market/check, GET+POST
 * /dsh-market/snapshots, POST /dsh-market/restore-snapshot) — no real
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

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

interface ApiOverrides {
  check?: unknown
  /** Override the POST /dsh-market/bundle-order response (defaults to 200 ok). */
  bundleOrder?: { status?: number; body?: unknown }
  snapshots?: unknown
}

/**
 * URL-routing fetch stub. Records every call so tests can assert request
 * shapes; GETs return the routed fixture, POSTs answer { ok: true } (create /
 * restore actions all succeed).
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
    if (url === '/dsh-market/snapshots') {
      if (method === 'GET') return Promise.resolve(json(overrides.snapshots ?? SNAPSHOTS))
      return Promise.resolve(json({ ok: true, snapshot: { id: 'snapshot-new', createdAt: 1780000000001, files: [] } }))
    }
    if (url === '/dsh-market/restore-snapshot') {
      return Promise.resolve(json({ ok: true, restored: ['package.json'] }))
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
  it('keeps the snapshot section collapsed without fetching it', async () => {
    const { mock } = await renderLoaded()

    // Only the check report is fetched on mount; the snapshot panel is lazy.
    expect(mock.mock.calls.map(c => String(c[0]))).toEqual(['/dsh-market/check'])

    const snapHead = screen.getByRole('button', { name: t('snapSection') })
    expect(snapHead.getAttribute('aria-expanded')).toBe('false')
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
  it('deletes a snapshot only after inline double confirmation', async () => {
    const { posts } = await renderLoaded()
    fireEvent.click(screen.getByRole('button', { name: t('snapSection') }))
    const section = sectionOf(t('snapSection'))
    await waitFor(() => expect(within(section).getByText('snapshot-2025-01-01T00-00-00-000Z')).toBeTruthy())

    // First click arms the delete confirmation — no request yet.
    fireEvent.click(within(section).getByRole('button', { name: t('snapDelete') }))
    expect(within(section).getByText(t('snapDeleteConfirmText'))).toBeTruthy()
    expect(posts('/dsh-market/delete-snapshot').length).toBe(0)

    // Cancel leaves everything untouched.
    fireEvent.click(within(section).getByRole('button', { name: t('cancel') }))
    expect(within(section).queryByText(t('snapDeleteConfirmText'))).toBeNull()
    expect(posts('/dsh-market/delete-snapshot').length).toBe(0)

    // Arm again and confirm → POST delete-snapshot with the snapshot id.
    fireEvent.click(within(section).getByRole('button', { name: t('snapDelete') }))
    fireEvent.click(within(section).getByRole('button', { name: t('snapDeleteConfirm') }))
    await waitFor(() => expect(posts('/dsh-market/delete-snapshot').length).toBe(1))
    const post = posts('/dsh-market/delete-snapshot')[0]!
    expect(JSON.parse(String(post[1]?.body))).toEqual({ snapshot: 'snapshot-2025-01-01T00-00-00-000Z' })

    // Success reloads the snapshot list and shows the deleted message.
    await waitFor(() => expect(within(section).getByText(t('snapDeleted'))).toBeTruthy())
  })

  it('AI fix copies the diagnostics prompt to the clipboard and confirms', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    // A HARD issue (duplicate entries) makes the AI-fix button visible —
    // purely informational reports keep it hidden (conservative UX).
    const api = stubApi({
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
    // The self-identification guard is present: the prompt tells the agent to
    // detect whether it is itself the target harness, and to hard-forbid
    // mutating / upgrade / restart / reinstall actions (plan-only output) when
    // it is — the fix that prevents the harness from being killed mid-fix.
    expect(prompt).toContain(t('aiFixDetect'))
    expect(prompt).toContain(t('aiFixIfSelf'))
    await waitFor(() => expect(screen.getByText(t('aiFixCopied'))).toBeTruthy())
    void api
  })

  it('AI-fix without a clipboard API shows the prompt in a copyable text block', async () => {
    // Regression for the #98 AI-fix fallback: when navigator.clipboard is
    // unavailable, the built prompt renders as a selectable <textarea> so the
    // user can still copy it by hand. Diagnostics renders with the post-#98
    // props signature (t only — the workspaces prop is gone).
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

  it('#201: peer warnings / info alone never show the AI-fix button', async () => {
    // The old #125 gate treated ANY satisfied===false as a hard issue. #201
    // tightens it: only a directional RISK opens the button; optional peers,
    // aboveMax without an explicit bound, classifier `none` and legacy rows
    // without a verdict stay in the warning/info tiers and stay quiet.
    stubApi({
      check: {
        ...CHECK_REPORT,
        orderConflicts: [],
        peerMismatches: [
          {
            plugin: 'plugin-warn', name: '@deepseek-ai/dsh-llm', range: '^0.1.0',
            resolved: '0.2.0', satisfied: false, optional: false,
            verdict: { kind: 'warning', warning: { plugin: 'plugin-warn', peer: '@deepseek-ai/dsh-llm', range: '^0.1.0', resolved: '0.2.0', reason: 'aboveMax' } },
          },
          {
            plugin: 'plugin-opt', name: '@deepseek-ai/cordis', range: '^4.0.1',
            resolved: '4.0.1', satisfied: false, optional: true,
            verdict: { kind: 'warning', warning: { plugin: 'plugin-opt', peer: '@deepseek-ai/cordis', range: '^4.0.1', resolved: '4.0.1', reason: 'optional' } },
          },
          { plugin: 'legacy-row', name: '@deepseek-ai/dsh-session', range: '^0.1.0', resolved: '0.2.0', satisfied: false, optional: false },
        ],
        summary: {
          ok: true,
          errors: [],
          warnings: ['plugin-warn peer range @deepseek-ai/dsh-llm@^0.1.0 does not match resolved 0.2.0'],
        },
      },
    })
    render(<Diagnostics t={t} />)
    await waitFor(() => expect(screen.queryByText(t('checkLoading'))).toBeNull())

    expect(screen.queryByRole('button', { name: t('aiFix') })).toBeNull()
    expect(screen.getByText(new RegExp(`^${t('catRisk')}:\\s*0$`))).toBeTruthy()
    expect(screen.getByText(new RegExp(`^${t('catWarn')}:\\s*3$`))).toBeTruthy()
  })

  it('#201: a risk peer opens AI fix and the prompt carries the risk row, not summary.warnings', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    stubApi({
      check: {
        ...CHECK_REPORT,
        orderConflicts: [],
        peerMismatches: [
          {
            plugin: 'plugin-risk', name: '@deepseek-ai/dsh-settings', range: '^0.1.0-rc.7',
            resolved: '0.1.0-rc.6', satisfied: false, optional: false,
            verdict: {
              kind: 'risk',
              risk: { plugin: 'plugin-risk', peer: '@deepseek-ai/dsh-settings', range: '^0.1.0-rc.7', resolved: '0.1.0-rc.6', direction: 'belowMin' },
            },
          },
        ],
        summary: {
          ok: true,
          errors: [],
          warnings: [
            'plugin-risk peer range @deepseek-ai/dsh-settings@^0.1.0-rc.7 does not match resolved 0.1.0-rc.6',
            'noise-warning that must not reach the agent prompt',
          ],
        },
      },
    })
    render(<Diagnostics t={t} />)
    await waitFor(() => expect(screen.queryByText(t('checkLoading'))).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: t('aiFix') }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    const prompt = String(writeText.mock.calls[0]?.[0])
    expect(prompt).toContain('/synthetic/profiles/web')
    expect(prompt).toContain('@deepseek-ai/dsh-settings')
    expect(prompt).toContain('^0.1.0-rc.7')
    expect(prompt).toContain(t('peerRiskBelowMin'))
    // The structured prompt no longer dumps summary.warnings.
    expect(prompt).not.toContain('noise-warning')
    expect(prompt).not.toContain('does not match resolved')
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

/**
 * A background re-check must not throw away a reorder the user is still
 * working on. The panel compares the incoming community bundle list with
 * the one it last synced from and only resets the draft when they actually
 * differ — the refetch hands back a NEW array every time, so identity alone
 * says nothing.
 *
 * A mutation audit flipped that comparison without failing anything: the
 * suite dragged rows and applied them, but never re-checked mid-edit. The
 * bug it hides is the annoying kind — you drag three bundles into place, a
 * refresh lands, and your work is silently gone.
 */
describe('Diagnostics ordering draft vs refetch', () => {
  /** Fetch stub whose /dsh-market/check payload can change between calls. */
  function stubMutableApi(initial: unknown) {
    let report = initial
    const mock = vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url === '/dsh-market/check') return Promise.resolve(json(report))
      if (url === '/dsh-market/bundle-order') return Promise.resolve(json({ ok: true }))
      return Promise.resolve(json({ ok: true }))
    })
    vi.stubGlobal('fetch', mock)
    return { set: (next: unknown) => { report = next } }
  }

  /** Open the ordering panel and return a reader for its row labels. */
  async function openOrderPanel(): Promise<() => string[]> {
    const header = screen.getByText(t('orderSection'))
    fireEvent.click(header)
    const section = header.closest('section') as HTMLElement
    await waitFor(() => {
      const body = section.querySelector('[class*="collapseBody"]') as HTMLElement | null
      expect(body?.style.display).not.toBe('none')
    })
    return () => Array.from(section.querySelectorAll('.' + css.diagRow)).map(r => r.textContent ?? '')
  }

  /** Drag the first community row onto the second. */
  function swapFirstTwo(section: HTMLElement): void {
    const rows = Array.from(section.querySelectorAll('.' + css.diagRow))
    fireEvent.dragStart(rows[0]!, { dataTransfer: {} })
    fireEvent.dragOver(rows[1]!, { dataTransfer: {} })
    fireEvent.drop(rows[1]!, { dataTransfer: {} })
    fireEvent.dragEnd(rows[1]!, { dataTransfer: {} })
  }

  it('keeps an in-progress reorder when the re-check returns the same bundles', async () => {
    stubMutableApi(CHECK_REPORT)
    render(<Diagnostics t={t} />)
    await waitFor(() => expect(screen.queryByText(t('checkLoading'))).toBeNull())
    const rows = await openOrderPanel()
    const section = screen.getByText(t('orderSection')).closest('section') as HTMLElement

    swapFirstTwo(section)
    await waitFor(() => expect(rows()[0]).toContain('beta'))

    // Same data comes back — the draft is the user's, not the server's.
    fireEvent.click(screen.getByRole('button', { name: t('checkRefresh') }))
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(rows()[0]).toContain('beta')
    expect(rows()[1]).toContain('alpha')
  })

  it('resets the draft when the re-check reports a DIFFERENT set of bundles', async () => {
    const api = stubMutableApi(CHECK_REPORT)
    render(<Diagnostics t={t} />)
    await waitFor(() => expect(screen.queryByText(t('checkLoading'))).toBeNull())
    const rows = await openOrderPanel()
    const section = screen.getByText(t('orderSection')).closest('section') as HTMLElement

    swapFirstTwo(section)
    await waitFor(() => expect(rows()[0]).toContain('beta'))

    // A plugin was installed elsewhere: the draft no longer describes
    // reality, so the panel has to take the server's list.
    api.set({
      ...CHECK_REPORT,
      bundles: [...CHECK_REPORT.bundles, {
        name: 'gamma', source: '^1.0.0', kind: 'community',
        directory: '/synthetic/node_modules/gamma',
        patchPath: '/synthetic/node_modules/gamma/cordis.patch.yml',
        error: null, entries: ['gamma-entry'], parseError: null,
      }],
    })
    fireEvent.click(screen.getByRole('button', { name: t('checkRefresh') }))
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(rows()[0]).toContain('alpha')
    expect(rows()[1]).toContain('beta')
    expect(rows()[2]).toContain('gamma')
  })
})