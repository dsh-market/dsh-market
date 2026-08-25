/**
 * Patch-layer toggles (port of Noob-stupid/dsh-plugin-hub):
 *
 * - disabling a row = appending `- id: X` + `disabled: true` to the
 *   profile's user patch layer (cordis.patch.yml), which DSH's HMR
 *   re-composes within ~1s and the loader re-applies on every boot;
 * - enabling = removing that block, or force-enabling with `disabled: false`
 *   when a lower layer holds the row down;
 * - appends are refused when the patch file is not a valid entry list (a
 *   malformed file is never made worse), and the dsh template's empty `[]`
 *   placeholder is commented out instead of being appended after.
 */

import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  carrierDisableIds, disableRow, enableRow, findUserPatchPath, isProtectedModule, packagePatchFlags,
  readUserPatchState, removeRowBlocks, rowIdsForPackage, userPatchPackageReferences, type PatchHost,
} from '../src/patch.ts'

function patchDir(): string {
  return mkdtempSync(join(tmpdir(), 'dshm-patch-'))
}

function readPatch(dir: string): string {
  return readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
}

const emptyHost: PatchHost = { loader: { entries: () => [] } }

describe('readUserPatchState', () => {
  it('scans disables, forced rows and insert ids', () => {
    const dir = patchDir()
    try {
      writeFileSync(join(dir, 'cordis.patch.yml'), [
        '# header',
        '- insert:',
        '    - id: workbench',
        "      name: 'dsh-excel-chat'",
        '- id: schedule',
        '  disabled: true',
        '- id: skins',
        '  disabled: false',
        '',
      ].join('\n'))
      const state = readUserPatchState(join(dir, 'cordis.patch.yml'))
      expect(state.disables).toEqual(['schedule'])
      expect(state.forced).toEqual(['skins'])
      expect(state.inserts).toEqual(['workbench'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns empty state for a missing file', () => {
    const dir = patchDir()
    try {
      expect(readUserPatchState(join(dir, 'cordis.patch.yml'))).toEqual({ disables: [], forced: [], inserts: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('userPatchPackageReferences', () => {
  it('finds exact package and exported-subpath inserts without prefix collisions', () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, [
        '- insert:',
        '    - id: exact',
        '      name: dsh-loop',
        '    - id: subpath',
        "      name: 'dsh-loop/runtime'",
        '    - id: scoped',
        '      name: "@scope/plugin/client"',
        '    - id: neighbour',
        '      name: dsh-loop-extra',
        '',
      ].join('\n'))

      expect(userPatchPackageReferences(patch, 'dsh-loop')).toEqual(['dsh-loop', 'dsh-loop/runtime'])
      expect(userPatchPackageReferences(patch, '@scope/plugin')).toEqual(['@scope/plugin/client'])
      expect(userPatchPackageReferences(patch, 'missing')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores nested config names and rows after the insert block', () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, [
        '- insert:',
        '  - id: workbench',
        '    name: real-plugin',
        '    config:',
        '      name: nested-config-value',
        '  - id: array-options',
        '    name: options-plugin',
        '    config:',
        '      - name: nested-array-value',
        '- config:',
        '    name: later-top-level-value',
        '',
      ].join('\n'))

      expect(userPatchPackageReferences(patch, 'real-plugin')).toEqual(['real-plugin'])
      expect(userPatchPackageReferences(patch, 'nested-config-value')).toEqual([])
      expect(userPatchPackageReferences(patch, 'nested-array-value')).toEqual([])
      expect(userPatchPackageReferences(patch, 'later-top-level-value')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recognizes flow-style inserts and loader entries nested in a group', () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, '[{ insert: [{ id: flow, name: dsh-loop/runtime }] }]\n')
      expect(userPatchPackageReferences(patch, 'dsh-loop')).toEqual(['dsh-loop/runtime'])

      writeFileSync(patch, [
        '- insert:',
        '    - id: group',
        '      name: cordis:group',
        '      group: true',
        '      config:',
        '        - id: child',
        '          name: dsh-loop/child',
        '',
      ].join('\n'))
      expect(userPatchPackageReferences(patch, 'dsh-loop')).toEqual(['dsh-loop/child'])

      writeFileSync(patch, '- insert:\n    - id: empty-group\n      name: cordis:group\n      group: true\n')
      expect(userPatchPackageReferences(patch, 'dsh-loop')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports an existing malformed patch as indeterminate', () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, '- insert:\n    - id: broken\n      name: [\n')
      expect(userPatchPackageReferences(patch, 'dsh-loop')).toBeNull()
      writeFileSync(patch, '- insert: { id: wrong-shape, name: dsh-loop }\n')
      expect(userPatchPackageReferences(patch, 'dsh-loop')).toBeNull()
      writeFileSync(patch, '- dsh-loop\n')
      expect(userPatchPackageReferences(patch, 'dsh-loop')).toBeNull()
      writeFileSync(patch, '')
      expect(userPatchPackageReferences(patch, 'dsh-loop')).toBeNull()
      writeFileSync(patch, '# no valid top-level list yet\n')
      expect(userPatchPackageReferences(patch, 'dsh-loop')).toBeNull()
      writeFileSync(patch, [
        '- insert: &entries',
        '    - id: cyclic-group',
        '      name: cordis:group',
        '      group: true',
        '      config: *entries',
        '',
      ].join('\n'))
      expect(userPatchPackageReferences(patch, 'dsh-loop')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats a missing patch and the template [] placeholder as no references', () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      expect(userPatchPackageReferences(patch, 'dsh-loop')).toEqual([])
      writeFileSync(patch, '# no user entries yet\n[]\n')
      expect(userPatchPackageReferences(patch, 'dsh-loop')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a non-file patch path as unreadable', () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      mkdirSync(patch)
      expect(userPatchPackageReferences(patch, 'dsh-loop')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('disableRow / enableRow', () => {
  it('appends the disabled block and is idempotent', async () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      const first = await disableRow(patch, 'workbench')
      expect(first.ok).toBe(true)
      expect(readPatch(dir)).toBe('- id: workbench\n  disabled: true\n')
      const again = await disableRow(patch, 'workbench')
      expect(again.ok).toBe(true)
      expect(readPatch(dir)).toBe('- id: workbench\n  disabled: true\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enable removes the disable block; appends disabled:false when nothing was removed', async () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      await disableRow(patch, 'workbench')
      const on = await enableRow(patch, 'workbench')
      expect(on.ok).toBe(true)
      // `[]`, not an empty file: dsh parses this file on every boot and
      // rejects anything that is not an array — and `yaml.load('')` is
      // undefined, so an emptied file bricks the profile just as surely as
      // a comments-only one did.
      expect(readPatch(dir)).toBe('[]\n')

      // No user-disable block: force-enable with disabled:false (covers rows
      // a lower layer — the bundle patch — disabled). The placeholder is
      // commented out rather than appended after, as for the dsh template.
      const forced = await enableRow(patch, 'workbench')
      expect(forced.ok).toBe(true)
      expect(readPatch(dir)).toBe('# []\n- id: workbench\n  disabled: false\n')
      // Already forced: no-op, file untouched.
      const again = await enableRow(patch, 'workbench')
      expect(again.ok).toBe(true)
      expect(readPatch(dir)).toBe('# []\n- id: workbench\n  disabled: false\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a disable after a force leaves both rows; composition resolves to disabled', async () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      await enableRow(patch, 'workbench')
      await disableRow(patch, 'workbench')
      const text = readPatch(dir)
      expect(text).toContain('disabled: false')
      expect(text).toContain('disabled: true')
      const state = readUserPatchState(patch)
      expect(state.forced).toEqual(['workbench'])
      expect(state.disables).toEqual(['workbench'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('appends after a comments-only file', async () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, '# my patch layer\n')
      const result = await disableRow(patch, 'workbench')
      expect(result.ok).toBe(true)
      expect(readPatch(dir)).toBe('# my patch layer\n- id: workbench\n  disabled: true\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('appends to a file missing a trailing newline', async () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, '- id: other\n  disabled: true')
      await disableRow(patch, 'workbench')
      const text = readPatch(dir)
      expect(text.startsWith('- id: other\n  disabled: true\n')).toBe(true)
      expect(text).toContain('- id: workbench\n  disabled: true\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the dsh template `[]` placeholder', () => {
  it('is commented out, keeping the header, before the block is appended', async () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, [
        '# Your patch layer for this dsh profile, applied after every bundle layer:',
        '# a top-level YAML array of loader patch entries.',
        '[]',
      ].join('\n'))
      const result = await disableRow(patch, 'workbench')
      expect(result.ok).toBe(true)
      const text = readPatch(dir)
      expect(text).toContain('# []\n')
      expect(text).toContain('- id: workbench\n  disabled: true\n')
      // The result must parse as ONE valid entry list (the `[]` + items
      // mistake from the real-world YAML error).
      expect(text.match(/^- /gm)).not.toBeNull()
      expect(text.split('\n').filter(line => /^- /u.test(line))).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('append safety on malformed patch files', () => {
  it('refuses to append when the file is not a valid entry list and leaves it untouched', async () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      // The exact break a hand-edit produces: a flow `[]` plus a block item
      // in the same document.
      const broken = '[]\n- id: workbench\n  disabled: true\n'
      writeFileSync(patch, broken)
      const result = await disableRow(patch, 'schedule')
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/refus/i)
      expect(readPatch(dir)).toBe(broken)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses to append after a top-level flow list', async () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, '[1, 2]\n')
      const result = await disableRow(patch, 'workbench')
      expect(result.ok).toBe(false)
      expect(readPatch(dir)).toBe('[1, 2]\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('appends after a block item whose VALUE is flow style', async () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, '- config: [1, 2]\n')
      const result = await disableRow(patch, 'workbench')
      expect(result.ok).toBe(true)
      const text = readPatch(dir)
      expect(text).toContain('- config: [1, 2]\n')
      expect(text).toContain('- id: workbench\n  disabled: true\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('removeRowBlocks', () => {
  it('removes both disable and force blocks for the given rows', () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, '- id: a\n  disabled: true\n- id: b\n  disabled: false\n- id: keep\n  disabled: true\n')
      removeRowBlocks(patch, ['a', 'b'])
      expect(readPatch(dir)).toBe('- id: keep\n  disabled: true\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('isProtectedModule', () => {
  it('flags host infrastructure and lets community plugins pass', () => {
    expect(isProtectedModule('cordis:timer')).toBe(true)
    expect(isProtectedModule('@deepseek-ai/dsh-host-webserver')).toBe(true)
    expect(isProtectedModule('@deepseek-ai/dsh-client-runtime')).toBe(true)
    expect(isProtectedModule('@deepseek-ai/dsh-web-app')).toBe(true)
    expect(isProtectedModule('dsh-loop')).toBe(false)
    expect(isProtectedModule(undefined)).toBe(false)
  })
})

describe('findUserPatchPath', () => {
  it('prefers the path the cordis:include entry read', () => {
    const host: PatchHost = {
      loader: {
        entries: () => [{
          options: { id: 'include', name: 'cordis:include', config: { path: 'file:///home/u/.dsh/profiles/web/cordis.yml' } },
        }],
      },
    }
    expect(findUserPatchPath(host, '/fallback')).toBe('/home/u/.dsh/profiles/web/cordis.patch.yml')
  })

  it('falls back to <profile>/cordis.patch.yml', () => {
    expect(findUserPatchPath(emptyHost, '/profiles/web')).toBe(join('/profiles/web', 'cordis.patch.yml'))
  })
})

describe('rowIdsForPackage', () => {
  function installedBundle(dir: string, name: string, patch: string): void {
    mkdirSync(join(dir, 'node_modules', name), { recursive: true })
    writeFileSync(join(dir, 'node_modules', name, 'cordis.patch.yml'), patch)
  }

  it('collects the bundle patch row ids plus live loader entries', () => {
    const dir = patchDir()
    try {
      installedBundle(dir, 'dsh-loop', '- insert:\n    - id: loop-main\n      name: dsh-loop\n')
      const host: PatchHost = {
        loader: {
          entries: () => [
            { options: { id: 'include', name: 'cordis:include' } },
            { options: { id: 'include:loop-main', name: 'dsh-loop' } },
            // Market-owned namespaces must never map to user-patch rows.
            { options: { id: 'mkt-loop-main', name: 'dsh-loop' } },
            { options: { id: 'client-dsh-loop', name: 'dsh-loop' } },
          ],
        },
      }
      expect(rowIdsForPackage(host, dir, 'dsh-loop')).toEqual(['loop-main'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never claims rows the patch merely RECONFIGURES (#147)', () => {
    const dir = patchDir()
    try {
      // Real shape of dsh-vision-router: it inserts its own row, and also
      // tunes two OFFICIAL rows it does not own. Disabling the plugin used
      // to write `disabled: true` onto all three — taking attachments and
      // the DeepSeek model down with it.
      installedBundle(dir, 'dsh-vision-router', [
        '# comment line with - id: decoy',
        '- insert:',
        '    - id: vision-router',
        '      name: dsh-vision-router',
        '      config:',
        '        progressiveTools: false',
        '',
        '- id: attachment-local',
        '  config:',
        '    maxImageBytes: 20971520',
        '',
        '- id: llm-deepseek',
        '  config:',
        '    hidden: true',
        '',
      ].join('\n'))
      // Declared through dsh.bundle.patch — the path real plugins use, and
      // the one that handed rowIdsForPackage every id in the file.
      writeFileSync(
        join(dir, 'node_modules', 'dsh-vision-router', 'package.json'),
        JSON.stringify({ name: 'dsh-vision-router', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      )
      const host: PatchHost = { loader: { entries: () => [] } }
      expect(rowIdsForPackage(host, dir, 'dsh-vision-router')).toEqual(['vision-router'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * The block open/close transitions, which the single-insert fixture above
   * never exercises: a mutation audit could flip either indentation test in
   * readBundlePatchRows without breaking a single spec.
   *
   * Ownership is decided by nesting — ids under an `insert:` belong to the
   * package, ids at or above that indentation are OTHER plugins' rows it
   * configures — so the cases that matter are the ones where the block opens
   * and closes more than once.
   */
  it('tracks insert blocks that open, close and reopen (#147)', () => {
    const dir = patchDir()
    try {
      installedBundle(dir, 'multi-bundle', [
        // A config row BEFORE any insert block: never owned.
        '- id: llm-deepseek',
        '  config:',
        '    hidden: true',
        '',
        // First block, carrying more than one row of its own.
        '- insert:',
        '    - id: alpha',
        '      name: multi-bundle',
        '    - id: beta',
        '      name: multi-bundle-extra',
        '',
        // A sibling `- id:` row closes the block. The deeper id below is
        // therefore part of THAT neighbour's config, not ours — order
        // matters here: this case has to come first, while the block is
        // still open, or nothing proves the row is what closed it.
        '- id: attachment-local',
        '  config:',
        '    handlers:',
        '      - id: not-ours-nested',
        '',
        // Reopen, then close with a NON-id row instead: the other closing
        // path, which a scan that only reacts to `id:` lines misses.
        '- insert:',
        '    - id: delta',
        '      name: multi-bundle-delta',
        '- disable: true',
        '  entries:',
        '    - id: not-ours-disabled',
        '',
        // Reopens: a second block after those rows.
        '- insert:',
        '    - id: gamma',
        '      name: multi-bundle-late',
        '',
      ].join('\n'))
      writeFileSync(
        join(dir, 'node_modules', 'multi-bundle', 'package.json'),
        JSON.stringify({ name: 'multi-bundle', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      )
      const host: PatchHost = { loader: { entries: () => [] } }
      expect(rowIdsForPackage(host, dir, 'multi-bundle')).toEqual(['alpha', 'beta', 'delta', 'gamma'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('collects every row of a multi-row insert block', () => {
    const dir = patchDir()
    try {
      installedBundle(dir, 'multi', [
        '- insert:',
        '    - id: one',
        '      name: multi',
        '    - id: two',
        '      name: multi/second',
        '- id: someone-else',
        '  config: { x: 1 }',
      ].join('\n'))
      const host: PatchHost = { loader: { entries: () => [] } }
      expect(rowIdsForPackage(host, dir, 'multi').sort()).toEqual(['one', 'two'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns nothing for client-only packages (no bundle rows)', () => {
    const dir = patchDir()
    try {
      mkdirSync(join(dir, 'node_modules', 'dsh-client-only'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'dsh-client-only', 'package.json'), JSON.stringify({ dsh: { client: './c.js' } }))
      expect(rowIdsForPackage(emptyHost, dir, 'dsh-client-only')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('packagePatchFlags', () => {
  it('flags names whose rows the patch layer disables or force-enables', () => {
    const dir = patchDir()
    try {
      mkdirSync(join(dir, 'node_modules', 'dsh-a'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'dsh-a', 'cordis.patch.yml'), '- insert:\n    - id: a-row\n      name: dsh-a\n')
      mkdirSync(join(dir, 'node_modules', 'dsh-b'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'dsh-b', 'cordis.patch.yml'), '- insert:\n    - id: b-row\n      name: dsh-b\n')
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, '- id: a-row\n  disabled: true\n- id: b-row\n  disabled: false\n')
      const state = readUserPatchState(patch)
      const flags = packagePatchFlags(emptyHost, dir, ['dsh-a', 'dsh-b'], state)
      expect(flags.disabled).toEqual(['dsh-a'])
      expect(flags.forced).toEqual(['dsh-b'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
describe('the patch file always stays a top-level array', () => {
  /**
   * dsh boots a profile by parsing this file and refusing anything that is
   * not an array ("must be a top-level YAML array of loader patch entries").
   * Appending the first row comments the template's `[]` out, so removing
   * the last row used to leave a file of pure comments — disable a plugin,
   * enable it again, and the profile would not start at all. Found by the
   * layer-3 install chain, where the restart simply failed.
   */
  const bootWouldAccept = (text: string): boolean => Array.isArray(load(text))

  const template = [
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '# a top-level YAML array of loader patch entries.',
    '[]',
    '',
  ].join('\n')

  it('survives a disable/enable round trip', async () => {
    const dir = patchDir()
    try {
      const file = join(dir, 'cordis.patch.yml')
      writeFileSync(file, template)
      await disableRow(file, 'some-plugin')
      expect(bootWouldAccept(readPatch(dir))).toBe(true)

      await enableRow(file, 'some-plugin')
      // The row is gone AND the file is still something dsh can boot.
      expect(readPatch(dir)).not.toContain('some-plugin')
      expect(bootWouldAccept(readPatch(dir))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('survives uninstall cleanup removing the last row', async () => {
    const dir = patchDir()
    try {
      const file = join(dir, 'cordis.patch.yml')
      writeFileSync(file, template)
      await disableRow(file, 'going-away')
      removeRowBlocks(file, ['going-away'])
      expect(readPatch(dir)).not.toContain('going-away')
      expect(bootWouldAccept(readPatch(dir))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('carrierDisableIds', () => {
  function installedBundle(dir: string, name: string, patch: string): void {
    mkdirSync(join(dir, 'node_modules', name), { recursive: true })
    writeFileSync(join(dir, 'node_modules', name, 'cordis.patch.yml'), patch)
  }

  it('returns the OTHER plugins a bundle DISABLES (#224)', () => {
    const dir = patchDir()
    try {
      // Real shape of dsh-postgres-backends: it inserts its own three backends,
      // disables the official JSONL session backend, and reroutes storage-domain
      // onto postgres. Only the foreign DISABLE counts — that is what bricks the
      // boot once the postgres backends are also toggled off (nothing left to
      // provide sessionPersistence). The storage-domain row is a config tweak,
      // not a disable, so it is NOT reported here (though removing the bundle
      // still neutralizes it).
      installedBundle(dir, 'dsh-postgres-backends', [
        '- id: session-persistence-jsonl',
        '  disabled: true',
        '- insert:',
        '    - id: session-persistence-postgres',
        "      name: 'dsh-postgres-backends'",
        '    - id: storage-postgres',
        "      name: 'dsh-postgres-backends/storage'",
        '    - id: pg-console',
        "      name: 'dsh-postgres-backends/console'",
        '- id: storage-domain',
        '  config:',
        '    backend: postgres',
        '',
      ].join('\n'))
      writeFileSync(
        join(dir, 'node_modules', 'dsh-postgres-backends', 'package.json'),
        JSON.stringify({ name: 'dsh-postgres-backends', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      )
      expect(carrierDisableIds(dir, 'dsh-postgres-backends')).toEqual(['session-persistence-jsonl'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores a config-only neighbour tweak so its re-enable keeps working (#147 e2e)', () => {
    const dir = patchDir()
    try {
      // Shape of the e2e fixture-cross: inserts its own row and tweaks a
      // DIFFERENT plugin's config — no `disabled: true`. Treating this as a
      // disable-carrier dropped it from the bundle stack and broke re-enabling
      // it in the web e2e; #147 requires disabling it to leave the neighbour
      // live, which the plain ownership path already guarantees.
      installedBundle(dir, 'dshm-e2e-fixture-cross', [
        '- insert:',
        '    - id: dshm-fixture-cross',
        "      name: 'dshm-e2e-fixture-cross'",
        '- id: dshm-fixture-b',
        '  config:',
        '    tweakedByCross: true',
        '',
      ].join('\n'))
      expect(carrierDisableIds(dir, 'dshm-e2e-fixture-cross')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is empty for a pure-insert plugin, which is not a carrier', () => {
    const dir = patchDir()
    try {
      installedBundle(dir, 'dsh-loop', '- insert:\n    - id: loop-main\n      name: dsh-loop\n')
      expect(carrierDisableIds(dir, 'dsh-loop')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is empty for a package that is not installed', () => {
    const dir = patchDir()
    try {
      expect(carrierDisableIds(dir, 'not-installed')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
