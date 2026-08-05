CREATE UNIQUE INDEX milestone_project_id_unique
ON milestone(project_id, id);

CREATE TRIGGER requirement_milestone_ownership_insert
BEFORE INSERT ON requirement
WHEN NEW.milestone_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM milestone
  WHERE id = NEW.milestone_id AND project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'requirement milestone must belong to the same project'); END;

CREATE TRIGGER requirement_milestone_ownership_update
BEFORE UPDATE OF project_id, milestone_id ON requirement
WHEN NEW.milestone_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM milestone
  WHERE id = NEW.milestone_id AND project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'requirement milestone must belong to the same project'); END;

CREATE TABLE review_hardened (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('task', 'agent_run', 'requirement', 'adr', 'milestone')),
  subject_id TEXT NOT NULL,
  reviewer_actor_type TEXT NOT NULL CHECK (reviewer_actor_type IN ('user', 'agent', 'system')),
  reviewer_actor_id TEXT NOT NULL CHECK (length(trim(reviewer_actor_id)) > 0),
  reviewer_display_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  summary TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(project_id, id)
);

INSERT INTO review_hardened(
  id, project_id, subject_type, subject_id,
  reviewer_actor_type, reviewer_actor_id, reviewer_display_name,
  status, summary, created_at, completed_at
)
SELECT
  id, project_id, subject_type, subject_id,
  'user', reviewer, reviewer,
  CASE status WHEN 'changes_requested' THEN 'rejected' ELSE status END,
  summary, created_at, completed_at
FROM review;

CREATE TABLE approval_hardened (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  review_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
  display_name TEXT,
  rationale TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(review_id),
  FOREIGN KEY(project_id, review_id)
    REFERENCES review_hardened(project_id, id) ON DELETE CASCADE
);

INSERT INTO approval_hardened(
  id, project_id, review_id, decision,
  actor_type, actor_id, display_name, rationale, created_at
)
SELECT id, project_id, review_id, decision, 'user', actor, actor, rationale, created_at
FROM approval;

DROP TABLE approval;
DROP TABLE review;
ALTER TABLE review_hardened RENAME TO review;
ALTER TABLE approval_hardened RENAME TO approval;

CREATE INDEX review_project_idx ON review(project_id, status, created_at);

CREATE TRIGGER review_subject_valid_insert
BEFORE INSERT ON review
WHEN
  (NEW.subject_type = 'task' AND NOT EXISTS (SELECT 1 FROM task WHERE id=NEW.subject_id AND project_id=NEW.project_id))
  OR (NEW.subject_type = 'agent_run' AND NOT EXISTS (SELECT 1 FROM agent_run WHERE id=NEW.subject_id AND project_id=NEW.project_id))
  OR (NEW.subject_type = 'requirement' AND NOT EXISTS (SELECT 1 FROM requirement WHERE id=NEW.subject_id AND project_id=NEW.project_id))
  OR (NEW.subject_type = 'adr' AND NOT EXISTS (SELECT 1 FROM architecture_decision WHERE id=NEW.subject_id AND project_id=NEW.project_id))
  OR (NEW.subject_type = 'milestone' AND NOT EXISTS (SELECT 1 FROM milestone WHERE id=NEW.subject_id AND project_id=NEW.project_id))
BEGIN SELECT RAISE(ABORT, 'review subject does not exist in the same project'); END;

CREATE TRIGGER review_subject_valid_update
BEFORE UPDATE OF project_id, subject_type, subject_id ON review
WHEN
  (NEW.subject_type = 'task' AND NOT EXISTS (SELECT 1 FROM task WHERE id=NEW.subject_id AND project_id=NEW.project_id))
  OR (NEW.subject_type = 'agent_run' AND NOT EXISTS (SELECT 1 FROM agent_run WHERE id=NEW.subject_id AND project_id=NEW.project_id))
  OR (NEW.subject_type = 'requirement' AND NOT EXISTS (SELECT 1 FROM requirement WHERE id=NEW.subject_id AND project_id=NEW.project_id))
  OR (NEW.subject_type = 'adr' AND NOT EXISTS (SELECT 1 FROM architecture_decision WHERE id=NEW.subject_id AND project_id=NEW.project_id))
  OR (NEW.subject_type = 'milestone' AND NOT EXISTS (SELECT 1 FROM milestone WHERE id=NEW.subject_id AND project_id=NEW.project_id))
BEGIN SELECT RAISE(ABORT, 'review subject does not exist in the same project'); END;

CREATE TRIGGER approval_finalize_review
AFTER INSERT ON approval
BEGIN
  UPDATE review
  SET status = NEW.decision,
      completed_at = NEW.created_at
  WHERE id = NEW.review_id
    AND project_id = NEW.project_id
    AND status = 'pending';
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'review is already finalized') END;
END;

CREATE TRIGGER review_terminal_status_requires_decision
BEFORE UPDATE OF status ON review
WHEN NEW.status IN ('approved', 'rejected') AND NOT EXISTS (
  SELECT 1 FROM approval
  WHERE review_id = NEW.id
    AND project_id = NEW.project_id
    AND decision = NEW.status
)
BEGIN SELECT RAISE(ABORT, 'review status requires a matching decision'); END;

CREATE TRIGGER review_pending_status_forbids_decision
BEFORE UPDATE OF status ON review
WHEN NEW.status = 'pending' AND EXISTS (
  SELECT 1 FROM approval
  WHERE review_id = NEW.id AND project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'decided review cannot return to pending'); END;

CREATE TRIGGER approval_prevent_update
BEFORE UPDATE ON approval
BEGIN SELECT RAISE(ABORT, 'approval is append-only'); END;

CREATE TRIGGER approval_prevent_delete
BEFORE DELETE ON approval
BEGIN SELECT RAISE(ABORT, 'approval is append-only'); END;

CREATE TRIGGER adr_superseded_ownership_insert
BEFORE INSERT ON architecture_decision
WHEN NEW.superseded_by_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM architecture_decision
  WHERE id=NEW.superseded_by_id AND project_id=NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'superseding ADR must belong to the same project'); END;

CREATE TRIGGER adr_superseded_ownership_update
BEFORE UPDATE OF project_id, superseded_by_id ON architecture_decision
WHEN NEW.superseded_by_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM architecture_decision
  WHERE id=NEW.superseded_by_id AND project_id=NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'superseding ADR must belong to the same project'); END;

CREATE TABLE governance_event (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'milestone.created', 'milestone.status_changed',
    'requirement.created', 'requirement.status_changed',
    'adr.created', 'adr.status_changed',
    'review.created', 'review.decided'
  )),
  aggregate_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  occurred_at TEXT NOT NULL
);

CREATE INDEX governance_event_project_idx
ON governance_event(project_id, occurred_at, id);

CREATE TRIGGER governance_event_prevent_update
BEFORE UPDATE ON governance_event
BEGIN SELECT RAISE(ABORT, 'governance_event is append-only'); END;

CREATE TRIGGER governance_event_prevent_delete
BEFORE DELETE ON governance_event
BEGIN SELECT RAISE(ABORT, 'governance_event is append-only'); END;
