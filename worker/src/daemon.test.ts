import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from './daemon.js';

describe('worker daemon config', () => {
  it('loads and validates environment configuration', () => {
    expect(() => loadWorkerConfig({})).toThrow();
    expect(loadWorkerConfig({ TALOS_CONTROL_PLANE_URL: 'http://localhost:8080', TALOS_WORKER_ID: 'w', TALOS_MACHINE_ID: 'm', TALOS_WORKER_TOKEN: 'worker-token-123456' })).toMatchObject({ workerId: 'w', machineId: 'm' });
  });
});
