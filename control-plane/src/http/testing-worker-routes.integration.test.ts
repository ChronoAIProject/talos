import { describe, expect, it } from 'vitest';
import { digestJson } from '@talos/testing-protocol';
import { hashWorkerToken } from '../config.js';
import { ProfileLockService } from '../services/profile-lock.js';
import { Scheduler } from '../services/scheduler.js';
import { TaskService } from '../services/task-service.js';
import { TestingAttemptService } from '../services/testing-attempt-service.js';
import { TestingRunService } from '../services/testing-run-service.js';
import { WebhookSigner } from '../services/webhook-signer.js';
import { MemoryRepository } from '../storage/memory-repository.js';
import { createApiServer } from './server.js';
import {
  testTestingPlacementInputVerifier,
  testTestingPlacementPolicy
} from '../test-support/testing-placement.js';
import { testResolvedIdentity } from '../test-support/testing-transport.js';

const digest = `sha256:${'a'.repeat(64)}`;
const reference = (schema: string, ref: string) => ({ schema, ref, digest });
const policy = {
  network_scope: 'environment_owned_loopback_exact_origins',
  environment_port_handle_policy: { source: 'current_run_owned_handles', allow_unowned_loopback: false },
  allowed_actions: ['navigate'],
  allowed_evidence_media: ['image/png'],
  secret_refs: [],
  budgets: {
    wall_time_ms: 600_000,
    max_cases: 20,
    max_actions: 200,
    max_events: 2_000,
    max_screenshots: 20,
    max_screenshot_bytes: 5_242_880,
    max_json_evidence_bytes: 1_048_576,
    max_total_artifact_bytes: 52_428_800
  }
} as const;

const submitRequest = (key: string) => ({
  schema_version: 'talos.testing-tool-request/v1',
  request_id: `request:${key}`,
  client_correlation_id: `client:${key}`,
  idempotency_key: key,
  display_goal: 'Exercise worker attempt routes',
  inputs: {
    schema_version: 'talos.testing-input-references/v1',
    project_pack_snapshot: reference('pql.project-pack-snapshot/v1', 'artifact://pql/project-pack-snapshot/snapshot-1'),
    test_selection: reference('pql.test-selection/v1', 'artifact://pql/test-selection/selection-1'),
    testing_design_input_set: reference('pql.testing-design-input-set.v1', 'artifact://pql/testing-design-input-set/input-1'),
    source_revision: {
      repository_id: 'repo-1',
      exact_revision: '0123456789abcdef0123456789abcdef01234567',
      ref: 'artifact://source/revision-1',
      digest
    },
    structured_plan: reference('testing-structured-plan.v2', 'artifact://plans/plan-1'),
    environment_profile: { ref: 'artifact://environments/environment-1', digest },
    testing_package: { package_id: 'testing-browser-runner', version: '1.0', digest }
  },
  execution_profile: 'local_qa_agent_mvp',
  placement_requirements: { testing_runtime: 'local-qa-mvp/v1' },
  policy_binding: {
    policy: {
      schema: 'talos.testing-execution-policy/v1',
      ref: 'talos://policies/testing/policy-1',
      digest: digestJson(policy)
    },
    budgets: {
      schema: 'talos.testing-budgets/v1',
      ref: 'talos://policies/testing/budgets-1',
      digest: digestJson(policy.budgets)
    }
  },
  policy
});

const testingTags = {
  testing_runtime: 'local-qa-mvp/v1',
  testing_task_contract: 'talos.testing-task/v1',
  testing_backend: 'browser',
  browser: 'chromium',
  os: 'darwin',
  arch: 'arm64',
  headed_display: true,
  runner_package_id: 'testing-browser-runner',
  runner_package_version: '1.0',
  runner_package_digest: digest
};

describe('Testing worker HTTP routes', () => {
  it('dispatches an exact attempt, resolves its signed claim, and commits bounded results', async () => {
    let now = Date.parse('2026-08-22T00:00:00.000Z');
    const repository = new MemoryRepository();
    await repository.savePool({ id: 'testing-pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({
      id: 'machine-1',
      poolId: 'testing-pool',
      tags: testingTags,
      capacity: 1,
      activeLeases: 0,
      online: true,
      workerTokenHash: hashWorkerToken('testing-worker-token-1234')
    });
    await repository.saveMachine({
      id: 'machine-2',
      poolId: 'testing-pool',
      tags: testingTags,
      capacity: 1,
      activeLeases: 0,
      online: true,
      workerTokenHash: hashWorkerToken('other-worker-token-12345')
    });
    const tasks = new TaskService(
      repository,
      new Scheduler(repository),
      new ProfileLockService(repository),
      new WebhookSigner('webhook-secret-1234')
    );
    const runs = new TestingRunService(repository, {
      cursorSecret: 'testing-cursor-secret-123456',
      clock: () => now,
      placementPolicy: testTestingPlacementPolicy(),
      placementInputVerifier: testTestingPlacementInputVerifier()
    });
    const attempts = new TestingAttemptService(repository, {
      authorizationProvider: {
        issueStartAuthorization: async (context) => ({
          ref: `authorization://local-qa-request/${context.attemptId}`,
          digest,
          expires_at: context.deadline
        }),
        issueReconcileAuthorization: async (context) => ({
          ref: `authorization://local-qa-reconcile/${context.attemptId}/${context.leaseId}`,
          digest,
          expires_at: context.deadline
        })
      },
      runtimeFactVerifier: {
        verifyTerminalNoLocalAcceptance: async (fact) => ({
          schemaVersion: 'talos.testing-no-local-acceptance-verification/v1',
          disposition: 'never_accepted',
          journalVersion: fact.journal_version,
          startClaimDigest: fact.start_claim_digest,
          reconcileClaimDigest: fact.reconcile_claim_digest
        })
      },
      cleanupReceiptVerifier: {
        verifyCleanupReceipt: async (receipt, context) => ({
          schemaVersion: 'talos.testing-cleanup-receipt-verification/v1',
          verifierId: 'runtime-cleanup-authority',
          verificationId: `cleanup-verification-${context.attemptId}`,
          receiptRef: receipt.ref,
          receiptDigest: receipt.digest,
          disposition: context.cleanupOutcome === 'complete' ? 'cleanup_complete' : 'cleanup_not_required',
          verifiedAt: new Date(now).toISOString()
        })
      },
      clock: () => now,
      leaseSeconds: 1
    });
    const server = createApiServer(tasks, repository, {
      testingRunService: runs,
      testingAttemptService: attempts,
      identityResolver: {
        resolve: (token) => {
          const match = /^submit:([^:]+):(.+)$/.exec(token);
          if (match !== null) return testResolvedIdentity(match[1]!, submitRequest(match[2]!));
          if (token === 'user:user-1') return { userId: 'user-1', groups: [], permissions: [] };
          return undefined;
        }
      },
      clock: () => now
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    const userHeaders = { 'x-nyxid-identity-token': 'user:user-1', 'content-type': 'application/json' };
    const workerHeaders = {
      'x-talos-worker-token': 'testing-worker-token-1234',
      'x-talos-machine-id': 'machine-1',
      'x-talos-worker-id': 'worker-1',
      'content-type': 'application/json'
    };
    const otherWorkerHeaders = {
      'x-talos-worker-token': 'other-worker-token-12345',
      'x-talos-machine-id': 'machine-2',
      'x-talos-worker-id': 'worker-2',
      'content-type': 'application/json'
    };
    const restartedWorkerHeaders = {
      'x-talos-worker-token': 'testing-worker-token-1234',
      'x-talos-machine-id': 'machine-1',
      'x-talos-worker-id': 'worker-restarted',
      'content-type': 'application/json'
    };

    const submit = async (runId: string, key: string): Promise<void> => {
      const response = await fetch(`${base}/v1/tools/testing/runs/${runId}`, {
        method: 'PUT',
        headers: { ...userHeaders, 'x-nyxid-identity-token': `submit:${runId}:${key}` },
        body: JSON.stringify(submitRequest(key))
      });
      expect(response.status).toBe(201);
    };

    try {
      await submit('run-http', 'submit-http');
      const strictClaim = await fetch(`${base}/v1/worker/testing/claim`, {
        method: 'POST',
        headers: workerHeaders,
        body: JSON.stringify({ worker_id: 'worker-1', machine_id: 'machine-1', unknown: true })
      });
      expect(strictClaim.status).toBe(400);
      const claimedResponse = await fetch(`${base}/v1/worker/testing/claim`, {
        method: 'POST',
        headers: workerHeaders,
        body: JSON.stringify({ worker_id: 'worker-1', machine_id: 'machine-1' })
      });
      expect(claimedResponse.status).toBe(200);
      const claimed = await claimedResponse.json() as {
        task: {
          id: string;
          dispatch_attempt_id: string;
          generation: number;
          fence_token: string;
          admission_nonce: string;
          lease_id: string;
          worker_id: string;
          machine_id: string;
        };
        lease_token: string;
        current_claim: {
          claim: { claim_id: string };
          claim_digest: string;
          observed_at: string;
          signature: string;
        };
      };
      expect(claimed).toMatchObject({
        task: { kind: 'testing', worker_id: 'worker-1', machine_id: 'machine-1' },
        current_claim: { is_current: true, status: 'current' }
      });
      expect(claimed.current_claim.signature).toMatch(/^ed25519:[A-Za-z0-9_-]{86}$/);

      const runtimeNonce = 'runtime-resolver-nonce-1234';
      const runtimeResolved = await fetch(
        `${base}/v1/testing/claims/run-http/${claimed.current_claim.claim.claim_id}/resolve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            schema_version: 'talos.testing-current-claim-resolve-request/v1',
            audience: 'local-qa-runtime',
            request_nonce: runtimeNonce
          })
        }
      );
      expect(runtimeResolved.status).toBe(200);
      expect(await runtimeResolved.json()).toMatchObject({
        audience: 'local-qa-runtime',
        request_nonce: runtimeNonce,
        is_current: true
      });

      const claimUrl = `${base}/v1/worker/testing/claims/run-http/${claimed.current_claim.claim.claim_id}`;
      expect((await fetch(claimUrl, { headers: otherWorkerHeaders })).status).toBe(401);
      const resolved = await fetch(claimUrl, { headers: workerHeaders });
      expect(resolved.status).toBe(200);
      expect(JSON.stringify(await resolved.json())).not.toContain(claimed.lease_token);

      const binding = {
        attempt_id: claimed.task.dispatch_attempt_id,
        generation: claimed.task.generation,
        fence_token: claimed.task.fence_token,
        lease_token: claimed.lease_token
      };
      const heartbeat = await fetch(`${base}/v1/worker/testing/runs/run-http/heartbeat`, {
        method: 'POST',
        headers: workerHeaders,
        body: JSON.stringify({
          ...binding,
          extend_seconds: 10,
          progress: { phase: 'preparing', completed_cases: 0, total_cases: 1, runtime_event_sequence: 2 }
        })
      });
      expect(heartbeat.status).toBe(200);
      expect(await heartbeat.json()).toMatchObject({ cancel_requested: false });
      const localAccept = await fetch(`${base}/v1/worker/testing/runs/run-http/local-accept`, {
        method: 'POST', headers: workerHeaders, body: JSON.stringify(binding)
      });
      expect(localAccept.status).toBe(200);
      expect(await localAccept.json()).toMatchObject({
        schema_version: 'talos.testing-worker-mutation-ack/v1',
        operation: 'local_accept',
        run_id: 'run-http',
        attempt_id: binding.attempt_id,
        mutation_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        current_claim: { is_current: true }
      });
      const runningAck = await fetch(`${base}/v1/worker/testing/runs/run-http/running`, {
        method: 'POST', headers: workerHeaders, body: JSON.stringify(binding)
      });
      expect(runningAck.status).toBe(200);
      expect(await runningAck.json()).toMatchObject({ operation: 'running', control_status: 'running' });

      const terminalBinding = {
        run_id: 'run-http',
        task_id: claimed.task.id,
        attempt_id: claimed.task.dispatch_attempt_id,
        generation: claimed.task.generation,
        fence_token: claimed.task.fence_token
      };
      const result = await fetch(`${base}/v1/worker/testing/runs/run-http/result`, {
        method: 'POST',
        headers: workerHeaders,
        body: JSON.stringify({
          ...binding,
          control_status: 'completed',
          execution_outcome: 'passed',
          evidence_outcome: 'complete',
          upload_outcome: 'uploaded',
          cleanup_outcome: 'complete',
          results: {
            schema_version: 'talos.testing-terminal-refs/v1',
            binding: terminalBinding,
            cleanup_receipt: {
              schema: 'qa.local-cleanup-receipt/v2',
              ref: 'artifact://testing/cleanup/run-http',
              digest,
              binding: terminalBinding
            }
          }
        })
      });
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({
        operation: 'terminal', run_id: 'run-http', control_status: 'completed',
        attempt_id: binding.attempt_id,
        mutation_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
      });
      expect(await (await fetch(`${base}/v1/tools/testing/runs/run-http`, { headers: userHeaders })).json())
        .toMatchObject({ control_status: 'completed', execution_outcome: 'passed' });

      await submit('run-reconcile', 'submit-reconcile');
      const second = await (await fetch(`${base}/v1/worker/testing/claim`, {
        method: 'POST',
        headers: workerHeaders,
        body: JSON.stringify({ worker_id: 'worker-1', machine_id: 'machine-1' })
      })).json() as typeof claimed;
      const secondBinding = {
        attempt_id: second.task.dispatch_attempt_id,
        generation: second.task.generation,
        fence_token: second.task.fence_token,
        lease_token: second.lease_token
      };
      expect((await fetch(`${base}/v1/worker/testing/runs/run-reconcile/local-accept`, {
        method: 'POST', headers: workerHeaders, body: JSON.stringify(secondBinding)
      })).status).toBe(200);
      now += 1_001;
      await attempts.sweep();
      const reconcileClaimResponse = await fetch(
        `${base}/v1/worker/testing/reconcile-claim`,
        {
          method: 'POST',
          headers: restartedWorkerHeaders,
          body: JSON.stringify({ worker_id: 'worker-restarted', machine_id: 'machine-1' })
        }
      );
      expect(reconcileClaimResponse.status).toBe(200);
      const reconcileClaim = await reconcileClaimResponse.json() as {
        task: {
          task_id: string;
          dispatch_attempt_id: string;
          generation: number;
          fence_token: string;
        };
        lease_token: string;
      };
      const reconcileBinding = {
        attempt_id: reconcileClaim.task.dispatch_attempt_id,
        generation: reconcileClaim.task.generation,
        fence_token: reconcileClaim.task.fence_token,
        lease_token: reconcileClaim.lease_token
      };
      const reconcileTerminalBinding = {
        run_id: 'run-reconcile',
        task_id: reconcileClaim.task.task_id,
        attempt_id: reconcileClaim.task.dispatch_attempt_id,
        generation: reconcileClaim.task.generation,
        fence_token: reconcileClaim.task.fence_token
      };
      const reconcile = await fetch(`${base}/v1/worker/testing/runs/run-reconcile/reconcile`, {
        method: 'POST',
        headers: restartedWorkerHeaders,
        body: JSON.stringify({
          ...reconcileBinding,
          control_status: 'failed',
          execution_outcome: 'lost_or_inconclusive',
          evidence_outcome: 'unavailable',
          upload_outcome: 'not_required',
          cleanup_outcome: 'complete',
          results: {
            schema_version: 'talos.testing-terminal-refs/v1',
            binding: reconcileTerminalBinding,
            cleanup_receipt: {
              schema: 'qa.local-cleanup-receipt/v2',
              ref: 'artifact://testing/cleanup/run-reconcile',
              digest,
              binding: reconcileTerminalBinding
            }
          },
          safe_error: { code: 'runtime_lost', message: 'runtime state was reconciled', retryable: false }
        })
      });
      expect(reconcile.status).toBe(200);
      expect(await reconcile.json()).toMatchObject({ run_id: 'run-reconcile', control_status: 'failed' });

      await submit('run-not-accepted', 'submit-not-accepted');
      const third = await (await fetch(`${base}/v1/worker/testing/claim`, {
        method: 'POST',
        headers: workerHeaders,
        body: JSON.stringify({ worker_id: 'worker-1', machine_id: 'machine-1' })
      })).json() as typeof claimed;
      now += 1_001;
      await attempts.sweep();
      const factReconcile = await (await fetch(
        `${base}/v1/worker/testing/runs/run-not-accepted/reconcile-claim`,
        {
          method: 'POST',
          headers: restartedWorkerHeaders,
          body: JSON.stringify({ worker_id: 'worker-restarted', machine_id: 'machine-1' })
        }
      )).json() as {
        task: { dispatch_attempt_id: string; generation: number; fence_token: string; lease_id: string };
        lease_token: string;
        current_claim: {
          claim: { claim_id: string };
          claim_digest: string;
          observed_at: string;
        };
      };
      const notAccepted = await fetch(`${base}/v1/worker/testing/runs/run-not-accepted/not-accepted`, {
        method: 'POST',
        headers: restartedWorkerHeaders,
        body: JSON.stringify({
          attempt_id: factReconcile.task.dispatch_attempt_id,
          generation: factReconcile.task.generation,
          fence_token: factReconcile.task.fence_token,
          lease_token: factReconcile.lease_token,
          fact: {
            schema_version: 'talos.testing-no-local-acceptance-fact/v1',
            run_id: 'run-not-accepted',
            task_id: third.task.id,
            attempt_id: third.task.dispatch_attempt_id,
            machine_id: third.task.machine_id,
            worker_id: third.task.worker_id,
            lease_id: third.task.lease_id,
            generation: third.task.generation,
            fence_token: third.task.fence_token,
            admission_nonce: third.task.admission_nonce,
            start_claim_digest: third.current_claim.claim_digest,
            reconcile_claim_id: factReconcile.current_claim.claim.claim_id,
            reconcile_lease_id: factReconcile.task.lease_id,
            reconcile_claim_digest: factReconcile.current_claim.claim_digest,
            journal_version: 1,
            disposition: 'never_accepted',
            fact_ref: `local-qa://runtime/facts/${third.task.dispatch_attempt_id}`,
            fact_digest: digest,
            observed_at: factReconcile.current_claim.observed_at
          }
        })
      });
      expect(notAccepted.status).toBe(200);
      expect(await notAccepted.json()).toMatchObject({
        operation: 'not_accepted', run_id: 'run-not-accepted', control_status: 'submitted',
        mutation_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
      });
      expect(await repository.getTestingMachineReservation('machine-1')).toBeUndefined();

      const currentMachine = await repository.getMachine('machine-1');
      if (currentMachine === undefined) throw new Error('testing machine missing');
      await repository.saveMachine({
        ...currentMachine,
        workerTokenHash: hashWorkerToken('rotated-testing-worker-token-1234')
      });
      expect((await fetch(`${base}/v1/worker/testing/claim`, {
        method: 'POST',
        headers: workerHeaders,
        body: JSON.stringify({ worker_id: 'worker-1', machine_id: 'machine-1' })
      })).status).toBe(401);
    } finally {
      server.close();
    }
  });
});
