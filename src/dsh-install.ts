/** Locate the DSH host package in CLI and packaged Desktop runtimes. */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const DSH_PACKAGE = '@deepseek-ai/dsh'

function isDshPackage(directory: string): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(join(directory, 'package.json'), 'utf8'),
    ) as { name?: unknown }
    return manifest.name === DSH_PACKAGE
  } catch {
    return false
  }
}

/**
 * Walk up from the CLI entry first, then inspect Electron's authoritative
 * resources directory. Desktop distributions may keep node_modules outside
 * the ASAR, expose them through ASAR's virtual filesystem, or disable ASAR.
 */
export function findDshInstallDir(entry = process.argv[1]): string | null {
  if (entry !== undefined) {
    let directory = resolve(dirname(entry))
    for (let depth = 0; depth < 10; depth += 1) {
      if (isDshPackage(directory)) return directory
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }

  const electronProcess = process as NodeJS.Process & { resourcesPath?: unknown }
  if (typeof electronProcess.resourcesPath !== 'string'
    || electronProcess.resourcesPath.length === 0) return null

  for (const applicationRoot of ['app.asar.unpacked', 'app.asar', 'app']) {
    const candidate = join(
      electronProcess.resourcesPath,
      applicationRoot,
      'node_modules',
      '@deepseek-ai',
      'dsh',
    )
    if (isDshPackage(candidate)) return candidate
  }
  return null
}
