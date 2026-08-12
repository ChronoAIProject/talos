import { describe, expect, it } from 'vitest';
import { hashWorkerToken } from '../config.js';
import { ProfileLockService } from '../services/profile-lock.js';
import { Scheduler } from '../services/scheduler.js';
import { TaskService } from '../services/task-service.js';
import { WebhookSigner } from '../services/webhook-signer.js';
import { MemoryRepository } from '../storage/memory-repository.js';
import { createApiServer } from './server.js';

describe('control-plane HTTP API', () => {
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
    const claim = await claimResponse.json() as { task: { id: string }; leaseToken: string };
    expect(claim.task.id).toBe(created.id);
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
    const invalid = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { 'x-nyxid-identity-token': 'user:u', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'bad' }) });
    expect(invalid.status).toBe(400);
    const invalidBody = await invalid.json() as { error: { message: string } };
    expect(invalidBody.error.message).toContain('kind:');
    expect(invalidBody.error.message).not.toContain('\n');
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
    expect((await fetch(`${base}/v1/admin/machines`, { method: 'POST', headers, body: JSON.stringify({ id: 'machine', pool_id: 'pool', worker_token: 'worker-token-123456' }) })).status).toBe(201);
    expect((await fetch(`${base}/v1/admin/profiles`, { method: 'POST', headers, body: JSON.stringify({ id: 'profile', user_id: 'u' }) })).status).toBe(201);
    expect((await fetch(`${base}/v1/admin/machines/machine/rotate-token`, { method: 'POST', headers, body: JSON.stringify({ worker_token: 'rotated-worker-token-123456' }) })).status).toBe(200);
    expect((await repository.getMachine('machine'))?.workerTokenHash).toBe(hashWorkerToken('rotated-worker-token-123456'));
    await repository.saveHandoff({ id: 'h', taskId: 't', userId: 'u', url: '/v1/handoffs/h', expiresAt: new Date(2000).toISOString(), used: false });
    const handoff = await fetch(`${base}/v1/handoffs/h`, { headers: { 'x-nyxid-identity-token': 'user:u' } });
    expect(handoff.status).toBe(501);
    expect((await fetch(`${base}/v1/handoffs/h`, { headers: { 'x-nyxid-identity-token': 'user:u' } })).status).toBe(409);
    await repository.saveHandoff({ id: 'expired', taskId: 't', userId: 'u', url: '/v1/handoffs/expired', expiresAt: new Date(500).toISOString(), used: false });
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
    expect((await fetch(`${base}/v1/pools`, { method: 'POST', headers: user('alice'), body: JSON.stringify({ id: 'bad-org', visibility: 'org' }) })).status).toBe(403);
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

  it('covers input, handoff, cancellation, artifact, and result worker routes', async () => {
    const repository = new MemoryRepository();
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'machine', poolId: 'pool', tags: {}, capacity: 2, activeLeases: 0, online: true, workerTokenHash: hashWorkerToken('worker-token-123456') });
    await repository.saveProfile({ id: 'p', userId: 'u' });
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
});
