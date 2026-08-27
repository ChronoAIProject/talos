import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  testingContractFixtureJson,
  testingContractFixtures,
  validateTestingContractFixtureJson
} from './pql-contract-fixtures.js';
import {
  computeTestingToolRequestDigest,
  testingRunAcceptanceSchema,
  testingRunEventSchema,
  testingRunSnapshotSchema,
  testingToolRequestSchema
} from './testing-tool.js';

const fixturePath = new URL('../../specs/testing-contract-fixtures.json', import.meta.url);

describe('PQL contract fixtures', () => {
  it('keeps the committed cross-language JSON artifact generated and schema-valid', () => {
    const source = readFileSync(fixturePath, 'utf8');
    expect(source).toBe(testingContractFixtureJson);
    expect(validateTestingContractFixtureJson(source)).toEqual(testingContractFixtures);
  });

  it('covers the frozen terminal, failure, retry, ordering, and recovery scenarios without effects or secrets', () => {
    const requiredIds = [
      'passed',
      'product_assertion_failed',
      'runner_runtime_error',
      'all_skipped',
      'evidence_incomplete',
      'cleanup_failed',
      'cleanup_incomplete',
      'cleanup_unknown',
      'execution_timeout',
      'cancelled',
      'terminal_blocked',
      'abandoned',
      'upload_failed',
      'upload_expired',
      'upload_pending',
      'authorization_denied',
      'authorization_expired',
      'no_eligible_machine',
      'wrong_machine',
      'wrong_worker',
      'lease_expired',
      'stale_fence',
      'stale_generation',
      'runtime_admission_rejected',
      'runner_package_unavailable',
      'runner_package_mismatch',
      'exact_commit_mismatch',
      'plan_digest_mismatch',
      'unsupported_capability',
      'conflicting_terminal_result',
      'duplicate_submit',
      'duplicate_out_of_order_events',
      'cursor_expiry',
      'worker_heartbeat_lost',
      'talos_restart_recovery',
      'worker_runtime_restart_recovery'
    ];
    const ids = testingContractFixtures.fixtures.map((fixture) => fixture.id);
    expect(ids).toEqual(expect.arrayContaining(requiredIds));
    expect(testingContractFixtures.side_effects).toBe(false);
    expect(testingContractFixtures.fixtures.every((fixture) => fixture.side_effects === false)).toBe(true);

    const serialized = JSON.stringify(testingContractFixtures);
    for (const forbidden of ['password', 'cookie', 'worker_token', 'lease_token', 'private_key']) {
      expect(serialized).not.toContain(forbidden);
    }
    for (const fixture of testingContractFixtures.fixtures) {
      if (fixture.kind === 'snapshot') testingRunSnapshotSchema.parse(fixture.response);
    }
    const snapshots = testingContractFixtures.fixtures.filter((fixture) => fixture.kind === 'snapshot');
    expect(new Set(snapshots.map((fixture) => fixture.response.run_id)).size).toBe(snapshots.length);
    expect(new Set(snapshots.map((fixture) => fixture.response.snapshot_ref)).size).toBe(snapshots.length);
    const externalIdentities = snapshots.flatMap((fixture) => {
      const refs = fixture.response.results;
      if (refs === null) return [];
      return [refs.case_result_set, refs.evidence_manifest, refs.cleanup_receipt]
        .filter((entry) => entry !== undefined)
        .map((entry) => `${entry.ref}\u0000${entry.digest}`);
    });
    expect(new Set(externalIdentities).size).toBe(externalIdentities.length);
  });

  it('provides parseable replay and event-reconciliation inputs with stable expected behavior', () => {
    const duplicate = testingContractFixtures.fixtures.find((fixture) => fixture.id === 'duplicate_submit');
    if (duplicate?.kind !== 'protocol') throw new Error('duplicate submit fixture missing');
    const duplicateRequest = testingToolRequestSchema.parse(duplicate.input);
    const duplicateExpected = duplicate.expected as { first: unknown; replay: unknown; logical_run_count: number };
    const first = testingRunAcceptanceSchema.parse(duplicateExpected.first);
    const replay = testingRunAcceptanceSchema.parse(duplicateExpected.replay);
    const exactRequestDigest = computeTestingToolRequestDigest('fixture-run', duplicateRequest);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(first.request_digest).toBe(exactRequestDigest);
    expect(replay.request_digest).toBe(exactRequestDigest);
    expect(first.authenticated_transport.verified_request_digest).toBe(exactRequestDigest);
    expect(duplicateExpected.logical_run_count).toBe(1);

    const eventFixture = testingContractFixtures.fixtures.find((fixture) => fixture.id === 'duplicate_out_of_order_events');
    if (eventFixture?.kind !== 'protocol') throw new Error('event ordering fixture missing');
    const events = (eventFixture.input as { events: unknown[] }).events.map((entry) => testingRunEventSchema.parse(entry));
    expect(events.map((entry) => entry.sequence)).toEqual([2, 1, 1]);
    expect(events[1]?.event_digest).toBe(events[2]?.event_digest);

    for (const id of ['worker_heartbeat_lost', 'talos_restart_recovery', 'worker_runtime_restart_recovery']) {
      const recovery = testingContractFixtures.fixtures.find((fixture) => fixture.id === id);
      if (recovery?.kind !== 'protocol') throw new Error(`${id} fixture missing`);
      const values = [...Object.values(recovery.input as Record<string, unknown>), ...Object.values(recovery.expected as Record<string, unknown>)];
      for (const value of values) {
        if (typeof value === 'object' && value !== null && 'schema_version' in value) {
          testingRunSnapshotSchema.parse(value);
        }
      }
    }
  });

  it('keeps per-run submit and NyxID fields outside deterministic InputSet references', () => {
    const passed = testingContractFixtures.fixtures.find((fixture) => fixture.id === 'passed');
    if (passed?.kind !== 'snapshot') throw new Error('passed fixture missing');
    const inputKeys = Object.keys(passed.response.inputs);
    expect(inputKeys).not.toEqual(expect.arrayContaining([
      'request_id',
      'client_correlation_id',
      'idempotency_key',
      'transport_correlation_id',
      'audit_refs'
    ]));
  });
});
