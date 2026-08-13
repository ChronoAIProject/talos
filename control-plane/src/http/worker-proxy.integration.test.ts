import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashWorkerToken } from '../config.js';
import { ProfileLockService } from '../services/profile-lock.js';
import { Scheduler } from '../services/scheduler.js';
import { TaskService } from '../services/task-service.js';
import { WebhookSigner } from '../services/webhook-signer.js';
import { MemoryRepository } from '../storage/memory-repository.js';
import { createApiServer } from './server.js';

interface TestWorkerClient {
  claim(): Promise<{ task: { id: string }; leaseToken: string }>;
  heartbeat(taskId: string, leaseToken: string): Promise<{ status: string }>;
  needsInput(taskId: string, leaseToken: string): Promise<void>;
  getInput(taskId: string, leaseToken: string): Promise<unknown>;
  result(taskId: string, leaseToken: string, status: 'completed' | 'failed', findings: readonly unknown[]): Promise<void>;
}

interface HttpWorkerClientConstructor {
  new(config: unknown): TestWorkerClient;
}

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}`;
};

const close = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
};

const forwardedHeaders = (headers: IncomingHttpHeaders): Headers => {
  const result = new Headers();
  const contentType = headers['content-type'];
  if (contentType !== undefined) result.set('content-type', Array.isArray(contentType) ? contentType.join(', ') : contentType);
  return result;
};

const readRequestBody = async (request: AsyncIterable<Uint8Array>): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

describe('worker rendezvous through a NyxID-style public proxy', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
  });

  it('completes the worker flow when the proxy strips all authentication headers', async () => {
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
    const task = await service.createTask('user-a', { kind: 'browse', goal: 'proxy test' });
    const apiServer = createApiServer(service, repository);
    servers.push(apiServer);
    const apiBase = await listen(apiServer);
    const receivedHeaderNames: string[][] = [];
    const prefix = '/public/s/talos-worker';
    const proxy = createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url ?? '/', 'http://proxy.local');
        if (!requestUrl.pathname.startsWith(`${prefix}/`)) {
          response.writeHead(404).end();
          return;
        }
        const upstreamPath = `${requestUrl.pathname.slice(prefix.length)}${requestUrl.search}`;
        const body = request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : await readRequestBody(request);
        const headers = forwardedHeaders(request.headers);
        receivedHeaderNames.push([...headers.keys()]);
        const upstream = await fetch(`${apiBase}${upstreamPath}`, {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body: body.toString('utf8') })
        });
        response.statusCode = upstream.status;
        upstream.headers.forEach((value, name) => response.setHeader(name, value));
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (error) {
        response.statusCode = 502;
        response.end(error instanceof Error ? error.message : 'proxy failure');
      }
    });
    servers.push(proxy);
    const proxyBase = await listen(proxy);
    const workerModule = await vi.importActual<{ HttpWorkerClient: HttpWorkerClientConstructor }>(
      '../../../worker/src/runtime/http-client.js'
    );
    const client = new workerModule.HttpWorkerClient({
      controlPlaneUrl: `${proxyBase}${prefix}`,
      workerId: 'worker',
      machineId: 'machine',
      workerToken: 'worker-token-123456'
    });

    const claim = await client.claim();
    expect(claim.task.id).toBe(task.id);
    expect(await client.heartbeat(task.id, claim.leaseToken)).toEqual({ status: 'running' });
    await client.needsInput(task.id, claim.leaseToken);
    await service.provideInput(task.id, 'user-a', { kind: 'text', value: 'proxy answer' });
    expect(await client.getInput(task.id, claim.leaseToken)).toEqual({ kind: 'text', value: 'proxy answer' });
    await client.result(task.id, claim.leaseToken, 'completed', []);
    expect((await repository.getTask(task.id))?.status).toBe('completed');
    expect(receivedHeaderNames).toEqual([
      ['content-type'],
      ['content-type'],
      ['content-type'],
      ['content-type'],
      ['content-type']
    ]);
  });
});
