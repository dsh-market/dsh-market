/**
 * Diagnostics tab — issue #98 (phase 1): renders the profile composition
 * check report served by the host route /dsh-market/check (see src/check.ts).
 *
 * Read-only view of the loading-layer stack and the conflict surface: bundle
 * order (official vs community), duplicate loader entry ids, core packages
 * pulled in as ordinary dependencies, peer dependency mismatches,
 * multi-version core packages, overrides and orphan patches. The report
 * shape mirrors the CheckReport interface in src/check.ts; it is re-declared
 * here because the client bundle is built independently of the host tree.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { DisclosureRow, IconChevronDownOutline14, IconLoadingOutline16, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Market.module.css'
import type { Translate } from './market-data.ts'

/** Mirrors BundleLayer in src/check.ts. */
interface BundleLayer {
  name: string
  source: string
  kind: 'official' | 'community'
  directory: string | null
  patchPath: string | null
  error: string | null
  entries: string[]
  parseError: string | null
}

/** Mirrors DuplicateId in src/check.ts. */
interface DuplicateId {
  id: string
  layers: string[]
  count: number
}

/** Mirrors OverrideRow in src/check.ts. */
interface OverrideRow {
  id: string
  layer: string
  overriddenLayers: string[]
}

/** Mirrors OrphanRow in src/check.ts. */
interface OrphanRow {
  id: string
  layer: string
  reason: string
}

/** Mirrors CoreDepIssue in src/check.ts. */
interface CoreDepIssue {
  plugin: string
  name: string
  spec: string
  section: 'dependencies' | 'peerDependencies'
  hoisted: string | null
  nested: string | null
  host: string | null
  shadowing: boolean
}

/** Mirrors PeerMismatch in src/check.ts. */
interface PeerMismatch {
  plugin: string
  name: string
  range: string
  resolved: string | null
  satisfied: boolean | null
}

/** Mirrors MultiVersion in src/check.ts. */
interface MultiVersion {
  name: string
  versions: string[]
  hoisted: string | null
}

/** Mirrors CheckSummary in src/check.ts. */
interface CheckSummary {
  ok: boolean
  errors: string[]
  warnings: string[]
}

/** Mirrors CheckReport in src/check.ts. */
interface CheckReport {
  profile: string
  scannedAt: number
  bundles: BundleLayer[]
  duplicates: DuplicateId[]
  overrides: OverrideRow[]
  orphans: OrphanRow[]
  coreDeps: CoreDepIssue[]
  peerMismatches: PeerMismatch[]
  multiVersion: MultiVersion[]
  summary: CheckSummary
}

/** One always-present section card with a count and an empty-state text. */
function Section(props: { title: string; count: number; empty: string; children: ReactNode }) {
  const { title, count, empty, children } = props
  return (
    <section className={css.diagSection}>
      <h3>{title} <span className={css.diagCount}>({count})</span></h3>
      {count === 0 ? <div className={css.diagEmpty}>{empty}</div> : children}
    </section>
  )
}

/** A collapsible secondary section (overrides / orphans). */
function DisclosureSection(props: {
  title: string
  count: number
  empty: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const { title, count, empty, open, onToggle, children } = props
  return (
    <DisclosureRow
      icon={<IconChevronDownOutline14 size={14} />}
      title={`${title} (${count})`}
      expandable
      open={open}
      onToggle={onToggle}
    >
      {count === 0 ? <div className={css.diagEmpty}>{empty}</div> : children}
    </DisclosureRow>
  )
}

/**
 * Fetch and render the profile check report. Refetches on every mount, so
 * switching tabs away and back re-runs the (cheap, read-only) analysis.
 */
export function Diagnostics(props: { t: Translate }) {
  const { t } = props
  const [report, setReport] = useState<CheckReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [overridesOpen, setOverridesOpen] = useState(true)
  const [orphansOpen, setOrphansOpen] = useState(true)

  useEffect(() => {
    let live = true
    setReport(null)
    setError(null)
    fetch('/dsh-market/check', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
        const body = (await res.json()) as CheckReport
        if (live) setReport(body)
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err))
      })
    return () => { live = false }
  }, [])

  if (error !== null) {
    return <div className={css.err}>{t('checkLoadFail')}{error}</div>
  }
  if (report === null) {
    return (
      <div className={css.loading}>
        <span className={css.spin}><IconLoadingOutline16 size={22} /></span>
        {t('checkLoading')}
      </div>
    )
  }

  const summary = report.summary
  return (
    <div className={css.diagPage}>
      <div className={css.diagSummary}>
        <span className={summary.ok ? css.okState : css.err}>
          <StateDot state={summary.ok ? 'done' : 'error'} size={8} />
          {summary.ok ? t('checkOk') : t('checkIssues')}
        </span>
        <span className={css.diagSummaryItem}>
          <StateDot state="error" size={8} />{t('checkErrors')}: {summary.errors.length}
        </span>
        <span className={css.diagSummaryItem}>
          <StateDot state="warning" size={8} />{t('checkWarnings')}: {summary.warnings.length}
        </span>
        <span className={css.grow} />
        <span className={css.diagSummaryMeta} title={report.profile}>{t('checkProfile')}: {report.profile}</span>
        <span className={css.diagSummaryMeta}>{t('checkScannedAt')}: {new Date(report.scannedAt).toLocaleString()}</span>
      </div>

      <Section title={t('checkErrors')} count={summary.errors.length} empty={t('checkErrorsEmpty')}>
        <div className={css.diagList}>
          {summary.errors.map((line, i) => (
            <div key={i} className={css.err}>{line}</div>
          ))}
        </div>
      </Section>

      <Section title={t('checkWarnings')} count={summary.warnings.length} empty={t('checkWarningsEmpty')}>
        <div className={css.diagList}>
          {summary.warnings.map((line, i) => (
            <div key={i} className={css.warnLine}><span>{line}</span></div>
          ))}
        </div>
      </Section>

      <Section title={t('checkBundles')} count={report.bundles.length} empty={t('checkBundlesEmpty')}>
        {report.bundles.map((bundle, i) => (
          <div key={bundle.name} className={css.diagBundle}>
            <div className={css.diagRow}>
              <span className={css.diagIndex}>{i + 1}</span>
              <span className={css.nm}>{bundle.name}</span>
              <span className={bundle.kind === 'official' ? css.diagBadgeOfficial : css.diagBadgeCommunity}>
                {bundle.kind === 'official' ? t('checkOfficial') : t('checkCommunity')}
              </span>
              {bundle.error !== null && <span className={css.err}>{bundle.error}</span>}
              {bundle.parseError !== null && <span className={css.err}>{t('checkPatch')}: {bundle.parseError}</span>}
            </div>
            <div className={css.diagMeta}>
              <span className={css.diagKey}>{t('checkSource')}</span>
              <code className={css.spec}>{bundle.source}</code>
            </div>
            <div className={css.diagMeta}>
              <span className={css.diagKey}>{t('checkEntries')}</span>
              <code className={css.spec}>{bundle.entries.length > 0 ? bundle.entries.join(', ') : '—'}</code>
            </div>
            {bundle.directory !== null && (
              <div className={css.diagMeta}>
                <span className={css.diagKey}>{t('checkDir')}</span>
                <code className={css.spec}>{bundle.directory}</code>
              </div>
            )}
            {bundle.patchPath !== null && (
              <div className={css.diagMeta}>
                <span className={css.diagKey}>{t('checkPatch')}</span>
                <code className={css.spec}>{bundle.patchPath}</code>
              </div>
            )}
          </div>
        ))}
      </Section>

      <Section title={t('checkDuplicates')} count={report.duplicates.length} empty={t('checkDuplicatesEmpty')}>
        <div className={css.diagList}>
          {report.duplicates.map(dup => (
            <div key={dup.id} className={css.diagRow}>
              <code className={css.diagVal}>{dup.id}</code>
              <span className={css.err}>× {dup.count}</span>
              <span className={css.spec}>{dup.layers.join(' / ')}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title={t('checkCoreDeps')} count={report.coreDeps.length} empty={t('checkCoreDepsEmpty')}>
        <div className={css.diagList}>
          {report.coreDeps.map((dep, i) => (
            <div key={i} className={css.diagRow}>
              <code className={css.diagVal}>{dep.name}</code>
              <span className={css.nm}>{dep.plugin}</span>
              <span className={css.spec}>{dep.spec}</span>
              <span className={css.spec}>{t('checkSection')}: {dep.section}</span>
              <span className={css.spec}>{t('checkHost')}: {dep.host ?? '—'}</span>
              <span className={css.spec}>{t('checkHoisted')}: {dep.hoisted ?? '—'}</span>
              {dep.shadowing && <span className={css.diagBadgeShadow}>{t('checkShadowing')}</span>}
            </div>
          ))}
        </div>
      </Section>

      <Section title={t('checkPeerMismatches')} count={report.peerMismatches.length} empty={t('checkPeerEmpty')}>
        <div className={css.diagList}>
          {report.peerMismatches.map((peer, i) => (
            <div key={i} className={css.diagRow}>
              <code className={css.diagVal}>{peer.name}</code>
              <span className={css.nm}>{peer.plugin}</span>
              <span className={css.spec}>{t('checkRange')}: {peer.range}</span>
              <span className={css.spec}>{t('checkResolved')}: {peer.resolved ?? '—'}</span>
              {peer.satisfied === false
                ? <span className={css.diagBadgeShadow}>{t('checkUnsatisfied')}</span>
                : peer.satisfied === true
                  ? <span className={css.okState}>{t('checkSatisfied')}</span>
                  : <span className={css.spec}>{t('checkUnknown')}</span>}
            </div>
          ))}
        </div>
      </Section>

      <Section title={t('checkMultiVersion')} count={report.multiVersion.length} empty={t('checkMultiEmpty')}>
        <div className={css.diagList}>
          {report.multiVersion.map(mv => (
            <div key={mv.name} className={css.diagRow}>
              <code className={css.diagVal}>{mv.name}</code>
              <span className={css.spec}>{mv.versions.join(' / ')}</span>
              {mv.hoisted !== null && <span className={css.spec}>{t('checkHoisted')}: {mv.hoisted}</span>}
            </div>
          ))}
        </div>
      </Section>

      <DisclosureSection
        title={t('checkOverrides')}
        count={report.overrides.length}
        empty={t('checkOverridesEmpty')}
        open={overridesOpen}
        onToggle={() => setOverridesOpen(o => !o)}
      >
        <div className={css.diagList}>
          {report.overrides.map((ov, i) => (
            <div key={i} className={css.diagRow}>
              <code className={css.diagVal}>{ov.id}</code>
              <span className={css.nm}>{ov.layer}</span>
              <span className={css.spec}>{t('checkOverridden')}: {ov.overriddenLayers.join(', ')}</span>
            </div>
          ))}
        </div>
      </DisclosureSection>

      <DisclosureSection
        title={t('checkOrphans')}
        count={report.orphans.length}
        empty={t('checkOrphansEmpty')}
        open={orphansOpen}
        onToggle={() => setOrphansOpen(o => !o)}
      >
        <div className={css.diagList}>
          {report.orphans.map((orphan, i) => (
            <div key={i} className={css.diagRow}>
              <code className={css.diagVal}>{orphan.id}</code>
              <span className={css.nm}>{orphan.layer}</span>
              <span className={css.spec}>{t('checkReason')}: {orphan.reason}</span>
            </div>
          ))}
        </div>
      </DisclosureSection>
    </div>
  )
}
