-- Admission accepts review-submitted prerequisites (0048); completion does not.
-- A review can still be rejected, so a dependent may only finish once every
-- prerequisite is completed. Historical corrections (pending/blocked ->
-- completed) attest work done elsewhere and are not execution, so they are
-- outside this guard.

CREATE TRIGGER task_completion_requires_completed_prerequisites
BEFORE UPDATE OF status ON task
WHEN NEW.status = 'completed' AND OLD.status IN ('running', 'waiting_review')
BEGIN
  SELECT RAISE(ABORT, 'task has incomplete prerequisites')
  WHERE EXISTS (
    SELECT 1 FROM task_dependency edge
    JOIN task prerequisite ON prerequisite.id = edge.depends_on_task_id
    WHERE edge.project_id = NEW.project_id AND edge.task_id = NEW.id
      AND prerequisite.status <> 'completed'
  );
END;
