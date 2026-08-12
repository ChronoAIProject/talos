CREATE TABLE IF NOT EXISTS pools (
  id TEXT PRIMARY KEY,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'org', 'platform')),
  owner_user_id TEXT,
  tags JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES pools(id),
  tags JSONB NOT NULL DEFAULT '{}'::jsonb,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  active_leases INTEGER NOT NULL DEFAULT 0 CHECK (active_leases >= 0),
  online BOOLEAN NOT NULL DEFAULT TRUE,
  worker_token_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  machine_id TEXT REFERENCES machines(id),
  locked_by_task_id TEXT,
  lock_expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  goal TEXT NOT NULL,
  site_hint TEXT,
  profile_id TEXT REFERENCES profiles(id),
  pool_id TEXT REFERENCES pools(id),
  constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
  mode TEXT NOT NULL,
  callback TEXT,
  status TEXT NOT NULL,
  queue_priority INTEGER,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  lease_token TEXT,
  worker_id TEXT,
  machine_id TEXT REFERENCES machines(id),
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  artifacts JSONB NOT NULL DEFAULT '[]'::jsonb,
  input JSONB,
  error JSONB,
  handoff JSONB
);

CREATE INDEX IF NOT EXISTS tasks_queue_idx ON tasks(status, queue_priority, created_at);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  user_id TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  delivery_status TEXT NOT NULL,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS pending_inputs (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  input JSONB NOT NULL
);
