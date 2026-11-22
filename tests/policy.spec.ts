/**
 * The organization policy file: where it is found, what a broken one does,
 * and the small helpers that read it. Real files in a temp directory; nothing
 * mocked.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  expandEnv, getPolicy, globMatch, loadPolicy, NO_POLICY, policyLocations, readPolicyFields, resetPolicyCache,
} from '../src/policy.ts'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dshm-policy-'))
  resetPolicyCache()
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  resetPolicyCache()
})

/** Env that points at nothing outside the temp dir (win32 = no /etc lookup). */
const envFor = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ProgramData: join(tmp, 'programdata'), ...extra })
const write = (path: string, doc: unknown): string => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof doc === 'string' ? doc : JSON.stringify(doc))
  return path
}

describe('policy file locations', () => {
  it('lists the explicit path, then the system one, then the one under DSH_HOME', () => {
    expect(policyLocations({ DSH_MARKET_POLICY: '/srv/p.json' }, 'linux', '/home/u/.dsh')).toEqual([
      '/srv/p.json', '/etc/dsh-market/policy.json', join('/home/u/.dsh', 'dsh-market', 'policy.json'),
    ])
    expect(policyLocations({ ProgramData: 'C:\\ProgramData' }, 'win32', 'C:\\Users\\u\\.dsh')[0])
      .toBe(join('C:\\ProgramData', 'dsh-market', 'policy.json'))
  })

  it('has no policy when no file exists', () => {
    expect(loadPolicy(envFor(), 'win32', join(tmp, 'home'))).toBe(NO_POLICY)
  })

  it('takes the first file that exists: explicit env over ProgramData over the home one', () => {
    const home = join(tmp, 'home')
    write(join(home, 'dsh-market', 'policy.json'), { allow: ['from-home'] })
    expect(loadPolicy(envFor(), 'win32', home).allow).toEqual(['from-home'])
    write(join(tmp, 'programdata', 'dsh-market', 'policy.json'), { allow: ['from-system'] })
    expect(loadPolicy(envFor(), 'win32', home).allow).toEqual(['from-system'])
    const explicit = write(join(tmp, 'explicit.json'), { allow: ['from-env'] })
    expect(loadPolicy(envFor({ DSH_MARKET_POLICY: explicit }), 'win32', home).allow).toEqual(['from-env'])
  })

  it('falls through a missing explicit path instead of failing', () => {
    const home = join(tmp, 'home')
    write(join(home, 'dsh-market', 'policy.json'), { publicCatalog: false })
    const policy = loadPolicy(envFor({ DSH_MARKET_POLICY: join(tmp, 'nope.json') }), 'win32', home)
    expect(policy.publicCatalog).toBe(false)
  })
})

describe('policy fields', () => {
  it('reads catalogs, labels, headers and the switches', () => {
    const policy = readPolicyFields({
      catalogs: [
        { id: 'acme', label: { zh: 'Acme 内部', en: 'Acme internal' }, url: 'https://plugins.acme.internal/plugins.json', headers: { Authorization: 'Bearer ${ACME}' } },
        { id: 'local', label: 'Local', file: '/opt/acme/plugins.json' },
      ],
      publicCatalog: false,
      userCatalogs: false,
      allow: ['@acme/*', 'dsh-notify-me'],
      mirrors: { npm: 'https://npm.acme.internal/', catalog: 'https://c.acme.internal/p.json' },
    }, '/p.json')
    expect(policy.catalogs).toHaveLength(2)
    expect(policy.catalogs[0]).toMatchObject({ id: 'acme', label: { zh: 'Acme 内部', en: 'Acme internal' }, headers: { Authorization: 'Bearer ${ACME}' } })
    expect(policy.catalogs[1]).toMatchObject({ id: 'local', label: { zh: 'Local', en: 'Local' }, file: '/opt/acme/plugins.json' })
    expect(policy).toMatchObject({ publicCatalog: false, userCatalogs: false, allow: ['@acme/*', 'dsh-notify-me'] })
    expect(policy.mirrors).toEqual({ npm: 'https://npm.acme.internal', catalog: 'https://c.acme.internal/p.json' })
    expect(policy.problems).toEqual([])
  })

  it('ignores a catalog it cannot use and says why, without dropping the others', () => {
    const policy = readPolicyFields({
      catalogs: [
        { id: 'Bad Id', url: 'https://a.example/p.json' },
        { id: 'public', url: 'https://a.example/p.json' },
        { id: 'both', url: 'https://a.example/p.json', file: '/x.json' },
        { id: 'relative', file: 'plugins.json' },
        { id: 'ok', url: 'https://a.example/p.json' },
        { id: 'ok', url: 'https://b.example/p.json' },
      ],
    }, '/p.json')
    expect(policy.catalogs.map(entry => entry.id)).toEqual(['ok'])
    expect(policy.catalogs[0]!.url).toBe('https://a.example/p.json')
    expect(policy.problems.length).toBe(5)
    expect(policy.problems[0]).toEqual({ zh: expect.stringContaining('id'), en: expect.stringContaining('id') })
  })

  it('treats a malformed allowlist as "nothing may be installed", never as "no allowlist"', () => {
    expect(readPolicyFields({ allow: 'dsh-loop' }, '/p.json').allow).toEqual([])
    expect(readPolicyFields({ allow: [1] }, '/p.json').allow).toEqual([])
    expect(readPolicyFields({ allow: [] }, '/p.json').allow).toEqual([])
    expect(readPolicyFields({}, '/p.json').allow).toBeNull()
  })

  it('ignores a switch that is not a boolean, and a mirror that is not a URL', () => {
    const policy = readPolicyFields({ publicCatalog: 'no', userCatalogs: 0, mirrors: { npm: 'not a url', githubProxy: 'ftp://x' } }, '/p.json')
    expect(policy.publicCatalog).toBe(true)
    expect(policy.userCatalogs).toBe(true)
    expect(policy.mirrors).toEqual({})
    expect(policy.problems).toHaveLength(4)
  })

  it('fails closed for installs when the file is not valid JSON, and reports it', () => {
    const file = write(join(tmp, 'broken.json'), '{ "allow": ["a" "b"] }')
    const policy = loadPolicy(envFor({ DSH_MARKET_POLICY: file }), 'win32', join(tmp, 'home'))
    expect(policy.allow).toEqual([])
    expect(policy.path).toBe(file)
    expect(policy.problems[0]!.en).toContain(file)
    expect(policy.problems[0]!.en).toMatch(/could not be read.*position \d+.*nothing can be installed.*Ask your administrator/)
    expect(policy.problems[0]!.zh).toContain(file)
    expect(policy.problems[0]!.zh).toMatch(/读不了.*不能安装任何插件.*联系管理员/)
  })

  it('fails closed when the document is not an object', () => {
    const policy = readPolicyFields(['catalogs'], '/p.json')
    expect(policy.allow).toEqual([])
    expect(policy.problems).toHaveLength(1)
  })
})

describe('getPolicy', () => {
  it('re-reads the file when it changes', () => {
    const file = write(join(tmp, 'p.json'), { allow: ['a'] })
    const env = envFor({ DSH_MARKET_POLICY: file, DSH_HOME: join(tmp, 'home') })
    expect(getPolicy(env, 0).allow).toEqual(['a'])
    write(file, { allow: ['a', 'bb'] })
    expect(getPolicy(env, 10_000).allow).toEqual(['a', 'bb'])
  })

  it('answers from memory inside the recheck window', () => {
    const file = write(join(tmp, 'p.json'), { allow: ['a'] })
    const env = envFor({ DSH_MARKET_POLICY: file, DSH_HOME: join(tmp, 'home') })
    const first = getPolicy(env, 0)
    expect(getPolicy(env, 100)).toBe(first)
  })
})

describe('expandEnv', () => {
  it('expands ${NAME} and reports the names that have no value', () => {
    expect(expandEnv('Bearer ${T}', { T: 'abc' })).toEqual({ value: 'Bearer abc', missing: [] })
    expect(expandEnv('${A}-${B}-${A}', { B: 'x' })).toEqual({ value: '-x-', missing: ['A'] })
    expect(expandEnv('no variables', {})).toEqual({ value: 'no variables', missing: [] })
  })
})

describe('globMatch', () => {
  it('matches `*` only, case-insensitively, over the whole name', () => {
    expect(globMatch('@acme/*', '@acme/dsh-x')).toBe(true)
    expect(globMatch('@acme/*', '@other/dsh-x')).toBe(false)
    expect(globMatch('dsh-notify-me', 'dsh-notify-me')).toBe(true)
    expect(globMatch('dsh-notify-me', 'dsh-notify-me-2')).toBe(false)
    expect(globMatch('DSH-*', 'dsh-loop')).toBe(true)
    // regex characters in a pattern are literal
    expect(globMatch('a.b', 'axb')).toBe(false)
    expect(globMatch('*', 'anything')).toBe(true)
  })
})
