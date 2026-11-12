/**
 * Patch-layer plugin toggles — hot disable/enable through the profile's
 * user patch layer (cordis.patch.yml), the mechanism ported from
 * Noob-stupid/dsh-plugin-hub's plugin console.
 *
 * DSH composes a web profile from the bundle layers + the user patch layer
 * (`$DSH_HOME/profiles/<name>/cordis.patch.yml`), with per-key override
 * semantics: a patch row `- id: X` + `disabled: true` stops that loader
 * entry, and `disabled: false` force-enables one a lower layer disabled.
 * The profile's config-file watcher (HMR) re-composes within ~1s of the
 * save — no restart — and the loader re-applies the same file on every
 * boot, so the choice survives restarts through the official mechanism.
 *
 * The market ALSO keeps its own in-memory/state.json bookkeeping (hot-mount
 * shims have no bundle row to patch, and the client's disable list drives
 * the switches); this module is the durable, HMR-driven layer on top.
 *
 * Safety (borrowed from the plugin-hub implementation):
 * - writes are serialized so concurrent toggles cannot interleave a
 *   read-modify-write;
 * - an append is REFUSED when the patch file is not a valid entry list —
 *   a malformed file (e.g. a stray `[]` followed by items) is never made
 *   worse, the market reports it instead;
 * - host infrastructure rows (transport / hot-reload / storage / settings
 *   chains) are protected and refuse to toggle.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logEvent } from './log.ts'
import { parsePatchFile, parsePatchText } from './check.ts'
import { bundleOptOutRowIds, bundlePatchInsertedIds, declaredBundlePatchFiles, parsePatchRows } from './profile.ts'

/** The slice of the loader tree this module needs. */
export interface PatchHost {
  loader: {
    entries(): Iterable<{
      options?: { id?: string; name?: string; config?: { path?: string } }
    }>
  }
}

/**
 * Host infrastructure rows: disabling any of these breaks the very chain
 * the patch layer runs on (e.g. timer → HMR, webserver → the page itself),
 * so they refuse to toggle. Same list the plugin-hub console uses — the
 * target host is the same DSH.
 */
const PROTECTED_MODULE_PATTERNS = [
  /^cordis:/u,
  /^@deepseek-ai\/cordis-plugin-/u,
  /^@deepseek-ai\/dsh-host-/u,
  /^@deepseek-ai\/dsh-client-modules$/u,
  /^@deepseek-ai\/dsh-client-connection$/u,
  /^@deepseek-ai\/dsh-client-hmr$/u,
  /^@deepseek-ai\/dsh-client-runtime$/u,
  /^@deepseek-ai\/dsh-client-locale$/u,
  /^@deepseek-ai\/dsh-client-web/u,
  /^@deepseek-ai\/dsh-web-frontend$/u,
  /^@deepseek-ai\/dsh-web-app$/u,
  /^@deepseek-ai\/dsh-settings/u,
  /^@deepseek-ai\/dsh-credentials/u,
  /^@deepseek-ai\/dsh-session/u,
  /^@deepseek-ai\/dsh-storage/u,
  /^@deepseek-ai\/dsh-typert/u,
  /^@deepseek-ai\/dsh-api-remotes$/u,
  /^@deepseek-ai\/dsh-tools$/u,
  /^@deepseek-ai\/dsh-system-prompt$/u,
  /^@deepseek-ai\/dsh-agent/u,
  /^@deepseek-ai\/dsh-llm/u,
  /^@deepseek-ai\/dsh-persona$/u,
  /^@deepseek-ai\/dsh-scope$/u,
  /^@deepseek-ai\/dsh-launch-environment$/u,
  /^@deepseek-ai\/dsh-shell$/u,
  /^@deepseek-ai\/dsh-subprocess/u,
  /^@deepseek-ai\/dsh-fs/u,
  /^@deepseek-ai\/dsh-sandbox/u,
  /^@deepseek-ai\/dsh-jobs/u,
  /^@deepseek-ai\/dsh-skill/u,
  /^@deepseek-ai\/dsh-goal/u,
  /^@deepseek-ai\/dsh-workflow/u,
  /^@deepseek-ai\/dsh-subagent/u,
  /^@deepseek-ai\/dsh-web$/u,
  /^@deepseek-ai\/dsh-workspace/u,
  /^@deepseek-ai\/dsh-user-approval$/u,
  /^@deepseek-ai\/dsh-user-questions$/u,
  /^@deepseek-ai\/dsh-commands$/u,
  /^@deepseek-ai\/dsh-hook/u,
  /^@deepseek-ai\/dsh-spill/u,
  /^@deepseek-ai\/dsh-guard/u,
  /^@deepseek-ai\/dsh-tool-call-timeout-policy$/u,
  /^@deepseek-ai\/dsh-repeat-tool-reminder$/u,
]

/** True when the module name sits on the host infrastructure chain. */
export function isProtectedModule(moduleName: string | undefined): boolean {
  return typeof moduleName === 'string' && PROTECTED_MODULE_PATTERNS.some(pattern => pattern.test(moduleName))
}

/**
 * Resolve the profile's user patch layer. Prefers the path the loader's
 * cordis:include entry actually read (authoritative under hosts that own
 * the profile directory, like DSH Desktop); falls back to the conventional
 * `<profile>/cordis.patch.yml`.
 */
export function findUserPatchPath(host: PatchHost, profileDir: string): string {
  for (const entry of host.loader.entries()) {
    const cfg = entry.options?.config
    if (entry.options?.name !== 'cordis:include' || cfg == null || typeof cfg.path !== 'string') continue
    if (!cfg.path.includes('cordis.yml')) continue
    let includePath = cfg.path
    if (includePath.startsWith('file://')) {
      try {
        includePath = fileURLToPath(includePath)
      } catch {
        // fileURLToPath rejects POSIX-style URLs on Windows; the scheme is
        // all we need to strip for the path to be usable.
        includePath = includePath.replace(/^file:\/\//u, '')
      }
    }
    return includePath.replace(/cordis\.yml$/u, 'cordis.patch.yml')
  }
  return join(profileDir, 'cordis.patch.yml')
}

/** What the user patch layer currently says about rows. */
export interface PatchState {
  /** Row ids the user patch disables (`disabled: true`). */
  disables: string[]
  /** Row ids the user patch force-enables (`disabled: false`). */
  forced: string[]
  /** Row ids the user patch inserts. */
  inserts: string[]
  /** The `name` a flag row carries, when it carries one. A row whose name
   * does not match the composed entry is skipped by the host, so its flag is
   * not a decision about anything (#1113). */
  names?: Record<string, string>
}

/** Row ids the market is allowed to write: plain unquoted YAML scalars. */
const ROW_ID_RE = /^[A-Za-z0-9_.-]+$/u

function nextPatchContentLine(lines: readonly string[], from: number): number {
  let index = from
  while (index < lines.length) {
    const line = (lines[index] ?? '').trim()
    if (line !== '' && !line.startsWith('#')) break
    index += 1
  }
  return index
}

/**
 * Line-wise scan of one patch file — the plugin-hub shapes. Deliberately
 * not a YAML parse: the file may hold structures the market's dialect
 * rejects, but a plain `- id: X` + `disabled: true|false` pair is enough
 * to know what the user patch layer says.
 */
/**
 * The value of a top-level key in a patch entry that starts after `start`.
 *
 * An entry runs until the next `- ` at column 0, and its keys sit at exactly
 * two spaces; anything deeper belongs to `config:` and says nothing about the
 * row itself. Reading only the line AFTER `- id:` missed `disabled: true`
 * whenever `name`, `inject` or a config block came first — the row then read
 * as enabled, so a plugin the user had switched off was reported "restart to
 * apply" forever, every boot (#1099).
 *
 * @returns the scalar as written (comments stripped), or null when the entry
 *   does not carry the key at all.
 */
function entryKeyValue(lines: readonly string[], start: number, key: string): string | null {
  const pattern = new RegExp(`^ {2}${key}:[ \\t]*(.*?)[ \\t]*$`, 'u')
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (/^- /u.test(line)) return null
    const match = pattern.exec(line)
    // A `#` starts a comment only after whitespace; `#` inside a bare scalar
    // is data, and YAML would keep it.
    if (match !== null) return (match[1] ?? '').replace(/[ \t]+#.*$/u, '').trim()
  }
  return null
}

/**
 * Whether a patch entry speaks for the row it names.
 *
 * The host skips an entry whose `name` is not the name that row's id composes
 * to — `applyPatches` in dsh-app-boot, `if (name && name !== target.name)`,
 * the same line in every published version. A row left behind by a package
 * rename therefore never takes effect, while anything that counts the flag
 * alone reports the plugin as off (#1113). Only a row that CARRIES a name is
 * compared, and only when the composed name is known: an id that is not in
 * the loader has nothing to compare against, and its flag stands.
 *
 * @param name - the `name` the entry carries, if any.
 * @param expected - the composed entry's own name, or null when unknown.
 */
function rowApplies(name: unknown, expected: string | null): boolean {
  if (typeof name !== 'string' || name === '') return true
  return expected === null || name === expected
}

/**
 * The name the loader composed for a row, or null when the id is not there.
 *
 * This is the comparison the host makes, against the composed entry's own
 * `name` — NOT `nameMatchesPackage()`, which judges package ownership and
 * treats a subpath name and a foreign package name the same way (#1113).
 */
export function composedRowName(host: PatchHost, rowId: string): string | null {
  for (const entry of host.loader.entries()) {
    if (loaderEntryId(entry) !== rowId) continue
    const name = entry.options?.name
    return typeof name === 'string' && name !== '' ? name : null
  }
  return null
}

/**
 * Whether the user layer's flag for this row is a decision the host applies.
 *
 * @param state - the user patch state.
 * @param rowId - the row being asked about.
 * @param expected - the composed entry's name, or null when the id is not in
 *   the loader.
 */
export function rowFlagApplies(state: PatchState, rowId: string, expected: string | null): boolean {
  const carried = state.names?.[rowId]
  return carried === undefined || rowApplies(carried, expected)
}

/** The state with one row's flags dropped when its `name` does not apply. */
function withoutMismatchedRow(state: PatchState, rowId: string, expected: string | null): PatchState {
  if (rowFlagApplies(state, rowId, expected)) return state
  return {
    disables: state.disables.filter(id => id !== rowId),
    forced: state.forced.filter(id => id !== rowId),
    inserts: state.inserts,
    ...(state.names !== undefined ? { names: state.names } : {}),
  }
}

export function readUserPatchState(patchPath: string): PatchState {
  // The host composes the file in order, later entries override earlier ones,
  // so a row has one final flag: listing it as both disabled and forced showed
  // a plugin as off while the file had it on (#1099).
  const flags = new Map<string, 'true' | 'false'>()
  const names = new Map<string, string>()
  const inserts: string[] = []
  let text = ''
  try {
    text = readPatchText(patchPath)
  } catch { /* no patch file — empty state */ }
  const lines = text.split(/\r?\n/u)
  let inInsert = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (/^- insert:\s*$/u.test(line)) {
      inInsert = true
      continue
    }
    if (/^- /u.test(line)) inInsert = false
    if (inInsert) {
      const insertRow = /^ {4}- id: ([A-Za-z0-9_.-]+)/u.exec(line)
      if (insertRow !== null) inserts.push(insertRow[1])
      continue
    }
    const disableRow = /^- id: (?:([A-Za-z0-9_.-]+)|'([A-Za-z0-9_.-]+)'|"([A-Za-z0-9_.-]+)")[ \t]*$/u.exec(line)
    if (disableRow === null) continue
    const id = (disableRow[1] ?? disableRow[2] ?? disableRow[3])!
    const value = entryKeyValue(lines, index + 1, 'disabled')
    if (value !== 'true' && value !== 'false') continue
    flags.set(id, value)
    // A row that names a module is only applied by the host when that name is
    // the one the row's id composes to; the flag stays here so the caller can
    // make that comparison (#1113).
    const named = entryKeyValue(lines, index + 1, 'name')
    const unwrapped = named === null ? null : named.replace(/^(['"])(.*)\1$/u, '$2')
    if (unwrapped !== null && unwrapped !== '') names.set(id, unwrapped)
    else names.delete(id)
  }
  const withFlag = (flag: 'true' | 'false'): string[] => [...flags.keys()].filter(id => flags.get(id) === flag)
  return {
    disables: withFlag('true'),
    forced: withFlag('false'),
    inserts,
    ...(names.size > 0 ? { names: Object.fromEntries(names) } : {}),
  }
}

/**
 * User-authored insert rows that still load `packageName` (or one of its
 * exported subpaths). This evidence deliberately stays separate from the
 * package's own bundle declaration: uninstall may clean market-owned rows,
 * but it must never rewrite an insert the user owns.
 *
 * A missing patch is the ordinary empty-profile shape. `null` means the
 * existing file could not be read as DSH's patch dialect; callers must treat
 * that as indeterminate and refuse the destructive step.
 */
export function userPatchPackageReferences(patchPath: string, packageName: string): string[] | null {
  let source: string
  try {
    source = readFileSync(patchPath, 'utf8')
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
    if (code === 'ENOENT') return []
    return null
  }

  // Use the same schema as profile composition, including !!js scalars. A
  // line scanner cannot distinguish flow-style entries or nested loader
  // groups from arbitrary config keys in a hand-written user patch.
  const rows = parsePatchText(source)
  if (rows === null) return null
  const insertedNames = new Set<string>()
  const visiting = new Set<unknown[]>()
  const visited = new Set<unknown[]>()
  const collect = (entries: unknown[]): boolean => {
    if (visited.has(entries)) return true
    if (visiting.has(entries)) return false
    visiting.add(entries)
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        visiting.delete(entries)
        return false
      }
      const row = entry as Record<string, unknown>
      if ('name' in row && typeof row.name !== 'string') {
        visiting.delete(entries)
        return false
      }
      if (typeof row.name === 'string') insertedNames.add(row.name)
      // Only group rows treat an array-valued config as child loader rows.
      // Other plugins may use arrays of `{ name: ... }` as ordinary options,
      // and those must not become false package references.
      if (row.group === true && Array.isArray(row.config)) {
        if (!collect(row.config)) {
          visiting.delete(entries)
          return false
        }
      }
    }
    visiting.delete(entries)
    visited.add(entries)
    return true
  }
  for (const patch of rows) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return null
    const patchRow = patch as Record<string, unknown>
    if (!('insert' in patchRow)) continue
    if (!Array.isArray(patchRow.insert) || !collect(patchRow.insert)) return null
  }
  return [...insertedNames].filter(
    reference => reference === packageName || reference.startsWith(`${packageName}/`),
  )
}

/**
 * A loader entry's id as a string, or '' when it has none.
 *
 * `EntryOptions.id` is a TypeScript interface, not a runtime check: an
 * unquoted `- id: 1` in `cordis.patch.yml` is parsed by YAML as the NUMBER 1,
 * the host's loader accepts it, and every `.split(':')` on it then throws —
 * `/dsh-market/installed` answered 400 with an empty body and the UI showed
 * "no community plugins installed" (#1071). The market's own regex parser
 * only ever produces strings, so this is reachable only through the loader.
 *
 * Numbers are stringified rather than dropped: `id: 1` names the same entry
 * the user wrote, and the market's own row comparisons are string-keyed.
 *
 * @param entry - a host loader entry.
 * @returns the id as a string, '' when absent or not a string/number.
 */
export function loaderEntryId(entry: { options?: { id?: unknown } } | null | undefined): string {
  const id = entry?.options?.id
  if (typeof id === 'string') return id
  if (typeof id === 'number' && Number.isFinite(id)) return String(id)
  return ''
}

/** The include entry's id prefix (loader entry ids look like `include:X`). */
function includePrefix(host: PatchHost): string {
  for (const entry of host.loader.entries()) {
    if (entry.options?.name === 'cordis:include' && typeof entry.options.id === 'string') {
      return `${entry.options.id}:`
    }
  }
  return ''
}

/**
 * The user-patch row ids one installed package owns: its bundle patch's
 * insert rows, plus the loader entries currently carrying its name.
 * Empty for client-only packages (no bundle rows) — the market's own
 * state.json mechanism covers those, and there is nothing to patch.
 * Market-owned namespaces (hot-mount `mkt-*`, shim `client-*`) are
 * excluded: their rows live in the market's own include subtree, and a
 * permanent patch row targeting them would be a boot-time orphan.
 */
export function rowIdsForPackage(host: PatchHost, profileDirectory: string, packageName: string): string[] {
  const ids = new Set<string>()
  const packageDir = join(profileDirectory, 'node_modules', packageName)
  // ONLY the rows this package inserts (#147). A bundle patch also carries
  // rows that merely reconfigure OTHER plugins — dsh-vision-router tunes the
  // official `attachment-local` row — and writing `disabled: true` onto
  // those took down attachments and the DeepSeek model along with it.
  try {
    for (const id of bundlePatchInsertedIds(packageDir)) ids.add(id)
  } catch { /* package not installed — loader side may still know it */ }
  // The conventional location too: a package may ship cordis.patch.yml at
  // its root without declaring dsh.bundle.patch (the loader probes it too).
  // Same parser, deliberately: this used to be a second hand-rolled scan
  // that closed the insert block only on `id:` lines, so `- disable:` with
  // nested ids under it claimed the neighbour's rows — #147 all over again
  // on the path #147 did not touch.
  try {
    for (const id of parsePatchRows(readFileSync(join(packageDir, 'cordis.patch.yml'), 'utf8')).insertedIds) {
      ids.add(id)
    }
  } catch { /* no conventional patch — nothing more to add */ }
  const prefix = includePrefix(host)
  for (const entry of host.loader.entries()) {
    if (entry.options?.name !== packageName) continue
    let id = loaderEntryId(entry)
    if (id === '') continue
    if (prefix !== '' && id.startsWith(prefix)) id = id.slice(prefix.length)
    if (/^(?:mkt-|client-)/u.test(id)) continue
    ids.add(id)
  }
  return [...ids]
}

/**
 * Top-level patch rows that DISABLE another plugin: a row carrying both an
 * `id` and `disabled: true`. Rows nested under an `insert:` block are separate
 * array elements shaped `{ insert: [...] }`, so anything here is by definition
 * a sibling row targeting a plugin this package does not own.
 */
function foreignDisableIds(rows: unknown[]): string[] {
  const ids: string[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const record = row as Record<string, unknown>
    const id = record.id
    if (typeof id === 'string' && record.disabled === true && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Top-level patch rows that add an `inject:` requirement to another plugin.
 *
 * Same shape rule as foreignDisableIds: anything at the top level with an id
 * is a statement about a plugin this package does not own. An `inject` there
 * makes that foreign row depend on a service — usually one this bundle
 * provides — so switching this package off while leaving its patch in the
 * stack strands the row: #938's billion-context adds
 * `inject: [biliBasicCompactionPolicy]` to the four official agent presets,
 * and a row-level disable left them unable to activate.
 */
function foreignInjectIds(rows: unknown[]): string[] {
  const ids: string[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const record = row as Record<string, unknown>
    const id = record.id
    if (typeof id === 'string' && record.inject !== undefined && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * The ids of OTHER plugins a package's bundle patch rewires — top-level rows
 * that either `disabled: true` a plugin it does not own, or add an `inject:`
 * requirement to one.
 *
 * Both are the marker of a bundle whose toggle-off can brick the boot while
 * its patch keeps applying (#224, #938):
 *  - dsh-postgres-backends disables session-persistence-jsonl, so once the
 *    market also disables the postgres backends nothing provides
 *    sessionPersistence;
 *  - billion-context adds `inject: [biliBasicCompactionPolicy]` to the four
 *    official agent presets, so disabling only its own row leaves the presets
 *    waiting for a service that no longer exists — every preset disappears.
 *
 * A bundle that merely RECONFIGURES a neighbour is deliberately NOT counted:
 * the e2e fixture-cross tweaks dshm-fixture-b's config, and #147 requires
 * disabling it to leave that neighbour live — dropping such a bundle from the
 * stack broke its re-enable. Config-only side effects stay on the normal #147
 * path. Removing the bundle still neutralizes any config side effects it
 * carries, since its whole patch stops applying.
 *
 * Reads both patch sources like rowIdsForPackage — the declared
 * dsh.bundle.patch (one file or a LIST of them, #792) and the conventional
 * root cordis.patch.yml — so either form is detected, and every declared file
 * is attributed.
 */
export function carrierRowIds(profileDirectory: string, packageName: string): string[] {
  const packageDir = join(profileDirectory, 'node_modules', packageName)
  const rows = new Set<string>()
  const collectFromFile = (patchPath: string): void => {
    const parsed = parsePatchFile(patchPath)
    if (parsed === null) return
    for (const id of foreignDisableIds(parsed)) rows.add(id)
    for (const id of foreignInjectIds(parsed)) rows.add(id)
  }
  for (const file of declaredBundlePatchFiles(packageDir)) collectFromFile(file)
  collectFromFile(join(packageDir, 'cordis.patch.yml'))
  return [...rows]
}

/**
 * The ids a package's bundle patch touches WITHOUT inserting them itself.
 *
 * `insert:` rows are the package's own — that split is what `rowIdsForPackage`
 * relies on (#147: a bundle patch also carries rows that merely reconfigure
 * other plugins, and writing `disabled: true` onto those took down the
 * neighbour). Every other row is a statement about a DIFFERENT plugin.
 *
 * It answers one question for the toggle route (#696 B): may this bundle leave
 * `dsh.profile.bundles` when the user turns it off? Leaving takes its whole
 * patch with it, which is exactly right when the patch speaks only for itself
 * and wrong when it configures a neighbour — the shape #147 and the
 * fixture-cross e2e exist to protect, where the neighbour must keep running
 * and the bundle must keep re-enabling.
 *
 * Reads both patch sources like carrierRowIds: the declared
 * `dsh.bundle.patch` (one file or a LIST, #792) and the conventional root
 * cordis.patch.yml. Ownership is judged per file, because a package may ship
 * both and only the file's own `insert:` block says which ids it brings in.
 */
export function foreignRowIds(profileDirectory: string, packageName: string): string[] {
  const packageDir = join(profileDirectory, 'node_modules', packageName)
  const foreign = new Set<string>()
  const collect = (text: string): void => {
    const rows = parsePatchText(text)
    if (rows === null) return
    const own = new Set(parsePatchRows(text).insertedIds)
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
      const id = (row as { id?: unknown }).id
      if (typeof id === 'string' && id !== '' && !own.has(id)) foreign.add(id)
    }
  }
  const readPatch = (patchPath: string): void => {
    try {
      collect(readFileSync(patchPath, 'utf8'))
    } catch { /* no such patch — nothing attributed to it */ }
  }
  for (const file of declaredBundlePatchFiles(packageDir)) readPatch(file)
  readPatch(join(packageDir, 'cordis.patch.yml'))
  return [...foreign]
}

/**
 * Per-package patch-layer flags for the installed list: names whose rows the
 * user patch layer disables / force-enables. These cover toggles made
 * OUTSIDE the market (hand-edited cordis.patch.yml, dsh-web-plugin-manager,
 * the dsh CLI), which the market's own state.json never sees.
 */
export function packagePatchFlags(
  host: PatchHost,
  profileDirectory: string,
  names: readonly string[],
  state: PatchState,
): { disabled: string[]; forced: string[] } {
  const disabled: string[] = []
  const forced: string[] = []
  for (const name of names) {
    const rows = rowIdsForPackage(host, profileDirectory, name)
    // Rows the package's own layer already ships off say nothing about what
    // the user decided (#876): `dsh-mnemon` ships four strategy rows as
    // opt-in, its user patch layer repeats one of them, and the package was
    // reported as 「已停用 / 重启后保持关闭」 while it was running. Only the
    // user's decisions ABOVE the bundle's own default count.
    const optOut = new Set(bundleOptOutRowIds(join(profileDirectory, 'node_modules', name)))
    const decidedByUser = (id: string): boolean => !optOut.has(id)
    // A row that names a module other than this id's does nothing in the
    // host, so it is not a decision about this package (#1113): the shape a
    // package rename leaves behind.
    const applies = (id: string): boolean => rowFlagApplies(state, id, composedRowName(host, id))
    // A package counts as off only when nothing of it is left running: a
    // multi-component plugin with some components switched off is still on
    // (#1150). One disabled row used to flip the whole package, which kept
    // it out of 「全部更新」.
    // Rows that name another module do not count either way (#1113).
    const decidedRows = rows.filter(id => decidedByUser(id) && applies(id))
    if (decidedRows.length > 0 && decidedRows.every(id => state.disables.includes(id))) disabled.push(name)
    if (rows.some(id => decidedByUser(id) && applies(id) && state.forced.includes(id))) forced.push(name)
  }
  return { disabled, forced }
}

/** Serialize patch-file writes: concurrent toggles must not interleave. */
let writeQueue: Promise<unknown> = Promise.resolve()
function queuedWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn)
  writeQueue = run.then(() => undefined, () => undefined)
  return run
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function rowBlock(rowId: string, disabled: boolean): string {
  return `- id: ${rowId}\n  disabled: ${disabled ? 'true' : 'false'}\n`
}

/**
 * Rewrite standalone id/flag rows while preserving the surrounding file.
 * Comments and blank lines may separate the fields (#930). Look beyond them
 * after the flag too: an indented config/name/key makes this a longer entry,
 * whose first lines must never be removed (#821). Trailing comments stay put.
 */
function rewriteRowBlocks(
  text: string,
  rowId: string,
  disabled: 'true' | 'false' | 'any',
  replace: (block: string) => string,
  expected: string | null = null,
): string {
  const id = escapeRegExp(rowId)
  const idLine = new RegExp(`^- id: (?:${id}|'${id}'|"${id}")[ \t]*$`, 'u')
  const lines = text.match(/[^\n]*(?:\n|$)/gu)?.filter(Boolean) ?? []
  const offsets: number[] = [0]
  for (const line of lines) offsets.push(offsets[offsets.length - 1]! + line.length)
  let result = '', copied = 0
  for (let index = 0; index < lines.length; index += 1) {
    if (!idLine.test(lines[index]!.replace(/\r?\n$/u, ''))) continue
    // A row that names another module is skipped by the host, so rewriting it
    // would report a change that never happens (#1113).
    const named = entryKeyValue(lines, index + 1, 'name')
    if (!rowApplies(named === null ? null : named.replace(/^(['"])(.*)\1$/u, '$2'), expected)) continue
    const flagIndex = nextPatchContentLine(lines, index + 1)
    const flag = /^ {2}disabled: (true|false)[ \t]*(?:\r?\n)?$/u.exec(lines[flagIndex] ?? '')
    if (flag === null || (disabled !== 'any' && flag[1] !== disabled)) continue
    const following = nextPatchContentLine(lines, flagIndex + 1)
    if (/^[ \t]/u.test(lines[following] ?? '')) continue
    const start = offsets[index]!, end = offsets[flagIndex + 1]!
    result += text.slice(copied, start) + replace(text.slice(start, end))
    copied = end
    index = flagIndex
  }
  return result + text.slice(copied)
}

/**
 * What the patch file finally says about one row: the flag of its last
 * `- id: X` entry that carries one, rows with more keys included. Later
 * entries override earlier ones.
 */
/**
 * The row's own flag as the HOST will compose it, from a real YAML parse.
 *
 * The line scanner is deliberately conservative, so it is blind to spellings
 * it was not written for — flow style `- { id: x, disabled: true }`, `disabled`
 * above `id`, `True`, a comment on the id line (#1112). The host parses the
 * file and applies entries in order, the last one winning, so this is both the
 * reading the user means and the one that decides.
 *
 * @returns 'true'/'false' from the last entry naming the row, or null when the
 *   text cannot be read as DSH's patch dialect — the caller then keeps the line
 *   scanner's answer rather than guessing.
 */
function composedRowFlag(text: string, rowId: string, expected: string | null = null): 'true' | 'false' | null {
  let rows: unknown[] | null
  try {
    rows = parsePatchText(text)
  } catch {
    return null
  }
  if (rows === null) return null
  let flag: 'true' | 'false' | null = null
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const entry = row as { id?: unknown; disabled?: unknown; name?: unknown }
    if (entry.id !== rowId) continue
    // A row naming another module never reaches this id's entry (#1113).
    if (!rowApplies(entry.name, expected)) continue
    // An `!!js` expression arrives as a function (or a tag object): it decides
    // by itself, and flattening it here would freeze one host's answer.
    if (entry.disabled === true) flag = 'true'
    else if (entry.disabled === false) flag = 'false'
  }
  return flag
}

function lastRowFlag(text: string, rowId: string, expected: string | null = null): 'true' | 'false' | null {
  const id = escapeRegExp(rowId)
  const idLine = new RegExp(`^- id: (?:${id}|'${id}'|"${id}")\\s*$`, 'u')
  const lines = text.split(/\r?\n/u)
  let flag: 'true' | 'false' | null = null
  for (let index = 0; index < lines.length; index += 1) {
    if (!idLine.test(lines[index] ?? '')) continue
    const named = entryKeyValue(lines, index + 1, 'name')
    const name = named === null ? null : named.replace(/^(['"])(.*)\1$/u, '$2')
    if (!rowApplies(name, expected)) continue
    const value = entryKeyValue(lines, index + 1, 'disabled')
    if (value === 'true' || value === 'false') flag = value
  }
  return flag
}

/**
 * Append one top-level patch entry, refusing when the file is not a valid
 * entry list. The refusal is the point: a malformed patch layer (the
 * `[]` + items mistake, or any broken YAML) must never be made worse —
 * the market reports it and keeps its own live/state.json toggle instead.
 */
/**
 * Write the patch file, or say in the user's words why it could not be
 * written (kettly1260's family of reports, and #582's read-only case): a bare
 * `EACCES: permission denied, open '…'` reaching the UI tells a user nothing
 * they can act on, while the plugin's actual state has already changed.
 */
/**
 * The user patch as text, without a leading UTF-8 BOM.
 *
 * Windows Notepad saves UTF-8 with one, and `readFileSync` keeps it. js-yaml
 * and the host strip it, so the host saw the first row while every
 * `^`-anchored scan here missed it: a first `- id:` read as absent, and a
 * first `[]` was not recognised as the placeholder, so a toggle appended
 * after it and wrote a second top-level node. The market's own writes drop
 * the BOM from then on. Throws like `readFileSync` when the file is missing.
 */
function readPatchText(patchPath: string): string {
  const text = readFileSync(patchPath, 'utf8')
  return text.startsWith('﻿') ? text.slice(1) : text
}

function writePatchFile(patchPath: string, contents: string): { ok: boolean; reason: string | null } {
  try {
    writeFileSync(patchPath, contents)
    return { ok: true, reason: null }
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
    const detail = code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
      ? '文件不可写（只读或被系统保护）'
      : code === 'ENOSPC'
        ? '磁盘空间不足'
        : error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      reason: `补丁层文件写不进去：${detail} / the patch file could not be written: ${code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'it is read-only' : detail}`,
    }
  }
}

function appendPatchEntry(patchPath: string, block: string): { ok: boolean; reason: string | null } {
  let text = ''
  try {
    text = readPatchText(patchPath)
  } catch { /* created below */ }
  const core = text.trim()
  if (core === '') {
    return writePatchFile(patchPath, block)
  }
  // The dsh profile template ships an empty `[]` placeholder (a valid
  // empty list). Appending after it would create TWO top-level elements in
  // one document — the exact YAML error a hand-edit runs into. Comment the
  // placeholder out (keeping the template header) and append the entry.
  const withoutComments = text.replace(/^[ \t]*#.*$/gmu, '').trim()
  // Comments only (the user dropped the placeholder): append after them.
  if (withoutComments === '') {
    const next = text.endsWith('\n') ? text : `${text}\n`
    return writePatchFile(patchPath, `${next}${block}`)
  }
  if (withoutComments === '[]' || withoutComments === '[ ]') {
    const commented = text.replace(/^[ \t]*\[[ \t]*\][ \t]*(?:#.*)?(?:\r?\n|$)/mu, '# []\n')
    const next = commented.endsWith('\n') ? commented : `${commented}\n`
    return writePatchFile(patchPath, `${next}${block}`)
  }
  // A top-level flow LIST (other than the placeholder above) cannot be
  // appended to: `- id: X` after `[1, 2]` would create two top-level
  // elements in one document. Block items whose VALUE is flow style (e.g.
  // `- config: [1, 2]`) are fine — their last line starts with `- `.
  const lastContentLine = text.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
    .pop() ?? ''
  if (/^[[{]/u.test(lastContentLine)) {
    return {
      ok: false,
      reason: '补丁层以顶层流式结构结尾,不支持自动追加;请先整理为条目列表 / the patch layer ends in a top-level flow structure; refusing to append — tidy the file into an entry list first',
    }
  }
  // The dsh entry-list dialect decides: anything that does not parse as a
  // top-level array is left untouched (appending would deepen the break).
  if (parsePatchFile(patchPath) === null) {
    return {
      ok: false,
      reason: '补丁层不是合法的条目数组,已拒绝追加以免破坏;请先修正 YAML / the patch layer is not a valid entry list; refused to append — fix the YAML first',
    }
  }
  const next = text.endsWith('\n') ? text : `${text}\n`
  return writePatchFile(patchPath, `${next}${block}`)
}

/**
 * Disable one row: `- id: X` + `disabled: true` (idempotent).
 *
 * A force-enable block already there is flipped in place rather than
 * followed by a second block (#821): the pair cancelled out by order alone,
 * and an uninstall that cleared one of them left the other behind to switch
 * a later reinstall off. Duplicates an older version left are folded into
 * the one block at the same time.
 */
export function disableRow(
  patchPath: string,
  rowId: string,
  options: { expectedName?: string | null } = {},
): Promise<{ ok: boolean; reason: string | null }> {
  return queuedWrite(async () => {
    if (!ROW_ID_RE.test(rowId)) {
      return { ok: false, reason: `行 id 含特殊字符,不支持写入补丁层 / row id ${rowId} cannot be written to the patch layer` }
    }
    const text = (() => {
      try { return readPatchText(patchPath) } catch { return '' }
    })()
    let kept = false
    const next = rewriteRowBlocks(text, rowId, 'any', block => {
      if (kept) return ''
      kept = true
      return block.replace(/^ {2}disabled: false(?=[ \t]*(?:\r?\n|$))/mu, '  disabled: true')
    }, options.expectedName ?? null)
    if (next !== text) {
      const flipped = writePatchFile(patchPath, next)
      if (!flipped.ok) return flipped
      // A longer entry for the row further down still has the last word.
      if (lastRowFlag(next, rowId, options.expectedName ?? null) !== 'true') {
        const result = appendPatchEntry(patchPath, rowBlock(rowId, true))
        if (!result.ok) return result
      }
      logEvent('info', 'patch', `disabled row ${rowId} in ${patchPath}`)
      return { ok: true, reason: null }
    }
    // A row whose `name` is not this entry's owns nothing here: counting it
    // as already-disabled would answer "off" and change nothing, leaving the
    // plugin running (#1113).
    const state = withoutMismatchedRow(readUserPatchState(patchPath), rowId, options.expectedName ?? null)
    if (state.disables.includes(rowId)) return { ok: true, reason: null }
    const result = appendPatchEntry(patchPath, rowBlock(rowId, true))
    if (result.ok) logEvent('info', 'patch', `disabled row ${rowId} in ${patchPath}`)
    return result
  })
}

/** Enable one row: remove its `disabled: true` blocks; force-enable with
 * `disabled: false` when a lower layer (bundle/home patch) holds it down, or
 * when a longer entry of the row still says `disabled: true` (#1099): that
 * entry is never cut up (#821), so it can only be overridden from below.
 *
 * `cleanOnly` is that cleanup and nothing else: remove a block the market
 * itself left on a row, never write a new one (#1110). An opt-in row of a
 * bundle and a row whose `disabled` is an expression are off by design, and
 * appending `disabled: false` above them force-opens a row that should stay
 * closed — the host composes later entries last, so the append wins. */
export function enableRow(
  patchPath: string,
  rowId: string,
  options: { cleanOnly?: boolean; expectedName?: string | null } = {},
): Promise<{ ok: boolean; reason: string | null }> {
  const cleanOnly = options.cleanOnly === true
  const expected = options.expectedName ?? null
  return queuedWrite(async () => {
    if (!ROW_ID_RE.test(rowId)) {
      return { ok: false, reason: `行 id 含特殊字符,不支持写入补丁层 / row id ${rowId} cannot be written to the patch layer` }
    }
    const state = withoutMismatchedRow(readUserPatchState(patchPath), rowId, expected)
    const text = (() => {
      try { return readPatchText(patchPath) } catch { return '' }
    })()
    const next = rewriteRowBlocks(text, rowId, 'true', () => '', expected)
    if (next !== text) {
      const written = writePatchFile(patchPath, withPlaceholderRestored(next))
      if (!written.ok) return written
      // A longer entry for the row may still have the last word — and so may a
      // spelling the line scanner cannot see (#1112). Ask the parser the host
      // uses; when the file is not readable as its dialect, fall back to the
      // scanner.
      const stillOff = composedRowFlag(next, rowId, expected) ?? lastRowFlag(next, rowId, expected)
      if (!cleanOnly && stillOff === 'true') {
        const result = appendPatchEntry(patchPath, rowBlock(rowId, false))
        if (!result.ok) return result
      }
      logEvent('info', 'patch', `${cleanOnly ? 'cleared the block on' : 'enabled'} row ${rowId} in ${patchPath}`)
      return { ok: true, reason: null }
    }
    // Nothing of the market's own to clean: the row's default stands.
    if (cleanOnly) return { ok: true, reason: null }
    if (state.forced.includes(rowId)) return { ok: true, reason: null }
    const result = appendPatchEntry(patchPath, rowBlock(rowId, false))
    if (result.ok) logEvent('info', 'patch', `force-enabled row ${rowId} in ${patchPath}`)
    return result
  })
}

/**
 * Put the empty-list placeholder back when nothing else is left.
 *
 * Appending the first row comments the template's `[]` out (see
 * appendPatchEntry), so removing the LAST row leaves a file of pure
 * comments. That is not a top-level array, and dsh refuses to boot the
 * profile at all — "must be a top-level YAML array of loader patch
 * entries". Disable a plugin, enable it again, and the profile is bricked.
 */
function withPlaceholderRestored(text: string): string {
  if (text.replace(/^[ \t]*#.*$/gmu, '').trim() !== '') return text
  const uncommented = text.replace(/^[ \t]*#[ \t]*\[[ \t]*\][ \t]*(?:\r?\n|$)/mu, '[]\n')
  if (uncommented !== text) return uncommented
  // No commented placeholder to revive (hand-written file): add one.
  return text === '' || text.endsWith('\n') ? `${text}[]\n` : `${text}\n[]\n`
}

/** Remove every disable/force block the market (or the user) wrote for a
 * row — the uninstall cleanup, so a removed plugin leaves no orphan rows. */
export function removeRowBlocks(patchPath: string, rowIds: readonly string[]): { ok: boolean; reason: string | null } {
  let text = ''
  try {
    text = readPatchText(patchPath)
  } catch { return { ok: true, reason: null } } // no file, nothing to remove
  let next = text
  for (const rowId of rowIds) next = rewriteRowBlocks(next, rowId, 'any', () => '')
  if (next === text) return { ok: true, reason: null }
  const written = writePatchFile(patchPath, withPlaceholderRestored(next))
  if (written.ok) logEvent('info', 'patch', `removed patch rows for ${rowIds.join(', ')}`)
  return written
}
