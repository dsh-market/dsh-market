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

  it('disabled when the user switched it off — never "restart to apply"', () => {
    profile(['dsh-loop'])
    pkg('dsh-loop', { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'index.js' }, { 'index.js': '', 'cordis.patch.yml': SIMPLE_PATCH })
    // Even when the fiber is somehow still up, the disabled flag wins.
    const result = verifyActivation('web', 'dsh-loop', new Set(['dsh-loop']), undefined, true)
    expect(result).toMatchObject({ state: 'disabled', hot: false, bundle: true })
    expect(result.reasons.join(' ')).toMatch(/disabled|已停用/)

    // A client-only package switched off reads disabled too, not inert.
    pkg('client-a', { dsh: { client: {} }, main: 'index.js' }, { 'index.js': '' })
    expect(verifyActivation('web', 'client-a', new Set(), undefined, true)).toMatchObject({ state: 'disabled', bundle: false })
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

describe('carrier bundles (#103)', () => {
  // Real shape of @linxin666/dsh-skins 0.1.17: skin assets + a patch mounting
  // the skin center, no main/exports/index.js of its own.
  const CARRIER_PATCH = "- insert:\n    - id: ui-skin-center\n      name: '@linxin666/dsh-client-ui-skin-center'\n"

  it('is not broken when its patch mounts an installed package that has an entry', () => {
    profile(['@linxin666/dsh-skins'])
    pkg('@linxin666/dsh-skins', { dsh: { bundle: { patch: './cordis.patch.yml' } } }, {
      'cordis.patch.yml': CARRIER_PATCH,
      'skins/ocean.json': '{}',
    })
    pkg('@linxin666/dsh-client-ui-skin-center', { main: 'lib/index.js' }, { 'lib/index.js': '' })
    // Judged by its own artifact it looked like a source-only checkout and was
    // both flagged broken AND uninstalled by the #18 guard.
    expect(verifyActivation('web', '@linxin666/dsh-skins', new Set())).toMatchObject({ state: 'restart', bundle: true })
    expect(verifyActivation('web', '@linxin666/dsh-skins', new Set(['@linxin666/dsh-skins']))).toMatchObject({ state: 'live' })
  })

  it('stays broken when nothing it mounts is loadable — the #18 guard still bites', () => {
    profile(['@linxin666/dsh-skins'])
    pkg('@linxin666/dsh-skins', { dsh: { bundle: { patch: './cordis.patch.yml' } } }, { 'cordis.patch.yml': CARRIER_PATCH })
    // Target absent entirely (or present without an artifact) → still broken.
    expect(verifyActivation('web', '@linxin666/dsh-skins', new Set())).toMatchObject({ state: 'broken' })
    pkg('@linxin666/dsh-client-ui-skin-center', { main: 'lib/index.js' })
    expect(verifyActivation('web', '@linxin666/dsh-skins', new Set())).toMatchObject({ state: 'broken' })
  })

  it('a source-only checkout naming ONLY itself is still broken (no self-carrier loophole)', () => {
    profile(['dsh-unbuilt'])
    pkg('dsh-unbuilt', { main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }, {
      'cordis.patch.yml': "- insert:\n    - id: unbuilt\n      name: 'dsh-unbuilt'\n",
    })
    expect(verifyActivation('web', 'dsh-unbuilt', new Set())).toMatchObject({ state: 'broken' })
  })
})

describe('loader inventory beats manifest inference (#135)', () => {
  it('a live package with no dsh field is live, not broken', () => {
    // @deepseek-ai/dsh-tools is loaded by the official dsh-base patch and
    // carries no `dsh` field at all — "no manifest" never implied "never loads".
    profile([])
    pkg('@deepseek-ai/dsh-tools', { name: '@deepseek-ai/dsh-tools', main: 'lib/index.js' }, { 'lib/index.js': '' })
    expect(verifyActivation('web', '@deepseek-ai/dsh-tools', new Set(['@deepseek-ai/dsh-tools'])))
      .toMatchObject({ state: 'live', hot: true })
  })

  it('not live and no dsh field: inert as a plain dependency, broken only when listed as a bundle', () => {
    profile([])
    pkg('some-lib', { name: 'some-lib', main: 'i.js' }, { 'i.js': '' })
    expect(verifyActivation('web', 'some-lib', new Set())).toMatchObject({ state: 'inert', bundle: false })
    // Listed as a bundle but with no dsh surface — that IS a real defect.
    profile(['some-lib'])
    expect(verifyActivation('web', 'some-lib', new Set())).toMatchObject({ state: 'broken', bundle: true })
  })

  it('a live package still reads live when its entry artifact is missing', () => {
    // Running is running: an unbuilt checkout that the loader nonetheless has
    // up must not be reported as broken.
    profile(['half-built'])
    pkg('half-built', { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'lib/index.js' })
    expect(verifyActivation('web', 'half-built', new Set(['half-built']))).toMatchObject({ state: 'live' })
    expect(verifyActivation('web', 'half-built', new Set())).toMatchObject({ state: 'broken' })
  })
})
