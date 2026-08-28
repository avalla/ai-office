ALTER TABLE action_requests
ADD COLUMN agent_run_id TEXT REFERENCES agent_run(id);

CREATE INDEX action_requests_agent_run_idx
ON action_requests(project_id, agent_run_id, created_at, id);

DROP TRIGGER action_request_pipeline_binding_valid;

CREATE TRIGGER action_request_pipeline_binding_valid
BEFORE INSERT ON action_requests
WHEN NEW.pipeline_run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM pipeline_run pr
  JOIN pipeline_stage_run psr
    ON psr.pipeline_run_id = pr.id AND psr.project_id = pr.project_id
  WHERE pr.id = NEW.pipeline_run_id
    AND pr.project_id = NEW.project_id
    AND pr.status = 'active'
    AND psr.id = NEW.pipeline_stage_run_id
    AND psr.status IN ('active', 'awaiting_approval')
)
BEGIN SELECT RAISE(ABORT, 'action request pipeline binding is inconsistent'); END;

CREATE TRIGGER action_request_agent_run_binding_valid
BEFORE INSERT ON action_requests
WHEN NEW.agent_run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_run ar
  WHERE ar.id = NEW.agent_run_id
    AND ar.project_id = NEW.project_id
    AND ar.agent_id = NEW.agent_id
    AND (ar.pipeline_run_id IS NEW.pipeline_run_id)
)
BEGIN SELECT RAISE(ABORT, 'action request agent-run binding is inconsistent'); END;

CREATE TRIGGER action_request_agent_run_binding_immutable
BEFORE UPDATE OF agent_run_id ON action_requests
WHEN NEW.agent_run_id IS NOT OLD.agent_run_id
BEGIN SELECT RAISE(ABORT, 'action request agent-run binding is immutable'); END;
