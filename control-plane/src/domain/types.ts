import type { BrowserAction, TestingTask as TestingTaskPayload } from '@talos/testing-protocol';

export type TaskKind = 'browse' | 'computer_use' | 'testing';
export type TaskMode = 'read_only' | 'act';
export type TaskInteraction = 'autonomous' | 'interactive' | 'managed';
export type TaskStatus =
  | 'submitted'
  | 'claimed'
  | 'running'
  | 'needs_input'
  | 'handoff'
  | 'closing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskClaimRecoveryReason =
  | 'partial_claim_identity'
  | 'invalid_claim_generation'
  | 'invalid_claim_credentials'
  | 'invalid_lease_expiry'
  | 'active_claim_missing_credentials'
  | 'active_claim_marked_released'
  | 'legacy_profile_identity_conflict';

export interface TaskClaimRecovery {
  schemaVersion: 'talos.task-claim-recovery/v1';
  recoveryId: string;
  kind: 'legacy' | 'malformed';
  phase: 'draining' | 'finalizing' | 'quarantined';
  sourceStatus: TaskStatus;
  sourceMachineId?: string;
  sourceProfileId?: string;
  restoredQueuePriority: number;
  reasonCode?: TaskClaimRecoveryReason;
  startedAt: string;
  updatedAt: string;
}

export type CapabilityTag =
  | 'os'
  | 'region'
  | 'residential_ip'
  | 'headed_display'
  | 'browser'
  | 'computer_use';

export interface TaskConstraints {
  budget?: number;
  deadline?: string;
  requirements?: Partial<Record<CapabilityTag, string | boolean>>;
}

export interface TaskInput {
  kind: 'choice' | 'text' | 'otp';
  value: string;
}

export interface Artifact {
  id: string;
  name: string;
  contentType: string;
  size: number;
  uri: string;
  createdAt: string;
}

export interface TaskFinding {
  key: string;
  value: string | number | boolean | null | string[];
}

interface TaskBase {
  id: string;
  userId: string;
  goal: string;
  siteHint?: string;
  profileId?: string;
  poolId?: string;
  requesterGroups?: readonly string[];
  constraints: TaskConstraints;
  mode: TaskMode;
  callback?: string;
  status: TaskStatus;
  queuePriority?: number;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  leaseExpiresAt?: string;
  leaseToken?: string;
  claimId?: string;
  claimGeneration?: number;
  taskVersion?: number;
  claimCommitted?: boolean;
  claimReleased?: boolean;
  claimQueuePriority?: number;
  workerId?: string;
  machineId?: string;
  findings: readonly TaskFinding[];
  artifacts: readonly Artifact[];
  input?: TaskInput;
  error?: { code: string; message: string };
  handoff?: { url: string; expiresAt: string };
  pendingActionId?: string;
  lastActionId?: string;
  sessionActions?: readonly SessionActionRecord[];
  claimRecovery?: TaskClaimRecovery;
}

export interface BrowserTask extends TaskBase {
  kind: 'browse' | 'computer_use';
  interaction: 'autonomous' | 'interactive';
}

export interface TestingQueueTask extends TaskBase {
  kind: 'testing';
  interaction: 'managed';
  testing: TestingTaskPayload;
}

export type Task = BrowserTask | TestingQueueTask;

export interface PublicTask {
  id: string;
  userId: string;
  kind: TaskKind;
  goal: string;
  siteHint?: string;
  profileId?: string;
  poolId?: string;
  constraints: TaskConstraints;
  mode: TaskMode;
  interaction: TaskInteraction;
  callback?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  findings: readonly TaskFinding[];
  artifacts: readonly Artifact[];
  error?: { code: string; message: string };
  handoff?: { url: string; expiresAt: string };
}

export type SessionAction = BrowserAction;

export interface ActionDispatchBinding {
  schemaVersion: 'talos.internal-action-dispatch-binding/v1';
  dispatchId: string;
  dispatchGeneration: number;
  workerId: string;
  machineId: string;
  leaseTokenDigest: string;
}

export interface PendingSessionAction {
  schemaVersion: 'talos.internal-session-action/v1';
  id: string;
  taskId: string;
  action: SessionAction;
  state: 'pending' | 'dispatched';
  dispatchGeneration: number;
  dispatchBinding?: ActionDispatchBinding;
  dispatchClaimId?: string;
  dispatchClaimGeneration?: number;
  createdAt: string;
}

export interface SessionActionResult {
  actionId: string;
  taskId: string;
  result: unknown;
  completedAt: string;
  dispatchBinding?: ActionDispatchBinding;
  unbound?: true;
}

export type SessionActionRecord = PendingSessionAction | (Omit<PendingSessionAction, 'state'> & {
  state: 'completed';
  completion: SessionActionResult;
});

export interface Pool {
  id: string;
  visibility: 'private' | 'org' | 'platform';
  ownerUserId?: string;
  sharedWithGroups?: readonly string[];
  tags: Readonly<Record<string, string | boolean>>;
}

export interface Machine {
  id: string;
  poolId: string;
  tags: Readonly<Record<string, string | boolean>>;
  capacity: number;
  activeLeases: number;
  leaseReservations?: readonly MachineLeaseReservation[];
  online: boolean;
  workerTokenHash: string;
}

export interface Profile {
  id: string;
  userId: string;
  machineId?: string;
  lockedByTaskId?: string;
  lockedByClaimId?: string;
  lockedByClaimGeneration?: number;
  lockExpiresAt?: string;
}

export interface TaskClaimGuard {
  claimId: string;
  claimGeneration: number;
  taskVersion: number;
  status: TaskStatus;
}

export interface TaskActiveClaimGuard extends TaskClaimGuard {
  leaseExpiresAt: string;
}

export interface TaskRecoveryGuard {
  status: TaskStatus;
  taskVersion: number;
  updatedAt: string;
  claimId?: string;
  claimGeneration?: number;
  recoveryId?: string;
  recoveryPhase?: TaskClaimRecovery['phase'];
}

export interface MachineLeaseReservation {
  claimId: string;
  claimGeneration: number;
  taskId: string;
  expiresAt: string;
}

export interface HandoffLink {
  id: string;
  taskId: string;
  userId: string;
  url: string;
  expiresAt: string;
  used: boolean;
}

export interface Lease {
  taskId: string;
  workerId: string;
  machineId: string;
  expiresAt: string;
}

export interface WebhookEvent {
  id: string;
  type: 'task.state_changed' | 'task.needs_input' | 'task.handoff_requested' | 'task.completed';
  taskId: string;
  userId: string;
  timestamp: string;
  payload: Record<string, unknown>;
  delivery: { status: 'pending' | 'delivered' | 'failed'; attempts: number; lastAttemptAt?: string; lastError?: string };
}
