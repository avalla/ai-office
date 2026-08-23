CREATE TABLE project_memory_reference (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type = 'pattern'),
  target_id TEXT NOT NULL,
  target_version INTEGER NOT NULL CHECK (target_version >= 1),
  reference_type TEXT NOT NULL CHECK (reference_type = 'adopted'),
  query TEXT,
  usage_count INTEGER NOT NULL DEFAULT 1 CHECK (usage_count >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (
    project_id,
    target_type,
    target_id,
    target_version,
    reference_type
  )
);

CREATE INDEX project_memory_reference_project_idx
ON project_memory_reference(project_id, updated_at DESC, id);
