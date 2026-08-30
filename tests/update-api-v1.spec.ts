import { describe, expect, it } from 'vitest'
import { UpdateOperationStoreV1, UPDATE_API_V1_SCHEMA } from '../src/update-api-v1.ts'

describe('public update API v1 operation model', () => {
  it('scopes operation ids to the boot and exposes live structured progress', () => {
    let now = 100
    const store = new UpdateOperationStoreV1('boot-a', () => ++now)
    const created = store.create('dsh-mcp-connector', '0.2.24')
    expect(created).toMatchObject({
      schema: UPDATE_API_V1_SCHEMA,
      operationId: 'boot-a-update-1',
      state: 'queued',
      beforeVersion: '0.2.24',
    })

    store.start(created.operationId)
    const running = store.get(created.operationId, {
      active: true,
      target: 'dsh-mcp-connector@latest',
      startedAt: 1,
      lastLine: 'resolved 3 packages',
      phase: 'resolving',
      done: 3,
      total: 4,
      currentPackage: 'dsh-mcp-connector',
      downloaded: 1024,
      size: 2048,
      ndjson: true,
      error: null,
      cancelling: false,
    })
    expect(running).toMatchObject({
      state: 'running',
      progress: {
        phase: 'resolving',
        done: 3,
        total: 4,
        percent: 75,
        detail: 'resolved 3 packages',
      },
    })
    expect(store.hasActive()).toBe(true)
  })

  it('bounds retained terminal operations without evicting the active task', () => {
    const store = new UpdateOperationStoreV1('boot-limit', Date.now, 2)
    const first = store.create('one', '1.0.0')
    store.start(first.operationId)
    store.finish(first.operationId, 200, { ok: true }, '1.1.0')
    const second = store.create('two', '1.0.0')
    store.start(second.operationId)
    store.finish(second.operationId, 200, { ok: true }, '1.1.0')
    const active = store.create('three', '1.0.0')
    store.start(active.operationId)

    expect(store.get(first.operationId)).toBeNull()
    expect(store.get(second.operationId)).not.toBeNull()
    expect(store.get(active.operationId)).toMatchObject({ state: 'running' })
  })

  it('normalizes success, activation and a compatibility rollback token', () => {
    const store = new UpdateOperationStoreV1('boot-b')
    const operation = store.create('dsh-mcp-connector', '0.2.24')
    store.start(operation.operationId)
    const completed = store.finish(operation.operationId, 200, {
      ok: true,
      activation: { 'dsh-mcp-connector': { state: 'restart' } },
      compatibility: { rollbackId: 'private-rollback-7' },
    }, '0.2.25')

    expect(completed).toMatchObject({
      state: 'succeeded',
      installedVersion: '0.2.25',
      outcome: {
        restartRequired: true,
        rollback: { available: true, state: 'available' },
      },
      failure: null,
    })
    expect(completed).not.toHaveProperty('legacyRollbackId')

    expect(store.beginRollback(operation.operationId)).toBe('private-rollback-7')
    expect(store.finishRollback(operation.operationId, 200, { rolledBack: true }, '0.2.24')).toMatchObject({
      state: 'rolled-back',
      installedVersion: '0.2.24',
      outcome: {
        restartRequired: true,
        rollback: { available: false, state: 'succeeded' },
      },
    })
  })

  it('keeps a rollback retryable when a concurrent mutation temporarily blocks it', () => {
    const store = new UpdateOperationStoreV1('boot-rollback')
    const operation = store.create('dsh-mcp-connector', '0.2.24')
    store.start(operation.operationId)
    store.finish(operation.operationId, 200, {
      ok: true,
      compatibility: { rollbackId: 'rollback-private' },
    }, '0.2.25')
    store.beginRollback(operation.operationId)

    expect(store.finishRollback(operation.operationId, 409, { error: 'busy' })).toMatchObject({
      state: 'succeeded',
      outcome: { rollback: { available: true, state: 'failed', detail: 'busy' } },
    })
  })

  it('maps actionable failure codes without leaking the legacy response shape', () => {
    const store = new UpdateOperationStoreV1('boot-c')
    const operation = store.create('dsh-mcp-connector', '0.2.24')
    store.start(operation.operationId)
    const failed = store.finish(operation.operationId, 409, {
      agentsBusy: true,
      runningAgents: ['main'],
      error: 'An agent is running; wait for it to finish.',
      stderr: 'private implementation detail',
    }, '0.2.24')

    expect(failed).toMatchObject({
      state: 'failed',
      failure: {
        code: 'AGENTS_RUNNING',
        message: 'An agent is running; wait for it to finish.',
        retryable: true,
      },
    })
    expect(failed).not.toHaveProperty('stderr')
  })

  it('distinguishes release cooling from an unexplained unchanged version', () => {
    const store = new UpdateOperationStoreV1('boot-d')
    const fresh = store.create('one', '1.0.0')
    store.start(fresh.operationId)
    expect(store.finish(fresh.operationId, 502, {
      stale: true,
      staleReason: 'release-age',
      error: 'wait before retrying',
    }, '1.0.0')).toMatchObject({
      failure: { code: 'RELEASE_TOO_FRESH', retryable: true },
    })

    const unknown = store.create('two', '1.0.0')
    store.start(unknown.operationId)
    expect(store.finish(unknown.operationId, 502, {
      stale: true,
      staleReason: 'unknown',
      error: 'version did not change',
    }, '1.0.0')).toMatchObject({
      failure: { code: 'VERSION_UNCHANGED', retryable: true },
    })
  })

  it('preserves post-install version-integrity failures for provider clients', () => {
    const store = new UpdateOperationStoreV1('boot-version-integrity')
    const downgrade = store.create('dsh-mcp-connector', '0.2.24')
    store.start(downgrade.operationId)
    expect(store.finish(downgrade.operationId, 502, {
      failureCode: 'DOWNGRADE_DETECTED',
      error: 'resolved to 0.2.23; previous build restored',
    }, '0.2.24')).toMatchObject({
      state: 'failed',
      installedVersion: '0.2.24',
      failure: { code: 'DOWNGRADE_DETECTED', retryable: false },
    })

    const mismatch = store.create('dsh-mcp-connector', '0.2.24')
    store.start(mismatch.operationId)
    expect(store.finish(mismatch.operationId, 502, {
      failureCode: 'RESOLVED_VERSION_MISMATCH',
      error: 'targeted 0.2.25 but installed 0.2.24; previous build restored',
    }, '0.2.24')).toMatchObject({
      failure: { code: 'RESOLVED_VERSION_MISMATCH', retryable: true },
    })
  })
})
