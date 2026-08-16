/**
 * Trial validation for composition changes — issue #98 (phase 3), the
 * "trial boot" half of #19 reduced to what is safe and offline: before any
 * bundle-order or preset change is written to the profile, replay the
 * composition with the CANDIDATE order using the same entry-list machinery
 * the real boot uses (src/check.ts's buildBundleLayers + composeLayers), and
 * refuse the change when the composed tree would fail to boot (duplicate
 * loader entry ids, unresolvable bundle layers, unparseable patches).
 *
 * No process, no network, no writes to the profile: the real profile is only
 * read; if the candidate is bad, the failure is reported and nothing is
 * applied (the caller then skips the write-back entirely).
 *
 * Bundle resolution is deliberately SHARED with the check report
 * (check.ts's buildBundleLayers): the dsh installation anchor first, then
 * Node's module search from the profile (workspace-root hoisting) — so the
 * trial can never disagree with the diagnostics about what a bundle is or
 * where it lives, and official bundles resolve even when they are only
 * hoisted to the workspace root.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildBundleLayers, composeLayers, findDshInstallDir, parsePatchFile,
  type DuplicateId, type LayerInput,
} from './check.ts'
import { mergeOrder, readBundleStack } from './order.ts'

export interface TrialIssue {
  layer: string
  message: string
}

export interface TrialResult {
  ok: boolean
  errors: TrialIssue[]
  warnings: TrialIssue[]
  duplicates: DuplicateId[]
  /** The composed loader rows under the candidate order. */
  rows: { id: string; layer: string }[]
}

/**
 * Replay the profile composition with `newCommunityOrder` (the candidate
 * community-bundle order; official bundles keep their exact positions) and
 * report anything that would break the boot. Pure read.
 */
export function trialValidate(
  profileDir: string,
  newCommunityOrder: string[],
  options: { dshInstallDir?: string | null; homeDir?: string } = {},
): TrialResult {
  const errors: TrialIssue[] = []
  const warnings: TrialIssue[] = []
  const current = readBundleStack(profileDir)
  // Same merge the apply path uses (order.ts mergeOrder): the trial replays
  // EXACTLY the stack a successful apply would write.
  const merged = mergeOrder(current.bundles, newCommunityOrder)
  if (!merged.ok) {
    return { ok: false, errors: [{ layer: '(order)', message: merged.error }], warnings, duplicates: [], rows: [] }
  }
  const candidate = merged.bundles

  // Shared bundle-layer build — identical resolution to analyzeProfile
  // (dsh install anchor first, then Node module search from the profile).
  let specs: Record<string, string> = {}
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    specs = manifest.dependencies ?? {}
  } catch { /* specs stay empty — sources read as '(not a direct dependency)' */ }
  const dshInstall = options.dshInstallDir !== undefined ? options.dshInstallDir : findDshInstallDir()
  const built = buildBundleLayers(profileDir, candidate, specs, dshInstall)
  for (const bundle of built.bundles) {
    if (bundle.error !== null) errors.push({ layer: bundle.name, message: bundle.error })
    if (bundle.parseError !== null) errors.push({ layer: bundle.name, message: bundle.parseError })
  }

  // Same user/home patch layers as the boot (and the check report).
  const layers: LayerInput[] = [...built.layers]
  const userPatchPath = join(profileDir, 'cordis.patch.yml')
  if (existsSync(userPatchPath)) {
    const patches = parsePatchFile(userPatchPath)
    layers.push({ label: 'user-patch', kind: 'user', patches: patches ?? [], parseError: null })
    if (patches === null) errors.push({ layer: 'user-patch', message: 'cordis.patch.yml is not a valid entry list / cordis.patch.yml 不是合法的条目列表' })
  }
  const home = options.homeDir ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const homePatchPath = join(home, 'cordis.patch.yml')
  if (existsSync(homePatchPath)) {
    const patches = parsePatchFile(homePatchPath)
    layers.push({ label: 'home-patch', kind: 'home', patches: patches ?? [], parseError: null })
    if (patches === null) errors.push({ layer: 'home-patch', message: 'home cordis.patch.yml is not a valid entry list / 全局 cordis.patch.yml 不是合法的条目列表' })
  }

  const composed = composeLayers(layers)
  for (const dup of composed.duplicates) {
    errors.push({ layer: dup.layers.join(' / '), message: `duplicate loader entry id ${JSON.stringify(dup.id)} (${dup.count} rows) / 重复的 loader 条目 id ${JSON.stringify(dup.id)}` })
  }
  for (const orphan of composed.orphans) {
    warnings.push({ layer: orphan.layer, message: `${orphan.id}: ${orphan.reason}` })
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    duplicates: composed.duplicates,
    rows: composed.rows.map(row => ({ id: row.id, layer: row.layer })),
  }
}
