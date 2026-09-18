// @vitest-environment jsdom
/**
 * The one builder behind both the settings section and `market.render()`
 * (#602).
 *
 * This asserts the WIRING, not the panel: which translate function, which
 * locale, which theme store, which log exporter reach `MarketSection`. That
 * is the part two callers can silently disagree about — the section passes a
 * host-chosen `preferredSubsectionId`, the render entry passes whatever its
 * caller gave it, and a mix-up would only show up as a panel that opens on
 * the wrong tab, in one of the two places, on somebody's machine.
 *
 * The panel itself is covered by market-section.client.spec.tsx.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { marketElement } from '../../src/client/market-element.ts'
import { MarketErrorBoundary } from '../../src/client/ErrorBoundary.tsx'
import { MarketSection } from '../../src/client/MarketSection.tsx'

interface SectionProps {
  t: unknown
  locale: unknown
  theme: unknown
  themeStore: unknown
  preferredSubsectionId?: string
}

function build(overrides: Partial<Parameters<typeof marketElement>[0]> = {}): {
  boundary: ReactElement<{ text: unknown; actions: unknown }>
  section: ReactElement<SectionProps>
  exportLog: ReturnType<typeof vi.fn>
} {
  const exportLog = vi.fn()
  const tree = marketElement({
    t: ((key: string) => key) as never,
    locale: { subscribe: () => () => {}, getSnapshot: () => ({ active: 'zh' }) },
    theme: { setTheme: () => {} },
    themeStore: { subscribe: () => () => {}, getSnapshot: () => null },
    crashText: { title: 'T', hint: 'H', reload: 'R', details: 'D' },
    exportLog,
    ...overrides,
  }) as ReactElement<{ children: ReactElement<SectionProps> }>
  return { boundary: tree as never, section: tree.props.children, exportLog }
}

describe('marketElement', () => {
  it('wraps the panel in the error boundary, for every caller', () => {
    // #293: a crash took the whole tree with it, including the export-log
    // button, so the reports that mattered most could not be produced. A
    // caller that mounted MarketSection directly would reintroduce that.
    const { boundary, section } = build()
    expect(boundary.type).toBe(MarketErrorBoundary)
    expect(section.type).toBe(MarketSection)
  })

  it('passes the panel every dependency it reads', () => {
    const t = (key: string) => `t:${key}`
    const locale = { subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }) }
    const theme = { setTheme: vi.fn() }
    const themeStore = { subscribe: () => () => {}, getSnapshot: () => null }
    const { section } = build({ t: t as never, locale, theme, themeStore })

    expect(section.props.t).toBe(t)
    expect(section.props.locale).toBe(locale)
    expect(section.props.theme).toBe(theme)
    expect(section.props.themeStore).toBe(themeStore)
  })

  it('forwards the host-chosen subsection, and leaves it undefined when absent', () => {
    // The section's slot passes this down per open; the render entry passes
    // whatever its caller gave it. Dropping it would send a host that asked
    // for "installed" to the Discover tab instead.
    expect(build({ preferredSubsectionId: 'installed' }).section.props.preferredSubsectionId).toBe('installed')
    expect(build().section.props.preferredSubsectionId).toBeUndefined()
  })

  it('gives the recovery panel a working log button and its own copy', () => {
    // The button must call the exporter it was handed — this is the control
    // that has to survive a crash, so a no-op here is the whole feature gone.
    const { boundary, exportLog } = build()
    const actions = boundary.props.actions as ReactElement<{ onClick: () => void }>
    actions.props.onClick()
    expect(exportLog).toHaveBeenCalledTimes(1)
    expect(boundary.props.text).toEqual({ title: 'T', hint: 'H', reload: 'R', details: 'D' })
  })

  it('builds a fresh element each time, not one shared tree', () => {
    // Two live callers (the section and a host panel) with different props;
    // a cached element would freeze whichever mounted first.
    const first = marketElement({
      t: ((k: string) => k) as never,
      locale: { subscribe: () => () => {}, getSnapshot: () => ({ active: 'zh' }) },
      theme: { setTheme: () => {} },
      themeStore: { subscribe: () => () => {}, getSnapshot: () => null },
      crashText: { title: 'T', hint: 'H', reload: 'R', details: 'D' },
      exportLog: () => {},
      preferredSubsectionId: 'a',
    })
    const second = marketElement({
      t: ((k: string) => k) as never,
      locale: { subscribe: () => () => {}, getSnapshot: () => ({ active: 'zh' }) },
      theme: { setTheme: () => {} },
      themeStore: { subscribe: () => () => {}, getSnapshot: () => null },
      crashText: { title: 'T', hint: 'H', reload: 'R', details: 'D' },
      exportLog: () => {},
      preferredSubsectionId: 'b',
    })
    expect(first).not.toBe(second)
  })
})
