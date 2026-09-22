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

/** Resolve one icon from a primitives-shaped module; null when both names are absent. */
export function resolveIcon(
  mod: Record<string, unknown>,
  newer: string,
  older: string,
): IconComponent | null {
  const candidate = mod[newer] ?? mod[older]
  return typeof candidate === 'function' ? (candidate as IconComponent) : null
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

function pick(newer: string, older: string): IconComponent {
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

export const IconCheckOutline16 = pick('IconCheckOutlineMedium', 'IconCheckOutline16')
export const IconChevronDownOutline14 = pick('IconChevronDownOutlineRegular', 'IconChevronDownOutline14')
export const IconChevronLeftOutline14 = pick('IconChevronLeftOutlineRegular', 'IconChevronLeftOutline14')
export const IconChevronRightOutline14 = pick('IconChevronRightOutlineRegular', 'IconChevronRightOutline14')
export const IconChevronUpOutline14 = pick('IconChevronUpOutlineRegular', 'IconChevronUpOutline14')
export const IconCodeOutline16 = pick('IconCodeOutlineMedium', 'IconCodeOutline16')
export const IconCordisPluginOutline14 = pick('IconCordisPluginOutlineRegular', 'IconCordisPluginOutline14')
export const IconDownloadOutline16 = pick('IconDownloadOutlineMedium', 'IconDownloadOutline16')
export const IconFolderOpen16 = pick('IconFolderOpenMedium', 'IconFolderOpen16')
export const IconFullscreenOutline16 = pick('IconFullscreenOutlineMedium', 'IconFullscreenOutline16')
export const IconLinkOutline14 = pick('IconLinkOutlineRegular', 'IconLinkOutline14')
export const IconLoadingOutline16 = pick('IconLoadingOutlineMedium', 'IconLoadingOutline16')
export const IconQuestionOutline14 = pick('IconQuestionOutlineRegular', 'IconQuestionOutline14')
export const IconRefreshOutline14 = pick('IconRefreshOutlineRegular', 'IconRefreshOutline14')
export const IconSearchOutline16 = pick('IconSearchOutlineMedium', 'IconSearchOutline16')
export const IconSparkle16 = pick('IconSparkleMedium', 'IconSparkle16')
export const IconWarningOutline16 = pick('IconWarningOutlineMedium', 'IconWarningOutline16')
