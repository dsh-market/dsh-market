import type { RegistryPlugin, Translate } from './market-data.ts'

type DownloadStats = Pick<RegistryPlugin, 'downloads' | 'downloadsStart' | 'downloadsEnd'>

/** Date-only values stay date-only; never derive a window from today's date. */
function dateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** Exact count and, when the catalog sent one, the 30-day window. */
export function downloadStatsText(plugin: DownloadStats, t: Translate): string | null {
  const count = plugin.downloads
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return null
  const meaning = t('downloadsMeaning').replace('{0}', String(count))
  if (!(dateOnly(plugin.downloadsStart) && dateOnly(plugin.downloadsEnd)
    && plugin.downloadsStart <= plugin.downloadsEnd)) {
    return meaning
  }
  return meaning + t('downloadsWindow')
    .replace('{0}', plugin.downloadsStart)
    .replace('{1}', plugin.downloadsEnd)
}
