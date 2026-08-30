/**
 * Unit tests for profile snapshots (issue #98, phase 3) — src/snapshot.ts.
 * Snapshot capture / list / restore / delete, exercised against per-test
 * tmpdir fixtures (same pattern as tests/check.spec.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareSnapshotIdsNewest,
  createProfileSnapshot,
  deleteSnapshot,
  listSnapshots,
  pruneSnapshots,
  restoreSnapshot,
  type ProfileSnapshot,
} from '../src/snapshot.ts'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dshm-snap-'))
  process.env.DSH_HOME = tmp
})
afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(tmp, { recursive: true, force: true })
})

/** A fresh profile directory inside the per-test tmpdir. */
function pdir(name = 'profile'): string {
  return join(tmp, name)
}

/** Write the profile manifest (package.json) into `dir`. */
function writeProfile(dir: string, manifest: unknown): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
}

function snapshotsDir(dir: string): string {
  return join(dir, '.dsh-market', 'snapshots')
}

function mustCreateProfileSnapshot(dir: string, maxSnapshots?: number): ProfileSnapshot {
  const result = createProfileSnapshot(dir, maxSnapshots)
  if (!result.ok) throw new Error(result.error)
  return result.snapshot
}

const SAMPLE_MANIFEST = {
  name: 'web-profile',
  version: '1.0.0',
  dependencies: { alpha: '^1.0.0' },
  dsh: { profile: { bundles: ['alpha'] } },
}

const SAMPLE_PATCH = '- insert:\n  - id: alpha\n    name: alpha\n'

describe('createProfileSnapshot', () => {
  it('captures package.json, cordis.patch.yml and state.json into a snapshot file', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
    writeFileSync(join(dir, 'cordis.patch.yml'), SAMPLE_PATCH)
    writeFileSync(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ disabled: ['p1'], groups: {}, groupOrder: [] }))

    const snapshot = mustCreateProfileSnapshot(dir)
    expect(snapshot.id).toMatch(/^snapshot-/)
    expect(typeof snapshot.createdAt).toBe('number')
    // Known composition files, package.json first.
    expect(snapshot.files.map(f => f.path)).toEqual(['package.json', 'cordis.patch.yml', '.dsh-market/state.json'])
    // JSON documents keep their parsed form; line-oriented files keep their lines.
    expect(snapshot.files[0]?.json).toEqual(SAMPLE_MANIFEST)
    expect(snapshot.files[1]?.lines?.join('\n')).toBe(SAMPLE_PATCH)
    expect(snapshot.files[2]?.json).toEqual({ disabled: ['p1'], groups: {}, groupOrder: [] })

    // Persisted under <profile>/.dsh-market/snapshots/<id>.json.
    const file = join(snapshotsDir(dir), `${snapshot.id}.json`)
    expect(existsSync(file)).toBe(true)
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { id: string; files: { path: string }[] }
    expect(stored.id).toBe(snapshot.id)
    expect(stored.files.map(f => f.path)).toEqual(['package.json', 'cordis.patch.yml', '.dsh-market/state.json'])
  })

  it('names package.json and the concrete reason when capture fails', () => {
    const dir = pdir()
    const missing = createProfileSnapshot(dir)
    expect(missing).toMatchObject({ ok: false })
    if (!missing.ok) expect(missing.error).toContain('package.json is missing')

    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{ nope')
    const invalid = createProfileSnapshot(dir)
    expect(invalid).toMatchObject({ ok: false })
    if (!invalid.ok) expect(invalid.error).toContain('package.json contains invalid JSON')
  })

  it('captures malformed optional state as absent because Market observes it as empty', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
    writeFileSync(join(dir, '.dsh-market', 'state.json'), '{ broken')

    const snapshot = mustCreateProfileSnapshot(dir)
    expect(snapshot.files).toContainEqual({ path: '.dsh-market/state.json', absent: true })
    expect(existsSync(join(snapshotsDir(dir), `${snapshot.id}.json`))).toBe(true)
    expect(readFileSync(join(dir, '.dsh-market', 'state.json'), 'utf8')).toBe('{ broken')

    writeFileSync(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ disabled: ['later'] }))
    expect(restoreSnapshot(dir, snapshot.id)).toMatchObject({ ok: true })
    expect(existsSync(join(dir, '.dsh-market', 'state.json'))).toBe(false)
  })

  it('does not mislabel an existing but unreadable optional path as absent', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    mkdirSync(join(dir, 'cordis.patch.yml'))

    const result = createProfileSnapshot(dir)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) {
      expect(result.error).toContain('cordis.patch.yml')
      expect(result.error).toContain('could not be read')
      expect(result.error).toContain('(EISDIR)')
    }
    expect(existsSync(snapshotsDir(dir))).toBe(false)
  })

  it('does not mislabel a dangling optional-file symlink as absent', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    symlinkSync(join(dir, 'missing-cordis.patch.yml'), join(dir, 'cordis.patch.yml'), 'file')

    const result = createProfileSnapshot(dir)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.error).toContain('cordis.patch.yml could not be read')
    expect(existsSync(snapshotsDir(dir))).toBe(false)
  })

  it('still snapshots when the optional files are absent', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    const snapshot = mustCreateProfileSnapshot(dir)
    expect(snapshot).toMatchObject({
      format: 'dsh-market/profile-snapshot',
      version: 2,
      files: [
        { path: 'package.json', json: SAMPLE_MANIFEST },
        { path: 'cordis.patch.yml', absent: true },
        { path: '.dsh-market/state.json', absent: true },
      ],
    })
  })

  it('assigns distinct ids to consecutive snapshots', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    const a = mustCreateProfileSnapshot(dir)
    const b = mustCreateProfileSnapshot(dir)
    expect(a.id).not.toBe(b.id)
    expect(readdirSync(snapshotsDir(dir)).filter(n => n.endsWith('.json'))).toHaveLength(2)
  })
})

describe('listSnapshots', () => {
  it('returns snapshots newest first', () => {
    const dir = pdir()
    mkdirSync(snapshotsDir(dir), { recursive: true })
    const mk = (id: string, createdAt: number): void => {
      writeFileSync(join(snapshotsDir(dir), `${id}.json`), JSON.stringify({
        id,
        createdAt,
        files: [{ path: 'package.json', json: { name: id } }],
      }))
    }
    mk('snapshot-old', 1000)
    mk('snapshot-new', 2000)

    const list = listSnapshots(dir)
    expect(list.map(s => s.id)).toEqual(['snapshot-new', 'snapshot-old'])
    expect(list[0]?.createdAt).toBe(2000)
  })

  it('returns [] when no snapshots exist', () => {
    const dir = pdir()
    expect(listSnapshots(dir)).toEqual([])
  })

  it('skips corrupt snapshot files', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    const good = mustCreateProfileSnapshot(dir)
    writeFileSync(join(snapshotsDir(dir), 'snapshot-corrupt.json'), 'not json at all')

    const list = listSnapshots(dir)
    expect(list.map(s => s.id)).toEqual([good.id])
  })
})

describe('restoreSnapshot', () => {
  it('restores every captured file from memory', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
    writeFileSync(join(dir, 'cordis.patch.yml'), SAMPLE_PATCH)
    writeFileSync(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ disabled: ['p1'], groups: {}, groupOrder: [] }))
    const snapshot = mustCreateProfileSnapshot(dir)

    // Mutate all three files after the snapshot was taken.
    writeProfile(dir, { name: 'changed', dsh: { profile: { bundles: ['beta'] } } })
    writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n  - id: beta\n    name: beta\n')
    writeFileSync(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ disabled: ['p2'], groups: {}, groupOrder: [] }))

    const result = restoreSnapshot(dir, snapshot.id)
    expect(result.ok).toBe(true)
    expect(result.restored).toEqual(['package.json', 'cordis.patch.yml', '.dsh-market/state.json'])
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).toEqual(SAMPLE_MANIFEST)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(SAMPLE_PATCH)
    expect(JSON.parse(readFileSync(join(dir, '.dsh-market', 'state.json'), 'utf8'))).toEqual({ disabled: ['p1'], groups: {}, groupOrder: [] })
  })

  it('removes optional composition files created after a v2 snapshot', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    const snapshot = mustCreateProfileSnapshot(dir)
    writeProfile(dir, { name: 'changed' })
    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
    writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n  - id: later\n')
    writeFileSync(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ disabled: ['later'] }))

    const result = restoreSnapshot(dir, snapshot.id)
    expect(result.ok).toBe(true)
    expect(result.restored).toEqual(['package.json', 'cordis.patch.yml', '.dsh-market/state.json'])
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).toEqual(SAMPLE_MANIFEST)
    expect(existsSync(join(dir, 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(dir, '.dsh-market', 'state.json'))).toBe(false)
  })

  it('preserves later optional files when restoring a legacy package-only snapshot', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    mkdirSync(snapshotsDir(dir), { recursive: true })
    writeFileSync(join(snapshotsDir(dir), 'snapshot-legacy.json'), JSON.stringify({
      id: 'snapshot-legacy',
      createdAt: 1,
      files: [{ path: 'package.json', json: SAMPLE_MANIFEST }],
    }))
    writeProfile(dir, { name: 'changed' })
    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
    writeFileSync(join(dir, 'cordis.patch.yml'), 'later patch\n')
    writeFileSync(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ disabled: ['later'] }))

    const result = restoreSnapshot(dir, 'snapshot-legacy')
    expect(result.ok).toBe(true)
    expect(result.restored).toEqual(['package.json'])
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe('later patch\n')
    expect(JSON.parse(readFileSync(join(dir, '.dsh-market', 'state.json'), 'utf8'))).toEqual({ disabled: ['later'] })
  })

  it('refuses to replace a live symlink with a regular file', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    writeFileSync(join(dir, 'cordis.patch.yml'), SAMPLE_PATCH)
    const snapshot = mustCreateProfileSnapshot(dir)

    const changedManifest = JSON.stringify({ name: 'changed' }, null, 2)
    const livePatch = join(tmp, 'live-cordis.patch.yml')
    writeFileSync(join(dir, 'package.json'), changedManifest)
    rmSync(join(dir, 'cordis.patch.yml'))
    writeFileSync(livePatch, 'live patch\n')
    symlinkSync(livePatch, join(dir, 'cordis.patch.yml'), 'file')

    const result = restoreSnapshot(dir, snapshot.id)
    expect(result.ok).toBe(false)
    expect(result.restored).toEqual([])
    expect(result.error).toContain('not a regular file')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(changedManifest)
    expect(lstatSync(join(dir, 'cordis.patch.yml')).isSymbolicLink()).toBe(true)
    expect(readFileSync(livePatch, 'utf8')).toBe('live patch\n')
  })

  it('refuses a parent symlink that redirects a tracked file outside the profile', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
    writeFileSync(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ disabled: ['captured'] }))
    const snapshot = mustCreateProfileSnapshot(dir)

    const changedManifest = JSON.stringify({ name: 'changed' }, null, 2)
    const outside = join(tmp, 'outside-market')
    writeFileSync(join(dir, 'package.json'), changedManifest)
    renameSync(join(dir, '.dsh-market'), outside)
    writeFileSync(join(outside, 'state.json'), JSON.stringify({ disabled: ['outside'] }))
    symlinkSync(outside, join(dir, '.dsh-market'), process.platform === 'win32' ? 'junction' : 'dir')

    const result = restoreSnapshot(dir, snapshot.id)
    expect(result.ok).toBe(false)
    expect(result.restored).toEqual([])
    expect(result.error).toContain('unsafe snapshot restore path')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(changedManifest)
    expect(lstatSync(join(dir, '.dsh-market')).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(join(outside, 'state.json'), 'utf8'))).toEqual({ disabled: ['outside'] })
  })

  it('rejects malformed v2 documents before mutating the profile', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'current' })
    mkdirSync(snapshotsDir(dir), { recursive: true })
    const packageEntry = { path: 'package.json', json: SAMPLE_MANIFEST }
    const patchEntry = { path: 'cordis.patch.yml', lines: SAMPLE_PATCH.split('\n') }
    const stateEntry = { path: '.dsh-market/state.json', json: { disabled: [] } }
    const cases: Array<{ id: string; version?: number; files: unknown[] }> = [
      { id: 'snapshot-missing-path', files: [packageEntry, patchEntry] },
      { id: 'snapshot-duplicate-path', files: [packageEntry, packageEntry, patchEntry, stateEntry] },
      { id: 'snapshot-absent-package', files: [{ path: 'package.json', absent: true }, patchEntry, stateEntry] },
      { id: 'snapshot-mixed-representation', files: [packageEntry, { path: 'cordis.patch.yml', lines: [], absent: true }, stateEntry] },
      { id: 'snapshot-invalid-lines', files: [packageEntry, { path: 'cordis.patch.yml', lines: [42] }, stateEntry] },
      { id: 'snapshot-unknown-version', version: 99, files: [packageEntry, patchEntry, stateEntry] },
    ]

    for (const candidate of cases) {
      writeFileSync(join(snapshotsDir(dir), `${candidate.id}.json`), JSON.stringify({
        format: 'dsh-market/profile-snapshot',
        version: candidate.version ?? 2,
        id: candidate.id,
        createdAt: 1,
        files: candidate.files,
      }))
      const before = readFileSync(join(dir, 'package.json'), 'utf8')
      expect(restoreSnapshot(dir, candidate.id).ok, candidate.id).toBe(false)
      expect(readFileSync(join(dir, 'package.json'), 'utf8'), candidate.id).toBe(before)
    }
    expect(listSnapshots(dir)).toEqual([])
  })

  it('recreates an earlier deletion when a later atomic write fails', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
    writeFileSync(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ disabled: ['old'] }))
    const snapshot = mustCreateProfileSnapshot(dir)

    const changedManifest = JSON.stringify({ name: 'changed' }, null, 2)
    const changedPatch = 'later patch\n'
    const changedState = JSON.stringify({ disabled: ['later'] })
    writeFileSync(join(dir, 'package.json'), changedManifest)
    writeFileSync(join(dir, 'cordis.patch.yml'), changedPatch)
    writeFileSync(join(dir, '.dsh-market', 'state.json'), changedState)

    const now = 123456789
    const random = 0.5
    const blocker = `${join(dir, '.dsh-market', 'state.json')}.tmp-${process.pid}-${now}-${random.toString(36).slice(2, 8)}`
    mkdirSync(blocker)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    vi.spyOn(Math, 'random').mockReturnValue(random)
    try {
      const result = restoreSnapshot(dir, snapshot.id)
      expect(result.ok).toBe(false)
      expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(changedManifest)
      expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(changedPatch)
      expect(readFileSync(join(dir, '.dsh-market', 'state.json'), 'utf8')).toBe(changedState)
    } finally {
      vi.restoreAllMocks()
      rmSync(blocker, { recursive: true, force: true })
    }
    expect(readdirSync(dir).some(name => name.includes('.tmp-'))).toBe(false)
    expect(readdirSync(join(dir, '.dsh-market')).some(name => name.includes('.tmp-'))).toBe(false)
  })

  it('reports when a later failure also prevents an earlier deletion from rolling back', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
    writeFileSync(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ disabled: ['old'] }))
    const snapshot = mustCreateProfileSnapshot(dir)

    const changedManifest = JSON.stringify({ name: 'changed' }, null, 2)
    const changedPatch = 'later patch\n'
    const changedState = JSON.stringify({ disabled: ['later'] })
    writeFileSync(join(dir, 'package.json'), changedManifest)
    writeFileSync(join(dir, 'cordis.patch.yml'), changedPatch)
    writeFileSync(join(dir, '.dsh-market', 'state.json'), changedState)

    const now = 123456790
    const random = 0.25
    const suffix = `.tmp-${process.pid}-${now}-${random.toString(36).slice(2, 8)}`
    const rollbackBlocker = `${join(dir, 'cordis.patch.yml')}${suffix}`
    const laterWriteBlocker = `${join(dir, '.dsh-market', 'state.json')}${suffix}`
    mkdirSync(rollbackBlocker)
    mkdirSync(laterWriteBlocker)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    vi.spyOn(Math, 'random').mockReturnValue(random)
    try {
      const result = restoreSnapshot(dir, snapshot.id)
      expect(result.ok).toBe(false)
      expect(result.restored).toEqual([])
      expect(result.error).toContain('rollback incomplete')
      expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(changedManifest)
      expect(existsSync(join(dir, 'cordis.patch.yml'))).toBe(false)
      expect(readFileSync(join(dir, '.dsh-market', 'state.json'), 'utf8')).toBe(changedState)
    } finally {
      vi.restoreAllMocks()
      rmSync(rollbackBlocker, { recursive: true, force: true })
      rmSync(laterWriteBlocker, { recursive: true, force: true })
    }
  })

  it('refuses traversal and absolute paths before writing anything', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    mkdirSync(snapshotsDir(dir), { recursive: true })

    writeFileSync(join(snapshotsDir(dir), 'snapshot-evil.json'), JSON.stringify({
      id: 'snapshot-evil',
      createdAt: 1,
      files: [{ path: '../escape.txt', json: { pwned: true } }],
    }))
    const traversal = restoreSnapshot(dir, 'snapshot-evil')
    expect(traversal.ok).toBe(false)
    expect(traversal.error).toContain('unsafe')
    expect(existsSync(join(tmp, 'escape.txt'))).toBe(false)

    writeFileSync(join(snapshotsDir(dir), 'snapshot-abs.json'), JSON.stringify({
      id: 'snapshot-abs',
      createdAt: 1,
      files: [{ path: 'C:\\Windows\\System32\\owned.txt', json: {} }],
    }))
    const absolute = restoreSnapshot(dir, 'snapshot-abs')
    expect(absolute.ok).toBe(false)
    expect(absolute.error).toContain('unsafe')
  })

  it('reports a missing snapshot as not found', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    // Valid id format, but no such snapshot file.
    const result = restoreSnapshot(dir, 'snapshot-does-not-exist')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('snapshot not found')
  })

  it('refuses malformed snapshot ids before touching the filesystem', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    // Ids must match /^snapshot-[0-9A-Za-z-]+$/ — traversal-shaped ids are refused.
    expect(restoreSnapshot(dir, '../state')).toMatchObject({ ok: false, error: 'invalid snapshot id / 无效的快照 id' })
    expect(restoreSnapshot(dir, 'missing')).toMatchObject({ ok: false, error: 'invalid snapshot id / 无效的快照 id' })
    expect(restoreSnapshot(dir, 'snapshot..evil')).toMatchObject({ ok: false, error: 'invalid snapshot id / 无效的快照 id' })
  })
})

describe('deleteSnapshot', () => {
  it('removes an existing snapshot and returns true', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    const snapshot = mustCreateProfileSnapshot(dir)
    const file = join(snapshotsDir(dir), `${snapshot.id}.json`)
    expect(existsSync(file)).toBe(true)

    expect(deleteSnapshot(dir, snapshot.id)).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(listSnapshots(dir)).toEqual([])
  })

  it('is fault-tolerant for a missing snapshot id', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    // Valid format but never created — not found → false.
    expect(deleteSnapshot(dir, 'snapshot-does-not-exist')).toBe(false)
    // Malformed (traversal-shaped / no snapshot- prefix) — refused → false.
    expect(deleteSnapshot(dir, '../state')).toBe(false)
    expect(deleteSnapshot(dir, 'ghost')).toBe(false)
  })
})

describe('pruneSnapshots', () => {
  /** Write a raw snapshot file with a controlled id/createdAt. */
  const mkSnapshot = (dir: string, id: string, createdAt: number): void => {
    writeFileSync(join(snapshotsDir(dir), `${id}.json`), JSON.stringify({
      id,
      createdAt,
      files: [{ path: 'package.json', json: { name: id } }],
    }))
  }

  it('createProfileSnapshot prunes to the cap — only the newest snapshots survive', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    // Pre-seed 25 snapshots (newest seed last) with controlled timestamps so
    // the survivor set is deterministic regardless of wall-clock speed.
    mkdirSync(snapshotsDir(dir), { recursive: true })
    for (let i = 1; i <= 25; i += 1) {
      const id = `snapshot-seed-${String(i).padStart(2, '0')}`
      mkSnapshot(dir, id, i * 1000)
    }

    // Creating one more snapshot with cap 2 must drop the 24 oldest seeds.
    const snapshot = mustCreateProfileSnapshot(dir, 2)

    const remaining = listSnapshots(dir)
    // The freshly created snapshot is the newest; the newest seed survives.
    expect(remaining.map(s => s.id)).toEqual([snapshot.id, 'snapshot-seed-25'])
    expect(readdirSync(snapshotsDir(dir)).filter(name => name.endsWith('.json'))).toHaveLength(2)
  })

  it('keeps the two newest sequence ids across three same-millisecond saves with cap two', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-29T12:34:56.789Z'))
    try {
      const first = mustCreateProfileSnapshot(dir, 2)
      const second = mustCreateProfileSnapshot(dir, 2)
      const third = mustCreateProfileSnapshot(dir, 2)
      expect(second.id).not.toBe(first.id)
      expect(third.id).not.toBe(second.id)
      expect(listSnapshots(dir).map(snapshot => snapshot.id)).toEqual([third.id, second.id])
      expect(existsSync(join(snapshotsDir(dir), `${third.id}.json`))).toBe(true)
      expect(existsSync(join(snapshotsDir(dir), `${second.id}.json`))).toBe(true)
      expect(existsSync(join(snapshotsDir(dir), `${first.id}.json`))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('orders double-digit same-millisecond sequences numerically before public pruning', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-29T12:34:56.789Z'))
    try {
      const ids = Array.from({ length: 12 }, () => mustCreateProfileSnapshot(dir, 20).id)
      expect(ids.every(id => id !== '')).toBe(true)
      expect(listSnapshots(dir).map(snapshot => snapshot.id)).toEqual([...ids].reverse())

      expect(pruneSnapshots(dir, 2)).toEqual(ids.slice(0, -2).reverse())
      expect(listSnapshots(dir).map(snapshot => snapshot.id)).toEqual(ids.slice(-2).reverse())
    } finally {
      vi.useRealTimers()
    }
  })

  it('totally orders mixed equal-time ids across permutations and public pruning', () => {
    const base = 'snapshot-2026-08-29T12-34-56-789Z'
    const newest = `${base}-10`
    const previous = `${base}-9`
    const nonstandard = `${base}-10x`
    const permutations = [
      [newest, previous, nonstandard],
      [newest, nonstandard, previous],
      [previous, newest, nonstandard],
      [previous, nonstandard, newest],
      [nonstandard, newest, previous],
      [nonstandard, previous, newest],
    ]

    for (const [index, ids] of permutations.entries()) {
      expect([...ids].sort(compareSnapshotIdsNewest)).toEqual([newest, previous, nonstandard])

      const dir = pdir(`mixed-${index}`)
      writeProfile(dir, SAMPLE_MANIFEST)
      mkdirSync(snapshotsDir(dir), { recursive: true })
      for (const id of ids) mkSnapshot(dir, id, 1_000)
      expect(pruneSnapshots(dir, 2)).toEqual([nonstandard])
      expect(listSnapshots(dir).map(snapshot => snapshot.id)).toEqual([newest, previous])
    }
  })

  it('prunes oldest-first and returns the dropped ids', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    mkdirSync(snapshotsDir(dir), { recursive: true })
    for (let i = 1; i <= 5; i += 1) {
      mkSnapshot(dir, `snapshot-${i}`, i * 1000)
    }

    const dropped = pruneSnapshots(dir, 2)
    // pruneSnapshots lists the dropped ids in listSnapshots order, i.e.
    // newest-first among the dropped: the 3 oldest are removed, newest of
    // those first.
    expect(dropped).toEqual(['snapshot-3', 'snapshot-2', 'snapshot-1'])
    expect(listSnapshots(dir).map(s => s.id)).toEqual(['snapshot-5', 'snapshot-4'])
  })

  it('is a no-op when at or under the cap', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    mustCreateProfileSnapshot(dir, 5)
    expect(pruneSnapshots(dir, 5)).toEqual([])
    expect(pruneSnapshots(dir, 99)).toEqual([])
    expect(listSnapshots(dir)).toHaveLength(1)
  })
})
