/**
 * AI search on the Discover tab: the user's default DSH model reads a
 * sentence and picks plugins from the catalog (same recall-then-pick as
 * `/find-plugin`). Off by default; it costs the user's tokens, so it runs only
 * on Enter while the switch is on.
 */
import { useCallback, useRef, useState, type ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Market.module.css'
import { api } from './market-data.ts'
import type { FindPick, FindResult } from './FindPluginCard.tsx'
import type { SearchAiMode } from './SearchInput.tsx'

type Translate = (key: string) => string
const STORAGE_KEY = 'dshm-ai-search'

type AiState =
  | { phase: 'idle' }
  | { phase: 'running'; query: string }
  | { phase: 'done'; query: string; result: FindResult }
  | { phase: 'error'; query: string; code: string; message: string }

export function useAiSearch(t: Translate): { mode: SearchAiMode; status: ReactElement | null; picks: FindPick[] | null } {
  const [on, setOn] = useState(() => { try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false } })
  const [state, setState] = useState<AiState>({ phase: 'idle' })
  const seq = useRef(0)

  const submit = useCallback((raw: string) => {
    const query = raw.trim()
    if (query === '') return
    const mine = ++seq.current
    setState({ phase: 'running', query })
    fetch(api('/dsh-market/ai-search'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    })
      .then(res => res.json().then((body: { result?: FindResult; code?: string; error?: string }) => ({ ok: res.ok, body })))
      .then(({ ok, body }) => {
        if (mine !== seq.current) return
        if (ok && body.result !== undefined) setState({ phase: 'done', query, result: body.result })
        else setState({ phase: 'error', query, code: body.code ?? 'model-failed', message: body.error ?? '' })
      })
      .catch((error: unknown) => {
        if (mine === seq.current) setState({ phase: 'error', query, code: 'model-failed', message: error instanceof Error ? error.message : String(error) })
      })
  }, [])

  const toggle = useCallback(() => {
    setOn(prev => {
      const next = !prev
      try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0') } catch { /* storage unavailable */ }
      if (!next) { seq.current += 1; setState({ phase: 'idle' }) }
      return next
    })
  }, [])

  // In the market the picks are drawn as the market's own plugin cards (by the
  // Discover tab); this hook only owns the line above them: what is happening,
  // the model's one-sentence framing, or why it failed.
  let status: ReactElement | null = null
  if (on) {
    status = (
      <div className={css.aiStatus} data-dshm-ai-search>
        {state.phase === 'idle' && <span className={css.aiHint}>{t('aiSearchHint')}</span>}
        {state.phase === 'running' && <span className={css.aiHint}>{t('aiSearchRunning')}</span>}
        {state.phase === 'error' && (
          <span className={css.fpNote} data-tone="error">
            {state.code === 'no-model' ? t('aiSearchNoModel') : t('aiSearchFailed') + state.message}
            {state.code !== 'no-model' && <> <Button size="sm" variant="outline" onClick={() => submit(state.query)}>{t('aiSearchRetry')}</Button></>}
          </span>
        )}
        {state.phase === 'done' && (
          <>
            <span className={css.aiHint}>{t('fpFoot')}</span>
          </>
        )}
      </div>
    )
  }
  const picks: FindPick[] | null = on && state.phase === 'done' ? state.result.picks : null
  return { mode: { on, toggle, submit, placeholder: t('aiSearchOn') }, status, picks }
}
