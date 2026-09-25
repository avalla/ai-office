CREATE TABLE governance_event_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'milestone.created', 'milestone.status_changed', 'milestone.title_changed',
    'requirement.created', 'requirement.status_changed',
    'adr.created', 'adr.status_changed',
    'review.created', 'review.decided'
  )),
  aggregate_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  occurred_at TEXT NOT NULL
);

INSERT INTO governance_event_new(
  id, project_id, event_type, aggregate_id, metadata_json, occurred_at
)
SELECT id, project_id, event_type, aggregate_id, metadata_json, occurred_at
FROM governance_event;

DROP TABLE governance_event;
ALTER TABLE governance_event_new RENAME TO governance_event;

CREATE INDEX governance_event_project_idx
ON governance_event(project_id, occurred_at, id);

CREATE TRIGGER governance_event_prevent_update
BEFORE UPDATE ON governance_event
BEGIN SELECT RAISE(ABORT, 'governance_event is append-only'); END;

CREATE TRIGGER governance_event_prevent_delete
BEFORE DELETE ON governance_event
BEGIN SELECT RAISE(ABORT, 'governance_event is append-only'); END;
