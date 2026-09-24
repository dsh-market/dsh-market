/** The official Electron profile is owned by DSH's in-process plugin manager. */

import { randomUUID } from 'node:crypto'
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

/**
 * What a user can actually do when the market cannot perform an operation on
 * the official Desktop profile: the app's own Plugins page runs the same
 * managed pipeline. Bilingual, because it is read in the operations panel.
 */
export const OFFICIAL_PAGE_HINT = '官方桌面客户端的这个插件操作需要在「设置 → 插件」里完成；市场无法通过命令行修改桌面端的 profile。 / On the official desktop app, do this from Settings → Plugins; the market cannot change the desktop profile through the command line.'

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
  _profileDirectory: string,
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
      return Promise.resolve(failure(OFFICIAL_PAGE_HINT, 127))
    }

    // Market sends pnpm argv. Only operations representable by the official
    // manager are accepted; silently dropping pnpm flags would change intent.
    const [command, target, ...extra] = argv
    if (extra.length !== 0 || typeof target !== 'string' || !TARGET_RE.test(target)) {
      return Promise.resolve(failure('this desktop operation is not supported by the official plugin manager', 127))
    }
    const spec = target
    // Only `add` and `remove` map onto the manager. `update` reached here
    // only for the #564 in-place re-resolve of a floating git spec; turning
    // it into `name@latest` (as a first draft did) would cross the installed
    // range and ignore the release channel, which is a different operation.
    if (command !== 'add' && command !== 'remove') {
      return Promise.resolve(failure(OFFICIAL_PAGE_HINT, 127))
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
      // `overridden` is a change the manager KEPT (`changed: true`) whose live
      // state differs because another layer — a user patch — overrides it.
      // It is not a failed install: reporting it as one sent the update route
      // into a rollback of a change the manager had already kept.
      const ok = result.application === 'applied'
        || result.application === 'restart-required'
        || result.application === 'overridden'
      const output = [
        result.packageResult?.output ?? '',
        result.application === 'overridden' ? 'the plugin manager kept this change, but another layer overrides whether it is enabled' : '',
      ].filter(Boolean).join('\n')
      const message = ok ? '' : detail(result.error)
      if (!ok) progress.error = message
      return {
        // `||`, not `??`: a failure at stage `enable` follows a SUCCESSFUL
        // pnpm step, so packageResult.exitCode is 0 there — and every route
        // reads exit 0 as success. A failed application must never be 0.
        exitCode: ok ? 0 : (result.packageResult?.exitCode || 1),
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
