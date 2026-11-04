/**
 * "View source" on the host's plugin detail page: its own source fact is an
 * install spec, a version range nobody can open. Resolved per installed
 * package; absent when nothing declares a repository.
 */
import { useEffect, useState } from 'react'
import css from './Market.module.css'
import { api } from './market-data.ts'
import type { Translate } from './market-data.ts'

/** Answers already read, by package name. Only definite ones are cached, so a failed request retries. */
const resolved = new Map<string, string | null>()

export function SourceRepoLink(props: { name: string; t: Translate }) {
  const { name, t } = props
  const [url, setUrl] = useState<string | null>(() => resolved.get(name) ?? null)

  useEffect(() => {
    const known = resolved.get(name)
    if (known !== undefined) {
      setUrl(known)
      return
    }
    let live = true
    // `api()` returns the pathname, so the query has to be appended after it.
    fetch(`${api('/dsh-market/source-repo')}?name=${encodeURIComponent(name)}`)
      .then(async (res) => (res.ok ? (await res.json()) as { url?: unknown } : null))
      .then((body) => {
        // An href is only safe when it is https: the route builds one from
        // sourceWebUrl today, but it is still another server's answer, and a
        // `javascript:` value here would be a script rather than a link.
        const next = typeof body?.url === 'string' && body.url.startsWith('https://') ? body.url : null
        resolved.set(name, next)
        if (live) setUrl(next)
      })
      .catch(() => { /* No row; the page reads fine without it. */ })
    return () => { live = false }
  }, [name])

  if (url === null) return null
  // The arrow is part of `viewSourceRepo`, so no glyph is drawn here.
  return (
    <a className={css.sourceRepo} href={url} target="_blank" rel="noreferrer">
      {t('viewSourceRepo')}
    </a>
  )
}
