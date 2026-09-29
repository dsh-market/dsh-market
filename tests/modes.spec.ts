/**
 * Modes: the pure rules in src/modes.ts, plus the state.json round trip.
 *
 * The activation rule is the whole feature, so it is tested as a pure
 * function against explicit sets rather than through the route: what a switch
 * does is "these names on, these names off", and the three properties the
 * design rests on — stateless, narrow, reversible — are statements about that
 * function, not about the host's toggle machinery (that side is covered in
 * flows.spec.ts).
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMarketState, writeMarketState } from '../src/hot.ts'
import {
  MAX_MODES, createMode, deleteMode, planModeActivation, planModeClear, removeFromModes,
  renameInModes, renameMode, setModeMembers, type ModeState,
} from '../src/modes.ts'

function modeState(overrides: Partial<ModeState> = {}): ModeState {
  return { modes: {}, modeOrder: [], activeMode: null, ...overrides }
}

const installed = (...names: string[]): ReadonlySet<string> => new Set(names)
const none = new Set<string>()

describe('mode CRUD', () => {
  it('creates, orders and refuses duplicates and bad names', () => {
    const state = modeState()
    expect(createMode(state, '编程').ok).toBe(true)
    expect(createMode(state, '科研').ok).toBe(true)
    expect(state.modeOrder).toEqual(['编程', '科研'])
    expect(state.modes['编程']).toEqual([])

    expect(createMode(state, '编程').ok).toBe(false)
    expect(createMode(state, '').ok).toBe(false)
    expect(createMode(state, 'a/b').ok).toBe(false)
    expect(createMode(state, 7).ok).toBe(false)
    // Same rule as a group name, including CJK and the separators people use.
    expect(createMode(state, '视频 剪辑-v2').ok).toBe(true)
  })

  it('stops at the quota instead of trimming silently', () => {
    const state = modeState()
    for (let index = 0; index < MAX_MODES; index += 1) expect(createMode(state, `m${index}`).ok).toBe(true)
    const over = createMode(state, 'one-too-many')
    expect(over.ok).toBe(false)
    expect(String(over.error)).toContain(String(MAX_MODES))
    expect(state.modeOrder).toHaveLength(MAX_MODES)
  })

  it('renames in place, keeping order and following the active mode', () => {
    const state = modeState({ modes: { 编程: ['a'] }, modeOrder: ['编程'], activeMode: '编程' })
    expect(renameMode(state, '编程', '写代码').ok).toBe(true)
    expect(state.modes).toEqual({ 写代码: ['a'] })
    expect(state.modeOrder).toEqual(['写代码'])
    // A rename must not silently unselect the mode the user is in.
    expect(state.activeMode).toBe('写代码')

    expect(renameMode(state, 'missing', 'x').ok).toBe(false)
    expect(renameMode(state, '写代码', 'a/b').ok).toBe(false)
    expect(createMode(state, '科研'))
    expect(renameMode(state, '写代码', '科研').ok).toBe(false)
    expect(renameMode(state, '写代码', '写代码').ok).toBe(true)
  })

  it('deletes, and unselects a deleted active mode rather than keeping a dead name', () => {
    const state = modeState({ modes: { a: [], b: [] }, modeOrder: ['a', 'b'], activeMode: 'a' })
    expect(deleteMode(state, 'a').ok).toBe(true)
    expect(state.modeOrder).toEqual(['b'])
    expect(state.activeMode).toBeNull()
    expect(deleteMode(state, 'a').ok).toBe(false)

    const other = modeState({ modes: { a: [], b: [] }, modeOrder: ['a', 'b'], activeMode: 'b' })
    expect(deleteMode(other, 'a').ok).toBe(true)
    expect(other.activeMode).toBe('b')
  })
})

describe('mode membership', () => {
  const themes = installed('theme-a', 'theme-b')

  it('keeps only installed, non-market, non-infrastructure names', () => {
    const state = modeState({ modes: { m: [] }, modeOrder: ['m'] })
    const result = setModeMembers(
      state, 'm',
      ['a', 'a', 'ghost', 'dsh-market', 'dshmarket', '', 7, '@deepseek-ai/dsh-web', 'b'],
      installed('a', 'b', 'dsh-market', 'dshmarket', '@deepseek-ai/dsh-web'),
      themes,
      installed('@deepseek-ai/dsh-web'),
    )
    expect(result.ok).toBe(true)
    expect(state.modes.m).toEqual(['a', 'b'])
  })

  it('holds at most one theme', () => {
    const state = modeState({ modes: { m: [] }, modeOrder: ['m'] })
    expect(setModeMembers(state, 'm', ['theme-a', 'theme-b'], installed('theme-a', 'theme-b'), themes, none).ok).toBe(false)
    expect(setModeMembers(state, 'm', ['theme-a', 'b'], installed('theme-a', 'b'), themes, none).ok).toBe(true)
    expect(state.modes.m).toEqual(['theme-a', 'b'])
  })

  it('refuses an unknown mode and a non-array', () => {
    const state = modeState({ modes: { m: [] }, modeOrder: ['m'] })
    expect(setModeMembers(state, 'nope', [], installed(), themes, none).ok).toBe(false)
    expect(setModeMembers(state, 'm', 'not-an-array', installed(), themes, none).ok).toBe(false)
  })

  it('drops a plugin from every mode, and follows a package rename', () => {
    const state = modeState({ modes: { a: ['x', 'y'], b: ['y'] }, modeOrder: ['a', 'b'] })
    removeFromModes(state.modes, 'y')
    expect(state.modes).toEqual({ a: ['x'], b: [] })

    renameInModes(state.modes, 'x', 'z')
    expect(state.modes.a).toEqual(['z'])
    // A rename onto a name already in the same mode must not duplicate it.
    renameInModes(state.modes, 'z', 'z')
    expect(state.modes.a).toEqual(['z'])
    const dup = modeState({ modes: { a: ['x', 'z'] }, modeOrder: ['a'] })
    renameInModes(dup.modes, 'x', 'z')
    expect(dup.modes.a).toEqual(['z'])
  })
})

describe('planModeActivation', () => {
  /**
   * The example from the feature's own description: a plugin useful in two
   * contexts (d, e) stays on across both, while the two that belong to only
   * one context trade places.
   */
  const roster = modeState({
    modes: { 编程: ['a', 'd', 'e'], 科研: ['b', 'd', 'e'], 视频: ['c', 'd', 'e'] },
    modeOrder: ['编程', '科研', '视频'],
    activeMode: '编程',
  })
  const all = installed('a', 'b', 'c', 'd', 'e', 'unfiled')

  it('opens the target, closes the other modes, and never touches an unfiled plugin', () => {
    // 编程 is the mode in force: a, d, e are on; b, c are off.
    const disabled = installed('b', 'c')
    const on = planModeActivation(roster, '科研', all, disabled, none)
    expect(on.ok).toBe(true)
    expect(on.turnedOn).toEqual(['b'])
    // 'c' belongs to 视频 and is already off, so it is not planned off twice.
    expect(on.turnedOff).toEqual(['a'])
    // The payoff of multi-membership: d and e are in both modes, so a switch
    // between them moves them not at all.
    expect([...on.turnedOn, ...on.turnedOff]).not.toContain('d')
    expect([...on.turnedOn, ...on.turnedOff]).not.toContain('e')
    // `unfiled` is in no mode, so it can appear in neither list.
    expect([...on.turnedOn, ...on.turnedOff]).not.toContain('unfiled')
  })

  it('is stateless: the same switch planned twice gives the same answer', () => {
    const once = planModeActivation(roster, '科研', all, installed('a', 'c'), none)
    const twice = planModeActivation(roster, '科研', all, installed('a', 'c'), none)
    expect(twice).toEqual(once)
  })

  it('is reversible: the way back from the state a switch produced is its inverse', () => {
    // 编程 is on (a, d, e), so switching to 科研 turns b on and a off.
    const away = planModeActivation(roster, '科研', all, installed('b', 'c'), none)
    expect(away.turnedOn).toEqual(['b'])
    expect(away.turnedOff).toEqual(['a'])
    // From the state that switch produced (科研 on: b, d, e), the way back
    // turns on exactly what went off and off exactly what came on.
    const back = planModeActivation(roster, '编程', all, installed('a', 'c'), none)
    expect(back.turnedOn).toEqual(['a'])
    expect(back.turnedOff).toEqual(['b'])
    expect(back.turnedOn).toEqual(away.turnedOff)
    expect(back.turnedOff).toEqual(away.turnedOn)
  })

  it('plans nothing when the target mode is open and the others are closed', () => {
    const plan = planModeActivation(roster, '编程', all, installed('b', 'c'), none)
    expect(plan).toMatchObject({ ok: true, turnedOn: [], turnedOff: [] })
  })

  it('ignores members that are no longer installed', () => {
    const plan = planModeActivation(roster, '科研', installed('b', 'd', 'e'), installed('b', 'd', 'e'), none)
    expect(plan.turnedOn).toEqual(['b', 'd', 'e'])
    // 'a' and 'c' are gone, so they are not mode-owned any more and cannot be
    // planned off — an uninstalled package has no switch to move.
    expect(plan.turnedOff).toEqual([])
  })

  it('skips host infrastructure instead of failing the whole switch', () => {
    const state = modeState({
      modes: { a: ['infra', 'x'], b: ['y'] },
      modeOrder: ['a', 'b'],
      activeMode: null,
    })
    const plan = planModeActivation(state, 'a', installed('infra', 'x', 'y'), installed('infra', 'x'), installed('infra'))
    expect(plan.ok).toBe(true)
    expect(plan.turnedOn).toEqual(['x'])
    expect(plan.turnedOff).toEqual(['y'])
    expect(plan.skippedProtected).toEqual(['infra'])
  })

  it('refuses an unknown mode', () => {
    expect(planModeActivation(roster, 'nope', all, none, none).ok).toBe(false)
    expect(planModeActivation(roster, 7, all, none, none).ok).toBe(false)
  })
})

describe('planModeClear', () => {
  it('closes the active mode and leaves other modes alone', () => {
    const state = modeState({
      modes: { 编程: ['a', 'd'], 科研: ['b'] },
      modeOrder: ['编程', '科研'],
      activeMode: '编程',
    })
    const plan = planModeClear(state, installed('a', 'b', 'd'), none, none)
    expect(plan.turnedOn).toEqual([])
    // 'b' belongs only to 科研: leaving 编程 must not flatten every mode.
    expect(plan.turnedOff).toEqual(['a', 'd'])
  })

  it('plans nothing with no active mode, or with the active mode gone', () => {
    expect(planModeClear(modeState(), installed('a'), none, none).turnedOff).toEqual([])
    const dangling = modeState({ modes: {}, modeOrder: [], activeMode: 'gone' })
    expect(planModeClear(dangling, installed('a'), none, none).turnedOff).toEqual([])
  })
})

describe('modes in state.json', () => {
  function stateDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dshm-modes-'))
    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
    return dir
  }

  it('round-trips modes and leaves groups untouched', () => {
    const dir = stateDir()
    try {
      writeMarketState(dir, {
        disabled: new Set(),
        groups: { 整理: ['a'] },
        groupOrder: ['整理'],
        modes: { 编程: ['a', 'b'], 科研: ['b'] },
        modeOrder: ['编程', '科研'],
        activeMode: '科研',
      })
      const state = readMarketState(dir)
      expect(state.modes).toEqual({ 编程: ['a', 'b'], 科研: ['b'] })
      expect(state.modeOrder).toEqual(['编程', '科研'])
      expect(state.activeMode).toBe('科研')
      // The two concepts share a shape and nothing else; a modes write must
      // never disturb the filing the user already did.
      expect(state.groups).toEqual({ 整理: ['a'] })
      expect(state.groupOrder).toEqual(['整理'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('omitting activeMode preserves it, null clears it', () => {
    const dir = stateDir()
    try {
      writeMarketState(dir, {
        disabled: new Set(), groups: {}, groupOrder: [],
        modes: { m: ['a'] }, modeOrder: ['m'], activeMode: 'm',
      })
      // A partial write (the shape every toggle route uses) must not unselect
      // the mode as a side effect of persisting something else.
      writeMarketState(dir, { disabled: new Set(['a']), groups: {}, groupOrder: [], modes: { m: ['a'] }, modeOrder: ['m'] })
      expect(readMarketState(dir).activeMode).toBe('m')

      writeMarketState(dir, {
        disabled: new Set(), groups: {}, groupOrder: [],
        modes: { m: ['a'] }, modeOrder: ['m'], activeMode: null,
      })
      expect(readMarketState(dir).activeMode).toBeNull()
      const raw = JSON.parse(readFileSync(join(dir, '.dsh-market', 'state.json'), 'utf8')) as Record<string, unknown>
      // Omitted while there is no mode, so "no mode" and "never chose" read
      // the same and a bad value cannot survive a round trip.
      expect('activeMode' in raw).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads malformed modes as empty and a dangling activeMode as none', () => {
    const dir = stateDir()
    try {
      writeFileSync(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ modes: 'nope', modeOrder: 7 }))
      expect(readMarketState(dir).modes).toEqual({})
      expect(readMarketState(dir).modeOrder).toEqual([])
      expect(readMarketState(dir).activeMode).toBeNull()

      writeFileSync(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ modes: { m: ['a', 'a', ''] }, modeOrder: ['m'], activeMode: 'gone' }))
      expect(readMarketState(dir).modes).toEqual({ m: ['a'] })
      expect(readMarketState(dir).activeMode).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
