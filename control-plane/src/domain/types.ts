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
  workerId?: string;
  machineId?: string;
  findings: readonly TaskFinding[];
  artifacts: readonly Artifact[];
  input?: TaskInput;
  error?: { code: string; message: string };
  handoff?: { url: string; expiresAt: string };
  pendingActionId?: string;
  lastActionId?: string;
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

export interface PendingSessionAction {
  id: string;
  taskId: string;
  action: SessionAction;
  state: 'pending' | 'dispatched';
  createdAt: string;
}

export interface SessionActionResult {
  actionId: string;
  taskId: string;
  result: unknown;
  completedAt: string;
}

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
  online: boolean;
  workerTokenHash: string;
}

export interface Profile {
  id: string;
  userId: string;
  machineId?: string;
  lockedByTaskId?: string;
  lockExpiresAt?: string;
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
