/**
 * Install orchestration with a recording fake runner over real profile
 * fixtures: collection retargeting, the fake-success guard, and update
 * staleness detection (#22's silent no-op).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InstallResult } from '../src/dsh-cli.ts'
import { isStaleUpdate, parseIgnoredBuilds, parsePrepareNotAllowed, retargetCollections, validateAddedPlugins } from '../src/install.ts'
import { profileDir } from '../src/profile.ts'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshm-home-'))
  process.env.DSH_HOME = home
})
afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

const ok: InstallResult = { exitCode: 0, timedOut: false, stdout: '', stderr: '', cancelled: false }

function recordingRunner(): { calls: string[][]; run: (profile: string, args: string[]) => Promise<InstallResult> } {
  const calls: string[][] = []
  return {
    calls,
    run: (_profile, args) => {
      calls.push(args)
      return Promise.resolve(ok)
    },
  }
}

function writeProfile(dependencies: Record<string, string>): string {
  const dir = profileDir('web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies }))
  return dir
}

function writePkg(dir: string, name: string, manifest: unknown, artifacts: string[] = []): void {
  const root = join(dir, 'node_modules', name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
  for (const rel of artifacts) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), '')
  }
}

describe('retargetCollections (#18)', () => {
  it('re-adds each contained plugin via #path:, leaving npm installs and pre-existing packages alone', async () => {
    const dir = writeProfile({ collection: 'github:o/r', existing: 'github:o/old', 'dsh-loop': '^1.0.0' })
    // Root manifest without a dsh surface = collection; two real plugins inside.
    writePkg(dir, 'collection', { name: 'collection', private: true })
    mkdirSync(join(dir, 'node_modules', 'collection', 'theme-a'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'collection', 'theme-a', 'package.json'), '{"dsh":{}}')
    mkdirSync(join(dir, 'node_modules', 'collection', 'packages', 'theme-b'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'collection', 'packages', 'theme-b', 'package.json'), '{"dsh":{}}')
    // 'existing' looks like junk too, but predates this install.
    writePkg(dir, 'existing', { name: 'existing', private: true })

    // npm target → no collection handling at all.
    const npm = recordingRunner()
    expect(await retargetCollections(npm.run, 'web', new Set(), 'dsh-loop')).toBe(true)
    expect(npm.calls).toEqual([])

    const { calls, run } = recordingRunner()
    expect(await retargetCollections(run, 'web', new Set(['existing', 'dsh-loop']), 'github:o/r')).toBe(true)
    expect(calls[0]).toEqual(['remove', 'collection'])
    expect(calls.slice(1).map(c => c[1]).sort()).toEqual([
      'github:o/r#path:/packages/theme-b',
      'github:o/r#path:/theme-a',
    ])
  })

  it('fails when a collection contains no plugins at all', async () => {
    const dir = writeProfile({ junk: 'github:o/r' })
    writePkg(dir, 'junk', { name: 'junk', private: true })
    expect(await retargetCollections(recordingRunner().run, 'web', new Set(), 'github:o/r')).toBe(false)
  })
})

describe('validateAddedPlugins (#18 / #21)', () => {
  it('keeps valid plugins, removes source-only and no-dsh-surface pieces on the spot', async () => {
    const dir = writeProfile({ good: '^1.0.0', broken: 'github:o/broken', dshmarket: '^0.0.1' })
    writePkg(dir, 'good', { dsh: {}, main: 'lib/index.js' }, ['lib/index.js'])
    // Source-only checkout: dsh manifest present but the built artifact is not.
    writePkg(dir, 'broken', { dsh: {}, main: 'lib/index.js' })
    // The #21 placeholder: artifact present but no dsh surface at all.
    writePkg(dir, 'dshmarket', { name: 'dshmarket', version: '0.0.1', main: 'index.js' }, ['index.js'])
    const { calls, run } = recordingRunner()
    const { keep, removedBroken } = await validateAddedPlugins(run, 'web', new Set())
    expect(keep).toEqual(['good'])
    expect(removedBroken.sort()).toEqual(['broken', 'dshmarket'])
    expect(calls.map(c => c.join(' ')).sort()).toEqual(['remove broken', 'remove dshmarket'])
  })
})

describe('isStaleUpdate (#22: clean exit, nothing changed)', () => {
  it('flags silently-kept versions/commits, never a first install', () => {
    // npm: same version after "update" = pnpm minimumReleaseAge kept the old one.
    expect(isStaleUpdate({ isGit: false, beforeVersion: '1.0.3', afterVersion: '1.0.3', beforeCommit: null, afterCommit: null })).toBe(true)
    expect(isStaleUpdate({ isGit: false, beforeVersion: '1.0.3', afterVersion: '1.2.2', beforeCommit: null, afterCommit: null })).toBe(false)
    // git: pinned to the same commit.
    expect(isStaleUpdate({ isGit: true, beforeVersion: null, afterVersion: null, beforeCommit: 'aaa', afterCommit: 'aaa' })).toBe(true)
    expect(isStaleUpdate({ isGit: true, beforeVersion: null, afterVersion: null, beforeCommit: 'aaa', afterCommit: 'bbb' })).toBe(false)
    // First install: no before state, nothing to be stale against.
    expect(isStaleUpdate({ isGit: false, beforeVersion: null, afterVersion: '1.0.0', beforeCommit: null, afterCommit: null })).toBe(false)
    expect(isStaleUpdate({ isGit: true, beforeVersion: null, afterVersion: null, beforeCommit: null, afterCommit: 'aaa' })).toBe(false)
  })
})

describe('parseIgnoredBuilds (#6)', () => {
  it('extracts names from pnpm output, stripping versions and the trailing period', () => {
    expect(parseIgnoredBuilds('Ignored build scripts: esbuild@0.25.0, koffi.', ''))
      .toEqual(['esbuild', 'koffi'])
    expect(parseIgnoredBuilds('', 'warn Ignored build scripts: @scope/pkg@1.0.0'))
      .toEqual(['@scope/pkg'])
    expect(parseIgnoredBuilds('all good', '')).toEqual([])
  })

  it('strips git/codeload source suffixes the same way as versions (#69)', () => {
    expect(parseIgnoredBuilds('', 'Ignored build scripts: dsh-github-intelligence@https://codeload.github.com/z/r/tar.gz/abc.'))
      .toEqual(['dsh-github-intelligence'])
  })
})

describe('parsePrepareNotAllowed (#68)', () => {
  const STDERR = '[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from "https://codeload.github.com/z/r/tar.gz/abc": The git-hosted package "dsh-github-intelligence@2.8.0" needs to execute build scripts but is not in the "allowBuilds" allowlist.'
  it('extracts the rejected package name, stripping the version', () => {
    expect(parsePrepareNotAllowed('', STDERR)).toBe('dsh-github-intelligence')
    expect(parsePrepareNotAllowed(STDERR.replace('dsh-github-intelligence@2.8.0', '@scope/pkg@1.0.0'), ''))
      .toBe('@scope/pkg')
  })
  it('returns null for anything else', () => {
    expect(parsePrepareNotAllowed('all good', '')).toBeNull()
    expect(parsePrepareNotAllowed('', 'Ignored build scripts: esbuild.')).toBeNull()
  })
})
