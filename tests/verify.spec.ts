/**
 * P0-2 activation verification: what "installed" means for a package —
 * live (hot-mounted) / restart (bundle layer, not live) / inert (never a
 * profile-layer plugin) / broken (validation failure) / missing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { profileDir } from '../src/profile.ts'
import { brokenClientBundles, checkClientBundle, clientBundlePath, configFormNamespaces, findUnservedConfigNamespaces, hostPeerGate, newlyBrokenBundles, verifyActivation } from '../src/verify.ts'
import type { HostRuntimeFacts } from '../src/verify.ts'

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

describe('bundle row peer gate (#867)', () => {
  const bundle = '@deepseek-ai/dsh-experimental-agent-team-profile'
  const children = [
    '@deepseek-ai/dsh-experimental-agent-team',
    '@deepseek-ai/dsh-experimental-tool-agent-team',
    '@deepseek-ai/dsh-experimental-client-ui-agent-team',
  ]
  const runtimeVersion = '0.2.1-alpha.3'
  const facts = { runtimeVersion, exemptions: {} }
  const patch = `- id: tool-subagent\n  disabled: true\n- insert:\n${children.map((name, i) => `    - id: team-${i}\n      name: '${name}'`).join('\n')}\n`

  // Published alpha.2 shape: only cordis is a peer of the carrier; its
  // three inserted plugins pin dsh peers to alpha.2. No registry in tests.
  function install(version = '0.2.1-alpha.2', patches: Record<string, string> = { 'cordis.patch.yml': patch }): string {
    const dir = profile([bundle])
    pkg(bundle, {
      name: bundle, version, main: 'index.js',
      peerDependencies: { '@deepseek-ai/cordis': '~4.0.5-alpha.1' },
      dependencies: Object.fromEntries(children.map(name => [name, version])),
      dsh: { bundle: { patch: Object.keys(patches) } },
    }, { 'index.js': '', ...patches })
    for (const name of children) child(name, version)
    return dir
  }

  function child(name: string, version: string, peers: Record<string, string> = { '@deepseek-ai/dsh-agent': version }): void {
    pkg(name, { name, version, main: 'index.js', peerDependencies: peers }, { 'index.js': '' })
  }

  const verify = (hostFacts: HostRuntimeFacts = facts, live = new Set<string>()) =>
    verifyActivation('web', bundle, live, undefined, false, hostFacts)

  it('rejects the alpha.2 trio on an alpha.3 host with a bilingual culprit and remedy', () => {
    install()
    expect(hostPeerGate(profileDir('web'), bundle, facts)).toBeNull()
    const result = verify()
    expect(result).toMatchObject({ state: 'incompatible', bundle: true, hot: false })
    const reason = result.reasons.join(' ')
    for (const text of [children[0]!, '@deepseek-ai/dsh-agent', '0.2.1-alpha.2', runtimeVersion,
      '重启也不会生效', 'a restart will not activate it', '更新', 'update', '兼容', 'compatible']) {
      expect(reason).toContain(text)
    }
    expect(reason).not.toContain('upgrade dsh,')
  })

  it.each(['0.2.1-alpha.2', '0.2.1-alpha.3'])('keeps compatible plugins on host %s restartable', host => {
    install(host)
    expect(verify({ runtimeVersion: host, exemptions: {} }).state).toBe('restart')
  })

  it('accepts the alpha.3 bundle on the alpha.3 host', () => {
    install(runtimeVersion)
    expect(verify().state).toBe('restart')
  })

  it('suggests upgrading dsh when the child requires a newer host', () => {
    install(runtimeVersion)
    const result = verify({ runtimeVersion: '0.2.1-alpha.2', exemptions: {} })
    expect(result.state).toBe('incompatible')
    expect(result.reasons.join(' ')).toContain('升级 dsh，或更新此插件包')
    expect(result.reasons.join(' ')).toContain('upgrade dsh, or update this bundle')
    expect(result.reasons.join(' ')).not.toContain('will not help')
  })

  it('accepts open dsh peers and ignores unrelated peers, including a string patch declaration', () => {
    const dir = install()
    for (const name of children) child(name, '0.2.1-alpha.2', {
      '@deepseek-ai/dsh': '>=0.2.1-alpha.1', '@deepseek-ai/cordis': '1.0.0',
    })
    const manifest = join(dir, 'node_modules', bundle, 'package.json')
    writeFileSync(manifest, JSON.stringify({ name: bundle, main: 'index.js', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    expect(verify().state).toBe('restart')
  })

  it('checks all three plugins, applying exemptions to each installed name and version', () => {
    install()
    const exemptions = Object.fromEntries(children.map(name => [`${name}@0.2.1-alpha.2`, [runtimeVersion]]))
    expect(verify({ runtimeVersion, exemptions }).state).toBe('restart')
    delete exemptions[`${children[2]}@0.2.1-alpha.2`]
    const result = verify({ runtimeVersion, exemptions })
    expect(result.state).toBe('incompatible')
    expect(result.reasons.join(' ')).toContain(children[2])
  })

  it('does not extend a carrier exemption or another version exemption to its children', () => {
    install()
    expect(verify({ runtimeVersion, exemptions: {
      [`${bundle}@0.2.1-alpha.2`]: [runtimeVersion],
      [`${children[0]}@0.2.1-alpha.3`]: [runtimeVersion],
    } }).state).toBe('incompatible')
  })

  it('keeps live carrier rows and disabled bundles ahead of predictions', () => {
    install()
    for (const live of [new Set([bundle]), new Set(['#team-0'])]) {
      expect(verify(facts, live)).toMatchObject({ state: 'live', hot: true })
    }
    expect(verifyActivation('web', bundle, new Set(), undefined, true, facts).state).toBe('disabled')
  })

  it('keeps unknown hosts and unparseable child ranges conservative', () => {
    install()
    expect(verify({ runtimeVersion: null, exemptions: {} }).state).toBe('restart')
    for (const name of children) child(name, '0.2.1-alpha.2', { '@deepseek-ai/dsh': 'unknown-range' })
    expect(verify().state).toBe('restart')
  })

  it.each(['absent', 'missing manifest', 'invalid manifest'])('does not invent incompatibility for an %s dependency', state => {
    install()
    for (const name of children) {
      const root = join(profileDir('web'), 'node_modules', name)
      rmSync(join(root, 'package.json'))
      if (state === 'absent') rmSync(root, { recursive: true })
      if (state === 'invalid manifest') writeFileSync(join(root, 'package.json'), '{')
    }
    expect(verify().state).toBe('restart')
  })

  it('does not scan ordinary dependencies, payload names, or the user patch', () => {
    const dir = install('0.2.1-alpha.2', {
      'cordis.patch.yml': `- insert:\n  - id: preset\n    name: good\n    config:\n      plugins:\n      - name: '${children[0]}'\n      insert:\n      - name: '${children[1]}'\n  - id: options\n    name: good\n    config:\n    - name: '${children[2]}'\n`,
    })
    child('good', runtimeVersion)
    writeFileSync(join(dir, 'cordis.patch.yml'), patch)
    expect(verify().state).toBe('restart')
  })

  it('finds real group children and scoped and unscoped subpath entries', () => {
    install('0.2.1-alpha.2', {
      'cordis.patch.yml': `- insert: [{ id: g, group: true, config: [{ id: real, name: '${children[0]}/plugin' }] }]`,
    })
    expect(verify().state).toBe('incompatible')
    install('0.2.1-alpha.2', { 'cordis.patch.yml': '- insert: [{ id: real, name: other/plugin.js }]' })
    child('other', '0.2.1-alpha.2')
    expect(verify().state).toBe('incompatible')
  })

  it('reads every declared patch and respects a later disable', () => {
    install('0.2.1-alpha.2', { 'first.yml': '[]', 'nested/second.yml': patch })
    expect(verify().state).toBe('incompatible')
    install('0.2.1-alpha.2', {
      'first.yml': patch,
      'second.yml': children.map((_, i) => `- id: team-${i}\n  disabled: true`).join('\n'),
    })
    expect(verify().state).toBe('restart')
  })

  it.each(['missing', 'malformed'])('requires readable patch declarations (%s file)', state => {
    const dir = install('0.2.1-alpha.2', { 'first.yml': patch, 'second.yml': '[]' })
    const file = join(dir, 'node_modules', bundle, 'second.yml')
    if (state === 'missing') rmSync(file)
    else writeFileSync(file, '- insert: [')
    expect(verify().state).toBe('restart')
  })

  it('does not predict rejection for disabled or expression-gated children', () => {
    install('0.2.1-alpha.2', { 'cordis.patch.yml': `- insert:\n  - id: off\n    name: '${children[0]}'\n    disabled: true\n  - id: maybe\n    name: '${children[1]}'\n    disabled: !!js someCondition\n` })
    expect(verify().state).toBe('restart')
  })

  it('does not borrow a fallback manifest when a nearer declared dependency is incomplete', () => {
    const dir = install()
    for (const name of children) mkdirSync(join(dir, 'node_modules', bundle, 'node_modules', name), { recursive: true })
    expect(verify().state).toBe('restart')
  })

  it('ignores undeclared nested copies when the profile resolves compatible plugins', () => {
    const dir = install(runtimeVersion)
    const root = join(dir, 'node_modules', bundle)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: bundle, main: 'index.js', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    const nested = join(root, 'node_modules', children[0]!)
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'package.json'), JSON.stringify({
      name: children[0], version: '0.2.1-alpha.2', peerDependencies: { '@deepseek-ai/dsh': '0.2.1-alpha.2' },
    }))
    expect(verify().state).toBe('restart')
  })

  it.each(['nested', 'virtual store', 'workspace'])('resolves the patch plugin from a %s layout without requiring exports', layout => {
    const dir = install()
    const name = children[0]!
    // Compatible root copies must not hide the carrier's pinned dependency.
    for (const other of children) child(other, runtimeVersion)
    let root = join(dir, 'node_modules', bundle)
    if (layout === 'virtual store') {
      const real = join(dir, 'node_modules', '.pnpm', 'team-profile@alpha.2', 'node_modules', bundle)
      mkdirSync(join(real, '..'), { recursive: true })
      // Move only this test's package, then link it as pnpm does.
      renameSync(root, real)
      symlinkSync(real, root, 'junction')
      root = join(real, '..', '..', '..')
    } else if (layout === 'workspace') {
      rmSync(join(dir, 'node_modules', name), { recursive: true })
      root = join(dir, '..')
    }
    const target = join(root, 'node_modules', name)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({
      name, version: '0.2.1-alpha.2', exports: { '.': './plugin.js' },
      peerDependencies: { '@deepseek-ai/dsh-agent': '0.2.1-alpha.2' },
    }))
    const result = verify()
    expect(result.state).toBe('incompatible')
    expect(result.reasons.join(' ')).toContain(name)
  })
})

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

  it('lets an own engines.dsh range decide alone, as the host does (#867)', () => {
    // @deepseek-ai/dsh-app-boot's unmetRequirements: when a manifest declares
    // `engines.dsh`, that range decides alone and peerDependencies are then
    // ignored. Both halves matter, and the second one is the subtle one — a
    // gate that read BOTH (or only peers) reports a plugin the host loads
    // fine as incompatible.
    const dir = profile(['dsh-capped'])
    pkg('dsh-capped', {
      version: '0.5.1',
      engines: { dsh: '>=0.1.0-rc.6' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      main: 'index.js',
    }, { 'index.js': '', 'cordis.patch.yml': SIMPLE_PATCH })
    expect(hostPeerGate(dir, 'dsh-capped', { runtimeVersion: '0.2.0', exemptions: {} })).toBeNull()

    // The same manifest with a peer that CANNOT be satisfied: the host still
    // loads it, because engines.dsh outranks the peer map entirely.
    pkg('dsh-capped', {
      version: '0.5.1',
      engines: { dsh: '>=0.1.0-rc.6' },
      peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      main: 'index.js',
    }, { 'index.js': '', 'cordis.patch.yml': SIMPLE_PATCH })
    expect(hostPeerGate(dir, 'dsh-capped', { runtimeVersion: '0.2.0', exemptions: {} })).toBeNull()
  })

  it('reports an unusable engines.dsh range as the gate that refuses it (#867)', () => {
    // The other direction, and the one that was invisible before: a package
    // with NO dsh peer at all — dsh-file-explorer-kit declares
    // `engines.dsh: ^0.1.1` and nothing else — whose engines range excludes
    // the running host. The host skips it; the market used to promise a
    // restart that could never apply it.
    const dir = profile(['dsh-capped'])
    pkg('dsh-capped', {
      version: '0.5.1',
      engines: { dsh: '^0.1.1' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      main: 'index.js',
    }, { 'index.js': '', 'cordis.patch.yml': SIMPLE_PATCH })
    const gate = hostPeerGate(dir, 'dsh-capped', { runtimeVersion: '0.2.0', exemptions: {} })
    expect(gate).toMatchObject({ peer: 'engines.dsh', range: '^0.1.1', hostTooOld: false })
    const result = verifyActivation('web', 'dsh-capped', new Set(), undefined, false,
      { runtimeVersion: '0.2.0', exemptions: {} })
    expect(result).toMatchObject({ state: 'incompatible', hot: false, bundle: true })
    // The user-facing sentence says "needs host ^0.1.1" — the API name for
    // that requirement is not the user's word for it.
    expect(result.reasons.join(' ')).toMatch(/\^0\.1\.1/)

    // An indeterminate range keeps the old verdict instead of inventing a
    // refusal (#757): a non-string range throws inside the host's evaluator,
    // and `workspace:` is accepted for peers but never for engines.
    expect(hostPeerGate(dir, 'dsh-capped', { runtimeVersion: '0.2.0', exemptions: {} })).not.toBeNull()
    pkg('dsh-capped', { version: '0.5.1', engines: { dsh: 1 }, main: 'index.js' }, { 'index.js': '' })
    expect(hostPeerGate(dir, 'dsh-capped', { runtimeVersion: '0.2.0', exemptions: {} })).toBeNull()
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

  it('recognizes a declared library without treating a missing plugin entry as broken (#995)', () => {
    profile([])
    pkg('dsh-shared', { name: 'dsh-shared', dsh: { kind: 'library' }, main: 'lib/index.js' })

    const result = verifyActivation('web', 'dsh-shared', new Set())
    expect(result).toMatchObject({ state: 'inert', library: true, bundle: false, hot: false })
    expect(result.reasons.join(' ')).toContain('供其他插件使用')
    expect(result.reasons.join(' ')).not.toContain('普通依赖')
    expect(verifyActivation('web', 'dsh-shared', new Set(), undefined, true)).toMatchObject({ state: 'inert', library: true })
  })

  it('keeps a package with a real plugin surface or a live loader entry under its existing verdict (#995)', () => {
    profile(['with-bundle'])
    pkg('with-bundle', { name: 'with-bundle', dsh: { kind: 'library', bundle: { patch: './cordis.patch.yml' } }, main: 'index.js' }, { 'index.js': '', 'cordis.patch.yml': SIMPLE_PATCH })
    pkg('loaded-library', { name: 'loaded-library', dsh: { kind: 'library' }, main: 'index.js' }, { 'index.js': '' })

    expect(verifyActivation('web', 'with-bundle', new Set())).toMatchObject({ state: 'restart', bundle: true })
    expect(verifyActivation('web', 'loaded-library', new Set(['loaded-library']))).toMatchObject({ state: 'live', hot: true })
    expect(verifyActivation('web', 'loaded-library', new Set(['loaded-library']), undefined, true)).toMatchObject({ state: 'disabled', hot: false })
    expect(verifyActivation('web', 'loaded-library', new Set(), undefined, true, undefined, true)).toMatchObject({ state: 'disabled', hot: false })
  })

  it('names the installable plugins a collection repository carries (#892)', () => {
    // The root of a monorepo says nothing about itself: no dsh field, no
    // entry. Installed whole it lands on the list as "installed, not in
    // effect" — a sentence with no way out, because the plugins exist one
    // level down and nothing said so. The reason is the exit.
    profile([])
    pkg('dsh-toolkit', { name: 'dsh-toolkit', private: true })
    pkg('dsh-toolkit/packages/dsh-at-file', { name: 'dsh-at-file', dsh: { bundle: {} } })
    pkg('dsh-toolkit/packages/dsh-cost-dashboard', { name: 'dsh-cost-dashboard', dsh: { bundle: {} } })

    const result = verifyActivation('web', 'dsh-toolkit', new Set())

    expect(result).toMatchObject({ state: 'inert', bundle: false })
    const text = result.reasons.join(' ')
    expect(text).toContain('packages/dsh-at-file')
    expect(text).toContain('packages/dsh-cost-dashboard')
    expect(text).toContain('#path:')
  })

  it('does not call an ordinary dependency a collection repository (#892)', () => {
    // A library has directories too; only one holding a dsh declaration of
    // its own is a plugin, and the plain-dependency sentence stays the one
    // that fits everything else.
    profile([])
    pkg('plain-lib', { name: 'plain-lib', main: 'index.js' })
    pkg('plain-lib/examples/thing', { name: 'thing' })

    const text = verifyActivation('web', 'plain-lib', new Set()).reasons.join(' ')
    expect(text).toContain('plain dependency with no dsh metadata')
    expect(text).not.toContain('#path:')
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

describe('config namespaces a client asks for (#810)', () => {
  const clientManifest = { name: 'p', main: 'lib/index.js', exports: { './client': './lib/client.js' }, dsh: { client: { platform: 'web' } } }
  /** `readInstalled` reads the profile manifest, so the package has to be declared. */
  function declaredProfile(...names: string[]): string {
    const dir = profileDir('web')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: Object.fromEntries(names.map(name => [name, '^0.1.0'])),
      dsh: { profile: { bundles: names } },
    }))
    return dir
  }

  it('reads a literal, and one level of constant alias — the shape that started this', () => {
    // The reported plugin writes `var NAMESPACE = "dsh-comfyui-canvas"` and
    // calls `configForms.get(NAMESPACE)`. A literal-only scan misses the very
    // case the check exists for.
    expect(configFormNamespaces('const render = () => ctx.configForms.get("comfyui-canvas")'))
      .toEqual(['comfyui-canvas'])
    expect(configFormNamespaces('var NAMESPACE = "dsh-comfyui-canvas"\nctx.configForms.get(NAMESPACE)'))
      .toEqual(['dsh-comfyui-canvas'])
    expect(configFormNamespaces('let ns = \'a-b\'\nctx.configForms.get( ns )'))
      .toEqual(['a-b'])
  })

  it('drops a name assigned twice rather than guessing which value is live', () => {
    // What the name holds at the call site is not decidable from text, and a
    // wrong guess would be reported as a plugin defect.
    expect(configFormNamespaces('let ns = "one"\nns = "two"\nconfigForms.get(ns)')).toEqual([])
    // A single assignment next to other statements still counts.
    expect(configFormNamespaces('const other = "x"\nconst ns = "two"\nconfigForms.get(ns)')).toEqual(['two'])
  })

  it('stays quiet on everything it cannot prove', () => {
    // Dynamic forms, an aliased receiver, and non-namespace values: all
    // "cannot judge", never "wrong".
    expect(configFormNamespaces('configForms.get(prefix + "-suffix")')).toEqual([])
    expect(configFormNamespaces('const forms = ctx.configForms\nforms.get("x")')).toEqual([])
    expect(configFormNamespaces('ctx.configForms.get(name)')).toEqual([])
    expect(configFormNamespaces('configForms.get("has space")')).toEqual([])
    expect(configFormNamespaces('configForms.get("")')).toEqual([])
    // The value must be a plain literal: a template or an escaped string is
    // not this pattern.
    expect(configFormNamespaces('configForms.get(`a-b`)')).toEqual([])
  })

  it('judges against the whole composition, and names what the package should ask for', () => {
    declaredProfile('dsh-comfyui-canvas')
    pkg('dsh-comfyui-canvas', clientManifest, {
      'lib/client.js': 'var NAMESPACE = "dsh-comfyui-canvas"\nctx.configForms.get(NAMESPACE)',
      'cordis.patch.yml': SIMPLE_PATCH,
    })
    // Its own id is what the plugin meant — the fix has to name it, not just
    // the mistake.
    const served = new Set(['comfyui-canvas'])
    expect(findUnservedConfigNamespaces('web', served, () => [], profileDir('web')))
      .toEqual([{ name: 'dsh-comfyui-canvas', namespaces: ['dsh-comfyui-canvas'], ownEntryIds: [] }])
    // Served by ANY entry id in the composition — including one another
    // package owns (carrier form) — and this goes quiet. That is the whole
    // reason the judgement is not "is it this package's own id".
    expect(findUnservedConfigNamespaces('web', new Set(['dsh-comfyui-canvas']), () => [], profileDir('web')))
      .toEqual([])
  })

  it('says nothing about a package whose client resolves the name at runtime', () => {
    // The second fixture from the report: @linxin666/dsh-remote-web-ui reads
    // the served entry id through `forms.describe()`, so there is no literal
    // to judge — and its client is full of its own package name, which must
    // not be counted.
    declaredProfile('remote-web-ui')
    pkg('remote-web-ui', clientManifest, {
      'lib/client.js': [
        'const PACKAGE = "@linxin666/dsh-remote-web-ui"',
        'const id = await forms.describe()',
        'ctx.configForms.get(id)',
        'console.log(PACKAGE)',
      ].join('\n'),
    })
    expect(findUnservedConfigNamespaces('web', new Set(['remote-web-ui']), () => [], profileDir('web')))
      .toEqual([])
  })

  it('needs a client bundle to judge at all', () => {
    declaredProfile('server-only')
    pkg('server-only', { name: 'server-only', main: 'lib/index.js' }, {})
    expect(findUnservedConfigNamespaces('web', new Set(), () => [], profileDir('web'))).toEqual([])
  })
})
