// @vitest-environment jsdom
/**
 * The market's card on the plugin configuration page.
 *
 * It had no spec at all until it grew a destructive action — the version
 * before this one shipped an `isOverridden` helper nothing ever exercised.
 * A card whose button uninstalls the plugin serving the page is the wrong
 * place to keep that record.
 *
 * Same convention as the other layer-2 specs: jsdom, testing-library, the
 * REAL component with the REAL locale dictionary, and the host boundary
 * stubbed at fetch.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsCard, clearBrowserState } from '../../src/client/SettingsCard.tsx'
import { en } from '../../src/client/locales.ts'

const t = (key: string): string => (en as Record<string, string>)[key] ?? key

let calls: Array<{ path: string; body: unknown }> = []

function stubFetch(options: { version?: string; restart?: boolean; latest?: string | null; removeOk?: boolean; error?: string } = {}): void {
  calls = []
  vi.stubGlobal('fetch', vi.fn((input: unknown, init?: RequestInit) => {
    const path = String(input)
    calls.push({ path, body: init?.body === undefined ? null : JSON.parse(String(init.body)) })
    const json = (value: unknown): Promise<Response> =>
      Promise.resolve(new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } }))
    if (path.endsWith('/dsh-market/status')) {
      return json({ version: options.version ?? '1.12.2', restart: options.restart !== false })
    }
    if (path.endsWith('/dsh-market/updates')) {
      return json({ updates: { dshmarket: { updateAvailable: options.latest != null, latest: options.latest ?? null } } })
    }
    if (path.endsWith('/dsh-market/self-uninstall')) {
      return options.removeOk === false
        ? json({ ok: false, error: options.error ?? 'boom' })
        : json({ ok: true, removed: 'dshmarket', restart: options.restart !== false })
    }
    return json({ ok: true })
  }))
}

beforeEach(() => { stubFetch() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** Open the card — everything below the header is behind the disclosure. */
async function open(): Promise<void> {
  render(<SettingsCard t={t} />)
  fireEvent.click(screen.getByRole('button', { expanded: false }))
  await waitFor(() => { expect(screen.getByText(t('setSelfRemove'), { selector: 'div' })).toBeTruthy() })
}

describe('SettingsCard', () => {
  it('starts collapsed and asks the host for nothing until opened', () => {
    render(<SettingsCard t={t} />)
    // The plugin configuration page renders every card at once; a card that
    // probed the registry on mount would cost a round trip per plugin for a
    // row the user may never look at.
    expect(calls).toEqual([])
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy()
  })

  it('shows the running version once opened', async () => {
    await open()
    await waitFor(() => { expect(screen.getByText(/v1\.12\.2/)).toBeTruthy() })
  })

  it('offers an update only when one exists', async () => {
    stubFetch({ latest: null })
    await open()
    await waitFor(() => { expect(screen.getByText(t('setSelfUpToDate'))).toBeTruthy() })
    expect(screen.queryByRole('button', { name: t('setSelfUpdate') })).toBeNull()

    cleanup()
    stubFetch({ latest: '1.13.0' })
    await open()
    await waitFor(() => { expect(screen.getByText(/1\.13\.0/)).toBeTruthy() })
    expect(screen.getByRole('button', { name: t('setSelfUpdate') })).toBeTruthy()
  })

  it('never removes anything on the first click', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemove') }))
    // The first click only reveals the confirmation. A destructive action
    // reachable in one click, on the plugin serving the page, is exactly the
    // shape the route's explicit `confirm` flag exists to refuse.
    expect(calls.some(call => call.path.includes('self-uninstall'))).toBe(false)
    expect(screen.getByText(t('setSelfConfirm'))).toBeTruthy()
  })

  it('states the consequence of KEEPING the data, which is the surprising one', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemove') }))
    // Unchecked is the default, and its consequence — plugins the market
    // switched off stay off with no UI left to switch them back on — is the
    // part a user cannot work out alone. It has to be on screen before the
    // choice, not after it.
    expect(screen.getByText(t('setSelfPurgeOff'))).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByText(t('setSelfPurgeOn'))).toBeTruthy()
  })

  it('sends the confirmation and the purge choice the user actually made', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemove') }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemoveConfirm') }))
    await waitFor(() => { expect(screen.getByText(t('setSelfRemoved'))).toBeTruthy() })
    const sent = calls.find(call => call.path.includes('self-uninstall'))
    expect(sent?.body).toEqual({ confirm: true, purge: true })
  })

  it('defaults purge to off when the user does not tick it', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemove') }))
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemoveConfirm') }))
    await waitFor(() => { expect(screen.getByText(t('setSelfRemoved'))).toBeTruthy() })
    expect(calls.find(call => call.path.includes('self-uninstall'))?.body).toEqual({ confirm: true, purge: false })
  })

  it('replaces the controls after removal instead of offering dead ones', async () => {
    stubFetch({ latest: '1.13.0' })
    await open()
    await waitFor(() => { expect(screen.getByRole('button', { name: t('setSelfUpdate') })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemove') }))
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemoveConfirm') }))
    await waitFor(() => { expect(screen.getByText(t('setSelfRemoved'))).toBeTruthy() })
    // The package is gone from disk; an update button beside "removed" would
    // offer something that cannot happen.
    expect(screen.queryByRole('button', { name: t('setSelfUpdate') })).toBeNull()
    expect(screen.getByRole('button', { name: t('setSelfRestartNow') })).toBeTruthy()
  })

  it('hides the restart button on a host that forbids self-restart', async () => {
    // Same rule the pending-change banner follows: when a supervisor owns the
    // process, the market says what is pending and lets the supervisor act.
    stubFetch({ restart: false })
    await open()
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemove') }))
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemoveConfirm') }))
    await waitFor(() => { expect(screen.getByText(t('setSelfRemoved'))).toBeTruthy() })
    expect(screen.queryByRole('button', { name: t('setSelfRestartNow') })).toBeNull()
    expect(screen.getByText(t('setSelfRemovedHint'))).toBeTruthy()
  })

  it('surfaces the server\'s reason when removal fails', async () => {
    stubFetch({ removeOk: false, error: 'EACCES: permission denied' })
    await open()
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemove') }))
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemoveConfirm') }))
    await waitFor(() => { expect(screen.getByText(/EACCES/)).toBeTruthy() })
    // Still removable: a failure must not leave the card in a state where the
    // user can neither retry nor understand what happened.
    expect(screen.queryByText(t('setSelfRemoved'))).toBeNull()
  })
})

describe('clearBrowserState', () => {
  it('clears exactly the market\'s own keys', () => {
    const removed: string[] = []
    clearBrowserState({ removeItem: (key: string) => { removed.push(key) } })
    expect(removed).toEqual(['dshm-webdav', 'dshm-gist-id'])
  })

  it('survives a storage that throws', () => {
    // Safari in private mode, and any browser with storage disabled. The
    // uninstall already succeeded on the server by this point — throwing here
    // would report a failure that did not happen.
    expect(() => {
      clearBrowserState({ removeItem: () => { throw new Error('QuotaExceededError') } })
    }).not.toThrow()
  })
})
