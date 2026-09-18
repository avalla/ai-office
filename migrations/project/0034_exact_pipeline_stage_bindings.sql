ALTER TABLE agent_run ADD COLUMN pipeline_stage_run_id TEXT
  REFERENCES pipeline_stage_run(id);

CREATE INDEX agent_run_pipeline_stage_idx
ON agent_run(project_id, pipeline_stage_run_id, status, created_at, id);

CREATE TRIGGER agent_run_pipeline_stage_binding_valid
BEFORE INSERT ON agent_run
WHEN NEW.pipeline_run_id IS NOT NULL AND (
  NEW.pipeline_stage_run_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pipeline_run pr
    JOIN pipeline_stage_run psr
      ON psr.project_id = pr.project_id
     AND psr.pipeline_run_id = pr.id
     AND psr.id = NEW.pipeline_stage_run_id
    WHERE pr.id = NEW.pipeline_run_id
      AND pr.project_id = NEW.project_id
      AND pr.task_id = NEW.task_id
      AND pr.status = 'active'
      AND psr.stage_index = pr.current_stage_index
      AND psr.status = 'active'
      AND psr.assigned_agent_id = NEW.agent_id
  )
)
BEGIN SELECT RAISE(ABORT, 'agent run pipeline stage binding is not currently assigned'); END;

CREATE TRIGGER agent_run_pipeline_stage_binding_immutable
BEFORE UPDATE OF pipeline_stage_run_id ON agent_run
WHEN NEW.pipeline_stage_run_id IS NOT OLD.pipeline_stage_run_id
BEGIN SELECT RAISE(ABORT, 'agent run pipeline stage binding is immutable'); END;

ALTER TABLE job_outbox ADD COLUMN pipeline_stage_run_id TEXT
  REFERENCES pipeline_stage_run(id);

CREATE INDEX job_outbox_stage_idx
ON job_outbox(project_id, pipeline_stage_run_id, dispatched_at, created_at, id);

CREATE TRIGGER job_outbox_stage_binding_valid
BEFORE INSERT ON job_outbox
WHEN NEW.pipeline_stage_run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM pipeline_stage_run psr
  WHERE psr.project_id = NEW.project_id
    AND psr.id = NEW.pipeline_stage_run_id
    AND (
      (NEW.job_type = 'orchestrate_pipeline'
       AND NEW.aggregate_type = 'pipeline_run'
       AND psr.pipeline_run_id = NEW.aggregate_id)
      OR
      (NEW.job_type = 'execute_agent_run'
       AND NEW.aggregate_type = 'agent_run'
       AND EXISTS (
         SELECT 1
         FROM agent_run ar
         WHERE ar.project_id = NEW.project_id
           AND ar.id = NEW.aggregate_id
           AND ar.pipeline_stage_run_id = psr.id
       ))
    )
)
BEGIN SELECT RAISE(ABORT, 'job outbox pipeline stage binding is invalid'); END;

CREATE TRIGGER job_outbox_stage_binding_immutable
BEFORE UPDATE OF pipeline_stage_run_id ON job_outbox
WHEN NEW.pipeline_stage_run_id IS NOT OLD.pipeline_stage_run_id
BEGIN SELECT RAISE(ABORT, 'job outbox pipeline stage binding is immutable'); END;
