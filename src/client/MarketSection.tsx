/**
 * The Market settings section: Discover / Favorites / Themes / Installed tabs over the
 * /dsh-market/* host routes, with install/update/uninstall flows and the
 * pending-restart bookkeeping in sessionStorage.
 */

import {
  Button,
  DisclosureRow,
  Input,
  Menu,
  Modal,
  Pill,
  StateDot,
  Toast,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Market.module.css'
import { OperationsPanel } from './OperationsPanel.tsx'
import { rememberDismissedHostId } from './dismissed-host.ts'
import { clearSettled, drop } from './operations.ts'
import {
  api,
  catalogEntryForInstalled,
  displayLatest,
  formatCount,
  groupSwitchState,
  hostCompatibilityKey,
  installCommandFor,
  installedDateText,
  isGenerationSpec,
  isInstalled,
  localizeBilingual,
  localizeBilingualList,
  looksTerminal,
  orderedCategories,
  pluginCategories,
  pluginName,
  profileBlockedText,
  restartHintKey,
  themeSwatch,
} from './market-data.ts'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconChevronUpOutline14,
  IconCordisPluginOutline14,
  IconDownloadOutline16,
  IconFolderOpen16,
  IconFullscreenOutline16,
  IconLinkOutline14,
  IconLoadingOutline16,
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
import { SearchInput } from './SearchInput.tsx'
import { Diagnostics } from './Diagnostics.tsx'
import { catalogReleaseSourceOf } from '../sources.ts'
import { RecoveryPanel } from './RecoveryPanel.tsx'
import { CommentsModal } from './CommentsModal.tsx'
import { MarketLogo } from './MarketLogo.tsx'
import {
  heldUpdateBeside,
  isAbsoluteLocalPath,
  isLocalDev,
  isPluginUpdatable,
  localPathOf,
  marketWaitTip,
  shortLocalPath,
  sourceMigrationCopy,
  writeSidebarTipDismissed,
} from './market-helpers.ts'
import {
  CardTip,
  CatalogVersionMark,
  ConfirmCopyButton,
  ConfirmFold,
  ConfirmTerminalIcon,
  ConfirmWarnIcon,
  DownloadCount,
  HOVER_TIP_DELAY_MS,
  IconBellOff,
  IconClock,
  IconPlus,
  SponsorMark,
  StarCount,
} from './MarketCardParts.tsx'
import { activationMeta, HostDependencyDiagnostics, hostRequirementChip } from './MarketStatusParts.tsx'
import { EmptyResults, FilterMenu, InstalledSortMenu, LoadMore, Pager } from './MarketListControls.tsx'
import { CardDesc, Masonry, ScreenshotLightbox } from './MarketLayout.tsx'
import { NOTE_MAX } from './market-constants.ts'
import { OwnerAvatar, ScreenshotStrip } from './MarketImages.tsx'
import { UpdateNotesContent } from './MarketNotes.tsx'
import { useMarketState } from './market-state.tsx'
import { useMarketSync } from './market-sync.ts'
import { useMarketInstall } from './market-install.ts'
import { useMarketOperations } from './market-operations.ts'
import { useMarketGroupsBackup } from './market-groups-backup.ts'
import { useMarketRender } from './market-render.tsx'
import type { MarketSectionProps } from './market-types.ts'

export { GithubRoutedImg, OwnerAvatar, resetThemePreviewCache } from './MarketImages.tsx'
export { resetMarketPortalHost } from './MarketLayout.tsx'
export { MarketLogo } from './MarketLogo.tsx'
export { resetHostCompatibilityCache } from './market-state.tsx'
export type { MarketSectionProps } from './market-types.ts'

export function MarketSection(props: MarketSectionProps) {
  const c1 = useMarketState({ props })
  const c2 = useMarketSync({ props, ...c1 })
  const c3 = useMarketInstall({ props, ...c1, ...c2 })
  const c4 = useMarketOperations({ props, ...c1, ...c2, ...c3 })
  const c5 = useMarketGroupsBackup({ props, ...c1, ...c2, ...c3, ...c4 })
  const c6 = useMarketRender({ props, ...c1, ...c2, ...c3, ...c4, ...c5 })
  const c = { props, ...c1, ...c2, ...c3, ...c4, ...c5, ...c6 }
  const {
    activationWarnings, activations, addPanel, addQuery, addSelected, agentsConfirm, anyThemePlugins,
    applyGroupTheme, applyRecoveryChoice, approveAndRetry, askRestore, askSourceMigration, assignFor,
    authoredDescription, autoBackup, backupBusy, backupMessage, basePage, batchActions, blockError,
    blockErrorDone, blockNotice, blockNoticeDone, blockedMissing, blockedNames, blockedPlugins,
    bodyRef, bootId, brokenPluginNames, brokenPlugins, buildsSkipped, busyUrl, cancelCreateGroup,
    cancelling, capabilityDetail, cat, catalogInstalled, catalogVersionTip, categories, catsExpanded,
    catsStuck, catsWrapRef, changePageSize, checkingUpdates, checkoutRecovery, closeNotes, cmdOpen,
    collapsedGroups, commentsFor, compatibilityNotice, compatibilitySummary, compatibleWithHost,
    configNamespaceIssues, confirming, creatingGroup, currentPage, data, debuggerLatch,
    deletingGroup, dependencyOnlyNames, describePlugin, discoverMore, discoverSearchReset,
    dismissBrokenError, dismissBrokenPlugin, dismissingBroken, doAddSelectedMembers, doAssign,
    doCancel, doCreateGroup, doDeleteGroup, doExportLog, doGroupToggle, doInstall, doRemoveMember,
    doRenameGroup, doRestart, doRestore, doRollback, doSourceMigration, doToggle, doUninstall,
    doUpdate, downloadFile, effectiveDisabledSet, eligibleMarketVersion, enableSidebar, envFailed,
    envFixing, envReady, exportAllSelected, exportError, exportIncludeConfig, exportLogButton,
    exportOpen, exportOptions, exportSelection, exportState, exportToastDone, favSortDir,
    favSortField, favTimeRange, favoriteError, favoriteErrorDone, favoriteListed,
    favoritePagePlugins, favoritePageThemes, favoritePluginMore, favoritePluginPagination,
    favoritePlugins, favoriteStale, favoriteTabCount, favoriteThemeMore, favoriteThemePagination,
    favoriteThemes, favoriteUrls, favoritesAllStale, fileInputRef, findingCompat, fixEnv, gistBusy,
    gistId, gistMessage, gistMode, gistOk, gistResult, gistToken, goToPage, groupMenuFor, groupOrder,
    groupQuery, groups, hasRecent, hasUpdates, headRef, heldMarketVersion, hideRecent, hostBusy,
    hostCompatHeld, hostCompatHeldHours, hostCompatWindowHours, hostCompatibility,
    hostDependencyFindings, hostHiddenCount, hostIncompatible, hostUnavailableCount, hostVersion,
    hotNames, ignoredUpdateSet, installError, installTimes, installed, installedBlurb,
    installedFiles, installedOtherCount, installedSearchReset, installedSort, installedThemeNames,
    installedView, labelledCheckbox, lang, lightbox, loadCatalog, loadError, loadedHostPackages,
    marketGone, matchesInstalledQuery, migrationConfirm, missingRestoreCount, newGroupName,
    noteDraft, notes, notesFor, notesState, notificationSnapshot, notingName, onOffSwitch,
    openAddPanel, openExportPicker, openInHost, openLightbox, openNotes, openThemePanel,
    operationsOpen, orderedInstalledEntries, pageHostPackages, pagePlugins, pageSize, pendingBackup,
    pendingRefreshNames, pendingRestart, pluginCard, pluginsAll, pluginsUnblocked, presetOpen,
    previewBackup, profileBlocked, profileName, progressPct, progressText, q, qFavorites, qInstalled,
    qThemes, recentCollapsed, recentHidden, recentPlugins, recentTile, reconnecting, records,
    recordsRef, recovery, recoveryBusy, recoveryKeep, recoveryOpen, refreshInstalled,
    rememberPassword, removeConfirm, removingName, renamingGroup, renamingValue,
    renderInstalledBlockMenu, renderStaleFavorites, replacementOf, replacing, repoHints,
    repoIdentities, resetDiscoverSearch, resetThemeSearch, resolveConflict, restartEnabled,
    restartHold, restartReachable, restarting, restoreBlocked, restoreConfirm, restoreConfirmOpen,
    restoreErrors, rollingBack, rootRef, runGist, runQueuedNow, runWebdav, saveNote, scrollToTop,
    setAddPanel, setAddQuery, setAddSelected, setAgentsConfirm, setAssignFor, setAutoBackup,
    setBackupMessage, setBuildsSkipped, setCat, setCatsOpen, setCatsSentinel, setCmdOpen,
    setCollapsedGroups, setCommentsFor, setCompatRetry, setCompatibleWithHost, setConfirming,
    setCreatingGroup, setDeletingGroup, setExportIncludeConfig, setExportOpen, setExportSelection,
    setFavSortDir, setFavSortField, setFavTimeRange, setGistId, setGistMode, setGistToken,
    setGroupMenuFor, setHostIncompatible, setInstalledMenuName, setInstalledSort, setInstalledView,
    setLightbox, setMigrationConfirm, setNewGroupName, setNoteDraft, setNotingName,
    setOperationsOpen, setPluginMenuUrl, setPresetOpen, setQ, setQFavorites, setQInstalled,
    setQThemes, setReconnectRound, setRecords, setRecoveryKeep, setRecoveryOpen, setRememberPassword,
    setRemoveConfirm, setRenamingGroup, setRenamingValue, setRestartNoticeDismissed,
    setRestoreBlocked, setRestoreConfirm, setRestoreConfirmOpen, setShowTheirs, setShowTop,
    setSidebarTipDismissed, setSortDir, setSortField, setStuckExpanded, setTab, setThemePanel,
    setThemePick, setThemeSortDir, setThemeSortField, setThemeTimeRange, setThemesFullscreen,
    setTimeRange, setWebdavNeedsPassword, setWebdavPassword, setWebdavSaved, setWebdavUrl,
    setWebdavUser, setWhyOpen, shadowSummary, showHostPending, showMarketWait, showRecent,
    showSidebarTip, showTheirs, showTop, sidebarTipError, sidebarTipSaving, sortDir, sortField,
    specKind, staleName, startupRepair, supervisor, surface, t, tab, themeCard, themeMore,
    themePagePlugins, themePagination, themePanel, themePick, themePluginCard, themePlugins,
    themePluginsAll, themeSearchReset, themeSnap, themeSortDir, themeSortField, themeTimeRange,
    themesFullscreen, timeRange, toggleBlock, toggleCollapsedGroup, toggleRecentCollapsed,
    toggleUpdateExempt, toggled, toggledDone, togglingName, totalPages, uiLocale, ungroupedNames,
    unignoreUpdateNotice, updateCheck, updateCheckFailed, updateExemptError, updateExemptErrorDone,
    updateExemptNotice, updateExemptNoticeDone, updateExemptSet, updateNotes, updatedNames, updates,
    updatingName, version, visibleCats, visibleGroupIds, visibleUngrouped, webdavNeedsPassword,
    webdavPassword, webdavUrl, webdavUser, whyOpen,
  } = c

  return (
    <div
      ref={rootRef}
      className={`${css.root} notranslate`}
      data-dsh-market-root
      data-dsh-market-plugins-tab={surface === 'plugins' ? 'true' : undefined}
      /* Browser page translation is the one reported cause of the blank
         market (#293 by @apdc111, and the same shape in #286 / #241, none of
         which ever reproduced in an untranslated browser). Chrome and Edge
         translate by REPLACING text nodes underneath React's feet; React then
         tries to remove a node its parent no longer has, throws
         NotFoundError, and the whole section unmounts — leaving the panel
         blank, with the export-log button gone too, which is why every
         request for a log from that state came back empty.

         `translate="no"` is scoped to this subtree, so the host page around
         it still translates. The cost is that machine translation stops
         inside the market; that is a fair trade against a page that cannot
         render at all, and the market already ships its own 中文 and English
         rather than relying on the browser for them. `notranslate` is the
         same instruction for engines that predate the attribute. */
      translate="no"
      data-dsh-market-tab={tab}
      data-dsh-market-fullscreen={tab === 'themes' && themesFullscreen ? 'true' : undefined}
    >
      <div ref={headRef} className={css.head}>
        {surface !== 'plugins' && (
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
              {showMarketWait && (
                <Tooltip label={() => marketWaitTip(heldMarketVersion!, eligibleMarketVersion, uiLocale, t)} side="bottom" delayMs={HOVER_TIP_DELAY_MS} portal maxWidth={320}>
                  <span className={css.marketVersionWait} tabIndex={0}>{t('marketVersionWaiting')}</span>
                </Tooltip>
              )}
            </span>
          )}
          <a className={css.submitLink} href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md" target="_blank" rel="noreferrer">{t('submitPlugin')}</a>
          {exportLogButton}
          {batchActions}
          </div>
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
            {hasUpdates && <StateDot state="error" size={7} className={css.dot} />}
          </button>
          <button className={tab === 'blocked' ? `${css.tab} ${css.on}` : css.tab} onClick={() => setTab('blocked')}>
            {t('tabBlocked') + (blockedNames.length > 0 ? ' (' + blockedNames.length + ')' : '')}
          </button>
          <button
            className={(tab === 'backup' || tab === 'diagnostics') ? `${css.tab} ${css.on}` : css.tab}
            onClick={() => { if (tab !== 'backup' && tab !== 'diagnostics') setTab('backup') }}
          >{t('tabAdvanced')}</button>
          {/* Sponsors live in the spacer. It never shrinks below the mark, so
              when the row has no room the spacer (and the buttons after it)
              moves to the next line instead of hiding a sponsor. */}
          <span className={surface === 'plugins' ? `${css.grow} ${css.sponsorSlot}` : css.grow}>
            {surface === 'plugins' && <SponsorMark lang={lang} t={t} />}
          </span>
          {/* The host page already names this tab, so these sit here instead
              of a second title row. Settings and the sidebar keep them in
              the heading. Export stays reachable on this surface — install
              failures ask for a log, and this is where that failure happens. */}
          {surface === 'plugins' && batchActions}
          {surface === 'plugins' && exportLogButton}
          {/* In the tab row, not above the grid: paginating, searching and
              switching tab all leave it — and any pending decision — in place. */}
          <OperationsPanel
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
                else doUpdate(record.name, record.updateOptions?.force, record.updateOptions?.restore, record.updateOptions?.compatVersion, false, record.updateOptions?.eligibleVersion)
              })
            }}
          />
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
        {pendingRestart > 0 && (
          <div className={css.banner}>
            <IconRefreshOutline14 size={14} className={css.bannerIcon} />
            <span className={css.grow}><b>{pendingRestart}</b> {t('restartBanner')}</span>
            <Tooltip
              label={t(restartHintKey({ debuggerLatch, restartReachable, supervisor })).replace('{0}', supervisor ?? '')}
              side="bottom"
            >
              <span className={css.bannerHint}><IconQuestionOutline14 size={14} /></span>
            </Tooltip>
            {restartEnabled && restartReachable && debuggerLatch === null && recovery === null && !marketGone && (
              <Button
                variant="primary"
                size="sm"
                disabled={restarting || hostBusy || busyUrl !== null || updatingName !== null || removingName !== null}
                onClick={doRestart}
              >{restarting ? t('restarting') : t('restartNow')}</Button>
            )}
            {/* Only the standing host-reported notice is dismissible: a
                banner for something you just did in this session should not
                be swipeable away mid-flow. */}
            {showHostPending && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('dismissNotice')}
                onClick={() => {
                  setRestartNoticeDismissed(true)
                  try { sessionStorage.setItem('dshm-restart-dismissed', String(bootId ?? '')) } catch { /* storage unavailable */ }
                }}
              >{t('dismiss')}</Button>
            )}
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
          onUpdate={name => {
            if (updates[name]?.restoreRequired === true) askRestore(name)
            else doUpdate(name)
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
                else if (updateName !== undefined) doUpdate(updateName, updateOptions?.force, updateOptions?.restore, updateOptions?.compatVersion, false, updateOptions?.eligibleVersion)
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
            {staleName !== null && (
              <Button variant="primary" size="sm" onClick={() => doUpdate(staleName, true)}>{t('updateNow')}</Button>
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
      <div
        className={css.body}
        ref={bodyRef}
        onScroll={surface === 'plugins' && !themesFullscreen ? undefined : e => {
          const show = e.currentTarget.scrollTop > 400
          setShowTop(prev => (prev === show ? prev : show))
          // Card menus are portaled to document.body and re-pinned to their
          // trigger on every scroll, so nothing here clips them: a trigger
          // scrolled under the sticky header or out of the list drags its
          // menu out over the header and past the panel edge.
          setPluginMenuUrl(null)
          setInstalledMenuName(null)
          setGroupMenuFor(null)
          setAssignFor(null)
        }}
      >
        {/* Everything below reaches the host through the market's own routes;
            with those gone (#962) every control here would fail on click, so
            the body says the one thing that is both true and actionable
            instead of leaving a page of dead buttons. */}
        {marketGone
          ? (
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
          : tab === 'backup'
          ? (
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
          : tab === 'discover'
          ? loadError !== null
            ? <div className={css.empty}>
                <div>{t('loadFail')}</div>
                <div className={css.err}>{loadError}</div>
                <Button variant="outline" size="sm" className={css.retryBtn} onClick={() => { void loadCatalog() }}>
                  {t('loadRetry')}
                </Button>
              </div>
            : data === null
              ? <div className={css.loading}><span className={css.logoMark}><MarketLogo size={26} animated /></span>{t('loading')}</div>
              : (
                  <>
                    <div ref={setCatsSentinel} />
                    <div className={css.stickyHead}>
                    <div className={css.tabSearchRow}>
                      <SearchInput key="discover" resetToken={discoverSearchReset} className={css.tabSearch} placeholder={t('searchPh')} value={q} onCommit={setQ} t={t} />
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
                      {compatibleWithHost && typeof hostVersion === 'string' && pageHostPackages.length > 0 && (
                        <div className={css.hostFilterNote}>
                          {loadedHostPackages < pageHostPackages.length
                            ? t('hostFilterLoading')
                              .replace('{0}', String(loadedHostPackages))
                              .replace('{1}', String(pageHostPackages.length))
                            : t(hostUnavailableCount > 0 ? 'hostFilterIncomplete' : 'hostFilterActive')
                                .replace('{0}', hostVersion)
                                .replace('{1}', String(hostHiddenCount))
                                .replace('{2}', String(hostUnavailableCount))}
                        </div>
                      )}
                    </div>
                    </div>
                    {hasRecent && (recentHidden
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
                            <Button variant="ghost" size="sm" className={css.recentHide} onClick={hideRecent}>{t('recentHide')}</Button>
                          </div>
                          {/* #940: clipped in place, never unmounted. */}
                          <div
                            id="dshm-recent-grid"
                            className={recentCollapsed ? `${css.recentRow} ${css.recentCollapsed}` : css.recentRow}
                          >
                            {recentPlugins.map(plugin => recentTile(plugin))}
                          </div>
                        </section>
                    )}
                    {pagePlugins.length === 0
                      ? <EmptyResults message={basePage.length > 0 ? 'hostFilterEmpty' : pluginsAll.length > 0 ? 'blockedFilteredEmpty' : 'empty'} t={t}
                          onClear={data.plugins.length > 0 && (q !== '' || cat !== 'all' || timeRange !== 'all' || compatibleWithHost) ? () => {
                            setQ(''); resetDiscoverSearch(value => value + 1)
                            setCat('all'); setTimeRange('all'); setCompatibleWithHost(false)
                            bodyRef.current?.querySelector('input')?.focus()
                          } : undefined}
                        />
                      : <Masonry items={pagePlugins} render={plugin => pluginCard(plugin)} />}
                    {pluginsUnblocked.length > 0 && (surface === 'plugins'
                      ? <LoadMore more={discoverMore.more} onLoad={discoverMore.loadMore} t={t} />
                      : <Pager currentPage={currentPage} totalPages={totalPages} pageSize={pageSize}
                          onGoToPage={goToPage} onChangePageSize={changePageSize} t={t} />)}
                  </>
                )
          : tab === 'favorites'
            ? data === null
              ? <div className={css.loading}><span className={css.logoMark}><MarketLogo size={26} animated /></span>{t('loading')}</div>
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
          : tab === 'themes' && themeSnap !== null
            ? (
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
                    const extra = themeSnap.themes.filter(def => def.id !== 'light' && def.id !== 'dark')
                    return extra.length > 0 && (
                      <div className={`${css.grid} ${css.themesGrid}`}>
                        {extra.map(def => themeCard(def.id, def.id, themeSwatch(def)))}
                      </div>
                    )
                  })()}
                  {data === null
                    ? <div className={css.loading}><span className={css.logoMark}><MarketLogo size={26} animated /></span>{t('loading')}</div>
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
            : tab === 'diagnostics'
            ? <Diagnostics t={t} />
            : tab === 'blocked'
              ? data === null
                ? <div className={css.loading}><span className={css.logoMark}><MarketLogo size={26} animated /></span>{t('loading')}</div>
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
            : (
                <>
                  <div className={css.viewBar}>
                    <button type="button" className={installedView === 'list' ? `${css.viewBtn} ${css.viewOn}` : css.viewBtn} onClick={() => setInstalledView('list')}>{t('tabList')}</button>
                    <button type="button" className={installedView === 'groups' ? `${css.viewBtn} ${css.viewOn}` : css.viewBtn} onClick={() => setInstalledView('groups')}>{t('tabGroups')}</button>
                  </div>
                  <div className={css.tabSearchRow}>
                    <SearchInput key="installed" resetToken={installedSearchReset} className={css.tabSearch} placeholder={t('searchPh')} value={qInstalled} onCommit={setQInstalled} t={t} />
                    {/* The order control belongs to the list only: groups are
                        ordered by the user's own group order, and offering to
                        sort them by install time would silently rearrange
                        something that is not sorted by anything else. */}
                    {installedView === 'list' && (
                      <InstalledSortMenu value={installedSort} onChange={setInstalledSort} t={t} />
                    )}
                    {installedView === 'groups' && (
                      creatingGroup
                        ? (
                            <div
                              className={css.groupCreateInline}
                              onBlur={event => {
                                const next = event.relatedTarget
                                if (next instanceof Node && event.currentTarget.contains(next)) return
                                cancelCreateGroup()
                              }}
                            >
                              <Input className={css.inlineInput} placeholder={t('groupNamePh')} value={newGroupName} onChange={e => setNewGroupName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') doCreateGroup(); if (e.key === 'Escape') cancelCreateGroup() }} autoFocus />
                              <Button variant="primary" size="sm" onClick={doCreateGroup}>{t('groupCreate')}</Button>
                              <Button variant="ghost" size="sm" onClick={cancelCreateGroup}>{t('cancel')}</Button>
                            </div>
                          )
                        : <Button variant="outline" size="sm" onClick={() => setCreatingGroup(true)}>{t('groupNew')}</Button>
                    )}
                  </div>
                  {installedView === 'groups'
                      ? (
                          <>
                            {groupOrder.length > 0 && (
                              <div className={css.groupBulkActions}>
                                <Button variant="ghost" size="sm"
                                  disabled={groupQuery !== '' || groupOrder.every(gid => collapsedGroups.has(gid))}
                                  onClick={() => setCollapsedGroups(new Set(groupOrder))}
                                >{t('groupCollapseAll')}</Button>
                                <Button variant="ghost" size="sm"
                                  disabled={groupQuery !== '' || !groupOrder.some(gid => collapsedGroups.has(gid))}
                                  onClick={() => setCollapsedGroups(new Set())}
                                >{t('groupExpandAll')}</Button>
                              </div>
                            )}
                            {groupQuery === '' && groupOrder.length === 0
                              ? <div className={css.empty}>{t('noGroups')}</div>
                              : visibleGroupIds.map(gid => {
                                  const members = groups[gid] ?? []
                                  const nameHit = groupQuery !== '' && gid.toLowerCase().includes(groupQuery)
                                  const visibleMembers = (groupQuery === '' || nameHit
                                    ? members
                                    : members.filter(matchesInstalledQuery)
                                  ).slice().sort((a, b) => Number(installedThemeNames.has(b)) - Number(installedThemeNames.has(a)))
                                  const themeSlot = visibleMembers.some(name => installedThemeNames.has(name)) && visibleMembers.some(name => !installedThemeNames.has(name))
                                  if (groupQuery !== '' && !nameHit && visibleMembers.length === 0) return null
                                  const switchableMembers = members.filter(member => activations[member]?.library !== true)
                                  const sw = groupSwitchState(switchableMembers, effectiveDisabledSet)
                                  const enabledCount = switchableMembers.filter(member => !effectiveDisabledSet.has(member)).length
                                  const collapsed = groupQuery === '' && collapsedGroups.has(gid)
                                  const meta = t('groupMembersMeta')
                                    .replace('{0}', String(members.length))
                                    .replace('{1}', String(enabledCount))
                                  return (
                                    <div className={css.groupRow} key={gid}>
                                      <div className={css.groupHead}>
                                        <button
                                          type="button"
                                          className={css.groupCollapse}
                                          aria-expanded={!collapsed}
                                          aria-label={(collapsed ? t('groupExpand') : t('groupFold')).replace('{0}', gid)}
                                          onClick={() => toggleCollapsedGroup(gid)}
                                        >
                                          {collapsed
                                            ? <IconChevronRightOutline14 size={14} />
                                            : <IconChevronDownOutline14 size={14} />}
                                        </button>
                                        {/* Deliberately NOT onOffSwitch: a group's state is
                                            three-valued (all on / all off / mixed), and the
                                            host's Switch is a boolean control — routing this
                                            through it would flatten "mixed" into one of the
                                            two, which is the one thing this switch must not
                                            say. */}
                                        <button
                                          type="button"
                                          role="switch"
                                          aria-checked={sw === 'on' ? true : sw === 'off' ? false : 'mixed'}
                                          aria-label={(sw !== 'on' ? t('enable') : t('disable')) + ' ' + gid}
                                          className={sw === 'on' ? `${css.switch} ${css.switchOn}` : sw === 'mixed' ? `${css.switch} ${css.switchMixed}` : css.switch}
                                          disabled={togglingName !== null || sw === 'empty'}
                                          onClick={() => doGroupToggle(gid, sw !== 'on')}
                                        >
                                          <span className={css.switchKnob} />
                                        </button>
                                        <div className={css.groupTitle}>
                                          <span className={css.groupName}>{gid}</span>
                                          <span className={css.groupMeta}>{meta}</span>
                                          {sw === 'mixed' && <span className={css.groupHint}>{t('groupMixed')}</span>}
                                        </div>
                                        <div className={css.groupActions}>
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => openThemePanel(gid)}
                                          >{members.some(member => installedThemeNames.has(member)) ? t('groupChangeTheme') : t('groupPickTheme')}</Button>
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => openAddPanel(gid)}
                                          >{t('groupAdd')}</Button>
                                          {deletingGroup === gid
                                            ? (
                                                <>
                                                  <Button variant="primary" size="sm" className={css.dangerArmed} onClick={() => doDeleteGroup(gid)}>{t('groupConfirmDelete')}</Button>
                                                  <Button variant="ghost" size="sm" onClick={() => setDeletingGroup(null)}>{t('cancel')}</Button>
                                                </>
                                              )
                                            : (
                                                <Menu
                                                  open={groupMenuFor === gid}
                                                  onClose={() => setGroupMenuFor(null)}
                                                  onSelect={id => {
                                                    setGroupMenuFor(null)
                                                    if (id === 'rename') {
                                                      setAddPanel(null)
                                                      setDeletingGroup(null)
                                                      setRenamingGroup(gid)
                                                      setRenamingValue(gid)
                                                    } else if (id === 'delete') {
                                                      setAddPanel(null)
                                                      setRenamingGroup(null)
                                                      setDeletingGroup(gid)
                                                    }
                                                  }}
                                                  align="end"
                                                  portal
                                                  anchor={(
                                                    <Button
                                                      variant="ghost"
                                                      size="sm"
                                                      aria-label={t('groupMore')}
                                                      onClick={() => setGroupMenuFor(open => open === gid ? null : gid)}
                                                    >···</Button>
                                                  )}
                                                  items={[
                                                    { id: 'rename', label: t('groupRename') },
                                                    { id: 'delete', label: t('groupDelete') },
                                                  ]}
                                                />
                                              )}
                                        </div>
                                      </div>
                                      {!collapsed && (
                                        <div className={css.groupMembers}>
                                          {members.length === 0 && <div className={css.groupHint}>{t('groupEmpty')}</div>}
                                          {visibleMembers.map(member => {
                                            const { note, shown } = installedBlurb(member)
                                            return (
                                            <div className={installedThemeNames.has(member) && themeSlot ? `${css.groupMember} ${css.themeSlot}` : css.groupMember} key={member}>
                                              <span className={shown !== '' ? `${css.memberName} ${css.memberNameWithDesc}` : css.memberName}>
                                                <span className={css.nm}>{member}</span>
                                                {installedThemeNames.has(member) && <span className={css.memberKind}>· {t('groupThemeBadge')}</span>}
                                              </span>
                                              {shown !== '' && (
                                                <Tooltip label={shown} side="top" maxWidth={320}>
                                                  <span className={note !== undefined ? `${css.ungroupedDesc} ${css.noteMine}` : css.ungroupedDesc}>{shown}</span>
                                                </Tooltip>
                                              )}
                                              {activations[member]?.library === true && <span className={css.spec}>{t('stateLibrary')}</span>}
                                              {activations[member]?.library !== true && effectiveDisabledSet.has(member) && <span className={css.spec}>{t('disabledState')}</span>}
                                              {activations[member]?.library !== true && onOffSwitch({
                                                label: (effectiveDisabledSet.has(member) ? t('enable') : t('disable')) + ' ' + member,
                                                on: !effectiveDisabledSet.has(member),
                                                disabled: togglingName !== null,
                                                toggle: () => doToggle(member, effectiveDisabledSet.has(member)),
                                              })}
                                              <Button variant="ghost" size="sm" onClick={() => doRemoveMember(gid, member)}>{t('groupRemove')}</Button>
                                            </div>
                                            )
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                            {(groupQuery === '' || visibleUngrouped.length > 0) && (
                            <div className={css.groupRow}>
                              <div className={css.groupHead}>
                                <div className={css.groupTitle}>
                                  <span className={css.groupName}>{t('ungrouped')}</span>
                                  <span className={css.groupMeta}>
                                    {t('groupMembersMeta')
                                      .replace('{0}', String((groupQuery === '' ? ungroupedNames : visibleUngrouped).length))
                                      .replace('{1}', String((groupQuery === '' ? ungroupedNames : visibleUngrouped).filter(name => activations[name]?.library !== true && !effectiveDisabledSet.has(name)).length))}
                                  </span>
                                </div>
                              </div>
                              <div className={css.groupMembers}>
                                {(groupQuery === '' ? ungroupedNames : visibleUngrouped).length === 0
                                  ? <div className={css.empty}>{t('installedEmpty')}</div>
                                  : visibleUngrouped.map(name => {
                                      const { entry, note, shown } = installedBlurb(name)
                                      const act = activations[name]
                                      const off = act?.library !== true && effectiveDisabledSet.has(name)
                                      const meta = !off && act !== undefined ? activationMeta(act.state, t, act.dependencyOf, act.loadedByProfile, act.library) : null
                                      const stateLabel = act?.library === true
                                        ? meta?.label
                                        : off
                                          ? t('disabledState')
                                          : act?.state === 'inert' && act.dependencyOf === undefined && act.loadedByProfile !== true
                                          ? t('groupStateInert')
                                          : act?.state === 'restart'
                                            ? t('groupStateRestart')
                                            : act?.state === 'broken'
                                              ? t('groupStateBroken')
                                              : meta?.label
                                      const stateDot = off ? 'warning' as const : meta?.dot === 'error' ? 'error' as const : meta?.dot === 'warning' ? 'warning' as const : 'done' as const
                                      const stateClass = stateDot === 'error' ? css.actBroken : stateDot === 'warning' ? css.actWarn : css.actLive
                                      return (
                                        <div className={`${css.groupMember} ${css.ungroupedRow}`} key={'ug-' + name}>
                                          <span className={css.nm} title={name}>
                                            {name}
                                            {entry?.deprecated === true && <span className={css.depBadge}>{t('deprecatedBadge')}</span>}
                                          </span>
                                          {installedThemeNames.has(name) && <span className={css.memberKind}>· {t('groupThemeBadge')}</span>}
                                          {stateLabel !== undefined && (
                                            <span className={css.ungroupedState}>
                                              {act?.library === true
                                                ? <span className={css.spec}>{stateLabel}</span>
                                                : <span className={stateClass} title={stateLabel}><StateDot state={stateDot} size={7} />{stateLabel}</span>}
                                            </span>
                                          )}
                                          {shown !== '' && (
                                            <Tooltip label={shown} side="top" maxWidth={320}>
                                              <span className={note !== undefined ? `${css.ungroupedDesc} ${css.noteMine}` : css.ungroupedDesc}>{shown}</span>
                                            </Tooltip>
                                          )}
                                          <div className={css.groupMemberAction}>
                                            <Menu
                                              open={assignFor === name}
                                              onClose={() => setAssignFor(null)}
                                              onSelect={id => {
                                                const blocked = installedThemeNames.has(name)
                                                  && (groups[id] ?? []).some(member => installedThemeNames.has(member))
                                                if (blocked) return
                                                setAssignFor(null)
                                                doAssign(name, id)
                                              }}
                                              align="end"
                                              portal
                                              anchor={(
                                                <Button
                                                  variant="outline"
                                                  size="sm"
                                                  disabled={groupOrder.length === 0}
                                                  icon={assignFor === name ? <IconChevronUpOutline14 size={14} /> : <IconChevronDownOutline14 size={14} />}
                                                  onClick={() => setAssignFor(open => open === name ? null : name)}
                                                >{t('groupAssign')}</Button>
                                              )}
                                              items={groupOrder.map(gid => {
                                                const blocked = installedThemeNames.has(name)
                                                  && (groups[gid] ?? []).some(member => installedThemeNames.has(member))
                                                return {
                                                  id: gid,
                                                  disabled: blocked,
                                                  label: blocked ? gid + ' · ' + t('groupThemeTaken') : gid,
                                                }
                                              })}
                                            />
                                          </div>
                                        </div>
                                      )
                                    })}
                              </div>
                            </div>
                            )}
                            {groupQuery !== '' && visibleGroupIds.length === 0 && visibleUngrouped.length === 0 && (
                              <div className={css.empty}>{t('groupSearchEmpty')}</div>
                            )}
                            <p className={css.groupOrgHint}>{t('groupOrgHint')}</p>
                          </>
                        )
                      : orderedInstalledEntries.length === 0
                        ? <div className={css.empty}>{t('installedEmpty')}</div>
                        : (
                          <Masonry
                            maxColumns={2}
                            minColumns={1}
                            className={css.masonryInstalled}
                            items={orderedInstalledEntries
                            .filter(([name, spec]) => {
                              const needle = qInstalled.trim().toLowerCase()
                              if (needle === '') return true
                              if (name.toLowerCase().includes(needle)) return true
                              if (String(spec).toLowerCase().includes(needle)) return true
                              const entry = data === null ? undefined : catalogEntryForInstalled(data.plugins, name, String(spec), repoIdentities[name], repoHints[name])
                              if (entry !== undefined) {
                                const desc = (entry.description && (entry.description[lang] || entry.description.en)) || ''
                                if (desc.toLowerCase().includes(needle)) return true
                                if ((entry.owner || '').toLowerCase().includes(needle)) return true
                              }
                              return false
                            })}
                            render={([name, spec]) => {
                            const missing = pendingBackup !== null && !installedFiles.includes(name)
                            const entry = data === null ? undefined : catalogEntryForInstalled(data.plugins, name, String(spec), repoIdentities[name], repoHints[name])
                            const status = updates[name]
                            // A generation is the desktop host's own install (#497):
                            // the host updates it, the market only says a newer
                            // release exists. Not a development checkout, so no
                            // "local" tag and no restore — the host would put the
                            // generation straight back.
                            const generation = status?.kind === 'generation' || isGenerationSpec(String(spec))
                            const localDev = isLocalDev(String(spec), status)
                            const act = activations[name]
                            const meta = act !== undefined ? activationMeta(act.state, t, act.dependencyOf, act.loadedByProfile, act.library) : null
                            const version = status && status.version ? 'v' + status.version : ''
                            // When this market installed it (#1142), in the
                            // reader's own timezone. `updatedOn` never
                            // replaces the install date on the line — they are
                            // two events, and only the install date is what
                            // the sort orders by.
                            const stamp = installTimes[name]
                            const installedOn = installedDateText(stamp?.installedAt)
                            const updatedOn = installedDateText(stamp?.updatedAt)
                            const installedWhenTitle = [
                              installedOn === null ? t('installedAtUnknown') : `${t('installedAtLabel')} ${installedOn}`,
                              updatedOn === null ? '' : `${t('updatedAtLabel')} ${updatedOn}`,
                            ].filter(Boolean).join(' · ')
                            const specText = String(spec)
                            // A plain range beside the resolved version says the
                            // same thing twice. Every other spec — github:, file:,
                            // link:, a tag — is the only place the row says where
                            // the plugin came from, so it stays.
                            const specRedundant = version !== '' && /^[\^~]?\d/.test(specText)
                            const releaseSource = entry !== undefined && catalogReleaseSourceOf(specText, entry) !== null
                            const localPath = localPathOf(specText)
                            const ghSpec = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#|$)/.exec(specText)
                            const repoUrl = entry !== undefined ? entry.url : ghSpec !== null ? 'https://github.com/' + ghSpec[1] : null
                            const off = act?.library !== true && effectiveDisabledSet.has(name)
                            // Switches only where they make sense: everything in
                            // the disable list (to re-enable), plus live/restart
                            // states. inert/broken rows keep their diagnosis
                            // without a misleading toggle (#60).
                            const toggleable = act?.library !== true && (off || (act !== undefined && (act.state === 'live' || act.state === 'restart')))
                            const updatable = isPluginUpdatable(name, String(spec), status, updatedNames)
                            const metaBits = [
                              version,
                              localDev ? t('linkedDev') : '',
                              // Third segment of the same line (#1142), and only
                              // when the market knows it. Every package installed
                              // before this existed, or through the CLI, has no
                              // date: a dash on all of those rows is a placeholder
                              // that says nothing, so the row stays quiet and the
                              // hover text explains why there is no date. The
                              // label says what the date is: a bare date beside a
                              // version reads as a release date.
                              installedOn === null ? '' : `${t('installedAtLabel')} ${installedOn}`,
                            ].filter(Boolean)
                            // Same DSH chip as Discover (label / tip / bad ink).
                            // - No catalog entry: stay quiet (scan cannot settle → never Loading).
                            // - Activation incompat: status band only — no second red chip.
                            // - Local-dev / missing: quiet.
                            const compatibilityKey = entry !== undefined ? hostCompatibilityKey(entry) : null
                            const compatibility = compatibilityKey === null
                              ? undefined
                              : hostCompatibility[compatibilityKey]
                            const hostChip = hostRequirementChip(compatibility, compatibilityKey, t)
                            const showIncompat = !localDev && act?.state === 'incompatible'
                            const showHostRequirement = !missing && !localDev && !showIncompat && entry !== undefined
                              // Only a known requirement earns a chip. "undeclared" / "unknown" /
                              // "loading" on every card is noise the user cannot act on.
                              && compatibility?.requirement != null
                            const note = notes[name]
                            const authored = authoredDescription(name, entry)
                            const theirs = showTheirs.includes(name)
                            const shown = note !== undefined && !theirs ? note : authored
                            return (
                              <div key={name} className={missing ? `${css.irow} ${css.irowMissing}` : css.irow}>
                                <div style={{ minWidth: 0 }}>
                                  <div className={css.irowHead}>
                                  {/* Row-scoped, NOT `.nm` alone: `.nm` clips with
                                      overflow+ellipsis as one block, so with the name and
                                      the version as inline siblings the ellipsis landed at
                                      the end of the LINE and ate the version — a long
                                      scoped package name hid the one fact this row exists
                                      to state (#257 by @HualuozhE). Laying the row out as
                                      flex lets the name be the only thing that truncates.
                                      `.nm` is shared by six other places (discover titles,
                                      group rows, theme cards); changing it there would
                                      reflow all of them. */}
                                  <div className={`${css.nm} ${css.irowName}`}>
                                    {/* The name is the link to the README. A separate button
                                        beside it pointed at the same page. */}
                                    <span className={css.irowNameText}>
                                      {repoUrl !== null
                                        ? <a className={css.nameLink} href={repoUrl + '#readme'} target="_blank" rel="noreferrer" title={name} aria-label={`${name} — ${t('readme')}`}>{name}</a>
                                        : name}
                                    </span>
                                    {entry?.deprecated === true && <span className={css.depBadge}>{t('deprecatedBadge')}</span>}
                                  </div>
                                  {!missing && name !== 'dsh-market' && name !== 'dshmarket' && (
                                    <span className={css.irowMenu}>{renderInstalledBlockMenu(name)}</span>
                                  )}
                                  </div>
                                  {(metaBits.length > 0 || updatable) && (
                                    <div className={css.irowMeta}>
                                      {metaBits.length > 0 && (
                                        <span className={css.irowMetaText} title={installedWhenTitle}>
                                          {metaBits.join(' · ')}
                                        </span>
                                      )}
                                      {/* Notes sit beside the installed version — the
                                          update button already says a newer cut exists,
                                          so a second "有新版本" band is just empty space. */}
                                      {updatable && (
                                        <button
                                          type="button"
                                          className={css.notesLink}
                                          onClick={() => openNotes(
                                            name,
                                            status?.current ?? null,
                                            status?.latest ?? null,
                                            // Prefer the mature install target (#1193); else latest.
                                            status?.eligibleVersion ?? status?.latest ?? null,
                                            repoUrl,
                                          )}
                                        >{`${t('notesLink')} ›`}</button>
                                      )}
                                    </div>
                                  )}
                                  {specRedundant
                                    ? null
                                    : localPath !== null
                                      ? (
                                          <div className={css.irowPath}>
                                            <span className={css.irowPathIcon}><IconFolderOpen16 size={14} /></span>
                                            <span className={css.spec} title={localPath}>{shortLocalPath(localPath)}</span>
                                            {isAbsoluteLocalPath(localPath) && (
                                              <span className={css.irowPathCopy}>
                                                <ConfirmCopyButton text={localPath} label={t('copyPath')} copiedLabel={t('pathCopied')} />
                                              </span>
                                            )}
                                          </div>
                                        )
                                      : releaseSource
                                        ? (
                                            <div className={css.irowPath}>
                                              <span className={css.irowPathIcon}><IconLinkOutline14 size={14} /></span>
                                              <a className={`${css.spec} ${css.src}`} href={specText} title={specText} target="_blank" rel="noreferrer">GitHub Release</a>
                                            </div>
                                          )
                                      : repoUrl !== null
                                        ? (
                                            <div className={css.irowPath}>
                                              <span className={css.irowPathIcon}><IconLinkOutline14 size={14} /></span>
                                              <a className={`${css.spec} ${css.src}`} href={repoUrl} target="_blank" rel="noreferrer">{specText}</a>
                                            </div>
                                          )
                                        : <div className={css.spec}>{specText}</div>}
                                  {/* The user's own note REPLACES the author's
                                      description (#347): a catalog blurb answers
                                      "what is this", written for strangers and
                                      often not in the reader's language, and
                                      cannot answer "why did I install this" —
                                      which is what someone with forty plugins
                                      is asking. The original stays one click
                                      away rather than being lost. */}
                                  <div className={css.irowDescBand}>
                                    {notingName === name
                                      ? (
                                          <div className={css.noteEdit}>
                                            <Input
                                              className={css.noteInput}
                                              value={noteDraft}
                                              maxLength={NOTE_MAX}
                                              autoFocus
                                              placeholder={t('notePlaceholder')}
                                              onChange={e => setNoteDraft(e.target.value)}
                                              onKeyDown={(e) => {
                                                // Enter while an IME is composing commits the candidate, not the note.
                                                if (e.nativeEvent.isComposing || e.keyCode === 229) return
                                                if (e.key === 'Enter') saveNote(name, noteDraft)
                                                if (e.key === 'Escape') setNotingName(null)
                                              }}
                                            />
                                            <div className={css.noteEditBar}>
                                              <span className={css.noteCount} aria-hidden="true">{`${noteDraft.length}/${NOTE_MAX}`}</span>
                                              <Button variant="ghost" size="sm" onClick={() => setNotingName(null)}>{t('cancel')}</Button>
                                              <Button variant="primary" size="sm" onClick={() => saveNote(name, noteDraft)}>{t('noteSave')}</Button>
                                            </div>
                                          </div>
                                        )
                                      : shown !== ''
                                        ? (
                                            <div className={`${css.desc} ${css.descTight} ${css.irowBody}`}>
                                              <CardDesc
                                                key={shown}
                                                text={shown}
                                                t={t}
                                                lines={3}
                                                className={css.irowDesc}
                                                textClassName={note !== undefined && !theirs ? css.noteMine : undefined}
                                              />
                                            </div>
                                          )
                                        : null}
                                    {/* Foot stays outside the note editor so the DSH chip
                                        does not vanish while editing. Note actions hide
                                        during edit (the editor is the action). */}
                                    {(showHostRequirement || notingName !== name) && (
                                      <div className={(shown === '' || notingName === name) ? `${css.irowFootRow} ${css.irowNoteActionsSpaced}` : css.irowFootRow}>
                                        {showHostRequirement && (
                                          <CardTip label={hostChip.title} maxWidth={320}>
                                            <span
                                              className={hostChip.bad
                                                ? `${css.hostRequirement} ${css.hostRequirementBad}`
                                                : css.hostRequirement}
                                              data-status={hostChip.status}
                                              tabIndex={0}
                                            >{hostChip.label}</span>
                                          </CardTip>
                                        )}
                                        {notingName !== name && (
                                          <div className={css.irowNoteActions}>
                                            {note !== undefined && authored !== '' && (
                                              <button
                                                type="button"
                                                className={css.noteToggle}
                                                title={theirs ? t('noteSeeMine') : t('noteSeeTheirs')}
                                                aria-label={theirs ? t('noteSeeMine') : t('noteSeeTheirs')}
                                                onClick={() => setShowTheirs(list => theirs ? list.filter(n => n !== name) : list.concat(name))}
                                              >{theirs ? t('noteMine') : t('noteTheirs')}</button>
                                            )}
                                            <button
                                              type="button"
                                              className={css.noteAdd}
                                              onClick={() => { setNoteDraft(note ?? ''); setNotingName(name) }}
                                            >
                                              {note === undefined && <IconPlus size={14} />}
                                              {note === undefined ? t('noteAdd') : t('noteEdit')}
                                            </button>
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                  {/* Incompat / muted-reminder only (#294, #728). Held waits
                                      sit with the update control. Compatible rows show the
                                      Discover-parity DSH chip; incompat rows use this band only. */}
                                  {(() => {
                                    const exempt = updateExemptSet.has(name)
                                    // Activation is the installed fact. Catalog discovery only
                                    // fills requirement numbers — never lights the band alone
                                    // (catalog latest can be incompatible while this install runs).
                                    const ignored = !exempt && bootId !== null && ignoredUpdateSet.has(name)
                                    if (!exempt && !ignored && !showIncompat) return null
                                    return (
                                      <div className={css.irowStatusBand}>
                                        {showIncompat && (
                                          <div className={css.irowIncompat}>
                                            <div className={css.irowIncompatTitle}>{t('installedIncompatTitle')}</div>
                                            <div className={css.irowIncompatBody}>
                                              {t('installedIncompatWhy')
                                                .replace('{0}', compatibility?.requirement ?? t('hostIncompatibleUnknown'))
                                                .replace('{1}', (typeof hostVersion === 'string' ? hostVersion : null) ?? t('hostIncompatibleUnknown'))}
                                            </div>
                                            <div className={css.irowIncompatBody}>
                                              {status?.updateAvailable === true
                                                ? t('installedIncompatNextUpdate')
                                                : compatibility?.status === 'incompatible'
                                                  ? t('installedIncompatNextHost')
                                                  : t('installedIncompatNextUnknown')}
                                            </div>
                                          </div>
                                        )}
                                        {(exempt || ignored) && (
                                          <div className={css.irowStatus}>
                                            <span className={css.irowStatusIcon}><IconBellOff size={16} /></span>
                                            {exempt
                                              ? <span className={css.metaInline} title={t('updateExemptHint')} role="status">{t('updateExemptMark')}</span>
                                              : <span className={css.metaInline} role="status">{t('updateNoticeIgnored')}</span>}
                                            <span className={css.irowStatusAction}>
                                              {exempt
                                                ? (
                                                    <button
                                                      type="button"
                                                      className={css.noteToggle}
                                                      title={t('updateExemptHint')}
                                                      aria-label={`${t('updateExemptRestore')} ${name}`}
                                                      onClick={() => toggleUpdateExempt(name)}
                                                    >{t('updateExemptRestore')}</button>
                                                  )
                                                : (
                                                    <button
                                                      type="button"
                                                      className={css.noteToggle}
                                                      aria-label={`${t('updateExemptRestore')} ${name}`}
                                                      onClick={() => unignoreUpdateNotice(name)}
                                                    >{t('updateExemptRestore')}</button>
                                                  )}
                                            </span>
                                          </div>
                                        )}
                                      </div>
                                    )
                                  })()}
                                  {!off && act !== undefined && meta !== null && (
                                        <div className={css.act}>
                                          {/* Only a state the switch does NOT already show earns a
                                              line here: "installed but not active" is news, "live"
                                              is what the switch is for. Incompatible already owns
                                              the quiet status band — do not repeat the same label. */}
                                          {act.library === true
                                            ? <span className={css.metaTag}>{meta.label}</span>
                                            : meta.dot !== 'done' && (localDev || act.state !== 'incompatible') && (
                                                <span className={meta.dot === 'error' ? css.actBroken : css.actWarn}>
                                                  <StateDot state={meta.dot} size={7} />
                                                  {meta.label}
                                                </span>
                                              )}
                                          {act.library === true && <div className={css.spec}>{t('libraryUseHint')}</div>}
                                          {act.library !== true && act.state !== 'live' && act.reasons.length > 0 && (
                                            <DisclosureRow
                                              icon={<IconQuestionOutline14 size={14} />}
                                              title={t('actWhy')}
                                              open={whyOpen === name}
                                              expandable
                                              expandOnRowClick
                                              onToggle={() => setWhyOpen(whyOpen === name ? null : name)}
                                              className={css.actWhy}
                                            >
                                              <div className={css.spec}>{localizeBilingualList(act.reasons, lang)}</div>
                                            </DisclosureRow>
                                          )}
                                        </div>
                                      )}
                                  {entry !== undefined && entry.deprecated === true && (
                                    <div className={css.deprecate} style={{ marginTop: 8 }}>
                                      <div className={css.depLine}>
                                        <span>⚠️ {t('deprecatedWarn')}</span>
                                        {entry.replacement !== undefined && (
                                          <span className={css.src}>{t('replacementHint') + ' ' + entry.replacement}</span>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                  {updatingName === name && (
                                    <div className={css.progress}>
                                      <span className={css.spin}><IconLoadingOutline16 size={14} /></span>
                                      <code className={css.grow}>{progressText}</code>
                                      {progressPct !== null && <span className={css.pct}>{progressPct}%</span>}
                                      <Button variant="outline" size="sm" disabled={cancelling} onClick={() => doCancel()}>
                                        {cancelling ? t('cancelling') : t('cancelOp')}
                                      </Button>
                                      <div className={css.bar}>
                                        <div
                                          className={progressPct !== null ? css.barFill : `${css.barFill} ${css.barWave}`}
                                          style={progressPct !== null ? { width: `${progressPct}%` } : undefined}
                                        />
                                      </div>
                                    </div>
                                  )}
                                </div>
                                {/* At half width the identity and the controls cannot
                                    share a line, so the row is two stacked bands. Left
                                    as one wrapping line, neighbouring cards broke at
                                    different points and stopped lining up.
                                    The market itself never reaches this row (filtered
                                    out above — it manages itself from its own settings
                                    card), so no self-toggle special case is needed. */}
                                <div className={css.irowActions}>
                                {/* Dot + tag, the pairing the host's own plugin
                                    inventory uses for exactly this state. */}
                                {!missing && act?.library !== true && (
                                  <span className={css.stateTag} data-on={off ? 'false' : 'true'}>
                                    <span className={css.stateDot} data-on={off ? 'false' : 'true'} />
                                    {off ? t('disabledState') : t('switchOnLabel')}
                                  </span>
                                )}
                                {toggleable && (
                                  onOffSwitch({
                                    label: (off ? t('enable') : t('disable')) + ' ' + name,
                                    on: !off,
                                    disabled: togglingName !== null || busyUrl !== null || updatingName !== null || removingName !== null,
                                    toggle: () => doToggle(name, off),
                                  })
                                )}
                                {/* State and switch pack left, the operations
                                    pack right: with everything in one flow the
                                    switch's x depended on whether the update
                                    slot rendered a button or a tag. */}
                                <span className={css.grow} />
                                {entry !== undefined && entry.deprecated === true && entry.replacement !== undefined && (() => {
                                  const replacement = data?.plugins.find(r => r.name === entry.replacement)
                                  if (replacement === undefined) return null
                                  return (
                                    <>
                                      <Button variant="outline" size="sm" onClick={() => { setCat('all'); setQ(entry.replacement!); setTab('discover') }}>{t('viewReplacement')}</Button>
                                      {!isInstalled(replacement, catalogInstalled, repoIdentities, data?.plugins, repoHints) && (
                                        <Button variant="outline" size="sm" onClick={() => setConfirming(replacement)}>{t('installReplacement')}</Button>
                                      )}
                                    </>
                                  )
                                })()}
                                {/* Horizontal ops stay in one trailing unit so a
                                    wrap moves them together (#242, installed layout). */}
                                <span className={css.irowTrailing}>
                                <span className={css.irowTrailingRow}>
                                {!missing && status?.sourceMigration !== undefined && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={updatingName !== null || removingName !== null || busyUrl !== null}
                                    onClick={() => askSourceMigration(name)}
                                  >{status.sourceMigration.kind === 'npm-rename' ? t('renameRowAction') : t('migrateNpm')}</Button>
                                )}
                                {missing
                                  ? <span className={css.metaTag}>{t('notInstalled')}</span>
                                  : updatedNames.includes(name)
                                    ? <span className={`${css.metaTag} ${css.metaTagOk}`}>{act?.library === true ? t('updatedLibrary') : act?.state === 'live' ? t('updatedLive') : t('updated')}</span>
                                    : updatingName === name
                                      ? <Button variant="outline" size="sm" className={css.irowUpdateBtn} disabled>{t('updating')}</Button>
                                      : status !== undefined && generation && status.latest != null
                                        ? <span className={css.metaTag} title={t('hostUpdateHint')}>{t('hostUpdateReady').replace('{0}', status.latest)}</span>
                                      : status?.profileBlocked !== undefined && status.updateAvailable !== true
                                        // Another release in the profile is in the way (#1252).
                                        // One short word here; the sentence is in the tooltip
                                        // and, once, in the note above the list.
                                        ? (
                                            <Tooltip label={profileBlockedText(status.profileBlocked, t)} side="top" delayMs={HOVER_TIP_DELAY_MS} portal maxWidth={280}>
                                              <span className={css.irowTrailingHint}>
                                                <IconClock size={12} />
                                                {t('profileBlockedBeside')}
                                              </span>
                                            </Tooltip>
                                          )
                                      : status && status.updateAvailable
                                        ? (() => {
                                              // Hint then button: clock+short wait stays visible,
                                              // update action stays the rightmost control.
                                              const held = status.heldUpdate !== undefined
                                                ? heldUpdateBeside(status.heldUpdate, t)
                                                : null
                                              return (
                                                <>
                                                  {held !== null && (
                                                    <Tooltip label={held.title} side="top" delayMs={HOVER_TIP_DELAY_MS} portal maxWidth={280}>
                                                      <span className={css.irowTrailingHint}>
                                                        <IconClock size={12} />
                                                        {held.label}
                                                      </span>
                                                    </Tooltip>
                                                  )}
                                                  <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className={css.irowUpdateBtn}
                                                    disabled={updatingName !== null}
                                                    onClick={() => {
                                                      if (status.restoreRequired === true) askRestore(name)
                                                      else doUpdate(name)
                                                    }}
                                                  >{status.restoreRequired === true ? t('restoreOnline')
                                                    : (() => {
                                                        // Status fact is versionless; the button is the
                                                        // one place that still names the target. Prefer
                                                        // the mature eligible cut, else latest (#layout).
                                                        const target = status.eligibleVersion ?? status.latest
                                                        return target != null && target !== ''
                                                          ? `${t('update')} ${displayLatest(target)}`
                                                          : t('update')
                                                      })()}</Button>
                                                </>
                                              )
                                            })()
                                        : status?.heldUpdate !== undefined
                                          // Held-only: no installable cut yet (#945). Same quiet
                                          // clock hint as beside the update button.
                                          ? (() => {
                                              const held = heldUpdateBeside(status.heldUpdate, t)
                                              return (
                                                <Tooltip label={held.title} side="top" delayMs={HOVER_TIP_DELAY_MS} portal maxWidth={280}>
                                                  <span className={css.irowTrailingHint}>
                                                    <IconClock size={12} />
                                                    {held.label}
                                                  </span>
                                                </Tooltip>
                                              )
                                            })()
                                        : localDev
                                          ? null
                                          : status?.unreleasedCommit != null
                                            ? <span className={css.metaTag} title={t('unreleasedCommitsHint')}>{t('unreleasedCommits').replace('{0}', displayLatest(status.unreleasedCommit))}</span>
                                            : status?.newerPrerelease !== undefined
                                              // "Up to date" is true against `latest` and false
                                              // for the reader: their pin is ahead of it, which
                                              // means they are on a line `latest` does not name
                                              // (#867). Name that line's newest build instead,
                                              // and leave the decision with them — installing it
                                              // is one click, and the market still does not
                                              // offer anyone's prerelease by itself.
                                              ? (
                                                  <>
                                                    <span className={css.metaTag} title={t('newerPrereleaseHint')}>{t('newerPrereleaseAvailable').replace('{0}', status.newerPrerelease)}</span>
                                                    <Button
                                                      variant="outline"
                                                      size="sm"
                                                      disabled={updatingName !== null || removingName !== null || busyUrl !== null}
                                                      onClick={() => doUpdate(name, false, false, status.newerPrerelease)}
                                                    >{t('install')}</Button>
                                                  </>
                                                )
                                              : updateCheck.failed === null || updateCheck.failed.has(name)
                                                ? null
                                                : <span className={css.metaTag} title={t('upToDate')}>{t('upToDate')}</span>}
                                {removingName === name && <span className={css.metaTag}>{t('uninstalling')}</span>}
                                </span>
                                </span>
                                </div>
                              </div>
                            )
                          }}
                          />
                        )}
                {dependencyOnlyNames.size > 0 && (
                  // The list is complete as a list of PLUGINS; the count keeps it
                  // from looking like packages went missing (#857).
                  <p className={css.groupOrgHint}>
                    {t('installedDependencyNote').replace('{0}', String(dependencyOnlyNames.size))}
                  </p>
                )}
                </>
              )}
      </div>
      {showTop && (
        <Tooltip label={t('backTop')} side="top">
          <span className={css.top}>
            <Button
              variant="outline"
              className={css.topBtn}
              aria-label={t('backTop')}
              onClick={scrollToTop}
            ><IconChevronUpOutline14 size={16} /></Button>
          </span>
        </Tooltip>
      )}
      {renamingGroup !== null && (
        <Modal
          open
          onClose={() => { setRenamingGroup(null); setRenamingValue('') }}
          title={t('groupRenameTitle')}
          description={t('groupRenameHint')}
          footer={(
            <>
              <Button variant="ghost" onClick={() => { setRenamingGroup(null); setRenamingValue('') }}>{t('cancel')}</Button>
              <Button
                variant="primary"
                disabled={renamingValue.trim() === '' || renamingValue.trim() === renamingGroup}
                onClick={() => doRenameGroup(renamingGroup)}
              >{t('groupRenameSave')}</Button>
            </>
          )}
        >
          <div className={css.groupRenameField}>
            <label htmlFor="dsh-market-group-rename">{t('groupNamePh')}</label>
            <Input
              id="dsh-market-group-rename"
              className={css.inlineInput}
              placeholder={t('groupNamePh')}
              value={renamingValue}
              onChange={e => setRenamingValue(e.target.value)}
              onFocus={e => e.currentTarget.select()}
              onKeyDown={e => { if (e.key === 'Enter') doRenameGroup(renamingGroup) }}
              autoFocus
            />
          </div>
        </Modal>
      )}
      {addPanel !== null && (() => {
        const members = groups[addPanel] ?? []
        const pluginCandidates = ungroupedNames.filter(name => !installedThemeNames.has(name) && !members.includes(name))
        const needle = addQuery.trim().toLowerCase()
        const candidates = needle === ''
          ? pluginCandidates
          : pluginCandidates.filter(name => name.toLowerCase().includes(needle))
        return (
          <Modal
            open
            onClose={() => setAddPanel(null)}
            title={t('groupAddTitle').replace('{0}', addPanel)}
            footer={(
              <>
                <span className={css.groupAddFooterMeta}>
                  {t('groupAddSelected').replace('{0}', String(addSelected.length))}
                </span>
                <Button variant="ghost" onClick={() => setAddPanel(null)}>{t('cancel')}</Button>
                <Button
                  variant="primary"
                  disabled={addSelected.length === 0}
                  onClick={doAddSelectedMembers}
                >{t('groupAddConfirm').replace('{0}', String(addSelected.length))}</Button>
              </>
            )}
          >
            <div className={css.groupAddModalBody}>
              <SearchInput
                value={addQuery}
                onCommit={setAddQuery}
                placeholder={t('groupAddSearchPh')}
                t={t}
              />
              {candidates.length === 0
                ? <p className={css.groupAddModalHint}>{t('groupAddEmpty')}</p>
                : (
                    <div className={css.groupAddModalList}>
                      {candidates.map(name => (
                        <label className={css.groupAddPick} key={name}>
                          <input
                            type="checkbox"
                            checked={addSelected.includes(name)}
                            onChange={() => setAddSelected(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name])}
                          />
                          <span className={css.nm}>{name}</span>
                          {effectiveDisabledSet.has(name) && <span className={css.spec}>{t('disabledState')}</span>}
                        </label>
                      ))}
                    </div>
                  )}
              <p className={css.groupAddModalHint}>{t('groupAddHint')}</p>
            </div>
          </Modal>
        )
      })()}
      {themePanel !== null && (() => {
        const members = groups[themePanel] ?? []
        const current = members.find(name => installedThemeNames.has(name)) ?? null
        const choices = [
          ...(current !== null ? [current] : []),
          ...ungroupedNames.filter(name => installedThemeNames.has(name)),
        ]
        return (
          <Modal
            open
            onClose={() => setThemePanel(null)}
            title={t('groupThemeTitle').replace('{0}', themePanel)}
            footer={(
              <>
                {current !== null && (
                  <Button variant="ghost" onClick={() => applyGroupTheme(themePanel, null)}>{t('groupThemeRemove')}</Button>
                )}
                <span className={css.groupAddFooterMeta} />
                <Button variant="ghost" onClick={() => setThemePanel(null)}>{t('cancel')}</Button>
                <Button
                  variant="primary"
                  disabled={themePick === null || themePick === current}
                  onClick={() => { if (themePick !== null) applyGroupTheme(themePanel, themePick) }}
                >{t('groupThemeUse')}</Button>
              </>
            )}
          >
            <div className={css.groupAddModalBody}>
              <p className={css.groupAddModalHint}>{t('groupThemeHint')}</p>
              {choices.length === 0
                ? <p className={css.groupAddModalHint}>{t('groupThemeEmpty')}</p>
                : (
                    <div className={css.groupAddModalList} role="radiogroup" aria-label={t('groupPickTheme')}>
                      {choices.map(name => (
                        <label className={css.groupAddPick} key={name}>
                          <input
                            type="radio"
                            name="dsh-market-group-theme"
                            checked={themePick === name}
                            onChange={() => setThemePick(name)}
                          />
                          <span className={css.nm}>{name}</span>
                          {name === current && <span className={css.spec}>{t('groupThemeCurrent')}</span>}
                        </label>
                      ))}
                    </div>
                  )}
            </div>
          </Modal>
        )
      })()}
      {confirming !== null && (
        <Modal
          open
          className={css.confirmModal}
          contentClassName={css.confirmContent}
          onClose={() => setConfirming(null)}
          title={t('confirmTitle') + ' ' + pluginName(confirming.name, confirming.npm) + '?'}
          footer={(
            <>
              <Button variant="ghost" onClick={() => setConfirming(null)}>{t('cancel')}</Button>
              <Button variant="primary" onClick={() => doInstall(confirming)}>{t('confirmInstall')}</Button>
            </>
          )}
        >
          {/* The detail dialog has to show at LEAST what the card already
              does — owner, version, downloads, stars, published date, category —
              a "detail" view that shows less than the summary it opened from
              is backwards. The download number's meaning stays on the mark
              (hover, focus, aria-label), not as a paragraph above the blurb
              (#739). */}
          <div className={css.confirmBody}>
          <div className={css.byline}>
            <OwnerAvatar name={confirming.name} owner={confirming.owner || ''} icon={confirming.icon ?? undefined} />
            <span className={css.owner} title={confirming.owner}>{confirming.owner}</span>
            <CatalogVersionMark version={confirming.version} tip={catalogVersionTip} />
            <DownloadCount plugin={confirming} t={t} />
            <StarCount plugin={confirming} t={t} />
            {confirming.added && (
              <span className={css.star} title={t('published')}>{`· ${confirming.added}`}</span>
            )}
          </div>
          {pluginCategories(confirming).length > 0 && (
            <div className={css.confirmTags}>
              {pluginCategories(confirming).map(category => (
                <span key={category} className={css.tag}>
                  {(data!.categories[category] && (data!.categories[category]![lang] || data!.categories[category]!.en)) || category}
                </span>
              ))}
            </div>
          )}
          {/* The Modal primitive's own `description` prop is sized for a
              one-line subtitle under the title — a full plugin description
              rendered there read as an oversized heading, not body text
              (reported on a real host). The card's .desc is tertiary and
              clamped so a grid stays even; here the blurb is what the dialog
              is for, so it takes body color and body size (#739). */}
          {(() => {
            const text = (confirming.description && (confirming.description[lang] || confirming.description.en)) || ''
            return text === '' ? null : <p className={css.confirmDesc}>{text}</p>
          })()}
          <ScreenshotStrip plugin={confirming} onOpen={openLightbox} />
          {/* A rule between "what it is" and the disclosures. Without it the
              fold rows sat in the same block as the blurb (#739). */}
          <div className={css.confirmFold}>
          {capabilityDetail(confirming)}
          <ConfirmFold
            icon={<ConfirmTerminalIcon />}
            title={t('cmdDetails')}
            open={cmdOpen}
            onToggle={() => setCmdOpen(o => !o)}
          >
            {(() => {
              // #872: the catalog's command names the `web` profile, which is
              // a different profile from the one this page is running in —
              // and on a desktop profile the CLI refuses that name outright.
              const shown = installCommandFor(confirming.install, profileName)
              if (shown.unusable) return <div className={css.confirmCmd}><div className={css.cmd}>{t('cmdDesktopUnavailable')}</div></div>
              if (shown.command === null) return null
              return (
                <div className={css.confirmCmd}>
                  <div className={css.cmd}>{shown.command}</div>
                  <ConfirmCopyButton text={shown.command} label={t('cmdCopy')} copiedLabel={t('cmdCopied')} />
                </div>
              )
            })()}
          </ConfirmFold>
          </div>
          {(looksTerminal(confirming, lang) || confirming.deprecated === true) && (
            <div className={css.installCaution}>
              <p className={css.installCautionLabel}>{t('installCaution')}</p>
              {looksTerminal(confirming, lang) && (
                <>
                  <p className={css.installCautionHead}>
                    <ConfirmWarnIcon />
                    {t('terminalCautionTitle')}
                  </p>
                  <p className={css.installCautionBody}>{t('terminalCautionBody')}</p>
                  <p className={css.installCautionFoot}>
                    <span>{t('terminalCautionStartup')}</span>
                    <a className={css.installCautionLink} href={confirming.url + '#readme'} target="_blank" rel="noreferrer">{t('terminalCautionLink')}</a>
                  </p>
                </>
              )}
              {confirming.deprecated === true && (() => {
                const replacement = replacementOf(confirming)
                return (
                  <p className={css.installCautionBody}>
                    {t('deprecatedWarn')}
                    {replacement !== undefined && (
                      <>
                        {' '}
                        <a className={css.src} href={replacement.url} target="_blank" rel="noreferrer">
                          {t('replacementHint') + ' ' + replacement.name}
                        </a>
                      </>
                    )}
                  </p>
                )
              })()}
            </div>
          )}
          <p className={css.confirmFineprint}>{t('confirmWarn')}</p>
          </div>
        </Modal>
      )}
      {recovery !== null && (
        <RecoveryPanel
          open={recoveryOpen}
          view={recovery}
          keep={recoveryKeep}
          busy={recoveryBusy}
          onToggle={(name, on) => setRecoveryKeep(current => ({ ...current, [name]: on }))}
          onApply={applyRecoveryChoice}
          onClose={() => setRecoveryOpen(false)}
          t={t}
        />
      )}
      {commentsFor !== null && (
        <CommentsModal
          key={commentsFor.url}
          name={pluginName(commentsFor.name, commentsFor.npm)}
          url={commentsFor.url}
          lang={uiLocale}
          onClose={() => setCommentsFor(null)}
          t={t}
        />
      )}
      {lightbox !== null && (
        <ScreenshotLightbox
          shots={lightbox.shots}
          startIndex={lightbox.index}
          onClose={() => setLightbox(null)}
          t={t}
        />
      )}
      {migrationConfirm !== null && (() => {
        const copy = sourceMigrationCopy(migrationConfirm, t)
        return (
          <Modal
            open
            onClose={() => setMigrationConfirm(null)}
            title={copy.title}
            description={copy.description}
            footer={(
              <>
                <Button
                  variant="ghost"
                  onClick={() => setMigrationConfirm(null)}
                >
                  {t('cancel')}
                </Button>
                <Button
                  variant="primary"
                  disabled={updatingName !== null}
                  onClick={() => doSourceMigration(
                    migrationConfirm.name,
                    false,
                    migrationConfirm.kind === 'npm-rename' ? migrationConfirm.target : undefined,
                  )}
                >
                  {copy.confirmLabel}
                </Button>
              </>
            )}
          >
            <div className={css.migrationSources}>
              <div className={css.migrationSource}>
                <span className={css.migrationLabel}>{copy.currentLabel}</span>
                <code>
                  {migrationConfirm.name}: {migrationConfirm.source}
                </code>
              </div>
              <div className={css.migrationArrow}>↓</div>
              <div className={css.migrationSource}>
                <span className={css.migrationLabel}>{copy.targetLabel}</span>
                <code>{migrationConfirm.target}</code>
              </div>
            </div>
            {copy.noteTone === 'warning' ? (
              <p className={css.migrationWarning}>
                <IconWarningOutline16 size={14} />
                {copy.note}
              </p>
            ) : (
              <p className={css.migrationNote}>{copy.note}</p>
            )}
          </Modal>
        )
      })()}
      {agentsConfirm !== null && (
        <Modal
          open
          onClose={() => setAgentsConfirm(null)}
          title={t('agentsRunningConfirm') + ' ' + agentsConfirm.name}
          description={t('agentsRunningRisk')}
          footer={(
            <>
              <Button variant="ghost" onClick={() => setAgentsConfirm(null)}>{t('cancel')}</Button>
              <Button variant="primary" disabled={busyUrl !== null || updatingName !== null || removingName !== null} onClick={() => {
                setAgentsConfirm(null)
                agentsConfirm.run()
              }}>{t(agentsConfirm.kind === 'uninstall' ? 'opUninstallNow' : 'opUpdateNow')}</Button>
            </>
          )}
        />
      )}
      {removeConfirm !== null && (
        <Modal
          open
          onClose={() => setRemoveConfirm(null)}
          title={t('uninstall') + ' ' + removeConfirm + '?'}
          description={t(activations[removeConfirm]?.library === true ? 'uninstallLibraryConfirmDesc' : 'uninstallConfirmDesc')}
          footer={(
            <>
              <Button variant="ghost" onClick={() => setRemoveConfirm(null)}>{t('cancel')}</Button>
              <Button variant="primary" disabled={removingName !== null} onClick={() => doUninstall(removeConfirm)}>{t('uninstall')}</Button>
            </>
          )}
        />
      )}
      {restoreConfirm !== null && (
        <Modal
          open
          onClose={() => setRestoreConfirm(null)}
          title={`${t('restoreOnline')} ${restoreConfirm.name}?`}
          // An unverified match is named for what it is (#485). The local
          // copy declares no repository, so the only thing that agrees with
          // the catalog entry below is the package name — and the owner on
          // that line may be a stranger, not the author of this checkout.
          description={`${restoreConfirm.verified ? t('restoreHint') : t('restoreNameOnlyHint')}\n\n${restoreConfirm.entry.owner} · ${restoreConfirm.entry.url}`}
          footer={(
            <>
              <Button variant="ghost" onClick={() => setRestoreConfirm(null)}>{t('cancel')}</Button>
              <Button variant="primary" disabled={updatingName !== null} onClick={() => doUpdate(restoreConfirm.name, false, true)}>{t('restoreProceed')}</Button>
            </>
          )}
        />
      )}
      {hostIncompatible !== null && (
        <Modal
          open
          onClose={() => setHostIncompatible(null)}
          title={t('hostIncompatibleTitle')}
          description={[
            t(hostIncompatible.kind === 'install' ? 'hostIncompatibleBodyInstall' : 'hostIncompatibleBody')
              .replace('{plugin}', `${hostIncompatible.name} ${hostIncompatible.version}`.trim())
              .replace('{requirement}', hostIncompatible.requirement ?? t('hostIncompatibleUnknown'))
              .replace('{host}', hostIncompatible.hostVersion ?? t('hostIncompatibleUnknown')),
            // The way out, said in the same breath as the refusal: what the
            // user can install instead of a version this host cannot run.
            hostIncompatible.npmName === null
              ? null
              : findingCompat.status === 'loading'
                ? t('hostIncompatibleSearching')
                : findingCompat.status === 'found'
                  // A compatible release that is still inside the release-age
                  // wait is not an available answer. Say so here, with the
                  // wait attached, instead of letting the button fail later.
                  ? hostCompatHeld
                    ? (hostCompatHeldHours === null
                        ? t('hostIncompatibleHeldTargetUnknown').replace('{version}', findingCompat.version)
                        : t('hostIncompatibleHeldTarget')
                            .replace('{version}', findingCompat.version)
                            .replace('{window}', String(hostCompatWindowHours))
                            .replace('{hours}', String(hostCompatHeldHours)))
                    : t(hostIncompatible.kind === 'install' ? 'hostIncompatibleFoundInstall' : 'hostIncompatibleFoundUpdate')
                        .replace('{version}', findingCompat.version)
                  : findingCompat.status === 'not-found'
                    ? t('hostIncompatibleNoCompat')
                    : findingCompat.status === 'error'
                      ? t('hostIncompatibleSearchFailed')
                      : null,
          ].filter((line): line is string => line !== null).join('\n')}
          footer={(
            <>
              {/* Staying put is the recommended action, so it is the primary
                  one — the opposite of the usual dialog, because here the
                  safe choice is to do nothing. */}
              {/* A release this host can actually run is the best outcome
                  available, so it takes the primary seat — and `stay put`
                  moves to outline rather than disappearing. The "anyway"
                  button keeps the ghost seat: it is the only option here
                  that asks the user to accept a broken host, and it must not
                  look like the recommended one. */}
              <Button
                variant={findingCompat.status === 'found' && !hostCompatHeld ? 'outline' : 'primary'}
                onClick={() => setHostIncompatible(null)}
              >{t(hostIncompatible.kind === 'install' ? 'hostIncompatibleCancel' : 'hostIncompatibleKeep')}</Button>
              {findingCompat.status === 'found' && (
                <Button
                  variant="primary"
                  disabled={hostCompatHeld || (hostIncompatible.kind === 'install' ? busyUrl !== null : updatingName !== null)}
                  onClick={() => {
                    const kind = hostIncompatible.kind
                    const target = hostIncompatible.name
                    const plugin = hostIncompatible.plugin
                    const version = findingCompat.version
                    setHostIncompatible(null)
                    if (kind === 'install') {
                      if (plugin !== null) doInstall(plugin, false, version)
                    } else {
                      doUpdate(target, false, false, version)
                    }
                  }}
                >{hostCompatHeld
                  ? (hostCompatHeldHours === null
                      ? t('hostIncompatibleHeldButtonUnknown')
                      : t('hostIncompatibleHeldButton').replace('{hours}', String(hostCompatHeldHours)))
                  : t(hostIncompatible.kind === 'install' ? 'hostIncompatibleInstallCompat' : 'hostIncompatibleUpdateCompat')
                      .replace('{version}', findingCompat.version)}</Button>
              )}
              {findingCompat.status === 'error' && hostIncompatible.npmName !== null && (
                <Button variant="outline" onClick={() => setCompatRetry(n => n + 1)}>{t('hostIncompatibleRetry')}</Button>
              )}
              <Button
                variant="ghost"
                disabled={hostIncompatible.kind === 'install' ? busyUrl !== null : updatingName !== null}
                onClick={() => {
                  const kind = hostIncompatible.kind
                  const target = hostIncompatible.name
                  const forcePlugin = hostIncompatible.plugin
                  setHostIncompatible(null)
                  if (kind === 'install' && forcePlugin !== null) doInstall(forcePlugin, true)
                  else doUpdate(target, true)
                }}
              >{t(hostIncompatible.kind === 'install' ? 'hostIncompatibleInstallAnyway' : 'hostIncompatibleAnyway')}</Button>
            </>
          )}
        />
      )}
      {restoreBlocked !== null && (
        <Modal
          open
          onClose={() => setRestoreBlocked(null)}
          title={`${t('restoreNoCatalogTitle')} — ${restoreBlocked.name}`}
          description={t(restoreBlocked.reason === 'repo-mismatch' ? 'restoreNoMatch' : 'restoreNoCatalog')}
          footer={(
            <Button variant="ghost" onClick={() => setRestoreBlocked(null)}>{t('gotIt')}</Button>
          )}
        />
      )}
      {notesFor !== null && (
        <Modal
          open
          onClose={closeNotes}
          className={notesState === 'ready' && (updateNotes?.kind === 'release' || (updateNotes?.history?.items.length ?? 0) > 0)
            ? css.notesModalWide : undefined}
          /* The host's Modal renders its title node verbatim; the hand-written
             primitives.d.ts narrows the prop to string, so this cast documents
             intent rather than defeating a runtime check. */
          title={(notesFor.repoUrl !== null
            ? <a className={css.nameLink} href={notesFor.repoUrl + '#readme'} target="_blank" rel="noreferrer">{notesFor.name}</a>
            : notesFor.name) as unknown as string}
          footer={(
            <Button variant="ghost" onClick={closeNotes}>{t('gotIt')}</Button>
          )}
        >
          {/* The version line reads as versions when both ends are semver and
              as short shas when the plugin updates from git — a 40-char sha
              pair wraps the dialog into nonsense. */}
          {(notesFor.current !== null || notesFor.latest !== null) && (
            <div className={css.notesRange}>
              <span className={css.spec}>{notesFor.current !== null && notesFor.current.length === 40
                ? notesFor.current.slice(0, 7)
                : notesFor.current}</span>
              <span className={css.notesArrow}>→</span>
              <span className={css.spec}>{(() => {
                const end = notesFor.target ?? notesFor.latest
                return end !== null && end.length === 40 ? end.slice(0, 7) : end
              })()}</span>
            </div>
          )}
          {notesState === 'loading' && <div className={css.spec}>{t('loading')}</div>}
          {notesState === 'fail' && <div className={css.spec}>{t('notesLoadFail')}</div>}
          {notesState === 'ready' && updateNotes !== null && (
            <UpdateNotesContent notes={updateNotes} name={notesFor.name} target={notesFor.target ?? notesFor.latest}
              repoUrl={notesFor.repoUrl} t={t} lang={lang} />
          )}
        </Modal>
      )}
      {restoreConfirmOpen && pendingBackup !== null && (
        <Modal
          open
          onClose={() => setRestoreConfirmOpen(false)}
          title={t('restoreConfirm')}
          footer={(
            <>
              <Button variant="ghost" onClick={() => setRestoreConfirmOpen(false)}>{t('cancel')}</Button>
              <Button variant="primary" disabled={backupBusy} onClick={doRestore}>{t('confirm')}</Button>
            </>
          )}
        />
      )}
      {exportOpen && (
        <Modal
          open
          onClose={() => setExportOpen(false)}
          title={t('gistExportSelect')}
          description={t('gistExportHint')}
          footer={(
            <>
              <Button variant="ghost" onClick={() => setExportOpen(false)}>{t('cancel')}</Button>
              <Button variant="primary" disabled={gistBusy || exportSelection.size === 0} onClick={() => runGist('export')}>
                {gistBusy ? t('backupWorking') : t('gistExportGo')}
              </Button>
            </>
          )}
        >
          {exportOptions.length === 0 && <p>{t('gistNoPlugins')}</p>}
          {exportOptions.length > 0 && (
            <>
              <div className={css.backupActions}>
                <Button size="sm" variant="outline" onClick={() => setExportSelection(new Set(exportOptions))}>{t('gistSelectAll')}</Button>
                <Button size="sm" variant="outline" onClick={() => setExportSelection(new Set())}>{t('gistSelectNone')}</Button>
              </div>
              <div className={css.backupCheckList}>
                {exportOptions.map(name => (
                  <label key={name} className={css.backupCheck}>
                    <input
                      type="checkbox"
                      checked={exportSelection.has(name)}
                      onChange={e => {
                        const next = new Set(exportSelection)
                        if (e.currentTarget.checked) next.add(name)
                        else next.delete(name)
                        setExportSelection(next)
                      }}
                    />
                    <span className={css.grow}>{name}</span>
                    {specKind(installed[name]) === 'git' && <span className={`${css.specTag} ${css.specTagGit}`}>git</span>}
                    {specKind(installed[name]) === 'file' && <span className={`${css.specTag} ${css.specTagFile}`}>{t('gistSpecLocal')}</span>}
                    <span className={css.spec} title={installed[name]}>{installed[name] ?? t('bundleTag')}</span>
                  </label>
                ))}
              </div>
              {labelledCheckbox({
                label: t('gistIncludeConfig'),
                checked: exportIncludeConfig,
                className: css.backupCheck,
                onChange: setExportIncludeConfig,
              })}
              {(exportAllSelected || exportIncludeConfig) && <p className={css.backupWarn}>{t('gistConfigWarning')}</p>}
              {exportError !== null && <p className={css.backupWarn}>{exportError}</p>}
            </>
          )}
        </Modal>
      )}
      {/* Log-export feedback via the Toast primitive — body portal, so it
        never squeezes the subtitle row or the error banner. */}
      {exportState === 'done' && (
        <Toast text={t('exportedLog')} icon={<IconCheckOutline16 size={14} />} onDone={exportToastDone} />
      )}
      {exportState === 'fail' && (
        <Toast text={t('exportLogFail')} icon={<IconWarningOutline16 size={14} />} onDone={exportToastDone} />
      )}
      {favoriteError !== null && (
        <Toast text={localizeBilingual(favoriteError, lang)} icon={<IconWarningOutline16 size={14} />} onDone={favoriteErrorDone} />
      )}
      {blockError !== null && (
        <Toast text={localizeBilingual(blockError, lang)} icon={<IconWarningOutline16 size={14} />} onDone={blockErrorDone} />
      )}
      {blockNotice !== null && (
        <Toast text={blockNotice} onDone={blockNoticeDone} />
      )}
      {updateExemptError !== null && (
        <Toast text={localizeBilingual(updateExemptError, lang)} icon={<IconWarningOutline16 size={14} />} onDone={updateExemptErrorDone} />
      )}
      {updateExemptNotice !== null && (
        <Toast text={updateExemptNotice} onDone={updateExemptNoticeDone} />
      )}
      {toggled !== null && (
        <Toast
          text={toggled.name + ' ' + t(toggled.enabled ? 'toastToggledOn' : 'toastToggledOff')}
          icon={toggled.enabled ? <IconCheckOutline16 size={14} /> : <IconWarningOutline16 size={14} />}
          onDone={toggledDone}
        />
      )}
    </div>
  )
}
