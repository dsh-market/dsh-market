/**
 * The three small pieces that exist only when more than the public catalog is
 * configured: the tag on a card, the source filter, and the notice for a
 * catalog that could not be read.
 *
 * All three render nothing for someone who uses the public catalog alone, so
 * an ordinary card, an ordinary Discover page and an ordinary failure screen
 * are exactly what they were.
 */

import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import { useSyncExternalStore } from 'react'
import css from './Market.module.css'
import {
  loadedSources, sourceErrorText, sourceLabel,
  type CatalogSourceInfo, type Registry, type RegistryPlugin, type Translate,
} from './market-data.ts'
import { sourceStatus } from './source-status.ts'

/** The quiet tag naming where a non-public entry came from. */
export function SourceTag({ plugin, lang }: { plugin: Pick<RegistryPlugin, 'source'>; lang: string }) {
  if (plugin.source === undefined) return null
  const label = sourceLabel(plugin.source.label, lang)
  if (label === '') return null
  return <span className={`${css.tag} ${css.srcTag}`} title={label}>{label}</span>
}

/** "Version set by your organization": the plugin installs and updates only to this release. */
export function PinnedNote({ plugin, t }: { plugin: Pick<RegistryPlugin, 'pinned'>; t: Translate }) {
  if (plugin.pinned === undefined) return null
  const text = t('pinnedByOrg').replace('{0}', plugin.pinned)
  return <span className={`${css.tag} ${css.srcTag}`} title={text}>{text}</span>
}

/**
 * "All sources / Public / Acme": only when at least two catalogs loaded —
 * with one there is nothing to choose between.
 */
export function SourceFilter({ data, active, onPick, lang, t }: {
  data: Pick<Registry, 'sources'>
  active: string
  onPick: (id: string) => void
  lang: string
  t: Translate
}) {
  const sources = loadedSources(data)
  if (sources.length < 2) return null
  return (
    <div className={css.srcFilter} role="group" aria-label={t('srcFilterLabel')}>
      <Pill active={active === 'all'} onClick={() => { onPick('all') }}>{t('srcAll')}</Pill>
      {sources.map(source => (
        <Pill key={source.id} active={active === source.id} onClick={() => { onPick(source.id) }}>
          {sourceLabel(source.label, lang)}
        </Pill>
      ))}
    </div>
  )
}

/**
 * Every catalog that could not be read, by name, with what to do and a retry.
 * Shown above the list when something else did load, and on its own when
 * nothing did.
 */
export function SourceProblems({ sources, lang, t, onRetry }: {
  sources: readonly CatalogSourceInfo[]
  lang: string
  t: Translate
  onRetry: () => void
}) {
  if (sources.length === 0) return null
  return (
    <div className={css.srcProblems} role="status">
      {sources.map(source => (
        <div key={source.id} className={css.srcProblem} title={source.error?.detail}>
          <span>
            <strong>{sourceLabel(source.label, lang)}</strong>
            {' '}
            {t('srcFailed')}
            {' '}
            {sourceErrorText(source.error, t)}
          </span>
        </div>
      ))}
      <Button variant="outline" size="sm" className={css.retryBtn} onClick={onRetry}>{t('loadRetry')}</Button>
    </div>
  )
}

/** The failed sources of the latest catalog read; empty (and inert) for the public catalog alone. */
export function useFailedSources(): CatalogSourceInfo[] {
  return useSyncExternalStore(sourceStatus.subscribe, sourceStatus.getSnapshot)
}
