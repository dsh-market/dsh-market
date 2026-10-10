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
import { brokenClientBundles, checkClientBundle, clientBundlePath, hostPeerGate, newlyBrokenBundles, verifyActivation } from '../src/verify.ts'

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

  /** #165: a plugin the user wired into their OWN cordis.patch.yml declares
   * nothing, is not hot-mounted until the next boot, and so read as `broken`
   * — the market said the install failed verification while the plugin was
   * working. The profile's patch is a third evidence source beside the loader
   * inventory and the package's own manifest. */
  it('reads a package the user own patch loads as restart, not broken', () => {
    const dir = profile(['@vincent-guo/dsh-web-search-openai'])
    pkg('@vincent-guo/dsh-web-search-openai', { main: 'index.js' }, { 'index.js': '' })
    // Without the patch it is what it looks like: bundled, no dsh metadata.
    expect(verifyActivation('web', '@vincent-guo/dsh-web-search-openai', new Set()))
      .toMatchObject({ state: 'broken' })

    writeFileSync(
      join(dir, 'cordis.patch.yml'),
      '- insert:\n    - id: mine\n      name: "@vincent-guo/dsh-web-search-openai"\n',
    )
    expect(verifyActivation('web', '@vincent-guo/dsh-web-search-openai', new Set()))
      .toMatchObject({ state: 'restart', bundle: true })
  })

  it('does not let an unrelated or unreadable patch soften a real defect', () => {
    const dir = profile(['dsh-broken'])
    pkg('dsh-broken', { main: 'index.js' }, { 'index.js': '' })
    // Names a DIFFERENT package: no evidence about this one.
    writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n    - id: other\n      name: somebody-else\n')
    expect(verifyActivation('web', 'dsh-broken', new Set())).toMatchObject({ state: 'broken' })

    // Unparseable: unsure has to leave the stricter verdict standing, since
    // this evidence only ever moves a verdict AWAY from broken.
    writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n    - id: broken\n      name: [\n')
    expect(verifyActivation('web', 'dsh-broken', new Set())).toMatchObject({ state: 'broken' })
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

  // #757: a plugin whose dsh peer range is capped below the running host is
  // skipped by the host's own boot gate (evaluatePluginCompatibility in
  // @deepseek-ai/dsh-app-boot) on EVERY boot. The bundle layer keeps
  // declaring it, the loader never mounts it, and "restart to apply" was an
  // infinite loop: restarting can never activate it. The market must predict
  // the host's verdict with the host's own semantics — satisfiesRange with
  // includePrerelease, @deepseek-ai/dsh and @deepseek-ai/dsh-* peers only —
  // and say `incompatible` instead of `restart`.
  it('incompatible when the host will skip the bundle on every boot — peer capped below the runtime (#757)', () => {
    profile(['dsh-capped'])
    pkg('dsh-capped', {
      version: '0.5.1',
      peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      main: 'index.js',
    }, { 'index.js': '', 'cordis.patch.yml': SIMPLE_PATCH })
    const result = verifyActivation('web', 'dsh-capped', new Set(), undefined, false,
      { runtimeVersion: '0.2.0', exemptions: {} })
    expect(result).toMatchObject({ state: 'incompatible', hot: false, bundle: true })
    expect(result.reasons.join(' ')).toMatch(/0\.1\.0-rc\.6/)
    expect(result.reasons.join(' ')).toMatch(/0\.2\.0/)
  })

  it('fires on the prerelease host line the users actually run (#757)', () => {
    // The case that hid the original defect: `^0.1.x` was compared against the
    // bare `0.2.0` ceiling, so a PRERELEASE of 0.2 slipped under every 0.1-only
    // range while the release itself did not. Every published 0.2 host is a
    // prerelease (`0.2.0-rc.1` is what the reporter ran), so a suite that only
    // exercises `0.2.0` proves the gate works on the one version nobody has.
    // Pinned here so a comparator regression cannot come back quietly.
    profile(['dsh-capped'])
    pkg('dsh-capped', {
      version: '0.5.1',
      peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      main: 'index.js',
    }, { 'index.js': '', 'cordis.patch.yml': SIMPLE_PATCH })
    for (const runtimeVersion of ['0.2.0-rc.1', '0.2.0-rc.2']) {
      const result = verifyActivation('web', 'dsh-capped', new Set(), undefined, false,
        { runtimeVersion, exemptions: {} })
      expect(result, runtimeVersion).toMatchObject({ state: 'incompatible', hot: false, bundle: true })
    }
    // The sibling line that DOES satisfy the range keeps the old answer, so
    // this is not a blanket "any 0.1 peer is incompatible".
    const satisfied = verifyActivation('web', 'dsh-capped', new Set(), undefined, false,
      { runtimeVersion: '0.1.7-rc.2', exemptions: {} })
    expect(satisfied.state).toBe('restart')
  })

  it('an exempted runtime version boots after all — restart, not incompatible (#757)', () => {
    profile(['dsh-capped'])
    pkg('dsh-capped', {
      version: '0.5.1',
      peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      main: 'index.js',
    }, { 'index.js': '', 'cordis.patch.yml': SIMPLE_PATCH })
    const result = verifyActivation('web', 'dsh-capped', new Set(), undefined, false,
      { runtimeVersion: '0.2.0', exemptions: { 'dsh-capped@0.5.1': ['0.2.0'] } })
    expect(result).toMatchObject({ state: 'restart', hot: false, bundle: true })
  })

  it('an open peer range never marks it incompatible — the host accepts it (#757)', () => {
    profile(['dsh-open'])
    pkg('dsh-open', {
      version: '0.59.2',
      peerDependencies: { '@deepseek-ai/dsh': '>=0.1.5-rc.1' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      main: 'index.js',
    }, { 'index.js': '', 'cordis.patch.yml': SIMPLE_PATCH })
    const result = verifyActivation('web', 'dsh-open', new Set(), undefined, false,
      { runtimeVersion: '0.2.0', exemptions: {} })
    expect(result).toMatchObject({ state: 'restart', hot: false, bundle: true })
  })

  it('unknown runtime version keeps the old verdict — uncertainty never marks it incompatible (#757)', () => {
    profile(['dsh-capped'])
    pkg('dsh-capped', {
      version: '0.5.1',
      peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      main: 'index.js',
    }, { 'index.js': '', 'cordis.patch.yml': SIMPLE_PATCH })
    const result = verifyActivation('web', 'dsh-capped', new Set(), undefined, false,
      { runtimeVersion: null, exemptions: {} })
    expect(result).toMatchObject({ state: 'restart', hot: false, bundle: true })
  })

  it('incompatible with the remedy pointing at upgrading dsh when the runtime is below the range (#758)', () => {
    // The #757 case upside down: the host is OLDER than the range's floor,
    // so upgrading dsh genuinely satisfies the peer. The remedy must offer
    // it, and must not claim upgrading would not help.
    const dir = profile(['dsh-capped'])
    pkg('dsh-capped', {
      version: '0.5.1',
      peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      main: 'index.js',
    }, { 'index.js': '', 'cordis.patch.yml': SIMPLE_PATCH })
    const gate = hostPeerGate(dir, 'dsh-capped', { runtimeVersion: '0.0.9', exemptions: {} })
    expect(gate).toMatchObject({ hostTooOld: true })
    const result = verifyActivation('web', 'dsh-capped', new Set(), undefined, false,
      { runtimeVersion: '0.0.9', exemptions: {} })
    expect(result).toMatchObject({ state: 'incompatible', hot: false, bundle: true })
    expect(result.reasons.join(' ')).toMatch(/升级 dsh、等插件更新适配或装回旧版本/)
    expect(result.reasons.join(' ')).toMatch(/upgrade dsh, wait for an updated release, or go back to the previous version/)
    expect(result.reasons.join(' ')).not.toMatch(/解决不了/)
  })

  it('incompatible without suggesting an upgrade when the runtime is above the range (#758)', () => {
    // The #757 shape itself: the running host already outruns the plugin's
    // cap, so no dsh upgrade can satisfy it. Offering "or upgrade dsh"
    // here points the wrong way (#758 review).
    const dir = profile(['dsh-capped'])
    pkg('dsh-capped', {
      version: '0.5.1',
      peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      main: 'index.js',
    }, { 'index.js': '', 'cordis.patch.yml': SIMPLE_PATCH })
    const gate = hostPeerGate(dir, 'dsh-capped', { runtimeVersion: '0.2.0', exemptions: {} })
    expect(gate).toMatchObject({ hostTooOld: false })
    const result = verifyActivation('web', 'dsh-capped', new Set(), undefined, false,
      { runtimeVersion: '0.2.0', exemptions: {} })
    expect(result).toMatchObject({ state: 'incompatible', hot: false, bundle: true })
    expect(result.reasons.join(' ')).toMatch(/等插件更新适配或装回旧版本;升级 dsh 解决不了/)
    expect(result.reasons.join(' ')).toMatch(/upgrading dsh will not help/)
    expect(result.reasons.join(' ')).not.toMatch(/或升级 dsh/)
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

/**
 * #792: the host accepts `dsh.bundle.patch` as a LIST of files and composes
 * them in order (official dsh-web-app ships five). The market read only a
 * string, so an array-declared pure carrier produced no patch rows, no mount
 * targets, no loadable entry — and verifyActivation called a healthy install
 * broken.
 */
describe('an array-declared pure-patch carrier (#792)', () => {
  it('reads as restart, not broken, when its two declared patches mount installed packages', () => {
    profile(['dsh-array-carrier'])
    pkg('dsh-array-carrier', { dsh: { bundle: { patch: ['./a.patch.yml', './b.patch.yml'] } } }, {
      'a.patch.yml': '- insert:\n    - id: arr-a\n      name: dep-a\n',
      'b.patch.yml': '- insert:\n    - id: arr-b\n      name: dep-b\n',
    })
    pkg('dep-a', { name: 'dep-a' }, { 'index.js': '' })
    pkg('dep-b', { name: 'dep-b' }, { 'index.js': '' })
    expect(verifyActivation('web', 'dsh-array-carrier', new Set()))
      .toMatchObject({ state: 'restart', bundle: true, hot: false })
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

describe('activationAfterReplace (post-update verdict)', () => {
  const live = { state: 'live' as const, reasons: ['已热加载 / live'], bundle: true, hot: true }

  it('downgrades a plugin that was already running to "restart"', async () => {
    // Measured on a real host: updating the market 1.11.3 → 1.12.2 left the
    // process reporting 1.11.3 with an unchanged boot id, while the update
    // route answered "live / 已热加载" in the same response. The loader
    // inventory cannot tell the two apart — the name was in it before the
    // update and is in it after, because replacing files on disk does not
    // unload an imported module.
    const { activationAfterReplace } = await import('../src/verify.ts')
    const result = activationAfterReplace(live, true)
    expect(result.state).toBe('restart')
    expect(result.hot).toBe(false)
    expect(result.reasons.join(' ')).toContain('重启后生效')
  })

  it('leaves a plugin that was NOT running alone', async () => {
    // Nothing was loaded to shadow the new build, so the fresh mount really
    // does run the new code. Downgrading this case too would tell users to
    // restart for a change that already took effect — the mistake #156 was.
    const { activationAfterReplace } = await import('../src/verify.ts')
    expect(activationAfterReplace(live, false)).toBe(live)
  })

  it('does not promote a non-live verdict', async () => {
    // Only "live" is the wrong answer here. A missing or broken package must
    // keep saying so; turning it into "restart" would hide a failed update
    // behind an instruction that cannot fix it.
    const { activationAfterReplace } = await import('../src/verify.ts')
    for (const state of ['missing', 'restart', 'disabled', 'broken'] as const) {
      const other = { ...live, state }
      expect(activationAfterReplace(other, true)).toBe(other)
    }
  })
})

describe('hasHostHalf (client-only updates need a refresh, not a restart)', () => {
  it('is false for a dsh.client package with no dsh.bundle', async () => {
    // Themes and skins. The market shim-mounts them so the loader has a live
    // row, but no server code runs — the browser re-fetches their bundle from
    // disk on the next page load. Asking these users to restart would repeat
    // #156 in a narrower place.
    const { hasHostHalf } = await import('../src/verify.ts')
    const dir = mkdtempSync(join(tmpdir(), 'dshm-hosthalf-'))
    const pkg = join(dir, 'node_modules', 'theme-only')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'theme-only', dsh: { client: 'client/client.js' } }))
    expect(hasHostHalf('web', 'theme-only', dir)).toBe(false)

    const both = join(dir, 'node_modules', 'has-host')
    mkdirSync(both, { recursive: true })
    writeFileSync(join(both, 'package.json'), JSON.stringify({ name: 'has-host', dsh: { bundle: 'lib/index.js', client: 'client/client.js' } }))
    expect(hasHostHalf('web', 'has-host', dir)).toBe(true)

    // A package declaring NEITHER key still loads through the bundle layer,
    // so it has a host half. Reading `dsh.bundle` alone would call this one
    // client-only and silently switch the correction off for it.
    const neither = join(dir, 'node_modules', 'bare')
    mkdirSync(neither, { recursive: true })
    writeFileSync(join(neither, 'package.json'), JSON.stringify({ name: 'bare', dsh: {} }))
    expect(hasHostHalf('web', 'bare', dir)).toBe(true)

    // A package that is not installed cannot have a stale host half either.
    expect(hasHostHalf('web', 'absent', dir)).toBe(false)
  })
})

describe('clientBundlePath', () => {
  it('resolves the two shapes real plugins ship', () => {
    expect(clientBundlePath('./client/client.js')).toBe('./client/client.js')
    expect(clientBundlePath({ default: './client/client.js' })).toBe('./client/client.js')
    // browser wins over default: it is the condition the host's client
    // loader actually activates.
    expect(clientBundlePath({ browser: './b.js', default: './d.js' })).toBe('./b.js')
    expect(clientBundlePath({ browser: { default: './nested.js' } })).toBe('./nested.js')
  })

  it('gives up on anything it does not fully model, rather than guessing', () => {
    // Guessing wrong here means reporting a HEALTHY plugin as corrupt,
    // which is worse than the silence this replaces — so every unmodelled
    // shape must resolve to null and skip the check entirely.
    expect(clientBundlePath(undefined)).toBeNull()
    expect(clientBundlePath(null)).toBeNull()
    expect(clientBundlePath(['./a.js'])).toBeNull()
    expect(clientBundlePath('client/client.js')).toBeNull()       // not relative
    expect(clientBundlePath('https://cdn.example/x.js')).toBeNull()
    // import/require describe a Node resolution this does not model, and
    // could name a different artifact than the browser gets.
    expect(clientBundlePath({ import: './esm.js', require: './cjs.js' })).toBeNull()
    // Cyclic-ish nesting terminates instead of recursing forever.
    const deep = { default: { default: { default: { default: { default: './x.js' } } } } }
    expect(clientBundlePath(deep)).toBeNull()
  })
})

describe('brokenClientBundles — the whole profile, not just what was added (#222)', () => {
  /** A profile whose manifest actually lists its dependencies. */
  function withDeps(names: string[]): void {
    const dir = profileDir('web')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: Object.fromEntries(names.map(name => [name, '^1.0.0'])),
      dsh: { profile: { bundles: [] } },
    }))
  }

  it('finds a plugin nobody touched', () => {
    // The reported shape: updating ONE plugin re-extracts the whole tree, so
    // an unrelated plugin comes back pristine-and-broken. Checking only what
    // the operation added is exactly what missed it.
    profile([])
    withDeps(['untouched-ui', 'fine-ui'])
    pkg('untouched-ui', {
      name: 'untouched-ui', dsh: { client: {} }, exports: { './client': './client/client.js' },
    }, { 'client/client.js': 'function ( { syntax error' })
    pkg('fine-ui', {
      name: 'fine-ui', dsh: { client: {} }, exports: { './client': './client/client.js' },
    }, { 'client/client.js': 'module.exports = { ok: 1 }' })

    const broken = brokenClientBundles('web')
    expect(broken.map(entry => entry.name)).toEqual(['untouched-ui'])
    expect(broken[0]?.reason).toBeTruthy()
  })

  it('reports only what an operation broke, never what the profile already carried', () => {
    // A profile can hold a broken bundle indefinitely. Re-reporting it would
    // put the user in front of something this operation neither caused nor
    // can undo — the same rule introducedRisks follows.
    const before = [{ name: 'already-bad', reason: 'old' }]
    const after = [{ name: 'already-bad', reason: 'old' }, { name: 'just-broke', reason: 'new' }]
    expect(newlyBrokenBundles(before, after).map(entry => entry.name)).toEqual(['just-broke'])
    expect(newlyBrokenBundles(after, after)).toEqual([])
  })

  it('costs nothing on a profile with no client bundles at all', () => {
    profile([])
    withDeps(['host-only'])
    pkg('host-only', { name: 'host-only', dsh: { bundle: {} }, exports: { '.': './lib/index.js' } })
    expect(brokenClientBundles('web')).toEqual([])
  })
})

describe('checkClientBundle (#222)', () => {
  it('reports a client bundle that no longer parses', () => {
    profile([])
    pkg('broken-ui', {
      name: 'broken-ui', dsh: { client: {} }, exports: { './client': './client/client.js' },
    }, { 'client/client.js': 'function ( { syntax error' })
    const result = checkClientBundle('web', 'broken-ui')
    expect(result.ok).toBe(false)
    expect(result.reason).toBeTruthy()
  })

  it('passes a bundle that parses, without executing it', () => {
    profile([])
    // If this were EXECUTED the throw would escape and fail the test — the
    // whole point of compiling rather than running is that plugin code never
    // gets a turn.
    pkg('good-ui', {
      name: 'good-ui', dsh: { client: {} }, exports: { './client': './client/client.js' },
    }, { 'client/client.js': 'throw new Error("must never run")' })
    expect(checkClientBundle('web', 'good-ui')).toEqual({ ok: true, reason: null })
  })

  it('does not call an ESM bundle corrupt (module syntax is not a break)', () => {
    // `new Script` compiles a CLASSIC script, so valid module syntax throws
    // SyntaxError. This package ships CJS, which is why it went unnoticed —
    // but a plugin with an ESM client bundle was told its file was corrupt
    // and offered a rollback for a file that is fine. A false "your plugin
    // is corrupt" is the one outcome this check must never produce.
    profile([])
    for (const [name, source] of [
      ['esm-export', 'export const ok = 1'],
      ['esm-import', 'import x from "y"\nconsole.log(x)'],
      ['esm-default', 'export default function () {}'],
      ['esm-tla', 'const x = await Promise.resolve(1)\nconsole.log(x)'],
    ] as const) {
      pkg(name, {
        name, dsh: { client: {} }, exports: { './client': './client/client.js' },
      }, { 'client/client.js': source })
      expect(checkClientBundle('web', name), `${name} was reported broken`).toEqual({ ok: true, reason: null })
    }
    // The limit this buys, stated rather than hidden: an ESM bundle is not
    // checked AT ALL, including one that really is broken. V8 reports the
    // `export` token before it reaches the stray brace, and there is no
    // flag-free way to compile a module here. Silence on ESM is the price of
    // never crying corrupt on a file that is fine — the direction this
    // check's contract already chose.
    pkg('broken-esm', {
      name: 'broken-esm', dsh: { client: {} }, exports: { './client': './client/client.js' },
    }, { 'client/client.js': 'export const a = 1\n}' })
    expect(checkClientBundle('web', 'broken-esm').ok).toBe(true)

    // CJS — what this package and most plugins ship — is still checked, and
    // a real break in one is still caught.
    pkg('broken-cjs', {
      name: 'broken-cjs', dsh: { client: {} }, exports: { './client': './client/client.js' },
    }, { 'client/client.js': 'module.exports = { a: 1 }\n}' })
    expect(checkClientBundle('web', 'broken-cjs').ok).toBe(false)
  })

  it('stays silent for everything it cannot judge', () => {
    profile([])
    // No dsh.client at all — a host-only plugin has no bundle to check.
    pkg('host-only', { name: 'host-only', dsh: { bundle: {} }, exports: { '.': './lib/index.js' } })
    expect(checkClientBundle('web', 'host-only').ok).toBe(true)
    // dsh.client but an exports shape this resolver does not model.
    pkg('odd-exports', { name: 'odd-exports', dsh: { client: {} }, exports: { './client': ['./a.js'] } })
    expect(checkClientBundle('web', 'odd-exports').ok).toBe(true)
    // Declared but absent: verifyActivation already calls a missing entry
    // artifact `broken`; reporting it twice in two vocabularies helps nobody.
    pkg('absent', { name: 'absent', dsh: { client: {} }, exports: { './client': './client/gone.js' } })
    expect(checkClientBundle('web', 'absent').ok).toBe(true)
    // Not installed at all.
    expect(checkClientBundle('web', 'nope').ok).toBe(true)
  })
})

/**
 * #813: a plugin whose own bundle patch is an empty list, wired in by an Agent
 * preset row in the user's patch. Preset trees never enter the host loader,
 * so it never reads as live — and with the bundle row it read "restart" on
 * every boot, without it the #696 inference called it disabled.
 */
describe('a bundle whose own patch is empty (#813)', () => {
  const EMPTY_PATCH = '# the model-facing row belongs in an authored Agent Preset\n[]\n'
  const PRESET_PATCH = [
    '- id: agent-preset',
    '  config:',
    '    presets:',
    '      - id: desktop',
    '        plugins:',
    '          - id: computer-use',
    "            name: 'some-plugin'",
    '',
  ].join('\n')
  function install(bundles: string[]): string {
    const dir = profile(bundles)
    pkg('some-plugin', { name: 'some-plugin', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }, {
      'lib/index.js': '',
      'cordis.patch.yml': EMPTY_PATCH,
    })
    return dir
  }

  it('says the user\'s setup loads it, in or out of the bundle list, and never asks for a restart', () => {
    for (const bundles of [['some-plugin'], []]) {
      const dir = install(bundles)
      writeFileSync(join(dir, 'cordis.patch.yml'), PRESET_PATCH)
      expect(verifyActivation('web', 'some-plugin', new Set())).toMatchObject({
        state: 'inert', loadedByProfile: true, bundle: bundles.length > 0, hot: false,
      })
    }
  })

  it('says nothing loads it when the user\'s setup does not name it', () => {
    install(['some-plugin'])
    const result = verifyActivation('web', 'some-plugin', new Set())
    expect(result.state).toBe('inert')
    expect(result.loadedByProfile).toBeUndefined()
  })

  it('leaves a bundle with rows, or with an unreadable patch, to the old verdicts', () => {
    install(['some-plugin'])
    pkg('some-plugin', { name: 'some-plugin', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }, {
      'lib/index.js': '',
      'cordis.patch.yml': SIMPLE_PATCH,
    })
    expect(verifyActivation('web', 'some-plugin', new Set())).toMatchObject({ state: 'restart' })
    pkg('some-plugin', { name: 'some-plugin', main: 'lib/index.js', dsh: { bundle: { patch: './missing.yml' } } }, {
      'lib/index.js': '',
    })
    expect(verifyActivation('web', 'some-plugin', new Set())).toMatchObject({ state: 'restart' })
  })
})
