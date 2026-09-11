/**
 * Tests for cleanupTmpDirsInNodeModules: defensive cleanup of stale pnpm
 * temp directories before install, to prevent EPERM rename failures on
 * Windows after interrupted installs.
 *
 * Coverage:
 * - no-op when node_modules does not exist
 * - removes stale top-level tmp dirs with dead pids
 * - skips tmp dirs whose pid is still alive
 * - scans .pnpm/<pkg>@<ver>/node_modules/ for nested tmp dirs
 * - does not throw on unreadable directories
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupTmpDirsInNodeModules } from '../src/dsh-cli.ts'

let profileDir: string

beforeEach(() => {
  profileDir = mkdtempSync(join(tmpdir(), 'dsh-test-'))
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
})

afterEach(() => {
  rmSync(profileDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('cleanupTmpDirsInNodeModules', () => {
  it('does nothing when node_modules does not exist', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'dsh-empty-'))
    expect(() => cleanupTmpDirsInNodeModules(emptyDir)).not.toThrow()
    rmSync(emptyDir, { recursive: true, force: true })
  })

  it('removes stale top-level tmp dirs with dead pids', () => {
    const tmpDir = join(profileDir, 'node_modules', 'node-hid_tmp_99999_abc123')
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, 'package.json'), '{}')

    cleanupTmpDirsInNodeModules(profileDir)

    expect(() => mkdirSync(tmpDir)).not.toThrow() // dir was removed, can recreate
  })

  it('skips tmp dirs whose pid is still alive', () => {
    // Use the current process pid — it is definitely alive
    const livePid = process.pid
    const tmpDir = join(profileDir, 'node_modules', `node-hid_tmp_${livePid}_abc123`)
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, 'package.json'), '{}')

    cleanupTmpDirsInNodeModules(profileDir)

    // Dir should still exist because pid is alive
    expect(() => mkdirSync(tmpDir)).toThrow() // EEXIST means dir still there
  })

  it('scans .pnpm/<pkg>@<ver>/node_modules/ for nested tmp dirs', () => {
    const nestedTmp = join(profileDir, 'node_modules', '.pnpm', 'node-hid@2.1.2', 'node_modules', 'node-hid_tmp_99998_def456')
    mkdirSync(nestedTmp, { recursive: true })
    writeFileSync(join(nestedTmp, 'index.js'), 'module.exports = {}')

    cleanupTmpDirsInNodeModules(profileDir)

    expect(() => mkdirSync(nestedTmp)).not.toThrow() // nested dir was removed
  })

  it('does not throw on unreadable nested node_modules', () => {
    // Create a .pnpm dir without node_modules — should be skipped gracefully
    mkdirSync(join(profileDir, 'node_modules', '.pnpm', 'some-pkg@1.0.0'), { recursive: true })

    expect(() => cleanupTmpDirsInNodeModules(profileDir)).not.toThrow()
  })

  it('treats tmp dirs without pid pattern as stale (no liveness check possible)', () => {
    const tmpDir = join(profileDir, 'node_modules', 'some-package_tmp_nopid')
    mkdirSync(tmpDir, { recursive: true })

    cleanupTmpDirsInNodeModules(profileDir)

    expect(() => mkdirSync(tmpDir)).not.toThrow() // dir was removed
  })
})
