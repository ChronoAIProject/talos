import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { digestJson } from '@talos/testing-protocol';
import { createControlPlane } from './index.js';
import { MemoryRepository } from './storage/memory-repository.js';
import {
  testTestingInputReferences,
  testTestingPlacementInputVerifier,
  testTestingPlacementPolicy
} from './test-support/testing-placement.js';
import { testTestingExternalSchemaAuthority } from './test-support/testing-schema-authority.js';
import { testResolvedIdentity } from './test-support/testing-transport.js';

const digest = `sha256:${'a'.repeat(64)}`;
const testingPolicy = {
  network_scope: 'environment_owned_loopback_exact_origins',
  environment_port_handle_policy: {
    source: 'current_run_owned_handles',
    allow_unowned_loopback: false
  },
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('control-plane factory', () => {
  it('wires a stoppable lease sweep', () => {
    const server = createControlPlane(undefined, 'webhook-secret-1234', { sweepIntervalMs: 100000, adminToken: 'admin-token-123456' });
    expect(typeof server.stopSweep).toBe('function');
    server.stopSweep();
  });

  it('fails fast without a webhook secret', () => {
    expect(() => createControlPlane(undefined, undefined)).toThrow('TALOS_WEBHOOK_SECRET');
  });

  it('fails fast when the OpenAPI spec is unreadable', () => {
    expect(() => createControlPlane(new MemoryRepository(), 'webhook-secret-1234', {
      openApiPath: '/missing/talos-openapi.yaml'
    })).toThrow('failed to load OpenAPI spec');
  });

  it('keeps Testing admission closed for a start-only authorization provider', async () => {
    const repository = new MemoryRepository();
    const { privateKey } = generateKeyPairSync('ed25519');
    const runId = 'run-start-only-authorization';
    const request = {
      schema_version: 'talos.testing-tool-request/v1' as const,
      request_id: 'request-start-only-authorization',
      client_correlation_id: 'client-start-only-authorization',
      idempotency_key: 'submit-start-only-authorization',
      display_goal: 'Reject incomplete authorization provider',
      inputs: testTestingInputReferences('repo-1'),
      execution_profile: 'local_qa_agent_mvp' as const,
      placement_requirements: { testing_runtime: 'local-qa-mvp/v1' as const },
      policy_binding: {
        policy: {
          schema: 'talos.testing-execution-policy/v1' as const,
          ref: 'talos://policies/testing/policy-1',
          digest: digestJson(testingPolicy)
        },
        budgets: {
          schema: 'talos.testing-budgets/v1' as const,
          ref: 'talos://policies/testing/budgets-1',
          digest: digestJson(testingPolicy.budgets)
        }
      },
      policy: testingPolicy
    };
    const server = createControlPlane(repository, 'webhook-secret-1234', {
      sweepIntervalMs: 100000,
      adminToken: 'admin-token-123456',
      identityResolver: {
        resolve: () => testResolvedIdentity(runId, request, { groups: ['eng'] })
      },
      testingClaimSigningKey: privateKey,
      testingAuthorizationProvider: {
        issueStartAuthorization: async (context) => ({
          ref: `authorization://local-qa-request/${context.attemptId}`,
          digest,
          expires_at: context.deadline
        })
      },
      testingRuntimeFactVerifier: {
        verifyTerminalNoLocalAcceptance: async () => undefined
      },
      testingCleanupReceiptVerifier: {
        verifyCleanupReceipt: async () => undefined
      },
      testingPlacementPolicy: testTestingPlacementPolicy(),
      testingPlacementInputVerifier: testTestingPlacementInputVerifier(),
      testingExternalSchemaAuthority: testTestingExternalSchemaAuthority()
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('server did not bind');
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/tools/testing/capabilities`, {
        headers: { 'x-nyxid-identity-token': 'user:user-1' }
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        admission_availability: {
          status: 'unavailable',
          reason_code: 'testing_authorization_unavailable'
        }
      });

      const submit = await fetch(`http://127.0.0.1:${address.port}/v1/tools/testing/runs/${runId}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-nyxid-identity-token': 'user:user-1'
        },
        body: JSON.stringify(request)
      });
      expect(submit.status).toBe(503);
      expect(await submit.json()).toMatchObject({
        error: { code: 'testing_authorization_unavailable', retryable: true }
      });
      expect(await repository.getTestingRun(runId)).toBeUndefined();
    } finally {
      server.stopSweep();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('periodically expires active leases', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);
    const repository = new MemoryRepository();
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'm', poolId: 'pool', tags: {}, capacity: 1, activeLeases: 1, online: true, workerTokenHash: 'x' });
    await repository.saveTask({ id: 't', userId: 'u', kind: 'browse', goal: 'x', constraints: {}, mode: 'read_only', interaction: 'autonomous', status: 'running', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), leaseExpiresAt: new Date(1000).toISOString(), workerId: 'w', machineId: 'm', findings: [], artifacts: [] });
    const server = createControlPlane(repository, 'webhook-secret-1234', { sweepIntervalMs: 10, adminToken: 'admin-token-123456' });
    await vi.advanceTimersByTimeAsync(11);
    expect((await repository.getTask('t'))?.status).toBe('submitted');
    server.stopSweep();
  });

  it('periodically releases expired orphan testing reservations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const repository = new MemoryRepository();
    await repository.createTestingMachineReservation({
      machineId: 'testing-machine',
      runId: 'missing-run',
      taskId: 'missing-task',
      attemptId: 'orphan-attempt',
      generation: 1,
      fenceToken: 'fence-token-123456',
      status: 'reserved',
      expiresAt: new Date(1_000).toISOString(),
      recordVersion: 1
    });
    const server = createControlPlane(repository, 'webhook-secret-1234', {
      sweepIntervalMs: 10,
      adminToken: 'admin-token-123456'
    });
    await vi.advanceTimersByTimeAsync(11);
    expect(await repository.getTestingMachineReservation('testing-machine')).toBeUndefined();
    server.stopSweep();
  });

  it('serializes periodic sweeps instead of overlapping a slow pass', async () => {
    vi.useFakeTimers();
    const repository = new MemoryRepository();
    let releaseFirst: ((tasks: readonly []) => void) | undefined;
    const blocked = new Promise<readonly []>((resolve) => { releaseFirst = resolve; });
    const listTasks = vi.spyOn(repository, 'listTasks')
      .mockImplementationOnce(async () => blocked)
      .mockResolvedValue([]);
    const server = createControlPlane(repository, 'webhook-secret-1234', {
      sweepIntervalMs: 10,
      adminToken: 'admin-token-123456'
    });

    await vi.advanceTimersByTimeAsync(11);
    expect(listTasks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(listTasks).toHaveBeenCalledTimes(1);
    releaseFirst?.([]);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(11);
    expect(listTasks).toHaveBeenCalledTimes(2);
    server.stopSweep();
  });

  it('logs sweep rejections and recovers on the next interval without an unhandled rejection', async () => {
    vi.useFakeTimers();
    const repository = new MemoryRepository();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const listTasks = vi.spyOn(repository, 'listTasks')
      .mockRejectedValueOnce(new Error('task sweep unavailable'))
      .mockResolvedValue([]);
    const listTestingRuns = vi.spyOn(repository, 'listTestingRuns')
      .mockRejectedValueOnce(new Error('testing sweep unavailable'))
      .mockResolvedValue([]);
    const server = createControlPlane(repository, 'webhook-secret-1234', {
      sweepIntervalMs: 10,
      adminToken: 'admin-token-123456'
    });

    await vi.advanceTimersByTimeAsync(11);
    await vi.advanceTimersByTimeAsync(11);
    expect(listTasks.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(listTestingRuns.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(stderr.mock.calls.flat().join('\n')).toContain('task lease sweep failed');
    expect(stderr.mock.calls.flat().join('\n')).toContain('testing attempt sweep failed');
    server.stopSweep();
  });
});
