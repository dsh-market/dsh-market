/**
 * dsh-market client: registers a "Market" settings section rendering the
 * plugin market UI, plus the post-install toast in the shell overlay layer.
 * Built by tsdown into the __ModuleLoader__ factory bundle at
 * client/client.js; the only externals are the loader module table's react
 * entries.
 */
import { createElement as h } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { missingIcons } from './icons.ts'
import { en, zh } from './locales.ts'
import { InstallToast } from './InstallToast.tsx'
import { MarketErrorBoundary } from './ErrorBoundary.tsx'
import { MarketSection } from './MarketSection.tsx'
import { marketElement } from './market-element.ts'
import { createSectionGate } from './section-gate.ts'
import { exportMarketLog } from './self-check.ts'
import { SettingsCard } from './SettingsCard.tsx'
import { installSettingsNavIcon } from './settings-nav-icon.ts'
import type { ThemeSnapshot, Translate } from './market-data.ts'

const NS = 'dsh-market'

/**
 * Primitives this bundle relies on that did not exist before rc.6. The
 * primitives module is host-injected (external at build time), so on an
 * older host the module resolves but these named exports are undefined —
 * rendering would throw and blank the whole settings dialog. Returning the
 * gaps lets apply() skip registration for a clean downgrade instead.
 */
export const REQUIRED_PRIMITIVES = ['Menu', 'DisclosureRow', 'Tooltip', 'Toast'] as const

export function missingPrimitives(mod: Record<string, unknown>, required: readonly string[] = REQUIRED_PRIMITIVES): string[] {
  return required.filter(name => mod[name] === undefined)
}

/**
 * The host surface the settings card needs, present only on rc.7+.
 *
 * The card no longer reads or writes settings — it manages the market's own
 * package — but `settingsScope` stays as the INJECTION KEY, because its
 * presence is what distinguishes a host that has the plugin configuration
 * page from one that does not. The market's namespace (registered in
 * settings.ts) is likewise still required: the page dispatches a card keyed
 * by a namespace it serves, so dropping it would take the card with it.
 */
interface SettingsScopeHost {
  slots: {
    inject(name: string, register: () => unknown): void
    register(options: Record<string, unknown>, render: () => unknown): unknown
  }
}

/** The subset of the theme service this plugin touches. */
interface ThemeService {
  getTheme(): ThemeSnapshot | null
  setTheme(id: string): void
}

/** The subset of the locale service this plugin touches. */
interface LocaleService {
  register(namespace: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): unknown
  bind(namespace: string): Translate
  subscribe(callback: () => void): () => void
  getSnapshot(): { active: string }
}

/** The subset of the slots service this plugin touches. */
interface SlotsService {
  inject(slot: string, register: () => unknown): void
  register(meta: Record<string, unknown>, component: () => unknown): unknown
}

/** The client cordis context shape this plugin relies on (structural: the
 * host provides the real Context; typing the touched surface keeps this
 * external package free of monorepo-internal type dependencies). */
interface MarketClientContext {
  effect(callback: () => unknown, label?: string): void
  on(event: string, callback: () => void): () => void
  locale: LocaleService
  slots: SlotsService
  theme: ThemeService
}

export const name = 'dsh-market'
// 'theme' is safe to require: ui-layout (mandatory in every web composition)
// already hard-depends on it. This cordis's object-form inject means
// intercept config, NOT {required,optional} — do not use it here.
export const inject = ['slots', 'locale', 'theme']
export function apply(ctx: MarketClientContext): void {
  // Older hosts resolve the primitives module but lack the rc.6 exports the
  // market renders with. Skip registration (market simply absent from the
  // settings list) rather than throwing mid-render and blanking the dialog.
  // Icons are different (#671): 0.1.7 renamed …14/…16 to weight names with no
  // alias. icons.ts accepts either spelling and skips a missing glyph so the
  // next rename costs one icon, not the whole page — do not fold icon gaps
  // into this hard disable.
  const mod = primitives as unknown as Record<string, unknown>
  const gaps = missingPrimitives(mod)
  if (gaps.length > 0) {
    console.warn('[dsh-market] host ui-primitives missing ' + gaps.join(', ') + ' — market section disabled (dsh web >= 0.1.0-rc.6 required)')
    return
  }
  const iconGaps = missingIcons(mod)
  if (iconGaps.length > 0) {
    console.warn('[dsh-market] host ui-primitives missing icons ' + iconGaps.join(', ') + ' — rendering without them')
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-market: dictionaries')
  const t = ctx.locale.bind(NS)

  // The section's nav glyph. The shell picks nav icons from its own built-in
  // ids and falls back to the settings gear, and a settings.section
  // registration has no icon to pass — so the market claims its own row and
  // swaps the gear for the block mark. Same label thunk as the registration
  // below, so the row is re-claimed when the locale changes.
  installSettingsNavIcon(ctx, () => t('nav'))

  // One gate owns both questions about this entry — whether the HOST wants
  // it (#602: a shell that renders the market itself does not want a
  // duplicate nav item) and whether this package is being removed. See
  // section-gate.ts for why the orderings, not the booleans, are the work.
  /**
   * The market's own panel, as an element — one builder for the settings
   * section this package registers and for `market.render()` (#602). Built
   * per call: the props are live (locale, theme, the host's preferred
   * subsection), and a cached element would freeze the first caller's.
   */
  const buildMarketElement = (ownerProps: { preferredSubsectionId?: string } = {}): unknown => marketElement({
    t,
    locale: ctx.locale,
    theme: ctx.theme,
    themeStore: {
      subscribe: (cb: () => void) => ctx.on('theme/change', cb),
      getSnapshot: () => ctx.theme.getTheme(),
    },
    crashText: {
      title: t('crashTitle'),
      hint: t('crashHint'),
      reload: t('crashReload'),
      details: t('crashDetails'),
    },
    exportLog: () => { void exportMarketLog().catch(() => {}) },
    preferredSubsectionId: ownerProps.preferredSubsectionId,
  })

  const sectionGate = createSectionGate(() => {
    const off = ctx.slots.register({
      name: 'settings.section',
      id: 'market',
      order: 40,
      label: () => t('nav'),
      locale: NS,
      inject: () => ({ t }),
    }, (ownerProps: { preferredSubsectionId?: string } = {}) => buildMarketElement(ownerProps))
    // `slots.register` may not hand back a disposer on every host; the gate
    // needs one regardless, so the absence becomes a no-op rather than a
    // silently unretractable entry.
    return typeof off === 'function' ? off as () => void : () => {}
  })

  ctx.slots.inject('settings.section', () => { sectionGate.available() })

  // The control surface a host uses instead of reaching into our internals.
  // Published as a service rather than a page global so it is discoverable
  // and typed like every other client-side capability. Deliberately small:
  // only what genuinely has to happen IN THE PAGE. Update counts are an HTTP
  // concern and live in the v1 API, where a client with no market UI loaded
  // can still ask for them.
  const marketControl = {
    version: 1 as const,
    setSettingsVisible: (visible: boolean): void => { sectionGate.setVisible(visible) },
    settingsVisible: (): boolean => sectionGate.visible(),
    /**
     * The market's panel as an element, for a host that renders it inside
     * its own container. Same page, same React instance — this package's
     * bundle resolves react through the host's module table, so an element
     * returned here mounts anywhere in that tree.
     *
     * What it is NOT: a way to rearrange the market. It hands over the whole
     * panel, chrome included. Cutting the market into host-fillable regions
     * is a different design and has not been asked for by a second host yet.
     */
    render: (props: { preferredSubsectionId?: string } = {}): unknown => buildMarketElement(props),
  }
  // Guarded: `provide` is cordis's, and a host old enough to be missing it
  // should lose the control surface, not the whole market.
  if (typeof (ctx as { provide?: unknown }).provide === 'function') {
    ;(ctx as unknown as { provide: (name: string, value: unknown) => void }).provide('market', marketControl)
  }

  // The settings card (dsh >= 0.1.0-rc.7). Registered through a NESTED
  // inject on purpose: naming settingsScope in the module-level `inject`
  // would keep this whole plugin unmounted on any host without that
  // service — the market's own page would vanish on rc.6 to gain a card
  // rc.6 cannot render. Nested, the card simply never appears there.
  const settingsCtx = ctx as unknown as {
    inject(services: string[], callback: (scoped: SettingsScopeHost) => void): void
  }
  settingsCtx.inject(['settingsScope'], (scoped) => {
    scoped.slots.inject('settings.plugin.item', () => scoped.slots.register({
      name: 'settings.plugin.item',
      key: NS,
      locale: NS,
      inject: () => ({ t }),
    }, () => h(SettingsCard, { t, onRemoved: () => { sectionGate.retire() } })))
  })

  const Toast = () => h(InstallToast, { t })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-market-toast',
    label: () => 'dsh-market',
  }, Toast))
}
