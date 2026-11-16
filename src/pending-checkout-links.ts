/** Checkout links disconnected before replacing a local build. */

import { randomUUID } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hostNodeModulesRoot } from './install.ts'
import { NPM_NAME_RE } from './sources.ts'

export interface PendingCheckoutLink {
  name: string
  spec: string
  rawTarget: string
}

export interface CheckoutRecoveryEntry {
  name: string
  reason: 'profile-busy' | 'package-run' | 'writer-lock' | 'check-failed'
  sourceExists: boolean
}

export interface CheckoutRecoveryStatus {
  checking: boolean
  entries: CheckoutRecoveryEntry[]
}

export class PendingCheckoutLinks {
  readonly file: string

  constructor(profileDirectory: string) {
    this.file = join(profileDirectory, '.dsh-market', 'pending-checkout-links.json')
  }

  list(): PendingCheckoutLink[] {
    let data: { operations?: unknown }
    try {
      data = JSON.parse(readFileSync(this.file, 'utf8')) as typeof data
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return Array.isArray(data?.operations) ? data.operations.filter((item): item is PendingCheckoutLink =>
      item !== null && typeof item === 'object'
      && typeof item.name === 'string' && NPM_NAME_RE.test(item.name)
      && typeof item.spec === 'string' && /^link:.+/i.test(item.spec)
      && typeof item.rawTarget === 'string' && item.rawTarget !== '',
    ) : []
  }

  record(item: PendingCheckoutLink): void {
    this.save([...this.list().filter(itemBefore => itemBefore.name !== item.name), item])
  }

  save(operations: PendingCheckoutLink[]): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp-${randomUUID()}`
    writeFileSync(temporary, JSON.stringify({ operations }), { flag: 'wx' })
    try {
      renameSync(temporary, this.file)
    } catch (error) {
      try { unlinkSync(temporary) } catch { /* preserve the write failure */ }
      throw error
    }
  }
}

/**
 * Claim the same exclusive profile writer lock as rc.3's plugin manager.
 * An occupied lock is left for the host to release or take over.
 */
export function withIdleProfile<T>(profileDirectory: string, action: () => T): T | null {
  const lock = join(profileDirectory, 'package.json.lock')
  let descriptor: number
  try {
    descriptor = openSync(lock, 'wx', 0o600)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || (code === 'EPERM' && lstatSync(lock, { throwIfNoEntry: false }) !== undefined)) return null
    throw error
  }
  try {
    writeFileSync(descriptor, `${process.pid}\n`)
    return action()
  } finally {
    closeSync(descriptor)
    unlinkSync(lock)
  }
}

type HostProfileLock = <T>(file: string, action: () => Promise<T>, options: { waitMs: number }) => Promise<T>

/** Resolve the lock implementation from the host's own plugin manager. */
export async function loadHostProfileLock(installDirectory: string | null): Promise<HostProfileLock | null> {
  if (installDirectory === null) return null
  const nodeModules = hostNodeModulesRoot(installDirectory)
  const belongsToHost = (path: string) => {
    const inside = relative(nodeModules, path)
    return inside !== '' && !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`)
  }
  try {
    const manager = createRequire(join(installDirectory, 'package.json')).resolve('@deepseek-ai/dsh-plugin-manager')
    if (!belongsToHost(manager)) return null
    const atomic = createRequire(manager).resolve('@deepseek-ai/dsh-atomic-write')
    if (!belongsToHost(atomic)) return null
    const module = await import(pathToFileURL(atomic).href) as { withFileLock?: HostProfileLock }
    return typeof module.withFileLock === 'function' ? module.withFileLock : null
  } catch {
    return null
  }
}

/** A pnpm child may survive the process that owned the writer lock. */
export function hasUnsettledPackageRun(profileDirectory: string): boolean {
  try {
    const value = JSON.parse(readFileSync(join(profileDirectory, '.plugin-manager', 'run.json'), 'utf8')) as {
      pid?: number; grouped?: boolean
    } | null
    const pid = value?.pid
    const grouped = value?.grouped
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || typeof grouped !== 'boolean') return true
    try {
      process.kill(grouped && process.platform !== 'win32' ? -pid : pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}
