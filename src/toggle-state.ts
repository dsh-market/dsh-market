/** Prepare one plugin/theme choice before touching its live composition. */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { checkWritableFile, writeDestination, writeFileAtomic } from './atomic-write.ts'
import { parsePatchText } from './check.ts'
import { disableRow, enableRow } from './patch.ts'
import { addProfileBundle, removeProfileBundle } from './profile.ts'

export interface ToggleChoice {
  name: string
  enabled: boolean
  rows: string[]
  carrier: boolean
}

function readOptional(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export interface PreparedToggle {
  /** Synchronous publication; state is written last, before yielding to this host's watchers. */
  commit(writeState: () => void): void
  dispose(): void
}

/**
 * Validate all rows on a scratch copy, then publish the entire patch once.
 * These are toggle-specific compensating writes, not crash-atomic commits
 * across files. Restore only bytes this operation wrote; never overwrite an
 * external edit encountered while activation was pending or during recovery.
 */
export async function prepareToggleWrites(
  profileDir: string, patchPath: string, choices: readonly ToggleChoice[],
): Promise<PreparedToggle> {
  const aliases = [patchPath, join(profileDir, 'package.json'), join(profileDir, '.dsh-market', 'state.json')]
    .map(path => ({ path, destination: writeDestination(path) }))
  patchPath = aliases[0].destination
  const statePath = aliases[2].destination
  checkWritableFile(statePath)
  const stateBefore = readOptional(statePath)
  if (stateBefore !== null) JSON.parse(stateBefore)
  const patchBefore = readOptional(patchPath)
  if (choices.some(choice => choice.rows.length > 0) && patchBefore?.replace(/^[ \t]*#.*$/gmu, '').trim() && parsePatchText(patchBefore) === null) {
    throw new Error('the patch layer is not a valid entry list; fix the YAML before toggling / 补丁层无效，请先修正 YAML')
  }
  const manifestPath = aliases[1].destination
  const manifestBefore = readOptional(manifestPath)
  const marketDir = join(profileDir, '.dsh-market')
  mkdirSync(marketDir, { recursive: true, mode: 0o700 })
  const scratch = mkdtempSync(join(marketDir, 'toggle-'))
  const files: { path: string; before: string | null; after: string; staged: string }[] = []
  const dispose = () => {
    for (const file of files) rmSync(file.staged, { force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
  try {
    const patchCopy = join(scratch, 'cordis.patch.yml')
    if (patchBefore !== null) writeFileSync(patchCopy, patchBefore)
    if (manifestBefore !== null) writeFileSync(join(scratch, 'package.json'), manifestBefore)
    for (const choice of choices) {
      for (const row of choice.rows) {
        const result = await (choice.enabled ? enableRow(patchCopy, row, false) : disableRow(patchCopy, row, false))
        if (!result.ok) throw new Error(result.reason ?? 'patch write refused')
      }
      if (choice.carrier) {
        if (choice.enabled) addProfileBundle(scratch, choice.name)
        else removeProfileBundle(scratch, choice.name)
      }
    }
    for (const [path, copy, before] of [
      [patchPath, patchCopy, patchBefore],
      [manifestPath, join(scratch, 'package.json'), manifestBefore],
    ] as const) {
      const after = readOptional(copy)
      if (after === null || after === before) continue
      if (path === patchPath && parsePatchText(after) === null) throw new Error('toggle would produce an invalid patch')
      checkWritableFile(path)
      const staged = join(dirname(path), `.dshm-toggle-${randomUUID()}`)
      files.push({ path, before, after, staged })
      writeFileSync(staged, after, { flag: 'wx', mode: before === null ? 0o600 : statSync(path).mode & 0o777 })
    }
    return {
      dispose,
      commit(writeState) {
        const published: typeof files = []
        try {
          // Even unchanged patch/manifest inputs matter: an external edit can
          // invalidate the activation decision made against the original file.
          for (const alias of aliases) {
            if (writeDestination(alias.path) !== alias.destination) throw new Error(`profile link changed during activation: ${alias.path}`)
          }
          for (const [path, before] of [[statePath, stateBefore], [patchPath, patchBefore], [manifestPath, manifestBefore]] as const) {
            if (readOptional(path) !== before) throw new Error(`profile changed during activation: ${path}`)
          }
          checkWritableFile(statePath)
          for (const file of files) checkWritableFile(file.path)
          for (const file of files) {
            renameSync(file.staged, file.path)
            published.push(file)
          }
          writeState()
        } catch (error) {
          const failures: string[] = []
          for (const file of published.reverse()) {
            try {
              if (readOptional(file.path) !== file.after) throw new Error('file changed after publication; refusing to overwrite it')
              if (file.before === null) rmSync(file.path, { force: true })
              else writeFileAtomic(file.path, file.before)
            } catch (restoreError) {
              failures.push(`${file.path}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`)
            }
          }
          if (failures.length) throw new Error(`${String(error)}; profile restoration failed: ${failures.join('; ')}`)
          throw error
        } finally { dispose() }
      },
    }
  } catch (error) { dispose(); throw error }
}
