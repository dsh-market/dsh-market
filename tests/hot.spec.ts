/**
 * #58: the market's boot shim for client-only packages (dsh.client without
 * dsh.bundle) must NOT re-mount packages the USER's patch layer
 * (cordis.patch.yml) already manages — e.g. a plugin disabled through
 * dsh-web-plugin-manager. The shim subtree is independent of the patch
 * layer, so re-mounting overrides the user's "disabled" choice on every
 * restart. Reported with a verified fix by @vikna919.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { hotMount, hotUnmount, listHotMounts, mountClientOnlyDeps, parseSimplePatch, resolveProfileEntry } from '../src/hot.ts'
import { configurePersistentLog, readPersistentLog } from '../src/log.ts'

// The harness-vendored Include class is not importable in the unit lane;
// a minimal stand-in lets hotMount succeed so the skip logic is observable.
vi.mock('@deepseek-ai/cordis-plugin-include', () => ({
  Include: class {
    write(): void {}
    import(name: string): unknown { return { name, apply: () => {} } }
  },
}))

const ctx = { plugin: () => ({ await: () => Promise.resolve(), dispose: () => {} }) }

function clientOnlyPkg(dir: string, name: string): void {
  mkdirSync(join(dir, 'node_modules', name), { recursive: true })
  writeFileSync(join(dir, 'node_modules', name, 'package.json'),
    JSON.stringify({ name, dsh: { client: './client.js' } }))
}

afterEach(async () => {
  for (const name of listHotMounts()) await hotUnmount(name)
})

describe('hotMount finds a patch the package declares in a subdirectory (#646)', () => {
  it('reads dsh.bundle.patch wherever it points, instead of only the package root', async () => {
    // The reported shape: `aegis` declares `./extensions/dsh/cordis.patch.yml`,
    // so the package root holds no cordis.patch.yml at all. Reading only the
    // root found nothing, fell through to the `dsh.client` check, and told a
    // user whose package plainly HAS a bundle patch that there was "nothing
    // to hot-mount" — a message about our lookup, not about their package.
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    try {
      const pkg = join(dir, 'node_modules', 'subpath-patch')
      mkdirSync(join(pkg, 'extensions', 'dsh'), { recursive: true })
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({
        name: 'subpath-patch',
        dsh: { bundle: { patch: './extensions/dsh/cordis.patch.yml' } },
      }))
      writeFileSync(join(pkg, 'extensions', 'dsh', 'cordis.patch.yml'),
        '- insert:\n    - id: subpath-patch-host\n      name: subpath-patch/dist/host.js\n')

      const result = await hotMount(ctx, dir, 'subpath-patch')
      expect(result.ok).toBe(true)
      expect(result.reason).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still reads the package-root cordis.patch.yml when nothing is declared', async () => {
    // The long-standing convention must keep working: this is the shape most
    // bundles ship, and it has no manifest field at all.
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    try {
      const pkg = join(dir, 'node_modules', 'root-patch')
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'root-patch' }))
      writeFileSync(join(pkg, 'cordis.patch.yml'),
        '- insert:\n    - id: root-patch-host\n      name: root-patch\n')

      const result = await hotMount(ctx, dir, 'root-patch')
      expect(result.ok).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still reports a package with neither a patch nor a client surface', async () => {
    // The message the reporter saw must survive for the packages it is
    // actually true of — a bare dependency with no dsh surface at all.
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    try {
      const pkg = join(dir, 'node_modules', 'plain-lib')
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'plain-lib' }))

      const result = await hotMount(ctx, dir, 'plain-lib')
      expect(result.ok).toBe(false)
      expect(String(result.reason)).toContain('无 bundle patch')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * #792: the host composes an ARRAY `dsh.bundle.patch` in order, so hotMount
 * must read EVERY declared file, not just a string — an array declaration
 * used to read as "no patch at all" and the user was told there was nothing
 * to hot-mount for a package that plainly has patches.
 */
describe('hotMount reads every declared patch file (#792)', () => {
  function target(dir: string, name: string): void {
    const pkg = join(dir, 'node_modules', name)
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, main: 'index.js' }))
    writeFileSync(join(pkg, 'index.js'), '')
  }

  function carrier(dir: string, name: string, patch: unknown, files: Record<string, string>): void {
    const pkg = join(dir, 'node_modules', name)
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, dsh: { bundle: { patch } } }))
    for (const [rel, text] of Object.entries(files)) writeFileSync(join(pkg, rel), text)
  }

  /** The hot input files still on disk, concatenated. */
  function mountedRows(dir: string): string {
    try {
      return readdirSync(join(dir, '.dsh-market'))
        .filter(file => /^hot-\d+\.yml$/.test(file))
        .map(file => readFileSync(join(dir, '.dsh-market', file), 'utf8'))
        .join('')
    } catch {
      return ''
    }
  }

  it('writes valid hot-mount YAML when the profile path contains an apostrophe (#1027)', async () => {
    const dir = mkdtempSync(join(tmpdir(), "dshm-hot-o'k-"))
    try {
      const name = 'quoted-plugin'
      target(dir, name)
      carrier(dir, 'quoted-carrier', './cordis.patch.yml', {
        'cordis.patch.yml': `- insert:\n    - id: it's-quoted\n      name: ${name}\n`,
      })
      const result = await hotMount(ctx, dir, 'quoted-carrier')
      expect(result.ok).toBe(true)
      // The mocked Include never parses the generated YAML.
      expect(mountedRows(dir)).toContain("o''k-")
      expect(load(mountedRows(dir))).toEqual([{
        id: "mkt-it's-quoted",
        name: resolveProfileEntry(dir, name),
      }])
    } finally {
      for (const mounted of listHotMounts()) await hotUnmount(mounted)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('mounts rows from every file of an array declaration, in order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    try {
      target(dir, 'dep-a')
      target(dir, 'dep-b')
      carrier(dir, 'array-carrier', ['./a.patch.yml', './b.patch.yml'], {
        'a.patch.yml': '- insert:\n    - id: arr-a\n      name: dep-a\n',
        'b.patch.yml': '- insert:\n    - id: arr-b\n      name: dep-b\n',
      })

      const result = await hotMount(ctx, dir, 'array-carrier')
      expect(result.ok).toBe(true)
      // Both files contributed, in declaration order, into ONE input file.
      const rows = readdirSync(join(dir, '.dsh-market'))
        .filter(file => /^hot-\d+\.yml$/.test(file))
        .map(file => readFileSync(join(dir, '.dsh-market', file), 'utf8'))
        .find(text => text.includes('mkt-arr-a'))
      expect(rows).toBeDefined()
      expect(rows!.indexOf('mkt-arr-b')).toBeGreaterThan(rows!.indexOf('mkt-arr-a'))
    } finally {
      for (const name of listHotMounts()) await hotUnmount(name)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a carrier whose declared list names a missing file', async () => {
    // All or nothing, same rule as readBundlePatchRows: the host drops the
    // entire bundle when one declared overlay file is missing, so nothing
    // of this package may go live off the readable remainder.
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    try {
      target(dir, 'dep-b')
      carrier(dir, 'partial-carrier', ['./gone.patch.yml', './b.patch.yml'], {
        'b.patch.yml': '- insert:\n    - id: arr-b\n      name: dep-b\n',
      })

      const result = await hotMount(ctx, dir, 'partial-carrier')
      expect(result.ok).toBe(false)
      expect(String(result.reason)).toContain('声明的 patch 文件缺失')
      expect(mountedRows(dir)).not.toContain('mkt-arr-b')
    } finally {
      for (const name of listHotMounts()) await hotUnmount(name)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * #1010: a refusal that only says "this comes up on a start" must be told
 * apart from a mount that was tried and failed — the toggle route persists the
 * first and refuses to persist the second (#575).
 */
describe('hotMount: restart-only versus failed', () => {
  function bundle(dir: string, name: string, patch: string | null): void {
    const pkg = join(dir, 'node_modules', name)
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    if (patch !== null) writeFileSync(join(pkg, 'cordis.patch.yml'), patch)
  }

  it('marks a patch with disables or config as deferred, not as a crash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    try {
      bundle(dir, 'swapper', '- id: ui-chat\n  disabled: true\n- insert:\n    - id: swap-chat\n      name: swapper\n')
      const result = await hotMount(ctx, dir, 'swapper')
      expect(result.ok).toBe(false)
      expect(result.deferred).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // #1102: the refusal used to name a config block for every shape it could
  // not replay, including this one — where nothing is configured and the
  // plugin (like dsh-mnemon) only switches an existing row off.
  it('names the switched-off row instead of inventing a config block', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    try {
      bundle(dir, 'swapper', '- id: ui-chat\n  disabled: true\n- insert:\n    - id: swap-chat\n      name: swapper\n')
      const result = await hotMount(ctx, dir, 'swapper')
      expect(String(result.reason)).toContain('disabled')
      expect(String(result.reason)).not.toContain('config')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not mark an unreadable declaration as deferred — no restart can load it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    try {
      bundle(dir, 'broken', null)
      const result = await hotMount(ctx, dir, 'broken')
      expect(result.ok).toBe(false)
      expect(result.deferred).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('mountClientOnlyDeps vs the user patch layer (#58)', () => {
  it('skips packages cordis.patch.yml already manages; still shims unmanaged ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        dependencies: {
          '@deepseek-ai/dsh-client-ui-aqua': '^1.0.0',
          'dsh-free-plugin': '^1.0.0',
        },
      }))
      clientOnlyPkg(dir, '@deepseek-ai/dsh-client-ui-aqua')
      clientOnlyPkg(dir, 'dsh-free-plugin')
      // A plugin-manager disable row (id follows its slugify convention:
      // strip @, non-alphanumerics → '-', lowercase). The user turned the
      // plugin OFF — the market must leave it to the patch layer.
      writeFileSync(join(dir, 'cordis.patch.yml'),
        '- id: deepseek-ai-dsh-client-ui-aqua\n  disabled: true\n')

      const mounted = await mountClientOnlyDeps(ctx, dir)
      expect(mounted).toContain('dsh-free-plugin')
      expect(mounted).not.toContain('@deepseek-ai/dsh-client-ui-aqua')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * #1137: a client-only package can ALSO be mounted by the profile's own
 * bundle layer, under a row id that only that bundle decides. It carries
 * `dsh.client` and no `dsh.bundle` all the same, so every shim predicate says
 * "shim it" — and the second fiber registers the same services again, which
 * cordis refuses. The host logged `1 entry did not activate` while the market
 * logged `live (client-only shim)`: the two halves disagreed about the same
 * mount, and the market's record is the one the UI shows.
 */
describe('mountClientOnlyDeps vs packages the bundle layer already mounts (#1137)', () => {
  /** A bundle package that mounts `target` under a row id of its own. */
  function bundlePkg(dir: string, bundle: string, rows: string): void {
    const root = join(dir, 'node_modules', ...bundle.split('/'))
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: bundle,
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(root, 'cordis.patch.yml'), rows)
  }

  it('skips a package an in-box bundle already mounts; still shims the ones it does not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        dependencies: {
          // The shape from the report: a peer dependency of an uninstalled
          // plugin, linked into the profile so it resolves.
          '@deepseek-ai/dsh-client-connection': 'link:./host/node_modules/@deepseek-ai/dsh-client-connection',
          'dsh-free-plugin': '^1.0.0',
        },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } },
      }))
      clientOnlyPkg(dir, '@deepseek-ai/dsh-client-connection')
      clientOnlyPkg(dir, 'dsh-free-plugin')
      // The row id is `connection`, not the package name — looking entries up
      // by name is exactly what used to miss this.
      bundlePkg(dir, '@deepseek-ai/dsh-web-app',
        "- id: connection\n  name: '@deepseek-ai/dsh-client-connection'\n  inject: [webStartup]\n")

      const mounted = await mountClientOnlyDeps(ctx, dir)
      expect(mounted).not.toContain('@deepseek-ai/dsh-client-connection')
      expect(mounted).toContain('dsh-free-plugin')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the declared patch file, and does not count a commented-out row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        dependencies: { 'dsh-real-plugin': '^1.0.0', 'dsh-commented-plugin': '^1.0.0' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } },
      }))
      clientOnlyPkg(dir, 'dsh-real-plugin')
      clientOnlyPkg(dir, 'dsh-commented-plugin')
      bundlePkg(dir, '@deepseek-ai/dsh-web-app',
        "- insert:\n    - id: real\n      name: dsh-real-plugin\n"
        + "# - id: commented\n#   name: dsh-commented-plugin\n")

      const mounted = await mountClientOnlyDeps(ctx, dir)
      expect(mounted).not.toContain('dsh-real-plugin')
      // A row that is only a comment mounts nothing, so the shim is still the
      // only thing that makes this package's client bundle reachable.
      expect(mounted).toContain('dsh-commented-plugin')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('hotMount activation timeout guard', () => {
  it('falls back to restart and disposes the subtree when activation never settles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    try {
      clientOnlyPkg(dir, 'dsh-wedged-plugin')
      let disposed = false
      // A fiber waiting on a service that never arrives: await() never
      // settles. Without the guard the route hangs forever — its
      // `finally { installing = false }` never runs and every later install/
      // update/uninstall gets 409'd until a host restart.
      const wedgedCtx = {
        plugin: () => ({
          await: () => new Promise<never>(() => {}),
          dispose: () => { disposed = true },
        }),
      }
      vi.useFakeTimers()
      const pending = hotMount(wedgedCtx, dir, 'dsh-wedged-plugin')
      const assertion = pending.then(result => {
        expect(result.ok).toBe(false)
        expect(result.reason).toContain('did not settle')
        expect(disposed).toBe(true)
        expect(listHotMounts()).not.toContain('dsh-wedged-plugin')
      })
      await vi.advanceTimersByTimeAsync(10000)
      await assertion
    } finally {
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('mountClientOnlyDeps vs the persisted disable list (#60)', () => {
  it('skips client-only packages the user switched off; still shims enabled ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        dependencies: {
          'dsh-free-plugin': '^1.0.0',
          'dsh-off-plugin': '^1.0.0',
        },
      }))
      clientOnlyPkg(dir, 'dsh-free-plugin')
      clientOnlyPkg(dir, 'dsh-off-plugin')
      // A previous session toggled dsh-off-plugin off; the boot shim must
      // not bring its fiber back up on the next start.
      mkdirSync(join(dir, '.dsh-market'), { recursive: true })
      writeFileSync(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ disabled: ['dsh-off-plugin'] }))

      const mounted = await mountClientOnlyDeps(ctx, dir)
      expect(mounted).toContain('dsh-free-plugin')
      expect(mounted).not.toContain('dsh-off-plugin')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * parseSimplePatch decides whether an install activates NOW or only after a
 * restart: it accepts a patch of plain `id`/`name` insert rows and returns
 * null for anything richer, because hot-mounting cannot replay config
 * overrides, disables or `!!js` expressions. Users meet this as
 * "the bundle patch contains config/expression rows — it activates on
 * restart", so the boundary between the two answers is the contract.
 *
 * It had no direct test; a mutation audit could break five of its
 * conditions without a single spec noticing.
 */
describe('parseSimplePatch — hot-mountable or restart-only', () => {
  const rows = (...lines: string[]): string => lines.join('\n')

  it('accepts plain insert rows, one or many', () => {
    expect(parseSimplePatch(rows(
      '- insert:',
      '    - id: alpha',
      '      name: pkg-alpha',
    ))).toEqual([{ id: 'alpha', name: 'pkg-alpha' }])

    expect(parseSimplePatch(rows(
      '- insert:',
      '    - id: alpha',
      '      name: pkg-alpha',
      '    - id: beta',
      '      name: "pkg-beta"',
    ))).toEqual([{ id: 'alpha', name: 'pkg-alpha' }, { id: 'beta', name: 'pkg-beta' }])
  })

  it('ignores comments and blank lines rather than refusing them', () => {
    expect(parseSimplePatch(rows(
      '# what this patch does',
      '',
      '- insert:',
      '    - id: alpha    # the row id',
      '      name: pkg-alpha',
      '',
    ))).toEqual([{ id: 'alpha', name: 'pkg-alpha' }])
  })

  it('refuses anything hot-mount cannot replay', () => {
    // A config override on the inserted row.
    expect(parseSimplePatch(rows(
      '- insert:',
      '    - id: alpha',
      '      name: pkg-alpha',
      '      config:',
      '        verbose: true',
    ))).toBeNull()

    // A row targeting somebody else's entry.
    expect(parseSimplePatch(rows(
      '- insert:',
      '    - id: alpha',
      '      name: pkg-alpha',
      '- id: attachment-local',
      '  config:',
      '    maxImageBytes: 1',
    ))).toBeNull()

    // A disable row.
    expect(parseSimplePatch(rows(
      '- insert:',
      '    - id: alpha',
      '      name: pkg-alpha',
      '- id: other',
      '  disabled: true',
    ))).toBeNull()

    // An expression: never replayed blind.
    expect(parseSimplePatch(rows(
      '- insert:',
      '    - id: alpha',
      '      name: !!js/eval process.env.PKG',
    ))).toBeNull()
  })

  it('refuses half-formed insert rows instead of guessing', () => {
    // id with no name following.
    expect(parseSimplePatch(rows('- insert:', '    - id: alpha'))).toBeNull()
    // two ids in a row: the first would silently lose its name.
    expect(parseSimplePatch(rows(
      '- insert:',
      '    - id: alpha',
      '    - id: beta',
      '      name: pkg-beta',
    ))).toBeNull()
    // a name with no id above it.
    expect(parseSimplePatch(rows('- insert:', '      name: pkg-alpha'))).toBeNull()
  })

  it('reads a patch authored on Windows the same as one authored on Unix', () => {
    // CRLF is not cosmetic here. `#.*$` cannot strip a comment that ends in
    // \r — JS stops `.` at a line terminator and `$` only anchors at the end
    // — so the comment text survived, matched no row shape, and failed the
    // whole patch. Every plugin whose cordis.patch.yml was written on
    // Windows then read as "contains config/expression rows" and could
    // never hot-mount, on any platform. Found by running layer 3 on Windows.
    const unix = rows(
      '# what this patch does',
      '- insert:',
      '    - id: alpha',
      '      name: pkg-alpha',
      '',
    )
    const expected = [{ id: 'alpha', name: 'pkg-alpha' }]
    expect(parseSimplePatch(unix)).toEqual(expected)
    expect(parseSimplePatch(unix.replace(/\n/g, '\r\n'))).toEqual(expected)
  })

  it('refuses an empty patch — there is nothing to mount', () => {
    expect(parseSimplePatch('')).toBeNull()
    expect(parseSimplePatch('# only a comment\n\n')).toBeNull()
    expect(parseSimplePatch('- insert:\n')).toBeNull()
  })
})

/**
 * Hot-mount rows must reach the loader as absolute file:// URLs resolved
 * against the profile the package was installed into.
 *
 * The include tree's base class resolves bare names against the LOADER's own
 * location — the host closure — whose parent walk can never reach
 * `home/profiles/<profile>/node_modules`. On any closure-hosted loader
 * (Ellamaka, DSH Desktop sidecar) every market hot mount died with
 * `Cannot find module '<pkg>' from '…/cordis-plugin-loader/…'` and fell back
 * to a restart the host did not even need: the bundle layer + a composition
 * replay had usually already mounted the plugin.
 */
describe('resolveProfileEntry — hot-mount rows are anchored at the profile', () => {
  /** A bundle-plugin package shape: main + lib/index.js on disk (the shape
   * every hot-mountable plugin carries — install validation, which runs
   * before hotMount, requires a checkable entry artifact). */
  function bundlePkg(dir: string, name: string): void {
    const pkgDir = join(dir, 'node_modules', name)
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'),
      JSON.stringify({ name, main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(pkgDir, 'lib', 'index.js'), 'export default {}')
  }

  it('resolves a bare package name to the profile-installed entry URL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    try {
      bundlePkg(dir, 'dsh-real-plugin')
      const resolved = resolveProfileEntry(dir, 'dsh-real-plugin')
      expect(resolved.startsWith('file://')).toBe(true)
      expect(resolved).toContain('dsh-real-plugin')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves a scoped package name the same way', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    try {
      bundlePkg(dir, join('@scope', 'pkg'))
      const resolved = resolveProfileEntry(dir, '@scope/pkg')
      expect(resolved.startsWith('file://')).toBe(true)
      expect(resolved).toContain('@scope')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('passes through specifiers the base class owns', () => {
    expect(resolveProfileEntry('/any', '')).toBe('')
    expect(resolveProfileEntry('/any', './relative.js')).toBe('./relative.js')
    expect(resolveProfileEntry('/any', 'cordis:include')).toBe('cordis:include')
    expect(resolveProfileEntry('/any', 'file:///already/absolute.js')).toBe('file:///already/absolute.js')
  })

  it('keeps the bare name when the package is not installed under the profile', () => {
    // Base-class semantics for shapes this fix does not own: an unresolvable
    // name reaches the loader unchanged and its error surfaces as before.
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    try {
      expect(resolveProfileEntry(dir, 'dsh-not-installed')).toBe('dsh-not-installed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * A failed hot mount must leave NOTHING behind. The dispose covers the
 * subtree; the input file removal matters because `cleanHotDir` only runs at
 * market START — a file left by a mid-session failure stays on disk until
 * the next restart, and on a closure-hosted loader it re-throws the same
 * resolve error on every later composition replay that imports it. On the
 * reporting host this grew the plugin log by millions of repeated errors
 * between restarts.
 */
describe('failed hotMount cleanup — no leftover file, no wedged fiber', () => {
  it('removes the hot input file when the import fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    try {
      // A package whose host half exists but fails to load: the stand-in
      // Include.import throws for anything not pre-registered.
      vi.doMock('@deepseek-ai/cordis-plugin-include', () => ({
        Include: class {
          write(): void {}
          import(name: string): unknown {
            if (name.includes('dsh-doomed-plugin')) throw new Error('Cannot find module')
            return { name, apply: () => {} }
          }
        },
      }))
      vi.resetModules()
      const { hotMount: freshHotMount, listHotMounts: freshList } = await import('../src/hot.ts')
      mkdirSync(join(dir, 'node_modules', 'dsh-doomed-plugin'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'dsh-doomed-plugin', 'package.json'),
        JSON.stringify({ name: 'dsh-doomed-plugin', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
      writeFileSync(join(dir, 'node_modules', 'dsh-doomed-plugin', 'cordis.patch.yml'),
        '- insert:\n    - id: doomed\n      name: dsh-doomed-plugin\n')
      const failCtx = { plugin: () => ({ await: () => Promise.reject(new Error('Cannot find module')), dispose: () => {} }) }
      const result = await freshHotMount(failCtx, dir, 'dsh-doomed-plugin')
      expect(result.ok).toBe(false)
      const hotFiles = readdirSync(join(dir, '.dsh-market')).filter(f => f.startsWith('hot-'))
      expect(hotFiles).toEqual([])
      expect(freshList()).not.toContain('dsh-doomed-plugin')
    } finally {
      vi.doUnmock('@deepseek-ai/cordis-plugin-include')
      vi.resetModules()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a teardown that never finishes cannot hold the market open (#582)', () => {
  /** Mount one client-only package through the stand-in inclusion plugin. */
  async function mounted(dir: string, name: string, plugin: (options?: unknown) => unknown): Promise<void> {
    clientOnlyPkg(dir, name)
    writeFileSync(join(dir, 'cordis.patch.yml'), `- insert:\n    - id: ${name}\n      name: '${name}'\n`)
    const result = await hotMount({ plugin } as never, dir, name)
    expect(result.ok).toBe(true)
  }

  it('gives up on a hanging teardown at the same ceiling as mounting, and says it could not be confirmed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    vi.useFakeTimers()
    const logFile = join(dir, 'log.ndjson')
    configurePersistentLog(logFile)
    const logged = (): string => readPersistentLog(logFile).join('\n')
    try {
      let rejectsLate: (error: unknown) => void = () => {}
      await mounted(dir, 'stuck-plugin', () => ({
        await: () => Promise.resolve(),
        dispose: () => new Promise<void>((_resolve, reject) => { rejectsLate = reject }),
      }))
      const pending = hotUnmount('stuck-plugin')
      // Not resolved yet: the teardown is still hanging.
      let settled: boolean | null = null
      void pending.then(value => { settled = value })
      await vi.advanceTimersByTimeAsync(5000)
      expect(settled).toBeNull()
      await vi.advanceTimersByTimeAsync(6000)
      expect(await pending).toBe(false)
      // The package is no longer registered, so a later attempt starts clean
      // rather than reusing a handle already being disposed.
      expect(listHotMounts()).not.toContain('stuck-plugin')
      expect(logged()).toContain('could not be confirmed stopped')
      // A late settlement is reported, not thrown: this rejection arrives
      // after the market has already answered.
      rejectsLate(new Error('teardown finally gave up'))
      await vi.advanceTimersByTimeAsync(0)
      expect(logged()).toContain('dispose failed after the wait')
    } finally {
      configurePersistentLog(null)
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still reports a teardown that fails at once, and one that succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    try {
      await mounted(dir, 'failing-plugin', () => ({ await: () => Promise.resolve(), dispose: () => Promise.reject(new Error('nope')) }))
      expect(await hotUnmount('failing-plugin')).toBe(false)
      await mounted(dir, 'fine-plugin', () => ({ await: () => Promise.resolve(), dispose: () => {} }))
      expect(await hotUnmount('fine-plugin')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
