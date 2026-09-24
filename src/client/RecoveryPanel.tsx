/**
 * The failure prompt's way out: what to enable at the next start, after a
 * restart the market triggered never came back.
 *
 * The surface this talks to is not the host. When the replacement fails to
 * boot, DSH has already exited — its loader refuses the whole tree for one
 * bad entry — so the detached restart helper starts a small recovery server
 * on the SAME origin (src/recovery.ts). That is why every call here can use
 * the market's ordinary `api()` paths: the origin did not change, only the
 * process answering it. It is also why this module has to tolerate requests
 * that fail outright — the recovery server closes its listener for a moment
 * whenever it hands the port back to a boot attempt.
 *
 * Two surfaces read the same endpoints: this React panel inside the market
 * page (for the tab that clicked restart), and the standalone page the
 * recovery server renders at `/` (for a fresh visit, or when that tab is
 * gone).
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconWarningOutline16 } from './icons.ts'
import css from './Market.module.css'
import { api, type Translate } from './market-data.ts'

/** One entry the boot log named. */
export interface RecoveryFailureEntry {
  name: string
  reason: string
  kind: 'failed' | 'pending' | 'unresolved'
}

/** One installed plugin the recovery surface can switch. */
export interface RecoveryPluginView {
  name: string
  rows: string[]
  enabled: boolean
  protected: boolean
  carrier: boolean
  toggleable: boolean
  note?: string
  implicated: boolean
  reason?: string
}

/** Everything GET /dsh-market/recovery answers with. */
export interface RecoveryView {
  ok: true
  recovery: true
  profile: string
  bootId: string
  scheduledAt: string
  marketVersion: string
  failure: { summary: string; entries: RecoveryFailureEntry[]; tail: string }
  plugins: RecoveryPluginView[]
  /** Names DSH blamed that this surface cannot switch. */
  unmatched: RecoveryFailureEntry[]
  /** Write errors from the last apply, when the choice could not be written in full. */
  lastErrors: string[]
  logPath: string
}

/**
 * The switch positions a surface OPENS on, taken straight from the payload.
 *
 * Extracted because this is the production initialisation both surfaces
 * depend on: the payload already carries the recommended position (off for a
 * plugin this boot blamed — see RecoveryPluginView.enabled in
 * src/recovery.ts), so the client's job is to copy it, not to re-derive it. A
 * test that hand-builds `keep` proves nothing about what a user actually
 * sees, which is how "unticked by default" shipped unimplemented once.
 * @param view - the recovery payload.
 * @returns the initial checkbox state, keyed by plugin name.
 */
export function initialKeep(view: RecoveryView): Record<string, boolean> {
  return Object.fromEntries(view.plugins.map(plugin => [plugin.name, plugin.enabled]))
}

/** Whether a payload really is the recovery surface's answer. */
export function isRecoveryView(value: unknown): value is RecoveryView {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<RecoveryView> & { recovery?: unknown }
  return candidate.recovery === true
    && typeof candidate.failure === 'object' && candidate.failure !== null
    && Array.isArray(candidate.plugins)
}

/**
 * Read the recovery surface, or null when the host (or nothing) answers.
 * @returns the view, or null.
 */
export async function fetchRecovery(): Promise<RecoveryView | null> {
  try {
    const response = await fetch(api('/dsh-market/recovery'), { cache: 'no-store' })
    if (!response.ok) return null
    const body: unknown = await response.json()
    return isRecoveryView(body) ? body : null
  } catch {
    return null
  }
}

/**
 * Write the chosen enable set and ask for a boot.
 *
 * The full desired set travels, not a delta — see src/recovery.ts's
 * applyRecovery for why. A response is not guaranteed: the server closes
 * itself to free the port, so a thrown fetch is the SUCCESS path here, and
 * the caller's job is then to watch for the new boot.
 * @param enabled - plugin names to leave enabled at the next start.
 * @returns whether the write was accepted, with the reason when it was not.
 */
export async function applyRecovery(enabled: readonly string[]): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(api('/dsh-market/recovery/apply'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: [...enabled] }),
    })
    const body = await response.json() as { ok?: unknown; error?: unknown; errors?: unknown }
    if (response.status !== 200 || body.ok !== true) {
      const errors = Array.isArray(body.errors) ? body.errors.map(String) : []
      return { ok: false, error: typeof body.error === 'string' ? body.error : errors.join('; ') }
    }
    return { ok: true }
  } catch {
    // The listener was already released for the boot attempt.
    return { ok: true }
  }
}

/** What the caller wants to know while the port changes hands. */
export interface RecoveryWatch {
  /** A different boot id answered: the host is back. */
  onBoot: (boot: string) => void
  /** The recovery surface answered again: the new composition failed too. */
  onRecovery: (view: RecoveryView) => void
  /** Nothing answered until the deadline; the caller says so. */
  onTimeout: () => void
}

/**
 * Watch the origin through one restart attempt.
 *
 * Every outcome is a legitimate state of this window: the host coming up
 * (reload), the recovery server coming back with a NEW failure (re-render the
 * panel rather than pretend the first attempt is still the story), or silence
 * (the caller's timeout message). Failures of the fetch itself are not
 * failures at all — that is what a released port looks like.
 * @param previousBoot - the boot id the restart started from.
 * @param watch - the callbacks above.
 * @param deadlineMs - how long to keep looking.
 */
export async function watchRestart(
  previousBoot: string,
  watch: RecoveryWatch,
  deadlineMs = 300_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    try {
      const response = await fetch(api('/dsh-market/status'), { cache: 'no-store' })
      const body = await response.json() as { boot?: unknown; recovery?: unknown }
      if (body.recovery === true) {
        const view = await fetchRecovery()
        if (view !== null) {
          watch.onRecovery(view)
          return
        }
      } else if (typeof body.boot === 'string' && body.boot !== previousBoot) {
        watch.onBoot(body.boot)
        return
      }
    } catch {
      // Port released for the boot attempt, or the host is still starting.
    }
    if (Date.now() > deadline) {
      watch.onTimeout()
      return
    }
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
}

/** The panel's own state, kept by the caller so a remount cannot lose it. */
export interface RecoveryPanelProps {
  open: boolean
  view: RecoveryView
  /** The checkbox state, keyed by package name. */
  keep: Record<string, boolean>
  busy: boolean
  onToggle: (name: string, enabled: boolean) => void
  onApply: () => void
  onClose: () => void
  t: Translate
}

/**
 * The checklist itself.
 *
 * Red marks the plugins THIS boot named — not "recently changed", not "maybe
 * suspicious" — because the one question a user has here is "which one do I
 * untick", and an answer that is a guess is worse than no answer.
 */
export function RecoveryPanel(props: RecoveryPanelProps): ReactElement | null {
  const { open, view, keep, busy, onToggle, onApply, onClose, t } = props
  const blamed = useMemo(() => view.plugins.filter(plugin => plugin.implicated), [view])
  const openStandalone = useCallback(() => {
    window.open('/', '_blank', 'noopener,noreferrer')
  }, [])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('recoveryTitle')}
      description={t('recoveryLead')}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={openStandalone}>{t('recoveryStandalone')}</Button>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={onApply}>
            {busy ? t('recoveryApplying') : t('recoveryApply')}
          </Button>
        </>
      )}
    >
      <div className={css.recoverySummary}>
        <IconWarningOutline16 size={14} className={css.bannerIcon} />
        <span>{view.failure.summary || t('recoveryNoSummary')}</span>
      </div>
      {view.lastErrors.length > 0 && (
        <div className={css.recoverySummary}>
          <IconWarningOutline16 size={14} className={css.bannerIcon} />
          <span>{t('recoveryWriteFailed')}{view.lastErrors.join('; ')}</span>
        </div>
      )}
      {view.failure.tail !== '' && (
        <details className={css.recoveryLog}>
          <summary>{t('recoveryRawLog')}</summary>
          <pre>{view.failure.tail}</pre>
        </details>
      )}
      <div className={css.recoveryHint}>
        {blamed.length > 0 ? t('recoveryBlamedHint') : t('recoveryNoBlameHint')}
      </div>
      <div className={css.recoveryList}>
        {view.plugins.map((plugin) => (
          <label
            key={plugin.name}
            className={[
              css.recoveryRow,
              plugin.implicated ? css.recoveryBlamed : '',
              plugin.toggleable ? '' : css.recoveryMuted,
            ].filter(Boolean).join(' ')}
          >
            <input
              type="checkbox"
              checked={keep[plugin.name] ?? plugin.enabled}
              disabled={!plugin.toggleable}
              onChange={event => { onToggle(plugin.name, event.target.checked) }}
            />
            <span className={css.recoveryName}>
              <code>{plugin.name}</code>
              {plugin.carrier && <span className={css.recoveryBadge}>{t('recoveryCarrier')}</span>}
              {plugin.reason !== undefined && <span className={css.recoveryReason}>{plugin.reason}</span>}
              {!plugin.toggleable && <span className={css.recoveryNote}>{plugin.note ?? t('recoveryNotToggleable')}</span>}
            </span>
          </label>
        ))}
      </div>
      {view.unmatched.length > 0 && (
        <div className={css.recoveryNote}>
          {t('recoveryUnmatched')} {view.unmatched.map(entry => entry.name).join(', ')}
        </div>
      )}
      <div className={css.recoveryNote}>{t('recoveryLogPath')} {view.logPath}</div>
    </Modal>
  )
}
