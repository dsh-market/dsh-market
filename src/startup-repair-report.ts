import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { RepairFailureCause, RepairReport } from './pending-updates.ts'
import { NPM_NAME_RE } from './sources.ts'

export type StartupRepairEntry = { name: string } & (
  | { state: 'reinstalled' | 'verified' | 'abandoned' }
  | { state: 'pending'; cause: RepairFailureCause }
)

export interface StartupRepairSnapshot {
  id: string
  revision: number
  checking: boolean
  entries: StartupRepairEntry[]
}

type ProfileReport = {
  id: string
  revision: number
  outstanding: Set<number>
  entries: Map<string, { attempt: number; entry: StartupRepairEntry }>
}

// The host can unload and evaluate the market module again during a repair.
const REPORTS = Symbol.for('dshmarket.startup-update-repair-reports')

function entriesOf(report: RepairReport): StartupRepairEntry[] {
  const abandoned = new Set(report.abandoned)
  return [
    ...report.reinstalled.map(name => ({ name, state: 'reinstalled' as const })),
    ...report.finished.map(name => ({ name, state: 'verified' as const })),
    ...report.failed.filter(({ name }) => !abandoned.has(name))
      .map(({ name, cause }) => ({ name, cause, state: 'pending' as const })),
    ...report.abandoned.map(name => ({ name, state: 'abandoned' as const })),
  ].filter(({ name }) => NPM_NAME_RE.test(name))
}

/** Track what the existing startup repair found, without owning any package writes. */
export function observeStartupRepair(profile: string, directory: string): {
  read: () => StartupRepairSnapshot
  finish: (report?: RepairReport) => void
} {
  const global = globalThis as { [REPORTS]?: Map<string, ProfileReport> }
  const reports = global[REPORTS] ??= new Map()
  const absolute = resolve(directory)
  const key = JSON.stringify([profile, process.platform === 'win32' ? absolute.toLowerCase() : absolute])
  const state: ProfileReport = reports.get(key) ?? { id: randomUUID(), revision: 0, outstanding: new Set(), entries: new Map() }
  reports.set(key, state)
  const attempt = ++state.revision
  state.outstanding.add(attempt)

  return {
    read: () => ({
      id: state.id,
      revision: state.revision,
      checking: state.outstanding.size > 0,
      entries: [...state.entries.values()].map(({ entry }) => entry),
    }),
    finish: report => {
      if (!state.outstanding.delete(attempt)) return
      state.revision += 1
      if (report === undefined) return
      for (const entry of entriesOf(report)) {
        const previous = state.entries.get(entry.name)
        if (previous === undefined || previous.attempt <= attempt) state.entries.set(entry.name, { attempt, entry })
      }
    },
  }
}
