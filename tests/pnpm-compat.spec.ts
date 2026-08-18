/**
 * The pnpm compatibility layer's decision logic. The -w cases encode issue
 * #20: the flag is required at pnpm-9 workspace roots but is a HARD ERROR
 * (every pnpm major) in a profile without pnpm-workspace.yaml — so the
 * injection must depend on the profile's actual shape.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyPnpmFailure, pluginArgsFor } from '../src/pnpm-compat.ts'

describe('pluginArgsFor', () => {
  let dir: string
  afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }) })

  function profileFixture(workspace: boolean): string {
    dir = mkdtempSync(join(tmpdir(), 'dshm-profile-'))
    writeFileSync(join(dir, 'package.json'), '{"name":"p","private":true}')
    if (workspace) writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    return dir
  }

  it('injects -w exactly when the profile is a workspace root (#20)', () => {
    // pnpm 9 refuses add/remove at a workspace root without -w…
    const ws = profileFixture(true)
    expect(pluginArgsFor(ws, ['add', 'dshmarket'])).toEqual(['add', '-w', 'dshmarket'])
    expect(pluginArgsFor(ws, ['remove', 'dshmarket'])).toEqual(['remove', '-w', 'dshmarket'])
    // …other subcommands pass through untouched.
    expect(pluginArgsFor(ws, ['install'])).toEqual(['install'])
    rmSync(ws, { recursive: true, force: true })
    // …and every pnpm major hard-errors on -w OUTSIDE a workspace.
    const plain = profileFixture(false)
    expect(pluginArgsFor(plain, ['add', 'dshmarket'])).toEqual(['add', 'dshmarket'])
    expect(pluginArgsFor(plain, ['remove', 'dshmarket'])).toEqual(['remove', 'dshmarket'])
  })
})

describe('classifyPnpmFailure', () => {
  it('maps each known pnpm failure signature, and only those', () => {
    const hoist = classifyPnpmFailure('ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF  This modules directory was created using a different public-hoist-pattern value. Run "pnpm install" to recreate the modules directory.')
    expect(hoist?.code).toBe('hoist-pattern-diff')
    expect(hoist?.recoverable).toBe(true)

    const root = classifyPnpmFailure('ERR_PNPM_ADDING_TO_ROOT  Running this command will add the dependency to the workspace root')
    expect(root?.code).toBe('adding-to-root')
    expect(root?.recoverable).toBe(false)

    expect(classifyPnpmFailure('[ERROR] --workspace-root may only be used inside a workspace')?.code).toBe('not-a-workspace')
    expect(classifyPnpmFailure('dsh: pnpm not found on PATH — install pnpm to manage profile plugins')?.code).toBe('pnpm-missing')

    // #39 — both faces of pnpm's release-age gate on an already-written
    // young lockfile entry: lockfile verification (remove/any mutation) and
    // re-resolution of the young dep during a later add.
    const violation = classifyPnpmFailure('[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:\n  is-odd@3.0.1 was published at 2018-05-31T20:04:53.306Z, within the minimumReleaseAge cutoff')
    expect(violation?.code).toBe('release-age-violation')
    expect(classifyPnpmFailure('[ERR_PNPM_NO_MATURE_MATCHING_VERSION] 1 version does not meet the minimumReleaseAge constraint:')?.code).toBe('release-age-violation')
    // Unrecognized output → null, the raw text is then surfaced as-is.
    expect(classifyPnpmFailure('some other failure')).toBeNull()
  })

  it('recognizes an unresolvable dependency and names it, decoding the scoped-URL form (#65)', () => {
    const missing = classifyPnpmFailure('[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/@deepseek-ai%2Fdsh-client-ui-theme-toggle: Not Found - 404\n\nThis error happened while installing a direct dependency of /home/u/.dsh/profiles/web')
    expect(missing?.code).toBe('fetch-404')
    expect(missing?.message).toContain('@deepseek-ai/dsh-client-ui-theme-toggle')
    expect(missing?.message).toContain('幽灵依赖')
    // Unscoped form, no encoding involved.
    expect(classifyPnpmFailure('[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/some-ghost: Not Found - 404')?.message).toContain('some-ghost')
  })

  it('recognizes momentary network failures — and only those — as transient (#83)', () => {
    const flake = classifyPnpmFailure('FetchError: request to https://codeload.github.com/o/r/tar.gz/abc failed, reason: socket hang up')
    expect(flake?.code).toBe('transient-network')
    expect(flake?.message).toContain('重放整个依赖树')
    expect(classifyPnpmFailure('GET https://registry.npmjs.org/x error (ERR_PNPM_FETCH_503)')?.code).toBe('transient-network')
    expect(classifyPnpmFailure('connect ETIMEDOUT 140.82.112.10:443')?.code).toBe('transient-network')
    // Permanent shapes must NOT read as transient: retrying doubles the pain.
    expect(classifyPnpmFailure('[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/ghost: Not Found - 404')?.code).toBe('fetch-404')
  })

  it('recognizes pnpm\u2019s per-request fetch timeout as fetch-timeout, not transient (#…)', () => {
    // The exact pnpm/undici abort shape for a large tarball that outlives the
    // default 60s limit: DOMException "The operation was aborted due to
    // timeout" (code 23), logged by pnpm as a retried GET error.
    const abort = classifyPnpmFailure('[WARN] GET https://codeload.github.com/volcengine/OpenViking/tar.gz/dbf3fcccefe43616e4b1c3b60dfe36c2222e2dd6 error (23). Will retry in 10 seconds. 2 retries left.\n[23] The operation was aborted due to timeout\n\nTimeoutError: The operation was aborted due to timeout\n    at new DOMException (node:internal/per_context/domexception:76:18)')
    expect(abort?.code).toBe('fetch-timeout')
    expect(abort?.message).toContain('下载超时')
    // The transient regex must NOT claim the same text — the two recoveries
    // differ (plain retry vs longer fetchTimeout).
    expect(classifyPnpmFailure('TimeoutError: The operation was aborted due to timeout')?.code).toBe('fetch-timeout')
    // Unrelated shapes stay unrecognized.
    expect(classifyPnpmFailure('some other failure')?.code).toBeUndefined()
  })

  it('recognizes both build-script blocks: ignored builds (#69) and the git-prepare fetcher rejection (#68)', () => {
    const ignored = classifyPnpmFailure('[ERR_PNPM_IGNORED_BUILDS]\nIgnored build scripts: dsh-github-intelligence@https://codeload.github.com/z/r/tar.gz/abc.')
    expect(ignored?.code).toBe('ignored-builds')
    expect(ignored?.message).toContain('允许构建脚本并重试')
    const prepare = classifyPnpmFailure('[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from "https://codeload.github.com/z/r/tar.gz/abc": The git-hosted package "r@2.8.0" needs to execute build scripts but is not in the "allowBuilds" allowlist.')
    expect(prepare?.code).toBe('git-prepare-not-allowed')
    expect(prepare?.message).toContain('允许构建脚本并重试')
  })
})

describe('provisionHint (#142 / #108 / #32)', () => {
  it('names the actual cause instead of a generic failure', async () => {
    const { provisionHint } = await import('../src/dsh-cli.ts')
    // #142: corepack succeeded and left a shim, so npm -g refused to overwrite.
    const eexist = provisionHint('', 'npm error EEXIST: file already exists\nnpm error File exists: /usr/local/bin/pnpm\nnpm error Remove the existing file and try again, or run npm\nnpm error with --force to overwrite files recklessly.')
    expect(eexist).toContain('corepack prepare pnpm@latest --activate')
    // #108: Node installed where the user cannot write.
    const eperm = provisionHint('Internal Error: EPERM: operation not permitted, open \'D:\\nodejs\\pnpm.CMD\'', 'npm error ... try running the command again as root/Administrator.')
    expect(eperm).toContain('brew install pnpm')
    expect(eperm).toContain('管理员')
    // #32: no toolchain on PATH at all — the button is a dead end, say so.
    expect(provisionHint('spawn corepack ENOENT', 'spawn npm ENOENT')).toContain('找不到 npm/corepack')
    // Restricted network: the corepack shim cannot fetch pnpm either.
    expect(provisionHint('', 'npm error network request to https://registry.npmjs.org failed, reason: ETIMEDOUT'))
      .toContain('镜像')
    // Unrecognized output stays undefined rather than guessing.
    expect(provisionHint('', 'some unknown failure')).toBeUndefined()
  })
})
