import { describe, expect, it, vi } from 'vitest';
import {
  computeTestingCurrentClaimDigest,
  computeTestingWorkerMutationDigest,
  type TestingWorkerMutationOperation
} from '@talos/testing-protocol';
import { HttpTestingWorkerClient } from './control-plane-client.js';

const deadline = '2026-08-24T00:10:00.000Z';
const claimIdentity = {
  schema_version: 'talos.testing-claim-identity/v1' as const,
  operation: 'start' as const,
  claim_id: 'claim-1',
  run_id: 'run-1',
  task_id: 'task-1',
  attempt_id: 'attempt-1',
  machine_id: 'machine-1',
  worker_id: 'worker-1',
  generation: 1,
  lease_id: 'lease-1',
  fence_token: 'testing-fence-token-1',
  admission_nonce: 'testing-admission-1',
  issued_at: '2026-08-24T00:00:00.000Z',
  expires_at: deadline
};
const currentClaim = {
  schema_version: 'talos.testing-current-claim/v1',
  claim: claimIdentity,
  claim_digest: computeTestingCurrentClaimDigest(claimIdentity),
  audience: 'talos-worker',
  request_nonce: 'worker-request-nonce-1',
  is_current: true,
  status: 'current',
  lease_expires_at: deadline,
  observed_at: '2026-08-24T00:00:00.000Z',
  valid_until: '2026-08-24T00:00:05.000Z',
  key_id: 'claim-key-1',
  signature: `ed25519:${'A'.repeat(86)}`
};
const credentials = {
  runId: 'run-1',
  attemptId: 'attempt-1',
  generation: 1,
  fenceToken: 'testing-fence-token-1',
  leaseToken: 'private-lease-token'
};
const terminal = {
  controlStatus: 'completed' as const,
  executionOutcome: 'passed' as const,
  evidenceOutcome: 'complete' as const,
  uploadOutcome: 'not_required' as const,
  cleanupOutcome: 'residual_blocking' as const
};
const terminalPayload = {
  control_status: terminal.controlStatus,
  execution_outcome: terminal.executionOutcome,
  evidence_outcome: terminal.evidenceOutcome,
  upload_outcome: terminal.uploadOutcome,
  cleanup_outcome: terminal.cleanupOutcome
};

describe('HttpTestingWorkerClient', () => {
  it('keeps testing claim, heartbeat, terminal, and Runtime claim resolution on the outbound worker protocol', async () => {
    const responses = [
      new Response(JSON.stringify({ error: { code: 'not_found', message: 'empty' } }), { status: 404 }),
      new Response(JSON.stringify({ error: { code: 'not_found', message: 'empty' } }), { status: 404 }),
      new Response(JSON.stringify({ lease_expires_at: deadline, cancel_requested: false, current_claim: currentClaim }), { status: 200 }),
      new Response(JSON.stringify(mutationAck('local_accept', {}, 'local_accepted', currentClaim)), { status: 200 }),
      new Response(JSON.stringify(mutationAck('running', {}, 'running', currentClaim)), { status: 200 }),
      new Response(JSON.stringify(mutationAck('terminal', terminalPayload, 'completed')), { status: 200 }),
      new Response(JSON.stringify(mutationAck('reconcile_terminal', terminalPayload, 'completed')), { status: 200 }),
      new Response(JSON.stringify({
        ...currentClaim,
        audience: 'local-qa-runtime',
        request_nonce: 'runtime-request-nonce-1'
      }), { status: 200 })
    ];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift() ?? new Response('{}'));
    const client = new HttpTestingWorkerClient({
      controlPlaneUrl: 'https://nyxid.example/public/s/talos-worker',
      workerId: 'worker-1',
      machineId: 'machine-1',
      workerToken: 'worker-token-123456'
    });
    expect(await client.claim()).toBeUndefined();
    expect(await client.claimReconcile()).toBeUndefined();
    await client.heartbeat(credentials, {
      phase: 'executing', completed_cases: 1, total_cases: 2, runtime_event_sequence: 8
    });
    await client.acceptLocal(credentials);
    await client.markRunning(credentials);
    await client.commitTerminal(credentials, terminal);
    await client.commitReconcileTerminal(credentials, terminal);
    const runtimeClaim = await client.resolveRuntimeCurrentClaim('run-1', 'claim-1', 'runtime-request-nonce-1');
    expect(runtimeClaim.audience).toBe('local-qa-runtime');

    expect(fetchMock.mock.calls.map((call) => new URL(call[0].toString()).pathname)).toEqual([
      '/public/s/talos-worker/v1/worker/testing/claim',
      '/public/s/talos-worker/v1/worker/testing/reconcile-claim',
      '/public/s/talos-worker/v1/worker/testing/runs/run-1/heartbeat',
      '/public/s/talos-worker/v1/worker/testing/runs/run-1/local-accept',
      '/public/s/talos-worker/v1/worker/testing/runs/run-1/running',
      '/public/s/talos-worker/v1/worker/testing/runs/run-1/result',
      '/public/s/talos-worker/v1/worker/testing/runs/run-1/reconcile',
      '/public/s/talos-worker/v1/testing/claims/run-1/claim-1/resolve'
    ]);
    const heartbeatBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as Record<string, unknown>;
    expect(heartbeatBody).toMatchObject({
      worker_id: 'worker-1', machine_id: 'machine-1', lease_token: 'private-lease-token',
      progress: { runtime_event_sequence: 8 }
    });
    const resolverBody = JSON.parse(String(fetchMock.mock.calls[7]?.[1]?.body)) as Record<string, unknown>;
    expect(resolverBody).not.toHaveProperty('worker_token');
    fetchMock.mockRestore();
  });

  it('aborts a pending control-plane request during shutdown', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }));
    const client = new HttpTestingWorkerClient({
      controlPlaneUrl: 'https://nyxid.example/public/s/talos-worker',
      workerId: 'worker-1',
      machineId: 'machine-1',
      workerToken: 'worker-token-123456'
    });
    const shutdown = new AbortController();
    const pending = client.claim(shutdown.signal);
    shutdown.abort(new Error('worker shutdown'));
    await expect(pending).rejects.toThrow('worker shutdown');
    fetchMock.mockRestore();
  });

  it('does not expose control-plane error messages that echo worker credentials', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'worker_denied', message: 'echo worker-token-123456' }
    }), { status: 403 }));
    const client = new HttpTestingWorkerClient({
      controlPlaneUrl: 'https://nyxid.example/public/s/talos-worker',
      workerId: 'worker-1',
      machineId: 'machine-1',
      workerToken: 'worker-token-123456'
    });
    await expect(client.claim()).rejects.toMatchObject({
      code: 'worker_denied',
      message: 'testing control plane request failed (403)',
      status: 403
    });
    fetchMock.mockRestore();
  });

  it('rejects a terminal acknowledgement for another run', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(
      mutationAck('terminal', terminalPayload, 'completed', undefined, 'run-other')
    ), { status: 200 }));
    const client = new HttpTestingWorkerClient({
      controlPlaneUrl: 'https://nyxid.example/public/s/talos-worker',
      workerId: 'worker-1',
      machineId: 'machine-1',
      workerToken: 'worker-token-123456'
    });
    await expect(client.commitTerminal(credentials, terminal))
      .rejects.toMatchObject({ code: 'testing_control_plane_ack_mismatch' });
    fetchMock.mockRestore();
  });

  it('rejects a same-attempt acknowledgement for another mutation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(
      mutationAck('running', {}, 'running', currentClaim)
    ), { status: 200 }));
    const client = new HttpTestingWorkerClient({
      controlPlaneUrl: 'https://nyxid.example/public/s/talos-worker',
      workerId: 'worker-1',
      machineId: 'machine-1',
      workerToken: 'worker-token-123456'
    });
    await expect(client.acceptLocal(credentials))
      .rejects.toMatchObject({ code: 'testing_control_plane_ack_mismatch' });
    fetchMock.mockRestore();
  });
});

const mutationAck = (
  operation: TestingWorkerMutationOperation,
  payload: Readonly<Record<string, unknown>>,
  controlStatus: string,
  claim?: typeof currentClaim,
  runId = credentials.runId
) => ({
  schema_version: 'talos.testing-worker-mutation-ack/v1',
  operation,
  run_id: runId,
  attempt_id: credentials.attemptId,
  generation: credentials.generation,
  fence_token: credentials.fenceToken,
  mutation_digest: computeTestingWorkerMutationDigest({
    schema_version: 'talos.testing-worker-mutation/v1',
    operation,
    run_id: runId,
    attempt_id: credentials.attemptId,
    generation: credentials.generation,
    fence_token: credentials.fenceToken,
    lease_token: credentials.leaseToken,
    payload
  }),
  control_status: controlStatus,
  snapshot_version: 4,
  ...(claim === undefined ? {} : { current_claim: claim })
});
