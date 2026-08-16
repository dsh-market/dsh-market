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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readMarketState, writeMarketState } from './hot.ts'
import { applyBundleOrder, mergeOrder, readBundleRules, readBundleStack, validateOrder } from './order.ts'
import { createProfileSnapshot, DEFAULT_MAX_SNAPSHOTS } from './snapshot.ts'
import { trialValidate } from './trial.ts'
import { logEvent } from './log.ts'

/** Group-style name rule: letters/digits (incl. CJK), spaces, _, -; ≤ 40 chars, at least one non-space. */
const PRESET_NAME_RE = /^[\p{L}\p{N}_ -]{1,40}$/u

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
  writeFileSync(presetsFile(profileDir), `${JSON.stringify({ presets }, null, 2)}\n`)
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
  const normalizedDisabled = Array.isArray(disabled)
    ? disabled.filter((item): item is string => typeof item === 'string' && item !== '')
    : []
  const presets = readPresets(profileDir)
  if (presets.some(preset => preset.name === name)) {
    return { ok: false, error: 'a preset with this name already exists / 同名组合已存在' }
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
}

/**
 * Preview what applying a preset would change, WITHOUT writing anything.
 * Runs the same trial validation as applyPreset so a broken preset is
 * surfaced before the user commits.
 */
export function previewPreset(profileDir: string, name: unknown): PresetResult & { changes?: PresetChange } {
  if (typeof name !== 'string') return { ok: false, error: 'invalid preset name / 组合名称无效' }
  const preset = readPresets(profileDir).find(item => item.name === name)
  if (preset === undefined) return { ok: false, error: 'preset not found / 组合不存在' }

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
  const presetDisabled = new Set(preset.disabled)
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

  const trial = trialValidate(profileDir, preset.bundleOrder)
  if (!trial.ok) {
    const first = trial.errors[0]
    logEvent('warn', 'preset', `apply "${name}" rejected by trial validation: ${first?.message ?? 'unknown'}`)
    return {
      ok: false,
      error: `trial validation failed — ${first?.message ?? 'composition would not boot'} / 试启动校验失败：${first?.message ?? '组合无法启动'}`,
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
  state.disabled = new Set(preset.disabled)
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
    const disabled = Array.isArray(item.disabled)
      ? item.disabled.filter((name): name is string => typeof name === 'string' && name !== '')
      : []
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
  const local = readPresets(profileDir)
  const byName = new Map(local.map(preset => [preset.name, preset]))
  let added = 0
  let updated = 0
  for (const preset of incoming) {
    if (byName.has(preset.name)) updated += 1
    else added += 1
    byName.set(preset.name, preset)
  }
  writePresets(profileDir, [...byName.values()])
  logEvent('info', 'preset', `imported ${incoming.length} preset(s) (${added} added, ${updated} overwritten, ${skipped} skipped): ${incoming.map(p => p.name).join(', ')}`)
  return { ok: true, imported: incoming.length, added, updated, skipped, names: incoming.map(p => p.name) }
}
