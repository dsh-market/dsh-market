/**
 * The market's panel, as an element, built from explicit dependencies.
 *
 * Two callers want the same thing and must not drift apart:
 *
 * - the `settings.section` this package registers, whose slot passes down a
 *   host-chosen `preferredSubsectionId`;
 * - `market.render()`, for a host shell that renders the market inside its
 *   own container (#602, from the Tauri desktop).
 *
 * A module function taking its dependencies rather than a closure over the
 * cordis context, so the wiring — which locale, which theme, which log
 * exporter reaches the panel — is something a test can assert instead of
 * something only a running host can reveal.
 */

import { createElement as h } from 'react'
import { MarketErrorBoundary } from './ErrorBoundary.tsx'
import { MarketSection } from './MarketSection.tsx'
import type { MarketSectionProps } from './MarketSection.tsx'
import type { Translate } from './market-data.ts'
import type { SidebarEntry } from './sidebar-entry.ts'

/** Everything the panel needs from the client context, plus its own actions. */
export interface MarketElementProps {
  t: Translate
  locale: MarketSectionProps['locale']
  theme: MarketSectionProps['theme']
  themeStore: MarketSectionProps['themeStore']
  /** The error boundary's own copy; passed in so this file holds none. */
  crashText: { title: string; hint: string; reload: string; details: string }
  /** Export the log from the recovery panel — the button that must survive a crash. */
  exportLog: () => void
  /** Host-provided destination, when the caller has one. */
  preferredSubsectionId?: string
  /** The opt-in sidebar row. Absent, the panel offers no shortcut tip. */
  sidebar?: SidebarEntry
  /**
   * Where this panel is mounted. Only the settings page offers the sidebar
   * shortcut; the sidebar page must not offer itself, and the Plugins page's
   * tab is already one click from 已安装 — no shortcut needed there either.
   * The Plugins tab also has no height of its own (the host page scrolls),
   * which `MarketSection` measures for.
   */
  surface?: 'settings' | 'sidebar' | 'plugins'
}

/**
 * @param props - see {@link MarketElementProps}.
 * @returns the panel wrapped in its error boundary.
 */
export function marketElement(props: MarketElementProps): unknown {
  return h(MarketErrorBoundary, {
    // Wrapped HERE rather than at each call site, so the boundary is outside
    // everything the panel renders — including its portalled layers — for
    // every caller. A crash used to unmount the whole tree and leave an
    // empty settings panel with no export-log button, which is how #293 went
    // months without a usable report.
    text: props.crashText,
    actions: h('button', {
      type: 'button',
      onClick: () => { props.exportLog() },
    }, props.t('exportLog')),
  }, h(MarketSection, {
    t: props.t,
    locale: props.locale,
    theme: props.theme,
    themeStore: props.themeStore,
    preferredSubsectionId: props.preferredSubsectionId,
    sidebar: props.sidebar,
    surface: props.surface,
  }))
}
