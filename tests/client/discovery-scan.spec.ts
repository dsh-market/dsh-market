import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiscoveryScan } from '../../src/client/discovery-scan.ts'
import type { Registry, RegistryPlugin } from '../../src/client/market-data.ts'

function catalog(size: number): Registry {
  const plugins = Array.from({ length: size }, (_, i) => ({
    name: { zh: `p${i}`, en: `p${i}` }, npm: `dsh-plugin-${i}`, version: '1.0.0', url: `https://github.com/x/p${i}`,
  })) as unknown as RegistryPlugin[]
  return { updated: 'u1', count: size, categories: {}, plugins }
}

async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve() }

describe('DiscoveryScan on-demand lookups (#1162)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('shows a preview before the full catalog and retries only the interrupted page', async () => {
    const registry = catalog(4)
    const calls: number[] = []
    let release = () => {}
    const wait = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const page = Number(new URL(url, 'http://localhost').searchParams.get('page') ?? 0)
      const alreadyRequested = calls.includes(page)
      calls.push(page)
      if (page === 1) {
        await wait
        if (!alreadyRequested) return new Response('{"registry":', { status: 200 })
      }
      return Response.json({
        registry: { ...registry, plugins: registry.plugins.slice(page, page + 1) },
        hostVersion: '0.2.2', snapshot: 'test-snapshot', page, pages: 4,
      })
    }))
    const scan = new DiscoveryScan(() => {})
    const loading = scan.resume()
    try {
      await vi.waitFor(() => expect(scan.getSnapshot()).toMatchObject({
        catalog: null, catalogPreview: { plugins: registry.plugins.slice(0, 1) },
      }))
    } finally {
      release()
      await loading
    }
    expect(calls.sort()).toEqual([0, 1, 1, 2, 3])
    expect(scan.getSnapshot()).toMatchObject({ catalog: registry, catalogPreview: null })
  })

  it('keeps the preview and successful pages when a single page exhausts retries', async () => {
    const registry = catalog(3)
    const calls: number[] = []
    let interrupted = true
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const page = Number(new URL(url, 'http://localhost').searchParams.get('page') ?? 0)
      calls.push(page)
      if (page === 1 && interrupted) return Response.json({ error: 'proxy unavailable' }, { status: 502 })
      return Response.json({
        registry: { ...registry, plugins: registry.plugins.slice(page, page + 1) },
        snapshot: 'test-snapshot', page, pages: 3,
      })
    }))
    const scan = new DiscoveryScan(() => {})
    await expect(scan.resume()).rejects.toThrow('proxy unavailable')
    expect(scan.getSnapshot()).toMatchObject({
      catalog: null, catalogPreview: { plugins: registry.plugins.slice(0, 1) },
    })
    interrupted = false
    calls.length = 0
    await expect(scan.resume()).resolves.toBe('loaded')
    expect(calls).toEqual([1])
    expect(scan.getSnapshot()).toMatchObject({ catalog: registry, catalogPreview: null })
  })

  it('sends one POST for the first page of a 10k catalog and only the new rows for the next', async () => {
    const posts: string[][] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith('/registry')) {
        return new Response(JSON.stringify({ registry: catalog(10_000), hostVersion: '0.2.2' }), { status: 200 })
      }
      const body = JSON.parse(init?.body ?? '{}') as { packages: string[] }
      posts.push(body.packages)
      const plugins = Object.fromEntries(body.packages.map(name => [name, {
        status: 'compatible', basis: 'manifest', requirement: '>=0.2.0', declarations: [],
      }]))
      return new Response(JSON.stringify({ hostVersion: '0.2.2', plugins }), { status: 200 })
    }))
    const scan = new DiscoveryScan(() => {})
    scan.reset()
    scan.setEnabled(true)
    await scan.resume()
    const data = scan.getSnapshot().catalog!
    const owner = {}
    scan.setDemand(owner, data, data.plugins.slice(0, 32).map(plugin => plugin.npm as string))
    await settle()
    expect(posts).toHaveLength(1)
    expect(posts[0]).toHaveLength(32)
    expect(Object.keys(scan.getSnapshot().verdicts)).toHaveLength(32)
    scan.setDemand(owner, data, data.plugins.slice(32, 56).map(plugin => plugin.npm as string))
    await settle()
    expect(posts.map(batch => batch.length)).toEqual([32, 24])
  })
})
