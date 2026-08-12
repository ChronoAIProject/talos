import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { z } from 'zod';
import {
  adminMachineSchema,
  adminPoolSchema,
  adminProfileSchema,
  adminRotateMachineSchema,
  artifactSchema,
  handoffRequestSchema,
  heartbeatSchema,
  resultSchema,
  taskInputSchema,
  workerClaimSchema
} from '../domain/schemas.js';
import { TalosError, notFound, notImplemented, payloadTooLarge, unauthorized } from '../domain/errors.js';
import type { TaskService } from '../services/task-service.js';
import type { Repository } from '../storage/repository.js';
import { hashWorkerToken } from '../config.js';
import { newId } from '../util/id.js';

export interface IdentityResolver {
  resolve(token: string): string | undefined;
}

export interface ServerOptions {
  identityResolver?: IdentityResolver;
  adminToken?: string;
  maxBodyBytes?: number;
  clock?: () => number;
}

const defaultIdentityResolver: IdentityResolver = {
  resolve: (token) => token.startsWith('user:') ? token.slice(5) : undefined
};

export const createApiServer = (
  service: TaskService,
  repository: Repository,
  options: ServerOptions = {}
): Server => {
  const identities = options.identityResolver ?? defaultIdentityResolver;
  return createServer(async (request, response) => {
    try {
      await route(request, response, service, repository, identities, options);
    } catch (error) {
      const talos = error instanceof TalosError ? error : undefined;
      const validation = error instanceof z.ZodError
        ? { code: 'validation_error', message: error.message, status: 400 }
        : undefined;
      const invalidJson = error instanceof SyntaxError
        ? { code: 'invalid_json', message: 'request body must be valid JSON', status: 400 }
        : undefined;
      const mapped = talos ?? validation ?? invalidJson;
      send(response, mapped?.status ?? 500, {
        error: {
          code: mapped?.code ?? 'internal_error',
          message: mapped?.message ?? 'internal server error'
        }
      });
    }
  });
};

const route = async (
  request: IncomingMessage,
  response: ServerResponse,
  service: TaskService,
  repository: Repository,
  identities: IdentityResolver,
  options: ServerOptions
): Promise<void> => {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://talos.local');
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] !== 'v1') return send(response, 404, { error: { code: 'not_found', message: 'route not found' } });
  if (parts[1] === 'handoffs' && parts[2] !== undefined && method === 'GET') {
    const userId = requireIdentity(request, identities);
    const link = await repository.getHandoff(parts[2]);
    if (link === undefined) throw notFound('handoff not found');
    if (link.userId !== userId) throw unauthorized('handoff belongs to another user');
    if (link.used || Date.parse(link.expiresAt) <= (options.clock?.() ?? Date.now())) {
      throw new TalosError('handoff_expired', 'handoff link is expired or already used', 409);
    }
    await repository.saveHandoff({ ...link, used: true });
    throw notImplemented('hosted handoff views are planned for Phase 3');
  }
  if (parts[1] === 'admin') return adminRoute(request, response, repository, parts, options);
  if (parts[1] === 'worker') return workerRoute(request, response, service, repository, parts, options);

  const userId = requireIdentity(request, identities);
  if (method === 'POST' && parts.length === 2 && parts[1] === 'tasks') {
    const task = await service.createTask(userId, await readBody(request, options.maxBodyBytes));
    return send(response, 201, service.toPublicTask(task));
  }
  if (parts[1] === 'tasks' && parts[2] !== undefined && method === 'GET' && parts.length === 3) {
    return send(response, 200, service.toPublicTask(await service.getTask(parts[2], userId)));
  }
  if (parts[1] === 'tasks' && parts[2] !== undefined && method === 'POST') {
    const taskId = parts[2];
    const action = parts[3];
    if (action === 'input') {
      const input = taskInputSchema.parse(await readBody(request, options.maxBodyBytes));
      return send(response, 200, service.toPublicTask(await service.provideInput(taskId, userId, input)));
    }
    if (action === 'handoff') {
      const input = handoffRequestSchema.parse(await readBody(request, options.maxBodyBytes));
      return send(response, 200, await service.requestHandoff(taskId, userId, input.expires_in_seconds));
    }
    if (action === 'cancel') return send(response, 200, service.toPublicTask(await service.cancel(taskId, userId)));
  }
  if (parts[1] === 'profiles' && parts[2] !== undefined && parts[3] === 'login-link' && method === 'POST') {
    const profile = await repository.getProfile(parts[2]);
    if (profile === undefined) throw notFound('profile not found');
    if (profile.userId !== userId) throw unauthorized('profile belongs to another user');
    throw notImplemented('profile login links are planned for Phase 2');
  }
  return send(response, 404, { error: { code: 'not_found', message: 'route not found' } });
};

const adminRoute = async (
  request: IncomingMessage,
  response: ServerResponse,
  repository: Repository,
  parts: readonly string[],
  options: ServerOptions
): Promise<void> => {
  requireAdmin(request, options.adminToken);
  if (request.method !== 'POST') return send(response, 404, { error: { code: 'not_found', message: 'route not found' } });
  if (parts[2] === 'pools') {
    const input = adminPoolSchema.parse(await readBody(request, options.maxBodyBytes));
    await repository.savePool({ id: input.id, visibility: input.visibility, ...(input.owner_user_id === undefined ? {} : { ownerUserId: input.owner_user_id }), tags: input.tags });
    return send(response, 201, { id: input.id });
  }
  if (parts[2] === 'machines' && parts[3] !== undefined && parts[4] === 'rotate-token') {
    const input = adminRotateMachineSchema.parse(await readBody(request, options.maxBodyBytes));
    const machine = await repository.getMachine(parts[3]);
    if (machine === undefined) throw notFound('machine not found');
    const workerToken = input.worker_token ?? issueWorkerToken();
    await repository.saveMachine({ ...machine, workerTokenHash: hashWorkerToken(workerToken) });
    return send(response, 200, { id: machine.id, rotated: true, worker_token: workerToken });
  }
  if (parts[2] === 'machines') {
    const input = adminMachineSchema.parse(await readBody(request, options.maxBodyBytes));
    if (await repository.getPool(input.pool_id) === undefined) throw notFound('pool not found');
    const workerToken = input.worker_token ?? issueWorkerToken();
    await repository.saveMachine({ id: input.id, poolId: input.pool_id, tags: input.tags, capacity: input.capacity, online: input.online, activeLeases: 0, workerTokenHash: hashWorkerToken(workerToken) });
    return send(response, 201, { id: input.id, worker_token: workerToken });
  }
  if (parts[2] === 'profiles') {
    const input = adminProfileSchema.parse(await readBody(request, options.maxBodyBytes));
    await repository.saveProfile({ id: input.id, userId: input.user_id, ...(input.machine_id === undefined ? {} : { machineId: input.machine_id }) });
    return send(response, 201, { id: input.id });
  }
  return send(response, 404, { error: { code: 'not_found', message: 'route not found' } });
};

const workerRoute = async (
  request: IncomingMessage,
  response: ServerResponse,
  service: TaskService,
  repository: Repository,
  parts: readonly string[],
  options: ServerOptions
): Promise<void> => {
  const machineId = await requireWorker(request, repository);
  const method = request.method ?? 'GET';
  if (method === 'POST' && parts[2] === 'claim') {
    const input = workerClaimSchema.parse(await readBody(request, options.maxBodyBytes));
    if (input.machine_id !== machineId) throw unauthorized('machine header does not match claim machine');
    if (input.worker_id !== request.headers['x-talos-worker-id']?.toString()) throw unauthorized('worker header does not match claim worker');
    const claimed = await service.claim(input.worker_id, input.machine_id);
    return send(response, 200, { task: service.toPublicTask(claimed.task), lease: claimed.lease, leaseToken: claimed.leaseToken });
  }
  if (parts[2] !== 'tasks' || parts[3] === undefined) return send(response, 404, { error: { code: 'not_found', message: 'route not found' } });
  const taskId = parts[3];
  const task = await repository.getTask(taskId);
  if (task?.machineId !== machineId) throw unauthorized('task is assigned to another machine');
  const worker = request.headers['x-talos-worker-id']?.toString() ?? '';
  if (method === 'POST' && parts[4] === 'heartbeat') {
    const input = heartbeatSchema.parse(await readBody(request, options.maxBodyBytes));
    return send(response, 200, service.toPublicTask(await service.heartbeat(taskId, worker, input.lease_token, input.extend_seconds)));
  }
  if (method === 'POST' && parts[4] === 'needs-input') {
    const input = z.object({ lease_token: z.string().min(1) }).parse(await readBody(request, options.maxBodyBytes));
    return send(response, 200, service.toPublicTask(await service.needsInput(taskId, worker, input.lease_token)));
  }
  if (method === 'GET' && parts[4] === 'input') {
    const leaseToken = request.headers['x-talos-lease-token']?.toString();
    if (leaseToken === undefined) throw unauthorized('X-Talos-Lease-Token is required');
    return send(response, 200, { input: await service.getWorkerInput(taskId, worker, leaseToken) });
  }
  if (method === 'POST' && parts[4] === 'result') {
    const input = resultSchema.parse(await readBody(request, options.maxBodyBytes));
    return send(response, 200, service.toPublicTask(await service.complete(taskId, worker, input.lease_token, input.status, input.findings, input.error)));
  }
  if (method === 'POST' && parts[4] === 'artifacts') {
    const input = artifactSchema.parse(await readBody(request, options.maxBodyBytes));
    const artifact = { id: newId('artifact'), name: input.name, contentType: input.content_type, size: input.size, uri: input.uri, createdAt: new Date(options.clock?.() ?? Date.now()).toISOString() };
    return send(response, 201, service.toPublicTask(await service.addArtifact(taskId, worker, input.lease_token, artifact)));
  }
  return send(response, 404, { error: { code: 'not_found', message: 'route not found' } });
};

const requireIdentity = (request: IncomingMessage, resolver: IdentityResolver): string => {
  const header = request.headers['x-nyxid-identity-token'];
  const token = Array.isArray(header) ? header[0] : header;
  const userId = token === undefined ? undefined : resolver.resolve(token);
  if (userId === undefined) throw unauthorized('X-NyxID-Identity-Token is required');
  return userId;
};

const requireWorker = async (request: IncomingMessage, repository: Repository): Promise<string> => {
  const auth = request.headers.authorization;
  const machineId = request.headers['x-talos-machine-id']?.toString();
  if (auth === undefined || !auth.startsWith('Bearer ') || machineId === undefined) throw unauthorized('worker token and machine header are required');
  const token = auth.slice(7);
  const machine = await repository.getMachine(machineId);
  if (machine === undefined) throw unauthorized('invalid worker token');
  const expected = Buffer.from(machine.workerTokenHash);
  const actual = Buffer.from(hashWorkerToken(token));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw unauthorized('invalid worker token');
  if (request.headers['x-talos-worker-id'] === undefined) throw unauthorized('worker id is required');
  return machineId;
};

const readBody = async (request: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > maxBytes) throw payloadTooLarge();
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
};

const requireAdmin = (request: IncomingMessage, expected?: string): void => {
  if (expected === undefined) throw unauthorized('admin token is not configured');
  const actual = Buffer.from(request.headers['x-talos-admin-token']?.toString() ?? '');
  const target = Buffer.from(expected);
  if (actual.length !== target.length || !timingSafeEqual(actual, target)) throw unauthorized('invalid admin token');
};

const issueWorkerToken = (): string => `tw_${randomBytes(24).toString('base64url')}`;

const send = (response: ServerResponse, status: number, payload: unknown): void => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
};

export const parseError = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
