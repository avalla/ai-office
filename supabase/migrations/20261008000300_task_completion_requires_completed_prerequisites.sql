-- Completion requires completed prerequisites, and exits from review are
-- serialized with dependent admission on the project's graph-edit lock.
--
-- Admission (task start, agent_run / pipeline_run insert) takes the lock and
-- then reads prerequisite statuses with a fresh READ COMMITTED snapshot. A
-- prerequisite leaving waiting_review for blocked/failed/cancelled now takes
-- the same lock in the transaction that writes the status, so admission either
-- waits for that commit and then sees the new status, or commits first and the
-- exit is ordered after it. Without this the early return let the exit commit
-- while admission still read the stale waiting_review snapshot.
CREATE OR REPLACE FUNCTION core.mark_task_execution_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  history_task_id text;
  history_project_id text;
  history_at timestamptz;
  new_authority boolean;
BEGIN
  IF TG_TABLE_NAME = 'task' THEN
    IF TG_OP <> 'UPDATE' OR OLD.status = NEW.status THEN
      RETURN NEW;
    END IF;
    IF NEW.status = 'completed' AND OLD.status IN ('running', 'waiting_review')
      AND EXISTS (SELECT 1 FROM core.task_dependency edge
        WHERE edge.project_id = NEW.project_id AND edge.task_id = NEW.id) THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(NEW.project_id, 0));
      IF EXISTS (
        SELECT 1 FROM core.task_dependency edge
        JOIN core.task prerequisite ON prerequisite.id = edge.depends_on_task_id
          AND prerequisite.project_id = edge.project_id
        WHERE edge.project_id = NEW.project_id AND edge.task_id = NEW.id
          AND prerequisite.status <> 'completed'
      ) THEN
        RAISE EXCEPTION 'task has incomplete prerequisites';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.status = 'waiting_review'
      AND NEW.status IN ('blocked', 'failed', 'cancelled') THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(NEW.project_id, 0));
      RETURN NEW;
    END IF;
    IF NEW.status NOT IN ('running', 'waiting_review') THEN
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

-- Claiming a queued run is admission too. It takes the same project lock and
-- re-reads prerequisite statuses, so a claim cannot commit on a stale
-- waiting_review snapshot while the prerequisite is leaving review.
CREATE TRIGGER task_execution_history_agent_run_claim
AFTER UPDATE OF status ON core.agent_run
FOR EACH ROW
WHEN (OLD.status = 'queued' AND NEW.status IN ('preparing', 'running', 'reviewing'))
EXECUTE FUNCTION core.mark_task_execution_history();
