/**
 * The recovery surface behind a restart that did not come back.
 *
 * The behaviour under test: one plugin that cannot load takes the whole DSH
 * process with it, so the tab that clicked restart is left polling an origin
 * nobody answers — and the only way back used to be hand-editing
 * cordis.patch.yml. Everything here exists so that prompt offers "adjust
 * plugins" instead.
 *
 * The log shapes in these fixtures are verbatim from
 * @deepseek-ai/dsh-app-boot's assertEntriesLoaded / assertEntriesActivated
 * and the CLI's fail-loud handler, because a parser tested against invented
 * output is a parser that will not match the real one.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyRecovery, matchFailureToPlugins, parseBootFailure, recoveryPayload,
  respawnAndWatch, runRecovery, startRecoveryServer, type RecoveryConfig, type RecoveryPlugin,
} from '../src/recovery.ts'
import { restartHelperSource } from '../src/restart.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const done of cleanups.splice(0)) await done()
})

/** Poll until the predicate holds, or give up — never a bare sleep. */
async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return predicate()
}

/** Occupy a port the way the outgoing DSH does, and hand back a release. */
async function hold(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = createServer(socket => socket.end())
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  let closed = false
  const release = async (): Promise<void> => {
    if (closed) return
    closed = true
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  cleanups.push(release)
  return { port, release }
}

/** A profile directory with a manifest and the dsh patch template. */
function makeProfile(): { dir: string; patchPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-recovery-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'web',
    dependencies: { 'good-plugin': '1.0.0', 'blamed-plugin': '1.0.0', 'carrier-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['good-plugin', 'carrier-plugin'] } },
  }, null, 2))
  const patchPath = join(dir, 'cordis.patch.yml')
  writeFileSync(patchPath, '# dsh profile root\n[]\n')
  return { dir, patchPath }
}

function makePlugin(name: string, overrides: Partial<RecoveryPlugin> = {}): RecoveryPlugin {
  return {
    name,
    rows: [name],
    enabled: true,
    protected: false,
    carrier: false,
    toggleable: true,
    ...overrides,
  }
}

function makeConfig(dir: string, patchPath: string, plugins: RecoveryPlugin[]): RecoveryConfig {
  return {
    port: null,
    profile: 'web',
    profileDir: dir,
    patchPath,
    bootId: '4242-1700000000000',
    marketVersion: '1.46.1',
    scheduledAt: '2026-09-13T10:00:00.000Z',
    logs: { out: join(dir, 'out.log'), err: join(dir, 'err.log') },
    spawn: { file: process.execPath, args: ['-e', 'process.exit(1)'], viaShell: false, detached: false },
    cwd: dir,
    plugins,
  }
}

/** The CLI's own fail-loud output for a tree with two bad entries. */
const TWO_ENTRIES_FAILED = [
  'dsh: fatal load failure: Error: dsh: plugin tree failed to load: dsh: 2 entries did not activate',
  "blamed-plugin: Error: Cannot find module 'left-pad'",
  '    at Module._resolveFilename (node:internal/modules/cjs/loader:1215:15)',
  '    at file:///D:/dsh/profiles/web/node_modules/blamed-plugin/index.js:3:1',
  'needs-service: pending (waiting for service: nonexistent)',
  '    at Fiber.<anonymous> (file:///D:/dsh/node_modules/@deepseek-ai/cordis/lib/index.js:100:5)',
  '',
  '[dsh-market] the replacement never came up on port 3080 (it exited with code 1)',
].join('\n')

/** The shape a REAL composition produced (captured from a live dsh web run). */
const REAL_INCLUDE_APPLY_FAILURE = [
  "Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to apply loader entry dsh-demo-broken (dsh-demo-broken-plugin): dsh-demo-broken-plugin: deliberate activation failure (mode=activate) — on the recovery page, untick this plugin and press save-and-restart",
  "Error: dsh-demo-broken-plugin: deliberate activation failure (mode=activate) — on the recovery page, untick this plugin and press save-and-restart",
  '    at new apply (file:///C:/Users/x/AppData/Local/Temp/dsh-market-demo/profiles/web/node_modules/dsh-demo-broken-plugin/index.js:43:9)',
  '    at Fiber.execute (file:///D:/dsh/node_modules/@deepseek-ai/cordis/lib/index.js:1067:24)',
  'Node.js v24.19.0',
].join('\n')

describe('parseBootFailure', () => {
  it('reads the include-apply chain a real composition produces', () => {
    // Found by running the demo against a real harness: the profile's tree
    // hangs off ONE include entry, so an activation failure arrives as an
    // apply chain, never as the audit's "entries did not activate" list. The
    // parser shipped without this shape would have shown no red plugin at all
    // in the most common real failure — which is exactly what the demo caught.
    const failure = parseBootFailure(REAL_INCLUDE_APPLY_FAILURE)
    expect(failure.entries).toHaveLength(1)
    expect(failure.entries[0]?.name).toBe('dsh-demo-broken-plugin')
    expect(failure.entries[0]?.reason).toContain('deliberate activation failure')
    // The wrapping levels (include, cordis:include) must not be blamed.
    expect(failure.entries.map(entry => entry.name)).not.toContain('cordis:include')
    expect(failure.summary).toBe('plugin entry failed to apply: dsh-demo-broken-plugin')
  })

  it('blames the innermost entry, not the include that carried it', () => {
    const text = 'failed to apply loader entry include (cordis:include): failed to apply loader entry other-row (other-plugin): boom'
    expect(parseBootFailure(text).entries.map(entry => entry.name)).toEqual(['other-plugin'])
  })

  it('names every entry the activation audit reported, with its kind', () => {
    const failure = parseBootFailure(TWO_ENTRIES_FAILED)
    expect(failure.entries).toEqual([
      { name: 'blamed-plugin', reason: "Error: Cannot find module 'left-pad'", kind: 'failed' },
      { name: 'needs-service', reason: 'pending (waiting for service: nonexistent)', kind: 'pending' },
    ])
    expect(failure.summary).toContain('2 plugin entries did not activate')
    expect(failure.summary).toContain('blamed-plugin')
    // The stack belongs to the tail the user can read, not to the entry list.
    expect(failure.tail).toContain('Module._resolveFilename')
  })

  it('reads the unresolved-module shape, which names plugins on one line', () => {
    const text = [
      'dsh: fatal load failure: Error: dsh: plugin tree failed to load: dsh: plugin(s) failed to load: alpha, @scope/beta; Cordis startup failed because these plugin(s) could not be resolved (see the error(s) logged above)',
      '    at boot (file:///D:/dsh/lib/profile-boot.js:1:1)',
    ].join('\n')
    const failure = parseBootFailure(text)
    expect(failure.entries.map(entry => entry.name)).toEqual(['alpha', '@scope/beta'])
    expect(failure.entries.every(entry => entry.kind === 'unresolved')).toBe(true)
  })

  it('parses the NEWEST failure when the log holds more than one', () => {
    // A recovery restart that fails again appends to the same file: the first
    // failure is history, and reporting it would tell the user to switch off a
    // plugin that is already off.
    const text = [
      'dsh: fatal load failure: Error: dsh: 1 entry did not activate',
      'first-plugin: Error: boom',
      '    at x',
      '[dsh-market recovery] the replacement failed again',
      'dsh: fatal load failure: Error: dsh: 1 entry did not activate',
      'second-plugin: Error: bang',
      '    at y',
    ].join('\n')
    expect(parseBootFailure(text).entries.map(entry => entry.name)).toEqual(['second-plugin'])
  })

  it('degrades to the log tail when nothing recognizable is there', () => {
    const failure = parseBootFailure('Error: listen EADDRINUSE: address already in use 127.0.0.1:3080\n')
    expect(failure.entries).toEqual([])
    expect(failure.summary).toContain('EADDRINUSE')
  })
})

describe('matchFailureToPlugins', () => {
  it('matches package names, row ids, and loader paths — and reports the rest', () => {
    const plugins = [
      makePlugin('@scope/two'),
      makePlugin('row-owner', { rows: ['custom-row'] }),
      makePlugin('three'),
    ]
    const failure = parseBootFailure([
      'dsh: 4 entries did not activate',
      '@scope/two: Error: boom',
      'custom-row: Error: boom',
      'file:///D:/dsh/profiles/web/three/index.js: Error: boom',
      'ghost: Error: boom',
    ].join('\n'))
    const { implicated, unmatched } = matchFailureToPlugins(plugins, failure)
    expect([...implicated].sort()).toEqual(['@scope/two', 'row-owner', 'three'])
    expect(unmatched.map(entry => entry.name)).toEqual(['ghost'])
  })
})

describe('applyRecovery', () => {
  it('switches plugins through the patch layer the loader re-applies at every boot', async () => {
    const { dir, patchPath } = makeProfile()
    const config = makeConfig(dir, patchPath, [
      makePlugin('good-plugin'),
      makePlugin('blamed-plugin'),
    ])
    const result = await applyRecovery(config, ['good-plugin'])
    expect(result.ok).toBe(true)
    expect(result.changes).toEqual([{ name: 'blamed-plugin', from: true, to: false }])
    const written = readFileSync(patchPath, 'utf8')
    expect(written).toContain('- id: blamed-plugin')
    expect(written).toContain('  disabled: true')
    // The plugin the user kept is not written at all: an untouched switch
    // leaves no trace, which is what makes the file readable afterwards.
    expect(written).not.toContain('good-plugin')
  })

  it('re-enables through the same layer, so an undo is a real undo', async () => {
    const { dir, patchPath } = makeProfile()
    writeFileSync(patchPath, '# dsh profile root\n# []\n- id: blamed-plugin\n  disabled: true\n')
    const config = makeConfig(dir, patchPath, [makePlugin('blamed-plugin', { enabled: false })])
    const result = await applyRecovery(config, ['blamed-plugin'])
    expect(result.ok).toBe(true)
    const written = readFileSync(patchPath, 'utf8')
    expect(written).not.toContain('disabled: true')
    expect(written).toContain('[]')
  })

  it('moves a disable-carrier out of the bundle stack too', async () => {
    const { dir, patchPath } = makeProfile()
    const config = makeConfig(dir, patchPath, [makePlugin('carrier-plugin', { carrier: true })])
    const result = await applyRecovery(config, [])
    expect(result.ok).toBe(true)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toEqual(['good-plugin'])
  })

  it('never touches host infrastructure, and says why instead', async () => {
    const { dir, patchPath } = makeProfile()
    const config = makeConfig(dir, patchPath, [
      makePlugin('@deepseek-ai/dsh-host-webserver', { protected: true, toggleable: false, rows: [] }),
    ])
    const result = await applyRecovery(config, [])
    expect(result.changes).toEqual([])
    expect(readFileSync(patchPath, 'utf8')).not.toContain('disabled: true')
  })
})

describe('startRecoveryServer', () => {
  /** Boot one surface on an ephemeral port and fetch against it. */
  async function serve(): Promise<{ base: string; config: RecoveryConfig; finished: Promise<unknown>; view: () => unknown }> {
    const { dir, patchPath } = makeProfile()
    const config = makeConfig(dir, patchPath, [
      makePlugin('blamed-plugin'),
      makePlugin('good-plugin'),
    ])
    const failure = parseBootFailure(TWO_ENTRIES_FAILED)
    const surface = await startRecoveryServer(config, failure, { port: 0, idleTimeoutMs: 60_000 })
    cleanups.push(() => surface.close())
    const base = 'http://127.0.0.1:' + String(surface.port)
    return {
      base,
      config,
      finished: surface.finished,
      view: () => recoveryPayload(config, failure),
    }
  }

  it('answers the market page in the shape it is already polling', async () => {
    const { base, config } = await serve()
    const status = await (await fetch(base + '/dsh-market/status')).json() as Record<string, unknown>
    // Same boot id on purpose: the page must NOT reload into this surface,
    // it must notice the failure and offer the way out.
    expect(status.boot).toBe(config.bootId)
    expect(status.recovery).toBe(true)
    expect((status.failure as { entries: string[] }).entries).toContain('blamed-plugin')
  })

  it('marks the blamed plugin in the payload the panel renders', async () => {
    const { base } = await serve()
    const body = await (await fetch(base + '/dsh-market/recovery')).json() as {
      plugins: Array<{ name: string; implicated: boolean; reason?: string }>
      unmatched: Array<{ name: string }>
      failure: { summary: string }
    }
    const blamed = body.plugins.find(plugin => plugin.name === 'blamed-plugin')
    expect(blamed?.implicated).toBe(true)
    expect(blamed?.reason).toContain('left-pad')
    expect(body.plugins.find(plugin => plugin.name === 'good-plugin')?.implicated).toBe(false)
    expect(body.unmatched.map(entry => entry.name)).toEqual(['needs-service'])
  })

  it('opens with the blamed plugins UNTICKED — the promise the prompt makes', async () => {
    // "The plugins DSH blamed are marked red and left unticked" is the
    // contract in the README and the copy. It used to be only half true: the
    // payload flagged them and every surface still ticked them, so the user
    // had to find and untick the red row themselves. The recommendation lives
    // in the payload so both surfaces inherit it from one place.
    const { base } = await serve()
    const body = await (await fetch(base + '/dsh-market/recovery')).json() as {
      plugins: Array<{ name: string; enabled: boolean; implicated: boolean; toggleable: boolean }>
    }
    const blamed = body.plugins.find(plugin => plugin.name === 'blamed-plugin')
    expect(blamed?.implicated).toBe(true)
    expect(blamed?.enabled, 'a blamed, switchable plugin must start unticked').toBe(false)
    expect(body.plugins.find(plugin => plugin.name === 'good-plugin')?.enabled).toBe(true)
  })

  it('leaves an untouchable plugin at its own state', async () => {
    // Nothing the user could do with another position: host infrastructure is
    // listed for context, not to be switched.
    const { base, config } = await serve()
    config.plugins.push({
      name: '@deepseek-ai/dsh-host-webserver', rows: [], enabled: true, protected: true,
      carrier: false, toggleable: false, note: 'host infrastructure',
    })
    const body = await (await fetch(base + '/dsh-market/recovery')).json() as {
      plugins: Array<{ name: string; enabled: boolean; toggleable: boolean }>
    }
    const hostRow = body.plugins.find(plugin => plugin.name === '@deepseek-ai/dsh-host-webserver')
    expect(hostRow?.toggleable).toBe(false)
    expect(hostRow?.enabled).toBe(true)
  })

  it('serves a standalone page for a fresh visit, with the same data', async () => {
    const { base } = await serve()
    const response = await fetch(base + '/', { headers: { 'accept-language': 'zh-CN,zh;q=0.9' } })
    const html = await response.text()
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(html).toContain('DeepSeek Harness 启动失败')
    expect(html).toContain('/dsh-market/recovery/apply')
  })

  it('exports the failing boot log, because that is what a report needs', async () => {
    const { base, config } = await serve()
    writeFileSync(config.logs.err, TWO_ENTRIES_FAILED)
    const response = await fetch(base + '/dsh-market/logs')
    expect(response.headers.get('content-type')).toContain('text/plain')
    const text = await response.text()
    expect(text).toContain('blamed-plugin')
    // The newlines are the structure; a sanitizer that flattened them would
    // hand the reporter one unreadable line.
    expect(text.split('\n').length).toBeGreaterThan(4)
    expect(text).toContain('## replacement host stderr')
  })

  it('refuses a cross-site write and accepts a same-origin one', async () => {
    const { base, finished } = await serve()
    const hostile = await fetch(base + '/dsh-market/recovery/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ enabled: [] }),
    })
    expect(hostile.status).toBe(403)

    const accepted = await fetch(base + '/dsh-market/recovery/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ enabled: ['good-plugin'] }),
    })
    expect(accepted.status).toBe(200)
    // The ticks travel with the decision: the writer is a different process.
    expect(await finished).toEqual({ kind: 'apply', enabled: ['good-plugin'] })
  })

  it('releases the port on request, so a manual dsh web start is not blocked', async () => {
    const { base, finished } = await serve()
    await fetch(base + '/dsh-market/recovery/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: '{}',
    })
    expect(await finished).toEqual({ kind: 'released' })
  })
})

describe('runRecovery', () => {
  it('comes back with the NEW failure when a written composition fails to boot too', async () => {
    // The whole point of the second round: the user's first guess was wrong,
    // and the surface that reappears has to describe the tree as it stands
    // now, not the tree they already changed.
    const { port, release } = await hold()
    // The surface has to BIND this port, so the stand-in host must let go of
    // it first — the same handover the helper performs for real.
    await release()
    const dir = mkdtempSync(join(tmpdir(), 'dshm-runrecovery-'))
    const patchPath = join(dir, 'cordis.patch.yml')
    writeFileSync(patchPath, '# dsh profile root\n[]\n')
    const errLog = join(dir, 'err.log')
    writeFileSync(errLog, TWO_ENTRIES_FAILED)
    const config = makeConfig(dir, patchPath, [makePlugin('blamed-plugin'), makePlugin('good-plugin')])
    config.port = port
    config.logs.err = errLog
    // A replacement that always dies: the loop's "failed again" path, with a
    // real spawn rather than a stub.
    config.spawn = { file: process.execPath, args: ['-e', 'process.exit(1)'], viaShell: false, detached: false }

    const running = runRecovery(config, { exitCode: 1, bound: false })
    const base = 'http://127.0.0.1:' + String(port)
    cleanups.push(async () => {
      await fetch(base + '/dsh-market/recovery/release', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: '{}',
      }).catch(() => undefined)
      await Promise.race([
        running.catch(() => 'released'),
        new Promise(resolve => setTimeout(resolve, 3000)),
      ])
    })

    /** Wait for the surface to answer, which it does once per failed attempt. */
    const waitForSurface = async (): Promise<boolean> => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        try {
          const response = await fetch(base + '/dsh-market/status', { cache: 'no-store' })
          if (response.ok) return true
        } catch { /* the port changes hands between attempts */ }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      return false
    }

    expect(await waitForSurface(), 'the recovery surface never came up').toBe(true)
    // Apply: the surface frees the port, boots the (failing) replacement, and
    // must come back rather than exiting on the user.
    await fetch(base + '/dsh-market/recovery/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ enabled: ['good-plugin'] }),
    }).catch(() => undefined)
    // A second surface answered on the same port after the failed boot.
    const answers: string[] = []
    const deadline = Date.now() + 40_000
    while (Date.now() < deadline) {
      try {
        const body = await (await fetch(base + '/dsh-market/recovery', { cache: 'no-store' })).json() as { failure?: { summary?: string } }
        if (typeof body.failure?.summary === 'string' && body.failure.summary !== '') {
          answers.push(body.failure.summary)
          break
        }
      } catch { /* between attempts */ }
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    expect(answers[0]).toContain('blamed-plugin')
    // And the choice was actually WRITTEN: runRecovery has to perform the
    // patch-layer write itself, because the surface only collects ticks.
    // Shipping without that made "save and restart" boot the same broken
    // composition again — the bug the demo plugin's run exposed.
    const written = readFileSync(patchPath, 'utf8')
    expect(written).toContain('- id: blamed-plugin')
    expect(written).toContain('  disabled: true')
    await fetch(base + '/dsh-market/recovery/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: '{}',
    }).catch(() => undefined)
    expect(await running).toBe('released')
  }, 90_000)
  it('comes back with the write errors instead of booting a partial choice', async () => {
    // A write that lands for some plugins and not others leaves the profile
    // as neither what the user asked for nor what it was. Booting that is
    // booting a guess, so the surface has to come back and say what failed.
    const { port, release } = await hold()
    await release()
    const dir = mkdtempSync(join(tmpdir(), 'dshm-partial-'))
    const patchPath = join(dir, 'cordis.patch.yml')
    writeFileSync(patchPath, '# dsh profile root\n[]\n')
    const mark = join(dir, 'booted.txt')
    const spawnScript = join(dir, 'replacement.cjs')
    writeFileSync(spawnScript, 'require("node:fs").writeFileSync(' + JSON.stringify(mark) + ', "booted")\n')
    // A row id the patch layer refuses (space + punctuation) is how a partial
    // write happens for real: the plugin is fine, its row is not writable.
    const config = makeConfig(dir, patchPath, [makePlugin('blamed-plugin', { rows: ['bad row!'] })])
    config.port = port
    config.spawn = { file: process.execPath, args: [spawnScript], viaShell: false, detached: false }
    const running = runRecovery(config, { exitCode: 1, bound: false })
    const base = 'http://127.0.0.1:' + String(port)
    cleanups.push(async () => {
      await fetch(base + '/dsh-market/recovery/release', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: '{}',
      }).catch(() => undefined)
      await Promise.race([running.catch(() => 'released'), new Promise(resolve => setTimeout(resolve, 3000))])
    })

    /** Poll the surface until it answers, or give up. */
    const readView = async (): Promise<{ lastErrors: string[] } | null> => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        try {
          const response = await fetch(base + '/dsh-market/recovery', { cache: 'no-store' })
          if (response.ok) return await response.json() as { lastErrors: string[] }
        } catch { /* not up yet */ }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      return null
    }

    const first = await readView()
    expect(first).not.toBeNull()
    await fetch(base + '/dsh-market/recovery/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ enabled: [] }),
    })

    // The surface returns — with the errors — and nothing was booted.
    const deadline = Date.now() + 30_000
    let errors: string[] = []
    while (Date.now() < deadline && errors.length === 0) {
      const view = await readView()
      errors = view?.lastErrors ?? []
      if (errors.length === 0) await new Promise(resolve => setTimeout(resolve, 200))
    }
    expect(errors.length, 'the write failure never reached the surface').toBeGreaterThan(0)
    expect(errors[0]).toContain('bad row!')
    expect(existsSync(mark), 'a partial write was booted anyway').toBe(false)
    await fetch(base + '/dsh-market/recovery/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: '{}',
    }).catch(() => undefined)
    expect(await running).toBe('released')
  }, 90_000)
})

describe('respawnAndWatch', () => {
  /** A replacement that binds the port, holds it, then dies like a failed boot. */
  function bootScript(dir: string, holdMs: number, dies: boolean): string {
    const script = join(dir, 'replacement.cjs')
    writeFileSync(script, [
      "const net = require('node:net')",
      "const fs = require('node:fs')",
      "const server = net.createServer(socket => socket.end())",
      "server.listen(Number(process.env.DSHM_PROBE_PORT), '127.0.0.1', () => {",
      "  fs.writeFileSync(process.env.DSHM_PROBE_PID, String(process.pid))",
      dies
        ? "  setTimeout(() => process.exit(1), " + String(holdMs) + ")"
        : '  // stays up',
      "})",
    ].join('\n'))
    return script
  }

  function configFor(dir: string, port: number, script: string, settleMs: number): RecoveryConfig {
    const config = makeConfig(dir, join(dir, 'cordis.patch.yml'), [makePlugin('blamed-plugin')])
    config.port = port
    config.settleMs = settleMs
    config.spawn = { file: process.execPath, args: [script], viaShell: false, detached: false }
    return config
  }

  it('does not call a boot up just because something bound the port', async () => {
    // The bug the demo plugin found: a boot that fails the activation audit
    // has already bound the web port when the audit runs, so the old check
    // said "booted" for a harness that was in the middle of dying.
    const { port, release } = await hold()
    await release()
    const dir = mkdtempSync(join(tmpdir(), 'dshm-settle-'))
    const pidFile = join(dir, 'pid.txt')
    const previous = { port: process.env.DSHM_PROBE_PORT, pid: process.env.DSHM_PROBE_PID }
    process.env.DSHM_PROBE_PORT = String(port)
    process.env.DSHM_PROBE_PID = pidFile
    cleanups.push(() => {
      if (previous.port === undefined) delete process.env.DSHM_PROBE_PORT
      else process.env.DSHM_PROBE_PORT = previous.port
      if (previous.pid === undefined) delete process.env.DSHM_PROBE_PID
      else process.env.DSHM_PROBE_PID = previous.pid
    })
    // Holds the port for 800ms, then exits: shorter than the settle window.
    const config = configFor(dir, port, bootScript(dir, 800, true), 2_000)
    expect(await respawnAndWatch(config)).toBe(false)
    expect(existsSync(pidFile), 'the fake replacement never ran').toBe(true)
  }, 30_000)

  it('calls it up once the port has answered steadily', async () => {
    const { port, release } = await hold()
    await release()
    const dir = mkdtempSync(join(tmpdir(), 'dshm-settle-ok-'))
    const pidFile = join(dir, 'pid.txt')
    const previous = { port: process.env.DSHM_PROBE_PORT, pid: process.env.DSHM_PROBE_PID }
    process.env.DSHM_PROBE_PORT = String(port)
    process.env.DSHM_PROBE_PID = pidFile
    cleanups.push(() => {
      if (existsSync(pidFile)) {
        try { process.kill(Number(readFileSync(pidFile, 'utf8'))) } catch { /* already gone */ }
      }
      if (previous.port === undefined) delete process.env.DSHM_PROBE_PORT
      else process.env.DSHM_PROBE_PORT = previous.port
      if (previous.pid === undefined) delete process.env.DSHM_PROBE_PID
      else process.env.DSHM_PROBE_PID = previous.pid
    })
    const config = configFor(dir, port, bootScript(dir, 0, false), 500)
    expect(await respawnAndWatch(config)).toBe(true)
  }, 30_000)
})

describe('restartHelperSource handoff', () => {
  it('starts the recovery surface when the replacement dies before it binds', async () => {
    const { port, release } = await hold()
    await release()
    const dir = mkdtempSync(join(tmpdir(), 'dshm-handoff-'))
    const errLog = join(dir, 'err.log')
    const configPath = join(dir, 'recovery.json')
    writeFileSync(configPath, '{}')
    // A stand-in recovery server: what matters here is that the helper starts
    // it, with the config and the facts, and does not wait for it.
    const script = join(dir, 'fixture-recovery.cjs')
    writeFileSync(script, [
      "const fs = require('node:fs')",
      'const argv = process.argv.slice(2)',
      "fs.writeFileSync(argv[0] + '.ran', JSON.stringify(argv))",
    ].join('\n'))

    const source = restartHelperSource(
      { file: process.execPath, args: ['-e', 'process.exit(1)'], viaShell: false, detached: false },
      { cwd: dir },
      { out: join(dir, 'out.log'), err: errLog },
      port,
      { script, config: configPath },
    )
    const child = spawn(process.execPath, ['-e', source], { stdio: 'ignore' })
    cleanups.push(() => { child.kill() })

    const ran = await until(() => existsSync(configPath + '.ran'), 20_000)
    expect(ran, 'a replacement that died left no recovery surface behind').toBe(true)
    const argv = JSON.parse(readFileSync(configPath + '.ran', 'utf8')) as string[]
    expect(argv[0]).toBe(configPath)
    expect(argv).toContain('--exit=1')
    expect(argv).toContain('--bound=0')
    const log = readFileSync(errLog, 'utf8')
    expect(log).toContain('never came up on port')
    expect(log).toContain('starting the recovery surface')
  }, 40_000)

  it('keeps the pre-recovery behaviour when no recovery script is available', async () => {
    const { port, release } = await hold()
    await release()
    const dir = mkdtempSync(join(tmpdir(), 'dshm-nohandoff-'))
    const errLog = join(dir, 'err.log')
    const source = restartHelperSource(
      { file: process.execPath, args: ['-e', 'process.exit(1)'], viaShell: false, detached: false },
      { cwd: dir },
      { out: join(dir, 'out.log'), err: errLog },
      port,
    )
    const child = spawn(process.execPath, ['-e', source], { stdio: 'ignore' })
    cleanups.push(() => { child.kill() })
    const wrote = await until(() => existsSync(errLog) && readFileSync(errLog, 'utf8').includes('never came up on port'), 20_000)
    expect(wrote).toBe(true)
    expect(readFileSync(errLog, 'utf8')).not.toContain('recovery surface')
  }, 40_000)
})
