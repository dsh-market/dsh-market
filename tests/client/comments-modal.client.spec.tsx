// @vitest-environment jsdom
/**
 * The comment thread's own behaviour: it loads on open (opening it is the
 * request — there is no second click), it asks for the right discussion, and
 * a failed load offers a way back rather than an empty box.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommentsModal } from '../../src/client/CommentsModal.tsx'
import { en, zh } from '../../src/client/locales.ts'

afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
})

const dict = (d: Record<string, string>) => (k: string) => d[k] ?? k

function open(overrides: Partial<{ url: string; lang: string }> = {}) {
  return render(
    <CommentsModal
      name="dsh-loop"
      url={overrides.url ?? 'https://github.com/alice/dsh-loop'}
      lang={overrides.lang ?? 'en'}
      onClose={() => {}}
      t={dict(overrides.lang === 'zh' ? zh : en)}
    />,
  )
}

/** The giscus loader the component appended, if any. */
const loader = () => document.querySelector<HTMLScriptElement>('script[src*="giscus.app"]')

describe('CommentsModal', () => {
  it('loads on open, without waiting for a second click', async () => {
    open()
    await waitFor(() => expect(loader()).not.toBeNull())
    // Nothing in the dialog asks the reader to start the load.
    expect(screen.queryByRole('button', { name: en.commentsRetry })).toBeNull()
    expect(screen.getByText(en.commentsLoading)).toBeTruthy()
  })

  it('keeps GitHub as the primary sign-in path while the embedded thread loads', async () => {
    window.history.replaceState({}, '', '/?token=local-host-secret')
    open()

    const link = screen.getByRole('link', { name: en.commentsOnGitHub })
    const href = new URL(link.getAttribute('href')!)
    expect(href.origin + href.pathname).toBe(
      'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/discussions',
    )
    expect(href.searchParams.get('discussions_q')).toBe('"plugin:alice/dsh-loop"')
    expect(href.href).not.toContain('local-host-secret')
    expect(link.getAttribute('target')).toBe('_blank')

    await waitFor(() => expect(loader()).not.toBeNull())
  })

  it('asks for the discussion this plugin shares with both websites', async () => {
    open()
    await waitFor(() => expect(loader()).not.toBeNull())
    const s = loader()!
    expect(s.dataset.term).toBe('plugin:alice/dsh-loop')
    expect(s.dataset.mapping).toBe('specific')
    // Without strict, `alice/dsh-loop` and `alice/dsh-loop--x` can collide.
    expect(s.dataset.strict).toBe('1')
    expect(s.dataset.repo).toBe('awesome-dsh-plugin/awesome-dsh-plugin')
  })

  it('qualifies a plugin that lives in a subdirectory', async () => {
    open({ url: 'https://github.com/alice/mono/tree/main/packages/loop' })
    await waitFor(() => expect(loader()).not.toBeNull())
    expect(loader()!.dataset.term).toBe('plugin:alice/mono--packages-loop')
  })

  it('shows the thread in the reader\'s language', async () => {
    open({ lang: 'zh' })
    await waitFor(() => expect(loader()).not.toBeNull())
    expect(loader()!.dataset.lang).toBe('zh-CN')
  })

  it('offers a retry and a way to GitHub when the load fails', async () => {
    open()
    await waitFor(() => expect(loader()).not.toBeNull())
    const first = loader()!
    fireEvent.error(first)

    const retry = await screen.findByRole('button', { name: en.commentsRetry })
    expect(screen.getByText(en.commentsError)).toBeTruthy()
    const link = screen.getByRole('link', { name: en.commentsOnGitHub })
    expect(link.getAttribute('href')).toContain('/discussions')

    fireEvent.click(retry)
    // A retry is a fresh attempt, not the dead script re-announced.
    await waitFor(() => expect(loader()).not.toBeNull())
    expect(screen.queryByText(en.commentsError)).toBeNull()
  })

  it('tells the reader that opening this reaches a third party', () => {
    open()
    expect(screen.getByText(en.commentsNote)).toBeTruthy()
    expect(en.commentsNote).toContain('giscus.app')
    expect(zh.commentsNote).toContain('giscus.app')
    expect(screen.getByText(en.commentsLoginHint)).toBeTruthy()
    expect(en.commentsLoginHint).toContain('nothing is broken')
    expect(en.commentsLoginHint).toContain('GitHub')
    expect(zh.commentsLoginHint).toContain('不是故障')
    expect(zh.commentsLoginHint).toContain('GitHub')
  })
})

describe('theme', () => {
  it('follows the host rather than the operating system', async () => {
    document.body.style.backgroundColor = 'rgb(21, 21, 23)'
    // The OS says light; the host window is dark, and the host wins.
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    open()
    await waitFor(() => expect(loader()).not.toBeNull())
    expect(loader()!.dataset.theme).toBe('dark')
    document.body.style.backgroundColor = ''
    vi.unstubAllGlobals()
  })
})
