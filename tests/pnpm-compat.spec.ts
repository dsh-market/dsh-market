/**
 * The pnpm compatibility layer's decision logic. The -w cases encode issue
 * #20: the flag is required at pnpm-9 workspace roots but is a HARD ERROR
 * (every pnpm major) in a profile without pnpm-workspace.yaml — so the
 * injection must depend on the profile's actual shape.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  it("names the host's own install rejection instead of passing it through (DSH 0.2.1+)", () => {
    // Captured from dsh 0.2.1-rc.1 by installing a release that declares
    // `engines.dsh: >=99.0.0` with the market's force flag. The host enforces
    // the gate itself now, so "the user insisted" is answered by the CLI —
    // and what reached the dialog before this branch was this wall of text.
    const output = [
      'dsh: installation rejected: Plugin dshm-e2e-fixture-a@2.0.0 is incompatible with dsh 0.2.1-rc.1:',
      ' requirements {"engines.dsh":">=99.0.0"}. Running it may cause crashes or data loss.',
      ' Update the plugin or install a plugin version compatible with this dsh runtime.',
      ' To accept this risk explicitly, grant the exact-version exemption for',
      ' dshm-e2e-fixture-a@2.0.0 on dsh 0.2.1-rc.1 with `dsh plugin allow-version` or the plugin manager,',
      ' then retry the installation or restart dsh. Exact-version exemption: not active.',
    ].join('')
    const failure = classifyPnpmFailure(output)
    expect(failure?.code).toBe('host-incompatible-install')
    expect(failure?.recoverable).toBe(false)
    // What happened, why, and the way out — including the host's own exemption.
    expect(failure?.message).toContain('宿主')
    expect(failure?.message).toContain('allow-version')
    expect(failure?.message).toContain('>=99.0.0')
    // A plain market-side failure must not be swallowed by this branch.
    expect(classifyPnpmFailure('ERR_PNPM_FETCH_404 GET https://registry/x: Not Found')?.code).not.toBe('host-incompatible-install')
  })

  it('names the profile write-lock timeout and where the lock is (#914)', () => {
    // The host's atomic-write waits lockWaitMs (120 s by default) and gives
    // up with this line. Before the branch, the dialog showed the bare
    // atomic-write sentence and nothing else — no path, no way out.
    const output = '停用失败: atomic-write: timed out waiting for the writer lock at C:\\Users\\a\\.dsh\\profiles\\desktop\\package.json.lock'
    const failure = classifyPnpmFailure(output)
    expect(failure?.code).toBe('profile-write-lock')
    expect(failure?.recoverable).toBe(true)
    // The path travels, and the message says what is safe to do.
    expect(failure?.message).toContain('package.json.lock')
    expect(failure?.message).toContain('删掉这个文件')
    // Ordinary failures stay ordinary.
    expect(classifyPnpmFailure('ERR_PNPM_FETCH_404 Not Found')?.code).not.toBe('profile-write-lock')
  })

  it('maps each known pnpm failure signature, and only those', () => {
    const hoist = classifyPnpmFailure('ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF  This modules directory was created using a different public-hoist-pattern value. Run "pnpm install" to recreate the modules directory.')
    expect(hoist?.code).toBe('hoist-pattern-diff')
    expect(hoist?.recoverable).toBe(true)
    const windowsLayout = classifyPnpmFailure('ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF This modules directory was created using a different virtual-store-dir-max-length value. Run "pnpm install" to recreate the modules directory.')
    expect(windowsLayout?.code).toBe('hoist-pattern-diff')
    expect(windowsLayout?.recoverable).toBe(true)

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
    // The THIRD face of the same gate, and the only one that fails after the
    // lockfile check has already SAID yes. pnpm skips that check whenever the
    // verification cache holds a run whose recorded window is at least as wide
    // as the current one (`canTrustPastCheck`: `past >= current`), and the
    // RESOLVER then applies the same policy from scratch. A re-resolved
    // dependency that is still inside the window is reported as a
    // `policyViolation`, and the CLI only knows how to consume that through a
    // handler it does not wire for this call path — so it throws instead.
    // Measured on the bundled pnpm 11.7.0 with a cached pass: verification
    // says "passes supply-chain policies", and the very next phase dies with
    // "2 resolution-policy violations were produced but no
    // handleResolutionPolicyViolations callback was wired". Without the
    // classification below the market recognized nothing here and surfaced
    // pnpm's internal hint — a stack trace where the user needed the same
    // "wait, or retry once with the override" answer the other two shapes get.
    const unhandled = classifyPnpmFailure('[ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED] 2 resolution-policy violations were produced but no handleResolutionPolicyViolations callback was wired to react to them.\n\nInternal: resolveDependencies needs a handleResolutionPolicyViolations callback whenever a policy that can produce violations (today: minimumReleaseAge) is active. Wire setupPolicyHandlers (in @pnpm/installing.commands) or supply a callback directly.\nProgress: resolved 242, reused 2, downloaded 0, added 0')
    expect(unhandled?.code).toBe('release-age-violation')
    // The sentence has to name the waiting period: nothing else in that text
    // tells a user why an unrelated plugin refused to uninstall.
    expect(unhandled?.message).toContain('等待期')
    expect(unhandled?.message).toContain('retries once')
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

  it('names the PACKAGE when the 404 arrived as a tarball URL, not the .tgz file (#848)', () => {
    // pnpm's 404 can point at a tarball rather than at the package document.
    // The sentence said "有一个依赖…（retry-0.12.0.tgz）", which is not something
    // the user can look up in their package.json — and it only started
    // mattering when this sentence began reaching users instead of the log
    // (#848 put it in the row). `pkg` itself keeps the last path segment: the
    // install route compares it against the tarball name to tell "this mirror
    // has not synced that release" from a ghost entry.
    const scoped = classifyPnpmFailure('[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/@types/retry/-/retry-0.12.0.tgz: Not Found - 404')
    expect(scoped?.code).toBe('fetch-404')
    expect(scoped?.message).toContain('@types/retry')
    expect(scoped?.message).not.toContain('retry-0.12.0.tgz)')
    expect(scoped?.pkg).toBe('retry-0.12.0.tgz')
    // The percent-encoded scope, as a real URL writes it.
    expect(classifyPnpmFailure('[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/@types%2Fretry/-/retry-0.12.0.tgz: Not Found - 404')?.message)
      .toContain('@types/retry')
    // Unscoped, and a registry mounted under a path prefix: two segments
    // before `/-/` are not automatically a scope.
    expect(classifyPnpmFailure('[ERR_PNPM_FETCH_404] GET https://artifactory.example/api/npm/npm-remote/lodash/-/lodash-4.17.21.tgz: Not Found - 404')?.message)
      .toContain('（lodash）')
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

  it('names the pinned patch that made pnpm refuse the whole command (#740)', () => {
    // Verbatim from @lws2004's report. patchedDependencies is keyed on
    // `pkg@exactVersion`; the installed version moved past the key, and pnpm
    // 12 answers a stale patch by failing the WHOLE command and writing
    // nothing — so the update looked like it simply never applied, and the
    // log held only exit=1. Naming the entry is what turns that into
    // something the user can act on.
    const failed = classifyPnpmFailure([
      'Command failed exit code 1: pnpm add -w \'dsh-skills-anywhere@0.13.0\' \'--reporter=ndjson\'',
      'Error: ERR_PNPM_UNUSED_PATCH',
      '',
      '  × adding a new package',
      '  ╰─▶ The following patches were not used: dsh-skills-anywhere@0.12.1',
      '  help: Either remove them from "patchedDependencies" or update them to match',
      '        packages in your dependencies.',
    ].join('\n'))
    expect(failed?.code).toBe('unused-patch')
    expect(failed?.recoverable).toBe(false)
    expect(failed?.pkg).toBe('dsh-skills-anywhere@0.12.1')
    expect(failed?.message).toContain('dsh-skills-anywhere@0.12.1')
    // The consequence the user actually needs: nothing was written at all.
    expect(failed?.message).toContain('什么都没写')
    expect(failed?.message).toContain('patchedDependencies')
  })

  it('still classifies the unused patch when the body arrives as an ndjson message', () => {
    // pnpm's own error text reaches us inside the ndjson stream as often as
    // on stderr, which is what withDecodedPnpmDiagnostics exists for.
    const failed = classifyPnpmFailure(JSON.stringify({
      name: 'pnpm',
      level: 'error',
      err: { code: 'ERR_PNPM_UNUSED_PATCH', message: 'The following patches were not used: dsh-restart@0.1.3-alpha.4' },
    }))
    expect(failed?.code).toBe('unused-patch')
    expect(failed?.pkg).toBe('dsh-restart@0.1.3-alpha.4')
  })

  it('explains a Windows locked-file rename instead of showing pnpm\'s stack (#389)', () => {
    // Verbatim from @qq1054435284's exported log: updating a plugin the
    // running dsh has loaded. pnpm stages the new version beside the old one
    // and renames it over; Windows refuses while the target's files are open,
    // and for an update the process holding them is the one asking.
    const failed = classifyPnpmFailure(String.raw`{"name":"pnpm","level":"error","err":{"code":"ERR_PNPM_EPERM","message":"[importPackage ~\\.dsh\\profiles\\web\\node_modules\\dsh-passwords] EPERM: operation not permitted, rename '~\\.dsh\\profiles\\web\\node_modules\\dsh-passwords_tmp_38728_10' -> '~\\.dsh\\profiles\\web\\node_modules\\dsh-passwords'"}}`)

    expect(failed?.code).toBe('windows-file-locked')
    expect(failed?.pkg).toBe('dsh-passwords')
    // Says which plugin, that nothing was broken, and what to do about it.
    expect(failed?.message).toContain('dsh-passwords')
    // Deliberately NOT "the installed version is intact". That promise was
    // here and it was false: pnpm's renameOverwrite clears as much of the
    // target directory as it can before retrying the rename, so files beside
    // the one it cannot remove may already be deleted (#608 by @Euezb, who
    // measured it: with only the directory inode locked, `perf/*.js` was gone
    // and `index.js` survived). The route now checks whether the entry
    // survived instead of assuming, and the message points at that check.
    expect(failed?.message).not.toContain('没有被破坏')
    expect(failed?.message).toContain('旁边的内容可能已经被删')
    expect(failed?.message).toContain('入口是否还在')
    expect(failed?.message).toContain('quit DeepSeek Harness')
    // Not retried: the process that would retry is the one holding the files.
    expect(failed?.recoverable).toBe(false)
    expect(failed?.message).not.toContain('undefined')
  })

  it('is worded for the rename, so it also fits a reinstall (#441)', () => {
    // @yandidan1 met this while INSTALLING — a reinstall of a plugin they had
    // just uninstalled — and the message told them their UPDATE had not
    // applied and to disable the plugin under Installed, which no longer
    // existed. The package pnpm names is a dependency, not their plugin.
    const failed = classifyPnpmFailure(String.raw`{"name":"pnpm","level":"error","err":{"code":"ERR_PNPM_EPERM","message":"[importPackage C:\p\web\node_modules\node-hid] EPERM: operation not permitted, rename 'C:\p\web\node_modules\node-hid_tmp_9120_3' -> 'C:\p\web\node_modules\node-hid'"}}`)

    expect(failed?.pkg).toBe('node-hid')
    // Never calls the named package a plugin, and never says "update".
    expect(failed?.message).not.toContain('更新')
    expect(failed?.message).not.toMatch(/updating a plugin/)
    // Names the reason disabling or uninstalling cannot help here.
    expect(failed?.message).toContain('.node')
    expect(failed?.message).toContain('刚卸载完立刻重装')
    expect(failed?.message).toContain('native module')
    // A page refresh is what the uninstall flow suggests, and it is exactly
    // the thing that does not release a native module.
    expect(failed?.message).toContain('not a page refresh')
  })

  it('names the way out that works when restarting alone does not, and says the lock spreads (#798)', () => {
    // Verbatim shape from the reporter's own pnpm.log, a native binding the host
    // loads at startup. Restarting does not help because the package is loaded
    // again before anything can touch it; what worked was switching off the
    // plugin that loads it, restarting, and doing the operation then. The old
    // text ruled that out in one sentence ("disabling is not enough") and sent
    // the reader back to the two things that had already failed.
    const failed = classifyPnpmFailure(String.raw`[ERR_PNPM_EPERM] [importPackage C:\dsh\profiles\desktop\node_modules\@trycua\cua-driver-win32-x64-msvc] EPERM: operation not permitted, rename 'C:\dsh\profiles\desktop\node_modules\@trycua\cua-driver-win32-x64-msvc_tmp_26500_6' -> 'C:\dsh\profiles\desktop\node_modules\@trycua\cua-driver-win32-x64-msvc'`)

    expect(failed?.pkg).toBe('@trycua/cua-driver-win32-x64-msvc')
    // The package is named, and the message says it blocks the OTHER plugins' work.
    expect(failed?.message).toContain('@trycua/cua-driver-win32-x64-msvc')
    expect(failed?.message).toContain('其他')
    expect(failed?.message).toContain('every OTHER plugin operation')
    // The workable path, in both languages.
    expect(failed?.message).toContain('先停用加载它的插件，再重启')
    expect(failed?.message).toContain('disable the plugin that loads it, restart')
    // It no longer says disabling is "not enough" without the restart that makes it enough.
    expect(failed?.message).not.toContain('停用插件、甚至卸载插件都不够')
    expect(failed?.message).not.toContain('undefined')
  })

  it('classifies pnpm 12\'s wording of the refused swap the same way (#608)', () => {
    // pnpm 12's native CLI reports the same refused swap without an
    // ERR_PNPM_ code, seen on macOS with the target directory locked; the
    // wording after the colon is the OS error and differs per platform.
    const failed = classifyPnpmFailure('× adding a new package\n  ╰─▶ failed to remove existing directory "/p/web/node_modules/left-pad" prior to swap: Operation not permitted (os error 1)')
    expect(failed?.code).toBe('windows-file-locked')
    expect(failed?.recoverable).toBe(false)
    expect(failed?.message).not.toContain('undefined')
  })

  it('classifies a locked rename with no readable package name (#389)', () => {
    const generic = classifyPnpmFailure('ERR_PNPM_EPERM: something the reporter reworded')
    expect(generic?.code).toBe('windows-file-locked')
    expect(generic?.pkg).toBeUndefined()
    expect(generic?.message).not.toContain('undefined')
    expect(generic?.message).not.toContain('（）')
  })

  it('separates a profile file from a package directory when Windows refuses the rename (#786)', () => {
    // Verbatim from the reporter's own profile, pnpm 11.7.0. pnpm writes
    // package.json and pnpm-lock.yaml through write-file-atomic, whose temp
    // name is `<file>.<hash>` — and which renames ONCE with no retry. Defender
    // or the indexer touching the file for an instant therefore fails the whole
    // run, after pnpm has already built and linked the new commit.
    const failed = classifyPnpmFailure(
      String.raw`[EPERM] EPERM: operation not permitted, rename 'C:\Users\Loner\.dsh\profiles\desktop\pnpm-lock.yaml.3015012533' -> 'C:\Users\Loner\.dsh\profiles\desktop\pnpm-lock.yaml'`,
    )
    expect(failed?.code).toBe('profile-file-locked')
    // The plugin is NOT what is locked, so the "quit DSH" advice is wrong here
    // and the failure clears on a plain retry.
    //
    // NOT marked recoverable, like the other same-argv retries
    // (`transient-network`, `fetch-timeout`): the flag means "re-running
    // `pnpm install` is the documented recovery", and nothing reads it to
    // decide a retry — `withHoistRecovery` keys on this code. Claiming it here
    // would invite a rebuild of `node_modules` over a one-file rename.
    expect(failed?.recoverable).toBe(false)
    expect(failed?.message).toContain('pnpm-lock.yaml')
    expect(failed?.message).not.toContain('quit DeepSeek Harness')
    expect(failed?.message).not.toContain('退出 DeepSeek Harness')
    // `profile` is the market's own word for an internal concept, and the
    // retry has ALREADY run by the time this text is shown (install.ts
    // composes it after the recovery chain), so promising one would leave the
    // reader waiting for something that already happened.
    expect(failed?.message).not.toContain('profile')
    expect(failed?.message).toContain('已经自动重试过一次')
    expect(failed?.message).toContain('already retried once')
    // Never claims a package was named: none was.
    expect(failed?.pkg).toBeUndefined()

    // package.json and pnpm-workspace.yaml are the same momentary-holder case.
    expect(classifyPnpmFailure(
      String.raw`EPERM: operation not permitted, rename 'C:\p\web\package.json.1621249915' -> 'C:\p\web\package.json'`,
    )?.code).toBe('profile-file-locked')

    // …and so is the lockfile pnpm keeps INSIDE node_modules. `writeLockfiles`
    // writes it through the same write-file-atomic, in the same `Promise.all`
    // as the profile's own lockfile (pnpm 11.7.0, both branches), so the temp
    // name `…\.pnpm\lock.yaml.<hash>` fails the run identically. Answering it
    // as a package directory would roll the profile's lockfile back over a
    // node_modules that already holds the new build — the desync this branch
    // exists to prevent.
    const inner = classifyPnpmFailure(
      String.raw`[EPERM] EPERM: operation not permitted, rename 'C:\Users\Loner\.dsh\profiles\desktop\node_modules\.pnpm\lock.yaml.3015012533' -> 'C:\Users\Loner\.dsh\profiles\desktop\node_modules\.pnpm\lock.yaml'`,
    )
    expect(inner?.code).toBe('profile-file-locked')
    expect(inner?.recoverable).toBe(false)
    // The inner lockfile is not a package name either.
    expect(inner?.pkg).toBeUndefined()

    // …but a PACKAGE directory still gets the #389 answer, including pnpm's
    // `<name>_tmp_<pid>_<n>` staging shape and a bare ERR_PNPM_EPERM.
    expect(classifyPnpmFailure(
      String.raw`EPERM: operation not permitted, rename 'C:\p\web\node_modules\dsh-passwords_tmp_38728_10' -> 'C:\p\web\node_modules\dsh-passwords'`,
    )?.code).toBe('windows-file-locked')
    expect(classifyPnpmFailure('ERR_PNPM_EPERM: something the reporter reworded')?.code)
      .toBe('windows-file-locked')
    // A `lock.yaml` somewhere that is NOT the profile's virtual store stays
    // with the package-directory answer: the pattern must not be loosened into
    // "any lock.yaml".
    expect(classifyPnpmFailure(
      String.raw`EPERM: operation not permitted, rename 'C:\p\web\some-pkg\lock.yaml.123' -> 'C:\p\web\some-pkg\lock.yaml'`,
    )?.code).toBe('windows-file-locked')
  })

  it('reads the profile-file lock out of pnpm\'s ndjson reporter too (#786)', () => {
    // Production mutating commands run with --reporter=ndjson, where the OS
    // message arrives JSON-escaped: every backslash is doubled, so a pattern
    // tested only against pretty output silently matches nothing.
    const failed = classifyPnpmFailure(JSON.stringify({
      name: 'pnpm',
      level: 'error',
      err: {
        code: 'EPERM',
        message: String.raw`EPERM: operation not permitted, rename 'C:\Users\Loner\.dsh\profiles\desktop\pnpm-lock.yaml.3015012533' -> 'C:\Users\Loner\.dsh\profiles\desktop\pnpm-lock.yaml'`,
      },
    }))
    expect(failed?.code).toBe('profile-file-locked')
    expect(failed?.recoverable).toBe(false)

    // Same shape for the inner virtual-store lockfile, which only exists in
    // the escaped form on this path.
    const inner = classifyPnpmFailure(JSON.stringify({
      name: 'pnpm',
      level: 'error',
      err: {
        code: 'EPERM',
        message: String.raw`EPERM: operation not permitted, rename 'C:\Users\Loner\.dsh\profiles\desktop\node_modules\.pnpm\lock.yaml.3015012533' -> 'C:\Users\Loner\.dsh\profiles\desktop\node_modules\.pnpm\lock.yaml'`,
      },
    }))
    expect(inner?.code).toBe('profile-file-locked')
    expect(inner?.recoverable).toBe(false)
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
    expect(failed?.message).toContain('安装和卸载')
    // Deliberately no longer advises "re-resolve to record a sha512": pnpm
    // refuses every operation in the profile, including uninstalling the
    // offender, so that was an instruction the user could not carry out
    // (#422). The message now gives the one step that does work.
    expect(failed?.message).not.toContain('sha512')
    expect(failed?.message).toContain('市场不会自动为未经验证的字节生成校验值')

    const scoped = classifyPnpmFailure(`ERR_PNPM_MISSING_TARBALL_INTEGRITY Cannot fetch package "@scope/plugin@https://example.test/plugin.tgz" from the lockfile: it has no "integrity" field, so the downloaded tarball cannot be verified.`)
    expect(scoped?.pkg).toBe('@scope/plugin')
  })

  it('extracts the package from the escaped NDJSON form used in production (#367)', () => {
    const ndjson = String.raw`{"name":"pnpm","level":"error","err":{"code":"ERR_PNPM_MISSING_TARBALL_INTEGRITY","message":"Cannot install package\n\"dsh-think-translate@https://gh-proxy.com/https://codeload.github.com/UncleK/dsh-think-translate/tar.gz/ba71a9bb88f52bc7bbf42225cfb69f7ef8d16900\": its lockfile entry has no \"integrity\" field, so pnpm cannot verify the downloaded tarball."}}`
    expect(classifyPnpmFailure(ndjson)?.pkg).toBe('dsh-think-translate')

    const scoped = ndjson.replace('dsh-think-translate@https://', '@scope/plugin@https://')
    expect(classifyPnpmFailure(scoped)?.pkg).toBe('@scope/plugin')
  })

  it('names the violators in pnpm 11’s whole-lockfile verification report (#422)', () => {
    // Captured verbatim from pnpm 11.22.0 refusing a profile whose lockfile
    // an older market had written with a mirror-prefixed codeload URL. pnpm
    // <= 11.20 named one package per error; 11.21+ verifies the whole
    // lockfile up front and lists every violator, which the old parser could
    // not read — leaving the user told an entry was bad but not which one,
    // in the one failure where pnpm will not even let them uninstall it.
    const report = classifyPnpmFailure(`[ERR_PNPM_MISSING_TARBALL_INTEGRITY] 1 lockfile entries failed verification:
  dsh-music-huazai@0.1.0 has no "integrity" field, so its downloaded tarball cannot be verified

The lockfile contains entries that the active policies reject.`)
    expect(report?.code).toBe('missing-tarball-integrity')
    expect(report?.recoverable).toBe(false)
    expect(report?.pkg).toBe('dsh-music-huazai')
    expect(report?.message).toContain('dsh-music-huazai')
    // The recovery is one entry, not the file: deleting the lockfile
    // re-resolves every other plugin in the profile.
    expect(report?.message).toContain('不要删整个 pnpm-lock.yaml')
    expect(report?.message).toContain('Do not delete the whole pnpm-lock.yaml')

    // Several violators at once: all are named, but `pkg` stays undefined
    // because callers read it as "the package this failure is about".
    const many = classifyPnpmFailure(`[ERR_PNPM_MISSING_TARBALL_INTEGRITY] 2 lockfile entries failed verification:
  @scope/plugin@1.2.0 has no "integrity" field, so its downloaded tarball cannot be verified
  dsh-music-huazai@0.1.0 has no "integrity" field, so its downloaded tarball cannot be verified`)
    expect(many?.pkg).toBeUndefined()
    expect(many?.message).toContain('@scope/plugin')
    expect(many?.message).toContain('dsh-music-huazai')

    // pnpm's mixed-code variant inserts the violation code before the reason.
    const mixed = classifyPnpmFailure(`ERR_PNPM_MISSING_TARBALL_INTEGRITY 1 lockfile entries failed verification:
  dsh-music-huazai@0.1.0 [MISSING_TARBALL_INTEGRITY] has no "integrity" field, so its downloaded tarball cannot be verified`)
    expect(mixed?.pkg).toBe('dsh-music-huazai')
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

    // The same restraint in the pnpm 11 list shape, where there are no
    // quotes to lean on: an alias must not be read as its target's name, and
    // a bare URL is not a package name.
    expect(classifyPnpmFailure(`ERR_PNPM_MISSING_TARBALL_INTEGRITY 1 lockfile entries failed verification:
  alias@npm:real@1.0.0 has no "integrity" field, so its downloaded tarball cannot be verified`)?.pkg).toBeUndefined()
    expect(classifyPnpmFailure(`ERR_PNPM_MISSING_TARBALL_INTEGRITY 1 lockfile entries failed verification:
  https://example.test/fake.tgz has no "integrity" field, so its downloaded tarball cannot be verified`)?.pkg).toBeUndefined()
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

  it('points at Download region → Global when the China npm mirror resets a tarball (#926)', () => {
    // Measured shape from #926: pnpm retries the same Tencent mirror URL, then
    // gives up. Same-argv retry (#83) still hits that host, so the message
    // must name the real next step — switch Download region — not "try later".
    const reset = classifyPnpmFailure([
      'GET https://mirrors.cloud.tencent.com/npm/dsh-mobile/-/dsh-mobile-0.6.12.tgz error (ECONNRESET). Will retry in 10 seconds. 2 retries left.',
      'GET https://mirrors.cloud.tencent.com/npm/dsh-mobile/-/dsh-mobile-0.6.12.tgz error (ECONNRESET). Will retry in 1 minute. 1 retries left.',
      '[ERROR] terminated',
    ].join('\n'))
    expect(reset?.code).toBe('transient-network')
    expect(reset?.message).toContain('下载区域')
    expect(reset?.message).toContain('全球')
    expect(reset?.message).toContain('Download region')
    expect(reset?.message).toContain('Global')
    expect(reset?.message).not.toContain('稍后再试')
    // socket hang up on the same mirror tarball is the same dead end.
    const hang = classifyPnpmFailure(
      'FetchError: request to https://mirrors.cloud.tencent.com/npm/dsh-mobile/-/dsh-mobile-0.6.12.tgz failed, reason: socket hang up',
    )
    expect(hang?.code).toBe('transient-network')
    expect(hang?.message).toContain('下载区域')
    // Scoped tarball on the same host.
    expect(classifyPnpmFailure(
      'GET https://mirrors.cloud.tencent.com/npm/@scope/pkg/-/pkg-1.0.0.tgz error (ECONNRESET)',
    )?.message).toContain('下载区域')
    // Official registry reset, or a China-mirror meta fetch (no .tgz), stay on
    // the generic "try again shortly" path — switching region is not the fix.
    expect(classifyPnpmFailure(
      'GET https://registry.npmjs.org/dsh-mobile/-/dsh-mobile-0.6.12.tgz error (ECONNRESET)',
    )?.message).toContain('稍后再试')
    expect(classifyPnpmFailure(
      'GET https://mirrors.cloud.tencent.com/npm/dsh-mobile error (ECONNRESET)',
    )?.message).toContain('稍后再试')
    // China-mirror .tgz mentioned, but the reset is on another host — do not
    // blame Download region (common when a github: dep's codeload flakes).
    expect(classifyPnpmFailure([
      'GET https://mirrors.cloud.tencent.com/npm/dsh-mobile/-/dsh-mobile-0.6.12.tgz 200 OK',
      'GET https://codeload.github.com/o/r/tar.gz/abc error (ECONNRESET)',
    ].join('\n'))?.message).toContain('稍后再试')
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

  it('recognizes a git-hosted package whose own build failed (ERR_PNPM_PREPARE_PACKAGE)', () => {
    // Verbatim from a real profile: updating an unrelated npm plugin
    // re-resolved a floating github: dependency to a new HEAD whose own
    // pnpm-lock.yaml fails pnpm 11's supply-chain check against a mirror
    // registry. pnpm rethrows the inner `pnpm install` failure with only a
    // one-line summary, so the classifier must name the package from that.
    const failed = classifyPnpmFailure('ERR_PNPM_PREPARE_PACKAGE: Failed to prepare git-hosted package fetched from "https://codeload.github.com/omdsh-dev/DSH-better-sidebar/tar.gz/d70db8fb026d002b22ae97efd893ff08ee9f0d10": dsh-better-sidebar@0.18.0-alpha.0 pnpm-install: `pnpm install`Exit status 1')
    expect(failed?.code).toBe('git-prepare-failed')
    expect(failed?.recoverable).toBe(false)
    expect(failed?.pkg).toBe('dsh-better-sidebar')
    expect(failed?.message).toContain('dsh-better-sidebar')
    expect(failed?.message).toContain('registry')
    expect(failed?.message).toContain('github:owner/repo#<commit>')
    // The scoped form is read the same way.
    const scoped = classifyPnpmFailure('ERR_PNPM_PREPARE_PACKAGE: Failed to prepare git-hosted package fetched from "https://codeload.github.com/o/r/tar.gz/abc": @scope/plugin@1.0.0 pnpm-install: `pnpm install`Exit status 1')
    expect(scoped?.pkg).toBe('@scope/plugin')
    // Unparseable prose still classifies, without inventing a package.
    const generic = classifyPnpmFailure('ERR_PNPM_PREPARE_PACKAGE: something reworded upstream')
    expect(generic?.code).toBe('git-prepare-failed')
    expect(generic?.pkg).toBeUndefined()
    expect(generic?.message).not.toContain('undefined')
  })

  it('recognizes the tarball URL mismatch supply-chain check (ERR_PNPM_TARBALL_URL_MISMATCH)', () => {
    // Captured from pnpm 11.7.0 preparing a git-hosted package whose
    // committed lockfile names registry.npmjs.org tarballs while the profile
    // resolves registry.npmmirror.com.
    const failed = classifyPnpmFailure(`[ERR_PNPM_TARBALL_URL_MISMATCH] 2 lockfile entries failed verification:
  @deepseek-ai/dsh-util-crypto@0.1.2-alpha.2 has a tarball URL (https://registry.npmjs.org/@deepseek-ai/dsh-util-crypto/-/dsh-util-crypto-0.1.2-alpha.2.tgz) that does not match the registry's published metadata (https://registry.npmmirror.com/@deepseek-ai/dsh-util-crypto/-/dsh-util-crypto-0.1.2-alpha.2.tgz)
  @deepseek-ai/dsh-util-time@0.1.2-alpha.2 has a tarball URL (https://registry.npmjs.org/@deepseek-ai/dsh-util-time/-/dsh-util-time-0.1.2-alpha.2.tgz) that does not match the registry's published metadata (https://registry.npmmirror.com/@deepseek-ai/dsh-util-time/-/dsh-util-time-0.1.2-alpha.2.tgz)

The lockfile contains entries that the active policies reject.`)
    expect(failed?.code).toBe('tarball-url-mismatch')
    expect(failed?.recoverable).toBe(false)
    // Two violators: both named, `pkg` stays undefined.
    expect(failed?.pkg).toBeUndefined()
    expect(failed?.message).toContain('@deepseek-ai/dsh-util-crypto')
    expect(failed?.message).toContain('@deepseek-ai/dsh-util-time')
    expect(failed?.message).toContain('pnpm clean --lockfile')
    // A single violator is exposed as `pkg`.
    const single = classifyPnpmFailure(`[ERR_PNPM_TARBALL_URL_MISMATCH] 1 lockfile entries failed verification:
  dsh-music-huazai@0.1.0 has a tarball URL (https://registry.npmjs.org/x.tgz) that does not match the registry's published metadata (https://registry.npmmirror.com/x.tgz)`)
    expect(single?.pkg).toBe('dsh-music-huazai')
    // The escaped NDJSON form used in production decodes the same way.
    const ndjson = String.raw`{"name":"pnpm","level":"error","err":{"code":"ERR_PNPM_TARBALL_URL_MISMATCH","message":"1 lockfile entries failed verification:\n  dsh-music-huazai@0.1.0 has a tarball URL (https://registry.npmjs.org/x.tgz) that does not match the registry's published metadata (https://registry.npmmirror.com/x.tgz)"}}`
    expect(classifyPnpmFailure(ndjson)?.pkg).toBe('dsh-music-huazai')
  })

  // #808 by @Tofu707: the profile's own lockfile, in the two shapes pnpm
  // reports with two codes. Both fixtures below are real captures from
  // 2026-10-08 against a throwaway copy of a profile lockfile — one importer
  // aligned and its `packages:` entry removed, and one whose recorded
  // specifier no longer matches package.json.
  it('classifies a lockfile contradicting itself, and names the entry that is missing (#808)', () => {
    // pnpm 12.8.1 with `--reporter=ndjson`, which is what market commands use.
    // On this major stdout is EMPTY (0 bytes) and the whole error block arrives
    // on stderr as plain text, so this is also the production form. Note the
    // `help:` line: 12.8.1 offers `--fix-lockfile` here, while 11.24.0 offers
    // `--no-frozen-lockfile` for the same failure — which is why no rule may
    // key on that line, only on the code and on pnpm's own phrase.
    const failed = classifyPnpmFailure([
      'Error: ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY',
      '  × installing dependencies',
      "  ╰─▶ Broken lockfile: no entry for 'dshmarket@1.47.0' in pnpm-lock.yaml",
      '  help: This issue is probably caused by a badly resolved merge conflict.',
      "        To fix the lockfile, run 'pnpm install --fix-lockfile'.",
    ].join('\n'))
    expect(failed?.code).toBe('lockfile-broken')
    expect(failed?.recoverable).toBe(false)
    // The entry is named, but not as `pkg`: the repair is in the lockfile, and
    // callers act on `pkg` (the #289 peer retry, the #65 ghost-entry advice).
    expect(failed?.pkg).toBeUndefined()
    expect(failed?.message).toContain('dshmarket@1.47.0')
    expect(failed?.message).toContain('不要删掉整个 pnpm-lock.yaml')
  })

  it('lets a broken lockfile speak over the policy code it provokes (#1075)', () => {
    // The reporter's log, verbatim in shape: the lockfile is missing an entry,
    // pnpm re-resolves, and the resolver's fresh-release check throws as a
    // side effect. Seconds earlier the same run had PASSED the supply-chain
    // check, so the wait-period story the policy code tells is not what
    // happened — and the retry it promises (a minimum-release-age override)
    // cannot repair a missing entry.
    const failed = classifyPnpmFailure([
      '✓ Lockfile passes supply-chain policies (verified 1m ago)',
      'Lockfile is up to date, resolution step is skipped',
      "[WARN] Broken lockfile: no entry for 'billion-context@0.1.210' in pnpm-lock.yaml",
      '[ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY] The lockfile is broken! Resolution step will be performed to fix it.',
      '[WARN] Could not find preferred package billion-context@0.1.210 in lockfile',
      'Progress: resolved 1, reused 0, downloaded 0, added 0',
      '[ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED] 1 resolution-policy violation was produced but no handleResolutionPolicyViolations callback was wired to react to them.',
    ].join('\n'))

    expect(failed?.code).toBe('lockfile-broken')
    expect(failed?.recoverable).toBe(false)
    expect(failed?.message).toContain('billion-context@0.1.210')
    // The wait-period sentence must not be what the user is shown.
    expect(failed?.message).not.toContain('安全等待期')
  })

  it('reads the same failure out of pnpm 11\u2019s ndjson record, which arrives on stdout (#808)', () => {
    // 11.24.0 inverts the streams: stdout carries the record as one JSON line
    // (stderr is 0 bytes). The decoder lifts err.message out of it, so the
    // human sentence matches even though the raw stream holds it escaped.
    // Fields that are machine-specific (time/hostname/pid/stack) are trimmed;
    // everything the classifier reads is verbatim.
    const record = String.raw`{"level":"error","name":"pnpm","code":"ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY","hint":"This issue is probably caused by a badly resolved merge conflict.\nTo fix the lockfile, run 'pnpm install --no-frozen-lockfile'.","err":{"name":"pnpm","message":"Broken lockfile: no entry for 'dshmarket@1.47.0' in pnpm-lock.yaml","code":"ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY"}}`
    const failed = classifyPnpmFailure(record)
    expect(failed?.code).toBe('lockfile-broken')
    expect(failed?.message).toContain('dshmarket@1.47.0')
    // pnpm's phrase alone is enough: a record whose message survives but whose
    // `code` field is absent still classifies (the anchor is not one string).
    const phraseOnly = String.raw`{"level":"error","name":"pnpm","err":{"message":"Broken lockfile: no entry for 'dsh-plugin-x@0.4.1' in pnpm-lock.yaml"}}`
    expect(classifyPnpmFailure(phraseOnly)?.code).toBe('lockfile-broken')
    expect(classifyPnpmFailure(phraseOnly)?.message).toContain('dsh-plugin-x@0.4.1')
  })

  it('keeps a lockfile that is merely behind the manifest separate from a broken one (#808)', () => {
    // pnpm 12.8.1, plain text on stderr. The sentence pnpm uses here wraps
    // across two lines ("… is not up" / "to date with package.json."), so the
    // rule anchors on the code — a sentence-anchored rule would miss exactly
    // the form the user is looking at.
    const failed = classifyPnpmFailure([
      'Error: ERR_PNPM_OUTDATED_LOCKFILE',
      '  × installing dependencies',
      '  ╰─▶ Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up',
      '      to date with package.json.',
      '        Failure reason:',
      "        specifiers in the lockfile don't match specifiers in package.json:",
      '      * in importers["."]:',
      '      * 1 dependency is mismatched:',
      '        - dshmarket (lockfile: ^1.46.0, manifest: ^1.47.0)',
      '  help: Regenerate the lockfile with `pnpm install --lockfile-only` so that',
      '        pnpm-lock.yaml reflects the current package.json, then re-run `pnpm',
      '        install --frozen-lockfile`.',
    ].join('\n'))
    expect(failed?.code).toBe('lockfile-outdated')
    expect(failed?.recoverable).toBe(false)
    expect(failed?.message).toContain('package.json')
    // Its own repair, not the other one's: the two codes exist because the two
    // repairs differ, and neither message may borrow the other's command.
    expect(failed?.message).toContain('不要互相套用')
    // The ndjson form used in production says the same thing on one line.
    const ndjson = String.raw`{"level":"error","name":"pnpm","code":"ERR_PNPM_OUTDATED_LOCKFILE","hint":"Note that in CI environments this setting is true by default. If you still need to run install in such cases, use \"pnpm install --no-frozen-lockfile\"","err":{"name":"pnpm","message":"Cannot install with \"frozen-lockfile\" because pnpm-lock.yaml is not up to date with <ROOT>/package.json","code":"ERR_PNPM_OUTDATED_LOCKFILE"}}`
    expect(classifyPnpmFailure(ndjson)?.code).toBe('lockfile-outdated')
  })
})

describe('ERR_PNPM_NO_MATCHING_VERSION — host peer with only pre-releases (#569)', () => {
  // Verbatim pnpm 12.4.1 output for:
  //   pnpm add @deepseek-ai/dsh-tools@'>=0.1.0'
  // where every published version of the package is a pre-release. Kept
  // word-for-word (including the wrapped URL) per the house rule for
  // classifier fixtures: if pnpm rewraps or rewords, a test breaks instead
  // of a user-facing message.
  const OUTPUT = [
    'Error: ERR_PNPM_NO_MATCHING_VERSION',
    '',
    '  × adding a new package',
    '  ╰─▶ Failed to resolve dependency tree: No matching version found for',
    '      @deepseek-ai/dsh-tools@>=0.1.0 while fetching it from https://',
    '      registry.npmjs.org/',
    '  help: The latest release of @deepseek-ai/dsh-tools is "0.0.1-rc.1".',
    '        ',
    '        Other releases are:',
    '          * alpha: 0.1.5-alpha.2',
    '          * next: 0.1.5-rc.2',
    '        ',
    '        If you need the full list of all 21 published versions run "pnpm view',
    '        @deepseek-ai/dsh-tools versions".',
  ].join('\n')

  it('gets its own code, not fetch-404', () => {
    const failure = classifyPnpmFailure(OUTPUT)
    expect(failure?.code).toBe('no-matching-version')
    expect(failure?.code).not.toBe('fetch-404')
  })

  it('extracts the scoped host peer through the wrapped output', () => {
    const failure = classifyPnpmFailure(OUTPUT)
    expect(failure?.pkg).toBe('@deepseek-ai/dsh-tools')
  })

  it('explains the host-provided provision and the automatic retry', () => {
    const failure = classifyPnpmFailure(OUTPUT)
    expect(failure?.message).toContain('宿主包（@deepseek-ai/dsh-tools）')
    expect(failure?.message).toContain('自动重试')
  })

  it('degrades to the unnamed wording when the package name cannot be read', () => {
    const failure = classifyPnpmFailure('Error: ERR_PNPM_NO_MATCHING_VERSION\n  × adding a new package')
    expect(failure?.code).toBe('no-matching-version')
    expect(failure?.message).toContain('没有可满足的版本')
    expect(failure?.message).not.toContain('宿主包（')
  })

  it('still names the plain-404 shape as fetch-404 (unchanged)', () => {
    expect(classifyPnpmFailure('[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/ghost: Not Found - 404')?.code).toBe('fetch-404')
  })

  it('names an exact pin the registry cannot see yet — not "never published" (#927)', () => {
    // Measured shape from #927: market pinned @1.1.3 from /latest; pnpm's
    // packument on the same Tencent mirror still stopped at 1.1.2.
    const output = [
      '[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for @michengai/dsh-archive-manager@1.1.3 while fetching it from https://mirrors.cloud.tencent.com/npm/',
      'The latest release of @michengai/dsh-archive-manager is "1.1.2". Published at 2026/10/18 19:45:43',
    ].join('\n')
    const failure = classifyPnpmFailure(output)
    expect(failure?.code).toBe('exact-version-missing')
    expect(failure?.pkg).toBe('@michengai/dsh-archive-manager')
    expect(failure?.message).toContain('@michengai/dsh-archive-manager@1.1.3')
    expect(failure?.message).toContain('1.1.2')
    expect(failure?.message).toContain('还没同步')
    expect(failure?.message).toContain('下载区域')
    expect(failure?.message).toContain('Global')
    expect(failure?.message).not.toContain('通常是该版本被弃用或从未发布')
    // A real range with no match stays on the generic withdrawn wording.
    const range = classifyPnpmFailure(
      'ERR_PNPM_NO_MATCHING_VERSION  No matching version found for some-dep@^9.0.0 while fetching it from https://registry.npmjs.org/',
    )
    expect(range?.code).toBe('no-matching-version')
    expect(range?.message).toContain('通常是该版本被弃用或从未发布')
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

describe('ERR_PNPM_UNEXPECTED_STORE across a pnpm major (#1100)', () => {
  const OUTPUT = ` ERR_PNPM_UNEXPECTED_STORE  Unexpected store location
The dependencies at "/root/.dsh/profiles/web/node_modules" are currently linked from the store at "/root/.dsh/.pnpm-store/v10".
pnpm now wants to use the store at "/tmp/store-v10/v11" to link dependencies.
      (This error may happen if the node_modules was installed with a different major version of pnpm)`

  function profileWithRecord(record: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-store-'))
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '.modules.yaml'), record)
    return dir
  }

  function profileRecording(packageManager: string): string {
    return profileWithRecord([
      'layoutVersion: 5',
      'nodeLinker: hoisted',
      `packageManager: pnpm@${packageManager}`,
      'storeDir: /root/.dsh/.pnpm-store/v10',
      '',
    ].join('\n'))
  }

  it('names the pnpm that built node_modules and stops recommending storeDir', () => {
    // pnpm appends its own version segment under whatever storeDir says, so
    // pointing pnpm 12 at a copy of the recorded v10 store lands on
    // `<that>/v11` and fails identically. The reported advice could not work.
    const dir = profileRecording('10.34.9')
    const failure = classifyPnpmFailure(OUTPUT, 1, { profileDirectory: dir })

    expect(failure?.code).toBe('unexpected-store')
    expect(failure?.message).toContain('10.34.9')
    expect(failure?.message).toMatch(/写 storeDir 修不好|cannot fix this/)
    expect(failure?.message).not.toMatch(/storeDir: <上面第一个路径>|storeDir: <the first path above>/)
  })

  it('still points at the recorded version when the profile cannot be read', () => {
    const failure = classifyPnpmFailure(OUTPUT, 1)
    expect(failure?.message).toMatch(/modules\.yaml/)
    expect(failure?.message).toMatch(/写 storeDir 修不好|cannot fix this/)
  })

  // Despite its name the file holds JSON on newer pnpm (measured: 10.34.9,
  // 11.8.0, 12.16.1) and YAML on older pnpm (9.15.9, 10.20.0, 10.28.2).
  const RECORD = {
    layoutVersion: 5,
    nodeLinker: 'hoisted',
    packageManager: 'pnpm@10.34.9',
    storeDir: '/root/.dsh/.pnpm-store/v10',
  }

  it.each([
    ['one-line JSON, the shape the report pasted', JSON.stringify(RECORD)],
    ['indented JSON, the shape pnpm writes', `${JSON.stringify(RECORD, null, 2)}\n`],
    ['YAML, the shape older pnpm writes', 'layoutVersion: 5\npackageManager: pnpm@10.34.9\nstoreDir: /s/v10\n'],
  ])('names the recorded version from %s', (_shape, record) => {
    const failure = classifyPnpmFailure(OUTPUT, 1, { profileDirectory: profileWithRecord(record) })

    expect(failure?.code).toBe('unexpected-store')
    expect(failure?.message).toContain('pnpm 10.34.9')
    // This line only appears when the version could not be read.
    expect(failure?.message).not.toMatch(/modules\.yaml/)
  })

  it.each([
    ['another package manager', JSON.stringify({ packageManager: 'npm@10.34.9' })],
    ['a value that is not a version', JSON.stringify({ packageManager: 'pnpm@latest' })],
    ['a value that is not a string', JSON.stringify({ packageManager: 10 })],
    ['the field only inside another object', JSON.stringify({ hoistedDependencies: { packageManager: 'pnpm@10.34.9' } })],
    ['JSON that is not an object', 'null'],
    ['a file cut off mid-write', '{\n  "packageManager": "pnpm@10.34.9",\n'],
    ['an empty file', ''],
  ])('answers with the generic wording, not a throw, for %s', (_shape, record) => {
    const failure = classifyPnpmFailure(OUTPUT, 1, { profileDirectory: profileWithRecord(record) })

    expect(failure?.code).toBe('unexpected-store')
    expect(failure?.message).toMatch(/modules\.yaml/)
    expect(failure?.message).toMatch(/写 storeDir 修不好|cannot fix this/)
  })

  // The market runs every mutation with --reporter=ndjson, and that stream has
  // no rendered text and no "different major" sentence. Shapes measured on real
  // pnpm 11.8.0 and 12.16.1, paths made up.
  const pnpmContext = (storeDir: string) => JSON.stringify({ name: 'pnpm:context', level: 'debug', currentLockfileExists: true, storeDir })
  const error11 = (expectedStorePath: string, actualStorePath: string) => JSON.stringify({
    level: 'error',
    name: 'pnpm',
    code: 'ERR_PNPM_UNEXPECTED_STORE',
    expectedStorePath,
    actualStorePath,
    modulesDir: '/root/.dsh/profiles/web/node_modules',
    err: { name: 'pnpm', message: 'Unexpected store location', code: 'ERR_PNPM_UNEXPECTED_STORE' },
  })
  const ndjson11 = (expected: string, actual: string) => [pnpmContext(actual), error11(expected, actual)].join('\n')
  const ERROR_12 = JSON.stringify({ name: 'pnpm', level: 'error', code: 'ERR_PNPM_UNEXPECTED_STORE', message: 'adding a new package: Unexpected store location', prefix: '/root/.dsh/profiles/web' })
  const ndjson12 = (storeDir: string) => [pnpmContext(storeDir), ERROR_12].join('\n')
  // pnpm 12's default reporter, which wraps inside the quotes.
  const wrapped12 = `Error: ERR_PNPM_UNEXPECTED_STORE

  × adding a new package
  ╰─▶ Unexpected store location
  help: The dependencies at "/root/.dsh/profiles/web/node_modules" are currently linked from the store
        at "/root/.dsh/.pnpm-store/v10".

        pnpm now wants to use the store at "/root/.dsh/.pnpm-
        store/v11" to link dependencies.

        (This error may happen if the node_modules was installed with a
        different major version of pnpm)`
  const LINKED = '/root/.dsh/.pnpm-store/v10'
  const WANTED = '/root/.dsh/.pnpm-store/v11'

  it.each([
    ['pnpm 11 ndjson, whose error event names both stores', ndjson11(LINKED, WANTED)],
    ['pnpm 12 ndjson, which only says the store it wants', ndjson12(WANTED)],
    ['pnpm 12 wrapped text', wrapped12],
  ])('recognizes the mismatch from %s', (_shape, output) => {
    const failure = classifyPnpmFailure(output, 1, { profileDirectory: profileRecording('10.34.9') })

    expect(failure?.code).toBe('unexpected-store')
    expect(failure?.message).toContain('pnpm 10.34.9')
    expect(failure?.message).toMatch(/写 storeDir 修不好/)
    expect(failure?.message).not.toContain('storeDir: <上面第一个路径>')
    // The wording points at "the second path above", so both have to be there.
    expect(failure?.message).toContain(`node_modules → ${LINKED}\n`)
    expect(failure?.message).toContain(`pnpm now wants → ${WANTED}\n`)
  })

  it('reads both stores off the pnpm 11 error event, with nothing else to go on', () => {
    const failure = classifyPnpmFailure(error11(LINKED, WANTED), 1)

    expect(failure?.message).toMatch(/写 storeDir 修不好/)
    expect(failure?.message).toContain(`node_modules → ${LINKED}\n`)
    expect(failure?.message).toContain(`pnpm now wants → ${WANTED}\n`)
  })

  // Same major, so the storeDir advice is the one that works. The rendered text
  // carries the sentence anyway: pnpm 11.8.0 prints it with only the store moved.
  const MOVED = '/mnt/old/.pnpm-store/v11'
  const recordingMoved = JSON.stringify({ ...RECORD, packageManager: 'pnpm@11.8.0', storeDir: MOVED })

  it.each([
    ['rendered text with the sentence', OUTPUT.replace(LINKED, MOVED)],
    ['pnpm 11 ndjson', ndjson11(MOVED, WANTED)],
    ['pnpm 12 ndjson', ndjson12(WANTED)],
    ['pnpm 12 wrapped text', wrapped12],
  ])('keeps the storeDir advice when both stores end in the same segment: %s', (_shape, output) => {
    const failure = classifyPnpmFailure(output, 1, { profileDirectory: profileWithRecord(recordingMoved) })

    expect(failure?.code).toBe('unexpected-store')
    expect(failure?.message).toContain('storeDir: <上面第一个路径>')
    expect(failure?.message).not.toMatch(/写 storeDir 修不好/)
    expect(failure?.message).toContain(`node_modules → ${MOVED}\n`)
  })

  it('falls back on the sentence when a store cannot be read', () => {
    const output = 'ERR_PNPM_UNEXPECTED_STORE reworded upstream\n(This error may happen if the node_modules was installed with a different major version of pnpm)'
    const failure = classifyPnpmFailure(output, 1, { profileDirectory: profileRecording('10.34.9') })

    expect(failure?.message).toContain('pnpm 10.34.9')
    expect(failure?.message).toMatch(/写 storeDir 修不好/)
  })

  it('does not trip over a stream cut off mid-line', () => {
    const output = [pnpmContext(WANTED).slice(0, 40), ERROR_12].join('\n')
    const failure = classifyPnpmFailure(output, 1, { profileDirectory: profileRecording('10.34.9') })

    expect(failure?.code).toBe('unexpected-store')
    expect(failure?.message).toContain('storeDir: <上面第一个路径>')
  })
})

describe('ERR_PNPM_UNEXPECTED_STORE (#244)', () => {
  const OUTPUT = ` ERR_PNPM_UNEXPECTED_STORE  Unexpected store location
The dependencies at "C:\\Users\\lenovo\\.dsh\\profiles\\web\\node_modules" are currently linked from the store at "C:\\Users\\lenovo\\.pnpm-store\\v11".
pnpm now wants to use the store at "C:\\Users\\lenovo\\AppData\\Local\\pnpm\\store\\v11" to link dependencies.`

  it('names BOTH store paths and the durable way to choose between them', () => {
    const failure = classifyPnpmFailure(OUTPUT)
    expect(failure?.code).toBe('unexpected-store')
    // The linked store comes first: it is the one to write into storeDir.
    expect(failure?.message).toContain('C:\\Users\\lenovo\\.pnpm-store\\v11')
    expect(failure?.message).toContain('C:\\Users\\lenovo\\AppData\\Local\\pnpm\\store\\v11')
    // The advice is the pin, not the flag (#715). `pnpm install
    // --store-dir <path>` applies to that one command and leaves the record
    // in .modules.yaml alone, so the next command fails identically —
    // measured on pnpm 11.7.0 and by the reporter on 11.22.0. This test used
    // to require `--store-dir` as the FIX, which is what sent users in a
    // circle; the string still appears, now saying that it is not one.
    expect(failure?.message).toContain('pnpm-workspace.yaml')
    expect(failure?.message).toContain('storeDir')
    expect(failure?.message).toContain('不是修复')
  })

  it('is NOT marked recoverable — a store choice is not the market\'s to make', () => {
    // `recoverable` drives an automatic `pnpm install` retry. Either choice
    // has a consequence the user owns: pinning the RECORDED store keeps a
    // possibly-dead path in use, and adopting the one pnpm now resolves
    // purges and re-downloads the entire node_modules (pnpm asks for
    // confirmation, and aborts without a TTY: ERR_PNPM_ABORTED_REMOVE_
    // MODULES_DIR_NO_TTY, measured). This comment used to justify the same
    // flag on "the store can only be set by CLI flag" — falsified by #715:
    // a top-level `storeDir:` in the profile's pnpm-workspace.yaml is
    // honoured on pnpm 11.
    expect(classifyPnpmFailure(OUTPUT)?.recoverable).toBe(false)
  })

  it('still classifies when the paths cannot be parsed, rather than falling through', () => {
    const failure = classifyPnpmFailure('ERR_PNPM_UNEXPECTED_STORE something reworded upstream')
    expect(failure?.code).toBe('unexpected-store')
    expect(failure?.message).toContain('storeDir')
  })

  const STAGING_OUTPUT = ` ERR_PNPM_UNEXPECTED_STORE  Unexpected store location
The dependencies at "/Users/panda/Library/Application Support/dsh-desktop/harness/profiles/.generations/staging/1b4f/node_modules" are currently linked from the store at "/Users/panda/Library/pnpm/store/v11".
pnpm now wants to use the store at "/Users/panda/Library/pnpm/store/v10" to link dependencies.`

  it('names the staging directory and both stores when the mismatch is inside .generations/staging', () => {
    // DSH Desktop installs in a disposable staging workspace; when an
    // ancestor pnpm-workspace.yaml claims it, the profile-relink advice is
    // wrong — the profile's node_modules is not the one that mismatched.
    const failure = classifyPnpmFailure(STAGING_OUTPUT)
    expect(failure?.code).toBe('unexpected-store')
    expect(failure?.message).toContain('.generations/staging/1b4f')
    expect(failure?.message).toContain('/Users/panda/Library/pnpm/store/v11')
    expect(failure?.message).toContain('/Users/panda/Library/pnpm/store/v10')
    expect(failure?.message).toContain('这不是 profile 的 node_modules')
    expect(failure?.message).toContain('暂存目录')
    expect(failure?.message).toContain("This is not the profile's node_modules")
    expect(failure?.message).toContain('relink that outer workspace')
    expect(failure?.message).toContain('remove that ancestor pnpm-workspace.yaml')
    expect(failure?.message).not.toContain('--store-dir')
    expect(failure?.message).not.toContain('allowBuilds')
    expect(failure?.message).not.toContain('update DSH Desktop')
  })

  it('keeps the profile-relink advice for a .generations/live path', () => {
    // live/ is not the disposable staging workspace; do not mis-describe it.
    const live = STAGING_OUTPUT.replace('.generations/staging/1b4f', '.generations/live/1b4f')
    const failure = classifyPnpmFailure(live)
    expect(failure?.code).toBe('unexpected-store')
    expect(failure?.message).toContain('storeDir')
    expect(failure?.message).not.toContain('Staging directory')
    expect(failure?.message).not.toContain('暂存目录')
  })
})

describe('a pnpm that exists on PATH but cannot be started (#502)', () => {
  // Reported on Windows: the pnpm first on PATH was a `.cmd` wrapper built
  // out of environment variables that only exist in its installer's own
  // process. Expanded in the market's child process it collapsed to an empty
  // command; cmd.exe answered 9009 and wrote its message in the OEM code
  // page, which arrives here as replacement characters. Three updates in a
  // row failed showing the user nothing else.
  const MOJIBAKE = "'\"\"' ��������������\ndsh: pnpm failed in profile directory"

  it('is recognized by the exit status, whatever locale cmd answered in', () => {
    const failure = classifyPnpmFailure(MOJIBAKE, 9009)
    expect(failure?.code).toBe('pnpm-unusable')
    expect(failure?.recoverable).toBe(false)
  })

  it('replaces the unreadable output instead of appending to it', () => {
    // The captured bytes are undecodable by construction, so printing them
    // above the explanation only buries the explanation.
    expect(classifyPnpmFailure(MOJIBAKE, 9009)?.replaceOutput).toBe(true)
  })

  it('tells the two causes apart for the user with one command they can run', () => {
    const message = classifyPnpmFailure(MOJIBAKE, 9009)?.message ?? ''
    expect(message).toContain('pnpm --version')
    expect(message).toContain('9009')
  })

  it('also matches on cmd\'s own wording when no exit status is available', () => {
    expect(classifyPnpmFailure("'pnpm' is not recognized as an internal or external command,\noperable program or batch file.")?.code).toBe('pnpm-unusable')
    expect(classifyPnpmFailure("'pnpm' 不是内部或外部命令。")?.code).toBe('pnpm-unusable')
  })

  it('also covers a spawn the system refused, with the repair that fits it (#509)', () => {
    // @awslmowms on Ubuntu: pnpm is on PATH and the spawn itself is denied.
    // dsh's wrapper rethrows Node's error verbatim, so what the user saw was
    // an argv dump and a Node version banner.
    const EACCES = String.raw`Error: spawnSync pnpm EACCES
    at Object.spawnSync (node:internal/child_process:1123:20) {
  errno: -13,
  code: 'EACCES',
  syscall: 'spawnSync pnpm',
  path: 'pnpm',
  spawnargs: [ 'add', '-w', 'dshmarket@1.41.0' ]
}`
    const failure = classifyPnpmFailure(EACCES, 1)
    expect(failure?.code).toBe('pnpm-unusable')
    expect(failure?.replaceOutput).toBe(true)
    // The repair is specific to being refused execution — not the Windows
    // wrapper story, which would send this reporter looking for the wrong
    // thing entirely.
    expect(failure?.message).toContain('chmod +x')
    expect(failure?.message).toContain('noexec')
    expect(failure?.message).not.toContain('9009')

    // A vanished target is a third repair again.
    const gone = classifyPnpmFailure(String.raw`Error: spawnSync pnpm ENOENT { code: 'ENOENT', syscall: 'spawnSync pnpm' }`, 1)
    expect(gone?.code).toBe('pnpm-unusable')
    expect(gone?.message).toContain('ENOENT')
    expect(gone?.message).not.toContain('chmod +x')
  })

  it('never outranks a failure pnpm itself reported', () => {
    // pnpm's own errors never exit 9009. If one somehow arrives with that
    // status, what pnpm said is the more specific answer and must win.
    expect(classifyPnpmFailure('ERR_PNPM_ADDING_TO_ROOT  Running this command will add the dependency to the workspace root', 9009)?.code)
      .toBe('adding-to-root')
  })

  it('leaves an ordinary failure alone', () => {
    expect(classifyPnpmFailure('some other failure', 1)).toBeNull()
  })
})

describe('a local file: dependency whose file is gone (#436)', () => {
  // Measured against real pnpm 10.28.2 and 11.21.0, both exit 254. Only the
  // bracketing of the code differs; both carry the path and the direct-
  // dependency line.
  const PNPM_10 = " ENOENT  ENOENT: no such file or directory, open '/home/u/dl/dsh-sandbox-escalation-fix-0.1.2-alpha1.tgz'\n\nThis error happened while installing a direct dependency of /home/u/.dsh/profiles/web\n"
  const PNPM_11 = "[ENOENT] ENOENT: no such file or directory, open '/home/u/dl/dsh-sandbox-escalation-fix-0.1.2-alpha1.tgz'\n\nThis error happened while installing a direct dependency of /home/u/.dsh/profiles/web\n"

  it('is recognized on both pnpm majors, and names the path', () => {
    for (const output of [PNPM_10, PNPM_11]) {
      const failure = classifyPnpmFailure(output, 254)
      expect(failure?.code).toBe('missing-local-dependency')
      expect(failure?.recoverable).toBe(false)
      expect(failure?.message).toContain('dsh-sandbox-escalation-fix-0.1.2-alpha1.tgz')
    }
  })

  it('says the entry blocks operations on OTHER plugins, which is how it is met', () => {
    // The reporter hit it while uninstalling the market, not while touching
    // the dead entry — "this plugin is broken" would have been useless.
    const message = classifyPnpmFailure(PNPM_11, 254)?.message ?? ''
    expect(message).toContain('包括卸载别的插件')
    expect(message).toContain('blocks every install and uninstall')
  })

  it('does not claim an ENOENT that is not about a profile dependency', () => {
    // A build script opening a missing file is a different failure and must
    // keep pnpm's own words.
    expect(classifyPnpmFailure("ENOENT: no such file or directory, open '/tmp/whatever'", 1)).toBeNull()
  })
})

describe('ssh authentication failed with the prompt closed (#596)', () => {
  it('points at ssh-agent and at GIT_SSH_COMMAND, not at the key', () => {
    // git's own words ("Permission denied (publickey)") read as "your key is
    // wrong", and the key is usually fine — it wants a passphrase, and the
    // channel that would have asked is exactly what the market shut.
    const failure = classifyPnpmFailure('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 128)
    expect(failure?.code).toBe('ssh-auth-failed')
    expect(failure?.message).toContain('ssh-agent')
    expect(failure?.message).toContain('GIT_SSH_COMMAND')
  })
})

describe('pnpm 12 native engine out of memory (#701)', () => {
  // The reported text, from a Windows dshmarket log: a Rust abort in
  // pnpm-native, then dsh's own wrapper line. Exit 3221226505 is 0xC0000409,
  // how a Rust abort ends on Windows.
  const REPORTED = 'memory allocation of 5368709120 bytes failed\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\ndsh: pnpm failed in profile directory C:\\Users\\x\\.dsh\\profiles\\web'

  it('names it, instead of showing the raw abort', () => {
    const failure = classifyPnpmFailure(REPORTED, 3221226505)
    expect(failure?.code).toBe('native-oom')
    // The two things a user needs: it is not the plugin, and what to do.
    expect(failure?.message).toMatch(/和要安装的插件无关/)
    expect(failure?.message).toContain('pnpm@11')
  })

  it('recognises the Windows abort code even when the text was lost', () => {
    expect(classifyPnpmFailure('dsh: pnpm failed in profile directory x', 3221226505)?.code).toBe('native-oom')
  })

  it('does not claim an ordinary failure', () => {
    expect(classifyPnpmFailure('dsh: pnpm failed in profile directory x', 1)?.code).not.toBe('native-oom')
  })
})

describe('a pnpm run the host stopped for silence (#817)', () => {
  // The reporter's tail, verbatim: cloudflared's postinstall downloading its
  // binary from GitHub Releases on a network that cannot reach it.
  const TAIL = [
    'Resolved 241, reused 4, downloaded 0, added 0, done',
    'node_modules/cloudflared postinstall$ node scripts/postinstall.mjs && node lib/cloudflared.js bin install',
    'node_modules/cloudflared postinstall: Installing latest version of cloudflared',
    'dsh: pnpm printed nothing for 600000ms and was terminated',
  ].join('\n')

  it('names the dependency whose install script went quiet, and says what to do', () => {
    const failed = classifyPnpmFailure(TAIL, 1)
    expect(failed?.code).toBe('pnpm-stalled')
    expect(failed?.recoverable).toBe(false)
    expect(failed?.pkg).toBeUndefined()
    expect(failed?.message).toContain('依赖 cloudflared 的安装脚本 10 分钟')
    expect(failed?.message).toContain('the dependency cloudflared printed nothing for 10 minutes')
  })

  it('keeps a scoped name whole, Windows separators included', () => {
    const failed = classifyPnpmFailure('node_modules\\@scope\\bin-fetcher postinstall: fetching\ndsh: pnpm printed nothing for 120000ms and was terminated', 1)
    expect(failed?.message).toContain('依赖 @scope/bin-fetcher 的安装脚本 2 分钟')
  })

  it('blames the network, not a package, when no install script was running', () => {
    const failed = classifyPnpmFailure('Progress: resolved 12\ndsh: pnpm printed nothing for 600000ms and was terminated', 1)
    expect(failed?.code).toBe('pnpm-stalled')
    expect(failed?.message).toContain('pnpm 10 分钟没有任何输出')
    expect(failed?.message).not.toContain('依赖')
  })
})
