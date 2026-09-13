/**
 * Theme classification: which installed packages the market treats as themes.
 *
 * Two paths decide it — the catalog name, and the GitHub repo the package
 * was installed from. The second exists because the same theme can land
 * under a different package name (a fork, a `github:owner/repo` install, a
 * monorepo subpath), and misclassifying there is user-visible in both
 * directions: a theme that never appears on the Themes tab, or a plain
 * plugin silently deactivated the next time a theme is switched on, since
 * activateTheme turns off everything it believes is a theme.
 *
 * Only the name path had coverage (through the flow suite). A mutation
 * audit broke the repo path in two places without failing a single spec.
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
import type { ThemeHost } from '../src/themes.ts'

const host: ThemeHost = {
  loader: { entries: () => [] },
  plugin: () => ({ await: async () => undefined, dispose: () => undefined }),
}

let home: string

/** A catalog with one theme and one ordinary plugin, both GitHub-hosted. */
function catalog(): void {
  registry.loadRegistry.mockResolvedValue({
      updated: '2026-01-01',
      count: 2,
      categories: {},
      plugins: [
        {
          name: 'dsh-deep-whale', owner: 'Small-tailqwq', category: 'theme',
          url: 'https://github.com/Small-tailqwq/dsh-deep-whale',
          description: { en: '', zh: '' }, install: '', added: '2026-01-01',
        },
        {
          name: 'dsh-notify', owner: 'someone', category: 'tools',
          url: 'https://github.com/someone/dsh-notify',
          description: { en: '', zh: '' }, install: '', added: '2026-01-01',
        },
    ],
  })
}

/** Write the profile manifest the classifier reads. */
function installed(deps: Record<string, string>): void {
  const dir = join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: deps }))
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshm-themes-'))
  process.env.DSH_HOME = home
  registry.loadRegistry.mockReset()
  catalog()
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

describe('installedThemeNames', () => {
  const names = async (): Promise<string[]> =>
    [...await createThemeManager(host, 'web', new Set()).installedThemeNames()].sort()

  it('classifies a package listed under the theme category by name', async () => {
    installed({ 'dsh-deep-whale': '^1.0.0', 'dsh-notify': '^1.0.0' })
    expect(await names()).toEqual(['dsh-deep-whale'])
  })

  it('classifies a theme installed from its repo under ANOTHER package name', async () => {
    // The github: spec is what identifies it — the package name does not
    // appear in the catalog at all.
    installed({ 'whale-fork': 'github:Small-tailqwq/dsh-deep-whale' })
    expect(await names()).toEqual(['whale-fork'])
  })

  it('matches the repo case-insensitively', async () => {
    installed({ 'whale-fork': 'github:SMALL-TAILQWQ/DSH-Deep-Whale' })
    expect(await names()).toEqual(['whale-fork'])
  })

  it('does NOT classify a repo that belongs to a non-theme entry', async () => {
    // The dangerous direction: a plain plugin treated as a theme gets
    // switched off whenever another theme is activated.
    installed({ 'notify-fork': 'github:someone/dsh-notify' })
    expect(await names()).toEqual([])
  })

  it('does NOT classify an unrelated repo or a plain version spec', async () => {
    installed({ 'random-plugin': 'github:nobody/unrelated', 'plain-dep': '^2.0.0' })
    expect(await names()).toEqual([])
  })

  it('classifies nothing when the catalog cannot be read', async () => {
    registry.loadRegistry.mockRejectedValue(new Error('offline'))
    installed({ 'dsh-deep-whale': '^1.0.0' })
    expect(await names()).toEqual([])
  })
})

describe('strict entry enable for ordinary plugins (#575)', () => {
  it('restores every touched entry if a later entry rejects, without touching other packages', async () => {
    const entries = [true, true].map((disabled, i) => {
      const entry = {
        options: { name: 'ordinary', disabled: disabled as boolean | null },
        fiber: undefined as unknown,
        update: async (options: { disabled: boolean | null }) => {
          entry.options.disabled = options.disabled
          entry.fiber = options.disabled ? undefined : {}
          if (!options.disabled && i === 1) throw new Error('second entry rejected')
        },
      }
      return entry
    })
    const other = { options: { name: 'unrelated', disabled: true }, update: vi.fn() }
    const manager = createThemeManager({ ...host, loader: { entries: () => [...entries, other] } }, 'web', new Set())
    await expect(manager.setEntryDisabled('ordinary', false, true)).rejects.toThrow('second entry rejected')
    for (const entry of entries) {
      expect(entry.options.disabled).toBe(true)
      expect(entry.fiber).toBeUndefined()
    }
    expect(other.update).not.toHaveBeenCalled()
  })

  it('reports failed restoration instead of claiming runtime rollback', async () => {
    const entry = { options: { name: 'ordinary', disabled: true }, update: async () => { throw new Error('loader broken') } }
    const manager = createThemeManager({ ...host, loader: { entries: () => [entry] } }, 'web', new Set())
    await expect(manager.setEntryDisabled('ordinary', false, true)).rejects.toThrow('entry restoration failed: loader broken')
  })

  it('refuses a fulfilled update that never produced a live fiber', async () => {
    const entry = { options: { name: 'ordinary', disabled: true as boolean | null }, update: async (options: { disabled: boolean | null }) => { entry.options.disabled = options.disabled } }
    const manager = createThemeManager({ ...host, loader: { entries: () => [entry] } }, 'web', new Set())
    await expect(manager.setEntryDisabled('ordinary', false, true)).rejects.toThrow('did not become live')
    expect(entry.options.disabled).toBe(true)
  })
  it('bounds background disable replay without rejecting its best-effort caller', async () => {
    const entry = { options: { name: 'ordinary', disabled: true }, update: () => new Promise<void>(() => {}) }
    const manager = createThemeManager({ ...host, loader: { entries: () => [entry] } }, 'web', new Set())
    vi.useFakeTimers()
    try {
      let result: boolean | undefined
      const pending = manager.setEntryDisabled('ordinary', true).then(value => { result = value })
      await vi.advanceTimersByTimeAsync(10_001)
      expect(result).toBe(false)
      await pending
    } finally { vi.useRealTimers() }
  })

})
