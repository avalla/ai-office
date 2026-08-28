CREATE UNIQUE INDEX office_manifest_project_id_unique
ON office_manifest_revision(project_id, id);

CREATE TABLE pipeline_run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES task(id),
  manifest_revision_id TEXT NOT NULL,
  manifest_revision INTEGER NOT NULL CHECK (manifest_revision > 0),
  definition_json TEXT NOT NULL CHECK (
    json_valid(definition_json) AND json_type(definition_json) = 'object'
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  current_stage_index INTEGER NOT NULL CHECK (current_stage_index >= 0),
  started_by TEXT NOT NULL CHECK (length(trim(started_by)) > 0),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT,
  UNIQUE(project_id, id),
  FOREIGN KEY(project_id, manifest_revision_id)
    REFERENCES office_manifest_revision(project_id, id),
  CHECK (
    (status = 'active' AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'cancelled' AND completed_at IS NULL AND cancelled_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX pipeline_run_active_task_idx
ON pipeline_run(project_id, task_id) WHERE status = 'active';
CREATE INDEX pipeline_run_project_status_idx
ON pipeline_run(project_id, status, created_at, id);

CREATE TRIGGER pipeline_run_immutable_definition
BEFORE UPDATE OF id, project_id, task_id, manifest_revision_id,
  manifest_revision, definition_json, started_by, created_at ON pipeline_run
BEGIN SELECT RAISE(ABORT, 'pipeline run definition is immutable'); END;

CREATE TRIGGER pipeline_run_status_transition
BEFORE UPDATE OF status ON pipeline_run
WHEN NEW.status <> OLD.status
  AND NOT (OLD.status = 'active' AND NEW.status IN ('completed', 'cancelled'))
BEGIN SELECT RAISE(ABORT, 'invalid pipeline run status transition'); END;

CREATE TRIGGER pipeline_run_version_transition
BEFORE UPDATE ON pipeline_run
WHEN NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'invalid pipeline run version transition'); END;

CREATE TABLE pipeline_stage_run (
  id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  stage_id TEXT NOT NULL CHECK (length(trim(stage_id)) > 0),
  stage_index INTEGER NOT NULL CHECK (stage_index >= 0),
  role_id TEXT NOT NULL CHECK (length(trim(role_id)) > 0),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'active', 'awaiting_approval', 'completed', 'cancelled')
  ),
  assigned_agent_id TEXT,
  assigned_at TEXT,
  completed_at TEXT,
  approved_by TEXT,
  approval_decision TEXT CHECK (approval_decision IN ('approved', 'rejected')),
  approval_rationale TEXT,
  approved_at TEXT,
  UNIQUE(project_id, id),
  UNIQUE(pipeline_run_id, stage_index),
  UNIQUE(pipeline_run_id, stage_id),
  FOREIGN KEY(project_id, pipeline_run_id)
    REFERENCES pipeline_run(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY(project_id, assigned_agent_id)
    REFERENCES agent(project_id, id),
  CHECK ((assigned_agent_id IS NULL) = (assigned_at IS NULL)),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK ((approved_by IS NULL) = (approval_decision IS NULL)),
  CHECK (approval_rationale IS NULL OR approved_by IS NOT NULL),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX pipeline_stage_run_assignment_idx
ON pipeline_stage_run(project_id, assigned_agent_id, status, id);
CREATE UNIQUE INDEX pipeline_stage_run_one_active_idx
ON pipeline_stage_run(pipeline_run_id)
WHERE status IN ('active', 'awaiting_approval');

CREATE TRIGGER pipeline_stage_run_immutable_identity
BEFORE UPDATE OF id, pipeline_run_id, project_id, stage_id, stage_index, role_id
ON pipeline_stage_run
BEGIN SELECT RAISE(ABORT, 'pipeline stage identity is immutable'); END;

CREATE TRIGGER pipeline_stage_run_status_transition
BEFORE UPDATE OF status ON pipeline_stage_run
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'pending' AND NEW.status IN ('active', 'cancelled'))
  OR (OLD.status = 'active' AND NEW.status IN (
    'awaiting_approval', 'completed', 'cancelled'
  ))
  OR (OLD.status = 'awaiting_approval' AND NEW.status IN ('completed', 'cancelled'))
)
BEGIN SELECT RAISE(ABORT, 'invalid pipeline stage status transition'); END;

CREATE TRIGGER pipeline_stage_run_assignment_once
BEFORE UPDATE OF assigned_agent_id, assigned_at ON pipeline_stage_run
WHEN (
  NEW.assigned_agent_id IS NOT OLD.assigned_agent_id
  OR NEW.assigned_at IS NOT OLD.assigned_at
) AND (
  OLD.assigned_agent_id IS NOT NULL
  OR NEW.assigned_agent_id IS NULL
  OR OLD.status <> 'active'
)
BEGIN SELECT RAISE(ABORT, 'pipeline stage assignment is immutable'); END;

CREATE TRIGGER pipeline_stage_run_approval_once
BEFORE UPDATE OF approved_by, approval_decision, approval_rationale, approved_at
ON pipeline_stage_run
WHEN (
  NEW.approved_by IS NOT OLD.approved_by
  OR NEW.approval_decision IS NOT OLD.approval_decision
  OR NEW.approval_rationale IS NOT OLD.approval_rationale
  OR NEW.approved_at IS NOT OLD.approved_at
) AND (
  OLD.approved_by IS NOT NULL
  OR NEW.approved_by IS NULL
  OR OLD.status <> 'awaiting_approval'
)
BEGIN SELECT RAISE(ABORT, 'pipeline stage approval is immutable'); END;

CREATE TABLE pipeline_override (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  pipeline_run_id TEXT NOT NULL,
  stage_run_id TEXT NOT NULL,
  actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  previous_rule TEXT NOT NULL CHECK (length(trim(previous_rule)) > 0),
  resulting_authorization TEXT NOT NULL CHECK (length(trim(resulting_authorization)) > 0),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, id),
  FOREIGN KEY(project_id, pipeline_run_id)
    REFERENCES pipeline_run(project_id, id),
  FOREIGN KEY(project_id, stage_run_id)
    REFERENCES pipeline_stage_run(project_id, id)
);

CREATE INDEX pipeline_override_run_idx
ON pipeline_override(project_id, pipeline_run_id, created_at, id);

CREATE TRIGGER pipeline_override_prevent_update BEFORE UPDATE ON pipeline_override
BEGIN SELECT RAISE(ABORT, 'pipeline overrides are immutable'); END;
CREATE TRIGGER pipeline_override_prevent_delete BEFORE DELETE ON pipeline_override
BEGIN SELECT RAISE(ABORT, 'pipeline overrides are append-only'); END;

ALTER TABLE agent_run ADD COLUMN pipeline_run_id TEXT REFERENCES pipeline_run(id);
ALTER TABLE action_requests ADD COLUMN pipeline_run_id TEXT REFERENCES pipeline_run(id);
ALTER TABLE action_requests ADD COLUMN pipeline_stage_run_id TEXT REFERENCES pipeline_stage_run(id);

CREATE TRIGGER agent_run_pipeline_binding_valid
BEFORE INSERT ON agent_run
WHEN NEW.pipeline_run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM pipeline_run pr
  JOIN pipeline_stage_run psr
    ON psr.pipeline_run_id = pr.id AND psr.project_id = pr.project_id
  WHERE pr.id = NEW.pipeline_run_id
    AND pr.project_id = NEW.project_id
    AND pr.task_id = NEW.task_id
    AND pr.status = 'active'
    AND psr.stage_index = pr.current_stage_index
    AND psr.status = 'active'
    AND psr.assigned_agent_id = NEW.agent_id
)
BEGIN SELECT RAISE(ABORT, 'agent run pipeline binding is not currently assigned'); END;

CREATE TRIGGER action_request_pipeline_binding_valid
BEFORE INSERT ON action_requests
WHEN
  (NEW.pipeline_run_id IS NULL) <> (NEW.pipeline_stage_run_id IS NULL)
  OR (
    NEW.pipeline_run_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pipeline_stage_run psr
      WHERE psr.id = NEW.pipeline_stage_run_id
        AND psr.pipeline_run_id = NEW.pipeline_run_id
        AND psr.project_id = NEW.project_id
    )
  )
BEGIN SELECT RAISE(ABORT, 'action request pipeline binding is inconsistent'); END;

CREATE TRIGGER agent_run_pipeline_binding_immutable
BEFORE UPDATE OF pipeline_run_id ON agent_run
WHEN NEW.pipeline_run_id IS NOT OLD.pipeline_run_id
BEGIN SELECT RAISE(ABORT, 'agent run pipeline binding is immutable'); END;

CREATE TRIGGER action_request_pipeline_binding_immutable
BEFORE UPDATE OF pipeline_run_id, pipeline_stage_run_id ON action_requests
WHEN NEW.pipeline_run_id IS NOT OLD.pipeline_run_id
  OR NEW.pipeline_stage_run_id IS NOT OLD.pipeline_stage_run_id
BEGIN SELECT RAISE(ABORT, 'action request pipeline binding is immutable'); END;
