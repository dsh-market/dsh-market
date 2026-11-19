/**
 * Markdown rendering for release notes and the update-notes body shown in the notes pane.
 */

import css from './Market.module.css'
import { displayLatest, releaseNotesHttpsImage, sanitizeReleaseNotesBody, type Translate } from './market-data.ts'
import { GithubRoutedImg } from './MarketImages.tsx'
import { parseSourceUrl } from '../sources.ts'

/**
 * Card avatar: the plugin owner's GitHub avatar (no API, browser-cached),
 * falling back to the initial-letter tile when it can't load.
 */
/** Inline pass: links, `code`, **bold**; everything else plain text. */
function mdInline(text: string): Array<string | JSX.Element> {
  return text.split(/(\[[^\]]+\]\(\s*https:\/\/[^)\s]+\s*\)|\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    const link = /^\[([^\]]+)\]\(\s*(https:\/\/[^)\s]+)\s*\)$/u.exec(part)
    if (link !== null) {
      return (
        <a key={i} className={css.notesA} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      )
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={i} className={css.notesCode}>{part.slice(1, -1)}</code>
    }
    return part
  })
}

function renderMarkdown(md: string): Array<JSX.Element | string> {
  const out: Array<JSX.Element | string> = []
  let bullets: string[] | null = null
  let fence: string[] | null = null
  const flushList = (): void => {
    if (bullets === null) return
    const items = bullets
    out.push(<ul key={`l${out.length}`} className={css.notesBullets}>{items.map((item, i) => <li key={i}>{mdInline(item)}</li>)}</ul>)
    bullets = null
  }
  const flushFence = (): void => {
    if (fence === null) return
    const body = fence.join('\n')
    out.push(<pre key={`c${out.length}`} className={css.notesFence}><code>{body}</code></pre>)
    fence = null
  }
  for (const line of sanitizeReleaseNotesBody(md).split('\n')) {
    const trimmed = line.trim()
    if (fence !== null) {
      if (/^```/.test(trimmed)) {
        flushFence()
      } else {
        fence.push(line.replace(/\s+$/u, ''))
      }
      continue
    }
    if (/^```/.test(trimmed)) {
      flushList()
      fence = []
      continue
    }
    if (trimmed === '') { flushList(); continue }
    const image = releaseNotesHttpsImage(trimmed)
    if (image !== null) {
      flushList()
      out.push(
        <GithubRoutedImg
          key={`i${out.length}`}
          className={css.notesImg}
          src={image.src}
          alt={image.alt}
        />,
      )
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed)
    if (heading !== null) {
      flushList()
      out.push(<div key={`h${out.length}`} className={css.notesH}>{mdInline(heading[1]!)}</div>)
      continue
    }
    const quote = /^>\s?(.*)$/u.exec(trimmed)
    if (quote !== null) {
      flushList()
      out.push(<div key={`q${out.length}`} className={css.notesQuote}>{mdInline(quote[1]!)}</div>)
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed)
    if (bullet !== null) {
      ;(bullets ??= []).push(bullet[1]!)
      continue
    }
    flushList()
    out.push(<div key={`p${out.length}`} className={css.notesP}>{mdInline(line)}</div>)
  }
  flushList()
  flushFence()
  return out
}

type NoteRelease = { tag: string | null; name: string | null; publishedAt: string | null; url: string | null; body: string }
type NoteCommit = { sha: string; message: string; date: string | null }
type NoteCommits = { items: NoteCommit[]; found: boolean }
export type ResolvedNotes = (
  | { kind: 'release'; release: NoteRelease; beyondTarget?: string; commits?: NoteCommits }
  | { kind: 'commits'; commits: NoteCommits }
  | { kind: 'npm'; npmTimes: Array<{ version: string; date: string }> }
  | { kind: 'source'; sourceUrl?: string | null; reason?: 'missing' | 'unavailable' | 'unreadable' }
  | { kind: 'none' }
) & { history?: { items: Array<NoteRelease & { version: string }>; partial: boolean } }

function notesReleaseBody(release: NoteRelease | null | undefined): string {
  return typeof release?.body === 'string' && release.body.trim() !== '' ? release.body : ''
}

/** Bind a supplied release page to the repository and the selected release tag. */
function notesReleasePage(repo: string | undefined, release?: NoteRelease): string | null {
  if (repo === undefined) return null
  const canonicalRepo = repo.replace(/\.git$/iu, '')
  if (canonicalRepo.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) return null
  const releasesPath = '/' + canonicalRepo + '/releases'
  const releasesUrl = 'https://github.com' + releasesPath
  if (release?.url && release.tag) {
    try {
      const page = new URL(release.url)
      const tagPrefix = releasesPath + '/tag/'
      if (page.origin === 'https://github.com' && page.username === '' && page.password === ''
        && page.pathname.slice(0, tagPrefix.length).toLowerCase() === tagPrefix.toLowerCase()
        && decodeURIComponent(page.pathname.slice(tagPrefix.length)) === release.tag) {
        return page.origin + page.pathname
      }
    } catch { /* Recorded page is unusable; send the reader to the repository's releases. */ }
  }
  return releasesUrl
}

export function UpdateNotesContent({ notes, name, target, repoUrl, t, lang }: {
  notes: ResolvedNotes; name: string; target: string | null; repoUrl: string | null; t: Translate; lang: 'zh' | 'en'
}) {
  const items = notes.history?.items ?? []
  const release = notes.kind === 'release' ? notes.release : null
  const beyondTarget = notes.kind === 'release' ? notes.beyondTarget : undefined
  const versionOf = (value: string | null) => value?.replace(/^v(?=\d)/i, '')
  // Git history is returned only for an exact release match, which is the first item.
  const expandedVersion = target !== null && /^[0-9a-f]{40}$/i.test(target) ? items[0]?.version : versionOf(target)
  const snapshotRelease = beyondTarget === undefined ? release : null
  const matchesSnapshot = (item: typeof items[number]): boolean => snapshotRelease !== null &&
    ((snapshotRelease.tag !== null && snapshotRelease.tag === item.tag) || versionOf(snapshotRelease.tag) === versionOf(item.version))
  const legacyRelease = items.some(matchesSnapshot) ? null : snapshotRelease
  const snapshotBody = notesReleaseBody(snapshotRelease)
  const history = snapshotBody !== ''
    ? items.map(item => notesReleaseBody(item) === '' && item.tag !== null && item.tag === snapshotRelease?.tag
      ? { ...item, body: snapshotBody } : item)
    : items
  const commits = notes.kind === 'commits' || (notes.kind === 'release' && (notes.commits?.items.length ?? 0) > 0)
    ? notes.commits : undefined
  const sourceUrl = notes.kind === 'source' ? notes.sourceUrl ?? '' : ''
  const repo = parseSourceUrl(repoUrl ?? '')?.repo ?? parseSourceUrl(sourceUrl)?.repo
  const targetRelease = history.find(item => versionOf(item.version) === expandedVersion)
    ?? (expandedVersion !== undefined && versionOf(legacyRelease?.tag ?? null) === expandedVersion
      ? legacyRelease ?? undefined : undefined)
  const targetBodyMissing = targetRelease !== undefined && notesReleaseBody(targetRelease) === ''
  const legacyBody = notesReleaseBody(legacyRelease)
  const historyIncomplete = notes.history?.partial === true
    || (history.length === 0 && (notes.history !== undefined || notes.kind === 'none'))
  const showSourceNotice = notes.kind === 'source' && (!historyIncomplete || notes.reason === 'unreadable')
  const missingNotes = (message: string, page: string | null) => (
    <>
      {message}{lang === 'zh' ? '' : ' '}
      {page === null ? t('notesHistoryRetry') : (
        <a className={css.notesSourceLink} href={page} target="_blank" rel="noreferrer">{t('notesHistoryReleasePage')}</a>
      )}
    </>
  )
  const historyHint = !targetBodyMissing && historyIncomplete && !showSourceNotice
    ? <div className={css.spec}>{missingNotes(t(history.length === 0 ? 'notesHistoryEmpty' : 'notesHistoryPartial'), notesReleasePage(repo))}</div>
    : null

  return (
    <div className={css.notesBody}>
      {history.length === 0 && historyHint}
      {history.length > 0 && (
        <section className={css.notesHistory}>
          <div className={css.notesMeta}><strong>{t('notesHistory')}</strong></div>
          {historyHint}
          {history.map(item => (
            <details key={item.version} className={css.notesEntry} open={versionOf(item.version) === expandedVersion}>
              <summary className={css.notesSummary}>
                <strong>{displayLatest(item.version)}</strong>
                {item.publishedAt !== null && <span className={css.notesDate}>{' · ' + item.publishedAt.slice(0, 10)}</span>}
              </summary>
              <div className={css.notesRendered}>
                {notesReleaseBody(item) !== '' ? renderMarkdown(item.body)
                  : item === targetRelease
                    ? missingNotes(t('notesHistoryVersionMissing'), notesReleasePage(repo, item))
                    : t('notesHistoryVersionMissing')}
              </div>
            </details>
          ))}
        </section>
      )}
      {legacyRelease !== null && (legacyBody !== '' || historyHint === null) && (
        <>
          <div className={css.notesMeta}>
            <strong>{t('notesRelease')}</strong>
            {legacyRelease.tag !== null && <span>{legacyRelease.tag}</span>}
            {legacyRelease.publishedAt !== null && <span>{' · ' + legacyRelease.publishedAt.slice(0, 10)}</span>}
          </div>
          <div className={css.notesRendered}>
            {legacyBody === ''
              ? missingNotes(t('notesHistoryVersionMissing'), notesReleasePage(repo, legacyRelease))
              : renderMarkdown(legacyBody)}
          </div>
        </>
      )}
      {commits !== undefined && (
        <>
          <div className={css.notesMeta}><strong>{t('notesCommits')}</strong></div>
          {!commits.found && <div className={css.notesMeta}>{t('notesCommitsRecent')}</div>}
          <ul className={css.notesList}>
            {commits.items.map(c => (
              <li key={c.sha} className={css.notesRow}>
                <span className={css.notesDate}>{c.date !== null ? c.date.slice(0, 10) : ''}</span>
                <span className={css.notesMsg}>{mdInline(c.message)}</span>
                {repoUrl !== null && (
                  <a className={css.notesSha} href={repoUrl + '/commit/' + c.sha}
                    target="_blank" rel="noreferrer" title={c.message}>{c.sha.slice(0, 7)}</a>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {notes.kind === 'npm' && (
        <>
          <div className={css.notesMeta}><strong>{t('notesNpm')}</strong></div>
          <ul className={css.notesList}>
            {notes.npmTimes.map(v => (
              <li key={v.version} className={css.notesRow}>
                <span className={css.notesDate}>{v.date.slice(0, 10)}</span>
                <a className={css.notesVer}
                  href={`https://www.npmjs.com/package/${encodeURIComponent(name)}/v/${encodeURIComponent(v.version)}`}
                  target="_blank" rel="noreferrer">{v.version}</a>
              </li>
            ))}
          </ul>
        </>
      )}
      {notes.kind === 'source' && showSourceNotice && (
        <div className={css.spec}>
          {t(notes.reason === 'unavailable'
            ? 'notesLoadFail'
            : notes.reason === 'unreadable' ? 'notesSourceUnreadable' : 'notesSource')}
          {typeof notes.sourceUrl === 'string' && /^https?:\/\//i.test(notes.sourceUrl)
            ? <>{lang === 'zh' ? '' : ' '}<a className={css.notesSourceLink} href={notes.sourceUrl} target="_blank" rel="noreferrer">{t('notesSourceLink')}</a></>
            : notes.reason !== 'unavailable' && <>{lang === 'zh' ? '' : ' '}{t('notesSourceNoLink')}</>}
        </div>
      )}

      {release !== null && beyondTarget !== undefined && (
        <section className={css.notesHeld}>
          <div className={css.notesMeta}>
            <strong>{t('notesHeldRelease')}</strong>
            {release.tag !== null && <span>{release.tag}</span>}
            {release.publishedAt !== null && <span>{' · ' + release.publishedAt.slice(0, 10)}</span>}
          </div>
          <div className={css.spec}>{t('notesBeyondTarget').replace('{0}', release.tag ?? '').replace('{1}', beyondTarget)}</div>
          <div className={css.notesRendered}>{notesReleaseBody(release) === '' ? t('notesHistoryVersionMissing') : renderMarkdown(release.body)}</div>
        </section>
      )}
    </div>
  )
}
