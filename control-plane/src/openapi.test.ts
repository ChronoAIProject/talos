import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultOpenApiPath, loadOpenApiDocument } from './openapi.js';

const asObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected object');
  return value as Record<string, unknown>;
};

describe('OpenAPI loader', () => {
  it('loads and converts the repository spec once', () => {
    const document = loadOpenApiDocument();
    expect(defaultOpenApiPath).toContain('specs/talos-openapi.yaml');
    const parsed = JSON.parse(document.json) as {
      openapi: string;
      paths: Record<string, Record<string, { operationId?: string }>>;
      components: { schemas: Record<string, unknown>; parameters: Record<string, unknown> };
    };
    expect(parsed).toMatchObject({ openapi: '3.1.0' });
    const operationId = (path: string, method: string): string | undefined =>
      parsed.paths[path]?.[method]?.operationId;
    expect([
      operationId('/v1/tools/testing/capabilities', 'get'),
      operationId('/v1/tools/testing/runs/{run_id}', 'put'),
      operationId('/v1/tools/testing/runs/{run_id}', 'get'),
      operationId('/v1/tools/testing/runs/{run_id}/events', 'get'),
      operationId('/v1/tools/testing/runs/{run_id}:cancel', 'post')
    ]).toEqual([
      'getTestingCapabilities',
      'submitTestingRun',
      'getTestingRun',
      'listTestingRunEvents',
      'cancelTestingRun'
    ]);
    expect(Object.keys(parsed.paths).filter((path) => path.startsWith('/v1/tools/testing'))).toEqual([
      '/v1/tools/testing/capabilities',
      '/v1/tools/testing/runs/{run_id}',
      '/v1/tools/testing/runs/{run_id}/events',
      '/v1/tools/testing/runs/{run_id}:cancel'
    ]);
    expect([
      operationId('/v1/worker/testing/claim', 'post'),
      operationId('/v1/worker/testing/reconcile-claim', 'post'),
      operationId('/v1/worker/testing/runs/{run_id}/heartbeat', 'post'),
      operationId('/v1/worker/testing/runs/{run_id}/local-accept', 'post'),
      operationId('/v1/worker/testing/runs/{run_id}/running', 'post'),
      operationId('/v1/worker/testing/runs/{run_id}/result', 'post'),
      operationId('/v1/worker/testing/runs/{run_id}/reconcile-claim', 'post'),
      operationId('/v1/worker/testing/runs/{run_id}/reconcile', 'post'),
      operationId('/v1/worker/testing/runs/{run_id}/not-accepted', 'post'),
      operationId('/v1/worker/testing/claims/{run_id}/{claim_id}', 'get'),
      operationId('/v1/testing/claims/{run_id}/{claim_id}/resolve', 'post')
    ]).toEqual([
      'claimTestingRun',
      'claimNextTestingReconcile',
      'heartbeatTestingAttempt',
      'acceptTestingAttemptLocally',
      'startTestingAttempt',
      'commitTestingAttemptResult',
      'claimTestingReconcile',
      'reconcileTestingAttempt',
      'confirmTestingNotLocallyAccepted',
      'resolveTestingCurrentClaim',
      'resolveTestingCurrentClaimForRuntime'
    ]);
    for (const schema of ['TestingCapabilities', 'TestingToolRequest', 'TestingRunAcceptance', 'TestingRunSnapshot', 'TestingEventPage', 'TestingCancelRequest', 'TestingCancelAck', 'TestingTask']) {
      expect(parsed.components.schemas).toHaveProperty(schema);
    }
    const schema = (name: string): Record<string, unknown> => asObject(parsed.components.schemas[name]);
    const properties = (name: string): Record<string, unknown> => asObject(schema(name).properties);
    for (const strictSchema of [
      'TestingToolRequest',
      'TestingCapabilities',
      'TestingAdmissionAvailability',
      'TestingBackendAvailability',
      'TestingRunnerPackageCapability',
      'TestingExternalSchemaIdentity',
      'TestingExternalSchemaCapability',
      'TestingAuthenticatedTransportContext',
      'NyxIdPointer',
      'NyxIdRoutePointer',
      'NyxIdAuthorizationPointer',
      'TestingRunAcceptance',
      'TestingPolicyBinding',
      'TestingPolicyReference',
      'TestingBudgetsReference',
      'TestingRunSnapshot',
      'TestingRunAttempt',
      'TestingRunRuntimeProvenance',
      'TestingTerminalReason',
      'TestingRecoverableBlocking',
      'TestingRunProgress',
      'TestingRunSummary',
      'TestingTerminalRefs',
      'TestingSafeError',
      'TestingRunEvent',
      'TestingTask',
      'LocalRequestAuthorizationReference',
      'TestingLeaseClaimReference',
      'TestingCurrentClaimIdentity',
      'TestingCurrentClaimEnvelope',
      'TestingCurrentClaimResolveRequest',
      'TestingWorkerClaim',
      'TestingReconcileTask',
      'TestingReconcileClaimResponse',
      'TestingNoLocalAcceptanceFact',
      'TestingNoLocalAcceptanceRequest',
      'TestingReconcileClosure',
      'TestingAttemptBindingRequest',
      'TestingHeartbeatRequest',
      'TestingHeartbeatResponse',
      'TestingClaimResponse',
      'TestingTerminalCommitRequest',
      'TestingWorkerMutationAck'
    ]) {
      expect(schema(strictSchema).additionalProperties, strictSchema).toBe(false);
    }
    expect(schema('TestingRunIdValue').pattern).toBe('^[A-Za-z0-9][A-Za-z0-9._-]*$');
    expect(schema('IdempotencyKey').pattern).toBe('^[A-Za-z0-9][A-Za-z0-9._:-]*$');
    expect(schema('ArtifactReference')).toMatchObject({ minLength: 1, maxLength: 2048 });
    expect(schema('TestingCancelReason').enum).toEqual([
      'user_requested',
      'deadline_exceeded',
      'authorization_revoked',
      'policy_revoked',
      'system_shutdown'
    ]);
    expect(schema('TestingToolRequest').required).toEqual(expect.arrayContaining([
      'request_id', 'client_correlation_id', 'idempotency_key', 'policy_binding'
    ]));
    expect(schema('TestingCapabilities').required).toEqual(expect.arrayContaining([
      'operations', 'observed_at', 'valid_until', 'scope', 'admission_availability', 'backend_availability',
      'runner_packages', 'runner_packages_total_count', 'runner_packages_truncated',
      'external_schema_capabilities', 'error_contract'
    ]));
    expect(asObject(properties('TestingCapabilities').operations).prefixItems).toEqual([
      { const: 'get_capabilities' },
      { const: 'submit' },
      { const: 'get' },
      { const: 'events' },
      { const: 'cancel' }
    ]);
    expect(schema('PublicErrorDetail').required).toEqual(['code', 'message', 'retryable']);
    expect(schema('TaskError').required).toEqual(['code', 'message']);
    const testingResponseCodes = (path: string, method: string): string[] =>
      Object.keys(asObject(asObject(parsed.paths[path]?.[method]).responses));
    expect(testingResponseCodes('/v1/tools/testing/capabilities', 'get'))
      .toEqual(['200', '401', '500']);
    expect(testingResponseCodes('/v1/tools/testing/runs/{run_id}', 'put'))
      .toEqual(['200', '201', '400', '401', '403', '409', '413', '500', '503']);
    expect(testingResponseCodes('/v1/tools/testing/runs/{run_id}', 'get'))
      .toEqual(['200', '400', '401', '403', '404', '500']);
    expect(testingResponseCodes('/v1/tools/testing/runs/{run_id}/events', 'get'))
      .toEqual(['200', '400', '401', '403', '404', '409', '410', '500']);
    expect(testingResponseCodes('/v1/tools/testing/runs/{run_id}:cancel', 'post'))
      .toEqual(['200', '400', '401', '403', '404', '409', '413', '500']);
    const externalCapabilities = asObject(properties('TestingCapabilities').external_schema_capabilities);
    const externalPrefixItems = externalCapabilities.prefixItems as unknown[];
    expect(externalPrefixItems.map((item) => {
      const allOf = asObject(item).allOf as unknown[];
      const specialized = asObject(allOf[1]);
      const specializedProperties = asObject(specialized.properties);
      return [asObject(specializedProperties.contract).const, asObject(specializedProperties.owner).const];
    })).toEqual([
      ['action', 'testing-packages'],
      ['observation', 'testing-packages'],
      ['assertion', 'testing-packages'],
      ['case_result_set', 'testing-packages'],
      ['evidence_manifest', 'local-qa-runtime'],
      ['cleanup_receipt', 'local-qa-runtime']
    ]);
    expect(schema('TestingRunAcceptance').required).toEqual(expect.arrayContaining([
      'request_id', 'client_correlation_id', 'authenticated_transport'
    ]));
    expect(schema('TestingRunSnapshot').required).toEqual(expect.arrayContaining([
      'request_id', 'client_correlation_id', 'authenticated_transport', 'inputs', 'terminal',
      'terminal_reason', 'blocking'
    ]));
    expect(schema('TestingRunAttempt').required).toEqual(expect.arrayContaining([
      'attempt_id', 'task_id', 'generation', 'machine_id', 'worker_id', 'runtime'
    ]));
    expect(schema('TestingRunSummary').required).toEqual([
      'total', 'passed', 'failed', 'blocked', 'error', 'skipped', 'all_skipped'
    ]);
    expect(schema('TestingRunSubmittedData').required).toEqual(expect.arrayContaining([
      'request_id', 'client_correlation_id', 'request_digest', 'authenticated_transport'
    ]));
    expect(schema('TestingTask').required).toContain('budgets_ref');
    expect(schema('TestingTask').required).toEqual(expect.arrayContaining([
      'worker_id', 'lease_id', 'fence_token', 'admission_nonce', 'lease_claim', 'task_payload_digest'
    ]));
    expect(schema('TestingCurrentClaimIdentity').required).toEqual(expect.arrayContaining([
      'operation', 'admission_nonce', 'task_payload_digest'
    ]));
    expect(schema('TestingReconcileTask').required).toContain('task_payload_digest');
    for (const referenceSchema of [
      'TestingCaseResultSetReference',
      'TestingEvidenceManifestReference',
      'TestingCleanupReceiptReference'
    ]) expect(schema(referenceSchema).required).toContain('schema_digest');
    const snapshotConditions = schema('TestingRunSnapshot').allOf as unknown[];
    const settledProperties = asObject(asObject(asObject(snapshotConditions[1]).then).properties);
    expect(settledProperties.summary).toEqual({ $ref: '#/components/schemas/TestingRunSummary' });
    expect(JSON.stringify(snapshotConditions[2])).toContain('"all_skipped":{"const":true}');
    expect(JSON.stringify(snapshotConditions[3])).toContain('"all_skipped":{"const":false}');
    expect(schema('TestingCurrentClaimEnvelope').required).toEqual(expect.arrayContaining([
      'audience', 'request_nonce', 'lease_expires_at', 'valid_until', 'key_id'
    ]));
    expect(schema('TestingNoLocalAcceptanceFact').required).toEqual(expect.arrayContaining([
      'start_claim_digest',
      'reconcile_claim_id',
      'reconcile_lease_id',
      'reconcile_claim_digest',
      'journal_version',
      'disposition'
    ]));
    expect(asObject(properties('TestingCurrentClaimEnvelope').signature).pattern)
      .toBe('^ed25519:[A-Za-z0-9_-]{86}$');
    const runtimeResolver = asObject(parsed.paths['/v1/testing/claims/{run_id}/{claim_id}/resolve']);
    expect(asObject(runtimeResolver.post).security).toEqual([]);
    expect(asObject(properties('TestingRunSnapshot').results).oneOf).toEqual([
      { type: 'null' },
      { $ref: '#/components/schemas/TestingTerminalRefs' }
    ]);
    expect(asObject(properties('TestingEventPage').events).items).toEqual({
      $ref: '#/components/schemas/TestingRunEvent'
    });
    expect(asObject(properties('TestingRunEvent').type).enum).toContain('run.terminal_projection_updated');
    const eventVariants = schema('TestingRunEvent').oneOf as unknown[];
    expect(eventVariants).toHaveLength(14);
    expect(eventVariants).toContainEqual({
      properties: {
        type: { const: 'run.terminal_projection_updated' },
        data: { $ref: '#/components/schemas/TestingRunTerminalProjectionUpdatedData' }
      }
    });
    for (const eventData of [
      'TestingRunSubmittedData',
      'TestingRunReservedData',
      'TestingAttemptClaimedData',
      'TestingAttemptReleasedData',
      'TestingAttemptAcceptedData',
      'TestingRunCancelRequestedData',
      'TestingRunReasonData',
      'TestingRunReconcileData',
      'TestingRunCompletedData',
      'TestingRunFailedData',
      'TestingRunCancelledData',
      'TestingRunTerminalProjectionUpdatedData'
    ]) {
      expect(schema(eventData).additionalProperties, eventData).toBe(false);
    }
    expect(schema('TestingTerminalExecutionOutcome').enum).not.toContain('executing');
    expect(schema('TestingExecutionOutcome').enum).toEqual(expect.arrayContaining(['timed_out', 'all_skipped']));
    expect(schema('TestingTerminalExecutionOutcome').enum).toEqual(expect.arrayContaining(['timed_out', 'all_skipped']));
    expect(schema('TestingUploadOutcome').enum).toContain('failed');
    expect(schema('TestingTerminalEvidenceOutcome').enum).not.toContain('staging');
    expect(schema('TestingTerminalCleanupOutcome').enum).not.toContain('pending');
    expect(asObject(properties('TestingRunCompletedData').execution_outcome)).toEqual({
      $ref: '#/components/schemas/TestingTerminalExecutionOutcome'
    });
    expect(asObject(properties('TestingRunCancelledData').cleanup_outcome)).toEqual({
      $ref: '#/components/schemas/TestingTerminalCleanupOutcome'
    });
    expect(asObject(properties('TestingTerminalCommitRequest').execution_outcome)).toEqual({
      $ref: '#/components/schemas/TestingTerminalExecutionOutcome'
    });
    expect(asObject(properties('TestingTerminalCommitRequest').evidence_outcome)).toEqual({
      $ref: '#/components/schemas/TestingTerminalEvidenceOutcome'
    });
    expect(asObject(properties('TestingTerminalCommitRequest').cleanup_outcome)).toEqual({
      $ref: '#/components/schemas/TestingWorkerTerminalCleanupOutcome'
    });
    expect(schema('TestingWorkerTerminalCleanupOutcome').enum).not.toContain('unobserved');
    expect(schema('TestingTerminalCommitRequest').allOf).toHaveLength(5);
    expect((schema('TestingRunSnapshot').allOf as unknown[]).length).toBeGreaterThanOrEqual(12);
    const eventPath = asObject(parsed.paths['/v1/tools/testing/runs/{run_id}/events']);
    const eventGet = asObject(eventPath.get);
    const eventResponses = asObject(eventGet.responses);
    const expiredResponse = asObject(eventResponses['410']);
    const expiredContent = asObject(expiredResponse.content);
    const expiredJson = asObject(expiredContent['application/json']);
    expect(expiredJson.schema).toEqual({ $ref: '#/components/schemas/TestingCursorExpiredError' });
    expect(schema('TestingCursorExpiredError').additionalProperties).toBe(false);
    expect(schema('TestingRunSnapshot').description).toContain('sole canonical Talos run authority');
    expect(schema('TestingTerminalRefs').description).toContain('externally owned facts');
    expect(schema('TestingCaseResultSetReference').description).toContain('Testing Packages owning repository');
    expect(schema('TestingEvidenceManifestReference').description).toContain('Local QA Runtime owning repository');
    expect(schema('TestingCleanupReceiptReference').description).toContain('Local QA Runtime owning repository');
    expect(document.raw).toContain('openapi: 3.1.0');
  });

  it('fails fast for unreadable and invalid specs', () => {
    expect(() => loadOpenApiDocument('/missing/talos-openapi.yaml')).toThrow('failed to load OpenAPI spec');
    const directory = mkdtempSync(join(tmpdir(), 'talos-openapi-'));
    const invalidPath = join(directory, 'invalid.yaml');
    writeFileSync(invalidPath, 'paths: [unterminated');
    expect(() => loadOpenApiDocument(invalidPath)).toThrow('failed to parse OpenAPI spec');
  });
});
