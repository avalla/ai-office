-- Office manifest and PipelineRun repository parity.
--
-- The previous runtime migration created a deliberately small pipeline
-- projection for worker fences. This migration evolves those same tables in
-- place; it does not create a second pipeline representation. Existing
-- projection-only rows remain readable by the worker fence and are allowed to
-- retain NULLs in the fields that did not exist yet. New repository rows must
-- satisfy the complete authoritative shape.

CREATE TABLE core.office_manifest_revision (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES core.project(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  manifest_json jsonb NOT NULL CHECK (
    jsonb_typeof(manifest_json) = 'object'
    AND jsonb_typeof(manifest_json -> 'schemaVersion') = 'number'
    AND (manifest_json ->> 'schemaVersion')::numeric = schema_version
  ),
  source_host text NOT NULL CHECK (length(trim(source_host)) > 0),
  source_skill text NOT NULL CHECK (source_skill = 'ai-office'),
  source_skill_version text NOT NULL CHECK (length(trim(source_skill_version)) > 0),
  applied_at timestamptz NOT NULL,
  UNIQUE (id, project_id),
  UNIQUE (project_id, revision),
  UNIQUE (id, project_id, revision),
  CHECK (manifest_json #>> '{provenance,host}' = source_host),
  CHECK (manifest_json #>> '{provenance,skill}' = source_skill),
  CHECK (manifest_json #>> '{provenance,skillVersion}' = source_skill_version)
);

CREATE INDEX office_manifest_project_revision_idx
ON core.office_manifest_revision(project_id, revision DESC);

CREATE OR REPLACE FUNCTION core.prevent_office_manifest_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'office manifest revisions are immutable'
    USING ERRCODE = '55000', CONSTRAINT = 'office_manifest_revision_immutable';
END;
$$;

CREATE TRIGGER office_manifest_revision_prevent_update
BEFORE UPDATE ON core.office_manifest_revision
FOR EACH ROW EXECUTE FUNCTION core.prevent_office_manifest_revision_mutation();

ALTER TABLE core.pipeline_run
  ADD COLUMN manifest_revision_id text,
  ADD COLUMN manifest_revision integer,
  ADD COLUMN definition_json jsonb,
  ADD COLUMN started_by text,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN cancelled_at timestamptz,
  ADD CONSTRAINT pipeline_run_manifest_same_project_fk
    FOREIGN KEY (manifest_revision_id, project_id, manifest_revision)
    REFERENCES core.office_manifest_revision(id, project_id, revision),
  ADD CONSTRAINT pipeline_run_authoritative_shape CHECK (
    (
      manifest_revision_id IS NULL
      AND manifest_revision IS NULL
      AND definition_json IS NULL
      AND started_by IS NULL
      AND completed_at IS NULL
      AND cancelled_at IS NULL
    )
    OR (
      manifest_revision_id IS NOT NULL
      AND manifest_revision IS NOT NULL
      AND manifest_revision > 0
      AND definition_json IS NOT NULL
      AND jsonb_typeof(definition_json) = 'object'
      AND started_by IS NOT NULL
      AND length(trim(started_by)) > 0
      AND (
        (status = 'active' AND completed_at IS NULL AND cancelled_at IS NULL)
        OR (status = 'completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL)
        OR (status = 'cancelled' AND completed_at IS NULL AND cancelled_at IS NOT NULL)
      )
    )
  );

ALTER TABLE core.pipeline_stage_run
  ADD COLUMN assigned_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN approved_by text,
  ADD COLUMN approval_decision text,
  ADD COLUMN approval_rationale text,
  ADD COLUMN approved_at timestamptz,
  ADD CONSTRAINT pipeline_stage_run_approval_decision_check
    CHECK (approval_decision IS NULL OR approval_decision IN ('approved', 'rejected')),
  ADD CONSTRAINT pipeline_stage_run_assignment_shape_check
    CHECK (assigned_at IS NULL OR assigned_agent_id IS NOT NULL),
  ADD CONSTRAINT pipeline_stage_run_approval_shape_check
    CHECK (
      (approved_by IS NULL) = (approved_at IS NULL)
      AND (approved_by IS NULL) = (approval_decision IS NULL)
      AND (approval_rationale IS NULL OR approved_by IS NOT NULL)
    ),
  ADD CONSTRAINT pipeline_stage_run_completion_shape_check
    CHECK (completed_at IS NULL OR status = 'completed');

ALTER TABLE core.pipeline_stage_run
  ADD CONSTRAINT pipeline_stage_run_run_id_id_project_key
    UNIQUE (pipeline_run_id, id, project_id);

CREATE UNIQUE INDEX pipeline_stage_run_one_active_idx
ON core.pipeline_stage_run(pipeline_run_id)
WHERE status IN ('active', 'awaiting_approval');

CREATE OR REPLACE FUNCTION core.prevent_pipeline_run_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.manifest_revision_id IS DISTINCT FROM OLD.manifest_revision_id
     OR NEW.manifest_revision IS DISTINCT FROM OLD.manifest_revision
     OR NEW.definition_json IS DISTINCT FROM OLD.definition_json
     OR NEW.started_by IS DISTINCT FROM OLD.started_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'pipeline run identity and pinned inputs are immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'pipeline_run_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pipeline_run_identity_immutable
BEFORE UPDATE OF id, project_id, task_id, manifest_revision_id,
  manifest_revision, definition_json, started_by, created_at
ON core.pipeline_run
FOR EACH ROW EXECUTE FUNCTION core.prevent_pipeline_run_identity_mutation();

CREATE OR REPLACE FUNCTION core.enforce_pipeline_run_version_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'invalid pipeline run version transition'
      USING ERRCODE = '23514', CONSTRAINT = 'pipeline_run_version_transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pipeline_run_version_transition
BEFORE UPDATE ON core.pipeline_run
FOR EACH ROW EXECUTE FUNCTION core.enforce_pipeline_run_version_transition();

CREATE OR REPLACE FUNCTION core.enforce_pipeline_run_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND OLD.manifest_revision_id IS NOT NULL
     AND NOT (
       OLD.status = 'active'
       AND NEW.status IN ('completed', 'cancelled')
     ) THEN
    RAISE EXCEPTION 'invalid pipeline run status transition'
      USING ERRCODE = '55000', CONSTRAINT = 'pipeline_run_status_transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pipeline_run_status_transition
BEFORE UPDATE OF status ON core.pipeline_run
FOR EACH ROW EXECUTE FUNCTION core.enforce_pipeline_run_status_transition();

CREATE OR REPLACE FUNCTION core.prevent_pipeline_stage_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.pipeline_run_id IS DISTINCT FROM OLD.pipeline_run_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.stage_id IS DISTINCT FROM OLD.stage_id
     OR NEW.stage_index IS DISTINCT FROM OLD.stage_index
     OR NEW.role_id IS DISTINCT FROM OLD.role_id THEN
    RAISE EXCEPTION 'pipeline stage identity is immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'pipeline_stage_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pipeline_stage_run_identity_immutable
BEFORE UPDATE OF id, pipeline_run_id, project_id, stage_id, stage_index, role_id
ON core.pipeline_stage_run
FOR EACH ROW EXECUTE FUNCTION core.prevent_pipeline_stage_identity_mutation();

CREATE OR REPLACE FUNCTION core.enforce_pipeline_stage_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND EXISTS (
       SELECT 1
       FROM core.pipeline_run AS pipeline
       WHERE pipeline.id = NEW.pipeline_run_id
         AND pipeline.project_id = NEW.project_id
         AND pipeline.manifest_revision_id IS NOT NULL
     )
     AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('active', 'cancelled'))
       OR (OLD.status = 'active' AND NEW.status IN (
         'awaiting_approval', 'completed', 'cancelled'
       ))
       OR (OLD.status = 'awaiting_approval' AND NEW.status IN (
         'completed', 'cancelled'
       ))
     ) THEN
    RAISE EXCEPTION 'invalid pipeline stage status transition'
      USING ERRCODE = '55000', CONSTRAINT = 'pipeline_stage_run_status_transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pipeline_stage_run_status_transition
BEFORE UPDATE OF status ON core.pipeline_stage_run
FOR EACH ROW EXECUTE FUNCTION core.enforce_pipeline_stage_status_transition();

CREATE OR REPLACE FUNCTION core.enforce_pipeline_stage_assignment_once()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id
    OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
  )
  AND EXISTS (
    SELECT 1
    FROM core.pipeline_run AS pipeline
    WHERE pipeline.id = NEW.pipeline_run_id
      AND pipeline.project_id = NEW.project_id
      AND pipeline.manifest_revision_id IS NOT NULL
  )
  AND (
    OLD.assigned_agent_id IS NOT NULL
    OR NEW.assigned_agent_id IS NULL
    OR OLD.status <> 'active'
  ) THEN
    RAISE EXCEPTION 'pipeline stage assignment is immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'pipeline_stage_run_assignment_once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pipeline_stage_run_assignment_once
BEFORE UPDATE OF assigned_agent_id, assigned_at ON core.pipeline_stage_run
FOR EACH ROW EXECUTE FUNCTION core.enforce_pipeline_stage_assignment_once();

CREATE OR REPLACE FUNCTION core.enforce_pipeline_stage_approval_once()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW.approved_by IS DISTINCT FROM OLD.approved_by
    OR NEW.approval_decision IS DISTINCT FROM OLD.approval_decision
    OR NEW.approval_rationale IS DISTINCT FROM OLD.approval_rationale
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
  )
  AND EXISTS (
    SELECT 1
    FROM core.pipeline_run AS pipeline
    WHERE pipeline.id = NEW.pipeline_run_id
      AND pipeline.project_id = NEW.project_id
      AND pipeline.manifest_revision_id IS NOT NULL
  )
  AND (
    OLD.approved_by IS NOT NULL
    OR NEW.approved_by IS NULL
    OR OLD.status <> 'awaiting_approval'
  ) THEN
    RAISE EXCEPTION 'pipeline stage approval is immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'pipeline_stage_run_approval_once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pipeline_stage_run_approval_once
BEFORE UPDATE OF approved_by, approval_decision, approval_rationale, approved_at
ON core.pipeline_stage_run
FOR EACH ROW EXECUTE FUNCTION core.enforce_pipeline_stage_approval_once();

CREATE OR REPLACE FUNCTION core.enforce_pipeline_stage_authoritative_shape()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM core.pipeline_run AS pipeline
    WHERE pipeline.id = NEW.pipeline_run_id
      AND pipeline.project_id = NEW.project_id
      AND pipeline.manifest_revision_id IS NOT NULL
  ) THEN
    IF (NEW.assigned_agent_id IS NULL) <> (NEW.assigned_at IS NULL)
       OR (NEW.approved_by IS NULL) <> (NEW.approved_at IS NULL)
       OR (NEW.approved_by IS NULL) <> (NEW.approval_decision IS NULL)
       OR (NEW.approval_rationale IS NOT NULL AND NEW.approved_by IS NULL)
       OR ((NEW.status = 'completed') <> (NEW.completed_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'authoritative pipeline stage fields are inconsistent'
        USING ERRCODE = '23514', CONSTRAINT = 'pipeline_stage_authoritative_shape';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pipeline_stage_run_authoritative_shape
BEFORE INSERT OR UPDATE ON core.pipeline_stage_run
FOR EACH ROW EXECUTE FUNCTION core.enforce_pipeline_stage_authoritative_shape();

CREATE TABLE core.pipeline_override (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  pipeline_run_id text NOT NULL,
  stage_run_id text NOT NULL,
  actor_id text NOT NULL CHECK (length(trim(actor_id)) > 0),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  previous_rule text NOT NULL CHECK (length(trim(previous_rule)) > 0),
  resulting_authorization text NOT NULL CHECK (length(trim(resulting_authorization)) > 0),
  created_at timestamptz NOT NULL,
  UNIQUE (id, project_id),
  FOREIGN KEY (pipeline_run_id, project_id)
    REFERENCES core.pipeline_run(id, project_id),
  FOREIGN KEY (pipeline_run_id, stage_run_id, project_id)
    REFERENCES core.pipeline_stage_run(pipeline_run_id, id, project_id)
);

CREATE INDEX pipeline_override_run_idx
ON core.pipeline_override(project_id, pipeline_run_id, created_at, id);

CREATE OR REPLACE FUNCTION core.prevent_pipeline_override_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'pipeline overrides are append-only'
    USING ERRCODE = '55000', CONSTRAINT = 'pipeline_override_append_only';
END;
$$;

CREATE TRIGGER pipeline_override_prevent_update
BEFORE UPDATE ON core.pipeline_override
FOR EACH ROW EXECUTE FUNCTION core.prevent_pipeline_override_mutation();

CREATE TRIGGER pipeline_override_prevent_delete
BEFORE DELETE ON core.pipeline_override
FOR EACH ROW EXECUTE FUNCTION core.prevent_pipeline_override_mutation();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'office_manifest_revision', 'pipeline_run', 'pipeline_stage_run',
    'pipeline_override'
  ] LOOP
    EXECUTE pg_catalog.format(
      'CREATE TRIGGER %I BEFORE UPDATE OF project_id ON core.%I FOR EACH ROW EXECUTE FUNCTION core.enforce_project_tenant_reparenting()',
      table_name || '_project_tenant_reparenting', table_name
    );
  END LOOP;
END;
$$;

ALTER TABLE core.office_manifest_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.pipeline_override ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    RETURN;
  END IF;

  GRANT SELECT ON core.office_manifest_revision TO authenticated;
  GRANT SELECT ON core.pipeline_override TO authenticated;

  CREATE POLICY office_manifest_revision_select_project_member
    ON core.office_manifest_revision FOR SELECT TO authenticated
    USING (private.can_access_project(project_id));

  CREATE POLICY pipeline_override_select_project_member
    ON core.pipeline_override FOR SELECT TO authenticated
    USING (private.can_access_project(project_id));
END;
$$;

COMMENT ON TABLE core.office_manifest_revision IS
  'Immutable, tenant-scoped office manifest revisions used as pipeline inputs.';
COMMENT ON TABLE core.pipeline_run IS
  'PipelineRun authority; legacy projection-only rows have NULL pinned fields and are not aggregate reads.';
COMMENT ON TABLE core.pipeline_stage_run IS
  'Pipeline stage authority owned by one pipeline run and project.';
COMMENT ON TABLE core.pipeline_override IS
  'Append-only, exact-stage pipeline authorization overrides.';
