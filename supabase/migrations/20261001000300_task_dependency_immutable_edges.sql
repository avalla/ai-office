-- Edges change through unlink/link. Updating an edge would bypass the insert
-- cycle trigger and obscure the original creation timestamp.
CREATE FUNCTION core.prevent_task_dependency_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'task dependency edges are immutable'
    USING ERRCODE = '55000', CONSTRAINT = 'task_dependency_immutable';
END;
$$;

CREATE TRIGGER task_dependency_prevent_update
BEFORE UPDATE ON core.task_dependency
FOR EACH ROW EXECUTE FUNCTION core.prevent_task_dependency_update();
