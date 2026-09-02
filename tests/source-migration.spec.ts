import { describe, expect, it } from 'vitest'
          import { findGitToNpmMigration } from '../src/source-migration.ts'

          const plugins = [
            { name: 'dsh-genui', url: 'https://github.com/omdsh-dev/dsh-genui', npm: '@changfenhuang/dsh-genui' },
            { name: 'mono#a', url: 'https://github.com/o/mono/tree/main/packages/a', npm: '@o/a' },
            { name: 'mono#b', url: 'https://github.com/o/mono/tree/main/packages/b', npm: '@o/b' },
          ]

          describe('findGitToNpmMigration', () => {
            it('matches only the exact verified repository identity', () => {
              expect(findGitToNpmMigration(plugins, 'github:omdsh-dev/dsh-genui')).toEqual({
                kind: 'git-to-npm',
                repo: 'omdsh-dev/dsh-genui',
                target: '@changfenhuang/dsh-genui',
              })
              expect(findGitToNpmMigration(plugins, 'github:someone-else/dsh-genui')).toBeNull()
            })

            it('keeps explicit branch, tag, commit and semver selections on Git', () => {
              expect(findGitToNpmMigration(plugins, 'github:omdsh-dev/dsh-genui#publish')).toBeNull()
              expect(findGitToNpmMigration(plugins, 'github:omdsh-dev/dsh-genui#v1.0.0')).toBeNull()
              expect(findGitToNpmMigration(plugins, `github:omdsh-dev/dsh-genui#${'a'.repeat(40)}`)).toBeNull()
              expect(findGitToNpmMigration(plugins, 'github:omdsh-dev/dsh-genui#semver:^1.0.0')).toBeNull()
            })

            it('requires exact monorepo path identity', () => {
              expect(findGitToNpmMigration(plugins, 'github:o/mono')).toBeNull()
              expect(findGitToNpmMigration(plugins, 'github:o/mono#path:/packages/a')).toEqual({
                kind: 'git-to-npm',
                repo: 'o/mono#path:/packages/a',
                target: '@o/a',
              })
              expect(findGitToNpmMigration(plugins, 'github:o/mono#path:/packages/missing')).toBeNull()
            })

            it('fails closed when one identity maps to multiple verified npm entries', () => {
              const ambiguous = [
                ...plugins,
                { name: 'duplicate', url: 'https://github.com/omdsh-dev/dsh-genui', npm: '@other/dsh-genui' },
              ]
              expect(findGitToNpmMigration(ambiguous, 'github:omdsh-dev/dsh-genui')).toBeNull()
            })
          })
