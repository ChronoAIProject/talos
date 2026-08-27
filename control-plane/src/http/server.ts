import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { z } from 'zod';
import {
  computeTestingWorkerMutationDigest,
  testingWorkerMutationAckSchema,
  type TestingControlStatus,
  type TestingCurrentClaimEnvelope,
  type TestingWorkerMutationOperation
} from '@talos/testing-protocol';
import {
  adminMachineSchema,
  adminPoolSchema,
  adminProfileSchema,
  adminRotateMachineSchema,
  selfMachineSchema,
  selfPoolSchema,
  selfPoolPatchSchema,
  selfProfileSchema,
  selfRotateMachineSchema,
  artifactSchema,
  handoffRequestSchema,
  heartbeatSchema,
  resultSchema,
  taskInputSchema,
  testingAttemptBindingBodySchema,
  testingHeartbeatBodySchema,
  testingNoLocalAcceptanceBodySchema,
  testingTerminalCommitBodySchema,
  testingWorkerClaimSchema,
  workerBodyCredentialsSchema,
  workerClaimSchema,
  workerActionPollSchema,
  workerActionResultSchema,
  workerInputPollSchema,
  workerNeedsInputSchema
} from '../domain/schemas.js';
import {
  TalosError,
  conflict,
  forbidden,
  notFound,
  notImplemented,
  payloadTooLarge,
  publicErrorRetryable,
  unauthorized
} from '../domain/errors.js';
import type { TaskService } from '../services/task-service.js';
import type { Repository } from '../storage/repository.js';
import { hashWorkerToken } from '../config.js';
import { newId } from '../util/id.js';
import { DevIdentityResolver, type IdentityResolver, type ResolvedIdentity } from '../identity.js';
import type { OpenApiDocument } from '../openapi.js';
import { SessionService, type SessionServiceOptions } from '../services/session-service.js';
import { routeSessionRequest } from './session-routes.js';
import { TestingRunService } from '../services/testing-run-service.js';
import { routeTestingRunRequest } from './testing-run-routes.js';
import {
  TestingAttemptService,
  type TestingAttemptBindingInput
} from '../services/testing-attempt-service.js';

export interface ServerOptions {
  identityResolver?: IdentityResolver;
  adminToken?: string;
  maxBodyBytes?: number;
  clock?: () => number;
  openApiDocument?: OpenApiDocument;
  sessionService?: SessionService;
  session?: SessionServiceOptions;
  testingRunService?: TestingRunService;
  testingAttemptService?: TestingAttemptService;
  testingCursorSecret?: string;
}

export const defaultIdentityResolver: IdentityResolver = new DevIdentityResolver();

export const createApiServer = (
  service: TaskService,
  repository: Repository,
  options: ServerOptions = {}
): Server => {
  const identities = options.identityResolver ?? defaultIdentityResolver;
  const sessions = options.sessionService ?? new SessionService(service, repository, options.session);
  const testingRuns = options.testingRunService ?? new TestingRunService(repository, {
    cursorSecret: options.testingCursorSecret ?? 'development-testing-cursor-secret',
    clock: options.clock
  });
  const testingAttempts = options.testingAttemptService ?? new TestingAttemptService(repository, {
    clock: options.clock
  });
  return createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? '/', 'http://talos.local').pathname;
      if (request.method === 'GET' && path === '/openapi.json' && options.openApiDocument !== undefined) {
        return sendSerialized(response, 200, options.openApiDocument.json, 'application/json');
      }
      if (request.method === 'GET' && path === '/openapi.yaml' && options.openApiDocument !== undefined) {
        return sendSerialized(response, 200, options.openApiDocument.raw, 'application/yaml');
      }
      if (request.method === 'GET' && path === '/healthz') {
        try {
          await repository.ping();
          return send(response, 200, { status: 'ok' });
        } catch {
          return send(response, 503, { status: 'degraded' });
        }
      }
      await route(request, response, service, sessions, testingRuns, testingAttempts, repository, identities, options);
    } catch (error) {
      const talos = error instanceof TalosError ? error : undefined;
      const validation = error instanceof z.ZodError
        ? {
            code: 'validation_error',
            message: 'request failed schema validation',
            status: 400
          }
        : undefined;
      const invalidJson = error instanceof SyntaxError
        ? { code: 'invalid_json', message: 'request body must be valid JSON', status: 400 }
        : undefined;
      const mapped = talos ?? validation ?? invalidJson;
      const status = mapped?.status ?? 500;
      const code = mapped?.code ?? 'internal_error';
      const message = boundedPublicErrorMessage(mapped?.message ?? 'internal server error');
      const details: Record<string, unknown> = { ...(talos?.details ?? {}) };
      delete details.code;
      delete details.message;
      delete details.retryable;
      send(response, status, {
        error: {
          ...details,
          code,
          message,
          retryable: publicErrorRetryable(code, status)
        }
      });
    }
  });
};

const route = async (
  request: IncomingMessage,
  response: ServerResponse,
  service: TaskService,
  sessions: SessionService,
  testingRuns: TestingRunService,
  testingAttempts: TestingAttemptService,
  repository: Repository,
  identities: IdentityResolver,
  options: ServerOptions
): Promise<void> => {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://talos.local');
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] !== 'v1') return send(response, 404, publicErrorEnvelope('not_found', 'route not found', 404));
  if (
    method === 'POST' &&
    parts[1] === 'testing' &&
    parts[2] === 'claims' &&
    parts[3] !== undefined &&
    parts[4] !== undefined &&
    parts[5] === 'resolve' &&
    parts.length === 6
  ) {
    const body = await readBody(request, options.maxBodyBytes);
    return send(response, 200, await testingAttempts.resolveRuntimeCurrentClaim(parts[3], parts[4], body));
  }
  if (parts[1] === 'handoffs' && parts[2] !== undefined && method === 'GET') {
    const identity = await requireIdentity(request, identities);
    const link = await repository.getHandoff(parts[2]);
    if (link === undefined) throw notFound('handoff not found');
    if (link.userId !== identity.userId) throw unauthorized('handoff belongs to another user');
    if (link.used || Date.parse(link.expiresAt) <= (options.clock?.() ?? Date.now())) {
      throw new TalosError('handoff_expired', 'handoff link is expired or already used', 409);
    }
    await repository.saveHandoff({ ...link, used: true });
    throw notImplemented('hosted handoff views are planned for Phase 3');
  }
  if (parts[1] === 'admin') return adminRoute(request, response, repository, parts, options);
  if (parts[1] === 'worker') {
    return workerRoute(request, response, service, sessions, testingAttempts, repository, parts, options);
  }

  const identity = await requireIdentity(request, identities);
  const userId = identity.userId;
  if (parts[1] === 'tools' && parts[2] === 'testing') {
    const body = ['POST', 'PUT'].includes(method) ? await readBody(request, options.maxBodyBytes) : {};
    const routed = await routeTestingRunRequest({
      method,
      parts,
      searchParams: url.searchParams,
      body,
      identity,
      service: testingRuns
    });
    if (routed !== undefined) return send(response, routed.status, routed.body);
  }
  if (parts[1] === 'sessions') {
    const body = method === 'POST' ? await readBody(request, options.maxBodyBytes) : {};
    const routed = await routeSessionRequest({ method, parts, searchParams: url.searchParams, body, identity, sessions });
    if (routed !== undefined) return send(response, routed.status, routed.body);
  }
  if (parts[1] === 'pools') return fleetPoolRoute(request, response, repository, parts, identity, options);
  if (parts[1] === 'machines' && parts[2] !== undefined && parts[3] === 'rotate-token' && method === 'POST') {
    const machine = await repository.getMachine(parts[2]);
    if (machine === undefined) throw notFound('machine not found');
    await assertPoolOwner(repository, machine.poolId, userId);
    selfRotateMachineSchema.parse(await readBody(request, options.maxBodyBytes));
    const workerToken = issueWorkerToken();
    await repository.saveMachine({ ...machine, workerTokenHash: hashWorkerToken(workerToken) });
    return send(response, 200, { id: machine.id, rotated: true, worker_token: workerToken });
  }
  if (parts[1] === 'profiles' && parts.length === 2 && method === 'POST') {
    const input = selfProfileSchema.parse(await readBody(request, options.maxBodyBytes));
    if (input.machine_id !== undefined) {
      const machine = await repository.getMachine(input.machine_id);
      if (machine === undefined) throw notFound('machine not found');
      await assertPoolOwner(repository, machine.poolId, userId);
    }
    const id = input.id ?? newId('profile');
    if (await repository.getProfile(id) !== undefined) throw conflict('profile already exists');
    await repository.saveProfile({ id, userId, ...(input.machine_id === undefined ? {} : { machineId: input.machine_id }) });
    return send(response, 201, {
      id,
      userId,
      ...(input.machine_id === undefined ? {} : { machineId: input.machine_id })
    });
  }
  if (parts[1] === 'profiles' && parts.length === 2 && method === 'GET') {
    const profiles = await repository.listProfilesByUser(userId);
    return send(response, 200, profiles.map((profile) => ({
      id: profile.id,
      userId: profile.userId,
      ...(profile.machineId === undefined ? {} : { machineId: profile.machineId })
    })));
  }
  if (method === 'POST' && parts.length === 2 && parts[1] === 'tasks') {
    const task = await service.createTask(userId, await readBody(request, options.maxBodyBytes), identity.groups);
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
  return send(response, 404, publicErrorEnvelope('not_found', 'route not found', 404));
};

const assertPoolOwner = async (repository: Repository, poolId: string, userId: string): Promise<NonNullable<Awaited<ReturnType<Repository['getPool']>>>> => {
  const pool = await repository.getPool(poolId);
  if (pool === undefined) throw notFound('pool not found');
  if (pool.ownerUserId !== userId) throw forbidden('pool belongs to another user');
  return pool;
};

const publicMachine = (machine: NonNullable<Awaited<ReturnType<Repository['getMachine']>>>): unknown => ({
  id: machine.id,
  tags: machine.tags,
  capacity: machine.capacity,
  online: machine.online,
  activeLeases: machine.activeLeases
});

const fleetPoolRoute = async (
  request: IncomingMessage,
  response: ServerResponse,
  repository: Repository,
  parts: readonly string[],
  identity: ResolvedIdentity,
  options: ServerOptions
): Promise<void> => {
  const method = request.method ?? 'GET';
  const userId = identity.userId;
  if (parts.length === 2 && method === 'POST') {
    const input = selfPoolSchema.parse(await readBody(request, options.maxBodyBytes));
    const id = input.id ?? newId('pool');
    if (await repository.getPool(id) !== undefined) throw conflict('pool already exists');
    const visibility = input.visibility ?? 'private';
    await repository.savePool({ id, visibility, ownerUserId: userId, tags: input.tags, ...(input.shared_with_groups.length === 0 ? {} : { sharedWithGroups: input.shared_with_groups }) });
    return send(response, 201, {
      id,
      visibility,
      ownerUserId: userId,
      tags: input.tags,
      ...(input.shared_with_groups.length === 0 ? {} : { sharedWithGroups: input.shared_with_groups })
    });
  }
  if (parts.length === 3 && parts[2] !== undefined && method === 'PATCH') {
    const pool = await assertPoolOwner(repository, parts[2], userId);
    const input = selfPoolPatchSchema.parse(await readBody(request, options.maxBodyBytes));
    const updated = {
      ...pool,
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
      ...(input.shared_with_groups === undefined ? {} : { sharedWithGroups: input.shared_with_groups })
    };
    await repository.savePool(updated);
    return send(response, 200, {
      id: updated.id,
      visibility: updated.visibility,
      ownerUserId: updated.ownerUserId,
      tags: updated.tags,
      ...(updated.sharedWithGroups === undefined ? {} : { sharedWithGroups: updated.sharedWithGroups })
    });
  }
  if (parts.length === 2 && method === 'GET') {
    const pools = await repository.listPoolsByOwner(userId);
    return send(response, 200, pools.map((pool) => ({
      id: pool.id,
      visibility: pool.visibility,
      ownerUserId: pool.ownerUserId,
      tags: pool.tags,
      ...(pool.sharedWithGroups === undefined ? {} : { sharedWithGroups: pool.sharedWithGroups })
    })));
  }
  if (parts[3] === 'machines' && parts[2] !== undefined) {
    const pool = await assertPoolOwner(repository, parts[2], userId);
    if (method === 'POST' && parts.length === 4) {
      const input = selfMachineSchema.parse(await readBody(request, options.maxBodyBytes));
      if (await repository.getMachine(input.id) !== undefined) throw conflict('machine already exists');
      const workerToken = issueWorkerToken();
      await repository.saveMachine({
        id: input.id,
        poolId: pool.id,
        tags: input.tags,
        capacity: input.capacity,
        online: input.online,
        activeLeases: 0,
        workerTokenHash: hashWorkerToken(workerToken)
      });
      return send(response, 201, { id: input.id, worker_token: workerToken });
    }
    if (method === 'GET' && parts.length === 4) {
      const machines = await repository.listMachines(pool.id);
      return send(response, 200, machines.map(publicMachine));
    }
  }
  return send(response, 404, publicErrorEnvelope('not_found', 'route not found', 404));
};

const adminRoute = async (
  request: IncomingMessage,
  response: ServerResponse,
  repository: Repository,
  parts: readonly string[],
  options: ServerOptions
): Promise<void> => {
  requireAdmin(request, options.adminToken);
  if (request.method !== 'POST') return send(response, 404, publicErrorEnvelope('not_found', 'route not found', 404));
  if (parts[2] === 'pools') {
    const input = adminPoolSchema.parse(await readBody(request, options.maxBodyBytes));
    if (await repository.getPool(input.id) !== undefined) throw conflict('pool already exists');
    await repository.savePool({ id: input.id, visibility: input.visibility, ...(input.owner_user_id === undefined ? {} : { ownerUserId: input.owner_user_id }), tags: input.tags, ...(input.shared_with_groups.length === 0 ? {} : { sharedWithGroups: input.shared_with_groups }) });
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
    if (await repository.getMachine(input.id) !== undefined) throw conflict('machine already exists');
    if (await repository.getPool(input.pool_id) === undefined) throw notFound('pool not found');
    const workerToken = input.worker_token ?? issueWorkerToken();
    await repository.saveMachine({ id: input.id, poolId: input.pool_id, tags: input.tags, capacity: input.capacity, online: input.online, activeLeases: 0, workerTokenHash: hashWorkerToken(workerToken) });
    return send(response, 201, { id: input.id, worker_token: workerToken });
  }
  if (parts[2] === 'profiles') {
    const input = adminProfileSchema.parse(await readBody(request, options.maxBodyBytes));
    if (await repository.getProfile(input.id) !== undefined) throw conflict('profile already exists');
    await repository.saveProfile({ id: input.id, userId: input.user_id, ...(input.machine_id === undefined ? {} : { machineId: input.machine_id }) });
    return send(response, 201, { id: input.id });
  }
  return send(response, 404, publicErrorEnvelope('not_found', 'route not found', 404));
};

const workerRoute = async (
  request: IncomingMessage,
  response: ServerResponse,
  service: TaskService,
  sessions: SessionService,
  testingAttempts: TestingAttemptService,
  repository: Repository,
  parts: readonly string[],
  options: ServerOptions
): Promise<void> => {
  const method = request.method ?? 'GET';
  const isActionResult = parts[2] === 'tasks' && parts[4] === 'actions' && parts[6] === 'result';
  const maxBodyBytes = isActionResult ? 8 * 1024 * 1024 : options.maxBodyBytes;
  const body = method === 'POST' ? await readBody(request, maxBodyBytes) : undefined;
  const workerIdentity = await requireWorker(request, repository, body);
  if (parts[2] === 'testing') {
    return testingWorkerRoute(response, testingAttempts, parts, method, body, workerIdentity);
  }
  if (method === 'POST' && parts[2] === 'claim') {
    const input = workerClaimSchema.parse(body);
    if (input.machine_id !== workerIdentity.machineId) throw unauthorized('authenticated machine does not match claim machine');
    if (input.worker_id !== workerIdentity.workerId) throw unauthorized('authenticated worker does not match claim worker');
    const claimed = await service.claim(input.worker_id, input.machine_id);
    return send(response, 200, { task: service.toPublicTask(claimed.task), lease: claimed.lease, leaseToken: claimed.leaseToken });
  }
  if (parts[2] !== 'tasks' || parts[3] === undefined) {
    return send(response, 404, publicErrorEnvelope('not_found', 'route not found', 404));
  }
  const taskId = parts[3];
  const task = await repository.getTask(taskId);
  if (task?.machineId !== workerIdentity.machineId) throw unauthorized('task is assigned to another machine');
  const worker = workerIdentity.workerId;
  if (method === 'POST' && parts[4] === 'heartbeat') {
    const input = heartbeatSchema.parse(body);
    return send(response, 200, service.toPublicTask(await service.heartbeat(taskId, worker, input.lease_token, input.extend_seconds)));
  }
  if (method === 'POST' && parts[4] === 'needs-input') {
    const input = workerNeedsInputSchema.parse(body);
    return send(response, 200, service.toPublicTask(await service.needsInput(taskId, worker, input.lease_token)));
  }
  if (method === 'POST' && parts[4] === 'input' && parts[5] === 'poll') {
    const input = workerInputPollSchema.parse(body);
    return send(response, 200, { input: await service.getWorkerInput(taskId, worker, input.lease_token) });
  }
  if (method === 'POST' && parts[4] === 'actions' && parts[5] === 'poll') {
    const input = workerActionPollSchema.parse(body);
    return send(response, 200, await sessions.pollWorkerAction(taskId, worker, input.lease_token));
  }
  if (method === 'POST' && parts[4] === 'actions' && parts[5] !== undefined && parts[6] === 'result') {
    const input = workerActionResultSchema.parse(body);
    await sessions.saveWorkerResult(taskId, parts[5], worker, input.lease_token, input.result);
    return send(response, 200, { stored: true });
  }
  if (method === 'GET' && parts[4] === 'input') {
    const leaseToken = request.headers['x-talos-lease-token']?.toString();
    if (leaseToken === undefined) throw unauthorized('X-Talos-Lease-Token is required');
    return send(response, 200, { input: await service.getWorkerInput(taskId, worker, leaseToken) });
  }
  if (method === 'POST' && parts[4] === 'result') {
    const input = resultSchema.parse(body);
    return send(response, 200, service.toPublicTask(await service.complete(taskId, worker, input.lease_token, input.status, input.findings, input.error)));
  }
  if (method === 'POST' && parts[4] === 'artifacts') {
    const input = artifactSchema.parse(body);
    const artifact = { id: newId('artifact'), name: input.name, contentType: input.content_type, size: input.size, uri: input.uri, createdAt: new Date(options.clock?.() ?? Date.now()).toISOString() };
    return send(response, 201, service.toPublicTask(await service.addArtifact(taskId, worker, input.lease_token, artifact)));
  }
  return send(response, 404, publicErrorEnvelope('not_found', 'route not found', 404));
};

const testingWorkerRoute = async (
  response: ServerResponse,
  service: TestingAttemptService,
  parts: readonly string[],
  method: string,
  body: unknown,
  worker: WorkerIdentity
): Promise<void> => {
  if (method === 'POST' && parts[3] === 'claim' && parts.length === 4) {
    const input = testingWorkerClaimSchema.parse(body);
    if (input.machine_id !== worker.machineId) throw unauthorized('authenticated machine does not match testing claim machine');
    if (input.worker_id !== worker.workerId) throw unauthorized('authenticated worker does not match testing claim worker');
    return send(response, 200, await service.claim(worker.workerId, worker.machineId));
  }
  if (method === 'POST' && parts[3] === 'reconcile-claim' && parts.length === 4) {
    const input = testingWorkerClaimSchema.parse(body);
    if (input.machine_id !== worker.machineId) throw unauthorized('authenticated machine does not match reconcile machine');
    if (input.worker_id !== worker.workerId) throw unauthorized('authenticated worker does not match reconcile worker');
    return send(response, 200, await service.claimNextReconcile(worker.workerId, worker.machineId));
  }
  if (method === 'GET' && parts[3] === 'claims' && parts[4] !== undefined && parts[5] !== undefined && parts.length === 6) {
    const claim = await service.resolveCurrentClaim(parts[4], parts[5]);
    if (claim.claim.machine_id !== worker.machineId) throw unauthorized('testing claim belongs to another machine');
    return send(response, 200, claim);
  }
  if (method !== 'POST' || parts[3] !== 'runs' || parts[4] === undefined || parts[5] === undefined || parts.length !== 6) {
    return send(response, 404, publicErrorEnvelope('not_found', 'route not found', 404));
  }
  const runId = parts[4];
  const action = parts[5];
  if (action === 'reconcile-claim') {
    const input = testingWorkerClaimSchema.parse(body);
    if (input.machine_id !== worker.machineId) throw unauthorized('authenticated machine does not match reconcile machine');
    if (input.worker_id !== worker.workerId) throw unauthorized('authenticated worker does not match reconcile worker');
    return send(response, 200, await service.claimReconcile(worker.workerId, worker.machineId, runId));
  }
  if (action === 'heartbeat') {
    const input = testingHeartbeatBodySchema.parse(body);
    const attempt = testingBinding(runId, input, worker);
    return send(response, 200, await service.heartbeat(attempt, input.extend_seconds, input.progress));
  }
  if (action === 'local-accept' || action === 'running') {
    const input = testingAttemptBindingBodySchema.parse(body);
    const attempt = testingBinding(runId, input, worker);
    const claim = action === 'local-accept'
      ? await service.acceptLocal(attempt)
      : await service.markRunning(attempt);
    const operation = action === 'local-accept' ? 'local_accept' : 'running';
    return send(response, 200, testingWorkerMutationAcknowledgement(
      operation,
      runId,
      input,
      {},
      operation === 'local_accept' ? 'local_accepted' : 'running',
      claim
    ));
  }
  if (action === 'not-accepted') {
    const input = testingNoLocalAcceptanceBodySchema.parse(body);
    const run = await service.confirmNotLocallyAccepted(testingBinding(runId, input, worker), input.fact);
    return send(response, 200, testingWorkerMutationAcknowledgement(
      'not_accepted',
      runId,
      input,
      { fact: input.fact },
      run.controlStatus,
      undefined,
      run.snapshotVersion
    ));
  }
  if (action === 'result' || action === 'reconcile') {
    const input = testingTerminalCommitBodySchema.parse(body);
    const terminal = {
      ...testingBinding(runId, input, worker),
      controlStatus: input.control_status,
      executionOutcome: input.execution_outcome,
      evidenceOutcome: input.evidence_outcome,
      uploadOutcome: input.upload_outcome,
      cleanupOutcome: input.cleanup_outcome,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.results === undefined ? {} : { results: input.results }),
      ...(input.safe_error === undefined ? {} : { safeError: input.safe_error })
    };
    const run = action === 'reconcile'
      ? await service.commitReconcileTerminal(terminal)
      : await service.commitTerminal(terminal);
    return send(response, 200, testingWorkerMutationAcknowledgement(
      action === 'result' ? 'terminal' : 'reconcile_terminal',
      runId,
      input,
      testingTerminalMutationPayload(input),
      run.controlStatus,
      undefined,
      run.snapshotVersion
    ));
  }
  return send(response, 404, publicErrorEnvelope('not_found', 'route not found', 404));
};

const testingBinding = (
  runId: string,
  input: { attempt_id: string; generation: number; fence_token: string; lease_token: string },
  worker: WorkerIdentity
): TestingAttemptBindingInput => ({
  runId,
  attemptId: input.attempt_id,
  machineId: worker.machineId,
  workerId: worker.workerId,
  generation: input.generation,
  fenceToken: input.fence_token,
  leaseToken: input.lease_token
});

const testingWorkerMutationAcknowledgement = (
  operation: TestingWorkerMutationOperation,
  runId: string,
  input: z.infer<typeof testingAttemptBindingBodySchema>,
  payload: Readonly<Record<string, unknown>>,
  controlStatus: TestingControlStatus,
  currentClaim?: TestingCurrentClaimEnvelope,
  snapshotVersion?: number
): ReturnType<typeof testingWorkerMutationAckSchema.parse> => testingWorkerMutationAckSchema.parse({
  schema_version: 'talos.testing-worker-mutation-ack/v1',
  operation,
  run_id: runId,
  attempt_id: input.attempt_id,
  generation: input.generation,
  fence_token: input.fence_token,
  mutation_digest: computeTestingWorkerMutationDigest({
    schema_version: 'talos.testing-worker-mutation/v1',
    operation,
    run_id: runId,
    attempt_id: input.attempt_id,
    generation: input.generation,
    fence_token: input.fence_token,
    lease_token: input.lease_token,
    payload
  }),
  control_status: controlStatus,
  ...(snapshotVersion === undefined ? {} : { snapshot_version: snapshotVersion }),
  ...(currentClaim === undefined ? {} : { current_claim: currentClaim })
});

const testingTerminalMutationPayload = (
  input: z.infer<typeof testingTerminalCommitBodySchema>
): Readonly<Record<string, unknown>> => ({
  control_status: input.control_status,
  execution_outcome: input.execution_outcome,
  evidence_outcome: input.evidence_outcome,
  upload_outcome: input.upload_outcome,
  cleanup_outcome: input.cleanup_outcome,
  ...(input.summary === undefined ? {} : { summary: input.summary }),
  ...(input.results === undefined ? {} : { results: input.results }),
  ...(input.safe_error === undefined ? {} : { safe_error: input.safe_error })
});

const requireIdentity = async (request: IncomingMessage, resolver: IdentityResolver): Promise<ResolvedIdentity> => {
  const header = request.headers['x-nyxid-identity-token'];
  const token = Array.isArray(header) ? header[0] : header;
  const identity = token === undefined ? undefined : await resolver.resolve(token);
  if (identity === undefined) throw unauthorized('X-NyxID-Identity-Token is required');
  return identity;
};

interface WorkerIdentity {
  machineId: string;
  workerId: string;
}

const requireWorker = async (
  request: IncomingMessage,
  repository: Repository,
  body: unknown
): Promise<WorkerIdentity> => {
  const auth = request.headers.authorization;
  const headerToken = request.headers['x-talos-worker-token']?.toString();
  const headerMachineId = request.headers['x-talos-machine-id']?.toString();
  const headerWorkerId = request.headers['x-talos-worker-id']?.toString();
  const bearerToken = auth?.startsWith('Bearer ') === true ? auth.slice(7) : undefined;
  const bodyCredentials = workerBodyCredentialsSchema.safeParse(body);
  const bodyData = bodyCredentials.success ? bodyCredentials.data : {};
  const headersSelected = headerToken !== undefined || bearerToken !== undefined;
  const token = headerToken ?? bearerToken ?? bodyData.worker_token;
  const machineId = headersSelected ? headerMachineId : bodyData.machine_id;
  const workerId = headersSelected ? headerWorkerId : bodyData.worker_id;
  if (token === undefined || machineId === undefined || workerId === undefined) {
    throw unauthorized('worker token, machine id, and worker id are required');
  }
  const machine = await repository.getMachine(machineId);
  if (machine === undefined) throw unauthorized('invalid worker token');
  const expected = Buffer.from(machine.workerTokenHash);
  const actual = Buffer.from(hashWorkerToken(token));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw unauthorized('invalid worker token');
  return { machineId, workerId };
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
  sendSerialized(response, status, JSON.stringify(payload), 'application/json');
};

const sendSerialized = (response: ServerResponse, status: number, payload: string, contentType: string): void => {
  response.statusCode = status;
  response.setHeader('content-type', contentType);
  response.end(payload);
};

const publicErrorEnvelope = (code: string, message: string, status: number): unknown => ({
  error: { code, message: boundedPublicErrorMessage(message), retryable: publicErrorRetryable(code, status) }
});

const boundedPublicErrorMessage = (message: string): string => message.slice(0, 4_096) || 'request failed';

export const parseError = z.object({
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).passthrough()
});
