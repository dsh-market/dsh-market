/**
 * Market operations: restart, cancel, source migration, notes, block and dismiss flows.
 */

import { useCallback } from 'react'
import { drop, enqueue, type OperationRecord, patch as patchRecord } from './operations.ts'
import { applyRecovery, fetchRecovery, initialKeep, type RecoveryView, watchRestart } from './RecoveryPanel.tsx'
import {
  api,
  type DrainOperationWire,
  entryForDep,
  failureText,
  localizeBilingual,
  resolveCatalogRestore,
} from './market-data.ts'
import { blockedSessions, withoutHostProjection } from './market-helpers.ts'
import type { CompatibilityNotice, DismissBrokenReply, FavoriteReply, MarketSectionProps } from './market-types.ts'
import type { ResolvedNotes } from './MarketNotes.tsx'
import type { MarketStateCtx } from './market-state.tsx'
import type { MarketInstallCtx } from './market-install.ts'
import type { MarketSyncCtx } from './market-sync.ts'

type MarketOperationsIn = { props: MarketSectionProps }
  & Pick<MarketStateCtx,
    'blockOpGen' | 'blockedNames' | 'bootId' | 'bootIdRef' | 'brokenPlugins' | 'data' |
    'dismissBrokenGen' | 'favoriteOpGen' | 'favoriteUrls' | 'hotNames' | 'installed' |
    'installedReadGen' | 'lang' | 'mounted' | 'nextRecordId' | 'notesRequest' | 'pendingUpdate' |
    'profileBlockRef' | 'recovery' | 'recoveryBusy' | 'recoveryKeep' | 'refreshInstalled' |
    'refreshNames' | 'repoHints' | 'repoIdentities' | 'restartHoldRef' | 'restarting' |
    'setActivationWarnings' | 'setActivations' | 'setAgentsConfirm' | 'setBlockError' |
    'setBlockNotice' | 'setBlockedNames' | 'setBrokenPlugins' | 'setBuildsSkipped' |
    'setClearingStale' | 'setCompatibilityNotice' | 'setDismissBrokenError' | 'setDismissingBroken' |
    'setFavoriteError' | 'setFavoriteUrls' | 'setHostIncompatible' | 'setHotNames' |
    'setInstallError' | 'setMigrationConfirm' | 'setNotes' | 'setNotesFor' | 'setNotesState' |
    'setNotingName' | 'setOperationsOpen' | 'setRecords' | 'setRecovery' | 'setRecoveryBusy' |
    'setRecoveryKeep' | 'setRecoveryOpen' | 'setRefreshNames' | 'setRemoveConfirm' |
    'setRemovedCount' | 'setRemovingName' | 'setRestartHold' | 'setRestartNames' | 'setRestarting' |
    'setRestoreBlocked' | 'setRestoreConfirm' | 'setStaleName' | 'setUpdateExemptError' |
    'setUpdateExemptNames' | 'setUpdateExemptNotice' | 'setUpdateNotes' | 'setUpdatedNames' |
    'setUpdatingName' | 'statusRef' | 't' | 'updateExemptNames' | 'updateExemptOpGen' |
    'updateIdleStrikes' | 'updates'>
  & Pick<MarketSyncCtx,
    'blockedNameSet' | 'favoriteUrlSet' | 'refreshRepairStatus' | 'rememberDrainMarker' |
    'updateExemptSet'>
  & Pick<MarketInstallCtx, 'doReplace' | 'favoriteStale'>

/** restart, cancel, source migration, notes, block and dismiss flows. */
export function useMarketOperations(c: MarketOperationsIn) {
  const {
    blockOpGen, blockedNameSet, blockedNames, bootId, bootIdRef, brokenPlugins, data,
    dismissBrokenGen, doReplace, favoriteOpGen, favoriteStale, favoriteUrlSet, favoriteUrls,
    hotNames, installed, installedReadGen, lang, mounted, nextRecordId, notesRequest, pendingUpdate,
    profileBlockRef, recovery, recoveryBusy, recoveryKeep, refreshInstalled, refreshNames,
    refreshRepairStatus, rememberDrainMarker, repoHints, repoIdentities, restartHoldRef, restarting,
    setActivationWarnings, setActivations, setAgentsConfirm, setBlockError, setBlockNotice,
    setBlockedNames, setBrokenPlugins, setBuildsSkipped, setClearingStale, setCompatibilityNotice,
    setDismissBrokenError, setDismissingBroken, setFavoriteError, setFavoriteUrls,
    setHostIncompatible, setHotNames, setInstallError, setMigrationConfirm, setNotes, setNotesFor,
    setNotesState, setNotingName, setOperationsOpen, setRecords, setRecovery, setRecoveryBusy,
    setRecoveryKeep, setRecoveryOpen, setRefreshNames, setRemoveConfirm, setRemovedCount,
    setRemovingName, setRestartHold, setRestartNames, setRestarting, setRestoreBlocked,
    setRestoreConfirm, setStaleName, setUpdateExemptError, setUpdateExemptNames,
    setUpdateExemptNotice, setUpdateNotes, setUpdatedNames, setUpdatingName, statusRef, t,
    updateExemptNames, updateExemptOpGen, updateExemptSet, updateIdleStrikes, updates,
  } = c
/**
   * Answer a clash. `keep` is not a no-op to skip: it is the user declining
   * the install, so the record retires rather than lingering as unanswered.
   */
  const resolveConflict = useCallback((record: OperationRecord, choice: 'keep' | 'swap') => {
    if (choice === 'keep') {
      setRecords(list => patchRecord(list, record.id, {
        state: 'failed', conflicts: undefined, reason: t('conflictDeclined'),
      }))
      return
    }
    const plugin = data?.plugins.find(candidate => candidate.url === record.url)
    if (plugin === undefined) return
    void doReplace(record, plugin)
  }, [data, doReplace, t])

  /**
   * Turn the recovery surface into the failure prompt.
   *
   * The banner keeps the host's own words for what happened (the parsed boot
   * failure), and the new option sits beside the other actions — the point of
   * the exercise is that a dead end now has a way out, not that the failure
   * is explained differently.
   */
  const enterRecovery = useCallback((view: RecoveryView) => {
    setRecovery(view)
    // The payload decides where the switches start (off for a blamed plugin);
    // this copies it rather than re-deriving it — see initialKeep.
    setRecoveryKeep(initialKeep(view))
    setRecoveryBusy(false)
    setRestarting(false)
    setInstallError(t('recoveryBanner') + (view.failure.summary || t('recoveryNoSummary')))
  }, [t])

  /**
   * Restart the host and reload once the boot id changes (#14 by @ysyyhhh).
   * The 202 races the process's SIGTERM, so network errors on the initial
   * request are expected and treated as "restart under way".
   *
   * A boot that never happens is now a first-class outcome rather than only a
   * timeout: the market's restart helper starts the recovery surface on this
   * same origin, so the poll below is how the tab that asked for the restart
   * finds out WHICH plugin stopped the boot and gets to switch it off.
   */
  const doRestart = useCallback(() => {
    // While the recovery surface is the thing answering this origin there is
    // no host to restart: the failure banner's "adjust plugins" is the action.
    if (bootId === null || restarting || recovery !== null) return
    const previousBoot = bootId
    setRestarting(true)
    setInstallError(null)
    setRecovery(null)
    // A shell that runs this host as its own child process owns the lifecycle:
    // it stops the process it started and relaunches its window. The helper
    // below would be a second lifecycle competing with it — two processes, one
    // port — so where the shell is there, ask it instead of spawning anything.
    const shellRestart = typeof window === 'undefined' ? undefined : window.__dshHostShell?.restart
    if (typeof shellRestart === 'function') {
      try {
        shellRestart()
        return
      } catch {
        // A shell that published the bridge and then threw is not a restart:
        // fall through to the host's own route, which is the pre-existing path.
      }
    }
    const awaitNewBoot = () => {
      const deadline = Date.now() + 60000
      const poll = () => {
        fetch(api('/dsh-market/status'), { cache: 'no-store' })
          .then(res => res.json())
          .then((next) => {
            if (next.recovery === true) {
              void fetchRecovery().then((view) => { if (view !== null) enterRecovery(view) })
              return
            }
            if (typeof next.boot === 'string' && next.boot !== previousBoot) {
              location.reload()
              return
            }
            retry()
          })
          .catch(retry)
      }
      const retry = () => {
        if (Date.now() > deadline) {
          // Last look before giving up on the clock: a failure that took the
          // helper's whole window to become a verdict lands right here.
          void fetchRecovery().then((view) => {
            if (view !== null) {
              enterRecovery(view)
              return
            }
            setRestarting(false)
            setInstallError(t('recoveryTimeout'))
          })
          return
        }
        setTimeout(poll, 1500)
      }
      poll()
    }
    const requestRestart = (attemptsLeft: number) => {
      fetch(api('/dsh-market/restart'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        .then(res => res.json().then(body => ({ status: res.status, body })))
        .then(({ status, body }) => {
          if (status === 202 && body.ok === true) {
            awaitNewBoot()
            return
          }
          // 409 = the install route still holds the operation lock for its
          // post-processing (#91) — a short quiet retry beats surfacing
          // "cannot restart while a plugin operation is running" to a user
          // who just followed our own banner.
          if (status === 409 && attemptsLeft > 0) {
            setTimeout(() => requestRestart(attemptsLeft - 1), 1500)
            return
          }
          setRestarting(false)
          setInstallError(t('restartFail') + ': ' + localizeBilingual(String(body.error || ('HTTP ' + String(status))), lang))
        })
        .catch(awaitNewBoot) // the host may die mid-response; keep polling
    }
    requestRestart(10)
  }, [bootId, restarting, recovery, t, lang, enterRecovery])

  /**
   * Write the chosen enable set through the recovery surface and wait for the
   * next boot. The write goes to the profile's patch layer — the same durable
   * mechanism the live toggles use — so the choice is what the loader applies
   * on every later start, not just this one.
   */
  const applyRecoveryChoice = useCallback(() => {
    if (recovery === null || recoveryBusy) return
    setRecoveryBusy(true)
    setInstallError(null)
    const enabled = Object.entries(recoveryKeep).filter(([, on]) => on).map(([name]) => name)
    void applyRecovery(enabled).then((result) => {
      if (!result.ok) {
        setRecoveryBusy(false)
        setInstallError(t('recoveryApplyFailed') + (result.error ?? ''))
        return
      }
      // The surface releases the port for the boot attempt, so a failure to
      // reach it from here on is expected — watchRestart treats that as
      // "still starting" rather than as an error.
      setRecoveryOpen(false)
      setRestarting(true)
      void watchRestart(recovery.bootId, {
        onBoot: () => { location.reload() },
        onRecovery: (view) => { enterRecovery(view); setRecoveryOpen(true) },
        onTimeout: () => {
          setRecoveryBusy(false)
          setRestarting(false)
          setInstallError(t('recoveryTimeout'))
        },
      })
    })
  }, [recovery, recoveryBusy, recoveryKeep, t, enterRecovery])

  /** Cancel the running plugin command (#6 by @qichuang321). */
  const doCancel = useCallback((record?: OperationRecord) => {
    const body = record?.hostOperationId === undefined ? {} : { operationId: record.hostOperationId }
    fetch(api('/dsh-market/cancel'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .catch(() => {})
  }, [])

  const doUpdate = useCallback((name: string, force = false, restore = false, compatVersion?: string, confirmAgentsRunning = false, eligibleVersion?: string, preferReject = false) => {
    const expectedVersion = compatVersion === undefined && !restore
      ? (eligibleVersion ?? updates[name]?.eligibleVersion) : undefined
    const updateOptions = { force, restore, compatVersion, eligibleVersion: expectedVersion }
    setInstallError(null)
    setActivationWarnings([])
    // Only THIS row's stale marker is cleared. "Update all" walks the list
    // calling straight into here, so an unconditional reset meant every
    // earlier release-age failure lost its retry button and only the last
    // one kept it — the rest failed silently with no way forward (#255).
    setStaleName(prev => (prev === name ? null : prev))
    setRestoreConfirm(prev => (prev?.name === name ? null : prev))
    setMigrationConfirm(null)
    setUpdatingName(name)
    updateIdleStrikes.current = 0
    // Mirror the install flow's dshm-pending marker: closing the config page
    // unmounts this section and drops `updatingName`, so the running row's
    // progress was lost on reopen. The marker survives the unmount and lets a
    // reopen restore the row while the status poll converges the outcome.
    sessionStorage.setItem('dshm-updating', JSON.stringify({ name }))
    // The Tasks panel exists to answer "what is running right now", and an
    // update is one of the things that runs. `OperationKind` has carried
    // 'update' since the panel was written; only the enqueue was missing, so
    // "update all" left the panel empty while several plugins were mid-flight
    // (#295 by @sanyecao88). One record per attempt, like the install flow.
    const updateRecordId = nextRecordId()
    const attempt = { recordId: updateRecordId, recovering: false }
    pendingUpdate.current = attempt
    setRecords(list => enqueue(list, { id: updateRecordId, kind: 'update', name, state: 'running', updateOptions }))
    return fetch(api('/dsh-market/update'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        ...(force ? { force: true } : {}),
        ...(restore ? { restore: true } : {}),
        ...(compatVersion !== undefined ? { compatVersion } : {}),
        ...(expectedVersion !== undefined ? { eligibleVersion: expectedVersion } : {}),
        ...(confirmAgentsRunning ? { confirmAgentsRunning: true } : {}),
        // `restore` is deliberately outside drain mode: a local-development
        // restore keeps its current wait/cancel guidance.
        ...(!restore && statusRef.current.agentDrain && !preferReject ? { busyPolicy: 'drain' } : {}),
      }),
    })
      .then(async res => {
        const body = await res.json()
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid update response')
        return { status: res.status, body }
      })
      .then(({ status, body }) => {
        // A response means the host settled the request (even a 4xx/5xx), so
        // the running row can hand back now. Only a lost response keeps the
        // marker + row for the poll to converge.
        if (pendingUpdate.current === attempt) {
          pendingUpdate.current = null
          sessionStorage.removeItem('dshm-updating')
          setUpdatingName(null)
        }
        if (status === 202 && typeof body.operationId === 'string') {
          const operation = body.operation as DrainOperationWire | undefined
          setRecords(list => patchRecord(withoutHostProjection(list, body.operationId, updateRecordId), updateRecordId, {
            state: 'queued',
            hostOperationId: body.operationId,
            ...(operation?.wait === null || operation?.wait === undefined
              ? {}
              : { blockedBy: operation.wait.activeAgentIds, waitSince: operation.wait.since }),
            reason: operation?.wait === null || operation?.wait === undefined
              ? t('agentBusyUpdateQueued')
              : t('agentDrainWaiting').replace('{0}', String(operation.wait.activeCount)),
          }))
          rememberDrainMarker({ operationId: body.operationId, kind: 'update', name })
          setOperationsOpen(true)
          return
        }
        if (body.cancelled === true) {
          setRecords(list => drop(list, updateRecordId))
          refreshInstalled()
          if (body.partial === true) setInstallError(t('partialNote'))
          return
        }
        // Another release in the profile is still inside the safety wait
        // (#1252): remember it so a batch stops here, and re-read the list so
        // every row shows the wait instead of an update that cannot start.
        const releaseBlocked = body.failureCode === 'PROFILE_RELEASE_BLOCKED' && body.profileBlocked !== null
          && typeof body.profileBlocked === 'object'
          ? body.profileBlocked as { name?: unknown; version?: unknown; readyAt?: unknown }
          : null
        if (releaseBlocked !== null && typeof releaseBlocked.name === 'string' && typeof releaseBlocked.version === 'string') {
          profileBlockRef.current = {
            name: releaseBlocked.name, version: releaseBlocked.version,
            readyAt: typeof releaseBlocked.readyAt === 'string' ? releaseBlocked.readyAt : null,
          }
          refreshInstalled(true)
        }
        // The host wants a restart before any further update (#1253). Not a
        // failure of this plugin: it is waiting like the rest, so it keeps its
        // row, says why, and the batch stops here.
        if (body.failureCode === 'RESTART_REQUIRED') {
          restartHoldRef.current = true
          setRestartHold({ boot: bootIdRef.current })
          setRecords(list => patchRecord(list, updateRecordId, { state: 'warned', reason: t('restartFirstNote') }))
          return
        }
        if (status === 409 && body.staleTarget === true) {
          setRecords(list => patchRecord(list, updateRecordId, { state: 'failed', reason: String(body.error ?? 'Update target changed') }))
          setInstallError(localizeBilingual(String(body.error ?? 'Update target changed'), lang))
          refreshInstalled(true)
          return
        }
        // The plugin is already on the version this update would install
        // (#495 by @Ztyss) — the list this row came from was taken before an
        // earlier round of the same batch moved it. Not a failure and not a
        // change: the row goes away, the list is re-read so the rest of it is
        // trustworthy too, and no restart is claimed, because nothing on disk
        // moved.
        if (status === 200 && body.ok && body.skipped === 'current') {
          setRecords(list => drop(list, updateRecordId))
          refreshInstalled(true)
          return
        }
        if (status === 200 && body.ok) {
          // The install worked, but no version could be pinned (#1047): both
          // registry lookups failed and pnpm chose the release itself. The ✓
          // stays, because the plugin IS on disk and usable; the note names
          // what actually arrived so the user can check it against what the
          // card now shows.
          const unverified = body.versionUnverified !== null && typeof body.versionUnverified === 'object'
            ? body.versionUnverified as { installed?: unknown }
            : null
          setRecords(list => patchRecord(list, updateRecordId, unverified === null
            ? { state: 'done' }
            : {
                state: 'warned',
                reason: typeof unverified.installed === 'string' && unverified.installed !== ''
                  ? t('versionUnverifiedNote').replace('{0}', unverified.installed)
                  : t('versionUnverifiedNoteUnknown'),
              }))
          setUpdatedNames(names => names.concat(name))
          // #558: the restart banner counts plugins the host parked behind a
          // restart, not every completed change. A client-only plugin comes
          // back 'inert'/'live' and goes live on refresh; when the host
          // reports no activation at all, count it to stay on the safe side.
          const activation = body.activation && typeof body.activation === 'object' ? body.activation[name] : undefined
          if (!activation || activation.state === 'restart') {
            setRestartNames(names => names.includes(name) ? names : names.concat(name))
          }
          if (body.activation && typeof body.activation === 'object') {
            setActivations(prev => ({ ...prev, ...body.activation }))
          }
          if (body.compatibility?.code === 'soft-incompatible') {
            setCompatibilityNotice(body.compatibility as CompatibilityNotice)
          }
          refreshInstalled()
        } else {
          if (body.unsupported === true) {
            // The Host lost the drain capability after the status sample;
            // retry once on the ordinary reject path (FR-9).
            setRecords(list => drop(list, updateRecordId))
            void doUpdate(name, force, restore, compatVersion, confirmAgentsRunning, eligibleVersion, true)
            return
          }
          // A wait is a failure with its own answer below, not a lock to queue behind.
          if (status === 409 && releaseBlocked === null) {
            if (body.failureCode === 'AGENT_BARRIER_LOST') {
              setRecords(list => patchRecord(list, updateRecordId, {
                state: 'failed',
                reason: String(body.error ?? 'An Agent became active before the update; nothing was changed.'),
              }))
              setOperationsOpen(true)
              return
            }
            if (body.targetChanged === true) {
              setRecords(list => patchRecord(list, updateRecordId, {
                state: 'failed',
                reason: String(body.error ?? 'Update target changed'),
              }))
              setInstallError(localizeBilingual(String(body.error ?? 'Update target changed'), lang))
              setOperationsOpen(true)
              return
            }
            if (body.agentsBusy === true) {
              // Same queue treatment as installs: the host refused before
              // touching pnpm, so this becomes a `queued` record the drain
              // runs when agents go idle — carrying the sessions that are
              // holding it, so the row can say why (#752).
              setRecords(list => patchRecord(list, updateRecordId, {
                state: 'queued',
                reason: t('agentBusyUpdateQueued'),
                blockedBy: blockedSessions(body),
              }))
              setOperationsOpen(true)
              return
            }
            // Same treatment as installs, and for the same reason: the lock
            // refusal happens before pnpm is touched, so it defers this update
            // rather than failing it. `queued` is also the only state the
            // durable queue keeps, so this is what lets the row outlive the
            // restart that ends the operation holding the lock.
            setRecords(list => patchRecord(list, updateRecordId, { state: 'queued' }))
            // `busy: true` means another operation is running — the official
            // Desktop manager's own install or repair can hold that state for
            // minutes. The queue's job then is to wait quietly: repeating the
            // banner on every 2s retry made the panel unusable and the log
            // grow while the market was doing exactly the right thing (#1140).
            if (body.busy === true) return
            setInstallError(t('queuedRunBusy'))
            setOperationsOpen(true)
            return
          }
          // The target's declared range excludes this host (#404, #1210).
          // Show the range and the running version so the user can choose.
          // Drop the row because the market refused before attempting the update.
          if (body.hostIncompatible && typeof body.hostIncompatible === 'object') {
            const notice = body.hostIncompatible as { name?: unknown; version?: unknown; requirement?: unknown; hostVersion?: unknown; npmName?: unknown }
            setRecords(list => drop(list, updateRecordId))
            setHostIncompatible({
              kind: 'update',
              name: String(notice.name ?? name),
              version: String(notice.version ?? ''),
              requirement: typeof notice.requirement === 'string' ? notice.requirement : null,
              hostVersion: typeof notice.hostVersion === 'string' ? notice.hostVersion : null,
              npmName: typeof notice.npmName === 'string' ? notice.npmName : null,
              plugin: null,
            })
            return
          }
          if (body.stale === true) setStaleName(name)
          // Blocked build scripts during an update (#69): same
          // approve-and-retry banner as the install flow, retrying the update.
          if (Array.isArray(body.ignoredBuilds) && body.ignoredBuilds.length > 0) {
            setBuildsSkipped({ updateName: name, names: body.ignoredBuilds.map(String), updateOptions })
          }
          const orphans = Array.isArray(body.orphanBundles) ? body.orphanBundles.map(String) : []
          const failure = failureText(body)
          // The profile will not boot as it stands (#339). Said FIRST, because
          // it outranks whatever else went wrong: a plugin that failed to
          // install is recoverable, a profile that cannot start is not — and
          // the user would otherwise meet it as a Node stack trace after the
          // next restart, with nothing linking it to this operation.
          // A stale catalog entry (#346) is said before pnpm's own wording,
          // which for that failure reads like the user broke something.
          const staleEntry = typeof body.staleEntry === 'string' ? body.staleEntry : null
          const detail = [
            orphans.length > 0 ? `${t('orphanBundle')} ${orphans.join(', ')}` : null,
            staleEntry,
            failure,
          ].filter(Boolean).join('\n')
          // Front-bounded for the same reason as the install row above (#848):
          // what is left here is our own bilingual sentence, and keeping its
          // last 600 characters kept the English and dropped the Chinese.
          const clipped = detail.trim().slice(0, 1200)
          setRecords(list => patchRecord(list, updateRecordId, { state: 'failed', reason: clipped,
            ...(Array.isArray(body.ignoredBuilds) && body.ignoredBuilds.length > 0 ? { blockedBuilds: body.ignoredBuilds.map(String) } : {}),
          }))
          // Localize the server half before prepending t() chrome.
          setInstallError((restore ? t('restoreFail') : t('updateFail')) + ': ' + name + ' — ' + localizeBilingual(clipped, lang))
        }
      })
      .catch(() => {
        // The host may still be writing. Keep the row until the status poll
        // confirms idle, and leave this attempt alone if the page was closed.
        if (pendingUpdate.current === attempt) pendingUpdate.current = { ...attempt, recovering: true }
      })
      .finally(() => {
        // A linked source switch can start its own recovery as the update ends.
        if (restore && mounted.current) void refreshRepairStatus()
      })
  }, [refreshInstalled, refreshRepairStatus, installed, rememberDrainMarker, t, lang, updates])


  const doSourceMigration = useCallback((name: string, confirmAgentsRunning = false, renameTo?: string) => {
    setInstallError(null)
    setActivationWarnings([])
    setMigrationConfirm(null)
    setUpdatingName(name)
    return fetch(api('/dsh-market/migrate-source'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        ...(renameTo === undefined ? {} : { kind: 'npm-rename', to: renameTo }),
        ...(confirmAgentsRunning ? { confirmAgentsRunning: true } : {}),
      }),
    })
      .then(res => res.json().then(body => ({ status: res.status, body })))
      .then(({ status, body }) => {
        setUpdatingName(null)
        if (status === 200 && body.ok === true) {
          const targetName = typeof body.to?.name === 'string' ? body.to.name : name
          setUpdatedNames(names => names.includes(targetName) ? names : names.concat(targetName))
          if (body.activation && typeof body.activation === 'object') {
            setActivations(prev => ({ ...prev, ...body.activation }))
          }
          refreshInstalled(true)
          const warnings = Array.isArray(body.warnings) ? body.warnings.map(String).filter(Boolean) : []
          if (warnings.length > 0) setInstallError(warnings.join('\n'))
          return
        }
        if (status === 409 && body.agentsBusy === true) {
          setAgentsConfirm({ name, kind: 'update', run: () => { void doSourceMigration(name, true, renameTo) } })
          return
        }
        setInstallError(t('migrateFail') + ': ' + localizeBilingual(String(body.error || ('HTTP ' + String(status))), lang))
      })
      .catch(error => {
        setUpdatingName(null)
        setInstallError(t('migrateFail') + ': ' + String(error))
      })
  }, [refreshInstalled, t, lang])

  const askSourceMigration = useCallback((name: string) => {
    const migration = updates[name]?.sourceMigration
    const source = installed[name]

    setStaleName(null)
    setRestoreConfirm(null)
    setRestoreBlocked(null)
    setInstallError(null)

    if (migration === undefined || source === undefined) {
      setMigrationConfirm(null)
      return
    }

    setMigrationConfirm({
      name,
      source: String(source),
      target: migration.target,
      kind: migration.kind,
    })
  }, [installed, updates])

  const askRestore = useCallback((name: string) => {
    if (data === null) return
    const spec = installed[name]
    if (spec === undefined) return
    const specText = String(spec)
    setStaleName(null)
    setMigrationConfirm(null)
    setRestoreBlocked(null)
    if (/^(?:link|file):/i.test(specText)) {
      const resolved = resolveCatalogRestore(
        data.plugins,
        name,
        repoIdentities[name] ?? [],
        repoHints[name] ?? [],
      )
      if (!resolved.ok) {
        setRestoreConfirm(null)
        setRestoreBlocked({ name, reason: resolved.reason })
        return
      }
      setRestoreConfirm({ name, entry: resolved.entry, verified: resolved.verified })
      return
    }
    const entry = entryForDep(data.plugins, name, specText, repoIdentities[name], repoHints[name])
    if (entry === undefined) {
      setRestoreConfirm(null)
      setRestoreBlocked({ name, reason: 'no-catalog' })
      return
    }
    // Not a local checkout: the entry was resolved from the install spec
    // itself, which names the source. Nothing was guessed from the name.
    setRestoreConfirm({ name, entry, verified: true })
  }, [data, installed, repoHints, repoIdentities])

  /** Open the update-notes dialog and start its fetch. Lazy: the request only
      exists while a user is actually looking at one plugin's notes, and
      closing the dialog abandons the render — the server side caches the
      payload, so reopening is cheap. */
  const openNotes = useCallback((name: string, current: string | null, latest: string | null, target: string | null, repoUrl: string | null) => {
    notesRequest.current?.abort()
    const request = new AbortController()
    notesRequest.current = request
    setNotesFor({ name, current, latest, target, repoUrl })
    setUpdateNotes(null)
    setNotesState('loading')
    // The Update button may install an older, mature version than the repo's
    // latest; ask for notes relative to that one (#1193).
    fetch(`${api('/dsh-market/changelog')}?name=${encodeURIComponent(name)}${target !== null ? `&target=${encodeURIComponent(target)}` : ''}`, { signal: request.signal })
      .then(res => res.json())
      .then(body => {
        if (request.signal.aborted) return
        setUpdateNotes(body as ResolvedNotes)
        setNotesState('ready')
      })
      .catch(() => { if (!request.signal.aborted) setNotesState('fail') })
  }, [])

  const closeNotes = useCallback(() => {
    notesRequest.current?.abort()
    notesRequest.current = null
    setNotesFor(null)
  }, [])

  const doUseSkin = useCallback((name: string) => {    setInstallError(null)
    fetch(api('/dsh-market/use-skin'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then(res => res.json().then(body => ({ status: res.status, body })))
      .then(({ status, body }) => {
        if (status === 200 && body.ok) {
          sessionStorage.setItem('dshm-toast', JSON.stringify([name]))
          sessionStorage.setItem('dshm-toast-mode', 'theme')
          sessionStorage.setItem('dshm-tab', 'themes')
          location.reload()
        } else {
          setInstallError(String(body.error || 'failed'))
        }
      })
      .catch(error => setInstallError(String(error)))
  }, [])

  /**
   * Forget a pending page-refresh for a plugin that is no longer here.
   *
   * The banner counts what the page has not caught up with. Install then
   * uninstall and the page is level again — there is nothing left to load —
   * but both sets were append-only, so it kept asking for a refresh that
   * would show nothing (#340). It conflated "something needs doing" with
   * "something happened in this session".
   */
  /** Write (or clear, when empty) this plugin's note. */
  const saveNote = useCallback((name: string, text: string) => {
    setNotingName(null)
    fetch(api('/dsh-market/note'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, text }),
    })
      .then(res => res.json())
      .then((body) => {
        if (body.ok && body.notes !== null && typeof body.notes === 'object') {
          setNotes(body.notes as Record<string, string>)
        } else setInstallError(String(body.error || 'note failed'))
      })
      .catch(error => setInstallError(String(error)))
  }, [])

  const toggleFavorite = useCallback((url: string) => {
    const gen = ++favoriteOpGen.current
    const favorited = !favoriteUrlSet.has(url)
    const previous = favoriteUrls
    setFavoriteError(null)
    setFavoriteUrls((list) => {
      if (favorited) return list.includes(url) ? list : [...list, url]
      return list.filter(entry => entry !== url)
    })
    fetch(api('/dsh-market/favorite'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, favorited }),
    })
      .then(async (res) => {
        const text = await res.text()
        let body: FavoriteReply | null = null
        if (text !== '') {
          try { body = JSON.parse(text) as FavoriteReply } catch { /* non-JSON */ }
        }
        return { status: res.status, body }
      })
      .then(({ status, body }) => {
        if (gen !== favoriteOpGen.current) return
        if (status === 200 && body?.ok === true && Array.isArray(body.favorites)) {
          setFavoriteUrls(body.favorites.filter((entry: unknown): entry is string => typeof entry === 'string'))
          return
        }
        setFavoriteUrls(previous)
        if (body === null && (status === 404 || status === 405)) {
          setFavoriteError(t('favoriteUnavailable'))
          return
        }
        if (status === 409) {
          setFavoriteError(t('favoriteBusy'))
          return
        }
        if (body?.code === 'FAVORITES_LIMIT_REACHED' && typeof body.limit === 'number') {
          setFavoriteError(t('favoriteLimitReached').replace('{0}', String(body.limit)))
          return
        }
        setFavoriteError(typeof body?.error === 'string' ? body.error : t('favoriteFailed'))
      })
      .catch((error: unknown) => {
        if (gen !== favoriteOpGen.current) return
        setFavoriteUrls(previous)
        setFavoriteError(String(error))
      })
  }, [favoriteUrlSet, favoriteUrls, t])

  const toggleBlock = useCallback((name: string) => {
    const gen = ++blockOpGen.current
    const nextBlocked = !blockedNameSet.has(name)
    const previous = blockedNames
    setBlockError(null)
    setBlockedNames((list) => {
      if (nextBlocked) return list.includes(name) ? list : [...list, name]
      return list.filter(entry => entry !== name)
    })
    fetch(api('/dsh-market/block'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, blocked: nextBlocked }),
    })
      .then(async (res) => {
        const text = await res.text()
        let body: { ok?: unknown; blocked?: unknown; error?: unknown } | null = null
        if (text !== '') {
          try { body = JSON.parse(text) as { ok?: unknown; blocked?: unknown; error?: unknown } } catch { /* non-JSON */ }
        }
        return { status: res.status, body }
      })
      .then(({ status, body }) => {
        if (gen !== blockOpGen.current) return
        if (status === 200 && body?.ok === true && Array.isArray(body.blocked)) {
          setBlockedNames(body.blocked.filter((entry: unknown): entry is string => typeof entry === 'string'))
          if (nextBlocked) setBlockNotice(t('blockMoved'))
          return
        }
        setBlockedNames(previous)
        setBlockError(typeof body?.error === 'string' ? body.error : t('blockFailed'))
      })
      .catch((error: unknown) => {
        if (gen !== blockOpGen.current) return
        setBlockedNames(previous)
        setBlockError(String(error))
      })
  }, [blockedNameSet, blockedNames, t])

  const toggleUpdateExempt = useCallback((name: string) => {
    const gen = ++updateExemptOpGen.current
    const nextExempt = !updateExemptSet.has(name)
    const previous = updateExemptNames
    setUpdateExemptError(null)
    setUpdateExemptNames((list) => {
      if (nextExempt) return list.includes(name) ? list : [...list, name]
      return list.filter(entry => entry !== name)
    })
    fetch(api('/dsh-market/update-exempt'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, exempt: nextExempt }),
    })
      .then(async (res) => {
        const text = await res.text()
        let body: { ok?: unknown; updateExempt?: unknown; error?: unknown } | null = null
        if (text !== '') {
          try { body = JSON.parse(text) as { ok?: unknown; updateExempt?: unknown; error?: unknown } } catch { /* non-JSON */ }
        }
        return { status: res.status, body }
      })
      .then(({ status, body }) => {
        if (gen !== updateExemptOpGen.current) return
        if (status === 200 && body?.ok === true && Array.isArray(body.updateExempt)) {
          setUpdateExemptNames(body.updateExempt.filter((entry: unknown): entry is string => typeof entry === 'string'))
          setUpdateExemptNotice(t(nextExempt ? 'updateExemptOn' : 'updateExemptOff'))
          return
        }
        setUpdateExemptNames(previous)
        setUpdateExemptError(typeof body?.error === 'string' ? body.error : t('updateExemptFailed'))
      })
      .catch((error: unknown) => {
        if (gen !== updateExemptOpGen.current) return
        setUpdateExemptNames(previous)
        setUpdateExemptError(String(error))
      })
  }, [updateExemptSet, updateExemptNames, t])

  /**
   * Stop showing one removed-declaration notice (#763).
   *
   * The notice is durable on purpose — it is the only thing left that says why
   * a plugin vanished — but the reporter's plugin was no longer in the catalog,
   * so the search it offered found nothing and the banner outlived every other
   * action. Hiding it says nothing about the plugin: the declaration stays
   * dropped and the directory stays where it is.
   *
   * Every step touches THIS name and nothing else, in both directions:
   *
   * - success removes this key and ignores the reply's map. That map is a
   *   snapshot from when the request ran, so adopting it wholesale would
   *   resurrect a notice another click had already dismissed, and would drop a
   *   record an `/installed` read reported while this was in flight — including
   *   one written by a failed update (#663), which is the one thing the notice
   *   exists for.
   * - failure puts THIS key back, and only if no `/installed` read has landed
   *   since: that read is the server's current truth and outranks a rollback
   *   built from what the panel happened to be showing.
   *
   * A dismiss that silently did nothing is worse than having no button: the
   * user would go on believing they had been told the truth about their profile.
   */
  const dismissBrokenPlugin = useCallback((name: string) => {
    const record = brokenPlugins[name]
    if (record === undefined) return
    const gens = dismissBrokenGen.current
    const gen = (gens.get(name) ?? 0) + 1
    gens.set(name, gen)
    const readAtRequest = installedReadGen.current
    setDismissBrokenError(null)
    setDismissingBroken(current => new Set(current).add(name))
    // Optimistic; the failure path below puts this one key back.
    setBrokenPlugins((current) => {
      if (current[name] === undefined) return current
      const next = { ...current }
      delete next[name]
      return next
    })
    /** This request's own failure, applied to this one name only. */
    const restore = (reason: string) => {
      // A later click on the same row owns this name now; that one reports its
      // own outcome, and reporting this one too would be two answers to one
      // question.
      if (dismissBrokenGen.current.get(name) !== gen) return
      // An `/installed` read landed meanwhile, so the panel is showing the
      // server's current truth and this rollback — built from what the panel
      // happened to be holding — would only argue with it. Skipping the record
      // does NOT skip the message: the dismiss failed, the user is owed that.
      if (installedReadGen.current === readAtRequest) {
        setBrokenPlugins(current => (
          current[name] === undefined ? { ...current, [name]: record } : current
        ))
      }
      setDismissBrokenError(reason)
    }
    fetch(api('/dsh-market/dismiss-broken'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then(async (res) => {
        const text = await res.text()
        let body: DismissBrokenReply | null = null
        if (text !== '') {
          try { body = JSON.parse(text) as DismissBrokenReply } catch { /* non-JSON */ }
        }
        return { status: res.status, body }
      })
      .then(({ status, body }) => {
        if (status === 200 && body?.ok === true) {
          // Said again, idempotently, and only for this name. The optimistic
          // removal can have been undone by an `/installed` read that was
          // already in flight when the click happened: it is a snapshot from
          // before, so it still carries the notice, and it lands after. The
          // server has now confirmed the record is gone, so the panel says so
          // too — otherwise it would show a notice the server no longer has,
          // with no error to explain it. Never the reply's whole map: that is
          // older than anything the panel has learned since.
          if (dismissBrokenGen.current.get(name) !== gen) return
          setBrokenPlugins((current) => {
            if (current[name] === undefined) return current
            const next = { ...current }
            delete next[name]
            return next
          })
          return
        }
        restore(typeof body?.error === 'string' ? body.error : t('toggleFail'))
      })
      .catch((error: unknown) => { restore(String(error)) })
      .finally(() => {
        setDismissingBroken(current => {
          const next = new Set(current)
          next.delete(name)
          return next
        })
      })
  }, [brokenPlugins, t])

  const clearStaleFavorites = useCallback(() => {
    if (favoriteStale.length === 0) return
    const gen = ++favoriteOpGen.current
    const stale = favoriteStale
    const previous = favoriteUrls
    setFavoriteError(null)
    setClearingStale(true)
    setFavoriteUrls(list => list.filter(url => !stale.includes(url)))
    void (async () => {
      try {
        let latest: string[] | null = null
        for (const url of stale) {
          const res = await fetch(api('/dsh-market/favorite'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url, favorited: false }),
          })
          const text = await res.text()
          let body: { ok?: unknown; favorites?: unknown; error?: unknown } | null = null
          if (text !== '') {
            try { body = JSON.parse(text) as { ok?: unknown; favorites?: unknown; error?: unknown } } catch { /* non-JSON */ }
          }
          if (res.status === 200 && body?.ok === true && Array.isArray(body.favorites)) {
            latest = body.favorites.filter((entry: unknown): entry is string => typeof entry === 'string')
            continue
          }
          if (gen !== favoriteOpGen.current) return
          setFavoriteUrls(previous)
          if (res.status === 409) setFavoriteError(t('favoriteBusy'))
          else setFavoriteError(typeof body?.error === 'string' ? body.error : t('favoriteFailed'))
          return
        }
        if (gen !== favoriteOpGen.current) return
        if (latest !== null) setFavoriteUrls(latest)
      } catch (error: unknown) {
        if (gen !== favoriteOpGen.current) return
        setFavoriteUrls(previous)
        setFavoriteError(String(error))
      } finally {
        if (gen === favoriteOpGen.current) setClearingStale(false)
      }
    })()
  }, [favoriteStale, favoriteUrls, t])

  const clearPendingRefresh = useCallback((name: string) => {
    setHotNames(names => names.filter(entry => entry !== name))
    setRefreshNames(names => names.filter(entry => entry !== name))
  }, [])

  const doUninstall = useCallback((name: string, confirmAgentsRunning = false, preferReject = false) => {
    setRemoveConfirm(null)
    setInstallError(null)
    setActivationWarnings([])
    setRemovingName(name)
    // Uninstalls join the same operation records as installs/updates, so an
    // agents-busy refusal can queue them and the drain can run them later.
    const uninstallRecordId = nextRecordId()
    setRecords(list => enqueue(list, { id: uninstallRecordId, kind: 'uninstall', name, state: 'running' }))
    return fetch(api('/dsh-market/uninstall'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        ...(confirmAgentsRunning ? { confirmAgentsRunning: true } : {}),
        ...(statusRef.current.agentDrain && !preferReject ? { busyPolicy: 'drain' } : {}),
      }),
    })
      .then(res => res.json().then(body => ({ status: res.status, body })))
      .then(({ status, body }) => {
        if (status === 202 && typeof body.operationId === 'string') {
          const operation = body.operation as DrainOperationWire | undefined
          setRecords(list => patchRecord(withoutHostProjection(list, body.operationId, uninstallRecordId), uninstallRecordId, {
            state: 'queued',
            hostOperationId: body.operationId,
            ...(operation?.wait === null || operation?.wait === undefined
              ? {}
              : { blockedBy: operation.wait.activeAgentIds, waitSince: operation.wait.since }),
            reason: operation?.wait === null || operation?.wait === undefined
              ? t('agentBusyUninstallQueued')
              : t('agentDrainWaiting').replace('{0}', String(operation.wait.activeCount)),
          }))
          rememberDrainMarker({ operationId: body.operationId, kind: 'uninstall', name })
          setOperationsOpen(true)
          return
        }
        if (body.unsupported === true) {
          // The Host lost the drain capability after the status sample;
          // retry once on the ordinary reject path (FR-9).
          setRecords(list => drop(list, uninstallRecordId))
          void doUninstall(name, confirmAgentsRunning, true)
          return
        }
        if (status === 409 && body.failureCode === 'AGENT_BARRIER_LOST') {
          setRecords(list => patchRecord(list, uninstallRecordId, {
            state: 'failed',
            reason: String(body.error ?? 'An Agent became active before the uninstall; nothing was changed.'),
          }))
          setOperationsOpen(true)
          return
        }
        if (status === 409 && body.targetChanged === true) {
          setRecords(list => patchRecord(list, uninstallRecordId, {
            state: 'failed',
            reason: String(body.error ?? t('installFail')),
          }))
          setOperationsOpen(true)
          return
        }
        if (status === 409 && body.agentsBusy === true) {
          setRecords(list => patchRecord(list, uninstallRecordId, {
            state: 'queued',
            reason: t('agentBusyUninstallQueued'),
            blockedBy: blockedSessions(body),
          }))
          setOperationsOpen(true)
          return
        }
        setRecords(list => drop(list, uninstallRecordId))
        if (status === 200 && body.ok) {
          if (!body.hot) setRemovedCount(n => n + 1)
          // A client-part plugin stays injected until a page reload — the same
          // pending-refresh banner as enable/disable tells the user to reload,
          // instead of silently leaving the uninstalled plugin's UI running.
          //
          // But only when it was live in THIS page. A plugin installed during
          // this session was never injected: the banner was asking the user to
          // reload in order to GET it, so undoing the install nets to zero and
          // the banner must go (#340 — "it was reporting session history, not
          // pending work"). Being already pending is exactly what distinguishes
          // the two, and the server cannot see it: `refresh` says the package
          // HAD a client part, not that this page ever loaded it.
          const neverLoadedHere = hotNames.includes(name) || refreshNames.includes(name)
          if (body.refresh === true && !neverLoadedHere) {
            setRefreshNames(names => names.includes(name) ? names : names.concat(name))
          } else clearPendingRefresh(name)
          refreshInstalled()
        } else {
          if (body.cancelled === true) {
            refreshInstalled()
            if (body.partial === true) setInstallError(t('partialNote'))
            return
          }
          // Half-uninstall reconcile: the package is gone and the server has
          // already converged the manifest to disk truth. Refresh so the card
          // leaves the list instead of luring the user into a retry that
          // would 400 on "not installed"; the note separates the outcome
          // (removed, profile synced) from the process (pnpm errored).
          if (body.reconciled === true) {
            if (!body.hot) setRemovedCount(n => n + 1)
            clearPendingRefresh(name)
            refreshInstalled()
            setInstallError(t('reconciledNote'))
            return
          }
          setInstallError(failureText(body, { fallback: 'error' }).trim())
        }
      })
      .catch(error => setInstallError(String(error)))
      .finally(() => setRemovingName(null))
    // hotNames/refreshNames are read above to tell a plugin this page loaded
    // from one installed inside it, so they belong in the closure.
  }, [refreshInstalled, hotNames, refreshNames, nextRecordId, rememberDrainMarker, t])
  return {
    applyRecoveryChoice, askRestore, askSourceMigration, clearPendingRefresh, clearStaleFavorites,
    closeNotes, dismissBrokenPlugin, doCancel, doRestart, doSourceMigration, doUninstall, doUpdate,
    doUseSkin, openNotes, resolveConflict, saveNote, toggleBlock, toggleFavorite, toggleUpdateExempt,
  } as const
}

export type MarketOperationsCtx = ReturnType<typeof useMarketOperations>
