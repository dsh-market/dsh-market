/**
 * The switches an administrator's policy turned OFF, as the page last heard
 * them from the server (the catalog response carries them).
 *
 * Module state rather than context: the image gate and the comment button sit
 * in functions far from any component that could receive a prop, and the value
 * is only ever replaced as a whole when a catalog arrives. The default — both
 * allowed — is what everyone with no policy has, so nothing changes for them.
 *
 * The server owns the rules; this only lets the page stop asking for things
 * it was told it may not have.
 */

export interface OrgPolicy {
  /** false: no image from another origin (screenshots, avatars, icons, README images). */
  externalImages: boolean
  /** false: no comment threads. */
  comments: boolean
}

const OPEN: OrgPolicy = { externalImages: true, comments: true }
let current: OrgPolicy = OPEN

/** Replace the policy with what the server sent (`undefined`/absent = no restrictions). */
export function setOrgPolicy(sent: { externalImages?: unknown; comments?: unknown } | null | undefined): void {
  current = sent === null || sent === undefined
    ? OPEN
    : { externalImages: sent.externalImages !== false, comments: sent.comments !== false }
}

export function orgPolicy(): OrgPolicy {
  return current
}

/** Whether an image URL may be loaded under the policy: any, or only the page's own origin. */
export function imageAllowed(url: string): boolean {
  if (current.externalImages) return true
  try {
    const base = typeof location === 'undefined' ? 'http://localhost/' : location.href
    const parsed = new URL(url, base)
    if (parsed.protocol === 'file:' || parsed.protocol === 'data:') return true
    return typeof location !== 'undefined' && parsed.origin === location.origin
  } catch {
    return false
  }
}
