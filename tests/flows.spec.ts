/**
 * UI flow tests: exercise the full browser-driven journeys — browse,
 * install, update-check, update, theme switch, uninstall — through the REAL
 * route/orchestration/profile layers, with only the process and network
 * boundaries replaced:
 *
 * - dsh-cli.ts   → FakeDsh: a programmable executor that performs real
 *                  filesystem effects on a tmp profile (package.json +
 *                  node_modules), with scriptable npm state ("latest is
 *                  1.2.0"), minimumReleaseAge silent-stale mode, and
 *                  hoist-drift failure injection. This is what lets CI test
 *                  the update logic WITHOUT publishing npm versions.
 * - registry.ts  → fixed curated registry (with a theme category)
 * - hot.ts       → in-memory mount table
 * - global fetch → fake npm/github APIs
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------- FakeDsh
// Mutable per-test state driving the fake executor and fake npm API.
const fake = vi.hoisted(() => ({
  profileDir: '',
  /** name → { versions: v→{manifest, artifacts}, latest } */
  npm: {} as Record<string, { versions: Record<string, { manifest: unknown; artifacts?: string[]; artifactContents?: Record<string, string> }>; latest: string }>,
  /** github:owner/repo target → packages it installs (or a junk collection) */
  repos: {} as Record<string, { name: string; manifest: unknown; artifacts?: string[]; junkChildren?: string[]; lockCommit?: string; byCommit?: Record<string, { manifest: unknown; artifacts?: string[] }> }>,
  /** Prebuilt Release archive URL → the package it installs (#250). A third
   * target shape beside npm names and github: shortcuts, and the only one
   * that must never have a dist-tag appended to it. */
  tarballs: {} as Record<string, { name: string; manifest: unknown; artifacts?: string[]; artifactContents?: Record<string, string> }>,
  /** Simulate pnpm minimumReleaseAge: adds resolve to the ALREADY INSTALLED version, exit 0. */
  staleUpdates: false,
  /** Resolve the next npm add to this version even though the dist-tag points elsewhere. */
  resolvedNpmVersionOnce: null as string | null,
  /** Fail the next N mutating commands with the hoist-pattern drift error. */
  hoistDiffTimes: 0,
  /** Simulate a too-young release in the lockfile (#39): every mutation
   * fails pnpm's supply-chain verification unless the one-shot
   * --config.minimumReleaseAge=0 override is passed (real pnpm 11 behavior
   * pinned in tests/pnpm-behavior.compat.spec.ts). */
  youngLockfile: false,
  /** When set, every command awaits this before acting (concurrency tests). */
  gate: null as Promise<void> | null,
  /** Set by the mocked cancelActive: the in-flight command resolves cancelled. */
  cancelNext: false,
  /**
   * Fail the next remove AFTER deleting node_modules but WITHOUT saving
   * package.json — pnpm's real half-uninstall shape (#65's mirror image:
   * files are gone, the manifest entry survives, the next boot's loader
   * misses its modules and the profile dies to activate).
   */
  failNextRemoveHalfGone: false,
  /**
   * Fail the next remove with exit 1 and this stderr, touching nothing —
   * a non-retryable pnpm failure (EPERM etc.) with the package intact.
   */
  failNextRemoveOnce: '',
  /** Appended to the next add's stdout (e.g. pnpm's Ignored build scripts line). */
  buildScriptOutputOnce: '',
/** Fail the next add with exit 1 and this stderr (e.g. ERR_PNPM_IGNORED_BUILDS, #68/#69). */
  failNextAddStderrOnce: '',
  /**
   * Fail the next npm add with exit 1 and this stderr AFTER writing
   * package.json/node_modules — pnpm's real order (#65, #69): the manifest
   * is written before registry fetches and the build-script check run.
   */
  failAfterWriteStderrOnce: '',
  /** Keep the dependency spec unchanged while the next npm add replaces its
   * package files, matching a range that already admits the new version. */
  preserveManifestOnNextAdd: false,
  /** Override only the next npm add's extracted bytes, then return to the
   * canonical package definition. Models pnpm replacing bytes before a later
   * hard failure while the resolved version and lock identity stay equal. */
  artifactContentsOnNextAdd: null as Record<string, string> | null,
  /** Fail one exact add target after writing, without affecting the update attempt before it. */
  failAddTargetOnce: null as { target: string; stderr: string } | null,
  /** Simulate dsh adding a profile bundle before that same add later fails (#339). */
  profileBundleOnNextAdd: null as string | null,
  /** Make restore's bulk install fail so its per-plugin fallback is exercised. */
  failInstallOnce: false,
  captureBundlesOnNextAdd: false,
  bundlesBeforeFallbackAdd: null as string[] | null,
  /** True while a fake command is in flight (mirrors the real activeChild). */
  running: false,
  calls: [] as string[][],
}))

vi.mock('../src/dsh-cli.ts', () => {
  function writePkg(name: string, manifest: unknown, artifacts: string[] = [], artifactContents: Record<string, string> = {}): void {
    const root = join(fake.profileDir, 'node_modules', name)
    // Replace, do not merge: pnpm swaps the package directory when the
    // version changes, so files the NEW version does not ship must be gone.
    // Merging let a stale artifact from the previous version stand in for a
    // missing one and hid #159 from this suite entirely.
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
    for (const rel of artifacts) {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      writeFileSync(join(root, rel), artifactContents[rel] ?? '')
    }
  }
  function readManifest(): {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  } {
    return JSON.parse(readFileSync(join(fake.profileDir, 'package.json'), 'utf8'))
  }
  function writeLockCommit(repo: string, commit: string): void {
    const path = join(fake.profileDir, 'pnpm-lock.yaml')
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const replaced = existing.includes('codeload.github.com')
      ? existing.replace(/codeload\.github\.com\/([^/\s]+\/[^/\s]+)\/tar\.gz\/[0-9a-f]{40}/g, `codeload.github.com/${repo}/tar.gz/${commit}`)
      : `lockfileVersion: 9\n  resolution: {tarball: https://codeload.github.com/${repo}/tar.gz/${commit}}\n`
    writeFileSync(path, replaced)
  }
  function writeNpmLock(name: string, spec: string, version: string): void {
    writeFileSync(join(fake.profileDir, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      `      ${name}:`,
      `        specifier: ${spec}`,
      `        version: ${version}`,
      'packages:',
      `  ${name}@${version}: {}`,
      'snapshots:',
      `  ${name}@${version}: {}`,
      '',
    ].join('\n'))
  }
  function lockedNpmVersion(name: string): string | null {
    const path = join(fake.profileDir, 'pnpm-lock.yaml')
    if (!existsSync(path)) return null
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`\\n\\s{6}${escaped}:\\r?\\n\\s{8}specifier:[^\\n]*\\r?\\n\\s{8}version:\\s*([^\\s(]+)`)
      .exec(readFileSync(path, 'utf8'))?.[1] ?? null
  }
  function writeDep(name: string, spec: string): void {
    const manifest = readManifest()
    manifest.dependencies = { ...manifest.dependencies, [name]: spec }
    writeFileSync(join(fake.profileDir, 'package.json'), JSON.stringify(manifest))
  }
  function appendProfileBundle(name: string): void {
    const manifest = readManifest()
    manifest.dsh ??= {}
    manifest.dsh.profile ??= {}
    const bundles = manifest.dsh.profile.bundles ?? []
    if (!bundles.includes(name)) manifest.dsh.profile.bundles = [...bundles, name]
    writeFileSync(join(fake.profileDir, 'package.json'), JSON.stringify(manifest))
  }
  function removeDep(name: string): void {
    const manifest = readManifest()
    if (manifest.dependencies) delete manifest.dependencies[name]
    writeFileSync(join(fake.profileDir, 'package.json'), JSON.stringify(manifest))
    rmSync(join(fake.profileDir, 'node_modules', name), { recursive: true, force: true })
  }
  async function runDshPlugin(_profile: string, args: string[]): Promise<unknown> {
    fake.calls.push(args)
    fake.running = true
    try {
      return await execute(args)
    } finally {
      fake.running = false
    }
  }
  async function execute(args: string[]): Promise<unknown> {
    if (fake.gate !== null) await fake.gate
    if (fake.cancelNext) {
      fake.cancelNext = false
      return { exitCode: null, timedOut: false, stdout: '', stderr: '', cancelled: true }
    }
    const positional = args.filter(a => !a.startsWith('-'))
    const cmd = positional[0]
    const ok = { exitCode: 0, timedOut: false, stdout: '', stderr: '', cancelled: false }
    if (fake.youngLockfile && !args.includes('--config.minimumReleaseAge=0')) {
      return {
        exitCode: 1, timedOut: false, stdout: '', cancelled: false,
        stderr: '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:\n  dsh-loop@1.0.0 was published at 2026-08-15T00:00:00.000Z, within the minimumReleaseAge cutoff',
      }
    }
    if (cmd === 'install') {
      if (fake.failInstallOnce) {
        fake.failInstallOnce = false
        return { ...ok, exitCode: 1, stderr: 'dsh: pnpm failed in profile directory' }
      }
      // pnpm install rematerializes whatever package.json currently pins,
      // independent of the registry's latest dist-tag.
      const manifest = readManifest()
      for (const [depName, spec] of Object.entries(manifest.dependencies ?? {})) {
        const pkg = fake.npm[depName]
        if (pkg === undefined) continue
        const match = /^\^?(\d+\.\d+\.\d+)$/.exec(spec)
        if (match === null) continue
        const version = match[1]
        const def = pkg.versions[version]
        if (def === undefined) continue
        writePkg(depName, { version, ...(def.manifest as object) }, def.artifacts, def.artifactContents)
      }
      return ok
    }
    if (cmd === 'add' && fake.captureBundlesOnNextAdd) {
      fake.captureBundlesOnNextAdd = false
      const manifest = readManifest() as { dsh?: { profile?: { bundles?: string[] } } }
      fake.bundlesBeforeFallbackAdd = [...(manifest.dsh?.profile?.bundles ?? [])]
    }
    if (fake.hoistDiffTimes > 0) {
      fake.hoistDiffTimes--
      return { exitCode: 1, timedOut: false, stdout: '', stderr: 'ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF  Run "pnpm install" to recreate the modules directory.', cancelled: false }
    }
    const target = positional[positional.length - 1]
    if (cmd === 'remove') {
      if (fake.failNextRemoveOnce !== '') {
        const stderr = fake.failNextRemoveOnce
        fake.failNextRemoveOnce = ''
        return { exitCode: 1, timedOut: false, stdout: '', stderr, cancelled: false }
      }
      if (fake.failNextRemoveHalfGone) {
        fake.failNextRemoveHalfGone = false
        rmSync(join(fake.profileDir, 'node_modules', target), { recursive: true, force: true })
        return { exitCode: 1, timedOut: false, stdout: '', cancelled: false, stderr: 'EPERM: operation not permitted, unlink …\\node_modules\\dsh-loop\\package.json' }
      }
      removeDep(target)
      return ok
    }
    // cmd === 'add'
    if (fake.failNextAddStderrOnce !== '') {
      const stderr = fake.failNextAddStderrOnce
      fake.failNextAddStderrOnce = ''
      return { exitCode: 1, timedOut: false, stdout: '', stderr, cancelled: false }
    }
    if (target.startsWith('github:')) {
      const hash = target.indexOf('#')
      const repoKey = hash === -1 ? target : target.slice(0, hash)
      const commit = hash === -1 ? undefined : target.slice(hash + 1)
      const repo = fake.repos[target] ?? (hash === -1 ? undefined : fake.repos[repoKey])
      if (repo === undefined) return { exitCode: 1, timedOut: false, stdout: '', stderr: `fake dsh: unknown repo ${target}`, cancelled: false }
      const def = commit !== undefined ? repo.byCommit?.[commit] : undefined
      writeDep(repo.name, target)
      writePkg(repo.name, def?.manifest ?? repo.manifest, def?.artifacts ?? repo.artifacts)
      const nextCommit = commit ?? repo.lockCommit
      if (nextCommit !== undefined) writeLockCommit(repoKey.replace(/^github:/, ''), nextCommit)
      // `dsh plugin add` writes the bundle row on this path too — that is
      // where #339 came from, a github-sourced install whose build was
      // blocked. Consuming the flag only in the npm branch below let the
      // regression test pass without ever creating the orphan it asserts on.
      if (fake.profileBundleOnNextAdd !== null) {
        appendProfileBundle(fake.profileBundleOnNextAdd)
        fake.profileBundleOnNextAdd = null
      }
      if (fake.failAfterWriteStderrOnce !== '') {
        const stderr = fake.failAfterWriteStderrOnce
        fake.failAfterWriteStderrOnce = ''
        return { exitCode: 1, timedOut: false, stdout: '', stderr, cancelled: false }
      }
      for (const child of repo.junkChildren ?? []) {
        mkdirSync(join(fake.profileDir, 'node_modules', repo.name, child), { recursive: true })
        writeFileSync(join(fake.profileDir, 'node_modules', repo.name, child, 'package.json'), '{"dsh":{}}')
      }
      return ok
    }
    if (/^https?:/.test(target)) {
      const prebuilt = fake.tarballs[target]
      if (prebuilt === undefined) {
        return { exitCode: 1, timedOut: false, stdout: '', stderr: `fake dsh: unknown archive ${target}`, cancelled: false }
      }
      writeDep(prebuilt.name, target)
      writePkg(prebuilt.name, prebuilt.manifest, prebuilt.artifacts, prebuilt.artifactContents)
      const codeload = /codeload\.github\.com\/([^/]+\/[^/]+)\/tar\.gz\/([0-9a-f]{40})/.exec(target)
      if (codeload !== null) writeLockCommit(codeload[1]!, codeload[2]!)
      return ok
    }
    const name = target.replace(/@(latest|[\d^~].*)$/, '')
    const pkg = fake.npm[name]
    if (pkg === undefined) return { exitCode: 1, timedOut: false, stdout: '', stderr: `fake dsh: unknown npm package ${name}`, cancelled: false }
    const installedManifestPath = join(fake.profileDir, 'node_modules', name, 'package.json')
    if (fake.staleUpdates && existsSync(installedManifestPath)) {
      // pnpm minimumReleaseAge: "Already up to date", old version kept, exit 0.
      return ok
    }
    const exactVersion = /@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(target)?.[1] ?? null
    const version = fake.resolvedNpmVersionOnce ?? exactVersion ?? pkg.latest
    fake.resolvedNpmVersionOnce = null
    const installedVersion = existsSync(installedManifestPath)
      ? (JSON.parse(readFileSync(installedManifestPath, 'utf8')) as { version?: unknown }).version
      : undefined
    // Real pnpm treats an exact add as already satisfied when package bytes,
    // manifest, and lock all claim the same version. Only --force repairs a
    // directory whose bytes were corrupted behind that identity.
    if (exactVersion !== null
      && installedVersion === exactVersion
      && lockedNpmVersion(name) === exactVersion
      && !args.includes('--force')) {
      return ok
    }
    const previousSpec = readManifest().dependencies?.[name]
    const nextSpec = `^${version}`
    writeDep(name, nextSpec)
    const artifactContents = fake.artifactContentsOnNextAdd ?? pkg.versions[version].artifactContents
    fake.artifactContentsOnNextAdd = null
    writePkg(name, { version, ...(pkg.versions[version].manifest as object) }, pkg.versions[version].artifacts, artifactContents)
    writeNpmLock(name, nextSpec, version)
    if (fake.preserveManifestOnNextAdd) {
      fake.preserveManifestOnNextAdd = false
      if (previousSpec !== undefined) writeDep(name, previousSpec)
    }
    if (fake.failAddTargetOnce?.target === target) {
      const stderr = fake.failAddTargetOnce.stderr
      fake.failAddTargetOnce = null
      return { exitCode: 1, timedOut: false, stdout: '', stderr, cancelled: false }
    }
    if (fake.profileBundleOnNextAdd !== null) {
      appendProfileBundle(fake.profileBundleOnNextAdd)
      fake.profileBundleOnNextAdd = null
    }
    if (fake.failAfterWriteStderrOnce !== '') {
      const stderr = fake.failAfterWriteStderrOnce
      fake.failAfterWriteStderrOnce = ''
      return { exitCode: 1, timedOut: false, stdout: '', stderr, cancelled: false }
    }
    if (fake.buildScriptOutputOnce !== '') {
      const stdout = fake.buildScriptOutputOnce
      fake.buildScriptOutputOnce = ''
      return { ...ok, stdout }
    }
    return ok
  }
  return {
    TARGET_RE: /^[A-Za-z0-9@:./_#+~^=-]+$/,
    BOOT_ID: 'test-boot',
    progress: {
      active: false, target: '', startedAt: 0, lastLine: '',
      phase: null, done: 0, total: null, currentPackage: null,
      downloaded: null, size: null, ndjson: false, error: null, cancelling: false,
    },
    probePnpm: () => Promise.resolve(true),
    provisionPnpm: () => Promise.resolve(true),
    killChild: () => {},
    cancelActive: () => { if (!fake.running) return false; fake.cancelNext = true; return true },
    dshArgv: () => ({ file: 'dsh', args: [], cwd: undefined, viaShell: false }),
    winCmdShim: false,
    runDshPlugin,
  }
})

// ---------------------------------------------------------------- fake hot layer
const hot = vi.hoisted(() => ({
  mounts: [] as string[],
  disabled: new Set<string>(),
  groups: {} as Record<string, string[]>,
  groupOrder: [] as string[],
  /** Stands in for the channel line of state.json; undefined = never chosen. */
  channel: undefined as 'stable' | 'beta' | 'dev' | undefined,
  failNext: false,
}))
vi.mock('../src/hot.ts', () => ({
  cleanHotDir: () => {},
  readDisabledThemes: () => hot.disabled,
  writeDisabledThemes: (_dir: string, set: Set<string>) => { hot.disabled = new Set(set) },
  readDisabled: () => hot.disabled,
  writeDisabled: (_dir: string, set: Set<string>) => { hot.disabled = new Set(set) },
  readMarketState: () => ({ disabled: hot.disabled, groups: hot.groups, groupOrder: hot.groupOrder, channel: hot.channel }),
  // Carries `channel` because the real one does. A stand-in that silently
  // drops a field cannot fail when the code under test forgets to persist
  // it — which is exactly how the channel choice reached this suite with
  // zero coverage while four route tests passed.
  writeMarketState: (_dir: string, state: { disabled: Set<string>; groups: Record<string, string[]>; groupOrder: string[]; channel?: 'stable' | 'beta' | 'dev' }) => {
    hot.disabled = new Set(state.disabled)
    hot.groups = state.groups
    hot.groupOrder = state.groupOrder
    hot.channel = state.channel
  },
  listHotMounts: () => [...hot.mounts],
  hotMount: (_ctx: unknown, _dir: string, name: string) => {
    if (hot.failNext) {
      hot.failNext = false
      return Promise.resolve({ ok: false, reason: 'test: host cannot hot-mount' })
    }
    hot.mounts.push(name)
    return Promise.resolve({ ok: true, reason: null })
  },
  hotUnmount: (name: string) => {
    const index = hot.mounts.indexOf(name)
    if (index !== -1) hot.mounts.splice(index, 1)
    return Promise.resolve(index !== -1)
  },
  mountClientOnlyDeps: () => Promise.resolve([]),
}))

// ---------------------------------------------------------------- fake restart scheduler
const restartCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('../src/restart.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/restart.ts')>()
  return {
    ...original,
    // The real one SIGTERMs the process — fatal inside a test worker.
    scheduleRestart: () => {
      restartCalls.count += 1
      return { pid: 1, helperPid: 2, logOut: '/tmp/o', logErr: '/tmp/e' }
    },
  }
})

// ---------------------------------------------------------------- fake registry
const REGISTRY = {
  updated: '', count: 3,
  categories: { tool: { en: 'Tools' }, theme: { en: 'Themes' } },
  plugins: [
    { name: 'dsh-loop', owner: 'o', url: 'https://github.com/o/dsh-loop', category: 'tool', npm: 'dsh-loop', description: {}, install: '', added: '' },
    // The market's own entry: the release-channel specs need it installed,
    // because the channel applies to this package and no other.
    { name: 'dshmarket', owner: 'o', url: 'https://github.com/o/dshmarket', category: 'tool', npm: 'dshmarket', description: {}, install: '', added: '' },
    { name: 'theme-a', owner: 'o', url: 'https://github.com/o/theme-a', category: 'theme', npm: null, description: {}, install: '', added: '' },
    { name: 'theme-b', owner: 'o', url: 'https://github.com/o/theme-b', category: 'theme', npm: null, description: {}, install: '', added: '' },
    { name: 'skin-pack', owner: 'o', url: 'https://github.com/o/skin-pack', category: 'theme', npm: null, description: {}, install: '', added: '' },
    { name: 'dsh-excel-chat', owner: 'hccccc01333', url: 'https://github.com/hccccc01333/dsh-excel-chat', category: 'tool', npm: null, description: {}, install: '', added: '' },
    { name: 'dshmarket', owner: 'dsh-market', url: 'https://github.com/dsh-market/dsh-market', category: 'tool', npm: 'dshmarket', description: {}, install: '', added: '' },
    // #27 shape: the same repo listed twice under different names.
    { name: 'dsh-share', owner: 'h', url: 'https://github.com/h/dsh-share', category: 'tool', npm: 'dsh-share', description: {}, install: '', added: '' },
    { name: '@dsh-external/dsh-share', owner: 'h', url: 'https://github.com/h/dsh-share', category: 'tool', npm: null, description: {}, install: '', added: '' },
    { name: 'dsh-security-audit', owner: 'omdsh-dev', url: 'https://github.com/omdsh-dev/dsh-security-audit', category: 'tool', npm: null, description: {}, install: '', added: '' },
    // #66 shape: two DISTINCT plugins listed under one name (real examples:
    // dsh-usage-stats ×2, dsh-memory ×4 in the live registry).
    { name: 'dsh-usage-stats', owner: 'a1', url: 'https://github.com/a1/dsh-usage-stats', category: 'tool', npm: null, description: {}, install: '', added: '' },
    { name: 'dsh-usage-stats', owner: 'a2', url: 'https://github.com/a2/dsh-usage-stats', category: 'tool', npm: null, description: {}, install: '', added: '' },
    { name: 'dsh-blue-whale', owner: 'o', url: 'https://github.com/o/blue-whale', category: 'tool', npm: null, description: {}, install: '', added: '' },
    { name: 'dsh-patchy', owner: 'o', url: 'https://github.com/o/dsh-patchy', category: 'tool', npm: null, description: {}, install: '', added: '' },
    // Carries a prebuilt Release archive (#250): its install target is a
    // URL, not an npm name and not a github: shortcut.
    { name: 'dsh-prebuilt', owner: 'o', url: 'https://github.com/o/dsh-prebuilt', category: 'tool', npm: null, tarball: 'https://github.com/o/dsh-prebuilt/releases/download/v1.0.0/dsh-prebuilt.tgz', description: {}, install: '', added: '' },
    // Monorepo siblings: distinct plugins sharing one repo.
    { name: 'mono#plug-a', owner: 'm', url: 'https://github.com/m/mono/tree/main/packages/plug-a', category: 'tool', npm: null, description: {}, install: '', added: '' },
    { name: 'mono#plug-b', owner: 'm', url: 'https://github.com/m/mono/tree/main/packages/plug-b', category: 'tool', npm: null, description: {}, install: '', added: '' },
  ],
}
const registryModule = vi.hoisted(() => ({ loadRegistry: vi.fn(), forgetCatalog: vi.fn() }))
vi.mock('../src/registry.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/registry.ts')>(),
  ...registryModule,
}))
registryModule.loadRegistry.mockImplementation(() => Promise.resolve(REGISTRY))

// ---------------------------------------------------------------- testbed
import { marketVersion, mountMarketRoutes } from '../src/routes.ts'
import { resolveChannel } from '../src/channels.ts'
import { profileDir } from '../src/profile.ts'
import { runDshPlugin } from '../src/dsh-cli.ts'
import type { AgentsServiceLike } from '../src/agents.ts'

type Handler = (request: unknown, response: unknown) => void | Promise<void>

interface Testbed {
  dispatch(method: string, path: string, body?: unknown, options?: { crossOrigin?: boolean; remoteAddress?: string; forwarded?: boolean }): Promise<{ status: number; json: any }>
  loaderEntries: { options: { name: string; disabled?: boolean | null }; fiber?: unknown; update(o: { disabled: boolean | null }): Promise<void> }[]
  dispose(): void
}

function createTestbed(
  config: { profile?: string; allowRestart?: boolean; profileDirectory?: string; region?: 'global' | 'china' } = {},
  runtime?: Parameters<typeof mountMarketRoutes>[2],
  agents?: AgentsServiceLike,
): Testbed {
  const routes = new Map<string, Handler>()
  const loaderEntries: Testbed['loaderEntries'] = []
  const host = {
    webServer: {
      register(route: { path: string; handler: Handler }) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    loader: { entries: () => loaderEntries },
    plugin: () => ({ await: () => Promise.resolve(), dispose: () => {} }),
    on: () => () => {},
  }
  // Pinned so no test reaches the network to decide one. An unpinned region
  // probes at mount and lands a few milliseconds later, which would make
  // every install assertion depend on which registry answered first —
  // and, as this suite proved once, would let a spec resolve a REAL commit
  // through a REAL proxy. Specs that care about the mirrors set it.
  const dispose = mountMarketRoutes(host as never, { profile: 'web', region: 'global', ...config }, runtime, () => agents)
  async function dispatch(method: string, path: string, body?: unknown, options?: { crossOrigin?: boolean }) {
    const handler = routes.get(path.split('?')[0])
    if (handler === undefined) throw new Error(`no route: ${path}`)
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const request = {
      method, url: path,
      headers: {
        host: 'localhost:3080',
        origin: options?.crossOrigin ? 'https://evil.example' : 'http://localhost:3080',
        ...(options?.forwarded ? { 'x-forwarded-for': '10.0.0.9' } : {}),
      },
      socket: { remoteAddress: options?.remoteAddress ?? '127.0.0.1' },
      async *[Symbol.asyncIterator]() { yield* chunks },
    }
    let status = 0
    let payload = ''
    const response = {
      writeHead(code: number) { status = code },
      end(text?: string) { payload = text ?? '' },
    }
    await handler(request, response)
    let json: any = null
    try { json = JSON.parse(payload) } catch { /* non-JSON (logs route) */ }
    return { status, json, text: payload }
  }
  return { dispatch, loaderEntries, dispose }
}

// ---------------------------------------------------------------- suite
let home: string
let bed: Testbed

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshm-flow-'))
  process.env.DSH_HOME = home
  const dir = join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"dependencies":{}}')
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  fake.profileDir = dir
  fake.npm = {}
  fake.repos = {}
  fake.tarballs = {}
  fake.staleUpdates = false
  fake.resolvedNpmVersionOnce = null
  fake.hoistDiffTimes = 0
  fake.youngLockfile = false
  fake.gate = null
  fake.cancelNext = false
  fake.buildScriptOutputOnce = ''
  fake.failNextAddStderrOnce = ''
  fake.failAfterWriteStderrOnce = ''
  fake.preserveManifestOnNextAdd = false
  fake.artifactContentsOnNextAdd = null
  fake.failAddTargetOnce = null
  fake.profileBundleOnNextAdd = null
  fake.failInstallOnce = false
  fake.captureBundlesOnNextAdd = false
  fake.bundlesBeforeFallbackAdd = null
  fake.running = false
  fake.calls = []
  restartCalls.count = 0
  hot.mounts = []
  hot.disabled = new Set()
  hot.groups = {}
  hot.groupOrder = []
  hot.channel = undefined
  hot.failNext = false
  bed = createTestbed()
})
afterEach(() => {
  bed.dispose()
  vi.unstubAllGlobals()
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

function installedSpec(name: string): string | undefined {
  const manifest = JSON.parse(readFileSync(join(profileDir('web'), 'package.json'), 'utf8'))
  return manifest.dependencies?.[name]
}

function npmLockFixture(name: string, spec: string, version: string): string {
  return [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    `      ${name}:`,
    `        specifier: ${spec}`,
    `        version: ${version}`,
    'packages:',
    `  ${name}@${version}: {}`,
    'snapshots:',
    `  ${name}@${version}: {}`,
    '',
  ].join('\n')
}

describe('host-provided profile and package-operation seams', () => {
  it('mounts ordinary routes for a dotted, Unicode, spaced DSH profile name (#260)', async () => {
    bed.dispose()
    const profile = '测试 profile.011-rc.2'
    const ordinaryDir = profileDir(profile)
    mkdirSync(ordinaryDir, { recursive: true })
    writeFileSync(join(ordinaryDir, 'package.json'), '{"dependencies":{}}')
    writeFileSync(join(ordinaryDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    fake.profileDir = ordinaryDir
    bed = createTestbed({ profile })

    const installed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(installed.status).toBe(200)
    expect(installed.json).toMatchObject({ profile, installed: {} })
  })

  it('uses the explicit profile directory and injected status/setup/cancel operations', async () => {
    bed.dispose()
    const explicitDir = join(home, 'desktop-owned-profile')
    mkdirSync(explicitDir, { recursive: true })
    writeFileSync(join(explicitDir, 'package.json'), '{"dependencies":{"desktop-only":"1.0.0"}}')
    writeFileSync(join(explicitDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    fake.profileDir = explicitDir
    const probe = vi.fn(() => Promise.resolve(true))
    const provision = vi.fn(() => Promise.resolve({ ok: true }))
    const cancel = vi.fn(() => true)
    bed = createTestbed(
      { profile: '工作 profile', profileDirectory: explicitDir, allowRestart: false },
      { runPlugin: vi.fn() as never, probePnpm: probe, provisionPnpm: provision, cancelActive: cancel },
    )

    const installed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(installed.json).toMatchObject({
      profile: '工作 profile',
      installed: { 'desktop-only': '1.0.0' },
    })
    const exported = await bed.dispatch('GET', '/dsh-market/backup')
    const exportedManifest = exported.json.files.find((file: { path: string }) => file.path === 'package.json')
    expect(exportedManifest.json.dependencies).toEqual({ 'desktop-only': '1.0.0' })
    const status = await bed.dispatch('GET', '/dsh-market/status')
    expect(status.json).toMatchObject({
      pnpm: true, restart: false, selfManaged: false, installed: { 'desktop-only': '1.0.0' },
    })
    writeFileSync(join(explicitDir, 'package.json'), '{"dependencies":{"desktop-only":"1.0.0","dshmarket":"1.26.0"}}')
    expect((await bed.dispatch('GET', '/dsh-market/status')).json.selfManaged).toBe(true)
    expect(probe).toHaveBeenCalledTimes(2)
    expect((await bed.dispatch('POST', '/dsh-market/setup-pnpm', {})).json.ok).toBe(true)
    expect(provision).toHaveBeenCalledOnce()
    expect((await bed.dispatch('POST', '/dsh-market/cancel', {})).status).toBe(200)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('maps a generation-wide Desktop package-operation gate to conflict', async () => {
    bed.dispose()
    bed = createTestbed({}, {
      runPlugin: () => Promise.resolve({
        exitCode: 127,
        timedOut: false,
        stdout: '',
        stderr: 'another desktop pnpm operation is already running',
        cancelled: false,
        busy: true,
      }),
      probePnpm: () => Promise.resolve(true),
      provisionPnpm: () => Promise.resolve({ ok: true }),
      cancelActive: () => false,
    })

    const result = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(result.status).toBe(409)
    expect(result.json).toMatchObject({ ok: false, busy: true })
  })

  it('writes build approvals and git keys only in the host-authoritative Desktop profile', async () => {
    bed.dispose()
    const explicitDir = join(home, 'desktop-owned-profile')
    mkdirSync(join(explicitDir, 'node_modules', 'dsh-blue-whale'), { recursive: true })
    writeFileSync(join(explicitDir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-blue-whale': 'github:o/blue-whale' },
    }))
    writeFileSync(join(explicitDir, 'node_modules', 'dsh-blue-whale', 'package.json'), '{"name":"dsh-blue-whale"}')
    writeFileSync(join(explicitDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    fake.profileDir = explicitDir
    bed = createTestbed({ profile: '工作 profile', profileDirectory: explicitDir, allowRestart: false })

    const approve = await bed.dispatch('POST', '/dsh-market/approve-builds', { packages: ['dsh-blue-whale'] })
    expect(approve.status).toBe(200)
    expect(approve.json.approved).toContain('dsh-blue-whale')
    expect(approve.json.approved).toContain('dsh-blue-whale@git+https://github.com/o/blue-whale.git')
    const desktopYaml = readFileSync(join(explicitDir, 'pnpm-workspace.yaml'), 'utf8')
    expect(desktopYaml).toContain('dsh-blue-whale@git+https://github.com/o/blue-whale.git: true')
    expect(readFileSync(join(profileDir('web'), 'pnpm-workspace.yaml'), 'utf8')).not.toContain('dsh-blue-whale')
  })

  it('rolls a failed Desktop install back in the host-authoritative profile only', async () => {
    bed.dispose()
    const explicitDir = join(home, 'desktop-owned-profile')
    mkdirSync(explicitDir, { recursive: true })
    writeFileSync(join(explicitDir, 'package.json'), JSON.stringify({ dependencies: { 'desktop-only': '1.0.0' } }))
    writeFileSync(join(explicitDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    fake.profileDir = explicitDir
    fake.npm['dsh-loop'] = {
      latest: '1.0.0',
      versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } },
    }
    fake.failAfterWriteStderrOnce = '[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/ghost: Not Found - 404'
    bed = createTestbed({ profile: '工作 profile', profileDirectory: explicitDir, allowRestart: false })

    const result = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(result.status).toBe(502)
    const desktopManifest = JSON.parse(readFileSync(join(explicitDir, 'package.json'), 'utf8'))
    expect(desktopManifest.dependencies).toEqual({ 'desktop-only': '1.0.0' })
    const ordinaryManifest = JSON.parse(readFileSync(join(profileDir('web'), 'package.json'), 'utf8'))
    expect(ordinaryManifest.dependencies).toEqual({})
  })

  it('restores the previous Desktop pin when an update fails after a partial manifest write', async () => {
    bed.dispose()
    const explicitDir = join(home, 'desktop-owned-profile')
    mkdirSync(join(explicitDir, 'node_modules', 'dsh-loop'), { recursive: true })
    writeFileSync(join(explicitDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-loop': '^1.0.0' } }))
    writeFileSync(join(explicitDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    writeFileSync(join(explicitDir, 'node_modules', 'dsh-loop', 'package.json'), JSON.stringify({
      name: 'dsh-loop', version: '1.0.0', dsh: {}, main: 'lib/index.js',
    }))
    fake.profileDir = explicitDir
    fake.npm['dsh-loop'] = {
      latest: '1.2.0',
      versions: {
        '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] },
        '1.2.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] },
      },
    }
    fake.failAfterWriteStderrOnce = '[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/ghost: Not Found - 404'
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ version: '1.2.0' }), { status: 200 })))
    bed = createTestbed({ profile: '工作 profile', profileDirectory: explicitDir, allowRestart: false })

    const result = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(result.status).toBe(502)
    const desktopManifest = JSON.parse(readFileSync(join(explicitDir, 'package.json'), 'utf8'))
    expect(desktopManifest.dependencies).toEqual({ 'dsh-loop': '^1.0.0' })
    const installed = JSON.parse(readFileSync(join(explicitDir, 'node_modules', 'dsh-loop', 'package.json'), 'utf8')) as { version?: string }
    expect(installed.version).toBe('1.0.0')
    const ordinaryManifest = JSON.parse(readFileSync(join(profileDir('web'), 'package.json'), 'utf8'))
    expect(ordinaryManifest.dependencies).toEqual({})
  })

  it('applies the same-name different-repo guard to the host-authoritative Desktop profile', async () => {
    bed.dispose()
    const explicitDir = join(home, 'desktop-owned-profile')
    mkdirSync(explicitDir, { recursive: true })
    writeFileSync(join(explicitDir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-usage-stats': 'github:a1/dsh-usage-stats' },
    }))
    writeFileSync(join(explicitDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    fake.profileDir = explicitDir
    bed = createTestbed({ profile: '工作 profile', profileDirectory: explicitDir, allowRestart: false })

    const result = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/a2/dsh-usage-stats' })
    expect(result.status).toBe(400)
    expect(String(result.json.error)).toContain('同名冲突')
    expect(fake.calls).toEqual([])
    const desktopManifest = JSON.parse(readFileSync(join(explicitDir, 'package.json'), 'utf8'))
    expect(desktopManifest.dependencies['dsh-usage-stats']).toBe('github:a1/dsh-usage-stats')
  })
})

describe('backup and restore (#55)', () => {
  it('exports profile config, restores it, and reinstalls the dependency list', async () => {
    writeFileSync(join(profileDir('web'), 'cordis.patch.yml'), '- config: original')
    const exported = await bed.dispatch('GET', '/dsh-market/backup')
    expect(exported.status).toBe(200)
    expect(exported.json.format).toBe('dsh-profile-backup')
    expect(exported.json.files.some((file: { path: string }) => file.path === 'pnpm-lock.yaml')).toBe(false)

    writeFileSync(join(profileDir('web'), 'cordis.patch.yml'), '- config: changed')
    const restored = await bed.dispatch('POST', '/dsh-market/restore', { backup: exported.json })
    expect(restored.status).toBe(200)
    expect(restored.json.ok).toBe(true)
    expect(readFileSync(join(profileDir('web'), 'cordis.patch.yml'), 'utf8')).toBe('- config: original')
    expect(fake.calls.at(-1)?.[0]).toBe('install')
  })

  /** #205: a restored composition can reference a package that is not on
   * this machine — the reporter's case was a user patch inserting @dsh-rp/*.
   * That used to surface only at the NEXT boot, as a Loader
   * ERR_MODULE_NOT_FOUND with nothing connecting it to the restore. The
   * restore still completes: undoing it halfway can leave someone worse off
   * than the state they were escaping, and naming the packages is the part
   * they cannot do themselves. */
  it('names what the restored profile still cannot boot without', async () => {
    const exported = await bed.dispatch('GET', '/dsh-market/backup')
    // A user patch that loads a package no one installed here.
    writeFileSync(
      join(profileDir('web'), 'cordis.patch.yml'),
      '- insert:\n    - id: from-the-other-machine\n      name: "@dsh-rp/missing-plugin"\n',
    )
    const restored = await bed.dispatch('POST', '/dsh-market/restore', { backup: exported.json })

    expect(restored.status).toBe(200)
    expect(restored.json.ok, 'the restore itself still succeeds').toBe(true)
    const boot = (restored.json.bootErrors ?? []) as string[]
    expect(boot.join('\n')).toContain('@dsh-rp/missing-plugin')
    // The patch file is left exactly as restored — reported, not rewritten.
    expect(readFileSync(join(profileDir('web'), 'cordis.patch.yml'), 'utf8')).toContain('@dsh-rp/missing-plugin')
  })

  it('says nothing about booting when the restored profile is fine', async () => {
    const exported = await bed.dispatch('GET', '/dsh-market/backup')
    const restored = await bed.dispatch('POST', '/dsh-market/restore', { backup: exported.json })
    expect(restored.status).toBe(200)
    expect(restored.json.bootErrors).toBeUndefined()
  })

  /** #341: the log buffer dies with the process, so a failure that only
   * appears after a restart exported "(no events this session)" — the class
   * of bug that most needs a log is exactly the class whose log is gone. The
   * export now also states what the profile looks like right now, which does
   * not depend on anything having been recorded. */
  it('exports the profile state even when nothing happened this session', async () => {
    const manifestPath = join(profileDir('web'), 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dsh = { profile: { bundles: [...(manifest.dsh?.profile?.bundles ?? []), 'ghost-bundle'] } }
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const r = await bed.dispatch('GET', '/dsh-market/logs')
    expect(r.status).toBe(200)
    const text = r.text
    expect(text).toContain('## profile state')
    // The unresolvable row is called out, because that is the thing that
    // stops the next boot and a plain manifest listing does not show it.
    expect(text).toMatch(/ghost-bundle: NOT RESOLVED/)
  })

  /** REIN-280: the host version was the field investigations kept stalling
   * on. #293 ran three rounds before it emerged that the reporter's host was
   * newer than every attempt to reproduce; #404 is a plugin requiring a host
   * newer than the Desktop build it was installed on. The export never
   * carried it, so every such question had to be asked by hand. */
  it('names the host version in the export, or says plainly that it could not find one', async () => {
    const r = await bed.dispatch('GET', '/dsh-market/logs')
    expect(r.status).toBe(200)
    const line = r.text.split('\n').find(row => row.startsWith('dsh host: '))
    expect(line, `no "dsh host" line in:\n${r.text.slice(0, 400)}`).toBeDefined()
    // Under the test harness there is no locatable host package, and that
    // must read as a stated fact rather than a blank or "undefined" — an
    // empty field would look like a bug in the export itself.
    expect(line).toBe('dsh host: not locatable from this process')
    expect(r.text).not.toContain('undefined')
  })

  /** #346: a catalog entry can name a monorepo subpackage its author has
   * since moved. pnpm's failure for that is unrecognisable — the user sees a
   * resolver error with no reason to suspect the entry rather than their own
   * machine. Audited the live catalog: 8 of 224 subpath entries point at a
   * directory that is gone, 3 of them with no npm package to fall back on. */
  it('says a subpath entry is stale rather than letting pnpm look like the user fault', async () => {
    const calls: string[] = []
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      const href = String(url)
      if (href.includes('raw.githubusercontent.com')) {
        calls.push(href)
        return new Response('not found', { status: 404 })
      }
      return realFetch(url, init)
    }))
    try {
      fake.failNextAddStderrOnce = 'ERR_PNPM_FETCH_404 some unhelpful resolver message'
      const r = await bed.dispatch('POST', '/dsh-market/install', {
        url: 'https://github.com/m/mono/tree/main/packages/plug-a',
      })
      expect(r.status).toBe(502)
      expect(String(r.json.staleEntry)).toContain('packages/plug-a')
      // Probed only on the failure path, and only for the subpath form.
      expect(calls.some(href => href.includes('m/mono/HEAD/packages/plug-a/package.json'))).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects cross-origin restore requests', async () => {
    expect((await bed.dispatch('POST', '/dsh-market/restore', { backup: {} }, { crossOrigin: true })).status).toBe(403)
  })

  it('continues with remaining plugins when one dependency fails', async () => {
    const exported = await bed.dispatch('GET', '/dsh-market/backup')
    const manifest = exported.json.files.find((file: { path: string }) => file.path === 'package.json').json
    manifest.dependencies = { missing: '^1.0.0', 'dsh-loop': '^1.0.0' }
    manifest.dsh = { profile: { bundles: ['missing', 'dsh-loop'] } }
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    fake.failInstallOnce = true
    fake.captureBundlesOnNextAdd = true

    const restored = await bed.dispatch('POST', '/dsh-market/restore', { backup: exported.json })
    expect(restored.status).toBe(200)
    expect(restored.json.errors).toEqual([expect.objectContaining({ name: 'missing' })])
    expect(installedSpec('missing')).toBeUndefined()
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')
    expect(fake.bundlesBeforeFallbackAdd).toEqual([])
    const finalManifest = JSON.parse(readFileSync(join(profileDir('web'), 'package.json'), 'utf8'))
    expect(finalManifest.dsh.profile.bundles).toEqual(['dsh-loop'])
    // install fails once (store probe), add of the missing dep fails (store
    // probe again), then dsh-loop adds cleanly.
    expect(fake.calls.slice(-5).map(call => call[0])).toEqual(['install', 'store', 'add', 'store', 'add'])
  })
})

describe('install flow', () => {
  it('installs a curated plugin end to end and reports it installed', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    const r = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.installed['dsh-loop']).toBe('^1.0.0')
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')
    // Refresh-free activation: the new plugin was hot mounted.
    expect(r.json.hot).toBe(true)
    // P0-2: the operation response carries the per-package activation state.
    expect(r.json.activation['dsh-loop']).toMatchObject({ state: 'live', hot: true })
    const listed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(listed.json.installed['dsh-loop']).toBe('^1.0.0')
    expect(listed.json.activation['dsh-loop'].state).toBe('live')
  })

  it('reports host contracts declared as normal dependencies without rejecting the plugin', async () => {
    fake.npm['dsh-loop'] = {
      latest: '1.0.0',
      versions: {
        '1.0.0': {
          manifest: {
            dsh: {},
            main: 'lib/index.js',
            dependencies: {
              '@deepseek-ai/dsh-attachment': '^0.0.1-rc.1',
              '@deepseek-ai/dsh-llm': '^0.0.1-rc.1',
              '@deepseek-ai/dsh-system-prompt': '^0.0.1-rc.1',
              '@deepseek-ai/dsh-tools': '^0.0.1-rc.1',
            },
          },
          artifacts: ['lib/index.js'],
        },
      },
    }

    const installed = await bed.dispatch('POST', '/dsh-market/install', {
      url: 'https://github.com/o/dsh-loop',
    })
    expect(installed.status).toBe(200)
    expect(installed.json.ok).toBe(true)
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')
    expect(fake.calls.some(call => call[0] === 'remove' && call[1] === 'dsh-loop')).toBe(false)

    const profileManifest = JSON.parse(readFileSync(join(fake.profileDir, 'package.json'), 'utf8'))
    profileManifest.dependencies['plain-helper'] = '^1.0.0'
    writeFileSync(join(fake.profileDir, 'package.json'), JSON.stringify(profileManifest))
    mkdirSync(join(fake.profileDir, 'node_modules', 'plain-helper'), { recursive: true })
    writeFileSync(join(fake.profileDir, 'node_modules', 'plain-helper', 'package.json'), JSON.stringify({
      name: 'plain-helper',
      dependencies: { '@deepseek-ai/cordis': '^4.0.1' },
    }))

    const profilePath = join(fake.profileDir, 'package.json')
    const pluginPath = join(fake.profileDir, 'node_modules', 'dsh-loop', 'package.json')
    const profileBefore = readFileSync(profilePath)
    const pluginBefore = readFileSync(pluginPath)
    const listed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(listed.json.diagnostics.schema).toBe('dsh-market/diagnostics/v1')
    expect(listed.json.diagnostics.findings).toHaveLength(4)
    expect(listed.json.diagnostics.findings).toContainEqual(expect.objectContaining({
      code: 'shared-host-package-dependency',
      subject: { kind: 'package', name: 'dsh-loop' },
      evidence: {
        basis: 'manifest-declaration',
        dependency: '@deepseek-ai/dsh-tools',
        declaredRange: '^0.0.1-rc.1',
        declaredIn: 'dependencies',
      },
    }))
    expect(listed.json.diagnostics.findings.some((finding: { subject: { name: string } }) =>
      finding.subject.name === 'plain-helper',
    )).toBe(false)
    expect(readFileSync(profilePath)).toEqual(profileBefore)
    expect(readFileSync(pluginPath)).toEqual(pluginBefore)
  })

  it('does not diagnose in-box bundles hidden from the community installed set', async () => {
    const profilePath = join(fake.profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(profilePath, 'utf8'))
    manifest.dependencies['@deepseek-ai/dsh-base'] = '0.1.0-rc.6'
    writeFileSync(profilePath, JSON.stringify(manifest))
    const baseDir = join(fake.profileDir, 'node_modules', '@deepseek-ai', 'dsh-base')
    mkdirSync(baseDir, { recursive: true })
    writeFileSync(join(baseDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-base',
      version: '0.1.0-rc.6',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      dependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.6' },
    }))

    const listed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(listed.json.installed['@deepseek-ai/dsh-base']).toBeUndefined()
    expect(listed.json.diagnostics.findings).toEqual([])
  })

  it('reports inert activation for a client-only plugin the host cannot hot-mount (P0-2)', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: { client: {} }, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    hot.failNext = true
    const r = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.hot).toBe(false)
    expect(r.json.activation['dsh-loop']).toMatchObject({ state: 'inert', hot: false, bundle: false })
    expect(r.json.activation['dsh-loop'].reasons.join(' ')).toMatch(/dsh\.bundle/)
  })

  it('refuses sources outside the curated registry and cross-origin posts', async () => {
    const outside = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/evil/mal' })
    expect(outside.status).toBe(400)
    const cross = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' }, { crossOrigin: true })
    expect(cross.status).toBe(403)
  })

  it('retries around a peer on an unpublished host package, and only when the profile never asked for it (#289)', async () => {
    // pnpm auto-installs peers by default (since 8), and in this ecosystem a
    // peer on `@deepseek-ai/*` names what the dsh runtime injects — several
    // of those are never published. `@deepseek-ai/dsh-type-meta` is 404 on
    // npmjs and on every mirror, so a fresh profile installing ANY plugin
    // with such a peer died on a package nobody asked to download.
    //
    // Verified against pnpm 10.29.3 that `peerDependencyRules.ignoreMissing`
    // does NOT prevent the fetch — the flag is the only thing that works.
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    fake.failNextAddStderrOnce = '[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/@deepseek-ai%2Fdsh-type-meta: Not Found - 404\n\nThis error happened while installing a direct dependency of /home/u/.dsh/profiles/web'
    const installed = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(installed.status).toBe(200)
    const retried = fake.calls.find(call => call.includes('--config.auto-install-peers=false'))
    expect(retried, 'the install was not retried with peers off').toBeDefined()
    // The FIRST attempt keeps pnpm's default: a plugin whose peers really do
    // live on npm must still get them. The flag is a recovery, not a policy.
    expect(fake.calls[0]?.includes('--config.auto-install-peers=false')).toBe(false)
  })

  it('rolls back manifest residue when the add fails after pnpm wrote package.json (#65)', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    // pnpm writes the manifest, then fails resolving another (ghost/private)
    // direct dependency — the classic #65 shape. The ghost has to actually BE
    // in the manifest for that to be what this is: an unresolvable host
    // package the profile does not ask for is a peer pnpm auto-installed, and
    // the market retries around that one instead (#289).
    const ghostPath = join(profileDir('web'), 'package.json')
    const ghosted = JSON.parse(readFileSync(ghostPath, 'utf8'))
    ghosted.dependencies = { ...ghosted.dependencies, '@deepseek-ai/dsh-client-ui-theme-toggle': '^1.0.0' }
    ghosted.dsh = { profile: { bundles: ['@deepseek-ai/dsh-base'] } }
    writeFileSync(ghostPath, JSON.stringify(ghosted))
    fake.profileBundleOnNextAdd = 'dsh-loop'
    fake.failAfterWriteStderrOnce = '[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/@deepseek-ai%2Fdsh-client-ui-theme-toggle: Not Found - 404'
    const r = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(r.status).toBe(502)
    // The failed run's manifest write is rolled back — no ghost entry left
    // to break every later pnpm operation.
    expect(installedSpec('dsh-loop')).toBeUndefined()
    expect(installedSpec('@deepseek-ai/dsh-client-ui-theme-toggle')).toBe('^1.0.0')
    const rolledBackManifest = JSON.parse(readFileSync(ghostPath, 'utf8'))
    expect(rolledBackManifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
    // The classification names the unresolvable package, decoded.
    expect(String(r.json.stderr)).toContain('@deepseek-ai/dsh-client-ui-theme-toggle')
    expect(String(r.json.stderr)).toContain('幽灵依赖')
  })

  /** #339's safety net. The rollback that leaves an orphan bundle is fixed,
   * but the market issues one call and the HOST owns both writes, so any
   * future write path could do the same. Checking at the end of the operation
   * means the next restart is not the thing that discovers it. */
  it('names a bundle the profile declares but cannot resolve, before the next boot does', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    const manifestPath = join(profileDir('web'), 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    // A bundle row with nothing behind it: neither a dependency nor a package
    // on disk — exactly what a half-failed add used to leave.
    manifest.dsh = { profile: { bundles: [...(manifest.dsh?.profile?.bundles ?? []), 'ghost-bundle'] } }
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const r = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect((r.json.orphanBundles ?? []) as string[]).toContain('ghost-bundle')
  })

  it('says nothing about orphan bundles when every declared bundle resolves', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    const r = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(r.json.orphanBundles).toBeUndefined()
  })

  it('auto-recovers when the modules dir was built by another pnpm major (#20)', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    fake.hoistDiffTimes = 1
    const r = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    // add(fail) → install --no-frozen-lockfile → add(retry) …
    expect(fake.calls.slice(0, 3).map(c => c.filter(a => !a.startsWith('-')).join(' ')))
      .toEqual(['add dsh-loop', 'install', 'add dsh-loop'])
  })

  it('retargets a collection repo to its contained plugins via #path: (#18)', async () => {
    fake.repos['github:o/skin-pack'] = {
      name: 'skin-pack', manifest: { name: 'skin-pack', private: true }, junkChildren: ['whale-skin'],
    }
    fake.repos['github:o/skin-pack#path:/whale-skin'] = {
      name: 'whale-skin', manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'],
    }
    const r = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/skin-pack' })
    expect(r.status).toBe(200)
    expect(installedSpec('whale-skin')).toBeDefined()
    expect(installedSpec('skin-pack')).toBeUndefined()
  })

  it('inspects the current dsh-excel-chat bundle after collection retargeting', async () => {
    fake.repos['github:hccccc01333/dsh-excel-chat'] = {
      name: 'vera',
      manifest: {
        name: 'vera',
        version: '0.34.1',
        private: true,
        dependencies: {
          '@deepseek-ai/cordis': '^4.0.1',
          exceljs: '^4.4.0',
          fflate: '^0.8.3',
        },
      },
      junkChildren: ['bundle'],
    }
    fake.repos['github:hccccc01333/dsh-excel-chat#path:/bundle'] = {
      name: 'dsh-excel-chat',
      manifest: {
        name: 'dsh-excel-chat',
        version: '0.34.1',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        main: 'dist/index.js',
        dependencies: { exceljs: '^4.4.0', fflate: '^0.8.3' },
        peerDependencies: {
          '@deepseek-ai/cordis': '^4.0.1',
          '@deepseek-ai/dsh-attachment': '^0.1.0-rc.6',
          '@deepseek-ai/dsh-llm': '^0.1.0-rc.6',
          '@deepseek-ai/dsh-system-prompt': '^0.1.0-rc.6',
          '@deepseek-ai/dsh-tools': '^0.1.0-rc.6',
        },
      },
      artifacts: ['dist/index.js'],
    }

    const installed = await bed.dispatch('POST', '/dsh-market/install', {
      url: 'https://github.com/hccccc01333/dsh-excel-chat',
    })
    expect(installed.status).toBe(200)
    expect(installedSpec('vera')).toBeUndefined()
    expect(installedSpec('dsh-excel-chat')).toBeDefined()

    const listed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(listed.json.diagnostics.schema).toBe('dsh-market/diagnostics/v1')
    expect(listed.json.diagnostics.findings).toEqual([])
  })
})

describe('update flow — no npm publishing required', () => {
  beforeEach(async () => {
    // Seed: dsh-loop 1.0.0 installed; fake npm later advances latest.
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
  })

  function advanceNpmLatest(version: string, publishedHoursAgo = 1): void {
    fake.npm['dsh-loop'].latest = version
    fake.npm['dsh-loop'].versions[version] = { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] }
    const publishedAt = new Date(Date.now() - publishedHoursAgo * 3_600_000).toISOString()
    vi.stubGlobal('fetch', (url: string) => {
      const u = String(url)
      if (u.endsWith('/latest') && u.includes('registry.npmjs.org')) {
        return Promise.resolve(new Response(JSON.stringify({ version }), { status: 200 }))
      }
      if (u.includes('registry.npmjs.org')) {
        // Full metadata doc: dist-tags + publish times (the #45 evidence check).
        return Promise.resolve(new Response(JSON.stringify({
          'dist-tags': { latest: version },
          time: { [version]: publishedAt },
        }), { status: 200 }))
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
    })
  }

  it('flags the update and applies it', async () => {
    advanceNpmLatest('1.2.0')
    const updates = await bed.dispatch('GET', '/dsh-market/updates?force=1')
    expect(updates.json.updates['dsh-loop']).toMatchObject({ kind: 'npm', current: '1.0.0', latest: '1.2.0', updateAvailable: true })
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(installedSpec('dsh-loop')).toBe('^1.2.0')
    // NOT 'live'. This expectation used to say so, and it was wrong in a way
    // only a real host could show: replacing a package on disk does not
    // unload the module the process already imported, so the loader
    // inventory keeps reporting the name and the verdict keeps reading
    // "live" while the OLD build is what answers requests.
    //
    // Measured — the market updated from 1.11.3 to 1.12.2 with 1.12.2 on
    // disk, `/dsh-market/status` still reporting 1.11.3, an unchanged boot
    // id, and this route calling it hot-loaded in the same response.
    expect(r.json.activation['dsh-loop']).toMatchObject({ state: 'restart', hot: false })
  })

  it('refuses an update before mutation when package.json cannot be captured exactly', async () => {
    const manifestPath = join(fake.profileDir, 'package.json')
    const malformed = JSON.stringify({
      dependencies: { 'dsh-loop': '^1.0.0', 'keep-this-entry': '9.9.9' },
      dsh: { profile: 'not-an-object' },
    })
    writeFileSync(manifestPath, malformed)
    const callsBefore = fake.calls.length

    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })

    expect(r.status).toBe(500)
    expect(String(r.json.error)).toMatch(/dsh\.profile field is malformed|无法安全读取/)
    expect(fake.calls).toHaveLength(callsBefore)
    expect(readFileSync(manifestPath, 'utf8')).toBe(malformed)
  })

  it('rejects and rolls back when pnpm silently resolves latest to an older release', async () => {
    advanceNpmLatest('1.2.0')
    fake.npm['dsh-loop'].versions['0.9.0'] = { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] }
    fake.resolvedNpmVersionOnce = '0.9.0'

    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })

    expect(r.status).toBe(502)
    expect(r.json).toMatchObject({ ok: false, failureCode: 'DOWNGRADE_DETECTED' })
    expect(String(r.json.error)).toMatch(/拒绝降级|downgrade was rejected/)
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')
    const installed = JSON.parse(readFileSync(join(fake.profileDir, 'node_modules', 'dsh-loop', 'package.json'), 'utf8')) as { version?: string }
    expect(installed.version).toBe('1.0.0')
  })

  it('accepts a release published while the install was still running', async () => {
    advanceNpmLatest('1.2.0')
    fake.npm['dsh-loop'].versions['1.2.1'] = { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] }
    // The author publishes 1.2.1 while pnpm is still downloading 1.2.0. A big
    // plugin leaves minutes of window for that, and rolling the update back
    // would report a good, newer build as a failure.
    fake.resolvedNpmVersionOnce = '1.2.1'

    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })

    expect(r.json).toMatchObject({ ok: true })
    const installed = JSON.parse(readFileSync(join(fake.profileDir, 'node_modules', 'dsh-loop', 'package.json'), 'utf8')) as { version?: string }
    expect(installed.version).toBe('1.2.1')
  })

  it('rejects and rolls back when pnpm resolves a newer but unexpected release', async () => {
    advanceNpmLatest('1.2.0')
    fake.npm['dsh-loop'].versions['1.1.0'] = { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] }
    fake.resolvedNpmVersionOnce = '1.1.0'

    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })

    expect(r.status).toBe(502)
    expect(r.json).toMatchObject({ ok: false, failureCode: 'RESOLVED_VERSION_MISMATCH' })
    expect(String(r.json.error)).toMatch(/目标为 v1\.2\.0|targeted v1\.2\.0/)
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')
    const installed = JSON.parse(readFileSync(join(fake.profileDir, 'node_modules', 'dsh-loop', 'package.json'), 'utf8')) as { version?: string }
    expect(installed.version).toBe('1.0.0')
    expect(fake.calls.some(call => call.includes('dsh-loop@1.0.0'))).toBe(true)
  })

  it('exposes a versioned capability and update-check contract for plugin-owned UIs', async () => {
    advanceNpmLatest('1.2.0')
    const capabilities = await bed.dispatch('GET', '/dsh-market/api/v1/capabilities')
    expect(capabilities.status).toBe(200)
    expect(capabilities.json).toMatchObject({
      schema: 'dsh-market/update-api/v1',
      apiVersion: 1,
      // The compatibility promise is machine-readable, because one that lives
      // only in a markdown file is one no client ever reads. A release that
      // means to make this stable has to change it here, deliberately.
      stability: 'beta',
      profile: 'web',
      runtime: 'web',
      features: { check: true, update: true, progress: true, rollback: true, restart: true },
      restart: { supported: true, managedBy: 'market' },
      operationRetention: 'current-process',
      operationLimit: 50,
    })

    const check = await bed.dispatch('GET', '/dsh-market/api/v1/updates?name=dsh-loop&force=1')
    expect(check.status).toBe(200)
    expect(check.json).toMatchObject({
      schema: 'dsh-market/update-api/v1',
      package: {
        name: 'dsh-loop',
        source: 'npm',
        installedVersion: '1.0.0',
        latestVersion: '1.2.0',
        updateAvailable: true,
      },
    })
  })

  it('returns an operation id immediately and exposes progress until the update settles', async () => {
    advanceNpmLatest('1.2.0')
    let release!: () => void
    fake.gate = new Promise<void>((resolvePromise) => { release = resolvePromise })

    const accepted = await bed.dispatch('POST', '/dsh-market/api/v1/updates', {
      packageName: 'dsh-loop',
    })
    expect(accepted.status).toBe(202)
    expect(accepted.json.operation).toMatchObject({
      schema: 'dsh-market/update-api/v1',
      packageName: 'dsh-loop',
      state: 'running',
      beforeVersion: '1.0.0',
    })
    const operationId = String(accepted.json.operation.operationId)

    const concurrent = await bed.dispatch('POST', '/dsh-market/api/v1/updates', {
      packageName: 'dsh-loop',
    })
    expect(concurrent.status).toBe(409)
    expect(concurrent.json.failure).toMatchObject({ code: 'OPERATION_BUSY', retryable: true })

    const during = await bed.dispatch('GET', `/dsh-market/api/v1/operations?operationId=${operationId}`)
    expect(during.status).toBe(200)
    expect(during.json.operation.state).toBe('running')

    release()
    fake.gate = null
    let completed = during
    for (let attempt = 0; attempt < 30 && completed.json.operation.state === 'running'; attempt += 1) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
      completed = await bed.dispatch('GET', `/dsh-market/api/v1/operations?operationId=${operationId}`)
    }
    expect(completed.json.operation).toMatchObject({
      state: 'succeeded',
      beforeVersion: '1.0.0',
      installedVersion: '1.2.0',
      outcome: { restartRequired: true },
      failure: null,
    })
  })

  it('normalizes an agent guard refusal as a terminal operation failure', async () => {
    advanceNpmLatest('1.2.0')
    const guarded = createTestbed({}, undefined, {
      list: () => [{ id: 'main', status: 'running' }],
    })
    const accepted = await guarded.dispatch('POST', '/dsh-market/api/v1/updates', {
      packageName: 'dsh-loop',
    })
    expect(accepted.status).toBe(202)
    const operationId = String(accepted.json.operation.operationId)
    let completed = await guarded.dispatch('GET', `/dsh-market/api/v1/operations?operationId=${operationId}`)
    for (let attempt = 0; attempt < 30 && completed.json.operation.state === 'running'; attempt += 1) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
      completed = await guarded.dispatch('GET', `/dsh-market/api/v1/operations?operationId=${operationId}`)
    }
    expect(completed.json.operation).toMatchObject({
      state: 'failed',
      installedVersion: '1.0.0',
      failure: { code: 'AGENTS_RUNNING', retryable: true },
    })
    guarded.dispose()
  })

  it('keeps compatibility rollback private while exposing operation-scoped rollback', async () => {
    const hostPeerDir = join(fake.profileDir, 'node_modules', '@deepseek-ai', 'dsh-settings')
    mkdirSync(hostPeerDir, { recursive: true })
    writeFileSync(join(hostPeerDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-settings',
      version: '0.1.0-rc.6',
    }))
    fake.npm['dsh-loop'].latest = '1.2.0'
    fake.npm['dsh-loop'].versions['1.2.0'] = {
      manifest: {
        dsh: {},
        main: 'lib/index.js',
        peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7' },
      },
      artifacts: ['lib/index.js'],
    }
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ version: '1.2.0' }), { status: 200 })))

    const accepted = await bed.dispatch('POST', '/dsh-market/api/v1/updates', { packageName: 'dsh-loop' })
    const operationId = String(accepted.json.operation.operationId)
    let completed = await bed.dispatch('GET', `/dsh-market/api/v1/operations?operationId=${operationId}`)
    for (let attempt = 0; attempt < 30 && completed.json.operation.state === 'running'; attempt += 1) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
      completed = await bed.dispatch('GET', `/dsh-market/api/v1/operations?operationId=${operationId}`)
    }
    expect(completed.json.operation).toMatchObject({
      state: 'succeeded',
      installedVersion: '1.2.0',
      outcome: { rollback: { available: true, state: 'available' } },
    })
    expect(JSON.stringify(completed.json)).not.toContain('rollbackId')

    const rolledBack = await bed.dispatch('POST', '/dsh-market/api/v1/rollback', { operationId })
    expect(rolledBack.status).toBe(200)
    expect(rolledBack.json.operation).toMatchObject({
      state: 'rolled-back',
      installedVersion: '1.0.0',
      outcome: { restartRequired: true, rollback: { available: false, state: 'succeeded' } },
    })
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')
  })

  it('updates a mirror-installed plugin from GitHub, not from a same-named npm package', async () => {
    // The spelling older market versions wrote under a mirrored region is a
    // proxied codeload URL, not the `github:` shortcut. The
    // update route recognised only the shortcut, so these fell through to
    // the registry path — and `name@latest` for a GitHub-only plugin either
    // fails outright or installs whatever unrelated package happens to own
    // that name on npm. The second outcome is why this is a test and not a
    // comment: it is silent, and it is somebody else's code.
    const sha = 'b0e6c57ebeeb4796017864f5cd5c66e6ba0899ec'
    const proxied = `https://gh-proxy.com/https://codeload.github.com/o/r/tar.gz/${sha}`
    fake.repos['github:o/r'] = { name: 'plug-b', manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/r' })

    // Rewrite the manifest to the legacy China-region spelling.
    const manifestPath = join(profileDir('web'), 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dependencies['plug-b'] = proxied
    writeFileSync(manifestPath, JSON.stringify(manifest))

    fake.calls = []
    const updated = await bed.dispatch('POST', '/dsh-market/update', { name: 'plug-b' })
    expect(updated.status).toBe(200)
    const ran = fake.calls.at(-1)?.join(' ') ?? ''
    expect(ran, 'the update went to npm instead of the repo').toContain('github:o/r')
    expect(ran).not.toContain('plug-b@latest')
    // And not the pin it already had: an update that reinstalls the commit
    // on disk is an update that can never move.
    expect(ran).not.toContain(sha)
  })

  it('keeps a github subpath while dropping revision selectors during update (#281)', async () => {
    const target = 'github:m/mono#path:/packages/plug-a'
    fake.repos[target] = {
      name: 'plug-a', manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'],
    }
    const installed = await bed.dispatch('POST', '/dsh-market/install', {
      url: 'https://github.com/m/mono/tree/main/packages/plug-a',
    })
    expect(installed.status).toBe(200)
    expect(installedSpec('plug-a')).toBe(target)

    const direct = await bed.dispatch('POST', '/dsh-market/update', { name: 'plug-a' })
    expect(direct.status).toBe(200)
    expect(fake.calls.at(-1)).toContain(target)
    expect(installedSpec('plug-a')).toBe(target)

    // A ref and path may share pnpm's fragment. Updating still discards the
    // ref (so HEAD is re-resolved) but must not discard the package subpath.
    const manifestPath = join(profileDir('web'), 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dependencies['plug-a'] = 'github:m/mono#release-1&path:/packages/plug-a'
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const refreshed = await bed.dispatch('POST', '/dsh-market/update', { name: 'plug-a' })
    expect(refreshed.status).toBe(200)
    expect(fake.calls.at(-1)).toContain(target)
    expect(fake.calls.at(-1)).not.toContain('release-1')
    expect(installedSpec('plug-a')).toBe(target)
  })

  it('does not offer a rollback that the real CLI cannot execute for a github subpath', async () => {
    const OLD = 'a'.repeat(40)
    const NEW = 'b'.repeat(40)
    const target = 'github:m/mono#path:/packages/plug-a'
    fake.repos[target] = {
      name: 'plug-a', manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'],
    }
    expect((await bed.dispatch('POST', '/dsh-market/install', {
      url: 'https://github.com/m/mono/tree/main/packages/plug-a',
    })).status).toBe(200)
    writeFileSync(join(fake.profileDir, 'pnpm-lock.yaml'), `lockfileVersion: 9\n  resolution: {tarball: https://codeload.github.com/m/mono/tar.gz/${OLD}}\n`)
    const hostPeerDir = join(fake.profileDir, 'node_modules', '@deepseek-ai', 'dsh-settings')
    mkdirSync(hostPeerDir, { recursive: true })
    writeFileSync(join(hostPeerDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-settings', version: '0.1.0-rc.6' }))
    fake.repos[target] = {
      name: 'plug-a',
      manifest: {
        dsh: {},
        main: 'index.js',
        peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7' },
      },
      artifacts: ['index.js'],
      lockCommit: NEW,
    }

    const updated = await bed.dispatch('POST', '/dsh-market/update', { name: 'plug-a' })

    expect(updated.status).toBe(200)
    expect(updated.json.compatibility).toMatchObject({
      code: 'soft-incompatible',
      rollbackUnavailable: expect.stringMatching(/subpath.*unavailable/i),
    })
    expect(String(updated.json.compatibility.rollbackUnavailable)).toContain(OLD)
    expect(String(updated.json.compatibility.rollbackUnavailable)).toContain(' / ')
    expect(updated.json.compatibility.rollbackId).toBeUndefined()
    expect(fake.calls.flat().some(arg => arg.includes(`${OLD}&path:`))).toBe(false)
  })

  it('refuses an update while any agent is running, before pnpm is touched', async () => {
    advanceNpmLatest('1.2.0')
    const callsBefore = fake.calls.length
    const busyBed = createTestbed({}, undefined, {
      list: () => [
        { id: 'main', status: 'running' },
        { id: 'helper', status: 'idle' },
      ],
    })
    const r = await busyBed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(r.status).toBe(409)
    expect(r.json.agentsBusy).toBe(true)
    expect(r.json.runningAgents).toEqual(['main'])
    expect(String(r.json.error)).toMatch(/agent|main/)
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')
    expect(fake.calls.length).toBe(callsBefore)
    busyBed.dispose()
  })

  it('refuses install and uninstall while any agent is running, before pnpm is touched', async () => {
    const callsBefore = fake.calls.length
    const defaultStatus = await bed.dispatch('GET', '/dsh-market/status')
    expect(defaultStatus.json.agentGuardAvailable).toBe(false)
    const busyBed = createTestbed({}, undefined, {
      list: () => [{ id: 'main', status: 'running' }],
    })
    const busyStatus = await busyBed.dispatch('GET', '/dsh-market/status')
    expect(busyStatus.json.agentGuardAvailable).toBe(true)
    const install = await busyBed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(install.status).toBe(409)
    expect(install.json.agentsBusy).toBe(true)
    expect(install.json.runningAgents).toEqual(['main'])

    const uninstall = await busyBed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })
    expect(uninstall.status).toBe(409)
    expect(uninstall.json.agentsBusy).toBe(true)
    expect(uninstall.json.runningAgents).toEqual(['main'])

    expect(installedSpec('dsh-loop')).toBe('^1.0.0')
    expect(fake.calls.length).toBe(callsBefore)
    busyBed.dispose()
  })

  it('allows the same update when no agent reports running', async () => {
    advanceNpmLatest('1.2.0')
    const idleBed = createTestbed({}, undefined, {
      list: () => [
        { id: 'main', status: 'idle' },
        { id: 'helper', status: 'maintenance' },
        { id: 'mystery', status: undefined },
      ],
    })
    const r = await idleBed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.agentsBusy).toBeUndefined()
    expect(installedSpec('dsh-loop')).toBe('^1.2.0')
    idleBed.dispose()
  })

  it('refuses an update whose new version has no entry artifact (#159)', async () => {
    // The reported shape: a registry mirror served a source-only tarball for
    // a freshly published version — package.json and src/, no lib/. pnpm
    // exits 0, the version really did change, so every existing check passed
    // and the market said "updated". The next boot could not resolve the
    // entry and dsh web would not start at all.
    const manifestPath = join(fake.profileDir, 'package.json')
    const manifestBefore = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifestBefore.dependencies['dsh-loop'] = '~1.0.0'
    writeFileSync(manifestPath, JSON.stringify(manifestBefore))
    writeFileSync(join(fake.profileDir, 'pnpm-lock.yaml'), npmLockFixture('dsh-loop', '~1.0.0', '1.0.0'))
    fake.npm['dsh-loop'].versions['1.0.0'].artifactContents = { 'lib/index.js': 'old-build' }
    writeFileSync(join(fake.profileDir, 'node_modules', 'dsh-loop', 'lib', 'index.js'), 'old-build')
    fake.npm['dsh-loop'].latest = '1.3.0'
    fake.npm['dsh-loop'].versions['1.3.0'] = { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: [] }
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ version: '1.3.0' }), { status: 200 })))

    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(r.json.ok).toBe(false)
    expect(String(r.json.error)).toMatch(/入口|entry/)
    // The pin is rolled back AND the previous files are rematerialized —
    // restoring only package.json left the bad package on disk and the next
    // boot still failed (measured on a real host).
    expect(installedSpec('dsh-loop')).toBe('~1.0.0')
    expect(readFileSync(join(fake.profileDir, 'node_modules', 'dsh-loop', 'lib', 'index.js'), 'utf8')).toBe('old-build')
    expect(fake.calls.some(call => call.includes('dsh-loop@1.0.0'))).toBe(true)
  })

  it('rematerializes the exact old npm build and restores an absent pre-update lock', async () => {
    const lockfilePath = join(fake.profileDir, 'pnpm-lock.yaml')
    rmSync(lockfilePath, { force: true })
    fake.npm['dsh-loop'].versions['1.0.0'].artifactContents = { 'lib/index.js': 'old-build' }
    writeFileSync(join(fake.profileDir, 'node_modules', 'dsh-loop', 'lib', 'index.js'), 'old-build')
    fake.npm['dsh-loop'].latest = '1.3.0'
    fake.npm['dsh-loop'].versions['1.3.0'] = {
      manifest: { dsh: {}, main: 'lib/index.js' },
      artifacts: [],
    }
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ version: '1.3.0' }), { status: 200 })))

    const callsBefore = fake.calls.length
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })

    expect(r.status).toBe(502)
    expect(r.json.ok).toBe(false)
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')
    expect(readFileSync(join(fake.profileDir, 'node_modules', 'dsh-loop', 'lib', 'index.js'), 'utf8')).toBe('old-build')
    expect(existsSync(lockfilePath)).toBe(false)
    expect(fake.calls.slice(callsBefore).filter(call => call[0] === 'add')).toEqual([
      ['add', 'dsh-loop@latest'],
      ['add', '--force', '--config.minimumReleaseAge=0', 'dsh-loop@1.0.0'],
    ])
  })

  it('restores the captured GitHub commit when a successful update has no entry artifact', async () => {
    const OLD = 'a'.repeat(40)
    const NEW = 'b'.repeat(40)
    await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })
    fake.repos['github:owner/dsh-loop'] = {
      name: 'dsh-loop',
      manifest: { name: 'dsh-loop', version: '2.0.0', dsh: {}, main: 'lib/index.js' },
      artifacts: [],
      lockCommit: NEW,
      byCommit: {
        [OLD]: {
          manifest: { name: 'dsh-loop', version: '1.0.0', dsh: {}, main: 'lib/index.js' },
          artifacts: ['lib/index.js'],
        },
      },
    }
    const manifestPath = join(fake.profileDir, 'package.json')
    writeFileSync(manifestPath, JSON.stringify({ dependencies: { 'dsh-loop': 'github:owner/dsh-loop' } }))
    const pkgDir = join(fake.profileDir, 'node_modules', 'dsh-loop')
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-loop', version: '1.0.0', dsh: {}, main: 'lib/index.js' }))
    writeFileSync(join(pkgDir, 'lib', 'index.js'), 'old-git-build')
    writeFileSync(join(fake.profileDir, 'pnpm-lock.yaml'), `lockfileVersion: 9\n  resolution: {tarball: https://codeload.github.com/owner/dsh-loop/tar.gz/${OLD}}\n`)

    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })

    expect(r.status).toBe(502)
    expect(r.json.ok).toBe(false)
    expect(String(r.json.error)).toMatch(/入口|entry/)
    expect(installedSpec('dsh-loop')).toBe('github:owner/dsh-loop')
    expect(fake.calls.some(call => call.includes(`github:owner/dsh-loop#${OLD}`))).toBe(true)
    const lockfile = readFileSync(join(fake.profileDir, 'pnpm-lock.yaml'), 'utf8')
    expect(lockfile).toContain(OLD)
    expect(lockfile).not.toContain(NEW)
    const installed = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version?: string }
    expect(installed.version).toBe('1.0.0')
    expect(existsSync(join(pkgDir, 'lib', 'index.js'))).toBe(true)
  })

  it('keeps a repaired lock for an authoritative pinned codeload source', async () => {
    const OLD = 'a'.repeat(40)
    const NEW = 'b'.repeat(40)
    const oldUrl = `https://codeload.github.com/owner/dsh-loop/tar.gz/${OLD}`
    await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })
    fake.repos['github:owner/dsh-loop'] = {
      name: 'dsh-loop',
      manifest: { name: 'dsh-loop', version: '2.0.0', dsh: {}, main: 'lib/index.js' },
      artifacts: [],
      lockCommit: NEW,
    }
    fake.tarballs[oldUrl] = {
      name: 'dsh-loop',
      manifest: { name: 'dsh-loop', version: '1.0.0', dsh: {}, main: 'lib/index.js' },
      artifacts: ['lib/index.js'],
      artifactContents: { 'lib/index.js': 'old-codeload-build' },
    }
    writeFileSync(join(fake.profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-loop': oldUrl } }))
    const pkgDir = join(fake.profileDir, 'node_modules', 'dsh-loop')
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-loop', version: '1.0.0', dsh: {}, main: 'lib/index.js' }))
    writeFileSync(join(pkgDir, 'lib', 'index.js'), 'old-codeload-build')
    // The durable URL pins OLD, while this stale lock proves that restoring
    // captured bytes after the exact re-add would discard the repair.
    writeFileSync(join(fake.profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')

    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })

    expect(r.status).toBe(502)
    expect(r.json.ok).toBe(false)
    expect(installedSpec('dsh-loop')).toBe(oldUrl)
    expect(fake.calls.some(call => call.includes(oldUrl) && call.includes('--force'))).toBe(true)
    expect(readFileSync(join(pkgDir, 'lib', 'index.js'), 'utf8')).toBe('old-codeload-build')
    const repairedLock = readFileSync(join(fake.profileDir, 'pnpm-lock.yaml'), 'utf8')
    expect(repairedLock).toContain(OLD)
    expect(repairedLock).not.toContain(NEW)
  })

  it('refuses an update whose new patch would duplicate a loader entry id and boots would fail', async () => {
    // Start over with a bundle-shaped install: the patch declares one row.
    await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })
    fake.npm['dsh-loop'] = {
      latest: '1.0.0',
      versions: {
        '1.0.0': {
          manifest: { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'lib/index.js' },
          artifacts: ['lib/index.js', 'cordis.patch.yml'],
          artifactContents: {
            'cordis.patch.yml': '- insert:\n    - id: loop-id\n      name: dsh-loop\n',
          },
        },
      },
    }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    // The real dsh plugin command reconciles the bundle layer; FakeDsh does
    // not, so write what the host would have written.
    const manifest = JSON.parse(readFileSync(join(fake.profileDir, 'package.json'), 'utf8')) as Record<string, unknown>
    manifest.dsh = { profile: { bundles: ['dsh-loop'] } }
    writeFileSync(join(fake.profileDir, 'package.json'), JSON.stringify(manifest))

    // The new version is perfectly loadable; its patch inserts the same id
    // twice. hasLoadableEntry cannot see this — the next boot would refuse
    // the whole tree with "duplicate loader entry id".
    fake.npm['dsh-loop'].latest = '1.4.0'
    fake.npm['dsh-loop'].versions['1.4.0'] = {
      manifest: { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'lib/index.js' },
      artifacts: ['lib/index.js', 'cordis.patch.yml'],
      artifactContents: {
        'cordis.patch.yml': '- insert:\n    - id: loop-id\n      name: dsh-loop\n    - id: loop-id\n      name: dsh-loop\n',
      },
    }
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ version: '1.4.0' }), { status: 200 })))

    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(r.status).toBe(502)
    expect(r.json.ok).toBe(false)
    expect(String(r.json.error)).toMatch(/duplicate|重复/)
    // Rolled back to the previous manifest AND previous files.
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')
    const patch = readFileSync(join(fake.profileDir, 'node_modules', 'dsh-loop', 'cordis.patch.yml'), 'utf8')
    expect(patch.match(/id: loop-id/g)?.length).toBe(1)
    expect(fake.calls.some(call => call.includes('dsh-loop@1.0.0'))).toBe(true)
  })

  it('tells the truth when the rollback of a duplicate-id update cannot restore the files', async () => {
    await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })
    fake.npm['dsh-loop'] = {
      latest: '1.0.0',
      versions: {
        '1.0.0': {
          manifest: { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'lib/index.js' },
          artifacts: ['lib/index.js', 'cordis.patch.yml'],
          artifactContents: {
            'cordis.patch.yml': '- insert:\n    - id: loop-id\n      name: dsh-loop\n',
          },
        },
      },
    }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    const manifest = JSON.parse(readFileSync(join(fake.profileDir, 'package.json'), 'utf8')) as Record<string, unknown>
    manifest.dsh = { profile: { bundles: ['dsh-loop'] } }
    writeFileSync(join(fake.profileDir, 'package.json'), JSON.stringify(manifest))
    fake.npm['dsh-loop'].latest = '1.4.0'
    fake.npm['dsh-loop'].versions['1.4.0'] = {
      manifest: { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'lib/index.js' },
      artifacts: ['lib/index.js', 'cordis.patch.yml'],
      artifactContents: {
        'cordis.patch.yml': '- insert:\n    - id: loop-id\n      name: dsh-loop\n    - id: loop-id\n      name: dsh-loop\n',
      },
    }
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ version: '1.4.0' }), { status: 200 })))
    fake.failAddTargetOnce = { target: 'dsh-loop@1.0.0', stderr: 'ELIFECYCLE: exact rollback failed' }

    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(r.status).toBe(502)
    expect(r.json.ok).toBe(false)
    expect(String(r.json.error)).toMatch(/未能恢复|could not restore/)
    expect(String(r.json.error)).not.toMatch(/已自动回滚并恢复原版本文件|previous build was restored/)
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')
  })

  it('rolls a soft host-incompatible npm update back to exact bytes while preserving its range (#195)', async () => {
    const hostPeerDir = join(fake.profileDir, 'node_modules', '@deepseek-ai', 'dsh-settings')
    mkdirSync(hostPeerDir, { recursive: true })
    writeFileSync(join(hostPeerDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-settings', version: '0.1.0-rc.6' }))
    const manifestPath = join(fake.profileDir, 'package.json')
    const manifestBefore = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifestBefore.dependencies['dsh-loop'] = '~1.0.0'
    writeFileSync(manifestPath, JSON.stringify(manifestBefore))
    const lockBefore = npmLockFixture('dsh-loop', '~1.0.0', '1.0.0')
    writeFileSync(join(fake.profileDir, 'pnpm-lock.yaml'), lockBefore)
    fake.npm['dsh-loop'].versions['1.0.0'].artifactContents = { 'lib/index.js': 'old-build' }
    writeFileSync(join(fake.profileDir, 'node_modules', 'dsh-loop', 'lib', 'index.js'), 'old-build')
    fake.npm['dsh-loop'].latest = '1.2.0'
    fake.npm['dsh-loop'].versions['1.2.0'] = {
      manifest: {
        dsh: {},
        main: 'lib/index.js',
        peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7' },
      },
      artifacts: ['lib/index.js'],
      artifactContents: { 'lib/index.js': 'incompatible-build' },
    }
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ version: '1.2.0' }), { status: 200 })))

    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.compatibility).toMatchObject({
      code: 'soft-incompatible',
      risks: [{ plugin: 'dsh-loop', peer: '@deepseek-ai/dsh-settings', direction: 'belowMin' }],
    })
    expect(readFileSync(join(fake.profileDir, 'node_modules', 'dsh-loop', 'lib', 'index.js'), 'utf8')).toBe('incompatible-build')

    const callsBeforeRollback = fake.calls.length
    const rollback = await bed.dispatch('POST', '/dsh-market/rollback', { rollbackId: r.json.compatibility.rollbackId })
    expect(rollback.status).toBe(200)
    expect(rollback.json.rolledBack).toBe(true)
    const rollbackAdds = fake.calls.slice(callsBeforeRollback).filter(call => call[0] === 'add')
    expect(rollbackAdds).toEqual([
      ['add', '--force', '--config.minimumReleaseAge=0', 'dsh-loop@1.0.0'],
    ])
    expect(installedSpec('dsh-loop')).toBe('~1.0.0')
    const manifest = JSON.parse(readFileSync(join(fake.profileDir, 'node_modules', 'dsh-loop', 'package.json'), 'utf8')) as { version?: string }
    expect(manifest.version).toBe('1.0.0')
    expect(readFileSync(join(fake.profileDir, 'node_modules', 'dsh-loop', 'lib', 'index.js'), 'utf8')).toBe('old-build')
    expect(readFileSync(join(fake.profileDir, 'pnpm-lock.yaml'), 'utf8')).toBe(lockBefore)
  })

  it('reports a failed soft-incompatible exact rollback without claiming success', async () => {
    const hostPeerDir = join(fake.profileDir, 'node_modules', '@deepseek-ai', 'dsh-settings')
    mkdirSync(hostPeerDir, { recursive: true })
    writeFileSync(join(hostPeerDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-settings', version: '0.1.0-rc.6' }))
    const manifestPath = join(fake.profileDir, 'package.json')
    const manifestBefore = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifestBefore.dependencies['dsh-loop'] = '~1.0.0'
    writeFileSync(manifestPath, JSON.stringify(manifestBefore))
    writeFileSync(join(fake.profileDir, 'pnpm-lock.yaml'), npmLockFixture('dsh-loop', '~1.0.0', '1.0.0'))
    fake.npm['dsh-loop'].latest = '1.2.0'
    fake.npm['dsh-loop'].versions['1.2.0'] = {
      manifest: {
        dsh: {},
        main: 'lib/index.js',
        peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7' },
      },
      artifacts: ['lib/index.js'],
    }
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ version: '1.2.0' }), { status: 200 })))

    const updated = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(updated.status).toBe(200)
    expect(updated.json.compatibility).toMatchObject({ code: 'soft-incompatible' })
    fake.failAddTargetOnce = { target: 'dsh-loop@1.0.0', stderr: 'ELIFECYCLE: exact rollback failed' }
    const callsBeforeRollback = fake.calls.length

    const rollback = await bed.dispatch('POST', '/dsh-market/rollback', { rollbackId: updated.json.compatibility.rollbackId })

    expect(rollback.status).toBe(502)
    expect(rollback.json.rolledBack).toBe(false)
    expect(String(rollback.json.detail)).toContain('exact rollback failed')
    const rollbackAdds = fake.calls.slice(callsBeforeRollback).filter(call => call[0] === 'add')
    expect(rollbackAdds).toEqual([
      ['add', '--force', '--config.minimumReleaseAge=0', 'dsh-loop@1.0.0'],
    ])
    expect(installedSpec('dsh-loop')).toBe('~1.0.0')
  })

  it('refuses to claim a soft-incompatible npm rollback when the prior version is unknown', async () => {
    const hostPeerDir = join(fake.profileDir, 'node_modules', '@deepseek-ai', 'dsh-settings')
    mkdirSync(hostPeerDir, { recursive: true })
    writeFileSync(join(hostPeerDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-settings', version: '0.1.0-rc.6' }))
    const installedPath = join(fake.profileDir, 'node_modules', 'dsh-loop', 'package.json')
    const installedBefore = JSON.parse(readFileSync(installedPath, 'utf8'))
    delete installedBefore.version
    writeFileSync(installedPath, JSON.stringify(installedBefore))
    fake.npm['dsh-loop'].latest = '1.2.0'
    fake.npm['dsh-loop'].versions['1.2.0'] = {
      manifest: {
        dsh: {},
        main: 'lib/index.js',
        peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7' },
      },
      artifacts: ['lib/index.js'],
    }
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ version: '1.2.0' }), { status: 200 })))

    const updated = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(updated.status).toBe(200)
    expect(updated.json.compatibility).toMatchObject({ code: 'soft-incompatible' })
    expect(updated.json.compatibility.rollbackId).toBeUndefined()
    expect(String(updated.json.compatibility.rollbackUnavailable)).toMatch(/previously installed npm version.*automatic rollback is unavailable/i)
    expect(String(updated.json.compatibility.rollbackUnavailable)).toContain(' / ')
    const installedAfter = JSON.parse(readFileSync(installedPath, 'utf8')) as { version?: string }
    expect(installedAfter.version).toBe('1.2.0')
  })

  it('names the previous version when the host cannot execute its exact rollback target', async () => {
    bed.dispose()
    bed = createTestbed({}, {
      runPlugin: runDshPlugin,
      probePnpm: () => Promise.resolve(true),
      provisionPnpm: () => Promise.resolve({ ok: true }),
      cancelActive: () => false,
      supportsExactRollbackTarget: target => target !== 'dsh-loop@1.0.0',
    })
    const hostPeerDir = join(fake.profileDir, 'node_modules', '@deepseek-ai', 'dsh-settings')
    mkdirSync(hostPeerDir, { recursive: true })
    writeFileSync(join(hostPeerDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-settings', version: '0.1.0-rc.6' }))
    fake.npm['dsh-loop'].latest = '1.2.0'
    fake.npm['dsh-loop'].versions['1.2.0'] = {
      manifest: {
        dsh: {}, main: 'lib/index.js',
        peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7' },
      },
      artifacts: ['lib/index.js'],
    }
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ version: '1.2.0' }), { status: 200 })))

    const updated = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })

    expect(updated.status).toBe(200)
    expect(updated.json.compatibility.rollbackId).toBeUndefined()
    expect(String(updated.json.compatibility.rollbackUnavailable)).toContain('dsh-loop@1.0.0')
    expect(String(updated.json.compatibility.rollbackUnavailable)).toContain('v1.0.0')
    expect(String(updated.json.compatibility.rollbackUnavailable)).toMatch(/host cannot install.*automatic rollback is unavailable/i)
    expect(String(updated.json.compatibility.rollbackUnavailable)).toContain(' / ')
  })

  it('does not offer rollback from a stale npm importer that cannot preserve the manifest range', async () => {
    const hostPeerDir = join(fake.profileDir, 'node_modules', '@deepseek-ai', 'dsh-settings')
    mkdirSync(hostPeerDir, { recursive: true })
    writeFileSync(join(hostPeerDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-settings', version: '0.1.0-rc.6' }))
    const manifestPath = join(fake.profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dependencies['dsh-loop'] = '~1.0.0'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    // Installed bytes say 1.0.0, but the importer already claims 1.2.0.
    // Replacing this captured lock after an exact add would recreate the
    // mismatch; keeping pnpm's exact specifier would disagree with ~1.0.0.
    writeFileSync(join(fake.profileDir, 'pnpm-lock.yaml'), npmLockFixture('dsh-loop', '~1.0.0', '1.2.0'))
    fake.npm['dsh-loop'].latest = '1.2.0'
    fake.npm['dsh-loop'].versions['1.2.0'] = {
      manifest: {
        dsh: {}, main: 'lib/index.js',
        peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7' },
      },
      artifacts: ['lib/index.js'],
    }
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ version: '1.2.0' }), { status: 200 })))

    const updated = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })

    expect(updated.status).toBe(200)
    expect(updated.json.compatibility).toMatchObject({ code: 'soft-incompatible' })
    expect(updated.json.compatibility.rollbackId).toBeUndefined()
    expect(String(updated.json.compatibility.rollbackUnavailable)).toMatch(/pnpm-lock\.yaml does not match.*automatic rollback is unavailable/i)
    expect(String(updated.json.compatibility.rollbackUnavailable)).toContain('v1.0.0')
    expect(String(updated.json.compatibility.rollbackUnavailable)).toContain(' / ')
  })

  it('refuses an update rollback token after an out-of-band profile edit', async () => {
    const hostPeerDir = join(fake.profileDir, 'node_modules', '@deepseek-ai', 'dsh-settings')
    mkdirSync(hostPeerDir, { recursive: true })
    writeFileSync(join(hostPeerDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-settings', version: '0.1.0-rc.6' }))
    fake.npm['dsh-loop'].latest = '1.2.0'
    fake.npm['dsh-loop'].versions['1.2.0'] = {
      manifest: {
        dsh: {}, main: 'lib/index.js',
        peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7' },
      },
      artifacts: ['lib/index.js'],
    }
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ version: '1.2.0' }), { status: 200 })))
    const updated = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    const rollbackId = updated.json.compatibility.rollbackId as string
    expect(rollbackId).toMatch(/^rollback-/)

    // Simulate `dsh plugin`/pnpm (or a careful manual edit) running outside
    // Market's in-process mutation lock after the warning was shown. The
    // saved rollback owns the whole manifest+lock pair and must not erase it.
    const manifestPath = join(fake.profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
    manifest.dependencies['external-plugin'] = '1.0.0'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const callsBeforeRollback = fake.calls.length
    const rollback = await bed.dispatch('POST', '/dsh-market/rollback', { rollbackId })

    expect(rollback.status).toBe(400)
    expect(String(rollback.json.error)).toMatch(/profile changed|配置已发生变化/)
    expect((JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }).dependencies['external-plugin']).toBe('1.0.0')
    expect(fake.calls).toHaveLength(callsBeforeRollback)
  })

  it('serializes a toggle behind an in-flight exact rollback', async () => {
    const hostPeerDir = join(fake.profileDir, 'node_modules', '@deepseek-ai', 'dsh-settings')
    mkdirSync(hostPeerDir, { recursive: true })
    writeFileSync(join(hostPeerDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-settings', version: '0.1.0-rc.6' }))
    fake.npm['dsh-loop'].latest = '1.2.0'
    fake.npm['dsh-loop'].versions['1.2.0'] = {
      manifest: {
        dsh: {}, main: 'lib/index.js',
        peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7' },
      },
      artifacts: ['lib/index.js'],
    }
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ version: '1.2.0' }), { status: 200 })))
    const updated = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    const rollbackId = updated.json.compatibility.rollbackId as string
    expect(rollbackId).toMatch(/^rollback-/)

    let release!: () => void
    fake.gate = new Promise<void>((resolvePromise) => { release = resolvePromise })
    const rollback = bed.dispatch('POST', '/dsh-market/rollback', { rollbackId })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))

    const toggle = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: false })
    expect(toggle.status).toBe(409)
    expect(hot.disabled.has('dsh-loop')).toBe(false)

    release()
    fake.gate = null
    const restored = await rollback
    expect(restored.status).toBe(200)
    expect(restored.json.rolledBack).toBe(true)
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')
    expect(hot.disabled.has('dsh-loop')).toBe(false)
  })

  it('does not offer exact rollback for a replaceable release-archive URL', async () => {
    const oldUrl = 'https://github.com/o/dsh-prebuilt/releases/download/v1.0.0/dsh-prebuilt.tgz'
    const hostPeerDir = join(fake.profileDir, 'node_modules', '@deepseek-ai', 'dsh-settings')
    mkdirSync(hostPeerDir, { recursive: true })
    writeFileSync(join(hostPeerDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-settings', version: '0.1.0-rc.6' }))
    writeFileSync(join(fake.profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-loop': '^1.0.0', 'dsh-prebuilt': oldUrl },
    }))
    const packageDir = join(fake.profileDir, 'node_modules', 'dsh-prebuilt')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: 'dsh-prebuilt', version: '1.0.0', dsh: {}, main: 'index.js',
    }))
    writeFileSync(join(packageDir, 'index.js'), 'old-release-bytes')
    const lockBefore = `lockfileVersion: '9.0'\n# exact release source: ${oldUrl}\n`
    writeFileSync(join(fake.profileDir, 'pnpm-lock.yaml'), lockBefore)
    fake.tarballs[oldUrl] = {
      name: 'dsh-prebuilt',
      manifest: { name: 'dsh-prebuilt', version: '1.0.0', dsh: {}, main: 'index.js' },
      artifacts: ['index.js'],
      artifactContents: { 'index.js': 'old-release-bytes' },
    }
    fake.npm['dsh-prebuilt'] = {
      latest: '2.0.0',
      versions: {
        '2.0.0': {
          manifest: {
            name: 'dsh-prebuilt', dsh: {}, main: 'index.js',
            peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7' },
          },
          artifacts: ['index.js'],
          artifactContents: { 'index.js': 'incompatible-registry-bytes' },
        },
      },
    }
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ version: '2.0.0' }), { status: 200 })))

    const callsBefore = fake.calls.length
    const updated = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-prebuilt' })
    expect(updated.status).toBe(200)
    expect(updated.json.compatibility).toMatchObject({ code: 'soft-incompatible' })
    expect(updated.json.compatibility.rollbackId).toBeUndefined()
    expect(String(updated.json.compatibility.rollbackUnavailable)).toMatch(/immutable content identity.*unavailable/i)
    expect(String(updated.json.compatibility.rollbackUnavailable)).toContain('v1.0.0')
    expect(String(updated.json.compatibility.rollbackUnavailable)).toContain(' / ')
    expect(fake.calls.slice(callsBefore).some(call => call.includes('--force') && call.includes(oldUrl))).toBe(false)
    expect(installedSpec('dsh-prebuilt')).not.toBe(oldUrl)
    expect(readFileSync(join(packageDir, 'index.js'), 'utf8')).toBe('incompatible-registry-bytes')
    expect((JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version?: string }).version).toBe('2.0.0')
  })

  it('does not guess an unsupported protocol source into an npm rollback', async () => {
    const hostPeerDir = join(fake.profileDir, 'node_modules', '@deepseek-ai', 'dsh-settings')
    mkdirSync(hostPeerDir, { recursive: true })
    writeFileSync(join(hostPeerDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-settings', version: '0.1.0-rc.6' }))
    const manifestPath = join(fake.profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dependencies['dsh-loop'] = 'patch:dsh-loop@npm%3A1.0.0#./patches/dsh-loop.patch'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    fake.npm['dsh-loop'].latest = '1.2.0'
    fake.npm['dsh-loop'].versions['1.2.0'] = {
      manifest: {
        dsh: {}, main: 'lib/index.js',
        peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7' },
      },
      artifacts: ['lib/index.js'],
    }
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ version: '1.2.0' }), { status: 200 })))

    const callsBefore = fake.calls.length
    const updated = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })

    expect(updated.status).toBe(200)
    expect(updated.json.compatibility).toMatchObject({ code: 'soft-incompatible' })
    expect(updated.json.compatibility.rollbackId).toBeUndefined()
    expect(String(updated.json.compatibility.rollbackUnavailable)).toMatch(/not a supported exact rollback target/)
    expect(String(updated.json.compatibility.rollbackUnavailable)).toContain('v1.0.0')
    expect(String(updated.json.compatibility.rollbackUnavailable)).toContain(' / ')
    expect(fake.calls.slice(callsBefore).flat()).not.toContain('dsh-loop@1.0.0')
  })

  it('flags a cross-layer duplicate loader NAME the install introduced, and offers the same rollback (#230)', async () => {
    // The reported shape: a plugin the user already loads from their own
    // cordis.patch.yml, then installed as a bundle. The loader ids DIFFER
    // (`user-memory-evolve` vs `bundle-memory-evolve`), so the existing
    // duplicate-ID guard has nothing to catch — but the NAME now resolves
    // from two layers and only one wins after a restart.
    await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })
    writeFileSync(
      join(fake.profileDir, 'cordis.patch.yml'),
      '- insert:\n    - id: user-memory-evolve\n      name: memory-evolve\n',
    )
    fake.npm['dsh-loop'] = {
      latest: '1.0.0',
      versions: {
        '1.0.0': {
          manifest: { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'lib/index.js' },
          artifacts: ['lib/index.js', 'cordis.patch.yml'],
          artifactContents: {
            'cordis.patch.yml': '- insert:\n    - id: bundle-memory-evolve\n      name: memory-evolve\n',
          },
        },
      },
    }

    // FakeDsh does not reconcile the bundle stack (see the sibling
    // duplicate-id test), so register it up front. The package itself is
    // still absent, so the BEFORE snapshot has no bundle rows to compose —
    // the collision only exists once the install lands the patch file.
    const preManifest = JSON.parse(readFileSync(join(fake.profileDir, 'package.json'), 'utf8')) as Record<string, unknown>
    preManifest.dsh = { profile: { bundles: ['dsh-loop'] } }
    writeFileSync(join(fake.profileDir, 'package.json'), JSON.stringify(preManifest))

    const r = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    // No duplicate-ID conflict — the ids are distinct, which is exactly why
    // this went unreported before.
    expect(r.json.conflictGroups).toBeUndefined()
    expect(r.json.compatibility).toMatchObject({ code: 'soft-incompatible' })
    expect(r.json.compatibility.shadowedNames).toEqual([
      expect.objectContaining({ name: 'memory-evolve' }),
    ])
    // Two layers, named, so the banner can say which.
    expect(r.json.compatibility.shadowedNames[0].layers.length).toBeGreaterThanOrEqual(2)
    // The same rollback that undoes a peer risk undoes this.
    expect(typeof r.json.compatibility.rollbackId).toBe('string')
  })

  it('flags a soft host-incompatible install and rolls back the newly added plugin (#195)', async () => {
    await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })
    const hostPeerDir = join(fake.profileDir, 'node_modules', '@deepseek-ai', 'dsh-settings')
    mkdirSync(hostPeerDir, { recursive: true })
    writeFileSync(join(hostPeerDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-settings', version: '0.1.0-rc.6' }))
    fake.npm['dsh-loop'] = {
      latest: '1.0.0',
      versions: {
        '1.0.0': {
          manifest: {
            dsh: {},
            main: 'lib/index.js',
            peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7' },
          },
          artifacts: ['lib/index.js'],
        },
      },
    }
    const install = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(install.status).toBe(200)
    expect(install.json.compatibility).toMatchObject({ code: 'soft-incompatible' })

    const rollback = await bed.dispatch('POST', '/dsh-market/rollback', { rollbackId: install.json.compatibility.rollbackId })
    expect(rollback.status).toBe(200)
    expect(rollback.json.rolledBack).toBe(true)
    expect(installedSpec('dsh-loop')).toBeUndefined()
    expect(existsSync(join(fake.profileDir, 'node_modules', 'dsh-loop'))).toBe(false)
  })

  it('rolls a github update back to the captured commit (#195)', async () => {
    const OLD = 'a'.repeat(40)
    const NEW = 'b'.repeat(40)
    await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })

    fake.repos['github:owner/dsh-loop'] = {
      name: 'dsh-loop',
      manifest: { dsh: {}, main: 'lib/index.js', peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7' } },
      artifacts: ['lib/index.js'],
      lockCommit: NEW,
      byCommit: {
        [OLD]: { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] },
      },
    }

    const manifest = JSON.parse(readFileSync(join(fake.profileDir, 'package.json'), 'utf8')) as Record<string, unknown>
    // The durable spec itself is authoritative even when the lockfile has
    // been removed or is stale. Update detection already understands this
    // spelling; rollback must capture the same old commit from it.
    manifest.dependencies = { 'dsh-loop': `github:owner/dsh-loop#${OLD}` }
    writeFileSync(join(fake.profileDir, 'package.json'), JSON.stringify(manifest))
    const pkgDir = join(fake.profileDir, 'node_modules', 'dsh-loop')
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-loop', version: '0.0.1', dsh: {}, main: 'lib/index.js' }))
    writeFileSync(join(pkgDir, 'lib', 'index.js'), '')
    const hostPeerDir = join(fake.profileDir, 'node_modules', '@deepseek-ai', 'dsh-settings')
    mkdirSync(hostPeerDir, { recursive: true })
    writeFileSync(join(hostPeerDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-settings', version: '0.1.0-rc.6' }))
    writeFileSync(join(fake.profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')

    // Exercise the China path: the update target itself is already pinned
    // after HEAD is resolved through the mirror. Rollback must replace that
    // pin, not append a second `#` to it (#385).
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`001e${NEW} HEAD\0multi_ack\n`, { status: 200 })))
    bed.dispose()
    bed = createTestbed({ region: 'china' })

    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(r.status).toBe(200)
    expect(r.json.compatibility).toMatchObject({ code: 'soft-incompatible' })
    expect(r.json.compatibility.risks[0]).toMatchObject({ direction: 'belowMin' })

    const rollback = await bed.dispatch('POST', '/dsh-market/rollback', { rollbackId: r.json.compatibility.rollbackId })
    expect(rollback.status).toBe(200)
    expect(rollback.json.rolledBack).toBe(true)
    expect(installedSpec('dsh-loop')).toBe(`github:owner/dsh-loop#${OLD}`)
    expect(fake.calls.some(call => call.includes(`github:owner/dsh-loop#${NEW}`))).toBe(true)
    expect(fake.calls.some(call => call.includes(`github:owner/dsh-loop#${OLD}`) && call.includes('--force'))).toBe(true)
    expect(fake.calls.flat().some(arg => arg.includes(`#${NEW}#${OLD}`))).toBe(false)
    const restored = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(restored.peerDependencies).toBeUndefined()
    const repairedLock = readFileSync(join(fake.profileDir, 'pnpm-lock.yaml'), 'utf8')
    expect(repairedLock).toContain(OLD)
    expect(repairedLock).not.toContain(NEW)
  })

  it('never offers or performs a downgrade when the latest dist-tag is older (#64 by @ZeroOrigin64)', async () => {
    // A package whose `latest` tag was left on its first release while newer
    // prereleases shipped: latest 0.0.1 is BELOW the installed 1.0.0.
    advanceNpmLatest('0.0.1')
    const specBefore = installedSpec('dsh-loop')
    const updates = await bed.dispatch('GET', '/dsh-market/updates?force=1')
    expect(updates.json.updates['dsh-loop']).toMatchObject({ kind: 'npm', current: '1.0.0', latest: '0.0.1', updateAvailable: false })
    // Even called directly, the route refuses rather than rewriting the pin to `@latest`.
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(r.status).toBe(400)
    expect(String(r.json.error)).toContain('0.0.1')
    expect(installedSpec('dsh-loop')).toBe(specBefore)
    expect(fake.calls.some(c => c.includes('dsh-loop@latest'))).toBe(false)
  })

  it('surfaces the silent fresh-release hold as an actionable error, and force applies it (#22)', async () => {
    advanceNpmLatest('1.2.0') // published 1h ago — inside the safety window
    fake.staleUpdates = true // pnpm keeps 1.0.0 and exits 0
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(r.status).toBe(502)
    expect(r.json.ok).toBe(false)
    expect(r.json.stale).toBe(true)
    // Evidence-backed diagnosis (#45): the release really is young.
    expect(r.json.staleReason).toBe('release-age')
    expect(String(r.json.error)).toMatch(/立即更新|Update now/)
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')

    // The user clicks 「立即更新」: force bypasses the wait for THIS command only.
    fake.staleUpdates = false
    const forced = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop', force: true })
    expect(forced.status).toBe(200)
    expect(installedSpec('dsh-loop')).toBe('^1.2.0')
    const lastAdd = fake.calls[fake.calls.length - 1]
    expect(lastAdd).toContain('--config.minimumReleaseAge=0')
  })

  it('restores the previous build when an update fails after pnpm wrote new files (#65 follow-up)', async () => {
    advanceNpmLatest('1.2.0')
    fake.failAfterWriteStderrOnce = '[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/some-ghost-dep: Not Found - 404'
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(r.status).toBe(502)
    // pnpm had already bumped the spec and replaced the package files before
    // failing. A rollback is only complete when both return to the previous
    // build; otherwise the rejected release still runs after restart.
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')
    const installed = JSON.parse(readFileSync(join(fake.profileDir, 'node_modules', 'dsh-loop', 'package.json'), 'utf8')) as { version?: string }
    expect(installed.version).toBe('1.0.0')
    expect(fake.calls.some(call => call.includes('dsh-loop@1.0.0'))).toBe(true)
    expect(String(r.json.stderr)).toContain('some-ghost-dep')
  })

  it('restores prior bytes even when the failed update did not change the manifest range', async () => {
    advanceNpmLatest('1.2.0')
    fake.preserveManifestOnNextAdd = true
    fake.failAfterWriteStderrOnce = 'ELIFECYCLE: postinstall failed after replacing the package directory'

    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })

    expect(r.status).toBe(502)
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')
    const installed = JSON.parse(readFileSync(join(fake.profileDir, 'node_modules', 'dsh-loop', 'package.json'), 'utf8')) as { version?: string }
    expect(installed.version).toBe('1.0.0')
    expect(fake.calls.some(call => call.includes('dsh-loop@1.0.0'))).toBe(true)
  })

  it('forces exact rematerialization when rejected bytes still claim the old version and lock', async () => {
    advanceNpmLatest('1.2.0')
    const entry = join(fake.profileDir, 'node_modules', 'dsh-loop', 'lib', 'index.js')
    fake.npm['dsh-loop'].versions['1.0.0'].artifactContents = { 'lib/index.js': 'verified-old-bytes' }
    writeFileSync(entry, 'verified-old-bytes')
    // The attempted update resolves back to 1.0.0 but corrupts its directory
    // before failing. Manifest, installed version, and lock now all still say
    // 1.0.0, so pnpm's ordinary exact add is a no-op; only --force repairs it.
    fake.resolvedNpmVersionOnce = '1.0.0'
    fake.artifactContentsOnNextAdd = { 'lib/index.js': 'corrupted-rejected-bytes' }
    fake.failAfterWriteStderrOnce = 'ELIFECYCLE: failed after replacing same-version bytes'

    const callsBefore = fake.calls.length
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })

    expect(r.status).toBe(502)
    expect(readFileSync(entry, 'utf8')).toBe('verified-old-bytes')
    const rollbackAdds = fake.calls.slice(callsBefore).filter(call => call[0] === 'add')
    expect(rollbackAdds.at(-1)).toEqual([
      'add', '--force', '--config.minimumReleaseAge=0', 'dsh-loop@1.0.0',
    ])
  })

  it('reports a failed byte rollback without claiming the previous build was restored', async () => {
    advanceNpmLatest('1.2.0')
    const manifestPath = join(fake.profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dependencies['dsh-loop'] = '~1.0.0'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    writeFileSync(join(fake.profileDir, 'pnpm-lock.yaml'), npmLockFixture('dsh-loop', '~1.0.0', '1.0.0'))
    fake.failAfterWriteStderrOnce = 'ELIFECYCLE: update build failed after writing files'
    fake.failAddTargetOnce = { target: 'dsh-loop@1.0.0', stderr: 'ELIFECYCLE: rollback build failed' }

    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })

    expect(r.status).toBe(502)
    expect(String(r.json.error)).toMatch(/未能验证|could not be verified/)
    expect(String(r.json.error)).not.toMatch(/已自动回滚并恢复原版本文件|previous build was restored/)
    // The failed recovery command rewrites the manifest before exiting. The
    // route's finally block must still put the user's exact durable spelling
    // back, even though it cannot claim the recovery was verified.
    expect(installedSpec('dsh-loop')).toBe('~1.0.0')
    const installed = JSON.parse(readFileSync(join(fake.profileDir, 'node_modules', 'dsh-loop', 'package.json'), 'utf8')) as { version?: string }
    expect(installed.version).toBe('1.0.0')
  })

  it('restores the captured GitHub commit after an update command fails post-write', async () => {
    const OLD = 'a'.repeat(40)
    const NEW = 'b'.repeat(40)
    await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })
    fake.repos['github:owner/dsh-loop'] = {
      name: 'dsh-loop',
      manifest: { name: 'dsh-loop', version: '2.0.0', dsh: {}, main: 'lib/index.js' },
      artifacts: ['lib/index.js'],
      lockCommit: NEW,
      byCommit: {
        [OLD]: { manifest: { name: 'dsh-loop', version: '1.0.0', dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] },
      },
    }
    const manifestPath = join(fake.profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dependencies = { 'dsh-loop': 'github:owner/dsh-loop' }
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const pkgDir = join(fake.profileDir, 'node_modules', 'dsh-loop')
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-loop', version: '1.0.0', dsh: {}, main: 'lib/index.js' }))
    writeFileSync(join(pkgDir, 'lib', 'index.js'), '')
    writeFileSync(join(fake.profileDir, 'pnpm-lock.yaml'), `lockfileVersion: 9\n  resolution: {tarball: https://codeload.github.com/owner/dsh-loop/tar.gz/${OLD}}\n`)
    fake.failAfterWriteStderrOnce = 'ELIFECYCLE: git update failed after replacing files'

    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })

    expect(r.status).toBe(502)
    expect(r.json.error).toBeUndefined()
    expect(String(r.json.stderr)).toContain('git update failed')
    expect(installedSpec('dsh-loop')).toBe('github:owner/dsh-loop')
    expect(fake.calls.some(call => call.includes(`github:owner/dsh-loop#${OLD}`))).toBe(true)
    const lockfile = readFileSync(join(fake.profileDir, 'pnpm-lock.yaml'), 'utf8')
    expect(lockfile).toContain(OLD)
    expect(lockfile).not.toContain(NEW)
    const installed = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version?: string }
    expect(installed.version).toBe('1.0.0')
  })

  it('does not launch recovery when Desktop rejects the update as busy', async () => {
    advanceNpmLatest('1.2.0')
    bed.dispose()
    const runPlugin = vi.fn(() => Promise.resolve({
      exitCode: 127,
      timedOut: false,
      stdout: '',
      stderr: 'another desktop pnpm operation is already running',
      cancelled: false,
      busy: true,
    }))
    bed = createTestbed({}, {
      runPlugin,
      probePnpm: () => Promise.resolve(true),
      provisionPnpm: () => Promise.resolve({ ok: true }),
      cancelActive: () => false,
    })

    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })

    expect(r.status).toBe(409)
    expect(r.json).toMatchObject({ ok: false, busy: true })
    expect(runPlugin.mock.calls).toEqual([
      ['web', ['add', 'dsh-loop@latest']],
      ['web', ['store', 'path']],
    ])
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')
  })

  it('does not launch automatic recovery for a user-cancelled update', async () => {
    advanceNpmLatest('1.2.0')
    fake.cancelNext = true
    const callsBefore = fake.calls.length

    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })

    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: false, cancelled: true })
    expect(fake.calls.slice(callsBefore)).toHaveLength(1)
    expect(fake.calls.slice(callsBefore).flat()).not.toContain('dsh-loop@1.0.0')
  })

  it('surfaces blocked build scripts during an update so the approve banner can retry it (#69)', async () => {
    advanceNpmLatest('1.2.0')
    // A leftover invalid allowBuilds entry (pnpm's placeholder bug, #56)
    // makes the update's `add` re-evaluate a git-hosted dep and hard-fail.
    fake.failNextAddStderrOnce = '[ERR_PNPM_IGNORED_BUILDS]\nIgnored build scripts: dsh-github-intelligence@https://codeload.github.com/zoahdev/dsh-github-intelligence/tar.gz/abc123.'
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(r.status).toBe(502)
    expect(r.json.ok).toBe(false)
    // The blocked package (bare name), so the client shows approve-and-retry.
    expect(r.json.ignoredBuilds).toEqual(['dsh-github-intelligence'])
    // The bilingual classification is appended to the raw stack.
    expect(String(r.json.stderr)).toContain('允许构建脚本并重试')
  })

  it('does NOT blame the safety wait when the target release is old — honest unknown-cause message (#45)', async () => {
    advanceNpmLatest('1.2.0', 27) // published 27h ago — OUTSIDE the ~24h window
    fake.staleUpdates = true // version still did not move
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(r.status).toBe(502)
    expect(r.json.stale).toBe(true)
    expect(r.json.staleReason).toBe('unknown')
    // No unfounded "just released, wait a day" story…
    expect(String(r.json.error)).not.toMatch(/刚发布|just released/)
    // …but still an actionable next step (retry usually resolves it).
    expect(String(r.json.error)).toMatch(/立即更新|Update now/)
  })
})

describe('theme flow', () => {
  beforeEach(async () => {
    for (const name of ['theme-a', 'theme-b']) {
      fake.repos[`github:o/${name}`] = { name, manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] }
      await bed.dispatch('POST', '/dsh-market/install', { url: `https://github.com/o/${name}` })
    }
  })

  it('installs auto-activate and use-skin keeps themes mutually exclusive', async () => {
    // Installing theme-b (the later one) deactivated theme-a.
    expect(hot.mounts).toEqual(['theme-b'])
    expect(hot.disabled.has('theme-a')).toBe(true)
    // Switch back to theme-a via the UI.
    const r = await bed.dispatch('POST', '/dsh-market/use-skin', { name: 'theme-a' })
    expect(r.status).toBe(200)
    expect(hot.mounts).toEqual(['theme-a'])
    expect(hot.disabled.has('theme-b')).toBe(true)
    expect(hot.disabled.has('theme-a')).toBe(false)
  })

  it('rejects use-skin for non-theme or uninstalled packages', async () => {
    expect((await bed.dispatch('POST', '/dsh-market/use-skin', { name: 'dsh-loop' })).status).toBe(400)
    expect((await bed.dispatch('POST', '/dsh-market/use-skin', { name: 'ghost' })).status).toBe(400)
  })
})

describe('local-dev restore flow', () => {
  it('refuses a plain update on a link: spec, and restore:true swaps it to the catalog', async () => {
    fake.npm['dsh-loop'] = {
      latest: '1.0.0',
      versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } },
    }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    fake.npm['dsh-loop'].latest = '1.2.0'
    fake.npm['dsh-loop'].versions['1.2.0'] = { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] }
    const manifestPath = join(fake.profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
    manifest.dependencies['dsh-loop'] = 'link:../dsh-loop-dev'
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const blocked = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop' })
    expect(blocked.status).toBe(400)
    expect(String(blocked.json.error)).toMatch(/locally linked/)
    expect(installedSpec('dsh-loop')).toBe('link:../dsh-loop-dev')

    const restored = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop', restore: true })
    expect(restored.status, String(restored.json.error ?? '')).toBe(200)
    expect(restored.json.ok).toBe(true)
    expect(installedSpec('dsh-loop')).toBe('^1.2.0')
    expect(fake.calls.some(call => call[0] === 'add' && call.includes('dsh-loop@latest'))).toBe(true)
  })

  it('keeps #path: when restoring a monorepo checkout onto a collection-root catalog row', async () => {
    fake.repos['github:o/theme-a'] = { name: 'theme-a', manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] }
    const checkout = join(fake.profileDir, '..', 'theme-a-dev')
    mkdirSync(checkout, { recursive: true })
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({
      name: 'theme-a',
      version: '1.0.0',
      main: 'index.js',
      dsh: {},
      repository: { type: 'git', url: 'https://github.com/o/theme-a.git', directory: 'packages/skin' },
    }))
    writeFileSync(join(checkout, 'index.js'), '')
    const manifestPath = join(fake.profileDir, 'package.json')
    writeFileSync(manifestPath, JSON.stringify({
      dependencies: { 'theme-a': `link:${checkout}` },
      dsh: { profile: { bundles: ['theme-a'] } },
    }))
    mkdirSync(join(fake.profileDir, 'node_modules', 'theme-a'), { recursive: true })
    writeFileSync(join(fake.profileDir, 'node_modules', 'theme-a', 'package.json'), JSON.stringify({
      name: 'theme-a', version: '1.0.0', main: 'index.js', dsh: {},
      repository: { type: 'git', url: 'https://github.com/o/theme-a.git', directory: 'packages/skin' },
    }))

    await bed.dispatch('POST', '/dsh-market/update', { name: 'theme-a', restore: true })
    expect(fake.calls.some(call => call[0] === 'add' && call.some(arg => String(arg).includes('github:o/theme-a#path:/packages/skin')))).toBe(true)
  })

  it('refuses restore when the checkout still uses workspace: dependencies', async () => {
    fake.repos['github:o/theme-a'] = { name: 'theme-a', manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] }
    const checkout = join(fake.profileDir, '..', 'theme-a-ws')
    mkdirSync(checkout, { recursive: true })
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({
      name: 'theme-a',
      version: '1.0.0',
      main: 'index.js',
      dsh: {},
      dependencies: { '@dsh-cowork/core': 'workspace:^' },
      repository: { type: 'git', url: 'https://github.com/o/theme-a.git', directory: 'packages/skin' },
    }))
    writeFileSync(join(fake.profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'theme-a': `link:${checkout}` },
      dsh: { profile: { bundles: ['theme-a'] } },
    }))
    mkdirSync(join(fake.profileDir, 'node_modules', 'theme-a'), { recursive: true })
    writeFileSync(join(fake.profileDir, 'node_modules', 'theme-a', 'package.json'), JSON.stringify({
      name: 'theme-a',
      version: '1.0.0',
      dependencies: { '@dsh-cowork/core': 'workspace:^' },
      repository: { type: 'git', url: 'https://github.com/o/theme-a.git', directory: 'packages/skin' },
    }))
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'theme-a', restore: true })
    expect(r.status).toBe(400)
    expect(String(r.json.error)).toMatch(/workspace/)
    expect(installedSpec('theme-a')).toBe(`link:${checkout}`)
  })

  it('returns 400 when restore cannot find a catalog entry', async () => {
    writeFileSync(join(fake.profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'mystery-plug': 'link:../mystery' },
    }))
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'mystery-plug', restore: true })
    expect(r.status).toBe(400)
    expect(String(r.json.error)).toMatch(/No catalog entry/)
  })

  /** #250 landed a third target shape — a prebuilt Release archive URL —
   * after this restore path was written. It is neither an npm name nor a
   * `github:` shortcut, so the dist-tag branch would have handed pnpm
   * `https://…/dsh-prebuilt.tgz@latest`. Only a bare npm name takes a tag. */
  it('restores onto a prebuilt Release tarball without gluing a dist-tag to the URL', async () => {
    writeFileSync(join(fake.profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-prebuilt': 'link:../dsh-prebuilt-dev' },
    }))
    mkdirSync(join(fake.profileDir, 'node_modules', 'dsh-prebuilt'), { recursive: true })
    writeFileSync(join(fake.profileDir, 'node_modules', 'dsh-prebuilt', 'package.json'), JSON.stringify({
      name: 'dsh-prebuilt', version: '1.0.0', main: 'index.js', dsh: {},
      repository: { type: 'git', url: 'https://github.com/o/dsh-prebuilt.git' },
    }))
    fake.tarballs['https://github.com/o/dsh-prebuilt/releases/download/v1.0.0/dsh-prebuilt.tgz'] = {
      name: 'dsh-prebuilt',
      manifest: { name: 'dsh-prebuilt', version: '1.0.0', main: 'index.js', dsh: {} },
      artifacts: ['index.js'],
    }
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-prebuilt', restore: true })
    expect(r.status, String(r.json.error ?? '')).toBe(200)
    const added = fake.calls.filter(call => call[0] === 'add').flat().map(String)
    expect(added.some(arg => arg === 'https://github.com/o/dsh-prebuilt/releases/download/v1.0.0/dsh-prebuilt.tgz')).toBe(true)
    expect(added.some(arg => arg.includes('.tgz@'))).toBe(false)
  })

  it('refuses restore:true when the installed spec is not local', async () => {
    writeFileSync(join(fake.profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-loop': '^1.0.0' },
    }))
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dsh-loop', restore: true })
    expect(r.status).toBe(400)
    expect(String(r.json.error)).toMatch(/Restore only applies/)
    expect(installedSpec('dsh-loop')).toBe('^1.0.0')
  })

  it('keeps the market development link local', async () => {
    writeFileSync(join(fake.profileDir, 'package.json'), JSON.stringify({
      dependencies: { dshmarket: 'link:../dshmarket-dev' },
    }))
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dshmarket', restore: true })
    expect(r.status).toBe(400)
    expect(String(r.json.error)).toMatch(/local development link/)
    expect(installedSpec('dshmarket')).toBe('link:../dshmarket-dev')
  })

  it('rolls a #path: restore back to the local spec when the catalog build introduces risks', async () => {
    fake.repos['github:o/theme-a'] = {
      name: 'theme-a',
      manifest: { dsh: {}, main: 'index.js', peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7' } },
      artifacts: ['index.js'],
    }
    const checkout = join(fake.profileDir, '..', 'theme-a-risk')
    mkdirSync(checkout, { recursive: true })
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({
      name: 'theme-a', version: '1.0.0', main: 'index.js', dsh: {},
      repository: { type: 'git', url: 'https://github.com/o/theme-a.git', directory: 'packages/skin' },
    }))
    writeFileSync(join(checkout, 'index.js'), '')
    writeFileSync(join(fake.profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'theme-a': `link:${checkout}` },
    }))
    mkdirSync(join(fake.profileDir, 'node_modules', 'theme-a'), { recursive: true })
    writeFileSync(join(fake.profileDir, 'node_modules', 'theme-a', 'package.json'), JSON.stringify({
      name: 'theme-a', version: '1.0.0', main: 'index.js', dsh: {},
      repository: { type: 'git', url: 'https://github.com/o/theme-a.git', directory: 'packages/skin' },
    }))
    const hostPeerDir = join(fake.profileDir, 'node_modules', '@deepseek-ai', 'dsh-settings')
    mkdirSync(hostPeerDir, { recursive: true })
    writeFileSync(join(hostPeerDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-settings', version: '0.1.0-rc.6' }))

    const restored = await bed.dispatch('POST', '/dsh-market/update', { name: 'theme-a', restore: true })
    expect(restored.status, String(restored.json.error ?? '')).toBe(200)
    expect(restored.json.compatibility).toMatchObject({ code: 'soft-incompatible' })
    expect(installedSpec('theme-a')).toContain('#path:/packages/skin')

    const rollback = await bed.dispatch('POST', '/dsh-market/rollback', { rollbackId: restored.json.compatibility.rollbackId })
    expect(rollback.status).toBe(200)
    expect(rollback.json.rolledBack).toBe(true)
    expect(installedSpec('theme-a')).toBe(`link:${checkout}`)
  })
})

describe('uninstall flow', () => {
  it('removes the plugin (live when hot mounted) and protects the market itself', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    const r = await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })
    expect(r.status).toBe(200)
    expect(r.json.hot).toBe(true)
    expect(installedSpec('dsh-loop')).toBeUndefined()
    expect(hot.mounts).toEqual([])

    expect((await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dshmarket' })).status).toBe(400)
    expect((await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'ghost' })).status).toBe(400)
  })

  it('refuses to remove a package still inserted by the user patch (#165)', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    const patch = join(fake.profileDir, 'cordis.patch.yml')
    const patchText = [
      '- insert:',
      '    - id: user-loop',
      "      name: 'dsh-loop/runtime'",
      '',
    ].join('\n')
    writeFileSync(patch, patchText)
    const callsBefore = fake.calls.length

    const r = await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })

    expect(r.status).toBe(409)
    expect(r.json).toMatchObject({
      userPatchReferenced: true,
      patchReferences: ['dsh-loop/runtime'],
    })
    expect(String(r.json.error)).toContain('cordis.patch.yml')
    expect(installedSpec('dsh-loop')).toBeDefined()
    expect(readFileSync(patch, 'utf8')).toBe(patchText)
    expect(fake.calls.slice(callsBefore).some(call => call[0] === 'remove')).toBe(false)
  })

  it('does not confuse a neighbouring package name for a user-patch reference (#165)', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    writeFileSync(join(fake.profileDir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: neighbour',
      '      name: dsh-loop-extra',
      '',
    ].join('\n'))

    const r = await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })

    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(installedSpec('dsh-loop')).toBeUndefined()
  })

  it('refuses to uninstall when the user patch cannot be inspected safely (#165)', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    const patch = join(fake.profileDir, 'cordis.patch.yml')
    const patchText = '- insert:\n    - id: broken\n      name: [\n'
    writeFileSync(patch, patchText)
    const callsBefore = fake.calls.length

    const r = await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })

    expect(r.status).toBe(409)
    expect(r.json.userPatchInspectionFailed).toBe(true)
    expect(String(r.json.error)).toContain('cordis.patch.yml')
    expect(installedSpec('dsh-loop')).toBeDefined()
    expect(readFileSync(patch, 'utf8')).toBe(patchText)
    expect(fake.calls.slice(callsBefore).some(call => call[0] === 'remove')).toBe(false)
    // Refusing is right, but refusing with no way through is not: the market
    // cannot name a row to fix here, and wanting to uninstall usually means
    // something is already broken. The refusal advertises the escape.
    expect(r.json.forceable).toBe(true)
  })

  it('lets an unreadable user patch be forced past, but never a definite reference (#165)', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    const patch = join(fake.profileDir, 'cordis.patch.yml')

    // Unreadable: forceable, and the user patch is still left untouched.
    const unreadable = '- insert:\n    - id: broken\n      name: [\n'
    writeFileSync(patch, unreadable)
    const forced = await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop', force: true })
    expect(forced.status, String(forced.json.error ?? '')).toBe(200)
    expect(installedSpec('dsh-loop')).toBeUndefined()
    expect(readFileSync(patch, 'utf8')).toBe(unreadable)

    // A patch that DEFINITELY names the package is not forceable: there the
    // user has a concrete row to remove, so an override would only help them
    // break the next boot.
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    writeFileSync(patch, '- insert:\n    - id: mine\n      name: dsh-loop\n')
    const refused = await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop', force: true })
    expect(refused.status).toBe(409)
    expect(refused.json.userPatchReferenced).toBe(true)
    expect(refused.json.forceable).toBeUndefined()
    expect(installedSpec('dsh-loop')).toBeDefined()
  })

  it('uninstall succeeds even when the lockfile holds a too-young release (#39)', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    // pnpm 11 verifies the WHOLE lockfile before any mutation; a package
    // published inside the safety window fails that check and bricks every
    // later add/remove until the one-shot override is passed.
    fake.youngLockfile = true
    const r = await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(installedSpec('dsh-loop')).toBeUndefined()
    const removes = fake.calls.filter(c => c[0] === 'remove')
    expect(removes[removes.length - 1]).toContain('--config.minimumReleaseAge=0')
  })

  it('reconciles the manifest when a remove fails halfway (half-uninstall)', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(installedSpec('dsh-loop')).toBeDefined()
    // pnpm dies AFTER deleting node_modules but BEFORE saving package.json
    // — disk truth and the manifest disagree; the next boot would fail to
    // activate the ghost dependency. The market must finish the removal.
    fake.failNextRemoveHalfGone = true
    const r = await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })
    expect(r.status).toBe(502)
    expect(r.json.ok).toBe(false)
    expect(r.json.reconciled).toBe(true)
    // Both manifest lists now match disk truth.
    expect(installedSpec('dsh-loop')).toBeUndefined()
    const manifest = JSON.parse(readFileSync(join(profileDir('web'), 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
    expect(manifest.dsh?.profile?.bundles ?? []).not.toContain('dsh-loop')
  })

  it('keeps the manifest when a failed remove left the package intact', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    // pnpm fails without touching anything (a non-retryable EPERM): disk
    // intact → the user may simply retry, so the manifest must stay as it was.
    fake.failNextRemoveOnce = 'EPERM: operation not permitted, rename …\\node_modules\\dsh-loop'
    const r = await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })
    expect(r.status).toBe(502)
    expect(r.json.ok).toBe(false)
    expect(r.json.reconciled).toBeUndefined()
    expect(installedSpec('dsh-loop')).toBeDefined()
  })
})

describe('duplicate alias guard (#27)', () => {
  it('refuses installing the same repo again under another catalog name', async () => {
    fake.npm['dsh-share'] = { latest: '0.2.0', versions: { '0.2.0': { manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] } } }
    expect((await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/h/dsh-share' })).status).toBe(200)
    // The alias entry (same repo, different display name) must be rejected —
    // a second install would create a duplicate loader entry id and brick boot.
    const dup = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/h/dsh-share' })
    expect(dup.status).toBe(400)
    expect(String(dup.json.error)).toContain('dsh-share')
  })

  it('refuses a same-named plugin from a DIFFERENT repo with an honest name-conflict error (#66)', async () => {
    fake.repos['github:a1/dsh-usage-stats'] = { name: 'dsh-usage-stats', manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] }
    const first = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/a1/dsh-usage-stats' })
    expect(first.json.ok).toBe(true)
    // The other same-named plugin is NOT "the same plugin already installed"
    // (that message would be a lie) — but pnpm would silently replace a1's
    // dependency entry, so the install is refused as a name conflict.
    const second = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/a2/dsh-usage-stats' })
    expect(second.status).toBe(400)
    expect(String(second.json.error)).toContain('同名冲突')
    // a1's install is untouched.
    expect(installedSpec('dsh-usage-stats')).toBe('github:a1/dsh-usage-stats')
  })

  it('does NOT block sibling subpackages of one monorepo', async () => {
    fake.repos['github:m/mono#path:/packages/plug-a'] = { name: 'plug-a', manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] }
    fake.repos['github:m/mono#path:/packages/plug-b'] = { name: 'plug-b', manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] }
    expect((await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/m/mono/tree/main/packages/plug-a' })).status).toBe(200)
    const second = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/m/mono/tree/main/packages/plug-b' })
    expect(second.status).toBe(200)
    expect(installedSpec('plug-a')).toBeDefined()
    expect(installedSpec('plug-b')).toBeDefined()
  })
})

describe('market self-update', () => {
  it('switches a locally packaged market to its newer online release', async () => {
    await bed.dispatch('POST', '/dsh-market/channel', { channel: 'stable' })
    fake.npm['dshmarket'] = {
      latest: '1.0.3',
      versions: { '1.0.3': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } },
    }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/dsh-market/dsh-market' })
    const manifestPath = join(fake.profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
    manifest.dependencies['dshmarket'] = 'file:/packages/dshmarket-1.0.3.tgz'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const packagePath = join(fake.profileDir, 'node_modules', 'dshmarket', 'package.json')
    const installedPackage = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>
    installedPackage.repository = { type: 'git', url: 'https://github.com/dsh-market/dsh-market.git' }
    writeFileSync(packagePath, JSON.stringify(installedPackage))
    fake.npm['dshmarket'].latest = '1.2.3'
    fake.npm['dshmarket'].versions['1.2.3'] = {
      manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'],
    }
    vi.stubGlobal('fetch', (url: string) => String(url).includes('registry.npmjs.org')
      ? Promise.resolve(new Response(JSON.stringify({ version: '1.2.3' }), { status: 200 }))
      : Promise.reject(new Error('unexpected fetch')))

    const updates = await bed.dispatch('GET', '/dsh-market/updates?force=1')
    expect(updates.json.updates['dshmarket']).toMatchObject({
      current: '1.0.3', latest: '1.2.3', updateAvailable: true, restoreRequired: true,
    })
    const result = await bed.dispatch('POST', '/dsh-market/update', { name: 'dshmarket', restore: true })
    expect(result.status, String(result.json.error ?? '')).toBe(200)
    expect(installedSpec('dshmarket')).toBe('^1.2.3')
  })

  it('the market updates itself through the same flow', async () => {
    // Pin the channel: with no choice on record it is derived from the
    // RUNNING build, and this repo carries a prerelease version while a beta
    // is in flight — which would send this test down the beta dist-tag it
    // has no fixture for. The channel's own behaviour is covered separately.
    await bed.dispatch('POST', '/dsh-market/channel', { channel: 'stable' })
    fake.npm['dshmarket'] = { latest: '1.0.3', versions: { '1.0.3': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/dsh-market/dsh-market' })
    fake.npm['dshmarket'].latest = '1.2.3'
    fake.npm['dshmarket'].versions['1.2.3'] = { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] }
    vi.stubGlobal('fetch', (url: string) => String(url).includes('registry.npmjs.org')
      ? Promise.resolve(new Response(JSON.stringify({ version: '1.2.3' }), { status: 200 }))
      : Promise.reject(new Error('unexpected fetch')))
    const updates = await bed.dispatch('GET', '/dsh-market/updates?force=1')
    expect(updates.json.updates['dshmarket'].updateAvailable).toBe(true)
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'dshmarket' })
    expect(r.status).toBe(200)
    expect(installedSpec('dshmarket')).toBe('^1.2.3')
  })
})

describe('theme update and uninstall', () => {
  beforeEach(async () => {
    fake.repos['github:o/theme-a'] = { name: 'theme-a', manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/theme-a' })
  })

  it('updates a github-installed theme by re-resolving its repo', async () => {
    const r = await bed.dispatch('POST', '/dsh-market/update', { name: 'theme-a' })
    expect(r.status).toBe(200)
    expect(fake.calls[fake.calls.length - 1]).toContain('github:o/theme-a')
  })

  it('uninstalls the active theme and clears its live mount', async () => {
    expect(hot.mounts).toEqual(['theme-a'])
    const r = await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'theme-a' })
    expect(r.status).toBe(200)
    expect(hot.mounts).toEqual([])
    expect(installedSpec('theme-a')).toBeUndefined()
  })
})

describe('concurrency', () => {
  it('a second install while one is running is refused with 409', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    let release!: () => void
    fake.gate = new Promise<void>((resolvePromise) => { release = resolvePromise })
    const first = bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20)) // let it enter the executor
    const second = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/theme-a' })
    expect(second.status).toBe(409)
    release()
    fake.gate = null
    expect((await first).status).toBe(200)
  })

  it('status reports the route-level operation lock as busy while an install is in flight (#91)', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    let release!: () => void
    fake.gate = new Promise<void>((resolvePromise) => { release = resolvePromise })
    const install = bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
    // The window #91 hit: the fake runner is "idle" from the progress
    // tracker's view, but the route still holds the lock — status must say
    // busy so the client neither offers restart nor declares the install done.
    const during = await bed.dispatch('GET', '/dsh-market/status')
    expect(during.json.busy).toBe(true)
    release()
    fake.gate = null
    await install
    const after = await bed.dispatch('GET', '/dsh-market/status')
    expect(after.json.busy).toBe(false)
  })
})

describe('cancel flow (#6)', () => {
  it('cancelling a running install ends it quietly (200 + cancelled, no error)', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    let release!: () => void
    fake.gate = new Promise<void>((resolvePromise) => { release = resolvePromise })
    const install = bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
    const cancel = await bed.dispatch('POST', '/dsh-market/cancel', {})
    expect(cancel.status).toBe(200)
    expect(cancel.json.cancelled).toBe(true)
    release()
    fake.gate = null
    const result = await install
    expect(result.status).toBe(200)
    expect(result.json.ok).toBe(false)
    expect(result.json.cancelled).toBe(true)
    // The fake cancels before acting — nothing was written, so not partial.
    expect(result.json.partial).toBe(false)
    expect(result.json.changed).toEqual([])
    expect(installedSpec('dsh-loop')).toBeUndefined()
  })

  it('cancel with nothing running is a 400', async () => {
    expect((await bed.dispatch('POST', '/dsh-market/cancel', {})).status).toBe(400)
  })
})

describe('build-script approval flow (#6)', () => {
  it('surfaces ignored builds, approve-builds allows only installed packages, and the retry succeeds', async () => {
    fake.npm['dsh-loop'] = {
      latest: '1.0.0',
      versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } },
    }
    fake.buildScriptOutputOnce = 'Ignored build scripts: dsh-loop@1.0.0.'
    const first = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(first.json.ignoredBuilds).toEqual(['dsh-loop'])

    // Approval writes allowBuilds into the profile's pnpm-workspace.yaml…
    const approve = await bed.dispatch('POST', '/dsh-market/approve-builds', { packages: ['dsh-loop', 'ghost-package'] })
    expect(approve.status).toBe(200)
    expect(approve.json.approved).toContain('dsh-loop')
    expect(approve.json.approved).not.toContain('ghost-package')
    const yaml = readFileSync(join(profileDir('web'), 'pnpm-workspace.yaml'), 'utf8')
    expect(yaml).toMatch(/allowBuilds:[\s\S]*dsh-loop: true/)
    // …and the original workspace settings survive.
    expect(yaml).toContain('packages:')
  })

  it('approves TRANSITIVE build deps — in node_modules but not in package.json (#56)', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    // pnpm's blocked build scripts are usually transitive deps (cloudflared,
    // ssh2, cpu-features…) — hoisted into node_modules, absent from the
    // profile's dependencies map.
    mkdirSync(join(profileDir('web'), 'node_modules', 'cloudflared'), { recursive: true })
    writeFileSync(join(profileDir('web'), 'node_modules', 'cloudflared', 'package.json'), '{"name":"cloudflared"}')
    const approve = await bed.dispatch('POST', '/dsh-market/approve-builds', { packages: ['cloudflared', '../evil', 'ghost-package'] })
    expect(approve.status).toBe(200)
    expect(approve.json.approved).toContain('cloudflared')
    expect(approve.json.approved).not.toContain('../evil')
    expect(approve.json.approved).not.toContain('ghost-package')
    const yaml = readFileSync(join(profileDir('web'), 'pnpm-workspace.yaml'), 'utf8')
    expect(yaml).toMatch(/allowBuilds:[\s\S]*cloudflared: true/)
  })

  it('writes both allowBuilds key forms, so pnpm below 11.21 can match one (#285)', async () => {
    // pnpm 11.21+ matches `name@git+https://…`; 11.8.0 — what DSH Desktop
    // bundles — matches only the commit-pinned codeload URL it names in its
    // own error. Writing one form meant the approval button could never work
    // on the other, and the failure was silent: the YAML looked authorized.
    const sha = 'b0e6c57ebeeb4796017864f5cd5c66e6ba0899ec'
    const proxied = `https://gh-proxy.com/https://codeload.github.com/o/r/tar.gz/${sha}`
    // Laid out directly rather than installed: the point under test is what
    // the approval route derives from a spec in this spelling, and a China
    // install is the only thing that produces one.
    mkdirSync(join(profileDir('web'), 'node_modules', 'plug-c'), { recursive: true })
    writeFileSync(join(profileDir('web'), 'node_modules', 'plug-c', 'package.json'), '{"name":"plug-c"}')
    const manifestPath = join(profileDir('web'), 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dependencies = { ...manifest.dependencies, 'plug-c': proxied }
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const approve = await bed.dispatch('POST', '/dsh-market/approve-builds', { packages: ['plug-c'] })
    expect(approve.status).toBe(200)
    const yaml = readFileSync(join(profileDir('web'), 'pnpm-workspace.yaml'), 'utf8')
    expect(yaml).toContain('plug-c@git+https://github.com/o/r.git: true')
    // The pin comes from the installed spec, with no lookup in between — an
    // approval must not depend on reaching the network to be written.
    expect(yaml).toContain(`plug-c@https://codeload.github.com/o/r/tar.gz/${sha}: true`)
  })

  it('uses a commit-pinned github spec for old-pnpm build approval without re-resolving HEAD (#385)', async () => {
    const sha = 'b0e6c57ebeeb4796017864f5cd5c66e6ba0899ec'
    mkdirSync(join(profileDir('web'), 'node_modules', 'plug-pinned'), { recursive: true })
    writeFileSync(join(profileDir('web'), 'node_modules', 'plug-pinned', 'package.json'), '{"name":"plug-pinned"}')
    const manifestPath = join(profileDir('web'), 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dependencies = { ...manifest.dependencies, 'plug-pinned': `github:o/r#${sha}` }
    writeFileSync(manifestPath, JSON.stringify(manifest))
    // An exact installed pin must be enough even when HEAD cannot be reached.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))

    const approve = await bed.dispatch('POST', '/dsh-market/approve-builds', { packages: ['plug-pinned'] })
    expect(approve.status).toBe(200)
    const yaml = readFileSync(join(profileDir('web'), 'pnpm-workspace.yaml'), 'utf8')
    expect(yaml).toContain('plug-pinned@git+https://github.com/o/r.git: true')
    expect(yaml).toContain(`plug-pinned@https://codeload.github.com/o/r/tar.gz/${sha}: true`)
  })

  it('surfaces a git-prepare rejection and approves the not-yet-installed package via the curated registry (#68)', async () => {
    // pnpm's fetcher rejects a git-hosted package with a prepare script
    // BEFORE it lands in node_modules — nothing to existsSync against.
    fake.failNextAddStderrOnce = '[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from "https://codeload.github.com/omdsh-dev/dsh-security-audit/tar.gz/abc123": The git-hosted package "dsh-security-audit@2.8.0" needs to execute build scripts but is not in the "allowBuilds" allowlist.'
    const first = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/omdsh-dev/dsh-security-audit' })
    expect(first.status).toBe(502)
    expect(first.json.ignoredBuilds).toEqual(['dsh-security-audit'])
    // The bilingual classification replaces the raw stack as the lead hint.
    expect(String(first.json.stderr)).toContain('允许构建脚本并重试')

    // Approval is anchored to the curated registry (the package exists in
    // neither node_modules nor package.json) and writes the stable git key —
    // the only form pnpm matches for a git-hosted dep.
    const approve = await bed.dispatch('POST', '/dsh-market/approve-builds', { packages: ['dsh-security-audit'] })
    expect(approve.status).toBe(200)
    expect(approve.json.approved).toContain('dsh-security-audit@git+https://github.com/omdsh-dev/dsh-security-audit.git')
    const yaml = readFileSync(join(profileDir('web'), 'pnpm-workspace.yaml'), 'utf8')
    expect(yaml).toContain('dsh-security-audit@git+https://github.com/omdsh-dev/dsh-security-audit.git: true')

    // The retry (the banner re-runs the install) now succeeds.
    fake.repos['github:omdsh-dev/dsh-security-audit'] = {
      name: 'dsh-security-audit', manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'],
    }
    const retry = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/omdsh-dev/dsh-security-audit' })
    expect(retry.status).toBe(200)
    expect(retry.json.ok).toBe(true)
  })

  it('writes the stable git allowBuilds key for an installed github-sourced dependency (#69)', async () => {
    fake.repos['github:o/blue-whale'] = { name: 'dsh-blue-whale', manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/blue-whale' })
    expect(installedSpec('dsh-blue-whale')).toBe('github:o/blue-whale')
    // Approving the bare name (what pnpm's error reports) must also write
    // the `name@git+https://…` key — a bare entry does not authorize a
    // git-hosted dep (verified against pnpm 11.21 in #68/#69).
    const approve = await bed.dispatch('POST', '/dsh-market/approve-builds', { packages: ['dsh-blue-whale'] })
    expect(approve.status).toBe(200)
    const yaml = readFileSync(join(profileDir('web'), 'pnpm-workspace.yaml'), 'utf8')
    expect(yaml).toMatch(/allowBuilds:[\s\S]*  dsh-blue-whale: true/)
    expect(yaml).toContain('dsh-blue-whale@git+https://github.com/o/blue-whale.git: true')
  })
})

describe('official-scope community plugins (#28)', () => {
  it('installs and lists a community plugin named under @deepseek-ai/', async () => {
    fake.repos['github:omdsh-dev/dsh-security-audit'] = {
      name: '@deepseek-ai/dsh-security-audit',
      manifest: { name: '@deepseek-ai/dsh-security-audit', dsh: {}, main: 'lib/index.js' },
      artifacts: ['lib/index.js'],
    }
    const r = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/omdsh-dev/dsh-security-audit' })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.installed['@deepseek-ai/dsh-security-audit']).toBeDefined()
    const listed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(listed.json.installed['@deepseek-ai/dsh-security-audit']).toBeDefined()
  })
})

describe('externally removed hot mounts (#29)', () => {
  it('drops a live mount whose package was removed outside the market', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(hot.mounts).toEqual(['dsh-loop'])
    // Simulate `dsh plugin remove` outside the market: dep + files gone,
    // the in-memory hot mount left behind.
    const manifest = JSON.parse(readFileSync(join(profileDir('web'), 'package.json'), 'utf8'))
    delete manifest.dependencies['dsh-loop']
    writeFileSync(join(profileDir('web'), 'package.json'), JSON.stringify(manifest))
    rmSync(join(profileDir('web'), 'node_modules', 'dsh-loop'), { recursive: true, force: true })

    const listed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(listed.json.live).toEqual([])
    expect(hot.mounts).toEqual([])
  })
})

describe('one-click restart guards (#14)', () => {
  it('delegates the public v1 restart route to the guarded restart executor', async () => {
    const result = await bed.dispatch('POST', '/dsh-market/api/v1/restart', {})
    expect(result.status).toBe(202)
    expect(result.json).toMatchObject({
      schema: 'dsh-market/update-api/v1',
      result: { ok: true },
    })
    expect(restartCalls.count).toBe(1)
  })

  it('schedules exactly once for a trusted loopback request; repeat is 409', async () => {
    const r = await bed.dispatch('POST', '/dsh-market/restart', {})
    expect(r.status).toBe(202)
    expect(r.json.ok).toBe(true)
    expect(restartCalls.count).toBe(1)
    expect((await bed.dispatch('POST', '/dsh-market/restart', {})).status).toBe(409)
    expect(restartCalls.count).toBe(1)
  })

  it('refuses non-loopback peers, forwarded requests, and cross-origin posts', async () => {
    expect((await bed.dispatch('POST', '/dsh-market/restart', {}, { remoteAddress: '192.168.1.7' })).status).toBe(403)
    expect((await bed.dispatch('POST', '/dsh-market/restart', {}, { forwarded: true })).status).toBe(403)
    expect((await bed.dispatch('POST', '/dsh-market/restart', {}, { crossOrigin: true })).status).toBe(403)
    expect(restartCalls.count).toBe(0)
  })

  it('refuses while a plugin operation is running', async () => {
    fake.npm['dsh-loop'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    let release!: () => void
    fake.gate = new Promise<void>((resolvePromise) => { release = resolvePromise })
    const install = bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
    expect((await bed.dispatch('POST', '/dsh-market/restart', {})).status).toBe(409)
    release()
    fake.gate = null
    await install
  })

  it('allowRestart: false disables the endpoint and the status capability flag', async () => {
    bed.dispose()
    bed = createTestbed({ allowRestart: false })
    expect((await bed.dispatch('GET', '/dsh-market/status')).json.restart).toBe(false)
    expect((await bed.dispatch('POST', '/dsh-market/restart', {})).status).toBe(403)
    expect(restartCalls.count).toBe(0)
  })
})

describe('bundle-layer uninstall live-disable (#37)', () => {
  it('uninstalling a bundle-layer plugin disables its live loader entry so refresh survives', async () => {
    fake.npm['dsh-blue-whale'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    // Bundle-layer plugins never hot-mount; simulate the live loader entry
    // the running host still holds for it.
    fake.repos['github:o/blue-whale'] = { name: 'dsh-blue-whale', manifest: { dsh: { bundle: { patch: './x.yml' } }, main: 'lib/index.js' }, artifacts: ['lib/index.js'] }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/blue-whale' })
    hot.mounts = [] // bundle-layer: not a hot mount
    const entry = {
      options: { id: 'dsh-blue-whale', name: 'dsh-blue-whale', disabled: null as boolean | null },
      fiber: {} as unknown,
      update: vi.fn(async (options: { disabled: boolean | null }) => {
        entry.options.disabled = options.disabled
        if (options.disabled === true) entry.fiber = undefined
      }),
    }
    bed.loaderEntries.push(entry)

    // The live loader fiber (bundle layer loaded at boot) reads as live too —
    // without it, every boot-loaded bundle plugin would claim "restart".
    const before = await bed.dispatch('GET', '/dsh-market/installed')
    expect(before.json.activation['dsh-blue-whale'].state).toBe('live')

    const r = await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-blue-whale' })
    expect(r.status).toBe(200)
    // The live entry must be down — otherwise the next refresh 404s on the
    // deleted client bundle and the whole page wedges until a dsh restart.
    expect(entry.options.disabled).toBe(true)
    expect(entry.fiber).toBeUndefined()
    expect(r.json.hot).toBe(true)
  })
})

describe('generic enable/disable toggle (#60)', () => {
  function installNpm(name: string, dsh: Record<string, unknown> = {}): Promise<void> {
    fake.npm[name] = {
      latest: '1.0.0',
      versions: { '1.0.0': { manifest: { dsh, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } },
    }
    return bed.dispatch('POST', '/dsh-market/install', { url: `https://github.com/o/${name}` }).then(() => undefined)
  }

  it('toggles a hot-mounted plugin off and back on, persisting the disable list', async () => {
    await installNpm('dsh-loop')
    expect(hot.mounts).toEqual(['dsh-loop'])

    const off = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: false })
    expect(off.status).toBe(200)
    expect(off.json.ok).toBe(true)
    expect(hot.mounts).toEqual([])
    expect(hot.disabled.has('dsh-loop')).toBe(true)
    expect(off.json.disabled).toContain('dsh-loop')

    const listed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(listed.json.disabled).toContain('dsh-loop')
    expect(listed.json.activation['dsh-loop'].state).not.toBe('live')

    const on = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: true })
    expect(on.status).toBe(200)
    expect(hot.mounts).toEqual(['dsh-loop'])
    expect(hot.disabled.has('dsh-loop')).toBe(false)
    expect(on.json.activation['dsh-loop'].state).toBe('live')
  })

  it('toggles a bundle-layer entry through setEntryDisabled', async () => {
    fake.repos['github:o/blue-whale'] = {
      name: 'dsh-blue-whale',
      manifest: { dsh: { bundle: { patch: './x.yml' } }, main: 'lib/index.js' },
      artifacts: ['lib/index.js'],
    }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/blue-whale' })
    hot.mounts = [] // bundle-layer: loaded by the loader, never a hot mount
    const entry = {
      options: { id: 'dsh-blue-whale', name: 'dsh-blue-whale', disabled: null as boolean | null },
      fiber: {} as unknown,
      update: vi.fn(async (options: { disabled: boolean | null }) => {
        entry.options.disabled = options.disabled
        if (options.disabled === true) entry.fiber = undefined
        else entry.fiber = {}
      }),
    }
    bed.loaderEntries.push(entry)

    const off = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-blue-whale', enabled: false })
    expect(off.status).toBe(200)
    expect(entry.options.disabled).toBe(true)
    expect(entry.fiber).toBeUndefined()
    expect(hot.disabled.has('dsh-blue-whale')).toBe(true)

    const on = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-blue-whale', enabled: true })
    expect(on.status).toBe(200)
    expect(entry.options.disabled).toBeNull()
    expect(entry.fiber).toBeDefined()
    expect(hot.disabled.has('dsh-blue-whale')).toBe(false)
  })

  it('writes the user patch layer on toggle (port of dsh-plugin-hub); activation reads disabled', async () => {
    // A bundle-layer plugin with a real insert row.
    fake.repos['github:o/dsh-patchy'] = {
      name: 'dsh-patchy',
      manifest: { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'lib/index.js' },
      artifacts: ['lib/index.js', 'cordis.patch.yml'],
    }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-patchy' })
    hot.mounts = []
    // The fake install writes an EMPTY patch artifact; give it the real row
    // and mirror the loader entry the boot would create.
    const patchFile = join(profileDir('web'), 'node_modules', 'dsh-patchy', 'cordis.patch.yml')
    writeFileSync(patchFile, "- insert:\n    - id: dsh-patchy\n      name: 'dsh-patchy'\n")
    bed.loaderEntries.push({
      options: { id: 'dsh-patchy', name: 'dsh-patchy', disabled: null as boolean | null },
      fiber: {},
      update: async (options: { disabled: boolean | null }) => {
        const target = bed.loaderEntries.find(e => e.options.name === 'dsh-patchy')!
        target.options.disabled = options.disabled
        target.fiber = options.disabled === true ? undefined : {}
      },
    })

    const off = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-patchy', enabled: false })
    expect(off.status).toBe(200)
    const userPatch = join(profileDir('web'), 'cordis.patch.yml')
    expect(readFileSync(userPatch, 'utf8')).toContain('- id: dsh-patchy\n  disabled: true\n')
    expect(off.json.patchWrite.ok).toBe(true)
    // Disabled plugins read as disabled, never "restart to apply".
    expect(off.json.activation['dsh-patchy'].state).toBe('disabled')

    const listed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(listed.json.patch.disables).toContain('dsh-patchy')
    expect(listed.json.patchDisabled).toContain('dsh-patchy')
    expect(listed.json.activation['dsh-patchy'].state).toBe('disabled')

    const on = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-patchy', enabled: true })
    expect(on.status).toBe(200)
    expect(readFileSync(userPatch, 'utf8')).not.toContain('dsh-patchy')
    expect(on.json.activation['dsh-patchy'].state).toBe('live')
    // The live fiber followed the switch — no restart needed.
    expect(on.json.restart).toBe(false)
    // Bundle-only plugin (no dsh.client) — no page refresh needed either.
    expect(on.json.refresh).toBe(false)
  })

  it('reports restart when the disable leaves the live fiber up', async () => {
    await installNpm('dsh-loop')
    hot.mounts = [] // only the loader entry is live
    bed.loaderEntries.push({
      options: { id: 'dsh-loop', name: 'dsh-loop', disabled: null as boolean | null },
      fiber: {},
      // The live drive cannot bring the fiber down (retries exhaust).
      update: async () => {},
    })
    const off = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: false })
    expect(off.status).toBe(200)
    expect(off.json.ok).toBe(true)
    expect(off.json.restart).toBe(true)
    // The choice is still durable (state.json; the next boot applies it).
    expect(hot.disabled.has('dsh-loop')).toBe(true)
  })

  it('reports restart + the reason when enabling cannot hot-mount', async () => {
    await installNpm('dsh-loop')
    await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: false })
    hot.failNext = true // hotMount fails with a restart-required reason
    const on = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: true })
    expect(on.status).toBe(502)
    expect(on.json.ok).toBe(false)
    expect(on.json.restart).toBe(true)
    expect(on.json.reason).toMatch(/cannot hot-mount|restart/)
  })

  it('toggles a client-only shim (dsh.client without dsh.bundle) through the hot path', async () => {
    await installNpm('dsh-loop', { client: './client.js' })
    expect(hot.mounts).toEqual(['dsh-loop'])
    const off = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: false })
    expect(off.status).toBe(200)
    expect(hot.mounts).toEqual([])
    expect(hot.disabled.has('dsh-loop')).toBe(true)
    // The client part is injected into the page — a refresh is prompted.
    expect(off.json.refresh).toBe(true)
    const on = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: true })
    expect(on.status).toBe(200)
    expect(hot.mounts).toEqual(['dsh-loop'])
    expect(hot.disabled.has('dsh-loop')).toBe(false)
  })

  it('enabling a theme through the generic toggle keeps the Themes-page exclusivity', async () => {
    for (const name of ['theme-a', 'theme-b']) {
      fake.repos[`github:o/${name}`] = { name, manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] }
      await bed.dispatch('POST', '/dsh-market/install', { url: `https://github.com/o/${name}` })
    }
    expect(hot.mounts).toEqual(['theme-b'])
    const r = await bed.dispatch('POST', '/dsh-market/toggle', { name: 'theme-a', enabled: true })
    expect(r.status).toBe(200)
    expect(hot.mounts).toEqual(['theme-a'])
    expect(hot.disabled.has('theme-b')).toBe(true)
    expect(hot.disabled.has('theme-a')).toBe(false)
  })

  it('rejects the market itself, unknown plugins, and cross-origin toggles', async () => {
    expect((await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dshmarket', enabled: false })).status).toBe(400)
    expect((await bed.dispatch('POST', '/dsh-market/toggle', { name: 'ghost', enabled: true })).status).toBe(400)
    expect((await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: false }, { crossOrigin: true })).status).toBe(403)
  })

  it('uninstall clears the disable flag; a reinstall starts enabled', async () => {
    await installNpm('dsh-loop')
    await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: false })
    expect(hot.disabled.has('dsh-loop')).toBe(true)
    const uninstall = await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })
    expect(uninstall.status).toBe(200)
    expect(hot.disabled.has('dsh-loop')).toBe(false)
    const reinstall = await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    expect(reinstall.status).toBe(200)
    expect(hot.disabled.has('dsh-loop')).toBe(false)
    expect(hot.mounts).toEqual(['dsh-loop'])
  })
})

describe('disable-list replay at boot (#60)', () => {
  it('re-applies persisted disables to bundle-layer entries after the boot shim resolves', async () => {
    // A previous session left theme-a disabled; the replay must put the
    // bundle-layer entry back down (client-only shims are skipped inside
    // mountClientOnlyDeps, covered by the real-module spec).
    hot.disabled = new Set(['theme-a'])
    const entry = {
      options: { id: 'theme-a', name: 'theme-a', disabled: null as boolean | null },
      fiber: {} as unknown,
      update: vi.fn(async (options: { disabled: boolean | null }) => {
        entry.options.disabled = options.disabled
        if (options.disabled === true) entry.fiber = undefined
      }),
    }
    const bed2 = createTestbed()
    bed2.loaderEntries.push(entry)
    // mountClientOnlyDeps resolves immediately; flush the replay microtask.
    await new Promise(resolvePromise => setTimeout(resolvePromise, 0))
    expect(entry.options.disabled).toBe(true)
    expect(entry.fiber).toBeUndefined()
    bed2.dispose()
  })
})

describe('custom groups (#60)', () => {
  async function seedMembers(): Promise<void> {
    fake.npm['dsh-loop'] = {
      latest: '1.0.0',
      versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } },
    }
    fake.npm['dsh-share'] = {
      latest: '0.2.0',
      versions: { '0.2.0': { manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] } },
    }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dsh-loop' })
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/h/dsh-share' })
  }

  it('create/rename/delete lifecycle keeps groups and groupOrder consistent', async () => {
    const created = await bed.dispatch('POST', '/dsh-market/groups', { action: 'create', name: 'work' })
    expect(created.status).toBe(200)
    expect(created.json.groups).toEqual({ work: [] })
    expect(created.json.groupOrder).toEqual(['work'])

    expect((await bed.dispatch('POST', '/dsh-market/groups', { action: 'create', name: 'work' })).status).toBe(400)
    expect((await bed.dispatch('POST', '/dsh-market/groups', { action: 'create', name: '../evil' })).status).toBe(400)

    const renamed = await bed.dispatch('POST', '/dsh-market/groups', { action: 'rename', name: 'work', newName: 'daily' })
    expect(renamed.status).toBe(200)
    expect(renamed.json.groups).toEqual({ daily: [] })
    expect(renamed.json.groupOrder).toEqual(['daily'])

    const deleted = await bed.dispatch('POST', '/dsh-market/groups', { action: 'delete', name: 'daily' })
    expect(deleted.status).toBe(200)
    expect(deleted.json.groups).toEqual({})
    expect(deleted.json.groupOrder).toEqual([])
    expect((await bed.dispatch('POST', '/dsh-market/groups', { action: 'delete', name: 'ghost' })).status).toBe(400)
    expect((await bed.dispatch('POST', '/dsh-market/groups', { action: 'explode' })).status).toBe(400)
  })

  it('set-members keeps only installed plugins and uninstall prunes membership', async () => {
    await seedMembers()
    await bed.dispatch('POST', '/dsh-market/groups', { action: 'create', name: 'work' })
    const set = await bed.dispatch('POST', '/dsh-market/groups', {
      action: 'set-members', name: 'work', members: ['dsh-loop', 'dsh-share', 'ghost', 'dshmarket'],
    })
    expect(set.status).toBe(200)
    expect(set.json.groups.work.sort()).toEqual(['dsh-loop', 'dsh-share'])
    expect(set.json.groups.work).not.toContain('dshmarket')

    await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dsh-loop' })
    const listed = await bed.dispatch('GET', '/dsh-market/installed')
    expect(listed.json.groups.work).toEqual(['dsh-share'])
  })

  it('group toggle enables/disables every member as a batch', async () => {
    await seedMembers()
    await bed.dispatch('POST', '/dsh-market/groups', { action: 'create', name: 'work' })
    await bed.dispatch('POST', '/dsh-market/groups', { action: 'set-members', name: 'work', members: ['dsh-loop', 'dsh-share'] })

    const off = await bed.dispatch('POST', '/dsh-market/groups', { action: 'toggle', name: 'work', enabled: false })
    expect(off.status).toBe(200)
    expect(off.json.disabled.sort()).toEqual(['dsh-loop', 'dsh-share'])
    expect(hot.mounts).toEqual([])

    const on = await bed.dispatch('POST', '/dsh-market/groups', { action: 'toggle', name: 'work', enabled: true })
    expect(on.status).toBe(200)
    expect(on.json.disabled).toEqual([])
    expect(hot.mounts.sort()).toEqual(['dsh-loop', 'dsh-share'])
  })

  it('group switch matches individually toggled plugins (mixed then all-off)', async () => {
    await seedMembers()
    await bed.dispatch('POST', '/dsh-market/groups', { action: 'create', name: 'work' })
    await bed.dispatch('POST', '/dsh-market/groups', { action: 'set-members', name: 'work', members: ['dsh-loop', 'dsh-share'] })
    // One member off individually → the group is mixed (derived, not stored).
    await bed.dispatch('POST', '/dsh-market/toggle', { name: 'dsh-loop', enabled: false })
    expect(hot.disabled).toEqual(new Set(['dsh-loop']))
    // Group off = same outcome as toggling each member individually.
    const off = await bed.dispatch('POST', '/dsh-market/groups', { action: 'toggle', name: 'work', enabled: false })
    expect(off.json.disabled.sort()).toEqual(['dsh-loop', 'dsh-share'])
    const on = await bed.dispatch('POST', '/dsh-market/groups', { action: 'toggle', name: 'work', enabled: true })
    expect(on.json.disabled).toEqual([])
  })

  it('rejects a second theme in one group', async () => {
    for (const name of ['theme-a', 'theme-b']) {
      fake.repos[`github:o/${name}`] = { name, manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] }
      await bed.dispatch('POST', '/dsh-market/install', { url: `https://github.com/o/${name}` })
    }
    await bed.dispatch('POST', '/dsh-market/groups', { action: 'create', name: 'looks' })
    const both = await bed.dispatch('POST', '/dsh-market/groups', {
      action: 'set-members', name: 'looks', members: ['theme-a', 'theme-b'],
    })
    expect(both.status).toBe(400)
    expect(String(both.json.error)).toMatch(/at most one theme/)
    const one = await bed.dispatch('POST', '/dsh-market/groups', {
      action: 'set-members', name: 'looks', members: ['theme-a'],
    })
    expect(one.status).toBe(200)
    expect(one.json.groups.looks).toEqual(['theme-a'])
  })

  it('group toggle enables a theme member with global exclusivity', async () => {
    for (const name of ['theme-a', 'theme-b']) {
      fake.repos[`github:o/${name}`] = { name, manifest: { dsh: {}, main: 'index.js' }, artifacts: ['index.js'] }
      await bed.dispatch('POST', '/dsh-market/install', { url: `https://github.com/o/${name}` })
    }
    expect(hot.mounts).toEqual(['theme-b']) // later install auto-activated
    await bed.dispatch('POST', '/dsh-market/groups', { action: 'create', name: 'looks' })
    await bed.dispatch('POST', '/dsh-market/groups', { action: 'set-members', name: 'looks', members: ['theme-a'] })

    const on = await bed.dispatch('POST', '/dsh-market/groups', { action: 'toggle', name: 'looks', enabled: true })
    expect(on.status).toBe(200)
    // Enabling the group's theme deactivates the previously active theme-b.
    expect(hot.mounts).toEqual(['theme-a'])
    expect(hot.disabled.has('theme-b')).toBe(true)
    expect(hot.disabled.has('theme-a')).toBe(false)

    const off = await bed.dispatch('POST', '/dsh-market/groups', { action: 'toggle', name: 'looks', enabled: false })
    expect(off.status).toBe(200)
    expect(hot.disabled.has('theme-a')).toBe(true)
  })
})

describe('self-uninstall — the market removing itself from its settings card', () => {
  /**
   * Deliberately a separate route from `/dsh-market/uninstall`, which keeps
   * refusing the market. A destructive action on the plugin serving the
   * request should be reachable only from the surface built for it, never as
   * a stray `{ name: "dshmarket" }` on the ordinary path.
   */
  it('is refused without an explicit confirmation', async () => {
    // Assert the REASON, not just the 400: this route has several ways to
    // reject, and a status-only assertion passed even with the confirmation
    // check removed entirely — the request then failed one step later for an
    // unrelated reason and looked identical from outside.
    const bare = await bed.dispatch('POST', '/dsh-market/self-uninstall', {})
    expect(bare.status).toBe(400)
    expect(String(bare.json.error)).toContain('explicit confirmation')
    // `confirm: false` is not "close enough" either.
    const explicitlyNot = await bed.dispatch('POST', '/dsh-market/self-uninstall', { confirm: false })
    expect(String(explicitlyNot.json.error)).toContain('explicit confirmation')
  })

  it('is refused from a cross-origin, forwarded or remote client', async () => {
    // The same door the restart route uses: both end the market's life in
    // this process, so neither may be driven by anything but the user's own
    // loopback browser.
    expect((await bed.dispatch('POST', '/dsh-market/self-uninstall', { confirm: true }, { crossOrigin: true })).status).toBe(403)
    expect((await bed.dispatch('POST', '/dsh-market/self-uninstall', { confirm: true }, { forwarded: true })).status).toBe(403)
    expect((await bed.dispatch('POST', '/dsh-market/self-uninstall', { confirm: true }, { remoteAddress: '192.168.1.7' })).status).toBe(403)
  })

  it('the ordinary uninstall route still refuses the market', async () => {
    // Adding a way to remove the market must not quietly open the old one.
    const viaGeneric = await bed.dispatch('POST', '/dsh-market/uninstall', { name: 'dshmarket' })
    expect(viaGeneric.status).toBe(400)
  })
})

describe('download region', () => {
  it('rejects anything but the two regions', async () => {
    expect((await bed.dispatch('POST', '/dsh-market/region', { region: 'CN' })).status).toBe(400)
    expect((await bed.dispatch('POST', '/dsh-market/region', {})).status).toBe(400)
    expect((await bed.dispatch('POST', '/dsh-market/region', { region: 'china' }, { crossOrigin: true })).status).toBe(403)
  })

  it('round-trips the setting and reports it on /status', async () => {
    const set = await bed.dispatch('POST', '/dsh-market/region', { region: 'china' })
    expect(set.status).toBe(200)
    expect(set.json.region).toBe('china')
    const status = (await bed.dispatch('GET', '/dsh-market/status')).json
    expect(status.region).toBe('china')
    // The card draws its control from this list, so a region the route would
    // refuse must never appear in it.
    expect(status.regions).toEqual(['global', 'china'])

    const back = await bed.dispatch('POST', '/dsh-market/region', { region: 'global' })
    expect(back.status).toBe(200)
    expect((await bed.dispatch('GET', '/dsh-market/status')).json.region).toBe('global')
  })

  it('sends the browser a resolved proxy prefix rather than a region to interpret', async () => {
    // The routing table has one home. A client deriving the proxy from the
    // region name would be a second copy of it that can disagree.
    expect((await bed.dispatch('GET', '/dsh-market/status')).json.githubProxy).toBeNull()
    await bed.dispatch('POST', '/dsh-market/region', { region: 'china' })
    const proxy = (await bed.dispatch('GET', '/dsh-market/status')).json.githubProxy
    expect(typeof proxy).toBe('string')
    expect(String(proxy).startsWith('https://')).toBe(true)
    await bed.dispatch('POST', '/dsh-market/region', { region: 'global' })
  })

  it('stops offering the automatic explanation once the user has chosen', async () => {
    await bed.dispatch('POST', '/dsh-market/region', { region: 'china' })
    // The market has nothing left to explain: the answer is the user's now.
    expect((await bed.dispatch('GET', '/dsh-market/status')).json.regionAuto).toBe(false)
    await bed.dispatch('POST', '/dsh-market/region', { region: 'global' })
  })
})

describe('release channel', () => {
  it('rejects anything but the two channels', async () => {
    expect((await bed.dispatch('POST', '/dsh-market/channel', { channel: 'nightly' })).status).toBe(400)
    expect((await bed.dispatch('POST', '/dsh-market/channel', {})).status).toBe(400)
    expect((await bed.dispatch('POST', '/dsh-market/channel', { channel: 'beta' }, { crossOrigin: true })).status).toBe(403)
  })

  it('round-trips the setting', async () => {
    // /status reports the ACTIVE channel, which a prerelease build forces to
    // beta whatever the setting says — so the round-trip is asserted on the
    // setting itself here, and the derivation is covered by resolveChannel's
    // own spec. Asserting /status against a literal would tie this test to
    // whatever version the repo happens to carry today.
    const set = await bed.dispatch('POST', '/dsh-market/channel', { channel: 'beta' })
    expect(set.status).toBe(200)
    expect(set.json.channel).toBe('beta')
    expect((await bed.dispatch('GET', '/dsh-market/status')).json.channel).toBe('beta')

    const back = await bed.dispatch('POST', '/dsh-market/channel', { channel: 'stable' })
    expect(back.status).toBe(200)
    expect(back.json.channel).toBe('stable')
  })

  it('installs from the channel it offered from, not from latest', async () => {
    // The offer and the install have to agree. `@latest` was hardcoded, so a
    // beta subscriber would be told an update existed and then handed the
    // stable build — the setting would look like it did nothing.
    fake.npm['dshmarket'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dshmarket' })
    fake.npm['dshmarket'].latest = '9.0.0'
    fake.npm['dshmarket'].versions['9.0.0'] = { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] }
    await bed.dispatch('POST', '/dsh-market/channel', { channel: 'beta' })
    fake.calls = []
    await bed.dispatch('POST', '/dsh-market/update', { name: 'dshmarket' })
    const added = fake.calls.find(call => call[0] === 'add')
    expect(added?.join(' '), 'the update ran with the wrong dist-tag').toContain('dshmarket@beta')

    await bed.dispatch('POST', '/dsh-market/channel', { channel: 'stable' })
    fake.calls = []
    await bed.dispatch('POST', '/dsh-market/update', { name: 'dshmarket' })
    expect(fake.calls.find(call => call[0] === 'add')?.join(' ')).toContain('dshmarket@latest')
  })

  it('re-checks immediately when the channel changes', async () => {
    // The listing is cached per profile for a while. Keyed on the profile
    // alone, switching channels would keep serving the previous verdict for
    // the rest of the TTL — indistinguishable, to the user, from a setting
    // that does nothing.
    fake.npm['dshmarket'] = { latest: '1.0.0', versions: { '1.0.0': { manifest: { dsh: {}, main: 'lib/index.js' }, artifacts: ['lib/index.js'] } } }
    await bed.dispatch('POST', '/dsh-market/install', { url: 'https://github.com/o/dshmarket' })
    const seen: string[] = []
    const realFetch = globalThis.fetch as typeof fetch
    vi.stubGlobal('fetch', vi.fn((input: unknown, init?: RequestInit) => {
      seen.push(String(input))
      return realFetch(input as string, init)
    }))
    // Warm the cache on the stable channel FIRST — that is the state the
    // bug needs. Without a prior listing there is nothing stale to serve,
    // and the spec would pass with the channel left out of the cache key.
    await bed.dispatch('GET', '/dsh-market/updates')
    await bed.dispatch('POST', '/dsh-market/channel', { channel: 'beta' })
    seen.length = 0
    await bed.dispatch('GET', '/dsh-market/updates')
    expect(seen.some(url => url.endsWith('/beta')), 'the beta dist-tag was never queried').toBe(true)
  })
})

describe('catalog: one source, and a failure says so', () => {
  it('reports the reason instead of substituting a bundled copy', async () => {
    // There used to be three answers here — live, a one-hour in-memory
    // cache, and a snapshot frozen into the npm package — and only the first
    // was correct. On screen they were indistinguishable, so an unreachable
    // registry read as "the catalog has fewer plugins today": 839 entries
    // against 1367 live, and frozen forever for anyone on an older release.
    // For a catalog, stale is not degraded, it is WRONG — a plugin published
    // this morning reads as "does not exist".
    registryModule.loadRegistry.mockRejectedValueOnce(new Error('fetch failed: ENOTFOUND'))
    const failed = await bed.dispatch('GET', '/dsh-market/registry')
    expect(failed.status).toBe(502)
    expect(String(failed.json.error)).toContain('ENOTFOUND')
    expect(failed.json.registry, 'a failed catalog fetch must not carry data').toBeUndefined()
  })
})


describe('the channel choice survives a restart', () => {
  it('is written down, not just held in memory', async () => {
    // The route used to mutate the in-memory config only, so the choice
    // lived exactly as long as the process — and no test noticed, because
    // every assertion queried the same instance that had just been told.
    expect(hot.channel).toBeUndefined()
    expect((await bed.dispatch('POST', '/dsh-market/channel', { channel: 'beta' })).status).toBe(200)
    expect(hot.channel, 'the choice never reached durable state').toBe('beta')
  })

  it('is read back by a freshly mounted market', async () => {
    // 'stable' is the load-bearing direction, and deliberately so: this
    // build is a prerelease (1.14.0-beta.1), so a market that persisted
    // NOTHING would still answer 'beta' on the way in — derived from the
    // running version. Only the way back off the channel can tell a
    // remembered choice from a re-derived one.
    expect((await bed.dispatch('POST', '/dsh-market/channel', { channel: 'stable' })).status).toBe(200)

    // A second market over the same profile state: this is what a restart
    // looks like from the state file's point of view.
    const restarted = createTestbed({ profile: 'web' })
    try {
      expect((await restarted.dispatch('GET', '/dsh-market/status')).json.channel).toBe('stable')
    } finally { restarted.dispose() }
  })

  it('leaves the channel derived from the build until the user picks one', async () => {
    // Absent is not 'stable'. Installing a prerelease by hand should land
    // on the beta channel with no second step — that is what makes the
    // setting a memory of a CHOICE rather than a default with extra steps.
    //
    // The RULE ("a prerelease build derives beta") is independently and
    // strongly covered in tests/channels.spec.ts, with literal version
    // strings on both sides of the branch — that coverage does not depend
    // on what this checkout happens to be.
    //
    // What THIS asserts is narrower than it looks: `resolveChannel(undefined,
    // marketVersion())` rather than a hardcoded 'beta' — a literal was only
    // ever true while this checkout happened to be a prerelease, and it
    // broke on exactly the first stable cut (main tagged 1.14.0). Comparing
    // against the same functions the route calls is honest about what that
    // buys: mutation-tested on THIS checkout (a stable, non-prerelease
    // version) and confirmed NOT to catch the route hardcoding 'stable' or
    // dropping marketVersion() entirely — both derive 'stable' here too, the
    // same as a correct implementation. It only regains bite on a prerelease
    // checkout. What stays checked unconditionally either way: `hot.channel`
    // really is undefined (nothing was accidentally persisted by an earlier
    // test), and the route answers with SOME value derived from real
    // functions rather than throwing or answering undefined.
    const fresh = createTestbed({ profile: 'web' })
    try {
      expect(hot.channel).toBeUndefined()
      const expected = resolveChannel(undefined, marketVersion())
      expect((await fresh.dispatch('GET', '/dsh-market/status')).json.channel).toBe(expected)
    } finally { fresh.dispose() }
  })
})

describe('the dev channel is an ordinary choice', () => {
  it('is offered by the status route alongside the other two', async () => {
    expect((await bed.dispatch('GET', '/dsh-market/status')).json.channels).toEqual(['stable', 'beta', 'dev'])
  })

  it('is selectable, persisted and read back like any other', async () => {
    // It was gated behind a stored developer mode for one version. Removing
    // the gate must not quietly remove the memory with it.
    expect((await bed.dispatch('POST', '/dsh-market/channel', { channel: 'dev' })).status).toBe(200)
    expect(hot.channel).toBe('dev')

    const restarted = createTestbed({ profile: 'web' })
    try {
      expect((await restarted.dispatch('GET', '/dsh-market/status')).json.channel).toBe('dev')
    } finally { restarted.dispose() }
  })

  it('still refuses a channel that does not exist', async () => {
    const refused = await bed.dispatch('POST', '/dsh-market/channel', { channel: 'nightly' })
    expect(refused.status).toBe(400)
    expect(hot.channel).toBeUndefined()
  })

  it('still refuses a cross-origin selection', async () => {
    expect((await bed.dispatch('POST', '/dsh-market/channel', { channel: 'dev' }, { crossOrigin: true })).status).toBe(403)
    expect(hot.channel).toBeUndefined()
  })
})
