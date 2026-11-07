/**
 * What DSH's own fatal recovery leaves behind (#875).
 *
 * When a boot fails, the desktop shell offers a recovery prompt. Using it
 * runs `sanitizeProfile` in `@deepseek-ai/dsh-app-boot`, and that does not
 * edit the profile patch — it renames `cordis.patch.yml` to a
 * `<patch>.bak-<epoch ms>` sibling, writes a small default stub in its place,
 * and restores the bundle list it was handed. The app then comes up normally,
 * so from the outside there is no error at all: the stub looks exactly like a
 * patch that never had content, and the backup is an unlabelled file sitting
 * next to it with no timestamp a person would read. In the report that found
 * this, 22 KB of providers, models, model defaults and permission presets
 * vanished that way and nothing on screen said so.
 *
 * DSH core is the one destroying data, and the fix for that belongs upstream
 * (never overwrite a patch that has content; keep an unticked entry as a
 * disabled row instead of dropping it from `dsh.profile.bundles`). But the
 * promise the user was acting on is this page's — the market's own recovery
 * surface is the documented way back to a booting app — so the market carries
 * the detection and the way back.
 *
 * The shape this looks for is deliberately narrow: a sibling named exactly
 * `<patch name>.bak-<digits>`, holding rows, LARGER than the live patch, and
 * naming rows the live patch no longer has. A hand-edited file, the market's
 * own `.bak` shapes (`package.json.bak-asm` and friends), an older backup, or
 * a patch that simply lost a row are all outside this surface — the point is
 * to speak up only when the evidence is unambiguous, because a false alarm
 * here trains the user to ignore the one that matters.
 */

import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { readUserPatchState } from './patch.ts'
import { createProfileSnapshot, DEFAULT_MAX_SNAPSHOTS, type SnapshotCaptureResult } from './snapshot.ts'

/**
 * The host's backup name: `<anything>.bak-<epoch ms>`. The stamp is what the
 * name carries, so it is read from there rather than from mtime — a copy or a
 * restore tool rewrites mtime, and `Date.now()` in the host's own
 * `sanitizeProfile` is what produced this name.
 */
const BACKUP_NAME_RE = /^(.+)\.bak-(\d{10,16})$/u

/** One `.bak-<epoch ms>` sibling of the profile patch. */
export interface HostRecoveryBackup {
  /** File name as it sits next to the patch. */
  name: string
  /** Epoch ms parsed out of the name, or null when the name is not the host's shape. */
  stamp: number | null
  bytes: number
  /** Row ids the backup carries (insert titles and toggled rows). */
  rowIds: string[]
}

/** What the profile patch looks like now, next to what the backups still hold. */
export interface HostRecoveryView {
  /** The live patch's file name, for the wording. */
  patchName: string
  currentBytes: number
  currentRowIds: string[]
  /** Newest first, and only backups that carry rows — a stub is not a restore point. */
  backups: HostRecoveryBackup[]
  /** Row ids the newest backup carries and the live patch no longer does. */
  lostRowIds: string[]
  /**
   * True only for the wipe shape: a backup with rows exists, the live patch is
   * the smaller file, and rows it used to have are gone. Everything the UI
   * says hangs off this, so it stays conservative.
   */
  offerRestore: boolean
}

/** Row ids a patch file declares, in any of the three shapes the market writes. */
function patchRowIds(patchPath: string): string[] {
  const state = readUserPatchState(patchPath)
  return [...new Set([...state.inserts, ...state.disables, ...state.forced])]
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/**
 * Read the profile's recovery state. Never throws: a profile the market
 * cannot read is a profile with nothing to offer, not a broken request.
 */
export function readHostRecoveryView(patchPath: string): HostRecoveryView {
  const patchName = basename(patchPath)
  const directory = dirname(patchPath)
  const currentBytes = sizeOf(patchPath)
  const currentRowIds = patchRowIds(patchPath)

  let names: string[] = []
  try {
    names = readdirSync(directory)
  } catch { /* unreadable directory — no candidates */ }

  const backups: HostRecoveryBackup[] = []
  for (const name of names) {
    const match = BACKUP_NAME_RE.exec(name)
    if (match === null || match[1] !== patchName) continue
    const path = join(directory, name)
    const rowIds = patchRowIds(path)
    // A file with no rows holds no configuration; listing it as a restore
    // point would only invite the user to restore nothing.
    if (rowIds.length === 0) continue
    backups.push({ name, stamp: Number(match[2]), bytes: sizeOf(path), rowIds })
  }
  backups.sort((left, right) => (right.stamp ?? 0) - (left.stamp ?? 0))

  const newest = backups[0]
  const lostRowIds = newest === undefined
    ? []
    : newest.rowIds.filter(id => !currentRowIds.includes(id))
  return {
    patchName,
    currentBytes,
    currentRowIds,
    backups,
    lostRowIds,
    offerRestore: newest !== undefined && lostRowIds.length > 0 && currentBytes < newest.bytes,
  }
}

/** The outcome of putting one backup back. */
export type HostRecoveryRestoreResult =
  | {
    ok: true
    /** The snapshot taken before the write, so this is undoable from the UI. */
    snapshot: string | null
    restored: { name: string; bytes: number; rows: number }
  }
  | { ok: false; error: string }

/**
 * Put one backup back in place of the live patch.
 *
 * Three things happen in order, and each one is there for a reason:
 *
 * 1. a profile snapshot, so the restore is undoable the same way every other
 *    write on this page is (issue #98);
 * 2. the backup's bytes are written to a temp file first, so a write that
 *    fails leaves the live patch where it was, and an interrupted one cannot
 *    leave a half patch behind, which is the one outcome that would not boot;
 * 3. the live patch is RENAMED, never deleted — it is what the app is running
 *    with right now, and a user who restores the wrong backup must still find
 *    it there — and the temp file is renamed into its place. If that last
 *    rename fails, the live patch is moved back.
 *
 * The backup file itself is left where it is: it is the other copy of the
 * user's configuration, and this function has no business being the last
 * thing that ever held it.
 */
export function restoreHostRecoveryBackup(
  patchPath: string,
  profileDir: string,
  name: string,
  maxSnapshots: number = DEFAULT_MAX_SNAPSHOTS,
): HostRecoveryRestoreResult {
  const view = readHostRecoveryView(patchPath)
  // The name is matched against the re-derived list, never used as a path.
  // Everything reaching the filesystem is a name this function just read off
  // the directory, so no caller input can steer a write.
  const backup = view.backups.find(entry => entry.name === name)
  if (backup === undefined) return { ok: false, error: `找不到备份 ${name}，它可能已经被移走或改名了。 / no such backup: ${name}` }

  const backupPath = join(dirname(patchPath), backup.name)
  let contents: Buffer
  try {
    contents = readFileSync(backupPath)
  } catch (error) {
    return { ok: false, error: `读不到备份 ${backup.name}：${messageOf(error)} — 文件可能没有权限或被占用。 / could not read the backup: ${messageOf(error)}` }
  }

  const captured: SnapshotCaptureResult = createProfileSnapshot(profileDir, maxSnapshots)
  if (!captured.ok) {
    // Refusing here is the honest failure: without a snapshot, this write
    // would be the only one on the page with no way back.
    return { ok: false, error: `恢复前没能存下快照，所以这次没有改动配置：${String(captured.error)} / refused to write without a snapshot: ${String(captured.error)}` }
  }

  // The temp file is written BEFORE the live patch moves: a write that fails
  // on a full disk or a file held by antivirus must leave the profile with
  // the patch it is running, not with none.
  const temp = `${patchPath}.restore-${process.pid}`
  const dropTemp = (): void => {
    try { rmSync(temp, { force: true }) } catch { /* not ours to remove (a directory) */ }
  }
  try {
    writeFileSync(temp, contents)
  } catch (error) {
    dropTemp()
    return { ok: false, error: `写入失败，所以这次没有改动：${messageOf(error)} / could not write the patch, nothing was changed: ${messageOf(error)}` }
  }
  let movedAside: string | null = null
  if (existsSync(patchPath)) {
    movedAside = `${patchPath}.bak-${Date.now()}`
    try {
      renameSync(patchPath, movedAside)
    } catch (error) {
      dropTemp()
      return { ok: false, error: `当前配置没能先改名保留，所以这次没有改动：${messageOf(error)} / could not move the current patch aside: ${messageOf(error)}` }
    }
  }
  try {
    renameSync(temp, patchPath)
  } catch (error) {
    dropTemp()
    if (movedAside !== null) {
      try {
        renameSync(movedAside, patchPath)
      } catch {
        return { ok: false, error: `写入失败，原配置留在 ${basename(movedAside)}：${messageOf(error)} / could not write the patch; the previous one is at ${basename(movedAside)}: ${messageOf(error)}` }
      }
    }
    return { ok: false, error: `写入失败，所以这次没有改动：${messageOf(error)} / could not write the patch, nothing was changed: ${messageOf(error)}` }
  }
  return {
    ok: true,
    snapshot: captured.snapshot?.id ?? null,
    restored: { name: backup.name, bytes: contents.length, rows: backup.rowIds.length },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
