import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlPlane } from './index.js';
import { MemoryRepository } from './storage/memory-repository.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

  it('periodically releases expired orphan testing reservations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const repository = new MemoryRepository();
    await repository.createTestingMachineReservation({
      machineId: 'testing-machine',
      runId: 'missing-run',
      taskId: 'missing-task',
      attemptId: 'orphan-attempt',
      generation: 1,
      fenceToken: 'fence-token-123456',
      status: 'reserved',
      expiresAt: new Date(1_000).toISOString(),
      recordVersion: 1
    });
    const server = createControlPlane(repository, 'webhook-secret-1234', {
      sweepIntervalMs: 10,
      adminToken: 'admin-token-123456'
    });
    await vi.advanceTimersByTimeAsync(11);
    expect(await repository.getTestingMachineReservation('testing-machine')).toBeUndefined();
    server.stopSweep();
  });

  it('serializes periodic sweeps instead of overlapping a slow pass', async () => {
    vi.useFakeTimers();
    const repository = new MemoryRepository();
    let releaseFirst: ((tasks: readonly []) => void) | undefined;
    const blocked = new Promise<readonly []>((resolve) => { releaseFirst = resolve; });
    const listTasks = vi.spyOn(repository, 'listTasks')
      .mockImplementationOnce(async () => blocked)
      .mockResolvedValue([]);
    const server = createControlPlane(repository, 'webhook-secret-1234', {
      sweepIntervalMs: 10,
      adminToken: 'admin-token-123456'
    });

    await vi.advanceTimersByTimeAsync(11);
    expect(listTasks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(listTasks).toHaveBeenCalledTimes(1);
    releaseFirst?.([]);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(11);
    expect(listTasks).toHaveBeenCalledTimes(2);
    server.stopSweep();
  });

  it('logs sweep rejections and recovers on the next interval without an unhandled rejection', async () => {
    vi.useFakeTimers();
    const repository = new MemoryRepository();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const listTasks = vi.spyOn(repository, 'listTasks')
      .mockRejectedValueOnce(new Error('task sweep unavailable'))
      .mockResolvedValue([]);
    const listTestingRuns = vi.spyOn(repository, 'listTestingRuns')
      .mockRejectedValueOnce(new Error('testing sweep unavailable'))
      .mockResolvedValue([]);
    const server = createControlPlane(repository, 'webhook-secret-1234', {
      sweepIntervalMs: 10,
      adminToken: 'admin-token-123456'
    });

    await vi.advanceTimersByTimeAsync(11);
    await vi.advanceTimersByTimeAsync(11);
    expect(listTasks.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(listTestingRuns.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(stderr.mock.calls.flat().join('\n')).toContain('task lease sweep failed');
    expect(stderr.mock.calls.flat().join('\n')).toContain('testing attempt sweep failed');
    server.stopSweep();
  });
});
