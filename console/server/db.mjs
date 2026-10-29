import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const schema = [
`CREATE TABLE IF NOT EXISTS orgs(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES orgs(id),name TEXT NOT NULL,email TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'member',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(org_id,email))`,
`ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ`,
`CREATE TABLE IF NOT EXISTS bootstrap_locks(id INTEGER PRIMARY KEY CHECK(id=1))`,
`INSERT INTO bootstrap_locks(id) VALUES(1) ON CONFLICT(id) DO NOTHING`,
`CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,token_hash TEXT NOT NULL UNIQUE,csrf_token TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
`CREATE TABLE IF NOT EXISTS teams(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES orgs(id),name TEXT NOT NULL,owner_id TEXT NOT NULL REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(org_id,name))`,
`CREATE TABLE IF NOT EXISTS team_members(team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(team_id,user_id))`,
`CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES orgs(id),owner_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,repo_url TEXT NOT NULL,base_branch TEXT NOT NULL,visibility TEXT NOT NULL,team_id TEXT,member_ids JSONB NOT NULL DEFAULT '[]',created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
`ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_enabled BOOLEAN NOT NULL DEFAULT false`,
`ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_limits JSONB NOT NULL DEFAULT '{}'`,
`ALTER TABLE projects ADD COLUMN IF NOT EXISTS repo_type TEXT NOT NULL DEFAULT 'remote'`,
`ALTER TABLE projects ADD COLUMN IF NOT EXISTS local_path TEXT`,
`ALTER TABLE projects ADD COLUMN IF NOT EXISTS local_node_id TEXT`,
`CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES orgs(id),owner_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,visibility TEXT NOT NULL,team_id TEXT,member_ids JSONB NOT NULL DEFAULT '[]',project_ids JSONB NOT NULL DEFAULT '[]',token_hash TEXT NOT NULL UNIQUE,capabilities JSONB NOT NULL DEFAULT '{"tools":[]}',online_at TIMESTAMPTZ,revoked_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
`ALTER TABLE nodes ADD COLUMN IF NOT EXISTS local_device_hash TEXT`,
`CREATE TABLE IF NOT EXISTS local_pairings(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,device_hash TEXT NOT NULL,code_hash TEXT NOT NULL UNIQUE,expires_at TIMESTAMPTZ NOT NULL,consumed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
`CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES orgs(id),owner_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,node_id TEXT NOT NULL REFERENCES nodes(id),tool TEXT NOT NULL,visibility TEXT NOT NULL,team_id TEXT,member_ids JSONB NOT NULL DEFAULT '[]',project_ids JSONB NOT NULL DEFAULT '[]',model TEXT NOT NULL,mode TEXT NOT NULL,allowed_models JSONB NOT NULL,allow_override BOOLEAN NOT NULL,max_concurrency INTEGER NOT NULL,allow_auto_failover BOOLEAN NOT NULL DEFAULT false,revoked_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
`CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES orgs(id),owner_id TEXT NOT NULL REFERENCES users(id),project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,description TEXT NOT NULL,status TEXT NOT NULL,connection_id TEXT NOT NULL REFERENCES connections(id),tool TEXT NOT NULL,model TEXT NOT NULL,mode TEXT NOT NULL,native_model TEXT NOT NULL,plan JSONB,allow_push BOOLEAN NOT NULL DEFAULT false,allow_pr BOOLEAN NOT NULL DEFAULT false,auto_failover BOOLEAN NOT NULL DEFAULT false,result JSONB,current_attempt_id TEXT,handoff_target_id TEXT,handoff_checkpoint JSONB,shared_team_id TEXT,shared_member_ids JSONB NOT NULL DEFAULT '[]',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS budget_block_reason TEXT`,
`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS auto_failover BOOLEAN NOT NULL DEFAULT false`,
`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS result JSONB`,
`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS stop_intent TEXT`,
`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS handoff_transfer_id TEXT`,
`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS handoff_model TEXT`,
`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS handoff_mode TEXT`,
`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS handoff_native_model TEXT`,
`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS retry_generation INTEGER NOT NULL DEFAULT 0`,
`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS review_generation INTEGER NOT NULL DEFAULT 0`,
`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS review_feedback TEXT`,
`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE`,
`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS workflow_key TEXT`,
`ALTER TABLE nodes ADD COLUMN IF NOT EXISTS checkpoint_public_key TEXT`,
`CREATE TABLE IF NOT EXISTS task_dependencies(parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,child_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,dependency_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,PRIMARY KEY(child_task_id,dependency_task_id),CHECK(child_task_id<>dependency_task_id))`,
`CREATE INDEX IF NOT EXISTS task_parent_idx ON tasks(parent_task_id,created_at)`,
`CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES orgs(id),task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,connection_id TEXT NOT NULL REFERENCES connections(id),node_id TEXT NOT NULL REFERENCES nodes(id),kind TEXT NOT NULL,status TEXT NOT NULL,lease_hash TEXT NOT NULL,model TEXT NOT NULL,mode TEXT NOT NULL,native_model TEXT NOT NULL,started_at TIMESTAMPTZ NOT NULL DEFAULT now(),ended_at TIMESTAMPTZ)`,
`ALTER TABLE attempts ADD COLUMN IF NOT EXISTS retry_generation INTEGER NOT NULL DEFAULT 0`,
`CREATE TABLE IF NOT EXISTS task_checkpoints(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES orgs(id),task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,source_attempt_id TEXT NOT NULL REFERENCES attempts(id),target_node_id TEXT NOT NULL REFERENCES nodes(id),transfer_id TEXT NOT NULL UNIQUE,digest TEXT NOT NULL,envelope JSONB NOT NULL,consumed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
`CREATE TABLE IF NOT EXISTS task_events(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES orgs(id),task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,attempt_id TEXT,type TEXT NOT NULL,message TEXT NOT NULL,data JSONB,actor_id TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
`CREATE TABLE IF NOT EXISTS usage_events(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES orgs(id),project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,event_id TEXT NOT NULL,input_tokens BIGINT NOT NULL,output_tokens BIGINT NOT NULL,cached_input_tokens BIGINT NOT NULL DEFAULT 0,cost_micros BIGINT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(attempt_id,event_id))`,
`CREATE INDEX IF NOT EXISTS usage_project_day_idx ON usage_events(project_id,created_at)`,
`CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES orgs(id),actor_id TEXT NOT NULL REFERENCES users(id),action TEXT NOT NULL,object_type TEXT NOT NULL,object_id TEXT NOT NULL,details JSONB NOT NULL DEFAULT '{}',created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
`CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(org_id,status,created_at)`,
`CREATE INDEX IF NOT EXISTS attempts_task_idx ON attempts(task_id,status)`,
`CREATE INDEX IF NOT EXISTS audit_org_idx ON audit(org_id,created_at DESC)`
];

export async function createDatabase({ connectionString, dataDir = '.data' } = {}) {
  let raw, embedded;
  if (connectionString) {
    const { Pool } = await import('pg');
    raw = new Pool({ connectionString, max: 12, idleTimeoutMillis: 30_000 });
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const path = dataDir === ':memory:' ? undefined : join(dataDir, 'postgres');
    if (path) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    raw = new PGlite(path);
    embedded = true;
    await raw.waitReady;
  }
  const query = async (sql, params = [], client = raw) => {
    if (embedded) {
      if (client === raw && /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i.test(sql)) {
        return serialized(() => raw.transaction(tx => query(sql, params, tx)));
      }
      const result = await client.query(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    }
    return client.query(sql, params);
  };
  let writeQueue = Promise.resolve();
  const serialized = async fn => {
    const previous = writeQueue;
    let release;
    writeQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  };
  const transaction = async fn => {
    if (embedded) {
      return serialized(() => raw.transaction(async tx => fn({ query: (sql, params) => query(sql, params, tx) })));
    }
    const client = await raw.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({ query: (sql, params) => query(sql, params, client) });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  };
  for (const sql of schema) await query(sql);
  return { query, transaction, close: () => raw.close ? raw.close() : raw.end(), embedded };
}
