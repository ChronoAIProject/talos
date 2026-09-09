import { MongoClient, type Collection, type Db, type Document as MongoDriverDocument, type Filter, type MongoClientOptions, type UpdateFilter } from 'mongodb';
import type { ActionDispatchBinding, HandoffLink, Machine, MachineLeaseReservation, PendingSessionAction, Pool, Profile, SessionActionResult, Task, TaskActiveClaimGuard, TaskClaimGuard, TaskInput, TaskRecoveryGuard, WebhookEvent } from '../domain/types.js';
import type { TestingMachineReservationRecord, TestingRunRecord } from '../domain/testing-types.js';
import type { Repository, SessionActionDispatchGuard, SessionActionResultGuard, TaskMaintenanceCursor, TestingAttemptDispatchGuard, TestingAttemptMutationGuard } from './repository.js';

type Document = { _id: string; [key: string]: unknown };

type MachineDocument = Omit<Machine, 'leaseReservations'> & {
  _id: string;
  leaseReservations?: MachineLeaseReservation[];
  legacyLeaseRecoveryMarkers?: Array<{ recoveryId: string; taskId: string }>;
};

const mongoDate = (input: unknown): Readonly<Record<string, unknown>> => ({
  $convert: { input, to: 'date', onError: null, onNull: null }
});

const afterDatabaseNow = (input: unknown): Readonly<Record<string, unknown>> => ({
  $gt: [mongoDate(input), '$$NOW']
});

const atOrBeforeDatabaseNow = (input: unknown): Readonly<Record<string, unknown>> => ({
  $lte: [mongoDate(input), '$$NOW']
});

const NON_TESTING_TASK_KINDS = ['browse', 'computer_use'] as const;
const ACTIVE_TASK_STATUSES = ['claimed', 'running', 'closing'] as const;
const TASK_LEASE_EXPIRY_INDEX = 'task-lease-expiry-v1';
const TASK_DEADLINE_EXPIRY_INDEX = 'task-deadline-expiry-v1';
const LEGACY_ACTION_MIGRATION_INDEX = 'legacy-action-migration-v1';
const LEGACY_ACTION_MIGRATION_BATCH_SIZE = 100;
const LEGACY_ACTION_RECOVERY_ERROR = {
  error: {
    code: 'legacy_action_quarantined',
    message: 'legacy action quarantined during schema migration'
  }
} as const;

const assertPositivePageLimit = (limit: number): void => {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('page limit must be a positive safe integer');
};

const expirableTaskTimestamp = (task: Task): string => {
  const value = task.status === 'submitted' ? task.constraints.deadline : task.leaseExpiresAt;
  return typeof value === 'string' ? value : '';
};

const compareExpirableTasks = (left: Task, right: Task): number =>
  expirableTaskTimestamp(left).localeCompare(expirableTaskTimestamp(right)) || left.id.localeCompare(right.id);

export interface MongoRepositoryOptions {
  client?: MongoClient;
  clientOptions?: MongoClientOptions;
}

export class MongoRepository implements Repository {
  private readonly client: MongoClient;
  private readonly database: Db;
  private readonly tasks: Collection<Document>;
  private readonly pools: Collection<Document>;
  private readonly machines: Collection<MachineDocument>;
  private readonly profiles: Collection<Document>;
  private readonly handoffs: Collection<Document>;
  private readonly webhooks: Collection<Document>;
  private readonly pendingInputs: Collection<Document>;
  private readonly pendingActions: Collection<Document>;
  private readonly actionResults: Collection<Document>;
  private readonly testingRuns: Collection<Document>;
  private readonly testingMachineReservations: Collection<Document>;
  private readonly maintenance: Collection<Document>;

  public constructor(url: string, databaseName = 'talos', options: MongoRepositoryOptions = {}) {
    this.client = options.client ?? new MongoClient(url, { ...options.clientOptions, ignoreUndefined: true });
    this.database = this.client.db(databaseName);
    this.tasks = this.database.collection('tasks');
    this.pools = this.database.collection('pools');
    this.machines = this.database.collection<MachineDocument>('machines');
    this.profiles = this.database.collection('profiles');
    this.handoffs = this.database.collection('handoffs');
    this.webhooks = this.database.collection('webhooks');
    this.pendingInputs = this.database.collection('pending_inputs');
    this.pendingActions = this.database.collection('pending_actions');
    this.actionResults = this.database.collection('action_results');
    this.testingRuns = this.database.collection('testing_runs');
    this.testingMachineReservations = this.database.collection('testing_machine_reservations');
    this.maintenance = this.database.collection('maintenance');
  }

  public async initialize(): Promise<void> {
    await this.client.connect();
    await Promise.all([
      this.tasks.createIndex({ status: 1, queuePriority: 1, createdAt: 1 }),
      this.tasks.createIndex({ kind: 1, claimId: 1, status: 1, updatedAt: 1 }),
      this.tasks.createIndex(
        { kind: 1, status: 1, leaseExpiresAt: 1, _id: 1 },
        { name: TASK_LEASE_EXPIRY_INDEX }
      ),
      this.tasks.createIndex(
        { kind: 1, status: 1, 'constraints.deadline': 1, _id: 1 },
        { name: TASK_DEADLINE_EXPIRY_INDEX }
      ),
      this.tasks.createIndex({ createdAt: 1, _id: 1 }),
      this.pools.createIndex({ ownerUserId: 1 }),
      this.profiles.createIndex({ userId: 1 }),
      this.machines.createIndex({ poolId: 1 }),
      this.machines.createIndex({
        'leaseReservations.taskId': 1,
        'leaseReservations.claimId': 1,
        'leaseReservations.claimGeneration': 1
      }),
      this.pendingActions.createIndex(
        { taskId: 1 },
        { unique: true, partialFilterExpression: { state: { $in: ['pending', 'dispatched'] } } }
      ),
      this.pendingActions.createIndex(
        { state: 1, _id: 1 },
        {
          name: LEGACY_ACTION_MIGRATION_INDEX,
          partialFilterExpression: { state: { $in: ['pending', 'dispatched'] } }
        }
      ),
      this.actionResults.createIndex({ taskId: 1 }),
      this.testingRuns.createIndex({ userId: 1, idempotencyKey: 1 }, { unique: true }),
      this.testingMachineReservations.createIndex({ runId: 1, attemptId: 1 }, { unique: true }),
      this.testingMachineReservations.createIndex({ expiresAt: 1 })
    ]);
    await this.quarantineLegacySessionActions();
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

  public async claimTask(task: Task, expectedClaimGeneration: number, expectedTaskVersion: number): Promise<Task | undefined> {
    if (!isValidClaim(task, expectedClaimGeneration, expectedTaskVersion)) return undefined;
    const filter = {
        _id: task.id,
        status: 'submitted',
        $and: [
          claimGenerationFilter(expectedClaimGeneration),
          taskVersionFilter(expectedTaskVersion),
          { $or: [{ claimId: { $exists: false } }, { claimReleased: true }] }
        ]
      } satisfies Filter<Document>;
    const document = await this.tasks.findOneAndReplace(
      filter,
      { ...task, _id: task.id, queuePriority: task.queuePriority ?? 0 },
      { returnDocument: 'after' }
    );
    return document === null ? undefined : taskFromDocument(document);
  }

  public async replaceTaskForClaim(task: Task, guard: TaskClaimGuard): Promise<boolean> {
    if (task.claimId !== guard.claimId || task.claimGeneration !== guard.claimGeneration) return false;
    const result = await this.tasks.replaceOne(
      { _id: task.id, status: guard.status, claimId: guard.claimId, claimGeneration: guard.claimGeneration, ...taskVersionFilter(guard.taskVersion) },
      { ...task, taskVersion: guard.taskVersion + 1, _id: task.id, queuePriority: task.queuePriority ?? 0 }
    );
    return result.matchedCount === 1;
  }

  public async replaceTaskForActiveClaim(task: Task, guard: TaskActiveClaimGuard): Promise<boolean> {
    if (task.claimId !== guard.claimId || task.claimGeneration !== guard.claimGeneration) return false;
    const result = await this.tasks.replaceOne(
      {
        _id: task.id,
        status: guard.status,
        claimId: guard.claimId,
        claimGeneration: guard.claimGeneration,
        leaseExpiresAt: guard.leaseExpiresAt,
        ...taskVersionFilter(guard.taskVersion),
        $expr: afterDatabaseNow('$leaseExpiresAt')
      },
      { ...task, taskVersion: guard.taskVersion + 1, _id: task.id, queuePriority: task.queuePriority ?? 0 }
    );
    return result.matchedCount === 1;
  }

  public async replaceTaskForExpiredClaim(task: Task, guard: TaskActiveClaimGuard): Promise<boolean> {
    if (task.claimId !== guard.claimId || task.claimGeneration !== guard.claimGeneration) return false;
    const result = await this.tasks.replaceOne(
      {
        _id: task.id,
        status: guard.status,
        claimId: guard.claimId,
        claimGeneration: guard.claimGeneration,
        leaseExpiresAt: guard.leaseExpiresAt,
        ...taskVersionFilter(guard.taskVersion),
        $expr: atOrBeforeDatabaseNow('$leaseExpiresAt')
      },
      { ...task, taskVersion: guard.taskVersion + 1, _id: task.id, queuePriority: task.queuePriority ?? 0 }
    );
    return result.matchedCount === 1;
  }

  public async replaceSubmittedTask(task: Task, expectedClaimGeneration: number, expectedTaskVersion: number): Promise<boolean> {
    if ((task.claimGeneration ?? 0) !== expectedClaimGeneration) return false;
    const result = await this.tasks.replaceOne(
      { _id: task.id, status: 'submitted', ...claimGenerationFilter(expectedClaimGeneration), ...taskVersionFilter(expectedTaskVersion) },
      { ...task, taskVersion: expectedTaskVersion + 1, _id: task.id, queuePriority: task.queuePriority ?? 0 }
    );
    return result.modifiedCount === 1;
  }

  public async replaceTaskForRecovery(task: Task, guard: TaskRecoveryGuard): Promise<boolean> {
    const filter = {
      _id: task.id,
      status: guard.status,
      updatedAt: guard.updatedAt,
      $and: [
        taskVersionFilter(guard.taskVersion),
        optionalFieldFilter('claimId', guard.claimId),
        optionalFieldFilter('claimGeneration', guard.claimGeneration),
        optionalFieldFilter('claimRecovery.recoveryId', guard.recoveryId),
        optionalFieldFilter('claimRecovery.phase', guard.recoveryPhase)
      ]
    } satisfies Filter<Document>;
    const result = await this.tasks.replaceOne(
      filter,
      { ...task, taskVersion: guard.taskVersion + 1, _id: task.id, queuePriority: task.queuePriority ?? 0 }
    );
    return result.matchedCount === 1;
  }

  public async listQueuedTasks(): Promise<readonly Task[]> {
    const documents = await this.tasks.find({
      status: 'submitted',
      claimRecovery: { $exists: false },
      $or: [{ claimId: { $exists: false } }, { claimReleased: true }]
    }).sort({ queuePriority: 1, createdAt: 1 }).toArray();
    return documents.map(taskFromDocument);
  }

  public async listTasks(): Promise<readonly Task[]> {
    return (await this.tasks.find({}).toArray()).map(taskFromDocument);
  }

  public async listExpirableTasks(now: number, limit: number): Promise<readonly Task[]> {
    assertPositivePageLimit(limit);
    const timestamp = new Date(now).toISOString();
    const [deadlineDocuments, leaseDocuments] = await Promise.all([
      this.tasks.find({
        kind: { $in: NON_TESTING_TASK_KINDS },
        status: 'submitted',
        'constraints.deadline': { $lte: timestamp }
      }).sort({ 'constraints.deadline': 1, _id: 1 }).limit(limit).toArray(),
      this.tasks.find({
        kind: { $in: NON_TESTING_TASK_KINDS },
        status: { $in: ACTIVE_TASK_STATUSES },
        leaseExpiresAt: { $lte: timestamp }
      }).sort({ leaseExpiresAt: 1, _id: 1 }).limit(limit).toArray()
    ]);
    return [...deadlineDocuments, ...leaseDocuments]
      .map(taskFromDocument)
      .sort(compareExpirableTasks)
      .slice(0, limit);
  }

  public async listTaskMaintenancePage(cursor: TaskMaintenanceCursor, limit: number): Promise<readonly Task[]> {
    const after = cursor.afterCreatedAt === undefined
      ? {}
      : {
          $or: [
            { createdAt: { $gt: cursor.afterCreatedAt } },
            { createdAt: cursor.afterCreatedAt, _id: { $gt: cursor.afterTaskId ?? '' } }
          ]
        };
    const documents = await this.tasks.find({
      createdAt: { $lte: cursor.cycleCutoffAt },
      ...after
    }).sort({ createdAt: 1, _id: 1 }).limit(limit).toArray();
    return documents.map(taskFromDocument);
  }

  public async getTaskMaintenanceHighWatermark(): Promise<string | undefined> {
    const document = await this.tasks.find({}).sort({ createdAt: -1, _id: -1 }).limit(1).toArray();
    const createdAt = document[0]?.createdAt;
    return typeof createdAt === 'string' ? createdAt : undefined;
  }

  public async createTaskMaintenanceCursor(cursor: TaskMaintenanceCursor): Promise<boolean> {
    try {
      await this.maintenance.insertOne({ ...cursor, _id: cursor.id });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  public async getTaskMaintenanceCursor(id: TaskMaintenanceCursor['id']): Promise<TaskMaintenanceCursor | undefined> {
    const document = await this.maintenance.findOne({ _id: id });
    return document === null ? undefined : taskMaintenanceCursorFromDocument(document);
  }

  public async replaceTaskMaintenanceCursor(cursor: TaskMaintenanceCursor, expectedVersion: number): Promise<boolean> {
    if (cursor.version !== expectedVersion + 1) return false;
    const result = await this.maintenance.replaceOne(
      { _id: cursor.id, version: expectedVersion },
      { ...cursor, _id: cursor.id }
    );
    return result.matchedCount === 1;
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
    const { leaseReservations, ...fields } = machine;
    const update: UpdateFilter<MachineDocument> = leaseReservations === undefined
      ? { $set: fields, $unset: { leaseReservations: '' } }
      : { $set: { ...fields, leaseReservations: [...leaseReservations] } };
    await this.machines.updateOne({ _id: machine.id }, update, { upsert: true });
  }

  public async rotateMachineToken(machineId: string, expectedTokenHash: string, tokenHash: string): Promise<boolean> {
    const result = await this.machines.updateOne(
      { _id: machineId, workerTokenHash: expectedTokenHash },
      { $set: { workerTokenHash: tokenHash } }
    );
    return result.matchedCount === 1;
  }

  public async reserveMachineLease(machineId: string, reservation: MachineLeaseReservation): Promise<boolean> {
    const existingFilter = {
      _id: machineId,
      leaseReservations: { $elemMatch: claimReservationFilter(reservation) }
    } satisfies Filter<MachineDocument>;
    const existing = await this.machines.findOne(existingFilter);
    if (existing !== null) return true;
    const filter = {
      _id: machineId,
      online: true,
      $expr: { $lt: ['$activeLeases', '$capacity'] },
      leaseReservations: { $not: { $elemMatch: { claimId: reservation.claimId } } }
    } satisfies Filter<MachineDocument>;
    const update = {
      $inc: { activeLeases: 1 },
      $push: { leaseReservations: reservation }
    } satisfies UpdateFilter<MachineDocument>;
    const document = await this.machines.findOneAndUpdate(filter, update, { returnDocument: 'after' });
    if (document !== null) return true;
    return await this.machines.findOne(existingFilter) !== null;
  }

  public async renewMachineLease(machineId: string, reservation: MachineLeaseReservation): Promise<boolean> {
    const filter = {
      _id: machineId,
      leaseReservations: { $elemMatch: claimReservationFilter(reservation) }
    } satisfies Filter<MachineDocument>;
    const update = {
      $max: { 'leaseReservations.$.expiresAt': reservation.expiresAt }
    } satisfies UpdateFilter<MachineDocument>;
    const result = await this.machines.updateOne(filter, update);
    return result.matchedCount === 1;
  }

  public async releaseMachineLease(machineId: string, reservation: Omit<MachineLeaseReservation, 'expiresAt'>): Promise<boolean> {
    const filter = {
      _id: machineId,
      leaseReservations: { $elemMatch: claimReservationFilter(reservation) }
    } satisfies Filter<MachineDocument>;
    const update = {
      $inc: { activeLeases: -1 },
      $pull: { leaseReservations: claimReservationFilter(reservation) }
    } satisfies UpdateFilter<MachineDocument>;
    const result = await this.machines.updateOne(filter, update);
    return result.modifiedCount === 1;
  }

  public async releaseMachineLeaseReservation(reservation: Omit<MachineLeaseReservation, 'expiresAt'>): Promise<boolean> {
    const filter = {
      leaseReservations: { $elemMatch: claimReservationFilter(reservation) }
    } satisfies Filter<MachineDocument>;
    const update = {
      $inc: { activeLeases: -1 },
      $pull: { leaseReservations: claimReservationFilter(reservation) }
    } satisfies UpdateFilter<MachineDocument>;
    const result = await this.machines.updateOne(filter, update);
    return result.modifiedCount === 1;
  }

  public async releaseLegacyMachineLease(machineId: string, recoveryId: string, taskId: string): Promise<boolean> {
    const filter = {
      _id: machineId,
      legacyLeaseRecoveryMarkers: { $not: { $elemMatch: { recoveryId } } }
    } satisfies Filter<MachineDocument>;
    const pipeline: MongoDriverDocument[] = [{
      $set: {
        activeLeases: {
          $max: [
            { $size: { $ifNull: ['$leaseReservations', []] } },
            { $subtract: ['$activeLeases', 1] }
          ]
        },
        legacyLeaseRecoveryMarkers: {
          $concatArrays: [
            { $ifNull: ['$legacyLeaseRecoveryMarkers', []] },
            [{ recoveryId, taskId }]
          ]
        }
      }
    }];
    const result = await this.machines.updateOne(filter, pipeline);
    if (result.modifiedCount === 1) return true;
    return await this.machines.findOne({
      _id: machineId,
      legacyLeaseRecoveryMarkers: { $elemMatch: { recoveryId, taskId } }
    }) !== null;
  }

  public async clearLegacyMachineLeaseMarker(machineId: string, recoveryId: string): Promise<boolean> {
    const filter = {
      _id: machineId,
      legacyLeaseRecoveryMarkers: { $elemMatch: { recoveryId } }
    } satisfies Filter<MachineDocument>;
    const update = {
      $pull: { legacyLeaseRecoveryMarkers: { recoveryId } }
    } satisfies UpdateFilter<MachineDocument>;
    const result = await this.machines.updateOne(filter, update);
    return result.modifiedCount === 1;
  }

  public async getProfile(id: string): Promise<Profile | undefined> {
    const document = await this.profiles.findOne({ _id: id });
    return document === null ? undefined : profileFromDocument(document);
  }

  public async createProfile(profile: Profile): Promise<boolean> {
    try {
      await this.profiles.insertOne({ ...profile, _id: profile.id });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  public async acquireProfileLease(profileId: string, userId: string, machineId: string, reservation: MachineLeaseReservation): Promise<Profile | undefined> {
    const document = await this.profiles.findOneAndUpdate(
      {
        _id: profileId,
        userId,
        $or: [
          { lockedByClaimId: reservation.claimId, lockedByClaimGeneration: reservation.claimGeneration },
          { lockedByTaskId: { $exists: false } }
        ]
      },
      {
        $set: {
          machineId,
          lockedByTaskId: reservation.taskId,
          lockedByClaimId: reservation.claimId,
          lockedByClaimGeneration: reservation.claimGeneration
        },
        $max: { lockExpiresAt: reservation.expiresAt }
      },
      { returnDocument: 'after' }
    );
    return document === null ? undefined : profileFromDocument(document);
  }


  public async releaseProfileLease(profileId: string, reservation: Omit<MachineLeaseReservation, 'expiresAt'>): Promise<boolean> {
    const result = await this.profiles.updateOne(
      { _id: profileId, lockedByTaskId: reservation.taskId, lockedByClaimId: reservation.claimId, lockedByClaimGeneration: reservation.claimGeneration },
      { $unset: { lockedByTaskId: '', lockedByClaimId: '', lockedByClaimGeneration: '', lockExpiresAt: '' } }
    );
    return result.modifiedCount === 1;
  }

  public async releaseLegacyProfileLease(profileId: string, taskId: string): Promise<boolean> {
    const result = await this.profiles.updateOne(
      {
        _id: profileId,
        lockedByTaskId: taskId,
        lockedByClaimId: { $exists: false },
        lockedByClaimGeneration: { $exists: false }
      },
      { $unset: { lockedByTaskId: '', lockExpiresAt: '' } }
    );
    return result.modifiedCount === 1;
  }

  public async listProfiles(): Promise<readonly Profile[]> {
    return (await this.profiles.find({}).toArray()).map(profileFromDocument);
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
    const document = await this.tasks.findOneAndUpdate(
      {
        _id: action.taskId,
        $nor: [{ sessionActions: { $elemMatch: { state: { $in: ['pending', 'dispatched'] } } } }]
      },
      {
        $push: { sessionActions: action },
        $set: { pendingActionId: action.id, updatedAt: action.createdAt },
        $inc: { taskVersion: 1 }
      },
      { returnDocument: 'after' }
    );
    return document !== null;
  }

  public async getPendingSessionAction(taskId: string): Promise<PendingSessionAction | undefined> {
    const taskDocument = await this.tasks.findOne({
      _id: taskId,
      sessionActions: { $elemMatch: { state: { $in: ['pending', 'dispatched'] } } }
    });
    if (taskDocument !== null) {
      const action = taskFromDocument(taskDocument).sessionActions?.find((candidate) => candidate.state !== 'completed');
      if (action !== undefined && action.state !== 'completed') return action;
    }
    return undefined;
  }

  public async takePendingSessionAction(
    taskId: string,
    guard: SessionActionDispatchGuard
  ): Promise<PendingSessionAction | undefined> {
    const dispatchGeneration = guard.expectedDispatchGeneration + 1;
    const dispatchBinding: ActionDispatchBinding = {
      schemaVersion: 'talos.internal-action-dispatch-binding/v1',
      dispatchId: guard.dispatchId,
      dispatchGeneration,
      workerId: guard.workerId,
      machineId: guard.machineId,
      leaseTokenDigest: guard.leaseTokenDigest
    };
    const document = await this.tasks.findOneAndUpdate(
      {
        _id: taskId,
        workerId: guard.workerId,
        machineId: guard.machineId,
        leaseToken: guard.leaseToken,
        claimId: guard.claimId,
        claimGeneration: guard.claimGeneration,
        claimCommitted: true,
        status: { $in: ['claimed', 'running'] },
        $expr: afterDatabaseNow('$leaseExpiresAt'),
        sessionActions: {
          $elemMatch: {
            schemaVersion: 'talos.internal-session-action/v1',
            state: 'pending',
            dispatchGeneration: guard.expectedDispatchGeneration
          }
        }
      },
      {
        $set: {
          'sessionActions.$[action].state': 'dispatched',
          'sessionActions.$[action].dispatchGeneration': dispatchGeneration,
          'sessionActions.$[action].dispatchBinding': dispatchBinding,
          'sessionActions.$[action].dispatchClaimId': guard.claimId,
          'sessionActions.$[action].dispatchClaimGeneration': guard.claimGeneration
        },
        $inc: { taskVersion: 1 }
      },
      {
        arrayFilters: [{
          'action.schemaVersion': 'talos.internal-session-action/v1',
          'action.state': 'pending',
          'action.dispatchGeneration': guard.expectedDispatchGeneration
        }],
        returnDocument: 'after'
      }
    );
    if (document === null) return undefined;
    const action = taskFromDocument(document).sessionActions?.find((candidate) => candidate.state === 'dispatched');
    return action?.state === 'dispatched' ? action : undefined;
  }

  public async requeueSessionAction(taskId: string): Promise<void> {
    await this.tasks.updateOne(
      { _id: taskId, sessionActions: { $elemMatch: { state: 'dispatched' } } },
      { $set: { 'sessionActions.$[action].state': 'pending' }, $inc: { taskVersion: 1 } },
      { arrayFilters: [{ 'action.state': 'dispatched' }] }
    );
  }

  public async finalizeSessionAction(
    result: SessionActionResult,
    expectedStates: readonly PendingSessionAction['state'][],
    guard?: SessionActionResultGuard
  ): Promise<boolean> {
    const bindingFilter = guard === undefined ? {} : {
      'sessionActions.dispatchBinding': guard.binding,
      workerId: guard.binding.workerId,
      machineId: guard.binding.machineId,
      leaseToken: guard.leaseToken,
      claimId: guard.claimId,
      claimGeneration: guard.claimGeneration,
      claimCommitted: true,
      status: { $in: ['claimed', 'running', 'closing'] },
      $expr: afterDatabaseNow('$leaseExpiresAt')
    };
    const actionFilter = guard === undefined
      ? { 'action.id': result.actionId, 'action.state': { $in: expectedStates } }
      : {
          'action.id': result.actionId,
          'action.state': 'dispatched',
          'action.dispatchBinding': guard.binding,
          'action.dispatchClaimId': guard.claimId,
          'action.dispatchClaimGeneration': guard.claimGeneration
        };
    const completion: SessionActionResult = guard === undefined
      ? (result.dispatchBinding === undefined ? { ...result, unbound: true } : result)
      : { ...result, dispatchBinding: guard.binding };
    const update = await this.tasks.updateOne(
      {
        _id: result.taskId,
        pendingActionId: result.actionId,
        sessionActions: {
          $elemMatch: guard === undefined
            ? { id: result.actionId, state: { $in: expectedStates } }
            : {
                id: result.actionId, state: 'dispatched', dispatchBinding: guard.binding,
                dispatchClaimId: guard.claimId, dispatchClaimGeneration: guard.claimGeneration
              }
        },
        ...bindingFilter
      },
      {
        $set: {
          'sessionActions.$[action].state': 'completed',
          'sessionActions.$[action].completion': completion,
          lastActionId: result.actionId,
          updatedAt: result.completedAt
        },
        $unset: { pendingActionId: '' },
        $inc: { taskVersion: 1 }
      },
      { arrayFilters: [actionFilter] }
    );
    return update.modifiedCount === 1;
  }

  public async getSessionActionResult(actionId: string): Promise<SessionActionResult | undefined> {
    const taskDocument = await this.tasks.findOne({
      sessionActions: { $elemMatch: { id: actionId, state: 'completed' } }
    });
    if (taskDocument !== null) {
      const action = taskFromDocument(taskDocument).sessionActions?.find((candidate) => candidate.id === actionId);
      if (action?.state === 'completed') return action.completion;
    }
    const document = await this.actionResults.findOne({ _id: actionId });
    if (document !== null) return sessionActionResultFromDocument(document);
    const completed = await this.pendingActions.findOne({ id: actionId, state: 'completed' });
    return completed === null ? undefined : completedSessionActionResultFromDocument(completed);
  }

  public async markSessionActionPending(_taskId: string, _actionId: string, _updatedAt: string): Promise<void> {}

  public async markSessionActionCompleted(_taskId: string, _actionId: string, _completedAt: string): Promise<void> {}

  private async quarantineLegacySessionActions(): Promise<void> {
    while (true) {
      const documents = await this.pendingActions.find(
        { state: { $in: ['pending', 'dispatched'] } },
        { projection: { _id: 1 } }
      ).sort({ _id: 1 }).limit(LEGACY_ACTION_MIGRATION_BATCH_SIZE).toArray();
      if (documents.length === 0) return;
      const completedAt = new Date().toISOString();
      await this.pendingActions.bulkWrite(documents.map((document) => ({
        updateOne: {
          filter: { _id: document._id, state: { $in: ['pending', 'dispatched'] } },
          update: {
            $set: {
              state: 'completed',
              completionResult: LEGACY_ACTION_RECOVERY_ERROR,
              completedAt
            }
          }
        }
      })), { ordered: false });
    }
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

const claimGenerationFilter = (expectedClaimGeneration: number) =>
  expectedClaimGeneration === 0
    ? { $or: [{ claimGeneration: 0 }, { claimGeneration: { $exists: false } }] }
    : { claimGeneration: expectedClaimGeneration };

const taskVersionFilter = (expectedTaskVersion: number) =>
  expectedTaskVersion === 0
    ? { $or: [{ taskVersion: 0 }, { taskVersion: { $exists: false } }] }
    : { taskVersion: expectedTaskVersion };

const optionalFieldFilter = (field: string, value: unknown): Filter<Document> =>
  value === undefined ? { [field]: { $exists: false } } : { [field]: value };

const claimReservationFilter = (reservation: Omit<MachineLeaseReservation, 'expiresAt'>) => ({
  claimId: reservation.claimId,
  claimGeneration: reservation.claimGeneration,
  taskId: reservation.taskId
}) satisfies Filter<MachineLeaseReservation>;

const withoutId = (document: Document): Record<string, unknown> => {
  return Object.fromEntries(Object.entries(document).filter(([key, value]) => key !== '_id' && value !== null));
};

const taskFromDocument = (document: Document): Task => ({
  interaction: 'autonomous',
  workerId: undefined,
  leaseExpiresAt: undefined,
  claimQueuePriority: undefined,
  ...withoutId(document)
}) as unknown as Task;
const poolFromDocument = (document: Document): Pool => withoutId(document) as unknown as Pool;
const machineFromDocument = ({
  _id: _documentId,
  leaseReservations,
  legacyLeaseRecoveryMarkers: _recoveryMarkers,
  ...machine
}: MachineDocument): Machine =>
  leaseReservations == null
    ? machine
    : { ...machine, leaseReservations };
const profileFromDocument = (document: Document): Profile => withoutId(document) as unknown as Profile;
const handoffFromDocument = (document: Document): HandoffLink => withoutId(document) as unknown as HandoffLink;
const webhookFromDocument = (document: Document): WebhookEvent => withoutId(document) as unknown as WebhookEvent;
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
const taskMaintenanceCursorFromDocument = (document: Document): TaskMaintenanceCursor =>
  withoutId(document) as unknown as TaskMaintenanceCursor;

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
