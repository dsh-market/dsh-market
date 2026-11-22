/**
 * Host ui-primitives the market uses WHEN THE RUNNING HOST HAS THEM.
 *
 * The primitives module is injected by the host, so the set of components
 * available at render time is whatever that host ships — 0.1.0-rc.7 has 25
 * export groups, 0.1.7-rc.2 has 51. A component the host has should be used
 * rather than re-implemented: the market sits inside the host's settings page,
 * and a hand-rolled lookalike drifts from it the moment either side changes.
 *
 * Anything resolved here MUST have a fallback at its call site, and the
 * fallback is the market's own markup — that is the whole difference between
 * this and `REQUIRED_PRIMITIVES` (src/client/index.ts), which decides whether
 * the market can render at all. Same rule as the icon aliases
 * (src/client/icons.ts): a host that predates a component costs that one
 * component's upgrade, never the page.
 *
 * `null` means "this host does not have it", which is the ordinary case on the
 * 0.1.x hosts the market still supports — so a call site that forgets its
 * fallback fails loudly in tests (which run against an old host's 0.1.0-rc.7)
 * rather than silently in production.
 */
import type { ReactNode } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

/** The palette `Tag` accepts (0.1.7-rc.2+). */
export type TagTone = 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'

export type TagComponent = (props: { tone?: TagTone; className?: string; children?: ReactNode }) => ReactNode

function optionalComponent<T>(name: string): T | null {
  let value: unknown
  try {
    value = (primitives as unknown as Record<string, unknown>)[name]
  } catch {
    // A module shim can be a strict proxy that THROWS on an unknown export
    // rather than answering undefined (vitest's own module mock does exactly
    // that). "The host does not have this component" and "asking threw" are
    // the same answer here, and the call site's fallback is the right response
    // to both.
    return null
  }
  // React components are functions, or objects tagged with $$typeof (memo /
  // forwardRef wrappers). Anything else — undefined on an older host, a string
  // from a bad shim — is not a component and must not be rendered as one.
  if (typeof value === 'function') return value as T
  if (value !== null && typeof value === 'object' && '$$typeof' in (value as object)) return value as T
  return null
}

/**
 * `Tag` — the host's read-only chip, for facts with no status meaning
 * (capabilities, categories). Null on hosts older than 0.1.7-rc.2.
 */
export const HostTag: TagComponent | null = optionalComponent<TagComponent>('Tag')

/**
 * `Switch` — the host's on/off control, the one its own plugin list uses.
 * Null before 0.1.7-rc.2, where the market renders its own switch (same
 * `role="switch"` contract, the market's styling).
 */
export type SwitchComponent = (props: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  title?: string
  className?: string
}) => ReactNode

export const HostSwitch: SwitchComponent | null = optionalComponent<SwitchComponent>('Switch')

/**
 * `Checkbox` — the host's labelled checkbox. Null before 0.1.7-rc.2.
 *
 * It takes a STRING label, which is what limits its use here: the market's
 * checkboxes that carry rich label content (the export rows: name, spec kind,
 * resolved spec) or no visible label at all (the recovery panel's) stay native
 * markup — routing those through this would either lose the row's content or
 * duplicate it.
 */
export type CheckboxComponent = (props: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  title?: string
  className?: string
}) => ReactNode

export const HostCheckbox: CheckboxComponent | null = optionalComponent<CheckboxComponent>('Checkbox')

/**
 * The host's menu row with an icon and a two-line label (dsh 0.2.2+), used in
 * the Plugins page's "Add plugin" menu. Older hosts have neither the menu slot
 * nor this component; the caller falls back to a plain menu button.
 */
export type MenuItemButtonComponent = (props: { icon?: ReactNode; disabled?: boolean; onSelect?: () => void; children?: ReactNode }) => ReactNode
export const HostMenuItemButton: MenuItemButtonComponent | null = optionalComponent<MenuItemButtonComponent>('MenuItemButton')
