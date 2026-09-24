// @vitest-environment jsdom
/**
 * The recovery panel's contract, from the browser's side.
 *
 * Two things are worth pinning here. The panel must call the blamed plugins
 * out — an "adjust plugins" screen that does not say WHICH one is a screen
 * that asks the user to guess — and it must survive the one thing that always
 * happens during a recovery restart: the origin stops answering for a while,
 * because the recovery server releases the port for every boot attempt.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement as h } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  applyRecovery, fetchRecovery, initialKeep, isRecoveryView, RecoveryPanel, watchRestart,
  type RecoveryView,
} from '../../src/client/RecoveryPanel.tsx'

const t = (key: string): string => key

function view(overrides: Partial<RecoveryView> = {}): RecoveryView {
  return {
    ok: true,
    recovery: true,
    profile: 'web',
    bootId: '1-1',
    scheduledAt: '2026-09-13T10:00:00.000Z',
    marketVersion: '1.46.1',
    failure: {
      summary: '1 plugin entry did not activate: blamed-plugin',
      entries: [{ name: 'blamed-plugin', reason: 'Error: boom', kind: 'failed' }],
      tail: 'dsh: fatal load failure: ...',
    },
    plugins: [
      {
        // The switch position the payload recommends for a blamed, switchable
        // plugin is OFF (src/recovery.ts sets it; see initialKeep below).
        name: 'blamed-plugin', rows: ['blamed-plugin'], enabled: false, protected: false,
        carrier: false, toggleable: true, implicated: true, reason: 'Error: boom',
      },
      {
        name: 'good-plugin', rows: ['good-plugin'], enabled: true, protected: false,
        carrier: false, toggleable: true, implicated: false,
      },
      {
        name: '@deepseek-ai/dsh-host-webserver', rows: [], enabled: true, protected: true,
        carrier: false, toggleable: false, note: 'host infrastructure', implicated: false,
      },
    ],
    unmatched: [],
    lastErrors: [],
    logPath: '/tmp/dsh-market-restart.err.log',
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('initialKeep', () => {
  it('opens from the payload: a blamed plugin starts unticked, the rest as they are', () => {
    // This is the PRODUCTION initialisation the panel is rendered with. The
    // older tests hand-built `keep`, which is how the payload shipped the
    // right recommendation while both surfaces still ticked everything: the
    // promise "left unticked" was only true in the tests. Pin the real path.
    const keep = initialKeep(view())
    expect(keep['blamed-plugin']).toBe(false)
    expect(keep['good-plugin']).toBe(true)
    // A plugin that cannot be switched keeps its own state.
    expect(keep['@deepseek-ai/dsh-host-webserver']).toBe(true)
  })

  it('renders that state, so the red row really is unticked', () => {
    const payload = view()
    render(h(RecoveryPanel, {
      open: true,
      view: payload,
      keep: initialKeep(payload),
      busy: false,
      onToggle: () => {},
      onApply: () => {},
      onClose: () => {},
      t,
    }))
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.map(box => box.checked)).toEqual([false, true, true])
  })
})

describe('RecoveryPanel write errors', () => {
  it('says the choice could not be written instead of quietly re-booting', () => {
    render(h(RecoveryPanel, {
      open: true,
      view: view({ lastErrors: ['blamed-plugin: row id has unsupported characters'] }),
      keep: initialKeep(view()),
      busy: false,
      onToggle: () => {},
      onApply: () => {},
      onClose: () => {},
      t,
    }))
    expect(screen.getByText(/row id has unsupported characters/)).toBeTruthy()
  })
})

describe('RecoveryPanel', () => {
  it('names the blamed plugin, leaves it unticked, and keeps the rest switchable', () => {
    render(h(RecoveryPanel, {
      open: true,
      view: view(),
      keep: { 'blamed-plugin': false, 'good-plugin': true },
      busy: false,
      onToggle: () => {},
      onApply: () => {},
      onClose: () => {},
      t,
    }))
    // The summary the host produced is what the user reads.
    expect(screen.getByText('1 plugin entry did not activate: blamed-plugin')).toBeTruthy()
    // The reason travels with the plugin, so the red row explains itself.
    expect(screen.getByText('Error: boom')).toBeTruthy()
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.map(box => box.checked)).toEqual([false, true, true])
    // Host infrastructure is listed (the user should see the whole tree) but
    // cannot be switched off from here.
    expect(boxes[2]?.disabled).toBe(true)
  })

  it('reports a toggle by package name', () => {
    const toggled: Array<[string, boolean]> = []
    render(h(RecoveryPanel, {
      open: true,
      view: view(),
      keep: { 'blamed-plugin': true, 'good-plugin': true },
      busy: false,
      onToggle: (name, on) => { toggled.push([name, on]) },
      onApply: () => {},
      onClose: () => {},
      t,
    }))
    fireEvent.click(screen.getAllByRole('checkbox')[0] as HTMLInputElement)
    expect(toggled).toEqual([['blamed-plugin', false]])
  })

  it('applies once, and says so while it is busy', () => {
    const applied = vi.fn()
    render(h(RecoveryPanel, {
      open: true,
      view: view(),
      keep: { 'blamed-plugin': false, 'good-plugin': true },
      busy: true,
      onToggle: () => {},
      onApply: applied,
      onClose: () => {},
      t,
    }))
    const button = screen.getByRole('button', { name: 'recoveryApplying' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(applied).not.toHaveBeenCalled()
  })
})

describe('isRecoveryView', () => {
  it('accepts the recovery payload and rejects the host status payload', () => {
    expect(isRecoveryView(view())).toBe(true)
    // /dsh-market/status answers with this shape while the host is alive; it
    // has no recovery block, and treating it as one would render an empty
    // panel over a working market.
    expect(isRecoveryView({ ok: true, boot: '1-1', version: '1.46.1' })).toBe(false)
    expect(isRecoveryView(null)).toBe(false)
    expect(isRecoveryView('nope')).toBe(false)
  })
})

describe('fetchRecovery', () => {
  it('answers null rather than throwing when nothing is listening', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')))
    expect(await fetchRecovery()).toBeNull()
  })

  it('answers null for a 404 from a host that has no recovery surface', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('nope', { status: 404 })))
    expect(await fetchRecovery()).toBeNull()
  })
})

describe('applyRecovery', () => {
  it('sends the full desired enable set', async () => {
    const bodies: string[] = []
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    })
    expect(await applyRecovery(['good-plugin'])).toEqual({ ok: true })
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({ enabled: ['good-plugin'] })
  })

  it('treats a lost response as the boot attempt it is', async () => {
    // The server closes its listener to free the port; the request may die
    // with it, and calling that a failure would strand the user on a page
    // whose only action reports an error it does not have.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('socket hang up')))
    expect(await applyRecovery([])).toEqual({ ok: true })
  })

  it('surfaces a refused write', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(
      JSON.stringify({ ok: false, errors: ['blamed-plugin: patch layer refused'] }),
      { status: 200 },
    )))
    const result = await applyRecovery([])
    expect(result.ok).toBe(false)
    expect(result.error).toContain('patch layer refused')
  })
})

describe('watchRestart', () => {
  it('reports the new boot when the host comes back', async () => {
    vi.stubGlobal('fetch', (url: string) => {
      if (String(url).includes('/dsh-market/status')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, boot: '2-2' }), { status: 200 }))
      }
      return Promise.reject(new Error('unexpected'))
    })
    const seen: string[] = []
    await watchRestart('1-1', {
      onBoot: boot => { seen.push('boot:' + boot) },
      onRecovery: () => { seen.push('recovery') },
      onTimeout: () => { seen.push('timeout') },
    })
    expect(seen).toEqual(['boot:2-2'])
  })

  it('reports the recovery surface coming back with a new failure', async () => {
    vi.stubGlobal('fetch', (url: string) => {
      if (String(url).includes('/dsh-market/recovery')) {
        return Promise.resolve(new Response(JSON.stringify(view()), { status: 200 }))
      }
      return Promise.resolve(new Response(
        JSON.stringify({ ok: true, boot: '1-1', recovery: true }),
        { status: 200 },
      ))
    })
    const seen: string[] = []
    await watchRestart('1-1', {
      onBoot: () => { seen.push('boot') },
      onRecovery: () => { seen.push('recovery') },
      onTimeout: () => { seen.push('timeout') },
    })
    expect(seen).toEqual(['recovery'])
  })

  it('gives up on the deadline instead of polling forever', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')))
    const seen: string[] = []
    await watchRestart('1-1', {
      onBoot: () => { seen.push('boot') },
      onRecovery: () => { seen.push('recovery') },
      onTimeout: () => { seen.push('timeout') },
    }, 1)
    expect(seen).toEqual(['timeout'])
  })
})
