/**
 * The release-age gate is one phenomenon with two faces (#39, #531): an
 * explicit pin fails with an error the wrapper can classify and retry, while
 * a floating name resolves to the newest MATURE version, exits 0, and says
 * nothing. The market must recover from the first on every command it issues
 * itself, must notice the second, and must not describe a retry that never ran.
 */

import { describe, expect, it } from 'vitest'
import type { InstallResult } from '../src/dsh-cli.ts'
import { RELEASE_AGE_OVERRIDE, withHoistRecovery } from '../src/install.ts'
import { classifyPnpmFailure } from '../src/pnpm-compat.ts'
import { heldInstallVersion } from '../src/updates.ts'

const OK: InstallResult = { exitCode: 0, timedOut: false, stdout: '', stderr: '', cancelled: false }

const AGE_STDERR = '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:\n'
  + '  dsh-loop@1.2.0 was published at 2026-09-16T11:51:27.530Z, within the minimumReleaseAge cutoff'

describe('release-age recovery scope', () => {
  it('retries the market own install with the one-shot bypass (#39 follow-up)', async () => {
    // pnpm verifies the WHOLE lockfile before any mutation, so the market's
    // rollback/rebuild install is the one command that can fail purely because
    // a young release is in the lockfile — and it was the only command the
    // release-age branch did not cover.
    const calls: string[][] = []
    let first = true
    const run = async (_profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      if (first) {
        first = false
        return { ...OK, exitCode: 1, stderr: AGE_STDERR }
      }
      return OK
    }
    const result = await withHoistRecovery(run, 'web', ['install', '--no-frozen-lockfile'])
    expect(result.exitCode).toBe(0)
    expect(calls).toEqual([
      ['install', '--no-frozen-lockfile'],
      ['install', RELEASE_AGE_OVERRIDE, '--no-frozen-lockfile'],
    ])
  })

  it('still retries add and remove exactly once (#39)', async () => {
    const calls: string[][] = []
    let first = true
    const run = async (_profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      if (first) {
        first = false
        return { ...OK, exitCode: 1, stderr: AGE_STDERR }
      }
      return OK
    }
    await withHoistRecovery(run, 'web', ['remove', 'dsh-loop'])
    expect(calls).toEqual([['remove', 'dsh-loop'], ['remove', RELEASE_AGE_OVERRIDE, 'dsh-loop']])
  })

  it('does not promise a retry in the copy — that claim belongs to the attempt', () => {
    const hit = classifyPnpmFailure(AGE_STDERR)
    expect(hit?.code).toBe('release-age-violation')
    // The classifier also runs on the FINAL output, where the retry may have
    // been skipped (argv[0] not in the retry set) or already failed. Asserting
    // a retry from here was the copy-vs-fact gap reported for the install shape.
    expect(hit?.message).not.toMatch(/已自动放行/)
    // It still names the remedy the UI can offer on the row.
    expect(hit?.message).toMatch(/立即安装最新版|install the latest anyway/)
  })
})

describe('heldInstallVersion (#531 install half)', () => {
  it('names a silent hold: the catalog version did not land', () => {
    expect(heldInstallVersion('0.4.8', '0.4.5')).toEqual({ expected: '0.4.8', actual: '0.4.5' })
  })

  it('stays quiet when the install reached the catalog version or went past it', () => {
    expect(heldInstallVersion('0.4.8', '0.4.8')).toBeNull()
    expect(heldInstallVersion('0.4.8', '0.4.9')).toBeNull()
  })

  it('stays quiet without evidence — no catalog version, no installed version, unparsable either side', () => {
    expect(heldInstallVersion(null, '0.4.5')).toBeNull()
    expect(heldInstallVersion(undefined, '0.4.5')).toBeNull()
    expect(heldInstallVersion('', '0.4.5')).toBeNull()
    expect(heldInstallVersion('0.4.8', null)).toBeNull()
    expect(heldInstallVersion('0.4.8', '')).toBeNull()
    expect(heldInstallVersion('not-a-version', '0.4.5')).toBeNull()
    expect(heldInstallVersion('0.4.8', 'also-not')).toBeNull()
  })

  it('compares semver properly: a prerelease below its release is a hold, and vice versa', () => {
    expect(heldInstallVersion('1.0.0', '1.0.0-rc.2')).toEqual({ expected: '1.0.0', actual: '1.0.0-rc.2' })
    expect(heldInstallVersion('1.0.0-rc.2', '1.0.0')).toBeNull()
  })
})
