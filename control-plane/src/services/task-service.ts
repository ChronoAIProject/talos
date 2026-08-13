import { conflict, deadlineExceeded, forbidden, notFound, taskCancelled, unauthorized, TalosError } from '../domain/errors.js';
import { timingSafeEqual } from 'node:crypto';
import { taskCreateSchema } from '../domain/schemas.js';
import type { Lease, PublicTask, Task, TaskFinding, WebhookEvent } from '../domain/types.js';
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

  public async createTask(userId: string, input: unknown, requesterGroups: readonly string[] = []): Promise<Task> {
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
      interaction: 'autonomous',
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
    const queued = await this.repository.listQueuedTasks();
    for (const candidate of queued) {
      try {
        const eligible = await this.scheduler.isEligible(candidate, machineId, candidate.userId, candidate.requesterGroups ?? []);
        if (eligible === undefined) continue;
        const { machine } = eligible;
        if (candidate.profileId !== undefined) {
          const profile = await this.profiles.assertOwner(candidate.profileId, candidate.userId);
          if (profile.machineId !== undefined && profile.machineId !== machine.id) continue;
          await this.profiles.acquire(candidate.profileId, candidate.userId, candidate.id, now, machine.id, this.leaseSeconds);
        }
        const expiresAt = new Date(now + this.leaseSeconds * 1000).toISOString();
        const leaseToken = newId('lease');
        const task: Task = {
          ...candidate,
          status: 'claimed',
          updatedAt: new Date(now).toISOString(),
          claimedAt: new Date(now).toISOString(),
          leaseExpiresAt: expiresAt,
          leaseToken,
          queuePriority: undefined,
          workerId,
          machineId
        };
        await this.repository.saveTask(task);
        await this.repository.saveMachine({ ...machine, activeLeases: machine.activeLeases + 1 });
        await this.emit(task, 'task.state_changed', { status: task.status });
        return { task, lease: { taskId: task.id, workerId, machineId, expiresAt }, leaseToken };
      } catch (error) {
        if (error instanceof TalosError && error.code === 'conflict') continue;
        throw error;
      }
    }
    throw notFound('no queued task available for worker');
  }

  public async heartbeat(taskId: string, workerId: string, leaseToken: string, extendSeconds: number): Promise<Task> {
    const task = await this.workerTask(taskId, workerId, leaseToken);
    const now = this.clock();
    const nextStatus = task.status === 'claimed' ? 'running' : task.status;
    const updated: Task = {
      ...task,
      status: nextStatus,
      updatedAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now + extendSeconds * 1000).toISOString()
    };
    if (task.profileId !== undefined) await this.profiles.renew(task.profileId, task.id, now, extendSeconds);
    await this.repository.saveTask(updated);
    if (task.status !== updated.status) await this.emit(updated, 'task.state_changed', { status: updated.status });
    return updated;
  }

  public async complete(taskId: string, workerId: string, leaseToken: string, status: 'completed' | 'failed', findings: readonly TaskFinding[], error?: { code: string; message: string }): Promise<Task> {
    const task = await this.workerTask(taskId, workerId, leaseToken);
    const updated: Task = {
      ...task,
      status,
      updatedAt: new Date(this.clock()).toISOString(),
      findings: [...findings],
      ...(error === undefined ? {} : { error })
    };
    await this.repository.saveTask(updated);
    await this.releaseLease(updated);
    await this.emit(updated, 'task.state_changed', { status });
    if (status === 'completed') await this.emit(updated, 'task.completed', { status });
    return updated;
  }

  public async addArtifact(taskId: string, workerId: string, leaseToken: string, artifact: Task['artifacts'][number]): Promise<Task> {
    const task = await this.workerTask(taskId, workerId, leaseToken);
    const updated: Task = {
      ...task,
      updatedAt: new Date(this.clock()).toISOString(),
      artifacts: [...task.artifacts, artifact]
    };
    await this.repository.saveTask(updated);
    return updated;
  }

  public async provideInput(id: string, userId: string, input: NonNullable<Task['input']>): Promise<Task> {
    const task = await this.authorizedTask(id, userId);
    if (task.status !== 'needs_input') throw conflict('task is not waiting for input');
    const now = this.clock();
    await this.repository.savePendingInput(id, input);
    const updated: Task = {
      ...task,
      status: 'running',
      updatedAt: new Date(now).toISOString(),
      leaseExpiresAt: task.workerId === undefined ? task.leaseExpiresAt : new Date(now + this.leaseSeconds * 1000).toISOString()
    };
    if (task.workerId !== undefined && task.profileId !== undefined) await this.profiles.renew(task.profileId, task.id, now, this.leaseSeconds);
    await this.repository.saveTask(updated);
    await this.emit(updated, 'task.state_changed', { status: updated.status });
    return updated;
  }

  public async needsInput(taskId: string, workerId: string, leaseToken: string): Promise<Task> {
    const task = await this.workerTask(taskId, workerId, leaseToken);
    const updated: Task = {
      ...task,
      status: 'needs_input',
      updatedAt: new Date(this.clock()).toISOString()
    };
    await this.repository.saveTask(updated);
    await this.emit(updated, 'task.needs_input', { status: updated.status });
    return updated;
  }

  public async getWorkerInput(taskId: string, workerId: string, leaseToken: string): Promise<Task['input']> {
    await this.workerTask(taskId, workerId, leaseToken);
    return this.repository.takePendingInput(taskId);
  }

  public async requestHandoff(id: string, userId: string, expiresInSeconds: number): Promise<{ handoff_url: string; expires: string }> {
    const task = await this.authorizedTask(id, userId);
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
    await this.repository.saveTask(updated);
    await this.emit(updated, 'task.handoff_requested', { handoff_url: url, expires });
    return { handoff_url: url, expires };
  }

  public async cancel(id: string, userId: string): Promise<Task> {
    const task = await this.authorizedTask(id, userId);
    if (['completed', 'failed', 'cancelled'].includes(task.status)) throw conflict('task is already terminal');
    const updated: Task = {
      ...task,
      status: 'cancelled',
      updatedAt: new Date(this.clock()).toISOString()
    };
    await this.repository.saveTask(updated);
    await this.releaseLease(updated);
    await this.emit(updated, 'task.state_changed', { status: updated.status });
    return updated;
  }

  public async expireLeases(now = this.clock()): Promise<readonly Task[]> {
    const active = await this.repository.listTasks();
    const expired: Task[] = [];
    for (const candidate of active) {
      const current = await this.repository.getTask(candidate.id);
      if (current?.status === 'submitted' && current.constraints.deadline !== undefined && Date.parse(current.constraints.deadline) <= now) {
        const failed: Task = {
          ...current,
          status: 'failed',
          updatedAt: new Date(now).toISOString(),
          error: { code: 'deadline_exceeded', message: deadlineExceeded().message }
        };
        await this.repository.saveTask(failed);
        await this.emit(failed, 'task.state_changed', { status: failed.status, error: failed.error });
        continue;
      }
      if (current?.leaseExpiresAt !== undefined && Date.parse(current.leaseExpiresAt) <= now && ['claimed', 'running'].includes(current.status)) {
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
        await this.repository.saveTask(requeued);
        await this.releaseLease(current);
        expired.push(requeued);
      }
    }
    return expired;
  }

  private async authorizedTask(id: string, userId: string): Promise<Task> {
    const task = await this.repository.getTask(id);
    if (task === undefined) throw notFound('task not found');
    if (task.userId !== userId) throw forbidden('task belongs to another user');
    return task;
  }

  private async workerTask(taskId: string, workerId: string, leaseToken: string): Promise<Task> {
    const task = await this.repository.getTask(taskId);
    if (task === undefined) throw notFound('task not found');
    if (task.workerId !== workerId || task.leaseToken === undefined || !['claimed', 'running', 'needs_input', 'handoff', 'cancelled'].includes(task.status)) throw unauthorized('worker does not own active lease');
    const expected = Buffer.from(task.leaseToken);
    const actual = Buffer.from(leaseToken);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw unauthorized('invalid lease token');
    if (task.status === 'cancelled') throw taskCancelled();
    if (task.leaseExpiresAt !== undefined && Date.parse(task.leaseExpiresAt) <= this.clock() && !['needs_input', 'handoff'].includes(task.status)) throw unauthorized('lease expired');
    return task;
  }

  private async releaseLease(task: Task): Promise<void> {
    if (task.machineId !== undefined) {
      const machine = await this.repository.getMachine(task.machineId);
      if (machine !== undefined) await this.repository.saveMachine({ ...machine, activeLeases: Math.max(0, machine.activeLeases - 1) });
    }
    if (task.profileId !== undefined) await this.profiles.release(task.profileId, task.id);
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
      'queuePriority',
      'workerId',
      'machineId',
      'leaseExpiresAt',
      'input',
      'requesterGroups'
    ]);
    return {
      interaction: task.interaction ?? 'autonomous',
      ...Object.fromEntries(
      Object.entries(task).filter(([key]) => !hidden.has(key))
      )
    } as unknown as PublicTask;
  }
}
