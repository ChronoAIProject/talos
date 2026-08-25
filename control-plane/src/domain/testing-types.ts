import type {
  TestingCancelAck,
  TestingCleanupOutcome,
  TestingControlStatus,
  TestingEvidenceOutcome,
  TestingExecutionOutcome,
  TestingRunAttemptProjection,
  TestingRunAcceptance,
  TestingRunEvent,
  TestingRunProgress,
  TestingRunSummary,
  TestingSafeError,
  TestingTerminalRefs,
  TestingToolRequest,
  TestingUploadOutcome,
  TestingTask,
  TestingLeaseClaimReference,
  TestingNoLocalAcceptanceFact,
  TestingReconcileClosure
} from '@talos/testing-protocol';

export interface TestingCursorPageRecord {
  readonly events: readonly TestingRunEvent[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

export interface TestingCancelRecord {
  readonly requestDigest: string;
  readonly acknowledgement: TestingCancelAck;
}

export type TestingTaskRecordStatus =
  | 'submitted'
  | 'reserved'
  | 'claimed'
  | 'local_accepted'
  | 'running'
  | 'cancel_requested'
  | 'acceptance_unknown'
  | 'reconcile_required'
  | 'closing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'abandoned';

export interface TestingTaskRecord {
  readonly id: string;
  readonly status: TestingTaskRecordStatus;
  readonly nextGeneration: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TestingAttemptStatus =
  | 'reserved'
  | 'claimed'
  | 'local_accepted'
  | 'running'
  | 'closing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'released'
  | 'acceptance_unknown'
  | 'reconcile_required'
  | 'abandoned';

export interface TestingAttemptClaimRecord {
  readonly claimId: string;
  readonly operation: 'start' | 'reconcile';
  readonly workerId: string;
  readonly leaseId: string;
  readonly leaseTokenHash: string;
  readonly leaseClaim: TestingLeaseClaimReference;
  readonly authorization?: TestingTask['local_request_authorization'];
  readonly leaseExpiresAt: string;
  readonly issuedAt: string;
}

export interface TestingAttemptRecord extends TestingAttemptClaimRecord {
  readonly id: string;
  readonly generation: number;
  readonly status: TestingAttemptStatus;
  readonly machineId: string;
  readonly fenceToken: string;
  readonly admissionNonce: string;
  readonly priorClaims: readonly TestingAttemptClaimRecord[];
  readonly deadline: string;
  readonly localAcceptedAt?: string;
  readonly runtimeEventSequence?: number;
  readonly reconcileDeadline?: string;
  readonly noLocalAcceptanceFact?: TestingNoLocalAcceptanceFact;
  readonly reservationCancellationReceipt?: {
    readonly schemaVersion: 'talos.testing-reservation-cancellation-receipt/v1';
    readonly reason: 'lease_expired' | 'cancelled_before_acceptance' | 'deadline_exceeded' | 'authorization_unavailable' | 'claim_conflict';
    readonly releasedAt: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TestingReservationStatus =
  | 'reserved'
  | 'claimed'
  | 'local_accepted'
  | 'reconcile_required'
  | 'residual_blocking';

export interface TestingMachineReservationRecord {
  readonly machineId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly fenceToken: string;
  readonly status: TestingReservationStatus;
  readonly expiresAt: string;
  readonly recordVersion: number;
}

export interface TestingPlacementRecord {
  readonly schemaVersion: 'talos.testing-placement-decision/v1';
  readonly policyId: string;
  readonly ruleId: string;
  readonly poolId: string;
  readonly caller: {
    readonly type: 'user' | 'group';
    readonly value: string;
  };
  readonly repositoryId: string;
  readonly environmentProfile: {
    readonly ref: string;
    readonly digest: string;
  };
  readonly inputVerification: {
    readonly schemaVersion: 'talos.testing-placement-input-verification/v1';
    readonly verifierId: string;
    readonly verificationId: string;
    readonly verificationDigest: string;
  };
  readonly executionPolicy: {
    readonly ref: string;
    readonly digest: string;
  };
  readonly budgets: {
    readonly ref: string;
    readonly digest: string;
  };
  readonly testingPackage: {
    readonly packageId: string;
    readonly version: string;
    readonly digest: string;
  };
  readonly capability: {
    readonly testingRuntime: 'local-qa-mvp/v1';
    readonly taskContract: 'talos.testing-task/v1';
    readonly backend: 'browser';
    readonly browser: 'chromium';
    readonly os: 'darwin';
    readonly arch: 'arm64';
    readonly headedDisplay: true;
    readonly maxTestingConcurrency: 1;
  };
  readonly selectedAt: string;
}

export interface TestingRunRecord {
  readonly id: string;
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly request: TestingToolRequest;
  readonly requesterGroups: readonly string[];
  readonly placement: TestingPlacementRecord;
  readonly acceptance: TestingRunAcceptance;
  readonly deadlineAt: string;
  readonly reconcileDeadlineAt?: string;
  readonly recordVersion: number;
  readonly snapshotVersion: number;
  readonly cursorEpoch: number;
  readonly controlStatus: TestingControlStatus;
  readonly executionOutcome: TestingExecutionOutcome;
  readonly evidenceOutcome: TestingEvidenceOutcome;
  readonly uploadOutcome: TestingUploadOutcome;
  readonly cleanupOutcome: TestingCleanupOutcome;
  readonly attempt?: TestingRunAttemptProjection;
  readonly progress: TestingRunProgress;
  readonly summary?: TestingRunSummary;
  readonly results?: TestingTerminalRefs;
  readonly safeError?: TestingSafeError;
  readonly events: readonly TestingRunEvent[];
  readonly cursorPages: Readonly<Record<string, TestingCursorPageRecord>>;
  readonly cancelRecords: Readonly<Record<string, TestingCancelRecord>>;
  readonly task: TestingTaskRecord;
  readonly attempts: readonly TestingAttemptRecord[];
  readonly currentAttemptId?: string;
  readonly reconcileClosure?: TestingReconcileClosure;
  readonly createdAt: string;
  readonly updatedAt: string;
}
