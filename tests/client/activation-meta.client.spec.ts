// @vitest-environment jsdom
/**
 * Activation labels shared by the tabs (#1278).
 *
 * `missing` is a verdict verify.ts really emits — its own reasons line reads
 * "未安装 / not installed" — so the label table has to name it. Without a case
 * it fell through to the '—' placeholder, which is the label for states this
 * file has never heard of: on the installed page that dash sat next to a
 * row still claiming the plugin was switched on.
 *
 * The translate function is the identity here on purpose: these cases are
 * about which key gets chosen, not about the three dictionaries.
 */
import { describe, expect, it } from 'vitest'
import { activationMeta } from '../../src/client/MarketStatusParts.tsx'

const t = (key: string) => key

describe('activationMeta', () => {
  it('names a package that is not on disk instead of leaving a dash', () => {
    expect(activationMeta('missing', t)).toEqual({ label: 'notInstalled', dot: 'error' })
  })

  it('keeps the verdicts it already had', () => {
    expect(activationMeta('live', t)).toEqual({ label: 'stateLive', dot: 'done' })
    expect(activationMeta('restart', t)).toEqual({ label: 'stateRestart', dot: 'warning' })
    expect(activationMeta('broken', t)).toEqual({ label: 'stateBroken', dot: 'error' })
    expect(activationMeta('failed', t)).toEqual({ label: 'stateFailed', dot: 'error' })
    expect(activationMeta('disabled', t)).toEqual({ label: 'stateDisabled', dot: 'warning' })
  })
})
