import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Repository } from './repository.js';
import { MemoryRepository } from './memory-repository.js';
import { MongoRepository } from './mongo-repository.js';
import type { Task, WebhookEvent } from '../domain/types.js';

interface Harness {
  repository: Repository;
  close: () => Promise<void>;
}

const baseTask = (overrides: Partial<Task> = {}): Task => ({
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

describe('Repository contract: memory', () => {
  contractTests(memoryHarness);
  undefinedLeaseTest(memoryHarness);
});
describe('Repository contract: mongo', () => {
  contractTests(mongoHarness, true);
  undefinedLeaseTest(mongoHarness, true);
});

it('reports when Mongo contract execution is unavailable', () => {
  if (mongoUrl === undefined) expect(mongoUnavailable).toBeTypeOf('string');
});
