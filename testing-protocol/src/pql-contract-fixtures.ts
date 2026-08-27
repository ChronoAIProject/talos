import { z } from 'zod';
import { digestJson, jsonValueSchema, type JsonValue } from './contracts.js';
import {
  computeTestingRunEventDigest,
  computeTestingRunSnapshotDigest,
  computeTestingToolRequestDigest,
  testingAuthenticatedTransportContextSchema,
  testingRunAcceptanceSchema,
  testingRunEventSchema,
  testingRunSnapshotSchema,
  testingToolRequestSchema,
  type TestingRunSnapshotCore
} from './testing-tool.js';

const fixtureIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_]*$/);
const publicErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1).max(4_096),
    retryable: z.boolean()
  }).passthrough()
}).strict();

const snapshotFixtureSchema = z.object({
  id: fixtureIdSchema,
  kind: z.literal('snapshot'),
  side_effects: z.literal(false),
  response: testingRunSnapshotSchema
}).strict();

const errorFixtureSchema = z.object({
  id: fixtureIdSchema,
  kind: z.literal('error'),
  side_effects: z.literal(false),
  response: publicErrorEnvelopeSchema
}).strict();

const protocolFixtureSchema = z.object({
  id: fixtureIdSchema,
  kind: z.literal('protocol'),
  side_effects: z.literal(false),
  input: jsonValueSchema,
  expected: jsonValueSchema
}).strict();

export const testingContractFixtureBundleSchema = z.object({
  schema_version: z.literal('talos.testing-contract-fixtures/v1'),
  authority: z.literal('talos'),
  canonical_terminal_authority: z.literal('talos.testing-run-snapshot/v1'),
  operations: z.tuple([
    z.literal('get_capabilities'),
    z.literal('submit'),
    z.literal('get'),
    z.literal('events'),
    z.literal('cancel')
  ]),
  side_effects: z.literal(false),
  fixtures: z.array(z.discriminatedUnion('kind', [
    snapshotFixtureSchema,
    errorFixtureSchema,
    protocolFixtureSchema
  ])).min(18).max(100)
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  value.fixtures.forEach((fixture, index) => {
    if (ids.has(fixture.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'fixture ids must be unique', path: ['fixtures', index, 'id'] });
    }
    ids.add(fixture.id);
  });
});

const digest = `sha256:${'a'.repeat(64)}`;
const timestamp = '2026-08-22T00:00:00.000Z';
const laterTimestamp = '2026-08-22T00:00:05.000Z';
const cursor = 'fixture-cursor-that-is-longer-than-thirty-two-characters';
const pointer = (schema: string, ref: string) => ({ schema, ref, digest });

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

const request = testingToolRequestSchema.parse({
  schema_version: 'talos.testing-tool-request/v1',
  request_id: 'request:fixture-run',
  client_correlation_id: 'client:fixture-run',
  idempotency_key: 'fixture-submit-key',
  display_goal: 'Validate a side-effect-free PQL consumer fixture',
  inputs: {
    schema_version: 'talos.testing-input-references/v1',
    project_pack_snapshot: pointer('pql.project-pack-snapshot/v1', 'artifact://pql/project-pack-snapshot/fixture'),
    test_selection: pointer('pql.test-selection/v1', 'artifact://pql/test-selection/fixture'),
    testing_design_input_set: pointer('pql.testing-design-input-set.v1', 'artifact://pql/testing-design-input-set/fixture'),
    source_revision: {
      repository_id: 'repo-fixture',
      exact_revision: '0123456789abcdef0123456789abcdef01234567',
      ref: 'artifact://source/revisions/fixture',
      digest
    },
    structured_plan: pointer('testing-structured-plan.v2', 'artifact://testing/plans/fixture'),
    environment_profile: { ref: 'artifact://testing/environments/fixture', digest },
    testing_package: { package_id: 'testing-browser-runner', version: '1.0', digest }
  },
  execution_profile: 'local_qa_agent_mvp',
  placement_requirements: { testing_runtime: 'local-qa-mvp/v1' },
  policy_binding: {
    policy: { schema: 'talos.testing-execution-policy/v1', ref: 'talos://policies/testing/fixture', digest: digestJson(policy) },
    budgets: { schema: 'talos.testing-budgets/v1', ref: 'talos://policies/testing/fixture-budgets', digest: digestJson(policy.budgets) }
  },
  policy
});

const requestFor = (runId: string) => testingToolRequestSchema.parse({
  ...request,
  request_id: `request:${runId}`,
  client_correlation_id: `client:${runId}`,
  idempotency_key: `fixture:${runId}`
});

const transportFor = (runId: string, runRequest: typeof request) => {
  const requestDigest = computeTestingToolRequestDigest(runId, runRequest);
  const transportDigest = digestJson({ fixture: runId, type: 'transport' });
  return testingAuthenticatedTransportContextSchema.parse({
    schema_version: 'talos.testing-authenticated-transport-context/v1',
    transport_correlation_id: `transport:${runId}`,
    verified_client_correlation_id: runRequest.client_correlation_id,
    subject: 'pql-fixture-user',
    delegated_actor: null,
    source: 'pql',
    destination: 'talos-testing-tool',
    route: {
      ref: `nyxid://routes/testing/${runId}`,
      digest: transportDigest,
      operation: 'submit',
      run_id: runId
    },
    authorization: {
      ref: `authorization://nyxid/testing/${runId}`,
      digest: transportDigest,
      operation: 'submit',
      run_id: runId,
      valid_until: '2026-08-22T00:10:00.000Z'
    },
    audit_refs: [{ ref: `nyxid://audit/events/${runId}`, digest: transportDigest }],
    transport_acknowledgement: { ref: `nyxid://transport-acks/testing/${runId}`, digest: transportDigest },
    verified_request_digest: requestDigest,
    verified_at: timestamp
  });
};

const authenticatedTransport = transportFor('fixture-run', request);
const requestDigest = computeTestingToolRequestDigest('fixture-run', request);

type ResultRefName = 'case_result_set' | 'evidence_manifest' | 'cleanup_receipt';

const snapshot = (
  fixtureId: string,
  overrides: Partial<TestingRunSnapshotCore> = {},
  includedRefs: readonly ResultRefName[] = ['case_result_set', 'evidence_manifest', 'cleanup_receipt']
) => {
  const runId = `fixture-${fixtureId}`;
  const runRequest = requestFor(runId);
  const runTransport = transportFor(runId, runRequest);
  const attempt = {
    attempt_id: `attempt-${fixtureId}`,
    task_id: `task-${fixtureId}`,
    generation: 1,
    machine_id: `machine-${fixtureId}`,
    worker_id: `worker-${fixtureId}`,
    runtime: { capability: 'local-qa-mvp/v1' as const, locally_accepted_at: timestamp, event_sequence: 4 }
  };
  const binding = {
    run_id: runId,
    task_id: attempt.task_id,
    attempt_id: attempt.attempt_id,
    generation: attempt.generation,
    fence_token: `fence-${fixtureId}-123456`
  };
  const resultRefs = {
    case_result_set: {
      schema: 'testing-case-result-set.v2' as const,
      ref: `artifact://testing/results/${fixtureId}`,
      digest: digestJson({ fixture: fixtureId, type: 'case_result_set' }),
      binding
    },
    evidence_manifest: {
      schema: 'testing-evidence-manifest.v1' as const,
      ref: `artifact://testing/evidence/${fixtureId}`,
      digest: digestJson({ fixture: fixtureId, type: 'evidence_manifest' }),
      binding
    },
    cleanup_receipt: {
      schema: 'qa.local-cleanup-receipt/v2' as const,
      ref: `artifact://testing/cleanup/${fixtureId}`,
      digest: digestJson({ fixture: fixtureId, type: 'cleanup_receipt' }),
      binding
    }
  };
  const selectedRefs = Object.fromEntries(includedRefs.map((name) => [name, resultRefs[name]]));
  const snapshotVersion = overrides.snapshot_version ?? 3;
  const core: TestingRunSnapshotCore = {
    schema_version: 'talos.testing-run-snapshot/v1',
    run_id: runId,
    request_id: runRequest.request_id,
    client_correlation_id: runRequest.client_correlation_id,
    authenticated_transport: runTransport,
    inputs: runRequest.inputs,
    snapshot_version: snapshotVersion,
    control_status: 'completed',
    execution_outcome: 'passed',
    evidence_outcome: 'complete',
    upload_outcome: 'uploaded',
    cleanup_outcome: 'complete',
    terminal: true,
    terminal_reason: { code: 'execution_settled', at: timestamp },
    blocking: null,
    attempt,
    progress: { phase: 'closing', completed_cases: 1, total_cases: 1, last_event_sequence: 4 },
    summary: { total: 1, passed: 1, failed: 0, blocked: 0, error: 0, skipped: 0, all_skipped: false },
    results: { schema_version: 'talos.testing-terminal-refs/v1', binding, ...selectedRefs },
    safe_error: null,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
    snapshot_ref: `talos://testing/runs/${runId}/snapshots/${snapshotVersion}`
  };
  return testingRunSnapshotSchema.parse({
    ...core,
    snapshot_digest: computeTestingRunSnapshotDigest(core),
    resume_cursor: cursor
  });
};

const snapshotFixture = (id: string, response: ReturnType<typeof snapshot>) => ({
  id,
  kind: 'snapshot' as const,
  side_effects: false as const,
  response
});

const errorFixture = (
  id: string,
  code: string,
  retryable: boolean,
  details: Readonly<Record<string, JsonValue>> = {}
) => ({
  id,
  kind: 'error' as const,
  side_effects: false as const,
  response: { error: { ...details, code, message: `${id} fixture`, retryable } }
});

const event = (sequence: number, type: 'run.reserved' | 'run.started', data: Record<string, JsonValue>) => {
  const core = { sequence, type, time: timestamp, data };
  return testingRunEventSchema.parse({ ...core, event_digest: computeTestingRunEventDigest(core) });
};

const acceptance = (replayed: boolean) => testingRunAcceptanceSchema.parse({
  schema_version: 'talos.testing-run-acceptance/v1',
  run_id: 'fixture-run',
  request_id: request.request_id,
  client_correlation_id: request.client_correlation_id,
  accepted: true,
  replayed,
  control_status: 'submitted',
  request_digest: requestDigest,
  authenticated_transport: authenticatedTransport,
  created_at: timestamp
});

const running = snapshot('recovery_chain', {
  snapshot_version: 1,
  control_status: 'running',
  execution_outcome: 'executing',
  evidence_outcome: 'staging',
  upload_outcome: 'pending',
  cleanup_outcome: 'pending',
  terminal: false,
  terminal_reason: null,
  progress: { phase: 'running', completed_cases: 0, total_cases: 1, last_event_sequence: 3 },
  summary: null,
  results: null,
  updated_at: timestamp
}, []);
const reconcileRequired = snapshot('recovery_chain', {
  snapshot_version: 2,
  control_status: 'reconcile_required',
  execution_outcome: 'executing',
  evidence_outcome: 'staging',
  upload_outcome: 'pending',
  cleanup_outcome: 'pending',
  terminal: false,
  terminal_reason: null,
  blocking: {
    reason_code: 'worker_heartbeat_lost',
    retry_at: laterTimestamp,
    deadline_at: '2026-08-22T00:10:00.000Z',
    next_action: 'reconcile'
  },
  progress: { phase: 'reconcile_required', completed_cases: 0, total_cases: 1, last_event_sequence: 4 },
  summary: null,
  results: null,
  updated_at: laterTimestamp
}, []);
const recoveryAttempt = running.attempt;
if (recoveryAttempt === null) throw new Error('recovery fixture attempt missing');

const fixtures = [
  snapshotFixture('passed', snapshot('passed')),
  snapshotFixture('product_assertion_failed', snapshot('product_assertion_failed', {
    execution_outcome: 'failed',
    summary: { total: 1, passed: 0, failed: 1, blocked: 0, error: 0, skipped: 0, all_skipped: false }
  })),
  snapshotFixture('runner_runtime_error', snapshot('runner_runtime_error', {
    execution_outcome: 'error',
    summary: { total: 1, passed: 0, failed: 0, blocked: 0, error: 1, skipped: 0, all_skipped: false },
    safe_error: { code: 'runner_error', message: 'Runner returned a structured execution error', retryable: false }
  })),
  snapshotFixture('all_skipped', snapshot('all_skipped', {
    execution_outcome: 'all_skipped',
    terminal_reason: { code: 'execution_all_skipped', at: timestamp },
    summary: { total: 2, passed: 0, failed: 0, blocked: 0, error: 0, skipped: 2, all_skipped: true }
  })),
  snapshotFixture('evidence_incomplete', snapshot('evidence_incomplete', { evidence_outcome: 'partial' })),
  snapshotFixture('evidence_unavailable', snapshot(
    'evidence_unavailable',
    { evidence_outcome: 'unavailable' },
    ['case_result_set', 'cleanup_receipt']
  )),
  snapshotFixture('cleanup_failed', snapshot('cleanup_failed', { cleanup_outcome: 'residual_blocking' })),
  snapshotFixture('cleanup_incomplete', snapshot('cleanup_incomplete', { cleanup_outcome: 'residual_retryable' })),
  snapshotFixture('cleanup_unknown', snapshot('cleanup_unknown', {
    control_status: 'abandoned',
    execution_outcome: 'lost_or_inconclusive',
    evidence_outcome: 'unavailable',
    upload_outcome: 'upload_expired',
    cleanup_outcome: 'unobserved',
    terminal_reason: { code: 'reconcile_deadline_exceeded', at: timestamp },
    summary: null
  }, [])),
  snapshotFixture('execution_timeout', snapshot('execution_timeout', {
    execution_outcome: 'timed_out',
    terminal_reason: { code: 'execution_timed_out', at: timestamp },
    summary: null
  }, ['evidence_manifest', 'cleanup_receipt'])),
  snapshotFixture('cancelled', snapshot('cancelled', {
    control_status: 'cancelled',
    execution_outcome: 'cancelled',
    evidence_outcome: 'unavailable',
    upload_outcome: 'not_required',
    cleanup_outcome: 'unobserved',
    terminal_reason: { code: 'cancelled', at: timestamp },
    summary: null
  }, [])),
  snapshotFixture('terminal_blocked', snapshot('terminal_blocked', {
    execution_outcome: 'blocked',
    terminal_reason: { code: 'terminal_blocked', at: timestamp },
    summary: { total: 1, passed: 0, failed: 0, blocked: 1, error: 0, skipped: 0, all_skipped: false }
  })),
  snapshotFixture('abandoned', snapshot('abandoned', {
    control_status: 'abandoned',
    execution_outcome: 'lost_or_inconclusive',
    evidence_outcome: 'unavailable',
    upload_outcome: 'upload_expired',
    cleanup_outcome: 'unobserved',
    terminal_reason: { code: 'reconcile_deadline_exceeded', at: timestamp },
    summary: null
  }, [])),
  snapshotFixture('upload_failed', snapshot('upload_failed', { upload_outcome: 'failed' })),
  snapshotFixture('upload_expired', snapshot('upload_expired', { upload_outcome: 'upload_expired' })),
  snapshotFixture('upload_pending', snapshot('upload_pending', {
    upload_outcome: 'pending', terminal: false, terminal_reason: null
  })),
  errorFixture('authorization_denied', 'nyxid_authorization_mismatch', false),
  errorFixture('authorization_expired', 'nyxid_authorization_expired', false),
  errorFixture('no_eligible_machine', 'testing_placement_unavailable', true),
  errorFixture('wrong_machine', 'stale_testing_machine', false),
  errorFixture('wrong_worker', 'stale_testing_worker', false),
  errorFixture('lease_expired', 'testing_lease_expired', false),
  errorFixture('stale_fence', 'stale_testing_fence', false),
  errorFixture('stale_generation', 'stale_testing_generation', false),
  errorFixture('runtime_admission_rejected', 'invalid_no_local_acceptance_fact', false),
  errorFixture('runner_package_unavailable', 'testing_placement_unavailable', true),
  errorFixture('runner_package_mismatch', 'testing_placement_inputs_unverified', false),
  errorFixture('exact_commit_mismatch', 'testing_placement_inputs_unverified', false),
  errorFixture('plan_digest_mismatch', 'testing_placement_inputs_unverified', false),
  errorFixture('unsupported_capability', 'testing_placement_denied', false),
  errorFixture('conflicting_terminal_result', 'terminal_commit_conflict', false),
  errorFixture('cursor_expiry', 'cursor_expired', true, {
    replacement_cursor: cursor,
    snapshot_ref: snapshot('cursor_expiry').snapshot_ref,
    snapshot_version: snapshot('cursor_expiry').snapshot_version,
    snapshot_digest: snapshot('cursor_expiry').snapshot_digest
  }),
  {
    id: 'duplicate_submit', kind: 'protocol' as const, side_effects: false as const,
    input: request,
    expected: { first: acceptance(false), replay: acceptance(true), logical_run_count: 1 }
  },
  {
    id: 'duplicate_out_of_order_events', kind: 'protocol' as const, side_effects: false as const,
    input: {
      events: [
        event(2, 'run.started', { attempt_id: recoveryAttempt.attempt_id, generation: recoveryAttempt.generation }),
        event(1, 'run.reserved', { task_id: recoveryAttempt.task_id }),
        event(1, 'run.reserved', { task_id: recoveryAttempt.task_id })
      ]
    },
    expected: { accepted_sequences: [1, 2], dedupe_key: 'event_digest', ordering_key: 'sequence' }
  },
  {
    id: 'worker_heartbeat_lost', kind: 'protocol' as const, side_effects: false as const,
    input: { last_snapshot: running },
    expected: { next_snapshot: reconcileRequired, next_action: 'same_machine_reconcile' }
  },
  {
    id: 'talos_restart_recovery', kind: 'protocol' as const, side_effects: false as const,
    input: { persisted_snapshot: running },
    expected: { recovered_snapshot: { ...running, snapshot_version: running.snapshot_version } }
  },
  {
    id: 'worker_runtime_restart_recovery', kind: 'protocol' as const, side_effects: false as const,
    input: { persisted_snapshot: reconcileRequired },
    expected: { recovered_terminal_snapshot: snapshot('recovery_chain'), rerun_product_cases: false }
  }
];

export const testingContractFixtures = testingContractFixtureBundleSchema.parse({
  schema_version: 'talos.testing-contract-fixtures/v1',
  authority: 'talos',
  canonical_terminal_authority: 'talos.testing-run-snapshot/v1',
  operations: ['get_capabilities', 'submit', 'get', 'events', 'cancel'],
  side_effects: false,
  fixtures
});

export const testingContractFixtureJson = `${JSON.stringify(testingContractFixtures, null, 2)}\n`;

export const validateTestingContractFixtureJson = (input: string) =>
  testingContractFixtureBundleSchema.parse(JSON.parse(input));
