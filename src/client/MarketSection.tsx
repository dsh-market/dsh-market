/**
 * The Market settings section: Discover / Favorites / Themes / Installed tabs over the
 * /dsh-market/* host routes, with install/update/uninstall flows and the
 * pending-restart bookkeeping in sessionStorage.
 */

import css from './Market.module.css'
import { Diagnostics } from './Diagnostics.tsx'
import { useMarketState } from './market-state.tsx'
import { useMarketSync } from './market-sync.ts'
import { useMarketInstall } from './market-install.ts'
import { useMarketOperations } from './market-operations.ts'
import { useMarketGroupsBackup } from './market-groups-backup.ts'
import { useMarketRender } from './market-render.tsx'
import { MarketHead } from './MarketHead.tsx'
import { BackupTab, BlockedTab, DiscoverTab, FavoritesTab, MarketGoneNotice, ThemesTab } from './MarketTabs.tsx'
import { InstalledTab } from './InstalledTab.tsx'
import { MarketDialogs } from './MarketDialogs.tsx'
import type { MarketSectionProps } from './market-types.ts'

export { GithubRoutedImg, OwnerAvatar, resetThemePreviewCache } from './MarketImages.tsx'
export { resetMarketPortalHost } from './MarketLayout.tsx'
export { MarketLogo } from './MarketLogo.tsx'
export { resetHostCompatibilityCache } from './market-state.tsx'
export type { MarketSectionProps } from './market-types.ts'

export function MarketSection(props: MarketSectionProps) {
  const c1 = useMarketState({ props })
  const c2 = useMarketSync({ props, ...c1 })
  const c3 = useMarketInstall({ props, ...c1, ...c2 })
  const c4 = useMarketOperations({ props, ...c1, ...c2, ...c3 })
  const c5 = useMarketGroupsBackup({ props, ...c1, ...c2, ...c3, ...c4 })
  const c6 = useMarketRender({ props, ...c1, ...c2, ...c3, ...c4, ...c5 })
  const c = { props, ...c1, ...c2, ...c3, ...c4, ...c5, ...c6 }
  const {
    bodyRef, marketGone, rootRef, setAssignFor, setGroupMenuFor, setInstalledMenuName,
    setPluginMenuUrl, setShowTop, surface, t, tab, themeSnap, themesFullscreen,
  } = c

  return (
    <div
      ref={rootRef}
      className={`${css.root} notranslate`}
      data-dsh-market-root
      data-dsh-market-plugins-tab={surface === 'plugins' ? 'true' : undefined}
      /* Browser page translation is the one reported cause of the blank
         market (#293 by @apdc111, and the same shape in #286 / #241, none of
         which ever reproduced in an untranslated browser). Chrome and Edge
         translate by REPLACING text nodes underneath React's feet; React then
         tries to remove a node its parent no longer has, throws
         NotFoundError, and the whole section unmounts — leaving the panel
         blank, with the export-log button gone too, which is why every
         request for a log from that state came back empty.

         `translate="no"` is scoped to this subtree, so the host page around
         it still translates. The cost is that machine translation stops
         inside the market; that is a fair trade against a page that cannot
         render at all, and the market already ships its own 中文 and English
         rather than relying on the browser for them. `notranslate` is the
         same instruction for engines that predate the attribute. */
      translate="no"
      data-dsh-market-tab={tab}
      data-dsh-market-fullscreen={tab === 'themes' && themesFullscreen ? 'true' : undefined}
    >
      <MarketHead c={c} />
      <div
        className={css.body}
        ref={bodyRef}
        onScroll={surface === 'plugins' && !themesFullscreen ? undefined : e => {
          const show = e.currentTarget.scrollTop > 400
          setShowTop(prev => (prev === show ? prev : show))
          // Card menus are portaled to document.body and re-pinned to their
          // trigger on every scroll, so nothing here clips them: a trigger
          // scrolled under the sticky header or out of the list drags its
          // menu out over the header and past the panel edge.
          setPluginMenuUrl(null)
          setInstalledMenuName(null)
          setGroupMenuFor(null)
          setAssignFor(null)
        }}
      >
        {/* Everything below reaches the host through the market's own routes;
            with those gone (#962) every control here would fail on click, so
            the body says the one thing that is both true and actionable
            instead of leaving a page of dead buttons. */}
        {marketGone
          ? <MarketGoneNotice c={c} />
          : tab === 'backup'
          ? <BackupTab c={c} />
          : tab === 'discover'
          ? <DiscoverTab c={c} />
          : tab === 'favorites'
            ? <FavoritesTab c={c} />
          : tab === 'themes' && themeSnap !== null
            ? <ThemesTab c={c} />
            : tab === 'diagnostics'
            ? <Diagnostics t={t} />
            : tab === 'blocked'
              ? <BlockedTab c={c} />
            : <InstalledTab c={c} />}
      </div>
      <MarketDialogs c={c} />
    </div>
  )
}
