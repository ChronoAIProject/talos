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

  it('keeps a profile lock renewed and resumes late input without requeue', async () => {
    const { repository, service, clock } = setup({ value: 1000 });
    await repository.saveProfile({ id: 'profile', userId: 'user-a' });
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'machine', poolId: 'pool', tags: {}, capacity: 2, activeLeases: 0, online: true, workerTokenHash: hashWorkerToken('worker-token-123456') });
    const task = await service.createTask('user-a', { kind: 'browse', goal: 'input', profile_id: 'profile' });
    const claim = await service.claim('worker-a', 'machine');
    await service.needsInput(task.id, 'worker-a', claim.leaseToken);
    clock.value = 9000;
    await service.heartbeat(task.id, 'worker-a', claim.leaseToken, 10);
    clock.value = 20000;
    await expect(service.claim('worker-a', 'machine')).rejects.toMatchObject({ code: 'not_found' });
    await service.provideInput(task.id, 'user-a', { kind: 'otp', value: '123456' });
    expect((await service.getWorkerInput(task.id, 'worker-a', claim.leaseToken))?.value).toBe('123456');
  });

  it('signals cancellation and fails queued deadline tasks', async () => {
    const { repository, service, clock } = setup({ value: 1000 });
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'machine', poolId: 'pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: hashWorkerToken('worker-token-123456') });
    const active = await service.createTask('user-a', { kind: 'browse', goal: 'cancel' });
    const claim = await service.claim('worker-a', 'machine');
    await service.cancel(active.id, 'user-a');
    await expect(service.heartbeat(active.id, 'worker-a', claim.leaseToken, 10)).rejects.toMatchObject({ code: 'task_cancelled' });
    const deadline = await service.createTask('user-a', { kind: 'browse', goal: 'late', constraints: { deadline: new Date(2000).toISOString() } });
    clock.value = 3000;
    await service.expireLeases();
    expect((await repository.getTask(deadline.id))?.error?.code).toBe('deadline_exceeded');
  });

  it('keeps FIFO ordering among multiple expired tasks', async () => {
    const { repository, service, clock } = setup({ value: 1000 });
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'machine', poolId: 'pool', tags: {}, capacity: 2, activeLeases: 0, online: true, workerTokenHash: hashWorkerToken('worker-token-123456') });
    const first = await service.createTask('user-a', { kind: 'browse', goal: 'first' });
    clock.value = 2000;
    const second = await service.createTask('user-a', { kind: 'browse', goal: 'second' });
    const claim1 = await service.claim('w1', 'machine', 2000);
    const claim2 = await service.claim('w2', 'machine', 2000);
    clock.value = 20000;
    await service.expireLeases();
    const next = await service.claim('w3', 'machine', 20000);
    expect(next.task.id).toBe(first.id);
    expect(second.id).not.toBe(first.id);
    void claim1; void claim2;
  });
});
