import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { clearOwnedProfileLock, cmdCommandLine, gitEnvForPnpm, probeCoreSshCommand, isCmdSafeProfileName, nodeExecutable, pnpmConfigEnvForArgs, proxyEnvForPnpm, quoteCmdArg, TARGET_RE, toolSearchDirs } from '../src/dsh-cli.ts'
import { AUTO_INSTALL_PEERS_OFF, FETCH_TIMEOUT_OVERRIDE, RELEASE_AGE_OVERRIDE } from '../src/install.ts'
import { routesFor, setActiveRegion } from '../src/regions.ts'

describe('cmd.exe command line building (DEP0190 shim)', () => {
  it('keeps simple tokens unquoted', () => {
    expect(quoteCmdArg('pnpm')).toBe('pnpm')
    expect(quoteCmdArg('--version')).toBe('--version')
    expect(cmdCommandLine(['pnpm', '--version'])).toBe('pnpm --version')
  })

  it('quotes tokens containing whitespace or cmd metacharacters', () => {
    expect(quoteCmdArg('C:\\Program Files\\nodejs\\node.exe')).toBe('"C:\\Program Files\\nodejs\\node.exe"')
    expect(quoteCmdArg('a&b')).toBe('"a&b"')
    expect(quoteCmdArg('x|y')).toBe('"x|y"')
    expect(quoteCmdArg('x^y')).toBe('"x^y"')
  })

  it('doubles embedded double quotes', () => {
    expect(quoteCmdArg('say "hi"')).toBe('"say ""hi"""')
  })

  it('joins argv in order for the dsh plugin forwarder', () => {
    expect(cmdCommandLine(['dsh', 'plugin', '--profile', 'web', 'add', '@scope/pkg'])).toBe(
      'dsh plugin --profile web add @scope/pkg',
    )
  })

  it('admits common DSH profile names without admitting cmd expansion syntax', () => {
    for (const profile of ['web', '011-rc.2', '测试001', '工作 profile', 'Профиль-2']) {
      expect(isCmdSafeProfileName(profile)).toBe(true)
    }
    for (const profile of [
      '%USERPROFILE%', 'name!VAR!', 'a&b', 'a|b', 'a^b', 'a<b', 'a>b', 'a(b)', 'say"hi"', 'line\nbreak',
    ]) {
      expect(isCmdSafeProfileName(profile)).toBe(false)
    }
  })
})

describe('nodeExecutable (Android linker64 execPath)', () => {
  // On Android the kernel runs node through the dynamic linker, so
  // `process.execPath` is `/apex/.../linker64` while `process.argv0` holds
  // the real node binary. Spawning the linker with `--expose-internals`
  // makes it treat the flag as the program path and die with
  // `error: expected absolute path: "--expose-internals"` — every market
  // install failed until the real binary was picked for children.
  it('prefers an existing absolute argv0 even when execPath is the linker', () => {
    const realNode = process.execPath
    expect(nodeExecutable(realNode, '/apex/com.android.runtime/bin/linker64')).toBe(realNode)
  })

  it('returns an existing absolute argv0 verbatim', () => {
    expect(nodeExecutable(process.execPath, '/fallback/never/used')).toBe(process.execPath)
  })

  it('falls back to execPath when argv0 is empty', () => {
    const execPath = '/usr/local/bin/node'
    expect(nodeExecutable('', execPath)).toBe(execPath)
  })

  it('falls back to execPath when argv0 is not absolute', () => {
    const execPath = '/usr/local/bin/node'
    expect(nodeExecutable('node', execPath)).toBe(execPath)
  })

  it('falls back to execPath when argv0 does not exist on disk', () => {
    const execPath = '/usr/local/bin/node'
    expect(nodeExecutable('/nonexistent/absolute/node', execPath)).toBe(execPath)
  })

  it('documents the pre-fix failure shape: linker execPath survives only when no real node is known', () => {
    expect(nodeExecutable('', '/apex/com.android.runtime/bin/linker64')).toBe('/apex/com.android.runtime/bin/linker64')
  })
})

describe('proxy env translated for the pnpm subprocess (#148/#161/#188/#232/#274)', () => {
  // Three consumers, three vocabularies. The market's own fetch reads the
  // standard vars; pnpm reads ONLY npm config; `git` — which pnpm shells
  // out to for every git-hosted plugin — reads only the standard vars.
  it('fills the npm_config_* names pnpm reads AND the standard names git reads', () => {
    expect(proxyEnvForPnpm({ HTTPS_PROXY: 'http://proxy:8080' })).toEqual({
      npm_config_https_proxy: 'http://proxy:8080',
      npm_config_proxy: 'http://proxy:8080',
    })
    // A proxy known ONLY to npm config is the case that stranded git:
    // registry installs went through it, git installs went direct (#274).
    expect(proxyEnvForPnpm({ npm_config_proxy: 'http://p:1' })).toEqual({
      HTTPS_PROXY: 'http://p:1',
      HTTP_PROXY: 'http://p:1',
    })
  })

  it('mirrors undici precedence: lowercase over uppercase, https falling back to http', () => {
    expect(proxyEnvForPnpm({
      https_proxy: 'http://lower-https:1',
      HTTPS_PROXY: 'http://upper-https:2',
      http_proxy: 'http://lower-http:3',
    })).toEqual({
      npm_config_https_proxy: 'http://lower-https:1',
      npm_config_proxy: 'http://lower-http:3',
    })
    // http-only env still covers https requests, exactly as undici does.
    expect(proxyEnvForPnpm({ HTTP_PROXY: 'http://only-http:1' })).toEqual({
      npm_config_https_proxy: 'http://only-http:1',
      npm_config_proxy: 'http://only-http:1',
    })
  })

  it('forwards NO_PROXY both ways, so an excluded mirror stays excluded for git too', () => {
    expect(proxyEnvForPnpm({ HTTPS_PROXY: 'http://p:1', NO_PROXY: 'registry.local,10.0.0.0/8' }))
      .toEqual({
        npm_config_https_proxy: 'http://p:1',
        npm_config_proxy: 'http://p:1',
        npm_config_noproxy: 'registry.local,10.0.0.0/8',
      })
    expect(proxyEnvForPnpm({ npm_config_proxy: 'http://p:1', npm_config_noproxy: 'registry.local' }))
      .toEqual({ HTTPS_PROXY: 'http://p:1', HTTP_PROXY: 'http://p:1', NO_PROXY: 'registry.local' })
  })

  it('never overrides a value the caller already set, case-insensitively (Windows env keys)', () => {
    // The more specific statement of intent wins — including when Windows
    // hands the key back in a different case than we would have written.
    expect(proxyEnvForPnpm({ HTTPS_PROXY: 'http://env:1', npm_config_https_proxy: 'http://explicit:2' }))
      .toEqual({ npm_config_proxy: 'http://env:1' })
    expect(proxyEnvForPnpm({ HTTPS_PROXY: 'http://env:1', NPM_CONFIG_HTTPS_PROXY: 'http://explicit:2' }))
      .toEqual({ npm_config_proxy: 'http://env:1' })
    // ...and the reverse direction never fires at all when the standard
    // vocabulary says anything: copying npm's answer over it would invent a
    // setting the caller did not make (an HTTP_PROXY for someone who
    // deliberately proxied https only).
    expect(proxyEnvForPnpm({ npm_config_proxy: 'http://npm:1', HTTPS_PROXY: 'http://std:2' }))
      .toEqual({ npm_config_https_proxy: 'http://std:2' })
  })

  it('adds nothing when no proxy is configured, or when the value is blank', () => {
    expect(proxyEnvForPnpm({})).toEqual({})
    // `HTTPS_PROXY=` is how a proxy gets turned off; it must not be
    // forwarded as an empty proxy, which pnpm would try to dial.
    expect(proxyEnvForPnpm({ HTTPS_PROXY: '', http_proxy: '   ' })).toEqual({})
  })
})

describe('the proxy translation actually reaches spawned pnpm (#148)', () => {
  it('points pnpm at the region mirror, and only when the region has one', () => {
    const mirror = routesFor('china', {}).npmRegistry
    // Both spellings: pnpm reads the `PNPM_CONFIG_*` one and ignores npm's
    // (#865), so a region mirror written only the npm way moved the market's
    // own requests and left every install on the registry `.npmrc` named.
    expect(proxyEnvForPnpm({}, 'china'))
      .toEqual({ npm_config_registry: `${mirror}/`, PNPM_CONFIG_REGISTRY: `${mirror}/` })
    // The global region names the default registry, so there is nothing to
    // say — an explicit registry equal to the default is noise in the env.
    expect(proxyEnvForPnpm({}, 'global')).toEqual({})
  })

  it('never overrules a registry the caller already named', () => {
    // Same rule the proxy translation follows: fill silence, do not overwrite
    // speech. Someone pointing pnpm at a company registry has said where
    // packages come from, and a region setting is not an argument with that.
    expect(proxyEnvForPnpm({ npm_config_registry: 'https://npm.corp/' }, 'china')).toEqual({})
    // Windows env keys are case-insensitive, so the check has to be too.
    expect(proxyEnvForPnpm({ NPM_CONFIG_REGISTRY: 'https://npm.corp/' }, 'china')).toEqual({})
    // The same statement in pnpm's own vocabulary counts just as much — and
    // it is the spelling pnpm actually reads, so it must be the one that wins.
    expect(proxyEnvForPnpm({ PNPM_CONFIG_REGISTRY: 'https://npm.corp/' }, 'china')).toEqual({})
    expect(proxyEnvForPnpm({ pnpm_config_registry: 'https://npm.corp/' }, 'china')).toEqual({})
    // A blank value is not a statement about anything.
    expect(proxyEnvForPnpm({ npm_config_registry: '  ' }, 'china'))
      .toEqual({
        npm_config_registry: `${routesFor('china', {}).npmRegistry}/`,
        PNPM_CONFIG_REGISTRY: `${routesFor('china', {}).npmRegistry}/`,
      })
  })

  it('carries the mirror alongside a proxy rather than instead of one', () => {
    // A user can need both: a proxy to leave their network at all, and a
    // mirror because the origin is far away once they have.
    expect(proxyEnvForPnpm({ HTTPS_PROXY: 'http://p:1' }, 'china')).toEqual({
      npm_config_https_proxy: 'http://p:1',
      npm_config_proxy: 'http://p:1',
      npm_config_registry: `${routesFor('china', {}).npmRegistry}/`,
      PNPM_CONFIG_REGISTRY: `${routesFor('china', {}).npmRegistry}/`,
    })
  })

  // proxyEnvForPnpm being correct is worth nothing if spawnEnv never calls
  // it — that wiring IS the bug being fixed, so it gets its own assertion
  // against a real spawn call rather than the pure function alone.
  it('puts the region mirror in the environment pnpm is spawned with, in pnpm\'s spelling (#865)', async () => {
    // Same reason as the proxy case below: the helper being right proves
    // nothing about the wiring, and the wiring — a value only npm's
    // vocabulary carries — was the bug.
    vi.resetModules()
    const seen: Array<NodeJS.ProcessEnv | undefined> = []
    vi.doMock('node:child_process', () => ({
      spawn: (_file: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        seen.push(options.env)
        const child = new EventEmitter() as EventEmitter & { pid?: number }
        child.pid = 1
        setImmediate(() => child.emit('close', 1))
        return child
      },
    }))
    const mirror = routesFor('china', {}).npmRegistry
    // The guard is "never overrule a registry the caller named", so a
    // machine whose own env carries one (this one does) would otherwise
    // see the mirror correctly withheld and the test fail for a reason
    // that has nothing to do with the wiring.
    const previous = process.env.npm_config_registry
    delete process.env.npm_config_registry
    try {
      // Set on the module instance dsh-cli is about to load: the static
      // import above belongs to the graph resetModules just discarded.
      const regions = await import('../src/regions.ts')
      regions.setActiveRegion('china')
      const { probePnpm } = await import('../src/dsh-cli.ts')
      await probePnpm()
      expect(seen.length).toBeGreaterThan(0)
      expect(seen[0]?.PNPM_CONFIG_REGISTRY).toBe(`${mirror}/`)
    } finally {
      if (previous === undefined) delete process.env.npm_config_registry
      else process.env.npm_config_registry = previous
      setActiveRegion('global')
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })

  it('puts npm_config_https_proxy in the environment pnpm is spawned with', async () => {
    vi.resetModules()
    const seen: Array<NodeJS.ProcessEnv | undefined> = []
    vi.doMock('node:child_process', () => ({
      spawn: (_file: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        seen.push(options.env)
        const child = new EventEmitter() as EventEmitter & { pid?: number }
        child.pid = 1
        // Non-zero: probePnpm caches only success, so this leaves no state.
        setImmediate(() => child.emit('close', 1))
        return child
      },
    }))
    // Every proxy variable the resolver reads is pinned, not just the one
    // this case sets. A machine that exports HTTP_PROXY (which is common,
    // and was true of the contributor who found this) otherwise leaves
    // `npm_config_proxy` derived from the REAL value and the assertion below
    // fails for a reason that has nothing to do with the code under test —
    // a test that only passes on machines shaped like the author's.
    const previous: Record<string, string | undefined> = {}
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) {
      previous[key] = process.env[key]
      delete process.env[key]
    }
    process.env.HTTPS_PROXY = 'http://proxy.corp:3128'
    try {
      const { probePnpm } = await import('../src/dsh-cli.ts')
      await probePnpm()
      expect(seen.length).toBeGreaterThan(0)
      expect(seen[0]?.npm_config_https_proxy).toBe('http://proxy.corp:3128')
      expect(seen[0]?.npm_config_proxy).toBe('http://proxy.corp:3128')
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })
})

describe('configured build environment reaches spawned children (#336)', () => {
  // The feature's whole point is a host whose process cannot inherit a shell
  // environment: the operator pins CC/CXX in the market config and every
  // build/install spawn must carry them — above the inherited env, below the
  // market's own PATH and CI. These two assertions ride a real spawn call,
  // the same way the proxy wiring is proven (see the test above): a pure
  // function test would only prove the helper agrees with the helper.
  it('lays the configured env over the inherited one', async () => {
    vi.resetModules()
    const seen: Array<NodeJS.ProcessEnv | undefined> = []
    vi.doMock('node:child_process', () => ({
      spawn: (_file: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        seen.push(options.env)
        const child = new EventEmitter() as EventEmitter & { pid?: number }
        child.pid = 1
        // Non-zero: probePnpm caches only success, so this leaves no state.
        setImmediate(() => child.emit('close', 1))
        return child
      },
    }))
    const previous = process.env.CC
    process.env.CC = '/usr/bin/gcc-10'
    try {
      const { probePnpm, setBuildEnvSource } = await import('../src/dsh-cli.ts')
      setBuildEnvSource(() => ({ CC: '/usr/bin/gcc-11', CXX: '/usr/bin/g++-11' }))
      await probePnpm()
      expect(seen.length).toBeGreaterThan(0)
      // The pinned value REPLACES the one the parent process inherited —
      // overriding is the feature (an unshelled host cannot export first).
      expect(seen[0]?.CC).toBe('/usr/bin/gcc-11')
      expect(seen[0]?.CXX).toBe('/usr/bin/g++-11')
    } finally {
      if (previous === undefined) delete process.env.CC
      else process.env.CC = previous
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })

  it('never lets a config value override the market-owned CI and PATH', async () => {
    vi.resetModules()
    const seen: Array<NodeJS.ProcessEnv | undefined> = []
    vi.doMock('node:child_process', () => ({
      spawn: (_file: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        seen.push(options.env)
        const child = new EventEmitter() as EventEmitter & { pid?: number }
        child.pid = 1
        setImmediate(() => child.emit('close', 1))
        return child
      },
    }))
    try {
      const { nodeBinDir, probePnpm, setBuildEnvSource } = await import('../src/dsh-cli.ts')
      setBuildEnvSource(() => ({ CI: 'false', PATH: '/usr/bin/evil', CC: '/usr/bin/gcc-11' }))
      await probePnpm()
      expect(seen.length).toBeGreaterThan(0)
      // CI answers pnpm's interactive prompt and PATH answers "where is
      // pnpm"; either one breaking is a failure that looks nothing like its
      // cause, so both are computed LAST and a config value may not touch
      // them (#336).
      expect(seen[0]?.CI).toBe('true')
      expect(seen[0]?.PATH).not.toBe('/usr/bin/evil')
      expect(seen[0]?.PATH).toContain(nodeBinDir)
    } finally {
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })

  it('adds nothing when no build environment is configured, and forgets a configured one on restore', async () => {
    vi.resetModules()
    const seen: Array<NodeJS.ProcessEnv | undefined> = []
    vi.doMock('node:child_process', () => ({
      spawn: (_file: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        seen.push(options.env)
        const child = new EventEmitter() as EventEmitter & { pid?: number }
        child.pid = 1
        setImmediate(() => child.emit('close', 1))
        return child
      },
    }))
    try {
      const { probePnpm, setBuildEnvSource } = await import('../src/dsh-cli.ts')
      setBuildEnvSource(() => ({ CC: '/usr/bin/gcc-11' }))
      await probePnpm()
      expect(seen[0]?.CC).toBe('/usr/bin/gcc-11')
      // The routes restore the previous source on unmount; the default adds
      // nothing, so the env returns to plain process.env.
      setBuildEnvSource(() => ({}))
      await probePnpm()
      expect(seen[1]?.CC).toBeUndefined()
    } finally {
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })
})

describe('TARGET_RE plugin target allowlist', () => {
  it('accepts semver range prefixes that restore/install flows produce', () => {
    // Regression: carets/tildes from manifest specs (name@^x.y.z) were rejected
    // as "unsafe plugin target", breaking every gist restore on the caret.
    for (const target of [
      '@linxin666/dsh-tool-describe-image@^0.2.2',
      'dsh-better-sidebar@^0.14.0',
      'dsh-dream-skin@~0.3.0',
      'dsh-free-search@^0.4.7',
      'dshmarket@^1.14.1',
      'dsh-market@=1.2.3',
      'dshmarket@1.14.0',
      'github:Ychris12138/dsh-usage-stats',
    ]) {
      expect(TARGET_RE.test(target)).toBe(true)
    }
  })

  it('still rejects targets that could inject through a shell', () => {
    for (const target of [
      'dsh; rm -rf /',
      'dsh-better-sidebar@^0.14.0 --reporter=ndjson',
      'x|y',
      '$(pwd)',
      'dsh-better-sidebar &',
    ]) {
      expect(TARGET_RE.test(target)).toBe(false)
    }
  })
})

describe('toolSearchDirs (#292)', () => {
  // A GUI or desktop launch inherits none of the shell profile, so the
  // market appends the places a package manager is actually installed to.
  // Windows used to get only the Node directory, which made the market's own
  // advice unfollowable: it tells the user to install pnpm with the
  // standalone installer and then did not look where that installer puts it.

  it('looks where the Windows standalone installer and npm -g put pnpm', () => {
    const dirs = toolSearchDirs('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u')
    expect(dirs).toContain(join('C:\\Users\\u\\AppData\\Local', 'pnpm'))
    expect(dirs).toContain(join('C:\\Users\\u\\AppData\\Roaming', 'npm'))
  })

  it('puts PNPM_HOME first, because the installer sets it even when the layout is not the default', () => {
    const dirs = toolSearchDirs('win32', { PNPM_HOME: 'D:\\tools\\pnpm', LOCALAPPDATA: 'C:\\l' }, 'C:\\u')
    expect(dirs[0]).toBe('D:\\tools\\pnpm')
  })

  it('honours PNPM_HOME on unix too', () => {
    expect(toolSearchDirs('darwin', { PNPM_HOME: '/opt/pnpm' }, '/home/u')[0]).toBe('/opt/pnpm')
  })

  it('keeps the unix locations it already searched, and adds the installer ones', () => {
    const dirs = toolSearchDirs('darwin', {}, '/home/u')
    expect(dirs).toContain('/opt/homebrew/bin')
    expect(dirs).toContain('/usr/local/bin')
    expect(dirs).toContain(join('/home/u', '.local', 'bin'))
    expect(dirs).toContain(join('/home/u', '.local', 'share', 'pnpm'))
  })

  it('never emits an empty directory when the environment is bare', () => {
    // An empty entry in PATH means "the current directory" on Windows, which
    // is not a place to look for a package manager.
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(toolSearchDirs(platform, {}, '/home/u').filter(d => d.trim() === '')).toEqual([])
    }
  })
})

describe('git is spawned non-interactively (#587)', () => {
  // CI=true covers pnpm, which reads it; git does not. A
  // `github:owner/repo#path:/sub` spec reaches pnpm's git fetcher rather
  // than the codeload tarball path, and git's credential prompt opens the
  // controlling terminal — which a spawned child does not have, so the
  // question was asked where nobody could answer it and the clone sat
  // there until the 15-minute install timeout.
  // The third argument is the `core.sshCommand` probe; null here means "git
  // has none configured", the state of a machine that never set one.
  it('refuses the terminal prompt when the caller said nothing', () => {
    expect(gitEnvForPnpm({}, null)).toEqual({ GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' })
  })

  it('never overwrites a value the caller set', () => {
    // Someone who turned prompting on has made a statement; a default must
    // fill silence, not replace speech. Same rule proxyEnvForPnpm follows.
    expect(gitEnvForPnpm({ GIT_TERMINAL_PROMPT: '1' }, null).GIT_TERMINAL_PROMPT).toBeUndefined()
  })

  it('treats a blank value as unset', () => {
    // Not a setting git can parse either: `git_env_bool` rejects it. An
    // empty string is how a shell spells "I cleared this".
    expect(gitEnvForPnpm({ GIT_TERMINAL_PROMPT: '' }, null).GIT_TERMINAL_PROMPT).toBe('0')
    expect(gitEnvForPnpm({ GIT_TERMINAL_PROMPT: '   ' }, null).GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('closes the ssh prompt only when the user has expressed no ssh identity (#596)', () => {
    // `GIT_SSH_COMMAND` overrides `core.sshCommand` and `GIT_SSH` — measured,
    // with core.sshCommand set the environment wins and the configured
    // command never runs — so setting ours unconditionally would replace the
    // identity of every user who chose one, and `BatchMode=yes` would then
    // break the passphrase installs that work today. All three count as a
    // statement, and the blank rule is the same one.
    expect(gitEnvForPnpm({ GIT_SSH_COMMAND: 'ssh -i /k' }, null).GIT_SSH_COMMAND).toBeUndefined()
    expect(gitEnvForPnpm({ GIT_SSH: '/usr/bin/ssh2' }, null).GIT_SSH_COMMAND).toBeUndefined()
    expect(gitEnvForPnpm({}, 'ssh -i /from/gitconfig').GIT_SSH_COMMAND).toBeUndefined()
    // Blank is still silence, wherever it is written.
    expect(gitEnvForPnpm({ GIT_SSH_COMMAND: '  ' }, '').GIT_SSH_COMMAND).toBe('ssh -oBatchMode=yes')
  })

  it('reads core.sshCommand from git, and treats an unanswerable probe as no choice', () => {
    // Not "the machine has none": a controlled git configuration, so this
    // asserts the reading rather than the author's machine. The env argument
    // bypasses the process-wide memo for exactly this reason.
    const dir = mkdtempSync(join(tmpdir(), 'dshm-sshcmd-'))
    try {
      const config = join(dir, 'gitconfig')
      writeFileSync(config, '[core]\n\tsshCommand = ssh -i /from/gitconfig\n')
      expect(probeCoreSshCommand({ ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: '/dev/null' }))
        .toBe('ssh -i /from/gitconfig')
      writeFileSync(config, '[core]\n\tbare = false\n')
      expect(probeCoreSshCommand({ ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: '/dev/null' }))
        .toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Same reasoning as the proxy wiring assertion above: the pure function
  // being right is worth nothing if spawnEnv never calls it.
  it('puts both switches in the environment pnpm is spawned with', async () => {
    const seen = await spawnedEnv(env => {
      delete env.GIT_TERMINAL_PROMPT
      delete env.GIT_SSH_COMMAND
      delete env.GIT_SSH
    })
    expect(seen?.GIT_TERMINAL_PROMPT).toBe('0')
    // `ssh -oBatchMode=yes` reaches the child too — unless this machine's git
    // has a core.sshCommand, in which case the rule says to leave its owner
    // alone, and the assertion follows the rule rather than the machine.
    if (probeCoreSshCommand() === null) expect(seen?.GIT_SSH_COMMAND).toBe('ssh -oBatchMode=yes')
    else expect(seen?.GIT_SSH_COMMAND).toBeUndefined()
  })

  // The pure-function assertion above proves gitEnvForPnpm stays quiet; this
  // proves the quiet actually reaches the child. Worth its own case because
  // the two halves fail independently — a default that stopped being
  // conditional would override the user here even though spawnEnv is wired
  // correctly. (Spread ORDER is deliberately not asserted: gitEnvForPnpm
  // returns {} exactly when process.env carries a value, so the two can
  // never disagree and moving the spread is a no-op, not a defect.)
  it('lets the caller value survive all the way into the spawned env', async () => {
    const seen = await spawnedEnv(env => { env.GIT_TERMINAL_PROMPT = '1'; env.GIT_SSH_COMMAND = 'ssh -i /mine' })
    expect(seen?.GIT_TERMINAL_PROMPT).toBe('1')
    expect(seen?.GIT_SSH_COMMAND).toBe('ssh -i /mine')
  })
})

/**
 * Run one real spawn through spawnEnv with `mutate` applied to process.env,
 * and hand back the environment the child was given.
 */
async function spawnedEnv(
  mutate: (env: NodeJS.ProcessEnv) => void,
): Promise<NodeJS.ProcessEnv | undefined> {
  vi.resetModules()
  const seen: Array<NodeJS.ProcessEnv | undefined> = []
  vi.doMock('node:child_process', () => ({
    spawn: (_file: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      seen.push(options.env)
      const child = new EventEmitter() as EventEmitter & { pid?: number }
      child.pid = 1
      // Non-zero: probePnpm caches only success, so this leaves no state.
      setImmediate(() => child.emit('close', 1))
      return child
    },
  }))
  const previous = process.env.GIT_TERMINAL_PROMPT
  mutate(process.env)
  try {
    const { probePnpm } = await import('../src/dsh-cli.ts')
    await probePnpm()
    expect(seen.length).toBeGreaterThan(0)
    return seen[0]
  } finally {
    if (previous === undefined) delete process.env.GIT_TERMINAL_PROMPT
    else process.env.GIT_TERMINAL_PROMPT = previous
    vi.doUnmock('node:child_process')
    vi.resetModules()
  }
}

describe('pnpmConfigEnvForArgs (#615)', () => {
  it('repeats each --config override as the PNPM_CONFIG_* variable pnpm 12 still reads', () => {
    // The real constants, not copies: a respelling must keep matching or
    // this is the test that says so.
    expect(pnpmConfigEnvForArgs(['add', FETCH_TIMEOUT_OVERRIDE, 'dsh-loop'])).toEqual({ PNPM_CONFIG_FETCH_TIMEOUT: '600000' })
    expect(pnpmConfigEnvForArgs(['add', AUTO_INSTALL_PEERS_OFF, 'dsh-loop'])).toEqual({ PNPM_CONFIG_AUTO_INSTALL_PEERS: 'false' })
    expect(pnpmConfigEnvForArgs(['add', RELEASE_AGE_OVERRIDE, 'dsh-loop'])).toEqual({ PNPM_CONFIG_MINIMUM_RELEASE_AGE: '0' })
    // Either spelling of a key lands on the same variable.
    expect(pnpmConfigEnvForArgs(['add', '--config.fetchTimeout=12345'])).toEqual({ PNPM_CONFIG_FETCH_TIMEOUT: '12345' })
    expect(pnpmConfigEnvForArgs(['add', '--config.fetch-timeout=12345'])).toEqual({ PNPM_CONFIG_FETCH_TIMEOUT: '12345' })
    // Two overrides on one run: both travel.
    expect(pnpmConfigEnvForArgs(['add', FETCH_TIMEOUT_OVERRIDE, AUTO_INSTALL_PEERS_OFF, 'dsh-loop']))
      .toEqual({ PNPM_CONFIG_FETCH_TIMEOUT: '600000', PNPM_CONFIG_AUTO_INSTALL_PEERS: 'false' })
  })

  it('sets nothing for a run that carries no override', () => {
    expect(pnpmConfigEnvForArgs(['add', 'dsh-loop'])).toEqual({})
    expect(pnpmConfigEnvForArgs(['add', '--force', '--reporter=ndjson', 'dsh-loop@1.0.0'])).toEqual({})
    // Not the override shape: no key, or no value.
    expect(pnpmConfigEnvForArgs(['add', '--config.=x', '--config.fetchTimeout='])).toEqual({})
  })
})

describe('clearOwnedProfileLock (#914)', () => {
  // The profile directory comes from DSH_HOME, so the whole case runs in a
  // throwaway home and never looks at the real one.
  const home = mkdtempSync(join(tmpdir(), 'dshm-home-'))
  const lockPath = join(home, 'profiles', 'web', 'package.json.lock')

  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(join(home, 'profiles'), { recursive: true, force: true })
  })

  function writeLock(content: string): void {
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    process.env.DSH_HOME = home
    writeFileSync(lockPath, content)
  }

  it('removes the lock naming the child this run just killed', () => {
    writeLock('4242\n')
    expect(clearOwnedProfileLock('web', 4242)).toBe(true)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('leaves a lock held by another operation alone', () => {
    // A different PID may be a live operation; deleting its lock would race
    // it. The classifier names the file instead (#914).
    writeLock('9999\n')
    expect(clearOwnedProfileLock('web', 4242)).toBe(false)
    expect(existsSync(lockPath)).toBe(true)
  })

  it('does nothing when there is no lock, or its content is not a PID', () => {
    process.env.DSH_HOME = home
    expect(clearOwnedProfileLock('web', 4242)).toBe(false)
    writeLock('not-a-pid')
    expect(clearOwnedProfileLock('web', 4242)).toBe(false)
    expect(existsSync(lockPath)).toBe(true)
  })
})

describe('child output is decoded once its bytes are known (#1122)', () => {
  /**
   * The report: on a Chinese Windows machine an install failed and the reason
   * read `'dsh' �����ڲ����ⲿ���Ҳ���ǿ����еĳ���` — cmd.exe's GBK bytes decoded
   * as UTF-8. The decoding lives in proc-text.ts and is unit-tested there;
   * this is the wiring: the runner must hand it BYTES, not pre-decoded text.
   * A character split across two writes is the part a per-chunk
   * `chunk.toString()` cannot get right on any platform.
   */
  it('joins a character split across two writes', async () => {
    const script = "const b = Buffer.from('插件市场', 'utf8'); process.stdout.write(b.subarray(0, 2));"
      + 'setTimeout(() => { process.stdout.write(b.subarray(2)); }, 50)'
    const { runHostPnpm } = await import('../src/dsh-cli.ts')
    const result = await runHostPnpm(
      { command: process.execPath, args: ['-e', script], env: { ...process.env } },
      process.cwd(),
      [],
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('插件市场')
  })
})
