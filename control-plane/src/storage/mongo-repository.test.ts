import { describe, expect, it } from 'vitest';
import type { MongoClient } from 'mongodb';
import { digestJson } from '@talos/testing-protocol';
import { TestingRunService } from '../services/testing-run-service.js';
import type { TestingRunRecord } from '../domain/testing-types.js';
import { MemoryRepository } from './memory-repository.js';
import { MongoRepository } from './mongo-repository.js';

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
    const duplicateIdentity = [...this.documents.values()].some((candidate) =>
      candidate.userId === document.userId && candidate.idempotencyKey === document.idempotencyKey);
    if (this.documents.has(document._id) || duplicateIdentity) throw { code: 11000 };
    this.documents.set(document._id, structuredClone(document));
    return { acknowledged: true, insertedId: document._id };
  }

  public async findOne(filter: Readonly<Record<string, unknown>>): Promise<FakeDocument | null> {
    const document = [...this.documents.values()].find((candidate) =>
      Object.entries(filter).every(([key, value]) => candidate[key] === value));
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
}

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
  const service = new TestingRunService(memory, {
    cursorSecret: 'mongo-double-cursor-secret-1234',
    clock: () => Date.parse('2026-08-22T00:00:00.000Z')
  });
  await service.submit('run-mongo', 'user-1', {
    schema_version: 'talos.testing-tool-request/v1',
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
  });
});
