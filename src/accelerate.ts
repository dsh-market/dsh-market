/**
 * Routing a GitHub install through a region's proxy.
 *
 * pnpm does not fetch `github:owner/repo` with `git clone`; it resolves the
 * shortcut and downloads a tarball from codeload.github.com. That rules out
 * the usual `git config insteadOf` trick — there is no git command to
 * redirect — and leaves rewriting the target as the only lever.
 *
 * Worth it: measured from an unproxied mainland connection, that tarball
 * takes 85s direct and 4.8s through the proxy.
 *
 * Two properties have to survive the rewrite, and both were found the hard
 * way rather than assumed:
 *
 * - **The commit has to be pinned.** The profile reads each plugin's
 *   installed commit back out of the lockfile by matching a codeload URL
 *   ending in a 40-character SHA (src/profile.ts). A `HEAD` tarball installs
 *   perfectly and then reports no version forever. So this resolves the SHA
 *   first, and a rewrite that cannot get one does not happen.
 * - **Build-script approval has to keep matching.** `gitAllowBuildsKey`
 *   (src/sources.ts) derives its key from the repo, and now recognizes the
 *   proxied form too — a plugin does not become a different plugin because
 *   its bytes arrived by another route.
 *
 * Subpath entries are left alone. A `#path:` selector picks one directory
 * out of a repo, and a tarball URL has nowhere to say that; those installs
 * stay on the direct route rather than quietly installing the wrong thing.
 *
 * Every failure falls back to the original target. Acceleration is an
 * optimisation, and an optimisation that can fail an install is a bug.
 */

import { logEvent } from './log.ts'
import { marketFetch } from './net.ts'
import { routesFor, type Region } from './regions.ts'
import { codeloadTarball } from './sources.ts'

/** A bare repo shortcut: the only target shape a tarball URL can express. */
const BARE_GITHUB_RE = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/

/**
 * How long to wait for the SHA before giving up and installing directly.
 *
 * Short on purpose: this is spent BEFORE the download starts, and the whole
 * point is to save time. A proxy that cannot answer in a few seconds is not
 * going to serve a tarball quickly either.
 */
const RESOLVE_TIMEOUT_MS = 6000

/**
 * The commit `HEAD` points at, from git's own ref advertisement.
 *
 * This is the endpoint `git clone` reads before it fetches anything, and it
 * is the right one here for two measured reasons. It is not the REST API, so
 * it does not consume the 60-requests-per-hour unauthenticated quota that a
 * user installing a handful of plugins could plausibly exhaust. And it
 * survives the proxy: over five consecutive tries from an unproxied mainland
 * connection it answered 200 in ~1.2s every time, while the REST API through
 * the same proxy returned 200, 200, then 403 — a proxy that rate-limits the
 * API path would silently drop every install back to the slow route.
 *
 * The response is git's pkt-line format, whose first ref line carries
 * `<sha> HEAD\0<capabilities>`. Read with a pattern rather than a parser:
 * one 40-character hex string followed by `HEAD` is unambiguous in this
 * payload, and a length-prefix reader would be more code to get wrong.
 */
export async function headCommit(
  repo: string,
  proxy: string | null,
  signal?: AbortSignal,
): Promise<string | null> {
  const base = `https://github.com/${repo}/info/refs?service=git-upload-pack`
  try {
    const res = await marketFetch(proxy === null ? base : `${proxy}/${base}`, {
      signal,
      headers: { 'user-agent': 'git/2.40.0' },
    })
    if (!res.ok) return null
    const found = /([0-9a-f]{40}) HEAD/.exec(await res.text())
    return found === null ? null : found[1]!
  } catch {
    return null
  }
}

/**
 * The current `HEAD` commit for a repo, on whichever route the region uses.
 *
 * Wraps the timeout so callers outside the install path — the build-script
 * approval below, which needs a commit-pinned key — do not each reinvent it.
 */
export async function resolveHeadCommit(
  repo: string,
  region: Region,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, RESOLVE_TIMEOUT_MS)
  try {
    return await headCommit(repo, routesFor(region, env).githubProxy, controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The install target to actually hand pnpm, given the region in force.
 *
 * @param target - what `installTargetFor` produced.
 * @param region - the download region.
 * @param env - environment, for the proxy override.
 * @returns a proxied commit-pinned tarball URL when every condition holds,
 *   otherwise `target` unchanged.
 */
export async function acceleratedTarget(
  target: string,
  region: Region,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const proxy = routesFor(region, env).githubProxy
  if (proxy === null) return target
  const bare = BARE_GITHUB_RE.exec(target)
  if (bare === null) return target
  const repo = bare[1]!
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, RESOLVE_TIMEOUT_MS)
  try {
    const sha = await headCommit(repo, proxy, controller.signal)
    if (sha === null) {
      logEvent('info', 'region', `${repo}: could not resolve a commit through the mirror; installing directly`)
      return target
    }
    return codeloadTarball(repo, sha, proxy)
  } finally {
    clearTimeout(timer)
  }
}
