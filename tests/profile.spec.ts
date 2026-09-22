/**
 * Profile filesystem reads against real fixture directories (DSH_HOME is
 * pointed at a tmpdir per test).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { resolveDshHome } from '../src/home-paths.ts'
import {
  addProfileBundle, conflictingEntryIds, dropFromManifest, entryArtifactExists, hasDshManifest, hasLoadableEntry, holdsNativeAddon, isDshProfileName, pluginSubdirs, profileDir,
  readDependencyOwners, readGitResolutionCommit, readInstalled, readInstalledManifest, readInstalledRepoEvidence, readInstalledRepoIdentities, readInstalledVersion, readLockCommits,
  removeProfileBundle,
} from '../src/profile.ts'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshm-home-'))
  process.env.DSH_HOME = home
})
afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

function writeProfile(manifest: unknown): string {
  const dir = profileDir('web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  return dir
}

describe('DSH home resolution (dsh-v0.1.2-alpha.1)', () => {
  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', ' \t '],
  ])('treats %s DSH_HOME as unset', (_label, value) => {
    const env = value === undefined ? {} : { DSH_HOME: value }
    const expected = join(homedir(), '.dsh')

    expect(resolveDshHome(undefined, env)).toBe(expected)
    if (value === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = value
    expect(profileDir('web')).toBe(join(expected, 'profiles', 'web'))
    expect(isAbsolute(profileDir('web'))).toBe(true)
  })

  it('normalizes a relative DSH_HOME to an absolute profile path', () => {
    process.env.DSH_HOME = 'relative-dsh-home'
    expect(profileDir('web')).toBe(join(resolve('relative-dsh-home'), 'profiles', 'web'))
    expect(isAbsolute(profileDir('web'))).toBe(true)
  })

  it('expands a tilde DSH_HOME before resolving the profile', () => {
    process.env.DSH_HOME = '~'
    expect(profileDir('web')).toBe(join(homedir(), 'profiles', 'web'))
  })
})

describe('profile names (#260)', () => {
  it('matches the DSH profile directory contract instead of an ASCII-only subset', () => {
    for (const name of ['web', '011-rc.2', '测试001', '工作 profile', 'Профиль-2']) {
      expect(isDshProfileName(name)).toBe(true)
      expect(profileDir(name)).toBe(join(home, 'profiles', name))
    }
  })

  it('still rejects every traversal-shaped or launcher-owned name DSH rejects', () => {
    for (const name of ['', '.', '..', 'node_modules', 'a/b', 'a\\b', 'a\0b']) {
      expect(isDshProfileName(name)).toBe(false)
      expect(() => profileDir(name)).toThrow('invalid profile name')
    }
  })

  it('keeps a host-authoritative Desktop directory independent of its display name', () => {
    const explicit = join(home, 'desktop-owned')
    expect(profileDir('../display-only', explicit)).toBe(explicit)
  })
})

describe('readInstalled', () => {
  it('filters exactly the in-box bundles — scoped COMMUNITY plugins stay (#28)', () => {
    expect(readInstalled('web')).toEqual({})
    writeProfile({ dependencies: {
      'dsh-loop': '^1.0.0',
      '@deepseek-ai/dsh-base': 'latest',
      '@deepseek-ai/dsh-web-app': 'latest',
      '@deepseek-ai/dsh-headless': 'latest',
      // Community plugin published under the official scope (github source).
      '@deepseek-ai/dsh-security-audit': 'github:omdsh-dev/dsh-security-audit',
      dshmarket: '^1.2.3',
    } })
    expect(readInstalled('web')).toEqual({
      'dsh-loop': '^1.0.0',
      '@deepseek-ai/dsh-security-audit': 'github:omdsh-dev/dsh-security-audit',
      dshmarket: '^1.2.3',
    })
  })
})

describe('dropFromManifest (half-uninstall reconcile)', () => {
  it('drops the package from dependencies AND dsh.profile.bundles, leaving every other field untouched', () => {
    writeProfile({
      name: 'web',
      private: true,
      dependencies: { 'dsh-loop': '^1.0.0', other: '^2.0.0' },
      dsh: { profile: { bundles: ['dshmarket', 'dsh-loop'] } },
    })
    expect(dropFromManifest('web', 'dsh-loop')).toBe(true)
    const manifest = JSON.parse(readFileSync(join(profileDir('web'), 'package.json'), 'utf8'))
    expect(manifest.dependencies).toEqual({ other: '^2.0.0' })
    expect(manifest.dsh.profile.bundles).toEqual(['dshmarket'])
    expect(manifest.name).toBe('web')
    expect(manifest.private).toBe(true)
  })

  it('returns false when the manifest never mentioned the package, and fails open when unreadable', () => {
    writeProfile({ dependencies: { other: '^2.0.0' } })
    expect(dropFromManifest('web', 'dsh-loop')).toBe(false)
    expect(dropFromManifest('missing-profile', 'dsh-loop')).toBe(false)
  })
})

describe('readInstalledVersion', () => {
  it('reads the version actually present in node_modules, null when absent', () => {
    const dir = writeProfile({ dependencies: {} })
    mkdirSync(join(dir, 'node_modules', 'dsh-loop'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'dsh-loop', 'package.json'), '{"version":"1.0.3"}')
    expect(readInstalledVersion('web', 'dsh-loop')).toBe('1.0.3')
    expect(readInstalledVersion('web', 'missing')).toBeNull()
  })
})

describe('readInstalledManifest', () => {
  it('reads explicit profile directories and fails open for missing or malformed packages', () => {
    const explicitDir = mkdtempSync(join(tmpdir(), 'dshm-profile-'))
    try {
      const packageDir = join(explicitDir, 'node_modules', 'dsh-loop')
      mkdirSync(packageDir, { recursive: true })
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'dsh-loop', dsh: {} }))
      expect(readInstalledManifest('ignored', 'dsh-loop', explicitDir)).toMatchObject({ name: 'dsh-loop' })
      expect(readInstalledManifest('ignored', 'missing', explicitDir)).toBeNull()
      writeFileSync(join(packageDir, 'package.json'), '{')
      expect(readInstalledManifest('ignored', 'dsh-loop', explicitDir)).toBeNull()
    } finally {
      rmSync(explicitDir, { recursive: true, force: true })
    }
  })
})

describe('holdsNativeAddon (#441)', () => {
  /** Put a package in the profile's node_modules with the given layout. */
  const packageAt = (dir: string, name: string, manifest: unknown, subdirs: string[] = [], files: string[] = []): void => {
    const packageDir = join(dir, 'node_modules', name)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify(manifest))
    for (const sub of subdirs) mkdirSync(join(packageDir, sub), { recursive: true })
    for (const file of files) writeFileSync(join(packageDir, file), '')
  }

  it('finds an addon in a DEPENDENCY, which is where plugins keep theirs', () => {
    // @yandidan1's plugin is JavaScript; node-hid is the addon, hoisted to
    // the profile root beside it. Asking only about the plugin's own
    // directory would answer no for every case this exists to catch.
    const dir = writeProfile({ dependencies: {} })
    packageAt(dir, 'dsh-music-huazai', { name: 'dsh-music-huazai', dependencies: { 'node-hid': '3.4.0' } })
    packageAt(dir, 'node-hid', { name: 'node-hid' }, ['build/Release'])
    expect(holdsNativeAddon('web', 'dsh-music-huazai')).toBe(true)
  })

  it('finds an addon in optionalDependencies, which is how SinglePlayer ships node-hid', () => {
    // @fenglin-dev's 1.44.0 uninstall of SinglePlayer still offered a page
    // refresh: node-hid is optional, and asking only `dependencies` treated
    // the plugin as ordinary JavaScript. The files are not released until
    // the process exits, so that prompt is the one that cannot help.
    const dir = writeProfile({ dependencies: {} })
    packageAt(dir, 'dsh-music-huazai', { name: 'dsh-music-huazai', optionalDependencies: { 'node-hid': '3.4.0' } })
    packageAt(dir, 'node-hid', { name: 'node-hid' }, ['build/Release'])
    expect(holdsNativeAddon('web', 'dsh-music-huazai')).toBe(true)
  })

  it('recognizes all three conventional layouts, on the package itself too', () => {
    const dir = writeProfile({ dependencies: {} })
    packageAt(dir, 'gyp-built', { name: 'gyp-built' }, ['build/Release'])
    packageAt(dir, 'prebuilt', { name: 'prebuilt' }, ['prebuilds'])
    packageAt(dir, 'source-built', { name: 'source-built' }, [], ['binding.gyp'])
    for (const name of ['gyp-built', 'prebuilt', 'source-built']) {
      expect(holdsNativeAddon('web', name), name).toBe(true)
    }
  })

  it('answers no for ordinary JavaScript, and for packages that are not there', () => {
    // A false yes costs the user a restart they did not need, on every
    // uninstall — so plain packages must stay plain.
    const dir = writeProfile({ dependencies: {} })
    packageAt(dir, 'dsh-loop', { name: 'dsh-loop', dependencies: { 'plain-dep': '1.0.0' } }, ['dist', 'lib'])
    packageAt(dir, 'plain-dep', { name: 'plain-dep' }, ['dist'])
    packageAt(dir, 'optional-plain', {
      name: 'optional-plain',
      optionalDependencies: { 'plain-dep': '1.0.0' },
    }, ['dist', 'lib'])
    expect(holdsNativeAddon('web', 'dsh-loop')).toBe(false)
    expect(holdsNativeAddon('web', 'optional-plain')).toBe(false)
    expect(holdsNativeAddon('web', 'never-installed')).toBe(false)
  })

  it('is not confused by a malformed manifest or a junk dependency name', () => {
    const dir = writeProfile({ dependencies: {} })
    const packageDir = join(dir, 'node_modules', 'broken')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), '{')
    expect(holdsNativeAddon('web', 'broken')).toBe(false)
    packageAt(dir, 'odd', { name: 'odd', dependencies: { '../escape': '1.0.0' } })
    expect(holdsNativeAddon('web', 'odd')).toBe(false)
    packageAt(dir, 'odd-optional', { name: 'odd-optional', optionalDependencies: { '../escape': '1.0.0' } })
    expect(holdsNativeAddon('web', 'odd-optional')).toBe(false)
  })
})

describe('readInstalledRepoEvidence (#141)', () => {
  it('reads the repository of an ordinary npm install, which is the only tie-breaker between same-named entries (#544)', () => {
    // @QinYupan: dsh-mermaid installed from npm, two same-named catalog
    // entries, and the Discover card still said Install. The manifest's
    // repository declaration names which of the two is on disk, and it sits
    // in node_modules/<pkg>/package.json for an npm install exactly as it
    // does for a local one — this used to return empty for any spec that
    // was not link:/file:, so the client found two name candidates and
    // matched neither.
    const dir = writeProfile({ dependencies: { 'dsh-mermaid': '^0.4.0' } })
    const installedDir = join(dir, 'node_modules', 'dsh-mermaid')
    mkdirSync(installedDir, { recursive: true })
    writeFileSync(join(installedDir, 'package.json'), JSON.stringify({
      name: 'dsh-mermaid',
      version: '0.4.0',
      repository: { type: 'git', url: 'git+https://github.com/MrmoLabs/dsh-mermaid.git' },
    }))

    expect(readInstalledRepoEvidence('web', 'dsh-mermaid', '^0.4.0'))
      .toEqual({ identities: ['mrmolabs/dsh-mermaid'], hints: [] })
  })

  it('treats a host shorthand as a spec that names its own source (#637)', () => {
    // Same rule as `github:` above, now reached by the two hosts pnpm writes
    // back as shorthands: a gitlab-installed fork almost always still
    // declares the upstream GitHub repository, and trusting that would mark
    // the upstream's Discover card as installed.
    const dir = writeProfile({ dependencies: { 'dsh-plug': 'gitlab:myfork/dsh-plug' } })
    const installedDir = join(dir, 'node_modules', 'dsh-plug')
    mkdirSync(installedDir, { recursive: true })
    writeFileSync(join(installedDir, 'package.json'), JSON.stringify({
      name: 'dsh-plug',
      version: '1.0.0',
      repository: { type: 'git', url: 'git+https://github.com/upstream/dsh-plug.git' },
    }))

    expect(readInstalledRepoEvidence('web', 'dsh-plug', 'gitlab:myfork/dsh-plug'))
      .toEqual({ identities: [], hints: [] })
  })

  it('reads the identity off a proxy-prefixed codeload URL (#432)', () => {
    // What a China-region install actually leaves in the manifest —
    // measured with the current dsh CLI, which keeps the https URL rather
    // than rewriting it to a `file:` spec (the layout #432's fix assumed).
    // No manifest, no checkout: the URL is the only evidence, and it is
    // enough.
    const dir = writeProfile({
      dependencies: {
        'dsh-plug': 'https://gh-proxy.com/https://codeload.github.com/owner/repo/tar.gz/666df7c10035f7e26f27ec214fe5ae3173435f34',
      },
    })
    mkdirSync(join(dir, 'node_modules', 'dsh-plug'), { recursive: true })
    const spec = 'https://gh-proxy.com/https://codeload.github.com/owner/repo/tar.gz/666df7c10035f7e26f27ec214fe5ae3173435f34'
    expect(readInstalledRepoEvidence('web', 'dsh-plug', spec))
      .toEqual({ identities: ['owner/repo'], hints: [] })
    // A direct codeload install (no region) behaves the same.
    expect(readInstalledRepoEvidence('web', 'dsh-plug',
      'https://codeload.github.com/owner/repo/tar.gz/666df7c10035f7e26f27ec214fe5ae3173435f34').identities)
      .toEqual(['owner/repo'])
  })

  it('does NOT read the manifest for a spec that already names its source (#544/#548)', () => {
    // A fork installed as github:myfork/plugin almost always still declares
    // the UPSTREAM repository, because nobody edits that field when forking.
    // Trusting it would add the upstream as an identity and mark the
    // upstream's Discover card as installed — a weaker signal outvoting a
    // definite one, which is #485's mistake. The first version of the #544
    // fix widened to every spec kind and had exactly that hole.
    const dir = writeProfile({ dependencies: { 'dsh-plug': 'github:myfork/dsh-plug' } })
    const installedDir = join(dir, 'node_modules', 'dsh-plug')
    mkdirSync(installedDir, { recursive: true })
    writeFileSync(join(installedDir, 'package.json'), JSON.stringify({
      name: 'dsh-plug',
      repository: { type: 'git', url: 'git+https://github.com/upstream/dsh-plug.git' },
    }))

    // The property is "the manifest never supplies the identity here", and
    // the sharpest way to state it is the fork's own repo — NOT an empty
    // list. Emptiness was how this was written while the spec contributed
    // nothing at all; now that it does (#432), empty would also mean a
    // URL-installed plugin has no identity, which is the bug being fixed.
    const fork = readInstalledRepoEvidence('web', 'dsh-plug', 'github:myfork/dsh-plug')
    expect(fork.identities).toEqual(['myfork/dsh-plug'])
    expect(fork.identities).not.toContain('upstream/dsh-plug')
    // A Release archive states its own source too — and it is the fork's.
    const asset = readInstalledRepoEvidence('web', 'dsh-plug', 'https://github.com/myfork/dsh-plug/releases/download/v1/p.tgz')
    expect(asset.identities).not.toContain('upstream/dsh-plug')
    // A host this build cannot parse yields nothing rather than a guess.
    expect(readInstalledRepoEvidence('web', 'dsh-plug', 'git+https://gitea.example/me/dsh-plug.git'))
      .toEqual({ identities: [], hints: [] })
  })

  it('reads package.json repository metadata, including monorepo directories', () => {
    const target = mkdtempSync(join(tmpdir(), 'dshm-link-'))
    try {
      writeProfile({ dependencies: { 'local-plugin': `link:${target}` } })
      writeFileSync(join(target, 'package.json'), JSON.stringify({
        name: 'local-plugin',
        repository: {
          type: 'git',
          url: 'git+https://github.com/Owner/Repo.git',
          directory: 'packages/local-plugin',
        },
      }))
      expect(readInstalledRepoIdentities('web', 'local-plugin', `link:${target}`))
        .toEqual(['owner/repo', 'owner/repo#path:/packages/local-plugin'])
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('falls back to the linked checkout origin and derives its subpath', () => {
    const repo = mkdtempSync(join(tmpdir(), 'dshm-repo-'))
    const target = join(repo, 'packages', 'local-plugin')
    try {
      writeProfile({ dependencies: { 'local-plugin': `link:${target}` } })
      mkdirSync(join(repo, '.git'), { recursive: true })
      mkdirSync(target, { recursive: true })
      writeFileSync(join(repo, '.git', 'config'), [
        '[core]',
        '\trepositoryformatversion = 0',
        '[remote "origin"]',
        '\turl = https://ghfast.top/https://github.com/GXX182/dsh-vision-bridge.git',
      ].join('\n'))
      writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'local-plugin' }))
      expect(readInstalledRepoIdentities('web', 'local-plugin', `link:${target}`)).toEqual([])
      expect(readInstalledRepoEvidence('web', 'local-plugin', `link:${target}`))
        .toEqual({ identities: [], hints: ['gxx182/dsh-vision-bridge', 'gxx182/dsh-vision-bridge#path:/packages/local-plugin'] })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('fails open when neither manifest nor Git metadata identifies the source', () => {
    const target = mkdtempSync(join(tmpdir(), 'dshm-plain-'))
    try {
      writeProfile({ dependencies: { 'local-plugin': `file:${target}` } })
      writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'local-plugin' }))
      expect(readInstalledRepoIdentities('web', 'local-plugin', `file:${target}`)).toEqual([])
      expect(readInstalledRepoIdentities('web', 'local-plugin', '^1.0.0')).toEqual([])
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })
})

describe('readDependencyOwners (#634)', () => {
  function installPackage(name: string, manifest: Record<string, unknown>): void {
    const dir = join(profileDir('web'), 'node_modules', ...name.split('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }))
  }

  it('names the installed package that declares each of the others', () => {
    writeProfile({})
    installPackage('dsh-office', {
      dsh: {},
      dependencies: { '@univer/engine-binding': '1.0.0' },
      peerDependencies: { '@univer/exchange-binding': '0.1.1' },
    })
    installPackage('@univer/engine-binding', {})
    installPackage('@univer/exchange-binding', {})
    installPackage('dsh-loop', { dsh: {} })

    const owners = readDependencyOwners('web', ['dsh-office', '@univer/engine-binding', '@univer/exchange-binding', 'dsh-loop'])

    expect(owners['@univer/engine-binding']).toBe('dsh-office')
    // A peer dependency is what pnpm's auto-install-peers writes into the
    // profile manifest, so it counts as ownership too.
    expect(owners['@univer/exchange-binding']).toBe('dsh-office')
    // A plugin nobody declares stays unowned, and so does the owner itself.
    expect(owners['dsh-loop']).toBeUndefined()
    expect(owners['dsh-office']).toBeUndefined()
  })

  it('ignores what is not installed, self-declarations, and manifest key order', () => {
    writeProfile({})
    installPackage('dsh-b', { dsh: {}, dependencies: { 'dsh-b': '1.0.0', 'not-installed': '1.0.0', shared: '1.0.0' } })
    installPackage('dsh-a', { dsh: {}, dependencies: { shared: '1.0.0' } })
    installPackage('shared', {})

    const owners = readDependencyOwners('web', ['dsh-b', 'dsh-a', 'shared'])

    expect(owners['not-installed']).toBeUndefined()
    expect(owners['dsh-b']).toBeUndefined()
    // Two owners declare it; the answer is the first in sorted order, not the
    // order the caller happened to pass.
    expect(owners.shared).toBe('dsh-a')
    expect(readDependencyOwners('web', ['shared', 'dsh-b', 'dsh-a']).shared).toBe('dsh-a')
  })

  it('is empty when nothing is installed or a manifest cannot be read', () => {
    writeProfile({})
    expect(readDependencyOwners('web', [])).toEqual({})
    expect(readDependencyOwners('web', ['absent'])).toEqual({})
  })
})

describe('readLockCommits', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567'
  const OTHER = 'fedcba9876543210fedcba9876543210fedcba98'

  function writeLock(body: string): void {
    writeProfile({})
    writeFileSync(join(profileDir('web'), 'pnpm-lock.yaml'), body)
  }

  it('extracts pinned commits from codeload URLs keyed lowercase by host; empty without a lockfile', () => {
    writeProfile({})
    expect(readLockCommits('web').size).toBe(0)
    writeLock(`  https://codeload.github.com/Owner/Repo/tar.gz/${SHA}:\n`)
    expect(readLockCommits('web').get('github.com/owner/repo')).toBe(SHA)
  })

  // The two lockfile lines below are pnpm 12.4.1's own output, copied from a
  // real install of each host (#637) — not a guess at the shape.
  it('reads the GitLab archive tarball, nested group path and all', () => {
    writeLock('  \'@gitlab/eslint-plugin@https://gitlab.com/gitlab-org/frontend/eslint-plugin/-/archive/'
      + `${SHA}/eslint-plugin-${SHA}.tar.gz':\n    resolution: {gitHosted: true, tarball: `
      + `https://gitlab.com/gitlab-org/frontend/eslint-plugin/-/archive/${SHA}/eslint-plugin-${SHA}.tar.gz}\n`)
    expect(readLockCommits('web').get('gitlab.com/gitlab-org/frontend/eslint-plugin')).toBe(SHA)
  })

  it('reads the GitLab archive the way pnpm 9 and 10 write it, under the same key', () => {
    // Those majors fetch through the REST API instead: the repository is
    // percent-encoded into one path segment and the commit is a query
    // parameter. Same repository, same commit, so the same key as the
    // `/-/archive/` shape above — this line is pnpm 9.15.4's own output.
    writeLock(`  version: https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab-svgs/repository/archive.tar.gz?sha=${SHA}\n`)
    expect(readLockCommits('web').get('gitlab.com/gitlab-org/gitlab-svgs')).toBe(SHA)
  })

  it('reads the Bitbucket archive tarball', () => {
    writeLock(`  '@atlassian/aui-workspace@https://bitbucket.org/Atlassian/AUI/get/${SHA}.tar.gz':\n`)
    expect(readLockCommits('web').get('bitbucket.org/atlassian/aui')).toBe(SHA)
  })

  // The reason the key carries a host at all: one plugin's commit must never
  // be able to answer for another plugin that happens to share owner/repo.
  it('keeps the same owner/repo apart across hosts', () => {
    writeLock(`  https://gitlab.com/me/themer/-/archive/${SHA}/themer-${SHA}.tar.gz\n`
      + `  https://bitbucket.org/me/themer/get/${OTHER}.tar.gz\n`)
    const commits = readLockCommits('web')
    expect(commits.get('gitlab.com/me/themer')).toBe(SHA)
    expect(commits.get('bitbucket.org/me/themer')).toBe(OTHER)
    expect(commits.get('me/themer')).toBeUndefined()
  })

  it('keeps a port in the key, and takes the host from the URL even behind a proxy', () => {
    writeLock(`  https://git.example.com:8443/me/themer/-/archive/${SHA}/themer-${SHA}.tar.gz\n`
      + `  https://proxy.example.com/https://gitlab.com/you/themer/-/archive/${OTHER}/themer-${OTHER}.tar.gz\n`)
    const commits = readLockCommits('web')
    expect(commits.get('git.example.com:8443/me/themer')).toBe(SHA)
    expect(commits.get('git.example.com/me/themer')).toBeUndefined()
    // A proxy in front of the URL is not the repository's host.
    expect(commits.get('gitlab.com/you/themer')).toBe(OTHER)
    expect(commits.get('proxy.example.com/https://gitlab.com/you/themer')).toBeUndefined()
  })

  it('keys a self-hosted GitLab archive under its own host, not gitlab.com', () => {
    writeLock(`  https://git.example.com/me/themer/-/archive/${SHA}/themer-${SHA}.tar.gz\n`)
    const commits = readLockCommits('web')
    expect(commits.get('git.example.com/me/themer')).toBe(SHA)
    expect(commits.get('gitlab.com/me/themer')).toBeUndefined()
  })
})

describe('readGitResolutionCommit', () => {
  const A = 'a'.repeat(40)
  const B = 'b'.repeat(40)

  function writeLock(body: string): void {
    writeProfile({})
    writeFileSync(join(profileDir('web'), 'pnpm-lock.yaml'), body)
  }

  it('gives a host shorthand nothing rather than another repository\'s commit (#637)', () => {
    // No pnpm the market supports resolves gitlab.com / bitbucket.org by
    // cloning — 9.15.4, 10.34.5, 11.8.0 and 12.4.1 all write an archive
    // tarball, which `readLockCommits` reads — so a `type: git` entry for one
    // of these hosts does not occur today. This pins the direction the miss
    // takes if some future pnpm writes one: nothing, which disables rollback
    // with a clear reason, rather than a same-named repository's commit,
    // which would roll back to the wrong tree.
    writeLock(`lockfileVersion: 9\n  resolution: {commit: ${A}, repo: https://gitlab.com/me/themer.git, type: git}\n`)

    expect(readGitResolutionCommit('web', 'gitlab:me/themer')).toBeNull()
    expect(readGitResolutionCommit('web', 'bitbucket:me/themer')).toBeNull()
    // The URL spelling of the same install still reads, untouched by #637.
    expect(readGitResolutionCommit('web', 'git+https://gitlab.com/me/themer.git')).toBe(A)
  })

  it('reads the commit pnpm recorded for a remote, whatever the spelling', () => {
    writeLock(`lockfileVersion: 9\n  resolution: {commit: ${A}, repo: https://gitea.example.com/me/themer.git, type: git}\n`)

    expect(readGitResolutionCommit('web', 'git+https://gitea.example.com/me/themer.git')).toBe(A)
    expect(readGitResolutionCommit('web', 'git+https://gitea.example.com/me/themer.git#main')).toBe(A)
    expect(readGitResolutionCommit('web', 'git+https://other.example.com/me/themer.git')).toBeNull()
  })

  it('keeps two packages of one monorepo apart by their path selector (#632)', () => {
    writeLock([
      'lockfileVersion: 9',
      `  resolution: {commit: ${A}, path: /packages/plug-a, repo: https://gitea.example.com/me/mono.git, type: git}`,
      `  resolution: {commit: ${B}, path: /packages/plug-b, repo: https://gitea.example.com/me/mono.git, type: git}`,
      '',
    ].join('\n'))

    const remote = 'git+https://gitea.example.com/me/mono.git'
    expect(readGitResolutionCommit('web', `${remote}#main&path:/packages/plug-a`)).toBe(A)
    expect(readGitResolutionCommit('web', `${remote}#path:/packages/plug-b`)).toBe(B)
    expect(readGitResolutionCommit('web', `${remote}#path:/packages/plug-c`)).toBeNull()
    // No selector while several siblings share the remote: none of them is
    // this package's commit, and answering with the first would compare one
    // sibling's identity against another's.
    expect(readGitResolutionCommit('web', remote)).toBeNull()
  })
})

describe('hasDshManifest / entryArtifactExists (#18 boot-brick guards)', () => {
  it('detects a dsh surface and the presence of the declared entry artifact', () => {
    const pkg = join(writeProfile({}), 'node_modules', 'x')
    mkdirSync(pkg, { recursive: true })

    writeFileSync(join(pkg, 'package.json'), '{"dsh":{"client":{}}}')
    expect(hasDshManifest(pkg)).toBe(true)
    writeFileSync(join(pkg, 'package.json'), '{"name":"x"}')
    expect(hasDshManifest(pkg)).toBe(false)

    // Source-only checkout: declared main missing → reject (would brick boot)…
    writeFileSync(join(pkg, 'package.json'), '{"main":"lib/index.js"}')
    expect(entryArtifactExists(pkg)).toBe(false)
    // …until the artifact exists.
    mkdirSync(join(pkg, 'lib'), { recursive: true })
    writeFileSync(join(pkg, 'lib', 'index.js'), '')
    expect(entryArtifactExists(pkg)).toBe(true)

    // Conditional exports objects are walked.
    writeFileSync(join(pkg, 'package.json'), '{"exports":{".":{"import":"dist/a.mjs"}}}')
    expect(entryArtifactExists(pkg)).toBe(false)
    mkdirSync(join(pkg, 'dist'), { recursive: true })
    writeFileSync(join(pkg, 'dist', 'a.mjs'), '')
    expect(entryArtifactExists(pkg)).toBe(true)

    // Nothing declared falls back to index.js.
    writeFileSync(join(pkg, 'package.json'), '{"name":"x"}')
    expect(entryArtifactExists(pkg)).toBe(false)
    writeFileSync(join(pkg, 'index.js'), '')
    expect(entryArtifactExists(pkg)).toBe(true)
  })
})

describe('hasLoadableEntry — carrier bundles (#203)', () => {
  /** A minimal loadable package: name only, index.js falls back and exists. */
  function writeLoadable(dir: string): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}')
    writeFileSync(join(dir, 'index.js'), '')
  }

  it('finds a mount target hoisted to the workspace root, one level above the profile', () => {
    // Reported shape exactly: a carrier (config-only, no entry of its own)
    // whose cordis.patch.yml names an in-box package that pnpm hoisted to
    // `<profiles>/node_modules` — one directory above `profiles/web` — because
    // the profile is a workspace member. Neither of the two locations this
    // function checked before #203 (the profile's own node_modules, and
    // nested under the carrier) is that directory.
    const profile = writeProfile({})
    const carrier = join(profile, 'node_modules', 'dsh-ouroboros')
    mkdirSync(carrier, { recursive: true })
    writeFileSync(join(carrier, 'package.json'), '{"dsh":{"bundle":{"patch":"cordis.patch.yml"}}}')
    writeFileSync(
      join(carrier, 'cordis.patch.yml'),
      "- name: '@deepseek-ai/dsh-mcp-client'\n  config: {}\n",
    )
    // Not present in the profile's own node_modules or nested under the
    // carrier — a real in-box install lives one level up.
    writeLoadable(join(dirname(profile), 'node_modules', '@deepseek-ai', 'dsh-mcp-client'))

    expect(hasLoadableEntry(profile, 'dsh-ouroboros')).toBe(true)
  })

  it('still finds a target the profile itself installed, unaffected by the fix', () => {
    const profile = writeProfile({})
    const carrier = join(profile, 'node_modules', 'carrier')
    mkdirSync(carrier, { recursive: true })
    writeFileSync(join(carrier, 'package.json'), '{"dsh":{"bundle":{"patch":"cordis.patch.yml"}}}')
    writeFileSync(join(carrier, 'cordis.patch.yml'), "- name: 'sibling-plugin'\n  config: {}\n")
    writeLoadable(join(profile, 'node_modules', 'sibling-plugin'))

    expect(hasLoadableEntry(profile, 'carrier')).toBe(true)
  })

  it('still finds a target nested under the carrier itself, unaffected by the fix', () => {
    const profile = writeProfile({})
    const carrier = join(profile, 'node_modules', 'carrier')
    mkdirSync(carrier, { recursive: true })
    writeFileSync(join(carrier, 'package.json'), '{"dsh":{"bundle":{"patch":"cordis.patch.yml"}}}')
    writeFileSync(join(carrier, 'cordis.patch.yml'), "- name: 'nested-dep'\n  config: {}\n")
    writeLoadable(join(carrier, 'node_modules', 'nested-dep'))

    expect(hasLoadableEntry(profile, 'carrier')).toBe(true)
  })

  it('refuses a carrier whose target genuinely does not exist anywhere', () => {
    const profile = writeProfile({})
    const carrier = join(profile, 'node_modules', 'carrier')
    mkdirSync(carrier, { recursive: true })
    writeFileSync(join(carrier, 'package.json'), '{"dsh":{"bundle":{"patch":"cordis.patch.yml"}}}')
    writeFileSync(join(carrier, 'cordis.patch.yml'), "- name: 'nowhere-to-be-found'\n  config: {}\n")
    // Nothing written for the target in any of the three locations.

    expect(hasLoadableEntry(profile, 'carrier')).toBe(false)
  })
})

describe('pluginSubdirs', () => {
  it('finds dsh plugins at depth 1 and 2, skipping node_modules', () => {
    const root = join(writeProfile({}), 'node_modules', 'collection')
    mkdirSync(join(root, 'plugin-a'), { recursive: true })
    writeFileSync(join(root, 'plugin-a', 'package.json'), '{"dsh":{}}')
    mkdirSync(join(root, 'packages', 'plugin-b'), { recursive: true })
    writeFileSync(join(root, 'packages', 'plugin-b', 'package.json'), '{"dsh":{}}')
    mkdirSync(join(root, 'node_modules', 'evil'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'evil', 'package.json'), '{"dsh":{}}')
    expect(pluginSubdirs(root).sort()).toEqual(['packages/plugin-b', 'plugin-a'])
  })
})

describe('manifest rollback (#65)', () => {
  it('readManifestDeps is RAW — includes the in-box bundles readInstalled filters', async () => {
    const { readManifestDeps } = await import('../src/profile.ts')
    writeProfile({ dependencies: { 'dsh-loop': '^1.0.0', '@deepseek-ai/dsh-base': 'latest' } })
    expect(readManifestDeps('web')).toEqual({ 'dsh-loop': '^1.0.0', '@deepseek-ai/dsh-base': 'latest' })
  })

  it('restoreProfileManifest drops ghost entries from both manifest lists and preserves other fields', async () => {
    const { readProfileManifestSnapshot, restoreProfileManifest } = await import('../src/profile.ts')
    const dir = writeProfile({
      name: 'web-profile',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-loop'], mode: 'manual' } },
      dependencies: { 'dsh-loop': '^1.0.0', '@deepseek-ai/dsh-base': 'latest' },
    })
    const snapshot = readProfileManifestSnapshot('web')
    // Simulate the host's partial write of a failed run: a ghost dep and
    // bundle appear, and an existing pin is bumped. An unrelated field also
    // changes after the snapshot and must not be rolled back.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'web-profile',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-loop', 'ghost-pkg'], mode: 'manual', future: true } },
      dependencies: { 'dsh-loop': '^1.2.0', '@deepseek-ai/dsh-base': 'latest', 'ghost-pkg': '0.1.0-rc.6' },
    }))
    const rolledBack = restoreProfileManifest('web', snapshot)
    expect(rolledBack.sort()).toEqual(['dsh-loop', 'ghost-pkg'])
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(manifest.dependencies).toEqual({ 'dsh-loop': '^1.0.0', '@deepseek-ai/dsh-base': 'latest' })
    expect(manifest.dsh).toEqual({
      profile: {
        bundles: ['@deepseek-ai/dsh-base', 'dsh-loop'],
        mode: 'manual',
        future: true,
      },
    })
    expect(manifest.name).toBe('web-profile')
    // A second restore is a no-op.
    expect(restoreProfileManifest('web', snapshot)).toEqual([])
  })

  it('restoreProfileManifest removes a newly-created bundle field without deleting its parent objects', async () => {
    const { readProfileManifestSnapshot, restoreProfileManifest } = await import('../src/profile.ts')
    const dir = writeProfile({ name: 'web-profile', dsh: { profile: { mode: 'manual' } }, dependencies: {} })
    const snapshot = readProfileManifestSnapshot('web')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'web-profile',
      dsh: { profile: { mode: 'manual', bundles: ['ghost-pkg'] } },
      dependencies: {},
    }))

    expect(restoreProfileManifest('web', snapshot)).toEqual(['ghost-pkg'])
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(manifest.dsh).toEqual({ profile: { mode: 'manual' } })
  })

  it('still snapshots dependencies when a parseable profile field is malformed', async () => {
    const { readProfileManifestSnapshot, restoreProfileManifest } = await import('../src/profile.ts')
    const dir = writeProfile({
      name: 'web-profile',
      dsh: { profile: null },
      dependencies: { 'kept-pkg': '^1.0.0' },
    })
    const snapshot = readProfileManifestSnapshot('web')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'web-profile',
      dsh: { profile: null },
      dependencies: { 'kept-pkg': '^1.0.0', 'ghost-pkg': '^2.0.0' },
    }))

    expect(restoreProfileManifest('web', snapshot)).toEqual(['ghost-pkg'])
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(manifest.dependencies).toEqual({ 'kept-pkg': '^1.0.0' })
    expect(manifest.dsh).toEqual({ profile: null })
  })
})

describe('setAllowBuilds (#6)', () => {
  it('accepts the clone-URL and archive keys off GitHub, and only in those exact shapes (#637)', async () => {
    // Same bargain as the codeload widening below: the allowlist is what
    // stops a caller writing arbitrary text into a file pnpm parses, so each
    // new branch names its host and path shape, and the near-misses are
    // asserted alongside the hits.
    const { setAllowBuilds } = await import('../src/profile.ts')
    writeProfile({})
    const sha = 'b0e6c57ebeeb4796017864f5cd5c66e6ba0899ec'
    const approved = setAllowBuilds('web', [
      // Hits: the clone URL of any host, with an optional commit pin, and
      // the archive gitlab.com / bitbucket.org serve.
      'p@git+https://gitlab.com/group/sub/plug.git',
      'p@git+https://gitea.example.com:8443/me/plug.git',
      `p@git+https://gitea.example.com/me/plug.git#${sha}`,
      `p@https://bitbucket.org/o/r/get/${sha}.tar.gz`,
      `p@https://gitlab.com/group/sub/plug/-/archive/${sha}/plug-${sha}.tar.gz`,
      // Near-misses. A different host wearing an archive shape…
      `p@https://evil.example.com/o/r/get/${sha}.tar.gz`,
      // …the right host with no commit pin…
      'p@https://bitbucket.org/o/r/get/HEAD.tar.gz',
      // …a path traversal dressed as a repo…
      `p@https://gitlab.com/../../etc/-/archive/${sha}/x-${sha}.tar.gz`,
      // …a clone URL over plain http…
      'p@git+http://gitea.example.com/me/plug.git',
      // …a local path, which is not a source the market installs from…
      'p@git+file:///tmp/plug.git',
      // …and another entry smuggled through a newline.
      'p@git+https://gitea.example.com/me/plug.git\n  evil: true',
    ])
    expect(approved).toEqual([
      'p@git+https://gitlab.com/group/sub/plug.git',
      'p@git+https://gitea.example.com:8443/me/plug.git',
      `p@git+https://gitea.example.com/me/plug.git#${sha}`,
      `p@https://bitbucket.org/o/r/get/${sha}.tar.gz`,
      `p@https://gitlab.com/group/sub/plug/-/archive/${sha}/plug-${sha}.tar.gz`,
    ])
  })

  it('accepts the commit-pinned codeload key, and only in that exact shape (#285)', async () => {
    // The allowlist is what stops a caller writing arbitrary text into a
    // file pnpm parses. Widening it for pnpm <11.21 must not widen it into
    // "anything containing a URL" — so the near-misses are asserted too.
    const { setAllowBuilds } = await import('../src/profile.ts')
    writeProfile({})
    const sha = 'b0e6c57ebeeb4796017864f5cd5c66e6ba0899ec'
    const approved = setAllowBuilds('web', [
      `p@https://codeload.github.com/o/r/tar.gz/${sha}`,
      // A different host wearing the same shape.
      `p@https://evil.example.com/o/r/tar.gz/${sha}`,
      // The right host with no commit pin: matches nothing, and an entry
      // that matches nothing is indistinguishable from one that worked.
      'p@https://codeload.github.com/o/r/tar.gz/HEAD',
      // A path traversal dressed as a repo.
      `p@https://codeload.github.com/../../etc/tar.gz/${sha}`,
      // Something else entirely, smuggled through a newline.
      `p@https://codeload.github.com/o/r/tar.gz/${sha}\n  evil: true`,
    ])
    expect(approved).toContain(`p@https://codeload.github.com/o/r/tar.gz/${sha}`)
    expect(approved).toHaveLength(1)
  })

  it('merges into an existing allowBuilds block and preserves the rest of the yaml', async () => {
    const { setAllowBuilds } = await import('../src/profile.ts')
    const dir = writeProfile({})
    writeFileSync(join(dir, 'pnpm-workspace.yaml'),
      'packages:\n  - .\n\nnodeLinker: hoisted\n\nallowBuilds:\n  existing-pkg: true\n')
    const approved = setAllowBuilds('web', ['dsh-skin', 'evil;rm'])
    expect(approved).toContain('existing-pkg')
    expect(approved).toContain('dsh-skin')
    expect(approved).not.toContain('evil;rm')
    const yaml = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    expect(yaml).toContain('nodeLinker: hoisted')
    expect(yaml).toMatch(/allowBuilds:\n  existing-pkg: true\n  dsh-skin: true/)
  })

  it('drops the pnpm #11535 placeholder corruption while merging (#56)', async () => {
    const { setAllowBuilds } = await import('../src/profile.ts')
    const dir = writeProfile({})
    // pnpm's failed-install bug writes a literal placeholder instead of a
    // boolean, breaking the file for every later approval.
    writeFileSync(join(dir, 'pnpm-workspace.yaml'),
      'packages:\n  - .\n\nallowBuilds:\n  cloudflared: set this to true or false\n  good-pkg: false\n')
    const approved = setAllowBuilds('web', ['ssh2'])
    expect(approved).toContain('ssh2')
    expect(approved).toContain('good-pkg')
    expect(approved).not.toContain('cloudflared')
    const yaml = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    expect(yaml).not.toContain('set this to')
    expect(yaml).toMatch(/good-pkg: false/)
    expect(yaml).toMatch(/ssh2: true/)
  })

  it('preserves existing git+https keys (whose keys contain colons) and accepts new ones (#68/#69)', async () => {
    const { setAllowBuilds } = await import('../src/profile.ts')
    const dir = writeProfile({})
    // A git-hosted dep is only matched under its `name@git+https://…` key;
    // the old line parser split on the FIRST colon and silently dropped
    // such entries on every rewrite.
    writeFileSync(join(dir, 'pnpm-workspace.yaml'),
      'packages:\n  - .\n\nallowBuilds:\n  keep-me@git+https://github.com/o/keep-me.git: true\n  plain: false\n')
    // Another host's clone URL is now written too (#637): these keys come
    // from the profile's own manifest, so refusing them only stopped
    // gitlab/bitbucket/self-hosted plugins from ever authorizing a build.
    // What the allowlist still refuses is a key that is not one of the
    // shapes — here, one carrying a second YAML entry.
    const approved = setAllowBuilds('web', [
      'dsh-audit@git+https://github.com/omdsh-dev/dsh-audit.git',
      'dsh-audit',
      'other@git+https://gitea.example.com/me/x.git',
      'evil@git+https://evil.example/x.git\n  evil: true',
    ])
    expect(approved).toContain('keep-me@git+https://github.com/o/keep-me.git')
    expect(approved).toContain('dsh-audit@git+https://github.com/omdsh-dev/dsh-audit.git')
    expect(approved).toContain('dsh-audit')
    expect(approved).toContain('other@git+https://gitea.example.com/me/x.git')
    expect(approved).not.toContain('evil@git+https://evil.example/x.git\n  evil: true')
    const yaml = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    expect(yaml).toContain('keep-me@git+https://github.com/o/keep-me.git: true')
    expect(yaml).toMatch(/plain: false/)
  })

  it('quotes scoped `@` keys so the block stays valid YAML', async () => {
    const { setAllowBuilds } = await import('../src/profile.ts')
    const dir = writeProfile({})
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    const approved = setAllowBuilds('web', ['@deepseek-ai/dsh-subprocess-local', 'plain-pkg'])
    expect(approved).toContain('@deepseek-ai/dsh-subprocess-local')
    const yaml = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    // `@` cannot start a plain YAML scalar; the key must be quoted or pnpm
    // fails to parse the workspace on every later run.
    expect(yaml).toContain("'@deepseek-ai/dsh-subprocess-local': true")
    expect(yaml).toMatch(/plain-pkg: true/)
  })

  it('round-trips an already-quoted scoped key without nesting quotes', async () => {
    const { setAllowBuilds } = await import('../src/profile.ts')
    const dir = writeProfile({})
    writeFileSync(join(dir, 'pnpm-workspace.yaml'),
      "packages:\n  - .\n\nallowBuilds:\n  '@google/genai': true\n")
    const approved = setAllowBuilds('web', ['ssh2'])
    expect(approved).toContain('@google/genai')
    const yaml = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    expect(yaml).toContain("'@google/genai': true")
    expect(yaml).not.toContain("''@google/genai''")
    expect(yaml).toContain('ssh2: true')
  })

  it('creates the block when the yaml has none', async () => {
    const { setAllowBuilds } = await import('../src/profile.ts')
    const dir = writeProfile({})
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    setAllowBuilds('web', ['pkg-a'])
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toMatch(/packages:[\s\S]*allowBuilds:\n  pkg-a: true/)
  })

  it('merges into a CRLF file instead of appending a second block (#231)', async () => {
    // Every Windows editor, and git with core.autocrlf=true, writes CRLF.
    // The old pattern required `allowBuilds:` to be followed immediately by
    // \n, so it never saw the existing block and appended another — two
    // top-level keys, invalid YAML, and pnpm then refused EVERY install in
    // the profile, not just the one that triggered it.
    const { setAllowBuilds } = await import('../src/profile.ts')
    const dir = writeProfile({})
    writeFileSync(join(dir, 'pnpm-workspace.yaml'),
      'packages:\r\n  - .\r\n\r\nallowBuilds:\r\n  existing-pkg: true\r\n')
    const approved = setAllowBuilds('web', ['ssh2'])
    expect(approved).toContain('existing-pkg')
    expect(approved).toContain('ssh2')
    const yaml = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    // Exactly one allowBuilds key — the whole point.
    expect(yaml.match(/^allowBuilds:/gmu)?.length).toBe(1)
    expect(yaml).toContain('existing-pkg: true')
    expect(yaml).toContain('ssh2: true')
    // ...and the file stays CRLF rather than becoming mixed.
    expect(yaml).toContain('\r\n')
    expect(/[^\r]\n/.test(yaml)).toBe(false)
  })

  it('repairs a profile already broken by the duplicate-block bug, keeping both blocks\' entries (#231)', async () => {
    // What a Windows user's file looks like after the bug bit: the approval
    // that triggered it went into a SECOND block. Merging is what repairs
    // it — dropping the extra outright would silently revoke those entries.
    const { setAllowBuilds } = await import('../src/profile.ts')
    const dir = writeProfile({})
    writeFileSync(join(dir, 'pnpm-workspace.yaml'),
      'packages:\r\n  - .\r\n\r\nallowBuilds:\r\n  first-pkg: true\r\n'
      + 'allowBuilds:\r\n  second-pkg: true\r\n')
    const approved = setAllowBuilds('web', ['third-pkg'])
    expect(approved).toEqual(expect.arrayContaining(['first-pkg', 'second-pkg', 'third-pkg']))
    const yaml = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    expect(yaml.match(/^allowBuilds:/gmu)?.length).toBe(1)
    for (const pkg of ['first-pkg', 'second-pkg', 'third-pkg']) expect(yaml).toContain(`${pkg}: true`)
  })
})

describe('conflictingEntryIds (#122)', () => {
  /** Write a package whose bundle patch holds the given rows. */
  function bundle(dir: string, name: string, patch: string): void {
    const root = join(dir, 'node_modules', name)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(root, 'cordis.patch.yml'), patch)
  }

  it('flags two packages that INSERT the same loader entry id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-clash-'))
    try {
      bundle(dir, 'incumbent', '- insert:\n    - id: shared\n      name: incumbent\n')
      bundle(dir, 'newcomer', '- insert:\n    - id: shared\n      name: newcomer\n')
      // Two entries under one id is what makes cordis refuse the next boot.
      expect(conflictingEntryIds(dir, 'newcomer', ['incumbent'])).toEqual([{ id: 'shared', owner: 'incumbent' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not flag a row that merely CONFIGURES another plugin\'s entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-clash-'))
    try {
      bundle(dir, 'incumbent', '- insert:\n    - id: theirs\n      name: incumbent\n')
      // A top-level `- id:` row patches an existing entry; it creates
      // nothing, so it cannot brick a boot. Counting it here refused a
      // legitimate plugin outright — the same owned-vs-referenced
      // distinction #147 drew for the disable path.
      bundle(dir, 'newcomer', '- insert:\n    - id: mine\n      name: newcomer\n- id: theirs\n  config:\n    tweaked: true\n')
      expect(conflictingEntryIds(dir, 'newcomer', ['incumbent'])).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('removeProfileBundle / addProfileBundle', () => {
  function readBundles(dir: string): string[] {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dsh?: { profile?: { bundles?: string[] } }
    }
    return manifest.dsh?.profile?.bundles ?? []
  }

  it('drops a carrier bundle from dsh.profile.bundles, keeping the rest (#224)', () => {
    const dir = writeProfile({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-postgres-backends', 'dshmarket'] } } })
    expect(removeProfileBundle(dir, 'dsh-postgres-backends')).toBe(true)
    expect(readBundles(dir)).toEqual(['@deepseek-ai/dsh-base', 'dshmarket'])
  })

  it('returns false and leaves the manifest byte-for-byte untouched when the bundle is absent', () => {
    const dir = writeProfile({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } })
    const before = readFileSync(join(dir, 'package.json'), 'utf8')
    expect(removeProfileBundle(dir, 'dsh-postgres-backends')).toBe(false)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
  })

  it('re-adds a bundle on enable and is idempotent (#224)', () => {
    const dir = writeProfile({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } })
    expect(addProfileBundle(dir, 'dsh-postgres-backends')).toBe(true)
    expect(addProfileBundle(dir, 'dsh-postgres-backends')).toBe(false)
    expect(readBundles(dir)).toEqual(['@deepseek-ai/dsh-base', 'dsh-postgres-backends'])
  })

  it('preserves unrelated manifest fields across a removal', () => {
    const dir = writeProfile({
      name: 'dsh-profile-web',
      dependencies: { dshmarket: '^1.0.0' },
      dsh: { profile: { bundles: ['dshmarket', 'dsh-postgres-backends'] } },
    })
    expect(removeProfileBundle(dir, 'dsh-postgres-backends')).toBe(true)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.name).toBe('dsh-profile-web')
    expect(manifest.dependencies).toEqual({ dshmarket: '^1.0.0' })
    expect(manifest.dsh.profile.bundles).toEqual(['dshmarket'])
  })
})
