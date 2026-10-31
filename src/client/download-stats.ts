import type { RegistryPlugin, Translate } from './market-data.ts'

type DownloadStats = Pick<RegistryPlugin, 'downloads' | 'downloadsStart' | 'downloadsEnd' | 'githubReleaseDownloads' | 'githubReleaseDownloadsCheckedAt'>
const validCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Keep the established npm window first; the two sources are never added together. */
export function downloadStatistic(plugin: DownloadStats): { count: number; source: 'npm' | 'github' } | null {
  if (validCount(plugin.downloads)) return { count: plugin.downloads, source: 'npm' }
  if (validCount(plugin.githubReleaseDownloads)) return { count: plugin.githubReleaseDownloads, source: 'github' }
  return null
}

function checkedAt(value: unknown, t: Translate): string {
  if (dateOnly(value)) return t('statisticCheckedAt').replace('{0}', value)
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) return ''
  return t('statisticCheckedAt').replace('{0}', value.slice(0, 16).replace('T', ' ') + ' UTC')
}

export function starStatsText(plugin: Pick<RegistryPlugin, 'stars' | 'starsCheckedAt'>, t: Translate): string | null {
  return validCount(plugin.stars)
    ? t('starsMeaning').replace('{0}', String(plugin.stars)) + checkedAt(plugin.starsCheckedAt, t)
    : null
}

/** Date-only values stay date-only; never derive a window from today's date. */
function dateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** Exact count and, when the catalog sent one, the 30-day window. */
export function downloadStatsText(plugin: DownloadStats, t: Translate): string | null {
  const statistic = downloadStatistic(plugin)
  if (statistic === null) return null
  const { count, source } = statistic
  if (source === 'github') return t('githubReleaseDownloadsMeaning').replace('{0}', String(count))
    + checkedAt(plugin.githubReleaseDownloadsCheckedAt, t)
  const meaning = t('downloadsMeaning').replace('{0}', String(count))
  if (!(dateOnly(plugin.downloadsStart) && dateOnly(plugin.downloadsEnd)
    && plugin.downloadsStart <= plugin.downloadsEnd)) {
    return meaning
  }
  return meaning + t('downloadsWindow')
    .replace('{0}', plugin.downloadsStart)
    .replace('{1}', plugin.downloadsEnd)
}
