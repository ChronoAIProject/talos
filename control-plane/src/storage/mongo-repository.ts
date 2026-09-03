import { MongoClient, type Collection, type Db, type MongoClientOptions } from 'mongodb';
import type { HandoffLink, Machine, PendingSessionAction, Pool, Profile, SessionActionResult, Task, TaskInput, WebhookEvent } from '../domain/types.js';
import type { TestingMachineReservationRecord, TestingRunRecord } from '../domain/testing-types.js';
import type { Repository, TestingAttemptDispatchGuard, TestingAttemptMutationGuard } from './repository.js';

type Document = { _id: string; [key: string]: unknown };

const mongoDate = (input: unknown): Readonly<Record<string, unknown>> => ({
  $convert: { input, to: 'date', onError: null, onNull: null }
});

const afterDatabaseNow = (input: unknown): Readonly<Record<string, unknown>> => ({
  $gt: [mongoDate(input), '$$NOW']
});

export interface MongoRepositoryOptions {
  client?: MongoClient;
  clientOptions?: MongoClientOptions;
}

export class MongoRepository implements Repository {
  private readonly client: MongoClient;
  private readonly database: Db;
  private readonly tasks: Collection<Document>;
  private readonly pools: Collection<Document>;
  private readonly machines: Collection<Document>;
  private readonly profiles: Collection<Document>;
  private readonly handoffs: Collection<Document>;
  private readonly webhooks: Collection<Document>;
  private readonly pendingInputs: Collection<Document>;
  private readonly pendingActions: Collection<Document>;
  private readonly actionResults: Collection<Document>;
  private readonly testingRuns: Collection<Document>;
  private readonly testingMachineReservations: Collection<Document>;

  public constructor(url: string, databaseName = 'talos', options: MongoRepositoryOptions = {}) {
    this.client = options.client ?? new MongoClient(url, { ...options.clientOptions, ignoreUndefined: true });
    this.database = this.client.db(databaseName);
    this.tasks = this.database.collection('tasks');
    this.pools = this.database.collection('pools');
    this.machines = this.database.collection('machines');
    this.profiles = this.database.collection('profiles');
    this.handoffs = this.database.collection('handoffs');
    this.webhooks = this.database.collection('webhooks');
    this.pendingInputs = this.database.collection('pending_inputs');
    this.pendingActions = this.database.collection('pending_actions');
    this.actionResults = this.database.collection('action_results');
    this.testingRuns = this.database.collection('testing_runs');
    this.testingMachineReservations = this.database.collection('testing_machine_reservations');
  }

  public async initialize(): Promise<void> {
    await this.client.connect();
    await Promise.all([
      this.tasks.createIndex({ status: 1, queuePriority: 1, createdAt: 1 }),
      this.pools.createIndex({ ownerUserId: 1 }),
      this.profiles.createIndex({ userId: 1 }),
      this.machines.createIndex({ poolId: 1 }),
      this.pendingActions.createIndex(
        { taskId: 1 },
        { unique: true, partialFilterExpression: { state: { $in: ['pending', 'dispatched'] } } }
      ),
      this.actionResults.createIndex({ taskId: 1 }),
      this.testingRuns.createIndex({ userId: 1, idempotencyKey: 1 }, { unique: true }),
      this.testingMachineReservations.createIndex({ runId: 1, attemptId: 1 }, { unique: true }),
      this.testingMachineReservations.createIndex({ expiresAt: 1 })
    ]);
  }

  public async ping(): Promise<void> {
    await this.database.command({ ping: 1 });
  }

  public async close(): Promise<void> {
    await this.client.close();
  }

  public async getTask(id: string): Promise<Task | undefined> {
    const document = await this.tasks.findOne({ _id: id });
    return document === null ? undefined : taskFromDocument(document);
  }

  public async saveTask(task: Task): Promise<void> {
    await this.tasks.replaceOne({ _id: task.id }, { ...task, _id: task.id, queuePriority: task.queuePriority ?? 0 }, { upsert: true });
  }

  public async listQueuedTasks(): Promise<readonly Task[]> {
    const documents = await this.tasks.find({ status: 'submitted' }).sort({ queuePriority: 1, createdAt: 1 }).toArray();
    return documents.map(taskFromDocument);
  }

  public async listTasks(): Promise<readonly Task[]> {
    return (await this.tasks.find({}).toArray()).map(taskFromDocument);
  }

  public async getPool(id: string): Promise<Pool | undefined> {
    const document = await this.pools.findOne({ _id: id });
    return document === null ? undefined : poolFromDocument(document);
  }

  public async savePool(pool: Pool): Promise<void> {
    await this.pools.replaceOne({ _id: pool.id }, { ...pool, _id: pool.id }, { upsert: true });
  }

  public async listPoolsByOwner(ownerUserId: string): Promise<readonly Pool[]> {
    return (await this.pools.find({ ownerUserId }).toArray()).map(poolFromDocument);
  }

  public async listMachines(poolId?: string): Promise<readonly Machine[]> {
    return (await this.machines.find(poolId === undefined ? {} : { poolId }).toArray()).map(machineFromDocument);
  }

  public async getMachine(id: string): Promise<Machine | undefined> {
    const document = await this.machines.findOne({ _id: id });
    return document === null ? undefined : machineFromDocument(document);
  }

  public async saveMachine(machine: Machine): Promise<void> {
    await this.machines.replaceOne({ _id: machine.id }, { ...machine, _id: machine.id }, { upsert: true });
  }

  public async getProfile(id: string): Promise<Profile | undefined> {
    const document = await this.profiles.findOne({ _id: id });
    return document === null ? undefined : profileFromDocument(document);
  }

  public async saveProfile(profile: Profile): Promise<void> {
    await this.profiles.replaceOne({ _id: profile.id }, { ...profile, _id: profile.id }, { upsert: true });
  }

  public async listProfilesByUser(userId: string): Promise<readonly Profile[]> {
    return (await this.profiles.find({ userId }).toArray()).map(profileFromDocument);
  }

  public async saveHandoff(link: HandoffLink): Promise<void> {
    await this.handoffs.replaceOne({ _id: link.id }, { ...link, _id: link.id }, { upsert: true });
  }

  public async getHandoff(id: string): Promise<HandoffLink | undefined> {
    const document = await this.handoffs.findOne({ _id: id });
    return document === null ? undefined : handoffFromDocument(document);
  }

  public async saveWebhook(event: WebhookEvent): Promise<void> {
    await this.webhooks.replaceOne({ _id: event.id }, { ...event, _id: event.id }, { upsert: true });
  }

  public async getWebhook(id: string): Promise<WebhookEvent | undefined> {
    const document = await this.webhooks.findOne({ _id: id });
    return document === null ? undefined : webhookFromDocument(document);
  }

  public async listWebhooks(): Promise<readonly WebhookEvent[]> {
    return (await this.webhooks.find({}).toArray()).map(webhookFromDocument);
  }

  public async savePendingInput(taskId: string, input: TaskInput): Promise<void> {
    await this.pendingInputs.replaceOne({ _id: taskId }, { _id: taskId, input }, { upsert: true });
  }

  public async takePendingInput(taskId: string): Promise<TaskInput | undefined> {
    const result = await this.pendingInputs.findOneAndDelete({ _id: taskId });
    const document = result ?? null;
    return document === null ? undefined : document.input as TaskInput;
  }

  public async enqueueSessionAction(action: PendingSessionAction): Promise<boolean> {
    try {
      await this.pendingActions.insertOne({ ...action, _id: action.id });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  public async getPendingSessionAction(taskId: string): Promise<PendingSessionAction | undefined> {
    const document = await this.pendingActions.findOne({ taskId, state: { $in: ['pending', 'dispatched'] } });
    return document === null ? undefined : sessionActionFromDocument(document);
  }

  public async takePendingSessionAction(taskId: string): Promise<PendingSessionAction | undefined> {
    const document = await this.pendingActions.findOneAndUpdate(
      { taskId, state: 'pending' },
      { $set: { state: 'dispatched' } },
      { returnDocument: 'after' }
    );
    return document === null ? undefined : sessionActionFromDocument(document);
  }

  public async requeueSessionAction(taskId: string): Promise<void> {
    await this.pendingActions.updateOne(
      { taskId, state: 'dispatched' },
      { $set: { state: 'pending' } }
    );
  }

  public async cancelPendingSessionAction(taskId: string, actionId: string): Promise<boolean> {
    const result = await this.pendingActions.deleteOne({ taskId, id: actionId, state: 'pending' });
    return result.deletedCount === 1;
  }

  public async completeSessionAction(taskId: string, actionId: string): Promise<void> {
    await this.pendingActions.deleteOne({ taskId, id: actionId });
  }

  public async finalizeSessionAction(result: SessionActionResult): Promise<boolean> {
    const document = await this.pendingActions.findOneAndUpdate(
      { taskId: result.taskId, id: result.actionId, state: 'dispatched' },
      {
        $set: {
          state: 'completed',
          completionResult: result.result,
          completedAt: result.completedAt
        }
      },
      { returnDocument: 'after' }
    );
    return document !== null;
  }

  public async saveSessionActionResult(result: SessionActionResult): Promise<void> {
    await this.actionResults.replaceOne(
      { _id: result.actionId },
      { ...result, _id: result.actionId },
      { upsert: true }
    );
  }

  public async getSessionActionResult(actionId: string): Promise<SessionActionResult | undefined> {
    const document = await this.actionResults.findOne({ _id: actionId });
    if (document !== null) return sessionActionResultFromDocument(document);
    const completed = await this.pendingActions.findOne({ id: actionId, state: 'completed' });
    return completed === null ? undefined : completedSessionActionResultFromDocument(completed);
  }

  public async markSessionActionPending(taskId: string, actionId: string, updatedAt: string): Promise<void> {
    await this.tasks.updateOne({ _id: taskId }, { $set: { pendingActionId: actionId, updatedAt } });
  }

  public async markSessionActionCompleted(taskId: string, actionId: string, completedAt: string): Promise<void> {
    await this.tasks.updateOne(
      { _id: taskId, pendingActionId: actionId },
      { $unset: { pendingActionId: '' }, $set: { lastActionId: actionId, updatedAt: completedAt } }
    );
  }

  public async createTestingRun(run: TestingRunRecord): Promise<boolean> {
    try {
      await this.testingRuns.insertOne({ ...run, _id: run.id });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  public async getTestingRun(id: string): Promise<TestingRunRecord | undefined> {
    const document = await this.testingRuns.findOne({ _id: id });
    return document === null ? undefined : testingRunFromDocument(document);
  }

  public async getTestingRunByIdempotencyKey(userId: string, idempotencyKey: string): Promise<TestingRunRecord | undefined> {
    const document = await this.testingRuns.findOne({ userId, idempotencyKey });
    return document === null ? undefined : testingRunFromDocument(document);
  }

  public async listTestingRuns(): Promise<readonly TestingRunRecord[]> {
    return (await this.testingRuns.find({}).toArray()).map(testingRunFromDocument);
  }

  public async replaceTestingRun(run: TestingRunRecord, expectedRecordVersion: number): Promise<boolean> {
    const result = await this.testingRuns.replaceOne(
      { _id: run.id, recordVersion: expectedRecordVersion },
      { ...run, _id: run.id }
    );
    return result.modifiedCount === 1;
  }

  public async replaceTestingRunWithinDeadline(
    run: TestingRunRecord,
    expectedRecordVersion: number,
    deadline: 'run' | 'reconcile',
    _observedNow: number
  ): Promise<boolean> {
    const field = deadline === 'run' ? 'deadlineAt' : 'reconcileDeadlineAt';
    const result = await this.testingRuns.replaceOne(
      {
        _id: run.id,
        recordVersion: expectedRecordVersion,
        $expr: afterDatabaseNow(`$${field}`)
      },
      { ...run, _id: run.id }
    );
    return result.modifiedCount === 1;
  }

  public async replaceTestingRunForAttempt(
    run: TestingRunRecord,
    expectedRecordVersion: number,
    deadline: 'run' | 'reconcile',
    guard: TestingAttemptMutationGuard,
    _observedNow: number
  ): Promise<boolean> {
    const deadlineField = deadline === 'run' ? 'deadlineAt' : 'reconcileDeadlineAt';
    const temporalChecks: unknown[] = [
      afterDatabaseNow(`$${deadlineField}`),
      afterDatabaseNow({ $literal: guard.leaseExpiresAt })
    ];
    const result = await this.testingRuns.replaceOne(
      {
        _id: run.id,
        recordVersion: expectedRecordVersion,
        currentAttemptId: guard.attemptId,
        attempts: {
          $elemMatch: {
            id: guard.attemptId,
            operation: guard.operation,
            generation: guard.generation,
            fenceToken: guard.fenceToken,
            leaseId: guard.leaseId,
            leaseExpiresAt: guard.leaseExpiresAt
          }
        },
        $expr: { $and: temporalChecks }
      },
      { ...run, _id: run.id }
    );
    return result.modifiedCount === 1;
  }

  public async replaceTestingRunForDispatch(
    run: TestingRunRecord,
    expectedRecordVersion: number,
    deadline: 'run' | 'reconcile',
    guard: TestingAttemptDispatchGuard,
    _observedNow: number
  ): Promise<boolean> {
    const deadlineField = deadline === 'run' ? 'deadlineAt' : 'reconcileDeadlineAt';
    const result = await this.testingRuns.replaceOne(
      {
        _id: run.id,
        recordVersion: expectedRecordVersion,
        currentAttemptId: guard.attemptId,
        attempts: {
          $elemMatch: {
            id: guard.attemptId,
            status: guard.status,
            operation: guard.operation,
            generation: guard.generation,
            fenceToken: guard.fenceToken,
            leaseId: guard.leaseId,
            leaseExpiresAt: guard.leaseExpiresAt
          }
        },
        $expr: {
          $and: [
            afterDatabaseNow(`$${deadlineField}`),
            afterDatabaseNow({ $literal: guard.dispatchLeaseExpiresAt }),
            afterDatabaseNow({ $literal: guard.dispatchAuthorizationExpiresAt })
          ]
        }
      },
      { ...run, _id: run.id }
    );
    return result.modifiedCount === 1;
  }

  public async createTestingMachineReservation(reservation: TestingMachineReservationRecord): Promise<boolean> {
    try {
      await this.testingMachineReservations.insertOne({ ...reservation, _id: reservation.machineId });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  public async getTestingMachineReservation(machineId: string): Promise<TestingMachineReservationRecord | undefined> {
    const document = await this.testingMachineReservations.findOne({ _id: machineId });
    return document === null ? undefined : testingMachineReservationFromDocument(document);
  }

  public async listTestingMachineReservations(): Promise<readonly TestingMachineReservationRecord[]> {
    return (await this.testingMachineReservations.find({}).toArray()).map(testingMachineReservationFromDocument);
  }

  public async replaceTestingMachineReservation(
    reservation: TestingMachineReservationRecord,
    expectedRecordVersion: number
  ): Promise<boolean> {
    const result = await this.testingMachineReservations.replaceOne(
      { _id: reservation.machineId, attemptId: reservation.attemptId, recordVersion: expectedRecordVersion },
      { ...reservation, _id: reservation.machineId }
    );
    return result.modifiedCount === 1;
  }

  public async releaseTestingMachineReservation(machineId: string, attemptId: string): Promise<boolean> {
    const result = await this.testingMachineReservations.deleteOne({ _id: machineId, attemptId });
    return result.deletedCount === 1;
  }
}

const withoutId = (document: Document): Record<string, unknown> => {
  return Object.fromEntries(Object.entries(document).filter(([key, value]) => key !== '_id' && value !== null));
};

const taskFromDocument = (document: Document): Task => ({
  interaction: 'autonomous',
  ...withoutId(document)
}) as unknown as Task;
const poolFromDocument = (document: Document): Pool => withoutId(document) as unknown as Pool;
const machineFromDocument = (document: Document): Machine => withoutId(document) as unknown as Machine;
const profileFromDocument = (document: Document): Profile => withoutId(document) as unknown as Profile;
const handoffFromDocument = (document: Document): HandoffLink => withoutId(document) as unknown as HandoffLink;
const webhookFromDocument = (document: Document): WebhookEvent => withoutId(document) as unknown as WebhookEvent;
const sessionActionFromDocument = (document: Document): PendingSessionAction => withoutId(document) as unknown as PendingSessionAction;
const sessionActionResultFromDocument = (document: Document): SessionActionResult => withoutId(document) as unknown as SessionActionResult;
const completedSessionActionResultFromDocument = (document: Document): SessionActionResult => ({
  actionId: document.id as string,
  taskId: document.taskId as string,
  result: document.completionResult,
  completedAt: document.completedAt as string
});
const testingRunFromDocument = (document: Document): TestingRunRecord => withoutId(document) as unknown as TestingRunRecord;
const testingMachineReservationFromDocument = (document: Document): TestingMachineReservationRecord =>
  withoutId(document) as unknown as TestingMachineReservationRecord;

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
