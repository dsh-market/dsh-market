/**
 * Registry-source parsing and install-target derivation — the security
 * boundary between curated registry URLs and what gets passed to pnpm.
 */

import { describe, expect, it } from 'vitest'
import {
  githubRefOfTarget,
  findCatalogEntryForLocal, findInstalledAlias, gitAllowBuildsKey, githubRemoteIdentities, githubRepoIdentities, githubRepoIdentity, githubTargetAtCommit,
  installTargetFor, isLocalSpec, lookupRepoFromUrl, parseGitHubRemote, parseGitHubRepository, parseSourceUrl, repoOf, restoreBlockedByWorkspace, restoreTargetForLocal, workspaceProtocolDeps,
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
  const tarball = 'https://github.com/o/r/releases/download/v1.2.3/dsh-loop-1.2.3.tgz'

  it('prefers curated npm, then a prebuilt release tarball, before github source', () => {
    expect(installTargetFor({ url: 'https://github.com/o/r', npm: 'dsh-loop', tarball })).toBe('dsh-loop')
    expect(installTargetFor({ url: 'https://github.com/o/r', npm: '@scope/pkg' })).toBe('@scope/pkg')
    expect(installTargetFor({ url: 'https://github.com/o/r', tarball })).toBe(tarball)
    // A malformed npm name is not a way past the tarball rules: it fails the
    // name check, and the archive still has to be this repo's own.
    expect(installTargetFor({ url: 'https://github.com/o/r', npm: 'evil;rm -rf', tarball })).toBe(tarball)
    expect(installTargetFor({ url: 'https://github.com/o/r/tree/main/packages/x' }))
      .toBe('github:o/r#path:/packages/x')
    expect(installTargetFor({ url: 'https://github.com/o/r' })).toBe('github:o/r')
    expect(installTargetFor({ url: 'https://gitlab.com/o/r', tarball })).toBeNull()
  })

  it('refuses non-release, foreign, insecure, and malformed tarball targets', () => {
    for (const rejected of [
      'https://github.com/o/r/archive/main.tar.gz',
      'https://example.com/dsh-loop.tgz',
      'http://github.com/o/r/releases/download/v1/dsh-loop.tgz',
      'https://github.com/o/r/releases/download/v1/dsh-loop.zip',
      '--config.ignore-scripts=false',
    ]) {
      expect(installTargetFor({ url: 'https://github.com/o/r', tarball: rejected })).toBe('github:o/r')
    }
  })

  /** The npm branch is repo-verified against name squatting; the tarball
   * branch has to be too, or a trusted-looking entry installs a stranger's
   * archive. Each of these is a real archive at a real GitHub Release — the
   * only thing wrong with it is whose. */
  it('refuses a release archive that is not the entry repo own', () => {
    for (const foreign of [
      'https://github.com/evil/repo/releases/download/v1/p.tgz',
      'https://github.com/o/other/releases/download/v1/p.tgz',
      'https://github.com/evil/r/releases/download/v1/p.tgz',
      // No owner or repo anywhere in the path, so nothing to bind to.
      'https://objects.githubusercontent.com/whatever/x.tgz',
      'https://release-assets.githubusercontent.com/github-production-release-asset/file.tar.gz',
    ]) {
      expect(installTargetFor({ url: 'https://github.com/o/r', tarball: foreign })).toBe('github:o/r')
    }
  })

  it('accepts the entry own release archive whatever the case, as GitHub does', () => {
    const mixed = 'https://github.com/O/R/releases/download/v1/p.tgz'
    expect(installTargetFor({ url: 'https://github.com/o/r', tarball: mixed })).toBe(mixed)
    // A monorepo entry still binds on the repo, not the subpath.
    const own = 'https://github.com/o/r/releases/latest/download/x.tgz'
    expect(installTargetFor({ url: 'https://github.com/o/r/tree/main/packages/x', tarball: own })).toBe(own)
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

describe('githubRefOfTarget (#446)', () => {
  it('reads the branch or tag an install actually names', () => {
    expect(githubRefOfTarget('github:o/r#publish')).toBe('publish')
    expect(githubRefOfTarget('github:o/r#v2.1.0')).toBe('v2.1.0')
    // pnpm allows a ref and a subpath in one fragment.
    expect(githubRefOfTarget('github:o/r#publish&path:/packages/p')).toBe('publish')
    expect(githubRefOfTarget('github:o/r#path:/packages/p&publish')).toBe('publish')
  })

  it('answers null where the default branch is the right question', () => {
    expect(githubRefOfTarget('github:o/r')).toBeNull()
    expect(githubRefOfTarget('github:o/r#path:/packages/p')).toBeNull()
    // A pin: "is there something newer" means the default branch, and
    // resolving the pin as a ref would compare a commit against itself.
    expect(githubRefOfTarget(`github:o/r#${'a'.repeat(40)}`)).toBeNull()
    // A semver range selects a release line the ref advertisement cannot
    // answer; treating it as a branch name would look up a ref that is not
    // there and report no update at all.
    expect(githubRefOfTarget('github:o/r#semver:^1.2.0')).toBeNull()
    // Not a github spec.
    expect(githubRefOfTarget('dsh-loop@1.0.0')).toBeNull()
    expect(githubRefOfTarget('https://example.test/x.tgz')).toBeNull()
  })
})

describe('findCatalogEntryForLocal', () => {
  const plugins = [
    { name: 'dsh-loop', npm: 'dsh-loop', url: 'https://github.com/o/dsh-loop' },
    { name: 'dsh-vision-bridge', npm: null, url: 'https://github.com/ximengxiaolan/dsh-vision-bridge' },
    { name: 'dsh-vision-bridge', npm: null, url: 'https://github.com/GXX182/dsh-vision-bridge' },
  ]

  it('matches a unique name when there is no repo evidence', () => {
    expect(findCatalogEntryForLocal(plugins, 'dsh-loop')?.url).toBe('https://github.com/o/dsh-loop')
  })

  it('lets a declared repo identity pick the right same-named fork', () => {
    expect(findCatalogEntryForLocal(plugins, 'dsh-vision-bridge', ['gxx182/dsh-vision-bridge'])?.url)
      .toBe('https://github.com/GXX182/dsh-vision-bridge')
  })

  it('does not guess among same-named forks without identities or a matching hint', () => {
    expect(findCatalogEntryForLocal(plugins, 'dsh-vision-bridge')).toBeNull()
  })

  it('uses a git-origin hint only to break a same-name tie', () => {
    expect(findCatalogEntryForLocal(plugins, 'dsh-vision-bridge', [], ['ximengxiaolan/dsh-vision-bridge'])?.url)
      .toBe('https://github.com/ximengxiaolan/dsh-vision-bridge')
  })

  it('does not let a collection-root identity select a sibling /tree/ entry', () => {
    const mono = [
      { name: 'mono#plug-a', npm: null, url: 'https://github.com/m/mono/tree/main/packages/plug-a' },
      { name: 'mono#plug-b', npm: null, url: 'https://github.com/m/mono/tree/main/packages/plug-b' },
      { name: 'mono', npm: null, url: 'https://github.com/m/mono' },
    ]
    // A bare root identity cannot say WHICH package the checkout is, so it
    // must not fall through to the collection-root row while /tree/ siblings
    // exist — guessing would install the wrong plugin.
    expect(findCatalogEntryForLocal(mono, 'plug-a', ['m/mono'])).toBeNull()
    expect(findCatalogEntryForLocal(mono, 'plug-a', ['m/mono#path:/packages/plug-b'])?.name).toBe('mono#plug-b')
    expect(findCatalogEntryForLocal(mono, 'plug-a', ['m/mono', 'm/mono#path:/packages/plug-a'])?.name).toBe('mono#plug-a')
  })

  it('lets a bare root identity select a root row whose name matches the checkout', () => {
    const mono = [
      { name: 'mono#plug-a', npm: null, url: 'https://github.com/m/mono/tree/main/packages/plug-a' },
      { name: 'mono-cli', npm: null, url: 'https://github.com/m/mono' },
    ]
    expect(findCatalogEntryForLocal(mono, 'mono-cli', ['m/mono'])?.name).toBe('mono-cli')
  })
})

describe('restoreTargetForLocal', () => {
  it('appends repository.directory onto a collection-root catalog target', () => {
    const entry = { url: 'https://github.com/Jesse-njx/dsh-cowork', npm: null }
    expect(restoreTargetForLocal(entry, ['jesse-njx/dsh-cowork', 'jesse-njx/dsh-cowork#path:/packages/dsh']))
      .toBe('github:Jesse-njx/dsh-cowork#path:/packages/dsh')
  })

  it('does not invent a path for a single-package catalog row', () => {
    expect(restoreTargetForLocal({ url: 'https://github.com/o/dsh-loop', npm: 'dsh-loop' }, ['o/dsh-loop']))
      .toBe('dsh-loop')
  })

  it('treats Link:/FILE: as local specs', () => {
    expect(isLocalSpec('link:../x')).toBe(true)
    expect(isLocalSpec('FILE:/tmp/x.tgz')).toBe(true)
    expect(isLocalSpec('^1.0.0')).toBe(false)
  })

  it('blocks git restores when the checkout still has workspace: dependencies', () => {
    expect(workspaceProtocolDeps({ dependencies: { '@dsh-cowork/core': 'workspace:^' } })).toEqual(['@dsh-cowork/core'])
    expect(workspaceProtocolDeps({
      optionalDependencies: { 'optional-peer': 'workspace:*' },
      peerDependencies: { 'peer-peer': 'workspace:^1.0.0' },
    })).toEqual(['optional-peer', 'peer-peer'])
    expect(workspaceProtocolDeps({ dependencies: {}, devDependencies: { dev: 'workspace:*' } })).toEqual([])
    expect(restoreBlockedByWorkspace('github:Jesse-njx/dsh-cowork#path:/packages/dsh', ['@dsh-cowork/core'])).toBe(true)
    expect(restoreBlockedByWorkspace('@dsh-cowork/plugin', ['@dsh-cowork/core'])).toBe(false)
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

    const sha = 'b0e6c57ebeeb4796017864f5cd5c66e6ba0899ec'
    const pinned = { 'plug-a': `github:m/mono#${sha}&path:/packages/plug-a` }
    expect(findInstalledAlias(siblingB, pinned)).toBeNull()
    expect(findInstalledAlias(sameA, pinned)).toBe('plug-a')
  })
})

describe('githubTargetAtCommit', () => {
  const sha = 'b0e6c57ebeeb4796017864f5cd5c66e6ba0899ec'

  it('replaces the revision while preserving one valid monorepo subpath', () => {
    expect(githubTargetAtCommit('github:o/r', sha)).toBe(`github:o/r#${sha}`)
    expect(githubTargetAtCommit('github:o/r#main', sha)).toBe(`github:o/r#${sha}`)
    expect(githubTargetAtCommit('github:o/r#main&path:/packages/x', sha))
      .toBe(`github:o/r#${sha}&path:/packages/x`)
  })

  it('refuses non-github targets and invalid commits', () => {
    expect(githubTargetAtCommit('dsh-loop', sha)).toBeNull()
    expect(githubTargetAtCommit('github:o/r', 'short')).toBeNull()
  })
})

describe('lookupRepoFromUrl (display/lookup only — NOT for install/rollback)', () => {
  it('extracts repo from catalog Release asset URLs', () => {
    expect(lookupRepoFromUrl('https://github.com/owner/repo/releases/latest/download/plugin-1.0.0.tgz'))
      .toBe('https://github.com/owner/repo')
    expect(lookupRepoFromUrl('https://github.com/owner/repo/releases/download/v1.0.0/plugin-1.0.0.tgz'))
      .toBe('https://github.com/owner/repo')
    expect(lookupRepoFromUrl('https://github.com/owner/repo/releases/download/v1.0.0/plugin-1.0.0.tar.gz'))
      .toBe('https://github.com/owner/repo')
  })

  it('returns null for non-Release-asset URLs', () => {
    expect(lookupRepoFromUrl('https://github.com/owner/repo/archive/refs/heads/main.tar.gz')).toBeNull()
    expect(lookupRepoFromUrl('https://codeload.github.com/owner/repo/tar.gz/' + 'a'.repeat(40))).toBeNull()
    expect(lookupRepoFromUrl('dsh-loop')).toBeNull()
    expect(lookupRepoFromUrl('@scope/pkg')).toBeNull()
  })
})
