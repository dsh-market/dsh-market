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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  carrierRowIds,
  foreignRowIds, disableRow, enableRow, findUserPatchPath, isProtectedModule, packagePatchFlags,
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

describe('commented flag rows (#930)', () => {
  it.each(['\n', '\r\n'])('reads flags through comments and blanks with %j line endings', eol => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, ['- id: alpha', '  # disabled: false is only a comment', '', '  disabled: true', '- id: beta', '  # another reason', '  disabled: false', '- id: missing', '  # no flag belongs to missing', '- id: gamma', '  disabled: true'].join(eol))
      expect(readUserPatchState(patch)).toEqual({ disables: ['alpha', 'gamma'], forced: ['beta'], inserts: [] })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it.each(['\n', '\r\n'])('flips a commented flag without dropping its explanation or duplicating it (%j)', async eol => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      const text = ['- id: pet', '  # keep this explanation', '', '  disabled: false', '- id: keep', '  disabled: true', ''].join(eol)
      writeFileSync(patch, text)
      expect((await disableRow(patch, 'pet')).ok).toBe(true)
      expect(readPatch(dir)).toBe(text.replace('disabled: false', 'disabled: true'))
      await disableRow(patch, 'pet')
      expect(readPatch(dir)).toBe(text.replace('disabled: false', 'disabled: true'))
      await enableRow(patch, 'pet')
      expect(load(readPatch(dir))).toEqual([{ id: 'keep', disabled: true }])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it.each(["'pet'", '"pet"'])('keeps quoted commented toggles idempotent (%s)', async id => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      const text = `- id: ${id}\n  # rationale\n  disabled: false`
      writeFileSync(patch, text)
      expect(readUserPatchState(patch).forced).toEqual(['pet'])
      await disableRow(patch, 'pet')
      await disableRow(patch, 'pet')
      expect(readPatch(dir)).toBe(text.replace('disabled: false', 'disabled: true'))
      expect(readUserPatchState(patch).disables).toEqual(['pet'])
      await enableRow(patch, 'pet')
      expect(load(readPatch(dir))).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('removes commented standalone flags while preserving longer entries across blank lines', () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      const longer = '- id: pet\n  # preserve config\n  disabled: false\n\n  # still part of pet\n  config:\n    size: 2\n'
      const standalone = '- id: pet\n  # a standalone override\n\n  disabled: true'
      writeFileSync(patch, longer + standalone)
      expect(removeRowBlocks(patch, ['pet']).ok).toBe(true)
      expect(readPatch(dir)).toBe(longer)
      expect(load(readPatch(dir))).toEqual([{ id: 'pet', disabled: false, config: { size: 2 } }])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('recognizes the last commented flag in a longer entry after a flip', async () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      const longer = '- id: pet\n  # a later override\n  disabled: false\n  config:\n    size: 2\n'
      writeFileSync(patch, '- id: pet\n  disabled: false\n' + longer)
      expect((await disableRow(patch, 'pet')).ok).toBe(true)
      expect(readPatch(dir)).toBe('- id: pet\n  disabled: true\n' + longer + '- id: pet\n  disabled: true\n')
    } finally { rmSync(dir, { recursive: true, force: true }) }
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

  it('a disable after a force flips that block in place instead of adding a second (#821)', async () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, '- id: other\n  disabled: true\n')
      await enableRow(patch, 'workbench')
      await disableRow(patch, 'workbench')
      expect(readPatch(dir)).toBe('- id: other\n  disabled: true\n- id: workbench\n  disabled: true\n')
      expect(readUserPatchState(patch)).toMatchObject({ forced: [], disables: ['other', 'workbench'] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('folds the duplicate blocks an older version left into one when disabling (#821)', async () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, '- id: dsh-engram\n  disabled: false\n- id: keep\n  disabled: true\n- id: dsh-engram\n  disabled: true\n')
      await disableRow(patch, 'dsh-engram')
      expect(readPatch(dir)).toBe('- id: dsh-engram\n  disabled: true\n- id: keep\n  disabled: true\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enable removes every disable block of the row, not only the first (#821)', async () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, '- id: pet\n  disabled: true\n- id: keep\n  disabled: true\n- id: pet\n  disabled: true\n')
      await enableRow(patch, 'pet')
      expect(readPatch(dir)).toBe('- id: keep\n  disabled: true\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enable finds a hand-written disable with trailing spaces and no final newline (#821)', async () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, '- id: keep\n  disabled: true\n- id: pet  \n  disabled: true')
      await enableRow(patch, 'pet')
      expect(readPatch(dir)).toBe('- id: keep\n  disabled: true\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enable that clears the last row puts the empty list back (#821)', async () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, '# []\n- id: pet\n  disabled: true\n- id: pet\n  disabled: true\n')
      await enableRow(patch, 'pet')
      expect(readPatch(dir)).toBe('[]\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a flip in place keeps the line endings of a CRLF file (#821)', async () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, '- id: pet\r\n  disabled: false\r\n- id: keep\r\n  disabled: true\r\n')
      await disableRow(patch, 'pet')
      expect(readPatch(dir)).toBe('- id: pet\r\n  disabled: true\r\n- id: keep\r\n  disabled: true\r\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still ends disabled when a longer entry for the row comes after the flipped block (#821)', async () => {
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      const longer = '- id: pet\n  disabled: false\n  config:\n    size: 2\n'
      writeFileSync(patch, `- id: pet\n  disabled: false\n${longer}`)
      const result = await disableRow(patch, 'pet')
      expect(result.ok).toBe(true)
      expect(readPatch(dir)).toBe(`- id: pet\n  disabled: true\n${longer}- id: pet\n  disabled: true\n`)
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

  it('removes every block of a row, so no disable outlives the package (#821)', () => {
    // The pair a force followed by a disable used to leave. Clearing only the
    // first block kept `disabled: true`, which switched a reinstall off.
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, '- id: dsh-engram\n  disabled: false\n- id: dsh-engram\n  disabled: true\n')
      removeRowBlocks(patch, ['dsh-engram'])
      expect(readPatch(dir)).toBe('[]\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves a row that carries more keys than the flag (#821)', () => {
    // Cutting `- id` and `disabled` off this entry would hang its `config`
    // on the entry above and break the file the profile boots from.
    const dir = patchDir()
    try {
      const patch = join(dir, 'cordis.patch.yml')
      const text = '- id: keep\n  disabled: true\n- id: pet\n  disabled: false\n  config:\n    size: 2\n'
      writeFileSync(patch, text)
      removeRowBlocks(patch, ['pet'])
      expect(readPatch(dir)).toBe(text)
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

  it('does not call a package disabled over a row it ships switched off itself (#876)', () => {
    // dsh-mnemon's real shape: the bundle ships four `mnemon-strategy-*` rows
    // as opt-in — `disabled: true` in its OWN patch, before the user ever saw
    // it — and the user patch layer repeats one of them. Counting that as a
    // user decision made the card say 「已停用 / 重启后保持关闭」 about a
    // plugin that was demonstrably running, and offered an enable button that
    // force-opened the other opt-in rows.
    const dir = patchDir()
    try {
      mkdirSync(join(dir, 'node_modules', 'dsh-mnemon'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'dsh-mnemon', 'cordis.patch.yml'), [
        '- insert:',
        '    - id: mnemon',
        '      name: dsh-mnemon',
        '    - id: mnemon-strategy-general',
        '      name: dsh-mnemon-strategy-general',
        '      disabled: true',
        '    - id: mnemon-strategy-light-context',
        '      name: dsh-mnemon-strategy-light-context',
        '      disabled: true',
        '',
      ].join('\n'))
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, '- id: mnemon-strategy-light-context\n  disabled: true\n')
      const flags = packagePatchFlags(emptyHost, dir, ['dsh-mnemon'], readUserPatchState(patch))
      expect(flags.disabled).toEqual([])
      expect(flags.forced).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still reads a decision about the package\'s own core row', () => {
    // The other half of the same rule: the user really did switch the package
    // off, so the row that IS the package counts as before.
    const dir = patchDir()
    try {
      mkdirSync(join(dir, 'node_modules', 'dsh-mnemon'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'dsh-mnemon', 'cordis.patch.yml'), [
        '- insert:',
        '    - id: mnemon',
        '      name: dsh-mnemon',
        '    - id: mnemon-strategy-general',
        '      name: dsh-mnemon-strategy-general',
        '      disabled: true',
        '',
      ].join('\n'))
      const patch = join(dir, 'cordis.patch.yml')
      writeFileSync(patch, '- id: mnemon\n  disabled: true\n')
      expect(packagePatchFlags(emptyHost, dir, ['dsh-mnemon'], readUserPatchState(patch)).disabled).toEqual(['dsh-mnemon'])
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

describe('carrierRowIds', () => {
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
      expect(carrierRowIds(dir, 'dsh-postgres-backends')).toEqual(['session-persistence-jsonl'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores a config-only neighbour tweak so its re-enable keeps working (#147 e2e)', () => {
    const dir = patchDir()
    try {
      // Shape of the e2e fixture-cross: inserts its own row and tweaks a
      // DIFFERENT plugin's config — no `disabled: true` and no `inject`. Treating this as a
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
      expect(carrierRowIds(dir, 'dshm-e2e-fixture-cross')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('counts a foreign row given a new inject requirement (#938)', () => {
    const dir = patchDir()
    try {
      // billion-context 0.1.202: its own row provides biliBasicCompactionPolicy,
      // and its patch makes the four official agent presets `inject` it. A
      // row-level disable leaves those rows waiting for a service that is
      // gone — every preset disappears. The bundle has to leave the stack.
      installedBundle(dir, 'billion-context', [
        '- insert:',
        '    - id: bili-native',
        "      name: 'billion-context'",
        '- id: preset-standard',
        '  inject:',
        '    - biliBasicCompactionPolicy',
        '- id: preset-ptc',
        '  inject:',
        '    - biliBasicCompactionPolicy',
        '',
      ].join('\n'))
      expect(carrierRowIds(dir, 'billion-context')).toEqual(['preset-standard', 'preset-ptc'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is empty for a pure-insert plugin, which is not a carrier', () => {
    const dir = patchDir()
    try {
      installedBundle(dir, 'dsh-loop', '- insert:\n    - id: loop-main\n      name: dsh-loop\n')
      expect(carrierRowIds(dir, 'dsh-loop')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is empty for a package that is not installed', () => {
    const dir = patchDir()
    try {
      expect(carrierRowIds(dir, 'not-installed')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads every file of an ARRAY-declared patch — the foreign disable in the second counts (#792, #224)', () => {
    const dir = patchDir()
    try {
      // Same brick-the-boot shape as #224, but declared as a LIST of patch
      // files (the host composes both). A string-only read saw no declared
      // patch at all, so the array package toggled off without the #224
      // bundle-removal guard firing.
      const pkg = join(dir, 'node_modules', 'dsh-array-carrier')
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({
        name: 'dsh-array-carrier',
        dsh: { bundle: { patch: ['./base.patch.yml', './carve.patch.yml'] } },
      }))
      writeFileSync(join(pkg, 'base.patch.yml'), '- insert:\n    - id: carrier-main\n      name: dsh-array-carrier\n')
      writeFileSync(join(pkg, 'carve.patch.yml'), '- id: session-persistence-jsonl\n  disabled: true\n')
      expect(carrierRowIds(dir, 'dsh-array-carrier')).toEqual(['session-persistence-jsonl'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('foreignRowIds', () => {
  function installedBundle(dir: string, name: string, patch: string, declared = true): void {
    mkdirSync(join(dir, 'node_modules', name), { recursive: true })
    writeFileSync(join(dir, 'node_modules', name, 'cordis.patch.yml'), patch)
    if (declared) {
      writeFileSync(join(dir, 'node_modules', name, 'package.json'),
        JSON.stringify({ name, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    }
  }

  it('is empty for a bundle whose patch speaks only for itself', () => {
    const dir = patchDir()
    try {
      // The ordinary shape, and the one #696 B is about: disabling this bundle
      // is disabling it, so the market may take it out of dsh.profile.bundles.
      installedBundle(dir, 'dsh-loop', [
        '- insert:',
        '    - id: loop-main',
        "      name: 'dsh-loop'",
        '    - id: loop-panel',
        "      name: 'dsh-loop/panel'",
        '',
      ].join('\n'))
      expect(foreignRowIds(dir, 'dsh-loop')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names a neighbour the bundle only CONFIGURES (fixture-cross, #147)', () => {
    const dir = patchDir()
    try {
      installedBundle(dir, 'dshm-e2e-fixture-cross', [
        '- insert:',
        '    - id: dshm-fixture-cross',
        "      name: 'dshm-e2e-fixture-cross'",
        '- id: dshm-fixture-b',
        '  config:',
        '    tweakedByCross: true',
        '',
      ].join('\n'))
      expect(foreignRowIds(dir, 'dshm-e2e-fixture-cross')).toEqual(['dshm-fixture-b'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names both the plugins a carrier disables and the ones it reconfigures', () => {
    const dir = patchDir()
    try {
      // dsh-postgres-backends shape: one foreign disable and one foreign config.
      // carrierRowIds reports the first alone (it is what bricks a boot);
      // this reports both, because leaving the stack takes both away.
      installedBundle(dir, 'dsh-postgres-backends', [
        '- id: session-persistence-jsonl',
        '  disabled: true',
        '- insert:',
        '    - id: session-persistence-postgres',
        "      name: 'dsh-postgres-backends'",
        '- id: storage-domain',
        '  config:',
        '    backend: postgres',
        '',
      ].join('\n'))
      expect(foreignRowIds(dir, 'dsh-postgres-backends').sort()).toEqual(['session-persistence-jsonl', 'storage-domain'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the conventional patch even when the manifest declares none', () => {
    const dir = patchDir()
    try {
      installedBundle(dir, 'dsh-tweaker', [
        '- insert:',
        '    - id: tweaker-main',
        "      name: 'dsh-tweaker'",
        '- id: neighbour-row',
        '  disabled: true',
        '',
      ].join('\n'), false)
      expect(foreignRowIds(dir, 'dsh-tweaker')).toEqual(['neighbour-row'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is empty for a package that is not installed', () => {
    const dir = patchDir()
    try {
      expect(foreignRowIds(dir, 'not-installed')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('judges ownership across every file of an ARRAY-declared patch (#792, #696 B)', () => {
    const dir = patchDir()
    try {
      // The neighbour tweak lives in the SECOND declared file: ownership is
      // per file, and a string-only read ignored the whole list — the array
      // package looked like it owned nothing foreign and its toggle-off
      // wrongly left it in the bundle stack (#696 B).
      const pkg = join(dir, 'node_modules', 'dsh-array-carrier')
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({
        name: 'dsh-array-carrier',
        dsh: { bundle: { patch: ['./own.patch.yml', './tweak.patch.yml'] } },
      }))
      writeFileSync(join(pkg, 'own.patch.yml'), '- insert:\n    - id: carrier-main\n      name: dsh-array-carrier\n')
      writeFileSync(join(pkg, 'tweak.patch.yml'), '- id: neighbour-row\n  config:\n    tuned: true\n')
      expect(foreignRowIds(dir, 'dsh-array-carrier')).toEqual(['neighbour-row'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a patch file that cannot be written is refused in words, not by throwing', () => {
  // Before this, the write threw: the route answered 500 with a raw errno
  // ("EACCES: permission denied, open '…'") after the runtime half had already
  // changed, and the durable layer silently kept the old state.
  const chmod = (path: string, mode: number): void => { chmodSync(path, mode) }

  it('disableRow, enableRow and removeRowBlocks report a read-only file instead of throwing', async () => {
    const dir = patchDir()
    const patch = join(dir, 'cordis.patch.yml')
    try {
      writeFileSync(patch, '- id: pet\n  disabled: false\n')
      chmod(patch, 0o444)
      const disabled = await disableRow(patch, 'pet')
      expect(disabled.ok).toBe(false)
      expect(disabled.reason).toContain('补丁层文件写不进去')
      expect(disabled.reason).toContain('文件不可写')
      // An enable only writes when it has a `disabled: true` block to remove;
      // force-enabling an already-forced row is a no-op success by design.
      chmod(patch, 0o644)
      writeFileSync(patch, '- id: pet\n  disabled: true\n')
      chmod(patch, 0o444)
      const enabled = await enableRow(patch, 'pet')
      expect(enabled.ok).toBe(false)
      expect(enabled.reason).toContain('补丁层文件写不进去')
      const removed = removeRowBlocks(patch, ['pet'])
      expect(removed.ok).toBe(false)
      expect(removed.reason).toContain('补丁层文件写不进去')
      // Nothing was half-written on the way out.
      expect(readFileSync(patch, 'utf8')).toBe('- id: pet\n  disabled: true\n')
    } finally {
      chmod(patch, 0o644)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removeRowBlocks still reports success when there is no file, and when rows are gone', () => {
    const dir = patchDir()
    try {
      const missing = join(dir, 'cordis.patch.yml')
      expect(removeRowBlocks(missing, ['pet']).ok).toBe(true)
      writeFileSync(missing, '- id: keep\n  disabled: true\n')
      expect(removeRowBlocks(missing, ['pet']).ok).toBe(true)
      expect(readFileSync(missing, 'utf8')).toBe('- id: keep\n  disabled: true\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
