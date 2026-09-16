CREATE TABLE job_outbox (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL CHECK (job_type IN ('orchestrate_pipeline', 'execute_agent_run')),
  aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('pipeline_run', 'agent_run')),
  aggregate_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json) AND json_type(payload_json) = 'object'
    AND length(payload_json) <= 4096
  ),
  available_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  dispatched_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, dedupe_key)
);

CREATE INDEX job_outbox_pending_idx
ON job_outbox(dispatched_at, available_at, created_at, id);

CREATE TRIGGER job_outbox_immutable_intent
BEFORE UPDATE OF id, project_id, job_type, aggregate_type, aggregate_id,
  dedupe_key, payload_json, created_at ON job_outbox
BEGIN SELECT RAISE(ABORT, 'job outbox intent is immutable'); END;

CREATE TRIGGER job_outbox_dispatched_once
BEFORE UPDATE OF dispatched_at ON job_outbox
WHEN OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS NOT OLD.dispatched_at
BEGIN SELECT RAISE(ABORT, 'job outbox dispatch is immutable'); END;
