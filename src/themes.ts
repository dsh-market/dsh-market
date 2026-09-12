/**
 * Theme lifecycle: classifying installed packages as themes (by the
 * registry's theme category), live-toggling bundle-layer entries through
 * the loader, and keeping exactly one theme active with the choice
 * persisted across restarts.
 */

import { loadRegistry, pluginCategories } from './registry.ts'
import { hotMount, hotMountDisposalError, hotUnmount, listHotMounts, writeDisabled, type HotMountResult } from './hot.ts'
import { logEvent } from './log.ts'
import { profileDir, readInstalled } from './profile.ts'
import { rowIdsForPackage } from './patch.ts'
import { repoOf } from './sources.ts'
import { LifecycleWaitError, waitForLifecycle } from './lifecycle.ts'

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
  setEntryDisabled(name: string, disabledFlag: boolean, requireLive?: boolean): Promise<boolean>
  activateTheme(name: string): Promise<boolean>
  changeEnabled(choices: readonly { name: string; enabled: boolean }[], commit: (next: Set<string>) => void): Promise<HotMountResult>
  isChanging(name: string): boolean
  isLive(name: string): boolean
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

  function matchingEntries(name: string): LoaderEntry[] {
    const ids = new Set(rowIdsForPackage(host, activeProfileDir, name))
    return [...host.loader.entries()].filter(entry => entry.options.name === name
      || (entry.options.id !== undefined && (ids.has(entry.options.id) || ids.has(entry.options.id.split(':').pop()!))))
  }

  const uncertainEntries = new WeakSet<LoaderEntry>()
  async function updateEntry(entry: LoaderEntry, disabled: boolean | null, restoring = false): Promise<void> {
    if (!disabled && !restoring && uncertainEntries.has(entry)) {
      throw new LifecycleWaitError('loader entry: runtime state is uncertain; retry disabling before enabling')
    }
    try {
      await waitForLifecycle(entry, () => entry.update({ disabled }, false, true), `${entry.options.name ?? entry.options.id ?? 'entry'}: loader update`)
      uncertainEntries.delete(entry)
    } catch (error) {
      uncertainEntries.add(entry)
      throw error
    }
  }

  /**
   * Live-toggle a bundle-layer plugin through its loader entry. Bundle trees
   * are in-memory (write is a no-op), so this never touches any file — the
   * market persists the choice itself and replays it at boot.
   * @returns true when a matching live entry was found and updated.
   */
  async function setEntryDisabled(name: string, disabledFlag: boolean, requireLive = false, rejectPending = false): Promise<boolean> {
    // Strict requests require the requested fiber state. The legacy theme and
    // disable paths retain their existing best-effort semantics.
    const previous: { entry: LoaderEntry; disabled: boolean | null | undefined; live: boolean }[] = []
    try {
      let found = false
      for (const entry of matchingEntries(name)) {
        if (!disabledFlag && uncertainEntries.has(entry)) throw new LifecycleWaitError('loader entry: runtime state is uncertain; retry disabling before enabling')
        if (requireLive) previous.push({ entry, disabled: entry.options.disabled, live: entry.fiber !== undefined })
        // A disable can land while the entry's init is still in flight: the
        // options flip but the finishing init brings the fiber up anyway, and a
        // plain re-update no-ops on the empty diff. Force the update and verify
        // the live state, retrying until reality matches the flag.
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await updateEntry(entry, disabledFlag ? true : null)
            found = true
          } catch (error) {
            if (requireLive || (rejectPending && error instanceof LifecycleWaitError)) throw error
            logEvent('warn', 'toggle', `${name}: entry update failed — ${error instanceof Error ? error.message : String(error)}`)
            break
          }
          const live = entry.fiber !== undefined
          if (live !== disabledFlag) break
          await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
        }
        if (requireLive && (entry.fiber !== undefined) === disabledFlag) throw new Error(`${name}: loader entry ${disabledFlag ? 'did not stop' : 'did not become live'}`)
        logEvent('info', 'toggle',
          `${name} -> ${disabledFlag ? 'off' : 'on'}: fiber=${String(entry.fiber !== undefined)}`)
      }
      if (!found) logEvent('info', 'toggle', `${name}: no loader entry matched`)
      return found
    } catch (error) {
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

  const changing = new Set<string>()
  const isLive = (name: string) => listHotMounts().includes(name) || matchingEntries(name).some(entry => entry.fiber !== undefined)

  /** Restore only the loader entries/hot mounts touched by this request. */
  async function changeEnabled(
    choices: readonly { name: string; enabled: boolean }[],
    commit: (next: Set<string>) => void,
  ): Promise<HotMountResult> {
    const names = new Set(choices.map(choice => choice.name))
    const hotBefore = new Set(listHotMounts().filter(name => names.has(name)))
    const entries = [...new Set([...names].flatMap(matchingEntries))]
      .map(entry => ({ entry, disabled: entry.options.disabled, live: entry.fiber !== undefined }))
    const restore = async () => {
      const errors: string[] = []
      for (const name of names) {
        try {
          if (!hotBefore.has(name) && listHotMounts().includes(name)) await hotUnmount(name, true)
          if (hotBefore.has(name) && !listHotMounts().includes(name)) {
            const restored = await hotMount(host, activeProfileDir, name)
            if (!restored.ok) throw new Error(restored.reason ?? 'could not restore hot mount')
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
          if (disposalError) throw new Error(`${disposalError}; runtime state is uncertain; retry disabling before enabling`)
          if (!listHotMounts().includes(name) && !await setEntryDisabled(name, false, true)) {
            result = await hotMount(host, activeProfileDir, name)
            if (result.outcome === 'failed') throw new Error(result.reason)
          }
          next.delete(name)
        } else {
          // Theme replacement requires the old entry to stop. Ordinary disables
          // preserve the existing deferred fallback, but never swallow a hung update.
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

  /** Installation callers retain a boolean API; failed switches keep the old theme. */
  async function activateTheme(name: string): Promise<boolean> {
    const choices = [...await installedThemeNames()]
      .filter(other => other !== name && (!disabledThemes.has(other) || isLive(other)))
      .map(other => ({ name: other, enabled: false }))
    choices.push({ name, enabled: true })
    return (await changeEnabled(choices, next => writeDisabled(activeProfileDir, next))).ok
  }

  return { installedThemeNames, setEntryDisabled, activateTheme, changeEnabled, isChanging: name => changing.has(name), isLive }
}
