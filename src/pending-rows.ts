/**
 * Patch rows an uninstall was going to orphan, recorded before the remove.
 *
 * Why this exists (#987): an uninstall removes the package first and clears the
 * rows its bundle patch declares second — `rowIdsForPackage` has to be asked
 * BEFORE the remove, because the remove deletes the patch it reads (#799). On
 * a host that unloads this plugin in the middle of the operation (the official
 * Desktop replays its plugin set after a profile change, #962), the second half
 * never runs and the rows outlive their package. A `- id: pet` insert for a
 * package that is no longer installed is not cosmetic: DSH's boot is
 * all-or-nothing, so one row naming a missing module can keep the whole host
 * from starting, and the way out was editing cordis.patch.yml by hand.
 *
 * So the intent is written down before the destructive step, exactly like the
 * interrupted-update journal next door, and the next start settles it against
 * disk truth: rows whose package is gone are removed, and a record whose
 * package is still installed is dropped untouched (the remove never happened,
 * or the user put it back — either way the rows are exactly as configuration
 * should be).
 *
 * The rows this settles are the ones the market writes and `removeRowBlocks`
 * understands — `- id: X` + `disabled:` blocks. Rows that declare a package's
 * own config live in that package's patch; a copy of one in the profile patch
 * is the host's (the manager's install dialog writes those) and is not this
 * module's to interpret.
 *
 * What this cannot do is run when the host never starts: the repair happens
 * inside the host, after composition. It covers the case that produced the
 * report — a host that stayed up while this plugin was unloaded — and the next
 * ordinary start after a restart.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { removeRowBlocks } from './patch.ts'
import { readInstalled } from './profile.ts'

export interface PendingRowCleanup {
  id: string
  profile: string
  /** The package being removed; also what decides whether the rows are orphans. */
  name: string
  /** The profile patch layer the rows live in, absolute. */
  patchPath: string
  /** Loader row ids the package's own bundle patch declares. */
  rows: string[]
  startedAt: string
}

export interface PendingRowInput {
  profile: string
  name: string
  patchPath: string
  rows: readonly string[]
}

interface PendingRowState {
  version: 1
  operations: PendingRowCleanup[]
}

const STATE_VERSION = 1 as const

/** Same directory as the other durable per-profile state (see pending-updates.ts). */
export function pendingRowsFile(profileDirectory: string): string {
  return join(profileDirectory, '.dsh-market', 'pending-rows.json')
}

export class PendingRowJournal {
  constructor(readonly file: string) {}

  static forProfile(profileDirectory: string): PendingRowJournal {
    return new PendingRowJournal(pendingRowsFile(profileDirectory))
  }

  list(): PendingRowCleanup[] {
    return this.read().operations
  }

  /** Record what a remove is about to orphan. Upserts by profile+name. */
  begin(input: PendingRowInput): void {
    if (input.rows.length === 0) return
    const state = this.read()
    const existing = state.operations.find(entry => entry.profile === input.profile && entry.name === input.name)
    const fields = {
      profile: input.profile,
      name: input.name,
      patchPath: input.patchPath,
      rows: [...input.rows],
      startedAt: new Date().toISOString(),
    }
    if (existing !== undefined) Object.assign(existing, fields)
    else state.operations.push({ id: `${input.profile}:${input.name}`, ...fields })
    this.write(state)
  }

  /** The rows were cleaned (or the remove never happened): nothing left to settle. */
  finish(profile: string, name: string): void {
    const state = this.read()
    const kept = state.operations.filter(entry => !(entry.profile === profile && entry.name === name))
    if (kept.length === state.operations.length) return
    this.write({ version: STATE_VERSION, operations: kept })
  }

  private read(): PendingRowState {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PendingRowState>
      const operations = Array.isArray(parsed.operations) ? parsed.operations : []
      // Storage is not trusted: this file is user-writable and outlives
      // versions of this code, and a malformed entry must cost its own record,
      // never the whole repair.
      return {
        version: STATE_VERSION,
        operations: operations.filter((entry): entry is PendingRowCleanup =>
          entry !== null && typeof entry === 'object'
          && typeof entry.profile === 'string' && typeof entry.name === 'string'
          && typeof entry.patchPath === 'string'
          && Array.isArray(entry.rows) && entry.rows.every(row => typeof row === 'string')
          && typeof entry.id === 'string' && typeof entry.startedAt === 'string'),
      }
    } catch {
      return { version: STATE_VERSION, operations: [] }
    }
  }

  private write(state: PendingRowState): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(state))
    } catch { /* storage unavailable — the next start just has nothing to settle */ }
  }
}

export interface OrphanRowReport {
  /** Packages whose rows were removed this start. */
  removed: string[]
  /** Records dropped because the package is still installed. */
  kept: string[]
  /** Records whose rows could not be removed; they are retried next start. */
  failed: string[]
}

/**
 * Settle every recorded remove against what the profile actually holds now.
 *
 * @param options.profile - Profile name, for reading the installed map.
 * @param options.profileDirectory - Its directory, when the host named one.
 * @returns what happened, per record.
 */
export function repairOrphanedRows(options: {
  profile: string
  profileDirectory?: string
}): OrphanRowReport {
  const directory = options.profileDirectory
  if (directory === undefined) return { removed: [], kept: [], failed: [] }
  const journal = PendingRowJournal.forProfile(directory)
  const records = journal.list()
  const report: OrphanRowReport = { removed: [], kept: [], failed: [] }
  if (records.length === 0) return report
  const installed = readInstalled(options.profile, directory)
  for (const record of records) {
    if (Object.hasOwn(installed, record.name)) {
      // The remove never landed, or the user reinstalled it. Either way these
      // rows are configuration for a package that is here.
      journal.finish(record.profile, record.name)
      report.kept.push(record.name)
      continue
    }
    const cleaned = removeRowBlocks(record.patchPath, record.rows, record.name)
    if (!cleaned.ok) {
      report.failed.push(record.name)
      continue
    }
    journal.finish(record.profile, record.name)
    report.removed.push(record.name)
  }
  return report
}
