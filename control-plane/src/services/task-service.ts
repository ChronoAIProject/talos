import { conflict, deadlineExceeded, forbidden, notFound, taskCancelled, unauthorized, TalosError } from '../domain/errors.js';
import { timingSafeEqual } from 'node:crypto';
import { taskCreateSchema } from '../domain/schemas.js';
import type { Lease, MachineLeaseReservation, PublicTask, Task, TaskClaimGuard, TaskFinding, WebhookEvent } from '../domain/types.js';
import type { Repository } from '../storage/repository.js';
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
    await this.reconcileClaims(now);
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
          queuePriority: undefined,
          workerId,
          machineId
        };
        const claimed = await this.repository.claimTask(task, candidate.claimGeneration ?? 0);
        if (claimed === undefined) continue;
        if (!await this.ensureClaimProjections(claimed, now)) {
          await this.abortClaim(claimed, candidate.queuePriority, now);
          continue;
        }
        await this.emit(claimed, 'task.state_changed', { status: claimed.status });
        return { task: claimed, lease: { taskId: claimed.id, workerId, machineId, expiresAt }, leaseToken };
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
    await this.replaceClaimedTask(task, updated);
    if (!await this.ensureClaimProjections(updated, now)) {
      await this.abortClaim(updated, -1, now);
      throw conflict('lease accounting could not be renewed');
    }
    if (task.status !== updated.status) await this.emit(updated, 'task.state_changed', { status: updated.status });
    return updated;
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
      if (!await this.ensureClaimProjections(updated, now)) throw conflict('lease accounting could not be renewed');
    } else if (!await this.repository.replaceSubmittedTask(updated, task.claimGeneration ?? 0)) {
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
      if (!await this.repository.replaceSubmittedTask(updated, task.claimGeneration ?? 0)) throw conflict('task state changed concurrently');
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
      if (!await this.repository.replaceSubmittedTask(updated, task.claimGeneration ?? 0)) throw conflict('task state changed concurrently');
    } else {
      await this.replaceClaimedTask(task, updated);
    }
    await this.emit(updated, 'task.state_changed', { status });
    if (status === 'completed') await this.emit(updated, 'task.completed', { status });
    return updated;
  }

  public async expireLeases(now = this.clock()): Promise<readonly Task[]> {
    await this.reconcileClaims(now);
    const active = await this.repository.listTasks();
    const expired: Task[] = [];
    for (const candidate of active) {
      const current = await this.repository.getTask(candidate.id);
      if (current?.kind === 'testing') continue;
      if (current?.status === 'submitted' && current.constraints.deadline !== undefined && Date.parse(current.constraints.deadline) <= now) {
        const failed: Task = {
          ...current,
          status: 'failed',
          updatedAt: new Date(now).toISOString(),
          error: { code: 'deadline_exceeded', message: deadlineExceeded().message }
        };
        if (await this.repository.replaceSubmittedTask(failed, current.claimGeneration ?? 0)) {
          await this.emit(failed, 'task.state_changed', { status: failed.status, error: failed.error });
        }
        continue;
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
          if (!await this.tryReplaceClaimedTask(current, completed)) continue;
          await this.releaseLease(completed);
          await this.emit(completed, 'task.state_changed', { status: completed.status });
          await this.emit(completed, 'task.completed', { status: completed.status });
          continue;
        }
        const requeued: Task = {
          ...current,
          status: 'submitted',
          updatedAt: new Date(now).toISOString(),
          leaseExpiresAt: undefined,
          leaseToken: undefined,
          workerId: undefined,
          machineId: undefined,
          queuePriority: -1
        };
        if (!await this.tryReplaceClaimedTask(current, requeued)) continue;
        if (current.interaction === 'interactive') await this.repository.requeueSessionAction(current.id);
        await this.releaseLease(current);
        expired.push(requeued);
      }
    }
    await this.reconcileClaims(now);
    return expired;
  }

  public async reconcileClaims(now = this.clock()): Promise<void> {
    const tasks = (await this.repository.listTasks()).filter((task) => task.kind !== 'testing');
    for (const task of tasks) {
      if (!this.isActiveClaim(task)) continue;
      if (!await this.ensureClaimProjections(task, now)) await this.abortClaim(task, -1, now);
    }

    const currentTasks = new Map((await this.repository.listTasks()).map((task) => [task.id, task]));
    for (const machine of await this.repository.listMachines()) {
      for (const reservation of machine.leaseReservations ?? []) {
        const task = currentTasks.get(reservation.taskId);
        if (!this.matchesActiveClaim(task, reservation)) {
          await this.repository.releaseMachineLease(machine.id, reservation);
        }
      }
    }
    for (const profile of await this.repository.listProfiles()) {
      if (profile.lockedByTaskId === undefined || profile.lockedByClaimId === undefined || profile.lockedByClaimGeneration === undefined) continue;
      const reservation = {
        taskId: profile.lockedByTaskId,
        claimId: profile.lockedByClaimId,
        claimGeneration: profile.lockedByClaimGeneration
      };
      const task = currentTasks.get(profile.lockedByTaskId);
      if (task?.profileId !== profile.id || !this.matchesActiveClaim(task, reservation)) {
        await this.repository.releaseProfileLease(profile.id, reservation);
      }
    }
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
    if (
      task.workerId !== workerId ||
      task.leaseToken === undefined ||
      task.claimId === undefined ||
      task.claimGeneration === undefined ||
      task.claimGeneration <= 0 ||
      !['claimed', 'running', 'needs_input', 'handoff', 'closing', 'cancelled'].includes(task.status)
    ) throw unauthorized('worker does not own active lease');
    const expected = Buffer.from(task.leaseToken);
    const actual = Buffer.from(leaseToken);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw unauthorized('invalid lease token');
    if (task.status === 'cancelled') throw taskCancelled();
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

  private async replaceClaimedTask(current: Task, updated: Task): Promise<void> {
    if (!await this.tryReplaceClaimedTask(current, updated)) throw unauthorized('lease generation is no longer active');
  }

  private async tryReplaceClaimedTask(current: Task, updated: Task): Promise<boolean> {
    return this.repository.replaceTaskForClaim(updated, this.claimGuard(current));
  }

  private claimGuard(task: Task): TaskClaimGuard {
    if (task.claimId === undefined || task.claimGeneration === undefined || task.claimGeneration <= 0) {
      throw unauthorized('lease generation is no longer active');
    }
    return { claimId: task.claimId, claimGeneration: task.claimGeneration, status: task.status };
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

  private async ensureClaimProjections(task: Task, now: number): Promise<boolean> {
    if (task.machineId === undefined) return false;
    const requested = this.reservation(task);
    const authoritative = await this.repository.getTask(task.id);
    if (authoritative === undefined || !this.matchesActiveClaim(authoritative, requested) || authoritative.machineId !== task.machineId) return false;
    const reservation = this.reservation(authoritative);
    if (!await this.repository.reserveMachineLease(task.machineId, reservation)) return false;
    await this.repository.renewMachineLease(task.machineId, reservation);
    if (task.profileId !== undefined) {
      try {
        await this.profiles.acquire(task.profileId, task.userId, task.machineId, reservation, now);
      } catch (error) {
        await this.repository.releaseMachineLease(task.machineId, reservation);
        if (error instanceof TalosError && error.code === 'conflict') return false;
        throw error;
      }
    }
    const committed = await this.repository.getTask(task.id);
    if (this.matchesActiveClaim(committed, reservation) && committed?.machineId === task.machineId) return true;
    await this.repository.releaseMachineLease(task.machineId, reservation);
    if (task.profileId !== undefined) await this.profiles.release(task.profileId, reservation);
    return false;
  }

  private async abortClaim(task: Task, queuePriority: number | undefined, now = this.clock()): Promise<void> {
    const requeued: Task = {
      ...task,
      status: 'submitted',
      updatedAt: new Date(now).toISOString(),
      leaseExpiresAt: undefined,
      leaseToken: undefined,
      workerId: undefined,
      machineId: undefined,
      queuePriority
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
    if (task.machineId !== undefined) await this.repository.releaseMachineLease(task.machineId, reservation);
    if (task.profileId !== undefined) await this.profiles.release(task.profileId, reservation);
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
      'queuePriority',
      'workerId',
      'machineId',
      'leaseExpiresAt',
      'input',
      'requesterGroups',
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
