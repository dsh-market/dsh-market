/**
 * Modes: user-defined sets of installed plugins that switch as a unit.
 *
 * A GROUP IS A LABEL; A MODE IS A SWITCH. Groups (groups.ts) answer "what
 * kind of thing is this" — one plugin, one group, purely organisational, and
 * the batch switch on a group row turns that set on or off independently of
 * every other group.
 *
 * A mode answers "what am I doing right now". It is EXCLUSIVE: switching to
 * one turns on its members and turns off every other mode's members, which is
 * what makes changing hats a single action instead of "turn last one off,
 * turn this one on". A plugin may belong to several modes — that is how a
 * plugin that is useful in two contexts (a theme, a translation helper) stays
 * on across both.
 *
 * The activation rule is deliberately STATELESS and NARROW:
 *
 *   owned   = every plugin that appears in ANY mode
 *   target  = the members of the mode being switched to
 *   on      = target                     (that are currently off)
 *   off     = owned \ target             (that are currently on)
 *
 * - Stateless: it never asks "which mode was I in". The first switch of a
 *   fresh profile is already correct, and nothing is stored to drift.
 * - Narrow: a plugin in NO mode is never touched. Forgetting to file a plugin
 *   under a mode costs nothing; it cannot be switched off by surprise.
 * - Reversible: switching back is a complete undo for every mode-managed
 *   plugin, because nothing outside the modes was ever moved. That is also
 *   why a switch needs no snapshot — unlike a preset, it cannot reorder the
 *   composition and therefore cannot stop the host from booting.
 *
 * Pure CRUD over the caller-owned state objects; routes.ts persists after each
 * mutation and drives the live toggles for `activate`.
 */

/**
 * The slices of market state mode CRUD touches (routes.ts owns the rest).
 *
 * `modes` and `groups` have the same shape and different meanings — which is
 * why they are separate fields rather than one reused for both. Users keep
 * their existing groups untouched, and neither concept has to be explained in
 * terms of the other.
 */
export interface ModeState {
  modes: Record<string, string[]>
  modeOrder: string[]
  /**
   * The mode the user last switched to, for the selector and for "no mode".
   *
   * UI state, never a computation input: every rule above is derived from
   * membership alone, so a stale value cannot make a switch behave oddly. It
   * only says which radio is filled in.
   */
  activeMode: string | null
}

export interface ModeMutationResult {
  ok: boolean
  error?: string
}

/** Maximum modes per profile (quota). */
export const MAX_MODES = 50

/**
 * Mode names: letters/digits (incl. CJK), spaces, underscores, hyphens.
 * Mirrors GROUP_NAME_RE in groups.ts — the two are separate on purpose, so a
 * later change to one concept's rule cannot silently reshape the other.
 */
const MODE_NAME_RE = /^[\p{L}\p{N}_ -]{1,40}$/u

/** The market's own package names never participate in a mode (#60 rule). */
const MARKET_SELF_NAMES = new Set(['dsh-market', 'dshmarket'])

function isModeName(value: unknown): value is string {
  return typeof value === 'string' && MODE_NAME_RE.test(value)
}

export function createMode(state: ModeState, name: unknown): ModeMutationResult {
  if (!isModeName(name)) return { ok: false, error: 'invalid mode name / 模式名称无效' }
  if (state.modes[name] !== undefined) return { ok: false, error: 'mode already exists / 模式已存在' }
  if (state.modeOrder.length >= MAX_MODES) {
    return { ok: false, error: `mode quota reached (${MAX_MODES}) — delete one first / 模式数量已达上限（${MAX_MODES}），请先删除一个` }
  }
  state.modes[name] = []
  state.modeOrder.push(name)
  return { ok: true }
}

export function renameMode(state: ModeState, name: unknown, newName: unknown): ModeMutationResult {
  if (typeof name !== 'string' || state.modes[name] === undefined) {
    return { ok: false, error: 'mode not found / 模式不存在' }
  }
  if (!isModeName(newName)) return { ok: false, error: 'invalid mode name / 模式名称无效' }
  if (newName !== name && state.modes[newName] !== undefined) {
    return { ok: false, error: 'mode already exists / 模式已存在' }
  }
  const members = state.modes[name]
  delete state.modes[name]
  state.modes[newName] = members
  const index = state.modeOrder.indexOf(name)
  if (index !== -1) state.modeOrder[index] = newName
  if (state.activeMode === name) state.activeMode = newName
  return { ok: true }
}

export function deleteMode(state: ModeState, name: unknown): ModeMutationResult {
  if (typeof name !== 'string' || state.modes[name] === undefined) {
    return { ok: false, error: 'mode not found / 模式不存在' }
  }
  delete state.modes[name]
  // Mutate in place: routes.ts hands over the LIVE modeOrder array, and the
  // response serializes that same array — replacing it here would orphan it.
  const index = state.modeOrder.indexOf(name)
  if (index !== -1) state.modeOrder.splice(index, 1)
  // Deleting the mode you are "in" leaves nobody to switch away from, so the
  // selector falls back to "no mode" rather than keeping a dead name.
  if (state.activeMode === name) state.activeMode = null
  return { ok: true }
}

/**
 * Replace a mode's membership. Only currently installed plugins can be
 * members — ghost names (uninstalled meanwhile) are dropped and duplicates
 * collapse, so the persisted list stays clean. Themes are exclusive: a mode
 * may hold at most one theme plugin, mirroring the global one-active-theme
 * rule (only one theme can be enabled at a time).
 *
 * Plugins on the host infrastructure chain are dropped at the SOURCE rather
 * than at switch time: they can never be switched off (see isProtectedModule
 * in patch.ts), so accepting them as members would build a mode that silently
 * does something other than what its member list says.
 */
export function setModeMembers(
  state: ModeState,
  name: unknown,
  members: unknown,
  installed: ReadonlySet<string>,
  themes: ReadonlySet<string>,
  protectedNames: ReadonlySet<string>,
): ModeMutationResult {
  if (typeof name !== 'string' || state.modes[name] === undefined) {
    return { ok: false, error: 'mode not found / 模式不存在' }
  }
  if (!Array.isArray(members)) return { ok: false, error: 'members must be an array / 成员必须是数组' }
  const kept: string[] = []
  const seen = new Set<string>()
  for (const member of members) {
    if (typeof member !== 'string' || member === '' || seen.has(member)) continue
    if (MARKET_SELF_NAMES.has(member)) continue
    if (protectedNames.has(member)) continue
    seen.add(member)
    if (installed.has(member)) kept.push(member)
  }
  let themeCount = 0
  for (const member of kept) if (themes.has(member)) themeCount += 1
  if (themeCount > 1) {
    return { ok: false, error: 'a mode can contain at most one theme / 每个模式最多一个主题' }
  }
  state.modes[name] = kept
  return { ok: true }
}

/**
 * Drop `name` from every mode (called after a successful uninstall).
 *
 * Takes the member map alone, not a full ModeState: an uninstall removes a
 * plugin, which can never change the mode list or which mode is active, and
 * a caller with only the map in hand should not have to invent the rest.
 */
export function removeFromModes(modes: Record<string, string[]>, name: string): void {
  for (const mode of Object.keys(modes)) {
    const members = modes[mode]
    if (members.includes(name)) modes[mode] = members.filter(member => member !== name)
  }
}

/**
 * Follow a package rename (source migration) through every mode, the same way
 * the route already follows it through the disable list, the groups and the
 * notes. Without this a migration silently empties every mode that mentioned
 * the old name.
 */
export function renameInModes(modes: Record<string, string[]>, from: string, to: string): void {
  if (from === to) return
  for (const mode of Object.keys(modes)) {
    if (!modes[mode].includes(from)) continue
    const next: string[] = []
    for (const member of modes[mode]) {
      const mapped = member === from ? to : member
      if (!next.includes(mapped)) next.push(mapped)
    }
    modes[mode] = next
  }
}

/** Everything a switch would do — computed BEFORE anything is written. */
export interface ModeActivationPlan {
  ok: boolean
  error?: string
  /** Members of the target mode that are currently off and will be turned on. */
  turnedOn: string[]
  /** Mode-managed plugins outside the target mode that will be turned off. */
  turnedOff: string[]
  /** Members skipped because they sit on the host infrastructure chain. */
  skippedProtected: string[]
}

function emptyPlan(error?: string): ModeActivationPlan {
  return { ok: error === undefined, error, turnedOn: [], turnedOff: [], skippedProtected: [] }
}

/** Installed, non-market members of one mode. */
function installedMembers(members: string[] | undefined, installed: ReadonlySet<string>): string[] {
  if (members === undefined) return []
  const out: string[] = []
  for (const member of members) {
    if (MARKET_SELF_NAMES.has(member)) continue
    if (!installed.has(member)) continue
    out.push(member)
  }
  return out
}

/** Every installed plugin that appears in at least one mode. */
function modeOwnedNames(state: ModeState, installed: ReadonlySet<string>): Set<string> {
  const owned = new Set<string>()
  for (const members of Object.values(state.modes)) {
    for (const member of installedMembers(members, installed)) owned.add(member)
  }
  return owned
}

/**
 * Plan `activate`: turn the mode on, and turn every other mode's members off.
 * Plugins outside every mode are not in `owned` and therefore never appear in
 * either list, which is the "forgetting to file a plugin costs nothing" rule.
 *
 * A protected member is skipped rather than fatal: refusing the whole switch
 * because one row cannot move would leave the user with a mode that does
 * nothing and no way to find out why.
 */
export function planModeActivation(
  state: ModeState,
  name: unknown,
  installed: ReadonlySet<string>,
  disabled: ReadonlySet<string>,
  protectedNames: ReadonlySet<string>,
): ModeActivationPlan {
  if (typeof name !== 'string' || state.modes[name] === undefined) {
    return emptyPlan('mode not found / 模式不存在')
  }
  const target = new Set(installedMembers(state.modes[name], installed))
  const owned = modeOwnedNames(state, installed)

  const candidatesOn: string[] = []
  for (const member of target) if (disabled.has(member)) candidatesOn.push(member)
  const candidatesOff: string[] = []
  for (const member of owned) if (!target.has(member) && !disabled.has(member)) candidatesOff.push(member)

  const skippedProtected = [...candidatesOn, ...candidatesOff].filter(member => protectedNames.has(member))
  return {
    ok: true,
    turnedOn: candidatesOn.filter(member => !protectedNames.has(member)),
    turnedOff: candidatesOff.filter(member => !protectedNames.has(member)),
    skippedProtected,
  }
}

/**
 * Plan "no mode": turn off the active mode's members and nothing else. A
 * plugin that belongs ONLY to another mode is not touched — the user asked to
 * leave the mode they were in, not to flatten every mode they own.
 */
export function planModeClear(
  state: ModeState,
  installed: ReadonlySet<string>,
  disabled: ReadonlySet<string>,
  protectedNames: ReadonlySet<string>,
): ModeActivationPlan {
  if (state.activeMode === null || state.modes[state.activeMode] === undefined) {
    return { ok: true, turnedOn: [], turnedOff: [], skippedProtected: [] }
  }
  const members = installedMembers(state.modes[state.activeMode], installed)
  const candidatesOff = members.filter(member => !disabled.has(member))
  return {
    ok: true,
    turnedOn: [],
    turnedOff: candidatesOff.filter(member => !protectedNames.has(member)),
    skippedProtected: candidatesOff.filter(member => protectedNames.has(member)),
  }
}
