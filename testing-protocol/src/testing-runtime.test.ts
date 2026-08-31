import { describe, expect, it } from 'vitest';
import {
  computeLocalQARunRequestDigest,
  computeLocalQARuntimeEventDigest,
  computeLocalQARuntimeSnapshotDigest,
  computeTestingCurrentClaimDigest,
  computeTestingTaskPayloadDigest,
  digestJson,
  localQARunRequestSchema,
  localQACancelAckSchema,
  localQARuntimeCapabilitiesSchema,
  localQARuntimeEventPageSchema,
  localQARuntimeSnapshotSchema,
  testingAuthorizationResolutionSchema,
  testingRuntimeAttemptSchema
} from './index.js';

const digest = `sha256:${'a'.repeat(64)}`;
const now = '2026-08-24T00:00:00.000Z';
const deadline = '2026-08-24T00:10:00.000Z';
const authorization = { schema_version: 'owner.pending-authorization/v1', signature: 'signed-envelope' };
const authorizationDigest = digestJson(authorization);

const taskWithoutPayloadDigest = {
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
  fence_token: 'testing-fence-token-1',
  admission_nonce: 'testing-admission-1',
  lease_claim: {
    schema: 'talos.testing-lease-claim/v1' as const,
    ref: 'talos://testing/claims/run-1/claim-1',
    digest,
    expires_at: deadline
  },
  inputs: {
    schema_version: 'talos.testing-input-references/v1' as const,
    project_pack_snapshot: { schema: 'pql.project-pack-snapshot/v1' as const, ref: 'artifact://pql/snapshots/1', digest },
    test_selection: { schema: 'pql.test-selection/v1' as const, ref: 'artifact://pql/selections/1', digest },
    testing_design_input_set: { schema: 'pql.testing-design-input-set.v1' as const, ref: 'artifact://pql/input-sets/1', digest },
    source_revision: { repository_id: 'repo-1', exact_revision: 'b'.repeat(40), ref: 'artifact://source/archives/1', digest },
    structured_plan: { schema: 'testing-structured-plan.v2' as const, ref: 'artifact://plans/structured/1', digest },
    environment_profile: { ref: 'artifact://environments/profiles/1', digest },
    testing_package: { package_id: 'testing-browser-runner', version: '1.0.0', digest }
  },
  runner: { package_id: 'testing-browser-runner', version: '1.0.0', digest },
  policy_ref: { schema: 'talos.testing-execution-policy/v1' as const, ref: 'talos://policies/testing/1', digest },
  budgets_ref: { schema: 'talos.testing-budgets/v1' as const, ref: 'talos://budgets/testing/1', digest },
  local_request_authorization: {
    ref: 'authorization://local-qa-request/start-1',
    digest: authorizationDigest,
    expires_at: deadline
  },
  expected_runtime_capability: 'local-qa-mvp/v1' as const,
  deadline
};
const task = {
  ...taskWithoutPayloadDigest,
  task_payload_digest: computeTestingTaskPayloadDigest(taskWithoutPayloadDigest)
};

const attempt = testingRuntimeAttemptSchema.parse({
  schema_version: 'talos.testing-runtime-attempt/v1',
  operation: 'start',
  run_id: task.qa_run_id,
  task_id: task.id,
  attempt_id: task.dispatch_attempt_id,
  machine_id: task.machine_id,
  worker_id: task.worker_id,
  generation: task.generation,
  lease_id: task.lease_id,
  fence_token: task.fence_token,
  admission_nonce: task.admission_nonce,
  task_payload_digest: task.task_payload_digest,
  lease_claim: task.lease_claim,
  deadline
});

const claimIdentity = {
  schema_version: 'talos.testing-claim-identity/v1' as const,
  operation: 'start' as const,
  claim_id: 'claim-1',
  run_id: attempt.run_id,
  task_id: attempt.task_id,
  attempt_id: attempt.attempt_id,
  machine_id: attempt.machine_id,
  worker_id: attempt.worker_id,
  generation: attempt.generation,
  lease_id: attempt.lease_id,
  fence_token: attempt.fence_token,
  admission_nonce: attempt.admission_nonce,
  task_payload_digest: attempt.task_payload_digest,
  issued_at: now,
  expires_at: deadline
};
task.lease_claim.digest = computeTestingCurrentClaimDigest(claimIdentity);
const currentClaim = {
  schema_version: 'talos.testing-current-claim/v1' as const,
  claim: claimIdentity,
  claim_digest: task.lease_claim.digest,
  audience: 'local-qa-runtime' as const,
  request_nonce: 'runtime-request-nonce-1',
  is_current: true,
  status: 'current' as const,
  lease_expires_at: deadline,
  observed_at: now,
  valid_until: '2026-08-24T00:00:05.000Z',
  key_id: 'claim-key-1',
  signature: `ed25519:${'A'.repeat(86)}`
};

describe('Local QA Runtime consumer contracts', () => {
  it('accepts a pointer-only request with exact attempt, claim, authorization, and body digest binding', () => {
    const projection = {
      schema_version: 'talos.local-qa-run-request/v1' as const,
      request_id: 'start-attempt-1-1',
      idempotency_key: 'start:run-1:attempt-1:1',
      run_id: 'run-1',
      task,
      attempt: { ...attempt, lease_claim: task.lease_claim },
      current_claim: currentClaim,
      issued_at: now,
      deadline
    };
    const requestDigest = computeLocalQARunRequestDigest(projection);
    const resolution = testingAuthorizationResolutionSchema.parse({
      schema_version: 'talos.testing-authorization-resolution/v1',
      operation: 'start',
      authorization_reference: task.local_request_authorization,
      attempt: projection.attempt,
      current_claim_digest: currentClaim.claim_digest,
      http_method: 'PUT',
      canonical_path: '/v1/runs/run-1',
      body_digest: requestDigest,
      authorization,
      signature_verified: true,
      signer_key_id: 'hosted-key-1',
      verified_at: now
    });
    const request = localQARunRequestSchema.parse({
      ...projection,
      request_digest: requestDigest,
      authorization_resolution: resolution,
      authorization
    });
    expect(request.task.inputs.structured_plan.ref).toBe('artifact://plans/structured/1');
    expect(JSON.stringify(request)).not.toContain('lease-secret');
    expect(localQARunRequestSchema.safeParse({
      ...request,
      authorization_resolution: {
        ...request.authorization_resolution,
        canonical_path: '/v1/runs/another-run'
      }
    }).success).toBe(false);
  });

  it('rejects unknown fields, authorization digest mismatch, and cross-attempt current claims', () => {
    const capabilities = {
      schema_version: 'local-qa-runtime-capabilities/v1',
      adapter_contracts: ['talos.local-qa-runtime-adapter/v1'],
      runtime_capabilities: ['local-qa-mvp/v1'],
      execution_profiles: ['local_qa_agent_mvp'],
      runner_packages: [task.runner],
      max_concurrency: 1,
      limits: { max_events_per_page: 100, max_snapshot_bytes: 1024, max_event_page_bytes: 1024 }
    };
    expect(localQARuntimeCapabilitiesSchema.safeParse({ ...capabilities, executable: '/bin/sh' }).success).toBe(false);
    expect(testingAuthorizationResolutionSchema.safeParse({
      schema_version: 'talos.testing-authorization-resolution/v1',
      operation: 'start',
      authorization_reference: { ...task.local_request_authorization, digest },
      attempt,
      current_claim_digest: currentClaim.claim_digest,
      http_method: 'PUT',
      canonical_path: '/v1/runs/run-1',
      body_digest: digest,
      authorization,
      signature_verified: true,
      signer_key_id: 'hosted-key-1',
      verified_at: now
    }).success).toBe(false);
  });

  it('requires digest-bound contiguous Runtime event pages', () => {
    const eventCore = {
      schema_version: 'local-qa-runtime-event/v1' as const,
      event_ref: 'local-qa://runtime/events/1',
      run_id: 'run-1',
      sequence: 1,
      type: 'run.accepted',
      snapshot_digest: digest,
      reference_projections: [],
      created_at: now
    };
    const event = { ...eventCore, event_digest: computeLocalQARuntimeEventDigest(eventCore) };
    const page = {
      schema_version: 'local-qa-runtime-event-page/v1' as const,
      run_id: 'run-1',
      after_sequence: 0,
      events: [event],
      through_sequence: 1,
      has_more: false,
      snapshot_digest: digest
    };
    expect(localQARuntimeEventPageSchema.safeParse(page).success).toBe(true);
    expect(localQARuntimeEventPageSchema.safeParse({
      ...page,
      events: [{ ...event, event_digest: `sha256:${'b'.repeat(64)}` }]
    }).success).toBe(false);
    expect(localQARuntimeEventPageSchema.safeParse({
      ...page,
      events: [{ ...event, sequence: 2 }],
      through_sequence: 2
    }).success).toBe(false);
    expect(localQARuntimeEventPageSchema.safeParse({
      ...page,
      snapshot_digest: `sha256:${'b'.repeat(64)}`
    }).success).toBe(false);
  });

  it('rejects an already-terminal cancel acknowledgement with a non-terminal snapshot', () => {
    const snapshotCore = {
      schema_version: 'local-qa-runtime-snapshot/v1' as const,
      snapshot_ref: 'local-qa://runtime/snapshots/1',
      snapshot_version: 1,
      run_id: 'run-1',
      attempt: {
        schema_version: 'talos.testing-runtime-execution-binding/v1' as const,
        run_id: 'run-1',
        task_id: 'task-1',
        attempt_id: 'attempt-1',
        machine_id: 'machine-1',
        generation: 1,
        fence_token: 'testing-fence-token-1'
      },
      state: 'executing' as const,
      event_sequence: 0,
      progress: {
        phase: 'executing',
        completed_cases: 0,
        total_cases: 1,
        last_event_sequence: 0
      },
      updated_at: now
    };
    const snapshot = {
      ...snapshotCore,
      snapshot_digest: computeLocalQARuntimeSnapshotDigest(snapshotCore)
    };
    expect(localQACancelAckSchema.safeParse({
      schema_version: 'local-qa-runtime-cancel-ack/v1',
      run_id: 'run-1',
      request_digest: digest,
      disposition: 'already_terminal',
      snapshot,
      acknowledged_at: now
    }).success).toBe(false);
  });

  it('enforces settled Runtime outcomes and exact external terminal references', () => {
    const binding = {
      schema_version: 'talos.testing-runtime-execution-binding/v1' as const,
      run_id: attempt.run_id,
      task_id: attempt.task_id,
      attempt_id: attempt.attempt_id,
      machine_id: attempt.machine_id,
      generation: attempt.generation,
      fence_token: attempt.fence_token
    };
    const resultBinding = {
      run_id: attempt.run_id,
      task_id: attempt.task_id,
      attempt_id: attempt.attempt_id,
      generation: attempt.generation,
      fence_token: attempt.fence_token
    };
    const results = {
      schema_version: 'talos.testing-terminal-refs/v1' as const,
      binding: resultBinding,
      case_result_set: {
        schema: 'testing-case-result-set.v2' as const,
        schema_digest: digest,
        ref: 'artifact://runtime/results/set-1',
        digest,
        binding: resultBinding
      },
      evidence_manifest: {
        schema: 'testing-evidence-manifest.v1' as const,
        schema_digest: digest,
        ref: 'artifact://runtime/evidence/manifest-1',
        digest,
        binding: resultBinding
      },
      cleanup_receipt: {
        schema: 'qa.local-cleanup-receipt/v2' as const,
        schema_digest: digest,
        ref: 'artifact://runtime/cleanup/receipt-1',
        digest,
        binding: resultBinding
      }
    };
    const core = {
      schema_version: 'local-qa-runtime-snapshot/v1' as const,
      snapshot_ref: 'local-qa://runtime/snapshots/terminal-1',
      snapshot_version: 1,
      run_id: attempt.run_id,
      attempt: binding,
      state: 'terminal' as const,
      event_sequence: 1,
      progress: { phase: 'terminal', completed_cases: 1, total_cases: 1, last_event_sequence: 1 },
      execution_outcome: 'passed' as const,
      evidence_outcome: 'complete' as const,
      upload_outcome: 'uploaded' as const,
      cleanup_outcome: 'complete' as const,
      summary: { total: 1, passed: 1, failed: 0, blocked: 0, error: 0, skipped: 0, all_skipped: false },
      results,
      updated_at: now
    };
    const validates = (candidate: unknown): boolean => {
      try {
        return localQARuntimeSnapshotSchema.safeParse({
          ...(candidate as Record<string, unknown>),
          snapshot_digest: computeLocalQARuntimeSnapshotDigest(candidate)
        }).success;
      } catch {
        return false;
      }
    };
    const { summary: _summary, ...withoutSummary } = core;
    const { case_result_set: _caseResultSet, ...withoutCaseResultSet } = results;
    const { evidence_manifest: _evidenceManifest, ...withoutEvidenceManifest } = results;
    const { cleanup_receipt: _cleanupReceipt, ...withoutCleanupReceipt } = results;
    void _summary;
    void _caseResultSet;
    void _evidenceManifest;
    void _cleanupReceipt;

    expect(validates(core)).toBe(true);
    expect(validates({
      ...withoutSummary,
      execution_outcome: 'timed_out'
    })).toBe(true);
    expect(validates({
      ...core,
      execution_outcome: 'all_skipped',
      summary: { total: 2, passed: 0, failed: 0, blocked: 0, error: 0, skipped: 2, all_skipped: true }
    })).toBe(true);
    expect(validates({
      ...core,
      cleanup_outcome: 'residual_blocking'
    })).toBe(true);

    for (const unsettled of [
      { evidence_outcome: 'staging' },
      { upload_outcome: 'pending' },
      { cleanup_outcome: 'pending' }
    ]) expect(validates({ ...core, ...unsettled })).toBe(false);

    expect(validates({
      ...core,
      execution_outcome: 'passed',
      summary: { total: 1, passed: 0, failed: 0, blocked: 0, error: 0, skipped: 1, all_skipped: true }
    })).toBe(false);
    expect(validates({
      ...core,
      execution_outcome: 'all_skipped',
      summary: { total: 1, passed: 1, failed: 0, blocked: 0, error: 0, skipped: 0, all_skipped: false }
    })).toBe(false);
    expect(validates({
      ...core,
      summary: { ...core.summary, total: 2 }
    })).toBe(false);

    for (const incompleteResults of [
      withoutCaseResultSet,
      withoutEvidenceManifest,
      withoutCleanupReceipt
    ]) expect(validates({ ...core, results: incompleteResults })).toBe(false);
    expect(validates({
      ...core,
      cleanup_outcome: 'residual_blocking',
      results: withoutCleanupReceipt
    })).toBe(false);
  });
});
