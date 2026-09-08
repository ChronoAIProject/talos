import { describe, expect, it } from 'vitest';
import { hashWorkerToken } from '../config.js';
import { MemoryRepository } from '../storage/memory-repository.js';
import { ProfileLockService } from './profile-lock.js';
import { Scheduler } from './scheduler.js';
import { TaskService } from './task-service.js';
import { WebhookSigner } from './webhook-signer.js';
import type { Task } from '../domain/types.js';
import type { Repository } from '../storage/repository.js';
import { computeTestingTaskPayloadDigest, testingTaskSchema } from '@talos/testing-protocol';

const setup = (clock: { value: number } = { value: Date.now() }) => {
  const repository = new MemoryRepository(() => clock.value);
  const profiles = new ProfileLockService(repository);
  const scheduler = new Scheduler(repository);
  const service = new TaskService(repository, scheduler, profiles, new WebhookSigner('test-webhook-secret'), { clock: () => clock.value, leaseSeconds: 10 });
  return { repository, profiles, service, clock };
};

const advanceClaimGeneration = async (
  repository: Repository,
  taskId: string,
  status: 'running' | 'needs_input'
): Promise<Task> => {
  const current = await repository.getTask(taskId);
  if (
    current === undefined ||
    current.claimId === undefined ||
    current.claimGeneration === undefined
  ) throw new Error('test task does not have an active claim');
  const requeued = {
    ...current,
    status: 'submitted' as const,
    workerId: undefined,
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    claimCommitted: false,
    claimReleased: true,
    queuePriority: current.claimQueuePriority,
    claimQueuePriority: undefined
  };
  if (!await repository.replaceTaskForClaim(requeued, {
    claimId: current.claimId,
    claimGeneration: current.claimGeneration,
    taskVersion: current.taskVersion ?? 0,
    status: current.status
  })) throw new Error('test could not requeue the current claim');
  const submitted = await repository.getTask(taskId);
  if (submitted === undefined) throw new Error('test task disappeared while requeueing');
  const nextGeneration = current.claimGeneration + 1;
  const reclaimed = await repository.claimTask({
    ...submitted,
    status: 'claimed',
    workerId: 'worker-next',
    machineId: current.machineId ?? 'machine',
    leaseToken: 'lease-next',
    leaseExpiresAt: '2100-01-01T00:00:00.000Z',
    claimId: 'claim-next',
    claimGeneration: nextGeneration,
    taskVersion: (submitted.taskVersion ?? 0) + 1,
    claimCommitted: true,
    claimReleased: false,
    claimQueuePriority: submitted.queuePriority,
    queuePriority: undefined
  }, current.claimGeneration, submitted.taskVersion ?? 0);
  if (reclaimed === undefined) throw new Error('test could not claim the next generation');
  if (!await repository.replaceTaskForClaim({ ...reclaimed, status }, {
    claimId: reclaimed.claimId!,
    claimGeneration: reclaimed.claimGeneration!,
    taskVersion: reclaimed.taskVersion ?? 0,
    status: reclaimed.status
  })) throw new Error('test could not advance the next generation status');
  const persisted = await repository.getTask(taskId);
  if (persisted === undefined) throw new Error('test task disappeared after reclaim');
  return persisted;
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

  it('rejects heartbeat when its claim CAS resumes after lease expiry', async () => {
    const clock = { value: 1_000 };
    const storage = new MemoryRepository(() => clock.value);
    let reachClaimCas!: () => void;
    let resumeClaimCas!: () => void;
    const claimCasReached = new Promise<void>((resolve) => { reachClaimCas = resolve; });
    const claimCasResume = new Promise<void>((resolve) => { resumeClaimCas = resolve; });
    const repository = new Proxy<Repository>(storage, {
      get(target, property) {
        if (property === 'replaceTaskForActiveClaim') {
          return async (task: Parameters<Repository['replaceTaskForActiveClaim']>[0], guard: Parameters<Repository['replaceTaskForActiveClaim']>[1]) => {
            reachClaimCas();
            await claimCasResume;
            return target.replaceTaskForActiveClaim(task, guard);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const service = new TaskService(
      repository,
      new Scheduler(repository),
      new ProfileLockService(repository),
      new WebhookSigner('test-webhook-secret'),
      { clock: () => clock.value, leaseSeconds: 10 }
    );
    await repository.savePool({ id: 'expiry-pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'expiry-machine', poolId: 'expiry-pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'x' });
    const task = await service.createTask('user-a', { kind: 'browse', goal: 'expiry race' });
    const claim = await service.claim('worker-a', 'expiry-machine');

    const heartbeat = service.heartbeat(task.id, 'worker-a', claim.leaseToken, 30);
    await claimCasReached;
    clock.value = Date.parse(claim.task.leaseExpiresAt!);
    resumeClaimCas();

    await expect(heartbeat).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await repository.getTask(task.id)).toMatchObject({
      status: 'claimed',
      leaseExpiresAt: claim.task.leaseExpiresAt,
      taskVersion: claim.task.taskVersion
    });
  });

  it('does not take over a stale profile projection while its task renewal is authoritative', async () => {
    const clock = { value: 1_000 };
    const storage = new MemoryRepository(() => clock.value);
    let renewalCommitted!: () => void;
    let resumeHeartbeat!: () => void;
    const renewalCommit = new Promise<void>((resolve) => { renewalCommitted = resolve; });
    const heartbeatResume = new Promise<void>((resolve) => { resumeHeartbeat = resolve; });
    const repository = new Proxy<Repository>(storage, {
      get(target, property) {
        if (property === 'replaceTaskForActiveClaim') {
          return async (task: Parameters<Repository['replaceTaskForActiveClaim']>[0], guard: Parameters<Repository['replaceTaskForActiveClaim']>[1]) => {
            const replaced = await target.replaceTaskForActiveClaim(task, guard);
            renewalCommitted();
            await heartbeatResume;
            return replaced;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const service = new TaskService(
      repository,
      new Scheduler(repository),
      new ProfileLockService(repository),
      new WebhookSigner('test-webhook-secret'),
      { clock: () => clock.value, leaseSeconds: 10 }
    );
    await repository.createProfile({ id: 'renewal-profile', userId: 'user-a' });
    await repository.savePool({ id: 'renewal-pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'renewal-machine', poolId: 'renewal-pool', tags: {}, capacity: 2, activeLeases: 0, online: true, workerTokenHash: 'x' });
    const first = await service.createTask('user-a', { kind: 'browse', goal: 'first', profile_id: 'renewal-profile' });
    await service.createTask('user-a', { kind: 'browse', goal: 'second', profile_id: 'renewal-profile' });
    const claim = await service.claim('worker-a', 'renewal-machine');

    const heartbeat = service.heartbeat(first.id, 'worker-a', claim.leaseToken, 30);
    await renewalCommit;
    clock.value = Date.parse(claim.task.leaseExpiresAt!);
    try {
      await expect(service.claim('worker-b', 'renewal-machine')).rejects.toMatchObject({ code: 'not_found' });
    } finally {
      resumeHeartbeat();
    }
    await expect(heartbeat).resolves.toMatchObject({ status: 'running' });
    expect(await repository.getProfile('renewal-profile')).toMatchObject({
      lockedByTaskId: first.id,
      lockedByClaimId: claim.task.claimId
    });
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
    expect(publicTask).not.toHaveProperty('claimId');
    expect(publicTask).not.toHaveProperty('claimGeneration');
    expect(publicTask).not.toHaveProperty('workerId');
    expect(publicTask).not.toHaveProperty('machineId');
    expect(publicTask).not.toHaveProperty('leaseExpiresAt');
    expect(publicTask).not.toHaveProperty('queuePriority');
    const publicInteractiveTask = service.toPublicTask({
      ...(await repository.getTask(task.id))!,
      pendingActionId: 'pending-action-secret',
      lastActionId: 'last-action-secret',
      claimRecovery: {
        schemaVersion: 'talos.task-claim-recovery/v1',
        recoveryId: 'recovery-secret',
        kind: 'malformed',
        phase: 'quarantined',
        sourceStatus: 'running',
        sourceMachineId: 'machine-secret',
        restoredQueuePriority: 0,
        reasonCode: 'partial_claim_identity',
        startedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z'
      }
    });
    expect(publicInteractiveTask).not.toHaveProperty('pendingActionId');
    expect(publicInteractiveTask).not.toHaveProperty('lastActionId');
    expect(publicInteractiveTask).not.toHaveProperty('claimRecovery');
  });

  it('never includes internal claim authority in webhook payloads', async () => {
    const { repository, service } = setup();
    await repository.savePool({ id: 'webhook-pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({
      id: 'webhook-machine',
      poolId: 'webhook-pool',
      tags: {},
      capacity: 1,
      activeLeases: 0,
      online: true,
      workerTokenHash: 'hash'
    });
    const task = await service.createTask('user-a', { kind: 'browse', goal: 'webhook disclosure' });
    const claim = await service.claim('webhook-worker', 'webhook-machine');
    await service.complete(task.id, 'webhook-worker', claim.leaseToken, 'completed', []);

    const serialized = JSON.stringify(await repository.listWebhooks());
    const stored = await repository.getTask(task.id);
    for (const field of [
      'claimId',
      'claimGeneration',
      'taskVersion',
      'claimCommitted',
      'claimReleased',
      'claimQueuePriority',
      'queuePriority',
      'workerId',
      'machineId',
      'leaseExpiresAt',
      'leaseToken',
      'claimRecovery'
    ]) expect(serialized).not.toContain(`\"${field}\"`);
    expect(serialized).not.toContain(claim.leaseToken);
    expect(serialized).not.toContain(stored?.claimId);
  });

  it('logs a stable code when webhook delivery rejects with internal authority', async () => {
    const repository = new MemoryRepository();
    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const service = new TaskService(
      repository,
      new Scheduler(repository),
      new ProfileLockService(repository),
      new WebhookSigner('test-webhook-secret'),
      {
        onWebhook: async () => { throw new Error('claim-secret-sentinel lease-token-sentinel'); },
        logger: { warn: (message, fields) => warnings.push({ message, fields }) }
      }
    );

    await service.createTask('user-a', {
      kind: 'browse',
      goal: 'webhook failure disclosure',
      callback: 'https://example.invalid/webhook'
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(warnings).toContainEqual({
      message: 'webhook delivery failed',
      fields: expect.objectContaining({ error: 'webhook_delivery_failed' })
    });
    const serialized = JSON.stringify(warnings);
    expect(serialized).not.toContain('claim-secret-sentinel');
    expect(serialized).not.toContain('lease-token-sentinel');
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
    await repository.createProfile({ id: 'profile', userId: 'user-a' });
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'machine', poolId: 'pool', tags: {}, capacity: 2, activeLeases: 0, online: true, workerTokenHash: hashWorkerToken('worker-token-123456') });
    await expect(service.createTask('user-b', { kind: 'browse', goal: 'x', profile_id: 'profile' })).rejects.toMatchObject({ code: 'forbidden' });
    await service.createTask('user-a', { kind: 'browse', goal: 'x', profile_id: 'profile' });
    await service.createTask('user-a', { kind: 'browse', goal: 'y', profile_id: 'profile' });
    await service.claim('worker-a', 'machine');
    await expect(service.claim('worker-a', 'machine')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects a pool target that conflicts with the profile pinned machine', async () => {
    const { repository, service } = setup();
    await repository.savePool({ id: 'local', visibility: 'private', ownerUserId: 'user-a', tags: {} });
    await repository.savePool({ id: 'remote', visibility: 'platform', tags: {} });
    await repository.saveMachine({
      id: 'remote-machine',
      poolId: 'remote',
      tags: {},
      capacity: 1,
      activeLeases: 0,
      online: true,
      workerTokenHash: 'x'
    });
    await repository.createProfile({ id: 'profile', userId: 'user-a', machineId: 'remote-machine' });

    await expect(service.createTask('user-a', {
      kind: 'browse',
      goal: 'impossible target',
      profile_id: 'profile',
      pool_id: 'local'
    })).rejects.toMatchObject({
      code: 'conflict',
      message: 'profile pinned machine belongs to a different pool'
    });
  });

  it('keeps a profile lock renewed and resumes late input without requeue', async () => {
    const { repository, service, clock } = setup({ value: 1000 });
    await repository.createProfile({ id: 'profile', userId: 'user-a' });
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

  it('returns a retryable conflict after three cancellation CAS misses without side effects', async () => {
    const clock = { value: 1_000 };
    const storage = new MemoryRepository(() => clock.value);
    const authority = new TaskService(
      storage,
      new Scheduler(storage),
      new ProfileLockService(storage),
      new WebhookSigner('test-webhook-secret'),
      { clock: () => clock.value, leaseSeconds: 10 }
    );
    await storage.savePool({ id: 'cancel-pool', visibility: 'platform', tags: {} });
    await storage.saveMachine({ id: 'cancel-machine', poolId: 'cancel-pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'hash' });
    const task = await authority.createTask('user-a', { kind: 'browse', goal: 'cancel CAS exhaustion' });
    await authority.claim('worker-a', 'cancel-machine');
    let attempts = 0;
    let releases = 0;
    const repository = new Proxy<Repository>(storage, {
      get(target, property) {
        if (property === 'replaceTaskForClaim') {
          return async (...args: Parameters<Repository['replaceTaskForClaim']>): Promise<boolean> => {
            if (args[0].status === 'cancelled' && args[0].claimReleased !== true) {
              attempts += 1;
              return false;
            }
            return target.replaceTaskForClaim(...args);
          };
        }
        if (property === 'releaseMachineLease') {
          return async (...args: Parameters<Repository['releaseMachineLease']>): Promise<boolean> => {
            releases += 1;
            return target.releaseMachineLease(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const service = new TaskService(
      repository,
      new Scheduler(repository),
      new ProfileLockService(repository),
      new WebhookSigner('test-webhook-secret'),
      { clock: () => clock.value, leaseSeconds: 10 }
    );

    await expect(service.cancel(task.id, task.userId)).rejects.toMatchObject({
      code: 'concurrent_update',
      status: 409
    });
    expect(attempts).toBe(3);
    expect(releases).toBe(0);
    expect((await storage.getTask(task.id))?.status).toBe('claimed');
    expect((await storage.listWebhooks()).filter((event) => event.payload.status === 'cancelled')).toHaveLength(0);
  });

  it('does not persist input or handoff side effects when their CAS retries are exhausted', async () => {
    const clock = { value: 1_000 };
    const storage = new MemoryRepository(() => clock.value);
    const authority = new TaskService(
      storage,
      new Scheduler(storage),
      new ProfileLockService(storage),
      new WebhookSigner('test-webhook-secret'),
      { clock: () => clock.value, leaseSeconds: 10 }
    );
    await storage.savePool({ id: 'side-effect-pool', visibility: 'platform', tags: {} });
    await storage.saveMachine({ id: 'side-effect-machine', poolId: 'side-effect-pool', tags: {}, capacity: 2, activeLeases: 0, online: true, workerTokenHash: 'hash' });
    const inputTask = await authority.createTask('user-a', { kind: 'browse', goal: 'input CAS exhaustion' });
    const inputClaim = await authority.claim('worker-input', 'side-effect-machine');
    await authority.needsInput(inputTask.id, 'worker-input', inputClaim.leaseToken);
    const handoffTask = await authority.createTask('user-a', { kind: 'browse', goal: 'handoff CAS exhaustion' });
    await authority.claim('worker-handoff', 'side-effect-machine');
    let inputAttempts = 0;
    let handoffAttempts = 0;
    let pendingInputWrites = 0;
    let handoffWrites = 0;
    const repository = new Proxy<Repository>(storage, {
      get(target, property) {
        if (property === 'replaceTaskForClaim') {
          return async (...args: Parameters<Repository['replaceTaskForClaim']>): Promise<boolean> => {
            if (args[0].id === inputTask.id && args[0].status === 'running' && args[1].status === 'needs_input') {
              inputAttempts += 1;
              return false;
            }
            return target.replaceTaskForClaim(...args);
          };
        }
        if (property === 'replaceTaskForActiveClaim') {
          return async (...args: Parameters<Repository['replaceTaskForActiveClaim']>): Promise<boolean> => {
            if (args[0].id === handoffTask.id && args[0].status === 'handoff') {
              handoffAttempts += 1;
              await authority.heartbeat(
                handoffTask.id,
                'worker-handoff',
                (await storage.getTask(handoffTask.id))?.leaseToken ?? '',
                30 + handoffAttempts
              );
              return false;
            }
            return target.replaceTaskForActiveClaim(...args);
          };
        }
        if (property === 'savePendingInput') {
          return async (...args: Parameters<Repository['savePendingInput']>): Promise<void> => {
            pendingInputWrites += 1;
            return target.savePendingInput(...args);
          };
        }
        if (property === 'saveHandoff') {
          return async (...args: Parameters<Repository['saveHandoff']>): Promise<void> => {
            handoffWrites += 1;
            return target.saveHandoff(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const service = new TaskService(
      repository,
      new Scheduler(repository),
      new ProfileLockService(repository),
      new WebhookSigner('test-webhook-secret'),
      { clock: () => clock.value, leaseSeconds: 10 }
    );

    await expect(service.provideInput(inputTask.id, inputTask.userId, { kind: 'text', value: 'secret' }))
      .rejects.toMatchObject({ code: 'concurrent_update', status: 409 });
    await expect(service.requestHandoff(handoffTask.id, handoffTask.userId, 60))
      .rejects.toMatchObject({ code: 'concurrent_update', status: 409 });
    expect(inputAttempts).toBe(3);
    expect(handoffAttempts).toBe(3);
    expect(pendingInputWrites).toBe(0);
    expect(handoffWrites).toBe(0);
    expect(await storage.takePendingInput(inputTask.id)).toBeUndefined();
    expect(await storage.getTask(handoffTask.id)).not.toHaveProperty('handoff');
  });

  it('rejects handoff while a claim is provisional and writes no handoff record', async () => {
    const clock = { value: 1_000 };
    const storage = new MemoryRepository(() => clock.value);
    let provisionalClaimReached!: () => void;
    let resumeClaim!: () => void;
    const claimReached = new Promise<void>((resolve) => { provisionalClaimReached = resolve; });
    const claimResume = new Promise<void>((resolve) => { resumeClaim = resolve; });
    let handoffWrites = 0;
    const repository = new Proxy<Repository>(storage, {
      get(target, property) {
        if (property === 'claimTask') {
          return async (...args: Parameters<Repository['claimTask']>): Promise<Awaited<ReturnType<Repository['claimTask']>>> => {
            const claimed = await target.claimTask(...args);
            if (claimed !== undefined) {
              provisionalClaimReached();
              await claimResume;
            }
            return claimed;
          };
        }
        if (property === 'saveHandoff') {
          return async (...args: Parameters<Repository['saveHandoff']>): Promise<void> => {
            handoffWrites += 1;
            return target.saveHandoff(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const service = new TaskService(
      repository,
      new Scheduler(repository),
      new ProfileLockService(repository),
      new WebhookSigner('test-webhook-secret'),
      { clock: () => clock.value, leaseSeconds: 10 }
    );
    await storage.savePool({ id: 'provisional-pool', visibility: 'platform', tags: {} });
    await storage.saveMachine({ id: 'provisional-machine', poolId: 'provisional-pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'hash' });
    const task = await service.createTask('user-a', { kind: 'browse', goal: 'provisional handoff' });

    const claiming = service.claim('worker-a', 'provisional-machine', clock.value);
    await claimReached;
    try {
      await expect(service.requestHandoff(task.id, task.userId, 60)).rejects.toMatchObject({
        code: 'conflict',
        status: 409,
        message: 'task claim is not active'
      });
      expect(handoffWrites).toBe(0);
      expect(await storage.getTask(task.id)).toMatchObject({ status: 'claimed', claimCommitted: false });
      expect(await storage.getTask(task.id)).not.toHaveProperty('handoff');
    } finally {
      resumeClaim();
    }
    await expect(claiming).resolves.toMatchObject({ task: { id: task.id, claimCommitted: true } });
  });

  it('fences input and handoff intent from a reclaimed generation', async () => {
    const clock = { value: 1_000 };
    const storage = new MemoryRepository(() => clock.value);
    const authority = new TaskService(
      storage,
      new Scheduler(storage),
      new ProfileLockService(storage),
      new WebhookSigner('test-webhook-secret'),
      { clock: () => clock.value, leaseSeconds: 10 }
    );
    await storage.savePool({ id: 'generation-pool', visibility: 'platform', tags: {} });
    await storage.saveMachine({ id: 'generation-machine', poolId: 'generation-pool', tags: {}, capacity: 2, activeLeases: 0, online: true, workerTokenHash: 'hash' });
    const inputTask = await authority.createTask('user-a', { kind: 'browse', goal: 'generation-bound input' });
    const inputClaim = await authority.claim('worker-input', 'generation-machine');
    await authority.needsInput(inputTask.id, 'worker-input', inputClaim.leaseToken);
    const handoffTask = await authority.createTask('user-a', { kind: 'browse', goal: 'generation-bound handoff' });
    const handoffClaim = await authority.claim('worker-handoff', 'generation-machine');
    await authority.heartbeat(handoffTask.id, 'worker-handoff', handoffClaim.leaseToken, 30);
    let inputReclaimed = false;
    let handoffReclaimed = false;
    let pendingInputWrites = 0;
    let handoffWrites = 0;
    const repository = new Proxy<Repository>(storage, {
      get(target, property) {
        if (property === 'replaceTaskForClaim') {
          return async (...args: Parameters<Repository['replaceTaskForClaim']>): Promise<boolean> => {
            if (!inputReclaimed && args[0].id === inputTask.id && args[0].status === 'running' && args[1].status === 'needs_input') {
              inputReclaimed = true;
              await advanceClaimGeneration(target, inputTask.id, 'needs_input');
              return false;
            }
            return target.replaceTaskForClaim(...args);
          };
        }
        if (property === 'replaceTaskForActiveClaim') {
          return async (...args: Parameters<Repository['replaceTaskForActiveClaim']>): Promise<boolean> => {
            if (!handoffReclaimed && args[0].id === handoffTask.id && args[0].status === 'handoff') {
              handoffReclaimed = true;
              await advanceClaimGeneration(target, handoffTask.id, 'running');
              return false;
            }
            return target.replaceTaskForActiveClaim(...args);
          };
        }
        if (property === 'savePendingInput') {
          return async (...args: Parameters<Repository['savePendingInput']>): Promise<void> => {
            pendingInputWrites += 1;
            return target.savePendingInput(...args);
          };
        }
        if (property === 'saveHandoff') {
          return async (...args: Parameters<Repository['saveHandoff']>): Promise<void> => {
            handoffWrites += 1;
            return target.saveHandoff(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const service = new TaskService(
      repository,
      new Scheduler(repository),
      new ProfileLockService(repository),
      new WebhookSigner('test-webhook-secret'),
      { clock: () => clock.value, leaseSeconds: 10 }
    );

    const expectedConflict = {
      code: 'conflict',
      status: 409,
      message: 'task claim generation changed concurrently'
    };
    await expect(service.provideInput(inputTask.id, inputTask.userId, { kind: 'text', value: 'stale input' }))
      .rejects.toMatchObject(expectedConflict);
    await expect(service.requestHandoff(handoffTask.id, handoffTask.userId, 60))
      .rejects.toMatchObject(expectedConflict);
    expect((await storage.getTask(inputTask.id))?.claimGeneration).toBe((inputClaim.task.claimGeneration ?? 0) + 1);
    expect((await storage.getTask(handoffTask.id))?.claimGeneration).toBe((handoffClaim.task.claimGeneration ?? 0) + 1);
    expect(pendingInputWrites).toBe(0);
    expect(handoffWrites).toBe(0);
    expect(await storage.takePendingInput(inputTask.id)).toBeUndefined();
    expect(await storage.getTask(handoffTask.id)).not.toHaveProperty('handoff');
  });

  it('lets either eligible machine claim queued work', async () => {
    const { repository, service } = setup();
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'first', poolId: 'pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'x' });
    await repository.saveMachine({ id: 'second', poolId: 'pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'x' });
    const task = await service.createTask('user-a', { kind: 'browse', goal: 'second may claim' });
    expect((await service.claim('worker-b', 'second')).task.id).toBe(task.id);
  });

  it('never dispatches strict testing tasks through the generic claim path', async () => {
    const { repository, service } = setup({ value: 1_000 });
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'machine', poolId: 'pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'x' });
    const digest = `sha256:${'a'.repeat(64)}`;
    const testingTaskInput = {
      schema_version: 'talos.testing-task/v1',
      id: 'testing-task',
      kind: 'testing',
      interaction: 'managed',
      qa_run_id: 'run-1',
      dispatch_attempt_id: 'attempt-1',
      generation: 1,
      machine_id: 'machine',
      worker_id: 'worker-testing',
      lease_id: 'lease-testing',
      fence_token: 'fence-token-testing-1',
      admission_nonce: 'admission-nonce-testing-1',
      lease_claim: { schema: 'talos.testing-lease-claim/v1', ref: 'talos://testing/claims/run-1/claim-1', digest, expires_at: '2026-08-22T00:10:00.000Z' },
      inputs: {
        schema_version: 'talos.testing-input-references/v1',
        project_pack_snapshot: { schema: 'pql.project-pack-snapshot/v1', ref: 'artifact://pql/project-pack-snapshot/snapshot-1', digest },
        test_selection: { schema: 'pql.test-selection/v1', ref: 'artifact://pql/test-selection/selection-1', digest },
        testing_design_input_set: { schema: 'pql.testing-design-input-set.v1', ref: 'artifact://pql/testing-design-input-set/input-1', digest },
        source_revision: { repository_id: 'repo-1', exact_revision: '0123456789abcdef0123456789abcdef01234567', ref: 'artifact://source/revision-1', digest },
        structured_plan: { schema: 'testing-structured-plan.v2', ref: 'artifact://plans/plan-1', digest },
        environment_profile: { ref: 'artifact://environments/environment-1', digest },
        testing_package: { package_id: 'testing-browser-runner', version: '1.0', digest }
      },
      runner: { package_id: 'testing-browser-runner', version: '1.0', digest },
      policy_ref: { schema: 'talos.testing-execution-policy/v1', ref: 'talos://policies/testing/policy-1', digest },
      budgets_ref: { schema: 'talos.testing-budgets/v1', ref: 'talos://policies/testing/budgets-1', digest },
      local_request_authorization: { ref: 'authorization://local-qa-request/start-1', digest, expires_at: '2026-08-22T00:10:00.000Z' },
      expected_runtime_capability: 'local-qa-mvp/v1',
      deadline: '2026-08-22T00:10:00.000Z'
    } as const;
    const testing = testingTaskSchema.parse({
      ...testingTaskInput,
      task_payload_digest: computeTestingTaskPayloadDigest(testingTaskInput)
    });
    const queuedTestingTask: Task = {
      id: 'testing-task',
      userId: 'user-a',
      kind: 'testing',
      goal: 'display only',
      constraints: {},
      mode: 'act',
      interaction: 'managed',
      status: 'submitted',
      createdAt: new Date(1_000).toISOString(),
      updatedAt: new Date(1_000).toISOString(),
      findings: [],
      artifacts: [],
      testing
    };
    await repository.saveTask(queuedTestingTask);
    const browser = await service.createTask('user-a', { kind: 'browse', goal: 'browser work' });
    expect((await service.claim('worker-a', 'machine')).task.id).toBe(browser.id);
    expect((await repository.getTask('testing-task'))?.status).toBe('submitted');
    await expect(service.createTask('user-a', { kind: 'testing', goal: 'caller bypass' }))
      .rejects.toBeDefined();
  });

  it('fails closed for testing tasks on every generic user, worker, and lease-expiry path', async () => {
    const { repository, service } = setup({ value: 2_000 });
    const digest = `sha256:${'a'.repeat(64)}`;
    const testingTaskInput = {
      schema_version: 'talos.testing-task/v1',
      id: 'testing-task-guarded',
      kind: 'testing',
      interaction: 'managed',
      qa_run_id: 'run-guarded',
      dispatch_attempt_id: 'attempt-guarded',
      generation: 1,
      machine_id: 'machine-guarded',
      worker_id: 'worker-testing',
      lease_id: 'lease-testing',
      fence_token: 'fence-token-testing-2',
      admission_nonce: 'admission-nonce-testing-2',
      lease_claim: { schema: 'talos.testing-lease-claim/v1', ref: 'talos://testing/claims/run-guarded/claim-1', digest, expires_at: '2026-08-22T00:10:00.000Z' },
      inputs: {
        schema_version: 'talos.testing-input-references/v1',
        project_pack_snapshot: { schema: 'pql.project-pack-snapshot/v1', ref: 'artifact://pql/project-pack-snapshot/snapshot-1', digest },
        test_selection: { schema: 'pql.test-selection/v1', ref: 'artifact://pql/test-selection/selection-1', digest },
        testing_design_input_set: { schema: 'pql.testing-design-input-set.v1', ref: 'artifact://pql/testing-design-input-set/input-1', digest },
        source_revision: { repository_id: 'repo-1', exact_revision: '0123456789abcdef0123456789abcdef01234567', ref: 'artifact://source/revision-1', digest },
        structured_plan: { schema: 'testing-structured-plan.v2', ref: 'artifact://plans/plan-1', digest },
        environment_profile: { ref: 'artifact://environments/environment-1', digest },
        testing_package: { package_id: 'testing-browser-runner', version: '1.0', digest }
      },
      runner: { package_id: 'testing-browser-runner', version: '1.0', digest },
      policy_ref: { schema: 'talos.testing-execution-policy/v1', ref: 'talos://policies/testing/policy-1', digest },
      budgets_ref: { schema: 'talos.testing-budgets/v1', ref: 'talos://policies/testing/budgets-1', digest },
      local_request_authorization: { ref: 'authorization://local-qa-request/start-1', digest, expires_at: '2026-08-22T00:10:00.000Z' },
      expected_runtime_capability: 'local-qa-mvp/v1',
      deadline: '2026-08-22T00:10:00.000Z'
    } as const;
    const testing = testingTaskSchema.parse({
      ...testingTaskInput,
      task_payload_digest: computeTestingTaskPayloadDigest(testingTaskInput)
    });
    const task: Task = {
      id: testing.id,
      userId: 'user-a',
      kind: 'testing',
      goal: 'display only',
      constraints: {},
      mode: 'act',
      interaction: 'managed',
      status: 'claimed',
      workerId: 'worker-guarded',
      machineId: 'machine-guarded',
      leaseToken: 'lease-guarded',
      leaseExpiresAt: new Date(1_000).toISOString(),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      findings: [],
      artifacts: [],
      testing
    };
    await repository.saveTask(task);

    await expect(service.getTask(task.id, task.userId)).rejects.toMatchObject({ code: 'conflict' });
    await expect(service.cancel(task.id, task.userId)).rejects.toMatchObject({ code: 'conflict' });
    await expect(service.heartbeat(task.id, 'worker-guarded', 'lease-guarded', 30))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(await service.expireLeases(2_000)).toEqual([]);
    expect(await repository.getTask(task.id)).toMatchObject({ status: 'claimed', leaseToken: 'lease-guarded' });
  });

  it('signals cancellation and fails queued deadline tasks', async () => {
    const { repository, service, clock } = setup({ value: 1000 });
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'machine', poolId: 'pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: hashWorkerToken('worker-token-123456') });
    const active = await service.createTask('user-a', { kind: 'browse', goal: 'cancel' });
    const claim = await service.claim('worker-a', 'machine');
    await service.cancel(active.id, 'user-a');
    await expect(service.heartbeat(active.id, 'worker-a', claim.leaseToken, 10)).rejects.toMatchObject({ code: 'task_cancelled' });
    await expect(service.heartbeat(active.id, 'worker-a', 'wrong-lease-token', 10)).rejects.toMatchObject({ code: 'unauthorized' });
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
