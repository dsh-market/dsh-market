/**
 * "Browse the Plugin Market" in the Plugins page's "Add plugin" menu
 * (host slot `plugins.add.actions`, the same seat DSH's own "Let the agent
 * create a plugin" uses). People who open that menu want a new plugin and
 * usually don't know a store exists; this takes them to the market's tab.
 */
import { createElement as h, type ReactElement } from 'react'
import css from './Market.module.css'
import { HostMenuItemButton } from './optional-primitives.ts'
import { MarketLogo } from './MarketLogo.tsx'
import { findMarketTab } from './SettingsNotice.tsx'
import type { HostNavigationStore } from './host-navigation.ts'

type Translate = (key: string) => string

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Select the market's tab on the Plugins page, opening the page first if needed. */
export async function openMarketFromMenu(navigation: HostNavigationStore | undefined, doc: Document = document): Promise<boolean> {
  let tab = findMarketTab(doc)
  if (tab === null) {
    navigation?.get()?.openList?.()
    for (let i = 0; i < 75 && tab === null; i += 1) { await wait(40); tab = findMarketTab(doc) }
  }
  if (tab === null) return false
  tab.click()
  return true
}

export function AddMenuMarketItem({ t, onDismiss, navigation }: { t: Translate; onDismiss?: () => void; navigation?: HostNavigationStore }): ReactElement {
  const select = (): void => {
    onDismiss?.()
    void openMarketFromMenu(navigation)
  }
  const label = h('span', { className: css.addMenuCopy },
    h('span', null, t('addMenuMarket')),
    h('span', { className: css.addMenuDescription, title: t('addMenuMarketHint') }, t('addMenuMarketHint')))
  const icon = h(MarketLogo, { size: 14 })
  if (HostMenuItemButton !== null) return h(HostMenuItemButton, { icon, onSelect: select }, label) as ReactElement
  return h('button', { type: 'button', role: 'menuitem', className: css.addMenuFallback, onClick: select, 'data-dshm-add-menu': '' }, icon, label)
}
