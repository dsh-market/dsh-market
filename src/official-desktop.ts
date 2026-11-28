/** The official Electron profile is owned by DSH's in-process plugin manager. */

import { clearStartupRepairEntry } from './startup-repair-report.ts'
import { randomUUID } from 'node:crypto'
import {
  acceptsManagedAddTarget,
  cancelActive as cancelHostChild,
  progress,
  runHostPnpm,
  TARGET_RE,
  type DesktopPluginRuntime,
  type HostPackageManager,
  type InstallResult,
} from './dsh-cli.ts'
import { logEvent } from './log.ts'
import { classifyPnpmFailure } from './pnpm-compat.ts'
import { compareSemver, isSemver } from './check.ts'
import {
  DeadlineExceeded,
  PendingUpdateJournal,
  repairInterruptedUpdates,
  withDeadline,
  type RepairReport,
} from './pending-updates.ts'
import { githubShortcut, NPM_NAME_RE } from './sources.ts'
import { profileDir, readInstalledVersion, readProfileManifestSnapshot } from './profile.ts'
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
  /** The refusal is the host's restart-first state, not a plugin in use (#1253). */
  needsRestart?: boolean
  /**
   * The host stopped or undid its own work: the profile holds what it held
   * before the call. Set by the in-place update path, where a refusal at the
   * target check, a failed removal that never reached pnpm, and a failure the
   * host already rolled back all leave the old version in place.
   */
  untouched?: boolean
  /** One more plain sentence for the user, appended to the failure's account. */
  note?: string
  /**
   * The host replaced the running market itself during this call: the
   * instance that asked is already disposed (see `updateInPlace`).
   */
  selfSwapped?: boolean
  /**
   * The host loaded the new build into the running process itself (HMR):
   * `applied`, not `restart-required`. The old module is gone from memory, so
   * the update route must not say "restart to apply".
   */
  liveSwap?: boolean
}

/**
 * How long the desktop manager gets before the market stops waiting.
 *
 * The host's reconciliation has no deadline of its own; when a plugin's
 * teardown or start never settles, `removeBundle`/`installBundle` never
 * resolve and the operation stays "updating" forever while holding the
 * profile's write lock. These deadlines cannot cancel the host, but they end
 * the market's wait, and the journal (`./pending-updates.ts`) makes the next
 * start finish the job.
 *
 * Both are the same length on purpose (#1057). Removal is short when pnpm
 * only unlinks, but the host runs every command through the profile's
 * supply-chain verification first, and that reaches the network: the reported
 * update died at 90 s while pnpm was doing the right thing
 * (`GET … UND_ERR_CONNECT_TIMEOUT. Will retry in 10 seconds. 2 retries left`),
 * and the host's own manager then rewrote the manifest from its stale
 * snapshot two minutes later. A deadline is here to end an infinite wait, not
 * to race pnpm's retry budget — a transient that resolves by itself must not
 * turn into a permanent failure.
 *
 * Their length is also not ours to pick: every call bounded here has the
 * host's own silence watchdog inside it (#1250). The plugin manager kills a
 * pnpm child that prints nothing for ten minutes (`idleTimeoutMs` of
 * `@deepseek-ai/dsh-plugin-manager`, the default #817 was reported against)
 * and answers `dsh: pnpm printed nothing for 600000ms and was terminated` —
 * the sentence `classifyPnpmFailure` turns into "the network stalled, nothing
 * was installed" (`./pnpm-compat.ts`). A market bound at or under that
 * instant is not a backstop for a silent host; it is the thing that decides
 * the answer, and the host's own diagnosis is replaced by
 * `operation-incomplete` — "the change may already be on disk", said about a
 * profile that a killed pnpm had not touched.
 */
const HOST_IDLE_WATCHDOG_MS = 600_000
/** Long enough for the host to turn a killed child into its answer. */
const DEADLINE_MARGIN_MS = 60_000
const REMOVE_DEADLINE_MS = HOST_IDLE_WATCHDOG_MS + DEADLINE_MARGIN_MS
const INSTALL_DEADLINE_MS = HOST_IDLE_WATCHDOG_MS + DEADLINE_MARGIN_MS
/**
 * The bound around a whole `add`, which may be an update and therefore holds
 * two bounded phases in a row. It has to stay strictly longer than their sum:
 * an outer bound equal to the inner one fires at the same instant and decides
 * the answer instead — that is how a timeout stopped being reported as
 * "the update did not finish" and started being reported as the plain
 * operation refusal (#928's spec caught it).
 */
const OPERATION_DEADLINE_MS = REMOVE_DEADLINE_MS + INSTALL_DEADLINE_MS + DEADLINE_MARGIN_MS
/**
 * The bound around the host's own in-place update (`updateBundle`). The host
 * runs the whole sequence itself — check the target, remove, install, and on a
 * failed install remove again and put the old version back — so the market no
 * longer sees the phases, only the one answer. Each of those phases can spend
 * the host's silence watchdog on its own pnpm child, and the market must not
 * answer for the host while the host is still diagnosing (#1250), so the bound
 * is three phases long: check + install + the restore the host owes after a
 * failed install. It is a backstop against a call that never settles, not a
 * budget for a slow network.
 */
const IN_PLACE_UPDATE_DEADLINE_MS = 3 * (HOST_IDLE_WATCHDOG_MS + DEADLINE_MARGIN_MS)
/** Strictly longer than the call it wraps, for the reason `OPERATION_DEADLINE_MS` gives. */
const IN_PLACE_OPERATION_DEADLINE_MS = IN_PLACE_UPDATE_DEADLINE_MS + DEADLINE_MARGIN_MS

/** What `updateBundle` answers (`PluginUpdateResult` in `@deepseek-ai/dsh-plugin-manager` 0.2.2+). */
export interface ManagedUpdateResult {
  from: string
  to: string
  /** The last step that ran: the target check, the removal, or the target's install. */
  step: 'check' | 'remove' | 'install'
  result: ManagedResult & { changed?: boolean; stage?: string; target?: string }
  /** Present when the install failed after the old version was removed: the old version's reinstall. */
  restore?: ManagedResult
}

/** The part of one `listBundles` row the in-place update decision reads. */
export interface ManagedBundleRow {
  name: string
  installed?: boolean
  version?: string
  source?: string
  /** How `updateBundle` can replace it; absent when it cannot. */
  update?: 'registry' | 'git'
  /**
   * What older managers (0.14.x) say instead of `update`: whether `updateBundle`
   * accepts the row. Only registry-spec rows under their own name are ever
   * `true` there, so it stands for `update: 'registry'` and nothing else (#909).
   */
  updatable?: boolean
}

export interface OfficialPluginManagerLike {
  installBundle(spec: string, options?: { requestId?: string; registry?: string }): Promise<ManagedResult>
  removeBundle(name: string): Promise<ManagedResult>
  cancelInstall(requestId: string): Promise<unknown>
  /**
   * Replace an installed bundle with a newer version, in one call. Only dsh
   * 0.2.2 and later: absent on 0.2.1, whose manager has no in-place update, and
   * every caller must feature-detect it.
   */
  updateBundle?(
    name: string,
    version: string,
    options?: { registry?: string | null; spec?: string; requestId?: string },
  ): Promise<ManagedUpdateResult>
  /** Used with `updateBundle` to learn which bundles it can replace (`update`). */
  listBundles?(): Promise<ManagedBundleRow[]>
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
  // The host's own reason for a refused check (the registry did not answer,
  // the version is not there). Said with what it means for the user: nothing
  // changed, and what to do.
  const reason = code === 'operation-error' ? (error as { diagnostic?: unknown }).diagnostic : undefined
  if (typeof reason === 'string' && reason.trim() !== '') {
    return `桌面端没能完成这次操作，现在的版本不受影响。原因见下，通常检查网络后重试即可。 / The desktop app could not finish this operation and your current version is unchanged. The reason is below; checking the network and retrying usually fixes it.\n${reason.trim().slice(0, 600)}`
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
  // An ordinary install or uninstall that the manager never answered (#1066).
  // Deliberately not `update-incomplete`: that sentence ("the plugin may
  // already be removed while its replacement never installed") is about the
  // remove-then-install pair and reads as nonsense on a plain uninstall.
  'operation-incomplete': {
    zh: '桌面端没有在限定时间内答复这次操作：磁盘上可能已经改完了，市场只是没等到答复，所以没有回滚。重新打开 DSH 后市场会按磁盘状态核对；状态不对的话从「设置 → 插件」处理',
    en: 'the desktop app did not answer this operation in time: the change may already be on disk, and the market got no reply, so it rolled nothing back. Reopen DSH and the market checks what is actually there; if it still looks wrong, use Settings → Plugins',
  },
  // Refusals of the in-place update (`updateBundle`, dsh 0.2.2+). Every one
  // says what stopped, that the old version is still there, and what to do.
  'not-bundle': {
    zh: '新版本不是一个 DSH 插件包，桌面端没有安装它，现在的版本不受影响。请稍后再试，或联系插件作者',
    en: 'the new version is not a DSH plugin package, so the desktop app did not install it and your current version is unchanged. Try again later, or contact the plugin author',
  },
  'unexpected-package': {
    zh: '装出来的不是要求的版本（常见原因：这个版本还在新版本等待期内），桌面端已撤销这次更新，旧版本还在。过几天再更新一次',
    en: 'what got installed was not the requested version (a common cause: it is still inside the fresh-release wait), so the desktop app undid the update and your old version is still there. Try again in a few days',
  },
  'invalid-spec': {
    zh: '桌面端不接受这次更新的目标，没有改动任何东西。请刷新市场后再试',
    en: 'the desktop app did not accept the target of this update and changed nothing. Refresh the market and try again',
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

/**
 * A manager call the market stopped waiting for.
 *
 * Neither "nothing happened" nor "undo it": the manager may have written the
 * change already, so the next start reconciles against disk instead of the
 * market inventing an answer here (#1066).
 */
function unanswered(): ManagedResult {
  return { application: 'failed', error: { code: 'operation-incomplete' }, repairOnRestart: true }
}

/** What an update needs to journal itself and to be repaired later. */
interface UpdateContext {
  profile: string
  profileDirectory: string
  journal: PendingUpdateJournal
  /** Bundled pnpm from the official desktop launcher; only used for the market itself. */
  packageManager?: HostPackageManager | null
  /** Told when the market starts or ends a pnpm child of its own (the self-update overlay). */
  onOwnChild?: (running: boolean) => void
  /**
   * The Git commit's package version, for a Git bundle's in-place update: the
   * host demands the exact version the spec will install, and a commit's
   * version is only in its package.json. Null when it cannot be read — the
   * update then takes the remove-and-install path instead.
   */
  gitVersionAt?: (spec: string) => Promise<string | null>
  /**
   * Hear the host's own steps of one in-place update (`plugin-manager/update-
   * state`) so the page can say which one is running. Returns the unsubscribe.
   */
  watchUpdateSteps?: (requestId: string, listener: (step: string) => void) => () => void
}

/** What the update steps the host reports are called on the progress line. */
const UPDATE_STEP_LINES: Record<string, string> = {
  checking: '正在确认新版本可以装 / Checking that the new version can be installed',
  removing: '正在停掉旧版本 / Stopping the old version',
  installing: '正在安装新版本 / Installing the new version',
  restoring: '新版本没装上，正在装回旧版本 / The new version did not install; putting the old one back',
}

const GIT_HOSTS: Record<string, string> = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }

/**
 * The repository directory of a Git spec pinned to one full commit, spelled the
 * way the host compares them (`github.com/owner/repo`), or null for anything
 * else — a floating spec, a path selector, an address the host would read
 * differently. Only used to match a spec to the bundle it replaces; the host
 * checks the same thing again before it changes anything.
 */
function pinnedGitOrigin(spec: string): string | null {
  const hash = spec.indexOf('#')
  if (hash === -1 || !/^[0-9a-f]{40}$/i.test(spec.slice(hash + 1))) return null
  let location = spec.slice(0, hash)
  const shorthand = /^(github|gitlab|bitbucket):([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/i.exec(location)
  if (shorthand !== null) location = `${GIT_HOSTS[shorthand[1]!.toLowerCase()]!}/${shorthand[2]!}`
  else if (/^(?:git\+)?https?:\/\/[^@]+$/i.test(location)) location = location.replace(/^git\+/i, '').replace(/^https?:\/\//i, '')
  else return null
  return location.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^[^/]+/, host => host.toLowerCase())
}

/** Identify one declared subpackage after the manager reports already-installed. */
function installedGithubSubpackage(spec: string, context?: UpdateContext): string | undefined {
  const source = githubShortcut(spec)
  if (source?.subpath == null || context === undefined) return undefined
  const manifest = readProfileManifestSnapshot(context.profile, context.profileDirectory)
  const matches = Object.entries(manifest.dependencies).filter(([name, declared]) => {
    if (!NPM_NAME_RE.test(name) || typeof declared !== 'string') return false
    const installed = githubShortcut(declared)
    return installed?.repo.toLowerCase() === source.repo.toLowerCase() && installed.subpath === source.subpath
  })
  return matches.length === 1 ? matches[0]![0] : undefined
}

/** One update the host can do in place, decided before anything is asked of it. */
interface InPlaceUpdate {
  name: string
  from: string
  to: string
  /** The Git spec the host needs for a Git bundle; absent for a registry one. */
  gitSpec?: string
}

/**
 * Whether this spec is an update the host's `updateBundle` can do, and if so
 * exactly which one. Null means "use the remove-and-install path", always
 * safe: that is the only path on 0.2.1, and it is what handles everything the
 * in-place call refuses by contract —
 *
 * - a version that is not newer (a downgrade, a re-install of the same one,
 *   the update route's own rollback to the build from before);
 * - a dist-tag or range instead of an exact version;
 * - a package the host does not list as updatable (`update` absent): a link,
 *   a floating Git spec, an `npm:` alias, an installation-owned package;
 *
 * The market itself is NOT on that list any more. It used to be (#900: with
 * HMR the host removes the bundle first, which unloads the code that was going
 * to install the new one), because the pair was driven from here, step by
 * step. `updateBundle` runs the pair inside the host, which does not care that
 * the caller is gone; what is left to handle is the request that asked, see
 * `updateInPlace`. A host without `updateBundle` never reaches this code and
 * keeps the market's own overlay (`updateMarketInPlace`).
 */
async function planInPlaceUpdate(
  manager: OfficialPluginManagerLike,
  spec: string,
  context?: UpdateContext,
): Promise<InPlaceUpdate | null> {
  // Why a spec went the old way, in the log: "did it use updateBundle" is the
  // first thing a bug report about an update has to answer.
  const decline = (reason: string): null => {
    logEvent('info', 'update-in-place', `${spec}: not updated in place (${reason}); using remove and install`)
    return null
  }
  if (typeof manager.updateBundle !== 'function' || typeof manager.listBundles !== 'function') return null
  let rows: ManagedBundleRow[]
  try {
    rows = await manager.listBundles()
  } catch {
    // Reading the profile failed: the ordinary path reports that in its own words.
    return decline('the host could not list its bundles')
  }
  if (!Array.isArray(rows)) return decline('the host listed no bundles')
  const named = registryNameOf(spec)
  let row: ManagedBundleRow | undefined
  let to = ''
  let gitSpec: string | undefined
  if (named !== undefined) {
    row = rows.find(entry => entry.name === named)
    if (row?.update !== 'registry' && !(row?.update === undefined && row?.updatable === true)) return decline(row === undefined ? 'not an installed bundle' : 'the host does not list it as updatable from a registry')
    to = targetVersionOf(spec)
    if (to === '') return decline('the target is not an exact version')
  } else {
    const origin = pinnedGitOrigin(spec)
    if (origin === null) return decline('not a Git spec pinned to one commit')
    row = rows.find(entry => entry.update === 'git' && typeof entry.source === 'string' && pinnedGitOrigin(entry.source) === origin)
    if (row === undefined) return decline('no installed Git bundle comes from that repository commit pin')
    if (context?.gitVersionAt === undefined) return decline('the commit version cannot be read here')
    try {
      to = (await context.gitVersionAt(spec)) ?? ''
    } catch {
      to = ''
    }
    if (to === '') return decline('the commit version could not be read')
    gitSpec = spec
  }
  const from = row.version
  if (typeof from !== 'string' || !isSemver(from) || !isSemver(to)) return decline('a version is not a semver')
  if (compareSemver(to, from) <= 0) return decline(`${to} is not newer than ${from}`)
  return { name: row.name, from, to, ...(gitSpec === undefined ? {} : { gitSpec }) }
}

/** `applied`, `restart-required` and `overridden` are the answers that mean the change was kept. */
function kept(result: { application: string } | undefined): boolean {
  return result?.application === 'applied' || result?.application === 'restart-required' || result?.application === 'overridden'
}

/**
 * Update one bundle with the host's `updateBundle`: one call that checks the
 * target, swaps the versions and, when the new one does not install, puts the
 * old one back by itself.
 *
 * What stays of the old machinery, and why:
 *
 * - No second journal phase. The remove-then-install pair is the host's now,
 *   and it undoes its own half-done work, so the market has nothing in between
 *   to record. But the host's undo is still only as durable as its process: if
 *   the host dies, or the market stops waiting, between its removal and its
 *   reinstall, the package is gone from disk exactly as in #928. So ONE record
 *   brackets the call and is cleared the moment the answer proves the profile
 *   whole (updated, or old version back, or never touched); the next start
 *   reconciles from disk, as it always did, when no answer ever came.
 * - The deadline stays, now around the one call (`IN_PLACE_UPDATE_DEADLINE_MS`).
 *
 * Returns null when the host refuses the spec itself (`invalid-spec` at the
 * check, before it changed anything): the caller then takes the
 * remove-and-install path, which is today's behavior for that spec.
 */
async function updateInPlace(
  manager: OfficialPluginManagerLike,
  plan: InPlaceUpdate,
  options: { requestId?: string; registry?: string },
  context?: UpdateContext,
): Promise<ManagedResult | null> {
  const spec = plan.gitSpec ?? `${plan.name}@${plan.to}`
  const record = context?.journal.begin({
    profile: context.profile,
    name: plan.name,
    from: plan.from,
    to: plan.to,
    spec,
  })
  const settle = (): void => { if (record !== undefined) context?.journal.finish(record.id) }
  // The line a bug report needs to tell which path an update took.
  logEvent('info', 'update-in-place', `${plan.name} ${plan.from} -> ${plan.to}: asking the host to update it in place`)
  progress.lastLine = UPDATE_STEP_LINES.checking!
  const unwatch = options.requestId === undefined
    ? undefined
    : context?.watchUpdateSteps?.(options.requestId, step => {
      const line = UPDATE_STEP_LINES[step]
      if (line !== undefined) progress.lastLine = line
    })
  let outcome: ManagedUpdateResult
  try {
    outcome = await withDeadline(
      trackManagerWrite(manager.updateBundle!(plan.name, plan.to, {
        ...(options.registry === undefined ? {} : { registry: options.registry }),
        ...(plan.gitSpec === undefined ? {} : { spec: plan.gitSpec }),
        ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
      })),
      IN_PLACE_UPDATE_DEADLINE_MS,
      `update ${plan.name}`,
    )
  } catch (error) {
    if (error instanceof DeadlineExceeded) return interrupted()
    // A call that threw never reported a result, which this host does only
    // before it changes anything (the profile could not be read, the manager
    // was disposed). The record stays unless the disk shows the old build.
    if (context !== undefined && readInstalledVersion(context.profile, plan.name, context.profileDirectory) === plan.from) settle()
    throw error
  } finally {
    // The listener hangs off the context that asked, which a self-update has
    // already disposed by now; letting go of it must never decide the answer.
    try { unwatch?.() } catch { /* nothing left to release */ }
  }
  const last = outcome.result
  logEvent('info', 'update-in-place', `${plan.name}: the host answered at step ${outcome.step}: ${last.application}${managementCode(last.error) === undefined ? '' : ` (${managementCode(last.error)!})`}${outcome.restore === undefined ? '' : `; restore ${outcome.restore.application}`}`)
  const asManaged = (result: typeof last): ManagedResult => ({
    application: result.application,
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.packageResult === undefined ? {} : { packageResult: result.packageResult }),
  })
  // The market updating ITSELF. With HMR the host removes the running bundle
  // before it installs the new one, so by the time this call answers, this
  // very instance has been disposed and its replacement is serving (measured
  // on dsh 0.2.2-rc.5 and 0.2.3-alpha.2, tests/web/desktop-update.e2e.ts).
  // What survives is this closure: it can still answer the HTTP request —
  // the response belongs to the web server, not to the plugin — but anything
  // that asks the disposed context for a service (`loader`, to read what is
  // live) throws, which turned a finished update into a 500. The caller is
  // told, and answers from the result alone. Without HMR the host installs
  // over the running version instead (`restart-required`), nothing is
  // disposed, and the ordinary reply applies.
  const tornDown = SELF_NAMES.has(plan.name) && outcome.step === 'install'
    && (kept(last) ? last.application !== 'restart-required' : outcome.restore !== undefined)
  const swapped = <T extends ManagedResult>(result: T): T => tornDown ? { ...result, selfSwapped: true } : result
  if (outcome.step === 'install' && kept(last)) {
    settle()
    if (last.application === 'restart-required') markRestartPending()
    return swapped({ ...asManaged(last), ...(last.application === 'applied' ? { liveSwap: true } : {}) })
  }
  if (outcome.step === 'check') {
    settle()
    // The host cannot express this update at all (not newer, not updatable):
    // nothing changed, and the ordinary path can still do it.
    if (managementCode(last.error) === 'invalid-spec') return null
    // `not-bundle` at the check is the host reading `dsh` out of `pnpm view`,
    // and pnpm 11 can answer that from its own install cache, which keeps only
    // the fields an install needs: no `dsh`. Measured on dsh 0.2.2-rc.5 with
    // the Tencent mirror (the China region's registry): any plugin that had
    // not been republished since it was installed was refused this way, the
    // market included, while the same `pnpm view` with an empty cache printed
    // the bundle. Nothing changed yet, and the ordinary path installs and
    // checks the real package, so it takes over; a version that truly is not
    // a bundle is still refused there, by the install, and rolled back.
    // (Libraries never get this far: the update list leaves them out, #793.)
    if (managementCode(last.error) === 'not-bundle') {
      logEvent('warn', 'update-in-place', `${plan.name}: the host's registry check found no bundle in ${plan.to}, which pnpm's metadata cache can cause; using the ordinary update path instead`)
      return null
    }
    return { ...asManaged(last), untouched: true }
  }
  if (outcome.step === 'remove') {
    // The removal itself failed or was cancelled, so nothing was unloaded.
    settle()
    if (last.application === 'failed' && managementCode(last.error) === 'bundle-in-use' && restartPending()) {
      return { ...asManaged(last), needsRestart: true, untouched: true }
    }
    return { ...asManaged(last), untouched: true }
  }
  // The install failed or was cancelled. With HMR the host removed the old
  // version first and has tried to put it back.
  if (outcome.restore !== undefined) {
    if (kept(outcome.restore)) {
      settle()
      return swapped({
        ...asManaged(last),
        untouched: true,
        note: '旧版本已经装回，没有丢东西。 / The old version was put back; nothing was lost.',
      })
    }
    // Neither version is installed. Do not ask the same host to restore it
    // again from the route (it just failed to) and keep the record, re-aimed
    // at the OLD version: the target just failed to install, and the next
    // start's repair must put back what the user had, not retry what failed.
    if (record !== undefined && context !== undefined) {
      context.journal.begin({ profile: context.profile, name: plan.name, from: plan.from, to: plan.from, spec: `${plan.name}@${plan.from}` })
    }
    return swapped({
      ...asManaged(last),
      repairOnRestart: true,
      note: `旧版本也没能装回，这个插件现在是缺的。重新打开 DSH 后市场会自动装回 ${plan.from}；也可以现在从「设置 → 插件」重新安装它。 / The old version could not be put back either, so the plugin is missing right now. Reopen DSH and the market will reinstall ${plan.from}, or reinstall it from Settings → Plugins now.`,
    })
  }
  // No restore ran: a host without HMR installs over the running version and
  // the failure left the old files in place. That is the ordinary failed
  // install, and the route's own rollback applies as it always did.
  settle()
  return asManaged(last)
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
  progress.lastLine = '正在更新市场本身，不会先卸载它 / Updating the market itself without unloading it'
  const args = ['add', spec]
  if (typeof options.registry === 'string' && options.registry !== '') args.push(`--registry=${options.registry}`)
  context.onOwnChild?.(true)
  const run = await runHostPnpm(invocation, directory, args).finally(() => context.onOwnChild?.(false))
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
  const classified = classifyPnpmFailure(output, run.exitCode, { profileDirectory: directory })
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
  const install = (): Promise<ManagedResult> => trackManagerWrite(manager.installBundle(spec, options))
  // dsh 0.2.2+ replaces an installed bundle in one call. Everything it cannot
  // express falls through to the remove-and-install path below, unchanged.
  // (Not awaited on a manager without it: the install call stays synchronous.)
  const plan = typeof manager.updateBundle === 'function' ? await planInPlaceUpdate(manager, spec, context) : null
  if (plan !== null) {
    const updated = await updateInPlace(manager, plan, options, context)
    if (updated !== null) return updated
  }
  let first: ManagedResult
  try {
    // Bounded like every other manager call: a plain install the host never
    // answers used to be bounded only by the whole-operation backstop, which
    // has to cover remove-then-install and is therefore twice as long (#1250).
    first = await withDeadline(install(), INSTALL_DEADLINE_MS, `install ${spec}`)
  } catch (error) {
    if (error instanceof DeadlineExceeded) return unanswered()
    if (managementCode(error) !== 'already-installed') throw error
    first = { application: 'failed', error }
  }
  if (first.application !== 'failed' || managementCode(first.error) !== 'already-installed') return first
  const registryName = registryNameOf(spec)
  const name = registryName ?? installedGithubSubpackage(spec, context)
  // A refusal we cannot turn into a name is the manager's answer to give.
  if (name === undefined) return first
  // Removing the market would unload this very code before the reinstall runs
  // (#900). Overlay the version with the host's own pnpm instead — no remove.
  if (SELF_NAMES.has(name)) {
    return registryName === undefined ? first : updateMarketInPlace(spec, name, options, context)
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
  progress.lastLine = '先移除旧版本，桌面端才能装新版本 / Removing the old version so the desktop app can install the new one'
  let removed: ManagedResult
  try {
    removed = await withDeadline(trackManagerWrite(manager.removeBundle(name)), REMOVE_DEADLINE_MS, `remove ${name}`)
  } catch (error) {
    if (error instanceof DeadlineExceeded) return interrupted()
    if (record !== undefined) context?.journal.finish(record.id)
    throw error
  }
  if (removed.application === 'failed' || removed.application === 'cancelled') {
    // Nothing was unloaded, so there is nothing for a later start to repair.
    if (record !== undefined) context?.journal.finish(record.id)
    // An update already landed behind a restart in this process, and the
    // host now says `bundle-in-use` for a plugin it put back itself (#1253).
    // It is the same wait for a restart, not a plugin that is really in use.
    if (removed.application === 'failed' && managementCode(removed.error) === 'bundle-in-use' && restartPending()) {
      return { ...removed, needsRestart: true }
    }
    return removed
  }
  if (record !== undefined) context?.journal.mark(record.id, 'installing')
  progress.lastLine = '正在安装新版本 / Installing the new version'
  try {
    const installed = await withDeadline(install(), INSTALL_DEADLINE_MS, `install ${spec}`)
    if (installed.application === 'failed' || installed.application === 'cancelled') {
      // The replacement did not land; the record stays so the next start can
      // put it back rather than leaving the package gone.
      return installed
    }
    if (record !== undefined) context?.journal.finish(record.id)
    if (installed.application === 'restart-required') markRestartPending()
    return installed
  } catch (error) {
    if (error instanceof DeadlineExceeded) return interrupted()
    throw error
  }
}

/**
 * The operation the desktop manager is running, visible to every instance of
 * this runtime in the process (#1151).
 *
 * The host reloads the market while an operation the market started is still
 * inside the manager, so the instance that began it is disposed and a new one
 * is built around it. The new one has no `active` of its own and would call
 * the manager idle: it would start a second operation into the first, and its
 * start-up repair would take the removal in progress for an interrupted one.
 * The slot lives on `globalThis` because a reload may evaluate this module
 * again, which a module-level variable would not survive.
 */
const RESTART_SLOT = Symbol.for('dshmarket.officialDesktop.restartPending')

/**
 * Whether an update in THIS host process already settled behind a restart.
 * On the global like the slots below: a market reload keeps the process, and
 * the process is what has to restart.
 */
function restartPending(): boolean {
  return (globalThis as { [RESTART_SLOT]?: boolean })[RESTART_SLOT] === true
}
function markRestartPending(): void {
  (globalThis as { [RESTART_SLOT]?: boolean })[RESTART_SLOT] = true
}
/** Test seam: a new host process starts with nothing pending. */
export function forgetRestartPending(): void {
  delete (globalThis as { [RESTART_SLOT]?: boolean })[RESTART_SLOT]
}

/** What the user reads when the host asks for a restart before the next update (#1253). */
const RESTART_FIRST_MESSAGE = '这一轮只能更新到这里。重启后再点「全部更新」继续。 / This run can only go this far. Restart, then click Update all to continue.'

const OPERATION_SLOT = Symbol.for('dshmarket.officialDesktop.operation')
const WRITE_SLOT = Symbol.for('dshmarket.officialDesktop.packageWrites')

/** Keep the native promises across a market reload, including after a route deadline. */
function pendingManagerWrites(): Set<Promise<unknown>> {
  const processState = globalThis as { [WRITE_SLOT]?: Set<Promise<unknown>> }
  return processState[WRITE_SLOT] ??= new Set()
}

function trackManagerWrite<T>(work: Promise<T>): Promise<T> {
  const pending = pendingManagerWrites()
  pending.add(work)
  const remove = () => pending.delete(work)
  void work.then(remove, remove)
  return work
}

interface RunningOperation { done: Promise<unknown> }
function runningOperation(): RunningOperation | undefined {
  return (globalThis as { [OPERATION_SLOT]?: RunningOperation })[OPERATION_SLOT]
}
function setRunningOperation(operation: RunningOperation | undefined): void {
  const slot = globalThis as { [OPERATION_SLOT]?: RunningOperation }
  if (operation === undefined) delete slot[OPERATION_SLOT]
  else slot[OPERATION_SLOT] = operation
}

/** The official runtime's own surface, plus the repair a later start owes the profile. */
export interface OfficialDesktopRuntime extends DesktopPluginRuntime {
  /**
   * Finish or undo an update an earlier start left half-applied (#928).
   * Returns after every record settled or was found unrepairable; never throws.
   */
  repairPendingUpdates(): Promise<RepairReport>
  /**
   * Whether the manager is already running an operation of its own — the
   * state that makes `runPlugin` answer `busy: true` (see
   * `PluginCommandRuntime.busy`). `/dsh-market/status` reports it so the
   * client's queue waits instead of retrying into a refusal every 2s (#1140).
   */
  busy(): boolean
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
  // What only the host process can supply to an in-place update (see
  // `UpdateContext`); both are optional, and an update without them still works.
  hooks?: Pick<UpdateContext, 'gitVersionAt' | 'watchUpdateSteps'>,
): OfficialDesktopRuntime {
  let disposed = false
  let repairing = false
  // True only while the self-update overlay runs its own pnpm child: the one
  // operation this instance, and nobody else, has to stop and wait for.
  let ownsChild = false
  let active: { requestId?: string; cancelled: boolean; done: Promise<InstallResult> } | undefined
  const directory = safeProfileDirectory(profileName, _profileDirectory)
  const journal = directory === undefined ? undefined : PendingUpdateJournal.forProfile(directory)
  const updateContext: UpdateContext | undefined = directory === undefined || journal === undefined
    ? undefined
    : {
      profile: profileName,
      profileDirectory: directory,
      journal,
      packageManager,
      onOwnChild: running => { ownsChild = running },
      ...(hooks?.gitVersionAt === undefined ? {} : { gitVersionAt: hooks.gitVersionAt }),
      ...(hooks?.watchUpdateSteps === undefined ? {} : { watchUpdateSteps: hooks.watchUpdateSteps }),
    }

  const busy = (): boolean => active !== undefined || repairing || runningOperation() !== undefined

  const runPlugin: DesktopPluginRuntime['runPlugin'] = (profile, argv) => {
    if (disposed) return Promise.resolve(failure('official desktop plugin runtime is disposed', 127))
    if (profile !== profileName) return Promise.resolve(failure('refusing to change a different profile', 127))
    // A repair uses the same manager; overlapping the two would race the
    // profile's write lock and the route's single-operation rule.
    if (busy()) return Promise.resolve({ ...failure('another plugin operation is running', 127), busy: true })
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
    if (extra.length !== 0 || typeof target !== 'string' || !(command === 'add' ? acceptsManagedAddTarget(target) : TARGET_RE.test(target))) {
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
    progress.lastLine = '桌面端的插件管理器正在处理 / The desktop app\'s plugin manager is working on it'
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
      // The host's manager has no deadline of its own (#1066): a call that
      // never settles held the profile's write lock and left the panel saying
      // "working" forever, while its pnpm had in fact finished seconds later.
      // The update path has had these deadlines for exactly that reason; an
      // ordinary install or uninstall needs the same bound.
      const deadline = command === 'remove'
        ? REMOVE_DEADLINE_MS
        : typeof manager.updateBundle === 'function' ? IN_PLACE_OPERATION_DEADLINE_MS : OPERATION_DEADLINE_MS
      operation = withDeadline(
        command === 'remove'
          ? trackManagerWrite(manager.removeBundle(target))
          : installOrReinstall(manager, spec, options, updateContext),
        deadline,
        `${command} ${target}`,
      ).catch((error: unknown) => {
        if (!(error instanceof DeadlineExceeded)) throw error
        return unanswered()
      })
    } catch (error) {
      progress.active = false
      return Promise.resolve(failure(detail(error), 127))
    }
    const current = { requestId, cancelled: false, done: Promise.resolve(failure('not started')) }
    active = current
    const flight: RunningOperation = { done: current.done }
    setRunningOperation(flight)
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
      const account = result.needsRestart === true ? RESTART_FIRST_MESSAGE : detail(result.error)
      const message = ok ? '' : result.note === undefined ? account : `${account} ${result.note}`
      if (!ok) progress.error = message
      // A later success for this package outdates what start-up repair said
      // about it earlier in this process.
      if (ok && directory !== undefined) {
        const settledName = registryNameOf(target)
        if (settledName !== undefined) clearStartupRepairEntry(profileName, directory, settledName)
      }
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
        wroteNothing: !ok && !repairOnRestart
          && (result.untouched === true || result.packageResult === undefined || prePnpmHostFailure(result)),
        ...(repairOnRestart ? { repairOnRestart: true } : {}),
        // The manager's own code, kept machine-readable (#909): a client can
        // tell a self-update refusal from an ordinary failure.
        ...(ok ? {} : { refusalCode: managementCode(result.error) }),
        ...(result.needsRestart === true ? { needsRestart: true } : {}),
        ...(result.selfSwapped === true ? { selfSwapped: true } : {}),
        ...(ok && result.liveSwap === true ? { liveSwap: true } : {}),
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
      if (runningOperation() === flight) setRunningOperation(undefined)
    })
    flight.done = current.done
    return current.done
  }

  const repairPendingUpdates = async (): Promise<RepairReport> => {
    const empty: RepairReport = { reinstalled: [], finished: [], failed: [], abandoned: [] }
    // An operation a previous instance started is still inside the manager:
    // its journal record is in progress, not interrupted. Let it settle first
    // — it finishes its own record on success, and a failure leaves the
    // record for exactly this repair. The operation is bounded by its own
    // deadline, so this wait is too.
    if (active === undefined) await runningOperation()?.done.catch(() => {})
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
    busy,
    packageWritesSettled: () => pendingManagerWrites().size === 0,
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
    supportsExactRollbackTarget: acceptsManagedAddTarget,
    // The reason the flag exists (#732): this manager takes exactly
    // `add <target>` or `remove <target>`, so every recovery step that needs
    // an option has to be left out here rather than sent and refused.
    acceptsMarketPnpmFlags: false,
    dispose: async () => {
      disposed = true
      const running = active
      // An operation inside the host's manager is the host's to finish (#1151).
      // The host reloads the market in the middle of the operation the market
      // started — and its reconciliation waits for this very disposer — so
      // waiting here for the operation, which waits for the reconciliation,
      // is a cycle: the market was already unmounted, the request never
      // answered, the profile lock stayed held. Cancelling would also abort
      // the update the user asked for halfway. Let it run; the next instance
      // sees it through `runningOperation`.
      if (running !== undefined && !ownsChild) {
        void running.done.catch(() => {})
        return
      }
      if (running?.requestId !== undefined) {
        const manager = managerLookup()
        if (manager !== undefined) void manager.cancelInstall(running.requestId).catch(() => {})
      }
      cancelHostChild()
      await running?.done
    },
  }
}
