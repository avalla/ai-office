CREATE TABLE pricing_version (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR')),
  input_per_million_micros INTEGER NOT NULL CHECK (input_per_million_micros >= 0),
  cached_input_per_million_micros INTEGER NOT NULL CHECK (cached_input_per_million_micros >= 0),
  output_per_million_micros INTEGER NOT NULL CHECK (output_per_million_micros >= 0),
  reasoning_per_million_micros INTEGER NOT NULL CHECK (reasoning_per_million_micros >= 0),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(provider, model, effective_from)
);

CREATE TABLE budget (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('project', 'milestone', 'task', 'agent', 'agent_run')),
  scope_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR')),
  limit_micros INTEGER NOT NULL CHECK (limit_micros >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, scope_type, scope_id, currency)
);

CREATE TABLE budget_reservation (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budget(id) ON DELETE CASCADE,
  agent_run_id TEXT REFERENCES agent_run(id) ON DELETE SET NULL,
  amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'released')),
  created_at TEXT NOT NULL,
  finalized_at TEXT
);

CREATE INDEX budget_reservation_budget_status_idx
ON budget_reservation(budget_id, status);

CREATE TABLE model_usage (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agent(id) ON DELETE SET NULL,
  agent_run_id TEXT REFERENCES agent_run(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  provider_request_id TEXT,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  reasoning_tokens INTEGER NOT NULL CHECK (reasoning_tokens >= 0),
  occurred_at TEXT NOT NULL
);

CREATE TABLE cost_event (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  usage_id TEXT NOT NULL UNIQUE REFERENCES model_usage(id),
  pricing_version_id TEXT NOT NULL REFERENCES pricing_version(id),
  reservation_id TEXT REFERENCES budget_reservation(id) ON DELETE SET NULL,
  estimated_micros INTEGER NOT NULL CHECK (estimated_micros >= 0),
  actual_micros INTEGER NOT NULL CHECK (actual_micros >= 0),
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR')),
  occurred_at TEXT NOT NULL
);

CREATE INDEX cost_event_project_occurred_at_idx
ON cost_event(project_id, occurred_at, id);
