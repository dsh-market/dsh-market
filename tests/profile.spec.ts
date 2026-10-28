/**
 * Profile filesystem reads against real fixture directories (DSH_HOME is
 * pointed at a tmpdir per test).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { resolveDshHome } from '../src/home-paths.ts'
import {
  addProfileBundle, bundleExpressionRowIds, bundleOptOutRowIds, bundlePatchInsertedIds, bundlesDroppedFromProfile, readProfileManifestSnapshot, bundlePatchTargets, conflictingEntryIds, declaredBundlePatchFiles, dropFromManifest, entryArtifactExists, generationManagedNames, hasDshManifest, hasLoadableEntry, holdsNativeAddon, isDshProfileName, mergeDuplicateReleaseAgeExcludes, parsePatchRows, pluginSubdirs, profileDir, shippedInsertedRowIds,
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

  it('counts an optional dependency as ownership (#941)', () => {
    // A platform-specific binary is payload, not a plugin the user chose. pnpm
    // installs it, so it reaches the installed list; the manifest that asked
    // for it must still name the owner so the card is not shown as a plugin.
    writeProfile({})
    installPackage('dsh-ops', {
      dsh: {},
      optionalDependencies: { '@dsh-ops/bash-win32-x64': '0.3.2' },
    })
    installPackage('@dsh-ops/bash-win32-x64', {})

    const owners = readDependencyOwners('web', ['dsh-ops', '@dsh-ops/bash-win32-x64'])

    expect(owners['@dsh-ops/bash-win32-x64']).toBe('dsh-ops')
    expect(owners['dsh-ops']).toBeUndefined()
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

  it('finds an owner that is not a profile dependency itself (#892)', () => {
    // `ws` is a plugin's dependency, so it is never in the profile manifest —
    // but pnpm hoists its directory to the top level, and that is where the
    // two native peers are declared. Asking only about the manifest's own
    // entries could not name an owner for either, so both stayed on the
    // installed list as plugins nobody chose.
    writeProfile({})
    installPackage('ws', { peerDependencies: { bufferutil: '^4.0.1', 'utf-8-validate': '>=5.0.2' } })
    installPackage('bufferutil', {})
    installPackage('utf-8-validate', {})
    installPackage('dsh-better-sidebar', { dsh: {} })

    const owners = readDependencyOwners('web', ['dsh-better-sidebar', 'bufferutil', 'utf-8-validate'])

    expect(owners.bufferutil).toBe('ws')
    expect(owners['utf-8-validate']).toBe('ws')
  })

  it('reads a scoped package at the top level as an owner too (#892)', () => {
    writeProfile({})
    installPackage('@scope/plugin', { dsh: {}, peerDependencies: { 'native-thing': '1.0.0' } })
    installPackage('native-thing', {})

    // The scope directory holds the package, not the package itself.
    expect(readDependencyOwners('web', ['native-thing'])['native-thing']).toBe('@scope/plugin')
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

  it('reads a host shorthand the same as the URL spelling of that install (#637, #851)', () => {
    // No pnpm the market supports resolves gitlab.com / bitbucket.org by
    // cloning — 9.15.4, 10.34.5, 11.8.0 and 12.4.1 all write an archive
    // tarball, which `readLockCommits` reads — so a `type: git` entry for one
    // of these hosts does not occur today, and this is the shape a future one
    // would take.
    //
    // The answer used to depend on the SPELLING: the URL read the commit and
    // the shorthand read nothing, because the shorthand could not be keyed at
    // all. #851 is that defect and it is not host-specific — the shorthand is
    // how pnpm writes a host back into the manifest, so two spellings of one
    // install have to give one answer. What #637 protected is untouched: the
    // key is host-qualified, so another host's same-named repository still
    // cannot answer for this one.
    writeLock(`lockfileVersion: 9\n  resolution: {commit: ${A}, repo: https://gitlab.com/me/themer.git, type: git}\n`)

    expect(readGitResolutionCommit('web', 'gitlab:me/themer')).toBe(A)
    expect(readGitResolutionCommit('web', 'git+https://gitlab.com/me/themer.git')).toBe(A)
    // Another host's repository of the same name still gets nothing, which is
    // the direction #637 asked the miss to take.
    expect(readGitResolutionCommit('web', 'bitbucket:me/themer')).toBeNull()
    expect(readGitResolutionCommit('web', 'github:me/themer')).toBeNull()
  })

  it('finds the commit for a floating github: shorthand pnpm resolved as type: git (#851)', () => {
    // The reporter's lockfile in shape: pnpm writes the `github:` shorthand
    // back into the manifest and records the resolution's remote in SCP form,
    // so before #851 the spec side and the lockfile side of the comparison
    // shared no spelling at all — the shorthand keyed to nothing, and the URL
    // spelling kept a `.git` suffix the SCP side also had, in a different
    // scheme. `hostedRepoKey` is what the rest of the market compares specs
    // by, and is now what both sides are keyed with here too.
    writeLock(`lockfileVersion: 9\n  resolution: {commit: ${A}, repo: git@github.com:me/themer.git, type: git}\n`)

    // Every spelling of one install. The reporter measured all four of the
    // first group returning null on 1.66.18.
    for (const spec of [
      'github:me/themer',
      'github:me/themer#main',
      'https://github.com/me/themer',
      'https://github.com/me/themer.git',
      'git+https://github.com/me/themer.git',
      'git+ssh://git@github.com/me/themer.git',
      `github:me/themer#${A}`,
      'git@github.com:me/themer.git',
    ]) {
      expect(readGitResolutionCommit('web', spec), spec).toBe(A)
    }
    // A different repository on the same host is still a different repository.
    expect(readGitResolutionCommit('web', 'github:me/other')).toBeNull()
    // And so is a repository on another host.
    expect(readGitResolutionCommit('web', 'gitlab:me/themer')).toBeNull()
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

  it('finds a target that lives only in the host install tree (#906)', () => {
    // A carrier mounting only in-box packages resolves nowhere under the
    // profile. Before this, verifyActivation called it broken and
    // validateAddedPlugins uninstalled it right after pnpm had installed it.
    const profile = writeProfile({})
    const carrier = join(profile, 'node_modules', 'dsh-mcp-context7')
    mkdirSync(carrier, { recursive: true })
    writeFileSync(join(carrier, 'package.json'), '{"dsh":{"bundle":{"patch":"cordis.patch.yml"}}}')
    writeFileSync(join(carrier, 'cordis.patch.yml'), "- name: '@deepseek-ai/dsh-mcp-client'\n  config: {}\n")

    const host = mkdtempSync(join(tmpdir(), 'dshm-host-'))
    try {
      writeFileSync(join(host, 'package.json'), '{"name":"@deepseek-ai/dsh"}')
      writeLoadable(join(host, 'node_modules', '@deepseek-ai', 'dsh-mcp-client'))
      // Nothing under the profile resolves; the host's tree does.
      expect(hasLoadableEntry(profile, 'dsh-mcp-context7')).toBe(false)
      expect(hasLoadableEntry(profile, 'dsh-mcp-context7', host)).toBe(true)
      // null means "do not consult the install tree" — the pre-#906 answer.
      expect(hasLoadableEntry(profile, 'dsh-mcp-context7', null)).toBe(false)
    } finally {
      rmSync(host, { recursive: true, force: true })
    }
  })

  it('trusts the official scope inside a packaged desktop archive (#676, #906)', () => {
    // Electron archives cannot be probed reliably by plain fs, so inside
    // app.asar the name is the evidence — the same rule check.ts already
    // applies to loader rows.
    const profile = writeProfile({})
    const carrier = join(profile, 'node_modules', 'carrier')
    mkdirSync(carrier, { recursive: true })
    writeFileSync(join(carrier, 'package.json'), '{"dsh":{"bundle":{"patch":"cordis.patch.yml"}}}')
    writeFileSync(join(carrier, 'cordis.patch.yml'), "- name: '@deepseek-ai/dsh-mcp-client'\n  config: {}\n")
    const asarHost = join(tmpdir(), 'some-app', 'resources', 'app.asar', 'dsh')
    expect(hasLoadableEntry(profile, 'carrier', asarHost)).toBe(true)

    // A non-official name gets no such benefit: without a readable package
    // there is no evidence it exists.
    writeFileSync(join(carrier, 'cordis.patch.yml'), "- name: 'third-party-missing'\n  config: {}\n")
    expect(hasLoadableEntry(profile, 'carrier', asarHost)).toBe(false)
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

/**
 * #792: the host composes an ARRAY `dsh.bundle.patch` in order (official
 * dsh-web-app ships five files). Reading only a string turned such a package
 * into one with no declared patch at all — no rows, no targets, no entry.
 */
describe('bundle patch readers vs an array declaration (#792)', () => {
  function carrier(name: string, patch: unknown, files: Record<string, string>): string {
    const dir = join(profileDir('web'), 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, dsh: { bundle: { patch } } }))
    for (const [rel, text] of Object.entries(files)) writeFileSync(join(dir, rel), text)
    return dir
  }

  it('merges rows from every file of an array declaration, in order', () => {
    const dir = carrier('multi-patch', ['./a.patch.yml', './b.patch.yml'], {
      'a.patch.yml': '- insert:\n    - id: arr-a\n      name: dep-a\n',
      'b.patch.yml': '- insert:\n    - id: arr-b\n      name: dep-b\n',
    })
    expect(bundlePatchTargets(dir)).toEqual(['dep-a', 'dep-b'])
    expect(bundlePatchInsertedIds(dir)).toEqual(['arr-a', 'arr-b'])
  })

  it('answers nothing when any declared file is unreadable', () => {
    // All or nothing, mirroring the host: one missing overlay file makes
    // loadOverlayPatches throw and the whole bundle is skipped — the
    // readable remainder may not stay in effect on the market's side.
    const dir = carrier('partial-patch', ['./gone.patch.yml', './b.patch.yml'], {
      'b.patch.yml': '- insert:\n    - id: arr-b\n      name: dep-b\n',
    })
    expect(bundlePatchTargets(dir)).toEqual([])
    expect(bundlePatchInsertedIds(dir)).toEqual([])
  })
})

/** The declaration reader itself, pinned shape by shape against the host. */
describe('declaredBundlePatchFiles — one patch file or a list (#792)', () => {
  function carrier(dir: string, patch: unknown): string {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'carrier', dsh: { bundle: { patch } } }))
    return dir
  }

  it('wraps a string declaration into the single joined path — subdirectories included (#646)', () => {
    const dir = carrier(join(profileDir('web'), 'node_modules', 'carrier'), './patches/cordis.patch.yml')
    expect(declaredBundlePatchFiles(dir)).toEqual([join(dir, 'patches', 'cordis.patch.yml')])
  })

  it('returns every file of an array declaration, in order', () => {
    // dsh-web-app ships five; two are enough to pin the shape.
    const dir = carrier(join(profileDir('web'), 'node_modules', 'carrier'), ['./a.patch.yml', 'sub/b.patch.yml'])
    expect(declaredBundlePatchFiles(dir)).toEqual([join(dir, 'a.patch.yml'), join(dir, 'sub', 'b.patch.yml')])
  })

  it('keeps the string items, in order, of a list holding a non-string item', () => {
    // The host requires every item to be a string and skips the whole bundle
    // otherwise; the read-side precedent is check.ts's declaredList (#676),
    // which filters instead of throwing — a mixed list contributes its
    // string files in order (#792).
    const dir = carrier(join(profileDir('web'), 'node_modules', 'carrier'), ['./a.patch.yml', 42])
    expect(declaredBundlePatchFiles(dir)).toEqual([join(dir, 'a.patch.yml')])
  })

  it('treats a list with no string items as none', () => {
    const dir = carrier(join(profileDir('web'), 'node_modules', 'carrier'), [42, null])
    expect(declaredBundlePatchFiles(dir)).toEqual([])
  })

  it('treats a declaration that is neither string nor array as none', () => {
    const root = join(profileDir('web'), 'node_modules', 'carrier')
    expect(declaredBundlePatchFiles(carrier(root, 42))).toEqual([])
    expect(declaredBundlePatchFiles(carrier(root, { file: 'x' }))).toEqual([])
    expect(declaredBundlePatchFiles(carrier(root, undefined))).toEqual([])
  })

  it('treats an empty string declaration as none', () => {
    const dir = carrier(join(profileDir('web'), 'node_modules', 'carrier'), '')
    expect(declaredBundlePatchFiles(dir)).toEqual([])
  })

  it('treats an unreadable manifest and an absent package as no declaration', () => {
    const dir = join(profileDir('web'), 'node_modules', 'carrier')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{broken')
    expect(declaredBundlePatchFiles(dir)).toEqual([])
    expect(declaredBundlePatchFiles(join(dir, 'absent'))).toEqual([])
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
  it('writes exact monorepo build keys and repairs their undecided placeholders', async () => {
    const { setAllowBuilds } = await import('../src/profile.ts')
    const dir = writeProfile({})
    const sha = '6322be7665112d5caecaf2522b5496e4c21a5d5a'
    const archive = `@cyrus/dsh-sessions-insight@https://codeload.github.com/Mt-Youya/dsh-plugins/tar.gz/${sha}`
    const clone = '@cyrus/dsh-sessions-insight@git+https://github.com/Mt-Youya/dsh-plugins.git'
    const keys = [
      `${archive}#path:/plugins/sessions-insight`,
      `${clone}#${sha}&path:/plugins/sessions-insight`,
      `${clone}#path:/plugins/sessions-insight`,
      `${archive}#path:/.plugins/sessions-insight`,
      `p@https://gitlab.com/group/mono/-/archive/${sha}/mono-${sha}.tar.gz#path:/packages/p`,
      `p@https://bitbucket.org/o/mono/get/${sha}.tar.gz#path:/packages/p`,
    ]
    writeFileSync(join(dir, 'pnpm-workspace.yaml'),
      `packages:\n  - .\nallowBuilds:\n  '${keys[0]}': set this to true or false\n  other: false\n`)

    const approved = setAllowBuilds('web', keys)
    expect(approved).toEqual(['other', ...keys])
    const workspace = load(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')) as { allowBuilds: Record<string, boolean> }
    expect(workspace.allowBuilds).toEqual({ other: false, ...Object.fromEntries(keys.map(key => [key, true])) })
    // Approval remains stable across a second click.
    expect(setAllowBuilds('web', keys)).toEqual(approved)
  })

  it('accepts the key pnpm writes for a dependency resolved from a BRANCH (#1034)', async () => {
    // A floating branch dependency is not keyed by a commit: pnpm writes
    // `…tar.gz/refs/heads/main`, so every SHA-only shape refused the one key
    // that would have authorized it, and "approve build scripts and retry"
    // wrote a bare name pnpm does not match.
    const { setAllowBuilds } = await import('../src/profile.ts')
    writeProfile({})
    const keys = [
      'dsh-purge@https://codeload.github.com/YuJunZhiXue/dsh-purge/tar.gz/refs/heads/master',
      'p@https://codeload.github.com/o/mono/tar.gz/refs/heads/feature/nested-branch#path:/packages/p',
      'p@https://codeload.github.com/o/r/tar.gz/refs/tags/v1.2.3',
      'p@https://bitbucket.org/o/r/get/refs/heads/main.tar.gz',
    ]
    expect(setAllowBuilds('web', keys)).toEqual(keys)
    // The ref is path segments only: no traversal, no empty piece, no
    // whitespace or separators that would end the value it is written into.
    const unsafe = [
      'p@https://codeload.github.com/o/r/tar.gz/refs/heads/../evil',
      'p@https://codeload.github.com/o/r/tar.gz/refs/heads//x',
      'p@https://codeload.github.com/o/r/tar.gz/refs/heads',
      'p@https://codeload.github.com/o/r/tar.gz/refs/heads/main\n  evil: true',
      'p@https://codeload.github.com/o/r/tar.gz/refs/pulls/1',
    ]
    const written = setAllowBuilds('web', unsafe)
    for (const key of unsafe) expect(written).not.toContain(key)
  })

  it('still rejects unsafe or malformed monorepo build keys', async () => {
    const { setAllowBuilds } = await import('../src/profile.ts')
    writeProfile({})
    const archive = `p@https://codeload.github.com/o/r/tar.gz/${'a'.repeat(40)}`
    expect(setAllowBuilds('web', [
      `${archive}#path:/../outside`,
      `${archive}#path:/packages/./p`,
      `${archive}#path:/packages/../../outside`,
      `${archive}#path:/packages/p\n  evil: true`,
      `${archive}#path:/packages/p&evil:true`,
      `${archive}#path:/packages\\p`,
      `${archive}#path:/packages/%2e%2e/outside`,
      `${archive}#path:`,
      'p@git+https://github.com/o/r.git#HEAD&path:/packages/p',
    ])).toEqual([])
  })

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
      // A remote spelled without `.git`, which pnpm keys exactly as spelled.
      'p@git+https://gitea.example.com/me/plug',
      `p@git+https://gitea.example.com/me/plug#${sha}`,
      `p@https://bitbucket.org/o/r/get/${sha}.tar.gz`,
      `p@https://gitlab.com/group/sub/plug/-/archive/${sha}/plug-${sha}.tar.gz`,
      // Near-misses. A traversal in the final segment, now that it may end
      // without `.git`…
      'p@git+https://gitea.example.com/me/..',
      // …a different host wearing an archive shape…
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
      'p@git+https://gitea.example.com/me/plug',
      `p@git+https://gitea.example.com/me/plug#${sha}`,
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

/**
 * #841: an insert row's `config:` is its payload, and payloads carry `id:`
 * keys of their own — a preset row lists the plugins it will instantiate
 * under `config.plugins[].id`. Counting those as inserted loader entry ids
 * made two bundles that instantiate the same official plugins read as two
 * bundles inserting the same entry ids, and the market then refused the
 * second one over a clash the host does not have.
 */
describe('parsePatchRows — an insert row\'s payload is not a loader entry (#841)', () => {
  const presetShaped = [
    '- insert:',
    '    - id: preset-a',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: a',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '          - id: tool-todo',
    "            name: '@deepseek-ai/dsh-tool-todo'",
    '',
  ].join('\n')

  it('counts the row and nothing the row configures', () => {
    // Exactly the input from the report, on 1.66.17 and unchanged on main:
    // four ids came out, and only the first is a row.
    expect(parsePatchRows(presetShaped).insertedIds).toEqual(['preset-a'])
  })

  it('still counts the children of a group, whose config IS more rows', () => {
    // The shape the fix must not lose: a group's list-valued config holds
    // child loader entries, and two bundles sharing a child id really do
    // brick the next boot (tests/patch.spec.ts pins the reference side).
    const groupShaped = [
      '- insert:',
      '    - id: group-x',
      '      name: cordis:group',
      '      group: true',
      '      config:',
      '        - id: real-child',
      '          name: some-plugin',
      '',
    ].join('\n')
    expect(parsePatchRows(groupShaped).insertedIds).toEqual(['group-x', 'real-child'])
  })

  it('leaves a plain plugin\'s list-valued config alone, as the strict parser does', () => {
    // Only a GROUP row reads a list config as child rows; for anyone else a
    // list is ordinary options. userPatchPackageReferences has drawn that
    // line since it was written — the line scanner now agrees with it.
    const optionsShaped = [
      '- insert:',
      '  - id: array-options',
      '    name: options-plugin',
      '    config:',
      '      - id: not-a-row',
      '        name: nested-array-value',
      '',
    ].join('\n')
    expect(parsePatchRows(optionsShaped).insertedIds).toEqual(['array-options'])
  })

  it('ends the payload at the next row, so later rows still count', () => {
    const twoRows = [
      '- insert:',
      '    - id: preset-a',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        id: a',
      '        plugins:',
      '          - id: persona',
      '            name: dsh-persona',
      '    - id: plain-b',
      '      name: plain-plugin',
      '',
    ].join('\n')
    expect(parsePatchRows(twoRows).insertedIds).toEqual(['preset-a', 'plain-b'])
  })

  it('finds the group no matter which side of config the keys are written', () => {
    // `group:` after `config:` is unusual but legal YAML. A scan that only
    // looked upwards would read this row's children as payload and lose the
    // collision it exists to catch, so the row is read as a whole.
    const reordered = [
      '- insert:',
      '    - config:',
      '        - id: real-child',
      '          name: some-plugin',
      '      name: cordis:group',
      '      group: true',
      '      id: group-x',
      '',
    ].join('\n')
    // Set comparison: which of the two ids is listed first is an artefact of
    // their order in the file, not something callers depend on.
    expect([...parsePatchRows(reordered).insertedIds].sort()).toEqual(['group-x', 'real-child'])
  })

  it('ends a payload opened on the marker line at the row\'s own next key', () => {
    // `- config:` puts the key two columns right of the `-`. The row's later
    // keys sit at that column too; measured from the `-`, `id: real-row`
    // read as payload and the row lost its own id.
    const configFirst = [
      '- insert:',
      '    - config:',
      '        foo: 1',
      '      id: real-row',
      '      name: x',
      '    - id: next-row',
      '      name: y',
      '',
    ].join('\n')
    expect(parsePatchRows(configFirst).insertedIds).toEqual(['real-row', 'next-row'])
  })

  it('finds the group past a list-valued key written before config', () => {
    // The `- foo` under `tags:` is a list item, not the row's marker; taking
    // it for one read the row from there and never saw `group: true`.
    const tagged = [
      '- insert:',
      '    - id: group-x',
      '      name: cordis:group',
      '      group: true',
      '      tags:',
      '        - foo',
      '      config:',
      '        - id: real-child',
      '          name: some-plugin',
      '',
    ].join('\n')
    expect(parsePatchRows(tagged).insertedIds).toEqual(['group-x', 'real-child'])
  })

  it('reads a row whose marker is followed by more than one space', () => {
    // `-   id:` is legal YAML; the row's keys then sit four columns right of
    // the `-`, not two.
    const wideMarker = [
      '- insert:',
      '  -   id: group-x',
      '      name: cordis:group',
      '      group: true',
      '      config:',
      '        - id: real-child',
      '          name: some-plugin',
      '',
    ].join('\n')
    expect(parsePatchRows(wideMarker).insertedIds).toEqual(['group-x', 'real-child'])
  })

  it('reads a group row opened by a bare `-`', () => {
    const bareMarker = [
      '- insert:',
      '    -',
      '      id: group-x',
      '      group: true',
      '      config:',
      '        - id: real-child',
      '          name: some-plugin',
      '',
    ].join('\n')
    expect(parsePatchRows(bareMarker).insertedIds).toEqual(['group-x', 'real-child'])
  })

  it('keeps a payload\'s own `config:` keys inside the payload', () => {
    // A preset's plugin list may configure each plugin. That inner `config:`
    // is payload too; letting it move the payload's edge ended the payload
    // early, and `official` read as a row this package inserts — #841 again.
    const nestedConfig = [
      '- insert:',
      '    - id: preset',
      '      name: x',
      '      config:',
      '        plugins:',
      '          - config:',
      '              a: 1',
      '            id: official',
      '',
    ].join('\n')
    expect(parsePatchRows(nestedConfig).insertedIds).toEqual(['preset'])
  })

  it('reads a list under any other key of a row as data, not rows', () => {
    // Only a group's config holds rows. A list under `tags:` (or any other
    // key) is the row's data, whatever keys its items carry.
    const tagged = [
      '- insert:',
      '    - id: a',
      '      tags:',
      '        - id: tag-one',
      '        - config:',
      '            x: 1',
      '          id: tag-two',
      '      name: z',
      '    - id: b',
      '',
    ].join('\n')
    expect(parsePatchRows(tagged).insertedIds).toEqual(['a', 'b'])
  })

  it('reads a list written at its key\'s own column as that key\'s value', () => {
    // YAML lets a block sequence sit at its key's column instead of one level
    // in. Read as a sibling, the payload ended at its first item and the
    // item's id counted as a row this package inserts — #841 again.
    const rows = (compact: boolean): string => [
      '- insert:',
      '    - id: plain',
      '      name: p',
      '      config:',
      `${compact ? '      ' : '        '}- id: payload-id`,
      `${compact ? '        ' : '          '}name: x`,
      '    - id: next',
      '',
    ].join('\n')
    expect(parsePatchRows(rows(false)).insertedIds).toEqual(['plain', 'next'])
    expect(parsePatchRows(rows(true)).insertedIds).toEqual(['plain', 'next'])
  })

  it('still reads a group\'s children when its config list sits at the key\'s column', () => {
    // The other side of the same rule: a group's list config holds rows
    // however it is indented.
    const compactGroup = [
      '- insert:',
      '    - id: group-x',
      '      group: true',
      '      config:',
      '      - id: real-child',
      '        name: some-plugin',
      '      - id: second-child',
      '    - id: next',
      '',
    ].join('\n')
    expect(parsePatchRows(compactGroup).insertedIds).toEqual(['group-x', 'real-child', 'second-child', 'next'])
  })

  it('reads a compact list under any other key as data too', () => {
    const compactTags = [
      '- insert:',
      '    - id: a',
      '      tags:',
      '      - id: tag-one',
      '      name: z',
      '    - id: b',
      '',
    ].join('\n')
    expect(parsePatchRows(compactTags).insertedIds).toEqual(['a', 'b'])
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

  it('does not flag two preset bundles whose payloads instantiate the same plugins (#841)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-clash-'))
    try {
      // Two bundles, each inserting ONE preset row, each instantiating the
      // same official plugins. Their loader ids are disjoint (`preset-a` vs
      // `preset-b`, and `a` vs `b` are preset ids in their own namespace),
      // and the host boots the combination — 6 presets declaring `id:
      // persona` each is a normal tree. Reading the payloads as entry ids
      // made this a 16-id "conflict" and uninstalled the newcomer.
      const preset = (row: string, presetId: string): string =>
        `- insert:\n    - id: ${row}\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: ${presetId}\n        plugins:\n          - id: persona\n            name: '@deepseek-ai/dsh-persona'\n          - id: tool-todo\n            name: '@deepseek-ai/dsh-tool-todo'\n`
      bundle(dir, 'smart-fount', preset('preset-a', 'a'))
      bundle(dir, 'clearai-dsh', preset('preset-b', 'b'))
      expect(conflictingEntryIds(dir, 'clearai-dsh', ['smart-fount'])).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still flags a real collision among the children of a group (#841)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-clash-'))
    try {
      // Narrowing the guard must not cost it the case it exists for: the
      // group's children ARE entries, so one shared child id is a duplicate
      // loader entry id and the host will refuse the next boot.
      const group = (row: string, child: string): string =>
        `- insert:\n    - id: ${row}\n      name: cordis:group\n      group: true\n      config:\n        - id: ${child}\n          name: some-plugin\n`
      bundle(dir, 'incumbent', group('group-a', 'real-child'))
      bundle(dir, 'newcomer', group('group-b', 'real-child'))
      expect(conflictingEntryIds(dir, 'newcomer', ['incumbent']))
        .toEqual([{ id: 'real-child', owner: 'incumbent' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not flag a payload id written as a list at its key\'s column', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-clash-'))
    try {
      // One bundle inserts `persona`; the other only names `persona` in its
      // preset payload, written without the extra indent. The host has one
      // `persona` entry, so the newcomer must not be refused over it.
      bundle(dir, 'other-plugin', '- insert:\n    - id: persona\n      name: other-plugin\n')
      bundle(dir, 'preset-a', "- insert:\n    - id: preset-a\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n      - id: persona\n        name: '@deepseek-ai/dsh-persona'\n")
      expect(conflictingEntryIds(dir, 'preset-a', ['other-plugin'])).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still flags a group child collision when the child list sits at the key\'s column', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-clash-'))
    try {
      const group = (row: string): string =>
        `- insert:\n    - id: ${row}\n      name: cordis:group\n      group: true\n      config:\n      - id: real-child\n        name: some-plugin\n`
      bundle(dir, 'incumbent', group('group-a'))
      bundle(dir, 'newcomer', group('group-b'))
      expect(conflictingEntryIds(dir, 'newcomer', ['incumbent']))
        .toEqual([{ id: 'real-child', owner: 'incumbent' }])
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

describe('mergeDuplicateReleaseAgeExcludes (#732)', () => {
  function workspace(contents: string): string {
    const dir = writeProfile({ name: 'dsh-profile-web', dependencies: {} })
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), contents)
    return dir
  }

  it.each(['\n', '\r\n'])('merges a pnpm folded union and shadowed duplicates with %j (#820)', (eol) => {
    const dir = workspace([
      'packages:',
      '  - .',
      'minimumReleaseAgeExclude:',
      "  - '@scope/a@1.0.0 || 1.0.1 ||",
      "    1.0.2'",
      '  - dshmarket@1.66.14',
      '  - dshmarket@1.66.15',
      'allowBuilds:',
      '  esbuild: true',
      '',
    ].join(eol))
    expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual(['dshmarket'])
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe([
      'packages:',
      '  - .',
      'minimumReleaseAgeExclude:',
      "  - '@scope/a@1.0.0 || 1.0.1 ||",
      "    1.0.2'",
      '  - dshmarket@1.66.14 || 1.66.15',
      'allowBuilds:',
      '  esbuild: true',
      '',
    ].join(eol))
  })

  it.each([
    ["'", '@scope/pkg'],
    ["'", 'ordinary'],
    ['"', '@scope/pkg'],
    ['"', 'ordinary'],
    ['', 'ordinary'],
  ])('merges a folded %s scalar for %s without widening its versions (#820)', (quote, name) => {
    const dir = workspace([
      'minimumReleaseAgeExclude:',
      `  - ${quote}${name}@1.0.0 ||`,
      `    1.0.1${quote}`,
      `  - '${name}@1.0.2-beta.1+build.2'`,
      '',
    ].join('\n'))
    expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual([name])
    const parsed = load(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'))
    expect(parsed).toEqual({ minimumReleaseAgeExclude: [`${name}@1.0.0 || 1.0.1 || 1.0.2-beta.1+build.2`] })
  })

  it('decodes YAML escapes before grouping and re-emits the same rule (#820)', () => {
    const dir = workspace('minimumReleaseAgeExclude:\n  - "pkg\\u00401.0.0 ||\n    1.0.1"\n  - pkg@1.0.2\n')
    expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual(['pkg'])
    expect(load(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')))
      .toEqual({ minimumReleaseAgeExclude: ['pkg@1.0.0 || 1.0.1 || 1.0.2'] })
  })

  it('honours an escaped line break in a double-quoted scalar (#820)', () => {
    const dir = workspace('minimumReleaseAgeExclude:\n  - "pkg@1.0.\\\n    1"\n  - pkg@1.0.2\n')
    expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual(['pkg'])
    expect(load(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')))
      .toEqual({ minimumReleaseAgeExclude: ['pkg@1.0.1 || 1.0.2'] })
  })

  it.each(['\n', '\r\n'])('preserves full-line and trailing comments around folded entries with %j (#816, #820)', (eol) => {
    const dir = workspace([
      'minimumReleaseAgeExclude:',
      '# before',
      "  - '@scope/pkg@1.0.0 ||",
      "    1.0.1'  # first",
      '',
      '  # between',
      "  - '@scope/pkg@1.0.2 ||",
      "    1.0.3' # duplicate",
      '  - other@1.0.0   # untouched',
      'allowBuilds:',
      '  esbuild: true # unrelated',
      '',
    ].join(eol))
    expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual(['@scope/pkg'])
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe([
      'minimumReleaseAgeExclude:',
      '# before',
      "  - '@scope/pkg@1.0.0 || 1.0.1 || 1.0.2 || 1.0.3' # first",
      '',
      '  # between',
      '  # duplicate',
      '  - other@1.0.0   # untouched',
      'allowBuilds:',
      '  esbuild: true # unrelated',
      '',
    ].join(eol))
  })

  it('converges for a long two-line rule over 20 consecutive runs (#820)', () => {
    const versions = Array.from({ length: 10 }, (_, i) => `1.0.${i}`)
    const original = [
      'minimumReleaseAgeExclude:',
      `  - '@scope/pkg@${versions.slice(0, 6).join(' || ')} ||`,
      `    ${versions.slice(6).join(' || ')}'`,
      "  - '@scope/pkg@1.0.10'",
      'allowBuilds:',
      '  esbuild: true',
      '',
    ].join('\n')
    const dir = workspace(original)
    const file = join(dir, 'pnpm-workspace.yaml')
    const expected = { minimumReleaseAgeExclude: [`@scope/pkg@${[...versions, '1.0.10'].join(' || ')}`], allowBuilds: { esbuild: true } }
    expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual(['@scope/pkg'])
    const repaired = readFileSync(file)
    expect(load(repaired.toString())).toEqual(expected)
    utimesSync(file, 1, 1)
    const mtime = statSync(file).mtimeMs
    for (let i = 1; i < 20; i++) {
      expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual([])
      expect(readFileSync(file)).toEqual(repaired)
      expect(statSync(file).mtimeMs).toBe(mtime)
    }
  })

  it.each([
    "  - '@scope/pkg@1.0.0 ||\n    1.0.1'",
    '  - "pkg@1.0.0 ||\n    1.0.1"',
    '  - pkg@1.0.0 ||\n    1.0.1',
  ])('does not write a folded block that needs no merge: %s (#820)', (entry) => {
    const original = `minimumReleaseAgeExclude:\r\n${entry.replaceAll('\n', '\r\n')}  # keep\r\n\r\nallowBuilds:\r\n  esbuild: true`
    const dir = workspace(original)
    const file = join(dir, 'pnpm-workspace.yaml')
    utimesSync(file, 1, 1)
    const mtime = statSync(file).mtimeMs
    expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(statSync(file).mtimeMs).toBe(mtime)
  })

  it.each([
    "  - '@scope/pkg@1.0.0 ||\n    1.0.1", // unterminated
    "  - '@scope/pkg@1.0.0 ||\n    1.0.1\"", // mismatched quotes
    "  - 'pkg@1.0.0'junk", // content after closing quote
    "  - 'pkg@1.0.0''", // unmatched escaped quote
    "  - 'pkg@1.0.0''suffix'", // decoded quote is not a version
    '  - "pkg@1.0.0\\q"', // invalid YAML escape
    "  - '''@scope/pkg@1.0.0 ||'\n    1.0.1'", // already damaged file
    "  - '@scope/pkg@1.0.\n    1'", // a newline inside a version is a space, not concatenation
    "  - ' pkg@1.0.0'", // quoted whitespace must not be stripped
    "  - 'pkg@1.0.0 # literal'", // not a YAML comment
    '  - pkg@1.0.0 # ends the scalar\n    || 1.0.1',
    '  - pkg@1.0.0\n\n    || 1.0.1', // a blank line must not truncate validation
    '  - pkg@1.0.0\n  # interrupts\n    || 1.0.1',
    '  - pkg@1.0.0\n  orphan@1.0.1', // insufficient continuation indent
    '  - pkg@1.0.0\n\t|| 1.0.1',
    '  - pkg@1.0.0\n    nested: true',
    '  - &rule pkg@1.0.0',
    '  - *rule',
    '  - !!str pkg@1.0.0',
    '  - >\n    pkg@1.0.0',
    '  - |\n    pkg@1.0.0',
    '  - [pkg@1.0.0]',
    '  - {pkg: 1.0.0}',
    "  - 'pkg@*'", // complex selectors are left alone, never widened
    "  - 'pkg@>=1.0.0'",
    "  - 'pkg@1.0.0-.'",
    "  - 'pkg@1.0.0-01'",
    "  - 'pkg@01.0.0'",
  ])('refuses unsafe or unsupported input without a write over 20 runs: %s (#820)', (entry) => {
    const original = `minimumReleaseAgeExclude:\n  - a@1.0.0\n  - a@2.0.0\n${entry}\nallowBuilds:\n  esbuild: true\n`
    const dir = workspace(original)
    const file = join(dir, 'pnpm-workspace.yaml')
    utimesSync(file, 1, 1)
    const mtime = statSync(file).mtimeMs
    for (let i = 0; i < 20; i++) {
      expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual([])
      expect(readFileSync(file, 'utf8')).toBe(original)
      expect(statSync(file).mtimeMs).toBe(mtime)
    }
  })

  it('merges a shadowed duplicate rule into one union (#732)', () => {
    // pnpm appended the second rule when it let 1.65.4 through, then honoured
    // only the first per name — so its own entry was shadowed and every later
    // command in the profile failed lockfile verification.
    const dir = workspace([
      'packages:',
      '  - .',
      'minimumReleaseAgeExclude:',
      '  - dshmarket@1.38.1 || 1.47.0 || 1.65.1',
      '  - other@1.0.0',
      '  - dshmarket@1.65.4',
      '',
    ].join('\n'))
    expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual(['dshmarket'])
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe([
      'packages:',
      '  - .',
      'minimumReleaseAgeExclude:',
      '  - dshmarket@1.38.1 || 1.47.0 || 1.65.1 || 1.65.4',
      '  - other@1.0.0',
      '',
    ].join('\n'))
  })

  it('leaves a version union alone, and does not widen it to a bare name (#733 review)', () => {
    // #733 tied an 80 GiB abort to this spelling, but review on that issue and
    // the reporter's own follow-up settled that `name@a || b` is a documented
    // pnpm form and that the abort is pnpm's to fix. A bare name would exempt
    // EVERY version of the package from the cooldown — wider than the file
    // says — so a union that is the only rule for its name is not touched.
    const original = 'minimumReleaseAgeExclude:\n  - billion-context@0.1.138 || 0.1.147\n  - keep@1.0.0\n'
    const dir = workspace(original)
    expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual([])
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(original)
  })

  it('leaves a file holding only bare names and single exact versions alone', () => {
    const original = 'minimumReleaseAgeExclude:\n  - a@1.0.0\n  - b\n  - c@2.0.0\n'
    const dir = workspace(original)
    expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual([])
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(original)
  })

  it('collapses an identical duplicate line without widening anything', () => {
    // The same exact version twice is redundant, not a broken shape: one
    // line is what is left, and the entry still names that version only.
    const dir = workspace('minimumReleaseAgeExclude:\n  - @scope/pkg@1.0.0\n  - @scope/pkg@1.0.0\n')
    expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual(['@scope/pkg'])
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'))
      .toBe("minimumReleaseAgeExclude:\n  - '@scope/pkg@1.0.0'\n")
  })

  it('retains the repair of a single unquoted scoped name (#732)', () => {
    const dir = workspace('minimumReleaseAgeExclude:\n  - @scope/pkg@1.0.0 # keep\n')
    expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual(['@scope/pkg'])
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'))
      .toBe("minimumReleaseAgeExclude:\n  - '@scope/pkg@1.0.0' # keep\n")
  })

  it('does not touch a block it cannot read exactly', () => {
    // A `#` that is not a YAML comment (no whitespace before it), or a flow
    // list, is a line this cannot re-emit without losing something: leaving
    // it alone beats guessing.
    for (const contents of [
      'minimumReleaseAgeExclude:\n  - a@1.0.0#keep\n  - a@2.0.0\n',
      'minimumReleaseAgeExclude: [a@1.0.0, a@2.0.0]\n',
      'minimumReleaseAgeExclude:\n  - a@1.0.0\n  - a@\n',
    ]) {
      const dir = workspace(contents)
      expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual([])
      expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(contents)
    }
  })

  it('merges past comment lines inside the block and keeps every comment (#816)', () => {
    // The reporter's file: they had merged a duplicate by hand and written
    // down why, inside the block. The host then appended another rule below
    // the comment. The comment used to end the block (or veto the repair), so
    // the new duplicate stayed shadowed and every command kept failing.
    const dir = workspace([
      'minimumReleaseAgeExclude:',
      '  - billion-context@0.1.187 || 0.1.188',
      '  # 注意：同一个包名只能出现一条 —— pnpm 11.7.0 只认每个包名的第一条匹配项，',
      '  # 必须合并成一条用 ` || ` 连接（2026-10-09 修复）。',
      '  - dshmarket@1.66.12 || 1.66.14',
      '  - dsh-think-translate@1.2.7',
      '  - dshmarket@1.66.15',
      'allowBuilds:',
      '  esbuild: true',
      '',
    ].join('\n'))
    expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual(['dshmarket'])
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe([
      'minimumReleaseAgeExclude:',
      '  - billion-context@0.1.187 || 0.1.188',
      '  # 注意：同一个包名只能出现一条 —— pnpm 11.7.0 只认每个包名的第一条匹配项，',
      '  # 必须合并成一条用 ` || ` 连接（2026-10-09 修复）。',
      '  - dshmarket@1.66.12 || 1.66.14 || 1.66.15',
      '  - dsh-think-translate@1.2.7',
      'allowBuilds:',
      '  esbuild: true',
      '',
    ].join('\n'))
  })

  it('keeps comments written at the end of entries, including on a dropped duplicate (#816)', () => {
    const dir = workspace([
      'minimumReleaseAgeExclude:',
      '# exempted by hand',
      '  - dshmarket@1.66.12 || 1.66.14  # 保留',
      '  - other@1.0.0',
      '  - dshmarket@1.66.15 # host added this',
      '',
    ].join('\n'))
    expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual(['dshmarket'])
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe([
      'minimumReleaseAgeExclude:',
      '# exempted by hand',
      '  - dshmarket@1.66.12 || 1.66.14 || 1.66.15 # 保留',
      '  - other@1.0.0',
      '  # host added this',
      '',
    ].join('\n'))
  })

  it('leaves a commented block with no duplicates byte-for-byte alone (#816)', () => {
    const original = 'minimumReleaseAgeExclude:\n  # why\n  - a@1.0.0   # keep\n  - b\n'
    const dir = workspace(original)
    expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual([])
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(original)
  })

  it('refuses to rewrite a name that is not a package name (#820)', () => {
    // The last line of defence: whatever shape misleads the reader, a name
    // that cannot be a package name must never reach the writer — that is how
    // a stray quote used to double once per operation until the profile broke.
    for (const contents of [
      "minimumReleaseAgeExclude:\n  - '''''': true\n  - a@1.0.0\n",
      'minimumReleaseAgeExclude:\n  - name with space@1.0.0\n  - a@1.0.0\n  - a@2.0.0\n',
      'minimumReleaseAgeExclude:\n  - @scope/@1.0.0\n  - a@1.0.0\n  - a@2.0.0\n',
    ]) {
      const dir = workspace(contents)
      expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual([])
      expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(contents)
    }
  })

  it('keeps a bare name meaning every version when it is one of the duplicates', () => {
    const dir = workspace('minimumReleaseAgeExclude:\n  - pkg\n  - pkg@1.0.0\n')
    expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual(['pkg'])
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe('minimumReleaseAgeExclude:\n  - pkg\n')
  })

  it('leaves a line break inside a version alone instead of guessing its meaning (#820)', () => {
    // pnpm wraps a long `||` union across two lines. The continuation is
    // indented but does not start with `-`, so the block used to end at it:
    // only the truncated first line survived, its unterminated quote was read
    // as a package name, and the repair re-emitted that line with the quote
    // doubled — once per run, until the file grew large enough to break every
    // pnpm command in the profile. YAML folds `1.0.` + `2` to `1.0. 2`, which
    // is not an exact version: even with scalar decoding this stays unreadable.
    const original = [
      'minimumReleaseAgeExclude:',
      "  - '@scope/thing@1.0.0 || 1.0.1 || 1.0.",
      "    2 || 1.0.3'",
      '  - dshmarket@1.66.14',
      '  - dshmarket@1.66.12 || 1.66.14',
      '',
    ].join('\n')
    const dir = workspace(original)
    expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual([])
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(original)
  })

  it('leaves the whole block alone when folding splits a version between readable rules (#820)', () => {
    // The readable rules around it are still a duplicate pair, so a repair
    // that only read up to the continuation would rewrite part of the block
    // while leaving the entry it misread untouched — worse than not acting.
    const original = [
      'minimumReleaseAgeExclude:',
      '  - dshmarket@1.66.14',
      "  - '@scope/thing@1.0.0 || 1.0.",
      "    1 || 1.0.2'",
      '  - dshmarket@1.66.12',
      'allowBuilds:',
      '  esbuild: true',
      '',
    ].join('\n')
    const dir = workspace(original)
    expect(mergeDuplicateReleaseAgeExcludes('web')).toEqual([])
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(original)
  })
})

describe('bundlesDroppedFromProfile (#720)', () => {
  /**
   * The report: after a market update the profile still DECLARED
   * `dsh-better-sidebar` and still had it on disk, but its row was gone from
   * `dsh.profile.bundles`, so the plugin stopped loading with nothing but a
   * dangling-patch warning at the next boot. The combination — still a
   * dependency, no longer a bundle — is the quiet one, and it is what this
   * names.
   */
  const manifest = (bundles: string[] | undefined, dependencies: Record<string, string>) => ({
    name: 'web-profile',
    ...(bundles === undefined ? {} : { dsh: { profile: { bundles } } }),
    dependencies,
  })

  it('names a package that is still a dependency but left the bundle list', () => {
    writeProfile(manifest(['@deepseek-ai/dsh-base', 'dshmarket', 'dsh-better-sidebar'], { dshmarket: '^1', 'dsh-better-sidebar': '^0.21.1' }))
    const before = readProfileManifestSnapshot('web')
    writeProfile(manifest(['@deepseek-ai/dsh-base', 'dshmarket'], { dshmarket: '^1', 'dsh-better-sidebar': '^0.21.1' }))
    expect(bundlesDroppedFromProfile(before, 'web', undefined)).toEqual(['dsh-better-sidebar'])
  })

  it('does not name a package that was uninstalled — gone from both is what an uninstall is', () => {
    writeProfile(manifest(['dshmarket', 'dsh-gone'], { dshmarket: '^1', 'dsh-gone': '^1' }))
    const before = readProfileManifestSnapshot('web')
    writeProfile(manifest(['dshmarket'], { dshmarket: '^1' }))
    expect(bundlesDroppedFromProfile(before, 'web', undefined)).toEqual([])
  })

  it('does not name the package the operation itself was about', () => {
    writeProfile(manifest(['dshmarket', 'dsh-target'], { dshmarket: '^1', 'dsh-target': '^1' }))
    const before = readProfileManifestSnapshot('web')
    writeProfile(manifest(['dshmarket'], { dshmarket: '^1', 'dsh-target': '^1' }))
    expect(bundlesDroppedFromProfile(before, 'web', undefined, new Set(['dsh-target']))).toEqual([])
  })

  it('says nothing when the list is unchanged, grew, or the profile had none', () => {
    writeProfile(manifest(['dshmarket'], { dshmarket: '^1', 'dsh-new': '^1' }))
    const before = readProfileManifestSnapshot('web')
    writeProfile(manifest(['dshmarket', 'dsh-new'], { dshmarket: '^1', 'dsh-new': '^1' }))
    expect(bundlesDroppedFromProfile(before, 'web', undefined)).toEqual([])

    writeProfile(manifest(undefined, { dshmarket: '^1' }))
    const without = readProfileManifestSnapshot('web')
    writeProfile(manifest(['dshmarket'], { dshmarket: '^1' }))
    expect(bundlesDroppedFromProfile(without, 'web', undefined)).toEqual([])
  })

  it('is read-only: it reports a drop and never puts the row back', () => {
    // The bundle list is also how the official plugin page switches a package
    // off (#696). Restoring "what was there before" would undo a deliberate
    // removal, so this only names the change.
    writeProfile(manifest(['dshmarket', 'dsh-off'], { dshmarket: '^1', 'dsh-off': '^1' }))
    const before = readProfileManifestSnapshot('web')
    const dir = writeProfile(manifest(['dshmarket'], { dshmarket: '^1', 'dsh-off': '^1' }))
    bundlesDroppedFromProfile(before, 'web', undefined)
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dsh.profile.bundles).toEqual(['dshmarket'])
  })
})

describe('generationManagedNames (#874)', () => {
  const link = (name: string, version: string) =>
    `link:../.generations/live/${name}+${version}+01080f24f124/node_modules/${name}`

  it('reads the host\'s own projection list', () => {
    writeProfile({
      dependencies: { 'dsh-codex-subscription': '2.6.5' },
      dsh: { desktop: { generationProjection: { plugins: ['dsh-codex-subscription'] } } },
    })
    expect([...generationManagedNames('web')]).toEqual(['dsh-codex-subscription'])
  })

  it('reads a generation link in overrides, which is where the host writes it', () => {
    // The shape from #874's report: `dependencies` keeps the plain version,
    // `pnpm.overrides` carries the link into `.generations/live`.
    writeProfile({
      dependencies: { 'dsh-codex-subscription': '2.6.5' },
      pnpm: { overrides: { 'dsh-codex-subscription': link('dsh-codex-subscription', '2.6.5') } },
    })
    expect([...generationManagedNames('web')]).toEqual(['dsh-codex-subscription'])
  })

  it('reads a generation link in dependencies', () => {
    writeProfile({ dependencies: { 'dsh-loop': link('dsh-loop', '1.2.0') } })
    expect([...generationManagedNames('web')]).toEqual(['dsh-loop'])
  })

  it('counts neither ordinary ranges nor a developer checkout', () => {
    writeProfile({
      dependencies: { 'dsh-loop': '^1.0.0', 'local-work': 'link:../local-work' },
      peerDependencies: { 'peer-thing': link('peer-thing', '1.0.0') },
    })
    // The generation link inside peerDependencies IS one; the range and the
    // hand-written `link:` are not.
    expect([...generationManagedNames('web')]).toEqual(['peer-thing'])
  })

  it('answers with nothing on a profile with no manifest', () => {
    mkdirSync(profileDir('web'), { recursive: true })
    expect([...generationManagedNames('web')]).toEqual([])
  })

  it('ignores a malformed projection list instead of throwing', () => {
    writeProfile({ dependencies: {}, dsh: { desktop: { generationProjection: { plugins: 'dsh-loop' } } } })
    expect([...generationManagedNames('web')]).toEqual([])
  })
})

describe('parsePatchRows — the rows a patch ships switched off (#876)', () => {
  it('reads an opt-in row whose keys sit between id and disabled', () => {
    // dsh-mnemon's real shape: `id`, then `name`, then `disabled: true`. The
    // line scanner the market uses for the USER layer requires `disabled` on
    // the very next line, so it never saw these; the row parser has to.
    const optIn = [
      '- id: mnemon-strategy-general',
      '  name: dsh-mnemon-strategy-general',
      '# an inserted comment must not end the row',
      '  disabled: true',
      '- id: mnemon',
      '  name: dsh-mnemon',
      '',
    ].join('\n')
    expect(parsePatchRows(optIn).disabledIds).toEqual(['mnemon-strategy-general'])
  })

  it('reads an opt-in row nested inside an insert block', () => {
    const nested = [
      '- insert:',
      '    - id: off-by-default',
      '      name: some-strategy',
      '      disabled: true',
      '    - id: on-by-default',
      '      name: some-core',
      '',
    ].join('\n')
    expect(parsePatchRows(nested).disabledIds).toEqual(['off-by-default'])
  })

  it('never counts disabled: false, and never counts a payload id (#841)', () => {
    const rows = [
      '- insert:',
      '    - id: forced-on',
      '      name: forced-plugin',
      '      disabled: false',
      '    - id: preset-a',
      '      name: cordis:preset',
      '      config:',
      '        plugins:',
      '          - id: payload-entry',
      '            name: payload-plugin',
      '            disabled: true',
      '',
    ].join('\n')
    expect(parsePatchRows(rows).disabledIds).toEqual([])
  })
})

describe('bundleOptOutRowIds (#876)', () => {
  it('reads both patch sources a package may ship', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-optout-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'dsh-mnemon',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))
      writeFileSync(join(dir, 'cordis.patch.yml'), [
        '- insert:',
        '    - id: mnemon',
        '      name: dsh-mnemon',
        '    - id: mnemon-strategy-general',
        '      name: dsh-mnemon-strategy-general',
        '      disabled: true',
        '',
      ].join('\n'))
      // #792: a declared LIST contributes every file it names.
      writeFileSync(join(dir, 'extra.patch.yml'), '- id: extra-opt-in\n  disabled: true\n')
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      manifest.dsh.bundle.patch = ['./cordis.patch.yml', './extra.patch.yml']
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
      expect([...bundleOptOutRowIds(dir)].sort()).toEqual(['extra-opt-in', 'mnemon-strategy-general'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers with nothing for a package that ships no patch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-optout-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'plain' }))
      expect(bundleOptOutRowIds(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('parsePatchRows — the rows a patch decides with an expression (#1043)', () => {
  it('reads a !!js condition as expression-decided, never as opt-in or plain', () => {
    // The report's shape (#1043): ds-harness-remote ships BOTH of its rows
    // with `disabled: !!js …` conditions, deciding per environment at
    // compose time. Neither row is literal, so neither is an opt-in row.
    const rows = [
      '- insert:',
      '    - id: remote',
      '      name: dsh-remote',
      '      disabled: !!js >-',
      "        [...ctx.loader.entries()].some(entry => entry.options.id === 'dsh-tui')",
      '    - id: remote-tui',
      '      name: dsh-remote-tui',
      '      disabled: !!js >-',
      "        ![...ctx.loader.entries()].some(entry => entry.options.id === 'dsh-tui')",
      '',
    ].join('\n')
    const parsed = parsePatchRows(rows)
    expect(parsed.disabledIds).toEqual([])
    expect(parsed.expressionIds).toEqual(['remote', 'remote-tui'])
  })

  it('keeps literal true and false rows out of expressionIds; a valueless disabled is not readable either', () => {
    const rows = [
      '- insert:',
      '    - id: lit-on',
      '      disabled: false',
      '    - id: lit-off',
      '      disabled: true',
      '    - id: null-flag',
      '      disabled:',
      '',
    ].join('\n')
    const parsed = parsePatchRows(rows)
    expect(parsed.disabledIds).toEqual(['lit-off'])
    expect(parsed.expressionIds).toEqual(['null-flag'])
  })

  it('never counts a payload id as an expression row (#841)', () => {
    const rows = [
      '- insert:',
      '    - id: real-row',
      '      config:',
      '        plugins:',
      '          - id: payload-entry',
      '            disabled: !!js ctx.isTui',
      '',
    ].join('\n')
    expect(parsePatchRows(rows).expressionIds).toEqual([])
  })
})

describe('bundleExpressionRowIds (#1043)', () => {
  it('reads both patch sources a package may ship', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-exprrows-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'ds-harness-remote',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))
      writeFileSync(join(dir, 'cordis.patch.yml'), [
        '- insert:',
        '    - id: remote',
        '      name: dsh-remote',
        '    - id: remote-tui',
        '      name: dsh-remote-tui',
        '      disabled: !!js >-',
        "        ![...ctx.loader.entries()].some(entry => entry.options.id === 'dsh-tui')",
        '',
      ].join('\n'))
      // #792: a declared LIST contributes every file it names.
      writeFileSync(join(dir, 'extra.patch.yml'), '- id: extra-expression\n  disabled: !!js 1 === 1\n')
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      manifest.dsh.bundle.patch = ['./cordis.patch.yml', './extra.patch.yml']
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
      expect([...bundleExpressionRowIds(dir)].sort()).toEqual(['extra-expression', 'remote-tui'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers with nothing for a package whose rows are all literal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-exprrows-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'dsh-mnemon',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))
      writeFileSync(join(dir, 'cordis.patch.yml'), [
        '- insert:',
        '    - id: mnemon',
        '      name: dsh-mnemon',
        '    - id: mnemon-strategy-general',
        '      name: dsh-mnemon-strategy-general',
        '      disabled: true',
        '',
      ].join('\n'))
      expect(bundleExpressionRowIds(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('shippedInsertedRowIds (#1012)', () => {
  it('unions every declared patch file with the conventional root file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-shipped-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'dsh-renamed',
        dsh: { bundle: { patch: ['./a.patch.yml', './b.patch.yml'] } },
      }))
      // A declared LIST is composed in order (#792) and the root file is read
      // even though the package declared patches of its own: the identity
      // question is "what does this package register", and a package that
      // ships both registers both. The install-path gate reads the declaration
      // only, which is why this reader cannot be that one.
      writeFileSync(join(dir, 'a.patch.yml'), '- insert:\n    - id: row-one\n      name: dsh-renamed\n')
      writeFileSync(join(dir, 'b.patch.yml'), [
        '- insert:',
        '    - id: row-two',
        '      name: dsh-renamed',
        '    - id: row-one',
        '      name: dsh-renamed',
        '',
      ].join('\n'))
      writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n    - id: row-three\n      name: dsh-renamed\n')
      expect([...shippedInsertedRowIds(dir)].sort()).toEqual(['row-one', 'row-three', 'row-two'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves out rows the package only reconfigures (#147)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-shipped-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'dsh-vision-router',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))
      // `attachment-local` belongs to another package: counting it as this
      // one's evidence would let a neighbour's row decide what "one plugin"
      // means, the split #147 exists to keep.
      writeFileSync(join(dir, 'cordis.patch.yml'), [
        '- insert:',
        '    - id: vision-router',
        '      name: dsh-vision-router',
        '- id: attachment-local',
        '  config: { maxImageBytes: 1048576 }',
        '',
      ].join('\n'))
      expect(shippedInsertedRowIds(dir)).toEqual(['vision-router'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers with nothing for a package that ships no patch, or one that cannot be read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-shipped-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'plain' }))
      expect(shippedInsertedRowIds(dir)).toEqual([])
      // Declared but absent: the package says nothing through a file that is
      // not there, and silence must not become a contradiction downstream.
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'plain', dsh: { bundle: { patch: './missing.patch.yml' } },
      }))
      expect(shippedInsertedRowIds(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
