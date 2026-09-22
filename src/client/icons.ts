/**
 * Host ui-primitives icons the market renders.
 *
 * Host 0.1.7-alpha.1 renamed size-suffixed icons (…14 / …16) to weight names
 * (…Regular / …Medium) and dropped the old exports with no alias (#671). The
 * primitives module is host-injected, so this file picks whichever spelling
 * the running host still has — newer first — and keeps the market's call
 * sites on one stable name.
 */
import type { ComponentType, ReactElement } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

export interface IconProps {
  size?: number
  className?: string
}

type IconComponent = ComponentType<IconProps>

/**
 * Each entry: the name this package imports, then the 0.1.7+ export, then the
 * pre-0.1.7 export. 14 → Regular, 16 → Medium (measured on the official
 * tarballs for #671).
 */
export const ICON_ALIASES = [
  ['IconCheckOutline16', 'IconCheckOutlineMedium', 'IconCheckOutline16'],
  ['IconChevronDownOutline14', 'IconChevronDownOutlineRegular', 'IconChevronDownOutline14'],
  ['IconChevronLeftOutline14', 'IconChevronLeftOutlineRegular', 'IconChevronLeftOutline14'],
  ['IconChevronRightOutline14', 'IconChevronRightOutlineRegular', 'IconChevronRightOutline14'],
  ['IconChevronUpOutline14', 'IconChevronUpOutlineRegular', 'IconChevronUpOutline14'],
  ['IconCodeOutline16', 'IconCodeOutlineMedium', 'IconCodeOutline16'],
  ['IconCordisPluginOutline14', 'IconCordisPluginOutlineRegular', 'IconCordisPluginOutline14'],
  ['IconDownloadOutline16', 'IconDownloadOutlineMedium', 'IconDownloadOutline16'],
  ['IconFolderOpen16', 'IconFolderOpenMedium', 'IconFolderOpen16'],
  ['IconFullscreenOutline16', 'IconFullscreenOutlineMedium', 'IconFullscreenOutline16'],
  ['IconLinkOutline14', 'IconLinkOutlineRegular', 'IconLinkOutline14'],
  ['IconLoadingOutline16', 'IconLoadingOutlineMedium', 'IconLoadingOutline16'],
  ['IconQuestionOutline14', 'IconQuestionOutlineRegular', 'IconQuestionOutline14'],
  ['IconRefreshOutline14', 'IconRefreshOutlineRegular', 'IconRefreshOutline14'],
  ['IconSearchOutline16', 'IconSearchOutlineMedium', 'IconSearchOutline16'],
  ['IconSparkle16', 'IconSparkleMedium', 'IconSparkle16'],
  ['IconWarningOutline16', 'IconWarningOutlineMedium', 'IconWarningOutline16'],
] as const

export type MarketIconName = (typeof ICON_ALIASES)[number][0]

/**
 * True for a value React will accept as an element type. Plain functions are
 * the common case today; memo / forwardRef wrappers are objects tagged with
 * $$typeof and must not be treated as "missing" (#671 follow-up).
 */
export function isIconComponent(value: unknown): value is IconComponent {
  if (typeof value === 'function') return true
  if (typeof value !== 'object' || value === null) return false
  return typeof (value as { $$typeof?: unknown }).$$typeof === 'symbol'
}

/** Resolve one icon from a primitives-shaped module; null when both names are absent. */
export function resolveIcon(
  mod: Record<string, unknown>,
  newer: string,
  older: string,
): IconComponent | null {
  const candidate = mod[newer] ?? mod[older]
  return isIconComponent(candidate) ? candidate : null
}

/**
 * Names for which neither the 0.1.7 nor the pre-0.1.7 export exists on the
 * injected module. Used by apply() so a half-renamed host disables the
 * market instead of rendering `undefined` (React #130).
 */
export function missingIcons(mod: Record<string, unknown>): string[] {
  const gaps: string[] = []
  for (const [stable, newer, older] of ICON_ALIASES) {
    if (resolveIcon(mod, newer, older) === null) gaps.push(stable)
  }
  return gaps
}

function pickIcon(newer: string, older: string): IconComponent {
  const resolved = resolveIcon(primitives as unknown as Record<string, unknown>, newer, older)
  // apply() refuses to register when any icon is missing; a throw here is
  // only reachable if a call site bypasses that guard.
  if (resolved === null) {
    const missing = (): ReactElement => {
      throw new Error(`[dsh-market] host ui-primitives missing ${newer} / ${older}`)
    }
    return missing as unknown as IconComponent
  }
  return resolved
}

export const IconCheckOutline16 = pickIcon('IconCheckOutlineMedium', 'IconCheckOutline16')
export const IconChevronDownOutline14 = pickIcon('IconChevronDownOutlineRegular', 'IconChevronDownOutline14')
export const IconChevronLeftOutline14 = pickIcon('IconChevronLeftOutlineRegular', 'IconChevronLeftOutline14')
export const IconChevronRightOutline14 = pickIcon('IconChevronRightOutlineRegular', 'IconChevronRightOutline14')
export const IconChevronUpOutline14 = pickIcon('IconChevronUpOutlineRegular', 'IconChevronUpOutline14')
export const IconCodeOutline16 = pickIcon('IconCodeOutlineMedium', 'IconCodeOutline16')
export const IconCordisPluginOutline14 = pickIcon('IconCordisPluginOutlineRegular', 'IconCordisPluginOutline14')
export const IconDownloadOutline16 = pickIcon('IconDownloadOutlineMedium', 'IconDownloadOutline16')
export const IconFolderOpen16 = pickIcon('IconFolderOpenMedium', 'IconFolderOpen16')
export const IconFullscreenOutline16 = pickIcon('IconFullscreenOutlineMedium', 'IconFullscreenOutline16')
export const IconLinkOutline14 = pickIcon('IconLinkOutlineRegular', 'IconLinkOutline14')
export const IconLoadingOutline16 = pickIcon('IconLoadingOutlineMedium', 'IconLoadingOutline16')
export const IconQuestionOutline14 = pickIcon('IconQuestionOutlineRegular', 'IconQuestionOutline14')
export const IconRefreshOutline14 = pickIcon('IconRefreshOutlineRegular', 'IconRefreshOutline14')
export const IconSearchOutline16 = pickIcon('IconSearchOutlineMedium', 'IconSearchOutline16')
export const IconSparkle16 = pickIcon('IconSparkleMedium', 'IconSparkle16')
export const IconWarningOutline16 = pickIcon('IconWarningOutlineMedium', 'IconWarningOutline16')
