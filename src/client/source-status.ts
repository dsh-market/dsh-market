/**
 * Which catalogs could not be read on the last load.
 *
 * A module-level store rather than a field threaded through the market's
 * context: it is written in one place (the catalog read in discovery-scan) and
 * read in two (the Discover banner and the "nothing loaded" page), and the
 * context those pages share is already wide enough.
 *
 * Empty for everyone with only the public catalog — the common case — so
 * nothing renders and nothing changes for them.
 */

import type { CatalogSourceInfo } from './market-data.ts'

let failed: CatalogSourceInfo[] = []
const listeners = new Set<() => void>()

/** Record the sources of the latest read (`undefined` when none are configured). */
export function noteSources(sources: readonly CatalogSourceInfo[] | undefined): void {
  const next = (sources ?? []).filter(source => source.status === 'failed')
  if (next.length === 0 && failed.length === 0) return
  failed = next
  for (const listener of listeners) listener()
}

export const sourceStatus = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  getSnapshot(): CatalogSourceInfo[] {
    return failed
  },
}
