/**
 * Profile filesystem reads against real fixture directories (DSH_HOME is
 * pointed at a tmpdir per test).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  conflictingEntryIds, entryArtifactExists, hasDshManifest, hasLoadableEntry, pluginSubdirs, profileDir,
  readInstalled, readInstalledManifest, readInstalledRepoEvidence, readInstalledRepoIdentities, readInstalledVersion, readLockCommits,
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

describe('readInstalledRepoEvidence (#141)', () => {
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

describe('readLockCommits', () => {
  it('extracts pinned commits from codeload URLs keyed lowercase; empty without a lockfile', () => {
    writeProfile({})
    expect(readLockCommits('web').size).toBe(0)
    writeFileSync(join(profileDir('web'), 'pnpm-lock.yaml'),
      '  https://codeload.github.com/Owner/Repo/tar.gz/0123456789abcdef0123456789abcdef01234567:\n')
    expect(readLockCommits('web').get('owner/repo')).toBe('0123456789abcdef0123456789abcdef01234567')
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

  it('restoreManifestDeps drops ghost entries and reverts bumped specs, preserving other fields', async () => {
    const { readManifestDeps, restoreManifestDeps } = await import('../src/profile.ts')
    const dir = writeProfile({
      name: 'web-profile',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      dependencies: { 'dsh-loop': '^1.0.0', '@deepseek-ai/dsh-base': 'latest' },
    })
    const snapshot = readManifestDeps('web')
    // Simulate pnpm's partial write of a failed run: a ghost dep appears
    // and an existing pin is bumped.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'web-profile',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      dependencies: { 'dsh-loop': '^1.2.0', '@deepseek-ai/dsh-base': 'latest', 'ghost-pkg': '0.1.0-rc.6' },
    }))
    const rolledBack = restoreManifestDeps('web', snapshot)
    expect(rolledBack.sort()).toEqual(['dsh-loop', 'ghost-pkg'])
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(manifest.dependencies).toEqual({ 'dsh-loop': '^1.0.0', '@deepseek-ai/dsh-base': 'latest' })
    // The in-box bundle survived, and non-dependency fields are untouched.
    expect(manifest.dsh).toEqual({ profile: { bundles: ['@deepseek-ai/dsh-base'] } })
    expect(manifest.name).toBe('web-profile')
    // A second restore is a no-op.
    expect(restoreManifestDeps('web', snapshot)).toEqual([])
  })
})

describe('setAllowBuilds (#6)', () => {
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
    const approved = setAllowBuilds('web', ['dsh-audit@git+https://github.com/omdsh-dev/dsh-audit.git', 'dsh-audit', 'evil@git+https://evil.example/x.git'])
    expect(approved).toContain('keep-me@git+https://github.com/o/keep-me.git')
    expect(approved).toContain('dsh-audit@git+https://github.com/omdsh-dev/dsh-audit.git')
    expect(approved).toContain('dsh-audit')
    expect(approved).not.toContain('evil@git+https://evil.example/x.git')
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
