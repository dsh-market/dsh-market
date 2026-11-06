/** Published GitHub archives stay archive installs; never infer an npm identity. */
import { marketFetch } from './net.ts'
import { activeRegion, githubRoutesFor, rememberGithubRoute, throughProxy } from './regions.ts'
import { installTargetFor, parseSourceUrl } from './sources.ts'

export interface CatalogReleaseSource {
  repo: string
  asset: string
  manifest: string
}

/** Only the catalog's own floating asset opts an existing archive into updates. */
export function catalogReleaseSourceOf(
  spec: string,
  entry: { url: string; npm?: unknown; tarball?: unknown },
): CatalogReleaseSource | null {
  if (entry.npm !== null && entry.npm !== undefined) return null
  const source = parseSourceUrl(entry.url)
  if (source === null || typeof entry.tarball !== 'string' || installTargetFor(entry) !== entry.tarball) return null
  try {
    const approved = new URL(entry.tarball)
    const installed = new URL(spec)
    const asset = /^\/[^/]+\/[^/]+\/releases\/latest\/download\/([A-Za-z0-9._-]+\.(?:tgz|tar\.gz))$/.exec(approved.pathname)?.[1]
    if (asset === undefined) return null
    for (const url of [approved, installed]) {
      if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null
    }
    const match = /^\/([^/]+\/[^/]+)\/releases\/(?:latest\/download|download\/[^/]+)\/([^/]+)$/.exec(installed.pathname)
    if (match === null || match[1]!.toLowerCase() !== source.repo.toLowerCase() || match[2] !== asset) return null
    return { repo: source.repo, asset, manifest: source.subpath === null ? 'package.json' : `${source.subpath}/package.json` }
  } catch { return null }
}

export async function publishedReleaseUpdate(
  source: CatalogReleaseSource,
  name: string,
): Promise<{ version: string; target: string } | null> {
  try {
    const init = { headers: { 'user-agent': 'dsh-market' }, signal: AbortSignal.timeout(10_000) }
    // The ordinary redirect has no REST API quota and cannot advertise an
    // unpublished main-branch version. Keep the published tag in the add target.
    const latest = await marketFetch(`https://github.com/${source.repo}/releases/latest`, { ...init, method: 'HEAD', redirect: 'manual' })
    if (latest.status !== 302 && latest.status !== 301) return null
    const location = new URL(latest.headers.get('location') ?? '', `https://github.com/${source.repo}/releases/latest`)
    const prefix = `/${source.repo}/releases/tag/`
    if (location.origin !== 'https://github.com' || location.username !== '' || location.password !== '' || location.search !== '' || location.hash !== '' || !location.pathname.toLowerCase().startsWith(prefix.toLowerCase())) return null
    const tag = location.pathname.slice(prefix.length)
    if (!/^v?\d+\.\d+\.\d+$/.test(tag)) return null
    const version = tag.replace(/^v/, '')
    const manifestUrl = `https://raw.githubusercontent.com/${source.repo}/${tag}/${source.manifest}`
    for (const route of githubRoutesFor('raw', activeRegion())) {
      try {
        const response = await marketFetch(throughProxy(route, manifestUrl), { headers: init.headers, signal: AbortSignal.timeout(10_000) })
        if (!response.ok) continue
        const manifest = await response.json() as { name?: unknown; version?: unknown }
        if (manifest.name !== name || manifest.version !== version) return null
        rememberGithubRoute('raw', route)
        const target = `https://github.com/${source.repo}/releases/download/${tag}/${source.asset}`
        const archive = await marketFetch(target, { headers: init.headers, signal: AbortSignal.timeout(10_000), method: 'HEAD', redirect: 'manual' })
        if (archive.status !== 200 && archive.status !== 302 && archive.status !== 301) return null
        return { version, target }
      } catch { /* Another configured raw route may answer. */ }
    }
    return null
  } catch { return null }
}
