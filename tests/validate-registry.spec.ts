import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The catalog gate is a script, not a module, so these run it for real against
 * a draft file. #1012 adds `previousNpm`, and a rule that only ever runs on the
 * live catalog would stay unexercised until the first rename lands — exactly
 * when a mistake is most expensive.
 */
function runCatalog(plugins: unknown[], extraEnv: Record<string, string> = {}): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-validate-'))
  const file = join(dir, 'catalog.json')
  writeFileSync(file, JSON.stringify({
    updated: '2026-01-01',
    count: plugins.length,
    categories: { tool: { en: 'Tools' } },
    plugins,
  }))
  const env = { ...process.env, DSHM_REGISTRY_FILE: file }
  delete env.DSHM_REGISTRY_ADVISORY
  Object.assign(env, extraEnv)
  const result = spawnSync(process.execPath, ['scripts/validate-registry.mjs'], {
    encoding: 'utf8',
    env,
  })
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
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

const gitOnly = (
  name: string,
  owner: string,
  repo: string,
  tarballRepo: string,
  extra: Record<string, unknown> = {},
) => ({
  name,
  owner,
  url: `https://github.com/${owner}/${repo}`,
  category: 'tool',
  npm: null,
  page: `https://awesome-dsh-plugin.com/p/${owner}/${repo}/`,
  description: { en: name, zh: name },
  stars: 0,
  install: `dsh plugin --profile web add "https://github.com/${tarballRepo}/releases/download/v1.0.0/x.tgz"`,
  added: '2026-01-01',
  ...extra,
})

/** The two live rows that have been failing every unrelated PR since 1.71.0. */
const knownDrifts = [
  gitOnly('dsh-quick-restart', 'GraptK', 'dsh-quick-restart', 'iQingke/dsh-quick-restart'),
  gitOnly('dsh-gitui', 'yaanlaan', 'dsh-gitui', 'yaanlaan/ds-gitui'),
]

describe('validate-registry known live-catalog drift', () => {
  it('still fails a local draft on an E10 owner mismatch', () => {
    const run = runCatalog([gitOnly('plug', 'Alice', 'plug', 'Bob/plug')])
    expect(run.status).toBe(1)
    expect(run.output).toContain('[E10] plug: release archive')
    expect(run.output).toContain('belongs to bob/plug, not Alice/plug')
  })

  it('still fails an unknown E10 even when advisory', () => {
    const run = runCatalog([gitOnly('plug', 'Alice', 'plug', 'Bob/plug')], { DSHM_REGISTRY_ADVISORY: '1' })
    expect(run.status, run.output).toBe(1)
    expect(run.output).toContain('[E10] plug: release archive')
  })

  it('excuses only the listed live rows when advisory', () => {
    const run = runCatalog(knownDrifts, { DSHM_REGISTRY_ADVISORY: '1' })
    expect(run.status, run.output).toBe(0)
    expect(run.output).toContain('[E10] dsh-quick-restart: release archive')
    expect(run.output).toContain('[E10] dsh-gitui: release archive')
    expect(run.output).toContain('known live-catalog drift')
  })

  it('still fails when a listed row is joined by a new error', () => {
    const extra = gitOnly('plug', 'Alice', 'plug', 'Alice/plug', {
      screenshots: ['https://evil.example/pixel.gif'],
    })
    const run = runCatalog([...knownDrifts, extra], { DSHM_REGISTRY_ADVISORY: '1' })
    expect(run.status, run.output).toBe(1)
    expect(run.output).toContain('[E12] plug:')
  })
})


