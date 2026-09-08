import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { MongoClient, type Document as MongoDocument } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Repository } from './repository.js';
import { MemoryRepository } from './memory-repository.js';
import { MongoRepository } from './mongo-repository.js';
import type { BrowserTask, WebhookEvent } from '../domain/types.js';
import { TaskService } from '../services/task-service.js';
import { SessionService } from '../services/session-service.js';
import { Scheduler } from '../services/scheduler.js';
import { ProfileLockService } from '../services/profile-lock.js';
import { WebhookSigner } from '../services/webhook-signer.js';
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
  restart: () => Promise<Repository>;
  close: () => Promise<void>;
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => { resolve = resolver; });
  return { promise, resolve };
};

const barrierRepository = (repository: Repository, participants = 2): Repository => {
  const barrier = deferred();
  let arrivals = 0;
  return new Proxy(repository, {
    get(target, property) {
      if (property === 'listQueuedTasks') {
        return async () => {
          const queued = await target.listQueuedTasks();
          arrivals += 1;
          if (arrivals === participants) barrier.resolve();
          await barrier.promise;
          return queued;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
};

const profileAcquireRaceRepositories = (
  repository: Repository,
  taskIds: readonly string[]
): { repositories: readonly Repository[]; arrivals: ReadonlySet<string> } => {
  const barrier = deferred();
  const arrivals = new Set<string>();
  const repositories = taskIds.map((taskId) => new Proxy(repository, {
    get(target, property) {
      if (property === 'listQueuedTasks') {
        return async () => (await target.listQueuedTasks()).filter((task) => task.id === taskId);
      }
      if (property === 'acquireProfileLease') {
        return async (...args: Parameters<Repository['acquireProfileLease']>): Promise<Awaited<ReturnType<Repository['acquireProfileLease']>>> => {
          arrivals.add(args[3].taskId);
          if (arrivals.size === taskIds.length) barrier.resolve();
          await barrier.promise;
          return target.acquireProfileLease(...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  }));
  return { repositories, arrivals };
};

const barrierBeforeRepositoryMethods = (
  repository: Repository,
  methods: readonly (keyof Repository)[],
  participants = methods.length
): Repository => {
  const barrier = deferred();
  let arrivals = 0;
  return new Proxy(repository, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value === 'function' && methods.includes(property as keyof Repository)) {
        return async (...args: unknown[]) => {
          arrivals += 1;
          if (arrivals === participants) barrier.resolve();
          await barrier.promise;
          return Reflect.apply(value, target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
};

type FaultBoundary =
  | 'claim_task'
  | 'machine_reservation'
  | 'profile_lock'
  | 'claim_commit'
  | 'terminal_task'
  | 'machine_release'
  | 'profile_release'
  | 'task_release'
  | 'legacy_draining'
  | 'legacy_machine_release'
  | 'legacy_profile_release'
  | 'legacy_finalizing'
  | 'legacy_marker_clear'
  | 'legacy_done'
  | 'legacy_action_requeue'
  | 'legacy_action_finalize';

const faultAfterBoundary = (
  repository: Repository,
  boundary: FaultBoundary
): { repository: Repository; hitCount: () => number } => {
  let injected = false;
  let hits = 0;
  const inject = (): never => {
    injected = true;
    hits += 1;
    throw new Error(`injected fault after ${boundary}`);
  };
  const faulted = new Proxy(repository, {
    get(target, property) {
      if (property === 'claimTask' && boundary === 'claim_task') {
        return async (...args: Parameters<Repository['claimTask']>): Promise<Awaited<ReturnType<Repository['claimTask']>>> => {
          const result = await target.claimTask(...args);
          if (!injected && result !== undefined) inject();
          return result;
        };
      }
      if (property === 'reserveMachineLease' && boundary === 'machine_reservation') {
        return async (...args: Parameters<Repository['reserveMachineLease']>): Promise<boolean> => {
          const result = await target.reserveMachineLease(...args);
          if (!injected && result) inject();
          return result;
        };
      }
      if (property === 'acquireProfileLease' && boundary === 'profile_lock') {
        return async (...args: Parameters<Repository['acquireProfileLease']>): Promise<Awaited<ReturnType<Repository['acquireProfileLease']>>> => {
          const result = await target.acquireProfileLease(...args);
          if (!injected && result !== undefined) inject();
          return result;
        };
      }
      if (property === 'replaceTaskForClaim' && ['claim_commit', 'terminal_task', 'task_release'].includes(boundary)) {
        return async (...args: Parameters<Repository['replaceTaskForClaim']>): Promise<boolean> => {
          const result = await target.replaceTaskForClaim(...args);
          const task = args[0];
          const matches =
            (boundary === 'claim_commit' && task.status === 'claimed' && task.claimCommitted === true && task.claimReleased !== true) ||
            (boundary === 'terminal_task' && ['completed', 'failed', 'cancelled', 'submitted'].includes(task.status) && task.claimReleased !== true) ||
            (boundary === 'task_release' && task.claimReleased === true);
          if (!injected && result && matches) inject();
          return result;
        };
      }
      if (property === 'releaseMachineLease' && boundary === 'machine_release') {
        return async (...args: Parameters<Repository['releaseMachineLease']>): Promise<boolean> => {
          const result = await target.releaseMachineLease(...args);
          if (!injected && result) inject();
          return result;
        };
      }
      if (property === 'releaseProfileLease' && boundary === 'profile_release') {
        return async (...args: Parameters<Repository['releaseProfileLease']>): Promise<boolean> => {
          const result = await target.releaseProfileLease(...args);
          if (!injected && result) inject();
          return result;
        };
      }
      if (property === 'replaceTaskForRecovery' && ['legacy_draining', 'legacy_finalizing', 'legacy_done'].includes(boundary)) {
        return async (...args: Parameters<Repository['replaceTaskForRecovery']>): Promise<boolean> => {
          const result = await target.replaceTaskForRecovery(...args);
          const [task, guard] = args;
          const matches =
            (boundary === 'legacy_draining' && task.claimRecovery?.phase === 'draining' && guard.recoveryId === undefined) ||
            (boundary === 'legacy_finalizing' && task.claimRecovery?.phase === 'finalizing') ||
            (boundary === 'legacy_done' && task.claimRecovery === undefined && guard.recoveryPhase === 'finalizing');
          if (!injected && result && matches) inject();
          return result;
        };
      }
      if (property === 'releaseLegacyMachineLease' && boundary === 'legacy_machine_release') {
        return async (...args: Parameters<Repository['releaseLegacyMachineLease']>): Promise<boolean> => {
          const result = await target.releaseLegacyMachineLease(...args);
          if (!injected && result) inject();
          return result;
        };
      }
      if (property === 'releaseLegacyProfileLease' && boundary === 'legacy_profile_release') {
        return async (...args: Parameters<Repository['releaseLegacyProfileLease']>): Promise<boolean> => {
          const result = await target.releaseLegacyProfileLease(...args);
          if (!injected && result) inject();
          return result;
        };
      }
      if (property === 'clearLegacyMachineLeaseMarker' && boundary === 'legacy_marker_clear') {
        return async (...args: Parameters<Repository['clearLegacyMachineLeaseMarker']>): Promise<boolean> => {
          const result = await target.clearLegacyMachineLeaseMarker(...args);
          if (!injected && result) inject();
          return result;
        };
      }
      if (property === 'requeueSessionAction' && boundary === 'legacy_action_requeue') {
        return async (...args: Parameters<Repository['requeueSessionAction']>): Promise<void> => {
          await target.requeueSessionAction(...args);
          if (!injected) inject();
        };
      }
      if (property === 'finalizeSessionAction' && boundary === 'legacy_action_finalize') {
        return async (...args: Parameters<Repository['finalizeSessionAction']>): Promise<boolean> => {
          const result = await target.finalizeSessionAction(...args);
          if (!injected && result) inject();
          return result;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return { repository: faulted, hitCount: () => hits };
};

const MONGODB_MEMORY_SERVER_VERSION = '7.0.14';
const MONGODB_CONNECT_TIMEOUT_MS = 5_000;
const MONGODB_CONTRACT_TEST_TIMEOUT_MS = 30_000;
const EXPIRY_QUERY_BATCH_SIZE = 100;
const EXPIRY_QUERY_BACKLOG_SIZE = 2_000;
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
  return {
    repository,
    restart: async () => repository,
    close: () => repository.close()
  };
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
  const url = mongoUrl;
  const databaseName = `talos_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  let client = new MongoClient(url, mongodbClientOptions);
  let repository = new MongoRepository(url, databaseName, { client });
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
    restart: async () => {
      await repository.close();
      client = new MongoClient(url, mongodbClientOptions);
      repository = new MongoRepository(url, databaseName, { client });
      await repository.initialize();
      return repository;
    },
    close: async () => {
      try {
        await client.db(databaseName).dropDatabase();
      } finally {
        await repository.close();
      }
    }
  };
};

const taskService = (repository: Repository, clock = { value: 1_000 }): TaskService => new TaskService(
  repository,
  new Scheduler(repository),
  new ProfileLockService(repository),
  new WebhookSigner('repository-contract-webhook-secret'),
  { clock: () => clock.value, leaseSeconds: 10 }
);

const executionPlanContainsStage = (value: unknown, stage: string): boolean => {
  if (Array.isArray(value)) return value.some((entry) => executionPlanContainsStage(entry, stage));
  if (typeof value !== 'object' || value === null) return false;
  const document = value as Readonly<Record<string, unknown>>;
  return typeof document.stage === 'string' && document.stage.toUpperCase() === stage.toUpperCase() ||
    Object.values(document).some((entry) => executionPlanContainsStage(entry, stage));
};

const executionPlanContainsValue = (value: unknown, expected: string): boolean => {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((entry) => executionPlanContainsValue(entry, expected));
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).some((entry) => executionPlanContainsValue(entry, expected));
};

const normalizedMongoSort = (value: unknown): Readonly<Record<string, unknown>> => {
  if (value instanceof Map) return Object.fromEntries(value);
  return typeof value === 'object' && value !== null ? value as Readonly<Record<string, unknown>> : {};
};

const contractTests = (makeHarness: () => Promise<Harness>): void => {
  it('returns one stable bounded page across deadline and lease expiry sources', async () => {
    const { repository, close } = await makeHarness();
    try {
      const now = Date.parse('2025-01-01T00:00:10.000Z');
      await repository.saveTask(baseTask({
        id: 'expiry-deadline-b',
        constraints: { deadline: '2025-01-01T00:00:01.000Z' }
      }));
      await repository.saveTask(baseTask({
        id: 'expiry-deadline-a',
        constraints: { deadline: '2025-01-01T00:00:01.000Z' }
      }));
      await repository.saveTask(baseTask({
        id: 'expiry-lease',
        status: 'running',
        leaseExpiresAt: '2025-01-01T00:00:02.000Z'
      }));
      await repository.saveTask(baseTask({
        id: 'expiry-future',
        status: 'claimed',
        leaseExpiresAt: '2025-01-01T00:01:00.000Z'
      }));

      expect((await repository.listExpirableTasks(now, 3)).map((task) => task.id)).toEqual([
        'expiry-deadline-a',
        'expiry-deadline-b',
        'expiry-lease'
      ]);
      for (const invalidLimit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(repository.listExpirableTasks(now, invalidLimit))
          .rejects.toThrow('page limit must be a positive safe integer');
      }
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('drains malformed deadline pages without starving a later valid expiry', async () => {
    const { repository, close } = await makeHarness();
    try {
      const now = Date.parse('2025-01-01T00:01:00.000Z');
      const service = taskService(repository, { value: now });
      for (let index = 0; index <= EXPIRY_QUERY_BATCH_SIZE; index += 1) {
        await repository.saveTask(baseTask({
          id: `malformed-deadline-${String(index).padStart(3, '0')}`,
          constraints: { deadline: '' }
        }));
      }
      await repository.saveTask(baseTask({
        id: 'valid-deadline-after-malformed-page',
        constraints: { deadline: '2025-01-01T00:00:01.000Z' },
        createdAt: '2025-01-01T00:00:01.000Z'
      }));

      await service.expireLeases(now);

      expect(await repository.getTask('valid-deadline-after-malformed-page')).toMatchObject({
        status: 'failed',
        error: { code: 'deadline_exceeded' }
      });
      expect((await repository.listTasks()).filter((task) => task.error?.code === 'invalid_deadline'))
        .toHaveLength(EXPIRY_QUERY_BATCH_SIZE + 1);
      const canonical = await service.createTask('user-1', {
        kind: 'browse',
        goal: 'canonical deadline',
        constraints: { deadline: '2025-01-01T08:02:00.000+08:00' }
      });
      expect(canonical.constraints.deadline).toBe('2025-01-01T00:02:00.000Z');
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('linearizes task claim, machine admission, and profile ownership', async () => {
    const { repository, close } = await makeHarness();
    try {
      await repository.savePool({ id: 'claim-pool', visibility: 'platform', tags: {} });
      await repository.saveMachine({ id: 'claim-machine', poolId: 'claim-pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'hash' });
      await repository.createProfile({ id: 'claim-profile', userId: 'user-1' });
      await repository.saveTask(baseTask({ id: 'claim-task', profileId: 'claim-profile' }));
      const service = taskService(barrierRepository(repository));

      const results = await Promise.allSettled([
        service.claim('worker-a', 'claim-machine'),
        service.claim('worker-b', 'claim-machine')
      ]);
      const winners = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<TaskService['claim']>>> => result.status === 'fulfilled');
      expect(winners).toHaveLength(1);
      const winner = winners[0]!.value;
      const stored = await repository.getTask('claim-task');
      const machine = await repository.getMachine('claim-machine');
      const profile = await repository.getProfile('claim-profile');
      expect(stored).toMatchObject({
        status: 'claimed',
        workerId: winner.task.workerId,
        leaseToken: winner.leaseToken,
        claimId: winner.task.claimId,
        claimGeneration: 1
      });
      expect(machine).toMatchObject({ activeLeases: 1 });
      expect(machine?.leaseReservations).toEqual([expect.objectContaining({
        taskId: stored?.id,
        claimId: stored?.claimId,
        claimGeneration: stored?.claimGeneration
      })]);
      expect(profile).toMatchObject({
        lockedByTaskId: stored?.id,
        lockedByClaimId: stored?.claimId,
        lockedByClaimGeneration: stored?.claimGeneration
      });
      expect(await repository.releaseMachineLease('claim-machine', { taskId: 'claim-task', claimId: 'loser-claim', claimGeneration: 1 })).toBe(false);
      expect(await repository.releaseProfileLease('claim-profile', { taskId: 'claim-task', claimId: 'loser-claim', claimGeneration: 1 })).toBe(false);
      expect(await repository.getMachine('claim-machine')).toMatchObject({ activeLeases: 1 });
      expect(await repository.getProfile('claim-profile')).toMatchObject({ lockedByClaimId: stored?.claimId });
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('atomically admits only one claim into the final machine slot', async () => {
    const { repository, close } = await makeHarness();
    try {
      await repository.savePool({ id: 'capacity-pool', visibility: 'platform', tags: {} });
      await repository.saveMachine({ id: 'capacity-machine', poolId: 'capacity-pool', tags: {}, capacity: 2, activeLeases: 1, online: true, workerTokenHash: 'hash' });
      await repository.saveTask(baseTask({ id: 'capacity-task-a', createdAt: '2025-01-01T00:00:00.000Z' }));
      await repository.saveTask(baseTask({ id: 'capacity-task-b', createdAt: '2025-01-01T00:00:01.000Z' }));
      const service = taskService(barrierRepository(repository));

      const results = await Promise.allSettled([
        service.claim('worker-a', 'capacity-machine'),
        service.claim('worker-b', 'capacity-machine')
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await repository.getMachine('capacity-machine')).toMatchObject({
        activeLeases: 2,
        leaseReservations: [expect.any(Object)]
      });
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('recovers a committed claim after faults at every claim persistence boundary', async () => {
    const harness = await makeHarness();
    let repository = harness.repository;
    try {
      const clock = { value: Date.now() };
      await repository.savePool({ id: 'fault-claim-pool', visibility: 'platform', tags: {} });
      const boundaries = ['claim_task', 'machine_reservation', 'profile_lock', 'claim_commit'] as const;
      for (const [index, boundary] of boundaries.entries()) {
        const suffix = `${index}-${boundary}`;
        const machineId = `fault-claim-machine-${suffix}`;
        const profileId = `fault-claim-profile-${suffix}`;
        const taskId = `fault-claim-task-${suffix}`;
        await repository.saveMachine({
          id: machineId,
          poolId: 'fault-claim-pool',
          tags: {},
          capacity: 1,
          activeLeases: 0,
          online: true,
          workerTokenHash: 'hash'
        });
        await repository.createProfile({ id: profileId, userId: 'user-1' });
        await repository.saveTask(baseTask({ id: taskId, profileId }));
        const fault = faultAfterBoundary(repository, boundary);
        const faulted = taskService(fault.repository, clock);

        await expect(faulted.claim(`worker-${suffix}`, machineId, clock.value))
          .rejects.toThrow(`injected fault after ${boundary}`);
        expect(fault.hitCount()).toBe(1);
        repository = await harness.restart();
        const restarted = taskService(repository, clock);
        await restarted.reconcileClaims(clock.value);

        const stored = await repository.getTask(taskId);
        expect(stored).toMatchObject({
          status: 'claimed',
          claimCommitted: true,
          claimReleased: false,
          machineId,
          workerId: `worker-${suffix}`
        });
        expect(await repository.getMachine(machineId)).toMatchObject({
          activeLeases: 1,
          leaseReservations: [{
            taskId,
            claimId: stored?.claimId,
            claimGeneration: stored?.claimGeneration
          }]
        });
        expect(await repository.getProfile(profileId)).toMatchObject({
          lockedByTaskId: taskId,
          lockedByClaimId: stored?.claimId,
          lockedByClaimGeneration: stored?.claimGeneration
        });
        await expect(restarted.claim(`duplicate-${suffix}`, machineId, clock.value))
          .rejects.toMatchObject({ code: 'not_found' });
      }
    } finally {
      await harness.close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('recovers a lost claim response through expiry and a fenced generation N+1 reclaim', async () => {
    const harness = await makeHarness();
    let repository = harness.repository;
    try {
      const clock = { value: 1_000 };
      await repository.savePool({ id: 'lost-response-pool', visibility: 'platform', tags: {} });
      await repository.saveMachine({
        id: 'lost-response-machine',
        poolId: 'lost-response-pool',
        tags: {},
        capacity: 1,
        activeLeases: 0,
        online: true,
        workerTokenHash: 'hash'
      });
      await repository.createProfile({ id: 'lost-response-profile', userId: 'user-1' });
      await repository.saveTask(baseTask({ id: 'lost-response-task', profileId: 'lost-response-profile' }));
      const first = await taskService(repository, clock).claim('lost-response-worker', 'lost-response-machine', clock.value);

      repository = await harness.restart();
      const restarted = taskService(repository, clock);
      await expect(restarted.claim('duplicate-worker', 'lost-response-machine', clock.value))
        .rejects.toMatchObject({ code: 'not_found' });

      clock.value = 12_000;
      expect(await restarted.expireLeases(clock.value)).toHaveLength(1);
      expect(await repository.getTask('lost-response-task')).toMatchObject({
        status: 'submitted',
        claimGeneration: first.task.claimGeneration,
        claimReleased: true
      });
      expect(await repository.getMachine('lost-response-machine')).toMatchObject({
        activeLeases: 0,
        leaseReservations: []
      });
      expect((await repository.getProfile('lost-response-profile'))?.lockedByTaskId).toBeUndefined();

      const second = await restarted.claim('replacement-worker', 'lost-response-machine', clock.value);
      expect(second.task.claimGeneration).toBe((first.task.claimGeneration ?? 0) + 1);
      expect(second.task.claimId).not.toBe(first.task.claimId);
      await expect(restarted.heartbeat('lost-response-task', 'lost-response-worker', first.leaseToken, 10))
        .rejects.toMatchObject({ code: 'unauthorized' });
      await expect(restarted.complete('lost-response-task', 'lost-response-worker', first.leaseToken, 'completed', []))
        .rejects.toMatchObject({ code: 'unauthorized' });
      expect(await repository.getMachine('lost-response-machine')).toMatchObject({
        activeLeases: 1,
        leaseReservations: [expect.objectContaining({
          taskId: second.task.id,
          claimId: second.task.claimId,
          claimGeneration: second.task.claimGeneration
        })]
      });
      expect(await repository.getProfile('lost-response-profile')).toMatchObject({
        lockedByTaskId: second.task.id,
        lockedByClaimId: second.task.claimId,
        lockedByClaimGeneration: second.task.claimGeneration
      });
    } finally {
      await harness.close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('converges exact release after faults without changing unrelated leases or profiles', async () => {
    const harness = await makeHarness();
    let repository = harness.repository;
    try {
      const clock = { value: Date.now() };
      await repository.savePool({ id: 'fault-release-pool', visibility: 'platform', tags: {} });
      const boundaries = ['terminal_task', 'machine_release', 'profile_release', 'task_release'] as const;
      for (const [index, boundary] of boundaries.entries()) {
        const suffix = `${index}-${boundary}`;
        const machineId = `fault-release-machine-${suffix}`;
        const profileId = `fault-release-profile-${suffix}`;
        const unrelatedProfileId = `unrelated-profile-${suffix}`;
        const taskId = `fault-release-task-${suffix}`;
        const unrelated = {
          taskId: `unrelated-task-${suffix}`,
          claimId: `unrelated-claim-${suffix}`,
          claimGeneration: 9,
          expiresAt: new Date(clock.value + 60_000).toISOString()
        };
        await repository.saveMachine({
          id: machineId,
          poolId: 'fault-release-pool',
          tags: {},
          capacity: 2,
          activeLeases: 1,
          leaseReservations: [unrelated],
          online: true,
          workerTokenHash: 'hash'
        });
        await repository.createProfile({ id: profileId, userId: 'user-1' });
        await repository.createProfile({
          id: unrelatedProfileId,
          userId: 'user-1',
          machineId,
          lockedByTaskId: unrelated.taskId,
          lockedByClaimId: unrelated.claimId,
          lockedByClaimGeneration: unrelated.claimGeneration,
          lockExpiresAt: unrelated.expiresAt
        });
        await repository.saveTask(baseTask({ id: taskId, profileId }));
        const claimed = await taskService(repository, clock).claim(`worker-${suffix}`, machineId, clock.value);
        const fault = faultAfterBoundary(repository, boundary);
        const faulted = taskService(fault.repository, clock);

        await expect(faulted.complete(taskId, `worker-${suffix}`, claimed.leaseToken, 'completed', []))
          .rejects.toThrow(`injected fault after ${boundary}`);
        expect(fault.hitCount()).toBe(1);
        repository = await harness.restart();
        await taskService(repository, clock).reconcileClaims(clock.value);

        expect(await repository.getTask(taskId)).toMatchObject({ status: 'completed', claimReleased: true });
        expect(await repository.getMachine(machineId)).toMatchObject({
          activeLeases: 1,
          leaseReservations: [unrelated]
        });
        expect((await repository.getProfile(profileId))?.lockedByTaskId).toBeUndefined();
        expect(await repository.getProfile(unrelatedProfileId)).toMatchObject({
          lockedByTaskId: unrelated.taskId,
          lockedByClaimId: unrelated.claimId,
          lockedByClaimGeneration: unrelated.claimGeneration
        });
      }
    } finally {
      await harness.close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('converges legacy recovery after faults at every durable side-effect boundary', async () => {
    const harness = await makeHarness();
    let repository = harness.repository;
    try {
      const clock = { value: Date.now() };
      const boundaries = [
        'legacy_draining',
        'legacy_machine_release',
        'legacy_profile_release',
        'legacy_finalizing',
        'legacy_marker_clear',
        'legacy_done'
      ] as const;
      for (const [index, boundary] of boundaries.entries()) {
        const suffix = `${index}-${boundary}`;
        const machineId = `legacy-fault-machine-${suffix}`;
        const profileId = `legacy-fault-profile-${suffix}`;
        const taskId = `legacy-fault-task-${suffix}`;
        await repository.saveMachine({
          id: machineId,
          poolId: 'pool',
          tags: {},
          capacity: 1,
          activeLeases: 1,
          online: true,
          workerTokenHash: 'hash'
        });
        await repository.createProfile({
          id: profileId,
          userId: 'user-1',
          machineId,
          lockedByTaskId: taskId,
          lockExpiresAt: new Date(clock.value + 60_000).toISOString()
        });
        await repository.saveTask(baseTask({
          id: taskId,
          status: 'running',
          profileId,
          machineId,
          workerId: `legacy-worker-${suffix}`,
          leaseToken: `legacy-token-${suffix}`,
          leaseExpiresAt: new Date(clock.value + 60_000).toISOString(),
          queuePriority: index
        }));

        const fault = faultAfterBoundary(repository, boundary);
        await taskService(fault.repository, clock).reconcileClaims(clock.value);
        expect(fault.hitCount()).toBe(1);
        const interrupted = await repository.getTask(taskId);
        if (boundary === 'legacy_done') {
          expect(interrupted?.claimRecovery).toBeUndefined();
        } else {
          expect(interrupted?.claimRecovery?.phase).toBe(
            ['legacy_finalizing', 'legacy_marker_clear'].includes(boundary) ? 'finalizing' : 'draining'
          );
        }
        expect(await repository.getMachine(machineId)).toMatchObject({
          activeLeases: ['legacy_draining'].includes(boundary) ? 1 : 0
        });
        expect((await repository.getProfile(profileId))?.lockedByTaskId).toBe(
          ['legacy_draining', 'legacy_machine_release'].includes(boundary) ? taskId : undefined
        );

        repository = await harness.restart();
        const restarted = taskService(repository, clock);
        await restarted.reconcileClaims(clock.value);
        expect(await repository.getTask(taskId)).toMatchObject({
          status: 'submitted',
          queuePriority: index
        });
        expect((await repository.getTask(taskId))?.claimRecovery).toBeUndefined();
        expect(await repository.getMachine(machineId)).toMatchObject({ activeLeases: 0 });
        expect((await repository.getProfile(profileId))?.lockedByTaskId).toBeUndefined();

        await restarted.reconcileClaims(clock.value);
        expect(await repository.getMachine(machineId)).toMatchObject({ activeLeases: 0 });
      }
    } finally {
      await harness.close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('retries legacy interactive action side effects after restart', async () => {
    const harness = await makeHarness();
    let repository = harness.repository;
    try {
      const clock = { value: Date.now() };
      await repository.saveTask(baseTask({
        id: 'legacy-action-requeue-task',
        interaction: 'interactive',
        status: 'running',
        workerId: 'legacy-worker',
        leaseToken: 'legacy-token',
        pendingActionId: 'legacy-action-requeue'
      }));
      await repository.enqueueSessionAction({
        id: 'legacy-action-requeue',
        taskId: 'legacy-action-requeue-task',
        action: { type: 'navigate', url: 'https://example.com/retry' },
        state: 'pending',
        createdAt: '2025-01-01T00:00:00.000Z'
      });
      await repository.takePendingSessionAction('legacy-action-requeue-task');
      const requeueFault = faultAfterBoundary(repository, 'legacy_action_requeue');
      await taskService(requeueFault.repository, clock).reconcileClaims(clock.value);
      expect(requeueFault.hitCount()).toBe(1);
      expect((await repository.getTask('legacy-action-requeue-task'))?.claimRecovery?.phase).toBe('draining');
      expect(await repository.getPendingSessionAction('legacy-action-requeue-task')).toMatchObject({
        id: 'legacy-action-requeue',
        state: 'pending'
      });

      repository = await harness.restart();
      await taskService(repository, clock).reconcileClaims(clock.value);
      expect(await repository.getTask('legacy-action-requeue-task')).toMatchObject({ status: 'submitted' });
      expect((await repository.getTask('legacy-action-requeue-task'))?.claimRecovery).toBeUndefined();
      expect(await repository.getPendingSessionAction('legacy-action-requeue-task')).toMatchObject({ state: 'pending' });

      await repository.saveTask(baseTask({
        id: 'legacy-action-closing-task',
        interaction: 'interactive',
        status: 'closing',
        workerId: 'legacy-worker',
        leaseToken: 'legacy-token',
        pendingActionId: 'legacy-action-close',
        createdAt: '2025-01-01T00:00:01.000Z'
      }));
      await repository.enqueueSessionAction({
        id: 'legacy-action-close',
        taskId: 'legacy-action-closing-task',
        action: { type: 'navigate', url: 'https://example.com/close' },
        state: 'pending',
        createdAt: '2025-01-01T00:00:01.000Z'
      });
      await repository.takePendingSessionAction('legacy-action-closing-task');
      const finalizeFault = faultAfterBoundary(repository, 'legacy_action_finalize');
      await taskService(finalizeFault.repository, clock).reconcileClaims(clock.value);
      expect(finalizeFault.hitCount()).toBe(1);
      expect((await repository.getTask('legacy-action-closing-task'))?.claimRecovery?.phase).toBe('draining');
      expect(await repository.getSessionActionResult('legacy-action-close')).toMatchObject({
        result: { error: { code: 'session_closed' } }
      });

      repository = await harness.restart();
      await taskService(repository, clock).reconcileClaims(clock.value);
      expect(await repository.getTask('legacy-action-closing-task')).toMatchObject({ status: 'completed' });
      expect((await repository.getTask('legacy-action-closing-task'))?.claimRecovery).toBeUndefined();
      expect(await repository.getPendingSessionAction('legacy-action-closing-task')).toBeUndefined();
      expect(await repository.getSessionActionResult('legacy-action-close')).toMatchObject({
        result: { error: { code: 'session_closed' } }
      });
    } finally {
      await harness.close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('allows exactly one of two different tasks to own the same profile', async () => {
    const { repository, close } = await makeHarness();
    try {
      const clock = { value: Date.now() };
      await repository.savePool({ id: 'profile-race-pool', visibility: 'platform', tags: {} });
      await repository.saveMachine({
        id: 'profile-race-machine',
        poolId: 'profile-race-pool',
        tags: {},
        capacity: 2,
        activeLeases: 0,
        online: true,
        workerTokenHash: 'hash'
      });
      await repository.createProfile({ id: 'shared-race-profile', userId: 'user-1' });
      await repository.saveTask(baseTask({ id: 'profile-race-task-a', profileId: 'shared-race-profile' }));
      await repository.saveTask(baseTask({
        id: 'profile-race-task-b',
        profileId: 'shared-race-profile',
        createdAt: '2025-01-01T00:00:01.000Z'
      }));
      const race = profileAcquireRaceRepositories(repository, ['profile-race-task-a', 'profile-race-task-b']);
      const firstService = taskService(race.repositories[0]!, clock);
      const secondService = taskService(race.repositories[1]!, clock);

      const results = await Promise.allSettled([
        firstService.claim('profile-race-worker-a', 'profile-race-machine', clock.value),
        secondService.claim('profile-race-worker-b', 'profile-race-machine', clock.value)
      ]);
      const winners = results.filter((result) => result.status === 'fulfilled');
      expect(winners).toHaveLength(1);
      expect([...race.arrivals].sort()).toEqual(['profile-race-task-a', 'profile-race-task-b']);
      const tasks = await repository.listTasks();
      const claimed = tasks.filter((task) => task.id.startsWith('profile-race-task-') && task.status === 'claimed');
      const requeued = tasks.filter((task) => task.id.startsWith('profile-race-task-') && task.status === 'submitted');
      expect(claimed).toHaveLength(1);
      expect(requeued).toHaveLength(1);
      const machine = await repository.getMachine('profile-race-machine');
      expect(machine).toMatchObject({ activeLeases: 1 });
      expect(machine?.leaseReservations).toEqual([expect.objectContaining({
        taskId: claimed[0]?.id,
        claimId: claimed[0]?.claimId,
        claimGeneration: claimed[0]?.claimGeneration
      })]);
      expect(requeued[0]).toMatchObject({ claimReleased: true, claimCommitted: false });
      expect(await repository.getProfile('shared-race-profile')).toMatchObject({
        lockedByTaskId: claimed[0]?.id,
        lockedByClaimId: claimed[0]?.claimId,
        lockedByClaimGeneration: claimed[0]?.claimGeneration
      });
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('rotates machine tokens without replacing lease accounting', async () => {
    const { repository, close } = await makeHarness();
    try {
      const unrelatedReservation = { taskId: 'task-unrelated', claimId: 'claim-unrelated', claimGeneration: 7, expiresAt: '2026-09-04T12:01:00.000Z' };
      const targetReservation = { taskId: 'task-target', claimId: 'claim-target', claimGeneration: 1, expiresAt: '2026-09-04T12:02:00.000Z' };
      await repository.saveMachine({
        id: 'machine-accounting',
        poolId: 'pool',
        tags: { os: 'macos' },
        capacity: 2,
        activeLeases: 1,
        leaseReservations: [unrelatedReservation],
        online: true,
        workerTokenHash: 'old-hash'
      });

      const reserveRace = barrierBeforeRepositoryMethods(repository, ['rotateMachineToken', 'reserveMachineLease']);
      expect(await Promise.all([
        reserveRace.rotateMachineToken('machine-accounting', 'old-hash', 'rotated-hash'),
        reserveRace.reserveMachineLease('machine-accounting', targetReservation)
      ])).toEqual([true, true]);
      expect(await repository.rotateMachineToken('machine-accounting', 'old-hash', 'stale-hash')).toBe(false);
      expect(await repository.getMachine('machine-accounting')).toEqual({
        id: 'machine-accounting',
        poolId: 'pool',
        tags: { os: 'macos' },
        capacity: 2,
        online: true,
        activeLeases: 2,
        workerTokenHash: 'rotated-hash',
        leaseReservations: [unrelatedReservation, targetReservation]
      });

      const releaseRace = barrierBeforeRepositoryMethods(repository, ['rotateMachineToken', 'releaseMachineLease']);
      expect(await Promise.all([
        releaseRace.rotateMachineToken('machine-accounting', 'rotated-hash', 'final-hash'),
        releaseRace.releaseMachineLease('machine-accounting', {
          taskId: targetReservation.taskId,
          claimId: targetReservation.claimId,
          claimGeneration: targetReservation.claimGeneration
        })
      ])).toEqual([true, true]);
      expect(await repository.getMachine('machine-accounting')).toEqual({
        id: 'machine-accounting',
        poolId: 'pool',
        tags: { os: 'macos' },
        capacity: 2,
        online: true,
        activeLeases: 1,
        workerTokenHash: 'final-hash',
        leaseReservations: [unrelatedReservation]
      });
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('refuses a lease response when a committed projection disappears before verification', async () => {
    const { repository, close } = await makeHarness();
    try {
      const clock = { value: Date.now() };
      await repository.savePool({ id: 'projection-loss-pool', visibility: 'platform', tags: {} });
      for (const projection of ['machine', 'profile'] as const) {
        const taskId = `projection-loss-${projection}-task`;
        const machineId = `projection-loss-${projection}-machine`;
        const profileId = `projection-loss-${projection}-profile`;
        await repository.saveMachine({ id: machineId, poolId: 'projection-loss-pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'hash' });
        await repository.createProfile({ id: profileId, userId: 'user-1' });
        await repository.saveTask(baseTask({ id: taskId, profileId }));
        let injections = 0;
        const projectionLossRepository = new Proxy(repository, {
          get(target, property) {
            if (property === 'replaceTaskForClaim') {
              return async (...args: Parameters<Repository['replaceTaskForClaim']>): Promise<boolean> => {
                const committed = await target.replaceTaskForClaim(...args);
                const task = args[0];
                if (committed && injections === 0 && task.claimCommitted === true && task.claimReleased !== true) {
                  injections += 1;
                  const reservation = { taskId: task.id, claimId: task.claimId!, claimGeneration: task.claimGeneration! };
                  if (projection === 'machine') await target.releaseMachineLease(machineId, reservation);
                  else await target.releaseProfileLease(profileId, reservation);
                }
                return committed;
              };
            }
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });

        await expect(taskService(projectionLossRepository, clock).claim(`projection-loss-${projection}-worker`, machineId, clock.value))
          .rejects.toMatchObject({ code: 'not_found' });
        expect(injections).toBe(1);
        expect(await repository.getTask(taskId)).toMatchObject({
          status: 'submitted',
          claimGeneration: 1,
          claimCommitted: false,
          claimReleased: true
        });
        expect(await repository.getMachine(machineId)).toMatchObject({ activeLeases: 0, leaseReservations: [] });
        expect(await repository.getProfile(profileId)).not.toHaveProperty('lockedByTaskId');

        const reclaimed = await taskService(repository, clock).claim(`projection-loss-${projection}-replacement`, machineId, clock.value);
        expect(reclaimed.task).toMatchObject({ status: 'claimed', claimGeneration: 2, claimCommitted: true });
        expect(await repository.getMachine(machineId)).toMatchObject({
          activeLeases: 1,
          leaseReservations: [{
            taskId,
            claimId: reclaimed.task.claimId,
            claimGeneration: reclaimed.task.claimGeneration,
            expiresAt: reclaimed.task.leaseExpiresAt
          }]
        });
        expect(await repository.getProfile(profileId)).toMatchObject({
          lockedByTaskId: taskId,
          lockedByClaimId: reclaimed.task.claimId,
          lockedByClaimGeneration: reclaimed.task.claimGeneration
        });
      }
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('keeps machine reservation mutations idempotent and monotonic', async () => {
    const { repository, close } = await makeHarness();
    try {
      await repository.saveMachine({
        id: 'machine-reservation-mutations',
        poolId: 'pool',
        tags: {},
        capacity: 2,
        activeLeases: 0,
        online: true,
        workerTokenHash: 'hash'
      });
      const initial = {
        taskId: 'task-a',
        claimId: 'claim-a',
        claimGeneration: 1,
        expiresAt: '2026-09-04T12:01:00.000Z'
      };

      expect(await repository.reserveMachineLease('machine-reservation-mutations', initial)).toBe(true);
      expect(await repository.reserveMachineLease('machine-reservation-mutations', initial)).toBe(true);
      expect(await repository.reserveMachineLease('machine-reservation-mutations', {
        ...initial,
        taskId: 'task-with-conflicting-claim-id'
      })).toBe(false);
      expect(await repository.getMachine('machine-reservation-mutations')).toMatchObject({
        activeLeases: 1,
        leaseReservations: [initial]
      });

      expect(await repository.renewMachineLease('machine-reservation-mutations', {
        ...initial,
        expiresAt: '2026-09-04T12:00:00.000Z'
      })).toBe(true);
      expect(await repository.getMachine('machine-reservation-mutations')).toMatchObject({
        leaseReservations: [initial]
      });

      const extended = { ...initial, expiresAt: '2026-09-04T12:02:00.000Z' };
      expect(await repository.renewMachineLease('machine-reservation-mutations', extended)).toBe(true);
      expect(await repository.getMachine('machine-reservation-mutations')).toMatchObject({
        activeLeases: 1,
        leaseReservations: [extended]
      });

      const identity = { taskId: initial.taskId, claimId: initial.claimId, claimGeneration: initial.claimGeneration };
      expect(await repository.releaseMachineLease('machine-reservation-mutations', identity)).toBe(true);
      expect(await repository.releaseMachineLease('machine-reservation-mutations', identity)).toBe(false);
      expect(await repository.getMachine('machine-reservation-mutations')).toMatchObject({
        activeLeases: 0,
        leaseReservations: []
      });
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('does not let profile creation clear an active claim lock', async () => {
    const { repository, close } = await makeHarness();
    try {
      expect(await repository.createProfile({ id: 'profile-insert', userId: 'user-1' })).toBe(true);
      const reservation = { taskId: 'task-a', claimId: 'claim-a', claimGeneration: 1, expiresAt: '2026-09-07T12:01:00.000Z' };
      expect(await repository.acquireProfileLease('profile-insert', 'user-1', 'machine-a', reservation)).toBeDefined();
      expect(await repository.createProfile({ id: 'profile-insert', userId: 'user-1', machineId: 'machine-b' })).toBe(false);
      expect(await repository.getProfile('profile-insert')).toMatchObject({
        machineId: 'machine-a',
        lockedByTaskId: 'task-a',
        lockedByClaimId: 'claim-a'
      });
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('atomically selects one winner for concurrent profile creation', async () => {
    const { repository, close } = await makeHarness();
    try {
      const candidates = [
        { id: 'profile-create-race', userId: 'user-a', machineId: 'machine-a' },
        { id: 'profile-create-race', userId: 'user-b', machineId: 'machine-b' }
      ] as const;
      const results = await Promise.all(candidates.map((profile) => repository.createProfile(profile)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await repository.getProfile('profile-create-race')).toEqual(candidates[results.indexOf(true)]);
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('serializes profile takeover after authoritative task expiry', async () => {
    const { repository, close } = await makeHarness();
    try {
      const now = Date.now();
      await repository.createProfile({ id: 'profile-renewing', userId: 'user-1' });
      const submitted = baseTask({ id: 'task-renewing', profileId: 'profile-renewing' });
      await repository.saveTask(submitted);
      const active = (await repository.claimTask({
        ...submitted,
        status: 'claimed',
        workerId: 'worker-active',
        machineId: 'machine-a',
        leaseToken: 'lease-active',
        leaseExpiresAt: new Date(now + 60_000).toISOString(),
        claimId: 'claim-active',
        claimGeneration: 1,
        taskVersion: 1,
        claimCommitted: true,
        claimedAt: new Date(now - 60_000).toISOString(),
        updatedAt: new Date(now - 60_000).toISOString()
      }, 0, 0))!;
      const staleProjection = {
        taskId: active.id,
        claimId: active.claimId!,
        claimGeneration: active.claimGeneration!,
        expiresAt: new Date(now - 60_000).toISOString()
      };
      const takeover = { taskId: 'task-new', claimId: 'claim-new', claimGeneration: 1, expiresAt: new Date(now + 120_000).toISOString() };
      expect(await repository.acquireProfileLease('profile-renewing', 'user-1', 'machine-a', staleProjection)).toBeDefined();

      const renewedDeadline = new Date(now + 180_000).toISOString();
      const renewalCommitted = deferred();
      const releaseRenewal = deferred();
      const renewal = (async () => {
        const result = await repository.replaceTaskForActiveClaim(
          { ...active, status: 'running', leaseExpiresAt: renewedDeadline },
          {
            claimId: active.claimId!,
            claimGeneration: active.claimGeneration!,
            taskVersion: active.taskVersion!,
            status: active.status,
            leaseExpiresAt: active.leaseExpiresAt!
          }
        );
        renewalCommitted.resolve();
        await releaseRenewal.promise;
        return result;
      })();

      await renewalCommitted.promise;
      try {
        expect(await repository.acquireProfileLease('profile-renewing', 'user-1', 'machine-b', takeover)).toBeUndefined();
        const renewed = (await repository.getTask(active.id))!;
        expect(await repository.replaceTaskForExpiredClaim({
          ...renewed,
          status: 'submitted',
          leaseExpiresAt: undefined,
          leaseToken: undefined,
          workerId: undefined,
          queuePriority: -1
        }, {
          claimId: renewed.claimId!,
          claimGeneration: renewed.claimGeneration!,
          taskVersion: renewed.taskVersion!,
          status: renewed.status,
          leaseExpiresAt: renewed.leaseExpiresAt!
        })).toBe(false);
        expect(await repository.getProfile('profile-renewing')).toMatchObject({
          lockedByTaskId: active.id,
          lockedByClaimId: active.claimId
        });
      } finally {
        releaseRenewal.resolve();
      }
      expect(await renewal).toBe(true);
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('takes over a profile only after requeueing its expired task generation', async () => {
    const { repository, close } = await makeHarness();
    try {
      const clock = { value: Date.now() };
      await repository.savePool({ id: 'takeover-pool', visibility: 'platform', tags: {} });
      await repository.saveMachine({ id: 'takeover-machine', poolId: 'takeover-pool', tags: {}, capacity: 2, activeLeases: 0, online: true, workerTokenHash: 'hash' });
      await repository.createProfile({ id: 'takeover-profile', userId: 'user-1' });
      const previous = baseTask({ id: 'takeover-previous', profileId: 'takeover-profile', queuePriority: 7 });
      await repository.saveTask(previous);
      const expired = (await repository.claimTask({
        ...previous,
        status: 'claimed',
        workerId: 'worker-previous',
        machineId: 'takeover-machine',
        leaseToken: 'lease-previous',
        leaseExpiresAt: '2000-01-01T00:00:00.000Z',
        claimId: 'claim-previous',
        claimGeneration: 1,
        taskVersion: 1,
        claimCommitted: true,
        claimQueuePriority: previous.queuePriority,
        queuePriority: undefined,
        claimedAt: '1999-12-31T23:59:00.000Z',
        updatedAt: '1999-12-31T23:59:00.000Z'
      }, 0, 0))!;
      const expiredReservation = {
        taskId: expired.id,
        claimId: expired.claimId!,
        claimGeneration: expired.claimGeneration!,
        expiresAt: expired.leaseExpiresAt!
      };
      expect(await repository.reserveMachineLease('takeover-machine', expiredReservation)).toBe(true);
      expect(await repository.acquireProfileLease('takeover-profile', 'user-1', 'takeover-machine', expiredReservation)).toBeDefined();
      await repository.saveTask(baseTask({ id: 'takeover-next', profileId: 'takeover-profile', createdAt: new Date(clock.value).toISOString(), updatedAt: new Date(clock.value).toISOString() }));

      const claimed = await taskService(repository, clock).claim('worker-next', 'takeover-machine', clock.value);
      expect(claimed.task.id).toBe('takeover-next');
      expect(await repository.getTask(expired.id)).toMatchObject({
        status: 'submitted',
        claimReleased: true,
        workerId: undefined,
        leaseExpiresAt: undefined,
        queuePriority: previous.queuePriority,
        claimQueuePriority: undefined
      });
      expect(await repository.getMachine('takeover-machine')).toMatchObject({ activeLeases: 1 });
      expect(await repository.getProfile('takeover-profile')).toMatchObject({
        lockedByTaskId: claimed.task.id,
        lockedByClaimId: claimed.task.claimId
      });
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('fences stale lifecycle mutations with the exact task version', async () => {
    const { repository, close } = await makeHarness();
    try {
      await repository.savePool({ id: 'version-pool', visibility: 'platform', tags: {} });
      await repository.saveMachine({ id: 'version-machine', poolId: 'version-pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'hash' });
      await repository.saveTask(baseTask({ id: 'version-task' }));
      const claimed = (await taskService(repository).claim('worker-a', 'version-machine')).task;
      const guard = {
        claimId: claimed.claimId!,
        claimGeneration: claimed.claimGeneration!,
        taskVersion: claimed.taskVersion!,
        status: claimed.status
      };

      expect(await repository.replaceTaskForClaim({ ...claimed, status: 'running' }, guard)).toBe(true);
      expect(await repository.replaceTaskForClaim({ ...claimed, status: 'failed' }, guard)).toBe(false);
      expect(await repository.getTask(claimed.id)).toMatchObject({ status: 'running', taskVersion: guard.taskVersion + 1 });
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('rejects a delayed initial claimant after a later generation was requeued', async () => {
    const { repository, close } = await makeHarness();
    try {
      const submitted = baseTask({ id: 'delayed-claim-task' });
      await repository.saveTask(submitted);
      const delayedClaim = {
        ...submitted,
        status: 'claimed' as const,
        workerId: 'worker-delayed',
        machineId: 'machine-delayed',
        leaseToken: 'lease-delayed',
        leaseExpiresAt: '2026-09-08T12:01:00.000Z',
        claimId: 'claim-delayed',
        claimGeneration: 1,
        taskVersion: 1,
        claimCommitted: false,
        claimReleased: false,
        claimedAt: '2026-09-08T12:00:00.000Z',
        updatedAt: '2026-09-08T12:00:00.000Z'
      };
      const winner = await repository.claimTask({
        ...delayedClaim,
        workerId: 'worker-winner',
        machineId: 'machine-winner',
        leaseToken: 'lease-winner',
        claimId: 'claim-winner'
      }, 0, 0);
      expect(winner).toBeDefined();
      expect(await repository.replaceTaskForClaim({
        ...winner!,
        status: 'submitted',
        workerId: undefined,
        machineId: undefined,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        claimCommitted: false,
        claimReleased: true,
        queuePriority: -1
      }, {
        claimId: winner!.claimId!,
        claimGeneration: winner!.claimGeneration!,
        taskVersion: winner!.taskVersion!,
        status: winner!.status
      })).toBe(true);

      expect(await repository.claimTask(delayedClaim, 0, 0)).toBeUndefined();
      expect(await repository.getTask(submitted.id)).toMatchObject({
        status: 'submitted',
        claimId: 'claim-winner',
        claimGeneration: 1,
        taskVersion: 2,
        claimReleased: true
      });
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('fences a delayed initial claimant after a complete generation N+1 reclaim', async () => {
    const { repository, close } = await makeHarness();
    try {
      const clock = { value: 1_000 };
      await repository.savePool({ id: 'delayed-reclaim-pool', visibility: 'platform', tags: {} });
      await repository.saveMachine({
        id: 'delayed-reclaim-machine',
        poolId: 'delayed-reclaim-pool',
        tags: {},
        capacity: 2,
        activeLeases: 0,
        online: true,
        workerTokenHash: 'hash'
      });
      await repository.createProfile({ id: 'delayed-reclaim-profile', userId: 'user-1' });
      await repository.saveTask(baseTask({
        id: 'delayed-reclaim-task',
        profileId: 'delayed-reclaim-profile'
      }));
      const delayedAtCas = deferred();
      const resumeDelayed = deferred();
      const delayedRepository = new Proxy(repository, {
        get(target, property) {
          if (property === 'claimTask') {
            return async (...args: Parameters<Repository['claimTask']>): Promise<Awaited<ReturnType<Repository['claimTask']>>> => {
              delayedAtCas.resolve();
              await resumeDelayed.promise;
              return target.claimTask(...args);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      const delayed = taskService(delayedRepository, clock)
        .claim('delayed-worker', 'delayed-reclaim-machine', clock.value);
      await delayedAtCas.promise;

      const authority = taskService(repository, clock);
      const generationN = await authority.claim('generation-n-worker', 'delayed-reclaim-machine', clock.value);
      clock.value = 12_000;
      expect(await authority.expireLeases(clock.value)).toHaveLength(1);
      const generationNPlusOne = await authority.claim('generation-n-plus-one-worker', 'delayed-reclaim-machine', clock.value);
      expect(generationNPlusOne.task.claimGeneration).toBe((generationN.task.claimGeneration ?? 0) + 1);

      resumeDelayed.resolve();
      await expect(delayed).rejects.toMatchObject({ code: 'not_found' });
      expect(await repository.getTask('delayed-reclaim-task')).toMatchObject({
        status: 'claimed',
        workerId: 'generation-n-plus-one-worker',
        claimId: generationNPlusOne.task.claimId,
        claimGeneration: generationNPlusOne.task.claimGeneration
      });
      expect(await repository.getMachine('delayed-reclaim-machine')).toMatchObject({
        activeLeases: 1,
        leaseReservations: [expect.objectContaining({
          taskId: generationNPlusOne.task.id,
          claimId: generationNPlusOne.task.claimId,
          claimGeneration: generationNPlusOne.task.claimGeneration
        })]
      });
      expect(await repository.getProfile('delayed-reclaim-profile')).toMatchObject({
        lockedByTaskId: generationNPlusOne.task.id,
        lockedByClaimId: generationNPlusOne.task.claimId,
        lockedByClaimGeneration: generationNPlusOne.task.claimGeneration
      });
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('rejects a heartbeat mutation that reaches the claim CAS after lease expiry', async () => {
    const { repository, close } = await makeHarness();
    try {
      const admittedAt = Date.parse('1999-12-31T23:59:59.999Z');
      const submitted = baseTask({ id: 'expired-heartbeat-task' });
      await repository.saveTask(submitted);
      const claimed = await repository.claimTask({
        ...submitted,
        status: 'claimed',
        workerId: 'worker-a',
        machineId: 'machine-a',
        leaseToken: 'lease-a',
        leaseExpiresAt: '2000-01-01T00:00:00.000Z',
        claimId: 'claim-a',
        claimGeneration: 1,
        taskVersion: 1,
        claimCommitted: true,
        claimedAt: '1999-12-31T23:59:50.000Z',
        updatedAt: '1999-12-31T23:59:50.000Z'
      }, 0, 0);
      expect(claimed).toBeDefined();

      const heartbeatRead = deferred();
      const expiryBarrier = deferred();
      const renewal = (async () => {
        const current = (await repository.getTask('expired-heartbeat-task'))!;
        expect(Date.parse(current.leaseExpiresAt!)).toBeGreaterThan(admittedAt);
        heartbeatRead.resolve();
        await expiryBarrier.promise;
        return repository.replaceTaskForActiveClaim(
          { ...current, status: 'running', leaseExpiresAt: '2000-01-01T00:01:00.000Z' },
          {
            claimId: current.claimId!,
            claimGeneration: current.claimGeneration!,
            taskVersion: current.taskVersion!,
            status: current.status,
            leaseExpiresAt: current.leaseExpiresAt!
          }
        );
      })();

      await heartbeatRead.promise;
      expiryBarrier.resolve();
      expect(await renewal).toBe(false);
      expect(await repository.getTask('expired-heartbeat-task')).toMatchObject({
        status: 'claimed',
        leaseExpiresAt: '2000-01-01T00:00:00.000Z',
        taskVersion: 1
      });
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('retries an authorized cancellation after heartbeat wins the first task CAS', async () => {
    const { repository, close } = await makeHarness();
    try {
      const clock = { value: Date.now() };
      await repository.savePool({ id: 'cancel-race-pool', visibility: 'platform', tags: {} });
      await repository.saveMachine({ id: 'cancel-race-machine', poolId: 'cancel-race-pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'hash' });
      const cancelCasReached = deferred();
      const resumeCancelCas = deferred();
      let cancelAttempts = 0;
      let leaseReleases = 0;
      const raced = new Proxy<Repository>(repository, {
        get(target, property) {
          if (property === 'replaceTaskForClaim') {
            return async (...args: Parameters<Repository['replaceTaskForClaim']>): Promise<boolean> => {
              if (args[0].status === 'cancelled' && args[0].claimReleased !== true) {
                cancelAttempts += 1;
                if (cancelAttempts === 1) {
                  cancelCasReached.resolve();
                  await resumeCancelCas.promise;
                }
              }
              return target.replaceTaskForClaim(...args);
            };
          }
          if (property === 'releaseMachineLease') {
            return async (...args: Parameters<Repository['releaseMachineLease']>): Promise<boolean> => {
              leaseReleases += 1;
              return target.releaseMachineLease(...args);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      const service = taskService(raced, clock);
      const task = await service.createTask('cancel-race-user', { kind: 'browse', goal: 'cancel race' });
      const claim = await service.claim('cancel-race-worker', 'cancel-race-machine', clock.value);

      const cancellation = service.cancel(task.id, task.userId);
      await cancelCasReached.promise;
      await service.heartbeat(task.id, 'cancel-race-worker', claim.leaseToken, 30);
      resumeCancelCas.resolve();

      await expect(cancellation).resolves.toMatchObject({ status: 'cancelled', claimReleased: true });
      expect(cancelAttempts).toBe(2);
      expect(leaseReleases).toBe(1);
      expect(await repository.getMachine('cancel-race-machine')).toMatchObject({
        activeLeases: 0,
        leaseReservations: []
      });
      expect((await repository.listWebhooks()).filter((event) => event.payload.status === 'cancelled')).toHaveLength(1);
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('retries interactive close after heartbeat and preserves pending-action teardown', async () => {
    const { repository, close } = await makeHarness();
    try {
      const clock = { value: Date.now() };
      await repository.savePool({ id: 'close-race-pool', visibility: 'platform', tags: {} });
      await repository.saveMachine({ id: 'close-race-machine', poolId: 'close-race-pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'hash' });
      const closeCasReached = deferred();
      const resumeCloseCas = deferred();
      let closeAttempts = 0;
      const raced = new Proxy<Repository>(repository, {
        get(target, property) {
          if (property === 'replaceTaskForClaim') {
            return async (...args: Parameters<Repository['replaceTaskForClaim']>): Promise<boolean> => {
              if (args[0].status === 'closing') {
                closeAttempts += 1;
                if (closeAttempts === 1) {
                  closeCasReached.resolve();
                  await resumeCloseCas.promise;
                }
              }
              return target.replaceTaskForClaim(...args);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      const tasks = taskService(raced, clock);
      const sessions = new SessionService(tasks, raced, { clock: () => clock.value });
      const session = await sessions.create('close-race-user', { mode: 'act', constraints: {} });
      const claim = await tasks.claim('close-race-worker', 'close-race-machine', clock.value);
      const action = await sessions.sendAction(session.id, 'close-race-user', {
        type: 'screenshot',
        format: 'png',
        quality: 80
      }, 0);

      const closing = sessions.close(session.id, 'close-race-user');
      await closeCasReached.promise;
      await tasks.heartbeat(session.id, 'close-race-worker', claim.leaseToken, 30);
      resumeCloseCas.resolve();

      await expect(closing).resolves.toMatchObject({ status: 'closing', lastActionId: action.action_id });
      expect(closeAttempts).toBe(2);
      await expect(sessions.getAction(session.id, action.action_id, 'close-race-user', 0)).resolves.toMatchObject({
        status: 'completed',
        result: { error: { code: 'session_closed' } }
      });
      await expect(sessions.pollWorkerAction(session.id, 'close-race-worker', claim.leaseToken))
        .resolves.toEqual({ closing: true });
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('reconciles interrupted projections and fences a requeued generation', async () => {
    const { repository, close } = await makeHarness();
    try {
      const clock = { value: 1_000 };
      await repository.savePool({ id: 'reconcile-pool', visibility: 'platform', tags: {} });
      await repository.saveMachine({ id: 'reconcile-machine', poolId: 'reconcile-pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'hash' });
      await repository.createProfile({ id: 'reconcile-profile', userId: 'user-1' });
      const submitted = baseTask({ id: 'reconcile-task', profileId: 'reconcile-profile' });
      await repository.saveTask(submitted);
      const interrupted = await repository.claimTask({
        ...submitted,
        status: 'claimed',
        workerId: 'worker-a',
        machineId: 'reconcile-machine',
        leaseToken: 'lease-a',
        leaseExpiresAt: '1970-01-01T00:00:11.000Z',
        claimId: 'claim-a',
        claimGeneration: 1,
        taskVersion: 1,
        claimCommitted: false,
        claimedAt: '1970-01-01T00:00:01.000Z',
        updatedAt: '1970-01-01T00:00:01.000Z'
      }, 0, 0);
      expect(interrupted).toBeDefined();
      const service = taskService(repository, clock);
      await service.reconcileClaims();
      expect(await repository.getMachine('reconcile-machine')).toMatchObject({ activeLeases: 1 });
      expect(await repository.getProfile('reconcile-profile')).toMatchObject({ lockedByClaimId: 'claim-a' });

      const claimed = (await repository.getTask('reconcile-task'))!;
      expect(await repository.replaceTaskForClaim({
        ...claimed,
        status: 'submitted',
        workerId: undefined,
        machineId: undefined,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        queuePriority: -1
      }, { claimId: 'claim-a', claimGeneration: 1, taskVersion: claimed.taskVersion ?? 0, status: 'claimed' })).toBe(true);

      const restarted = taskService(repository, clock);
      await restarted.reconcileClaims();
      expect(await repository.getMachine('reconcile-machine')).toMatchObject({ activeLeases: 0, leaseReservations: [] });
      expect(await repository.getProfile('reconcile-profile')).not.toHaveProperty('lockedByTaskId');

      clock.value = 12_000;
      const reclaimed = await restarted.claim('worker-b', 'reconcile-machine', 12_000);
      expect(reclaimed.task.claimGeneration).toBe(2);
      await expect(restarted.heartbeat('reconcile-task', 'worker-a', 'lease-a', 10)).rejects.toMatchObject({ code: 'unauthorized' });
      expect(await repository.getMachine('reconcile-machine')).toMatchObject({ activeLeases: 1 });
      expect(await repository.getProfile('reconcile-profile')).toMatchObject({ lockedByClaimId: reclaimed.task.claimId });
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('does not let a stale generation reconciler remove generation N+1 projections', async () => {
    const { repository, close } = await makeHarness();
    try {
      const clock = { value: Date.now() - 30_000 };
      await repository.savePool({ id: 'stale-reconcile-pool', visibility: 'platform', tags: {} });
      await repository.saveMachine({
        id: 'stale-reconcile-machine',
        poolId: 'stale-reconcile-pool',
        tags: {},
        capacity: 2,
        activeLeases: 0,
        online: true,
        workerTokenHash: 'hash'
      });
      await repository.createProfile({ id: 'stale-reconcile-profile', userId: 'user-1' });
      await repository.saveTask(baseTask({ id: 'stale-reconcile-task', profileId: 'stale-reconcile-profile' }));
      const authority = taskService(repository, clock);
      const generationN = await authority.claim('stale-reconcile-worker-n', 'stale-reconcile-machine', clock.value);

      const staleAtReservation = deferred();
      const resumeStale = deferred();
      const staleReservationPersisted = deferred();
      const returnStaleReservation = deferred();
      let paused = false;
      let staleReservationResult: boolean | undefined;
      let staleReservationError: unknown;
      const staleRepository = new Proxy(repository, {
        get(target, property) {
          if (property === 'reserveMachineLease') {
            return async (...args: Parameters<Repository['reserveMachineLease']>): Promise<boolean> => {
              const reservation = args[1];
              if (!paused && reservation.claimId === generationN.task.claimId) {
                paused = true;
                staleAtReservation.resolve();
                await resumeStale.promise;
                try {
                  staleReservationResult = await target.reserveMachineLease(...args);
                } catch (error) {
                  staleReservationError = error;
                } finally {
                  staleReservationPersisted.resolve();
                }
                await returnStaleReservation.promise;
                if (staleReservationError !== undefined) throw staleReservationError;
                return staleReservationResult ?? false;
              }
              return target.reserveMachineLease(...args);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      const staleReconciliation = taskService(staleRepository, { value: Date.now() }).reconcileClaims(Date.now());
      await staleAtReservation.promise;

      clock.value = Date.now();
      expect(await authority.expireLeases(clock.value)).toHaveLength(1);
      clock.value = Date.now() + 600_000;
      const generationNPlusOne = await authority.claim('stale-reconcile-worker-n-plus-one', 'stale-reconcile-machine', clock.value);
      expect(generationNPlusOne.task.claimGeneration).toBe((generationN.task.claimGeneration ?? 0) + 1);
      const cursorBeforeStaleResume = await repository.getTaskMaintenanceCursor('task-claim-reconciliation');
      expect(cursorBeforeStaleResume).toMatchObject({ id: 'task-claim-reconciliation' });
      if (cursorBeforeStaleResume === undefined) throw new Error('authoritative maintenance cursor missing');
      expect(cursorBeforeStaleResume.version).toBeGreaterThan(0);
      expect(await repository.getMachine('stale-reconcile-machine')).toMatchObject({
        activeLeases: 1,
        leaseReservations: [{
          taskId: 'stale-reconcile-task',
          claimId: generationNPlusOne.task.claimId,
          claimGeneration: generationNPlusOne.task.claimGeneration,
          expiresAt: generationNPlusOne.task.leaseExpiresAt
        }]
      });

      resumeStale.resolve();
      await staleReservationPersisted.promise;
      let temporaryMachine: Awaited<ReturnType<Repository['getMachine']>>;
      let observationError: unknown;
      try {
        temporaryMachine = await repository.getMachine('stale-reconcile-machine');
      } catch (error) {
        observationError = error;
      } finally {
        returnStaleReservation.resolve();
      }
      await staleReconciliation;
      if (observationError !== undefined) throw observationError;
      expect(staleReservationError).toBeUndefined();
      expect(staleReservationResult).toBe(true);
      expect(temporaryMachine).toMatchObject({ activeLeases: 2 });
      expect(temporaryMachine?.leaseReservations).toHaveLength(2);
      expect(temporaryMachine?.leaseReservations).toEqual(expect.arrayContaining([
        {
          taskId: 'stale-reconcile-task',
          claimId: generationN.task.claimId,
          claimGeneration: generationN.task.claimGeneration,
          expiresAt: generationN.task.leaseExpiresAt
        },
        {
          taskId: 'stale-reconcile-task',
          claimId: generationNPlusOne.task.claimId,
          claimGeneration: generationNPlusOne.task.claimGeneration,
          expiresAt: generationNPlusOne.task.leaseExpiresAt
        }
      ]));

      expect(await repository.getTask('stale-reconcile-task')).toMatchObject({
        status: 'claimed',
        claimId: generationNPlusOne.task.claimId,
        claimGeneration: generationNPlusOne.task.claimGeneration,
        workerId: 'stale-reconcile-worker-n-plus-one'
      });
      expect(await repository.getMachine('stale-reconcile-machine')).toMatchObject({
        activeLeases: 1,
        leaseReservations: [{
          taskId: 'stale-reconcile-task',
          claimId: generationNPlusOne.task.claimId,
          claimGeneration: generationNPlusOne.task.claimGeneration,
          expiresAt: generationNPlusOne.task.leaseExpiresAt
        }]
      });
      expect(await repository.getProfile('stale-reconcile-profile')).toMatchObject({
        lockedByTaskId: 'stale-reconcile-task',
        lockedByClaimId: generationNPlusOne.task.claimId,
        lockedByClaimGeneration: generationNPlusOne.task.claimGeneration
      });
      expect(await repository.getTaskMaintenanceCursor('task-claim-reconciliation'))
        .toEqual(cursorBeforeStaleResume);
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('fences generation N action operations after N+1 reclaims the original action', async () => {
    const { repository, close } = await makeHarness();
    try {
      const clock = { value: Date.now() - 30_000 };
      await repository.savePool({ id: 'action-reclaim-pool', visibility: 'platform', tags: {} });
      await repository.saveMachine({
        id: 'action-reclaim-machine',
        poolId: 'action-reclaim-pool',
        tags: {},
        capacity: 1,
        activeLeases: 0,
        online: true,
        workerTokenHash: 'hash'
      });
      await repository.createProfile({ id: 'action-reclaim-profile', userId: 'user-1' });
      const tasks = taskService(repository, clock);
      const sessions = new SessionService(tasks, repository, { clock: () => clock.value });
      const session = await sessions.create('user-1', {
        profile_id: 'action-reclaim-profile',
        mode: 'act',
        constraints: {}
      });
      const generationN = await tasks.claim('action-reclaim-worker-n', 'action-reclaim-machine', clock.value);
      const pending = await sessions.sendAction(session.id, 'user-1', { type: 'wait', milliseconds: 1 }, 0);
      expect((await sessions.pollWorkerAction(session.id, 'action-reclaim-worker-n', generationN.leaseToken)).action?.id)
        .toBe(pending.action_id);

      clock.value = Date.now();
      expect(await tasks.expireLeases(clock.value)).toHaveLength(1);
      const generationNPlusOne = await tasks.claim('action-reclaim-worker-n-plus-one', 'action-reclaim-machine', clock.value);
      expect(generationNPlusOne.task.claimGeneration).toBe((generationN.task.claimGeneration ?? 0) + 1);

      await expect(sessions.pollWorkerAction(session.id, 'action-reclaim-worker-n', generationN.leaseToken))
        .rejects.toMatchObject({ code: 'unauthorized' });
      await expect(sessions.saveWorkerResult(
        session.id,
        pending.action_id,
        'action-reclaim-worker-n',
        generationN.leaseToken,
        { value: 'stale' },
        'action-reclaim-machine'
      )).rejects.toMatchObject({ code: 'unauthorized' });
      expect(await repository.getSessionActionResult(pending.action_id)).toBeUndefined();
      expect(await repository.getPendingSessionAction(session.id)).toMatchObject({
        id: pending.action_id,
        state: 'pending'
      });

      expect((await sessions.pollWorkerAction(session.id, 'action-reclaim-worker-n-plus-one', generationNPlusOne.leaseToken)).action?.id)
        .toBe(pending.action_id);
      await sessions.saveWorkerResult(
        session.id,
        pending.action_id,
        'action-reclaim-worker-n-plus-one',
        generationNPlusOne.leaseToken,
        { value: 'generation-n-plus-one' },
        'action-reclaim-machine'
      );
      await expect(sessions.getAction(session.id, pending.action_id, 'user-1', 0)).resolves.toEqual({
        action_id: pending.action_id,
        status: 'completed',
        result: { value: 'generation-n-plus-one' }
      });
      expect(await repository.getMachine('action-reclaim-machine')).toMatchObject({
        activeLeases: 1,
        leaseReservations: [expect.objectContaining({
          taskId: session.id,
          claimId: generationNPlusOne.task.claimId,
          claimGeneration: generationNPlusOne.task.claimGeneration
        })]
      });
      expect(await repository.getProfile('action-reclaim-profile')).toMatchObject({
        lockedByTaskId: session.id,
        lockedByClaimId: generationNPlusOne.task.claimId,
        lockedByClaimGeneration: generationNPlusOne.task.claimGeneration
      });
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('recovers legacy machine and profile accounting without changing modern reservations', async () => {
    const { repository, close } = await makeHarness();
    try {
      const modernReservation = {
        taskId: 'modern-task',
        claimId: 'modern-claim',
        claimGeneration: 3,
        expiresAt: '2026-09-08T12:10:00.000Z'
      };
      await repository.saveMachine({
        id: 'legacy-machine',
        poolId: 'pool',
        tags: {},
        capacity: 2,
        activeLeases: 2,
        leaseReservations: [modernReservation],
        online: true,
        workerTokenHash: 'hash'
      });
      await repository.createProfile({
        id: 'legacy-profile',
        userId: 'user-1',
        machineId: 'legacy-machine',
        lockedByTaskId: 'legacy-task',
        lockExpiresAt: '2026-09-08T12:10:00.000Z'
      });
      await repository.saveTask(baseTask({
        id: 'legacy-task',
        status: 'running',
        machineId: 'legacy-machine',
        profileId: 'legacy-profile',
        workerId: 'legacy-worker',
        leaseToken: 'legacy-token',
        leaseExpiresAt: '2026-09-08T12:10:00.000Z',
        queuePriority: 7
      }));

      const service = taskService(repository);
      await service.reconcileClaims();
      expect(await repository.getTask('legacy-task')).toMatchObject({
        status: 'submitted',
        queuePriority: 7
      });
      expect((await repository.getTask('legacy-task'))?.claimRecovery).toBeUndefined();
      expect((await repository.getTask('legacy-task'))?.machineId).toBeUndefined();
      expect(await repository.getMachine('legacy-machine')).toMatchObject({
        activeLeases: 1,
        leaseReservations: [modernReservation]
      });
      expect(await repository.getProfile('legacy-profile')).toMatchObject({
        machineId: 'legacy-machine'
      });
      expect((await repository.getProfile('legacy-profile'))?.lockedByTaskId).toBeUndefined();

      await service.reconcileClaims();
      expect(await repository.getMachine('legacy-machine')).toMatchObject({
        activeLeases: 1,
        leaseReservations: [modernReservation]
      });
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('requeues legacy interactive actions but terminalizes legacy closing actions', async () => {
    const { repository, close } = await makeHarness();
    try {
      await repository.saveTask(baseTask({
        id: 'legacy-interactive',
        interaction: 'interactive',
        status: 'running',
        workerId: 'legacy-worker',
        leaseToken: 'legacy-token',
        pendingActionId: 'action-requeue',
        createdAt: '2025-01-01T00:00:00.000Z'
      }));
      await repository.saveTask(baseTask({
        id: 'legacy-closing',
        interaction: 'interactive',
        status: 'closing',
        workerId: 'legacy-worker',
        leaseToken: 'legacy-token',
        pendingActionId: 'action-close',
        createdAt: '2025-01-01T00:00:01.000Z'
      }));
      await repository.enqueueSessionAction({
        id: 'action-requeue',
        taskId: 'legacy-interactive',
        action: { type: 'navigate', url: 'https://example.com/requeue' },
        state: 'pending',
        createdAt: '2025-01-01T00:00:00.000Z'
      });
      await repository.enqueueSessionAction({
        id: 'action-close',
        taskId: 'legacy-closing',
        action: { type: 'navigate', url: 'https://example.com/close' },
        state: 'pending',
        createdAt: '2025-01-01T00:00:01.000Z'
      });
      await repository.takePendingSessionAction('legacy-interactive');
      await repository.takePendingSessionAction('legacy-closing');

      await taskService(repository).reconcileClaims();
      expect(await repository.getTask('legacy-interactive')).toMatchObject({ status: 'submitted' });
      expect(await repository.getPendingSessionAction('legacy-interactive')).toMatchObject({
        id: 'action-requeue',
        state: 'pending'
      });
      expect(await repository.getTask('legacy-closing')).toMatchObject({ status: 'completed' });
      expect((await repository.getTask('legacy-closing'))?.pendingActionId).toBeUndefined();
      expect(await repository.getPendingSessionAction('legacy-closing')).toBeUndefined();
      expect(await repository.getSessionActionResult('action-close')).toMatchObject({
        taskId: 'legacy-closing',
        result: { error: { code: 'session_closed' } }
      });
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('quarantines malformed claims without preventing later legacy recovery', async () => {
    const { repository, close } = await makeHarness();
    try {
      await repository.saveTask(baseTask({
        id: 'malformed-claim',
        status: 'claimed',
        claimId: 'malformed-id',
        claimGeneration: 0,
        machineId: 'unknown-machine',
        workerId: 'malformed-worker',
        leaseToken: 'malformed-token',
        leaseExpiresAt: '1970-01-01T00:00:00.000Z',
        createdAt: '2025-01-01T00:00:00.000Z'
      }));
      await repository.saveTask(baseTask({
        id: 'invalid-expiry',
        status: 'claimed',
        claimId: 'invalid-expiry-claim',
        claimGeneration: 1,
        machineId: 'unknown-machine',
        workerId: 'invalid-expiry-worker',
        leaseToken: 'invalid-expiry-token',
        leaseExpiresAt: 'not-a-timestamp',
        createdAt: '2025-01-01T00:00:00.500Z'
      }));
      await repository.saveTask(baseTask({
        id: 'invalid-credentials',
        status: 'claimed',
        claimId: '',
        claimGeneration: 1,
        machineId: 'unknown-machine',
        workerId: 'invalid-credentials-worker',
        leaseToken: 'invalid-credentials-token',
        leaseExpiresAt: '2026-09-08T12:10:00.000Z',
        createdAt: '2025-01-01T00:00:00.750Z'
      }));
      await repository.saveTask(baseTask({
        id: 'later-legacy',
        status: 'running',
        workerId: 'legacy-worker',
        leaseToken: 'legacy-token',
        createdAt: '2025-01-01T00:00:01.000Z'
      }));

      await taskService(repository).reconcileClaims();
      expect(await repository.getTask('malformed-claim')).toMatchObject({
        status: 'failed',
        error: { code: 'claim_state_malformed' },
        claimRecovery: {
          kind: 'malformed',
          phase: 'quarantined',
          reasonCode: 'invalid_claim_generation'
        }
      });
      expect(await repository.getTask('invalid-expiry')).toMatchObject({
        status: 'failed',
        claimRecovery: { reasonCode: 'invalid_lease_expiry', phase: 'quarantined' }
      });
      expect(await repository.getTask('invalid-credentials')).toMatchObject({
        status: 'failed',
        claimRecovery: { reasonCode: 'invalid_claim_credentials', phase: 'quarantined' }
      });
      expect(await repository.getTask('later-legacy')).toMatchObject({ status: 'submitted' });
      expect((await repository.getTask('later-legacy'))?.claimRecovery).toBeUndefined();
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('drains exact projections even when a malformed active claim says it was released', async () => {
    const { repository, close } = await makeHarness();
    try {
      const reservation = {
        taskId: 'false-released-task',
        claimId: 'false-released-claim',
        claimGeneration: 4,
        expiresAt: '2026-09-08T12:10:00.000Z'
      };
      await repository.saveMachine({
        id: 'false-released-machine',
        poolId: 'pool',
        tags: {},
        capacity: 1,
        activeLeases: 1,
        leaseReservations: [reservation],
        online: true,
        workerTokenHash: 'hash'
      });
      await repository.createProfile({
        id: 'false-released-profile',
        userId: 'user-1',
        machineId: 'false-released-machine',
        lockedByTaskId: reservation.taskId,
        lockedByClaimId: reservation.claimId,
        lockedByClaimGeneration: reservation.claimGeneration,
        lockExpiresAt: reservation.expiresAt
      });
      await repository.saveTask(baseTask({
        id: reservation.taskId,
        status: 'claimed',
        profileId: 'false-released-profile',
        machineId: 'false-released-machine',
        workerId: 'false-released-worker',
        leaseToken: 'false-released-token',
        leaseExpiresAt: reservation.expiresAt,
        claimId: reservation.claimId,
        claimGeneration: reservation.claimGeneration,
        claimCommitted: true,
        claimReleased: true
      }));

      const service = taskService(repository);
      await service.reconcileClaims();
      expect(await repository.getTask(reservation.taskId)).toMatchObject({
        status: 'failed',
        claimRecovery: {
          kind: 'malformed',
          phase: 'quarantined',
          reasonCode: 'active_claim_marked_released'
        }
      });
      expect(await repository.getMachine('false-released-machine')).toMatchObject({
        activeLeases: 0,
        leaseReservations: []
      });
      expect((await repository.getProfile('false-released-profile'))?.lockedByTaskId).toBeUndefined();

      await service.reconcileClaims();
      expect(await repository.getMachine('false-released-machine')).toMatchObject({
        activeLeases: 0,
        leaseReservations: []
      });
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('advances durable maintenance past one full batch', async () => {
    const { repository, close } = await makeHarness();
    try {
      for (let index = 0; index < 100; index += 1) {
        await repository.saveTask(baseTask({
          id: `healthy-${String(index).padStart(3, '0')}`,
          createdAt: '2025-01-01T00:00:00.000Z'
        }));
      }
      await repository.saveTask(baseTask({
        id: 'legacy-after-full-batch',
        status: 'running',
        workerId: 'legacy-worker',
        leaseToken: 'legacy-token',
        createdAt: '2025-01-01T00:00:01.000Z'
      }));
      const service = taskService(repository);

      await service.reconcileClaims();
      expect(await repository.getTask('legacy-after-full-batch')).toMatchObject({ status: 'running' });
      await service.reconcileClaims();
      expect(await repository.getTask('legacy-after-full-batch')).toMatchObject({ status: 'submitted' });
      expect((await repository.getTask('legacy-after-full-batch'))?.claimRecovery).toBeUndefined();
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('reconciles a reservation when the task machine pointer is stale', async () => {
    const { repository, close } = await makeHarness();
    try {
      await repository.saveMachine({
        id: 'reservation-machine',
        poolId: 'pool',
        tags: {},
        capacity: 1,
        activeLeases: 0,
        online: true,
        workerTokenHash: 'hash'
      });
      const submitted = baseTask({ id: 'stale-machine-pointer-task' });
      await repository.saveTask(submitted);
      const claimed = (await repository.claimTask({
        ...submitted,
        status: 'claimed',
        workerId: 'worker-a',
        machineId: 'stale-machine-pointer',
        leaseToken: 'lease-a',
        leaseExpiresAt: '1970-01-01T00:00:11.000Z',
        claimId: 'claim-a',
        claimGeneration: 1,
        taskVersion: 1,
        claimCommitted: true,
        claimedAt: '1970-01-01T00:00:01.000Z',
        updatedAt: '1970-01-01T00:00:01.000Z'
      }, 0, 0))!;
      const reservation = {
        taskId: claimed.id,
        claimId: claimed.claimId!,
        claimGeneration: claimed.claimGeneration!,
        expiresAt: claimed.leaseExpiresAt!
      };
      expect(await repository.reserveMachineLease('reservation-machine', reservation)).toBe(true);
      expect(await repository.replaceTaskForClaim({
        ...claimed,
        status: 'submitted',
        workerId: undefined,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        queuePriority: -1
      }, {
        claimId: claimed.claimId!,
        claimGeneration: claimed.claimGeneration!,
        taskVersion: claimed.taskVersion!,
        status: claimed.status
      })).toBe(true);

      const service = taskService(repository);
      await service.reconcileClaims();
      expect(await repository.getMachine('reservation-machine')).toMatchObject({
        activeLeases: 0,
        leaseReservations: []
      });
      expect(await repository.getTask(claimed.id)).toMatchObject({ claimReleased: true });

      await service.reconcileClaims();
      expect(await repository.getMachine('reservation-machine')).toMatchObject({
        activeLeases: 0,
        leaseReservations: []
      });
    } finally {
      await close();
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('round-trips registry entities and task state', async () => {
    const { repository, close } = await makeHarness();
    try {
      await repository.savePool({ id: 'pool-1', visibility: 'org', ownerUserId: 'user-1', sharedWithGroups: ['eng'], tags: { os: 'linux' } });
      await repository.saveMachine({ id: 'machine-1', poolId: 'pool-1', tags: { browser: true }, capacity: 2, activeLeases: 0, online: true, workerTokenHash: 'hash' });
      await repository.createProfile({ id: 'profile-1', userId: 'user-1', machineId: 'machine-1' });
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

  it('continues the durable maintenance cursor after a real repository reconnect', async () => {
    if (mongoUrl === undefined) throw new Error('Mongo contract setup did not provide a database URL');
    const databaseName = `talos_restart_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const firstClient = new MongoClient(mongoUrl, mongodbClientOptions);
    const first = new MongoRepository(mongoUrl, databaseName, { client: firstClient });
    let firstClosed = false;
    let secondClient: MongoClient | undefined;
    let second: MongoRepository | undefined;
    try {
      await first.initialize();
      for (let index = 0; index < 100; index += 1) {
        await first.saveTask(baseTask({
          id: `restart-healthy-${String(index).padStart(3, '0')}`,
          createdAt: '2025-01-01T00:00:00.000Z'
        }));
      }
      await first.saveTask(baseTask({
        id: 'restart-legacy-after-batch',
        status: 'running',
        workerId: 'legacy-worker',
        leaseToken: 'legacy-token',
        createdAt: '2025-01-01T00:00:01.000Z'
      }));
      await taskService(first).reconcileClaims();
      expect(await first.getTask('restart-legacy-after-batch')).toMatchObject({ status: 'running' });

      await first.close();
      firstClosed = true;
      secondClient = new MongoClient(mongoUrl, mongodbClientOptions);
      second = new MongoRepository(mongoUrl, databaseName, { client: secondClient });
      await second.initialize();
      await taskService(second).reconcileClaims();

      expect(await second.getTask('restart-legacy-after-batch')).toMatchObject({ status: 'submitted' });
      expect((await second.getTask('restart-legacy-after-batch'))?.claimRecovery).toBeUndefined();
    } finally {
      if (!firstClosed) await first.close();
      if (secondClient !== undefined) {
        try {
          await secondClient.db(databaseName).dropDatabase();
        } finally {
          await second?.close();
        }
      }
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);

  it('bounds expiry query work to the requested pages instead of the expired backlog', async () => {
    if (mongoUrl === undefined) throw new Error('Mongo contract setup did not provide a database URL');
    const databaseName = `talos_expiry_plan_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const client = new MongoClient(mongoUrl, { ...mongodbClientOptions, monitorCommands: true });
    const repository = new MongoRepository(mongoUrl, databaseName, { client });
    const findCommands: MongoDocument[] = [];
    client.on('commandStarted', (event) => {
      if (event.commandName === 'find' && event.command.find === 'tasks') {
        findCommands.push({
          find: event.command.find,
          filter: event.command.filter,
          sort: event.command.sort,
          limit: event.command.limit
        });
      }
    });
    try {
      await repository.initialize();
      const expiryBase = Date.parse('2025-01-01T00:00:00.000Z');
      const documents = Array.from({ length: EXPIRY_QUERY_BACKLOG_SIZE }, (_, index) => {
        const submitted = index % 2 === 0;
        const id = `expiry-plan-${String(index).padStart(4, '0')}`;
        const expiredAt = new Date(expiryBase + (EXPIRY_QUERY_BACKLOG_SIZE - index) * 1_000).toISOString();
        return {
          ...baseTask({
            id,
            kind: index % 4 < 2 ? 'browse' : 'computer_use',
            status: submitted ? 'submitted' : (['claimed', 'running', 'closing'] as const)[index % 3],
            constraints: submitted ? { deadline: expiredAt } : {},
            ...(submitted ? {} : { leaseExpiresAt: expiredAt })
          }),
          _id: id
        };
      });
      await client.db(databaseName).collection<{ _id: string; [key: string]: unknown }>('tasks').insertMany(documents);

      expect(await repository.listExpirableTasks(Date.parse('2026-01-01T00:00:00.000Z'), EXPIRY_QUERY_BATCH_SIZE))
        .toHaveLength(EXPIRY_QUERY_BATCH_SIZE);
      expect(findCommands).toHaveLength(2);

      const expectedQueries = [
        { sortField: 'constraints.deadline', indexName: 'task-deadline-expiry-v1' },
        { sortField: 'leaseExpiresAt', indexName: 'task-lease-expiry-v1' }
      ] as const;
      for (const expected of expectedQueries) {
        const command = findCommands.find((candidate) => {
          const filter = candidate.filter;
          return typeof filter === 'object' && filter !== null && Object.hasOwn(filter, expected.sortField);
        });
        if (command === undefined) throw new Error(`missing captured ${expected.sortField} expiry query`);
        expect(command).toMatchObject({ find: 'tasks', limit: EXPIRY_QUERY_BATCH_SIZE });
        expect(normalizedMongoSort(command.sort)).toEqual({ [expected.sortField]: 1, _id: 1 });
        const explanation = await client.db(databaseName).command({ explain: command, verbosity: 'executionStats' });
        const executionStats = explanation.executionStats as {
          nReturned: number;
          totalDocsExamined: number;
          totalKeysExamined: number;
          executionStages: unknown;
        };
        expect(executionStats.nReturned).toBe(EXPIRY_QUERY_BATCH_SIZE);
        expect(executionStats.totalDocsExamined).toBeLessThanOrEqual(EXPIRY_QUERY_BATCH_SIZE * 8);
        expect(executionStats.totalKeysExamined).toBeLessThanOrEqual(EXPIRY_QUERY_BATCH_SIZE * 8);
        expect(executionPlanContainsStage(executionStats.executionStages, 'SORT')).toBe(false);
        expect(executionPlanContainsStage(executionStats.executionStages, 'COLLSCAN')).toBe(false);
        expect(executionPlanContainsValue(executionStats.executionStages, expected.indexName)).toBe(true);
      }
    } finally {
      try {
        await client.db(databaseName).dropDatabase();
      } finally {
        await repository.close();
      }
    }
  }, MONGODB_CONTRACT_TEST_TIMEOUT_MS);
});
