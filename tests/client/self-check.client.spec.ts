// @vitest-environment jsdom
/**
 * The browser half of the exported log. Its whole value is being right about
 * a page nobody can look at, so the tests build the two page shapes that have
 * actually cost investigations time — one healthy, one double-loaded — and
 * check that the lines distinguish them.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientDiagnostics } from '../../src/client/self-check.ts'

const lines = () => clientDiagnostics()
const find = (prefix: string): string => {
  const hit = lines().find(line => line.startsWith(prefix))
  expect(hit, `no line starting with "${prefix}" in:\n${lines().join('\n')}`).toBeDefined()
  return hit!
}

afterEach(() => { document.body.innerHTML = '' })

describe('clientDiagnostics', () => {
  it('reports a healthy page as one root, one portal, cards present', () => {
    const root = document.createElement('div')
    root.setAttribute('data-dsh-market-root', '')
    root.innerHTML = '<div class="abc_card"></div><div class="abc_card"></div>'
    document.body.append(root)
    const portal = document.createElement('div')
    portal.setAttribute('data-dsh-market-portal', '')
    document.body.append(portal)

    expect(find('market roots in the document:')).toBe('market roots in the document: 1')
    expect(find('portal containers:')).toBe("portal containers: 1 (last one is body's last child: true)")
    expect(find('plugin cards rendered:')).toBe('plugin cards rendered: 2')
  })

  it('separates "never mounted" from "mounted and rendered nothing" (#293)', () => {
    // Both look like a blank panel to the reporter and have different causes,
    // which is exactly what the console question was trying to establish.
    expect(find('market roots in the document:')).toBe('market roots in the document: 0')

    const root = document.createElement('div')
    root.setAttribute('data-dsh-market-root', '')
    document.body.append(root)
    expect(find('market roots in the document:')).toBe('market roots in the document: 1')
    expect(find('plugin cards rendered:')).toBe('plugin cards rendered: 0')
  })

  it('shows a second portal container, and that the live one is not last (#384)', () => {
    const first = document.createElement('div')
    first.setAttribute('data-dsh-market-portal', '')
    const second = document.createElement('div')
    second.setAttribute('data-dsh-market-portal', '')
    document.body.append(first, second)
    expect(find('portal containers:')).toBe("portal containers: 2 (last one is body's last child: true)")

    // Something appended after the market's container covers it — the other
    // way a visible button stops receiving clicks.
    document.body.append(document.createElement('div'))
    expect(find('portal containers:')).toBe("portal containers: 2 (last one is body's last child: false)")
  })

  it('counts bundle evaluations on the page, not per module copy', async () => {
    // The count has to survive a second evaluation of this module, because
    // that is the condition it exists to detect. A module-local counter would
    // report 1 from each copy and never see the problem.
    const before = Number(find('client bundle evaluations:').split(': ')[1])
    expect(before).toBeGreaterThanOrEqual(1)
    // resetModules drops the registry entry, so the next import EVALUATES the
    // module again in the same page — the double-load condition itself.
    vi.resetModules()
    const second = await import('../../src/client/self-check.ts')
    expect(Number(find('client bundle evaluations:').split(': ')[1])).toBe(before + 1)
    // And the fresh copy agrees: the count lives on the page, not in either
    // copy's own scope.
    const fromCopy = second.clientDiagnostics().find(l => l.startsWith('client bundle evaluations:'))
    expect(fromCopy).toBe(`client bundle evaluations: ${String(before + 1)}`)
  })

  it('records the base the API paths resolve against (#345)', () => {
    expect(find('document baseURI:')).toContain(document.baseURI)
  })

  it('says nothing at all outside a browser', async () => {
    // The export is client-only today, but a line that throws in a server
    // render would take the whole export down with it.
    const doc = globalThis.document
    // @ts-expect-error deliberately removing the global for this assertion
    delete globalThis.document
    try {
      expect(clientDiagnostics()).toEqual([])
    } finally {
      globalThis.document = doc
    }
  })
})
