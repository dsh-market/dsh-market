/** Persisted choices shared by the profile monitor and its settings UI. */
export const UPDATE_CHECK_INTERVAL_HOURS = [6, 12, 72, 168] as const
export type UpdateCheckIntervalHours = typeof UPDATE_CHECK_INTERVAL_HOURS[number]
export const DEFAULT_UPDATE_CHECK_INTERVAL_HOURS: UpdateCheckIntervalHours = 6

export function isUpdateCheckIntervalHours(value: unknown): value is UpdateCheckIntervalHours {
  return typeof value === 'number' && (UPDATE_CHECK_INTERVAL_HOURS as readonly number[]).includes(value)
}
