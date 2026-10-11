-- M19-T4 task-delivery setup: a project stores its skill setup as key-value
-- JSON rows. Project scope holds the defaults, run and task scopes hold
-- overrides; the application service merges project -> run -> task and
-- validates the key vocabulary, so the table stays forward-compatible without
-- one column per key. Delete is an upsert of JSON null at the command layer,
-- so value_json stays NOT NULL.
--
-- The identity is a unique index rather than a PRIMARY KEY, and it compares
-- IFNULL(scope_ref, ''): project scope keeps scope_ref NULL, and SQLite treats
-- NULLs as distinct in both PRIMARY KEY and plain unique indexes, which would
-- let duplicate project-scope rows past upsert conflict detection.
CREATE TABLE task_delivery_setup (
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('project','run','task')),
  scope_ref TEXT,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  CHECK ((scope='project' AND scope_ref IS NULL)
      OR (scope IN ('run','task') AND scope_ref IS NOT NULL))
);

CREATE UNIQUE INDEX task_delivery_setup_key
  ON task_delivery_setup(project_id, scope, IFNULL(scope_ref, ''), key);
