import { describe, expect, it } from 'vitest';
import {
  computeTestingArtifactCommitRequestDigest,
  computeTestingArtifactPrepareRequestDigest,
  computeTestingArtifactStableObjectKey,
  testingArtifactCommitRequestSchema,
  testingArtifactLookupRequestSchema,
  testingArtifactPrepareRequestSchema,
  testingArtifactPrepareResponseSchema
} from './testing-artifact-store.js';

const digest = `sha256:${'a'.repeat(64)}`;
const now = '2026-08-24T00:00:00.000Z';
const deadline = '2026-08-24T00:10:00.000Z';
const authority = {
  binding: {
    run_id: 'run-1',
    task_id: 'task-1',
    attempt_id: 'attempt-1',
    generation: 1,
    fence_token: 'testing-fence-token-1'
  },
  machine_id: 'machine-1',
  runtime_instance_id: 'runtime-instance-1',
  subject: 'runtime-installation-1',
  audience: 'testing-artifact-store' as const,
  claim: {
    schema: 'talos.testing-lease-claim/v1' as const,
    ref: 'talos://testing/claims/run-1/claim-1',
    digest,
    expires_at: deadline
  }
};
const artifact = {
  evidence_id: 'evidence-1',
  role: 'evidence_png' as const,
  media_type: 'image/png' as const,
  size: 1_024,
  digest
};

describe('Testing ArtifactStore consumer contracts', () => {
  it('binds prepare, commit, and lookup requests without raw bytes or provider credentials', () => {
    const prepareCore = {
      schema_version: 'talos.testing-artifact-prepare-request/v1' as const,
      idempotency_key: 'prepare-run-1-evidence-1',
      authority,
      artifact
    };
    const prepare = testingArtifactPrepareRequestSchema.parse({
      ...prepareCore,
      request_digest: computeTestingArtifactPrepareRequestDigest(prepareCore)
    });
    const commitCore = {
      schema_version: 'talos.testing-artifact-commit-request/v1' as const,
      idempotency_key: prepare.idempotency_key,
      authority,
      artifact,
      stable_object_key: 'qa/run-1/attempt-1/evidence-1',
      prepare_request_digest: prepare.request_digest,
      provider_object_version: 'provider-version-1'
    };
    expect(testingArtifactCommitRequestSchema.safeParse({
      ...commitCore,
      request_digest: computeTestingArtifactCommitRequestDigest(commitCore)
    }).success).toBe(true);
    expect(testingArtifactLookupRequestSchema.safeParse({
      schema_version: 'talos.testing-artifact-lookup-request/v1',
      stable_object_key: commitCore.stable_object_key,
      idempotency_key: prepare.idempotency_key,
      authority,
      artifact
    }).success).toBe(true);
    expect(computeTestingArtifactStableObjectKey(authority, artifact))
      .toBe('qa/run-1/attempt-1/evidence-1');
    expect(testingArtifactPrepareRequestSchema.safeParse({
      ...prepare,
      bytes: 'raw-base64',
      provider_credential: 'provider-secret'
    }).success).toBe(false);
    expect(testingArtifactPrepareRequestSchema.safeParse({
      ...prepareCore,
      authority: {
        ...authority,
        binding: { ...authority.binding, run_id: 'run-2' }
      },
      request_digest: prepare.request_digest
    }).success).toBe(false);
  });

  it('rejects media/role mismatches, oversized JSON, unknown grant fields, and digest drift', () => {
    const prepareCore = {
      schema_version: 'talos.testing-artifact-prepare-request/v1' as const,
      idempotency_key: 'prepare-run-1-evidence-1',
      authority,
      artifact
    };
    const requestDigest = computeTestingArtifactPrepareRequestDigest(prepareCore);
    expect(testingArtifactPrepareRequestSchema.safeParse({
      ...prepareCore,
      artifact: { ...artifact, media_type: 'application/vnd.fkst.testing.sanitized+json' },
      request_digest: requestDigest
    }).success).toBe(false);
    expect(testingArtifactPrepareRequestSchema.safeParse({
      ...prepareCore,
      artifact: {
        ...artifact,
        role: 'sanitized_json',
        media_type: 'application/vnd.fkst.testing.sanitized+json',
        size: 1_048_577
      },
      request_digest: requestDigest
    }).success).toBe(false);
    expect(testingArtifactPrepareRequestSchema.safeParse({
      ...prepareCore,
      request_digest: `sha256:${'b'.repeat(64)}`
    }).success).toBe(false);

    const grant = {
      schema_version: 'talos.testing-artifact-upload-grant/v1',
      grant_ref: 'authorization://testing-artifacts/grants/grant-1',
      grant_digest: digest,
      stable_object_key: 'qa/run-1/attempt-1/evidence-1',
      prepare_request_digest: requestDigest,
      idempotency_key: prepareCore.idempotency_key,
      authority,
      artifact,
      allowed_method: 'PUT',
      allowed_path: '/v1/testing/artifacts/qa%2Frun-1%2Fattempt-1%2Fevidence-1:upload',
      nonce: 'artifact-grant-nonce-1',
      not_before: now,
      expires_at: deadline
    };
    expect(testingArtifactPrepareResponseSchema.safeParse({
      schema_version: 'talos.testing-artifact-prepare-response/v1',
      stable_object_key: grant.stable_object_key,
      upload_grant: { ...grant, provider_credential: 'must-not-cross' }
    }).success).toBe(false);
  });
});
