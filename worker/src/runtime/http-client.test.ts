import { describe, expect, it, vi } from 'vitest';
import { HttpWorkerClient } from './http-client.js';
import { resolveControlPlaneUrl } from './url.js';

describe('HttpWorkerClient', () => {
  it('validates claim responses and reports structured server errors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ task: { id: 't', kind: 'browse', goal: 'x', profileId: 'profile_a' }, lease: { taskId: 't', workerId: 'w', machineId: 'm', expiresAt: new Date().toISOString() }, leaseToken: 'lease_1' }), { status: 200 }));
    const client = new HttpWorkerClient({ controlPlaneUrl: 'http://localhost:8080', workerId: 'w', machineId: 'm', workerToken: 'worker-token-123456' });
    expect((await client.claim()).task).toMatchObject({ id: 't', profileId: 'profile_a' });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer worker-token-123456');
    expect(headers.get('x-talos-worker-token')).toBe('worker-token-123456');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      worker_token: 'worker-token-123456',
      worker_id: 'w',
      machine_id: 'm'
    });
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 409 }));
    await expect(client.heartbeat('t', 'lease_1')).rejects.toThrow('409');
    fetchMock.mockRestore();
  });

  it('relays heartbeat, input, needs-input, result, and artifact requests', async () => {
    const responses = [
      { task: { id: 't', kind: 'browse', goal: 'x' }, lease: { taskId: 't', workerId: 'w', machineId: 'm', expiresAt: new Date().toISOString() }, leaseToken: 'lease_1' },
      { id: 't', kind: 'browse', goal: 'x', status: 'handoff' },
      { id: 't', kind: 'browse', goal: 'x', status: 'needs_input' },
      { input: { kind: 'text', value: 'ok' } },
      { id: 't', kind: 'browse', goal: 'x', status: 'completed' },
      { id: 't', kind: 'browse', goal: 'x', status: 'running' },
      { closing: false, action: { id: 'action_1', action: { type: 'screenshot', format: 'jpeg', quality: 70 } } },
      { stored: true }
    ];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(responses.shift() ?? {}), { status: 200 }));
    const client = new HttpWorkerClient({ controlPlaneUrl: 'http://localhost:8080', workerId: 'w', machineId: 'm', workerToken: 'worker-token-123456' });
    await client.claim();
    expect(await client.heartbeat('t', 'lease_1')).toEqual({ status: 'handoff' });
    await client.needsInput('t', 'lease_1');
    expect(await client.getInput('t', 'lease_1')).toMatchObject({ value: 'ok' });
    await client.result('t', 'lease_1', 'completed', []);
    await client.artifact('t', 'lease_1', { name: 'a', contentType: 'text/plain', size: 1, uri: 'https://example.com/a' });
    expect(await client.pollAction('t', 'lease_1')).toMatchObject({ action: { id: 'action_1' } });
    await client.actionResult('t', 'action_1', 'lease_1', { value: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(8);
    for (const call of fetchMock.mock.calls) {
      expect(JSON.parse(String(call[1]?.body))).toMatchObject({
        worker_token: 'worker-token-123456',
        worker_id: 'w',
        machine_id: 'm'
      });
    }
    expect(fetchMock.mock.calls[3]?.[0].toString()).toBe('http://localhost:8080/v1/worker/tasks/t/input/poll');
    expect(fetchMock.mock.calls[3]?.[1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[6]?.[0].toString()).toContain('/actions/poll');
    expect(fetchMock.mock.calls[7]?.[0].toString()).toContain('/actions/action_1/result');
    fetchMock.mockRestore();
  });

  it.each([
    ['plain base', 'http://talos-control-plane.talos.svc.cluster.local', '/v1/worker/claim', 'http://talos-control-plane.talos.svc.cluster.local/v1/worker/claim'],
    ['prefixed base', 'https://nyxid.example.com/public/s/talos-worker', '/v1/worker/claim', 'https://nyxid.example.com/public/s/talos-worker/v1/worker/claim'],
    ['trailing slash', 'https://nyxid.example.com/public/s/talos-worker/', '/v1/worker/claim', 'https://nyxid.example.com/public/s/talos-worker/v1/worker/claim'],
    ['query string', 'https://nyxid.example.com/public/s/talos-worker', '/v1/worker/tasks/task/input?wait=true', 'https://nyxid.example.com/public/s/talos-worker/v1/worker/tasks/task/input?wait=true']
  ])('resolves a %s without discarding the base path', (_name, base, path, expected) => {
    expect(resolveControlPlaneUrl(base, path).toString()).toBe(expected);
  });
});
