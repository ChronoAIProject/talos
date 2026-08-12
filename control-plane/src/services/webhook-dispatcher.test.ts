import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../storage/memory-repository.js';
import { WebhookSigner } from './webhook-signer.js';
import { WebhookDispatcher } from './webhook-dispatcher.js';

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
});
