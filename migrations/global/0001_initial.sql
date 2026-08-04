CREATE TABLE global_role (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE pattern (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  problem TEXT NOT NULL,
  context TEXT NOT NULL,
  solution TEXT NOT NULL,
  applicability_json TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  risks_json TEXT NOT NULL,
  status TEXT NOT NULL,
  source_project_id TEXT,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(id, version)
);

CREATE TABLE lesson (
  id TEXT PRIMARY KEY,
  source_project_id TEXT,
  source_task_id TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
