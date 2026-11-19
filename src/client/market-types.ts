/**
 * Shared types for the Market section: its props, the notices and the reply shapes.
 */

import type { MarketLocaleStore, RegistryPlugin, ThemeSnapshot, Translate } from './market-data.ts'
import type { SidebarEntry } from './sidebar-entry.ts'
import type { HostNavigationStore } from './host-navigation.ts'

/**
 * `/dsh-market/dismiss-broken` answers with the whole remaining map, but only
 * `ok` is read: that map is a snapshot from when the request ran, and adopting
 * it would resurrect or drop notices the panel has since settled (#763).
 */
export type DismissBrokenReply = { ok?: unknown; brokenPlugins?: unknown; error?: unknown }

export type FavoriteReply = { ok?: unknown; favorites?: unknown; error?: unknown; code?: unknown; limit?: unknown }

export interface MarketSectionProps {
  t: Translate
  locale: MarketLocaleStore
  theme: { setTheme(id: string): void }
  themeStore: {
    subscribe(callback: () => void): () => void
    getSnapshot(): ThemeSnapshot | null
  }
  /** Optional host-provided destination: `discover:<query>` or `installed:<query>`. */
  preferredSubsectionId?: string
  /** The opt-in sidebar row. Absent, the page offers no shortcut tip. */
  sidebar?: SidebarEntry
  /**
   * The host's `pluginNavigation` (dsh 0.2.1+). Absent, installed plugins
   * offer no link to the host's own page for them.
   */
  hostNavigation?: HostNavigationStore
  /**
   * Which mount this is. Only the settings page may offer the sidebar
   * shortcut; the sidebar page must not ask to open itself, and the Plugins
   * page's tab is already one click from 已安装.
   */
  surface?: 'settings' | 'sidebar' | 'plugins'
}

export interface SourceMigrationConfirm {
  name: string
  source: string
  target: string
  kind: SourceMigrationKind
}

/**
 * The two moves one dialog serves: a Git install switching to the npm
 * package its own repository publishes (#461), and an npm install following a
 * package rename (#1012). Same confirmation, same transaction.
 */
type SourceMigrationKind = 'git-to-npm' | 'npm-rename'

/** A rejected install and the installed plugins it clashed with, one entry
   * per owner as grouped by the host. */
  export interface ConflictNotice {
    plugin: RegistryPlugin
    groups: Array<{ owner: string; ids: string[] }>
  }

export interface CompatibilityNotice {
    code: 'soft-incompatible'
    risks: Array<{ plugin: string; peer: string; range: string; resolved: string; direction: string }>
    /** Cross-layer loader-name collisions this operation introduced (#230). */
    shadowedNames?: Array<{ name: string; layers: string[]; count: number }>
    /** Client bundles that no longer parse after the operation (#222). */
    brokenBundles?: Array<{ name: string; reason: string }>
    rollbackId?: string
    rollbackUnavailable?: string
  }
