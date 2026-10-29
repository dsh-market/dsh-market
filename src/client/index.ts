/**
 * dsh-market client: registers a "Market" settings section rendering the
 * plugin market UI, plus the post-install toast in the shell overlay layer.
 * Built by tsdown into the __ModuleLoader__ factory bundle at
 * client/client.js; the only externals are the loader module table's react
 * entries.
 */
import { createElement as h } from 'react'
import type { ReactNode } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { missingIcons } from './icons.ts'
import { en, ja, zh } from './locales.ts'
import { InstallToast } from './InstallToast.tsx'
import { MarketErrorBoundary } from './ErrorBoundary.tsx'
import { MarketSection } from './MarketSection.tsx'
import { marketElement } from './market-element.ts'
import { createSectionGate } from './section-gate.ts'
import { createEntryVisibility } from './entry-visibility.ts'
import { exportMarketLog } from './self-check.ts'
import { SettingsCard } from './SettingsCard.tsx'
import { installSettingsNavIcon } from './settings-nav-icon.ts'
import { createHostNavigation } from './host-navigation.ts'
import { createSidebarEntry, SIDEBAR_PANEL_ID, SIDEBAR_PANEL_ORDER } from './sidebar-entry.ts'
import type { SidebarEntry } from './sidebar-entry.ts'
import { MarketLogo } from './MarketSection.tsx'
import css from './Market.module.css'
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

/**
 * The package name the host keys a bundle's own configuration by.
 *
 * `plugins.bundle.config` on dsh 0.1.7+ is keyed by the BUNDLE's package
 * name. The market's is `dshmarket` — the name `dsh plugin add dshmarket`
 * installs and the one its own `package.json` declares — which is not the
 * same string as the locale namespace (`dsh-market`) this file uses for copy.
 */
const MARKET_PACKAGE_NAME = 'dshmarket'

/** The subset of the theme service this plugin touches. */
interface ThemeService {
  getTheme(): ThemeSnapshot | null
  setTheme(id: string): void
}

/** The subset of the locale service this plugin touches. */
interface LocaleService {
  register(namespace: string, dicts: { zh: Record<string, string>; en: Record<string, string>; ja?: Record<string, string> }): unknown
  bind(namespace: string): Translate
  subscribe(callback: () => void): () => void
  getSnapshot(): { active: string }
}

/** The subset of the host layout service the sidebar entry touches. */
interface LayoutService {
  selectPanel(id: string | null): void
  panelInfo: { getSnapshot(): { activePanelId?: string | null } }
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

  // Everything below hands registrations to the host, and a throw in there is
  // a throw inside the host's own client-plugin bootstrap: the module loader
  // runs a plugin's factory on the boot path with nothing between it and the
  // shell, so ONE plugin failing takes the whole app down — the market
  // included, on a host where it is only a guest (#869). The market must not
  // be able to do that. Contain it here: the sections registered before the
  // throw stay (they are valid, and ctx owns their disposal), the market goes
  // missing for this session, and the console says what happened and where to
  // send it. A hook on the host side would be the better place for this —
  // none exists today.
  try {
    mountMarket(ctx)
  } catch (error) {
    console.error(
      '[dsh-market] mounting failed, so the market is missing for this session. '
      + 'The rest of the app is unaffected. Report at https://github.com/dsh-market/dsh-market/issues '
      + 'with this line and the stack below:',
      error,
    )
  }
}

/**
 * The market's mounts, split out only so apply() can contain a throw from any
 * of them. Not exported: the split is a guard, not a surface.
 */
function mountMarket(ctx: MarketClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja }), 'dsh-market: dictionaries')
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
  // Assigned once the sidebar controller exists, below. Closures that call
  // buildMarketElement run after that assignment — a render during setup
  // would see no controller, and the page simply offers no tip.
  let sidebar: SidebarEntry | undefined
  /**
   * The host's `pluginNavigation` (dsh 0.2.1+), published as a store so the
   * panel's menus can offer "在插件页查看" whether the service is there before
   * or after this package mounts. See host-navigation.ts.
   */
  const hostNavigation = createHostNavigation()
  /**
   * The market's own panel, as an element — one builder for the settings
   * section this package registers and for `market.render()` (#602). Built
   * per call: the props are live (locale, theme, the host's preferred
   * subsection), and a cached element would freeze the first caller's.
   */
  const buildMarketElement = (ownerProps: { preferredSubsectionId?: string; surface?: 'settings' | 'sidebar' | 'plugins' } = {}): unknown => marketElement({
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
    sidebar,
    hostNavigation,
    surface: ownerProps.surface ?? 'settings',
  })

  const sectionGate = createSectionGate(() => {
    const off = ctx.slots.register({
      name: 'settings.section',
      id: 'market',
      order: 40,
      label: () => t('nav'),
      locale: NS,
      inject: () => ({ t }),
    }, (ownerProps: { preferredSubsectionId?: string } = {}) => buildMarketElement({ ...ownerProps, surface: 'settings' }))
    // `slots.register` may not hand back a disposer on every host; the gate
    // needs one regardless, so the absence becomes a no-op rather than a
    // silently unretractable entry.
    return typeof off === 'function' ? off as () => void : () => {}
  })

  // The Plugins page's own tab row (dsh 0.2.1-alpha.4+). The page that
  // shows 已安装 next to 发现 declares `plugins.tab` for exactly this: another
  // plugin adds a tab after 已安装 and draws whatever it likes there. The
  // official Discover tab is itself such a registration, which is why the
  // market belongs here rather than only behind Settings — same page, one
  // click from 已安装, and no dependency on where each host puts Settings.
  //
  // Order −1 places the market between 已安装 and the host's own 发现 tab:
  // the same adjacency the sidebar row uses, and the market is the fuller
  // catalog of the two.
  //
  // Detection is the slot, as everywhere else in this file: hosts before
  // 0.2.1-alpha.4 never declare it (their tab row is `settings.plugins.tab`,
  // which the market already occupies), so nothing is added there. The owner
  // props this slot hands over (`install`, `openPackage`) drive the host's own
  // install dialog and Installed list; the market brings both of its own, so
  // they are deliberately not used — routing installs through the host would
  // take the progress, the task list and the cancel with them.
  //
  // The gate (#1015): this entry is now the user's to keep or hide, but only
  // where the slot exists — on older hosts there is nothing to gate.
  const pluginsTabGate = createSectionGate(() => {
    const off = ctx.slots.register({
      name: 'plugins.tab',
      id: NS,
      order: -1,
      label: () => t('nav'),
      locale: NS,
      inject: () => ({ t }),
    }, () => buildMarketElement({ surface: 'plugins' }))
    return typeof off === 'function' ? off as () => void : () => {}
  })

  // One controller owns both page entries and their saved answers (#1015).
  // The sidebar's two facts are read live rather than copied: its switch
  // lives in the same card, and a copy would go stale the moment it flips.
  const entries = createEntryVisibility({
    settingsGate: sectionGate,
    pluginsTabGate,
    fetch: (...args) => fetch(...args),
    sidebarSupported: () => sidebar?.supported() === true,
    sidebarShown: () => sidebar?.shown() === true,
  })
  void entries.load()

  // Whether the host offers a settings page at all. dsh 0.2.1 moved the
  // Settings dialog into the account menu, but the section slot still
  // arrives and the market still renders there. Detection is the slot, as
  // everywhere else here, and `refresh()` re-answers when it arrives: a host
  // that declares sidebar panels without serving a settings section would
  // otherwise leave the market with no door but the row (#846).
  ctx.slots.inject('settings.section', () => {
    entries.markSettingsSection()
    sidebar?.refresh()
  })

  // The opt-in sidebar row (#846). Registered only while the user has it on
  // AND the host declares sidebar panels; see sidebar-entry.ts.
  let layout: LayoutService | undefined
  const sidebarGate = createSectionGate(() => {
    const offPanel = ctx.slots.register({
      name: 'main',
      key: SIDEBAR_PANEL_ID,
      locale: NS,
      inject: () => ({ t }),
    }, () => h('div', { className: css.panelHost }, buildMarketElement({ surface: 'sidebar' }) as ReactNode))
    const offRow = ctx.slots.register({
      name: 'sidebar.panellist',
      id: SIDEBAR_PANEL_ID,
      order: SIDEBAR_PANEL_ORDER,
      label: () => t('nav'),
      locale: NS,
    }, ((owner: { size?: number } = {}) => h(MarketLogo, { size: owner.size ?? 16 })) as () => unknown)
    return () => {
      // Leave the page before its panel goes: a selection pointing at a key
      // that no longer exists would strand the main column on nothing.
      if (layout?.panelInfo.getSnapshot().activePanelId === SIDEBAR_PANEL_ID) layout.selectPanel(null)
      if (typeof offRow === 'function') (offRow as () => void)()
      if (typeof offPanel === 'function') (offPanel as () => void)()
    }
  }, false)
  sidebar = createSidebarEntry({
    gate: sidebarGate,
    fetch: (...args) => fetch(...args),
    // Settings and the Plugins page tab are both doors now (#1015), and
    // either one makes this row optional rather than the only way in.
    hasOtherSeat: () => entries.settingsSupported() || entries.pluginsTabSupported(),
  })
  void sidebar.load()
  ctx.slots.inject('sidebar.panellist', () => { sidebar?.markSupported() })
  // The slot injections above either fire synchronously (the host declares the
  // slot) or never; this re-answers once the setup pass is over so a host with
  // no settings page shows the row without waiting for the server round trip.
  setTimeout(() => { sidebar?.refresh() }, 0)
  ;(ctx as unknown as { inject(services: string[], callback: (scoped: { layout: LayoutService }) => void): void })
    .inject(['layout'], (scoped) => { layout = scoped.layout })

  // The host's own page for a bundle (dsh 0.2.1+). Its Plugins page documents
  // `pluginNavigation.openBundle(packageName)` for other client plugins: the
  // bundle's page is where its rows are switched one by one, which no public
  // contract lets a third party draw. Nested inject, like the settings card
  // below: naming the service in the module-level `inject` would keep the
  // whole plugin unmounted on every host without it, and this one is young.
  ;(ctx as unknown as {
    inject(services: string[], callback: (scoped: { pluginNavigation: { openBundle(name: string): void } }) => void): void
  }).inject(['pluginNavigation'], (scoped) => {
    hostNavigation.attach({ openBundle: (name) => { scoped.pluginNavigation.openBundle(name) } })
  })
  const retire = (): void => {
    entries.retire()
    sidebarGate.retire()
  }

  // The control surface a host uses instead of reaching into our internals.
  // Published as a service rather than a page global so it is discoverable
  // and typed like every other client-side capability. Deliberately small:
  // only what genuinely has to happen IN THE PAGE. Update counts are an HTTP
  // concern and live in the v1 API, where a client with no market UI loaded
  // can still ask for them.
  const marketControl = {
    version: 1 as const,
    // The host's own preference (#602), ANDed with the user's saved answer
    // by the entry controller (#1015): a host that renders the market itself
    // must not get the duplicate entry back because a user flipped a switch.
    setSettingsVisible: (visible: boolean): void => { entries.setHostSettingsVisible(visible) },
    settingsVisible: (): boolean => entries.settingsVisible(),
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
    }, () => h(SettingsCard, { t, sidebar, entries, onRemoved: retire })))
  })

  // The card's seat on 0.1.7+ (#677). The host moved a plugin's own
  // configuration onto its bundle's page in the sidebar's Plugins page, and
  // states in its own slot contract where a THIRD-PARTY bundle's
  // configuration belongs: `plugins.item` is "OCCUPIED by the official
  // settings pages", and "a bundle's configuration belongs in
  // `plugins.bundle.config` or `plugins.row.config` instead". So this is the
  // same seat `settings.plugin.item` was on the older line, under its new
  // name — not a place chosen here.
  //
  // Detection is the slot itself: `slots.inject` waits for the slot to exist,
  // so a host that never declares it (every release before 0.1.7) never runs
  // this, and no version string is consulted.
  const bundleConfigCtx = ctx as unknown as {
    slots: {
      inject(name: string, register: () => unknown): void
      register(options: Record<string, unknown>, render: (ownerProps: { view?: string }) => unknown): unknown
    }
  }
  bundleConfigCtx.slots.inject('plugins.bundle.config', () => bundleConfigCtx.slots.register({
    name: 'plugins.bundle.config',
    key: MARKET_PACKAGE_NAME,
    locale: NS,
    inject: () => ({ t }),
  }, (ownerProps: { view?: string } = {}) => ownerProps.view === 'summary'
    // `summary` is this entry's one-liner in the list, which the market's own
    // description already carries; the card is the page.
    ? null
    : h(SettingsCard, { t, sidebar, entries, onRemoved: retire })))

  // The seat on the 0.1.7 line (#722). That release renamed the client's
  // `settingsScope` service to `settings`, so the nested inject above stopped
  // firing and `settings.plugin.item` — the settings-list card — went silent
  // with no error anywhere. `settings.plugins.tab` is what that line's slot
  // contract offers instead: "one page inside the Plugins settings section",
  // rendered as a tab beside the host's own. Reported as "the settings card
  // disappeared".
  //
  // This does not replace the `plugins.bundle.config` registration above, and
  // that one did not stop firing: 0.1.7 declares it (`ui-plugin-manager` — "a
  // bundle's own configuration, keyed by the bundle's package name and
  // rendered on the bundle's page"), so the market's card is also on the
  // market bundle's page in the Plugins section. BOTH seats are deliberate:
  // the tab is where a user opens the market's settings from that section, the
  // bundle page is where the plugin manager shows them for the installed
  // bundle. Keep both.
  //
  // Detection is the slot itself, as everywhere else here: a host that does
  // not declare it never runs this, and the older line keeps its card through
  // `settings.plugin.item`.
  const pluginsTabCtx = ctx as unknown as {
    slots: {
      inject(name: string, register: () => unknown): void
      register(options: Record<string, unknown>, render: () => unknown): unknown
    }
  }
  pluginsTabCtx.slots.inject('settings.plugins.tab', () => pluginsTabCtx.slots.register({
    name: 'settings.plugins.tab',
    id: NS,
    order: 60,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ t }),
  }, () => h(SettingsCard, { t, sidebar, entries, onRemoved: retire })))

  // The Plugins page tab itself (#1015). Its registration now lives behind
  // `pluginsTabGate` above; this only tells the controller the slot exists,
  // which is also what makes the sidebar row no longer a candidate for the
  // market's only door.
  ctx.slots.inject('plugins.tab', () => {
    entries.markPluginsTab()
    sidebar?.refresh()
  })

  const Toast = () => h(InstallToast, { t })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-market-toast',
    label: () => 'dsh-market',
  }, Toast))
}
