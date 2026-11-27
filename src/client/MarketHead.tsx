/**
 * The Market header: title row, tabs, toolbar and the banners under them.
 */

import { useState } from 'react'
import { Button, Menu, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Market.module.css'
import { ActivationActions } from './ActivationActions.tsx'
import { OperationsPanel } from './OperationsPanel.tsx'
import { rememberDismissedHostId } from './dismissed-host.ts'
import { clearSettled, drop } from './operations.ts'
import { CLIENT_VERSION, requestSelfReload, serverIsBehind } from './client-version.ts'
import { api, localizeBilingual, localizeBilingualList, profileBlockedText, restartHintKey } from './market-data.ts'
import {
  IconCordisPluginOutline14,
  IconDownloadOutline16,
  IconCloseOutline16,
  IconQuestionOutline14,
  IconRefreshOutline14,
  IconSparkle16,
  IconWarningOutline16,
} from './icons.ts'
import { HostRecoveryBanner } from './HostRecoveryBanner.tsx'
import { UpdateNotificationsPanel } from './UpdateNotificationsPanel.tsx'
import {
  checkUpdateNotifications,
  setUpdateNotificationsEnabled,
  setUpdateNotificationsIntervalHours,
} from './update-notifications.ts'
import { MarketLogo } from './MarketLogo.tsx'
import { writeSidebarTipDismissed } from './market-helpers.ts'
import { HOVER_TIP_DELAY_MS, SponsorMark } from './MarketCardParts.tsx'
import { activationMeta, HostDependencyDiagnostics } from './MarketStatusParts.tsx'
import type { MarketStateCtx } from './market-state.tsx'
import type { MarketRenderCtx } from './market-render.tsx'
import type { MarketInstallCtx } from './market-install.ts'
import type { MarketGroupsBackupCtx } from './market-groups-backup.ts'
import type { MarketOperationsCtx } from './market-operations.ts'
import type { MarketSyncCtx } from './market-sync.ts'
import type { MarketSectionProps } from './market-types.ts'

type MarketHeadCtx = { props: MarketSectionProps }
  & Pick<MarketStateCtx,
    'activationWarnings' | 'backupBusy' | 'backupMessage' | 'blockedNames' | 'bootId' |
    'brokenPluginNames' | 'brokenPlugins' | 'buildsSkipped' | 'busyUrl' | 'checkingUpdates' |
    'checkoutRecovery' | 'compatibilityNotice' | 'configNamespaceIssues' | 'data' | 'debuggerLatch' |
    'describePlugin' | 'dismissBrokenError' | 'dismissingBroken' | 'doExportLog' | 'enableSidebar' | 'undoSidebar' | 'showSidebarAdded' |
    'envFailed' | 'envFixing' | 'envReady' | 'exportState' | 'headRef' | 'hostBusy' |
    'hostDependencyFindings' | 'hotNames' | 'installError' | 'lang' | 'marketGone' |
    'notificationSnapshot' | 'openInHost' | 'operationsOpen' | 'pendingBackup' | 'profileBlocked' |
    'records' | 'recovery' | 'refreshInstalled' | 'removingName' | 'replacing' | 'restartEnabled' |
    'restartHold' | 'restartReachable' | 'restarting' | 'restoreErrors' | 'rollingBack' |
    'setBuildsSkipped' | 'setCat' | 'setOperationsOpen' | 'setQ' | 'setRecords' | 'setRecoveryOpen' |
    'setRestartNoticeDismissed' | 'setRestoreConfirmOpen' | 'setSidebarTipDismissed' | 'setTab' |
    'showSidebarTip' | 'sidebarTipError' | 'sidebarTipSaving' | 'staleUpdate' | 'startupRepair' |
    'supervisor' | 'surface' | 't' | 'tab' | 'themeSnap' | 'uiLocale' | 'updates' | 'updatingName' |
    'version' | 'hostCaps' | 'restartNames' | 'updatedNames' | 'activations'>
  & Pick<MarketSyncCtx, 'fixEnv'>
  & Pick<MarketInstallCtx,
    'compatibilitySummary' | 'doInstall' | 'doRollback' | 'favoriteTabCount' | 'shadowSummary'>
  & Pick<MarketOperationsCtx,
    'askRestore' | 'dismissBrokenPlugin' | 'doCancel' | 'doRestart' | 'doUpdate' | 'resolveConflict'>
  & Pick<MarketGroupsBackupCtx,
    'approveAndRetry' | 'installedOtherCount' | 'recordsRef' | 'runQueuedNow'>
  & Pick<MarketRenderCtx,
    'eligibleMarketVersion' | 'hasUpdates' |
    'heldMarketVersion' | 'missingRestoreCount' | 'pendingRefreshNames' | 'pendingRestart' |
    'showHostPending' | 'showMarketWait' | 'updateCheckFailed' | 'marketOffer' | 'takeMarketOffer'>

const MARKET_OFFER_CLOSED_KEY = 'dshm-market-offer-closed'

export function MarketHead({ c }: { c: MarketHeadCtx }) {
  const {
    activationWarnings, approveAndRetry, askRestore, backupBusy, backupMessage,
    blockedNames, bootId, brokenPluginNames, brokenPlugins, buildsSkipped, busyUrl, checkingUpdates,
    checkoutRecovery, compatibilityNotice, compatibilitySummary, configNamespaceIssues, data,
    debuggerLatch, describePlugin, dismissBrokenError, dismissBrokenPlugin, dismissingBroken,
    doCancel, doExportLog, doInstall, doRestart, doRollback, doUpdate, eligibleMarketVersion,
    enableSidebar, undoSidebar, showSidebarAdded, envFailed, envFixing, envReady, exportState, favoriteTabCount,
    fixEnv, hasUpdates, headRef, heldMarketVersion, hostBusy, hostDependencyFindings, hotNames,
    installError, installedOtherCount, lang, marketGone, missingRestoreCount, notificationSnapshot,
    openInHost, operationsOpen, pendingBackup, pendingRefreshNames, pendingRestart, profileBlocked,
    records, recordsRef, recovery, refreshInstalled, removingName, replacing, resolveConflict,
    restartEnabled, restartHold, restartReachable, restarting, restoreErrors, rollingBack,
    runQueuedNow, setBuildsSkipped, setCat, setOperationsOpen, setQ, setRecords, setRecoveryOpen,
    setRestartNoticeDismissed, setRestoreConfirmOpen, setSidebarTipDismissed, setTab, shadowSummary,
    showHostPending, showMarketWait, showSidebarTip, sidebarTipError, sidebarTipSaving, staleUpdate,
    startupRepair, supervisor, surface, t, tab, themeSnap, uiLocale, updateCheckFailed, updates,
    updatingName, version, marketOffer, takeMarketOffer, hostCaps, restartNames, updatedNames, activations,
  } = c
  const [reloadingSelf, setReloadingSelf] = useState<'idle' | 'working' | 'failed'>('idle')
  // Why the server said it could not switch, in its own words; '' = no reason given.
  const [reloadError, setReloadError] = useState('')
  const staleServer = serverIsBehind(version)
  /** Swap the new server half in, then reload the page so it matches. */
  const applyNow = (): void => {
    setReloadingSelf('working')
    requestSelfReload(
      () => fetch(api('/dsh-market/reload-self'), { method: 'POST' }),
      async () => {
        const status = await (await fetch(api('/dsh-market/status'))).json() as { version?: unknown }
        return typeof status.version === 'string' ? status.version : null
      },
    ).then(result => {
      if (result.ok) { location.reload(); return }
      setReloadError(localizeBilingual(result.error, lang))
      setReloadingSelf('failed')
    }, () => { setReloadError(''); setReloadingSelf('failed') })
  }
  const marketWaiting = [...restartNames, ...updatedNames, ...Object.keys(activations).filter(name => activations[name]?.state === 'restart')]
    .some(name => name === 'dshmarket' || name === 'dsh-market')
  const canReload = hostCaps.selfReload && (staleServer || marketWaiting) && reloadingSelf !== 'failed'
  const canRestart = restartEnabled && restartReachable && debuggerLatch === null && recovery === null && !marketGone
  const activationBusy = hostBusy || busyUrl !== null || updatingName !== null || removingName !== null
  const activationActions = (
    <ActivationActions
      key={JSON.stringify([bootId, version, pendingRestart, canReload, canRestart])}
      t={t}
      action={canReload ? 'reload' : canRestart ? 'restart' : null}
      label={t(canReload ? 'staleReload' : staleServer ? 'staleRestart' : 'restartNow')}
      working={reloadingSelf === 'working' || restarting}
      busy={activationBusy}
      onImmediate={canReload ? applyNow : doRestart}
    />
  )
  // Four everyday tabs in the row; the rarely used ones (Hidden, Advanced)
  // and the rarely used actions sit behind ···.
  const [moreOpen, setMoreOpen] = useState(false)
  // A restart notice can be closed. It comes back when another change needs
  // a restart, so closing it never hides something new.
  const [restartClosedAt, setRestartClosedAt] = useState(0)
  // Closing the new-version notice hides that version only; a newer one shows
  // again. Kept across reloads, since the offer itself is.
  const [offerClosed, setOfferClosed] = useState<string | null>(() => {
    try { return localStorage.getItem(MARKET_OFFER_CLOSED_KEY) } catch { return null }
  })
  const showMarketOffer = marketOffer !== null && (marketOffer.version === null || marketOffer.version !== offerClosed)
  return (
    <>
      <div ref={headRef} className={css.head}>
        {/* The logo title row, on every surface: the sidebar and the Plugins
            page tab carry the same heading, so either one reads as the market. */}
        {(
        <div className={css.headTop}>
        <div className={css.titleRow}>
          <MarketLogo size={18} ambient style={{ flexShrink: 0 }} />
          <h2 className={css.title}>{t('nav')}</h2>
          <p className={css.sub}>{t('subtitle')}</p>
          </div>
          <div className={css.titleActions}>
          {/* A quiet pointer back to the project — most visitors reach the
              market through a client that embeds it, with no other way to
              find the repo it came from. */}
          <a className={css.repoLink} href="https://github.com/dsh-market/dsh-market" target="_blank" rel="noreferrer" title="dsh-market · GitHub">dsh-market</a>
          {version !== null && (
            <span className={css.marketVersionGroup}>
              <span className={css.version} title={t('versionHint')}>v{version}</span>
              {/* Only when there is something to do: a version that cannot be
                  installed yet is not shown at all (nothing to act on). */}
              {marketOffer !== null && (
                <button
                  type="button"
                  className={css.marketVersionUpdate}
                  disabled={updatingName !== null || busyUrl !== null}
                  onClick={takeMarketOffer}
                >{updatingName === marketOffer.name
                  ? t('updating')
                  : t('marketVersionUpdateNow').replace('{0}', marketOffer.version === null ? '' : ` v${marketOffer.version.replace(/^v/, '')}`)}</button>
              )}
            </span>
          )}
          <a className={css.submitLink} href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md" target="_blank" rel="noreferrer">{t('submitPlugin')}</a>
          </div>
        </div>
        )}
        {showSidebarAdded && (
          <div className={css.sidebarTip}>
            <span>{t('sidebarTipAdded')}</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={sidebarTipSaving}
              onClick={undoSidebar}
            >{t('sidebarTipUndo')}</Button>
            {sidebarTipError !== null && <span>{sidebarTipError}</span>}
          </div>
        )}
        {showSidebarTip && (
          <div className={css.sidebarTip}>
            <span>{t('sidebarTip')}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={sidebarTipSaving}
              onClick={enableSidebar}
            >{t('setSidebarOn')}</Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={sidebarTipSaving}
              onClick={() => {
                writeSidebarTipDismissed()
                setSidebarTipDismissed(true)
              }}
            >{t('sidebarTipDismiss')}</Button>
            {sidebarTipError !== null && <span>{sidebarTipError}</span>}
          </div>
        )}
        <div className={css.tabs}>
          <button className={tab === 'discover' ? `${css.tab} ${css.on}` : css.tab} onClick={() => setTab('discover')}>{t('tabDiscover')}</button>
          {themeSnap !== null && <button className={tab === 'themes' ? `${css.tab} ${css.on}` : css.tab} onClick={() => setTab('themes')}>{t('tabThemes')}</button>}
          <button
            className={tab === 'favorites' ? `${css.tab} ${css.on}` : css.tab}
            onClick={() => setTab('favorites')}
          >{t('tabFavorites') + (favoriteTabCount > 0 ? ' (' + favoriteTabCount + ')' : '')}</button>
          <button className={tab === 'installed' ? `${css.tab} ${css.on}` : css.tab} onClick={() => { setTab('installed'); refreshInstalled(true) }}>
            {t('tabInstalled') + (installedOtherCount > 0 ? ' (' + installedOtherCount + ')' : '')}
            {(hasUpdates || showMarketOffer || (tab !== 'installed' && pendingRestart > restartClosedAt)) && <StateDot state="error" size={7} className={css.dot} />}
          </button>
          {tab === 'blocked' && (
            <button className={tab === 'blocked' ? `${css.tab} ${css.on}` : css.tab} onClick={() => setTab('blocked')}>
              {t('tabBlocked') + (blockedNames.length > 0 ? ' (' + blockedNames.length + ')' : '')}
            </button>
          )}
          {(tab === 'backup' || tab === 'diagnostics') && (
            <button
              className={(tab === 'backup' || tab === 'diagnostics') ? `${css.tab} ${css.on}` : css.tab}
              onClick={() => { if (tab !== 'backup' && tab !== 'diagnostics') setTab('backup') }}
            >{t('tabAdvanced')}</button>
          )}
          {/* The host page already names this tab, so these sit here instead
              of a second title row. Settings and the sidebar keep them in
              the heading. Export stays reachable on this surface — install
              failures ask for a log, and this is where that failure happens. */}
          <Menu
            open={moreOpen}
            onClose={() => setMoreOpen(false)}
            onSelect={(id) => {
              setMoreOpen(false)
              if (id === 'blocked') setTab('blocked')
              if (id === 'advanced') setTab('backup')
              if (id === 'tasks') setOperationsOpen(true)
              if (id === 'export') doExportLog()
            }}
            align="start"
            portal
            anchor={(
              <button
                type="button"
                className={css.headMore}
                data-dshm-head-more
                aria-label={t('headMore')}
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen(open => !open)}
              >···</button>
            )}
            items={[
              { id: 'blocked', label: t('tabBlocked') + (blockedNames.length > 0 ? ' (' + blockedNames.length + ')' : '') },
              { id: 'advanced', label: t('tabAdvanced') },
              { type: 'separator', id: 'sep' },
              { id: 'tasks', label: t('opTitle') },
              { id: 'export', label: exportState === 'busy' ? t('exportingLog') : t('exportLog'), disabled: exportState === 'busy' },
            ]}
          />
          {/* In the tab row, not above the grid: paginating, searching and
              switching tab all leave it — and any pending decision — in place. */}
          <OperationsPanel
            hideWhenQuiet
            t={t}
            lang={lang}
            describe={describePlugin}
            records={records}
            startupRepairEntries={startupRepair?.entries}
            checkoutRecoveryEntries={checkoutRecovery?.entries}
            open={operationsOpen}
            onOpenChange={setOperationsOpen}
            replacing={replacing}
            envReady={envReady}
            onClearSettled={() => {
              for (const record of recordsRef.current) {
                if (record.hostOperationId !== undefined
                  && (record.state === 'done' || record.state === 'warned' || record.state === 'failed')) {
                  rememberDismissedHostId(record.hostOperationId)
                }
              }
              setRecords(list => clearSettled(list))
            }}
            onCancel={record => doCancel(record)}
            onDismiss={record => {
              if (record.hostOperationId !== undefined) {
                rememberDismissedHostId(record.hostOperationId)
              }
              setRecords(list => drop(list, record.id))
            }}
            onRefresh={() => location.reload()}
            onResolveConflict={resolveConflict}
            onForceInstall={(record) => {
              // Same road as any other install, with the one flag that says
              // the user has seen the hold and wants the release anyway. The
              // record is dropped first so the retry replaces it rather than
              // sitting beside a row that already said "installed".
              const plugin = record.url === undefined ? undefined : data?.plugins.find(p => p.url === record.url)
              if (plugin === undefined) return
              setRecords(list => drop(list, record.id))
              doInstall(plugin, true)
            }}
            onRunNow={runQueuedNow}
            onApproveBuilds={(record) => {
              const names = record.blockedBuilds ?? []
              if (names.length === 0) return
              setRecords(list => drop(list, record.id))
              const plugin = record.url === undefined ? undefined : data?.plugins.find(p => p.url === record.url)
              approveAndRetry(names, () => {
                if (plugin !== undefined) doInstall(plugin)
                else doUpdate(record.name, record.updateOptions?.force, record.updateOptions?.restore, record.updateOptions?.compatVersion, false, record.updateOptions?.eligibleVersion, false, record.updateOptions?.compatibleVersion ?? null)
              })
            }}
          />
          {/* Sponsors live in the spacer. It never shrinks below the mark, so
              when the row has no room the spacer (and the buttons after it)
              moves to the next line instead of hiding a sponsor. */}
          <span className={`${css.grow} ${css.sponsorSlot}`}>
            <SponsorMark lang={lang} t={t} />
          </span>
        </div>
        {!marketGone && updateCheckFailed && (
          <div className={css.updateCheckNotice}>
            <span role="status">{t('updateCheckFailed')}</span>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('updateCheckRetry')}
              disabled={checkingUpdates}
              onClick={() => refreshInstalled(true)}
            >{t('loadRetry')}</Button>
          </div>
        )}
        {!marketGone && restartHold !== null && restartHold.boot === bootId && (
          <div className={css.updateCheckNotice}>
            <span role="status">{t('restartFirstNote')}</span>
          </div>
        )}
        {!marketGone && profileBlocked !== null && (
          <div className={css.updateCheckNotice}>
            <span role="status">{profileBlockedText(profileBlocked, t)}</span>
          </div>
        )}
        {/* Backup & Restore and Diagnostics sit under Advanced rather than as
            their own top-level tabs — most users never need either, and having
            five peers up top buried the ones people actually reach for. */}
        {(tab === 'backup' || tab === 'diagnostics') && (
          <div className={css.subTabs}>
            <button className={tab === 'backup' ? `${css.tab} ${css.on}` : css.tab} onClick={() => setTab('backup')}>{t('tabBackup')}</button>
            <button className={tab === 'diagnostics' ? `${css.tab} ${css.on}` : css.tab} onClick={() => setTab('diagnostics')}>{t('tabDiagnostics')}</button>
            <span className={css.grow} />
          </div>
        )}
        {!envReady && (
          <div className={css.banner}>
            <IconCordisPluginOutline14 size={14} className={css.bannerIcon} />
            <span className={css.grow}>{envFailed ? t('envFixFail') : t('envMissing')}</span>
            {!envFailed && (
              <Button variant="primary" size="sm" disabled={envFixing} onClick={fixEnv}>
                {envFixing ? t('envFixing') : t('envFix')}
              </Button>
            )}
          </div>
        )}
        {backupMessage !== null && <div className={css.backupMessage}>{backupMessage}</div>}
        {restoreErrors.length > 0 && (
          <div className={css.banner}>
            <IconWarningOutline16 size={14} className={css.bannerIcon} />
            <span className={css.grow}>
              <div><b>{t('restorePartial')}</b></div>
              {restoreErrors.map(error => <div key={error} className={css.spec}>{error}</div>)}
            </span>
          </div>
        )}
        {/* #875: rendered only when DSH's own recovery replaced the profile
            patch — for every other profile this is null. */}
        <HostRecoveryBanner t={t} bootId={bootId} />
        {tab === 'installed' && pendingBackup !== null && (
          <div className={css.banner}>
            <IconRefreshOutline14 size={14} className={css.bannerIcon} />
            <span className={css.grow}>{t('restoreMissing').replace('{0}', String(missingRestoreCount))}</span>
            <Button variant="primary" size="sm" disabled={backupBusy} onClick={() => setRestoreConfirmOpen(true)}>
              {backupBusy ? t('backupWorking') : t('restoreStart')}
            </Button>
          </div>
        )}
        {pendingRefreshNames.length > 0 && (
          <div className={css.banner}>
            <IconSparkle16 size={14} className={css.bannerIcon} />
            <span className={css.grow}><b>{pendingRefreshNames.length}</b> {t('refreshBanner')}</span>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                if (hotNames.length > 0) sessionStorage.setItem('dshm-toast', JSON.stringify(hotNames))
                sessionStorage.setItem('dshm-tab', 'installed')
                location.reload()
              }}
            >{t('refresh')}</Button>
          </div>
        )}
        {/* The page is newer than the server half still running: the market
            updated itself and DSH has not reloaded it. Routes the page relies
            on may not exist until the next host start. */}
        {staleServer && (
          <div className={css.banner} data-dshm-stale-server>
            <IconRefreshOutline14 size={14} className={css.bannerIcon} />
            <span className={css.grow}>
              {t('staleBanner').replace('{0}', CLIENT_VERSION ?? '').replace('{1}', version ?? '')}
              {' '}
              {hostCaps.selfReload || (restartEnabled && restartReachable && debuggerLatch === null)
                ? null
                : t(hostCaps.desktop ? 'staleDesktopHint' : 'staleManualHint')}
              {reloadingSelf === 'failed' && <> {reloadError !== '' ? reloadError : t(hostCaps.desktop ? 'staleDesktopHint' : 'staleManualHint')}</>}
            </span>
            {activationActions}
          </div>
        )}
        {/* The market's own new version: named, with what updating does, on
            Installed; the Installed tab carries a dot so it is found. Once it
            is downloaded the restart notice below takes over. */}
        {showMarketOffer && tab === 'installed' && (
          <div className={css.banner} data-dshm-market-offer>
            <IconDownloadOutline16 size={14} className={css.bannerIcon} />
            <span className={css.grow}>
              {marketOffer.version !== null
                ? <>{t('marketOfferBanner')} <b>{marketOffer.version}</b></>
                : t('marketOfferBanner')}
              <span className={css.bannerSub}>{t('marketOfferHint')}</span>
            </span>
            <Button
              variant="primary"
              size="sm"
              aria-label={marketOffer.restoreRequired ? t('restoreOnline') : t('marketUpdate')}
              disabled={updatingName !== null || busyUrl !== null}
              onClick={takeMarketOffer}
            >{updatingName === marketOffer.name ? t('updating') : marketOffer.restoreRequired ? t('restoreOnline') : t('update')}</Button>
            <button
              type="button"
              className={css.bannerClose}
              aria-label={t('dismissNotice')}
              title={t('dismissNotice')}
              onClick={() => {
                setOfferClosed(marketOffer.version)
                try { if (marketOffer.version !== null) localStorage.setItem(MARKET_OFFER_CLOSED_KEY, marketOffer.version) } catch { /* storage unavailable */ }
              }}
            ><IconCloseOutline16 size={14} /></button>
          </div>
        )}
        {/* On the Plugins page this lives on Installed, next to the rows it is
            about; the Installed tab carries a dot so it is not missed. */}
        {pendingRestart > restartClosedAt && tab === 'installed' && (
          <div className={css.banner}>
            <IconRefreshOutline14 size={14} className={css.bannerIcon} />
            <span className={css.grow}><b>{pendingRestart}</b> {t('restartBanner')}</span>
            <Tooltip
              label={t(restartHintKey({ debuggerLatch, restartReachable, supervisor })).replace('{0}', supervisor ?? '')}
              side="bottom"
            >
              <span className={css.bannerHint}><IconQuestionOutline14 size={14} /></span>
            </Tooltip>
            {!staleServer && activationActions}
            {/* Reloading the market above cannot apply another plugin's host restart. */}
            {staleServer && canReload && canRestart && (
              <ActivationActions
                key={JSON.stringify([bootId, pendingRestart])}
                t={t} action="restart" label={t('restartNow')} offerDefer={false}
                working={restarting || reloadingSelf === 'working'} busy={activationBusy} onImmediate={doRestart}
              />
            )}
            {!staleServer && reloadingSelf === 'failed' && reloadError !== '' && marketWaiting && <span className={css.grow}>{reloadError}</span>}
            <button
              type="button"
              className={css.bannerClose}
              aria-label={t('dismissNotice')}
              title={t('dismissNotice')}
              onClick={() => {
                setRestartClosedAt(pendingRestart)
                if (showHostPending) {
                  setRestartNoticeDismissed(true)
                  try { sessionStorage.setItem('dshm-restart-dismissed', String(bootId ?? '')) } catch { /* storage unavailable */ }
                }
              }}
            ><IconCloseOutline16 size={14} /></button>
          </div>
        )}
        {activationWarnings.length > 0 && (
          <div className={css.banner}>
            <IconWarningOutline16 size={14} className={css.bannerIcon} />
            <span className={css.grow}>
              {activationWarnings.map(({ name, info }) => (
                <div key={name}>
                  <b>{name}</b> — {activationMeta(info.state, t, info.dependencyOf, info.loadedByProfile, info.library).label}
                  {info.reasons.length > 0 && <span className={css.spec}>（{localizeBilingualList(info.reasons, lang)}）</span>}
                </div>
              ))}
            </span>
          </div>
        )}
        {tab === 'installed' && configNamespaceIssues.length > 0 && (
          <div className={css.banner}>
            <IconWarningOutline16 size={14} className={css.bannerIcon} />
            <span className={css.grow}>
              {configNamespaceIssues.map(finding => (
                <div key={finding.name}>
                  {t('configNamespaceNotice')
                    .replace('{0}', finding.name)
                    .replace('{1}', finding.namespaces.join('、'))
                    .replace('{2}', finding.ownEntryIds.join('、') || '—')}
                </div>
              ))}
            </span>
          </div>
        )}
        {tab === 'installed' && <UpdateNotificationsPanel
          snapshot={notificationSnapshot} t={t}
          busy={updatingName !== null || busyUrl !== null || removingName !== null}
          onCheck={checkUpdateNotifications}
          onEnabled={setUpdateNotificationsEnabled}
          onIntervalHours={setUpdateNotificationsIntervalHours}
          onUpdate={(name, selectedCompatibleVersion) => {
            if (updates[name]?.restoreRequired === true) askRestore(name)
            else doUpdate(name, false, false, undefined, false, undefined, false, selectedCompatibleVersion)
          }}
          onOpenHost={openInHost === undefined ? undefined : name => openInHost.openBundle(name)}
        />}
        {tab === 'installed' && <HostDependencyDiagnostics findings={hostDependencyFindings} t={t} />}
        {tab === 'installed' && brokenPluginNames.length > 0 && (
          <div className={css.brokenPluginNotice}>
            {brokenPluginNames.map(name => (
              <div key={name} className={css.brokenPluginItem}>
                <div className={css.brokenPluginText}>
                  {/* A cancel saw no cause, so its notice names none (#663). */}
                  <b>{t(brokenPlugins[name]?.reason === 'incomplete-build-cancelled' ? 'brokenPluginTitleCancelled' : 'brokenPluginTitle').replace('{0}', name)}</b>
                  <span>{t(brokenPlugins[name]?.reason === 'incomplete-build-cancelled' ? 'brokenPluginBodyCancelled' : 'brokenPluginBody')}</span>
                </div>
                {/* Same road the replacement hint takes: search for it and
                    land on the catalog, where Install does the right thing. */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setCat('all'); setQ(name); setTab('discover') }}
                >{t('brokenPluginAction')}</Button>
                {/* A second, quieter way out (#763): the plugin may be gone from
                    the catalog too, and then the search above finds nothing and
                    the user has no way to make the banner stop. Ghost, because
                    hiding a message is not one of the two things they may have
                    come here to do. Disabled while in flight so one row cannot
                    queue two requests against the same record. */}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={dismissingBroken.has(name)}
                  onClick={() => dismissBrokenPlugin(name)}
                >{t('brokenPluginDismiss')}</Button>
              </div>
            ))}
            {/* A dismiss that did not take says so here, next to the notice it
                belongs to — and that notice is still on screen, because the
                failure path put it back rather than leaving the user with an
                error and no explanation. */}
            {dismissBrokenError !== null && (
              <div className={css.brokenPluginItem} role="alert">
                <span className={css.brokenPluginText}>{dismissBrokenError}</span>
              </div>
            )}
          </div>
        )}
      </div>
      {buildsSkipped !== null && (
        <div className={css.banner}>
          <IconWarningOutline16 size={14} className={css.bannerIcon} />
          <span className={css.grow}>{t('buildsSkipped')} {buildsSkipped.names.join(', ')}</span>
          <Button
            size="sm"
            disabled={busyUrl !== null}
            onClick={() => {
              const { plugin, updateName, names, updateOptions } = buildsSkipped
              setBuildsSkipped(null)
              approveAndRetry(names, () => {
                if (plugin !== undefined) doInstall(plugin)
                else if (updateName !== undefined) doUpdate(updateName, updateOptions?.force, updateOptions?.restore, updateOptions?.compatVersion, false, updateOptions?.eligibleVersion, false, updateOptions?.compatibleVersion ?? null)
              })
            }}
          >{t('approveBuilds')}</Button>
        </div>
      )}
      {compatibilityNotice !== null && (
        <div className={css.banner}>
          <span className={css.grow}>
            {/* Two independent findings share one banner and one rollback,
                because they came from one operation. Each is named for what
                it actually is: a peer-version risk and a loader-name
                collision are not the same problem and must not read as one. */}
            {compatibilityNotice.risks.length > 0 && (
              <><b>{t(compatibilityNotice.rollbackId === undefined ? 'compatRiskBannerNoRollback' : 'compatRiskBanner')}</b> {compatibilitySummary(compatibilityNotice.risks)}</>
            )}
            {compatibilityNotice.shadowedNames !== undefined && compatibilityNotice.shadowedNames.length > 0 && (
              <>
                {compatibilityNotice.risks.length > 0 && ' · '}
                <b>{t('shadowNameBanner')}</b> {shadowSummary(compatibilityNotice.shadowedNames)}
              </>
            )}
            {compatibilityNotice.brokenBundles !== undefined && compatibilityNotice.brokenBundles.length > 0 && (
              <>
                {(compatibilityNotice.risks.length > 0
                  || (compatibilityNotice.shadowedNames?.length ?? 0) > 0) && ' · '}
                <b>{t('brokenBundleBanner')}</b>{' '}
                {compatibilityNotice.brokenBundles.map(entry => entry.name).join(', ')}
              </>
            )}
          </span>
          <Button variant="outline" size="sm" onClick={() => setTab('diagnostics')}>{t('goDiagnose')}</Button>
          {compatibilityNotice.risks.length === 0 && (compatibilityNotice.brokenBundles?.length ?? 0) === 0
            // Same-name rows alone are informational (#913): they prove nothing
            // broke, so there is nothing to roll back and nothing to warn about.
            ? null
            : compatibilityNotice.rollbackId === undefined
            ? <span>{compatibilityNotice.rollbackUnavailable ? localizeBilingual(compatibilityNotice.rollbackUnavailable, lang) : t('rollbackUnavailable')}</span>
            : (
                <Button variant="primary" size="sm" disabled={rollingBack} onClick={() => void doRollback(compatibilityNotice.rollbackId!)}>
                  {rollingBack ? t('rollingBack') : t('rollbackNow')}
                </Button>
              )}
        </div>
      )}
      {installError !== null && (
        <div className={css.err}>
          {localizeBilingual(installError, lang)}
          <div className={css.staleAction}>
            {/* The new option beside the failure: when the restart this page
                asked for never came back, every other action here is beside
                the point — what the user needs is the list of plugins and the
                ones DSH blamed, which the recovery surface is holding. */}
            {recovery !== null && (
              <Button variant="primary" size="sm" onClick={() => setRecoveryOpen(true)}>
                {t('recoveryOption')}
              </Button>
            )}
            {/* Primary, because the banner's own words point at it ("点
                「立即更新」不再等待") and it is the way out of the wait. With
                the default variant it inherited the banner's 12px red text
                and sat flush against the export button, which is why #410
                was reported as "there is no such button" — @Dave-12138
                spotted it in the reporter's own screenshot: it was there,
                it just did not look like one. */}
            {staleUpdate !== null && updates[staleUpdate.name]?.hostUpdateBlocked === undefined
              && (staleUpdate.exactVersion !== undefined && staleUpdate.compatibleVersion === undefined
                || updates[staleUpdate.name]?.compatibleVersion === staleUpdate.compatibleVersion) && (
              <Button variant="primary" size="sm" onClick={() => doUpdate(staleUpdate.name, true, false, staleUpdate.exactVersion)}>{t('updateNow')}</Button>
            )}
            {/* The banner text told users to export the log; now it IS the button (#84). */}
            <Button
              size="sm"
              variant="outline"
              icon={<IconDownloadOutline16 size={14} />}
              disabled={exportState === 'busy'}
              onClick={doExportLog}
            >
              {exportState === 'busy' ? t('exportingLog') : t('exportLog')}
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
