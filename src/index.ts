/**
 * dsh-market host entry: mounts the market's HTTP routes once the profile
 * composes the webServer and shell services.
 */

import type { Context } from '@deepseek-ai/cordis'
import { dirname, isAbsolute } from 'node:path'
import { createDesktopPluginRuntime, setHostPackageManager, type DesktopPnpmLike, type HostPackageManager } from './dsh-cli.ts'
import { createOfficialDesktopRuntime, type OfficialPluginManagerLike } from './official-desktop.ts'
import { isDshProfileName } from './profile.ts'
import { mountMarketRoutes, type MarketConfig, type MarketHost } from './routes.ts'
import { installDesktopMarketSettings, installMarketSettings } from './settings.ts'
import type { AgentsServiceLike } from './agents.ts'

export const name = 'dsh-market'

/** Optional cordis.yml configuration; profile defaults to `web`. */
export type Config = Partial<Pick<MarketConfig, 'profile' | 'allowRestart' | 'maxSnapshots'>>

/**
 * Structural subset of the dsh launcher's public `profileContext` service —
 * "present only in a profile launched by dsh", provided on the host context
 * before any config-tree entry mounts.
 *
 * `packageManager` is an optional member of that same public service, not of
 * the third-party `desktopPnpm` contract: a packaged host ships its own
 * runtime and names it here instead of relying on a PATH executable. Typed
 * `unknown` because the launcher owns the shape and the market only reads it
 * after checking every field (#653).
 */
interface ProfileContextLike {
  readonly name: string
  readonly dir: string
  readonly installAnchor?: string
  readonly packageManager?: unknown
}

/** Structural subset of DSH Desktop's public `desktopProfiles` contract. */
interface DesktopProfilesLike {
  readonly current: {
    readonly name: string
    readonly dir: string
  }
}

interface MarketEffectHost extends MarketHost {
  effect(
    callback: () => (() => void | Promise<void>),
    label: string,
  ): void
}

/**
 * Register the market against the host context.
 * @param ctx - Host context that may acquire webServer and shell services.
 * @param config - Optional profile override from the loader.
 */
/**
 * The profile this host process actually booted (`--profile <name>` on the
 * dsh CLI invocation). Without it the market would default to `web` and
 * installs from a test/secondary profile would mutate the real one.
 */
function argvProfile(): string | undefined {
  const argv = process.argv
  const flag = argv.indexOf('--profile')
  if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith('-')) return argv[flag + 1]
  return undefined
}

/**
 * The profile this process was launched into, as the launcher itself reports
 * it. `argvProfile` only sees a `--profile` flag on this process's argv, and
 * the official desktop host starts a profile through the launcher's node
 * entry rather than the CLI — no flag, no `desktopProfiles` service either,
 * so the market fell back to `web` and every install, update and uninstall
 * landed in the web profile instead of the one the user was looking at
 * (#639).
 *
 * The launcher's `dir` is taken with the name rather than derived from it:
 * the launcher owns where a profile lives, and deriving the path would
 * disagree with it for any profile that does not sit in the default place.
 * A name the market could not use as a directory segment is refused rather
 * than joined into a path.
 */
function launchedProfile(context: ProfileContextLike | undefined): { name: string; dir: string } | undefined {
  if (context === undefined) return undefined
  const name = typeof context.name === 'string' ? context.name.trim() : ''
  const dir = typeof context.dir === 'string' ? context.dir.trim() : ''
  if (!isDshProfileName(name) || dir === '') return undefined
  return { name, dir }
}

/**
 * The package manager the launcher published for this profile, if any.
 *
 * Every field is checked before use, and one bad field discards the whole
 * invocation rather than half of it: a command without its args or its env
 * is a tool this process still cannot run, which is the very failure being
 * fixed. A host that publishes nothing here keeps the PATH and corepack
 * chain exactly as it was — feature detection, not a hard dependency.
 */
function hostPackageManagerOf(context: ProfileContextLike | undefined): HostPackageManager | null {
  const published = context?.packageManager
  if (published === null || typeof published !== 'object' || Array.isArray(published)) return null
  const { command, args, env } = published as { command?: unknown; args?: unknown; env?: unknown }
  if (typeof command !== 'string' || command.trim() === '') return null
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) return null
  if (env !== undefined && (env === null || typeof env !== 'object' || Array.isArray(env))) return null
  // Only string values survive: the child environment is Record<string,
  // string>, and handing a foreign number or object to spawn is a type it
  // coerces or drops without saying so.
  const merged: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries((env ?? {}) as Record<string, unknown>)) {
    if (typeof value === 'string') merged[key] = value
  }
  return { command: command.trim(), args: [...(args as string[])], env: merged }
}

/**
 * Resolve the host's `agents` inventory lazily — at request time, not at
 * market startup, so the guard sees whichever agents exist by the time an
 * update is asked for. Hosts without the service return undefined and the
 * update route stays open (see src/agents.ts).
 */
function agentsLookupOf(ctx: Context): () => AgentsServiceLike | undefined {
  return () => ctx.get('agents') as AgentsServiceLike | undefined
}

export function apply(ctx: Context, config?: Config): void {
  ctx.inject(['webServer', 'loader'], (hostCtx: Context) => {
    const host = hostCtx as unknown as MarketEffectHost
    const desktopProfiles = ctx.get('desktopProfiles') as DesktopProfilesLike | undefined
    if (desktopProfiles === undefined) {
      // An explicit `profile:` in cordis.yml is the operator speaking and
      // still wins; the launcher's own answer comes next, and only then the
      // flag-and-default guesswork. The launcher's directory rides along with
      // its name, and never with somebody else's.
      const profileContext = ctx.get('profileContext') as ProfileContextLike | undefined
      const launched = launchedProfile(profileContext)
      // The official Electron app owns this profile. Its CLI explicitly
      // refuses `--profile desktop`; use the app's pluginManager service.
      // Looking it up at request time lets the market mount before the
      // service while still failing closed if it never becomes available.
      // The dsh CLI refuses a profile by NAME — `profile.toLowerCase() ===
      // "desktop"` (@deepseek-ai/dsh 0.1.7-alpha.2) — so a launched profile
      // with that name can never be changed through `dsh plugin`, whatever
      // the install layout. Detection follows the same rule rather than the
      // app.asar anchor shape an earlier draft keyed on: the official desktop
      // host is not published, its layout could not be checked, and a host
      // that missed the anchor test fell straight back to the CLI and failed
      // every install (#702). A third-party shell announces itself through
      // `desktopProfiles`, and this whole block runs only when that service
      // is absent, so this never takes a third-party shell's profile.
      const officialElectron = launched !== undefined && launched.name.toLowerCase() === 'desktop'
      if (officialElectron && config?.profile === undefined) {
        const runtime = createOfficialDesktopRuntime(
          () => hostCtx.get('pluginManager') as OfficialPluginManagerLike | undefined,
          launched.name,
          launched.dir,
        )
        const resolved: MarketConfig = {
          profile: launched.name,
          profileDirectory: launched.dir,
          desktopHost: true,
          allowRestart: false,
          maxSnapshots: config?.maxSnapshots,
          ...(typeof profileContext?.installAnchor === 'string' && isAbsolute(profileContext.installAnchor)
            ? { dshInstallDir: dirname(profileContext.installAnchor) } : {}),
        }
        installDesktopMarketSettings(ctx)
        host.effect(() => {
          const disposeRoutes = mountMarketRoutes(host, resolved, runtime, agentsLookupOf(ctx))
          return async () => {
            disposeRoutes()
            await runtime.dispose()
          }
        }, 'dsh-market: official Desktop routes and package operations')
        return
      }
      // The launcher's own package manager, when it publishes one. Registering
      // it here covers both the pnpm probe and every install spawn, since the
      // invocation's environment reaches both through spawnEnv (#653).
      setHostPackageManager(hostPackageManagerOf(profileContext))
      const useLaunchedDir = config?.profile === undefined && launched !== undefined
      const resolved: MarketConfig = {
        profile: config?.profile ?? launched?.name ?? argvProfile() ?? 'web',
        ...(useLaunchedDir ? { profileDirectory: launched.dir } : {}),
        // Left UNDEFINED when unconfigured, deliberately: `?? true` here
        // would turn "the operator said nothing" into "the operator said
        // yes", and restartAllowed() could no longer tell them apart — which
        // is exactly the distinction supervisor detection needs (#229).
        allowRestart: config?.allowRestart,
        maxSnapshots: config?.maxSnapshots,
      }
      // Web settings may control restart; Desktop only registers the card's
      // namespace below. Both no-op on a host without a settings service.
      installMarketSettings(ctx, resolved)
      host.effect(() => mountMarketRoutes(host, resolved, undefined, agentsLookupOf(ctx)), 'dsh-market: http routes')
      return
    }

    // Desktop's supported cross-environment contract guarantees that
    // desktopProfiles exists before Loader entries mount, and prescribes this
    // presence check plus a nested desktopPnpm injection:
    // https://github.com/anywhere-labs/deepseek-harness-desktop/blob/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/docs/plugin-services.md#L190-L243
    // Ordinary DSH keeps the existing CLI path above.
    hostCtx.inject(['desktopPnpm'], (desktopCtx: Context) => {
      const current = desktopProfiles.current
      const service = (desktopCtx as unknown as { desktopPnpm: DesktopPnpmLike }).desktopPnpm
      const runtime = createDesktopPluginRuntime(service, current.dir)
      const resolved: MarketConfig = {
        profile: current.name,
        profileDirectory: current.dir,
        // The shell owns the window and the process lifecycle here; the
        // capability bits report that, and an explicit profile directory no
        // longer implies it (#639).
        desktopHost: true,
        // Relaunching a raw Electron process would bypass Desktop's launcher
        // lifecycle. The shell remains responsible for restart in this mode.
        allowRestart: false,
        maxSnapshots: config?.maxSnapshots,
      }
      const desktopHost = desktopCtx as unknown as MarketEffectHost
      installDesktopMarketSettings(desktopCtx)
      desktopHost.effect(() => {
        const disposeRoutes = mountMarketRoutes(host, resolved, runtime, agentsLookupOf(ctx))
        return async () => {
          disposeRoutes()
          await runtime.dispose()
        }
      }, 'dsh-market: Desktop http routes and package operations')
    })
  })
}
