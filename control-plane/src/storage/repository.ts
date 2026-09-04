import type { HandoffLink, Machine, MachineLeaseReservation, PendingSessionAction, Pool, Profile, SessionActionResult, Task, TaskClaimGuard, TaskInput, WebhookEvent } from '../domain/types.js';
import type { TestingAttemptStatus, TestingMachineReservationRecord, TestingRunRecord } from '../domain/testing-types.js';

export interface TestingAttemptMutationGuard {
  readonly attemptId: string;
  readonly operation: 'start' | 'reconcile';
  readonly generation: number;
  readonly fenceToken: string;
  readonly leaseId: string;
  readonly leaseExpiresAt: string;
}

export interface TestingAttemptDispatchGuard extends TestingAttemptMutationGuard {
  readonly status: TestingAttemptStatus;
  readonly dispatchLeaseExpiresAt: string;
  readonly dispatchAuthorizationExpiresAt: string;
}

export interface Repository {
  ping(): Promise<void>;
  close(): Promise<void>;
  getTask(id: string): Promise<Task | undefined>;
  saveTask(task: Task): Promise<void>;
  claimTask(task: Task, expectedClaimGeneration: number): Promise<Task | undefined>;
  replaceTaskForClaim(task: Task, guard: TaskClaimGuard): Promise<boolean>;
  replaceSubmittedTask(task: Task, expectedClaimGeneration: number): Promise<boolean>;
  listQueuedTasks(): Promise<readonly Task[]>;
  listTasks(): Promise<readonly Task[]>;
  getPool(id: string): Promise<Pool | undefined>;
  savePool(pool: Pool): Promise<void>;
  listPoolsByOwner(ownerUserId: string): Promise<readonly Pool[]>;
  listMachines(poolId?: string): Promise<readonly Machine[]>;
  getMachine(id: string): Promise<Machine | undefined>;
  saveMachine(machine: Machine): Promise<void>;
  reserveMachineLease(machineId: string, reservation: MachineLeaseReservation): Promise<boolean>;
  renewMachineLease(machineId: string, reservation: MachineLeaseReservation): Promise<boolean>;
  releaseMachineLease(machineId: string, reservation: Omit<MachineLeaseReservation, 'expiresAt'>): Promise<boolean>;
  getProfile(id: string): Promise<Profile | undefined>;
  saveProfile(profile: Profile): Promise<void>;
  acquireProfileLease(profileId: string, userId: string, machineId: string, reservation: MachineLeaseReservation, observedNow: number): Promise<Profile | undefined>;
  releaseProfileLease(profileId: string, reservation: Omit<MachineLeaseReservation, 'expiresAt'>): Promise<boolean>;
  listProfiles(): Promise<readonly Profile[]>;
  listProfilesByUser(userId: string): Promise<readonly Profile[]>;
  saveHandoff(link: HandoffLink): Promise<void>;
  getHandoff(id: string): Promise<HandoffLink | undefined>;
  saveWebhook(event: WebhookEvent): Promise<void>;
  getWebhook(id: string): Promise<WebhookEvent | undefined>;
  listWebhooks(): Promise<readonly WebhookEvent[]>;
  savePendingInput(taskId: string, input: TaskInput): Promise<void>;
  takePendingInput(taskId: string): Promise<TaskInput | undefined>;
  enqueueSessionAction(action: PendingSessionAction): Promise<boolean>;
  getPendingSessionAction(taskId: string): Promise<PendingSessionAction | undefined>;
  takePendingSessionAction(taskId: string): Promise<PendingSessionAction | undefined>;
  requeueSessionAction(taskId: string): Promise<void>;
  finalizeSessionAction(
    result: SessionActionResult,
    expectedStates: readonly PendingSessionAction['state'][]
  ): Promise<boolean>;
  getSessionActionResult(actionId: string): Promise<SessionActionResult | undefined>;
  markSessionActionPending(taskId: string, actionId: string, updatedAt: string): Promise<void>;
  markSessionActionCompleted(taskId: string, actionId: string, completedAt: string): Promise<void>;
  createTestingRun(run: TestingRunRecord): Promise<boolean>;
  getTestingRun(id: string): Promise<TestingRunRecord | undefined>;
  getTestingRunByIdempotencyKey(userId: string, idempotencyKey: string): Promise<TestingRunRecord | undefined>;
  listTestingRuns(): Promise<readonly TestingRunRecord[]>;
  replaceTestingRun(run: TestingRunRecord, expectedRecordVersion: number): Promise<boolean>;
  replaceTestingRunWithinDeadline(
    run: TestingRunRecord,
    expectedRecordVersion: number,
    deadline: 'run' | 'reconcile',
    observedNow: number
  ): Promise<boolean>;
  replaceTestingRunForAttempt(
    run: TestingRunRecord,
    expectedRecordVersion: number,
    deadline: 'run' | 'reconcile',
    guard: TestingAttemptMutationGuard,
    observedNow: number
  ): Promise<boolean>;
  replaceTestingRunForDispatch(
    run: TestingRunRecord,
    expectedRecordVersion: number,
    deadline: 'run' | 'reconcile',
    guard: TestingAttemptDispatchGuard,
    observedNow: number
  ): Promise<boolean>;
  createTestingMachineReservation(reservation: TestingMachineReservationRecord): Promise<boolean>;
  getTestingMachineReservation(machineId: string): Promise<TestingMachineReservationRecord | undefined>;
  listTestingMachineReservations(): Promise<readonly TestingMachineReservationRecord[]>;
  replaceTestingMachineReservation(
    reservation: TestingMachineReservationRecord,
    expectedRecordVersion: number
  ): Promise<boolean>;
  releaseTestingMachineReservation(machineId: string, attemptId: string): Promise<boolean>;
}
