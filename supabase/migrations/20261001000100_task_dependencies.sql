CREATE TABLE core.task_dependency (
  project_id text NOT NULL REFERENCES core.project(id) ON DELETE CASCADE,
  task_id text NOT NULL,
  depends_on_task_id text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id),
  FOREIGN KEY (task_id, project_id) REFERENCES core.task(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_task_id, project_id) REFERENCES core.task(id, project_id) ON DELETE CASCADE
);

CREATE INDEX task_dependency_project_prerequisite_idx
ON core.task_dependency(project_id, depends_on_task_id);

CREATE FUNCTION core.reject_task_dependency_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize graph edits within the project, including concurrent writers.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.project_id, 0));
  IF EXISTS (
    WITH RECURSIVE reachable(id) AS (
      SELECT task_id FROM core.task_dependency WHERE depends_on_task_id = NEW.task_id
      UNION
      SELECT edge.task_id FROM core.task_dependency edge
      JOIN reachable ON edge.depends_on_task_id = reachable.id
    )
    SELECT 1 FROM reachable WHERE id = NEW.depends_on_task_id
  ) THEN
    RAISE EXCEPTION 'task dependency cycle';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_dependency_cycle_insert
BEFORE INSERT ON core.task_dependency
FOR EACH ROW EXECUTE FUNCTION core.reject_task_dependency_cycle();

CREATE TRIGGER task_dependency_project_tenant_reparenting
BEFORE UPDATE OF project_id ON core.task_dependency
FOR EACH ROW EXECUTE FUNCTION core.enforce_project_tenant_reparenting();

ALTER TABLE core.task_dependency ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.task_dependency FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON core.task_dependency TO authenticated;
    CREATE POLICY task_dependency_select_project_member ON core.task_dependency
      FOR SELECT TO authenticated USING (private.can_access_project(project_id));
    CREATE POLICY task_dependency_insert_project_member ON core.task_dependency
      FOR INSERT TO authenticated WITH CHECK (private.can_access_project(project_id));
    CREATE POLICY task_dependency_update_project_member ON core.task_dependency
      FOR UPDATE TO authenticated USING (private.can_access_project(project_id))
      WITH CHECK (private.can_access_project(project_id));
    CREATE POLICY task_dependency_delete_project_member ON core.task_dependency
      FOR DELETE TO authenticated USING (private.can_access_project(project_id));
  END IF;
END;
$$;
