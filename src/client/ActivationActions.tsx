import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './market-data.ts'

type ImmediateAction = 'reload' | 'restart'

/** The install or update is already on disk. Deferring only acknowledges it. */
export function ActivationActions({ t, action, label, working, busy, onImmediate, offerDefer = true }: {
  t: Translate
  action: ImmediateAction | null
  label: string
  working: boolean
  busy: boolean
  onImmediate: () => void
  offerDefer?: boolean
}) {
  const [deferred, setDeferred] = useState(false)
  const [confirming, setConfirming] = useState<ImmediateAction | null>(null)
  const confirmLabel = t(action === 'reload' ? 'reloadMarketNow' : 'restartNow')
  return (
    <>
      {offerDefer && (deferred
        ? <span role="status">{t('activationDeferred')}</span>
        : <Button variant="primary" size="sm" disabled={working} onClick={() => setDeferred(true)}>{t('applyOnRestart')}</Button>)}
      {action !== null && (
        <Button variant="ghost" size="sm" disabled={working || busy} onClick={() => setConfirming(action)}>
          {working ? t('restarting') : label}
        </Button>
      )}
      {action !== null && confirming === action && (
        <Modal
          open
          onClose={() => setConfirming(null)}
          title={confirmLabel}
          description={t(action === 'reload' ? 'reloadMarketWarning' : 'restartHostWarning')}
          footer={(
            <>
              <Button variant="ghost" autoFocus onClick={() => setConfirming(null)}>{t('cancel')}</Button>
              <Button variant="primary" disabled={working || busy} onClick={() => {
                setConfirming(null)
                onImmediate()
              }}>{confirmLabel}</Button>
            </>
          )}
        />
      )}
    </>
  )
}
