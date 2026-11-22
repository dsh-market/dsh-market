/**
 * "让 AI 猜你喜欢什么插件" under Recently added on the Discover tab.
 *
 * Nothing runs until the user clicks: the click is what lets the market read
 * their installed and favorited plugins and spend their tokens. The picks are
 * drawn as the market's own plugin cards, and the last set is kept on this
 * device so reopening the market shows it again without asking the model.
 */
import { useCallback, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Market.module.css'
import { api } from './market-data.ts'
import { readMarketJson } from './client-version.ts'
import type { RegistryPlugin } from './market-data.ts'
import type { FindResult } from './FindPluginCard.tsx'
import { IconQuestionOutline14 } from './icons.ts'
import { openModelSettings } from './model-settings.ts'

type Translate = (key: string) => string
const STORAGE_KEY = 'dshm-ai-recommend'

type RecState =
  | { phase: 'idle' }
  | { phase: 'running'; previous: string[] }
  | { phase: 'done'; urls: string[] }
  | { phase: 'error'; code: string; message: string }

function readSaved(): string[] | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as { urls?: unknown } | null
    return Array.isArray(value?.urls) ? value.urls.filter((url): url is string => typeof url === 'string') : null
  } catch {
    return null
  }
}

function save(urls: string[] | null): void {
  try {
    if (urls === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify({ urls, at: new Date().toISOString() }))
  } catch { /* storage unavailable: the set just is not kept */ }
}

export function AiRecommend({ t, lang, plugins, render }: {
  t: Translate
  lang: string
  plugins: RegistryPlugin[]
  render: (items: RegistryPlugin[]) => ReactNode
}): ReactElement {
  const [state, setState] = useState<RecState>(() => {
    const urls = readSaved()
    return urls === null ? { phase: 'idle' } : { phase: 'done', urls }
  })
  const [setupFailed, setSetupFailed] = useState(false)
  const seq = useRef(0)

  const byUrl = useMemo(() => new Map(plugins.map(plugin => [plugin.url, plugin])), [plugins])
  const namesOf = useCallback((urls: string[]) => urls.flatMap(url => byUrl.get(url)?.name ?? []), [byUrl])

  const run = useCallback((exclude: string[]) => {
    const mine = ++seq.current
    setSetupFailed(false)
    setState({ phase: 'running', previous: exclude })
    fetch(api('/dsh-market/ai-recommend'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exclude, lang }),
    })
      .then(res => readMarketJson<{ result?: FindResult }>(res))
      .then(({ ok, body }) => {
        if (mine !== seq.current) return
        if (ok && body.result !== undefined) {
          const urls = body.result.picks.map(pick => pick.url)
          save(urls)
          setState({ phase: 'done', urls })
        } else setState({ phase: 'error', code: body.code ?? 'model-failed', message: body.error ?? '' })
      })
      .catch((error: unknown) => {
        if (mine === seq.current) setState({ phase: 'error', code: 'model-failed', message: error instanceof Error ? error.message : String(error) })
      })
  }, [lang])

  const close = useCallback(() => {
    seq.current += 1
    save(null)
    setState({ phase: 'idle' })
  }, [])

  const setup = useCallback(() => {
    void openModelSettings().then(ok => { if (!ok) setSetupFailed(true) })
  }, [])

  if (state.phase === 'idle') {
    return (
      <div className={css.recTrigger} data-dshm-ai-recommend="idle">
        <button type="button" className={css.fpLink} onClick={() => run([])}>{t('recTrigger')}</button>
        <Tooltip label={t('recHelp')} side="bottom" delayMs={150} portal maxWidth={320}>
          <span className={css.aiHelp} tabIndex={0} aria-label={t('recHelp')}><IconQuestionOutline14 size={14} /></span>
        </Tooltip>
      </div>
    )
  }

  const items = state.phase === 'done' ? state.urls.flatMap(url => byUrl.get(url) ?? []) : []
  return (
    <section className={css.recBlock} aria-labelledby="dshm-ai-recommend" data-dshm-ai-recommend={state.phase}>
      <div className={css.recHead}>
        <h3 id="dshm-ai-recommend" className={css.favoritesSectionHead}>{t('recTitle')}</h3>
        <span className={css.recActions}>
          {state.phase === 'done' && <Button variant="ghost" size="sm" className={css.recentHide} onClick={() => run(namesOf(state.urls))}>{t('recMore')}</Button>}
          <Button variant="ghost" size="sm" className={css.recentHide} onClick={close}>{t('recClose')}</Button>
        </span>
      </div>
      <div className={css.recStatus}>
        {state.phase === 'running' && <span>{t('recRunning')}</span>}
        {state.phase === 'done' && <span>{items.length === 0 ? t('recEmpty') : t('fpFoot')}</span>}
        {state.phase === 'error' && state.code === 'no-model' && (
          <>
            <span data-tone="error">{t('recNoModel')}</span>
            <Button size="sm" variant="primary" onClick={setup}>{t('recSetupModel')}</Button>
            {setupFailed && <span>{t('recSetupManual')}</span>}
          </>
        )}
        {state.phase === 'error' && state.code === 'no-seeds' && <span>{t('recNoSeeds')}</span>}
        {state.phase === 'error' && state.code === 'stale-server' && <span data-tone="error">{t('staleServer')}</span>}
        {state.phase === 'error' && state.code !== 'no-model' && state.code !== 'no-seeds' && state.code !== 'stale-server' && (
          <>
            <span data-tone="error">{t('recFailed') + (state.code === 'bad-reply' ? t('badReply') : state.message)}</span>
            <Button size="sm" variant="outline" onClick={() => run([])}>{t('recRetry')}</Button>
          </>
        )}
      </div>
      {items.length > 0 && render(items)}
    </section>
  )
}
