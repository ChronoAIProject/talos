import type { HandoffLink, Machine, MachineLeaseReservation, PendingSessionAction, Pool, Profile, SessionActionResult, Task, TaskClaimGuard, TaskInput, WebhookEvent } from '../domain/types.js';
import type { TestingMachineReservationRecord, TestingRunRecord } from '../domain/testing-types.js';
import type { Repository, TestingAttemptDispatchGuard, TestingAttemptMutationGuard } from './repository.js';

const isFutureTimestamp = (value: string | undefined, observedNow: number): boolean => {
  if (value === undefined) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > observedNow;
};

const isValidClaim = (task: Task, expectedClaimGeneration: number): boolean =>
  task.kind !== 'testing' &&
  task.status === 'claimed' &&
  task.claimId !== undefined &&
  task.claimGeneration === expectedClaimGeneration + 1 &&
  task.claimGeneration > 0 &&
  task.workerId !== undefined &&
  task.machineId !== undefined &&
  task.leaseToken !== undefined &&
  task.leaseExpiresAt !== undefined;

export class MemoryRepository implements Repository {
  private readonly tasks = new Map<string, Task>();
  private readonly pools = new Map<string, Pool>();
  private readonly machines = new Map<string, Machine>();
  private readonly profiles = new Map<string, Profile>();
  private readonly handoffs = new Map<string, HandoffLink>();
  private readonly webhooks = new Map<string, WebhookEvent>();
  private readonly pendingInputs = new Map<string, TaskInput>();
  private readonly pendingActions = new Map<string, PendingSessionAction>();
  private readonly actionResults = new Map<string, SessionActionResult>();
  private readonly testingRuns = new Map<string, TestingRunRecord>();
  private readonly testingRunIdempotency = new Map<string, string>();
  private readonly testingMachineReservations = new Map<string, TestingMachineReservationRecord>();

  public async ping(): Promise<void> {}

  public async close(): Promise<void> {}

  public async getTask(id: string): Promise<Task | undefined> {
    return this.tasks.get(id);
  }

  public async saveTask(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
  }

  public async claimTask(task: Task, expectedClaimGeneration: number): Promise<Task | undefined> {
    if (!isValidClaim(task, expectedClaimGeneration)) return undefined;
    const current = this.tasks.get(task.id);
    if (current?.status !== 'submitted' || (current.claimGeneration ?? 0) !== expectedClaimGeneration) return undefined;
    this.tasks.set(task.id, task);
    return task;
  }

  public async replaceTaskForClaim(task: Task, guard: TaskClaimGuard): Promise<boolean> {
    if (task.claimId !== guard.claimId || task.claimGeneration !== guard.claimGeneration) return false;
    const current = this.tasks.get(task.id);
    if (
      current?.claimId !== guard.claimId ||
      current.claimGeneration !== guard.claimGeneration ||
      current.status !== guard.status
    ) return false;
    this.tasks.set(task.id, task);
    return true;
  }

  public async replaceSubmittedTask(task: Task, expectedClaimGeneration: number): Promise<boolean> {
    if ((task.claimGeneration ?? 0) !== expectedClaimGeneration) return false;
    const current = this.tasks.get(task.id);
    if (current?.status !== 'submitted' || (current.claimGeneration ?? 0) !== expectedClaimGeneration) return false;
    this.tasks.set(task.id, task);
    return true;
  }

  public async listQueuedTasks(): Promise<readonly Task[]> {
    return [...this.tasks.values()]
      .filter((task) => task.status === 'submitted')
      .sort(
        (a, b) =>
          (a.queuePriority ?? 0) - (b.queuePriority ?? 0) ||
          a.createdAt.localeCompare(b.createdAt)
      );
  }
  public async listTasks(): Promise<readonly Task[]> {
    return [...this.tasks.values()];
  }

  public async getPool(id: string): Promise<Pool | undefined> {
    return this.pools.get(id);
  }

  public async savePool(pool: Pool): Promise<void> {
    this.pools.set(pool.id, pool);
  }

  public async listPoolsByOwner(ownerUserId: string): Promise<readonly Pool[]> {
    return [...this.pools.values()].filter((pool) => pool.ownerUserId === ownerUserId);
  }

  public async listMachines(poolId?: string): Promise<readonly Machine[]> {
    return [...this.machines.values()].filter(
      (machine) => poolId === undefined || machine.poolId === poolId
    );
  }
  public async getMachine(id: string): Promise<Machine | undefined> {
    return this.machines.get(id);
  }

  public async saveMachine(machine: Machine): Promise<void> {
    this.machines.set(machine.id, machine);
  }

  public async reserveMachineLease(machineId: string, reservation: MachineLeaseReservation): Promise<boolean> {
    const machine = this.machines.get(machineId);
    if (machine === undefined) return false;
    const reservations = machine.leaseReservations ?? [];
    if (reservations.some((entry) => entry.claimId === reservation.claimId && entry.claimGeneration === reservation.claimGeneration)) return true;
    if (!machine.online || machine.activeLeases >= machine.capacity) return false;
    this.machines.set(machineId, {
      ...machine,
      activeLeases: machine.activeLeases + 1,
      leaseReservations: [...reservations, reservation]
    });
    return true;
  }

  public async renewMachineLease(machineId: string, reservation: MachineLeaseReservation): Promise<boolean> {
    const machine = this.machines.get(machineId);
    if (machine === undefined) return false;
    const reservations = machine.leaseReservations ?? [];
    const index = reservations.findIndex((entry) => entry.claimId === reservation.claimId && entry.claimGeneration === reservation.claimGeneration && entry.taskId === reservation.taskId);
    if (index < 0) return false;
    const next = [...reservations];
    next[index] = reservation;
    this.machines.set(machineId, { ...machine, leaseReservations: next });
    return true;
  }

  public async releaseMachineLease(machineId: string, reservation: Omit<MachineLeaseReservation, 'expiresAt'>): Promise<boolean> {
    const machine = this.machines.get(machineId);
    if (machine === undefined) return false;
    const reservations = machine.leaseReservations ?? [];
    const next = reservations.filter((entry) => !(
      entry.claimId === reservation.claimId &&
      entry.claimGeneration === reservation.claimGeneration &&
      entry.taskId === reservation.taskId
    ));
    if (next.length === reservations.length) return false;
    this.machines.set(machineId, { ...machine, activeLeases: machine.activeLeases - 1, leaseReservations: next });
    return true;
  }

  public async getProfile(id: string): Promise<Profile | undefined> {
    return this.profiles.get(id);
  }

  public async saveProfile(profile: Profile): Promise<void> {
    this.profiles.set(profile.id, profile);
  }

  public async acquireProfileLease(profileId: string, userId: string, machineId: string, reservation: MachineLeaseReservation, observedNow: number): Promise<Profile | undefined> {
    const profile = this.profiles.get(profileId);
    if (profile === undefined || profile.userId !== userId) return undefined;
    const sameClaim = profile.lockedByClaimId === reservation.claimId && profile.lockedByClaimGeneration === reservation.claimGeneration;
    const expired = profile.lockExpiresAt === undefined || Date.parse(profile.lockExpiresAt) <= observedNow;
    if (!sameClaim && profile.lockedByTaskId !== undefined && !expired) return undefined;
    const updated: Profile = {
      ...profile,
      machineId,
      lockedByTaskId: reservation.taskId,
      lockedByClaimId: reservation.claimId,
      lockedByClaimGeneration: reservation.claimGeneration,
      lockExpiresAt: reservation.expiresAt
    };
    this.profiles.set(profileId, updated);
    return updated;
  }


  public async releaseProfileLease(profileId: string, reservation: Omit<MachineLeaseReservation, 'expiresAt'>): Promise<boolean> {
    const profile = this.profiles.get(profileId);
    if (
      profile?.lockedByTaskId !== reservation.taskId ||
      profile.lockedByClaimId !== reservation.claimId ||
      profile.lockedByClaimGeneration !== reservation.claimGeneration
    ) return false;
    this.profiles.set(profileId, {
      id: profile.id,
      userId: profile.userId,
      ...(profile.machineId === undefined ? {} : { machineId: profile.machineId })
    });
    return true;
  }

  public async listProfiles(): Promise<readonly Profile[]> {
    return [...this.profiles.values()];
  }

  public async listProfilesByUser(userId: string): Promise<readonly Profile[]> {
    return [...this.profiles.values()].filter((profile) => profile.userId === userId);
  }

  public async saveHandoff(link: HandoffLink): Promise<void> {
    this.handoffs.set(link.id, link);
  }

  public async getHandoff(id: string): Promise<HandoffLink | undefined> {
    return this.handoffs.get(id);
  }

  public async saveWebhook(event: WebhookEvent): Promise<void> {
    this.webhooks.set(event.id, event);
  }

  public async getWebhook(id: string): Promise<WebhookEvent | undefined> {
    return this.webhooks.get(id);
  }

  public async listWebhooks(): Promise<readonly WebhookEvent[]> {
    return [...this.webhooks.values()];
  }

  public async savePendingInput(taskId: string, input: TaskInput): Promise<void> {
    this.pendingInputs.set(taskId, input);
  }

  public async takePendingInput(taskId: string): Promise<TaskInput | undefined> {
    const input = this.pendingInputs.get(taskId);
    this.pendingInputs.delete(taskId);
    return input;
  }

  public async enqueueSessionAction(action: PendingSessionAction): Promise<boolean> {
    if (this.pendingActions.has(action.taskId)) return false;
    this.pendingActions.set(action.taskId, action);
    return true;
  }

  public async getPendingSessionAction(taskId: string): Promise<PendingSessionAction | undefined> {
    return this.pendingActions.get(taskId);
  }

  public async takePendingSessionAction(taskId: string): Promise<PendingSessionAction | undefined> {
    const action = this.pendingActions.get(taskId);
    if (action === undefined || action.state !== 'pending') return undefined;
    const dispatched: PendingSessionAction = { ...action, state: 'dispatched' };
    this.pendingActions.set(taskId, dispatched);
    return dispatched;
  }

  public async requeueSessionAction(taskId: string): Promise<void> {
    const action = this.pendingActions.get(taskId);
    if (action?.state === 'dispatched') this.pendingActions.set(taskId, { ...action, state: 'pending' });
  }

  public async finalizeSessionAction(
    result: SessionActionResult,
    expectedStates: readonly PendingSessionAction['state'][]
  ): Promise<boolean> {
    const action = this.pendingActions.get(result.taskId);
    if (action?.id !== result.actionId || !expectedStates.includes(action.state)) return false;
    this.actionResults.set(result.actionId, result);
    this.pendingActions.delete(result.taskId);
    return true;
  }

  public async getSessionActionResult(actionId: string): Promise<SessionActionResult | undefined> {
    return this.actionResults.get(actionId);
  }

  public async markSessionActionPending(taskId: string, actionId: string, updatedAt: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task !== undefined) this.tasks.set(taskId, { ...task, pendingActionId: actionId, updatedAt });
  }

  public async markSessionActionCompleted(taskId: string, actionId: string, completedAt: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task?.pendingActionId !== actionId) return;
    this.tasks.set(taskId, { ...task, pendingActionId: undefined, lastActionId: actionId, updatedAt: completedAt });
  }

  public async createTestingRun(run: TestingRunRecord): Promise<boolean> {
    const idempotencyIndex = `${run.userId}\u0000${run.idempotencyKey}`;
    if (this.testingRuns.has(run.id) || this.testingRunIdempotency.has(idempotencyIndex)) return false;
    this.testingRuns.set(run.id, run);
    this.testingRunIdempotency.set(idempotencyIndex, run.id);
    return true;
  }

  public async getTestingRun(id: string): Promise<TestingRunRecord | undefined> {
    return this.testingRuns.get(id);
  }

  public async getTestingRunByIdempotencyKey(userId: string, idempotencyKey: string): Promise<TestingRunRecord | undefined> {
    const id = this.testingRunIdempotency.get(`${userId}\u0000${idempotencyKey}`);
    return id === undefined ? undefined : this.testingRuns.get(id);
  }

  public async listTestingRuns(): Promise<readonly TestingRunRecord[]> {
    return [...this.testingRuns.values()];
  }

  public async replaceTestingRun(run: TestingRunRecord, expectedRecordVersion: number): Promise<boolean> {
    const current = this.testingRuns.get(run.id);
    if (current?.recordVersion !== expectedRecordVersion) return false;
    this.testingRuns.set(run.id, run);
    return true;
  }

  public async replaceTestingRunWithinDeadline(
    run: TestingRunRecord,
    expectedRecordVersion: number,
    deadline: 'run' | 'reconcile',
    observedNow: number
  ): Promise<boolean> {
    const current = this.testingRuns.get(run.id);
    const deadlineAt = deadline === 'run' ? current?.deadlineAt : current?.reconcileDeadlineAt;
    if (current?.recordVersion !== expectedRecordVersion || !isFutureTimestamp(deadlineAt, observedNow)) {
      return false;
    }
    this.testingRuns.set(run.id, run);
    return true;
  }

  public async replaceTestingRunForAttempt(
    run: TestingRunRecord,
    expectedRecordVersion: number,
    deadline: 'run' | 'reconcile',
    guard: TestingAttemptMutationGuard,
    observedNow: number
  ): Promise<boolean> {
    const current = this.testingRuns.get(run.id);
    const deadlineAt = deadline === 'run' ? current?.deadlineAt : current?.reconcileDeadlineAt;
    const attempt = current?.attempts.find((candidate) => candidate.id === guard.attemptId);
    if (
      current?.recordVersion !== expectedRecordVersion ||
      current.currentAttemptId !== guard.attemptId ||
      !isFutureTimestamp(deadlineAt, observedNow) ||
      attempt?.operation !== guard.operation ||
      attempt.generation !== guard.generation ||
      attempt.fenceToken !== guard.fenceToken ||
      attempt.leaseId !== guard.leaseId ||
      attempt.leaseExpiresAt !== guard.leaseExpiresAt ||
      !isFutureTimestamp(guard.leaseExpiresAt, observedNow)
    ) return false;
    this.testingRuns.set(run.id, run);
    return true;
  }

  public async replaceTestingRunForDispatch(
    run: TestingRunRecord,
    expectedRecordVersion: number,
    deadline: 'run' | 'reconcile',
    guard: TestingAttemptDispatchGuard,
    observedNow: number
  ): Promise<boolean> {
    const current = this.testingRuns.get(run.id);
    const deadlineAt = deadline === 'run' ? current?.deadlineAt : current?.reconcileDeadlineAt;
    const attempt = current?.attempts.find((candidate) => candidate.id === guard.attemptId);
    if (
      current?.recordVersion !== expectedRecordVersion ||
      current.currentAttemptId !== guard.attemptId ||
      !isFutureTimestamp(deadlineAt, observedNow) ||
      attempt?.status !== guard.status ||
      attempt.operation !== guard.operation ||
      attempt.generation !== guard.generation ||
      attempt.fenceToken !== guard.fenceToken ||
      attempt.leaseId !== guard.leaseId ||
      attempt.leaseExpiresAt !== guard.leaseExpiresAt ||
      !isFutureTimestamp(guard.dispatchLeaseExpiresAt, observedNow) ||
      !isFutureTimestamp(guard.dispatchAuthorizationExpiresAt, observedNow)
    ) return false;
    this.testingRuns.set(run.id, run);
    return true;
  }

  public async createTestingMachineReservation(reservation: TestingMachineReservationRecord): Promise<boolean> {
    if (this.testingMachineReservations.has(reservation.machineId)) return false;
    this.testingMachineReservations.set(reservation.machineId, reservation);
    return true;
  }

  public async getTestingMachineReservation(machineId: string): Promise<TestingMachineReservationRecord | undefined> {
    return this.testingMachineReservations.get(machineId);
  }

  public async listTestingMachineReservations(): Promise<readonly TestingMachineReservationRecord[]> {
    return [...this.testingMachineReservations.values()];
  }

  public async replaceTestingMachineReservation(
    reservation: TestingMachineReservationRecord,
    expectedRecordVersion: number
  ): Promise<boolean> {
    const current = this.testingMachineReservations.get(reservation.machineId);
    if (current?.recordVersion !== expectedRecordVersion || current.attemptId !== reservation.attemptId) return false;
    this.testingMachineReservations.set(reservation.machineId, reservation);
    return true;
  }

  public async releaseTestingMachineReservation(machineId: string, attemptId: string): Promise<boolean> {
    const current = this.testingMachineReservations.get(machineId);
    if (current?.attemptId !== attemptId) return false;
    this.testingMachineReservations.delete(machineId);
    return true;
  }
}
