/**
 * Diagnostics sub-panel — issue #98 phase 3 (plugin presets).
 *
 * Rendered at the bottom of the Diagnostics tab inside a collapsible section
 * (the parent keeps it mounted and passes `open`, so it lazy-loads on first
 * expand and keeps its state across collapses). Lists named presets
 * (GET /dsh-market/presets), saves the current community bundle order as a
 * new preset (POST /dsh-market/presets {action:'save', name, bundleOrder,
 * disabled}), applies one (action:'apply' — the host trial-validates and
 * auto-snapshots before writing; on success the parent refreshes the check
 * report) and deletes one after an inline double confirmation
 * (action:'delete').
 *
 * The list payload is read defensively (bare array or {presets: [...]}).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Market.module.css'
import type { Translate } from './market-data.ts'

/** One preset from GET /dsh-market/presets. */
export interface Preset {
  name: string
  bundleOrder: string[]
  disabled: string[]
}

interface PresetPanelProps {
  t: Translate
  /** True while the parent collapsible section is expanded (lazy-load gate). */
  open: boolean
  /** Current community bundle order (the Diagnostics ordering DRAFT — what the
   * user is editing, not necessarily the last-applied order); saved verbatim. */
  bundleOrder: string[]
  /** Re-fetch the check report after a successful preset apply. */
  onRefresh: () => void
}

interface JsonBody {
  ok?: unknown
  error?: unknown
  changes?: unknown
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: JsonBody | null }> {
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    return { status: 0, body: null }
  }
  let payload: JsonBody | null = null
  try { payload = (await res.json()) as JsonBody } catch { /* non-JSON body */ }
  return { status: res.status, body: payload }
}

const errorText = (status: number, body: JsonBody | null, fallback: string): string =>
  body !== null && typeof body.error === 'string'
    ? body.error
    : status === 0 ? fallback + 'network error' : fallback + `HTTP ${String(status)}`

export function PresetPanel(props: PresetPanelProps) {
  const { t, open, bundleOrder, onRefresh } = props
  const [presets, setPresets] = useState<Preset[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [name, setName] = useState('')
  /** Preset name awaiting the second confirm click, or null. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  /** Hidden <input type="file"> for the import action. */
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const loaded = useRef(false)

  const load = useCallback(() => {
    fetch('/dsh-market/presets', { cache: 'no-store' })
      .then(res => res.json())
      .then(body => {
        const list: unknown[] = Array.isArray(body) ? body : Array.isArray(body.presets) ? body.presets : []
        setPresets(list.map((item: unknown) => {
          const preset = (item ?? {}) as Preset
          return {
            name: String(preset.name ?? ''),
            bundleOrder: Array.isArray(preset.bundleOrder) ? preset.bundleOrder.map(String) : [],
            disabled: Array.isArray(preset.disabled) ? preset.disabled.map(String) : [],
          }
        }))
        setError(null)
        // Mark loaded only on success so a transient failure retries on the
        // next expand (review M3).
        loaded.current = true
      })
      .catch(() => setError(t('presetListFail') + 'network'))
  }, [t])

  useEffect(() => {
    if (open && !loaded.current) {
      load()
    }
  }, [open, load])

  const save = useCallback(() => {
    const presetName = name.trim()
    if (presetName === '') {
      setError(t('presetNameEmpty'))
      return
    }
    if (busy !== null) return
    setBusy('save')
    setMsg(null)
    setError(null)
    // Save the CURRENT disable list too — applying a preset restores it, so
    // saving an empty list would silently re-enable every disabled plugin.
    fetch('/dsh-market/installed', { cache: 'no-store' })
      .then(res => res.json())
      .then((installed: { disabled?: unknown }) => postJson('/dsh-market/presets', {
        action: 'save',
        name: presetName,
        bundleOrder,
        disabled: Array.isArray(installed.disabled) ? installed.disabled.map(String) : [],
      }))
      .then(({ status, body }) => {
        if (status >= 200 && status < 300 && body?.ok === true) {
          setName('')
          setMsg(t('presetSaved'))
          load()
        } else {
          setError(errorText(status, body, t('presetFail')))
        }
      })
      .catch(() => setError(t('presetFail') + 'network'))
      .finally(() => setBusy(null))
  }, [busy, bundleOrder, load, name, t])

  const apply = useCallback((presetName: string) => {
    if (busy !== null) return
    setBusy('apply')
    setMsg(null)
    setError(null)
    postJson('/dsh-market/presets', { action: 'apply', name: presetName })
      .then(({ status, body }) => {
        if (status >= 200 && status < 300 && body?.ok === true) {
          setMsg(t('presetApplied'))
          onRefresh()
        } else {
          setError(errorText(status, body, t('presetFail')))
        }
      })
      .catch(() => setError(t('presetFail') + 'network'))
      .finally(() => setBusy(null))
  }, [busy, onRefresh, t])

  const remove = useCallback((presetName: string) => {
    if (busy !== null) return
    setBusy('delete')
    setMsg(null)
    setError(null)
    postJson('/dsh-market/presets', { action: 'delete', name: presetName })
      .then(({ status, body }) => {
        if (status >= 200 && status < 300 && body?.ok === true) {
          setConfirmDelete(null)
          setMsg(t('presetDeleted'))
          load()
        } else {
          setError(errorText(status, body, t('presetFail')))
        }
      })
      .catch(() => setError(t('presetFail') + 'network'))
      .finally(() => setBusy(null))
  }, [busy, load, t])

  /**
   * Export the preset list as a downloadable JSON file
   * (GET /dsh-market/presets-export). Prefers the server's
   * Content-Disposition filename and falls back to a fixed name.
   */
  const exportPresets = useCallback(() => {
    if (busy !== null) return
    setBusy('export')
    setMsg(null)
    setError(null)
    fetch('/dsh-market/presets-export', { cache: 'no-store' })
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
        let filename = 'dsh-market-presets.json'
        const disposition = res.headers.get('content-disposition')
        if (disposition !== null) {
          const match = /filename="?([^";]+)"?/.exec(disposition)
          if (match !== null && match[1] !== undefined && match[1] !== '') filename = match[1]
        }
        return { blob: await res.blob(), filename }
      })
      .then(({ blob, filename }) => {
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 2000)
        setMsg(t('presetExported'))
      })
      .catch(err => setError(t('presetExportFail') + (err instanceof Error ? err.message : String(err))))
      .finally(() => setBusy(null))
  }, [busy, t])

  /** Import a preset JSON file (POST /dsh-market/presets-import, raw JSON body). */
  const importPresets = useCallback((file: File) => {
    if (busy !== null) return
    setBusy('import')
    setMsg(null)
    setError(null)
    file.text()
      .then(text => {
        let payload: unknown
        try {
          payload = JSON.parse(text)
        } catch {
          setError(t('presetImportFail') + t('presetImportBadJson'))
          setBusy(null)
          return null
        }
        return postJson('/dsh-market/presets-import', payload)
      })
      .then(result => {
        if (result === null) return
        const { status, body } = result
        if (status >= 200 && status < 300 && body?.ok === true) {
          // The host reports imported/added/updated/skipped counts — surface
          // them in the success message when present.
          const counts = body as { imported?: unknown; added?: unknown; updated?: unknown; skipped?: unknown }
          const imported = typeof counts.imported === 'number' ? counts.imported : null
          if (imported !== null) {
            const added = typeof counts.added === 'number' ? counts.added : 0
            const updated = typeof counts.updated === 'number' ? counts.updated : 0
            const skipped = typeof counts.skipped === 'number' ? counts.skipped : 0
            setMsg(t('presetImportedCount')
              .replace('{0}', String(imported))
              .replace('{1}', String(added))
              .replace('{2}', String(updated))
              .replace('{3}', String(skipped)))
          } else {
            setMsg(t('presetImported'))
          }
          load()
        } else {
          setError(errorText(status, body, t('presetImportFail')))
        }
      })
      .catch(() => setError(t('presetImportFail') + 'network'))
      .finally(() => setBusy(null))
  }, [busy, load, t])

  /** Change preview of one preset: {reordered[], enabled[], disabled[], noop}. */
  const [previewed, setPreviewed] = useState<{ name: string; changes: { reordered: string[]; enabled: string[]; disabled: string[]; noop: boolean } } | null>(null)
  const preview = useCallback((presetName: string) => {
    if (busy !== null) return
    setBusy('preview')
    setMsg(null)
    setError(null)
    if (previewed?.name === presetName) {
      setPreviewed(null)
      setBusy(null)
      return
    }
    postJson('/dsh-market/presets', { action: 'preview', name: presetName })
      .then(({ status, body }) => {
        if (status >= 200 && status < 300 && body?.ok === true && body.changes !== null && typeof body.changes === 'object') {
          const changes = body.changes as { reordered?: unknown; enabled?: unknown; disabled?: unknown; noop?: unknown }
          setPreviewed({
            name: presetName,
            changes: {
              reordered: Array.isArray(changes.reordered) ? changes.reordered.map(String) : [],
              enabled: Array.isArray(changes.enabled) ? changes.enabled.map(String) : [],
              disabled: Array.isArray(changes.disabled) ? changes.disabled.map(String) : [],
              noop: changes.noop === true,
            },
          })
        } else {
          setError(errorText(status, body, t('presetPreviewFail')))
        }
      })
      .catch(() => setError(t('presetPreviewFail') + 'network'))
      .finally(() => setBusy(null))
  }, [busy, previewed, t])

  return (
    <div className={css.orderPanel}>
      <p className={css.panelNote}>{t('presetHint')}</p>

      <div className={css.panelActions}>
        <Input
          className={css.inlineInput}
          placeholder={t('presetName')}
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save() }}
        />
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={save}>
          {busy === 'save' ? t('presetSaving') : t('presetSave')}
        </Button>
      </div>

      <div className={css.panelActions}>
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={exportPresets}>
          {busy === 'export' ? t('presetExporting') : t('presetExport')}
        </Button>
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => fileInputRef.current?.click()}>
          {busy === 'import' ? t('presetImporting') : t('presetImport')}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className={css.hiddenFile}
          tabIndex={-1}
          aria-hidden="true"
          onChange={event => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file !== undefined) importPresets(file)
          }}
        />
      </div>

      {error !== null && <div className={css.err}>{error}</div>}

      {presets === null || presets.length === 0
        ? <div className={css.diagEmpty}>{t('presetEmpty')}</div>
        : (
            <div className={css.presetList}>
              {presets.map(preset => (
                <div key={preset.name} className={css.presetRow}>
                  <div className={css.confirmRow}>
                    <span className={css.presetName}>{preset.name}</span>
                    {preset.bundleOrder.length > 0 && (
                      <span className={css.spec}>{t('presetBundleCount').replace('{0}', String(preset.bundleOrder.length))}</span>
                    )}
                    <span className={css.grow} />
                    {confirmDelete === preset.name ? (
                      <span className={css.confirmRow}>
                        <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => remove(preset.name)}>{t('presetDelete')}</Button>
                        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmDelete(null)}>{t('cancel')}</Button>
                      </span>
                    ) : (
                      <span className={css.confirmRow}>
                        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => apply(preset.name)}>{t('presetApply')}</Button>
                        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => preview(preset.name)}>
                          {previewed?.name === preset.name ? t('cancel') : t('presetPreview')}
                        </Button>
                        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmDelete(preset.name)}>{t('presetDelete')}</Button>
                      </span>
                    )}
                  </div>
                  {previewed?.name === preset.name && (
                    <div className={css.diagList}>
                      <span className={css.diagKey}>{t('presetPreviewTitle')}</span>
                      {previewed.changes.noop
                        ? <div className={css.spec}>{t('presetNoop')}</div>
                        : (
                            <div className={css.spec}>
                              {previewed.changes.reordered.length > 0
                                && <div className={css.warnLine}>{t('presetReorder').replace('{0}', String(previewed.changes.reordered.length))}: {previewed.changes.reordered.join(', ')}</div>}
                              {previewed.changes.enabled.length > 0
                                && <div className={css.warnLine}>{t('presetEnable').replace('{0}', String(previewed.changes.enabled.length))}: {previewed.changes.enabled.join(', ')}</div>}
                              {previewed.changes.disabled.length > 0
                                && <div className={css.warnLine}>{t('presetDisable').replace('{0}', String(previewed.changes.disabled.length))}: {previewed.changes.disabled.join(', ')}</div>}
                            </div>
                          )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

      {msg !== null && <div className={css.okState}>{msg}</div>}
    </div>
  )
}
