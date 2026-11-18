/**
 * The "this has moved" line at the top of the market in Settings.
 *
 * On a host that has the Plugins page tab, the tab is where the market lives
 * now and the Settings entry is on its way out. The market stays fully usable
 * below the line; the line is a statement with one way to the new place, not a
 * warning. Everywhere else (older hosts, the sidebar, the Plugins tab itself)
 * nothing is added.
 *
 * The frame keeps the market at the same place in the tree whether or not the
 * line is showing, so the line appearing when the host's slot or the saved
 * answer arrives late never remounts (and so never resets) the market.
 */
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Market.module.css'
import type { EntryVisibility } from './entry-visibility.ts'
import type { HostNavigation, HostNavigationStore } from './host-navigation.ts'
import type { Translate } from './market-data.ts'

/** The id the market registers its Plugins page tab under. */
export const MARKET_TAB_ID = 'dsh-market'

const CLOSE_LABEL = /^(关闭|关闭对话框|Close|Close dialog|閉じる)$/i

function wait(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** Poll until `probe` answers truthy; null on timeout. */
async function until<T>(probe: () => T | null | undefined | false, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = probe()
    if (found) return found
    if (Date.now() >= deadline) return null
    await wait(40)
  }
}

/** The market's tab in the Plugins page's tab row, once it is in the page. */
export function findMarketTab(doc: Document): HTMLElement | null {
  const tabs = doc.querySelectorAll<HTMLElement>(`[role="tab"][id$="-${MARKET_TAB_ID}"]`)
  for (const tab of Array.from(tabs)) {
    // Not one inside a dialog: Settings can hold tabs of its own.
    if (tab.closest('[role="dialog"]') === null) return tab
  }
  return null
}

/** Close the dialog that holds `from`. Resolves true once it is gone. */
export async function closeDialogOf(from: Element, doc: Document): Promise<boolean> {
  const dialog = from.closest('[role="dialog"]')
  if (dialog === null) return true
  const closeButton = Array.from(dialog.querySelectorAll<HTMLElement>('button'))
    .find(button => CLOSE_LABEL.test((button.getAttribute('aria-label') ?? button.textContent ?? '').trim()))
  if (closeButton !== undefined) {
    closeButton.click()
  } else {
    const init = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }
    // Escape goes where the focus is when that is inside the dialog, which is
    // where a host's key handler listens; otherwise to the dialog itself.
    const focused = doc.activeElement
    ;(focused !== null && dialog.contains(focused) ? focused : dialog).dispatchEvent(new KeyboardEvent('keydown', init))
  }
  return (await until(() => !from.isConnected || !dialog.isConnected, 1500)) !== null
}

/**
 * Take the user to the Plugins page, select the market tab there when it can
 * be found, and close the Settings dialog `from` sits in.
 *
 * Landing on the Plugins page without the market tab selected is still a
 * success: the user is where the market lives, one click from it.
 * @returns false when the user was NOT taken anywhere (no navigation, the
 *   host threw, or the dialog would not close), so the caller can say so.
 */
export async function openMarketTab(
  navigation: HostNavigation | undefined,
  from: Element,
  doc: Document = document,
): Promise<boolean> {
  if (navigation?.openList === undefined) return false
  try {
    navigation.openList()
    const tab = await until(() => findMarketTab(doc), 3000)
    if (tab !== null) {
      tab.click()
      await until(() => tab.getAttribute('aria-selected') === 'true', 1000)
    }
    // Close last: closing first would unmount this line mid-way.
    return await closeDialogOf(from, doc)
  } catch {
    return false
  }
}

interface NoticeProps {
  t: Translate
  hostNavigation?: HostNavigationStore
}

function Notice({ t, hostNavigation }: NoticeProps): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const mounted = useRef(true)
  const [, bump] = useState(0)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  // The navigation service may arrive after this page first renders.
  useEffect(() => hostNavigation?.subscribe(() => { bump(n => n + 1) }), [hostNavigation])
  const canGo = typeof hostNavigation?.get()?.openList === 'function'

  const go = useCallback(() => {
    if (rootRef.current === null) return
    setBusy(true)
    setFailed(false)
    void openMarketTab(hostNavigation?.get(), rootRef.current).then((ok) => {
      if (!mounted.current) return
      setBusy(false)
      setFailed(!ok)
    })
  }, [hostNavigation])

  return h('div', { className: css.moveNotice, ref: rootRef, 'data-dsh-market-notice': '' },
    h('span', { className: css.moveNoticeText }, failed ? t('noticeFailed') : canGo ? t('noticeText') : t('noticeTextManual')),
    canGo
      ? h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: go }, t('noticeGo'))
      : null,
  )
}

interface FrameProps extends NoticeProps {
  entries?: EntryVisibility
  children?: ReactNode
}

/**
 * Wraps the Settings surface's market. The line shows while the host has the
 * Plugins tab and the user keeps it on — the only case where "it moved" is
 * true and there is somewhere to go.
 */
export function SettingsNoticeFrame({ t, entries, hostNavigation, children }: FrameProps): ReactElement {
  const [, bump] = useState(0)
  useEffect(() => entries?.subscribe(() => { bump(n => n + 1) }), [entries])
  const show = entries !== undefined && entries.pluginsTabSupported() && entries.pluginsTab()
  return h('div', { className: show ? css.noticeFrame : css.noticeFrameOff },
    show ? h(Notice, { t, hostNavigation }) : null,
    h('div', { className: show ? css.noticeBody : css.noticeFrameOff }, children),
  )
}
