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

  it('names a patch that no longer applies, and says the package went in unpatched (#222)', () => {
    // pnpm exits 1 here (verified against 10.29.3) but has ALREADY written
    // the package without the patch, so the profile keeps the pristine
    // version the patch existed to fix — and that only shows up at the next
    // boot. The message has to say so, or the user reads "install failed"
    // and does not know their profile is now holding a broken bundle.
    const failed = classifyPnpmFailure('ERR_PNPM_PATCH_FAILED  Could not apply patch /home/u/.dsh/profiles/web/patches/dsh-plugin-guardian@1.1.0.patch to /home/u/.dsh/profiles/web/node_modules/.pnpm/x/node_modules/dsh-plugin-guardian')
    expect(failed?.code).toBe('patch-failed')
    expect(failed?.recoverable).toBe(false)
    expect(failed?.message).toContain('dsh-plugin-guardian@1.1.0.patch')
    expect(failed?.message).toContain('没打补丁的原版')
    expect(failed?.message).toContain('patchedDependencies')
  })

  it('names the tarball dependency whose lockfile entry has no integrity (#367)', () => {
    const failed = classifyPnpmFailure(`[ERR_PNPM_MISSING_TARBALL_INTEGRITY] Cannot install package
"dsh-think-translate@https://gh-proxy.com/https://codeload.github.com/UncleK/dsh-think-translate/tar.gz/ba71a9bb88f52bc7bbf42225cfb69f7ef8d16900": its lockfile entry has no "integrity" field,
so pnpm cannot verify the downloaded tarball.`)

    expect(failed?.code).toBe('missing-tarball-integrity')
    expect(failed?.recoverable).toBe(false)
    expect(failed?.pkg).toBe('dsh-think-translate')
    expect(failed?.message).toContain('dsh-think-translate')
    expect(failed?.message).toContain('pnpm-lock.yaml')
    expect(failed?.message).toContain('sha512')
    expect(failed?.message).toContain('拒绝所有安装和卸载')

    const scoped = classifyPnpmFailure(`ERR_PNPM_MISSING_TARBALL_INTEGRITY Cannot fetch package "@scope/plugin@https://example.test/plugin.tgz" from the lockfile: it has no "integrity" field, so the downloaded tarball cannot be verified.`)
    expect(scoped?.pkg).toBe('@scope/plugin')
  })

  it('extracts the package from the escaped NDJSON form used in production (#367)', () => {
    const ndjson = String.raw`{"name":"pnpm","level":"error","err":{"code":"ERR_PNPM_MISSING_TARBALL_INTEGRITY","message":"Cannot install package\n\"dsh-think-translate@https://gh-proxy.com/https://codeload.github.com/UncleK/dsh-think-translate/tar.gz/ba71a9bb88f52bc7bbf42225cfb69f7ef8d16900\": its lockfile entry has no \"integrity\" field, so pnpm cannot verify the downloaded tarball."}}`
    expect(classifyPnpmFailure(ndjson)?.pkg).toBe('dsh-think-translate')

    const scoped = ndjson.replace('dsh-think-translate@https://', '@scope/plugin@https://')
    expect(classifyPnpmFailure(scoped)?.pkg).toBe('@scope/plugin')
  })

  it('classifies missing tarball integrity without guessing a package from ambiguous prose (#367)', () => {
    const generic = classifyPnpmFailure(`ERR_PNPM_MISSING_TARBALL_INTEGRITY 1 lockfile entries failed verification:
  a rewritten diagnostic whose package shape is not stable`)
    expect(generic?.code).toBe('missing-tarball-integrity')
    expect(generic?.recoverable).toBe(false)
    expect(generic?.pkg).toBeUndefined()
    expect(generic?.message).not.toContain('undefined')

    // The prose alone is not enough: another tool quoting pnpm's message in
    // a log or help page must not be classified as the active pnpm failure.
    expect(classifyPnpmFailure('Cannot install package "dsh-fake@https://example.test/fake.tgz": its lockfile entry has no "integrity" field')).toBeNull()

    // Even with the code, only the canonical name@https-url shape is safe to
    // expose as `pkg`; do not mistake a bare URL or npm alias for a name.
    expect(classifyPnpmFailure('ERR_PNPM_MISSING_TARBALL_INTEGRITY Cannot install package "https://example.test/fake.tgz": its lockfile entry has no "integrity" field')?.pkg).toBeUndefined()
    expect(classifyPnpmFailure('ERR_PNPM_MISSING_TARBALL_INTEGRITY Cannot install package "alias@npm:real@1.0.0": its lockfile entry has no "integrity" field')?.pkg).toBeUndefined()
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
    // Unrecognized output no longer stays silent (#228): every step can
    // report success and pnpm still not run, and that is the case a user has
    // the least chance of working out alone. It must not MISFILE itself as
    // one of the recognized causes, though — that would send them to fix
    // something they do not have.
    const fallback = provisionHint('', 'some unknown failure')
    expect(fallback).toMatch(/which pnpm|where pnpm/)
    expect(fallback).not.toContain('找不到 npm/corepack')
    expect(fallback).not.toContain('镜像')
  })

  /** #228 again, the other half: "我是有 pnpm 的，可以正常使用". A binary that
   * IS on the path and exits non-zero is a different problem from one that
   * is not there, and the fix for it is not a path. Sending that user to set
   * PNPM_HOME is advice for the opposite situation. */
  it('does not blame the path when pnpm is found and simply fails to run', async () => {
    const { provisionHint } = await import('../src/dsh-cli.ts')
    const failing = provisionHint('', 'some unknown failure', true, {
      kind: 'failed',
      output: 'Error: Cannot find matching keyid: {"signatures":[...]}',
    })
    // Its own output is the explanation, so it is shown.
    expect(failing).toContain('Cannot find matching keyid')
    // And the advice for the OTHER problem is explicitly absent.
    expect(failing).not.toContain('PNPM_HOME=<')
    expect(failing).toContain('PNPM_HOME 没有用')

    // A probe that found nothing keeps the original path-shaped advice.
    const absent = provisionHint('', 'some unknown failure', true, { kind: 'missing', output: 'spawn pnpm ENOENT' })
    expect(absent).toMatch(/which pnpm|where pnpm/)
    expect(absent).toContain('PNPM_HOME')
  })
})

describe('ERR_PNPM_UNEXPECTED_STORE (#244)', () => {
  const OUTPUT = ` ERR_PNPM_UNEXPECTED_STORE  Unexpected store location
The dependencies at "C:\\Users\\lenovo\\.dsh\\profiles\\web\\node_modules" are currently linked from the store at "C:\\Users\\lenovo\\.pnpm-store\\v11".
pnpm now wants to use the store at "C:\\Users\\lenovo\\AppData\\Local\\pnpm\\store\\v11" to link dependencies.`

  it('recognizes it and names BOTH store paths, which is what the user has to act on', () => {
    const failure = classifyPnpmFailure(OUTPUT)
    expect(failure?.code).toBe('unexpected-store')
    // The linked store comes first: it is the one to pass to --store-dir.
    expect(failure?.message).toContain('C:\\Users\\lenovo\\.pnpm-store\\v11')
    expect(failure?.message).toContain('C:\\Users\\lenovo\\AppData\\Local\\pnpm\\store\\v11')
    expect(failure?.message).toContain('--store-dir')
  })

  it('is NOT marked recoverable — the market must not relink a whole node_modules on a guess', () => {
    // `recoverable` drives an automatic `pnpm install` retry. On pnpm 11 the
    // store can only be set by CLI flag, so self-healing would mean adopting
    // whatever path .modules.yaml names — possibly stale, or on a drive that
    // is gone — and relinking everything to do it.
    expect(classifyPnpmFailure(OUTPUT)?.recoverable).toBe(false)
  })

  it('still classifies when the paths cannot be parsed, rather than falling through', () => {
    const failure = classifyPnpmFailure('ERR_PNPM_UNEXPECTED_STORE something reworded upstream')
    expect(failure?.code).toBe('unexpected-store')
    expect(failure?.message).toContain('--store-dir')
  })
})
