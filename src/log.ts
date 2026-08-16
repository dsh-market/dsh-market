/**
 * In-memory event log for issue reports: what the market did and how it
 * failed, exportable as plain text from `/dsh-market/logs`.
 *
 * Privacy: entries are sanitized on write — the home directory collapses to
 * `~`, and common credential shapes (API keys, GitHub/npm tokens, bearer
 * headers) are masked. Nothing is persisted to disk; the buffer dies with the
 * process and holds at most {@link MAX_ENTRIES} entries.
 */

import { homedir } from 'node:os'

export type LogLevel = 'info' | 'warn' | 'error'

interface LogEntry {
  at: string
  level: LogLevel
  event: string
  detail: string
}

const MAX_ENTRIES = 200
const DETAIL_MAX = 600

const entries: LogEntry[] = []

function sanitize(text: string): string {
  return text
    .replaceAll(homedir(), '~')
    // Log-injection guard: control characters (newlines above all) would
    // forge extra lines in the exported log file. The #98 routes pass
    // user-supplied names into logEvent (bundle-order order entries, trial
    // messages), so strip them at the single choke point (issue #98
    // analysis: log filtering).
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_***')
    .replace(/npm_[A-Za-z0-9]{16,}/g, 'npm_***')
    .replace(/bearer\s+\S+/gi, 'Bearer ***')
    .replace(/(authorization|token|apikey|api-key|password)(["':=\s]+)\S+/gi, '$1$2***')
}

/**
 * Append one event, sanitized and truncated.
 * @param level - severity for the export listing.
 * @param event - short machine-ish event name (e.g. `install`, `hot-mount`).
 * @param detail - free-form context; credentials and home paths are masked.
 */
export function logEvent(level: LogLevel, event: string, detail: string): void {
  entries.push({
    at: new Date().toISOString(),
    level,
    event,
    detail: sanitize(detail).slice(0, DETAIL_MAX),
  })
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
}

/**
 * The export document for bug reports.
 * @param header - environment lines to prepend (version, platform — no paths).
 * @returns plain text, newest entry last.
 */
export function exportLogs(header: Record<string, string>): string {
  const head = Object.entries(header).map(([key, value]) => `${key}: ${sanitize(value)}`)
  const lines = entries.map(e => `${e.at} [${e.level}] ${e.event}: ${e.detail}`)
  return [
    '# dsh-market log export',
    ...head,
    '',
    ...(lines.length > 0 ? lines : ['(no events this session)']),
    '',
  ].join('\n')
}
