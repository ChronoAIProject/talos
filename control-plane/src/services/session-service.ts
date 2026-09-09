import { actionAlreadyCompleted, conflict, forbidden, modeForbidden, notFound, unauthorized } from '../domain/errors.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  ActionDispatchBinding,
  PendingSessionAction,
  SessionAction,
  SessionActionResult,
  Task,
  TaskMode,
  TaskStatus
} from '../domain/types.js';
import { workerActionResultPayloadSchema } from '../domain/schemas.js';
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
      const completedAt = new Date(this.clock()).toISOString();
      const cancelled = await this.repository.finalizeSessionAction({
        actionId: pending.id,
        taskId: id,
        result: { error: { code: 'session_closed', message: 'session closed before the action completed' } },
        completedAt
      }, ['pending']);
      if (cancelled) {
        await this.repository.markSessionActionCompleted(id, pending.id, completedAt);
        return this.toView(await this.sessionTask(id, userId));
      }
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
      schemaVersion: 'talos.internal-session-action/v1',
      id: newId('action'),
      taskId: task.id,
      action,
      state: 'pending',
      dispatchGeneration: 0,
      createdAt: new Date(this.clock()).toISOString()
    };
    if (!await this.repository.enqueueSessionAction(pending)) {
      throw conflict('session already has an action in flight');
    }
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
    const pending = await this.repository.getPendingSessionAction(taskId);
    if (
      pending === undefined || task.claimId === undefined || task.claimGeneration === undefined ||
      task.machineId === undefined
    ) return { closing: false };
    const action = await this.repository.takePendingSessionAction(taskId, {
      expectedDispatchGeneration: pending.dispatchGeneration,
      dispatchId: newId('dispatch'),
      workerId,
      machineId: task.machineId,
      leaseToken,
      leaseTokenDigest: digestLeaseToken(leaseToken),
      claimId: task.claimId,
      claimGeneration: task.claimGeneration
    });
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
    result: unknown,
    authenticatedMachineId?: string
  ): Promise<void> {
    if (
      authenticatedMachineId === undefined || Buffer.byteLength(leaseToken, 'utf8') > 4096 ||
      Buffer.byteLength(workerId, 'utf8') > 255 || Buffer.byteLength(authenticatedMachineId, 'utf8') > 255
    ) throw unauthorized('unauthorized');
    const task = await this.repository.getTask(taskId);
    const action = task?.sessionActions?.find((candidate) => candidate.id === actionId);
    if (task === undefined || task.interaction !== 'interactive' || action === undefined) throw unauthorized('unauthorized');
    const binding = action.state === 'completed' ? action.completion.dispatchBinding : action.dispatchBinding;
    if (!isValidDispatchBinding(binding) || !matchesDispatchCredential(binding, workerId, authenticatedMachineId, leaseToken)) {
      throw unauthorized('unauthorized');
    }
    if (action.state === 'completed') throw actionAlreadyCompleted();
    if (
      action.state !== 'dispatched' || action.dispatchClaimId === undefined ||
      action.dispatchClaimGeneration === undefined
    ) throw unauthorized('unauthorized');
    const validatedResult = workerActionResultPayloadSchema.parse(result);
    const completedAt = new Date(this.clock()).toISOString();
    const stored: SessionActionResult = { actionId, taskId, result: validatedResult, completedAt, dispatchBinding: binding };
    if (!await this.repository.finalizeSessionAction(stored, ['dispatched'], {
      binding, leaseToken, claimId: action.dispatchClaimId, claimGeneration: action.dispatchClaimGeneration
    })) {
      const latest = await this.repository.getTask(taskId);
      const completed = latest?.sessionActions?.find((candidate) => candidate.id === actionId);
      if (
        completed?.state === 'completed' &&
        isValidDispatchBinding(completed.completion.dispatchBinding) &&
        matchesDispatchCredential(completed.completion.dispatchBinding, workerId, authenticatedMachineId, leaseToken)
      ) throw actionAlreadyCompleted();
      throw unauthorized('unauthorized');
    }
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

const digestLeaseToken = (leaseToken: string): string =>
  `sha256:${createHash('sha256').update(Buffer.from(leaseToken, 'utf8')).digest('hex')}`;

const isValidDispatchBinding = (binding: ActionDispatchBinding | undefined): binding is ActionDispatchBinding =>
  binding?.schemaVersion === 'talos.internal-action-dispatch-binding/v1' &&
  binding.dispatchId.length > 0 && binding.dispatchId.length <= 255 &&
  Number.isSafeInteger(binding.dispatchGeneration) && binding.dispatchGeneration > 0 &&
  binding.workerId.length > 0 && binding.workerId.length <= 255 &&
  binding.machineId.length > 0 && binding.machineId.length <= 255 &&
  /^sha256:[0-9a-f]{64}$/.test(binding.leaseTokenDigest);

const matchesDispatchCredential = (
  binding: ActionDispatchBinding,
  workerId: string,
  machineId: string,
  leaseToken: string
): boolean => {
  if (binding.workerId !== workerId || binding.machineId !== machineId) return false;
  const expected = Buffer.from(binding.leaseTokenDigest.slice('sha256:'.length), 'hex');
  const actual = createHash('sha256').update(Buffer.from(leaseToken, 'utf8')).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
