import { conflict, forbidden, modeForbidden, notFound } from '../domain/errors.js';
import type {
  PendingSessionAction,
  SessionAction,
  SessionActionResult,
  Task,
  TaskMode,
  TaskStatus
} from '../domain/types.js';
import type { Repository } from '../storage/repository.js';
import { newId } from '../util/id.js';
import type { TaskService } from './task-service.js';

export interface SessionView {
  id: string;
  status: TaskStatus;
  mode: TaskMode;
  createdAt: string;
  updatedAt: string;
  pendingActionId?: string;
  lastActionId?: string;
}

export interface ActionView {
  action_id: string;
  status: 'completed' | 'pending';
  result?: unknown;
}

export interface WorkerActionPoll {
  closing: boolean;
  action?: { id: string; action: SessionAction };
}

export interface SessionServiceOptions {
  clock?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
}

const mutatingActions = new Set<SessionAction['type']>([
  'click',
  'type',
  'key',
  'act-on-a11y-node'
]);

export class SessionService {
  private readonly clock: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly pollIntervalMs: number;

  public constructor(
    private readonly tasks: TaskService,
    private readonly repository: Repository,
    options: SessionServiceOptions = {}
  ) {
    this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 250);
  }

  public async create(
    userId: string,
    input: {
      pool_id?: string;
      profile_id?: string;
      mode: TaskMode;
      constraints: Task['constraints'];
    },
    requesterGroups: readonly string[] = []
  ): Promise<SessionView> {
    const task = await this.tasks.createTask(userId, {
      kind: 'browse',
      goal: 'interactive browser session',
      mode: input.mode,
      constraints: input.constraints,
      ...(input.pool_id === undefined ? {} : { pool_id: input.pool_id }),
      ...(input.profile_id === undefined ? {} : { profile_id: input.profile_id })
    }, requesterGroups, 'interactive');
    return this.toView(task);
  }

  public async get(id: string, userId: string): Promise<SessionView> {
    return this.toView(await this.sessionTask(id, userId));
  }

  public async close(id: string, userId: string): Promise<SessionView> {
    await this.sessionTask(id, userId);
    const pending = await this.repository.getPendingSessionAction(id);
    const closed = await this.tasks.closeInteractive(id, userId);
    if (pending?.state === 'pending') {
      await this.repository.saveSessionActionResult({
        actionId: pending.id,
        taskId: id,
        result: { error: { code: 'session_closed', message: 'session closed before the action completed' } },
        completedAt: new Date(this.clock()).toISOString()
      });
      await this.repository.completeSessionAction(id, pending.id);
      const updated = { ...closed, pendingActionId: undefined };
      await this.repository.saveTask(updated);
      return this.toView(updated);
    }
    return this.toView(closed);
  }

  public async sendAction(
    id: string,
    userId: string,
    action: SessionAction,
    waitSeconds: number
  ): Promise<ActionView> {
    const task = await this.sessionTask(id, userId);
    this.assertActionAllowed(task, action);
    if (!['claimed', 'running'].includes(task.status)) throw conflict('session is not ready for actions');
    const pending: PendingSessionAction = {
      id: newId('action'),
      taskId: task.id,
      action,
      state: 'pending',
      createdAt: new Date(this.clock()).toISOString()
    };
    if (!await this.repository.enqueueSessionAction(pending)) {
      throw conflict('session already has an action in flight');
    }
    await this.repository.saveTask({
      ...task,
      pendingActionId: pending.id,
      updatedAt: new Date(this.clock()).toISOString()
    });
    return this.waitForResult(pending.id, task.id, waitSeconds);
  }

  public async getAction(
    sessionId: string,
    actionId: string,
    userId: string,
    waitSeconds: number
  ): Promise<ActionView> {
    await this.sessionTask(sessionId, userId);
    const result = await this.repository.getSessionActionResult(actionId);
    if (result !== undefined && result.taskId !== sessionId) throw notFound('session action not found');
    const pending = await this.repository.getPendingSessionAction(sessionId);
    if (result === undefined && pending?.id !== actionId) throw notFound('session action not found');
    return this.waitForResult(actionId, sessionId, waitSeconds);
  }

  public async pollWorkerAction(
    taskId: string,
    workerId: string,
    leaseToken: string
  ): Promise<WorkerActionPoll> {
    const task = await this.tasks.getWorkerTask(taskId, workerId, leaseToken);
    if (task.interaction !== 'interactive') throw conflict('task is not an interactive session');
    if (task.status === 'closing') return { closing: true };
    const action = await this.repository.takePendingSessionAction(taskId);
    return {
      closing: false,
      ...(action === undefined ? {} : { action: { id: action.id, action: action.action } })
    };
  }

  public async saveWorkerResult(
    taskId: string,
    actionId: string,
    workerId: string,
    leaseToken: string,
    result: unknown
  ): Promise<void> {
    const task = await this.tasks.getWorkerTask(taskId, workerId, leaseToken);
    if (task.interaction !== 'interactive') throw conflict('task is not an interactive session');
    const pending = await this.repository.getPendingSessionAction(taskId);
    if (pending?.id !== actionId || pending.state !== 'dispatched') throw conflict('session action is not in flight');
    const completedAt = new Date(this.clock()).toISOString();
    const stored: SessionActionResult = { actionId, taskId, result, completedAt };
    await this.repository.saveSessionActionResult(stored);
    await this.repository.completeSessionAction(taskId, actionId);
    await this.repository.saveTask({
      ...task,
      pendingActionId: undefined,
      lastActionId: actionId,
      updatedAt: completedAt
    });
  }

  private async waitForResult(actionId: string, taskId: string, waitSeconds: number): Promise<ActionView> {
    const deadline = this.clock() + waitSeconds * 1000;
    while (true) {
      const result = await this.repository.getSessionActionResult(actionId);
      if (result !== undefined && result.taskId === taskId) {
        return { action_id: actionId, status: 'completed', result: result.result };
      }
      const remaining = deadline - this.clock();
      if (remaining <= 0) return { action_id: actionId, status: 'pending' };
      await this.sleep(Math.min(this.pollIntervalMs, remaining));
    }
  }

  private async sessionTask(id: string, userId: string): Promise<Task> {
    const task = await this.repository.getTask(id);
    if (task === undefined || task.interaction !== 'interactive') throw notFound('session not found');
    if (task.userId !== userId) throw forbidden('session belongs to another user');
    return task;
  }

  private assertActionAllowed(task: Task, action: SessionAction): void {
    if (task.mode === 'read_only' && mutatingActions.has(action.type)) {
      throw modeForbidden(`action ${action.type} is not allowed in read_only mode`);
    }
  }

  private toView(task: Task): SessionView {
    return {
      id: task.id,
      status: task.status,
      mode: task.mode,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ...(task.pendingActionId === undefined ? {} : { pendingActionId: task.pendingActionId }),
      ...(task.lastActionId === undefined ? {} : { lastActionId: task.lastActionId })
    };
  }
}
