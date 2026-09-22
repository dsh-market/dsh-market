/**
 * Ambient types for @deepseek-ai/dsh-client-ui-primitives — provided at
 * runtime by the host's frozen platform module table
 * (packages/client/web/src/platform.ts). The published npm package is only a
 * dev-time mirror used by the jsdom test lane, so the browser bundle stays
 * external (see tsdown.config.ts CLIENT_EXTERNALS); keep these signatures in
 * sync with deepseek-harness/packages/client/ui-primitives/src/ @0.1.0-rc.6.
 * Only the members this plugin uses are declared.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode } from 'react'

  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'
  export function Button(props: {
    variant?: ButtonVariant
    size?: 'md' | 'sm'
    icon?: ReactNode
    className?: string | undefined
    children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>): ReactElement

  export function Pill(props: {
    active?: boolean
    className?: string | undefined
    children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>): ReactElement

  export function Input(props: {
    icon?: ReactNode
    className?: string
  } & InputHTMLAttributes<HTMLInputElement>): ReactElement

  export function Modal(props: {
    open: boolean
    onClose: () => void
    title: string
    closeLabel?: string
    description?: string
    children?: ReactNode
    footer?: ReactNode
    className?: string
    contentClassName?: string
    headless?: boolean
  }): ReactElement | null

  export function Toast(props: {
    text: string
    icon?: ReactNode
    anchor?: HTMLElement | null
    onDone: () => void
  }): ReactElement

  /** One primary-menu entry: a row, a separator, or a heading label. */
  export interface MenuItem {
    id: string
    label: ReactNode
    disabled?: boolean
    icon?: ReactNode
    danger?: boolean
    submenu?: readonly MenuItem[]
  }
  export interface MenuSeparator { type: 'separator'; id: string }
  export interface MenuLabel { type: 'label'; id: string; text: string }
  export type MenuEntry = MenuItem | MenuSeparator | MenuLabel

  export function Menu(props: {
    open: boolean
    anchor: ReactNode
    items: readonly MenuEntry[]
    footer?: readonly MenuEntry[]
    selectedId?: string | undefined
    selectedIds?: readonly string[] | undefined
    onSelect: (id: string) => void
    onClose: () => void
    align?: 'start' | 'end'
    side?: 'bottom' | 'top' | 'right'
    portal?: boolean
    closeOnPointerLeave?: boolean
    dense?: boolean
    compact?: boolean
    className?: string
  }): ReactElement

  export interface DisclosureRowProps {
    icon: ReactNode
    title: string
    open: boolean
    expandable: boolean
    onToggle: () => void
    expandOnRowClick?: boolean | undefined
    previewChevron?: boolean | undefined
    keepContentWhenOpen?: boolean | undefined
    collapsedContent?: ReactNode
    children?: ReactNode
    className?: string | undefined
    rowClassName?: string | undefined
    leadingClassName?: string | undefined
    chevronClassName?: string | undefined
    titleClassName?: string | undefined
  }
  export function DisclosureRow(props: DisclosureRowProps): ReactElement

  export function Tooltip(props: {
    label: string | (() => string)
    side?: 'right' | 'bottom' | 'top'
    delayMs?: number
    disabled?: boolean
    maxWidth?: number
    children: ReactElement
  }): ReactElement

  /**
   * Shape every product glyph takes. Icon *components* are deliberately not
   * declared here: their names are what moved between host versions (the
   * 0.1.7-alpha.1 rename dropped the size-suffixed exports this plugin used),
   * so src/client/icons.ts resolves them from the host table by name at
   * runtime and needs only this props shape.
   */
  export interface IconProps {
    size?: number
    className?: string
  }

  export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error'
  export function StateDot(props: {
    state: StateDotState
    size?: number | undefined
    className?: string | undefined
  }): ReactElement
}
