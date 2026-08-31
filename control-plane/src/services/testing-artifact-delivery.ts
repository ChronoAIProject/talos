import { createHash } from 'node:crypto';
import {
  canonicalJson,
  computeTestingArtifactStableObjectKey,
  testingArtifactCommitRequestSchema,
  testingArtifactCommitResponseSchema,
  testingArtifactLookupRequestSchema,
  testingArtifactLookupResponseSchema,
  testingArtifactPrepareRequestSchema,
  testingArtifactPrepareResponseSchema,
  type TestingArtifactAuthority,
  type TestingArtifactCommitRequest,
  type TestingArtifactCommitResponse,
  type TestingArtifactDescriptor,
  type TestingArtifactLookupRequest,
  type TestingArtifactLookupResponse,
  type TestingArtifactPrepareRequest,
  type TestingArtifactPrepareResponse
} from '@talos/testing-protocol';
import { TalosError } from '../domain/errors.js';

export type TestingArtifactOperation = 'prepare' | 'commit' | 'lookup';

export interface TestingArtifactAuthorityVerification {
  readonly schemaVersion: 'talos.testing-artifact-authority-verification/v1';
  readonly operation: TestingArtifactOperation;
  readonly authorityDigest: string;
  readonly verifiedAt: string;
}

export interface TestingArtifactAuthorityVerifier {
  verify(
    operation: TestingArtifactOperation,
    authority: TestingArtifactAuthority
  ): Promise<TestingArtifactAuthorityVerification | undefined>;
}

export interface TestingArtifactStoreProvider {
  prepare(request: TestingArtifactPrepareRequest): Promise<unknown>;
  commit(request: TestingArtifactCommitRequest): Promise<unknown>;
  lookup(request: TestingArtifactLookupRequest): Promise<unknown>;
}

export class TestingArtifactDeliveryConsumer {
  public constructor(
    private readonly provider: TestingArtifactStoreProvider,
    private readonly authority: TestingArtifactAuthorityVerifier,
    private readonly clock: () => number = Date.now
  ) {}

  public async prepare(input: unknown): Promise<TestingArtifactPrepareResponse> {
    const request = testingArtifactPrepareRequestSchema.parse(input);
    await this.requireAuthority('prepare', request.authority);
    if (Date.parse(request.authority.claim.expires_at) <= this.clock()) {
      throw new TalosError('stale_testing_artifact_claim', 'artifact prepare claim is expired', 409);
    }
    const response = await this.providerCall(
      () => this.provider.prepare(request),
      (value) => testingArtifactPrepareResponseSchema.parse(value)
    );
    const grant = response.upload_grant;
    this.assertStableObjectKey(response.stable_object_key, request.authority, request.artifact);
    this.assertExact(grant.authority, request.authority, 'artifact_authority_mismatch');
    this.assertExact(grant.artifact, request.artifact, 'artifact_descriptor_mismatch');
    if (
      grant.idempotency_key !== request.idempotency_key ||
      grant.prepare_request_digest !== request.request_digest ||
      grant.allowed_path !== `/v1/testing/artifacts/${encodeURIComponent(response.stable_object_key)}:upload` ||
      Date.parse(grant.not_before) > this.clock() ||
      Date.parse(grant.expires_at) <= this.clock() ||
      Date.parse(grant.expires_at) > Date.parse(request.authority.claim.expires_at)
    ) throw new TalosError('invalid_testing_artifact_grant', 'artifact upload grant is not bound and current', 502);
    return response;
  }

  public async commit(input: unknown): Promise<TestingArtifactCommitResponse> {
    const request = testingArtifactCommitRequestSchema.parse(input);
    await this.requireAuthority('commit', request.authority);
    if (Date.parse(request.authority.claim.expires_at) <= this.clock()) {
      throw new TalosError('stale_testing_artifact_claim', 'artifact commit claim is expired', 409);
    }
    this.assertStableObjectKey(request.stable_object_key, request.authority, request.artifact);
    const response = await this.providerCall(
      () => this.provider.commit(request),
      (value) => testingArtifactCommitResponseSchema.parse(value)
    );
    this.assertReceipt(response.ingest_receipt, request);
    if (response.artifact.digest !== request.artifact.digest) {
      throw new TalosError('artifact_integrity_conflict', 'artifact pointer digest differs from committed bytes', 409);
    }
    return response;
  }

  public async lookup(input: unknown): Promise<TestingArtifactLookupResponse> {
    const request = testingArtifactLookupRequestSchema.parse(input);
    await this.requireAuthority('lookup', request.authority);
    this.assertStableObjectKey(request.stable_object_key, request.authority, request.artifact);
    const response = await this.providerCall(
      () => this.provider.lookup(request),
      (value) => testingArtifactLookupResponseSchema.parse(value)
    );
    if (response.stable_object_key !== request.stable_object_key) {
      throw new TalosError('artifact_identity_conflict', 'artifact lookup returned another object key', 409);
    }
    if (response.disposition === 'found') {
      this.assertReceipt(response.ingest_receipt, request);
      if (response.artifact.digest !== request.artifact.digest) {
        throw new TalosError('artifact_integrity_conflict', 'artifact lookup digest differs from requested bytes', 409);
      }
    }
    return response;
  }

  private async requireAuthority(
    operation: TestingArtifactOperation,
    authority: TestingArtifactAuthority
  ): Promise<void> {
    let verification: TestingArtifactAuthorityVerification | undefined;
    try {
      verification = await this.authority.verify(operation, authority);
    } catch {
      throw new TalosError('testing_artifact_authority_unavailable', 'artifact authority verifier is unavailable', 503);
    }
    if (
      verification === undefined || verification.operation !== operation ||
      verification.schemaVersion !== 'talos.testing-artifact-authority-verification/v1' ||
      verification.authorityDigest !== this.authorityDigest(authority)
    ) throw new TalosError('stale_testing_artifact_authority', 'artifact operation authority is not current', 409);
  }

  private async providerCall<T>(call: () => Promise<unknown>, parse: (value: unknown) => T): Promise<T> {
    let raw: unknown;
    try {
      raw = await call();
    } catch {
      throw new TalosError('testing_artifact_store_unavailable', 'artifact store is unavailable', 503);
    }
    try {
      return parse(raw);
    } catch {
      throw new TalosError('invalid_testing_artifact_response', 'artifact store returned an invalid bounded response', 502);
    }
  }

  private assertReceipt(
    receipt: {
      stable_object_key: string;
      idempotency_key: string;
      authority: TestingArtifactAuthority;
      artifact: TestingArtifactDescriptor;
      provider_object_version: string;
      commit_request_digest: string;
    },
    request: TestingArtifactCommitRequest | TestingArtifactLookupRequest
  ): void {
    this.assertExact(receipt.authority, request.authority, 'artifact_authority_mismatch');
    this.assertExact(receipt.artifact, request.artifact, 'artifact_descriptor_mismatch');
    if (receipt.stable_object_key !== request.stable_object_key || receipt.idempotency_key !== request.idempotency_key) {
      throw new TalosError('artifact_identity_conflict', 'artifact receipt is bound to another object identity', 409);
    }
    if ('request_digest' in request && (
      receipt.commit_request_digest !== request.request_digest ||
      receipt.provider_object_version !== request.provider_object_version
    )) throw new TalosError('artifact_integrity_conflict', 'artifact receipt does not match the commit request', 409);
  }

  private assertExact(actual: unknown, expected: unknown, code: string): void {
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new TalosError(code, 'artifact response binding differs from the exact request', 409);
    }
  }

  private assertStableObjectKey(
    actual: string,
    authority: TestingArtifactAuthority,
    artifact: TestingArtifactDescriptor
  ): void {
    if (actual !== computeTestingArtifactStableObjectKey(authority, artifact)) {
      throw new TalosError('artifact_identity_conflict', 'artifact object key is bound to another run or evidence', 409);
    }
  }

  private authorityDigest(authority: TestingArtifactAuthority): string {
    return `sha256:${createHash('sha256').update(canonicalJson(authority)).digest('hex')}`;
  }
}
