/**
 * The market's release channels: which build of ITSELF it offers.
 *
 * Only the market follows this. Other plugins are never pulled from a
 * prerelease on the strength of a setting the user made about the market —
 * opting into early builds is volunteering to try THIS plugin early, not to
 * be handed every other author's unreleased work.
 *
 * The model lives in its own module because it is the part with rules
 * rather than plumbing: three channels, one of them hidden, a mapping to
 * npm dist-tags, and a resolution order that has already been got wrong
 * once (see `resolveChannel`).
 */

/** A channel the market can follow. */
export type Channel = 'stable' | 'beta' | 'dev'

/**
 * The npm dist-tag each channel installs from.
 *
 * `dev` is published straight from a branch with no git tag behind it, so a
 * version carries a timestamp and a short SHA (`1.15.0-dev.20260818-3f1432e`)
 * and is never reused. That is what makes a dev build disposable: nothing in
 * the repository's history refers to it.
 */
export const DIST_TAG: Record<Channel, string> = {
  stable: 'latest',
  beta: 'beta',
  dev: 'dev',
}

/**
 * Channels a user may actually pick.
 *
 * `dev` is hidden until developer mode is switched on. Not as decoration:
 * a dev build is published from an unmerged branch by whoever pressed the
 * button, with no promise that it was run by anyone first. Offering that in
 * the same control as "stable" would make it look like a third degree of
 * caution rather than what it is.
 */
export function availableChannels(devMode: boolean): Channel[] {
  return devMode ? ['stable', 'beta', 'dev'] : ['stable', 'beta']
}

/** Whether a channel may be selected at all under the current mode. */
export function channelAllowed(channel: Channel, devMode: boolean): boolean {
  return availableChannels(devMode).includes(channel)
}

/** Narrow an untrusted value to a Channel, or null. */
export function asChannel(value: unknown): Channel | null {
  return value === 'stable' || value === 'beta' || value === 'dev' ? value : null
}

/**
 * Which channel applies right now.
 *
 * A choice on record always wins — including "stable" while a prerelease is
 * running, which is the only way back off a channel. Only the ABSENCE of a
 * choice is derived, and then from what is actually running: installing
 * `dshmarket@beta` by hand IS the subscription, and treating that as
 * "stable" costs updates rather than just clarity — on the stable channel
 * `latest` (1.13.1) is not newer than an installed 1.14.0-beta.1, so the
 * market answers "up to date" and the next beta is never offered.
 *
 * Which makes `undefined` load-bearing: it has to survive both the settings
 * schema (no `.default`) and state.json (field omitted) or "never chose"
 * silently becomes "chose stable".
 *
 * A stored `dev` with developer mode off is treated as NO choice and
 * derived past, rather than honoured. That state is reachable by turning
 * the mode off while dev is selected, or by hand-editing state.json, and
 * silently following a hidden channel is precisely what the mode exists to
 * prevent. Deriving is right rather than picking a substitute: an
 * unusable choice is not evidence of what the user would have picked.
 */
export function resolveChannel(
  setting: Channel | undefined,
  version: string,
  devMode = false,
): Channel {
  if (setting !== undefined && channelAllowed(setting, devMode)) return setting
  return version.includes('-') ? 'beta' : 'stable'
}
