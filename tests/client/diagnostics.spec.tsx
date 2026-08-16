// @vitest-environment jsdom
/**
 * Portable render tests for the Diagnostics tab (issue #98, phase 1). The
 * host boundary is the single /dsh-market/check fetch, stubbed with a
 * synthetic fixture CheckReport (mirroring src/check.ts) — no real profile,
 * no absolute machine paths, so this runs on any environment/CI.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Diagnostics } from '../../src/client/Diagnostics.tsx'
import css from '../../src/client/Market.module.css'
import { en } from '../../src/client/locales.ts'

/** Synthetic problem report — every field mirrors CheckReport in src/check.ts. */
const REPORT = {
  profile: '/synthetic/profiles/web',
  scannedAt: 1780000000000,
  bundles: [
    {
      name: '@deepseek-ai/dsh-base', source: '^4.0.1', kind: 'official',
      directory: '/synthetic/node_modules/@deepseek-ai/dsh-base',
      patchPath: '/synthetic/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml',
      error: null, entries: ['dsh-base', 'session-title-llm'], parseError: null,
    },
    {
      name: 'dsh-market', source: '^1.9.0', kind: 'community',
      directory: '/synthetic/node_modules/dsh-market',
      patchPath: '/synthetic/node_modules/dsh-market/cordis.patch.yml',
      error: null, entries: ['dsh-market'], parseError: null,
    },
    {
      name: 'broken-bundle', source: '^2.0.0', kind: 'community',
      directory: null, patchPath: null,
      error: 'bundle package is not installed — the profile will fail to boot',
      entries: [], parseError: null,
    },
  ],
  rows: [],
  duplicates: [{ id: 'shared-entry', layers: ['@deepseek-ai/dsh-base', 'user-patch'], count: 2 }],
  overrides: [{ id: 'shared-entry', layer: 'user-patch', overriddenLayers: ['@deepseek-ai/dsh-base'] }],
  orphans: [{ id: 'ghost-entry', layer: 'user-patch', reason: 'patch target not found' }],
  peerMismatches: [
    { plugin: 'plugin-x', name: '@deepseek-ai/dsh-llm', range: '^0.1.0', resolved: '0.2.0', satisfied: false },
    { plugin: 'plugin-y', name: '@deepseek-ai/cordis', range: '^4.0.1', resolved: '4.0.1', satisfied: true },
    { plugin: 'plugin-z', name: '@deepseek-ai/dsh-agent', range: '^0.1.0-rc.6', resolved: null, satisfied: null },
  ],
  multiVersion: [{ name: '@deepseek-ai/dsh-tools', versions: ['0.0.1-rc.1', '0.1.0-rc.6'], hoisted: '0.0.1-rc.1' }],
  summary: {
    ok: false,
    errors: [
      'bundle broken-bundle: bundle package is not installed — the profile will fail to boot',
      'duplicate loader entry id "shared-entry" (2 rows: @deepseek-ai/dsh-base, user-patch)',
    ],
    warnings: ['plugin-x peer range @deepseek-ai/dsh-llm@^0.1.0 does not match resolved 0.2.0'],
  },
}

/** Fully-clean report for the empty-state rendering test. */
const CLEAN_REPORT = {
  ...REPORT,
  bundles: [],
  rows: [],
  duplicates: [],
  overrides: [],
  orphans: [],
  peerMismatches: [],
  multiVersion: [],
  summary: { ok: true, errors: [], warnings: [] },
}

const t = (key: string) => (en as Record<string, string>)[key] ?? key

/** Stub the single host boundary and assert the request shape. */
function stubCheckReport(payload: unknown) {
  const mock = vi.fn((input: unknown, init?: RequestInit) => {
    expect(String(input)).toBe('/dsh-market/check')
    expect(init?.cache).toBe('no-store')
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

/**
 * Section headings split title and "(N)" count across child nodes (title is
 * the h3's own text node, the count sits in a nested span), so scope the
 * count query to the section instead of assuming a single text node.
 */
function assertSection(title: string, count: number): HTMLElement {
  const section = screen.getByText(title).closest('section')
  expect(section, `section for "${title}"`).not.toBeNull()
  expect(within(section as HTMLElement).getByText(`(${count})`), `count (${count}) in "${title}"`).toBeTruthy()
  return section as HTMLElement
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Diagnostics (jsdom)', () => {
  it('renders the loading state, then the full problem report', async () => {
    const fetchMock = stubCheckReport(REPORT)
    const { container } = render(<Diagnostics t={t} />)

    // Loading state first, then the report replaces it.
    expect(screen.getByText(t('checkLoading'))).toBeTruthy()
    await waitFor(() => expect(screen.queryByText(t('checkLoading'))).toBeNull())
    expect(fetchMock.mock.calls.length).toBe(1)

    // Summary strip: status badge, category counts, profile meta.
    expect(screen.getByText(t('checkIssues'))).toBeTruthy()
    expect(screen.getByText(new RegExp(`^${t('catConflict')}:\\s*1$`))).toBeTruthy()
    expect(screen.getByText(new RegExp(`^${t('catDeps')}:\\s*4$`))).toBeTruthy()
    expect(screen.getByText(`${t('checkProfile')}: /synthetic/profiles/web`)).toBeTruthy()

    // Every section heading renders with its count (scoped to the section).
    assertSection(t('checkErrors'), 2)
    assertSection(t('checkWarnings'), 1)
    assertSection(t('checkBundles'), 3)
    assertSection(t('checkDuplicates'), 1)
    assertSection(t('checkPeerMismatches'), 1)
    assertSection(t('checkMultiVersion'), 1)
    // Overrides/orphans now use the same collapsible Section style as the
    // other blocks (title and count split across nodes).
    assertSection(t('checkOverrides'), 1)
    assertSection(t('checkOrphans'), 1)

    // Problem lists render in the red error style (css-module err class).
    const dupErrLine = screen.getByText(/duplicate loader entry id/)
    expect(dupErrLine.closest('[class*="err"]')).not.toBeNull()
    // Expand the warnings block, then its first warning row is visible exactly
    // once (the collapsed overview line carries the same text).
    fireEvent.click(screen.getByText(t('checkWarnings')))
    expect(screen.getAllByText(/does not match resolved 0\.2\.0/).length).toBeGreaterThan(0)

    // Bundle blocks: one per bundle, in report order, with badges and errors.
    const bundleBlocks = Array.from(container.querySelectorAll('.' + css.diagBundle))
    expect(bundleBlocks.length).toBe(3)
    const block = (i: number) => bundleBlocks[i] as HTMLElement
    expect(block(0).querySelector('.' + css.nm)?.textContent).toBe('@deepseek-ai/dsh-base')
    expect(block(1).querySelector('.' + css.nm)?.textContent).toBe('dsh-market')
    expect(block(2).querySelector('.' + css.nm)?.textContent).toBe('broken-bundle')
    expect(within(block(0)).getByText(t('checkOfficial'))).toBeTruthy()
    expect(within(block(1)).getByText(t('checkCommunity'))).toBeTruthy()
    expect(within(block(2)).getByText(t('checkCommunity'))).toBeTruthy()
    expect(within(block(0)).getByText('dsh-base, session-title-llm')).toBeTruthy()
    expect(within(block(0)).getByText('^4.0.1')).toBeTruthy()
    const bundleErr = within(block(2)).getByText(/bundle package is not installed/)
    expect(bundleErr.closest('[class*="err"]')).not.toBeNull()

    // Duplicate loader entry id row (scoped: the same id also appears in the
    // overrides disclosure below).
    const dupSection = assertSection(t('checkDuplicates'), 1)
    expect(within(dupSection).getByText('shared-entry')).toBeTruthy()
    expect(within(dupSection).getByText('× 2')).toBeTruthy()
    expect(within(dupSection).getByText('@deepseek-ai/dsh-base / user-patch')).toBeTruthy()

    // Peer block counts only CONFIRMED mismatches; informational entries
    // (satisfied / unknown) sit in a collapsed disclosure.
    assertSection(t('checkPeerMismatches'), 1)
    expect(screen.getByText(t('checkUnsatisfied'))).toBeTruthy()
    // Informational (satisfied/unknown) peer entries are collapsed behind a
    // disclosure to keep the page compact — the disclosure title is present.
    expect(screen.getByText(/informational entries/)).toBeTruthy()

    // Multi-version row, scoped to its section.
    const mvSection = assertSection(t('checkMultiVersion'), 1)
    expect(within(mvSection).getByText('@deepseek-ai/dsh-tools')).toBeTruthy()
    expect(within(mvSection).getByText('0.0.1-rc.1 / 0.1.0-rc.6')).toBeTruthy()

    // Overrides disclosure opens expanded. Each row is a structured line
    // `id ← layer-badge t('checkOverridden') overridden-layers` — the label
    // and the value are separate spans now, so assert them separately (scoped
    // to the section: the same id/layer texts also appear elsewhere).
    const ovSection = assertSection(t('checkOverrides'), 1)
    expect(within(ovSection).getByText('shared-entry')).toBeTruthy()
    expect(within(ovSection).getByText('user-patch')).toBeTruthy()
    expect(within(ovSection).getByText(t('checkOverridden'))).toBeTruthy()
    expect(within(ovSection).getByText('@deepseek-ai/dsh-base')).toBeTruthy()

    // Orphan patch row is now category-badge + id + layer + reason span. The
    // badge uses the plain-language label (t('orphanPatchTargetMissing')), the
    // reason keeps the technical detail — assert each separately.
    const orphSection = assertSection(t('checkOrphans'), 1)
    expect(within(orphSection).getByText('ghost-entry')).toBeTruthy()
    expect(within(orphSection).getByText('user-patch')).toBeTruthy()
    expect(within(orphSection).getByText(t('orphanPatchTargetMissing'))).toBeTruthy()
    expect(within(orphSection).getByText(/patch target not found/)).toBeTruthy()
  })

  it('renders the clean-report empty states and the ok badge', async () => {
    stubCheckReport(CLEAN_REPORT)
    const { container } = render(<Diagnostics t={t} />)
    expect(screen.getByText(t('checkLoading'))).toBeTruthy()
    await waitFor(() => expect(screen.queryByText(t('checkLoading'))).toBeNull())

    expect(screen.getByText(t('diagOkAll'))).toBeTruthy()
    expect(screen.getByText(new RegExp(`^${t('catConflict')}:\\s*0$`))).toBeTruthy()
    expect(screen.getByText(new RegExp(`^${t('catDeps')}:\\s*0$`))).toBeTruthy()
    expect(screen.getByText(new RegExp(`^${t('catOrder')}:\\s*0$`))).toBeTruthy()

    for (const key of [
      'checkErrorsEmpty', 'checkWarningsEmpty', 'checkBundlesEmpty',
      'checkDuplicatesEmpty', 'checkPeerEmpty',
      'checkMultiEmpty', 'checkOverridesEmpty', 'checkOrphansEmpty',
    ]) {
      expect(screen.getByText(t(key)), t(key)).toBeTruthy()
    }
    assertSection(t('checkOverrides'), 0)
    assertSection(t('checkOrphans'), 0)
    expect(container.querySelectorAll('.' + css.diagBundle).length).toBe(0)
  })

  it('shows the load-failure state when /dsh-market/check is not ok', async () => {
    const mock = vi.fn(() => Promise.resolve(new Response('boom', { status: 500 })))
    vi.stubGlobal('fetch', mock)
    render(<Diagnostics t={t} />)
    await waitFor(() => {
      expect(screen.getByText(new RegExp(`${t('checkLoadFail')}HTTP 500`))).toBeTruthy()
    })
    expect(screen.queryByText(t('checkLoading'))).toBeNull()
  })

  it('renders the informational peer disclosure even with zero CONFIRMED mismatches', async () => {
    // Regression for the #98 peer-drawer fix: with 0 confirmed mismatches the
    // section used to render only the count-0 empty text, making the
    // informational entries (satisfied / unknown) unreachable. alwaysShowBody
    // keeps the disclosure visible whenever info entries exist.
    const report = {
      ...CLEAN_REPORT,
      peerMismatches: [
        { plugin: 'plugin-y', name: '@deepseek-ai/cordis', range: '^4.0.1', resolved: '4.0.1', satisfied: true },
        { plugin: 'plugin-z', name: '@deepseek-ai/dsh-agent', range: '^0.1.0-rc.6', resolved: null, satisfied: null },
      ],
    }
    stubCheckReport(report)
    render(<Diagnostics t={t} />)
    await waitFor(() => expect(screen.queryByText(t('checkLoading'))).toBeNull())

    // Section count is 0 (no CONFIRMED mismatches)…
    const section = assertSection(t('checkPeerMismatches'), 0)
    // …the overview line shows "0 mismatch(es) · 2 informational"…
    expect(screen.getByText(t('checkPeerOverview').replace('{0}', '0').replace('{1}', '2'))).toBeTruthy()
    // …and the body still renders (empty text + the reachable disclosure).
    expect(within(section).getByText(t('checkPeerEmpty'))).toBeTruthy()
    const disclosure = within(section).getByText(/informational entries/)
    expect(disclosure).toBeTruthy()

    // The disclosure's leading chevron button is the toggle (the title span
    // itself is inert). Expanding it reveals both informational rows.
    const row = disclosure.closest('[data-disclosure-row]') as HTMLElement | null
    expect(row).not.toBeNull()
    const toggle = row?.querySelector('button') as HTMLButtonElement | null
    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle!)
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(within(section).getByText(t('checkSatisfied'))).toBeTruthy()
    expect(within(section).getByText(t('checkUnknown'))).toBeTruthy()
  })
})
