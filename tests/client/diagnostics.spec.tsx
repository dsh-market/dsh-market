// @vitest-environment jsdom
/**
 * Portable render tests for the Diagnostics tab (issue #98, phase 1). The
 * host boundary is the single /dsh-market/check fetch, stubbed with a
 * synthetic fixture CheckReport (mirroring src/check.ts) — no real profile,
 * no absolute machine paths, so this runs on any environment/CI.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
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
  coreDeps: [
    {
      plugin: 'dsh-excel-chat', name: '@deepseek-ai/dsh-tools', spec: '^0.0.1-rc.1',
      section: 'dependencies', hoisted: '0.0.1-rc.1', nested: null,
      host: '0.1.0-rc.6', shadowing: true,
    },
  ],
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
  coreDeps: [],
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
    expect(screen.getByText(new RegExp(`^${t('catDeps')}:\\s*5$`))).toBeTruthy()
    expect(screen.getByText(`${t('checkProfile')}: /synthetic/profiles/web`)).toBeTruthy()

    // Every section heading renders with its count (scoped to the section).
    assertSection(t('checkErrors'), 2)
    assertSection(t('checkWarnings'), 1)
    assertSection(t('checkBundles'), 3)
    assertSection(t('checkDuplicates'), 1)
    assertSection(t('checkCoreDeps'), 1)
    assertSection(t('checkPeerMismatches'), 3)
    assertSection(t('checkMultiVersion'), 1)
    // DisclosureRows render title and count as one text node.
    expect(screen.getByText(`${t('checkOverrides')} (1)`)).toBeTruthy()
    expect(screen.getByText(`${t('checkOrphans')} (1)`)).toBeTruthy()

    // Problem lists render in the red error style (css-module err class).
    const dupErrLine = screen.getByText(/duplicate loader entry id/)
    expect(dupErrLine.closest('[class*="err"]')).not.toBeNull()
    expect(screen.getByText(/does not match resolved 0\.2\.0/)).toBeTruthy()

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

    // Shadowing badge on the core-dep row.
    expect(screen.getByText(t('checkShadowing'))).toBeTruthy()

    // Peer badges for every satisfiability state.
    expect(screen.getByText(t('checkUnsatisfied'))).toBeTruthy()
    expect(screen.getByText(t('checkSatisfied'))).toBeTruthy()
    expect(screen.getByText(t('checkUnknown'))).toBeTruthy()

    // Multi-version row, scoped to its section (the name also appears in coreDeps).
    const mvSection = assertSection(t('checkMultiVersion'), 1)
    expect(within(mvSection).getByText('@deepseek-ai/dsh-tools')).toBeTruthy()
    expect(within(mvSection).getByText('0.0.1-rc.1 / 0.1.0-rc.6')).toBeTruthy()

    // Overrides disclosure opens expanded and lists its row.
    expect(screen.getByText(`overridden layers: @deepseek-ai/dsh-base`)).toBeTruthy()

    // Orphan patch row renders its id and reason.
    expect(screen.getByText('ghost-entry')).toBeTruthy()
    expect(screen.getByText(`reason: patch target not found`)).toBeTruthy()
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
      'checkDuplicatesEmpty', 'checkCoreDepsEmpty', 'checkPeerEmpty',
      'checkMultiEmpty', 'checkOverridesEmpty', 'checkOrphansEmpty',
    ]) {
      expect(screen.getByText(t(key)), t(key)).toBeTruthy()
    }
    expect(screen.getByText(`${t('checkOverrides')} (0)`)).toBeTruthy()
    expect(screen.getByText(`${t('checkOrphans')} (0)`)).toBeTruthy()
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
})
