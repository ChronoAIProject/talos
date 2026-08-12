import type { HandoffLink, Machine, Pool, Profile, Task, WebhookEvent } from '../domain/types.js';

export interface Repository {
  getTask(id: string): Promise<Task | undefined>;
  saveTask(task: Task): Promise<void>;
  listQueuedTasks(): Promise<readonly Task[]>;
  listTasks(): Promise<readonly Task[]>;
  getPool(id: string): Promise<Pool | undefined>;
  savePool(pool: Pool): Promise<void>;
  listMachines(poolId?: string): Promise<readonly Machine[]>;
  getMachine(id: string): Promise<Machine | undefined>;
  saveMachine(machine: Machine): Promise<void>;
  getProfile(id: string): Promise<Profile | undefined>;
  saveProfile(profile: Profile): Promise<void>;
  saveHandoff(link: HandoffLink): Promise<void>;
  getHandoff(id: string): Promise<HandoffLink | undefined>;
  saveWebhook(event: WebhookEvent): Promise<void>;
}
