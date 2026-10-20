/** The official Electron profile is owned by DSH's in-process plugin manager. */

import { randomUUID } from 'node:crypto'
import { progress, TARGET_RE, type DesktopPluginRuntime, type InstallResult } from './dsh-cli.ts'
import { activeRegion, DEFAULT_NPM_REGISTRY, routesFor } from './regions.ts'

interface ManagedResult {
  application: string
  error?: unknown
  packageResult?: { exitCode: number | null; output?: string }
}

export interface OfficialPluginManagerLike {
  installBundle(spec: string, options?: { requestId?: string; registry?: string }): Promise<ManagedResult>
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

/**
 * The host's own pre-install diagnostic, when it wrote one.
 *
 * On dsh 0.2.1 the manager runs checks of its own before pnpm starts and
 * reports them as `dsh: …` in an `operation-error`'s `diagnostic` (#912).
 */
function hostDiagnostic(error: unknown): string | undefined {
  const diagnostic = (error as { diagnostic?: unknown } | null | undefined)?.diagnostic
  return typeof diagnostic === 'string' && diagnostic.startsWith('dsh: ') ? diagnostic : undefined
}

/**
 * Whether the host stopped before pnpm ran, on a check of its own (#912).
 *
 * `checkGithubConnection` refuses an install after five seconds without
 * touching the profile; so does the compatibility gate (`installation
 * rejected:`). Neither is a write, and treating them as one sent the update
 * route into a rollback of an untouched profile — a false "restoration
 * could not be verified" alarm that buried the real reason.
 */
function prePnpmHostFailure(result: ManagedResult): boolean {
  const diagnostic = hostDiagnostic(result.error)
  return diagnostic !== undefined
    && /^dsh: (?:connection to \S+ timed out|installation rejected:)/.test(diagnostic)
}

function detail(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (error === undefined) return 'plugin manager did not explain the failure'
  const code = managementCode(error)
  const copy = code === undefined ? undefined : REFUSAL_COPY[code]
  // The code stays on the line: it is what the log and the issue report carry.
  if (copy !== undefined) return `${copy.zh} / ${copy.en} (${code})`
  const message = (error as { message?: unknown }).message
  if (typeof message === 'string' && message !== '') return message
  const diagnostic = hostDiagnostic(error)
  if (diagnostic !== undefined) {
    if (/^dsh: connection to \S+ timed out/.test(diagnostic)) {
      // The 5 s is the host's own pre-install reachability check, not the
      // install failing: say which knob moves it (#912).
      return `${diagnostic}\n\n宿主在开始安装前自己检查了 GitHub 的连通性，5 秒内没连上就放弃了这次安装，pnpm 还没有开始，profile 没有任何改动。如果手动 \`git ls-remote\` 能连上（例如已给 git 配好代理或换过 TLS 后端），把宿主 plugin-manager 的 \`githubConnectionTimeoutMs\` 调大再试（cordis.yml 里该插件的 config）。 / the host checks GitHub reachability before installing and gave up after five seconds; pnpm never started and the profile is unchanged. If git itself can reach GitHub (a proxy, or a different TLS backend), raise the host plugin-manager's \`githubConnectionTimeoutMs\` (its config in cordis.yml) and try again.`
    }
    return diagnostic
  }
  return JSON.stringify(error)
}

/**
 * What the manager's refusal means, in the user's terms.
 *
 * These codes are the manager's localization keys, not sentences; they used to
 * reach the page as `{"code":"already-installed"}` and, on the update route,
 * wrapped in "restoration of the previous build could not be verified" — alarm
 * about a profile that was never touched (#897). The bilingual half is picked
 * by the same `localizeBilingual` every other server message goes through.
 */
const REFUSAL_COPY: Record<string, { zh: string; en: string }> = {
  'already-installed': {
    zh: '桌面端认为这个包已经装在 profile 里，因此在运行 pnpm 之前就拒绝了这次安装，profile 没有任何改动',
    en: 'the desktop app treats this package as already installed and refused the install before pnpm ran, so the profile is unchanged',
  },
  'not-removable': {
    zh: '这个插件由桌面端自己管理，市场不能移除它',
    en: 'the desktop app manages this plugin itself, so the market cannot remove it',
  },
  'bundle-in-use': {
    zh: '这个插件正在使用中，桌面端不允许现在移除',
    en: 'the plugin is in use, and the desktop app will not remove it right now',
  },
  'stop-profile': {
    zh: '要移除它得先停止这个 profile',
    en: 'removing it requires stopping this profile first',
  },
  'management-required': {
    zh: '这个 profile 由桌面端自己管理，市场不能直接改动',
    en: 'this profile is managed by the desktop app itself, so the market cannot change it',
  },
  'incompatible-version': {
    zh: '这个版本与当前 DSH 不兼容，宿主拒绝安装',
    en: 'this version is not compatible with the running DSH, so the host refused it',
  },
}

/**
 * The market's own package names. A desktop profile installs it from npm as
 * `dshmarket`; a fork or a local checkout can declare the repository's name.
 */
const SELF_NAMES = new Set(['dshmarket', 'dsh-market'])

/**
 * Why the market will not remove itself to update, and what to do instead.
 *
 * The manager's `removeBundle` drops the bundle from the running composition
 * before pnpm runs. For every other package that is a normal unload; for the
 * market it unloads the very code that was going to install the new version,
 * so the reinstall never happens and the profile is left with the bundle row
 * gone and the dependency still declared (#900). The app's own Plugins page
 * performs the same two steps from outside the market and survives.
 */
function selfUpdateMessage(spec: string): string {
  const at = spec.indexOf('@', 1)
  const version = at === -1 ? '' : spec.slice(at + 1)
  const target = version === '' ? spec : `${registryNameOf(spec) ?? spec}@${version}`
  const name = registryNameOf(spec) ?? spec
  // Two paths that used to be named here do not exist on dsh 0.2.1, and a
  // reporter proved both (#909): `dsh plugin --profile desktop` is refused
  // outright, and the app's Settings → Plugins has no update entry — its
  // manager refuses re-adding a package that is already declared. The only
  // route left is pnpm run against the profile with the app fully quit, which
  // is what the reporter verified. `--config.minimum-release-age=0` is the
  // market's own one-shot flag, spelled so it works in every shell.
  //
  // That command is kept, but it is not free (#944). It installs the version
  // WITHOUT writing an exclusion, so the version sits in the lockfile while it
  // is still inside the wait — and pnpm then verifies the whole lockfile before
  // any later mutation, so EVERY plugin install/update fails until it ages out
  // (#39's shape, reported from the self-update route by #944 and #942). The
  // user who follows this hint is the one user who cannot be left to discover
  // that by trying. Say the cost here, and the one-line remedy next to it.
  //
  // The remedy must land on the package's EXISTING row, not a new one: pnpm
  // 11.7.0 stops at the first matching rule, so a second row for the same name
  // is shadowed and reading as "your exemption is ignored" (#883). Advice that
  // says "add a line" would therefore not work.
  const remedyZh = version === ''
    ? ''
    : `这条命令会把 ${target} 写进 lockfile，而它可能还在新版本等待期内：此后 pnpm 校验整个 lockfile，**所有插件**的安装/更新都会被拦下（#944）。若遇到，在 profile 的 pnpm-workspace.yaml 里 minimumReleaseAgeExclude 中 **${name} 同名那一行**行尾追加 \` || ${version}\`（追加到同名行，不要新增一行——新增的那行会被 pnpm 遮蔽，#883）。`
  const remedyEn = version === ''
    ? ''
    : ` That command writes ${target} into the lockfile while it may still be inside the fresh-release wait: pnpm then verifies the whole lockfile, so **every** plugin install/update is refused (#944). If that happens, append \` || ${version}\` to the END of the existing \`${name}\` row under minimumReleaseAgeExclude in the profile's pnpm-workspace.yaml (the same row, not a new one — pnpm shadows a second row for the same name, #883).`
  const before = `市场不能在自己的请求里更新自己：桌面端的移除会先把市场从正在运行的组合里摘掉，补装那一步就执行不到了（#900），而应用内的「设置 → 插件」没有更新入口（#909）。要更新${version === '' ? '' : ` 到 ${version}`}：完全退出 DSH Desktop，在 profile 目录执行 \`pnpm add ${target} --config.minimum-release-age=0\`（没有 pnpm 时用 \`npx pnpm add …\`），然后重新启动。Windows 的 profile 一般在 %USERPROFILE%\\.dsh\\profiles\\desktop。`
  const after = `The market cannot update itself: the desktop app unloads it from the running composition first, so the reinstall never runs (#900), and the app's Settings → Plugins has no update entry (#909). To update${version === '' ? '' : ` to ${version}`}: quit DSH Desktop completely, run \`pnpm add ${target} --config.minimum-release-age=0\` in the profile directory (use \`npx pnpm add …\` if pnpm is not installed), then start DSH again. On Windows the profile is usually %USERPROFILE%\\.dsh\\profiles\\desktop.`
  return `${before}${remedyZh} / ${after}${remedyEn}`
}

/** The manager's own refusal code, whether it was returned or thrown. */
function managementCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/** `dshmarket@1.66.32` → `dshmarket`; anything that is not a registry name stays unparsed. */
export function registryNameOf(spec: string): string | undefined {
  // Start at 1 so a scoped name's leading `@` is not mistaken for a version.
  const at = spec.indexOf('@', 1)
  const name = at === -1 ? spec : spec.slice(0, at)
  return /^(@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/.test(name) ? name : undefined
}

/**
 * Install a spec, and when the manager refuses it because that package is
 * already in the profile, remove the installed copy first and install again.
 *
 * dsh 0.2.1's plugin manager treats `add` on an existing dependency as
 * `already-installed` outright (#896). An update is exactly that shape, and
 * the app's own Plugins page updates a bundle the same two-step way —
 * `removeBundle` then install — because its manager has no in-place update.
 * Without this the market could not update ANY installed plugin on that host,
 * itself included: users stuck on a broken build could not fetch the fix.
 */
async function installOrReinstall(
  manager: OfficialPluginManagerLike,
  spec: string,
  options: { requestId?: string; registry?: string },
): Promise<ManagedResult> {
  const install = (): Promise<ManagedResult> => manager.installBundle(spec, options)
  let first: ManagedResult
  try {
    first = await install()
  } catch (error) {
    if (managementCode(error) !== 'already-installed') throw error
    first = { application: 'failed', error }
  }
  if (first.application !== 'failed' || managementCode(first.error) !== 'already-installed') return first
  const name = registryNameOf(spec)
  // A refusal we cannot turn into a name is the manager's answer to give.
  if (name === undefined) return first
  // Removing the market would unload this very code before the reinstall runs
  // (#900). Say how to update it instead.
  if (SELF_NAMES.has(name)) {
    return { application: 'failed', error: { code: 'market-self-update', message: selfUpdateMessage(spec) } }
  }
  progress.lastLine = 'Removing the installed copy so the desktop app can install the new version'
  const removed = await manager.removeBundle(name)
  if (removed.application === 'failed' || removed.application === 'cancelled') return removed
  progress.lastLine = 'Installing the new version'
  return install()
}

/**
 * Never fall back to `dsh plugin --profile desktop`.
 *
 * Up to dsh 0.2.0-rc.1 the CLI refused that profile outright. From rc.2 it
 * accepts it only when Desktop's own carrier invokes it, with Desktop fully
 * quit — it takes a 120 s lock on the profile's package.json and says "fully
 * quit it before running". The market only ever runs inside a live Desktop, so
 * for the market the answer is the same on every version: the app's own
 * plugin manager is the only door.
 */
export function createOfficialDesktopRuntime(
  managerLookup: () => OfficialPluginManagerLike | undefined,
  profileName: string,
  // Unused by the manager bridge — it takes the profile by NAME — and optional
  // because an explicitly configured `profile: desktop` may be the only thing
  // that names this profile, with no launcher directory to go with it (#744).
  _profileDirectory?: string,
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
      // The market's own options are what usually lands here, and they are
      // spelled with a leading `-` — and they sit in the TARGET slot, because
      // the market writes `add <option> <target>`. The OPERATION is supported
      // here; only the option is not, and reporting that as "this desktop
      // operation is not supported" is what made #732 read as a broken
      // profile. Name the option and the way out instead.
      const options = argv.slice(1).filter(argument => argument.startsWith('-')).join(' ')
      return Promise.resolve(failure(options === ''
        ? 'this desktop operation is not supported by the official plugin manager'
        : `官方桌面客户端自己执行这次安装，不接受市场附加的参数（${options}），这个选项在它这里用不了。可以改用普通 dsh web 安装，或等这个版本过了新版本等待期再试。 / The official desktop app runs this install itself and takes no options from the market (${options}); that option cannot be used here. Install from plain dsh web, or try again once the release is past the fresh-release wait.`, 127))
    }
    const spec = target
    // Only `add` and `remove` map onto the manager. `update` reached here only
    // for the #564 in-place re-resolve of a floating git spec, and no route
    // builds it any more: on a host with this contract the routes express that
    // re-resolve as `add <spec>` (#786), which pnpm does re-resolve — it is
    // `install` that skips a resolution. Turning `update` into `name@latest`
    // (as a first draft did) would cross the installed range and ignore the
    // release channel, which is a different operation, so the refusal stays
    // for any caller that asks for something the manager cannot express.
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
      // Read at each operation so region switches apply without a restart.
      // The default route leaves the host's own npm configuration in charge.
      const registry = routesFor(activeRegion()).npmRegistry
      const options = { requestId, ...(registry === DEFAULT_NPM_REGISTRY ? {} : { registry }) }
      operation = command === 'remove'
        ? manager.removeBundle(target)
        : installOrReinstall(manager, spec, options)
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
        // No package result means the manager stopped before it ran pnpm: the
        // profile is untouched, and the route must not try to "restore" it.
        // A pre-install host check (#912) is the same shape even when the
        // manager attached a package result to its refusal.
        wroteNothing: !ok && (result.packageResult === undefined || prePnpmHostFailure(result)),
        // The manager's own code, kept machine-readable (#909): a client can
        // tell a self-update refusal from an ordinary failure.
        ...(ok ? {} : { refusalCode: managementCode(result.error) }),
      }
    }, (error): InstallResult => {
      const message = detail(error)
      progress.error = message
      return {
        ...failure(message, 127),
        wroteNothing: managementCode(error) !== undefined,
        ...(managementCode(error) === undefined ? {} : { refusalCode: managementCode(error) }),
      }
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
    // The reason the flag exists (#732): this manager takes exactly
    // `add <target>` or `remove <target>`, so every recovery step that needs
    // an option has to be left out here rather than sent and refused.
    acceptsMarketPnpmFlags: false,
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
