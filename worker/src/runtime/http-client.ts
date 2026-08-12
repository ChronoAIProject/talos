import { workerConfigSchema, type TaskEnvelope, type WorkerClient } from './client.js';

export class HttpWorkerClient implements WorkerClient {
  private readonly config: ReturnType<typeof workerConfigSchema.parse>;
  public constructor(config: unknown) { this.config = workerConfigSchema.parse(config); }

  public async claim(): Promise<{ task: TaskEnvelope; leaseToken: string }> {
    const response = await this.request('/v1/worker/claim', { worker_id: this.config.workerId, machine_id: this.config.machineId });
    return response as { task: TaskEnvelope; leaseToken: string };
  }
  public async heartbeat(taskId: string, leaseToken: string): Promise<void> { await this.request(`/v1/worker/tasks/${encodeURIComponent(taskId)}/heartbeat`, { lease_token: leaseToken, extend_seconds: 60 }); }
  public async result(taskId: string, leaseToken: string, status: 'completed' | 'failed', findings: readonly unknown[], error?: { code: string; message: string }): Promise<void> { await this.request(`/v1/worker/tasks/${encodeURIComponent(taskId)}/result`, { lease_token: leaseToken, status, findings, ...(error === undefined ? {} : { error }) }); }
  public async artifact(taskId: string, leaseToken: string, artifact: { name: string; contentType: string; size: number; uri: string }): Promise<void> { await this.request(`/v1/worker/tasks/${encodeURIComponent(taskId)}/artifacts`, { lease_token: leaseToken, name: artifact.name, content_type: artifact.contentType, size: artifact.size, uri: artifact.uri }); }
  public async input(taskId: string, input: unknown): Promise<void> { await this.request(`/v1/worker/tasks/${encodeURIComponent(taskId)}/input`, input); }

  private async request(path: string, payload: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.config.controlPlaneUrl), { method: 'POST', headers: { authorization: `Bearer ${this.config.workerToken}`, 'x-talos-worker-id': this.config.workerId, 'x-talos-machine-id': this.config.machineId, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const json = await response.json() as unknown;
    if (!response.ok) throw new Error(`control plane request failed (${response.status})`);
    return json;
  }
}
