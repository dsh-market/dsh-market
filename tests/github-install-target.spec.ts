import { afterEach, describe, expect, it, vi } from 'vitest'
import { mismatchedWorkspaceRoot } from '../src/github-install-target.ts'

const SHA = 'b'.repeat(40)

afterEach(() => { vi.unstubAllGlobals() })

describe('mismatchedWorkspaceRoot (#1208)', () => {
  it.each([
    ['an explicit #path: subdirectory (#1183)', 'github:o/kit#path:/packages/dsh-citelint'],
    ['a semver selector', 'github:o/kit#semver:^1.0.0'],
    ['a branch ref', 'github:o/kit#main'],
    ['a release archive', 'https://github.com/o/kit/releases/download/v1/dsh-citelint.tgz'],
    ['a repo named like the entry', 'github:o/dsh-citelint'],
  ])('does not look at %s', async (_label, target) => {
    const request = vi.fn(async () => { throw new Error('must not fetch') })
    vi.stubGlobal('fetch', request)
    await expect(mismatchedWorkspaceRoot(target, 'dsh-citelint', 'global')).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it('lets a root that carries its own DSH declaration through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ name: 'kit', dsh: {}, workspaces: ['packages/*'] })))
    await expect(mismatchedWorkspaceRoot(`github:o/kit#${SHA}`, 'dsh-citelint', 'global')).resolves.toBeNull()
  })

  it('lets a plain (non-workspace) root with another name through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ name: 'kit', version: '1.0.0' })))
    await expect(mismatchedWorkspaceRoot(`github:o/kit#${SHA}`, 'dsh-citelint', 'global')).resolves.toBeNull()
  })

  it('names the root when it is an undeclared workspace root under another name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ name: 'kit', workspaces: { packages: ['packages/*'] } })))
    await expect(mismatchedWorkspaceRoot(`github:o/kit#${SHA}`, 'dsh-citelint', 'global')).resolves.toBe('kit')
  })

  it('fails open when the manifest cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    await expect(mismatchedWorkspaceRoot(`github:o/kit#${SHA}`, 'dsh-citelint', 'global')).resolves.toBeNull()
  })
})
