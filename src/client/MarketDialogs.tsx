/**
 * The modals, panels and toasts the Market section opens on top of its tabs.
 */

import { Button, Input, Modal, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Market.module.css'
import { IconCheckOutline16, IconChevronUpOutline14, IconWarningOutline16 } from './icons.ts'
import { SearchInput } from './SearchInput.tsx'
import { installCommandFor, isInstalled, localizeBilingual, looksTerminal, pluginCategories, pluginName } from './market-data.ts'
import { RecoveryPanel } from './RecoveryPanel.tsx'
import { PinnedNote, SourceTag } from './SourceParts.tsx'
import { CommentsModal } from './CommentsModal.tsx'
import { OwnerAvatar, ScreenshotStrip } from './MarketImages.tsx'
import {
  CatalogVersionMark,
  ConfirmCopyButton,
  ConfirmFold,
  ConfirmTerminalIcon,
  ConfirmWarnIcon,
  DownloadCount,
  StarCount,
} from './MarketCardParts.tsx'
import { ScreenshotLightbox } from './MarketLayout.tsx'
import { sourceMigrationCopy } from './market-helpers.ts'
import { UpdateNotesContent } from './MarketNotes.tsx'
import type { MarketStateCtx } from './market-state.tsx'
import type { MarketSyncCtx } from './market-sync.ts'
import type { MarketGroupsBackupCtx } from './market-groups-backup.ts'
import type { MarketRenderCtx } from './market-render.tsx'
import type { MarketInstallCtx } from './market-install.ts'
import type { MarketOperationsCtx } from './market-operations.ts'
import type { MarketSectionProps } from './market-types.ts'

type MarketDialogsCtx = { props: MarketSectionProps }
  & Pick<MarketStateCtx,
    'activations' | 'addPanel' | 'addQuery' | 'addSelected' | 'agentsConfirm' | 'backupBusy' |
    'blockError' | 'blockErrorDone' | 'blockNotice' | 'blockNoticeDone' | 'busyUrl' |
    'catalogVersionTip' | 'cmdOpen' | 'commentsFor' | 'confirming' | 'data' | 'exportError' | 'repoHints' | 'repoIdentities' |
    'exportIncludeConfig' | 'exportOpen' | 'exportSelection' | 'exportState' | 'exportToastDone' |
    'favoriteError' | 'favoriteErrorDone' | 'findingCompat' | 'gistBusy' | 'groups' |
    'hostCompatHeld' | 'hostCompatHeldHours' | 'hostCompatWindowHours' | 'hostIncompatible' |
    'installed' | 'lang' | 'lightbox' | 'migrationConfirm' | 'notesFor' | 'notesState' |
    'openLightbox' | 'openPluginUnavailable' | 'openPluginUnavailableDone' | 'pendingBackup' | 'profileName' | 'recovery' | 'recoveryBusy' | 'recoveryKeep' |
    'recoveryOpen' | 'removeConfirm' | 'removingName' | 'renamingGroup' | 'renamingValue' |
    'restoreBlocked' | 'restoreConfirm' | 'restoreConfirmOpen' | 'setAddPanel' | 'setAddQuery' |
    'setAddSelected' | 'setAgentsConfirm' | 'setCmdOpen' | 'setCommentsFor' | 'setCompatRetry' |
    'setConfirming' | 'setExportIncludeConfig' | 'setExportOpen' | 'setExportSelection' |
    'setHostIncompatible' | 'setLightbox' | 'setMigrationConfirm' | 'setRecoveryKeep' |
    'setRecoveryOpen' | 'setRemoveConfirm' | 'setRenamingGroup' | 'setRenamingValue' |
    'setRestoreBlocked' | 'setRestoreConfirm' | 'setRestoreConfirmOpen' | 'setThemePanel' |
    'setThemePick' | 'showTop' | 't' | 'themePanel' | 'themePick' | 'toggled' | 'toggledDone' |
    'uiLocale' | 'updateExemptError' | 'updateExemptErrorDone' | 'updateExemptNotice' |
    'updateExemptNoticeDone' | 'updateNotes' | 'updatingName'>
  & Pick<MarketSyncCtx, 'catalogInstalled' | 'effectiveDisabledSet' | 'scrollToTop'>
  & Pick<MarketInstallCtx, 'doInstall'>
  & Pick<MarketOperationsCtx,
    'applyRecoveryChoice' | 'closeNotes' | 'doSourceMigration' | 'doUninstall' | 'doUpdate'>
  & Pick<MarketGroupsBackupCtx,
    'doAddSelectedMembers' | 'doRenameGroup' | 'doRestore' | 'exportAllSelected' | 'exportOptions' |
    'runGist' | 'specKind'>
  & Pick<MarketRenderCtx,
    'applyGroupTheme' | 'capabilityDetail' | 'installedThemeNames' | 'labelledCheckbox' |
    'replacementOf' | 'ungroupedNames'>

export function MarketDialogs({ c }: { c: MarketDialogsCtx }) {
  const {
    activations, addPanel, addQuery, addSelected, agentsConfirm, applyGroupTheme,
    applyRecoveryChoice, backupBusy, blockError, blockErrorDone, blockNotice, blockNoticeDone,
    busyUrl, capabilityDetail, catalogInstalled, catalogVersionTip, closeNotes, cmdOpen, commentsFor, confirming, data,
    repoHints, repoIdentities,
    doAddSelectedMembers, doInstall, doRenameGroup, doRestore, doSourceMigration, doUninstall,
    doUpdate, effectiveDisabledSet, exportAllSelected, exportError, exportIncludeConfig, exportOpen,
    exportOptions, exportSelection, exportState, exportToastDone, favoriteError, favoriteErrorDone,
    findingCompat, gistBusy, groups, hostCompatHeld, hostCompatHeldHours, hostCompatWindowHours,
    hostIncompatible, installed, installedThemeNames, labelledCheckbox, lang, lightbox,
    migrationConfirm, notesFor, notesState, openLightbox, openPluginUnavailable, openPluginUnavailableDone, pendingBackup, profileName, recovery,
    recoveryBusy, recoveryKeep, recoveryOpen, removeConfirm, removingName, renamingGroup,
    renamingValue, replacementOf, restoreBlocked, restoreConfirm, restoreConfirmOpen, runGist,
    scrollToTop, setAddPanel, setAddQuery, setAddSelected, setAgentsConfirm, setCmdOpen,
    setCommentsFor, setCompatRetry, setConfirming, setExportIncludeConfig, setExportOpen,
    setExportSelection, setHostIncompatible, setLightbox, setMigrationConfirm, setRecoveryKeep,
    setRecoveryOpen, setRemoveConfirm, setRenamingGroup, setRenamingValue, setRestoreBlocked,
    setRestoreConfirm, setRestoreConfirmOpen, setThemePanel, setThemePick, showTop, specKind, t,
    themePanel, themePick, toggled, toggledDone, uiLocale, ungroupedNames, updateExemptError,
    updateExemptErrorDone, updateExemptNotice, updateExemptNoticeDone, updateNotes, updatingName,
  } = c
  // The card title opens this same dialog as a detail view. For a plugin that
  // is already installed it is only that: no "Install X?", no install button.
  const confirmingInstalled = confirming !== null
    && isInstalled(confirming, catalogInstalled, repoIdentities, data?.plugins, repoHints)
  return (
    <>
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
          title={confirmingInstalled ? pluginName(confirming.name, confirming.npm) : t('confirmTitle') + ' ' + pluginName(confirming.name, confirming.npm) + '?'}
          footer={(
            <>
              {confirmingInstalled
                ? <Button variant="ghost" onClick={() => setConfirming(null)}>{t('detailClose')}</Button>
                : (
                    <>
                      <Button variant="ghost" onClick={() => setConfirming(null)}>{t('cancel')}</Button>
                      <Button variant="primary" onClick={() => doInstall(confirming)}>{t('confirmInstall')}</Button>
                    </>
                  )}
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
            <OwnerAvatar name={confirming.name} owner={confirming.owner || ''} icon={confirming.icon ?? undefined} trusted={confirming.source !== undefined} />
            <span className={css.owner} title={confirming.owner}>{confirming.owner}</span>
            <CatalogVersionMark version={confirming.version} tip={catalogVersionTip} />
            <DownloadCount plugin={confirming} t={t} />
            <StarCount plugin={confirming} t={t} />
            {confirming.added && (
              <span className={css.star} title={t('published')}>{`· ${confirming.added}`}</span>
            )}
          </div>
          {(pluginCategories(confirming).length > 0 || confirming.source !== undefined || confirming.pinned !== undefined) && (
            <div className={css.confirmTags}>
              <SourceTag plugin={confirming} lang={lang} />
              <PinnedNote plugin={confirming} t={t} />
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
      {openPluginUnavailable && (
        <Toast text={t('fpOpenUnavailable')} icon={<IconWarningOutline16 size={14} />} onDone={openPluginUnavailableDone} />
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
    </>
  )
}
