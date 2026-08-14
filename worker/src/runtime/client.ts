import { z } from 'zod';
import type { Action } from '../protocol/actions.js';
import { createHandoffPolicy, type HandoffPolicy } from './policy.js';
import { WorkerClientError } from './errors.js';

export interface TaskEnvelope {
  id: string;
  kind: 'browse' | 'computer_use';
  goal: string;
  interaction: 'autonomous' | 'interactive';
  profileId?: string;
}

export interface InteractiveActionPoll {
  closing: boolean;
  action?: { id: string; action: Action };
}

export interface WorkerClient {
  claim(): Promise<{ task: TaskEnvelope; leaseToken: string }>;
  heartbeat(taskId: string, leaseToken: string): Promise<TaskHeartbeat>;
  result(taskId: string, leaseToken: string, status: 'completed' | 'failed', findings: readonly unknown[], error?: { code: string; message: string }): Promise<void>;
  artifact(taskId: string, leaseToken: string, artifact: { name: string; contentType: string; size: number; uri: string }): Promise<void>;
  needsInput(taskId: string, leaseToken: string): Promise<void>;
  getInput(taskId: string, leaseToken: string): Promise<unknown>;
  pollAction(taskId: string, leaseToken: string): Promise<InteractiveActionPoll>;
  actionResult(taskId: string, actionId: string, leaseToken: string, result: unknown): Promise<void>;
}

export type TaskHeartbeat = { status: 'submitted' | 'claimed' | 'running' | 'needs_input' | 'handoff' | 'closing' | 'completed' | 'failed' | 'cancelled' };

export const workerConfigSchema = z.object({
  controlPlaneUrl: z.string().url(),
  workerId: z.string().min(1),
  machineId: z.string().min(1),
  workerToken: z.string().min(16),
  profilePath: z.string().min(1).default('./talos-profile'),
  cdpEndpoint: z.string().url().optional(),
  heartbeatMs: z.coerce.number().int().positive().default(20000),
  pollMs: z.coerce.number().int().positive().default(1000),
  inputPollMs: z.coerce.number().int().positive().default(1000),
  actionPollMs: z.coerce.number().int().positive().default(2000),
  sessionIdleMs: z.coerce.number().int().positive().default(600000)
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export type PlannerDecision =
  | { type: 'action'; action: Action }
  | { type: 'needs_input'; kind: 'choice' | 'text' | 'otp' }
  | { type: 'done'; findings: readonly unknown[] };

export interface ActionPlanner {
  plan(task: TaskEnvelope, lastResult: unknown): Promise<PlannerDecision>;
}

export interface RuntimeLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface RuntimeOptions {
  client: WorkerClient;
  executor: { execute(action: Action, context: { taskId: string; masking: boolean }): Promise<unknown>; close(): Promise<void> };
  planner: ActionPlanner;
  policy?: HandoffPolicy;
  heartbeatMs?: number;
  logger?: RuntimeLogger;
  inputPollMs?: number;
  actionPollMs?: number;
  sessionIdleMs?: number;
  clock?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class WorkerRuntime {
  private policy: HandoffPolicy;

  public constructor(private readonly options: RuntimeOptions) {
    this.policy = options.policy ?? createHandoffPolicy();
  }

  public async runOnce(): Promise<void> {
    const lease = await this.options.client.claim();
    let lastResult: unknown = undefined;
    let cancellationError: unknown;
    let taskStatus = 'claimed';
    let heartbeatInFlight: Promise<void> | undefined;
    const heartbeat = (): void => {
      if (heartbeatInFlight !== undefined) return;
      heartbeatInFlight = this.options.client.heartbeat(lease.task.id, lease.leaseToken)
        .then((heartbeat) => {
          if (heartbeat.status === 'handoff' && taskStatus !== 'handoff') this.policy = this.policy.startHandoff();
          if (heartbeat.status !== 'handoff' && taskStatus === 'handoff') this.policy = this.policy.endHandoff();
          taskStatus = heartbeat.status;
        })
        .catch((error: unknown) => {
          this.options.logger?.warn('lease heartbeat failed', { taskId: lease.task.id, error: error instanceof Error ? error.message : 'unknown' });
          if (error instanceof WorkerClientError && error.code === 'task_cancelled') cancellationError = error;
        })
        .finally(() => {
          heartbeatInFlight = undefined;
        });
    };
    const interval = setInterval(heartbeat, this.options.heartbeatMs ?? 20000);
    try {
      if (lease.task.interaction === 'interactive') {
        await this.runInteractive(lease.task, lease.leaseToken, () => taskStatus, () => cancellationError);
        return;
      }
      while (true) {
        if (cancellationError !== undefined) throw cancellationError;
        if (this.policy.isMasked) {
          await new Promise((resolve) => setTimeout(resolve, this.options.inputPollMs ?? 1000));
          continue;
        }
        const decision = await this.options.planner.plan(lease.task, lastResult);
        if (decision.type === 'done') {
          await this.options.client.result(lease.task.id, lease.leaseToken, 'completed', decision.findings);
          break;
        }
        if (decision.type === 'needs_input') {
          await this.options.client.needsInput(lease.task.id, lease.leaseToken);
          let input: unknown;
          while (input === undefined) {
            if (cancellationError !== undefined) throw cancellationError;
            await new Promise((resolve) => setTimeout(resolve, this.options.inputPollMs ?? 1000));
            input = await this.options.client.getInput(lease.task.id, lease.leaseToken);
          }
          lastResult = input;
          continue;
        }
        if (this.policy.isMasked) {
          await new Promise((resolve) => setTimeout(resolve, this.options.inputPollMs ?? 1000));
          continue;
        }
        lastResult = await this.options.executor.execute(decision.action, { taskId: lease.task.id, masking: this.policy.isMasked });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'executor failed';
      if (error instanceof WorkerClientError && error.code === 'task_cancelled') {
        this.options.logger?.warn('task cancelled', { taskId: lease.task.id });
      } else {
        await this.options.client.result(lease.task.id, lease.leaseToken, 'failed', [], { code: 'executor_failed', message });
      }
    } finally {
      clearInterval(interval);
      await heartbeatInFlight;
      await this.options.executor.close();
    }
  }

  private async runInteractive(
    task: TaskEnvelope,
    leaseToken: string,
    status: () => string,
    heartbeatError: () => unknown
  ): Promise<void> {
    const clock = this.options.clock ?? Date.now;
    const sleep = this.options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const basePollMs = this.options.actionPollMs ?? 2000;
    const idleMs = this.options.sessionIdleMs ?? 600000;
    let pollIntervalMs = basePollMs;
    let lastActivityAt = clock();
    const requestWithRetry = async <T>(
      operation: 'poll_action' | 'submit_action_result',
      request: () => Promise<T>
    ): Promise<T | undefined> => {
      let retryInMs = basePollMs;
      while (true) {
        try {
          return await request();
        } catch (error) {
          if (isCompletedActionConflict(error, operation)) return undefined;
          if (!isTransientWorkerRequestError(error)) throw error;
          if (error instanceof WorkerClientError && error.status === 429) {
            pollIntervalMs = Math.min(Math.ceil(pollIntervalMs * 1.5), 10000);
          }
          this.options.logger?.warn('interactive control plane request failed; retrying', {
            taskId: task.id,
            operation,
            error: error instanceof Error ? error.message : 'unknown',
            ...(error instanceof WorkerClientError
              ? { code: error.code, status: error.status }
              : {}),
            retryInMs,
            pollIntervalMs
          });
          await sleep(retryInMs);
          retryInMs = Math.min(retryInMs * 2, 30000);
        }
      }
    };
    while (true) {
      const error = heartbeatError();
      if (error !== undefined) throw error;
      if (status() === 'closing') {
        await this.options.client.result(task.id, leaseToken, 'completed', []);
        return;
      }
      if (this.policy.isMasked) {
        await sleep(pollIntervalMs);
        continue;
      }
      const polled = await requestWithRetry(
        'poll_action',
        () => this.options.client.pollAction(task.id, leaseToken)
      );
      if (polled === undefined) continue;
      if (polled.closing) {
        await this.options.client.result(task.id, leaseToken, 'completed', []);
        return;
      }
      if (polled.action === undefined) {
        if (clock() - lastActivityAt >= idleMs) {
          await this.options.client.result(task.id, leaseToken, 'failed', [], {
            code: 'session_idle_timeout',
            message: 'interactive session exceeded its idle timeout'
          });
          return;
        }
        await sleep(pollIntervalMs);
        continue;
      }
      const pendingAction = polled.action;
      let result: unknown;
      try {
        result = await this.options.executor.execute(pendingAction.action, {
          taskId: task.id,
          masking: this.policy.isMasked
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'executor failed';
        await requestWithRetry(
          'submit_action_result',
          () => this.options.client.actionResult(task.id, pendingAction.id, leaseToken, {
            error: { code: 'executor_failed', message }
          })
        );
        await this.options.client.result(task.id, leaseToken, 'failed', [], {
          code: 'executor_failed',
          message
        });
        return;
      }
      await requestWithRetry(
        'submit_action_result',
        () => this.options.client.actionResult(task.id, pendingAction.id, leaseToken, result)
      );
      lastActivityAt = clock();
    }
  }

}

const isTransientWorkerRequestError = (error: unknown): boolean => {
  if (error instanceof WorkerClientError) {
    return error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError;
};

const isCompletedActionConflict = (
  error: unknown,
  operation: 'poll_action' | 'submit_action_result'
): boolean => operation === 'submit_action_result'
  && error instanceof WorkerClientError
  && error.status === 409
  && error.code === 'action_already_completed';
