// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SearchInput, SEARCH_DELAY_MS } from '../../src/client/SearchInput.tsx'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { cleanup(); vi.useRealTimers() })
const tick = (ms = SEARCH_DELAY_MS) => act(() => vi.advanceTimersByTime(ms))
const input = () => screen.getByRole('textbox') as HTMLInputElement
const type = (value: string) => fireEvent.change(input(), { target: { value } })

it('echoes each character locally but commits only after the last pause', () => {
  const commit = vi.fn()
  render(<SearchInput value="" onCommit={commit} />)
  type('m'); tick(200); type('me'); tick(200); type('memory')
  expect(input().value).toBe('memory')
  tick(SEARCH_DELAY_MS - 1)
  expect(commit).not.toHaveBeenCalled()
  tick(1)
  expect(commit.mock.calls).toEqual([['memory']])
})

it('clears immediately and cancels the older pending query', () => {
  const commit = vi.fn()
  render(<SearchInput value="memory" onCommit={commit} />)
  type('memo'); type(''); tick()
  expect(commit.mock.calls).toEqual([['']])
})

it('flushes Enter and blur exactly once', () => {
  const commit = vi.fn()
  render(<SearchInput value="" onCommit={commit} />)
  type('memory'); fireEvent.keyDown(input(), { key: 'Enter' }); tick()
  expect(commit.mock.calls).toEqual([['memory']])
  type('theme'); fireEvent.blur(input()); tick()
  expect(commit.mock.calls).toEqual([['memory'], ['theme']])
})

it('does not search intermediate IME text or commit its confirmation Enter', () => {
  const commit = vi.fn()
  render(<SearchInput value="" onCommit={commit} />)
  type('m'); fireEvent.compositionStart(input()); type('ming'); tick(1000)
  fireEvent.keyDown(input(), { key: 'Enter', isComposing: true })
  expect(commit).not.toHaveBeenCalled()
  fireEvent.compositionEnd(input(), { target: { value: '命令' } })
  tick()
  expect(commit.mock.calls).toEqual([['命令']])
})

it('honors external navigation and cancels the old draft', () => {
  const commit = vi.fn()
  const { rerender } = render(<SearchInput value="" onCommit={commit} />)
  type('old')
  rerender(<SearchInput value="replacement" onCommit={commit} />)
  expect(input().value).toBe('replacement')
  tick()
  expect(commit).not.toHaveBeenCalled()
})

it('cancels pending work on unmount and keeps tab identities separate', () => {
  const commit = vi.fn()
  const other = vi.fn()
  const { rerender, unmount } = render(<SearchInput key="discover" value="" onCommit={commit} />)
  type('discard')
  rerender(<SearchInput key="themes" value="skin" onCommit={other} />)
  expect(input().value).toBe('skin')
  tick()
  expect(commit).not.toHaveBeenCalled()
  expect(other).not.toHaveBeenCalled()
  type('discard too'); unmount(); tick()
  expect(other).not.toHaveBeenCalled()
})
