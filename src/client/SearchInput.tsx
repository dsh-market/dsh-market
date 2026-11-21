import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Input, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Market.module.css'
import { IconQuestionOutline14, IconSearchOutline16 } from './icons.ts'
import { HostSwitch } from './optional-primitives.ts'
import type { Translate } from './market-data.ts'

export const SEARCH_DELAY_MS = 250

/** Keep keystrokes out of the market's large render tree, not just its filter.
 * Only settled queries reach the parent. Explicit navigation remains immediate.
 *
 * The clear control lives in here rather than at the call sites (#524 by
 * @bulingbuling688, whose clear button reached the same four fields from
 * outside this component). Two things made the difference:
 *
 * - it has to clear the DRAFT, not the committed query. Between a keystroke
 *   and the 250ms commit, the text on screen and the parent's `value` are
 *   different strings; a button that only reset `value` would leave the old
 *   text visible until the effect below rewrote the draft, and would schedule
 *   its own debounce on the way out.
 * - the padding that keeps a long query off the button belongs to whoever
 *   renders the button. As a prop of the call sites it is a rule four rows
 *   have to remember and a fifth would forget.
 */
/**
 * Optional AI mode (the Discover tab's search): a switch inside the field. In
 * AI mode typing does not filter; Enter hands the sentence to the user's own
 * model, so tokens are spent only when they ask.
 */
export interface SearchAiMode {
  on: boolean
  toggle(): void
  submit(query: string): void
  placeholder: string
}

export function SearchInput({ value, onCommit, className, placeholder, resetToken, t, ai }: {
  value: string
  onCommit: (value: string) => void
  className?: string
  placeholder?: string
  /** Explicit navigation can repeat the already committed query. */
  resetToken?: number
  t: Translate
  ai?: SearchAiMode
}) {
  const aiOn = ai?.on === true
  const [draft, setDraft] = useState(value)
  const field = useRef<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const composing = useRef(false)
  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }, [])
  const commit = (next: string) => {
    cancel()
    onCommit(next)
  }
  const schedule = (next: string) => {
    cancel()
    if (composing.current || aiOn) return
    if (next === '') commit(next)
    else timer.current = setTimeout(() => commit(next), SEARCH_DELAY_MS)
  }

  /**
   * Clear what is on screen and what the parent filters by, now.
   *
   * `commit('')` also cancels a debounce that is already in flight — without
   * that, clearing during the 250ms gap would let the old query land after
   * the clear and re-filter the list the user just emptied.
   */
  const clear = () => {
    setDraft('')
    commit('')
    // The host Input renders the native element internally and does not
    // forward a ref, so focus is returned through this component's own
    // container: keyboard users land back in the field they were typing in,
    // not on the button they just pressed.
    field.current?.querySelector('input')?.focus()
  }

  // A deep link/replacement action can change the query without typing.
  useLayoutEffect(() => {
    cancel()
    setDraft(value)
  }, [value, resetToken, cancel])
  // Switching tabs/unmounting must not apply a stale query later.
  useEffect(() => cancel, [cancel])

  return <div ref={field} data-ai={ai !== undefined ? '' : undefined} className={className === undefined ? css.searchField : `${css.searchField} ${className}`}>
    <Input
      className={css.searchInput}
      icon={<IconSearchOutline16 size={14} />}
      placeholder={aiOn ? ai!.placeholder : placeholder}
      value={draft}
      // A plugin name is not prose: the browser's red squiggles under
      // `dsh-session-manager` are noise on a field that only ever takes names.
      spellCheck={false}
      onChange={event => {
        const next = event.target.value
        setDraft(next)
        schedule(next)
      }}
      onCompositionStart={() => { composing.current = true; cancel() }}
      onCompositionEnd={event => {
        composing.current = false
        const next = event.currentTarget.value
        setDraft(next)
        schedule(next)
      }}
      onKeyDown={event => {
        if (event.key === 'Enter' && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) {
          if (aiOn) ai!.submit(event.currentTarget.value)
          else commit(event.currentTarget.value)
        }
      }}
      onBlur={event => {
        if (!composing.current && !aiOn) commit(event.currentTarget.value)
      }}
    />
    {draft !== '' && (
      <button
        type="button"
        className={css.searchClear}
        aria-label={t('clearSearch')}
        // Keep focus in the field while the button is pressed. Otherwise the
        // press blurs the input, onBlur commits the query that was still
        // inside its 250ms wait, the list reflows (e.g. to "No plugins
        // match"), the button moves, and the release lands elsewhere — so the
        // clear never happens. Clearing should never apply the old query first.
        onMouseDown={event => event.preventDefault()}
        onClick={clear}
      >
        <span aria-hidden="true">×</span>
      </button>
    )}
    {ai !== undefined && (
      <span className={css.aiGroup} onMouseDown={event => event.preventDefault()}>
        <Tooltip label={t('aiSearchHelp')} side="bottom" delayMs={150} portal maxWidth={320}>
          <span className={css.aiHelp} tabIndex={0} aria-label={t('aiSearchHelp')}><IconQuestionOutline14 size={14} /></span>
        </Tooltip>
        <span className={css.aiLabel}>{t('aiSearchLabel')}</span>
        {(() => {
          const toggleAi = (): void => {
            // Leaving AI mode applies what is typed as an ordinary filter;
            // entering it drops the filter so the list is not half-filtered.
            if (aiOn) commit(draft)
            else commit('')
            ai.toggle()
            field.current?.querySelector('input')?.focus()
          }
          return HostSwitch !== null
            ? <HostSwitch checked={aiOn} onChange={toggleAi} label={t('aiSearchLabel')} />
            : <button type="button" role="switch" aria-checked={aiOn} aria-label={t('aiSearchLabel')} className={aiOn ? `${css.switch} ${css.switchOn}` : css.switch} onClick={toggleAi}><span className={css.switchKnob} /></button>
        })()}
      </span>
    )}
  </div>
}
