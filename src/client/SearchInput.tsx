import { useRef } from 'react'
import { IconSearchOutline16, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Market.module.css'
import type { Translate } from './market-data.ts'

/** Keep each tab's query in its parent, just like typing or deleting text. */
export function SearchInput({ value, onChange, placeholder, className, t }: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  className: string
  t: Translate
}) {
  const containerRef = useRef<HTMLDivElement>(null)

  function clear() {
    onChange('')
    // The host Input does not forward refs. Scope the lookup to this field
    // so mouse and keyboard activation both return focus to its native input.
    containerRef.current?.querySelector('input')?.focus()
  }

  return (
    <div ref={containerRef} className={`${css.searchField} ${className}`}>
      <Input
        className={css.searchInput}
        icon={<IconSearchOutline16 size={14} />}
        placeholder={placeholder}
        value={value}
        onChange={event => onChange(event.target.value)}
        spellCheck={false}
      />
      {value !== '' && (
        <button type="button" className={css.searchClear} aria-label={t('clearSearch')} onClick={clear}>
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  )
}
