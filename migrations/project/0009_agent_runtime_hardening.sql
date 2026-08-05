CREATE INDEX agent_run_recovery_idx
ON agent_run(status, updated_at, id)
WHERE status IN ('preparing', 'running', 'reviewing');

CREATE INDEX task_lock_expiry_idx ON task_lock(expires_at, task_id);

CREATE TRIGGER agent_role_same_project_insert
BEFORE INSERT ON agent
WHEN NOT EXISTS (
  SELECT 1 FROM role
  WHERE role.id = NEW.role_id AND role.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent role must belong to the same project');
END;

CREATE TRIGGER agent_role_same_project_update
BEFORE UPDATE OF project_id, role_id ON agent
WHEN NOT EXISTS (
  SELECT 1 FROM role
  WHERE role.id = NEW.role_id AND role.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent role must belong to the same project');
END;

CREATE TRIGGER agent_run_ownership_insert
BEFORE INSERT ON agent_run
WHEN NOT EXISTS (
  SELECT 1 FROM task
  WHERE task.id = NEW.task_id AND task.project_id = NEW.project_id
) OR NOT EXISTS (
  SELECT 1 FROM agent
  WHERE agent.id = NEW.agent_id AND agent.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent run references must belong to the same project');
END;

CREATE TRIGGER agent_run_ownership_update
BEFORE UPDATE OF project_id, task_id, agent_id ON agent_run
WHEN NOT EXISTS (
  SELECT 1 FROM task
  WHERE task.id = NEW.task_id AND task.project_id = NEW.project_id
) OR NOT EXISTS (
  SELECT 1 FROM agent
  WHERE agent.id = NEW.agent_id AND agent.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent run references must belong to the same project');
END;
