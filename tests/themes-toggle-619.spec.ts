/**
 * Live toggles for bundle-layer plugins whose loader entries are NOT
 * registered under the bare package name (#619).
 *
 * A bundle's cordis.patch.yml can insert its rows under a sub-path entry
 * name (`name: 'pkg/extensions/dsh/index.js'`) or under any other id the
 * author chose. The toggle used to match loader entries by package name
 * alone: the disable "succeeded" (the package landed in state.json) while
 * the fiber kept running, and re-enable failed with
 * `no loader entry matched`. The fix resolves the entry names the package
 * owns from its own patch file and matches those too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const registry = vi.hoisted(() => ({ loadRegistry: vi.fn() }))
vi.mock('../src/registry.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/registry.ts')>(),
  loadRegistry: registry.loadRegistry,
}))

import { createThemeManager } from '../src/themes.ts'
import type { LoaderEntry, ThemeHost } from '../src/themes.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshm-toggle-619-'))
  process.env.DSH_HOME = home
  registry.loadRegistry.mockReset()
  registry.loadRegistry.mockResolvedValue({ updated: '2026-01-01', count: 0, categories: {}, plugins: [] })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

/** Write an installed manifest naming `deps`, and each package's patch file. */
function install(deps: Record<string, string>, patches: Record<string, string>): void {
  const dir = join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: deps }))
  for (const [name, patch] of Object.entries(patches)) {
    const pkgDir = join(dir, 'node_modules', name)
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'cordis.patch.yml'), patch)
  }
}

interface FakeEntry {
  entry: LoaderEntry
  updates: number
}

/** A loader entry registered under an arbitrary name, live until disabled. */
function entryNamed(name: string): FakeEntry {
  const record: FakeEntry = { updates: 0, entry: {
    options: { id: name, name, disabled: null as boolean | null },
    fiber: {} as unknown,
    update: async (options: { disabled: boolean | null }) => {
      record.updates += 1
      record.entry.options.disabled = options.disabled
      record.entry.fiber = options.disabled === true ? undefined : ({} as unknown)
    },
  } }
  return record
}

describe('setEntryDisabled resolves the entry names a package owns (#619)', () => {
  it('disables and re-enables a sub-path entry inserted by the package patch', async () => {
    install(
      { aegis: 'github:example/aegis' },
      { aegis: "- id: aegis-method-pack\n  name: 'aegis/extensions/dsh/index.js'\n" },
    )
    const fake = entryNamed('aegis/extensions/dsh/index.js')
    const manager = createThemeManager(hostWith(fake.entry), 'web', new Set())

    expect(await manager.setEntryDisabled('aegis', true)).toBe(true)
    expect(fake.entry.options.disabled).toBe(true)
    expect(fake.entry.fiber).toBeUndefined()

    expect(await manager.setEntryDisabled('aegis', false)).toBe(true)
    expect(fake.entry.options.disabled).toBeNull()
    expect(fake.entry.fiber).toBeDefined()
  })

  it('matches an entry registered under a bare id that differs from the package name', async () => {
    install(
      { 'toolshrink': 'github:example/toolshrink' },
      { toolshrink: '- id: toolshrink/harness\n  name: harness-entry\n' },
    )
    // The loader registered it as the row's name, not the package name.
    const fake = entryNamed('harness-entry')
    const manager = createThemeManager(hostWith(fake.entry), 'web', new Set())

    expect(await manager.setEntryDisabled('toolshrink', true)).toBe(true)
    expect(fake.entry.options.disabled).toBe(true)
  })

  it('still matches a plain package whose entry name is the package name', async () => {
    install({ 'dsh-plain': 'github:example/dsh-plain' }, {})
    const fake = entryNamed('dsh-plain')
    const manager = createThemeManager(hostWith(fake.entry), 'web', new Set())

    expect(await manager.setEntryDisabled('dsh-plain', true)).toBe(true)
    expect(fake.entry.options.disabled).toBe(true)
  })

  it('reports no match when no owned entry name is live', async () => {
    install(
      { aegis: 'github:example/aegis' },
      { aegis: "- id: aegis-method-pack\n  name: 'aegis/extensions/dsh/index.js'\n" },
    )
    // An unrelated entry is live; nothing the package owns.
    const fake = entryNamed('someone-else')
    const manager = createThemeManager(hostWith(fake.entry), 'web', new Set())

    expect(await manager.setEntryDisabled('aegis', true)).toBe(false)
    expect(fake.updates).toBe(0)
  })
})

function hostWith(...entries: LoaderEntry[]): ThemeHost {
  return {
    loader: { entries: () => entries },
    plugin: () => ({ await: async () => undefined, dispose: () => undefined }),
  }
}
