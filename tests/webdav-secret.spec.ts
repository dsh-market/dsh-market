import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearWebdavSecret, readWebdavSecret, webdavSecretFile, webdavSecretFor, writeWebdavSecret } from '../src/webdav-secret.ts'

describe('remembered WebDAV password (#1058)', () => {
  const dirs: string[] = []
  const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'dshm-secret-')); dirs.push(dir); return webdavSecretFile(dir) }
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('lives under the market state dir, not the profile', () => {
    expect(webdavSecretFile('/home/x/.dsh')).toBe(join('/home/x/.dsh', 'dsh-market', 'webdav.json'))
  })

  it('stores with owner-only permissions and reads back', () => {
    const file = fresh()
    expect(readWebdavSecret(file)).toBeNull()
    writeWebdavSecret({ url: 'https://d/x.json', username: 'a', password: 'pw' }, file)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readWebdavSecret(file)?.password).toBe('pw')
    expect(readFileSync(file, 'utf8')).toContain('pw')
  })

  it('only hands the password to the address and user it was saved for', () => {
    const file = fresh()
    writeWebdavSecret({ url: 'https://d/x.json', username: 'a', password: 'pw' }, file)
    expect(webdavSecretFor('https://d/x.json', 'a', file)).toBe('pw')
    expect(webdavSecretFor('https://evil/x.json', 'a', file)).toBeNull()
    expect(webdavSecretFor('https://d/x.json', 'b', file)).toBeNull()
  })

  it('forgetting deletes the file', () => {
    const file = fresh()
    writeWebdavSecret({ url: 'u', username: 'a', password: 'pw' }, file)
    clearWebdavSecret(file)
    expect(existsSync(file)).toBe(false)
    expect(() => clearWebdavSecret(file)).not.toThrow()
  })
})
