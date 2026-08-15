/**
 * WhaleHarness audit-verdict layer (host): case-insensitive owner/repo
 * matching with monorepo /tree/ fallback, plus the graceful-degradation
 * contract for loadAudit — unreachable / timeout / malformed payload must
 * always fall back to the bundled snapshot, never throw into the caller.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadAudit, verdictMap, verdictOf, type Audit } from '../src/audit.ts'

const entry = (repo: string, verdict: 'PASS' | 'REJECT' | 'UNEVALUATED') => ({ repo, verdict })
const auditOf = (...entries: Array<{ repo: string; verdict: 'PASS' | 'REJECT' | 'UNEVALUATED' }>): Audit => ({ entries })

describe('verdictOf (matching)', () => {
  it('matches owner/repo case-insensitively', () => {
    const audit = auditOf(entry('VLLN/Dsh-Navbar', 'PASS'))
    expect(verdictOf('https://github.com/vlln/dsh-navbar', audit)).toBe('PASS')
    expect(verdictOf('https://github.com/VLLN/Dsh-Navbar/', audit)).toBe('PASS')
  })

  it('falls back to the repo-level verdict for monorepo /tree/ subpaths', () => {
    const audit = auditOf(entry('m/mono', 'REJECT'))
    expect(verdictOf('https://github.com/m/mono/tree/main/packages/plug-a', audit)).toBe('REJECT')
  })

  it('returns null for repos missing from the audit, non-github urls, and null audit', () => {
    const audit = auditOf(entry('o/a', 'PASS'))
    expect(verdictOf('https://github.com/o/other', audit)).toBeNull()
    expect(verdictOf('https://gitlab.com/o/a', audit)).toBeNull()
    expect(verdictOf('nonsense', audit)).toBeNull()
    expect(verdictOf('https://github.com/o/a', null)).toBeNull()
  })
})

describe('verdictMap (client payload)', () => {
  it('keys verdicts by lowercased owner/repo', () => {
    expect(verdictMap(auditOf(entry('O/R', 'PASS')))).toEqual({ 'o/r': 'PASS' })
  })
})

describe('loadAudit (graceful degradation)', () => {
  afterEach(() => vi.unstubAllGlobals())

  async function freshLoadAudit() {
    // The module caches its live payload in module scope; reset so each
    // scenario starts from a cold cache.
    vi.resetModules()
    return (await import('../src/audit.ts')).loadAudit
  }

  it('falls back to the bundled snapshot when the network fails', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('network down')))
    const load = await freshLoadAudit()
    const r = await load()
    expect(r.source).toBe('snapshot')
    expect(Array.isArray(r.audit.entries)).toBe(true)
    expect(r.audit.entries.length).toBeGreaterThan(0)
  })

  it('falls back when the payload is malformed (entries not an array)', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ nope: true }), { status: 200 })))
    const load = await freshLoadAudit()
    const r = await load()
    expect(r.source).toBe('snapshot')
    expect(Array.isArray(r.audit.entries)).toBe(true)
  })

  it('returns live data on a healthy response', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(
      JSON.stringify({ entries: [entry('o/a', 'PASS')] }), { status: 200 },
    )))
    const load = await freshLoadAudit()
    const r = await load()
    expect(r.source).toBe('live')
    expect(r.audit.entries).toHaveLength(1)
  })
})
