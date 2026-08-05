CREATE TABLE project_source (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  local_path TEXT,
  remote_url TEXT,
  default_branch TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE project_scan (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  scan_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  source_revision TEXT,
  summary_json TEXT,
  error_json TEXT
);

CREATE TABLE project_profile_entry (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('detected', 'inferred', 'user')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_reference TEXT,
  confirmed_at TEXT,
  superseded_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX project_profile_project_category_idx
ON project_profile_entry(project_id, category, key);

CREATE TABLE project_question (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  scan_id TEXT REFERENCES project_scan(id) ON DELETE SET NULL,
  key TEXT NOT NULL,
  question TEXT NOT NULL,
  reason TEXT NOT NULL,
  answer_json TEXT,
  answered_at TEXT
);
