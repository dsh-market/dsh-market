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

/** Write an installed package that declares itself a skin (skin.json at root). */
function skin(name: string, id: string): void {
  const dir = join(home, 'profiles', 'web', 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'skin.json'), JSON.stringify({ id, package: name }))
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

  it('separates the packages of one monorepo: the manager is not a theme (#519)', async () => {
    // The reported shape, with the catalog as it actually is: one repository
    // ships a skin MANAGER and two skins as three separate packages, and the
    // catalog lists only ONE of the skins (`/tree/main/maid-atelier`).
    // Matching by repo alone made the manager a theme, so activating any other
    // theme switched it off — taking the user's own management UI with it.
    registry.loadRegistry.mockResolvedValue({
      updated: '2026-01-01',
      count: 1,
      categories: {},
      plugins: [
        {
          name: 'dsh-deep-whale#maid-atelier', owner: 'Small-tailqwq', category: 'theme',
          url: 'https://github.com/Small-tailqwq/dsh-deep-whale/tree/main/maid-atelier',
          description: { en: '', zh: '' }, install: '', added: '2026-01-01',
        },
      ],
    })
    installed({
      '@dsh-external/dsh-client-ui-skin-deep-whale-manager': 'github:Small-tailqwq/dsh-deep-whale#path:/skin-manager',
      '@smalltailqwq/dsh-client-ui-skin-maid-atelier': 'github:Small-tailqwq/dsh-deep-whale#path:/maid-atelier',
      '@smalltailqwq/dsh-client-ui-skin-orca-link': 'github:Small-tailqwq/dsh-deep-whale#path:/orca-link',
    })
    // The second skin is not in the catalog at all — its own skin.json is what
    // identifies it (both skins ship one; the manager ships none).
    skin('@smalltailqwq/dsh-client-ui-skin-maid-atelier', 'maid-atelier')
    skin('@smalltailqwq/dsh-client-ui-skin-orca-link', 'orca-link')

    expect(await names()).toEqual([
      '@smalltailqwq/dsh-client-ui-skin-maid-atelier',
      '@smalltailqwq/dsh-client-ui-skin-orca-link',
    ])
  })

  it('still classifies a subdirectory install when the catalog entry covers the whole repo', async () => {
    // The other direction, pinned so the rule cannot become "subpath installs
    // are never themes": a catalog entry pointing at the repo itself says
    // nothing about subdirectories, and the old permissive match is what keeps
    // a monorepo skin working there.
    installed({ 'whale-fork': 'github:Small-tailqwq/dsh-deep-whale#path:/somewhere' })
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

  it('does not claim a duplicated id that another installed package names (#1089)', async () => {
    // The reported chain: `dsh-tauri-pet`'s patch also inserted an entry for
    // `dsh-taiwind`, and `dsh-taiwind` is a bundle of its own. Switching the
    // pet off therefore switched tailwind's entry off too — every boot, about
    // ten seconds in, with the stylesheet route going 404 for good.
    installed({ 'dsh-tauri-pet': '^1.0.0', 'dsh-taiwind': '^1.0.0' })
    bundlePatch('dsh-tauri-pet', [
      '- insert:',
      '    - id: dsh-tauri-pet',
      '      name: dsh-tauri-pet',
      '    - id: dsh-taiwind',
      '      name: dsh-taiwind',
      '',
    ].join('\n'))
    const pet = makeEntry({ id: 'dsh-tauri-pet', name: 'dsh-tauri-pet' })
    const tailwind = makeEntry({ id: 'dsh-taiwind', name: 'dsh-taiwind' })
    const manager = createThemeManager(hostWith([pet.entry, tailwind.entry]), 'web', new Set())

    expect(await manager.setEntryDisabled('dsh-tauri-pet', true)).toBe(true)
    expect(pet.updates).toEqual([true])
    // The entry names an installed package of its own; the shared id says
    // nothing about ownership.
    expect(tailwind.updates).toEqual([])
    expect(tailwind.entry.fiber).toBeDefined()
  })

  it('reports false when nothing matches', async () => {
    const manager = createThemeManager(hostWith([]), 'web', new Set())
    expect(await manager.setEntryDisabled('ghost', true)).toBe(false)
  })
})

describe('toggle log lines say what actually happened (#788)', () => {
  /**
   * The report: one stuck entry produced the same three lines every minute for
   * a day, and each of them was wrong about the situation. The entry WAS
   * matched; its update threw; the fiber was still up. The log said "-> off:
   * fiber=true" and, from a different branch, "no loader entry matched" — which
   * pointed the reporter at an entry-naming bug (#619) that was not there.
   * None of this changes what setEntryDisabled returns or what boot replays;
   * it only stops the log from contradicting the state it describes.
   */
  const logged = async (run: () => Promise<unknown>): Promise<string[]> => {
    const log = await import('../src/log.ts')
    const spy = vi.spyOn(log, 'logEvent').mockImplementation(() => undefined)
    try {
      await run()
      return spy.mock.calls.map(([level, event, detail]) => `${level} ${event} ${detail}`)
    } finally {
      spy.mockRestore()
    }
  }

  /** An entry whose update always throws, like one wedged behind pending work. */
  const failingEntry = (error: Error): LoaderEntry => ({
    options: { id: 'pet', name: '@linxin666/dsh-pet' },
    fiber: {},
    update: async () => { throw error },
  })

  it('does not say "no loader entry matched" when an entry matched and its update failed', async () => {
    const entry = failingEntry(new Error('boom'))
    const manager = createThemeManager(hostWith([entry]), 'web', new Set())
    const lines = await logged(async () => {
      expect(await manager.setEntryDisabled('@linxin666/dsh-pet', true)).toBe(false)
    })
    expect(lines.join('\n')).not.toContain('no loader entry matched')
    expect(lines.join('\n')).toContain('entry update failed — boom')
  })

  it('does not write "-> off" for an update that threw, with the fiber still up', async () => {
    const entry = failingEntry(new Error('boom'))
    const manager = createThemeManager(hostWith([entry]), 'web', new Set())
    const lines = await logged(() => manager.setEntryDisabled('@linxin666/dsh-pet', true))
    expect(lines.join('\n')).not.toMatch(/-> off/)
    expect(entry.fiber).toBeDefined()
  })

  it('still says "no loader entry matched" when nothing was selected, and "-> off" when it landed', async () => {
    const empty = createThemeManager(hostWith([]), 'web', new Set())
    expect((await logged(() => empty.setEntryDisabled('ghost', true))).join('\n')).toContain('ghost: no loader entry matched')

    const { entry } = makeEntry({ id: 'pet', name: '@linxin666/dsh-pet' })
    const ok = createThemeManager(hostWith([entry]), 'web', new Set())
    expect((await logged(() => ok.setEntryDisabled('@linxin666/dsh-pet', true))).join('\n'))
      .toContain('@linxin666/dsh-pet -> off: fiber=false')
  })

  it('does not log a second failure for the update that is still pending, but keeps the first timeout', async () => {
    // First call: the update never settles within the wait, so it logs the
    // timeout once. Second call (the next boot replay / retry) bumps into the
    // still-pending operation — that is the SAME problem, not a new one.
    vi.useFakeTimers()
    try {
      const entry: LoaderEntry = {
        options: { id: 'pet', name: '@linxin666/dsh-pet' },
        fiber: {},
        update: () => new Promise<void>(() => { /* never settles */ }),
      }
      const manager = createThemeManager(hostWith([entry]), 'web', new Set())
      const lines = await logged(async () => {
        const first = manager.setEntryDisabled('@linxin666/dsh-pet', true)
        await vi.advanceTimersByTimeAsync(11_000)
        await first
        await manager.setEntryDisabled('@linxin666/dsh-pet', true)
      })
      const text = lines.join('\n')
      expect(text).toContain('did not settle within 10s')
      expect(text).not.toContain('previous operation is still pending')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('strict entry enable (#575, #582)', () => {
  it('restores every touched entry if a later entry rejects, without touching other packages', async () => {
    const entries = [0, 1].map(i => {
      const entry = {
        options: { name: 'ordinary', disabled: true as boolean | null },
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
    // Both entries are back where they started — including the one that HAD
    // been enabled before the second one rejected.
    for (const entry of entries) {
      expect(entry.options.disabled).toBe(true)
      expect(entry.fiber).toBeUndefined()
    }
    expect(other.update).not.toHaveBeenCalled()
  })

  it('reports a failed restoration instead of claiming the runtime was rolled back', async () => {
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

  it('bounds a hung update without rejecting the best-effort caller', async () => {
    // The boot replay and the theme paths were written against the old
    // best-effort contract: they must not start rejecting because a loader
    // update never settles.
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
