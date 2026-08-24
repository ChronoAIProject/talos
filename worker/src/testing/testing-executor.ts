import { createHash, randomBytes } from 'node:crypto';
import {
  computeLocalQAControlRequestDigest,
  computeLocalQAControlEffectId,
  computeLocalQARunRequestDigest,
  localQAControlRequestSchema,
  localQARunRequestSchema,
  testingAuthorizationResolutionRequestSchema,
  testingAuthorizationResolutionSchema,
  testingClaimResponseSchema,
  testingReconcileClaimResponseSchema,
  testingRuntimeAttemptSchema,
  type LocalQAControlRequest,
  type LocalQARuntimeSnapshot,
  type TestingAuthorizationResolution,
  type TestingAuthorizationResolutionRequest,
  type TestingClaimResponse,
  type TestingCurrentClaimEnvelope,
  type TestingReconcileClaimResponse,
  type TestingRuntimeAttempt
} from '@talos/testing-protocol';
import type { RuntimeLogger } from '../runtime/client.js';
import { WorkerClientError } from '../runtime/errors.js';
import type {
  TestingAttemptCredentials,
  TestingHeartbeatProgress,
  TestingTerminalProjection,
  TestingWorkerControlPlane
} from './control-plane-client.js';
import type { LocalQARuntimeAdapter } from './runtime-adapter.js';

export interface TestingAuthorizationResolver {
  resolve(
    request: TestingAuthorizationResolutionRequest,
    signal?: AbortSignal
  ): Promise<TestingAuthorizationResolution>;
}

export interface TestingExecutorOptions {
  readonly controlPlane: TestingWorkerControlPlane;
  readonly runtime: LocalQARuntimeAdapter;
  readonly authorizations: TestingAuthorizationResolver;
  readonly heartbeatMs?: number;
  readonly pollMs?: number;
  readonly clock?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly nonce?: () => string;
  readonly logger?: RuntimeLogger;
  readonly shutdownSignal?: AbortSignal;
}

export class TestingExecutor {
  private readonly heartbeatMs: number;
  private readonly pollMs: number;
  private readonly clock: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly nonce: () => string;

  public constructor(private readonly options: TestingExecutorOptions) {
    this.heartbeatMs = options.heartbeatMs ?? 20_000;
    this.pollMs = options.pollMs ?? 2_000;
    this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.nonce = options.nonce ?? (() => `runtime-${randomBytes(18).toString('base64url')}`);
  }

  public async runStart(input: TestingClaimResponse): Promise<void> {
    throwIfAborted(this.options.shutdownSignal);
    const claim = testingClaimResponseSchema.parse(input);
    assertStartClaim(claim, this.clock());
    const attempt = startAttempt(claim);
    const credentials = startCredentials(claim);
    const heartbeat = new TestingHeartbeatMonitor(
      this.options.controlPlane,
      credentials,
      attempt,
      claim.lease.lease_expires_at,
      this.heartbeatMs,
      this.clock,
      this.options.logger,
      this.options.shutdownSignal
    );
    heartbeat.start();
    const signal = combineSignals(heartbeat.signal, this.options.shutdownSignal);
    let locallyAccepted = false;
    try {
      await heartbeat.tick();
      heartbeat.assertDispatchAllowed(this.clock(), attempt.deadline);
      throwIfAborted(signal);
      const capabilities = await this.options.runtime.getCapabilities(signal);
      if (
        !capabilities.runtime_capabilities.includes(claim.task.expected_runtime_capability) ||
        !capabilities.execution_profiles.includes('local_qa_agent_mvp') ||
        !capabilities.runner_packages.some((runner) =>
          runner.package_id === claim.task.runner.package_id &&
          runner.version === claim.task.runner.version &&
          runner.digest === claim.task.runner.digest)
      ) {
        throw new TestingExecutorError('testing_capability_mismatch', 'Local QA Runtime cannot execute the frozen testing package');
      }

      const currentClaim = await this.resolveCurrentClaim(attempt, signal);
      const issuedAt = new Date(this.clock()).toISOString();
      const operationId = runtimeOperationId('start', attempt, currentClaim.claim.claim_id);
      const projection = {
        schema_version: 'talos.local-qa-run-request/v1' as const,
        request_id: `start-${operationId}`,
        idempotency_key: `start:${operationId}`,
        run_id: attempt.run_id,
        task: claim.task,
        attempt,
        current_claim: currentClaim,
        issued_at: issuedAt,
        deadline: attempt.deadline
      };
      const requestDigest = computeLocalQARunRequestDigest(projection);
      const authorization = await this.resolveAuthorization({
        schema_version: 'talos.testing-authorization-resolution-request/v1',
        operation: 'start',
        authorization_reference: claim.task.local_request_authorization,
        attempt,
        current_claim_digest: currentClaim.claim_digest,
        http_method: 'PUT',
        canonical_path: `/v1/runs/${attempt.run_id}`,
        body_digest: requestDigest
      }, signal);
      heartbeat.assertDispatchAllowed(this.clock(), attempt.deadline);
      throwIfAborted(signal);
      assertRuntimeClaimFresh(currentClaim, this.clock());
      const request = localQARunRequestSchema.parse({
        ...projection,
        request_digest: requestDigest,
        authorization_resolution: authorization,
        authorization: authorization.authorization
      });
      const admission = await this.options.runtime.submitRun(request, signal);
      assertAdmission(admission, attempt, requestDigest);
      await this.options.controlPlane.acceptLocal(credentials, signal);
      locallyAccepted = true;
      let snapshot = admission.snapshot;
      heartbeat.setProgress(runtimeProgress(snapshot));
      await this.observeRun(
        attempt,
        credentials,
        heartbeat,
        snapshot,
        capabilities.limits.max_events_per_page,
        signal
      );
    } catch (error) {
      if (!locallyAccepted) {
        this.options.logger?.warn('testing dispatch stopped before confirmed local acceptance', {
          runId: attempt.run_id,
          attemptId: attempt.attempt_id,
          error: safeMessage(error)
        });
      } else {
        this.options.logger?.warn('testing attempt requires same-machine reconciliation', {
          runId: attempt.run_id,
          attemptId: attempt.attempt_id,
          error: safeMessage(error)
        });
      }
    } finally {
      await heartbeat.stop();
    }
  }

  public async runReconcile(input: TestingReconcileClaimResponse): Promise<void> {
    throwIfAborted(this.options.shutdownSignal);
    const claim = testingReconcileClaimResponseSchema.parse(input);
    assertReconcileClaim(claim, this.clock());
    const attempt = reconcileAttempt(claim);
    const credentials = reconcileCredentials(claim);
    const heartbeat = new TestingHeartbeatMonitor(
      this.options.controlPlane,
      credentials,
      attempt,
      claim.current_claim.lease_expires_at,
      this.heartbeatMs,
      this.clock,
      this.options.logger,
      this.options.shutdownSignal
    );
    heartbeat.start();
    const signal = combineSignals(heartbeat.signal, this.options.shutdownSignal);
    try {
      await heartbeat.tick();
      heartbeat.assertReconcileAllowed(this.clock(), attempt.deadline);
      throwIfAborted(signal);
      const capabilities = await this.options.runtime.getCapabilities(signal);
      const currentClaim = await this.resolveCurrentClaim(attempt, signal);
      const request = await this.controlRequest(
        attempt,
        currentClaim,
        'reconcile',
        'daemon_restart',
        claim.task.local_request_authorization,
        signal
      );
      const result = await this.options.runtime.reconcileTerminal(request, signal);
      if (result.disposition === 'never_accepted') {
        await this.options.controlPlane.confirmNotAccepted(credentials, result.fact, signal);
        return;
      }
      assertSnapshotAttempt(result.snapshot, attempt);
      heartbeat.setProgress(runtimeProgress(result.snapshot));
      if (result.disposition === 'terminal') {
        await this.options.controlPlane.commitReconcileTerminal(
          credentials,
          terminalProjection(result.snapshot),
          signal
        );
        return;
      }
      await this.observeReconcile(
        attempt,
        credentials,
        heartbeat,
        result.snapshot,
        capabilities.limits.max_events_per_page,
        signal
      );
    } catch (error) {
      this.options.logger?.warn('testing reconciliation did not converge', {
        runId: attempt.run_id,
        attemptId: attempt.attempt_id,
        error: safeMessage(error)
      });
    } finally {
      await heartbeat.stop();
    }
  }

  private async observeRun(
    attempt: TestingRuntimeAttempt,
    credentials: TestingAttemptCredentials,
    heartbeat: TestingHeartbeatMonitor,
    initialSnapshot: LocalQARuntimeSnapshot,
    eventPageLimit: number,
    signal: AbortSignal
  ): Promise<void> {
    let snapshot = initialSnapshot;
    let eventSequence = 0;
    let runningReported = false;
    let cancelSent = false;
    while (true) {
      heartbeat.assertAuthorityCurrent(this.clock());
      if (snapshot.state === 'terminal') {
        await this.options.controlPlane.commitTerminal(credentials, terminalProjection(snapshot), signal);
        return;
      }
      if (!runningReported && ['executing', 'staging_evidence', 'cleaning_up_execution', 'uploading', 'finalizing_local'].includes(snapshot.state)) {
        await this.options.controlPlane.markRunning(credentials, signal);
        runningReported = true;
      }
      const deadlineAt = Date.parse(attempt.deadline);
      const timedOut = this.clock() >= deadlineAt;
      const deadlineCancelDue = this.clock() + Math.max(this.pollMs, 1_000) >= deadlineAt;
      if ((heartbeat.cancelRequested || deadlineCancelDue) && !cancelSent) {
        const currentClaim = await this.resolveCurrentClaim(attempt, signal);
        const request = await this.controlRequest(
          attempt,
          currentClaim,
          'cancel',
          heartbeat.cancelRequested ? 'user_cancelled' : 'timed_out',
          undefined,
          signal
        );
        const acknowledgement = await this.options.runtime.cancelRun(request, signal);
        assertCancelAcknowledgement(acknowledgement, attempt, request.request_digest);
        snapshot = acknowledgement.snapshot;
        heartbeat.setProgress(runtimeProgress(snapshot));
        cancelSent = true;
        if (snapshot.state === 'terminal') {
          await this.options.controlPlane.commitTerminal(credentials, terminalProjection(snapshot), signal);
          return;
        }
      }
      if (timedOut && !cancelSent) {
        throw new TestingExecutorError('testing_deadline_exceeded', 'testing deadline passed without cancel authority');
      }
      const eventPage = await this.options.runtime.listEvents(
        attempt.run_id,
        eventSequence,
        eventPageLimit,
        signal
      );
      eventSequence = eventPage.through_sequence;
      snapshot = await this.options.runtime.getSnapshot(attempt.run_id, signal);
      assertSnapshotAttempt(snapshot, attempt);
      assertRuntimeJournalConsistent(eventPage, snapshot);
      heartbeat.setProgress(runtimeProgress(snapshot));
      if (snapshot.state === 'terminal') {
        await this.options.controlPlane.commitTerminal(credentials, terminalProjection(snapshot), signal);
        return;
      }
      await sleepWithSignal(this.sleep, this.pollMs, signal);
    }
  }

  private async observeReconcile(
    attempt: TestingRuntimeAttempt,
    credentials: TestingAttemptCredentials,
    heartbeat: TestingHeartbeatMonitor,
    initialSnapshot: LocalQARuntimeSnapshot,
    eventPageLimit: number,
    signal: AbortSignal
  ): Promise<void> {
    let snapshot = initialSnapshot;
    let eventSequence = snapshot.event_sequence;
    while (this.clock() < Date.parse(attempt.deadline)) {
      await heartbeat.tick();
      heartbeat.assertReconcileAllowed(this.clock(), attempt.deadline);
      const eventPage = await this.options.runtime.listEvents(
        attempt.run_id,
        eventSequence,
        eventPageLimit,
        signal
      );
      eventSequence = eventPage.through_sequence;
      snapshot = await this.options.runtime.getSnapshot(attempt.run_id, signal);
      assertSnapshotAttempt(snapshot, attempt);
      assertRuntimeJournalConsistent(eventPage, snapshot);
      heartbeat.setProgress(runtimeProgress(snapshot));
      if (snapshot.state === 'terminal') {
        await this.options.controlPlane.commitReconcileTerminal(
          credentials,
          terminalProjection(snapshot),
          signal
        );
        return;
      }
      await sleepWithSignal(this.sleep, this.pollMs, signal);
    }
    throw new TestingExecutorError(
      'testing_reconcile_deadline_exceeded',
      'Runtime reconciliation did not settle before its deadline'
    );
  }

  private async resolveCurrentClaim(
    attempt: TestingRuntimeAttempt,
    signal: AbortSignal | undefined
  ): Promise<TestingCurrentClaimEnvelope> {
    throwIfAborted(signal);
    const claimId = claimIdFromReference(attempt.lease_claim.ref, attempt.run_id);
    const requestNonce = this.nonce();
    const claim = await this.options.controlPlane.resolveRuntimeCurrentClaim(
      attempt.run_id,
      claimId,
      requestNonce,
      signal
    );
    throwIfAborted(signal);
    assertResolvedCurrentClaim(claim, attempt, claimId, requestNonce);
    return claim;
  }

  private async resolveAuthorization(
    input: TestingAuthorizationResolutionRequest,
    signal: AbortSignal | undefined
  ): Promise<TestingAuthorizationResolution> {
    const request = testingAuthorizationResolutionRequestSchema.parse(input);
    const resolution = testingAuthorizationResolutionSchema.parse(
      await this.options.authorizations.resolve(request, signal)
    );
    if (
      resolution.operation !== request.operation ||
      resolution.http_method !== request.http_method ||
      resolution.canonical_path !== request.canonical_path ||
      resolution.body_digest !== request.body_digest ||
      resolution.current_claim_digest !== request.current_claim_digest ||
      JSON.stringify(resolution.attempt) !== JSON.stringify(request.attempt) ||
      (request.authorization_reference !== undefined &&
        JSON.stringify(resolution.authorization_reference) !== JSON.stringify(request.authorization_reference)) ||
      Date.parse(resolution.authorization_reference.expires_at) <= this.clock()
    ) {
      throw new TestingExecutorError('testing_authorization_mismatch', 'resolved authorization is not bound to the requested operation');
    }
    return resolution;
  }

  private async controlRequest(
    attempt: TestingRuntimeAttempt,
    currentClaim: TestingCurrentClaimEnvelope,
    operation: 'cancel' | 'reconcile',
    reason: 'user_cancelled' | 'timed_out' | 'daemon_restart',
    authorizationReference: TestingAuthorizationResolutionRequest['authorization_reference'],
    signal: AbortSignal | undefined
  ): Promise<LocalQAControlRequest> {
    const requestedAt = new Date(this.clock()).toISOString();
    const operationId = runtimeOperationId(operation, attempt, currentClaim.claim.claim_id);
    const projection = {
      schema_version: 'talos.local-qa-control-request/v1' as const,
      request_id: `${operation}-${operationId}`,
      idempotency_key: `${operation}:${operationId}`,
      effect_id: computeLocalQAControlEffectId(operation, attempt),
      operation,
      reason,
      attempt,
      current_claim: currentClaim,
      requested_at: requestedAt,
      deadline: attempt.deadline
    };
    const requestDigest = computeLocalQAControlRequestDigest(projection);
    const authorization = await this.resolveAuthorization({
      schema_version: 'talos.testing-authorization-resolution-request/v1',
      operation,
      ...(authorizationReference === undefined ? {} : { authorization_reference: authorizationReference }),
      attempt,
      current_claim_digest: currentClaim.claim_digest,
      http_method: 'POST',
      canonical_path: `/v1/runs/${attempt.run_id}:${operation === 'cancel' ? 'cancel' : 'reconcile-terminal'}`,
      body_digest: requestDigest
    }, signal);
    assertRuntimeClaimFresh(currentClaim, this.clock());
    return localQAControlRequestSchema.parse({
      ...projection,
      request_digest: requestDigest,
      authorization_resolution: authorization,
      authorization: authorization.authorization
    });
  }
}

export class TestingWorkerRuntime {
  private readonly executor: TestingExecutor;
  private readonly controlPlane: TestingWorkerControlPlane;
  private readonly shutdownController = new AbortController();

  public constructor(options: TestingExecutorOptions) {
    this.controlPlane = options.controlPlane;
    const shutdownSignal = options.shutdownSignal === undefined
      ? this.shutdownController.signal
      : AbortSignal.any([this.shutdownController.signal, options.shutdownSignal]);
    this.executor = new TestingExecutor({ ...options, shutdownSignal });
  }

  public async runOnce(): Promise<boolean> {
    if (this.shutdownController.signal.aborted) return false;
    const reconcile = await this.controlPlane.claimReconcile(this.shutdownController.signal);
    if (reconcile !== undefined) {
      if (this.shutdownController.signal.aborted) return true;
      await this.executor.runReconcile(reconcile);
      return true;
    }
    if (this.shutdownController.signal.aborted) return false;
    const claim = await this.controlPlane.claim(this.shutdownController.signal);
    if (claim === undefined) return false;
    if (this.shutdownController.signal.aborted) return true;
    await this.executor.runStart(claim);
    return true;
  }

  public stop(): void {
    this.shutdownController.abort(
      new TestingExecutorError('testing_worker_shutdown', 'testing worker is shutting down')
    );
  }
}

export class TestingExecutorError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TestingExecutorError';
  }
}

class TestingHeartbeatMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private leaseTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private failure: unknown;
  private progress: TestingHeartbeatProgress | undefined;
  private readonly abortController = new AbortController();
  private readonly operationSignal: AbortSignal;
  private leaseExpiresAt: number;
  public cancelRequested = false;

  public constructor(
    private readonly controlPlane: TestingWorkerControlPlane,
    private readonly credentials: TestingAttemptCredentials,
    private readonly attempt: TestingRuntimeAttempt,
    initialLeaseExpiresAt: string,
    private readonly intervalMs: number,
    private readonly clock: () => number,
    private readonly logger?: RuntimeLogger,
    externalSignal?: AbortSignal
  ) {
    this.leaseExpiresAt = Date.parse(initialLeaseExpiresAt);
    this.operationSignal = combineSignals(this.abortController.signal, externalSignal);
  }

  public get signal(): AbortSignal {
    return this.operationSignal;
  }

  public start(): void {
    this.armLeaseExpiry();
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, this.intervalMs);
  }

  public setProgress(progress: TestingHeartbeatProgress): void {
    this.progress = progress;
  }

  public async tick(): Promise<void> {
    this.assertAuthorityCurrent(this.clock());
    if (this.inFlight !== undefined) return this.inFlight;
    this.inFlight = raceWithSignal(
      this.controlPlane.heartbeat(this.credentials, this.progress, this.signal),
      this.signal
    )
      .then((response) => {
        assertHeartbeatResponse(response, this.attempt, this.credentials);
        const leaseExpiresAt = Date.parse(response.lease_expires_at);
        if (leaseExpiresAt < this.leaseExpiresAt || leaseExpiresAt <= this.clock()) {
          throw new TestingExecutorError('testing_lease_expired', 'testing heartbeat did not preserve a current lease');
        }
        this.leaseExpiresAt = leaseExpiresAt;
        this.armLeaseExpiry();
        this.cancelRequested ||= response.cancel_requested;
      })
      .catch((error: unknown) => {
        if (!this.signal.aborted || this.abortController.signal.aborted) this.loseAuthority(error);
        throw error;
      })
      .finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  public assertAuthorityCurrent(now: number): void {
    if (this.failure !== undefined) throw this.failure;
    throwIfAborted(this.signal);
    if (now >= this.leaseExpiresAt) {
      const error = new TestingExecutorError('testing_lease_expired', 'testing lease authority has expired');
      this.loseAuthority(error);
      throw error;
    }
  }

  public assertDispatchAllowed(now: number, deadline: string): void {
    this.assertAuthorityCurrent(now);
    if (this.cancelRequested) throw new TestingExecutorError('cancel_requested', 'testing cancel intent prevents Runtime dispatch');
    if (now >= Date.parse(deadline)) throw new TestingExecutorError('testing_deadline_exceeded', 'testing deadline prevents Runtime dispatch');
  }

  public assertReconcileAllowed(now: number, deadline: string): void {
    this.assertAuthorityCurrent(now);
    if (now >= Date.parse(deadline)) throw new TestingExecutorError('testing_reconcile_deadline_exceeded', 'testing reconcile deadline prevents Runtime dispatch');
  }

  public async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.leaseTimer !== undefined) clearTimeout(this.leaseTimer);
    try { await this.inFlight; } catch { /* authority loss is handled by the executor */ }
  }

  private armLeaseExpiry(): void {
    if (this.leaseTimer !== undefined) clearTimeout(this.leaseTimer);
    const delay = Math.max(0, Math.min(this.leaseExpiresAt - this.clock(), 2_147_483_647));
    this.leaseTimer = setTimeout(() => {
      this.loseAuthority(new TestingExecutorError('testing_lease_expired', 'testing lease authority has expired'));
    }, delay);
  }

  private loseAuthority(error: unknown): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    this.abortController.abort(error);
    this.logger?.warn('testing heartbeat lost authority', {
      runId: this.credentials.runId,
      attemptId: this.credentials.attemptId,
      error: safeMessage(error)
    });
  }
}

const startAttempt = (claim: TestingClaimResponse): TestingRuntimeAttempt => testingRuntimeAttemptSchema.parse({
  schema_version: 'talos.testing-runtime-attempt/v1',
  operation: 'start',
  run_id: claim.task.qa_run_id,
  task_id: claim.task.id,
  attempt_id: claim.task.dispatch_attempt_id,
  machine_id: claim.task.machine_id,
  worker_id: claim.task.worker_id,
  generation: claim.task.generation,
  lease_id: claim.task.lease_id,
  fence_token: claim.task.fence_token,
  admission_nonce: claim.task.admission_nonce,
  lease_claim: claim.task.lease_claim,
  deadline: claim.task.deadline
});

const reconcileAttempt = (claim: TestingReconcileClaimResponse): TestingRuntimeAttempt => testingRuntimeAttemptSchema.parse({
  schema_version: 'talos.testing-runtime-attempt/v1',
  operation: 'reconcile',
  run_id: claim.task.qa_run_id,
  task_id: claim.task.task_id,
  attempt_id: claim.task.dispatch_attempt_id,
  machine_id: claim.task.machine_id,
  worker_id: claim.task.worker_id,
  generation: claim.task.generation,
  lease_id: claim.task.lease_id,
  fence_token: claim.task.fence_token,
  admission_nonce: claim.task.admission_nonce,
  lease_claim: claim.task.lease_claim,
  deadline: claim.task.deadline
});

const startCredentials = (claim: TestingClaimResponse): TestingAttemptCredentials => ({
  runId: claim.task.qa_run_id,
  attemptId: claim.task.dispatch_attempt_id,
  generation: claim.task.generation,
  fenceToken: claim.task.fence_token,
  leaseToken: claim.lease_token
});

const reconcileCredentials = (claim: TestingReconcileClaimResponse): TestingAttemptCredentials => ({
  runId: claim.task.qa_run_id,
  attemptId: claim.task.dispatch_attempt_id,
  generation: claim.task.generation,
  fenceToken: claim.task.fence_token,
  leaseToken: claim.lease_token
});

const assertStartClaim = (claim: TestingClaimResponse, now: number): void => {
  const task = claim.task;
  const identity = claim.current_claim.claim;
  if (
    identity.operation !== 'start' || identity.run_id !== task.qa_run_id || identity.task_id !== task.id ||
    identity.attempt_id !== task.dispatch_attempt_id || identity.machine_id !== task.machine_id ||
    identity.worker_id !== task.worker_id || identity.generation !== task.generation ||
    identity.lease_id !== task.lease_id || identity.fence_token !== task.fence_token ||
    identity.admission_nonce !== task.admission_nonce || claim.lease.lease_id !== task.lease_id ||
    claim.current_claim.claim_digest !== task.lease_claim.digest || !claim.current_claim.is_current ||
    claim.current_claim.audience !== 'talos-worker' || Date.parse(task.deadline) <= now
  ) throw new TestingExecutorError('invalid_testing_claim', 'testing claim and task bindings differ');
};

const assertReconcileClaim = (claim: TestingReconcileClaimResponse, now: number): void => {
  const task = claim.task;
  const identity = claim.current_claim.claim;
  if (
    identity.operation !== 'reconcile' || identity.run_id !== task.qa_run_id || identity.task_id !== task.task_id ||
    identity.attempt_id !== task.dispatch_attempt_id || identity.machine_id !== task.machine_id ||
    identity.worker_id !== task.worker_id || identity.generation !== task.generation ||
    identity.lease_id !== task.lease_id || identity.fence_token !== task.fence_token ||
    identity.admission_nonce !== task.admission_nonce || claim.current_claim.claim_digest !== task.lease_claim.digest ||
    !claim.current_claim.is_current || claim.current_claim.audience !== 'talos-worker' || Date.parse(task.deadline) <= now
  ) throw new TestingExecutorError('invalid_testing_reconcile_claim', 'testing reconcile claim and task bindings differ');
};

const assertAdmission = (
  admission: { run_id: string; request_digest: string; attempt: TestingRuntimeAttempt; snapshot: LocalQARuntimeSnapshot },
  attempt: TestingRuntimeAttempt,
  requestDigest: string
): void => {
  if (admission.run_id !== attempt.run_id || admission.request_digest !== requestDigest ||
      JSON.stringify(admission.attempt) !== JSON.stringify(attempt)) {
    throw new TestingExecutorError('runtime_admission_mismatch', 'Runtime admission is bound to another request or attempt');
  }
  assertSnapshotAttempt(admission.snapshot, attempt);
};

const assertCancelAcknowledgement = (
  acknowledgement: { run_id: string; request_digest: string; snapshot: LocalQARuntimeSnapshot },
  attempt: TestingRuntimeAttempt,
  requestDigest: string
): void => {
  if (acknowledgement.run_id !== attempt.run_id || acknowledgement.request_digest !== requestDigest) {
    throw new TestingExecutorError(
      'runtime_cancel_ack_mismatch',
      'Runtime cancellation acknowledgement is bound to another request'
    );
  }
  assertSnapshotAttempt(acknowledgement.snapshot, attempt);
};

const assertSnapshotAttempt = (snapshot: LocalQARuntimeSnapshot, attempt: TestingRuntimeAttempt): void => {
  const binding = snapshot.attempt;
  if (
    snapshot.run_id !== attempt.run_id || binding.run_id !== attempt.run_id ||
    binding.task_id !== attempt.task_id || binding.attempt_id !== attempt.attempt_id ||
    binding.machine_id !== attempt.machine_id || binding.generation !== attempt.generation ||
    binding.fence_token !== attempt.fence_token
  ) {
    throw new TestingExecutorError('runtime_snapshot_mismatch', 'Runtime snapshot is bound to another attempt');
  }
};

const runtimeProgress = (snapshot: LocalQARuntimeSnapshot): TestingHeartbeatProgress => ({
  phase: snapshot.progress.phase,
  completed_cases: snapshot.progress.completed_cases,
  total_cases: snapshot.progress.total_cases,
  runtime_event_sequence: snapshot.event_sequence
});

const terminalProjection = (snapshot: LocalQARuntimeSnapshot): TestingTerminalProjection => {
  if (
    snapshot.state !== 'terminal' || snapshot.execution_outcome === undefined ||
    snapshot.evidence_outcome === undefined || snapshot.upload_outcome === undefined ||
    snapshot.cleanup_outcome === undefined
  ) throw new TestingExecutorError('runtime_not_terminal', 'Runtime snapshot does not contain a complete terminal projection');
  const controlStatus = snapshot.execution_outcome === 'cancelled'
    ? 'cancelled' as const
    : ['not_started', 'error', 'lost_or_inconclusive'].includes(snapshot.execution_outcome)
      ? 'failed' as const
      : 'completed' as const;
  return {
    controlStatus,
    executionOutcome: snapshot.execution_outcome,
    evidenceOutcome: snapshot.evidence_outcome,
    uploadOutcome: snapshot.upload_outcome,
    cleanupOutcome: snapshot.cleanup_outcome,
    ...(snapshot.summary === undefined ? {} : { summary: snapshot.summary }),
    ...(snapshot.results === undefined ? {} : { results: snapshot.results }),
    ...(snapshot.safe_error === undefined ? {} : { safeError: snapshot.safe_error })
  };
};

const claimIdFromReference = (reference: string, expectedRunId: string): string => {
  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    throw new TestingExecutorError('invalid_claim_reference', 'lease claim reference is not a valid URL');
  }
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  if (
    url.protocol !== 'talos:' || url.hostname !== 'testing' || url.username !== '' || url.password !== '' ||
    url.port !== '' || url.search !== '' || url.hash !== '' || segments.length !== 3 ||
    segments[0] !== 'claims' || segments[1] !== expectedRunId || segments[2]?.length === 0
  ) {
    throw new TestingExecutorError('invalid_claim_reference', 'lease claim reference does not identify one claim');
  }
  return segments[2] as string;
};

const runtimeOperationId = (
  operation: 'start' | 'cancel' | 'reconcile',
  attempt: TestingRuntimeAttempt,
  claimId: string
): string =>
  createHash('sha256').update(JSON.stringify({
    operation,
    run_id: attempt.run_id,
    attempt_id: attempt.attempt_id,
    generation: attempt.generation,
    fence_token: attempt.fence_token,
    claim_id: claimId
  })).digest('hex');

const assertRuntimeJournalConsistent = (
  eventPage: { through_sequence: number; snapshot_digest: string },
  snapshot: LocalQARuntimeSnapshot
): void => {
  if (snapshot.event_sequence < eventPage.through_sequence) {
    throw new TestingExecutorError(
      'runtime_journal_regressed',
      'Runtime snapshot predates the delivered event page'
    );
  }
  if (
    snapshot.event_sequence === eventPage.through_sequence &&
    snapshot.snapshot_digest !== eventPage.snapshot_digest
  ) {
    throw new TestingExecutorError(
      'runtime_journal_mismatch',
      'Runtime event page and snapshot digests differ at the same sequence'
    );
  }
};

const assertRuntimeClaimFresh = (claim: TestingCurrentClaimEnvelope, now: number): void => {
  if (claim.audience !== 'local-qa-runtime' || Date.parse(claim.valid_until) <= now) {
    throw new TestingExecutorError('testing_current_claim_expired', 'Runtime current-claim observation is no longer valid');
  }
};

const assertResolvedCurrentClaim = (
  claim: TestingCurrentClaimEnvelope,
  attempt: TestingRuntimeAttempt,
  claimId: string,
  requestNonce: string
): void => {
  const identity = claim.claim;
  if (
    claim.audience !== 'local-qa-runtime' || claim.request_nonce !== requestNonce ||
    claim.claim_digest !== attempt.lease_claim.digest || identity.claim_id !== claimId ||
    identity.operation !== attempt.operation || identity.run_id !== attempt.run_id ||
    identity.task_id !== attempt.task_id || identity.attempt_id !== attempt.attempt_id ||
    identity.machine_id !== attempt.machine_id || identity.worker_id !== attempt.worker_id ||
    identity.generation !== attempt.generation || identity.lease_id !== attempt.lease_id ||
    identity.fence_token !== attempt.fence_token || identity.admission_nonce !== attempt.admission_nonce
  ) {
    throw new TestingExecutorError(
      'testing_current_claim_mismatch',
      'resolved current claim is not bound to the challenge and exact attempt'
    );
  }
};

const assertHeartbeatResponse = (
  response: {
    lease_expires_at: string;
    cancel_requested: boolean;
    current_claim: TestingCurrentClaimEnvelope;
  },
  attempt: TestingRuntimeAttempt,
  credentials: TestingAttemptCredentials
): void => {
  const claim = response.current_claim;
  const identity = claim.claim;
  const stateAllowed = claim.is_current || (
    response.cancel_requested && claim.status === 'cancel_requested'
  );
  if (
    !stateAllowed || claim.audience !== 'talos-worker' ||
    claim.claim_digest !== attempt.lease_claim.digest ||
    claim.lease_expires_at !== response.lease_expires_at ||
    identity.operation !== attempt.operation || identity.run_id !== credentials.runId ||
    identity.task_id !== attempt.task_id || identity.attempt_id !== credentials.attemptId ||
    identity.machine_id !== attempt.machine_id || identity.worker_id !== attempt.worker_id ||
    identity.generation !== credentials.generation || identity.lease_id !== attempt.lease_id ||
    identity.fence_token !== credentials.fenceToken || identity.admission_nonce !== attempt.admission_nonce
  ) {
    throw new TestingExecutorError(
      'testing_heartbeat_claim_mismatch',
      'testing heartbeat response is not bound to the exact current attempt'
    );
  }
};

const safeMessage = (error: unknown): string => {
  if (error instanceof WorkerClientError || error instanceof TestingExecutorError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : 'unknown error';
};

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw signal.reason;
};

const combineSignals = (primary: AbortSignal, secondary: AbortSignal | undefined): AbortSignal =>
  secondary === undefined ? primary : AbortSignal.any([primary, secondary]);

const raceWithSignal = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
};

const sleepWithSignal = async (
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal
): Promise<void> => {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void sleep(milliseconds).then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
};
