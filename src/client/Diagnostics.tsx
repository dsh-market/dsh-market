/**
 * Diagnostics tab — issue #98: renders the profile composition check report
 * served by the host route /dsh-market/check (see src/check.ts). Below the
 * report sit the phase 2/3 action panels: a community-bundle ordering block
 * (reorder locally with ↑/↓, POST to /dsh-market/bundle-order), a snapshots
 * & rollback panel (snapshot-panel.tsx) and a plugin presets panel
 * (preset-panel.tsx) — the latter two are collapsible, default collapsed,
 * and lazy-fetch on first expand.
 *
 * Read-only view of the loading-layer stack and the conflict surface: bundle
 * order (official vs community), duplicate loader entry ids, core packages
 * pulled in as ordinary dependencies, peer dependency mismatches,
 * multi-version core packages, overrides and orphan patches. The report
 * shape mirrors the CheckReport interface in src/check.ts; it is re-declared
 * here because the client bundle is built independently of the host tree.
 */
import { useCallback, useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react'
import { Button, IconChevronDownOutline14, IconChevronRightOutline14, IconLoadingOutline16, IconRefreshOutline14, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Market.module.css'
import type { Translate } from './market-data.ts'
import { PresetPanel } from './preset-panel.tsx'
import { SnapshotPanel } from './snapshot-panel.tsx'

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

/** Mirrors OrderConflict in src/order.ts (top-level orderConflicts in CheckReport). */
interface OrderConflict {
  name: string
  reason: string
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
  /** #98 phase 2: validateOrder result for the CURRENT bundle order, when the host emits it. */
  orderConflicts?: OrderConflict[]
  /** #98 opt: loader rows sharing one name — runtime shadowing, not a boot failure. */
  duplicateNames?: Array<{ name: string; layers: string[]; count: number }>
  /** #98 opt: LOOT-style suggested community order satisfying every rule. */
  suggestedOrder?: { ok: true; order: string[] } | { ok: false; cycle: string[] } | null
}

/**
 * A collapsible report section: header shows title + count + chevron; the
 * body stays mounted (hidden via CSS when collapsed) so every block keeps
 * its state. ALL blocks are collapsed by default; only blocks with real
 * problems (errors/warnings) are passed `defaultOpen` by the caller. When
 * collapsed, an optional one-line `overview` summarizes the block so the
 * page reads without expanding everything.
 */
function Section(props: {
  title: string
  count: number
  empty: string
  defaultOpen?: boolean
  overview?: ReactNode
  children: ReactNode
}) {
  const { title, count, empty, defaultOpen, overview, children } = props
  const [open, setOpen] = useState(defaultOpen ?? false)
  return (
    <section className={css.diagSection}>
      <button type="button" className={css.collapseHead} onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className={css.collapseIcon}>
          {open ? <IconChevronDownOutline14 size={14} /> : <IconChevronRightOutline14 size={14} />}
        </span>
        <span className={css.collapseTitle}>{title}</span>
        <span className={css.diagCount}>({count})</span>
        <span className={css.grow} />
      </button>
      {!open && overview !== undefined && <div className={css.sectionOverview}>{overview}</div>}
      <div className={css.collapseBody} style={open ? undefined : { display: 'none' }}>
        {count === 0 ? <div className={css.diagEmpty}>{empty}</div> : children}
      </div>
    </section>
  )
}

/** A collapsible section that KEEPS its children mounted (hidden via CSS when
 * collapsed) so the phase 3 panels below retain their loaded data and
 * in-progress edits across collapses. Children mount from the start, but the
 * panels only fetch when `open` first becomes true.
 */
function CollapsibleSection(props: { title: string; count?: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  const { title, count, open, onToggle, children } = props
  return (
    <section className={css.diagSection}>
      <button type="button" className={css.collapseHead} onClick={onToggle} aria-expanded={open}>
        <span className={css.collapseIcon}>
          {open ? <IconChevronDownOutline14 size={14} /> : <IconChevronRightOutline14 size={14} />}
        </span>
        <span className={css.collapseTitle}>{title}</span>
        {count !== undefined && <span className={css.diagCount}>({count})</span>}
        <span className={css.grow} />
      </button>
      <div className={css.collapseBody} style={open ? undefined : { display: 'none' }}>
        {children}
      </div>
    </section>
  )
}

/** Map an orphan patch reason (src/check.ts) to a locale key for its badge. */
function orphanKindLabel(reason: string): string {
  if (reason === 'insert is not an array') return 'orphanInsertNotArray'
  if (reason === 'insert target not found') return 'orphanInsertTargetMissing'
  if (reason === 'insert target is not a group') return 'orphanInsertTargetNotGroup'
  if (reason === 'id required for non-insert patch') return 'orphanIdRequired'
  if (reason === 'patch target not found') return 'orphanPatchTargetMissing'
  if (reason.startsWith('name mismatch')) return 'orphanNameMismatch'
  return 'orphanReasonOther'
}

/**
 * Fetch and render the profile check report. Refetches on every mount, so
 * switching tabs away and back re-runs the (cheap, read-only) analysis; the
 * phase 3 panels below call `refresh()` after applying changes.
 */
export function Diagnostics(props: { t: Translate }) {
  const { t } = props
  const [report, setReport] = useState<CheckReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [orderOpen, setOrderOpen] = useState(true)
  const [snapOpen, setSnapOpen] = useState(false)
  const [presetOpen, setPresetOpen] = useState(false)
  /** Bump to re-run the /dsh-market/check fetch after an order/preset/restore apply. */
  const [version, setVersion] = useState(0)
  const refresh = useCallback(() => setVersion(v => v + 1), [])

  // --- issue #98 phase 2 (step 1): community-bundle ordering ---------------
  /** Community bundle names from the report, in declared order. */
  const communityNames = useMemo(
    () => report === null ? [] : report.bundles.filter(bundle => bundle.kind === 'community').map(bundle => bundle.name),
    [report],
  )
  /** Local editing state: re-synced whenever the report (re)loads. */
  const [order, setOrder] = useState<string[]>(communityNames)
  const [orderMsg, setOrderMsg] = useState<string | null>(null)
  const [orderErr, setOrderErr] = useState<string | null>(null)
  const [orderBusy, setOrderBusy] = useState(false)
  useEffect(() => { setOrder(communityNames) }, [communityNames])

  /** Swap one community bundle with its neighbour (-1 up, +1 down). */
  const moveBundle = (index: number, delta: -1 | 1) => {
    setOrder(prev => {
      const next = [...prev]
      const target = index + delta
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target]!, next[index]!]
      return next
    })
  }

  // --- drag & drop reordering (draft only — saved by 应用顺序 / Apply order) ---
  /** Row being dragged (index into the local `order` draft). */
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  /** Row currently under the pointer, highlighted as the drop target. */
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const onRowDragStart = (index: number) => (event: DragEvent<HTMLDivElement>) => {
    if (orderBusy) {
      event.preventDefault()
      return
    }
    setDragIndex(index)
    event.dataTransfer?.setData?.('text/plain', order[index] ?? '')
    if (event.dataTransfer !== undefined) event.dataTransfer.effectAllowed = 'move'
  }

  const onRowDragOver = (index: number) => (event: DragEvent<HTMLDivElement>) => {
    if (dragIndex === null || dragIndex === index) return
    // preventDefault marks the row as a valid drop target (no auto-scroll).
    event.preventDefault()
    if (event.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'move'
    setDragOverIndex(index)
  }

  const onRowDragLeave = (index: number) => () => {
    setDragOverIndex(prev => prev === index ? null : prev)
  }

  const onRowDrop = (index: number) => (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const from = dragIndex
    setDragIndex(null)
    setDragOverIndex(null)
    if (from === null || from === index) return
    // Reorder the LOCAL draft only; the host is told via 应用顺序 / Apply order.
    setOrder(prev => {
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(index, 0, moved!)
      return next
    })
  }

  const onRowDragEnd = () => {
    setDragIndex(null)
    setDragOverIndex(null)
  }

  /** POST the current community order; the host trial-validates and snapshots first. */
  const applyOrder = (target?: string[]) => {
    if (orderBusy) return
    setOrderBusy(true)
    setOrderMsg(null)
    setOrderErr(null)
    fetch('/dsh-market/bundle-order', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: target ?? order }),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null
        if (!res.ok || body?.ok !== true) {
          setOrderErr(String(body?.error ?? `HTTP ${String(res.status)}`))
          return
        }
        setOrderMsg(t('orderApplied'))
        // Refetch the report so communityNames / the PresetPanel bundleOrder
        // reflect the applied order before anything is saved as a preset.
        refresh()
      })
      .catch((err: unknown) => setOrderErr(err instanceof Error ? err.message : String(err)))
      .finally(() => setOrderBusy(false))
  }

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
  }, [version])

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
  const suggested = report.suggestedOrder ?? null
  // Category counts for the overview strip: conflicts / dependencies / order.
  const catConflict = report.duplicates.length + (report.duplicateNames?.length ?? 0)
  const catDeps = report.coreDeps.length + report.peerMismatches.length + report.multiVersion.length
  const catOrder = report.orderConflicts?.length ?? 0
  const anyIssue = catConflict + catDeps + catOrder > 0
  return (
    <div className={css.diagPage}>
      <div className={css.diagSummary}>
        <span className={summary.ok ? css.okState : css.err}>
          <StateDot state={summary.ok ? 'done' : 'error'} size={8} />
          {summary.ok ? (anyIssue ? t('checkIssues') : t('diagOkAll')) : t('checkIssues')}
        </span>
        <span className={css.diagSummaryItem}>
          <StateDot state="error" size={8} />{t('catConflict')}: {catConflict}
        </span>
        <span className={css.diagSummaryItem}>
          <StateDot state="warning" size={8} />{t('catDeps')}: {catDeps}
        </span>
        <span className={css.diagSummaryItem}>
          <StateDot state="warning" size={8} />{t('catOrder')}: {catOrder}
        </span>
        <span className={css.grow} />
        <Button variant="ghost" size="sm" aria-label={t('checkRefresh')} onClick={refresh}>
          <IconRefreshOutline14 size={14} />
        </Button>
        <span className={css.diagSummaryMeta} title={report.profile}>{t('checkProfile')}: {report.profile}</span>
        <span className={css.diagSummaryMeta}>{new Date(report.scannedAt).toLocaleString()}</span>
      </div>

      <Section
        title={t('checkErrors')}
        count={summary.errors.length}
        empty={t('checkErrorsEmpty')}
        defaultOpen={summary.errors.length > 0}
        overview={summary.errors.length > 0 ? summary.errors[0] : undefined}
      >
        <div className={css.diagList}>
          {summary.errors.map((line, i) => (
            <div key={i} className={css.err}>{line}</div>
          ))}
        </div>
      </Section>

      <Section
        title={t('checkWarnings')}
        count={summary.warnings.length}
        empty={t('checkWarningsEmpty')}
        defaultOpen={summary.warnings.length > 0}
        overview={summary.warnings.length > 0 ? summary.warnings[0] : undefined}
      >
        <div className={css.diagList}>
          {summary.warnings.map((line, i) => (
            <div key={i} className={css.warnLine}><span>{line}</span></div>
          ))}
        </div>
      </Section>

      <Section
        title={t('checkBundles')}
        count={report.bundles.length}
        empty={t('checkBundlesEmpty')}
        overview={
          <span>
            {t('checkOfficial')} × {report.bundles.filter(b => b.kind === 'official').length}
            {' · '}
            {t('checkCommunity')} × {report.bundles.filter(b => b.kind === 'community').length}
          </span>
        }
      >
        {report.bundles.map((bundle, i) => (
          <div key={bundle.name} className={css.diagBundle}>
            <div className={css.diagRow}>
              <span className={css.diagIndex}>{i + 1}</span>
              <span className={css.diagArrow}>→</span>
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

      <Section
        title={t('checkDuplicates')}
        count={report.duplicates.length}
        empty={t('checkDuplicatesEmpty')}
        overview={report.duplicates.length > 0 ? `${report.duplicates[0]?.id} × ${report.duplicates[0]?.count}` : undefined}
      >
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

      <Section
        title={t('checkCoreDeps')}
        count={report.coreDeps.length}
        empty={t('checkCoreDepsEmpty')}
        overview={report.coreDeps.length > 0 ? `${report.coreDeps[0]?.name} ← ${report.coreDeps[0]?.plugin}` : undefined}
      >
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

      <Section
        title={t('checkPeerMismatches')}
        count={report.peerMismatches.length}
        empty={t('checkPeerEmpty')}
        overview={report.peerMismatches.length > 0 ? `${report.peerMismatches[0]?.plugin} → ${report.peerMismatches[0]?.name}` : undefined}
      >
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

      <Section
        title={t('checkMultiVersion')}
        count={report.multiVersion.length}
        empty={t('checkMultiEmpty')}
        overview={report.multiVersion.length > 0 ? `${report.multiVersion[0]?.name}: ${report.multiVersion[0]?.versions.join(' / ')}` : undefined}
      >
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

      <Section
        title={t('checkOverrides')}
        count={report.overrides.length}
        empty={t('checkOverridesEmpty')}
        overview={report.overrides.length > 0 ? `${report.overrides[0]?.id} ← ${report.overrides[0]?.layer}` : undefined}
      >
        <div className={css.diagList}>
          {report.overrides.map((ov, i) => (
            <div key={i} className={css.ovRow}>
              <code className={css.diagVal}>{ov.id}</code>
              <span className={css.ovArrow}>←</span>
              <span className={css.ovByTag}>{ov.layer}</span>
              <span className={css.spec}>{t('checkOverridden')}</span>
              <span className={css.ovFrom}>{ov.overriddenLayers.join(', ')}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title={t('checkOrphans')}
        count={report.orphans.length}
        empty={t('checkOrphansEmpty')}
        overview={report.orphans.length > 0 ? `${report.orphans[0]?.id}（${t(orphanKindLabel(report.orphans[0]?.reason ?? ''))}）` : undefined}
      >
        <div className={css.diagList}>
          {report.orphans.map((orphan, i) => (
            <div key={i} className={css.orphRow}>
              <span className={css.orphBadge}>{t(orphanKindLabel(orphan.reason))}</span>
              <code className={css.diagVal}>{orphan.id}</code>
              <span className={css.nm}>{orphan.layer}</span>
              <span className={css.spec}>{orphan.reason}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* issue #98 phase 2 (step 1): community-bundle ordering */}
      <CollapsibleSection title={t('orderSection')} count={order.length} open={orderOpen} onToggle={() => setOrderOpen(o => !o)}>
        <p className={css.panelNote}>{t('orderDragHint')}</p>
        {report.orderConflicts !== undefined && report.orderConflicts.length > 0 && (
          <div className={css.diagList}>
            <span className={css.diagKey}>{t('orderConflicts')}</span>
            {report.orderConflicts.map((conflict, i) => (
              <div key={i} className={css.warnLine}>{conflict.name} — {conflict.reason}</div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="primary" size="sm" disabled={order.length === 0 || orderBusy} onClick={() => applyOrder()}>
            {orderBusy ? '…' : t('orderApply')}
          </Button>
          {suggested !== null && suggested !== undefined && suggested.ok === true
            && suggested.order.join('\u0000') !== communityNames.join('\u0000')
            && (
              <Button variant="outline" size="sm" disabled={orderBusy} onClick={() => applyOrder(suggested.order)}>
                {t('orderSuggestApply')}
              </Button>
            )}
          {order.length !== communityNames.length && (
            <Button variant="ghost" size="sm" disabled={orderBusy} onClick={() => setOrder(communityNames)}>
              {t('orderReset')}
            </Button>
          )}
          {orderMsg !== null && <span className={css.okState}>{orderMsg}</span>}
          {orderErr !== null && <span className={css.err}>{orderErr}</span>}
        </div>
        {suggested !== null && suggested !== undefined && suggested.ok === false && (
          <div className={css.warnLine}>{t('orderSuggestHint')} ⚠ {suggested.cycle.join(' → ')}</div>
        )}
        {report.duplicateNames !== undefined && report.duplicateNames.length > 0 && (
          <div className={css.diagList}>
            <span className={css.diagKey}>{t('duplicateNames')}</span>
            {report.duplicateNames.map((dup, i) => (
              <div key={i} className={css.warnLine}>{dup.name} × {dup.count} — {dup.layers.join(' / ')}</div>
            ))}
          </div>
        )}
        {order.length === 0
          ? <div className={css.diagEmpty}>—</div>
          : (
              <div className={css.diagList}>
                {order.map((name, i) => (
                  <div
                    key={name}
                    draggable={!orderBusy}
                    className={[
                      css.diagRow,
                      dragIndex === i ? css.dragging : '',
                      dragOverIndex === i ? css.dragOver : '',
                    ].filter(Boolean).join(' ')}
                    onDragStart={onRowDragStart(i)}
                    onDragOver={onRowDragOver(i)}
                    onDragLeave={onRowDragLeave(i)}
                    onDrop={onRowDrop(i)}
                    onDragEnd={onRowDragEnd}
                  >
                    <span className={css.dragHandle} aria-label={t('orderDrag')} title={t('orderDrag')}>⠿</span>
                    <span className={css.diagIndex}>{i + 1}</span>
                    <span className={css.nm}>{name}</span>
                    <span className={css.grow} />
                    <Button
                      variant="ghost"
                      size="sm"
                      draggable={false}
                      aria-label={t('orderUp')}
                      disabled={i === 0 || orderBusy}
                      onClick={() => moveBundle(i, -1)}
                    >{t('orderUp')}</Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      draggable={false}
                      aria-label={t('orderDown')}
                      disabled={i >= order.length - 1 || orderBusy}
                      onClick={() => moveBundle(i, 1)}
                    >{t('orderDown')}</Button>
                  </div>
                ))}
              </div>
            )}
      </CollapsibleSection>

      {/* issue #98 phase 3: snapshots & rollback / plugin presets */}
      <CollapsibleSection title={t('snapSection')} open={snapOpen} onToggle={() => setSnapOpen(o => !o)}>
        <SnapshotPanel t={t} open={snapOpen} onRefresh={refresh} />
      </CollapsibleSection>

      <CollapsibleSection title={t('presetSection')} open={presetOpen} onToggle={() => setPresetOpen(o => !o)}>
        <PresetPanel t={t} open={presetOpen} bundleOrder={communityNames} onRefresh={refresh} />
      </CollapsibleSection>
    </div>
  )
}
