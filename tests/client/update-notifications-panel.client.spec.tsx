// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateNotificationsPanel } from '../../src/client/UpdateNotificationsPanel.tsx'
import { en } from '../../src/client/locales.ts'
import type { UpdateNotificationSnapshot } from '../../src/update-notifications.ts'

const t = (key: string): string => (en as Record<string, string>)[key] ?? key
const snapshot = (overrides: Partial<UpdateNotificationSnapshot> = {}): UpdateNotificationSnapshot => ({
  enabled: true, checking: false, checkedAt: 1000, lastSuccessAt: 1000,
  nextCheckAt: 1_801_000, stale: false, error: null, boot: 'boot',
  updates: {}, updateExempt: [], disabled: [], blocked: [], ...overrides,
})
afterEach(() => { cleanup(); sessionStorage.clear() })

describe('shared update review', () => {
  it('uses the sidebar reminder policy for the summary, including boot-scoped dismissals', () => {
    sessionStorage.setItem('dshm-updates-ignored', JSON.stringify({ boot: 'boot', names: ['dshmarket'] }))
    render(<UpdateNotificationsPanel t={t} busy={false} onUpdate={vi.fn()}
      onCheck={vi.fn()} onEnabled={vi.fn()} snapshot={snapshot({ updates: {
        dshmarket: { kind: 'npm', current: '1.0.0', version: '1.0.0', latest: '2.0.0', updateAvailable: true },
      } })} />)
    expect(screen.getByText(en.updateChecksNone)).toBeTruthy()
    expect(screen.queryByText('dshmarket')).toBeNull()
  })

  it('includes the market and sends generation updates to the host only', () => {
    const onUpdate = vi.fn()
    const onOpenHost = vi.fn()
    render(<UpdateNotificationsPanel t={t} busy={false} onUpdate={onUpdate} onOpenHost={onOpenHost}
      onCheck={vi.fn()} onEnabled={vi.fn()} snapshot={snapshot({ updates: {
        dshmarket: { kind: 'npm', current: '1.0.0', version: '1.0.0', latest: '1.2.0', eligibleVersion: '1.1.0', updateAvailable: true },
        desktopPlugin: { kind: 'generation', current: '1.0.0', version: '1.0.0', latest: '2.0.0', updateAvailable: false },
      } })} />)
    fireEvent.click(screen.getByText(en.updateChecksTitle))
    expect(onUpdate).not.toHaveBeenCalled()
    expect(screen.getByText('1.0.0 → 1.1.0')).toBeTruthy()
    const desktopRow = screen.getByText('desktopPlugin').closest('li')!
    expect(within(desktopRow).queryByRole('button', { name: en.update })).toBeNull()
    fireEvent.click(within(desktopRow).getByRole('button', { name: en.updateChecksOpenHost }))
    expect(onOpenHost).toHaveBeenCalledWith('desktopPlugin')
    fireEvent.click(screen.getByRole('button', { name: en.update }))
    expect(onUpdate).toHaveBeenCalledWith('dshmarket')
  })

  it('keeps known updates during a failed check and never claims everything is current', () => {
    const { rerender } = render(<UpdateNotificationsPanel t={t} busy={false} onUpdate={vi.fn()}
      onCheck={vi.fn()} onEnabled={vi.fn()} snapshot={snapshot({ stale: true, error: 'offline', updates: {
        plugin: { kind: 'npm', current: '1.0.0', version: '1.0.0', latest: '2.0.0', updateAvailable: true },
      } })} />)
    fireEvent.click(screen.getByText(en.updateChecksTitle))
    expect(screen.getAllByText(en.updateChecksFailed)).toHaveLength(1)
    expect(screen.getByText('plugin')).toBeTruthy()
    expect(screen.queryByText(en.updateChecksNone)).toBeNull()
    rerender(<UpdateNotificationsPanel t={t} busy={false} onUpdate={vi.fn()}
      onCheck={vi.fn()} onEnabled={vi.fn()} snapshot={snapshot({ checkedAt: null, lastSuccessAt: null })} />)
    expect(screen.getByText(en.updateChecksPending)).toBeTruthy()
    expect(screen.queryByText(en.updateChecksNone)).toBeNull()
  })

  it('requires an explicit check and reports a failed preference save', async () => {
    const onCheck = vi.fn().mockResolvedValue(undefined)
    const onEnabled = vi.fn().mockRejectedValue(new Error('offline'))
    render(<UpdateNotificationsPanel t={t} busy={false} onUpdate={vi.fn()}
      onCheck={onCheck} onEnabled={onEnabled} snapshot={snapshot()} />)
    fireEvent.click(screen.getByText(en.updateChecksTitle))
    expect(onCheck).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.updateChecksNow }))
    await waitFor(() => expect(screen.getByRole('button', { name: en.updateChecksNow }).hasAttribute('disabled')).toBe(false))
    expect(onCheck).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('checkbox', { name: en.updateChecksAutomatic }))
    await screen.findByText(en.updateChecksFailed)
    expect(onEnabled).toHaveBeenCalledWith(false)
    expect((screen.getByRole('checkbox', { name: en.updateChecksAutomatic }) as HTMLInputElement).checked).toBe(true)
  })
})
