/**
 * An interrupted desktop update must not leave the profile without its plugin.
 *
 * The desktop manager's update is remove-then-install (#896), and a host that
 * never answers leaves the removal on disk (#928). These specs pin the two
 * halves that make the next start whole again: the journal is durable before
 * the removal, and the repair reads the disk — not the interrupted call's
 * intent — to decide whether to finish or leave things alone.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withIdleProfile, withIdleProfileAsync } from '../src/pending-checkout-links.ts'
import {
  DeadlineExceeded,
  PendingUpdateJournal,
  clearStaleProfileLock,
  pendingUpdatesFile,
  MAX_AUTO_REPAIR_ATTEMPTS,
  repairInterruptedUpdates,
  withDeadline,
} from '../src/pending-updates.ts'

const roots: string[] = []

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-pending-'))
  roots.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: {} }))
  return dir
}

/** Declare a package in the profile manifest, the way the manager would. */
function declare(dir: string, name: string, range = '^1.0.0'): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { [name]: range } }))
}

/** Put a package in the profile's node_modules, the way pnpm would have. */
function install(dir: string, name: string, version: string, dsh?: Record<string, unknown>): void {
  const packageDir = join(dir, 'node_modules', name)
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version, ...(dsh === undefined ? {} : { dsh }) }))
}

/** Add a package to `dsh.profile.bundles`, the way the host's manager would. */
function bundle(dir: string, name: string): void {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } }
  }
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const bundles = manifest.dsh.profile.bundles ?? []
  if (!bundles.includes(name)) bundles.push(name)
  manifest.dsh.profile.bundles = bundles
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
}

function manager(installBundle: (spec: string) => Promise<{ application: string }>): {
  installBundle: ReturnType<typeof vi.fn>
} {
  return { installBundle: vi.fn(installBundle) }
}

afterEach(() => {
  vi.useRealTimers()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the desktop profile writer during a market overlay (#1328)', () => {
  it('holds the host lock until the asynchronous write settles and allows the next writer', async () => {
    const dir = profile()
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const write = withIdleProfileAsync(dir, async () => { await gate; return 'updated' })
    try {
      expect(readFileSync(join(dir, 'package.json.lock'), 'utf8')).toBe(`${process.pid}\n`)
      const competingWrite = vi.fn()
      expect(withIdleProfile(dir, competingWrite)).toBeNull()
      expect(await withIdleProfileAsync(dir, competingWrite)).toBeNull()
      expect(competingWrite).not.toHaveBeenCalled()
    } finally {
      finish()
      await write
    }
    await expect(write).resolves.toBe('updated')
    expect(withIdleProfile(dir, () => 'idle')).toBe('idle')
  })

  it('leaves a host writer alone and also checks its unfinished pnpm run under the lock', async () => {
    const dir = profile()
    const lock = join(dir, 'package.json.lock')
    writeFileSync(lock, `${process.pid}\n`)
    const write = vi.fn()
    expect(await withIdleProfileAsync(dir, write)).toBeNull()
    expect(readFileSync(lock, 'utf8')).toBe(`${process.pid}\n`)
    rmSync(lock)

    mkdirSync(join(dir, '.plugin-manager'))
    writeFileSync(join(dir, '.plugin-manager', 'run.json'), JSON.stringify({ pid: process.pid, grouped: false }))
    expect(await withIdleProfileAsync(dir, write)).toBeNull()
    expect(write).not.toHaveBeenCalled()
    expect(withIdleProfile(dir, () => 'released')).toBe('released')
  })

  it('releases the profile when the asynchronous write rejects', async () => {
    const dir = profile()
    const error = new Error('overlay failed')
    await expect(withIdleProfileAsync(dir, () => Promise.reject(error))).rejects.toBe(error)
    await expect(withIdleProfileAsync(dir, () => Promise.resolve('retried'))).resolves.toBe('retried')
  })
})

describe('the pending-update journal', () => {
  it('remembers a removal across a restart and upserts a retry of the same package', () => {
    const dir = profile()
    const file = pendingUpdatesFile(dir)
    const first = new PendingUpdateJournal(file)
    const record = first.begin({ profile: 'desktop', name: 'example', from: '1.0.0', to: '2.0.0', spec: 'example@2.0.0' })

    // A brand-new instance stands in for the next process.
    const next = new PendingUpdateJournal(file)
    expect(next.list()).toMatchObject([{ name: 'example', from: '1.0.0', to: '2.0.0', step: 'removing' }])

    const retried = next.begin({ profile: 'desktop', name: 'example', from: '1.0.0', to: '2.0.1', spec: 'example@2.0.1' })
    expect(retried.id).toBe(record.id)
    expect(next.list()).toHaveLength(1)
    expect(next.list()[0]).toMatchObject({ to: '2.0.1' })

    next.mark(record.id, 'installing')
    next.finish(record.id)
    expect(new PendingUpdateJournal(file).list()).toEqual([])
  })

  it('forgets a package when the user uninstalls it explicitly', () => {
    const dir = profile()
    const journal = new PendingUpdateJournal(pendingUpdatesFile(dir))
    journal.begin({ profile: 'desktop', name: 'example', from: '1.0.0', to: '2.0.0', spec: 'example@2.0.0' })
    journal.begin({ profile: 'desktop', name: 'other', from: '1.0.0', to: '2.0.0', spec: 'other@2.0.0' })

    journal.forget('desktop', 'example')

    expect(journal.list()).toMatchObject([{ name: 'other' }])
  })

  it('treats an unreadable journal as empty instead of failing the update', () => {
    const dir = profile()
    const file = pendingUpdatesFile(dir)
    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
    writeFileSync(file, '{"version":1,"operations":[')
    expect(new PendingUpdateJournal(file).list()).toEqual([])
  })
})

describe('repairing an update a previous start interrupted', () => {
  it('puts back a package whose removal won and whose install never ran', async () => {
    const dir = profile()
    const journal = new PendingUpdateJournal(pendingUpdatesFile(dir))
    const record = journal.begin({ profile: 'desktop', name: 'example', from: '1.0.0', to: '2.0.0', spec: 'example@2.0.0' })
    journal.mark(record.id, 'installing')

    const service = manager(async (spec) => {
      expect(spec).toBe('example@2.0.0')
      install(dir, 'example', '2.0.0')
      return { application: 'applied' }
    })
    const report = await repairInterruptedUpdates({ profile: 'desktop', profileDirectory: dir, manager: service })

    expect(service.installBundle).toHaveBeenCalledWith('example@2.0.0', { requestId: expect.any(String) })
    expect(report.reinstalled).toEqual(['example'])
    expect(report.failed).toEqual([])
    expect(journal.list()).toEqual([])
  })

  it('clears the record when the previous build is still installed and declared', async () => {
    const dir = profile()
    install(dir, 'example', '1.0.0')
    declare(dir, 'example')
    const journal = new PendingUpdateJournal(pendingUpdatesFile(dir))
    journal.begin({ profile: 'desktop', name: 'example', from: '1.0.0', to: '2.0.0', spec: 'example@2.0.0' })

    const service = manager(async () => {
      throw new Error('the profile already holds a settled version')
    })
    const report = await repairInterruptedUpdates({ profile: 'desktop', profileDirectory: dir, manager: service })

    expect(service.installBundle).not.toHaveBeenCalled()
    expect(report.finished).toEqual(['example'])
    expect(journal.list()).toEqual([])
  })

  it('clears the record when the requested build did land before the answer was lost', async () => {
    const dir = profile()
    install(dir, 'example', '2.0.0')
    declare(dir, 'example')
    const journal = new PendingUpdateJournal(pendingUpdatesFile(dir))
    journal.begin({ profile: 'desktop', name: 'example', from: '1.0.0', to: '2.0.0', spec: 'example@2.0.0' })

    const service = manager(async () => {
      throw new Error('nothing to do')
    })
    const report = await repairInterruptedUpdates({ profile: 'desktop', profileDirectory: dir, manager: service })

    expect(report.finished).toEqual(['example'])
    expect(journal.list()).toEqual([])
  })

  it('records a written build as finished even when only the live start failed', async () => {
    // The manager reports `failed` for an application stage that follows a
    // successful pnpm run. When the build is on disk, the next start loads it;
    // keeping the record would repair a profile that is already whole.
    const dir = profile()
    const journal = new PendingUpdateJournal(pendingUpdatesFile(dir))
    journal.begin({ profile: 'desktop', name: 'example', from: '1.0.0', to: '2.0.0', spec: 'example@2.0.0' })

    const service = manager(async () => {
      // A pnpm add writes the manifest and the files together; only a
      // package with a BUNDLE layer can be written without being composed,
      // which is the case the next test covers.
      install(dir, 'example', '2.0.0')
      declare(dir, 'example')
      return { application: 'failed' }
    })
    const report = await repairInterruptedUpdates({ profile: 'desktop', profileDirectory: dir, manager: service })

    expect(report.reinstalled).toEqual(['example'])
    expect(report.failed).toEqual([])
    expect(journal.list()).toEqual([])
  })

  it('keeps the record when the app wrote the files but not the bundle declaration (#928)', async () => {
    // The reporter's second state, reproduced through the manager: the build
    // lands on disk and the dependency is written, but `dsh.profile.bundles`
    // never gets the name — so the host composes nothing. Reading "a version
    // is on disk" as settled cleared the record and logged "recorded as
    // finished" while the plugin still did not load, leaving nothing to
    // repair it on the next start.
    const dir = profile()
    install(dir, 'example', '2.0.0', { bundle: { patch: './cordis.patch.yml' } })
    const journal = new PendingUpdateJournal(pendingUpdatesFile(dir))
    journal.begin({ profile: 'desktop', name: 'example', from: '1.0.0', to: '2.0.0', spec: 'example@2.0.0' })

    const service = manager(async () => {
      declare(dir, 'example')
      return { application: 'failed' }
    })
    const report = await repairInterruptedUpdates({ profile: 'desktop', profileDirectory: dir, manager: service })

    expect(report.finished).toEqual([])
    expect(report.failed).toHaveLength(1)
    expect(journal.list()).toMatchObject([{ name: 'example', attempts: 1 }])
  })

  it('repairs a bundle-layer package whose row went missing even though the files are right (#928)', async () => {
    // The other half of the same rule: the settled check itself has to look
    // at the composition, not only at node_modules. Files at the requested
    // version plus a dependency, but no bundle row, is not a loaded plugin.
    const dir = profile()
    install(dir, 'example', '2.0.0', { bundle: { patch: './cordis.patch.yml' } })
    declare(dir, 'example')
    const journal = new PendingUpdateJournal(pendingUpdatesFile(dir))
    journal.begin({ profile: 'desktop', name: 'example', from: '1.0.0', to: '2.0.0', spec: 'example@2.0.0' })

    const service = manager(async () => {
      bundle(dir, 'example')
      return { application: 'applied' }
    })
    const report = await repairInterruptedUpdates({ profile: 'desktop', profileDirectory: dir, manager: service })

    expect(service.installBundle).toHaveBeenCalledTimes(1)
    expect(report.reinstalled).toEqual(['example'])
    expect(journal.list()).toEqual([])
  })

  it('leaves a client-only package settled without a bundle row (#928)', async () => {
    // Only the bundle layer composes through `dsh.profile.bundles`; requiring
    // the row for every package would reinstall client-only plugins on every
    // start.
    const dir = profile()
    install(dir, 'example', '2.0.0', { client: { inject: [] } })
    declare(dir, 'example')
    const journal = new PendingUpdateJournal(pendingUpdatesFile(dir))
    journal.begin({ profile: 'desktop', name: 'example', from: '1.0.0', to: '2.0.0', spec: 'example@2.0.0' })

    const service = manager(async () => ({ application: 'applied' }))
    const report = await repairInterruptedUpdates({ profile: 'desktop', profileDirectory: dir, manager: service })

    expect(service.installBundle).not.toHaveBeenCalled()
    expect(report.finished).toEqual(['example'])
    expect(journal.list()).toEqual([])
  })

  it('keeps the record when the reinstall fails, so a later start tries again', async () => {
    const dir = profile()
    const journal = new PendingUpdateJournal(pendingUpdatesFile(dir))
    journal.begin({ profile: 'desktop', name: 'example', from: '1.0.0', to: '2.0.0', spec: 'example@2.0.0' })

    const service = manager(async () => ({ application: 'failed' }))
    const report = await repairInterruptedUpdates({ profile: 'desktop', profileDirectory: dir, manager: service })

    expect(report.reinstalled).toEqual([])
    expect(report.failed).toHaveLength(1)
    expect(journal.list()).toMatchObject([{ name: 'example', attempts: 1 }])
  })

  it('reinstalls when the build is on disk but the profile no longer declares it (#928 half-removal)', async () => {
    // The interrupted removal wrote the manifest and never ran the install:
    // node_modules still holds the OLD build, and the profile declares
    // nothing. Treating "a version is installed" as settled cleared the
    // record while the plugin was not composed at all.
    const dir = profile()
    install(dir, 'example', '1.0.0')
    const journal = new PendingUpdateJournal(pendingUpdatesFile(dir))
    journal.begin({ profile: 'desktop', name: 'example', from: '1.0.0', to: '2.0.0', spec: 'example@2.0.0' })

    const service = manager(async (spec) => {
      expect(spec).toBe('example@2.0.0')
      install(dir, 'example', '2.0.0')
      declare(dir, 'example')
      return { application: 'applied' }
    })
    const report = await repairInterruptedUpdates({ profile: 'desktop', profileDirectory: dir, manager: service })

    expect(service.installBundle).toHaveBeenCalledTimes(1)
    expect(report.reinstalled).toEqual(['example'])
    expect(journal.list()).toEqual([])
  })

  it('finishes the interrupted removal, then installs, when the manager says already-installed (#1259)', async () => {
    // The update died after its removal began: the dependency and the build
    // are still there, but the bundle row is gone, so the profile is not
    // composed. `add` is refused outright on this host (#896).
    const dir = profile()
    declare(dir, 'example')
    install(dir, 'example', '1.0.0', { bundle: { patch: './cordis.patch.yml' } })
    const journal = new PendingUpdateJournal(pendingUpdatesFile(dir))
    journal.begin({ profile: 'desktop', name: 'example', from: '1.0.0', to: '2.0.0', spec: 'example@2.0.0' })

    const installBundle = vi.fn(async () => {
      if (installBundle.mock.calls.length === 1) {
        return { application: 'failed', error: Object.assign(new Error('already installed'), { code: 'already-installed' }) }
      }
      install(dir, 'example', '2.0.0', { bundle: { patch: './cordis.patch.yml' } })
      bundle(dir, 'example')
      return { application: 'applied' }
    })
    const removeBundle = vi.fn(async () => ({ application: 'applied' }))
    const report = await repairInterruptedUpdates({
      profile: 'desktop', profileDirectory: dir, manager: { installBundle, removeBundle },
    })

    expect(removeBundle).toHaveBeenCalledWith('example')
    expect(installBundle).toHaveBeenCalledTimes(2)
    expect(report.reinstalled).toEqual(['example'])
    expect(report.failed).toEqual([])
    expect(journal.list()).toEqual([])
  })

  it('does not call an install the old build survived "refused", and does not count it toward giving up (#1259)', async () => {
    const dir = profile()
    declare(dir, 'example')
    install(dir, 'example', '1.0.0', { bundle: { patch: './cordis.patch.yml' } })
    const journal = new PendingUpdateJournal(pendingUpdatesFile(dir))
    journal.begin({ profile: 'desktop', name: 'example', from: '1.0.0', to: '2.0.0', spec: 'example@2.0.0' })

    const service = manager(async () => {
      // Whatever the manager did, the old build ends up loaded again.
      bundle(dir, 'example')
      return { application: 'failed', error: Object.assign(new Error('x'), { code: 'install-failed' }) } as never
    })
    const report = await repairInterruptedUpdates({ profile: 'desktop', profileDirectory: dir, manager: service })

    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]).toMatchObject({ name: 'example', cause: 'kept-old' })
    expect(report.failed[0]?.reason).toContain('install-failed')
    expect(report.abandoned).toEqual([])
    expect(journal.list()).toEqual([])
  })

  it('names the manager error code when the removal itself is refused (#1259)', async () => {
    const dir = profile()
    declare(dir, 'example')
    install(dir, 'example', '1.0.0', { bundle: { patch: './cordis.patch.yml' } })
    const journal = new PendingUpdateJournal(pendingUpdatesFile(dir))
    journal.begin({ profile: 'desktop', name: 'example', from: '1.0.0', to: '2.0.0', spec: 'example@2.0.0' })
    const report = await repairInterruptedUpdates({
      profile: 'desktop', profileDirectory: dir,
      manager: {
        installBundle: async () => ({ application: 'failed', error: Object.assign(new Error('x'), { code: 'already-installed' }) }),
        removeBundle: async () => ({ application: 'failed', error: Object.assign(new Error('x'), { code: 'bundle-in-use' }) }),
      },
    })
    expect(report.failed[0]?.reason).toContain('bundle-in-use')
    expect(journal.list()).toMatchObject([{ attempts: 1 }])
  })

  it('clears a profile write lock whose owner is gone, and keeps a live one', () => {
    const dir = profile()
    const lock = join(dir, 'package.json.lock')
    writeFileSync(lock, String(process.pid))
    expect(clearStaleProfileLock(dir)).toBe(false)
    expect(readFileSync(lock, 'utf8')).toBe(String(process.pid))

    // A PID that cannot exist stands in for a host killed mid-update.
    writeFileSync(lock, '4294967294')
    expect(clearStaleProfileLock(dir)).toBe(true)
    expect(() => readFileSync(lock, 'utf8')).toThrow()
  })

  it('does not fight a version the user chose while the update was interrupted', async () => {
    const dir = profile()
    install(dir, 'example', '1.5.0')
    // A version the user chose is one the profile declares — that is what a
    // real install writes. Undeclared-but-on-disk is the interrupted removal,
    // covered by the half-removal test above.
    declare(dir, 'example', '^1.5.0')
    const journal = new PendingUpdateJournal(pendingUpdatesFile(dir))
    journal.begin({ profile: 'desktop', name: 'example', from: '1.0.0', to: '2.0.0', spec: 'example@2.0.0' })

    const service = manager(async () => {
      throw new Error('must not reinstall over an explicit choice')
    })
    const report = await repairInterruptedUpdates({ profile: 'desktop', profileDirectory: dir, manager: service })

    expect(service.installBundle).not.toHaveBeenCalled()
    expect(report.failed).toMatchObject([{ name: 'example', reason: expect.stringContaining('1.5.0') }])
    expect(journal.list()).toHaveLength(1)
  })

  it('stops retrying a package that failed on every start, and keeps the record (#1061)', async () => {
    // Each attempt may spend the full REPAIR_INSTALL_TIMEOUT_MS (5 min) before
    // giving up, on every boot, for a spec that will never install. The
    // reporter's machine paid that cost on the Desktop host's behalf for five
    // days without ever being told; the market's own record must not do the
    // same. Two failed starts keep retrying, the third ends it with a sentence
    // that says where to act.
    const dir = profile()
    const journal = new PendingUpdateJournal(pendingUpdatesFile(dir))
    journal.begin({ profile: 'desktop', name: 'example', from: '1.0.0', to: '2.0.0', spec: 'example@2.0.0' })
    const service = manager(async () => ({ application: 'failed' }))

    for (let start = 0; start < MAX_AUTO_REPAIR_ATTEMPTS - 1; start += 1) {
      const report = await repairInterruptedUpdates({ profile: 'desktop', profileDirectory: dir, manager: service })
      expect(report.failed).toHaveLength(1)
    }
    // The start that reaches the cap still tried.
    await repairInterruptedUpdates({ profile: 'desktop', profileDirectory: dir, manager: service })
    expect(service.installBundle).toHaveBeenCalledTimes(MAX_AUTO_REPAIR_ATTEMPTS)

    service.installBundle.mockClear()
    const report = await repairInterruptedUpdates({ profile: 'desktop', profileDirectory: dir, manager: service })

    expect(service.installBundle).not.toHaveBeenCalled()
    expect(report.failed).toMatchObject([{ name: 'example', reason: expect.stringContaining('重新安装') }])
    expect(journal.list()).toMatchObject([{ name: 'example', attempts: MAX_AUTO_REPAIR_ATTEMPTS }])
  })
})

describe('withDeadline', () => {
  it('ends the wait with a DeadlineExceeded instead of hanging on the manager', async () => {
    vi.useFakeTimers()
    const waiting = withDeadline(new Promise(() => {}), 1_000, 'remove example')
    const settled = expect(waiting).rejects.toBeInstanceOf(DeadlineExceeded)
    await vi.advanceTimersByTimeAsync(1_000)
    await settled
  })
})
