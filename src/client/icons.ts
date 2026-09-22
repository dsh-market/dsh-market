/**
 * Host ui-primitives icons the market renders.
 *
 * Host 0.1.7-alpha.1 renamed size-suffixed icons (…14 / …16) to weight names
 * (…Regular / …Medium) and dropped the old exports with no alias
 * (#670/#671/#673). The primitives module is host-injected, so this file
 * picks whichever spelling the running host still has — newer first — and
 * keeps the market's call sites on one stable name.
 *
 * Weight is always `Regular` (product default stroke). `Medium` is the
 * emphasized 1.3px variant and is not what these call sites mean. Pixel size
 * is a separate `size` prop on every call site; the old suffix was never a
 * substitute for that prop on 0.1.7+.
 *
 * A missing glyph must not blank the market (React #130). Resolve to an empty
 * component and warn — a later host rename then costs one icon, not the page.
 */
import type { ComponentType } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

export interface IconProps {
  size?: number
  className?: string
}

type IconComponent = ComponentType<IconProps>

/**
 * Each entry: the name this package imports, then the 0.1.7+ Regular export,
 * then the pre-0.1.7 size-suffixed export.
 */
export const ICON_ALIASES = [
  ['IconCheckOutline16', 'IconCheckOutlineRegular', 'IconCheckOutline16'],
  ['IconChevronDownOutline14', 'IconChevronDownOutlineRegular', 'IconChevronDownOutline14'],
  ['IconChevronLeftOutline14', 'IconChevronLeftOutlineRegular', 'IconChevronLeftOutline14'],
  ['IconChevronRightOutline14', 'IconChevronRightOutlineRegular', 'IconChevronRightOutline14'],
  ['IconChevronUpOutline14', 'IconChevronUpOutlineRegular', 'IconChevronUpOutline14'],
  ['IconCodeOutline16', 'IconCodeOutlineRegular', 'IconCodeOutline16'],
  ['IconCordisPluginOutline14', 'IconCordisPluginOutlineRegular', 'IconCordisPluginOutline14'],
  ['IconDownloadOutline16', 'IconDownloadOutlineRegular', 'IconDownloadOutline16'],
  ['IconFolderOpen16', 'IconFolderOpenRegular', 'IconFolderOpen16'],
  ['IconFullscreenOutline16', 'IconFullscreenOutlineRegular', 'IconFullscreenOutline16'],
  ['IconLinkOutline14', 'IconLinkOutlineRegular', 'IconLinkOutline14'],
  ['IconLoadingOutline16', 'IconLoadingOutlineRegular', 'IconLoadingOutline16'],
  ['IconQuestionOutline14', 'IconQuestionOutlineRegular', 'IconQuestionOutline14'],
  ['IconRefreshOutline14', 'IconRefreshOutlineRegular', 'IconRefreshOutline14'],
  ['IconSearchOutline16', 'IconSearchOutlineRegular', 'IconSearchOutline16'],
  ['IconSparkle16', 'IconSparkleRegular', 'IconSparkle16'],
  ['IconWarningOutline16', 'IconWarningOutlineRegular', 'IconWarningOutline16'],
] as const

export type MarketIconName = (typeof ICON_ALIASES)[number][0]

/**
 * True for a value React will accept as an element type. Plain functions are
 * the common case today; memo / forwardRef wrappers are objects tagged with
 * $$typeof and must not be treated as "missing".
 */
export function isIconComponent(value: unknown): value is IconComponent {
  if (typeof value === 'function') return true
  if (typeof value !== 'object' || value === null) return false
  return typeof (value as { $$typeof?: unknown }).$$typeof === 'symbol'
}

/**
 * Read one name out of a primitives-shaped table. A strict namespace proxy may
 * throw on unknown keys; that must not be what blanks the market.
 */
export function fromHost(mod: Record<string, unknown>, name: string): unknown {
  try {
    return mod[name]
  } catch {
    return undefined
  }
}

/** Resolve one icon from a primitives-shaped module; null when both names are absent. */
export function resolveIcon(
  mod: Record<string, unknown>,
  newer: string,
  older: string,
): IconComponent | null {
  const candidate = fromHost(mod, newer) ?? fromHost(mod, older)
  return isIconComponent(candidate) ? candidate : null
}

/**
 * Names for which neither the 0.1.7 nor the pre-0.1.7 export exists.
 * Informational — apply() does not disable the market for these; pickIcon
 * renders nothing instead so a rename costs one glyph, not the page.
 */
export function missingIcons(mod: Record<string, unknown>): string[] {
  const gaps: string[] = []
  for (const [stable, newer, older] of ICON_ALIASES) {
    if (resolveIcon(mod, newer, older) === null) gaps.push(stable)
  }
  return gaps
}

/** Rendered when a host exports neither spelling — see the module comment. */
function renderNothing(): null {
  return null
}

function pickIcon(newer: string, older: string): IconComponent {
  const resolved = resolveIcon(primitives as unknown as Record<string, unknown>, newer, older)
  if (resolved === null) {
    console.warn(`[dsh-market] host ui-primitives missing ${newer} / ${older} — icon skipped`)
    return renderNothing as unknown as IconComponent
  }
  return resolved
}

export const IconCheckOutline16 = pickIcon('IconCheckOutlineRegular', 'IconCheckOutline16')
export const IconChevronDownOutline14 = pickIcon('IconChevronDownOutlineRegular', 'IconChevronDownOutline14')
export const IconChevronLeftOutline14 = pickIcon('IconChevronLeftOutlineRegular', 'IconChevronLeftOutline14')
export const IconChevronRightOutline14 = pickIcon('IconChevronRightOutlineRegular', 'IconChevronRightOutline14')
export const IconChevronUpOutline14 = pickIcon('IconChevronUpOutlineRegular', 'IconChevronUpOutline14')
export const IconCodeOutline16 = pickIcon('IconCodeOutlineRegular', 'IconCodeOutline16')
export const IconCordisPluginOutline14 = pickIcon('IconCordisPluginOutlineRegular', 'IconCordisPluginOutline14')
export const IconDownloadOutline16 = pickIcon('IconDownloadOutlineRegular', 'IconDownloadOutline16')
export const IconFolderOpen16 = pickIcon('IconFolderOpenRegular', 'IconFolderOpen16')
export const IconFullscreenOutline16 = pickIcon('IconFullscreenOutlineRegular', 'IconFullscreenOutline16')
export const IconLinkOutline14 = pickIcon('IconLinkOutlineRegular', 'IconLinkOutline14')
export const IconLoadingOutline16 = pickIcon('IconLoadingOutlineRegular', 'IconLoadingOutline16')
export const IconQuestionOutline14 = pickIcon('IconQuestionOutlineRegular', 'IconQuestionOutline14')
export const IconRefreshOutline14 = pickIcon('IconRefreshOutlineRegular', 'IconRefreshOutline14')
export const IconSearchOutline16 = pickIcon('IconSearchOutlineRegular', 'IconSearchOutline16')
export const IconSparkle16 = pickIcon('IconSparkleRegular', 'IconSparkle16')
export const IconWarningOutline16 = pickIcon('IconWarningOutlineRegular', 'IconWarningOutline16')
