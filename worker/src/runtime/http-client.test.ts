import { describe, expect, it, vi } from 'vitest';
import { HttpWorkerClient } from './http-client.js';

describe('HttpWorkerClient', () => {
  it('validates claim responses and reports structured server errors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ task: { id: 't', kind: 'browse', goal: 'x' }, lease: { taskId: 't', workerId: 'w', machineId: 'm', expiresAt: new Date().toISOString() }, leaseToken: 'lease_1' }), { status: 200 }));
    const client = new HttpWorkerClient({ controlPlaneUrl: 'http://localhost:8080', workerId: 'w', machineId: 'm', workerToken: 'worker-token-123456' });
    expect((await client.claim()).task.id).toBe('t');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 409 }));
    await expect(client.heartbeat('t', 'lease_1')).rejects.toThrow('409');
    fetchMock.mockRestore();
  });
});
