CREATE TABLE milestone (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'completed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE requirement (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  milestone_id TEXT REFERENCES milestone(id) ON DELETE SET NULL,
  requirement_key TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'implemented', 'verified', 'rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, requirement_key)
);

CREATE TABLE architecture_decision (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  context TEXT NOT NULL,
  decision TEXT NOT NULL,
  consequences TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'deprecated', 'superseded')),
  superseded_by_id TEXT REFERENCES architecture_decision(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE review (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('task', 'agent_run', 'requirement', 'adr', 'milestone')),
  subject_id TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'changes_requested')),
  summary TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE approval (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  review_id TEXT NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  actor TEXT NOT NULL,
  rationale TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(review_id)
);

CREATE INDEX governance_project_idx ON milestone(project_id, status, created_at);
CREATE INDEX requirement_project_idx ON requirement(project_id, status, requirement_key);
CREATE INDEX adr_project_idx ON architecture_decision(project_id, status, created_at);
CREATE INDEX review_project_idx ON review(project_id, status, created_at);
