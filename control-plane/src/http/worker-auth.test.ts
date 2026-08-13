import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashWorkerToken } from '../config.js';
import { ProfileLockService } from '../services/profile-lock.js';
import { Scheduler } from '../services/scheduler.js';
import { TaskService } from '../services/task-service.js';
import { WebhookSigner } from '../services/webhook-signer.js';
import { MemoryRepository } from '../storage/memory-repository.js';
import { createApiServer } from './server.js';

describe('worker token carriers', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    const repository = new MemoryRepository();
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({
      id: 'machine',
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
      new WebhookSigner('webhook-secret-1234')
    );
    server = createApiServer(service, repository);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(() => {
    server.close();
  });

  it.each([
    ['Authorization only', { authorization: 'Bearer worker-token-123456' }, 404],
    ['custom header only', { 'x-talos-worker-token': 'worker-token-123456' }, 404],
    ['both valid carriers', { authorization: 'Bearer worker-token-123456', 'x-talos-worker-token': 'worker-token-123456' }, 404],
    ['valid custom header takes precedence', { authorization: 'Bearer wrong-token', 'x-talos-worker-token': 'worker-token-123456' }, 404],
    ['neither carrier', {}, 401],
    ['wrong Authorization token', { authorization: 'Bearer wrong-token' }, 401],
    ['wrong custom-header token', { 'x-talos-worker-token': 'wrong-token' }, 401],
    ['invalid custom header takes precedence', { authorization: 'Bearer worker-token-123456', 'x-talos-worker-token': 'wrong-token' }, 401]
  ])('%s', async (_name, tokenHeaders, expectedStatus) => {
    const response = await fetch(`${baseUrl}/v1/worker/unknown`, {
      headers: {
        ...tokenHeaders,
        'x-talos-machine-id': 'machine',
        'x-talos-worker-id': 'worker'
      }
    });
    expect(response.status).toBe(expectedStatus);
  });
});
