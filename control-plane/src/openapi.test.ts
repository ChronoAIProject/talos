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
    for (const schema of ['TestingCapabilities', 'TestingToolRequest', 'TestingRunAcceptance', 'TestingRunSnapshot', 'TestingEventPage', 'TestingCancelRequest', 'TestingCancelAck', 'TestingTask']) {
      expect(parsed.components.schemas).toHaveProperty(schema);
    }
    const schema = (name: string): Record<string, unknown> => asObject(parsed.components.schemas[name]);
    const properties = (name: string): Record<string, unknown> => asObject(schema(name).properties);
    for (const strictSchema of [
      'TestingToolRequest',
      'TestingPolicyBinding',
      'TestingPolicyReference',
      'TestingBudgetsReference',
      'TestingRunSnapshot',
      'TestingRunAttempt',
      'TestingRunProgress',
      'TestingRunSummary',
      'TestingTerminalRefs',
      'TestingSafeError',
      'TestingRunEvent',
      'TestingTask',
      'LocalRequestAuthorizationReference'
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
    expect(schema('TestingToolRequest').required).toContain('policy_binding');
    expect(schema('TestingTask').required).toContain('budgets_ref');
    expect(asObject(properties('TestingRunSnapshot').results).oneOf).toEqual([
      { type: 'null' },
      { $ref: '#/components/schemas/TestingTerminalRefs' }
    ]);
    expect(asObject(properties('TestingEventPage').events).items).toEqual({
      $ref: '#/components/schemas/TestingRunEvent'
    });
    expect(schema('TestingRunEvent').oneOf).toHaveLength(12);
    for (const eventData of [
      'TestingRunSubmittedData',
      'TestingRunReservedData',
      'TestingAttemptClaimedData',
      'TestingAttemptAcceptedData',
      'TestingRunCancelRequestedData',
      'TestingRunReasonData',
      'TestingRunReconcileData',
      'TestingRunCompletedData',
      'TestingRunFailedData',
      'TestingRunCancelledData'
    ]) {
      expect(schema(eventData).additionalProperties, eventData).toBe(false);
    }
    const eventPath = asObject(parsed.paths['/v1/tools/testing/runs/{run_id}/events']);
    const eventGet = asObject(eventPath.get);
    const eventResponses = asObject(eventGet.responses);
    const expiredResponse = asObject(eventResponses['410']);
    const expiredContent = asObject(expiredResponse.content);
    const expiredJson = asObject(expiredContent['application/json']);
    expect(expiredJson.schema).toEqual({ $ref: '#/components/schemas/TestingCursorExpiredError' });
    expect(schema('TestingCursorExpiredError').additionalProperties).toBe(false);
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
