import type { ActionDispatchBinding, HandoffLink, Machine, MachineLeaseReservation, PendingSessionAction, Pool, Profile, SessionActionResult, Task, TaskActiveClaimGuard, TaskClaimGuard, TaskInput, TaskRecoveryGuard, WebhookEvent } from '../domain/types.js';
import type { TestingMachineReservationRecord, TestingRunRecord } from '../domain/testing-types.js';
import type { Repository, SessionActionDispatchGuard, SessionActionResultGuard, TaskMaintenanceCursor, TestingAttemptDispatchGuard, TestingAttemptMutationGuard } from './repository.js';

const isFutureTimestamp = (value: string | undefined, observedNow: number): boolean => {
  if (value === undefined) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > observedNow;
};

const isValidClaim = (task: Task, expectedClaimGeneration: number, expectedTaskVersion: number): boolean =>
  task.kind !== 'testing' &&
  task.status === 'claimed' &&
  task.claimId !== undefined &&
  task.claimGeneration === expectedClaimGeneration + 1 &&
  task.taskVersion === expectedTaskVersion + 1 &&
  task.claimGeneration > 0 &&
  task.workerId !== undefined &&
  task.machineId !== undefined &&
  task.leaseToken !== undefined &&
  task.leaseExpiresAt !== undefined;

const expirableTaskTimestamp = (task: Task): string => {
  const value = task.status === 'submitted' ? task.constraints.deadline : task.leaseExpiresAt;
  return typeof value === 'string' ? value : '';
};

const assertPositivePageLimit = (limit: number): void => {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('page limit must be a positive safe integer');
};

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
  private readonly taskMaintenanceCursors = new Map<TaskMaintenanceCursor['id'], TaskMaintenanceCursor>();
  private readonly legacyMachineRecoveryMarkers = new Map<string, Map<string, string>>();

  public constructor(private readonly clock: () => number = () => Date.now()) {}

  public async ping(): Promise<void> {}

  public async close(): Promise<void> {}

  public async getTask(id: string): Promise<Task | undefined> {
    return this.tasks.get(id);
  }

  public async saveTask(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
  }

  public async claimTask(task: Task, expectedClaimGeneration: number, expectedTaskVersion: number): Promise<Task | undefined> {
    if (!isValidClaim(task, expectedClaimGeneration, expectedTaskVersion)) return undefined;
    const current = this.tasks.get(task.id);
    if (
      current?.status !== 'submitted' ||
      (current.claimGeneration ?? 0) !== expectedClaimGeneration ||
      (current.taskVersion ?? 0) !== expectedTaskVersion ||
      (current.claimId !== undefined && current.claimReleased !== true)
    ) return undefined;
    this.tasks.set(task.id, task);
    return task;
  }

  public async replaceTaskForClaim(task: Task, guard: TaskClaimGuard): Promise<boolean> {
    if (task.claimId !== guard.claimId || task.claimGeneration !== guard.claimGeneration) return false;
    const current = this.tasks.get(task.id);
    if (
      current?.claimId !== guard.claimId ||
      current.claimGeneration !== guard.claimGeneration ||
      (current.taskVersion ?? 0) !== guard.taskVersion ||
      current.status !== guard.status
    ) return false;
    this.tasks.set(task.id, { ...task, taskVersion: guard.taskVersion + 1 });
    return true;
  }

  public async replaceTaskForActiveClaim(task: Task, guard: TaskActiveClaimGuard): Promise<boolean> {
    const current = this.tasks.get(task.id);
    if (current?.leaseExpiresAt !== guard.leaseExpiresAt || !isFutureTimestamp(current.leaseExpiresAt, this.clock())) return false;
    return this.replaceTaskForClaim(task, guard);
  }

  public async replaceTaskForExpiredClaim(task: Task, guard: TaskActiveClaimGuard): Promise<boolean> {
    const current = this.tasks.get(task.id);
    if (current?.leaseExpiresAt !== guard.leaseExpiresAt || isFutureTimestamp(current.leaseExpiresAt, this.clock())) return false;
    return this.replaceTaskForClaim(task, guard);
  }

  public async replaceSubmittedTask(task: Task, expectedClaimGeneration: number, expectedTaskVersion: number): Promise<boolean> {
    if ((task.claimGeneration ?? 0) !== expectedClaimGeneration) return false;
    const current = this.tasks.get(task.id);
    if (current?.status !== 'submitted' || (current.claimGeneration ?? 0) !== expectedClaimGeneration || (current.taskVersion ?? 0) !== expectedTaskVersion) return false;
    this.tasks.set(task.id, { ...task, taskVersion: expectedTaskVersion + 1 });
    return true;
  }

  public async replaceTaskForRecovery(task: Task, guard: TaskRecoveryGuard): Promise<boolean> {
    const current = this.tasks.get(task.id);
    if (
      current?.status !== guard.status ||
      (current.taskVersion ?? 0) !== guard.taskVersion ||
      current.updatedAt !== guard.updatedAt ||
      current.claimId !== guard.claimId ||
      current.claimGeneration !== guard.claimGeneration ||
      current.claimRecovery?.recoveryId !== guard.recoveryId ||
      current.claimRecovery?.phase !== guard.recoveryPhase
    ) return false;
    this.tasks.set(task.id, { ...task, taskVersion: guard.taskVersion + 1 });
    return true;
  }

  public async listQueuedTasks(): Promise<readonly Task[]> {
    return [...this.tasks.values()]
      .filter((task) =>
        task.status === 'submitted' &&
        task.claimRecovery === undefined &&
        (task.claimId === undefined || task.claimReleased === true)
      )
      .sort(
        (a, b) =>
          (a.queuePriority ?? 0) - (b.queuePriority ?? 0) ||
          a.createdAt.localeCompare(b.createdAt)
      );
  }
  public async listTasks(): Promise<readonly Task[]> {
    return [...this.tasks.values()];
  }

  public async listExpirableTasks(now: number, limit: number): Promise<readonly Task[]> {
    assertPositivePageLimit(limit);
    const timestamp = new Date(now).toISOString();
    const deadlineTasks = [...this.tasks.values()]
      .filter((task) =>
        task.kind !== 'testing' &&
        task.status === 'submitted' &&
        task.constraints.deadline !== undefined &&
        task.constraints.deadline <= timestamp
      )
      .sort((left, right) => expirableTaskTimestamp(left).localeCompare(expirableTaskTimestamp(right)) || left.id.localeCompare(right.id))
      .slice(0, limit);
    const leaseTasks = [...this.tasks.values()]
      .filter((task) =>
        task.kind !== 'testing' &&
        ['claimed', 'running', 'closing'].includes(task.status) &&
        task.leaseExpiresAt !== undefined &&
        task.leaseExpiresAt <= timestamp
      )
      .sort((left, right) => expirableTaskTimestamp(left).localeCompare(expirableTaskTimestamp(right)) || left.id.localeCompare(right.id))
      .slice(0, limit);
    return [...deadlineTasks, ...leaseTasks]
      .sort((left, right) => expirableTaskTimestamp(left).localeCompare(expirableTaskTimestamp(right)) || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  public async listTaskMaintenancePage(cursor: TaskMaintenanceCursor, limit: number): Promise<readonly Task[]> {
    return [...this.tasks.values()]
      .filter((task) =>
        task.createdAt <= cursor.cycleCutoffAt &&
        (
          cursor.afterCreatedAt === undefined ||
          task.createdAt > cursor.afterCreatedAt ||
          (task.createdAt === cursor.afterCreatedAt && task.id > (cursor.afterTaskId ?? ''))
        )
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  public async getTaskMaintenanceHighWatermark(): Promise<string | undefined> {
    return [...this.tasks.values()]
      .map((task) => task.createdAt)
      .sort((left, right) => right.localeCompare(left))[0];
  }

  public async createTaskMaintenanceCursor(cursor: TaskMaintenanceCursor): Promise<boolean> {
    if (this.taskMaintenanceCursors.has(cursor.id)) return false;
    this.taskMaintenanceCursors.set(cursor.id, cursor);
    return true;
  }

  public async getTaskMaintenanceCursor(id: TaskMaintenanceCursor['id']): Promise<TaskMaintenanceCursor | undefined> {
    return this.taskMaintenanceCursors.get(id);
  }

  public async replaceTaskMaintenanceCursor(cursor: TaskMaintenanceCursor, expectedVersion: number): Promise<boolean> {
    const current = this.taskMaintenanceCursors.get(cursor.id);
    if (current?.version !== expectedVersion || cursor.version !== expectedVersion + 1) return false;
    this.taskMaintenanceCursors.set(cursor.id, cursor);
    return true;
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

  public async rotateMachineToken(machineId: string, expectedTokenHash: string, tokenHash: string): Promise<boolean> {
    const machine = this.machines.get(machineId);
    if (machine === undefined || machine.workerTokenHash !== expectedTokenHash) return false;
    this.machines.set(machineId, { ...machine, workerTokenHash: tokenHash });
    return true;
  }

  public async reserveMachineLease(machineId: string, reservation: MachineLeaseReservation): Promise<boolean> {
    const machine = this.machines.get(machineId);
    if (machine === undefined) return false;
    const reservations = machine.leaseReservations ?? [];
    if (reservations.some((entry) =>
      entry.taskId === reservation.taskId &&
      entry.claimId === reservation.claimId &&
      entry.claimGeneration === reservation.claimGeneration
    )) return true;
    if (reservations.some((entry) => entry.claimId === reservation.claimId)) return false;
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
    const current = next[index]!;
    next[index] = Date.parse(current.expiresAt) >= Date.parse(reservation.expiresAt) ? current : reservation;
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

  public async releaseMachineLeaseReservation(reservation: Omit<MachineLeaseReservation, 'expiresAt'>): Promise<boolean> {
    const machine = [...this.machines.values()].find((candidate) =>
      candidate.leaseReservations?.some((entry) =>
        entry.taskId === reservation.taskId &&
        entry.claimId === reservation.claimId &&
        entry.claimGeneration === reservation.claimGeneration
      ) === true
    );
    return machine === undefined ? false : this.releaseMachineLease(machine.id, reservation);
  }

  public async releaseLegacyMachineLease(machineId: string, recoveryId: string, taskId: string): Promise<boolean> {
    const machine = this.machines.get(machineId);
    if (machine === undefined) return false;
    const markers = this.legacyMachineRecoveryMarkers.get(machineId) ?? new Map<string, string>();
    const markedTaskId = markers.get(recoveryId);
    if (markedTaskId !== undefined) return markedTaskId === taskId;
    const reservationCount = machine.leaseReservations?.length ?? 0;
    this.machines.set(machineId, {
      ...machine,
      activeLeases: Math.max(reservationCount, machine.activeLeases - 1)
    });
    markers.set(recoveryId, taskId);
    this.legacyMachineRecoveryMarkers.set(machineId, markers);
    return true;
  }

  public async clearLegacyMachineLeaseMarker(machineId: string, recoveryId: string): Promise<boolean> {
    const markers = this.legacyMachineRecoveryMarkers.get(machineId);
    if (markers === undefined) return false;
    const removed = markers.delete(recoveryId);
    if (markers.size === 0) this.legacyMachineRecoveryMarkers.delete(machineId);
    return removed;
  }

  public async getProfile(id: string): Promise<Profile | undefined> {
    return this.profiles.get(id);
  }

  public async createProfile(profile: Profile): Promise<boolean> {
    if (this.profiles.has(profile.id)) return false;
    this.profiles.set(profile.id, profile);
    return true;
  }

  public async acquireProfileLease(profileId: string, userId: string, machineId: string, reservation: MachineLeaseReservation): Promise<Profile | undefined> {
    const profile = this.profiles.get(profileId);
    if (profile === undefined || profile.userId !== userId) return undefined;
    const sameClaim = profile.lockedByClaimId === reservation.claimId && profile.lockedByClaimGeneration === reservation.claimGeneration;
    if (!sameClaim && profile.lockedByTaskId !== undefined) return undefined;
    const updated: Profile = {
      ...profile,
      machineId,
      lockedByTaskId: reservation.taskId,
      lockedByClaimId: reservation.claimId,
      lockedByClaimGeneration: reservation.claimGeneration,
      lockExpiresAt: sameClaim && Date.parse(profile.lockExpiresAt ?? '') >= Date.parse(reservation.expiresAt)
        ? profile.lockExpiresAt
        : reservation.expiresAt
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

  public async releaseLegacyProfileLease(profileId: string, taskId: string): Promise<boolean> {
    const profile = this.profiles.get(profileId);
    if (
      profile?.lockedByTaskId !== taskId ||
      profile.lockedByClaimId !== undefined ||
      profile.lockedByClaimGeneration !== undefined
    ) return false;
    this.profiles.set(profileId, {
      ...profile,
      lockedByTaskId: undefined,
      lockExpiresAt: undefined
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
    const task = this.tasks.get(action.taskId);
    if (task === undefined || task.sessionActions?.some((candidate) => candidate.state !== 'completed') === true) return false;
    this.tasks.set(task.id, {
      ...task,
      sessionActions: [...(task.sessionActions ?? []), action],
      pendingActionId: action.id,
      updatedAt: action.createdAt,
      taskVersion: (task.taskVersion ?? 0) + 1
    });
    return true;
  }

  public async getPendingSessionAction(taskId: string): Promise<PendingSessionAction | undefined> {
    const action = this.tasks.get(taskId)?.sessionActions?.find((candidate) => candidate.state !== 'completed');
    if (action !== undefined && action.state !== 'completed') return action;
    return this.pendingActions.get(taskId);
  }

  public async takePendingSessionAction(
    taskId: string,
    guard: SessionActionDispatchGuard
  ): Promise<PendingSessionAction | undefined> {
    const task = this.tasks.get(taskId);
    const action = task?.sessionActions?.find((candidate) => candidate.state !== 'completed');
    if (
      task === undefined || action === undefined || action.state !== 'pending' ||
      action.schemaVersion !== 'talos.internal-session-action/v1' ||
      action.dispatchGeneration !== guard.expectedDispatchGeneration ||
      task.workerId !== guard.workerId || task.machineId !== guard.machineId ||
      task.leaseToken !== guard.leaseToken || task.claimId !== guard.claimId ||
      task.claimGeneration !== guard.claimGeneration || task.claimCommitted !== true ||
      !['claimed', 'running'].includes(task.status) || !isFutureTimestamp(task.leaseExpiresAt, this.clock())
    ) return undefined;
    const dispatchGeneration = action.dispatchGeneration + 1;
    const dispatchBinding: ActionDispatchBinding = {
      schemaVersion: 'talos.internal-action-dispatch-binding/v1',
      dispatchId: guard.dispatchId,
      dispatchGeneration,
      workerId: guard.workerId,
      machineId: guard.machineId,
      leaseTokenDigest: guard.leaseTokenDigest
    };
    const dispatched: PendingSessionAction = {
      ...action, state: 'dispatched', dispatchGeneration, dispatchBinding,
      dispatchClaimId: guard.claimId, dispatchClaimGeneration: guard.claimGeneration
    };
    this.tasks.set(taskId, {
      ...task,
      sessionActions: task.sessionActions?.map((candidate) => candidate.id === action.id ? dispatched : candidate),
      taskVersion: (task.taskVersion ?? 0) + 1
    });
    return dispatched;
  }

  public async requeueSessionAction(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    const action = task?.sessionActions?.find((candidate) => candidate.state === 'dispatched');
    if (task === undefined || action === undefined || action.state !== 'dispatched') return;
    this.tasks.set(taskId, {
      ...task,
      sessionActions: task.sessionActions?.map((candidate) => candidate.id === action.id ? { ...action, state: 'pending' as const } : candidate),
      taskVersion: (task.taskVersion ?? 0) + 1
    });
  }

  public async finalizeSessionAction(
    result: SessionActionResult,
    expectedStates: readonly PendingSessionAction['state'][],
    guard?: SessionActionResultGuard
  ): Promise<boolean> {
    const task = this.tasks.get(result.taskId);
    const action = task?.sessionActions?.find((candidate) => candidate.id === result.actionId);
    if (task === undefined || action === undefined || action.state === 'completed' || !expectedStates.includes(action.state)) return false;
    if (guard !== undefined && (
      action.state !== 'dispatched' || !sameDispatchBinding(action.dispatchBinding, guard.binding) ||
      task.workerId !== guard.binding.workerId || task.machineId !== guard.binding.machineId ||
      task.leaseToken !== guard.leaseToken || task.claimId !== guard.claimId ||
      task.claimGeneration !== guard.claimGeneration || action.dispatchClaimId !== guard.claimId ||
      action.dispatchClaimGeneration !== guard.claimGeneration || task.claimCommitted !== true ||
      !['claimed', 'running', 'closing'].includes(task.status) || !isFutureTimestamp(task.leaseExpiresAt, this.clock())
    )) return false;
    const completion: SessionActionResult = action.dispatchBinding === undefined
      ? { ...result, unbound: true }
      : { ...result, dispatchBinding: action.dispatchBinding };
    this.tasks.set(task.id, {
      ...task,
      sessionActions: task.sessionActions?.map((candidate) => candidate.id === action.id
        ? { ...action, state: 'completed' as const, completion }
        : candidate),
      pendingActionId: task.pendingActionId === action.id ? undefined : task.pendingActionId,
      lastActionId: action.id,
      updatedAt: result.completedAt,
      taskVersion: (task.taskVersion ?? 0) + 1
    });
    return true;
  }

  public async getSessionActionResult(actionId: string): Promise<SessionActionResult | undefined> {
    for (const task of this.tasks.values()) {
      const action = task.sessionActions?.find((candidate) => candidate.id === actionId);
      if (action?.state === 'completed') return action.completion;
    }
    return this.actionResults.get(actionId);
  }

  public async markSessionActionPending(_taskId: string, _actionId: string, _updatedAt: string): Promise<void> {}

  public async markSessionActionCompleted(_taskId: string, _actionId: string, _completedAt: string): Promise<void> {}

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

const sameDispatchBinding = (left: ActionDispatchBinding | undefined, right: ActionDispatchBinding): boolean =>
  left?.schemaVersion === right.schemaVersion &&
  left.dispatchId === right.dispatchId &&
  left.dispatchGeneration === right.dispatchGeneration &&
  left.workerId === right.workerId &&
  left.machineId === right.machineId &&
  left.leaseTokenDigest === right.leaseTokenDigest;
