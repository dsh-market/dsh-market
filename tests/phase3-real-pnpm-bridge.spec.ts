/**
 * Optional real-pnpm, localhost-only approximation of the official Desktop
 * in-process plugin manager. Run with DSHM_991_PNPM_CLI=<pnpm 11 bin/pnpm.cjs>
 * in a Windows environment permitted to create pnpm's node_modules links.
 * The manager here is a shim, not the actual Electron/Desktop manager.
 */
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveDesktopMatureUpdate, setUpdateRegistry } from '../src/updates.ts'
import { createOfficialDesktopRuntime, type OfficialPluginManagerLike } from '../src/official-desktop.ts'

const cli = process.env.DSHM_991_PNPM_CLI
const run = (bin: string, args: string[], cwd: string, env = process.env) => new Promise<{ code: number | null; output: string }>((ok, fail) => {
  const child = spawn(bin, args, { cwd, env, windowsHide: true })
  let output = ''
  child.stdout.on('data', data => { output += String(data) })
  child.stderr.on('data', data => { output += String(data) })
  child.on('error', fail)
  child.on('close', code => ok({ code, output }))
})

describe.skipIf(cli === undefined)('Issue #991 real pnpm 11 via Desktop manager contract', () => {
  const name = 'dsh-991-fixture'
  const versions = ['1.0.0', '1.1.0', '1.2.0']
  let dir: string
  let base: string
  let registry: string
  let server: Server
  const tarballs = new Map<string, Buffer>()

  beforeAll(async () => {
    base = await mkdtemp(join(process.cwd(), '.research-991-bridge-'))
    dir = join(base, 'profile')
    await mkdir(dir, { recursive: true })
    for (const version of versions) {
      const packageDir = join(base, `tar-${version}`, 'package')
      await mkdir(packageDir, { recursive: true })
      await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name, version, dsh: {}, main: 'index.js' }))
      await writeFile(join(packageDir, 'index.js'), `module.exports=${JSON.stringify(version)}\n`)
      const archive = join(base, `${name}-${version}.tgz`)
      const result = await run('tar', ['-czf', archive, '-C', join(base, `tar-${version}`), 'package'], dir)
      if (result.code !== 0) throw new Error(`tar failed: ${result.output}`)
      tarballs.set(version, await readFile(archive))
    }
    server = createServer((req, res) => {
      const pathname = decodeURIComponent((req.url ?? '').split('?')[0])
      const match = new RegExp(`^/${name}/-/${name}-(\\d+\\.\\d+\\.\\d+)\\.tgz$`).exec(pathname)
      if (match && tarballs.has(match[1]!)) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(tarballs.get(match[1]!))
        return
      }
      const pack = Object.fromEntries(versions.map(version => [version, {
        name, version, dist: { tarball: `${registry}/${name}/-/${name}-${version}.tgz` },
      }]))
      if (pathname === `/${name}`) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ name, versions: pack, 'dist-tags': { latest: '1.2.0' },
          time: { '1.0.0': '2026-09-01T00:00:00.000Z', '1.1.0': '2026-09-02T00:00:00.000Z', '1.2.0': new Date().toISOString() } }))
        return
      }
      if (pathname.startsWith(`/${name}/`) && pack[pathname.slice(name.length + 2)]) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(pack[pathname.slice(name.length + 2)]))
        return
      }
      res.writeHead(404); res.end('not found')
    })
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
    registry = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-991-isolated-desktop', private: true }))
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    await writeFile(join(dir, '.npmrc'), `registry=${registry}/\nstore-dir=${join(base, 'store').replace(/\\/g, '/')}\n`)
  })
  afterAll(async () => {
    setUpdateRegistry('https://registry.npmjs.org')
    if (server) await new Promise<void>((ok, fail) => server.close(error => error ? fail(error) : ok()))
    if (base) await rm(base, { recursive: true, force: true })
  })

  it.each([
    ['default', 'packages:\n  - .\n'],
    ['strict false', 'packages:\n  - .\nminimumReleaseAgeStrict: false\n'],
    ['ignore missing time', 'packages:\n  - .\nminimumReleaseAgeIgnoreMissingTime: true\n'],
  ])('verifies mature exact pin through manager reinstall with %s policy (#991 approved)', async (_label, policy) => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), policy)
    setUpdateRegistry(registry)
    const selected = await resolveDesktopMatureUpdate(name, '1.0.0', 'desktop', dir, '1.2.0')
    expect(selected.candidate).toBe('1.1.0')

    const sandboxHome = join(base, 'home')
    await mkdir(sandboxHome, { recursive: true })
    const env = { ...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome, APPDATA: sandboxHome,
      LOCALAPPDATA: sandboxHome, XDG_CONFIG_HOME: sandboxHome, XDG_CACHE_HOME: sandboxHome,
      npm_config_userconfig: join(dir, '.npmrc'), npm_config_registry: `${registry}/`, PNPM_HOME: sandboxHome,
      npm_config_store_dir: join(base, 'store'), COREPACK_ENABLE_AUTO_PIN: '0' }
    const pnpm = async (args: string[]) => run(process.execPath, [resolve(cli!), ...args,
      ...(args[0] === 'add' ? ['--ignore-scripts'] : []),
      `--config.store-dir=${join(base, 'store')}`], dir, env)
    const first = await pnpm(['add', `${name}@1.0.0`])
    expect(first.code, first.output).toBe(0)
    const beforePolicy = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    const calls: string[] = []
    const manager: OfficialPluginManagerLike = {
      installBundle: async (spec) => {
        calls.push(spec)
        const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
        if (manifest.dependencies?.[name] !== undefined) return { application: 'failed', error: { code: 'already-installed' } }
        const result = await pnpm(['add', spec])
        return result.code === 0
          ? { application: 'applied', packageResult: { exitCode: 0, output: result.output } }
          : { application: 'failed', error: result.output, packageResult: { exitCode: result.code, output: result.output } }
      },
      removeBundle: async (packageName) => {
        calls.push(`remove ${packageName}`)
        const result = await pnpm(['remove', packageName])
        return result.code === 0
          ? { application: 'applied', packageResult: { exitCode: 0, output: result.output } }
          : { application: 'failed', error: result.output, packageResult: { exitCode: result.code, output: result.output } }
      },
      cancelInstall: async () => {},
    }
    const runtime = createOfficialDesktopRuntime(() => manager, 'desktop', dir)
    try {
      const result = await runtime.runPlugin('desktop', ['add', `${name}@1.1.0`])
      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0)
      expect(calls).toEqual([`${name}@1.1.0`, `remove ${name}`, `${name}@1.1.0`])
      expect(calls.join(' ')).not.toContain('@latest')
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
      const installed = JSON.parse(await readFile(join(dir, 'node_modules', name, 'package.json'), 'utf8')) as { version: string }
      const lock = await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8')
      expect(manifest.dependencies[name]).toBe('1.1.0')
      expect(installed.version).toBe('1.1.0')
      expect(lock).toContain(`${name}@1.1.0`)
      expect(lock).not.toContain(`${name}@1.2.0`)
      expect(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(beforePolicy)
    } finally {
      await runtime.dispose()
      setUpdateRegistry('https://registry.npmjs.org')
    }
  }, 90_000)
})
