// @vitest-environment jsdom
/**
 * The "view source" row the market contributes to a plugin detail page: it
 * resolves per package, and draws nothing when no repository is declared.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourceRepoLink } from '../../src/client/SourceRepoLink.tsx'
import { en } from '../../src/client/locales.ts'

const t = (key: string): string => (en as Record<string, string>)[key] ?? key

/** Answer the source-repo route from a fixed name → url table. */
function stubSourceRepo(urls: Record<string, string | null>): void {
  vi.stubGlobal('fetch', vi.fn((input: unknown) => {
    const path = String(input)
    expect(path).toContain('/dsh-market/source-repo?name=')
    const name = decodeURIComponent(path.slice(path.indexOf('name=') + 'name='.length))
    const url = urls[name] ?? null
    return Promise.resolve(new Response(JSON.stringify({ url }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  }))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SourceRepoLink', () => {
  it('links the package’s own repository, opened in a new tab', async () => {
    stubSourceRepo({ '@acme/widget': 'https://github.com/acme/widget' })
    render(<SourceRepoLink name="@acme/widget" t={t} />)

    const link = await screen.findByRole('link')
    expect(link.getAttribute('href')).toBe('https://github.com/acme/widget')
    expect(link.getAttribute('target')).toBe('_blank')
    // noreferrer: the click leaves for a third-party site.
    expect(link.getAttribute('rel')).toBe('noreferrer')
    // The row's whole visible name, arrow included.
    expect(link.textContent).toBe('View the repository↗')
  })

  it('resolves a different address for a different package', async () => {
    stubSourceRepo({
      'plugin-one': 'https://github.com/one/plugin-one',
      'plugin-two': 'https://github.com/two/plugin-two',
    })

    const first = render(<SourceRepoLink name="plugin-one" t={t} />)
    expect((await screen.findByRole('link')).getAttribute('href')).toBe('https://github.com/one/plugin-one')
    first.unmount()

    render(<SourceRepoLink name="plugin-two" t={t} />)
    await waitFor(() => {
      expect(screen.getByRole('link').getAttribute('href')).toBe('https://github.com/two/plugin-two')
    })
  })

  it('draws nothing when the package declares no repository', async () => {
    stubSourceRepo({ 'no-source': null })
    const { container } = render(<SourceRepoLink name="no-source" t={t} />)

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByRole('link')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('draws nothing when the route answers an address that is not https', async () => {
    // The href is a server answer, so a scheme the route would never build
    // today still must not become a clickable anchor.
    stubSourceRepo({ 'plain-http': 'http://github.com/acme/widget', 'script-url': 'javascript:alert(1)' })

    const first = render(<SourceRepoLink name="plain-http" t={t} />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByRole('link')).toBeNull()
    first.unmount()

    const { container } = render(<SourceRepoLink name="script-url" t={t} />)
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('link')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('draws nothing when the route cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    const { container } = render(<SourceRepoLink name="unreachable" t={t} />)

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })
})
