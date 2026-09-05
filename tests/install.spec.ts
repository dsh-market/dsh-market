/**
 * Install orchestration with a recording fake runner over real profile
 * fixtures: collection retargeting, the fake-success guard, and update
 * staleness detection (#22's silent no-op).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InstallResult } from '../src/dsh-cli.ts'
import {
  failureDetail, FETCH_TIMEOUT_OVERRIDE, groupConflictsByOwner, isStaleUpdate, parseIgnoredBuilds,
  parsePrepareNotAllowed, pnpmNeverStarted, retargetCollections, validateAddedPlugins, withHoistRecovery,
} from '../src/install.ts'
import { profileDir } from '../src/profile.ts'

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

describe('withHoistRecovery', () => {
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
