import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProfileBackup, downloadWebdav, restoreProfileBackup, uploadWebdav } from '../src/backup.ts'
import { profileDir } from '../src/profile.ts'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshm-backup-'))
  process.env.DSH_HOME = home
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

  it('uploads and downloads the same backup through WebDAV', async () => {
    const dir = profileDir('web')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{}')
    const backup = createProfileBackup('web')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(backup), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await uploadWebdav('https://dav.example/backup.json', 'user', 'secret', backup)
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT')
    expect(fetchMock.mock.calls[0][1].headers.get('authorization')).toMatch(/^Basic /)
    expect(await downloadWebdav('https://dav.example/backup.json', 'user', 'secret')).toEqual(backup)
    expect(fetchMock.mock.calls[1][1].method).toBe('GET')
  })
})
