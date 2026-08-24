import { computeLocalQARuntimeEventDigest } from '@talos/testing-protocol';
import { describe, expect, it, vi } from 'vitest';
import { HttpLocalQARuntimeAdapter } from './runtime-adapter.js';

describe('HttpLocalQARuntimeAdapter', () => {
  it('only accepts loopback Runtime endpoints and sends the local credential out of band', async () => {
    expect(() => new HttpLocalQARuntimeAdapter({
      baseUrl: 'https://runtime.example',
      credential: 'runtime-credential-1234'
    })).toThrow('Local QA Runtime URL must use HTTP loopback');

    const capabilities = {
      schema_version: 'local-qa-runtime-capabilities/v1',
      adapter_contracts: ['talos.local-qa-runtime-adapter/v1'],
      runtime_capabilities: ['local-qa-mvp/v1'],
      execution_profiles: ['local_qa_agent_mvp'],
      runner_packages: [],
      max_concurrency: 1,
      limits: { max_events_per_page: 100, max_snapshot_bytes: 2048, max_event_page_bytes: 2048 }
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(capabilities), { status: 200 })
    );
    const adapter = new HttpLocalQARuntimeAdapter({
      baseUrl: 'http://127.0.0.1:4317',
      credential: 'runtime-credential-1234'
    });
    expect(await adapter.getCapabilities()).toMatchObject({ max_concurrency: 1 });
    expect(fetchMock.mock.calls[0]?.[0].toString()).toBe('http://127.0.0.1:4317/v1/capabilities');
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('x-local-qa-credential')).toBe('runtime-credential-1234');
    fetchMock.mockRestore();
  });

  it('rejects Runtime responses before parsing when they exceed the fixed bound', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-length': '70000' }
    }));
    const adapter = new HttpLocalQARuntimeAdapter({
      baseUrl: 'http://localhost:4317',
      credential: 'runtime-credential-1234'
    });
    await expect(adapter.getCapabilities()).rejects.toMatchObject({ code: 'runtime_response_too_large' });
    fetchMock.mockRestore();
  });

  it('stops reading an oversized streamed response without relying on Content-Length', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('x'.repeat(70_000), { status: 200 })
    );
    const adapter = new HttpLocalQARuntimeAdapter({
      baseUrl: 'http://[::1]:4317',
      credential: 'runtime-credential-1234'
    });
    await expect(adapter.getCapabilities()).rejects.toMatchObject({ code: 'runtime_response_too_large' });
    fetchMock.mockRestore();
  });

  it('does not expose Runtime-provided error messages', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'runtime_denied', message: 'echo runtime-credential-1234' }
    }), { status: 403 }));
    const adapter = new HttpLocalQARuntimeAdapter({
      baseUrl: 'http://localhost:4317',
      credential: 'runtime-credential-1234'
    });
    await expect(adapter.getCapabilities()).rejects.toMatchObject({
      code: 'runtime_denied',
      message: 'Local QA Runtime request failed (403)',
      status: 403
    });
    fetchMock.mockRestore();
  });

  it('rejects event pages that exceed the negotiated request limit', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const capabilities = {
      schema_version: 'local-qa-runtime-capabilities/v1',
      adapter_contracts: ['talos.local-qa-runtime-adapter/v1'],
      runtime_capabilities: ['local-qa-mvp/v1'],
      execution_profiles: ['local_qa_agent_mvp'],
      runner_packages: [],
      max_concurrency: 1,
      limits: { max_events_per_page: 3, max_snapshot_bytes: 2048, max_event_page_bytes: 65536 }
    };
    const events = Array.from({ length: 4 }, (_value, index) => {
      const core = {
        schema_version: 'local-qa-runtime-event/v1' as const,
        event_ref: `local-qa://runtime/events/${index + 1}`,
        run_id: 'run-1',
        sequence: index + 1,
        type: 'run.progress',
        snapshot_digest: digest,
        reference_projections: [],
        created_at: '2026-08-24T00:00:00.000Z'
      };
      return { ...core, event_digest: computeLocalQARuntimeEventDigest(core) };
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(capabilities), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schema_version: 'local-qa-runtime-event-page/v1',
        run_id: 'run-1',
        after_sequence: 0,
        events,
        through_sequence: 4,
        has_more: true,
        snapshot_digest: digest
      }), { status: 200 }));
    const adapter = new HttpLocalQARuntimeAdapter({
      baseUrl: 'http://localhost:4317',
      credential: 'runtime-credential-1234'
    });
    await adapter.getCapabilities();
    await expect(adapter.listEvents('run-1', 0, 3)).rejects.toMatchObject({
      code: 'runtime_event_page_limit_exceeded'
    });
    await expect(adapter.listEvents('run-1', 0, 4)).rejects.toMatchObject({
      code: 'invalid_event_query'
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });
});
