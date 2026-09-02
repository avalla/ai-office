-- Existing repository identity mappings remain authoritative. Projects created
-- before that mapping existed receive one generated portable identity once.
INSERT INTO project_repository_identity(repository_id, project_id, created_at)
SELECT 'repo_' || lower(hex(randomblob(16))), id, created_at
FROM project
WHERE NOT EXISTS (
  SELECT 1
  FROM project_repository_identity identity
  WHERE identity.project_id = project.id
)
AND NOT EXISTS (
  SELECT 1
  FROM project_source source
  WHERE source.project_id = project.id
);

CREATE TABLE project_state_revision (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  parent_revision_id TEXT,
  state_checksum TEXT NOT NULL CHECK (
    length(state_checksum) = 64
    AND state_checksum NOT GLOB '*[^0-9a-f]*'
  ),
  origin TEXT NOT NULL CHECK (origin IN ('local_export', 'portable_import')),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, id)
);

CREATE INDEX project_state_revision_project_created_idx
ON project_state_revision(project_id, created_at, id);

CREATE TABLE project_state_head (
  project_id TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL,
  base_revision_id TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id, revision_id)
    REFERENCES project_state_revision(project_id, id)
);
