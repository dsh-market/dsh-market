/**
 * The market's page-level entrances and whether the user keeps them (#1015).
 *
 * Three doors lead into the market: the page in Settings, the tab on the
 * host's Plugins page, and the opt-in sidebar row (#846, sidebar-entry.ts).
 * This module owns the first two and ASKS the sidebar controller whether a
 * third door remains — it does not own that choice.
 *
 * Absent means shown for both of these, unlike the sidebar row: they are the
 * entries every host has always had, and a host before 0.2.1 offers the
 * settings page as its only one. The host decides which slots exist at all
 * (an older dsh never declares `plugins.tab`, and the desktop shell may hide
 * the settings section through #602), so availability is answered live from
 * the slots and the host's service, never inferred from the stored value.
 *
 * ## The last-door rule
 *
 * Any switch that could turn a door off asks {@link EntryVisibility.otherDoorOpen}
 * first. The server enforces the same rule on the three stored answers, but
 * it cannot see which slots THIS host declares — on a host with no Plugins
 * tab, hiding the settings page while the row is off would leave no entry at
 * all, and the server would happily store it. So the browser answers for the
 * host's half, and the server answers for the saved half.
 */

import { api } from './market-data.ts'
import type { SectionGate } from './section-gate.ts'

/** The two doors this module owns. The sidebar is the third, asked separately. */
export type EntryKey = 'settingsSection' | 'pluginsTab'

export interface EntryVisibility {
  /** The user's saved answer; true unless they turned the door off. */
  settingsSection(): boolean
  pluginsTab(): boolean
  /** The host declares the settings slot at all. */
  settingsSupported(): boolean
  /**
   * The settings door can be USED: the slot exists and the host itself has
   * not hidden it (#602). A preference for a door the host keeps shut is
   * kept but cannot be offered as a working switch.
   */
  settingsAvailable(): boolean
  /** The host declares the Plugins page tab slot. */
  pluginsTabSupported(): boolean
  /** The settings section is registered right now. */
  settingsVisible(): boolean
  /**
   * The host's own preference (#602), ANDed with the user's rather than
   * replacing it: a host that renders the market itself must not get the
   * duplicate entry back because a user flipped a switch.
   */
  setHostSettingsVisible(visible: boolean): void
  /** Called when the host declares the slot; safe before or after load(). */
  markSettingsSection(): void
  markPluginsTab(): void
  /** Whether at least one door OTHER than `key` would stay open. */
  otherDoorOpen(key: EntryKey | 'sidebar'): boolean
  /** Read (or re-read) the saved answers, e.g. before closing a door. */
  load(): Promise<void>
  /**
   * Persist one answer, then show or hide the door.
   * @returns the value the server accepted.
   */
  set(key: EntryKey, visible: boolean): Promise<boolean>
  /** Re-render hook for the settings card. */
  subscribe(listener: () => void): () => void
  /** The package is being removed: never register again. */
  retire(): void
}

interface Deps {
  /** The settings section gate, created by the caller with its register(). */
  settingsGate: SectionGate
  /** The Plugins page tab gate, same shape. */
  pluginsTabGate: SectionGate
  fetch: typeof globalThis.fetch
  /** The host declares sidebar panels (#846). */
  sidebarSupported: () => boolean
  /**
   * The row is visible right now, not just the saved choice: on a host
   * where it is the only door it is shown before anyone answers (#846).
   */
  sidebarShown: () => boolean
}

export function createEntryVisibility({ settingsGate, pluginsTabGate, fetch, sidebarSupported, sidebarShown }: Deps): EntryVisibility {
  let settingsSeat = false
  let pluginsTabSeat = false
  let hostSettings = true
  let settingsSection = true
  let pluginsTab = true
  /** Bumped by every `set` so a slow initial `load` cannot overwrite it. */
  let epoch = 0
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }

  const apply = (): void => {
    settingsGate.setVisible(hostSettings && settingsSection)
    pluginsTabGate.setVisible(pluginsTab)
  }

  /**
   * "Is this door open?" is a question about what the UI shows, so it
   * combines the host's declaration, the host's own preference, and the
   * user's answer. The sidebar's two facts arrive through callbacks because
   * that controller keeps its own state.
   */
  const settingsOpen = (): boolean => settingsSeat && hostSettings && settingsSection
  const pluginsOpen = (): boolean => pluginsTabSeat && pluginsTab
  const sidebarOpen = (): boolean => sidebarSupported() && sidebarShown()
  const otherDoorOpen = (key: EntryKey | 'sidebar'): boolean =>
    (key !== 'settingsSection' && settingsOpen())
    || (key !== 'pluginsTab' && pluginsOpen())
    || (key !== 'sidebar' && sidebarOpen())

  const loadState = async (): Promise<void> => {
    const at = epoch
    try {
      const response = await fetch(api('/dsh-market/entry-visibility'), { cache: 'no-store' })
      if (response.ok) {
        const body = (await response.json()) as { settingsSection?: unknown; pluginsTab?: unknown }
        // A POST that finished while we were in flight already owns these.
        if (at === epoch) {
          if (typeof body.settingsSection === 'boolean') settingsSection = body.settingsSection
          if (typeof body.pluginsTab === 'boolean') pluginsTab = body.pluginsTab
          apply()
        }
      }
    } catch {
      // No answer means the defaults (or the last known answers) stand.
    } finally {
      notify()
    }
  }

  /**
   * `set` is serialized because two saves in flight at once each answer the
   * last-door rule from the state before the other one landed. The second
   * save would then be judged against a world that no longer exists — or be
   * discarded by the epoch guard after the server accepted it.
   */
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  const save = async (key: EntryKey, visible: boolean): Promise<boolean> => {
    // Any save invalidates an in-flight load: from here on, the answers this
    // save reads and writes are the ones that count.
    const at = ++epoch
    if (!visible) {
      // Another tab may have closed a door since this card loaded. The
      // invariant is about the SAVED answers, so answer it from the server
      // rather than from this tab's snapshot.
      await loadState()
      if (!otherDoorOpen(key)) {
        throw new Error('at least one market entry must stay visible')
      }
    }
    try {
      const response = await fetch(api('/dsh-market/entry-visibility'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [key]: visible }),
      })
      let body: { ok?: boolean; settingsSection?: unknown; pluginsTab?: unknown; error?: string }
      try {
        body = (await response.json()) as { ok?: boolean; settingsSection?: unknown; pluginsTab?: unknown; error?: string }
      } catch {
        throw new Error(`entry visibility: HTTP ${response.status}`)
      }
      if (body.ok !== true || typeof body.settingsSection !== 'boolean' || typeof body.pluginsTab !== 'boolean') {
        throw new Error(body.error ?? `entry visibility: HTTP ${response.status}`)
      }
      // A newer set() started after we did — let that one paint.
      if (at === epoch) {
        settingsSection = body.settingsSection
        pluginsTab = body.pluginsTab
        apply()
        notify()
      }
      return key === 'settingsSection' ? body.settingsSection : body.pluginsTab
    } catch (error) {
      // A refusal means this card and the server disagree (another tab, an
      // older bundle). Re-read so the switches show what is actually saved.
      await loadState()
      throw error
    }
  }

  return {
    settingsSection: () => settingsSection,
    pluginsTab: () => pluginsTab,
    settingsSupported: () => settingsSeat,
    settingsAvailable: () => settingsSeat && hostSettings,
    pluginsTabSupported: () => pluginsTabSeat,
    settingsVisible: () => settingsGate.visible(),
    setHostSettingsVisible: (visible) => {
      hostSettings = visible
      apply()
      notify()
    },
    markSettingsSection: () => {
      settingsSeat = true
      // Apply before available(): a saved OFF that arrived first must not
      // be overridden by the gate's shown-by-default initial answer.
      apply()
      settingsGate.available()
      notify()
    },
    markPluginsTab: () => {
      pluginsTabSeat = true
      apply()
      pluginsTabGate.available()
      notify()
    },
    otherDoorOpen,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    load: loadState,
    set: (key, visible) => serialize(() => save(key, visible)),
    retire: () => {
      settingsGate.retire()
      pluginsTabGate.retire()
      notify()
    },
  }
}
