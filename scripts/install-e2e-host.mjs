#!/usr/bin/env node
/**
 * Install the DSH host the web-e2e lane boots, with its cordis plugins pinned
 * (#684).
 *
 * `npm install -g @deepseek-ai/dsh@<pinned>` pins only the CLI. Its cordis
 * plugins are caret ranges, so a fresh install takes whatever was published
 * last — and on 2026-09-22 that combination stopped booting: every web-e2e
 * job, on main and every PR, failed before the market was reached with
 *
 *     dsh: user patch-layer watching requires the Cordis HMR service
 *
 * Bisected by swapping one package at a time into a fresh `dsh@0.1.0-rc.8`
 * install and booting it:
 *
 *   - `@deepseek-ai/cordis-plugin-loader` >= 1.0.4 → the HMR service is never
 *     registered, which is the error above;
 *   - `@deepseek-ai/cordis-plugin-hmr` >= 1.0.18 → fails later, on
 *     `hmr.registerConfig`, against these CLIs' dsh-app-boot;
 *   - loader 1.0.2 + hmr 1.0.16, everything else at its newest → boots, on
 *     both matrix versions (0.1.0-rc.8 and 0.1.2-alpha.2).
 *
 * A global install cannot be told about this — `overrides` is honoured only
 * for the root project — so the host is installed as the dependency of a
 * throwaway project that carries the overrides, and its bin directory goes on
 * PATH for the steps that follow. Nothing about the market itself changes:
 * this is the harness, not the product.
 *
 * pnpm, not npm, and with `node-linker=hoisted` so the tree is shaped like the
 * global npm install it replaces. npm resolved the rc.8 tree under these
 * overrides in 403s locally and 15 minutes on the ubuntu runner (arborist
 * backtracking; 0.1.2-alpha.2 was quick); pnpm installs the same versions in
 * about 8s. The full e2e suite passes against either.
 *
 * Remove the overrides once the pinned CLIs resolve to a set that boots
 * again; the job going green without them is the signal.
 *
 * Usage: node scripts/install-e2e-host.mjs <dsh version>
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const version = process.argv[2]
if (!version) {
  console.error('usage: node scripts/install-e2e-host.mjs <dsh version>')
  process.exit(2)
}

const OVERRIDES = {
  // 2026-11-04: cordis 4.1.0 (+ loader 1.1.0) published and the two oldest
  // CLI lines stopped booting on it — `mountRootInclude` → `PluginGroup.create`
  // → "Cannot read properties of null (reading 'entry')", on 0.1.0-rc.8 and
  // 0.1.2-alpha.2 only, while the newer lines stayed green. Same shape as
  // #684: the old CLIs' caret ranges float onto a plugin set their
  // dsh-app-boot cannot boot. Pin the last 4.0.x for those lines only.
  '@deepseek-ai/cordis': '4.0.5',
  '@deepseek-ai/cordis-plugin-loader': '1.0.2',
  '@deepseek-ai/cordis-plugin-hmr': '1.0.16',
}

/**
 * The CLI lines whose own cordis plugins need to be pinned.
 *
 * The breakage is in what the OLD CLIs resolve: their caret ranges float onto
 * plugin versions their `dsh-app-boot` cannot boot (#684). 0.1.7 declares its
 * own ranges (`cordis-plugin-loader: ~1.0.5`) and boots as declared —
 * measured, and the full lane is green on it — so pinning it would make CI
 * test a composition no user gets, on the line where "what users run" matters
 * most. Anything not listed here installs as published; a future line that
 * needs pins will say so by going red.
 */
const NEEDS_OVERRIDES = new Set(['0.1.0-rc.8', '0.1.2-alpha.2'])
const pinned = NEEDS_OVERRIDES.has(version)

const root = join(process.env.RUNNER_TEMP ?? tmpdir(), 'dsh-e2e-host')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
writeFileSync(join(root, 'package.json'), JSON.stringify({
  private: true,
  dependencies: { '@deepseek-ai/dsh': version },
  ...(pinned ? { pnpm: { overrides: OVERRIDES } } : {}),
}, null, 2))
writeFileSync(join(root, '.npmrc'), 'node-linker=hoisted\n')
// The overrides go in the WORKSPACE file as well, because pnpm 10 moved its
// settings there and 11 stopped reading `pnpm.overrides` in package.json —
// measured on pnpm 11.7: with the overrides only in package.json the install
// landed loader@1.0.5 + hmr@1.0.19 and the host died with the #684 error this
// script exists to avoid, while `pnpm-workspace.yaml` carried nothing but an
// `allowBuilds` stub pnpm had written for itself. CI pins pnpm 10, where the
// package.json form still works, so both are written rather than one
// replaced: a contributor on a newer pnpm gets the same tree CI gets.
//
// `strictDepBuilds: false` is the other half of that stub: pnpm 11 fails the
// install over dependencies whose build scripts it ignored, and the versions
// above are exactly the ones that carry them. Nothing here needs those
// scripts built — this tree boots a `dsh web` for the market, not a terminal.
writeFileSync(join(root, 'pnpm-workspace.yaml'), [
  'packages:',
  '  - .',
  'strictDepBuilds: false',
  // Only when this line needs pinning, for the same reason the package.json
  // copy is conditional: a pin is a deviation from what users get.
  ...(pinned ? ['overrides:', ...Object.entries(OVERRIDES).map(([name, v]) => `  '${name}': ${v}`)] : []),
  '',
].join('\n'))

const attempt = () => spawnSync('pnpm', ['install', '--no-frozen-lockfile'], {
  cwd: root,
  stdio: 'inherit',
  // pnpm is a .cmd shim on Windows, which spawn only finds through a shell.
  shell: process.platform === 'win32',
})
let install = attempt()
if (install.status !== 0) {
  // A registry race upstream is not this repository's failure. Measured
  // 2026-10-28: `@aws-sdk/middleware-websocket` named `@aws-sdk/core@^3.978.7`
  // before core 3.978.7 was published, and every web-e2e job went red with
  // `ERR_PNPM_NO_MATCHING_VERSION` for about two minutes until it landed.
  // One retry after the wave settles turns that into a slower pass instead of
  // a red lane someone has to re-read.
  console.error('host install failed; retrying once in 20s in case the registry was racing a publish')
  await new Promise(resolve => setTimeout(resolve, 20_000))
  install = attempt()
}
if (install.status !== 0) process.exit(install.status ?? 1)

const bin = join(root, 'node_modules', '.bin')
if (process.env.GITHUB_PATH) appendFileSync(process.env.GITHUB_PATH, `${bin}\n`)
console.log(`dsh ${version} installed at ${root} ${pinned ? `with ${JSON.stringify(OVERRIDES)}` : 'as published (this line pins nothing)'}; ${bin} is on PATH for later steps`)
