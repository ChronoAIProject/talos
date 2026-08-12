import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import type { Repository } from './repository.js';
import { MemoryRepository } from './memory-repository.js';
import { PostgresRepository } from './postgres-repository.js';
import type { Task, WebhookEvent } from '../domain/types.js';

interface Harness {
  repository: Repository;
  close: () => Promise<void>;
}

const memoryHarness = async (): Promise<Harness> => {
  const repository = new MemoryRepository();
  return { repository, close: () => repository.close() };
};

const postgresHarness = async (): Promise<Harness> => {
  const database = newDb();
  const Pool = database.adapters.createPg().Pool;
  const pool = new Pool();
  const repository = new PostgresRepository({ pool });
  const schema = await readFile(new URL('../../sql/schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
  return { repository, close: () => repository.close() };
};

const cases: Array<[string, () => Promise<Harness>]> = [
  ['memory', memoryHarness],
  ['postgres', postgresHarness]
];

const baseTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  userId: 'user-1',
  kind: 'browse',
  goal: 'check status',
  constraints: {},
  mode: 'read_only',
  status: 'submitted',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  findings: [],
  artifacts: [],
  ...overrides
});

describe.each(cases)('Repository contract: %s', (_name, makeHarness) => {
  it('round-trips registry entities and task state', async () => {
    const { repository, close } = await makeHarness();
    try {
      await repository.savePool({ id: 'pool-1', visibility: 'private', ownerUserId: 'user-1', tags: { os: 'linux' } });
      await repository.saveMachine({ id: 'machine-1', poolId: 'pool-1', tags: { browser: true }, capacity: 2, activeLeases: 0, online: true, workerTokenHash: 'hash' });
      await repository.saveProfile({ id: 'profile-1', userId: 'user-1', machineId: 'machine-1' });
      const task = baseTask({ profileId: 'profile-1', poolId: 'pool-1' });
      await repository.saveTask(task);
      await repository.saveHandoff({ id: 'handoff-1', taskId: task.id, userId: task.userId, url: '/v1/handoffs/handoff-1', expiresAt: '2025-01-01T00:10:00.000Z', used: false });
      const event: WebhookEvent = { id: 'event-1', type: 'task.state_changed', taskId: task.id, userId: task.userId, timestamp: task.createdAt, payload: { status: 'submitted' }, delivery: { status: 'pending', attempts: 0 } };
      await repository.saveWebhook(event);
      await repository.savePendingInput(task.id, { kind: 'text', value: 'secret' });

      expect(await repository.getPool('pool-1')).toMatchObject({ id: 'pool-1', ownerUserId: 'user-1' });
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

  it('keeps queued ordering and updates existing immutable records', async () => {
    const { repository, close } = await makeHarness();
    try {
      await repository.saveTask(baseTask({ id: 'late', createdAt: '2025-01-01T00:02:00.000Z', queuePriority: -1 }));
      await repository.saveTask(baseTask({ id: 'early', createdAt: '2025-01-01T00:01:00.000Z', queuePriority: -1 }));
      expect((await repository.listQueuedTasks()).map((task) => task.id)).toEqual(['early', 'late']);
      await repository.saveTask(baseTask({ id: 'early', status: 'running', updatedAt: '2025-01-01T00:03:00.000Z' }));
      expect((await repository.listQueuedTasks()).map((task) => task.id)).toEqual(['late']);
    } finally {
      await close();
    }
  });
});
