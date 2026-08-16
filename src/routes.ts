/**
 * HTTP routes bridging the browser market UI to the host. This layer only
 * parses requests, calls the service modules, and serializes responses —
 * process spawning lives in dsh-cli.ts, filesystem reads in profile.ts,
 * orchestration in install.ts / themes.ts / updates.ts.
 *
 * Security: the install route executes a shell command, so it accepts only
 * same-origin POSTs and only sources present in the curated registry.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadRegistry } from './registry.ts'
import {
  cleanHotDir, hotMount, hotUnmount, listHotMounts,
  mountClientOnlyDeps, readDisabledThemes,
} from './hot.ts'
import { exportLogs, logEvent } from './log.ts'
import {
  BOOT_ID, cancelActive, probePnpm, progress, provisionPnpm, runDshPlugin,
  type PluginCommandRuntime,
} from './dsh-cli.ts'
import { profileDir, readInstalled, readInstalledVersion, readLockCommits, readManifestDeps, restoreManifestDeps, setAllowBuilds } from './profile.ts'
import { findInstalledAlias, gitAllowBuildsKey, installTargetFor } from './sources.ts'
import { isStaleUpdate, parseIgnoredBuilds, parsePrepareNotAllowed, RELEASE_AGE_OVERRIDE, retargetCollections, validateAddedPlugins, withHoistRecovery } from './install.ts'
import { checkUpdates, fetchNpmLatest, invalidateUpdates, isUpgrade, latestPublishedRecently } from './updates.ts'
import { createThemeManager, type LoaderEntry } from './themes.ts'
import { readJsonBody, sameOrigin, sendJson } from './http.ts'
import { restartAllowed, scheduleRestart, trustedRestartRequest } from './restart.ts'
import { verifyActivation } from './verify.ts'
import {
  createProfileBackup, downloadWebdav, MAX_BACKUP_BYTES, restoreProfileBackup, secretFileCount, uploadWebdav,
} from './backup.ts'

export type { LoaderEntry } from './themes.ts'
export type { UpdateStatus } from './updates.ts'

export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

export interface MarketHost {
  webServer: WebServerService
  loader: { entries(): Iterable<LoaderEntry> }
  plugin(plugin: unknown, config: unknown): { await(): Promise<unknown>; dispose(): Promise<unknown> | void }
  on?(event: string, callback: (fiber: { entry?: { options?: { name?: string } } }) => void): () => void
  logger?: { info?(message: string): void; warn(message: string): void }
}

export interface MarketConfig {
  /** Profile the market installs into; matches the profile serving this UI. */
  profile: string
  /** Host-authoritative profile directory; ordinary DSH derives it from DSH_HOME. */
  profileDirectory?: string
  /** Detached self-restart is unsafe under systemd/launchd/pm2; operators can disable it (#14). */
  allowRestart?: boolean
}

const PROFILE_RE = /^[A-Za-z0-9_-]+$/

/**
 * Packages whose build scripts pnpm refused to run, from any of its three
 * reporting shapes: the structured ndjson event (pnpm 11), the human
 * "Ignored build scripts:" line, or the fetcher's git-prepare rejection —
 * which fires BEFORE the package lands in node_modules (#68). Undefined when
 * none, so the field can be spread straight into a JSON response.
 */
function blockedBuilds(result: { ignoredBuilds?: unknown; stdout: string; stderr: string }): string[] | undefined {
  if (Array.isArray(result.ignoredBuilds) && result.ignoredBuilds.length > 0) return result.ignoredBuilds as string[]
  const list = parseIgnoredBuilds(result.stdout, result.stderr)
  if (list.length > 0) return list
  const pending = parsePrepareNotAllowed(result.stdout, result.stderr)
  return pending !== null ? [pending] : undefined
}

/**
 * Register the market's HTTP routes.
 * @param host - Acquired webServer + shell services.
 * @param config - Validated market configuration.
 * @returns Disposer removing every registered route.
 */
export function mountMarketRoutes(
  host: MarketHost,
  config: MarketConfig,
  commandRuntime?: PluginCommandRuntime,
): () => void {
  // Ordinary DSH profile names cross the CLI boundary and keep the legacy
  // allowlist. A host-authoritative explicit directory (DSH Desktop) may
  // legitimately pair with a Unicode or spaced display/profile name.
  if (config.profileDirectory === undefined && !PROFILE_RE.test(config.profile)) {
    throw new Error(`dsh-market: invalid profile name: ${config.profile}`)
  }
  const activeProfileDir = profileDir(config.profile, config.profileDirectory)
  const commands = commandRuntime ?? { runPlugin: runDshPlugin, probePnpm, provisionPnpm, cancelActive }
  // Boot-time wipe: stale hot-mount inputs from a previous session must never
  // survive into a composition where the bundle layer already covers them.
  cleanHotDir(activeProfileDir)
  // The user's persisted theme choice; activateTheme mutates and writes it.
  const disabledThemes = readDisabledThemes(activeProfileDir)
  const themes = createThemeManager(host, config.profile, disabledThemes, activeProfileDir)

  // Client-only packages (dsh.client without dsh.bundle) are invisible to the
  // bundle layer in every boot; the market shim-mounts them so their client
  // bundles are actually served.
  void mountClientOnlyDeps(host, activeProfileDir).then(async (mounted) => {
    if (mounted.length > 0) logEvent('info', 'boot', `client-only shims mounted: ${mounted.join(', ')}`)
    // Replay the user's theme choice: bundle-layer themes they switched away
    // from get live-disabled again (bundle trees are in-memory, so the
    // disable never persists on its own).
    for (const name of disabledThemes) {
      if (await themes.setEntryDisabled(name, true)) logEvent('info', 'boot', `theme kept off: ${name}`)
    }
  })

  // Self-healing guard: dsh's own patch overlay can re-update entries during
  // activation and wipe the runtime disabled flag — whenever a fiber comes up
  // for a theme the user switched off, put it back down.
  host.on?.('internal/plugin', (fiber) => {
    const name = fiber.entry?.options?.name
    if (name !== undefined && disabledThemes.has(name)) void themes.setEntryDisabled(name, true)
  })
  let installing = false
  let restarting = false

  /** Dependency diff vs. a pre-operation snapshot (cancel aftermath). */
  function changedSince(before: Record<string, string>): { changed: string[]; partial: boolean } {
    const now = readInstalled(config.profile, activeProfileDir)
    const changed = new Set<string>()
    for (const [name, spec] of Object.entries(now)) if (before[name] !== spec) changed.add(name)
    for (const name of Object.keys(before)) if (now[name] === undefined) changed.add(name)
    return { changed: [...changed], partial: changed.size > 0 }
  }

  /**
   * Everything live in the running composition: market hot mounts plus
   * bundle-layer loader entries whose fiber is up (loaded at boot). This is
   * the source of truth for verifyActivation's `live` state — without the
   * loader side, every boot-loaded bundle plugin would read as "restart".
   */
  function liveNames(): Set<string> {
    const live = new Set(listHotMounts())
    for (const entry of host.loader.entries()) {
      if (entry.fiber !== undefined && entry.options.name !== undefined) live.add(entry.options.name)
    }
    return live
  }

  /**
   * Drop live hot mounts whose package was removed outside the market
   * (e.g. `dsh plugin remove` in a terminal): the stale mount would keep
   * serving a client bundle that 404s after refresh, wedging the page
   * until a restart (#29 by @SunYanbox).
   */
  async function dropStaleHotMounts(): Promise<void> {
    for (const name of listHotMounts()) {
      if (existsSync(join(activeProfileDir, 'node_modules', name, 'package.json'))) continue
      await hotUnmount(name)
      logEvent('warn', 'hot-sweep', `${name}: package removed outside the market — live mount dropped`)
    }
  }

  /** Every plugin command goes through the pnpm-drift recovery wrapper (#20). */
  const runPlugin = (profile: string, args: string[]) => withHoistRecovery(commands.runPlugin, profile, args)

  async function restoreBackup(value: unknown): Promise<{ files: number; errors: { name: string; error: string }[] }> {
    if (installing) throw new Error('another plugin operation is already running')
    if (!await probePnpm()) throw new Error('pnpm is required to restore plugins')
    installing = true
    const restored = restoreProfileBackup(config.profile, value, activeProfileDir)
    try {
      const result = await runPlugin(config.profile, ['install'])
      if (result.exitCode === 0 && !result.timedOut && !result.cancelled) {
        invalidateUpdates()
        return { files: restored.files, errors: [] }
      }

      // A bad dependency makes pnpm abort the whole install. Retry from an
      // empty dependency list so one broken plugin cannot block the rest.
      // activeProfileDir, NOT profileDir(config.profile): in DSH Desktop the
      // profile directory is host-authoritative (#72) and the ambient
      // derivation would edit the WRONG profile's manifest.
      const manifestFile = join(activeProfileDir, 'package.json')
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
        dependencies?: Record<string, string>
        dsh?: { profile?: { bundles?: string[] } }
      }
      const dependencies = Object.entries(manifest.dependencies ?? {})
      const desiredBundles = [...(manifest.dsh?.profile?.bundles ?? [])]
      const dependencyNames = new Set(dependencies.map(([name]) => name))
      manifest.dependencies = {}
      if (Array.isArray(manifest.dsh?.profile?.bundles)) {
        manifest.dsh.profile.bundles = desiredBundles.filter(bundle => !dependencyNames.has(bundle))
      }
      writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
      const errors: { name: string; error: string }[] = []
      let installed = 0
      for (const [name, spec] of dependencies) {
        const target = /^(?:file|link|github|git\+|https?):/.test(spec) ? spec : `${name}@${spec}`
        try {
          const item = await runPlugin(config.profile, ['add', target])
          if (item.exitCode === 0 && !item.timedOut && !item.cancelled
            && existsSync(join(activeProfileDir, 'node_modules', name, 'package.json'))) {
            installed += 1
            if (desiredBundles.includes(name)) {
              const current = JSON.parse(readFileSync(manifestFile, 'utf8')) as typeof manifest
              current.dsh ??= {}
              current.dsh.profile ??= {}
              current.dsh.profile.bundles ??= []
              if (!current.dsh.profile.bundles.includes(name)) current.dsh.profile.bundles.push(name)
              writeFileSync(manifestFile, `${JSON.stringify(current, null, 2)}\n`)
            }
            continue
          }
          errors.push({ name, error: (item.stderr || item.stdout || 'pnpm failed').trim().slice(-300) })
        } catch (error) {
          errors.push({ name, error: error instanceof Error ? error.message : String(error) })
        }
        const current = JSON.parse(readFileSync(manifestFile, 'utf8')) as typeof manifest
        if (current.dependencies !== undefined) delete current.dependencies[name]
        writeFileSync(manifestFile, `${JSON.stringify(current, null, 2)}\n`)
      }
      if (installed === 0 && dependencies.length > 0) {
        restored.rollback()
      }
      invalidateUpdates()
      return { files: restored.files, errors }
    } catch (error) {
      restored.rollback()
      throw error
    } finally {
      installing = false
    }
  }

  const disposers = [
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/backup',
      handler: (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        // Profile exports carry configuration that may include credentials
        // (config.toml, .env, …), so they are limited to same-origin loopback
        // requests exactly like process control (review #63).
        if (!trustedRestartRequest(request)) {
          sendJson(response, 403, { error: 'backup export is limited to same-origin loopback requests' })
          return
        }
        try {
          const data = createProfileBackup(config.profile, activeProfileDir)
          const backup = JSON.stringify(data, null, 2)
          const timestamp = new Date(data.createdAt).toLocaleString('sv-SE').replace(/\D/g, '')
          response.writeHead(200, {
            'cache-control': 'no-store',
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="dsh-dshmarket-backup-${timestamp}.json"`,
          })
          response.end(backup)
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/restore',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) return sendJson(response, 403, { error: 'untrusted origin' })
        try {
          const body = await readJsonBody(request, MAX_BACKUP_BYTES + 4096) as { backup?: unknown }
          sendJson(response, 200, { ok: true, ...await restoreBackup(body.backup) })
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/webdav',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) return sendJson(response, 403, { error: 'untrusted origin' })
        try {
          const body = await readJsonBody(request) as { action?: unknown; url?: unknown; username?: unknown; password?: unknown }
          const url = typeof body.url === 'string' ? body.url : ''
          const username = typeof body.username === 'string' ? body.username : ''
          const password = typeof body.password === 'string' ? body.password : ''
          if (body.action === 'backup') {
            await uploadWebdav(url, username, password, createProfileBackup(config.profile, activeProfileDir))
            sendJson(response, 200, { ok: true })
          } else if (body.action === 'restore') {
            // The preview flow first returns the downloaded backup so the
            // client can show what will be restored; the real restore then
            // posts it to /dsh-market/restore, where downloadWebdav's strict
            // validation guarantees the fetch result is never blindly echoed
            // (review #63).
            sendJson(response, 200, { ok: true, backup: await downloadWebdav(url, username, password) })
          } else sendJson(response, 400, { error: 'invalid WebDAV action' })
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/registry',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        try {
          const { registry, source } = await loadRegistry()
          sendJson(response, 200, { source, registry })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/installed',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        await dropStaleHotMounts()
        const installed = readInstalled(config.profile, activeProfileDir)
        const present = Object.keys(installed).filter(
          name => readInstalledVersion(config.profile, name, activeProfileDir) !== null,
        )
        const activation: Record<string, ReturnType<typeof verifyActivation>> = {}
        const live = liveNames()
        for (const name of Object.keys(installed)) {
          activation[name] = verifyActivation(config.profile, name, live, activeProfileDir)
        }
        sendJson(response, 200, {
          profile: config.profile,
          installed,
          present,
          activation,
          live: listHotMounts(),
        })
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/use-skin',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { name?: unknown }
          const name = typeof body.name === 'string' ? body.name : ''
          const installed = readInstalled(config.profile, activeProfileDir)
          const themeNames = await themes.installedThemeNames()
          if (installed[name] === undefined || !themeNames.has(name)) {
            sendJson(response, 400, { error: 'not an installed theme' })
            return
          }
          const activated = await themes.activateTheme(name)
          logEvent(activated ? 'info' : 'error', 'use-skin', `${name}: ${activated ? 'active' : 'failed'}`)
          sendJson(response, activated ? 200 : 502, { ok: activated, live: listHotMounts() })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logEvent('error', 'use-skin', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/status',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        await dropStaleHotMounts()
        sendJson(response, 200, {
          active: progress.active,
          target: progress.target,
          seconds: progress.active ? Math.round((Date.now() - progress.startedAt) / 1000) : 0,
          lastLine: progress.lastLine,
          phase: progress.phase,
          done: progress.done,
          total: progress.total,
          currentPackage: progress.currentPackage,
          downloaded: progress.downloaded,
          size: progress.size,
          ndjson: progress.ndjson,
          error: progress.error,
          cancelling: progress.cancelling,
          pnpm: await commands.probePnpm(),
          boot: BOOT_ID,
          restart: restartAllowed(config),
          installed: readInstalled(config.profile, activeProfileDir),
        })
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/logs',
      handler: (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        let version = 'unknown'
        try {
          version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? version
        } catch { /* export still works without the version line */ }
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="dsh-market-log.txt"',
        })
        response.end(exportLogs({
          'dsh-market': version,
          platform: `${process.platform} ${process.arch}`,
          node: process.version,
          profile: config.profile,
        }))
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/updates',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        try {
          const force = (request.url ?? '').includes('force=1')
          sendJson(response, 200, { updates: await checkUpdates(config.profile, force, activeProfileDir) })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/update',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        if (installing) {
          sendJson(response, 409, { error: 'another install is already running' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { name?: unknown; force?: unknown }
          const name = typeof body.name === 'string' ? body.name : ''
          const force = body.force === true
          const spec = readInstalled(config.profile, activeProfileDir)[name]
          if (spec === undefined) {
            sendJson(response, 400, { error: 'plugin is not installed' })
            return
          }
          if (spec.startsWith('link:') || spec.startsWith('file:')) {
            sendJson(response, 400, { error: 'locally linked plugins update from their checkout' })
            return
          }
          const beforeInstalled = readInstalled(config.profile, activeProfileDir)
          // Re-running add re-resolves the source: git HEAD for github specs,
          // dist-tag latest for registry installs.
          const isGit = spec.startsWith('github:')
          const target = isGit ? spec.replace(/#.*$/, '') : `${name}@latest`
          // Never let `@latest` walk a profile BACKWARDS (#64 by @ZeroOrigin64):
          // a package whose latest dist-tag was left on an older release turns
          // this update into a downgrade that also rewrites an exact pin to
          // `@latest`. Detection already hides the button; this guards the
          // route itself. Unreadable versions fall through and update as before.
          if (!isGit) {
            const installedVersion = readInstalledVersion(config.profile, name, activeProfileDir)
            const registryLatest = await fetchNpmLatest(name)
            if (installedVersion !== null && registryLatest !== null && !isUpgrade(installedVersion, registryLatest)) {
              logEvent('info', 'update', `${name} refused: latest=${registryLatest} is not newer than installed=${installedVersion}`)
              sendJson(response, 400, {
                error: `已是最新：registry 的 latest 是 ${registryLatest}，不高于已装的 ${installedVersion}，更新会造成降级。 / Already current: the registry's latest (${registryLatest}) is not newer than the installed ${installedVersion}, so updating would downgrade it.`,
              })
              return
            }
          }
          const repoKey = isGit ? spec.slice('github:'.length).replace(/#.*$/, '').toLowerCase() : null
          const beforeVersion = readInstalledVersion(config.profile, name, activeProfileDir)
          const beforeCommit = repoKey !== null
            ? readLockCommits(config.profile, activeProfileDir).get(repoKey) ?? null
            : null
          installing = true
          try {
            // force: the user chose to install a fresh release without the
            // default one-day safety wait; scoped to this single command.
            const addArgs = force ? ['add', RELEASE_AGE_OVERRIDE, target] : ['add', target]
            // RAW manifest snapshot for failure rollback (#65) — pnpm writes
            // package.json before it finishes, so a hard-failed add leaves
            // ghost/bumped entries that break every later pnpm run.
            const manifestBefore = readManifestDeps(config.profile, activeProfileDir)
            const result = await runPlugin(config.profile, addArgs)
            const cancelled = result.cancelled
            if ((result.exitCode !== 0 || result.timedOut) && !cancelled) {
              const rolledBack = restoreManifestDeps(config.profile, manifestBefore, activeProfileDir)
              if (rolledBack.length > 0) logEvent('warn', 'update', `${name}: rolled back manifest residue of the failed run: ${rolledBack.join(', ')}`)
            }
            let ok = result.exitCode === 0 && !result.timedOut && !cancelled
            let stale = false
            let activation: Record<string, ReturnType<typeof verifyActivation>> | undefined
            if (ok) {
              stale = isStaleUpdate({
                isGit,
                beforeVersion,
                afterVersion: readInstalledVersion(config.profile, name, activeProfileDir),
                beforeCommit,
                afterCommit: repoKey !== null
                  ? readLockCommits(config.profile, activeProfileDir).get(repoKey) ?? null
                  : null,
              })
              if (stale) ok = false
            }
            if (ok) {
              invalidateUpdates()
              activation = { [name]: verifyActivation(config.profile, name, liveNames(), activeProfileDir) }
            }
            // Diagnose the stale outcome with EVIDENCE (#45 by @ayingQAQ):
            // only blame pnpm's fresh-release wait when the target's latest
            // release really is young; otherwise be honest that the cause is
            // unconfirmed. Git installs never hit the age gate.
            const youngRelease = stale && !isGit ? await latestPublishedRecently(name) : false
            const staleReason = stale ? (youngRelease === true ? 'release-age' : 'unknown') : null
            const staleError = !stale
              ? null
              : staleReason === 'release-age'
                ? '这个新版本刚发布不久。为了安全，系统默认会等它发布满一天后再安装——刚发布的版本偶尔会被发现问题然后撤回。可以明天再试，或点「立即更新」不再等待。 / This version was just released; for safety, installs normally wait about a day after a release. Try again tomorrow, or click "Update now" to install it right away.'
                : '更新命令执行完成，但版本没有变化，原因未能确认。点「立即更新」重试通常能解决；若仍不行，请导出日志反馈。 / The update command completed but the version did not change; the cause could not be confirmed. Clicking "Update now" to retry usually resolves it — if not, export the log and report it.'
            const cancelDiff = cancelled ? changedSince(beforeInstalled) : null
            // Build-script blocks hit updates too (#69): a leftover invalid
            // allowBuilds entry (pnpm's placeholder bug, #56) or a newly
            // build-required dep fails the add with ERR_PNPM_IGNORED_BUILDS.
            // Reporting the blocked packages here gives the client the same
            // approve-and-retry banner the install flow has had since #6.
            const ignoredBuilds = ok || cancelled ? undefined : blockedBuilds(result)
            logEvent(ok || cancelled ? 'info' : 'error', 'update',
              `${name} -> ${target} exit=${String(result.exitCode)}${result.timedOut ? ' TIMEOUT' : ''}${cancelled ? ' CANCELLED' : ''}${stale ? ` STALE(${staleReason ?? 'unknown'})` : ''}${ok || cancelled ? '' : ` stderr=${result.stderr.slice(-300)}`}`)
            // A user-cancelled run is a quiet outcome, not an error.
            sendJson(response, ok || cancelled ? 200 : result.busy === true ? 409 : 502, {
              ok,
              cancelled: cancelled || undefined,
              busy: result.busy || undefined,
              stale: stale || undefined,
              partial: cancelDiff?.partial,
              changed: cancelDiff?.changed,
              activation,
              ignoredBuilds,
              staleReason: staleReason ?? undefined,
              error: staleError ?? undefined,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              stdout: result.stdout,
              stderr: result.stderr,
              installed: readInstalled(config.profile, activeProfileDir),
            })
          } finally {
            installing = false
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          host.logger?.warn(`[dsh-market] update failed: ${message}`)
          logEvent('error', 'update', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/setup-pnpm',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          const result = await commands.provisionPnpm()
          sendJson(response, 200, { ok: result.ok, error: result.hint })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/restart',
      handler: (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        // One-click restart contributed in #14 by @ysyyhhh.
        if (!restartAllowed(config)) {
          sendJson(response, 403, { error: 'self-restart is disabled for this host' })
          return
        }
        if (!trustedRestartRequest(request)) {
          sendJson(response, 403, { error: 'restart is limited to same-origin loopback requests' })
          return
        }
        if (installing) {
          sendJson(response, 409, { error: 'cannot restart while a plugin operation is running' })
          return
        }
        if (restarting) {
          sendJson(response, 409, { error: 'restart already scheduled' })
          return
        }
        restarting = true
        try {
          const result = scheduleRestart()
          logEvent('info', 'restart', `scheduled pid=${String(result.pid)} helper=${String(result.helperPid)}`)
          sendJson(response, 202, { ok: true, boot: BOOT_ID, ...result })
        } catch (error) {
          restarting = false
          const message = error instanceof Error ? error.message : String(error)
          logEvent('error', 'restart', message)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/approve-builds',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          // One-click build-script approval (#6 by @qichuang321): only
          // packages physically present in the profile's installed tree can
          // be allowed — the list is not free input. Presence is checked in
          // node_modules, NOT the dependencies map: pnpm's blocked build
          // scripts are usually TRANSITIVE deps (cloudflared, ssh2,
          // cpu-features…), which never appear in package.json (#56 by
          // @walnut1218).
          // pnpm 11's ndjson `ignored-scripts` event reports version-qualified
          // names (cloudflared@0.7.3); strip the @version suffix so the
          // allowlist keys and node_modules lookups use bare package names.
          const stripVersion = (name: string): string => {
            const at = name.lastIndexOf('@')
            return at > 0 ? name.slice(0, at) : name
          }
          const PKG_RE = /^(@[A-Za-z0-9-~][A-Za-z0-9._~-]*\/)?[A-Za-z0-9-~][A-Za-z0-9._~-]*$/
          const body = (await readJsonBody(request)) as { packages?: unknown }
          const requested = (Array.isArray(body.packages) ? body.packages.map(String).map(stripVersion) : [])
            .filter(name => PKG_RE.test(name))
          const installed = requested
            .filter(name => existsSync(join(activeProfileDir, 'node_modules', name, 'package.json')))
          // Git-hosted plugins rejected by pnpm's FETCHER (#68) exist in
          // neither node_modules nor package.json — the only trusted anchor
          // left is the curated registry itself: a name that resolves to a
          // github-sourced catalog entry may be approved pre-materialization.
          //
          // pnpm only matches a git-hosted dep's allowBuilds entry under its
          // stable `name@git+https://…` key (#68/#69) — a bare name entry is
          // ignored (verified against pnpm 11.21). Derive that key wherever
          // the github source is known: from the profile spec for installed
          // deps, from the curated registry for pending ones. The bare name
          // is kept alongside — it authorizes the npm-sourced case.
          const specs = readInstalled(config.profile, activeProfileDir)
          const packages: string[] = []
          for (const name of requested) {
            if (installed.includes(name)) {
              packages.push(name)
              const key = gitAllowBuildsKey(name, String(specs[name] ?? ''))
              if (key !== null) packages.push(key)
              continue
            }
            if (specs[name] !== undefined) continue
            const { registry } = await loadRegistry()
            const entry = registry.plugins.find(p => p.name === name || p.npm === name)
            const target = entry === undefined ? null : installTargetFor(entry)
            const key = target === null ? null : gitAllowBuildsKey(name, target)
            if (key !== null) {
              packages.push(name, key)
            }
          }
          if (packages.length === 0) {
            sendJson(response, 400, { error: 'no installed packages given' })
            return
          }
          const approved = setAllowBuilds(config.profile, packages, activeProfileDir)
          logEvent('info', 'approve-builds', `allowed build scripts: ${approved.join(', ')}`)
          sendJson(response, 200, { ok: true, approved })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logEvent('error', 'approve-builds', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/cancel',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        // Cancel flow contributed in #6 by @qichuang321.
        if (!commands.cancelActive()) {
          sendJson(response, 400, { error: 'no operation is running' })
          return
        }
        logEvent('info', 'cancel', `cancelled ${progress.target || 'operation'}`)
        sendJson(response, 200, { ok: true, cancelled: true, target: progress.target })
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/uninstall',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        if (installing) {
          sendJson(response, 409, { error: 'another install is already running' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { name?: unknown }
          const name = typeof body.name === 'string' ? body.name : ''
          if (name === 'dsh-market' || name === 'dshmarket') {
            sendJson(response, 400, { error: 'the market cannot uninstall itself; use the dsh CLI' })
            return
          }
          if (readInstalled(config.profile, activeProfileDir)[name] === undefined) {
            sendJson(response, 400, { error: 'plugin is not installed' })
            return
          }
          const beforeInstalled = readInstalled(config.profile, activeProfileDir)
          const activation = {
            [name]: verifyActivation(config.profile, name, liveNames(), activeProfileDir),
          }
          installing = true
          try {
            const result = await runPlugin(config.profile, ['remove', name])
            const cancelled = result.cancelled
            const ok = result.exitCode === 0 && !result.timedOut && !cancelled
            const cancelDiff = cancelled ? changedSince(beforeInstalled) : null
            let hot = false
            if (ok) {
              invalidateUpdates()
              hot = await hotUnmount(name)
              // Bundle-layer plugins never hot-mount, but their loader entry
              // is still LIVE in this process — after the remove deleted the
              // package, the next refresh would 404 on its client bundle and
              // wedge the whole page until a dsh restart (#37 by
              // @1123762794). Live-disable the entry so the refresh composes
              // without it; after a real restart the entry is gone anyway.
              if (!hot) hot = await themes.setEntryDisabled(name, true)
            }
            logEvent(ok || cancelled ? 'info' : 'error', 'uninstall',
              `${name} exit=${String(result.exitCode)}${cancelled ? ' CANCELLED' : ''}${ok ? ` live-removed=${String(hot)}` : cancelled ? '' : ` stderr=${result.stderr.slice(-300)}`}`)
            sendJson(response, ok || cancelled ? 200 : result.busy === true ? 409 : 502, {
              ok,
              cancelled: cancelled || undefined,
              busy: result.busy || undefined,
              hot,
              partial: cancelDiff?.partial,
              changed: cancelDiff?.changed,
              // The state of the package that was just removed (captured pre-op).
              activation,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              installed: readInstalled(config.profile, activeProfileDir),
            })
          } finally {
            installing = false
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          host.logger?.warn(`[dsh-market] uninstall failed: ${message}`)
          logEvent('error', 'uninstall', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/install',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        if (installing) {
          sendJson(response, 409, { error: 'another install is already running' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { url?: unknown }
          const url = typeof body.url === 'string' ? body.url : ''
          const { registry } = await loadRegistry()
          const entry = registry.plugins.find(p => p.url.toLowerCase() === url.toLowerCase())
          if (entry === undefined) {
            logEvent('warn', 'install-rejected', `not in curated registry: ${url.slice(0, 120)}`)
            sendJson(response, 400, { error: 'plugin is not in the curated registry' })
            return
          }
          const target = installTargetFor(entry)
          if (target === null) {
            sendJson(response, 400, { error: 'unsupported source url' })
            return
          }
          // Duplicate guard (#27): the same plugin listed under another name
          // (an alias entry pointing at the same repo) must never install
          // twice — two loader entries with one id brick the next boot.
          // Monorepo subpath entries (distinct plugins in one repo) pass:
          // their entry urls differ by subpath and identity is name-based.
          // A dependency left in package.json by a FAILED install (blocked
          // build scripts: pnpm writes the manifest, then exits 1) is NOT a
          // duplicate — it was never activated. Blocking the retry would
          // make the approve-builds flow dead-end, so a leftover that is the
          // SAME package/source (not a repo-only alias of a different entry)
          // and is not yet active (bundle layer or live mount) may be retried.
          const installedNow = readInstalled(config.profile, activeProfileDir)
          const aliasOf = findInstalledAlias(entry, installedNow)
          // When the duplicate guard allows a retry of a leftover dep, that
          // name must be treated as "newly added" by the post-install
          // validation and hot-mount below (it IS in package.json from the
          // failed attempt, so the plain before/after diff would miss it).
          let retryAlias: string | null = null
          if (aliasOf !== null) {
            // Same install? The leftover's own name/spec must match what we
            // are about to add — an npm entry retries under its npm name; a
            // github entry's package.json spec equals the target.
            const sameSource = aliasOf.toLowerCase() === (entry.npm ?? '').toLowerCase()
              || String(installedNow[aliasOf] ?? '').replace(/^file:/, '').toLowerCase() === String(target).replace(/^file:/, '').toLowerCase()
            let active = false
            try {
              const manifest = JSON.parse(readFileSync(join(activeProfileDir, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
              active = (manifest.dsh?.profile?.bundles ?? []).includes(aliasOf) || liveNames().has(aliasOf)
            } catch {
              // unreadable manifest — treat as active to stay safe
              active = true
            }
            if (active || !sameSource) {
              logEvent('warn', 'install-rejected', `${entry.name}: same plugin already installed as ${aliasOf}`)
              sendJson(response, 400, { error: `已以「${aliasOf}」安装过同一个插件，无需重复安装 / this plugin is already installed as "${aliasOf}"` })
              return
            }
            retryAlias = aliasOf
            logEvent('info', 'install', `${entry.name}: ${aliasOf} present but inactive (leftover of a failed install) — retrying`)
          }
          // Name-collision guard (#66): the curated registry lists DISTINCT
          // plugins sharing one name (both dsh-usage-stats, four dsh-memory…).
          // The alias guard above no longer cross-matches them (repo evidence
          // decides), but two packages with one name still cannot coexist —
          // pnpm would silently REPLACE the installed one's dependency entry.
          // Refuse with the honest reason instead.
          if (aliasOf === null) {
            const clashName = [entry.npm, entry.name].find(
              (n): n is string => typeof n === 'string' && n !== '' && installedNow[n] !== undefined,
            )
            if (clashName !== undefined) {
              logEvent('warn', 'install-rejected', `${entry.name}: name collision with installed ${clashName} (${installedNow[clashName]}) from a different source`)
              sendJson(response, 400, {
                error: `同名冲突：已安装的「${clashName}」来自其他来源，两个同名插件无法共存于一个 profile，请先卸载再安装 / name conflict: an installed plugin already uses the name "${clashName}" but comes from a different source; two plugins with the same name cannot coexist in one profile — uninstall it first`,
              })
              return
            }
          }
          installing = true
          try {
            const beforeSpecs = readInstalled(config.profile, activeProfileDir)
            const before = new Set(Object.keys(beforeSpecs))
            if (retryAlias !== null) before.delete(retryAlias)
            // RAW manifest snapshot for failure rollback (#65): pnpm writes
            // package.json before the build-script check / registry fetches
            // run, so a hard-failed add leaves ghost dependencies that break
            // every later pnpm run — of anything. Cancelled runs keep their
            // partial state on purpose (the user sees the diff and decides).
            const manifestBefore = readManifestDeps(config.profile, activeProfileDir)
            const result = await runPlugin(config.profile, ['add', target])
            const cancelled = result.cancelled
            if ((result.exitCode !== 0 || result.timedOut) && !cancelled) {
              const rolledBack = restoreManifestDeps(config.profile, manifestBefore, activeProfileDir)
              if (rolledBack.length > 0) logEvent('warn', 'install', `${target}: rolled back manifest residue of the failed run: ${rolledBack.join(', ')}`)
            }
            let ok = result.exitCode === 0 && !result.timedOut && !cancelled
            const cancelDiff = cancelled ? changedSince(beforeSpecs) : null
            if (ok) invalidateUpdates()
            if (ok) {
              // Collection repos (e.g. skin monorepos) install as a junk
              // fileset with no root package.json; retarget to the real
              // plugin subdirectories via pnpm's #path: selector.
              ok = await retargetCollections(runPlugin, config.profile, before, target, activeProfileDir)
            }
            // Fake-success guard (#18): a clean exit that added nothing
            // installable must not read as success. Runs even when
            // retargeting partially failed — a broken piece that slipped in
            // must never survive to brick the next boot.
            let notAPlugin = false
            let removedBroken: string[] = []
            if (result.exitCode === 0 && !result.timedOut && !cancelled) {
              const validated = await validateAddedPlugins(runPlugin, config.profile, before, activeProfileDir)
              removedBroken = validated.removedBroken
              if (removedBroken.length > 0) {
                logEvent('warn', 'install', `${target}: removed uninstallable pieces (no dsh manifest or missing build artifacts): ${removedBroken.join(', ')}`)
              }
              if (validated.keep.length === 0) {
                ok = false
                notAPlugin = true
                logEvent('error', 'install', `${target}: nothing installable survived validation`)
              } else {
                // Partial success across a collection still counts as success.
                ok = true
              }
            }
            const installed = readInstalled(config.profile, activeProfileDir)
            let hot = false
            let activation: Record<string, ReturnType<typeof verifyActivation>> | undefined
            if (ok) {
              const added = Object.keys(installed).filter(name => !before.has(name))
              if (added.length > 0) {
                // Theme installs auto-activate (and deactivate the previous
                // theme) so the result is visible right after the refresh.
                hot = true
                for (const name of added) {
                  const live = entry.category === 'theme'
                    ? await themes.activateTheme(name)
                    : (await hotMount(host, activeProfileDir, name)).ok
                  if (!live) hot = false
                }
                activation = {}
                const live = liveNames()
                for (const name of added) {
                  activation[name] = verifyActivation(config.profile, name, live, activeProfileDir)
                }
              }
            }
            logEvent(ok || cancelled ? 'info' : 'error', 'install',
              `${target} exit=${String(result.exitCode)}${result.timedOut ? ' TIMEOUT' : ''}${cancelled ? ' CANCELLED' : ''}${ok ? ` hot=${String(hot)}` : cancelled ? '' : ` stderr=${result.stderr.slice(-300)}`}`)
            const ignoredBuilds = blockedBuilds(result)
            sendJson(response, ok || cancelled ? 200 : result.busy === true ? 409 : 502, {
              ok,
              cancelled: cancelled || undefined,
              busy: result.busy || undefined,
              hot,
              partial: cancelDiff?.partial,
              changed: cancelDiff?.changed,
              activation,
              ignoredBuilds,
              // Blocked build scripts are expected (pnpm >= 10 blocks them by
              // default): surface the approve-builds banner instead of scaring
              // the user with pnpm's raw stack.
              error: notAPlugin
                ? 'nothing installable: the plugin(s) need a build step (blocked by default, see allowBuilds) or ship no prebuilt artifacts / 没有可安装的内容：插件需要构建授权（allowBuilds，默认拦截）或未附带构建产物，详见导出日志'
                : Array.isArray(ignoredBuilds) && ignoredBuilds.length > 0
                  ? `构建脚本被 pnpm 默认拦截（${ignoredBuilds.join(', ')}），请点击上方按钮放行后重试 / build scripts are blocked by pnpm by default (${ignoredBuilds.join(', ')}); click "Allow build scripts and retry" above`
                  : undefined,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              stdout: result.stdout,
              stderr: result.stderr,
              installed,
            })
          } finally {
            installing = false
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          host.logger?.warn(`[dsh-market] install failed: ${message}`)
          logEvent('error', 'install', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),
  ]

  return () => {
    for (const dispose of disposers) dispose()
  }
}
