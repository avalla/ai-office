-- PostgreSQL governance authority parity.
--
-- This migration extends the linkage-support requirement table created by the
-- foundation migration. The agent_run subject table is intentionally only the
-- identity/ownership projection needed by GovernanceRepository; the agent
-- runtime repository remains a later storage slice.

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
  FOREIGN KEY (milestone_id) REFERENCES core.milestone(id) ON DELETE SET NULL;

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
    )
    WHEN 'agent_run' THEN EXISTS (
      SELECT 1 FROM core.agent_run
      WHERE id = NEW.subject_id AND project_id = NEW.project_id
    )
    WHEN 'requirement' THEN EXISTS (
      SELECT 1 FROM core.requirement
      WHERE id = NEW.subject_id AND project_id = NEW.project_id
    )
    WHEN 'adr' THEN EXISTS (
      SELECT 1 FROM core.architecture_decision
      WHERE id = NEW.subject_id AND project_id = NEW.project_id
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
  IF NEW.status IN ('approved', 'rejected') AND NOT EXISTS (
    SELECT 1
    FROM core.approval
    WHERE review_id = NEW.id
      AND project_id = NEW.project_id
      AND decision = NEW.status
  ) THEN
    RAISE EXCEPTION 'review status requires a matching decision'
      USING ERRCODE = '23514', CONSTRAINT = 'review_status_requires_approval';
  END IF;

  IF NEW.status = 'pending' AND EXISTS (
    SELECT 1
    FROM core.approval
    WHERE review_id = NEW.id AND project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'decided review cannot return to pending'
      USING ERRCODE = '23514', CONSTRAINT = 'review_pending_after_approval';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER review_terminal_status_requires_approval
BEFORE UPDATE OF status ON core.review
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
