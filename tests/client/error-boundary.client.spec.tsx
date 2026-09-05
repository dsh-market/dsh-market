// @vitest-environment jsdom
/**
 * The recovery panel. Its whole purpose is to exist on the one day nothing
 * else does, so the tests are about what survives a crash — a way back, a
 * way to report, and a record in the exported log.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement as h, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MarketErrorBoundary, forgetMarketCrash, lastMarketCrash } from '../../src/client/ErrorBoundary.tsx'
import { clientDiagnostics } from '../../src/client/self-check.ts'

const text = { title: 'Market broke', hint: 'Nothing was changed.', reload: 'Reload', details: 'Error details' }

/** Throws on its first render, renders normally once `heal` is called. */
function Fragile({ broken }: { broken: boolean }) {
  if (broken) throw new Error('removeChild NotFoundError')
  return h('div', null, 'the market')
}

let consoleError: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  // React logs caught errors itself; the boundary logs one too. Neither is
  // the thing under test, and both would drown the run.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  forgetMarketCrash()
})
afterEach(() => {
  consoleError.mockRestore()
  cleanup()
})

describe('MarketErrorBoundary', () => {
  it('renders its children when nothing is wrong', () => {
    render(h(MarketErrorBoundary, { text }, h(Fragile, { broken: false })))
    expect(screen.getByText('the market')).toBeTruthy()
    expect(screen.queryByText(text.title)).toBeNull()
  })

  it('replaces a crash with a panel that explains it and offers a way back', () => {
    render(h(MarketErrorBoundary, { text }, h(Fragile, { broken: true })))
    expect(screen.getByText(text.title)).toBeTruthy()
    // The user's plugins are untouched, and the panel says so — a blank
    // settings page says nothing, which is how this used to read as "the
    // market ate my plugins".
    expect(screen.getByText(text.hint)).toBeTruthy()
    expect(screen.getByRole('button', { name: text.reload })).toBeTruthy()
  })

  it('keeps the export-log action reachable, which is the whole point', () => {
    // #293 went months without a usable log because the export button
    // unmounted along with everything else.
    const exported = vi.fn()
    render(h(MarketErrorBoundary, {
      text,
      actions: h('button', { type: 'button', onClick: exported }, 'Export log'),
    }, h(Fragile, { broken: true })))
    fireEvent.click(screen.getByRole('button', { name: 'Export log' }))
    expect(exported).toHaveBeenCalledOnce()
  })

  it('reloads back into a working tree when the cause is gone', () => {
    function Host() {
      const [broken, setBroken] = useState(true)
      return h('div', null, [
        h('button', { key: 'fix', type: 'button', onClick: () => { setBroken(false) } }, 'fix it'),
        h(MarketErrorBoundary, { key: 'boundary', text }, h(Fragile, { broken })),
      ])
    }
    render(h(Host))
    expect(screen.getByText(text.title)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'fix it' }))
    fireEvent.click(screen.getByRole('button', { name: text.reload }))
    expect(screen.getByText('the market')).toBeTruthy()
  })

  it('still counts as a mounted root, so the log does not read "never mounted"', () => {
    // "The section never mounted" and "the section crashed" are different
    // failures with different causes, and the exported log has to keep
    // telling them apart (#293).
    render(h(MarketErrorBoundary, { text }, h(Fragile, { broken: true })))
    expect(document.querySelectorAll('[data-dsh-market-root]')).toHaveLength(1)
    expect(document.querySelector('[data-dsh-market-crashed]')).toBeTruthy()
  })

  it('records the crash for the exported log, with where it happened', () => {
    expect(lastMarketCrash()).toBeNull()
    render(h(MarketErrorBoundary, { text }, h(Fragile, { broken: true })))

    const crash = lastMarketCrash()
    expect(crash?.message).toBe('removeChild NotFoundError')
    // The component stack is the part a reporter cannot obtain by hand, and
    // the part a minified bundle's JS stack does not give.
    expect(crash?.stack).toContain('Fragile')

    const log = clientDiagnostics()
    expect(log.some(line => line.startsWith('market crash message: removeChild NotFoundError'))).toBe(true)
    expect(log.some(line => line.startsWith('market UI crashed at:'))).toBe(true)
  })

  it('says nothing about crashes in a log exported from a healthy page', () => {
    expect(clientDiagnostics().some(line => line.includes('crash'))).toBe(false)
  })
})
