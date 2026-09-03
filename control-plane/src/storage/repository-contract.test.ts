import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Repository } from './repository.js';
import { MemoryRepository } from './memory-repository.js';
import { MongoRepository } from './mongo-repository.js';
import type { BrowserTask, WebhookEvent } from '../domain/types.js';
import { TestingRunService } from '../services/testing-run-service.js';
import { submitTestingRun } from '../test-support/testing-transport.js';
import { digestJson } from '@talos/testing-protocol';
import {
  provisionTestingPool,
  testTestingPlacementInputVerifier,
  testTestingPlacementPolicy
} from '../test-support/testing-placement.js';
import { testTestingExternalSchemaAuthority } from '../test-support/testing-schema-authority.js';
import { testTestingExecutionDependencyReadiness } from '../test-support/testing-execution-readiness.js';

interface Harness {
  repository: Repository;
  close: () => Promise<void>;
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => { resolve = resolver; });
  return { promise, resolve };
};

const MONGODB_MEMORY_SERVER_VERSION = '7.0.14';
const MONGODB_CONNECT_TIMEOUT_MS = 5_000;
const MONGODB_CONTRACT_TEST_TIMEOUT_MS = 30_000;
const mongodbClientOptions = {
  connectTimeoutMS: MONGODB_CONNECT_TIMEOUT_MS,
  serverSelectionTimeoutMS: MONGODB_CONNECT_TIMEOUT_MS
};

const baseTask = (overrides: Partial<BrowserTask> = {}): BrowserTask => ({
  id: 'task-1', userId: 'user-1', kind: 'browse', goal: 'check status', constraints: {}, mode: 'read_only',
  interaction: 'autonomous', status: 'submitted', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', findings: [], artifacts: [], ...overrides
});

const memoryHarness = async (): Promise<Harness> => {
  const repository = new MemoryRepository();
  return { repository, close: () => repository.close() };
};

let mongoServer: MongoMemoryServer | undefined;
let mongoUrl: string | undefined;

beforeAll(async () => {
  mongoUrl = process.env.TALOS_TEST_MONGODB_URL;
  if (mongoUrl === undefined) {
    mongoServer = await MongoMemoryServer.create({
      binary: { version: MONGODB_MEMORY_SERVER_VERSION }
    });
    mongoUrl = mongoServer.getUri();
  }
  const client = new MongoClient(mongoUrl, mongodbClientOptions);
  try {
    await client.connect();
    await client.db().command({ ping: 1 });
  } finally {
    await client.close();
  }
}, 300_000);

afterAll(async () => {
  await mongoServer?.stop();
}, 30_000);

const mongoHarness = async (): Promise<Harness> => {
  if (mongoUrl === undefined) throw new Error('Mongo contract setup did not provide a database URL');
  const client = new MongoClient(mongoUrl, mongodbClientOptions);
  const databaseName = `talos_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const repository = new MongoRepository(mongoUrl, databaseName, { client });
  try {
    await repository.initialize();
  } catch (error) {
    try {
      await client.db(databaseName).dropDatabase();
    } catch {
      // Preserve the initialization failure while still attempting bounded cleanup.
    } finally {
      await repository.close();
    }
    throw error;
  }
  return {
    repository,
    close: async () => {
      try {
        await client.db(databaseName).dropDatabase();
      } finally {
        await repository.close();
      }
    }
  };
};

const contractTests = (makeHarness: () => Promise<Harness>): void => {
  it('round-trips registry entities and task state', async () => {
    const { repository, close } = await makeHarness();
    try {
      await repository.savePool({ id: 'pool-1', visibility: 'org', ownerUserId: 'user-1', sharedWithGroups: ['eng'], tags: { os: 'linux' } });
      await repository.saveMachine({ id: 'machine-1', poolId: 'pool-1', tags: { browser: true }, capacity: 2, activeLeases: 0, online: true, workerTokenHash: 'hash' });
      await repository.saveProfile({ id: 'profile-1', userId: 'user-1', machineId: 'machine-1' });
      const task = baseTask({ profileId: 'profile-1', poolId: 'pool-1' });
      await repository.saveTask(task);
      await repository.saveHandoff({ id: 'handoff-1', taskId: task.id, userId: task.userId, url: '/v1/handoffs/handoff-1', expiresAt: '2025-01-01T00:10:00.000Z', used: false });
      const event: WebhookEvent = { id: 'event-1', type: 'task.state_changed', taskId: task.id, userId: task.userId, timestamp: task.createdAt, payload: { status: 'submitted' }, delivery: { status: 'pending', attempts: 0 } };
      await repository.saveWebhook(event);
      await repository.savePendingInput(task.id, { kind: 'text', value: 'secret' });
      expect(await repository.getPool('pool-1')).toMatchObject({ ownerUserId: 'user-1', sharedWithGroups: ['eng'] });
      expect(await repository.listPoolsByOwner('user-1')).toHaveLength(1);
      expect(await repository.getMachine('machine-1')).toMatchObject({ activeLeases: 0 });
      expect(await repository.listMachines('pool-1')).toHaveLength(1);
      expect(await repository.getProfile('profile-1')).toMatchObject({ machineId: 'machine-1' });
      expect(await repository.listProfilesByUser('user-1')).toHaveLength(1);
      expect(await repository.getTask(task.id)).toMatchObject({ poolId: 'pool-1', profileId: 'profile-1' });
      expect(await repository.listQueuedTasks()).toHaveLength(1);
      expect(await repository.getHandoff('handoff-1')).toMatchObject({ used: false });
      expect(await repository.getWebhook('event-1')).toMatchObject({ delivery: { status: 'pending', attempts: 0 } });
      expect(await repository.listWebhooks()).toHaveLength(1);
      expect(await repository.takePendingInput(task.id)).toEqual({ kind: 'text', value: 'secret' });
      expect(await repository.takePendingInput(task.id)).toBeUndefined();
      await repository.ping();
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('keeps requeued tasks ahead of fresh tasks and updates records', async () => {
    const { repository, close } = await makeHarness();
    try {
      await repository.saveTask(baseTask({ id: 'fresh', createdAt: '2025-01-01T00:01:00.000Z' }));
      await repository.saveTask(baseTask({ id: 'requeued', createdAt: '2025-01-01T00:02:00.000Z', queuePriority: -1 }));
      expect((await repository.listQueuedTasks()).map((task) => task.id)).toEqual(['requeued', 'fresh']);
      await repository.saveTask(baseTask({ id: 'fresh', status: 'running' }));
      expect((await repository.listQueuedTasks()).map((task) => task.id)).toEqual(['requeued']);
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('atomically relays one interactive action and correlates its result', async () => {
    const { repository, close } = await makeHarness();
    try {
      const action = {
        id: 'action-1',
        taskId: 'task-1',
        action: { type: 'navigate' as const, url: 'https://example.com' },
        state: 'pending' as const,
        createdAt: '2025-01-01T00:00:00.000Z'
      };
      expect(await repository.enqueueSessionAction(action)).toBe(true);
      expect(await repository.enqueueSessionAction({ ...action, id: 'action-2' })).toBe(false);
      expect(await repository.getPendingSessionAction(action.taskId)).toMatchObject({ id: action.id, state: 'pending' });
      expect(await repository.takePendingSessionAction(action.taskId)).toMatchObject({ id: action.id, state: 'dispatched' });
      expect(await repository.takePendingSessionAction(action.taskId)).toBeUndefined();
      await repository.requeueSessionAction(action.taskId);
      expect(await repository.takePendingSessionAction(action.taskId)).toMatchObject({ id: action.id, state: 'dispatched' });
      const completed = {
        actionId: action.id,
        taskId: action.taskId,
        result: { value: 'ok' },
        completedAt: '2025-01-01T00:00:01.000Z'
      };
      expect(await repository.finalizeSessionAction(completed, ['dispatched'])).toBe(true);
      expect(await repository.getSessionActionResult(action.id)).toMatchObject({ taskId: action.taskId, result: { value: 'ok' } });
      expect(await repository.getPendingSessionAction(action.taskId)).toBeUndefined();
      expect(await repository.finalizeSessionAction(completed, ['dispatched'])).toBe(false);
      expect(await repository.getSessionActionResult(action.id)).toEqual(completed);
      const pending = { ...action, id: 'action-cancel', state: 'pending' as const };
      expect(await repository.enqueueSessionAction(pending)).toBe(true);
      expect(await repository.getPendingSessionAction(action.taskId)).toMatchObject({ id: pending.id });
      const cancelled = {
        actionId: pending.id,
        taskId: pending.taskId,
        result: { error: { code: 'session_closed' } },
        completedAt: '2025-01-01T00:00:02.000Z'
      };
      expect(await repository.finalizeSessionAction(cancelled, ['pending'])).toBe(true);
      expect(await repository.finalizeSessionAction(cancelled, ['pending'])).toBe(false);
      expect(await repository.getSessionActionResult(pending.id)).toEqual(cancelled);
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('preserves a worker result when worker terminalization wins the teardown race', async () => {
    const { repository, close } = await makeHarness();
    try {
      const action = {
        id: 'action-worker-wins',
        taskId: 'task-worker-wins',
        action: { type: 'navigate' as const, url: 'https://example.com' },
        state: 'pending' as const,
        createdAt: '2025-01-01T00:00:00.000Z'
      };
      expect(await repository.enqueueSessionAction(action)).toBe(true);
      let browserExecutions = 0;
      if (await repository.takePendingSessionAction(action.taskId) !== undefined) browserExecutions += 1;
      const workerResult = {
        actionId: action.id,
        taskId: action.taskId,
        result: { value: 'worker-result' },
        completedAt: '2025-01-01T00:00:01.000Z'
      };
      const teardownResult = {
        actionId: action.id,
        taskId: action.taskId,
        result: { error: { code: 'session_closed' } },
        completedAt: '2025-01-01T00:00:02.000Z'
      };
      const teardownBarrier = deferred();
      const teardown = (async () => {
        await teardownBarrier.promise;
        return repository.finalizeSessionAction(teardownResult, ['pending', 'dispatched']);
      })();

      expect(await repository.finalizeSessionAction(workerResult, ['dispatched'])).toBe(true);
      teardownBarrier.resolve();
      expect(await teardown).toBe(false);
      expect(await repository.getSessionActionResult(action.id)).toEqual(workerResult);
      expect(await repository.getPendingSessionAction(action.taskId)).toBeUndefined();
      expect(await repository.finalizeSessionAction(workerResult, ['dispatched'])).toBe(false);
      expect(await repository.finalizeSessionAction(teardownResult, ['pending', 'dispatched'])).toBe(false);
      expect(await repository.takePendingSessionAction(action.taskId)).toBeUndefined();
      expect(browserExecutions).toBe(1);
      expect(await repository.enqueueSessionAction({ ...action, id: 'action-worker-wins-next' })).toBe(true);
      expect(await repository.enqueueSessionAction({ ...action, id: 'action-worker-wins-extra' })).toBe(false);
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('preserves teardown cancellation when teardown terminalization wins the worker race', async () => {
    const { repository, close } = await makeHarness();
    try {
      const action = {
        id: 'action-teardown-wins',
        taskId: 'task-teardown-wins',
        action: { type: 'navigate' as const, url: 'https://example.com' },
        state: 'pending' as const,
        createdAt: '2025-01-01T00:00:00.000Z'
      };
      expect(await repository.enqueueSessionAction(action)).toBe(true);
      let browserExecutions = 0;
      if (await repository.takePendingSessionAction(action.taskId) !== undefined) browserExecutions += 1;
      const workerResult = {
        actionId: action.id,
        taskId: action.taskId,
        result: { value: 'worker-result' },
        completedAt: '2025-01-01T00:00:02.000Z'
      };
      const teardownResult = {
        actionId: action.id,
        taskId: action.taskId,
        result: { error: { code: 'session_closed' } },
        completedAt: '2025-01-01T00:00:01.000Z'
      };
      const workerBarrier = deferred();
      const worker = (async () => {
        await workerBarrier.promise;
        return repository.finalizeSessionAction(workerResult, ['dispatched']);
      })();

      expect(await repository.finalizeSessionAction(teardownResult, ['pending', 'dispatched'])).toBe(true);
      workerBarrier.resolve();
      expect(await worker).toBe(false);
      expect(await repository.getSessionActionResult(action.id)).toEqual(teardownResult);
      expect(await repository.getPendingSessionAction(action.taskId)).toBeUndefined();
      expect(await repository.finalizeSessionAction(teardownResult, ['pending', 'dispatched'])).toBe(false);
      expect(await repository.finalizeSessionAction(workerResult, ['dispatched'])).toBe(false);
      expect(await repository.takePendingSessionAction(action.taskId)).toBeUndefined();
      expect(browserExecutions).toBe(1);
      expect(await repository.enqueueSessionAction({ ...action, id: 'action-teardown-wins-next' })).toBe(true);
      expect(await repository.enqueueSessionAction({ ...action, id: 'action-teardown-wins-extra' })).toBe(false);
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);
};

const undefinedLeaseTest = (makeHarness: () => Promise<Harness>): void => {
  it('round-trips explicitly undefined lease fields as undefined', async () => {
    const { repository, close } = await makeHarness();
    try {
      const claimed = baseTask({ status: 'claimed', leaseExpiresAt: '2025-01-01T00:01:00.000Z', leaseToken: 'lease-1', workerId: 'worker-1', machineId: 'machine-1' });
      await repository.saveTask(claimed);
      await repository.saveTask({ ...claimed, status: 'submitted', queuePriority: -1, leaseExpiresAt: undefined, leaseToken: undefined, workerId: undefined, machineId: undefined });
      const requeued = await repository.getTask(claimed.id);
      expect(requeued?.leaseExpiresAt).toBeUndefined();
      expect(requeued?.leaseToken).toBeUndefined();
      expect(requeued?.workerId).toBeUndefined();
      expect(requeued?.machineId).toBeUndefined();
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);
};

const testingRunContractTest = (makeHarness: () => Promise<Harness>): void => {
  it('atomically creates and compare-and-sets a testing run aggregate', async () => {
    const { repository, close } = await makeHarness();
    try {
      await provisionTestingPool(repository, 'pool-1');
      const digest = `sha256:${'a'.repeat(64)}`;
      const reference = (schema: string, ref: string) => ({ schema, ref, digest });
      const observedNow = Date.now();
      const service = new TestingRunService(repository, {
        cursorSecret: 'repository-contract-secret-1234',
        clock: () => observedNow,
        placementPolicy: testTestingPlacementPolicy('pool-1'),
        placementInputVerifier: testTestingPlacementInputVerifier(),
        executionDependencyReadiness: testTestingExecutionDependencyReadiness(),
        externalSchemaAuthority: testTestingExternalSchemaAuthority()
      });
      const policy = {
        network_scope: 'environment_owned_loopback_exact_origins' as const,
        environment_port_handle_policy: { source: 'current_run_owned_handles' as const, allow_unowned_loopback: false as const },
        allowed_actions: ['navigate' as const],
        allowed_evidence_media: ['image/png' as const],
        secret_refs: [],
        budgets: { wall_time_ms: 600_000, max_cases: 20, max_actions: 200, max_events: 2_000, max_screenshots: 20, max_screenshot_bytes: 5_242_880, max_json_evidence_bytes: 1_048_576, max_total_artifact_bytes: 52_428_800 }
      };
      const request = {
        schema_version: 'talos.testing-tool-request/v1' as const,
        request_id: 'request:run-contract',
        client_correlation_id: 'client:run-contract',
        idempotency_key: 'testing-submit-1',
        display_goal: 'Repository contract',
        inputs: {
          schema_version: 'talos.testing-input-references/v1' as const,
          project_pack_snapshot: reference('pql.project-pack-snapshot/v1', 'artifact://pql/project-pack-snapshot/snapshot-1'),
          test_selection: reference('pql.test-selection/v1', 'artifact://pql/test-selection/selection-1'),
          testing_design_input_set: reference('pql.testing-design-input-set.v1', 'artifact://pql/testing-design-input-set/input-1'),
          source_revision: { repository_id: 'repo-1', exact_revision: '0123456789abcdef0123456789abcdef01234567', ref: 'artifact://source/revision-1', digest },
          structured_plan: reference('testing-structured-plan.v2', 'artifact://plans/plan-1'),
          environment_profile: { ref: 'artifact://environments/environment-1', digest },
          testing_package: { package_id: 'testing-browser-runner', version: '1.0', digest }
        },
        execution_profile: 'local_qa_agent_mvp' as const,
        placement_requirements: { testing_runtime: 'local-qa-mvp/v1' as const },
        policy_binding: {
          policy: { schema: 'talos.testing-execution-policy/v1' as const, ref: 'talos://policies/testing/policy-1', digest: digestJson(policy) },
          budgets: { schema: 'talos.testing-budgets/v1' as const, ref: 'talos://policies/testing/budgets-1', digest: digestJson(policy.budgets) }
        },
        policy
      };
      expect((await submitTestingRun(service, 'run-contract', 'user-1', request)).created).toBe(true);
      expect((await submitTestingRun(service, 'run-contract', 'user-1', request)).created).toBe(false);
      const run = await repository.getTestingRun('run-contract');
      expect(run).toMatchObject({ recordVersion: 1, snapshotVersion: 1, controlStatus: 'submitted' });
      expect(await repository.getTestingRunByIdempotencyKey('user-1', 'testing-submit-1')).toMatchObject({ id: 'run-contract' });
      if (run === undefined) throw new Error('testing run missing');
      expect(await repository.replaceTestingRun({ ...run, recordVersion: 2 }, 1)).toBe(true);
      expect(await repository.replaceTestingRun({ ...run, recordVersion: 3 }, 1)).toBe(false);

      const leaseExpiresAt = new Date(observedNow + 120_000).toISOString();
      const authorizationExpiresAt = new Date(observedNow + 60_000).toISOString();
      const attempt = {
        id: 'attempt-contract',
        claimId: 'claim-contract',
        operation: 'start' as const,
        taskPayloadDigest: digest,
        generation: 1,
        status: 'claimed' as const,
        machineId: 'machine-contract',
        workerId: 'worker-contract',
        leaseId: 'lease-contract',
        leaseTokenHash: 'b'.repeat(64),
        fenceToken: 'fence-contract',
        admissionNonce: 'admission-contract',
        priorClaims: [],
        leaseClaim: {
          schema: 'talos.testing-lease-claim/v1' as const,
          ref: 'talos://testing/claims/run-contract/claim-contract',
          digest,
          expires_at: run.deadlineAt
        },
        authorization: {
          ref: 'authorization://testing/attempt-contract',
          digest,
          expires_at: authorizationExpiresAt
        },
        leaseExpiresAt,
        issuedAt: new Date(observedNow).toISOString(),
        deadline: run.deadlineAt,
        createdAt: new Date(observedNow).toISOString(),
        updatedAt: new Date(observedNow).toISOString()
      };
      const attempted = {
        ...run,
        recordVersion: 3,
        controlStatus: 'claimed' as const,
        task: { ...run.task, status: 'claimed' as const },
        attempts: [attempt],
        currentAttemptId: attempt.id,
        attempt: {
          attempt_id: attempt.id,
          task_id: run.task.id,
          generation: attempt.generation,
          machine_id: attempt.machineId,
          worker_id: attempt.workerId,
          runtime: {
            capability: 'local-qa-mvp/v1' as const,
            locally_accepted_at: null,
            event_sequence: null
          }
        }
      };
      expect(await repository.replaceTestingRun(attempted, 2)).toBe(true);
      const guard = {
        attemptId: attempt.id,
        operation: attempt.operation,
        generation: attempt.generation,
        fenceToken: attempt.fenceToken,
        leaseId: attempt.leaseId,
        leaseExpiresAt: attempt.leaseExpiresAt
      };
      const heartbeat = { ...attempted, recordVersion: 4 };
      expect(await repository.replaceTestingRunForAttempt(heartbeat, 3, 'run', guard, observedNow)).toBe(true);
      expect(await repository.replaceTestingRunForAttempt(
        { ...heartbeat, recordVersion: 5 },
        4,
        'run',
        { ...guard, fenceToken: 'stale-fence' },
        observedNow
      )).toBe(false);

      const invalidLeaseAttempt = { ...attempt, leaseExpiresAt: 'invalid-lease-expiry' };
      const invalidLeaseRun = { ...heartbeat, recordVersion: 5, attempts: [invalidLeaseAttempt] };
      expect(await repository.replaceTestingRun(invalidLeaseRun, 4)).toBe(true);
      expect(await repository.replaceTestingRunForAttempt(
        { ...invalidLeaseRun, recordVersion: 6 },
        5,
        'run',
        { ...guard, leaseExpiresAt: invalidLeaseAttempt.leaseExpiresAt },
        observedNow
      )).toBe(false);

      const reservedAttempt = { ...attempt, status: 'reserved' as const, authorization: undefined };
      const dispatchSource = { ...invalidLeaseRun, recordVersion: 6, attempts: [reservedAttempt] };
      expect(await repository.replaceTestingRun(dispatchSource, 5)).toBe(true);
      const dispatchedAttempt = { ...attempt, status: 'claimed' as const };
      const dispatched = { ...dispatchSource, recordVersion: 7, attempts: [dispatchedAttempt] };
      const dispatchGuard = {
        ...guard,
        status: reservedAttempt.status,
        dispatchLeaseExpiresAt: dispatchedAttempt.leaseExpiresAt,
        dispatchAuthorizationExpiresAt: authorizationExpiresAt
      };
      expect(await repository.replaceTestingRunForDispatch(
        dispatched,
        6,
        'run',
        dispatchGuard,
        observedNow
      )).toBe(true);
      expect(await repository.replaceTestingRunForDispatch(
        { ...dispatched, recordVersion: 8 },
        7,
        'run',
        {
          ...guard,
          status: dispatchedAttempt.status,
          dispatchLeaseExpiresAt: dispatchedAttempt.leaseExpiresAt,
          dispatchAuthorizationExpiresAt: 'invalid-authorization-expiry'
        },
        observedNow
      )).toBe(false);

      const invalidDeadline = { ...dispatched, recordVersion: 8, deadlineAt: 'invalid-run-deadline' };
      expect(await repository.replaceTestingRun(invalidDeadline, 7)).toBe(true);
      expect(await repository.replaceTestingRunWithinDeadline(
        { ...invalidDeadline, recordVersion: 9 },
        8,
        'run',
        observedNow
      )).toBe(false);
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);
};

describe('Repository contract: memory', () => {
  contractTests(memoryHarness);
  undefinedLeaseTest(memoryHarness);
  testingRunContractTest(memoryHarness);
});
describe('Repository contract: mongo', () => {
  contractTests(mongoHarness);
  undefinedLeaseTest(mongoHarness);
  testingRunContractTest(mongoHarness);
});
