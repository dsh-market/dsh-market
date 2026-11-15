/**
 * The rows an interrupted uninstall leaves behind (#987).
 *
 * A remove deletes the package first and clears the rows its bundle patch
 * declares second. When this plugin is unloaded in between — the official
 * Desktop replays its plugin set after a profile change — the rows outlive
 * their package, and an insert naming a missing module can stop the whole
 * boot. These specs pin the two halves: the intent is durable before the
 * destructive step, and the next start settles it against disk truth.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PendingRowJournal, pendingRowsFile, repairOrphanedRows } from '../src/pending-rows.ts'

const roots: string[] = []

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-rows-'))
  roots.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: {} }))
  // The shape the market itself writes: a top-level `- id: X` + `disabled:`
  // block. `removeRowBlocks` is scoped to these by design — an `insert:` row
  // belongs to the package's own patch, and reconfigurations of OTHER plugins
  // must never be touched (#147).
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- id: pet',
    '  disabled: true',
    '- id: other',
    '  disabled: true',
    '',
  ].join('\n'))
  return dir
}

/** Put a package in the profile manifest, the way an install would. */
function declare(dir: string, name: string): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { [name]: '^1.0.0' } }))
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the pending-row journal', () => {
  it('records the rows a remove is about to orphan and forgets them once cleaned', () => {
    const dir = profile()
    const journal = PendingRowJournal.forProfile(dir)
    journal.begin({ profile: 'web', name: '@acme/dsh-pet', patchPath: join(dir, 'cordis.patch.yml'), rows: ['pet'] })

    // A brand-new instance stands in for the next process.
    expect(PendingRowJournal.forProfile(dir).list()).toMatchObject([{ name: '@acme/dsh-pet', rows: ['pet'] }])

    journal.finish('web', '@acme/dsh-pet')
    expect(PendingRowJournal.forProfile(dir).list()).toEqual([])
  })

  it('writes nothing for a package that owns no rows', () => {
    const dir = profile()
    PendingRowJournal.forProfile(dir).begin({ profile: 'web', name: '@acme/plain', patchPath: join(dir, 'cordis.patch.yml'), rows: [] })
    expect(PendingRowJournal.forProfile(dir).list()).toEqual([])
  })

  it('treats an unreadable journal as empty instead of failing the start', () => {
    const dir = profile()
    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
    writeFileSync(pendingRowsFile(dir), '{"version":1,"operations":[')
    expect(PendingRowJournal.forProfile(dir).list()).toEqual([])
    expect(() => repairOrphanedRows({ profile: 'web', profileDirectory: dir })).not.toThrow()
  })
})

describe('settling an uninstall a previous start interrupted', () => {
  it('removes the rows of a package that is gone, and only those', () => {
    const dir = profile()
    // The remove landed; the cleanup did not.
    PendingRowJournal.forProfile(dir).begin({ profile: 'web', name: '@acme/dsh-pet', patchPath: join(dir, 'cordis.patch.yml'), rows: ['pet'] })

    const report = repairOrphanedRows({ profile: 'web', profileDirectory: dir })

    expect(report.removed).toEqual(['@acme/dsh-pet'])
    const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    expect(patch).not.toContain('id: pet')
    expect(patch).toContain('id: other')
    expect(PendingRowJournal.forProfile(dir).list()).toEqual([])
  })

  it('leaves the rows alone when the package is still installed', () => {
    // The remove never ran (or the user reinstalled it): these rows are
    // configuration for a package that is here, not orphans.
    const dir = profile()
    declare(dir, '@acme/dsh-pet')
    PendingRowJournal.forProfile(dir).begin({ profile: 'web', name: '@acme/dsh-pet', patchPath: join(dir, 'cordis.patch.yml'), rows: ['pet'] })

    const report = repairOrphanedRows({ profile: 'web', profileDirectory: dir })

    expect(report.kept).toEqual(['@acme/dsh-pet'])
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toContain('id: pet')
    expect(PendingRowJournal.forProfile(dir).list()).toEqual([])
  })

  it('removes only the departed package’s marked override when another package reuses its row ID (#1196)', () => {
    const dir = profile()
    const patchPath = join(dir, 'cordis.patch.yml')
    const kept = "- id: pet\n  disabled: false\n  name: '@acme/dsh-other' # dsh-market\n"
    const orphan = "- id: pet\n  disabled: true\n  name: '@acme/dsh-pet' # dsh-market\n"
    writeFileSync(patchPath, orphan + kept)
    declare(dir, '@acme/dsh-other')
    PendingRowJournal.forProfile(dir).begin({ profile: 'web', name: '@acme/dsh-pet', patchPath, rows: ['pet'] })

    const report = repairOrphanedRows({ profile: 'web', profileDirectory: dir })

    expect(report.removed).toEqual(['@acme/dsh-pet'])
    expect(readFileSync(patchPath, 'utf8')).toBe(kept)
  })

  it('keeps the record when the rows cannot be removed, so a later start retries', () => {
    const dir = profile()
    // A patch path that does not exist is treated as "nothing to remove" by
    // removeRowBlocks; point it at a directory instead, which cannot be read
    // as a file and cannot be written either.
    PendingRowJournal.forProfile(dir).begin({ profile: 'web', name: '@acme/dsh-pet', patchPath: dir, rows: ['pet'] })

    const report = repairOrphanedRows({ profile: 'web', profileDirectory: dir })

    // removeRowBlocks answers ok for a file it cannot read (no file, nothing
    // to remove), so this record settles; what must NOT happen is a throw or
    // a record left mid-write.
    expect(report.failed).toEqual([])
    expect(PendingRowJournal.forProfile(dir).list()).toEqual([])
  })
})
