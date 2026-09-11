import { describe, expect, it } from 'vitest';
import { hashWorkerToken } from '../config.js';
import { ProfileLockService } from '../services/profile-lock.js';
import { Scheduler } from '../services/scheduler.js';
import { TaskService } from '../services/task-service.js';
import { WebhookSigner } from '../services/webhook-signer.js';
import { MemoryRepository } from '../storage/memory-repository.js';
import type { Repository } from '../storage/repository.js';
import { createApiServer } from './server.js';
import { loadOpenApiDocument } from '../openapi.js';
import type { PendingHandoffIntent, PendingInputIntent, Task } from '../domain/types.js';

class FirstMaterializationFailureRepository extends MemoryRepository {
  public readonly attemptedIntents: PendingInputIntent[] = [];
  public successfulMaterializations = 0;

  public override async materializePendingInput(intent: PendingInputIntent): Promise<void> {
    this.attemptedIntents.push(structuredClone(intent));
    if (this.attemptedIntents.length === 1) throw new Error('injected pending input materialization failure');
    await super.materializePendingInput(intent);
    this.successfulMaterializations += 1;
  }
}

class FirstCommittedInputAcknowledgementFailureRepository extends MemoryRepository {
  public readonly attemptedIntents: PendingInputIntent[] = [];

  public override async materializePendingInput(intent: PendingInputIntent): Promise<void> {
    this.attemptedIntents.push(structuredClone(intent));
    await super.materializePendingInput(intent);
    if (this.attemptedIntents.length === 1) throw new Error('injected pending input acknowledgement failure');
  }
}

class FirstCommittedHandoffAcknowledgementFailureRepository extends MemoryRepository {
  public readonly attemptedIntents: PendingHandoffIntent[] = [];

  public override async materializeHandoff(intent: PendingHandoffIntent): Promise<void> {
    this.attemptedIntents.push(structuredClone(intent));
    await super.materializeHandoff(intent);
    if (this.attemptedIntents.length === 1) throw new Error('injected handoff acknowledgement failure');
  }
}

describe('control-plane HTTP API', () => {
  it('serves cached OpenAPI JSON and YAML without authentication', async () => {
    const repository = new MemoryRepository();
    const service = new TaskService(repository, new Scheduler(repository), new ProfileLockService(repository), new WebhookSigner('webhook-secret-1234'));
    const document = loadOpenApiDocument();
    const server = createApiServer(service, repository, { openApiDocument: document });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    const jsonResponse = await fetch(`${base}/openapi.json`);
    expect(jsonResponse.status).toBe(200);
    expect(jsonResponse.headers.get('content-type')).toBe('application/json');
    const json = await jsonResponse.json() as { openapi: string; paths: Record<string, unknown> };
    expect(json.openapi.startsWith('3.1')).toBe(true);
    expect(Object.keys(json.paths).length).toBeGreaterThan(0);
    const yamlResponse = await fetch(`${base}/openapi.yaml`);
    expect(yamlResponse.status).toBe(200);
    expect(yamlResponse.headers.get('content-type')).toBe('application/yaml');
    expect(await yamlResponse.text()).toBe(document.raw);
    server.close();
  });

  it('serves an unauthenticated repository health check', async () => {
    const repository = new MemoryRepository();
    const service = new TaskService(repository, new Scheduler(repository), new ProfileLockService(repository), new WebhookSigner('webhook-secret-1234'));
    const server = createApiServer(service, repository);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    server.close();
  });

  it('reports degraded health when repository ping fails', async () => {
    const repository = new MemoryRepository();
    repository.ping = async () => { throw new Error('database unavailable'); };
    const service = new TaskService(repository, new Scheduler(repository), new ProfileLockService(repository), new WebhookSigner('webhook-secret-1234'));
    const server = createApiServer(service, repository);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'degraded' });
    server.close();
  });

  it('maps repository failures to an opaque public error', async () => {
    const repository = new MemoryRepository();
    repository.getTask = async () => { throw new Error('claim-secret-sentinel lease-token-sentinel'); };
    const service = new TaskService(repository, new Scheduler(repository), new ProfileLockService(repository), new WebhookSigner('webhook-secret-1234'));
    const server = createApiServer(service, repository);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/tasks/task`, {
      headers: { 'x-nyxid-identity-token': 'user:user-a' }
    });
    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).toContain('internal_error');
    expect(body).not.toContain('claim-secret-sentinel');
    expect(body).not.toContain('lease-token-sentinel');
    server.close();
  });

  it('returns a retryable public conflict after authorized task CAS exhaustion', async () => {
    const storage = new MemoryRepository();
    let attempts = 0;
    const repository = new Proxy<Repository>(storage, {
      get(target, property) {
        if (property === 'replaceSubmittedTask') {
          return async (...args: Parameters<Repository['replaceSubmittedTask']>): Promise<boolean> => {
            if (args[0].status === 'cancelled') {
              attempts += 1;
              return false;
            }
            return target.replaceSubmittedTask(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const service = new TaskService(
      repository,
      new Scheduler(repository),
      new ProfileLockService(repository),
      new WebhookSigner('webhook-secret-1234')
    );
    const server = createApiServer(service, repository);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { 'content-type': 'application/json', 'x-nyxid-identity-token': 'user:user-a' };
    const created = await fetch(`${base}/v1/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'browse', goal: 'public CAS exhaustion' })
    });
    const task = await created.json() as { id: string };

    const response = await fetch(`${base}/v1/tasks/${task.id}/cancel`, { method: 'POST', headers });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: 'concurrent_update',
        message: 'task state changed concurrently',
        retryable: true
      }
    });
    expect(attempts).toBe(3);
    server.close();
  });

  it('reports an expired handoff claim as a non-retryable public conflict', async () => {
    const clock = { value: Date.now() };
    const repository = new MemoryRepository(() => clock.value);
    await repository.savePool({ id: 'expired-handoff-pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'expired-handoff-machine', poolId: 'expired-handoff-pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'hash' });
    const service = new TaskService(
      repository,
      new Scheduler(repository),
      new ProfileLockService(repository),
      new WebhookSigner('webhook-secret-1234'),
      { clock: () => clock.value, leaseSeconds: 10 }
    );
    const task = await service.createTask('user-a', { kind: 'browse', goal: 'expired handoff' });
    const claim = await service.claim('worker-a', 'expired-handoff-machine', clock.value);
    clock.value = Date.parse(claim.task.leaseExpiresAt!);
    const server = createApiServer(service, repository, { clock: () => clock.value });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/v1/tasks/${task.id}/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nyxid-identity-token': 'user:user-a' },
      body: '{}'
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: 'conflict',
        message: 'task claim is not active',
        retryable: false
      }
    });
    expect(await repository.getTask(task.id)).not.toHaveProperty('handoff');
    server.close();
  });

  it('enforces NyxID and worker authentication across lifecycle routes', async () => {
    const repository = new MemoryRepository();
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'machine', poolId: 'pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: hashWorkerToken('worker-token-123456') });
    const service = new TaskService(repository, new Scheduler(repository), new ProfileLockService(repository), new WebhookSigner('webhook-secret-1234'));
    const server = createApiServer(service, repository);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    const missing = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'browse', goal: 'x' }) });
    expect(missing.status).toBe(401);
    const createdResponse = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nyxid-identity-token': 'user:user-a' }, body: JSON.stringify({ kind: 'browse', goal: 'x' }) });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { id: string };
    const badWorker = await fetch(`${base}/v1/worker/claim`, { method: 'POST', headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' }, body: JSON.stringify({ worker_id: 'w', machine_id: 'machine' }) });
    expect(badWorker.status).toBe(401);
    const claimResponse = await fetch(`${base}/v1/worker/claim`, { method: 'POST', headers: { authorization: 'Bearer worker-token-123456', 'x-talos-worker-id': 'w', 'x-talos-machine-id': 'machine', 'content-type': 'application/json' }, body: JSON.stringify({ worker_id: 'w', machine_id: 'machine' }) });
    expect(claimResponse.status).toBe(200);
    const claim = await claimResponse.json() as { task: Record<string, unknown> & { id: string }; leaseToken: string };
    expect(claim.task.id).toBe(created.id);
    const internalAuthorityFields = [
      'claimId',
      'claimGeneration',
      'taskVersion',
      'claimCommitted',
      'claimReleased',
      'claimQueuePriority',
      'queuePriority',
      'workerId',
      'machineId',
      'leaseExpiresAt',
      'leaseToken',
      'claimRecovery',
      'pendingInputIntent'
    ];
    for (const field of internalAuthorityFields) expect(claim.task).not.toHaveProperty(field);
    const publicTaskResponse = await fetch(`${base}/v1/tasks/${created.id}`, {
      headers: { 'x-nyxid-identity-token': 'user:user-a' }
    });
    expect(publicTaskResponse.status).toBe(200);
    const publicTask = await publicTaskResponse.json() as Record<string, unknown>;
    for (const field of internalAuthorityFields) expect(publicTask).not.toHaveProperty(field);
    expect(JSON.stringify(publicTask)).not.toContain(claim.leaseToken);
    const heartbeat = await fetch(`${base}/v1/worker/tasks/${created.id}/heartbeat`, { method: 'POST', headers: { authorization: 'Bearer worker-token-123456', 'x-talos-worker-id': 'w', 'x-talos-machine-id': 'machine', 'content-type': 'application/json' }, body: JSON.stringify({ lease_token: claim.leaseToken }) });
    expect(heartbeat.status).toBe(200);
    server.close();
  });

  it('maps malformed JSON, validation, size, and cross-machine worker errors', async () => {
    const repository = new MemoryRepository();
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'machine', poolId: 'pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: hashWorkerToken('worker-token-123456') });
    await repository.saveMachine({ id: 'other', poolId: 'pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: hashWorkerToken('other-worker-token-123456') });
    const service = new TaskService(repository, new Scheduler(repository), new ProfileLockService(repository), new WebhookSigner('webhook-secret-1234'));
    const server = createApiServer(service, repository, { maxBodyBytes: 128, adminToken: 'admin-token-123456' });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    const malformed = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { 'x-nyxid-identity-token': 'user:u', 'content-type': 'application/json' }, body: '{' });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: { code: 'invalid_json', message: 'request body must be valid JSON', retryable: false }
    });
    const invalid = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { 'x-nyxid-identity-token': 'user:u', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'bad' }) });
    expect(invalid.status).toBe(400);
    const invalidBody = await invalid.json() as { error: { code: string; message: string; retryable: boolean } };
    expect(invalidBody).toEqual({
      error: { code: 'validation_error', message: 'request failed schema validation', retryable: false }
    });
    expect(invalidBody.error.message.length).toBeLessThanOrEqual(4_096);
    const oversized = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { 'x-nyxid-identity-token': 'user:u', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'browse', goal: 'x'.repeat(200) }) });
    expect(oversized.status).toBe(413);
    const unauthorizedMachine = await fetch(`${base}/v1/worker/claim`, { method: 'POST', headers: { authorization: 'Bearer worker-token-123456', 'x-talos-worker-id': 'w', 'x-talos-machine-id': 'other', 'content-type': 'application/json' }, body: JSON.stringify({ worker_id: 'w', machine_id: 'other' }) });
    expect(unauthorizedMachine.status).toBe(401);
    const unsafeCallback = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { 'x-nyxid-identity-token': 'user:u', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'browse', goal: 'x', callback: 'file:///tmp/callback' }) });
    expect(unsafeCallback.status).toBe(400);

    const taskResponse = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { 'x-nyxid-identity-token': 'user:u', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'browse', goal: 'cross-machine' }) });
    const task = await taskResponse.json() as { id: string };
    const claimResponse = await fetch(`${base}/v1/worker/claim`, { method: 'POST', headers: { authorization: 'Bearer worker-token-123456', 'x-talos-worker-id': 'w', 'x-talos-machine-id': 'machine', 'content-type': 'application/json' }, body: JSON.stringify({ worker_id: 'w', machine_id: 'machine' }) });
    const claim = await claimResponse.json() as { leaseToken: string };
    const crossMachine = await fetch(`${base}/v1/worker/tasks/${task.id}/heartbeat`, { method: 'POST', headers: { authorization: 'Bearer other-worker-token-123456', 'x-talos-worker-id': 'w', 'x-talos-machine-id': 'other', 'content-type': 'application/json' }, body: JSON.stringify({ lease_token: claim.leaseToken }) });
    expect(crossMachine.status).toBe(401);
    server.close();
  });

  it('registers pools, machines, profiles, rotates tokens, and serves one-use handoff errors', async () => {
    const repository = new MemoryRepository();
    const service = new TaskService(repository, new Scheduler(repository), new ProfileLockService(repository), new WebhookSigner('webhook-secret-1234'));
    const server = createApiServer(service, repository, { adminToken: 'admin-token-123456', clock: () => 1000 });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { 'x-talos-admin-token': 'admin-token-123456', 'content-type': 'application/json' };
    expect((await fetch(`${base}/v1/admin/pools`, { method: 'POST', headers, body: JSON.stringify({ id: 'pool', visibility: 'platform' }) })).status).toBe(201);
    expect((await fetch(`${base}/v1/admin/pools`, { method: 'POST', headers, body: JSON.stringify({ id: 'pool', visibility: 'org' }) })).status).toBe(409);
    expect((await fetch(`${base}/v1/admin/machines`, { method: 'POST', headers, body: JSON.stringify({ id: 'machine', pool_id: 'pool', worker_token: 'worker-token-123456' }) })).status).toBe(201);
    const registeredMachine = await repository.getMachine('machine');
    if (registeredMachine === undefined) throw new Error('machine was not registered');
    await repository.saveMachine({ ...registeredMachine, activeLeases: 1 });
    expect((await fetch(`${base}/v1/admin/machines`, { method: 'POST', headers, body: JSON.stringify({ id: 'machine', pool_id: 'pool', worker_token: 'replacement-token-123456' }) })).status).toBe(409);
    expect(await repository.getMachine('machine')).toMatchObject({
      activeLeases: 1,
      workerTokenHash: hashWorkerToken('worker-token-123456')
    });
    expect((await fetch(`${base}/v1/admin/profiles`, { method: 'POST', headers, body: JSON.stringify({ id: 'profile', user_id: 'u' }) })).status).toBe(201);
    expect((await fetch(`${base}/v1/admin/profiles`, { method: 'POST', headers, body: JSON.stringify({ id: 'profile', user_id: 'other-user' }) })).status).toBe(409);
    expect((await fetch(`${base}/v1/admin/machines/machine/rotate-token`, { method: 'POST', headers, body: JSON.stringify({ worker_token: 'rotated-worker-token-123456' }) })).status).toBe(200);
    expect((await repository.getMachine('machine'))?.workerTokenHash).toBe(hashWorkerToken('rotated-worker-token-123456'));
    const handoffIntent: PendingHandoffIntent = {
      schemaVersion: 'talos.task-handoff-intent/v1', operationId: 'handoff-operation-h', id: 'h', taskId: 't', userId: 'u',
      claimId: 'claim-h', claimGeneration: 1, expiresInSeconds: 1, url: '/v1/handoffs/h', expiresAt: new Date(2000).toISOString(), consumed: false
    };
    await repository.saveTask({
      id: 't', userId: 'u', kind: 'browse', goal: 'handoff', constraints: {}, mode: 'read_only', interaction: 'autonomous',
      status: 'handoff', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), findings: [], artifacts: [],
      claimId: handoffIntent.claimId, claimGeneration: handoffIntent.claimGeneration, claimCommitted: true, taskVersion: 1,
      handoff: { url: handoffIntent.url, expiresAt: handoffIntent.expiresAt }, pendingHandoffIntent: handoffIntent
    } satisfies Task);
    await repository.materializeHandoff(handoffIntent);
    const handoff = await fetch(`${base}/v1/handoffs/h`, { headers: { 'x-nyxid-identity-token': 'user:u' } });
    expect(handoff.status).toBe(501);
    expect((await fetch(`${base}/v1/handoffs/h`, { headers: { 'x-nyxid-identity-token': 'user:u' } })).status).toBe(409);
    await repository.materializeHandoff({
      ...handoffIntent,
      operationId: 'handoff-operation-expired',
      id: 'expired',
      url: '/v1/handoffs/expired',
      expiresAt: new Date(500).toISOString()
    });
    expect((await fetch(`${base}/v1/handoffs/expired`, { headers: { 'x-nyxid-identity-token': 'user:u' } })).status).toBe(409);
    server.close();
  });

  it('rejects malformed worker routes and admin credentials', async () => {
    const repository = new MemoryRepository();
    const service = new TaskService(repository, new Scheduler(repository), new ProfileLockService(repository), new WebhookSigner('webhook-secret-1234'));
    const server = createApiServer(service, repository, { adminToken: 'admin-token-123456' });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/v1/admin/pools`, { method: 'POST', headers: { 'x-talos-admin-token': 'wrong', 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await fetch(`${base}/v1/worker/nope`, { headers: { authorization: 'Bearer x', 'x-talos-machine-id': 'm', 'x-talos-worker-id': 'w' } })).status).toBe(401);
    server.close();
  });

  it('supports identity-scoped private fleets with ownership and token boundaries', async () => {
    const repository = new MemoryRepository();
    const service = new TaskService(repository, new Scheduler(repository), new ProfileLockService(repository), new WebhookSigner('webhook-secret-1234'));
    const server = createApiServer(service, repository, { adminToken: 'admin-token-123456' });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    const user = (id: string) => ({ 'x-nyxid-identity-token': `user:${id}`, 'content-type': 'application/json' });
    const poolResponse = await fetch(`${base}/v1/pools`, { method: 'POST', headers: user('alice'), body: JSON.stringify({ id: 'alice-pool', visibility: 'private', tags: { region: 'local' } }) });
    expect(poolResponse.status).toBe(201);
    expect((await poolResponse.json() as { visibility: string }).visibility).toBe('private');
    expect((await fetch(`${base}/v1/pools`, { method: 'POST', headers: user('alice'), body: JSON.stringify({ id: 'bad-org', visibility: 'org' }) })).status).toBe(201);
    expect((await fetch(`${base}/v1/pools`, { method: 'POST', headers: user('alice'), body: JSON.stringify({ id: 'forged-owner', owner_user_id: 'bob' }) })).status).toBe(400);
    expect((await fetch(`${base}/v1/pools/alice-pool/machines`, { method: 'POST', headers: user('bob'), body: JSON.stringify({ id: 'alice-machine' }) })).status).toBe(403);
    const machineResponse = await fetch(`${base}/v1/pools/alice-pool/machines`, { method: 'POST', headers: user('alice'), body: JSON.stringify({ id: 'alice-machine', tags: { os: 'macos' } }) });
    expect(machineResponse.status).toBe(201);
    const machineBody = await machineResponse.json() as { worker_token: string };
    expect(machineBody.worker_token).toMatch(/^tw_/);
    const machine = await repository.getMachine('alice-machine');
    expect(machine?.workerTokenHash).toBe(hashWorkerToken(machineBody.worker_token));
    expect((await fetch(`${base}/v1/pools/alice-pool/machines`, { headers: user('bob') })).status).toBe(403);
    expect((await fetch(`${base}/v1/machines/alice-machine/rotate-token`, { method: 'POST', headers: user('bob'), body: '{}' })).status).toBe(403);
    const rotationResponse = await fetch(`${base}/v1/machines/alice-machine/rotate-token`, { method: 'POST', headers: user('alice'), body: '{}' });
    expect(rotationResponse.status).toBe(200);
    const rotation = await rotationResponse.json() as { worker_token: string };
    expect((await repository.getMachine('alice-machine'))?.workerTokenHash).toBe(hashWorkerToken(rotation.worker_token));
    const oldAuthentication = await fetch(`${base}/v1/worker/nope`, { headers: { authorization: `Bearer ${machineBody.worker_token}`, 'x-talos-machine-id': 'alice-machine', 'x-talos-worker-id': 'worker' } });
    expect(oldAuthentication.status).toBe(401);
    const newAuthentication = await fetch(`${base}/v1/worker/nope`, { headers: { authorization: `Bearer ${rotation.worker_token}`, 'x-talos-machine-id': 'alice-machine', 'x-talos-worker-id': 'worker' } });
    expect(newAuthentication.status).toBe(404);
    const profileResponse = await fetch(`${base}/v1/profiles`, { method: 'POST', headers: user('alice'), body: JSON.stringify({ machine_id: 'alice-machine' }) });
    expect(profileResponse.status).toBe(201);
    const profileBody = await profileResponse.json() as { id: string; userId: string };
    expect(profileBody.userId).toBe('alice');
    const profiles = await fetch(`${base}/v1/profiles`, { headers: user('alice') });
    expect(profiles.status).toBe(200);
    expect((await profiles.json() as Array<{ id: string }>).some((profile) => profile.id === profileBody.id)).toBe(true);
    const aliceMachines = await fetch(`${base}/v1/pools/alice-pool/machines`, { headers: user('alice') });
    expect(await aliceMachines.json()).toEqual([{
      id: 'alice-machine',
      tags: { os: 'macos' },
      capacity: 1,
      online: true,
      activeLeases: 0
    }]);
    expect((await fetch(`${base}/v1/pools`, { method: 'POST', headers: user('bob'), body: JSON.stringify({ id: 'bob-pool' }) })).status).toBe(201);
    expect((await fetch(`${base}/v1/pools/bob-pool/machines`, { method: 'POST', headers: user('bob'), body: JSON.stringify({ id: 'bob-machine' }) })).status).toBe(201);
    expect((await fetch(`${base}/v1/profiles`, { method: 'POST', headers: user('bob'), body: JSON.stringify({ id: 'bob-profile', machine_id: 'bob-machine' }) })).status).toBe(201);
    expect((await fetch(`${base}/v1/profiles`, { method: 'POST', headers: user('bob'), body: JSON.stringify({ id: 'bob-profile' }) })).status).toBe(409);
    const bobPools = await fetch(`${base}/v1/pools`, { headers: user('bob') });
    expect(bobPools.status).toBe(200);
    expect((await bobPools.json() as Array<{ id: string }>).map((pool) => pool.id)).toEqual(['bob-pool']);
    expect((await (await fetch(`${base}/v1/profiles`, { headers: user('bob') })).json() as Array<{ id: string }>).map((profile) => profile.id)).toEqual(['bob-profile']);
    expect((await fetch(`${base}/v1/profiles`, { method: 'POST', headers: user('bob'), body: JSON.stringify({ machine_id: 'alice-machine' }) })).status).toBe(403);
    server.close();
  });

  it('targets a submitted task to the caller-owned pool', async () => {
    const repository = new MemoryRepository();
    await repository.savePool({ id: 'platform', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'platform-machine', poolId: 'platform', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: hashWorkerToken('platform-worker-token-123456') });
    const service = new TaskService(repository, new Scheduler(repository), new ProfileLockService(repository), new WebhookSigner('webhook-secret-1234'));
    const server = createApiServer(service, repository);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { 'x-nyxid-identity-token': 'user:alice', 'content-type': 'application/json' };
    await fetch(`${base}/v1/pools`, { method: 'POST', headers, body: JSON.stringify({ id: 'alice-pool' }) });
    const enrolled = await fetch(`${base}/v1/pools/alice-pool/machines`, { method: 'POST', headers, body: JSON.stringify({ id: 'alice-machine' }) });
    expect(enrolled.status).toBe(201);
    const enrollment = await enrolled.json() as { worker_token: string };
    const task = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ kind: 'browse', goal: 'local', pool_id: 'alice-pool' }) });
    expect(task.status).toBe(201);
    expect((await task.json() as { poolId: string }).poolId).toBe('alice-pool');
    const claimOnPlatform = await fetch(`${base}/v1/worker/claim`, { method: 'POST', headers: { authorization: 'Bearer platform-worker-token-123456', 'x-talos-machine-id': 'platform-machine', 'x-talos-worker-id': 'platform-worker', 'content-type': 'application/json' }, body: JSON.stringify({ worker_id: 'platform-worker', machine_id: 'platform-machine' }) });
    expect(claimOnPlatform.status).toBe(404);
    const claimOnAlice = await fetch(`${base}/v1/worker/claim`, { method: 'POST', headers: { authorization: `Bearer ${enrollment.worker_token}`, 'x-talos-machine-id': 'alice-machine', 'x-talos-worker-id': 'alice-worker', 'content-type': 'application/json' }, body: JSON.stringify({ worker_id: 'alice-worker', machine_id: 'alice-machine' }) });
    expect(claimOnAlice.status).toBe(200);
    const foreign = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { 'x-nyxid-identity-token': 'user:bob', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'browse', goal: 'foreign', pool_id: 'alice-pool' }) });
    expect(foreign.status).toBe(403);
    const unknown = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ kind: 'browse', goal: 'unknown', pool_id: 'missing-pool' }) });
    expect(unknown.status).toBe(404);
    server.close();
  });

  it('shares an org pool with matching NyxID groups through claim and completion', async () => {
    const repository = new MemoryRepository();
    const service = new TaskService(repository, new Scheduler(repository), new ProfileLockService(repository), new WebhookSigner('webhook-secret-1234'));
    const server = createApiServer(service, repository);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    const identity = (value: string) => ({ 'x-nyxid-identity-token': value, 'content-type': 'application/json' });
    const owner = identity('user:alice');
    const member = identity('user:bob;groups=eng');
    await expect((await fetch(`${base}/v1/pools`, { method: 'POST', headers: owner, body: JSON.stringify({ id: 'eng-pool', visibility: 'org', shared_with_groups: ['eng'] }) })).status).toBe(201);
    const enrolled = await fetch(`${base}/v1/pools/eng-pool/machines`, { method: 'POST', headers: owner, body: JSON.stringify({ id: 'eng-machine' }) });
    const token = (await enrolled.json() as { worker_token: string }).worker_token;
    const submitted = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: member, body: JSON.stringify({ kind: 'browse', goal: 'shared', pool_id: 'eng-pool' }) });
    expect(submitted.status).toBe(201);
    expect((await fetch(`${base}/v1/tasks`, { method: 'POST', headers: identity('user:bob;groups=sales'), body: JSON.stringify({ kind: 'browse', goal: 'denied', pool_id: 'eng-pool' }) })).status).toBe(403);
    const task = await submitted.json() as { id: string };
    const workerHeaders = { authorization: `Bearer ${token}`, 'x-talos-machine-id': 'eng-machine', 'x-talos-worker-id': 'worker', 'content-type': 'application/json' };
    const claim = await fetch(`${base}/v1/worker/claim`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: 'worker', machine_id: 'eng-machine' }) });
    expect(claim.status).toBe(200);
    const lease = await claim.json() as { leaseToken: string };
    const result = await fetch(`${base}/v1/worker/tasks/${task.id}/result`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ lease_token: lease.leaseToken, status: 'completed' }) });
    expect(result.status).toBe(200);
    const patch = await fetch(`${base}/v1/pools/eng-pool`, { method: 'PATCH', headers: owner, body: JSON.stringify({ shared_with_groups: ['ops'] }) });
    expect(patch.status).toBe(200);
    expect((await fetch(`${base}/v1/pools/eng-pool`, { method: 'PATCH', headers: member, body: JSON.stringify({ visibility: 'private' }) })).status).toBe(403);
    expect((await fetch(`${base}/v1/pools/eng-pool`, { method: 'PATCH', headers: owner, body: JSON.stringify({ visibility: 'platform' }) })).status).toBe(400);
    server.close();
  });

  it('covers input, handoff, cancellation, artifact, and result worker routes', async () => {
    const repository = new MemoryRepository();
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'machine', poolId: 'pool', tags: {}, capacity: 2, activeLeases: 0, online: true, workerTokenHash: hashWorkerToken('worker-token-123456') });
    await repository.createProfile({ id: 'p', userId: 'u' });
    const service = new TaskService(repository, new Scheduler(repository), new ProfileLockService(repository), new WebhookSigner('webhook-secret-1234'));
    const server = createApiServer(service, repository);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    const publicHeaders = { 'x-nyxid-identity-token': 'user:u', 'content-type': 'application/json' };
    const workerHeaders = { authorization: 'Bearer worker-token-123456', 'x-talos-worker-id': 'w', 'x-talos-machine-id': 'machine', 'content-type': 'application/json' };
    const create = async (goal: string) => (await (await fetch(`${base}/v1/tasks`, { method: 'POST', headers: publicHeaders, body: JSON.stringify({ kind: 'browse', goal }) })).json() as { id: string }).id;
    const inputTask = await create('input');
    const claim = await (await fetch(`${base}/v1/worker/claim`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: 'w', machine_id: 'machine' }) })).json() as { leaseToken: string };
    const leaseHeaders = { ...workerHeaders, 'content-type': 'application/json' };
    expect((await fetch(`${base}/v1/worker/tasks/${inputTask}/needs-input`, { method: 'POST', headers: leaseHeaders, body: JSON.stringify({ lease_token: claim.leaseToken }) })).status).toBe(200);
    expect((await fetch(`${base}/v1/tasks/${inputTask}/input`, { method: 'POST', headers: publicHeaders, body: JSON.stringify({ kind: 'text', value: 'answer' }) })).status).toBe(200);
    expect((await fetch(`${base}/v1/worker/tasks/${inputTask}/input`, { headers: { ...workerHeaders, 'x-talos-lease-token': claim.leaseToken } })).status).toBe(200);
    await fetch(`${base}/v1/worker/tasks/${inputTask}/needs-input`, { method: 'POST', headers: leaseHeaders, body: JSON.stringify({ lease_token: claim.leaseToken }) });
    await fetch(`${base}/v1/tasks/${inputTask}/input`, { method: 'POST', headers: publicHeaders, body: JSON.stringify({ kind: 'text', value: 'second answer' }) });
    const proxyPoll = await fetch(`${base}/v1/worker/tasks/${inputTask}/input/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lease_token: claim.leaseToken,
        worker_token: 'worker-token-123456',
        worker_id: 'w',
        machine_id: 'machine'
      })
    });
    expect(proxyPoll.status).toBe(200);
    expect(await proxyPoll.json()).toEqual({ input: { kind: 'text', value: 'second answer' } });
    expect((await fetch(`${base}/v1/worker/tasks/${inputTask}/artifacts`, { method: 'POST', headers: leaseHeaders, body: JSON.stringify({ lease_token: claim.leaseToken, name: 'a', content_type: 'text/plain', size: 1, uri: 'https://example.com/a' }) })).status).toBe(201);
    expect((await fetch(`${base}/v1/worker/tasks/${inputTask}/result`, { method: 'POST', headers: leaseHeaders, body: JSON.stringify({ lease_token: claim.leaseToken, status: 'completed' }) })).status).toBe(200);
    const handoffTask = await create('handoff');
    const claim2 = await (await fetch(`${base}/v1/worker/claim`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: 'w', machine_id: 'machine' }) })).json() as { leaseToken: string };
    await fetch(`${base}/v1/worker/tasks/${handoffTask}/heartbeat`, { method: 'POST', headers: leaseHeaders, body: JSON.stringify({ lease_token: claim2.leaseToken }) });
    expect((await fetch(`${base}/v1/tasks/${handoffTask}/handoff`, { method: 'POST', headers: publicHeaders, body: '{}' })).status).toBe(200);
    const cancelTask = await create('cancel');
    expect((await fetch(`${base}/v1/tasks/${cancelTask}/cancel`, { method: 'POST', headers: publicHeaders })).status).toBe(200);
    expect((await fetch(`${base}/v1/profiles/p/login-link`, { method: 'POST', headers: publicHeaders })).status).toBe(501);
    server.close();
  });

  it('reconciles one generation-bound input after post-CAS materialization failure', async () => {
    const now = Date.parse('2026-09-11T12:00:00.000Z');
    const repository = new FirstMaterializationFailureRepository(() => now);
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({
      id: 'machine-a',
      poolId: 'pool',
      tags: {},
      capacity: 1,
      activeLeases: 0,
      online: true,
      workerTokenHash: hashWorkerToken('worker-token-123456')
    });
    const service = new TaskService(
      repository,
      new Scheduler(repository),
      new ProfileLockService(repository),
      new WebhookSigner('webhook-secret-1234'),
      { clock: () => now }
    );
    const server = createApiServer(service, repository, { clock: () => now });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    const publicHeaders = {
      'content-type': 'application/json',
      'x-nyxid-identity-token': 'user:user-a'
    };
    const workerHeaders = {
      authorization: 'Bearer worker-token-123456',
      'content-type': 'application/json',
      'x-talos-worker-id': 'worker-a',
      'x-talos-machine-id': 'machine-a'
    };
    const internalFields = [
      'pendingInputIntent',
      'operationId',
      'claimId',
      'claimGeneration',
      'leaseToken',
      'workerId',
      'machineId'
    ];
    const assertPublicTask = (task: Record<string, unknown>): void => {
      for (const field of internalFields) expect(task).not.toHaveProperty(field);
    };

    try {
      const createdResponse = await fetch(`${base}/v1/tasks`, {
        method: 'POST',
        headers: publicHeaders,
        body: JSON.stringify({ kind: 'browse', goal: 'recover input' })
      });
      const created = await createdResponse.json() as Record<string, unknown> & { id: string };
      expect(createdResponse.status).toBe(201);
      assertPublicTask(created);

      const claimResponse = await fetch(`${base}/v1/worker/claim`, {
        method: 'POST',
        headers: workerHeaders,
        body: JSON.stringify({ worker_id: 'worker-a', machine_id: 'machine-a' })
      });
      const claim = await claimResponse.json() as { task: Record<string, unknown>; leaseToken: string };
      expect(claimResponse.status).toBe(200);
      assertPublicTask(claim.task);

      const needsInputResponse = await fetch(`${base}/v1/worker/tasks/${created.id}/needs-input`, {
        method: 'POST',
        headers: workerHeaders,
        body: JSON.stringify({ lease_token: claim.leaseToken })
      });
      expect(needsInputResponse.status).toBe(200);
      assertPublicTask(await needsInputResponse.json() as Record<string, unknown>);

      const firstInputResponse = await fetch(`${base}/v1/tasks/${created.id}/input`, {
        method: 'POST',
        headers: publicHeaders,
        body: '{"kind":"text","value":"answer"}'
      });
      expect(firstInputResponse.status).toBe(500);
      expect(await firstInputResponse.json()).toEqual({
        error: { code: 'internal_error', message: 'internal server error', retryable: true }
      });
      const failedTask = await repository.getTask(created.id);
      expect(failedTask).toMatchObject({
        status: 'running',
        pendingInputIntent: {
          taskId: created.id,
          claimId: failedTask?.claimId,
          claimGeneration: failedTask?.claimGeneration,
          input: { kind: 'text', value: 'answer' }
        }
      });
      expect(failedTask?.pendingInputIntent?.claimGeneration).toBeGreaterThan(0);
      expect(repository.attemptedIntents).toHaveLength(1);
      expect(repository.successfulMaterializations).toBe(0);

      const retryResponse = await fetch(`${base}/v1/tasks/${created.id}/input`, {
        method: 'POST',
        headers: publicHeaders,
        body: '{"kind":"text","value":"answer"}'
      });
      expect(retryResponse.status).toBe(200);
      const retriedTask = await retryResponse.json() as Record<string, unknown> & { status: string };
      expect(retriedTask.status).toBe('running');
      assertPublicTask(retriedTask);
      expect(repository.attemptedIntents).toHaveLength(2);
      expect(repository.attemptedIntents[1]?.operationId).toBe(repository.attemptedIntents[0]?.operationId);
      expect(repository.successfulMaterializations).toBe(1);

      const pollBody = JSON.stringify({
        lease_token: claim.leaseToken,
        worker_token: 'worker-token-123456',
        worker_id: 'worker-a',
        machine_id: 'machine-a'
      });
      const firstPoll = await fetch(`${base}/v1/worker/tasks/${created.id}/input/poll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: pollBody
      });
      expect(firstPoll.status).toBe(200);
      expect(await firstPoll.json()).toEqual({ input: { kind: 'text', value: 'answer' } });

      const secondPoll = await fetch(`${base}/v1/worker/tasks/${created.id}/input/poll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: pollBody
      });
      expect(secondPoll.status).toBe(200);
      expect(await secondPoll.json()).toEqual({});
      expect(await repository.getTask(created.id)).not.toHaveProperty('pendingInputIntent');
    } finally {
      server.close();
    }
  });

  it('reconciles committed input materialization after a lost acknowledgement', async () => {
    const now = Date.parse('2026-09-11T12:00:00.000Z');
    const repository = new FirstCommittedInputAcknowledgementFailureRepository(() => now);
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'machine', poolId: 'pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: hashWorkerToken('worker-token-123456') });
    const service = new TaskService(repository, new Scheduler(repository), new ProfileLockService(repository), new WebhookSigner('webhook-secret-1234'), { clock: () => now });
    const server = createApiServer(service, repository, { clock: () => now });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    const publicHeaders = { 'content-type': 'application/json', 'x-nyxid-identity-token': 'user:user-a' };
    const workerHeaders = { authorization: 'Bearer worker-token-123456', 'content-type': 'application/json', 'x-talos-worker-id': 'worker-a', 'x-talos-machine-id': 'machine' };
    try {
      const created = await (await fetch(`${base}/v1/tasks`, { method: 'POST', headers: publicHeaders, body: JSON.stringify({ kind: 'browse', goal: 'recover committed input' }) })).json() as { id: string };
      const claim = await (await fetch(`${base}/v1/worker/claim`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: 'worker-a', machine_id: 'machine' }) })).json() as { leaseToken: string };
      await fetch(`${base}/v1/worker/tasks/${created.id}/needs-input`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ lease_token: claim.leaseToken }) });
      const body = '{"kind":"text","value":" answer "}';
      const first = await fetch(`${base}/v1/tasks/${created.id}/input`, { method: 'POST', headers: publicHeaders, body });
      expect(first.status).toBe(500);
      expect(await first.json()).toEqual({ error: { code: 'internal_error', message: 'internal server error', retryable: true } });
      const retry = await fetch(`${base}/v1/tasks/${created.id}/input`, { method: 'POST', headers: publicHeaders, body });
      expect(retry.status).toBe(200);
      expect(repository.attemptedIntents).toHaveLength(2);
      expect(repository.attemptedIntents[1]).toEqual(repository.attemptedIntents[0]);
      const pollBody = JSON.stringify({ lease_token: claim.leaseToken, worker_token: 'worker-token-123456', worker_id: 'worker-a', machine_id: 'machine' });
      const firstPoll = await fetch(`${base}/v1/worker/tasks/${created.id}/input/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: pollBody });
      expect(await firstPoll.json()).toEqual({ input: { kind: 'text', value: ' answer ' } });
      const secondPoll = await fetch(`${base}/v1/worker/tasks/${created.id}/input/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: pollBody });
      expect(await secondPoll.json()).toEqual({});
    } finally {
      server.close();
    }
  });

  it('reconciles one handoff after a committed materialization loses acknowledgement', async () => {
    const now = Date.parse('2026-09-11T12:00:00.000Z');
    const repository = new FirstCommittedHandoffAcknowledgementFailureRepository(() => now);
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'machine', poolId: 'pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: hashWorkerToken('worker-token-123456') });
    const service = new TaskService(repository, new Scheduler(repository), new ProfileLockService(repository), new WebhookSigner('webhook-secret-1234'), { clock: () => now });
    const server = createApiServer(service, repository, { clock: () => now });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    const publicHeaders = { 'content-type': 'application/json', 'x-nyxid-identity-token': 'user:user-a' };
    const workerHeaders = { authorization: 'Bearer worker-token-123456', 'content-type': 'application/json', 'x-talos-worker-id': 'worker-a', 'x-talos-machine-id': 'machine' };
    try {
      const created = await (await fetch(`${base}/v1/tasks`, { method: 'POST', headers: publicHeaders, body: JSON.stringify({ kind: 'browse', goal: 'recover committed handoff' }) })).json() as { id: string };
      const claim = await (await fetch(`${base}/v1/worker/claim`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: 'worker-a', machine_id: 'machine' }) })).json() as { leaseToken: string };
      await fetch(`${base}/v1/worker/tasks/${created.id}/heartbeat`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ lease_token: claim.leaseToken }) });
      const first = await fetch(`${base}/v1/tasks/${created.id}/handoff`, { method: 'POST', headers: publicHeaders, body: '{"expires_in_seconds":900}' });
      expect(first.status).toBe(500);
      expect(await first.json()).toEqual({ error: { code: 'internal_error', message: 'internal server error', retryable: true } });
      const retry = await fetch(`${base}/v1/tasks/${created.id}/handoff`, { method: 'POST', headers: publicHeaders, body: '{"expires_in_seconds":900}' });
      expect(retry.status).toBe(200);
      const response = await retry.json() as { handoff_url: string; expires: string };
      expect(response).toEqual({ handoff_url: repository.attemptedIntents[0]?.url, expires: repository.attemptedIntents[0]?.expiresAt });
      expect(repository.attemptedIntents).toHaveLength(2);
      expect(repository.attemptedIntents[1]).toEqual(repository.attemptedIntents[0]);
      const task = await (await fetch(`${base}/v1/tasks/${created.id}`, { headers: publicHeaders })).json() as Record<string, unknown>;
      expect(task).not.toHaveProperty('pendingHandoffIntent');
      expect(task).not.toHaveProperty('operationId');
      const concurrent = await Promise.all([
        fetch(`${base}${response.handoff_url}`, { headers: { 'x-nyxid-identity-token': 'user:user-a' } }),
        fetch(`${base}${response.handoff_url}`, { headers: { 'x-nyxid-identity-token': 'user:user-a' } })
      ]);
      expect(concurrent.map((candidate) => candidate.status).sort()).toEqual([409, 501]);
      for (const candidate of concurrent) {
        expect(await candidate.json()).toEqual(candidate.status === 501
          ? { error: { code: 'not_implemented', message: 'hosted handoff views are planned for Phase 3', retryable: false } }
          : { error: { code: 'handoff_expired', message: 'handoff link is expired or already used', retryable: false } });
      }
      const repeated = await fetch(`${base}${response.handoff_url}`, { headers: { 'x-nyxid-identity-token': 'user:user-a' } });
      expect(repeated.status).toBe(409);
      expect(await repeated.json()).toEqual({ error: { code: 'handoff_expired', message: 'handoff link is expired or already used', retryable: false } });
    } finally {
      server.close();
    }
  });

});
