import { describe, expect, it } from 'vitest'
import type { RegistryPlugin } from '../../src/client/market-data.ts'
import { sponsorOfPlugin, withSponsoredFirst } from '../../src/client/sponsored-plugins.ts'

const sponsor = (over: Record<string, unknown> = {}) => ({
  id: 's', name: { zh: 'S', en: 'S', ja: 'S' }, scope: { zh: '', en: '', ja: '' }, url: 'https://s.example', pluginUrl: 'https://s.example/p',
  until: null, plugins: ['@s/provider', 'https://github.com/s/other'], logo: '', ...over,
}) as never
const plugin = (name: string, over: Partial<RegistryPlugin> = {}): RegistryPlugin => ({
  name, url: `https://github.com/x/${name}`, category: 'tools', description: { en: '', zh: '' }, install: name, ...over,
}) as RegistryPlugin

describe('a sponsor\'s plugins at the front of Recently added', () => {
  const all = [plugin('new-a'), plugin('new-b'), plugin('provider', { npm: '@s/provider' }), plugin('other', { url: 'https://github.com/s/other' })]
  const recent = [all[0]!, all[1]!]

  it('puts them first in sponsor order, then the recent ones, each once', () => {
    const out = withSponsoredFirst(all, recent, () => true, [sponsor()])
    expect(out.map(p => p.name)).toEqual(['provider', 'other', 'new-a', 'new-b'])
  })

  it('does not repeat a sponsored plugin that is also recent', () => {
    const out = withSponsoredFirst(all, [all[2]!, all[0]!], () => true, [sponsor()])
    expect(out.map(p => p.name)).toEqual(['provider', 'other', 'new-a'])
  })

  it('leaves the strip alone when the sponsorship has ended, or has no plugins', () => {
    expect(withSponsoredFirst(all, recent, () => true, [sponsor({ until: '2000-01-01' })])).toEqual(recent)
    expect(withSponsoredFirst(all, recent, () => true, [sponsor({ plugins: [] })])).toEqual(recent)
  })

  it('skips a sponsored plugin the user blocked or the host cannot run', () => {
    const out = withSponsoredFirst(all, recent, p => p.name !== 'provider', [sponsor()])
    expect(out.map(p => p.name)).toEqual(['other', 'new-a', 'new-b'])
  })

  it('finds the owner by npm name or repository URL, ignoring case and a trailing .git', () => {
    expect(sponsorOfPlugin(plugin('p', { npm: '@S/Provider' }), [sponsor()])).toBeDefined()
    expect(sponsorOfPlugin(plugin('o', { url: 'https://github.com/s/other.git' }), [sponsor()])).toBeDefined()
    expect(sponsorOfPlugin(plugin('z'), [sponsor()])).toBeUndefined()
  })
})
