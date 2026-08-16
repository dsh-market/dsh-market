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
import { applyBundleOrder, readBundleStack } from './order.ts'
import { createProfileSnapshot } from './snapshot.ts'
import { trialValidate } from './trial.ts'
import { logEvent } from './log.ts'

/** Group-style name rule: letters/digits (incl. CJK), spaces, _, -; ≤ 40 chars. */
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
  if (typeof name !== 'string' || !PRESET_NAME_RE.test(name)) {
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
export function applyPreset(profileDir: string, name: unknown): PresetApplyResult {
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

  const preview = previewPreset(profileDir, name)
  const snapshot = createProfileSnapshot(profileDir)
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
