import { describe, expect, it } from 'vitest';
import type { MongoClient } from 'mongodb';
import { digestJson } from '@talos/testing-protocol';
import { TestingRunService } from '../services/testing-run-service.js';
import { submitTestingRun } from '../test-support/testing-transport.js';
import type { TestingRunRecord } from '../domain/testing-types.js';
import { MemoryRepository } from './memory-repository.js';
import { MongoRepository } from './mongo-repository.js';
import {
  provisionTestingPool,
  testTestingPlacementInputVerifier,
  testTestingPlacementPolicy
} from '../test-support/testing-placement.js';

type FakeDocument = { _id: string; [key: string]: unknown };

class FakeCollection {
  public readonly indexes: Array<{ keys: Readonly<Record<string, number>>; options?: Readonly<Record<string, unknown>> }> = [];
  private readonly documents = new Map<string, FakeDocument>();

  public async createIndex(
    keys: Readonly<Record<string, number>>,
    options?: Readonly<Record<string, unknown>>
  ): Promise<string> {
    this.indexes.push({ keys, ...(options === undefined ? {} : { options }) });
    return `index-${this.indexes.length}`;
  }

  public async insertOne(document: FakeDocument): Promise<{ acknowledged: true; insertedId: string }> {
    const duplicateUniqueIndex = this.indexes
      .filter((index) => index.options?.unique === true)
      .some((index) => [...this.documents.values()].some((candidate) =>
        Object.keys(index.keys).every((key) => candidate[key] === document[key])));
    if (this.documents.has(document._id) || duplicateUniqueIndex) throw { code: 11000 };
    this.documents.set(document._id, structuredClone(document));
    return { acknowledged: true, insertedId: document._id };
  }

  public find(filter: Readonly<Record<string, unknown>>): {
    sort: () => { toArray: () => Promise<FakeDocument[]> };
    toArray: () => Promise<FakeDocument[]>;
  } {
    const toArray = async (): Promise<FakeDocument[]> => [...this.documents.values()]
      .filter((candidate) => Object.entries(filter).every(([key, value]) => candidate[key] === value))
      .map((document) => structuredClone(document));
    return { sort: () => ({ toArray }), toArray };
  }

  public async findOne(filter: Readonly<Record<string, unknown>>): Promise<FakeDocument | null> {
    const document = [...this.documents.values()].find((candidate) =>
      matchesFilter(candidate, filter));
    return document === undefined ? null : structuredClone(document);
  }

  public async replaceOne(
    filter: Readonly<Record<string, unknown>>,
    replacement: FakeDocument
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const current = await this.findOne(filter);
    if (current === null) return { matchedCount: 0, modifiedCount: 0 };
    this.documents.set(replacement._id, structuredClone(replacement));
    return { matchedCount: 1, modifiedCount: 1 };
  }

  public async deleteOne(filter: Readonly<Record<string, unknown>>): Promise<{ deletedCount: number }> {
    const current = await this.findOne(filter);
    if (current === null) return { deletedCount: 0 };
    this.documents.delete(current._id);
    return { deletedCount: 1 };
  }
}

const matchesFilter = (
  candidate: Readonly<Record<string, unknown>>,
  filter: Readonly<Record<string, unknown>>
): boolean => Object.entries(filter).every(([key, value]) => {
  if (key === '$expr') return matchesExpression(candidate, value);
  if (typeof value === 'object' && value !== null && '$elemMatch' in value) {
    const items = candidate[key];
    return Array.isArray(items) && items.some((item) =>
      typeof item === 'object' && item !== null &&
      matchesFilter(item as Readonly<Record<string, unknown>>, value.$elemMatch as Readonly<Record<string, unknown>>));
  }
  return dottedValue(candidate, key) === value;
});

const matchesExpression = (candidate: Readonly<Record<string, unknown>>, input: unknown): boolean => {
  if (typeof input !== 'object' || input === null) return false;
  if ('$and' in input) {
    return Array.isArray(input.$and) && input.$and.every((expression) => matchesExpression(candidate, expression));
  }
  if (!('$gt' in input) || !Array.isArray(input.$gt) || input.$gt.length !== 2 || input.$gt[1] !== '$$NOW') {
    return false;
  }
  const operand = input.$gt[0] as { $convert?: { input?: unknown; to?: unknown; onError?: unknown; onNull?: unknown } };
  const conversion = operand.$convert;
  if (conversion?.to !== 'date' || conversion.onError !== null || conversion.onNull !== null) return false;
  const dateInput = conversion.input;
  const dateValue = typeof dateInput === 'string' && dateInput.startsWith('$')
    ? dottedValue(candidate, dateInput.slice(1))
    : typeof dateInput === 'object' && dateInput !== null && '$literal' in dateInput
      ? dateInput.$literal
      : undefined;
  return typeof dateValue === 'string' &&
    Date.parse(dateValue) > Date.parse('2026-08-22T00:00:00.000Z');
};

const dottedValue = (candidate: Readonly<Record<string, unknown>>, path: string): unknown =>
  path.split('.').reduce<unknown>((value, part) =>
    typeof value === 'object' && value !== null
      ? (value as Readonly<Record<string, unknown>>)[part]
      : undefined, candidate);

class FakeDatabase {
  private readonly collections = new Map<string, FakeCollection>();

  public collection(name: string): FakeCollection {
    const existing = this.collections.get(name);
    if (existing !== undefined) return existing;
    const collection = new FakeCollection();
    this.collections.set(name, collection);
    return collection;
  }
}

class FakeMongoClient {
  public readonly database = new FakeDatabase();

  public db(): FakeDatabase { return this.database; }
  public async connect(): Promise<this> { return this; }
  public async close(): Promise<void> {}
}

const makeTestingRun = async (): Promise<TestingRunRecord> => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const reference = (schema: string, ref: string) => ({ schema, ref, digest });
  const policy = {
    network_scope: 'environment_owned_loopback_exact_origins' as const,
    environment_port_handle_policy: {
      source: 'current_run_owned_handles' as const,
      allow_unowned_loopback: false as const
    },
    allowed_actions: ['navigate' as const],
    allowed_evidence_media: ['image/png' as const],
    secret_refs: [],
    budgets: {
      wall_time_ms: 600_000,
      max_cases: 20,
      max_actions: 200,
      max_events: 2_000,
      max_screenshots: 20,
      max_screenshot_bytes: 5_242_880,
      max_json_evidence_bytes: 1_048_576,
      max_total_artifact_bytes: 52_428_800
    }
  };
  const memory = new MemoryRepository();
  await provisionTestingPool(memory);
  const service = new TestingRunService(memory, {
    cursorSecret: 'mongo-double-cursor-secret-1234',
    clock: () => Date.parse('2026-08-22T00:00:00.000Z'),
    placementPolicy: testTestingPlacementPolicy(),
    placementInputVerifier: testTestingPlacementInputVerifier()
  });
  await submitTestingRun(service, 'run-mongo', 'user-1', {
    schema_version: 'talos.testing-tool-request/v1',
    request_id: 'request:run-mongo',
    client_correlation_id: 'client:run-mongo',
    idempotency_key: 'mongo-submit-key',
    display_goal: 'Mongo repository double',
    inputs: {
      schema_version: 'talos.testing-input-references/v1',
      project_pack_snapshot: reference('pql.project-pack-snapshot/v1', 'artifact://pql/project-pack-snapshot/snapshot-1'),
      test_selection: reference('pql.test-selection/v1', 'artifact://pql/test-selection/selection-1'),
      testing_design_input_set: reference('pql.testing-design-input-set.v1', 'artifact://pql/testing-design-input-set/input-1'),
      source_revision: {
        repository_id: 'repo-1',
        exact_revision: '0123456789abcdef0123456789abcdef01234567',
        ref: 'artifact://source/revision-1',
        digest
      },
      structured_plan: reference('testing-structured-plan.v2', 'artifact://plans/plan-1'),
      environment_profile: { ref: 'artifact://environments/environment-1', digest },
      testing_package: { package_id: 'testing-browser-runner', version: '1.0', digest }
    },
    execution_profile: 'local_qa_agent_mvp',
    placement_requirements: { testing_runtime: 'local-qa-mvp/v1' },
    policy_binding: {
      policy: {
        schema: 'talos.testing-execution-policy/v1',
        ref: 'talos://policies/testing/policy-1',
        digest: digestJson(policy)
      },
      budgets: {
        schema: 'talos.testing-budgets/v1',
        ref: 'talos://policies/testing/budgets-1',
        digest: digestJson(policy.budgets)
      }
    },
    policy
  });
  const run = await memory.getTestingRun('run-mongo');
  if (run === undefined) throw new Error('testing run fixture missing');
  return run;
};

describe('MongoRepository testing run persistence', () => {
  it('creates the unique index, maps duplicate inserts, and rejects stale CAS writes', async () => {
    const client = new FakeMongoClient();
    const repository = new MongoRepository('mongodb://unused', 'talos-test', {
      client: client as unknown as MongoClient
    });
    await repository.initialize();
    expect(client.database.collection('testing_runs').indexes).toContainEqual({
      keys: { userId: 1, idempotencyKey: 1 },
      options: { unique: true }
    });
    expect(client.database.collection('testing_machine_reservations').indexes).toContainEqual({
      keys: { runId: 1, attemptId: 1 },
      options: { unique: true }
    });

    const run = await makeTestingRun();
    expect(await repository.createTestingRun(run)).toBe(true);
    expect(await repository.createTestingRun({ ...run, idempotencyKey: 'different-key' })).toBe(false);
    expect(await repository.createTestingRun({
      ...run,
      id: 'run-other',
      acceptance: { ...run.acceptance, run_id: 'run-other' }
    })).toBe(false);
    expect(await repository.getTestingRun(run.id)).toEqual(run);
    expect(await repository.getTestingRunByIdempotencyKey(run.userId, run.idempotencyKey)).toEqual(run);

    const updated = { ...run, recordVersion: 2, snapshotVersion: 2 };
    expect(await repository.replaceTestingRun(updated, 1)).toBe(true);
    expect(await repository.replaceTestingRun({ ...updated, recordVersion: 3 }, 1)).toBe(false);
    expect(await repository.getTestingRun(run.id)).toMatchObject({ recordVersion: 2, snapshotVersion: 2 });
    const withinDeadline = { ...updated, recordVersion: 3, snapshotVersion: 3 };
    expect(await repository.replaceTestingRunWithinDeadline(withinDeadline, 2, 'run', 0)).toBe(true);
    const expired = {
      ...withinDeadline,
      recordVersion: 4,
      deadlineAt: '2026-08-21T23:59:59.000Z'
    };
    expect(await repository.replaceTestingRun(expired, 3)).toBe(true);
    expect(await repository.replaceTestingRunWithinDeadline({ ...expired, recordVersion: 5 }, 4, 'run', 0))
      .toBe(false);

    const guardedAttempt = {
      id: 'attempt-guarded',
      claimId: 'claim-guarded',
      operation: 'start' as const,
      taskPayloadDigest: `sha256:${'a'.repeat(64)}`,
      generation: 1,
      status: 'claimed' as const,
      machineId: 'machine-guarded',
      workerId: 'worker-guarded',
      leaseId: 'lease-guarded',
      leaseTokenHash: 'a'.repeat(64),
      fenceToken: 'fence-token-guarded',
      admissionNonce: 'admission-nonce-guarded',
      priorClaims: [],
      leaseClaim: {
        schema: 'talos.testing-lease-claim/v1' as const,
        ref: 'talos://testing/claims/run-guarded/claim-guarded',
        digest: `sha256:${'b'.repeat(64)}`,
        expires_at: '2026-08-22T00:10:00.000Z'
      },
      authorization: {
        ref: 'authorization://testing/run-guarded',
        digest: `sha256:${'c'.repeat(64)}`,
        expires_at: '2026-08-22T00:05:00.000Z'
      },
      leaseExpiresAt: '2026-08-22T00:01:00.000Z',
      issuedAt: '2026-08-22T00:00:00.000Z',
      deadline: '2026-08-22T00:10:00.000Z',
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z'
    };
    const guardedRun: TestingRunRecord = {
      ...run,
      id: 'run-guarded',
      idempotencyKey: 'guarded-key',
      acceptance: { ...run.acceptance, run_id: 'run-guarded' },
      deadlineAt: '2026-08-22T00:10:00.000Z',
      attempts: [guardedAttempt],
      currentAttemptId: guardedAttempt.id,
      recordVersion: 1
    };
    expect(await repository.createTestingRun(guardedRun)).toBe(true);
    const guard = {
      attemptId: guardedAttempt.id,
      operation: guardedAttempt.operation,
      generation: guardedAttempt.generation,
      fenceToken: guardedAttempt.fenceToken,
      leaseId: guardedAttempt.leaseId,
      leaseExpiresAt: guardedAttempt.leaseExpiresAt,
      authorizationExpiresAt: guardedAttempt.authorization.expires_at
    };
    expect(await repository.replaceTestingRunForAttempt(
      { ...guardedRun, recordVersion: 2 },
      1,
      'run',
      guard,
      0
    )).toBe(true);
    expect(await repository.replaceTestingRunForAttempt(
      { ...guardedRun, recordVersion: 3 },
      2,
      'run',
      { ...guard, leaseExpiresAt: '2026-08-21T23:59:59.000Z' },
      0
    )).toBe(false);

    const dispatchedLeaseExpiresAt = '2026-08-22T00:02:00.000Z';
    const dispatchedAuthorizationExpiresAt = '2026-08-22T00:05:00.000Z';
    const dispatchedAttempt = {
      ...guardedAttempt,
      leaseExpiresAt: dispatchedLeaseExpiresAt,
      authorization: {
        ...guardedAttempt.authorization,
        expires_at: dispatchedAuthorizationExpiresAt
      }
    };
    const dispatchedRun = { ...guardedRun, attempts: [dispatchedAttempt], recordVersion: 3 };
    expect(await repository.replaceTestingRunForDispatch(
      dispatchedRun,
      2,
      'run',
      {
        ...guard,
        status: guardedAttempt.status,
        dispatchLeaseExpiresAt: dispatchedLeaseExpiresAt,
        dispatchAuthorizationExpiresAt: dispatchedAuthorizationExpiresAt
      },
      0
    )).toBe(true);
    expect(await repository.replaceTestingRunForDispatch(
      { ...dispatchedRun, recordVersion: 4 },
      3,
      'run',
      {
        attemptId: dispatchedAttempt.id,
        operation: dispatchedAttempt.operation,
        generation: dispatchedAttempt.generation,
        fenceToken: dispatchedAttempt.fenceToken,
        leaseId: dispatchedAttempt.leaseId,
        leaseExpiresAt: dispatchedAttempt.leaseExpiresAt,
        status: dispatchedAttempt.status,
        dispatchLeaseExpiresAt: 'not-a-timestamp',
        dispatchAuthorizationExpiresAt: dispatchedAuthorizationExpiresAt
      },
      0
    )).toBe(false);

    const reservation = {
      machineId: 'machine-1',
      runId: run.id,
      taskId: run.task.id,
      attemptId: 'attempt-1',
      generation: 1,
      fenceToken: 'fence-token-123456',
      status: 'reserved' as const,
      expiresAt: '2026-08-22T00:01:00.000Z',
      recordVersion: 1
    };
    expect(await repository.createTestingMachineReservation(reservation)).toBe(true);
    expect(await repository.createTestingMachineReservation({ ...reservation, attemptId: 'attempt-2' })).toBe(false);
    expect(await repository.createTestingMachineReservation({ ...reservation, machineId: 'machine-2' })).toBe(false);
    expect(await repository.getTestingMachineReservation('machine-1')).toEqual(reservation);
    expect(await repository.listTestingMachineReservations()).toEqual([reservation]);
    const claimedReservation = { ...reservation, status: 'claimed' as const, recordVersion: 2 };
    expect(await repository.replaceTestingMachineReservation(claimedReservation, 1)).toBe(true);
    expect(await repository.replaceTestingMachineReservation({ ...claimedReservation, recordVersion: 3 }, 1)).toBe(false);
    expect(await repository.releaseTestingMachineReservation('machine-1', 'stale-attempt')).toBe(false);
    expect(await repository.releaseTestingMachineReservation('machine-1', 'attempt-1')).toBe(true);
    expect(await repository.getTestingMachineReservation('machine-1')).toBeUndefined();
  });
});
