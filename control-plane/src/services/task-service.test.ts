import { describe, expect, it } from 'vitest';
import { hashWorkerToken } from '../config.js';
import { MemoryRepository } from '../storage/memory-repository.js';
import { ProfileLockService } from './profile-lock.js';
import { Scheduler } from './scheduler.js';
import { TaskService } from './task-service.js';
import { WebhookSigner } from './webhook-signer.js';
import type { Task } from '../domain/types.js';
import { computeTestingTaskPayloadDigest, testingTaskSchema } from '@talos/testing-protocol';

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
    expect(publicTask).not.toHaveProperty('claimId');
    expect(publicTask).not.toHaveProperty('claimGeneration');
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
    await repository.saveProfile({ id: 'profile', userId: 'user-a', machineId: 'remote-machine' });

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
