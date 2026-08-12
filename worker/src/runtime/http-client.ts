import { z } from 'zod';
import { workerConfigSchema, type TaskEnvelope, type WorkerClient } from './client.js';

const taskSchema = z.object({ id: z.string(), kind: z.enum(['browse', 'computer_use']), goal: z.string() });
const claimSchema = z.object({ task: taskSchema, lease: z.object({ taskId: z.string(), workerId: z.string(), machineId: z.string(), expiresAt: z.string() }), leaseToken: z.string().min(1) });
const inputResponseSchema = z.object({ input: z.unknown().optional() });
const errorResponseSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export class HttpWorkerClient implements WorkerClient {
  private readonly config: ReturnType<typeof workerConfigSchema.parse>;

  public constructor(config: unknown) {
    this.config = workerConfigSchema.parse(config);
  }

  public async claim(): Promise<{ task: TaskEnvelope; leaseToken: string }> {
    return claimSchema.parse(await this.request('/v1/worker/claim', { worker_id: this.config.workerId, machine_id: this.config.machineId }));
  }

  public async heartbeat(taskId: string, leaseToken: string): Promise<void> {
    await this.request(`/v1/worker/tasks/${encodeURIComponent(taskId)}/heartbeat`, { lease_token: leaseToken, extend_seconds: 60 });
  }

  public async needsInput(taskId: string, leaseToken: string): Promise<void> {
    await this.request(`/v1/worker/tasks/${encodeURIComponent(taskId)}/needs-input`, { lease_token: leaseToken });
  }

  public async getInput(taskId: string, leaseToken: string): Promise<unknown> {
    const response = inputResponseSchema.parse(await this.request(`/v1/worker/tasks/${encodeURIComponent(taskId)}/input`, undefined, 'GET', { 'X-Talos-Lease-Token': leaseToken }));
    return response.input;
  }

  public async result(taskId: string, leaseToken: string, status: 'completed' | 'failed', findings: readonly unknown[], error?: { code: string; message: string }): Promise<void> {
    await this.request(`/v1/worker/tasks/${encodeURIComponent(taskId)}/result`, { lease_token: leaseToken, status, findings, ...(error === undefined ? {} : { error }) });
  }

  public async artifact(taskId: string, leaseToken: string, artifact: { name: string; contentType: string; size: number; uri: string }): Promise<void> {
    await this.request(`/v1/worker/tasks/${encodeURIComponent(taskId)}/artifacts`, { lease_token: leaseToken, name: artifact.name, content_type: artifact.contentType, size: artifact.size, uri: artifact.uri });
  }

  private async request(path: string, payload?: unknown, method = 'POST', extraHeaders: Record<string, string> = {}): Promise<unknown> {
    const response = await fetch(new URL(path, this.config.controlPlaneUrl), {
      method,
      headers: { authorization: `Bearer ${this.config.workerToken}`, 'x-talos-worker-id': this.config.workerId, 'x-talos-machine-id': this.config.machineId, 'content-type': 'application/json', ...extraHeaders },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
    });
    const text = await response.text();
    let json: unknown = {};
    try { json = text.length === 0 ? {} : JSON.parse(text) as unknown; } catch { json = {}; }
    if (!response.ok) {
      const error = errorResponseSchema.safeParse(json);
      throw new Error(error.success ? `${error.data.error.code}: ${error.data.error.message}` : `control plane request failed (${response.status})`);
    }
    return json;
  }
}
