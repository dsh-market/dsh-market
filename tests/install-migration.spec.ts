import {describe,it,expect} from 'vitest'
import {installMigrationHelp} from '../src/install-migration.ts'
describe('renamed package migration guidance',()=>{
 it('preserves the duplicate guard and gives a settings-preserving exit without uninstall',()=>{
  const old={'dsh-purge':'file:/existing/release.tgz'}
  const before=JSON.stringify(old)
  const r=installMigrationHelp('https://github.com/kingcharleslzy-ai/dsh-purge',old)
  expect(r?.code).toBe('migration-required')
  expect(r?.error).toContain('无需卸载')
  expect(r?.migrationGuide).toMatch(/^https:\/\/github.com\/kingcharleslzy-ai\/dsh-purge\//)
  expect(JSON.stringify(old)).toBe(before)
 })
 it('does not block fresh installs, current installs, or unrelated same-name repositories',()=>{
  expect(installMigrationHelp('https://github.com/kingcharleslzy-ai/dsh-purge',{})).toBeNull()
  expect(installMigrationHelp('https://github.com/kingcharleslzy-ai/dsh-purge',{'dsh-purge':'old','dsh-purge-community':'current'})).toBeNull()
  expect(installMigrationHelp('https://github.com/other/dsh-purge',{'dsh-purge':'old'})).toBeNull()
 })
})
