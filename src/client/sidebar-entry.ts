/**
 * The market's own row in the sidebar (#846), beside the host's Plugins page.
 *
 * Off by default: the sidebar's global rows are the host's own pages, and
 * installing plugins is occasional, so the row is something a user turns on
 * in the market's settings card. The page entries (Settings, and the host's
 * Plugins tab where it exists) are the defaults; the card refuses to let
 * the last open door close, this row included (#1015).
 *
 * Two facts decide whether the row exists, and they arrive independently:
 * whether the host declares `sidebar.panellist` at all (hosts before the
 * Plugins page moved to the sidebar do not), and what the user chose, which
 * is read from the server. The section gate already owns that ordering
 * problem for the settings entry; this reuses it with the opposite default.
 *
 * Opening the row selects a `main` panel, so the market renders as a page —
 * the only one-click destination the host's public contracts allow. A
 * settings-dialog shortcut is not possible: the dialog's state is private
 * to the host's settings shell.
 */

import { api } from './market-data.ts'
import type { SectionGate } from './section-gate.ts'

/** The `main` key and `sidebar.panellist` id this package registers. */
export const SIDEBAR_PANEL_ID = 'dsh-market'

/**
 * Directly below the host's Plugins row (order 0) and above Scheduled tasks
 * (order 10): the market is where plugins come from, so it sits next to
 * where they are managed.
 */
export const SIDEBAR_PANEL_ORDER = 1

export interface SidebarEntry {
  /** The host declares sidebar panels, so the switch can do something. */
  supported(): boolean
  /** The user's choice as last confirmed by the server. */
  enabled(): boolean
  /**
   * The row is registered right now. Not the same as {@link enabled}: on a
   * host where this row is the only door it is shown before the user has
   * answered, and a deliberate OFF hides it even there (#846).
   */
  shown(): boolean
  /**
   * The initial `load()` finished (ok, refused, or failed). Until then
   * `enabled()` is still the default off, and must not be treated as a
   * confirmed choice — the settings tip would otherwise flash for users
   * who already turned the row on.
   */
  ready(): boolean
  /**
   * True when the host offers NO other entry — no settings section and no
   * Plugins page tab (#1015), so this row is the market's ONLY door. The row
   * is then shown by default — a default that leaves the market unreachable
   * is not a default, it is a missing feature — and the card says so instead
   * of promising a Settings entry that does not exist. On the hosts that
   * ship today the section is always there (dsh 0.2.1 kept it and moved
   * Settings into the account menu), so this stays a guard rather than a
   * branch users see (#846).
   */
  onlyDoor(): boolean
  /**
   * Persist the choice, then show or hide the row.
   * @returns the value the server accepted.
   */
  set(enabled: boolean): Promise<boolean>
  /** Re-render hook for the settings card. */
  subscribe(listener: () => void): () => void
  /** The slot exists: the gate may register now. */
  markSupported(): void
  /** Re-answer "is the row shown" after the host's seat set is known/changed. */
  refresh(): void
  /** Read the saved choice once at page load. */
  load(): Promise<void>
}

interface Deps {
  gate: SectionGate
  fetch: typeof globalThis.fetch
  /**
   * Whether the host offers the market somewhere ELSE — the settings page
   * this package registers as `settings.section`, or the Plugins page tab
   * that arrived with dsh 0.2.1-alpha.4 (#1015). Read live rather than
   * captured, because it is answered by the same slot injection that makes
   * the rest of the client work, and a host may declare it late.
   */
  hasOtherSeat?: () => boolean
}

export function createSidebarEntry({ gate, fetch, hasOtherSeat }: Deps): SidebarEntry {
  // A host that says nothing is assumed to offer the usual settings page; only
  // the one that reports the slot missing changes the default.
  const otherSeat = hasOtherSeat ?? ((): boolean => true)
  let supported = false
  let enabled = false
  let ready = false
  /** The user has ever answered; an absent choice is not an "off". */
  let chosen = false
  /** Bumped by every `set` so a slow initial `load` cannot overwrite it. */
  let epoch = 0
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }

  /**
   * One place that answers "is the row shown": the user's own choice wins;
   * with no choice on record, the row is shown exactly when it is the only
   * way into the market.
   */
  const decide = (): void => {
    if (!supported) return
    gate.setVisible(enabled || (!chosen && !otherSeat()))
    notify()
  }

  const settle = (): void => {
    if (ready) return
    ready = true
    notify()
  }

  return {
    supported: () => supported,
    enabled: () => enabled,
    shown: () => gate.visible(),
    ready: () => ready,
    onlyDoor: () => !otherSeat(),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    markSupported: () => {
      supported = true
      gate.available()
      decide()
    },
    refresh: () => { decide() },
    load: async () => {
      const at = epoch
      try {
        const response = await fetch(api('/dsh-market/sidebar-entry'), { cache: 'no-store' })
        if (response.ok) {
          const body = (await response.json()) as { enabled?: unknown; chosen?: unknown }
          // A POST that finished while we were in flight already owns the row.
          if (at === epoch) {
            enabled = body.enabled === true
            chosen = body.chosen === true
            decide()
          }
        }
      } catch {
        // No answer means no saved choice; whether that leaves the market
        // unreachable is `decide()`'s question, not this one's.
      } finally {
        settle()
      }
    },
    set: async (next) => {
      const at = ++epoch
      const response = await fetch(api('/dsh-market/sidebar-entry'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      let body: { ok?: boolean; enabled?: unknown; error?: string }
      try {
        body = (await response.json()) as { ok?: boolean; enabled?: unknown; error?: string }
      } catch {
        throw new Error(`sidebar entry: HTTP ${response.status}`)
      }
      if (body.ok !== true || typeof body.enabled !== 'boolean') {
        throw new Error(body.error ?? `sidebar entry: HTTP ${response.status}`)
      }
      // A newer set() started after we did — let that one paint.
      if (at === epoch) {
        enabled = body.enabled
        chosen = true
        decide()
      }
      // A choice the user just made is as settled as a finished load.
      settle()
      return body.enabled
    },
  }
}
