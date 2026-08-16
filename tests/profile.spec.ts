/**
 * Profile filesystem reads against real fixture directories (DSH_HOME is
 * pointed at a tmpdir per test).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  entryArtifactExists, hasDshManifest, pluginSubdirs, profileDir,
  readInstalled, readInstalledVersion, readLockCommits,
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

  it('creates the block when the yaml has none', async () => {
    const { setAllowBuilds } = await import('../src/profile.ts')
    const dir = writeProfile({})
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    setAllowBuilds('web', ['pkg-a'])
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toMatch(/packages:[\s\S]*allowBuilds:\n  pkg-a: true/)
  })
})
