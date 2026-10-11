-- Review-submitted prerequisites allow dependent execution while the review is open.

DROP TRIGGER task_execution_history_task_start;

CREATE TRIGGER task_execution_history_task_start
AFTER UPDATE OF status ON task
WHEN NEW.status IN ('running', 'waiting_review') AND OLD.status <> NEW.status
BEGIN
  SELECT RAISE(ABORT, 'task has incomplete prerequisites')
  WHERE NEW.status = 'running' AND EXISTS (
    SELECT 1 FROM task_dependency edge
    JOIN task prerequisite ON prerequisite.id = edge.depends_on_task_id
    WHERE edge.project_id = NEW.project_id AND edge.task_id = NEW.id
      AND prerequisite.status NOT IN ('completed', 'waiting_review')
  );
  INSERT INTO task_execution_history(task_id, project_id, state, first_known_at)
  VALUES (NEW.id, NEW.project_id, 'executed',
    CASE WHEN NEW.status = 'running' THEN NEW.updated_at ELSE NULL END)
  ON CONFLICT(task_id) DO UPDATE SET state = 'executed',
    first_known_at = CASE
      WHEN task_execution_history.first_known_at IS NULL THEN excluded.first_known_at
      WHEN excluded.first_known_at IS NULL THEN task_execution_history.first_known_at
      WHEN excluded.first_known_at < task_execution_history.first_known_at THEN excluded.first_known_at
      ELSE task_execution_history.first_known_at
    END
  WHERE task_execution_history.state = 'unknown'
    OR (
      task_execution_history.state = 'executed'
      AND excluded.first_known_at IS NOT NULL
      AND (
        task_execution_history.first_known_at IS NULL
        OR excluded.first_known_at < task_execution_history.first_known_at
      )
    );
END;

DROP TRIGGER task_execution_history_agent_run;

CREATE TRIGGER task_execution_history_agent_run
AFTER INSERT ON agent_run
BEGIN
  SELECT RAISE(ABORT, 'task has incomplete prerequisites')
  WHERE NEW.status IN ('queued', 'preparing', 'running', 'reviewing') AND EXISTS (
    SELECT 1 FROM task_dependency edge
    JOIN task prerequisite ON prerequisite.id = edge.depends_on_task_id
    WHERE edge.project_id = NEW.project_id AND edge.task_id = NEW.task_id
      AND prerequisite.status NOT IN ('completed', 'waiting_review')
  );
  INSERT INTO task_execution_history(task_id, project_id, state, first_known_at)
  VALUES (NEW.task_id, NEW.project_id, 'executed', NEW.created_at)
  ON CONFLICT(task_id) DO UPDATE SET state = 'executed',
    first_known_at = CASE
      WHEN task_execution_history.first_known_at IS NULL THEN excluded.first_known_at
      WHEN excluded.first_known_at IS NULL THEN task_execution_history.first_known_at
      WHEN excluded.first_known_at < task_execution_history.first_known_at THEN excluded.first_known_at
      ELSE task_execution_history.first_known_at
    END
  WHERE task_execution_history.state = 'unknown'
    OR (
      task_execution_history.state = 'executed'
      AND excluded.first_known_at IS NOT NULL
      AND (
        task_execution_history.first_known_at IS NULL
        OR excluded.first_known_at < task_execution_history.first_known_at
      )
    );
END;

DROP TRIGGER task_execution_history_pipeline_run;

CREATE TRIGGER task_execution_history_pipeline_run
AFTER INSERT ON pipeline_run
BEGIN
  SELECT RAISE(ABORT, 'task has incomplete prerequisites')
  WHERE NEW.status = 'active' AND EXISTS (
    SELECT 1 FROM task_dependency edge
    JOIN task prerequisite ON prerequisite.id = edge.depends_on_task_id
    WHERE edge.project_id = NEW.project_id AND edge.task_id = NEW.task_id
      AND prerequisite.status NOT IN ('completed', 'waiting_review')
  );
  INSERT INTO task_execution_history(task_id, project_id, state, first_known_at)
  VALUES (NEW.task_id, NEW.project_id, 'executed', NEW.created_at)
  ON CONFLICT(task_id) DO UPDATE SET state = 'executed',
    first_known_at = CASE
      WHEN task_execution_history.first_known_at IS NULL THEN excluded.first_known_at
      WHEN excluded.first_known_at IS NULL THEN task_execution_history.first_known_at
      WHEN excluded.first_known_at < task_execution_history.first_known_at THEN excluded.first_known_at
      ELSE task_execution_history.first_known_at
    END
  WHERE task_execution_history.state = 'unknown'
    OR (
      task_execution_history.state = 'executed'
      AND excluded.first_known_at IS NOT NULL
      AND (
        task_execution_history.first_known_at IS NULL
        OR excluded.first_known_at < task_execution_history.first_known_at
      )
    );
END;
