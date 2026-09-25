import type { RegistryPlugin, Translate } from './market-data.ts'

type DownloadStats = Pick<RegistryPlugin, 'downloads' | 'downloadsStart' | 'downloadsEnd' | 'downloadsCheckedAt'>

/** Date-only values stay date-only; never derive a window from today's date. */
function dateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function checkedAt(value: unknown): value is string {
  if (dateOnly(value)) return true
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false
  return dateOnly(value.slice(0, 10)) && Number.isFinite(Date.parse(value))
}

/** All text comes from this entry's source metadata, not registry.updated. */
export function downloadStatsText(plugin: DownloadStats, t: Translate): string | null {
  const count = plugin.downloads
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return null
  const window = dateOnly(plugin.downloadsStart) && dateOnly(plugin.downloadsEnd)
    && plugin.downloadsStart <= plugin.downloadsEnd
    ? t('downloadsWindow').replace('{0}', plugin.downloadsStart).replace('{1}', plugin.downloadsEnd)
    : t('downloadsWindowUnknown')
  const checked = checkedAt(plugin.downloadsCheckedAt)
    ? t('downloadsChecked').replace('{0}', plugin.downloadsCheckedAt)
    : t('downloadsCheckedUnknown')
  return [t('downloadsMeaning').replace('{0}', String(count)), window, checked].join(' ')
}
