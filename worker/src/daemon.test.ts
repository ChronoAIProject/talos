import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadWorkerConfig, runWorkerDaemon } from './daemon.js';
import { WorkerClientError } from './runtime/errors.js';

describe('worker daemon config', () => {
  it('loads and validates environment configuration', () => {
    expect(() => loadWorkerConfig({})).toThrow();
    expect(loadWorkerConfig({ TALOS_CONTROL_PLANE_URL: 'http://localhost:8080', TALOS_WORKER_ID: 'w', TALOS_MACHINE_ID: 'm', TALOS_WORKER_TOKEN: 'worker-token-123456' })).toMatchObject({ workerId: 'w', machineId: 'm' });
  });

  it('runs the loop with injected dependencies and stops cleanly', async () => {
    let runs = 0;
    let closed = false;
    const config = { TALOS_CONTROL_PLANE_URL: 'http://localhost:8080', TALOS_WORKER_ID: 'w', TALOS_MACHINE_ID: 'm', TALOS_WORKER_TOKEN: 'worker-token-123456', TALOS_POLL_MS: '1' };
    const stop = await runWorkerDaemon(config, {
      createClient: () => ({}) as never,
      createExecutor: () => ({ close: async () => { closed = true; } }) as never,
      createRuntime: (_client, createExecutor) => ({
        runOnce: async () => {
          const executor = await createExecutor({
            id: 'task',
            kind: 'browse',
            goal: 'test',
            interaction: 'autonomous'
          });
          runs += 1;
          await executor.close();
          if (runs === 1) throw Object.assign(new Error('no task'), { code: 'not_found' });
        }
      }) as never
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await stop();
    expect(runs).toBeGreaterThan(0);
    expect(closed).toBe(true);
  });

  it('grows backoff for persistent non-empty-queue failures', async () => {
    const delays: number[] = [];
    const config = { TALOS_CONTROL_PLANE_URL: 'http://localhost:8080', TALOS_WORKER_ID: 'w', TALOS_MACHINE_ID: 'm', TALOS_WORKER_TOKEN: 'worker-token-123456', TALOS_POLL_MS: '2' };
    const stop = await runWorkerDaemon(config, {
      createClient: () => ({}) as never,
      createExecutor: () => ({ close: async () => undefined }) as never,
      createRuntime: () => ({ runOnce: async () => { throw new WorkerClientError('http_error', 'down', 503); } }) as never,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        if (delays.length === 3) process.emit('SIGTERM');
      }
    });
    for (let attempt = 0; attempt < 20 && delays.length < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await stop();
    expect(delays).toEqual([2, 4, 8]);
  });

  it('polls the fixed testing path before falling back to the existing browser queue', async () => {
    const calls: string[] = [];
    const config = {
      TALOS_CONTROL_PLANE_URL: 'http://localhost:8080',
      TALOS_WORKER_ID: 'w',
      TALOS_MACHINE_ID: 'm',
      TALOS_WORKER_TOKEN: 'worker-token-123456',
      TALOS_POLL_MS: '1',
      TALOS_TESTING_RUNTIME_URL: 'http://127.0.0.1:4317',
      TALOS_TESTING_RUNTIME_CREDENTIAL: 'runtime-credential-1234',
      TALOS_TESTING_AUTHORIZATION_RESOLVER_URL: 'https://authorization.example/resolve',
      TALOS_TESTING_AUTHORIZATION_RESOLVER_TOKEN: 'resolver-token-123456'
    };
    const stop = await runWorkerDaemon(config, {
      createClient: () => ({}) as never,
      createRuntime: () => ({
        runOnce: async () => {
          calls.push('browser');
          process.emit('SIGTERM');
        }
      }) as never,
      createTestingControlPlane: () => ({
        claimReconcile: async () => { calls.push('testing-reconcile'); return undefined; },
        claim: async () => { calls.push('testing-start'); return undefined; }
      }) as never,
      createLocalQARuntimeAdapter: () => ({}) as never,
      createTestingAuthorizationResolver: () => ({}) as never,
      sleep: async () => undefined
    });
    for (let attempt = 0; attempt < 20 && !calls.includes('browser'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await stop();
    expect(calls.slice(0, 3)).toEqual(['testing-reconcile', 'testing-start', 'browser']);
  });

  it('aborts a pending testing claim on shutdown without falling back to the browser queue', async () => {
    const calls: string[] = [];
    let claimStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { claimStarted = resolve; });
    const config = {
      TALOS_CONTROL_PLANE_URL: 'http://localhost:8080',
      TALOS_WORKER_ID: 'w',
      TALOS_MACHINE_ID: 'm',
      TALOS_WORKER_TOKEN: 'worker-token-123456',
      TALOS_POLL_MS: '1',
      TALOS_TESTING_RUNTIME_URL: 'http://127.0.0.1:4317',
      TALOS_TESTING_RUNTIME_CREDENTIAL: 'runtime-credential-1234',
      TALOS_TESTING_AUTHORIZATION_RESOLVER_URL: 'https://authorization.example/resolve',
      TALOS_TESTING_AUTHORIZATION_RESOLVER_TOKEN: 'resolver-token-123456'
    };
    const stop = await runWorkerDaemon(config, {
      createClient: () => ({}) as never,
      createRuntime: () => ({
        runOnce: async () => { calls.push('browser'); }
      }) as never,
      createTestingControlPlane: () => ({
        claimReconcile: async (signal?: AbortSignal) => {
          calls.push('testing-reconcile');
          claimStarted?.();
          return await new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
        claim: async () => { calls.push('testing-start'); return undefined; }
      }) as never,
      createLocalQARuntimeAdapter: () => ({}) as never,
      createTestingAuthorizationResolver: () => ({}) as never,
      sleep: async () => undefined
    });
    await started;
    await stop();
    expect(calls).toEqual(['testing-reconcile']);
  });

  it('does not log untrusted testing claim validation content', async () => {
    const credential = 'worker-token-123456';
    const localPath = '/Users/private/testing-source';
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = {
      TALOS_CONTROL_PLANE_URL: 'http://localhost:8080',
      TALOS_WORKER_ID: 'w',
      TALOS_MACHINE_ID: 'm',
      TALOS_WORKER_TOKEN: credential,
      TALOS_POLL_MS: '1',
      TALOS_TESTING_RUNTIME_URL: 'http://127.0.0.1:4317',
      TALOS_TESTING_RUNTIME_CREDENTIAL: 'runtime-credential-1234',
      TALOS_TESTING_AUTHORIZATION_RESOLVER_URL: 'https://authorization.example/resolve',
      TALOS_TESTING_AUTHORIZATION_RESOLVER_TOKEN: 'resolver-token-123456'
    };
    const stop = await runWorkerDaemon(config, {
      createClient: () => ({}) as never,
      createRuntime: () => ({
        runOnce: async () => { process.emit('SIGTERM'); }
      }) as never,
      createTestingControlPlane: () => ({
        claimReconcile: async () => {
          throw z.literal('valid-claim').parse(`${credential} ${localPath} ${'x'.repeat(4_096)}`);
        },
        claim: async () => undefined
      }) as never,
      createLocalQARuntimeAdapter: () => ({}) as never,
      createTestingAuthorizationResolver: () => ({}) as never,
      sleep: async () => undefined
    });
    for (let attempt = 0; attempt < 20 && write.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await stop();

    const logged = write.mock.calls.map((call) => String(call[0])).join('');
    expect(logged).toContain('unexpected_error');
    expect(logged).not.toContain(credential);
    expect(logged).not.toContain(localPath);
    expect(logged).not.toContain('xxxx');
    write.mockRestore();
  });
});
