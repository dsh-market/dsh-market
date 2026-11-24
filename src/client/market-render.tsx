/**
 * Market render helpers: derived display values and the card/row render closures the tabs share.
 */

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo } from 'react'
import { Button, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  blockAliases,
  catalogEntryForInstalled,
  compareInstalledRows,
  hostCompatibilityKey,
  isInstalled,
  linksToGithub,
  matchInstalledName,
  pluginCategories,
  pluginName,
  type RegistryPlugin,
  themePlugins as themePluginsOf,
} from './market-data.ts'
import css from './Market.module.css'
import { HostCheckbox, HostSwitch, HostTag } from './optional-primitives.ts'
import { IconLoadingOutline16, IconWarningOutline16 } from './icons.ts'
import { recordForUrl } from './operations.ts'
import { isLocalDev, isPluginUpdatable } from './market-helpers.ts'
import { hostRequirementChip, phaseLabel } from './MarketStatusParts.tsx'
import {
  aheadFacts,
  AheadMark,
  CardStats,
  CardTip,
  ConfirmCapabilityIcon,
  ConfirmFold,
  FavoriteButton,
  groupCapabilities,
  HOVER_TIP_DELAY_MS,
  redLineIsUrgent,
  redLineNamesAddress,
  UNCOMMON_CAPABILITIES,
} from './MarketCardParts.tsx'
import { CardShot, OwnerAvatar, ThemeCover } from './MarketImages.tsx'
import { PinnedNote, SourceTag } from './SourceParts.tsx'
import { orgPolicy } from './org-policy.ts'
import { GithubRepoMark } from './MarketLogo.tsx'
import { CardDesc } from './MarketLayout.tsx'
import type { MarketStateCtx } from './market-state.tsx'
import type { MarketGroupsBackupCtx } from './market-groups-backup.ts'
import type { MarketSyncCtx } from './market-sync.ts'
import type { MarketOperationsCtx } from './market-operations.ts'
import type { MarketInstallCtx } from './market-install.ts'
import type { MarketSectionProps } from './market-types.ts'

type MarketRenderIn = { props: MarketSectionProps }
  & Pick<MarketStateCtx,
    'activations' | 'backupRestored' | 'bodyRef' | 'bootId' | 'busyUrl' | 'cancelling' | 'capsOpen' |
    'catalogPreview' | 'catalogVersionTip' | 'catsOpen' | 'catsSentinel' | 'catsStuck' | 'catsWrapRef' |
    'clearingStale' | 'data' | 'doneUrls' | 'envReady' |
    'groupOrder' | 'groups' | 'hostCompatibility' | 'hotNames' | 'hotUrls' | 'installTimes' |
    'installed' | 'installedFiles' | 'installedMenuName' | 'installedSort' | 'installedView' |
    'lang' | 'localDescriptions' | 'notes' | 'openInHost' | 'openLightbox' | 'openOperations' |
    'pendingBackup' | 'pendingDependencies' | 'pluginMenuUrl' | 'progressCurrent' | 'progressDone' |
    'progressLine' | 'progressPct' | 'progressPhase' | 'qInstalled' | 'records' | 'refreshNames' |
    'removedCount' | 'removingName' | 'repoHints' | 'repoIdentities' | 'restartNames' |
    'restartNoticeDismissed' | 'setAddPanel' | 'setCapsOpen' | 'setCatsStuck' | 'setCommentsFor' |
    'setConfirming' | 'setDeletingGroup' | 'setGroupMenuFor' | 'setInstallError' |
    'setInstalledMenuName' | 'setPluginMenuUrl' | 'setRemoveConfirm' | 'setRenamingGroup' |
    'setStuckExpanded' | 'setTab' | 'setThemePanel' | 'setThemePick' | 'setVisibleCats' | 'skins' |
    'stuckExpanded' | 'surface' | 't' | 'tab' | 'themeSnap' | 'toggleRestart' | 'togglingName' |
    'updateCheck' | 'updatedNames' | 'updates' | 'updatingAll' | 'updatingName' | 'visibleCats'>
  & Pick<MarketSyncCtx,
    'blockedNameSet' | 'catalogInstalled' | 'effectiveDisabledSet' | 'favoriteUrlSet' |
    'updateExemptSet'>
  & Pick<MarketInstallCtx, 'blockToggleName' | 'favoriteStale'>
  & Pick<MarketOperationsCtx,
    'askRestore' | 'clearStaleFavorites' | 'doCancel' | 'doUpdate' | 'doUseSkin' | 'toggleBlock' |
    'toggleFavorite' | 'toggleUpdateExempt'>
  & Pick<MarketGroupsBackupCtx,
    'dependencyOnlyNames' | 'doGroupAction' | 'doToggle' | 'doUpdateAll' | 'ignoreUpdateNotices' |
    'ignoredUpdateSet' | 'quietUpdateSet' | 'reminderBatchUpdatableNames' | 'reminderUpdatableNames' |
    'selfName'>

/** derived display values and the card/row render helpers. */
export function useMarketRender(c: MarketRenderIn) {
  const {
    activations, askRestore, backupRestored, blockToggleName, blockedNameSet, bodyRef, bootId,
    busyUrl, cancelling, capsOpen, catalogInstalled, catalogPreview, catalogVersionTip, catsOpen, catsSentinel,
    catsStuck, catsWrapRef, clearStaleFavorites, clearingStale, data, dependencyOnlyNames, doCancel,
    doGroupAction, doToggle, doUpdate, doUpdateAll, doUseSkin, doneUrls,
    effectiveDisabledSet, envReady, favoriteStale, favoriteUrlSet, groupOrder, groups,
    hostCompatibility, hotNames, hotUrls, ignoreUpdateNotices, ignoredUpdateSet, installTimes,
    installed, installedFiles, installedMenuName, installedSort, installedView, lang,
    localDescriptions, notes, openInHost, openLightbox, openOperations, pendingBackup,
    pendingDependencies, pluginMenuUrl, progressCurrent, progressDone, progressLine, progressPct,
    progressPhase, props, qInstalled, quietUpdateSet, records, refreshNames,
    reminderBatchUpdatableNames, reminderUpdatableNames, removedCount,
    removingName, repoHints, repoIdentities, restartNames, restartNoticeDismissed, selfName,
    setAddPanel, setCapsOpen, setCatsStuck, setCommentsFor, setConfirming, setDeletingGroup,
    setGroupMenuFor, setInstallError, setInstalledMenuName, setPluginMenuUrl, setRemoveConfirm,
    setRenamingGroup, setStuckExpanded, setTab, setThemePanel, setThemePick, setVisibleCats, skins,
    stuckExpanded, surface, t, tab, themeSnap, toggleBlock, toggleFavorite, toggleRestart,
    toggleUpdateExempt, togglingName, updateCheck, updateExemptSet, updatedNames, updates,
    updatingAll, updatingName, visibleCats,
  } = c
  const discoverCatalog = data ?? catalogPreview
  const categoryNames = discoverCatalog?.categories
// #558: count restart-pending session changes (restartNames), not every
  // completed `updatedNames` entry (which would double-count a batch update
  // that reports both a done URL and a name for the same plugin).
  const sessionPendingRestart = doneUrls.length + restartNames.length + removedCount + toggleRestart + (backupRestored ? 1 : 0)
  /**
   * Plugins the HOST reports as restart-pending, independent of what this
   * browser session happens to remember. Installing and then reloading the
   * page used to leave no restart affordance at all: the banner is built
   * from session state, while the Installed tab only says "activates on
   * restart" in passing — so the user was told a restart was needed and
   * given nothing to press. Dismissible, because a standing banner nobody
   * wants to act on right now is just noise (it returns next session, or
   * as soon as another change lands).
   */
  const hostPendingNames = Object.keys(activations).filter(name => activations[name]?.state === 'restart')
  const showHostPending = hostPendingNames.length > 0 && !restartNoticeDismissed && sessionPendingRestart === 0
  const pendingRestart = sessionPendingRestart > 0 ? sessionPendingRestart : (showHostPending ? hostPendingNames.length : 0)
  const displayedInstalled = pendingBackup === null ? installed : { ...pendingDependencies, ...installed }
  /**
   * Installed entries ordered for the list view: enabled plugins first
   * (#745), then rows with a pending update, then manifest order — a stable
   * sort, so each of those groups keeps its own order.
   *
   * The order settles once and then holds, so rows never reshuffle under a
   * pointer that is already aiming at one (#631). Two moments are allowed to
   * move it. One is when the update check lands: `/installed` is a local read
   * and `/updates` is a network probe over every package, so the list is
   * always rendered BEFORE the answer exists — freezing on the view alone
   * would leave it in manifest order forever. `updatesLoaded` is therefore
   * the one part of `updates` allowed in, as a boolean: it flips once when
   * the result arrives, and every later change (a newer check, a row the user
   * just updated) leaves the boolean and the order alone. The other is the
   * disable set changing: when the snapshot first arrives, or when a switch
   * the user flipped settles — and in the switch case the toggled row is the
   * only one that crosses the enabled/disabled line, so every other row
   * stays where it was.
   */
  const isInstalledListActive = tab === 'installed' && installedView === 'list'
  const updatesLoaded = Object.keys(updates).length > 0
  const orderedInstalledEntries = useMemo(() => {
    return Object.entries(displayedInstalled)
      .filter(([name]) => name !== selfName)
      .filter(([name]) => !dependencyOnlyNames.has(name))
      .sort(([nameA, specA], [nameB, specB]) => {
        // The list reads as "what is running", so a plugin that is off sinks
        // below every one that is on (#745) — even a disabled row with a
        // pending update, which only sorts inside the group it lands in.
        const aOn = effectiveDisabledSet.has(nameA) ? 0 : 1
        const bOn = effectiveDisabledSet.has(nameB) ? 0 : 1
        if (aOn !== bOn) return bOn - aOn
        const aUp = isPluginUpdatable(nameA, String(specA), updates[nameA], updatedNames, quietUpdateSet) ? 1 : 0
        const bUp = isPluginUpdatable(nameB, String(specB), updates[nameB], updatedNames, quietUpdateSet) ? 1 : 0
        if (aUp !== bUp) return bUp - aUp
        // The chosen field applies INSIDE those two groups, not across them:
        // "sorted by install time" must not float a plugin the user switched
        // off above one that is running (#1142, and #745 above still holds).
        return compareInstalledRows(
          installedSort,
          { name: nameA, installedAt: installTimes[nameA]?.installedAt },
          { name: nameB, installedAt: installTimes[nameB]?.installedAt },
        )
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `updatesLoaded` stands in for `updates`/`updatedNames`: reorder when the check lands, then hold (#631). `effectiveDisabledSet` only re-runs this when a disable state actually changed; the toggled row is the only one that moves.
  }, [isInstalledListActive, displayedInstalled, selfName, updatesLoaded, effectiveDisabledSet, dependencyOnlyNames, installedSort, installTimes])
  const missingRestoreCount = Object.keys(pendingDependencies).filter(name => !installedFiles.includes(name)).length
  // Self-update lives in the page header (or the Plugins tab's own tab row)
  // and the settings card, not this tab's row list (the market itself is
  // filtered out below) — so a pending self-update alone must not light up a
  // dot pointing at an empty-looking tab.
  const hasUpdates = reminderUpdatableNames.length > 0

  /** Live status line: structured phase, or the human-line fallback. */
  const phasePart = progressPhase != null
    ? phaseLabel(progressPhase, t)
      + (progressCurrent !== null ? ' · ' + progressCurrent : '')
      + (progressDone > 0 ? ' · ' + t('packagesDone').replace('{0}', String(progressDone)) : '')
    : progressLine || t('progressHint')
  const progressText = cancelling ? t('cancelling') + ' · ' + phasePart : phasePart

  /** Whether the catalog carries ANY theme-category entry at all — distinct
   * from `themePlugins.length === 0` above (which also fires the instant a
   * search/sort/time filter matches nothing) so the two empty states read
   * differently: "there's nothing here yet" vs "nothing matches your filter". */
  const anyThemePlugins = data === null ? [] : themePluginsOf(data.plugins)

  /** The catalog entry a deprecated plugin's `replacement` names, if any. */
  const replacementOf = (p: RegistryPlugin): RegistryPlugin | undefined =>
    p.deprecated === true && p.replacement !== undefined
      ? data?.plugins.find(r => r.name === p.replacement)
      : undefined

  const renderFavoriteControl = (url: string) => (
    <FavoriteButton
      filled={favoriteUrlSet.has(url)}
      label={favoriteUrlSet.has(url) ? t('favoriteRemove') : t('favoriteAdd')}
      onToggle={() => toggleFavorite(url)}
    />
  )

  /** Bookmarks with no catalog entry have no card, so each gets its own row
   * and its own remove button; a bulk clear sits beside them when there are several. */
  const renderStaleFavorites = () => (
    <div className={css.favoritesStaleBar} data-testid="favorites-stale">
      <span>{t('favoritesStaleNote').replace('{0}', String(favoriteStale.length))}</span>
      {favoriteStale.map(url => (
        <div key={url} className={css.favoritesStaleRow}>
          <span className={css.favoritesStaleName}>{url.replace(/^https?:\/\/(www\.)?github\.com\//, '')}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={clearingStale}
            aria-label={`${t('favoriteRemove')} ${url}`}
            onClick={() => toggleFavorite(url)}
          >{t('favoriteRemove')}</Button>
        </div>
      ))}
      {favoriteStale.length > 1 && (
        <Button
          variant="outline"
          size="sm"
          disabled={clearingStale}
          onClick={() => clearStaleFavorites()}
        >{clearingStale ? t('favoritesClearingStale') : t('favoritesClearStale')}</Button>
      )}
    </div>
  )

  const renderPluginMenu = (plugin: RegistryPlugin, key = plugin.url) => {
    const aliases = blockAliases(plugin, matchInstalledName(plugin, installed, repoIdentities, data?.plugins, repoHints))
    const hidden = aliases.some(name => blockedNameSet.has(name))
    return (
      <Menu
        open={pluginMenuUrl === key}
        onClose={() => setPluginMenuUrl(null)}
        onSelect={(id) => {
          setPluginMenuUrl(null)
          if (id === 'favorite') toggleFavorite(plugin.url)
          if (id === 'block') toggleBlock(blockToggleName(aliases))
        }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className={css.cardMore}
            aria-label={t('groupMore')}
            aria-expanded={pluginMenuUrl === key}
            onClick={() => setPluginMenuUrl(open => open === key ? null : key)}
          >···</button>
        )}
        items={[
          { id: 'favorite', label: favoriteUrlSet.has(plugin.url) ? t('favoriteRemove') : t('favoriteAdd') },
          { id: 'block', label: hidden ? t('blockRemove') : t('blockAdd') },
        ]}
      />
    )
  }

  /** Catalog copy wins; an installed package can still explain itself when
   * it has no usable catalog description (#1147). Shared by all installed views. */
  const authoredDescription = (name: string, entry: RegistryPlugin | undefined): string => {
    for (const description of [entry?.description?.[lang], entry?.description?.en, localDescriptions[name]]) {
      if (typeof description === 'string' && description.trim() !== '') return description.trim()
    }
    return ''
  }

  /**
   * What the group view says about an installed plugin beyond its name: the
   * user's own note, else the author's description (#1006, #1147). One place,
   * so a plugin reads the same in a group or in "Ungrouped".
   */
  const installedBlurb = (name: string) => {
    const entry = data === null ? undefined : catalogEntryForInstalled(data.plugins, name, String(installed[name]), repoIdentities[name], repoHints[name])
    const note = notes[name]
    const authored = authoredDescription(name, entry)
    return { entry, note, shown: note ?? authored }
  }

  const renderInstalledBlockMenu = (name: string) => {
    // The host's page for this bundle, when it offers one. It is the only
    // place a bundle's ROWS can be switched one by one, which is the reason
    // to leave a page that already installs, updates and removes.
    const hostPage = openInHost === undefined ? null : () => { openInHost.openBundle(name) }

    const entry = data === null ? undefined : catalogEntryForInstalled(data.plugins, name, String(installed[name] ?? ''), repoIdentities[name], repoHints[name])
    const aliases = entry === undefined ? [name] : blockAliases(entry, name)
    const hidden = aliases.some(alias => blockedNameSet.has(alias))
    // Favourites are keyed by the CATALOG entry's url (#414), so an installed
    // plugin with no catalog entry has nothing the Favorites tab could list —
    // the action is offered only where it can be honoured (#785).
    const favoriteUrl = entry?.url
    const favorited = favoriteUrl !== undefined && favoriteUrlSet.has(favoriteUrl)
    const removing = removingName === name
    const uninstallBusy = removingName !== null || busyUrl !== null || updatingName !== null
    const spec = String(installed[name] ?? '')
    const status = updates[name]
    const localDev = isLocalDev(spec, status)
    const exempt = updateExemptSet.has(name)
    const updatable = isPluginUpdatable(name, spec, status, updatedNames)
    // A plain checkout has no release feed to remind about. A local package the
    // catalog can replace does (restoreRequired), and an existing entry stays
    // reachable so it can still be removed.
    const showExempt = !localDev || exempt || updatable
    // Undo stays on the row ("恢复提醒"); only the dismissal itself lives here.
    const showBootIgnore = bootId !== null && !exempt && !ignoredUpdateSet.has(name) && updatable
    // With an update pending, the action band already offers the same switch
    // as its primary button; one entry, one name.
    const showRestore = localDev && !(status?.updateAvailable === true && status.restoreRequired === true)
    return (
      <Menu
        open={installedMenuName === name}
        onClose={() => setInstalledMenuName(null)}
        onSelect={(id) => {
          setInstalledMenuName(null)
          if (id === 'restore-online' && data !== null && !uninstallBusy) askRestore(name)
          if (id === 'favorite' && favoriteUrl !== undefined) toggleFavorite(favoriteUrl)
          if (id === 'block') toggleBlock(blockToggleName(aliases))
          if (id === 'update-exempt') toggleUpdateExempt(name)
          if (id === 'ignore-boot') ignoreUpdateNotices([name])
          if (id === 'host-page') hostPage?.()
          if (id === 'uninstall' && !uninstallBusy) setRemoveConfirm(name)
        }}
        align="end"
        portal
        anchor={(
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('groupMore')}
            onClick={() => setInstalledMenuName(open => open === name ? null : name)}
          >···</Button>
        )}
        items={[
          ...(showRestore ? [{ id: 'restore-online', label: t('restoreOnline'), disabled: data === null || uninstallBusy }] : []),
          // Before block: the same kind of choice about one plugin, and the
          // harmless one of the two. Having it installed is exactly when a user
          // knows whether it is worth keeping — the complaint in #785 was
          // installing one first and then hunting for it again in Discover.
          ...(favoriteUrl === undefined ? [] : [{ id: 'favorite', label: favorited ? t('favoriteRemove') : t('favoriteAdd') }]),
          { id: 'block', label: hidden ? t('blockRemove') : t('blockAdd') },
          ...(showBootIgnore ? [{ id: 'ignore-boot', label: t('ignoreUpdateNotice') }] : []),
          ...(hostPage === null ? [] : [{ id: 'host-page', label: t('openInHostPage') }]),
          ...(showExempt ? [{ id: 'update-exempt', label: exempt ? t('updateExemptRemove') : t('updateExemptAdd') }] : []),
          { type: 'separator' as const, id: 'uninstall-sep' },
          { id: 'uninstall', label: removing ? t('uninstalling') : t('uninstall'), danger: true, disabled: uninstallBusy },
        ]}
      />
    )
  }

  /**
   * Chip label for one capability name, or the scanner's own name.
   *
   * `network` has a label; a name this build has never seen (`dynamic-code`
   * arrived after the first integration) shows as itself rather than
   * disappearing — an unlabelled fact is still a fact, and a missing chip
   * would read as "does not do that".
   */
  const capabilityLabel = (name: string): string => {
    const key = 'cap' + name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('')
    const label = t(key)
    return label === key ? name : label
  }

  /**
   * The scanner's red-line sentences, in the reader's language.
   *
   * The scanner emits a fixed set of shapes — one per rule family — and every
   * one of them is translated here. A sentence from a family this build does
   * not know stays in the scanner's own words on purpose: a mistranslation of
   * a security fact is worse than a foreign word, and this is the one line on
   * the card a reader must not misread. The shapes are matched by their stable
   * prefix rather than in full, so the parenthesised detail the scanner
   * attaches can change without falling back to English.
   */
  const redLineLabel = (line: string): string => {
    if (line === 'reads credentials/secrets AND has network access') return t('capRedCredentialsNetwork')
    const plaintext = /^uses plaintext http:\/\/ to (.+)$/.exec(line)
    if (plaintext !== null) return t('capRedPlaintextHttp').replace('{0}', plaintext[1]!)
    const literalIp = /^uses literal IP (.+) for network access$/.exec(line)
    if (literalIp !== null) return t('capRedLiteralIp').replace('{0}', literalIp[1]!)
    const installScript = /^runs code at install time(?: \((.+)\))?$/.exec(line)
    if (installScript !== null) {
      return installScript[1] === undefined
        ? t('capRedInstallScript')
        : t('capRedInstallScriptScripts').replace('{0}', installScript[1])
    }
    // The parenthesised detail is not a name. The scanner emits exactly two
    // shapes — "overrides bundle <id>" and "disables bundle <id>" — and pasting
    // either through leaves the verb in English. That verb is the fact: the
    // install would replace a part of DSH, or switch one off.
    const coreVerb = /^tampers with a core bundle \((overrides|disables) bundle (.+)\)$/.exec(line)
    if (coreVerb !== null) {
      const key = coreVerb[1] === 'overrides' ? 'capRedCoreOverride' : 'capRedCoreDisable'
      return t(key).replace('{0}', coreVerb[2]!)
    }
    const coreTamper = /^tampers with a core bundle(?: \((.+)\))?$/.exec(line)
    if (coreTamper !== null) {
      return coreTamper[1] === undefined
        ? t('capRedCoreTamper')
        : t('capRedCoreTamperDetail').replace('{0}', coreTamper[1])
    }
    return line
  }

  /**
   * What the static scan found (#401), in the detail dialog and nowhere else.
   *
   * It used to sit on both cards. It does not any more, for three reasons that
   * all pointed the same way: a capability list does not help anyone choose a
   * plugin, most of it cannot be acted on, and — the one that decided it — a
   * line every card carries is a line nobody reads, including the install-time
   * script that IS worth stopping for. So the card says nothing about this, the
   * dialog leads with the one thing that needs a decision before you press
   * install, and the rest of the facts are one click away.
   *
   * Which lines count as that one thing is `redLineIsUrgent`: a rare rule that
   * fires at install time, drawn above everything else. `aheadFacts` follow
   * as plain sentences in body ink. The closed fold holds every capability,
   * grouped by what it touches, with the uncommon ones filled and counted in
   * the fold's title as a frequency, plus the address red lines. The
   * blind-spot sentence sits under the fold whenever a scan ran, so a dialog
   * with nothing in front is not read as a clean scan. A plugin never scanned
   * gets the fold's frame with nothing to open and no blind-spot sentence:
   * the state is seen without a click, and there is no scan to qualify.
   * Nothing here scores, bands, or colours a plugin safe.
   */
  const capabilityDetail = (p: RegistryPlugin) => {
    const redLines = p.capabilityRedLines ?? []
    const ahead = aheadFacts(p)
    const addresses = redLines.filter(redLineNamesAddress)
    const names = p.capabilities ?? []
    const uncommon = names.filter(name => UNCOMMON_CAPABILITIES.has(name)).length
    const meta = names.length === 0
      ? undefined
      : uncommon === 0
        ? t('capabilityCount').replace('{0}', String(names.length))
        : t('capabilityCountUncommon').replace('{0}', String(names.length)).replace('{1}', String(uncommon))
    const chip = (name: string) => {
      const className = UNCOMMON_CAPABILITIES.has(name) ? `${css.capChip} ${css.capChipUncommon}` : css.capChip
      return HostTag !== null
        ? <HostTag key={name} tone="outline" className={className}>{capabilityLabel(name)}</HostTag>
        : <span key={name} className={className}>{capabilityLabel(name)}</span>
    }
    const checkedAt = typeof p.capabilityCheckedAt === 'string' && p.capabilityCheckedAt.length > 0
      ? p.capabilityCheckedAt.slice(0, 10)
      : null
    if (p.capabilities === undefined && redLines.length === 0) {
      return (
        <div className={css.confirmPanel} data-state="unchecked">
          <div className={`${css.confirmPanelRow} ${css.confirmPanelRowStatic}`}>
            <span className={css.confirmPanelIcon}><ConfirmCapabilityIcon /></span>
            <span className={css.confirmPanelTitle}>{t('capabilityTitle')}</span>
            <span className={css.confirmPanelMeta}>{t('capabilityUnchecked')}</span>
          </div>
        </div>
      )
    }
    return (
      <>
        {redLines.filter(redLineIsUrgent).map(line => (
          <p key={line} className={css.warnLine}>
            <IconWarningOutline16 size={14} className={css.bannerIcon} />
            {' ' + redLineLabel(line)}
          </p>
        ))}
        {ahead.length > 0 && (
          <div className={css.capAhead}>
            <p className={css.capAheadLabel}>{t('capabilityAhead')}</p>
            {ahead.map(fact => (
              <p key={fact} className={css.capAheadRow}>
                <AheadMark fact={fact} />
                <span>{fact === 'dynamic-code' ? capabilityLabel(fact) : redLineLabel(fact)}</span>
              </p>
            ))}
          </div>
        )}
        <ConfirmFold
          icon={<ConfirmCapabilityIcon />}
          title={t('capabilityTitle')}
          meta={meta}
          open={capsOpen}
          onToggle={() => setCapsOpen(o => !o)}
        >
          {addresses.length > 0 && (
            <div className={css.caps}>
              {addresses.map(line => (
                <span key={line} className={css.capAddress}>{redLineLabel(line)}</span>
              ))}
            </div>
          )}
          {p.capabilities === undefined
            ? <div className={css.caps}><span className={css.capMuted} data-state="unchecked">{t('capabilityUnchecked')}</span></div>
            : p.capabilities.length === 0
              ? <div className={css.caps}><span className={css.capMuted} data-state="none">{t('capabilityNone')}</span></div>
              : (
                  <div className={css.capGroups}>
                    {groupCapabilities(p.capabilities).map(([key, members]) => (
                      <Fragment key={key}>
                        <span className={css.capGroupLabel}>{t(key)}</span>
                        <div className={css.caps}>{members.map(name => chip(name))}</div>
                      </Fragment>
                    ))}
                  </div>
                )}
          {(uncommon > 0 || checkedAt !== null) && (
            <p className={css.capCaveat}>
              {uncommon > 0 && <span className={css.capCaveatNote}>{t('capabilityUncommonLegend')}</span>}
              {checkedAt !== null && <span className={css.capCaveatAt}>{t('capabilityScannedAt').replace('{0}', checkedAt)}</span>}
            </p>
          )}
        </ConfirmFold>
        <p className={css.capNote}>{t('capabilityNote')}</p>
      </>
    )
  }

  /**
   * The enable/disable control, wherever it appears — the installed row, a
   * group member row, the plugin detail view. One helper because they were
   * three copies of the same markup, and because the host has this component:
   * its own plugin list uses `Switch`, so the market's rows should look like
   * the list they sit in. Before 0.1.7-rc.2 the market's own switch renders,
   * with the same `role="switch"` contract either way.
   */
  const onOffSwitch = (opts: { label: string; on: boolean; disabled: boolean; toggle: () => void }) => (HostSwitch !== null
    ? <HostSwitch checked={opts.on} onChange={() => opts.toggle()} label={opts.label} disabled={opts.disabled} />
    : (
        <button
          type="button"
          role="switch"
          aria-checked={opts.on}
          aria-label={opts.label}
          className={opts.on ? `${css.switch} ${css.switchOn}` : css.switch}
          disabled={opts.disabled}
          onClick={opts.toggle}
        >
          <span className={css.switchKnob} />
        </button>
      ))

  /**
   * A labelled checkbox: the host's when it has one, the market's label+input
   * otherwise. Only the simple ones go through here — see `HostCheckbox` for
   * why the export rows and the recovery panel keep their own markup.
   */
  const labelledCheckbox = (opts: { label: string; checked: boolean; disabled?: boolean; className?: string; onChange: (next: boolean) => void }) => (HostCheckbox !== null
    ? <HostCheckbox checked={opts.checked} onChange={opts.onChange} label={opts.label} disabled={opts.disabled} className={opts.className} />
    : (
        <label className={opts.className}>
          <input type="checkbox" checked={opts.checked} disabled={opts.disabled} onChange={event => opts.onChange(event.target.checked)} />
          {opts.label}
        </label>
      ))

  const installAction = (p: RegistryPlugin) => {
    const done = doneUrls.includes(p.url) || hotUrls.includes(p.url)
    const already = isInstalled(p, catalogInstalled, repoIdentities, data?.plugins, repoHints)
    const busy = busyUrl === p.url
    const record = recordForUrl(records, p.url)
    const blocked = record !== null && (record.state === 'input' || record.state === 'failed')
    const queued = record !== null && record.state === 'queued'
    return done
      ? <span className={css.okState}>{t('installedBadge')}</span>
      : already
        ? <span className={css.okState}>{t('alreadyInstalled')}</span>
        : busy
          ? <Button variant="outline" size="sm" className={css.installBtn} disabled>{t('installing')}</Button>
          : queued
            ? (
                <button type="button" className={css.cardBlockedMark} onClick={openOperations}>
                  <IconWarningOutline16 size={13} />
                  {t(record?.hostOperationId !== undefined && (record.blockedBy?.length ?? 0) > 0 ? 'agentDrainBadge' : 'queuedBadge')}
                </button>
              )
            : blocked
              ? (
                  <button type="button" className={css.cardBlockedMark} onClick={openOperations}>
                    <IconWarningOutline16 size={13} />
                    {t('opBlockedCard')}
                  </button>
                )
              : (
                  <Button
                    variant="outline"
                    size="sm"
                    className={css.installBtn}
                    disabled={busyUrl !== null || !envReady}
                    onClick={() => setConfirming(p)}
                  >{t('install')}</Button>
                )
  }

  const recentTile = (p: RegistryPlugin) => {
    const desc = (p.description && (p.description[lang] || p.description.en)) || ''
    const record = recordForUrl(records, p.url)
    const blocked = record !== null && (record.state === 'input' || record.state === 'failed')
    return (
      <div key={p.url} className={blocked ? `${css.recentTile} ${css.cardBlocked}` : css.recentTile}>
        <div className={css.recentTitle}>
          <OwnerAvatar name={p.name} owner={p.owner || ''} icon={p.icon ?? undefined} trusted={p.source !== undefined} className={css.recentAv} />
          <div className={css.recentName}>
            {/* Same as a card: the name opens the detail dialog. */}
            <button type="button" className={`${css.nm} ${css.nmButton}`} title={p.name} onClick={() => setConfirming(p)}>
              {pluginName(p.name, p.npm)}
            </button>
          </div>
          {installAction(p)}
        </div>
        <div className={css.recentBottom}>
          {desc !== '' && <CardDesc text={desc} t={t} lines={3} className={css.recentDescBox} onOpen={() => setConfirming(p)} />}
          {renderPluginMenu(p, `recent:${p.url}`)}
        </div>
      </div>
    )
  }

  const pluginCard = (p: RegistryPlugin, menuKey = p.url) => {
    const desc = (p.description && (p.description[lang] || p.description.en)) || ''
    const busy = busyUrl === p.url
    const replacement = replacementOf(p)
    // The card reflects its own latest operation. Without this a rejected
    // install leaves the card looking untouched, and pressing Install again
    // is the obvious next move — which is how the same clash gets hit twice.
    const record = recordForUrl(records, p.url)
    const blocked = record !== null && (record.state === 'input' || record.state === 'failed')
    const compatibilityKey = hostCompatibilityKey(p)
    const compatibility = compatibilityKey === null ? undefined : hostCompatibility[compatibilityKey]
    const hostChip = hostRequirementChip(compatibility, compatibilityKey, t)
    return (
      <div key={p.url} className={blocked ? `${css.card} ${css.cardBlocked}` : css.card}>
        <div className={css.row1}>
          {/* The avatar belongs to the AUTHOR, not to the title. Beside the
              name it reads as one signature, which is what frees the title
              to be just the plugin — and lets two authors ship a plugin of
              the same name without either card needing a qualifier. */}
          <div style={{ minWidth: 0 }}>
            {/* The name opens the detail dialog, the same one Install opens;
                the GitHub mark beside it is still the way to the source. */}
            <div className={`${css.nm} ${css.nmRow}`}>
              <button type="button" className={css.nmButton} title={p.name} onClick={() => setConfirming(p)}>
                {pluginName(p.name, p.npm)}
              </button>
              {linksToGithub(p) && (
                <a className={css.repoMarkLink} href={p.url} target="_blank" rel="noreferrer" aria-label={`${p.name} — ${t('repoLink')}`} title={t('repoLink')}>
                  <GithubRepoMark className={css.repoMark} />
                </a>
              )}
              {p.deprecated === true && <span className={css.depBadge}>{t('deprecatedBadge')}</span>}
            </div>
            <div className={css.byline}>
              <OwnerAvatar name={p.name} owner={p.owner || ''} icon={p.icon ?? undefined} trusted={p.source !== undefined} />
              <span className={css.owner} title={p.owner}>{p.owner}</span>
            </div>
            <CardStats plugin={p} t={t} versionTip={catalogVersionTip} />
          </div>
          {/* Top right, at its natural size: in the footer it needed a row of
              its own once the cards went two-up, which cost every card that
              height whether or not it had anything else to say. */}
          <span className={css.grow} />
          <div className={css.cardAction}>
            {installAction(p)}
          </div>
        </div>
        <CardDesc text={desc} t={t} onOpen={() => setConfirming(p)} />
        <CardShot plugin={p} onOpen={openLightbox} />
        {p.deprecated === true && (
          <div className={css.deprecate}>
            <div className={css.depLine}>
              <span>⚠️ {t('deprecatedWarn')}</span>
              {replacement !== undefined && (
                <a className={css.src} href={replacement.url} target="_blank" rel="noreferrer">
                  {t('replacementHint') + ' ' + replacement.name}
                </a>
              )}
            </div>
          </div>
        )}
        <div className={css.foot}>
          <div className={css.footTags}>
            <CardTip label={hostChip.title} maxWidth={320}>
              <span
                className={hostChip.bad
                  ? `${css.hostRequirement} ${css.hostRequirementBad}`
                  : css.hostRequirement}
                data-status={hostChip.status}
                tabIndex={0}
              >{hostChip.label}</span>
            </CardTip>
            <SourceTag plugin={p} lang={lang} />
            <PinnedNote plugin={p} t={t} />
            {pluginCategories(p).map(category => (
              <span key={category} className={css.tag}>
                {categoryNames?.[category]?.[lang] || categoryNames?.[category]?.en || category}
              </span>
            ))}
          </div>
          {/* Published date and a source link used to live here too — both
              redundant now that the title itself opens the repo, and the
              date/tag pair alone was long enough in English to wrap onto its
              own line, splitting one card's footer into two visual rows. */}
          <span className={css.footActions}>
            {renderFavoriteControl(p.url)}
            {/* No thread when the organization turned comments off, and none for an
                entry from an added catalog: its thread would live on the public
                site, under the name of something that is not listed there. */}
            {orgPolicy().comments && p.source === undefined && (
              <button type="button" className={css.commentsLink} onClick={() => setCommentsFor(p)}>
                {t('comments')}
              </button>
            )}
            {renderPluginMenu(p, menuKey)}
          </span>
        </div>
        {busy && (
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
    )
  }

  const installedNameOf = (p: RegistryPlugin) => matchInstalledName(p, installed, repoIdentities, data?.plugins, repoHints)

  // Plugins loaded at boot (bundle-layer skins) aren't in the shim list but
  // are just as live; the boot manifest is the page's own record of them.
  const bootEntries = (typeof window !== 'undefined' && window.__DSH_BOOT__ && Array.isArray(window.__DSH_BOOT__.entries))
    ? window.__DSH_BOOT__.entries
    : []

  // Theme-native card: visual preview first, then identity and lifecycle.
  // This deliberately does not reuse pluginCard; repository metadata is
  // useful context here, but it must not outrank the theme itself.
  const themePluginCard = (p: RegistryPlugin) => {
    const instName = installedNameOf(p)
    const desc = (p.description && (p.description[lang] || p.description.en)) || ''
    const replacement = replacementOf(p)
    const done = doneUrls.includes(p.url) || hotUrls.includes(p.url)
    const busy = busyUrl === p.url
    const record = recordForUrl(records, p.url)
    const blocked = record !== null && (record.state === 'input' || record.state === 'failed')
    const themeQueued = record !== null && record.state === 'queued'
    // A theme switched off via the Installed-tab toggle (or a group switch)
    // stays in the boot manifest, so the disabled set must veto the badge.
    const mounted = instName !== null
      && (skins.includes(instName) || bootEntries.some(e => e.id === instName))
      && !effectiveDisabledSet.has(instName)

    return (
      <article key={p.url} className={blocked ? `${css.themeCard} ${css.cardBlocked}` : css.themeCard}>
        <ThemeCover plugin={p} onOpen={openLightbox} t={t} />
        <div className={css.themeCardBody}>
          <div className={css.themeCardHead}>
            <div className={css.themeIdentity}>
              <a className={`${css.nm} ${css.nmLink}`} href={p.url} target="_blank" rel="noreferrer" title={p.name} aria-label={`${p.name} — ${t('repoLink')}`}>
                {pluginName(p.name, p.npm)}
                {linksToGithub(p) && <GithubRepoMark className={css.repoMark} />}
              </a>
              <div className={css.byline}>
                <OwnerAvatar name={p.name} owner={p.owner || ''} icon={p.icon ?? undefined} trusted={p.source !== undefined} />
                <span className={css.owner} title={p.owner}>{p.owner}</span>
              </div>
              <CardStats plugin={p} t={t} versionTip={catalogVersionTip} />
            </div>
            {p.deprecated === true && <span className={css.depBadge}>{t('deprecatedBadge')}</span>}
            {mounted && <span className={css.themeStatus}>{t('themeActive')}</span>}
            {instName !== null && !mounted && (
              <span className={css.themeStatusMuted}>
                {effectiveDisabledSet.has(instName) ? t('disabledState') : t('alreadyInstalled')}
              </span>
            )}
          </div>

          <p className={css.themeDescription} title={desc}>{desc}</p>

          {p.deprecated === true && (
            <div className={css.deprecate}>
              <div className={css.depLine}>
                <span>⚠️ {t('deprecatedWarn')}</span>
                {replacement !== undefined && (
                  <a className={css.src} href={replacement.url} target="_blank" rel="noreferrer">
                    {t('replacementHint') + ' ' + replacement.name}
                  </a>
                )}
              </div>
            </div>
          )}

          <div className={css.themeCardFooter}>
            <span className={css.footActions}>
              {renderFavoriteControl(p.url)}
              {renderPluginMenu(p)}
            </span>
            {instName === null && (
              <span className={css.themeLifecycle}>{done ? t('installedBadge') : t('notInstalled')}</span>
            )}
            <div className={css.themeActions}>
              {instName === null
                ? done
                  ? <span className={css.okState}>{t('installedBadge')}</span>
                  : busy
                    ? <Button variant="outline" size="sm" className={css.installBtn} disabled>{t('installing')}</Button>
                    : themeQueued
                      ? (
                          <button type="button" className={css.cardBlockedMark} onClick={openOperations}>
                            <IconWarningOutline16 size={13} />
                            {t(record?.hostOperationId !== undefined && (record.blockedBy?.length ?? 0) > 0 ? 'agentDrainBadge' : 'queuedBadge')}
                          </button>
                        )
                      : blocked
                      ? (
                          <button type="button" className={css.cardBlockedMark} onClick={openOperations}>
                            <IconWarningOutline16 size={13} />
                            {t('opBlockedCard')}
                          </button>
                        )
                      : (
                          <Button
                            variant="outline"
                            size="sm"
                            className={css.installBtn}
                            disabled={busyUrl !== null || !envReady}
                            onClick={() => setConfirming(p)}
                          >{t('install')}</Button>
                        )
                : (
                    <>
                      {removingName === instName
                        ? <Button variant="outline" size="sm" disabled>{t('uninstalling')}</Button>
                        : <Button variant="ghost" size="sm" onClick={() => setRemoveConfirm(instName)}>{t('uninstall')}</Button>}
                      {mounted
                        ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={togglingName !== null}
                              onClick={() => doToggle(instName, false, true)}
                            >{t('themeDeactivate')}</Button>
                          )
                        : <Button variant="primary" size="sm" onClick={() => doUseSkin(instName)}>{t('themeApply')}</Button>}
                    </>
                  )}
            </div>
          </div>

          {busy && (
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
      </article>
    )
  }

  const themeCard = (id: string, label: string, swatch: string[]) => {
    const active = themeSnap !== null && themeSnap.preference === id
    return (
      <div key={'th-' + id} className={css.card}>
        <div className={css.swatches}>{swatch.map((c, i) => <i key={i} style={{ background: c }} />)}</div>
        <div className={css.foot}>
          <span className={css.nm}>{label}</span>
          <span className={css.grow} />
          {active
            ? <span className={css.okState}>{t('themeActive')}</span>
            : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { try { props.theme.setTheme(id) } catch (error) { setInstallError(String(error)) } }}
                >{t('themeApply')}</Button>
              )}
        </div>
      </div>
    )
  }

  const categories = discoverCatalog === null ? [] : Object.keys(discoverCatalog.categories)

  useLayoutEffect(() => { setVisibleCats(null) }, [lang, categories.length])
  // The sidebar page is often much wider than the settings dialog. A budget
  // measured once at the first (sometimes still-zero) width left a half-empty
  // category row on the wide panel — remeasure whenever the wrap's width
  // actually changes.
  useLayoutEffect(() => {
    const el = catsWrapRef.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    let width = el.clientWidth
    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width ?? el.clientWidth
      // jsdom (and a pre-layout frame in the host) reports 0 — treating that
      // as a real shrink cleared the budget and left every chip painted.
      if (next < 80 || Math.abs(next - width) < 8) return
      width = next
      setVisibleCats(null)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [discoverCatalog])
  useLayoutEffect(() => {
    if (visibleCats !== null) return
    const el = catsWrapRef.current
    if (el === null) return
    const chips = [...el.children].filter((c): c is HTMLElement => (c as HTMLElement).dataset?.chip === '1')
    if (chips.length === 0) return
    // How many pills sit in the first row — the collapsed state is exactly one
    // row, so this is the whole budget. It counts 「全部」 too, which is why the
    // slice below gives the category list one slot fewer.
    const first = chips[0]!
    const rowTwoTop = first.offsetTop + first.offsetHeight + 6 - 3
    let fits = 0
    for (const chip of chips) { if (chip.offsetTop < rowTwoTop) fits += 1 }
    setVisibleCats(Math.max(1, fits))
  }, [visibleCats, discoverCatalog])

  useEffect(() => {
    // The Plugins tab scrolls with the host page. Collapse-on-scroll against
    // `.body` (which no longer scrolls) is what #266 / #395 flapped on, so
    // this surface never auto-collapses. The row itself can still pin.
    if (surface === 'plugins' || catsSentinel === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      ([entry]) => {
        const leftView = entry !== undefined && !entry.isIntersecting
        // Collapsing shrinks the sticky header, which shrinks the scrollable
        // content. When there is barely more content than viewport, that
        // makes scrollHeight drop below the current scroll position, the
        // browser CLAMPS scrollTop, the sentinel slides back into view, and
        // the row expands again — which grows the content, restores the
        // scroll, and starts over. Reported as the category bar flapping and
        // the list refusing to scroll (#266 by @hidge123), and reproduced
        // here: a filtered list went scrollTop 78 → 0 and snapped straight
        // back from one row to four.
        //
        // The guard is not a tuning constant, it is the feature's own
        // precondition: collapsing exists to reclaim vertical space while
        // scrolling a LONG list. If the scroller has less overflow than the
        // category row could give back, collapsing buys nothing and can only
        // start the loop, so it does not happen. Long lists — the case this
        // was built for — are unaffected.
        const root = bodyRef.current
        const wrap = catsWrapRef.current
        if (leftView && root !== null && wrap !== null) {
          const overflow = root.scrollHeight - root.clientHeight
          if (overflow <= wrap.offsetHeight) return
        }
        setCatsStuck(prev => (prev === leftView ? prev : leftView))
      },
      { root: bodyRef.current, threshold: 0 },
    )
    observer.observe(catsSentinel)
    return () => observer.disconnect()
  }, [catsSentinel, surface])
  // Drop any in-pin expand once the header unpins, so the next pin starts
  // collapsed without a rising-edge setState in the observer.
  useEffect(() => {
    if (!catsStuck) setStuckExpanded(false)
  }, [catsStuck])
  /** Expanded chips + chevron share one value. Stuck uses `stuckExpanded`
   * so pinning collapses without rewriting `catsOpen` in a layout effect
   * (see stuckExpanded state). Leaving stuck falls back to `catsOpen`,
   * which still holds the pre-pin / in-pin user choice. */
  const catsExpanded = catsStuck ? stuckExpanded : catsOpen

  /**
   * The collapsed row must be exactly one row.
   *
   * Whatever the measuring pass predicts, the answer is only right once the
   * chips are painted with the host's real font — an early pass measures
   * narrower pills and lands one too many, which wraps the last one onto a
   * second row. So: after a collapsed render, look at what actually happened
   * and step the budget down until the row holds. A layout effect, so the
   * correction lands before paint and the user never sees the two-row state.
   */
  useLayoutEffect(() => {
    const el = catsWrapRef.current
    if (el === null || visibleCats === null || catsExpanded) return
    const chips = [...el.children].filter((c): c is HTMLElement => (c as HTMLElement).dataset?.chip === '1')
    if (chips.length < 2) return
    const top = Math.round(chips[0]!.getBoundingClientRect().top)
    if (chips.every(chip => Math.round(chip.getBoundingClientRect().top) === top)) return
    setVisibleCats(Math.max(1, chips.length - 1))
  }, [visibleCats, catsExpanded, catsStuck])

  /**
   * A fresh install (hotUrls/hotNames) and a toggle/group action
   * (refreshNames) both end in the same place — "reload the page" — and
   * used to render as two near-identical banners stacked on top of each
   * other when both happened in one session (reported as "为啥有三个状态横幅
   * 啊，太奇怪了"). They're merged into one count and one banner; only the
   * restart banner (a full host restart, a different action entirely) stays
   * separate.
   */
  const pendingRefreshNames = useMemo(
    () => [...new Set([...hotNames, ...refreshNames])],
    [hotNames, refreshNames],
  )

  /** Installed plugins the market itself cannot group (#60). */
  const groupableNames = Object.keys(installed)
    .filter(name => name !== 'dsh-market' && name !== 'dshmarket' && !dependencyOnlyNames.has(name))
  /** Names already inside some group; everything else shows under "ungrouped". */
  const groupedNames = useMemo(() => new Set(Object.values(groups).flat()), [groups])
  const ungroupedNames = groupableNames.filter(name => !groupedNames.has(name))
  const groupQuery = qInstalled.trim().toLowerCase()
  const matchesInstalledQuery = useCallback((name: string) => {
    if (groupQuery === '') return true
    if (name.toLowerCase().includes(groupQuery)) return true
    const note = notes[name]
    if (note !== undefined && note.toLowerCase().includes(groupQuery)) return true
    const spec = installed[name]
    if (spec !== undefined && String(spec).toLowerCase().includes(groupQuery)) return true
    if (data !== null && spec !== undefined) {
      const entry = catalogEntryForInstalled(data.plugins, name, String(spec), repoIdentities[name], repoHints[name])
      const desc = (entry?.description && (entry.description[lang] || entry.description.en)) || ''
      if (desc.toLowerCase().includes(groupQuery)) return true
    }
    return false
  }, [data, groupQuery, installed, lang, notes, repoHints, repoIdentities])
  const visibleUngrouped = ungroupedNames.filter(matchesInstalledQuery)
  const visibleGroupIds = groupOrder.filter(gid => {
    if (groupQuery === '') return true
    if (gid.toLowerCase().includes(groupQuery)) return true
    return (groups[gid] ?? []).some(matchesInstalledQuery)
  })
  /** Installed package names the catalog classifies as themes (client-side
   * mirror of the server's classification; themes are exclusive per group). */
  const installedThemeNames = useMemo(() => {
    const names = new Set<string>()
    if (data === null) return names
    for (const [name, spec] of Object.entries(installed)) {
      const entry = catalogEntryForInstalled(data.plugins, name, String(spec), repoIdentities[name], repoHints[name])
      if (entry !== undefined && pluginCategories(entry).includes('theme')) names.add(name)
    }
    return names
  }, [data, installed, repoIdentities, repoHints])

  const openThemePanel = useCallback((group: string) => {
    const current = (groups[group] ?? []).find(name => installedThemeNames.has(name)) ?? null
    setAddPanel(null)
    setRenamingGroup(null)
    setDeletingGroup(null)
    setGroupMenuFor(null)
    setThemePick(current)
    setThemePanel(group)
  }, [groups, installedThemeNames])

  /** Set or clear the single theme slot. The previous theme leaves this group. */
  const applyGroupTheme = useCallback((group: string, themeName: string | null) => {
    const members = groups[group] ?? []
    const without = members.filter(name => !installedThemeNames.has(name))
    const next = themeName === null ? without : [...without, themeName]
    void doGroupAction({ action: 'set-members', name: group, members: next }).then(ok => {
      if (ok) setThemePanel(null)
    })
  }, [doGroupAction, groups, installedThemeNames])

  const marketUpdateStatus = updates[selfName]
  const eligibleMarketVersion = marketUpdateStatus?.updateAvailable === true
    ? marketUpdateStatus.eligibleVersion ?? marketUpdateStatus.latest ?? null
    : null
  const heldMarketVersion = marketUpdateStatus?.heldUpdate
  const showMarketWait = typeof heldMarketVersion?.latest === 'string'
    && heldMarketVersion.latest !== ''
    && heldMarketVersion.latest !== eligibleMarketVersion
    && !updatedNames.includes(selfName)
    && !quietUpdateSet.has(selfName)

  // The market's own new version. It used to be a bare button on the
  // Installed row; it is now a one-line notice on Installed that says what
  // updating does (MarketHead), so the version is named before it is taken.
  const marketOffer = (() => {
    const self = installed['dshmarket'] !== undefined ? 'dshmarket' : 'dsh-market'
    const status = updates[self]
    if (!status || !status.updateAvailable || updatedNames.includes(self) || quietUpdateSet.has(self)) return null
    return {
      name: self,
      version: status.eligibleVersion ?? status.latest ?? null,
      restoreRequired: status.restoreRequired === true,
    }
  })()
  const takeMarketOffer = (): void => {
    if (marketOffer === null) return
    setTab('installed')
    if (marketOffer.restoreRequired) askRestore(marketOffer.name)
    else doUpdate(marketOffer.name)
  }

  // Update-all on the Installed row. On the Plugins tab the host already has
  // a page title, so it sits on the market's own tab row; Settings and the
  // sidebar keep it in the heading.
  // "Update all" leaves out plugins that are switched off, so they are easy to
  // forget. Say how many are waiting; each updates from its own card (#1257).
  const disabledUpdateCount = Object.keys(installed).filter(name => name !== selfName
    && effectiveDisabledSet.has(name)
    && isPluginUpdatable(name, String(installed[name]), updates[name], updatedNames, quietUpdateSet)).length
  const batchActions = (
    <>
      {disabledUpdateCount >= 1 && (
        <span className={css.spec} title={t('disabledUpdatesHint')}>
          {t('disabledUpdates').replace('{0}', String(disabledUpdateCount))}
        </span>
      )}
      {reminderBatchUpdatableNames.length >= 1 && (
        <Button
          variant="primary"
          size="sm"
          disabled={updatingAll || updatingName !== null || busyUrl !== null || removingName !== null}
          onClick={() => { setTab('installed'); doUpdateAll() }}
        >{updatingAll ? t('updating') : t('updateAll') + ' (' + reminderBatchUpdatableNames.length + ')'}</Button>
      )}
    </>
  )
  // The header banner means "the check did not complete". One row that can never
  // answer (a private repo probed anonymously) keeps its own per-row hint; it must
  // not hold the whole page in a retry state forever (#1227).
  const updateCheckFailed = updateCheck.failed === null
    || (updateCheck.failed.size > 0 && updateCheck.failed.size >= Object.keys(updateCheck.updates).length)
  return {
    anyThemePlugins, applyGroupTheme, authoredDescription, batchActions, capabilityDetail,
    categories, catsExpanded, eligibleMarketVersion, groupQuery, hasUpdates,
    heldMarketVersion, installedBlurb, installedThemeNames, labelledCheckbox, matchesInstalledQuery,
    missingRestoreCount, onOffSwitch, openThemePanel, orderedInstalledEntries, pendingRefreshNames,
    pendingRestart, pluginCard, progressText, recentTile, renderInstalledBlockMenu,
    renderStaleFavorites, replacementOf, showHostPending, showMarketWait, themeCard, themePluginCard,
    ungroupedNames, updateCheckFailed, visibleGroupIds, visibleUngrouped, marketOffer, takeMarketOffer,
  } as const
}

export type MarketRenderCtx = ReturnType<typeof useMarketRender>
