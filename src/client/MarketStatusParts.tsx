/**
 * Small status pieces shared by the Market tabs: the host-requirement chip, the shared-dependency findings panel and the activation labels.
 */

import type {
  ActivationState,
  HostCompatibility,
  MarketStatus,
  SharedHostPackageDependencyFinding,
  Translate,
} from './market-data.ts'
import css from './Market.module.css'
import { IconWarningOutline16 } from './icons.ts'

/** Discover + Installed share one chip: same label fallbacks, status tip, bad ink. */
export function hostRequirementChip(
  compatibility: HostCompatibility | undefined,
  key: string | null,
  t: Translate,
): { label: string; title: string; bad: boolean; status: string } {
  const label = compatibility?.requirement !== null && compatibility?.requirement !== undefined
    ? t('hostRequirement').replace('{0}', compatibility.requirement)
    : key === null
      ? t('hostRequirementUnavailable')
      : compatibility === undefined
        ? t('hostRequirementLoading')
        : compatibility.basis === 'undeclared'
          ? t('hostRequirementUndeclared')
          : t('hostRequirementUnavailable')
  const detail = compatibility?.declarations.map(declaration =>
    declaration.kind === 'engine'
      ? `engines.dsh: ${declaration.range}`
      : `${declaration.package ?? 'peer'}: ${declaration.range}`,
  ).join('\n') || label
  const title = (compatibility?.status === 'compatible' || compatibility?.status === 'incompatible'
    ? t(compatibility.status === 'compatible' ? 'hostStatusCompatible' : 'hostStatusIncompatible') + '\n'
    : '') + detail
  return {
    label,
    title,
    bad: compatibility?.status === 'incompatible',
    status: compatibility?.status ?? 'unknown',
  }
}

export function isHostDependencyFinding(value: unknown): value is SharedHostPackageDependencyFinding {
  if (value === null || typeof value !== 'object') return false
  const finding = value as Partial<SharedHostPackageDependencyFinding>
  return finding.code === 'shared-host-package-dependency'
    && finding.severity === 'warning'
    && finding.subject?.kind === 'package'
    && typeof finding.subject.name === 'string'
    && finding.evidence?.basis === 'manifest-declaration'
    && typeof finding.evidence?.dependency === 'string'
    && typeof finding.evidence.declaredRange === 'string'
    && finding.evidence.declaredIn === 'dependencies'
}

const HOST_DEPENDENCY_PREVIEW_LIMIT = 5

export function HostDependencyDiagnostics({
  findings,
  t,
}: {
  findings: SharedHostPackageDependencyFinding[]
  t: Translate
}) {
  if (findings.length === 0) return null
  const preview = findings.slice(0, HOST_DEPENDENCY_PREVIEW_LIMIT)
  const remaining = findings.length - preview.length
  return (
    <div className={css.banner}>
      <IconWarningOutline16 size={14} className={css.bannerIcon} />
      <span className={css.grow}>
        <div>{t('hostDependencyWarning')}</div>
        {preview.map(finding => (
          <div
            key={`${finding.subject.name}:${finding.evidence.dependency}`}
            className={css.spec}
          >
            {finding.subject.name} → {finding.evidence.dependency}@{finding.evidence.declaredRange}
          </div>
        ))}
        {remaining > 0 && (
          <div className={css.spec}>{t('hostDependencyMore').replace('{0}', String(remaining))}</div>
        )}
      </span>
    </div>
  )
}

/** The state label + dot for one activation result (P0-2). */
export function activationMeta(
  state: ActivationState,
  t: Translate,
  dependencyOf?: string,
  loadedByProfile?: true,
  library?: true,
): { label: string; dot: 'done' | 'warning' | 'error' } {
  if (library === true) return { label: t('stateLibrary'), dot: 'done' }
  // Loaded by the user's own setup, out of the market's sight (#813): a fact
  // about where it comes from, not a warning.
  if (state === 'inert' && loadedByProfile === true) return { label: t('stateLoadedByProfile'), dot: 'done' }
  // A library another plugin pulled in is not a plugin that failed to start,
  // so it gets its own label and no warning dot (#634).
  if (state === 'inert' && dependencyOf !== undefined) {
    return { label: t('stateDependencyLibrary').replace('{0}', dependencyOf), dot: 'done' }
  }
  if (state === 'live') return { label: t('stateLive'), dot: 'done' }
  if (state === 'restart') return { label: t('stateRestart'), dot: 'warning' }
  // The host's own boot gate will skip this plugin on every boot: its dsh
  // peer range excludes the running runtime (#757). Rare and the user must
  // act, so it gets the red dot broken uses.
  if (state === 'incompatible') return { label: t('stateIncompatible'), dot: 'error' }
  if (state === 'inert') return { label: t('stateInert'), dot: 'warning' }
  if (state === 'broken') return { label: t('stateBroken'), dot: 'error' }
  // The package is not on disk at all (verify → 未安装 / not installed): the
  // row has to read as unavailable, not as a state nobody set (#1278).
  if (state === 'missing') return { label: t('notInstalled'), dot: 'error' }
  // The host's loader made a row for it and never started one (#1023): not a
  // pending change, so it must not read like one.
  if (state === 'failed') return { label: t('stateFailed'), dot: 'error' }
  if (state === 'disabled') return { label: t('stateDisabled'), dot: 'warning' }
  return { label: '—', dot: 'warning' }
}

export function phaseLabel(phase: NonNullable<MarketStatus['phase']>, t: Translate): string {
  if (phase === 'resolving') return t('phaseResolving')
  if (phase === 'downloading') return t('phaseDownloading')
  if (phase === 'linking') return t('phaseLinking')
  return t('phaseBuilding')
}
