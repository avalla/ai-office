CREATE TABLE audit_event (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES project(id),
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('daemon', 'cli', 'system')),
  actor_id TEXT,
  aggregate_type TEXT,
  aggregate_id TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL
);

CREATE INDEX audit_event_occurred_at_idx
ON audit_event(occurred_at, id);

CREATE INDEX audit_event_project_occurred_at_idx
ON audit_event(project_id, occurred_at, id);

CREATE TRIGGER audit_event_prevent_update
BEFORE UPDATE ON audit_event
BEGIN
  SELECT RAISE(ABORT, 'audit_event is append-only');
END;

CREATE TRIGGER audit_event_prevent_delete
BEFORE DELETE ON audit_event
BEGIN
  SELECT RAISE(ABORT, 'audit_event is append-only');
END;
