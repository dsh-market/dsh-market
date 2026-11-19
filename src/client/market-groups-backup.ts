/**
 * Market queue, groups and backup: queued runs, installed groups, update-all, and the backup / WebDAV / Gist actions.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { drop, enqueue, type OperationRecord, patch as patchRecord } from './operations.ts'
import {
  api,
  type GistExportResult,
  profileBlockedText,
  profileBlockStillHolds,
  type RegistryPlugin,
} from './market-data.ts'
import { backupDependencies, isPluginUpdatable } from './market-helpers.ts'
import { IGNORED_UPDATES_SESSION_KEY, WEBDAV_STORAGE_KEY } from './market-constants.ts'
import type { MarketStateCtx } from './market-state.tsx'
import type { MarketInstallCtx } from './market-install.ts'
import type { MarketOperationsCtx } from './market-operations.ts'
import type { MarketSyncCtx } from './market-sync.ts'
import type { MarketSectionProps } from './market-types.ts'

type MarketGroupsBackupIn = { props: MarketSectionProps }
  & Pick<MarketStateCtx,
    'activations' | 'addPanel' | 'addSelected' | 'autoBackup' | 'bootId' | 'busyUrl' | 'data' |
    'drainingRef' | 'exportIncludeConfig' | 'exportSelection' | 'gistId' | 'gistMode' | 'gistToken' |
    'groups' | 'ignoredUpdateNames' | 'installed' | 'installedBundles' | 'loadedDisabled' |
    'newGroupName' | 'nextRecordId' | 'pendingBackup' | 'profileBlockRef' | 'records' |
    'refreshInstalled' | 'rememberPassword' | 'removingName' | 'renamingValue' | 'restartHoldRef' |
    'setActivations' | 'setAddPanel' | 'setAddQuery' | 'setAddSelected' | 'setAgentsConfirm' |
    'setAssignFor' | 'setBackupBusy' | 'setBackupMessage' | 'setBackupRestored' |
    'setCollapsedGroups' | 'setCreatingGroup' | 'setDeletingGroup' | 'setDisabledNames' |
    'setExportError' | 'setExportIncludeConfig' | 'setExportOpen' | 'setExportSelection' |
    'setGistBusy' | 'setGistId' | 'setGistMessage' | 'setGistMode' | 'setGistOk' | 'setGistResult' |
    'setGroupMenuFor' | 'setGroupOrder' | 'setGroups' | 'setIgnoredUpdateNames' | 'setInstallError' |
    'setNewGroupName' | 'setOperationsOpen' | 'setPendingBackup' | 'setPendingDependencies' |
    'setRecords' | 'setRefreshNames' | 'setRememberPassword' | 'setRenamingGroup' |
    'setRenamingValue' | 'setRestoreConfirmOpen' | 'setRestoreErrors' | 'setSkins' | 'setTab' |
    'setThemePanel' | 'setToggleRestart' | 'setToggled' | 'setTogglingName' | 'setUpdatingAll' |
    'setWebdavNeedsPassword' | 'setWebdavSaved' | 'statusRef' | 't' | 'updateExemptNames' |
    'updatedNames' | 'updates' | 'updatingName' | 'webdavInFlight' | 'webdavPassword' |
    'webdavPasswordUsable' | 'webdavSaved' | 'webdavUrl' | 'webdavUser'>
  & Pick<MarketSyncCtx,
    'applyDrainStatus' | 'effectiveDisabledSet' | 'readMarketStatus' | 'restoreDrainMarkers'>
  & Pick<MarketInstallCtx, 'doInstall' | 'installedBlocked'>
  & Pick<MarketOperationsCtx, 'clearPendingRefresh' | 'doUninstall' | 'doUpdate'>

/** queued runs, groups, update-all, backup / WebDAV / Gist. */
export function useMarketGroupsBackup(c: MarketGroupsBackupIn) {
  const {
    activations, addPanel, addSelected, applyDrainStatus, autoBackup, bootId, busyUrl,
    clearPendingRefresh, data, doInstall, doUninstall, doUpdate, drainingRef, effectiveDisabledSet,
    exportIncludeConfig, exportSelection, gistId, gistMode, gistToken, groups, ignoredUpdateNames,
    installed, installedBlocked, installedBundles, loadedDisabled, newGroupName, nextRecordId,
    pendingBackup, profileBlockRef, readMarketStatus, records, refreshInstalled, rememberPassword,
    removingName, renamingValue, restartHoldRef, restoreDrainMarkers, setActivations, setAddPanel,
    setAddQuery, setAddSelected, setAgentsConfirm, setAssignFor, setBackupBusy, setBackupMessage,
    setBackupRestored, setCollapsedGroups, setCreatingGroup, setDeletingGroup, setDisabledNames,
    setExportError, setExportIncludeConfig, setExportOpen, setExportSelection, setGistBusy,
    setGistId, setGistMessage, setGistMode, setGistOk, setGistResult, setGroupMenuFor, setGroupOrder,
    setGroups, setIgnoredUpdateNames, setInstallError, setNewGroupName, setOperationsOpen,
    setPendingBackup, setPendingDependencies, setRecords, setRefreshNames, setRememberPassword,
    setRenamingGroup, setRenamingValue, setRestoreConfirmOpen, setRestoreErrors, setSkins, setTab,
    setThemePanel, setToggleRestart, setToggled, setTogglingName, setUpdatingAll,
    setWebdavNeedsPassword, setWebdavSaved, statusRef, t, updateExemptNames, updatedNames, updates,
    updatingName, webdavInFlight, webdavPassword, webdavPasswordUsable, webdavSaved, webdavUrl,
    webdavUser,
  } = c
// Drain-loop refs, assigned after doInstall/doUpdate/doUninstall exist
  // (the mount-once drain effect below only reads refs, never closures).
  const busyUrlRef = useRef<string | null>(null)
  busyUrlRef.current = busyUrl
  const updatingNameRef = useRef<string | null>(null)
  updatingNameRef.current = updatingName
  const removingNameRef = useRef<string | null>(null)
  removingNameRef.current = removingName
  /**
   * The records as of the last commit, for the drain's tick.
   *
   * The tick must not read the list out of its own `setRecords` updater.
   * React only runs that updater synchronously when the fiber has no pending
   * work (its eager-state optimization, react-dom dispatchSetState); an
   * interval tick regularly races the status poll's state writes, and when
   * the updater is deferred the read returns null BEFORE it runs — while the
   * updater still removes the row it finds when render finally calls it. The
   * drain then deleted a queued operation instead of starting it, and the
   * persistence effect rewrote the durable queue without it.
   */
  const recordsRef = useRef<OperationRecord[]>(records)
  recordsRef.current = records
  const dataRef = useRef<typeof data>(null)
  dataRef.current = data
  const doInstallRef = useRef<((plugin: RegistryPlugin) => void) | null>(null)
  doInstallRef.current = doInstall
  const doUpdateRef = useRef<((name: string, force?: boolean, restore?: boolean, compatVersion?: string, confirmAgentsRunning?: boolean, eligibleVersion?: string) => Promise<void>) | null>(null)
  doUpdateRef.current = doUpdate
  const doUninstallRef = useRef<((name: string) => Promise<void>) | null>(null)
  doUninstallRef.current = doUninstall

  /**
   * Whether a plugin operation started from THIS page is still in flight.
   *
   * The host runs one mutation at a time and answers a second one with 409
   * (routes.ts withMutationLock) rather than queueing it, so every start path
   * has to look before it fires. The catalog and installed cards do it by
   * disabling their button on `busyUrl`/`updatingName`/`removingName`; the
   * drain does it on these refs. The Tasks panel's "run now" asked only about
   * the agent guard, so a batch of clicks sent one request that ran and N-1
   * the host refused — and a refusal used to be recorded as a failure, which
   * is not part of the durable queue.
   *
   * Refs, not `statusRef.current.busy`: that sample is up to a whole poll
   * interval old, and the batch lands inside exactly that window. Asking the
   * host "are you busy" cannot answer a question about a request this page
   * has just sent.
   */
  const operationInFlight = useCallback((): boolean =>
    busyUrlRef.current !== null || updatingNameRef.current !== null || removingNameRef.current !== null,
  [])

  /**
   * Installs wait only for the mutation lock; replacements also wait for
   * running sessions unless the user confirms a single request. Legacy hosts
   * can still refuse installs, so retain their queue fallback. When every
   * operation is queued, nothing else polls /status, so this loop fetches it
   * itself — but only while a queued record exists, so an idle page makes no
   * requests.
   * One mutation at a time — the host still serializes via its lock, and a
   * re-refused drain simply re-queues instead of failing.
   */
  useEffect(() => {
    let disposed = false
    const timer = setInterval(() => {
      if (drainingRef.current) return
      if (operationInFlight()) return
      // The sentence above is the one this loop has to keep: it fetched
      // before asking whether anything was queued, so an open page polled
      // /status every 2 s for as long as it stayed open, queue or no queue
      // (#838). Ask first — with no record there is nothing to drain.
      const hasWork = recordsRef.current.some(record =>
        record.hostOperationId === undefined
          ? record.state === 'queued'
          : record.state === 'queued' || record.state === 'running')
      if (!hasWork) return
      void fetch(api('/dsh-market/status'), { cache: 'no-store' })
        .then(readMarketStatus)
        .then(status => {
          if (disposed || status === null) return
          const runningAgents: string[] = Array.isArray(status.runningAgents) ? status.runningAgents.map(String) : []
          const busy = status.busy === true
          statusRef.current = {
            busy,
            runningAgents,
            agentDrain: status.agentDrain === true,
            boot: typeof status.boot === 'string' ? status.boot : null,
          }
          applyDrainStatus(status)
          restoreDrainMarkers(status)
          if (busy) return
          // A Host-owned operation owns the lane. Client-queued rows must not
          // start beside it: the Host's maintenance barrier is what makes the
          // package command safe.
          if (status.drainActive === true) return
          if (operationInFlight()) return
          const task = recordsRef.current.find(record =>
            record.state === 'queued'
            && record.hostOperationId === undefined
            && (record.kind === 'install' || runningAgents.length === 0))
          if (task === undefined || recordsRef.current.some(record => record.state === 'running' && record.hostOperationId === undefined)) return
          // A queued update meets the same wall as the one that failed (#1252):
          // end it with the reason instead of starting a run that cannot work.
          // A queued update waits for the restart too; it stays queued (#1253).
          if (task.kind === 'update' && restartHoldRef.current) return
          const blocked = profileBlockRef.current
          if (task.kind === 'update' && blocked !== null && profileBlockStillHolds(blocked)) {
            const reason = t('profileBlockedSkipped').replace('{0}', profileBlockedText(blocked, t))
            setRecords(list => patchRecord(list, task.id, { state: 'failed', reason }))
            return
          }
          setRecords(list => list.filter(record => record.id !== task.id))
          drainingRef.current = true
          try {
            if (task.kind === 'install') {
              const plugin = dataRef.current?.plugins.find(candidate => candidate.url === task.url)
              if (plugin !== undefined) doInstallRef.current?.(plugin)
            } else if (task.kind === 'update') {
              void doUpdateRef.current?.(task.name, task.updateOptions?.force, task.updateOptions?.restore, task.updateOptions?.compatVersion, false, task.updateOptions?.eligibleVersion)
            } else {
              void doUninstallRef.current?.(task.name)
            }
          } finally {
            drainingRef.current = false
          }
        })
        .catch(() => { /* retry on the next tick */ })
    }, 2000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [applyDrainStatus, readMarketStatus, restoreDrainMarkers, t])

  /** A queued record's "run now": retry immediately instead of waiting for idle. */
  const runQueuedNow = useCallback((record: OperationRecord, confirmAgentsRunning = false) => {
    // A Host-owned row is already being coordinated; running it here would
    // start a second mutation outside the maintenance barrier.
    if (record.hostOperationId !== undefined) return
    if (!recordsRef.current.some(item => item.id === record.id && item.state === 'queued')) return
    if (record.kind !== 'install' && !confirmAgentsRunning &&
        (statusRef.current.runningAgents.length > 0 || (record.blockedBy?.length ?? 0) > 0)) {
      setAgentsConfirm({ name: record.name, kind: record.kind, run: () => runQueuedNow(record, true) })
      return
    }
    // The agent guard is not the only thing that can hold this row: the host's
    // mutation lock answers 409 while any earlier operation is in flight. The
    // panel has one "run now" per row and no card-level `disabled` to stop a
    // batch, so without this the second click of a batch is refused, and only
    // the first of N installs the user asked for survives.
    if (operationInFlight() || statusRef.current.busy) {
      setInstallError(t('queuedRunBusy'))
      setOperationsOpen(true)
      return
    }
    if (record.kind === 'install') {
      const plugin = data?.plugins.find(candidate => candidate.url === record.url)
      if (plugin === undefined) {
        // The catalog no longer holds it — a refresh or a page change replaced
        // `data`. Dropping the row silently was the same defect in miniature
        // (#752): the entry disappears and the user is left without an entry
        // or a reason. The way back is the catalog, so point at it.
        setRecords(prev => drop(prev, record.id))
        setInstallError(t('queuedInstallGone'))
        setOperationsOpen(true)
        return
      }
      setRecords(prev => drop(prev, record.id))
      doInstall(plugin)
    } else if (record.kind === 'update') {
      setRecords(prev => drop(prev, record.id))
      void doUpdate(record.name, record.updateOptions?.force, record.updateOptions?.restore, record.updateOptions?.compatVersion, confirmAgentsRunning, record.updateOptions?.eligibleVersion)
    } else {
      setRecords(prev => drop(prev, record.id))
      void doUninstall(record.name, confirmAgentsRunning)
    }
  }, [data, doInstall, doUpdate, doUninstall, operationInFlight, t])

  /** Live enable/disable of one installed plugin (#60). `reload` opts the
   * card-level theme flow into a page refresh so the visual result lands
   * immediately (mirrors the use-skin reload on activate). */
  const doToggle = useCallback((name: string, enabled: boolean, reload = false) => {
    setTogglingName(name)
    setInstallError(null)
    return fetch(api('/dsh-market/toggle'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, enabled }),
    })
      .then(res => res.json().then(body => ({ status: res.status, body })))
      .then(({ status, body }) => {
        if (status === 200 && body.ok) {
          if (Array.isArray(body.disabled)) setDisabledNames(body.disabled)
          if (Array.isArray(body.live)) setSkins(body.live)
          if (body.activation && typeof body.activation === 'object') {
            setActivations(prev => ({ ...prev, ...body.activation }))
          }
          // A toggle whose fiber did not follow the switch joins the
          // pending-restart banner (same path as installs/updates/removals).
          if (body.restart === true) setToggleRestart(n => n + 1)
          // A client-part plugin's UI is already in the page — refresh to
          // show the change (mirrors the install hot banner).
          // Back to the position the page was rendered with means there is
          // nothing left for a refresh to show, so the banner drops it
          // instead of counting the round trip as a pending change (#340).
          if (body.refresh === true) {
            const wasDisabled = loadedDisabled.current?.has(name) ?? false
            if (wasDisabled === !enabled) clearPendingRefresh(name)
            else setRefreshNames(names => names.includes(name) ? names : names.concat(name))
          }
          // Not on the reload path: the page is about to go away, and the
          // theme flow lands its own toast on the other side.
          if (!reload) setToggled({ name, enabled })
          refreshInstalled()
          if (reload) {
            // Land back in the Themes tab with the stock look on screen.
            // Drop a stale install/switch toast so it cannot resurrect.
            sessionStorage.removeItem('dshm-toast')
            sessionStorage.removeItem('dshm-toast-mode')
            sessionStorage.setItem('dshm-tab', 'themes')
            location.reload()
          }
        } else {
          const text = (v: unknown) => typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)
          // The server's bilingual reason (e.g. host cannot hot-mount —
          // restart required) beats the generic failure line.
          setInstallError(text(body.reason) || text(body.error) || t('toggleFail'))
          // The durable state (state.json + patch layer) was still written,
          // so a restart applies it even though the live drive failed.
          if (body.restart === true) setToggleRestart(n => n + 1)
          if (body.refresh === true) setRefreshNames(names => names.includes(name) ? names : names.concat(name))
        }
      })
      .catch(error => setInstallError(String(error)))
      .finally(() => setTogglingName(null))
  }, [clearPendingRefresh, refreshInstalled, t])

  /** Adopt the groups payload returned by POST /dsh-market/groups. */
  const setGroupPayload = useCallback((body: {
    groups?: Record<string, string[]>
    groupOrder?: string[]
    disabled?: string[]
  }) => {
    if (body.groups && typeof body.groups === 'object') setGroups(body.groups)
    if (Array.isArray(body.groupOrder)) setGroupOrder(body.groupOrder)
    if (Array.isArray(body.disabled)) setDisabledNames(body.disabled)
  }, [])

  /** One POST /dsh-market/groups round trip (create/rename/delete/members/toggle). */
  const doGroupAction = useCallback((payload: Record<string, unknown>): Promise<boolean> => {
    setInstallError(null)
    return fetch(api('/dsh-market/groups'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(res => res.json().then(body => ({ status: res.status, body })))
      .then(({ status, body }) => {
        if (status === 200 && body.ok) {
          setGroupPayload(body)
          // Batch toggles whose members did not follow the switch join the
          // pending-restart banner too.
          if (Array.isArray(body.restartMembers) && body.restartMembers.length > 0) {
            setToggleRestart(n => n + body.restartMembers.length)
          }
          if (Array.isArray(body.refreshMembers) && body.refreshMembers.length > 0) {
            setRefreshNames(names => [...new Set([...names, ...body.refreshMembers])])
          }
          refreshInstalled()
          return true
        }
        const text = (v: unknown) => typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)
        if (body.partial === true) {
          setGroupPayload(body)
          refreshInstalled()
        }
        setInstallError(text(body.error) || t('toggleFail'))
        if (Array.isArray(body.restartMembers) && body.restartMembers.length > 0) {
          setToggleRestart(n => n + body.restartMembers.length)
        }
        if (Array.isArray(body.refreshMembers) && body.refreshMembers.length > 0) {
          setRefreshNames(names => [...new Set([...names, ...body.refreshMembers])])
        }
        return false
      })
      .catch(error => { setInstallError(String(error)); return false })
  }, [refreshInstalled, setGroupPayload, t])

  /** Approve the build scripts pnpm refused, then rerun what was blocked. */
  const approveAndRetry = useCallback((
    names: string[],
    resume: () => void,
  ) => {
    fetch(api('/dsh-market/approve-builds'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ packages: names }),
    })
      .then(res => res.json())
      .then((body) => {
        if (!body.ok) setInstallError(String(body.error || 'approve failed'))
        else resume()
      })
      .catch(error => setInstallError(String(error)))
  }, [])

  const doGroupToggle = useCallback((name: string, enabled: boolean) => {
    return doGroupAction({ action: 'toggle', name, enabled })
  }, [doGroupAction])

  const cancelCreateGroup = useCallback(() => {
    setCreatingGroup(false)
    setNewGroupName('')
  }, [])

  const doCreateGroup = useCallback(() => {
    const name = newGroupName.trim()
    if (name === '') return
    void doGroupAction({ action: 'create', name }).then(ok => {
      if (ok) cancelCreateGroup()
    })
  }, [cancelCreateGroup, doGroupAction, newGroupName])

  const doRenameGroup = useCallback((name: string) => {
    const newName = renamingValue.trim()
    if (newName === '' || newName === name) {
      setRenamingGroup(null)
      return
    }
    void doGroupAction({ action: 'rename', name, newName }).then(ok => {
      if (ok) {
        setRenamingGroup(null)
        setRenamingValue('')
      }
    })
  }, [doGroupAction, renamingValue])

  const doDeleteGroup = useCallback((name: string) => {
    void doGroupAction({ action: 'delete', name }).then(ok => {
      if (ok) setDeletingGroup(null)
    })
  }, [doGroupAction])

  const doAssign = useCallback((name: string, group: string) => {
    if (group === '') return
    const members = groups[group] ?? []
    void doGroupAction({ action: 'set-members', name: group, members: [...members, name] }).then(ok => {
      if (ok) setAssignFor(null)
    })
  }, [doGroupAction, groups])

  const doRemoveMember = useCallback((group: string, name: string) => {
    const members = (groups[group] ?? []).filter(member => member !== name)
    void doGroupAction({ action: 'set-members', name: group, members })
  }, [doGroupAction, groups])

  /** Open the multi-select add-members dialog for a group. Plugins only. */
  const openAddPanel = useCallback((group: string) => {
    setRenamingGroup(null)
    setDeletingGroup(null)
    setGroupMenuFor(null)
    setThemePanel(null)
    setAddQuery('')
    setAddSelected([])
    setAddPanel(group)
  }, [])

  /** Commit the current multi-select into the open group. */
  const doAddSelectedMembers = useCallback(() => {
    if (addPanel === null || addSelected.length === 0) return
    const members = groups[addPanel] ?? []
    const next = [...members]
    for (const name of addSelected) {
      if (!next.includes(name)) next.push(name)
    }
    void doGroupAction({ action: 'set-members', name: addPanel, members: next }).then(ok => {
      if (ok) setAddPanel(null)
    })
  }, [addPanel, addSelected, doGroupAction, groups])

  const toggleCollapsedGroup = useCallback((gid: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(gid)) next.delete(gid)
      else next.add(gid)
      return next
    })
  }, [])

  // The market itself stays out of the batch: its update reloads this page
  // mid-run, which would strand the remaining items.
  const selfName = installed['dshmarket'] !== undefined ? 'dshmarket' : 'dsh-market'
  const updatableNames = Object.keys(installed).filter(
    name => name !== selfName
      && !effectiveDisabledSet.has(name)
      && isPluginUpdatable(name, String(installed[name]), updates[name], updatedNames),
  )
  // Replacing a local source with its catalog source is deliberately not a
  // batch update: every such plugin has an existing, explicit confirmation
  // gate because the source switch cannot be rolled back.
  const batchUpdatableNames = updatableNames.filter(name => updates[name]?.restoreRequired !== true)
  const ignoredUpdateSet = useMemo(() => new Set(ignoredUpdateNames), [ignoredUpdateNames])
  // Session dismissals die with the boot. The saved list does not. Reminders
  // read the union; the row still shows that an update exists (#728).
  const quietUpdateSet = useMemo(
    () => new Set([...ignoredUpdateNames, ...updateExemptNames]),
    [ignoredUpdateNames, updateExemptNames],
  )
  const reminderUpdatableNames = updatableNames.filter(name => !quietUpdateSet.has(name) && !installedBlocked(name))
  const reminderBatchUpdatableNames = batchUpdatableNames.filter(name => !quietUpdateSet.has(name) && !installedBlocked(name))
  const selfUpdateAvailable = updates[selfName]?.updateAvailable === true && !updatedNames.includes(selfName)
  const reminderUpdateNames = [
    ...(selfUpdateAvailable ? [selfName] : []),
    ...updatableNames,
  ].filter(name => !quietUpdateSet.has(name) && !installedBlocked(name))
  // The market manages itself from its own settings card (Settings → Plugins
  // → Plugin configuration), not as a row here — listing it in both places
  // read as two different controls for the same thing.
  /**
   * Installed packages that are not plugins at all: a plain library some
   * other plugin pulled in — zustand, bufferutil, a peer of ws (#634's
   * `dependencyOf`, #857). They were rendered as plugin cards with a
   * working uninstall, which is a real remove path for something a plugin
   * needs. Out of the list; the count stays visible in one quiet line, so the
   * list is not silently shorter than package.json.
   */
  const dependencyOnlyNames = useMemo(
    () => new Set(Object.keys(installed).filter(name => {
      const act = activations[name]
      return act?.state === 'inert' && act.dependencyOf !== undefined
    })),
    [installed, activations],
  )
  const installedOtherCount = Object.keys(installed)
    .filter(name => name !== selfName && !dependencyOnlyNames.has(name)).length

  const ignoreUpdateNotices = useCallback((names: string[]) => {
    if (bootId === null || names.length === 0) return
    setIgnoredUpdateNames(current => {
      const next = [...new Set([...current, ...names])]
      try {
        sessionStorage.setItem(IGNORED_UPDATES_SESSION_KEY, JSON.stringify({ boot: bootId, names: next }))
      } catch { /* storage unavailable: keep the dismissal for this mount */ }
      return next
    })
  }, [bootId])

  const unignoreUpdateNotice = useCallback((name: string) => {
    if (bootId === null) return
    setIgnoredUpdateNames(current => {
      const next = current.filter(n => n !== name)
      try {
        sessionStorage.setItem(IGNORED_UPDATES_SESSION_KEY, JSON.stringify({ boot: bootId, names: next }))
      } catch { /* storage unavailable: the change holds for this mount */ }
      return next
    })
  }, [bootId])

  const doUpdateAll = useCallback(() => {
    const names = reminderBatchUpdatableNames.map(name => ({ name, eligibleVersion: updates[name]?.eligibleVersion }))
    setUpdatingAll(true)
    const next = () => {
      // The first refusal for a profile-wide wait ends the batch (#1252): the
      // rest would meet the same wall, so say so once per plugin and stop.
      const blocked = profileBlockRef.current
      if (names.length > 0 && blocked !== null && profileBlockStillHolds(blocked)) {
        const reason = t('profileBlockedSkipped').replace('{0}', profileBlockedText(blocked, t))
        const skipped = names.splice(0, names.length)
        setRecords(list => skipped.reduce((acc, item) => enqueue(acc, {
          id: nextRecordId(), kind: 'update', name: item.name, state: 'failed', reason,
        }), list))
      }
      // The host asked for a restart (#1253): the rest would be refused the
      // same way. They stay un-updated and listed; the notice says what to do.
      if (restartHoldRef.current) names.splice(0, names.length)
      const item = names.shift()
      if (item === undefined) {
        setUpdatingAll(false)
        // The queue was a snapshot taken before any of it ran, and a batch is
        // where it drifts furthest from the profile (#495): re-read the list
        // once at the end so what is left on screen is what is actually still
        // updatable, forced past the 30-minute listing cache.
        refreshInstalled(true)
        return
      }
      doUpdate(item.name, false, false, undefined, false, item.eligibleVersion).then(next, next)
    }
    next()
  }, [reminderBatchUpdatableNames, doUpdate, refreshInstalled, updates, t, nextRecordId])

  const finishRestore = useCallback((body: { errors?: unknown; unportable?: unknown; pinned?: unknown; bootErrors?: unknown }) => {
    const errors = Array.isArray(body.errors) ? body.errors as { name?: unknown; error?: unknown }[] : []
    // Machine-specific dependency paths (#205): a `link:/Users/…` spec from
    // the machine that wrote the backup names a directory that does not
    // exist here, so pnpm cannot satisfy it. Listed with the other restore
    // problems rather than in a banner of its own — from the operator's
    // side it is one question ("what went wrong with my restore?").
    const unportable = Array.isArray(body.unportable) ? body.unportable as { name?: unknown; spec?: unknown }[] : []
    // The market is the package running the restore, so it keeps its own
    // version instead of having its files swapped out mid-operation. Said
    // here rather than in a banner of its own: from the operator's side it is
    // the same question ("what did not come back?"), and the answer has a
    // next step (update the market separately).
    const pinned = Array.isArray(body.pinned) ? body.pinned as { name?: unknown; from?: unknown; to?: unknown }[] : []
    // Partial failures surface inline in the Backup tab (previously a
    // window.alert); the restore itself still completes.
    // What the profile analysis says about the composition that just landed
    // (#205). The restore itself succeeded; these are the packages the
    // composition still needs, which otherwise surfaced only at the NEXT
    // boot, as a Loader error with nothing tying it back to the restore.
    const bootErrors = Array.isArray(body.bootErrors) ? body.bootErrors.map(String) : []
    setRestoreErrors([
      ...errors.map(item => `${String(item.name)}: ${String(item.error)}`),
      ...unportable.map(item => `${String(item.name)}: ${t('restoreUnportable')} (${String(item.spec)})`),
      ...pinned.map(item => `${String(item.name)}: ${t('restoreSelfPinned')} (${String(item.from)} → ${String(item.to)})`),
      ...bootErrors.map(line => `${t('restoreBootError')} ${line}`),
    ])
    setBackupRestored(true)
    setBackupMessage(t('restoreDone'))
    if (errors.length === 0) {
      setPendingBackup(null)
      setPendingDependencies({})
    }
    refreshInstalled(true)
  }, [refreshInstalled, t])

  const previewBackup = useCallback((backup: unknown) => {
    const dependencies = backupDependencies(backup)
    setPendingBackup(backup)
    setPendingDependencies(dependencies)
    setBackupMessage(t('restorePreviewDone'))
    setRestoreErrors([])
    setTab('installed')
  }, [t])

  /** Actually run the restore; the confirm dialog gates this (previously window.confirm). */
  const doRestore = useCallback(() => {
    if (pendingBackup === null) return Promise.resolve()
    setRestoreConfirmOpen(false)
    setBackupBusy(true)
    setBackupMessage(null)
    setRestoreErrors([])
    return fetch(api('/dsh-market/restore'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backup: pendingBackup }),
    }).then(async response => {
      const body = await response.json()
      if (!response.ok) throw new Error(String(body.error || 'restore failed'))
      finishRestore(body)
    }).catch(error => setBackupMessage(String(error))).finally(() => setBackupBusy(false))
  }, [finishRestore, pendingBackup])

  const runWebdav = useCallback((action: 'backup' | 'restore') => {
    if (webdavUrl.trim() === '' || webdavInFlight.current) return
    webdavInFlight.current = true
    setBackupBusy(true)
    setBackupMessage(null)
    setRestoreErrors([])
    fetch(api('/dsh-market/webdav'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, url: webdavUrl.trim(), username: webdavUser, password: webdavPassword, remember: rememberPassword }),
    }).then(async response => {
      const body = await response.json()
      if (!response.ok) throw new Error(String(body.error || 'WebDAV failed'))
      if (rememberPassword && webdavPassword !== '') setWebdavSaved({ remembered: true, url: webdavUrl.trim(), username: webdavUser })
      if (action === 'restore') {
        previewBackup(body.backup)
      }
      if (action === 'backup') {
        try { localStorage.setItem('dshm-webdav-last', String(Date.now())) } catch { /* storage unavailable */ }
        setBackupMessage(t('backupDone'))
      }
    }).catch(error => {
      const message = String(error)
      // #1058: a 401 with an empty password field is not a mystery — the
      // password is never stored, so this is what every reload looks like.
      // Name the state on the card instead of a bare `HTTP 401`, and clear it
      // the moment a password is typed.
      if (action === 'backup' && !webdavPasswordUsable && /HTTP 401|401/u.test(message)) {
        setWebdavNeedsPassword(true)
        setBackupMessage(null)
        return
      }
      setBackupMessage(message)
    }).finally(() => {
      webdavInFlight.current = false
      setBackupBusy(false)
    })
  }, [previewBackup, rememberPassword, t, webdavPassword, webdavPasswordUsable, webdavUrl, webdavUser])

  /** Map the server's token-source string to a localized label. */
  const gistSourceLabel = (source: string): string => {
    if (source === 'token') return t('gistSrcToken')
    if (source === 'env') return t('gistSrcEnv')
    if (source === 'gh') return t('gistSrcGh')
    return source
  }

  /** Turn any failure (server error, network error, timeout) into a friendly message. */
  const gistErrorMessage = (error: unknown): string => {
    const err = error as { name?: unknown; code?: unknown }
    const name = typeof err?.name === 'string' ? err.name : ''
    const code = typeof err?.code === 'string' ? err.code : ''
    if (code === 'timeout' || name === 'TimeoutError' || name === 'AbortError') return t('gistErrTimeout')
    if (code === 'network') return t('gistErrNetwork')
    if (code === 'auth') return t('gistErrAuth')
    if (code === 'notfound') return t('gistErrNotFound')
    if (code === 'rate-limit') return t('gistErrRateLimit')
    if (code === 'invalid') return t('gistErrInvalid')
    // Network-level fetch failures surface as TypeError("Failed to fetch").
    if (error instanceof TypeError) return t('gistErrNetwork')
    return String(error)
  }

  /** The picker list: dependency plugins + bundle-only plugins, deduplicated. */
  const exportOptions = useMemo(() => {
    const names = new Set([...Object.keys(installed), ...installedBundles])
    return [...names].sort()
  }, [installed, installedBundles])
  const exportAllSelected = exportOptions.length > 0 && exportOptions.every(name => exportSelection.has(name))

  const runGist = useCallback((action: 'export' | 'import' | 'verify') => {
    setGistBusy(true)
    setGistMessage(null)
    setGistOk(false)
    setGistResult(null)
    setRestoreErrors([])
    setExportError(null)
    const body: Record<string, unknown> = { action, token: gistToken.trim() }
    // Import always targets the field; export targets it only in update mode
    // (create mode deliberately ignores the field and makes a new Gist).
    if (action === 'import') body.gistId = gistId.trim()
    if (action === 'export' && gistMode === 'update') {
      if (gistId.trim() === '') {
        setGistBusy(false)
        setGistMessage(t('gistErrNoId'))
        setGistOk(false)
        return
      }
      body.gistId = gistId.trim()
    }
    // A full export includes configuration by default. A partial export
    // includes only the selected plugins and any explicitly selected config.
    if (action === 'export' && !exportAllSelected) {
      body.includeDeps = [...exportSelection]
      if (exportIncludeConfig) body.includeConfig = true
    }
    fetch(api('/dsh-market/gist'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      // Fallback ceiling only — the server answers structured errors (with a
      // code) within 25 s, so a wedged host cannot leave the user staring at
      // "working…" forever.
      signal: AbortSignal.timeout(30_000),
    }).then(async response => {
      let body: Record<string, unknown> = {}
      try { body = await response.json() as Record<string, unknown> } catch { /* non-JSON response */ }
      if (!response.ok) {
        const error = new Error(String(body.error || 'Gist failed'))
        if (typeof body.code === 'string') (error as { code?: string }).code = body.code
        throw error
      }
      if (action === 'export') {
        setGistResult(body as unknown as GistExportResult)
        // Backfill the id so the next export updates this Gist instead of
        // creating yet another one.
        const ref = body as unknown as GistExportResult
        if (typeof ref.gistId === 'string' && ref.gistId !== '') {
          setGistId(ref.gistId)
          // A fresh export flips the mode to update so the next export
          // PATCHes the same Gist instead of creating yet another one.
          setGistMode('update')
          try { localStorage.setItem('dshm-gist-id', ref.gistId) } catch { /* storage unavailable */ }
        }
        setGistMessage(t('gistExportDone'))
        setGistOk(true)
        setExportOpen(false)
      } else if (action === 'import') {
        previewBackup(body.backup)
      } else {
        // verify: tell the user which token source actually served the request.
        const source = typeof body.source === 'string' ? body.source : ''
        setGistMessage(t('gistVerifySource').replace('{0}', gistSourceLabel(source)))
        setGistOk(true)
      }
    }).catch(error => {
      const message = gistErrorMessage(error)
      setGistMessage(message)
      setGistOk(false)
      // Keep the picker open (selection preserved) and show the failure
      // inside it — never hidden behind the dialog.
      if (action === 'export') setExportError(message)
    }).finally(() => setGistBusy(false))
  }, [exportAllSelected, exportIncludeConfig, exportSelection, gistId, gistMode, gistToken, previewBackup, t])

  /** Classify an install spec for the export picker badge. */
  const specKind = (spec: string | undefined): 'npm' | 'git' | 'file' | 'bundle' => {
    if (spec === undefined) return 'bundle'
    if (/^file:/i.test(spec)) return 'file'
    if (/^(github:|git\+|git:)/i.test(spec)) return 'git'
    return 'npm'
  }

  const openExportPicker = useCallback(() => {
    setExportSelection(new Set(exportOptions))
    setExportIncludeConfig(false)
    setExportOpen(true)
  }, [exportOptions])

  const runWebdavRef = useRef(runWebdav)
  useEffect(() => { runWebdavRef.current = runWebdav }, [runWebdav])

  useEffect(() => {
    // Persist only the non-secret WebDAV settings; the password stays
    // server-side/in-memory (see savedWebdav). Storage itself may be
    // unavailable (e.g. the client test env), so never let it crash the UI.
    try {
      localStorage.setItem(WEBDAV_STORAGE_KEY, JSON.stringify({ url: webdavUrl, username: webdavUser, auto: autoBackup }))
    } catch { /* storage unavailable — config just won't survive reload */ }
  }, [autoBackup, webdavUrl, webdavUser])

  // Check when the market opens or daily backup is enabled. Editing the
  // settings (or changing the locale) must not start another upload.
  useEffect(() => {
    fetch(api('/dsh-market/webdav')).then(response => response.json()).then((body: { remembered?: boolean; url?: string; username?: string }) => {
      setWebdavSaved({ remembered: body.remembered === true, url: body.url, username: body.username })
      setRememberPassword(body.remembered === true)
    }).catch(() => setWebdavSaved({ remembered: false }))
  }, [])

  useEffect(() => {
    if (!autoBackup) return
    // #1058: a server that needs a login cannot be backed up without its
    // password. Wait quietly (the card says so) instead of uploading with an
    // empty one and getting a 401 on every market open.
    if (webdavUser !== '' && !webdavPasswordUsable) {
      if (webdavSaved !== undefined) setWebdavNeedsPassword(true)
      return
    }
    let last = 0
    try {
      last = Number(localStorage.getItem('dshm-webdav-last')) || 0
    } catch { /* ignore */ }
    if (Date.now() - last >= 24 * 60 * 60 * 1000) runWebdavRef.current('backup')
    // Only the first answer matters: later edits to the form must not retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoBackup, webdavUser === '' || webdavSaved !== undefined])
  return {
    approveAndRetry, cancelCreateGroup, dependencyOnlyNames, doAddSelectedMembers, doAssign,
    doCreateGroup, doDeleteGroup, doGroupAction, doGroupToggle, doRemoveMember, doRenameGroup,
    doRestore, doToggle, doUpdateAll, exportAllSelected, exportOptions, ignoreUpdateNotices,
    ignoredUpdateSet, installedOtherCount, openAddPanel, openExportPicker, previewBackup,
    quietUpdateSet, recordsRef, reminderBatchUpdatableNames, reminderUpdatableNames,
    reminderUpdateNames, runGist, runQueuedNow, runWebdav, selfName, specKind, toggleCollapsedGroup,
    unignoreUpdateNotice,
  } as const
}

export type MarketGroupsBackupCtx = ReturnType<typeof useMarketGroupsBackup>
