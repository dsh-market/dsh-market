/** Published GitHub archives stay archive installs; never infer an npm identity. */
import { marketFetch } from './net.ts'
import { activeRegion, githubRoutesFor, rememberGithubRoute, throughProxy } from './regions.ts'
import type { CatalogReleaseSource } from './sources.ts'
export { catalogReleaseSourceOf, type CatalogReleaseSource } from './sources.ts'

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
