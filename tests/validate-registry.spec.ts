import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import validCatalog from './fixtures/registry-valid.json'

function runValidator(file: string, extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ['scripts/validate-registry.mjs'], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv, DSHM_REGISTRY_FILE: file },
  })
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

function runCatalog(plugins: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-validate-'))
  try {
    const file = join(dir, 'catalog.json')
    writeFileSync(file, JSON.stringify({ ...validCatalog, count: plugins.length, plugins }))
    return runValidator(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const entry = (name: string, npmName: string, previousNpm?: unknown) => ({
  name,
  owner: 'o',
  url: `https://github.com/o/${name}`,
  category: 'tool',
  npm: npmName,
  ...(previousNpm === undefined ? {} : { previousNpm }),
  page: `https://awesome-dsh-plugin.com/p/${name}/`,
  description: { en: name, zh: name },
  stars: 0,
  install: `dsh plugin --profile web add ${npmName}`,
  added: '2026-01-01',
})

describe('validate-registry previousNpm (#1012 P1)', () => {
  it('accepts a renamed entry whose former name is gone from npm', () => {
    const run = runCatalog([entry('renamed', 'renamed-new', ['renamed-old'])])
    expect(run.status, run.output).toBe(0)
    expect(run.output).toContain('registry ok')
  })

  it('refuses a former name that is still a live package in the catalog', () => {
    const run = runCatalog([entry('old', 'renamed-old'), entry('renamed', 'renamed-new', ['renamed-old'])])
    expect(run.status).toBe(1)
    expect(run.output).toContain('[E13] renamed: previousNpm "renamed-old" is still a live package name')
  })

  it('refuses one former name claimed by two successors', () => {
    const run = runCatalog([
      entry('renamed-a', 'renamed-a-new', ['renamed-old']),
      entry('renamed-b', 'renamed-b-new', ['renamed-old']),
    ])
    expect(run.status).toBe(1)
    expect(run.output).toContain('[E13] renamed-b: previousNpm "renamed-old" is already declared by "renamed-a"')
  })

  it('refuses malformed and empty declarations instead of ignoring them', () => {
    const run = runCatalog([
      entry('empty', 'empty-new', []),
      entry('not-a-list', 'list-new', 'renamed-old'),
      entry('bad-name', 'bad-new', ['Not A Name']),
    ])
    expect(run.status).toBe(1)
    expect(run.output).toContain('[E13] empty: previousNpm must be a non-empty array')
    expect(run.output).toContain('[E13] not-a-list: previousNpm must be a non-empty array')
    expect(run.output).toContain('[E13] bad-name: previousNpm entry "Not A Name" is not a valid npm package name')
  })

  it('refuses a former name that differs only in case', () => {
    const run = runCatalog([entry('renamed', 'renamed-new', ['Renamed-Old'])])
    expect(run.status).toBe(1)
    expect(run.output).toContain('[E13] renamed: previousNpm entry "Renamed-Old" must be lowercase')
  })

  it('refuses a miscased field name instead of ignoring the declaration', () => {
    // The runtime reads the exact key, so `PreviousNpm` would validate as an
    // unknown-but-harmless property and the rename would silently never appear.
    const run = runCatalog([{ ...entry('renamed', 'renamed-new'), PreviousNpm: ['renamed-old'] }])
    expect(run.status).toBe(1)
    expect(run.output).toContain('[E13] renamed: key "PreviousNpm" is not the rename field')
  })
})

const [notifier, formatter, linter] = validCatalog.plugins

describe('validate-registry install identities', () => {
  it('accepts distinct release-installed subpaths of the same repository', () => {
    const run = runValidator(join('tests', 'fixtures', 'registry-valid.json'))
    expect(run.status, run.output).toBe(0)
    expect(run.output).toContain('registry ok')
  })

  it('rejects two repositories that claim the same npm package', () => {
    const alias = { ...notifier, name: 'other-notifier', url: 'https://github.com/example/other-notifier' }
    const run = runCatalog([notifier, alias])
    expect(run.status, run.output).toBe(1)
    expect(run.output).toContain('[E11] other-notifier: duplicate install identity with "notifier"')
  })

  it('rejects two entries with the same repository and subpath', () => {
    const run = runCatalog([formatter, { ...linter, url: formatter.url }])
    expect(run.status, run.output).toBe(1)
    expect(run.output).toContain('[E11] linter: duplicate install identity with "formatter"')
  })
})

describe('validate-registry catalog errors', () => {
  it('fails a missing explicit file even when the remote catalog is valid', () => {
    const missingFile = join('tests', 'fixtures', 'missing-catalog.json')
    const run = runValidator(missingFile, {
      DSHM_REGISTRY_URL: `data:application/json,${encodeURIComponent(JSON.stringify(validCatalog))}`,
    })
    expect(run.status, run.output).toBe(1)
    expect(run.output).toContain(missingFile)
  })

  it('rejects a release archive hosted in another repository', () => {
    const run = runCatalog([{ ...formatter, install: formatter.install.replace('example/tools', 'other/tools') }])
    expect(run.status, run.output).toBe(1)
    expect(run.output).toContain('[E10] formatter: release archive')
    expect(run.output).toContain('belongs to other/tools, not example/tools')
  })

  it('rejects a screenshot outside the allowed GitHub hosts', () => {
    const run = runCatalog([{ ...notifier, screenshots: ['https://example.com/image.png'] }])
    expect(run.status, run.output).toBe(1)
    expect(run.output).toContain('[E12] notifier: screenshot must be an https URL on GitHub hosting')
  })
})


