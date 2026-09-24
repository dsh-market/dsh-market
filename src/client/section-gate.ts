/**
 * Whether the market's own `settings.section` entry is registered.
 *
 * Two independent things decide that, and they arrive at different times:
 *
 * - **The host**, which may render the market itself and therefore wants no
 *   duplicate entry in the settings page (#602, from the Tauri desktop
 *   shell). It says so through the service this package publishes, and it
 *   may say so before the slots service has even appeared.
 * - **This package being removed**, which retires the entry for good: a nav
 *   item for a package that is gone is the card claiming something the
 *   profile no longer agrees with.
 *
 * A small state machine rather than two inline booleans, because the
 * orderings are the entire difficulty. A host that hides before the slots
 * service arrives must not get a flash of the entry first; a removal must
 * not be undone by a later "show"; and a host that hides and then shows must
 * get its entry back without re-registering a second one.
 */

/** The visibility rules, with the registering itself left to the caller. */
export interface SectionGate {
  /**
   * The slots service has arrived. Until this is called the gate holds its
   * answer rather than acting on it, because there is nothing to act on.
   */
  available(): void
  /** The host's preference. Takes effect now, or as soon as it can. */
  setVisible(visible: boolean): void
  /** Whether the entry is registered right now. */
  visible(): boolean
  /** The package is being removed: never register again. */
  retire(): void
}

/**
 * @param register - registers the entry and returns its disposer. Called
 *   only when the entry should be visible; may be called again after a
 *   retraction, which is why the disposer is required rather than optional.
 * @returns the gate.
 */
export function createSectionGate(register: () => () => void): SectionGate {
  let ready = false
  // Default visible: this is an opt-in a host makes, not something a user
  // opts out of, so the absence of an opinion means "as it always was".
  let wanted = true
  let removed = false
  let dispose: (() => void) | null = null

  const apply = (): void => {
    if (!ready) return
    const shouldShow = wanted && !removed
    if (shouldShow && dispose === null) {
      dispose = register()
      return
    }
    if (!shouldShow && dispose !== null) {
      const stop = dispose
      dispose = null
      stop()
    }
  }

  return {
    available: () => {
      ready = true
      apply()
    },
    setVisible: (visible: boolean) => {
      wanted = visible
      apply()
    },
    visible: () => dispose !== null,
    retire: () => {
      removed = true
      apply()
    },
  }
}
