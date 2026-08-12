import type { HandoffLink, Machine, Pool, Profile, Task, TaskInput, WebhookEvent } from '../domain/types.js';
import type { Repository } from './repository.js';

export class MemoryRepository implements Repository {
  private readonly tasks = new Map<string, Task>();
  private readonly pools = new Map<string, Pool>();
  private readonly machines = new Map<string, Machine>();
  private readonly profiles = new Map<string, Profile>();
  private readonly handoffs = new Map<string, HandoffLink>();
  private readonly webhooks = new Map<string, WebhookEvent>();
  private readonly pendingInputs = new Map<string, TaskInput>();

  public async getTask(id: string): Promise<Task | undefined> {
    return this.tasks.get(id);
  }

  public async saveTask(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
  }

  public async listQueuedTasks(): Promise<readonly Task[]> {
    return [...this.tasks.values()]
      .filter((task) => task.status === 'submitted')
      .sort(
        (a, b) =>
          (a.queuePriority ?? 0) - (b.queuePriority ?? 0) ||
          a.createdAt.localeCompare(b.createdAt)
      );
  }
  public async listTasks(): Promise<readonly Task[]> {
    return [...this.tasks.values()];
  }

  public async getPool(id: string): Promise<Pool | undefined> {
    return this.pools.get(id);
  }

  public async savePool(pool: Pool): Promise<void> {
    this.pools.set(pool.id, pool);
  }

  public async listMachines(poolId?: string): Promise<readonly Machine[]> {
    return [...this.machines.values()].filter(
      (machine) => poolId === undefined || machine.poolId === poolId
    );
  }
  public async getMachine(id: string): Promise<Machine | undefined> {
    return this.machines.get(id);
  }

  public async saveMachine(machine: Machine): Promise<void> {
    this.machines.set(machine.id, machine);
  }

  public async getProfile(id: string): Promise<Profile | undefined> {
    return this.profiles.get(id);
  }

  public async saveProfile(profile: Profile): Promise<void> {
    this.profiles.set(profile.id, profile);
  }

  public async saveHandoff(link: HandoffLink): Promise<void> {
    this.handoffs.set(link.id, link);
  }

  public async getHandoff(id: string): Promise<HandoffLink | undefined> {
    return this.handoffs.get(id);
  }

  public async saveWebhook(event: WebhookEvent): Promise<void> {
    this.webhooks.set(event.id, event);
  }

  public async getWebhook(id: string): Promise<WebhookEvent | undefined> {
    return this.webhooks.get(id);
  }

  public async listWebhooks(): Promise<readonly WebhookEvent[]> {
    return [...this.webhooks.values()];
  }

  public async savePendingInput(taskId: string, input: TaskInput): Promise<void> {
    this.pendingInputs.set(taskId, input);
  }

  public async takePendingInput(taskId: string): Promise<TaskInput | undefined> {
    const input = this.pendingInputs.get(taskId);
    this.pendingInputs.delete(taskId);
    return input;
  }
}
