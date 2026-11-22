/**
 * "Plugin catalogs" in the market's settings card: the public catalog, the
 * ones the organization set (locked), and the user's own (removable), plus the
 * one control that adds a catalog.
 *
 * Quiet by default: someone who uses only the public catalog sees one line
 * and an "Add catalog" button. Errors appear only on the row they belong to,
 * in the same what / why / what-next shape as everywhere else.
 *
 * Adding is a single step. The address is read once to prove it is a catalog;
 * only then is it saved, so the list never holds something that never worked.
 * Removing is immediate and needs no confirmation: adding it again brings it
 * back.
 */

import { createElement as h, useCallback, useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Market.module.css'
import { api, sourceErrorText, sourceLabel } from './market-data.ts'
import type { CatalogSourceInfo, LocalizedText, SourceError, Translate } from './market-data.ts'
import { discoveryScan } from './MarketImages.tsx'

/** What `/dsh-market/catalogs` answers. */
export interface CatalogsData {
  sources: CatalogSourceInfo[]
  publicCatalog: { enabled: boolean; locked: boolean }
  userCatalogsAllowed: boolean
  limit: number
  problems: Array<{ zh: string; en: string }>
}

/** Read the server's answer; null for a server that predates it (or any other reply). */
export function readCatalogs(body: unknown): CatalogsData | null {
  if (body === null || typeof body !== 'object') return null
  const raw = body as Record<string, unknown>
  if (!Array.isArray(raw.sources)) return null
  const pub = raw.publicCatalog as { enabled?: unknown; locked?: unknown } | undefined
  return {
    sources: raw.sources as CatalogSourceInfo[],
    publicCatalog: { enabled: pub?.enabled !== false, locked: pub?.locked === true },
    userCatalogsAllowed: raw.userCatalogsAllowed !== false,
    limit: typeof raw.limit === 'number' ? raw.limit : 8,
    problems: Array.isArray(raw.problems) ? raw.problems as CatalogsData['problems'] : [],
  }
}

/**
 * Whether the block has anything to say or do. Hidden only when the
 * organization forbids adding and there is nothing else to show.
 */
export function catalogsVisible(data: CatalogsData | null): data is CatalogsData {
  return data !== null && (data.userCatalogsAllowed || data.sources.some(source => source.kind !== 'public')
    || data.problems.length > 0 || data.publicCatalog.locked)
}

/** "1 plugin" / "12 plugins": one place, so every row says it the same way. */
const countText = (t: Translate, count: number): string =>
  count === 1 ? t('setCatalogCountOne') : t('setCatalogCount').replace('{0}', String(count))

const ADD_ERRORS: Record<string, string> = {
  empty: 'setCatalogErrEmpty',
  unrecognized: 'setCatalogErrAddress',
  credentials: 'setCatalogErrCreds',
  duplicate: 'setCatalogErrDuplicate',
  limit: 'setCatalogErrLimit',
  locked: 'setCatalogErrLocked',
}

export interface CatalogsPanelProps {
  data: CatalogsData
  t: Translate
  lang: string
  /** Re-read the list after a change. */
  reload: () => Promise<void>
}

export function CatalogsPanel({ data, t, lang, reload }: CatalogsPanelProps): ReactElement {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null)

  const changed = useCallback(async (): Promise<void> => {
    await reload()
    // The market page, if it is open, shows the new list without a refresh.
    void discoveryScan.resume().catch(() => { /* the page reports its own failure */ })
  }, [reload])

  const onAdd = useCallback(() => {
    setBusy(true)
    setMessage({ text: t('setCatalogChecking'), bad: false })
    void (async () => {
      try {
        const response = await fetch(api('/dsh-market/catalogs/add'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: draft }),
        })
        const body = await response.json() as {
          ok?: boolean; count?: number; code?: string; limit?: number; source?: SourceError; error?: string
        }
        if (body.ok === true) {
          setMessage({ text: body.count === 1 ? t('setCatalogAddedOne') : t('setCatalogAdded').replace('{0}', String(body.count ?? 0)), bad: false })
          setDraft('')
          setAdding(false)
          await changed()
        } else if (body.code === 'unreadable') {
          setMessage({ text: sourceErrorText(body.source, t), bad: true })
        } else {
          const key = ADD_ERRORS[body.code ?? '']
          setMessage({ text: key === undefined ? (body.error ?? t('srcErrNetwork')) : t(key).replace('{0}', String(body.limit ?? data.limit)), bad: true })
        }
      } catch {
        setMessage({ text: t('srcErrNetwork'), bad: true })
      } finally {
        setBusy(false)
      }
    })()
  }, [changed, data.limit, draft, t])

  const onRemove = useCallback((id: string) => {
    setBusy(true)
    setMessage(null)
    void (async () => {
      try {
        const response = await fetch(api('/dsh-market/catalogs/remove'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        })
        const body = await response.json() as { ok?: boolean; error?: string }
        if (body.ok !== true) setMessage({ text: body.error ?? t('srcErrNetwork'), bad: true })
        else await changed()
      } catch {
        setMessage({ text: t('srcErrNetwork'), bad: true })
      } finally {
        setBusy(false)
      }
    })()
  }, [changed, t])

  const publicInfo = data.sources.find(source => source.id === 'public')
  const others = data.sources.filter(source => source.id !== 'public')
  const nameOf = (label: LocalizedText): string => sourceLabel(label, lang)

  const publicMeta = !data.publicCatalog.enabled
    ? `${t('setCatalogOff')} · ${t('setCatalogOrg')}`
    : publicInfo?.status === 'ok' ? countText(t, publicInfo.count) : ''

  const sourceRow = (source: CatalogSourceInfo): ReactElement => h('div', { key: source.id, className: css.setCatalogRow },
    h('div', { className: css.setCatalogName },
      h('div', { className: css.setLabel }, nameOf(source.label)),
      h('div', { className: css.setCatalogMeta },
        [source.status === 'ok' ? countText(t, source.count) : '', source.where].filter(Boolean).join(' · ')),
      source.status === 'failed'
        ? h('div', { className: css.setCatalogErr, title: source.error?.detail }, sourceErrorText(source.error, t))
        : null,
    ),
    source.locked
      ? h('span', { className: css.setCatalogLock }, t('setCatalogOrg'))
      : h(Button, {
          variant: 'ghost', size: 'sm', disabled: busy,
          'aria-label': `${t('setCatalogRemove')} ${nameOf(source.label)}`,
          onClick: () => { onRemove(source.id) },
        }, t('setCatalogRemove')),
  )

  return h('div', { className: css.setConfirm },
    h('div', { className: css.setLabel }, t('setCatalogs')),
    h('div', { className: css.setHint }, t('setCatalogsHint')),
    h('div', { className: css.setCatalogList },
      h('div', { className: css.setCatalogRow },
        h('div', { className: css.setCatalogName },
          h('div', { className: css.setLabel }, t('setCatalogPublic')),
          publicMeta === '' ? null : h('div', { className: css.setCatalogMeta }, publicMeta),
          publicInfo?.status === 'failed'
            ? h('div', { className: css.setCatalogErr, title: publicInfo.error?.detail }, sourceErrorText(publicInfo.error, t))
            : null,
        ),
        data.publicCatalog.locked ? h('span', { className: css.setCatalogLock }, t('setCatalogOrg')) : null,
      ),
      others.map(sourceRow),
    ),
    data.problems.length > 0
      ? h('div', { className: css.setCatalogErr },
          h('div', null, t('setCatalogPolicyProblem')),
          data.problems.map((problem, index) => h('div', { key: index }, lang === 'zh' ? problem.zh : problem.en)))
      : null,
    adding
      ? h('div', { className: css.setProxyEditor },
          h('label', { className: css.setProxyLabel },
            t('setCatalogInput'),
            h('input', {
              className: css.setProxyInput,
              type: 'text',
              value: draft,
              placeholder: 'https://plugins.example.com/plugins.json',
              'aria-label': t('setCatalogInput'),
              disabled: busy,
              spellCheck: false,
              onChange: (event: { currentTarget: { value: string } }) => { setDraft(event.currentTarget.value) },
            }),
          ),
          h('div', { className: css.setHint }, t('setCatalogInputHint')),
          h('div', { className: css.setInlineActions },
            h(Button, {
              variant: 'ghost', size: 'sm', disabled: busy,
              onClick: () => { setAdding(false); setMessage(null) },
            }, t('setSelfCancel')),
            h(Button, {
              variant: 'primary', size: 'sm', disabled: busy || draft.trim() === '',
              onClick: onAdd,
            }, t('setCatalogSave')),
          ),
        )
      : data.userCatalogsAllowed
        ? h('div', { className: css.setInlineActions },
            h(Button, {
              variant: 'outline', size: 'sm', disabled: busy,
              onClick: () => { setAdding(true); setMessage(null) },
            }, t('setCatalogAdd')),
          )
        : null,
    message === null
      ? null
      : h('div', { className: message.bad ? css.setCatalogErr : css.setHint, role: 'status' }, message.text),
  )
}
