-- Explicit Task <-> Requirement linkage.
--
-- Many-to-many on purpose: one task can deliver several requirements, and one
-- requirement can need several tasks. Neither side can therefore be a column on
-- the other. Nothing is inferred from titles or requirement keys; a link exists
-- only because an operator created it.
--
-- Historical state is deliberately not fabricated: this migration creates the
-- table and links nothing. `task:reconcile` reports questionable tasks after the
-- upgrade and the operator decides.

CREATE TABLE task_requirement (
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL REFERENCES requirement(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, requirement_id)
);

-- Reverse lookups ("which tasks deliver this requirement") need their own path;
-- the primary key only serves the task-first direction.
CREATE INDEX task_requirement_requirement_idx
ON task_requirement(requirement_id, task_id);

-- Project-boundary enforcement, following the requirement/milestone ownership
-- precedent in 0011. Foreign keys alone cannot express "both ends belong to the
-- same project", and cross-project linkage would break portable snapshots.
CREATE TRIGGER task_requirement_project_ownership_insert
BEFORE INSERT ON task_requirement
WHEN NOT EXISTS (
  SELECT 1
  FROM task t
  JOIN requirement r ON r.id = NEW.requirement_id
  WHERE t.id = NEW.task_id AND t.project_id = r.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'task and requirement must belong to the same project');
END;

CREATE TRIGGER task_requirement_project_ownership_update
BEFORE UPDATE OF task_id, requirement_id ON task_requirement
WHEN NOT EXISTS (
  SELECT 1
  FROM task t
  JOIN requirement r ON r.id = NEW.requirement_id
  WHERE t.id = NEW.task_id AND t.project_id = r.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'task and requirement must belong to the same project');
END;
