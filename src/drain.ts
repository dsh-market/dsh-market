/**
 * Host-owned coordinator for Agent-safe deferred plugin mutations (#411).
 *
 * The safety invariant is #199's: plugin files must not be replaced or
 * removed while an Agent can still execute a turn against them. The market
 * already refuses such a mutation; this module removes the dead end by
 * waiting at DSH's public maintenance boundary instead.
 *
 * The mechanism is deliberately narrow. `runMaintenance()` claims a truly
 * idle Agent synchronously and latches later inbox work until the task
 * settles, so there is no poll-then-race window between "observed idle" and
 * pnpm. Existing turns are allowed to finish; nothing here calls
 * `Agent.cancel()`.
 *
 * One process-local coordinator owns one deferred operation at a time, every
 * maintenance hold, and the operation record the browser projects. The record
 * carries counts and ids only — never prompts, transcripts, tool input, or
 * paths (FR-11).
 */

import { drainableAgent, type DrainableAgent } from './agents.ts'
import { redactHomePaths } from './log-redaction.ts'

export type DrainKind = 'install' | 'update' | 'uninstall'

export type DrainState =
  | 'accepted'
  | 'draining'
  | 'queued-for-mutation'
  | 'running'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type DrainTerminalState = 'succeeded' | 'failed' | 'cancelled'

/** Why the operation is queued. Only `agents` exists in v1. */
export interface DrainWait {
  reason: 'agents'
  /**
   * Agents the operation is waiting on: those in a turn or, when none is, every
   * live Agent not yet maintenance-held. Refreshed when the drain loop wakes,
   * so it can lag behind a turn that just ended or started.
   */
  activeCount: number
  /** Their local session ids. With a turn running, the same ids as a 409's `runningAgents`. */
  activeAgentIds: string[]
  since: number
}

/** The immutable facts a delayed operation may not silently change. */
export interface DrainExpectation {
  /** install/update: the exact pnpm target (version, commit, or tarball). */
  target?: string
  /** update/uninstall: the installed spec the operation was approved against. */
  spec?: string
  /** update/uninstall: the installed version baseline, when readable. */
  version?: string | null
}

export interface DrainIntent {
  kind: DrainKind
  /** Package name, or the catalog name for an install. */
  name: string
  /** Catalog url, present for installs. */
  url?: string
  expected: DrainExpectation
}

export interface DrainFailure {
  code: string
  message: string
}

/** Bounded terminal facts the client needs to drive its existing banners. */
export interface DrainOutcome {
  needsRefresh: boolean
  restartRequired: boolean
  activation: string | null
  hot: boolean
}

/** The browser-facing projection of one operation. */
export interface DrainOperationView {
  operationId: string
  kind: DrainKind
  name: string
  url?: string
  state: DrainState
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  wait: DrainWait | null
  failure: DrainFailure | null
  outcome: DrainOutcome | null
}

/** The result of re-running the route's ordinary executor. */
export interface DrainExecutionResult {
  status: number
  payload: unknown
}

/** Why the executor may not touch the profile right now. */
export type DrainMutationReason =
  | 'market-unloaded'
  | 'cancelled'
  | 'barrier-broken'
  | 'agents-service-unavailable'
  | 'agent-active'

export type DrainMutationGate =
  | { ok: true }
  | { ok: false; reason: DrainMutationReason; ids: string[] }

export interface DrainJournalRecord {
  at: number
  id: string
  kind: DrainKind
  name: string
  state: DrainTerminalState
  agentsAtStart: number
  agentsAtEnd: number
}

export interface DrainJournalLike {
  append(record: DrainJournalRecord): void
}

/**
 * What the coordinator needs from the host.
 *
 * `list()` returns null when the host has no readable `agents` service.
 * The event methods return null when this host cannot report Agent creation
 * and disposal; without them the admission barrier is incomplete, so the
 * coordinator reports drain as unsupported rather than guessing.
 */
export interface DrainHost {
  list(): unknown[] | null
  onCreated(listener: (agent: unknown) => void): (() => void) | null
  onDisposed(listener: (agent: unknown) => void): (() => void) | null
  /** Status transitions; how a turn starting behind a new Agent's factory is seen. */
  onStatus?(listener: (agent: unknown, status: unknown) => void): (() => void) | null
}

export interface DrainBeginRequest {
  kind: DrainKind
  name: string
  url?: string
  /**
   * Capture the immutable intent. Called only when the operation actually has
   * to wait; the inline path executes immediately and needs no snapshot.
   */
  captureIntent: () => Promise<DrainIntent>
  /** Run the same executor the immediate path uses. */
  execute: (intent: DrainIntent | null, onPhase: (phase: 'verifying') => void) => Promise<DrainExecutionResult>
  /** Public API callers always project a queued 202, even with no Agent. */
  forceDeferred?: boolean
  /** Called on every state/wait change for exposed operations. */
  onUpdate?: (view: DrainOperationView) => void
}

export type DrainBeginResult =
  | { mode: 'inline'; operation: DrainOperationView; result: DrainExecutionResult }
  | { mode: 'deferred'; operation: DrainOperationView }
  /** The operation ended before it could be deferred (cancel, lost inventory). */
  | { mode: 'terminal'; operation: DrainOperationView; status: number; payload: unknown }
  | { mode: 'refused'; status: number; payload: unknown }
  | { mode: 'busy' }
  | { mode: 'unsupported'; reason: string; incompatibleIds: string[] }

/** A probe (or an ordinary route replay) refused the request before mutation. */
export class DrainRefusal extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
  ) {
    super('drain preflight refused')
  }
}

/**
 * The probe finished with a normal no-op (`skipped: "current"`). The route's
 * existing answer is the correct result; there is no operation to defer.
 */
export class DrainNoop extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
  ) {
    super('drain probe is a no-op')
  }
}

interface Hold {
  id: string
  release: () => void
  settled: boolean
}

interface Operation {
  id: string
  kind: DrainKind
  name: string
  url?: string
  state: DrainState
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  waitSince: number
  wait: DrainWait | null
  failure: DrainFailure | null
  outcome: DrainOutcome | null
  intent: DrainIntent | null
  initialAgents: number
  exposed: boolean
  cancelRequested: boolean
  settled: boolean
  resolveSettled: (view: DrainOperationView | null) => void
  execute: DrainBeginRequest['execute']
  onPhase: (phase: 'verifying') => void
  onUpdate?: ((view: DrainOperationView) => void) | undefined
}

export interface DrainCoordinatorOptions {
  host: DrainHost
  journal: DrainJournalLike
  bootId: string
  now?: () => number
  maxRetained?: number
  log?: (level: 'info' | 'warn' | 'error', event: string, detail: string) => void
  /** Stop the package command when a hold is lost mid-mutation. */
  abortMutation?: () => boolean
}

const MAX_RETAINED = 50
const VIEW_LIMIT = 10

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** User-facing failure text, stripped of control characters and home paths. */
function safeMessage(value: unknown): string | null {
  const raw = text(value)
  if (raw === null) return null
  return redactHomePaths(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1200)
}

function failureCode(status: number, payload: Record<string, unknown> | null): string {
  if (payload?.targetChanged === true) return 'TARGET_CHANGED'
  if (payload?.agentsBusy === true) return 'AGENTS_RUNNING'
  const explicit = text(payload?.failureCode)
  if (explicit !== null) return explicit
  if (payload?.busy === true || status === 409) return 'OPERATION_BUSY'
  return 'MUTATION_FAILED'
}

function outcomeOf(kind: DrainKind, name: string, payload: Record<string, unknown> | null): DrainOutcome {
  const activations = record(payload?.activation)
  const activation = activations === null ? null : record(activations[name])
  const activationState = activation === null ? null : text(activation.state)
  const hot = payload?.hot === true
  return {
    needsRefresh: payload?.needsRefresh === true
      || (kind === 'install' && !hot)
      || (activationState === 'live' && hot),
    restartRequired: activationState === 'restart',
    activation: activationState,
    hot,
  }
}

export class DrainCoordinator {
  private readonly host: DrainHost
  private readonly journal: DrainJournalLike
  private readonly bootId: string
  private readonly now: () => number
  private readonly maxRetained: number
  private readonly log: NonNullable<DrainCoordinatorOptions['log']>
  private readonly abortMutation: (() => boolean) | undefined
  private readonly operations = new Map<string, Operation>()
  private readonly holds = new Map<string, Hold>()
  /** New Agents still inside their factory's maintenance, claimed when it ends. */
  private readonly inFactory = new Map<string, DrainableAgent>()
  private readonly subscriptions: Array<() => void> = []
  private readonly activityWaiters = new Set<() => void>()
  private readonly subscribed: boolean
  private sequence = 0
  private active: Operation | null = null
  private disposeRequested = false
  private barrierBroken = false

  constructor(options: DrainCoordinatorOptions) {
    this.host = options.host
    this.journal = options.journal
    this.bootId = options.bootId
    this.now = options.now ?? Date.now
    this.maxRetained = options.maxRetained ?? MAX_RETAINED
    this.log = options.log ?? (() => {})
    this.abortMutation = options.abortMutation
    // Subscribe before the first inventory snapshot (FR-4). A host without
    // both events cannot close the creation race, so drain stays unsupported.
    const created = this.host.onCreated(agent => this.onAgentCreated(agent))
    const disposed = this.host.onDisposed(agent => this.onAgentDisposed(agent))
    if (created !== null) this.subscriptions.push(created)
    if (disposed !== null) this.subscriptions.push(disposed)
    this.subscribed = created !== null && disposed !== null
    const status = this.host.onStatus?.((agent, next) => this.onAgentStatus(agent, next)) ?? null
    if (status !== null) this.subscriptions.push(status)
  }

  /** Whether one deferred or running operation owns the lane. */
  hasActive(): boolean {
    return this.active !== null && !this.active.settled
  }

  /**
   * Whether the executor may still change files right now.
   *
   * Called under the mutation lock at the route entrance and again
   * immediately before every package command. The second call is the
   * load-bearing one: the validation between the two can take seconds on the
   * network, during which an Agent can become active, the user can cancel, or
   * the market can unload. It also re-enumerates live Agents and claims any
   * idle one that the creation subscription missed, so an undelivered
   * `agent/created` cannot let a turn start between the last wait and the file
   * change.
   */
  assertCanMutate(): DrainMutationGate {
    if (this.disposeRequested) return { ok: false, reason: 'market-unloaded', ids: [] }
    const active = this.active
    if (active === null || active.settled || active.cancelRequested) {
      return { ok: false, reason: 'cancelled', ids: [] }
    }
    if (this.barrierBroken) return { ok: false, reason: 'barrier-broken', ids: [] }
    const live = this.liveAgents()
    if (live === null) return { ok: false, reason: 'agents-service-unavailable', ids: [] }
    const unheld: string[] = []
    for (const agent of live) {
      if (this.holds.has(agent.id) || this.claim(agent)) continue
      // Still in its factory's maintenance: no turn can start there, and
      // `claimAfterFactory` either holds it or stops the command when that ends.
      if (this.inFactory.has(agent.id) && agent.status !== 'running') continue
      unheld.push(agent.id)
    }
    if (unheld.length > 0) return { ok: false, reason: 'agent-active', ids: unheld }
    return { ok: true }
  }

  /**
   * Whether this request may use drain mode.
   *
   * Re-evaluated per request: a host that gains an incompatible Agent handle
   * after mount must not be treated as drain-capable just because the service
   * exists.
   */
  support(): { supported: boolean; reason: string; incompatibleIds: string[] } {
    if (this.disposeRequested) return { supported: false, reason: 'unloading', incompatibleIds: [] }
    if (!this.subscribed) return { supported: false, reason: 'no-agent-events', incompatibleIds: [] }
    let listed: unknown[] | null
    try {
      listed = this.host.list()
    } catch {
      listed = null
    }
    if (listed === null) return { supported: false, reason: 'no-agents-service', incompatibleIds: [] }
    const incompatibleIds: string[] = []
    for (const entry of listed) {
      if (drainableAgent(entry) === null) incompatibleIds.push(agentId(entry) ?? 'agent')
    }
    if (incompatibleIds.length > 0) return { supported: false, reason: 'incompatible-agents', incompatibleIds }
    return { supported: true, reason: 'ok', incompatibleIds: [] }
  }

  /** The current process's exposed operations, active first, terminal newest last. */
  list(limit = VIEW_LIMIT): DrainOperationView[] {
    const exposed = [...this.operations.values()].filter(operation => operation.exposed)
    const active = exposed.filter(operation => !operation.settled)
    const terminal = exposed.filter(operation => operation.settled)
    const room = Math.max(0, limit - active.length)
    return active.concat(room === 0 ? [] : terminal.slice(-room)).map(operation => this.view(operation))
  }

  get(operationId: string): DrainOperationView | null {
    const operation = this.operations.get(operationId)
    return operation === undefined || !operation.exposed ? null : this.view(operation)
  }

  /**
   * Accept a drain request.
   *
   * With no Agent running this claims every idle Agent synchronously and runs
   * the ordinary executor inline, returning its normal response. Otherwise it
   * captures intent, returns a deferred record, and the drain loop waits.
   */
  async begin(request: DrainBeginRequest): Promise<DrainBeginResult> {
    if (this.disposeRequested) {
      return { mode: 'refused', status: 503, payload: { ok: false, error: 'the market is unloading' } }
    }
    if (this.hasActive()) return { mode: 'busy' }
    const support = this.support()
    if (!support.supported) {
      return { mode: 'unsupported', reason: support.reason, incompatibleIds: support.incompatibleIds }
    }
    const operation = this.createOperation(request)
    this.active = operation
    this.barrierBroken = false
    try {
      // Claim every idle Agent synchronously. A failure here means that Agent
      // is mid-turn or another maintenance task owns it, and the deferred loop
      // will wait for it instead of touching its files. An unreadable
      // inventory is not an empty one: refuse rather than mutate unheld.
      const live = this.liveAgents()
      if (live === null) {
        this.abandon(operation)
        return { mode: 'unsupported', reason: 'agents-service-unavailable', incompatibleIds: [] }
      }
      // #1095: claim only when the whole inventory is at a safe boundary. A
      // hold FREEZES an Agent, so claiming the idle ones while another is
      // mid-turn made every other session wait for that turn behind a barrier
      // that was itself waiting — 45 minutes in the report. With anyone still
      // running, `drainAgents` waits first and claims them all together.
      const busyNow = live.some(agent => agent.status === 'running')
      if (!busyNow) for (const agent of live) this.claim(agent)
      const afterClaims = this.liveAgents()
      if (afterClaims === null) {
        this.abandon(operation)
        return { mode: 'unsupported', reason: 'agents-service-unavailable', incompatibleIds: [] }
      }
      const unheld = afterClaims.filter(agent => !this.holds.has(agent.id))
      if (unheld.length === 0 && request.forceDeferred !== true) {
        return await this.runInline(operation)
      }

      // The probe may still be refused (`TARGET_CHANGED`, no-op, unsupported
      // host). Do not expose the operation until it is actually deferred:
      // publishing it now would leave the client with a Host row that the
      // Host then deletes, which the client has no event to clean up.
      operation.state = 'accepted'
      this.setWait(operation, unheld)
      const intent = await request.captureIntent()
      if (!operation.settled) {
        operation.intent = intent
        operation.name = intent.name
        if (intent.url !== undefined) operation.url = intent.url
      }
      if (operation.cancelRequested || operation.settled || this.disposeRequested) {
        if (!operation.settled) {
          this.releaseAll()
          this.finish(operation, 'cancelled', null, null)
        }
        return {
          mode: 'terminal',
          operation: this.view(operation),
          status: 200,
          payload: { ok: false, cancelled: true },
        }
      }
      operation.state = 'draining'
      const current = this.liveAgents()
      if (current === null) {
        this.releaseAll()
        this.finish(operation, 'failed', {
          code: 'AGENT_DRAIN_UNSUPPORTED',
          message: 'the host stopped offering a readable Agent inventory before the operation started',
        }, null)
        const view = this.view(operation)
        return {
          mode: 'terminal',
          operation: view,
          status: 500,
          payload: { ok: false, error: view.failure?.message ?? 'the host stopped offering a readable Agent inventory' },
        }
      }
      this.setWait(operation, current.filter(agent => !this.holds.has(agent.id)))
      this.notify(operation)
      void this.runDeferred(operation)
      return { mode: 'deferred', operation: this.view(operation) }
    } catch (error) {
      if (error instanceof DrainRefusal || error instanceof DrainNoop) {
        this.abandon(operation)
        return { mode: 'refused', status: error.status, payload: error.payload }
      }
      const message = safeMessage(error instanceof Error ? error.message : String(error))
        ?? 'the drain preflight failed'
      this.log('error', 'drain', `preflight failed before acceptance — ${message}`)
      this.abandon(operation)
      return { mode: 'refused', status: 500, payload: { ok: false, error: message } }
    }
  }

  /**
   * Cancel one exposed operation. Before the executor starts this performs no
   * mutation; after it starts, the existing package-command cancellation path
   * runs and the holds are released once it settles.
   */
  cancel(operationId: string): boolean {
    const operation = this.operations.get(operationId)
    if (operation === undefined || operation.settled) return false
    operation.cancelRequested = true
    this.notifyActivity()
    if (operation.state === 'running' || operation.state === 'verifying') {
      this.abortMutation?.()
      this.notify(operation)
      return true
    }
    if (operation.state === 'accepted') {
      // The intent probe may still be in flight. Finish now and release the
      // holds it already took; `begin` sees `settled` when the probe returns
      // and only reports the terminal view. Waiting for the probe here would
      // leave every claimed Agent parked for as long as it takes.
      this.releaseAll()
      this.finish(operation, 'cancelled', null, null)
      return true
    }
    this.finish(operation, 'cancelled', null, null)
    this.releaseAll()
    return true
  }

  /** Resolve after one operation reaches a terminal state. Tests and the API bridge use it. */
  async whenSettled(operationId: string): Promise<DrainOperationView | null> {
    const operation = this.operations.get(operationId)
    if (operation === undefined) return null
    if (operation.settled) return this.view(operation)
    return await new Promise(resolve => {
      const previous = operation.resolveSettled
      operation.resolveSettled = view => {
        previous(view)
        resolve(view)
      }
    })
  }

  /**
   * Release every hold, cancel the active operation, and detach the host
   * subscriptions. Called from the market's mount disposer; the second half of
   * the "finally + disposer" guarantee that no Agent is left parked.
   */
  dispose(): void {
    if (this.disposeRequested) return
    this.disposeRequested = true
    const active = this.active
    const executing = active !== null && !active.settled
      && (active.state === 'running' || active.state === 'verifying')
    const detach = (): void => {
      for (const dispose of this.subscriptions.splice(0)) {
        try { dispose() } catch { /* host already tore the subscription down */ }
      }
      this.notifyActivity()
    }
    if (executing) {
      // The executor is already inside a package command. Stop that command,
      // stop any later runPlugin through the pre-command gate, and leave the
      // holds and the Agent subscription in place until the drain loop's
      // finally runs: releasing or detaching now would leave a live command
      // changing files with nobody watching the Agents.
      this.abortMutation?.()
      return
    }
    if (active !== null && !active.settled) {
      this.finish(active, 'cancelled', {
        code: 'MARKET_UNLOADED',
        message: 'the market was unloaded before this operation finished',
      }, null)
    }
    this.releaseAll()
    detach()
  }

  /** Detach the host subscriptions once; safe to call more than once. */
  private detach(): void {
    for (const dispose of this.subscriptions.splice(0)) {
      try { dispose() } catch { /* host already tore the subscription down */ }
    }
    this.notifyActivity()
  }

  // -------------------------------------------------------------- drain loop

  private async runInline(operation: Operation): Promise<DrainBeginResult> {
    operation.exposed = false
    operation.state = 'running'
    operation.startedAt = this.now()
    let result: DrainExecutionResult
    try {
      result = await operation.execute(null, operation.onPhase)
    } catch (error) {
      result = {
        status: 500,
        payload: {
          ok: false,
          error: safeMessage(error instanceof Error ? error.message : String(error)) ?? 'the drain executor failed',
        },
      }
    } finally {
      this.releaseAll()
      if (this.disposeRequested) this.detach()
    }
    if (this.disposeRequested) {
      result = {
        status: 503,
        payload: {
          ok: false,
          failureCode: 'MARKET_UNLOADED',
          error: 'the market was unloaded before this operation finished',
        },
      }
      this.finish(operation, 'cancelled', {
        code: 'MARKET_UNLOADED',
        message: 'the market was unloaded before this operation finished',
      }, null)
    } else if (operation.cancelRequested) {
      result = { status: 200, payload: { ok: false, cancelled: true } }
      this.finish(operation, 'cancelled', null, null)
    } else if (this.barrierBroken) {
      result = {
        status: 500,
        payload: {
          ok: false,
          failureCode: 'AGENT_BARRIER_LOST',
          error: 'an Agent could not be held at the maintenance boundary; verify the installed files before retrying',
        },
      }
      this.finish(operation, 'failed', {
        code: 'AGENT_BARRIER_LOST',
        message: 'an Agent could not be held at the maintenance boundary; verify the installed files before retrying',
      }, null)
    } else {
      this.finishFromResult(operation, result)
    }
    return { mode: 'inline', operation: this.view(operation), result }
  }

  private async runDeferred(operation: Operation): Promise<void> {
    operation.exposed = true
    try {
      for (;;) {
        if (operation.cancelRequested || this.disposeRequested) {
          this.finish(operation, 'cancelled', null, null)
          return
        }
        if (this.barrierBroken) {
          this.finish(operation, 'failed', {
            code: 'AGENT_BARRIER_LOST',
            message: 'an Agent could not be held at the maintenance boundary; the plugin operation was not started',
          }, null)
          return
        }
        const held = await this.drainAgents(operation)
        if (!held) {
          if (operation.cancelRequested || this.disposeRequested) {
            this.finish(operation, 'cancelled', null, null)
          } else if (this.barrierBroken) {
            this.finish(operation, 'failed', {
              code: 'AGENT_BARRIER_LOST',
              message: 'an Agent could not be held at the maintenance boundary; the plugin operation was not started',
            }, null)
          } else {
            this.finish(operation, 'failed', {
              code: 'AGENT_DRAIN_UNSUPPORTED',
              message: 'the host stopped offering a usable Agent maintenance boundary',
            }, null)
          }
          return
        }
        // Final synchronous re-enumeration. The creation subscription can claim
        // a new Agent only if the host announces it outside its factory's
        // maintenance; if one is still unheld, go back to waiting instead of
        // mutating under it. An unreadable inventory is a failure, not an empty
        // list.
        const live = this.liveAgents()
        if (live === null) {
          this.finish(operation, 'failed', {
            code: 'AGENT_DRAIN_UNSUPPORTED',
            message: 'the host stopped offering a readable Agent inventory before the operation started',
          }, null)
          return
        }
        let allHeld = true
        for (const agent of live) {
          if (!this.holds.has(agent.id) && !this.claim(agent)) allHeld = false
        }
        if (this.barrierBroken) continue
        const afterClaims = this.liveAgents()
        if (afterClaims === null) {
          this.finish(operation, 'failed', {
            code: 'AGENT_DRAIN_UNSUPPORTED',
            message: 'the host stopped offering a readable Agent inventory before the operation started',
          }, null)
          return
        }
        if (!allHeld || afterClaims.some(agent => !this.holds.has(agent.id))) continue
        break
      }

      operation.state = 'queued-for-mutation'
      this.notify(operation)
      if (operation.cancelRequested) {
        this.finish(operation, 'cancelled', null, null)
        return
      }
      operation.state = 'running'
      operation.startedAt = this.now()
      this.notify(operation)
      const result = await operation.execute(operation.intent, operation.onPhase)
      // The executor can return success after a cancel or unload landed too
      // late for its last gate. The Host's state wins: the user asked to stop
      // or the market is gone, so this is not reported as a completed change.
      if (this.disposeRequested) {
        this.finish(operation, 'cancelled', {
          code: 'MARKET_UNLOADED',
          message: 'the market was unloaded before this operation finished',
        }, null)
        return
      }
      if (operation.cancelRequested) {
        this.finish(operation, 'cancelled', null, null)
        return
      }
      if (this.barrierBroken) {
        this.finish(operation, 'failed', {
          code: 'AGENT_BARRIER_LOST',
          message: 'an Agent started work while the package operation was running; verify the installed files before retrying',
        }, null)
        return
      }
      this.finishFromResult(operation, result)
    } catch (error) {
      if (!operation.settled) {
        this.finish(operation, 'failed', {
          code: 'DRAIN_FAILED',
          message: safeMessage(error instanceof Error ? error.message : String(error))
            ?? 'the drain coordinator failed',
        }, null)
      }
    } finally {
      this.releaseAll()
      if (!operation.settled) {
        if (this.disposeRequested) {
          this.finish(operation, 'cancelled', {
            code: 'MARKET_UNLOADED',
            message: 'the market was unloaded before this operation finished',
          }, null)
        } else {
          this.finish(operation, 'failed', { code: 'DRAIN_FAILED', message: 'the drain coordinator stopped unexpectedly' }, null)
        }
      }
      if (this.disposeRequested) this.detach()
    }
  }

  /**
   * Wait until every live Agent is maintenance-held.
   * @returns true when the barrier is complete, false on cancel/dispose/loss.
   */
  private async drainAgents(operation: Operation): Promise<boolean> {
    operation.state = 'draining'
    let stall = 0
    while (!operation.cancelRequested && !this.disposeRequested && !this.barrierBroken) {
      const live = this.liveAgents()
      if (live === null) return false
      const unheld = live.filter(agent => !this.holds.has(agent.id))
      this.setWait(operation, unheld)
      if (unheld.length === 0) return true
      // #1095: a hold FREEZES the Agent — its queued messages wait for the
      // barrier, and the barrier waits for whoever is still in a turn. The
      // reported case held every idle session for 45 minutes behind one long
      // turn, while the UI still called them idle. Claim only once nothing is
      // running, so waiting for one session costs the others nothing.
      const busy = unheld.some(agent => agent.status === 'running')
      let waiting = unheld
      if (!busy) {
        for (const agent of unheld) {
          if (operation.cancelRequested || this.disposeRequested) break
          this.claim(agent)
        }
        const current = this.liveAgents()
        if (current === null) return false
        waiting = current.filter(agent => !this.holds.has(agent.id))
        this.setWait(operation, waiting)
        if (waiting.length === 0) return true
      }
      const heldBefore = this.holds.size
      const signature = waiting.map(agent => `${agent.id}:${String(agent.status)}`).join('\u0000')
      const activity = this.waitForActivity()
      try {
        await Promise.race([
          Promise.all(waiting.map(agent => agent.whenIdle().catch(() => undefined))),
          activity.promise,
        ])
      } finally {
        activity.dispose()
      }
      // A pass can come back with nothing changed — no hold gained and every
      // waited-for Agent in the same state — and then re-entering the loop
      // immediately is a busy loop. Two host shapes do that: a claim refused
      // while the Agent reports idle (another maintenance task owns it, so
      // `whenIdle()` resolves at once), and an Agent whose status still says
      // `running` after its turn is over (sessions left behind by an earlier
      // run), where `whenIdle()` also resolves at once. A profile with 81 such
      // sessions pinned one core at 100% and grew RSS until DSH was restarted
      // (#1134). Pause only when nothing moved: a turn that just ended changes
      // the signature and is retried at once, which is what makes the wait end
      // the moment the Agent is free.
      const moved = this.holds.size !== heldBefore
        || waiting.map(agent => `${agent.id}:${String(agent.status)}`).join('\u0000') !== signature
      stall = moved ? 0 : stall + 1
      // One pass without progress is ordinary: `whenIdle()` resolving is what
      // the next pass claims on, and it costs nothing to retry at once. A
      // SECOND consecutive pass with nothing changed means the wake-up came
      // from something that will keep answering instantly — an Agent whose
      // status still says `running` after its turn ended (sessions left behind
      // by an earlier run), or a claim another maintenance task keeps
      // refusing. Looping on that pinned one core at 100% and grew RSS until
      // DSH was restarted (#1134). Pause instead; a status change or any host
      // activity cuts the pause short, so a real turn end is claimed at once.
      if (stall >= 2) {
        const wake = this.waitForActivity()
        try {
          await Promise.race([new Promise<void>(resolve => setTimeout(resolve, 25)), wake.promise])
        } finally {
          wake.dispose()
        }
      }
    }
    return false
  }

  // -------------------------------------------------------------- hold logic

  private claim(agent: DrainableAgent): boolean {
    if (this.holds.has(agent.id)) return true
    let releaseHeld!: () => void
    const held = new Promise<void>(resolve => { releaseHeld = resolve })
    const hold: Hold = {
      id: agent.id,
      settled: false,
      release: () => {
        if (hold.settled) return
        hold.settled = true
        releaseHeld()
      },
    }
    // Record the hold BEFORE calling into the host: `runMaintenance` may
    // invoke the task synchronously, and an already-aborted signal settles
    // the hold before this function regains control. Setting it afterwards
    // would leave a settled entry that later claims mistake for a real hold.
    this.holds.set(agent.id, hold)
    try {
      // `runMaintenance` claims synchronously. A synchronous throw means a turn
      // or another maintenance task already owns the Agent; the caller waits.
      const running = agent.runMaintenance<void>(signal => {
        const onAbort = () => {
          hold.release()
          // #1111: the host tears a closing session down by cancelling its
          // maintenance FIRST and announcing `agent/disposed` after it has
          // gone idle. Abort therefore arrives before the disposal event, and
          // treating every abort as a lost hold aborted the package command
          // because an unrelated session was closed. `reason.kind` is the
          // host's own word for it; a disposed Agent is one fewer session, not
          // a session that started working.
          this.onHoldLost(hold, signal.reason)
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
        return held
      })
      void running.catch(() => {
        hold.release()
        this.onHoldLost(hold)
      })
    } catch {
      if (this.holds.get(agent.id) === hold) this.holds.delete(agent.id)
      return false
    }
    if (hold.settled) {
      if (this.holds.get(agent.id) === hold) this.holds.delete(agent.id)
      return false
    }
    return true
  }

  private onHoldLost(hold: Hold, reason?: unknown): void {
    if (this.holds.get(hold.id) === hold) this.holds.delete(hold.id)
    // A session being closed is not a session starting work (#1111). Its hold
    // ends here; the disposal event that follows finds nothing left to release.
    if (reason !== null && typeof reason === 'object'
      && (reason as { kind?: unknown }).kind === 'disposed') {
      this.notifyActivity()
      return
    }
    const active = this.active
    if (active === null || active.settled) {
      this.notifyActivity()
      return
    }
    if (active.state === 'running' || active.state === 'verifying') {
      // The package command is already replacing files. Stop it rather than
      // leaving a turn running against them; the operation reports failure.
      this.barrierBroken = true
      this.abortMutation?.()
      this.log('error', 'drain', 'maintenance hold was lost during the package operation; aborting it')
    }
    this.notifyActivity()
  }

  private releaseAll(): void {
    for (const hold of this.holds.values()) hold.release()
    this.holds.clear()
    this.inFactory.clear()
  }

  private onAgentCreated(agent: unknown): void {
    const drainable = drainableAgent(agent)
    if (drainable === null) {
      // An incompatible handle only matters while an operation owns the
      // barrier. Outside an operation it must not latch drain off for the rest
      // of the process: support() is re-evaluated per request.
      const active = this.active
      if (active !== null && !active.settled) {
        this.barrierBroken = true
        if (active.state === 'running' || active.state === 'verifying') this.abortMutation?.()
      }
      this.notifyActivity()
      return
    }
    const active = this.active
    if (active !== null && !active.settled) {
      const claimed = this.claim(drainable)
      if (!claimed && (active.state === 'running' || active.state === 'verifying')) {
        if (drainable.status === 'running') {
          this.barrierBroken = true
          this.abortMutation?.()
        } else {
          this.claimAfterFactory(drainable)
        }
      }
    }
    this.notifyActivity()
  }

  /**
   * The host announces `agent/created` from inside the factory's own
   * maintenance, so a claim made by the listener is refused with no turn in
   * sight. Nothing can start a turn until that maintenance ends, so take the
   * hold at that point; only a refusal then is a broken barrier.
   *
   * The package command does not wait for this, and neither may the listener:
   * the host's serial dispatch awaits its listeners, and the factory awaits the
   * dispatch. `releaseAll` empties the map when the operation settles, so a
   * factory that outlives the operation leaves nothing behind but a no-op.
   */
  private claimAfterFactory(agent: DrainableAgent): void {
    this.inFactory.set(agent.id, agent)
    // Directly on `whenIdle`: this has to run before `create()` returns to its
    // caller, whose first message would otherwise start a turn ahead of the hold.
    const retry = (): void => {
      if (this.inFactory.get(agent.id) !== agent) return
      this.inFactory.delete(agent.id)
      if (!this.claim(agent)) this.loseNewAgent('a new Agent could not be held once it was created')
    }
    void agent.whenIdle().then(retry, retry)
  }

  /**
   * A message latched during the factory starts its turn the moment the factory
   * ends, and `whenIdle` then resolves only after that turn. The retry would
   * succeed and hide it, so the transition itself has to stop the command.
   */
  private onAgentStatus(agent: unknown, status: unknown): void {
    // Any status transition is news to whoever is waiting: a turn ending is
    // exactly the event the drain loop is waiting for, and it also cuts short
    // the no-progress pause (#1134).
    this.notifyActivity()
    if (status !== 'running') return
    const id = agentId(agent)
    if (id === null || !this.inFactory.delete(id)) return
    this.loseNewAgent('a new Agent started a turn before it could be held')
  }

  private loseNewAgent(why: string): void {
    this.barrierBroken = true
    this.abortMutation?.()
    this.log('error', 'drain', `${why}; aborting the package operation`)
  }

  private onAgentDisposed(agent: unknown): void {
    const id = agentId(agent)
    if (id !== null) {
      this.inFactory.delete(id)
      const hold = this.holds.get(id)
      if (hold !== undefined) {
        this.holds.delete(id)
        hold.release()
      }
    }
    this.notifyActivity()
  }

  // ------------------------------------------------------------- operations

  private createOperation(request: DrainBeginRequest): Operation {
    const operationId = `${this.bootId}-drain-${String(++this.sequence)}`
    const createdAt = this.now()
    let resolveSettled: (view: DrainOperationView | null) => void = () => {}
    const operation: Operation = {
      id: operationId,
      kind: request.kind,
      name: request.name,
      ...(request.url === undefined ? {} : { url: request.url }),
      state: 'accepted',
      createdAt,
      startedAt: null,
      finishedAt: null,
      waitSince: createdAt,
      wait: null,
      failure: null,
      outcome: null,
      intent: null,
      initialAgents: this.liveAgents()?.length ?? 0,
      exposed: request.forceDeferred === true,
      cancelRequested: false,
      settled: false,
      resolveSettled,
      execute: request.execute,
      onPhase: phase => {
        if (operation.settled || operation.state !== 'running') return
        operation.state = phase === 'verifying' ? 'verifying' : operation.state
        this.notify(operation)
      },
      onUpdate: request.onUpdate,
    }
    this.operations.set(operationId, operation)
    // The new operation is the one that must survive eviction. Mark it active
    // before trimming so the oldest terminal record is the one dropped.
    this.active = operation
    while (this.operations.size > this.maxRetained) {
      const oldest = [...this.operations.values()].find(candidate => candidate !== this.active && candidate.settled)
        ?? [...this.operations.values()].find(candidate => candidate !== this.active)
      if (oldest === undefined) break
      this.operations.delete(oldest.id)
    }
    return operation
  }

  private abandon(operation: Operation): void {
    this.releaseAll()
    if (this.active === operation) this.active = null
    this.operations.delete(operation.id)
    operation.settled = true
    operation.resolveSettled(null)
  }

  private finishFromResult(operation: Operation, result: DrainExecutionResult): void {
    const payload = record(result.payload)
    const cancelled = payload?.cancelled === true
    const ok = result.status >= 200 && result.status < 300 && payload?.ok !== false && !cancelled
    const state: DrainTerminalState = cancelled ? 'cancelled' : ok ? 'succeeded' : 'failed'
    const failure = ok || cancelled
      ? null
      : {
          code: failureCode(result.status, payload),
          message: safeMessage(payload?.error) ?? `mutation failed with HTTP ${String(result.status)}`,
        }
    this.finish(operation, state, failure, ok ? outcomeOf(operation.kind, operation.name, payload) : null)
  }

  private finish(
    operation: Operation,
    state: DrainTerminalState,
    failure: DrainFailure | null,
    outcome: DrainOutcome | null,
  ): void {
    if (operation.settled) return
    operation.settled = true
    operation.state = state
    operation.finishedAt = this.now()
    operation.wait = null
    operation.failure = failure
    operation.outcome = outcome
    if (this.active === operation) this.active = null
    if (operation.exposed) {
      try {
        this.journal.append({
          at: operation.finishedAt,
          id: operation.id,
          kind: operation.kind,
          name: operation.name,
          state,
          agentsAtStart: operation.initialAgents,
          agentsAtEnd: this.liveAgents()?.length ?? 0,
        })
      } catch (error) {
        this.log('warn', 'drain', `terminal record could not be persisted — ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.log(state === 'succeeded' ? 'info' : state === 'cancelled' ? 'info' : 'warn', 'drain',
      `${operation.kind} ${operation.name}: ${state}${failure === null ? '' : ` (${failure.code})`}`)
    this.notify(operation)
    operation.resolveSettled(this.view(operation))
  }

  private view(operation: Operation): DrainOperationView {
    return {
      operationId: operation.id,
      kind: operation.kind,
      name: operation.name,
      ...(operation.url === undefined ? {} : { url: operation.url }),
      state: operation.state,
      createdAt: operation.createdAt,
      startedAt: operation.startedAt,
      finishedAt: operation.finishedAt,
      wait: operation.wait === null ? null : { ...operation.wait, activeAgentIds: [...operation.wait.activeAgentIds] },
      failure: operation.failure === null ? null : { ...operation.failure },
      outcome: operation.outcome === null ? null : { ...operation.outcome },
    }
  }

  private notify(operation: Operation): void {
    if (!operation.exposed || operation.onUpdate === undefined) return
    try {
      operation.onUpdate(this.view(operation))
    } catch {
      // A projection failure must never take the coordinator down.
    }
  }

  private setWait(operation: Operation, unheld: DrainableAgent[]): void {
    // #1095: nothing is claimed while anyone is mid-turn, so the idle Agents are
    // unheld too, yet they already sit at a safe boundary. Name only the turns
    // being waited for. With none running, list whoever is unheld: `drainAgents`
    // claims them in the same tick, so what stays visible is those that refused
    // (another maintenance task owns them).
    const running = unheld.filter(agent => agent.status === 'running')
    const ids = (running.length > 0 ? running : unheld).map(agent => agent.id).sort()
    const previous = operation.wait
    if (
      previous !== null
      && previous.activeCount === ids.length
      && previous.activeAgentIds.join('\u0000') === ids.join('\u0000')
    ) return
    operation.wait = ids.length === 0
      ? null
      : { reason: 'agents', activeCount: ids.length, activeAgentIds: ids, since: operation.waitSince }
    this.notify(operation)
  }

  /**
   * The live Agent handles, or null when the host's inventory is unreadable.
   *
   * Null is not an empty list: treating a half-disposed registry as "no
   * Agents" would let a drain request mutate files without holding anything.
   */
  private liveAgents(): DrainableAgent[] | null {
    let listed: unknown[] | null
    try {
      listed = this.host.list()
    } catch {
      return null
    }
    if (listed === null) return null
    const agents: DrainableAgent[] = []
    for (const entry of listed) {
      const agent = drainableAgent(entry)
      if (agent !== null && !agents.some(candidate => candidate.id === agent.id)) agents.push(agent)
    }
    return agents
  }

  private waitForActivity(): { promise: Promise<void>; dispose: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>(r => { resolve = r })
    const entry = () => resolve()
    this.activityWaiters.add(entry)
    return {
      promise,
      dispose: () => { this.activityWaiters.delete(entry) },
    }
  }

  private notifyActivity(): void {
    const waiters = [...this.activityWaiters]
    this.activityWaiters.clear()
    for (const resolve of waiters) resolve()
  }
}

function agentId(agent: unknown): string | null {
  if (agent === null || typeof agent !== 'object') return null
  const id = (agent as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : null
}
