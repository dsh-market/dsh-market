/** The official Electron profile is owned by DSH's in-process plugin manager. */

import { randomUUID } from 'node:crypto'
import {
  cancelActive as cancelHostChild,
  progress,
  runHostPnpm,
  TARGET_RE,
  type DesktopPluginRuntime,
  type HostPackageManager,
  type InstallResult,
} from './dsh-cli.ts'
import { classifyPnpmFailure } from './pnpm-compat.ts'
import {
  DeadlineExceeded,
  PendingUpdateJournal,
  repairInterruptedUpdates,
  withDeadline,
  type RepairReport,
} from './pending-updates.ts'
import { profileDir, readInstalledVersion } from './profile.ts'
import { activeRegion, DEFAULT_NPM_REGISTRY, routesFor } from './regions.ts'

interface ManagedResult {
  application: string
  error?: unknown
  packageResult?: { exitCode: number | null; output?: string }
  /**
   * The install never settled and the profile may be half-updated: the route
   * must not try to "restore" it through the same stuck manager.
   */
  repairOnRestart?: boolean
}

/**
 * How long the desktop manager gets before the market stops waiting.
 *
 * The host's reconciliation has no deadline of its own; when a plugin's
 * teardown or start never settles, `removeBundle`/`installBundle` never
 * resolve and the operation stays "updating" forever while holding the
 * profile's write lock. These deadlines cannot cancel the host, but they end
 * the market's wait, and the journal (`./pending-updates.ts`) makes the next
 * start finish the job. Removal is the short step (pnpm unlink + unload);
 * installation may legitimately download and build, so it gets the longer one.
 */
const REMOVE_DEADLINE_MS = 90_000
const INSTALL_DEADLINE_MS = 300_000

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
  'update-incomplete': {
    zh: '桌面端没有在限定时间内完成这次更新：插件可能已经被移除，新版本却还没装上。重新打开 DSH 后市场会自动补装；也可以现在从「设置 → 插件」重试',
    en: 'the desktop app did not finish this update in time: the plugin may already be removed while its replacement never installed. Reopen DSH and the market will finish the install, or retry from Settings → Plugins now',
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
  // The append remedy needs a real version. `version` is whatever follows the
  // `@` in the spec, and the update route can pass a dist-tag (`latest`, a
  // channel name) when registry metadata was unavailable; ` || latest` is not
  // a valid exclusion and pnpm rejects the whole file. The cost sentence stays
  // either way — it is true the moment the command writes anything young.
  const pinnedVersion = /^\d+\.\d+\.\d+/.test(version)
  const remedyZh = version === ''
    ? ''
    : `这条命令会把 ${target} 写进 lockfile，而它可能还在新版本等待期内：此后 pnpm 校验整个 lockfile，**所有插件**的安装/更新都会被拦下（#944）。${pinnedVersion ? `若遇到，在 profile 的 pnpm-workspace.yaml 里 minimumReleaseAgeExclude 中**这个名字的那一行**（没有就新增一行）追加 \` || ${version}\`——带引号的行要加在引号里面；不要另开一行同名规则，pnpm 只读第一条（#883）。` : '若遇到，等这个版本过了等待期再操作；临时豁免要写进这个 profile 的 minimumReleaseAgeExclude。'}`
  const remedyEn = version === ''
    ? ''
    : ` That command writes ${target} into the lockfile while it may still be inside the fresh-release wait: pnpm then verifies the whole lockfile, so **every** plugin install/update is refused (#944).${pinnedVersion ? ` If that happens, append \` || ${version}\` to the row for \`${name}\` under minimumReleaseAgeExclude in the profile's pnpm-workspace.yaml — inside the quotes when the row is quoted, and in a new row only if none exists. Do not add a second row for the same name: pnpm reads only the first (#883).` : ' If that happens, wait the version out before the next operation; a temporary exclusion goes into this profile\'s minimumReleaseAgeExclude.'}`
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

/** Exact version from a registry spec, or '' when the spec is a range or tag. */
function targetVersionOf(spec: string): string {
  if (registryNameOf(spec) === undefined) return ''
  const at = spec.indexOf('@', 1)
  const version = at === -1 ? '' : spec.slice(at + 1)
  return /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version) ? version : ''
}

/** A manager call that never settled: the profile may be half-updated. */
function interrupted(): ManagedResult {
  return { application: 'failed', error: { code: 'update-incomplete' }, repairOnRestart: true }
}

/** What an update needs to journal itself and to be repaired later. */
interface UpdateContext {
  profile: string
  profileDirectory: string
  journal: PendingUpdateJournal
  /** Bundled pnpm from the official desktop launcher; only used for the market itself. */
  packageManager?: HostPackageManager | null
}

/**
 * Overlay the market's own version without unloading it (#982, #900).
 *
 * The manager refuses a re-add (`already-installed`) and the only managed
 * update is remove-then-install, which kills this process. Official Desktop
 * already publishes a bundled pnpm on `profileContext`; `pnpm add` on an
 * existing dependency is an overlay, so the running market stays in memory.
 * No `--config.minimum-release-age=0` — that write is #944.
 */
async function updateMarketInPlace(
  spec: string,
  name: string,
  options: { requestId?: string; registry?: string },
  context?: UpdateContext,
): Promise<ManagedResult> {
  const invocation = context?.packageManager
  const directory = context?.profileDirectory
  if (context === undefined || invocation === undefined || invocation === null || directory === undefined) {
    return { application: 'failed', error: { code: 'market-self-update', message: selfUpdateMessage(spec) } }
  }
  progress.lastLine = 'Updating the market without unloading it'
  const args = ['add', spec]
  if (typeof options.registry === 'string' && options.registry !== '') args.push(`--registry=${options.registry}`)
  const run = await runHostPnpm(invocation, directory, args)
  const output = `${run.stdout}\n${run.stderr}`.trim()
  if (run.cancelled) {
    return { application: 'cancelled', packageResult: { exitCode: run.exitCode, output } }
  }
  if (run.exitCode === 0 && run.timedOut !== true) {
    const landed = readInstalledVersion(context.profile, name, directory) ?? ''
    const wanted = targetVersionOf(spec)
    if (wanted === '' ? landed !== '' : landed === wanted) {
      return { application: 'restart-required', packageResult: { exitCode: 0, output: run.stdout } }
    }
    return {
      application: 'failed',
      error: {
        message: `市场文件没有换成 ${wanted || spec}（现在是 ${landed || '未知'}）。没有把这次当成成功。 / the market files did not become ${wanted || spec} (now ${landed || 'unknown'}). This was not treated as success.`,
      },
      packageResult: { exitCode: run.exitCode || 1, output },
    }
  }
  const classified = classifyPnpmFailure(output, run.exitCode)
  if (classified?.code === 'release-age-violation') {
    return {
      application: 'failed',
      error: {
        message: '这个版本还在新版本等待期内，现在装不了。等过了等待期再点一次更新。 / this version is still inside the fresh-release wait, so it cannot be installed yet. Try the update again after the wait.',
      },
      packageResult: { exitCode: run.exitCode || 1, output },
    }
  }
  if (classified?.code === 'windows-file-locked') {
    // Starting the market loads these files again, so "quit, reopen, click
    // Update" cannot replace them. Settings → Plugins has no update entry
    // (#909). This is not an age failure — no `--config.minimum-release-age=0`.
    return {
      application: 'failed',
      error: {
        message: `文件正被打开着，这一步没有换上。市场启动就会再占用这些文件，再点更新也换不上。请完全退出 DSH Desktop，在 profile 目录执行 \`pnpm add ${spec}\`（没有 pnpm 时用 \`npx pnpm add …\`），然后重新启动。Windows 的 profile 一般在 %USERPROFILE%\\.dsh\\profiles\\desktop。 / files are held open, so this step did not apply. Starting the market loads those files again, so clicking Update after a restart cannot replace them. Quit DSH Desktop completely, run \`pnpm add ${spec}\` in the profile directory (use \`npx pnpm add …\` if pnpm is not installed), then start DSH again. On Windows the profile is usually %USERPROFILE%\\.dsh\\profiles\\desktop.`,
      },
      packageResult: { exitCode: run.exitCode || 1, output },
    }
  }
  if (classified !== null) {
    return {
      application: 'failed',
      error: { message: classified.message },
      packageResult: { exitCode: run.exitCode || 1, output },
    }
  }
  // pnpm already ran. `market-self-update` means the button cannot work on
  // this host (#909); recycling it here, with the age-bypass hint, is #944.
  return {
    application: 'failed',
    error: {
      message: '这一次没有换上。pnpm 没有给出能对上的原因。可以再点一次更新；还是不行就完全退出 DSH Desktop 后再试。 / this update did not apply. pnpm did not name a cause we can match. Try the update again; if it still fails, quit DSH Desktop completely and try once more.',
    },
    packageResult: { exitCode: run.exitCode || 1, output },
  }
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
 *
 * The two steps are not atomic and the first one writes the profile, so the
 * pair is journaled before it starts and bounded by a deadline (#928). If the
 * host never answers, the market stops waiting and the next start finishes or
 * undoes the removal from that record instead of leaving the plugin gone.
 */
async function installOrReinstall(
  manager: OfficialPluginManagerLike,
  spec: string,
  options: { requestId?: string; registry?: string },
  context?: UpdateContext,
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
  // (#900). Overlay the version with the host's own pnpm instead — no remove.
  if (SELF_NAMES.has(name)) {
    return updateMarketInPlace(spec, name, options, context)
  }
  const record = context === undefined
    ? undefined
    : context.journal.begin({
      profile: context.profile,
      name,
      from: readInstalledVersion(context.profile, name, context.profileDirectory) ?? '',
      to: targetVersionOf(spec),
      spec,
    })
  progress.lastLine = 'Removing the installed copy so the desktop app can install the new version'
  let removed: ManagedResult
  try {
    removed = await withDeadline(manager.removeBundle(name), REMOVE_DEADLINE_MS, `remove ${name}`)
  } catch (error) {
    if (error instanceof DeadlineExceeded) return interrupted()
    if (record !== undefined) context?.journal.finish(record.id)
    throw error
  }
  if (removed.application === 'failed' || removed.application === 'cancelled') {
    // Nothing was unloaded, so there is nothing for a later start to repair.
    if (record !== undefined) context?.journal.finish(record.id)
    return removed
  }
  if (record !== undefined) context?.journal.mark(record.id, 'installing')
  progress.lastLine = 'Installing the new version'
  try {
    const installed = await withDeadline(install(), INSTALL_DEADLINE_MS, `install ${spec}`)
    if (installed.application === 'failed' || installed.application === 'cancelled') {
      // The replacement did not land; the record stays so the next start can
      // put it back rather than leaving the package gone.
      return installed
    }
    if (record !== undefined) context?.journal.finish(record.id)
    return installed
  } catch (error) {
    if (error instanceof DeadlineExceeded) return interrupted()
    throw error
  }
}

/** The official runtime's own surface, plus the repair a later start owes the profile. */
export interface OfficialDesktopRuntime extends DesktopPluginRuntime {
  /**
   * Finish or undo an update an earlier start left half-applied (#928).
   * Returns after every record settled or was found unrepairable; never throws.
   */
  repairPendingUpdates(): Promise<RepairReport>
}

/** Resolve the profile directory without making an invalid name a construction failure. */
function safeProfileDirectory(profile: string, explicit?: string): string | undefined {
  if (explicit !== undefined) return explicit
  try {
    return profileDir(profile)
  } catch {
    return undefined
  }
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
  // Official Desktop publishes its bundled pnpm here. Used only to overlay
  // the market itself (#982). Other packages still go through the manager.
  packageManager?: HostPackageManager | null,
): OfficialDesktopRuntime {
  let disposed = false
  let repairing = false
  let active: { requestId?: string; cancelled: boolean; done: Promise<InstallResult> } | undefined
  const directory = safeProfileDirectory(profileName, _profileDirectory)
  const journal = directory === undefined ? undefined : PendingUpdateJournal.forProfile(directory)
  const updateContext: UpdateContext | undefined = directory === undefined || journal === undefined
    ? undefined
    : { profile: profileName, profileDirectory: directory, journal, packageManager }

  const runPlugin: DesktopPluginRuntime['runPlugin'] = (profile, argv) => {
    if (disposed) return Promise.resolve(failure('official desktop plugin runtime is disposed', 127))
    if (profile !== profileName) return Promise.resolve(failure('refusing to change a different profile', 127))
    // A repair uses the same manager; overlapping the two would race the
    // profile's write lock and the route's single-operation rule.
    if (active !== undefined || repairing) return Promise.resolve({ ...failure('another plugin operation is running', 127), busy: true })
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
      // An explicit uninstall supersedes an interrupted update for the same
      // package: the journal must not put back what the user just removed.
      if (command === 'remove') updateContext?.journal.forget(profileName, target)
      operation = command === 'remove'
        ? manager.removeBundle(target)
        : installOrReinstall(manager, spec, options, updateContext)
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
      // The manager never settled: the profile may be half-updated, so this
      // is neither "nothing happened" nor something the route can restore
      // through the same stuck manager (#928).
      const repairOnRestart = !ok && result.repairOnRestart === true
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
        wroteNothing: !ok && !repairOnRestart && (result.packageResult === undefined || prePnpmHostFailure(result)),
        ...(repairOnRestart ? { repairOnRestart: true } : {}),
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

  const repairPendingUpdates = async (): Promise<RepairReport> => {
    const empty: RepairReport = { reinstalled: [], finished: [], failed: [] }
    if (disposed || repairing || active !== undefined) return empty
    const manager = managerLookup()
    if (manager === undefined || directory === undefined || journal === undefined) return empty
    repairing = true
    try {
      return await repairInterruptedUpdates({ profile: profileName, profileDirectory: directory, manager, journal })
    } catch (error) {
      console.warn('dsh-market: could not repair an interrupted update', error)
      return empty
    } finally {
      repairing = false
    }
  }

  return {
    runPlugin,
    repairPendingUpdates,
    probePnpm: async () => managerLookup() !== undefined,
    provisionPnpm: async () => ({ ok: managerLookup() !== undefined, hint: 'Use the official desktop plugin manager' }),
    cancelActive: () => {
      if (active === undefined) return false
      active.cancelled = true
      progress.cancelling = true
      const manager = managerLookup()
      if (active.requestId !== undefined && manager !== undefined) void manager.cancelInstall(active.requestId).catch(() => {})
      // A self-update overlay is a host pnpm child, not a manager install.
      cancelHostChild()
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
      cancelHostChild()
      await active?.done
    },
  }
}
