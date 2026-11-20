/**
 * Small card building blocks: hover tips, favorite/bookmark controls, download and star counts, install-confirm folds, sponsor mark and capability grouping.
 */

import { type ReactElement, type ReactNode, type Ref, useEffect, useRef, useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Market.module.css'
import { formatCount, type RegistryPlugin, type Translate } from './market-data.ts'
import { downloadStatistic, downloadStatsText, starStatsText } from './download-stats.ts'
import {
  IconCheckOutline16,
  IconChevronRightOutline14,
  IconChevronUpOutline14,
  IconCodeOutline16,
  IconCopyOutline16,
} from './icons.ts'
import { SPONSORS } from './sponsors.generated.ts'

/**
 * Sweeping cards or the recent strip must not flash tips. Same dwell as
 * the recent-tile name/blurb tips.
 */
export const HOVER_TIP_DELAY_MS = 700

/**
 * Hover tips on catalog cards. Matches official Discover placement
 * (`portal`, `side="bottom"`) so the bubble escapes card overflow and the
 * theme-card hover transform, and does not cover the name. Extra props
 * are ignored on hosts whose Tooltip is older than portal.
 */
export function CardTip({
  label,
  maxWidth,
  children,
}: {
  label: string
  maxWidth?: number
  children: ReactElement
}): ReactElement {
  return (
    <Tooltip label={label} side="bottom" delayMs={HOVER_TIP_DELAY_MS} portal maxWidth={maxWidth}>
      {children}
    </Tooltip>
  )
}

/** Bookmark toggle on catalog cards (#414). Outline when off, filled when on —
 * deliberately not a star, which the byline already uses for GitHub popularity. */
/**
 * The bookmark, with the click felt rather than only seen.
 *
 * Filling the mark is the state; the pop is what makes it read as something
 * the reader did. It is a bookmark, so the mark is pulled down from its top
 * edge and snaps back — a ribbon tugged and released, not a checkbox ticking.
 *
 * Web Animations rather than a class toggled through React state: a second
 * click has to restart the gesture, and "set a flag, clear it on a timer"
 * either coalesces the two renders or leaves the flag set when the click
 * lands mid-animation. Each call here owns its own animation object.
 *
 * `prefers-reduced-motion` skips the gesture; the fill still changes, so the
 * action is never silent.
 */
export function FavoriteButton({ filled, label, onToggle }: { filled: boolean; label: string; onToggle: () => void }) {
  const markRef = useRef<SVGSVGElement>(null)
  return (
    <CardTip label={label}>
      <button
        type="button"
        className={filled ? `${css.favoriteBtn} ${css.favoriteOn}` : css.favoriteBtn}
        aria-pressed={filled}
        aria-label={label}
        onClick={() => {
          onToggle()
          const el = markRef.current
          if (el === null || typeof el.animate !== 'function') return
          if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true) return
          // Per-segment easing, not one curve over the whole gesture: a spring
          // easing on the whole timeline reaches the stretch keyframe in the
          // first few frames and spends the rest of the time settling, which
          // measured as a peak of 1.12 instead of the 1.42 asked for.
          el.animate([
            { transform: 'scaleY(1) translateY(0)', easing: 'cubic-bezier(.32,.72,.42,1)' },
            { transform: 'scaleY(1.42) translateY(1px)', offset: 0.18, easing: 'cubic-bezier(.42,0,.58,1)' },
            { transform: 'scaleY(.84) translateY(-1px)', offset: 0.42, easing: 'cubic-bezier(.3,.75,.5,1)' },
            { transform: 'scaleY(1.1) translateY(.4px)', offset: 0.62, easing: 'cubic-bezier(.3,.75,.5,1)' },
            { transform: 'scaleY(.96) translateY(0)', offset: 0.8, easing: 'ease-out' },
            { transform: 'scaleY(1) translateY(0)' },
          ], { duration: 460 })
        }}
      >
        <BookmarkMark filled={filled} className={css.favoriteMark} markRef={markRef} />
      </button>
    </CardTip>
  )
}

function BookmarkMark({ size = 14, filled = false, className, markRef }: {
  size?: number
  filled?: boolean
  className?: string
  markRef?: Ref<SVGSVGElement>
}) {
  return (
    <svg
      ref={markRef}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      {filled
        ? <path d="M4 1.5h8a1 1 0 0 1 1 1v11.8a.5.5 0 0 1-.78.41L8 12.2 3.78 14.71A.5.5 0 0 1 3 14.3V2.5a1 1 0 0 1 1-1z" fill="currentColor" />
        : (
            <path
              d="M4 1.5h8a1 1 0 0 1 1 1v11.8a.5.5 0 0 1-.78.41L8 12.2 3.78 14.71A.5.5 0 0 1 3 14.3V2.5a1 1 0 0 1 1-1z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinejoin="round"
            />
          )}
    </svg>
  )
}

/** Compact count; hover names the exact figure, source and reporting scope. */
export function DownloadCount({ plugin, t, dot = true }: { plugin: RegistryPlugin; t: Translate; dot?: boolean }) {
  const tip = downloadStatsText(plugin, t)
  const statistic = downloadStatistic(plugin)
  if (tip === null || statistic === null) return null
  return (
    <CardTip label={tip}>
      <span className={css.star} tabIndex={0} aria-label={tip}>
        {(dot ? '· ' : '') + (statistic.source === 'github' ? 'GitHub ' : '') + '↓ ' + formatCount(statistic.count)}
      </span>
    </CardTip>
  )
}

export function StarCount({ plugin, t, dot = true }: { plugin: RegistryPlugin; t: Translate; dot?: boolean }) {
  const tip = starStatsText(plugin, t)
  if (tip === null) return null
  return <CardTip label={tip}><span className={css.star} tabIndex={0} aria-label={tip}>
    {(dot ? '· ' : '') + '★ ' + formatCount(plugin.stars!)}
  </span></CardTip>
}

/** Monochrome mark for one fact in front of the capability fold. Ink, not a warning colour. */
export function AheadMark({ fact }: { fact: string }) {
  if (fact === 'dynamic-code') return <IconCodeOutline16 size={16} className={css.capAheadIcon} />
  if (fact.startsWith('reads credentials')) {
    return (
      <svg className={css.capAheadIcon} viewBox="0 0 16 16" width={16} height={16} aria-hidden="true" focusable="false">
        <circle cx="5.5" cy="8" r="2.25" fill="none" stroke="currentColor" strokeWidth="1.25" />
        <path d="M7.6 8H13M10.6 8v2M12.4 8v1.4" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg className={css.capAheadIcon} viewBox="0 0 16 16" width={16} height={16} aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </svg>
  )
}

/** Circle with a question mark, in the same dark badge and light glyph as the
 * terminal mark below it. */
export function ConfirmCapabilityIcon() {
  return (
    <svg className={css.confirmTerminalIcon} viewBox="0 0 16 16" width={16} height={16} aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="8" fill="currentColor" />
      <path
        className={css.confirmTerminalPrompt}
        d="M6.2 6.25a1.8 1.8 0 1 1 2.7 1.55C8.35 8.1 8 8.5 8 9.05"
        fill="none"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle className={css.confirmTerminalDot} cx="8" cy="11.2" r="0.75" />
    </svg>
  )
}

/** Design-spec terminal mark for the install-command fold: dark rounded
 * square with a light `>_` prompt. Host ui-primitives has no matching glyph. */
export function ConfirmTerminalIcon() {
  return (
    <svg className={css.confirmTerminalIcon} viewBox="0 0 16 16" width={16} height={16} aria-hidden="true" focusable="false">
      <rect width="16" height="16" rx="3.5" fill="currentColor" />
      <path
        className={css.confirmTerminalPrompt}
        d="M4.25 5.25 L7.25 8 L4.25 10.75 M8.25 10.75 H12"
        fill="none"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** execCommand only succeeds inside the click. writeText rejects later, after
 * Chrome has already dropped the user activation, so the textarea copy has
 * to happen before that promise. The field stays inside the dialog; removing
 * a focused node outside it would drop the keyboard onto document.body. */
function copyInstallCommandNow(text: string, anchor: HTMLElement): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.setAttribute('aria-hidden', 'true')
  area.tabIndex = -1
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '-9999px'
  ;(anchor.parentElement ?? document.body).appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  anchor.focus()
  return ok
}

function writeInstallCommand(text: string, anchor: HTMLElement): Promise<void> {
  const copiedNow = copyInstallCommandNow(text, anchor)
  const write = navigator.clipboard?.writeText
  if (typeof write !== 'function') {
    return copiedNow ? Promise.resolve() : Promise.reject(new Error('copy failed'))
  }
  return write.call(navigator.clipboard, text).then(
    () => undefined,
    () => {
      if (copiedNow) return
      throw new Error('copy failed')
    },
  )
}

/** Copy control for the install command. Success shows 「已复制」 beside the
 * icon; the command stays selectable if both copy paths fail. */
export function ConfirmCopyButton({ text, label, copiedLabel }: { text: string, label: string, copiedLabel: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])
  const markCopied = () => {
    setCopied(true)
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }
  return (
    <>
      {copied && <span className={css.confirmCopied} role="status">{copiedLabel}</span>}
      <button
        type="button"
        className={css.confirmCopy}
        aria-label={copied ? copiedLabel : label}
        onClick={(event) => {
          void writeInstallCommand(text, event.currentTarget).then(markCopied, () => {})
        }}
      >
        {copied ? <IconCheckOutline16 size={14} /> : <IconCopyOutline16 size={14} />}
      </button>
    </>
  )
}

/** Stroke glyphs the host primitives do not ship. They inherit the text colour. */
export function IconPlus({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** Clock face for held-wait hints (Lucide `clock` geometry). */
export function IconClock({ size = 12 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  )
}

/** Reminders off (Lucide `bell-off` geometry): the body breaks where the slash crosses it. */
export function IconBellOff({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <path d="M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742" />
      <path d="M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05" />
      <path d="m2 2 20 20" />
    </svg>
  )
}

/** Design-spec warning mark: filled amber triangle, same visual size as the
 * terminal badge above it. Title stays body ink. */
export function ConfirmWarnIcon() {
  return (
    <svg className={css.installCautionMark} viewBox="0 0 16 16" width={16} height={16} aria-hidden="true" focusable="false">
      <path
        fill="#f8b428"
        d="M8 1.15Q8.72 1.15 9.15 2.05L14.4 12.35Q15.15 13.85 13.75 14.55H2.25Q0.85 13.85 1.6 12.35L6.85 2.05Q7.28 1.15 8 1.15Z"
      />
      <path d="M8 6.05v3.15" fill="none" stroke="#fff" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="8" cy="11.15" r="0.68" fill="#fff" />
    </svg>
  )
}

/**
 * Whether a red line is one a reader has to weigh BEFORE installing, rather
 * than a fact about what the plugin does once it runs.
 *
 * Two families qualify, for one reason: they happen at install time. There is
 * no "afterwards" to inspect, so this is the last moment the decision can be
 * made. The other families — credentials+network above all, 73% of every red
 * line the catalog holds — describe what plugins normally do, and calling
 * that urgent is how a warning gets trained away.
 */
export function redLineIsUrgent(line: string): boolean {
  return line.startsWith('runs code at install time') || line.startsWith('tampers with a core bundle')
}

/**
 * Red lines that name one address: a plaintext http:// host or a literal IP.
 *
 * The scanner keeps at most one of each, matched from source text, and many
 * are schema or documentation URLs inside a bundled library. They stay in the
 * capability list as sentences instead of standing in front of it.
 */
export function redLineNamesAddress(line: string): boolean {
  return line.startsWith('uses plaintext http://') || line.startsWith('uses literal IP ')
}

/**
 * Facts shown in front of the capability list: the credentials red line,
 * any red-line family this build does not know, then dynamic code.
 *
 * Each is something the static scan can only point at, not inspect: a secret
 * leaving over the network, or code that exists only once it runs. A
 * host-runtime dependency is a package.json declaration, not that, and stays
 * in the list.
 */
/**
 * The fold's groups: what a capability touches, not how bad it is. A name the
 * build does not know goes under "other" rather than being dropped.
 */
const CAPABILITY_GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['capGroupFiles', ['fs-read', 'fs-write', 'env']],
  ['capGroupNetwork', ['network', 'llm']],
  ['capGroupRun', ['shell', 'dynamic-code', 'subagent']],
  ['capGroupKeys', ['credentials']],
  ['capGroupHost', ['host-runtime']],
]

/**
 * Found in under 15% of the 3844 scanned catalog records (2026-09). A
 * frequency, stated as one; it says nothing about harm.
 */
export const UNCOMMON_CAPABILITIES = new Set(['credentials', 'llm', 'dynamic-code', 'host-runtime', 'subagent'])

export function groupCapabilities(names: readonly string[]): Array<[string, string[]]> {
  const known = new Set(CAPABILITY_GROUPS.flatMap(([, members]) => members))
  const groups: Array<[string, string[]]> = CAPABILITY_GROUPS
    .map(([key, members]): [string, string[]] => [key, members.filter(name => names.includes(name))])
    .filter(([, members]) => members.length > 0)
  const other = names.filter(name => !known.has(name))
  if (other.length > 0) groups.push(['capGroupOther', other])
  return groups
}

export function aheadFacts(plugin: { capabilityRedLines?: string[]; capabilities?: string[] }): string[] {
  const quiet = (plugin.capabilityRedLines ?? []).filter(line => !redLineIsUrgent(line) && !redLineNamesAddress(line))
  const dynamic = (plugin.capabilities ?? []).includes('dynamic-code') ? ['dynamic-code'] : []
  return [...quiet, ...dynamic]
}

/** Install-dialog fold (#739). A gray block, not an outlined frame: the icon
 * stays on the left and the chevron stays on the right, open or closed. */
export function ConfirmFold({ icon, title, meta, open, onToggle, children }: {
  icon: ReactNode
  title: string
  meta?: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className={css.confirmPanel}>
      <button type="button" className={css.confirmPanelRow} aria-expanded={open} onClick={onToggle}>
        <span className={css.confirmPanelIcon}>{icon}</span>
        <span className={css.confirmPanelTitle}>{title}</span>
        {meta !== undefined && <span className={css.confirmPanelMeta}>{meta}</span>}
        {open
          ? <IconChevronUpOutline14 size={14} className={css.confirmPanelChevron} />
          : <IconChevronRightOutline14 size={14} className={css.confirmPanelChevron} />}
      </button>
      {open && <div className={css.confirmPanelBody}>{children}</div>}
    </div>
  )
}

/** Catalog npm latest, omitted for github-only and not-yet-backfilled rows. */
export function CatalogVersionMark({ version, tip, dot = true }: { version: string | null | undefined; tip: string; dot?: boolean }) {
  if (typeof version !== 'string' || version.length === 0) return null
  const label = /^v/i.test(version) ? version : `v${version}`
  return (
    <CardTip label={tip} maxWidth={280}>
      <span className={css.star}>{dot ? `· ${label}` : label}</span>
    </CardTip>
  )
}

/**
 * Sponsors sit in the tab row, logos only (the name is in the tooltip). Every
 * active sponsor is shown, in sponsors.json order: that order is the ranking.
 */
export function SponsorMark({ lang, t }: { lang: 'zh' | 'en'; t: Translate }) {
  const today = new Date().toISOString().slice(0, 10)
  const list = SPONSORS.filter(sponsor => sponsor.until === null || sponsor.until >= today)
  if (list.length === 0) return null
  return (
    <span className={css.sponsorMark}>
      <span className={css.sponsorLabel}>{t('sponsorsLabel')}</span>
      {list.map(sponsor => (
        <a
          key={sponsor.id}
          className={css.sponsorItem}
          href={sponsor.url}
          target="_blank"
          rel="noreferrer sponsored"
          title={`${sponsor.name[lang]} · ${sponsor.scope[lang]}`}
        >
          <img className={css.sponsorLogo} src={sponsor.logo} alt={sponsor.name[lang]} height={14} />
        </a>
      ))}
    </span>
  )
}

/**
 * A card's numbers on their own line, under the author: version, downloads,
 * stars. The dots sit only BETWEEN items that are present, so the line never
 * starts with one — which is what a single wrapping line used to do.
 */
export function CardStats({ plugin, t, versionTip }: { plugin: RegistryPlugin; t: Translate; versionTip: string }) {
  const hasVersion = typeof plugin.version === 'string' && plugin.version.length > 0
  const hasDownloads = downloadStatsText(plugin, t) !== null && downloadStatistic(plugin) !== null
  const hasStars = starStatsText(plugin, t) !== null
  if (!hasVersion && !hasDownloads && !hasStars) return null
  return (
    <div className={css.cardStats}>
      <CatalogVersionMark version={plugin.version} tip={versionTip} dot={false} />
      <DownloadCount plugin={plugin} t={t} dot={hasVersion} />
      <StarCount plugin={plugin} t={t} dot={hasVersion || hasDownloads} />
    </div>
  )
}
