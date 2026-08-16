import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const network = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn(),
}))

vi.mock('node:dns/promises', () => ({ lookup: network.lookup }))
vi.mock('node:https', () => ({ request: network.request }))

import {
  createProfileBackup, downloadWebdav, isPublicTarget, restoreProfileBackup, uploadWebdav,
} from '../src/backup.ts'
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

/**
 * Windows without Developer Mode / elevated privileges rejects symlinkSync
 * with EPERM (an environment limitation unrelated to issue #98). Probe once
 * with the exact same call shape the symlink test uses; when unavailable the
 * test is skipped so the suite stays green on locked-down machines/CI.
 */
const symlinksAvailable = ((): boolean => {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-symlink-probe-'))
  try {
    const target = join(dir, 'target')
    const link = join(dir, 'link')
    mkdirSync(target)
    symlinkSync(target, link)
    return existsSync(link)
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshm-backup-'))
  process.env.DSH_HOME = home
  network.lookup.mockReset()
  network.request.mockReset()
  network.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('profile backup and restore', () => {
  it('round-trips config files and excludes installed/cache data', () => {
    const dir = profileDir('web')
    mkdirSync(join(dir, 'node_modules', 'plugin'), { recursive: true })
    mkdirSync(join(dir, 'plugin-config'), { recursive: true })
    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"dependencies":{"plugin":"^1.0.0"}}')
    writeFileSync(join(dir, 'cordis.patch.yml'), '- config: true')
    writeFileSync(join(dir, 'plugin-config', 'settings.json'), '{"enabled":true}')
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
    writeFileSync(join(dir, 'node_modules', 'plugin', 'large.bin'), 'not included')
    writeFileSync(join(dir, '.dsh-market', 'state.json'), '{}')

    const backup = createProfileBackup('web')
    expect(backup.files.map(file => file.path)).toEqual(['cordis.patch.yml', 'package.json', 'plugin-config/settings.json'])
    expect(backup.version).toBe(0.2)
    expect(backup.files.find(file => file.path === 'cordis.patch.yml')).toEqual({ path: 'cordis.patch.yml', lines: ['- config: true'] })
    expect(backup.files.find(file => file.path === 'package.json')).toEqual({ path: 'package.json', json: { dependencies: { plugin: '^1.0.0' } } })

    writeFileSync(join(dir, 'package.json'), '{"dependencies":{}}')
    rmSync(join(dir, 'plugin-config', 'settings.json'))
    restoreProfileBackup('web', backup)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('plugin')
    expect(readFileSync(join(dir, 'plugin-config', 'settings.json'), 'utf8')).toBe('{"enabled":true}')
    expect(existsSync(join(dir, 'node_modules', 'plugin', 'large.bin'))).toBe(true)
  })

  it('rejects traversal paths without touching the profile', () => {
    const dir = profileDir('web')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{}')
    const backup = createProfileBackup('web')
    backup.files.push({ path: '../outside', lines: ['bad'] })
    expect(() => restoreProfileBackup('web', backup)).toThrow(/unsafe backup path/)
    expect(existsSync(join(home, 'profiles', 'outside'))).toBe(false)
  })

  it.skipIf(!symlinksAvailable)('rejects an existing symlink in a restored path parent', () => {
    const dir = profileDir('web')
    const outside = join(home, 'outside')
    mkdirSync(dir, { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(dir, 'package.json'), '{}')
    symlinkSync(outside, join(dir, 'escape'))
    const backup = createProfileBackup('web')
    backup.files.push({ path: 'escape/probe.txt', lines: ['must stay inside the profile'] })

    expect(() => restoreProfileBackup('web', backup)).toThrow(/unsafe backup path/)
    expect(existsSync(join(outside, 'probe.txt'))).toBe(false)
  })

  it('uses an explicit Desktop-owned profile directory', () => {
    const explicitDir = join(home, 'desktop-profile')
    mkdirSync(explicitDir)
    writeFileSync(join(explicitDir, 'package.json'), '{"dependencies":{"desktop-only":"1.0.0"}}')
    const backup = createProfileBackup('工作 profile', explicitDir)

    writeFileSync(join(explicitDir, 'package.json'), '{}')
    restoreProfileBackup('工作 profile', backup, explicitDir)
    expect(readFileSync(join(explicitDir, 'package.json'), 'utf8')).toContain('desktop-only')
  })

  it('blocks direct and DNS-resolved private WebDAV targets', async () => {
    const dir = profileDir('web')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{}')
    const backup = createProfileBackup('web')

    for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '172.17.0.1', '192.168.1.1', '[::1]', '[fc00::1]']) {
      expect(isPublicTarget(host), host).toBe(false)
      await expect(uploadWebdav(`https://${host}/backup.json`, '', '', backup)).rejects.toThrow(/invalid WebDAV URL/)
    }
    network.lookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])
    await expect(uploadWebdav('https://rebinding.example/backup.json', '', '', backup)).rejects.toThrow(/invalid WebDAV URL/)
    expect(network.request).not.toHaveBeenCalled()
  })

  it('uploads and downloads the same backup through WebDAV', async () => {
    const dir = profileDir('web')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{}')
    const backup = createProfileBackup('web')
    respondWith('', 201)
    respondWith(JSON.stringify(backup), 200)

    await uploadWebdav('https://dav.example/backup.json', 'user', 'secret', backup)
    expect(network.request.mock.calls[0][0]).toMatchObject({
      hostname: '93.184.216.34', method: 'PUT', servername: 'dav.example',
      headers: { host: 'dav.example', authorization: expect.stringMatching(/^Basic /) },
    })
    expect(await downloadWebdav('https://dav.example/backup.json', 'user', 'secret')).toEqual(backup)
    expect(network.request.mock.calls[1][0]).toMatchObject({
      hostname: '93.184.216.34', method: 'GET', servername: 'dav.example',
    })
  })
})

describe('WebDAV parent collections (#102)', () => {
  it('creates missing folders before the upload, and explains a surviving 404', async () => {
    const dir = profileDir('web')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{}')
    const backup = createProfileBackup('web')
    // Jianguoyun: PUT into a folder that does not exist answers 404, and files
    // are not allowed at the root at all.
    respondWith('', 405) // MKCOL /dav/ — already exists
    respondWith('', 201) // MKCOL /dav/dsh/ — created
    respondWith('', 201) // PUT the backup
    await uploadWebdav('https://dav.jianguoyun.com/dav/dsh/backup.json', 'u', 'p', backup)
    expect(network.request.mock.calls.map(call => call[0].method)).toEqual(['MKCOL', 'MKCOL', 'PUT'])
    expect(network.request.mock.calls[1][0]).toMatchObject({ path: '/dav/dsh/', method: 'MKCOL' })

    // A root-level file has no folder to create — Jianguoyun's 404 there now
    // names the actual remedy (put it inside a folder) instead of the code.
    network.request.mockReset()
    respondWith('', 404)
    await expect(uploadWebdav('https://dav.jianguoyun.com/backup.json', 'u', 'p', backup))
      .rejects.toThrow(/does not exist and could not be created/)
    expect(network.request.mock.calls.map(call => call[0].method)).toEqual(['PUT'])
  })

  it('lists ancestor collections outermost first, excluding the server root', async () => {
    const { webdavParentCollections } = await import('../src/backup.ts')
    // Jianguoyun's shape: the file must live inside a folder, and the folder
    // has to be created explicitly or the PUT answers 404.
    expect(webdavParentCollections('https://dav.jianguoyun.com/dav/dsh/backup.json'))
      .toEqual(['https://dav.jianguoyun.com/dav/', 'https://dav.jianguoyun.com/dav/dsh/'])
    // A file at the root has no collection to create.
    expect(webdavParentCollections('https://dav.example.com/backup.json')).toEqual([])
    expect(webdavParentCollections('not a url')).toEqual([])
  })
})
