-- Edges change through unlink/link. Updating an edge would bypass the insert
-- cycle trigger and obscure the original creation timestamp.
CREATE TRIGGER task_dependency_prevent_update
BEFORE UPDATE ON task_dependency
BEGIN
  SELECT RAISE(ABORT, 'task dependency edges are immutable');
END;
