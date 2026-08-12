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

  it('redacts private input and scheduling fields from public tasks', async () => {
    const { repository, service } = setup();
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'machine', poolId: 'pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'x' });
    const task = await service.createTask('user-a', { kind: 'browse', goal: 'otp' });
    const claim = await service.claim('worker-a', 'machine');
    await service.needsInput(task.id, 'worker-a', claim.leaseToken);
    await service.provideInput(task.id, 'user-a', { kind: 'otp', value: 'secret-123' });
    const publicTask = service.toPublicTask((await repository.getTask(task.id))!);
    expect(publicTask).not.toHaveProperty('input');
    expect(publicTask).not.toHaveProperty('leaseToken');
    expect(publicTask).not.toHaveProperty('workerId');
    expect(publicTask).not.toHaveProperty('machineId');
    expect(publicTask).not.toHaveProperty('leaseExpiresAt');
    expect(publicTask).not.toHaveProperty('queuePriority');
  });

  it('uses a unique artifact id and injected clock', async () => {
    const { repository, service, clock } = setup({ value: 5000 });
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'machine', poolId: 'pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'x' });
    const task = await service.createTask('user-a', { kind: 'browse', goal: 'artifact' });
    const claim = await service.claim('worker-a', 'machine');
    await service.addArtifact(task.id, 'worker-a', claim.leaseToken, { id: 'artifact_a', name: 'a', contentType: 'text/plain', size: 1, uri: 'https://example.invalid/a', createdAt: new Date(clock.value).toISOString() });
    const saved = await repository.getTask(task.id);
    expect(saved?.artifacts[0]?.id).toBe('artifact_a');
    expect(saved?.artifacts[0]?.createdAt).toBe(new Date(clock.value).toISOString());
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
    await service.createTask('user-a', { kind: 'browse', goal: 'competitor', profile_id: 'profile' });
    const claim = await service.claim('worker-a', 'machine');
    await service.needsInput(task.id, 'worker-a', claim.leaseToken);
    clock.value = 9000;
    await service.heartbeat(task.id, 'worker-a', claim.leaseToken, 10);
    clock.value = 18000;
    await service.heartbeat(task.id, 'worker-a', claim.leaseToken, 10);
    clock.value = 20000;
    await expect(service.claim('worker-a', 'machine')).rejects.toMatchObject({ code: 'not_found' });
    await service.provideInput(task.id, 'user-a', { kind: 'otp', value: '123456' });
    expect((await service.getWorkerInput(task.id, 'worker-a', claim.leaseToken))?.value).toBe('123456');
  });

  it('lets either eligible machine claim queued work', async () => {
    const { repository, service } = setup();
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'first', poolId: 'pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'x' });
    await repository.saveMachine({ id: 'second', poolId: 'pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'x' });
    const task = await service.createTask('user-a', { kind: 'browse', goal: 'second may claim' });
    expect((await service.claim('worker-b', 'second')).task.id).toBe(task.id);
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
