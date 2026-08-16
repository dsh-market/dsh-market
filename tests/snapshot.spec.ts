/**
 * Unit tests for profile snapshots (issue #98, phase 3) — src/snapshot.ts.
 * Snapshot capture / list / restore / delete, exercised against per-test
 * tmpdir fixtures (same pattern as tests/check.spec.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createProfileSnapshot,
  deleteSnapshot,
  listSnapshots,
  pruneSnapshots,
  restoreSnapshot,
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

    const snapshot = createProfileSnapshot(dir)
    expect(snapshot).not.toBeNull()
    expect(snapshot?.id).toMatch(/^snapshot-/)
    expect(typeof snapshot?.createdAt).toBe('number')
    // Known composition files, package.json first.
    expect(snapshot?.files.map(f => f.path)).toEqual(['package.json', 'cordis.patch.yml', '.dsh-market/state.json'])
    // JSON documents keep their parsed form; line-oriented files keep their lines.
    expect(snapshot?.files[0]?.json).toEqual(SAMPLE_MANIFEST)
    expect(snapshot?.files[1]?.lines?.join('\n')).toBe(SAMPLE_PATCH)
    expect(snapshot?.files[2]?.json).toEqual({ disabled: ['p1'], groups: {}, groupOrder: [] })

    // Persisted under <profile>/.dsh-market/snapshots/<id>.json.
    const file = join(snapshotsDir(dir), `${snapshot?.id}.json`)
    expect(existsSync(file)).toBe(true)
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { id: string; files: { path: string }[] }
    expect(stored.id).toBe(snapshot?.id)
    expect(stored.files.map(f => f.path)).toEqual(['package.json', 'cordis.patch.yml', '.dsh-market/state.json'])
  })

  it('returns null when package.json is missing or unparseable', () => {
    const dir = pdir()
    expect(createProfileSnapshot(dir)).toBeNull()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{ nope')
    expect(createProfileSnapshot(dir)).toBeNull()
  })

  it('still snapshots when the optional files are absent', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    const snapshot = createProfileSnapshot(dir)
    expect(snapshot?.files.map(f => f.path)).toEqual(['package.json'])
  })

  it('assigns distinct ids to consecutive snapshots', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    const a = createProfileSnapshot(dir)
    const b = createProfileSnapshot(dir)
    expect(a?.id).not.toBe(b?.id)
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
    const good = createProfileSnapshot(dir)
    writeFileSync(join(snapshotsDir(dir), 'snapshot-corrupt.json'), 'not json at all')

    const list = listSnapshots(dir)
    expect(list.map(s => s.id)).toEqual([good?.id])
  })
})

describe('restoreSnapshot', () => {
  it('restores every captured file from memory', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
    writeFileSync(join(dir, 'cordis.patch.yml'), SAMPLE_PATCH)
    writeFileSync(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ disabled: ['p1'], groups: {}, groupOrder: [] }))
    const snapshot = createProfileSnapshot(dir)
    expect(snapshot).not.toBeNull()

    // Mutate all three files after the snapshot was taken.
    writeProfile(dir, { name: 'changed', dsh: { profile: { bundles: ['beta'] } } })
    writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n  - id: beta\n    name: beta\n')
    writeFileSync(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ disabled: ['p2'], groups: {}, groupOrder: [] }))

    const result = restoreSnapshot(dir, snapshot?.id ?? '')
    expect(result.ok).toBe(true)
    expect(result.restored).toEqual(['package.json', 'cordis.patch.yml', '.dsh-market/state.json'])
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).toEqual(SAMPLE_MANIFEST)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(SAMPLE_PATCH)
    expect(JSON.parse(readFileSync(join(dir, '.dsh-market', 'state.json'), 'utf8'))).toEqual({ disabled: ['p1'], groups: {}, groupOrder: [] })
  })

  it('restores a snapshot containing only package.json', () => {
    const dir = pdir()
    writeProfile(dir, SAMPLE_MANIFEST)
    const snapshot = createProfileSnapshot(dir)
    writeProfile(dir, { name: 'changed' })

    const result = restoreSnapshot(dir, snapshot?.id ?? '')
    expect(result.ok).toBe(true)
    expect(result.restored).toEqual(['package.json'])
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).toEqual(SAMPLE_MANIFEST)
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
    const snapshot = createProfileSnapshot(dir)
    const file = join(snapshotsDir(dir), `${snapshot?.id}.json`)
    expect(existsSync(file)).toBe(true)

    expect(deleteSnapshot(dir, snapshot?.id ?? '')).toBe(true)
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
    const snapshot = createProfileSnapshot(dir, 2)
    expect(snapshot).not.toBeNull()

    const remaining = listSnapshots(dir)
    // The freshly created snapshot is the newest; the newest seed survives.
    expect(remaining.map(s => s.id)).toEqual([snapshot?.id, 'snapshot-seed-25'])
    expect(readdirSync(snapshotsDir(dir)).filter(name => name.endsWith('.json'))).toHaveLength(2)
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
    createProfileSnapshot(dir, 5)
    expect(pruneSnapshots(dir, 5)).toEqual([])
    expect(pruneSnapshots(dir, 99)).toEqual([])
    expect(listSnapshots(dir)).toHaveLength(1)
  })
})
