// @vitest-environment jsdom
/** Real page consumers must retire offers when the host invalidates its source context. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketSection, resetHostCompatibilityCache, resetThemePreviewCache } from '../../src/client/MarketSection.tsx'
import { SettingsCard } from '../../src/client/SettingsCard.tsx'
import { en } from '../../src/client/locales.ts'
import { resetGithubRouting, resetScreenshotsCache } from '../../src/client/market-data.ts'
import { updateNotifications } from '../../src/client/update-notifications.ts'
import type { UpdateNotificationSnapshot } from '../../src/update-notifications.ts'

const t = (key: string): string => (en as Record<string, string>)[key] ?? key
const localeSnapshot = { active: 'en' }
const props = {
  t,
  locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
  theme: { setTheme: () => {} },
  themeStore: { subscribe: () => () => {}, getSnapshot: () => null },
}
let current: UpdateNotificationSnapshot
let stop: (() => void) | undefined

function fakeStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) },
    setItem: (key, value) => { values.set(key, String(value)) },
  }
}

beforeEach(async () => {
  vi.stubGlobal('localStorage', fakeStorage())
  sessionStorage.clear()
  resetGithubRouting()
  resetScreenshotsCache()
  resetThemePreviewCache()
  resetHostCompatibilityCache()
  current = {
    enabled: true, checking: false, checkedAt: 100, lastSuccessAt: 100,
    nextCheckAt: 200, stale: false, error: null, boot: 'boot-1',
    updateExempt: [], disabled: [], blocked: [],
    updates: {
      dshmarket: { kind: 'npm', current: '1.0.0', latest: '1.1.0', eligibleVersion: '1.1.0', updateAvailable: true },
      'dsh-loop': { kind: 'npm', current: '1.0.0', latest: '1.2.0', eligibleVersion: '1.2.0', updateAvailable: true },
    },
  }
  vi.stubGlobal('fetch', vi.fn((input: unknown) => {
    const path = String(input).split('?')[0]
    const body = path === '/dsh-market/update-notifications' ? current
      : path === '/dsh-market/updates' ? { updates: current.updates }
      : path === '/dsh-market/status' ? {
        version: '1.0.0', boot: 'boot-1', active: false, pnpm: true, restart: true,
        selfManaged: true, channel: 'stable', channels: ['stable', 'beta'],
        region: 'global', regions: ['global', 'china'], installed: {},
      }
      : path === '/dsh-market/installed' ? {
        profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [], disabled: [],
        groups: {}, groupOrder: [], favorites: [], blocked: [], updateExempt: [],
      }
      : path === '/dsh-market/registry' ? {
        source: 'live', hostVersion: '0.2.1-rc.3',
        registry: { updated: '', count: 1, categories: { tools: { en: 'Tools' } }, plugins: [{
          name: 'dsh-loop', owner: 'alice', url: 'https://github.com/alice/dsh-loop',
          category: 'tools', npm: 'dsh-loop', stars: 1, added: '2026-08-01',
          description: { en: 'Loop task runner' }, install: '',
        }] },
      }
      : path === '/dsh-market/discovery-compatibility' ? { hostVersion: '0.2.1-rc.3', plugins: {} }
      : { ok: true }
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
  }))
  stop = updateNotifications.start()
  await updateNotifications.refresh()
})

afterEach(() => {
  cleanup()
  stop?.()
  stop = undefined
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

async function invalidateCheckedSource(): Promise<void> {
  current = { ...current, checkedAt: null, lastSuccessAt: null, stale: true, updates: {} }
  await act(async () => { await updateNotifications.refreshAfterChange() })
  expect(updateNotifications.getSnapshot()).toMatchObject({ loaded: true, checkedAt: null, updates: {} })
}

describe('update notification page integration', () => {
  it('clears the mounted settings offer when the checked source is invalidated', async () => {
    render(<SettingsCard t={t} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    await screen.findByRole('button', { name: en.setSelfUpdate })
    await act(async () => { await updateNotifications.refreshAfterChange() })
    expect(screen.getByText(/1\.1\.0/)).toBeTruthy()

    await invalidateCheckedSource()
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: en.setSelfUpdate })).toBeNull()
      expect(screen.queryByText(/1\.1\.0/)).toBeNull()
    })
  })

  it('clears the mounted market offer when the checked source is invalidated', async () => {
    render(<MarketSection {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    await screen.findByRole('button', { name: 'Update v1.2.0' })
    await act(async () => { await updateNotifications.refreshAfterChange() })

    await invalidateCheckedSource()
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Update v1.2.0' })).toBeNull()
      expect(screen.queryByRole('button', { name: en.updateAll })).toBeNull()
    })
    expect(screen.getAllByText('dsh-loop').length).toBeGreaterThan(0)
  })
})
