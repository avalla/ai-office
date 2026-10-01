CREATE TABLE core.task_execution_history (
  task_id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES core.project(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('unknown', 'executed')),
  first_known_at timestamptz,
  CHECK (state = 'executed' OR first_known_at IS NULL),
  FOREIGN KEY (task_id, project_id) REFERENCES core.task(id, project_id) ON DELETE CASCADE
);

CREATE INDEX task_execution_history_project_idx
ON core.task_execution_history(project_id, task_id);

-- Current status is not lifetime history. Backfill from persisted authority;
-- a currently running task is itself proof even when no timestamp survives.
INSERT INTO core.task_execution_history(task_id, project_id, state, first_known_at)
SELECT task.id, task.project_id, 'executed', MIN(evidence.at)
FROM core.task task JOIN (
  SELECT aggregate_id AS task_id, project_id, occurred_at AS at
  FROM core.audit_event WHERE aggregate_type = 'task'
    AND event_type = 'task.status_changed'
    AND payload_json->>'operation' = 'start'
  UNION ALL
  SELECT task_id, project_id, created_at FROM core.agent_run WHERE task_id IS NOT NULL
  UNION ALL
  SELECT task_id, project_id, created_at FROM core.pipeline_run
  UNION ALL
  SELECT id, project_id, NULL::timestamptz FROM core.task
    WHERE status IN ('running', 'waiting_review')
) evidence ON evidence.task_id = task.id AND evidence.project_id = task.project_id
GROUP BY task.id, task.project_id;

CREATE FUNCTION core.guard_task_execution_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM core.task WHERE id = OLD.task_id)
      AND EXISTS (SELECT 1 FROM core.project WHERE id = OLD.project_id) THEN
      RAISE EXCEPTION 'task execution history is append-only';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT (OLD.state = 'unknown' AND NEW.state = 'executed'
    AND OLD.task_id = NEW.task_id AND OLD.project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'task execution history is monotonic';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_execution_history_no_regression
BEFORE UPDATE OR DELETE ON core.task_execution_history
FOR EACH ROW EXECUTE FUNCTION core.guard_task_execution_history();

CREATE FUNCTION core.mark_task_execution_history() RETURNS trigger
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
      AND prerequisite.status <> 'completed'
  ) THEN
    RAISE EXCEPTION 'task has incomplete prerequisites';
  END IF;
  INSERT INTO core.task_execution_history(task_id, project_id, state, first_known_at)
  VALUES (history_task_id, history_project_id, 'executed', history_at)
  ON CONFLICT(task_id) DO UPDATE SET state = 'executed',
    first_known_at = COALESCE(core.task_execution_history.first_known_at, EXCLUDED.first_known_at)
  WHERE core.task_execution_history.state = 'unknown';
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_execution_history_task_start
AFTER UPDATE OF status ON core.task
FOR EACH ROW EXECUTE FUNCTION core.mark_task_execution_history();

CREATE TRIGGER task_execution_history_agent_run
AFTER INSERT ON core.agent_run
FOR EACH ROW EXECUTE FUNCTION core.mark_task_execution_history();

CREATE TRIGGER task_execution_history_pipeline_run
AFTER INSERT ON core.pipeline_run
FOR EACH ROW EXECUTE FUNCTION core.mark_task_execution_history();

CREATE FUNCTION core.guard_task_dependency_execution_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  dependent_project_id text;
  dependent_task_id text;
BEGIN
  dependent_project_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.project_id ELSE NEW.project_id END;
  dependent_task_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.task_id ELSE NEW.task_id END;
  IF TG_OP = 'DELETE' AND (
    NOT EXISTS (SELECT 1 FROM core.project WHERE id = dependent_project_id)
    OR NOT EXISTS (SELECT 1 FROM core.task WHERE id = dependent_task_id)
  ) THEN RETURN OLD; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(dependent_project_id, 0));
  IF EXISTS (SELECT 1 FROM core.task_execution_history
    WHERE project_id = dependent_project_id AND task_id = dependent_task_id) THEN
    RAISE EXCEPTION 'task dependency cannot change after execution history';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Some pre-release installations recorded the dependency migration before
-- the cycle trigger was present. Repair that authority in this forward step.
CREATE OR REPLACE FUNCTION core.reject_task_dependency_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.project_id, 0));
  IF EXISTS (
    WITH RECURSIVE reachable(id) AS (
      SELECT task_id FROM core.task_dependency WHERE depends_on_task_id = NEW.task_id
      UNION
      SELECT edge.task_id FROM core.task_dependency edge
      JOIN reachable ON edge.depends_on_task_id = reachable.id
    ) SELECT 1 FROM reachable WHERE id = NEW.depends_on_task_id
  ) THEN
    RAISE EXCEPTION 'task dependency cycle';
  END IF;
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'core.task_dependency'::regclass
      AND tgname = 'task_dependency_cycle_insert') THEN
    CREATE TRIGGER task_dependency_cycle_insert
    BEFORE INSERT ON core.task_dependency
    FOR EACH ROW EXECUTE FUNCTION core.reject_task_dependency_cycle();
  END IF;
END $$;

CREATE TRIGGER task_dependency_history_guard
BEFORE INSERT OR DELETE ON core.task_dependency
FOR EACH ROW EXECUTE FUNCTION core.guard_task_dependency_execution_history();

ALTER TABLE core.task_execution_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.task_execution_history FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON core.task_execution_history TO authenticated;
    CREATE POLICY task_execution_history_select_project_member
      ON core.task_execution_history FOR SELECT TO authenticated
      USING (private.can_access_project(project_id));
  END IF;
END;
$$;
