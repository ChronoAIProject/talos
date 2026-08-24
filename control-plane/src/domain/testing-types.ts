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
  TestingUploadOutcome
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

export interface TestingRunRecord {
  readonly id: string;
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly request: TestingToolRequest;
  readonly acceptance: TestingRunAcceptance;
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
  readonly createdAt: string;
  readonly updatedAt: string;
}
