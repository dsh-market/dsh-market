/**
 * dsh-market host entry: mounts the market's HTTP routes once the profile
 * composes the webServer and shell services.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createDesktopPluginRuntime, type DesktopPnpmLike } from './dsh-cli.ts'
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
 */
interface ProfileContextLike {
  readonly name: string
  readonly dir: string
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
      const launched = launchedProfile(ctx.get('profileContext') as ProfileContextLike | undefined)
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
