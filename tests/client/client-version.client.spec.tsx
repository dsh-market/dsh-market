// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { compareMarketVersions, readMarketJson, serverIsBehind } from '../../src/client/client-version.ts'
import { AiRecommend } from '../../src/client/AiRecommend.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('tells a server older than the page apart from an equal or newer one', () => {
  expect(compareMarketVersions('1.78.0', '1.76.1')).toBe(1)
  expect(compareMarketVersions('1.10.0', '1.9.9')).toBe(1)
  expect(compareMarketVersions('v1.2.3', '1.2.3')).toBe(0)
  expect(compareMarketVersions('x', '1.2.3')).toBeNull()
  expect(serverIsBehind('1.76.1', '1.78.0')).toBe(true)
  expect(serverIsBehind('1.78.0', '1.78.0')).toBe(false)
  expect(serverIsBehind('1.79.0', '1.78.0')).toBe(false)
  // Unknown on either side: never claim a mismatch.
  expect(serverIsBehind(null, '1.78.0')).toBe(false)
  expect(serverIsBehind('1.76.1', null)).toBe(false)
})

it('reads the empty 405 a host sends for a route this server lacks as stale-server, not a parse error', async () => {
  expect((await readMarketJson(new Response(null, { status: 405 }))).body.code).toBe('stale-server')
  expect((await readMarketJson(new Response('', { status: 404 }))).body.code).toBe('stale-server')
  expect((await readMarketJson(new Response('<html>', { status: 502 }))).body.code).toBe('bad-reply')
  expect((await readMarketJson(new Response('{"result":1}', { status: 200 }))).body).toEqual({ result: 1 })
})

it('says the server is still the old version when the recommendation route is missing', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 405 }))))
  render(<AiRecommend t={(k: string) => k} lang="zh" plugins={[]} render={() => null} />)
  fireEvent.click(screen.getByRole('button', { name: 'recTrigger' }))
  await waitFor(() => screen.getByText('staleServer'))
  expect(screen.queryByText(/JSON/)).toBeNull()
  expect(screen.queryByRole('button', { name: 'recRetry' })).toBeNull()
})
