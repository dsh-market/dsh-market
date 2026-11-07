import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DrainCoordinator, type DrainExecutionResult, type DrainIntent, type DrainJournalRecord } from '../src/drain.ts'
import { DrainJournal } from '../src/drain-journal.ts'
import { exportLogs, logEvent } from '../src/log.ts'
import { runInProbe } from '../src/probe-context.ts'
import { FakeAgent } from './drain-agent.ts'

class FakeHost {
  agents: FakeAgent[] = []
  private created: Array<(agent: unknown) => void> = []
  private disposed: Array<(agent: unknown) => void> = []
  private status: Array<(agent: unknown, status: unknown) => void> = []

  list(): unknown[] {
    return [...this.agents]
  }

  onCreated(listener: (agent: unknown) => void): () => void {
    this.created.push(listener)
    return () => { this.created = this.created.filter(entry => entry !== listener) }
  }

  onDisposed(listener: (agent: unknown) => void): () => void {
    this.disposed.push(listener)
    return () => { this.disposed = this.disposed.filter(entry => entry !== listener) }
  }

  onStatus(listener: (agent: unknown, status: unknown) => void): () => void {
    this.status.push(listener)
    return () => { this.status = this.status.filter(entry => entry !== listener) }
  }

  /** Announces the Agent already idle. The real host does not: see `createInFactory`. */
  create(agent: FakeAgent): void {
    this.agents.push(agent)
    for (const listener of this.created) listener(agent)
  }

  /** The real host's order, see `FakeAgent.runFactory`. */
  createInFactory(agent: FakeAgent): { finish: () => Promise<void> } {
    agent.onStatus = status => { for (const listener of this.status) listener(agent, status) }
    return agent.runFactory(async () => {
      this.agents.push(agent)
      for (const listener of this.created) await listener(agent)
    })
  }

  remove(agent: FakeAgent): void {
    this.agents = this.agents.filter(entry => entry !== agent)
    for (const listener of this.disposed) listener(agent)
  }
}

interface Harness {
  host: FakeHost
  coordinator: DrainCoordinator
  records: DrainJournalRecord[]
  executed: Array<DrainIntent | null>
  aborted: { count: number }
  begin: (execute?: (intent: DrainIntent | null, onPhase: (phase: 'verifying') => void) => Promise<DrainExecutionResult>) => ReturnType<DrainCoordinator['begin']>
}

function harness(options: { forceDeferred?: boolean; maxRetained?: number } = {}): Harness {
  const host = new FakeHost()
  const records: DrainJournalRecord[] = []
  const aborted = { count: 0 }
  const executed: Array<DrainIntent | null> = []
  const coordinator = new DrainCoordinator({
    host,
    journal: { append: record => records.push(record) },
    bootId: 'boot-test',
    ...(options.maxRetained === undefined ? {} : { maxRetained: options.maxRetained }),
    log: () => {},
    abortMutation: () => { aborted.count += 1; return true },
  })
  const begin = (execute?: (intent: DrainIntent | null, onPhase: (phase: 'verifying') => void) => Promise<DrainExecutionResult>) =>
    coordinator.begin({
      kind: 'update',
      name: 'dsh-loop',
      forceDeferred: options.forceDeferred,
      captureIntent: async () => ({
        kind: 'update',
        name: 'dsh-loop',
        expected: { target: 'dsh-loop@1.2.0', spec: '^1.0.0', version: '1.0.0' },
      }),
      execute: execute ?? (async intent => {
        executed.push(intent)
        return { status: 200, payload: { ok: true, activation: { 'dsh-loop': { state: 'live' } }, hot: true } }
      }),
    })
  return { host, coordinator, records, executed, aborted, begin }
}

const OK: DrainExecutionResult = { status: 200, payload: { ok: true } }

describe('DrainCoordinator', () => {
  it('holds an idle Agent before running the executor inline', async () => {
    const bed = harness()
    const agent = new FakeAgent('main')
    bed.host.create(agent)

    const result = await bed.begin(async intent => {
      expect(intent).toBeNull()
      expect(agent.maintenanceCalls).toBe(1)
      return OK
    })
    expect(result.mode).toBe('inline')
    if (result.mode !== 'inline') return
    expect(result.result.status).toBe(200)
    // The hold is released after the operation settles.
    await Promise.resolve()
    expect(agent.held).toBe(false)
    expect(agent.cancelCalls).toBe(0)
    bed.coordinator.dispose()
  })

  /**
   * The report (#1134): a profile with ~81 idle sessions pinned one core at
   * 100% and grew RSS until DSH was restarted. The shape is a claim that keeps
   * being refused while the Agent reports idle — another maintenance task owns
   * it — so `whenIdle()` resolves at once and the drain loop re-entered with
   * nothing changed. Two Agents are the same shape as eighty-one.
   */
  it('does not spin while an idle Agent keeps refusing the claim (#1134)', async () => {
    const bed = harness()
    const stuck = new FakeAgent('stuck')
    stuck.failClaims = Number.MAX_SAFE_INTEGER
    const other = new FakeAgent('other')
    bed.host.create(stuck)
    bed.host.create(other)
    let lists = 0
    const realList = bed.host.list.bind(bed.host)
    bed.host.list = () => { lists += 1; return realList() }
    // A refused claim means the barrier cannot be reached inline, so the
    // operation is deferred and waits in the background.
    const result = await bed.begin()
    expect(result.mode).toBe('deferred')
    if (result.mode !== 'deferred') return
    // Each pass enumerates the Agents twice. Without the pause this ran
    // thousands of passes in 120ms; with it, a handful.
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(lists).toBeLessThan(100)
    // The Agent becomes claimable: the wait ends promptly, it is not stuck
    // behind a long backoff.
    stuck.failClaims = 0
    const settled = await bed.coordinator.whenSettled(result.operation.operationId)
    expect(settled?.state).toBe('succeeded')
    expect(bed.executed).toHaveLength(1)
    bed.coordinator.dispose()
  })

  /**
   * The reported shape (#1134): 81 sessions left over from weeks earlier,
   * some of them still reporting `running` while `whenIdle()` answers at once
   * — the host's status is stale, the turn is long over. Nothing was claimed
   * (the drain refuses to claim during a turn), the race returned
   * immediately, and the loop re-entered with nothing changed: one core at
   * 100% and RSS climbing until DSH was restarted.
   */
  it('does not spin while a session still reports running after its turn is over (#1134)', async () => {
    const bed = harness()
    const stale = new FakeAgent('stale', 'running')
    // `whenIdle` resolving while status still says `running` is the host
    // inconsistency; FakeAgent keeps them consistent, so state it here.
    stale.whenIdle = () => Promise.resolve()
    bed.host.create(stale)
    let lists = 0
    const realList = bed.host.list.bind(bed.host)
    bed.host.list = () => { lists += 1; return realList() }
    const result = await bed.begin()
    expect(result.mode).toBe('deferred')
    if (result.mode !== 'deferred') return
    // Each pass enumerates the Agents twice. Without the pause this ran
    // thousands of passes in 120ms; with it, a handful.
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(lists).toBeLessThan(100)
    // The status catches up: the wait ends promptly, not behind a backoff.
    stale.status = 'idle'
    const settled = await bed.coordinator.whenSettled(result.operation.operationId)
    expect(settled?.state).toBe('succeeded')
    bed.coordinator.dispose()
  })

  it('stays bounded with a profile full of stale idle sessions (#1134)', async () => {
    // The reported profile carries ~81 sessions from weeks earlier, a few of
    // them still reported `running` after their turns ended. The shape that
    // spun is the same; this pins the size: the wait must end promptly once
    // the statuses catch up, and the work per pass must not grow with the
    // session count in a way that keeps a core busy.
    const bed = harness()
    const stale: FakeAgent[] = []
    for (let index = 0; index < 80; index += 1) {
      const agent = new FakeAgent(`s-${String(index)}`, 'running')
      agent.whenIdle = () => Promise.resolve()
      stale.push(agent)
      bed.host.create(agent)
    }
    const result = await bed.begin()
    expect(result.mode).toBe('deferred')
    if (result.mode !== 'deferred') return
    let lists = 0
    const realList = bed.host.list.bind(bed.host)
    bed.host.list = () => { lists += 1; return realList() }
    await new Promise(resolve => setTimeout(resolve, 150))
    // A pause per stalled pass keeps this in the tens, not the thousands.
    expect(lists).toBeLessThan(150)
    for (const agent of stale) agent.status = 'idle'
    const settled = await bed.coordinator.whenSettled(result.operation.operationId)
    expect(settled?.state).toBe('succeeded')
    expect(bed.executed).toHaveLength(1)
    bed.coordinator.dispose()
  })

  it('waits for a running Agent, then executes once it is maintenance-held', async () => {
    const bed = harness()
    const agent = new FakeAgent('main', 'running')
    bed.host.create(agent)
    let calls = 0

    const result = await bed.begin(async intent => {
      calls += 1
      expect(intent?.expected.target).toBe('dsh-loop@1.2.0')
      return OK
    })
    expect(result.mode).toBe('deferred')
    if (result.mode !== 'deferred') return
    await Promise.resolve()
    expect(calls).toBe(0)
    expect(result.operation.wait).toMatchObject({ reason: 'agents', activeCount: 1, activeAgentIds: ['main'] })

    agent.finishTurn()
    const settled = await bed.coordinator.whenSettled(result.operation.operationId)
    expect(settled?.state).toBe('succeeded')
    expect(calls).toBe(1)
    expect(agent.maintenanceCalls).toBe(1)
    expect(agent.cancelCalls).toBe(0)
    expect(bed.records.at(-1)).toMatchObject({ state: 'succeeded', agentsAtStart: 1, agentsAtEnd: 1 })
    bed.coordinator.dispose()
  })

  it('leaves an idle Agent usable while it waits for a running one (#1095)', async () => {
    // Reported: a long turn in one session froze every OTHER session for 45
    // minutes. The barrier claimed all idle Agents up front and then waited on
    // the busy one, so their queued messages sat behind a hold that was itself
    // waiting. Nothing needs the idle Agents held until the moment the
    // package command can actually run.
    const bed = harness()
    const busy = new FakeAgent('long-turn', 'running')
    const idle = new FakeAgent('idle')
    bed.host.create(busy)
    bed.host.create(idle)

    const result = await bed.begin(async () => OK)
    expect(result.mode).toBe('deferred')
    if (result.mode !== 'deferred') return
    await Promise.resolve()

    expect(idle.held).toBe(false)
    expect(idle.maintenanceCalls).toBe(0)
    // A queued message may still start its turn — that is the point.
    expect(() => idle.startTurn()).not.toThrow()
    idle.finishTurn()

    busy.finishTurn()
    const settled = await bed.coordinator.whenSettled(result.operation.operationId)
    expect(settled?.state).toBe('succeeded')
    // Both are held by the time the command runs, so nothing starts a turn
    // against the files being replaced.
    expect(busy.maintenanceCalls).toBe(1)
    expect(idle.maintenanceCalls).toBe(1)
    bed.coordinator.dispose()
  })

  it('names only the Agents in a turn while it waits, not the idle ones (#1095)', async () => {
    // Since nothing is claimed while anyone is mid-turn, every idle Agent stays
    // unheld. Counting them told the user it was waiting for 4 Agents, under
    // "show running sessions", when one turn was all that stood in the way.
    const bed = harness()
    const busy = new FakeAgent('long-turn', 'running')
    const idle = ['idle-a', 'idle-b', 'idle-c'].map(id => new FakeAgent(id))
    bed.host.create(busy)
    for (const agent of idle) bed.host.create(agent)

    const result = await bed.begin(async () => OK)
    expect(result.mode).toBe('deferred')
    if (result.mode !== 'deferred') return
    const operationId = result.operation.operationId
    expect(result.operation.wait).toMatchObject({ activeCount: 1, activeAgentIds: ['long-turn'] })
    await Promise.resolve()
    expect(bed.coordinator.get(operationId)?.wait).toMatchObject({ activeCount: 1, activeAgentIds: ['long-turn'] })

    // Someone starting a turn keeps the barrier open, so the wait now names them.
    idle[0]!.startTurn()
    busy.finishTurn()
    await vi.waitFor(() => {
      expect(bed.coordinator.get(operationId)?.wait).toMatchObject({ activeCount: 1, activeAgentIds: ['idle-a'] })
    })

    idle[0]!.finishTurn()
    const settled = await bed.coordinator.whenSettled(operationId)
    expect(settled?.state).toBe('succeeded')
    bed.coordinator.dispose()
  })

  it('names every unheld Agent when none is in a turn but claims are refused', async () => {
    // Another maintenance task can own an idle Agent. Nobody is running then,
    // and an empty list would claim the operation is waiting for no one.
    const bed = harness()
    const first = new FakeAgent('owned-a')
    const second = new FakeAgent('owned-b')
    first.failClaims = Number.MAX_SAFE_INTEGER
    second.failClaims = Number.MAX_SAFE_INTEGER
    bed.host.create(first)
    bed.host.create(second)

    const result = await bed.begin(async () => OK)
    expect(result.mode).toBe('deferred')
    if (result.mode !== 'deferred') return
    expect(result.operation.wait).toMatchObject({ activeCount: 2, activeAgentIds: ['owned-a', 'owned-b'] })

    first.failClaims = 0
    second.failClaims = 0
    const settled = await bed.coordinator.whenSettled(result.operation.operationId)
    expect(settled?.state).toBe('succeeded')
    bed.coordinator.dispose()
  })

  it('holds an Agent created during the drain before its first turn', async () => {
    const bed = harness()
    const first = new FakeAgent('first', 'running')
    bed.host.create(first)
    const result = await bed.begin(async () => OK)
    expect(result.mode).toBe('deferred')

    const late = new FakeAgent('late')
    bed.host.create(late)
    // The creation listener claims synchronously, before `create()` returns.
    expect(late.maintenanceCalls).toBe(1)
    expect(() => late.startTurn()).toThrow()

    first.finishTurn()
    const settled = await bed.coordinator.whenSettled(result.mode === 'deferred' ? result.operation.operationId : '')
    expect(settled?.state).toBe('succeeded')
    bed.coordinator.dispose()
  })

  it('does not abort the command when a held session is closed (#1111)', async () => {
    // The host closes a session by cancelling its maintenance first and
    // announcing `agent/disposed` once it is idle. The abort therefore lands
    // BEFORE the disposal event, and reading every abort as a lost hold
    // aborted the package command because an unrelated session was closed.
    // `forceDeferred` so the command runs under the barrier (the inline path
    // has no holds to lose).
    const bed = harness({ forceDeferred: true })
    const kept = new FakeAgent('kept')
    const closing = new FakeAgent('closing')
    bed.host.create(kept)
    bed.host.create(closing)
    let finishExecution!: () => void
    let started = false
    const result = await bed.begin(async () => {
      started = true
      // Hold the command open, the way pnpm running against real files does.
      await new Promise<void>(resolve => { finishExecution = resolve })
      return OK
    })
    expect(result.mode).toBe('deferred')
    if (result.mode !== 'deferred') return
    await vi.waitFor(() => { expect(started).toBe(true) })

    closing.abortMaintenance({ kind: 'disposed' })
    await vi.waitFor(() => { expect(bed.aborted.count).toBe(0) })

    // The command still runs to completion: one fewer session, not a broken
    // barrier.
    finishExecution()
    const settled = await bed.coordinator.whenSettled(result.operation.operationId)
    expect(settled?.state).toBe('succeeded')
    expect(bed.aborted.count).toBe(0)
    bed.coordinator.dispose()
  })

  it('retries a lost maintenance claim after the Agent goes idle and never cancels it', async () => {
    const bed = harness()
    const agent = new FakeAgent('main')
    agent.failClaims = 1
    bed.host.create(agent)
    let calls = 0

    const result = await bed.begin(async () => {
      calls += 1
      return OK
    })
    expect(result.mode).toBe('deferred')
    const settled = await bed.coordinator.whenSettled(result.mode === 'deferred' ? result.operation.operationId : '')
    expect(settled?.state).toBe('succeeded')
    expect(calls).toBe(1)
    expect(agent.cancelCalls).toBe(0)
    bed.coordinator.dispose()
  })

  it('aborts the package command when a hold is lost mid-mutation', async () => {
    const bed = harness()
    const agent = new FakeAgent('main', 'running')
    bed.host.create(agent)
    let release!: (result: DrainExecutionResult) => void
    const result = await bed.begin(async () => await new Promise(resolve => { release = resolve }))
    expect(result.mode).toBe('deferred')
    if (result.mode !== 'deferred') return
    agent.finishTurn()
    // Wait until the executor owns the package command.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(agent.held).toBe(true)

    agent.abortMaintenance()
    expect(bed.aborted.count).toBe(1)
    release({ status: 200, payload: { ok: true } })
    const settled = await bed.coordinator.whenSettled(result.operation.operationId)
    expect(settled?.state).toBe('failed')
    expect(settled?.failure?.code).toBe('AGENT_BARRIER_LOST')
    bed.coordinator.dispose()
  })

  describe('an Agent announced inside its own factory maintenance', () => {
    /** Run an inline operation and leave its package command open. */
    function midCommand(bed: Harness): {
      release: (result?: DrainExecutionResult) => void
      pending: ReturnType<DrainCoordinator['begin']>
    } {
      let finish!: (result: DrainExecutionResult) => void
      const pending = bed.begin(async () => await new Promise(resolve => { finish = resolve }))
      return { release: (result = OK) => finish(result), pending }
    }

    it('takes the hold when the factory ends instead of aborting the command', async () => {
      const bed = harness()
      const command = midCommand(bed)
      const late = new FakeAgent('late')

      const factory = bed.host.createInFactory(late)
      expect(bed.aborted.count).toBe(0)
      // The gate before the next package command must not misread it either.
      expect(bed.coordinator.assertCanMutate()).toEqual({ ok: true })

      await factory.finish()
      // Held by the time `create()` returns, so the first message stays queued.
      expect(late.held).toBe(true)
      late.followup()
      expect(late.status).toBe('idle')

      command.release()
      const result = await command.pending
      expect(result.mode === 'inline' && result.operation.state).toBe('succeeded')
      expect(bed.aborted.count).toBe(0)
      expect(late.cancelCalls).toBe(0)
      // The hold is gone and the queued message gets its turn.
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(late.held).toBe(false)
      expect(late.status).toBe('running')
      bed.coordinator.dispose()
    })

    it('holds it for a deferred operation too', async () => {
      const bed = harness()
      const first = new FakeAgent('first', 'running')
      bed.host.create(first)
      let release!: (result: DrainExecutionResult) => void
      const result = await bed.begin(async () => await new Promise(resolve => { release = resolve }))
      if (result.mode !== 'deferred') throw new Error(result.mode)
      first.finishTurn()
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(first.held).toBe(true)

      const late = new FakeAgent('late')
      const factory = bed.host.createInFactory(late)
      await factory.finish()
      expect(late.held).toBe(true)
      expect(bed.aborted.count).toBe(0)

      release(OK)
      const settled = await bed.coordinator.whenSettled(result.operation.operationId)
      expect(settled?.state).toBe('succeeded')
      bed.coordinator.dispose()
    })

    it('keeps waiting for it while still draining, and breaks nothing', async () => {
      const bed = harness()
      const first = new FakeAgent('first', 'running')
      bed.host.create(first)
      const result = await bed.begin()
      if (result.mode !== 'deferred') throw new Error(result.mode)

      const late = new FakeAgent('late')
      const factory = bed.host.createInFactory(late)
      first.finishTurn()
      await new Promise(resolve => setTimeout(resolve, 40))
      expect(bed.executed).toEqual([])
      expect(bed.coordinator.get(result.operation.operationId)?.state).toBe('draining')

      await factory.finish()
      const settled = await bed.coordinator.whenSettled(result.operation.operationId)
      expect(settled?.state).toBe('succeeded')
      expect(bed.aborted.count).toBe(0)
      bed.coordinator.dispose()
    })

    it('aborts the command when a wake latched in the factory starts a turn', async () => {
      const bed = harness()
      const command = midCommand(bed)
      const late = new FakeAgent('late')

      const factory = bed.host.createInFactory(late)
      late.followup()
      expect(bed.aborted.count).toBe(0)

      await factory.finish()
      expect(late.status).toBe('running')
      expect(bed.aborted.count).toBe(1)
      expect(bed.coordinator.assertCanMutate()).toMatchObject({ ok: false, reason: 'barrier-broken' })

      command.release()
      const result = await command.pending
      expect(result.mode === 'inline' && result.operation.failure?.code).toBe('AGENT_BARRIER_LOST')
      // That turn ending must not read as a clean claim afterwards.
      late.finishTurn()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(late.held).toBe(false)
      bed.coordinator.dispose()
    })

    it('refuses at the gate when a turn starts on a host that reports no status events', async () => {
      const bed = harness()
      const command = midCommand(bed)
      const late = new FakeAgent('late')

      const factory = bed.host.createInFactory(late)
      late.onStatus = null
      late.followup()
      await factory.finish()
      expect(late.status).toBe('running')
      expect(bed.coordinator.assertCanMutate()).toMatchObject({ ok: false, reason: 'agent-active', ids: ['late'] })

      late.finishTurn()
      command.release()
      await command.pending
      bed.coordinator.dispose()
    })

    it('calls the barrier broken only when the retried claim is refused too', async () => {
      const bed = harness()
      const command = midCommand(bed)
      const late = new FakeAgent('late')

      const factory = bed.host.createInFactory(late)
      expect(bed.aborted.count).toBe(0)
      late.failClaims = 1
      await factory.finish()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(late.held).toBe(false)
      expect(bed.aborted.count).toBe(1)

      command.release()
      const result = await command.pending
      expect(result.mode === 'inline' && result.operation.failure?.code).toBe('AGENT_BARRIER_LOST')
      bed.coordinator.dispose()
    })

    it('still aborts at once for an Agent announced mid-turn', async () => {
      const bed = harness()
      const command = midCommand(bed)
      bed.host.create(new FakeAgent('late', 'running'))
      expect(bed.aborted.count).toBe(1)

      command.release()
      const result = await command.pending
      expect(result.mode === 'inline' && result.operation.failure?.code).toBe('AGENT_BARRIER_LOST')
      bed.coordinator.dispose()
    })

    it('settles without waiting for a factory that outlasts the command and leaves no hold', async () => {
      const bed = harness()
      const command = midCommand(bed)
      const late = new FakeAgent('late')
      const factory = bed.host.createInFactory(late)

      command.release()
      const result = await command.pending
      expect(result.mode === 'inline' && result.operation.state).toBe('succeeded')
      expect(bed.aborted.count).toBe(0)

      await factory.finish()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(late.held).toBe(false)
      expect(() => late.startTurn()).not.toThrow()
      bed.coordinator.dispose()
    })

    it('does not outlive a cancel', async () => {
      const bed = harness()
      const first = new FakeAgent('first', 'running')
      bed.host.create(first)
      let release!: (result: DrainExecutionResult) => void
      const result = await bed.begin(async () => await new Promise(resolve => { release = resolve }))
      if (result.mode !== 'deferred') throw new Error(result.mode)
      first.finishTurn()
      await new Promise(resolve => setTimeout(resolve, 10))

      const late = new FakeAgent('late')
      const factory = bed.host.createInFactory(late)
      expect(bed.coordinator.cancel(result.operation.operationId)).toBe(true)
      expect(bed.aborted.count).toBe(1)
      release({ status: 200, payload: { ok: false, cancelled: true } })
      // Settles with the factory still open.
      const settled = await bed.coordinator.whenSettled(result.operation.operationId)
      expect(settled?.state).toBe('cancelled')
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(first.held).toBe(false)

      await factory.finish()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(late.held).toBe(false)
      expect(bed.aborted.count).toBe(1)
      bed.coordinator.dispose()
    })

    it('does not outlive an unload during the command', async () => {
      const bed = harness()
      const command = midCommand(bed)
      const late = new FakeAgent('late')
      const factory = bed.host.createInFactory(late)

      bed.coordinator.dispose()
      expect(bed.aborted.count).toBe(1)
      command.release()
      const result = await command.pending
      expect(result.mode === 'inline' && result.operation.failure?.code).toBe('MARKET_UNLOADED')

      await factory.finish()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(late.held).toBe(false)
    })

    it('holds an Agent whose factory failed until the command ends, then lets its teardown finish', async () => {
      // The host's order: the factory ends first, its teardown then waits on
      // `whenIdle`, and only after that does `agent/disposed` fire.
      const bed = harness()
      const command = midCommand(bed)
      const late = new FakeAgent('late')
      const factory = bed.host.createInFactory(late)
      await factory.finish()
      expect(late.held).toBe(true)

      let tornDown = false
      const teardown = late.whenIdle().then(() => { tornDown = true; bed.host.remove(late) })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(tornDown).toBe(false)

      command.release()
      const result = await command.pending
      await teardown
      expect(result.mode === 'inline' && result.operation.state).toBe('succeeded')
      expect(bed.aborted.count).toBe(0)
      bed.coordinator.dispose()
    })

    it('treats a rejected whenIdle as the end of the wait', async () => {
      const bed = harness()
      const command = midCommand(bed)
      const late = new FakeAgent('late')
      late.whenIdle = () => Promise.reject(new Error('the driver failed'))
      bed.host.createInFactory(late)
      await new Promise(resolve => setTimeout(resolve, 0))
      // Still in the factory, so the retried claim is refused: that is the broken barrier.
      expect(bed.aborted.count).toBe(1)

      command.release()
      const result = await command.pending
      expect(result.mode === 'inline' && result.operation.failure?.code).toBe('AGENT_BARRIER_LOST')
      bed.coordinator.dispose()
    })

    // A host that reports disposal inside the factory. The real host does not:
    // its teardown waits for the factory first, see the test above.
    it('does not claim or break anything for an Agent disposed inside its factory', async () => {
      const bed = harness()
      const command = midCommand(bed)
      const late = new FakeAgent('late')
      const factory = bed.host.createInFactory(late)

      bed.host.remove(late)
      await factory.finish()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(late.held).toBe(false)
      expect(bed.aborted.count).toBe(0)

      command.release()
      const result = await command.pending
      expect(result.mode === 'inline' && result.operation.state).toBe('succeeded')
      bed.coordinator.dispose()
    })
  })

  it('releases holds and records a cancel while the intent probe is still running', async () => {
    const host = new FakeHost()
    const records: DrainJournalRecord[] = []
    const coordinator = new DrainCoordinator({
      host,
      journal: { append: record => records.push(record) },
      bootId: 'boot-test',
      log: () => {},
      abortMutation: () => true,
    })
    const agent = new FakeAgent('main')
    const runner = new FakeAgent('runner', 'running')
    host.create(agent)
    host.create(runner)
    let resolveIntent!: (intent: DrainIntent) => void
    const pending = coordinator.begin({
      kind: 'update',
      name: 'dsh-loop',
      captureIntent: () => new Promise(resolve => { resolveIntent = resolve }),
      execute: async () => OK,
    })
    // The operation is deliberately not exposed while the probe runs: a probe
    // that is refused must not leave a Host row the client cannot clean up.
    // The idle Agent is NOT held yet either — #1095: nothing is claimed while
    // someone is mid-turn, so this session stays usable during the probe.
    await Promise.resolve()
    expect(agent.held).toBe(false)
    expect(coordinator.list()).toEqual([])
    const operationId = 'boot-test-drain-1'

    expect(coordinator.cancel(operationId)).toBe(true)
    await Promise.resolve()
    expect(agent.held).toBe(false)
    expect(() => agent.startTurn()).not.toThrow()
    expect(records).toEqual([])
    expect(coordinator.get(operationId)).toBeNull()

    resolveIntent({ kind: 'update', name: 'dsh-loop', expected: { target: 'dsh-loop@1.2.0' } })
    const result = await pending
    expect(result.mode).toBe('terminal')
    if (result.mode === 'terminal') {
      expect(result.status).toBe(200)
      expect(result.payload).toMatchObject({ ok: false, cancelled: true })
    }
    coordinator.dispose()
  })

  it('cancels before mutation without calling the executor and releases the hold', async () => {
    const bed = harness()
    const agent = new FakeAgent('main', 'running')
    bed.host.create(agent)
    let calls = 0
    const result = await bed.begin(async () => {
      calls += 1
      return OK
    })
    expect(result.mode).toBe('deferred')
    if (result.mode !== 'deferred') return

    expect(bed.coordinator.cancel(result.operation.operationId)).toBe(true)
    const settled = await bed.coordinator.whenSettled(result.operation.operationId)
    expect(settled?.state).toBe('cancelled')
    expect(calls).toBe(0)
    expect(bed.records.at(-1)).toMatchObject({ state: 'cancelled' })
    expect(agent.cancelCalls).toBe(0)
    bed.coordinator.dispose()
  })

  it('releases every hold on executor failure', async () => {
    const bed = harness()
    const agent = new FakeAgent('main', 'running')
    bed.host.create(agent)
    const result = await bed.begin(async () => ({ status: 500, payload: { ok: false, error: 'pnpm failed' } }))
    expect(result.mode).toBe('deferred')
    if (result.mode !== 'deferred') return
    agent.finishTurn()
    const settled = await bed.coordinator.whenSettled(result.operation.operationId)
    expect(settled).toMatchObject({ state: 'failed', failure: { code: 'MUTATION_FAILED', message: 'pnpm failed' } })
    // The fake's maintenance task settles only through the release.
    await Promise.resolve()
    expect(agent.maintenanceCalls).toBe(1)
    bed.coordinator.dispose()
  })

  it('releases every hold when the coordinator is disposed', async () => {
    const bed = harness()
    const agent = new FakeAgent('main', 'running')
    bed.host.create(agent)
    const result = await bed.begin(async () => OK)
    expect(result.mode).toBe('deferred')
    if (result.mode !== 'deferred') return
    bed.coordinator.dispose()
    const settled = await bed.coordinator.whenSettled(result.operation.operationId)
    expect(settled?.state).toBe('cancelled')
    expect(bed.records.at(-1)).toMatchObject({ state: 'cancelled' })
  })

  it('maps a changed target to TARGET_CHANGED and performs no mutation', async () => {
    const bed = harness()
    const agent = new FakeAgent('main', 'running')
    bed.host.create(agent)
    const result = await bed.begin(async () => ({
      status: 409,
      payload: { ok: false, targetChanged: true, error: 'target moved' },
    }))
    expect(result.mode).toBe('deferred')
    if (result.mode !== 'deferred') return
    agent.finishTurn()
    const settled = await bed.coordinator.whenSettled(result.operation.operationId)
    expect(settled?.state).toBe('failed')
    expect(settled?.failure?.code).toBe('TARGET_CHANGED')
    bed.coordinator.dispose()
  })

  it('projects the post-command phase as verifying', async () => {
    const bed = harness({ forceDeferred: true })
    const states: string[] = []
    const result = await bed.coordinator.begin({
      kind: 'update',
      name: 'dsh-loop',
      forceDeferred: true,
      captureIntent: async () => ({
        kind: 'update',
        name: 'dsh-loop',
        expected: { target: 'dsh-loop@1.2.0' },
      }),
      execute: async (_intent, onPhase) => {
        onPhase('verifying')
        return OK
      },
      onUpdate: view => states.push(view.state),
    })
    expect(result.mode).toBe('deferred')
    if (result.mode !== 'deferred') return
    await bed.coordinator.whenSettled(result.operation.operationId)
    expect(states).toContain('verifying')
    bed.coordinator.dispose()
  })

  it('never evicts the operation it just created', async () => {
    const bed = harness({ forceDeferred: true, maxRetained: 2 })
    for (let index = 0; index < 2; index += 1) {
      const result = await bed.begin(async () => OK)
      expect(result.mode).toBe('deferred')
      if (result.mode !== 'deferred') return
      await bed.coordinator.whenSettled(result.operation.operationId)
    }
    const third = await bed.begin(async () => OK)
    expect(third.mode).toBe('deferred')
    if (third.mode !== 'deferred') return
    expect(bed.coordinator.get(third.operation.operationId)).not.toBeNull()
    await bed.coordinator.whenSettled(third.operation.operationId)
    bed.coordinator.dispose()
  })

  it('refuses instead of mutating when the agent inventory becomes unreadable', async () => {
    const host = new FakeHost()
    let calls = 0
    const list = host.list.bind(host)
    host.list = () => {
      calls += 1
      if (calls > 1) throw new Error('agent registry disposed')
      return list()
    }
    let executed = false
    const coordinator = new DrainCoordinator({
      host,
      journal: { append: () => {} },
      bootId: 'boot-test',
      log: () => {},
    })
    const result = await coordinator.begin({
      kind: 'update',
      name: 'dsh-loop',
      captureIntent: async () => ({ kind: 'update', name: 'dsh-loop', expected: { target: 'dsh-loop@1.2.0' } }),
      execute: async () => {
        executed = true
        return OK
      },
    })
    expect(result.mode).toBe('unsupported')
    expect(executed).toBe(false)
    coordinator.dispose()
  })

  it('retries a claim whose maintenance task started with an aborted signal', async () => {
    const bed = harness({ forceDeferred: true })
    const agent = new FakeAgent('main')
    agent.startAbortedOnce = true
    bed.host.create(agent)

    const result = await bed.begin(async () => OK)
    expect(result.mode).toBe('deferred')
    if (result.mode !== 'deferred') return
    const settled = await bed.coordinator.whenSettled(result.operation.operationId)
    expect(settled?.state).toBe('succeeded')
    // The aborted attempt never became a hold; the real claim did.
    expect(agent.maintenanceCalls).toBe(1)
    expect(agent.cancelCalls).toBe(0)
    bed.coordinator.dispose()
  })

  it('asserts every live Agent is held and the operation still live before a mutation', async () => {
    const host = new FakeHost()
    const coordinator = new DrainCoordinator({
      host,
      journal: { append: () => {} },
      bootId: 'boot-test',
      log: () => {},
    })
    const main = new FakeAgent('main')
    host.create(main)
    let resolveIntent!: (intent: DrainIntent) => void
    const pending = coordinator.begin({
      kind: 'update',
      name: 'dsh-loop',
      forceDeferred: true,
      captureIntent: () => new Promise(resolve => { resolveIntent = resolve }),
      execute: async () => OK,
    })
    await Promise.resolve()
    expect(coordinator.assertCanMutate()).toEqual({ ok: true })

    const late = new FakeAgent('late', 'running')
    host.create(late)
    expect(coordinator.assertCanMutate()).toMatchObject({ ok: false, reason: 'agent-active', ids: ['late'] })
    host.remove(late)
    expect(coordinator.assertCanMutate()).toEqual({ ok: true })

    const list = host.list.bind(host)
    host.list = () => { throw new Error('agent registry disposed') }
    expect(coordinator.assertCanMutate()).toMatchObject({ ok: false, reason: 'agents-service-unavailable' })
    host.list = list

    expect(coordinator.cancel('boot-test-drain-1')).toBe(true)
    expect(coordinator.assertCanMutate()).toMatchObject({ ok: false, reason: 'cancelled' })
    resolveIntent({ kind: 'update', name: 'dsh-loop', expected: { target: 'dsh-loop@1.2.0' } })
    await pending

    coordinator.dispose()
    expect(coordinator.assertCanMutate()).toMatchObject({ ok: false, reason: 'market-unloaded' })
  })

  it('reports unsupported when an Inventory handle lacks the maintenance boundary', async () => {
    const bed = harness()
    bed.host.agents.push({ id: 'legacy', status: 'idle' } as never)
    const result = await bed.begin(async () => OK)
    expect(result.mode).toBe('unsupported')
    bed.coordinator.dispose()
  })

  it('does not latch drain off for an incompatible Agent created outside an operation', async () => {
    const bed = harness()
    const legacy = { id: 'legacy', status: 'idle' }
    bed.host.create(legacy as never)
    expect(bed.coordinator.support().supported).toBe(false)
    bed.host.remove(legacy as never)

    const agent = new FakeAgent('main')
    bed.host.create(agent)
    const result = await bed.begin(async () => OK)
    expect(result.mode).toBe('inline')
    if (result.mode !== 'inline') return
    expect(result.result.status).toBe(200)
    bed.coordinator.dispose()
  })

  it('keeps holds through a dispose mid-execution and settles MARKET_UNLOADED', async () => {
    const bed = harness()
    const agent = new FakeAgent('main', 'running')
    bed.host.create(agent)
    let release!: (result: DrainExecutionResult) => void
    const result = await bed.begin(async () => await new Promise(resolve => { release = resolve }))
    expect(result.mode).toBe('deferred')
    if (result.mode !== 'deferred') return
    agent.finishTurn()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(agent.held).toBe(true)

    bed.coordinator.dispose()
    // The command is still live: releasing now would leave nobody holding the
    // Agent while pnpm changes files.
    expect(agent.held).toBe(true)
    expect(bed.coordinator.assertCanMutate()).toMatchObject({ ok: false, reason: 'market-unloaded' })

    release({ status: 200, payload: { ok: true } })
    const settled = await bed.coordinator.whenSettled(result.operation.operationId)
    expect(settled?.state).toBe('cancelled')
    expect(settled?.failure?.code).toBe('MARKET_UNLOADED')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(agent.held).toBe(false)
  })

  it('does not abort an unrelated package command when unloaded with no active operation', () => {
    const bed = harness()
    bed.coordinator.dispose()
    expect(bed.aborted.count).toBe(0)
  })

  it('redacts home paths from a failed executor message', async () => {
    const home = homedir()
    const leaked = join(home, '.dsh', 'profiles', 'web')
    const bed = harness()
    const agent = new FakeAgent('main', 'running')
    bed.host.create(agent)
    const result = await bed.begin(async () => { throw new Error(`failed under ${leaked}`) })
    expect(result.mode).toBe('deferred')
    if (result.mode !== 'deferred') return
    agent.finishTurn()
    const settled = await bed.coordinator.whenSettled(result.operation.operationId)
    expect(settled?.failure?.message).not.toContain(home)
    expect(settled?.failure?.message).toContain('~')
    bed.coordinator.dispose()
  })

  it('suppresses probe logging', () => {
    expect(exportLogs({})).not.toContain('drain-probe-test')
    runInProbe(() => logEvent('info', 'drain-probe-test', 'must not be recorded'))
    expect(exportLogs({})).not.toContain('drain-probe-test')
    logEvent('info', 'drain-visible-test', 'recorded')
    expect(exportLogs({})).toContain('drain-visible-test')
  })
})

describe('DrainJournal', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('reads back only well-formed terminal records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drain-journal-'))
    dirs.push(dir)
    const file = join(dir, '.dsh-market', 'drain.ndjson')
    const journal = new DrainJournal(file)
    journal.append({ at: 1, id: 'boot-drain-1', kind: 'update', name: 'dsh-loop', state: 'succeeded', agentsAtStart: 2, agentsAtEnd: 0 })
    journal.append({ at: 2, id: 'boot-drain-2', kind: 'uninstall', name: 'dsh-old', state: 'failed', agentsAtStart: 1, agentsAtEnd: 1 })
    expect(journal.recent()).toHaveLength(2)

    const reread = new DrainJournal(file)
    expect(reread.recent()).toEqual([
      { at: 1, id: 'boot-drain-1', kind: 'update', name: 'dsh-loop', state: 'succeeded', agentsAtStart: 2, agentsAtEnd: 0 },
      { at: 2, id: 'boot-drain-2', kind: 'uninstall', name: 'dsh-old', state: 'failed', agentsAtStart: 1, agentsAtEnd: 1 },
    ])
  })

  it('keeps a record appended after an unterminated tail, and loses only the damaged line (#1084)', () => {
    // Reported with the production modules: a journal whose last write was
    // interrupted has no trailing newline, so the next append landed on the
    // same line — and on reopen BOTH records vanished, including the one that
    // had just completed. Losing the damaged line is correct; losing the
    // record written after it is not.
    const dir = mkdtempSync(join(tmpdir(), 'drain-journal-'))
    dirs.push(dir)
    const file = join(dir, '.dsh-market', 'drain.ndjson')
    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
    const row = (id: string): DrainJournalRecord => ({
      at: 1, id, kind: 'update', name: 'dsh-example', state: 'succeeded', agentsAtStart: 0, agentsAtEnd: 0,
    })
    writeFileSync(file, `${JSON.stringify(row('old'))}\n{"at":2,"id":"partial"`)

    const journal = new DrainJournal(file)
    journal.append(row('new-completed'))
    expect(journal.recent().map(record => record.id)).toEqual(['old', 'new-completed'])

    expect(new DrainJournal(file).recent().map(record => record.id)).toEqual(['old', 'new-completed'])
  })

  it('redacts home paths in the package name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drain-journal-'))
    dirs.push(dir)
    const file = join(dir, '.dsh-market', 'drain.ndjson')
    const home = homedir()
    const journal = new DrainJournal(file)
    journal.append({
      at: 1,
      id: 'boot-drain-1',
      kind: 'update',
      name: `plugin at ${join(home, '.dsh', 'profiles', 'web')}`,
      state: 'failed',
      agentsAtStart: 0,
      agentsAtEnd: 0,
    })
    expect(journal.recent()[0]?.name).not.toContain(home)
    expect(journal.recent()[0]?.name).toContain('~')
  })
})
