import {
  testingAuthorizationResolutionRequestSchema,
  testingAuthorizationResolutionSchema,
  type TestingAuthorizationResolution,
  type TestingAuthorizationResolutionRequest
} from '@talos/testing-protocol';
import { z } from 'zod';
import { BoundedHttpResponseError, readBoundedResponseText } from './bounded-http-response.js';
import type { TestingAuthorizationResolver } from './testing-executor.js';

const isSecureResolverUrl = (value: string): boolean => {
  const url = new URL(value);
  if (url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
};

const resolverConfigSchema = z.object({
  url: z.string().url().refine(
    isSecureResolverUrl,
    'authorization resolver must use HTTPS, or HTTP on loopback'
  ),
  token: z.string().min(16).max(4096),
  requestTimeoutMs: z.number().int().positive().max(120_000).default(30_000)
}).strict();

export class HttpTestingAuthorizationResolver implements TestingAuthorizationResolver {
  private readonly config: z.infer<typeof resolverConfigSchema>;

  public constructor(config: unknown) {
    this.config = resolverConfigSchema.parse(config);
  }

  public async resolve(
    input: TestingAuthorizationResolutionRequest,
    externalSignal?: AbortSignal
  ): Promise<TestingAuthorizationResolution> {
    const request = testingAuthorizationResolutionRequestSchema.parse(input);
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    const signal = externalSignal === undefined ? timeout : AbortSignal.any([externalSignal, timeout]);
    let response: Response;
    try {
      response = await fetch(this.config.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(request),
        signal
      });
    } catch {
      throw new TestingAuthorizationResolverError(
        'authorization_resolver_unavailable',
        'testing authorization resolver is unavailable'
      );
    }
    let text: string;
    try {
      text = await readBoundedResponseText(response, 1_048_576);
    } catch (error) {
      if (error instanceof BoundedHttpResponseError) {
        throw new TestingAuthorizationResolverError(
          'authorization_response_too_large',
          'testing authorization response exceeds the bounded limit',
          response.status
        );
      }
      throw new TestingAuthorizationResolverError(
        'invalid_authorization_response',
        'testing authorization response could not be read',
        response.status
      );
    }
    let json: unknown;
    try {
      json = text.length === 0 ? {} : JSON.parse(text) as unknown;
    } catch {
      throw new TestingAuthorizationResolverError(
        'invalid_authorization_response',
        'testing authorization resolver returned invalid JSON',
        response.status
      );
    }
    if (!response.ok) {
      const error = z.object({
        error: z.object({
          code: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
        }).passthrough()
      }).safeParse(json);
      throw new TestingAuthorizationResolverError(
        error.success ? error.data.error.code : 'authorization_resolver_http_error',
        `testing authorization resolver failed (${response.status})`,
        response.status
      );
    }
    return testingAuthorizationResolutionSchema.parse(json);
  }
}

export class TestingAuthorizationResolverError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'TestingAuthorizationResolverError';
  }
}
