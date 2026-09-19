CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE core.project (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  description text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE core.task (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES core.project(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(trim(title)) > 0),
  description text,
  status text NOT NULL CHECK (
    status IN (
      'pending', 'assigned', 'running', 'blocked', 'waiting_review',
      'completed', 'failed', 'cancelled'
    )
  ),
  priority integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (id, project_id)
);

CREATE INDEX task_project_priority_created_id_idx
ON core.task(project_id, priority DESC, created_at ASC, id ASC);

CREATE TABLE core.requirement (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES core.project(id) ON DELETE CASCADE,
  requirement_key text NOT NULL,
  title text NOT NULL CHECK (length(trim(title)) > 0),
  status text NOT NULL CHECK (
    status IN ('proposed', 'accepted', 'implemented', 'verified', 'rejected')
  ),
  UNIQUE (id, project_id),
  UNIQUE (project_id, requirement_key)
);

CREATE INDEX requirement_project_key_id_idx
ON core.requirement(project_id, requirement_key, id);

CREATE TABLE core.task_requirement (
  project_id text NOT NULL REFERENCES core.project(id) ON DELETE CASCADE,
  task_id text NOT NULL,
  requirement_id text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (task_id, requirement_id),
  FOREIGN KEY (task_id, project_id)
    REFERENCES core.task(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (requirement_id, project_id)
    REFERENCES core.requirement(id, project_id) ON DELETE CASCADE
);

CREATE INDEX task_requirement_project_task_requirement_idx
ON core.task_requirement(project_id, task_id, requirement_id);
