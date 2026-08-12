import { z } from 'zod';
import { actionSchema, type Action } from '../protocol/actions.js';

export interface TaskEnvelope { id: string; kind: 'browse' | 'computer_use'; goal: string; }
export interface WorkerClient {
  claim(): Promise<{ task: TaskEnvelope; leaseToken: string }>;
  heartbeat(taskId: string, leaseToken: string): Promise<void>;
  result(taskId: string, leaseToken: string, status: 'completed' | 'failed', findings: readonly unknown[], error?: { code: string; message: string }): Promise<void>;
  artifact(taskId: string, leaseToken: string, artifact: { name: string; contentType: string; size: number; uri: string }): Promise<void>;
  input(taskId: string, input: unknown): Promise<void>;
}

export const workerConfigSchema = z.object({
  controlPlaneUrl: z.string().url(),
  workerId: z.string().min(1),
  machineId: z.string().min(1),
  workerToken: z.string().min(16)
});

export interface RuntimeOptions { client: WorkerClient; executor: { execute(action: Action, context: { taskId: string; masking: boolean }): Promise<unknown>; close(): Promise<void> }; heartbeatMs?: number; }

export class WorkerRuntime {
  public constructor(private readonly options: RuntimeOptions) {}

  public async runOnce(actions: readonly unknown[] = []): Promise<void> {
    const lease = await this.options.client.claim();
    const parsedActions = actions.map((action) => actionSchema.parse(action));
    const interval = setInterval(() => { void this.options.client.heartbeat(lease.task.id, lease.leaseToken); }, this.options.heartbeatMs ?? 20000);
    try {
      for (const action of parsedActions) await this.options.executor.execute(action, { taskId: lease.task.id, masking: false });
      await this.options.client.result(lease.task.id, lease.leaseToken, 'completed', []);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'executor failed';
      await this.options.client.result(lease.task.id, lease.leaseToken, 'failed', [], { code: 'executor_failed', message });
    } finally {
      clearInterval(interval);
      await this.options.executor.close();
    }
  }

  public async executeHandoff(taskId: string, action: Action): Promise<void> {
    await this.options.executor.execute(action, { taskId, masking: true });
  }
}
