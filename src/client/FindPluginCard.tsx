/**
 * The `/find-plugin` row in the DSH chat, drawn as plugin cards.
 *
 * The host lets a plugin replace the row of a command by name
 * (`conversation.chat.commandview`). The command's text stays the source of
 * truth for hosts without that slot; here the structured picks are fetched by
 * the command id and drawn with three ways to install, the market's own
 * dialog first (it explains what installing does before anything happens).
 */
import { Component, useCallback, useEffect, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Market.module.css'
import { api, formatCount } from './market-data.ts'
import { OwnerAvatar } from './MarketImages.tsx'
import { requestOpenPlugin } from './open-request.ts'
import { findMarketTab } from './SettingsNotice.tsx'
import type { HostNavigationStore } from './host-navigation.ts'
import { closeOverlay, noteFindRowShown, overlayRequest, subscribeOverlay } from './find-plugin-overlay.ts'

type Translate = (key: string) => string

export interface FindPick {
  name: string
  owner: string
  url: string
  npm: string | null
  install: string
  categories: string[]
  description: string
  downloads: number | null
  stars: number | null
  why: string
}

export interface FindResult {
  request: string
  intro: string
  picks: FindPick[]
  model: string
}

/** The command node as the chat hands it over (only the fields read here). */
interface CommandNodeLike {
  commandId: string
  args: string | null
  outcome: { kind: 'success' | 'error'; text?: string } | null
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Take the user to the market tab; the market opens the dialog when it mounts. */
export async function goToMarket(name: string, navigation: HostNavigationStore | undefined, doc: Document = document): Promise<boolean> {
  requestOpenPlugin(name)
  const nav = navigation?.get()
  if (nav?.openList === undefined) return false
  nav.openList()
  for (let i = 0; i < 75; i += 1) {
    const tab = findMarketTab(doc)
    if (tab !== null) { tab.click(); return true }
    await wait(40)
  }
  return true
}

type InstallState =
  | { phase: 'idle' }
  | { phase: 'confirm' }
  | { phase: 'working' }
  | { phase: 'done'; text: string }
  | { phase: 'failed'; text: string }

function PickCard({ pick, index, t, navigation, onOpen }: { pick: FindPick; index: number; t: Translate; navigation?: HostNavigationStore; onOpen?: (name: string) => void }): ReactElement {
  const [install, setInstall] = useState<InstallState>({ phase: 'idle' })
  const [copied, setCopied] = useState(false)
  const [navFailed, setNavFailed] = useState(false)

  const onMarket = useCallback(() => {
    // Already on the market page: just open the dialog.
    if (onOpen !== undefined) { onOpen(pick.name); return }
    void goToMarket(pick.name, navigation).then(ok => { if (!ok) setNavFailed(true) })
  }, [navigation, onOpen, pick.name])

  const onInstall = useCallback(() => {
    setInstall({ phase: 'working' })
    fetch(api('/dsh-market/install'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: pick.url }),
    })
      .then(res => res.json().then((body: Record<string, unknown>) => ({ status: res.status, body })))
      .then(({ status, body }) => {
        if (status === 202) setInstall({ phase: 'done', text: t('fpQueued') })
        else if (status === 200 && body.ok !== false) {
          setInstall({ phase: 'done', text: body.restart === true || body.needsRestart === true ? t('fpInstalledRestart') : t('fpInstalled') })
        } else setInstall({ phase: 'failed', text: typeof body.error === 'string' ? body.error : t('fpInstallFailed') })
      })
      .catch((error: unknown) => setInstall({ phase: 'failed', text: error instanceof Error ? error.message : String(error) }))
  }, [pick.url, t])

  const onCopy = useCallback(() => {
    void navigator.clipboard?.writeText(pick.install).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }, [pick.install])

  const meta = [pick.categories.join(' / '), pick.downloads !== null ? `${t('fpDownloads')} ${formatCount(pick.downloads)}` : ''].filter(Boolean).join(' · ')
  return (
    <div className={css.fpCard} data-dshm-find-pick={pick.name}>
      <OwnerAvatar name={pick.name} owner={pick.owner} className={css.fpAvatar} />
      <div className={css.fpBody}>
        <div className={css.fpHead}>
          <a className={css.fpName} href={pick.url} target="_blank" rel="noreferrer">{index + 1}. {pick.name}</a>
          {meta !== '' && <span className={css.fpMeta}>{meta}</span>}
        </div>
        <div className={css.fpWhy}>{pick.why || pick.description}</div>
        {install.phase === 'confirm' && (
          <div className={css.fpConfirm}>
            <span>{t('fpConfirm').replace('{0}', pick.name)}</span>
            <Button size="sm" variant="primary" onClick={onInstall}>{t('fpConfirmInstall')}</Button>
            <Button size="sm" variant="outline" onClick={() => setInstall({ phase: 'idle' })}>{t('cancel')}</Button>
          </div>
        )}
        {install.phase === 'working' && <div className={css.fpNote}>{t('installing')}</div>}
        {install.phase === 'done' && <div className={css.fpNote} data-tone="ok">{install.text}</div>}
        {install.phase === 'failed' && <div className={css.fpNote} data-tone="error">{install.text}</div>}
        {navFailed && <div className={css.fpNote}>{t('fpOpenManually')}</div>}
      </div>
      <div className={css.fpActions}>
        <div className={css.fpButtons}>
          <Button size="sm" variant="primary" onClick={onMarket}>{t('fpOpenMarket')}</Button>
          <Button size="sm" variant="outline" disabled={install.phase === 'working' || install.phase === 'done'} onClick={() => setInstall({ phase: 'confirm' })}>{t('fpInstallHere')}</Button>
        </div>
        <button type="button" className={css.fpCopy} onClick={onCopy}>{copied ? t('fpCopied') : t('fpCopy')}</button>
      </div>
    </div>
  )
}

/** The picks, drawn the same way in the chat and in the market's AI search. */
export function FindResultView({ result, t, navigation, onOpen }: { result: FindResult; t: Translate; navigation?: HostNavigationStore; onOpen?: (name: string) => void }): ReactElement {
  return (
    <div className={css.fpRoot}>
      {result.intro !== '' && <p className={css.fpIntro}>{result.intro}</p>}
      {result.picks.length > 0 && (
        <div className={css.fpList}>
          {result.picks.map((pick, i) => <PickCard key={pick.name} pick={pick} index={i} t={t} navigation={navigation} onOpen={onOpen} />)}
        </div>
      )}
      <p className={css.fpFoot}>{t('fpFoot')}</p>
    </div>
  )
}

/** The chat's command row for `/find-plugin`. */
export function FindPluginRow({ node, t, navigation }: { node: CommandNodeLike; t: Translate; navigation?: HostNavigationStore }): ReactElement {
  const [result, setResult] = useState<FindResult | null>(null)
  const [missing, setMissing] = useState(false)
  const done = node.outcome?.kind === 'success'
  // Tell the blank-session fallback that the chat did draw this row.
  useEffect(() => { if (node.outcome !== null) noteFindRowShown() }, [node.outcome])
  useEffect(() => {
    if (!done) return undefined
    let live = true
    fetch(api('/dsh-market/find-plugin/result') + '?id=' + encodeURIComponent(node.commandId), { cache: 'no-store' })
      .then(res => res.ok ? res.json() as Promise<{ result: FindResult }> : Promise.reject(new Error(String(res.status))))
      .then(body => { if (live) setResult(body.result) })
      .catch(() => { if (live) setMissing(true) })
    return () => { live = false }
  }, [done, node.commandId])

  const request = (node.args ?? '').trim()
  return (
    <div className={css.fpRow} data-dshm-find-plugin>
      <div className={css.fpTitle}>
        <span className={css.fpCmd}>/find-plugin</span>
        {request !== '' && <span className={css.fpRequest}>{request}</span>}
      </div>
      {node.outcome === null && <div className={css.fpNote}>{t('fpRunning')}</div>}
      {node.outcome?.kind === 'error' && <div className={css.fpNote} data-tone="error">{node.outcome.text ?? t('fpFailed')}</div>}
      {done && result !== null && <FindResultView result={result} t={t} navigation={navigation} />}
      {done && result === null && missing && <pre className={css.fpPlain}>{node.outcome?.text ?? ''}</pre>}
    </div>
  )
}

/**
 * A card that throws must not take the chat row (or the chat) with it: fall
 * back to the command's own text, which is always there.
 */
export class FindPluginRowBoundary extends Component<{ fallback: string; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  render(): ReactNode {
    return this.state.failed ? <pre className={css.fpPlain}>{this.props.fallback}</pre> : this.props.children
  }
}

/**
 * The same result in a frame-wide overlay, for a `/find-plugin` run on a
 * blank session where the chat draws no row (see find-plugin-overlay.ts).
 */
export function FindPluginOverlay({ t, navigation }: { t: Translate; navigation?: HostNavigationStore }): ReactElement | null {
  const request = useSyncExternalStore(subscribeOverlay, overlayRequest, () => null)
  const [result, setResult] = useState<FindResult | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setResult(null)
    setFailed(false)
    if (request === null || request.error !== null) return undefined
    let live = true
    fetch(api('/dsh-market/find-plugin/result') + '?session=' + encodeURIComponent(request.sessionId), { cache: 'no-store' })
      .then(res => res.ok ? res.json() as Promise<{ result: FindResult }> : Promise.reject(new Error(String(res.status))))
      .then(body => { if (live) setResult(body.result) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [request])
  useEffect(() => {
    if (request === null) return undefined
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); closeOverlay() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [request])
  if (request === null) return null
  const go = (name: string): void => {
    closeOverlay()
    void goToMarket(name, navigation)
  }
  return (
    <div className={css.fpOverlay} onClick={closeOverlay} data-dshm-find-overlay>
      <div className={css.fpDialog} role="dialog" aria-modal="true" aria-label="/find-plugin" onClick={event => event.stopPropagation()}>
        <div className={css.fpDialogHead}>
          <span className={css.fpCmd}>/find-plugin</span>
          <button type="button" className={css.fpClose} aria-label={t('dismissNotice')} onClick={closeOverlay}>×</button>
        </div>
        {request.error !== null && <div className={css.fpNote} data-tone="error">{request.error || t('fpFailed')}</div>}
        {request.error === null && result === null && !failed && <div className={css.fpNote}>{t('fpRunning')}</div>}
        {failed && <div className={css.fpNote} data-tone="error">{t('fpFailed')}</div>}
        {result !== null && <FindResultView result={result} t={t} navigation={navigation} onOpen={go} />}
      </div>
    </div>
  )
}
