/** Catalog-declared plugin dependency planning. */

/** Minimum registry fields needed to resolve plugin dependencies. */
export interface DependencyEntry {
  name: string
  url: string
  requires?: readonly string[]
}

/** Canonical repository URL identity used by catalog dependency references. */
export function dependencyIdentity(url: string): string {
  return url.trim().replace(/\/+$/u, '').toLowerCase()
}

/** Return a dependency-first installation order for one catalog entry. */
export function resolveInstallOrder<T extends DependencyEntry>(plugins: readonly T[], root: T): T[] {
  const byIdentity = new Map<string, T>()
  for (const plugin of plugins) byIdentity.set(dependencyIdentity(plugin.url), plugin)
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const order: T[] = []
  const visit = (plugin: T, path: readonly string[]): void => {
    const identity = dependencyIdentity(plugin.url)
    if (visited.has(identity)) return
    if (visiting.has(identity)) throw new Error(`catalog dependency cycle: ${[...path, plugin.name].join(' -> ')}`)
    visiting.add(identity)
    for (const requiredUrl of plugin.requires ?? []) {
      const required = byIdentity.get(dependencyIdentity(requiredUrl))
      if (required === undefined) throw new Error(`catalog plugin ${JSON.stringify(plugin.name)} requires missing entry ${JSON.stringify(requiredUrl)}`)
      visit(required, [...path, plugin.name])
    }
    visiting.delete(identity)
    visited.add(identity)
    order.push(plugin)
  }
  visit(root, [])
  return order
}

/** Return installed catalog entries that transitively require a target. */
export function installedDependents<T extends DependencyEntry>(
  plugins: readonly T[],
  target: T,
  installed: (plugin: T) => boolean,
): T[] {
  const targetIdentity = dependencyIdentity(target.url)
  return plugins.filter(plugin => {
    if (plugin === target || !installed(plugin)) return false
    return resolveInstallOrder(plugins, plugin)
      .some(required => required !== plugin && dependencyIdentity(required.url) === targetIdentity)
  })
}
