/**
 * Which loader entry belongs to which installed package (#646).
 *
 * The ecosystem does not require a bundle patch's row `name:` to be the
 * package name. Two shapes are ordinary:
 *
 *     - id: aegis-method-pack
 *       name: aegis/extensions/dsh/index.js     ← a SUBPATH inside the package
 *     - id: filesystem
 *       name: @deepseek-ai/dsh-skill-filesystem  ← another package entirely
 *
 * `dsh-chat-import`, `meow-memory` and `dsh-context` all name themselves, so
 * the simple `name === packageName` comparison worked for years. `aegis`
 * names an entry inside itself, and every site that compared the two
 * directly concluded the plugin had no entry — the market reported "no
 * bundle patch … nothing to hot-mount" on enable (#646) and could not see
 * the entry was already live.
 *
 * Three such sites had grown independently (`src/themes.ts`, `src/verify.ts`,
 * `src/routes.ts`), each restating the rule from memory. That is the shape
 * the identity bugs #485→#605 came from: one assumption, several copies,
 * each fixed at a different time. The rule lives here now, once.
 *
 * The carrier case (#156) is NOT decided here. A bundle that mounts someone
 * else's package has no name relation at all, and is recognised by the entry
 * ID its own patch inserts — see `bundlePatchInsertedIds`. The two rules
 * compose; neither replaces the other.
 */

/**
 * Whether a loader entry name refers to `packageName`.
 *
 * The `/` bound is load-bearing: without it `toolshrink` would match an
 * entry named `toolshrink-extra`, a different installed package.
 *
 * @param name - an entry's `options.name`, in any shape.
 * @param packageName - the installed package name to match against.
 * @returns true for the bare name and for a subpath entry inside it.
 */
export function nameMatchesPackage(name: unknown, packageName: string): boolean {
  if (typeof name !== 'string' || name === '') return false
  return name === packageName || name.startsWith(`${packageName}/`)
}

/**
 * The same rule for a loader entry object.
 *
 * @param entry - anything with `options.name`, as the host's loader stores it.
 * @param packageName - the installed package name to match against.
 * @returns whether this entry is the one `packageName` refers to.
 */
export function entryMatchesPackage(
  entry: { options?: { name?: unknown } },
  packageName: string,
): boolean {
  return nameMatchesPackage(entry.options?.name, packageName)
}

/**
 * The package a subpath entry name belongs to — `aegis/x/y.js` → `aegis`.
 *
 * The inverse of {@link nameMatchesPackage}, for building a set of live
 * packages from a set of live entry names: an entry that is up proves its
 * package is up, and its name alone does not say so.
 *
 * Names that are not npm package names return null rather than a guess: a
 * relative path, an absolute path, a URL or a cordis builtin would otherwise
 * "belong to" a package that does not exist, which is worse than no answer.
 * A scoped name needs three segments (`@scope/pkg/sub`) to have a subpath at
 * all, and a lone `@scope/pkg` has no package to return.
 *
 * @param name - an entry's `options.name`.
 * @returns the package name, or null when the name cannot imply one.
 */
export function packageOfEntryName(name: string): string | null {
  if (typeof name !== 'string' || name === '') return null
  if (name.startsWith('.') || name.startsWith('/') || name.startsWith('cordis:')) return null
  if (name.includes('://')) return null
  if (!name.includes('/')) return null
  const parts = name.split('/')
  if (parts[0] === '') return null
  if (parts[0]!.startsWith('@')) return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : null
  return parts[0]!
}
