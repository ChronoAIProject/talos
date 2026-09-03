import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  timingSafeEqual,
  type KeyObject
} from 'node:crypto';
import {
  canonicalJson,
  computeTestingCurrentClaimDigest,
  computeTestingReconcileTaskPayloadDigest,
  computeTestingRunEventDigest,
  computeTestingRunSnapshotDigest,
  computeTestingTaskPayloadDigest,
  identifierSchema,
  sha256DigestSchema,
  testingCurrentClaimEnvelopeCoreSchema,
  testingCurrentClaimEnvelopeSchema,
  testingCurrentClaimResolveRequestSchema,
  testingNoLocalAcceptanceFactSchema,
  testingReconcileClosureCoreSchema,
  testingReconcileClosureSchema,
  testingReconcileTaskSchema,
  testingRunEventSchema,
  testingRunSummarySchema,
  testingTaskSchema,
  testingTerminalRefsSchema,
  type TestingCleanupOutcome,
  type TestingCurrentClaimEnvelope,
  type TestingCurrentClaimIdentity,
  type TestingCurrentClaimResolveRequest,
  type TestingEvidenceOutcome,
  type TestingExecutionOutcome,
  type TestingRunEvent,
  type TestingRunSummary,
  type TestingRunProgress,
  type TestingSafeError,
  type TestingTask,
  type TestingReconcileClosure,
  type TestingReconcileTask,
  type TestingNoLocalAcceptanceFact,
  type TestingTerminalRefs,
  type TestingUploadOutcome,
  type TestingTerminalReasonCode
} from '@talos/testing-protocol';
import { z } from 'zod';
import { TalosError, notFound } from '../domain/errors.js';
import {
  isTestingRunCanonicalTerminal,
  projectTestingRunAttempt,
  testingOutcomesSettled,
  type TestingAttemptClaimRecord,
  type TestingAttemptRecord,
  type TestingCleanupVerificationRecord,
  type TestingMachineReservationRecord,
  type TestingRunRecord
} from '../domain/testing-types.js';
import type { Machine, Pool } from '../domain/types.js';
import type { Repository, TestingAttemptDispatchGuard, TestingAttemptMutationGuard } from '../storage/repository.js';
import { newId } from '../util/id.js';
import {
  resolveTestingExternalSchemaCapabilities,
  type TestingExternalSchemaAuthority,
  type TestingExternalSchemaOwner,
  type TestingExternalSchemaReferenceVerification,
  type TestingTerminalSchemaContract
} from './testing-schema-authority.js';

const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'abandoned']);
const activeAttemptStatuses = new Set(['reserved', 'claimed', 'local_accepted', 'running', 'closing']);
export const TESTING_MAX_ATTEMPTS = 16;
export const TESTING_MAX_RECONCILE_CLAIMS = 16;
export const TESTING_RECONCILE_WINDOW_MS = 120_000;

const testingCleanupReceiptVerificationSchema = z.object({
  schemaVersion: z.literal('talos.testing-cleanup-receipt-verification/v1'),
  verifierId: identifierSchema,
  verificationId: identifierSchema,
  receiptRef: z.string().min(1).max(2_048)
    .regex(/^artifact:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/),
  receiptDigest: sha256DigestSchema,
  disposition: z.enum([
    'cleanup_complete',
    'cleanup_not_required',
    'cleanup_residual_retryable',
    'cleanup_residual_blocking'
  ]),
  verifiedAt: z.string().datetime({ offset: true })
}).strict();

const testingExternalSchemaReferenceVerificationSchema = z.object({
  schemaVersion: z.literal('talos.testing-external-schema-verification/v1'),
  authorityId: identifierSchema,
  verificationId: identifierSchema,
  contract: z.enum(['case_result_set', 'evidence_manifest', 'cleanup_receipt']),
  owner: z.enum(['testing-packages', 'local-qa-runtime']),
  referenceSchema: z.string().min(1).max(255),
  schemaId: identifierSchema,
  version: identifierSchema,
  schemaDigest: sha256DigestSchema,
  artifactRef: z.string().min(1).max(2_048),
  artifactDigest: sha256DigestSchema,
  verifiedAt: z.string().datetime({ offset: true })
}).strict();

export interface TestingStartAuthorizationContext {
  readonly operation: 'start';
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly machineId: string;
  readonly workerId: string;
  readonly generation: number;
  readonly leaseId: string;
  readonly fenceToken: string;
  readonly admissionNonce: string;
  readonly leaseClaim: TestingAttemptRecord['leaseClaim'];
  readonly requestDigest: string;
  readonly deadline: string;
}

export interface TestingReconcileAuthorizationContext {
  readonly operation: 'reconcile';
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly machineId: string;
  readonly workerId: string;
  readonly generation: number;
  readonly leaseId: string;
  readonly fenceToken: string;
  readonly admissionNonce: string;
  readonly leaseClaim: TestingAttemptRecord['leaseClaim'];
  readonly requestDigest: string;
  readonly deadline: string;
}

export interface TestingAuthorizationProvider {
  issueStartAuthorization(
    context: TestingStartAuthorizationContext
  ): Promise<TestingTask['local_request_authorization']>;
  issueReconcileAuthorization?(
    context: TestingReconcileAuthorizationContext
  ): Promise<TestingReconcileTask['local_request_authorization']>;
}

export interface TestingRuntimeFactVerifier {
  // The adapter must verify an authority-signed, monotonic Runtime Journal terminal proof.
  verifyTerminalNoLocalAcceptance(
    fact: TestingNoLocalAcceptanceFact,
    context: {
      readonly runId: string;
      readonly taskId: string;
      readonly attemptId: string;
      readonly machineId: string;
      readonly generation: number;
      readonly fenceToken: string;
      readonly admissionNonce: string;
      readonly startClaimDigest: string;
      readonly reconcileClaimId: string;
      readonly reconcileLeaseId: string;
      readonly reconcileClaimDigest: string;
      readonly reconcileIssuedAt: string;
    }
  ): Promise<TestingNoLocalAcceptanceVerification | undefined>;
}

export interface TestingNoLocalAcceptanceVerification {
  readonly schemaVersion: 'talos.testing-no-local-acceptance-verification/v1';
  readonly disposition: 'never_accepted';
  readonly journalVersion: number;
  readonly startClaimDigest: string;
  readonly reconcileClaimDigest: string;
}

export interface TestingCleanupReceiptVerification {
  readonly schemaVersion: 'talos.testing-cleanup-receipt-verification/v1';
  readonly verifierId: string;
  readonly verificationId: string;
  readonly receiptRef: string;
  readonly receiptDigest: string;
  readonly disposition:
    | 'cleanup_complete'
    | 'cleanup_not_required'
    | 'cleanup_residual_retryable'
    | 'cleanup_residual_blocking';
  readonly verifiedAt: string;
}

export interface TestingCleanupReceiptVerifier {
  verifyCleanupReceipt(
    receipt: NonNullable<TestingTerminalRefs['cleanup_receipt']>,
    context: {
      readonly runId: string;
      readonly taskId: string;
      readonly attemptId: string;
      readonly machineId: string;
      readonly generation: number;
      readonly fenceToken: string;
      readonly cleanupOutcome: 'complete' | 'not_required' | 'residual_retryable' | 'residual_blocking';
    }
  ): Promise<TestingCleanupReceiptVerification | undefined>;
}

export interface TestingAttemptBindingInput {
  readonly runId: string;
  readonly attemptId: string;
  readonly machineId: string;
  readonly workerId: string;
  readonly generation: number;
  readonly fenceToken: string;
  readonly leaseToken: string;
}

export interface TestingClaimResult {
  readonly task: TestingTask;
  readonly lease: {
    readonly lease_id: string;
    readonly lease_expires_at: string;
  };
  readonly lease_token: string;
  readonly current_claim: TestingCurrentClaimEnvelope;
}

export interface TestingReconcileClaimResult {
  readonly task: TestingReconcileTask;
  readonly lease_token: string;
  readonly current_claim: TestingCurrentClaimEnvelope;
}

export interface TestingHeartbeatResult {
  readonly lease_expires_at: string;
  readonly cancel_requested: boolean;
  readonly current_claim: TestingCurrentClaimEnvelope;
}

export interface TestingHeartbeatProgress extends Omit<TestingRunProgress, 'last_event_sequence'> {
  readonly runtime_event_sequence: number;
}

export interface TestingTerminalCommit extends TestingAttemptBindingInput {
  readonly controlStatus: 'completed' | 'failed' | 'cancelled';
  readonly executionOutcome: TestingExecutionOutcome;
  readonly evidenceOutcome: TestingEvidenceOutcome;
  readonly uploadOutcome: TestingUploadOutcome;
  readonly cleanupOutcome: TestingCleanupOutcome;
  readonly summary?: TestingRunSummary;
  readonly results?: TestingTerminalRefs;
  readonly safeError?: TestingSafeError;
}

type SettledTestingTerminalCommit = TestingTerminalCommit & {
  readonly executionOutcome: Exclude<TestingExecutionOutcome, 'executing'>;
  readonly evidenceOutcome: Exclude<TestingEvidenceOutcome, 'staging'>;
  readonly cleanupOutcome: Exclude<TestingCleanupOutcome, 'pending'>;
};

export interface TestingAttemptServiceOptions {
  readonly claimSigningKey?: KeyObject | string;
  readonly claimKeyId?: string;
  readonly authorizationProvider?: TestingAuthorizationProvider;
  readonly runtimeFactVerifier?: TestingRuntimeFactVerifier;
  readonly cleanupReceiptVerifier?: TestingCleanupReceiptVerifier;
  readonly externalSchemaAuthority?: TestingExternalSchemaAuthority;
  readonly clock?: () => number;
  readonly leaseSeconds?: number;
}

interface TestingCurrentClaimChallenge {
  readonly audience: 'talos-worker' | 'local-qa-runtime';
  readonly request_nonce: string;
}

export class TestingAttemptService {
  private readonly clock: () => number;
  private readonly leaseSeconds: number;
  private readonly claimSigningKey: KeyObject;
  private readonly claimKeyId: string;

  public constructor(
    private readonly repository: Repository,
    private readonly options: TestingAttemptServiceOptions
  ) {
    this.clock = options.clock ?? Date.now;
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.claimSigningKey = normalizeClaimSigningKey(options.claimSigningKey);
    this.claimKeyId = options.claimKeyId ?? claimKeyFingerprint(this.claimSigningKey);
  }

  public claimPublicKey(): KeyObject {
    return createPublicKey(this.claimSigningKey);
  }

  public async claim(workerId: string, machineId: string): Promise<TestingClaimResult> {
    const provider = this.options.authorizationProvider;
    if (provider === undefined) {
      throw new TalosError('testing_authorization_unavailable', 'testing authorization provider is unavailable', 503);
    }
    const machine = await this.repository.getMachine(machineId);
    if (machine === undefined || !machine.online) throw notFound('testing machine is not available');

    const runs = (await this.repository.listTestingRuns())
      .filter((run) => run.controlStatus === 'submitted' && run.task.status === 'submitted')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const run of runs) {
      if (!await this.machineEligible(machine, run)) continue;
      if (run.attempts.length >= TESTING_MAX_ATTEMPTS) {
        await this.failAttemptExhausted(run);
        continue;
      }
      const claimed = await this.claimRun(run, machine, workerId, provider);
      if (claimed !== undefined) return claimed;
    }
    throw notFound('no eligible testing run available for worker');
  }

  public async heartbeat(
    input: TestingAttemptBindingInput,
    extendSeconds: number,
    progress?: TestingHeartbeatProgress
  ): Promise<TestingHeartbeatResult> {
    if (!Number.isInteger(extendSeconds) || extendSeconds < 1 || extendSeconds > 300) {
      throw new TalosError('invalid_lease_extension', 'testing lease extension must be between 1 and 300 seconds', 400);
    }
    for (let retries = 0; retries < 20; retries += 1) {
      const run = await this.requireRun(input.runId);
      const attempt = this.assertCurrentAttempt(run, input, 'heartbeat');
      this.assertHeartbeatProgress(run, attempt, progress);
      const now = this.clock();
      const operationDeadline = this.operationDeadline(run, attempt);
      const expiresAt = new Date(Math.min(
        now + extendSeconds * 1_000,
        operationDeadline
      )).toISOString();
      const updatedAttempt = {
        ...attempt,
        leaseExpiresAt: expiresAt,
        ...(progress === undefined ? {} : { runtimeEventSequence: progress.runtime_event_sequence }),
        updatedAt: new Date(now).toISOString()
      };
      const updated = this.withAttempt(run, updatedAttempt, {
        recordVersion: run.recordVersion + 1,
        ...(progress === undefined ? {} : {
          snapshotVersion: run.snapshotVersion + 1,
          progress: {
            phase: progress.phase,
            completed_cases: progress.completed_cases,
            total_cases: progress.total_cases,
            last_event_sequence: run.progress.last_event_sequence
          }
        }),
        updatedAt: progress === undefined ? run.updatedAt : updatedAttempt.updatedAt
      });
      if (!await this.repository.replaceTestingRunForAttempt(
        updated,
        run.recordVersion,
        this.deadlineKind(attempt),
        this.mutationGuard(attempt),
        now
      )) continue;
      await this.updateReservation(updatedAttempt, run.task.id, this.reservationStatus(updatedAttempt), expiresAt);
      return {
        lease_expires_at: expiresAt,
        cancel_requested: run.controlStatus === 'cancel_requested',
        current_claim: this.currentClaim(updated, updatedAttempt)
      };
    }
    throw new TalosError('concurrent_update', 'testing run changed too frequently', 409);
  }

  public async claimNextReconcile(workerId: string, machineId: string): Promise<TestingReconcileClaimResult> {
    const candidates = (await this.repository.listTestingRuns())
      .filter((run) => {
        const attempt = this.currentAttempt(run);
        return attempt?.machineId === machineId &&
          ['acceptance_unknown', 'reconcile_required'].includes(attempt.status) &&
          ['cancel_requested', 'reconcile_required'].includes(run.controlStatus);
      })
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const run of candidates) {
      try {
        return await this.claimReconcile(workerId, machineId, run.id);
      } catch (error) {
        if (error instanceof TalosError && [
          'testing_reconcile_unavailable',
          'testing_reconcile_deadline_exceeded',
          'testing_reconcile_claim_limit',
          'claim_superseded'
        ].includes(error.code)) continue;
        throw error;
      }
    }
    throw notFound('no testing run requires same-machine reconcile');
  }

  public async claimReconcile(
    workerId: string,
    machineId: string,
    runId: string
  ): Promise<TestingReconcileClaimResult> {
    const provider = this.options.authorizationProvider;
    if (provider?.issueReconcileAuthorization === undefined) {
      throw new TalosError('testing_authorization_unavailable', 'testing reconcile authorization provider is unavailable', 503);
    }
    const run = await this.requireRun(runId);
    const attempt = this.currentAttempt(run);
    if (
      attempt === undefined ||
      attempt.machineId !== machineId ||
      !['acceptance_unknown', 'reconcile_required'].includes(attempt.status) ||
      !['cancel_requested', 'reconcile_required'].includes(run.controlStatus)
    ) {
      throw new TalosError('testing_reconcile_unavailable', 'testing run is not available for same-machine reconcile', 409);
    }
    if (attempt.priorClaims.length >= TESTING_MAX_RECONCILE_CLAIMS) {
      throw new TalosError('testing_reconcile_claim_limit', 'testing reconcile claim limit is exhausted', 409);
    }
    const nowMs = this.clock();
    const reconcileDeadline = run.reconcileDeadlineAt ?? attempt.reconcileDeadline;
    if (reconcileDeadline === undefined || Date.parse(reconcileDeadline) <= nowMs) {
      throw new TalosError('testing_reconcile_deadline_exceeded', 'testing reconcile deadline has passed', 409);
    }
    const reservation = await this.repository.getTestingMachineReservation(machineId);
    if (
      reservation?.attemptId !== attempt.id ||
      reservation.runId !== run.id ||
      reservation.taskId !== run.task.id ||
      reservation.generation !== attempt.generation ||
      reservation.fenceToken !== attempt.fenceToken
    ) {
      throw new TalosError('testing_reservation_lost', 'testing machine reservation is not owned by the reconcile attempt', 409);
    }

    const now = new Date(nowMs).toISOString();
    const claimId = newId('testing-claim');
    const leaseId = newId('testing-lease');
    const leaseToken = newId('testing-lease-token');
    const leaseExpiresAt = new Date(Math.min(
      nowMs + this.leaseSeconds * 1_000,
      Date.parse(reconcileDeadline)
    )).toISOString();
    const leaseClaimBinding = {
      schema: 'talos.testing-lease-claim/v1' as const,
      ref: `talos://testing/claims/${run.id}/${claimId}`,
      expires_at: reconcileDeadline
    };
    const taskPayloadDigest = computeTestingReconcileTaskPayloadDigest({
      schema_version: 'talos.testing-reconcile-task/v1',
      operation: 'reconcile',
      qa_run_id: run.id,
      task_id: run.task.id,
      dispatch_attempt_id: attempt.id,
      generation: attempt.generation,
      machine_id: machineId,
      worker_id: workerId,
      lease_id: leaseId,
      fence_token: attempt.fenceToken,
      admission_nonce: attempt.admissionNonce,
      lease_claim: leaseClaimBinding,
      deadline: reconcileDeadline
    });
    const identity = this.claimIdentityFromValues(run, {
      claimId,
      operation: 'reconcile',
      taskPayloadDigest,
      attemptId: attempt.id,
      machineId,
      workerId,
      generation: attempt.generation,
      leaseId,
      fenceToken: attempt.fenceToken,
      admissionNonce: attempt.admissionNonce,
      issuedAt: now,
      expiresAt: reconcileDeadline
    });
    const leaseClaim = {
      ...leaseClaimBinding,
      digest: computeTestingCurrentClaimDigest(identity),
    };
    let authorization: TestingReconcileTask['local_request_authorization'];
    try {
      authorization = await provider.issueReconcileAuthorization({
        operation: 'reconcile',
        runId: run.id,
        taskId: run.task.id,
        attemptId: attempt.id,
        machineId,
        workerId,
        generation: attempt.generation,
        leaseId,
        fenceToken: attempt.fenceToken,
        admissionNonce: attempt.admissionNonce,
        leaseClaim,
        requestDigest: run.requestDigest,
        deadline: reconcileDeadline
      });
      if (Date.parse(authorization.expires_at) <= this.clock()) throw new Error('reconcile authorization expired');
    } catch {
      throw new TalosError('testing_authorization_unavailable', 'testing reconcile authorization is unavailable', 503);
    }
    const updatedAttempt: TestingAttemptRecord = {
      ...attempt,
      priorClaims: [...attempt.priorClaims, this.claimRecord(attempt)],
      claimId,
      operation: 'reconcile',
      taskPayloadDigest,
      workerId,
      leaseId,
      leaseTokenHash: hashSecret(leaseToken),
      leaseClaim,
      authorization,
      leaseExpiresAt,
      issuedAt: now,
      status: 'reconcile_required',
      updatedAt: now
    };
    const updated = this.withAttempt(run, updatedAttempt, {
      recordVersion: run.recordVersion + 1,
      snapshotVersion: run.snapshotVersion + 1,
      updatedAt: now
    });
    if (!await this.repository.replaceTestingRunForDispatch(
      updated,
      run.recordVersion,
      'reconcile',
      this.dispatchGuard(attempt, leaseExpiresAt, authorization.expires_at),
      this.clock()
    )) {
      throw new TalosError('claim_superseded', 'testing reconcile claim was superseded', 409);
    }
    await this.updateReservation(updatedAttempt, run.task.id, 'reconcile_required', reconcileDeadline);
    const task = testingReconcileTaskSchema.parse({
      schema_version: 'talos.testing-reconcile-task/v1',
      operation: 'reconcile',
      qa_run_id: run.id,
      task_id: run.task.id,
      dispatch_attempt_id: attempt.id,
      generation: attempt.generation,
      machine_id: machineId,
      worker_id: workerId,
      lease_id: leaseId,
      fence_token: attempt.fenceToken,
      admission_nonce: attempt.admissionNonce,
      lease_claim: leaseClaim,
      task_payload_digest: taskPayloadDigest,
      local_request_authorization: authorization,
      deadline: reconcileDeadline
    });
    return {
      task,
      lease_token: leaseToken,
      current_claim: this.currentClaim(updated, updatedAttempt)
    };
  }

  public async acceptLocal(input: TestingAttemptBindingInput): Promise<TestingCurrentClaimEnvelope> {
    return this.transitionAttempt(input, 'claimed', 'local_accepted', 'attempt.local_accepted');
  }

  public async markRunning(input: TestingAttemptBindingInput): Promise<TestingCurrentClaimEnvelope> {
    return this.transitionAttempt(input, 'local_accepted', 'running', 'run.started');
  }

  public async confirmNotLocallyAccepted(
    input: TestingAttemptBindingInput,
    factInput: unknown
  ): Promise<TestingRunRecord> {
    const verifier = this.options.runtimeFactVerifier;
    if (verifier === undefined) {
      throw new TalosError('testing_fact_verifier_unavailable', 'testing Runtime fact verifier is unavailable', 503);
    }
    const fact = testingNoLocalAcceptanceFactSchema.parse(factInput);
    for (let retries = 0; retries < 20; retries += 1) {
      const run = await this.requireRun(input.runId);
      const attempt = this.currentAttempt(run);
      if (attempt === undefined || attempt.id !== input.attemptId || attempt.localAcceptedAt !== undefined) {
        throw new TalosError('invalid_testing_state', 'testing attempt cannot accept a no-local-acceptance fact', 409);
      }
      this.assertCurrentAttempt(run, input, 'reconcile');
      if (attempt.operation !== 'reconcile' || attempt.status !== 'reconcile_required') {
        throw new TalosError('invalid_testing_state', 'testing attempt is not awaiting an acceptance fact', 409);
      }
      const claims: TestingAttemptClaimRecord[] = [attempt, ...attempt.priorClaims];
      const factClaim = claims.find((candidate) => {
        if (candidate.operation !== 'start') return false;
        const identity = this.claimIdentity(attempt, candidate, run);
        return candidate.workerId === fact.worker_id &&
          candidate.leaseId === fact.lease_id &&
          computeTestingCurrentClaimDigest(identity) === fact.start_claim_digest;
      });
      const reconcileIdentity = this.claimIdentity(attempt, attempt, run);
      const reconcileClaimDigest = computeTestingCurrentClaimDigest(reconcileIdentity);
      if (
        factClaim === undefined ||
        fact.run_id !== run.id ||
        fact.task_id !== run.task.id ||
        fact.attempt_id !== attempt.id ||
        fact.machine_id !== attempt.machineId ||
        fact.generation !== attempt.generation ||
        fact.fence_token !== attempt.fenceToken ||
        fact.admission_nonce !== attempt.admissionNonce ||
        fact.reconcile_claim_id !== attempt.claimId ||
        fact.reconcile_lease_id !== attempt.leaseId ||
        fact.reconcile_claim_digest !== reconcileClaimDigest ||
        Date.parse(fact.observed_at) < Date.parse(attempt.issuedAt)
      ) {
        throw new TalosError('stale_no_local_acceptance_fact', 'no-local-acceptance fact is bound to another attempt', 409);
      }
      let verification: TestingNoLocalAcceptanceVerification | undefined;
      try {
        verification = await verifier.verifyTerminalNoLocalAcceptance(fact, {
          runId: run.id,
          taskId: run.task.id,
          attemptId: attempt.id,
          machineId: attempt.machineId,
          generation: attempt.generation,
          fenceToken: attempt.fenceToken,
          admissionNonce: attempt.admissionNonce,
          startClaimDigest: fact.start_claim_digest,
          reconcileClaimId: attempt.claimId,
          reconcileLeaseId: attempt.leaseId,
          reconcileClaimDigest,
          reconcileIssuedAt: attempt.issuedAt
        });
      } catch {
        throw new TalosError('testing_fact_verifier_unavailable', 'testing Runtime fact verifier is unavailable', 503);
      }
      if (
        verification === undefined ||
        verification.schemaVersion !== 'talos.testing-no-local-acceptance-verification/v1' ||
        verification.disposition !== 'never_accepted' ||
        verification.journalVersion !== fact.journal_version ||
        verification.startClaimDigest !== fact.start_claim_digest ||
        verification.reconcileClaimDigest !== reconcileClaimDigest
      ) throw new TalosError('invalid_no_local_acceptance_fact', 'Runtime rejected terminal no-local-acceptance proof', 401);

      const nowMs = this.clock();
      const now = new Date(nowMs).toISOString();
      const terminalStatus = run.controlStatus === 'cancel_requested'
        ? 'cancelled'
        : this.runDeadline(run) <= nowMs
          ? 'failed'
          : undefined;
      const reason = terminalStatus === 'cancelled'
        ? 'cancelled_before_acceptance'
        : terminalStatus === 'failed'
          ? 'deadline_exceeded'
          : 'lease_expired';
      const releasedAttempt: TestingAttemptRecord = {
        ...attempt,
        status: terminalStatus ?? 'released',
        noLocalAcceptanceFact: fact,
        reservationCancellationReceipt: {
          schemaVersion: 'talos.testing-reservation-cancellation-receipt/v1',
          reason,
          releasedAt: now
        },
        updatedAt: now
      };
      const releaseEvent = makeEvent(
        run.progress.last_event_sequence + 1,
        'attempt.released',
        now,
        { attempt_id: attempt.id, generation: attempt.generation, reason_code: reason }
      );
      const terminalEvent = terminalStatus === 'cancelled'
        ? makeEvent(releaseEvent.sequence + 1, 'run.cancelled', now, { cleanup_outcome: 'unobserved' })
        : terminalStatus === 'failed'
          ? makeEvent(releaseEvent.sequence + 1, 'run.failed', now, { error_code: 'deadline_exceeded' })
          : undefined;
      const nextStatus = terminalStatus ?? 'submitted';
      const updated = this.withAttempt(run, releasedAttempt, {
        recordVersion: run.recordVersion + 1,
        snapshotVersion: run.snapshotVersion + 1,
        controlStatus: nextStatus,
        executionOutcome: 'not_started',
        cleanupOutcome: 'unobserved',
        ...(terminalStatus === undefined
          ? {}
          : {
              terminalReason: {
                code: terminalStatus === 'cancelled' ? 'cancelled' as const : 'deadline_exceeded' as const,
                at: now
              },
              blocking: undefined
            }),
        task: { ...run.task, status: nextStatus, updatedAt: now },
        currentAttemptId: terminalStatus === undefined ? undefined : run.currentAttemptId,
        attempt: terminalStatus === undefined ? undefined : run.attempt,
        reconcileDeadlineAt: undefined,
        safeError: terminalStatus === 'failed'
          ? { code: 'deadline_exceeded', message: 'testing run deadline expired without local acceptance', retryable: false }
          : run.safeError,
        progress: {
          ...run.progress,
          phase: nextStatus,
          last_event_sequence: terminalEvent?.sequence ?? releaseEvent.sequence
        },
        events: appendBoundedEvents(run, terminalEvent === undefined ? [releaseEvent] : [releaseEvent, terminalEvent]),
        updatedAt: now
      });
      if (!await this.repository.replaceTestingRunForAttempt(
        updated,
        run.recordVersion,
        'reconcile',
        this.mutationGuard(attempt),
        this.clock()
      )) continue;
      await this.releaseReservation(attempt.machineId, attempt.id);
      return updated;
    }
    throw new TalosError('concurrent_update', 'testing run changed too frequently while recording Runtime fact', 409);
  }

  public async assertEffectAllowed(
    input: TestingAttemptBindingInput,
    effect: 'runtime_dispatch' | 'artifact_upload' | 'terminal_commit' | 'runtime_cancel' | 'reconcile'
  ): Promise<void> {
    const run = await this.requireRun(input.runId);
    this.assertCurrentAttempt(run, input, effect);
  }

  public async commitTerminal(input: TestingTerminalCommit): Promise<TestingRunRecord> {
    return this.commitTerminalInternal(input, false);
  }

  public async commitReconcileTerminal(input: TestingTerminalCommit): Promise<TestingRunRecord> {
    return this.commitTerminalInternal(input, true);
  }

  private async commitTerminalInternal(
    input: TestingTerminalCommit,
    reconcile: boolean
  ): Promise<TestingRunRecord> {
    for (let retries = 0; retries < 20; retries += 1) {
      const run = await this.requireRun(input.runId);
      if (terminalStatuses.has(run.controlStatus)) {
        const replay = await this.replayTerminal(run, input, reconcile ? 'reconcile' : 'start');
        if (replay !== undefined) return replay;
        continue;
      }
      const attempt = this.assertCurrentAttempt(run, input, reconcile ? 'reconcile' : 'terminal_commit');
      const allowedStatuses: TestingAttemptRecord['status'][] = reconcile
        ? ['reconcile_required']
        : ['local_accepted', 'running', 'closing'];
      if (!allowedStatuses.includes(attempt.status)) {
        throw new TalosError('invalid_testing_state', 'testing attempt is not ready for terminal commit', 409);
      }
      const controlStatus = run.controlStatus === 'cancel_requested' ? 'cancelled' : input.controlStatus;
      const results = input.results === undefined ? undefined : testingTerminalRefsSchema.parse(input.results);
      if (results !== undefined) this.assertTerminalBinding(run, attempt, results);
      this.assertTerminalOutcomes(input, results);
      await this.verifyExternalSchemaProofs(results);
      const cleanupVerification = await this.verifyCleanupProof(run, attempt, input.cleanupOutcome, results);
      const now = new Date(this.clock()).toISOString();
      const closing = makeEvent(
        run.progress.last_event_sequence + 1,
        'run.closing',
        now,
        { reason_code: controlStatus }
      );
      const terminal = controlStatus === 'completed'
        ? makeEvent(closing.sequence + 1, 'run.completed', now, { execution_outcome: input.executionOutcome })
        : controlStatus === 'failed'
          ? makeEvent(closing.sequence + 1, 'run.failed', now, { error_code: input.safeError?.code ?? 'testing_failed' })
          : makeEvent(closing.sequence + 1, 'run.cancelled', now, { cleanup_outcome: input.cleanupOutcome });
      const updatedAttempt: TestingAttemptRecord = { ...attempt, status: controlStatus, updatedAt: now };
      const updated = this.withAttempt(run, updatedAttempt, {
        recordVersion: run.recordVersion + 1,
        snapshotVersion: run.snapshotVersion + 1,
        controlStatus,
        executionOutcome: input.executionOutcome,
        evidenceOutcome: input.evidenceOutcome,
        uploadOutcome: input.uploadOutcome,
        cleanupOutcome: input.cleanupOutcome,
        terminalReason: testingOutcomesSettled({
          executionOutcome: input.executionOutcome,
          evidenceOutcome: input.evidenceOutcome,
          uploadOutcome: input.uploadOutcome,
          cleanupOutcome: input.cleanupOutcome
        }) ? { code: this.terminalReasonCode(controlStatus, input.executionOutcome), at: now } : undefined,
        blocking: undefined,
        summary: input.summary,
        results,
        ...(cleanupVerification === undefined ? {} : { cleanupVerification }),
        safeError: input.safeError,
        task: { ...run.task, status: controlStatus, updatedAt: now },
        progress: { ...run.progress, phase: controlStatus, last_event_sequence: terminal.sequence },
        events: appendBoundedEvents(run, [closing, terminal]),
        updatedAt: now
      });
      if (!await this.repository.replaceTestingRunForAttempt(
        updated,
        run.recordVersion,
        reconcile ? 'reconcile' : 'run',
        this.mutationGuard(attempt),
        this.clock()
      )) continue;
      if (this.hasReservationReleaseProof(updated, updatedAttempt)) {
        await this.releaseReservation(attempt.machineId, attempt.id);
      } else {
        await this.updateReservation(attempt, run.task.id, 'residual_blocking', attempt.leaseExpiresAt);
      }
      return updated;
    }
    throw new TalosError('concurrent_update', 'testing run changed too frequently', 409);
  }

  public async resolveCurrentClaim(
    runId: string,
    claimId: string,
    challenge: TestingCurrentClaimChallenge = {
      audience: 'talos-worker',
      request_nonce: newId('testing-observation')
    }
  ): Promise<TestingCurrentClaimEnvelope> {
    const run = await this.requireRun(runId);
    for (const attempt of run.attempts) {
      if (attempt.claimId === claimId) return this.currentClaim(run, attempt, attempt, challenge);
      const prior = attempt.priorClaims.find((candidate) => candidate.claimId === claimId);
      if (prior !== undefined) return this.currentClaim(run, attempt, prior, challenge);
    }
    throw notFound('testing claim not found');
  }

  public async resolveRuntimeCurrentClaim(
    runId: string,
    claimId: string,
    input: unknown
  ): Promise<TestingCurrentClaimEnvelope> {
    const request: TestingCurrentClaimResolveRequest = testingCurrentClaimResolveRequestSchema.parse(input);
    return this.resolveCurrentClaim(runId, claimId, {
      audience: request.audience,
      request_nonce: request.request_nonce
    });
  }

  public async sweep(now = this.clock()): Promise<void> {
    const runs = await this.repository.listTestingRuns();
    for (const candidate of runs) {
      if (isTestingRunCanonicalTerminal(candidate)) continue;
      const run = await this.repository.getTestingRun(candidate.id);
      if (run === undefined || isTestingRunCanonicalTerminal(run)) continue;
      const attempt = this.currentAttempt(run);
      if (terminalStatuses.has(run.controlStatus)) {
        if (
          run.uploadOutcome === 'pending' && attempt !== undefined &&
          Math.min(Date.parse(attempt.leaseExpiresAt), this.operationDeadline(run, attempt)) <= now
        ) await this.expireClosedUpload(run, now);
        continue;
      }
      if (run.controlStatus === 'cancel_requested' && attempt === undefined) {
        await this.closeBeforeAcceptance(run, undefined, 'cancelled_before_acceptance', 'cancelled');
        continue;
      }
      if (run.controlStatus === 'cancel_requested' && attempt?.status === 'reserved') {
        await this.closeBeforeAcceptance(run, attempt, 'cancelled_before_acceptance', 'cancelled');
        continue;
      }
      if (run.controlStatus === 'cancel_requested' && attempt?.status === 'claimed') {
        await this.requireReconcile(run, attempt, 'cancel_requested', now);
        continue;
      }
      if (attempt === undefined && this.runDeadline(run) <= now) {
        await this.closeBeforeAcceptance(run, undefined, 'deadline_exceeded', 'failed');
        continue;
      }
      if (attempt === undefined) continue;
      if (attempt.reconcileDeadline !== undefined && Date.parse(attempt.reconcileDeadline) <= now) {
        await this.abandonReconcile(run, attempt, now);
        continue;
      }
      if (Date.parse(attempt.deadline) <= now) {
        if (attempt.status === 'reserved') {
          await this.closeBeforeAcceptance(run, attempt, 'deadline_exceeded', 'failed');
        } else {
          await this.requireReconcile(run, attempt, 'deadline_exceeded', now);
        }
        continue;
      }
      if (Date.parse(attempt.leaseExpiresAt) <= now) {
        if (attempt.status === 'reserved') {
          await this.releaseBeforeAcceptance(run, attempt, 'lease_expired');
        } else {
          await this.requireReconcile(run, attempt, 'lease_expired', now);
        }
      }
    }
    await this.sweepReservations(now);
  }

  private async claimRun(
    run: TestingRunRecord,
    machine: Machine,
    workerId: string,
    provider: TestingAuthorizationProvider
  ): Promise<TestingClaimResult | undefined> {
    const nowMs = this.clock();
    const now = new Date(nowMs).toISOString();
    const generation = run.task.nextGeneration;
    const attemptId = newId('testing-attempt');
    const claimId = newId('testing-claim');
    const leaseId = newId('testing-lease');
    const leaseToken = newId('testing-lease-token');
    const fenceToken = newId('testing-fence');
    const admissionNonce = newId('testing-admission');
    const leaseExpiresAt = new Date(nowMs + this.leaseSeconds * 1_000).toISOString();
    const deadline = run.deadlineAt;
    if (Date.parse(deadline) <= nowMs) {
      await this.closeBeforeAcceptance(run, undefined, 'deadline_exceeded', 'failed');
      return undefined;
    }
    const leaseClaimBinding = {
      schema: 'talos.testing-lease-claim/v1' as const,
      ref: `talos://testing/claims/${run.id}/${claimId}`,
      expires_at: deadline
    };
    const taskPayloadDigest = computeTestingTaskPayloadDigest({
      schema_version: 'talos.testing-task/v1',
      id: run.task.id,
      kind: 'testing',
      interaction: 'managed',
      qa_run_id: run.id,
      dispatch_attempt_id: attemptId,
      generation,
      machine_id: machine.id,
      worker_id: workerId,
      lease_id: leaseId,
      fence_token: fenceToken,
      admission_nonce: admissionNonce,
      lease_claim: leaseClaimBinding,
      inputs: run.request.inputs,
      runner: run.request.inputs.testing_package,
      policy_ref: run.request.policy_binding.policy,
      budgets_ref: run.request.policy_binding.budgets,
      expected_runtime_capability: run.request.placement_requirements.testing_runtime,
      deadline
    });
    const identity = this.claimIdentityFromValues(run, {
      claimId,
      operation: 'start',
      taskPayloadDigest,
      attemptId,
      machineId: machine.id,
      workerId,
      generation,
      leaseId,
      fenceToken,
      admissionNonce,
      issuedAt: now,
      expiresAt: deadline
    });
    const leaseClaim = {
      ...leaseClaimBinding,
      digest: computeTestingCurrentClaimDigest(identity),
    };
    const attempt: TestingAttemptRecord = {
      id: attemptId,
      claimId,
      operation: 'start',
      taskPayloadDigest,
      generation,
      status: 'reserved',
      machineId: machine.id,
      workerId,
      leaseId,
      leaseTokenHash: hashSecret(leaseToken),
      fenceToken,
      admissionNonce,
      priorClaims: [],
      leaseClaim,
      leaseExpiresAt,
      issuedAt: now,
      deadline,
      createdAt: now,
      updatedAt: now
    };
    const reservation: TestingMachineReservationRecord = {
      machineId: machine.id,
      runId: run.id,
      taskId: run.task.id,
      attemptId,
      generation,
      fenceToken,
      status: 'reserved',
      expiresAt: leaseExpiresAt,
      recordVersion: 1
    };
    if (!await this.repository.createTestingMachineReservation(reservation)) return undefined;

    const reservedEvent = makeEvent(
      run.progress.last_event_sequence + 1,
      'run.reserved',
      now,
      { task_id: run.task.id }
    );
    const reserved: TestingRunRecord = {
      ...run,
      recordVersion: run.recordVersion + 1,
      snapshotVersion: run.snapshotVersion + 1,
      controlStatus: 'reserved',
      task: {
        ...run.task,
        status: 'reserved',
        nextGeneration: generation + 1,
        updatedAt: now
      },
      attempts: [...run.attempts, attempt],
      currentAttemptId: attempt.id,
      attempt: {
        attempt_id: attempt.id,
        task_id: run.task.id,
        generation,
        machine_id: machine.id,
        worker_id: workerId,
        runtime: {
          capability: run.request.placement_requirements.testing_runtime,
          locally_accepted_at: null,
          event_sequence: null
        }
      },
      progress: { ...run.progress, phase: 'reserved', last_event_sequence: reservedEvent.sequence },
      events: appendBoundedEvents(run, [reservedEvent]),
      updatedAt: now
    };
    if (!await this.repository.replaceTestingRunWithinDeadline(reserved, run.recordVersion, 'run', this.clock())) {
      await this.releaseReservation(machine.id, attempt.id);
      return undefined;
    }

    let authorization: TestingTask['local_request_authorization'];
    try {
      authorization = await provider.issueStartAuthorization({
        operation: 'start',
        runId: run.id,
        taskId: run.task.id,
        attemptId: attempt.id,
        machineId: machine.id,
        workerId,
        generation,
        leaseId,
        fenceToken,
        admissionNonce,
        leaseClaim,
        requestDigest: run.requestDigest,
        deadline
      });
      const observedNow = this.clock();
      if (
        Date.parse(authorization.expires_at) <= observedNow ||
        Date.parse(leaseExpiresAt) <= observedNow ||
        Date.parse(deadline) <= observedNow
      ) throw new Error('testing authorization or claim is already expired');
    } catch {
      await this.releaseBeforeAcceptance(reserved, attempt, 'authorization_unavailable');
      throw new TalosError('testing_authorization_unavailable', 'testing start authorization is unavailable', 503);
    }

    const task = testingTaskSchema.parse({
      schema_version: 'talos.testing-task/v1',
      id: run.task.id,
      kind: 'testing',
      interaction: 'managed',
      qa_run_id: run.id,
      dispatch_attempt_id: attempt.id,
      generation,
      machine_id: machine.id,
      worker_id: workerId,
      lease_id: leaseId,
      fence_token: fenceToken,
      admission_nonce: admissionNonce,
      lease_claim: leaseClaim,
      task_payload_digest: taskPayloadDigest,
      inputs: run.request.inputs,
      runner: run.request.inputs.testing_package,
      policy_ref: run.request.policy_binding.policy,
      budgets_ref: run.request.policy_binding.budgets,
      local_request_authorization: authorization,
      expected_runtime_capability: run.request.placement_requirements.testing_runtime,
      deadline
    });
    const claimedAt = new Date(this.clock()).toISOString();
    const claimedAttempt: TestingAttemptRecord = { ...attempt, status: 'claimed', authorization, updatedAt: claimedAt };
    const claimedEvent = makeEvent(
      reserved.progress.last_event_sequence + 1,
      'attempt.claimed',
      claimedAt,
      {
        task_id: run.task.id,
        attempt_id: attempt.id,
        generation,
        machine_id: machine.id
      }
    );
    const claimed = this.withAttempt(reserved, claimedAttempt, {
      recordVersion: reserved.recordVersion + 1,
      snapshotVersion: reserved.snapshotVersion + 1,
      controlStatus: 'claimed',
      task: { ...reserved.task, status: 'claimed', updatedAt: claimedAt },
      progress: { ...reserved.progress, phase: 'claimed', last_event_sequence: claimedEvent.sequence },
      events: appendBoundedEvents(reserved, [claimedEvent]),
      updatedAt: claimedAt
    });
    if (!await this.repository.replaceTestingRunForDispatch(
      claimed,
      reserved.recordVersion,
      'run',
      this.dispatchGuard(attempt, leaseExpiresAt, authorization.expires_at),
      this.clock()
    )) {
      await this.releaseBeforeAcceptance(reserved, attempt, 'claim_conflict');
      throw new TalosError('claim_superseded', 'testing claim was superseded before dispatch', 409);
    }
    await this.updateReservation(claimedAttempt, run.task.id, 'claimed', claimedAttempt.leaseExpiresAt);
    return {
      task,
      lease: { lease_id: leaseId, lease_expires_at: claimedAttempt.leaseExpiresAt },
      lease_token: leaseToken,
      current_claim: this.currentClaim(claimed, claimedAttempt)
    };
  }

  private async transitionAttempt(
    input: TestingAttemptBindingInput,
    expectedStatus: TestingAttemptRecord['status'],
    status: TestingAttemptRecord['status'],
    eventType: 'attempt.local_accepted' | 'run.started'
  ): Promise<TestingCurrentClaimEnvelope> {
    for (let retries = 0; retries < 20; retries += 1) {
      const run = await this.requireRun(input.runId);
      const attempt = this.assertCurrentAttempt(run, input, 'runtime_dispatch');
      const controlStatus = status === 'local_accepted' ? 'local_accepted' : 'running';
      if (attempt.status === status && run.controlStatus === controlStatus) {
        await this.updateReservation(
          attempt,
          run.task.id,
          this.reservationStatus(attempt),
          attempt.leaseExpiresAt
        );
        return this.currentClaim(run, attempt);
      }
      if (attempt.status !== expectedStatus) {
        throw new TalosError('invalid_testing_state', `testing attempt must be ${expectedStatus}`, 409);
      }
      const now = new Date(this.clock()).toISOString();
      const updatedAttempt: TestingAttemptRecord = {
        ...attempt,
        status,
        ...(status === 'local_accepted' ? { localAcceptedAt: now } : {}),
        updatedAt: now
      };
      const event = makeEvent(
        run.progress.last_event_sequence + 1,
        eventType,
        now,
        { attempt_id: attempt.id, generation: attempt.generation }
      );
      const updated = this.withAttempt(run, updatedAttempt, {
        recordVersion: run.recordVersion + 1,
        snapshotVersion: run.snapshotVersion + 1,
        controlStatus,
        executionOutcome: status === 'running' ? 'executing' : run.executionOutcome,
        task: { ...run.task, status: controlStatus, updatedAt: now },
        progress: { ...run.progress, phase: controlStatus, last_event_sequence: event.sequence },
        events: appendBoundedEvents(run, [event]),
        updatedAt: now
      });
      if (!await this.repository.replaceTestingRunForAttempt(
        updated,
        run.recordVersion,
        'run',
        this.mutationGuard(attempt),
        this.clock()
      )) continue;
      await this.updateReservation(
        updatedAttempt,
        run.task.id,
        this.reservationStatus(updatedAttempt),
        updatedAttempt.leaseExpiresAt
      );
      return this.currentClaim(updated, updatedAttempt);
    }
    throw new TalosError('concurrent_update', 'testing run changed too frequently', 409);
  }

  private assertCurrentAttempt(
    run: TestingRunRecord,
    input: TestingAttemptBindingInput,
    effect: string
  ): TestingAttemptRecord {
    const attempt = run.attempts.find((candidate) => candidate.id === input.attemptId);
    if (attempt === undefined || run.currentAttemptId !== attempt.id) throw new TalosError('stale_testing_attempt', 'testing attempt is not current', 409);
    this.assertAttemptIdentity(attempt, input);
    const now = this.clock();
    const reconciling = attempt.operation === 'reconcile';
    const postControlUpload = effect === 'artifact_upload' && terminalStatuses.has(run.controlStatus) &&
      !isTestingRunCanonicalTerminal(run) && run.uploadOutcome === 'pending';
    if (effect === 'reconcile' && !reconciling) {
      throw new TalosError('stale_testing_operation', 'testing reconcile requires a fresh reconcile claim', 409);
    }
    if (['runtime_dispatch', 'terminal_commit'].includes(effect) && reconciling) {
      throw new TalosError('stale_testing_operation', 'reconcile-only credentials cannot start or directly close a Case', 409);
    }
    if (reconciling) {
      if (
        !['reconcile_required', 'cancel_requested'].includes(run.controlStatus) ||
        attempt.status !== 'reconcile_required'
      ) throw new TalosError('testing_reconcile_required', 'testing attempt is not in reconcile state', 409);
      if (this.operationDeadline(run, attempt) <= now) {
        throw new TalosError('testing_reconcile_deadline_exceeded', 'testing reconcile deadline has passed', 409);
      }
    } else if (this.operationDeadline(run, attempt) <= now) {
      throw new TalosError('testing_deadline_exceeded', 'testing deadline has passed', 409);
    }
    if (Date.parse(attempt.leaseExpiresAt) <= now) {
      throw new TalosError('testing_lease_expired', 'testing lease has expired', 409);
    }
    if (terminalStatuses.has(run.controlStatus) && !postControlUpload) {
      throw new TalosError('testing_run_terminal', 'testing run is terminal', 409);
    }
    if (run.controlStatus === 'reconcile_required' && !reconciling) {
      throw new TalosError('testing_reconcile_required', 'testing run requires same-machine reconciliation', 409);
    }
    if (run.controlStatus === 'cancel_requested' && !['heartbeat', 'runtime_cancel', 'terminal_commit', 'reconcile'].includes(effect)) {
      throw new TalosError('cancel_requested', 'testing run has a durable cancel intent', 409);
    }
    if (!activeAttemptStatuses.has(attempt.status) && !reconciling && !postControlUpload) {
      throw new TalosError('stale_testing_attempt', 'testing attempt is no longer active', 409);
    }
    return attempt;
  }

  private assertAttemptIdentity(
    attempt: TestingAttemptRecord,
    input: TestingAttemptBindingInput
  ): void {
    if (attempt.machineId !== input.machineId) throw new TalosError('stale_testing_machine', 'testing machine does not own current attempt', 409);
    if (attempt.workerId !== input.workerId) throw new TalosError('stale_testing_worker', 'testing worker does not own current attempt', 409);
    if (attempt.generation !== input.generation) throw new TalosError('stale_testing_generation', 'testing generation is stale', 409);
    if (attempt.fenceToken !== input.fenceToken) throw new TalosError('stale_testing_fence', 'testing fence is stale', 409);
    const expected = Buffer.from(attempt.leaseTokenHash, 'hex');
    const actual = Buffer.from(hashSecret(input.leaseToken), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new TalosError('invalid_testing_lease', 'testing lease token is invalid', 401);
    }
  }

  private assertHeartbeatProgress(
    run: TestingRunRecord,
    attempt: TestingAttemptRecord,
    progress: TestingHeartbeatProgress | undefined
  ): void {
    if (progress === undefined) return;
    if (
      progress.runtime_event_sequence < (attempt.runtimeEventSequence ?? 0) ||
      progress.completed_cases < run.progress.completed_cases ||
      progress.total_cases < run.progress.total_cases
    ) {
      throw new TalosError('stale_testing_progress', 'testing Runtime progress cannot move backwards', 409);
    }
  }

  private currentClaim(
    run: TestingRunRecord,
    attempt: TestingAttemptRecord,
    claim: TestingAttemptClaimRecord = attempt,
    challenge: TestingCurrentClaimChallenge = {
      audience: 'talos-worker',
      request_nonce: newId('testing-observation')
    }
  ): TestingCurrentClaimEnvelope {
    const now = this.clock();
    const currentIdentity = this.claimIdentity(attempt, claim, run);
    const sameClaim = attempt.claimId === claim.claimId;
    const operationDeadline = claim.operation === 'reconcile'
      ? Date.parse(run.reconcileDeadlineAt ?? attempt.reconcileDeadline ?? claim.leaseClaim.expires_at)
      : Date.parse(run.deadlineAt);
    const postControlUpload = terminalStatuses.has(run.controlStatus) &&
      !isTestingRunCanonicalTerminal(run) && run.uploadOutcome === 'pending';
    const operationCurrent = claim.operation === 'start'
      ? (activeAttemptStatuses.has(attempt.status) &&
          run.controlStatus !== 'cancel_requested' &&
          run.controlStatus !== 'reconcile_required') || postControlUpload
      : (['acceptance_unknown', 'reconcile_required'].includes(attempt.status) &&
          ['cancel_requested', 'reconcile_required'].includes(run.controlStatus)) || postControlUpload;
    const current = sameClaim &&
      run.currentAttemptId === attempt.id &&
      operationCurrent &&
      !isTestingRunCanonicalTerminal(run) &&
      Date.parse(claim.leaseExpiresAt) > now &&
      operationDeadline > now;
    const status = current
      ? 'current'
      : isTestingRunCanonicalTerminal(run)
        ? 'terminal'
        : !sameClaim
          ? 'superseded'
        : run.controlStatus === 'cancel_requested'
          ? 'cancel_requested'
          : run.controlStatus === 'reconcile_required'
            ? 'reconcile_required'
            : run.currentAttemptId !== undefined && run.currentAttemptId !== attempt.id
              ? 'superseded'
            : Date.parse(claim.leaseExpiresAt) <= now || operationDeadline <= now
              ? 'expired'
              : 'superseded';
    const validUntil = current
      ? Math.min(now + 5_000, Date.parse(claim.leaseExpiresAt), operationDeadline)
      : now + 5_000;
    const core = testingCurrentClaimEnvelopeCoreSchema.parse({
      schema_version: 'talos.testing-current-claim/v1',
      claim: currentIdentity,
      claim_digest: computeTestingCurrentClaimDigest(currentIdentity),
      audience: challenge.audience,
      request_nonce: challenge.request_nonce,
      is_current: current,
      status,
      lease_expires_at: claim.leaseExpiresAt,
      observed_at: new Date(now).toISOString(),
      valid_until: new Date(validUntil).toISOString(),
      key_id: this.claimKeyId
    });
    const signature = sign(null, Buffer.from(canonicalJson(core)), this.claimSigningKey).toString('base64url');
    return testingCurrentClaimEnvelopeSchema.parse({ ...core, signature: `ed25519:${signature}` });
  }

  private claimIdentity(
    attempt: TestingAttemptRecord,
    claim: TestingAttemptClaimRecord,
    run: TestingRunRecord
  ): TestingCurrentClaimIdentity {
    return this.claimIdentityFromValues(run, {
      claimId: claim.claimId,
      operation: claim.operation,
      taskPayloadDigest: claim.taskPayloadDigest,
      attemptId: attempt.id,
      machineId: attempt.machineId,
      workerId: claim.workerId,
      generation: attempt.generation,
      leaseId: claim.leaseId,
      fenceToken: attempt.fenceToken,
      admissionNonce: attempt.admissionNonce,
      issuedAt: claim.issuedAt,
      expiresAt: claim.leaseClaim.expires_at
    });
  }

  private claimIdentityFromValues(
    run: TestingRunRecord,
    values: {
      readonly claimId: string;
      readonly operation: 'start' | 'reconcile';
      readonly taskPayloadDigest: string;
      readonly attemptId: string;
      readonly machineId: string;
      readonly workerId: string;
      readonly generation: number;
      readonly leaseId: string;
      readonly fenceToken: string;
      readonly admissionNonce: string;
      readonly issuedAt: string;
      readonly expiresAt: string;
    }
  ): TestingCurrentClaimIdentity {
    return {
      schema_version: 'talos.testing-claim-identity/v1',
      operation: values.operation,
      claim_id: values.claimId,
      run_id: run.id,
      task_id: run.task.id,
      attempt_id: values.attemptId,
      machine_id: values.machineId,
      worker_id: values.workerId,
      generation: values.generation,
      lease_id: values.leaseId,
      fence_token: values.fenceToken,
      admission_nonce: values.admissionNonce,
      task_payload_digest: values.taskPayloadDigest,
      issued_at: values.issuedAt,
      expires_at: values.expiresAt
    };
  }

  private async machineEligible(machine: Machine, run: TestingRunRecord): Promise<boolean> {
    const tags = machine.tags;
    if (
      machine.poolId !== run.placement.poolId ||
      machine.activeLeases >= machine.capacity ||
      tags.testing_runtime !== run.placement.capability.testingRuntime ||
      tags.testing_task_contract !== run.placement.capability.taskContract ||
      tags.testing_backend !== run.placement.capability.backend ||
      tags.browser !== run.placement.capability.browser ||
      tags.os !== run.placement.capability.os ||
      tags.arch !== run.placement.capability.arch ||
      tags.headed_display !== run.placement.capability.headedDisplay ||
      tags.runner_package_id !== run.placement.testingPackage.packageId ||
      tags.runner_package_version !== run.placement.testingPackage.version ||
      tags.runner_package_digest !== run.placement.testingPackage.digest
    ) return false;
    const pool = await this.repository.getPool(machine.poolId);
    return pool !== undefined && poolVisible(pool, run.userId, run.requesterGroups);
  }

  private async releaseBeforeAcceptance(
    run: TestingRunRecord,
    attempt: TestingAttemptRecord,
    reason: 'lease_expired' | 'authorization_unavailable' | 'claim_conflict'
  ): Promise<void> {
    for (let retries = 0; retries < 20; retries += 1) {
      const current = retries === 0 ? run : await this.requireRun(run.id);
      const currentAttempt = current.attempts.find((candidate) => candidate.id === attempt.id);
      if (currentAttempt === undefined || current.currentAttemptId !== attempt.id) {
        await this.releaseReservation(attempt.machineId, attempt.id);
        return;
      }
      if (currentAttempt.status !== 'reserved') return;
      if (terminalStatuses.has(current.controlStatus)) {
        await this.releaseReservation(attempt.machineId, attempt.id);
        return;
      }
      if (current.controlStatus === 'cancel_requested') return;
      const now = new Date(this.clock()).toISOString();
      const event = makeEvent(
        current.progress.last_event_sequence + 1,
        'attempt.released',
        now,
        { attempt_id: currentAttempt.id, generation: currentAttempt.generation, reason_code: reason }
      );
      const released: TestingAttemptRecord = {
        ...currentAttempt,
        status: 'released',
        reservationCancellationReceipt: {
          schemaVersion: 'talos.testing-reservation-cancellation-receipt/v1',
          reason,
          releasedAt: now
        },
        updatedAt: now
      };
      const updated = this.withAttempt(current, released, {
        recordVersion: current.recordVersion + 1,
        snapshotVersion: current.snapshotVersion + 1,
        controlStatus: 'submitted',
        task: { ...current.task, status: 'submitted', updatedAt: now },
        currentAttemptId: undefined,
        attempt: undefined,
        progress: { ...current.progress, phase: 'submitted', last_event_sequence: event.sequence },
        events: appendBoundedEvents(current, [event]),
        updatedAt: now
      });
      if (!await this.repository.replaceTestingRun(updated, current.recordVersion)) continue;
      await this.releaseReservation(currentAttempt.machineId, currentAttempt.id);
      return;
    }
    throw new TalosError('concurrent_update', 'testing run changed too frequently while releasing attempt', 409);
  }

  private async closeBeforeAcceptance(
    run: TestingRunRecord,
    attempt: TestingAttemptRecord | undefined,
    reason: 'cancelled_before_acceptance' | 'deadline_exceeded',
    status: 'cancelled' | 'failed'
  ): Promise<void> {
    const now = new Date(this.clock()).toISOString();
    const events: TestingRunEvent[] = [];
    let sequence = run.progress.last_event_sequence;
    if (attempt !== undefined) {
      events.push(makeEvent(++sequence, 'attempt.released', now, {
        attempt_id: attempt.id,
        generation: attempt.generation,
        reason_code: reason
      }));
    }
    events.push(status === 'cancelled'
      ? makeEvent(++sequence, 'run.cancelled', now, { cleanup_outcome: 'unobserved' })
      : makeEvent(++sequence, 'run.failed', now, { error_code: 'deadline_exceeded' }));
    const terminalAttempt = attempt === undefined
      ? undefined
      : {
          ...attempt,
          status,
          reservationCancellationReceipt: {
            schemaVersion: 'talos.testing-reservation-cancellation-receipt/v1' as const,
            reason,
            releasedAt: now
          },
          updatedAt: now
        } as TestingAttemptRecord;
    const base = terminalAttempt === undefined ? run : this.withAttempt(run, terminalAttempt, {});
    const updated: TestingRunRecord = {
      ...base,
      recordVersion: run.recordVersion + 1,
      snapshotVersion: run.snapshotVersion + 1,
      controlStatus: status,
      executionOutcome: 'not_started',
      cleanupOutcome: 'unobserved',
      terminalReason: {
        code: status === 'cancelled' ? 'cancelled' : 'deadline_exceeded',
        at: now
      },
      blocking: undefined,
      task: { ...run.task, status, updatedAt: now },
      safeError: status === 'failed'
        ? { code: 'deadline_exceeded', message: 'testing run deadline expired before local acceptance', retryable: false }
        : run.safeError,
      progress: { ...run.progress, phase: status, last_event_sequence: sequence },
      events: appendBoundedEvents(run, events),
      updatedAt: now
    };
    if (await this.repository.replaceTestingRun(updated, run.recordVersion) && attempt !== undefined) {
      await this.releaseReservation(attempt.machineId, attempt.id);
    }
  }

  private async requireReconcile(
    run: TestingRunRecord,
    attempt: TestingAttemptRecord,
    reasonCode: 'lease_expired' | 'deadline_exceeded' | 'cancel_requested',
    nowMs: number
  ): Promise<void> {
    if (attempt.status === 'acceptance_unknown' || attempt.status === 'reconcile_required') return;
    const now = new Date(nowMs).toISOString();
    const reconcileDeadline = new Date(nowMs + TESTING_RECONCILE_WINDOW_MS).toISOString();
    const event = makeEvent(
      run.progress.last_event_sequence + 1,
      'run.reconcile_required',
      now,
      { attempt_id: attempt.id, reason_code: reasonCode }
    );
    const reconciling: TestingAttemptRecord = {
      ...attempt,
      status: attempt.localAcceptedAt === undefined ? 'acceptance_unknown' : 'reconcile_required',
      reconcileDeadline,
      updatedAt: now
    };
    const controlStatus = run.controlStatus === 'cancel_requested' ? 'cancel_requested' : 'reconcile_required';
    const updated = this.withAttempt(run, reconciling, {
      recordVersion: run.recordVersion + 1,
      snapshotVersion: run.snapshotVersion + 1,
      controlStatus,
      reconcileDeadlineAt: reconcileDeadline,
      blocking: {
        reason_code: reasonCode,
        retry_at: now,
        deadline_at: reconcileDeadline,
        next_action: 'reconcile'
      },
      task: { ...run.task, status: controlStatus, updatedAt: now },
      progress: { ...run.progress, phase: controlStatus, last_event_sequence: event.sequence },
      events: appendBoundedEvents(run, [event]),
      updatedAt: now
    });
    if (await this.repository.replaceTestingRun(updated, run.recordVersion)) {
      await this.updateReservation(reconciling, run.task.id, 'reconcile_required', reconcileDeadline);
    }
  }

  private async abandonReconcile(
    run: TestingRunRecord,
    attempt: TestingAttemptRecord,
    nowMs: number
  ): Promise<void> {
    const now = new Date(nowMs).toISOString();
    const event = makeEvent(
      run.progress.last_event_sequence + 1,
      'run.abandoned',
      now,
      { reason_code: 'reconcile_deadline_exceeded' }
    );
    const reconcileClosure = this.reconcileClosure(run, attempt, now);
    const abandoned: TestingAttemptRecord = { ...attempt, status: 'abandoned', updatedAt: now };
    const updated = this.withAttempt(run, abandoned, {
      recordVersion: run.recordVersion + 1,
      snapshotVersion: run.snapshotVersion + 1,
      controlStatus: 'abandoned',
      executionOutcome: 'lost_or_inconclusive',
      cleanupOutcome: 'unobserved',
      terminalReason: { code: 'reconcile_deadline_exceeded', at: now },
      blocking: undefined,
      task: { ...run.task, status: 'abandoned', updatedAt: now },
      safeError: { code: 'reconcile_deadline_exceeded', message: 'same-machine reconciliation did not converge', retryable: false },
      progress: { ...run.progress, phase: 'abandoned', last_event_sequence: event.sequence },
      events: appendBoundedEvents(run, [event]),
      reconcileClosure,
      updatedAt: now
    });
    if (await this.repository.replaceTestingRun(updated, run.recordVersion)) {
      await this.updateReservation(abandoned, run.task.id, 'residual_blocking', attempt.reconcileDeadline ?? now);
    }
  }

  private async expireClosedUpload(
    run: TestingRunRecord,
    nowMs: number
  ): Promise<void> {
    if (
      !terminalStatuses.has(run.controlStatus) || run.uploadOutcome !== 'pending' ||
      run.executionOutcome === 'executing' || run.evidenceOutcome === 'staging' ||
      run.cleanupOutcome === 'pending'
    ) return;
    const now = new Date(nowMs).toISOString();
    const event = makeEvent(
      run.progress.last_event_sequence + 1,
      'run.terminal_projection_updated',
      now,
      {
        evidence_outcome: run.evidenceOutcome,
        upload_outcome: 'upload_expired',
        cleanup_outcome: run.cleanupOutcome
      }
    );
    const reasonCode = run.controlStatus === 'abandoned'
      ? 'reconcile_deadline_exceeded' as const
      : this.terminalReasonCode(run.controlStatus as 'completed' | 'failed' | 'cancelled', run.executionOutcome);
    await this.repository.replaceTestingRun({
      ...run,
      recordVersion: run.recordVersion + 1,
      snapshotVersion: run.snapshotVersion + 1,
      uploadOutcome: 'upload_expired',
      terminalReason: run.terminalReason ?? { code: reasonCode, at: now },
      progress: { ...run.progress, last_event_sequence: event.sequence },
      events: appendBoundedEvents(run, [event]),
      updatedAt: now
    }, run.recordVersion);
  }

  private async replayTerminal(
    run: TestingRunRecord,
    input: TestingTerminalCommit,
    expectedOperation: 'start' | 'reconcile'
  ): Promise<TestingRunRecord | undefined> {
    const attempt = run.attempts.find((candidate) => candidate.id === input.attemptId);
    if (attempt === undefined || run.currentAttemptId !== attempt.id) {
      throw new TalosError('stale_testing_attempt', 'testing attempt is not current', 409);
    }
    this.assertAttemptIdentity(attempt, input);
    if (attempt.operation !== expectedOperation) {
      throw new TalosError('stale_testing_operation', `terminal replay requires ${expectedOperation} credentials`, 409);
    }
    const results = input.results === undefined ? undefined : testingTerminalRefsSchema.parse(input.results);
    if (results !== undefined) this.assertTerminalBinding(run, attempt, results);
    this.assertTerminalOutcomes(input, results);
    const controlStatus = run.controlStatus === 'cancelled' || run.controlStatus === 'abandoned'
      ? run.controlStatus
      : input.controlStatus;
    const existing = {
      control_status: run.controlStatus,
      execution_outcome: run.executionOutcome,
      evidence_outcome: run.evidenceOutcome,
      upload_outcome: run.uploadOutcome,
      cleanup_outcome: run.cleanupOutcome,
      summary: run.summary ?? null,
      results: run.results ?? null,
      safe_error: run.safeError ?? null
    };
    const requested = {
      control_status: controlStatus,
      execution_outcome: input.executionOutcome,
      evidence_outcome: input.evidenceOutcome,
      upload_outcome: input.uploadOutcome,
      cleanup_outcome: input.cleanupOutcome,
      summary: input.summary === undefined ? existing.summary : input.summary,
      results: results ?? null,
      safe_error: input.safeError === undefined ? existing.safe_error : input.safeError
    };
    if (canonicalJson(existing) !== canonicalJson(requested)) {
      this.assertTerminalAdvance(run, input, results, controlStatus);
      if (!this.isCleanupOnlyRepair(run, input, results)) {
        const nowMs = this.clock();
        if (Date.parse(attempt.leaseExpiresAt) <= nowMs) {
          throw new TalosError('testing_lease_expired', 'testing lease has expired', 409);
        }
        if (this.operationDeadline(run, attempt) <= nowMs) {
          throw new TalosError(
            attempt.operation === 'reconcile' ? 'testing_reconcile_deadline_exceeded' : 'testing_deadline_exceeded',
            'testing terminal projection authority has expired',
            409
          );
        }
      }
      await this.verifyExternalSchemaProofs(results);
      const cleanupVerification = await this.verifyCleanupProof(run, attempt, input.cleanupOutcome, results);
      const now = new Date(this.clock()).toISOString();
      const event = makeEvent(
        run.progress.last_event_sequence + 1,
        'run.terminal_projection_updated',
        now,
        {
          evidence_outcome: input.evidenceOutcome,
          upload_outcome: input.uploadOutcome,
          cleanup_outcome: input.cleanupOutcome
        }
      );
      const advanced = {
        ...run,
        recordVersion: run.recordVersion + 1,
        snapshotVersion: run.snapshotVersion + 1,
        evidenceOutcome: input.evidenceOutcome,
        uploadOutcome: input.uploadOutcome,
        cleanupOutcome: input.cleanupOutcome,
        terminalReason: run.terminalReason ?? (testingOutcomesSettled({
          executionOutcome: input.executionOutcome,
          evidenceOutcome: input.evidenceOutcome,
          uploadOutcome: input.uploadOutcome,
          cleanupOutcome: input.cleanupOutcome
        })
          ? {
              code: controlStatus === 'abandoned'
                ? 'reconcile_deadline_exceeded' as const
                : this.terminalReasonCode(controlStatus, input.executionOutcome),
              at: now
            }
          : undefined),
        results,
        ...(cleanupVerification === undefined
          ? { cleanupVerification: run.cleanupVerification }
          : { cleanupVerification }),
        progress: { ...run.progress, last_event_sequence: event.sequence },
        events: appendBoundedEvents(run, [event]),
        updatedAt: now
      };
      const releasesReservation = this.hasReservationReleaseProof(advanced, attempt);
      if (!releasesReservation) {
        const reservation = await this.repository.getTestingMachineReservation(attempt.machineId);
        if (reservation?.attemptId !== attempt.id) {
          throw new TalosError('testing_reservation_lost', 'terminal testing reservation is missing', 409);
        }
      }
      if (!await this.repository.replaceTestingRun(advanced, run.recordVersion)) return undefined;
      if (releasesReservation) {
        await this.releaseReservation(attempt.machineId, attempt.id);
      } else {
        const reservation = await this.repository.getTestingMachineReservation(attempt.machineId);
        if (reservation?.attemptId !== attempt.id) {
          throw new TalosError('testing_reservation_lost', 'terminal testing reservation is missing', 409);
        }
        if (reservation.status !== 'residual_blocking') {
          await this.updateReservation(attempt, run.task.id, 'residual_blocking', reservation.expiresAt);
        }
      }
      return advanced;
    }
    if (this.hasReservationReleaseProof(run, attempt)) {
      await this.releaseReservation(attempt.machineId, attempt.id);
    } else {
      const reservation = await this.repository.getTestingMachineReservation(attempt.machineId);
      if (reservation?.attemptId !== attempt.id) {
        throw new TalosError('testing_reservation_lost', 'terminal testing reservation is missing', 409);
      }
      if (reservation.status !== 'residual_blocking') {
        await this.updateReservation(attempt, run.task.id, 'residual_blocking', reservation.expiresAt);
      }
    }
    return run;
  }

  private isCleanupOnlyRepair(
    run: TestingRunRecord,
    input: TestingTerminalCommit,
    results: TestingTerminalRefs | undefined
  ): boolean {
    return run.evidenceOutcome === input.evidenceOutcome && run.uploadOutcome === input.uploadOutcome &&
      run.cleanupOutcome !== input.cleanupOutcome &&
      canonicalJson(run.results?.case_result_set ?? null) === canonicalJson(results?.case_result_set ?? null) &&
      canonicalJson(run.results?.evidence_manifest ?? null) === canonicalJson(results?.evidence_manifest ?? null);
  }

  private assertTerminalBinding(
    run: TestingRunRecord,
    attempt: TestingAttemptRecord,
    results: TestingTerminalRefs
  ): void {
    const binding = results.binding;
    if (
      binding.run_id !== run.id ||
      binding.task_id !== run.task.id ||
      binding.attempt_id !== attempt.id ||
      binding.generation !== attempt.generation ||
      binding.fence_token !== attempt.fenceToken
    ) throw new TalosError('stale_terminal_binding', 'terminal references are bound to another attempt', 409);
  }

  private assertTerminalOutcomes(
    input: TestingTerminalCommit,
    results: TestingTerminalRefs | undefined
  ): asserts input is SettledTestingTerminalCommit {
    if (
      input.executionOutcome === 'executing' ||
      input.evidenceOutcome === 'staging' ||
      input.cleanupOutcome === 'pending' ||
      input.cleanupOutcome === 'unobserved'
    ) {
      throw new TalosError('invalid_terminal_projection', 'testing terminal outcomes are not settled', 409);
    }
    const summary = input.summary === undefined ? undefined : testingRunSummarySchema.parse(input.summary);
    if (input.executionOutcome === 'all_skipped' && summary?.all_skipped !== true) {
      throw new TalosError('invalid_terminal_projection', 'all-skipped execution requires exact all-skipped summary counts', 409);
    }
    if (input.executionOutcome === 'passed' && summary?.all_skipped === true) {
      throw new TalosError('invalid_terminal_projection', 'all-skipped execution cannot be passed', 409);
    }
    if (['passed', 'failed', 'blocked', 'error', 'all_skipped'].includes(input.executionOutcome)) {
      if (summary === undefined || results?.case_result_set === undefined) {
        throw new TalosError(
          'terminal_case_results_required',
          'settled Runner execution requires bounded summary and exact CaseResultSet reference',
          409
        );
      }
    }
    if (['complete', 'partial'].includes(input.evidenceOutcome) && results?.evidence_manifest === undefined) {
      throw new TalosError(
        'terminal_evidence_manifest_required',
        'settled evidence requires an exact EvidenceManifest reference',
        409
      );
    }
    if (results?.cleanup_receipt === undefined) {
      throw new TalosError(
        'cleanup_proof_required',
        'observed cleanup outcome requires an exact attempt-bound CleanupReceipt reference',
        409
      );
    }
  }

  private terminalReasonCode(
    controlStatus: 'completed' | 'failed' | 'cancelled',
    executionOutcome: TestingExecutionOutcome
  ): TestingTerminalReasonCode {
    if (controlStatus === 'cancelled') return 'cancelled';
    if (executionOutcome === 'timed_out') return 'execution_timed_out';
    if (executionOutcome === 'all_skipped') return 'execution_all_skipped';
    if (executionOutcome === 'blocked') return 'terminal_blocked';
    if (controlStatus === 'failed') return 'control_failed';
    return 'execution_settled';
  }

  private assertTerminalAdvance(
    run: TestingRunRecord,
    input: TestingTerminalCommit,
    results: TestingTerminalRefs | undefined,
    controlStatus: TestingRunRecord['controlStatus']
  ): void {
    if (
      run.controlStatus !== controlStatus || run.executionOutcome !== input.executionOutcome ||
      (input.summary !== undefined && canonicalJson(run.summary ?? null) !== canonicalJson(input.summary)) ||
      (input.safeError !== undefined && canonicalJson(run.safeError ?? null) !== canonicalJson(input.safeError)) ||
      !isEvidenceAdvance(run.evidenceOutcome, input.evidenceOutcome) ||
      !isUploadAdvance(run.uploadOutcome, input.uploadOutcome) ||
      !isCleanupAdvance(run.cleanupOutcome, input.cleanupOutcome) ||
      !areTerminalRefsMonotonic(run.results, results)
    ) throw new TalosError('terminal_commit_conflict', 'testing terminal projection cannot advance monotonically', 409);
  }

  private async verifyCleanupProof(
    run: TestingRunRecord,
    attempt: TestingAttemptRecord,
    cleanupOutcome: TestingCleanupOutcome,
    results: TestingTerminalRefs | undefined
  ): Promise<TestingCleanupVerificationRecord | undefined> {
    if (cleanupOutcome === 'unobserved') return undefined;
    if (cleanupOutcome === 'pending') {
      throw new TalosError('invalid_terminal_projection', 'terminal cleanup cannot remain pending', 409);
    }
    const receipt = results?.cleanup_receipt;
    if (receipt === undefined) {
      throw new TalosError(
        'cleanup_proof_required',
        'terminal cleanup outcome requires an exact attempt-bound cleanup receipt',
        409
      );
    }
    const existing = run.cleanupVerification;
    if (
      existing?.receiptRef === receipt.ref && existing.receiptDigest === receipt.digest &&
      existing.binding.runId === run.id && existing.binding.taskId === run.task.id &&
      existing.binding.attemptId === attempt.id && existing.binding.generation === attempt.generation &&
      existing.binding.fenceToken === attempt.fenceToken &&
      existing.disposition === cleanupVerificationDisposition(cleanupOutcome)
    ) return existing;
    const verifier = this.options.cleanupReceiptVerifier;
    if (verifier === undefined) {
      throw new TalosError('cleanup_verifier_unavailable', 'cleanup receipt verifier is unavailable', 503);
    }
    let verification: TestingCleanupReceiptVerification | undefined;
    try {
      verification = await verifier.verifyCleanupReceipt(receipt, {
        runId: run.id,
        taskId: run.task.id,
        attemptId: attempt.id,
        machineId: attempt.machineId,
        generation: attempt.generation,
        fenceToken: attempt.fenceToken,
        cleanupOutcome
      });
    } catch {
      throw new TalosError('cleanup_verifier_unavailable', 'cleanup receipt verifier is unavailable', 503);
    }
    const parsedVerification = testingCleanupReceiptVerificationSchema.safeParse(verification);
    const expectedDisposition = cleanupVerificationDisposition(cleanupOutcome);
    if (
      !parsedVerification.success ||
      parsedVerification.data.receiptRef !== receipt.ref || parsedVerification.data.receiptDigest !== receipt.digest ||
      parsedVerification.data.disposition !== expectedDisposition
    ) throw new TalosError('invalid_cleanup_receipt', 'cleanup receipt authority verification failed', 401);
    return {
      ...parsedVerification.data,
      binding: {
        runId: run.id,
        taskId: run.task.id,
        attemptId: attempt.id,
        generation: attempt.generation,
        fenceToken: attempt.fenceToken
      }
    };
  }

  private async verifyExternalSchemaProofs(results: TestingTerminalRefs | undefined): Promise<void> {
    if (results === undefined) return;
    const authority = this.options.externalSchemaAuthority;
    const capabilities = await resolveTestingExternalSchemaCapabilities(authority);
    const references = [
      ['case_result_set', 'testing-packages', results.case_result_set],
      ['evidence_manifest', 'local-qa-runtime', results.evidence_manifest],
      ['cleanup_receipt', 'local-qa-runtime', results.cleanup_receipt]
    ] as const;
    for (const [contract, owner, reference] of references) {
      if (reference === undefined) continue;
      const capability = capabilities.find((candidate) => candidate.contract === contract && candidate.owner === owner);
      if (authority === undefined || capability?.status !== 'available') {
        throw new TalosError(
          'external_schema_authority_unavailable',
          'upstream schema authority is unavailable for terminal reference verification',
          503
        );
      }
      let verification: TestingExternalSchemaReferenceVerification | undefined;
      try {
        verification = await authority.verifyTerminalReference(
          contract as TestingTerminalSchemaContract,
          owner as TestingExternalSchemaOwner,
          reference
        );
      } catch {
        throw new TalosError(
          'external_schema_authority_unavailable',
          'upstream schema authority is unavailable for terminal reference verification',
          503
        );
      }
      const parsed = testingExternalSchemaReferenceVerificationSchema.safeParse(verification);
      if (
        !parsed.success ||
        parsed.data.contract !== contract || parsed.data.owner !== owner ||
        parsed.data.referenceSchema !== reference.schema ||
        parsed.data.schemaDigest !== reference.schema_digest ||
        parsed.data.artifactRef !== reference.ref || parsed.data.artifactDigest !== reference.digest ||
        !capability.schemas.some((identity) =>
          identity.schema_id === parsed.data.schemaId &&
          identity.version === parsed.data.version &&
          identity.digest === parsed.data.schemaDigest)
      ) {
        throw new TalosError(
          'invalid_external_schema_reference',
          'terminal reference schema identity was not verified by its owning authority',
          401
        );
      }
    }
  }

  private hasReservationReleaseProof(run: TestingRunRecord, attempt: TestingAttemptRecord): boolean {
    if (!['complete', 'not_required'].includes(run.cleanupOutcome)) return false;
    if (attempt.reservationCancellationReceipt !== undefined) return true;
    const cleanupReceipt = run.results?.cleanup_receipt;
    const verification = run.cleanupVerification;
    if (
      cleanupReceipt === undefined || verification === undefined ||
      verification.schemaVersion !== 'talos.testing-cleanup-receipt-verification/v1' ||
      verification.receiptRef !== cleanupReceipt.ref || verification.receiptDigest !== cleanupReceipt.digest ||
      verification.disposition !== (run.cleanupOutcome === 'complete' ? 'cleanup_complete' : 'cleanup_not_required') ||
      verification.binding.runId !== run.id || verification.binding.taskId !== run.task.id ||
      verification.binding.attemptId !== attempt.id || verification.binding.generation !== attempt.generation ||
      verification.binding.fenceToken !== attempt.fenceToken
    ) return false;
    try {
      this.assertTerminalBinding(run, attempt, run.results as TestingTerminalRefs);
      return true;
    } catch {
      return false;
    }
  }

  private async updateReservation(
    attempt: TestingAttemptRecord,
    taskId: string,
    status: TestingMachineReservationRecord['status'],
    expiresAt: string
  ): Promise<void> {
    for (let retries = 0; retries < 20; retries += 1) {
      const current = await this.repository.getTestingMachineReservation(attempt.machineId);
      if (
        current?.attemptId !== attempt.id ||
        current.taskId !== taskId ||
        current.generation !== attempt.generation ||
        current.fenceToken !== attempt.fenceToken
      ) {
        throw new TalosError('testing_reservation_lost', 'testing machine reservation is not owned by the current attempt', 409);
      }
      if (await this.repository.replaceTestingMachineReservation({
        ...current,
        taskId,
        status,
        expiresAt,
        recordVersion: current.recordVersion + 1
      }, current.recordVersion)) return;
    }
    throw new TalosError('concurrent_update', 'testing reservation changed too frequently', 409);
  }

  private reservationStatus(attempt: TestingAttemptRecord): TestingMachineReservationRecord['status'] {
    if (attempt.status === 'local_accepted' || attempt.status === 'running' || attempt.status === 'closing') return 'local_accepted';
    if (attempt.status === 'reconcile_required') return 'reconcile_required';
    return attempt.status === 'reserved' ? 'reserved' : 'claimed';
  }

  private currentAttempt(run: TestingRunRecord): TestingAttemptRecord | undefined {
    return run.currentAttemptId === undefined
      ? undefined
      : run.attempts.find((attempt) => attempt.id === run.currentAttemptId);
  }

  private claimRecord(attempt: TestingAttemptRecord): TestingAttemptClaimRecord {
    return {
      claimId: attempt.claimId,
      operation: attempt.operation,
      taskPayloadDigest: attempt.taskPayloadDigest,
      workerId: attempt.workerId,
      leaseId: attempt.leaseId,
      leaseTokenHash: attempt.leaseTokenHash,
      leaseClaim: attempt.leaseClaim,
      ...(attempt.authorization === undefined ? {} : { authorization: attempt.authorization }),
      leaseExpiresAt: attempt.leaseExpiresAt,
      issuedAt: attempt.issuedAt
    };
  }

  private withAttempt(
    run: TestingRunRecord,
    attempt: TestingAttemptRecord,
    overrides: Partial<TestingRunRecord>
  ): TestingRunRecord {
    return {
      ...run,
      ...overrides,
      attempts: run.attempts.map((candidate) => candidate.id === attempt.id ? attempt : candidate)
    };
  }

  private async requireRun(runId: string): Promise<TestingRunRecord> {
    const run = await this.repository.getTestingRun(runId);
    if (run === undefined) throw notFound('testing run not found');
    return run;
  }

  private runDeadline(run: TestingRunRecord): number {
    return Date.parse(run.deadlineAt);
  }

  private deadlineKind(attempt: TestingAttemptRecord): 'run' | 'reconcile' {
    return attempt.operation === 'reconcile' ? 'reconcile' : 'run';
  }

  private mutationGuard(attempt: TestingAttemptRecord): TestingAttemptMutationGuard {
    return {
      attemptId: attempt.id,
      operation: attempt.operation,
      generation: attempt.generation,
      fenceToken: attempt.fenceToken,
      leaseId: attempt.leaseId,
      leaseExpiresAt: attempt.leaseExpiresAt
    };
  }

  private dispatchGuard(
    attempt: TestingAttemptRecord,
    dispatchLeaseExpiresAt: string,
    dispatchAuthorizationExpiresAt: string
  ): TestingAttemptDispatchGuard {
    return {
      ...this.mutationGuard(attempt),
      status: attempt.status,
      dispatchLeaseExpiresAt,
      dispatchAuthorizationExpiresAt
    };
  }

  private operationDeadline(run: TestingRunRecord, attempt: TestingAttemptRecord): number {
    if (attempt.operation === 'start') return this.runDeadline(run);
    const reconcileDeadline = run.reconcileDeadlineAt ?? attempt.reconcileDeadline;
    if (reconcileDeadline === undefined) {
      throw new TalosError('testing_reconcile_deadline_missing', 'testing reconcile deadline is not durable', 409);
    }
    return Date.parse(reconcileDeadline);
  }

  private reconcileClosure(
    run: TestingRunRecord,
    attempt: TestingAttemptRecord,
    decidedAt: string
  ): TestingReconcileClosure {
    const reconcileDeadline = run.reconcileDeadlineAt ?? attempt.reconcileDeadline;
    if (reconcileDeadline === undefined) {
      throw new TalosError('testing_reconcile_deadline_missing', 'testing reconcile deadline is not durable', 409);
    }
    const snapshotCore = {
      schema_version: 'talos.testing-run-snapshot/v1' as const,
      run_id: run.id,
      request_id: run.request.request_id,
      client_correlation_id: run.request.client_correlation_id,
      authenticated_transport: run.authenticatedTransport,
      inputs: run.request.inputs,
      snapshot_version: run.snapshotVersion,
      snapshot_ref: `talos://testing/runs/${run.id}/snapshots/${run.snapshotVersion}`,
      control_status: run.controlStatus,
      execution_outcome: run.executionOutcome,
      evidence_outcome: run.evidenceOutcome,
      upload_outcome: run.uploadOutcome,
      cleanup_outcome: run.cleanupOutcome,
      terminal: isTestingRunCanonicalTerminal(run),
      terminal_reason: run.terminalReason ?? null,
      blocking: run.blocking ?? null,
      attempt: projectTestingRunAttempt(run) ?? null,
      progress: run.progress,
      summary: run.summary ?? null,
      results: run.results ?? null,
      safe_error: run.safeError ?? null,
      created_at: run.createdAt,
      updated_at: run.updatedAt
    };
    const receiptRefs = [
      run.results?.case_result_set,
      run.results?.evidence_manifest,
      run.results?.cleanup_receipt
    ].filter((reference): reference is NonNullable<typeof reference> => reference !== undefined)
      .map((reference) => ({ ref: reference.ref, digest: reference.digest }));
    const core = testingReconcileClosureCoreSchema.parse({
      schema_version: 'talos.testing-reconcile-closure/v1',
      run_id: run.id,
      task_id: run.task.id,
      attempt_id: attempt.id,
      machine_id: attempt.machineId,
      generation: attempt.generation,
      fence_token: attempt.fenceToken,
      reconcile_deadline: reconcileDeadline,
      last_authoritative_snapshot: {
        ref: snapshotCore.snapshot_ref,
        version: run.snapshotVersion,
        digest: computeTestingRunSnapshotDigest(snapshotCore)
      },
      last_receipt_refs: receiptRefs,
      decision_nonce: newId('testing-reconcile-decision'),
      decided_at: decidedAt,
      execution_disposition: 'lost_or_inconclusive',
      cleanup_disposition: 'residual_blocking',
      key_id: this.claimKeyId
    });
    const signature = sign(null, Buffer.from(canonicalJson(core)), this.claimSigningKey).toString('base64url');
    return testingReconcileClosureSchema.parse({ ...core, signature: `ed25519:${signature}` });
  }

  private async failAttemptExhausted(run: TestingRunRecord): Promise<void> {
    const now = new Date(this.clock()).toISOString();
    const event = makeEvent(
      run.progress.last_event_sequence + 1,
      'run.failed',
      now,
      { error_code: 'attempt_limit_exceeded' }
    );
    await this.repository.replaceTestingRun({
      ...run,
      recordVersion: run.recordVersion + 1,
      snapshotVersion: run.snapshotVersion + 1,
      controlStatus: 'failed',
      executionOutcome: 'not_started',
      cleanupOutcome: 'unobserved',
      terminalReason: { code: 'attempt_limit_exceeded', at: now },
      blocking: undefined,
      task: { ...run.task, status: 'failed', updatedAt: now },
      safeError: {
        code: 'attempt_limit_exceeded',
        message: 'testing attempt limit was exhausted before local acceptance',
        retryable: false
      },
      progress: { ...run.progress, phase: 'failed', last_event_sequence: event.sequence },
      events: appendBoundedEvents(run, [event]),
      updatedAt: now
    }, run.recordVersion);
  }

  private async sweepReservations(now: number): Promise<void> {
    const reservations = await this.repository.listTestingMachineReservations();
    for (const reservation of reservations) {
      const run = await this.repository.getTestingRun(reservation.runId);
      const attempt = run?.attempts.find((candidate) => candidate.id === reservation.attemptId);
      const exactBinding = run !== undefined &&
        attempt?.machineId === reservation.machineId &&
        attempt.generation === reservation.generation &&
        attempt.fenceToken === reservation.fenceToken;
      if (exactBinding && attempt.reservationCancellationReceipt !== undefined) {
        await this.releaseReservation(reservation.machineId, reservation.attemptId);
        continue;
      }
      const authoritative = exactBinding && run.currentAttemptId === reservation.attemptId;
      if (authoritative) {
        if (terminalStatuses.has(run.controlStatus)) {
          if (this.hasReservationReleaseProof(run, attempt)) {
            await this.releaseReservation(reservation.machineId, reservation.attemptId);
          } else if (reservation.status !== 'residual_blocking') {
            await this.updateReservation(attempt, run.task.id, 'residual_blocking', reservation.expiresAt);
          }
          continue;
        }
        if (attempt.localAcceptedAt !== undefined || Date.parse(reservation.expiresAt) > now) continue;
        if (!['released', 'completed', 'failed', 'cancelled', 'abandoned'].includes(attempt.status)) continue;
      } else if (reservation.status === 'residual_blocking' || Date.parse(reservation.expiresAt) > now) {
        continue;
      }
      await this.releaseReservation(reservation.machineId, reservation.attemptId);
    }
  }

  private async releaseReservation(machineId: string, attemptId: string): Promise<void> {
    const reservation = await this.repository.getTestingMachineReservation(machineId);
    if (reservation === undefined || reservation.attemptId !== attemptId) return;
    if (!await this.repository.releaseTestingMachineReservation(machineId, attemptId)) {
      const current = await this.repository.getTestingMachineReservation(machineId);
      if (current === undefined || current.attemptId !== attemptId) return;
      throw new TalosError('concurrent_update', 'testing reservation changed before release', 409);
    }
  }
}

const isEvidenceAdvance = (
  current: TestingEvidenceOutcome,
  requested: TestingEvidenceOutcome
): boolean => current === requested ||
  (current === 'partial' && requested === 'complete') ||
  (current === 'unavailable' && ['partial', 'complete'].includes(requested));

const isUploadAdvance = (
  current: TestingUploadOutcome,
  requested: TestingUploadOutcome
): boolean => current === requested ||
  (current === 'pending' && ['uploaded', 'failed', 'upload_expired'].includes(requested)) ||
  (['failed', 'upload_expired'].includes(current) && requested === 'uploaded');

const isCleanupAdvance = (
  current: TestingCleanupOutcome,
  requested: TestingCleanupOutcome
): boolean => current === requested ||
  (current === 'residual_blocking' && ['residual_retryable', 'complete', 'not_required'].includes(requested)) ||
  (current === 'residual_retryable' && ['complete', 'not_required'].includes(requested)) ||
  (current === 'unobserved' && ['residual_blocking', 'residual_retryable', 'complete', 'not_required'].includes(requested));

const cleanupVerificationDisposition = (
  outcome: Exclude<TestingCleanupOutcome, 'pending' | 'unobserved'>
): TestingCleanupReceiptVerification['disposition'] => ({
  complete: 'cleanup_complete',
  not_required: 'cleanup_not_required',
  residual_retryable: 'cleanup_residual_retryable',
  residual_blocking: 'cleanup_residual_blocking'
} as const)[outcome];

const areTerminalRefsMonotonic = (
  current: TestingTerminalRefs | undefined,
  requested: TestingTerminalRefs | undefined
): boolean => {
  if (current === undefined) return true;
  if (requested === undefined || canonicalJson(current.binding) !== canonicalJson(requested.binding)) return false;
  for (const field of ['case_result_set', 'evidence_manifest', 'cleanup_receipt'] as const) {
    if (
      current[field] !== undefined &&
      (requested[field] === undefined || canonicalJson(current[field]) !== canonicalJson(requested[field]))
    ) return false;
  }
  return true;
};

const hashSecret = (value: string): string => createHash('sha256').update(value).digest('hex');

const normalizeClaimSigningKey = (input: KeyObject | string | undefined): KeyObject => {
  const key = input === undefined ? generateKeyPairSync('ed25519').privateKey :
    typeof input === 'string' ? createPrivateKey(input) : input;
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('testing claim signing key must be an Ed25519 private key');
  }
  return key;
};

const claimKeyFingerprint = (privateKey: KeyObject): string => {
  const publicDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return `testing-claim-${createHash('sha256').update(publicDer).digest('hex').slice(0, 16)}`;
};

const poolVisible = (pool: Pool, userId: string, groups: readonly string[]): boolean => {
  if (pool.visibility === 'platform' || pool.ownerUserId === userId) return true;
  if (pool.visibility === 'private') return false;
  return (pool.sharedWithGroups ?? []).some((group) => groups.includes(group));
};

const makeEvent = (
  sequence: number,
  type: TestingRunEvent['type'],
  time: string,
  data: TestingRunEvent['data']
): TestingRunEvent => {
  const core = { sequence, type, time, data };
  return testingRunEventSchema.parse({ ...core, event_digest: computeTestingRunEventDigest(core) });
};

const appendBoundedEvents = (
  run: TestingRunRecord,
  appended: readonly TestingRunEvent[]
): readonly TestingRunEvent[] => [...run.events, ...appended].slice(-run.request.policy.budgets.max_events);
