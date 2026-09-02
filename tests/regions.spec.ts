/**
 * The download-region routing table and the target rewriting built on it.
 *
 * Pure string logic, so it is asserted directly rather than through a route.
 * Two of these tests exist because the property they check was measured
 * against the real services and would be invisible in a mock: a proxied
 * codeload URL still has to satisfy the lockfile reader's SHA pattern, and
 * build-script approval still has to produce the key it produced before.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  activeRegion, asRegion, DEFAULT_NPM_REGISTRY, REGIONS, routesFor, setActiveRegion, throughProxy,
} from '../src/regions.ts'
import { codeloadAllowBuildsKey, codeloadTarball, githubCommitOfTarget, gitAllowBuildsKey, repoOfTarget } from '../src/sources.ts'
import { githubProxyInUse, githubUrl, setGithubProxy } from '../src/client/market-data.ts'

const SHA = 'b0e6c57ebeeb4796017864f5cd5c66e6ba0899ec'

afterEach(() => { setActiveRegion('global') })

describe('asRegion', () => {
  it('accepts the two regions and nothing else', () => {
    expect(asRegion('global')).toBe('global')
    expect(asRegion('china')).toBe('china')
    expect(asRegion('CN')).toBeNull()
    expect(asRegion(undefined)).toBeNull()
    expect(asRegion({ region: 'china' })).toBeNull()
  })
})

describe('routesFor', () => {
  it('leaves the global route on the official sources', () => {
    const routes = routesFor('global', {})
    expect(routes.npmRegistry).toBe(DEFAULT_NPM_REGISTRY)
    expect(routes.githubProxy).toBeNull()
    // One source and no fallbacks: this IS what everything else falls back to.
    expect(routes.catalog).toEqual([{ kind: 'url', url: expect.stringContaining('awesome-dsh-plugin.com') }])
  })

  it('sends every china route through a mirror, ending at the address that always works', () => {
    const routes = routesFor('china', {})
    expect(routes.npmRegistry).not.toBe(DEFAULT_NPM_REGISTRY)
    expect(routes.githubProxy).not.toBeNull()
    // The published package first: it rides the same mirror as the plugins,
    // so it needs no service that did not already have to work.
    expect(routes.catalog[0]).toEqual({ kind: 'npm', registry: routes.npmRegistry, pkg: 'dsh-plugin-catalog' })
    // And the origin last. Nothing in between: `plugins.json` is a build
    // artifact the site never commits, so a raw.githubusercontent step would
    // be a guaranteed 404 that costs two attempts to discover.
    expect(routes.catalog).toHaveLength(2)
    expect(routes.catalog[1]).toEqual({ kind: 'url', url: expect.stringContaining('awesome-dsh-plugin.com') })
  })

  it('moves the catalog package onto whichever registry the environment named', () => {
    const routes = routesFor('china', { DSHM_NPM_MIRROR: 'https://npm.internal' })
    expect(routes.catalog[0]).toEqual({ kind: 'npm', registry: 'https://npm.internal', pkg: 'dsh-plugin-catalog' })
  })

  it('lets the environment override each route', () => {
    const routes = routesFor('china', {
      DSHM_NPM_MIRROR: 'https://npm.internal/',
      DSHM_GITHUB_PROXY: 'https://gh.internal/',
    })
    // Trailing slashes are stripped so callers can join without doubling.
    expect(routes.npmRegistry).toBe('https://npm.internal')
    expect(routes.githubProxy).toBe('https://gh.internal')
  })

  it('replaces the whole source list when the catalog itself is overridden', () => {
    // Someone pointing the market at their own catalog does not want it
    // quietly reverting to ours when that one is briefly unreachable — that
    // is how a fixture-backed test ends up asserting against the live one.
    const routes = routesFor('china', { DSHM_REGISTRY_URL: 'http://127.0.0.1:9/fixture.json' })
    expect(routes.catalog).toEqual([{ kind: 'url', url: 'http://127.0.0.1:9/fixture.json' }])
  })

  it('ignores blank overrides', () => {
    const routes = routesFor('china', { DSHM_NPM_MIRROR: '   ' })
    expect(routes.npmRegistry).toBe(routesFor('china', {}).npmRegistry)
  })
})

describe('the active region', () => {
  it('starts global and follows what it is set to', () => {
    expect(activeRegion()).toBe('global')
    setActiveRegion('china')
    expect(activeRegion()).toBe('china')
  })
})

describe('throughProxy', () => {
  it('prefixes the whole absolute URL, so one proxy serves every github host', () => {
    expect(throughProxy('https://p', 'https://api.github.com/x')).toBe('https://p/https://api.github.com/x')
    expect(throughProxy(null, 'https://api.github.com/x')).toBe('https://api.github.com/x')
  })
})

describe('codeloadTarball', () => {
  it('pins the commit, because a HEAD url installs and then reports no version', () => {
    // The profile reads the installed commit back out of the lockfile with
    // this exact pattern (src/profile.ts). It is a SUBSTRING match, which is
    // the whole reason a proxy prefix is survivable — assert both shapes
    // against it rather than trusting that.
    const lockPattern = /codeload\.github\.com\/([^/\s]+\/[^/\s]+)\/tar\.gz\/([0-9a-f]{40})/
    const direct = codeloadTarball('o/r', SHA, null)
    const proxied = codeloadTarball('o/r', SHA, 'https://gh-proxy.com')
    expect(direct).toBe(`https://codeload.github.com/o/r/tar.gz/${SHA}`)
    expect(proxied).toBe(`https://gh-proxy.com/https://codeload.github.com/o/r/tar.gz/${SHA}`)
    expect(lockPattern.exec(direct)?.[2]).toBe(SHA)
    expect(lockPattern.exec(proxied)?.[2]).toBe(SHA)
  })
})

describe('repoOfTarget', () => {
  it('resolves both spellings of one plugin to one identity', () => {
    // This is what stops a region switch from making every installed plugin
    // look like a different one to the duplicate guard.
    expect(repoOfTarget('github:Owner/Repo')).toBe('owner/repo')
    expect(repoOfTarget(codeloadTarball('Owner/Repo', SHA, 'https://gh-proxy.com'))).toBe('owner/repo')
    expect(repoOfTarget(codeloadTarball('Owner/Repo', SHA, null))).toBe('owner/repo')
  })

  it('keeps a subpath, which names a different plugin in the same repo', () => {
    expect(repoOfTarget('github:o/r#path:/packages/x')).toBe('o/r#path:/packages/x')
    expect(repoOfTarget(`github:o/r#${SHA}&path:/packages/x`)).toBe('o/r#path:/packages/x')
  })

  it('is null for anything that is not a github source', () => {
    expect(repoOfTarget('dsh-loop')).toBeNull()
    expect(repoOfTarget('@scope/pkg')).toBeNull()
    expect(repoOfTarget('/tmp/local-checkout')).toBeNull()
    // A tarball with no full SHA is not a target we produce, and treating it
    // as one would let an unpinned install pass the identity check.
    expect(repoOfTarget('https://codeload.github.com/o/r/tar.gz/HEAD')).toBeNull()
    // Non-matching GitHub URLs are not recognized as targets.
    expect(repoOfTarget('https://github.com/owner/repo/archive/refs/heads/main.tar.gz')).toBeNull()
  })
})

describe('githubCommitOfTarget', () => {
  it('reads the exact pin from both target spellings without another HEAD lookup', () => {
    expect(githubCommitOfTarget(`github:o/r#${SHA}`)).toBe(SHA)
    expect(githubCommitOfTarget(`github:o/r#${SHA}&path:/packages/x`)).toBe(SHA)
    expect(githubCommitOfTarget(codeloadTarball('o/r', SHA, 'https://gh-proxy.com'))).toBe(SHA)
  })

  it('refuses mutable, short, malformed, and non-github refs', () => {
    expect(githubCommitOfTarget('github:o/r')).toBeNull()
    expect(githubCommitOfTarget('github:o/r#main')).toBeNull()
    expect(githubCommitOfTarget('github:o/r#b0e6c57')).toBeNull()
    expect(githubCommitOfTarget(`github:o/r#path:/packages/x&${SHA}`)).toBeNull()
    expect(githubCommitOfTarget(`https://example.test/o/r/tar.gz/${SHA}`)).toBeNull()
  })
})

describe('gitAllowBuildsKey', () => {
  it('gives a proxied install the same key as a direct one', () => {
    // A plugin does not become a different plugin because its bytes arrived
    // by another route — so build-script approval must not have to be given
    // twice, once per region.
    const direct = gitAllowBuildsKey('p', 'github:o/r')
    const proxied = gitAllowBuildsKey('p', codeloadTarball('o/r', SHA, 'https://gh-proxy.com'))
    expect(direct).toBe('p@git+https://github.com/o/r.git')
    expect(proxied).toBe(direct)
  })

  it('keeps the repo in its original case', () => {
    // pnpm matches this key as a literal string, so normalising it would
    // stop it matching for anyone whose repo is not all lowercase.
    expect(gitAllowBuildsKey('p', 'github:DeepSeek/Harness')).toBe('p@git+https://github.com/DeepSeek/Harness.git')
  })

  it('still accepts every fragment form it accepted before', () => {
    expect(gitAllowBuildsKey('p', 'github:o/r#path:/packages/x')).toBe('p@git+https://github.com/o/r.git')
    expect(gitAllowBuildsKey('p', 'github:o/r#semver:^1.0.0')).toBe('p@git+https://github.com/o/r.git')
    expect(gitAllowBuildsKey('p', 'github:o/r.git')).toBe('p@git+https://github.com/o/r.git')
  })

  it('is null for npm packages, which authorize by name', () => {
    expect(gitAllowBuildsKey('p', 'dsh-loop')).toBeNull()
  })
})

describe('codeloadAllowBuildsKey', () => {
  it('names the commit-pinned URL pnpm 11.7 prints in its own error', () => {
    // The stable git+https key is the better one and does not go stale, but
    // pnpm below 11.21 never matches it — so on the pnpm DSH Desktop bundles,
    // "allow build scripts and retry" wrote a key pnpm would never read.
    expect(codeloadAllowBuildsKey('p', 'github:o/r', SHA))
      .toBe(`p@https://codeload.github.com/o/r/tar.gz/${SHA}`)
  })

  it('derives the same key from either spelling of the source', () => {
    const fromShortcut = codeloadAllowBuildsKey('p', 'github:o/r', SHA)
    const fromProxied = codeloadAllowBuildsKey('p', codeloadTarball('o/r', SHA, 'https://gh.test'), SHA)
    expect(fromProxied).toBe(fromShortcut)
  })

  it('keeps the repo in its original case, like the stable key', () => {
    expect(codeloadAllowBuildsKey('p', 'github:DeepSeek/Harness', SHA))
      .toBe(`p@https://codeload.github.com/DeepSeek/Harness/tar.gz/${SHA}`)
  })

  it('refuses anything that is not a full commit sha', () => {
    // A short or non-hex ref would produce a key that matches nothing, which
    // is indistinguishable on disk from an approval that worked.
    expect(codeloadAllowBuildsKey('p', 'github:o/r', 'b0e6c57')).toBeNull()
    expect(codeloadAllowBuildsKey('p', 'github:o/r', 'HEAD')).toBeNull()
    expect(codeloadAllowBuildsKey('p', 'dsh-loop', SHA)).toBeNull()
  })
})

describe('REGIONS', () => {
  it('lists every region the narrowing function accepts', () => {
    // The status route sends this list and the card draws from it, so a
    // region present in one and absent from the other would be a control
    // the route refuses.
    for (const region of REGIONS) expect(asRegion(region)).toBe(region)
    expect(REGIONS).toHaveLength(2)
  })
})

describe('browser-side github URLs', () => {
  // These two were both got wrong on the first pass and caught by measuring
  // from an unproxied mainland connection, not by reasoning. They are kept
  // as tests because the failure mode of the first one is a hang, which is
  // the kind of thing a screenshot of a working page will never show.
  afterEach(() => { setGithubProxy(null) })

  it('names the avatar host directly when proxied, because the redirect hangs', () => {
    // gh-proxy does not follow github.com's redirect to the avatar host: the
    // request sat until the client gave up at 60s, against 1.07s for the
    // avatar host addressed through the same proxy.
    setGithubProxy(null)
    expect(githubProxyInUse()).toBeNull()
    setGithubProxy('https://gh.test')
    expect(githubUrl('https://avatars.githubusercontent.com/o?size=96'))
      .toBe('https://gh.test/https://avatars.githubusercontent.com/o?size=96')
  })

  it('leaves a URL alone when no proxy is in force', () => {
    setGithubProxy(null)
    expect(githubUrl('https://raw.githubusercontent.com/o/r/HEAD/README.md'))
      .toBe('https://raw.githubusercontent.com/o/r/HEAD/README.md')
  })
})
