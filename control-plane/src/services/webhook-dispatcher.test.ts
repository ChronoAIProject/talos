import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../storage/memory-repository.js';
import { WebhookSigner } from './webhook-signer.js';
import { WebhookDispatcher } from './webhook-dispatcher.js';
import { ProfileLockService } from './profile-lock.js';
import { Scheduler } from './scheduler.js';
import { TaskService } from './task-service.js';
import { hashWorkerToken } from '../config.js';
import { createServer } from 'node:http';

describe('WebhookDispatcher', () => {
  it('delivers signed events to callback and records status', async () => {
    const repository = new MemoryRepository();
    const signer = new WebhookSigner('webhook-secret-1234');
    let received = false;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        received = signer.verify({ id: 'evt', timestamp: request.headers['x-talos-webhook-timestamp'] as string, signature: request.headers['x-talos-webhook-signature'] as string, body });
        response.statusCode = 204;
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('not bound');
    const event = { id: 'evt', type: 'task.completed' as const, taskId: 'task', userId: 'u', timestamp: new Date().toISOString(), payload: {}, delivery: { status: 'pending' as const, attempts: 0 } };
    await repository.saveWebhook(event);
    await new WebhookDispatcher(repository, signer, { policy: { hosts: [`127.0.0.1:${address.port}`] } }).dispatch(event, `http://127.0.0.1:${address.port}/hook`);
    expect(received).toBe(true);
    expect((await repository.getWebhook('evt'))?.delivery.status).toBe('delivered');
    server.close();
  });

  it('retries failures and rejects unsafe callbacks', async () => {
    const repository = new MemoryRepository();
    const signer = new WebhookSigner('webhook-secret-1234');
    const event = { id: 'evt2', type: 'task.state_changed' as const, taskId: 'task', userId: 'u', timestamp: new Date().toISOString(), payload: {}, delivery: { status: 'pending' as const, attempts: 0 } };
    await repository.saveWebhook(event);
    let attempts = 0;
    const dispatcher = new (await import('./webhook-dispatcher.js')).WebhookDispatcher(repository, signer, { fetchImpl: async () => { attempts += 1; return new Response('', { status: 500 }); }, backoffMs: 0 });
    await dispatcher.dispatch(event, 'http://localhost/hook');
    expect(attempts).toBe(3);
    expect((await repository.getWebhook('evt2'))?.delivery.status).toBe('failed');
    await expect(dispatcher.dispatch(event, 'file:///tmp/hook')).rejects.toThrow('scheme');
  });

  it('receives a signed webhook during the full task lifecycle', async () => {
    const repository = new MemoryRepository();
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'machine', poolId: 'pool', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: hashWorkerToken('worker-token-123456') });
    const signer = new WebhookSigner('webhook-secret-1234');
    const received: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        if (signer.verify({ id: 'unused', timestamp: String(request.headers['x-talos-webhook-timestamp']), signature: String(request.headers['x-talos-webhook-signature']), body })) received.push(JSON.parse(body).type as string);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('not bound');
    const callback = `http://127.0.0.1:${address.port}/events`;
    const dispatcher = new WebhookDispatcher(repository, signer, { policy: { hosts: [`127.0.0.1:${address.port}`] } });
    const service = new TaskService(repository, new Scheduler(repository), new ProfileLockService(repository), signer, { onWebhook: (event, signed, url) => dispatcher.dispatch(event, url, signed) });
    const task = await service.createTask('u', { kind: 'browse', goal: 'full lifecycle', callback });
    const claim = await service.claim('w', 'machine');
    await service.heartbeat(task.id, 'w', claim.leaseToken, 60);
    await service.complete(task.id, 'w', claim.leaseToken, 'completed', []);
    expect(received).toContain('task.completed');
    server.close();
  });
});
