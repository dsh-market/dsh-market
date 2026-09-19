/**
 * Host-compatibility guard: on hosts whose injected primitives module
 * predates rc.6, the named exports the market renders with are undefined
 * (the module itself resolves, so the bundle factory succeeds). apply()
 * must detect the gap and skip registration instead of throwing mid-render.
 */
import { describe, expect, it } from 'vitest'
import { apply, missingPrimitives, REQUIRED_PRIMITIVES } from '../../src/client/index.ts'

describe('missingPrimitives', () => {
  it('reports no gaps when every required export exists', () => {
    const mod: Record<string, unknown> = {}
    for (const name of REQUIRED_PRIMITIVES) mod[name] = () => null
    expect(missingPrimitives(mod)).toEqual([])
  })

  it('names the missing exports on an old host', () => {
    const mod: Record<string, unknown> = { Menu: () => null, Toast: () => null }
    expect(missingPrimitives(mod)).toEqual(['DisclosureRow', 'Tooltip'])
  })

  it('reports every requirement when the module is empty', () => {
    expect(missingPrimitives({})).toEqual([...REQUIRED_PRIMITIVES])
  })

  it('accepts a custom requirement list', () => {
    expect(missingPrimitives({ A: 1 }, ['A', 'B', 'C'])).toEqual(['B', 'C'])
  })
})

it('keeps the main market on hosts without settingsScope (#516)', () => {
  const registrations: Record<string, unknown>[] = []
  const injections: string[][] = []
  apply({
    effect: (run: () => unknown) => { run() },
    on: () => () => {},
    locale: {
      register: () => () => {}, bind: () => (key: string) => key,
      subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }),
    },
    theme: { getTheme: () => null, setTheme: () => {} },
    slots: {
      inject: (_slot: string, register: () => unknown) => { register() },
      register: (options: Record<string, unknown>) => { registrations.push(options); return () => {} },
    },
    inject: (services: string[]) => { injections.push(services) },
  } as Parameters<typeof apply>[0])
  expect(injections).toEqual([['settingsScope']])
  expect(registrations.map(entry => entry.name)).toEqual(['settings.section', 'shell.overlay'])
})
