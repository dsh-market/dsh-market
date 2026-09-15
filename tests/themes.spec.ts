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
import type { LoaderEntry, ThemeHost } from '../src/themes.ts'

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

/**
 * The toggle half of the subpath problem #71 fixed only for the read-only
 * verification path: a bundle patch whose entries are not named after the
 * package must still be found by setEntryDisabled, or the market persists a
 * "disabled" choice that never lands while the plugin keeps running (#619).
 */
function hostWith(entries: LoaderEntry[]): ThemeHost {
  return {
    loader: { entries: () => entries },
    plugin: () => ({ await: async () => undefined, dispose: () => undefined }),
  }
}

/** A package that declares a bundle patch, so its inserted ids are readable. */
function bundlePatch(name: string, patch: string): void {
  const dir = join(home, 'profiles', 'web', 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(dir, 'cordis.patch.yml'), patch)
}

/**
 * A loader entry whose fiber tracks update(), so the "retry until reality
 * matches" loop breaks on the first pass instead of sleeping 200ms.
 */
function makeEntry(
  options: { id?: string; name?: string },
  initiallyLive = true,
): { entry: LoaderEntry; updates: (boolean | null)[] } {
  const updates: (boolean | null)[] = []
  const entry: LoaderEntry = {
    options,
    fiber: initiallyLive ? {} : undefined,
    update: async (next) => {
      updates.push(next.disabled)
      entry.fiber = next.disabled ? undefined : {}
    },
  }
  return { entry, updates }
}

describe('setEntryDisabled', () => {
  it('still matches the bare package name', async () => {
    const { entry, updates } = makeEntry({ id: 'dsh-pocket', name: 'dsh-pocket' })
    const manager = createThemeManager(hostWith([entry]), 'web', new Set())
    expect(await manager.setEntryDisabled('dsh-pocket', true)).toBe(true)
    expect(updates).toEqual([true])
    expect(entry.fiber).toBeUndefined()
  })

  it('matches a subpath entry named after the package', async () => {
    // aegis → aegis/extensions/dsh/index.js, toolshrink → toolshrink/harness
    const { entry, updates } = makeEntry({ id: 'aegis-method-pack', name: 'aegis/extensions/dsh/index.js' })
    const manager = createThemeManager(hostWith([entry]), 'web', new Set())
    expect(await manager.setEntryDisabled('aegis', true)).toBe(true)
    expect(updates).toEqual([true])
  })

  it('matches a carrier bundle by the ids its own patch inserts', async () => {
    bundlePatch('@deepseek-ai/dsh-experimental-agent-team-profile', [
      '- insert:',
      '    - id: agent-team',
      "      name: '@deepseek-ai/dsh-experimental-agent-team'",
      '    - id: tool-agent-team',
      "      name: '@deepseek-ai/dsh-experimental-tool-agent-team'",
      '',
    ].join('\n'))
    const team = makeEntry({ id: 'agent-team', name: '@deepseek-ai/dsh-experimental-agent-team' })
    // The loader may wrap ids in an include prefix; the bare id still matches.
    const tools = makeEntry({ id: 'include:abc:tool-agent-team', name: '@deepseek-ai/dsh-experimental-tool-agent-team' })
    const other = makeEntry({ id: 'unrelated', name: '@deepseek-ai/dsh-other' })
    const manager = createThemeManager(hostWith([team.entry, tools.entry, other.entry]), 'web', new Set())
    expect(await manager.setEntryDisabled('@deepseek-ai/dsh-experimental-agent-team-profile', true)).toBe(true)
    expect(team.updates).toEqual([true])
    expect(tools.updates).toEqual([true])
    expect(other.updates).toEqual([])
  })

  it('does not match a differently-suffixed package (the / bound)', async () => {
    const { entry, updates } = makeEntry({ id: 'tool', name: 'toolshrink-extra/harness' })
    const manager = createThemeManager(hostWith([entry]), 'web', new Set())
    expect(await manager.setEntryDisabled('toolshrink', true)).toBe(false)
    expect(updates).toEqual([])
  })

  it('reports false when nothing matches', async () => {
    const manager = createThemeManager(hostWith([]), 'web', new Set())
    expect(await manager.setEntryDisabled('ghost', true)).toBe(false)
  })
})
