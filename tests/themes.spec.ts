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
vi.mock('../src/registry.ts', () => ({ loadRegistry: registry.loadRegistry }))

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
