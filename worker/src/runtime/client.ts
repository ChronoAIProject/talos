import { z } from 'zod';
import type { Action } from '../protocol/actions.js';
import type { HandoffPolicy } from './policy.js';

export interface TaskEnvelope { id: string; kind: 'browse' | 'computer_use'; goal: string; }
export interface WorkerClient {
  claim(): Promise<{ task: TaskEnvelope; leaseToken: string }>;
  heartbeat(taskId: string, leaseToken: string): Promise<void>;
  result(taskId: string, leaseToken: string, status: 'completed' | 'failed', findings: readonly unknown[], error?: { code: string; message: string }): Promise<void>;
  artifact(taskId: string, leaseToken: string, artifact: { name: string; contentType: string; size: number; uri: string }): Promise<void>;
  needsInput(taskId: string, leaseToken: string): Promise<void>;
  getInput(taskId: string, leaseToken: string): Promise<unknown>;
}

export const workerConfigSchema = z.object({
  controlPlaneUrl: z.string().url(),
  workerId: z.string().min(1),
  machineId: z.string().min(1),
  workerToken: z.string().min(16),
  profilePath: z.string().min(1).default('./talos-profile'),
  cdpEndpoint: z.string().url().optional(),
  heartbeatMs: z.coerce.number().int().positive().default(20000),
  pollMs: z.coerce.number().int().positive().default(1000)
});

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
}

export class WorkerRuntime {
  public constructor(private readonly options: RuntimeOptions) {}

  public async runOnce(): Promise<void> {
    const lease = await this.options.client.claim();
    const policy = this.options.policy ?? (await import('./policy.js')).createHandoffPolicy();
    let lastResult: unknown = undefined;
    const interval = setInterval(() => {
      void this.options.client.heartbeat(lease.task.id, lease.leaseToken).catch((error: unknown) => {
        this.options.logger?.warn('lease heartbeat failed', { taskId: lease.task.id, error: error instanceof Error ? error.message : 'unknown' });
      });
    }, this.options.heartbeatMs ?? 20000);
    try {
      while (true) {
        const decision = await this.options.planner.plan(lease.task, lastResult);
        if (decision.type === 'done') {
          await this.options.client.result(lease.task.id, lease.leaseToken, 'completed', decision.findings);
          break;
        }
        if (decision.type === 'needs_input') {
          await this.options.client.needsInput(lease.task.id, lease.leaseToken);
          let input: unknown;
          while (input === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            input = await this.options.client.getInput(lease.task.id, lease.leaseToken);
          }
          lastResult = input;
          continue;
        }
        lastResult = await this.options.executor.execute(decision.action, { taskId: lease.task.id, masking: policy.isMasked });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'executor failed';
      if (error instanceof Error && 'code' in error && error.code === 'task_cancelled') {
        this.options.logger?.warn('task cancelled', { taskId: lease.task.id });
      } else {
        await this.options.client.result(lease.task.id, lease.leaseToken, 'failed', [], { code: 'executor_failed', message });
      }
    } finally {
      clearInterval(interval);
      await this.options.executor.close();
    }
  }

  public async executeHandoff(taskId: string, action: Action): Promise<void> {
    const policy = this.options.policy ?? (await import('./policy.js')).createHandoffPolicy();
    const masked = policy.startHandoff();
    await this.options.executor.execute(action, { taskId, masking: masked.isMasked });
  }
}
