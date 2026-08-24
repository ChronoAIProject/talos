import type { HandoffLink, Machine, PendingSessionAction, Pool, Profile, SessionActionResult, Task, TaskInput, WebhookEvent } from '../domain/types.js';
import type { TestingRunRecord } from '../domain/testing-types.js';

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
  enqueueSessionAction(action: PendingSessionAction): Promise<boolean>;
  getPendingSessionAction(taskId: string): Promise<PendingSessionAction | undefined>;
  takePendingSessionAction(taskId: string): Promise<PendingSessionAction | undefined>;
  requeueSessionAction(taskId: string): Promise<void>;
  cancelPendingSessionAction(taskId: string, actionId: string): Promise<boolean>;
  completeSessionAction(taskId: string, actionId: string): Promise<void>;
  saveSessionActionResult(result: SessionActionResult): Promise<void>;
  getSessionActionResult(actionId: string): Promise<SessionActionResult | undefined>;
  createTestingRun(run: TestingRunRecord): Promise<boolean>;
  getTestingRun(id: string): Promise<TestingRunRecord | undefined>;
  getTestingRunByIdempotencyKey(userId: string, idempotencyKey: string): Promise<TestingRunRecord | undefined>;
  replaceTestingRun(run: TestingRunRecord, expectedRecordVersion: number): Promise<boolean>;
}
