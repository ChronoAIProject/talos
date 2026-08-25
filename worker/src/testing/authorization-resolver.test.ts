import { describe, expect, it, vi } from 'vitest';
import { HttpTestingAuthorizationResolver } from './authorization-resolver.js';

describe('HttpTestingAuthorizationResolver', () => {
  it('requires HTTPS except for loopback development endpoints', () => {
    expect(() => new HttpTestingAuthorizationResolver({
      url: 'http://authorization.example/resolve',
      token: 'resolver-token-123456'
    })).toThrow('authorization resolver must use HTTPS, or HTTP on loopback');
    expect(() => new HttpTestingAuthorizationResolver({
      url: 'http://127.0.0.1:4318/resolve',
      token: 'resolver-token-123456'
    })).not.toThrow();
  });

  it('strictly validates the authority response and never embeds its credential in the request body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      schema_version: 'wrong-version'
    }), { status: 200 }));
    const resolver = new HttpTestingAuthorizationResolver({
      url: 'https://authorization.example/resolve',
      token: 'resolver-token-123456'
    });
    const request = authorizationRequest();
    await expect(resolver.resolve(request)).rejects.toThrow();
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('token');
    expect(body).not.toHaveProperty('credential');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer resolver-token-123456');
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('error');
    fetchMock.mockRestore();
  });

  it('preserves only a bounded remote error code and local generic message', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'authorization_denied', message: 'echo resolver-token-123456' }
    }), { status: 403 }));
    const resolver = new HttpTestingAuthorizationResolver({
      url: 'https://authorization.example/resolve',
      token: 'resolver-token-123456'
    });
    await expect(resolver.resolve(authorizationRequest())).rejects.toMatchObject({
      code: 'authorization_denied',
      message: 'testing authorization resolver failed (403)',
      status: 403
    });
    fetchMock.mockRestore();
  });

  it('stops reading an oversized streamed authority response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('x'.repeat(1_048_577), { status: 200 })
    );
    const resolver = new HttpTestingAuthorizationResolver({
      url: 'https://authorization.example/resolve',
      token: 'resolver-token-123456'
    });
    await expect(resolver.resolve(authorizationRequest())).rejects.toMatchObject({
      code: 'authorization_response_too_large'
    });
    fetchMock.mockRestore();
  });
});

const authorizationRequest = () => ({
  schema_version: 'talos.testing-authorization-resolution-request/v1' as const,
  operation: 'cancel' as const,
  attempt: {
    schema_version: 'talos.testing-runtime-attempt/v1' as const,
    operation: 'start' as const,
    run_id: 'run-1',
    task_id: 'task-1',
    attempt_id: 'attempt-1',
    machine_id: 'machine-1',
    worker_id: 'worker-1',
    generation: 1,
    lease_id: 'lease-1',
    fence_token: 'testing-fence-token-1',
    admission_nonce: 'testing-admission-1',
    lease_claim: {
      schema: 'talos.testing-lease-claim/v1' as const,
      ref: 'talos://testing/claims/run-1/claim-1',
      digest: `sha256:${'a'.repeat(64)}`,
      expires_at: '2026-08-24T00:10:00.000Z'
    },
    deadline: '2026-08-24T00:10:00.000Z'
  },
  current_claim_digest: `sha256:${'a'.repeat(64)}`,
  http_method: 'POST' as const,
  canonical_path: '/v1/runs/run-1:cancel',
  body_digest: `sha256:${'b'.repeat(64)}`
});
