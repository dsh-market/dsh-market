/**
 * #60 durable state: state.json grows from the theme-only `disabledSkins`
 * into the generic `disabled` list plus custom groups. These specs exercise
 * the REAL hot.ts state functions and the pure groups.ts CRUD — the route
 * wiring and live toggles live in flows.spec.ts.
 */

import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readDisabled, readDisabledThemes, readMarketState, writeDisabled, writeDisabledThemes, writeMarketState,
} from '../src/hot.ts'
import {
  createGroup, deleteGroup, removeFromGroups, renameGroup, setGroupMembers,
} from '../src/groups.ts'

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-state-'))
  mkdirSync(join(dir, '.dsh-market'), { recursive: true })
  return dir
}

function readRaw(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, '.dsh-market', 'state.json'), 'utf8')) as Record<string, unknown>
}

describe('market state.json (#60)', () => {
  it('loads legacy disabledSkins; new writes use the unified disabled key', () => {
    const dir = stateDir()
    try {
      writeFileSync(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ disabledSkins: ['theme-a'] }))
      expect([...readMarketState(dir).disabled]).toEqual(['theme-a'])
      expect([...readDisabled(dir)]).toEqual(['theme-a'])
      expect([...readDisabledThemes(dir)]).toEqual(['theme-a'])

      writeDisabledThemes(dir, new Set(['theme-b']))
      const raw = readRaw(dir)
      expect(raw.disabled).toEqual(['theme-b'])
      expect(raw.disabledSkins).toBeUndefined()
      expect([...readMarketState(dir).disabled]).toEqual(['theme-b'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writeDisabled preserves groups and groupOrder; writeMarketState persists all', () => {
    const dir = stateDir()
    try {
      writeMarketState(dir, {
        disabled: new Set(['dsh-loop']),
        groups: { work: ['dsh-loop', 'dsh-notify'] },
        groupOrder: ['work'],
      })
      // A theme switch only rewrites the disable list — groups must survive.
      writeDisabled(dir, new Set(['theme-a']))
      const state = readMarketState(dir)
      expect([...state.disabled]).toEqual(['theme-a'])
      expect(state.groups).toEqual({ work: ['dsh-loop', 'dsh-notify'] })
      expect(state.groupOrder).toEqual(['work'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readMarketState normalizes malformed payloads to empty state', () => {
    const dir = stateDir()
    try {
      writeFileSync(join(dir, '.dsh-market', 'state.json'), 'not json')
      expect(readMarketState(dir)).toEqual({ disabled: new Set(), groups: {}, groupOrder: [] })
      writeFileSync(join(dir, '.dsh-market', 'state.json'), JSON.stringify({
        disabled: ['a', 'a', '', 7],
        groups: { work: ['x', 'x', 3] },
        groupOrder: ['work', 'work', null],
      }))
      const state = readMarketState(dir)
      expect([...state.disabled]).toEqual(['a'])
      expect(state.groups).toEqual({ work: ['x'] })
      expect(state.groupOrder).toEqual(['work'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('remembers the release channel the user picked, in both directions', () => {
    // "用户选完之后,应该就要记住用户上次选的". Round-tripped through the
    // real file because the route-level spec runs against a stand-in, and a
    // stand-in cannot vouch for the writer it stands in for.
    const dir = stateDir()
    try {
      const base = { disabled: new Set(['dsh-loop']), groups: { work: ['dsh-loop'] }, groupOrder: ['work'] }
      writeMarketState(dir, { ...base, channel: 'beta' })
      expect(readRaw(dir).channel).toBe('beta')
      expect(readMarketState(dir).channel).toBe('beta')

      // The way back off the channel has to persist as a CHOICE. Left to
      // derivation a prerelease build re-reads as 'beta' every boot, so a
      // writer that only recorded the interesting-looking value would strand
      // the user on the channel they just left.
      writeMarketState(dir, { ...base, channel: 'stable' })
      expect(readRaw(dir).channel).toBe('stable')
      expect(readMarketState(dir).channel).toBe('stable')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records no channel at all until one is chosen', () => {
    // Absent has to stay absent through a round trip: it is what lets the
    // channel derive from the running build, so hand-installing a
    // prerelease lands on beta without a second step. Persisting a
    // stand-in 'stable' here would silently answer the question for the
    // user and then claim they had answered it.
    const dir = stateDir()
    try {
      writeMarketState(dir, { disabled: new Set(), groups: {}, groupOrder: [] })
      expect('channel' in readRaw(dir)).toBe(false)
      expect(readMarketState(dir).channel).toBeUndefined()

      // ...and a junk value on disk is not a choice either.
      writeFileSync(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ channel: 'nightly' }))
      expect(readMarketState(dir).channel).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a disable toggle does not forget the channel', () => {
    // writeDisabled re-reads, mutates one field and writes the whole file
    // back. Every field it fails to carry is erased by an unrelated click.
    const dir = stateDir()
    try {
      writeMarketState(dir, { disabled: new Set(), groups: {}, groupOrder: [], channel: 'beta' })
      writeDisabled(dir, new Set(['theme-a']))
      expect(readMarketState(dir).channel).toBe('beta')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('group CRUD (groups.ts)', () => {
  it('create/rename/delete keep groups and order consistent', () => {
    const state = { groups: {}, groupOrder: [] }
    expect(createGroup(state, 'work').ok).toBe(true)
    expect(createGroup(state, 'work').ok).toBe(false)
    expect(createGroup(state, 'bad/name').ok).toBe(false)
    expect(createGroup(state, '').ok).toBe(false)

    expect(renameGroup(state, 'work', 'daily').ok).toBe(true)
    expect(state.groups).toEqual({ daily: [] })
    expect(state.groupOrder).toEqual(['daily'])
    expect(renameGroup(state, 'missing', 'x').ok).toBe(false)
    expect(renameGroup(state, 'daily', 'work').ok).toBe(true)
    expect(renameGroup(state, 'work', 'work').ok).toBe(true)

    expect(deleteGroup(state, 'work').ok).toBe(true)
    expect(state).toEqual({ groups: {}, groupOrder: [] })
    expect(deleteGroup(state, 'ghost').ok).toBe(false)
  })

  it('set-members keeps only installed unique names and drops the market itself', () => {
    const state = { groups: { work: [] }, groupOrder: ['work'] }
    const installed = new Set(['dsh-loop', 'dsh-notify', 'dshmarket'])
    const themes = new Set(['theme-a'])
    expect(setGroupMembers(state, 'work', ['dsh-loop', 'dsh-loop', 'ghost', 'dshmarket'], installed, themes).ok).toBe(true)
    expect(state.groups.work).toEqual(['dsh-loop'])
    expect(setGroupMembers(state, 'ghost', [], installed, themes).ok).toBe(false)
    expect(setGroupMembers(state, 'work', 'nope', installed, themes).ok).toBe(false)
  })

  it('set-members rejects a second theme in one group', () => {
    const state = { groups: { work: [] }, groupOrder: ['work'] }
    const installed = new Set(['theme-a', 'theme-b'])
    const themes = new Set(['theme-a', 'theme-b'])
    const result = setGroupMembers(state, 'work', ['theme-a', 'theme-b'], installed, themes)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/at most one theme/)
    expect(state.groups.work).toEqual([])
    // A single theme is fine.
    expect(setGroupMembers(state, 'work', ['theme-a'], installed, themes).ok).toBe(true)
    expect(state.groups.work).toEqual(['theme-a'])
  })

  it('removeFromGroups prunes a name everywhere', () => {
    const state = { groups: { a: ['x', 'y'], b: ['x'] }, groupOrder: ['a', 'b'] }
    removeFromGroups(state, 'x')
    expect(state.groups).toEqual({ a: ['y'], b: [] })
  })
})
