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

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsCard, clearBrowserState } from '../../src/client/SettingsCard.tsx'
import { en } from '../../src/client/locales.ts'
import type { SidebarEntry } from '../../src/client/sidebar-entry.ts'
import type { EntryKey, EntryVisibility } from '../../src/client/entry-visibility.ts'

const t = (key: string): string => (en as Record<string, string>)[key] ?? key

let calls: Array<{ path: string; body: unknown }> = []

function stubFetch(options: {
  version?: string; restart?: boolean; latest?: string | null; restoreRequired?: boolean; removeOk?: boolean; error?: string; selfManaged?: boolean
  kind?: string
  channel?: string; channelSwitch?: string; channelError?: string
  region?: string; regionAuto?: boolean; regionError?: string; githubProxy?: string | null
  githubProxyCustom?: string | null; githubProxyManaged?: boolean; githubProxyError?: string
  buildEnv?: Record<string, string>; buildEnvError?: string
} = {}): void {
  calls = []
  let githubProxyCustom = options.githubProxyCustom ?? null
  vi.stubGlobal('fetch', vi.fn((input: unknown, init?: RequestInit) => {
    const path = String(input)
    calls.push({ path, body: init?.body === undefined ? null : JSON.parse(String(init.body)) })
    const json = (value: unknown): Promise<Response> =>
      Promise.resolve(new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } }))
    if (path.endsWith('/dsh-market/status')) {
      return json({
        version: options.version ?? '1.12.2',
        restart: options.restart !== false,
        channel: options.channel ?? 'stable',
        channels: ['stable', 'beta', 'dev'],
        region: options.region ?? 'global',
        regions: ['global', 'china'],
        regionAuto: options.regionAuto === true,
        githubProxy: options.githubProxy ?? null,
        githubRoutes: {
          raw: options.githubProxy === undefined ? [null] : [options.githubProxy],
          avatar: options.githubProxy === undefined ? [null] : [options.githubProxy],
          git: options.githubProxy === undefined ? [null] : [options.githubProxy],
        },
        githubProxyCustom,
        githubProxyManaged: options.githubProxyManaged === true,
        selfManaged: options.selfManaged !== false,
        buildEnv: options.buildEnv ?? {},
      })
    }
    if (path.endsWith('/dsh-market/build-env')) {
      // The server answers with what it APPLIED — here, the same map sent
      // back, exactly like the region endpoint echoes its choice.
      return options.buildEnvError !== undefined
        ? json({ ok: false, error: options.buildEnvError })
        : json({ ok: true, buildEnv: (JSON.parse(String(init?.body)) as { buildEnv: Record<string, string> }).buildEnv })
    }
    if (path.includes('/dsh-market/updates')) {
      return json({ updates: { dshmarket: options.channelSwitch !== undefined
        ? { updateAvailable: false, latest: options.channelSwitch, channelSwitch: options.channelSwitch }
        : {
            // A generation (#497) names its newer release without offering it.
            updateAvailable: options.kind !== 'generation' && options.latest != null,
            latest: options.latest ?? null,
            restoreRequired: options.restoreRequired === true,
            ...(options.kind === undefined ? {} : { kind: options.kind }),
          } } })
    }
    if (path.endsWith('/dsh-market/channel')) {
      return options.channelError !== undefined
        ? json({ ok: false, error: options.channelError })
        : json({ ok: true, channel: (JSON.parse(String(init?.body)) as { channel: string }).channel })
    }
    if (path.endsWith('/dsh-market/region')) {
      return options.regionError !== undefined
        ? json({ ok: false, error: options.regionError })
        : json({ ok: true, region: (JSON.parse(String(init?.body)) as { region: string }).region })
    }
    if (path.endsWith('/dsh-market/github-proxy')) {
      if (options.githubProxyError !== undefined) return json({ ok: false, error: options.githubProxyError })
      const raw = (JSON.parse(String(init?.body)) as { proxy: string | null }).proxy
      githubProxyCustom = raw === null ? null : raw.replace(/\/+$/, '')
      return json({ ok: true, githubProxyCustom })
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

  it('keeps host-provided installations out of profile package controls', async () => {
    stubFetch({ selfManaged: false, latest: '1.13.0' })
    render(<SettingsCard t={t} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    await waitFor(() => { expect(screen.getByText(t('setRegion'), { selector: 'div' })).toBeTruthy() })
    expect(screen.queryByText(t('setSelfUpToDate'))).toBeNull()
    expect(screen.queryByText(t('setChannel'), { selector: 'div' })).toBeNull()
    expect(screen.queryByRole('button', { name: t('setSelfUpdate') })).toBeNull()
    expect(screen.queryByRole('button', { name: t('setSelfRemove') })).toBeNull()
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

  it('names a newer release for a host-installed market without offering to apply it (#497)', async () => {
    stubFetch({ version: '1.38.1', latest: '1.41.0', kind: 'generation' })
    await open()
    await waitFor(() => { expect(screen.getByText(/1\.41\.0/)).toBeTruthy() })
    expect(screen.getByText(t('setSelfHostManagedHint'))).toBeTruthy()
    expect(screen.queryByRole('button', { name: t('setSelfUpdate') })).toBeNull()
    expect(screen.queryByRole('button', { name: t('restoreOnline') })).toBeNull()
  })

  it('confirms before switching a locally packaged market to its matched online release', async () => {
    stubFetch({ version: '1.29.2', latest: '1.37.0', restoreRequired: true })
    await open()
    const button = await screen.findByRole('button', { name: t('restoreOnline') })
    fireEvent.click(button)
    expect(calls.some(call => call.path.endsWith('/dsh-market/update'))).toBe(false)
    expect(screen.getByText(t('restoreHint'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('restoreContinue') }))
    await waitFor(() => {
      expect(calls.find(call => call.path.endsWith('/dsh-market/update'))?.body)
        .toEqual({ name: 'dshmarket', restore: true })
    })
  })

  it('does not explain what the Update button does when there is no Update button', async () => {
    // "Updating downloads a new version, restart to apply" makes sense next
    // to an Update button. Already up to date, it read as an instruction for
    // an action that was not on screen (reported from a real host).
    stubFetch({ latest: null })
    await open()
    await waitFor(() => { expect(screen.getByText(t('setSelfUpToDate'))).toBeTruthy() })
    expect(screen.queryByText(t('setSelfUpdateHint'))).toBeNull()

    cleanup()
    stubFetch({ latest: '1.13.0' })
    await open()
    await waitFor(() => { expect(screen.getByText(t('setSelfUpdateHint'))).toBeTruthy() })
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
    fireEvent.click(screen.getByRole('checkbox', { name: t('setSelfPurge') }))
    expect(screen.getByText(t('setSelfPurgeOn'))).toBeTruthy()
  })

  it('sends the confirmation and the purge choice the user actually made', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemove') }))
    fireEvent.click(screen.getByRole('checkbox', { name: t('setSelfPurge') }))
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

  it('offers no control in the end state that the server can no longer answer', async () => {
    stubFetch({ latest: '1.13.0' })
    await open()
    await waitFor(() => { expect(screen.getByRole('button', { name: t('setSelfUpdate') })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemove') }))
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemoveConfirm') }))
    await waitFor(() => { expect(screen.getByText(t('setSelfRemoved'))).toBeTruthy() })
    // The package is gone from disk AND the market is out of the running
    // composition, so every one of its routes is gone with it. The first
    // version put a "restart now" button here; on a real host it could only
    // answer 405. Nothing actionable belongs in this state.
    expect(screen.queryByRole('button', { name: t('setSelfUpdate') })).toBeNull()
    expect(screen.queryByRole('button')).toBe(screen.getByRole('button', { expanded: true }))
  })

  it('asks exactly one thing — whether to keep the data', async () => {
    // The confirmation carried a second checkbox for a moment: whether to
    // restart afterwards. It was there to work around a constraint of ours
    // (the restart route dies with the market), not because the answer was
    // the user's to give — a removal is not finished without a restart, and
    // there is no version of "removed but not restarted" anyone wants. A
    // consequence gets STATED; only a real choice gets asked.
    await open()
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemove') }))
    // Scoped to the confirmation: the card has other checkboxes elsewhere,
    // and what this asserts is that REMOVING asks one question.
    const confirm = screen.getByText(t('setSelfConfirm')).parentElement!
    expect(within(confirm).getAllByRole('checkbox')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemoveConfirm') }))
    await waitFor(() => { expect(screen.getByText(t('setSelfRemoved'))).toBeTruthy() })
    expect(calls.find(call => call.path.includes('self-uninstall'))?.body)
      .toEqual({ confirm: true, purge: false })
  })

  it('retires the market\'s own menu entry once the package is gone', async () => {
    // The visible half of the removal. Without it the left menu still offers
    // "插件市场", and clicking it opens a page whose server routes have just
    // been disposed — the card would be claiming something the profile no
    // longer agrees with.
    const retired = vi.fn()
    render(<SettingsCard t={t} onRemoved={retired} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    await waitFor(() => { expect(screen.getByText(t('setSelfRemove'), { selector: 'div' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemove') }))
    expect(retired).not.toHaveBeenCalled() // not before it actually happened
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemoveConfirm') }))
    await waitFor(() => { expect(retired).toHaveBeenCalledTimes(1) })
  })

  it('leaves the menu alone when removal fails', async () => {
    stubFetch({ removeOk: false })
    const retired = vi.fn()
    render(<SettingsCard t={t} onRemoved={retired} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    await waitFor(() => { expect(screen.getByText(t('setSelfRemove'), { selector: 'div' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemove') }))
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemoveConfirm') }))
    await waitFor(() => { expect(screen.getByText(/boom/)).toBeTruthy() })
    // The market is still installed and still working; removing its menu
    // entry would strand the user with no way back to it.
    expect(retired).not.toHaveBeenCalled()
  })

  it('shows that it is working instead of looking frozen', async () => {
    // Reported from real use: the confirmation vanished the instant the
    // button was clicked and the card fell back to its resting layout with a
    // dimmed button, so a removal that takes seconds of pnpm read as a hang.
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const inner = globalThis.fetch as unknown as (input: unknown, init?: RequestInit) => Promise<Response>
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('self-uninstall')) await gate
      return inner(input, init)
    }))

    await open()
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemove') }))
    fireEvent.click(screen.getByRole('button', { name: t('setSelfRemoveConfirm') }))
    // Mid-flight: the state has to be visible ON SCREEN, not merely internal.
    await waitFor(() => { expect(screen.getByRole('button', { name: t('setSelfWorking') })).toBeTruthy() })
    // ...and cancel is gone, because by now there is nothing left to cancel.
    expect(screen.queryByRole('button', { name: t('setSelfCancel') })).toBeNull()
    release?.()
    await waitFor(() => { expect(screen.getByText(t('setSelfRemoved'))).toBeTruthy() })
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

describe('SettingsCard — channels', () => {
  it('offers all three, with the dev one saying what it is on hover', async () => {
    await open()
    await waitFor(() => { expect(screen.getByRole('button', { name: t('setChannelStable') })).toBeTruthy() })
    expect(screen.getByRole('button', { name: t('setChannelBeta') })).toBeTruthy()
    const dev = screen.getByRole('button', { name: t('setChannelDev') })
    // A plainly labelled option a user can read, rather than one hidden
    // behind a switch: the warning has to travel WITH the control.
    expect(dev.getAttribute('title')).toBe(t('setChannelDevHint'))
    expect(screen.queryByRole('checkbox', { name: /开发者模式|Developer mode/ })).toBeNull()
  })

  it('sends the channel the user picked', async () => {
    await open()
    await waitFor(() => { expect(screen.getByRole('button', { name: t('setChannelDev') })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: t('setChannelDev') }))
    await waitFor(() => {
      expect(calls.find(call => call.path.includes('/dsh-market/channel'))?.body).toEqual({ channel: 'dev' })
    })
  })

  it('does not leave a refused channel looking selected', async () => {
    // It used to move the control first and ignore the answer. Any refusal
    // — a bad value, a host that does not know the channel — would have
    // left the user looking at one their profile is not on.
    stubFetch({ channelError: 'no such channel' })
    await open()
    await waitFor(() => { expect(screen.getByRole('button', { name: t('setChannelBeta') })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: t('setChannelBeta') }))
    await waitFor(() => { expect(screen.getByText(/no such channel/)).toBeTruthy() })
    expect(screen.getByRole('button', { name: t('setChannelStable') }).className).toMatch(/SegOn|setSegOn/)
  })
})

describe('SettingsCard — sidebar shortcut (#846)', () => {
  /** A stand-in controller: the card's contract is with this, not with fetch. */
  function fakeSidebar(options: { supported: boolean; enabled?: boolean; shown?: boolean; refuse?: string; onlyDoor?: boolean }): SidebarEntry & { sets: boolean[]; support(): void } {
    let supported = options.supported
    let enabled = options.enabled === true
    const listeners = new Set<() => void>()
    const sets: boolean[] = []
    return {
      sets,
      supported: () => supported,
      enabled: () => enabled,
      shown: () => options.shown ?? enabled,
      ready: () => true,
      onlyDoor: () => options.onlyDoor === true,
      refresh: () => {},
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      markSupported: () => {},
      load: async () => {},
      support: () => { supported = true; for (const l of listeners) l() },
      set: async (next) => {
        sets.push(next)
        if (options.refuse !== undefined) throw new Error(options.refuse)
        enabled = next
        for (const l of listeners) l()
        return next
      },
    }
  }

  async function openWith(sidebar: SidebarEntry): Promise<void> {
    render(<SettingsCard t={t} sidebar={sidebar} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    await waitFor(() => { expect(screen.getByText(t('setSelfRemove'), { selector: 'div' })).toBeTruthy() })
  }

  /** The three entry switches live behind one collapsed group (#1015). */
  function openAdvanced(): void {
    fireEvent.click(screen.getByRole('button', { name: t('setAdvanced') }))
  }

  it('offers no switch on a host without sidebar panels', async () => {
    await openWith(fakeSidebar({ supported: false }))
    expect(screen.queryByText(t('setSidebar'))).toBeNull()
    expect(screen.queryByRole('button', { name: t('setAdvanced') })).toBeNull()
  })

  it('appears once the host declares sidebar panels, off by default', async () => {
    const sidebar = fakeSidebar({ supported: false })
    await openWith(sidebar)
    act(() => { sidebar.support() })
    openAdvanced()
    await waitFor(() => { expect(screen.getByText(t('setSidebar'))).toBeTruthy() })
    expect(screen.getByRole('button', { name: t('setSidebarOff') }).getAttribute('aria-pressed')).toBe('true')
    const sidebarLabel = screen.getByText(t('setSidebar'))
    const regionLabel = screen.getByText(t('setRegion'))
    expect(sidebarLabel.compareDocumentPosition(regionLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('turns the row on', async () => {
    const sidebar = fakeSidebar({ supported: true })
    await openWith(sidebar)
    openAdvanced()
    expect(screen.getByText(t('setSidebarHint'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('setSidebarOn') }))
    await waitFor(() => { expect(sidebar.sets).toEqual([true]) })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: t('setSidebarOn') }).getAttribute('aria-pressed')).toBe('true')
    })
  })

  it('does not re-send the choice already in force', async () => {
    const sidebar = fakeSidebar({ supported: true, enabled: true })
    await openWith(sidebar)
    openAdvanced()
    fireEvent.click(screen.getByRole('button', { name: t('setSidebarOn') }))
    expect(sidebar.sets).toEqual([])
  })

  it('keeps the old choice selected and shows why when saving fails', async () => {
    const sidebar = fakeSidebar({ supported: true, refuse: 'untrusted origin' })
    await openWith(sidebar)
    openAdvanced()
    fireEvent.click(screen.getByRole('button', { name: t('setSidebarOn') }))
    await waitFor(() => { expect(screen.getByText('untrusted origin')).toBeTruthy() })
    expect(screen.getByRole('button', { name: t('setSidebarOff') }).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('SettingsCard — entry visibility (#1015)', () => {
  /** The controller as the card sees it; the two page entries are its half. */
  function fakeEntries(options: {
    settingsSupported?: boolean
    hostAllows?: boolean
    pluginsTabSupported?: boolean
    settingsSection?: boolean
    pluginsTab?: boolean
    sidebarSupported?: boolean
    sidebarEnabled?: boolean
    refuse?: string
  } = {}): EntryVisibility & { sets: Array<{ key: EntryKey; visible: boolean }> } {
    const settingsSupported = options.settingsSupported !== false
    const pluginsTabSupported = options.pluginsTabSupported === true
    const sidebarSupported = options.sidebarSupported === true
    let hostAllows = options.hostAllows !== false
    let settingsSection = options.settingsSection !== false
    let pluginsTab = options.pluginsTab !== false
    const sidebarEnabled = options.sidebarEnabled === true
    const listeners = new Set<() => void>()
    const sets: Array<{ key: EntryKey; visible: boolean }> = []
    const notify = (): void => { for (const listener of listeners) listener() }
    const settingsOpen = (): boolean => settingsSupported && hostAllows && settingsSection
    const tabOpen = (): boolean => pluginsTabSupported && pluginsTab
    const rowOpen = (): boolean => sidebarSupported && sidebarEnabled
    return {
      sets,
      settingsSection: () => settingsSection,
      pluginsTab: () => pluginsTab,
      settingsSupported: () => settingsSupported,
      settingsAvailable: () => settingsSupported && hostAllows,
      pluginsTabSupported: () => pluginsTabSupported,
      settingsVisible: settingsOpen,
      setHostSettingsVisible: (visible) => { hostAllows = visible; notify() },
      markSettingsSection: () => {},
      markPluginsTab: () => {},
      otherDoorOpen: (key) =>
        (key !== 'settingsSection' && settingsOpen())
        || (key !== 'pluginsTab' && tabOpen())
        || (key !== 'sidebar' && rowOpen()),
      load: async () => {},
      set: async (key, visible) => {
        sets.push({ key, visible })
        if (options.refuse !== undefined) throw new Error(options.refuse)
        if (key === 'settingsSection') settingsSection = visible
        else pluginsTab = visible
        notify()
        return visible
      },
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      retire: () => {},
    }
  }

  function fakeSidebar(options: { supported: boolean; enabled?: boolean; shown?: boolean }): SidebarEntry {
    const enabled = options.enabled === true
    return {
      sets: [],
      supported: () => options.supported,
      enabled: () => enabled,
      shown: () => options.shown ?? enabled,
      ready: () => true,
      onlyDoor: () => false,
      refresh: () => {},
      subscribe: () => () => {},
      markSupported: () => {},
      load: async () => {},
      set: async (next) => next,
    } as SidebarEntry & { sets: boolean[] }
  }

  async function openWith(entries: EntryVisibility, sidebar?: SidebarEntry): Promise<void> {
    render(<SettingsCard t={t} entries={entries} {...(sidebar === undefined ? {} : { sidebar })} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    await waitFor(() => { expect(screen.getByText(t('setSelfRemove'), { selector: 'div' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: t('setAdvanced') }))
  }

  const rowOf = (label: string): HTMLElement => {
    const labelNode = screen.getByText(label)
    return labelNode.parentElement!.parentElement!
  }

  it('keeps all three switches behind the collapsed Advanced group', async () => {
    const entries = fakeEntries({ settingsSupported: true, pluginsTabSupported: true })
    render(<SettingsCard t={t} entries={entries} sidebar={fakeSidebar({ supported: true })} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    await waitFor(() => { expect(screen.getByText(t('setSelfRemove'), { selector: 'div' })).toBeTruthy() })
    expect(screen.queryByText(t('setEntrySection'))).toBeNull()
    expect(screen.queryByText(t('setEntryPluginsTab'))).toBeNull()
    expect(screen.queryByText(t('setSidebar'))).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('setAdvanced') }))
    expect(screen.getByText(t('setEntrySection'))).toBeTruthy()
    expect(screen.getByText(t('setEntryPluginsTab'))).toBeTruthy()
    expect(screen.getByText(t('setSidebar'))).toBeTruthy()
  })

  it('hides the settings switch when the host keeps that entry itself (#602)', async () => {
    const entries = fakeEntries({ settingsSupported: true, hostAllows: false, pluginsTabSupported: true })
    await openWith(entries)
    expect(screen.queryByText(t('setEntrySection'))).toBeNull()
    expect(screen.getByText(t('setEntryPluginsTab'))).toBeTruthy()
  })

  it('hides the Plugins tab switch on a host that never declares the slot', async () => {
    const entries = fakeEntries({ settingsSupported: true, pluginsTabSupported: false })
    await openWith(entries)
    expect(screen.getByText(t('setEntrySection'))).toBeTruthy()
    expect(screen.queryByText(t('setEntryPluginsTab'))).toBeNull()
  })

  it('saves each page entry through the controller', async () => {
    const entries = fakeEntries({
      settingsSupported: true, pluginsTabSupported: true, sidebarSupported: true, sidebarEnabled: true,
    })
    await openWith(entries, fakeSidebar({ supported: true, enabled: true }))
    fireEvent.click(within(rowOf(t('setEntrySection'))).getByRole('button', { name: t('setEntryHide') }))
    await waitFor(() => { expect(entries.sets).toEqual([{ key: 'settingsSection', visible: false }]) })
    await waitFor(() => {
      expect(within(rowOf(t('setEntrySection'))).getByRole('button', { name: t('setEntryHide') }).getAttribute('aria-pressed')).toBe('true')
    })
  })

  it('disables the last open door and says why', async () => {
    const entries = fakeEntries({
      settingsSupported: true, pluginsTabSupported: true, pluginsTab: false,
    })
    await openWith(entries)
    const hide = within(rowOf(t('setEntrySection'))).getByRole('button', { name: t('setEntryHide') })
    expect(hide.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(new RegExp(t('setEntryLastDoorHint')))).toBeTruthy()
  })

  it('shows a sidebar row that is the only door as on, and refuses to hide it', async () => {
    // The row can be shown before it was ever "enabled": a host with no
    // other door shows it by default (#846). The switch must reflect what
    // is on screen, not the absent saved choice.
    const entries = fakeEntries({
      settingsSupported: true, pluginsTabSupported: true, settingsSection: false, pluginsTab: false,
    })
    await openWith(entries, fakeSidebar({ supported: true, shown: true }))
    const row = rowOf(t('setSidebar'))
    expect(within(row).getByRole('button', { name: t('setSidebarOn') }).getAttribute('aria-pressed')).toBe('true')
    expect(within(row).getByRole('button', { name: t('setSidebarOff') }).hasAttribute('disabled')).toBe(true)
  })

  it('keeps the switch where it was and shows the refusal', async () => {
    const entries = fakeEntries({
      settingsSupported: true, pluginsTabSupported: true, sidebarSupported: true, sidebarEnabled: true, refuse: 'untrusted origin',
    })
    await openWith(entries, fakeSidebar({ supported: true, enabled: true }))
    fireEvent.click(within(rowOf(t('setEntrySection'))).getByRole('button', { name: t('setEntryHide') }))
    await waitFor(() => { expect(screen.getByText('untrusted origin')).toBeTruthy() })
    expect(within(rowOf(t('setEntrySection'))).getByRole('button', { name: t('setEntryShow') }).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('SettingsCard — download region', () => {
  it('offers the two regions the server named, with the current one selected', async () => {
    await open()
    await waitFor(() => { expect(screen.getByRole('button', { name: t('setRegionGlobal') })).toBeTruthy() })
    expect(screen.getByRole('button', { name: t('setRegionChina') })).toBeTruthy()
    expect(screen.getByRole('button', { name: t('setRegionGlobal') }).className).toMatch(/SegOn|setSegOn/)
  })

  it('describes what the selected region actually does', async () => {
    stubFetch({ region: 'china' })
    await open()
    // The second sentence is the one that matters: a user handed a mirror
    // needs to know the plugin is still the author's, only the route changed.
    await waitFor(() => { expect(screen.getByText(t('setRegionChinaHint'))).toBeTruthy() })
  })

  it('sends the region the user picked', async () => {
    await open()
    await waitFor(() => { expect(screen.getByRole('button', { name: t('setRegionChina') })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: t('setRegionChina') }))
    await waitFor(() => {
      expect(calls.find(call => call.path.endsWith('/dsh-market/region'))?.body).toEqual({ region: 'china' })
    })
  })

  it('does not leave a refused region looking selected', async () => {
    stubFetch({ regionError: 'no such region' })
    await open()
    await waitFor(() => { expect(screen.getByRole('button', { name: t('setRegionChina') })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: t('setRegionChina') }))
    await waitFor(() => { expect(screen.getByText(/no such region/)).toBeTruthy() })
    expect(screen.getByRole('button', { name: t('setRegionGlobal') }).className).toMatch(/SegOn|setSegOn/)
  })

  it('explains an automatic choice, and stops once the user has made one', async () => {
    stubFetch({ region: 'china', regionAuto: true })
    await open()
    // A user who never learns a route was chosen for them has no reason to
    // look for the setting when something downloads oddly.
    await waitFor(() => { expect(screen.getByText(new RegExp(t('setRegionAuto')))).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: t('setRegionGlobal') }))
    await waitFor(() => { expect(screen.queryByText(new RegExp(t('setRegionAuto')))).toBeNull() })
  })

  it('re-reads the resolved proxy from the server instead of deriving it', async () => {
    // The card knows which regions exist because the server said so. It must
    // not also know what each one resolves TO, or the routing table would
    // have a second copy that can disagree with the first.
    await open()
    await waitFor(() => { expect(screen.getByRole('button', { name: t('setRegionChina') })).toBeTruthy() })
    calls.length = 0
    fireEvent.click(screen.getByRole('button', { name: t('setRegionChina') }))
    await waitFor(() => {
      expect(calls.filter(call => call.path.endsWith('/dsh-market/status'))).toHaveLength(1)
    })
  })
})

describe('SettingsCard — GitHub escape route', () => {
  it('keeps mirror details behind one custom entry and persists the prefix', async () => {
    await open()
    await waitFor(() => { expect(screen.getByText(t('setGithubProxy'), { selector: 'div' })).toBeTruthy() })
    expect(screen.getByText(t('setGithubProxyAutoHint'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('setGithubProxyCustom') }))
    const input = screen.getByRole('textbox', { name: t('setGithubProxyInput') })
    fireEvent.change(input, { target: { value: 'https://mirror.example/prefix/' } })
    fireEvent.click(screen.getByRole('button', { name: t('setGithubProxySave') }))
    await waitFor(() => {
      expect(calls.find(call => call.path.endsWith('/dsh-market/github-proxy'))?.body)
        .toEqual({ proxy: 'https://mirror.example/prefix/' })
    })
    await waitFor(() => { expect(screen.getByText(t('setGithubProxyCustomHint'))).toBeTruthy() })
  })

  it('offers a restore-to-automatic action for a saved prefix', async () => {
    stubFetch({ githubProxyCustom: 'https://mirror.example' })
    await open()
    await waitFor(() => { expect(screen.getByRole('button', { name: t('setGithubProxyAuto') })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: t('setGithubProxyAuto') }))
    await waitFor(() => {
      expect(calls.find(call => call.path.endsWith('/dsh-market/github-proxy'))?.body).toEqual({ proxy: null })
    })
  })

  it('shows environment-managed routing as read-only', async () => {
    stubFetch({ githubProxyManaged: true, githubProxy: 'https://env.example' })
    await open()
    await waitFor(() => { expect(screen.getByText(t('setGithubProxyManagedHint'))).toBeTruthy() })
    expect(screen.queryByRole('button', { name: t('setGithubProxyCustom') })).toBeNull()
    expect(screen.queryByRole('button', { name: t('setGithubProxyAuto') })).toBeNull()
  })
})

describe('SettingsCard — a channel switch is not an update', () => {
  it('names an older offer for what it is', async () => {
    // Picking stable while a prerelease runs offers 1.13.1, which is older.
    // Calling that "更新" would have the user click Update to go backwards;
    // it IS what they asked for, so it is offered under its own name.
    stubFetch({ version: '1.14.0-beta.1', channel: 'stable', channelSwitch: '1.13.1' })
    await open()
    await waitFor(() => { expect(screen.getByText(`${t('setChannelSwitch')} 1.13.1`)).toBeTruthy() })
    expect(screen.getByRole('button', { name: t('setChannelSwitch') })).toBeTruthy()
    // Never the update wording, and never the update button: the market
    // page reads `updateAvailable` in three places and would announce a
    // downgrade as "a new version is available".
    expect(screen.queryByRole('button', { name: t('setSelfUpdate') })).toBeNull()
    expect(screen.queryByText(new RegExp(t('setSelfUpdateReady')))).toBeNull()
    expect(screen.getByText(t('setChannelSwitchHint'))).toBeTruthy()
  })

  it('still calls a newer offer an update', async () => {
    stubFetch({ version: '1.13.1', latest: '1.14.0' })
    await open()
    await waitFor(() => { expect(screen.getByText(`${t('setSelfUpdateReady')} 1.14.0`)).toBeTruthy() })
    expect(screen.getByRole('button', { name: t('setSelfUpdate') })).toBeTruthy()
  })
})

describe('SettingsCard — build environment (#336)', () => {
  const editor = (): HTMLElement => screen.getByRole('textbox', { name: t('setBuildEnv') })

  it('renders the effective build environment as one KEY=value line each', async () => {
    stubFetch({ buildEnv: { CC: '/usr/bin/gcc-11', CXX: '/usr/bin/g++-11' } })
    await open()
    await waitFor(() => {
      expect((editor() as HTMLTextAreaElement).value).toContain('CC=/usr/bin/gcc-11')
      expect((editor() as HTMLTextAreaElement).value).toContain('CXX=/usr/bin/g++-11')
    })
  })

  it('saves the edited list back to the server in the map shape the route wants', async () => {
    stubFetch({ buildEnv: { CC: '/usr/bin/gcc-11' } })
    await open()
    await waitFor(() => { expect((editor() as HTMLTextAreaElement).value).toContain('CC=/usr/bin/gcc-11') })
    fireEvent.change(editor(), { target: { value: 'CC=/usr/bin/gcc-12\nCXX=/usr/bin/g++-12' } })
    fireEvent.click(screen.getByRole('button', { name: t('setBuildEnvSave') }))
    await waitFor(() => {
      expect(calls.find(call => call.path.endsWith('/dsh-market/build-env'))?.body)
        .toEqual({ buildEnv: { CC: '/usr/bin/gcc-12', CXX: '/usr/bin/g++-12' } })
    })
    // What the textarea shows afterwards is the SERVER's applied answer,
    // not the draft: same contract as the channel/region rows.
    await waitFor(() => {
      expect((editor() as HTMLTextAreaElement).value).toContain('CXX=/usr/bin/g++-12')
    })
  })

  it('sends an empty map when the editor is cleared, so the save clears the override', async () => {
    stubFetch({ buildEnv: { CC: '/usr/bin/gcc-11' } })
    await open()
    await waitFor(() => { expect((editor() as HTMLTextAreaElement).value).toContain('CC=/usr/bin/gcc-11') })
    fireEvent.change(editor(), { target: { value: '  \n ' } })
    fireEvent.click(screen.getByRole('button', { name: t('setBuildEnvSave') }))
    await waitFor(() => {
      expect(calls.find(call => call.path.endsWith('/dsh-market/build-env'))?.body).toEqual({ buildEnv: {} })
    })
  })

  it('surfaces a refusal instead of pretending the save landed', async () => {
    stubFetch({ buildEnvError: 'PATH is managed by the market' })
    await open()
    await waitFor(() => { expect(screen.getByRole('button', { name: t('setBuildEnvSave') })).toBeTruthy() })
    fireEvent.change(editor(), { target: { value: 'CC=/usr/bin/gcc-11' } })
    fireEvent.click(screen.getByRole('button', { name: t('setBuildEnvSave') }))
    await waitFor(() => { expect(screen.getByText(/PATH is managed by the market/)).toBeTruthy() })
  })
})
