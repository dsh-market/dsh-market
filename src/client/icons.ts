/**
 * Product icons, resolved by name instead of imported by name.
 *
 * The host injects `@deepseek-ai/dsh-client-ui-primitives` and the browser
 * bundle keeps it external (see tsdown.config.ts CLIENT_EXTERNALS), so a
 * static `import { IconX } from …` is bound to whatever the *running* host
 * happens to export. DSH 0.1.7-alpha.1 made those names size-neutral and
 * weight-suffixed — `IconChevronDownOutline14` became
 * `IconChevronDownOutlineRegular` (1px) and `…Medium` (1.3px) — and dropped
 * the size-suffixed names outright. Every icon this plugin imported then
 * resolved to `undefined`, so the first `<Icon…>` in the tree threw React
 * #130 ("Element type is invalid … but got: undefined"), which the market's
 * error boundary could only turn into a blank section (#670).
 *
 * Importing the new names statically would fix that host and break every
 * other one: `latest` is still 0.1.5-rc.2, which exports only the old names.
 * So resolve per glyph at call time — size-neutral host name first, pre-0.1.7
 * name second, and an empty glyph when a host has neither. A missing icon is
 * a cosmetic gap; it must never be able to blank the market again.
 *
 * Weight: `Regular` is the artwork the host itself renders for these glyphs
 * and what this plugin has always drawn; `Medium` is the host's emphasized
 * 1.3px variant, kept for call sites that want emphasis later.
 */
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactElement } from 'react'

export type { IconProps }

/** One resolved glyph: the host's component, or the empty fallback below. */
type IconComponent = (props: IconProps) => ReactElement | null

const hostTable = primitives as unknown as Record<string, unknown>

/** Rendered when a host exports neither name — see the module comment. */
function renderNothing(): null {
  return null
}

/**
 * Read one name out of the host table.
 *
 * A module namespace that does not carry the name may answer with `undefined`
 * or may refuse the lookup outright (a strict namespace proxy does), and the
 * lookup itself must never be the thing that throws: that is the whole point
 * of this module.
 * @param name - export name to read.
 * @returns whatever the host exposes under it, if anything.
 */
function fromHost(name: string): unknown {
  try {
    return hostTable[name]
  } catch {
    return undefined
  }
}

/**
 * Resolve one glyph from the host's frozen module table.
 * @param name - size-neutral host name, e.g. `IconChevronDownOutlineRegular`.
 * @param legacyName - pre-0.1.7 name, e.g. `IconChevronDownOutline14`.
 * @returns the host component, or a glyph that renders nothing.
 */
function resolveIcon(name: string, legacyName: string): IconComponent {
  const found = fromHost(name) ?? fromHost(legacyName)
  return typeof found === 'function' ? (found as IconComponent) : renderNothing
}

export const IconChevronDown = resolveIcon('IconChevronDownOutlineRegular', 'IconChevronDownOutline14')
export const IconChevronUp = resolveIcon('IconChevronUpOutlineRegular', 'IconChevronUpOutline14')
export const IconChevronLeft = resolveIcon('IconChevronLeftOutlineRegular', 'IconChevronLeftOutline14')
export const IconChevronRight = resolveIcon('IconChevronRightOutlineRegular', 'IconChevronRightOutline14')
export const IconCheck = resolveIcon('IconCheckOutlineRegular', 'IconCheckOutline16')
export const IconClose = resolveIcon('IconCloseOutlineRegular', 'IconCloseOutline16')
export const IconSearch = resolveIcon('IconSearchOutlineRegular', 'IconSearchOutline16')
export const IconRefresh = resolveIcon('IconRefreshOutlineRegular', 'IconRefreshOutline14')
export const IconWarning = resolveIcon('IconWarningOutlineRegular', 'IconWarningOutline16')
export const IconQuestion = resolveIcon('IconQuestionOutlineRegular', 'IconQuestionOutline14')
export const IconSparkle = resolveIcon('IconSparkleRegular', 'IconSparkle16')
export const IconCode = resolveIcon('IconCodeOutlineRegular', 'IconCodeOutline16')
export const IconCordisPlugin = resolveIcon('IconCordisPluginOutlineRegular', 'IconCordisPluginOutline14')
export const IconLoading = resolveIcon('IconLoadingOutlineRegular', 'IconLoadingOutline16')
export const IconLink = resolveIcon('IconLinkOutlineRegular', 'IconLinkOutline14')
export const IconDownload = resolveIcon('IconDownloadOutlineRegular', 'IconDownloadOutline16')
export const IconFullscreen = resolveIcon('IconFullscreenOutlineRegular', 'IconFullscreenOutline16')
export const IconFolderOpen = resolveIcon('IconFolderOpenRegular', 'IconFolderOpen16')
