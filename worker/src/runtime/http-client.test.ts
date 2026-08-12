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

  it('relays heartbeat, input, needs-input, result, and artifact requests', async () => {
    const responses = [
      { task: { id: 't', kind: 'browse', goal: 'x' }, lease: { taskId: 't', workerId: 'w', machineId: 'm', expiresAt: new Date().toISOString() }, leaseToken: 'lease_1' },
      { id: 't', kind: 'browse', goal: 'x' },
      { id: 't', kind: 'browse', goal: 'x' },
      { input: { kind: 'text', value: 'ok' } },
      { id: 't', kind: 'browse', goal: 'x' },
      { id: 't', kind: 'browse', goal: 'x' }
    ];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(responses.shift() ?? {}), { status: 200 }));
    const client = new HttpWorkerClient({ controlPlaneUrl: 'http://localhost:8080', workerId: 'w', machineId: 'm', workerToken: 'worker-token-123456' });
    await client.claim();
    await client.heartbeat('t', 'lease_1');
    await client.needsInput('t', 'lease_1');
    expect(await client.getInput('t', 'lease_1')).toMatchObject({ value: 'ok' });
    await client.result('t', 'lease_1', 'completed', []);
    await client.artifact('t', 'lease_1', { name: 'a', contentType: 'text/plain', size: 1, uri: 'https://example.com/a' });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    fetchMock.mockRestore();
  });
});
