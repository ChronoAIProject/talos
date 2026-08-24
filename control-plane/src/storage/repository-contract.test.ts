import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Repository } from './repository.js';
import { MemoryRepository } from './memory-repository.js';
import { MongoRepository } from './mongo-repository.js';
import type { BrowserTask, WebhookEvent } from '../domain/types.js';
import { TestingRunService } from '../services/testing-run-service.js';
import { digestJson } from '@talos/testing-protocol';

interface Harness {
  repository: Repository;
  close: () => Promise<void>;
}

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
let mongoUnavailable: string | undefined;

beforeAll(async () => {
  mongoUrl = process.env.TALOS_TEST_MONGODB_URL;
  if (mongoUrl === undefined) {
    try {
      mongoServer = await MongoMemoryServer.create();
      mongoUrl = mongoServer.getUri();
    } catch (error) {
      mongoUnavailable = error instanceof Error ? error.message : 'mongodb-memory-server unavailable';
    }
  }
});

afterAll(async () => {
  await mongoServer?.stop();
});

const mongoHarness = async (): Promise<Harness> => {
  if (mongoUrl === undefined) throw new Error(`Mongo contract unavailable: ${mongoUnavailable ?? 'set TALOS_TEST_MONGODB_URL to run against MongoDB'}`);
  const client = new MongoClient(mongoUrl);
  await client.connect();
  const repository = new MongoRepository(mongoUrl, `talos_test_${Date.now()}_${Math.random().toString(16).slice(2)}`, { client });
  await repository.initialize();
  return { repository, close: () => repository.close() };
};

const contractTests = (makeHarness: () => Promise<Harness>, allowUnavailable = false): void => {
  it('round-trips registry entities and task state', async () => {
    if (allowUnavailable && mongoUrl === undefined) {
      expect(mongoUnavailable).toBeTypeOf('string');
      return;
    }
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
  });

  it('keeps requeued tasks ahead of fresh tasks and updates records', async () => {
    if (allowUnavailable && mongoUrl === undefined) {
      expect(mongoUnavailable).toBeTypeOf('string');
      return;
    }
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
  });

  it('atomically relays one interactive action and correlates its result', async () => {
    if (allowUnavailable && mongoUrl === undefined) {
      expect(mongoUnavailable).toBeTypeOf('string');
      return;
    }
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
      await repository.saveSessionActionResult({ actionId: action.id, taskId: action.taskId, result: { value: 'ok' }, completedAt: '2025-01-01T00:00:01.000Z' });
      expect(await repository.getSessionActionResult(action.id)).toMatchObject({ taskId: action.taskId, result: { value: 'ok' } });
      await repository.completeSessionAction(action.taskId, action.id);
      expect(await repository.getPendingSessionAction(action.taskId)).toBeUndefined();
      const pending = { ...action, id: 'action-cancel', state: 'pending' as const };
      expect(await repository.enqueueSessionAction(pending)).toBe(true);
      expect(await repository.cancelPendingSessionAction(pending.taskId, pending.id)).toBe(true);
      expect(await repository.cancelPendingSessionAction(pending.taskId, pending.id)).toBe(false);
    } finally {
      await close();
    }
  });
};

const undefinedLeaseTest = (makeHarness: () => Promise<Harness>, allowUnavailable = false): void => {
  it('round-trips explicitly undefined lease fields as undefined', async () => {
    if (allowUnavailable && mongoUrl === undefined) {
      expect(mongoUnavailable).toBeTypeOf('string');
      return;
    }
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
  });
};

const testingRunContractTest = (makeHarness: () => Promise<Harness>, allowUnavailable = false): void => {
  it('atomically creates and compare-and-sets a testing run aggregate', async () => {
    if (allowUnavailable && mongoUrl === undefined) {
      expect(mongoUnavailable).toBeTypeOf('string');
      return;
    }
    const { repository, close } = await makeHarness();
    try {
      const digest = `sha256:${'a'.repeat(64)}`;
      const reference = (schema: string, ref: string) => ({ schema, ref, digest });
      const service = new TestingRunService(repository, {
        cursorSecret: 'repository-contract-secret-1234',
        clock: () => Date.parse('2026-08-22T00:00:00.000Z')
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
      expect((await service.submit('run-contract', 'user-1', request)).created).toBe(true);
      expect((await service.submit('run-contract', 'user-1', request)).created).toBe(false);
      const run = await repository.getTestingRun('run-contract');
      expect(run).toMatchObject({ recordVersion: 1, snapshotVersion: 1, controlStatus: 'submitted' });
      expect(await repository.getTestingRunByIdempotencyKey('user-1', 'testing-submit-1')).toMatchObject({ id: 'run-contract' });
      if (run === undefined) throw new Error('testing run missing');
      expect(await repository.replaceTestingRun({ ...run, recordVersion: 2 }, 1)).toBe(true);
      expect(await repository.replaceTestingRun({ ...run, recordVersion: 3 }, 1)).toBe(false);
    } finally {
      await close();
    }
  });
};

describe('Repository contract: memory', () => {
  contractTests(memoryHarness);
  undefinedLeaseTest(memoryHarness);
  testingRunContractTest(memoryHarness);
});
describe('Repository contract: mongo', () => {
  contractTests(mongoHarness, true);
  undefinedLeaseTest(mongoHarness, true);
  testingRunContractTest(mongoHarness, true);
});

it('reports when Mongo contract execution is unavailable', () => {
  if (mongoUrl === undefined) expect(mongoUnavailable).toBeTypeOf('string');
});
