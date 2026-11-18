/**
 * The host's own "open this bundle's page" entry (dsh 0.2.1+).
 *
 * The Plugins page documents `pluginNavigation.openBundle(packageName)` for
 * other client plugins: it selects that page and shows the bundle, without
 * touching the running Session. The market uses it from an installed plugin's
 * ··· menu, because the host's page is the only place a bundle's ROWS can be
 * switched on and off one by one — the market draws the bundle's own switch
 * and nothing below it.
 *
 * A store rather than a plain value: the service arrives with the host's
 * plugin manager, which may load after this package, and a menu drawn from a
 * snapshot taken at setup would never offer the action on a host that has it.
 */

/** What the host offers, as much of it as this package uses. */
export interface HostNavigation {
  openBundle(packageName: string): void
  /**
   * Select the Plugins page on its list view (Installed tab). Optional: the
   * service shipped with `openBundle` first, and a host without this call
   * simply cannot be steered to the page from here.
   */
  openList?(): void
}

export interface HostNavigationStore {
  /** The service, or undefined on a host that never provides it. */
  get(): HostNavigation | undefined
  /** Re-render hook for the menus that offer the action. */
  subscribe(listener: () => void): () => void
  /** The host provided the service. */
  attach(navigation: HostNavigation): void
}

export function createHostNavigation(): HostNavigationStore {
  let navigation: HostNavigation | undefined
  const listeners = new Set<() => void>()
  return {
    get: () => navigation,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    attach: (next) => {
      navigation = next
      for (const listener of [...listeners]) listener()
    },
  }
}
