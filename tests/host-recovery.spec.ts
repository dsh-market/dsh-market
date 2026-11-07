/**
 * #875: DSH's fatal recovery renames the profile patch to a `.bak-<epoch ms>`
 * sibling and writes a stub, then boots normally. These tests pin the two
 * halves of the market's answer — the shape it is willing to call a wipe, and
 * the restore that puts the user's file back without becoming a second way to
 * lose it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readHostRecoveryView, restoreHostRecoveryBackup } from '../src/host-recovery.ts'
import { listSnapshots } from '../src/snapshot.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** A user patch with three rows — the shape #875 lost 22 KB of. */
const USER_PATCH = [
  '- insert:',
  '    - id: llm-deepseek',
  '    - id: agent-default-model',
  '- id: permission',
  '  disabled: false',
  '',
].join('\n')

/** The stub `sanitizeProfile` writes in its place. */
const STUB = '# recovered by DSH\n'

/** The host's own backup name: `<patch name>.bak-<epoch ms>`. */
const STAMP = 1_792_065_596_554

function profile(options: { patch?: string | null; packageJson?: string | null; backup?: string | null; backupName?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-host-recovery-'))
  dirs.push(dir)
  const patch = options.patch === undefined ? STUB : options.patch
  if (patch !== null) writeFileSync(join(dir, 'cordis.patch.yml'), patch)
  const packageJson = options.packageJson === undefined ? '{ "name": "desktop-profile" }\n' : options.packageJson
  if (packageJson !== null) writeFileSync(join(dir, 'package.json'), packageJson)
  const backup = options.backup === undefined ? USER_PATCH : options.backup
  if (backup !== null) writeFileSync(join(dir, options.backupName ?? `cordis.patch.yml.bak-${STAMP}`), backup)
  return dir
}

function patchPathOf(dir: string): string {
  return join(dir, 'cordis.patch.yml')
}

describe('readHostRecoveryView', () => {
  it('reads the wipe shape: the stub is smaller and rows are missing', () => {
    const dir = profile()
    const view = readHostRecoveryView(patchPathOf(dir))
    expect(view.offerRestore).toBe(true)
    expect(view.backups.map(entry => entry.name)).toEqual([`cordis.patch.yml.bak-${STAMP}`])
    expect(view.backups[0].stamp).toBe(STAMP)
    expect(view.backups[0].rowIds).toEqual(['llm-deepseek', 'agent-default-model', 'permission'])
    // The stub carries no rows at all, which is the shape the report saw:
    // every provider, model and preset gone at once.
    expect(view.lostRowIds).toEqual(['llm-deepseek', 'agent-default-model', 'permission'])
    expect(view.currentRowIds).toEqual([])
    expect(view.patchName).toBe('cordis.patch.yml')
  })

  it('does not offer an old backup when all flags survive with comments (#930)', () => {
    const patch = '- id: alpha\n  # still here\n\n  disabled: true\n- id: beta\n  # enabled\n  disabled: false\n'
    const backup = '# old configuration with a longer comment '.repeat(8) + '\n- id: alpha\n  disabled: true\n- id: beta\n  disabled: false\n'
    const dir = profile({ patch, backup })
    const view = readHostRecoveryView(patchPathOf(dir))
    expect(view.currentRowIds).toEqual(['alpha', 'beta'])
    expect(view.lostRowIds).toEqual([])
    expect(view.offerRestore).toBe(false)
  })

  it('says nothing when there is no backup beside the patch', () => {
    const dir = profile({ backup: null })
    expect(readHostRecoveryView(patchPathOf(dir)).offerRestore).toBe(false)
    expect(readHostRecoveryView(patchPathOf(dir)).backups).toEqual([])
  })

  it('says nothing when the live patch is the bigger file', () => {
    // The user kept editing after the recovery, or the backup is an older,
    // smaller state. Either way this is not the wipe shape and the market
    // must not claim it is.
    const dir = profile({ patch: `${USER_PATCH}- id: ui-theme\n  disabled: false\n` })
    const view = readHostRecoveryView(patchPathOf(dir))
    expect(view.lostRowIds).toEqual([])
    expect(view.offerRestore).toBe(false)
  })

  it('does not list a backup that carries no rows', () => {
    // The stub the host leaves behind has a name of the same shape. It is not
    // a restore point — offering it would invite the user to restore nothing.
    const dir = profile({ backupName: `cordis.patch.yml.bak-${STAMP + 1000}`, backup: STUB })
    const view = readHostRecoveryView(patchPathOf(dir))
    expect(view.backups).toEqual([])
    expect(view.offerRestore).toBe(false)
  })

  it('ignores epoch-stamped backups of other files', () => {
    const dir = profile({ backup: null })
    writeFileSync(join(dir, `package.json.bak-${STAMP}`), USER_PATCH)
    expect(readHostRecoveryView(patchPathOf(dir)).backups).toEqual([])
  })

  it('picks the newest backup and compares against it', () => {
    const dir = profile({ backup: null })
    writeFileSync(join(dir, `cordis.patch.yml.bak-${STAMP}`), USER_PATCH)
    writeFileSync(join(dir, `cordis.patch.yml.bak-${STAMP + 5000}`), '- id: ui-theme\n  disabled: true\n')
    const view = readHostRecoveryView(patchPathOf(dir))
    expect(view.backups[0].name).toBe(`cordis.patch.yml.bak-${STAMP + 5000}`)
    expect(view.lostRowIds).toEqual(['ui-theme'])
  })

  it('survives a profile the market cannot read', () => {
    const view = readHostRecoveryView(join(tmpdir(), 'dsh-market-no-such-profile', 'cordis.patch.yml'))
    expect(view).toMatchObject({ offerRestore: false, backups: [], currentBytes: 0 })
  })
})

describe('restoreHostRecoveryBackup', () => {
  it('puts the user patch back and keeps everything it displaced', () => {
    const dir = profile()
    const patchPath = patchPathOf(dir)
    const backupName = `cordis.patch.yml.bak-${STAMP}`
    const result = restoreHostRecoveryBackup(patchPath, dir, backupName)
    expect(result.ok).toBe(true)
    expect(result.ok && result.restored.rows).toBe(3)
    // The profile is exactly what it was before the recovery...
    expect(readFileSync(patchPath, 'utf8')).toBe(USER_PATCH)
    // ...including the one that already exists in the user's own settings.
    expect(readFileSync(join(dir, backupName), 'utf8')).toBe(USER_PATCH)
    // The stub was moved aside rather than deleted: a user who restores the
    // wrong backup must still find what the app was running with.
    const sidecars = readdirSync(dir).filter(name => name.startsWith('cordis.patch.yml.bak-') && name !== backupName)
    expect(sidecars).toHaveLength(1)
    expect(readFileSync(join(dir, sidecars[0]), 'utf8')).toBe(STUB)
    // And the restore is undoable the way every other write on this page is.
    expect(result.ok && listSnapshots(dir).map(snap => snap.id)).toContain(result.snapshot)
  })

  it('leaves the banner satisfied afterwards', () => {
    const dir = profile()
    expect(readHostRecoveryBackupOk(dir)).toBe(true)
    restoreHostRecoveryBackup(patchPathOf(dir), dir, `cordis.patch.yml.bak-${STAMP}`)
    expect(readHostRecoveryView(patchPathOf(dir)).offerRestore).toBe(false)
  })

  it('refuses a name it did not just read off the directory', () => {
    const dir = profile()
    for (const name of ['cordis.patch.yml', '../../etc/passwd', 'cordis.patch.yml.bak-1', '']) {
      const result = restoreHostRecoveryBackup(patchPathOf(dir), dir, name)
      expect(result.ok).toBe(false)
    }
    // Nothing was touched: the stub is still the live patch.
    expect(readFileSync(patchPathOf(dir), 'utf8')).toBe(STUB)
    expect(listSnapshots(dir)).toEqual([])
  })

  it('refuses to write when no snapshot can be taken, because then nothing could undo it', () => {
    const dir = profile({ packageJson: null })
    const result = restoreHostRecoveryBackup(patchPathOf(dir), dir, `cordis.patch.yml.bak-${STAMP}`)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('快照')
    expect(readFileSync(patchPathOf(dir), 'utf8')).toBe(STUB)
  })

  it('restores a patch the host left the profile without', () => {
    // A crash between the rename and the stub write leaves no patch at all.
    const dir = profile({ patch: null })
    const result = restoreHostRecoveryBackup(patchPathOf(dir), dir, `cordis.patch.yml.bak-${STAMP}`)
    expect(result.ok).toBe(true)
    expect(readFileSync(patchPathOf(dir), 'utf8')).toBe(USER_PATCH)
    expect(readdirSync(dir).filter(name => name.startsWith('cordis.patch.yml.bak-'))).toHaveLength(1)
  })

  it('leaves the live patch in place when the new one cannot be written', () => {
    // A directory where the temp file goes makes the write fail the way a
    // full disk or a file held by antivirus does. The live patch used to be
    // moved aside first, so the profile was left with none.
    const dir = profile()
    const patchPath = patchPathOf(dir)
    const backupName = `cordis.patch.yml.bak-${STAMP}`
    mkdirSync(`${patchPath}.restore-${process.pid}`)
    const result = restoreHostRecoveryBackup(patchPath, dir, backupName)
    expect(result.ok).toBe(false)
    expect(readFileSync(patchPath, 'utf8')).toBe(STUB)
    expect(readdirSync(dir).filter(name => name.startsWith('cordis.patch.yml.bak-'))).toEqual([backupName])
  })

  it('refuses when the backup disappeared between the read and the write', () => {
    const dir = profile()
    const backupName = `cordis.patch.yml.bak-${STAMP}`
    rmSync(join(dir, backupName))
    const result = restoreHostRecoveryBackup(patchPathOf(dir), dir, backupName)
    expect(result.ok).toBe(false)
    expect(existsSync(patchPathOf(dir))).toBe(true)
  })
})

/** The banner's own question, asked the way the client asks it. */
function readHostRecoveryBackupOk(dir: string): boolean {
  return readHostRecoveryView(patchPathOf(dir)).offerRestore
}
