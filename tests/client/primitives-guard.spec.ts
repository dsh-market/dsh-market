/**
 * Host-compatibility guard: on hosts whose injected primitives module
 * predates rc.6, the named exports the market renders with are undefined
 * (the module itself resolves, so the bundle factory succeeds). apply()
 * must detect the gap and skip registration instead of throwing mid-render.
 */
import { describe, expect, it, vi } from 'vitest'
import { apply, missingPrimitives, REQUIRED_PRIMITIVES } from '../../src/client/index.ts'
import { ICON_ALIASES, missingIcons } from '../../src/client/icons.ts'

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

describe('apply() icon gaps (#671)', () => {
  it('treats a 0.1.7-only Regular icon table as complete for missingIcons', () => {
    const mod: Record<string, unknown> = {}
    for (const name of REQUIRED_PRIMITIVES) mod[name] = () => null
    for (const [, newer] of ICON_ALIASES) mod[newer] = () => null
    expect(missingPrimitives(mod)).toEqual([])
    expect(missingIcons(mod)).toEqual([])
  })

  it('does not treat icon gaps as a hard apply() disable', () => {
    // Missing Menu still disables; missing icons alone must not — icons.ts
    // skips the glyph so a rename costs one icon, not the settings page.
    const mod: Record<string, unknown> = {}
    for (const name of REQUIRED_PRIMITIVES) mod[name] = () => null
    expect(missingPrimitives(mod)).toEqual([])
    expect(missingIcons(mod).length).toBeGreaterThan(0)
  })
})

/** Like `hostWith`, but keeps each registration's options for inspection. */
function hostWithEntries(declared: readonly string[]) {
  const registrations: Record<string, unknown>[] = []
  const slots = new Set(declared)
  apply({
    effect: (run: () => unknown) => { run() },
    on: () => () => {},
    locale: {
      register: () => () => {}, bind: () => (key: string) => key,
      subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }),
    },
    theme: { getTheme: () => null, setTheme: () => {} },
    slots: {
      inject: (slot: string, register: () => unknown) => { if (slots.has(slot)) register() },
      register: (options: Record<string, unknown>) => { registrations.push(options); return () => {} },
    },
    inject: () => {},
  } as Parameters<typeof apply>[0])
  return { registrations }
}

/** A host that declares only the slots it has, and records what the market did. */
function hostWith(declared: readonly string[]) {
  const registrations: Record<string, unknown>[] = []
  const injections: string[][] = []
  const slots = new Set(declared)
  apply({
    effect: (run: () => unknown) => { run() },
    on: () => () => {},
    locale: {
      register: () => () => {}, bind: () => (key: string) => key,
      subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }),
    },
    theme: { getTheme: () => null, setTheme: () => {} },
    slots: {
      // A real host fires this only for the slots it declares — which is what
      // makes the slot itself the feature detection for the newer card seat.
      inject: (slot: string, register: () => unknown) => { if (slots.has(slot)) register() },
      register: (options: Record<string, unknown>) => { registrations.push(options); return () => {} },
    },
    // The service injections are RECORDED but never fired on this host: that
    // is the "host without settingsScope" case the market must survive.
    inject: (services: string[]) => { injections.push(services) },
  } as Parameters<typeof apply>[0])
  return { registrations: registrations.map(entry => entry.name), injections }
}

it('keeps the main market on hosts without settingsScope (#516)', () => {
  const { registrations, injections } = hostWith(['settings.section', 'shell.overlay'])
  expect(injections).toEqual([['layout'], ['settingsScope']])
  expect(registrations).toEqual(['settings.section', 'shell.overlay'])
})

it('offers the market as a Plugins-page tab on the line that declares one (#722)', () => {
  // 0.1.7 removed `settingsScope` and `settings.plugin.item`, and no host
  // declares `plugins.bundle.config` — so the card had no seat on that line at
  // all and vanished silently. The tab slot is what its contract offers for a
  // page inside the Plugins section, and it is the one the market must follow.
  const { registrations, injections } = hostWith(['settings.section', 'shell.overlay', 'settings.plugins.tab'])
  expect(injections).toEqual([['layout'], ['settingsScope']])
  expect(registrations).toEqual(['settings.section', 'settings.plugins.tab', 'shell.overlay'])
})

it('adds nothing to a sidebar that has panels until the user opts in (#846)', () => {
  // The slot existing is not consent: the row is off by default, so a host
  // with sidebar panels gets exactly the registrations it got before.
  const { registrations } = hostWith(['settings.section', 'shell.overlay', 'sidebar.panellist', 'main'])
  expect(registrations).toEqual(['settings.section', 'shell.overlay'])
})

it('adds the market as a tab on the Plugins page when the host declares one', () => {
  // dsh 0.2.1-alpha.4 added `plugins.tab` to the Plugins page (已安装 | 发现):
  // the host's own Discover tab is a registration into it. The market follows
  // the slot, and everything it registered before stays as it was.
  const host = hostWithEntries(['settings.section', 'shell.overlay', 'plugins.tab'])
  expect(host.registrations.map(entry => entry.name)).toEqual(['settings.section', 'plugins.tab', 'shell.overlay'])
  const tab = host.registrations.find(entry => entry.name === 'plugins.tab')!
  // Placed before the host's Discover (which registers with no order, i.e. 0),
  // so the market sits next to 已安装.
  expect(tab.id).toBe('dsh-market')
  expect(tab.order).toBeLessThan(0)
})

it('adds no Plugins-page tab on hosts that never declare it', () => {
  // Every host before 0.2.1-alpha.4: the slot never arrives, so neither does
  // the registration.
  const host = hostWithEntries(['settings.section', 'shell.overlay'])
  expect(host.registrations.map(entry => entry.name)).not.toContain('plugins.tab')
})

it('places the settings card on the bundle page a 0.1.7 host declares (#677)', () => {
  // The newer line has no plugin-configuration page and no settingsScope; it
  // declares `plugins.bundle.config`, which its own contract names as where a
  // third-party bundle's configuration belongs. The card must follow the
  // slot, and the market must still register everything else.
  const { registrations, injections } = hostWith(['settings.section', 'shell.overlay', 'plugins.bundle.config'])
  expect(injections).toEqual([['layout'], ['settingsScope']])
  expect(registrations).toEqual(['settings.section', 'plugins.bundle.config', 'shell.overlay'])
})

/**
 * #869: the loader runs a client plugin's factory on the boot path, so a
 * throw inside apply() is a throw inside the shell's own bootstrap and takes
 * the whole app down (reported on the Desktop shell). Whatever the cause
 * turns out to be, the market hosting itself in someone else's app must not
 * be able to kill it.
 */
describe('apply() contains a throw from the host (#869)', () => {
  /** A host whose registration of the market's main section throws. */
  function hostWhoseSectionRegistrationThrows() {
    return {
      effect: (run: () => unknown) => { run() },
      on: () => () => {},
      locale: {
        register: () => () => {}, bind: () => (key: string) => key,
        subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }),
      },
      theme: { getTheme: () => null, setTheme: () => {} },
      slots: {
        inject: (slot: string, register: () => unknown) => { if (slot === 'settings.section') register() },
        register: (options: Record<string, unknown>) => {
          if (options.name === 'settings.section') throw new Error('host refused the section')
          return () => {}
        },
      },
      inject: () => {},
    } as Parameters<typeof apply>[0]
  }

  it('does not let the throw escape into the shell, and says so on the console', () => {
    const logged: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args) })
    try {
      expect(() => apply(hostWhoseSectionRegistrationThrows())).not.toThrow()
    } finally {
      spy.mockRestore()
    }
    expect(logged).toHaveLength(1)
    expect(String(logged[0][0])).toContain('[dsh-market] mounting failed')
    // The error object rides along so the console holds the stack, not just
    // a sentence about it.
    expect(logged[0][1]).toBeInstanceOf(Error)
  })

  it('contains a throw from any mount point, not just the first one that fires', () => {
    // Containment is the outer try/catch, so a failure while mounting the
    // overlay toast is caught exactly like the section's. If this ever moves
    // to per-call guards, this test is what fails.
    const host = hostWhoseSectionRegistrationThrows()
    const slots = host.slots as {
      inject: (slot: string, register: () => unknown) => void
      register: (options: Record<string, unknown>) => unknown
    }
    slots.inject = (slot: string, register: () => unknown) => {
      if (slot === 'shell.overlay') register()
    }
    slots.register = () => { throw new Error('host refused the overlay') }

    const logged: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args) })
    try {
      expect(() => apply(host)).not.toThrow()
    } finally {
      spy.mockRestore()
    }
    expect(logged).toHaveLength(1)
    expect(String(logged[0][0])).toContain('[dsh-market] mounting failed')
  })
})
