CREATE TABLE project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'pending',
      'assigned',
      'running',
      'blocked',
      'waiting_review',
      'completed',
      'failed',
      'cancelled'
    )
  ),
  priority INTEGER NOT NULL DEFAULT 0 CHECK (typeof(priority) = 'integer'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX task_project_status_priority_idx
ON task(project_id, status, priority DESC);
