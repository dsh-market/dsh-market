/**
 * Real-pnpm compat matrix (`npm run test:compat`): pins the failure
 * signatures behind issues #20/#21/#22 against actual pnpm 9/10/11/12 in
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
import { RELEASE_AGE_OVERRIDE } from '../src/install.ts'
import { readLockCommits } from '../src/profile.ts'
import { classifyPnpmFailure, pluginArgsFor } from '../src/pnpm-compat.ts'

/** Last release of each major the market supports; behavior is per-major. */
const PNPM = { 9: '9.15.9', 10: '10.28.2', 11: '11.21.0', 12: '12.4.1' } as const
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

function pnpm(version: string, args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): { code: number | null; out: string } {
  // `npx` is a cmd shim on Windows and cannot be spawned directly without a
  // shell. Keep argument arrays on both platforms; no package target is ever
  // interpolated into a command string.
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npx'
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npx', '-y', `pnpm@${version}`, ...args]
    : ['-y', `pnpm@${version}`, ...args]
  const r = spawnSync(command, commandArgs, {
    cwd, encoding: 'utf8', timeout: 240_000,
    env: { ...process.env, CI: 'true', COREPACK_ENABLE_STRICT: '0', ...extraEnv },
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

const GIT_FIXTURE_REPO = 'pnpm/test-git-fetch'

/** Lock shapes for `github:owner/repo#sha` — older pnpm used codeload tarballs
 *  with `gitHosted: true`; current pnpm writes `git+https` / `git+ssh` /
 *  `type: git`. */
function githubShortcutLockShape(lockfile: string, sha: string): {
  hasCodeload: boolean
  hasGitUrl: boolean
} {
  return {
    hasCodeload: lockfile.includes(`codeload.github.com/${GIT_FIXTURE_REPO}/tar.gz/${sha}`),
    hasGitUrl: lockfile.includes(`git+https://github.com/${GIT_FIXTURE_REPO}.git#${sha}`)
      || lockfile.includes(`git+ssh://git@github.com/${GIT_FIXTURE_REPO}.git#${sha}`)
      || (lockfile.includes(GIT_FIXTURE_REPO) && lockfile.includes('type: git') && lockfile.includes(sha)),
  }
}

/** Prefix-proxied codeload lock entry without `gitHosted` — the durable
 *  orphan v1.34 left behind. Hand-written so the probe does not depend on
 *  current pnpm's lock shape. */
function orphanedProxyLockfile(proxied: string): string {
  return [
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    '  autoInstallPeers: false',
    '  excludeLinksFromLockfile: false',
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    '      test-git-fetch:',
    `        specifier: ${proxied}`,
    `        version: ${proxied}`,
    '',
    'packages:',
    '',
    `  test-git-fetch@${proxied}:`,
    `    resolution: {tarball: ${proxied}}`,
    '    version: 1.0.0',
    '',
    'snapshots:',
    '',
    `  test-git-fetch@${proxied}: {}`,
    '',
  ].join('\n')
}

describe('#385 — pnpm keeps a commit-pinned github shortcut inside its git-hosted trust boundary', () => {
  it('installs on Desktop and current pnpm, then survives the next dependency mutation', () => {
    for (const version of [DESKTOP_PNPM, PNPM[11]]) {
      const dir = profileFixture({ workspace: true })
      const target = `github:${GIT_FIXTURE_REPO}#${GIT_FIXTURE_SHA}`

      const installed = pnpm(version, ['add', '-w', '--ignore-scripts', target], dir)
      expect(installed.code, `pnpm ${version}\n${installed.out.slice(-600)}`).toBe(0)

      const lockfile = readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')
      const { hasCodeload, hasGitUrl } = githubShortcutLockShape(lockfile, GIT_FIXTURE_SHA)
      expect(hasCodeload || hasGitUrl, `pnpm ${version} lock shape:\n${lockfile.slice(0, 800)}`).toBe(true)
      if (hasCodeload) expect(lockfile).toContain('gitHosted: true')

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
    const target = `github:${GIT_FIXTURE_REPO}#${GIT_FIXTURE_SHA}`
    const canonical = `https://codeload.github.com/${GIT_FIXTURE_REPO}/tar.gz/${GIT_FIXTURE_SHA}`
    const proxied = `https://gh-proxy.com/${canonical}`
    const lockPath = join(dir, 'pnpm-lock.yaml')
    const manifestPath = join(dir, 'package.json')

    // Hand-write the bricked profile: manifest + lock both name a
    // prefix-proxied codeload tarball without gitHosted. Current pnpm writes
    // git+https/ssh, so poisoning a live seed cannot recreate this mode.
    const poisoned = orphanedProxyLockfile(proxied)
    expect(poisoned).toContain(proxied)
    expect(poisoned).not.toContain('gitHosted: true')
    writeFileSync(lockPath, poisoned)
    writeFileSync(manifestPath, JSON.stringify({
      name: 'dsh-profile-fixture',
      private: true,
      dependencies: { 'test-git-fetch': proxied },
    }))

    const before = pnpm(DESKTOP_PNPM, ['add', '-w', '--ignore-scripts', 'is-odd@3.0.1'], dir)
    expect(before.out).toContain('ERR_PNPM_MISSING_TARBALL_INTEGRITY')

    // v1.34 restored package.json after the failed install but left the
    // proxied lock entry behind.
    writeFileSync(manifestPath, JSON.stringify({ name: 'dsh-profile-fixture', private: true }))

    const repaired = pnpm(DESKTOP_PNPM, ['add', '-w', '--ignore-scripts', target], dir)
    expect(repaired.code, repaired.out.slice(-600)).toBe(0)
    const repairedLock = readFileSync(lockPath, 'utf8')
    expect(repairedLock).not.toContain('gh-proxy.com')
    const repairedShape = githubShortcutLockShape(repairedLock, GIT_FIXTURE_SHA)
    expect(repairedShape.hasCodeload || repairedShape.hasGitUrl).toBe(true)
    if (repairedShape.hasCodeload) expect(repairedLock).toContain('gitHosted: true')

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
    const seed = pnpm(PNPM[11], ['add', '-w', RELEASE_AGE_OVERRIDE, 'is-odd@3.0.1'], dir)
    expect(seed.code, seed.out.slice(-400)).toBe(0)

    // pnpm verifies the WHOLE lockfile before applying the mutation — even
    // removing the young package itself fails.
    const blocked = pnpm(PNPM[11], ['remove', '-w', 'is-odd'], dir)
    expect(blocked.code).not.toBe(0)
    expect(blocked.out).toContain('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION')
    expect(classifyPnpmFailure(blocked.out)?.code).toBe('release-age-violation')

    // The recovery the market automates: same command + the one-shot override.
    const recovered = pnpm(PNPM[11], ['remove', '-w', RELEASE_AGE_OVERRIDE, 'is-odd'], dir)
    expect(recovered.code, recovered.out.slice(-400)).toBe(0)
    expect(installedVersion(dir, 'is-odd')).toBeNull()
  })

  it('add fails the same way on pnpm 12, and only the kebab-case override recovers (#600)', () => {
    const dir = profileFixture({ workspace: true, extraWorkspaceYaml: `minimumReleaseAge: ${String(ageWindowMinutes())}\n` })
    const seed = pnpm(PNPM[12], ['add', '-w', RELEASE_AGE_OVERRIDE, 'is-odd@3.0.1'], dir)
    expect(seed.code, seed.out.slice(-400)).toBe(0)

    // pnpm 12 re-applies the policy to the loaded lockfile before adding
    // anything: a mature, unrelated package is refused because of the young
    // one already there. Removing the young package itself passes on 12 (the
    // lockfile it leaves behind is clean), so `add` is what pins the trap.
    const blocked = pnpm(PNPM[12], ['add', '-w', 'is-even@1.0.0'], dir)
    expect(blocked.code).not.toBe(0)
    expect(blocked.out).toContain('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION')
    expect(classifyPnpmFailure(blocked.out)?.code).toBe('release-age-violation')

    // What the market passed before #600. pnpm 11 accepted it; the native
    // CLI from 12.3.0 ignores it without an "unknown option" error, so the
    // retry failed exactly like the first attempt.
    const ignored = pnpm(PNPM[12], ['add', '-w', '--config.minimumReleaseAge=0', 'is-even@1.0.0'], dir)
    expect(ignored.code).not.toBe(0)
    expect(ignored.out).toContain('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION')
    expect(installedVersion(dir, 'is-even')).toBeNull()

    const recovered = pnpm(PNPM[12], ['add', '-w', RELEASE_AGE_OVERRIDE, 'is-even@1.0.0'], dir)
    expect(recovered.code, recovered.out.slice(-400)).toBe(0)
    expect(installedVersion(dir, 'is-even')).toBe('1.0.0')
  })

  it('the override flag is harmless on pnpm 9/10 remove', () => {
    for (const version of [PNPM[9], PNPM[10]]) {
      const dir = profileFixture({ workspace: true })
      expect(pnpm(version, ['add', '-w', 'is-odd@3.0.0'], dir).code, `pnpm ${version} add`).toBe(0)
      const removed = pnpm(version, ['remove', '-w', RELEASE_AGE_OVERRIDE, 'is-odd'], dir)
      expect(removed.code, `pnpm ${version}: ${removed.out.slice(-300)}`).toBe(0)
    }
  })
})

describe('a dead file: dependency blocks the whole profile (#436)', () => {
  // @screamff could not uninstall the market until they removed an unrelated
  // plugin that had been installed from a .tgz they had since deleted. pnpm
  // re-resolves every direct dependency before any mutation, so one dead
  // local path stops everything — and the error names the PATH, never the
  // package, which is why it read as unrelated to what they were doing.
  for (const version of [PNPM[10], PNPM[11]]) {
    it(`pnpm ${version} refuses to remove an unrelated package, and the market names the cause`, () => {
      const dir = profileFixture({ workspace: true })
      expect(pnpm(version, ['add', '-w', 'is-odd@3.0.0'], dir).code).toBe(0)
      const manifestPath = join(dir, 'package.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
      const ghost = join(dir, 'gone', 'ghost-plugin-1.0.0.tgz')
      manifest.dependencies = { ...manifest.dependencies, 'ghost-plugin': `file:${ghost}` }
      writeFileSync(manifestPath, JSON.stringify(manifest))

      const blocked = pnpm(version, ['remove', '-w', 'is-odd'], dir)

      expect(blocked.code, blocked.out.slice(-400)).not.toBe(0)
      const failure = classifyPnpmFailure(blocked.out, blocked.code)
      expect(failure?.code, blocked.out.slice(-400)).toBe('missing-local-dependency')
      // The path is the only handle the user has: it is the literal value of
      // the offending line in their package.json.
      expect(failure?.message).toContain('ghost-plugin-1.0.0.tgz')
    }, 300_000)
  }
})

describe('#615 — pnpm 12 ignores some --config.<key> flags on the command line; PNPM_CONFIG_<KEY> is read', () => {
  /** A workspace profile WITHOUT autoInstallPeers, so the flag is what decides. */
  function peerFixture(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-compat-peers-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'package.json'), '{"name":"dsh-profile-fixture","private":true}')
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\n')
    return dir
  }

  it('pnpm 12.4 auto-installs the peer despite --config.auto-install-peers=false, and honours the variable', () => {
    const flagged = peerFixture()
    const withFlag = pnpm(PNPM[12], ['add', '-w', '--config.auto-install-peers=false', 'use-sync-external-store@1.2.2'], flagged)
    expect(withFlag.code, withFlag.out.slice(-400)).toBe(0)
    // The flag the market's #289 retry relied on did nothing here.
    expect(installedVersion(flagged, 'react')).not.toBeNull()

    const viaEnv = peerFixture()
    const withVar = pnpm(PNPM[12], ['add', '-w', 'use-sync-external-store@1.2.2'], viaEnv, { PNPM_CONFIG_AUTO_INSTALL_PEERS: 'false' })
    expect(withVar.code, withVar.out.slice(-400)).toBe(0)
    expect(installedVersion(viaEnv, 'react')).toBeNull()
  })

  it('pnpm 11 reads both the flag and the variable', () => {
    const flagged = peerFixture()
    expect(pnpm(PNPM[11], ['add', '-w', '--config.auto-install-peers=false', 'use-sync-external-store@1.2.2'], flagged).code).toBe(0)
    expect(installedVersion(flagged, 'react')).toBeNull()

    const viaEnv = peerFixture()
    expect(pnpm(PNPM[11], ['add', '-w', 'use-sync-external-store@1.2.2'], viaEnv, { PNPM_CONFIG_AUTO_INSTALL_PEERS: 'false' }).code).toBe(0)
    expect(installedVersion(viaEnv, 'react')).toBeNull()
  })
})

/**
 * #637 — the host shorthands pnpm writes back into package.json.
 *
 * Two things are pinned here per major, because the market reads both and
 * neither is guessable from the docs: the manifest pnpm leaves behind (the
 * shorthand, whatever spelling the install was typed as), and the archive URL
 * it resolves to, which is where the commit lives. The URL is NOT stable
 * across majors — 9 and 10 fetch GitLab through the REST API
 * (`/api/v4/projects/<owner>%2F<repo>/repository/archive.tar.gz?sha=`) while
 * 11 and 12 take the project archive (`/-/archive/<sha>/`) — so what is
 * asserted is the identity the market derives, not the string.
 *
 * `--lockfile-only`: the commit is in the lockfile, and none of these
 * repositories needs to be extracted or built to prove it.
 */
describe('#637 — host shorthands resolve to an archive whose URL carries the commit', () => {
  // gitlab-org/gitlab-svgs, not a nested group: pnpm 9 percent-encodes only
  // the last separator and 404s on `group/subgroup/repo`, which is a bug in
  // that major, not something the market can read its way out of.
  const SHORTHANDS = [
    { spec: 'gitlab:gitlab-org/gitlab-svgs', key: 'gitlab.com/gitlab-org/gitlab-svgs' },
    { spec: 'bitbucket:atlassian/aui', key: 'bitbucket.org/atlassian/aui' },
  ] as const

  it('writes the shorthand back and records a readable commit on every major', () => {
    for (const version of [...Object.values(PNPM), DESKTOP_PNPM]) {
      for (const { spec, key } of SHORTHANDS) {
        const dir = profileFixture({ workspace: false })
        const added = pnpm(version, ['add', '--lockfile-only', spec], dir)
        expect(added.code, `pnpm ${version} ${spec}\n${added.out.slice(-600)}`).toBe(0)

        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
          dependencies?: Record<string, string>
        }
        expect(Object.values(manifest.dependencies ?? {}), `pnpm ${version} manifest`).toEqual([spec])

        const commit = readLockCommits('ignored', dir).get(key)
        expect(commit, `pnpm ${version} ${spec} lock:\n${readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8').slice(0, 700)}`)
          .toMatch(/^[0-9a-f]{40}$/)
      }
    }
  })
})
