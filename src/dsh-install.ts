/** Locate the DSH host package in CLI and packaged Desktop runtimes. */

import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The entry with symlinks resolved, or unchanged when it cannot be read. */
function realpathOf(entry: string): string {
  try {
    return realpathSync(entry)
  } catch {
    // A path that does not exist, or one inside an ASAR archive, where
    // realpath fails: the raw entry is still the best guess and the walk
    // below simply answers null if it leads nowhere.
    return entry
  }
}

const DSH_PACKAGE = '@deepseek-ai/dsh'
const DESKTOP_PACKAGE = '@deepseek-ai/dsh-desktop'
const APPLICATION_ROOTS = ['app.asar.unpacked', 'app.asar', 'app']
// The split runtime reported in #553. Only these local, identity-checked
// packages corroborate the shell; never resolve witnesses from a profile.
const DESKTOP_RUNTIME_PACKAGES = ['dsh-base', 'dsh-web-app', 'dsh-web', 'dsh-settings']

/**
 * A package's own manifest, or null when its identity cannot be confirmed.
 */
function readDshManifest(directory: string, name = DSH_PACKAGE): { name: string; version?: unknown } | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(directory, 'package.json'), 'utf8'),
    ) as { name?: unknown; version?: unknown }
    return manifest.name === name ? { name, version: manifest.version } : null
  } catch {
    return null
  }
}

function entryDirectories(entry: string | undefined): string[] {
  if (entry === undefined) return []
  const directories: string[] = []
  let directory = resolve(dirname(realpathOf(entry)))
  for (let depth = 0; depth < 10; depth += 1) {
    directories.push(directory)
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return directories
}

function desktopDirectories(): string[] {
  const { resourcesPath } = process as NodeJS.Process & { resourcesPath?: unknown }
  if (typeof resourcesPath !== 'string' || resourcesPath.length === 0) return []
  return APPLICATION_ROOTS.map(root => join(resourcesPath, root))
}

function declaredVersion(manifest: { version?: unknown } | null): string {
  return typeof manifest?.version === 'string' && manifest.version !== '' ? manifest.version : 'unknown'
}

function flatDesktopHost(directory: string): { version: string; directory: string } | null {
  const shell = readDshManifest(directory, DESKTOP_PACKAGE)
  if (shell === null) return null
  const runtime = DESKTOP_RUNTIME_PACKAGES.map(name => {
    const candidate = join(directory, 'node_modules', '@deepseek-ai', name)
    // Bundled pnpm links are fine; a link to a mutable profile/global package
    // is not evidence about the version of the embedded runtime.
    const path = relative(realpathOf(directory), realpathOf(join(candidate, 'package.json')))
    if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) return null
    return readDshManifest(candidate, `@deepseek-ai/${name}`)
  })
  // A shell alone is not a dependency anchor. Either in-box bundle can
  // establish the directory even if the other version witnesses are broken.
  if (runtime[0] === null && runtime[1] === null) return null
  const version = declaredVersion(shell)
  // DSH split packages share a release line, but a desktop shell need not.
  // Require agreement from every witness; missing/conflicting evidence is
  // unknown, not the shell version or a majority vote among split packages.
  const parsed = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version)
  const corroborated = parsed !== null && !(parsed[1]?.split('.').some(part => /^0\d+$/.test(part)) ?? false)
    && runtime.every(manifest => manifest?.version === version)
  return { directory, version: corroborated ? version : 'unknown' }
}

/**
 * The version of the DSH host this market is running inside.
 *
 * CLI versions come from the host manifest. Flat Desktop shells additionally
 * require agreement with their bundled split runtime, never profile packages.
 *
 * Worth reporting because the host version has repeatedly been the thing
 * neither side could see. #293 turned on it (the reporter was on
 * 0.1.1-rc.2 while every attempt to reproduce had been on 0.1.0-rc.8, which
 * nobody knew until three rounds in), and #404 is entirely about a plugin
 * that requires a host newer than the Desktop build it was installed on.
 *
 * The directory comes back too, because WHERE it was found is the other half
 * of the answer: a path under Electron's resources is a Desktop-bundled host,
 * which #139 established can be older than whatever `npm ls` would report.
 * Asking the user is not a substitute — that is the number they do not have.
 * @returns the host version and the directory it was read from, or null when
 * no host package is locatable (a plain `dsh web` from a global install can
 * legitimately land here).
 */
export function dshHostInfo(entry = process.argv[1]): { version: string; directory: string } | null {
  const ancestors = entryDirectories(entry)
  const applications = desktopDirectories()
  // Keep the entire legacy search order ahead of newly supported shells.
  for (const directory of [...ancestors, ...applications.map(root => join(root, 'node_modules', '@deepseek-ai', 'dsh'))]) {
    const manifest = readDshManifest(directory)
    if (manifest !== null) return { directory, version: declaredVersion(manifest) }
  }
  for (const directory of [...ancestors, ...applications]) {
    const host = flatDesktopHost(directory)
    if (host !== null) return host
  }
  return null
}

/**
 * Walk up from the CLI entry first, then inspect Electron's authoritative
 * resources directory. Desktop distributions may keep node_modules outside
 * the ASAR, expose them through ASAR's virtual filesystem, or disable ASAR.
 *
 * The entry is resolved through symlinks before the walk, because for a
 * globally installed dsh it IS one. `npm i -g` and Homebrew both put a link
 * in a `bin/` directory pointing at the real package, so `process.argv[1]`
 * is `/opt/homebrew/bin/dsh` and walking up from there reaches `/` without
 * ever passing the package. Measured: the same call answers `null` for the
 * link and the correct directory for its target.
 *
 * That was not a cosmetic gap. Everything downstream reads the host version
 * from here — the exported log's `dsh host:` line (#426), Discover's
 * host-requirement column and filter (#473), and the pre-update check
 * (#404) — and a null version makes every one of them answer "unknown",
 * silently, on exactly the ordinary global install. A bundled Desktop host
 * is reached by the resources branch below and was never affected, which is
 * why this survived: the case that worked is the one that gets tested.
 */
export function findDshInstallDir(entry = process.argv[1]): string | null {
  return dshHostInfo(entry)?.directory ?? null
}
