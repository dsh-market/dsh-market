/**
 * Install orchestration with a recording fake runner over real profile
 * fixtures: collection retargeting, the fake-success guard, and update
 * staleness detection (#22's silent no-op).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { InstallResult } from '../src/dsh-cli.ts'
import {
  diagnosticsTail, failureDetail, FETCH_TIMEOUT_OVERRIDE, groupConflictsByOwner, hostNodeModulesRoot, installApplied,
  isHostPortCollision, isStaleUpdate, normalizedLinkTarget, parseIgnoredBuildEntries, parseIgnoredBuilds,
  parsePrepareNotAllowed, pnpmNeverStarted, pnpmRefusedYoungRelease, refusedReleaseAgePackage, removeDanglingHostBridge,
  retargetCollections, RELEASE_AGE_OVERRIDE, updateApplied, validateAddedPlugins, withHoistRecovery,
} from '../src/install.ts'
import { dropUnparseableBuildKeys, profileDir } from '../src/profile.ts'
import * as profileHelpers from '../src/profile.ts'
import { canCreateSymlink } from './symlink-support.ts'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshm-home-'))
  process.env.DSH_HOME = home
})
afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

const ok: InstallResult = { exitCode: 0, timedOut: false, stdout: '', stderr: '', cancelled: false }
const SHA = 'b0e6c57ebeeb4796017864f5cd5c66e6ba0899ec'

const FETCH_TIMEOUT_STDERR = '[23] The operation was aborted due to timeout\n\nTimeoutError: The operation was aborted due to timeout'

function recordingRunner(): { calls: string[][]; run: (profile: string, args: string[]) => Promise<InstallResult> } {
  const calls: string[][] = []
  return {
    calls,
    run: (_profile, args) => {
      calls.push(args)
      return Promise.resolve(ok)
    },
  }
}

function writeProfile(dependencies: Record<string, string>): string {
  const dir = profileDir('web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies }))
  return dir
}

function writePkg(dir: string, name: string, manifest: unknown, artifacts: string[] = []): void {
  const root = join(dir, 'node_modules', name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
  for (const rel of artifacts) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), '')
  }
}

describe('retargetCollections (#18)', () => {
  it('re-adds each contained plugin via #path:, leaving npm installs and pre-existing packages alone', async () => {
    const dir = writeProfile({ collection: 'github:o/r', existing: 'github:o/old', 'dsh-loop': '^1.0.0' })
    // Root manifest without a dsh surface = collection; two real plugins inside.
    writePkg(dir, 'collection', { name: 'collection', private: true })
    mkdirSync(join(dir, 'node_modules', 'collection', 'theme-a'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'collection', 'theme-a', 'package.json'), '{"dsh":{}}')
    mkdirSync(join(dir, 'node_modules', 'collection', 'packages', 'theme-b'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'collection', 'packages', 'theme-b', 'package.json'), '{"dsh":{}}')
    // 'existing' looks like junk too, but predates this install.
    writePkg(dir, 'existing', { name: 'existing', private: true })

    // npm target → no collection handling at all.
    const npm = recordingRunner()
    expect(await retargetCollections(npm.run, 'web', new Set(), 'dsh-loop')).toBe(true)
    expect(npm.calls).toEqual([])

    const { calls, run } = recordingRunner()
    expect(await retargetCollections(run, 'web', new Set(['existing', 'dsh-loop']), 'github:o/r')).toBe(true)
    expect(calls[0]).toEqual(['remove', 'collection'])
    expect(calls.slice(1).map(c => c[1]).sort()).toEqual([
      'github:o/r#path:/packages/theme-b',
      'github:o/r#path:/theme-a',
    ])

    // China-region installs now carry the commit resolved through the mirror.
    // The subpath is a second selector in that same fragment; a second `#`
    // would silently hand pnpm an invalid target (#385).
    const pinned = recordingRunner()
    expect(await retargetCollections(pinned.run, 'web', new Set(['existing', 'dsh-loop']), `github:o/r#${SHA}`)).toBe(true)
    expect(pinned.calls.slice(1).map(c => c[1]).sort()).toEqual([
      `github:o/r#${SHA}&path:/packages/theme-b`,
      `github:o/r#${SHA}&path:/theme-a`,
    ])
  })

  it('fails when a collection contains no plugins at all', async () => {
    const dir = writeProfile({ junk: 'github:o/r' })
    writePkg(dir, 'junk', { name: 'junk', private: true })
    expect(await retargetCollections(recordingRunner().run, 'web', new Set(), 'github:o/r')).toBe(false)
  })
})

describe('validateAddedPlugins (#18 / #21)', () => {
  it('keeps valid plugins, removes source-only and no-dsh-surface pieces on the spot', async () => {
    const dir = writeProfile({ good: '^1.0.0', broken: 'github:o/broken', dshmarket: '^0.0.1' })
    writePkg(dir, 'good', { dsh: {}, main: 'lib/index.js' }, ['lib/index.js'])
    // Source-only checkout: dsh manifest present but the built artifact is not.
    writePkg(dir, 'broken', { dsh: {}, main: 'lib/index.js' })
    // The #21 placeholder: artifact present but no dsh surface at all.
    writePkg(dir, 'dshmarket', { name: 'dshmarket', version: '0.0.1', main: 'index.js' }, ['index.js'])
    const { calls, run } = recordingRunner()
    const { keep, removedBroken } = await validateAddedPlugins(run, 'web', new Set())
    expect(keep).toEqual(['good'])
    expect(removedBroken.sort()).toEqual(['broken', 'dshmarket'])
    expect(calls.map(c => c.join(' ')).sort()).toEqual(['remove broken', 'remove dshmarket'])
  })

  it('removes a package whose loader entry ids clash with an installed bundle (#122)', async () => {
    // The real report: a TUI bundle installed into a web profile. Both
    // declare `id: storage`, cordis refuses the whole tree, and DSH will not
    // START — an error naming neither plugin, from a page you cannot reach.
    const dir = writeProfile({ '@deepseek-ai/dsh-web-app': '^1.0.0', '@scope/dsh-tui': 'github:o/dsh-tui' })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { '@deepseek-ai/dsh-web-app': '^1.0.0', '@scope/dsh-tui': 'github:o/dsh-tui' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', '@scope/dsh-tui'] } },
    }))
    const patch = (id: string, name: string) => `- insert:\n    - id: ${id}\n      name: '${name}'\n`
    writePkg(dir, '@deepseek-ai/dsh-web-app', { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'i.js' }, ['i.js'])
    writeFileSync(join(dir, 'node_modules', '@deepseek-ai/dsh-web-app', 'cordis.patch.yml'), patch('storage', '@deepseek-ai/dsh-storage'))
    writePkg(dir, '@scope/dsh-tui', { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'i.js' }, ['i.js'])
    writeFileSync(join(dir, 'node_modules', '@scope/dsh-tui', 'cordis.patch.yml'), patch('storage', '@deepseek-ai/dsh-storage'))

    const { calls, run } = recordingRunner()
    // web-app predates this install; the tui bundle is what just landed.
    const { keep, removedBroken, conflicts } = await validateAddedPlugins(run, 'web', new Set(['@deepseek-ai/dsh-web-app']))
    expect(keep).toEqual([])
    expect(removedBroken).toEqual(['@scope/dsh-tui'])
    expect(conflicts).toEqual([{ name: '@scope/dsh-tui', id: 'storage', owner: '@deepseek-ai/dsh-web-app' }])
    expect(calls).toEqual([['remove', '@scope/dsh-tui']])
  })

  it('does not flag distinct ids, nor a package against itself (#122)', async () => {
    const dir = writeProfile({ 'plug-a': '^1.0.0', 'plug-b': '^1.0.0' })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'plug-a': '^1.0.0', 'plug-b': '^1.0.0' },
      dsh: { profile: { bundles: ['plug-a', 'plug-b'] } },
    }))
    const patch = (id: string) => `- insert:\n    - id: ${id}\n      name: 'x'\n`
    writePkg(dir, 'plug-a', { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'i.js' }, ['i.js'])
    writeFileSync(join(dir, 'node_modules', 'plug-a', 'cordis.patch.yml'), patch('alpha'))
    writePkg(dir, 'plug-b', { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'i.js' }, ['i.js'])
    writeFileSync(join(dir, 'node_modules', 'plug-b', 'cordis.patch.yml'), patch('beta'))
    const { keep, conflicts } = await validateAddedPlugins(recordingRunner().run, 'web', new Set(['plug-a']))
    expect(keep).toEqual(['plug-b'])
    expect(conflicts).toEqual([])
  })

  it('drops the bundle row a failed remove already took off disk (#122)', async () => {
    // pnpm's #65 write-order failure, on the remove side: every persistent
    // step completes — node_modules unlinked, dependency saved — and the
    // command still exits 1 (a hoisted-linker file lock aborts the tail).
    // The plugin command reconciles dsh.profile.bundles only on exit 0, so
    // the row it leaves behind names a package the next boot cannot
    // resolve: the whole profile, not just this plugin, refuses to start.
    const dir = writeProfile({ '@deepseek-ai/dsh-web-app': '^1.0.0', '@scope/dsh-tui': 'github:o/dsh-tui' })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { '@deepseek-ai/dsh-web-app': '^1.0.0', '@scope/dsh-tui': 'github:o/dsh-tui' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', '@scope/dsh-tui'] } },
    }))
    const patch = (id: string, name: string) => `- insert:\n    - id: ${id}\n      name: '${name}'\n`
    writePkg(dir, '@deepseek-ai/dsh-web-app', { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'i.js' }, ['i.js'])
    writeFileSync(join(dir, 'node_modules', '@deepseek-ai/dsh-web-app', 'cordis.patch.yml'), patch('storage', '@deepseek-ai/dsh-storage'))
    writePkg(dir, '@scope/dsh-tui', { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'i.js' }, ['i.js'])
    writeFileSync(join(dir, 'node_modules', '@scope/dsh-tui', 'cordis.patch.yml'), patch('storage', '@deepseek-ai/dsh-storage'))

    const calls: string[][] = []
    const run = (profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      if (args[0] === 'remove') {
        const manifestFile = join(dir, 'package.json')
        const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
          dependencies: Record<string, string>
          dsh?: { profile?: { bundles?: string[] } }
        }
        delete manifest.dependencies[args[1]!]
        writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
        rmSync(join(dir, 'node_modules', args[1]!), { recursive: true, force: true })
        return Promise.resolve({ ...ok, exitCode: 1 })
      }
      return Promise.resolve(ok)
    }

    const { removedBroken } = await validateAddedPlugins(run, 'web', new Set(['@deepseek-ai/dsh-web-app']))
    expect(removedBroken).toEqual(['@scope/dsh-tui'])
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(Object.keys(manifest.dependencies)).toEqual(['@deepseek-ai/dsh-web-app'])
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-web-app'])
  })

  it('drops the bundle row when a clean-exit remove skipped the manifest reconcile', async () => {
    // A remove that bypasses the plugin command (raw pnpm in the profile
    // directory, a drift-recovery install re-run) cleans pnpm's own state
    // and exits 0, but nothing reconciles dsh.profile.bundles. Disk truth
    // is the same as the failing case and must land the same way.
    const dir = writeProfile({ '@deepseek-ai/dsh-web-app': '^1.0.0', '@scope/dsh-tui': 'github:o/dsh-tui' })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { '@deepseek-ai/dsh-web-app': '^1.0.0', '@scope/dsh-tui': 'github:o/dsh-tui' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', '@scope/dsh-tui'] } },
    }))
    const patch = (id: string, name: string) => `- insert:\n    - id: ${id}\n      name: '${name}'\n`
    writePkg(dir, '@deepseek-ai/dsh-web-app', { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'i.js' }, ['i.js'])
    writeFileSync(join(dir, 'node_modules', '@deepseek-ai/dsh-web-app', 'cordis.patch.yml'), patch('storage', '@deepseek-ai/dsh-storage'))
    writePkg(dir, '@scope/dsh-tui', { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'i.js' }, ['i.js'])
    writeFileSync(join(dir, 'node_modules', '@scope/dsh-tui', 'cordis.patch.yml'), patch('storage', '@deepseek-ai/dsh-storage'))

    const run = (profile: string, args: string[]): Promise<InstallResult> => {
      if (args[0] !== 'remove') return Promise.resolve(ok)
      const manifestFile = join(dir, 'package.json')
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
        dependencies: Record<string, string>
      }
      delete manifest.dependencies[args[1]!]
      writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
      rmSync(join(dir, 'node_modules', args[1]!), { recursive: true, force: true })
      return Promise.resolve(ok)
    }

    await validateAddedPlugins(run, 'web', new Set(['@deepseek-ai/dsh-web-app']))
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-web-app'])
  })

  it('keeps the manifest rows of a failed remove whose package is still on disk', async () => {
    // The other half of disk truth: a remove that failed BEFORE deleting
    // anything leaves an intact installation. Dropping the rows here would
    // orphan a dependency the profile can still load; a retry needs them.
    const dir = writeProfile({ '@deepseek-ai/dsh-web-app': '^1.0.0', '@scope/dsh-tui': 'github:o/dsh-tui' })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { '@deepseek-ai/dsh-web-app': '^1.0.0', '@scope/dsh-tui': 'github:o/dsh-tui' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', '@scope/dsh-tui'] } },
    }))
    const patch = (id: string, name: string) => `- insert:\n    - id: ${id}\n      name: '${name}'\n`
    writePkg(dir, '@deepseek-ai/dsh-web-app', { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'i.js' }, ['i.js'])
    writeFileSync(join(dir, 'node_modules', '@deepseek-ai/dsh-web-app', 'cordis.patch.yml'), patch('storage', '@deepseek-ai/dsh-storage'))
    writePkg(dir, '@scope/dsh-tui', { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'i.js' }, ['i.js'])
    writeFileSync(join(dir, 'node_modules', '@scope/dsh-tui', 'cordis.patch.yml'), patch('storage', '@deepseek-ai/dsh-storage'))

    const run = (_profile: string, args: string[]): Promise<InstallResult> =>
      Promise.resolve(args[0] === 'remove' ? { ...ok, exitCode: 1 } : ok)

    await validateAddedPlugins(run, 'web', new Set(['@deepseek-ai/dsh-web-app']))
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dependencies['@scope/dsh-tui']).toBe('github:o/dsh-tui')
    expect(manifest.dsh.profile.bundles).toContain('@scope/dsh-tui')
  })

  it('groups clash hits by the installed plugin that owns them', () => {
    // The market asks the user to uninstall PLUGINS, so the owner is the unit
    // it renders and acts on; a candidate hitting several owners at once has
    // to keep each id with the one that declares it.
    expect(groupConflictsByOwner([
      { id: 'storage', owner: 'dsh-tui-core' },
      { id: 'panel', owner: 'dsh-panel-kit' },
      { id: 'terminal', owner: 'dsh-tui-core' },
    ])).toEqual([
      { owner: 'dsh-tui-core', ids: ['storage', 'terminal'] },
      { owner: 'dsh-panel-kit', ids: ['panel'] },
    ])
  })

  it('groups a clean single clash into one row, and nothing into nothing', () => {
    expect(groupConflictsByOwner([{ id: 'storage', owner: 'plug-a' }]))
      .toEqual([{ owner: 'plug-a', ids: ['storage'] }])
    expect(groupConflictsByOwner([])).toEqual([])
  })

  it('keeps a carrier bundle that mounts other installed packages (#103)', async () => {
    // @linxin666/dsh-skins ships skin assets + a patch mounting the skin
    // center, with no entry of its own — the guard used to uninstall it right
    // after installing ("nothing installable survived validation").
    const dir = writeProfile({ '@linxin666/dsh-skins': '^0.1.17', '@linxin666/dsh-client-ui-skin-center': '^0.1.0' })
    writePkg(dir, '@linxin666/dsh-skins', { dsh: { bundle: { patch: './cordis.patch.yml' } } })
    writeFileSync(
      join(dir, 'node_modules', '@linxin666/dsh-skins', 'cordis.patch.yml'),
      "- insert:\n    - id: ui-skin-center\n      name: '@linxin666/dsh-client-ui-skin-center'\n",
    )
    writePkg(dir, '@linxin666/dsh-client-ui-skin-center', { dsh: {}, main: 'lib/index.js' }, ['lib/index.js'])
    const { calls, run } = recordingRunner()
    const { keep, removedBroken } = await validateAddedPlugins(run, 'web', new Set())
    expect(keep.sort()).toEqual(['@linxin666/dsh-client-ui-skin-center', '@linxin666/dsh-skins'])
    expect(removedBroken).toEqual([])
    expect(calls).toEqual([])
  })
})

describe('surfacing the dsh CLI diagnostics file (#672)', () => {
  // The CLI's literal line, from @deepseek-ai/dsh's plugin-CnNK4cws.js:
  //   process.stderr.write(`dsh: pnpm failed; diagnostics: ${result.logPath}\n`)
  const line = (path: string): string => `dsh: pnpm failed; diagnostics: ${path}\n`

  it('shows the tail of the file the CLI pointed at', async () => {
    const dir = writeProfile({})
    const log = join(dir, 'run.log')
    writeFileSync(log, 'Progress: resolved 12\nERR_PNPM_FETCH_404  @scope/thing is not in the registry\n')
    const run = (): Promise<InstallResult> => Promise.resolve({ ...ok, exitCode: 1, stderr: line(log) })
    const result = await withHoistRecovery(run, 'web', ['add', 'thing'])
    expect(result.stderr).toContain('ERR_PNPM_FETCH_404')
    expect(result.stderr).toContain(log)
  })

  it('keeps only the END of a large file', async () => {
    const dir = writeProfile({})
    const log = join(dir, 'big.log')
    writeFileSync(log, `${'x'.repeat(40_000)}\nTHE ACTUAL CAUSE\n`)
    const run = (): Promise<InstallResult> => Promise.resolve({ ...ok, exitCode: 1, stderr: line(log) })
    const result = await withHoistRecovery(run, 'web', ['add', 'thing'])
    expect(result.stderr).toContain('THE ACTUAL CAUSE')
    expect(result.stderr.length).toBeLessThan(20_000)
  })

  it('leaves the output alone when the path is unusable', async () => {
    // A directory, and a path that does not exist: the market only ever
    // wants the end of a log file, so anything else is ignored.
    const dir = writeProfile({})
    for (const bad of [dir, join(dir, 'missing.log')]) {
      const stderr = line(bad)
      const run = (): Promise<InstallResult> => Promise.resolve({ ...ok, exitCode: 1, stderr })
      const result = await withHoistRecovery(run, 'web', ['add', 'thing'])
      expect(result.stderr, bad).not.toContain('--- dsh diagnostics')
    }
  })

  it('refuses a RELATIVE path even when such a file exists', () => {
    // The child's stderr names a path in whatever cwd the child had, which is
    // not necessarily this process's — so a relative path has no reliable
    // meaning here. Asserted against a file that really does exist, or the
    // refusal would be indistinguishable from a failed read.
    const probe = 'dshm-diagnostics-probe.log'
    writeFileSync(probe, 'should not be read by this market')
    try {
      expect(diagnosticsTail({ stdout: '', stderr: line(probe) })).toBeNull()
    } finally {
      rmSync(probe, { force: true })
    }
  })

  it('puts pnpm\'s own error before a diagnostics file that holds only execa\'s summary (#808)', async () => {
    // The reporter's screen: the file the CLI pointed at (`.plugin-manager/
    // logs/operation-*/pnpm.log`) now holds one line from execa, because dsh
    // pipes pnpm's output to the market instead of into the file. Shown
    // instead of pnpm's error, that line was all the user got, and the real
    // cause — pnpm's ndjson error record — never appeared.
    const dir = writeProfile({})
    const log = join(dir, 'pnpm.log')
    writeFileSync(log, "Command failed with exit code 1: pnpm add -w --force 'dshmarket@1.66.8' '--reporter=ndjson'\n")
    const run = (): Promise<InstallResult> => Promise.resolve({
      ...ok,
      exitCode: 1,
      stderr: line(log),
      pnpmError: 'Something no rule here recognises',
      pnpmErrorCode: 'ERR_PNPM_BRAND_NEW',
    })
    const result = await withHoistRecovery(run, 'web', ['add', 'thing'])

    const cause = result.stderr.indexOf('ERR_PNPM_BRAND_NEW: Something no rule here recognises')
    const summary = result.stderr.indexOf('Command failed with exit code 1')
    expect(cause).toBeGreaterThanOrEqual(0)
    // The path still travels with the report, after the cause.
    expect(summary).toBeGreaterThan(cause)
    expect(result.stderr).toContain(log)
  })

  it('says nothing when the CLI named no diagnostics file', async () => {
    writeProfile({})
    const run = (): Promise<InstallResult> => Promise.resolve({ ...ok, exitCode: 1, stderr: 'dsh: pnpm failed in profile directory x\n' })
    const result = await withHoistRecovery(run, 'web', ['add', 'thing'])
    expect(result.stderr).not.toContain('--- dsh diagnostics')
  })
})

describe('allowBuilds keys a pnpm cannot parse (#698)', () => {
  // pnpm 10.26 → 10.29 and 11.0 → 11.5 read an allowBuilds key as
  // `name@<version union>`: a git or archive source there fails the WHOLE
  // workspace file, so every later pnpm command in the profile fails — the
  // exact text below is pnpm 10.29.3's, measured on a profile holding the
  // key the market writes for a git source.
  const INVALID = ' ERR_PNPM_INVALID_VERSION_UNION  Invalid versions union. Found: "some-plugin@git+https://github.com/o/r.git". Use exact versions only.'

  function writeWorkspace(allowBuilds: string): string {
    const dir = writeProfile({})
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), `packages:\n  - .\n\nallowBuilds:\n${allowBuilds}`)
    return dir
  }

  it('drops only the source-form keys, keeping bare names and the rest of the file', () => {
    const dir = writeWorkspace(
      '  some-plugin: true\n'
      + '  "some-plugin@git+https://github.com/o/r.git": true\n'
      + `  "some-plugin@https://codeload.github.com/o/r/tar.gz/${SHA}": true\n`
      + "  '@scope/pkg': true\n"
      + '  esbuild: false\n',
    )
    expect(dropUnparseableBuildKeys('web').sort()).toEqual([
      'some-plugin@git+https://github.com/o/r.git',
      `some-plugin@https://codeload.github.com/o/r/tar.gz/${SHA}`,
    ].sort())
    const yaml = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    expect(yaml).toContain('packages:\n  - .')
    expect(yaml).toContain('some-plugin: true')
    expect(yaml).toContain("'@scope/pkg': true")
    // A user's explicit `false` is a decision, not a key form; it stays.
    expect(yaml).toContain('esbuild: false')
    expect(yaml).not.toContain('git+https')
    expect(yaml).not.toContain('codeload')
  })

  it('leaves the file untouched when nothing matches', () => {
    const dir = writeWorkspace('  some-plugin: true\n')
    const before = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    expect(dropUnparseableBuildKeys('web')).toEqual([])
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(before)
  })

  it('repairs the profile and retries once when pnpm names such a key', async () => {
    writeWorkspace('  some-plugin: true\n  "some-plugin@git+https://github.com/o/r.git": true\n')
    const calls: string[][] = []
    const run = (_profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      return Promise.resolve(calls.length === 1 ? { ...ok, exitCode: 1, stderr: INVALID } : ok)
    }
    const result = await withHoistRecovery(run, 'web', ['add', 'is-odd'])
    expect(result.exitCode).toBe(0)
    expect(calls).toEqual([['add', 'is-odd'], ['add', 'is-odd']])
  })

  it('does not retry when there was nothing to repair', async () => {
    writeWorkspace('  some-plugin: true\n')
    const calls: string[][] = []
    const run = (_profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      return Promise.resolve({ ...ok, exitCode: 1, stderr: INVALID })
    }
    await withHoistRecovery(run, 'web', ['add', 'is-odd'])
    // Only the add counts: a failed run is followed by the store cleanup's
    // own query, which is not a retry.
    expect(calls.filter(args => args[0] === 'add')).toHaveLength(1)
  })
})

describe('withHoistRecovery', () => {
  it('retries the SAME command when Windows briefly locked a profile file (#786)', async () => {
    // The reporter's real sequence: pnpm had already built and linked the new
    // commit, then a momentary holder (Defender, the indexer) refused the
    // rename of pnpm-lock.yaml. Leaving this unretried made the update route
    // treat it as "the running host holds the plugin's files open", restore
    // package.json and pnpm-lock.yaml, and thereby throw away a lockfile that
    // already named the new commit — which is what desynchronized the profile.
    const calls: string[][] = []
    let failFirst = true
    const run = async (_profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      if (failFirst) {
        failFirst = false
        return {
          exitCode: -4048,
          timedOut: false,
          stdout: '',
          stderr: String.raw`[EPERM] EPERM: operation not permitted, rename '~\pnpm-lock.yaml.3015012533' -> '~\pnpm-lock.yaml'`,
          cancelled: false,
        }
      }
      return ok
    }
    const result = await withHoistRecovery(run, 'web', ['add', 'git+https://gitee.com/iJetLi/deepseek-harness-codearts.git'])
    expect(result.exitCode).toBe(0)
    // No option is added: this host accepts none, and none is needed — which is
    // exactly why the retry is the same argv (#732).
    expect(calls).toEqual([
      ['add', 'git+https://gitee.com/iJetLi/deepseek-harness-codearts.git'],
      ['add', 'git+https://gitee.com/iJetLi/deepseek-harness-codearts.git'],
    ])
    // And it is not reported as a locked plugin: the final result is a success,
    // so the route's open-file rollback never runs.
    expect(result.stderr).toBe('')
  })

  it('retries the same command when the lock was on the inner virtual-store lockfile (#786)', async () => {
    // `writeLockfiles` writes the profile's `pnpm-lock.yaml` AND the lockfile
    // inside `node_modules/.pnpm/lock.yaml` through the same write-file-atomic,
    // inside one `Promise.all` (pnpm 11.7.0, both branches). A momentary holder
    // on the INNER temp name therefore fails the run exactly like the outer one
    // — and if it were answered as the package-directory case, the route's
    // `pnpmBlockedByOpenFiles` would roll the profile's lockfile back over a
    // node_modules that already holds the new build. Same retry, same argv.
    const calls: string[][] = []
    let failFirst = true
    const run = async (_profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      if (failFirst) {
        failFirst = false
        return {
          exitCode: -4048,
          timedOut: false,
          stdout: '',
          stderr: String.raw`[EPERM] EPERM: operation not permitted, rename 'C:\p\desktop\node_modules\.pnpm\lock.yaml.3015012533' -> 'C:\p\desktop\node_modules\.pnpm\lock.yaml'`,
          cancelled: false,
        }
      }
      return ok
    }
    const result = await withHoistRecovery(run, 'web', ['add', 'dsh-codearts-auth'])
    expect(result.exitCode).toBe(0)
    expect(calls).toEqual([['add', 'dsh-codearts-auth'], ['add', 'dsh-codearts-auth']])
    expect(result.stderr).toBe('')
  })

  it('retries a per-request fetch timeout once with a longer fetchTimeout (#…)', async () => {
    const calls: string[][] = []
    let failFirst = true
    const run = async (_profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      if (failFirst) {
        failFirst = false
        return { exitCode: 1, timedOut: false, stdout: '', stderr: FETCH_TIMEOUT_STDERR, cancelled: false }
      }
      return ok
    }
    const result = await withHoistRecovery(run, 'web', ['add', 'github:volcengine/OpenViking#path:/examples/dsh-memory-plugin'])
    expect(result.exitCode).toBe(0)
    expect(calls).toEqual([
      ['add', 'github:volcengine/OpenViking#path:/examples/dsh-memory-plugin'],
      ['add', FETCH_TIMEOUT_OVERRIDE, 'github:volcengine/OpenViking#path:/examples/dsh-memory-plugin'],
    ])
  })

  it('does not double-apply the fetchTimeout override when it is already present', async () => {
    const calls: string[][] = []
    const run = async (_profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      return { exitCode: 1, timedOut: false, stdout: '', stderr: FETCH_TIMEOUT_STDERR, cancelled: false }
    }
    const result = await withHoistRecovery(run, 'web', ['add', FETCH_TIMEOUT_OVERRIDE, 'dsh-loop'])
    expect(result.exitCode).toBe(1)
    // No second add — and the terminal failure reclaims orphaned store
    // staging dirs (#119), which is the trailing `store path` probe.
    expect(calls).toEqual([['add', FETCH_TIMEOUT_OVERRIDE, 'dsh-loop'], ['store', 'path']])
    // The final failure message is appended for the UI.
    expect(result.stderr).toContain('下载超时')
  })

  it('retries the same argv once when an exact pin is missing from the registry packument (#927)', async () => {
    const stderr = [
      '[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for @michengai/dsh-archive-manager@1.1.3 while fetching it from https://mirrors.cloud.tencent.com/npm/',
      'The latest release of @michengai/dsh-archive-manager is "1.1.2".',
    ].join('\n')
    const calls: string[][] = []
    let failFirst = true
    const run = async (_profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      if (failFirst) {
        failFirst = false
        return { exitCode: 1, timedOut: false, stdout: '', stderr, cancelled: false }
      }
      return ok
    }
    const result = await withHoistRecovery(run, 'web', ['add', '@michengai/dsh-archive-manager@1.1.3'])
    expect(result.exitCode).toBe(0)
    expect(calls).toEqual([
      ['add', '@michengai/dsh-archive-manager@1.1.3'],
      ['add', '@michengai/dsh-archive-manager@1.1.3'],
    ])
  })

  it('keeps the sync-lag sentence when the exact-pin retry also loses (#927)', async () => {
    const stderr = [
      '[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for @michengai/dsh-archive-manager@1.1.3 while fetching it from https://mirrors.cloud.tencent.com/npm/',
      'The latest release of @michengai/dsh-archive-manager is "1.1.2".',
    ].join('\n')
    const run = async (): Promise<InstallResult> => (
      { exitCode: 1, timedOut: false, stdout: '', stderr, cancelled: false }
    )
    const result = await withHoistRecovery(run, 'web', ['add', '@michengai/dsh-archive-manager@1.1.3'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('还没同步')
    expect(result.stderr).not.toContain('通常是该版本被弃用或从未发布')
  })

  it('replaces cmd.exe\'s undecodable output rather than printing it (#502)', async () => {
    // Windows answers 9009 for "command not found" and writes its message in
    // the OEM code page, which reaches us as replacement characters. Leaving
    // that above the explanation was what the user was shown three times in
    // a row, with no way to tell it was a pnpm launch problem.
    const run = async (): Promise<InstallResult> => ({
      exitCode: 9009,
      timedOut: false,
      stdout: '\ufffd\ufffd\ufffd\ufffd',
      stderr: "'\"\"' \ufffd\ufffd\ufffd\ufffd\ndsh: pnpm failed in profile directory",
      cancelled: false,
    })
    const result = await withHoistRecovery(run, 'web', ['add', 'dsh-loop'])
    expect(result.stderr).toContain('pnpm --version')
    expect(result.stderr).not.toContain('\ufffd')
    expect(result.stdout).toBe('')
  })

  // #732: the official Desktop bridge takes exactly `add <target>` or
  // `remove <target>`, so every recovery that decorates the command with an
  // option has to be left out there instead of sent and refused.
  const AGE_VIOLATION_STDERR = '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification'

  it('sends no market option to a host that does not accept them (#732)', async () => {
    const calls: string[][] = []
    const run = async (_profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      return { exitCode: 1, timedOut: false, stdout: '', stderr: AGE_VIOLATION_STDERR, cancelled: false }
    }
    const result = await withHoistRecovery(run, 'web', ['add', 'thing'], undefined, { marketFlags: false })
    expect(result.exitCode).toBe(1)
    // The one command, then only the orphan-store probe — never the override.
    expect(calls).toEqual([['add', 'thing'], ['store', 'path']])
    // And the message does not claim a retry that could not happen (#732 / #919).
    expect(result.stderr).toContain('没有自动重试')
    expect(result.stderr).not.toMatch(/已自动放行重试|already retried|retries once with a one-shot/)
  })

  describe('a locked package directory on the official desktop app (#798)', () => {
    // pnpm names the native binding the host loaded at startup. The classified
    // text offers "run it from the command line with the app closed", which is
    // the one thing the market never does on the official desktop app — it
    // refuses to fall back to `dsh plugin --profile desktop`. So the advice sent
    // the reporter to a door the market itself keeps shut.
    const LOCKED = String.raw`[ERR_PNPM_EPERM] [importPackage C:\dsh\profiles\desktop\node_modules\@trycua\cua-driver-win32-x64-msvc] EPERM: operation not permitted, rename 'C:\dsh\profiles\desktop\node_modules\@trycua\cua-driver-win32-x64-msvc_tmp_26500_6' -> 'C:\dsh\profiles\desktop\node_modules\@trycua\cua-driver-win32-x64-msvc'`
    const failing = async (): Promise<InstallResult> => ({ exitCode: 1, timedOut: false, stdout: '', stderr: LOCKED, cancelled: false })

    it('says the command-line way is not available there, and where to go instead', async () => {
      const result = await withHoistRecovery(failing, 'desktop', ['add', 'thing'], undefined, { marketFlags: false })
      expect(result.stderr).toContain('官方桌面端')
      expect(result.stderr).toContain('设置 → 插件')
      expect(result.stderr).toContain("the \"run it from the command line\" option above is not available here")
    })

    it('leaves the ordinary host\'s message alone, where the command line IS an option', async () => {
      const result = await withHoistRecovery(failing, 'web', ['add', 'thing'])
      expect(result.stderr).not.toContain('官方桌面端')
      expect(result.stderr).toContain('run it from the command line')
    })

    it('adds nothing for a different failure on the desktop app', async () => {
      const other = async (): Promise<InstallResult> => ({ exitCode: 1, timedOut: false, stdout: '', stderr: 'ERR_PNPM_FETCH_404  GET https://x/y.tgz: Not Found - 404', cancelled: false })
      const result = await withHoistRecovery(other, 'desktop', ['add', 'thing'], undefined, { marketFlags: false })
      expect(result.stderr).not.toContain('设置 → 插件')
    })

    it.each(['dshmarket@1.66.48', 'dsh-market@1.66.48'])('does not send a market overlay to Settings → Plugins (%s, #909, #982)', async spec => {
      // That page has no update entry for a package already in the profile.
      // The #798 note is for other plugins; for the market it is a shut door.
      const result = await withHoistRecovery(failing, 'desktop', ['add', spec], undefined, { marketFlags: false })
      expect(result.stderr).not.toContain('设置 → 插件')
      expect(result.stderr).not.toContain("the \"run it from the command line\" option above is not available here")
    })
  })

  it('tells a desktop user on the fresh-release wait what to do, without a door that is shut (#852, #919)', async () => {
    // "no retry happened" is not an answer here: the plugin IS published, pnpm
    // simply will not take it yet. #852 pointed at plain `dsh web`, but that
    // profile is desktop-managed — the same door #909 already proved shut.
    // Say the wait, and (when pnpm named the publish time) how long is left.
    // The classifier's "market already retried" sentence must not stay: the
    // client prefers body.error / stderr's classified half over the note.
    const published = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString()
    const stderr = `[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:\n  thing@1.0.0 was published at ${published}, within the minimumReleaseAge cutoff`
    const run = async (): Promise<InstallResult> => ({ exitCode: 1, timedOut: false, stdout: '', stderr, cancelled: false })
    const result = await withHoistRecovery(run, 'desktop', ['add', 'thing'], undefined, { marketFlags: false })
    expect(result.stderr).toContain('等这个版本过了等待期再更新一次即可')
    expect(result.stderr).toContain('没有自动重试')
    expect(result.stderr).not.toMatch(/dsh web|plain dsh web/)
    expect(result.stderr).not.toMatch(/已自动放行重试|already retried|retries once with a one-shot/)
    expect(result.stderr).toMatch(/还剩|约|小时|hour/i)
  })

  it('still names the wait when pnpm did not include a publish time (#919)', async () => {
    const run = async (): Promise<InstallResult> => ({ exitCode: 1, timedOut: false, stdout: '', stderr: AGE_VIOLATION_STDERR, cancelled: false })
    const result = await withHoistRecovery(run, 'desktop', ['add', 'thing'], undefined, { marketFlags: false })
    expect(result.stderr).toContain('等这个版本过了等待期再更新一次即可')
    expect(result.stderr).not.toMatch(/dsh web|plain dsh web/)
    expect(result.stderr).not.toMatch(/已自动放行重试|already retried|retries once with a one-shot/)
    expect(result.stderr).toContain('没有自动重试')
  })

  it('does not invent a remaining wait when the profile\'s age window cannot be read (#919)', async () => {
    const dir = writeProfile({})
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'minimumReleaseAge: not-a-number\n')
    const published = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString()
    const stderr = `[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:\n  thing@1.0.0 was published at ${published}, within the minimumReleaseAge cutoff`
    const run = async (): Promise<InstallResult> => ({ exitCode: 1, timedOut: false, stdout: '', stderr, cancelled: false })
    const result = await withHoistRecovery(run, 'desktop', ['add', 'thing'], dir, { marketFlags: false })
    expect(result.stderr).toContain('等这个版本过了等待期再更新一次即可')
    expect(result.stderr).not.toMatch(/还剩 \d+ 小时|about \d+ hour/i)
  })

  it('uses the profile\'s own minimumReleaseAge window for the remaining wait (#919)', async () => {
    const dir = writeProfile({})
    // 48 hours: a release 10 hours old still has ~38 hours left, not ~14.
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 2880\n')
    const published = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString()
    const stderr = `[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:\n  thing@1.0.0 was published at ${published}, within the minimumReleaseAge cutoff`
    const run = async (): Promise<InstallResult> => ({ exitCode: 1, timedOut: false, stdout: '', stderr, cancelled: false })
    const result = await withHoistRecovery(run, 'desktop', ['add', 'thing'], dir, { marketFlags: false })
    expect(result.stderr).toMatch(/还剩 3[0-9] 小时|about 3[0-9] hours/)
  })

  it('keeps the plain "no retry" note for a skipped step that is not the wait', async () => {
    const run = async (): Promise<InstallResult> => ({ exitCode: 1, timedOut: false, stdout: '', stderr: 'ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF', cancelled: false })
    const result = await withHoistRecovery(run, 'desktop', ['add', 'thing'], undefined, { marketFlags: false })
    expect(result.stderr).toContain('没有自动重试')
    expect(result.stderr).toContain('--no-frozen-lockfile')
    expect(result.stderr).not.toContain('过了等待期')
  })

  it('still uses the one-shot override where the host accepts options', async () => {
    const calls: string[][] = []
    const run = async (_profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      return { exitCode: 1, timedOut: false, stdout: '', stderr: AGE_VIOLATION_STDERR, cancelled: false }
    }
    await withHoistRecovery(run, 'web', ['add', 'thing'])
    expect(calls[1]).toEqual(['add', RELEASE_AGE_OVERRIDE, 'thing'])
  })

  it('repairs a broken entry before running, even where the caller declined the bypass (#594)', async () => {
    // The repair is not the bypass: it is a rewrite of a form pnpm cannot read
    // back, so a caller that declined to relax the profile's age policy still
    // gets the file fixed — and it happens before the first run, because that
    // is when pnpm would be resolving the entry.
    const dir = writeProfile({})
    const workspace = join(dir, 'pnpm-workspace.yaml')
    writeFileSync(workspace, 'minimumReleaseAgeExclude:\n  - keep@1.0.0\n  - keep@2.0.0\n')
    const calls: string[][] = []
    const seen: string[] = []
    const run = async (_profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      seen.push(readFileSync(workspace, 'utf8'))
      return { exitCode: 1, timedOut: false, stdout: '', stderr: AGE_VIOLATION_STDERR, cancelled: false }
    }
    await withHoistRecovery(run, 'web', ['add', 'thing'], dir, { releaseAgeBypass: false })
    expect(calls).toEqual([['add', 'thing'], ['store', 'path']])
    expect(seen[0]).toBe('minimumReleaseAgeExclude:\n  - keep@1.0.0 || 2.0.0\n')
  })

  it('leaves the policy alone when the caller declined the bypass and nothing was broken', async () => {
    // A single exact version is a form pnpm reads fine: nothing to rewrite,
    // and the entry keeps naming that version only.
    const dir = writeProfile({})
    const workspace = join(dir, 'pnpm-workspace.yaml')
    writeFileSync(workspace, 'minimumReleaseAgeExclude:\n  - keep@1.0.0\n')
    const calls: string[][] = []
    const run = async (_profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      return { exitCode: 1, timedOut: false, stdout: '', stderr: AGE_VIOLATION_STDERR, cancelled: false }
    }
    await withHoistRecovery(run, 'web', ['add', 'thing'], dir, { releaseAgeBypass: false })
    expect(calls).toEqual([['add', 'thing'], ['store', 'path']])
    expect(readFileSync(workspace, 'utf8')).toBe('minimumReleaseAgeExclude:\n  - keep@1.0.0\n')
  })

  it('merges a shadowed rule before the command runs, not after a failure (#732)', async () => {
    // pnpm reads only the FIRST rule per name, so the duplicate makes every
    // later command fail verification. Merging it first is what keeps this
    // command from failing at all — the runner below reads the file as pnpm
    // would, which is how the test proves the order.
    const dir = writeProfile({})
    const workspace = join(dir, 'pnpm-workspace.yaml')
    writeFileSync(workspace, 'minimumReleaseAgeExclude:\n  - billion-context@0.1.138 || 0.1.147\n  - dshmarket@1.38.1\n  - dshmarket@1.65.4\n')
    const seen: string[] = []
    const run = async (_profile: string, _args: string[]): Promise<InstallResult> => {
      seen.push(readFileSync(workspace, 'utf8'))
      return ok
    }
    const result = await withHoistRecovery(run, 'web', ['add', 'billion-context@0.1.147'], dir)
    expect(result.exitCode).toBe(0)
    expect(seen[0]).toBe('minimumReleaseAgeExclude:\n  - billion-context@0.1.138 || 0.1.147\n  - dshmarket@1.38.1 || 1.65.4\n')
  })

  it('repairs a broken entry pnpm wrote during the run, and retries the same argv (#732)', async () => {
    // A repair is a file rewrite, so it needs no option: the host that refuses
    // options gets the same recovery as the one that does not.
    const dir = writeProfile({})
    const workspace = join(dir, 'pnpm-workspace.yaml')
    const calls: string[][] = []
    let failFirst = true
    const run = async (_profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      if (failFirst) {
        failFirst = false
        // pnpm appends its own rule for the version it just let through.
        writeFileSync(workspace, 'minimumReleaseAgeExclude:\n  - dshmarket@1.38.1 || 1.65.1\n  - dshmarket@1.65.4\n')
        return { exitCode: 1, timedOut: false, stdout: '', stderr: AGE_VIOLATION_STDERR, cancelled: false }
      }
      return ok
    }
    const result = await withHoistRecovery(run, 'web', ['add', 'dshmarket@1.65.4'], dir, { marketFlags: false })
    expect(result.exitCode).toBe(0)
    expect(calls).toEqual([['add', 'dshmarket@1.65.4'], ['add', 'dshmarket@1.65.4']])
    expect(readFileSync(workspace, 'utf8')).toBe('minimumReleaseAgeExclude:\n  - dshmarket@1.38.1 || 1.65.1 || 1.65.4\n')
  })

  it('repairs a rule appended during the run even when the host\'s error hides pnpm\'s text (#732)', async () => {
    // The official desktop host runs pnpm itself and hands back its own
    // message, not pnpm's. In the report it appended `dsh-cost-meter@1.8.5` as
    // a second rule behind the existing union — dead, because pnpm reads only
    // the first per name — and the market's repair never fired, since it
    // waited for `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` to arrive.
    const dir = writeProfile({})
    const workspace = join(dir, 'pnpm-workspace.yaml')
    writeFileSync(workspace, 'minimumReleaseAgeExclude:\n  - dsh-cost-meter@1.7.40 || 1.7.47 || 1.8.2 || 1.8.3 || 1.8.4\n')
    const calls: string[][] = []
    let failFirst = true
    const run = async (_profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      if (failFirst) {
        failFirst = false
        writeFileSync(workspace, 'minimumReleaseAgeExclude:\n  - dsh-cost-meter@1.7.40 || 1.7.47 || 1.8.2 || 1.8.3 || 1.8.4\n  - dsh-cost-meter@1.8.5\n')
        // What the bridge actually returns: the manager's own message.
        return { exitCode: 1, timedOut: false, stdout: '', stderr: '{"code":"install-failed"}', cancelled: false }
      }
      return ok
    }

    const result = await withHoistRecovery(run, 'desktop', ['add', 'dsh-cost-meter@1.8.5'], dir, { marketFlags: false })

    expect(result.exitCode).toBe(0)
    expect(calls).toEqual([['add', 'dsh-cost-meter@1.8.5'], ['add', 'dsh-cost-meter@1.8.5']])
    expect(readFileSync(workspace, 'utf8')).toBe('minimumReleaseAgeExclude:\n  - dsh-cost-meter@1.7.40 || 1.7.47 || 1.8.2 || 1.8.3 || 1.8.4 || 1.8.5\n')
  })

  it('does not retry an unrelated failure that wrote no duplicate rule (#732)', async () => {
    // The repair is keyed on evidence in the file, not on "something failed":
    // without a shadowed rule there is nothing a retry could change.
    const dir = writeProfile({})
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'minimumReleaseAgeExclude:\n  - keep@1.0.0\n')
    const calls: string[][] = []
    const run = async (_profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      return { exitCode: 1, timedOut: false, stdout: '', stderr: '{"code":"install-failed"}', cancelled: false }
    }

    await withHoistRecovery(run, 'desktop', ['add', 'thing'], dir, { marketFlags: false })

    expect(calls.filter(call => call[0] === 'add')).toEqual([['add', 'thing']])
  })

  it('merges before an `install` too, which reads the same key (#732)', async () => {
    const dir = writeProfile({})
    const workspace = join(dir, 'pnpm-workspace.yaml')
    writeFileSync(workspace, 'minimumReleaseAgeExclude:\n  - keep@1.0.0\n  - keep@2.0.0\n')
    const seen: string[] = []
    const run = async (_profile: string, _args: string[]): Promise<InstallResult> => {
      seen.push(readFileSync(workspace, 'utf8'))
      return ok
    }
    await withHoistRecovery(run, 'web', ['--no-frozen-lockfile', 'install'], dir)
    expect(seen[0]).toBe('minimumReleaseAgeExclude:\n  - keep@1.0.0 || 2.0.0\n')
  })
})

describe('successful release-age cleanup (#883, #878)', () => {
  const initial = 'minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - keep@1.0.0\n'
  const appended = `${initial}  - keep@2.0.0\n`
  const merged = initial.replace('keep@1.0.0', 'keep@1.0.0 || 2.0.0')

  it('preserves the policy byte-for-byte on #991 mature updates, including ambiguous duplicates', async () => {
    const dir = writeProfile({})
    const workspace = join(dir, 'pnpm-workspace.yaml')
    writeFileSync(workspace, appended)
    const calls: string[][] = []
    const run = async (_profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      return ok
    }
    expect(await withHoistRecovery(run, 'desktop', ['add', 'thing@1.1.0'], dir,
      { marketFlags: false, releaseAgeBypass: false, preserveProfilePolicy: true })).toBe(ok)
    expect(readFileSync(workspace, 'utf8')).toBe(appended)
    expect(calls).toEqual([['add', 'thing@1.1.0']])
  })

  it.each([true, false])('preserving #991 policy prevents age recovery even with marketFlags=%s', async marketFlags => {
    const dir = writeProfile({})
    const workspace = join(dir, 'pnpm-workspace.yaml')
    writeFileSync(workspace, appended)
    const calls: string[][] = []
    const run = async (_profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      return { ...ok, exitCode: 1, stderr: 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION' }
    }
    const result = await withHoistRecovery(run, 'desktop', ['add', '--force', 'thing@1.0.0'], dir,
      { marketFlags, preserveProfilePolicy: true })
    expect(result.exitCode).toBe(1)
    expect(calls.filter(args => args[0] === 'add')).toEqual([['add', '--force', 'thing@1.0.0']])
    expect(calls.some(args => args.includes(RELEASE_AGE_OVERRIDE))).toBe(false)
    expect(readFileSync(workspace, 'utf8')).toBe(appended)
  })

  it('leaves pnpm native persisted exclusions intact on #991 updates', async () => {
    const dir = writeProfile({})
    const workspace = join(dir, 'pnpm-workspace.yaml')
    writeFileSync(workspace, initial)
    const run = async (): Promise<InstallResult> => {
      writeFileSync(workspace, appended)
      return ok
    }
    expect(await withHoistRecovery(run, 'desktop', ['add', 'thing@1.1.0'], dir,
      { preserveProfilePolicy: true })).toBe(ok)
    expect(readFileSync(workspace, 'utf8')).toBe(appended)
  })

  it('does not repair exclusions or bypass the wait after a pnpm failure on #991 updates', async () => {
    const dir = writeProfile({})
    const workspace = join(dir, 'pnpm-workspace.yaml')
    writeFileSync(workspace, appended)
    const calls: string[][] = []
    const run = async (_profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      return { ...ok, exitCode: 1, stderr: 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION' }
    }
    const result = await withHoistRecovery(run, 'desktop', ['add', 'thing@1.1.0'], dir,
      { marketFlags: false, releaseAgeBypass: false, preserveProfilePolicy: true })
    expect(result.exitCode).toBe(1)
    expect(readFileSync(workspace, 'utf8')).toBe(appended)
    // Failure cleanup can query the pnpm store, but must never retry an add.
    expect(calls.filter(args => args[0] === 'add')).toEqual([['add', 'thing@1.1.0']])
  })

  it.each([
    ['add', 'thing'],
    ['remove', 'thing'],
    ['--no-frozen-lockfile', 'install'],
    ['update', 'thing'],
  ])('merges rules written by a successful %j before returning, without rerunning it', async (...args) => {
    const dir = writeProfile({})
    const workspace = join(dir, 'pnpm-workspace.yaml')
    writeFileSync(workspace, initial)
    const calls: string[][] = []
    const success = { ...ok, stdout: 'installed', stderr: 'warning', resolvedNpmVersion: '2.0.0' }
    const run = async (_profile: string, argv: string[]): Promise<InstallResult> => {
      calls.push(argv)
      expect(readFileSync(workspace, 'utf8')).toBe(initial)
      writeFileSync(workspace, appended)
      return success
    }

    expect(await withHoistRecovery(run, 'web', args, dir, { releaseAgeBypass: false })).toBe(success)
    expect(readFileSync(workspace, 'utf8')).toBe(merged)
    expect(calls).toEqual([args])
  })

  it.each(['duplicate rule', 'release age', 'network', 'hoist', 'profile lock'])('cleans the successful retry after %s without adding another retry', async failure => {
    const dir = writeProfile({})
    const workspace = join(dir, 'pnpm-workspace.yaml')
    writeFileSync(workspace, initial)
    const calls: string[][] = []
    const args = ['add', 'thing']
    const retryRule = '  - keep@3.0.0\n'
    const run = async (_profile: string, argv: string[]): Promise<InstallResult> => {
      calls.push(argv)
      if (calls.length === 1) {
        if (failure === 'duplicate rule') writeFileSync(workspace, appended)
        const stderr = {
          'duplicate rule': '{"code":"install-failed"}',
          'release age': 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION',
          network: 'ERR_PNPM_META_FETCH_FAIL request failed, reason: read ECONNRESET',
          hoist: 'ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF',
          'profile lock': String.raw`EPERM: operation not permitted, rename 'C:\profile\pnpm-lock.yaml.3015012533' -> 'C:\profile\pnpm-lock.yaml'`,
        }[failure]!
        return { ...ok, exitCode: 1, stderr }
      }
      writeFileSync(workspace, readFileSync(workspace, 'utf8') + retryRule)
      return ok
    }

    expect(await withHoistRecovery(run, 'web', args, dir)).toBe(ok)
    expect(calls).toEqual(failure === 'hoist'
      ? [args, ['install', '--no-frozen-lockfile'], args]
      : [args, failure === 'release age' ? ['add', RELEASE_AGE_OVERRIDE, 'thing'] : args])
    expect(readFileSync(workspace, 'utf8')).toBe(failure === 'duplicate rule'
      ? merged.replace('2.0.0', '2.0.0 || 3.0.0')
      : initial.replace('keep@1.0.0', 'keep@1.0.0 || 3.0.0'))
  })

  it('leaves a file without duplicate rules byte-for-byte and does not write it', async () => {
    const dir = writeProfile({})
    const workspace = join(dir, 'pnpm-workspace.yaml')
    writeFileSync(workspace, initial)
    utimesSync(workspace, new Date(0), new Date(0))
    const mtime = statSync(workspace).mtimeMs
    const { run, calls } = recordingRunner()

    expect(await withHoistRecovery(run, 'web', ['add', 'thing'], dir)).toBe(ok)
    expect(readFileSync(workspace, 'utf8')).toBe(initial)
    expect(statSync(workspace).mtimeMs).toBe(mtime)
    expect(calls).toEqual([['add', 'thing']])
  })

  it('keeps a successful result and never reruns the operation if cleanup throws', async () => {
    const dir = writeProfile({})
    const calls: string[][] = []
    const merge = vi.spyOn(profileHelpers, 'mergeDuplicateReleaseAgeExcludes')
    try {
      const run = async (_profile: string, args: string[]): Promise<InstallResult> => {
        calls.push(args)
        merge.mockImplementationOnce(() => { throw new Error('workspace is read-only') })
        return ok
      }
      expect(await withHoistRecovery(run, 'web', ['add', 'thing'], dir)).toBe(ok)
      expect(calls).toEqual([['add', 'thing']])
      expect(merge).toHaveBeenCalledTimes(2)
    } finally {
      merge.mockRestore()
    }
  })
})

describe('pnpmNeverStarted (#502)', () => {
  it('is true only when the failure happened before pnpm could run', () => {
    const failed = (over: Partial<InstallResult>): InstallResult =>
      ({ exitCode: 1, timedOut: false, stdout: '', stderr: '', cancelled: false, ...over })
    // The profile is untouched here, so the update route must not report a
    // rollback it could not verify — there is nothing to roll back.
    expect(pnpmNeverStarted(failed({ exitCode: 9009, stderr: "'\"\"' \ufffd\ufffd\ufffd" }))).toBe(true)
    // pnpm ran and failed: package.json may already have been rewritten.
    expect(pnpmNeverStarted(failed({ stderr: 'ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/ghost: Not Found - 404' }))).toBe(false)
    // #509: the spawn was refused outright, so the profile is equally
    // untouched — and the update route's "restoration could not be verified,
    // inspect this profile" notice is equally an alarm about nothing.
    expect(pnpmNeverStarted(failed({ stderr: "Error: spawnSync pnpm EACCES\n  code: 'EACCES',\n  syscall: 'spawnSync pnpm'," }))).toBe(true)
    expect(pnpmNeverStarted(failed({ stderr: 'some other failure' }))).toBe(false)
    // #919: release-age is a different "untouched" shape — pnpm DID start —
    // covered by pnpmRefusedYoungRelease, not by this predicate.
    expect(pnpmNeverStarted(failed({ stderr: '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] young' }))).toBe(false)
  })
})

describe('pnpmRefusedYoungRelease (#919)', () => {
  it('is true when pnpm refused a too-young release without writing', () => {
    const failed = (over: Partial<InstallResult>): InstallResult =>
      ({ exitCode: 1, timedOut: false, stdout: '', stderr: '', cancelled: false, ...over })
    expect(pnpmRefusedYoungRelease(failed({ stderr: '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] young' }))).toBe(true)
    expect(pnpmRefusedYoungRelease(failed({ stderr: 'ERR_PNPM_NO_MATURE_MATCHING_VERSION No matching version' }))).toBe(true)
    expect(pnpmRefusedYoungRelease(failed({ stderr: 'ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/ghost: Not Found - 404' }))).toBe(false)
  })
})

describe('host port collision after pnpm wrote (#975)', () => {
  const failed = (over: Partial<InstallResult>): InstallResult =>
    ({ exitCode: 1, timedOut: false, stdout: '', stderr: '', cancelled: false, ...over })
  const collision = [
    'webserver (required) listen EADDRINUSE: address already in use 127.0.0.1:3080',
    'Plugins waiting for services: client-hmr',
    'Full diagnostics: C:\\Users\\u\\.dsh\\logs\\startup-2026-10-22T05-05-40.541Z-37a0b6ec-b8f2-4699-82ce-c53428afc403.log',
  ].join('\n')

  it('is true only for DSH listen EADDRINUSE plus Full diagnostics on a startup log', () => {
    expect(isHostPortCollision(failed({ stderr: collision }))).toBe(true)
    expect(isHostPortCollision(failed({ stdout: collision, stderr: '' }))).toBe(true)
    expect(isHostPortCollision(failed({ stderr: 'listen EADDRINUSE 127.0.0.1:3080' }))).toBe(false)
    expect(isHostPortCollision(failed({
      stderr: 'Full diagnostics: C:\\Users\\u\\.dsh\\logs\\startup-2026-10-22T05-05-40.541Z-x.log',
    }))).toBe(false)
    expect(isHostPortCollision(failed({ stderr: 'EADDRINUSE: address already in use' }))).toBe(false)
    expect(isHostPortCollision(failed({ stderr: '[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/ghost: Not Found - 404' }))).toBe(false)
  })

  it('installApplied is true only when this run added a loadable plugin', () => {
    const dir = writeProfile({})
    expect(installApplied('web', new Set(), dir)).toBe(false)
    writePkg(dir, 'dsh-loop', { name: 'dsh-loop', version: '0.1.204', dsh: {}, main: 'lib/index.js' }, ['lib/index.js'])
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-loop': '^0.1.204' } }))
    expect(installApplied('web', new Set(), dir)).toBe(true)
    expect(installApplied('web', new Set(['dsh-loop']), dir)).toBe(false)
    writePkg(dir, 'junk', { name: 'junk', version: '1.0.0' })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { junk: '^1.0.0' } }))
    expect(installApplied('web', new Set(), dir)).toBe(false)
  })

  it('updateApplied is true only when this run changed the installed version or commit', () => {
    const dir = writeProfile({ 'dsh-loop': '^1.0.0' })
    writePkg(dir, 'dsh-loop', { name: 'dsh-loop', version: '1.2.0', dsh: {}, main: 'lib/index.js' }, ['lib/index.js'])
    expect(updateApplied({
      profile: 'web', name: 'dsh-loop', isGit: false,
      beforeVersion: '1.0.0', beforeCommit: null, explicitDir: dir,
    })).toBe(true)
    writePkg(dir, 'dsh-loop', { name: 'dsh-loop', version: '1.0.0', dsh: {}, main: 'lib/index.js' }, ['lib/index.js'])
    expect(updateApplied({
      profile: 'web', name: 'dsh-loop', isGit: false,
      beforeVersion: '1.0.0', beforeCommit: null, explicitDir: dir,
    })).toBe(false)
    expect(updateApplied({
      profile: 'web', name: 'missing', isGit: false,
      beforeVersion: '1.0.0', beforeCommit: null, explicitDir: dir,
    })).toBe(false)
  })

  it('updateApplied sees a commit change in the codeload lock a github: install leaves', () => {
    // pnpm records floating github: as `resolution: {tarball: …/tar.gz/<sha>}`,
    // not `type: git`. Version often stays put; the lock commit is the only
    // proof the update landed. Reading only the git-resolution shape would
    // say nothing changed and the route would roll the new build back.
    const oldCommit = 'a'.repeat(40)
    const newCommit = 'b'.repeat(40)
    const dir = writeProfile({ themer: 'github:owner/themer' })
    writePkg(dir, 'themer', { name: 'themer', version: '1.0.0', dsh: {}, main: 'lib/index.js' }, ['lib/index.js'])
    writeFileSync(join(dir, 'pnpm-lock.yaml'),
      `lockfileVersion: 9\n  resolution: {tarball: https://codeload.github.com/owner/themer/tar.gz/${newCommit}}\n`)
    expect(updateApplied({
      profile: 'web', name: 'themer', isGit: true,
      beforeVersion: '1.0.0', beforeCommit: oldCommit,
      spec: 'github:owner/themer', explicitDir: dir,
    })).toBe(true)
    writeFileSync(join(dir, 'pnpm-lock.yaml'),
      `lockfileVersion: 9\n  resolution: {tarball: https://codeload.github.com/owner/themer/tar.gz/${oldCommit}}\n`)
    expect(updateApplied({
      profile: 'web', name: 'themer', isGit: true,
      beforeVersion: '1.0.0', beforeCommit: oldCommit,
      spec: 'github:owner/themer', explicitDir: dir,
    })).toBe(false)
  })
})

describe('isStaleUpdate (#22: clean exit, nothing changed)', () => {
  it('flags silently-kept versions/commits, never a first install', () => {
    // npm: same version after "update" = pnpm minimumReleaseAge kept the old one.
    expect(isStaleUpdate({ isGit: false, beforeVersion: '1.0.3', afterVersion: '1.0.3', beforeCommit: null, afterCommit: null })).toBe(true)
    expect(isStaleUpdate({ isGit: false, beforeVersion: '1.0.3', afterVersion: '1.2.2', beforeCommit: null, afterCommit: null })).toBe(false)
    // git: pinned to the same commit.
    expect(isStaleUpdate({ isGit: true, beforeVersion: null, afterVersion: null, beforeCommit: 'aaa', afterCommit: 'aaa' })).toBe(true)
    expect(isStaleUpdate({ isGit: true, beforeVersion: null, afterVersion: null, beforeCommit: 'aaa', afterCommit: 'bbb' })).toBe(false)
    // First install: no before state, nothing to be stale against.
    expect(isStaleUpdate({ isGit: false, beforeVersion: null, afterVersion: '1.0.0', beforeCommit: null, afterCommit: null })).toBe(false)
    expect(isStaleUpdate({ isGit: true, beforeVersion: null, afterVersion: null, beforeCommit: null, afterCommit: 'aaa' })).toBe(false)
  })
})

describe('store hygiene (#119)', () => {

  it('reclaims orphaned pnpm store staging dirs after a failed run', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dshm-storehome-'))
    try {
      const store = join(home, 'store')
      mkdirSync(join(store, 'tmp', '_tmp_99999999_orphan'), { recursive: true })
      const calls: string[][] = []
      let failAdd = true
      const run = async (_profile: string, args: string[]): Promise<InstallResult> => {
        calls.push(args)
        if (args[0] === 'store') {
          return { exitCode: 0, timedOut: false, stdout: `${store}\n`, stderr: '', cancelled: false }
        }
        if (failAdd) {
          failAdd = false
          return { exitCode: 1, timedOut: false, stdout: '', stderr: 'ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/ghost: Not Found - 404', cancelled: false }
        }
        return ok
      }
      const result = await withHoistRecovery(run, 'web', ['add', 'dsh-loop'])
      expect(result.exitCode).toBe(1)
      expect(calls.map(c => c.join(' '))).toEqual(['add dsh-loop', 'store path'])
      expect(existsSync(join(store, 'tmp', '_tmp_99999999_orphan'))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('reclaims node_modules/.ignored after success and after cancel (#974)', async () => {
    // Garbage lands in .ignored on the NEXT pnpm run. Cleaning only on
    // failure would miss the successful run that just moved it there.
    const ignored = join(profileDir('web'), 'node_modules', '.ignored')
    const run = async (): Promise<InstallResult> => ok
    mkdirSync(join(ignored, 'orphan_tmp_1_a'), { recursive: true })
    await withHoistRecovery(run, 'web', ['add', 'dsh-loop'])
    expect(existsSync(join(ignored, 'orphan_tmp_1_a'))).toBe(false)

    mkdirSync(join(ignored, 'orphan_tmp_1_a'), { recursive: true })
    const cancel = async (): Promise<InstallResult> =>
      ({ exitCode: 1, timedOut: false, stdout: '', stderr: '', cancelled: true })
    await withHoistRecovery(cancel, 'web', ['add', 'dsh-loop'])
    expect(existsSync(join(ignored, 'orphan_tmp_1_a'))).toBe(false)
  })
})

describe('parseIgnoredBuilds (#6)', () => {
  it('extracts names from pnpm output, stripping versions and the trailing period', () => {
    expect(parseIgnoredBuilds('Ignored build scripts: esbuild@0.25.0, koffi.', ''))
      .toEqual(['esbuild', 'koffi'])
    expect(parseIgnoredBuilds('', 'warn Ignored build scripts: @scope/pkg@1.0.0'))
      .toEqual(['@scope/pkg'])
    expect(parseIgnoredBuilds('all good', '')).toEqual([])
  })

  it('strips git/codeload source suffixes the same way as versions (#69)', () => {
    expect(parseIgnoredBuilds('', 'Ignored build scripts: dsh-github-intelligence@https://codeload.github.com/z/r/tar.gz/abc.'))
      .toEqual(['dsh-github-intelligence'])
  })
})

describe('parseIgnoredBuildEntries', () => {
  it('keeps the dep path pnpm named alongside the bare name it is matched by', () => {
    // pnpm writes THIS string into allowBuilds when it auto-creates the entry,
    // and matches an existing one verbatim. `parseIgnoredBuilds` collapses it
    // to `dsh-codearts-auth`, which no pnpm 11.x reads for a git dependency.
    const dep = 'dsh-codearts-auth@git+https://gitee.com/iJetLi/deepseek-harness-codearts.git#f9a297ac86962d75ca99d08e279b57b2b66a7b59'
    expect(parseIgnoredBuildEntries('', `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: ${dep}\n`))
      .toEqual([{ name: 'dsh-codearts-auth', key: dep }])
  })

  it('leaves a registry dependency keyed by its bare name, as pnpm does', () => {
    // pnpm's allowBuildKeyFromIgnoredBuild collapses a semver dep path to the
    // bare name, which is exactly the entry that authorizes it. Only a source
    // (git, archive, tarball) keeps its full dep path.
    expect(parseIgnoredBuildEntries('', 'Ignored build scripts: esbuild@0.25.0, koffi.'))
      .toEqual([{ name: 'esbuild', key: 'esbuild' }, { name: 'koffi', key: 'koffi' }])
    expect(parseIgnoredBuildEntries('', 'Ignored build scripts: @scope/pkg@1.0.0.'))
      .toEqual([{ name: '@scope/pkg', key: '@scope/pkg' }])
  })

  it('keeps a codeload archive dep path whole, not the bare name', () => {
    const dep = 'dsh-github-intelligence@https://codeload.github.com/z/r/tar.gz/abc123'
    expect(parseIgnoredBuildEntries('', `Ignored build scripts: ${dep}.`))
      .toEqual([{ name: 'dsh-github-intelligence', key: dep }])
  })

  it('stops at the JSON around the sentence when it arrives inside ndjson', () => {
    // --reporter=ndjson puts the whole sentence in a JSON string on stdout, so
    // the capture runs on into `","code":"ERR_PNPM_IGNORED_BUILDS"…` unless the
    // walk stops at the quote. Verified against real pnpm 11.7.0 output.
    const dep = 'dsh-probe@git+file:///tmp/probe.git#fd58e36338d83115cf3c0b5d52916cdb705d5632'
    const line = `{"time":1,"level":"error","name":"pnpm","code":"ERR_PNPM_IGNORED_BUILDS",`
      + `"err":{"message":"Ignored build scripts: ${dep}","code":"ERR_PNPM_IGNORED_BUILDS"}}`
    expect(parseIgnoredBuildEntries(line, '')).toEqual([{ name: 'dsh-probe', key: dep }])
  })
})

describe('parsePrepareNotAllowed (#68)', () => {
  const STDERR = '[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from "https://codeload.github.com/z/r/tar.gz/abc": The git-hosted package "dsh-github-intelligence@2.8.0" needs to execute build scripts but is not in the "allowBuilds" allowlist.'
  it('extracts the rejected package name, stripping the version', () => {
    expect(parsePrepareNotAllowed('', STDERR)).toBe('dsh-github-intelligence')
    expect(parsePrepareNotAllowed(STDERR.replace('dsh-github-intelligence@2.8.0', '@scope/pkg@1.0.0'), ''))
      .toBe('@scope/pkg')
  })
  it('returns null for anything else', () => {
    expect(parsePrepareNotAllowed('all good', '')).toBeNull()
    expect(parsePrepareNotAllowed('', 'Ignored build scripts: esbuild.')).toBeNull()
  })

  it('matches the ndjson form, whose quotes arrive escaped (#113)', () => {
    // The market always passes --reporter=ndjson, so in production this
    // sentence is nested in a JSON string: the literal-quote regex missed it
    // and the approve-and-retry banner never appeared.
    const ndjson = String.raw`{"name":"pnpm","level":"error","err":{"message":"Failed to prepare git-hosted package fetched from \"https://codeload.github.com/s/r/tar.gz/abc\": The git-hosted package \"dsh-queue-plus@0.3.0\" needs to execute build scripts but is not in the \"allowBuilds\" allowlist."}}`
    expect(parsePrepareNotAllowed(ndjson, '')).toBe('dsh-queue-plus')
    expect(parsePrepareNotAllowed('', ndjson.replace('dsh-queue-plus@0.3.0', '@scope/pkg@1.0.0'))).toBe('@scope/pkg')
  })
})

describe("pnpm's own error survives to the surface (#244/#192/#138)", () => {
  const base: InstallResult = {
    exitCode: 1, timedOut: false, cancelled: false,
    // What the market actually gets on stderr: dsh's wrapper line, byte-for-byte
    // identical for every possible cause. This is the "stack tail" three
    // separate reports describe seeing in the UI.
    stderr: 'dsh: pnpm failed in profile directory ~/.dsh/profiles/web',
    stdout: '',
  }

  it('prefers pnpm\'s structured error over the useless wrapper tail', () => {
    expect(failureDetail({
      ...base,
      pnpmError: 'Unexpected store location',
      pnpmErrorCode: 'ERR_PNPM_UNEXPECTED_STORE',
    })).toBe('ERR_PNPM_UNEXPECTED_STORE: Unexpected store location')
  })

  it('falls back to the stderr tail when pnpm gave no structured error', () => {
    expect(failureDetail(base)).toContain('pnpm failed in profile directory')
  })

  it('uses stdout when stderr is empty, as before', () => {
    expect(failureDetail({ ...base, stderr: '', stdout: 'something on stdout' }))
      .toBe('something on stdout')
  })

  it('cuts a long tail at a sentence end, and says something was dropped (#852)', () => {
    // The shape that reached a user's UI: the market appends its own
    // explanation to pnpm's output, and the 300-character tail used to land
    // inside the middle sentence — the log read
    // "（is, export the log and report it这台宿主…", a fragment of one sentence
    // welded to the next. Two things have to hold: the cut starts at a
    // sentence, and the reader is told the front is missing.
    const explanation = 'a recently-published plugin version in this profile trips the fresh-release check, blocking any change (even to other plugins); the market retries once with a one-shot bypass — if you still see this, export the log and report it'
    const note = '这台宿主（官方桌面端）自己执行安装，不接受市场附加的 pnpm 参数（--config.minimum-release-age=0），所以这一步没有自动重试。 / This host (the official desktop app) runs the install itself and takes no pnpm options from the market (--config.minimum-release-age=0), so that automatic retry could not be attempted.'
    const detail = failureDetail({ ...base, stderr: `${explanation}\n\n${note}` })
    expect(detail.startsWith('…')).toBe(true)
    expect(detail).not.toContain('it这台宿主')
    expect(detail.endsWith('so that automatic retry could not be attempted.')).toBe(true)
  })

  it('marks a tail with no sentence boundary rather than pretending it is whole', () => {
    const blob = 'x'.repeat(500)
    expect(failureDetail({ ...base, stderr: blob })).toBe(`…${blob.slice(-300)}`)
  })

  it('appends pnpm\'s own words when nothing classified the failure', async () => {
    // The whole point: an UNRECOGNIZED error is where the raw text is worth
    // the most, because there is no written explanation to show instead.
    const run = async (): Promise<InstallResult> => ({
      ...base,
      pnpmError: 'Something upstream has never seen before',
      pnpmErrorCode: 'ERR_PNPM_BRAND_NEW',
    })
    const result = await withHoistRecovery(run, 'web', ['add', 'x'])
    expect(result.stderr).toContain('ERR_PNPM_BRAND_NEW: Something upstream has never seen before')
  })

  it('leaves a CLASSIFIED failure to its written explanation, not the raw text', async () => {
    // A recognized error already has an actionable bilingual message; pasting
    // pnpm's raw prose after it would just make the banner longer.
    const run = async (): Promise<InstallResult> => ({
      ...base,
      stdout: 'ERR_PNPM_ADDING_TO_ROOT some raw pnpm prose',
      pnpmError: 'some raw pnpm prose',
      pnpmErrorCode: 'ERR_PNPM_ADDING_TO_ROOT',
    })
    const result = await withHoistRecovery(run, 'web', ['add', 'x'])
    expect(result.stderr).toContain('this is a market bug')
    expect(result.stderr).not.toContain('ERR_PNPM_ADDING_TO_ROOT: some raw pnpm prose')
  })
})

describe('validateAddedPlugins separates "added nothing" from "added junk" (#258)', () => {
  it('reports an empty `added` when the plugin command changed nothing', async () => {
    // The Desktop channel in the report exited 0 without touching the
    // profile. Blaming the plugin ("needs a build step / ships no
    // artifacts") sent the reporter chasing allowBuilds for a plugin that
    // ships a complete lib/.
    const dir = profileDir('web')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { existing: '^1.0.0' } }))
    const run = async (): Promise<InstallResult> => ({
      exitCode: 0, timedOut: false, cancelled: false, stdout: '', stderr: '',
    })
    const result = await validateAddedPlugins(run, 'web', new Set(['existing']))
    expect(result.added).toEqual([])
    expect(result.keep).toEqual([])
    // No removals either — nothing arrived to remove. That pairing is what
    // distinguishes this from "everything added was unloadable".
    expect(result.removedBroken).toEqual([])
  })

  it('reports what arrived when the additions were unloadable', async () => {
    const dir = profileDir('web')
    mkdirSync(join(dir, 'node_modules', 'junk'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { junk: '^1.0.0' } }))
    // No dsh manifest → removed as broken.
    writeFileSync(join(dir, 'node_modules', 'junk', 'package.json'), JSON.stringify({ name: 'junk' }))
    const removed: string[] = []
    const run = async (_p: string, args: string[]): Promise<InstallResult> => {
      if (args[0] === 'remove') removed.push(args[1]!)
      return { exitCode: 0, timedOut: false, cancelled: false, stdout: '', stderr: '' }
    }
    const result = await validateAddedPlugins(run, 'web', new Set())
    expect(result.added).toEqual(['junk'])
    expect(result.keep).toEqual([])
    expect(result.removedBroken).toEqual(['junk'])
    expect(removed).toEqual(['junk'])
  })
})

describe('host bridge cleanup after removal (#662)', () => {
  // A runner that performs the real filesystem effect of `dsh plugin remove`
  // (the profile package directory disappears), unlike recordingRunner.
  function removingRunner(dir: string): { calls: string[][]; run: (profile: string, args: string[]) => Promise<InstallResult> } {
    const calls: string[][] = []
    return {
      calls,
      run: (_profile, args) => {
        calls.push(args)
        if (args[0] === 'remove') rmSync(join(dir, 'node_modules', String(args[1])), { recursive: true, force: true })
        return Promise.resolve(ok)
      },
    }
  }

  function makeBridge(hostDeploy: string, name: string, target: string): string {
    const bridge = join(hostDeploy, 'node_modules', name)
    mkdirSync(dirname(bridge), { recursive: true })
    symlinkSync(target, bridge, process.platform === 'win32' ? 'junction' : 'dir')
    return bridge
  }

  // existsSync follows links, so a DANGLING link answers false; only lstat
  // says whether the link itself is still on disk.
  function linkPresent(path: string): boolean {
    try {
      lstatSync(path)
      return true
    } catch {
      return false
    }
  }

  it('drops the host-side bridge link of a package the post-install validation removed', async () => {
    const dir = writeProfile({ broken: 'github:o/broken' })
    // dsh manifest present but the built artifact is not → removed on the spot.
    writePkg(dir, 'broken', { dsh: {}, main: 'lib/index.js' })
    const hostDeploy = join(home, 'host-deploy')
    const bridge = makeBridge(hostDeploy, 'broken', join(dir, 'node_modules', 'broken'))
    const { calls, run } = removingRunner(dir)

    const { removedBroken } = await validateAddedPlugins(run, 'web', new Set(), undefined, hostDeploy)

    expect(removedBroken).toEqual(['broken'])
    expect(calls).toEqual([['remove', 'broken']])
    // The profile copy is gone (the runner removed it) and the host bridge
    // that pointed at it must not survive as a dangling link.
    expect(existsSync(join(dir, 'node_modules', 'broken'))).toBe(false)
    expect(linkPresent(bridge)).toBe(false)
  })

  it('derives the host node_modules root for both host layouts', () => {
    // CLI: the host package sits inside the shared install's node_modules.
    expect(hostNodeModulesRoot(join(home, 'prefix', 'node_modules', '@deepseek-ai', 'dsh')))
      .toBe(join(home, 'prefix', 'node_modules'))
    // Forward slashes (an Electron resourcesPath, a hand-written config)
    // must not defeat the tail check either.
    expect(hostNodeModulesRoot([home, 'prefix', 'node_modules', '@deepseek-ai', 'dsh'].join('/')))
      .toBe(join(home, 'prefix', 'node_modules'))
    // Flat Desktop (#662's <desktop-app>\dependencies\dsh): node_modules
    // lives beside the host package's own package.json.
    expect(hostNodeModulesRoot(join(home, 'app', 'dependencies', 'dsh')))
      .toBe(join(home, 'app', 'dependencies', 'dsh', 'node_modules'))
  })

  it('removes a dangling junction pointing at the uninstalled package', () => {
    const dir = writeProfile({})
    const pkg = join(dir, 'node_modules', 'pkg-gone')
    mkdirSync(pkg, { recursive: true })
    const hostDeploy = join(home, 'host-deploy')
    const bridge = makeBridge(hostDeploy, 'pkg-gone', pkg)
    rmSync(pkg, { recursive: true, force: true })

    expect(removeDanglingHostBridge('pkg-gone', dir, hostDeploy)).toBe(true)
    expect(linkPresent(bridge)).toBe(false)
  })

  it('matches the target case-insensitively on win32 (junctions keep the created case)', () => {
    const dir = writeProfile({})
    const pkg = join(dir, 'node_modules', 'pkg-case')
    mkdirSync(pkg, { recursive: true })
    const hostDeploy = join(home, 'host-deploy')
    // The projection stored an upper-case spelling of the same path.
    const cased = pkg.toUpperCase() === pkg ? pkg : pkg.toUpperCase()
    const bridge = makeBridge(hostDeploy, 'pkg-case', cased)
    rmSync(pkg, { recursive: true, force: true })

    expect(removeDanglingHostBridge('pkg-case', dir, hostDeploy)).toBe(process.platform === 'win32')
    expect(linkPresent(bridge)).toBe(process.platform !== 'win32')
  })

  it.runIf(canCreateSymlink('dir'))('removes a dangling directory symlink too (the other bridge form)', () => {
    const dir = writeProfile({})
    const pkg = join(dir, 'node_modules', 'pkg-link')
    mkdirSync(pkg, { recursive: true })
    const hostDeploy = join(home, 'host-deploy')
    const bridge = join(hostDeploy, 'node_modules', 'pkg-link')
    mkdirSync(dirname(bridge), { recursive: true })
    symlinkSync(pkg, bridge, 'dir')
    rmSync(pkg, { recursive: true, force: true })

    expect(removeDanglingHostBridge('pkg-link', dir, hostDeploy)).toBe(true)
    expect(linkPresent(bridge)).toBe(false)
  })

  it('keeps a real directory the host shipped there itself', () => {
    const dir = writeProfile({})
    const hostDeploy = join(home, 'host-deploy')
    const real = join(hostDeploy, 'node_modules', 'pkg-real')
    mkdirSync(real, { recursive: true })
    writeFileSync(join(real, 'package.json'), '{"name":"pkg-real"}')

    expect(removeDanglingHostBridge('pkg-real', dir, hostDeploy)).toBe(false)
    expect(existsSync(join(real, 'package.json'))).toBe(true)
  })

  it('keeps a link whose target is another profile (not this package)', () => {
    const dir = writeProfile({})
    const elsewhere = join(home, 'other-profile', 'node_modules', 'pkg-x')
    mkdirSync(elsewhere, { recursive: true })
    const hostDeploy = join(home, 'host-deploy')
    const bridge = makeBridge(hostDeploy, 'pkg-x', elsewhere)

    expect(removeDanglingHostBridge('pkg-x', dir, hostDeploy)).toBe(false)
    expect(linkPresent(bridge)).toBe(true)
  })

  it('keeps a live bridge while the profile package still exists', () => {
    // A remove that silently failed must not take a still-working
    // projection down with it. Alive follows the same manifest truth as
    // removeAndReconcile's gone-check: package.json present.
    const dir = writeProfile({})
    const pkg = join(dir, 'node_modules', 'pkg-live')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), '{"name":"pkg-live"}')
    const hostDeploy = join(home, 'host-deploy')
    const bridge = makeBridge(hostDeploy, 'pkg-live', pkg)

    expect(removeDanglingHostBridge('pkg-live', dir, hostDeploy)).toBe(false)
    expect(linkPresent(bridge)).toBe(true)
    expect(existsSync(pkg)).toBe(true)
  })

  it('removes the bridge when only package.json is gone but the directory lingers', () => {
    // The gone-check mirrors removeAndReconcile's: an uninstall that took
    // package.json but left stray files behind is still gone, and keeping
    // the bridge up would be exactly #662's dangling link.
    const dir = writeProfile({})
    const pkg = join(dir, 'node_modules', 'pkg-husk')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'stray.txt'), 'left behind by a partial remove')
    const hostDeploy = join(home, 'host-deploy')
    const bridge = makeBridge(hostDeploy, 'pkg-husk', pkg)

    expect(removeDanglingHostBridge('pkg-husk', dir, hostDeploy)).toBe(true)
    expect(linkPresent(bridge)).toBe(false)
    // The stray file itself is not ours to touch.
    expect(existsSync(join(pkg, 'stray.txt'))).toBe(true)
  })

  it('normalizes NT device prefixes and the UNC device form off link targets', () => {
    expect(normalizedLinkTarget('\\\\?\\C:\\profile\\node_modules\\pkg')).toBe('C:\\profile\\node_modules\\pkg')
    expect(normalizedLinkTarget('\\??\\C:\\profile\\node_modules\\pkg')).toBe('C:\\profile\\node_modules\\pkg')
    expect(normalizedLinkTarget('C:\\profile\\node_modules\\pkg')).toBe('C:\\profile\\node_modules\\pkg')
    // Stripped of the UNC device prefix the path would no longer be
    // absolute — it must be restored to the \\\\server\\share form instead.
    expect(normalizedLinkTarget('\\\\?\\UNC\\server\\share\\profile\\node_modules\\pkg')).toBe('\\\\server\\share\\profile\\node_modules\\pkg')
  })

  it('is a no-op when no host is locatable, and when no bridge exists', () => {
    const dir = writeProfile({})
    const hostDeploy = join(home, 'host-deploy')
    mkdirSync(join(hostDeploy, 'node_modules'), { recursive: true })
    expect(removeDanglingHostBridge('pkg-any', dir, null)).toBe(false)
    expect(removeDanglingHostBridge('pkg-any', dir, hostDeploy)).toBe(false)
  })
})

describe('naming the package pnpm actually refused (#944)', () => {
  it('reads the offender out of the violation line, scoped and plain', () => {
    expect(refusedReleaseAgePackage('  dshmarket@1.66.44 was published at 2026-10-19T18:21:57.000Z, within the cutoff'))
      .toEqual({ name: 'dshmarket', version: '1.66.44' })
    expect(refusedReleaseAgePackage('  @liustack/modsearch@5.10.9 was published at 2026-10-18T00:24:18.000Z'))
      .toEqual({ name: '@liustack/modsearch', version: '5.10.9' })
    // A prerelease keeps its whole version string.
    expect(refusedReleaseAgePackage('  dsh-cost-meter@1.9.6-rc.1 was published at 2026-10-19T18:21:57.000Z'))
      .toEqual({ name: 'dsh-cost-meter', version: '1.9.6-rc.1' })
    // The capture stops at the space: the timestamp and the cutoff on the same
    // line must never end up inside the version.
    expect(refusedReleaseAgePackage('  dsh-loop@1.2.0 was published at 2026-10-19T18:21:57.000Z')?.version)
      .toBe('1.2.0')
  })

  it('returns null rather than guessing when the output names no package', () => {
    // The whole point of the attribution is that a wrong name is worse than no
    // name — the caller keeps its existing wording when this is null.
    expect(refusedReleaseAgePackage('within the minimumReleaseAge cutoff (2026-10-19T06:02:25.725Z)')).toBeNull()
    expect(refusedReleaseAgePackage('  dshmarket was published at 2026-10-19T18:21:57.000Z')).toBeNull()
    expect(refusedReleaseAgePackage('')).toBeNull()
    // An unrelated package name that pnpm never attributed to a publish time.
    expect(refusedReleaseAgePackage('dsh-loop@1.2.0 could not be resolved')).toBeNull()
  })
})
