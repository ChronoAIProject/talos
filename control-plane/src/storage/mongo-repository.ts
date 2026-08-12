import { MongoClient, type Collection, type Db, type MongoClientOptions } from 'mongodb';
import type { HandoffLink, Machine, Pool, Profile, Task, TaskInput, WebhookEvent } from '../domain/types.js';
import type { Repository } from './repository.js';

type Document = { _id: string; [key: string]: unknown };

export interface MongoRepositoryOptions {
  client?: MongoClient;
  clientOptions?: MongoClientOptions;
}

export class MongoRepository implements Repository {
  private readonly client: MongoClient;
  private readonly database: Db;
  private readonly tasks: Collection<Document>;
  private readonly pools: Collection<Document>;
  private readonly machines: Collection<Document>;
  private readonly profiles: Collection<Document>;
  private readonly handoffs: Collection<Document>;
  private readonly webhooks: Collection<Document>;
  private readonly pendingInputs: Collection<Document>;

  public constructor(url: string, databaseName = 'talos', options: MongoRepositoryOptions = {}) {
    this.client = options.client ?? new MongoClient(url, { ...options.clientOptions, ignoreUndefined: true });
    this.database = this.client.db(databaseName);
    this.tasks = this.database.collection('tasks');
    this.pools = this.database.collection('pools');
    this.machines = this.database.collection('machines');
    this.profiles = this.database.collection('profiles');
    this.handoffs = this.database.collection('handoffs');
    this.webhooks = this.database.collection('webhooks');
    this.pendingInputs = this.database.collection('pending_inputs');
  }

  public async initialize(): Promise<void> {
    await this.client.connect();
    await Promise.all([
      this.tasks.createIndex({ status: 1, queuePriority: 1, createdAt: 1 }),
      this.pools.createIndex({ ownerUserId: 1 }),
      this.profiles.createIndex({ userId: 1 }),
      this.machines.createIndex({ poolId: 1 })
    ]);
  }

  public async ping(): Promise<void> {
    await this.database.command({ ping: 1 });
  }

  public async close(): Promise<void> {
    await this.client.close();
  }

  public async getTask(id: string): Promise<Task | undefined> {
    const document = await this.tasks.findOne({ _id: id });
    return document === null ? undefined : taskFromDocument(document);
  }

  public async saveTask(task: Task): Promise<void> {
    await this.tasks.replaceOne({ _id: task.id }, { ...task, _id: task.id, queuePriority: task.queuePriority ?? 0 }, { upsert: true });
  }

  public async listQueuedTasks(): Promise<readonly Task[]> {
    const documents = await this.tasks.find({ status: 'submitted' }).sort({ queuePriority: 1, createdAt: 1 }).toArray();
    return documents.map(taskFromDocument);
  }

  public async listTasks(): Promise<readonly Task[]> {
    return (await this.tasks.find({}).toArray()).map(taskFromDocument);
  }

  public async getPool(id: string): Promise<Pool | undefined> {
    const document = await this.pools.findOne({ _id: id });
    return document === null ? undefined : poolFromDocument(document);
  }

  public async savePool(pool: Pool): Promise<void> {
    await this.pools.replaceOne({ _id: pool.id }, { ...pool, _id: pool.id }, { upsert: true });
  }

  public async listPoolsByOwner(ownerUserId: string): Promise<readonly Pool[]> {
    return (await this.pools.find({ ownerUserId }).toArray()).map(poolFromDocument);
  }

  public async listMachines(poolId?: string): Promise<readonly Machine[]> {
    return (await this.machines.find(poolId === undefined ? {} : { poolId }).toArray()).map(machineFromDocument);
  }

  public async getMachine(id: string): Promise<Machine | undefined> {
    const document = await this.machines.findOne({ _id: id });
    return document === null ? undefined : machineFromDocument(document);
  }

  public async saveMachine(machine: Machine): Promise<void> {
    await this.machines.replaceOne({ _id: machine.id }, { ...machine, _id: machine.id }, { upsert: true });
  }

  public async getProfile(id: string): Promise<Profile | undefined> {
    const document = await this.profiles.findOne({ _id: id });
    return document === null ? undefined : profileFromDocument(document);
  }

  public async saveProfile(profile: Profile): Promise<void> {
    await this.profiles.replaceOne({ _id: profile.id }, { ...profile, _id: profile.id }, { upsert: true });
  }

  public async listProfilesByUser(userId: string): Promise<readonly Profile[]> {
    return (await this.profiles.find({ userId }).toArray()).map(profileFromDocument);
  }

  public async saveHandoff(link: HandoffLink): Promise<void> {
    await this.handoffs.replaceOne({ _id: link.id }, { ...link, _id: link.id }, { upsert: true });
  }

  public async getHandoff(id: string): Promise<HandoffLink | undefined> {
    const document = await this.handoffs.findOne({ _id: id });
    return document === null ? undefined : handoffFromDocument(document);
  }

  public async saveWebhook(event: WebhookEvent): Promise<void> {
    await this.webhooks.replaceOne({ _id: event.id }, { ...event, _id: event.id }, { upsert: true });
  }

  public async getWebhook(id: string): Promise<WebhookEvent | undefined> {
    const document = await this.webhooks.findOne({ _id: id });
    return document === null ? undefined : webhookFromDocument(document);
  }

  public async listWebhooks(): Promise<readonly WebhookEvent[]> {
    return (await this.webhooks.find({}).toArray()).map(webhookFromDocument);
  }

  public async savePendingInput(taskId: string, input: TaskInput): Promise<void> {
    await this.pendingInputs.replaceOne({ _id: taskId }, { _id: taskId, input }, { upsert: true });
  }

  public async takePendingInput(taskId: string): Promise<TaskInput | undefined> {
    const result = await this.pendingInputs.findOneAndDelete({ _id: taskId });
    const document = result ?? null;
    return document === null ? undefined : document.input as TaskInput;
  }
}

const withoutId = (document: Document): Record<string, unknown> => {
  return Object.fromEntries(Object.entries(document).filter(([key, value]) => key !== '_id' && value !== null));
};

const taskFromDocument = (document: Document): Task => withoutId(document) as unknown as Task;
const poolFromDocument = (document: Document): Pool => withoutId(document) as unknown as Pool;
const machineFromDocument = (document: Document): Machine => withoutId(document) as unknown as Machine;
const profileFromDocument = (document: Document): Profile => withoutId(document) as unknown as Profile;
const handoffFromDocument = (document: Document): HandoffLink => withoutId(document) as unknown as HandoffLink;
const webhookFromDocument = (document: Document): WebhookEvent => withoutId(document) as unknown as WebhookEvent;
