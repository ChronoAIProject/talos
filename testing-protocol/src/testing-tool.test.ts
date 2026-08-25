import { describe, expect, it } from 'vitest';
import {
  computeTestingCurrentClaimDigest,
  computeTestingRunEventDigest,
  computeTestingRunSnapshotDigest,
  computeTestingToolRequestDigest,
  testingCancelRequestSchema,
  testingCurrentClaimEnvelopeSchema,
  testingRunEventSchema,
  testingRunSnapshotSchema,
  testingTaskSchema,
  testingToolRequestSchema
} from './testing-tool.js';
import { digestJson } from './contracts.js';

const digest = `sha256:${'a'.repeat(64)}`;
const timestamp = '2026-08-22T00:00:00.000Z';

const pointer = (schema: string, ref: string) => ({ schema, ref, digest });
const policy = {
  network_scope: 'environment_owned_loopback_exact_origins' as const,
  environment_port_handle_policy: {
    source: 'current_run_owned_handles' as const,
    allow_unowned_loopback: false as const
  },
  allowed_actions: ['navigate' as const, 'assert-visible' as const],
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
  schema_version: 'talos.testing-tool-request/v1' as const,
  idempotency_key: 'snapshot:selection:revision:plan:policy',
  display_goal: 'Verify the login redirect',
  inputs: {
    schema_version: 'talos.testing-input-references/v1' as const,
    project_pack_snapshot: pointer('pql.project-pack-snapshot/v1', 'artifact://pql/project-pack-snapshot/snapshot-1'),
    test_selection: pointer('pql.test-selection/v1', 'artifact://pql/test-selection/selection-1'),
    testing_design_input_set: pointer('pql.testing-design-input-set.v1', 'artifact://pql/testing-design-input-set/input-1'),
    source_revision: {
      repository_id: 'repo-example',
      exact_revision: '0123456789abcdef0123456789abcdef01234567',
      ref: 'artifact://source/revision-1',
      digest
    },
    structured_plan: pointer('testing-structured-plan.v2', 'artifact://plans/plan-1'),
    environment_profile: { ref: 'artifact://environments/environment-1', digest },
    testing_package: { package_id: 'testing-browser-runner', version: '1.0', digest }
  },
  execution_profile: 'local_qa_agent_mvp' as const,
  placement_requirements: { testing_runtime: 'local-qa-mvp/v1' as const },
  policy_binding: {
    policy: {
      schema: 'talos.testing-execution-policy/v1' as const,
      ref: 'talos://policies/testing/policy-1',
      digest: digestJson(policy)
    },
    budgets: {
      schema: 'talos.testing-budgets/v1' as const,
      ref: 'talos://policies/testing/budgets-1',
      digest: digestJson(policy.budgets)
    }
  },
  policy
});

describe('Testing Tool contracts', () => {
  it('strictly binds signed current-claim envelopes without carrying raw lease tokens', () => {
    const claim = {
      schema_version: 'talos.testing-claim-identity/v1' as const,
      operation: 'start' as const,
      claim_id: 'claim-1',
      run_id: 'run-1',
      task_id: 'task-1',
      attempt_id: 'attempt-1',
      machine_id: 'machine-1',
      worker_id: 'worker-1',
      generation: 1,
      lease_id: 'lease-1',
      fence_token: 'fence-token-123456',
      admission_nonce: 'admission-nonce-123456',
      issued_at: timestamp,
      expires_at: '2026-08-22T00:10:00.000Z'
    };
    const envelope = {
      schema_version: 'talos.testing-current-claim/v1' as const,
      claim,
      claim_digest: computeTestingCurrentClaimDigest(claim),
      audience: 'local-qa-runtime' as const,
      request_nonce: 'runtime-request-nonce-123456',
      is_current: true,
      status: 'current' as const,
      lease_expires_at: '2026-08-22T00:01:00.000Z',
      observed_at: timestamp,
      valid_until: '2026-08-22T00:00:05.000Z',
      key_id: 'testing-claim-key-1',
      signature: `ed25519:${'b'.repeat(86)}`
    };
    expect(testingCurrentClaimEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(() => testingCurrentClaimEnvelopeSchema.parse({ ...envelope, claim_digest: digest })).toThrow(
      'claim_digest does not match claim identity'
    );
    expect(() => testingCurrentClaimEnvelopeSchema.parse({ ...envelope, is_current: false })).toThrow(
      'is_current must match current claim status'
    );
    expect(() => testingCurrentClaimEnvelopeSchema.parse({ ...envelope, lease_token: 'forbidden' })).toThrow();
  });

  it('strictly accepts pointer-only requests and binds the digest to path run identity', () => {
    expect(testingToolRequestSchema.parse(request)).toEqual(request);
    expect(computeTestingToolRequestDigest('run-1', request)).not.toBe(
      computeTestingToolRequestDigest('run-2', request)
    );
    for (const forbiddenField of ['pool_id', 'machine_id', 'raw_plan', 'cwd', 'argv', 'lease_token']) {
      expect(() => testingToolRequestSchema.parse({ ...request, [forbiddenField]: 'forbidden' })).toThrow();
    }
    expect(() => testingToolRequestSchema.parse({
      ...request,
      policy: { ...request.policy, secret_refs: ['secret-1'] }
    })).toThrow();
    expect(() => testingToolRequestSchema.parse({
      ...request,
      policy_binding: {
        ...request.policy_binding,
        policy: { ...request.policy_binding.policy, digest }
      }
    })).toThrow('policy digest does not match bounded policy projection');
  });

  it('keeps control and operational outcomes independent in a digest-bound snapshot', () => {
    const core = {
      schema_version: 'talos.testing-run-snapshot/v1' as const,
      run_id: 'run-1',
      snapshot_version: 3,
      snapshot_ref: 'talos://testing/runs/run-1/snapshots/3',
      control_status: 'completed' as const,
      execution_outcome: 'failed' as const,
      evidence_outcome: 'complete' as const,
      upload_outcome: 'pending' as const,
      cleanup_outcome: 'residual_blocking' as const,
      attempt: null,
      progress: { phase: 'closing', completed_cases: 1, total_cases: 1, last_event_sequence: 4 },
      summary: { total: 1, passed: 0, failed: 1, blocked: 0, error: 0 },
      results: null,
      safe_error: null,
      created_at: timestamp,
      updated_at: timestamp
    };
    const snapshot = {
      ...core,
      snapshot_digest: computeTestingRunSnapshotDigest(core),
      resume_cursor: 'cursor-value-that-is-longer-than-thirty-two-characters'
    };

    expect(testingRunSnapshotSchema.parse(snapshot)).toMatchObject({
      control_status: 'completed',
      execution_outcome: 'failed',
      upload_outcome: 'pending',
      cleanup_outcome: 'residual_blocking'
    });
    expect(() => testingRunSnapshotSchema.parse({ ...snapshot, execution_outcome: 'passed' })).toThrow(
      'snapshot_digest does not match snapshot'
    );
    for (const unsettled of [
      { execution_outcome: 'executing' as const },
      { evidence_outcome: 'staging' as const },
      { cleanup_outcome: 'pending' as const }
    ]) {
      const invalidCore = { ...core, ...unsettled };
      expect(testingRunSnapshotSchema.safeParse({
        ...invalidCore,
        snapshot_digest: digestJson(invalidCore),
        resume_cursor: snapshot.resume_cursor
      }).success).toBe(false);
    }

    const attempt = { attempt_id: 'attempt-1', task_id: 'task-1', generation: 2, machine_id: 'machine-1' };
    const binding = {
      run_id: 'run-1',
      task_id: attempt.task_id,
      attempt_id: attempt.attempt_id,
      generation: attempt.generation,
      fence_token: 'fence-token-123456'
    };
    const terminalCore = {
      ...core,
      attempt,
      results: { schema_version: 'talos.testing-terminal-refs/v1' as const, binding }
    };
    expect(testingRunSnapshotSchema.parse({
      ...terminalCore,
      snapshot_digest: computeTestingRunSnapshotDigest(terminalCore),
      resume_cursor: snapshot.resume_cursor
    }).results).toMatchObject({ binding });

    const foreignRunCore = {
      ...terminalCore,
      results: {
        ...terminalCore.results,
        binding: { ...binding, run_id: 'run-2' }
      }
    };
    expect(() => computeTestingRunSnapshotDigest(foreignRunCore)).toThrow(
      'terminal results run_id must match snapshot attempt'
    );
    expect(() => testingRunSnapshotSchema.parse({
      ...foreignRunCore,
      snapshot_digest: digestJson(foreignRunCore),
      resume_cursor: snapshot.resume_cursor
    })).toThrow('terminal results run_id must match snapshot attempt');

    const missingAttemptCore = { ...terminalCore, attempt: null };
    expect(() => computeTestingRunSnapshotDigest(missingAttemptCore)).toThrow(
      'terminal results require a current attempt'
    );
    expect(() => testingRunSnapshotSchema.parse({
      ...missingAttemptCore,
      snapshot_digest: digestJson(missingAttemptCore),
      resume_cursor: snapshot.resume_cursor
    })).toThrow('terminal results require a current attempt');
  });

  it('digest-binds bounded events and rejects testing tasks with transport secrets or raw plans', () => {
    const eventCore = {
      sequence: 1,
      type: 'run.submitted' as const,
      time: timestamp,
      data: { request_digest: digest }
    };
    expect(testingRunEventSchema.parse({
      ...eventCore,
      event_digest: computeTestingRunEventDigest(eventCore)
    })).toMatchObject(eventCore);
    for (const terminalEvent of [
      { sequence: 2, type: 'run.completed', time: timestamp, data: { execution_outcome: 'executing' } },
      { sequence: 2, type: 'run.cancelled', time: timestamp, data: { cleanup_outcome: 'pending' } },
      {
        sequence: 2,
        type: 'run.terminal_projection_updated',
        time: timestamp,
        data: { evidence_outcome: 'staging', upload_outcome: 'pending', cleanup_outcome: 'pending' }
      }
    ]) {
      expect(testingRunEventSchema.safeParse({
        ...terminalEvent,
        event_digest: digestJson(terminalEvent)
      }).success).toBe(false);
    }
    expect(() => testingRunEventSchema.parse({
      ...eventCore,
      data: { ...eventCore.data, lease_token: 'forbidden' },
      event_digest: computeTestingRunEventDigest(eventCore)
    })).toThrow();
    expect(() => testingCancelRequestSchema.parse({
      schema_version: 'talos.testing-cancel-request/v1',
      idempotency_scope: 'talos.testing.cancel:run-1',
      idempotency_key: 'cancel-1',
      canonical_request_digest: digest,
      reason: 'lease_token_abc123'
    })).toThrow();

    const task = {
      schema_version: 'talos.testing-task/v1' as const,
      id: 'task-1',
      kind: 'testing' as const,
      interaction: 'managed' as const,
      qa_run_id: 'run-1',
      dispatch_attempt_id: 'attempt-1',
      generation: 1,
      machine_id: 'machine-1',
      worker_id: 'worker-1',
      lease_id: 'lease-1',
      fence_token: 'fence-token-123456',
      admission_nonce: 'admission-nonce-123456',
      lease_claim: {
        schema: 'talos.testing-lease-claim/v1' as const,
        ref: 'talos://testing/claims/run-1/claim-1',
        digest,
        expires_at: timestamp
      },
      inputs: request.inputs,
      runner: request.inputs.testing_package,
      policy_ref: request.policy_binding.policy,
      budgets_ref: request.policy_binding.budgets,
      local_request_authorization: {
        ref: 'authorization://local-qa-request/start-1',
        digest,
        expires_at: timestamp
      },
      expected_runtime_capability: 'local-qa-mvp/v1' as const,
      deadline: timestamp
    };
    expect(testingTaskSchema.parse(task)).toEqual(task);
    for (const forbiddenField of ['lease_token', 'worker_token', 'raw_plan', 'command']) {
      expect(() => testingTaskSchema.parse({ ...task, [forbiddenField]: 'forbidden' })).toThrow();
    }
    expect(() => testingTaskSchema.parse({
      ...task,
      runner: { ...task.runner, version: '1.1' }
    })).toThrow('runner must match frozen testing package');
  });
});
