import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { observeStartupRepair } from '../src/startup-repair-report.ts'

describe('startup repair report', () => {
  it('keeps a completed report across remounts, scoped to the active profile, with no raw errors', () => {
    const directory = join(tmpdir(), randomUUID())
    const active = observeStartupRepair('desktop', directory)
    expect(active.read()).toMatchObject({ checking: true, entries: [] })
    active.finish({
      reinstalled: ['fixed-package'],
      finished: ['@scope/intact-package'],
      failed: [
        { name: 'incomplete-package', reason: 'C:\\private\\location with credentials', cause: 'timeout' },
        { name: 'C:\\private\\invalid-name', reason: 'private details', cause: 'unknown' },
        { name: 'manual-package', reason: 'limit reached', cause: 'abandoned' },
      ],
      abandoned: ['manual-package'],
    })
    expect(active.read()).toEqual({
      id: expect.any(String), revision: 2, checking: false,
      entries: [
        { name: 'fixed-package', state: 'reinstalled' },
        { name: '@scope/intact-package', state: 'verified' },
        { name: 'incomplete-package', state: 'pending', cause: 'timeout' },
        { name: 'manual-package', state: 'abandoned' },
      ],
    })
    const remount = observeStartupRepair('desktop', directory)
    expect(remount.read()).toMatchObject({ id: active.read().id, checking: true, entries: active.read().entries })
    remount.finish({ reinstalled: [], finished: [], failed: [], abandoned: [] })
    expect(remount.read()).toMatchObject({ id: active.read().id, checking: false, entries: active.read().entries })
    for (const other of [
      observeStartupRepair('another', directory),
      observeStartupRepair('desktop', join(directory, 'another-home')),
    ]) {
      other.finish()
      expect(other.read()).toMatchObject({ checking: false, entries: [] })
      expect(other.read().id).not.toBe(remount.read().id)
    }
  })

  it('keeps the newer result for a package if the previous mount finishes late', () => {
    const directory = join(tmpdir(), randomUUID())
    const older = observeStartupRepair('desktop', directory)
    const recent = observeStartupRepair('desktop', directory)
    recent.finish({ reinstalled: ['fixed-package'], finished: [], failed: [], abandoned: [] })
    const ahead = recent.read()
    expect(ahead).toMatchObject({ checking: true, entries: [{ name: 'fixed-package', state: 'reinstalled' }] })

    older.finish({
      reinstalled: [],
      finished: ['other-package'],
      failed: [{ name: 'fixed-package', cause: 'refused', reason: 'old mount failure' }],
      abandoned: [],
    })
    expect(recent.read()).toEqual({
      id: ahead.id, revision: ahead.revision + 1, checking: false,
      entries: [{ name: 'fixed-package', state: 'reinstalled' }, { name: 'other-package', state: 'verified' }],
    })
    older.finish()
    expect(recent.read().revision).toBe(ahead.revision + 1)
  })
})
