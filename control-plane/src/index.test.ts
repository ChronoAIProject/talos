import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlPlane } from './index.js';
import { MemoryRepository } from './storage/memory-repository.js';

afterEach(() => vi.useRealTimers());

describe('control-plane factory', () => {
  it('wires a stoppable lease sweep', () => {
    const server = createControlPlane(undefined, 'webhook-secret-1234', { sweepIntervalMs: 100000, adminToken: 'admin-token-123456' });
    expect(typeof server.stopSweep).toBe('function');
    server.stopSweep();
  });

  it('fails fast without a webhook secret', () => {
    expect(() => createControlPlane(undefined, undefined)).toThrow('TALOS_WEBHOOK_SECRET');
  });

  it('fails fast when the OpenAPI spec is unreadable', () => {
    expect(() => createControlPlane(new MemoryRepository(), 'webhook-secret-1234', {
      openApiPath: '/missing/talos-openapi.yaml'
    })).toThrow('failed to load OpenAPI spec');
  });

  it('periodically expires active leases', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);
    const repository = new MemoryRepository();
    await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'm', poolId: 'pool', tags: {}, capacity: 1, activeLeases: 1, online: true, workerTokenHash: 'x' });
    await repository.saveTask({ id: 't', userId: 'u', kind: 'browse', goal: 'x', constraints: {}, mode: 'read_only', interaction: 'autonomous', status: 'running', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), leaseExpiresAt: new Date(1000).toISOString(), workerId: 'w', machineId: 'm', findings: [], artifacts: [] });
    const server = createControlPlane(repository, 'webhook-secret-1234', { sweepIntervalMs: 10, adminToken: 'admin-token-123456' });
    await vi.advanceTimersByTimeAsync(11);
    expect((await repository.getTask('t'))?.status).toBe('submitted');
    server.stopSweep();
  });
});
