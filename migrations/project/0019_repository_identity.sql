CREATE TABLE project_repository_identity (
  repository_id TEXT PRIMARY KEY CHECK (length(trim(repository_id)) > 0),
  project_id TEXT NOT NULL UNIQUE REFERENCES project(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

-- A detached checkout must not be rediscovered through the pre-project_source
-- compatibility fallbacks in SqliteProjectProfileRepository. The portable
-- repository identity and the project itself deliberately survive detachment.
CREATE TABLE project_checkout_detachment (
  local_path TEXT PRIMARY KEY CHECK (length(trim(local_path)) > 0),
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  detached_at TEXT NOT NULL
);
