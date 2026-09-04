/**
 * Real-pnpm compat matrix (`npm run test:compat`): pins the failure
 * signatures behind issues #20/#21/#22 against actual pnpm 9/10/11 in
 * throwaway profile fixtures, and proves the market's argv decision works on
 * every combination. Needs network; several minutes on a cold npx cache.
 *
 * Publish dates in the minimumReleaseAge tests are immutable npm history
 * (is-odd@3.0.0 → 2018-05-30, 3.0.1 → 2018-05-31), so the derived age
 * window is deterministic forever.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyPnpmFailure, pluginArgsFor } from '../src/pnpm-compat.ts'

/** Last release of each major the market supports; behavior is per-major. */
const PNPM = { 9: '9.15.9', 10: '10.28.2', 11: '11.21.0' } as const
/** Version pinned by the DSH Desktop 2.0.3 distribution reported in #385. */
const DESKTOP_PNPM = '11.8.0'
const GIT_FIXTURE_SHA = '6ebf1e03de0ada9e653d1f8ff82ad905ab761ad9'

const dirs: string[] = []
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true }) })

/** Profile fixture mirroring the stock web profile template (workspace root) or a bare one. */
function profileFixture(options: { workspace: boolean; extraWorkspaceYaml?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-compat-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'package.json'), '{"name":"dsh-profile-fixture","private":true}')
  if (options.workspace) {
    writeFileSync(join(dir, 'pnpm-workspace.yaml'),
      `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n${options.extraWorkspaceYaml ?? ''}`)
  }
  return dir
}

function pnpm(version: string, args: string[], cwd: string): { code: number | null; out: string } {
  // `npx` is a cmd shim on Windows and cannot be spawned directly without a
  // shell. Keep argument arrays on both platforms; no package target is ever
  // interpolated into a command string.
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npx'
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npx', '-y', `pnpm@${version}`, ...args]
    : ['-y', `pnpm@${version}`, ...args]
  const r = spawnSync(command, commandArgs, {
    cwd, encoding: 'utf8', timeout: 240_000,
    env: { ...process.env, CI: 'true', COREPACK_ENABLE_STRICT: '0' },
  })
  const spawnError = r.error === undefined ? '' : `\n${r.error.name}: ${r.error.message}`
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${spawnError}` }
}

function installedVersion(dir: string, name: string): string | null {
  const manifest = join(dir, 'node_modules', name, 'package.json')
  if (!existsSync(manifest)) return null
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version ?? null
}

describe('#20 bug 1 — workspace-root add without -w', () => {
  it('pnpm 9 refuses with ERR_PNPM_ADDING_TO_ROOT (why the market injects -w at all)', () => {
    const dir = profileFixture({ workspace: true })
    const { code, out } = pnpm(PNPM[9], ['add', 'is-odd@3.0.1'], dir)
    expect(code).not.toBe(0)
    expect(out).toContain('ERR_PNPM_ADDING_TO_ROOT')
    expect(classifyPnpmFailure(out)?.code).toBe('adding-to-root')
  })

  it('pnpm 10 accepts it (the refusal is a pnpm-9-only behavior)', () => {
    const dir = profileFixture({ workspace: true })
    const { code } = pnpm(PNPM[10], ['add', 'is-odd@3.0.1'], dir)
    expect(code, `pnpm ${PNPM[10]}`).toBe(0)
  })

  it('pnpm 11 accepts it (the refusal is a pnpm-9-only behavior)', () => {
    const dir = profileFixture({ workspace: true })
    const { code } = pnpm(PNPM[11], ['add', 'is-odd@3.0.1'], dir)
    expect(code, `pnpm ${PNPM[11]}`).toBe(0)
  })
})

describe('#20 — -w outside a workspace is a hard error on EVERY major', () => {
  it('all three majors refuse --workspace-root without pnpm-workspace.yaml', () => {
    for (const version of Object.values(PNPM)) {
      const dir = profileFixture({ workspace: false })
      const { code, out } = pnpm(version, ['add', '-w', 'is-odd@3.0.1'], dir)
      expect(code, `pnpm ${version}`).not.toBe(0)
      expect(out).toMatch(/workspace-root may only be used inside a workspace/i)
      expect(classifyPnpmFailure(out)?.code).toBe('not-a-workspace')
    }
  })
})

describe('the market argv decision works on every pnpm major × profile shape', () => {
  it('pluginArgsFor-derived add succeeds everywhere', () => {
    for (const version of Object.values(PNPM)) {
      for (const workspace of [true, false]) {
        const dir = profileFixture({ workspace })
        const args = pluginArgsFor(dir, ['add', 'is-odd@3.0.1'])
        const { code, out } = pnpm(version, args, dir)
        expect(code, `pnpm ${version} workspace=${String(workspace)} args=${args.join(' ')}\n${out.slice(-400)}`).toBe(0)
        expect(installedVersion(dir, 'is-odd')).toBe('3.0.1')
      }
    }
  })
})

describe('#385 — pnpm keeps a commit-pinned github shortcut inside its git-hosted trust boundary', () => {
  it('installs on Desktop and current pnpm, then survives the next dependency mutation', () => {
    for (const version of [DESKTOP_PNPM, PNPM[11]]) {
      const dir = profileFixture({ workspace: true })
      const target = `github:pnpm/test-git-fetch#${GIT_FIXTURE_SHA}`

      const installed = pnpm(version, ['add', '-w', '--ignore-scripts', target], dir)
      expect(installed.code, `pnpm ${version}\n${installed.out.slice(-600)}`).toBe(0)

      const lockfile = readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')
      expect(lockfile).toContain(`codeload.github.com/pnpm/test-git-fetch/tar.gz/${GIT_FIXTURE_SHA}`)
      expect(lockfile).toContain('gitHosted: true')

      // A prefix-proxied codeload URL loses that marker and #385 fails here
      // with ERR_PNPM_MISSING_TARBALL_INTEGRITY. The pinned github shortcut
      // remains valid when pnpm verifies the whole lockfile on a later add.
      // Keep this compatibility probe about lockfile integrity. The fixture
      // deliberately has a prepare script, whose separate allowBuilds policy
      // would otherwise stop the second command before this assertion.
      const mutation = pnpm(version, ['add', '-w', '--ignore-scripts', 'is-odd@3.0.1'], dir)
      expect(mutation.code, `pnpm ${version}\n${mutation.out.slice(-600)}`).toBe(0)
      expect(mutation.out).not.toContain('ERR_PNPM_MISSING_TARBALL_INTEGRITY')
    }
  })

  it('repairs the orphaned proxy lock entry left by a failed Desktop install', () => {
    const dir = profileFixture({ workspace: true })
    const target = `github:pnpm/test-git-fetch#${GIT_FIXTURE_SHA}`
    const canonical = `https://codeload.github.com/pnpm/test-git-fetch/tar.gz/${GIT_FIXTURE_SHA}`
    const proxied = `https://gh-proxy.com/${canonical}`

    const seed = pnpm(DESKTOP_PNPM, ['add', '-w', '--ignore-scripts', target], dir)
    expect(seed.code, seed.out.slice(-600)).toBe(0)

    // Recreate the durable state left by v1.34 after the failed install:
    // package.json was restored, but pnpm's prefix-proxy resolution remained
    // orphaned in the lockfile without its git-hosted trust marker.
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
    manifest.dependencies = {}
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    const lockPath = join(dir, 'pnpm-lock.yaml')
    const poisoned = readFileSync(lockPath, 'utf8')
      .replaceAll(canonical, proxied)
      .replaceAll('gitHosted: true, ', '')
    expect(poisoned).toContain(proxied)
    expect(poisoned).not.toContain('gitHosted: true')
    writeFileSync(lockPath, poisoned)

    const repaired = pnpm(DESKTOP_PNPM, ['add', '-w', '--ignore-scripts', target], dir)
    expect(repaired.code, repaired.out.slice(-600)).toBe(0)
    const repairedLock = readFileSync(lockPath, 'utf8')
    expect(repairedLock).not.toContain('gh-proxy.com')
    expect(repairedLock).toContain(canonical)
    expect(repairedLock).toContain('gitHosted: true')

    const mutation = pnpm(DESKTOP_PNPM, ['add', '-w', '--ignore-scripts', 'is-odd@3.0.1'], dir)
    expect(mutation.code, mutation.out.slice(-600)).toBe(0)
    expect(mutation.out).not.toContain('ERR_PNPM_MISSING_TARBALL_INTEGRITY')
  })
})

describe('#20 bug 2 — modules dir built by pnpm 9, mutated by pnpm 11', () => {
  it('fails with a modules-layout mismatch, and one `install` + retry recovers', () => {
    const dir = profileFixture({ workspace: true })
    const seed = pnpm(PNPM[9], ['add', '-w', 'is-odd@3.0.1'], dir)
    expect(seed.code, seed.out.slice(-400)).toBe(0)

    const drift = pnpm(PNPM[11], ['add', '-w', 'is-even@1.0.0'], dir)
    expect(drift.code).not.toBe(0)
    expect(drift.out).toMatch(/ERR_PNPM_(?:PUBLIC_HOIST_PATTERN|VIRTUAL_STORE_DIR_MAX_LENGTH)_DIFF/)
    const failure = classifyPnpmFailure(drift.out)
    expect(failure?.code).toBe('hoist-pattern-diff')
    expect(failure?.recoverable).toBe(true)

    // pnpm's documented remedy — the exact recovery the market automates.
    // --no-frozen-lockfile: under CI=true the old major's lockfile is refused.
    const rebuild = pnpm(PNPM[11], ['install', '--no-frozen-lockfile'], dir)
    expect(rebuild.code, rebuild.out.slice(-400)).toBe(0)
    const retry = pnpm(PNPM[11], ['add', '-w', 'is-even@1.0.0'], dir)
    expect(retry.code, retry.out.slice(-400)).toBe(0)
    expect(installedVersion(dir, 'is-even')).toBe('1.0.0')
  })
})

/** Minutes such that is-odd@3.0.1 (2018-05-31) is "too young" but 3.0.0 (2018-05-30) is mature. */
function ageWindowMinutes(): number {
  const cutoff = Date.parse('2018-05-31T07:00:00Z') // between the two publish instants
  return Math.round((Date.now() - cutoff) / 60_000)
}

describe('#21/#22 — minimumReleaseAge resolution traps', () => {
  it('a dist-tag add silently resolves to an OLD version and exits 0 (the #21/#22 silent trap)', () => {
    const dir = profileFixture({ workspace: true, extraWorkspaceYaml: `minimumReleaseAge: ${String(ageWindowMinutes())}\n` })
    const { code } = pnpm(PNPM[11], ['add', 'is-odd'], dir)
    expect(code).toBe(0) // clean exit…
    expect(installedVersion(dir, 'is-odd')).toBe('3.0.0') // …but NOT the latest (3.0.1)
  })

  it('an exact too-young version fails loudly with ERR_PNPM_NO_MATURE_MATCHING_VERSION', () => {
    const dir = profileFixture({ workspace: true, extraWorkspaceYaml: `minimumReleaseAge: ${String(ageWindowMinutes())}\n` })
    const { code, out } = pnpm(PNPM[11], ['add', 'is-odd@3.0.1'], dir)
    expect(code).not.toBe(0)
    expect(out).toContain('ERR_PNPM_NO_MATURE_MATCHING_VERSION')
  })
})

describe('#39 — a too-young lockfile entry blocks every later mutation', () => {
  it('remove fails ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION on pnpm 11; the one-shot override recovers', () => {
    const dir = profileFixture({ workspace: true, extraWorkspaceYaml: `minimumReleaseAge: ${String(ageWindowMinutes())}\n` })
    // A young release lands in the lockfile via the bypass (force-update path).
    const seed = pnpm(PNPM[11], ['add', '-w', '--config.minimumReleaseAge=0', 'is-odd@3.0.1'], dir)
    expect(seed.code, seed.out.slice(-400)).toBe(0)

    // pnpm verifies the WHOLE lockfile before applying the mutation — even
    // removing the young package itself fails.
    const blocked = pnpm(PNPM[11], ['remove', '-w', 'is-odd'], dir)
    expect(blocked.code).not.toBe(0)
    expect(blocked.out).toContain('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION')
    expect(classifyPnpmFailure(blocked.out)?.code).toBe('release-age-violation')

    // The recovery the market automates: same command + the one-shot override.
    const recovered = pnpm(PNPM[11], ['remove', '-w', '--config.minimumReleaseAge=0', 'is-odd'], dir)
    expect(recovered.code, recovered.out.slice(-400)).toBe(0)
    expect(installedVersion(dir, 'is-odd')).toBeNull()
  })

  it('the override flag is harmless on pnpm 9/10 remove', () => {
    for (const version of [PNPM[9], PNPM[10]]) {
      const dir = profileFixture({ workspace: true })
      expect(pnpm(version, ['add', '-w', 'is-odd@3.0.0'], dir).code, `pnpm ${version} add`).toBe(0)
      const removed = pnpm(version, ['remove', '-w', '--config.minimumReleaseAge=0', 'is-odd'], dir)
      expect(removed.code, `pnpm ${version}: ${removed.out.slice(-300)}`).toBe(0)
    }
  })
})
