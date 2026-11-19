/**
 * Images and previews: the github-routed <img>, owner avatars, screenshot strips and the measured theme-cover previews.
 */

import { useEffect, useState } from 'react'
import {
  avatarColor,
  githubRouteCandidates,
  pluginName,
  pluginScreenshotCandidates,
  pluginScreenshots,
  previewDimensionScore,
  rankThemeScreenshots,
  type RegistryPlugin,
  rememberGithubRoute,
  resetScreenshotsCache,
  safeIcon,
  safeScreenshots,
  type ScreenshotCandidate,
  type ScreenshotMeasurement,
  type Translate,
} from './market-data.ts'
import css from './Market.module.css'
import { DiscoveryScan } from './discovery-scan.ts'
import { IconLoadingOutline16, IconSearchOutline16, IconSparkle16 } from './icons.ts'

/**
 * Release-body markdown, reduced to what a reading dialog needs: headings,
 * bullets, quotes, fenced code, paragraphs, bold, inline code, https links,
 * and allowlisted https images. HTML from the repo is stripped first (never
 * interpreted as markup); remaining text arrives as React children or
 * controlled nodes only.
 */

/**
 * An <img> whose src lives on raw.githubusercontent.com, walked through the
 * raw GitHub route candidates on failure (#1070 follow-up): the update-notes
 * dialog was the last place still loading those images directly, so on
 * networks where raw is unreachable the notes rendered with holes. When every
 * candidate fails the last one is the direct URL, exactly the old behavior.
 */
export function GithubRoutedImg({ src, alt, className, key }: { src: string; alt: string; className?: string; key?: string }) {
  const [routeIndex, setRouteIndex] = useState(0)
  const candidates = githubRouteCandidates('raw', src)
  const candidate = candidates[Math.min(routeIndex, candidates.length - 1)]!
  return (
    <img
      key={key}
      className={className}
      src={candidate.url}
      alt={alt}
      loading="lazy"
      onLoad={() => rememberGithubRoute('raw', candidate.proxy)}
      onError={() => { if (routeIndex + 1 < candidates.length) setRouteIndex(routeIndex + 1) }}
    />
  )
}

export function OwnerAvatar({ name, owner, icon, className }: { name: string; owner: string; icon?: string | null; className?: string }) {
  const [failed, setFailed] = useState(false)
  const [routeIndex, setRouteIndex] = useState(0)
  const [iconFailed, setIconFailed] = useState(false)
  const [iconRouteIndex, setIconRouteIndex] = useState(0)
  const av = className === undefined ? css.av : `${css.av} ${className}`
  const tile = iconFailed ? null : safeIcon(icon)
  if (tile !== null) {
    // A declared icon is almost always a raw.githubusercontent.com URL, so it
    // goes through the raw route candidates the lightbox uses (#1070) instead
    // of a direct connection: on networks where raw is unreachable the icon
    // would fail on first request and silently degrade to the owner's avatar
    // (#1078). Candidates are walked on error, like the avatar branch below.
    const candidates = githubRouteCandidates('raw', tile)
    const candidate = candidates[Math.min(iconRouteIndex, candidates.length - 1)]!
    return (
      <img
        className={av}
        src={candidate.url}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => rememberGithubRoute('raw', candidate.proxy)}
        onError={() => {
          if (iconRouteIndex + 1 < candidates.length) setIconRouteIndex(iconRouteIndex + 1)
          else setIconFailed(true)
        }}
      />
    )
  }
  if (failed || owner === '') {
    return (
      <div className={av} style={{ background: avatarColor(name) }}>
        {name.replace(/^dsh[-_]/i, '').charAt(0).toUpperCase() || 'P'}
      </div>
    )
  }
  const candidates = githubRouteCandidates(
    'avatar',
    `https://avatars.githubusercontent.com/${encodeURIComponent(owner)}?size=96`,
  )
  const candidate = candidates[Math.min(routeIndex, candidates.length - 1)]!
  return (
    <img
      className={av}
      src={candidate.url}
      alt=""
      loading="lazy"
      onLoad={() => rememberGithubRoute('avatar', candidate.proxy)}
      onError={() => {
        if (routeIndex + 1 < candidates.length) setRouteIndex(routeIndex + 1)
        else setFailed(true)
      }}
    />
  )
}

/**
 * AppStore-style screenshot strip in the install detail dialog (#61).
 * Curated registry screenshots win; otherwise images are extracted from the
 * repo README. Requests start only once the dialog opens; failures — no
 * README, no images, broken links — degrade to rendering nothing at all.
 */
export function ScreenshotStrip({ plugin, onOpen }: { plugin: RegistryPlugin; onOpen: (shots: string[], index: number) => void }) {
  const [shots, setShots] = useState<string[]>([])
  const [broken, setBroken] = useState<string[]>([])
  useEffect(() => {
    let live = true
    setShots([])
    setBroken([])
    pluginScreenshots(plugin).then((list) => { if (live) setShots(list) })
    return () => { live = false }
  }, [plugin])
  const visible = shots.filter(src => !broken.includes(src))
  if (visible.length === 0) return null
  return (
    <div className={css.shots}>
      {visible.map((src, i) => (
        <img
          key={src}
          className={css.shot}
          src={thumbUrl(src, 300)}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onClick={() => onOpen(visible, i)}
          onError={() => setBroken(prev => prev.includes(src) ? prev : prev.concat(src))}
        />
      ))}
    </div>
  )
}

/**
 * Advances an index every `intervalMs` while `count > 1` — the shared clock
 * behind both a card's auto-cycling thumbnail and the lightbox. A manual
 * jump (clicking a dot, an arrow, opening on a specific shot) restarts the
 * clock instead of letting it fire again moments later: without that, a
 * deliberate "go back one" reads as broken when it auto-advances right past
 * where the user just navigated to.
 *
 * `intervalMs <= 0` disables the timer entirely (no auto-advance at all);
 * manual jumps still work. The lightbox uses this: a full-bleed image needs
 * to stay put until the viewer moves on, so it must never page itself.
 */
export function useAutoCarousel(count: number, initial: number, intervalMs = 3500): [number, (i: number) => void] {
  const [index, setIndexState] = useState(initial)
  const [resetTick, setResetTick] = useState(0)
  useEffect(() => {
    if (count <= 1 || intervalMs <= 0) return
    const timer = setInterval(() => { setIndexState(i => (i + 1) % count) }, intervalMs)
    return () => clearInterval(timer)
  }, [count, intervalMs, resetTick])
  const setIndex = (i: number): void => {
    if (count <= 0) return
    setIndexState(((i % count) + count) % count)
    setResetTick(t => t + 1)
  }
  return [index, setIndex]
}

/**
 * A card thumbnail (or dialog strip image) renders at well under 150px on
 * screen; the curated screenshot behind it can be a full-resolution PNG
 * several hundred KB to a few MB — GitHub's own hosts offer no resized
 * variant, so rendering the original meant downloading full-size images for
 * a strip nobody asked to see full-size. images.weserv.nl resizes
 * server-side (by decoded HEIGHT, `fit=inside` so it never crops, `we=1` so
 * it never upscales something already smaller) before the bytes reach the
 * browser. The lightbox — an explicit "show me this big" — still requests
 * the ORIGINAL directly: proxying that one too would add a hop with nothing
 * left to save, and once the thumbnail is genuinely smaller it can no longer
 * share a cache entry with the full-size open anyway.
 */
function thumbUrl(src: string, height: number, options: { webp?: boolean } = {}): string {
  // The resizer stays in every region, including China.
  //
  // It was briefly bypassed there on the assumption that a service in the
  // Netherlands would be one more far-away host in the way. Measured from an
  // unproxied mainland connection, that was wrong twice over: weserv answers
  // in 1.39s, and it answers with 23KB where the original is 41KB. Routing
  // around it would have traded a working request for a bigger one, on a
  // page that makes dozens of them.
  const encoded = encodeURIComponent(src.replace(/^https?:\/\//, ''))
  let url = `https://images.weserv.nl/?url=${encoded}&h=${String(height)}&fit=inside&we=1`
  // Theme covers ask for webp on still photos: a 520px PNG of a UI
  // screenshot still weighed 0.4–0.6 MB (#1060). Only png/jpeg/webp URLs
  // opt in; extension-less GitHub attachments stay resized-only.
  if (options.webp === true && /\.(?:png|jpe?g|webp)(?:$|[?#])/iu.test(src)) url += '&output=webp'
  // An animated GIF would otherwise come back as a single still frame: the
  // resize drops every frame past the first, so a curated animated cover sat
  // frozen on the card and in the strip. `n=-1` asks for every frame and
  // `output=webp` re-encodes the animation far smaller than the original
  // (a 7s 600×420 demo: 283KB → 31KB at h=200), so it keeps moving without
  // costing more than a still would.
  //
  // `n=-1` decodes every frame, which is what the resizer's input limits
  // measure: past 71 000 000 decoded pixels or 400 frames it answers 404 and
  // the card would show a broken image where it used to show a frozen one.
  // That is 15 of the catalog's 71 GIF covers. `errorredirect` sends the
  // browser to the same resize WITHOUT `n=-1` in exactly that case, so the
  // fallback is today's behaviour — a still, the right size, and visible.
  else if (/\.gif(?:$|[?#])/iu.test(src)) {
    const still = `${url}&output=webp`
    url = `${url}&n=-1&output=webp&errorredirect=${encodeURIComponent(still)}`
  }
  return url
}

/**
 * True once the wrapped element has scrolled within `rootMargin` of the
 * viewport. Falls back to true immediately where IntersectionObserver is
 * unavailable (old browsers, jsdom without a stub) — a missing observer
 * should degrade to eager loading, not a permanently empty thumbnail.
 * Native `img loading="lazy"` already defers the network fetch on its own,
 * but its trigger distance isn't ours to tune, and scrolling a 400+ entry
 * catalog queues every off-screen card's request the instant the browser
 * decides to start prefetching — this hook is what lets CardShot not even
 * SET `src` until a card is actually close.
 */
function useNearViewport<T extends Element>(rootMargin = '200px'): [(node: T | null) => void, boolean] {
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined')
  const [node, setNode] = useState<T | null>(null)
  useEffect(() => {
    if (near || node === null) return
    const obs = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) setNear(true)
    }, { rootMargin })
    obs.observe(node)
    return () => obs.disconnect()
  }, [near, node, rootMargin])
  return [setNode, near]
}

/**
 * A card's own thumbnail strip — curated screenshots only (#61 supplement):
 * this data already rode along with the catalog fetch that drew the grid,
 * so showing it costs nothing extra. README-scraped fallback images stay
 * dialog-only, where fetching one repo's README on click is a single
 * request instead of one per visible card.
 *
 * Horizontal scroll at each image's own aspect ratio, not an auto-cycling
 * single crop: cropping every shot into one fixed box hid most of a tall
 * screenshot, and cycling on a timer meant the card you were looking at
 * kept changing under you. Scrolling is a gesture the user drives.
 */
/** Thumbnails per card. The dialog shows every screenshot; a grid of cards
 * pulling six full-size PNGs each is what makes the first paint crawl. */
const CARD_SHOT_LIMIT = 3
/**
 * Theme gallery is 4-up (16:10 tile ≈ 150px tall in a typical panel). 320px
 * is ~2× that; 520 was a near-full-bleed PNG and still hundreds of KB (#1060).
 */
const THEME_COVER_HEIGHT = 320
/** About half a cover row — off-screen theme cards must not prefetch. */
const THEME_COVER_ROOT_MARGIN = '80px'
/** First-pass geometry probes for a README fallback. If none of these
 * pass as a cover, the remaining candidates (still capped at six) are
 * measured too — otherwise a later landscape is dropped before ranking. */
const THEME_PREVIEW_PROBE_LIMIT = 3

export function CardShot({ plugin, onOpen }: { plugin: RegistryPlugin; onOpen: (shots: string[], index: number) => void }) {
  const shots = safeScreenshots(plugin.screenshots)
  const [broken, setBroken] = useState<string[]>([])
  const visible = shots.filter(src => !broken.includes(src)).slice(0, CARD_SHOT_LIMIT)
  const [setStripRef, near] = useNearViewport<HTMLDivElement>()
  if (visible.length === 0) return null
  return (
    <div ref={setStripRef} className={css.cardShots}>
      {visible.map((src, i) => (
        <img
          key={src}
          className={css.cardShot}
          src={near ? thumbUrl(src, 200) : undefined}
          alt=""
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          referrerPolicy="no-referrer"
          onClick={(e) => { e.stopPropagation(); onOpen(visible, i) }}
          onError={() => setBroken(prev => prev.includes(src) ? prev : prev.concat(src))}
        />
      ))}
    </div>
  )
}

/**
 * Read dimensions through the same low-resolution, no-upscale route used by
 * card thumbnails. Large originals therefore stay off the wire, while a
 * genuinely tiny image remains tiny and can be rejected by the scorer.
 */
function measureThemeCandidates(candidates: ScreenshotCandidate[]): Promise<ScreenshotMeasurement[]> {
  if (typeof Image === 'undefined') return Promise.resolve([])
  const measureBatch = (batch: ScreenshotCandidate[]): Promise<ScreenshotMeasurement[]> =>
    Promise.all(batch.map(candidate => new Promise<ScreenshotMeasurement | null>((resolve) => {
      const probe = new Image()
      let settled = false
      const finish = (measurement: ScreenshotMeasurement | null) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        probe.onload = null
        probe.onerror = null
        resolve(measurement)
      }
      const timer = window.setTimeout(() => finish(null), 6_000)
      probe.onload = () => finish({ src: candidate.src, width: probe.naturalWidth, height: probe.naturalHeight })
      probe.onerror = () => finish(null)
      probe.referrerPolicy = 'no-referrer'
      probe.decoding = 'async'
      probe.src = thumbUrl(candidate.src, 240)
    }))).then(results => results.filter((result): result is ScreenshotMeasurement => result !== null))
  return measureBatch(candidates.slice(0, THEME_PREVIEW_PROBE_LIMIT)).then(first => {
    if (first.some(item => previewDimensionScore(item.width, item.height) !== null)
      || candidates.length <= THEME_PREVIEW_PROBE_LIMIT) return first
    return measureBatch(candidates.slice(THEME_PREVIEW_PROBE_LIMIT)).then(rest => first.concat(rest))
  })
}

const measuredThemePreviewTasks = new Map<string, Promise<string[]>>()
const measuredThemePreviewResults = new Map<string, string[]>()

/** Clear measured theme media at the boundary of an accepted catalog generation. */
export function resetThemePreviewCache(): void {
  measuredThemePreviewTasks.clear()
  measuredThemePreviewResults.clear()
}

export const discoveryScan = new DiscoveryScan(() => {
  resetScreenshotsCache()
  resetThemePreviewCache()
})

/** README fetch + geometry probes, shared across search/page remounts. */
function measuredThemePreview(plugin: RegistryPlugin): Promise<string[]> {
  const cached = measuredThemePreviewTasks.get(plugin.url)
  if (cached !== undefined) return cached
  const task = pluginScreenshotCandidates(plugin).then(async (candidates) => {
    const measurements = await measureThemeCandidates(candidates)
    const ranked = rankThemeScreenshots(candidates, measurements)
    measuredThemePreviewResults.set(plugin.url, ranked)
    return ranked
  }).catch(() => {
    measuredThemePreviewResults.set(plugin.url, [])
    return []
  })
  measuredThemePreviewTasks.set(plugin.url, task)
  return task
}

/**
 * Themes are chosen visually, so their catalog card gets one stable, large
 * preview instead of the generic plugin card's horizontal thumbnail strip.
 * Curated screenshots keep their declared order. A missing curated set is
 * filled lazily from README only when the card nears the viewport, then
 * ranked by both README semantics and measured image geometry.
 */
export function ThemeCover({ plugin, onOpen, t }: {
  plugin: RegistryPlugin
  onOpen: (shots: string[], index: number) => void
  t: Translate
}) {
  const curated = safeScreenshots(plugin.screenshots)
  const curatedKey = curated.join('\n')
  const cachedFallback = curated.length === 0 ? measuredThemePreviewResults.get(plugin.url) : undefined
  const [fallback, setFallback] = useState<{ loading: boolean; shots: string[] }>({
    loading: curated.length === 0 && cachedFallback === undefined,
    shots: cachedFallback ?? [],
  })
  const [broken, setBroken] = useState<string[]>([])
  const [setCoverRef, near] = useNearViewport<HTMLButtonElement>(THEME_COVER_ROOT_MARGIN)
  useEffect(() => {
    setBroken([])
    if (curated.length > 0) {
      setFallback({ loading: false, shots: [] })
      return
    }
    const cached = measuredThemePreviewResults.get(plugin.url)
    if (cached !== undefined) {
      setFallback({ loading: false, shots: cached })
      return
    }
    setFallback({ loading: true, shots: [] })
    if (!near) return
    let live = true
    void measuredThemePreview(plugin).then(shots => { if (live) setFallback({ loading: false, shots }) })
    return () => { live = false }
  // `plugin.url` identifies a card; registry objects are deliberately not a
  // dependency because polling may recreate one without changing its media.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curatedKey, near, plugin.url])
  const shots = curated.length > 0 ? curated : fallback.shots
  const visible = shots.filter(src => !broken.includes(src))
  const name = pluginName(plugin.name, plugin.npm)

  if (visible.length === 0) {
    return (
      <button
        ref={setCoverRef}
        type="button"
        className={`${css.themeCover} ${css.themeCoverEmpty}`}
        aria-label={`${name}: ${fallback.loading ? t('themePreviewLoading') : t('themePreviewMissing')}`}
        disabled
      >
        {fallback.loading
          ? <span className={css.spin}><IconLoadingOutline16 size={20} /></span>
          : <IconSparkle16 size={20} />}
        <span>{fallback.loading ? t('themePreviewLoading') : t('themePreviewMissing')}</span>
      </button>
    )
  }

  const src = visible[0]!
  return (
    <button
      ref={setCoverRef}
      type="button"
      className={css.themeCover}
      aria-label={`${t('themePreview')} ${name}`}
      onClick={() => onOpen(visible, 0)}
    >
      <img
        src={near ? thumbUrl(src, THEME_COVER_HEIGHT, { webp: true }) : undefined}
        alt=""
        loading="lazy"
        decoding="async"
        fetchPriority="low"
        referrerPolicy="no-referrer"
        onError={() => setBroken(prev => prev.includes(src) ? prev : prev.concat(src))}
      />
      <span className={css.themePreviewAction}>
        <IconSearchOutline16 size={14} />
        {t('themePreview')}
      </span>
      {visible.length > 1 && (
        <span className={css.themePreviewCount}>
          {t('themePreviewCount').replace('{0}', String(visible.length))}
        </span>
      )}
    </button>
  )
}
