import { testingEventQuerySchema } from '@talos/testing-protocol';
import type { ResolvedIdentity } from '../identity.js';
import type { TestingRunService } from '../services/testing-run-service.js';

export interface TestingRouteResult {
  readonly status: number;
  readonly body: unknown;
}

export interface TestingRouteRequest {
  readonly method: string;
  readonly parts: readonly string[];
  readonly searchParams: URLSearchParams;
  readonly body: unknown;
  readonly identity: ResolvedIdentity;
  readonly service: TestingRunService;
}

export const routeTestingRunRequest = async (
  request: TestingRouteRequest
): Promise<TestingRouteResult | undefined> => {
  const { method, parts, searchParams, body, identity, service } = request;
  if (parts[0] !== 'v1' || parts[1] !== 'tools' || parts[2] !== 'testing') return undefined;
  if (method === 'GET' && parts.length === 4 && parts[3] === 'capabilities') {
    return { status: 200, body: service.getCapabilities() };
  }
  if (parts[3] !== 'runs' || parts[4] === undefined) return undefined;

  if (method === 'POST' && parts.length === 5 && parts[4].endsWith(':cancel')) {
    const runId = parts[4].slice(0, -':cancel'.length);
    return { status: 200, body: await service.cancel(runId, identity.userId, body) };
  }
  const runId = parts[4];
  if (method === 'PUT' && parts.length === 5) {
    const result = await service.submit(runId, identity.userId, body, identity.groups);
    return { status: result.created ? 201 : 200, body: result.acceptance };
  }
  if (method === 'GET' && parts.length === 5) {
    return { status: 200, body: await service.get(runId, identity.userId) };
  }
  if (method === 'GET' && parts.length === 6 && parts[5] === 'events') {
    const query = testingEventQuerySchema.parse({
      cursor: searchParams.get('cursor') ?? undefined,
      limit: searchParams.get('limit') ?? undefined
    });
    return {
      status: 200,
      body: await service.events(runId, identity.userId, query.cursor, query.limit)
    };
  }
  return undefined;
};
