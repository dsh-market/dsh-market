/**
 * The market's own settings namespace: the half that makes `allowRestart`
 * a switch on the plugin configuration page instead of a line the user has
 * to hand-write into cordis.yml.
 *
 * `allowRestart: false` is the documented answer for a host owned by
 * systemd, launchd or pm2 — a supervisor restarts it, so the market's
 * one-click restart must not launch a second one. Until now the only way to
 * say that was editing YAML in the right place with the right indentation,
 * where a stray space stops the profile booting.
 *
 * Only `allowRestart` is exposed. `profile` names which profile this
 * instance manages: it is decided at mount from the composition or the
 * command line, and a running instance cannot switch to another one, so
 * offering it as a field would promise something the write cannot deliver.
 *
 * installSettingsSection rides the scoped fiber, so a host with no settings
 * service — every dsh before 0.1.0-rc.7 — simply never runs any of this and
 * the entry configuration stands as composed. That is why this needs no
 * version check of its own.
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/** Namespace the card on the browser side keys itself to. */
export const MARKET_SETTINGS_NS = settingsNamespace('dsh-market')

/** The market settings a user may edit at runtime. */
export interface MarketSettings {
  allowRestart: boolean
  channel: 'stable' | 'beta'
}

export const MarketSettings: z<MarketSettings> = z.object({
  allowRestart: z.boolean().default(true),
  /**
   * Which npm dist-tag the market offers ITSELF from.
   *
   * Only the market's own updates follow this; other plugins are never
   * pulled from a prerelease on the strength of a setting the user made
   * about the market. Someone opting into betas is volunteering to try this
   * plugin early, not to change what every author ships them.
   */
  channel: z.union([z.const('stable'), z.const('beta')]).default('stable'),
})

/**
 * Wire the namespace so a saved change reaches the routes immediately.
 *
 * The routes read `allowRestart` off this object on every request (the
 * status route reports the capability, the restart route enforces it), so
 * updating it in place is what makes a toggle take effect without a
 * restart — which would be a poor thing to require of a setting whose whole
 * subject is restarting.
 *
 * @param ctx - the plugin context owning the wiring.
 * @param resolved - the live config object the routes read.
 */
export function installMarketSettings(ctx: Context, resolved: { allowRestart?: boolean; channel?: 'stable' | 'beta' }): void {
  // `!== false` is the routes' own reading: an absent value allows restart,
  // so the entry layer this registers must say the same thing rather than
  // presenting "unset" as "off".
  const entry = { allowRestart: resolved.allowRestart !== false, channel: resolved.channel ?? 'stable' as const }
  let source = (): MarketSettings => entry
  installSettingsSection(
    ctx,
    MARKET_SETTINGS_NS,
    MarketSettings,
    entry,
    {
      setSource: (current) => { source = current },
      onChange: () => {
        resolved.allowRestart = source().allowRestart
        resolved.channel = source().channel
      },
    },
  )
}
