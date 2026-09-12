/**
 * #58: the market's boot shim for client-only packages (dsh.client without
 * dsh.bundle) must NOT re-mount packages the USER's patch layer
 * (cordis.patch.yml) already manages — e.g. a plugin disabled through
 * dsh-web-plugin-manager. The shim subtree is independent of the patch
 * layer, so re-mounting overrides the user's "disabled" choice on every
 * restart. Reported with a verified fix by @vikna919.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hotMount, hotUnmount, listHotMounts, mountClientOnlyDeps, parseSimplePatch } from '../src/hot.ts'

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
        expect(result.outcome).toBe('deferred')
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

// Test the production classification, with failure injected at handle.await.
describe('hotMount outcomes (#575)', () => {
  it('distinguishes a rejected apply from a live mount and restart-only patch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-'))
    try {
      clientOnlyPkg(dir, 'dsh-outcome')
      const rejected = await hotMount({ plugin: () => ({ await: async () => { throw new Error('apply rejected') }, dispose: () => {} }) }, dir, 'dsh-outcome')
      expect(rejected).toMatchObject({ ok: false, outcome: 'failed' })
      expect(rejected.reason).not.toContain('restart required')
      expect(listHotMounts()).not.toContain('dsh-outcome')
      expect(await hotMount(ctx, dir, 'dsh-outcome')).toMatchObject({ ok: true, outcome: 'live' })
      await hotUnmount('dsh-outcome')
      writeFileSync(join(dir, 'node_modules/dsh-outcome/cordis.patch.yml'), '- id: other\n  config:\n    limit: 7\n')
      expect(await hotMount(ctx, dir, 'dsh-outcome')).toMatchObject({ ok: false, outcome: 'deferred' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
