import { conflict, deadlineExceeded, forbidden, notFound, taskCancelled, unauthorized, TalosError } from '../domain/errors.js';
import { timingSafeEqual } from 'node:crypto';
import { taskCreateSchema } from '../domain/schemas.js';
import type { Lease, MachineLeaseReservation, PublicTask, Task, TaskClaimRecoveryReason, TaskClaimGuard, TaskFinding, TaskRecoveryGuard, WebhookEvent } from '../domain/types.js';
import type { Repository, TaskMaintenanceCursor } from '../storage/repository.js';
import { newId } from '../util/id.js';
import type { ProfileLockService } from './profile-lock.js';
import type { Scheduler } from './scheduler.js';
import type { WebhookSigner } from './webhook-signer.js';
import type { SignedWebhook } from './webhook-signer.js';
import type { Logger } from '../util/logger.js';

export interface TaskServiceOptions {
  leaseSeconds?: number;
  clock?: () => number;
  onWebhook?: (event: WebhookEvent, signed: SignedWebhook, callback?: string) => Promise<void>;
  validateCallback?: (callback: string) => void;
  logger?: Pick<Logger, 'warn'>;
}

const CLAIM_RECONCILIATION_BATCH_SIZE = 100;
const TASK_MAINTENANCE_CURSOR_ID = 'task-claim-reconciliation' as const;
const ACTIVE_CLAIM_STATUSES: readonly Task['status'][] = ['claimed', 'running', 'needs_input', 'handoff', 'closing'];
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isValidTimestamp = (value: unknown): value is string => isNonEmptyString(value) && Number.isFinite(Date.parse(value));

export class TaskService {
  private readonly leaseSeconds: number;
  private readonly clock: () => number;
  private readonly onWebhook?: (event: WebhookEvent, signed: SignedWebhook, callback?: string) => Promise<void>;
  private readonly validateCallback?: (callback: string) => void;
  private readonly logger?: Pick<Logger, 'warn'>;
  public constructor(
    private readonly repository: Repository,
    private readonly scheduler: Scheduler,
    private readonly profiles: ProfileLockService,
    private readonly signer: WebhookSigner,
    options: TaskServiceOptions = {}
  ) {
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.clock = options.clock ?? Date.now;
    this.onWebhook = options.onWebhook;
    this.validateCallback = options.validateCallback;
    this.logger = options.logger;
  }

  public async createTask(
    userId: string,
    input: unknown,
    requesterGroups: readonly string[] = [],
    interaction: 'autonomous' | 'interactive' = 'autonomous'
  ): Promise<Task> {
    const data = taskCreateSchema.parse(input);
    if (data.callback !== undefined) this.validateCallback?.(data.callback);
    const profile = data.profile_id === undefined
      ? undefined
      : await this.profiles.assertOwner(data.profile_id, userId);
    if (data.pool_id !== undefined) {
      const pool = await this.repository.getPool(data.pool_id);
      if (pool === undefined) throw notFound('pool not found');
      if (!this.scheduler.poolVisible(pool, userId, requesterGroups)) throw forbidden('pool is not visible to this identity');
      if (profile?.machineId !== undefined) {
        const machine = await this.repository.getMachine(profile.machineId);
        if (machine === undefined) throw notFound('profile pinned machine not found');
        if (machine.poolId !== pool.id) throw conflict('profile pinned machine belongs to a different pool');
      }
    }
    const now = new Date(this.clock()).toISOString();
    const task: Task = {
      id: newId('task'),
      userId,
      kind: data.kind,
      goal: data.goal,
      ...(data.site_hint === undefined ? {} : { siteHint: data.site_hint }),
      ...(data.profile_id === undefined ? {} : { profileId: data.profile_id }),
      ...(data.pool_id === undefined ? {} : { poolId: data.pool_id }),
      ...(requesterGroups.length === 0 ? {} : { requesterGroups: [...requesterGroups] }),
      constraints: data.constraints,
      mode: data.mode,
      interaction,
      ...(data.callback === undefined ? {} : { callback: data.callback }),
      status: 'submitted',
      taskVersion: 0,
      createdAt: now,
      updatedAt: now,
      findings: [],
      artifacts: []
    };
    await this.repository.saveTask(task);
    await this.emit(task, 'task.state_changed', { status: task.status });
    return task;
  }

  public async getTask(id: string, userId: string): Promise<Task> { return this.authorizedTask(id, userId); }

  public async claim(workerId: string, machineId: string, now = this.clock()): Promise<{ task: Task; lease: Lease; leaseToken: string }> {
    const queued = await this.repository.listQueuedTasks();
    for (const candidate of queued) {
      if (candidate.kind === 'testing') continue;
      try {
        const eligible = await this.scheduler.isEligible(candidate, machineId, candidate.userId, candidate.requesterGroups ?? []);
        if (eligible === undefined) continue;
        const expiresAt = new Date(now + this.leaseSeconds * 1000).toISOString();
        const leaseToken = newId('lease');
        const claimId = newId('claim');
        const claimGeneration = (candidate.claimGeneration ?? 0) + 1;
        const task: Task = {
          ...candidate,
          status: 'claimed',
          updatedAt: new Date(now).toISOString(),
          claimedAt: new Date(now).toISOString(),
          leaseExpiresAt: expiresAt,
          leaseToken,
          claimId,
          claimGeneration,
          taskVersion: (candidate.taskVersion ?? 0) + 1,
          claimCommitted: false,
          claimReleased: false,
          claimQueuePriority: candidate.queuePriority,
          queuePriority: undefined,
          workerId,
          machineId
        };
        const claimed = await this.repository.claimTask(task, candidate.claimGeneration ?? 0, candidate.taskVersion ?? 0);
        if (claimed === undefined) continue;
        if (!await this.ensureClaimProjections(claimed)) {
          await this.abortClaim(claimed, now);
          continue;
        }
        const committed = await this.replaceClaimedTask(claimed, { ...claimed, claimCommitted: true });
        if (!await this.verifyClaimProjections(committed)) {
          await this.abortClaim(committed, now);
          continue;
        }
        await this.emit(committed, 'task.state_changed', { status: committed.status });
        return { task: committed, lease: { taskId: committed.id, workerId, machineId, expiresAt }, leaseToken };
      } catch (error) {
        if (error instanceof TalosError && error.code === 'conflict') continue;
        throw error;
      }
    }
    throw notFound('no queued task available for worker');
  }

  public async heartbeat(taskId: string, workerId: string, leaseToken: string, extendSeconds: number): Promise<Task> {
    const task = await this.getWorkerTask(taskId, workerId, leaseToken);
    const now = this.clock();
    const updated: Task = {
      ...task,
      status: task.status === 'claimed' ? 'running' : task.status,
      updatedAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now + extendSeconds * 1000).toISOString()
    };
    const persisted = await this.replaceActiveClaimedTask(task, updated);
    if (!await this.ensureClaimProjections(persisted)) {
      if (persisted.claimCommitted !== true) await this.abortClaim(persisted, now);
      throw conflict('lease accounting could not be renewed');
    }
    if (task.status !== updated.status) await this.emit(updated, 'task.state_changed', { status: updated.status });
    return persisted;
  }

  public async complete(taskId: string, workerId: string, leaseToken: string, status: 'completed' | 'failed', findings: readonly TaskFinding[], error?: { code: string; message: string }): Promise<Task> {
    const task = await this.getWorkerTask(taskId, workerId, leaseToken);
    const updated: Task = {
      ...task,
      status,
      updatedAt: new Date(this.clock()).toISOString(),
      findings: [...findings],
      ...(error === undefined ? {} : { error })
    };
    await this.replaceClaimedTask(task, updated);
    await this.releaseLease(updated);
    await this.emit(updated, 'task.state_changed', { status });
    if (status === 'completed') await this.emit(updated, 'task.completed', { status });
    return updated;
  }

  public async addArtifact(taskId: string, workerId: string, leaseToken: string, artifact: Task['artifacts'][number]): Promise<Task> {
    const task = await this.getWorkerTask(taskId, workerId, leaseToken);
    const updated: Task = {
      ...task,
      updatedAt: new Date(this.clock()).toISOString(),
      artifacts: [...task.artifacts, artifact]
    };
    await this.replaceClaimedTask(task, updated);
    return updated;
  }

  public async provideInput(id: string, userId: string, input: NonNullable<Task['input']>): Promise<Task> {
    const task = await this.authorizedTask(id, userId);
    if (task.interaction === 'interactive') throw conflict('interactive sessions do not accept task input');
    if (task.status !== 'needs_input') throw conflict('task is not waiting for input');
    const now = this.clock();
    await this.repository.savePendingInput(id, input);
    const updated: Task = {
      ...task,
      status: 'running',
      updatedAt: new Date(now).toISOString(),
      leaseExpiresAt: task.workerId === undefined ? task.leaseExpiresAt : new Date(now + this.leaseSeconds * 1000).toISOString()
    };
    if (task.workerId !== undefined) {
      await this.replaceClaimedTask(task, updated);
      if (!await this.ensureClaimProjections(updated)) throw conflict('lease accounting could not be renewed');
    } else if (!await this.repository.replaceSubmittedTask(updated, task.claimGeneration ?? 0, task.taskVersion ?? 0)) {
      throw conflict('task state changed concurrently');
    }
    await this.emit(updated, 'task.state_changed', { status: updated.status });
    return updated;
  }

  public async needsInput(taskId: string, workerId: string, leaseToken: string): Promise<Task> {
    const task = await this.getWorkerTask(taskId, workerId, leaseToken);
    if (task.interaction === 'interactive') throw conflict('interactive sessions do not accept task input');
    const updated: Task = {
      ...task,
      status: 'needs_input',
      updatedAt: new Date(this.clock()).toISOString()
    };
    await this.replaceClaimedTask(task, updated);
    await this.emit(updated, 'task.needs_input', { status: updated.status });
    return updated;
  }

  public async getWorkerInput(taskId: string, workerId: string, leaseToken: string): Promise<Task['input']> {
    const task = await this.getWorkerTask(taskId, workerId, leaseToken);
    if (task.interaction === 'interactive') throw conflict('interactive sessions do not accept task input');
    return this.repository.takePendingInput(taskId);
  }

  public async requestHandoff(id: string, userId: string, expiresInSeconds: number): Promise<{ handoff_url: string; expires: string }> {
    const task = await this.authorizedTask(id, userId);
    if (task.interaction === 'interactive') throw conflict('interactive sessions do not support handoff');
    if (!['running', 'claimed'].includes(task.status)) throw conflict('task cannot request handoff in current state');
    const expires = new Date(this.clock() + expiresInSeconds * 1000).toISOString();
    const linkId = newId('handoff');
    const url = `/v1/handoffs/${linkId}`;
    await this.repository.saveHandoff({ id: linkId, taskId: id, userId, url, expiresAt: expires, used: false });
    const updated: Task = {
      ...task,
      status: 'handoff',
      updatedAt: new Date(this.clock()).toISOString(),
      handoff: { url, expiresAt: expires }
    };
    await this.replaceClaimedTask(task, updated);
    await this.emit(updated, 'task.handoff_requested', { handoff_url: url, expires });
    return { handoff_url: url, expires };
  }

  public async cancel(id: string, userId: string): Promise<Task> {
    const task = await this.authorizedTask(id, userId);
    if (task.interaction === 'interactive') throw conflict('interactive sessions must be closed through the session API');
    if (['completed', 'failed', 'cancelled'].includes(task.status)) throw conflict('task is already terminal');
    const updated: Task = {
      ...task,
      status: 'cancelled',
      updatedAt: new Date(this.clock()).toISOString()
    };
    if (task.status === 'submitted') {
      if (!await this.repository.replaceSubmittedTask(updated, task.claimGeneration ?? 0, task.taskVersion ?? 0)) throw conflict('task state changed concurrently');
    } else {
      await this.replaceClaimedTask(task, updated);
      await this.releaseLease(updated);
    }
    await this.emit(updated, 'task.state_changed', { status: updated.status });
    return updated;
  }

  public async closeInteractive(id: string, userId: string): Promise<Task> {
    const task = await this.authorizedTask(id, userId);
    if (task.interaction !== 'interactive') throw conflict('task is not an interactive session');
    if (['completed', 'failed', 'cancelled'].includes(task.status)) throw conflict('session is already terminal');
    const status = task.status === 'submitted' ? 'completed' : 'closing';
    const updated: Task = {
      ...task,
      status,
      updatedAt: new Date(this.clock()).toISOString()
    };
    if (task.status === 'submitted') {
      if (!await this.repository.replaceSubmittedTask(updated, task.claimGeneration ?? 0, task.taskVersion ?? 0)) throw conflict('task state changed concurrently');
    } else {
      await this.replaceClaimedTask(task, updated);
    }
    await this.emit(updated, 'task.state_changed', { status });
    if (status === 'completed') await this.emit(updated, 'task.completed', { status });
    return updated;
  }

  public async expireLeases(now = this.clock()): Promise<readonly Task[]> {
    await this.reconcileClaims(now);
    const active = await this.repository.listExpirableTasks(now, CLAIM_RECONCILIATION_BATCH_SIZE);
    const expired: Task[] = [];
    for (const candidate of active) {
      try {
        const result = await this.expireTaskCandidate(candidate, now);
        if (result !== undefined) expired.push(result);
      } catch {
        this.logger?.warn('task lease expiry failed', { taskId: candidate.id, error: 'claim_maintenance_failed' });
      }
    }
    await this.reconcileClaims(now);
    return expired;
  }

  private async expireTaskCandidate(candidate: Task, now: number): Promise<Task | undefined> {
      const current = await this.repository.getTask(candidate.id);
      if (current?.kind === 'testing' || current === undefined) return undefined;
      const malformedReason = this.malformedClaimReason(current);
      if (
        current.claimRecovery !== undefined ||
        malformedReason !== undefined ||
        (ACTIVE_CLAIM_STATUSES.includes(current.status) && current.claimId === undefined && current.claimGeneration === undefined)
      ) {
        await this.processTaskClaimMaintenance(current, now, malformedReason);
        return undefined;
      }
      if (current?.status === 'submitted' && current.constraints.deadline !== undefined && Date.parse(current.constraints.deadline) <= now) {
        const failed: Task = {
          ...current,
          status: 'failed',
          updatedAt: new Date(now).toISOString(),
          error: { code: 'deadline_exceeded', message: deadlineExceeded().message }
        };
        if (await this.repository.replaceSubmittedTask(failed, current.claimGeneration ?? 0, current.taskVersion ?? 0)) {
          await this.emit(failed, 'task.state_changed', { status: failed.status, error: failed.error });
        }
        return undefined;
      }
      if (current?.leaseExpiresAt !== undefined && Date.parse(current.leaseExpiresAt) <= now && ['claimed', 'running', 'closing'].includes(current.status)) {
        if (current.status === 'closing') {
          const pending = await this.repository.getPendingSessionAction(current.id);
          if (pending !== undefined) {
            await this.repository.finalizeSessionAction({
              actionId: pending.id,
              taskId: current.id,
              result: { error: { code: 'session_closed', message: 'session closed before the action completed' } },
              completedAt: new Date(now).toISOString()
            }, ['pending', 'dispatched']);
          }
          const completed: Task = {
            ...current,
            status: 'completed',
            pendingActionId: undefined,
            updatedAt: new Date(now).toISOString()
          };
          if (!await this.tryReplaceClaimedTask(current, completed)) return undefined;
          await this.releaseLease(completed);
          await this.emit(completed, 'task.state_changed', { status: completed.status });
          await this.emit(completed, 'task.completed', { status: completed.status });
          return undefined;
        }
        const requeued: Task = {
          ...current,
          status: 'submitted',
          updatedAt: new Date(now).toISOString(),
          leaseExpiresAt: undefined,
          leaseToken: undefined,
          workerId: undefined,
          queuePriority: -1
        };
        if (!await this.tryReplaceClaimedTask(current, requeued)) return undefined;
        if (current.interaction === 'interactive') await this.repository.requeueSessionAction(current.id);
        await this.releaseLease(current);
        return requeued;
      }
      return undefined;
  }

  public async reconcileClaims(now = this.clock()): Promise<void> {
    let cursor = await this.getOrCreateTaskMaintenanceCursor(now);
    let tasks = await this.repository.listTaskMaintenancePage(cursor, CLAIM_RECONCILIATION_BATCH_SIZE);
    if (tasks.length === 0) {
      const highWatermark = await this.repository.getTaskMaintenanceHighWatermark();
      const wrapped: TaskMaintenanceCursor = {
        id: TASK_MAINTENANCE_CURSOR_ID,
        version: cursor.version + 1,
        cycleCutoffAt: highWatermark ?? new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString()
      };
      if (!await this.repository.replaceTaskMaintenanceCursor(wrapped, cursor.version)) return;
      cursor = wrapped;
      tasks = await this.repository.listTaskMaintenancePage(cursor, CLAIM_RECONCILIATION_BATCH_SIZE);
      if (tasks.length === 0) return;
    }
    for (const task of tasks) {
      try {
        await this.processTaskClaimMaintenance(task, now);
      } catch {
        this.logger?.warn('task claim reconciliation failed', {
          taskId: task.id,
          error: 'claim_maintenance_failed'
        });
      }
    }
    const last = tasks[tasks.length - 1]!;
    await this.repository.replaceTaskMaintenanceCursor({
      ...cursor,
      version: cursor.version + 1,
      afterCreatedAt: last.createdAt,
      afterTaskId: last.id,
      updatedAt: new Date(now).toISOString()
    }, cursor.version);
  }

  private async getOrCreateTaskMaintenanceCursor(now: number): Promise<TaskMaintenanceCursor> {
    const existing = await this.repository.getTaskMaintenanceCursor(TASK_MAINTENANCE_CURSOR_ID);
    if (existing !== undefined) return existing;
    const highWatermark = await this.repository.getTaskMaintenanceHighWatermark();
    const cursor: TaskMaintenanceCursor = {
      id: TASK_MAINTENANCE_CURSOR_ID,
      version: 0,
      cycleCutoffAt: highWatermark ?? new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString()
    };
    if (await this.repository.createTaskMaintenanceCursor(cursor)) return cursor;
    const concurrent = await this.repository.getTaskMaintenanceCursor(TASK_MAINTENANCE_CURSOR_ID);
    if (concurrent === undefined) throw new Error('task maintenance cursor unavailable');
    return concurrent;
  }

  private async processTaskClaimMaintenance(task: Task, now: number, knownMalformedReason?: TaskClaimRecoveryReason): Promise<void> {
    if (task.kind === 'testing') return;
    if (task.claimRecovery !== undefined) {
      if (task.claimRecovery.kind === 'legacy' && task.claimRecovery.phase !== 'quarantined') {
        await this.continueLegacyClaimRecovery(task, now);
      } else if (task.claimRecovery.kind === 'malformed' && task.claimRecovery.phase !== 'quarantined') {
        await this.continueMalformedClaimRecovery(task, now);
      }
      return;
    }
    const malformedReason = knownMalformedReason ?? this.malformedClaimReason(task);
    if (malformedReason !== undefined) {
      await this.beginMalformedClaimRecovery(task, malformedReason, now);
      return;
    }
    if (ACTIVE_CLAIM_STATUSES.includes(task.status) && task.claimId === undefined && task.claimGeneration === undefined) {
      await this.beginLegacyClaimRecovery(task, now);
      return;
    }
    if (this.isActiveClaim(task)) {
      const projectionsReady = await this.ensureClaimProjections(task);
      if (!projectionsReady && task.claimCommitted !== true) await this.abortClaim(task, now);
      else if (projectionsReady && task.claimCommitted !== true) {
        await this.replaceClaimedTask(task, { ...task, claimCommitted: true });
      }
      return;
    }
    if (task.claimId !== undefined && task.claimGeneration !== undefined) await this.releaseLease(task);
  }

  private malformedClaimReason(task: Task): TaskClaimRecoveryReason | undefined {
    const hasClaimId = task.claimId !== undefined;
    const hasClaimGeneration = task.claimGeneration !== undefined;
    if (hasClaimId !== hasClaimGeneration) return 'partial_claim_identity';
    if (hasClaimId && !isNonEmptyString(task.claimId)) return 'invalid_claim_credentials';
    if (hasClaimGeneration && (!Number.isInteger(task.claimGeneration) || task.claimGeneration! <= 0)) {
      return 'invalid_claim_generation';
    }
    if (!ACTIVE_CLAIM_STATUSES.includes(task.status) || !hasClaimId) return undefined;
    if (
      !isNonEmptyString(task.machineId) ||
      !isNonEmptyString(task.workerId) ||
      !isNonEmptyString(task.leaseToken) ||
      task.leaseExpiresAt === undefined
    ) return 'active_claim_missing_credentials';
    if (!isValidTimestamp(task.leaseExpiresAt)) return 'invalid_lease_expiry';
    if (task.claimReleased === true) return 'active_claim_marked_released';
    return undefined;
  }

  private recoveryGuard(task: Task): TaskRecoveryGuard {
    return {
      status: task.status,
      taskVersion: task.taskVersion ?? 0,
      updatedAt: task.updatedAt,
      claimId: task.claimId,
      claimGeneration: task.claimGeneration,
      recoveryId: task.claimRecovery?.recoveryId,
      recoveryPhase: task.claimRecovery?.phase
    };
  }

  private async beginLegacyClaimRecovery(task: Task, now: number): Promise<void> {
    if (!ACTIVE_CLAIM_STATUSES.includes(task.status)) return;
    const timestamp = new Date(now).toISOString();
    const recovering: Task = {
      ...task,
      updatedAt: timestamp,
      claimRecovery: {
        schemaVersion: 'talos.task-claim-recovery/v1',
        recoveryId: newId('recovery'),
        kind: 'legacy',
        phase: 'draining',
        sourceStatus: task.status,
        ...(task.machineId === undefined ? {} : { sourceMachineId: task.machineId }),
        ...(task.profileId === undefined ? {} : { sourceProfileId: task.profileId }),
        restoredQueuePriority: task.claimQueuePriority ?? task.queuePriority ?? 0,
        startedAt: timestamp,
        updatedAt: timestamp
      }
    };
    if (!await this.repository.replaceTaskForRecovery(recovering, this.recoveryGuard(task))) return;
    const persisted = await this.repository.getTask(task.id);
    if (persisted !== undefined) await this.continueLegacyClaimRecovery(persisted, now);
  }

  private async continueLegacyClaimRecovery(task: Task, now: number): Promise<void> {
    const recovery = task.claimRecovery;
    if (recovery?.kind !== 'legacy' || recovery.phase === 'quarantined') return;
    const timestamp = new Date(now).toISOString();
    if (recovery.phase === 'draining') {
      if (recovery.sourceProfileId !== undefined) {
        const profile = await this.repository.getProfile(recovery.sourceProfileId);
        if (
          profile?.lockedByTaskId === task.id &&
          (profile.lockedByClaimId !== undefined || profile.lockedByClaimGeneration !== undefined)
        ) {
          await this.quarantineLegacyClaimRecovery(task, now);
          return;
        }
      }
      if (recovery.sourceStatus === 'closing') {
        const pending = await this.repository.getPendingSessionAction(task.id);
        if (pending !== undefined) {
          await this.repository.finalizeSessionAction({
            actionId: pending.id,
            taskId: task.id,
            result: { error: { code: 'session_closed', message: 'session closed before the action completed' } },
            completedAt: timestamp
          }, ['pending', 'dispatched']);
        }
      }
      if (recovery.sourceMachineId !== undefined) {
        await this.repository.releaseLegacyMachineLease(recovery.sourceMachineId, recovery.recoveryId, task.id);
      }
      if (recovery.sourceProfileId !== undefined) {
        await this.repository.releaseLegacyProfileLease(recovery.sourceProfileId, task.id);
      }
      if (recovery.sourceStatus !== 'closing' && task.interaction === 'interactive') {
        await this.repository.requeueSessionAction(task.id);
      }
      const finalizing: Task = {
        ...task,
        status: recovery.sourceStatus === 'closing' ? 'completed' : 'submitted',
        updatedAt: timestamp,
        workerId: undefined,
        machineId: undefined,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        claimCommitted: undefined,
        claimReleased: undefined,
        claimQueuePriority: undefined,
        ...(recovery.sourceStatus === 'closing'
          ? { pendingActionId: undefined }
          : { queuePriority: recovery.restoredQueuePriority }),
        claimRecovery: { ...recovery, phase: 'finalizing', updatedAt: timestamp }
      };
      if (!await this.repository.replaceTaskForRecovery(finalizing, this.recoveryGuard(task))) return;
      const persisted = await this.repository.getTask(task.id);
      if (persisted !== undefined) await this.continueLegacyClaimRecovery(persisted, now);
      return;
    }
    if (recovery.sourceMachineId !== undefined) {
      await this.repository.clearLegacyMachineLeaseMarker(recovery.sourceMachineId, recovery.recoveryId);
    }
    await this.repository.replaceTaskForRecovery({
      ...task,
      updatedAt: timestamp,
      claimRecovery: undefined
    }, this.recoveryGuard(task));
  }

  private async quarantineLegacyClaimRecovery(task: Task, now: number): Promise<void> {
    const recovery = task.claimRecovery;
    if (recovery?.kind !== 'legacy') return;
    const timestamp = new Date(now).toISOString();
    await this.repository.replaceTaskForRecovery({
      ...task,
      status: 'failed',
      updatedAt: timestamp,
      workerId: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      error: { code: 'claim_state_malformed', message: 'task claim state requires operator recovery' },
      claimRecovery: {
        ...recovery,
        kind: 'malformed',
        phase: 'quarantined',
        reasonCode: 'legacy_profile_identity_conflict',
        updatedAt: timestamp
      }
    }, this.recoveryGuard(task));
  }

  private async beginMalformedClaimRecovery(task: Task, reason: TaskClaimRecoveryReason, now: number): Promise<void> {
    const timestamp = new Date(now).toISOString();
    const recovering: Task = {
      ...task,
      updatedAt: timestamp,
      claimRecovery: {
        schemaVersion: 'talos.task-claim-recovery/v1',
        recoveryId: newId('recovery'),
        kind: 'malformed',
        phase: 'draining',
        sourceStatus: task.status,
        ...(task.machineId === undefined ? {} : { sourceMachineId: task.machineId }),
        ...(task.profileId === undefined ? {} : { sourceProfileId: task.profileId }),
        restoredQueuePriority: task.claimQueuePriority ?? task.queuePriority ?? 0,
        reasonCode: reason,
        startedAt: timestamp,
        updatedAt: timestamp
      }
    };
    if (!await this.repository.replaceTaskForRecovery(recovering, this.recoveryGuard(task))) return;
    const persisted = await this.repository.getTask(task.id);
    if (persisted !== undefined) await this.continueMalformedClaimRecovery(persisted, now);
  }

  private async continueMalformedClaimRecovery(task: Task, now: number): Promise<void> {
    const recovery = task.claimRecovery;
    if (recovery?.kind !== 'malformed' || recovery.phase === 'quarantined') return;
    if (
      isNonEmptyString(task.claimId) &&
      typeof task.claimGeneration === 'number' &&
      Number.isInteger(task.claimGeneration) &&
      task.claimGeneration > 0
    ) {
      const reservation = {
        taskId: task.id,
        claimId: task.claimId,
        claimGeneration: task.claimGeneration
      };
      let machineReleased = false;
      if (isNonEmptyString(recovery.sourceMachineId)) {
        machineReleased = await this.repository.releaseMachineLease(recovery.sourceMachineId, reservation);
      }
      if (!machineReleased && isNonEmptyString(task.machineId) && task.machineId !== recovery.sourceMachineId) {
        machineReleased = await this.repository.releaseMachineLease(task.machineId, reservation);
      }
      if (!machineReleased) await this.repository.releaseMachineLeaseReservation(reservation);
      if (isNonEmptyString(recovery.sourceProfileId)) {
        await this.repository.releaseProfileLease(recovery.sourceProfileId, reservation);
      }
    }
    const timestamp = new Date(now).toISOString();
    await this.repository.replaceTaskForRecovery({
      ...task,
      status: 'failed',
      updatedAt: timestamp,
      workerId: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      error: { code: 'claim_state_malformed', message: 'task claim state requires operator recovery' },
      claimRecovery: { ...recovery, phase: 'quarantined', updatedAt: timestamp }
    }, this.recoveryGuard(task));
  }

  private async authorizedTask(id: string, userId: string): Promise<Task> {
    const task = await this.repository.getTask(id);
    if (task === undefined) throw notFound('task not found');
    if (task.userId !== userId) throw forbidden('task belongs to another user');
    if (task.kind === 'testing') throw conflict('testing tasks require the Testing Tool API');
    return task;
  }

  public async getWorkerTask(taskId: string, workerId: string, leaseToken: string): Promise<Task> {
    const task = await this.repository.getTask(taskId);
    if (task === undefined) throw notFound('task not found');
    if (task.kind === 'testing') throw conflict('testing tasks require the Testing Executor API');
    if (task.claimRecovery !== undefined || this.malformedClaimReason(task) !== undefined) {
      throw unauthorized('worker does not own active lease');
    }
    if (
      task.workerId !== workerId ||
      task.leaseToken === undefined ||
      task.claimId === undefined ||
      task.claimGeneration === undefined ||
      task.claimGeneration <= 0
    ) throw unauthorized('worker does not own active lease');
    const expected = Buffer.from(task.leaseToken);
    const actual = Buffer.from(leaseToken);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw unauthorized('invalid lease token');
    if (task.status === 'cancelled') throw taskCancelled();
    if (
      task.claimCommitted !== true ||
      !['claimed', 'running', 'needs_input', 'handoff', 'closing'].includes(task.status)
    ) throw unauthorized('worker does not own active lease');
    if (task.leaseExpiresAt !== undefined && Date.parse(task.leaseExpiresAt) <= this.clock() && !['needs_input', 'handoff'].includes(task.status)) throw unauthorized('lease expired');
    return task;
  }

  public async getWorkerActionResultTask(
    taskId: string,
    actionId: string,
    workerId: string,
    machineId: string | undefined,
    leaseToken: string,
    hasStoredResult: (taskId: string, actionId: string) => Promise<boolean>
  ): Promise<Task> {
    const task = await this.repository.getTask(taskId);
    if (task === undefined) throw unauthorized('worker does not own action result');
    if (task.kind === 'testing') throw conflict('testing tasks require the Testing Executor API');
    if (
      task.claimRecovery !== undefined ||
      this.malformedClaimReason(task) !== undefined ||
      task.workerId !== workerId ||
      task.machineId === undefined ||
      task.leaseToken === undefined
    ) {
      throw unauthorized('worker does not own action result');
    }
    const expected = Buffer.from(task.leaseToken);
    const actual = Buffer.from(leaseToken);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw unauthorized('invalid lease token');
    }
    if (machineId !== undefined && task.machineId !== machineId) {
      throw unauthorized('worker does not own action result');
    }
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      if (machineId === undefined) throw unauthorized('authenticated machine is required for terminal action result');
      if (!await hasStoredResult(taskId, actionId)) throw unauthorized('worker does not own action result');
      return task;
    }
    return this.getWorkerTask(taskId, workerId, leaseToken);
  }

  private async replaceClaimedTask(current: Task, updated: Task): Promise<Task> {
    if (!await this.tryReplaceClaimedTask(current, updated)) throw unauthorized('lease generation is no longer active');
    const persisted = await this.repository.getTask(current.id);
    if (persisted === undefined) throw unauthorized('lease generation is no longer active');
    return persisted;
  }

  private async replaceActiveClaimedTask(current: Task, updated: Task): Promise<Task> {
    const guard = this.claimGuard(current);
    if (current.leaseExpiresAt === undefined) throw unauthorized('lease generation is no longer active');
    if (!await this.repository.replaceTaskForActiveClaim(updated, { ...guard, leaseExpiresAt: current.leaseExpiresAt })) {
      throw unauthorized('lease generation is no longer active');
    }
    const persisted = await this.repository.getTask(current.id);
    if (persisted === undefined) throw unauthorized('lease generation is no longer active');
    return persisted;
  }

  private async tryReplaceClaimedTask(current: Task, updated: Task): Promise<boolean> {
    return this.repository.replaceTaskForClaim(updated, this.claimGuard(current));
  }

  private claimGuard(task: Task): TaskClaimGuard {
    if (task.claimId === undefined || task.claimGeneration === undefined || task.claimGeneration <= 0) {
      throw unauthorized('lease generation is no longer active');
    }
    return { claimId: task.claimId, claimGeneration: task.claimGeneration, taskVersion: task.taskVersion ?? 0, status: task.status };
  }

  private reservation(task: Task): MachineLeaseReservation {
    const guard = this.claimGuard(task);
    if (task.leaseExpiresAt === undefined) throw unauthorized('lease generation is no longer active');
    return {
      taskId: task.id,
      claimId: guard.claimId,
      claimGeneration: guard.claimGeneration,
      expiresAt: task.leaseExpiresAt
    };
  }

  private async ensureClaimProjections(task: Task): Promise<boolean> {
    if (task.machineId === undefined) return false;
    const requested = this.reservation(task);
    const authoritative = await this.repository.getTask(task.id);
    if (authoritative === undefined || !this.matchesActiveClaim(authoritative, requested) || authoritative.machineId !== task.machineId) return false;
    const reservation = this.reservation(authoritative);
    if (!await this.repository.reserveMachineLease(task.machineId, reservation)) return false;
    await this.repository.renewMachineLease(task.machineId, reservation);
    if (task.profileId !== undefined) {
      if (!await this.acquireProfileProjection(task, reservation)) {
        await this.repository.releaseMachineLease(task.machineId, reservation);
        return false;
      }
    }
    const committed = await this.repository.getTask(task.id);
    if (this.matchesActiveClaim(committed, reservation) && committed?.machineId === task.machineId) return true;
    await this.repository.releaseMachineLease(task.machineId, reservation);
    if (task.profileId !== undefined) await this.profiles.release(task.profileId, reservation);
    return false;
  }

  private async acquireProfileProjection(task: Task, reservation: MachineLeaseReservation): Promise<boolean> {
    if (task.profileId === undefined || task.machineId === undefined) return false;
    try {
      await this.profiles.acquire(task.profileId, task.userId, task.machineId, reservation);
      return true;
    } catch (error) {
      if (!(error instanceof TalosError) || error.code !== 'conflict') throw error;
    }

    const profile = await this.repository.getProfile(task.profileId);
    if (
      profile?.lockedByTaskId === undefined ||
      profile.lockedByClaimId === undefined ||
      profile.lockedByClaimGeneration === undefined
    ) return false;
    const previous = await this.repository.getTask(profile.lockedByTaskId);
    if (
      previous === undefined ||
      previous.kind === 'testing' ||
      previous.profileId !== task.profileId ||
      previous.claimId !== profile.lockedByClaimId ||
      previous.claimGeneration !== profile.lockedByClaimGeneration ||
      previous.leaseExpiresAt === undefined ||
      !['claimed', 'running'].includes(previous.status)
    ) return false;
    const requeued: Task = {
      ...previous,
      status: 'submitted',
      updatedAt: new Date(this.clock()).toISOString(),
      leaseExpiresAt: undefined,
      leaseToken: undefined,
      workerId: undefined,
      queuePriority: previous.claimQueuePriority,
      claimQueuePriority: undefined
    };
    if (!await this.repository.replaceTaskForExpiredClaim(requeued, {
      ...this.claimGuard(previous),
      leaseExpiresAt: previous.leaseExpiresAt
    })) return false;
    if (previous.interaction === 'interactive') await this.repository.requeueSessionAction(previous.id);
    await this.releaseLease(previous);
    try {
      await this.profiles.acquire(task.profileId, task.userId, task.machineId, reservation);
      return true;
    } catch (error) {
      if (error instanceof TalosError && error.code === 'conflict') return false;
      throw error;
    }
  }

  private async verifyClaimProjections(task: Task): Promise<boolean> {
    if (task.machineId === undefined) return false;
    const reservation = this.reservation(task);
    const machine = await this.repository.getMachine(task.machineId);
    if (machine === undefined) return false;
    const machineCommitted = machine?.leaseReservations?.some((entry) =>
      entry.taskId === reservation.taskId &&
      entry.claimId === reservation.claimId &&
      entry.claimGeneration === reservation.claimGeneration
    ) === true;
    if (!machineCommitted || machine.activeLeases > machine.capacity || machine.activeLeases < (machine.leaseReservations?.length ?? 0)) return false;
    if (task.profileId === undefined) return true;
    const profile = await this.repository.getProfile(task.profileId);
    return profile?.lockedByTaskId === reservation.taskId &&
      profile.lockedByClaimId === reservation.claimId &&
      profile.lockedByClaimGeneration === reservation.claimGeneration;
  }

  private async abortClaim(task: Task, now = this.clock()): Promise<void> {
    const requeued: Task = {
      ...task,
      status: 'submitted',
      updatedAt: new Date(now).toISOString(),
      leaseExpiresAt: undefined,
      leaseToken: undefined,
      workerId: undefined,
      claimCommitted: false,
      queuePriority: task.claimQueuePriority,
      claimQueuePriority: undefined
    };
    if (!await this.tryReplaceClaimedTask(task, requeued)) return;
    await this.releaseLease(task);
  }

  private isActiveClaim(task: Task): boolean {
    return this.matchesActiveClaim(task, task.claimId === undefined || task.claimGeneration === undefined
      ? undefined
      : { taskId: task.id, claimId: task.claimId, claimGeneration: task.claimGeneration });
  }

  private matchesActiveClaim(task: Task | undefined, reservation: Omit<MachineLeaseReservation, 'expiresAt'> | undefined): boolean {
    return task !== undefined &&
      reservation !== undefined &&
      ['claimed', 'running', 'needs_input', 'handoff', 'closing'].includes(task.status) &&
      task.claimId === reservation.claimId &&
      task.claimGeneration === reservation.claimGeneration;
  }

  private async releaseLease(task: Task): Promise<void> {
    if (task.claimId === undefined || task.claimGeneration === undefined) return;
    const reservation = { taskId: task.id, claimId: task.claimId, claimGeneration: task.claimGeneration };
    const current = await this.repository.getTask(task.id);
    if (current?.claimId !== reservation.claimId || current.claimGeneration !== reservation.claimGeneration || current.claimReleased === true) return;
    let machineReleased = false;
    if (current.machineId !== undefined) {
      machineReleased = await this.repository.releaseMachineLease(current.machineId, reservation);
    }
    if (!machineReleased && task.machineId !== undefined && task.machineId !== current.machineId) {
      machineReleased = await this.repository.releaseMachineLease(task.machineId, reservation);
    }
    if (!machineReleased) await this.repository.releaseMachineLeaseReservation(reservation);
    if (current.profileId !== undefined) await this.profiles.release(current.profileId, reservation);
    await this.repository.replaceTaskForClaim({
      ...current,
      claimCommitted: false,
      claimReleased: true
    }, this.claimGuard(current));
  }

  private async emit(task: Task, type: WebhookEvent['type'], payload: Record<string, unknown>): Promise<SignedWebhook> {
    const event: WebhookEvent = {
      id: newId('evt'),
      type,
      taskId: task.id,
      userId: task.userId,
      timestamp: new Date(this.clock()).toISOString(),
      payload,
      delivery: { status: 'pending', attempts: 0 }
    };
    await this.repository.saveWebhook(event);
    const signed = this.signer.sign(event, this.clock());
    if (this.onWebhook !== undefined) {
      void this.onWebhook(event, signed, task.callback).catch((error: unknown) => {
        this.logger?.warn('webhook delivery failed', {
          eventId: event.id,
          error: error instanceof Error ? error.message : 'unknown'
        });
      });
    }
    return signed;
  }

  public toPublicTask(task: Task): PublicTask {
    const hidden = new Set([
      'leaseToken',
      'claimId',
      'claimGeneration',
      'taskVersion',
      'claimCommitted',
      'claimReleased',
      'claimQueuePriority',
      'queuePriority',
      'workerId',
      'machineId',
      'leaseExpiresAt',
      'input',
      'requesterGroups',
      'claimRecovery',
      'testing'
    ]);
    return {
      interaction: task.interaction ?? 'autonomous',
      ...Object.fromEntries(
      Object.entries(task).filter(([key]) => !hidden.has(key))
      )
    } as unknown as PublicTask;
  }
}
