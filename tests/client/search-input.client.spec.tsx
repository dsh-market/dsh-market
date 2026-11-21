// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SearchInput, SEARCH_DELAY_MS } from '../../src/client/SearchInput.tsx'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { cleanup(); vi.useRealTimers() })
const tick = (ms = SEARCH_DELAY_MS) => act(() => vi.advanceTimersByTime(ms))
const input = () => screen.getByRole('textbox') as HTMLInputElement
const type = (value: string) => fireEvent.change(input(), { target: { value } })
/** The component names its clear control through the caller's translate function. */
const label = (key: string) => key
const clear = () => screen.getByRole('button', { name: 'clearSearch' })

it('echoes each character locally but commits only after the last pause', () => {
  const commit = vi.fn()
  render(<SearchInput t={label} value="" onCommit={commit} />)
  type('m'); tick(200); type('me'); tick(200); type('memory')
  expect(input().value).toBe('memory')
  tick(SEARCH_DELAY_MS - 1)
  expect(commit).not.toHaveBeenCalled()
  tick(1)
  expect(commit.mock.calls).toEqual([['memory']])
})

it('clears immediately and cancels the older pending query', () => {
  const commit = vi.fn()
  render(<SearchInput t={label} value="memory" onCommit={commit} />)
  type('memo'); type(''); tick()
  expect(commit.mock.calls).toEqual([['']])
})

it('flushes Enter and blur exactly once', () => {
  const commit = vi.fn()
  render(<SearchInput t={label} value="" onCommit={commit} />)
  type('memory'); fireEvent.keyDown(input(), { key: 'Enter' }); tick()
  expect(commit.mock.calls).toEqual([['memory']])
  type('theme'); fireEvent.blur(input()); tick()
  expect(commit.mock.calls).toEqual([['memory'], ['theme']])
})

it('does not search intermediate IME text or commit its confirmation Enter', () => {
  const commit = vi.fn()
  render(<SearchInput t={label} value="" onCommit={commit} />)
  type('m'); fireEvent.compositionStart(input()); type('ming'); tick(1000)
  fireEvent.keyDown(input(), { key: 'Enter', isComposing: true })
  expect(commit).not.toHaveBeenCalled()
  fireEvent.compositionEnd(input(), { target: { value: '命令' } })
  tick()
  expect(commit.mock.calls).toEqual([['命令']])
})

it('honors external navigation and cancels the old draft', () => {
  const commit = vi.fn()
  const { rerender } = render(<SearchInput t={label} value="" onCommit={commit} />)
  type('old')
  rerender(<SearchInput t={label} value="replacement" onCommit={commit} />)
  expect(input().value).toBe('replacement')
  tick()
  expect(commit).not.toHaveBeenCalled()
})

it('cancels pending work on unmount and keeps tab identities separate', () => {
  const commit = vi.fn()
  const other = vi.fn()
  const { rerender, unmount } = render(<SearchInput t={label} key="discover" value="" onCommit={commit} />)
  type('discard')
  rerender(<SearchInput t={label} key="themes" value="skin" onCommit={other} />)
  expect(input().value).toBe('skin')
  tick()
  expect(commit).not.toHaveBeenCalled()
  expect(other).not.toHaveBeenCalled()
  type('discard too'); unmount(); tick()
  expect(other).not.toHaveBeenCalled()
})

it('offers the clear control only while there is something on screen', () => {
  render(<SearchInput t={label} value="" onCommit={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'clearSearch' })).toBeNull()
  // Whitespace counts: it is text the reader can see and would have to
  // backspace through.
  type(' ')
  expect(screen.getByRole('button', { name: 'clearSearch' })).toBeTruthy()
  type('')
  expect(screen.queryByRole('button', { name: 'clearSearch' })).toBeNull()
})

it('clears the draft and the query together, before the debounce fires', () => {
  const commit = vi.fn()
  render(<SearchInput t={label} value="" onCommit={commit} />)
  type('memory')
  expect(input().value).toBe('memory')
  fireEvent.click(clear())
  // Immediately: the box is empty, the parent has been told, and nothing is
  // left scheduled to put 'memory' back.
  expect(input().value).toBe('')
  expect(commit.mock.calls).toEqual([['']])
  tick(SEARCH_DELAY_MS * 2)
  expect(commit.mock.calls).toEqual([['']])
  expect(screen.queryByRole('button', { name: 'clearSearch' })).toBeNull()
})

it('returns focus to the field it cleared', () => {
  render(<SearchInput t={label} value="" onCommit={vi.fn()} />)
  type('memory')
  clear().focus()
  fireEvent.click(clear())
  // The host Input renders the native element itself and forwards no ref, so
  // this is the assertion that keeps the lookup inside this component honest.
  expect(document.activeElement).toBe(input())
})

it('pressing clear keeps focus in the field, so the pending query is never applied first', () => {
  // Real browsers blur the input on the button's mousedown; onBlur would then
  // commit the query still inside its wait, the list reflows, the button
  // moves and the mouseup misses it (Favorites at 640px, 1.74.0 CI).
  const commit = vi.fn()
  render(<SearchInput t={label} value="" onCommit={commit} />)
  type('memory')
  const pressed = fireEvent.mouseDown(clear())
  expect(pressed, 'mousedown default must be prevented so the input keeps focus').toBe(false)
  fireEvent.click(clear())
  tick(SEARCH_DELAY_MS * 2)
  expect(commit.mock.calls).toEqual([['']])
})

it('in AI mode typing never filters, Enter asks the model, and switching back applies the text as a filter', () => {
  const commit = vi.fn()
  const submit = vi.fn()
  const ai = { on: true, toggle: vi.fn(), submit, placeholder: 'describe it' }
  const { rerender } = render(<SearchInput t={label} value="" onCommit={commit} ai={ai} />)
  expect(input().placeholder).toBe('describe it')
  type('a plugin that remembers what I said'); tick(); fireEvent.blur(input()); tick()
  expect(commit).not.toHaveBeenCalled()
  fireEvent.keyDown(input(), { key: 'Enter' })
  expect(submit).toHaveBeenCalledWith('a plugin that remembers what I said')
  expect(commit).not.toHaveBeenCalled()
  // The switch is labelled and reports its state; turning it off filters by what is typed.
  const toggle = screen.getByRole('switch', { name: 'aiSearchLabel' })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggle)
  expect(ai.toggle).toHaveBeenCalled()
  expect(commit).toHaveBeenLastCalledWith('a plugin that remembers what I said')
  rerender(<SearchInput t={label} value="" onCommit={commit} ai={{ ...ai, on: false }} />)
  expect(screen.getByRole('switch', { name: 'aiSearchLabel' }).getAttribute('aria-checked')).toBe('false')
})

it('explains what AI search needs and costs next to the switch', () => {
  render(<SearchInput t={label} value="" onCommit={vi.fn()} ai={{ on: false, toggle: vi.fn(), submit: vi.fn(), placeholder: 'x' }} />)
  expect(screen.getByLabelText('aiSearchHelp')).toBeTruthy()
})
