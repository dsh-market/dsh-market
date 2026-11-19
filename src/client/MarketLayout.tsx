/**
 * Layout primitives: masonry, card description clamp, window-titlebar measuring, the screenshot lightbox and the body-portal host.
 */

import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import { githubRouteCandidates, masonryColumnCount, rememberGithubRoute, type Translate } from './market-data.ts'
import css from './Market.module.css'
import {
  IconChevronDownOutline14,
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconChevronUpOutline14,
} from './icons.ts'
import { useAutoCarousel } from './MarketImages.tsx'

/**
 * Masonry columns holding items in their input order.
 *
 * Items are dealt alternately (0,2,4… left; 1,3,5… right) rather than split
 * down the middle, so the sort order still reads left-to-right then down —
 * the ranking is the whole point of the sort menu above it. Each column is
 * its own flex stack, so a tall item only pushes down the items beneath IT
 * instead of leaving a hole beside its shorter neighbour.
 *
 * Below the two-up breakpoint the CSS collapses to one column, and dealing
 * alternately would then interleave the list wrongly — so at one column the
 * items stay in a single stack in their original order.
 *
 * Two columns at the settings dialog's width; the sidebar page is wider and
 * gets a third once each column still has room for a full card.
 */
export function Masonry<T>({ items, render, maxColumns = 3, minColumns = 2, className }: {
  items: T[]
  render: (item: T) => ReactNode
  maxColumns?: number
  /** Discover keeps its two-column floor; Installed may collapse to one. */
  minColumns?: number
  className?: string
}) {
  const wide = useMediaWide()
  const ref = useRef<HTMLDivElement>(null)
  const [columns, setColumns] = useState(2)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setColumns(masonryColumnCount(entry.contentRect.width, maxColumns, 290, minColumns))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [wide, maxColumns, minColumns])
  const masonryClass = [css.masonry, className].filter(Boolean).join(' ')
  if (!wide) {
    return <div className={masonryClass}><div className={css.masonryCol}>{items.map(render)}</div></div>
  }
  const buckets: T[][] = Array.from({ length: columns }, () => [])
  items.forEach((item, index) => { buckets[index % columns]!.push(item) })
  return (
    <div ref={ref} className={masonryClass}>
      {buckets.map((bucket, index) => (
        <div key={index} className={css.masonryCol}>{bucket.map(render)}</div>
      ))}
    </div>
  )
}

/**
 * Whether the layout is at its two-up width. Matches the CSS breakpoint
 * exactly: the column split is decided in JS but rendered by CSS, and the
 * two disagreeing would deal cards into columns the stylesheet has already
 * stacked.
 */
function useMediaWide(): boolean {
  const query = '(min-width: 681px)'
  const subscribe = useCallback((notify: () => void) => {
    if (typeof matchMedia !== 'function') return () => {}
    const list = matchMedia(query)
    list.addEventListener('change', notify)
    return () => list.removeEventListener('change', notify)
  }, [])
  return useSyncExternalStore(
    subscribe,
    () => (typeof matchMedia === 'function' ? matchMedia(query).matches : true),
    // Server/jsdom without matchMedia: assume the two-up layout, which is
    // what the stylesheet defaults to before any media query applies.
    () => true,
  )
}

/**
 * A card's description, clamped to 5 lines so one wordy entry doesn't blow
 * the two-up grid's row height out for whatever sits beside it — the grid
 * already tolerates SOME height variance by design (`.card`'s `align-self:
 * start`), just not an unbounded one. The toggle only renders when the text
 * actually overflows the clamp: a two-line description has nothing to
 * "expand", so no button beats a button that does nothing.
 */
export function CardDesc({ text, t, lines = 5, className, textClassName }: {
  text: string
  t: Translate
  lines?: 3 | 5
  className?: string
  textClassName?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)
  const base = textClassName === undefined ? css.desc : `${css.desc} ${textClassName}`
  const clamp = lines === 3 ? css.descClamp3 : css.descClamp
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    // Measured while clamped only: expanded, scrollHeight equals clientHeight
    // and would hide the button that collapses it again.
    const measure = () => {
      if (!el.classList.contains(clamp)) return
      setCanExpand(el.scrollHeight > el.clientHeight + 1)
    }
    measure()
    // A column width change re-wraps the text, so the answer can flip.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text, clamp])
  return (
    <div className={className}>
      <div ref={ref} className={expanded ? base : `${base} ${clamp}`}>{text}</div>
      {canExpand && lines === 3 && (
        <button type="button" className={css.descMore} onClick={() => setExpanded(e => !e)}>
          {expanded ? t('descCollapse') : t('descMore')}
          {expanded ? <IconChevronUpOutline14 size={12} /> : <IconChevronRightOutline14 size={12} />}
        </button>
      )}
      {canExpand && lines === 5 && (
        <button
          type="button"
          className={css.descToggle}
          aria-label={expanded ? t('descCollapse') : t('descExpand')}
          onClick={() => setExpanded(e => !e)}
        >
          {expanded ? <IconChevronUpOutline14 size={14} /> : <IconChevronDownOutline14 size={14} />}
        </button>
      )}
    </div>
  )
}

type WindowControlsOverlayApi = {
  visible?: boolean
  getTitlebarAreaRect: () => { height: number }
  addEventListener?: (type: 'geometrychange', listener: EventListener) => void
  removeEventListener?: (type: 'geometrychange', listener: EventListener) => void
}

/**
 * Native window controls can own the top band even though DOM hit-testing
 * still reports the page element underneath. The official Windows desktop
 * shell has been observed with a 42px band while the lightbox close button
 * starts at 16px (#384), leaving only its bottom edge clickable.
 *
 * Read the shell's geometry instead of hard-coding a desktop height: titlebar
 * overlays differ between shells, and ordinary browsers have no such API.
 */
function useWindowTitlebarHeight(): number {
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    if (typeof navigator === 'undefined') return
    const overlay = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayApi }).windowControlsOverlay
    if (overlay?.getTitlebarAreaRect === undefined) return

    const sync = () => {
      try {
        if (overlay.visible === false) {
          setHeight(0)
          return
        }
        const next = overlay.getTitlebarAreaRect().height
        setHeight(Number.isFinite(next) && next > 0 ? next : 0)
      } catch {
        setHeight(0)
      }
    }
    sync()
    overlay.addEventListener?.('geometrychange', sync)
    return () => overlay.removeEventListener?.('geometrychange', sync)
  }, [])
  return height
}

/**
 * Full-bleed image preview, opened from a card thumbnail or a dialog's
 * screenshot strip. Not the shared Modal primitive: Modal is chrome for a
 * decision (title, description, footer actions); this is just the same
 * already-downloaded image shown bigger — there is no separate "thumbnail"
 * vs "full size" asset to fetch.
 */
/**
 * The full-size screenshot, loaded through the configured GitHub route (#1070).
 *
 * Screenshots are GitHub-hosted, and on a mainland connection
 * `raw.githubusercontent.com` is the slowest part of the page — the avatars
 * next to them already go through the proxy the user chose, while this one
 * still went direct. The thumbnail keeps its own resizer; this is the one
 * place that wants the original bytes, so it is the one place the proxy
 * itself is worth a hop.
 *
 * The route order is the same one avatars use: the prefix that last worked
 * first, then the region's other prefixes, then direct. A failed load walks
 * the list rather than leaving a blank image.
 */
function LightboxImage({ src, className, onClick }: {
  src: string
  className: string
  onClick: (event: ReactMouseEvent<HTMLImageElement>) => void
}) {
  const [routeIndex, setRouteIndex] = useState(0)
  useEffect(() => { setRouteIndex(0) }, [src])
  const candidates = githubRouteCandidates('raw', src)
  const candidate = candidates[Math.min(routeIndex, candidates.length - 1)]!
  return (
    <img
      className={className}
      src={candidate.url}
      alt=""
      onClick={onClick}
      onLoad={() => rememberGithubRoute('raw', candidate.proxy)}
      onError={() => { if (routeIndex + 1 < candidates.length) setRouteIndex(current => current + 1) }}
    />
  )
}

export function ScreenshotLightbox({ shots, startIndex, onClose, t }: { shots: string[]; startIndex: number; onClose: () => void; t: Translate }) {
  // Full-bleed previews must not auto-advance: a chart or a screenshot needs
  // to stay readable until the viewer moves on, so the carousel timer is
  // disabled with intervalMs = 0. Arrows, dots, and the keyboard still
  // navigate manually.
  const [index, setIndex] = useAutoCarousel(shots.length, startIndex, 0)
  const titlebarHeight = useWindowTitlebarHeight()
  const host = useMarketPortalHost()
  useEffect(() => {
    // Capture phase + stopPropagation: the Settings dialog underneath is a
    // Modal with its own Escape-to-close handling, also on window/document.
    // Without this, one Escape press closed both layers at once — verified
    // on a real host — because the modal's bubble-phase listener still fired
    // after this one. Capture runs first and this stops it from reaching
    // bubble phase at all, so only the top layer responds to one press.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      else if (e.key === 'ArrowLeft') { e.stopPropagation(); setIndex(index - 1) }
      else if (e.key === 'ArrowRight') { e.stopPropagation(); setIndex(index + 1) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index])
  // Into a container this package owns, never into document.body itself.
  //
  // In-tree rendering is not an option: the primitives' own Modal (the
  // settings dialog underneath) portals itself to document.body, so the
  // lightbox rendered in place sat BEHIND it whatever the z-index — a portal
  // only wins a stacking tie against another portal by mounting later.
  // Reported on a real host: "大的预览图层级不对，现在在弹窗的后面".
  //
  // But sharing document.body with the host was the other half of a trap.
  // The host's settings dialog and this package are separate React roots,
  // and two roots appending and removing children of the SAME container
  // interleave in an order neither one models. The host's root then calls
  // removeChild for a node this one had already moved, React throws
  // `NotFoundError: The node to be removed is not a child of this node`, the
  // `settings.section` slot catches it, and the whole market panel goes
  // blank (#293 by @Tianhao-1017, #286, #241 — the reporter of #293 traced
  // this to the line, with the stack and a clean-reinstall check).
  //
  // Owning one container fixes that structurally: the host's root sees a
  // single opaque child it never touches, and everything this package
  // mounts or unmounts happens inside it.
  return createPortal(
    <div className={css.lightbox} onClick={onClose}>
      {/* A literal "×" rather than IconCloseOutline16: the primitives
          package's own Modal uses that icon at runtime, but this package
          version's public type surface doesn't resolve it — `tsc` reports
          "no exported member" even though icons/index.d.ts declares it.
          Not worth a type-check suppression for one close glyph. */}
      <button
        className={css.lightboxClose}
        style={titlebarHeight > 0 ? { top: titlebarHeight + 16 } : undefined}
        aria-label={t('lightboxClose')}
        onClick={onClose}
      >×</button>
      <LightboxImage
        className={css.lightboxImg}
        src={shots[index]!}
        onClick={e => e.stopPropagation()}
      />
      {shots.length > 1 && (
        <>
          <button
            className={`${css.lightboxNav} ${css.lightboxPrev}`}
            aria-label={t('lightboxPrev')}
            onClick={(e) => { e.stopPropagation(); setIndex(index - 1) }}
          ><IconChevronLeftOutline14 size={18} /></button>
          <button
            className={`${css.lightboxNav} ${css.lightboxNext}`}
            aria-label={t('lightboxNext')}
            onClick={(e) => { e.stopPropagation(); setIndex(index + 1) }}
          ><IconChevronRightOutline14 size={18} /></button>
          <div className={css.lightboxDots} onClick={e => e.stopPropagation()}>
            {shots.map((src, i) => (
              <span
                key={src}
                className={i === index ? `${css.lightboxDot} ${css.lightboxDotOn}` : css.lightboxDot}
                onClick={() => setIndex(i)}
              />
            ))}
          </div>
        </>
      )}
    </div>,
    host,
  )
}

/**
 * The one DOM node this package portals into, created on first use and kept
 * for the life of the page.
 *
 * Created imperatively rather than rendered, and never removed: the point is
 * that `document.body`'s child list stops being shared state between two
 * React roots. A container that came and went would put the same churn back
 * into body, just less often — and "less often" is what made this bug
 * intermittent and hard to believe in the first place.
 *
 * Re-appended on every open so it stays last among body's children. That is
 * what keeps the lightbox above the host's own portalled dialog, which is
 * why the portal exists at all; moving a node we own is not something the
 * host's root tracks, so it cannot disturb it.
 */
let portalHost: HTMLElement | null = null

function marketPortalHost(): HTMLElement {
  if (portalHost === null) {
    portalHost = document.createElement('div')
    // Named so anyone inspecting the DOM, or a future host wanting to give
    // plugins a real portal slot, can see who owns it.
    portalHost.setAttribute('data-dsh-market-portal', '')
    // Dialogs, the lightbox and every other layer render THROUGH this host,
    // outside the root above — so it needs the same exemption, or a
    // translated dialog crashes React exactly like a translated page (#293).
    portalHost.setAttribute('translate', 'no')
    portalHost.classList.add('notranslate')
  }
  return portalHost
}

/**
 * Move the container to the end of `document.body`, which is what keeps this
 * package's layers above the host's own portalled dialog.
 *
 * In a layout effect, NOT during render. `createPortal` needs the element
 * while rendering, but appending it does not belong there: React may start a
 * render, abandon it and start again, so a mutation in the render body runs
 * for passes that never commit — and this particular mutation reorders
 * `document.body`, the one container this package shares with the host's
 * separate React root. That is the same shared-child-list hazard #293 was
 * about, just arrived at from the other side. Committing it in an effect
 * means it happens once, after React is done, in the order React expects.
 */
function useMarketPortalHost(): HTMLElement {
  const host = marketPortalHost()
  useLayoutEffect(() => {
    // appendChild on an existing child MOVES it to the end — the stacking
    // guarantee, refreshed on open without ever creating a second container.
    document.body.appendChild(host)
  }, [host])
  return host
}

/** Test hook: the container is module state and outlives a component unmount. */
export function resetMarketPortalHost(): void {
  portalHost?.remove()
  portalHost = null
}
