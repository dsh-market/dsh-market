// @vitest-environment jsdom
/**
 * Read-only report extras (issue #98, PR-A): the before/after ordering
 * conflicts and the same-name plugin rows are part of the read-only
 * diagnostics report. The interactive phase 2/3 panels — community-bundle
 * ordering, snapshots & rollback, plugin presets and the AI-fix button —
 * ship in later stacked PRs and must NOT be present here. The host boundary
 * is the single /dsh-market/check fetch, stubbed with a synthetic fixture —
 * no real profile, no absolute machine paths.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Diagnostics } from '../../src/client/Diagnostics.tsx'
import { en } from '../../src/client/locales.ts'

const t = (key: string) => (en as Record<string, string>)[key] ?? key

/** Synthetic check report with an ordering conflict and a same-name row. */
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

/** Stub the single host boundary (GET /dsh-market/check). */
function stubCheckReport(payload: unknown) {
  const mock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })))
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Diagnostics read-only extras (jsdom, #98 PR-A)', () => {
  it('renders ordering conflicts and same-name rows; no action panels are present', async () => {
    const fetchMock = stubCheckReport(CHECK_REPORT)
    render(<Diagnostics t={t} />)
    await waitFor(() => expect(screen.queryByText(t('checkLoading'))).toBeNull())
    expect(fetchMock.mock.calls.length).toBe(1)

    // Ordering-conflict rows render read-only: `name — reason`.
    expect(screen.getByText(t('orderConflicts'))).toBeTruthy()
    expect(screen.getByText(/^alpha — must load after beta/)).toBeTruthy()

    // Same-name rows render in the neutral informational style (no ⚠).
    expect(screen.getByText(t('duplicateNames'))).toBeTruthy()
    expect(screen.getByText(/^shared-name × 2 — alpha \/ beta$/)).toBeTruthy()

    // None of the phase 2/3 action panels or the AI-fix button exist.
    expect(screen.queryByRole('button', { name: t('orderApply') })).toBeNull()
    expect(screen.queryByRole('button', { name: t('snapSection') })).toBeNull()
    expect(screen.queryByRole('button', { name: t('presetSection') })).toBeNull()
    expect(screen.queryByRole('button', { name: t('aiFix') })).toBeNull()
  })
})
