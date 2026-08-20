import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { cmdCommandLine, nodeExecutable, proxyEnvForPnpm, quoteCmdArg, TARGET_RE } from '../src/dsh-cli.ts'

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

describe('proxy env translated for pnpm (#148/#161/#188/#232)', () => {
  // The market's own catalog fetches go through undici's EnvHttpProxyAgent,
  // which reads HTTPS_PROXY/http_proxy. pnpm reads NONE of those — it reads
  // npm config — so on a proxied network the catalog loaded and every
  // install then hung. These assert the translation, and its precedence.
  it('translates https_proxy/http_proxy into the npm_config_* names pnpm reads', () => {
    expect(proxyEnvForPnpm({ HTTPS_PROXY: 'http://proxy:8080' })).toEqual({
      npm_config_https_proxy: 'http://proxy:8080',
      npm_config_proxy: 'http://proxy:8080',
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

  it('forwards NO_PROXY, so a host excluding its own registry mirror keeps excluding it', () => {
    expect(proxyEnvForPnpm({ HTTPS_PROXY: 'http://p:1', NO_PROXY: 'registry.local,10.0.0.0/8' }))
      .toEqual({
        npm_config_https_proxy: 'http://p:1',
        npm_config_proxy: 'http://p:1',
        npm_config_noproxy: 'registry.local,10.0.0.0/8',
      })
  })

  it('never overrides an npm_config_* the caller already set, case-insensitively (Windows env keys)', () => {
    // The more specific statement of intent wins — including when Windows
    // hands the key back in a different case than we would have written.
    expect(proxyEnvForPnpm({ HTTPS_PROXY: 'http://env:1', npm_config_https_proxy: 'http://explicit:2' }))
      .toEqual({ npm_config_proxy: 'http://env:1' })
    expect(proxyEnvForPnpm({ HTTPS_PROXY: 'http://env:1', NPM_CONFIG_HTTPS_PROXY: 'http://explicit:2' }))
      .toEqual({ npm_config_proxy: 'http://env:1' })
  })

  it('adds nothing when no proxy is configured, or when the value is blank', () => {
    expect(proxyEnvForPnpm({})).toEqual({})
    // `HTTPS_PROXY=` is how a proxy gets turned off; it must not be
    // forwarded as an empty proxy, which pnpm would try to dial.
    expect(proxyEnvForPnpm({ HTTPS_PROXY: '', http_proxy: '   ' })).toEqual({})
  })
})

describe('the proxy translation actually reaches spawned pnpm (#148)', () => {
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
