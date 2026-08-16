import { describe, expect, it } from 'vitest'
import { diagnosePackageManifests } from '../src/diagnostics.ts'

const excel033 = {
  name: 'dsh-excel-chat',
  version: '0.33.0',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  dependencies: {
    '@deepseek-ai/dsh-attachment': '^0.0.1-rc.1',
    '@deepseek-ai/dsh-llm': '^0.0.1-rc.1',
    '@deepseek-ai/dsh-system-prompt': '^0.0.1-rc.1',
    '@deepseek-ai/dsh-tools': '^0.0.1-rc.1',
    exceljs: '^4.4.0',
  },
  peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
}

const excel0341 = {
  name: 'dsh-excel-chat',
  version: '0.34.1',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  dependencies: { exceljs: '^4.4.0', fflate: '^0.8.3' },
  peerDependencies: {
    '@deepseek-ai/cordis': '^4.0.1',
    '@deepseek-ai/dsh-attachment': '^0.1.0-rc.6',
    '@deepseek-ai/dsh-llm': '^0.1.0-rc.6',
    '@deepseek-ai/dsh-system-prompt': '^0.1.0-rc.6',
    '@deepseek-ai/dsh-tools': '^0.1.0-rc.6',
  },
  devDependencies: {
    '@types/node': '^26.0.0',
    typescript: '^5.7.0',
  },
}

describe('shared host dependency diagnostics', () => {
  const findingsFor = (packageName: string, manifest: unknown) =>
    diagnosePackageManifests([{ packageName, manifest }]).findings

  it('reports the four host contracts declared as normal dependencies by dsh-excel-chat 0.33.0', () => {
    const findings = findingsFor('dsh-excel-chat', excel033)
    expect(findings.map(finding => [
      finding.evidence.dependency,
      finding.evidence.declaredRange,
    ])).toEqual([
      ['@deepseek-ai/dsh-attachment', '^0.0.1-rc.1'],
      ['@deepseek-ai/dsh-llm', '^0.0.1-rc.1'],
      ['@deepseek-ai/dsh-system-prompt', '^0.0.1-rc.1'],
      ['@deepseek-ai/dsh-tools', '^0.0.1-rc.1'],
    ])
    expect(findings.every(finding => finding.evidence.basis === 'manifest-declaration')).toBe(true)
    expect(findings.every(finding => !('confidence' in finding))).toBe(true)
  })

  it('accepts the current dsh-excel-chat 0.34.1 bundle and replacement providers that use host peers', () => {
    expect(findingsFor('dsh-excel-chat', excel0341)).toEqual([])
    expect(findingsFor('custom-agent-loop', {
      dependencies: { 'private-loop-algorithm': '^1.0.0' },
      peerDependencies: {
        '@deepseek-ai/cordis': '^4.0.1',
        '@deepseek-ai/dsh-llm': '^0.1.0-rc.6',
        '@deepseek-ai/dsh-tools': '^0.1.0-rc.6',
      },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })).toEqual([])
  })

  it('keeps carrier-style packages as non-blocking manifest findings without claiming runtime duplication', () => {
    const findings = findingsFor('carrier-plugin', {
      dsh: {},
      dependencies: {
        '@deepseek-ai/dsh-llm': '^0.1.0-rc.6',
        '@deepseek-ai/dsh-system-prompt': '^0.1.0-rc.6',
      },
    })
    expect(findings).toHaveLength(2)
    expect(findings.every(finding => finding.severity === 'warning')).toBe(true)
    expect(findings.every(finding => !('confidence' in finding))).toBe(true)
  })

  it('uses a conservative explicit allowlist and ignores malformed manifest fields', () => {
    expect(findingsFor('sample', {
      dsh: {},
      dependencies: {
        '@deepseek-ai/cordis': '^4.0.1',
        '@deepseek-ai/dsh-session': '^0.1.0-rc.6',
        '@deepseek-ai/dsh-client-ui-primitives': '^0.1.0-rc.6',
        '@deepseek-ai/dsh-tools': 7,
      },
      devDependencies: {
        '@deepseek-ai/dsh-attachment': '^0.1.0-rc.6',
      },
    }).map(finding => finding.evidence.dependency)).toEqual(['@deepseek-ai/cordis'])
    expect(findingsFor('sample', null)).toEqual([])
  })

  it('builds a deterministic, versioned report from package facts', () => {
    const report = diagnosePackageManifests([
      { packageName: 'z-plugin', manifest: excel033 },
      { packageName: 'missing', manifest: null },
      {
        packageName: 'plain-helper',
        manifest: { dependencies: { '@deepseek-ai/cordis': '^4.0.1' } },
      },
      {
        packageName: 'a-plugin',
        manifest: {
          dsh: {},
          dependencies: { '@deepseek-ai/dsh-llm': '^0.0.1-rc.1' },
        },
      },
    ])
    expect(report.schema).toBe('dsh-market/diagnostics/v1')
    expect(report.findings.map(finding => [
      finding.subject.name,
      finding.evidence.dependency,
    ])).toEqual([
      ['a-plugin', '@deepseek-ai/dsh-llm'],
      ['z-plugin', '@deepseek-ai/dsh-attachment'],
      ['z-plugin', '@deepseek-ai/dsh-llm'],
      ['z-plugin', '@deepseek-ai/dsh-system-prompt'],
      ['z-plugin', '@deepseek-ai/dsh-tools'],
    ])
  })
})
