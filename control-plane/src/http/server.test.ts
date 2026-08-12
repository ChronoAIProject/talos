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
    const claimResponse = await fetch(`${base}/v1/worker/claim`, { method: 'POST', headers: { authorization: 'Bearer worker-token-123456', 'content-type': 'application/json' }, body: JSON.stringify({ worker_id: 'w', machine_id: 'machine' }) });
    expect(claimResponse.status).toBe(200);
    const claim = await claimResponse.json() as { task: { id: string }; leaseToken: string };
    expect(claim.task.id).toBe(created.id);
    const heartbeat = await fetch(`${base}/v1/worker/tasks/${created.id}/heartbeat`, { method: 'POST', headers: { authorization: 'Bearer worker-token-123456', 'x-talos-worker-id': 'w', 'x-talos-machine-id': 'machine', 'content-type': 'application/json' }, body: JSON.stringify({ lease_token: claim.leaseToken }) });
    expect(heartbeat.status).toBe(200);
    server.close();
  });
});
