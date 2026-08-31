import { describe, expect, it } from 'vitest';
import {
  computeTestingArtifactCommitRequestDigest,
  computeTestingArtifactPrepareRequestDigest,
  digestJson,
  type TestingArtifactAuthority,
  type TestingArtifactCommitRequest,
  type TestingArtifactLookupRequest,
  type TestingArtifactPrepareRequest
} from '@talos/testing-protocol';
import {
  TestingArtifactDeliveryConsumer,
  type TestingArtifactAuthorityVerifier,
  type TestingArtifactStoreProvider
} from './testing-artifact-delivery.js';

const digest = `sha256:${'a'.repeat(64)}`;
const now = Date.parse('2026-08-24T00:00:00.000Z');
const deadline = '2026-08-24T00:10:00.000Z';
const authority: TestingArtifactAuthority = {
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
  audience: 'testing-artifact-store',
  claim: {
    schema: 'talos.testing-lease-claim/v1',
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
const prepareRequest = (): TestingArtifactPrepareRequest => {
  const core = {
    schema_version: 'talos.testing-artifact-prepare-request/v1' as const,
    idempotency_key: 'artifact-run-1-evidence-1',
    authority: structuredClone(authority),
    artifact: structuredClone(artifact)
  };
  return { ...core, request_digest: computeTestingArtifactPrepareRequestDigest(core) };
};
const commitRequest = (prepare: TestingArtifactPrepareRequest): TestingArtifactCommitRequest => {
  const core = {
    schema_version: 'talos.testing-artifact-commit-request/v1' as const,
    idempotency_key: prepare.idempotency_key,
    authority: prepare.authority,
    artifact: prepare.artifact,
    stable_object_key: 'qa/run-1/attempt-1/evidence-1',
    prepare_request_digest: prepare.request_digest,
    provider_object_version: 'provider-version-1'
  };
  return { ...core, request_digest: computeTestingArtifactCommitRequestDigest(core) };
};
const lookupRequest = (): TestingArtifactLookupRequest => ({
  schema_version: 'talos.testing-artifact-lookup-request/v1',
  stable_object_key: 'qa/run-1/attempt-1/evidence-1',
  idempotency_key: 'artifact-run-1-evidence-1',
  authority: structuredClone(authority),
  artifact: structuredClone(artifact)
});
const verifier = (accept = true): TestingArtifactAuthorityVerifier => ({
  verify: async (operation, currentAuthority) => accept ? {
    schemaVersion: 'talos.testing-artifact-authority-verification/v1',
    operation,
    authorityDigest: digestJson(currentAuthority),
    verifiedAt: new Date(now).toISOString()
  } : undefined
});
const receipt = (request: TestingArtifactCommitRequest) => ({
  schema_version: 'talos.testing-artifact-ingest-receipt/v1' as const,
  receipt_ref: 'artifact://testing/ingest-receipts/receipt-1',
  receipt_digest: digest,
  stable_object_key: request.stable_object_key,
  commit_request_digest: request.request_digest,
  idempotency_key: request.idempotency_key,
  authority: request.authority,
  artifact: request.artifact,
  provider_object_version: request.provider_object_version,
  committed_at: new Date(now).toISOString()
});
const committed = (request: TestingArtifactCommitRequest) => ({
  schema_version: 'talos.testing-artifact-commit-response/v1' as const,
  artifact: {
    schema: 'testing-evidence-object/v1' as const,
    ref: 'artifact://testing/evidence/evidence-1',
    digest: request.artifact.digest
  },
  ingest_receipt: structuredClone(receipt(request))
});

describe('TestingArtifactDeliveryConsumer', () => {
  it('recovers a lost commit acknowledgement through exact lookup without another commit', async () => {
    const prepare = prepareRequest();
    const commit = commitRequest(prepare);
    let stored: ReturnType<typeof committed> | undefined;
    let commitCalls = 0;
    const provider: TestingArtifactStoreProvider = {
      prepare: async (request) => ({
        schema_version: 'talos.testing-artifact-prepare-response/v1',
        stable_object_key: commit.stable_object_key,
        upload_grant: {
          schema_version: 'talos.testing-artifact-upload-grant/v1',
          grant_ref: 'authorization://testing-artifacts/grants/grant-1',
          grant_digest: digest,
          stable_object_key: commit.stable_object_key,
          prepare_request_digest: request.request_digest,
          idempotency_key: request.idempotency_key,
          authority: request.authority,
          artifact: request.artifact,
          allowed_method: 'PUT',
          allowed_path: '/v1/testing/artifacts/qa%2Frun-1%2Fattempt-1%2Fevidence-1:upload',
          nonce: 'artifact-grant-nonce-1',
          not_before: new Date(now).toISOString(),
          expires_at: deadline
        }
      }),
      commit: async (request) => {
        commitCalls += 1;
        stored = committed(request);
        throw new Error('acknowledgement lost');
      },
      lookup: async (request) => stored === undefined ? {
        schema_version: 'talos.testing-artifact-lookup-response/v1',
        disposition: 'not_found',
        stable_object_key: request.stable_object_key
      } : {
        schema_version: 'talos.testing-artifact-lookup-response/v1',
        disposition: 'found',
        stable_object_key: request.stable_object_key,
        artifact: stored.artifact,
        ingest_receipt: stored.ingest_receipt
      }
    };
    const consumer = new TestingArtifactDeliveryConsumer(provider, verifier(), () => now);
    await expect(consumer.prepare(prepare)).resolves.toMatchObject({ stable_object_key: commit.stable_object_key });
    await expect(consumer.commit(commit)).rejects.toMatchObject({ code: 'testing_artifact_store_unavailable' });
    await expect(consumer.lookup(lookupRequest())).resolves.toMatchObject({
      disposition: 'found',
      artifact: { digest }
    });
    expect(commitCalls).toBe(1);
  });

  it('fails closed on stale fence authority before contacting the provider', async () => {
    let calls = 0;
    const provider: TestingArtifactStoreProvider = {
      prepare: async () => { calls += 1; return {}; },
      commit: async () => { calls += 1; return {}; },
      lookup: async () => { calls += 1; return {}; }
    };
    const stale = prepareRequest();
    stale.authority.binding.fence_token = 'testing-stale-fence-token-1';
    const core = { ...stale };
    delete (core as Partial<TestingArtifactPrepareRequest>).request_digest;
    stale.request_digest = computeTestingArtifactPrepareRequestDigest(core);
    const consumer = new TestingArtifactDeliveryConsumer(provider, verifier(false), () => now);
    await expect(consumer.prepare(stale)).rejects.toMatchObject({ code: 'stale_testing_artifact_authority' });
    expect(calls).toBe(0);
  });

  it('rejects object keys bound to another run before contacting the provider', async () => {
    let calls = 0;
    const provider: TestingArtifactStoreProvider = {
      prepare: async () => { calls += 1; return {}; },
      commit: async () => { calls += 1; return {}; },
      lookup: async () => { calls += 1; return {}; }
    };
    const prepare = prepareRequest();
    const commit = commitRequest(prepare);
    commit.stable_object_key = 'qa/run-2/attempt-1/evidence-1';
    const core = { ...commit };
    delete (core as Partial<TestingArtifactCommitRequest>).request_digest;
    commit.request_digest = computeTestingArtifactCommitRequestDigest(core);
    const consumer = new TestingArtifactDeliveryConsumer(provider, verifier(), () => now);
    await expect(consumer.commit(commit)).rejects.toMatchObject({ code: 'artifact_identity_conflict' });
    await expect(consumer.lookup({
      ...lookupRequest(),
      stable_object_key: 'qa/run-2/attempt-1/evidence-1'
    })).rejects.toMatchObject({ code: 'artifact_identity_conflict' });
    expect(calls).toBe(0);
  });

  it('rejects upload grants with another object path or a lifetime beyond the claim', async () => {
    const prepare = prepareRequest();
    const response = (expiresAt: string, allowedPath: string) => ({
      schema_version: 'talos.testing-artifact-prepare-response/v1',
      stable_object_key: 'qa/run-1/attempt-1/evidence-1',
      upload_grant: {
        schema_version: 'talos.testing-artifact-upload-grant/v1',
        grant_ref: 'authorization://testing-artifacts/grants/grant-1',
        grant_digest: digest,
        stable_object_key: 'qa/run-1/attempt-1/evidence-1',
        prepare_request_digest: prepare.request_digest,
        idempotency_key: prepare.idempotency_key,
        authority: prepare.authority,
        artifact: prepare.artifact,
        allowed_method: 'PUT',
        allowed_path: allowedPath,
        nonce: 'artifact-grant-nonce-1',
        not_before: new Date(now).toISOString(),
        expires_at: expiresAt
      }
    });
    for (const invalidResponse of [
      response(deadline, '/v1/testing/artifacts/qa%2Frun-2%2Fattempt-1%2Fevidence-1:upload'),
      response('2026-08-24T00:11:00.000Z', '/v1/testing/artifacts/qa%2Frun-1%2Fattempt-1%2Fevidence-1:upload')
    ]) {
      const provider: TestingArtifactStoreProvider = {
        prepare: async () => invalidResponse,
        commit: async () => { throw new Error('not used'); },
        lookup: async () => { throw new Error('not used'); }
      };
      await expect(new TestingArtifactDeliveryConsumer(provider, verifier(), () => now).prepare(prepare))
        .rejects.toMatchObject({ code: 'invalid_testing_artifact_grant' });
    }
  });

  it.each([
    ['cross-run authority', (response: ReturnType<typeof committed>) => {
      response.ingest_receipt.authority.binding.run_id = 'run-2';
      response.ingest_receipt.authority.claim.ref = 'talos://testing/claims/run-2/claim-1';
    }, 'artifact_authority_mismatch'],
    ['digest mismatch', (response: ReturnType<typeof committed>) => {
      response.ingest_receipt.artifact.digest = `sha256:${'b'.repeat(64)}`;
    }, 'artifact_descriptor_mismatch'],
    ['media mismatch', (response: ReturnType<typeof committed>) => {
      response.ingest_receipt.artifact.media_type = 'application/vnd.fkst.testing.sanitized+json';
    }, 'invalid_testing_artifact_response'],
    ['size mismatch', (response: ReturnType<typeof committed>) => {
      response.ingest_receipt.artifact.size += 1;
    }, 'artifact_descriptor_mismatch']
  ])('rejects %s in commit receipts', async (_name, mutate, code) => {
    const prepare = prepareRequest();
    const commit = commitRequest(prepare);
    const response = committed(commit);
    mutate(response);
    const provider: TestingArtifactStoreProvider = {
      prepare: async () => { throw new Error('not used'); },
      commit: async () => response,
      lookup: async () => { throw new Error('not used'); }
    };
    await expect(new TestingArtifactDeliveryConsumer(provider, verifier(), () => now).commit(commit))
      .rejects.toMatchObject({ code });
  });
});
