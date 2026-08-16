/**
 * #20 bug 2: a modules directory built by one pnpm major fails mutation
 * under another (ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF); pnpm's own remedy is
 * "run pnpm install to recreate the modules directory". The market does
 * that automatically — one `install` in the profile, then retry the original
 * command once — instead of surfacing a wall of text to a novice user.
 */

import { describe, expect, it } from 'vitest'
import type { InstallResult } from '../src/dsh-cli.ts'
import { withHoistRecovery } from '../src/install.ts'

const HOIST_DIFF: InstallResult = {
  exitCode: 1, timedOut: false, stdout: '', cancelled: false,
  stderr: 'ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF  This modules directory was created using a different public-hoist-pattern value. Run "pnpm install" to recreate the modules directory.',
}
const OK: InstallResult = { exitCode: 0, timedOut: false, stdout: '', stderr: '', cancelled: false }

function scriptedRunner(script: InstallResult[]): { calls: string[][]; run: (profile: string, args: string[]) => Promise<InstallResult> } {
  const calls: string[][] = []
  return {
    calls,
    run: (_profile, args) => {
      calls.push(args)
      return Promise.resolve(script[calls.length - 1] ?? OK)
    },
  }
}

describe('withHoistRecovery', () => {
  it('passes clean results and unrelated failures straight through — recovery is drift-only', async () => {
    const clean = scriptedRunner([OK])
    expect((await withHoistRecovery(clean.run, 'web', ['add', 'dsh-loop'])).exitCode).toBe(0)
    expect(clean.calls).toEqual([['add', 'dsh-loop']])

    const OTHER_FAIL: InstallResult = { exitCode: 1, timedOut: false, stdout: '', stderr: 'ELIFECYCLE build failed', cancelled: false }
    const other = scriptedRunner([OTHER_FAIL])
    expect((await withHoistRecovery(other.run, 'web', ['add', 'dsh-loop'])).exitCode).toBe(1)
    // The failed run still probes the store for orphaned staging dirs.
    expect(other.calls).toEqual([['add', 'dsh-loop'], ['store', 'path']])
  })

  it('recovers from hoist-pattern drift: rebuild the modules dir, retry once, succeed', async () => {
    const { calls, run } = scriptedRunner([HOIST_DIFF, OK, OK])
    const result = await withHoistRecovery(run, 'web', ['add', 'dsh-loop'])
    expect(result.exitCode).toBe(0)
    expect(calls).toEqual([
      ['add', 'dsh-loop'],
      ['install', '--no-frozen-lockfile'],
      ['add', 'dsh-loop'],
    ])
  })

  it('gives up cleanly: no retry after a failed rebuild, one attempt max, bilingual explanation appended', async () => {
    // Rebuild itself fails → the original failure stands, no retry.
    const FAILED_REBUILD: InstallResult = { exitCode: 1, timedOut: false, stdout: '', stderr: 'install failed', cancelled: false }
    const short = scriptedRunner([HOIST_DIFF, FAILED_REBUILD])
    expect((await withHoistRecovery(short.run, 'web', ['add', 'dsh-loop'])).exitCode).not.toBe(0)
    expect(short.calls).toEqual([['add', 'dsh-loop'], ['install', '--no-frozen-lockfile'], ['store', 'path']])

    // Retry fails again → stop (no loops) and surface the bilingual message (#20 bug 3).
    const { calls, run } = scriptedRunner([HOIST_DIFF, OK, HOIST_DIFF])
    const result = await withHoistRecovery(run, 'web', ['add', 'dsh-loop'])
    expect(result.exitCode).not.toBe(0)
    expect(calls.length).toBe(4)
    expect(calls[3]).toEqual(['store', 'path'])
    expect(result.stderr).toMatch(/重建|rebuilt/)
  })
})

describe('transient network retry (#83)', () => {
  const TRANSIENT: InstallResult = {
    exitCode: 1, timedOut: false, stdout: '', cancelled: false,
    stderr: 'WARN  GET https://codeload.github.com/KinGao294/dsh-skin/tar.gz/abc error (ERR_PNPM_FETCH_502). Will retry in 10 seconds.\nFetchError: request to https://codeload.github.com/KinGao294/dsh-skin/tar.gz/abc failed, reason: socket hang up',
  }

  it('retries once when pnpm trips over a momentary network failure, and succeeds silently', async () => {
    const { calls, run } = scriptedRunner([TRANSIENT, OK])
    const result = await withHoistRecovery(run, 'web', ['add', 'dsh-deepseek-billing'])
    expect(result.exitCode).toBe(0)
    expect(calls).toEqual([['add', 'dsh-deepseek-billing'], ['add', 'dsh-deepseek-billing']])
  })

  it('gives up after one retry with the bilingual replay explanation — no loops', async () => {
    const { calls, run } = scriptedRunner([TRANSIENT, TRANSIENT, TRANSIENT])
    const result = await withHoistRecovery(run, 'web', ['add', 'dsh-deepseek-billing'])
    expect(result.exitCode).toBe(1)
    // One retry, then the store probe for orphaned staging dirs.
    expect(calls).toHaveLength(3)
    expect(calls[2]).toEqual(['store', 'path'])
    // The message tells the user the failing dep is not necessarily the
    // plugin they were installing (#83's core confusion).
    expect(result.stderr).toContain('重放整个依赖树')
  })
})
