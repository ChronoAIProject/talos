import type { HandoffLink, Machine, Pool, Profile, Task, TaskInput, WebhookEvent } from '../domain/types.js';

export interface Repository {
  ping(): Promise<void>;
  close(): Promise<void>;
  getTask(id: string): Promise<Task | undefined>;
  saveTask(task: Task): Promise<void>;
  listQueuedTasks(): Promise<readonly Task[]>;
  listTasks(): Promise<readonly Task[]>;
  getPool(id: string): Promise<Pool | undefined>;
  savePool(pool: Pool): Promise<void>;
  listPoolsByOwner(ownerUserId: string): Promise<readonly Pool[]>;
  listMachines(poolId?: string): Promise<readonly Machine[]>;
  getMachine(id: string): Promise<Machine | undefined>;
  saveMachine(machine: Machine): Promise<void>;
  getProfile(id: string): Promise<Profile | undefined>;
  saveProfile(profile: Profile): Promise<void>;
  listProfilesByUser(userId: string): Promise<readonly Profile[]>;
  saveHandoff(link: HandoffLink): Promise<void>;
  getHandoff(id: string): Promise<HandoffLink | undefined>;
  saveWebhook(event: WebhookEvent): Promise<void>;
  getWebhook(id: string): Promise<WebhookEvent | undefined>;
  listWebhooks(): Promise<readonly WebhookEvent[]>;
  savePendingInput(taskId: string, input: TaskInput): Promise<void>;
  takePendingInput(taskId: string): Promise<TaskInput | undefined>;
}
