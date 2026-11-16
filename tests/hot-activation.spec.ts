import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { hotMount, hotUnmount, listHotMounts, readDisabled } from '../src/hot.ts'
import { configurePersistentLog, readPersistentLog } from '../src/log.ts'
import { createThemeManager } from '../src/themes.ts'
import { verifyActivation } from '../src/verify.ts'

interface Entry {
  id: string
  fiber: { state: number }
  update: () => Promise<void>
}

vi.mock('@deepseek-ai/cordis-plugin-include', () => ({
  Include: class {
    constructor(private readonly ctx: { entries: Entry[] }) {}
    entries(): Entry[] { return this.ctx.entries }
    write(): void {}
    import(name: string): unknown { return { name, apply: () => {} } }
  },
}))

const registry = vi.hoisted(() => ({ loadRegistry: vi.fn() }))
vi.mock('../src/registry.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/registry.ts')>(),
  loadRegistry: registry.loadRegistry,
}))

const ACTIVE = 2
const FAILED = 3
const PENDING = 0

function installFixture(dir: string, name: string): void {
  const pkg = join(dir, 'node_modules', name)
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({
    name, version: '1.0.0', main: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(pkg, 'index.js'), '')
  writeFileSync(join(pkg, 'cordis.patch.yml'), `- insert:\n    - id: ${name}\n      name: ${name}\n`)
}

function entry(id: string, state: number): Entry {
  return { id, fiber: { state }, update: async () => {} }
}

function hostWithEntries(entries: Entry[]) {
  const dispose = vi.fn()
  return {
    dispose,
    host: {
      plugin: vi.fn((Plugin: unknown, config: unknown) => {
        const Include = Plugin as new (ctx: { entries: Entry[] }, config: unknown) => unknown
        new Include({ entries }, config)
        return { await: async () => {}, dispose }
      }),
    },
  }
}

it('reports a failed child by its own entry, while keeping the mounted siblings and allowing teardown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-activation-'))
  const partial = 'dsh-partial'
  const waiting = 'dsh-waiting'
  const log = join(dir, '.dsh-market', 'log.ndjson')
  const duplicate = entry('mkt-duplicate-service', FAILED)
  const sibling = entry('mkt-working-sibling', ACTIVE)
  const pending = entry('mkt-awaiting-service', PENDING)
  const first = hostWithEntries([duplicate, sibling])
  const second = hostWithEntries([pending])
  try {
    installFixture(dir, partial)
    installFixture(dir, waiting)
    configurePersistentLog(log)

    const result = await hotMount(first.host, dir, partial)
    expect(result.ok).toBe(false)
    expect(result.deferred).toBeUndefined()
    expect(result.retained).toBe(true)
    expect(result.reason).toContain(duplicate.id)
    expect(result.reason).not.toContain('restart')
    expect(first.dispose).not.toHaveBeenCalled()
    expect(await hotMount(first.host, dir, partial)).toEqual(result)
    expect(first.host.plugin).toHaveBeenCalledOnce()
    expect(sibling.fiber.state).toBe(ACTIVE)
    expect(listHotMounts()).toContain(partial)
    expect(verifyActivation('desktop', partial, new Set([partial]), dir)).toMatchObject({
      state: 'failed',
      hot: false,
      reasons: [expect.stringContaining(duplicate.id)],
    })
    expect(readPersistentLog(log).join('\n')).not.toContain(`${partial}: live`)

    expect(await hotMount(second.host, dir, waiting)).toEqual({ ok: true, reason: null })
    expect(listHotMounts()).toContain(waiting)
    pending.fiber.state = ACTIVE
    expect(verifyActivation('desktop', waiting, new Set(listHotMounts()), dir).state).toBe('live')

    expect(await hotUnmount(partial)).toBe(true)
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(second.dispose).not.toHaveBeenCalled()
    expect(listHotMounts()).toContain(waiting)
    expect(verifyActivation('desktop', partial, new Set(), dir).state).not.toBe('failed')
  } finally {
    await hotUnmount(partial)
    await hotUnmount(waiting)
    configurePersistentLog(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each([false, true])('reuses the healthy tree when only inserts remain (patch changed: %s)', async changed => {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-reuse-'))
  const name = 'dsh-reuse-patch'
  const { host, dispose } = hostWithEntries([entry('mkt-dsh-reuse-patch', ACTIVE)])
  try {
    installFixture(dir, name)
    expect(await hotMount(host, dir, name)).toEqual({ ok: true, reason: null })

    if (changed) {
      const patch = join(dir, 'node_modules', name, 'cordis.patch.yml')
      writeFileSync(patch, '- insert:\n    - id: replacement\n      name: dsh-reuse-patch\n')
    }
    expect(await hotMount(host, dir, name)).toEqual({ ok: true, reason: null })
    expect(host.plugin).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
    expect(await hotUnmount(name)).toBe(true)
    expect(dispose).toHaveBeenCalledOnce()
  } finally {
    await hotUnmount(name)
    rmSync(dir, { recursive: true, force: true })
  }
})

it('checks a replacement patch when the previously mounted tree is healthy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-replacement-'))
  const name = 'dsh-replacement-patch'
  const { host } = hostWithEntries([entry('mkt-replacement-patch', ACTIVE)])
  try {
    installFixture(dir, name)
    expect(await hotMount(host, dir, name)).toEqual({ ok: true, reason: null })

    const patch = join(dir, 'node_modules', name, 'cordis.patch.yml')
    writeFileSync(patch, "- id: ui-chat\n  disabled: true\n- insert:\n    - id: replacement\n      name: dsh-replacement-patch\n")
    expect(await hotMount(host, dir, name)).toMatchObject({ ok: false, deferred: true })
    expect(host.plugin).toHaveBeenCalledOnce()
  } finally {
    await hotUnmount(name)
    rmSync(dir, { recursive: true, force: true })
  }
})

it('disposes a failed replacement theme before restoring the previously active theme', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-hot-theme-'))
  const previous = 'dsh-previous-theme'
  const replacement = 'dsh-replacement-theme'
  const stopped: string[] = []
  const old = hostWithEntries([entry('mkt-previous-theme', ACTIVE)])
  const failed = hostWithEntries([
    entry('mkt-replacement-skin', ACTIVE),
    entry('mkt-replacement-service', FAILED),
  ])
  const restored = hostWithEntries([entry('mkt-previous-theme', ACTIVE)])
  const plugin = vi.fn((Plugin: unknown, config: unknown) => {
    stopped.push('previous restored')
    return restored.host.plugin(Plugin, config)
  })
  plugin.mockImplementationOnce(failed.host.plugin)
  old.dispose.mockImplementation(() => { stopped.push('previous stopped') })
  failed.dispose.mockImplementation(() => { stopped.push('replacement stopped') })
  registry.loadRegistry.mockResolvedValue({
    updated: '2026-01-01', count: 2, categories: {},
    plugins: [previous, replacement].map(name => ({
      name, owner: 'fixture', category: 'theme', url: `https://github.com/fixture/${name}`,
    })),
  })
  try {
    installFixture(dir, previous)
    installFixture(dir, replacement)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { [previous]: '1.0.0', [replacement]: '1.0.0' },
    }))
    const manager = createThemeManager({ loader: { entries: () => [] }, plugin }, 'desktop', new Set(), dir)

    expect(await hotMount(old.host, dir, previous)).toEqual({ ok: true, reason: null })
    expect(await manager.activateTheme(replacement)).toEqual({
      ok: false,
      reason: expect.stringContaining('mkt-replacement-service'),
    })
    expect(stopped).toEqual(['previous stopped', 'replacement stopped', 'previous restored'])
    expect(listHotMounts()).toContain(previous)
    expect(listHotMounts()).not.toContain(replacement)
    expect(restored.dispose).not.toHaveBeenCalled()
    expect(readDisabled(dir).has(previous)).toBe(false)
  } finally {
    await hotUnmount(previous)
    await hotUnmount(replacement)
    rmSync(dir, { recursive: true, force: true })
  }
})
