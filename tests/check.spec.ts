/**
 * Unit tests for the profile composition diagnostics (issue #98, phase 1) —
 * src/check.ts. Pure filesystem analysis, exercised against per-test tmpdir
 * fixtures (same pattern as tests/profile.spec.ts): the profile directory is
 * constructed manually under a mkdtemp tmpdir, and DSH_HOME is pointed there
 * so the home-level cordis.patch.yml layer can never leak into a test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump } from 'js-yaml'
import {
  analyzeProfile,
  compareSemver,
  corePackageNames,
  findDshInstallDir,
  satisfiesRange,
} from '../src/check.ts'
import { desktopApplicationRoots, dshHostInfo } from '../src/dsh-install.ts'
import { readBundleRules } from '../src/order.ts'
import { canCreateSymlink } from './symlink-support.ts'
import { trialValidate } from '../src/trial.ts'

let tmp: string
const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dshm-check-'))
  process.env.DSH_HOME = tmp
})
afterEach(() => {
  delete process.env.DSH_HOME
  if (originalResourcesPath === undefined) {
    delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  } else {
    Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
  }
  rmSync(tmp, { recursive: true, force: true })
})

/** A fresh profile directory inside the per-test tmpdir. */
function pdir(name = 'profile'): string {
  return join(tmp, name)
}

/** Write the profile manifest (package.json) into `dir`. */
function writeProfile(dir: string, manifest: unknown): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
}

/** Write a package manifest at base/node_modules/<name>. */
function writePackage(base: string, name: string, manifest: unknown): string {
  const dir = join(base, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  return dir
}

/** Write a minimal package that Node's ESM resolver can actually import. */
function writeLoadablePackage(base: string, name: string): string {
  const dir = writePackage(base, name, {
    name,
    version: '1.0.0',
    type: 'module',
    exports: './index.js',
  })
  writeFileSync(join(dir, 'index.js'), 'export default {}\n')
  return dir
}

/** Write a dsh bundle package (dsh.bundle.patch entry-list) at base/node_modules/<name>. */
function writeBundle(
  base: string,
  name: string,
  version: string,
  patch: unknown[],
  order?: unknown,
): string {
  const dir = writePackage(base, name, {
    name,
    version,
    dsh: { bundle: { patch: './cordis.patch.yml', ...(order === undefined ? {} : { order }) } },
  })
  writeFileSync(join(dir, 'cordis.patch.yml'), dump(patch))
  return dir
}

describe('a bundle that declares several patch files (#676)', () => {
  it('accepts a patch LIST and collects entries from every file', () => {
    // dsh 0.1.7's own `@deepseek-ai/dsh-web-app` declares five patch files —
    // a base one plus four presets — and the official headless template
    // includes that bundle. Requiring a string therefore reported "the
    // profile will fail to boot" for the DEFAULT layout, while
    // `dsh --dump-config` composed it with exit 0.
    const dir = pdir()
    writeProfile(dir, {
      name: 'web-profile',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } },
      dependencies: { '@deepseek-ai/dsh-web-app': '^0.1.7-alpha.1' },
    })
    const bundle = writePackage(dir, '@deepseek-ai/dsh-web-app', {
      name: '@deepseek-ai/dsh-web-app',
      version: '0.1.7-alpha.1',
      dsh: { bundle: { patch: ['./cordis.patch.yml', './presets/standard.patch.yml'] } },
    })
    writeLoadablePackage(dir, 'web-app-core')
    writeLoadablePackage(dir, 'preset-standard')
    mkdirSync(join(bundle, 'presets'), { recursive: true })
    writeFileSync(join(bundle, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'web-app-core', name: 'web-app-core' }] },
    ]))
    writeFileSync(join(bundle, 'presets', 'standard.patch.yml'), dump([
      { insert: [{ id: 'preset-standard', name: 'preset-standard' }] },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: dir })

    expect(report.summary.errors).toEqual([])
    // BOTH files contribute: a reader who only parsed the first would see
    // the second patch's rows as unknown ids everywhere downstream.
    const layer = report.bundles.find(entry => entry.name === '@deepseek-ai/dsh-web-app')
    expect(layer?.entries).toEqual(expect.arrayContaining(['web-app-core', 'preset-standard']))
  })

  it('still reports a declared file that is missing, naming the one that is', () => {
    const dir = pdir()
    writeProfile(dir, {
      name: 'web-profile',
      dsh: { profile: { bundles: ['multi'] } },
      dependencies: { multi: '^1.0.0' },
    })
    const bundle = writePackage(dir, 'multi', {
      name: 'multi',
      version: '1.0.0',
      dsh: { bundle: { patch: ['./cordis.patch.yml', './presets/gone.patch.yml'] } },
    })
    writeFileSync(join(bundle, 'cordis.patch.yml'), dump([{ insert: [] }]))

    const report = analyzeProfile(dir, { dshInstallDir: dir })

    expect(report.summary.errors).toEqual([
      'bundle multi: declared patch ./presets/gone.patch.yml is missing — the profile will fail to boot',
    ])
  })

  it('still reports a bundle that declares no patch at all', () => {
    const dir = pdir()
    writeProfile(dir, {
      name: 'web-profile',
      dsh: { profile: { bundles: ['bare'] } },
      dependencies: { bare: '^1.0.0' },
    })
    writePackage(dir, 'bare', { name: 'bare', version: '1.0.0', dsh: { bundle: {} } })

    const report = analyzeProfile(dir, { dshInstallDir: dir })

    expect(report.summary.errors).toEqual([
      'bundle bare: bundle declares no dsh.bundle.patch — the profile will fail to boot',
    ])
  })
})

describe('bundle stack (#98 diagnostics)', () => {
  it('keeps dsh.profile.bundles order and classifies official vs community', () => {
    const dir = pdir()
    writeProfile(dir, {
      name: 'web-profile',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-market'] } },
      dependencies: { '@deepseek-ai/dsh-base': '^4.0.1', 'dsh-market': '^1.9.0' },
    })
    writeBundle(dir, '@deepseek-ai/dsh-base', '4.0.1', [
      { insert: [{ id: 'dsh-base', name: 'dsh-base' }] },
    ])
    writeBundle(dir, 'dsh-market', '1.9.0', [
      { insert: [{ id: 'dsh-market', name: 'dshmarket' }] },
    ])

    // This fixture deliberately models a visible DSH installation anchor.
    const report = analyzeProfile(dir, { dshInstallDir: dir })

    // Order comes straight from dsh.profile.bundles.
    expect(report.bundles.map(b => b.name)).toEqual(['@deepseek-ai/dsh-base', 'dsh-market'])
    // Classification: in-box dsh bundle vs community plugin.
    expect(report.bundles[0]?.kind).toBe('official')
    expect(report.bundles[1]?.kind).toBe('community')
    // Dependency spec and resolved location.
    expect(report.bundles[0]?.source).toBe('^4.0.1')
    expect(report.bundles[1]?.source).toBe('^1.9.0')
    expect(report.bundles[0]?.directory).not.toBeNull()
    expect(report.bundles[0]?.patchPath).not.toBeNull()
    expect(report.bundles[0]?.error).toBeNull()
    // Loader entries collected from each layer's patch, in stack order.
    expect(report.bundles[0]?.entries).toEqual(['dsh-base'])
    expect(report.bundles[1]?.entries).toEqual(['dsh-market'])
    expect(report.rows.map(r => r.id)).toEqual(['dsh-base', 'dsh-market'])
    expect(report.summary.ok).toBe(true)
  })

  it('flags a bundle whose package directory is missing as a boot failure', () => {
    const dir = pdir()
    writeProfile(dir, {
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'missing-bundle'] } },
      dependencies: { '@deepseek-ai/dsh-base': '^4.0.1', 'missing-bundle': '^1.0.0' },
    })
    writeBundle(dir, '@deepseek-ai/dsh-base', '4.0.1', [{ insert: [{ id: 'x' }] }])

    const report = analyzeProfile(dir, { dshInstallDir: dir })
    const missing = report.bundles.find(b => b.name === 'missing-bundle')
    expect(missing).toBeDefined()
    expect(missing?.directory).toBeNull()
    expect(missing?.error).not.toBeNull()
    expect(report.summary.errors.some(e => e.includes('missing-bundle'))).toBe(true)
    expect(report.summary.ok).toBe(false)
  })
})

describe('workspace-root hoisted bundles (#98 review B1)', () => {
  it('resolves a bundle that physically lives only in the parent node_modules', () => {
    // dsh layouts share <profiles>/node_modules as the workspace root: the
    // bundle package is NOT inside the profile's own node_modules, only at
    // tmp/node_modules/bundle-a. createRequire's upward search (the same
    // resolution the boot uses) must find it.
    const dir = pdir() // tmp/profile
    writeProfile(dir, {
      name: 'web-profile',
      dsh: { profile: { bundles: ['bundle-a'] } },
      dependencies: { 'bundle-a': '^1.0.0' },
    })
    const root = join(tmp, 'node_modules', 'bundle-a')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'bundle-a',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(root, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'a-entry', name: 'bundle-a' }] },
    ]))
    // Guard the fixture itself: the profile must NOT carry a local copy.
    expect(existsSync(join(dir, 'node_modules', 'bundle-a'))).toBe(false)

    const report = analyzeProfile(dir)
    const bundle = report.bundles[0]
    expect(bundle?.name).toBe('bundle-a')
    expect(bundle?.error).toBeNull()
    expect(bundle?.parseError).toBeNull()
    expect(bundle?.entries).toEqual(['a-entry'])
    expect(bundle?.directory).toBe(root)
    expect(report.rows.map(r => r.id)).toEqual(['a-entry'])
    expect(report.summary.ok).toBe(true)
  })
})

describe('a host peer is not read from another installation (#726)', () => {
  /** The reporter's machine: the Desktop app, plus a global npm CLI whose closure sits in the shared root. */
  function fixture(): string {
    const dir = pdir('desktop-profile')
    writeProfile(dir, { name: 'desktop-profile', dependencies: { 'dsh-plugin-x': '^1.0.0' } })
    writePackage(dir, 'dsh-plugin-x', {
      name: 'dsh-plugin-x',
      version: '1.0.0',
      peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.2' },
    })
    // <profiles>/node_modules is shared by every profile. Here it belongs to
    // the OTHER installation — the global CLI, four minor versions behind.
    writePackage(tmp, '@deepseek-ai/dsh', { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' })
    return dir
  }

  it('leaves a host-plane peer unknown when the install dir cannot be located', () => {
    // Reading that shared copy as "the host" reported a healthy install as
    // "introduced host-compatibility risks … vs 0.1.5-rc.2" and offered a
    // rollback. Unknown is not wrong — the rule #676 settled for bundles.
    const report = analyzeProfile(fixture(), { dshInstallDir: null })
    const peer = report.peerMismatches.find(mismatch => mismatch.name === '@deepseek-ai/dsh')
    expect(peer?.resolved).toBeNull()
    expect(peer?.satisfied).toBeNull()
  })

  /** Write the host package at `install`, so its shared root holds the version. */
  const hostAt = (install: string): void => {
    mkdirSync(install, { recursive: true })
    writeFileSync(join(install, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.2' }, null, 2))
  }
  it.each([
    ['the CLI package directory', (prefix: string) => join(prefix, 'node_modules', '@deepseek-ai', 'dsh')],
    ['the nested app.asar/dsh package directory (#778)', (prefix: string) => join(prefix, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh')],
  ])('asks the SHARED root when the located install is %s (#676)', (_shape, installOf) => {
    // `dshHostInfo()` answers a PACKAGE directory in both of these layouts.
    // `readNodeModulesVersion` takes a package root and appends `node_modules`
    // itself, so passing the package directory read `<package>/node_modules/…`
    // — absent here, which left the located installation silently unasked and
    // the version unknown even though the caller promised to ask it.
    const dir = fixture()
    const prefix = pdir('cli-prefix')
    const install = installOf(prefix)
    hostAt(install)

    const report = analyzeProfile(dir, { dshInstallDir: install })
    const peer = report.peerMismatches.find(mismatch => mismatch.name === '@deepseek-ai/dsh')

    expect(peer?.resolved).toBe('0.1.7-rc.2')
    expect(peer?.satisfied).toBe(true)
  })

  it('does not answer from the host package\'s own nested scope (#676)', () => {
    // Where the host package carries its own `@deepseek-ai` scope (pnpm
    // isolated trees) the old splice did not answer null — it answered from
    // that truncated subset, which is the opposite of the "unknown rather than
    // wrong" the rule promises: here it would report a healthy install as a
    // peer mismatch against a package that is not the host's.
    const dir = fixture()
    const prefix = pdir('cli-prefix-nested')
    writePackage(prefix, '@deepseek-ai/dsh', { name: '@deepseek-ai/dsh', version: '0.1.7-rc.2' })
    writePackage(join(prefix, 'node_modules', '@deepseek-ai', 'dsh'), '@deepseek-ai/dsh', {
      name: '@deepseek-ai/dsh',
      version: '0.0.1',
    })

    const report = analyzeProfile(dir, {
      dshInstallDir: join(prefix, 'node_modules', '@deepseek-ai', 'dsh'),
    })
    const peer = report.peerMismatches.find(mismatch => mismatch.name === '@deepseek-ai/dsh')

    expect(peer?.resolved).toBe('0.1.7-rc.2')
    expect(peer?.satisfied).toBe(true)
  })

  it('still asks the located installation itself, which satisfies the peer', () => {
    const install = pdir('dsh-install')
    writePackage(install, '@deepseek-ai/dsh', { name: '@deepseek-ai/dsh', version: '0.1.7-rc.2' })
    const report = analyzeProfile(fixture(), { dshInstallDir: install })
    const peer = report.peerMismatches.find(mismatch => mismatch.name === '@deepseek-ai/dsh')
    expect(peer?.resolved).toBe('0.1.7-rc.2')
    expect(peer?.satisfied).toBe(true)
  })
})

describe('shared DSH home resolution', () => {
  it('does not treat the process directory as home when DSH_HOME is empty', () => {
    const dir = pdir('blank-home-profile')
    const cwd = pdir('blank-home-cwd')
    const previousCwd = process.cwd()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'blank-home-trap', name: 'must-not-load' }] },
    ]))
    process.env.DSH_HOME = ''

    try {
      process.chdir(cwd)
      const report = analyzeProfile(dir, { dshInstallDir: null })
      expect(report.rows.map(row => row.id)).not.toContain('blank-home-trap')
    } finally {
      process.chdir(previousCwd)
    }
  })
})

describe('user patch package resolution (#205)', () => {
  const resolutionErrors = (errors: string[]): string[] =>
    errors.filter(line => line.includes('loader package') || line.includes('loader specifier') || line.includes('has no module name'))

  it('flags a missing package inserted by the profile patch as a boot failure', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'rp-plugin', name: '@dsh-rp/missing' }] },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: null, homeDir: join(tmp, 'empty-home') })

    expect(report.rows).toContainEqual({
      id: 'rp-plugin',
      layer: 'user-patch',
      kind: 'insert',
      name: '@dsh-rp/missing',
    })
    expect(resolutionErrors(report.summary.errors)).toEqual([
      'user-patch: loader package @dsh-rp/missing is not installed in the profile — the profile will fail to boot',
    ])
    expect(report.summary.ok).toBe(false)
  })

  it('normalizes a scoped package subpath to its installed npm package root', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: { '@scope/plugin': '^1.0.0' } })
    const plugin = writePackage(dir, '@scope/plugin', {
      name: '@scope/plugin',
      version: '1.0.0',
      type: 'module',
      exports: { './runtime': './runtime.js' },
    })
    writeFileSync(join(plugin, 'runtime.js'), 'throw new Error("must not execute during check")\n')
    writePackage(dir, 'legacy-package', { name: 'legacy-package', version: '1.0.0' })
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      {
        insert: [
          { id: 'runtime', name: '@scope/plugin/runtime' },
          { id: 'double-slash', name: 'legacy-package//index.js' },
          { id: 'dot-segment', name: 'legacy-package/./index.js' },
          { id: 'parent-segment', name: 'legacy-package/../legacy-package/index.js' },
        ],
      },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: null, homeDir: join(tmp, 'empty-home') })

    expect(resolutionErrors(report.summary.errors)).toEqual([])
    expect(report.summary.ok).toBe(true)
  })

  it('accepts a profile package self-reference without a node_modules copy', () => {
    const dir = pdir()
    writeProfile(dir, {
      name: 'self-profile',
      exports: { '.': './index.js' },
      dependencies: {},
    })
    writeFileSync(join(dir, 'index.js'), 'export default {}\n')
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([{
      insert: [{ id: 'self', name: 'self-profile' }],
    }]))

    const report = analyzeProfile(dir, { dshInstallDir: null, homeDir: join(tmp, 'empty-home') })

    expect(existsSync(join(dir, 'node_modules', 'self-profile'))).toBe(false)
    expect(resolutionErrors(report.summary.errors)).toEqual([])
  })

  it('does not treat exports:null as a resolvable profile self-reference', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'self-profile', exports: null, dependencies: {} })
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([{
      insert: [{ id: 'self', name: 'self-profile' }],
    }]))

    const report = analyzeProfile(dir, { dshInstallDir: null, homeDir: join(tmp, 'empty-home') })

    expect(resolutionErrors(report.summary.errors)).toEqual([
      'user-patch: loader package self-profile is not installed in the profile — the profile will fail to boot',
    ])
  })

  it('accepts Node-resolvable legacy and Unicode package roots', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writePackage(dir, '_private', { name: '_private', version: '1.0.0' })
    writePackage(dir, '@_scope/_pkg', { name: '@_scope/_pkg', version: '1.0.0' })
    writePackage(dir, '插件', { name: '插件', version: '1.0.0' })
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([{
      insert: [
        { id: 'private', name: '_private/runtime' },
        { id: 'scoped-private', name: '@_scope/_pkg/runtime' },
        { id: 'unicode', name: '插件/runtime' },
      ],
    }]))

    const report = analyzeProfile(dir, { dshInstallDir: null, homeDir: join(tmp, 'empty-home') })

    expect(resolutionErrors(report.summary.errors)).toEqual([])
    expect(report.summary.ok).toBe(true)
  })

  it('uses the profile workspace-root fallback that is visible to the Loader', () => {
    const profiles = join(tmp, 'profiles')
    const dir = join(profiles, 'web')
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writeLoadablePackage(profiles, 'workspace-plugin')
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'workspace', name: 'workspace-plugin' }] },
    ]))

    expect(existsSync(join(dir, 'node_modules', 'workspace-plugin'))).toBe(false)
    expect(existsSync(join(tmp, 'node_modules', 'workspace-plugin'))).toBe(false)
    const report = analyzeProfile(dir, { dshInstallDir: null, homeDir: join(tmp, 'empty-home') })

    expect(resolutionErrors(report.summary.errors)).toEqual([])
    expect(report.summary.ok).toBe(true)
  })

  it('does not accept an install-only package that the profile Loader cannot see', () => {
    const dir = pdir()
    const dshInstall = join(tmp, 'dsh-install')
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writeProfile(dshInstall, { name: '@deepseek-ai/dsh' })
    writeLoadablePackage(dshInstall, '@issue205/host-only-plugin')
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'host-only', name: '@issue205/host-only-plugin' }] },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: dshInstall, homeDir: join(tmp, 'empty-home') })

    expect(resolutionErrors(report.summary.errors)).toEqual([
      'user-patch: loader package @issue205/host-only-plugin is not installed in the profile — the profile will fail to boot',
    ])
  })

  it('accepts an official host package in a Desktop user patch', () => {
    const dir = pdir()
    const dshInstall = join(tmp, 'dsh-install')
    writeProfile(dir, { name: 'desktop-profile', dependencies: {} })
    writeProfile(dshInstall, { name: '@deepseek-ai/dsh' })
    writeLoadablePackage(dshInstall, '@deepseek-ai/dsh-mcp-client')
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'official-mcp', name: '@deepseek-ai/dsh-mcp-client' }] },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: dshInstall, homeDir: join(tmp, 'empty-home') })
    expect(resolutionErrors(report.summary.errors)).toEqual([])
  })

  it('accepts an install-level package a user patch can reach, without a list of names (#676)', () => {
    // qikairo7's counterexample, as a fixture: `@deepseek-ai/dsh-agent-preset`
    // exists ONLY in the installation, and its cordis.patch.yml row was
    // proven to resolve (`dsh --profile web --dump-config` EXIT=0, entries in
    // the tree). It is not one of the curated core names in the seed list, so
    // the only thing that can recognise it is the installation's own
    // node_modules inventory — which is the point: that inventory is the
    // authority, not a list maintained here.
    const dir = pdir()
    const dshInstall = join(tmp, 'dsh-install')
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writeProfile(dshInstall, { name: '@deepseek-ai/dsh' })
    writeLoadablePackage(dshInstall, '@deepseek-ai/dsh-agent-preset')
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset' }] },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: dshInstall, homeDir: join(tmp, 'empty-home') })

    expect(resolutionErrors(report.summary.errors)).toEqual([])
  })

  it('accepts a host package when the located install is the CLI package directory (#676)', () => {
    // hmtime's report: `findDshInstallDir()` located the host fine, but the
    // directory it answered was the package directory
    // `<app>/node_modules/@deepseek-ai/dsh`. corePackageNames spliced
    // `node_modules/@deepseek-ai` onto THAT, the readdir threw two levels
    // deep, the curated seed stood, and a user-patch insert of a package the
    // host genuinely ships read as fatal. Same fixture as the #676 case
    // above except the install dir carries the CLI layout — the shape
    // production hands this function every day.
    const dir = pdir()
    const prefix = join(tmp, 'cli-install')
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    // writePackage puts the manifest under <prefix>/node_modules/<name>, so
    // this yields exactly dshHostInfo's CLI answer: the package directory.
    const dshInstall = writePackage(prefix, '@deepseek-ai/dsh', { name: '@deepseek-ai/dsh' })
    writeLoadablePackage(prefix, '@deepseek-ai/dsh-agent-preset')
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset' }] },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: dshInstall, homeDir: join(tmp, 'empty-home') })

    expect(resolutionErrors(report.summary.errors)).toEqual([])
  })

  it('does not call confirmed app.asar host packages missing profile dependencies', () => {
    const dir = pdir()
    const dshInstall = join(tmp, 'resources', 'app.asar', 'dsh')
    writeProfile(dir, {
      name: 'desktop-profile',
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-experimental-agent-team-profile'] } },
    })
    writeProfile(dshInstall, { name: '@deepseek-ai/dsh' })
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'official-mcp', name: '@deepseek-ai/dsh-mcp-client' }] },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: dshInstall, homeDir: join(tmp, 'empty-home') })
    expect(report.bundles[0]).toMatchObject({
      kind: 'official',
      error: null,
      unresolvedInbox: true,
    })
    expect(report.summary.errors).toEqual([])
    expect(report.summary.warnings).toContain(
      'user-patch: bundled Desktop loader @deepseek-ai/dsh-mcp-client could not be independently resolved from app.asar',
    )
  })

  it('keeps missing Agent Team and MCP packages fatal outside the packaged Desktop', () => {
    const dir = pdir()
    const dshInstall = join(tmp, 'dsh-install')
    writeProfile(dir, {
      name: 'web-profile',
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-experimental-agent-team-profile'] } },
    })
    writeProfile(dshInstall, { name: '@deepseek-ai/dsh' })
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'official-mcp', name: '@deepseek-ai/dsh-mcp-client' }] },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: dshInstall, homeDir: join(tmp, 'empty-home') })
    expect(report.summary.errors.some(error => error.includes('dsh-experimental-agent-team-profile'))).toBe(true)
    expect(report.summary.errors.some(error => error.includes('dsh-mcp-client'))).toBe(true)
  })

  // The two fixed lists that used to carry this rule — one bundle name, one
  // loader name — are what made #676 a report that kept coming back: each new
  // name a Desktop build shipped walked past them into a fatal verdict while
  // the entries were live in the running host. The rule is the LAYOUT (an
  // archive nothing can be probed inside) plus the SCOPE (only DeepSeek
  // publishes the host), and these two tests are the names those lists did
  // not have.
  it('reads an unseen official Desktop bundle as unknown rather than missing', () => {
    const dir = pdir()
    const dshInstall = join(tmp, 'resources', 'app.asar', 'dsh')
    writeProfile(dir, {
      name: 'desktop-profile',
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-experimental-agent-team-web-profile'] } },
    })
    writeProfile(dshInstall, { name: '@deepseek-ai/dsh' })

    const report = analyzeProfile(dir, { dshInstallDir: dshInstall, homeDir: join(tmp, 'empty-home') })

    expect(report.bundles[0]).toMatchObject({
      kind: 'official',
      error: null,
      unresolvedInbox: true,
    })
    expect(report.summary.errors).toEqual([])
  })

  it('reads an unseen official Desktop loader as a warning rather than a boot failure', () => {
    const dir = pdir()
    const dshInstall = join(tmp, 'resources', 'app.asar', 'dsh')
    writeProfile(dir, { name: 'desktop-profile', dependencies: {} })
    writeProfile(dshInstall, { name: '@deepseek-ai/dsh' })
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'official-skill', name: '@deepseek-ai/dsh-skill-manage' }] },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: dshInstall, homeDir: join(tmp, 'empty-home') })

    expect(report.summary.errors).toEqual([])
    expect(report.summary.warnings).toContain(
      'user-patch: bundled Desktop loader @deepseek-ai/dsh-skill-manage could not be independently resolved from app.asar',
    )
  })

  it('still fails a community bundle declared on a packaged Desktop', () => {
    // The archive is blind to the host's own packages, not to the profile's:
    // a community bundle resolves through the profile's node_modules
    // ancestry, which this process probes normally, so a missing one is a
    // real boot failure and must not ride along with the official names.
    const dir = pdir()
    const dshInstall = join(tmp, 'resources', 'app.asar', 'dsh')
    writeProfile(dir, {
      name: 'desktop-profile',
      dependencies: {},
      dsh: { profile: { bundles: ['@someone/community-bundle'] } },
    })
    writeProfile(dshInstall, { name: '@deepseek-ai/dsh' })

    const report = analyzeProfile(dir, { dshInstallDir: dshInstall, homeDir: join(tmp, 'empty-home') })

    expect(report.bundles[0]).toMatchObject({ kind: 'community', error: expect.stringContaining('not installed') })
    expect(report.summary.errors.some(error => error.includes('community-bundle'))).toBe(true)
  })

  it('names the leftover directories the profile no longer declares (#663)', () => {
    const dir = pdir()
    writeProfile(dir, {
      name: 'web-profile',
      dependencies: { 'dsh-loop': '^1.0.0', 'broken-declared': '^1.0.0' },
      dsh: { profile: { bundles: ['dsh-loop', 'broken-declared'] } },
    })
    writeLoadablePackage(dir, 'dsh-loop')
    // The shape a lock-blocked update leaves: the directory is still there,
    // its package.json is not, and the declaration that pointed at it is gone.
    mkdirSync(join(dir, 'node_modules', 'dsh-pet'), { recursive: true })
    // pnpm's staging directory, top level.
    mkdirSync(join(dir, 'node_modules', 'dsh-pet_tmp_15548_10'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'dsh-pet_tmp_15548_10', 'lib'), { recursive: true })
    // ...and one for a dependency, which pnpm stages beside it in the store.
    mkdirSync(join(dir, 'node_modules', '.pnpm', 'dsh-loop@1.0.0', 'node_modules', 'dsh-loop_tmp_99_2'), { recursive: true })
    // A DECLARED package with a broken directory is not a leftover: the
    // bundle layers already say it cannot load, and calling it junk here
    // would tell the user to clear a package the profile is asking for.
    writeProfile(join(dir, 'node_modules', 'broken-declared'), { name: 'broken-declared' })
    rmSync(join(dir, 'node_modules', 'broken-declared', 'package.json'))

    const report = analyzeProfile(dir, { dshInstallDir: null, homeDir: join(tmp, 'empty-home') })

    expect(report.residuals).toEqual([
      { name: 'dsh-loop', path: join('node_modules', '.pnpm', 'dsh-loop@1.0.0', 'node_modules', 'dsh-loop_tmp_99_2'), kind: 'tmp-directory', declared: true },
      { name: 'dsh-pet', path: join('node_modules', 'dsh-pet'), kind: 'incomplete-package', declared: false },
      { name: 'dsh-pet', path: join('node_modules', 'dsh-pet_tmp_15548_10'), kind: 'tmp-directory', declared: false },
    ])
    // Nothing here is a boot failure, and the summary must not read like one:
    // a warning on every profile that ever had an interrupted install is how
    // a list stops being read.
    // ...and the declared one is reported by the other surface instead,
    // which is where a user looking for "why will this not boot" is sent.
    // The bundle layers own that one, and this is the surface the notice
    // points at. Its wording is "not installed" even though the directory is
    // sitting right there — accurate about the boot ("will fail to boot"),
    // imprecise about what the user will see in `node_modules`. Left as-is
    // rather than quietly encoded: the leftover listing above is what names
    // the directory, and changing the layer message is a separate edit.
    expect(report.bundles.find(layer => layer.name === 'broken-declared')?.error)
      .toContain('will fail to boot')
    // A leftover is not a boot failure, and the summary must not read like
    // one: a warning on every profile that ever had an interrupted install is
    // how a list stops being read. (These fixtures fail to BOOT for their own
    // reasons — the leftover names must simply not be among them.)
    expect(report.summary.errors.filter(line => line.includes('dsh-pet'))).toEqual([])
    expect(report.summary.warnings.filter(line => line.includes('dsh-pet'))).toEqual([])
  })

  it('leaves healthy packages and pnpm links out of the leftover list', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writeLoadablePackage(dir, 'healthy')
    // Every installed package is a symlink into the store; flagging those
    // would put every profile in existence on this list.
    mkdirSync(join(dir, 'node_modules', '.pnpm', 'linked@1.0.0', 'node_modules', 'linked'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '.pnpm', 'linked@1.0.0', 'node_modules', 'linked', 'package.json'), '{"name":"linked"}')
    symlinkSync(join('..', '.pnpm', 'linked@1.0.0', 'node_modules', 'linked'), join(dir, 'node_modules', 'linked'), 'dir')

    const report = analyzeProfile(dir, { dshInstallDir: null, homeDir: join(tmp, 'empty-home') })

    expect(report.residuals).toEqual([])
  })

  it('does not skip a broken nearer package directory for a healthy parent copy', () => {
    const profiles = join(tmp, 'profiles')
    const dir = join(profiles, 'web')
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writeLoadablePackage(profiles, 'shadowed-plugin')
    writeLoadablePackage(profiles, 'file-shadow-plugin')
    mkdirSync(join(dir, 'node_modules', 'shadowed-plugin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'file-shadow-plugin'), 'not a package directory')
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([{
      insert: [
        { id: 'shadowed', name: 'shadowed-plugin' },
        { id: 'file-shadow', name: 'file-shadow-plugin' },
      ],
    }]))

    const report = analyzeProfile(dir, { dshInstallDir: null, homeDir: join(tmp, 'empty-home') })

    expect(resolutionErrors(report.summary.errors)).toEqual([
      'user-patch: loader package shadowed-plugin is not installed in the profile — the profile will fail to boot',
    ])
  })

  it('does not check an insert skipped because its target group is missing', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      {
        id: 'missing-group',
        insert: [{ id: 'skipped', name: 'missing-but-never-loaded' }],
      },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: null, homeDir: join(tmp, 'empty-home') })

    expect(report.rows.some(row => row.id === 'skipped')).toBe(false)
    expect(resolutionErrors(report.summary.errors)).toEqual([])
    expect(report.summary.warnings).toContain(
      'user-patch: missing-group — insert target not found',
    )
    expect(report.summary.ok).toBe(true)
  })

  it('checks a user package inserted into a group supplied by a bundle', () => {
    const dir = pdir()
    writeProfile(dir, {
      name: 'web-profile',
      dependencies: { 'base-bundle': '^1.0.0' },
      dsh: { profile: { bundles: ['base-bundle'] } },
    })
    writeBundle(dir, 'base-bundle', '1.0.0', [
      { insert: [{ id: 'bundle-group', name: 'cordis:group', group: true, config: [] }] },
    ])
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      {
        id: 'bundle-group',
        insert: [{ id: 'user-child', name: 'missing-targeted-plugin' }],
      },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: null, homeDir: join(tmp, 'empty-home') })

    expect(report.rows.find(row => row.id === 'user-child')?.layer).toBe('user-patch')
    expect(resolutionErrors(report.summary.errors)).toEqual([
      'user-patch: loader package missing-targeted-plugin is not installed in the profile — the profile will fail to boot',
    ])
  })

  it('checks nested group children with the layer inherited from their patch', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      {
        insert: [{
          id: 'tools',
          name: 'cordis:group',
          group: true,
          config: [{ id: 'nested-missing', name: 'nested-plugin' }],
        }],
      },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: null, homeDir: join(tmp, 'empty-home') })

    expect(report.rows.find(row => row.id === 'nested-missing')?.layer).toBe('user-patch')
    expect(resolutionErrors(report.summary.errors)).toEqual([
      'user-patch: loader package nested-plugin is not installed in the profile — the profile will fail to boot',
    ])
  })

  it('checks the home patch and deduplicates repeated references within one layer', () => {
    const dir = pdir()
    const home = join(tmp, 'home')
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'cordis.patch.yml'), dump([
      {
        insert: [
          { id: 'one', name: 'missing-home/runtime' },
          { id: 'two', name: 'missing-home/worker' },
        ],
      },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: null, homeDir: home })

    expect(resolutionErrors(report.summary.errors)).toEqual([
      'home-patch: loader package missing-home is not installed in the profile — the profile will fail to boot',
    ])
  })

  it('ignores non-group rows disabled directly, by a parent, by a later layer, or by a truthy literal', () => {
    const dir = pdir()
    const home = join(tmp, 'home')
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    mkdirSync(home, { recursive: true })
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      {
        insert: [
          { id: 'direct-off', name: 'missing-direct', disabled: true },
          { id: 'truthy-off', name: 'missing-truthy', disabled: 'false' },
          {
            id: 'group-off',
            name: 'cordis:group',
            group: true,
            disabled: true,
            config: [{ id: 'child-off', name: 'missing-child' }],
          },
          { id: 'later-off', name: 'missing-later' },
        ],
      },
    ]))
    writeFileSync(join(home, 'cordis.patch.yml'), dump([
      { id: 'later-off', disabled: true },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: null, homeDir: home })

    expect(report.rows.map(row => row.id)).toEqual([
      'direct-off', 'truthy-off', 'group-off', 'child-off', 'later-off',
    ])
    expect(resolutionErrors(report.summary.errors)).toEqual([])
    expect(report.summary.ok).toBe(true)
  })

  it('still resolves custom group modules while their disabled state suppresses descendants', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      {
        insert: [{
          id: 'outer-off',
          name: 'cordis:group',
          group: true,
          disabled: true,
          config: [{
            id: 'custom-group',
            name: 'missing-custom-group',
            group: true,
            config: [{ id: 'suppressed-child', name: 'missing-child' }],
          }],
        }],
      },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: null, homeDir: join(tmp, 'empty-home') })

    expect(resolutionErrors(report.summary.errors)).toEqual([
      'user-patch: loader package missing-custom-group is not installed in the profile — the profile will fail to boot',
    ])
    expect(report.summary.errors.some(line => line.includes('missing-child'))).toBe(false)
  })

  it('reports expression-gated missing modules as conditional warnings, never definite failures', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writeFileSync(join(dir, 'cordis.patch.yml'), [
      '- insert:',
      '  - id: maybe-plugin',
      '    name: missing-conditional',
      '    disabled: !!js process.platform === "win32"',
      '',
    ].join('\n'))

    const report = analyzeProfile(dir, { dshInstallDir: null, homeDir: join(tmp, 'empty-home') })

    expect(resolutionErrors(report.summary.errors)).toEqual([])
    expect(report.summary.warnings).toContain(
      'user-patch: loader package missing-conditional is not installed in the profile — boot will fail if its disabled expression enables the entry',
    )
    expect(report.summary.ok).toBe(true)
  })

  it('reports enabled rows with a missing or empty module name', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'missing-name' }, { id: 'empty-name', name: '' }] },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: null, homeDir: join(tmp, 'empty-home') })

    expect(resolutionErrors(report.summary.errors)).toEqual([
      'user-patch: loader entry "missing-name" has no module name — the profile will fail to boot',
      'user-patch: loader entry "empty-name" has no module name — the profile will fail to boot',
    ])
  })

  it('reports malformed bare specifiers instead of silently skipping them', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      {
        insert: [
          { id: 'scope-only', name: '@scope' },
          { id: 'encoded', name: 'foo%bar' },
        ],
      },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: null, homeDir: join(tmp, 'empty-home') })

    expect(resolutionErrors(report.summary.errors)).toEqual([
      'user-patch: loader specifier "@scope" is not a valid bare package name — the profile will fail to boot',
      'user-patch: loader specifier "foo%bar" is not a valid bare package name — the profile will fail to boot',
    ])
  })

  it('ignores builtins, relative or absolute modules, URLs, and names inside ordinary config', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      {
        insert: [
          { id: 'builtin', name: 'cordis:group' },
          { id: 'node-builtin', name: 'node:path' },
          { id: 'bare-builtin', name: 'fs/promises' },
          { id: 'package-import', name: '#profile-plugin' },
          { id: 'relative', name: './local-plugin.js' },
          { id: 'absolute', name: join(dir, 'local-plugin.js') },
          { id: 'url', name: 'file:///portable/plugin.js' },
          {
            id: 'configured',
            name: 'cordis:group',
            config: [{ name: 'ordinary-option-name' }],
          },
        ],
      },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: null, homeDir: join(tmp, 'empty-home') })

    expect(resolutionErrors(report.summary.errors)).toEqual([])
    expect(report.summary.ok).toBe(true)
  })

  it('reports a malformed patch once without inventing a missing package', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writeFileSync(join(dir, 'cordis.patch.yml'), '- insert: [unterminated')

    const report = analyzeProfile(dir, { dshInstallDir: null, homeDir: join(tmp, 'empty-home') })

    expect(report.summary.errors).toEqual([
      'user-patch: patch file is not a valid entry list',
    ])
    expect(resolutionErrors(report.summary.errors)).toEqual([])
  })
})

describe('duplicate loader entry ids (#98 boot failure)', () => {
  it('detects an id inserted by both a bundle patch and the user cordis.patch.yml', () => {
    const dir = pdir()
    writeProfile(dir, {
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      dependencies: { '@deepseek-ai/dsh-base': '^4.0.1' },
    })
    writeBundle(dir, '@deepseek-ai/dsh-base', '4.0.1', [
      { insert: [{ id: 'shared-entry', name: 'from-bundle' }] },
    ])
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'shared-entry', name: 'from-user' }] },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: dir })
    const dup = report.duplicates.find(d => d.id === 'shared-entry')
    expect(dup).toBeDefined()
    expect(dup?.id).toBe('shared-entry')
    expect(dup?.count).toBe(2)
    expect(dup?.layers).toContain('@deepseek-ai/dsh-base')
    expect(dup?.layers).toContain('user-patch')
    expect(report.summary.errors.some(e => e.includes('duplicate'))).toBe(true)
    expect(report.summary.ok).toBe(false)
  })
})

describe('one loader id on two rows depends on the loader (#853)', () => {
  /** The reported shape: a bundle's own row plus the user's row on one id. */
  function twoRowsOnOneId(dir: string): void {
    writeProfile(dir, {
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      dependencies: { '@deepseek-ai/dsh-base': '^4.0.1' },
    })
    writeBundle(dir, '@deepseek-ai/dsh-base', '4.0.1', [
      { insert: [{ id: 'dsh-market', name: 'dshmarket' }] },
    ])
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'dsh-market', name: 'file:///profile/node_modules/dshmarket/lib/index.js' }] },
    ]))
  }

  /** A lockfile naming the loader, the way a real profile has one. */
  function lockWithLoader(dir: string, version: string): void {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      'packages:',
      `  '@deepseek-ai/cordis-plugin-loader@${version}':`,
      `    version: ${version}`,
      '',
    ].join('\n'))
  }

  it('is a warning on a loader that folds the id instead of refusing it', () => {
    // Measured against the published packages: 1.0.3 throws
    // `duplicate loader entry id`, 1.0.4 and 1.0.5 fold the array into a Map
    // and let the LATER row win. The reporter's profile already had this pair,
    // so treating it as fatal rolled back every update — of every plugin —
    // forever, over a boot that works.
    const dir = pdir()
    twoRowsOnOneId(dir)
    lockWithLoader(dir, '1.0.5')

    const report = analyzeProfile(dir, { dshInstallDir: dir })

    expect(report.summary.errors.some(e => e.includes('duplicate loader entry id'))).toBe(false)
    expect(report.summary.ok).toBe(true)
    // Still SAID: on this loader one of the two rows quietly loses.
    const warning = report.summary.warnings.find(w => w.includes('dsh-market'))
    expect(warning).toBeDefined()
    expect(String(warning)).toContain('"dsh-market"')
    expect(String(warning)).toMatch(/后一层覆盖前一层|LATER row wins/)
  })

  it('stays fatal on a loader that still refuses it — the version this rule was written for', () => {
    const dir = pdir()
    twoRowsOnOneId(dir)
    lockWithLoader(dir, '1.0.3')

    const report = analyzeProfile(dir, { dshInstallDir: dir })

    expect(report.summary.errors.some(e => e.includes('duplicate loader entry id'))).toBe(true)
    expect(report.summary.ok).toBe(false)
  })

  it('stays fatal when no version can be read, because the evidence to relax is missing', () => {
    const dir = pdir()
    twoRowsOnOneId(dir)

    const report = analyzeProfile(dir, { dshInstallDir: dir })

    expect(report.summary.errors.some(e => e.includes('duplicate loader entry id'))).toBe(true)
  })

  /** A host installation whose shared node_modules carries the loader. */
  function hostWithLoader(version: string): string {
    const host = mkdtempSync(join(tmpdir(), 'dshm-host-'))
    const packageDir = join(host, 'node_modules', '@deepseek-ai', 'cordis-plugin-loader')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis-plugin-loader', version }))
    return host
  }

  it('reads the loader from a host that PROVIDES it when the profile lockfile cannot (#943)', () => {
    // The official Desktop embeds the loader in app.asar and hands it to every
    // profile, so a profile lockfile can never name it. Reading that as an old
    // loader made this gate fatal for every update on 0.2.1-rc.2.
    const dir = pdir()
    twoRowsOnOneId(dir)

    const report = analyzeProfile(dir, { dshInstallDir: hostWithLoader('1.0.6') })

    expect(report.summary.errors.some(e => e.includes('duplicate loader entry id'))).toBe(false)
    expect(report.summary.warnings.some(w => w.includes('dsh-market'))).toBe(true)
  })

  it('still refuses when the host-provided loader is one that throws on the pair', () => {
    const dir = pdir()
    twoRowsOnOneId(dir)

    const report = analyzeProfile(dir, { dshInstallDir: hostWithLoader('1.0.3') })

    expect(report.summary.errors.some(e => e.includes('duplicate loader entry id'))).toBe(true)
  })

  it('the trial gate reads the same host-provided loader', () => {
    // trial.ts calls the same function on the candidate composition; without
    // the host fallback it kept rolling updates back after the check report
    // had already relaxed (#943: "update succeeds, then reverts").
    const dir = pdir()
    twoRowsOnOneId(dir)
    const result = trialValidate(dir, [], { dshInstallDir: hostWithLoader('1.0.6') })
    expect(result.ok).toBe(true)
  })
})

describe('duplicate loader entry names (#98 opt: runtime shadowing)', () => {
  it('reports two rows sharing one name across layers — informational, not a boot failure and not a summary warning', () => {
    const dir = pdir()
    writeProfile(dir, {
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      dependencies: { '@deepseek-ai/dsh-base': '^4.0.1' },
    })
    writeBundle(dir, '@deepseek-ai/dsh-base', '4.0.1', [
      { insert: [{ id: 'one', name: 'same-plugin' }] },
    ])
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'two', name: 'same-plugin' }] },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: dir })
    // The shadowing pair stays structurally visible with the SAME shape
    // ({name, layers, count}) for the diagnostics panel to render.
    const dup = report.duplicateNames.find(d => d.name === 'same-plugin')
    expect(dup).toBeDefined()
    expect(dup?.count).toBe(2)
    expect(dup?.layers).toContain('@deepseek-ai/dsh-base')
    expect(dup?.layers).toContain('user-patch')
    // Distinct ids, so NOT a boot failure (issue #109: only id collisions
    // fail the boot; name collisions are informational, never a summary
    // warning — a healthy profile must not be flagged).
    expect(report.summary.errors.some(e => e.includes('duplicate loader entry id'))).toBe(false)
    expect(report.summary.warnings.some(w => w.includes('duplicate loader entry name'))).toBe(false)
  })

  it('ignores same-name rows within ONE layer — the official multi-instance bundle pattern', () => {
    // dsh-base ships tool-subagent and tool-subagent-fork under the SAME name
    // (@deepseek-ai/dsh-tool-subagent, different provider/toolName configs).
    // Same-layer same-name rows are a routine multi-entry bundle, never a
    // conflict: the loader addresses them by id within one layer.
    const dir = pdir()
    writeProfile(dir, {
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      dependencies: { '@deepseek-ai/dsh-base': '^4.0.1' },
    })
    writeBundle(dir, '@deepseek-ai/dsh-base', '4.0.1', [
      {
        insert: [
          { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent' },
          { id: 'tool-subagent-fork', name: '@deepseek-ai/dsh-tool-subagent' },
        ],
      },
    ])

    const report = analyzeProfile(dir)
    expect(report.duplicateNames.find(d => d.name === '@deepseek-ai/dsh-tool-subagent')).toBeUndefined()
    expect(report.summary.warnings).toEqual([])
    expect(report.summary.ok).toBe(true)
  })

  it('fresh profile with only the official bundle warns about nothing out of the box', () => {
    // Maintainer-reported false positive (issue #109): an untouched profile
    // with zero community plugins must not be flagged. The official bundle
    // legitimately repeats a name for multi-instance rows, so the whole
    // duplicate-name machinery stays silent on a healthy profile.
    const dir = pdir()
    writeProfile(dir, {
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      dependencies: { '@deepseek-ai/dsh-base': '^4.0.1' },
    })
    writeBundle(dir, '@deepseek-ai/dsh-base', '4.0.1', [
      {
        insert: [
          { id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' },
          { id: 'llm', name: '@deepseek-ai/dsh-llm' },
          { id: 'session', name: '@deepseek-ai/dsh-session' },
          { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent' },
          { id: 'tool-subagent-fork', name: '@deepseek-ai/dsh-tool-subagent' },
          { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' },
        ],
      },
    ])

    const report = analyzeProfile(dir)
    expect(report.duplicateNames).toEqual([])
    expect(report.summary.warnings).toEqual([])
    expect(report.summary.errors).toEqual([])
    expect(report.summary.ok).toBe(true)
  })
})

describe('peer checks cover every plugin (#98 opt: plugin-to-plugin peers)', () => {
  it('flags a peer mismatch on a NON-core package', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writePackage(dir, 'plugin-a', {
      name: 'plugin-a',
      version: '1.0.0',
      peerDependencies: { 'community-lib': '^2.0.0' },
    })
    writePackage(dir, 'community-lib', { name: 'community-lib', version: '1.5.0' })

    const report = analyzeProfile(dir)
    const mismatch = report.peerMismatches.find(
      m => m.plugin === 'plugin-a' && m.name === 'community-lib',
    )
    expect(mismatch).toBeDefined()
    expect(mismatch?.satisfied).toBe(false)
    expect(report.summary.warnings.some(w => w.includes('community-lib'))).toBe(true)
  })

  it('reports a peer dependency that is not installed at all (info-level, no summary warning)', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writePackage(dir, 'plugin-b', {
      name: 'plugin-b',
      version: '1.0.0',
      peerDependencies: { 'missing-peer': '^1.0.0' },
    })

    const report = analyzeProfile(dir)
    const mismatch = report.peerMismatches.find(
      m => m.plugin === 'plugin-b' && m.name === 'missing-peer',
    )
    expect(mismatch).toBeDefined()
    expect(mismatch?.resolved).toBeNull()
    expect(mismatch?.satisfied).toBeNull()
    // Un-evaluable peers stay in the list but do not pollute the summary.
    expect(report.summary.warnings.some(w => w.includes('missing-peer'))).toBe(false)
  })
})

describe('suggestedOrder (#98 opt: LOOT-style auto-fix)', () => {
  it('suggests a compliant community order when rules are violated', () => {
    const dir = pdir()
    writeProfile(dir, {
      dsh: { profile: { bundles: ['a', 'b'] } },
      dependencies: {},
    })
    // b declares after a → current order [a, b] already satisfies it; force a
    // violation by having a declare after b with order [a, b].
    writeBundle(dir, 'a', '1.0.0', [{ insert: [{ id: 'a' }] }])
    writeBundle(dir, 'b', '1.0.0', [{ insert: [{ id: 'b' }] }])
    writeFileSync(join(dir, 'node_modules', 'a', 'package.json'), JSON.stringify({
      name: 'a',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml', order: { after: ['b'] } } },
    }))

    const report = analyzeProfile(dir)
    expect(report.suggestedOrder?.ok).toBe(true)
    if (report.suggestedOrder?.ok === true) {
      expect(report.suggestedOrder.order).toEqual(['b', 'a'])
    }
    // The violation itself surfaces as a warning + orderConflicts.
    expect(report.orderConflicts.some(c => c.name === 'a')).toBe(true)
  })

  it('no declared rules → no suggestion and no order warning (no false alert)', () => {
    // Two unconstrained community bundles in a hand-picked order [b, a]: with
    // no declared rules there is nothing to suggest, and a hand-picked order
    // that breaks no rule must never be flagged (issue #98 analysis: false
    // alerts; issue #125 review: no rules → no suggestion).
    const dir = pdir()
    writeProfile(dir, {
      name: 'web-profile',
      dsh: { profile: { bundles: ['b', 'a'] } }, // hand-picked order
      dependencies: {},
    })
    writeBundle(dir, 'a', '1.0.0', [{ insert: [{ id: 'a' }] }])
    writeBundle(dir, 'b', '1.0.0', [{ insert: [{ id: 'b' }] }])

    const report = analyzeProfile(dir)
    expect(report.suggestedOrder).toBeNull()
    expect(report.orderConflicts).toEqual([])
    expect(report.summary.warnings.some(w => w.includes('violates declared rules'))).toBe(false)
    expect(report.summary.ok).toBe(true)
  })

})

/** #369: when no CLI or Desktop installation anchor is visible, the in-box
 * bundles cannot be resolved. They are supplied by that installation by
 * definition, so this unknown state must not declare the profile unbootable.
 * `dsh --dump-config` on the same profile exited 0. */
describe('in-box bundles that cannot be located (#369)', () => {
  /** `tmp` is assigned per test, so this has to be read inside one. */
  const desktop = () => ({ dshInstallDir: null, homeDir: join(tmp, 'empty-home') })

  it('does not call an unlocatable in-box bundle a boot failure', () => {
    const dir = pdir()
    // The default profile template, and nothing in node_modules: the shape
    // of every Desktop profile.
    writeProfile(dir, {
      name: 'web-profile',
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    })

    const report = analyzeProfile(dir, desktop())

    for (const layer of report.bundles) {
      expect(layer.kind).toBe('official')
      expect(layer.error, `${layer.name} was called broken`).toBeNull()
      expect(layer.unresolvedInbox).toBe(true)
    }
    expect(report.summary.errors.join('\n')).not.toMatch(/is not installed/)
  })

  it('does not call an unlisted OFFICIAL bundle missing while the installation is out of sight (#676)', () => {
    // A desktop build ships more in-box bundles than INBOX_BUNDLES names —
    // this one reported "not installed — will fail to boot" while its three
    // entries were active in the running host. With the installation not
    // locatable, an `@deepseek-ai/` bundle is unknown, not missing.
    const dir = pdir()
    writeProfile(dir, {
      name: 'web-profile',
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-agent-team-profile'] } },
    })

    const report = analyzeProfile(dir, desktop())

    const team = report.bundles.find(layer => layer.name === '@deepseek-ai/dsh-experimental-agent-team-profile')
    expect(team?.error).toBeNull()
    expect(team?.unresolvedInbox).toBe(true)
    expect(report.summary.errors.join('\n')).not.toMatch(/is not installed/)
  })

  it('still calls a COMMUNITY bundle missing while the installation is out of sight', () => {
    // The relaxation is for what the installation may supply. A community
    // bundle only ever comes from the profile, so its absence is certain.
    const dir = pdir()
    writeProfile(dir, {
      name: 'web-profile',
      dependencies: {},
      dsh: { profile: { bundles: ['dsh-community-gone'] } },
    })

    const report = analyzeProfile(dir, desktop())

    expect(report.bundles[0]?.error).toMatch(/is not installed/)
  })

  it('still calls an official bundle missing when the installation IS located and lacks it', () => {
    const dir = pdir()
    const install = join(tmp, 'dsh-install')
    mkdirSync(install, { recursive: true })
    writeFileSync(join(install, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7' }))
    writeProfile(dir, {
      name: 'web-profile',
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-experimental-agent-team-profile'] } },
    })

    const report = analyzeProfile(dir, { dshInstallDir: install })

    expect(report.bundles[0]?.error).toMatch(/is not installed/)
  })

  it('does not inspect a stale profile copy when the in-box host is hidden', () => {
    const dir = pdir()
    writeProfile(dir, {
      name: 'web-profile',
      dependencies: { '@deepseek-ai/dsh-base': '^0.0.1' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    })
    const stale = writePackage(dir, '@deepseek-ai/dsh-base', {
      name: '@deepseek-ai/dsh-base',
      version: '0.0.1',
      dsh: {},
    })

    const report = analyzeProfile(dir, desktop())
    const official = report.bundles[0]

    expect(official).toMatchObject({
      directory: null,
      unresolvedInbox: true,
      error: null,
    })
    expect(official?.directory).not.toBe(stale)
    expect(report.summary.ok).toBe(true)
  })

  it('uses the healed parent fallback behind a stale direct in-box shadow', () => {
    const dir = pdir('profiles/web')
    writeProfile(dir, {
      name: 'web-profile',
      dependencies: { '@deepseek-ai/dsh-base': '^0.0.1' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    })
    writePackage(dir, '@deepseek-ai/dsh-base', {
      name: '@deepseek-ai/dsh-base',
      version: '0.0.1',
      dsh: {},
    })
    const fallback = writeBundle(
      join(tmp, 'profiles'),
      '@deepseek-ai/dsh-base',
      '4.0.1',
      [{ insert: [{ id: 'host-base' }] }],
    )

    const report = analyzeProfile(dir, desktop())
    const official = report.bundles[0]

    expect(official?.directory).toBe(fallback)
    expect(official?.unresolvedInbox).toBeUndefined()
    expect(official?.error).toBeNull()
    expect(official?.entries).toEqual(['host-base'])
    expect(report.rows.map(row => row.id)).toEqual(['host-base'])
    expect(report.summary.ok).toBe(true)
  })

  it('still calls a COMMUNITY bundle missing, which is a real defect', () => {
    const dir = pdir()
    writeProfile(dir, {
      name: 'web-profile',
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'some-community-bundle'] } },
    })

    const report = analyzeProfile(dir, desktop())

    const community = report.bundles.find(layer => layer.name === 'some-community-bundle')
    expect(community?.error).toMatch(/not installed/)
    expect(community?.unresolvedInbox).toBeUndefined()
  })
})

describe('host version for the exported log (REIN-280)', () => {
  it('reports the version and the directory it came from', () => {
    const cliInstall = writePackage(join(tmp, 'cli'), '@deepseek-ai/dsh', {
      name: '@deepseek-ai/dsh',
      version: '0.1.1-rc.2',
    })

    expect(dshHostInfo(join(cliInstall, 'bin', 'dsh.js')))
      .toEqual({ version: '0.1.1-rc.2', directory: cliInstall })
  })

  // Needs a *file* symlink, and a file link has no unprivileged fallback:
  // `junction` is directory-only. Without the privilege this asserted a link
  // that was never created, so it skips instead (tests/symlink-support.ts).
  it.skipIf(!canCreateSymlink('file'))('follows the bin symlink a global install actually puts on PATH', () => {
    // `npm i -g` and Homebrew both install the package under lib/ and link
    // it into bin/, so process.argv[1] is the LINK. Walking up from there
    // reaches / without ever passing the package, and every consumer of the
    // host version — the log line, Discover's requirement filter (#473),
    // the pre-update check (#404) — silently answered "unknown" on the most
    // ordinary install there is. Measured against a real Homebrew dsh:
    // null for the link, correct for its target.
    const cliInstall = writePackage(join(tmp, 'global-lib'), '@deepseek-ai/dsh', {
      name: '@deepseek-ai/dsh',
      version: '0.1.2-alpha.5',
    })
    mkdirSync(join(cliInstall, 'lib'), { recursive: true })
    writeFileSync(join(cliInstall, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
    const bin = join(tmp, 'global-bin')
    mkdirSync(bin, { recursive: true })
    const link = join(bin, 'dsh')
    symlinkSync(join(cliInstall, 'lib', 'bin.js'), link)

    // realpathSync on the expectation too: macOS's own /var -> /private/var
    // link means the resolved directory is not string-equal to the one the
    // fixture built, and the point here is the package that was found.
    expect(dshHostInfo(link)).toEqual({ version: '0.1.2-alpha.5', directory: realpathSync(cliInstall) })
  })

  it('reports a Desktop-bundled host by the resources path it was found at', () => {
    // The directory is half the answer: a path under Electron's resources is
    // how a bundled host — which #139 established can be older than anything
    // npm would report — identifies itself without asking the user.
    const resources = join(tmp, 'resources-desktop')
    const dshInstall = writePackage(join(resources, 'app.asar'), '@deepseek-ai/dsh', {
      name: '@deepseek-ai/dsh',
      version: '0.1.0-rc.8',
    })
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })

    expect(dshHostInfo(join(tmp, 'electron-entry', 'main.js')))
      .toEqual({ version: '0.1.0-rc.8', directory: dshInstall })
  })

  it('distinguishes "located but unversioned" from "no host found"', () => {
    // Two different facts. A host that is present and declares no version
    // still tells the reader where it is; null says the market could not
    // find one at all, which is a legitimate state for a global install.
    const unversioned = writePackage(join(tmp, 'noversion'), '@deepseek-ai/dsh', {
      name: '@deepseek-ai/dsh',
    })
    expect(dshHostInfo(join(unversioned, 'bin', 'dsh.js')))
      .toEqual({ version: 'unknown', directory: unversioned })

    delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    expect(dshHostInfo(join(tmp, 'nothing-here', 'main.js'))).toBeNull()
  })

  it('does not accept a package that merely sits at the right path', () => {
    const impostor = writePackage(join(tmp, 'impostor'), '@deepseek-ai/dsh', {
      name: 'something-else',
      version: '9.9.9',
    })
    delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    expect(dshHostInfo(join(impostor, 'bin', 'dsh.js'))).toBeNull()
  })
})

describe('Desktop host discovery (#405)', () => {
  it.each(['app.asar.unpacked', 'app.asar', 'app'])(
    'finds a validated host package in resources/%s',
    applicationRoot => {
      const resources = join(tmp, `resources-${applicationRoot}`)
      const dshInstall = writePackage(join(resources, applicationRoot), '@deepseek-ai/dsh', {
        name: '@deepseek-ai/dsh',
        version: '0.1.1-rc.2',
      })
      Object.defineProperty(process, 'resourcesPath', {
        value: resources,
        configurable: true,
      })

      expect(findDshInstallDir(join(tmp, 'electron-entry', 'main.js'))).toBe(dshInstall)
    },
  )

  describe('the runtime one `dsh/` level inside app.asar (#778)', () => {
    // 0.2.0-rc.2 embeds the whole runtime in a `dsh/` subdirectory INSIDE the
    // asar. The asar's own node_modules holds eight shared libraries and none
    // of the host, so probing the root alone found no host and every consumer
    // read "not locatable": hostVersion null, "update to a compatible version"
    // unable to pick anything, and the exported log's first line wrong.
    const desktop = (applicationRoot: string) => {
      const resources = join(tmp, `resources-nested-${applicationRoot}`)
      const host = writePackage(join(resources, applicationRoot, 'dsh'), '@deepseek-ai/dsh', {
        name: '@deepseek-ai/dsh',
        version: '0.2.0-rc.2',
      })
      Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
      return { resources, host }
    }

    it.each(['app.asar.unpacked', 'app.asar', 'app'])('finds the host under resources/%s/dsh', applicationRoot => {
      const { host } = desktop(applicationRoot)
      expect(dshHostInfo(join(tmp, 'electron-entry', 'main.js'))).toEqual({ version: '0.2.0-rc.2', directory: host })
      expect(findDshInstallDir(join(tmp, 'electron-entry', 'main.js'))).toBe(host)
    })

    it('still prefers the layout that already worked when both exist', () => {
      // The nested candidate FOLLOWS its root, so a build that carries a host at
      // the root keeps answering with it.
      const { resources } = desktop('app.asar')
      const flat = writePackage(join(resources, 'app.asar'), '@deepseek-ai/dsh', {
        name: '@deepseek-ai/dsh',
        version: '0.1.1-rc.2',
      })
      expect(dshHostInfo(join(tmp, 'electron-entry', 'main.js'))).toEqual({ version: '0.1.1-rc.2', directory: flat })
    })

    it('does not trust a nested directory just because it exists — identity still decides', () => {
      // The nested level adds a place to look, not a thing to believe.
      const resources = join(tmp, 'resources-nested-wrong')
      writePackage(join(resources, 'app.asar', 'dsh'), '@deepseek-ai/dsh', { name: 'not-the-dsh-host', version: '9.9.9' })
      Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
      expect(dshHostInfo(join(tmp, 'electron-entry', 'main.js'))).toBeNull()
    })
  })

  it('keeps CLI-entry discovery ahead of the Desktop fallback', () => {
    const cliInstall = pdir('cli-install')
    mkdirSync(join(cliInstall, 'bin'), { recursive: true })
    writeFileSync(join(cliInstall, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))

    const resources = pdir('desktop-resources')
    writePackage(join(resources, 'app.asar.unpacked'), '@deepseek-ai/dsh', {
      name: '@deepseek-ai/dsh',
    })
    Object.defineProperty(process, 'resourcesPath', {
      value: resources,
      configurable: true,
    })

    expect(findDshInstallDir(join(cliInstall, 'bin', 'dsh.js'))).toBe(cliInstall)
  })

  it('rejects a Desktop candidate with the wrong package identity', () => {
    const resources = pdir('wrong-package-resources')
    writePackage(join(resources, 'app.asar.unpacked'), '@deepseek-ai/dsh', {
      name: 'not-the-dsh-host',
    })
    Object.defineProperty(process, 'resourcesPath', {
      value: resources,
      configurable: true,
    })

    expect(findDshInstallDir(join(tmp, 'electron-entry', 'main.js'))).toBeNull()
  })

  it('loads hoisted in-box rows before composing community patches', () => {
    const resources = join(tmp, 'resources')
    const applicationRoot = join(resources, 'app.asar.unpacked')
    const dshInstall = writePackage(applicationRoot, '@deepseek-ai/dsh', {
      name: '@deepseek-ai/dsh',
      version: '0.1.1-rc.2',
    })
    const dshBase = writeBundle(applicationRoot, '@deepseek-ai/dsh-base', '0.1.1-rc.2', [
      { insert: [{ id: 'attachment-local', name: '@deepseek-ai/dsh-attachment-local' }] },
    ], { before: ['dsh-vision-router'] })

    const dir = pdir()
    writeProfile(dir, {
      name: 'web-profile',
      dependencies: { 'dsh-vision-router': '2.0.1' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-vision-router'] } },
    })
    writeBundle(dir, 'dsh-vision-router', '2.0.1', [
      { id: 'attachment-local', config: { local: true } },
    ])
    Object.defineProperty(process, 'resourcesPath', {
      value: resources,
      configurable: true,
    })

    expect(findDshInstallDir(join(tmp, 'electron-entry', 'main.js'))).toBe(dshInstall)
    const report = analyzeProfile(dir, { homeDir: join(tmp, 'empty-home') })

    const official = report.bundles.find(bundle => bundle.name === '@deepseek-ai/dsh-base')
    expect(official).toMatchObject({
      directory: dshBase,
      entries: ['attachment-local'],
    })
    expect(official?.unresolvedInbox).toBeUndefined()
    expect(report.orphans).toEqual([])
    expect(report.overrides).toEqual([{
      id: 'attachment-local',
      layer: 'dsh-vision-router',
      overriddenLayers: ['@deepseek-ai/dsh-base'],
    }])
    expect(readBundleRules(dir)).toContainEqual({
      name: '@deepseek-ai/dsh-base',
      before: ['dsh-vision-router'],
      after: [],
    })
    expect(report.summary.warnings).not.toContain(
      'dsh-vision-router: attachment-local — patch target not found',
    )
  })
})

/**
 * The Desktop shell applies its own `cordis.patch.yml` by hand, right behind
 * the `@deepseek-ai/dsh-web-app` layer — it is never in `dsh.profile.bundles`.
 * Composing without it reported the shell's own settings rows as orphan
 * patches, which is the one warning a user must NOT act on: deleting those rows
 * drops the window mode and every notification preference (#748).
 */
describe('the installation own overlay layer (#748)', () => {
  /** A packaged Desktop: the shell package root, its overlay, and the host package beside it. */
  function desktop(): string {
    const app = join(tmp, 'resources', 'app')
    writeProfile(app, {
      name: 'dsh-plugin-desktop',
      version: '2.0.15',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    writeFileSync(
      join(app, 'cordis.patch.yml'),
      dump([
        {
          insert: [
            { id: 'desktop-shell', name: 'dsh-plugin-desktop' },
            { id: 'desktop-notifications', name: 'dsh-plugin-desktop/notifications' },
          ],
        },
        { id: 'web-runtime', config: { openBrowser: false, printUrl: false } },
      ]),
    )
    // The host package findDshInstallDir() answers with: an ancestor of the
    // shell root, never the shell root itself.
    writePackage(app, '@deepseek-ai/dsh', { name: '@deepseek-ai/dsh', version: '0.1.7-rc.2' })
    writeBundle(app, '@deepseek-ai/dsh-web-app', '0.1.7-rc.2', [
      { insert: [{ id: 'web-runtime', name: '@deepseek-ai/dsh-web-app' }] },
    ])
    return app
  }

  it('offers the application root from the install package and from Electron resources', () => {
    const app = desktop()
    const install = join(app, 'node_modules', '@deepseek-ai', 'dsh')
    Object.defineProperty(process, 'resourcesPath', {
      value: join(tmp, 'resources'),
      configurable: true,
    })

    const fromInstall = desktopApplicationRoots(install)
    // The walk resolves the entry through symlinks (`entryDirectories`), and
    // on macOS `tmpdir()` is one: `/var/folders/…` is `/private/var/folders/…`.
    // Compare like for like, or this passes on Linux and fails on the
    // maintainer's machine (the `resourcesPath` branch below is not resolved,
    // which is why the last assertion compares the raw path).
    expect(fromInstall).toContain(realpathSync(install))
    expect(fromInstall).toContain(realpathSync(app))
    expect(desktopApplicationRoots(null)).toContain(app)
  })

  it('does not compose a project that merely declares a bundle patch (#749 review)', () => {
    // The ancestor walk exists because the shell's package root is an ancestor
    // of the `@deepseek-ai/dsh` package directory. But ANY project can declare
    // `dsh.bundle.patch` — this repository does — so a project root above the
    // install used to be composed as the installation's own overlay, inventing
    // rows and able to mask a real orphan warning.
    const project = join(tmp, 'project')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'cordis.patch.yml'), dump([
      { insert: [{ id: 'project-row', name: 'project-bundle' }] },
    ]))
    writeProfile(project, { name: 'some-project', dsh: { bundle: { patch: './cordis.patch.yml' } } })
    // The installation the lookup answered with: a package that declares none,
    // sitting inside that project's node_modules exactly as a linked install
    // would.
    const install = writePackage(project, '@deepseek-ai/dsh', { name: '@deepseek-ai/dsh', version: '0.1.7-rc.2' })

    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dsh: { profile: { bundles: [] } } })

    const report = analyzeProfile(dir, { dshInstallDir: install, homeDir: join(tmp, 'empty-home') })

    expect(report.rows.filter(row => row.id === 'project-row')).toEqual([])
    expect(report.rows.filter(row => row.layer === 'some-project')).toEqual([])
  })

  it('finds the shell overlay in the profile tree when no application root declares one (#807)', () => {
    // The layout the reporter measured: the whole runtime packed into one
    // app.asar, where the root is `@deepseek-ai/dsh-desktop` and the nested
    // `app.asar/dsh` is `@deepseek-ai/dsh-desktop-runtime` — neither declares
    // `dsh.bundle.patch` — while the file that actually supplies the shell rows
    // is `dsh-plugin-desktop`'s own patch, resolved from the profile's module
    // search. Without it, every user-patch row aimed at a shell row is reported
    // as an orphan, and deleting those rows drops the window material and the
    // notification preferences.
    const resources = join(tmp, 'resources-asar')
    writeProfile(join(resources, 'app.asar'), { name: '@deepseek-ai/dsh-desktop', version: '0.2.0-rc.2' })
    writeProfile(join(resources, 'app.asar', 'dsh'), { name: '@deepseek-ai/dsh-desktop-runtime', version: '0.2.0-rc.2' })
    const host = writePackage(join(resources, 'app.asar', 'dsh'), '@deepseek-ai/dsh', { name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' })
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })

    // The shell plugin sits in the shared root (<profiles>/node_modules), which
    // is where the reporter's own file lives.
    const shellRoot = join(tmp, 'profiles')
    const shell = writeBundle(shellRoot, 'dsh-plugin-desktop', '2.0.17', [
      { insert: [{ id: 'desktop-shell', name: 'dsh-plugin-desktop' }] },
      { insert: [{ id: 'desktop-notifications', name: 'dsh-plugin-desktop/notifications' }] },
    ])
    const dir = pdir('profiles/desktop')
    writeProfile(dir, { name: 'desktop-profile', dsh: { profile: { bundles: [] } } })
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      { id: 'desktop-shell', config: { mode: 'compatibility' } },
      { id: 'desktop-notifications', config: { enabled: true } },
    ]))

    const report = analyzeProfile(dir, { dshInstallDir: host, homeDir: join(tmp, 'empty-home') })

    expect(report.orphans).toEqual([])
    expect(report.summary.warnings.filter(line => line.includes('patch target not found'))).toEqual([])
    expect(report.rows.filter(row => row.id.startsWith('desktop-'))).toMatchObject([
      { id: 'desktop-shell', layer: 'dsh-plugin-desktop' },
      { id: 'desktop-notifications', layer: 'dsh-plugin-desktop' },
    ])
    expect(shell.endsWith(join('dsh-plugin-desktop'))).toBe(true)
  })

  it('does not accept a package that merely sits at that name (#807)', () => {
    // The bound is identity, not location — the same discipline the #749 review
    // settled for the application-root candidates: a directory that happens to
    // be called `dsh-plugin-desktop` but declares another package is not the
    // shell, and composing its patch would invent rows.
    const resources = join(tmp, 'resources-asar-impostor')
    writeProfile(join(resources, 'app.asar'), { name: '@deepseek-ai/dsh-desktop', version: '0.2.0-rc.2' })
    const host = writePackage(join(resources, 'app.asar'), '@deepseek-ai/dsh', { name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' })
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
    writeBundle(join(tmp, 'profiles'), 'dsh-plugin-desktop', '9.9.9', [
      { insert: [{ id: 'desktop-shell', name: 'not-the-shell' }] },
    ])
    // Rewrite the manifest so the DIRECTORY name and the package name disagree.
    writeFileSync(
      join(tmp, 'profiles', 'node_modules', 'dsh-plugin-desktop', 'package.json'),
      JSON.stringify({ name: 'not-the-shell', version: '9.9.9', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    )
    const dir = pdir('profiles/desktop-impostor')
    writeProfile(dir, { name: 'desktop-profile', dsh: { profile: { bundles: [] } } })

    const report = analyzeProfile(dir, { dshInstallDir: host, homeDir: join(tmp, 'empty-home') })

    expect(report.rows.filter(row => row.id === 'desktop-shell')).toEqual([])
  })

  it('does not compose that overlay twice when the profile already lists it as a bundle (#807)', () => {
    // In `dsh.profile.bundles` it is an ordinary bundle layer, which already
    // contributes its rows; adding the overlay as well would duplicate every
    // one of them — the failure mode the loader refuses to boot on.
    const resources = join(tmp, 'resources-asar-twice')
    writeProfile(join(resources, 'app.asar'), { name: '@deepseek-ai/dsh-desktop', version: '0.2.0-rc.2' })
    const host = writePackage(join(resources, 'app.asar'), '@deepseek-ai/dsh', { name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' })
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
    writeBundle(join(tmp, 'profiles'), 'dsh-plugin-desktop', '2.0.17', [
      { insert: [{ id: 'desktop-shell', name: 'dsh-plugin-desktop' }] },
    ])
    const dir = pdir('profiles/desktop-twice')
    writeProfile(dir, {
      name: 'desktop-profile',
      dsh: { profile: { bundles: ['dsh-plugin-desktop'] } },
      dependencies: { 'dsh-plugin-desktop': '^2.0.17' },
    })

    const report = analyzeProfile(dir, { dshInstallDir: host, homeDir: join(tmp, 'empty-home') })

    expect(report.duplicates).toEqual([])
    expect(report.rows.filter(row => row.id === 'desktop-shell')).toHaveLength(1)
  })

  it('composes that layer, so a user patch targeting the shell rows is not an orphan', () => {
    const app = desktop()
    const dir = pdir()
    writeProfile(dir, {
      name: 'desktop-profile',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } },
    })
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      { id: 'desktop-shell', config: { mode: 'extended' } },
      { id: 'desktop-notifications', config: { enabled: true } },
      { id: 'web-runtime', config: { printUrl: false } },
    ]))

    const report = analyzeProfile(dir, {
      dshInstallDir: join(app, 'node_modules', '@deepseek-ai', 'dsh'),
      homeDir: join(tmp, 'empty-home'),
    })

    expect(report.orphans).toEqual([])
    expect(report.rows.filter(row => row.id.startsWith('desktop-'))).toMatchObject([
      { id: 'desktop-shell', layer: 'dsh-plugin-desktop' },
      { id: 'desktop-notifications', layer: 'dsh-plugin-desktop' },
    ])
    // The two boundaries the launcher's splice position defines: after the web
    // carrier, before the user patch.
    expect(report.overrides).toContainEqual({
      id: 'web-runtime',
      layer: 'dsh-plugin-desktop',
      overriddenLayers: ['@deepseek-ai/dsh-web-app'],
    })
    expect(report.overrides).toContainEqual({
      id: 'desktop-shell',
      layer: 'user-patch',
      overriddenLayers: ['dsh-plugin-desktop'],
    })
    expect(report.summary.warnings).not.toContain(
      'user-patch: desktop-shell — patch target not found',
    )
  })

  it('invents no overlay for an installation that declares none', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dsh: { profile: { bundles: [] } } })
    writeFileSync(join(dir, 'cordis.patch.yml'), dump([
      { id: 'desktop-shell', config: { mode: 'extended' } },
    ]))
    const install = writePackage(pdir('cli-install'), '@deepseek-ai/dsh', {
      name: '@deepseek-ai/dsh',
      version: '0.1.7-rc.2',
    })

    const report = analyzeProfile(dir, { dshInstallDir: install, homeDir: join(tmp, 'empty-home') })

    // `desktop-shell` is still an orphan here — the honest answer for a profile
    // whose installation ships no overlay, and what keeps this lookup from
    // suppressing a real one.
    expect(report.orphans).toEqual([
      { id: 'desktop-shell', layer: 'user-patch', reason: 'patch target not found' },
    ])
    expect(report.rows.filter(row => row.layer === 'dsh-plugin-desktop')).toEqual([])
  })
})

describe('flat Desktop host discovery (#553)', () => {
  // Report-derived layout, not an extracted rc.12 installer. In particular,
  // app.asar below is an ordinary directory, NOT Electron's virtual fs.
  const packages = ['dsh-base', 'dsh-web-app', 'dsh-web', 'dsh-settings']
  const version = '0.1.0-rc.12'
  function desktop(applicationRoot = 'app'): string {
    const resources = join(tmp, 'flat-resources')
    const app = join(resources, applicationRoot)
    writeProfile(app, { name: '@deepseek-ai/dsh-desktop', version })
    for (const name of packages) {
      writePackage(app, `@deepseek-ai/${name}`, { name: `@deepseek-ai/${name}`, version })
    }
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
    return app
  }

  it('finds the flat dependency anchor from the process entry without resourcesPath', () => {
    const app = desktop()
    delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    expect(findDshInstallDir(join(app, 'lib', 'main.js'))).toBe(app)
    expect(dshHostInfo(join(app, 'lib', 'main.js'))).toEqual({ directory: app, version })
  })

  it.each(['app', 'app.asar', 'app.asar.unpacked'])(
    'falls back to resources/%s with an unhelpful entry (filesystem fixture)', root => {
      const app = desktop(root)
      expect(dshHostInfo(join(tmp, 'unrelated', 'main.js'))).toEqual({ directory: app, version })
    },
  )

  it('preserves legacy nested-host priority over a flat shell reached by argv', () => {
    const app = desktop()
    const cli = writePackage(app, '@deepseek-ai/dsh', { name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' })
    expect(dshHostInfo(join(app, 'lib', 'main.js'))).toEqual({ directory: cli, version: '0.1.1-rc.2' })
  })

  it.each([undefined, '', ' ', 'not-a-version', '0.1', 12, null, '9.9.9'])(
    'retains the dependency anchor but not an uncorroborated shell version %j', shellVersion => {
      const app = desktop()
      writeProfile(app, { name: '@deepseek-ai/dsh-desktop', version: shellVersion })
      expect(dshHostInfo(join(app, 'lib', 'main.js'))).toEqual({ directory: app, version: 'unknown' })
    },
  )

  it.each(packages)('does not choose a version when %s disagrees', name => {
    const app = desktop()
    writePackage(app, `@deepseek-ai/${name}`, { name: `@deepseek-ai/${name}`, version: '0.1.1-rc.2' })
    expect(dshHostInfo(join(app, 'lib', 'main.js'))).toEqual({ directory: app, version: 'unknown' })
  })

  it.each(['garbage', '01.2.3', '1.2.3-01', '1.2.3-rc..1'])(
    'does not report an invalid version even if every manifest agrees: %s', invalidVersion => {
      const app = desktop()
      writeProfile(app, { name: '@deepseek-ai/dsh-desktop', version: invalidVersion })
      for (const name of packages) {
        writePackage(app, `@deepseek-ai/${name}`, { name: `@deepseek-ai/${name}`, version: invalidVersion })
      }
      expect(dshHostInfo(join(app, 'lib', 'main.js'))).toEqual({ directory: app, version: 'unknown' })
    },
  )

  it.each([false, true])('accepts bundled package links but not profile links (external=%s)', external => {
    const app = desktop()
    const name = '@deepseek-ai/dsh-web'
    const target = writePackage(external ? pdir() : join(app, 'node_modules', '.pnpm', 'runtime'), name, { name, version })
    const link = join(app, 'node_modules', name)
    rmSync(link, { recursive: true })
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(dshHostInfo(join(app, 'lib', 'main.js'))).toEqual({ directory: app, version: external ? 'unknown' : version })
  })

  it('uses resources when argv has no entry', () => {
    const app = desktop()
    const argv = process.argv
    try {
      process.argv = [argv[0]!]
      expect(dshHostInfo()).toEqual({ directory: app, version })
    } finally {
      process.argv = argv
    }
  })

  it.each(['missing', 'unreadable', 'json', 'identity', 'version'])(
    'keeps a confirmed bundle anchor when another witness is %s', defect => {
      const app = desktop()
      const manifest = join(app, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json')
      if (defect === 'missing' || defect === 'unreadable') {
        rmSync(manifest)
        // A directory at the file path produces a read failure on both OSes.
        if (defect === 'unreadable') mkdirSync(manifest)
      } else {
        writeFileSync(manifest, defect === 'json' ? '{' : JSON.stringify(
          defect === 'identity' ? { name: 'impostor', version } : { name: '@deepseek-ai/dsh-web-app' },
        ))
      }
      expect(dshHostInfo(join(app, 'lib', 'main.js'))).toEqual({ directory: app, version: 'unknown' })
    },
  )

  it.each(['null', '{', '{"name":"other-desktop","version":"0.1.0-rc.12"}'])(
    'rejects a malformed or wrong shell manifest: %s', content => {
      const app = desktop()
      writeFileSync(join(app, 'package.json'), content)
      expect(dshHostInfo(join(app, 'lib', 'main.js'))).toBeNull()
    },
  )

  it('does not treat a shell-only directory or profile packages as a bundled runtime', () => {
    const app = desktop()
    rmSync(join(app, 'node_modules'), { recursive: true })
    for (const name of packages) {
      writePackage(pdir(), `@deepseek-ai/${name}`, { name: `@deepseek-ai/${name}`, version })
      // Node's ancestor search must not supply version evidence either.
      writePackage(tmp, `@deepseek-ai/${name}`, { name: `@deepseek-ai/${name}`, version })
    }
    expect(dshHostInfo(join(app, 'lib', 'main.js'))).toBeNull()
  })

  it('resolves built-in bundle composition, inventory, ordering and trial from the flat anchor', () => {
    const app = desktop()
    const base = writeBundle(app, '@deepseek-ai/dsh-base', version, [
      { insert: [{ id: 'attachment-local', name: '@deepseek-ai/dsh-attachment-local' }] },
    ], { before: ['community'] })
    const dir = pdir()
    writeProfile(dir, {
      dependencies: { community: '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'community'] } },
    })
    writeBundle(dir, 'community', '1.0.0', [{ id: 'attachment-local', config: { local: true } }])
    writeBundle(dir, '@deepseek-ai/dsh-base', '9.9.9', [])

    const report = analyzeProfile(dir, { homeDir: join(tmp, 'empty-home') })
    expect(report.bundles[0]).toMatchObject({ directory: base, entries: ['attachment-local'] })
    expect(report.orphans).toEqual([])
    expect(report.overrides).toContainEqual({
      id: 'attachment-local', layer: 'community', overriddenLayers: ['@deepseek-ai/dsh-base'],
    })
    expect(corePackageNames(findDshInstallDir())).toContain('@deepseek-ai/dsh-web')
    expect(readBundleRules(dir)).toContainEqual({ name: '@deepseek-ai/dsh-base', before: ['community'], after: [] })
    expect(trialValidate(dir, ['community'], { homeDir: join(tmp, 'empty-home') })).toMatchObject({ ok: true })
    expect(dshHostInfo()).toEqual({ directory: app, version })
  })
})

describe('peer range mismatch', () => {
  // ^0.1.0 := >=0.1.0 <0.2.0 (exclusive upper bound), so resolved 0.2.0
  // must be reported as unsatisfied.
  it('marks satisfied=false when resolved 0.2.0 is outside ^0.1.0', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writePackage(dir, 'plugin-x', {
      name: 'plugin-x',
      version: '1.0.0',
      peerDependencies: { '@deepseek-ai/dsh-llm': '^0.1.0' },
    })
    // Resolved core version hoisted at the profile root.
    writePackage(dir, '@deepseek-ai/dsh-llm', {
      name: '@deepseek-ai/dsh-llm',
      version: '0.2.0',
    })

    const report = analyzeProfile(dir)
    const mismatch = report.peerMismatches.find(
      m => m.plugin === 'plugin-x' && m.name === '@deepseek-ai/dsh-llm',
    )
    expect(mismatch).toBeDefined()
    expect(mismatch?.range).toBe('^0.1.0')
    expect(mismatch?.resolved).toBe('0.2.0')
    expect(mismatch?.satisfied).toBe(false)
    expect(report.summary.warnings.some(w => w.includes('does not match'))).toBe(true)
  })

  it('does not WARN about an optional peer that does not match (#275)', () => {
    // `peerDependenciesMeta.optional` is the plugin saying "I work without
    // this". classifyPeer already treats those as non-risk; the summary
    // disagreeing meant a scary warning line for a plugin that is fine —
    // including the market's own optional peer, on every profile that
    // installs it.
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writePackage(dir, 'plugin-opt', {
      name: 'plugin-opt',
      version: '1.0.0',
      peerDependencies: { '@deepseek-ai/dsh-llm': '^0.1.0' },
      peerDependenciesMeta: { '@deepseek-ai/dsh-llm': { optional: true } },
    })
    writePackage(dir, '@deepseek-ai/dsh-llm', { name: '@deepseek-ai/dsh-llm', version: '0.2.0' })

    const report = analyzeProfile(dir)
    const mismatch = report.peerMismatches.find(m => m.plugin === 'plugin-opt')
    // Still REPORTED — the diagnostics page shows it, and classifyPeer
    // decides what it means. Only the summary warning is suppressed.
    expect(mismatch?.satisfied).toBe(false)
    expect(mismatch?.optional).toBe(true)
    expect(report.summary.warnings.some(w => w.includes('plugin-opt'))).toBe(false)
  })

  it('accepts a rolling workspace peer resolved to its prerelease sibling (#317)', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writePackage(dir, 'workspace-plugin', {
      name: 'workspace-plugin',
      version: '0.1.1-rc.2',
      peerDependencies: { '@deepseek-ai/dsh-invariants': 'workspace:^' },
    })
    writePackage(dir, '@deepseek-ai/dsh-invariants', {
      name: '@deepseek-ai/dsh-invariants',
      version: '0.1.1-rc.2',
    })

    const report = analyzeProfile(dir)
    const peer = report.peerMismatches.find(
      mismatch => mismatch.plugin === 'workspace-plugin'
        && mismatch.name === '@deepseek-ai/dsh-invariants',
    )

    expect(peer).toMatchObject({
      range: 'workspace:^',
      resolved: '0.1.1-rc.2',
      satisfied: true,
    })
    expect(report.summary.warnings.some(w => w.includes('workspace-plugin'))).toBe(false)
  })
})

describe('pnpm-lock.yaml multi-version core packages', () => {
  it('reports both lockfile resolutions of @deepseek-ai/dsh-tools', () => {
    const dir = pdir()
    writeProfile(dir, { name: 'web-profile', dependencies: {} })
    writeFileSync(join(dir, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '  .:',
      '    dependencies:',
      "      '@deepseek-ai/dsh-tools':",
      '        specifier: ^0.0.1-rc.1',
      '        version: 0.0.1-rc.1',
      '',
      'packages:',
      "  '@deepseek-ai/dsh-tools@0.0.1-rc.1':",
      '    version: 0.0.1-rc.1',
      "  '@deepseek-ai/dsh-tools@0.1.0-rc.6':",
      '    version: 0.1.0-rc.6',
      '',
    ].join('\n'))

    const report = analyzeProfile(dir)
    const mv = report.multiVersion.find(m => m.name === '@deepseek-ai/dsh-tools')
    expect(mv).toBeDefined()
    expect(mv?.versions).toEqual(['0.0.1-rc.1', '0.1.0-rc.6'])
    expect(mv?.versions.length).toBe(2)
    expect(report.summary.errors.some(e => e.includes('multiple versions of core package'))).toBe(true)
    expect(report.summary.ok).toBe(false)
  })
})

describe('satisfiesRange', () => {

  it('zero-fills a partial version inside a comparator, as node-semver does', () => {
    // The connector-plugin family's peers are written this way —
    // `@deepseek-ai/dsh-llm: '>=0.1.5 <0.3'`, `'>=0.1.7-rc <2'`,
    // `'>=0.2.0-rc.0 <0.3'` — and every one of them used to parse as
    // UNKNOWN, which left the activation gate standing aside: measured
    // against the host's own evaluator over 699 live catalog manifests, the
    // market promised a restart would apply a plugin the host refuses.
    expect(satisfiesRange('0.1.2-alpha.2', '>=0.1.5 <0.3', { includePrerelease: true })).toBe(false)
    expect(satisfiesRange('0.1.2-alpha.2', '>=0.1.5-rc <2', { includePrerelease: true })).toBe(false)
    expect(satisfiesRange('0.1.7-rc.2', '>=0.2.0-rc.0 <0.3', { includePrerelease: true })).toBe(false)
    expect(satisfiesRange('0.2.9', '<0.3', { includePrerelease: true })).toBe(true)
    expect(satisfiesRange('2.1.0', '>=2', { includePrerelease: true })).toBe(true)
    expect(satisfiesRange('1.9.9', '>=2', { includePrerelease: true })).toBe(false)
  })

  it('keeps a BARE partial version unknown: `1.2` is an x-range, not `1.2.0`', () => {
    // node-semver reads `1.2` as `>=1.2.0 <1.3.0`. Treating it as the exact
    // version would be a different — and wrong — answer, so it stays unknown.
    expect(satisfiesRange('1.2.0', '1.2', { includePrerelease: true })).toBeNull()
    expect(satisfiesRange('1.2.0', '2', { includePrerelease: true })).toBeNull()
  })
  it('matches caret ranges', () => {
    expect(satisfiesRange('1.2.3', '^1.2.0')).toBe(true)
    expect(satisfiesRange('1.9.9', '^1.2.0')).toBe(true)
    expect(satisfiesRange('1.1.9', '^1.2.0')).toBe(false)
    expect(satisfiesRange('2.0.1', '^1.2.0')).toBe(false)
    // Regression: the npm upper bound is EXCLUSIVE — versions exactly at the
    // next breaking bump must not satisfy (previously wrongly accepted).
    expect(satisfiesRange('2.0.0', '^1.2.0')).toBe(false)
    expect(satisfiesRange('0.2.0', '^0.1.0')).toBe(false)
    expect(satisfiesRange('0.0.4', '^0.0.3')).toBe(false)
  })

  it('matches tilde ranges', () => {
    expect(satisfiesRange('1.2.0', '~1.2.0')).toBe(true)
    expect(satisfiesRange('1.2.9', '~1.2.0')).toBe(true)
    expect(satisfiesRange('1.1.9', '~1.2.0')).toBe(false)
    expect(satisfiesRange('1.3.1', '~1.2.0')).toBe(false)
    // Regression: same exclusive-upper-bound rule for ~ (next minor bump).
    expect(satisfiesRange('1.3.0', '~1.2.0')).toBe(false)
    expect(satisfiesRange('0.2.0', '~0.1.0')).toBe(false)
  })

  it('matches >= and exact ranges', () => {
    expect(satisfiesRange('1.2.0', '>=1.2.0')).toBe(true)
    expect(satisfiesRange('1.2.3', '>=1.2.0')).toBe(true)
    expect(satisfiesRange('1.1.9', '>=1.2.0')).toBe(false)
    expect(satisfiesRange('1.2.3', '1.2.3')).toBe(true)
    expect(satisfiesRange('1.2.4', '1.2.3')).toBe(false)
  })

  it('handles prerelease comparisons against caret ranges', () => {
    expect(satisfiesRange('0.1.0-rc.6', '^0.1.0-rc.6')).toBe(true)
    expect(satisfiesRange('0.1.0', '^0.1.0-rc.6')).toBe(true)
    expect(satisfiesRange('0.0.1-rc.1', '^0.1.0-rc.6')).toBe(false)
    expect(satisfiesRange('0.2.1', '^0.1.0-rc.6')).toBe(false)
  })

  it('applies the npm prerelease gate at the comparator-SET level (#98)', () => {
    // A prerelease version only satisfies a set when a comparator pins the
    // SAME [major, minor, patch] tuple WITH a prerelease of its own. This is
    // a set-level rule, not a per-comparator one.
    // 0.2.0-rc.1 is outside ^0.1.0's tuple → never admitted (and out of range).
    expect(satisfiesRange('0.2.0-rc.1', '^0.1.0')).toBe(false)
    // 0.1.0-rc.5 is INSIDE the numeric range of ^0.1.0 but the range declares
    // no prerelease → npm still refuses it.
    expect(satisfiesRange('0.1.0-rc.5', '^0.1.0')).toBe(false)
    expect(satisfiesRange('1.2.3-rc.1', '^1.2.3')).toBe(false)
    // A compound range with a same-tuple prerelease comparator admits it…
    expect(satisfiesRange('1.2.3-rc.2', '>=1.2.3-rc.1 <2.0.0')).toBe(true)
    // …even when the plain release form of the same bounds would not.
    expect(satisfiesRange('1.2.3-rc.1', '>=1.2.3 <1.2.4')).toBe(false)
    // Same-tuple prerelease ranges match normally.
    expect(satisfiesRange('0.1.0-rc.2', '^0.1.0-rc.1')).toBe(true)
    expect(satisfiesRange('2.0.0-rc.1', '^2.0.0-rc.1')).toBe(true)
    // || alternatives are independent sets: the second set's own prerelease
    // comparator admits the version.
    expect(satisfiesRange('2.0.0-rc.1', '^1.0.0 || ^2.0.0-rc.1')).toBe(true)
    expect(satisfiesRange('0.2.0-rc.1', '^0.1.0 || ^0.2.0-rc.1')).toBe(true)
  })

  it('can include prereleases across base tuples for the all-prerelease DSH release line', () => {
    expect(satisfiesRange('0.1.2-alpha.2', '^0.1.1-rc.2')).toBe(false)
    expect(satisfiesRange('0.1.2-alpha.2', '^0.1.1-rc.2', { includePrerelease: true })).toBe(true)
  })

  it('keeps the caret and tilde ceiling exclusive for prereleases of the ceiling itself', () => {
    // npm expands a caret/tilde ceiling with `-0`: `^0.1.1-rc.2` is
    // `>=0.1.1-rc.2 <0.2.0-0`, never `<0.2.0`. Comparing against the bare
    // release made `0.2.0 > 0.2.0-rc.2` true — the release outranks the
    // prerelease of its own base — so the 0.2 line slid under every `^0.1.x`
    // range, which is what the whole 0.1 release train declares.
    expect(satisfiesRange('0.2.0-rc.2', '^0.1.1-rc.2', { includePrerelease: true })).toBe(false)
    expect(satisfiesRange('0.2.0-rc.1', '^0.1.1-rc.2', { includePrerelease: true })).toBe(false)
    expect(satisfiesRange('0.2.0-0', '^0.1.1-rc.2', { includePrerelease: true })).toBe(false)
    expect(satisfiesRange('0.2.0-rc.2', '^0.1.0-rc.7', { includePrerelease: true })).toBe(false)
    expect(satisfiesRange('0.2.0-rc.2', '~0.1.7', { includePrerelease: true })).toBe(false)
    // 1.x caret was already exclusive and stays so, for prereleases too.
    expect(satisfiesRange('2.0.0-rc.1', '^1.2.0', { includePrerelease: true })).toBe(false)
    // The ceiling itself is still excluded as a release.
    expect(satisfiesRange('0.2.0', '^0.1.1-rc.2', { includePrerelease: true })).toBe(false)
    // …and the declared line is still admitted.
    expect(satisfiesRange('0.1.9', '^0.1.1-rc.2', { includePrerelease: true })).toBe(true)
    expect(satisfiesRange('0.1.1-rc.2', '^0.1.1-rc.2', { includePrerelease: true })).toBe(true)
  })

  it('agrees with node-semver on the prerelease ranges the host gate judges', () => {
    // The gate (@deepseek-ai/dsh-app-boot evaluatePluginCompatibility) is
    // node-semver. Values here were read from node-semver 7.8.5, the copy the
    // runtime ships, so this pins equivalence rather than intent — a
    // divergence is what produced "the market said compatible, the install
    // said rejected" for one release.
    const oracle: [string, string, boolean | null][] = [
      ['0.2.0-rc.2', '^0.1.1-rc.2', false],
      ['0.2.0-rc.2', '^0.1.0-rc.7', false],
      ['0.2.0-rc.2', '~0.1.7', false],
      ['0.2.0-rc.2', '^0.1.1-rc.2 || ^0.2.0-rc.1', true],
      ['0.1.2-alpha.2', '^0.1.1-rc.2', true],
      ['0.1.2-alpha.2', '^0.0.1', false],
      ['0.1.3', '~0.1.1', true],
      ['0.2.1', '^0.1.1-rc.2', false],
      ['0.2.0', '^0.1.1-rc.2', false],
    ]
    for (const [version, range, expected] of oracle) {
      expect(
        satisfiesRange(version, range, { includePrerelease: true }),
        `${version} in ${range}`,
      ).toBe(expected)
    }
  })

  it('matches wildcard, compound and || ranges; unknown ranges are null', () => {
    expect(satisfiesRange('1.2.3', '*')).toBe(true)
    expect(satisfiesRange('1.5.0', '>=1.2.0 <2.0.0')).toBe(true)
    expect(satisfiesRange('2.1.0', '>=1.2.0 <2.0.0')).toBe(false)
    expect(satisfiesRange('2.0.0', '^1.0.0 || ^2.0.0')).toBe(true)
    expect(satisfiesRange('0.5.0', '^1.0.0 || ^2.0.0')).toBe(false)
    expect(satisfiesRange('1.2.3', 'catalog:default')).toBeNull()
    expect(satisfiesRange('1.2.3-rc.1', 'catalog:default')).toBeNull()
    expect(satisfiesRange('1.2.3', 'catalog:default || ^3.0.0')).toBeNull()
    expect(satisfiesRange('3.1.0', 'catalog:default || ^3.0.0')).toBe(true)
  })

  it('materializes pnpm workspace protocol ranges against the resolved sibling (#317)', () => {
    expect(satisfiesRange('0.1.1-rc.2', 'workspace:')).toBe(true)
    expect(satisfiesRange('0.1.1-rc.2', 'workspace:*')).toBe(true)
    expect(satisfiesRange('0.1.1-rc.2', 'workspace:^')).toBe(true)
    expect(satisfiesRange('0.1.1-rc.2', 'workspace:~')).toBe(true)
    expect(satisfiesRange('0.1.1-rc.2', 'workspace:^0.1.1-rc.1')).toBe(true)
    expect(satisfiesRange('0.1.1-rc.2', 'workspace:^0.1.2-rc.1')).toBe(false)
    expect(satisfiesRange('4.5.6', 'workspace:>= || ^3.9.0')).toBe(true)
    expect(satisfiesRange('1.2.3', '^3.0.0 || workspace:>=')).toBe(true)
    expect(satisfiesRange('1.2.3', 'workspace:>')).toBe(false)
    expect(satisfiesRange('1.2.3', 'workspace:<')).toBe(false)
    expect(satisfiesRange('1.2.3', 'workspace:<=')).toBe(true)
    expect(satisfiesRange('1.2.3', 'workspace:1.2.x || ^3.0.0')).toBeNull()
    expect(satisfiesRange('0.1.1-rc.2', 'workspace:../sibling')).toBeNull()
  })
})

describe('compareSemver', () => {
  it('compares releases, prereleases and prerelease ordering', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
    expect(compareSemver('1.2.3', '1.2.4')).toBe(-1)
    expect(compareSemver('1.2.3', '1.2.2')).toBe(1)
    expect(compareSemver('1.0.0', '0.9.9')).toBe(1)
    // Prerelease of the same base sorts below the release.
    expect(compareSemver('0.1.0-rc.6', '0.1.0')).toBe(-1)
    expect(compareSemver('0.1.0', '0.1.0-rc.6')).toBe(1)
    expect(compareSemver('0.1.0-rc.6', '0.1.0-rc.6')).toBe(0)
    expect(compareSemver('0.1.0-rc.6', '0.1.0-rc.7')).toBe(-1)
    // Comparator contract is the SIGN (callers sort / test >=0): the raw
    // numeric difference (10-6=4) is not normalized to ±1 by check.ts.
    expect(compareSemver('0.1.0-rc.10', '0.1.0-rc.6')).toBeGreaterThan(0)
  })
})

describe('corePackageNames', () => {
  it('reads the host install inventory plus the curated seed', () => {
    const host = join(tmp, 'host-install')
    writePackage(host, '@deepseek-ai/dsh-tools', { name: '@deepseek-ai/dsh-tools', version: '0.1.0-rc.6' })
    writePackage(host, '@deepseek-ai/cordis-plugin-timer', { name: '@deepseek-ai/cordis-plugin-timer', version: '4.0.1' })
    writePackage(host, '@deepseek-ai/notcore', { name: '@deepseek-ai/notcore', version: '1.0.0' })
    mkdirSync(host, { recursive: true })
    writeFileSync(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))

    const core = corePackageNames(host)
    expect(core.has('@deepseek-ai/dsh-tools')).toBe(true) // install inventory (dsh*)
    expect(core.has('@deepseek-ai/cordis-plugin-timer')).toBe(true) // install inventory (cordis*)
    expect(core.has('@deepseek-ai/dsh')).toBe(true) // install manifest name
    expect(core.has('@deepseek-ai/notcore')).toBe(false) // scope names without dsh/cordis prefix
    expect(core.has('@deepseek-ai/dsh-llm')).toBe(true) // curated seed fallback
  })

  it('falls back to the curated seed when no install dir is readable', () => {
    const core = corePackageNames(null)
    expect(core.has('@deepseek-ai/dsh-tools')).toBe(true)
    expect(core.has('@deepseek-ai/dsh-llm')).toBe(true)
    expect(core.has('@deepseek-ai/dsh')).toBe(true)
  })

  it('reads the inventory when dshHostInfo answers the CLI PACKAGE directory (#676)', () => {
    // `findDshInstallDir()` hands corePackageNames whatever dshHostInfo()
    // found: for a CLI install that is the host PACKAGE directory
    // `<prefix>/node_modules/@deepseek-ai/dsh`, not `<prefix>`. Splicing
    // `node_modules/@deepseek-ai` onto it landed two levels too deep, the
    // readdir threw, and the curated seed silently replaced the real
    // inventory — every host-shipped name the seed lacked read as "not
    // installed — the profile will fail to boot". The only existing fixture
    // passed the deployment root, the one shape where the old splice
    // happened to work; this is the shape production actually passes.
    const prefix = join(tmp, 'cli-install')
    const hostPackage = writePackage(prefix, '@deepseek-ai/dsh', { name: '@deepseek-ai/dsh' })
    writePackage(prefix, '@deepseek-ai/dsh-agent-preset', { name: '@deepseek-ai/dsh-agent-preset', version: '0.1.7-alpha.1' })

    const core = corePackageNames(hostPackage)
    expect(core.has('@deepseek-ai/dsh-agent-preset')).toBe(true) // real inventory, not the seed
    expect(core.has('@deepseek-ai/dsh')).toBe(true) // package manifest name
    expect(core.has('@deepseek-ai/dsh-llm')).toBe(true) // curated seed still stands
  })
})
