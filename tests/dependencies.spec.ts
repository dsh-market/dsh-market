import { describe, expect, it } from 'vitest'
import { installedDependents, resolveInstallOrder } from '../src/dependencies.ts'

const kernel = { name: 'ontology-kernel', url: 'https://github.com/aiko/kernel' }
const bid = { name: 'bid-studio', url: 'https://github.com/aiko/bid', requires: [kernel.url] }
const contract = { name: 'contract-studio', url: 'https://github.com/aiko/contract', requires: [kernel.url] }

describe('catalog plugin dependencies', () => {
  it('places a shared platform plugin before a scene plugin', () => {
    expect(resolveInstallOrder([bid, kernel], bid)).toEqual([kernel, bid])
  })
  it('installs a shared dependency only once across a transitive graph', () => {
    const suite = { name: 'business-suite', url: 'https://github.com/aiko/suite', requires: [bid.url, contract.url] }
    expect(resolveInstallOrder([suite, bid, contract, kernel], suite)).toEqual([kernel, bid, contract, suite])
  })
  it('rejects missing entries and dependency cycles', () => {
    expect(() => resolveInstallOrder([bid], bid)).toThrow(/requires missing entry/)
    const first = { name: 'first', url: 'https://example.test/first', requires: ['https://example.test/second'] }
    const second = { name: 'second', url: 'https://example.test/second', requires: [first.url] }
    expect(() => resolveInstallOrder([first, second], first)).toThrow(/first -> second -> first/)
  })
  it('finds every installed scene that blocks removal of the shared Kernel', () => {
    const installed = new Set(['bid-studio', 'contract-studio'])
    expect(installedDependents([kernel, bid, contract], kernel, plugin => installed.has(plugin.name))).toEqual([bid, contract])
  })
})
