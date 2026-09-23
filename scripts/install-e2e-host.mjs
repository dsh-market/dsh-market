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
  '@deepseek-ai/cordis-plugin-loader': '1.0.2',
  '@deepseek-ai/cordis-plugin-hmr': '1.0.16',
}

const root = join(process.env.RUNNER_TEMP ?? tmpdir(), 'dsh-e2e-host')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
writeFileSync(join(root, 'package.json'), JSON.stringify({
  private: true,
  dependencies: { '@deepseek-ai/dsh': version },
  pnpm: { overrides: OVERRIDES },
}, null, 2))
writeFileSync(join(root, '.npmrc'), 'node-linker=hoisted\n')

const install = spawnSync('pnpm', ['install', '--no-frozen-lockfile'], {
  cwd: root,
  stdio: 'inherit',
  // pnpm is a .cmd shim on Windows, which spawn only finds through a shell.
  shell: process.platform === 'win32',
})
if (install.status !== 0) process.exit(install.status ?? 1)

const bin = join(root, 'node_modules', '.bin')
if (process.env.GITHUB_PATH) appendFileSync(process.env.GITHUB_PATH, `${bin}\n`)
console.log(`dsh ${version} installed at ${root} with ${JSON.stringify(OVERRIDES)}; ${bin} is on PATH for later steps`)
