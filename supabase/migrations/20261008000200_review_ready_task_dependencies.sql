-- Review-submitted prerequisites allow dependent execution while the review is open.
CREATE OR REPLACE FUNCTION core.mark_task_execution_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  history_task_id text;
  history_project_id text;
  history_at timestamptz;
  new_authority boolean;
BEGIN
  IF TG_TABLE_NAME = 'task' THEN
    IF TG_OP <> 'UPDATE' OR NEW.status NOT IN ('running', 'waiting_review')
      OR OLD.status = NEW.status THEN
      RETURN NEW;
    END IF;
    history_task_id := NEW.id;
    history_project_id := NEW.project_id;
    history_at := CASE WHEN NEW.status = 'running' THEN NEW.updated_at ELSE NULL END;
    new_authority := NEW.status = 'running';
  ELSE
    history_task_id := NEW.task_id;
    IF history_task_id IS NULL THEN RETURN NEW; END IF;
    history_project_id := NEW.project_id;
    history_at := NEW.created_at;
    new_authority := CASE WHEN TG_TABLE_NAME = 'agent_run'
      THEN NEW.status IN ('queued', 'preparing', 'running', 'reviewing')
      ELSE NEW.status = 'active' END;
  END IF;
  -- Shares the project's graph-edit lock. The authority write and marker are
  -- in one transaction; concurrent edge edits cannot race the marker.
  PERFORM pg_advisory_xact_lock(hashtextextended(history_project_id, 0));
  IF new_authority AND EXISTS (
    SELECT 1 FROM core.task_dependency edge
    JOIN core.task prerequisite ON prerequisite.id = edge.depends_on_task_id
      AND prerequisite.project_id = edge.project_id
    WHERE edge.project_id = history_project_id AND edge.task_id = history_task_id
      AND prerequisite.status NOT IN ('completed', 'waiting_review')
  ) THEN
    RAISE EXCEPTION 'task has incomplete prerequisites';
  END IF;
  INSERT INTO core.task_execution_history(task_id, project_id, state, first_known_at)
  VALUES (history_task_id, history_project_id, 'executed', history_at)
  ON CONFLICT(task_id) DO UPDATE SET state = 'executed',
    first_known_at = CASE
      WHEN core.task_execution_history.first_known_at IS NULL THEN EXCLUDED.first_known_at
      WHEN EXCLUDED.first_known_at IS NULL THEN core.task_execution_history.first_known_at
      ELSE LEAST(core.task_execution_history.first_known_at, EXCLUDED.first_known_at)
    END
  WHERE core.task_execution_history.state = 'unknown'
    OR (
      core.task_execution_history.state = 'executed'
      AND EXCLUDED.first_known_at IS NOT NULL
      AND (
        core.task_execution_history.first_known_at IS NULL
        OR EXCLUDED.first_known_at < core.task_execution_history.first_known_at
      )
    );
  RETURN NEW;
END;
$$;
