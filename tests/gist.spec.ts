import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const network = vi.hoisted(() => ({
  request: vi.fn(),
}))
const childProcess = vi.hoisted(() => ({
  spawn: vi.fn(),
}))

vi.mock('node:https', () => ({ request: network.request }))
vi.mock('node:child_process', () => ({ spawn: childProcess.spawn }))

/** Fake a `gh auth token` child: stdout data, then close. */
function mockGhSpawn(stdout: string, fail = false): void {
  // Sustained mock: fetchGhToken tries every candidate (gh, ~/.local/bin/gh),
  // so the same behavior must apply to each spawn attempt — each call gets a
  // FRESH child so listeners never stack on one object.
  childProcess.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      kill: vi.fn(),
      unref: vi.fn(),
    })
    queueMicrotask(() => {
      if (fail) child.emit('error', new Error('ENOENT'))
      else {
        child.stdout.emit('data', Buffer.from(stdout))
        child.emit('close', 0, null)
      }
    })
    return child
  })
}

import {
  createGist, fitsGistLimit, GistError, gistErrorCode, GIST_FILENAME, parseGistId, readGist, resetGhTokenCache, resolveGistToken, resolveGistTokenSource, updateGist, verifyGistToken,
} from '../src/gist.ts'
import { createProfileBackup, extractPluginSelection, mergeRestoreManifest, type ProfileBackup } from '../src/backup.ts'
import { profileDir } from '../src/profile.ts'

function respondWith(body: string, statusCode: number): void {
  network.request.mockImplementationOnce((_options, callback) => {
    const response = Readable.from(body === '' ? [] : [Buffer.from(body)])
    Object.assign(response, { statusCode, headers: { 'content-length': String(Buffer.byteLength(body)) } })
    const request = Object.assign(new EventEmitter(), { end: vi.fn() })
    queueMicrotask(() => callback(response))
    return request
  })
}

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshm-gist-'))
  process.env.DSH_HOME = home
  resetGhTokenCache()
  network.request.mockReset()
  childProcess.spawn.mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.DSH_HOME
  delete process.env.DSH_GITHUB_TOKEN
  rmSync(home, { recursive: true, force: true })
})

describe('parseGistId', () => {
  it('accepts a bare id and URL forms', () => {
    expect(parseGistId('abc123def456')).toBe('abc123def456')
    expect(parseGistId('https://gist.github.com/user/abc123def456')).toBe('abc123def456')
    expect(parseGistId('https://gist.github.com/abc123def456')).toBe('abc123def456')
    expect(parseGistId('  abc123def456  ')).toBe('abc123def456')
  })

  it('rejects empty, path-like and oversize input', () => {
    expect(() => parseGistId('')).toThrow(/required/)
    expect(() => parseGistId('   ')).toThrow(/required/)
    expect(() => parseGistId('a/b')).toThrow(/invalid/)
    expect(() => parseGistId('../etc/passwd')).toThrow(/invalid/)
    expect(() => parseGistId('a'.repeat(65))).toThrow(/invalid/)
  })
})

describe('resolveGistToken', () => {
  it('prefers the supplied token over the environment', async () => {
    process.env.DSH_GITHUB_TOKEN = 'env-token'
    await expect(resolveGistToken('body-token')).resolves.toBe('body-token')
    await expect(resolveGistToken('  padded  ')).resolves.toBe('padded')
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })

  it('falls back to the configured environment variable', async () => {
    process.env.DSH_GITHUB_TOKEN = 'env-token'
    await expect(resolveGistToken(undefined)).resolves.toBe('env-token')
    await expect(resolveGistToken('')).resolves.toBe('env-token')
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })

  it('uses a logged-in gh CLI when nothing else is configured', async () => {
    mockGhSpawn('gh-token\n')
    await expect(resolveGistToken(undefined)).resolves.toBe('gh-token')
    expect(childProcess.spawn).toHaveBeenCalled()
  })

  it('caches the gh token for later calls', async () => {
    mockGhSpawn('gh-token\n')
    await expect(resolveGistToken(undefined)).resolves.toBe('gh-token')
    await expect(resolveGistToken(undefined)).resolves.toBe('gh-token')
    // Second call served from cache — no second spawn.
    expect(childProcess.spawn).toHaveBeenCalledTimes(1)
  })

  it('throws when no token source is available', async () => {
    mockGhSpawn('', true)
    await expect(resolveGistToken(undefined)).rejects.toThrow(/token is required/)
    await expect(resolveGistToken('')).rejects.toThrow(/token is required/)
  })
})

function sampleBackup(): ProfileBackup {
  return {
    format: 'dsh-profile-backup',
    version: 0.2,
    createdAt: new Date().toISOString(),
    profile: 'web',
    files: [{ path: 'package.json', json: { dependencies: { a: '^1.0.0' } } }],
  }
}

describe('Gist transport', () => {
  it('creates a private Gist with the backup file', async () => {
    respondWith(JSON.stringify({ id: 'g1', html_url: 'https://gist.github.com/u/g1' }), 201)
    const ref = await createGist('tok', JSON.stringify(sampleBackup()))
    expect(ref).toEqual({ id: 'g1', htmlUrl: 'https://gist.github.com/u/g1' })
    expect(network.request.mock.calls[0][0]).toMatchObject({
      hostname: 'api.github.com', method: 'POST', path: '/gists',
      headers: { authorization: 'Bearer tok', accept: 'application/vnd.github+json' },
    })
    const sent = JSON.parse(String(network.request.mock.results[0]?.value?.end.mock.calls[0]?.[0] ?? '')) as { public: unknown; files: Record<string, { content: string }> }
    expect(sent.public).toBe(false)
    expect(sent.files[GIST_FILENAME].content).toContain('dsh-profile-backup')
  })

  it('updates an existing Gist via PATCH', async () => {
    respondWith(JSON.stringify({ id: 'g1', html_url: 'https://gist.github.com/u/g1' }), 200)
    const ref = await updateGist('tok', 'g1', JSON.stringify(sampleBackup()))
    expect(ref.id).toBe('g1')
    expect(network.request.mock.calls[0][0]).toMatchObject({ method: 'PATCH', path: '/gists/g1' })
  })

  it('reads and validates a backup from a Gist', async () => {
    respondWith(JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify(sampleBackup()) } } }), 200)
    const backup = await readGist('tok', 'g1')
    expect(backup.format).toBe('dsh-profile-backup')
    expect(network.request.mock.calls[0][0]).toMatchObject({ method: 'GET', path: '/gists/g1' })
  })

  it('rejects a Gist without the backup file', async () => {
    respondWith(JSON.stringify({ files: { 'other.json': { content: '{}' } } }), 200)
    await expect(readGist('tok', 'g1')).rejects.toThrow(/no dsh-profile-backup/)
  })

  it('rejects a Gist whose backup content is not a valid backup', async () => {
    respondWith(JSON.stringify({ files: { [GIST_FILENAME]: { content: '{"format":"nope"}' } } }), 200)
    await expect(readGist('tok', 'g1')).rejects.toThrow(/unsupported backup format/)
    respondWith(JSON.stringify({ files: { [GIST_FILENAME]: { content: 'not json' } } }), 200)
    await expect(readGist('tok', 'g1')).rejects.toThrow(/not valid JSON/)
  })

  it('verifies the token against /user', async () => {
    respondWith('{}', 200)
    await verifyGistToken('tok')
    expect(network.request.mock.calls[0][0]).toMatchObject({ method: 'GET', path: '/user' })
  })

  it('maps auth and not-found failures to friendly errors', async () => {
    respondWith(JSON.stringify({ message: 'Bad credentials' }), 401)
    await expect(createGist('bad', '{}')).rejects.toThrow(/invalid or revoked/)
    respondWith(JSON.stringify({ message: 'Not Found' }), 404)
    await expect(readGist('tok', 'nope')).rejects.toThrow(/not found/i)
  })
})

describe('partial export', () => {
  it('exports only the selected dependencies and bundles', () => {
    const dir = profileDir('web')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'p',
      dependencies: { a: '^1.0.0', b: '^2.0.0' },
      dsh: { profile: { bundles: ['b', 'c'] } },
    }))
    const backup = createProfileBackup('web', undefined, { includeDeps: ['a', 'c'] })
    expect(backup.files.map(file => file.path)).toEqual(['package.json'])
    const json = backup.files[0] as { json: { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } } }
    expect(json.json.dependencies).toEqual({ a: '^1.0.0' })
    expect(json.json.dsh.profile.bundles).toEqual(['c'])
  })

  it('keeps other config files when includeConfig is set', () => {
    const dir = profileDir('web')
    mkdirSync(join(dir, 'cfg'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"dependencies":{"a":"^1.0.0","b":"^2.0.0"}}')
    writeFileSync(join(dir, 'cfg', 'settings.json'), '{"x":1}')
    const backup = createProfileBackup('web', undefined, { includeDeps: ['a'], includeConfig: true })
    const paths = backup.files.map(file => file.path)
    expect(paths).toContain('package.json')
    expect(paths).toContain('cfg/settings.json')
    const json = backup.files.find(file => file.path === 'package.json') as { json: { dependencies: Record<string, string> } }
    expect(json.json.dependencies).toEqual({ a: '^1.0.0' })
  })

  it('rejects an empty selection', () => {
    const dir = profileDir('web')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"dependencies":{"a":"^1.0.0"}}')
    expect(() => createProfileBackup('web', undefined, { includeDeps: [] })).toThrow(/no plugins selected/)
    expect(() => createProfileBackup('web', undefined, { includeDeps: ['missing'] })).toThrow(/none of the selected/)
  })
})

describe('extractPluginSelection', () => {
  it('returns only string specs for the selected names', () => {
    const backup: ProfileBackup = {
      format: 'dsh-profile-backup', version: 0.2, createdAt: '', profile: 'web',
      files: [{ path: 'package.json', json: {
        dependencies: { a: '^1.0.0', b: 42, c: '^3.0.0' },
        dsh: { profile: { bundles: ['b', 'c'] } },
      } }],
    }
    const selection = extractPluginSelection(backup, ['a', 'c'])
    expect(selection.deps).toEqual({ a: '^1.0.0', c: '^3.0.0' })
    expect(selection.bundles).toEqual(['c'])
  })

  it('throws when the backup has no manifest', () => {
    const backup: ProfileBackup = {
      format: 'dsh-profile-backup', version: 0.2, createdAt: '', profile: 'web',
      files: [{ path: 'cordis.patch.yml', lines: [] }],
    }
    expect(() => extractPluginSelection(backup, ['a'])).toThrow(/no package.json/)
  })
})

describe('mergeRestoreManifest', () => {
  it('keeps the target plugins and overlays backup specs', () => {
    const merged = mergeRestoreManifest(
      { dependencies: { a: '^1.0.0', b: '^2.0.0' }, dsh: { profile: { bundles: ['b'] } } },
      { dependencies: { b: '^9.0.0', local: 'file:./local' }, dsh: { profile: { bundles: ['local'] } } },
    )
    expect(merged.dependencies).toEqual({ b: '^2.0.0', local: 'file:./local', a: '^1.0.0' })
    expect((merged.dsh as { profile: { bundles: string[] } }).profile.bundles.sort()).toEqual(['b', 'local'])
  })

  it('merges only the selection when provided', () => {
    const merged = mergeRestoreManifest(
      { dependencies: { a: '^1.0.0', b: '^2.0.0' }, dsh: { profile: { bundles: ['b'] } } },
      { dependencies: { local: 'file:./local' } },
      { deps: { a: '^1.0.0' }, bundles: [] },
    )
    expect(merged.dependencies).toEqual({ local: 'file:./local', a: '^1.0.0' })
    expect((merged.dsh as { profile: { bundles: string[] } }).profile.bundles).toEqual([])
  })
})

describe('fitsGistLimit', () => {
  it('accepts small payloads and rejects over 1 MB', () => {
    expect(fitsGistLimit('x'.repeat(1024))).toBe(true)
    expect(fitsGistLimit('x'.repeat(1024 * 1024 + 1))).toBe(false)
  })
})

/** Make the mocked https.request fail with a request-level error. */
function failWith(error: Error): void {
  network.request.mockImplementationOnce((_options, callback) => {
    const response = Readable.from([])
    Object.assign(response, { statusCode: 200, headers: {} })
    const request = Object.assign(new EventEmitter(), { end: vi.fn() })
    queueMicrotask(() => request.emit('error', error))
    return request
  })
}

describe('token source resolution', () => {
  it('reports the source for every resolution path', async () => {
    expect(await resolveGistTokenSource('body-token')).toEqual({ token: 'body-token', source: 'token' })
    process.env.DSH_GITHUB_TOKEN = 'env-token'
    expect(await resolveGistTokenSource(undefined)).toEqual({ token: 'env-token', source: 'env' })
    delete process.env.DSH_GITHUB_TOKEN
    mockGhSpawn('gh-token\n')
    expect(await resolveGistTokenSource(undefined)).toEqual({ token: 'gh-token', source: 'gh' })
  })

  it('resolveGistToken still returns just the token', async () => {
    process.env.DSH_GITHUB_TOKEN = 'env-token'
    await expect(resolveGistToken(undefined)).resolves.toBe('env-token')
    delete process.env.DSH_GITHUB_TOKEN
  })

  it('throws a GistError with code auth when no source exists', async () => {
    mockGhSpawn('', true)
    await expect(resolveGistTokenSource(undefined)).rejects.toMatchObject({ code: 'auth' })
  })

  it('recovers when the first candidate (gh on PATH) fails with ENOENT', async () => {
    // Node emits 'error' then a companion 'close' (code -2) on spawn failure;
    // the close handler must not lock the result to null before the next
    // candidate (absolute path) succeeds — regression for systemd services
    // whose PATH lacks ~/.local/bin.
    let calls = 0
    childProcess.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        kill: vi.fn(),
        unref: vi.fn(),
      })
      queueMicrotask(() => {
        if (calls++ === 0) {
          child.emit('error', new Error('ENOENT'))
          child.emit('close', -2, null)
        } else {
          child.stdout.emit('data', Buffer.from('gh-token\n'))
          child.emit('close', 0, null)
        }
      })
      return child
    })
    await expect(resolveGistToken(undefined)).resolves.toBe('gh-token')
    expect(childProcess.spawn).toHaveBeenCalledTimes(2)
  })
})

describe('error classification', () => {
  it('classifies request-level timeouts as code timeout', async () => {
    failWith(new DOMException('signal timed out', 'TimeoutError'))
    await expect(verifyGistToken('tok')).rejects.toMatchObject({ code: 'timeout' })
  })

  it('classifies DNS failures as code network', async () => {
    const err = new Error('getaddrinfo ENOTFOUND api.github.com')
    ;(err as { code?: string }).code = 'ENOTFOUND'
    failWith(err)
    await expect(verifyGistToken('tok')).rejects.toMatchObject({ code: 'network' })
  })

  it('maps HTTP failures to stable codes', async () => {
    respondWith(JSON.stringify({ message: 'Bad credentials' }), 401)
    await expect(createGist('bad', '{}')).rejects.toMatchObject({ code: 'auth' })
    respondWith(JSON.stringify({ message: 'Not Found' }), 404)
    await expect(readGist('tok', 'nope')).rejects.toMatchObject({ code: 'notfound' })
    respondWith(JSON.stringify({ message: 'no dice' }), 422)
    await expect(updateGist('tok', 'g1', '{}')).rejects.toMatchObject({ code: 'invalid' })
  })

  it('gistErrorCode maps any thrown value to a stable code', () => {
    expect(gistErrorCode(new GistError('x', 'auth'))).toBe('auth')
    expect(gistErrorCode(new DOMException('t', 'TimeoutError'))).toBe('timeout')
    expect(gistErrorCode(new DOMException('a', 'AbortError'))).toBe('timeout')
    const net = new Error('boom')
    ;(net as { code?: string }).code = 'ECONNRESET'
    expect(gistErrorCode(net)).toBe('network')
    expect(gistErrorCode(new Error('plain'))).toBe('other')
    expect(gistErrorCode('string value')).toBe('other')
  })
})
