import { Pool, type PoolConfig, type QueryResultRow } from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { HandoffLink, Machine, Pool as TalosPool, Profile, Task, TaskInput, WebhookEvent } from '../domain/types.js';
import type { Repository } from './repository.js';

type Row = QueryResultRow & Record<string, unknown>;
type PoolLike = Pick<Pool, 'query' | 'end'>;

const nullable = (value: unknown): string | undefined => value === null || value === undefined ? undefined : String(value);
const iso = (value: unknown): string => new Date(String(value)).toISOString();
const json = <T>(value: unknown, fallback: T): T => value === null || value === undefined ? fallback : value as T;
const encodeJson = (value: unknown): string => JSON.stringify(value);

export interface PostgresRepositoryOptions {
  pool?: PoolLike;
  poolConfig?: PoolConfig;
}

export class PostgresRepository implements Repository {
  private readonly pool: PoolLike;

  public constructor(options: PostgresRepositoryOptions = {}) {
    this.pool = options.pool ?? new Pool(options.poolConfig);
  }

  public async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  public async initialize(): Promise<void> {
    const schema = await readFile(fileURLToPath(new URL('../../../control-plane/sql/schema.sql', import.meta.url)), 'utf8');
    await this.pool.query(schema);
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  public async getTask(id: string): Promise<Task | undefined> {
    const result = await this.pool.query<Row>('SELECT * FROM tasks WHERE id = $1', [id]);
    return result.rows[0] === undefined ? undefined : taskFromRow(result.rows[0]);
  }

  public async saveTask(task: Task): Promise<void> {
    await this.pool.query(
      `INSERT INTO tasks (id, user_id, kind, goal, site_hint, profile_id, pool_id, constraints, mode, callback, status, queue_priority, created_at, updated_at, claimed_at, lease_expires_at, lease_token, worker_id, machine_id, findings, artifacts, input, error, handoff)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       ON CONFLICT (id) DO UPDATE SET user_id=EXCLUDED.user_id, kind=EXCLUDED.kind, goal=EXCLUDED.goal, site_hint=EXCLUDED.site_hint, profile_id=EXCLUDED.profile_id, pool_id=EXCLUDED.pool_id, constraints=EXCLUDED.constraints, mode=EXCLUDED.mode, callback=EXCLUDED.callback, status=EXCLUDED.status, queue_priority=EXCLUDED.queue_priority, created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at, claimed_at=EXCLUDED.claimed_at, lease_expires_at=EXCLUDED.lease_expires_at, lease_token=EXCLUDED.lease_token, worker_id=EXCLUDED.worker_id, machine_id=EXCLUDED.machine_id, findings=EXCLUDED.findings, artifacts=EXCLUDED.artifacts, input=EXCLUDED.input, error=EXCLUDED.error, handoff=EXCLUDED.handoff`,
      [task.id, task.userId, task.kind, task.goal, task.siteHint ?? null, task.profileId ?? null, task.poolId ?? null, encodeJson(task.constraints), task.mode, task.callback ?? null, task.status, task.queuePriority ?? null, task.createdAt, task.updatedAt, task.claimedAt ?? null, task.leaseExpiresAt ?? null, task.leaseToken ?? null, task.workerId ?? null, task.machineId ?? null, encodeJson(task.findings), encodeJson(task.artifacts), task.input === undefined ? null : encodeJson(task.input), task.error === undefined ? null : encodeJson(task.error), task.handoff === undefined ? null : encodeJson(task.handoff)]
    );
  }

  public async listQueuedTasks(): Promise<readonly Task[]> {
    const result = await this.pool.query<Row>("SELECT * FROM tasks WHERE status = 'submitted' ORDER BY COALESCE(queue_priority, 0) ASC, created_at ASC");
    return result.rows.map(taskFromRow);
  }

  public async listTasks(): Promise<readonly Task[]> {
    const result = await this.pool.query<Row>('SELECT * FROM tasks');
    return result.rows.map(taskFromRow);
  }

  public async getPool(id: string): Promise<TalosPool | undefined> {
    const result = await this.pool.query<Row>('SELECT * FROM pools WHERE id = $1', [id]);
    return result.rows[0] === undefined ? undefined : poolFromRow(result.rows[0]);
  }

  public async savePool(pool: TalosPool): Promise<void> {
    await this.pool.query(
      `INSERT INTO pools (id, visibility, owner_user_id, tags) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET visibility=EXCLUDED.visibility, owner_user_id=EXCLUDED.owner_user_id, tags=EXCLUDED.tags`,
      [pool.id, pool.visibility, pool.ownerUserId ?? null, encodeJson(pool.tags)]
    );
  }

  public async listPoolsByOwner(ownerUserId: string): Promise<readonly TalosPool[]> {
    const result = await this.pool.query<Row>('SELECT * FROM pools WHERE owner_user_id = $1', [ownerUserId]);
    return result.rows.map(poolFromRow);
  }

  public async listMachines(poolId?: string): Promise<readonly Machine[]> {
    const result = poolId === undefined
      ? await this.pool.query<Row>('SELECT * FROM machines')
      : await this.pool.query<Row>('SELECT * FROM machines WHERE pool_id = $1', [poolId]);
    return result.rows.map(machineFromRow);
  }

  public async getMachine(id: string): Promise<Machine | undefined> {
    const result = await this.pool.query<Row>('SELECT * FROM machines WHERE id = $1', [id]);
    return result.rows[0] === undefined ? undefined : machineFromRow(result.rows[0]);
  }

  public async saveMachine(machine: Machine): Promise<void> {
    await this.pool.query(
      `INSERT INTO machines (id, pool_id, tags, capacity, active_leases, online, worker_token_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET pool_id=EXCLUDED.pool_id, tags=EXCLUDED.tags, capacity=EXCLUDED.capacity, active_leases=EXCLUDED.active_leases, online=EXCLUDED.online, worker_token_hash=EXCLUDED.worker_token_hash`,
      [machine.id, machine.poolId, encodeJson(machine.tags), machine.capacity, machine.activeLeases, machine.online, machine.workerTokenHash]
    );
  }

  public async getProfile(id: string): Promise<Profile | undefined> {
    const result = await this.pool.query<Row>('SELECT * FROM profiles WHERE id = $1', [id]);
    return result.rows[0] === undefined ? undefined : profileFromRow(result.rows[0]);
  }

  public async saveProfile(profile: Profile): Promise<void> {
    await this.pool.query(
      `INSERT INTO profiles (id, user_id, machine_id, locked_by_task_id, lock_expires_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET user_id=EXCLUDED.user_id, machine_id=EXCLUDED.machine_id, locked_by_task_id=EXCLUDED.locked_by_task_id, lock_expires_at=EXCLUDED.lock_expires_at`,
      [profile.id, profile.userId, profile.machineId ?? null, profile.lockedByTaskId ?? null, profile.lockExpiresAt ?? null]
    );
  }

  public async listProfilesByUser(userId: string): Promise<readonly Profile[]> {
    const result = await this.pool.query<Row>('SELECT * FROM profiles WHERE user_id = $1', [userId]);
    return result.rows.map(profileFromRow);
  }

  public async saveHandoff(link: HandoffLink): Promise<void> {
    await this.pool.query(
      `INSERT INTO handoffs (id, task_id, user_id, url, expires_at, used) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET task_id=EXCLUDED.task_id, user_id=EXCLUDED.user_id, url=EXCLUDED.url, expires_at=EXCLUDED.expires_at, used=EXCLUDED.used`,
      [link.id, link.taskId, link.userId, link.url, link.expiresAt, link.used]
    );
  }

  public async getHandoff(id: string): Promise<HandoffLink | undefined> {
    const result = await this.pool.query<Row>('SELECT * FROM handoffs WHERE id = $1', [id]);
    const row = result.rows[0];
    return row === undefined ? undefined : { id: String(row.id), taskId: String(row.task_id), userId: String(row.user_id), url: String(row.url), expiresAt: iso(row.expires_at), used: Boolean(row.used) };
  }

  public async saveWebhook(event: WebhookEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO webhooks (id, type, task_id, user_id, timestamp, payload, delivery_status, delivery_attempts, last_attempt_at, last_error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET type=EXCLUDED.type, task_id=EXCLUDED.task_id, user_id=EXCLUDED.user_id, timestamp=EXCLUDED.timestamp, payload=EXCLUDED.payload, delivery_status=EXCLUDED.delivery_status, delivery_attempts=EXCLUDED.delivery_attempts, last_attempt_at=EXCLUDED.last_attempt_at, last_error=EXCLUDED.last_error`,
      [event.id, event.type, event.taskId, event.userId, event.timestamp, encodeJson(event.payload), event.delivery.status, event.delivery.attempts, event.delivery.lastAttemptAt ?? null, event.delivery.lastError ?? null]
    );
  }

  public async getWebhook(id: string): Promise<WebhookEvent | undefined> {
    const result = await this.pool.query<Row>('SELECT * FROM webhooks WHERE id = $1', [id]);
    const row = result.rows[0];
    return row === undefined ? undefined : webhookFromRow(row);
  }

  public async listWebhooks(): Promise<readonly WebhookEvent[]> {
    const result = await this.pool.query<Row>('SELECT * FROM webhooks');
    return result.rows.map(webhookFromRow);
  }

  public async savePendingInput(taskId: string, input: TaskInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO pending_inputs (task_id, input) VALUES ($1,$2)
       ON CONFLICT (task_id) DO UPDATE SET input=EXCLUDED.input`,
      [taskId, encodeJson(input)]
    );
  }

  public async takePendingInput(taskId: string): Promise<TaskInput | undefined> {
    const result = await this.pool.query<Row>('DELETE FROM pending_inputs WHERE task_id = $1 RETURNING input', [taskId]);
    return result.rows[0] === undefined ? undefined : result.rows[0].input as TaskInput;
  }
}

const taskFromRow = (row: Row): Task => ({
  id: String(row.id),
  userId: String(row.user_id),
  kind: row.kind as Task['kind'],
  goal: String(row.goal),
  ...(nullable(row.site_hint) === undefined ? {} : { siteHint: String(row.site_hint) }),
  ...(nullable(row.profile_id) === undefined ? {} : { profileId: String(row.profile_id) }),
  ...(nullable(row.pool_id) === undefined ? {} : { poolId: String(row.pool_id) }),
  constraints: json(row.constraints, {}),
  mode: row.mode as Task['mode'],
  ...(nullable(row.callback) === undefined ? {} : { callback: String(row.callback) }),
  status: row.status as Task['status'],
  ...(row.queue_priority === null || row.queue_priority === undefined ? {} : { queuePriority: Number(row.queue_priority) }),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  ...(nullable(row.claimed_at) === undefined ? {} : { claimedAt: iso(row.claimed_at) }),
  ...(nullable(row.lease_expires_at) === undefined ? {} : { leaseExpiresAt: iso(row.lease_expires_at) }),
  ...(nullable(row.lease_token) === undefined ? {} : { leaseToken: String(row.lease_token) }),
  ...(nullable(row.worker_id) === undefined ? {} : { workerId: String(row.worker_id) }),
  ...(nullable(row.machine_id) === undefined ? {} : { machineId: String(row.machine_id) }),
  findings: json(row.findings, []),
  artifacts: json(row.artifacts, []),
  ...(row.input === null || row.input === undefined ? {} : { input: row.input as TaskInput }),
  ...(row.error === null || row.error === undefined ? {} : { error: row.error as Task['error'] }),
  ...(row.handoff === null || row.handoff === undefined ? {} : { handoff: row.handoff as Task['handoff'] })
});

const poolFromRow = (row: Row): TalosPool => ({ id: String(row.id), visibility: row.visibility as TalosPool['visibility'], ...(nullable(row.owner_user_id) === undefined ? {} : { ownerUserId: String(row.owner_user_id) }), tags: json(row.tags, {}) });
const machineFromRow = (row: Row): Machine => ({ id: String(row.id), poolId: String(row.pool_id), tags: json(row.tags, {}), capacity: Number(row.capacity), activeLeases: Number(row.active_leases), online: Boolean(row.online), workerTokenHash: String(row.worker_token_hash) });
const profileFromRow = (row: Row): Profile => ({ id: String(row.id), userId: String(row.user_id), ...(nullable(row.machine_id) === undefined ? {} : { machineId: String(row.machine_id) }), ...(nullable(row.locked_by_task_id) === undefined ? {} : { lockedByTaskId: String(row.locked_by_task_id) }), ...(nullable(row.lock_expires_at) === undefined ? {} : { lockExpiresAt: iso(row.lock_expires_at) }) });
const webhookFromRow = (row: Row): WebhookEvent => ({ id: String(row.id), type: row.type as WebhookEvent['type'], taskId: String(row.task_id), userId: String(row.user_id), timestamp: iso(row.timestamp), payload: json(row.payload, {}), delivery: { status: row.delivery_status as WebhookEvent['delivery']['status'], attempts: Number(row.delivery_attempts), ...(nullable(row.last_attempt_at) === undefined ? {} : { lastAttemptAt: iso(row.last_attempt_at) }), ...(nullable(row.last_error) === undefined ? {} : { lastError: String(row.last_error) }) } });
