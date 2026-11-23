// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AiRecommend } from '../../src/client/AiRecommend.tsx'
import type { RegistryPlugin } from '../../src/client/market-data.ts'

const t = (key: string) => key
const plugin = (name: string): RegistryPlugin => ({ name, owner: 'o', url: `https://github.com/o/${name}`, category: 'x', description: { en: name }, npm: name, install: `dsh plugin add ${name}` } as RegistryPlugin)
const plugins = [plugin('a'), plugin('b'), plugin('c')]
const render_ = () => render(<AiRecommend t={t} lang="zh" plugins={plugins} render={items => <ul>{items.map(p => <li key={p.url}>{p.name}</li>)}</ul>} />)
const reply = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('does not reuse a cached recommendation made before exact source selection (#1290)', () => {
  localStorage.setItem('dshm-ai-recommend', JSON.stringify({ urls: ['https://github.com/o/b'] }))
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  render_()
  expect(screen.getByRole('button', { name: 'recTrigger' })).toBeTruthy()
  expect(screen.queryByText('b')).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
})

it('asks nothing until clicked, then draws the picks as catalog cards and keeps them', async () => {
  const fetch = vi.fn(() => reply(200, { result: { picks: [{ url: 'https://github.com/o/b' }, { url: 'https://github.com/o/zzz' }] } }))
  vi.stubGlobal('fetch', fetch)
  render_()
  expect(fetch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'recTrigger' }))
  await waitFor(() => expect(screen.getByText('b')).toBeTruthy())
  expect(screen.queryByText('zzz')).toBeNull()
  expect(JSON.parse(localStorage.getItem('dshm-ai-recommend')!).urls).toContain('https://github.com/o/b')
  cleanup()
  render_()
  expect(screen.getByText('b')).toBeTruthy()
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('"show others" sends the names just shown, and "close" forgets the set', async () => {
  const fetch = vi.fn(() => reply(200, { result: { picks: [{ url: 'https://github.com/o/a' }] } }))
  vi.stubGlobal('fetch', fetch)
  render_()
  fireEvent.click(screen.getByRole('button', { name: 'recTrigger' }))
  await waitFor(() => screen.getByText('a'))
  fireEvent.click(screen.getByRole('button', { name: 'recMore' }))
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  expect(JSON.parse((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).exclude).toEqual(['a'])
  await waitFor(() => screen.getByRole('button', { name: 'recClose' }))
  fireEvent.click(screen.getByRole('button', { name: 'recClose' }))
  expect(screen.getByRole('button', { name: 'recTrigger' })).toBeTruthy()
  expect(localStorage.getItem('dshm-ai-recommend')).toBeNull()
})

it('with no model, offers to set one up; with nothing installed, says to install some first', async () => {
  vi.stubGlobal('fetch', vi.fn(() => reply(409, { code: 'no-model', error: 'x' })))
  render_()
  fireEvent.click(screen.getByRole('button', { name: 'recTrigger' }))
  await waitFor(() => screen.getByRole('button', { name: 'recSetupModel' }))
  cleanup()
  vi.stubGlobal('fetch', vi.fn(() => reply(409, { code: 'no-seeds', error: 'x' })))
  render_()
  fireEvent.click(screen.getByRole('button', { name: 'recTrigger' }))
  await waitFor(() => screen.getByText('recNoSeeds'))
})
