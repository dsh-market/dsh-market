/**
 * The Installed tab: list and groups views, update/notes rows, install-task rows and per-plugin menus.
 */

import { Button, DisclosureRow, Input, Menu, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Market.module.css'
import { SearchInput } from './SearchInput.tsx'
import {
  catalogEntryForInstalled,
  displayLatest,
  groupSwitchState,
  hostCompatibilityKey,
  installedDateText,
  installedStateTag,
  isGenerationSpec,
  isInstalled,
  localizeBilingualList,
  profileBlockedText,
} from './market-data.ts'
import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconChevronUpOutline14,
  IconFolderOpen16,
  IconLinkOutline14,
  IconLoadingOutline16,
  IconQuestionOutline14,
} from './icons.ts'
import { catalogReleaseSourceOf } from '../sources.ts'
import { InstalledSortMenu } from './MarketListControls.tsx'
import { activationMeta, hostRequirementChip } from './MarketStatusParts.tsx'
import { CardDesc, Masonry } from './MarketLayout.tsx'
import {
  heldUpdateBeside,
  isAbsoluteLocalPath,
  isLocalDev,
  isPluginUpdatable,
  localPathOf,
  shortLocalPath,
} from './market-helpers.ts'
import { CardTip, ConfirmCopyButton, HOVER_TIP_DELAY_MS, IconBellOff, IconClock, IconPlus } from './MarketCardParts.tsx'
import { NOTE_MAX } from './market-constants.ts'
import type { MarketStateCtx } from './market-state.tsx'
import type { MarketGroupsBackupCtx } from './market-groups-backup.ts'
import type { MarketRenderCtx } from './market-render.tsx'
import type { MarketSyncCtx } from './market-sync.ts'
import type { MarketOperationsCtx } from './market-operations.ts'
import type { MarketSectionProps } from './market-types.ts'

type InstalledTabCtx = { props: MarketSectionProps }
  & Pick<MarketStateCtx,
    'activations' | 'assignFor' | 'bootId' | 'busyUrl' | 'cancelling' | 'collapsedGroups' |
    'creatingGroup' | 'data' | 'deletingGroup' | 'groupMenuFor' | 'groupOrder' | 'groups' |
    'hostCompatibility' | 'hostVersion' | 'installTimes' | 'installedFiles' | 'installedSearchReset' |
    'installedSort' | 'installedView' | 'lang' | 'newGroupName' | 'noteDraft' | 'notes' |
    'notingName' | 'pendingBackup' | 'progressPct' | 'qInstalled' | 'removingName' | 'repoHints' |
    'repoIdentities' | 'setAddPanel' | 'setAssignFor' | 'setCat' | 'setCollapsedGroups' |
    'setConfirming' | 'setCreatingGroup' | 'setDeletingGroup' | 'setGroupMenuFor' |
    'setInstalledSort' | 'setInstalledView' | 'setNewGroupName' | 'setNoteDraft' | 'setNotingName' |
    'setQ' | 'setQInstalled' | 'setRenamingGroup' | 'setRenamingValue' | 'setShowTheirs' | 'setTab' |
    'setWhyOpen' | 'showTheirs' | 't' | 'togglingName' | 'updateCheck' | 'updatedNames' | 'updates' |
    'updatingName' | 'whyOpen'>
  & Pick<MarketSyncCtx, 'catalogInstalled' | 'effectiveDisabledSet' | 'updateExemptSet'>
  & Pick<MarketOperationsCtx,
    'askRestore' | 'askSourceMigration' | 'doCancel' | 'doUpdate' | 'openNotes' | 'saveNote' |
    'toggleUpdateExempt'>
  & Pick<MarketGroupsBackupCtx,
    'cancelCreateGroup' | 'dependencyOnlyNames' | 'doAssign' | 'doCreateGroup' | 'doDeleteGroup' |
    'doGroupToggle' | 'doRemoveMember' | 'doToggle' | 'ignoredUpdateSet' | 'openAddPanel' |
    'toggleCollapsedGroup' | 'unignoreUpdateNotice'>
  & Pick<MarketRenderCtx,
    'authoredDescription' | 'batchActions' | 'groupQuery' | 'installedBlurb' | 'installedThemeNames' |
    'matchesInstalledQuery' | 'onOffSwitch' | 'openThemePanel' | 'orderedInstalledEntries' |
    'progressText' | 'renderInstalledBlockMenu' | 'ungroupedNames' | 'visibleGroupIds' |
    'visibleUngrouped'>

export function InstalledTab({ c }: { c: InstalledTabCtx }) {
  const {
    activations, askRestore, askSourceMigration, assignFor, authoredDescription, batchActions, bootId, busyUrl,
    cancelCreateGroup, cancelling, catalogInstalled, collapsedGroups, creatingGroup, data,
    deletingGroup, dependencyOnlyNames, doAssign, doCancel, doCreateGroup, doDeleteGroup,
    doGroupToggle, doRemoveMember, doToggle, doUpdate, effectiveDisabledSet, groupMenuFor,
    groupOrder, groupQuery, groups, hostCompatibility, hostVersion, ignoredUpdateSet, installTimes,
    installedBlurb, installedFiles, installedSearchReset, installedSort, installedThemeNames,
    installedView, lang, matchesInstalledQuery, newGroupName, noteDraft, notes, notingName,
    onOffSwitch, openAddPanel, openNotes, openThemePanel, orderedInstalledEntries, pendingBackup,
    progressPct, progressText, qInstalled, removingName, renderInstalledBlockMenu, repoHints,
    repoIdentities, saveNote, setAddPanel, setAssignFor, setCat, setCollapsedGroups, setConfirming,
    setCreatingGroup, setDeletingGroup, setGroupMenuFor, setInstalledSort, setInstalledView,
    setNewGroupName, setNoteDraft, setNotingName, setQ, setQInstalled, setRenamingGroup,
    setRenamingValue, setShowTheirs, setTab, setWhyOpen, showTheirs, t, toggleCollapsedGroup,
    toggleUpdateExempt, togglingName, ungroupedNames, unignoreUpdateNotice, updateCheck,
    updateExemptSet, updatedNames, updates, updatingName, visibleGroupIds, visibleUngrouped, whyOpen,
  } = c
  return (
    <>
      {/* On the Plugins page the update actions live here, beside the rows
          they act on, instead of in the tab row on every tab. */}
      <div className={css.installedTopRow}>
        <div className={css.viewBar}>
          <button type="button" className={installedView === 'list' ? `${css.viewBtn} ${css.viewOn}` : css.viewBtn} onClick={() => setInstalledView('list')}>{t('tabList')}</button>
          <button type="button" className={installedView === 'groups' ? `${css.viewBtn} ${css.viewOn}` : css.viewBtn} onClick={() => setInstalledView('groups')}>{t('tabGroups')}</button>
        </div>
        <div className={css.installedBatch}>{batchActions}</div>
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
                // Null for a package that is not on disk: see installedStateTag.
                const stateTag = installedStateTag(off, act?.state)
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
                        inventory uses for exactly this state. A package that
                        is not on disk has no membership worth reporting, so
                        the line keeps its 未安装 diagnosis instead (#1278). */}
                    {!missing && act?.library !== true && stateTag !== null && (
                      <span className={css.stateTag} data-on={stateTag === 'off' ? 'false' : 'true'}>
                        <span className={css.stateDot} data-on={stateTag === 'off' ? 'false' : 'true'} />
                        {stateTag === 'off' ? t('disabledState') : t('switchOnLabel')}
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
  )
}
