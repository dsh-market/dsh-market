/**
 * Unit tests for the profile composition diagnostics (issue #98, phase 1) —
 * src/check.ts. Pure filesystem analysis, exercised against per-test tmpdir
 * fixtures (same pattern as tests/profile.spec.ts): the profile directory is
 * constructed manually under a mkdtemp tmpdir, and DSH_HOME is pointed there
 * so the home-level cordis.patch.yml layer can never leak into a test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { readBundleRules } from '../src/order.ts'

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
})
