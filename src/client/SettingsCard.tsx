/**
 * The market's card on the plugin configuration page (dsh >= 0.1.0-rc.7).
 *
 * It manages the market ITSELF — version, update, remove. That is the whole
 * scope on purpose: this page is where a user goes to deal with a plugin,
 * and "which version am I on / update it / get rid of it" is the part of
 * that anybody can act on without knowing how DSH is put together.
 *
 * `allowRestart` deliberately does NOT appear here. It exists for hosts
 * where a supervisor (systemd, launchd, pm2, Docker `restart: always`, a
 * desktop wrapper) owns the process, and its audience is whoever wrote that
 * deployment — a person already editing config, not someone browsing
 * settings. As a switch it read as jargon to everyone else, which is worse
 * than absent: a control you cannot evaluate is a control you cannot safely
 * touch. It remains a config option.
 *
 * ## Why the chrome is hand-built (again), and why it now matches
 *
 * The host's own contract is that "a plugin that ships a browser half owns
 * its own card" — the plugins tab only lays out a flex column and dispatches
 * `settings.plugin.item`. So the container IS ours to draw, and a value
 * import from `dsh-client-ui-settings-plugins` would fail the client
 * bundle-purity gate anyway.
 *
 * What the first version got wrong was drawing something of its own
 * invention: a flat, always-expanded box next to rows that collapse and
 * carry a chevron. The fix is not a different component — `DisclosureRow` is
 * 24px chrome for compact flow rows, a different thing — but the same design
 * tokens, laid out the way the host lays out `PluginCard`. Classes below
 * mirror it one for one, so the market stops looking like it wandered in
 * from another product.
 */

import { createElement as h, Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, IconChevronDownOutline14, IconLoadingOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Market.module.css'
import type { Translate } from './market-data.ts'

/** Keys the market leaves in the browser; cleared when the user purges. */
const BROWSER_KEYS = ['dshm-webdav', 'dshm-gist-id'] as const

export interface SettingsCardProps {
  t: Translate
  /**
   * Retire the market's own entry in the left settings menu.
   *
   * Called once the package is gone. Leaving "插件市场" in the menu after
   * the user removed it is the card asserting something the profile no
   * longer agrees with — and the section behind it can no longer talk to a
   * server that has disposed its routes.
   */
  onRemoved?: () => void
}

/** What `/dsh-market/status` tells this card. */
interface SelfStatus {
  version: string | null
  restart: boolean
  channel: 'stable' | 'beta'
}

/** What `/dsh-market/updates` says about the market's own row. */
interface SelfUpdate {
  updateAvailable: boolean
  latest: string | null
}

type Phase = 'idle' | 'confirming' | 'working' | 'removed' | 'updated' | 'failed'

/**
 * Clear the market's browser-side leftovers.
 *
 * These are the only two things the market keeps in the browser, and the
 * server cannot reach either. Neither holds a credential — the WebDAV
 * password is never persisted and a Gist token is read from the environment,
 * never from disk — so this is tidiness, not a security step, and the copy
 * must not imply otherwise.
 */
export function clearBrowserState(storage: Pick<Storage, 'removeItem'>): void {
  for (const key of BROWSER_KEYS) {
    try { storage.removeItem(key) } catch { /* storage unavailable */ }
  }
}

export function SettingsCard({ t, onRemoved }: SettingsCardProps): ReactElement | null {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<SelfStatus | null>(null)
  const [update, setUpdate] = useState<SelfUpdate | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [purge, setPurge] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Only once the row is opened: the plugin configuration page renders every
  // card at once, and an update check costs a registry round trip.
  //
  // `open` is the ONLY dependency, and re-entry is guarded by a ref rather
  // than by `status`. Keying it on state the effect itself sets meant the
  // first `setStatus` re-ran the effect, whose cleanup dropped the still
  // in-flight update check — so the update row never appeared. Measured by
  // the spec, not reasoned about.
  const probed = useRef(false)
  useEffect(() => {
    if (!open || probed.current) return
    probed.current = true
    let live = true
    void (async () => {
      try {
        const response = await fetch('/dsh-market/status', { cache: 'no-store' })
        const body = (await response.json()) as { version?: string; restart?: boolean; channel?: string }
        if (live) setStatus({ version: body.version ?? null, restart: body.restart === true, channel: body.channel === 'beta' ? 'beta' : 'stable' })
      } catch { if (live) setStatus({ version: null, restart: false, channel: 'stable' }) }
      try {
        const response = await fetch('/dsh-market/updates', { cache: 'no-store' })
        const body = (await response.json()) as { updates?: Record<string, { updateAvailable?: boolean; latest?: string }> }
        const own = body.updates?.['dshmarket'] ?? body.updates?.['dsh-market']
        if (live && own !== undefined) setUpdate({ updateAvailable: own.updateAvailable === true, latest: own.latest ?? null })
      } catch { /* an update check that fails leaves the row without an offer */ }
    })()
    return () => { live = false }
  }, [open])

  const post = useCallback(async (path: string, payload: unknown): Promise<{ ok?: boolean; error?: string }> => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return (await response.json()) as { ok?: boolean; error?: string }
  }, [])

  const onUpdate = useCallback(() => {
    setPhase('working')
    setError(null)
    void (async () => {
      try {
        const body = await post('/dsh-market/update', { name: 'dshmarket' })
        if (body.ok === true) setPhase('updated')
        else { setError(body.error ?? t('setSelfFailed')); setPhase('failed') }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        setPhase('failed')
      }
    })()
  }, [post, t])

  const onRemove = useCallback(() => {
    setPhase('working')
    setError(null)
    void (async () => {
      try {
        const body = await post('/dsh-market/self-uninstall', { confirm: true, purge })
        if (body.ok === true) {
          if (purge) clearBrowserState(localStorage)
          setPhase('removed')
          onRemoved?.()
        } else { setError(body.error ?? t('setSelfFailed')); setPhase('failed') }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        setPhase('failed')
      }
    })()
  }, [onRemoved, post, purge, t])

  const busy = phase === 'working'
  const version = status?.version ?? null
  // A prerelease says so in its own version string; nothing else has to be
  // consulted to know the running build is one.
  const prerelease = version !== null && version.includes('-')

  const onChannel = useCallback((next: 'stable' | 'beta') => {
    setStatus(current => (current === null ? current : { ...current, channel: next }))
    void (async () => {
      try {
        await post('/dsh-market/channel', { channel: next })
        // The offer on screen was computed for the old channel.
        const response = await fetch('/dsh-market/updates?force=1', { cache: 'no-store' })
        const body = (await response.json()) as { updates?: Record<string, { updateAvailable?: boolean; latest?: string }> }
        const own = body.updates?.['dshmarket'] ?? body.updates?.['dsh-market']
        setUpdate(own === undefined ? null : { updateAvailable: own.updateAvailable === true, latest: own.latest ?? null })
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  }, [post])

  /** One label + hint block with an optional action, the host's row shape. */
  const row = (label: string, hint: string, action: ReactElement | null): ReactElement =>
    h('div', { className: css.setRow },
      h('div', { className: css.setLabelBox },
        h('div', { className: css.setLabel }, label),
        h('div', { className: css.setHint }, hint),
      ),
      action,
    )

  // The end state REPLACES the controls rather than sitting beside them: the
  // package is gone from disk, so an update button next to "removed" would
  // offer something that cannot happen.
  const body = phase === 'removed'
    ? row(t('setSelfRemoved'), t('setSelfRemovedHint'), null)
    : h(Fragment, null,
        row(
          update?.updateAvailable === true && update.latest !== null
            ? `${t('setSelfUpdateReady')} ${update.latest}`
            : t('setSelfUpToDate'),
          phase === 'updated' ? t('setSelfUpdatedHint') : t('setSelfUpdateHint'),
          update?.updateAvailable === true && phase !== 'updated'
            ? h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: onUpdate }, t('setSelfUpdate'))
            : null,
        ),
        row(t('setChannel'), status?.channel === 'beta' ? t('setChannelBetaHint') : t('setChannelStableHint'),
          h('div', { className: css.setSeg },
            (['stable', 'beta'] as const).map(id => h('button', {
              key: id,
              type: 'button',
              className: status?.channel === id ? `${css.setSegBtn} ${css.setSegOn}` : css.setSegBtn,
              disabled: busy || status === null,
              onClick: () => { onChannel(id) },
            }, t(id === 'beta' ? 'setChannelBeta' : 'setChannelStable'))),
          )),
        row(t('setSelfRemove'), t('setSelfRemoveHint'),
          phase === 'confirming' || busy
            ? null
            : h(Button, {
                variant: 'outline',
                size: 'sm',
                className: css.setDanger,
                disabled: busy,
                onClick: () => { setPhase('confirming') },
              }, t('setSelfRemove'))),
        phase === 'confirming' || busy
          ? h('div', { className: css.setConfirm },
              h('div', { className: css.setHint }, t('setSelfConfirm')),
              h('label', { className: css.setCheck },
                h('input', { type: 'checkbox', checked: purge, onChange: () => { setPurge(!purge) } }),
                h('span', null, t('setSelfPurge')),
              ),
              // States the consequence of the CURRENT choice, both ways. The
              // default keeps things, and what "keeping" costs — plugins the
              // market switched off stay off, with the UI that could switch
              // them back on about to disappear — is the part a user cannot
              // work out on their own.
              h('div', { className: css.setHint }, purge ? t('setSelfPurgeOn') : t('setSelfPurgeOff')),
              h('div', { className: css.setActions },
                busy
                  ? null
                  : h(Button, {
                      variant: 'ghost',
                      size: 'sm',
                      onClick: () => { setPhase('idle'); setPurge(false) },
                    }, t('setSelfCancel')),
                h(Button, {
                  variant: 'primary',
                  size: 'sm',
                  className: css.setDanger,
                  disabled: busy,
                  icon: busy ? h('span', { className: css.spin }, h(IconLoadingOutline16, { size: 16 })) : undefined,
                  onClick: onRemove,
                }, busy ? t('setSelfWorking') : t('setSelfRemoveConfirm')),
              ),
            )
          : null,
        error !== null ? h('div', { className: css.err }, error) : null,
      )

  return h('div', { className: open ? `${css.setCard} ${css.setCardOpen}` : css.setCard },
    h('button', {
      type: 'button',
      className: css.setHeader,
      'aria-expanded': open,
      onClick: () => { setOpen(!open) },
    },
      h('div', { className: css.setHeadText },
        h('div', { className: css.setName },
          t('nav'),
          version !== null ? h('span', { className: css.version }, ` v${version}`) : null,
          prerelease ? h('span', { className: css.setBetaTag }, t('setChannelBeta')) : null,
        ),
        h('div', { className: css.setDesc }, t('setCardDesc')),
      ),
      h('span', { className: open ? `${css.setChevron} ${css.setChevronOpen}` : css.setChevron },
        h(IconChevronDownOutline14, { size: 14 }),
      ),
    ),
    open ? h('div', { className: css.setBody }, body) : null,
  )
}
