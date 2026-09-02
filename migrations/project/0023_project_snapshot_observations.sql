-- A revision records an observed semantic state. Archive publication is a
-- separate filesystem outcome, so a local revision must not claim that an
-- export artifact was successfully published.
CREATE TABLE project_state_revision_observation (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  parent_revision_id TEXT,
  state_checksum TEXT NOT NULL CHECK (
    length(state_checksum) = 64
    AND state_checksum NOT GLOB '*[^0-9a-f]*'
  ),
  origin TEXT NOT NULL CHECK (origin IN ('local_snapshot', 'portable_import')),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, id)
);

INSERT INTO project_state_revision_observation(
  id, project_id, parent_revision_id, state_checksum, origin, created_at
)
SELECT
  id, project_id, parent_revision_id, state_checksum,
  CASE origin WHEN 'local_export' THEN 'local_snapshot' ELSE origin END,
  created_at
FROM project_state_revision;

CREATE TABLE project_state_head_observation (
  project_id TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL,
  base_revision_id TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id, revision_id)
    REFERENCES project_state_revision_observation(project_id, id)
);

INSERT INTO project_state_head_observation(
  project_id, revision_id, base_revision_id, updated_at
)
SELECT project_id, revision_id, base_revision_id, updated_at
FROM project_state_head;

DROP TABLE project_state_head;
DROP TABLE project_state_revision;
ALTER TABLE project_state_revision_observation RENAME TO project_state_revision;
ALTER TABLE project_state_head_observation RENAME TO project_state_head;

CREATE INDEX project_state_revision_project_created_idx
ON project_state_revision(project_id, created_at, id);
