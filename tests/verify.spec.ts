/**
 * P0-2 activation verification: what "installed" means for a package —
 * live (hot-mounted) / restart (bundle layer, not live) / inert (never a
 * profile-layer plugin) / broken (validation failure) / missing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { profileDir } from '../src/profile.ts'
import { verifyActivation } from '../src/verify.ts'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshm-verify-'))
  process.env.DSH_HOME = home
})
afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

function profile(bundles: string[]): string {
  const dir = profileDir('web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles } } }))
  return dir
}

function pkg(name: string, manifest: unknown, files: Record<string, string> = {}): void {
  const root = join(profileDir('web'), 'node_modules', name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
}

const SIMPLE_PATCH = '- insert:\n  - id: \'x\'\n    name: \'y\'\n'
const COMPLEX_PATCH = '- insert:\n  - id: \'x\'\n    name: \'y\'\n- config:\n    foo: bar\n'

describe('verifyActivation (P0-2)', () => {
  it('missing package', () => {
    profile([])
    expect(verifyActivation('web', 'ghost', new Set())).toMatchObject({ state: 'missing' })
  })

  it('live when hot-mounted — bundle patch or client-only shim', () => {
    profile(['dsh-loop'])
    pkg('dsh-loop', { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'index.js' }, { 'index.js': '', 'cordis.patch.yml': SIMPLE_PATCH })
    expect(verifyActivation('web', 'dsh-loop', new Set(['dsh-loop']))).toMatchObject({ state: 'live', hot: true, bundle: true })

    pkg('client-a', { dsh: { client: {} }, main: 'index.js' }, { 'index.js': '' })
    expect(verifyActivation('web', 'client-a', new Set(['client-a']))).toMatchObject({ state: 'live', hot: true, bundle: false })
  })

  it('restart when in bundles but not live, with the patch reason', () => {
    profile(['dsh-loop'])
    pkg('dsh-loop', { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'index.js' }, { 'index.js': '', 'cordis.patch.yml': COMPLEX_PATCH })
    const result = verifyActivation('web', 'dsh-loop', new Set())
    expect(result).toMatchObject({ state: 'restart', hot: false, bundle: true })
    expect(result.reasons.join(' ')).toMatch(/纯 insert|plain inserts/)
  })

  it('inert when never a profile-layer plugin — client-only', () => {
    profile([])
    pkg('client-a', { dsh: { client: {} }, main: 'index.js' }, { 'index.js': '' })
    const result = verifyActivation('web', 'client-a', new Set())
    expect(result).toMatchObject({ state: 'inert', hot: false, bundle: false })
    expect(result.reasons.join(' ')).toMatch(/dsh\.bundle/)
  })

  it('inert when installed as a plain dependency (no dsh.bundle, no dsh.client)', () => {
    profile([])
    pkg('plain-dep', { dsh: {}, main: 'index.js' }, { 'index.js': '' })
    expect(verifyActivation('web', 'plain-dep', new Set())).toMatchObject({ state: 'inert', bundle: false })
  })

  it('broken when the dsh surface or the entry artifact is missing', () => {
    profile(['junk-a'])
    pkg('junk-a', { main: 'index.js' }, { 'index.js': '' })
    expect(verifyActivation('web', 'junk-a', new Set())).toMatchObject({ state: 'broken' })

    pkg('junk-b', { dsh: {}, main: 'lib/index.js' })
    expect(verifyActivation('web', 'junk-b', new Set())).toMatchObject({ state: 'broken' })
  })

  it('a simple-patch bundle that failed to mount still reads as restart', () => {
    profile(['dsh-loop'])
    pkg('dsh-loop', { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'index.js' }, { 'index.js': '', 'cordis.patch.yml': SIMPLE_PATCH })
    expect(verifyActivation('web', 'dsh-loop', new Set())).toMatchObject({ state: 'restart', bundle: true })
  })

  it('live when the bundle entry name is a scoped subpath of the package (patch name ≠ package name)', () => {
    profile(['@vectorize-io/hindsight-coding-agents'])
    pkg('@vectorize-io/hindsight-coding-agents',
      { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'index.js' },
      { 'index.js': '', 'cordis.patch.yml': SIMPLE_PATCH })
    // liveNames() reports loader entry names — the patch's `name:` field, which
    // may be a subpath (`@vectorize-io/hindsight-coding-agents/dsh`) rather than
    // the bare package name. The fiber being up must still read as live.
    expect(verifyActivation('web', '@vectorize-io/hindsight-coding-agents',
      new Set(['@vectorize-io/hindsight-coding-agents/dsh']))).toMatchObject({ state: 'live', hot: true, bundle: true })
  })

  it('live when the bundle entry name is an unscoped subpath of the package (e.g. aegis)', () => {
    profile(['aegis'])
    pkg('aegis',
      { dsh: { bundle: { patch: './extensions/dsh/cordis.patch.yml' } }, main: 'index.js' },
      { 'index.js': '' })
    expect(verifyActivation('web', 'aegis', new Set(['aegis/extensions/dsh/index.js']))).toMatchObject({ state: 'live', hot: true, bundle: true })
  })

  it('does not treat a similarly-prefixed different package as live', () => {
    profile(['dsh-loop'])
    pkg('dsh-loop', { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'index.js' }, { 'index.js': '', 'cordis.patch.yml': SIMPLE_PATCH })
    // 'dsh-loop-tool' is a distinct package; only an exact name or a real
    // `name/` subpath entry counts as the package being live.
    expect(verifyActivation('web', 'dsh-loop', new Set(['dsh-loop-tool']))).toMatchObject({ state: 'restart', bundle: true })
  })
})
