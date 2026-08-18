import { describe, expect, it } from 'vitest'
import { runningAgentIds, type AgentsServiceLike } from '../src/agents.ts'

function agents(entries: Array<{ id?: unknown; status?: unknown }>): AgentsServiceLike {
  return { list: () => entries }
}

describe('runningAgentIds', () => {
  it('returns [] when the host provides no agents service', () => {
    expect(runningAgentIds(undefined)).toEqual([])
  })

  it('returns only agents with status "running", by id', () => {
    const result = runningAgentIds(agents([
      { id: 'main', status: 'running' },
      { id: 'helper', status: 'idle' },
      { id: 'maintenance', status: 'maintenance' },
      { id: 'unknown', status: undefined },
      { status: 'running' },
      null as never,
    ]))
    expect(result).toEqual(['main', 'agent'])
  })

  it('deduplicates ids and keeps order', () => {
    const result = runningAgentIds(agents([
      { id: 'a', status: 'running' },
      { id: 'a', status: 'running' },
      { id: 'b', status: 'running' },
    ]))
    expect(result).toEqual(['a', 'b'])
  })

  it('fails open when list() throws (half-disposed registry)', () => {
    const broken: AgentsServiceLike = { list: () => { throw new Error('disposed') } }
    expect(runningAgentIds(broken)).toEqual([])
  })
})
