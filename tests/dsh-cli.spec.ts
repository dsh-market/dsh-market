import { describe, expect, it } from 'vitest'
import { cmdCommandLine, nodeExecutable, quoteCmdArg } from '../src/dsh-cli.ts'

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
