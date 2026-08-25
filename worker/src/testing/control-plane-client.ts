import {
  computeTestingWorkerMutationDigest,
  testingClaimResponseSchema,
  testingCurrentClaimEnvelopeSchema,
  testingNoLocalAcceptanceFactSchema,
  testingReconcileClaimResponseSchema,
  testingWorkerHeartbeatResponseSchema,
  testingWorkerMutationAckSchema,
  type TestingClaimResponse,
  type TestingCurrentClaimEnvelope,
  type TestingNoLocalAcceptanceFact,
  type TestingReconcileClaimResponse,
  type TestingRunProgress,
  type TestingSafeError,
  type TestingTerminalRefs,
  type TestingWorkerMutationOperation
} from '@talos/testing-protocol';
import { z } from 'zod';
import { workerConfigSchema } from '../runtime/client.js';
import { WorkerClientError } from '../runtime/errors.js';
import { resolveControlPlaneUrl } from '../runtime/url.js';
import { BoundedHttpResponseError, readBoundedResponseText } from './bounded-http-response.js';

const errorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  }).passthrough()
});

export interface TestingAttemptCredentials {
  readonly runId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly fenceToken: string;
  readonly leaseToken: string;
}

export interface TestingHeartbeatProgress extends Omit<TestingRunProgress, 'last_event_sequence'> {
  readonly runtime_event_sequence: number;
}

export interface TestingTerminalProjection {
  readonly controlStatus: 'completed' | 'failed' | 'cancelled';
  readonly executionOutcome: 'not_started' | 'executing' | 'passed' | 'failed' | 'blocked' | 'error' | 'cancelled' | 'lost_or_inconclusive' | 'unobserved';
  readonly evidenceOutcome: 'not_required' | 'staging' | 'complete' | 'partial' | 'unavailable' | 'policy_blocked';
  readonly uploadOutcome: 'not_required' | 'pending' | 'uploaded' | 'upload_expired';
  readonly cleanupOutcome: 'not_required' | 'pending' | 'complete' | 'residual_retryable' | 'residual_blocking' | 'unobserved';
  readonly summary?: { total: number; passed: number; failed: number; blocked: number; error: number };
  readonly results?: TestingTerminalRefs;
  readonly safeError?: TestingSafeError;
}

export interface TestingWorkerControlPlane {
  claim(signal?: AbortSignal): Promise<TestingClaimResponse | undefined>;
  claimReconcile(signal?: AbortSignal): Promise<TestingReconcileClaimResponse | undefined>;
  heartbeat(credentials: TestingAttemptCredentials, progress?: TestingHeartbeatProgress, signal?: AbortSignal): Promise<ReturnType<typeof testingWorkerHeartbeatResponseSchema.parse>>;
  acceptLocal(credentials: TestingAttemptCredentials, signal?: AbortSignal): Promise<TestingCurrentClaimEnvelope>;
  markRunning(credentials: TestingAttemptCredentials, signal?: AbortSignal): Promise<TestingCurrentClaimEnvelope>;
  commitTerminal(credentials: TestingAttemptCredentials, projection: TestingTerminalProjection, signal?: AbortSignal): Promise<void>;
  commitReconcileTerminal(credentials: TestingAttemptCredentials, projection: TestingTerminalProjection, signal?: AbortSignal): Promise<void>;
  confirmNotAccepted(credentials: TestingAttemptCredentials, fact: TestingNoLocalAcceptanceFact, signal?: AbortSignal): Promise<void>;
  resolveRuntimeCurrentClaim(runId: string, claimId: string, requestNonce: string, signal?: AbortSignal): Promise<TestingCurrentClaimEnvelope>;
}

export class HttpTestingWorkerClient implements TestingWorkerControlPlane {
  private readonly config: ReturnType<typeof workerConfigSchema.parse>;

  public constructor(config: unknown) {
    this.config = workerConfigSchema.parse(config);
  }

  public async claim(signal?: AbortSignal): Promise<TestingClaimResponse | undefined> {
    const response = await this.workerRequest('/v1/worker/testing/claim', {}, true, signal);
    return response === undefined ? undefined : testingClaimResponseSchema.parse(response);
  }

  public async claimReconcile(signal?: AbortSignal): Promise<TestingReconcileClaimResponse | undefined> {
    const response = await this.workerRequest('/v1/worker/testing/reconcile-claim', {}, true, signal);
    return response === undefined ? undefined : testingReconcileClaimResponseSchema.parse(response);
  }

  public async heartbeat(
    credentials: TestingAttemptCredentials,
    progress?: TestingHeartbeatProgress,
    signal?: AbortSignal
  ): Promise<ReturnType<typeof testingWorkerHeartbeatResponseSchema.parse>> {
    return testingWorkerHeartbeatResponseSchema.parse(await this.requireWorkerRequest(
      `/v1/worker/testing/runs/${encodeURIComponent(credentials.runId)}/heartbeat`,
      { ...bindingBody(credentials), extend_seconds: 60, ...(progress === undefined ? {} : { progress }) },
      signal
    ));
  }

  public async acceptLocal(credentials: TestingAttemptCredentials, signal?: AbortSignal): Promise<TestingCurrentClaimEnvelope> {
    const acknowledgement = requireMutationAcknowledgement(
      await this.requireWorkerRequest(
      `/v1/worker/testing/runs/${encodeURIComponent(credentials.runId)}/local-accept`,
      bindingBody(credentials),
      signal
      ),
      'local_accept',
      credentials,
      {},
      'local_accepted'
    );
    if (acknowledgement.current_claim === undefined) throw acknowledgementMismatch();
    assertCurrentClaimAcknowledgement(acknowledgement.current_claim, credentials);
    return acknowledgement.current_claim;
  }

  public async markRunning(credentials: TestingAttemptCredentials, signal?: AbortSignal): Promise<TestingCurrentClaimEnvelope> {
    const acknowledgement = requireMutationAcknowledgement(
      await this.requireWorkerRequest(
      `/v1/worker/testing/runs/${encodeURIComponent(credentials.runId)}/running`,
      bindingBody(credentials),
      signal
      ),
      'running',
      credentials,
      {},
      'running'
    );
    if (acknowledgement.current_claim === undefined) throw acknowledgementMismatch();
    assertCurrentClaimAcknowledgement(acknowledgement.current_claim, credentials);
    return acknowledgement.current_claim;
  }

  public async commitTerminal(
    credentials: TestingAttemptCredentials,
    projection: TestingTerminalProjection,
    signal?: AbortSignal
  ): Promise<void> {
    const payload = terminalMutationPayload(projection);
    requireMutationAcknowledgement(await this.requireWorkerRequest(
      `/v1/worker/testing/runs/${encodeURIComponent(credentials.runId)}/result`,
      terminalBody(credentials, projection),
      signal
    ), 'terminal', credentials, payload, terminalAcknowledgementStatuses(projection.controlStatus));
  }

  public async commitReconcileTerminal(
    credentials: TestingAttemptCredentials,
    projection: TestingTerminalProjection,
    signal?: AbortSignal
  ): Promise<void> {
    const payload = terminalMutationPayload(projection);
    requireMutationAcknowledgement(await this.requireWorkerRequest(
      `/v1/worker/testing/runs/${encodeURIComponent(credentials.runId)}/reconcile`,
      terminalBody(credentials, projection),
      signal
    ), 'reconcile_terminal', credentials, payload, terminalAcknowledgementStatuses(projection.controlStatus));
  }

  public async confirmNotAccepted(
    credentials: TestingAttemptCredentials,
    fact: TestingNoLocalAcceptanceFact,
    signal?: AbortSignal
  ): Promise<void> {
    const parsedFact = testingNoLocalAcceptanceFactSchema.parse(fact);
    requireMutationAcknowledgement(await this.requireWorkerRequest(
      `/v1/worker/testing/runs/${encodeURIComponent(credentials.runId)}/not-accepted`,
      { ...bindingBody(credentials), fact: parsedFact },
      signal
    ), 'not_accepted', credentials, { fact: parsedFact });
  }

  public async resolveRuntimeCurrentClaim(
    runId: string,
    claimId: string,
    requestNonce: string,
    signal?: AbortSignal
  ): Promise<TestingCurrentClaimEnvelope> {
    const response = await this.request(
      `/v1/testing/claims/${encodeURIComponent(runId)}/${encodeURIComponent(claimId)}/resolve`,
      {
        schema_version: 'talos.testing-current-claim-resolve-request/v1',
        audience: 'local-qa-runtime',
        request_nonce: requestNonce
      },
      false,
      false,
      signal
    );
    return testingCurrentClaimEnvelopeSchema.parse(response);
  }

  private async requireWorkerRequest(
    path: string,
    payload: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const response = await this.workerRequest(path, payload, false, signal);
    if (response === undefined) throw new WorkerClientError('not_found', 'testing worker resource not found', 404);
    return response;
  }

  private async workerRequest(
    path: string,
    payload: Readonly<Record<string, unknown>>,
    notFoundIsEmpty = true,
    signal?: AbortSignal
  ): Promise<unknown | undefined> {
    return this.request(path, payload, true, notFoundIsEmpty, signal);
  }

  private async request(
    path: string,
    payload: Readonly<Record<string, unknown>>,
    authenticated: boolean,
    notFoundIsEmpty: boolean,
    externalSignal?: AbortSignal
  ): Promise<unknown | undefined> {
    const body = authenticated
      ? {
          ...payload,
          worker_token: this.config.workerToken,
          worker_id: this.config.workerId,
          machine_id: this.config.machineId
        }
      : payload;
    const timeout = AbortSignal.timeout(30_000);
    const signal = externalSignal === undefined ? timeout : AbortSignal.any([externalSignal, timeout]);
    const response = await fetch(resolveControlPlaneUrl(this.config.controlPlaneUrl, path), {
      method: 'POST',
      headers: {
        ...(authenticated
          ? {
              authorization: `Bearer ${this.config.workerToken}`,
              'x-talos-worker-token': this.config.workerToken,
              'x-talos-worker-id': this.config.workerId,
              'x-talos-machine-id': this.config.machineId
            }
          : {}),
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal
    });
    let text: string;
    try {
      text = await readBoundedResponseText(response, 1_048_576);
    } catch (error) {
      if (error instanceof BoundedHttpResponseError) {
        throw new WorkerClientError(
          'testing_control_plane_response_too_large',
          'testing control plane response exceeds the bounded limit',
          response.status
        );
      }
      throw new WorkerClientError(
        'invalid_testing_control_plane_response',
        'testing control plane response could not be read',
        response.status
      );
    }
    let json: unknown = {};
    try { json = text.length === 0 ? {} : JSON.parse(text) as unknown; } catch { json = {}; }
    if (response.status === 404 && notFoundIsEmpty) return undefined;
    if (!response.ok) {
      const error = errorResponseSchema.safeParse(json);
      if (error.success) {
        throw new WorkerClientError(
          error.data.error.code,
          `testing control plane request failed (${response.status})`,
          response.status
        );
      }
      throw new WorkerClientError('http_error', `control plane request failed (${response.status})`, response.status);
    }
    return json;
  }
}

const bindingBody = (credentials: TestingAttemptCredentials): Readonly<Record<string, unknown>> => ({
  attempt_id: credentials.attemptId,
  generation: credentials.generation,
  fence_token: credentials.fenceToken,
  lease_token: credentials.leaseToken
});

const terminalBody = (
  credentials: TestingAttemptCredentials,
  projection: TestingTerminalProjection
): Readonly<Record<string, unknown>> => ({
  ...bindingBody(credentials),
  ...terminalMutationPayload(projection)
});

const terminalMutationPayload = (
  projection: TestingTerminalProjection
): Readonly<Record<string, unknown>> => ({
  control_status: projection.controlStatus,
  execution_outcome: projection.executionOutcome,
  evidence_outcome: projection.evidenceOutcome,
  upload_outcome: projection.uploadOutcome,
  cleanup_outcome: projection.cleanupOutcome,
  ...(projection.summary === undefined ? {} : { summary: projection.summary }),
  ...(projection.results === undefined ? {} : { results: projection.results }),
  ...(projection.safeError === undefined ? {} : { safe_error: projection.safeError })
});

const assertCurrentClaimAcknowledgement = (
  claim: TestingCurrentClaimEnvelope,
  credentials: TestingAttemptCredentials
): void => {
  const identity = claim.claim;
  if (
    !claim.is_current || claim.audience !== 'talos-worker' ||
    identity.run_id !== credentials.runId || identity.attempt_id !== credentials.attemptId ||
    identity.generation !== credentials.generation || identity.fence_token !== credentials.fenceToken
  ) throw acknowledgementMismatch();
};

const requireMutationAcknowledgement = (
  input: unknown,
  operation: TestingWorkerMutationOperation,
  credentials: TestingAttemptCredentials,
  payload: Readonly<Record<string, unknown>>,
  expectedStatus?: string | readonly string[]
): ReturnType<typeof testingWorkerMutationAckSchema.parse> => {
  const acknowledgement = testingWorkerMutationAckSchema.parse(input);
  const mutationDigest = computeTestingWorkerMutationDigest({
    schema_version: 'talos.testing-worker-mutation/v1',
    operation,
    run_id: credentials.runId,
    attempt_id: credentials.attemptId,
    generation: credentials.generation,
    fence_token: credentials.fenceToken,
    lease_token: credentials.leaseToken,
    payload
  });
  if (
    acknowledgement.operation !== operation || acknowledgement.run_id !== credentials.runId ||
    acknowledgement.attempt_id !== credentials.attemptId ||
    acknowledgement.generation !== credentials.generation ||
    acknowledgement.fence_token !== credentials.fenceToken ||
    acknowledgement.mutation_digest !== mutationDigest ||
    (expectedStatus !== undefined && !(Array.isArray(expectedStatus)
      ? expectedStatus.includes(acknowledgement.control_status)
      : acknowledgement.control_status === expectedStatus))
  ) throw acknowledgementMismatch();
  return acknowledgement;
};

const terminalAcknowledgementStatuses = (requested: TestingTerminalProjection['controlStatus']): readonly string[] =>
  requested === 'cancelled' ? ['cancelled'] : [requested, 'cancelled'];

const acknowledgementMismatch = (): WorkerClientError => new WorkerClientError(
  'testing_control_plane_ack_mismatch',
  'testing control plane acknowledgement is bound to another mutation',
  502
);
