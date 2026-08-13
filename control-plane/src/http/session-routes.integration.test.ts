import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { hashWorkerToken } from '../config.js';
import { ProfileLockService } from '../services/profile-lock.js';
import { Scheduler } from '../services/scheduler.js';
import { TaskService } from '../services/task-service.js';
import { WebhookSigner } from '../services/webhook-signer.js';
import { MemoryRepository } from '../storage/memory-repository.js';
import { createApiServer } from './server.js';

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}`;
};

const close = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
};

describe('interactive session HTTP API', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
  });

  it('enforces ownership, mode, one in-flight action, and action-result sizing', async () => {
    const repository = new MemoryRepository();
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({
      id: 'machine',
      poolId: 'pool',
      tags: { browser: true },
      capacity: 1,
      activeLeases: 0,
      online: true,
      workerTokenHash: hashWorkerToken('worker-token-123456')
    });
    const tasks = new TaskService(
      repository,
      new Scheduler(repository),
      new ProfileLockService(repository),
      new WebhookSigner('webhook-secret-1234')
    );
    const server = createApiServer(tasks, repository, { maxBodyBytes: 256 });
    servers.push(server);
    const base = await listen(server);
    const alice = { 'x-nyxid-identity-token': 'user:alice', 'content-type': 'application/json' };
    const bob = { 'x-nyxid-identity-token': 'user:bob', 'content-type': 'application/json' };

    expect((await fetch(`${base}/v1/sessions`, { method: 'POST', body: '{}' })).status).toBe(401);
    const createdResponse = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: alice,
      body: JSON.stringify({})
    });
    expect(createdResponse.status).toBe(201);
    const session = await createdResponse.json() as { id: string; mode: string };
    expect(session.mode).toBe('read_only');
    expect((await fetch(`${base}/v1/sessions/${session.id}`, { headers: alice })).status).toBe(200);
    expect((await fetch(`${base}/v1/sessions/${session.id}`, { headers: bob })).status).toBe(403);
    expect((await fetch(`${base}/v1/sessions/${session.id}/actions?wait_seconds=0`, {
      method: 'POST',
      headers: bob,
      body: JSON.stringify({ action: { type: 'screenshot' } })
    })).status).toBe(403);
    expect((await fetch(`${base}/v1/sessions/${session.id}/close`, {
      method: 'POST',
      headers: bob,
      body: '{}'
    })).status).toBe(403);
    expect((await fetch(`${base}/v1/sessions/${session.id}/actions?wait_seconds=26`, {
      method: 'POST',
      headers: alice,
      body: JSON.stringify({ action: { type: 'wait', milliseconds: 1 } })
    })).status).toBe(400);

    const claimResponse = await fetch(`${base}/v1/worker/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        worker_token: 'worker-token-123456',
        worker_id: 'worker',
        machine_id: 'machine'
      })
    });
    const claim = await claimResponse.json() as { leaseToken: string };
    const forbiddenAction = await fetch(`${base}/v1/sessions/${session.id}/actions?wait_seconds=0`, {
      method: 'POST',
      headers: alice,
      body: JSON.stringify({ action: { type: 'type', text: 'blocked' } })
    });
    expect(forbiddenAction.status).toBe(403);
    expect(await forbiddenAction.json()).toMatchObject({ error: { code: 'mode_forbidden' } });
    const sentResponse = await fetch(`${base}/v1/sessions/${session.id}/actions?wait_seconds=0`, {
      method: 'POST',
      headers: alice,
      body: JSON.stringify({ action: { type: 'screenshot' } })
    });
    const sent = await sentResponse.json() as { action_id: string; status: string };
    expect(sent.status).toBe('pending');
    expect((await fetch(`${base}/v1/sessions/${session.id}/actions?wait_seconds=0`, {
      method: 'POST',
      headers: alice,
      body: JSON.stringify({ action: { type: 'wait', milliseconds: 1 } })
    })).status).toBe(409);

    const credentials = {
      worker_token: 'worker-token-123456',
      worker_id: 'worker',
      machine_id: 'machine',
      lease_token: claim.leaseToken
    };
    const pollResponse = await fetch(`${base}/v1/worker/tasks/${session.id}/actions/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credentials)
    });
    expect(await pollResponse.json()).toMatchObject({ action: { id: sent.action_id, action: { format: 'jpeg' } } });
    const largeValue = 'x'.repeat(1024);
    const resultResponse = await fetch(`${base}/v1/worker/tasks/${session.id}/actions/${sent.action_id}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...credentials, result: { value: largeValue } })
    });
    expect(resultResponse.status).toBe(200);
    const actionResponse = await fetch(`${base}/v1/sessions/${session.id}/actions/${sent.action_id}?wait_seconds=0`, {
      headers: alice
    });
    expect(await actionResponse.json()).toMatchObject({ status: 'completed', result: { value: largeValue } });

    for (const taskAction of ['input', 'handoff', 'cancel']) {
      const response = await fetch(`${base}/v1/tasks/${session.id}/${taskAction}`, {
        method: 'POST',
        headers: alice,
        body: taskAction === 'input' ? JSON.stringify({ kind: 'text', value: 'x' }) : '{}'
      });
      expect(response.status).toBe(409);
    }
    expect((await fetch(`${base}/v1/sessions/${session.id}/close`, {
      method: 'POST',
      headers: alice,
      body: '{}'
    })).status).toBe(200);
  });
});
