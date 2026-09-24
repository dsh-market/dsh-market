import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type SymlinkKind = 'dir' | 'file'

const cached = new Map<SymlinkKind, boolean>()

/**
 * Whether this machine can create a symlink of `kind`.
 *
 * Windows without Developer Mode and without elevation rejects `symlinkSync`
 * with EPERM. That is an environment limitation, not a result about the code
 * under test, so the symlink tests skip when this returns false and the suite
 * stays green on a locked-down machine.
 *
 * Each kind is probed separately, and each probe uses the same target kind as
 * the test it guards — a probe that creates a directory symlink does not answer
 * for a test that needs a file one, which is the whole reason this is a function
 * rather than a constant:
 *
 *  - `file` creates a *file* symlink. It has no fallback: `junction` is a
 *    directory-only reparse point, so the trick the directory fixtures below use
 *    (`check.spec.ts:1226`, `snapshot.spec.ts:296`) is unavailable to a test that
 *    needs a file link, and nothing but a symlink can dangle.
 *  - `dir` leaves `type` unset over a directory target, the shape the directory
 *    fixtures use; node autodetects the type in that case.
 */
export function canCreateSymlink(kind: SymlinkKind): boolean {
  const known = cached.get(kind)
  if (known !== undefined) return known

  // `existsSync` is checked because a rejected symlink can also be created and
  // then dropped, which would answer true for a link that is not there.
  const dir = mkdtempSync(join(tmpdir(), `dshm-symlink-${kind}-probe-`))
  let available = false

  try {
    const target = join(dir, 'target')
    const link = join(dir, 'link')

    if (kind === 'file') {
      writeFileSync(target, '')
      symlinkSync(target, link, 'file')
    } else {
      mkdirSync(target)
      symlinkSync(target, link)
    }

    available = existsSync(link)
  } catch {
    available = false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  cached.set(kind, available)
  return available
}
