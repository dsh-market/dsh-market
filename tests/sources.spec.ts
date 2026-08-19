/**
 * Registry-source parsing and install-target derivation — the security
 * boundary between curated registry URLs and what gets passed to pnpm.
 */

import { describe, expect, it } from 'vitest'
import {
  findInstalledAlias, gitAllowBuildsKey, githubRemoteIdentities, githubRepoIdentities, githubRepoIdentity,
  installTargetFor, parseGitHubRemote, parseGitHubRepository, parseSourceUrl, repoOf,
} from '../src/sources.ts'

describe('parseSourceUrl', () => {
  it('accepts github repo urls, plain or with a /tree/<branch>/<subpath> suffix', () => {
    expect(parseSourceUrl('https://github.com/owner/repo')).toEqual({ repo: 'owner/repo', subpath: null })
    expect(parseSourceUrl('https://github.com/owner/repo/')).toEqual({ repo: 'owner/repo', subpath: null })
    expect(parseSourceUrl('https://github.com/o/r/tree/main/packages/theme-x'))
      .toEqual({ repo: 'o/r', subpath: 'packages/theme-x' })
    expect(repoOf('https://github.com/o/r/tree/main/sub')).toBe('o/r')
  })

  it('rejects foreign hosts, malformed urls, traversal, and charset violations', () => {
    expect(parseSourceUrl('https://evil.com/owner/repo')).toBeNull()
    expect(parseSourceUrl('https://github.com/onlyowner')).toBeNull()
    expect(parseSourceUrl('https://github.com/o/r/tree/main/../../etc')).toBeNull()
    expect(parseSourceUrl('https://github.com/o/r/tree/main/pkg%20name')).toBeNull()
    expect(parseSourceUrl('https://github.com/o/r/tree/main/pkg;rm')).toBeNull()
    expect(repoOf('nonsense')).toBeNull()
  })
})

describe('local GitHub source identity (#141)', () => {
  it('normalizes package and git remote forms without exposing transport details', () => {
    expect(parseGitHubRemote('https://github.com/GXX182/dsh-vision-bridge.git'))
      .toEqual({ repo: 'GXX182/dsh-vision-bridge' })
    expect(parseGitHubRemote('git+https://github.com/GXX182/dsh-vision-bridge.git'))
      .toEqual({ repo: 'GXX182/dsh-vision-bridge' })
    expect(parseGitHubRemote('git@github.com:GXX182/dsh-vision-bridge.git'))
      .toEqual({ repo: 'GXX182/dsh-vision-bridge' })
    expect(parseGitHubRemote('ssh://git@github.com/GXX182/dsh-vision-bridge.git'))
      .toEqual({ repo: 'GXX182/dsh-vision-bridge' })
    expect(parseGitHubRepository('owner/repo')).toEqual({ repo: 'owner/repo' })
    expect(parseGitHubRepository('github:owner/repo')).toEqual({ repo: 'owner/repo' })
    expect(parseGitHubRepository('git+ssh://git@github.com/Owner/Repo.git'))
      .toEqual({ repo: 'Owner/Repo' })
    expect(parseGitHubRemote('https://ghfast.top/https://github.com/Owner/Repo.git'))
      .toEqual({ repo: 'Owner/Repo' })
    expect(parseGitHubRemote('https://gitlab.com/GXX182/dsh-vision-bridge.git')).toBeNull()
  })

  it('builds lowercase, subpath-aware identities and rejects unsafe directories', () => {
    expect(githubRepoIdentity('https://github.com/Owner/Repo.git')).toBe('owner/repo')
    expect(githubRepoIdentity('git@github.com:Owner/Repo.git', 'packages\\Plugin'))
      .toBe('owner/repo#path:/packages/plugin')
    expect(githubRepoIdentity('https://github.com/o/r', '../escape')).toBeNull()
  })

  it('mirrors github:#path matching evidence for local monorepo packages', () => {
    expect(githubRepoIdentities('https://github.com/Owner/Repo.git'))
      .toEqual(['owner/repo'])
    expect(githubRepoIdentities('https://github.com/Owner/Repo.git', 'packages/plugin'))
      .toEqual(['owner/repo', 'owner/repo#path:/packages/plugin'])
    expect(githubRemoteIdentities('git@github.com:Owner/Repo.git', 'packages/plugin'))
      .toEqual(['owner/repo', 'owner/repo#path:/packages/plugin'])
  })
})

describe('installTargetFor', () => {
  it('prefers curated npm, targets subpaths via #path:, falls back to github, refuses the rest', () => {
    expect(installTargetFor({ url: 'https://github.com/o/r', npm: 'dsh-loop' })).toBe('dsh-loop')
    expect(installTargetFor({ url: 'https://github.com/o/r', npm: '@scope/pkg' })).toBe('@scope/pkg')
    // A malformed npm name never reaches pnpm — fall back to the repo.
    expect(installTargetFor({ url: 'https://github.com/o/r', npm: 'evil;rm -rf' })).toBe('github:o/r')
    expect(installTargetFor({ url: 'https://github.com/o/r/tree/main/packages/x' }))
      .toBe('github:o/r#path:/packages/x')
    expect(installTargetFor({ url: 'https://github.com/o/r' })).toBe('github:o/r')
    expect(installTargetFor({ url: 'https://gitlab.com/o/r' })).toBeNull()
  })
})

describe('gitAllowBuildsKey (#68/#69)', () => {
  it('derives the stable git+https key pnpm actually matches for github specs', () => {
    expect(gitAllowBuildsKey('dsh-github-intelligence', 'github:zoahdev/dsh-github-intelligence'))
      .toBe('dsh-github-intelligence@git+https://github.com/zoahdev/dsh-github-intelligence.git')
    // Subpath and ref suffixes belong to the install selector, not the repo.
    expect(gitAllowBuildsKey('plug-a', 'github:m/mono#path:/packages/plug-a'))
      .toBe('plug-a@git+https://github.com/m/mono.git')
    expect(gitAllowBuildsKey('x', 'github:o/r.git')).toBe('x@git+https://github.com/o/r.git')
  })
  it('returns null for non-github specs — npm ranges, links, tarballs', () => {
    expect(gitAllowBuildsKey('dsh-loop', '^1.2.0')).toBeNull()
    expect(gitAllowBuildsKey('dsh-loop', 'link:../dev')).toBeNull()
    expect(gitAllowBuildsKey('dsh-loop', '')).toBeNull()
  })
})

describe('findInstalledAlias (#27 duplicate guard)', () => {
  it('finds the same plugin installed under another name, by repo or npm identity', () => {
    const alias = { name: '@dsh-external/dsh-share', url: 'https://github.com/h/dsh-share' }
    expect(findInstalledAlias(alias, { 'dsh-share': 'github:h/dsh-share' })).toBe('dsh-share')
    expect(findInstalledAlias({ name: 'x', npm: 'dsh-share', url: 'https://github.com/h/other' }, { 'dsh-share': '^0.2.0' })).toBe('dsh-share')
    expect(findInstalledAlias(alias, {})).toBeNull()
  })

  it('never treats a same-named plugin from a DIFFERENT repo as an alias (#66)', () => {
    const installed = { 'dsh-usage-stats': 'github:Make0209/dsh-usage-stats' }
    // Same name, different repo → distinct plugin, not an alias.
    expect(findInstalledAlias(
      { name: 'dsh-usage-stats', url: 'https://github.com/Ychris12138/dsh-usage-stats' }, installed,
    )).toBeNull()
    // Same repo → the entry's own plugin, matched case-insensitively.
    expect(findInstalledAlias(
      { name: 'dsh-usage-stats', url: 'https://github.com/make0209/dsh-usage-stats' }, installed,
    )).toBe('dsh-usage-stats')
  })

  it('keeps monorepo siblings independent but matches the exact subpackage', () => {
    const installed = { 'plug-a': 'github:m/mono#path:/packages/plug-a' }
    const siblingB = { name: 'mono#plug-b', url: 'https://github.com/m/mono/tree/main/packages/plug-b' }
    const sameA = { name: 'mono#plug-a', url: 'https://github.com/m/mono/tree/main/packages/plug-a' }
    expect(findInstalledAlias(siblingB, installed)).toBeNull()
    expect(findInstalledAlias(sameA, installed)).toBe('plug-a')
    // A collection root entry still matches the pieces it was retargeted into.
    expect(findInstalledAlias({ name: 'mono', url: 'https://github.com/m/mono' }, installed)).toBe('plug-a')
  })
})
