/**
 * Pure helpers for the Market section: backup/installed parsing, local-path and update-eligibility checks, migration copy, small storage flags.
 */

import { SIDEBAR_TIP_KEY, WEBDAV_STORAGE_KEY } from './market-constants.ts'
import {
  displayLatest,
  type InstalledMap,
  type InstalledRepoHints,
  type InstalledRepoIdentities,
  isGenerationSpec,
  marketHeldVersionText,
  type Translate,
  type UpdateStatus,
} from './market-data.ts'
import type { SourceMigrationConfirm } from './market-types.ts'
import type { OperationRecord } from './operations.ts'

export function savedWebdav(): { url: string; username: string; password: string; auto: boolean } {
  try {
    const value = JSON.parse(localStorage.getItem(WEBDAV_STORAGE_KEY) ?? '{}') as Record<string, unknown>
    return {
      url: typeof value.url === 'string' ? value.url : '',
      username: typeof value.username === 'string' ? value.username : '',
      // The password never persists in the browser: plugins run same-origin
      // with dshmarket, so a stored password would be readable by any plugin
      // client on this host and become the weakest credential in the profile
      // (review #63). It lives in server config / memory only.
      password: '',
      auto: value.auto === true,
    }
  } catch {
    return { url: '', username: '', password: '', auto: false }
  }
}

export function backupDependencies(value: unknown): InstalledMap {
  if (value === null || typeof value !== 'object') throw new Error('invalid backup')
  const backup = value as { format?: unknown; version?: unknown; files?: unknown }
  if (backup.format !== 'dsh-profile-backup' || backup.version !== 0.2) throw new Error('unsupported backup format')
  const files = backup.files
  if (!Array.isArray(files)) throw new Error('unsupported backup format')
  const manifest = files.find(file => file !== null && typeof file === 'object' && (file as { path?: unknown }).path === 'package.json') as { json?: unknown } | undefined
  if (manifest?.json === null || typeof manifest?.json !== 'object' || Array.isArray(manifest.json)) throw new Error('backup package.json is invalid')
  const dependencies = (manifest.json as { dependencies?: unknown }).dependencies
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) return {}
  if (!Object.values(dependencies).every(spec => typeof spec === 'string')) throw new Error('backup dependencies are invalid')
  return dependencies as InstalledMap
}

export function installedRepoIdentities(value: unknown): InstalledRepoIdentities {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const identities: InstalledRepoIdentities = {}
  for (const [name, ids] of Object.entries(value)) {
    if (!Array.isArray(ids)) continue
    const strings = ids.filter((id): id is string => typeof id === 'string')
    if (strings.length > 0) identities[name] = strings
  }
  return identities
}

export function installedRepoHints(value: unknown): InstalledRepoHints {
  return installedRepoIdentities(value)
}

export function installedMap(value: unknown): InstalledMap {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const installed: InstalledMap = {}
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec === 'string') installed[name] = spec
  }
  return installed
}

/** Optional /installed metadata: older hosts omit it, malformed values are not text. */
export function localDescriptionsFromUnknown(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const descriptions: Record<string, string> = {}
  for (const [name, description] of Object.entries(value)) {
    if (typeof description === 'string' && description.trim() !== '') descriptions[name] = description.trim()
  }
  return descriptions
}

/** A `{name: {...}}` map, or anything else — for untyped server fields. */
export function isRecordOfRecords(value: unknown): value is Record<string, { spec?: string; reason?: string }> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isInstalledSnapshot(value: unknown): value is InstalledMap {
  return isRecordOfRecords(value) && Object.values(value).every(spec => typeof spec === 'string')
}

function isUpdateStatus(value: unknown): value is UpdateStatus {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const status = value as UpdateStatus
  return typeof status.updateAvailable === 'boolean'
    && (status.checkFailed === undefined || status.checkFailed === true)
    && (status.checkError === undefined || status.checkError === 'unavailable')
    && (status.kind === undefined || typeof status.kind === 'string')
    && (status.version === undefined || status.version === null || typeof status.version === 'string')
    && (status.latest === undefined || status.latest === null || typeof status.latest === 'string')
    && (status.current === undefined || status.current === null || typeof status.current === 'string')
    && (status.compatibleVersion === undefined || typeof status.compatibleVersion === 'string')
    && (status.hostUpdateBlocked === undefined || (status.hostUpdateBlocked !== null
      && typeof status.hostUpdateBlocked.version === 'string' && typeof status.hostUpdateBlocked.hostVersion === 'string'
      && (typeof status.hostUpdateBlocked.requirement === 'string' || status.hostUpdateBlocked.requirement === null)))
}

export function readUpdateStatuses(body: unknown): Record<string, UpdateStatus> {
  const updates = (body as { updates?: unknown } | null)?.updates
  if (!isRecordOfRecords(updates) || !Object.values(updates).every(isUpdateStatus)) {
    throw new Error('Invalid update list')
  }
  return updates as Record<string, UpdateStatus>
}

export function sameInstalledMap(left: InstalledMap, right: InstalledMap): boolean {
  const names = Object.keys(left)
  return names.length === Object.keys(right).length && names.every(name => left[name] === right[name])
}

/** Describe the pending release separately from any version the update button can install. */
export function marketWaitTip(
  held: NonNullable<UpdateStatus['heldUpdate']>,
  eligible: string | null,
  locale: string,
  t: Translate,
): string {
  const pending = marketHeldVersionText(held, locale, t)
  if (eligible === null) return pending
  const ready = t('marketVersionAvailableNow').replace('{0}', displayLatest(eligible))
  return `${ready} · ${pending}`
}

/** Compact held-wait for the trailing row (clock + short label); version/reason in title. */
export function heldUpdateBeside(
  held: { latest: string; until: string; estimated?: true },
  t: (key: string) => string,
): { label: string; title: string } {
  const left = Date.parse(held.until) - Date.now()
  const estimated = held.estimated === true
  const known = Number.isFinite(left) && left > 0
  const amount = known
    ? String(Math.max(1, Math.ceil(left / (estimated ? 60_000 : 3_600_000))))
    : ''
  const label = !known
    ? t('updateHeldBesideUnknown')
    : estimated
      ? t('updateHeldBesideEstimated').replace('{1}', amount)
      : t('updateHeldBeside').replace('{1}', amount)
  const reason = !known
    ? t('updateHeldBesideUnknown')
    : t(estimated ? 'updateHeldEstimatedHint' : 'updateHeldHint').replace('{1}', amount)
  const title = `${displayLatest(held.latest)} · ${reason}`
  return { label, title }
}

/** The tail of a local checkout path; the full path stays in the title and the copy button. */
export function shortLocalPath(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? path : '…/' + parts.slice(-2).join('/')
}

/** A relative spec is resolved against the profile directory, so copying it elsewhere is meaningless. */
export function isAbsoluteLocalPath(path: string): boolean {
  return /^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(path)
}

/** `file:///abs` keeps one leading slash, like `file:/abs`. */
export function localPathOf(spec: string): string | null {
  const match = /^(?:link|file):(?:\/\/(?=\/))?(.+)$/i.exec(spec)
  return match !== null ? match[1] : null
}

/**
 * A development checkout or local package. A generation is the desktop host's
 * own install (#497) and is never one, even though its spec is a link:.
 */
export function isLocalDev(spec: string, status: UpdateStatus | undefined): boolean {
  if (status?.kind === 'generation' || isGenerationSpec(spec)) return false
  return /^(?:link|file):/i.test(spec) || status?.kind === 'linked'
}

/**
 * Whether one installed plugin has a pending update (either an ordinary
 * upgrade via npm/git/restore, or a host-managed generation release), and has
 * not already been updated in the current session.
 *
 * THE answer to that question. It used to have three copies that disagreed —
 * the reminder count, the card's pill, and the installed list's ordering —
 * which is the shape this repository already paid for once
 * (`src/entry-identity.ts`: one assumption, several copies, each fixed at a
 * different time). Callers now pass the two things that are genuinely their
 * own policy:
 *
 * - `ignored`: a session-level "ignore this update" (#657). The NOTICE
 *   surfaces pass it — the badge and the ordering, because a row the user
 *   dismissed should not keep jumping to the top or counting toward
 *   attention. The row's own pill does NOT, because the pill answers "is
 *   there an update" (which dismissing does not change) and the row shows the
 *   dismissal right beside it.
 * - whether a disabled plugin counts, which the reminder count says no to and
 *   the list says yes to: a disabled row is still a row someone may want to
 *   update from the list, but it is not asking for attention.
 */
export function isPluginUpdatable(
  name: string,
  spec: string,
  status: UpdateStatus | undefined,
  updatedNames: readonly string[],
  ignored: ReadonlySet<string> = new Set<string>(),
): boolean {
  if (updatedNames.includes(name) || ignored.has(name) || status === undefined) return false
  if (status.updateAvailable === true) return true
  const generation = status.kind === 'generation' || isGenerationSpec(spec)
  return generation && status.latest != null
}

/**
 * What the two moves say (#1012). Same dialog and same transaction, so the
 * difference belongs in one branch rather than a ternary per line.
 */
export function sourceMigrationCopy(confirm: SourceMigrationConfirm, t: (key: string) => string) {
  if (confirm.kind === 'npm-rename') {
    return {
      title: t('renameTitle'),
      description: t('renameDescription'),
      confirmLabel: t('renameContinue'),
      currentLabel: t('renameCurrentPackage'),
      targetLabel: t('renameTargetPackage'),
      note: t('renameWarning'),
      // Reassurance, not a warning: a rename cannot touch what the plugin
      // saved itself, and painting that as a warning is the #4 relapse.
      noteTone: 'plain' as const,
    }
  }
  return {
    title: t('migrateTitle'),
    description: t('migrateDescription'),
    confirmLabel: t('migrateContinue'),
    currentLabel: t('migrateCurrentSource'),
    targetLabel: t('migrateTargetSource'),
    note: t('migrateWarning'),
    noteTone: 'warning' as const,
  }
}

/**
 * The sessions a host 409 named as blocking (#752).
 *
 * The agent guard refuses before it touches pnpm and answers with the sessions
 * that are running. Keeping them on the record is what lets a queued row say
 * WHY it is not moving: a queue entry with no reason reads as an operation
 * that is merely last in line, and "it never starts" is what the user reports.
 *
 * @returns the session names, or undefined when the host named none.
 */
export function blockedSessions(body: { runningAgents?: unknown }): string[] | undefined {
  if (!Array.isArray(body.runningAgents)) return undefined
  const names = body.runningAgents.map(String).filter(name => name !== '')
  return names.length === 0 ? undefined : names
}

/**
 * Drop a Host-projected row before the page's own record adopts the same
 * operation id (#411).
 *
 * The status poll can create `host-<id>` while a slow probe is still running;
 * without this the 202 would leave both rows pointing at one Host operation,
 * and the panel's first match would keep the synthetic one forever.
 */
export function withoutHostProjection(
  list: readonly OperationRecord[],
  operationId: string,
  keepId: string,
): OperationRecord[] {
  return list.filter(record =>
    record.id === keepId
    || (record.id !== `host-${operationId}` && record.hostOperationId !== operationId))
}

export function readRecentFlag(key: string): boolean {
  try { return localStorage.getItem(key) === '1' } catch { return false }
}
export function writeRecentFlag(key: string, next: boolean): void {
  try { localStorage.setItem(key, next ? '1' : '0') } catch { /* storage unavailable — the choice just won't survive a reload */ }
}

export function readSidebarTipDismissed(): boolean {
  try { return localStorage.getItem(SIDEBAR_TIP_KEY) === '1' } catch { return false }
}
export function writeSidebarTipDismissed(): void {
  try { localStorage.setItem(SIDEBAR_TIP_KEY, '1') } catch { /* private mode: the tip can return */ }
}
