import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DrainCoordinator, type DrainExecutionResult, type DrainIntent, type DrainJournalRecord } from '../src/drain.ts'
import { DrainJournal } from '../src/drain-journal.ts'
import { exportLogs, logEvent } from '../src/log.ts'
import { runInProbe } from '../src/probe-context.ts'
import { FakeAgent } from './drain-agent.ts'

class FakeHost {
  agents: FakeAgent[] = []
  private created: Array<(agent: unknown) => void> = []
  private disposed: Array<(agent: unknown) => void> = []

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

  create(agent: FakeAgent): void {
    this.agents.push(agent)
    for (const listener of this.created) listener(agent)
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
    // A running Agent forces the deferred path; the idle one is held by the
    // same synchronous claim, which is what a cancel during the probe must
    // release.
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
    // `begin` claimed the idle Agent synchronously and is waiting on the probe.
    // The operation is deliberately not exposed yet: a probe that is refused
    // must not leave a Host row the client cannot clean up.
    await Promise.resolve()
    expect(agent.held).toBe(true)
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
