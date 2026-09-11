import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconSearchOutline16, Input } from '@deepseek-ai/dsh-client-ui-primitives'

export const SEARCH_DELAY_MS = 250

/** Keep keystrokes out of the market's large render tree, not just its filter.
 * Only settled queries reach the parent. Explicit navigation remains immediate.
 */
export function SearchInput({ value, onCommit, className, placeholder, resetToken }: {
  value: string
  onCommit: (value: string) => void
  className?: string
  placeholder?: string
  /** Explicit navigation can repeat the already committed query. */
  resetToken?: number
}) {
  const [draft, setDraft] = useState(value)
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
    if (composing.current) return
    if (next === '') commit(next)
    else timer.current = setTimeout(() => commit(next), SEARCH_DELAY_MS)
  }

  // A deep link/replacement action can change the query without typing.
  useLayoutEffect(() => {
    cancel()
    setDraft(value)
  }, [value, resetToken, cancel])
  // Switching tabs/unmounting must not apply a stale query later.
  useEffect(() => cancel, [cancel])

  return <Input
    className={className}
    icon={<IconSearchOutline16 size={14} />}
    placeholder={placeholder}
    value={draft}
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
        commit(event.currentTarget.value)
      }
    }}
    onBlur={event => {
      if (!composing.current) commit(event.currentTarget.value)
    }}
  />
}
