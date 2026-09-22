/** The official Electron profile is owned by DSH's in-process plugin manager. */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { progress, TARGET_RE, type DesktopPluginRuntime, type InstallResult } from './dsh-cli.ts'

interface ManagedResult {
  application: string
  error?: unknown
  packageResult?: { exitCode: number | null; output?: string }
}

export interface OfficialPluginManagerLike {
  installBundle(spec: string, options?: { requestId?: string }): Promise<ManagedResult>
  removeBundle(name: string): Promise<ManagedResult>
  cancelInstall(requestId: string): Promise<unknown>
}

function failure(message: string, exitCode = 1): InstallResult {
  return { exitCode, timedOut: false, stdout: '', stderr: message, cancelled: false }
}

function detail(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (error === undefined) return 'plugin manager did not explain the failure'
  return JSON.stringify(error)
}

/** Never fall back to `dsh plugin --profile desktop`: that CLI is forbidden. */
export function createOfficialDesktopRuntime(
  managerLookup: () => OfficialPluginManagerLike | undefined,
  profileName: string,
  profileDirectory: string,
): DesktopPluginRuntime {
  let disposed = false
  let active: { requestId?: string; cancelled: boolean; done: Promise<InstallResult> } | undefined

  const runPlugin: DesktopPluginRuntime['runPlugin'] = (profile, argv) => {
    if (disposed) return Promise.resolve(failure('official desktop plugin runtime is disposed', 127))
    if (profile !== profileName) return Promise.resolve(failure('refusing to change a different profile', 127))
    if (active !== undefined) return Promise.resolve({ ...failure('another plugin operation is running', 127), busy: true })
    const manager = managerLookup()
    if (manager === undefined
      || typeof manager.installBundle !== 'function'
      || typeof manager.removeBundle !== 'function'
      || typeof manager.cancelInstall !== 'function') {
      return Promise.resolve(failure('official desktop plugin manager is unavailable; no CLI fallback is allowed', 127))
    }

    // Market sends pnpm argv. Only operations representable by the official
    // manager are accepted; silently dropping pnpm flags would change intent.
    const [command, target, ...extra] = argv
    if (extra.length !== 0 || typeof target !== 'string' || !TARGET_RE.test(target)) {
      return Promise.resolve(failure('this desktop operation is not supported by the official plugin manager', 127))
    }
    let spec = target
    if (command === 'update') {
      try {
        const manifest = JSON.parse(readFileSync(join(profileDirectory, 'package.json'), 'utf8')) as {
          dependencies?: Record<string, string>
        }
        const current = manifest.dependencies?.[target]
        if (current === undefined || /^(?:file:|link:|github:|git\+|https?:)/.test(current)) {
          return Promise.resolve(failure('updating this source requires the official Plugins page', 127))
        }
        spec = `${target}@latest`
      } catch {
        return Promise.resolve(failure('cannot read the desktop profile manifest', 127))
      }
    } else if (command !== 'add' && command !== 'remove') {
      return Promise.resolve(failure('this desktop operation requires the official Plugins page', 127))
    }

    const requestId = command === 'remove' ? undefined : randomUUID()
    progress.active = true
    progress.target = target
    progress.startedAt = Date.now()
    progress.lastLine = 'Using the official desktop plugin manager'
    progress.error = null
    progress.cancelling = false
    let operation: Promise<ManagedResult>
    try {
      operation = command === 'remove'
        ? manager.removeBundle(target)
        : manager.installBundle(spec, { requestId })
    } catch (error) {
      progress.active = false
      return Promise.resolve(failure(detail(error), 127))
    }
    const current = { requestId, cancelled: false, done: Promise.resolve(failure('not started')) }
    active = current
    current.done = operation.then((result): InstallResult => {
      const ok = result.application === 'applied' || result.application === 'restart-required'
      const output = result.packageResult?.output ?? ''
      const message = ok ? '' : detail(result.error)
      if (!ok) progress.error = message
      return {
        exitCode: ok ? 0 : (result.packageResult?.exitCode ?? 1),
        timedOut: false,
        stdout: output,
        stderr: message,
        cancelled: current.cancelled || result.application === 'cancelled',
      }
    }, (error): InstallResult => {
      const message = detail(error)
      progress.error = message
      return failure(message, 127)
    }).finally(() => {
      progress.active = false
      progress.cancelling = false
      if (active === current) active = undefined
    })
    return current.done
  }

  return {
    runPlugin,
    probePnpm: async () => managerLookup() !== undefined,
    provisionPnpm: async () => ({ ok: managerLookup() !== undefined, hint: 'Use the official desktop plugin manager' }),
    cancelActive: () => {
      if (active?.requestId === undefined) return false
      active.cancelled = true
      progress.cancelling = true
      const manager = managerLookup()
      if (manager !== undefined) void manager.cancelInstall(active.requestId).catch(() => {})
      return true
    },
    supportsExactRollbackTarget: target => TARGET_RE.test(target),
    dispose: async () => {
      disposed = true
      if (active?.requestId !== undefined) {
        const manager = managerLookup()
        if (manager !== undefined) void manager.cancelInstall(active.requestId).catch(() => {})
      }
      await active?.done
    },
  }
}
