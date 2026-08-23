/**
 * Shared IR key for joining curated catalog entries to outside evidence.
 *
 * A GitHub repository root and a plugin living under one of its monorepo
 * subpaths are different catalog entries. Consumers may normalize spelling,
 * but must not erase or invent that path.
 */
export function normalizeCatalogUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com'
      || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return null
    const owner = parts[0]!.toLowerCase()
    const repository = parts[1]!.replace(/\.git$/i, '').toLowerCase()
    if (owner === '' || repository === '') return null
    return `https://github.com/${[owner, repository, ...parts.slice(2)].join('/')}`
  } catch {
    return null
  }
}
