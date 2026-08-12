import { describe, expect, it } from 'vitest';
import { loadWorkerConfig, runWorkerDaemon } from './daemon.js';

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
      createRuntime: () => ({ runOnce: async () => { runs += 1; if (runs === 1) throw Object.assign(new Error('no task'), { code: 'not_found' }); } }) as never
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await stop();
    expect(runs).toBeGreaterThan(0);
    expect(closed).toBe(true);
  });
});
