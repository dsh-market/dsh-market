import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { cmdCommandLine, isCmdSafeProfileName, nodeExecutable, proxyEnvForPnpm, quoteCmdArg, TARGET_RE, toolSearchDirs } from '../src/dsh-cli.ts'
import { routesFor } from '../src/regions.ts'

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
    expect(proxyEnvForPnpm({}, 'china')).toEqual({ npm_config_registry: `${mirror}/` })
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
    // A blank value is not a statement about anything.
    expect(proxyEnvForPnpm({ npm_config_registry: '  ' }, 'china'))
      .toEqual({ npm_config_registry: `${routesFor('china', {}).npmRegistry}/` })
  })

  it('carries the mirror alongside a proxy rather than instead of one', () => {
    // A user can need both: a proxy to leave their network at all, and a
    // mirror because the origin is far away once they have.
    expect(proxyEnvForPnpm({ HTTPS_PROXY: 'http://p:1' }, 'china')).toEqual({
      npm_config_https_proxy: 'http://p:1',
      npm_config_proxy: 'http://p:1',
      npm_config_registry: `${routesFor('china', {}).npmRegistry}/`,
    })
  })

  // proxyEnvForPnpm being correct is worth nothing if spawnEnv never calls
  // it — that wiring IS the bug being fixed, so it gets its own assertion
  // against a real spawn call rather than the pure function alone.
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
    const previous = process.env.HTTPS_PROXY
    process.env.HTTPS_PROXY = 'http://proxy.corp:3128'
    try {
      const { probePnpm } = await import('../src/dsh-cli.ts')
      await probePnpm()
      expect(seen.length).toBeGreaterThan(0)
      expect(seen[0]?.npm_config_https_proxy).toBe('http://proxy.corp:3128')
      expect(seen[0]?.npm_config_proxy).toBe('http://proxy.corp:3128')
    } finally {
      if (previous === undefined) delete process.env.HTTPS_PROXY
      else process.env.HTTPS_PROXY = previous
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
