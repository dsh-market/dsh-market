// @vitest-environment jsdom
/**
 * The rule that decides whether a queued operation may still run (#523).
 *
 * Unit-level on purpose: the behaviour it exists for is `null` vs a reason,
 * and driving it through the market's DOM could only ever show the reason
 * that happened to win — the two `update` branches differ by one map lookup
 * and look identical on screen.
 */
import { describe, expect, it } from 'vitest'
import { queuedRowApplies, type InstalledMap, type RegistryPlugin, type UpdateStatus } from '../../src/client/market-data.ts'

const plugin = (url: string): RegistryPlugin => ({
  name: url.split('/').slice(-2)[0] ?? 'x', owner: 'o', url, category: 'tools', npm: 'dsh-loop',
  stars: 0, added: '', description: { en: '', zh: '' }, install: '',
})

function world(over: {
  installed?: InstalledMap
  updates?: Record<string, UpdateStatus>
  plugins?: RegistryPlugin[]
} = {}) {
  return {
    installed: over.installed ?? {},
    updates: over.updates ?? {},
    plugins: over.plugins ?? [plugin('https://github.com/o/dsh-loop')],
  }
}

describe('queuedRowApplies', () => {
  it('lets an install run while its catalog entry is still listed', () => {
    expect(queuedRowApplies({ kind: 'install', name: 'dsh-loop', url: 'https://github.com/o/dsh-loop' }, world())).toBeNull()
  })

  it('stops an install whose entry is delisted, or that carries no url', () => {
    expect(queuedRowApplies({ kind: 'install', name: 'dsh-loop', url: 'https://github.com/o/gone' }, world())).toBe('gone')
    expect(queuedRowApplies({ kind: 'install', name: 'dsh-loop' }, world())).toBe('gone')
  })

  it('stops an uninstall once the plugin is gone — the destructive case', () => {
    // Queued at 10:00, removed by hand, market opened at 15:00: without this
    // the row would run, uninstalling something that is not there (or worse,
    // something the user reinstalled under the same name).
    expect(queuedRowApplies({ kind: 'uninstall', name: 'dsh-loop' }, world())).toBe('gone')
    expect(queuedRowApplies({ kind: 'uninstall', name: 'dsh-loop' }, world({ installed: { 'dsh-loop': '^1.0.0' } }))).toBeNull()
  })

  it('keeps an explicit local restore but not a completed or delisted restore (#779)', () => {
    const row = { kind: 'update' as const, name: 'dsh-loop', restore: true }
    const installed = { 'dsh-loop': 'link:../dsh-loop' }
    const updates = { 'dsh-loop': { kind: 'linked', updateAvailable: false } }
    expect(queuedRowApplies(row, world({ installed, updates }))).toBeNull()
    expect(queuedRowApplies(row, world({ installed, updates, plugins: [] }))).toBe('no-update')
    expect(queuedRowApplies(row, world({ installed: { 'dsh-loop': '^1.0.0' }, updates: { 'dsh-loop': { kind: 'npm', updateAvailable: false } } }))).toBe('no-update')
  })

  it('stops an update that has landed or disappeared since it was queued', () => {
    const installed = { 'dsh-loop': '^1.0.0' }
    expect(queuedRowApplies({ kind: 'update', name: 'dsh-loop' }, world({ installed }))).toBe('no-update')
    expect(queuedRowApplies({ kind: 'update', name: 'dsh-loop' }, world({ installed, updates: { 'dsh-loop': { updateAvailable: false } } }))).toBe('no-update')
    expect(queuedRowApplies({ kind: 'update', name: 'dsh-loop' }, world({ installed, updates: { 'dsh-loop': { updateAvailable: true } } }))).toBeNull()
    // Not installed at all: `gone` wins over `no-update`, because the row is
    // about a package that is not there any more.
    expect(queuedRowApplies({ kind: 'update', name: 'dsh-loop' }, world({ updates: { 'dsh-loop': { updateAvailable: true } } }))).toBe('gone')
  })
})
