import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { hotMount, hotUnmount, listHotMounts } from '../src/hot.ts'
import { configurePersistentLog, readPersistentLog } from '../src/log.ts'
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

const ACTIVE = 2
const FAILED = 3
const PENDING = 0

function installFixture(dir: string, name: string): void {
  const pkg = join(dir, 'node_modules', name)
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({
    name, main: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' } },
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
      plugin(Plugin: unknown, config: unknown) {
        const Include = Plugin as new (ctx: { entries: Entry[] }, config: unknown) => unknown
        new Include({ entries }, config)
        return { await: async () => {}, dispose }
      },
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
