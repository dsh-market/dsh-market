/**
 * Scroll and sticky-header geometry helpers for the Market list.
 */



/**
 * The element that actually scrolls the list.
 *
 * Settings and the sidebar own `.body`. The Plugins page tab is content-sized
 * inside the host's page, so the scroller is the first ancestor with overflow
 * auto or scroll — the same walk the old height measurement used. Themes
 * fullscreen puts the market back in an overlay with `.body` as the scroller
 * again (the CSS already drops the flatten rules), so that path returns body.
 * No host ancestor (jsdom, a host that has not laid out) falls back to the
 * document's scrolling element when there is one.
 */
export function listScroller(
  surface: 'settings' | 'sidebar' | 'plugins',
  root: HTMLElement | null,
  body: HTMLElement | null,
  fullscreen = false,
): HTMLElement | null {
  if (surface !== 'plugins' || fullscreen) return body
  for (let node = root?.parentElement ?? null; node !== null; node = node.parentElement) {
    if (/^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY)) return node
  }
  const scrolling = root?.ownerDocument.scrollingElement
  return scrolling instanceof HTMLElement ? scrolling : null
}

/**
 * How far the host's own stuck chrome already occupies the top of the
 * Plugins page scroller. The market's tab row sticks just below that, so it
 * does not cover 已安装 / 插件市场 / 发现 after the page header compactifies.
 *
 * Only preceding siblings on the path from this panel up to the scroller —
 * the host chrome sits above us. Walking the whole scroller would crawl the
 * catalog on every frame.
 *
 * dsh 0.2.2 keeps the plugin-page header's layout box at its resting height
 * and paints only the compact slice: an absolutely positioned ::before of
 * `--plugin-header-paint-height`, with the title clipped away. The border box
 * still reports the resting height, so sticking under `rect.bottom` parks
 * the market's own rows in that clipped gap and the catalog scrolls through
 * them. The cover is that ::before only when it is the opaque bar: shorter
 * than the box, flush to the top and both sides, and filled. A marker or a
 * strip hung from the bottom keeps the border box. Hosts without one keep
 * the border box.
 */
/**
 * Bottom of a stuck bar's opaque ::before, in the same coordinate space as
 * `rect`, or null when that pseudo-element is not the cover.
 *
 * The 0.2.2 page bar's cover is `inset: 0 0 auto` with the page background,
 * so it starts at the padding edge (no border, no padding-top on that bar)
 * and is shorter than the resting box. A marker, a hairline, or a strip
 * anchored with `bottom` does not qualify — those keep the border box.
 */
function paintedCoverBottom(node: Element, rect: DOMRect): number | null {
  const before = getComputedStyle(node, '::before')
  // `none` / `normal` means there is no cover. `content: ''` (the host's
  // opaque bar) computes to a quoted empty string.
  if (before.content === 'none' || before.content === 'normal') return null
  if (before.position !== 'absolute' && before.position !== 'fixed') return null
  const height = Number.parseFloat(before.height)
  if (!Number.isFinite(height) || height <= 0 || height >= rect.height - 1) return null
  const top = Number.parseFloat(before.top)
  const left = Number.parseFloat(before.left)
  const right = Number.parseFloat(before.right)
  // `top: auto` (a strip hung from the bottom) and a corner mark are not it.
  if (!Number.isFinite(top) || Math.abs(top) > 1) return null
  if (!Number.isFinite(left) || !Number.isFinite(right) || Math.abs(left) > 1 || Math.abs(right) > 1) return null
  if (before.backgroundColor === 'transparent' || before.backgroundColor === 'rgba(0, 0, 0, 0)') return null
  const borderTop = Number.parseFloat(getComputedStyle(node).borderTopWidth)
  const border = Number.isFinite(borderTop) ? borderTop : 0
  return rect.top + border + top + height
}

/**
 * Painted height of a stuck bar that keeps its layout box and clips the rest.
 *
 * dsh 0.2.2's plugin page writes the drawn height onto the bar every frame as
 * an inline `--plugin-header-paint-height` and clips the box with it, so the
 * border box keeps reporting the resting height the bar no longer occupies.
 * Sticking under that number left a bare strip above the market's tab row
 * with cards scrolling through it (#1125). Read the drawn number when the
 * host publishes one; null means the border box is the honest one.
 */
function paintedBarHeight(node: Element, rect: DOMRect): number | null {
  const inline = (node as HTMLElement).style?.getPropertyValue('--plugin-header-paint-height')
  if (inline === undefined || inline.trim() === '') return null
  const value = Number.parseFloat(inline)
  if (!Number.isFinite(value)) return null
  return Math.max(0, Math.min(rect.height, value))
}

export function hostStickyOffset(scroller: HTMLElement, market: HTMLElement): number {
  const scrollerTop = scroller.getBoundingClientRect().top
  let bottom = scrollerTop
  const consider = (node: Element): void => {
    const position = getComputedStyle(node).position
    if (position !== 'sticky' && position !== 'fixed') return
    const rect = node.getBoundingClientRect()
    if (rect.height <= 0 || rect.top > scrollerTop + 4 || rect.bottom <= scrollerTop) return
    const painted = paintedBarHeight(node, rect)
    if (painted !== null) {
      bottom = Math.max(bottom, rect.top + painted)
      return
    }
    bottom = Math.max(bottom, paintedCoverBottom(node, rect) ?? rect.bottom)
  }
  const walkPreceding = (node: Element): void => {
    consider(node)
    for (const child of node.children) walkPreceding(child)
  }
  let node: HTMLElement | null = market
  while (node !== null && node !== scroller) {
    const parent: HTMLElement | null = node.parentElement
    if (parent === null) break
    for (const sibling of parent.children) {
      if (sibling === node) break
      walkPreceding(sibling)
    }
    node = parent
  }
  return Math.max(0, Math.round(bottom - scrollerTop))
}

/** True when `el` is sitting on its sticky line, not still in flow and not scrolled away. */
export function isPinned(scroller: HTMLElement, el: HTMLElement, inset: number): boolean {
  if (scroller.scrollTop <= 0 || el.getBoundingClientRect().height <= 0) return false
  const line = scroller.getBoundingClientRect().top + inset
  const top = el.getBoundingClientRect().top
  return top <= line + 2 && top >= line - 4
}

/**
 * Mirrors "this row is sitting on its sticky line" onto the row itself (#1237).
 *
 * A theme may set `--dsw-alias-bg-base` to a transparent colour so the
 * wallpaper shows through — that is the host's own page-background token, and
 * the market's sticky rows are the only thing between that transparency and
 * the cards scrolling underneath them. Such a theme wants no surface while the
 * row is still in flow and one once it sticks; until now it had no way to tell
 * the two apart except by matching the CSS modules' hashed class names.
 *
 * `data-dshm-stuck` is that state, on a selector that survives the hashes.
 * The market's own stylesheet reads it only to pick `--dshm-stuck-bg`; with
 * that hook unset the surface stays exactly `--dsw-alias-bg-base`, so a host
 * without such a theme is unchanged.
 */
export function markStuck(el: Element | null, pinned: boolean): void {
  if (!(el instanceof HTMLElement)) return
  if (pinned) el.dataset.dshmStuck = 'true'
  else delete el.dataset.dshmStuck
}

/**
 * ScrollTop where the market's tab row first sticks under the host chrome.
 * Unsticks for one measurement so a currently-pinned head still reports its
 * in-flow offset. That is the "top" Plugins back-to-top aims for — tabs stay
 * stuck, the host title does not reopen.
 */
export function headPinScrollTop(scroller: HTMLElement, market: HTMLElement, head: HTMLElement): number {
  const hostTop = hostStickyOffset(scroller, market)
  const prev = head.style.position
  head.style.position = 'static'
  const y = head.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  head.style.position = prev
  return Math.max(0, Math.round(y - hostTop))
}
