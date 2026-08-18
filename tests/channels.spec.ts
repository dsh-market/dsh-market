/**
 * The release-channel model: which build of ITSELF the market offers.
 *
 * Pure rules, so they are asserted directly rather than through a route.
 * Every one of them exists because a previous reading of "channel" was
 * wrong in a way that only showed up in use — a control that appeared to do
 * nothing, a subscriber walked backwards, a hidden channel that was merely
 * unlabelled.
 */

import { describe, expect, it } from 'vitest'
import {
  asChannel, availableChannels, channelAllowed, DIST_TAG, resolveChannel,
} from '../src/channels.ts'

describe('resolveChannel', () => {
  it('treats a prerelease BUILD as the beta channel when nothing is on record', () => {
    // Reported while running 1.14.0-beta.1: the card showed "稳定版" selected,
    // because the build had been installed by hand with @beta and the setting
    // was never touched. That is not only confusing — it costs updates. On
    // the stable channel `latest` (1.13.1) is not newer than an installed
    // 1.14.0-beta.1, so the market answers "up to date" and the NEXT beta is
    // never offered. Installing a beta IS the subscription.
    expect(resolveChannel(undefined, '1.14.0-beta.1')).toBe('beta')
    expect(resolveChannel(undefined, '1.13.1')).toBe('stable')
  })

  it('lets a choice on record win, including the way back off a channel', () => {
    // A setting the user cannot un-set is not a setting.
    expect(resolveChannel('stable', '1.14.0-beta.1')).toBe('stable')
    expect(resolveChannel('beta', '1.13.1')).toBe('beta')
    expect(resolveChannel('stable', '1.13.1')).toBe('stable')
  })

  it('derives past a dev choice that developer mode no longer permits', () => {
    // Reachable by switching the mode off while dev is selected. Honouring
    // the stored value would leave a profile following unreviewed builds
    // with nothing on screen able to say so — the state the mode exists to
    // prevent, arrived at by turning the protection ON.
    expect(resolveChannel('dev', '1.15.0-dev.20260818-abc1234', false)).toBe('beta')
    expect(resolveChannel('dev', '1.13.1', false)).toBe('stable')
    // With the mode on it is an ordinary choice.
    expect(resolveChannel('dev', '1.13.1', true)).toBe('dev')
  })
})

describe('availableChannels', () => {
  it('hides dev until developer mode is on', () => {
    expect(availableChannels(false)).toEqual(['stable', 'beta'])
    expect(availableChannels(true)).toEqual(['stable', 'beta', 'dev'])
  })

  it('agrees with channelAllowed, which is what the route enforces', () => {
    // Two readings of the same rule — one draws the control, one guards the
    // POST. They have to be the same rule or the hidden channel is only
    // unlabelled.
    for (const devMode of [false, true]) {
      for (const channel of ['stable', 'beta', 'dev'] as const) {
        expect(channelAllowed(channel, devMode)).toBe(availableChannels(devMode).includes(channel))
      }
    }
  })
})

describe('asChannel', () => {
  it('accepts only the three, and answers null for anything else', () => {
    expect(asChannel('stable')).toBe('stable')
    expect(asChannel('beta')).toBe('beta')
    expect(asChannel('dev')).toBe('dev')
    for (const junk of ['nightly', 'DEV', '', null, undefined, 0, {}]) {
      expect(asChannel(junk), `accepted ${JSON.stringify(junk)}`).toBeNull()
    }
  })
})

describe('DIST_TAG', () => {
  it('maps every channel to the tag it installs from', () => {
    // `stable` publishes under `latest`, not under `stable` — the names
    // differ, and a mapping is the only place that stays true.
    expect(DIST_TAG).toEqual({ stable: 'latest', beta: 'beta', dev: 'dev' })
  })
})
