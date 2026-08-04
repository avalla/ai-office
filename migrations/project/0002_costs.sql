CREATE TABLE model_pricing (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  currency TEXT NOT NULL,
  input_per_million_micros INTEGER NOT NULL,
  cached_input_per_million_micros INTEGER NOT NULL,
  output_per_million_micros INTEGER NOT NULL,
  reasoning_per_million_micros INTEGER NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  source TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE cost_event (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agent(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES agent_run(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  provider TEXT,
  service TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_micros INTEGER NOT NULL,
  actual_cost_micros INTEGER,
  currency TEXT NOT NULL,
  pricing_version_id TEXT REFERENCES model_pricing(id),
  occurred_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX cost_event_project_time_idx
ON cost_event(project_id, occurred_at);

CREATE INDEX cost_event_task_idx
ON cost_event(task_id);

CREATE TABLE budget (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  period TEXT NOT NULL,
  limit_micros INTEGER NOT NULL,
  warning_threshold_percent INTEGER NOT NULL DEFAULT 80,
  hard_limit INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE budget_reservation (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  reserved_micros INTEGER NOT NULL,
  consumed_micros INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
