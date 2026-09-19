-- PostgreSQL governance authority parity.
--
-- This migration extends the linkage-support requirement table created by the
-- foundation migration. The agent_run subject table is intentionally only the
-- identity/ownership projection needed by GovernanceRepository; a future
-- agent-runtime migration must extend this table rather than create a second
-- authority. The agent runtime repository remains a later storage slice.

CREATE TABLE core.milestone (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES core.project(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(trim(title)) > 0),
  description text,
  status text NOT NULL CHECK (
    status IN ('planned', 'active', 'completed', 'cancelled')
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (id, project_id)
);

CREATE INDEX milestone_project_status_created_id_idx
ON core.milestone(project_id, status, created_at, id);

ALTER TABLE core.requirement
  ADD COLUMN milestone_id text;

ALTER TABLE core.requirement
  RENAME CONSTRAINT requirement_project_id_requirement_key_key
  TO requirement_project_key_unique;

ALTER TABLE core.requirement
  ADD CONSTRAINT requirement_milestone_fk
  FOREIGN KEY (milestone_id, project_id)
  REFERENCES core.milestone(id, project_id)
  ON DELETE SET NULL (milestone_id);

CREATE INDEX requirement_project_status_key_id_idx
ON core.requirement(project_id, status, requirement_key, id);

CREATE TABLE core.architecture_decision (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES core.project(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(trim(title)) > 0),
  context text NOT NULL,
  decision text NOT NULL,
  consequences text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('proposed', 'accepted', 'rejected', 'deprecated', 'superseded')
  ),
  superseded_by_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (id, project_id),
  CONSTRAINT adr_superseded_by_same_project_fk
    FOREIGN KEY (superseded_by_id, project_id)
    REFERENCES core.architecture_decision(id, project_id)
);

CREATE INDEX adr_project_status_created_id_idx
ON core.architecture_decision(project_id, status, created_at, id);

-- Governance subject ownership needs the existing SQLite subject set. This
-- identity-only table is not an AgentRuntimeRepository implementation; it is
-- the future runtime slice's ownership anchor for governance reviews.
CREATE TABLE core.agent_run (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES core.project(id) ON DELETE CASCADE,
  UNIQUE (id, project_id)
);

CREATE TABLE core.review (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES core.project(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (
    subject_type IN ('task', 'agent_run', 'requirement', 'adr', 'milestone')
  ),
  subject_id text NOT NULL,
  reviewer_actor_type text NOT NULL CHECK (
    reviewer_actor_type IN ('user', 'agent', 'system')
  ),
  reviewer_actor_id text NOT NULL CHECK (length(trim(reviewer_actor_id)) > 0),
  reviewer_display_name text,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  summary text,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (id, project_id)
);

CREATE INDEX review_project_status_created_id_idx
ON core.review(project_id, status, created_at, id);

CREATE TABLE core.approval (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES core.project(id) ON DELETE CASCADE,
  review_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id text NOT NULL CHECK (length(trim(actor_id)) > 0),
  display_name text,
  rationale text,
  created_at timestamptz NOT NULL,
  UNIQUE (review_id),
  CONSTRAINT approval_review_same_project_fk
    FOREIGN KEY (review_id, project_id)
    REFERENCES core.review(id, project_id) ON DELETE CASCADE
);

CREATE INDEX approval_project_created_id_idx
ON core.approval(project_id, created_at, id);

CREATE TABLE core.governance_event (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id text NOT NULL UNIQUE,
  project_id text NOT NULL REFERENCES core.project(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (
    event_type IN (
      'milestone.created', 'milestone.status_changed',
      'requirement.created', 'requirement.status_changed',
      'adr.created', 'adr.status_changed',
      'review.created', 'review.decided'
    )
  ),
  aggregate_id text NOT NULL,
  metadata_json jsonb NOT NULL CHECK (jsonb_typeof(metadata_json) = 'object'),
  occurred_at timestamptz NOT NULL
);

CREATE INDEX governance_event_project_sequence_idx
ON core.governance_event(project_id, sequence);

CREATE OR REPLACE FUNCTION core.enforce_requirement_milestone_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.milestone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM core.milestone
    WHERE id = NEW.milestone_id AND project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'requirement milestone must belong to the same project'
      USING ERRCODE = '23514', CONSTRAINT = 'requirement_milestone_same_project';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER requirement_milestone_ownership
BEFORE INSERT OR UPDATE OF project_id, milestone_id ON core.requirement
FOR EACH ROW EXECUTE FUNCTION core.enforce_requirement_milestone_ownership();

CREATE OR REPLACE FUNCTION core.enforce_review_subject_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  subject_exists boolean;
BEGIN
  subject_exists := CASE NEW.subject_type
    WHEN 'task' THEN EXISTS (
      SELECT 1 FROM core.task
      WHERE id = NEW.subject_id AND project_id = NEW.project_id
      FOR UPDATE
    )
    WHEN 'agent_run' THEN EXISTS (
      SELECT 1 FROM core.agent_run
      WHERE id = NEW.subject_id AND project_id = NEW.project_id
      FOR UPDATE
    )
    WHEN 'requirement' THEN EXISTS (
      SELECT 1 FROM core.requirement
      WHERE id = NEW.subject_id AND project_id = NEW.project_id
      FOR UPDATE
    )
    WHEN 'adr' THEN EXISTS (
      SELECT 1 FROM core.architecture_decision
      WHERE id = NEW.subject_id AND project_id = NEW.project_id
      FOR UPDATE
    )
    WHEN 'milestone' THEN EXISTS (
      SELECT 1 FROM core.milestone
      WHERE id = NEW.subject_id AND project_id = NEW.project_id
    )
    ELSE false
  END;

  IF NOT subject_exists THEN
    RAISE EXCEPTION 'review subject does not exist in the same project'
      USING ERRCODE = '23514', CONSTRAINT = 'review_subject_same_project';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER review_subject_ownership
BEFORE INSERT OR UPDATE OF project_id, subject_type, subject_id ON core.review
FOR EACH ROW EXECUTE FUNCTION core.enforce_review_subject_ownership();

CREATE OR REPLACE FUNCTION core.prevent_review_subject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_subject_type text;
BEGIN
  expected_subject_type := CASE TG_TABLE_NAME
    WHEN 'architecture_decision' THEN 'adr'
    ELSE TG_TABLE_NAME
  END;

  IF TG_OP = 'UPDATE'
     AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM core.review AS existing_review
    WHERE existing_review.subject_type = expected_subject_type
      AND existing_review.subject_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'review subject ownership is immutable after review'
      USING ERRCODE = '23514', CONSTRAINT = 'review_subject_ownership_immutable';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER task_review_subject_project_immutable
BEFORE UPDATE OF project_id ON core.task
FOR EACH ROW EXECUTE FUNCTION core.prevent_review_subject_mutation();

CREATE TRIGGER task_review_subject_delete_guard
BEFORE DELETE ON core.task
FOR EACH ROW EXECUTE FUNCTION core.prevent_review_subject_mutation();

CREATE TRIGGER agent_run_review_subject_project_immutable
BEFORE UPDATE OF project_id ON core.agent_run
FOR EACH ROW EXECUTE FUNCTION core.prevent_review_subject_mutation();

CREATE TRIGGER agent_run_review_subject_delete_guard
BEFORE DELETE ON core.agent_run
FOR EACH ROW EXECUTE FUNCTION core.prevent_review_subject_mutation();

CREATE TRIGGER requirement_review_subject_project_immutable
BEFORE UPDATE OF project_id ON core.requirement
FOR EACH ROW EXECUTE FUNCTION core.prevent_review_subject_mutation();

CREATE TRIGGER requirement_review_subject_delete_guard
BEFORE DELETE ON core.requirement
FOR EACH ROW EXECUTE FUNCTION core.prevent_review_subject_mutation();

CREATE TRIGGER adr_review_subject_project_immutable
BEFORE UPDATE OF project_id ON core.architecture_decision
FOR EACH ROW EXECUTE FUNCTION core.prevent_review_subject_mutation();

CREATE TRIGGER adr_review_subject_delete_guard
BEFORE DELETE ON core.architecture_decision
FOR EACH ROW EXECUTE FUNCTION core.prevent_review_subject_mutation();

CREATE TRIGGER milestone_review_subject_project_immutable
BEFORE UPDATE OF project_id ON core.milestone
FOR EACH ROW EXECUTE FUNCTION core.prevent_review_subject_mutation();

CREATE TRIGGER milestone_review_subject_delete_guard
BEFORE DELETE ON core.milestone
FOR EACH ROW EXECUTE FUNCTION core.prevent_review_subject_mutation();

CREATE OR REPLACE FUNCTION core.finalize_review_from_approval()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE core.review
  SET status = NEW.decision,
      completed_at = NEW.created_at
  WHERE id = NEW.review_id
    AND project_id = NEW.project_id
    AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'review is already finalized'
      USING ERRCODE = '23514', CONSTRAINT = 'review_approval_pending';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER approval_finalize_review
AFTER INSERT ON core.approval
FOR EACH ROW EXECUTE FUNCTION core.finalize_review_from_approval();

CREATE OR REPLACE FUNCTION core.enforce_review_terminal_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'new review must be pending without completion'
        USING ERRCODE = '23514', CONSTRAINT = 'review_initial_pending';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'pending' THEN
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'decided review cannot return to pending'
        USING ERRCODE = '23514', CONSTRAINT = 'review_pending_after_approval';
    END IF;
    IF NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'pending review cannot have completed_at'
        USING ERRCODE = '23514', CONSTRAINT = 'review_pending_completed_at';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'pending' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'terminal review decision is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'review_terminal_decision_immutable';
  END IF;

  IF NEW.completed_at IS NULL OR NOT EXISTS (
    SELECT 1
    FROM core.approval
    WHERE review_id = NEW.id
      AND project_id = NEW.project_id
      AND decision = NEW.status
      AND created_at = NEW.completed_at
  ) THEN
    RAISE EXCEPTION 'review terminal state requires its matching approval'
      USING ERRCODE = '23514', CONSTRAINT = 'review_status_requires_approval';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER review_terminal_status_requires_approval
BEFORE INSERT OR UPDATE OF status, completed_at ON core.review
FOR EACH ROW EXECUTE FUNCTION core.enforce_review_terminal_status();

CREATE OR REPLACE FUNCTION core.prevent_approval_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'approval is append-only'
    USING ERRCODE = '55000', CONSTRAINT = 'approval_append_only';
END;
$$;

CREATE TRIGGER approval_prevent_update
BEFORE UPDATE ON core.approval
FOR EACH ROW EXECUTE FUNCTION core.prevent_approval_mutation();

CREATE TRIGGER approval_prevent_delete
BEFORE DELETE ON core.approval
FOR EACH ROW EXECUTE FUNCTION core.prevent_approval_mutation();

CREATE OR REPLACE FUNCTION core.prevent_governance_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'governance_event is append-only'
    USING ERRCODE = '55000', CONSTRAINT = 'governance_event_append_only';
END;
$$;

CREATE TRIGGER governance_event_prevent_update
BEFORE UPDATE ON core.governance_event
FOR EACH ROW EXECUTE FUNCTION core.prevent_governance_event_mutation();

CREATE TRIGGER governance_event_prevent_delete
BEFORE DELETE ON core.governance_event
FOR EACH ROW EXECUTE FUNCTION core.prevent_governance_event_mutation();
