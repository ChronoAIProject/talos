import {
  sessionActionRequestSchema,
  sessionCloseSchema,
  sessionCreateSchema,
  sessionWaitSchema
} from '../domain/schemas.js';
import type { ResolvedIdentity } from '../identity.js';
import type { SessionService } from '../services/session-service.js';

export interface SessionRouteRequest {
  method: string;
  parts: readonly string[];
  searchParams: URLSearchParams;
  body: unknown;
  identity: ResolvedIdentity;
  sessions: SessionService;
}

export interface SessionRouteResponse {
  status: number;
  body: unknown;
}

export const routeSessionRequest = async (
  request: SessionRouteRequest
): Promise<SessionRouteResponse | undefined> => {
  const { method, parts, searchParams, body, identity, sessions } = request;
  if (parts[1] !== 'sessions') return undefined;
  if (method === 'POST' && parts.length === 2) {
    const input = sessionCreateSchema.parse(body);
    return {
      status: 201,
      body: await sessions.create(identity.userId, input, identity.groups)
    };
  }
  const sessionId = parts[2];
  if (sessionId === undefined) return undefined;
  if (method === 'GET' && parts.length === 3) {
    return { status: 200, body: await sessions.get(sessionId, identity.userId) };
  }
  if (method === 'POST' && parts[3] === 'close' && parts.length === 4) {
    sessionCloseSchema.parse(body);
    return { status: 200, body: await sessions.close(sessionId, identity.userId) };
  }
  if (method === 'POST' && parts[3] === 'actions' && parts.length === 4) {
    const input = sessionActionRequestSchema.parse(body);
    const waitSeconds = sessionWaitSchema.parse(searchParams.get('wait_seconds') ?? undefined);
    return {
      status: 200,
      body: await sessions.sendAction(sessionId, identity.userId, input.action, waitSeconds)
    };
  }
  if (method === 'GET' && parts[3] === 'actions' && parts[4] !== undefined && parts.length === 5) {
    const waitSeconds = sessionWaitSchema.parse(searchParams.get('wait_seconds') ?? undefined);
    return {
      status: 200,
      body: await sessions.getAction(sessionId, parts[4], identity.userId, waitSeconds)
    };
  }
  return undefined;
};
