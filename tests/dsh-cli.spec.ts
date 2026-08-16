import { describe, expect, it } from 'vitest'
import { cmdCommandLine, quoteCmdArg } from '../src/dsh-cli.ts'

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
