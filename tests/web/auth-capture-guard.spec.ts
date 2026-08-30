import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('authenticated browser artifact guard', () => {
  it('passes the current Web E2E sources, config, package script, and CI entrypoint', () => {
    const result = spawnSync(process.execPath, ['scripts/check-web-auth-capture.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('authenticated browser capture guard passed')
  })

  it('discovers a nested non-e2e helper and fails closed on trace or HAR capture', () => {
    const root = mkdtempSync(join(tmpdir(), 'dshm-auth-capture-guard-'))
    try {
      const nested = join(root, 'helpers')
      mkdirSync(nested)
      const helper = join(nested, 'browser-helper.ts')
      writeFileSync(helper, [
        "await context.tracing.start({ screenshots: true })",
        "await browser.newContext({ recordHar: { path: 'authenticated.har' } })",
      ].join('\n'))
      const result = spawnSync(process.execPath, [
        'scripts/check-web-auth-capture.mjs',
        '--browser-source-root',
        root,
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('BrowserContext tracing')
      expect(result.stderr).toContain('HAR recording')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
