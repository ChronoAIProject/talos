import {
  computeTestingToolRequestDigest,
  testingAuthenticatedTransportContextSchema,
  testingToolRequestSchema,
  type TestingAuthenticatedTransportContext,
} from '@talos/testing-protocol';
import type { ResolvedIdentity } from '../identity.js';
import type { TestingRunService } from '../services/testing-run-service.js';

const digest = `sha256:${'b'.repeat(64)}`;

export const testAuthenticatedTransportContext = (
  runId: string,
  requestInput: unknown,
  overrides: Partial<TestingAuthenticatedTransportContext> = {}
): TestingAuthenticatedTransportContext => {
  const request = testingToolRequestSchema.parse(requestInput);
  return testingAuthenticatedTransportContextSchema.parse({
    schema_version: 'talos.testing-authenticated-transport-context/v1',
    transport_correlation_id: `transport:${runId}`,
    verified_client_correlation_id: request.client_correlation_id,
    subject: 'user-1',
    delegated_actor: null,
    source: 'pql',
    destination: 'talos-testing-tool',
    route: { ref: `nyxid://routes/testing/${runId}`, digest, operation: 'submit', run_id: runId },
    authorization: {
      ref: `authorization://nyxid/testing/${runId}`,
      digest,
      operation: 'submit',
      run_id: runId,
      valid_until: '2099-08-22T00:10:00.000Z'
    },
    audit_refs: [{ ref: `nyxid://audit/events/${runId}`, digest }],
    transport_acknowledgement: { ref: `nyxid://transport-acks/testing/${runId}`, digest },
    verified_request_digest: computeTestingToolRequestDigest(runId, request),
    verified_at: '2026-08-22T00:00:00.000Z',
    ...overrides
  });
};

export const testResolvedIdentity = (
  runId: string,
  request: unknown,
  overrides: Partial<ResolvedIdentity> = {}
): ResolvedIdentity => ({
  userId: 'user-1',
  groups: [],
  permissions: ['testing:submit'],
  authenticatedTransport: testAuthenticatedTransportContext(runId, request),
  ...overrides
});

export const submitTestingRun = async (
  service: TestingRunService,
  runId: string,
  userId: string,
  requestInput: unknown,
  requesterGroups: readonly string[] = []
) => {
  const request = testingToolRequestSchema.parse(requestInput);
  return await service.submit(
    runId,
    userId,
    request,
    testAuthenticatedTransportContext(runId, request, { subject: userId }),
    requesterGroups
  );
};
