CREATE TABLE role (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  role_key TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  tools_json TEXT NOT NULL CHECK (json_valid(tools_json)),
  model_policy TEXT NOT NULL,
  limits_json TEXT NOT NULL CHECK (json_valid(limits_json)),
  source_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, role_key)
);

CREATE TABLE agent (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES role(id),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE agent_run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES task(id),
  agent_id TEXT NOT NULL REFERENCES agent(id),
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'preparing', 'running', 'reviewing', 'completed', 'failed', 'cancelled'
  )),
  worktree_path TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX agent_run_project_status_idx
ON agent_run(project_id, status, created_at, id);

CREATE TABLE task_lock (
  task_id TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE REFERENCES agent_run(id) ON DELETE CASCADE,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE agent_run_event (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL
);

CREATE INDEX agent_run_event_run_idx ON agent_run_event(run_id, occurred_at, id);

CREATE TRIGGER agent_run_event_prevent_update BEFORE UPDATE ON agent_run_event
BEGIN SELECT RAISE(ABORT, 'agent_run_event is append-only'); END;

CREATE TRIGGER agent_run_event_prevent_delete BEFORE DELETE ON agent_run_event
BEGIN SELECT RAISE(ABORT, 'agent_run_event is append-only'); END;
