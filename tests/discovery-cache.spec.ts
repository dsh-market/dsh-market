import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDiscoveryCache, type CacheEntry } from '../src/discovery-cache.ts'
import { DiscoveryManifestIndex, manifestFacts } from '../src/discovery-compatibility.ts'
import { apply } from '../src/index.ts'
import * as net from '../src/net.ts'
import type { MarketHost } from '../src/routes.ts'

const HEADER = '{"schema":"dsh-market/discovery-compatibility-cache/v2"}\n'
const REGISTRY = 'https://registry.example'

function entry(checkedAt: number, version = '1.0.0'): CacheEntry {
  return { checkedAt, facts: manifestFacts({ version }) }
}

function row(name: string, record: CacheEntry): string {
  return JSON.stringify([name, record]) + '\n'
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('discovery cache journal', () => {
  let directory: string
  let file: string
  let journal: string
  let indexes: DiscoveryManifestIndex[]
  const newIndex = (options: ConstructorParameters<typeof DiscoveryManifestIndex>[1] = {}): DiscoveryManifestIndex => {
    const index = new DiscoveryManifestIndex(file, options)
    indexes.push(index)
    return index
  }

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'dshm-cache-journal-'))
    file = join(directory, 'compatibility.json')
    journal = file + '.journal'
    indexes = []
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const index of indexes) await index.dispose()
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('migrates an old cache only when there is a new result and retains timestamps', async () => {
    const original = JSON.stringify({
      schema: 'dsh-market/discovery-compatibility-cache/v1',
      entries: { 'old-plugin': { checkedAt: 900, facts: { version: '1.0.0', enginesDsh: null, peerDependencies: {} } } },
    })
    await fs.writeFile(file, original)
    const fetcher = vi.fn(async () => Response.json({ version: '2.0.0' }))
    const index = newIndex({ fetcher, now: () => 1_000 })

    expect((await index.lookup(['old-plugin'], REGISTRY))['old-plugin']).toEqual(entry(900).facts)
    expect(await fs.readdir(directory)).toEqual(['compatibility.json'])
    expect(fetcher).not.toHaveBeenCalled()
    await index.lookup(['new-plugin'], REGISTRY)
    await index.dispose()

    expect(await fs.readFile(file, 'utf8')).toBe(original)
    expect(await fs.readFile(journal, 'utf8')).toBe(HEADER + row('old-plugin', entry(900)) + row('new-plugin', entry(1_000, '2.0.0')))
    // Once published, nothing from the retired v1 file is merged back.
    await fs.writeFile(file, original.replace('1.0.0', '99.0.0'))
    const replacement = newIndex({ fetcher, now: () => 1_001 })
    expect((await replacement.lookup(['old-plugin', 'new-plugin'], REGISTRY))['old-plugin']?.version).toBe('1.0.0')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('appends only changed keys and coalesces multiple replacements of a key', async () => {
    const initial = HEADER + row('unchanged', entry(1))
    await fs.writeFile(journal, initial)
    const cache = openDiscoveryCache(file, raw => raw as CacheEntry)
    await cache.get('unchanged')
    cache.set('new', entry(2))
    cache.set('new', entry(3, '2.0.0'))
    cache.set('new', entry(2, '9.0.0'))
    await cache.release()

    expect(await fs.readFile(journal, 'utf8')).toBe(initial + '\n' + row('new', entry(3, '2.0.0')))
  })

  it('answers during a blocked append and persists updates from a remounted index', async () => {
    const initial = HEADER + row('seed', entry(1))
    await fs.writeFile(journal, initial)
    const started = deferred()
    const unblock = deferred()
    const append = fs.appendFile.bind(fs)
    vi.spyOn(fs, 'appendFile').mockImplementationOnce(async (...args) => {
      started.resolve()
      await unblock.promise
      await append(...args)
    })
    const closingIndex = newIndex({
      fetcher: async () => Response.json({ version: '1.0.0' }), now: () => 1_000, ttlMs: 100,
    })
    await closingIndex.lookup(['same'], REGISTRY)
    const closing = closingIndex.dispose()
    const fetcher = vi.fn(async () => Response.json({ version: '2.0.0' }))
    try {
      await started.promise
      const replacement = newIndex({ fetcher, now: () => 2_000, ttlMs: 100 })
      expect((await replacement.lookup(['same', 'extra'], REGISTRY)).same?.version).toBe('2.0.0')
      expect(await fs.readFile(journal, 'utf8')).toBe(initial)
      unblock.resolve()
      await closing
      await replacement.dispose()
    } finally {
      unblock.resolve()
      await closing
    }
    const restarted = newIndex({ fetcher, now: () => 2_001, ttlMs: 100 })
    expect((await restarted.lookup(['same', 'extra'], REGISTRY)).same?.version).toBe('2.0.0')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('backs off after a partial append and replays the retry across restart', async () => {
    const initial = HEADER + row('seed', entry(1))
    await fs.writeFile(journal, initial)
    const append = fs.appendFile.bind(fs)
    const failed = deferred()
    const retried = deferred()
    const spy = vi.spyOn(fs, 'appendFile')
      .mockImplementationOnce(async path => {
        await append(path, '\n["cut record')
        failed.resolve()
        throw new Error('test partial write')
      })
      .mockImplementationOnce(async (...args) => {
        await append(...args)
        retried.resolve()
      })
    const fetcher = vi.fn(async () => Response.json({ version: '2.0.0' }))
    const index = newIndex({ fetcher, now: () => 100 })

    expect((await index.lookup(['fresh'], REGISTRY)).fresh?.version).toBe('2.0.0')
    await failed.promise
    expect(spy).toHaveBeenCalledTimes(1)
    expect((await index.lookup(['fresh'], REGISTRY)).fresh?.version).toBe('2.0.0')
    await retried.promise
    await index.dispose()

    const restarted = newIndex({ fetcher, now: () => 101 })
    expect(await restarted.lookup(['seed', 'fresh'], REGISTRY)).toEqual({
      seed: entry(1).facts, fresh: entry(100, '2.0.0').facts,
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('retains a failed pending write between consecutive mounts', async () => {
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('test cache locked on unmount'))
    const before = newIndex({ fetcher: async () => Response.json({ version: '1.0.0' }) })
    await before.lookup(['pending'], REGISTRY)
    await before.dispose()
    expect(await fs.readdir(directory)).toEqual([])

    const fetcher = vi.fn(async () => Response.json({ version: '2.0.0' }))
    const after = newIndex({ fetcher })
    expect((await after.lookup(['pending'], REGISTRY)).pending?.version).toBe('1.0.0')
    await after.dispose()
    expect(fetcher).not.toHaveBeenCalled()
    expect(await fs.readFile(journal, 'utf8')).toContain('"pending"')
  })

  it('awaits queued compatibility writes when Cordis unloads the market plugin', async () => {
    const store = join(directory, '.dsh-market')
    const cacheFile = join(store, 'discovery-compatibility-v1.json.journal')
    await fs.mkdir(store)
    await fs.writeFile(join(store, 'state.json'), JSON.stringify({ region: 'global', regionAuto: false }))
    const started = deferred()
    const unblock = deferred()
    const write = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (args[0] === cacheFile + '.tmp') {
        started.resolve()
        await unblock.promise
      }
      await write(...args)
    })
    vi.spyOn(net, 'marketFetch').mockImplementation(async () => Response.json({ version: '1.0.0' }))
    const routes = new Map<string, Parameters<MarketHost['webServer']['register']>[0]['handler']>()
    const webServer: MarketHost['webServer'] = {
      register(route) {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    }
    const root = new Context()
    root.provide('webServer', webServer)
    root.provide('loader', { entries: () => [] })
    root.provide('profileContext', { name: 'web', dir: directory })
    const plugin = root.plugin(ctx => apply(ctx))
    const path = '/dsh-market/discovery-compatibility'
    try {
      await plugin.await()
      const request = Readable.from([Buffer.from(JSON.stringify({ packages: ['queued-plugin'] }))]) as IncomingMessage
      request.method = 'POST'
      request.url = path
      request.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
      const response = { writeHead: vi.fn(), end: vi.fn() }
      await routes.get(path)!(request, response as unknown as ServerResponse)
      expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object))

      let unloaded = false
      const unloading = Promise.resolve(plugin.dispose()).then(() => { unloaded = true })
      try {
        await started.promise
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(routes.has(path)).toBe(false)
        expect(unloaded).toBe(false)
      } finally {
        unblock.resolve()
        await unloading
      }
      expect(await fs.readFile(cacheFile, 'utf8')).toContain('queued-plugin')
    } finally {
      unblock.resolve()
      await root.fiber.dispose()
    }
  })

  it('leaves the old journal intact if compaction fails, then retains the newest 20,000 rows', async () => {
    const initial = HEADER + Array.from({ length: 40_000 }, (_, i) => row('plugin-' + String(i), entry(i))).join('')
    await fs.writeFile(journal, initial)
    const rename = fs.rename.bind(fs)
    const failed = deferred()
    const retried = deferred()
    vi.spyOn(fs, 'rename')
      .mockImplementationOnce(async () => {
        failed.resolve()
        throw new Error('test interrupted publication')
      })
      .mockImplementationOnce(async (...args) => {
        await rename(...args)
        retried.resolve()
      })
    const fetcher = vi.fn(async () => Response.json({ version: '2.0.0' }))
    const index = newIndex({ fetcher, now: () => 50_000 })
    expect((await index.lookup(['new'], REGISTRY)).new?.version).toBe('2.0.0')

    await failed.promise
    expect(await fs.readFile(journal, 'utf8')).toBe(initial)
    await retried.promise
    await index.dispose()

    const compacted = (await fs.readFile(journal, 'utf8')).split('\n').filter(Boolean)
    expect(compacted).toHaveLength(20_001)
    expect(compacted).not.toContain(row('plugin-20000', entry(20_000)).trim())
    expect(compacted).toContain(row('plugin-20001', entry(20_001)).trim())
    const restarted = newIndex({ fetcher, now: () => 50_001 })
    expect(await restarted.lookup(['new', 'plugin-39999'], REGISTRY)).toEqual({
      new: entry(50_000, '2.0.0').facts, 'plugin-39999': entry(39_999).facts,
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
