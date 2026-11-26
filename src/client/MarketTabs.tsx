/**
 * The tab bodies of the Market section other than Installed: Backup, Discover, Favorites, Themes and Blocked, plus the "market gone" notice.
 */

import { Button, Input, Menu, Pill, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import css from './Market.module.css'
import { IconCloseOutline16 } from './icons.ts'
import {
  IconChevronDownOutline14,
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconChevronUpOutline14,
  IconDownloadOutline16,
  IconFolderOpen16,
  IconFullscreenOutline16,
  IconLinkOutline14,
} from './icons.ts'
import { api, formatCount, orderedCategories, themeSwatch } from './market-data.ts'
import { SearchInput } from './SearchInput.tsx'
import { MarketLogo } from './MarketLogo.tsx'
import { SourceFilter, SourceProblems, useFailedSources } from './SourceParts.tsx'
import { EmptyResults, FilterMenu, LoadMore, Pager } from './MarketListControls.tsx'
import { Masonry } from './MarketLayout.tsx'
import type { MarketStateCtx } from './market-state.tsx'
import type { MarketInstallCtx } from './market-install.ts'
import type { MarketGroupsBackupCtx } from './market-groups-backup.ts'
import type { MarketRenderCtx } from './market-render.tsx'
import type { MarketSyncCtx } from './market-sync.ts'
import type { MarketOperationsCtx } from './market-operations.ts'
import type { MarketSectionProps } from './market-types.ts'
import { useAiSearch } from './AiSearch.tsx'
import { AiRecommend } from './AiRecommend.tsx'

type MarketGoneNoticeCtx = { props: MarketSectionProps }
  & Pick<MarketStateCtx, 'reconnecting' | 'setReconnectRound' | 't'>

/**
 * Recently added scrolls sideways, and a thin scrollbar that only shows on
 * hover (or never, on macOS) does not say so. Two arrows in the section head
 * do: each one is there only while there is more to see in its direction.
 */
const RECENT_AUTOPLAY_MS = 10_000

function RecentArrows({ rowRef, t }: { rowRef: RefObject<HTMLDivElement | null>; t: (key: 'recentPrev' | 'recentNext') => string }) {
  const [edges, setEdges] = useState({ left: false, right: false })
  useEffect(() => {
    const row = rowRef.current
    if (row === null) return
    const measure = () => {
      const max = row.scrollWidth - row.clientWidth
      setEdges({ left: row.scrollLeft > 2, right: row.scrollLeft < max - 2 })
    }
    measure()
    row.addEventListener('scroll', measure, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(row)
    return () => { row.removeEventListener('scroll', measure); observer?.disconnect() }
  }, [rowRef])
  // Turns the page by itself every RECENT_AUTOPLAY_MS so every new plugin (and
  // the sponsored one up front) gets seen; at the end it goes back to the
  // start. Stops while the pointer or focus is in the strip, while the tab is
  // hidden, and for people who asked for less motion. Using the arrows
  // restarts the wait, so a click is never followed by an instant second turn.
  const [round, setRound] = useState(0)
  useEffect(() => {
    const row = rowRef.current
    if (row === null) return
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let held = false
    const hold = () => { held = true }
    const release = () => { held = row.matches(':hover') || row.contains(document.activeElement) }
    row.addEventListener('mouseenter', hold)
    row.addEventListener('mouseleave', release)
    row.addEventListener('focusin', hold)
    row.addEventListener('focusout', release)
    const timer = setInterval(() => {
      if (held || document.hidden) return
      const max = row.scrollWidth - row.clientWidth
      if (max <= 2) return
      if (row.scrollLeft >= max - 2) row.scrollTo({ left: 0, behavior: 'smooth' })
      else row.scrollBy({ left: row.clientWidth * 0.85, behavior: 'smooth' })
    }, RECENT_AUTOPLAY_MS)
    return () => {
      clearInterval(timer)
      row.removeEventListener('mouseenter', hold)
      row.removeEventListener('mouseleave', release)
      row.removeEventListener('focusin', hold)
      row.removeEventListener('focusout', release)
    }
  }, [rowRef, round])
  if (!edges.left && !edges.right) return null
  const page = (direction: 1 | -1) => {
    const row = rowRef.current
    if (row === null) return
    setRound(value => value + 1)
    row.scrollBy({ left: direction * row.clientWidth * 0.85, behavior: 'smooth' })
  }
  return (
    <span className={css.recentArrows}>
      <button type="button" className={css.recentArrow} disabled={!edges.left} aria-label={t('recentPrev')} onClick={() => page(-1)}>
        <IconChevronLeftOutline14 size={14} />
      </button>
      <button type="button" className={css.recentArrow} disabled={!edges.right} aria-label={t('recentNext')} onClick={() => page(1)}>
        <IconChevronRightOutline14 size={14} />
      </button>
    </span>
  )
}

const HOST_FILTER_NOTE_KEY = 'dshm-host-filter-note-closed'

/**
 * How many incompatible plugins the compatibility filter hid on this page.
 * Closing it is remembered: the filter itself stays switchable under Filter,
 * so the count is never the only way to know it is on.
 */
function HostFilterNote({ text, t }: { text: string; t: (key: 'dismissNotice') => string }) {
  const [closed, setClosed] = useState(() => {
    try { return localStorage.getItem(HOST_FILTER_NOTE_KEY) === '1' } catch { return false }
  })
  if (closed) return null
  return (
    <div className={`${css.hostFilterNote} ${css.hostFilterNoteRow}`}>
      <span>{text}</span>
      <button
        type="button"
        className={css.bannerClose}
        aria-label={t('dismissNotice')}
        title={t('dismissNotice')}
        onClick={() => {
          setClosed(true)
          try { localStorage.setItem(HOST_FILTER_NOTE_KEY, '1') } catch { /* storage unavailable */ }
        }}
      ><IconCloseOutline16 size={12} /></button>
    </div>
  )
}

export function MarketGoneNotice({ c }: { c: MarketGoneNoticeCtx }) {
  const { reconnecting, setReconnectRound, t } = c
  return (
    <div className={css.empty} role="alert">
      <div><b>{t('marketGoneTitle')}</b></div>
      <div className={css.spec}>{t('marketGoneBody')}</div>
      {reconnecting
        ? <div className={css.spec}>{t('marketGoneReconnecting')}</div>
        : (
            <div>
              <Button variant="outline" size="sm" onClick={() => setReconnectRound(round => round + 1)}>
                {t('marketGoneReconnect')}
              </Button>
            </div>
          )}
    </div>
  )
}


type BackupTabCtx = { props: MarketSectionProps }
  & Pick<MarketStateCtx,
    'autoBackup' | 'backupBusy' | 'fileInputRef' | 'gistBusy' | 'gistId' | 'gistMessage' |
    'gistMode' | 'gistOk' | 'gistResult' | 'gistToken' | 'presetOpen' | 'rememberPassword' |
    'setAutoBackup' | 'setBackupMessage' | 'setGistId' | 'setGistMode' | 'setGistToken' |
    'setPresetOpen' | 'setRememberPassword' | 'setWebdavNeedsPassword' | 'setWebdavPassword' |
    'setWebdavSaved' | 'setWebdavUrl' | 'setWebdavUser' | 't' | 'webdavNeedsPassword' |
    'webdavPassword' | 'webdavUrl' | 'webdavUser'>
  & Pick<MarketInstallCtx, 'downloadFile'>
  & Pick<MarketGroupsBackupCtx,
    'openExportPicker' | 'previewBackup' | 'runGist' | 'runWebdav'>
  & Pick<MarketRenderCtx, 'labelledCheckbox'>

export function BackupTab({ c }: { c: BackupTabCtx }) {
  const {
    autoBackup, backupBusy, downloadFile, fileInputRef, gistBusy, gistId, gistMessage, gistMode,
    gistOk, gistResult, gistToken, labelledCheckbox, openExportPicker, presetOpen, previewBackup,
    rememberPassword, runGist, runWebdav, setAutoBackup, setBackupMessage, setGistId, setGistMode,
    setGistToken, setPresetOpen, setRememberPassword, setWebdavNeedsPassword, setWebdavPassword,
    setWebdavSaved, setWebdavUrl, setWebdavUser, t, webdavNeedsPassword, webdavPassword, webdavUrl,
    webdavUser,
  } = c
  return (
    <div className={css.backupGrid}>
      <section className={css.backupCard}>
        <h3>{t('backupLocal')}</h3>
        <p>{t('backupHint')}</p>
        <p className={css.backupWarn}>{t('credsWarning')}</p>
        <div className={css.backupActions}>
          <Button
            variant="primary"
            size="sm"
            icon={<IconDownloadOutline16 size={14} />}
            disabled={backupBusy}
            onClick={() => downloadFile(api('/dsh-market/backup'), 'dsh-profile-backup.json', t('backupExportFailed') + '：')}
          >{backupBusy ? t('backupWorking') : t('backupDownload')}</Button>
          <Button
            variant="outline"
            size="sm"
            icon={<IconFolderOpen16 size={14} />}
            disabled={backupBusy}
            onClick={() => fileInputRef.current?.click()}
          >{backupBusy ? t('backupWorking') : t('backupImport')}</Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className={css.hiddenFile}
            tabIndex={-1}
            aria-hidden="true"
            disabled={backupBusy}
            onChange={event => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file !== undefined) file.text().then(text => previewBackup(JSON.parse(text))).catch(error => setBackupMessage(String(error)))
            }}
          />
        </div>
      </section>
      <section className={css.backupCard}>
        <h3>{t('webdav')}</h3>
        <Menu
          open={presetOpen}
          onClose={() => setPresetOpen(false)}
          onSelect={id => {
            const urls: Record<string, string> = {
              jianguoyun: 'https://dav.jianguoyun.com/dav/dsh-profile-backup.json',
              koofr: 'https://app.koofr.net/dav/Koofr/dsh-profile-backup.json',
              nextcloud: 'https://nextcloud.example/remote.php/dav/files/USERNAME/dsh-profile-backup.json',
            }
            if (urls[id] !== undefined) setWebdavUrl(urls[id]!)
          }}
          align="start"
          anchor={(
            <Button
              variant="outline"
              size="sm"
              icon={<IconChevronDownOutline14 size={14} />}
              onClick={() => setPresetOpen(o => !o)}
            >{t('webdavPreset')}</Button>
          )}
          items={[
            { id: 'custom', label: t('webdavPreset') },
            { id: 'jianguoyun', label: '坚果云 / Nutstore' },
            { id: 'koofr', label: 'Koofr' },
            { id: 'nextcloud', label: 'Nextcloud' },
          ]}
        />
        <Input className={css.backupInput} icon={<IconLinkOutline14 size={14} />} type="url" value={webdavUrl} placeholder={t('webdavUrl')} onChange={e => setWebdavUrl(e.target.value)} />
        {/* The field had a placeholder and nothing else, so "is this a
            folder or a file?" was answered only by trying it — and a
            reporter who read it as a folder expected the market to
            name the file (#868). Name the shape, and say why the
            name has to stay put: restore looks for that same one. */}
        <p>{t('webdavPathHint')}</p>
        <Input className={css.backupInput} autoComplete="username" value={webdavUser} placeholder={t('webdavUser')} onChange={e => setWebdavUser(e.target.value)} />
        <Input className={css.backupInput} type="password" autoComplete="current-password" value={webdavPassword} placeholder={t('webdavPassword')} onChange={e => { setWebdavPassword(e.target.value); if (e.target.value !== '') setWebdavNeedsPassword(false) }} />
        {labelledCheckbox({
          label: t('webdavRemember'),
          checked: rememberPassword,
          className: css.backupCheck,
          onChange: on => {
            setRememberPassword(on)
            const call = on
              ? (webdavPassword === '' ? null : { action: 'remember', url: webdavUrl.trim(), username: webdavUser, password: webdavPassword })
              : { action: 'forget' }
            if (call === null) return
            fetch(api('/dsh-market/webdav'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(call) })
              .then(() => setWebdavSaved(on ? { remembered: true, url: webdavUrl.trim(), username: webdavUser } : { remembered: false }))
              .catch(() => { /* the next upload carries the choice again */ })
          },
        })}
        <div className={css.backupActions}>
          <Button variant="primary" size="sm" disabled={backupBusy || webdavUrl.trim() === ''} onClick={() => runWebdav('backup')}>{backupBusy ? t('backupWorking') : t('webdavUpload')}</Button>
          <Button variant="outline" size="sm" disabled={backupBusy || webdavUrl.trim() === ''} onClick={() => runWebdav('restore')}>{t('webdavRestore')}</Button>
        </div>
        {labelledCheckbox({
          label: t('autoBackup'),
          checked: autoBackup,
          className: css.backupCheck,
          onChange: setAutoBackup,
        })}
        <p>{t('webdavNote')}</p>
        {webdavNeedsPassword && <p>{t('webdavAutoBackupPaused')}</p>}
        <p className={css.backupWarn}>{t('credsWarning')}</p>
      </section>
      <section className={css.backupCard}>
        <h3>{t('gist')}</h3>
        <Input
          className={css.backupInput}
          type="password"
          autoComplete="off"
          value={gistToken}
          placeholder={t('gistToken')}
          onChange={e => setGistToken(e.target.value)}
        />
        <Input
          className={css.backupInput}
          icon={<IconLinkOutline14 size={14} />}
          value={gistId}
          placeholder={t('gistId')}
          onChange={e => setGistId(e.target.value)}
        />
        <div className={css.backupActions}>
          <label className={css.backupCheck}>
            <input type="radio" name="gist-mode" checked={gistMode === 'update'} onChange={() => setGistMode('update')} />
            {t('gistModeUpdate')}
          </label>
          <label className={css.backupCheck}>
            <input type="radio" name="gist-mode" checked={gistMode === 'create'} onChange={() => setGistMode('create')} />
            {t('gistModeCreate')}
          </label>
        </div>
        <div className={css.backupActions}>
          <Button variant="outline" size="sm" disabled={gistBusy} onClick={() => runGist('verify')}>{gistBusy ? t('backupWorking') : t('gistVerify')}</Button>
          <Button variant="primary" size="sm" disabled={gistBusy || (gistMode === 'update' && gistId.trim() === '')} onClick={openExportPicker}>{gistBusy ? t('backupWorking') : t('gistExport')}</Button>
          <Button variant="outline" size="sm" disabled={gistBusy || gistId.trim() === ''} onClick={() => runGist('import')}>{t('gistImport')}</Button>
        </div>
        {gistResult !== null && (
          <p className={css.backupCheck}>
            <span>{t('gistCreated')}</span>{' '}
            <a className={css.src} href={gistResult.gistUrl} target="_blank" rel="noreferrer">{gistResult.gistUrl}</a>
          </p>
        )}
        {gistMessage !== null && (
          <div className={gistOk ? css.backupMessage : css.backupWarn}>{gistMessage}</div>
        )}
        <p>{t('gistNote')}</p>
      </section>
    </div>
  )
}


type CatalogStatusCtx = Pick<MarketStateCtx, 'loadError' | 't'>
  & Pick<MarketSyncCtx, 'loadCatalog'>

function CatalogStatus({ c }: { c: CatalogStatusCtx & Partial<Pick<MarketStateCtx, 'lang'>> }) {
  const { loadError, loadCatalog, t } = c
  const failedSources = useFailedSources()
  if (loadError === null) {
    return <div className={css.loading}><span className={css.logoMark}><MarketLogo size={26} animated /></span>{t('loading')}</div>
  }
  return (
    <div className={css.empty}>
      <div>{t('loadFail')}</div>
      {failedSources.length > 0
        // Catalogs beyond the public one: say which, in plain words, instead of
        // the joined diagnostic string below.
        ? <SourceProblems sources={failedSources} lang={c.lang ?? 'en'} t={t} onRetry={() => { void loadCatalog() }} />
        : <div className={css.err}>{loadError}</div>}
      <Button variant="outline" size="sm" className={css.retryBtn} onClick={() => { void loadCatalog() }}>
        {t('loadRetry')}
      </Button>
    </div>
  )
}

type DiscoverTabCtx = { props: MarketSectionProps } & CatalogStatusCtx
  & Pick<MarketStateCtx,
    'bodyRef' | 'cat' | 'catalogPreview' | 'catsStuck' | 'catsWrapRef' | 'compatibleWithHost' | 'data' |
    'discoverSearchReset' | 'hostVersion' | 'lang' | 'q' | 'resetDiscoverSearch' |
    'setCat' | 'source' | 'setSource' | 'setCatsOpen' | 'setCatsSentinel' | 'setCompatibleWithHost' | 'setQ' | 'setSortDir' |
    'setSortField' | 'setStuckExpanded' | 'setTimeRange' | 'sortDir' | 'sortField' | 'surface' |
    'timeRange' | 'visibleCats'>
  & Pick<MarketInstallCtx,
    'basePage' | 'changePageSize' | 'currentPage' | 'discoverMore' | 'goToPage' | 'hasRecent' |
    'hideRecent' | 'hostHiddenCount' | 'hostUnavailableCount' | 'loadedHostPackages' |
    'pageHostPackages' | 'pagePlugins' | 'pageSize' | 'pluginsAll' | 'pluginsUnblocked' |
    'recentCollapsed' | 'recentHidden' | 'recentPlugins' | 'showRecent' | 'toggleRecentCollapsed' |
    'totalPages'>
  & Pick<MarketRenderCtx, 'categories' | 'catsExpanded' | 'pluginCard' | 'recentTile'>

export function DiscoverTab({ c }: { c: DiscoverTabCtx }) {
  const {
    basePage, bodyRef, cat, catalogPreview, categories, catsExpanded, catsStuck, catsWrapRef, changePageSize,
    compatibleWithHost, currentPage, data: catalog, discoverMore, discoverSearchReset, goToPage, hasRecent,
    hideRecent, hostHiddenCount, hostUnavailableCount, hostVersion, lang, loadCatalog, loadError,
    loadedHostPackages, pageHostPackages, pagePlugins, pageSize, pluginCard, pluginsAll,
    pluginsUnblocked, q, recentCollapsed, recentHidden, recentPlugins, recentTile,
    resetDiscoverSearch, setCat, source, setSource, setCatsOpen, setCatsSentinel, setCompatibleWithHost, setQ,
    setSortDir, setSortField, setStuckExpanded, setTimeRange, showRecent, sortDir, sortField,
    surface, t, timeRange, toggleRecentCollapsed, totalPages, visibleCats,
  } = c
  const data = catalog ?? catalogPreview
  const recentRowRef = useRef<HTMLDivElement | null>(null)
  const failedSources = useFailedSources()
  const aiSearch = useAiSearch(t)
  // AI picks resolved to the catalog's own entries (by repository URL: names
  // are not unique), in the model's order, drawn exactly like ordinary results.
  const aiPlugins = useMemo(() => {
    if (aiSearch.picks === null || catalog === null) return null
    const byUrl = new Map(catalog.plugins.map(plugin => [plugin.url, plugin]))
    return aiSearch.picks.flatMap(pick => {
      const plugin = byUrl.get(pick.url)
      return plugin === undefined ? [] : [plugin]
    })
  }, [aiSearch.picks, catalog])
  return (
    data === null || (loadError !== null && catalogPreview === null)
      ? <CatalogStatus c={c} />
      : (
            <>
              {catalogPreview !== null && (
                <div className={css.updateCheckNotice}>
                  <span role="status">{t(loadError !== null ? 'catalogInterrupted' : 'catalogProgress')}</span>
                  {loadError !== null && (
                    <Button variant="ghost" size="sm" onClick={() => { void loadCatalog() }}>{t('loadRetry')}</Button>
                  )}
                </div>
              )}
              <div ref={setCatsSentinel} />
              <div className={css.stickyHead}>
              <div className={css.tabSearchRow}>
                <SearchInput key="discover" resetToken={discoverSearchReset} className={css.tabSearch} placeholder={t('searchPh')} value={q} onCommit={setQ} t={t} ai={aiSearch.mode} />
                <FilterMenu
                  sortField={sortField}
                  sortDir={sortDir}
                  timeRange={timeRange}
                  hostVersion={hostVersion}
                  compatibleWithHost={compatibleWithHost}
                  onSortField={setSortField}
                  onSortDir={setSortDir}
                  onTimeRange={setTimeRange}
                  onCompatibleWithHost={setCompatibleWithHost}
                  t={t}
                />
              </div>
              {/* The AI line belongs to the search box: right under it, above the chips. */}
              {aiSearch.status}
              <div className={css.cats}>
                <div className={css.catsRow}>
                {/* The height cap belongs to the MEASURING pass only: that pass
                    renders every chip so their offsets can be counted, and
                    clipping hides the tall row from the user for the frame it
                    exists. Applying it while OPEN clipped the very rows the
                    user had just asked to see — with 20 categories, expanding
                    revealed two rows out of six and read as "nothing
                    happened". Collapsed after measuring needs no cap: the list
                    is already sliced to what fits. */}
                <div ref={catsWrapRef} className={visibleCats === null && !catsExpanded ? `${css.catsWrap} ${css.catsCollapsed}` : css.catsWrap}>
                  {(() => {
                    // Collapsed, the selected category is pulled to the front so it
                    // never hides: the one row in view always contains the choice.
                    const budget = visibleCats
                    const ordered = orderedCategories(categories, cat, catsExpanded, budget)
                    // Collapsed is a single row; expanded shows every category —
                    // including while the header is pinned, where the chevron has
                    // to keep working (a pinned list that ignores the click read as
                    // broken). Pinning an already-open list collapses it because
                    // catsExpanded follows stuckExpanded, not catsOpen.
                    const shown = catsExpanded
                      ? ordered
                      : budget === null ? ordered : ordered.slice(0, Math.max(0, budget - 1))
                    return (
                      <>
                        <Pill data-chip="1" active={cat === 'all'} onClick={() => setCat('all')}>{t('all') + ' (' + formatCount(data!.count) + ')'}</Pill>
                        {shown.map(id => (
                          <Pill
                            key={id}
                            data-chip="1"
                            active={cat === id}
                            onClick={() => setCat(id)}
                          >{(data.categories[id] && (data.categories[id]![lang] || data.categories[id]!.en)) || id}</Pill>
                        ))}
                      </>
                    )
                  })()}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className={css.catsToggle}
                  icon={catsExpanded ? <IconChevronUpOutline14 size={14} /> : <IconChevronDownOutline14 size={14} />}
                  aria-label={catsExpanded ? t('catsLess') : t('catsMore')}
                  onClick={() => {
                    const next = !catsExpanded
                    if (catsStuck) setStuckExpanded(next)
                    setCatsOpen(next)
                  }}
                />
                </div>
                <SourceFilter data={data} active={source} onPick={setSource} lang={lang} t={t} />
                {/* Quiet unless something is actually hidden or unchecked: a line that
                    says "hid 0" on every visit trains people to skip it. */}
                {compatibleWithHost && typeof hostVersion === 'string' && pageHostPackages.length > 0
                  && loadedHostPackages >= pageHostPackages.length && (hostHiddenCount > 0 || hostUnavailableCount > 0) && (
                  <HostFilterNote
                    t={t}
                    text={t(hostUnavailableCount > 0 ? 'hostFilterIncomplete' : 'hostFilterActive')
                      .replace('{0}', hostVersion)
                      .replace('{1}', String(hostHiddenCount))
                      .replace('{2}', String(hostUnavailableCount))}
                  />
                )}
              </div>
              </div>
              <SourceProblems sources={failedSources} lang={lang} t={t} onRetry={() => { void loadCatalog() }} />
              {aiPlugins === null && hasRecent && (recentHidden
                ? <button type="button" className={css.recentShow} onClick={showRecent}>
                    <IconChevronRightOutline14 size={14} />{t('recentShow')}
                  </button>
                : <section className={css.recentBlock} aria-labelledby="dshm-recently-added">
                    <div className={css.recentHead}>
                      <h3 id="dshm-recently-added" className={css.favoritesSectionHead}>
                        <button
                          type="button"
                          className={css.recentToggle}
                          aria-expanded={!recentCollapsed}
                          aria-controls="dshm-recent-grid"
                          onClick={toggleRecentCollapsed}
                        >
                          {recentCollapsed ? <IconChevronRightOutline14 size={14} /> : <IconChevronDownOutline14 size={14} />}
                          {t('recentlyAdded')}
                        </button>
                      </h3>
                      {!recentCollapsed && <RecentArrows rowRef={recentRowRef} t={t} />}
                      <Button variant="ghost" size="sm" className={css.recentHide} onClick={hideRecent}>{t('recentHide')}</Button>
                    </div>
                    {/* #940: clipped in place, never unmounted. */}
                    <div
                      id="dshm-recent-grid"
                      ref={recentRowRef}
                      className={recentCollapsed ? `${css.recentRow} ${css.recentCollapsed}` : css.recentRow}
                    >
                      {recentPlugins.map(plugin => recentTile(plugin))}
                    </div>
                  </section>
              )}
              {aiPlugins === null && (
                <AiRecommend t={t} lang={lang} plugins={data.plugins} render={items => <Masonry items={items} render={plugin => pluginCard(plugin)} />} />
              )}
              {aiPlugins !== null
                ? (aiPlugins.length === 0
                    ? <EmptyResults message="aiSearchEmpty" t={t} />
                    : <Masonry items={aiPlugins} render={plugin => pluginCard(plugin)} />)
                : pagePlugins.length === 0
                ? <EmptyResults message={basePage.length > 0 ? 'hostFilterEmpty' : pluginsAll.length > 0 ? 'blockedFilteredEmpty' : 'empty'} t={t}
                    onClear={data.plugins.length > 0 && (q !== '' || cat !== 'all' || source !== 'all' || timeRange !== 'all' || compatibleWithHost) ? () => {
                      setQ(''); resetDiscoverSearch(value => value + 1)
                      setCat('all'); setSource('all'); setTimeRange('all'); setCompatibleWithHost(false)
                      bodyRef.current?.querySelector('input')?.focus()
                    } : undefined}
                  />
                : <Masonry items={pagePlugins} render={plugin => pluginCard(plugin)} />}
              {aiPlugins === null && pluginsUnblocked.length > 0 && (surface === 'plugins'
                ? <LoadMore more={discoverMore.more} onLoad={discoverMore.loadMore} t={t} />
                : <Pager currentPage={currentPage} totalPages={totalPages} pageSize={pageSize}
                    onGoToPage={goToPage} onChangePageSize={changePageSize} t={t} />)}
            </>
          )
  )
}


type FavoritesTabCtx = { props: MarketSectionProps } & CatalogStatusCtx
  & Pick<MarketStateCtx,
    'data' | 'favSortDir' | 'favSortField' | 'favTimeRange' | 'favoriteUrls' | 'qFavorites' |
    'setFavSortDir' | 'setFavSortField' | 'setFavTimeRange' | 'setQFavorites' | 'surface'>
  & Pick<MarketInstallCtx,
    'favoriteListed' | 'favoritePagePlugins' | 'favoritePageThemes' | 'favoritePluginMore' |
    'favoritePluginPagination' | 'favoritePlugins' | 'favoriteStale' | 'favoriteThemeMore' |
    'favoriteThemePagination' | 'favoriteThemes' | 'favoritesAllStale'>
  & Pick<MarketRenderCtx, 'pluginCard' | 'renderStaleFavorites' | 'themePluginCard'>

export function FavoritesTab({ c }: { c: FavoritesTabCtx }) {
  const {
    data, favSortDir, favSortField, favTimeRange, favoriteListed, favoritePagePlugins,
    favoritePageThemes, favoritePluginMore, favoritePluginPagination, favoritePlugins, favoriteStale,
    favoriteThemeMore, favoriteThemePagination, favoriteThemes, favoriteUrls, favoritesAllStale,
    pluginCard, qFavorites, renderStaleFavorites, setFavSortDir, setFavSortField, setFavTimeRange,
    setQFavorites, surface, t, themePluginCard,
  } = c
  return (
    data === null
      ? <CatalogStatus c={c} />
      : favoriteUrls.length === 0
        ? <div className={css.empty}>{t('favoritesEmpty')}</div>
        : (
            <>
              <div className={css.themeToolbar}>
                <SearchInput
                  key="favorites"
                  className={css.themeSearch}
                  placeholder={t('searchFavoritesPh')}
                  value={qFavorites}
                  onCommit={setQFavorites}
                  t={t}
                />
                <div className={css.themeToolbarActions}>
                  <FilterMenu
                    sortField={favSortField}
                    sortDir={favSortDir}
                    timeRange={favTimeRange}
                    onSortField={setFavSortField}
                    onSortDir={setFavSortDir}
                    onTimeRange={setFavTimeRange}
                    t={t}
                  />
                </div>
              </div>
              {favoriteListed.length === 0
                ? favoritesAllStale
                  ? (
                      <div className={css.favoritesStaleOnly}>
                        <div className={css.empty}>{t('favoritesStaleEmpty')}</div>
                        {renderStaleFavorites()}
                      </div>
                    )
                  : <div className={css.empty}>{t('empty')}</div>
                : (
                    <>
                      {favoriteStale.length > 0 && (
                        renderStaleFavorites()
                      )}
                      <div className={css.themeResultBar}>
                        <span>{t('favoritesResultCount').replace('{0}', String(favoriteListed.length))}</span>
                      </div>
                      {favoritePlugins.length > 0 && (
                        <>
                          <h3 className={css.favoritesSectionHead}>
                            {t('favoritesPluginsSection').replace('{0}', String(favoritePlugins.length))}
                          </h3>
                          <Masonry items={favoritePagePlugins} render={plugin => pluginCard(plugin)} />
                          {surface === 'plugins'
                            ? <LoadMore more={favoritePluginMore.more} onLoad={favoritePluginMore.loadMore} t={t} />
                            : (
                                <Pager
                                  currentPage={favoritePluginPagination.currentPage}
                                  totalPages={favoritePluginPagination.totalPages}
                                  pageSize={favoritePluginPagination.pageSize}
                                  onGoToPage={favoritePluginPagination.goToPage}
                                  onChangePageSize={favoritePluginPagination.changePageSize}
                                  t={t}
                                />
                              )}
                        </>
                      )}
                      {favoriteThemes.length > 0 && (
                        <>
                          <h3 className={css.favoritesSectionHead}>
                            {t('favoritesThemesSection').replace('{0}', String(favoriteThemes.length))}
                          </h3>
                          <div className={css.themeGallery}>
                            {favoritePageThemes.map(themePluginCard)}
                          </div>
                          {surface === 'plugins'
                            ? <LoadMore more={favoriteThemeMore.more} onLoad={favoriteThemeMore.loadMore} t={t} />
                            : (
                                <Pager
                                  currentPage={favoriteThemePagination.currentPage}
                                  totalPages={favoriteThemePagination.totalPages}
                                  pageSize={favoriteThemePagination.pageSize}
                                  onGoToPage={favoriteThemePagination.goToPage}
                                  onChangePageSize={favoriteThemePagination.changePageSize}
                                  t={t}
                                />
                              )}
                        </>
                      )}
                    </>
                  )}
            </>
          )
  )
}


type ThemesTabCtx = { props: MarketSectionProps } & CatalogStatusCtx
  & Pick<MarketStateCtx,
    'bodyRef' | 'data' | 'qThemes' | 'resetThemeSearch' | 'setQThemes' | 'setThemeSortDir' |
    'setThemeSortField' | 'setThemeTimeRange' | 'setThemesFullscreen' | 'surface' |
    'themeSearchReset' | 'themeSnap' | 'themeSortDir' | 'themeSortField' | 'themeTimeRange' |
    'themesFullscreen'>
  & Pick<MarketInstallCtx,
    'themeMore' | 'themePagePlugins' | 'themePagination' | 'themePlugins' | 'themePluginsAll'>
  & Pick<MarketRenderCtx, 'anyThemePlugins' | 'themeCard' | 'themePluginCard'>

export function ThemesTab({ c }: { c: ThemesTabCtx }) {
  const {
    anyThemePlugins, bodyRef, data, qThemes, resetThemeSearch, setQThemes, setThemeSortDir,
    setThemeSortField, setThemeTimeRange, setThemesFullscreen, surface, t, themeCard, themeMore,
    themePagePlugins, themePagination, themePluginCard, themePlugins, themePluginsAll,
    themeSearchReset, themeSnap, themeSortDir, themeSortField, themeTimeRange, themesFullscreen,
  } = c
  return (
    <>
      <div className={css.themeToolbar}>
        <SearchInput key="themes" resetToken={themeSearchReset} className={css.themeSearch} placeholder={t('searchPh')} value={qThemes} onCommit={setQThemes} t={t} />
        <div className={css.themeToolbarActions}>
          <FilterMenu
            sortField={themeSortField}
            sortDir={themeSortDir}
            timeRange={themeTimeRange}
            onSortField={setThemeSortField}
            onSortDir={setThemeSortDir}
            onTimeRange={setThemeTimeRange}
            t={t}
          />
          <Tooltip label={themesFullscreen ? t('themeExitFullscreen') : t('themeFullscreen')} side="top">
            <Button
              variant="outline"
              size="sm"
              className={css.themeFullscreenBtn}
              icon={<IconFullscreenOutline16 size={16} />}
              aria-label={themesFullscreen ? t('themeExitFullscreen') : t('themeFullscreen')}
              aria-pressed={themesFullscreen}
              onClick={() => setThemesFullscreen(value => !value)}
            />
          </Tooltip>
        </div>
      </div>
      {/* Light/dark/system live in the official Appearance setting; this
        tab only shows what that setting can't: registered third-party
        palettes (none in the wild yet) and installable theme plugins. */}
      {(() => {
        const extra = themeSnap!.themes.filter(def => def.id !== 'light' && def.id !== 'dark')
        return extra.length > 0 && (
          <div className={`${css.grid} ${css.themesGrid}`}>
            {extra.map(def => themeCard(def.id, def.id, themeSwatch(def)))}
          </div>
        )
      })()}
      {data === null
        ? <CatalogStatus c={c} />
        : anyThemePlugins.length === 0
          ? <div className={css.empty}>{t('themeEmpty')}</div>
          : themePlugins.length === 0
            ? <EmptyResults message={themePluginsAll.length > 0 ? 'blockedFilteredEmpty' : 'empty'} t={t}
                onClear={qThemes !== '' || themeTimeRange !== 'all' ? () => {
                  setQThemes(''); resetThemeSearch(value => value + 1)
                  setThemeTimeRange('all')
                  bodyRef.current?.querySelector('input')?.focus()
                } : undefined}
              />
            : (
                <>
                  <div className={css.themeResultBar}>
                    <span>{t('themeResultCount').replace('{0}', String(themePlugins.length))}</span>
                  </div>
                  <div className={css.themeGallery}>
                    {themePagePlugins.map(themePluginCard)}
                  </div>
                  {surface === 'plugins'
                    ? <LoadMore more={themeMore.more} onLoad={themeMore.loadMore} t={t} />
                    : (
                        <Pager
                          currentPage={themePagination.currentPage}
                          totalPages={themePagination.totalPages}
                          pageSize={themePagination.pageSize}
                          onGoToPage={themePagination.goToPage}
                          onChangePageSize={themePagination.changePageSize}
                          t={t}
                        />
                      )}
                </>
              )}
    </>
  )
}


type BlockedTabCtx = { props: MarketSectionProps } & CatalogStatusCtx
  & Pick<MarketStateCtx, 'blockedNames' | 'data'>
  & Pick<MarketInstallCtx, 'blockedMissing' | 'blockedPlugins'>
  & Pick<MarketOperationsCtx, 'toggleBlock'>
  & Pick<MarketRenderCtx, 'pluginCard'>

export function BlockedTab({ c }: { c: BlockedTabCtx }) {
  const { blockedMissing, blockedNames, blockedPlugins, data, pluginCard, t, toggleBlock } = c
  return (
    data === null
      ? <CatalogStatus c={c} />
      : blockedNames.length === 0
        ? <div className={css.empty}>{t('blockedEmpty')}</div>
        : (
            <>
              <div className={css.blockedTabHint}>{t('blockedTabHint')}</div>
              {blockedPlugins.length > 0 && <Masonry items={blockedPlugins} render={plugin => pluginCard(plugin)} />}
              {blockedMissing.length > 0 && (
                <div className={css.blockedMissing}>
                  {blockedMissing.map(name => (
                    <div key={name} className={css.blockedBarRow}>
                      <span className={css.blockedBarName} title={name}>{name}</span>
                      <button type="button" className={css.blockedBarUndo} onClick={() => toggleBlock(name)}>{t('blockRemove')}</button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )
  )
}
