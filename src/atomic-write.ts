/** Small profile files must not be truncated by a rejected write. */
import { accessSync, constants, lstatSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

/** Follow an existing file link without replacing the user's link itself. */
export function writeDestination(path: string): string {
  let link = false
  try { link = lstatSync(path).isSymbolicLink() } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // A dangling link is an error, not permission to replace it with a file.
  return link ? realpathSync(path) : path
}

/** Atomic replacement must respect the existing file's write permissions. */
export function checkWritableFile(path: string): void {
  try { accessSync(path, constants.W_OK) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export function writeFileAtomic(path: string, text: string): void {
  const target = writeDestination(path)
  checkWritableFile(target)
  let mode = 0o600
  try { mode = statSync(target).mode & 0o777 } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = join(dirname(target), `.dshm-write-${randomUUID()}`)
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode })
    renameSync(temporary, target)
  } finally { rmSync(temporary, { force: true }) }
}
