/**
 * Theme lifecycle: classifying installed packages as themes (by the
 * registry's theme category), live-toggling bundle-layer entries through
 * the loader, and keeping exactly one theme active with the choice
 * persisted across restarts.
 */

import { join } from 'node:path'
import { loadRegistry, pluginCategories } from './registry.ts'
import { hotMount, hotMountDisposalError, hotUnmount, listHotMounts, writeDisabled, type HotMountResult } from './hot.ts'
import { logEvent } from './log.ts'
import { LifecycleWaitError, waitForLifecycle } from './lifecycle.ts'
import { nameMatchesPackage } from './entry-identity.ts'
import { bundlePatchInsertedIds, profileDir, readInstalled } from './profile.ts'
import { repoOf } from './sources.ts'

/** The slice of a cordis loader entry the market needs for live enable/disable. */
export interface LoaderEntry {
  options: { id?: string; name?: string; disabled?: boolean | null }
  fiber?: unknown
  update(options: { disabled: boolean | null }, create?: boolean, force?: boolean): Promise<void>
}

/** The host surface the theme manager needs (loader entries + hot-mount context). */
export interface ThemeHost {
  loader: { entries(): Iterable<LoaderEntry> }
  plugin(plugin: unknown, config: unknown): { await(): Promise<unknown>; dispose(): Promise<unknown> | void }
}

/** Manages theme exclusivity for one profile. */
export interface ThemeManager {
  installedThemeNames(): Promise<Set<string>>
  setEntryDisabled(name: string, disabledFlag: boolean, requireLive?: boolean, rejectPending?: boolean): Promise<boolean>
  /**
   * One toggle transaction over several names: stage the durable writes, drive
   * the live composition, publish state last. Restores the runtime it touched
   * when anything fails, and reports `deferred` when the host could not settle
   * (restart is the remedy) rather than `failed`.
   */
  changeEnabled(choices: readonly { name: string; enabled: boolean }[], commit: (next: Set<string>) => void): Promise<HotMountResult>
  /** True while a changeEnabled call owns these names (#582). */
  isChanging(name: string): boolean
  /** True when the name is live right now, by hot mount or by loader entry. */
  isLive(name: string): boolean
  activateTheme(name: string): Promise<boolean>
}

/**
 * Whether a loader entry belongs to `packageName`.
 *
 * A bundle patch need not name its own package. Two shapes exist (#619, the
 * toggle-side half of #71):
 *
 *  - a SUBPATH entry — `aegis` mounts `aegis/extensions/dsh/index.js`,
 *    `toolshrink` mounts `toolshrink/harness`. Matched with the same `name/`
 *    bound `liveIncludes()` uses, so a differently-suffixed package
 *    (`toolshrink-extra`) can never match.
 *  - a CARRIER bundle — `@deepseek-ai/dsh-experimental-agent-team-profile`
 *    mounts entries named `@deepseek-ai/dsh-experimental-agent-team` and
 *    `@deepseek-ai/dsh-experimental-tool-agent-team`. There is no name
 *    relation at all, so this falls back to the entry id the package's own
 *    patch inserts — the rule `carriedRowLive()` uses (#156).
 */
function ownsLoaderEntry(
  entry: LoaderEntry,
  packageName: string,
  ownedIds: ReadonlySet<string>,
): boolean {
  const entryName = entry.options.name
  if (nameMatchesPackage(entryName, packageName)) return true
  const id = entry.options.id
  if (id === undefined || id === '') return false
  // Loader ids may carry an include prefix (`include:<key>:<id>`); the bare
  // id is what a bundle patch declares.
  return ownedIds.has(id.split(':').pop() ?? id)
}

/**
 * Create the theme manager. `disabledThemes` is the live, shared set of
 * themes the user switched off — the caller owns reading it at boot and
 * replaying it; the manager mutates and persists it on switches.
 */
export function createThemeManager(
  host: ThemeHost,
  profile: string,
  disabledThemes: Set<string>,
  explicitDir?: string,
): ThemeManager {
  const activeProfileDir = profileDir(profile, explicitDir)
  /** Installed package names classified as themes by the registry's theme category. */
  async function installedThemeNames(): Promise<Set<string>> {
    const names = new Set<string>()
    try {
      const registry = await loadRegistry()
      const themeEntries = registry.plugins.filter(p => pluginCategories(p).includes('theme'))
      const themeNames = new Set(themeEntries.map(p => p.name))
      const themeRepos = new Set(
        themeEntries.map(p => repoOf(p.url)).filter((r): r is string => r !== null).map(r => r.toLowerCase()),
      )
      for (const [name, spec] of Object.entries(readInstalled(profile, activeProfileDir))) {
        if (themeNames.has(name)) {
          names.add(name)
          continue
        }
        const match = /github:([^#\s]+)/.exec(String(spec).toLowerCase())
        if (match !== null && themeRepos.has(match[1])) names.add(name)
      }
    } catch { /* registry unavailable — nothing classifies as a theme */ }
    return names
  }

  /**
   * Live-toggle a bundle-layer plugin through its loader entry. Bundle trees
   * are in-memory (write is a no-op), so this never touches any file — the
   * market persists the choice itself and replays it at boot.
   * @returns true when a matching live entry was found and updated.
   */
  /** Every loader entry that belongs to this package (its own rows and names). */
  function matchingEntries(name: string): LoaderEntry[] {
    const ownedIds = new Set(bundlePatchInsertedIds(join(activeProfileDir, 'node_modules', name)))
    return [...host.loader.entries()].filter(entry => ownsLoaderEntry(entry, name, ownedIds))
  }

  /**
   * Entries whose last update did not settle.
   *
   * A rejected update leaves the loader object in a state nobody can describe,
   * so a later ENABLE of the same entry is refused until a disable (which
   * cannot make things worse) has been seen through. Without this an enable
   * after a crashed disable reports success over a fiber that is not there.
   */
  const uncertainEntries = new WeakSet<LoaderEntry>()
  async function updateEntry(entry: LoaderEntry, disabled: boolean | null, restoring = false): Promise<void> {
    if (!disabled && !restoring && uncertainEntries.has(entry)) {
      throw new LifecycleWaitError('loader entry: runtime state is uncertain; retry disabling before enabling')
    }
    try {
      await waitForLifecycle(entry, () => entry.update({ disabled }, false, true),
        `${entry.options.name ?? entry.options.id ?? 'entry'}: loader update`)
      uncertainEntries.delete(entry)
    } catch (error) {
      uncertainEntries.add(entry)
      throw error
    }
  }

  /**
   * Live-toggle a bundle-layer plugin through its loader entry.
   *
   * `requireLive` is the strict mode: the caller needs the requested state to
   * be true when this returns, so an update that does not settle is an error
   * rather than a log line, and every entry touched on the way is restored to
   * the state it had before (#575, #582). The legacy theme and boot-replay
   * callers keep the best-effort semantics they were written against.
   *
   * @returns true when a matching live entry was found and updated.
   */
  async function setEntryDisabled(name: string, disabledFlag: boolean, requireLive = false, rejectPending = false): Promise<boolean> {
    const previous: { entry: LoaderEntry; disabled: boolean | null | undefined; live: boolean }[] = []
    try {
      let found = false
      for (const entry of matchingEntries(name)) {
        if (!disabledFlag && uncertainEntries.has(entry)) {
          throw new LifecycleWaitError('loader entry: runtime state is uncertain; retry disabling before enabling')
        }
        if (requireLive) previous.push({ entry, disabled: entry.options.disabled, live: entry.fiber !== undefined })
        // A disable can land while the entry's init is still in flight: the
        // options flip but the finishing init brings the fiber up anyway, and a
        // plain re-update no-ops on the empty diff. Force the update and verify
        // the live state, retrying until reality matches the flag.
        // More attempts than the legacy loop's three: a strict caller is
        // waiting for a state it can verify, and on a real host the fiber does
        // not always drop within the first few hundred milliseconds (measured
        // in tests/web/failed-enable.e2e.ts, where a theme replacement stopped
        // being reported as a failure once the wait was long enough).
        for (let attempt = 0; attempt < 12; attempt++) {
          try {
            await updateEntry(entry, disabledFlag ? true : null)
            found = true
          } catch (error) {
            // A strict caller cannot accept an update that did not settle; a
            // pending one is also fatal for a caller that asked to be told.
            if (requireLive || (rejectPending && error instanceof LifecycleWaitError)) throw error
            logEvent('warn', 'toggle', `${name}: entry update failed — ${error instanceof Error ? error.message : String(error)}`)
            break
          }
          const live = entry.fiber !== undefined
          if (live !== disabledFlag) break
          await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
        }
        if (requireLive && (entry.fiber !== undefined) === disabledFlag) {
          throw new Error(`${name}: loader entry ${disabledFlag ? 'did not stop' : 'did not become live'}`)
        }
        logEvent('info', 'toggle',
          `${name} -> ${disabledFlag ? 'off' : 'on'}: fiber=${String(entry.fiber !== undefined)}`)
      }
      if (!found) logEvent('info', 'toggle', `${name}: no loader entry matched`)
      return found
    } catch (error) {
      // Put back what this call changed, in reverse, and say so when that
      // fails too: a rollback that reports success while the runtime is
      // somewhere else is the failure mode this exists for.
      const rollbackErrors: string[] = []
      for (const { entry, disabled, live } of previous.reverse()) {
        try {
          await updateEntry(entry, disabled ?? null, true)
          if (disabled === undefined) delete entry.options.disabled
          if ((entry.fiber !== undefined) !== live) throw new Error(`${name}: loader entry did not restore its previous live state`)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError))
        }
      }
      if (rollbackErrors.length) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; entry restoration failed: ${rollbackErrors.join('; ')}`)
      }
      throw error
    }
  }

  /**
   * Make `name` the one active theme: deactivate every other installed theme
   * (market hot mounts unmount; bundle-layer entries live-disable) and bring
   * it up. The choice persists in state.json and is replayed at boot.
   */
  /** Names a changeEnabled call currently owns; the boot replay skips them. */
  const changing = new Set<string>()
  const isLive = (name: string): boolean =>
    listHotMounts().includes(name) || matchingEntries(name).some(entry => entry.fiber !== undefined)

  /**
   * One toggle transaction: stage, activate, publish.
   *
   * The order is the point. `commit` is called only after every choice is
   * live (or deferred, which is the host's answer and not a failure), so a
   * failure never publishes a state.json that claims a plugin is enabled while
   * its fiber is not there — and the runtime this call touched is restored to
   * what it was before (#575, #582).
   *
   * @returns `live` when everything the caller asked for is up, `deferred` when
   * the host could not settle it in time (restart applies it), `failed` when
   * activation was rejected.
   */
  async function changeEnabled(
    choices: readonly { name: string; enabled: boolean }[],
    commit: (next: Set<string>) => void,
  ): Promise<HotMountResult> {
    const names = new Set(choices.map(choice => choice.name))
    const hotBefore = new Set(listHotMounts().filter(name => names.has(name)))
    const entries = [...new Set([...names].flatMap(matchingEntries))]
      .map(entry => ({ entry, disabled: entry.options.disabled, live: entry.fiber !== undefined }))
    const restore = async (): Promise<void> => {
      const errors: string[] = []
      for (const name of names) {
        try {
          if (!hotBefore.has(name) && listHotMounts().includes(name)) await hotUnmount(name, true)
          if (hotBefore.has(name) && !listHotMounts().includes(name)) {
            const restored = await hotMount(host, activeProfileDir, name)
            if (!restored.ok) throw new Error(restored.reason)
          }
        } catch (error) { errors.push(`${name}: ${String(error)}`) }
      }
      for (const { entry, disabled, live } of entries.reverse()) {
        try {
          if (entry.options.disabled !== disabled || (entry.fiber !== undefined) !== live) {
            await updateEntry(entry, disabled ?? null, true)
            if (disabled === undefined) delete entry.options.disabled
            if ((entry.fiber !== undefined) !== live) throw new Error('previous live state was not restored')
          }
        } catch (error) { errors.push(`${entry.options.name ?? ''}: ${String(error)}`) }
      }
      if (errors.length) throw new Error(`runtime restoration failed: ${errors.join('; ')}`)
    }
    for (const name of names) changing.add(name)
    try {
      const next = new Set(disabledThemes)
      let result: HotMountResult = { ok: true, outcome: 'live', reason: null }
      for (const { name, enabled } of choices) {
        if (enabled) {
          const disposalError = hotMountDisposalError(name)
          if (disposalError !== undefined) {
            throw new Error(`${disposalError}; runtime state is uncertain; retry disabling before enabling`)
          }
          if (!listHotMounts().includes(name) && !await setEntryDisabled(name, false, true)) {
            result = await hotMount(host, activeProfileDir, name)
            if (result.outcome === 'failed') throw new Error(result.reason)
          }
          next.delete(name)
        } else {
          // A theme replacement has to wait for the old entry to actually stop
          // (two themes live at once is the state the Themes tab exists to
          // prevent). An ordinary disable keeps the deferred fallback, but a
          // hung update is still an error the caller asked to hear about.
          await hotUnmount(name, true)
          await setEntryDisabled(name, true, choices.length > 1, true)
          next.add(name)
        }
      }
      commit(next)
      disabledThemes.clear()
      for (const name of next) disabledThemes.add(name)
      return result
    } catch (error) {
      let reason = error instanceof Error ? error.message : String(error)
      try { await restore() } catch (restoreError) { reason += `; ${String(restoreError)}` }
      return { ok: false, outcome: 'failed', reason }
    } finally {
      for (const name of names) changing.delete(name)
    }
  }

  /**
   * Make `name` the one active theme.
   *
   * A theme switch is a two-choice transaction: every other theme goes off and
   * this one comes on, staged and published as one thing (see changeEnabled).
   * The failure case is why it is a transaction — stopping the old theme is
   * part of switching, so a switch that then fails would leave the user with NO
   * theme at all: the old one stopped, the new one never started, while the tab
   * listed the plugin as enabled (#582). The transaction restores the old one.
   */
  async function activateTheme(name: string): Promise<boolean> {
    const choices = [...await installedThemeNames()]
      .filter(other => other !== name && (!disabledThemes.has(other) || isLive(other)))
      .map(other => ({ name: other, enabled: false }))
    choices.push({ name, enabled: true })
    return (await changeEnabled(choices, next => {
      writeDisabled(activeProfileDir, next)
    })).ok
  }

  return { installedThemeNames, setEntryDisabled, activateTheme, changeEnabled, isChanging: name => changing.has(name), isLive }
}
