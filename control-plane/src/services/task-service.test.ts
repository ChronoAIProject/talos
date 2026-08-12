import { describe, expect, it } from 'vitest';
import { hashWorkerToken } from '../config.js';
import { MemoryRepository } from '../storage/memory-repository.js';
import { ProfileLockService } from './profile-lock.js';
import { Scheduler } from './scheduler.js';
import { TaskService } from './task-service.js';
import { WebhookSigner } from './webhook-signer.js';

const setup = (clock: { value: number } = { value: Date.now() }) => {
  const repository = new MemoryRepository();
  const profiles = new ProfileLockService(repository);
  const scheduler = new Scheduler(repository);
  const service = new TaskService(repository, scheduler, profiles, new WebhookSigner('test-webhook-secret'), { clock: () => clock.value, leaseSeconds: 10 });
  return { repository, profiles, service, clock };
};

describe('task service', () => {
  it('runs submit, claim, heartbeat, result and preserves identity', async () => {
    const { repository, service } = setup();
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'machine', poolId: 'pool', tags: { os: 'macos', browser: true }, capacity: 1, activeLeases: 0, online: true, workerTokenHash: hashWorkerToken('worker-token-123456') });
    const task = await service.createTask('user-a', { kind: 'browse', goal: 'find flights' });
    const claim = await service.claim('worker-a', 'machine');
    expect(claim.task.id).toBe(task.id);
    expect((await service.heartbeat(task.id, 'worker-a', claim.leaseToken, 30)).status).toBe('running');
    const completed = await service.complete(task.id, 'worker-a', claim.leaseToken, 'completed', [{ key: 'count', value: 2 }]);
    expect(completed.status).toBe('completed');
    await expect(service.getTask(task.id, 'user-b')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('requeues expired leases and releases machine capacity', async () => {
    const { repository, service, clock } = setup({ value: 1000 });
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'machine', poolId: 'pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: hashWorkerToken('worker-token-123456') });
    const first = await service.createTask('user-a', { kind: 'browse', goal: 'first' });
    await service.createTask('user-a', { kind: 'browse', goal: 'second' });
    await service.claim('worker-a', 'machine', 1000);
    clock.value = 12000;
    const expired = await service.expireLeases();
    expect(expired).toHaveLength(1);
    expect((await repository.getTask(first.id))?.status).toBe('submitted');
    expect((await repository.getMachine('machine'))?.activeLeases).toBe(0);
  });

  it('enforces profile ownership and one concurrent lock', async () => {
    const { repository, service } = setup();
    await repository.saveProfile({ id: 'profile', userId: 'user-a' });
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'machine', poolId: 'pool', tags: {}, capacity: 2, activeLeases: 0, online: true, workerTokenHash: hashWorkerToken('worker-token-123456') });
    await expect(service.createTask('user-b', { kind: 'browse', goal: 'x', profile_id: 'profile' })).rejects.toMatchObject({ code: 'forbidden' });
    await service.createTask('user-a', { kind: 'browse', goal: 'x', profile_id: 'profile' });
    await service.createTask('user-a', { kind: 'browse', goal: 'y', profile_id: 'profile' });
    await service.claim('worker-a', 'machine');
    await expect(service.claim('worker-a', 'machine')).rejects.toMatchObject({ code: 'not_found' });
  });
});
