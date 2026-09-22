-- PostgreSQL AgentRuntime and audit authority parity.
--
-- core.agent_run already exists as the governance review subject projection.
-- This migration extends that table in place. Rows containing only id and
-- project_id remain valid identity-only subjects; runtime repositories expose
-- only rows with a complete runtime shape.

CREATE TABLE core.role (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES core.project(id) ON DELETE CASCADE,
  role_key text NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  version integer NOT NULL CHECK (version > 0),
  capabilities_json jsonb NOT NULL CHECK (jsonb_typeof(capabilities_json) = 'array'),
  tools_json jsonb NOT NULL CHECK (jsonb_typeof(tools_json) = 'array'),
  model_policy text NOT NULL,
  limits_json jsonb NOT NULL CHECK (
    jsonb_typeof(limits_json) = 'object'
    AND jsonb_typeof(limits_json -> 'maxIterations') = 'number'
    AND (limits_json ->> 'maxIterations')::integer > 0
    AND jsonb_typeof(limits_json -> 'maxCostMicros') = 'string'
    AND (limits_json ->> 'maxCostMicros') ~ '^[0-9]{1,20}$'
    AND jsonb_typeof(limits_json -> 'timeoutSeconds') = 'number'
    AND (limits_json ->> 'timeoutSeconds')::integer > 0
  ),
  source_path text NOT NULL,
  guidance_text text NOT NULL DEFAULT '' CHECK (length(guidance_text) <= 65536),
  guidance_version integer NOT NULL DEFAULT 1 CHECK (guidance_version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (project_id, role_key),
  UNIQUE (id, project_id)
);

CREATE INDEX role_project_key_id_idx
ON core.role(project_id, role_key, id);

CREATE TABLE core.agent (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES core.project(id) ON DELETE CASCADE,
  role_id text NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (project_id, name),
  UNIQUE (id, project_id),
  CONSTRAINT agent_role_same_project_fk
    FOREIGN KEY (role_id, project_id)
    REFERENCES core.role(id, project_id)
);

CREATE INDEX agent_project_name_id_idx
ON core.agent(project_id, name, id);

-- Read-only pipeline authority projection required by WorkerAuthorityFence.
-- PipelineRunRepository parity is intentionally out of scope for this slice.
CREATE TABLE core.pipeline_run (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES core.project(id) ON DELETE CASCADE,
  task_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  current_stage_index integer NOT NULL CHECK (current_stage_index >= 0),
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (id, project_id),
  FOREIGN KEY (task_id, project_id)
    REFERENCES core.task(id, project_id)
);

CREATE UNIQUE INDEX pipeline_run_active_task_idx
ON core.pipeline_run(project_id, task_id)
WHERE status = 'active';

CREATE TABLE core.pipeline_stage_run (
  id text PRIMARY KEY,
  pipeline_run_id text NOT NULL,
  project_id text NOT NULL,
  stage_id text NOT NULL CHECK (length(trim(stage_id)) > 0),
  stage_index integer NOT NULL CHECK (stage_index >= 0),
  role_id text NOT NULL CHECK (length(trim(role_id)) > 0),
  status text NOT NULL CHECK (status IN ('pending', 'active', 'awaiting_approval', 'completed', 'cancelled')),
  assigned_agent_id text,
  UNIQUE (id, project_id),
  UNIQUE (pipeline_run_id, stage_index),
  UNIQUE (pipeline_run_id, stage_id),
  FOREIGN KEY (pipeline_run_id, project_id)
    REFERENCES core.pipeline_run(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_agent_id, project_id)
    REFERENCES core.agent(id, project_id)
);

CREATE INDEX pipeline_stage_assignment_idx
ON core.pipeline_stage_run(project_id, assigned_agent_id, status, id);

ALTER TABLE core.agent_run
  ADD COLUMN task_id text,
  ADD COLUMN agent_id text,
  ADD COLUMN action_intent_json jsonb,
  ADD COLUMN pipeline_run_id text,
  ADD COLUMN pipeline_stage_run_id text,
  ADD COLUMN status text,
  ADD COLUMN worktree_path text,
  ADD COLUMN result_json jsonb,
  ADD COLUMN error_json jsonb,
  ADD COLUMN created_at timestamptz,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN execution_json jsonb,
  ADD COLUMN model_routing_json jsonb,
  ADD COLUMN role_guidance_json jsonb;

ALTER TABLE core.agent_run
  ADD CONSTRAINT agent_run_runtime_shape CHECK (
    (status IS NULL AND task_id IS NULL AND agent_id IS NULL
      AND created_at IS NULL AND updated_at IS NULL)
    OR
    (status IN ('queued', 'preparing', 'running', 'reviewing', 'completed', 'failed', 'cancelled')
      AND task_id IS NOT NULL AND agent_id IS NOT NULL
      AND created_at IS NOT NULL AND updated_at IS NOT NULL)
  ),
  ADD CONSTRAINT agent_run_task_same_project_fk
    FOREIGN KEY (task_id, project_id)
    REFERENCES core.task(id, project_id),
  ADD CONSTRAINT agent_run_agent_same_project_fk
    FOREIGN KEY (agent_id, project_id)
    REFERENCES core.agent(id, project_id),
  ADD CONSTRAINT agent_run_pipeline_same_project_fk
    FOREIGN KEY (pipeline_run_id, project_id)
    REFERENCES core.pipeline_run(id, project_id),
  ADD CONSTRAINT agent_run_pipeline_stage_same_project_fk
    FOREIGN KEY (pipeline_stage_run_id, project_id)
    REFERENCES core.pipeline_stage_run(id, project_id),
  ADD CONSTRAINT agent_run_json_shape CHECK (
    (action_intent_json IS NULL OR jsonb_typeof(action_intent_json) = 'object')
    AND (result_json IS NULL OR jsonb_typeof(result_json) IS NOT NULL)
    AND (error_json IS NULL OR jsonb_typeof(error_json) IS NOT NULL)
    AND (execution_json IS NULL OR jsonb_typeof(execution_json) = 'object')
    AND (model_routing_json IS NULL OR jsonb_typeof(model_routing_json) = 'object')
    AND (role_guidance_json IS NULL OR jsonb_typeof(role_guidance_json) = 'object')
  );

CREATE INDEX agent_run_project_status_idx
ON core.agent_run(project_id, status, created_at, id);

CREATE INDEX agent_run_recovery_idx
ON core.agent_run(status, updated_at, id)
WHERE status IN ('preparing', 'running', 'reviewing');

CREATE OR REPLACE FUNCTION core.prevent_agent_run_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.action_intent_json IS DISTINCT FROM OLD.action_intent_json
     OR NEW.pipeline_run_id IS DISTINCT FROM OLD.pipeline_run_id
     OR NEW.pipeline_stage_run_id IS DISTINCT FROM OLD.pipeline_stage_run_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.model_routing_json IS DISTINCT FROM OLD.model_routing_json
     OR NEW.role_guidance_json IS DISTINCT FROM OLD.role_guidance_json THEN
    RAISE EXCEPTION 'agent run identity and admission inputs are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_run_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_run_identity_immutable
BEFORE UPDATE OF project_id, task_id, agent_id, action_intent_json,
  pipeline_run_id, pipeline_stage_run_id, created_at, model_routing_json,
  role_guidance_json ON core.agent_run
FOR EACH ROW EXECUTE FUNCTION core.prevent_agent_run_identity_mutation();

CREATE OR REPLACE FUNCTION core.enforce_agent_run_pipeline_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.pipeline_run_id IS NULL AND NEW.pipeline_stage_run_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.pipeline_run_id IS NULL OR NEW.pipeline_stage_run_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM core.pipeline_run AS pipeline
    JOIN core.pipeline_stage_run AS stage
      ON stage.pipeline_run_id = pipeline.id
     AND stage.project_id = pipeline.project_id
     AND stage.id = NEW.pipeline_stage_run_id
    JOIN core.agent AS agent
      ON agent.id = NEW.agent_id AND agent.project_id = NEW.project_id
    JOIN core.role AS role
      ON role.id = agent.role_id AND role.project_id = agent.project_id
    WHERE pipeline.id = NEW.pipeline_run_id
      AND pipeline.project_id = NEW.project_id
      AND pipeline.task_id = NEW.task_id
      AND pipeline.status = 'active'
      AND stage.stage_index = pipeline.current_stage_index
      AND stage.status = 'active'
      AND stage.assigned_agent_id = NEW.agent_id
      AND stage.role_id = role.role_key
  ) THEN
    RAISE EXCEPTION 'agent run pipeline binding is not currently assigned'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_run_pipeline_binding_valid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_run_pipeline_binding_valid
BEFORE INSERT OR UPDATE OF project_id, task_id, agent_id,
  pipeline_run_id, pipeline_stage_run_id ON core.agent_run
FOR EACH ROW EXECUTE FUNCTION core.enforce_agent_run_pipeline_binding();

CREATE OR REPLACE FUNCTION core.prevent_agent_run_execution_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.execution_json IS NOT NULL
     AND NEW.execution_json IS DISTINCT FROM OLD.execution_json THEN
    RAISE EXCEPTION 'agent run execution provenance is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_run_execution_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_run_execution_immutable
BEFORE UPDATE OF execution_json ON core.agent_run
FOR EACH ROW EXECUTE FUNCTION core.prevent_agent_run_execution_mutation();

CREATE TABLE core.task_lock (
  task_id text PRIMARY KEY,
  project_id text NOT NULL,
  run_id text NOT NULL UNIQUE,
  acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (task_id, project_id)
    REFERENCES core.task(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, project_id)
    REFERENCES core.agent_run(id, project_id) ON DELETE CASCADE
);

CREATE INDEX task_lock_expiry_idx
ON core.task_lock(expires_at, task_id);

CREATE TABLE core.agent_run_event (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id text NOT NULL UNIQUE,
  run_id text NOT NULL,
  project_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'preparing', 'running', 'reviewing', 'completed', 'failed', 'cancelled')),
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY (run_id, project_id)
    REFERENCES core.agent_run(id, project_id) ON DELETE CASCADE
);

CREATE INDEX agent_run_event_run_idx
ON core.agent_run_event(run_id, sequence);

CREATE OR REPLACE FUNCTION core.prevent_agent_run_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent_run_event is append-only'
    USING ERRCODE = '55000', CONSTRAINT = 'agent_run_event_append_only';
END;
$$;

CREATE TRIGGER agent_run_event_prevent_update
BEFORE UPDATE ON core.agent_run_event
FOR EACH ROW EXECUTE FUNCTION core.prevent_agent_run_event_mutation();

CREATE TRIGGER agent_run_event_prevent_delete
BEFORE DELETE ON core.agent_run_event
FOR EACH ROW EXECUTE FUNCTION core.prevent_agent_run_event_mutation();

CREATE TABLE core.audit_event (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id text NOT NULL UNIQUE,
  project_id text REFERENCES core.project(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (length(trim(event_type)) > 0),
  actor_type text NOT NULL CHECK (actor_type IN ('daemon', 'cli', 'system')),
  actor_id text,
  aggregate_type text,
  aggregate_id text,
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  occurred_at timestamptz NOT NULL
);

CREATE INDEX audit_event_occurred_at_idx
ON core.audit_event(occurred_at, id);

CREATE INDEX audit_event_project_occurred_at_idx
ON core.audit_event(project_id, occurred_at, id);

CREATE OR REPLACE FUNCTION core.prevent_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only'
    USING ERRCODE = '55000', CONSTRAINT = 'audit_event_append_only';
END;
$$;

CREATE TRIGGER audit_event_prevent_update
BEFORE UPDATE ON core.audit_event
FOR EACH ROW EXECUTE FUNCTION core.prevent_audit_event_mutation();

CREATE TRIGGER audit_event_prevent_delete
BEFORE DELETE ON core.audit_event
FOR EACH ROW EXECUTE FUNCTION core.prevent_audit_event_mutation();

COMMENT ON TABLE core.agent_run IS
  'Runtime-owned agent-run authority plus the pre-existing identity-only governance subject projection. Identity-only rows have NULL runtime fields.';

-- Human clients may inspect tenant-scoped projections, but all runtime, lock,
-- event, and audit mutations remain on the trusted Runtime/server-side path.
ALTER TABLE core.role ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.agent ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.pipeline_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.pipeline_stage_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.task_lock ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.agent_run_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.audit_event ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'role', 'agent', 'pipeline_run', 'pipeline_stage_run',
    'task_lock', 'agent_run_event', 'audit_event'
  ] LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON core.%I FROM PUBLIC', table_name);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon'
  ) THEN
    NULL;
  ELSE
    FOREACH table_name IN ARRAY ARRAY[
      'role', 'agent', 'pipeline_run', 'pipeline_stage_run',
      'task_lock', 'agent_run_event', 'audit_event'
    ] LOOP
      EXECUTE pg_catalog.format('REVOKE ALL ON core.%I FROM anon', table_name);
    END LOOP;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'
  ) THEN
    RETURN;
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'role', 'agent', 'pipeline_run', 'pipeline_stage_run',
    'task_lock', 'agent_run_event', 'audit_event'
  ] LOOP
    EXECUTE pg_catalog.format('GRANT SELECT ON core.%I TO authenticated', table_name);
  END LOOP;
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON core.agent_run FROM authenticated';
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON core.audit_event FROM authenticated';

  EXECUTE 'CREATE POLICY role_select_project_member ON core.role FOR SELECT TO authenticated USING (private.can_access_project(project_id))';
  EXECUTE 'CREATE POLICY agent_select_project_member ON core.agent FOR SELECT TO authenticated USING (private.can_access_project(project_id))';
  EXECUTE 'CREATE POLICY pipeline_run_select_project_member ON core.pipeline_run FOR SELECT TO authenticated USING (private.can_access_project(project_id))';
  EXECUTE 'CREATE POLICY pipeline_stage_select_project_member ON core.pipeline_stage_run FOR SELECT TO authenticated USING (private.can_access_project(project_id))';
  EXECUTE 'CREATE POLICY task_lock_select_project_member ON core.task_lock FOR SELECT TO authenticated USING (private.can_access_project(project_id))';
  EXECUTE 'CREATE POLICY agent_run_event_select_project_member ON core.agent_run_event FOR SELECT TO authenticated USING (private.can_access_project(project_id))';
  EXECUTE 'CREATE POLICY audit_event_select_project_member ON core.audit_event FOR SELECT TO authenticated USING (project_id IS NOT NULL AND private.can_access_project(project_id))';
END;
$$;
