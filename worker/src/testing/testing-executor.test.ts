import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  computeLocalQARuntimeSnapshotDigest,
  computeTestingCurrentClaimDigest,
  computeTestingReconcileTaskPayloadDigest,
  computeTestingTaskPayloadDigest,
  digestJson,
  testingAuthorizationResolutionSchema,
  testingClaimResponseSchema,
  testingReconcileClaimResponseSchema,
  type LocalQAControlRequest,
  type LocalQARunRequest,
  type LocalQARuntimeSnapshot,
  type TestingAuthorizationResolutionRequest,
  type TestingCurrentClaimEnvelope,
  type TestingReconcileTask,
  type TestingTask,
  type TestingRuntimeAttempt
} from '@talos/testing-protocol';
import type { TestingWorkerControlPlane } from './control-plane-client.js';
import { LocalQARuntimeAdapterError, type LocalQARuntimeAdapter } from './runtime-adapter.js';
import {
  TestingExecutor,
  TestingWorkerRuntime,
  type TestingAuthorizationResolver
} from './testing-executor.js';

const digest = `sha256:${'a'.repeat(64)}`;
const observedAt = '2026-08-24T00:00:00.000Z';
const deadline = '2026-08-24T00:10:00.000Z';
const clock = () => Date.parse(observedAt);
const signature = `ed25519:${'A'.repeat(86)}`;

describe('TestingExecutor', () => {
  it('projects a fixed pointer-only task to Runtime and commits only bounded terminal refs', async () => {
    const fixture = startFixture();
    const calls: string[] = [];
    let submitted: LocalQARunRequest | undefined;
    const terminal = snapshot(fixture.attempt, 'terminal', 'passed');
    const controlPlane = fakeControlPlane(fixture, calls);
    const runtime: LocalQARuntimeAdapter = {
      getCapabilities: async () => capabilities(fixture.claim.task.runner),
      submitRun: async (request) => {
        calls.push('submit');
        submitted = request;
        return {
          schema_version: 'local-qa-runtime-admission/v1',
          disposition: 'new',
          accepted: true,
          run_id: fixture.attempt.run_id,
          request_digest: request.request_digest,
          attempt: fixture.attempt,
          journal_version: 1,
          snapshot: terminal
        };
      },
      getSnapshot: async () => terminal,
      listEvents: async () => eventPage(fixture.attempt.run_id),
      cancelRun: async () => { throw new Error('cancel must not run'); },
      reconcileTerminal: async () => { throw new Error('reconcile must not run'); }
    };
    await new TestingExecutor({
      controlPlane,
      runtime,
      authorizations: resolver(),
      heartbeatMs: 60_000,
      clock
    }).runStart(fixture.claim);

    expect(calls).toEqual(['heartbeat', 'submit', 'accept', 'commit:completed']);
    expect(submitted?.task.inputs.structured_plan).toEqual(fixture.claim.task.inputs.structured_plan);
    expect(JSON.stringify(submitted)).not.toContain(fixture.claim.lease_token);
    expect(submitted).not.toHaveProperty('goal');
    expect(submitted?.request_id).toMatch(/^start-[a-f0-9]{64}$/);
    expect(submitted?.idempotency_key).toMatch(/^start:[a-f0-9]{64}$/);
  });

  it('rejects an altered task payload even when the attacker recomputes its unsigned payload digest', async () => {
    const fixture = startFixture();
    const calls: string[] = [];
    const alteredTaskWithoutDigest = {
      ...fixture.claim.task,
      inputs: {
        ...fixture.claim.task.inputs,
        structured_plan: {
          ...fixture.claim.task.inputs.structured_plan,
          digest: `sha256:${'b'.repeat(64)}`
        }
      }
    };
    const alteredClaim = {
      ...fixture.claim,
      task: {
        ...alteredTaskWithoutDigest,
        task_payload_digest: computeTestingTaskPayloadDigest(alteredTaskWithoutDigest)
      }
    };
    const runtimeCapabilities = vi.fn(async () => capabilities(fixture.claim.task.runner));
    const resolveAuthorization = vi.fn();

    await expect(new TestingExecutor({
      controlPlane: fakeControlPlane(fixture, calls),
      runtime: {
        getCapabilities: runtimeCapabilities,
        submitRun: async () => { throw new Error('must not submit'); },
        getSnapshot: async () => { throw new Error('must not read'); },
        listEvents: async () => { throw new Error('must not read'); },
        cancelRun: async () => { throw new Error('must not cancel'); },
        reconcileTerminal: async () => { throw new Error('must not reconcile'); }
      },
      authorizations: { resolve: resolveAuthorization },
      heartbeatMs: 60_000,
      clock
    }).runStart(alteredClaim)).rejects.toMatchObject({ code: 'invalid_testing_claim' });
    expect(calls).toEqual([]);
    expect(runtimeCapabilities).not.toHaveBeenCalled();
    expect(resolveAuthorization).not.toHaveBeenCalled();
  });

  it('fails closed on unsupported Runtime capability without submitting or falling back', async () => {
    const fixture = startFixture();
    const calls: string[] = [];
    await new TestingExecutor({
      controlPlane: fakeControlPlane(fixture, calls),
      runtime: {
        getCapabilities: async () => capabilities({ package_id: 'other-runner', version: '1.0.0', digest }),
        submitRun: async () => { calls.push('submit'); throw new Error('must not submit'); },
        getSnapshot: async () => { throw new Error('must not read'); },
        listEvents: async () => { throw new Error('must not read'); },
        cancelRun: async () => { throw new Error('must not cancel'); },
        reconcileTerminal: async () => { throw new Error('must not reconcile'); }
      },
      authorizations: resolver(),
      heartbeatMs: 60_000,
      clock
    }).runStart(fixture.claim);
    expect(calls).toEqual(['heartbeat']);
  });

  it('uses the Runtime-advertised event page limit', async () => {
    const fixture = startFixture();
    const calls: string[] = [];
    const running = snapshot(fixture.attempt, 'executing');
    const terminal = snapshot(fixture.attempt, 'terminal', 'passed');
    let requestedLimit: number | undefined;
    await new TestingExecutor({
      controlPlane: fakeControlPlane(fixture, calls),
      runtime: {
        getCapabilities: async () => capabilities(fixture.claim.task.runner, 7),
        submitRun: async (request) => ({
          schema_version: 'local-qa-runtime-admission/v1',
          disposition: 'new',
          accepted: true,
          run_id: fixture.attempt.run_id,
          request_digest: request.request_digest,
          attempt: fixture.attempt,
          journal_version: 1,
          snapshot: running
        }),
        getSnapshot: async () => terminal,
        listEvents: async (_runId, after, limit) => {
          requestedLimit = limit;
          return eventPage(fixture.attempt.run_id, after, terminal.snapshot_digest);
        },
        cancelRun: async () => { throw new Error('must not cancel'); },
        reconcileTerminal: async () => { throw new Error('must not reconcile'); }
      },
      authorizations: resolver(),
      heartbeatMs: 60_000,
      clock
    }).runStart(fixture.claim);

    expect(requestedLimit).toBe(7);
    expect(calls).toContain('commit:completed');
  });

  it('rejects a replayed current-claim response with the wrong challenge nonce', async () => {
    const fixture = startFixture();
    const calls: string[] = [];
    const controlPlane = fakeControlPlane(fixture, calls);
    controlPlane.resolveRuntimeCurrentClaim = async () => currentClaim(
      fixture.attempt,
      'local-qa-runtime'
    );
    await new TestingExecutor({
      controlPlane,
      runtime: {
        getCapabilities: async () => capabilities(fixture.claim.task.runner),
        submitRun: async () => { calls.push('submit'); throw new Error('must not submit'); },
        getSnapshot: async () => { throw new Error('must not read'); },
        listEvents: async () => { throw new Error('must not read'); },
        cancelRun: async () => { throw new Error('must not cancel'); },
        reconcileTerminal: async () => { throw new Error('must not reconcile'); }
      },
      authorizations: resolver(),
      heartbeatMs: 60_000,
      nonce: () => 'runtime-expected-nonce-1',
      clock
    }).runStart(fixture.claim);
    expect(calls).toEqual(['heartbeat']);
  });

  it('rejects a heartbeat response bound to another fence', async () => {
    const fixture = startFixture();
    const calls: string[] = [];
    const controlPlane = fakeControlPlane(fixture, calls);
    controlPlane.heartbeat = async () => ({
      lease_expires_at: deadline,
      cancel_requested: false,
      current_claim: {
        ...fixture.claim.current_claim,
        claim: {
          ...fixture.claim.current_claim.claim,
          fence_token: 'testing-stale-fence-1'
        }
      }
    });
    await new TestingExecutor({
      controlPlane,
      runtime: {
        getCapabilities: async () => { calls.push('capabilities'); return capabilities(fixture.claim.task.runner); },
        submitRun: async () => { throw new Error('must not submit'); },
        getSnapshot: async () => { throw new Error('must not read'); },
        listEvents: async () => { throw new Error('must not read'); },
        cancelRun: async () => { throw new Error('must not cancel'); },
        reconcileTerminal: async () => { throw new Error('must not reconcile'); }
      },
      authorizations: resolver(),
      heartbeatMs: 60_000,
      clock
    }).runStart(fixture.claim);
    expect(calls).not.toContain('capabilities');
  });

  it('maps a durable cancel intent to an operation-specific Runtime cancel and cleanup terminal', async () => {
    const fixture = startFixture();
    const calls: string[] = [];
    let heartbeatCount = 0;
    let cancelled = false;
    const running = snapshot(fixture.attempt, 'executing');
    const cancelledSnapshot = snapshot(fixture.attempt, 'terminal', 'cancelled');
    const controlPlane = fakeControlPlane(fixture, calls, {
      heartbeat: () => {
        heartbeatCount += 1;
        return heartbeatCount > 1;
      },
      currentClaim: () => currentClaim(fixture.attempt, 'local-qa-runtime', cancelled ? 'cancel_requested' : 'current')
    });
    const runtime: LocalQARuntimeAdapter = {
      getCapabilities: async () => capabilities(fixture.claim.task.runner),
      submitRun: async (request) => ({
        schema_version: 'local-qa-runtime-admission/v1',
        disposition: 'new',
        accepted: true,
        run_id: fixture.attempt.run_id,
        request_digest: request.request_digest,
        attempt: fixture.attempt,
        journal_version: 1,
        snapshot: running
      }),
      getSnapshot: async () => cancelled ? cancelledSnapshot : running,
      listEvents: async (_runId, after) => eventPage(
        fixture.attempt.run_id,
        after,
        (cancelled ? cancelledSnapshot : running).snapshot_digest
      ),
      cancelRun: async (request) => {
        calls.push(`runtime:${request.operation}`);
        cancelled = true;
        return {
          schema_version: 'local-qa-runtime-cancel-ack/v1',
          run_id: fixture.attempt.run_id,
          request_digest: request.request_digest,
          disposition: 'accepted',
          cancel_intent_ref: { schema: 'qa.local-cancel-intent/v1', ref: 'artifact://runtime/cancel-intents/1', digest },
          snapshot: cancelledSnapshot,
          acknowledged_at: observedAt
        };
      },
      reconcileTerminal: async () => { throw new Error('must not reconcile'); }
    };
    await new TestingExecutor({
      controlPlane,
      runtime,
      authorizations: resolver((request) => calls.push(`authorization:${request.operation}`)),
      heartbeatMs: 5,
      pollMs: 10,
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      clock
    }).runStart(fixture.claim);

    expect(calls).toContain('authorization:cancel');
    expect(calls).toContain('runtime:cancel');
    expect(calls).toContain('commit:cancelled');
  });

  it('keeps Talos control closure independent from settled Runner outcomes', async () => {
    for (const outcome of ['failed', 'error', 'timed_out', 'blocked', 'all_skipped'] as const) {
      const fixture = startFixture();
      const calls: string[] = [];
      const terminal = snapshot(fixture.attempt, 'terminal', outcome);
      await new TestingExecutor({
        controlPlane: fakeControlPlane(fixture, calls),
        runtime: {
          getCapabilities: async () => capabilities(fixture.claim.task.runner),
          submitRun: async (request) => ({
            schema_version: 'local-qa-runtime-admission/v1',
            disposition: 'new',
            accepted: true,
            run_id: fixture.attempt.run_id,
            request_digest: request.request_digest,
            attempt: fixture.attempt,
            journal_version: 1,
            snapshot: terminal
          }),
          getSnapshot: async () => terminal,
          listEvents: async () => eventPage(fixture.attempt.run_id, 0, terminal.snapshot_digest),
          cancelRun: async () => { throw new Error('must not cancel'); },
          reconcileTerminal: async () => { throw new Error('must not reconcile'); }
        },
        authorizations: resolver(),
        heartbeatMs: 60_000,
        clock
      }).runStart(fixture.claim);
      expect(calls, outcome).toContain('commit:completed');
    }
  });

  it('rejects a cancel acknowledgement bound to another request', async () => {
    const fixture = startFixture();
    const calls: string[] = [];
    let heartbeatCount = 0;
    const running = snapshot(fixture.attempt, 'executing');
    const controlPlane = fakeControlPlane(fixture, calls, {
      heartbeat: () => {
        heartbeatCount += 1;
        return heartbeatCount > 1;
      }
    });
    await new TestingExecutor({
      controlPlane,
      runtime: {
        getCapabilities: async () => capabilities(fixture.claim.task.runner),
        submitRun: async (request) => ({
          schema_version: 'local-qa-runtime-admission/v1',
          disposition: 'new',
          accepted: true,
          run_id: fixture.attempt.run_id,
          request_digest: request.request_digest,
          attempt: fixture.attempt,
          journal_version: 1,
          snapshot: running
        }),
        getSnapshot: async () => running,
        listEvents: async (_runId, after) => eventPage(
          fixture.attempt.run_id,
          after,
          running.snapshot_digest
        ),
        cancelRun: async () => {
          calls.push('runtime:cancel');
          return {
            schema_version: 'local-qa-runtime-cancel-ack/v1',
            run_id: fixture.attempt.run_id,
            request_digest: digest,
            disposition: 'accepted',
            cancel_intent_ref: {
              schema: 'qa.local-cancel-intent/v1',
              ref: 'artifact://runtime/cancel-intents/wrong',
              digest
            },
            snapshot: running,
            acknowledged_at: observedAt
          };
        },
        reconcileTerminal: async () => { throw new Error('must not reconcile'); }
      },
      authorizations: resolver(),
      heartbeatMs: 5,
      pollMs: 10,
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      clock
    }).runStart(fixture.claim);

    expect(calls).toContain('runtime:cancel');
    expect(calls.some((call) => call.startsWith('commit:'))).toBe(false);
  });

  it('labels a proactive deadline cancellation as timed out', async () => {
    const fixture = startFixture();
    const calls: string[] = [];
    let now = clock();
    let cancelReason: string | undefined;
    const running = snapshot(fixture.attempt, 'executing');
    const terminal = snapshot(fixture.attempt, 'terminal', 'cancelled');
    const controlPlane = fakeControlPlane(fixture, calls, {
      currentClaim: () => ({
        ...currentClaim(fixture.attempt, 'local-qa-runtime'),
        valid_until: deadline
      })
    });
    await new TestingExecutor({
      controlPlane,
      runtime: {
        getCapabilities: async () => capabilities(fixture.claim.task.runner),
        submitRun: async (request) => {
          now = Date.parse(deadline) - 500;
          return {
            schema_version: 'local-qa-runtime-admission/v1',
            disposition: 'new',
            accepted: true,
            run_id: fixture.attempt.run_id,
            request_digest: request.request_digest,
            attempt: fixture.attempt,
            journal_version: 1,
            snapshot: running
          };
        },
        getSnapshot: async () => terminal,
        listEvents: async (_runId, after) => eventPage(
          fixture.attempt.run_id,
          after,
          terminal.snapshot_digest
        ),
        cancelRun: async (request) => {
          cancelReason = request.reason;
          return {
            schema_version: 'local-qa-runtime-cancel-ack/v1',
            run_id: fixture.attempt.run_id,
            request_digest: request.request_digest,
            disposition: 'accepted',
            cancel_intent_ref: {
              schema: 'qa.local-cancel-intent/v1',
              ref: 'artifact://runtime/cancel-intents/deadline',
              digest
            },
            snapshot: terminal,
            acknowledged_at: observedAt
          };
        },
        reconcileTerminal: async () => { throw new Error('must not reconcile'); }
      },
      authorizations: resolver(),
      heartbeatMs: 60_000,
      pollMs: 1_000,
      clock: () => now
    }).runStart(fixture.claim);

    expect(cancelReason).toBe('timed_out');
    expect(calls).toContain('commit:cancelled');
  });

  it('uses a reconcile-only claim to read terminal state and never submits a new run', async () => {
    const fixture = reconcileFixture();
    const calls: string[] = [];
    const terminal = snapshot(fixture.executionAttempt, 'terminal', 'failed');
    const controlPlane: TestingWorkerControlPlane = {
      claim: async () => undefined,
      claimReconcile: async () => undefined,
      heartbeat: async () => {
        calls.push('heartbeat');
        return { lease_expires_at: deadline, cancel_requested: false, current_claim: fixture.claim.current_claim };
      },
      acceptLocal: async () => { throw new Error('reconcile cannot accept'); },
      markRunning: async () => { throw new Error('reconcile cannot start'); },
      commitTerminal: async () => { throw new Error('reconcile cannot use start terminal'); },
      commitReconcileTerminal: async (_credentials, projection) => { calls.push(`reconcile:${projection.controlStatus}`); },
      confirmNotAccepted: async () => { calls.push('not-accepted'); },
      resolveRuntimeCurrentClaim: async (_runId, _claimId, requestNonce) => ({
        ...currentClaim(fixture.attempt, 'local-qa-runtime'),
        request_nonce: requestNonce
      })
    };
    const runtime: LocalQARuntimeAdapter = {
      getCapabilities: async () => capabilities({ package_id: 'testing-browser-runner', version: '1.0.0', digest }),
      submitRun: async () => { calls.push('submit'); throw new Error('must not submit'); },
      getSnapshot: async () => terminal,
      listEvents: async () => eventPage(fixture.attempt.run_id),
      cancelRun: async () => { throw new Error('must not cancel'); },
      reconcileTerminal: async (request) => {
        calls.push(`runtime:${request.operation}`);
        return { schema_version: 'local-qa-runtime-reconcile-result/v1', disposition: 'terminal', snapshot: terminal };
      }
    };
    await new TestingExecutor({
      controlPlane,
      runtime,
      authorizations: resolver(),
      heartbeatMs: 60_000,
      clock
    }).runReconcile(fixture.claim);
    expect(calls).toEqual(['heartbeat', 'runtime:reconcile', 'reconcile:completed']);
    expect(calls).not.toContain('submit');
  });

  it('issues reconcile control once and observes a pending run through snapshots and events', async () => {
    const fixture = reconcileFixture();
    const calls: string[] = [];
    const pending = snapshot(fixture.executionAttempt, 'cleaning_up_execution');
    const terminal = snapshot(fixture.executionAttempt, 'terminal', 'failed');
    let reconcileRequests = 0;
    const controlPlane: TestingWorkerControlPlane = {
      claim: async () => undefined,
      claimReconcile: async () => undefined,
      heartbeat: async () => {
        calls.push('heartbeat');
        return { lease_expires_at: deadline, cancel_requested: false, current_claim: fixture.claim.current_claim };
      },
      acceptLocal: async () => { throw new Error('must not accept'); },
      markRunning: async () => { throw new Error('must not run'); },
      commitTerminal: async () => { throw new Error('must not commit start terminal'); },
      commitReconcileTerminal: async () => { calls.push('commit:reconcile'); },
      confirmNotAccepted: async () => { throw new Error('must not report no acceptance'); },
      resolveRuntimeCurrentClaim: async (_runId, _claimId, requestNonce) => ({
        ...currentClaim(fixture.attempt, 'local-qa-runtime'),
        request_nonce: requestNonce
      })
    };
    await new TestingExecutor({
      controlPlane,
      runtime: {
        getCapabilities: async () => capabilities({ package_id: 'testing-browser-runner', version: '1.0.0', digest }, 3),
        submitRun: async () => { calls.push('submit'); throw new Error('must not submit'); },
        getSnapshot: async () => { calls.push('snapshot'); return terminal; },
        listEvents: async (_runId, after, limit) => {
          calls.push(`events:${limit}`);
          return eventPage(fixture.attempt.run_id, after, terminal.snapshot_digest);
        },
        cancelRun: async () => { throw new Error('must not cancel'); },
        reconcileTerminal: async () => {
          reconcileRequests += 1;
          calls.push('runtime:reconcile');
          return {
            schema_version: 'local-qa-runtime-reconcile-result/v1',
            disposition: 'pending',
            snapshot: pending
          };
        }
      },
      authorizations: resolver(),
      heartbeatMs: 60_000,
      clock
    }).runReconcile(fixture.claim);

    expect(reconcileRequests).toBe(1);
    expect(calls).toContain('events:3');
    expect(calls).toContain('snapshot');
    expect(calls).toContain('commit:reconcile');
    expect(calls).not.toContain('submit');
  });

  it('dispatches cancellation that arrives after pending reconciliation starts', async () => {
    const fixture = reconcileFixture();
    const calls: string[] = [];
    const pending = snapshot(fixture.executionAttempt, 'cleaning_up_execution');
    const terminal = snapshot(fixture.executionAttempt, 'terminal', 'cancelled');
    let heartbeatCount = 0;
    const controlPlane: TestingWorkerControlPlane = {
      claim: async () => undefined,
      claimReconcile: async () => undefined,
      heartbeat: async () => {
        heartbeatCount += 1;
        const cancelRequested = heartbeatCount > 1;
        return {
          lease_expires_at: deadline,
          cancel_requested: cancelRequested,
          current_claim: cancelRequested
            ? { ...fixture.claim.current_claim, is_current: false, status: 'cancel_requested' }
            : fixture.claim.current_claim
        };
      },
      acceptLocal: async () => { throw new Error('must not accept'); },
      markRunning: async () => { throw new Error('must not run'); },
      commitTerminal: async () => { throw new Error('must not commit start terminal'); },
      commitReconcileTerminal: async (_credentials, projection) => { calls.push(`commit:${projection.controlStatus}`); },
      confirmNotAccepted: async () => { throw new Error('must not report no acceptance'); },
      resolveRuntimeCurrentClaim: async (_runId, _claimId, requestNonce) => ({
        ...currentClaim(
          fixture.attempt,
          'local-qa-runtime',
          heartbeatCount > 1 ? 'cancel_requested' : 'current'
        ),
        request_nonce: requestNonce
      })
    };
    await new TestingExecutor({
      controlPlane,
      runtime: {
        getCapabilities: async () => capabilities({ package_id: 'testing-browser-runner', version: '1.0.0', digest }),
        submitRun: async () => { throw new Error('must not submit'); },
        getSnapshot: async () => { throw new Error('terminal cancel must not poll'); },
        listEvents: async () => { throw new Error('terminal cancel must not poll'); },
        cancelRun: async (request) => {
          calls.push('runtime:cancel');
          return cancelAcknowledgement(fixture.attempt.run_id, request.request_digest, terminal, 'late');
        },
        reconcileTerminal: async () => {
          calls.push('runtime:reconcile');
          return {
            schema_version: 'local-qa-runtime-reconcile-result/v1',
            disposition: 'pending',
            snapshot: pending
          };
        }
      },
      authorizations: resolver((request) => calls.push(`authorization:${request.operation}`)),
      heartbeatMs: 60_000,
      clock
    }).runReconcile(fixture.claim);

    expect(calls).toContain('runtime:reconcile');
    expect(calls).toContain('authorization:cancel');
    expect(calls).toContain('runtime:cancel');
    expect(calls).toContain('commit:cancelled');
  });

  it('replays durable cancel intent before reconcile and observes a non-terminal acknowledgement', async () => {
    const fixture = reconcileFixture();
    const calls: string[] = [];
    const pending = snapshot(fixture.executionAttempt, 'cleaning_up_execution');
    const terminal = snapshot(fixture.executionAttempt, 'terminal', 'cancelled');
    let heartbeatCount = 0;
    let cancelRequest: LocalQAControlRequest | undefined;
    const controlPlane: TestingWorkerControlPlane = {
      claim: async () => undefined,
      claimReconcile: async () => undefined,
      heartbeat: async () => {
        heartbeatCount += 1;
        return {
          lease_expires_at: deadline,
          cancel_requested: true,
          current_claim: { ...fixture.claim.current_claim, is_current: false, status: 'cancel_requested' }
        };
      },
      acceptLocal: async () => { throw new Error('must not accept'); },
      markRunning: async () => { throw new Error('must not run'); },
      commitTerminal: async () => { throw new Error('must not commit start terminal'); },
      commitReconcileTerminal: async (_credentials, projection) => { calls.push(`commit:${projection.controlStatus}`); },
      confirmNotAccepted: async () => { throw new Error('must not report no acceptance'); },
      resolveRuntimeCurrentClaim: async (_runId, _claimId, requestNonce) => ({
        ...currentClaim(fixture.attempt, 'local-qa-runtime', 'cancel_requested'),
        request_nonce: requestNonce
      })
    };
    await new TestingExecutor({
      controlPlane,
      runtime: {
        getCapabilities: async () => capabilities({ package_id: 'testing-browser-runner', version: '1.0.0', digest }),
        submitRun: async () => { throw new Error('must not submit'); },
        getSnapshot: async () => { calls.push('snapshot'); return terminal; },
        listEvents: async (_runId, after) => eventPage(fixture.attempt.run_id, after, terminal.snapshot_digest),
        cancelRun: async (request) => {
          calls.push('runtime:cancel');
          cancelRequest = request;
          return {
            schema_version: 'local-qa-runtime-cancel-ack/v1',
            run_id: fixture.attempt.run_id,
            request_digest: request.request_digest,
            disposition: 'accepted',
            cancel_intent_ref: {
              schema: 'qa.local-cancel-intent/v1',
              ref: 'artifact://runtime/cancel-intents/reconcile-1',
              digest
            },
            snapshot: pending,
            acknowledged_at: observedAt
          };
        },
        reconcileTerminal: async () => { calls.push('runtime:reconcile'); throw new Error('must not reconcile after cancel'); }
      },
      authorizations: resolver((request) => calls.push(`authorization:${request.operation}`)),
      heartbeatMs: 60_000,
      clock
    }).runReconcile(fixture.claim);

    expect(heartbeatCount).toBeGreaterThanOrEqual(2);
    expect(calls).toContain('authorization:cancel');
    expect(calls).toContain('runtime:cancel');
    expect(calls).toContain('snapshot');
    expect(calls).toContain('commit:cancelled');
    expect(calls).not.toContain('runtime:reconcile');
    expect(cancelRequest?.operation).toBe('cancel');
    expect(cancelRequest?.effect_id).toMatch(/^cancel-effect-/);
  });

  it('does not infer reconciliation success when durable cancel replay fails', async () => {
    const fixture = reconcileFixture();
    const calls: string[] = [];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const controlPlane: TestingWorkerControlPlane = {
      claim: async () => undefined,
      claimReconcile: async () => undefined,
      heartbeat: async () => ({
        lease_expires_at: deadline,
        cancel_requested: true,
        current_claim: { ...fixture.claim.current_claim, is_current: false, status: 'cancel_requested' }
      }),
      acceptLocal: async () => { throw new Error('must not accept'); },
      markRunning: async () => { throw new Error('must not run'); },
      commitTerminal: async () => { throw new Error('must not commit'); },
      commitReconcileTerminal: async () => { calls.push('commit'); },
      confirmNotAccepted: async () => { calls.push('not-accepted'); },
      resolveRuntimeCurrentClaim: async (_runId, _claimId, requestNonce) => ({
        ...currentClaim(fixture.attempt, 'local-qa-runtime', 'cancel_requested'),
        request_nonce: requestNonce
      })
    };
    await new TestingExecutor({
      controlPlane,
      runtime: {
        getCapabilities: async () => capabilities({ package_id: 'testing-browser-runner', version: '1.0.0', digest }),
        submitRun: async () => { throw new Error('must not submit'); },
        getSnapshot: async () => { throw new Error('must not observe after failed cancel'); },
        listEvents: async () => { throw new Error('must not observe after failed cancel'); },
        cancelRun: async () => { calls.push('runtime:cancel'); throw new Error('remote secret: token-123'); },
        reconcileTerminal: async () => { calls.push('runtime:reconcile'); throw new Error('must not reconcile'); }
      },
      authorizations: resolver(),
      heartbeatMs: 60_000,
      clock,
      logger
    }).runReconcile(fixture.claim);

    expect(calls).toEqual(['runtime:cancel']);
    expect(logger.warn).toHaveBeenCalledWith(
      'testing reconciliation did not converge',
      expect.objectContaining({ error: 'unexpected_error' })
    );
  });

  it('dispatches an initially durable cancel without depending on Runtime capabilities', async () => {
    const fixture = reconcileFixture();
    const calls: string[] = [];
    const terminal = snapshot(fixture.executionAttempt, 'terminal', 'cancelled');
    const controlPlane: TestingWorkerControlPlane = {
      claim: async () => undefined,
      claimReconcile: async () => undefined,
      heartbeat: async () => ({
        lease_expires_at: deadline,
        cancel_requested: true,
        current_claim: { ...fixture.claim.current_claim, is_current: false, status: 'cancel_requested' }
      }),
      acceptLocal: async () => { throw new Error('must not accept'); },
      markRunning: async () => { throw new Error('must not run'); },
      commitTerminal: async () => { throw new Error('must not commit'); },
      commitReconcileTerminal: async () => { calls.push('commit'); },
      confirmNotAccepted: async () => { throw new Error('must not report no acceptance'); },
      resolveRuntimeCurrentClaim: async (_runId, _claimId, requestNonce) => ({
        ...currentClaim(fixture.attempt, 'local-qa-runtime', 'cancel_requested'),
        request_nonce: requestNonce
      })
    };
    await new TestingExecutor({
      controlPlane,
      runtime: {
        getCapabilities: async () => { calls.push('capabilities'); throw new Error('capabilities unavailable'); },
        submitRun: async () => { throw new Error('must not submit'); },
        getSnapshot: async () => { throw new Error('must not read'); },
        listEvents: async () => { throw new Error('must not read'); },
        cancelRun: async (request) => {
          calls.push('runtime:cancel');
          return cancelAcknowledgement(fixture.attempt.run_id, request.request_digest, terminal, 'capability-free');
        },
        reconcileTerminal: async () => { throw new Error('must not reconcile'); }
      },
      authorizations: resolver(),
      heartbeatMs: 60_000,
      clock
    }).runReconcile(fixture.claim);

    expect(calls).toEqual(['runtime:cancel', 'commit']);
  });

  it('keeps one reconcile effect across acknowledgement loss and claim rotation', async () => {
    const first = reconcileFixture(2);
    const rotated = reconcileFixture(3);
    const requests: Array<{ requestId: string; effectId: string }> = [];
    const effects = new Set<string>();
    let localQuiesceStarts = 0;
    let posts = 0;
    let committed = false;
    const terminal = snapshot(rotated.executionAttempt, 'terminal', 'failed');
    const runtime: LocalQARuntimeAdapter = {
      getCapabilities: async () => capabilities({ package_id: 'testing-browser-runner', version: '1.0.0', digest }),
      submitRun: async () => { throw new Error('must not submit'); },
      getSnapshot: async () => terminal,
      listEvents: async (_runId, after) => eventPage(rotated.attempt.run_id, after, terminal.snapshot_digest),
      cancelRun: async () => { throw new Error('must not cancel'); },
      reconcileTerminal: async (request) => {
        posts += 1;
        requests.push({ requestId: request.request_id, effectId: request.effect_id });
        if (!effects.has(request.effect_id)) {
          effects.add(request.effect_id);
          localQuiesceStarts += 1;
        }
        if (posts === 1) throw new Error('reconcile acknowledgement lost');
        return {
          schema_version: 'local-qa-runtime-reconcile-result/v1',
          disposition: 'terminal',
          snapshot: terminal
        };
      }
    };
    const controlPlaneFor = (fixture: ReturnType<typeof reconcileFixture>): TestingWorkerControlPlane => ({
      claim: async () => undefined,
      claimReconcile: async () => undefined,
      heartbeat: async () => ({
        lease_expires_at: deadline,
        cancel_requested: false,
        current_claim: fixture.claim.current_claim
      }),
      acceptLocal: async () => { throw new Error('must not accept'); },
      markRunning: async () => { throw new Error('must not run'); },
      commitTerminal: async () => { throw new Error('must not commit start terminal'); },
      commitReconcileTerminal: async () => { committed = true; },
      confirmNotAccepted: async () => { throw new Error('must not report no acceptance'); },
      resolveRuntimeCurrentClaim: async (_runId, _claimId, requestNonce) => ({
        ...currentClaim(fixture.attempt, 'local-qa-runtime'),
        request_nonce: requestNonce
      })
    });

    await new TestingExecutor({
      controlPlane: controlPlaneFor(first),
      runtime,
      authorizations: resolver(),
      heartbeatMs: 60_000,
      clock
    }).runReconcile(first.claim);
    await new TestingExecutor({
      controlPlane: controlPlaneFor(rotated),
      runtime,
      authorizations: resolver(),
      heartbeatMs: 60_000,
      clock
    }).runReconcile(rotated.claim);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.requestId).not.toBe(requests[1]?.requestId);
    expect(requests[0]?.effectId).toBe(requests[1]?.effectId);
    expect(localQuiesceStarts).toBe(1);
    expect(committed).toBe(true);
  });

  it('rejects a reconcile terminal snapshot with a stale fence', async () => {
    const fixture = reconcileFixture();
    const calls: string[] = [];
    const staleAttempt = { ...fixture.executionAttempt, fence_token: 'testing-stale-fence-1' };
    const staleTerminal = snapshot(staleAttempt, 'terminal', 'failed');
    const controlPlane: TestingWorkerControlPlane = {
      claim: async () => undefined,
      claimReconcile: async () => undefined,
      heartbeat: async () => ({
        lease_expires_at: deadline,
        cancel_requested: false,
        current_claim: fixture.claim.current_claim
      }),
      acceptLocal: async () => { throw new Error('must not accept'); },
      markRunning: async () => { throw new Error('must not run'); },
      commitTerminal: async () => { throw new Error('must not commit start terminal'); },
      commitReconcileTerminal: async () => { calls.push('commit:reconcile'); },
      confirmNotAccepted: async () => { throw new Error('must not report no acceptance'); },
      resolveRuntimeCurrentClaim: async (_runId, _claimId, requestNonce) => ({
        ...currentClaim(fixture.attempt, 'local-qa-runtime'),
        request_nonce: requestNonce
      })
    };
    await new TestingExecutor({
      controlPlane,
      runtime: {
        getCapabilities: async () => capabilities({ package_id: 'testing-browser-runner', version: '1.0.0', digest }),
        submitRun: async () => { throw new Error('must not submit'); },
        getSnapshot: async () => { throw new Error('must not read'); },
        listEvents: async () => { throw new Error('must not read'); },
        cancelRun: async () => { throw new Error('must not cancel'); },
        reconcileTerminal: async () => ({
          schema_version: 'local-qa-runtime-reconcile-result/v1',
          disposition: 'terminal',
          snapshot: staleTerminal
        })
      },
      authorizations: resolver(),
      heartbeatMs: 60_000,
      clock
    }).runReconcile(fixture.claim);
    expect(calls).not.toContain('commit:reconcile');
  });

  it('projects a Runtime Journal never-accepted fact instead of retrying the test', async () => {
    const fixture = reconcileFixture();
    const calls: string[] = [];
    const controlPlane: TestingWorkerControlPlane = {
      claim: async () => undefined,
      claimReconcile: async () => undefined,
      heartbeat: async () => ({ lease_expires_at: deadline, cancel_requested: false, current_claim: fixture.claim.current_claim }),
      acceptLocal: async () => { throw new Error('must not accept'); },
      markRunning: async () => { throw new Error('must not run'); },
      commitTerminal: async () => { throw new Error('must not commit start terminal'); },
      commitReconcileTerminal: async () => { throw new Error('must not infer a terminal outcome'); },
      confirmNotAccepted: async () => { calls.push('not-accepted'); },
      resolveRuntimeCurrentClaim: async (_runId, _claimId, requestNonce) => ({
        ...currentClaim(fixture.attempt, 'local-qa-runtime'),
        request_nonce: requestNonce
      })
    };
    await new TestingExecutor({
      controlPlane,
      runtime: {
        getCapabilities: async () => capabilities({ package_id: 'testing-browser-runner', version: '1.0.0', digest }),
        submitRun: async () => { calls.push('submit'); throw new Error('must not submit'); },
        getSnapshot: async () => { throw new Error('must not read'); },
        listEvents: async () => { throw new Error('must not read'); },
        cancelRun: async () => { throw new Error('must not cancel'); },
        reconcileTerminal: async () => ({
          schema_version: 'local-qa-runtime-reconcile-result/v1',
          disposition: 'never_accepted',
          fact: {
            schema_version: 'talos.testing-no-local-acceptance-fact/v1',
            run_id: fixture.attempt.run_id,
            task_id: fixture.attempt.task_id,
            attempt_id: fixture.attempt.attempt_id,
            machine_id: fixture.attempt.machine_id,
            worker_id: 'worker-1',
            lease_id: 'lease-1',
            generation: fixture.attempt.generation,
            fence_token: fixture.attempt.fence_token,
            admission_nonce: fixture.attempt.admission_nonce,
            start_claim_digest: digest,
            reconcile_claim_id: 'claim-2',
            reconcile_lease_id: fixture.attempt.lease_id,
            reconcile_claim_digest: fixture.claim.current_claim.claim_digest,
            journal_version: 1,
            disposition: 'never_accepted',
            fact_ref: 'local-qa://runtime/facts/1',
            fact_digest: digest,
            observed_at: observedAt
          }
        })
      },
      authorizations: resolver(),
      heartbeatMs: 60_000,
      clock
    }).runReconcile(fixture.claim);
    expect(calls).toEqual(['not-accepted']);
    expect(calls).not.toContain('submit');
  });

  it('fails closed when an event page and snapshot disagree at the same sequence', async () => {
    const fixture = startFixture();
    const calls: string[] = [];
    const running = snapshot(fixture.attempt, 'executing');
    await new TestingExecutor({
      controlPlane: fakeControlPlane(fixture, calls),
      runtime: {
        getCapabilities: async () => capabilities(fixture.claim.task.runner),
        submitRun: async (request) => ({
          schema_version: 'local-qa-runtime-admission/v1',
          disposition: 'new',
          accepted: true,
          run_id: fixture.attempt.run_id,
          request_digest: request.request_digest,
          attempt: fixture.attempt,
          journal_version: 1,
          snapshot: running
        }),
        getSnapshot: async () => running,
        listEvents: async (_runId, after) => eventPage(fixture.attempt.run_id, after, digest),
        cancelRun: async () => { throw new Error('must not cancel'); },
        reconcileTerminal: async () => { throw new Error('must not reconcile'); }
      },
      authorizations: resolver(),
      heartbeatMs: 60_000,
      clock
    }).runStart(fixture.claim);

    expect(calls).toContain('accept');
    expect(calls.some((call) => call.startsWith('commit:'))).toBe(false);
  });

  it('aborts active Runtime polling on worker shutdown without issuing a cancel', async () => {
    const fixture = startFixture();
    const calls: string[] = [];
    const runningSnapshot = snapshot(fixture.attempt, 'executing');
    let claimed = false;
    let pollStarted: (() => void) | undefined;
    const polling = new Promise<void>((resolve) => { pollStarted = resolve; });
    const controlPlane = fakeControlPlane(fixture, calls);
    controlPlane.claim = async () => {
      if (claimed) return undefined;
      claimed = true;
      return fixture.claim;
    };
    const worker = new TestingWorkerRuntime({
      controlPlane,
      runtime: {
        getCapabilities: async () => capabilities(fixture.claim.task.runner),
        submitRun: async (request) => ({
          schema_version: 'local-qa-runtime-admission/v1',
          disposition: 'new',
          accepted: true,
          run_id: fixture.attempt.run_id,
          request_digest: request.request_digest,
          attempt: fixture.attempt,
          journal_version: 1,
          snapshot: runningSnapshot
        }),
        getSnapshot: async () => runningSnapshot,
        listEvents: async (_runId, _after, _limit, signal) => {
          pollStarted?.();
          return await new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
        cancelRun: async () => { calls.push('runtime:cancel'); throw new Error('must not cancel'); },
        reconcileTerminal: async () => { throw new Error('must not reconcile'); }
      },
      authorizations: resolver(),
      heartbeatMs: 60_000,
      clock
    });

    const activeRun = worker.runOnce();
    await polling;
    worker.stop();
    await expect(activeRun).resolves.toBe(true);
    expect(calls).toContain('accept');
    expect(calls).not.toContain('runtime:cancel');
    expect(calls.some((call) => call.startsWith('commit:'))).toBe(false);
  });

  it('aborts active Runtime polling when the last authoritative lease expires', async () => {
    const fixture = startFixture();
    const calls: string[] = [];
    const runningSnapshot = snapshot(fixture.attempt, 'executing');
    const leaseExpiresAt = new Date(clock() + 20).toISOString();
    const shortLeaseClaim = {
      ...fixture.claim,
      lease: { ...fixture.claim.lease, lease_expires_at: leaseExpiresAt }
    };
    const controlPlane = fakeControlPlane(fixture, calls);
    controlPlane.heartbeat = async () => ({
      lease_expires_at: leaseExpiresAt,
      cancel_requested: false,
      current_claim: {
        ...fixture.claim.current_claim,
        lease_expires_at: leaseExpiresAt,
        valid_until: leaseExpiresAt
      }
    });
    await new TestingExecutor({
      controlPlane,
      runtime: {
        getCapabilities: async () => capabilities(fixture.claim.task.runner),
        submitRun: async (request) => ({
          schema_version: 'local-qa-runtime-admission/v1',
          disposition: 'new',
          accepted: true,
          run_id: fixture.attempt.run_id,
          request_digest: request.request_digest,
          attempt: fixture.attempt,
          journal_version: 1,
          snapshot: runningSnapshot
        }),
        getSnapshot: async () => runningSnapshot,
        listEvents: async (_runId, _after, _limit, signal) => {
          calls.push('events');
          return await new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
        cancelRun: async () => { calls.push('runtime:cancel'); throw new Error('must not cancel'); },
        reconcileTerminal: async () => { throw new Error('must not reconcile'); }
      },
      authorizations: resolver(),
      heartbeatMs: 60_000,
      clock
    }).runStart(shortLeaseClaim);

    expect(calls).toContain('accept');
    expect(calls).toContain('events');
    expect(calls).not.toContain('runtime:cancel');
    expect(calls.some((call) => call.startsWith('commit:'))).toBe(false);
  });

  it('does not copy untrusted validation content into worker logs', async () => {
    const fixture = startFixture();
    const malicious = `resolver-token-123456 /Users/private/source ${'x'.repeat(4_096)}`;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await new TestingExecutor({
      controlPlane: fakeControlPlane(fixture, []),
      runtime: {
        getCapabilities: async () => { throw z.literal('expected').parse(malicious); },
        submitRun: async () => { throw new Error('must not submit'); },
        getSnapshot: async () => { throw new Error('must not read'); },
        listEvents: async () => { throw new Error('must not read'); },
        cancelRun: async () => { throw new Error('must not cancel'); },
        reconcileTerminal: async () => { throw new Error('must not reconcile'); }
      },
      authorizations: resolver(),
      heartbeatMs: 60_000,
      clock,
      logger
    }).runStart(fixture.claim);

    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('unexpected_error');
    expect(logged).not.toContain('resolver-token-123456');
    expect(logged).not.toContain('/Users/private/source');
    expect(logged).not.toContain('xxxx');
  });

  it('does not copy remote error codes into worker logs', async () => {
    const fixture = startFixture();
    const credential = 'runtime-credential-1234';
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await new TestingExecutor({
      controlPlane: fakeControlPlane(fixture, []),
      runtime: {
        getCapabilities: async () => {
          throw new LocalQARuntimeAdapterError(credential, 'Local QA Runtime request failed (403)', 403);
        },
        submitRun: async () => { throw new Error('must not submit'); },
        getSnapshot: async () => { throw new Error('must not read'); },
        listEvents: async () => { throw new Error('must not read'); },
        cancelRun: async () => { throw new Error('must not cancel'); },
        reconcileTerminal: async () => { throw new Error('must not reconcile'); }
      },
      authorizations: resolver(),
      heartbeatMs: 60_000,
      clock,
      logger
    }).runStart(fixture.claim);

    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('local_qa_runtime_error (403)');
    expect(logged).not.toContain(credential);
  });
});

const startFixture = () => {
  const authorization = authorizationEnvelope('start');
  const authorizationDigest = digestJson(authorization);
  const task = taskFixture(authorizationDigest);
  const identity = claimIdentity(task, 'start');
  task.lease_claim.digest = computeTestingCurrentClaimDigest(identity);
  const attempt = runtimeAttempt(task, 'start');
  const claim = testingClaimResponseSchema.parse({
    task,
    lease: { lease_id: task.lease_id, lease_expires_at: deadline },
    lease_token: 'private-testing-lease-token',
    current_claim: claimEnvelope(identity, 'talos-worker')
  });
  return { authorization, claim, attempt };
};

const reconcileFixture = (claimNumber = 2) => {
  const authorization = authorizationEnvelope('reconcile');
  const taskWithoutPayloadDigest = {
    schema_version: 'talos.testing-reconcile-task/v1' as const,
    operation: 'reconcile' as const,
    qa_run_id: 'run-1',
    task_id: 'task-1',
    dispatch_attempt_id: 'attempt-1',
    generation: 1,
    machine_id: 'machine-1',
    worker_id: `worker-${claimNumber}`,
    lease_id: `lease-${claimNumber}`,
    fence_token: 'testing-fence-token-1',
    admission_nonce: 'testing-admission-1',
    lease_claim: { schema: 'talos.testing-lease-claim/v1' as const, ref: `talos://testing/claims/run-1/claim-${claimNumber}`, digest, expires_at: deadline },
    local_request_authorization: { ref: `authorization://local-qa-request/reconcile-${claimNumber}`, digest: digestJson(authorization), expires_at: deadline },
    deadline
  };
  const task = {
    ...taskWithoutPayloadDigest,
    task_payload_digest: computeTestingReconcileTaskPayloadDigest(taskWithoutPayloadDigest)
  };
  const identity = claimIdentity(task, 'reconcile');
  task.lease_claim.digest = computeTestingCurrentClaimDigest(identity);
  const attempt = runtimeAttempt(task, 'reconcile');
  const claim = testingReconcileClaimResponseSchema.parse({
    task,
    lease_token: 'private-reconcile-lease-token',
    current_claim: claimEnvelope(identity, 'talos-worker')
  });
  const executionAttempt = { ...attempt, operation: 'start' as const, worker_id: 'worker-1', lease_id: 'lease-1' };
  return { authorization, claim, attempt, executionAttempt };
};

const taskFixture = (authorizationDigest: string) => {
  const taskWithoutPayloadDigest = {
    schema_version: 'talos.testing-task/v1' as const,
    id: 'task-1',
    kind: 'testing' as const,
    interaction: 'managed' as const,
    qa_run_id: 'run-1',
    dispatch_attempt_id: 'attempt-1',
    generation: 1,
    machine_id: 'machine-1',
    worker_id: 'worker-1',
    lease_id: 'lease-1',
    fence_token: 'testing-fence-token-1',
    admission_nonce: 'testing-admission-1',
    lease_claim: { schema: 'talos.testing-lease-claim/v1' as const, ref: 'talos://testing/claims/run-1/claim-1', digest, expires_at: deadline },
    inputs: {
      schema_version: 'talos.testing-input-references/v1' as const,
      project_pack_snapshot: { schema: 'pql.project-pack-snapshot/v1' as const, ref: 'artifact://pql/snapshots/1', digest },
      test_selection: { schema: 'pql.test-selection/v1' as const, ref: 'artifact://pql/selections/1', digest },
      testing_design_input_set: { schema: 'pql.testing-design-input-set.v1' as const, ref: 'artifact://pql/input-sets/1', digest },
      source_revision: { repository_id: 'repo-1', exact_revision: 'b'.repeat(40), ref: 'artifact://source/archives/1', digest },
      structured_plan: { schema: 'testing-structured-plan.v2' as const, ref: 'artifact://plans/structured/1', digest },
      environment_profile: { ref: 'artifact://environments/profiles/1', digest },
      testing_package: { package_id: 'testing-browser-runner', version: '1.0.0', digest }
    },
    runner: { package_id: 'testing-browser-runner', version: '1.0.0', digest },
    policy_ref: { schema: 'talos.testing-execution-policy/v1' as const, ref: 'talos://policies/testing/1', digest },
    budgets_ref: { schema: 'talos.testing-budgets/v1' as const, ref: 'talos://budgets/testing/1', digest },
    local_request_authorization: { ref: 'authorization://local-qa-request/start-1', digest: authorizationDigest, expires_at: deadline },
    expected_runtime_capability: 'local-qa-mvp/v1' as const,
    deadline
  };
  return {
    ...taskWithoutPayloadDigest,
    task_payload_digest: computeTestingTaskPayloadDigest(taskWithoutPayloadDigest)
  };
};

type RuntimeTask = TestingTask | TestingReconcileTask;

const runtimeTaskId = (task: RuntimeTask): string => 'id' in task ? task.id : task.task_id;

const runtimeAttempt = (
  task: RuntimeTask,
  operation: 'start' | 'reconcile'
): TestingRuntimeAttempt => ({
  schema_version: 'talos.testing-runtime-attempt/v1',
  operation,
  run_id: task.qa_run_id,
  task_id: runtimeTaskId(task),
  attempt_id: task.dispatch_attempt_id,
  machine_id: task.machine_id,
  worker_id: task.worker_id,
  generation: task.generation,
  lease_id: task.lease_id,
  fence_token: task.fence_token,
  admission_nonce: task.admission_nonce,
  task_payload_digest: task.task_payload_digest,
  lease_claim: task.lease_claim,
  deadline: task.deadline
});

const claimIdentity = (
  task: RuntimeTask,
  operation: 'start' | 'reconcile'
) => ({
  schema_version: 'talos.testing-claim-identity/v1' as const,
  operation,
  claim_id: task.lease_claim.ref.split('/').at(-1) ?? 'missing-claim',
  run_id: task.qa_run_id,
  task_id: runtimeTaskId(task),
  attempt_id: task.dispatch_attempt_id,
  machine_id: task.machine_id,
  worker_id: task.worker_id,
  generation: task.generation,
  lease_id: task.lease_id,
  fence_token: task.fence_token,
  admission_nonce: task.admission_nonce,
  task_payload_digest: task.task_payload_digest,
  issued_at: observedAt,
  expires_at: deadline
});

const claimEnvelope = (
  identity: ReturnType<typeof claimIdentity>,
  audience: 'talos-worker' | 'local-qa-runtime',
  status: 'current' | 'cancel_requested' = 'current'
): TestingCurrentClaimEnvelope => ({
  schema_version: 'talos.testing-current-claim/v1',
  claim: identity,
  claim_digest: computeTestingCurrentClaimDigest(identity),
  audience,
  request_nonce: audience === 'talos-worker' ? 'worker-request-nonce-1' : 'runtime-request-nonce-1',
  is_current: status === 'current',
  status,
  lease_expires_at: deadline,
  observed_at: observedAt,
  valid_until: '2026-08-24T00:00:05.000Z',
  key_id: 'claim-key-1',
  signature
});

const currentClaim = (
  attempt: TestingRuntimeAttempt,
  audience: 'talos-worker' | 'local-qa-runtime',
  status: 'current' | 'cancel_requested' = 'current'
): TestingCurrentClaimEnvelope => claimEnvelope({
  schema_version: 'talos.testing-claim-identity/v1',
  operation: attempt.operation,
  claim_id: attempt.lease_claim.ref.split('/').at(-1) ?? 'missing-claim',
  run_id: attempt.run_id,
  task_id: attempt.task_id,
  attempt_id: attempt.attempt_id,
  machine_id: attempt.machine_id,
  worker_id: attempt.worker_id,
  generation: attempt.generation,
  lease_id: attempt.lease_id,
  fence_token: attempt.fence_token,
  admission_nonce: attempt.admission_nonce,
  task_payload_digest: attempt.task_payload_digest,
  issued_at: observedAt,
  expires_at: deadline
}, audience, status);

const capabilities = (
  runner: { package_id: string; version: string; digest: string },
  maxEventsPerPage = 100
) => ({
  schema_version: 'local-qa-runtime-capabilities/v1' as const,
  adapter_contracts: ['talos.local-qa-runtime-adapter/v1'] as ['talos.local-qa-runtime-adapter/v1'],
  runtime_capabilities: ['local-qa-mvp/v1'] as ['local-qa-mvp/v1'],
  execution_profiles: ['local_qa_agent_mvp'] as ['local_qa_agent_mvp'],
  runner_packages: [runner],
  max_concurrency: 1 as const,
  limits: { max_events_per_page: maxEventsPerPage, max_snapshot_bytes: 1_048_576, max_event_page_bytes: 1_048_576 }
});

const snapshot = (
  attempt: TestingRuntimeAttempt,
  state: LocalQARuntimeSnapshot['state'],
  outcome?: 'passed' | 'failed' | 'blocked' | 'error' | 'timed_out' | 'all_skipped' | 'cancelled'
): LocalQARuntimeSnapshot => {
  const binding = {
    schema_version: 'talos.testing-runtime-execution-binding/v1' as const,
    run_id: attempt.run_id,
    task_id: attempt.task_id,
    attempt_id: attempt.attempt_id,
    machine_id: attempt.machine_id,
    generation: attempt.generation,
    fence_token: attempt.fence_token
  };
  const resultBinding = {
    run_id: attempt.run_id,
    task_id: attempt.task_id,
    attempt_id: attempt.attempt_id,
    generation: attempt.generation,
    fence_token: attempt.fence_token
  };
  const summary = outcome === 'passed'
    ? { total: 1, passed: 1, failed: 0, blocked: 0, error: 0, skipped: 0, all_skipped: false }
    : outcome === 'failed'
      ? { total: 1, passed: 0, failed: 1, blocked: 0, error: 0, skipped: 0, all_skipped: false }
      : outcome === 'blocked'
        ? { total: 1, passed: 0, failed: 0, blocked: 1, error: 0, skipped: 0, all_skipped: false }
        : outcome === 'error'
          ? { total: 1, passed: 0, failed: 0, blocked: 0, error: 1, skipped: 0, all_skipped: false }
          : outcome === 'all_skipped'
            ? { total: 1, passed: 0, failed: 0, blocked: 0, error: 0, skipped: 1, all_skipped: true }
            : undefined;
  const core = {
    schema_version: 'local-qa-runtime-snapshot/v1' as const,
    snapshot_ref: 'local-qa://runtime/snapshots/1',
    snapshot_version: 1,
    run_id: attempt.run_id,
    attempt: binding,
    state,
    event_sequence: 0,
    progress: { phase: state, completed_cases: outcome === undefined ? 0 : 1, total_cases: 1, last_event_sequence: 0 },
    ...(outcome === undefined ? {} : {
      execution_outcome: outcome,
      evidence_outcome: 'complete' as const,
      upload_outcome: 'not_required' as const,
      cleanup_outcome: 'complete' as const,
      results: {
        schema_version: 'talos.testing-terminal-refs/v1' as const,
        binding: resultBinding,
        ...(summary === undefined ? {} : {
          case_result_set: {
            schema: 'testing-case-result-set.v2' as const,
            schema_digest: digest,
            ref: 'artifact://runtime/results/1',
            digest,
            binding: resultBinding
          }
        }),
        evidence_manifest: {
          schema: 'testing-evidence-manifest.v1' as const,
          schema_digest: digest,
          ref: 'artifact://runtime/evidence-manifests/1',
          digest,
          binding: resultBinding
        },
        cleanup_receipt: { schema: 'qa.local-cleanup-receipt/v2' as const, schema_digest: digest, ref: 'artifact://runtime/cleanup-receipts/1', digest, binding: resultBinding }
      },
      ...(summary === undefined ? {} : { summary })
    }),
    updated_at: observedAt
  };
  return { ...core, snapshot_digest: computeLocalQARuntimeSnapshotDigest(core) } as LocalQARuntimeSnapshot;
};

const eventPage = (runId: string, afterSequence = 0, snapshotDigest = digest) => ({
  schema_version: 'local-qa-runtime-event-page/v1' as const,
  run_id: runId,
  after_sequence: afterSequence,
  events: [],
  through_sequence: afterSequence,
  has_more: false,
  snapshot_digest: snapshotDigest
});

const cancelAcknowledgement = (
  runId: string,
  requestDigest: string,
  currentSnapshot: LocalQARuntimeSnapshot,
  id: string
) => ({
  schema_version: 'local-qa-runtime-cancel-ack/v1' as const,
  run_id: runId,
  request_digest: requestDigest,
  disposition: 'accepted' as const,
  cancel_intent_ref: {
    schema: 'qa.local-cancel-intent/v1' as const,
    ref: `artifact://runtime/cancel-intents/${id}`,
    digest
  },
  snapshot: currentSnapshot,
  acknowledged_at: observedAt
});

const authorizationEnvelope = (operation: string) => ({
  schema_version: 'owner.pending-authorization/v1',
  operation,
  signature: 'signed-envelope'
});

const resolver = (
  observe?: (request: TestingAuthorizationResolutionRequest) => void
): TestingAuthorizationResolver => ({
  resolve: async (request) => {
    observe?.(request);
    const authorization = authorizationEnvelope(request.operation);
    const reference = request.authorization_reference ?? {
      ref: `authorization://local-qa-request/${request.operation}-1`,
      digest: digestJson(authorization),
      expires_at: deadline
    };
    const envelope = request.authorization_reference === undefined
      ? authorization
      : request.operation === 'start'
        ? authorizationEnvelope('start')
        : authorizationEnvelope('reconcile');
    return testingAuthorizationResolutionSchema.parse({
      schema_version: 'talos.testing-authorization-resolution/v1',
      operation: request.operation,
      authorization_reference: reference,
      attempt: request.attempt,
      current_claim_digest: request.current_claim_digest,
      http_method: request.http_method,
      canonical_path: request.canonical_path,
      body_digest: request.body_digest,
      authorization: envelope,
      signature_verified: true,
      signer_key_id: 'hosted-key-1',
      verified_at: observedAt
    });
  }
});

const fakeControlPlane = (
  fixture: ReturnType<typeof startFixture>,
  calls: string[],
  overrides: {
    heartbeat?: () => boolean;
    currentClaim?: () => TestingCurrentClaimEnvelope;
  } = {}
): TestingWorkerControlPlane => ({
  claim: async () => undefined,
  claimReconcile: async () => undefined,
  heartbeat: async () => {
    calls.push('heartbeat');
    const cancelRequested = overrides.heartbeat?.() ?? false;
    return {
      lease_expires_at: deadline,
      cancel_requested: cancelRequested,
      current_claim: cancelRequested
        ? { ...fixture.claim.current_claim, is_current: false, status: 'cancel_requested' }
        : fixture.claim.current_claim
    };
  },
  acceptLocal: async () => { calls.push('accept'); return fixture.claim.current_claim; },
  markRunning: async () => { calls.push('running'); return fixture.claim.current_claim; },
  commitTerminal: async (_credentials, projection) => { calls.push(`commit:${projection.controlStatus}`); },
  commitReconcileTerminal: async () => { throw new Error('start cannot reconcile terminal'); },
  confirmNotAccepted: async () => { throw new Error('start cannot report reconcile fact'); },
  resolveRuntimeCurrentClaim: async (_runId, _claimId, requestNonce) => ({
    ...(overrides.currentClaim?.() ?? currentClaim(fixture.attempt, 'local-qa-runtime')),
    request_nonce: requestNonce
  })
});
