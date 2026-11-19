import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from './home-paths.ts'

/**
 * The remembered WebDAV password (#1058), opt-in and off by default.
 *
 * The DSH host exposes no secret store to plugins, so the one place it can
 * live is a 0600 file in the market's own state directory under DSH_HOME —
 * outside the profile directory, so exported backups (which walk the profile)
 * never contain it. It is bound to the URL and username it was saved for: a
 * password is never sent to a different server just because the form changed.
 */
export interface RememberedWebdav { url: string; username: string; password: string }

export function webdavSecretFile(home: string = resolveDshHome()): string {
  return join(home, 'dsh-market', 'webdav.json')
}

export function readWebdavSecret(file: string = webdavSecretFile()): RememberedWebdav | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (typeof value.url === 'string' && typeof value.username === 'string' && typeof value.password === 'string' && value.password !== '') {
      return { url: value.url, username: value.username, password: value.password }
    }
  } catch { /* absent or unreadable: nothing remembered */ }
  return null
}

/** The remembered password, only when it was saved for exactly this URL and username. */
export function webdavSecretFor(url: string, username: string, file: string = webdavSecretFile()): string | null {
  const stored = readWebdavSecret(file)
  return stored !== null && stored.url === url && stored.username === username ? stored.password : null
}

export function writeWebdavSecret(value: RememberedWebdav, file: string = webdavSecretFile()): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  try { chmodSync(temp, 0o600) } catch { /* filesystems without POSIX modes */ }
  renameSync(temp, file)
}

export function clearWebdavSecret(file: string = webdavSecretFile()): void {
  rmSync(file, { force: true })
}
