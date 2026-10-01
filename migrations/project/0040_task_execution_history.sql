-- Absence means known pristine only in a database whose complete local history
-- was inspected by this migration. Legacy archives restore an explicit unknown.
CREATE TABLE task_execution_history (
  task_id TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('unknown', 'executed')),
  first_known_at TEXT,
  CHECK (state = 'executed' OR first_known_at IS NULL)
);

CREATE INDEX task_execution_history_project_idx
ON task_execution_history(project_id, task_id);

CREATE TRIGGER task_execution_history_ownership
BEFORE INSERT ON task_execution_history
WHEN NOT EXISTS (SELECT 1 FROM task WHERE id = NEW.task_id AND project_id = NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'task execution history must belong to task project'); END;

CREATE TRIGGER task_execution_history_no_regression
BEFORE UPDATE ON task_execution_history
WHEN NOT (OLD.state = 'unknown' AND NEW.state = 'executed'
  AND NEW.task_id = OLD.task_id AND NEW.project_id = OLD.project_id)
BEGIN SELECT RAISE(ABORT, 'task execution history is monotonic'); END;

CREATE TRIGGER task_execution_history_no_delete
BEFORE DELETE ON task_execution_history
WHEN EXISTS (SELECT 1 FROM task WHERE id = OLD.task_id)
  AND EXISTS (SELECT 1 FROM project WHERE id = OLD.project_id)
BEGIN SELECT RAISE(ABORT, 'task execution history is append-only'); END;

-- Use only authoritative local execution evidence. A status alone can prove
-- execution only when it is currently in an execution state.
INSERT INTO task_execution_history(task_id, project_id, state, first_known_at)
SELECT task.id, task.project_id, 'executed', MIN(evidence.at)
FROM task JOIN (
  SELECT aggregate_id AS task_id, project_id, occurred_at AS at
  FROM audit_event WHERE aggregate_type = 'task'
    AND event_type = 'task.status_changed'
    AND json_extract(payload_json, '$.operation') = 'start'
  UNION ALL
  SELECT task_id, project_id, created_at FROM agent_run
  UNION ALL
  SELECT task_id, project_id, created_at FROM pipeline_run
  UNION ALL
  SELECT id, project_id, NULL FROM task WHERE status IN ('running', 'waiting_review')
) evidence ON evidence.task_id = task.id AND evidence.project_id = task.project_id
GROUP BY task.id, task.project_id;

-- Earlier portable imports did not carry lifetime execution evidence. Even a
-- pending task with no surviving local audit could have executed elsewhere.
INSERT INTO task_execution_history(task_id, project_id, state)
SELECT task.id, task.project_id, 'unknown'
FROM task
WHERE EXISTS (SELECT 1 FROM project_state_revision revision
  WHERE revision.project_id = task.project_id AND revision.origin = 'portable_import')
  AND NOT EXISTS (SELECT 1 FROM task_execution_history history
    WHERE history.task_id = task.id);

CREATE TRIGGER task_execution_history_task_start
AFTER UPDATE OF status ON task
WHEN NEW.status IN ('running', 'waiting_review') AND OLD.status <> NEW.status
BEGIN
  SELECT RAISE(ABORT, 'task has incomplete prerequisites')
  WHERE NEW.status = 'running' AND EXISTS (
    SELECT 1 FROM task_dependency edge
    JOIN task prerequisite ON prerequisite.id = edge.depends_on_task_id
    WHERE edge.project_id = NEW.project_id AND edge.task_id = NEW.id
      AND prerequisite.status <> 'completed'
  );
  INSERT INTO task_execution_history(task_id, project_id, state, first_known_at)
  VALUES (NEW.id, NEW.project_id, 'executed',
    CASE WHEN NEW.status = 'running' THEN NEW.updated_at ELSE NULL END)
  ON CONFLICT(task_id) DO UPDATE SET state = 'executed',
    first_known_at = COALESCE(task_execution_history.first_known_at, excluded.first_known_at)
  WHERE task_execution_history.state = 'unknown';
END;

CREATE TRIGGER task_execution_history_agent_run
AFTER INSERT ON agent_run
BEGIN
  SELECT RAISE(ABORT, 'task has incomplete prerequisites')
  WHERE NEW.status IN ('queued', 'preparing', 'running', 'reviewing') AND EXISTS (
    SELECT 1 FROM task_dependency edge
    JOIN task prerequisite ON prerequisite.id = edge.depends_on_task_id
    WHERE edge.project_id = NEW.project_id AND edge.task_id = NEW.task_id
      AND prerequisite.status <> 'completed'
  );
  INSERT INTO task_execution_history(task_id, project_id, state, first_known_at)
  VALUES (NEW.task_id, NEW.project_id, 'executed', NEW.created_at)
  ON CONFLICT(task_id) DO UPDATE SET state = 'executed',
    first_known_at = COALESCE(task_execution_history.first_known_at, excluded.first_known_at)
  WHERE task_execution_history.state = 'unknown';
END;

CREATE TRIGGER task_execution_history_pipeline_run
AFTER INSERT ON pipeline_run
BEGIN
  SELECT RAISE(ABORT, 'task has incomplete prerequisites')
  WHERE NEW.status = 'active' AND EXISTS (
    SELECT 1 FROM task_dependency edge
    JOIN task prerequisite ON prerequisite.id = edge.depends_on_task_id
    WHERE edge.project_id = NEW.project_id AND edge.task_id = NEW.task_id
      AND prerequisite.status <> 'completed'
  );
  INSERT INTO task_execution_history(task_id, project_id, state, first_known_at)
  VALUES (NEW.task_id, NEW.project_id, 'executed', NEW.created_at)
  ON CONFLICT(task_id) DO UPDATE SET state = 'executed',
    first_known_at = COALESCE(task_execution_history.first_known_at, excluded.first_known_at)
  WHERE task_execution_history.state = 'unknown';
END;

CREATE TRIGGER task_dependency_history_insert
BEFORE INSERT ON task_dependency
WHEN EXISTS (SELECT 1 FROM task_execution_history
  WHERE task_id = NEW.task_id AND project_id = NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'task dependency cannot change after execution history'); END;

CREATE TRIGGER task_dependency_history_delete
BEFORE DELETE ON task_dependency
WHEN EXISTS (SELECT 1 FROM task WHERE id = OLD.task_id)
  AND EXISTS (SELECT 1 FROM project WHERE id = OLD.project_id)
  AND EXISTS (SELECT 1 FROM task_execution_history
    WHERE task_id = OLD.task_id AND project_id = OLD.project_id)
BEGIN SELECT RAISE(ABORT, 'task dependency cannot change after execution history'); END;
