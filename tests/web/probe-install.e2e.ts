// Not a regression test: skipped unless PROBE_NPM is set. Installs the named npm packages one by one through the
// market on a real host and writes what happened to PROBE_OUT (feeds site/install-tests.json and the /tested/ page).
import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { dshAvailable, launchMarketScaffold } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

const PROBE_SNAPSHOT = 'data/registry-snapshot.json'
const names = (process.env.PROBE_NPM ?? '').split(',').filter(Boolean)

/**
 * The catalog a probe installs from. It is a DOWNLOAD, not a committed file
 * (#545), so a fresh checkout does not have it — reading it at module scope
 * made this file throw on import, which failed the whole web-e2e lane on every
 * run whether or not a probe was asked for. Only a run that was asked for needs
 * it, and such a run should hear why it cannot start rather than skip quietly.
 */
function probeCatalog(): { npm?: string; url: string; version: string }[] {
  if (!existsSync(PROBE_SNAPSHOT)) {
    throw new Error(`PROBE_NPM is set but ${PROBE_SNAPSHOT} is missing: it is downloaded, never committed (#545). Run \`npm run snapshot\` first.`)
  }
  const snap = JSON.parse(readFileSync(PROBE_SNAPSHOT, 'utf8'))
  return snap.plugins ?? snap
}

describe.skipIf(!dshAvailable() || names.length === 0).sequential('probe', () => {
  let s: WebScaffold
  let all: { npm?: string; url: string; version: string }[]
  beforeAll(async () => {
    all = probeCatalog()
    s = await launchMarketScaffold({ localCatalog: false })
  }, 600_000)
  afterAll(async () => { await s?.close() })
  it('installs each', async () => {
    const out: unknown[] = []
    for (const npm of names) {
      const p = all.find(x => x.npm === npm)!
      const t0 = Date.now()
      let r: Response; try { r = await s.api('/dsh-market/install', { method: 'POST', headers: { 'content-type': 'application/json', origin: s.baseUrl }, body: JSON.stringify({ url: p.url }) }) } catch (e) { out.push({ npm, ok: false, status: 0, error: 'no answer within 5 minutes: ' + String(e) }); writeFileSync(process.env.PROBE_OUT ?? '/tmp/probe-out/result.json', JSON.stringify(out, null, 1)); continue }
      const body = await r.text()
      for (let i = 0; i < 90; i++) {
        const st = await (await s.api('/dsh-market/status')).json() as { busy?: boolean; active?: boolean }
        if (!st.busy && !st.active) break
        await new Promise(d => setTimeout(d, 2000))
      }
      if (r.status !== 200) writeFileSync(`/tmp/probe-out/log-${npm.replace(/\W/g,'_')}.txt`, await (await s.api('/dsh-market/logs')).text())
      const secs = Math.round((Date.now() - t0) / 1000)
      const inst = await (await s.api('/dsh-market/installed')).json() as { activation?: Record<string, unknown> }
      let sizeKB: number | null = null; let deps: number | null = null; let peer: unknown = null; let installed: string | null = null
      try {
        const dir = join(s.home, 'profiles/web/node_modules', npm)
        sizeKB = Number(execSync(`du -sk ${JSON.stringify(dir + '/')}`).toString().split('\t')[0])
        const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        installed = pj.version; deps = Object.keys(pj.dependencies ?? {}).length; peer = pj.peerDependencies ?? null
      } catch {}
      const act = inst.activation?.[npm] as { state?: string; reasons?: string[] } | undefined
      out.push({ npm, catalogVersion: p.version, installed, ok: r.status === 200, secs, state: act?.state ?? null, reasons: act?.reasons ?? [], sizeKB, deps, peer, status: r.status, error: r.status === 200 ? null : body.slice(0, 400) })
      writeFileSync(process.env.PROBE_OUT ?? '/tmp/probe-out/result.json', JSON.stringify(out, null, 1))
    }
  }, 3_000_000)
})
