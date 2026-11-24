/**
 * A sponsor's own plugins, pinned at the front of "Recently added" and
 * marked as sponsored for as long as the sponsorship runs (sponsors.json
 * `plugins`: npm names or repository URLs, in sponsor order).
 */
import type { RegistryPlugin } from './market-data.ts'
import { SPONSORS } from './sponsors.generated.ts'

const today = (): string => new Date().toISOString().slice(0, 10)
const keyOf = (value: string): string => value.trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '')

type Sponsor = (typeof SPONSORS)[number]
const active = (sponsors: readonly Sponsor[] = SPONSORS): Sponsor[] =>
  sponsors.filter(sponsor => sponsor.until === null || sponsor.until >= today())

/** The sponsor that owns this plugin, or undefined. */
export function sponsorOfPlugin(plugin: RegistryPlugin, sponsors: readonly Sponsor[] = SPONSORS): Sponsor | undefined {
  const names = [plugin.npm, plugin.url].filter((value): value is string => typeof value === 'string' && value !== '').map(keyOf)
  return active(sponsors).find(sponsor => sponsor.plugins.some(item => names.includes(keyOf(item))))
}

/**
 * The strip with sponsors' plugins first, in sponsor order, whether or not
 * they are recent. Each plugin appears once; `eligible` drops the ones the
 * user has blocked or the host cannot run.
 */
export function withSponsoredFirst(
  all: readonly RegistryPlugin[],
  recent: readonly RegistryPlugin[],
  eligible: (plugin: RegistryPlugin) => boolean = () => true,
  sponsors: readonly Sponsor[] = SPONSORS,
): RegistryPlugin[] {
  const order = active(sponsors).flatMap(sponsor => sponsor.plugins.map(keyOf))
  if (order.length === 0) return [...recent]
  const rank = (plugin: RegistryPlugin): number => {
    const at = order.findIndex(item => item === keyOf(plugin.npm ?? '') || item === keyOf(plugin.url))
    return at === -1 ? order.length : at
  }
  const pinned = all.filter(plugin => rank(plugin) < order.length && eligible(plugin)).sort((a, b) => rank(a) - rank(b))
  return pinned.length === 0 ? [...recent] : [...pinned, ...recent.filter(plugin => !pinned.includes(plugin))]
}
