-- Existing projects begin with no prerequisites. All changes are explicit.
CREATE TABLE task_dependency (
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE INDEX task_dependency_project_prerequisite_idx
ON task_dependency(project_id, depends_on_task_id);

CREATE TRIGGER task_dependency_ownership_insert
BEFORE INSERT ON task_dependency
WHEN NOT EXISTS (
  SELECT 1 FROM task task
  JOIN task prerequisite ON prerequisite.id = NEW.depends_on_task_id
  WHERE task.id = NEW.task_id
    AND task.project_id = NEW.project_id
    AND prerequisite.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'task dependency must remain in one project');
END;

CREATE TRIGGER task_dependency_ownership_update
BEFORE UPDATE OF project_id, task_id, depends_on_task_id ON task_dependency
WHEN NOT EXISTS (
  SELECT 1 FROM task task
  JOIN task prerequisite ON prerequisite.id = NEW.depends_on_task_id
  WHERE task.id = NEW.task_id
    AND task.project_id = NEW.project_id
    AND prerequisite.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'task dependency must remain in one project');
END;

CREATE TRIGGER task_dependency_cycle_insert
BEFORE INSERT ON task_dependency
WHEN EXISTS (
  WITH RECURSIVE reachable(id) AS (
    SELECT task_id FROM task_dependency WHERE depends_on_task_id = NEW.task_id
    UNION
    SELECT edge.task_id FROM task_dependency edge
    JOIN reachable ON edge.depends_on_task_id = reachable.id
  )
  SELECT 1 FROM reachable WHERE id = NEW.depends_on_task_id
)
BEGIN
  SELECT RAISE(ABORT, 'task dependency cycle');
END;
