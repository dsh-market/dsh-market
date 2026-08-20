/**
 * Named plugin presets — issue #98 (phase 3), the "save different plugin
 * combinations" product shape. A preset captures the community-bundle order
 * and the disabled-plugin list of the profile at save time; applying one
 * replays the composition under the candidate order (trialValidate), refuses
 * on failure, auto-snapshots the profile (createProfileSnapshot), and only
 * then writes the bundle order and disable list.
 *
 * Presets persist in `<profile>/.dsh-market/presets.json` (market-owned
 * state, like snapshots) — deliberately separate from state.json, whose
 * shape routes.ts owns.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readMarketState, writeMarketState } from './hot.ts'
import { applyBundleOrder, mergeOrder, readBundleRules, readBundleStack, validateOrder } from './order.ts'
import { createProfileSnapshot, DEFAULT_MAX_SNAPSHOTS } from './snapshot.ts'
import { trialValidate, type TrialDiff, type TrialIssue } from './trial.ts'
import { logEvent } from './log.ts'

/** Group-style name rule: letters/digits (incl. CJK), spaces, _, -; ≤ 40 chars, at least one non-space. */
const PRESET_NAME_RE = /^[\p{L}\p{N}_ -]{1,40}$/u

/**
 * The market's own package names. The toggle route refuses to disable them;
 * a preset must never carry them in its disabled list either — otherwise
 * applying a preset (or importing one) could disable the very page doing the
 * applying (issue #98 analysis: applyPreset self-disable guard). They are
 * filtered at save/import time and again at apply time (defense in depth).
 */
const MARKET_SELF_NAMES = new Set(['dsh-market', 'dshmarket'])

/** Maximum presets stored per profile (quota — issue #98 analysis). */
export const MAX_PRESETS = 50

/**
 * Atomic same-directory replace (write temp + rename): a crash mid-write can
 * never leave presets.json truncated, which would silently drop every saved
 * preset on the next read.
 */
function writeFileAtomic(file: string, content: string): void {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(temp, content)
  renameSync(temp, file)
}

/** Drop the market's own names from a raw disabled list (strings only). */
function sanitizeDisabled(disabled: unknown): string[] {
  if (!Array.isArray(disabled)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of disabled) {
    if (typeof item !== 'string' || item === '') continue
    if (MARKET_SELF_NAMES.has(item)) continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

export interface Preset {
  name: string
  /** Community-bundle order this preset restores. */
  bundleOrder: string[]
  /** Disabled plugin names this preset restores. */
  disabled: string[]
  createdAt: number
}

export interface PresetResult {
  ok: boolean
  error?: string
  /** Set when applyPreset auto-created a pre-change snapshot. */
  snapshot?: string
}

function presetsFile(profileDir: string): string {
  return join(profileDir, '.dsh-market', 'presets.json')
}

function readPresets(profileDir: string): Preset[] {
  try {
    const value = JSON.parse(readFileSync(presetsFile(profileDir), 'utf8')) as { presets?: unknown }
    if (!Array.isArray(value.presets)) return []
    return value.presets.filter((preset): preset is Preset =>
      preset !== null && typeof preset === 'object'
      && typeof (preset as Preset).name === 'string'
      && Array.isArray((preset as Preset).bundleOrder)
      && Array.isArray((preset as Preset).disabled),
    )
  } catch {
    return []
  }
}

function writePresets(profileDir: string, presets: Preset[]): void {
  mkdirSync(join(profileDir, '.dsh-market'), { recursive: true, mode: 0o700 })
  writeFileAtomic(presetsFile(profileDir), `${JSON.stringify({ presets }, null, 2)}\n`)
}

/** All saved presets, newest first. */
export function listPresets(profileDir: string): Preset[] {
  return readPresets(profileDir).sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Save the current composition state as a named preset. The bundle order is
 * validated against the current community bundles so a stale snapshot can
 * never be stored.
 */
export function savePreset(
  profileDir: string,
  name: unknown,
  bundleOrder: unknown,
  disabled: unknown,
): PresetResult {
  if (typeof name !== 'string' || !PRESET_NAME_RE.test(name) || name.trim() === '') {
    return { ok: false, error: 'invalid preset name / 组合名称无效' }
  }
  if (!Array.isArray(bundleOrder) || !bundleOrder.every(item => typeof item === 'string')) {
    return { ok: false, error: 'bundle order must be an array of names / bundle 顺序必须是名称数组' }
  }
  // The stored order must be a permutation of the CURRENT community bundles:
  // a stale snapshot is refused here instead of failing later at apply time
  // (issue #98 review M3 — the comment now matches the implementation).
  const { community } = readBundleStack(profileDir)
  const order = bundleOrder as string[]
  if (new Set(order).size !== order.length || order.length !== community.length || order.some(name => !community.includes(name))) {
    return { ok: false, error: 'bundle order must be a permutation of the current community bundles / bundle 顺序必须是当前社区 bundle 的排列' }
  }
  const normalizedDisabled = sanitizeDisabled(disabled)
  const presets = readPresets(profileDir)
  if (presets.some(preset => preset.name === name)) {
    return { ok: false, error: 'a preset with this name already exists / 同名组合已存在' }
  }
  // Quota (issue #98 analysis): a bounded store keeps the file small and the
  // list usable; refuse instead of silently trimming.
  if (presets.length >= MAX_PRESETS) {
    return { ok: false, error: `preset quota reached (${MAX_PRESETS}) — delete one first / 组合数量已达上限（${MAX_PRESETS}），请先删除一个` }
  }
  presets.push({
    name,
    bundleOrder: order,
    disabled: normalizedDisabled,
    createdAt: Date.now(),
  })
  writePresets(profileDir, presets)
  logEvent('info', 'preset', `saved "${name}" (${order.length} bundles, ${normalizedDisabled.length} disabled)`)
  return { ok: true }
}

/** Delete a named preset. */
export function deletePreset(profileDir: string, name: unknown): PresetResult {
  if (typeof name !== 'string') return { ok: false, error: 'invalid preset name / 组合名称无效' }
  const presets = readPresets(profileDir)
  const next = presets.filter(preset => preset.name !== name)
  if (next.length === presets.length) return { ok: false, error: 'preset not found / 组合不存在' }
  writePresets(profileDir, next)
  logEvent('info', 'preset', `deleted "${name}"`)
  return { ok: true }
}

/** The concrete change a preset apply would make — computed BEFORE writing. */
export interface PresetChange {
  /** Bundles whose position changes under the preset order. */
  reordered: string[]
  /** Plugins the preset would ENABLE (currently disabled, enabled by the preset). */
  enabled: string[]
  /** Plugins the preset would DISABLE (currently enabled, disabled by the preset). */
  disabled: string[]
  /** True when nothing would change. */
  noop: boolean
}

export interface PresetApplyResult extends PresetResult {
  changes?: PresetChange
  /** Set when the preset order fails trial validation — errors + current-vs-candidate diff (issue #125 review). */
  trial?: { errors: TrialIssue[]; warnings: TrialIssue[]; diff: TrialDiff }
}

/**
 * The preset's bundle set vs the profile's current community bundles —
 * a stale preset (saved before a plugin was installed/uninstalled) can no
 * longer be applied as-is, but its intent (enabled/disabled plugins,
 * relative order) is still previewable.
 */
export interface PresetMismatch {
  /** Bundles in the current profile that the preset does not mention. */
  missing: string[]
  /** Bundles the preset mentions that are not installed anymore. */
  extra: string[]
  /** True when the preset's bundle set differs from the current one. */
  stale: boolean
}

/** Compare a preset's order against the current community bundle set. */
function presetMismatch(profileDir: string, bundleOrder: string[]): PresetMismatch {
  const { community } = readBundleStack(profileDir)
  const current = new Set(community)
  const preset = new Set(bundleOrder)
  const missing = community.filter(name => !preset.has(name))
  const extra = bundleOrder.filter(name => !current.has(name))
  return { missing, extra, stale: missing.length > 0 || extra.length > 0 }
}

/**
 * Preview what applying a preset would change, WITHOUT writing anything.
 * A stale preset (bundle set mismatch) is NOT a hard failure: the preview
 * reports the mismatch alongside the still-computable changes (relative
 * order + enabled/disabled diffs over the intersection).
 */
export function previewPreset(profileDir: string, name: unknown): PresetResult & { changes?: PresetChange; mismatch?: PresetMismatch } {
  if (typeof name !== 'string') return { ok: false, error: 'invalid preset name / 组合名称无效' }
  const preset = readPresets(profileDir).find(item => item.name === name)
  if (preset === undefined) return { ok: false, error: 'preset not found / 组合不存在' }

  // Full composition replay only makes sense when the bundle SET matches;
  // otherwise report the mismatch (and keep the apply path's hard refusal).
  const mismatch = presetMismatch(profileDir, preset.bundleOrder)
  if (mismatch.stale) {
    const detail = [...mismatch.missing.map(n => `+${n}`), ...mismatch.extra.map(n => `-${n}`)].join(' ')
    return {
      ok: false,
      mismatch,
      error: `preset is out of date — current profile differs: ${detail} / 组合已过期——当前 profile 的插件列表已变化：${detail}`,
    }
  }

  const trial = trialValidate(profileDir, preset.bundleOrder)
  if (!trial.ok) {
    const first = trial.errors[0]
    return {
      ok: false,
      error: `trial validation failed — ${first?.message ?? 'composition would not boot'} / 试启动校验失败：${first?.message ?? '组合无法启动'}`,
    }
  }

  const { community } = readBundleStack(profileDir)
  const reordered = community.filter((name, index) => name !== preset.bundleOrder[index])
  const currentDisabled = readMarketState(profileDir).disabled
  // The market's own names are never applied (self-disable guard) — exclude
  // them from the diff too, so the preview matches what apply will actually do.
  const presetDisabled = new Set(preset.disabled.filter(name => !MARKET_SELF_NAMES.has(name)))
  const enabled = [...currentDisabled].filter(name => !presetDisabled.has(name))
  const disabled = [...presetDisabled].filter(name => !currentDisabled.has(name))
  return {
    ok: true,
    changes: {
      reordered,
      enabled,
      disabled,
      noop: reordered.length === 0 && enabled.length === 0 && disabled.length === 0,
    },
  }
}

/**
 * Apply a saved preset: trial-validate the candidate order first (refuse
 * without writing on any boot-breaking issue), auto-snapshot the profile,
 * then write the bundle order and the disable list. The response carries the
 * change preview so the UI can report exactly what moved.
 */
export function applyPreset(profileDir: string, name: unknown, maxSnapshots: number = DEFAULT_MAX_SNAPSHOTS): PresetApplyResult {
  if (typeof name !== 'string') return { ok: false, error: 'invalid preset name / 组合名称无效' }
  const preset = readPresets(profileDir).find(item => item.name === name)
  if (preset === undefined) return { ok: false, error: 'preset not found / 组合不存在' }

  // A stale preset (bundle set differs) cannot be applied as-is; say exactly
  // what differs instead of the raw trial-merge error (issue #98 report).
  const mismatch = presetMismatch(profileDir, preset.bundleOrder)
  if (mismatch.stale) {
    const detail = [...mismatch.missing.map(n => `+${n}`), ...mismatch.extra.map(n => `-${n}`)].join(' ')
    logEvent('warn', 'preset', `apply "${name}" rejected: preset out of date — ${detail}`)
    return {
      ok: false,
      error: `preset is out of date — current profile differs: ${detail} / 组合已过期——当前 profile 的插件列表已变化：${detail}`,
    }
  }

  const trial = trialValidate(profileDir, preset.bundleOrder)
  if (!trial.ok) {
    const first = trial.errors[0]
    logEvent('warn', 'preset', `apply "${name}" rejected by trial validation: ${first?.message ?? 'unknown'}`)
    return {
      ok: false,
      error: `trial validation failed — ${first?.message ?? 'composition would not boot'} / 试启动校验失败：${first?.message ?? '组合无法启动'}`,
      trial: { errors: trial.errors, warnings: trial.warnings, diff: trial.diff },
    }
  }
  // Before/after rules (review B5): the reorder endpoint refuses rule-violating
  // stacks; the preset path must enforce the same gate before writing.
  const { bundles } = readBundleStack(profileDir)
  const merged = mergeOrder(bundles, preset.bundleOrder)
  if (merged.ok) {
    const conflicts = validateOrder(merged.bundles, readBundleRules(profileDir))
    if (conflicts.length > 0) {
      logEvent('warn', 'preset', `apply "${name}" rejected by before/after rules: ${conflicts.map(c => c.reason).join('; ')}`)
      return {
        ok: false,
        error: 'the preset order violates declared before/after rules / 组合顺序违反了插件声明的 before/after 规则',
      }
    }
  }

  const preview = previewPreset(profileDir, name)
  const snapshot = createProfileSnapshot(profileDir, maxSnapshots)
  const ordered = applyBundleOrder(profileDir, preset.bundleOrder)
  if (!ordered.ok) {
    return { ok: false, error: ordered.error }
  }
  const state = readMarketState(profileDir)
  // Self-disable guard (issue #98 analysis): a preset (possibly imported)
  // carrying the market's own name must never switch this page off — drop
  // those names from the applied disabled list.
  const filtered = preset.disabled.filter(name => !MARKET_SELF_NAMES.has(name))
  if (filtered.length !== preset.disabled.length) {
    logEvent('warn', 'preset', `apply "${name}": dropped market self-names from the disabled list`)
  }
  state.disabled = new Set(filtered)
  writeMarketState(profileDir, state)
  logEvent('info', 'preset', `applied "${name}"${snapshot !== null ? ` (snapshot ${snapshot.id})` : ''}`)
  return { ok: true, snapshot: snapshot?.id, changes: preview.ok ? preview.changes : undefined }
}

/**
 * Preset export/import — issue #98 supplement: share a plugin combination
 * between profiles (or machines) as a JSON file. Export is a plain document
 * (an envelope carrying the current presets); import MERGES it into the local
 * list — same-name entries are overwritten, new names are added, and local
 * presets not present in the import are kept.
 *
 * Import deliberately does NOT validate `bundleOrder` against the target
 * profile's current community bundles: that check belongs to apply time,
 * when the target profile's bundles are known (issue #98 review — the apply
 * path already trial-validates and refuses a non-matching order).
 */

/** Envelope of a preset export file; round-trippable by importPresets. */
export interface PresetExport {
  format: 'dsh-market-presets'
  version: 1
  exportedAt: number
  presets: Preset[]
}

/** Current presets as an exportable document (UI order: newest first). */
export function exportPresets(profileDir: string): PresetExport {
  return {
    format: 'dsh-market-presets',
    version: 1,
    exportedAt: Date.now(),
    presets: listPresets(profileDir),
  }
}

export interface PresetImportResult {
  ok: boolean
  error?: string
  /** Presets actually written (added + overwritten). */
  imported: number
  added: number
  updated: number
  /** Invalid entries skipped (bad shape, name, or bundleOrder). */
  skipped: number
  /** Names of the presets written. */
  names: string[]
}

/** Candidate entries from an import payload: the envelope's `presets` array or a bare array. */
function importCandidates(value: unknown): { presets: unknown[] } | null {
  if (Array.isArray(value)) return { presets: value }
  if (value !== null && typeof value === 'object' && Array.isArray((value as { presets?: unknown }).presets)) {
    return { presets: (value as { presets: unknown[] }).presets }
  }
  return null
}

/**
 * Merge an exported preset document (or a bare preset array) into the local
 * list. Same-name entries overwrite the local one, new names are appended,
 * unrelated local presets are kept. Entries with an invalid name, a
 * non-string bundleOrder array, or a non-object shape are skipped and
 * counted. Nothing is written when the payload is not a preset document or
 * contains no valid presets.
 */
export function importPresets(profileDir: string, value: unknown): PresetImportResult {
  const candidates = importCandidates(value)
  if (candidates === null) {
    return {
      ok: false,
      error: 'preset export must be an array or { presets: [...] } / 导入内容必须是数组或 { presets: [...] } 格式',
      imported: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      names: [],
    }
  }
  const incoming: Preset[] = []
  let skipped = 0
  for (const entry of candidates.presets) {
    if (entry === null || typeof entry !== 'object') {
      skipped += 1
      continue
    }
    const item = entry as { name?: unknown; bundleOrder?: unknown; disabled?: unknown; createdAt?: unknown }
    if (typeof item.name !== 'string' || !PRESET_NAME_RE.test(item.name)) {
      skipped += 1
      continue
    }
    if (!Array.isArray(item.bundleOrder) || !item.bundleOrder.every(name => typeof name === 'string')) {
      skipped += 1
      continue
    }
    // Missing `disabled` is tolerated (legacy exports); an explicit
    // non-array value is malformed and skips the entry (review B16).
    if (item.disabled !== undefined && !Array.isArray(item.disabled)) {
      skipped += 1
      continue
    }
    const disabled = sanitizeDisabled(item.disabled)
    const createdAt = typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) && item.createdAt > 0
      ? item.createdAt
      : Date.now()
    incoming.push({
      name: item.name,
      bundleOrder: item.bundleOrder as string[],
      disabled,
      createdAt,
    })
  }
  if (incoming.length === 0) {
    return {
      ok: false,
      error: skipped > 0
        ? 'no valid presets in the import / 导入文件中没有有效组合'
        : 'the import contains no presets / 导入文件中没有组合',
      imported: 0,
      added: 0,
      updated: 0,
      skipped,
      names: [],
    }
  }
  // Dedupe same-name entries WITHIN the payload (last wins), so one imported
  // file can never write the same name twice nor inflate the imported count
  // (issue #98 analysis: import dedup).
  const unique = new Map<string, Preset>()
  for (const preset of incoming) unique.set(preset.name, preset)
  const local = readPresets(profileDir)
  const byName = new Map(local.map(preset => [preset.name, preset]))
  let added = 0
  let updated = 0
  for (const preset of unique.values()) {
    if (byName.has(preset.name)) updated += 1
    else added += 1
    byName.set(preset.name, preset)
  }
  // Quota (issue #98 analysis): refuse the whole import when the merged list
  // would exceed the cap — never silently trim the user's data.
  if (byName.size > MAX_PRESETS) {
    return {
      ok: false,
      error: `import would exceed the preset quota (${MAX_PRESETS}) / 导入会超过组合数量上限（${MAX_PRESETS}）`,
      imported: 0,
      added: 0,
      updated: 0,
      skipped,
      names: [],
    }
  }
  const merged = [...byName.values()]
  writePresets(profileDir, merged)
  const names = [...unique.keys()]
  logEvent('info', 'preset', `imported ${unique.size} preset(s) (${added} added, ${updated} overwritten, ${skipped} skipped): ${names.join(', ')}`)
  return { ok: true, imported: unique.size, added, updated, skipped, names }
}