import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './market-data.ts'
import type { UpdateNotificationSnapshot } from '../update-notifications.ts'
import { HostSwitch } from './optional-primitives.ts'
import { notificationNames } from './update-notifications.ts'
import css from './Market.module.css'

/** The same snapshot that drives the sidebar; actions keep their existing owner. */
export function UpdateNotificationsPanel({ snapshot, t, busy, onCheck, onEnabled, onUpdate, onOpenHost }: {
  snapshot: UpdateNotificationSnapshot
  t: Translate
  busy: boolean
  onCheck(): Promise<unknown>
  onEnabled(enabled: boolean): Promise<unknown>
  onUpdate(name: string): void
  onOpenHost?: (name: string) => void
}) {
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setPending(true)
    setFailed(false)
    try { await action() } catch { setFailed(true) } finally { setPending(false) }
  }
  const entries = notificationNames(snapshot).map(name => [name, snapshot.updates[name]] as const)
  const state = failed || snapshot.stale ? t('updateChecksFailed')
    : snapshot.checking || pending ? t('updateChecksChecking')
      : snapshot.checkedAt === null ? t('updateChecksPending')
        : entries.length > 0 ? t('updateChecksFound').replace('{0}', String(entries.length))
          : t('updateChecksNone')

  return <details className={css.updateChecks} data-dsh-market-update-checks>
    <summary>{t('updateChecksTitle')} <span className={css.updateChecksSummary}>{state}</span></summary>
    <div className={css.updateChecksControls}>
      {HostSwitch !== null
        ? <span className={css.updateChecksToggle}>
            <HostSwitch checked={snapshot.enabled} disabled={pending} label={t('updateChecksAutomatic')}
              onChange={next => { void run(() => onEnabled(next)) }} />
            <span>{t('updateChecksAutomatic')}</span>
          </span>
        : <label><input type="checkbox" checked={snapshot.enabled} disabled={pending}
            onChange={event => { const next = event.target.checked; void run(() => onEnabled(next)) }} /> {t('updateChecksAutomatic')}</label>}
      <Button variant="ghost" size="sm" disabled={pending || snapshot.checking}
        onClick={() => { void run(onCheck) }}>{t('updateChecksNow')}</Button>
    </div>
    <p className={css.updateChecksHint}>{t('updateChecksHint')}</p>
    {(snapshot.stale || failed) && <p role="status" className={css.updateChecksHint}>{t('updateChecksFailedHint')}</p>}
    {snapshot.lastSuccessAt !== null && <p className={css.updateChecksHint}>
      {t('updateChecksLastSuccess').replace('{0}', new Date(snapshot.lastSuccessAt).toLocaleString())}
    </p>}
    {entries.length > 0 && <ul className={css.updateChecksList}>
      {entries.map(([name, status]) => <li key={name}>
        <div className={css.updateChecksPackage}>
          <b>{name}</b>
          <span>{status.version ?? status.current ?? '—'} → {status.eligibleVersion ?? status.latest}</span>
          {status.kind === 'generation' && <span>{t('hostUpdateHint')}</span>}
        </div>
        {status.kind === 'generation'
          ? onOpenHost !== undefined && <Button variant="ghost" size="sm" onClick={() => onOpenHost(name)}>{t('updateChecksOpenHost')}</Button>
          : <Button variant="ghost" size="sm" disabled={busy || snapshot.disabled.includes(name)}
              onClick={() => onUpdate(name)}>{t(status.restoreRequired ? 'restoreOnline' : 'update')}</Button>}
      </li>)}
    </ul>}
  </details>
}
