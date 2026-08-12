import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { z } from 'zod';
import { artifactSchema, handoffRequestSchema, heartbeatSchema, resultSchema, taskInputSchema, workerClaimSchema } from '../domain/schemas.js';
import { TalosError, notImplemented, unauthorized } from '../domain/errors.js';
import type { TaskService } from '../services/task-service.js';
import type { Repository } from '../storage/repository.js';
import { hashWorkerToken } from '../config.js';

export interface IdentityResolver { resolve(token: string): string | undefined; }
export interface ServerOptions { identityResolver?: IdentityResolver; }

const defaultIdentityResolver: IdentityResolver = { resolve: (token) => token.startsWith('user:') ? token.slice(5) : undefined };

export const createApiServer = (service: TaskService, repository: Repository, options: ServerOptions = {}): Server => {
  const identities = options.identityResolver ?? defaultIdentityResolver;
  return createServer(async (request, response) => {
    try {
      await route(request, response, service, repository, identities);
    } catch (error) {
      const talos = error instanceof TalosError ? error : undefined;
      send(response, talos?.status ?? 500, { error: { code: talos?.code ?? 'internal_error', message: talos?.message ?? 'internal server error' } });
    }
  });
};

const route = async (request: IncomingMessage, response: ServerResponse, service: TaskService, repository: Repository, identities: IdentityResolver): Promise<void> => {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://talos.local');
  const parts = url.pathname.split('/').filter(Boolean);
  const userId = parts[0] === 'v1' && parts[1] === 'worker' ? undefined : requireIdentity(request, identities);

  if (method === 'POST' && parts.join('/') === 'v1/tasks') return send(response, 201, service.toPublicTask(await service.createTask(userId as string, await body(request))));
  if (method === 'GET' && parts[0] === 'v1' && parts[1] === 'tasks' && parts[2] !== undefined) return send(response, 200, service.toPublicTask(await service.getTask(parts[2], userId as string)));
  if (method === 'POST' && parts[0] === 'v1' && parts[1] === 'tasks' && parts[2] !== undefined) {
    const taskId = parts[2];
    const action = parts[3];
    if (action === 'input') return send(response, 200, service.toPublicTask(await service.provideInput(taskId, userId as string, taskInputSchema.parse(await body(request)))));
    if (action === 'handoff') {
      const input = handoffRequestSchema.parse(await body(request));
      return send(response, 200, await service.requestHandoff(taskId, userId as string, input.expires_in_seconds));
    }
    if (action === 'cancel') return send(response, 200, service.toPublicTask(await service.cancel(taskId, userId as string)));
  }
  if (method === 'POST' && parts[0] === 'v1' && parts[1] === 'profiles' && parts[3] === 'login-link') {
    throw notImplemented('profile login links are planned for Phase 2');
  }
  if (parts[0] === 'v1' && parts[1] === 'worker') {
    if (method === 'POST' && parts[2] === 'claim') {
      const input = workerClaimSchema.parse(await body(request));
      await requireWorker(request, repository, input.machine_id);
      return send(response, 200, await service.claim(input.worker_id, input.machine_id));
    }
    await requireWorker(request, repository, request.headers['x-talos-machine-id']?.toString());
    if (parts[2] === 'tasks' && parts[3] !== undefined) {
      const taskId = parts[3];
      if (method === 'POST' && parts[4] === 'heartbeat') {
        const input = heartbeatSchema.parse(await body(request));
        return send(response, 200, await service.heartbeat(taskId, workerId(request), input.lease_token, input.extend_seconds));
      }
      if (method === 'POST' && parts[4] === 'needs-input') {
        const input = z.object({ lease_token: z.string().min(1) }).parse(await body(request));
        return send(response, 200, await service.needsInput(taskId, workerId(request), input.lease_token));
      }
      if (method === 'GET' && parts[4] === 'input') {
        const leaseToken = url.searchParams.get('lease_token');
        if (leaseToken === null) throw unauthorized('lease_token is required');
        return send(response, 200, { input: await service.getWorkerInput(taskId, workerId(request), leaseToken) });
      }
      if (method === 'POST' && parts[4] === 'result') {
        const input = resultSchema.parse(await body(request));
        return send(response, 200, await service.complete(taskId, workerId(request), input.lease_token, input.status, input.findings, input.error));
      }
      if (method === 'POST' && parts[4] === 'artifacts') {
        const input = artifactSchema.parse(await body(request));
        const artifact = { id: `artifact_${Date.now()}`, name: input.name, contentType: input.content_type, size: input.size, uri: input.uri, createdAt: new Date().toISOString() };
        return send(response, 201, await service.addArtifact(taskId, workerId(request), input.lease_token, artifact));
      }
    }
  }
  send(response, 404, { error: { code: 'not_found', message: 'route not found' } });
};

const workerId = (request: IncomingMessage): string => request.headers['x-talos-worker-id']?.toString() ?? '';

const requireIdentity = (request: IncomingMessage, resolver: IdentityResolver): string => {
  const header = request.headers['x-nyxid-identity-token'];
  const token = Array.isArray(header) ? header[0] : header;
  const userId = token === undefined ? undefined : resolver.resolve(token);
  if (userId === undefined) throw unauthorized('X-NyxID-Identity-Token is required');
  return userId;
};

const requireWorker = async (request: IncomingMessage, repository: Repository, machineId?: string): Promise<void> => {
  const auth = request.headers.authorization;
  if (auth === undefined || !auth.startsWith('Bearer ')) throw unauthorized('worker token is required');
  const token = auth.slice(7);
  const machines = await repository.listMachines();
  if (!machines.some((machine) => (machineId === undefined || machine.id === machineId) && machine.workerTokenHash === hashWorkerToken(token))) throw unauthorized('invalid worker token');
};

const body = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
};

const send = (response: ServerResponse, status: number, payload: unknown): void => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
};

export const parseError = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
