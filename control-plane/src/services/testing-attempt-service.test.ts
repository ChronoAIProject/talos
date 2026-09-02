import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalJson,
  computeTestingCancelRequestDigest,
  testingCurrentClaimEnvelopeCoreSchema,
  testingReconcileClosureCoreSchema,
  digestJson,
  type TestingCancelRequest,
  type TestingTerminalRefs
} from '@talos/testing-protocol';
import { MemoryRepository } from '../storage/memory-repository.js';
import type { TestingAttemptDispatchGuard, TestingAttemptMutationGuard } from '../storage/repository.js';
import { TalosError } from '../domain/errors.js';
import type { TestingRunRecord } from '../domain/testing-types.js';
import type { Machine } from '../domain/types.js';
import {
  testTestingPlacementInputVerifier,
  testTestingPlacementPolicy
} from '../test-support/testing-placement.js';
import { submitTestingRun } from '../test-support/testing-transport.js';
import { testTestingExternalSchemaAuthority } from '../test-support/testing-schema-authority.js';
import { testTestingExecutionDependencyReadiness } from '../test-support/testing-execution-readiness.js';
import type {
  TestingExternalSchemaAuthority,
  TestingExternalSchemaReferenceVerification
} from './testing-schema-authority.js';
import { TestingRunService } from './testing-run-service.js';
import {
  TESTING_MAX_ATTEMPTS,
  TESTING_RECONCILE_WINDOW_MS,
  TestingAttemptService,
  type TestingAttemptBindingInput,
  type TestingAuthorizationProvider,
  type TestingClaimResult,
  type TestingCleanupReceiptVerifier,
  type TestingReconcileClaimResult,
  type TestingRuntimeFactVerifier,
  type TestingTerminalCommit
} from './testing-attempt-service.js';

const digest = `sha256:${'a'.repeat(64)}`;
const signingKey = generateKeyPairSync('ed25519').privateKey;
const pointer = (schema: string, ref: string) => ({ schema, ref, digest });

const testingRequest = (key: string) => {
  const policy = {
    network_scope: 'environment_owned_loopback_exact_origins' as const,
    environment_port_handle_policy: {
      source: 'current_run_owned_handles' as const,
      allow_unowned_loopback: false as const
    },
    allowed_actions: ['navigate' as const],
    allowed_evidence_media: ['image/png' as const],
    secret_refs: [],
    budgets: {
      wall_time_ms: 600_000,
      max_cases: 20,
      max_actions: 200,
      max_events: 2_000,
      max_screenshots: 20,
      max_screenshot_bytes: 5_242_880,
      max_json_evidence_bytes: 1_048_576,
      max_total_artifact_bytes: 52_428_800
    }
  };
  return {
    schema_version: 'talos.testing-tool-request/v1' as const,
    request_id: `request:${key}`,
    client_correlation_id: `client:${key}`,
    idempotency_key: key,
    display_goal: 'Exercise attempt fencing',
    inputs: {
      schema_version: 'talos.testing-input-references/v1' as const,
      project_pack_snapshot: pointer('pql.project-pack-snapshot/v1', 'artifact://pql/project-pack-snapshot/snapshot-1'),
      test_selection: pointer('pql.test-selection/v1', 'artifact://pql/test-selection/selection-1'),
      testing_design_input_set: pointer('pql.testing-design-input-set.v1', 'artifact://pql/testing-design-input-set/input-1'),
      source_revision: {
        repository_id: 'repo-1',
        exact_revision: '0123456789abcdef0123456789abcdef01234567',
        ref: 'artifact://source/revision-1',
        digest
      },
      structured_plan: pointer('testing-structured-plan.v2', 'artifact://plans/plan-1'),
      environment_profile: { ref: 'artifact://environments/environment-1', digest },
      testing_package: { package_id: 'testing-browser-runner', version: '1.0', digest }
    },
    execution_profile: 'local_qa_agent_mvp' as const,
    placement_requirements: { testing_runtime: 'local-qa-mvp/v1' as const },
    policy_binding: {
      policy: {
        schema: 'talos.testing-execution-policy/v1' as const,
        ref: 'talos://policies/testing/policy-1',
        digest: digestJson(policy)
      },
      budgets: {
        schema: 'talos.testing-budgets/v1' as const,
        ref: 'talos://policies/testing/budgets-1',
        digest: digestJson(policy.budgets)
      }
    },
    policy
  };
};

const machine = (id: string): Machine => ({
  id,
  poolId: 'testing-pool',
  tags: {
    testing_runtime: 'local-qa-mvp/v1',
    testing_task_contract: 'talos.testing-task/v1',
    testing_backend: 'browser',
    browser: 'chromium',
    os: 'darwin',
    arch: 'arm64',
    headed_display: true,
    runner_package_id: 'testing-browser-runner',
    runner_package_version: '1.0',
    runner_package_digest: digest
  },
  capacity: 1,
  activeLeases: 0,
  online: true,
  workerTokenHash: 'worker-token-hash'
});

const authorizationProvider: TestingAuthorizationProvider = {
  issueStartAuthorization: async (context) => ({
    ref: `authorization://local-qa-request/${context.attemptId}`,
    digest,
    expires_at: context.deadline
  }),
  issueReconcileAuthorization: async (context) => ({
    ref: `authorization://local-qa-reconcile/${context.attemptId}/${context.leaseId}`,
    digest,
    expires_at: context.deadline
  })
};

const runtimeFactVerifier: TestingRuntimeFactVerifier = {
  verifyTerminalNoLocalAcceptance: async (fact) => ({
    schemaVersion: 'talos.testing-no-local-acceptance-verification/v1',
    disposition: 'never_accepted',
    journalVersion: fact.journal_version,
    startClaimDigest: fact.start_claim_digest,
    reconcileClaimDigest: fact.reconcile_claim_digest
  })
};

const cleanupReceiptVerifier: TestingCleanupReceiptVerifier = {
  verifyCleanupReceipt: async (receipt, context) => ({
    schemaVersion: 'talos.testing-cleanup-receipt-verification/v1',
    verifierId: 'runtime-cleanup-authority',
    verificationId: `cleanup-verification-${context.attemptId}`,
    receiptRef: receipt.ref,
    receiptDigest: receipt.digest,
    disposition: ({
      complete: 'cleanup_complete',
      not_required: 'cleanup_not_required',
      residual_retryable: 'cleanup_residual_retryable',
      residual_blocking: 'cleanup_residual_blocking'
    } as const)[context.cleanupOutcome],
    verifiedAt: '2026-08-22T00:00:00.000Z'
  })
};

const setup = async (options: {
  machines?: readonly string[];
  leaseSeconds?: number;
  repository?: MemoryRepository;
  authorizationProvider?: TestingAuthorizationProvider;
  runtimeFactVerifier?: TestingRuntimeFactVerifier;
  cleanupReceiptVerifier?: TestingCleanupReceiptVerifier | false;
  externalSchemaAuthority?: TestingExternalSchemaAuthority | false;
  time?: { value: number };
} = {}) => {
  const time = options.time ?? { value: Date.parse('2026-08-22T00:00:00.000Z') };
  const repository = options.repository ?? new MemoryRepository();
  await repository.savePool({ id: 'testing-pool', visibility: 'platform', tags: {} });
  for (const machineId of options.machines ?? ['machine-1']) {
    await repository.saveMachine(machine(machineId));
  }
  const runs = new TestingRunService(repository, {
    cursorSecret: 'testing-attempt-cursor-secret-1234',
    clock: () => time.value,
    placementPolicy: testTestingPlacementPolicy(),
    placementInputVerifier: testTestingPlacementInputVerifier(),
    executionDependencyReadiness: testTestingExecutionDependencyReadiness(),
    externalSchemaAuthority: options.externalSchemaAuthority === false
      ? undefined
      : options.externalSchemaAuthority ?? testTestingExternalSchemaAuthority()
  });
  const attempts = new TestingAttemptService(repository, {
    claimSigningKey: signingKey,
    claimKeyId: 'testing-claim-key-1',
    authorizationProvider: options.authorizationProvider ?? authorizationProvider,
    runtimeFactVerifier: options.runtimeFactVerifier ?? runtimeFactVerifier,
    cleanupReceiptVerifier: options.cleanupReceiptVerifier === false
      ? undefined
      : options.cleanupReceiptVerifier ?? cleanupReceiptVerifier,
    externalSchemaAuthority: options.externalSchemaAuthority === false
      ? undefined
      : options.externalSchemaAuthority ?? testTestingExternalSchemaAuthority(),
    clock: () => time.value,
    leaseSeconds: options.leaseSeconds ?? 10
  });
  return {
    repository,
    runs,
    attempts,
    now: (): number => time.value,
    advance: (milliseconds: number): void => { time.value += milliseconds; }
  };
};

type Claim = TestingClaimResult | TestingReconcileClaimResult;

const binding = (claim: Claim): TestingAttemptBindingInput => ({
  runId: claim.task.qa_run_id,
  attemptId: claim.task.dispatch_attempt_id,
  machineId: claim.task.machine_id,
  workerId: claim.task.worker_id,
  generation: claim.task.generation,
  fenceToken: claim.task.fence_token,
  leaseToken: claim.lease_token
});

const terminal = (
  claim: Claim,
  overrides: Partial<TestingTerminalCommit> = {}
): TestingTerminalCommit => {
  const terminalBinding = {
    run_id: claim.task.qa_run_id,
    task_id: 'id' in claim.task ? claim.task.id : claim.task.task_id,
    attempt_id: claim.task.dispatch_attempt_id,
    generation: claim.task.generation,
    fence_token: claim.task.fence_token
  };
  const executionOutcome = overrides.executionOutcome ?? 'passed';
  const summary = overrides.summary ?? (
    executionOutcome === 'passed'
      ? { total: 1, passed: 1, failed: 0, blocked: 0, error: 0, skipped: 0, all_skipped: false }
      : executionOutcome === 'failed'
        ? { total: 1, passed: 0, failed: 1, blocked: 0, error: 0, skipped: 0, all_skipped: false }
        : executionOutcome === 'blocked'
          ? { total: 1, passed: 0, failed: 0, blocked: 1, error: 0, skipped: 0, all_skipped: false }
          : executionOutcome === 'error'
            ? { total: 1, passed: 0, failed: 0, blocked: 0, error: 1, skipped: 0, all_skipped: false }
            : executionOutcome === 'all_skipped'
              ? { total: 1, passed: 0, failed: 0, blocked: 0, error: 0, skipped: 1, all_skipped: true }
              : undefined
  );
  return {
    ...binding(claim),
    controlStatus: 'completed',
    executionOutcome,
    evidenceOutcome: 'complete',
    uploadOutcome: 'uploaded',
    cleanupOutcome: 'complete',
    ...(summary === undefined ? {} : { summary }),
    results: {
      schema_version: 'talos.testing-terminal-refs/v1',
      binding: terminalBinding,
      case_result_set: {
        schema: 'testing-case-result-set.v2',
        schema_digest: digest,
        ref: `artifact://testing/results/${terminalBinding.attempt_id}`,
        digest,
        binding: terminalBinding
      },
      evidence_manifest: {
        schema: 'testing-evidence-manifest.v1',
        schema_digest: digest,
        ref: `artifact://testing/evidence/${terminalBinding.attempt_id}`,
        digest,
        binding: terminalBinding
      },
      cleanup_receipt: {
        schema: 'qa.local-cleanup-receipt/v2',
        schema_digest: digest,
        ref: `artifact://testing/cleanup/${terminalBinding.attempt_id}`,
        digest,
        binding: terminalBinding
      }
    },
    ...overrides,
    ...(overrides.summary === undefined && summary === undefined ? { summary: undefined } : {})
  };
};

const withoutEvidenceManifest = (results: TestingTerminalRefs): TestingTerminalRefs => ({
  schema_version: results.schema_version,
  binding: results.binding,
  ...(results.case_result_set === undefined ? {} : { case_result_set: results.case_result_set }),
  ...(results.cleanup_receipt === undefined ? {} : { cleanup_receipt: results.cleanup_receipt })
});

const noLocalAcceptanceFact = (
  claim: TestingClaimResult,
  reconcile: TestingReconcileClaimResult,
  journalVersion = 1
) => ({
  schema_version: 'talos.testing-no-local-acceptance-fact/v1' as const,
  run_id: claim.task.qa_run_id,
  task_id: claim.task.id,
  attempt_id: claim.task.dispatch_attempt_id,
  machine_id: claim.task.machine_id,
  worker_id: claim.task.worker_id,
  lease_id: claim.task.lease_id,
  generation: claim.task.generation,
  fence_token: claim.task.fence_token,
  admission_nonce: claim.task.admission_nonce,
  start_claim_digest: claim.current_claim.claim_digest,
  reconcile_claim_id: reconcile.current_claim.claim.claim_id,
  reconcile_lease_id: reconcile.task.lease_id,
  reconcile_claim_digest: reconcile.current_claim.claim_digest,
  journal_version: journalVersion,
  disposition: 'never_accepted' as const,
  fact_ref: `local-qa://runtime/facts/${claim.task.dispatch_attempt_id}`,
  fact_digest: digest,
  observed_at: reconcile.current_claim.observed_at
});

const cancelRequest = (
  runId: string,
  key: string,
  reason: TestingCancelRequest['reason'] = 'user_requested'
) => {
  const unsigned = {
    schema_version: 'talos.testing-cancel-request/v1' as const,
    idempotency_scope: `talos.testing.cancel:${runId}`,
    idempotency_key: key,
    reason
  };
  return { ...unsigned, canonical_request_digest: computeTestingCancelRequestDigest(runId, unsigned) };
};

class DeadlineBarrierRepository extends MemoryRepository {
  private armed = false;
  private dispatchOnly = false;
  private enteredResolve: (() => void) | undefined;
  private releaseResolve: (() => void) | undefined;
  private entered = Promise.resolve();
  private release = Promise.resolve();

  public constructor(private readonly currentTime: () => number) {
    super();
  }

  public armDeadlineWrite(): void {
    this.armed = true;
    this.dispatchOnly = false;
    this.resetBarrier();
  }

  public armDispatchWrite(): void {
    this.armed = true;
    this.dispatchOnly = true;
    this.resetBarrier();
  }

  private resetBarrier(): void {
    this.entered = new Promise<void>((resolve) => { this.enteredResolve = resolve; });
    this.release = new Promise<void>((resolve) => { this.releaseResolve = resolve; });
  }

  public async waitForDeadlineWrite(): Promise<void> {
    await this.entered;
  }

  public releaseDeadlineWrite(): void {
    this.releaseResolve?.();
  }

  public override async replaceTestingRunWithinDeadline(
    run: TestingRunRecord,
    expectedRecordVersion: number,
    deadline: 'run' | 'reconcile',
    _observedNow: number
  ): Promise<boolean> {
    if (this.armed && !this.dispatchOnly) {
      this.armed = false;
      this.enteredResolve?.();
      await this.release;
    }
    return super.replaceTestingRunWithinDeadline(run, expectedRecordVersion, deadline, this.currentTime());
  }

  public override async replaceTestingRunForAttempt(
    run: TestingRunRecord,
    expectedRecordVersion: number,
    deadline: 'run' | 'reconcile',
    guard: TestingAttemptMutationGuard,
    _observedNow: number
  ): Promise<boolean> {
    if (this.armed && !this.dispatchOnly) {
      this.armed = false;
      this.enteredResolve?.();
      await this.release;
    }
    return super.replaceTestingRunForAttempt(
      run,
      expectedRecordVersion,
      deadline,
      guard,
      this.currentTime()
    );
  }

  public override async replaceTestingRunForDispatch(
    run: TestingRunRecord,
    expectedRecordVersion: number,
    deadline: 'run' | 'reconcile',
    guard: TestingAttemptDispatchGuard,
    _observedNow: number
  ): Promise<boolean> {
    if (this.armed) {
      this.armed = false;
      this.dispatchOnly = false;
      this.enteredResolve?.();
      await this.release;
    }
    return super.replaceTestingRunForDispatch(
      run,
      expectedRecordVersion,
      deadline,
      guard,
      this.currentTime()
    );
  }
}

class ReservationReleaseBarrierRepository extends MemoryRepository {
  private armed = false;
  private waiting = 0;
  private enteredResolve: (() => void) | undefined;
  private releaseResolve: (() => void) | undefined;
  private entered = Promise.resolve();
  private release = Promise.resolve();

  public armReleaseBarrier(): void {
    this.armed = true;
    this.waiting = 0;
    this.entered = new Promise<void>((resolve) => { this.enteredResolve = resolve; });
    this.release = new Promise<void>((resolve) => { this.releaseResolve = resolve; });
  }

  public async waitForCompetingReleases(): Promise<void> {
    await this.entered;
  }

  public releaseCompetingCalls(): void {
    this.armed = false;
    this.releaseResolve?.();
  }

  public override async releaseTestingMachineReservation(machineId: string, attemptId: string): Promise<boolean> {
    if (this.armed) {
      this.waiting += 1;
      if (this.waiting === 2) this.enteredResolve?.();
      await this.release;
    }
    return super.releaseTestingMachineReservation(machineId, attemptId);
  }
}

describe('TestingAttemptService', () => {
  it('fails closed without authorization and requires exact machine capabilities', async () => {
    const { repository, runs, attempts, advance } = await setup();
    await submitTestingRun(runs, 'run-1', 'user-1', testingRequest('submit-1'));
    const withoutAuthorization = new TestingAttemptService(repository, {
      claimSigningKey: signingKey
    });
    await expect(withoutAuthorization.claim('worker-1', 'machine-1'))
      .rejects.toMatchObject({ code: 'testing_authorization_unavailable', status: 503 });
    expect((await repository.getTestingRun('run-1'))?.attempts).toHaveLength(0);

    const currentMachine = await repository.getMachine('machine-1');
    if (currentMachine === undefined) throw new Error('machine fixture missing');
    await repository.saveMachine({
      ...currentMachine,
      tags: { ...currentMachine.tags, runner_package_digest: `sha256:${'b'.repeat(64)}` }
    });
    await expect(attempts.claim('worker-1', 'machine-1')).rejects.toMatchObject({ code: 'not_found' });
    expect((await repository.getTestingRun('run-1'))?.attempts).toHaveLength(0);
    advance(600_001);
    await attempts.sweep();
    expect(await repository.getTestingRun('run-1')).toMatchObject({
      controlStatus: 'failed',
      executionOutcome: 'not_started',
      cleanupOutcome: 'unobserved',
      safeError: { code: 'deadline_exceeded', retryable: false }
    });
    await expect(runs.get('run-1', 'user-1')).resolves.toMatchObject({
      terminal: true,
      terminal_reason: { code: 'deadline_exceeded' },
      cleanup_outcome: 'unobserved'
    });
  });

  it('atomically permits one claim across competing machines and one run per machine', async () => {
    const { repository, runs, attempts } = await setup({ machines: ['machine-1', 'machine-2'] });
    await submitTestingRun(runs, 'run-1', 'user-1', testingRequest('submit-1'));
    const competing = await Promise.allSettled([
      attempts.claim('worker-1', 'machine-1'),
      attempts.claim('worker-2', 'machine-2')
    ]);
    expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const run = await repository.getTestingRun('run-1');
    expect(run?.attempts).toHaveLength(1);
    expect(await repository.listTestingMachineReservations()).toHaveLength(1);

    const occupiedMachine = run?.attempts[0]?.machineId;
    if (occupiedMachine === undefined) throw new Error('claimed attempt fixture missing');
    await submitTestingRun(runs, 'run-2', 'user-1', testingRequest('submit-2'));
    await expect(attempts.claim('worker-next', occupiedMachine)).rejects.toMatchObject({ code: 'not_found' });
    expect((await repository.getTestingRun('run-2'))?.attempts).toHaveLength(0);
  });

  it('uses the submitter group snapshot for organization pool visibility', async () => {
    const { repository, runs, attempts } = await setup();
    await repository.savePool({
      id: 'testing-pool',
      visibility: 'org',
      ownerUserId: 'pool-owner',
      sharedWithGroups: ['qa-team'],
      tags: {}
    });
    await expect(submitTestingRun(runs, 'run-hidden', 'user-1', testingRequest('submit-hidden')))
      .rejects.toMatchObject({ code: 'testing_placement_denied' });
    expect(await repository.getTestingRun('run-hidden')).toBeUndefined();
    await submitTestingRun(runs, 'run-visible', 'user-1', testingRequest('submit-visible'), ['qa-team']);
    expect((await attempts.claim('worker-1', 'machine-1')).task.qa_run_id).toBe('run-visible');
  });

  it('rejects stale lease, generation, and fence writers', async () => {
    const { runs, attempts, advance } = await setup();
    await submitTestingRun(runs, 'run-1', 'user-1', testingRequest('submit-1'));
    const claim = await attempts.claim('worker-1', 'machine-1');
    const exact = binding(claim);
    await expect(attempts.heartbeat({ ...exact, generation: exact.generation + 1 }, 10))
      .rejects.toMatchObject({ code: 'stale_testing_generation' });
    await expect(attempts.heartbeat({ ...exact, fenceToken: 'different-fence-token-1234' }, 10))
      .rejects.toMatchObject({ code: 'stale_testing_fence' });
    await expect(attempts.heartbeat({ ...exact, leaseToken: 'different-lease-token' }, 10))
      .rejects.toMatchObject({ code: 'invalid_testing_lease' });
    await expect(attempts.heartbeat({ ...exact, workerId: 'worker-2' }, 10))
      .rejects.toMatchObject({ code: 'stale_testing_worker' });
    await expect(attempts.heartbeat({ ...exact, machineId: 'machine-2' }, 10))
      .rejects.toMatchObject({ code: 'stale_testing_machine' });
    const snapshotBeforeHeartbeat = await runs.get('run-1', 'user-1');
    advance(1_000);
    const beforeHeartbeat = claim.current_claim.claim_digest;
    const heartbeat = await attempts.heartbeat(exact, 30);
    expect(heartbeat.current_claim.claim_digest).toBe(beforeHeartbeat);
    expect(heartbeat.current_claim.claim.expires_at).toBe(claim.task.deadline);
    expect(await runs.get('run-1', 'user-1')).toEqual(snapshotBeforeHeartbeat);
  });

  it('does not place testing work on a machine with an active generic lease', async () => {
    const { repository, runs, attempts } = await setup();
    const current = await repository.getMachine('machine-1');
    if (current === undefined) throw new Error('machine fixture missing');
    await repository.saveMachine({ ...current, activeLeases: current.capacity });
    await submitTestingRun(runs, 'run-capacity', 'user-1', testingRequest('submit-capacity'));

    await expect(attempts.claim('worker-1', 'machine-1')).rejects.toMatchObject({ code: 'not_found' });
    expect((await repository.getTestingRun('run-capacity'))?.attempts).toHaveLength(0);
  });

  it('claims only from the pool frozen by Talos placement policy', async () => {
    const { repository, runs, attempts } = await setup();
    await repository.savePool({ id: 'other-visible-pool', visibility: 'platform', tags: {} });
    await repository.saveMachine({ ...machine('machine-other'), poolId: 'other-visible-pool' });
    await submitTestingRun(runs, 'run-policy-pool', 'user-1', testingRequest('submit-policy-pool'));

    await expect(attempts.claim('worker-other', 'machine-other')).rejects.toMatchObject({ code: 'not_found' });
    await expect(attempts.claim('worker-selected', 'machine-1')).resolves.toMatchObject({
      task: { qa_run_id: 'run-policy-pool', machine_id: 'machine-1' }
    });
    expect((await repository.getTestingRun('run-policy-pool'))?.placement.poolId).toBe('testing-pool');
  });

  it('projects bounded Runtime progress monotonically without replacing the Talos event cursor', async () => {
    const { repository, runs, attempts } = await setup();
    await submitTestingRun(runs, 'run-progress', 'user-1', testingRequest('submit-progress'));
    const claim = await attempts.claim('worker-1', 'machine-1');
    const before = await repository.getTestingRun('run-progress');
    await attempts.heartbeat(binding(claim), 30, {
      phase: 'executing',
      completed_cases: 2,
      total_cases: 5,
      runtime_event_sequence: 9
    });
    const updated = await repository.getTestingRun('run-progress');
    expect(updated?.progress).toEqual({
      phase: 'executing',
      completed_cases: 2,
      total_cases: 5,
      last_event_sequence: before?.progress.last_event_sequence
    });
    expect(updated?.attempts[0]?.runtimeEventSequence).toBe(9);
    await expect(attempts.heartbeat(binding(claim), 30, {
      phase: 'executing',
      completed_cases: 1,
      total_cases: 5,
      runtime_event_sequence: 8
    })).rejects.toMatchObject({ code: 'stale_testing_progress' });
  });

  it('binds Runtime current-claim observations to nonce, audience, validity, and a dedicated Ed25519 key', async () => {
    const { runs, attempts } = await setup();
    await submitTestingRun(runs, 'run-claim', 'user-1', testingRequest('submit-claim'));
    const claim = await attempts.claim('worker-1', 'machine-1');
    const first = await attempts.resolveRuntimeCurrentClaim(
      'run-claim',
      claim.current_claim.claim.claim_id,
      {
        schema_version: 'talos.testing-current-claim-resolve-request/v1',
        audience: 'local-qa-runtime',
        request_nonce: 'runtime-request-nonce-0001'
      }
    );
    expect(first).toMatchObject({
      audience: 'local-qa-runtime',
      request_nonce: 'runtime-request-nonce-0001',
      key_id: 'testing-claim-key-1',
      is_current: true
    });
    const core = { ...first } as Record<string, unknown>;
    const signature = String(core.signature).slice('ed25519:'.length);
    delete core.signature;
    expect(testingCurrentClaimEnvelopeCoreSchema.parse(core)).toEqual(core);
    expect(verify(null, Buffer.from(canonicalJson(core)), attempts.claimPublicKey(), Buffer.from(signature, 'base64url')))
      .toBe(true);

    const second = await attempts.resolveRuntimeCurrentClaim(
      'run-claim',
      claim.current_claim.claim.claim_id,
      {
        schema_version: 'talos.testing-current-claim-resolve-request/v1',
        audience: 'local-qa-runtime',
        request_nonce: 'runtime-request-nonce-0002'
      }
    );
    expect(second.signature).not.toBe(first.signature);
    await expect(attempts.resolveRuntimeCurrentClaim('run-claim', claim.current_claim.claim.claim_id, {
      schema_version: 'talos.testing-current-claim-resolve-request/v1',
      audience: 'local-qa-runtime',
      request_nonce: 'runtime-request-nonce-0003',
      worker_token: 'forbidden'
    })).rejects.toThrow();
  });

  it('canonically closes a concurrent non-cancel terminal commit after cancel intent', async () => {
    const time = { value: Date.parse('2026-08-22T00:00:00.000Z') };
    const repository = new DeadlineBarrierRepository(() => time.value);
    const { runs, attempts } = await setup({ repository, time });
    await submitTestingRun(runs, 'run-cancel-race', 'user-1', testingRequest('submit-cancel-race'));
    const claim = await attempts.claim('worker-1', 'machine-1');
    await attempts.acceptLocal(binding(claim));
    repository.armDeadlineWrite();

    const terminalCommit = attempts.commitTerminal(terminal(claim));
    await repository.waitForDeadlineWrite();
    await runs.cancel(
      'run-cancel-race',
      'user-1',
      cancelRequest('run-cancel-race', 'cancel-race')
    );
    repository.releaseDeadlineWrite();

    await expect(terminalCommit).resolves.toMatchObject({
      controlStatus: 'cancelled',
      executionOutcome: 'passed'
    });
    expect(await repository.getTestingRun('run-cancel-race')).toMatchObject({
      controlStatus: 'cancelled',
      executionOutcome: 'passed'
    });
  });

  it('rejects a terminal write when the persisted run deadline passes while its CAS is blocked', async () => {
    const time = { value: Date.parse('2026-08-22T00:00:00.000Z') };
    const repository = new DeadlineBarrierRepository(() => time.value);
    const { runs, attempts, advance } = await setup({ repository, time });
    await submitTestingRun(runs, 'run-deadline-race', 'user-1', testingRequest('submit-deadline-race'));
    const claim = await attempts.claim('worker-1', 'machine-1');
    await attempts.acceptLocal(binding(claim));
    repository.armDeadlineWrite();

    const terminalCommit = attempts.commitTerminal(terminal(claim));
    await repository.waitForDeadlineWrite();
    advance(600_001);
    repository.releaseDeadlineWrite();

    await expect(terminalCommit).rejects.toMatchObject({ code: 'testing_deadline_exceeded' });
    expect((await repository.getTestingRun('run-deadline-race'))?.controlStatus).toBe('local_accepted');
  });

  it('rejects a terminal write when its lease expires while the attempt CAS is blocked', async () => {
    const time = { value: Date.parse('2026-08-22T00:00:00.000Z') };
    const repository = new DeadlineBarrierRepository(() => time.value);
    const { runs, attempts, advance } = await setup({ repository, time, leaseSeconds: 1 });
    await submitTestingRun(runs, 'run-lease-race', 'user-1', testingRequest('submit-lease-race'));
    const claim = await attempts.claim('worker-1', 'machine-1');
    await attempts.acceptLocal(binding(claim));
    repository.armDeadlineWrite();

    const terminalCommit = attempts.commitTerminal(terminal(claim));
    await repository.waitForDeadlineWrite();
    advance(1_001);
    repository.releaseDeadlineWrite();

    await expect(terminalCommit).rejects.toMatchObject({ code: 'testing_lease_expired' });
    expect((await repository.getTestingRun('run-lease-race'))?.controlStatus).toBe('local_accepted');
  });

  it('rejects start dispatch when authorization expires while its CAS is blocked', async () => {
    const time = { value: Date.parse('2026-08-22T00:00:00.000Z') };
    const repository = new DeadlineBarrierRepository(() => time.value);
    const expiringAuthorization: TestingAuthorizationProvider = {
      ...authorizationProvider,
      issueStartAuthorization: async (context) => ({
        ref: `authorization://local-qa-request/${context.attemptId}`,
        digest,
        expires_at: new Date(time.value + 1_000).toISOString()
      })
    };
    const { runs, attempts, advance } = await setup({
      repository,
      time,
      authorizationProvider: expiringAuthorization
    });
    await submitTestingRun(runs, 'run-auth-race', 'user-1', testingRequest('submit-auth-race'));
    repository.armDispatchWrite();

    const claim = attempts.claim('worker-1', 'machine-1');
    await repository.waitForDeadlineWrite();
    advance(1_001);
    repository.releaseDeadlineWrite();

    await expect(claim).rejects.toMatchObject({ code: 'claim_superseded' });
    expect((await repository.getTestingRun('run-auth-race'))?.controlStatus).toBe('submitted');
  });

  it('rejects start dispatch when its lease expires while the CAS is blocked', async () => {
    const time = { value: Date.parse('2026-08-22T00:00:00.000Z') };
    const repository = new DeadlineBarrierRepository(() => time.value);
    const { runs, attempts, advance } = await setup({ repository, time, leaseSeconds: 1 });
    await submitTestingRun(runs, 'run-dispatch-lease-race', 'user-1', testingRequest('submit-dispatch-lease-race'));
    repository.armDispatchWrite();

    const claim = attempts.claim('worker-1', 'machine-1');
    await repository.waitForDeadlineWrite();
    advance(1_001);
    repository.releaseDeadlineWrite();

    await expect(claim).rejects.toMatchObject({ code: 'claim_superseded' });
    expect((await repository.getTestingRun('run-dispatch-lease-race'))?.controlStatus).toBe('submitted');
  });

  it('records local acceptance after an admitted start authorization expires', async () => {
    const time = { value: Date.parse('2026-08-22T00:00:00.000Z') };
    const repository = new DeadlineBarrierRepository(() => time.value);
    const expiringAuthorization: TestingAuthorizationProvider = {
      ...authorizationProvider,
      issueStartAuthorization: async (context) => ({
        ref: `authorization://local-qa-request/${context.attemptId}`,
        digest,
        expires_at: new Date(time.value + 1_000).toISOString()
      })
    };
    const { runs, attempts, advance } = await setup({ repository, time, authorizationProvider: expiringAuthorization });
    await submitTestingRun(runs, 'run-admitted-auth', 'user-1', testingRequest('submit-admitted-auth'));
    const claim = await attempts.claim('worker-1', 'machine-1');
    repository.armDeadlineWrite();

    const localAcceptance = attempts.acceptLocal(binding(claim));
    await repository.waitForDeadlineWrite();
    advance(1_001);
    repository.releaseDeadlineWrite();

    await expect(localAcceptance).resolves.toMatchObject({ is_current: true, status: 'current' });
    expect((await repository.getTestingRun('run-admitted-auth'))?.controlStatus).toBe('local_accepted');
  });

  it('rejects reconcile dispatch when authorization expires while its CAS is blocked', async () => {
    const time = { value: Date.parse('2026-08-22T00:00:00.000Z') };
    const repository = new DeadlineBarrierRepository(() => time.value);
    const expiringReconcileAuthorization: TestingAuthorizationProvider = {
      ...authorizationProvider,
      issueReconcileAuthorization: async (context) => ({
        ref: `authorization://local-qa-reconcile/${context.attemptId}/${context.leaseId}`,
        digest,
        expires_at: new Date(time.value + 1_000).toISOString()
      })
    };
    const { runs, attempts, advance } = await setup({
      repository,
      time,
      leaseSeconds: 10,
      authorizationProvider: expiringReconcileAuthorization
    });
    await submitTestingRun(runs, 'run-reconcile-auth-race', 'user-1', testingRequest('submit-reconcile-auth-race'));
    const start = await attempts.claim('worker-1', 'machine-1');
    await attempts.acceptLocal(binding(start));
    advance(10_001);
    await attempts.sweep();
    repository.armDispatchWrite();

    const reconcile = attempts.claimReconcile('worker-restarted', 'machine-1', 'run-reconcile-auth-race');
    await repository.waitForDeadlineWrite();
    advance(1_001);
    repository.releaseDeadlineWrite();

    await expect(reconcile).rejects.toMatchObject({ code: 'claim_superseded' });
    expect((await repository.getTestingRun('run-reconcile-auth-race'))?.attempts[0])
      .toMatchObject({ operation: 'start', status: 'reconcile_required' });
  });

  it('commits an admitted reconcile fact after its request authorization expires', async () => {
    const time = { value: Date.parse('2026-08-22T00:00:00.000Z') };
    const expiringReconcileAuthorization: TestingAuthorizationProvider = {
      ...authorizationProvider,
      issueReconcileAuthorization: async (context) => ({
        ref: `authorization://local-qa-reconcile/${context.attemptId}/${context.leaseId}`,
        digest,
        expires_at: new Date(time.value + 1_000).toISOString()
      })
    };
    const { runs, attempts, advance } = await setup({
      time,
      leaseSeconds: 10,
      authorizationProvider: expiringReconcileAuthorization
    });
    await submitTestingRun(runs, 'run-reconcile-admitted', 'user-1', testingRequest('submit-reconcile-admitted'));
    const start = await attempts.claim('worker-1', 'machine-1');
    await attempts.acceptLocal(binding(start));
    advance(10_001);
    await attempts.sweep();
    const reconcile = await attempts.claimReconcile('worker-restarted', 'machine-1', 'run-reconcile-admitted');

    advance(1_001);

    await expect(attempts.commitReconcileTerminal(terminal(reconcile))).resolves.toMatchObject({
      controlStatus: 'completed',
      executionOutcome: 'passed'
    });
  });

  it('requires exact cleanup proof before releasing a locally accepted machine slot', async () => {
    const { repository, runs, attempts } = await setup();
    await submitTestingRun(runs, 'run-cleanup', 'user-1', testingRequest('submit-cleanup'));
    const claim = await attempts.claim('worker-1', 'machine-1');
    await attempts.acceptLocal(binding(claim));
    const withoutCleanup = terminal(claim);
    if (withoutCleanup.results === undefined) throw new Error('terminal refs fixture missing');
    const { cleanup_receipt: _cleanupReceipt, ...results } = withoutCleanup.results;
    void _cleanupReceipt;
    await expect(attempts.commitTerminal({ ...withoutCleanup, results }))
      .rejects.toMatchObject({ code: 'cleanup_proof_required' });
    expect(await repository.getTestingMachineReservation('machine-1')).toBeDefined();

    await attempts.commitTerminal(terminal(claim));
    expect(await repository.getTestingMachineReservation('machine-1')).toBeUndefined();
    await expect(attempts.commitReconcileTerminal(terminal(claim)))
      .rejects.toMatchObject({ code: 'stale_testing_operation' });
  });

  it('converges concurrent exact terminal commits after one request releases the reservation', async () => {
    const repository = new ReservationReleaseBarrierRepository();
    const { runs, attempts } = await setup({ repository });
    await submitTestingRun(runs, 'run-concurrent-terminal', 'user-1', testingRequest('submit-concurrent-terminal'));
    const claim = await attempts.claim('worker-1', 'machine-1');
    await attempts.acceptLocal(binding(claim));
    const input = terminal(claim);
    repository.armReleaseBarrier();

    const commits = Promise.all([
      attempts.commitTerminal(input),
      attempts.commitTerminal(input)
    ]);
    await repository.waitForCompetingReleases();
    repository.releaseCompetingCalls();
    const [first, second] = await commits;

    expect(first).toEqual(second);
    expect(first).toMatchObject({ controlStatus: 'completed', cleanupOutcome: 'complete' });
    expect(await repository.getTestingMachineReservation('machine-1')).toBeUndefined();
  });

  it('fails closed when cleanup authority is missing or rejects a structural receipt pointer', async () => {
    for (const [runId, cleanupReceiptVerifier] of [
      ['run-cleanup-no-verifier', false],
      ['run-cleanup-rejected', { verifyCleanupReceipt: async () => undefined }]
    ] as const) {
      const { repository, runs, attempts } = await setup({ cleanupReceiptVerifier });
      await submitTestingRun(runs, runId, 'user-1', testingRequest(`submit-${runId}`));
      const claim = await attempts.claim('worker-1', 'machine-1');
      await attempts.acceptLocal(binding(claim));
      await expect(attempts.commitTerminal(terminal(claim))).rejects.toMatchObject({
        code: cleanupReceiptVerifier === false ? 'cleanup_verifier_unavailable' : 'invalid_cleanup_receipt'
      });
      expect(await repository.getTestingMachineReservation('machine-1')).toBeDefined();
      expect(await repository.getTestingRun(runId)).toMatchObject({ controlStatus: 'local_accepted' });
    }
  });

  it('fails closed when owning-repo schema manifests are unavailable or reject a terminal reference', async () => {
    let schemaAuthorityAvailable = true;
    const delegate = testTestingExternalSchemaAuthority();
    const unavailableAfterAdmission: TestingExternalSchemaAuthority = {
      getCapabilities: async () => {
        if (!schemaAuthorityAvailable) throw new Error('upstream unavailable');
        return delegate.getCapabilities();
      },
      verifyTerminalReference: delegate.verifyTerminalReference.bind(delegate)
    };
    const rejectingAuthority: TestingExternalSchemaAuthority = {
      ...delegate,
      verifyTerminalReference: async () => undefined
    };
    for (const [runId, externalSchemaAuthority, expectedCode] of [
      ['run-schema-unpublished', unavailableAfterAdmission, 'external_schema_authority_unavailable'],
      ['run-schema-rejected', rejectingAuthority, 'invalid_external_schema_reference']
    ] as const) {
      schemaAuthorityAvailable = true;
      const { repository, runs, attempts } = await setup({ externalSchemaAuthority });
      await submitTestingRun(runs, runId, 'user-1', testingRequest(`submit-${runId}`));
      const claim = await attempts.claim('worker-1', 'machine-1');
      await attempts.acceptLocal(binding(claim));
      if (runId === 'run-schema-unpublished') schemaAuthorityAvailable = false;

      await expect(attempts.commitTerminal(terminal(claim))).rejects.toMatchObject({ code: expectedCode });
      expect(await repository.getTestingMachineReservation('machine-1')).toBeDefined();
      expect(await repository.getTestingRun(runId)).toMatchObject({ controlStatus: 'local_accepted' });
    }
  });

  it('rejects every well-formed external schema verification identity mismatch before persistence', async () => {
    const mismatches: readonly [string, (
      verification: TestingExternalSchemaReferenceVerification
    ) => TestingExternalSchemaReferenceVerification][] = [
      ['contract', (verification) => ({ ...verification, contract: 'evidence_manifest' })],
      ['owner', (verification) => ({ ...verification, owner: 'local-qa-runtime' })],
      ['reference-schema', (verification) => ({ ...verification, referenceSchema: 'wrong.reference.schema' })],
      ['schema-id', (verification) => ({ ...verification, schemaId: 'wrong-schema-id' })],
      ['version', (verification) => ({ ...verification, version: 'wrong-version' })],
      ['schema-digest', (verification) => ({ ...verification, schemaDigest: `sha256:${'b'.repeat(64)}` })],
      ['artifact-ref', (verification) => ({ ...verification, artifactRef: 'artifact://wrong/reference-1' })],
      ['artifact-digest', (verification) => ({ ...verification, artifactDigest: `sha256:${'b'.repeat(64)}` })]
    ];

    for (const [name, mismatch] of mismatches) {
      const delegate = testTestingExternalSchemaAuthority();
      const authority: TestingExternalSchemaAuthority = {
        getCapabilities: delegate.getCapabilities.bind(delegate),
        verifyTerminalReference: async (...input) => {
          const verification = await delegate.verifyTerminalReference(...input);
          return verification === undefined ? undefined : mismatch(verification);
        }
      };
      const runId = `run-schema-mismatch-${name}`;
      const { repository, runs, attempts } = await setup({ externalSchemaAuthority: authority });
      await submitTestingRun(runs, runId, 'user-1', testingRequest(`submit-${runId}`));
      const claim = await attempts.claim('worker-1', 'machine-1');
      await attempts.acceptLocal(binding(claim));

      await expect(attempts.commitTerminal(terminal(claim)))
        .rejects.toMatchObject({ code: 'invalid_external_schema_reference', status: 401 });
      expect(await repository.getTestingRun(runId)).toMatchObject({ controlStatus: 'local_accepted' });
      expect(await repository.getTestingMachineReservation('machine-1')).toBeDefined();
    }
  });

  it('rejects unbounded cleanup verification records without persisting adapter fields', async () => {
    const unboundedVerifier: TestingCleanupReceiptVerifier = {
      verifyCleanupReceipt: async (receipt, context) => ({
        schemaVersion: 'talos.testing-cleanup-receipt-verification/v1',
        verifierId: 'runtime-cleanup-authority',
        verificationId: `cleanup-verification-${context.attemptId}`,
        receiptRef: receipt.ref,
        receiptDigest: receipt.digest,
        disposition: 'cleanup_complete',
        verifiedAt: '2026-08-22T00:00:01.000Z',
        providerCredential: 'must-not-persist'
      })
    };
    const { repository, runs, attempts } = await setup({ cleanupReceiptVerifier: unboundedVerifier });
    await submitTestingRun(runs, 'run-cleanup-unbounded', 'user-1', testingRequest('submit-cleanup-unbounded'));
    const claim = await attempts.claim('worker-1', 'machine-1');
    await attempts.acceptLocal(binding(claim));
    await expect(attempts.commitTerminal(terminal(claim)))
      .rejects.toMatchObject({ code: 'invalid_cleanup_receipt' });
    const run = await repository.getTestingRun('run-cleanup-unbounded');
    expect(run).toMatchObject({ controlStatus: 'local_accepted' });
    expect(run?.cleanupVerification).toBeUndefined();
    expect(await repository.getTestingMachineReservation('machine-1')).toBeDefined();
  });

  it('advances terminal delivery and cleanup monotonically without reopening execution', async () => {
    let verifications = 0;
    const verifierWithCount: TestingCleanupReceiptVerifier = {
      verifyCleanupReceipt: async (receipt, context) => {
        verifications += 1;
        return {
          schemaVersion: 'talos.testing-cleanup-receipt-verification/v1',
          verifierId: 'runtime-cleanup-authority',
          verificationId: `cleanup-verification-${context.attemptId}`,
          receiptRef: receipt.ref,
          receiptDigest: receipt.digest,
          disposition: ({
            complete: 'cleanup_complete',
            not_required: 'cleanup_not_required',
            residual_retryable: 'cleanup_residual_retryable',
            residual_blocking: 'cleanup_residual_blocking'
          } as const)[context.cleanupOutcome],
          verifiedAt: '2026-08-22T00:00:01.000Z'
        };
      }
    };
    const { repository, runs, attempts } = await setup({ cleanupReceiptVerifier: verifierWithCount });
    await submitTestingRun(runs, 'run-terminal-advance', 'user-1', testingRequest('submit-terminal-advance'));
    const claim = await attempts.claim('worker-1', 'machine-1');
    await attempts.acceptLocal(binding(claim));
    const defaultResults = terminal(claim).results;
    if (defaultResults === undefined) throw new Error('terminal refs fixture missing');
    const initialInput = terminal(claim, {
      evidenceOutcome: 'unavailable',
      uploadOutcome: 'pending',
      cleanupOutcome: 'residual_blocking',
      summary: { total: 1, passed: 1, failed: 0, blocked: 0, error: 0, skipped: 0, all_skipped: false },
      results: withoutEvidenceManifest(defaultResults)
    });
    const initial = await attempts.commitTerminal(initialInput);
    expect(initial).toMatchObject({
      controlStatus: 'completed',
      executionOutcome: 'passed',
      evidenceOutcome: 'unavailable',
      uploadOutcome: 'pending',
      cleanupOutcome: 'residual_blocking',
      summary: { total: 1, passed: 1, failed: 0, blocked: 0, error: 0, skipped: 0, all_skipped: false }
    });
    expect(await repository.getTestingMachineReservation('machine-1')).toMatchObject({ status: 'residual_blocking' });
    expect(verifications).toBe(1);

    if (initialInput.results === undefined) throw new Error('terminal refs fixture missing');
    const advancedResults = {
      ...initialInput.results,
      evidence_manifest: {
        schema: 'testing-evidence-manifest.v1' as const,
        schema_digest: digest,
        ref: 'artifact://testing/evidence/manifests-1',
        digest,
        binding: initialInput.results.binding
      }
    };
    const failedUploadInput = terminal(claim, {
      evidenceOutcome: 'unavailable',
      uploadOutcome: 'failed',
      cleanupOutcome: 'residual_blocking',
      results: initialInput.results
    });
    const uploadFailed = await attempts.commitTerminal(failedUploadInput);
    expect(uploadFailed).toMatchObject({
      terminalReason: { code: 'execution_settled' },
      uploadOutcome: 'failed'
    });
    expect(uploadFailed.snapshotVersion).toBe(initial.snapshotVersion + 1);

    const advancedInput = terminal(claim, {
      evidenceOutcome: 'complete',
      uploadOutcome: 'uploaded',
      cleanupOutcome: 'complete',
      results: advancedResults
    });
    const replaceTestingRun = repository.replaceTestingRun.bind(repository);
    vi.spyOn(repository, 'replaceTestingRun')
      .mockResolvedValueOnce(false)
      .mockImplementation(replaceTestingRun);
    const advanced = await attempts.commitTerminal(advancedInput);
    expect(advanced).toMatchObject({
      controlStatus: 'completed',
      executionOutcome: 'passed',
      evidenceOutcome: 'complete',
      uploadOutcome: 'uploaded',
      cleanupOutcome: 'complete',
      cleanupVerification: {
        schemaVersion: 'talos.testing-cleanup-receipt-verification/v1',
        receiptDigest: digest,
        binding: { runId: 'run-terminal-advance', attemptId: claim.task.dispatch_attempt_id }
      },
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'run.terminal_projection_updated' })
      ])
    });
    expect(advanced.snapshotVersion).toBe(uploadFailed.snapshotVersion + 1);
    expect(await repository.getTestingMachineReservation('machine-1')).toBeUndefined();
    expect(verifications).toBe(3);
    await expect(attempts.commitTerminal(advancedInput)).resolves.toEqual(advanced);
    expect(verifications).toBe(3);
    await expect(attempts.commitTerminal({ ...advancedInput, uploadOutcome: 'pending' }))
      .rejects.toMatchObject({ code: 'terminal_commit_conflict' });
    await expect(attempts.commitTerminal({
      ...advancedInput,
      results: initialInput.results
    })).rejects.toMatchObject({ code: 'terminal_evidence_manifest_required' });
  });

  it('expires closed pending uploads and rejects stale projection changes', async () => {
    const { runs, attempts, advance } = await setup({ leaseSeconds: 1 });
    await submitTestingRun(runs, 'run-upload-expiry', 'user-1', testingRequest('submit-upload-expiry'));
    const claim = await attempts.claim('worker-1', 'machine-1');
    await attempts.acceptLocal(binding(claim));
    const defaultResults = terminal(claim).results;
    if (defaultResults === undefined) throw new Error('terminal refs fixture missing');
    const pendingInput = terminal(claim, {
      evidenceOutcome: 'unavailable',
      uploadOutcome: 'pending',
      cleanupOutcome: 'residual_blocking',
      results: withoutEvidenceManifest(defaultResults)
    });
    await attempts.commitTerminal(pendingInput);
    await expect(runs.get('run-upload-expiry', 'user-1')).resolves.toMatchObject({
      control_status: 'completed',
      upload_outcome: 'pending',
      terminal: false,
      terminal_reason: null
    });
    await expect(attempts.assertEffectAllowed(binding(claim), 'artifact_upload')).resolves.toBeUndefined();
    await expect(attempts.resolveCurrentClaim('run-upload-expiry', claim.current_claim.claim.claim_id))
      .resolves.toMatchObject({ is_current: true, status: 'current' });
    await expect(runs.cancel(
      'run-upload-expiry',
      'user-1',
      cancelRequest('run-upload-expiry', 'cancel-upload-expiry')
    )).resolves.toMatchObject({ already_terminal: false, control_status: 'completed' });

    advance(1_001);
    await attempts.sweep();
    await expect(runs.get('run-upload-expiry', 'user-1')).resolves.toMatchObject({
      control_status: 'completed',
      upload_outcome: 'upload_expired',
      terminal: true,
      terminal_reason: { code: 'execution_settled' }
    });
    await expect(attempts.assertEffectAllowed(binding(claim), 'artifact_upload'))
      .rejects.toMatchObject({ code: 'testing_lease_expired' });
    await expect(attempts.commitTerminal({ ...pendingInput, uploadOutcome: 'uploaded' }))
      .rejects.toMatchObject({ code: 'testing_lease_expired' });
    await expect(attempts.commitTerminal({ ...pendingInput, uploadOutcome: 'upload_expired' }))
      .resolves.toMatchObject({ uploadOutcome: 'upload_expired' });
  });

  it('rejects terminal commits that still execute, stage evidence, or have pending cleanup', async () => {
    const { runs, attempts } = await setup();
    await submitTestingRun(runs, 'run-unsettled-terminal', 'user-1', testingRequest('submit-unsettled-terminal'));
    const claim = await attempts.claim('worker-1', 'machine-1');
    await attempts.acceptLocal(binding(claim));
    for (const projection of [
      { executionOutcome: 'executing' as const },
      { evidenceOutcome: 'staging' as const },
      { cleanupOutcome: 'pending' as const },
      { cleanupOutcome: 'unobserved' as const }
    ]) {
      await expect(attempts.commitTerminal(terminal(claim, projection)))
        .rejects.toMatchObject({ code: 'invalid_terminal_projection' });
    }
  });

  it('does not advance a blocking terminal projection after its machine reservation is lost', async () => {
    const { repository, runs, attempts } = await setup();
    await submitTestingRun(runs, 'run-terminal-reservation-lost', 'user-1', testingRequest('submit-terminal-reservation-lost'));
    const claim = await attempts.claim('worker-1', 'machine-1');
    await attempts.acceptLocal(binding(claim));
    const defaultResults = terminal(claim).results;
    if (defaultResults === undefined) throw new Error('terminal refs fixture missing');
    const initialInput = terminal(claim, {
      evidenceOutcome: 'unavailable',
      uploadOutcome: 'pending',
      cleanupOutcome: 'residual_blocking',
      results: withoutEvidenceManifest(defaultResults)
    });
    const initial = await attempts.commitTerminal(initialInput);
    await repository.releaseTestingMachineReservation('machine-1', claim.task.dispatch_attempt_id);
    if (initialInput.results === undefined) throw new Error('terminal refs fixture missing');
    const advancedResults = {
      ...initialInput.results,
      evidence_manifest: {
        schema: 'testing-evidence-manifest.v1' as const,
        schema_digest: digest,
        ref: 'artifact://testing/evidence/reservation-lost-manifest-1',
        digest,
        binding: initialInput.results.binding
      }
    };
    await expect(attempts.commitTerminal(terminal(claim, {
      evidenceOutcome: 'complete',
      uploadOutcome: 'pending',
      cleanupOutcome: 'residual_blocking',
      results: advancedResults
    }))).rejects.toMatchObject({ code: 'testing_reservation_lost' });
    expect(await repository.getTestingRun('run-terminal-reservation-lost')).toEqual(initial);
  });

  it('keeps machine slots blocked for residual cleanup outcomes even when a cleanup receipt exists', async () => {
    const { repository, runs, attempts } = await setup({ machines: ['machine-1', 'machine-2'] });
    for (const [index, cleanupOutcome] of ['residual_blocking', 'residual_retryable'].entries()) {
      const machineId = `machine-${index + 1}`;
      const runId = `run-residual-${index + 1}`;
      await submitTestingRun(runs, runId, 'user-1', testingRequest(`submit-residual-${index + 1}`));
      const claim = await attempts.claim(`worker-${index + 1}`, machineId);
      await attempts.acceptLocal(binding(claim));
      await attempts.commitTerminal(terminal(claim, {
        cleanupOutcome: cleanupOutcome as 'residual_blocking' | 'residual_retryable'
      }));
      await attempts.sweep();
      expect(await repository.getTestingMachineReservation(machineId)).toMatchObject({
        runId,
        status: 'residual_blocking'
      });
    }
  });

  it('preserves the slot when the local-accept ack is unknown and issues only a same-machine reconcile claim', async () => {
    const { repository, runs, attempts, advance } = await setup({
      machines: ['machine-1', 'machine-2'],
      leaseSeconds: 1
    });
    await submitTestingRun(runs, 'run-1', 'user-1', testingRequest('submit-1'));
    const first = await attempts.claim('worker-1', 'machine-1');
    expect(first.current_claim.is_current).toBe(true);
    expect(JSON.stringify(first.current_claim)).not.toContain(first.lease_token);
    expect(JSON.stringify(first.task)).not.toContain(first.lease_token);

    advance(1_001);
    await attempts.sweep();
    expect(await repository.getTestingRun('run-1')).toMatchObject({
      controlStatus: 'reconcile_required',
      attempts: [expect.objectContaining({ status: 'acceptance_unknown' })]
    });
    expect(await repository.getTestingMachineReservation('machine-1'))
      .toMatchObject({ attemptId: first.task.dispatch_attempt_id, status: 'reconcile_required' });
    await expect(attempts.claim('worker-2', 'machine-2')).rejects.toMatchObject({ code: 'not_found' });
    const oldClaim = await attempts.resolveCurrentClaim('run-1', first.current_claim.claim.claim_id);
    expect(oldClaim).toMatchObject({ is_current: false, status: 'reconcile_required' });

    await expect(attempts.claimReconcile('worker-2', 'machine-2', 'run-1'))
      .rejects.toMatchObject({ code: 'testing_reconcile_unavailable' });
    const second = await attempts.claimNextReconcile('worker-restarted', 'machine-1');
    expect(second.task).toMatchObject({
      operation: 'reconcile',
      dispatch_attempt_id: first.task.dispatch_attempt_id,
      generation: first.task.generation,
      fence_token: first.task.fence_token,
      worker_id: 'worker-restarted'
    });
    expect(second.lease_token).not.toBe(first.lease_token);
    expect(await attempts.resolveCurrentClaim('run-1', first.current_claim.claim.claim_id))
      .toMatchObject({ is_current: false, status: 'superseded' });
    await expect(attempts.heartbeat(binding(first), 10)).rejects.toMatchObject({ code: 'stale_testing_worker' });
    await expect(attempts.assertEffectAllowed(binding(first), 'artifact_upload'))
      .rejects.toMatchObject({ code: 'stale_testing_worker' });
    expect((await attempts.heartbeat(binding(second), 10)).current_claim)
      .toMatchObject({ is_current: true, claim: { operation: 'reconcile' } });
    await expect(attempts.assertEffectAllowed(binding(second), 'runtime_dispatch'))
      .rejects.toMatchObject({ code: 'stale_testing_operation' });
    await expect(attempts.acceptLocal(binding(second)))
      .rejects.toMatchObject({ code: 'stale_testing_operation' });
  });

  it('skips an exhausted reconcile candidate instead of starving later work', async () => {
    const { repository, runs, attempts, advance } = await setup({
      machines: ['machine-1', 'machine-2'],
      leaseSeconds: 1
    });
    await submitTestingRun(runs, 'run-1', 'user-1', testingRequest('reconcile-limit-1'));
    await submitTestingRun(runs, 'run-2', 'user-1', testingRequest('reconcile-limit-2'));
    await attempts.claim('worker-1', 'machine-1');
    await attempts.claim('worker-2', 'machine-2');
    advance(1_001);
    await attempts.sweep();

    const secondRun = await repository.getTestingRun('run-2');
    expect(secondRun?.currentAttemptId).toBeDefined();
    if (secondRun === undefined) throw new Error('missing second testing run');
    await repository.replaceTestingRun({
      ...secondRun,
      recordVersion: secondRun.recordVersion + 1,
      attempts: secondRun.attempts.map((attempt) =>
        attempt.id === secondRun.currentAttemptId ? { ...attempt, machineId: 'machine-1' } : attempt)
    }, secondRun.recordVersion);

    const expected = { task: { qa_run_id: 'run-2' } } as TestingReconcileClaimResult;
    const claimReconcile = vi.spyOn(attempts, 'claimReconcile').mockImplementation(
      async (_workerId, _machineId, runId) => {
        if (runId === 'run-1') {
          throw new TalosError(
            'testing_reconcile_claim_limit',
            'testing reconcile claim limit is exhausted',
            409
          );
        }
        return expected;
      }
    );

    await expect(attempts.claimNextReconcile('worker-restarted', 'machine-1')).resolves.toBe(expected);
    expect(claimReconcile.mock.calls.map((call) => call[2])).toEqual(['run-1', 'run-2']);
  });

  it('enforces the local acceptance no-rerun boundary and allows only exact same-attempt reconcile', async () => {
    const { repository, runs, attempts, advance } = await setup({ machines: ['machine-1', 'machine-2'], leaseSeconds: 1 });
    await submitTestingRun(runs, 'run-1', 'user-1', testingRequest('submit-1'));
    const claim = await attempts.claim('worker-1', 'machine-1');
    const accepted = await attempts.acceptLocal(binding(claim));
    expect(await attempts.acceptLocal(binding(claim))).toMatchObject({
      claim_digest: accepted.claim_digest,
      is_current: true,
      status: 'current'
    });
    const running = await attempts.markRunning(binding(claim));
    expect(await attempts.markRunning(binding(claim))).toMatchObject({
      claim_digest: running.claim_digest,
      is_current: true,
      status: 'current'
    });

    advance(1_001);
    await attempts.sweep();
    expect((await repository.getTestingRun('run-1'))?.controlStatus).toBe('reconcile_required');
    expect(await repository.getTestingMachineReservation('machine-1')).toMatchObject({ status: 'reconcile_required' });
    await expect(attempts.claim('worker-2', 'machine-2')).rejects.toMatchObject({ code: 'not_found' });
    await expect(attempts.commitTerminal(terminal(claim))).rejects.toMatchObject({ code: 'testing_lease_expired' });
    await expect(attempts.commitReconcileTerminal(terminal(claim)))
      .rejects.toMatchObject({ code: 'stale_testing_operation' });
    const reconcile = await attempts.claimReconcile('worker-restarted', 'machine-1', 'run-1');
    await expect(attempts.commitReconcileTerminal(terminal(reconcile, { generation: reconcile.task.generation + 1 })))
      .rejects.toMatchObject({ code: 'stale_testing_generation' });

    const completed = await attempts.commitReconcileTerminal(terminal(reconcile));
    expect(completed).toMatchObject({ controlStatus: 'completed', executionOutcome: 'passed' });
    expect(await attempts.commitReconcileTerminal(terminal(reconcile))).toEqual(completed);
    await expect(attempts.commitTerminal(terminal(reconcile)))
      .rejects.toMatchObject({ code: 'stale_testing_operation' });
    await expect(attempts.commitReconcileTerminal(terminal(reconcile, { evidenceOutcome: 'partial' })))
      .rejects.toMatchObject({ code: 'terminal_commit_conflict' });
    expect(await repository.getTestingMachineReservation('machine-1')).toBeUndefined();
    expect(await attempts.resolveCurrentClaim('run-1', claim.current_claim.claim.claim_id))
      .toMatchObject({ is_current: false, status: 'terminal' });

    const completedAttempt = completed.attempts[0];
    if (completedAttempt === undefined) throw new Error('completed attempt fixture missing');
    await repository.createTestingMachineReservation({
      machineId: completedAttempt.machineId,
      runId: completed.id,
      taskId: completed.task.id,
      attemptId: completedAttempt.id,
      generation: completedAttempt.generation,
      fenceToken: completedAttempt.fenceToken,
      status: 'local_accepted',
      expiresAt: completedAttempt.leaseExpiresAt,
      recordVersion: 1
    });
    await attempts.sweep();
    expect(await repository.getTestingMachineReservation('machine-1')).toBeUndefined();
  });

  it('keeps an abandoned reconcile blocked until late verified cleanup releases the slot', async () => {
    const { repository, runs, attempts, advance } = await setup({ leaseSeconds: 1 });
    await submitTestingRun(runs, 'run-1', 'user-1', testingRequest('submit-1'));
    const claim = await attempts.claim('worker-1', 'machine-1');
    await attempts.acceptLocal(binding(claim));
    advance(1_001);
    await attempts.sweep();
    const reconcile = await attempts.claimReconcile('worker-restarted', 'machine-1', 'run-1');
    advance(TESTING_RECONCILE_WINDOW_MS + 1);
    await expect(attempts.commitReconcileTerminal(terminal(reconcile)))
      .rejects.toMatchObject({ code: 'testing_reconcile_deadline_exceeded' });
    await attempts.sweep();

    const abandoned = await repository.getTestingRun('run-1');
    expect(abandoned).toMatchObject({
      controlStatus: 'abandoned',
      executionOutcome: 'lost_or_inconclusive',
      cleanupOutcome: 'unobserved',
      reconcileClosure: {
        schema_version: 'talos.testing-reconcile-closure/v1',
        attempt_id: claim.task.dispatch_attempt_id,
        execution_disposition: 'lost_or_inconclusive',
        cleanup_disposition: 'residual_blocking',
        key_id: 'testing-claim-key-1'
      }
    });
    if (abandoned?.reconcileClosure === undefined) throw new Error('reconcile closure missing');
    const closureCore = { ...abandoned.reconcileClosure } as Record<string, unknown>;
    const signature = String(closureCore.signature).slice('ed25519:'.length);
    delete closureCore.signature;
    expect(testingReconcileClosureCoreSchema.parse(closureCore)).toEqual(closureCore);
    expect(verify(null, Buffer.from(canonicalJson(closureCore)), attempts.claimPublicKey(), Buffer.from(signature, 'base64url')))
      .toBe(true);
    expect(await repository.getTestingMachineReservation('machine-1'))
      .toMatchObject({ runId: 'run-1', status: 'residual_blocking' });

    await submitTestingRun(runs, 'run-2', 'user-1', testingRequest('submit-2'));
    await expect(attempts.claim('worker-1', 'machine-1')).rejects.toMatchObject({ code: 'not_found' });
    expect((await repository.getTestingRun('run-2'))?.attempts).toHaveLength(0);

    const lateCleanup = terminal(reconcile, {
      executionOutcome: 'lost_or_inconclusive',
      evidenceOutcome: 'not_required',
      uploadOutcome: 'not_required',
      cleanupOutcome: 'complete'
    });
    if (lateCleanup.results === undefined) throw new Error('late cleanup refs fixture missing');
    const {
      case_result_set: _lateCaseResultSet,
      evidence_manifest: _lateEvidenceManifest,
      ...cleanupOnlyResults
    } = lateCleanup.results;
    void _lateCaseResultSet;
    void _lateEvidenceManifest;
    const repaired = await attempts.commitReconcileTerminal({ ...lateCleanup, results: cleanupOnlyResults });
    expect(repaired).toMatchObject({
      controlStatus: 'abandoned',
      executionOutcome: 'lost_or_inconclusive',
      cleanupOutcome: 'complete'
    });
    expect(await repository.getTestingMachineReservation('machine-1')).toBeUndefined();
    await expect(attempts.claim('worker-1', 'machine-1')).resolves.toMatchObject({
      task: { qa_run_id: 'run-2', machine_id: 'machine-1' }
    });
  });

  it('releases a cancelled unknown-acceptance attempt only after an exact Runtime fact', async () => {
    const { repository, runs, attempts, advance } = await setup({ leaseSeconds: 1 });
    await submitTestingRun(runs, 'run-before', 'user-1', testingRequest('submit-before'));
    const before = await attempts.claim('worker-1', 'machine-1');
    await runs.cancel('run-before', 'user-1', cancelRequest('run-before', 'cancel-before'));
    expect((await repository.getTestingRun('run-before'))?.task.status).toBe('cancel_requested');
    await attempts.sweep();
    expect(await repository.getTestingRun('run-before')).toMatchObject({
      controlStatus: 'cancel_requested',
      attempts: [expect.objectContaining({ status: 'acceptance_unknown' })]
    });
    expect(await repository.getTestingMachineReservation('machine-1')).toBeDefined();
    const beforeReconcile = await attempts.claimReconcile('worker-restarted', 'machine-1', 'run-before');
    await attempts.confirmNotLocallyAccepted(binding(beforeReconcile), noLocalAcceptanceFact(before, beforeReconcile));
    expect(await repository.getTestingRun('run-before')).toMatchObject({
      controlStatus: 'cancelled',
      executionOutcome: 'not_started',
      cleanupOutcome: 'unobserved'
    });
    await expect(runs.get('run-before', 'user-1')).resolves.toMatchObject({
      terminal: true,
      terminal_reason: { code: 'cancelled' },
      cleanup_outcome: 'unobserved'
    });
    expect(await repository.getTestingMachineReservation('machine-1')).toBeUndefined();
    const releasedRun = await repository.getTestingRun('run-before');
    if (releasedRun === undefined) throw new Error('released run missing');
    const releasedAttempt = releasedRun.attempts[0];
    if (releasedAttempt === undefined) throw new Error('released attempt missing');
    await repository.createTestingMachineReservation({
      machineId: releasedAttempt.machineId,
      runId: 'run-before',
      taskId: releasedRun.task.id,
      attemptId: releasedAttempt.id,
      generation: releasedAttempt.generation,
      fenceToken: releasedAttempt.fenceToken,
      status: 'reconcile_required',
      expiresAt: releasedAttempt.reconcileDeadline ?? releasedAttempt.leaseExpiresAt,
      recordVersion: 1
    });
    await attempts.sweep();
    expect(await repository.getTestingMachineReservation('machine-1')).toBeUndefined();

    await submitTestingRun(runs, 'run-after', 'user-1', testingRequest('submit-after'));
    const accepted = await attempts.claim('worker-1', 'machine-1');
    await attempts.acceptLocal(binding(accepted));
    await runs.cancel('run-after', 'user-1', cancelRequest('run-after', 'cancel-after'));
    advance(1_001);
    await attempts.sweep();
    expect(await repository.getTestingRun('run-after')).toMatchObject({
      controlStatus: 'cancel_requested',
      attempts: [expect.objectContaining({ status: 'reconcile_required' })]
    });
    expect(await repository.getTestingMachineReservation('machine-1')).toBeDefined();
    await expect(attempts.commitTerminal(terminal(accepted)))
      .rejects.toMatchObject({ code: 'testing_lease_expired' });
    const reconcile = await attempts.claimReconcile('worker-restarted', 'machine-1', 'run-after');
    const cancelled = await attempts.commitReconcileTerminal(terminal(reconcile, {
      controlStatus: 'cancelled',
      executionOutcome: 'cancelled'
    }));
    expect(cancelled.controlStatus).toBe('cancelled');
    expect(await repository.getTestingMachineReservation('machine-1')).toBeUndefined();
  });

  it('fails closed for missing or invalid no-local-acceptance verification', async () => {
    const { repository, runs, attempts } = await setup({ leaseSeconds: 1 });
    await submitTestingRun(runs, 'run-fact', 'user-1', testingRequest('submit-fact'));
    const start = await attempts.claim('worker-1', 'machine-1');
    await runs.cancel('run-fact', 'user-1', cancelRequest('run-fact', 'cancel-fact'));
    await attempts.sweep();
    const firstReconcile = await attempts.claimReconcile('worker-restarted', 'machine-1', 'run-fact');
    const staleBarrierFact = noLocalAcceptanceFact(start, firstReconcile);
    const reconcile = await attempts.claimReconcile('worker-current', 'machine-1', 'run-fact');

    await expect(attempts.confirmNotLocallyAccepted(binding(reconcile), staleBarrierFact))
      .rejects.toMatchObject({ code: 'stale_no_local_acceptance_fact' });

    await expect(attempts.confirmNotLocallyAccepted(binding(reconcile), {
      ...noLocalAcceptanceFact(start, reconcile),
      admission_nonce: 'different-admission-nonce-1234'
    })).rejects.toMatchObject({ code: 'stale_no_local_acceptance_fact' });
    expect(await repository.getTestingMachineReservation('machine-1')).toBeDefined();

    const withoutVerifier = new TestingAttemptService(repository, {
      claimSigningKey: signingKey,
      authorizationProvider,
      clock: () => Date.parse(start.current_claim.observed_at),
      leaseSeconds: 1
    });
    await expect(withoutVerifier.confirmNotLocallyAccepted(binding(reconcile), noLocalAcceptanceFact(start, reconcile)))
      .rejects.toMatchObject({ code: 'testing_fact_verifier_unavailable' });
    expect(await repository.getTestingMachineReservation('machine-1')).toBeDefined();

    const rejectingVerifier = new TestingAttemptService(repository, {
      claimSigningKey: signingKey,
      authorizationProvider,
      runtimeFactVerifier: { verifyTerminalNoLocalAcceptance: async () => undefined },
      clock: () => Date.parse(start.current_claim.observed_at),
      leaseSeconds: 1
    });
    await expect(rejectingVerifier.confirmNotLocallyAccepted(binding(reconcile), noLocalAcceptanceFact(start, reconcile)))
      .rejects.toMatchObject({ code: 'invalid_no_local_acceptance_fact' });
    expect(await repository.getTestingMachineReservation('machine-1')).toBeDefined();

    const unavailableVerifier = new TestingAttemptService(repository, {
      claimSigningKey: signingKey,
      authorizationProvider,
      runtimeFactVerifier: {
        verifyTerminalNoLocalAcceptance: async () => { throw new Error('Runtime authority timeout'); }
      },
      clock: () => Date.parse(start.current_claim.observed_at),
      leaseSeconds: 1
    });
    await expect(unavailableVerifier.confirmNotLocallyAccepted(
      binding(reconcile),
      noLocalAcceptanceFact(start, reconcile)
    )).rejects.toMatchObject({ code: 'testing_fact_verifier_unavailable', status: 503 });
    expect(await repository.getTestingMachineReservation('machine-1')).toBeDefined();
    expect(await repository.getTestingRun('run-fact')).toMatchObject({ controlStatus: 'cancel_requested' });
  });

  it('rejects foreign terminal refs, fails closed on authorization outage, and bounds attempts', async () => {
    const { repository, runs, attempts } = await setup({ leaseSeconds: 1 });
    await submitTestingRun(runs, 'run-binding', 'user-1', testingRequest('submit-binding'));
    const claim = await attempts.claim('worker-1', 'machine-1');
    await attempts.acceptLocal(binding(claim));
    const foreignResults = terminal(claim).results;
    if (foreignResults === undefined) throw new Error('terminal refs fixture missing');
    const foreignBinding = { ...foreignResults.binding, run_id: 'run-foreign' };
    await expect(attempts.commitTerminal(terminal(claim, {
      results: {
        ...foreignResults,
        binding: foreignBinding,
        case_result_set: foreignResults.case_result_set === undefined
          ? undefined
          : { ...foreignResults.case_result_set, binding: foreignBinding },
        evidence_manifest: foreignResults.evidence_manifest === undefined
          ? undefined
          : { ...foreignResults.evidence_manifest, binding: foreignBinding },
        cleanup_receipt: foreignResults.cleanup_receipt === undefined
          ? undefined
          : { ...foreignResults.cleanup_receipt, binding: foreignBinding }
      }
    }))).rejects.toMatchObject({ code: 'stale_terminal_binding' });
    await attempts.commitTerminal(terminal(claim));

    await submitTestingRun(runs, 'run-auth', 'user-1', testingRequest('submit-auth'));
    const outage = new TestingAttemptService(repository, {
      claimSigningKey: signingKey,
      authorizationProvider: { issueStartAuthorization: async () => { throw new Error('unavailable'); } },
      clock: () => Date.parse('2026-08-22T00:00:00.000Z'),
      leaseSeconds: 1
    });
    await expect(outage.claim('worker-1', 'machine-1'))
      .rejects.toMatchObject({ code: 'testing_authorization_unavailable' });
    expect((await repository.getTestingRun('run-auth'))?.attempts[0]?.status).toBe('released');
    expect(await repository.getTestingMachineReservation('machine-1')).toBeUndefined();
    await runs.cancel('run-auth', 'user-1', cancelRequest('run-auth', 'cancel-auth'));
    await attempts.sweep();

    await submitTestingRun(runs, 'run-limit', 'user-1', testingRequest('submit-limit'));
    for (let index = 0; index < TESTING_MAX_ATTEMPTS; index += 1) {
      await expect(outage.claim('worker-1', 'machine-1'))
        .rejects.toMatchObject({ code: 'testing_authorization_unavailable' });
    }
    await expect(outage.claim('worker-1', 'machine-1')).rejects.toMatchObject({ code: 'not_found' });
    expect(await repository.getTestingRun('run-limit')).toMatchObject({
      controlStatus: 'failed',
      cleanupOutcome: 'unobserved',
      safeError: { code: 'attempt_limit_exceeded', retryable: false }
    });
    await expect(runs.get('run-limit', 'user-1')).resolves.toMatchObject({
      terminal: true,
      terminal_reason: { code: 'attempt_limit_exceeded' },
      cleanup_outcome: 'unobserved'
    });
  });

  it('does not treat an admitted start authorization as the attempt lease', async () => {
    const { repository, runs, advance, now } = await setup();
    await submitTestingRun(runs, 'run-short-auth', 'user-1', testingRequest('submit-short-auth'));
    const shortAuthorization = new TestingAttemptService(repository, {
      claimSigningKey: signingKey,
      authorizationProvider: {
        issueStartAuthorization: async (context) => ({
          ref: `authorization://local-qa-request/${context.attemptId}`,
          digest,
          expires_at: new Date(now() + 500).toISOString()
        })
      },
      clock: now,
      leaseSeconds: 10
    });
    const claim = await shortAuthorization.claim('worker-1', 'machine-1');
    advance(501);
    await expect(shortAuthorization.acceptLocal(binding(claim)))
      .resolves.toMatchObject({ is_current: true, status: 'current' });
  });
});
