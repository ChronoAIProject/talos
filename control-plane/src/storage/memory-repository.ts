import type { HandoffLink, Machine, PendingSessionAction, Pool, Profile, SessionActionResult, Task, TaskInput, WebhookEvent } from '../domain/types.js';
import type { TestingMachineReservationRecord, TestingRunRecord } from '../domain/testing-types.js';
import type { Repository } from './repository.js';

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

  public async getProfile(id: string): Promise<Profile | undefined> {
    return this.profiles.get(id);
  }

  public async saveProfile(profile: Profile): Promise<void> {
    this.profiles.set(profile.id, profile);
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

  public async cancelPendingSessionAction(taskId: string, actionId: string): Promise<boolean> {
    const action = this.pendingActions.get(taskId);
    if (action?.id !== actionId || action.state !== 'pending') return false;
    this.pendingActions.delete(taskId);
    return true;
  }

  public async completeSessionAction(taskId: string, actionId: string): Promise<void> {
    const action = this.pendingActions.get(taskId);
    if (action?.id === actionId) this.pendingActions.delete(taskId);
  }

  public async saveSessionActionResult(result: SessionActionResult): Promise<void> {
    this.actionResults.set(result.actionId, result);
  }

  public async getSessionActionResult(actionId: string): Promise<SessionActionResult | undefined> {
    return this.actionResults.get(actionId);
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
    if (current?.recordVersion !== expectedRecordVersion || deadlineAt === undefined || Date.parse(deadlineAt) <= observedNow) {
      return false;
    }
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
