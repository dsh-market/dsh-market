/**
 * The market's block mark in the settings navigation.
 *
 * The settings shell picks nav glyphs from a closed list of section ids
 * (`models`, `agent-presets`, `plugins`) and falls back to its own gear for
 * every other id; `settings.section` projects only `id` / `order` / `label`,
 * so a registrant has no icon to pass — the slot contract in
 * `@deepseek-ai/dsh-client-ui-settings` and the runtime slot inventory both
 * list exactly those three options. Every third-party section therefore wears
 * the gear, the market included.
 *
 * So the market claims its own row once the dialog is mounted and swaps the
 * fallback gear for the block mark — the same mark `MarketLogo` draws inside
 * the section (see market-mark.ts), which is what makes the nav entry read as
 * the same thing as the page it opens. `dsh-better-sidebar` and
 * `dsh-skill-mcp-panel` solve it the same way.
 *
 * Scope, deliberately narrow:
 *
 * - only the row whose visible text equals this plugin's own localized
 *   section label is marked; no shell structure is touched;
 * - the marker and the injected stylesheet belong to a `ctx.effect`, so they
 *   are removed with the fiber;
 * - a locale switch re-claims the row through the MutationObserver, so the
 *   label and the glyph never disagree.
 *
 * Delete this module (and its call in index.ts) the day `settings.section`
 * grows an `icon` field.
 */
import {
  MARK_BLOCK_RADIUS,
  MARK_BLOCK_SIZE,
  MARK_GRID_BLOCKS,
  MARK_PLUG_BLOCK,
  MARK_VIEW_BOX,
} from './market-mark.ts'

/** Marks the one nav row this plugin owns. */
export const NAV_ICON_MARKER = 'data-dsh-market-nav-icon'

/**
 * The nav rows of the settings dialog. The shell renders each
 * `settings.section` entry as a `<button>` inside the panel's `<nav>`
 * (SettingsPanel in dsh-client-ui-settings-general).
 */
export const NAV_ROW_SELECTOR = '[role="dialog"] nav button'

/**
 * Glyph box in px. The shell renders every nav icon at this size and ships no
 * media query at all; the only thing that ever shrinks those icons is another
 * plugin's mobile stylesheet, which is not this module's business to
 * second-guess. So there is deliberately no narrow variant here.
 */
export const NAV_ICON_SIZE = 16

/**
 * The mark as standalone SVG for a CSS `mask-image`.
 *
 * Painted pure black on purpose: a mask reads alpha only, and the visible
 * colour comes from the element's `background-color: currentColor`. The
 * plug block carries its tilt without the animated variant's transform
 * classes — a mask cannot animate through CSS-module classes.
 */
export function marketMaskSvg(): string {
  const blocks = MARK_GRID_BLOCKS
    .map(block => `<rect x="${block.x}" y="${block.y}" width="${MARK_BLOCK_SIZE}" height="${MARK_BLOCK_SIZE}" rx="${MARK_BLOCK_RADIUS}"/>`)
    .join('')
  const plug = MARK_PLUG_BLOCK
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '
    + `${MARK_VIEW_BOX} ${MARK_VIEW_BOX}" fill="#000">`
    + `<g>${blocks}</g>`
    + `<rect x="${plug.x}" y="${plug.y}" width="${MARK_BLOCK_SIZE}" height="${MARK_BLOCK_SIZE}"`
    + ` rx="${MARK_BLOCK_RADIUS}" transform="rotate(${plug.degrees} ${plug.originX} ${plug.originY})"/>`
    + '</svg>'
}

/** The mask URL for the mark (encoded at runtime, never hand-escaped). */
export function marketMaskUrl(svg: string = marketMaskSvg()): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/**
 * Whether a nav row is this plugin's own.
 *
 * Pure, and the only decision this feature makes: the row whose visible text
 * is the section label the shell is currently projecting. An empty label
 * matches nothing — a locale that has not resolved yet must not mark the
 * whole nav.
 */
export function isOwnNavRow(rowText: string | null | undefined, wantedLabel: string | null | undefined): boolean {
  const wanted = String(wantedLabel ?? '').trim()
  if (wanted.length === 0) return false
  return String(rowText ?? '').trim() === wanted
}

/** Stylesheet for the marked row: hide the shell's gear, draw the mark. */
export function navIconCss(maskUrl: string): string {
  return [
    `[${NAV_ICON_MARKER}] > svg { display: none; }`,
    `[${NAV_ICON_MARKER}]::before {`,
    `  content: '';`,
    `  flex: none;`,
    `  width: ${NAV_ICON_SIZE}px;`,
    `  height: ${NAV_ICON_SIZE}px;`,
    `  background-color: currentColor;`,
    `  -webkit-mask-image: url("${maskUrl}");`,
    `  mask-image: url("${maskUrl}");`,
    `  -webkit-mask-repeat: no-repeat;`,
    `  mask-repeat: no-repeat;`,
    `  -webkit-mask-position: center;`,
    `  mask-position: center;`,
    `  -webkit-mask-size: ${NAV_ICON_SIZE}px ${NAV_ICON_SIZE}px;`,
    `  mask-size: ${NAV_ICON_SIZE}px ${NAV_ICON_SIZE}px;`,
    `}`,
  ].join('\n')
}

/** The slice of the client context this feature needs (matches index.ts's
 * structural MarketClientContext, so no monorepo-internal types are pulled in). */
export interface NavIconContext {
  effect(callback: () => unknown, label?: string): void
}

/**
 * Install the nav glyph.
 *
 * @param ctx - client context, for effect ownership.
 * @param resolveLabel - this plugin's current section label (the same thunk
 *   the `settings.section` registration passes), re-read on every sync so a
 *   locale switch is picked up without re-registering.
 */
export function installSettingsNavIcon(ctx: NavIconContext, resolveLabel: () => string): void {
  if (typeof document === 'undefined') return

  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dshmarket'
    tag.dataset.pluginCss = 'dshmarket/settings-nav-icon'
    tag.textContent = navIconCss(marketMaskUrl())
    document.head.appendChild(tag)

    let disposed = false
    let scheduled = false

    const sync = () => {
      scheduled = false
      if (disposed) return
      const wanted = resolveLabel()
      for (const row of document.querySelectorAll(NAV_ROW_SELECTOR)) {
        if (isOwnNavRow(row.textContent, wanted)) row.setAttribute(NAV_ICON_MARKER, '')
        else row.removeAttribute(NAV_ICON_MARKER)
      }
    }

    // Coalesce a burst of DOM mutations into one sync, and land it before the
    // next paint so the row never shows the gear first.
    const schedule = () => {
      if (scheduled || disposed) return
      scheduled = true
      queueMicrotask(sync)
    }

    sync()
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })

    return () => {
      disposed = true
      observer.disconnect()
      for (const row of document.querySelectorAll(`[${NAV_ICON_MARKER}]`)) row.removeAttribute(NAV_ICON_MARKER)
      tag.remove()
    }
  }, 'dsh-market: settings nav icon')
}
