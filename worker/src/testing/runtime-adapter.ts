import {
  localQACancelAckSchema,
  localQAReconcileResultSchema,
  localQARunAdmissionSchema,
  localQARunRequestSchema,
  localQARuntimeCapabilitiesSchema,
  localQARuntimeEventPageSchema,
  localQARuntimeSnapshotSchema,
  localQAControlRequestSchema,
  type LocalQACancelAck,
  type LocalQAControlRequest,
  type LocalQAReconcileResult,
  type LocalQARunAdmission,
  type LocalQARunRequest,
  type LocalQARuntimeCapabilities,
  type LocalQARuntimeEventPage,
  type LocalQARuntimeSnapshot
} from '@talos/testing-protocol';
import { z } from 'zod';
import { BoundedHttpResponseError, readBoundedResponseText } from './bounded-http-response.js';

function isLoopbackUrl(value: string): boolean {
  const url = new URL(value);
  return url.protocol === 'http:' && url.username === '' && url.password === '' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

const adapterConfigSchema = z.object({
  baseUrl: z.string().url().refine(isLoopbackUrl, 'Local QA Runtime URL must use HTTP loopback'),
  credential: z.string().min(16).max(4096),
  requestTimeoutMs: z.number().int().positive().max(120_000).default(30_000)
}).strict();

export interface LocalQARuntimeAdapter {
  getCapabilities(signal?: AbortSignal): Promise<LocalQARuntimeCapabilities>;
  submitRun(request: LocalQARunRequest, signal?: AbortSignal): Promise<LocalQARunAdmission>;
  getSnapshot(runId: string, signal?: AbortSignal): Promise<LocalQARuntimeSnapshot>;
  listEvents(runId: string, afterSequence: number, limit: number, signal?: AbortSignal): Promise<LocalQARuntimeEventPage>;
  cancelRun(request: LocalQAControlRequest, signal?: AbortSignal): Promise<LocalQACancelAck>;
  reconcileTerminal(request: LocalQAControlRequest, signal?: AbortSignal): Promise<LocalQAReconcileResult>;
}

export class LocalQARuntimeAdapterError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'LocalQARuntimeAdapterError';
  }
}

export class HttpLocalQARuntimeAdapter implements LocalQARuntimeAdapter {
  private readonly config: z.infer<typeof adapterConfigSchema>;
  private snapshotLimit = 1_048_576;
  private eventPageLimit = 1_048_576;
  private maxEventsPerPage = 100;

  public constructor(config: unknown) {
    this.config = adapterConfigSchema.parse(config);
  }

  public async getCapabilities(signal?: AbortSignal): Promise<LocalQARuntimeCapabilities> {
    const capabilities = localQARuntimeCapabilitiesSchema.parse(await this.request(
      '/v1/capabilities',
      { method: 'GET', signal },
      65_536
    ));
    this.snapshotLimit = capabilities.limits.max_snapshot_bytes;
    this.eventPageLimit = capabilities.limits.max_event_page_bytes;
    this.maxEventsPerPage = capabilities.limits.max_events_per_page;
    return capabilities;
  }

  public async submitRun(request: LocalQARunRequest, signal?: AbortSignal): Promise<LocalQARunAdmission> {
    const run = localQARunRequestSchema.parse(request);
    return localQARunAdmissionSchema.parse(await this.request(
      `/v1/runs/${encodeURIComponent(run.run_id)}`,
      { method: 'PUT', body: run, signal },
      this.snapshotLimit
    ));
  }

  public async getSnapshot(runId: string, signal?: AbortSignal): Promise<LocalQARuntimeSnapshot> {
    return localQARuntimeSnapshotSchema.parse(await this.request(
      `/v1/runs/${encodeURIComponent(runId)}`,
      { method: 'GET', signal },
      this.snapshotLimit
    ));
  }

  public async listEvents(
    runId: string,
    afterSequence: number,
    limit: number,
    signal?: AbortSignal
  ): Promise<LocalQARuntimeEventPage> {
    if (
      !Number.isInteger(afterSequence) || afterSequence < 0 ||
      !Number.isInteger(limit) || limit < 1 || limit > this.maxEventsPerPage
    ) {
      throw new LocalQARuntimeAdapterError('invalid_event_query', 'Runtime event query is outside bounded limits');
    }
    const page = localQARuntimeEventPageSchema.parse(await this.request(
      `/v1/runs/${encodeURIComponent(runId)}/events?after_sequence=${afterSequence}&limit=${limit}`,
      { method: 'GET', signal },
      this.eventPageLimit
    ));
    if (page.events.length > limit) {
      throw new LocalQARuntimeAdapterError(
        'runtime_event_page_limit_exceeded',
        'Local QA Runtime returned more events than requested'
      );
    }
    return page;
  }

  public async cancelRun(request: LocalQAControlRequest, signal?: AbortSignal): Promise<LocalQACancelAck> {
    const input = localQAControlRequestSchema.parse(request);
    if (input.operation !== 'cancel') {
      throw new LocalQARuntimeAdapterError('invalid_runtime_operation', 'cancelRun requires a cancel authorization');
    }
    return localQACancelAckSchema.parse(await this.request(
      `/v1/runs/${encodeURIComponent(input.attempt.run_id)}:cancel`,
      { method: 'POST', body: input, signal },
      this.snapshotLimit
    ));
  }

  public async reconcileTerminal(
    request: LocalQAControlRequest,
    signal?: AbortSignal
  ): Promise<LocalQAReconcileResult> {
    const input = localQAControlRequestSchema.parse(request);
    if (input.operation !== 'reconcile') {
      throw new LocalQARuntimeAdapterError('invalid_runtime_operation', 'reconcileTerminal requires a reconcile authorization');
    }
    return localQAReconcileResultSchema.parse(await this.request(
      `/v1/runs/${encodeURIComponent(input.attempt.run_id)}:reconcile-terminal`,
      { method: 'POST', body: input, signal },
      this.snapshotLimit
    ));
  }

  private async request(
    path: string,
    options: { method: 'GET' | 'PUT' | 'POST'; body?: unknown; signal?: AbortSignal },
    maxResponseBytes: number
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    const signal = options.signal === undefined
      ? timeout
      : AbortSignal.any([options.signal, timeout]);
    let response: Response;
    try {
      response = await fetch(new URL(path, withTrailingSlash(this.config.baseUrl)), {
        method: options.method,
        headers: {
          authorization: `Bearer ${this.config.credential}`,
          'x-local-qa-credential': this.config.credential,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal
      });
    } catch {
      throw new LocalQARuntimeAdapterError(
        'runtime_unavailable',
        'Local QA Runtime is unavailable'
      );
    }
    let text: string;
    try {
      text = await readBoundedResponseText(response, maxResponseBytes);
    } catch (error) {
      if (error instanceof BoundedHttpResponseError) {
        throw new LocalQARuntimeAdapterError(
          'runtime_response_too_large',
          'Local QA Runtime response exceeds the bounded limit',
          response.status
        );
      }
      throw new LocalQARuntimeAdapterError('invalid_runtime_response', 'Local QA Runtime response could not be read', response.status);
    }
    let json: unknown;
    try {
      json = text.length === 0 ? {} : JSON.parse(text) as unknown;
    } catch {
      throw new LocalQARuntimeAdapterError('invalid_runtime_response', 'Local QA Runtime returned invalid JSON', response.status);
    }
    if (!response.ok) {
      const parsed = z.object({
        error: z.object({
          code: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
        }).passthrough()
      }).safeParse(json);
      throw new LocalQARuntimeAdapterError(
        parsed.success ? parsed.data.error.code : 'runtime_http_error',
        `Local QA Runtime request failed (${response.status})`,
        response.status
      );
    }
    return json;
  }
}

const withTrailingSlash = (value: string): string => value.endsWith('/') ? value : `${value}/`;
