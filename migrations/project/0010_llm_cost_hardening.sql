ALTER TABLE budget_reservation ADD COLUMN expires_at TEXT;
UPDATE budget_reservation SET expires_at = created_at WHERE expires_at IS NULL;

ALTER TABLE cost_event ADD COLUMN reserved_micros INTEGER NOT NULL DEFAULT 0
CHECK (reserved_micros >= 0);
ALTER TABLE cost_event ADD COLUMN overage_micros INTEGER NOT NULL DEFAULT 0
CHECK (overage_micros >= 0);

CREATE INDEX budget_reservation_expiry_idx
ON budget_reservation(status, expires_at, budget_id);

CREATE INDEX model_usage_task_cost_idx ON model_usage(project_id, task_id, occurred_at);
CREATE INDEX model_usage_agent_cost_idx ON model_usage(project_id, agent_id, occurred_at);
CREATE INDEX model_usage_run_cost_idx ON model_usage(project_id, agent_run_id, occurred_at);

CREATE TRIGGER pricing_version_no_overlap_insert
BEFORE INSERT ON pricing_version
WHEN EXISTS (
  SELECT 1 FROM pricing_version p
  WHERE p.provider = NEW.provider
    AND p.model = NEW.model
    AND p.currency = NEW.currency
    AND COALESCE(p.effective_to, '9999-12-31T23:59:59.999Z') > NEW.effective_from
    AND COALESCE(NEW.effective_to, '9999-12-31T23:59:59.999Z') > p.effective_from
)
BEGIN SELECT RAISE(ABORT, 'pricing interval overlaps an existing version'); END;

CREATE TRIGGER pricing_version_no_overlap_update
BEFORE UPDATE OF provider, model, currency, effective_from, effective_to ON pricing_version
WHEN EXISTS (
  SELECT 1 FROM pricing_version p
  WHERE p.id <> NEW.id
    AND p.provider = NEW.provider
    AND p.model = NEW.model
    AND p.currency = NEW.currency
    AND COALESCE(p.effective_to, '9999-12-31T23:59:59.999Z') > NEW.effective_from
    AND COALESCE(NEW.effective_to, '9999-12-31T23:59:59.999Z') > p.effective_from
)
BEGIN SELECT RAISE(ABORT, 'pricing interval overlaps an existing version'); END;

CREATE TRIGGER budget_scope_valid_insert
BEFORE INSERT ON budget
WHEN NEW.scope_type = 'milestone'
  OR (NEW.scope_type = 'project' AND NEW.scope_id <> NEW.project_id)
  OR (NEW.scope_type = 'task' AND NOT EXISTS (SELECT 1 FROM task WHERE id=NEW.scope_id AND project_id=NEW.project_id))
  OR (NEW.scope_type = 'agent' AND NOT EXISTS (SELECT 1 FROM agent WHERE id=NEW.scope_id AND project_id=NEW.project_id))
  OR (NEW.scope_type = 'agent_run' AND NOT EXISTS (SELECT 1 FROM agent_run WHERE id=NEW.scope_id AND project_id=NEW.project_id))
BEGIN SELECT RAISE(ABORT, 'invalid or cross-project budget scope'); END;

CREATE TRIGGER budget_scope_valid_update
BEFORE UPDATE OF project_id, scope_type, scope_id ON budget
WHEN NEW.scope_type = 'milestone'
  OR (NEW.scope_type = 'project' AND NEW.scope_id <> NEW.project_id)
  OR (NEW.scope_type = 'task' AND NOT EXISTS (SELECT 1 FROM task WHERE id=NEW.scope_id AND project_id=NEW.project_id))
  OR (NEW.scope_type = 'agent' AND NOT EXISTS (SELECT 1 FROM agent WHERE id=NEW.scope_id AND project_id=NEW.project_id))
  OR (NEW.scope_type = 'agent_run' AND NOT EXISTS (SELECT 1 FROM agent_run WHERE id=NEW.scope_id AND project_id=NEW.project_id))
BEGIN SELECT RAISE(ABORT, 'invalid or cross-project budget scope'); END;

CREATE TRIGGER model_usage_ownership_insert
BEFORE INSERT ON model_usage
WHEN (NEW.task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task WHERE id=NEW.task_id AND project_id=NEW.project_id))
  OR (NEW.agent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent WHERE id=NEW.agent_id AND project_id=NEW.project_id))
  OR (NEW.agent_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_run WHERE id=NEW.agent_run_id AND project_id=NEW.project_id))
BEGIN SELECT RAISE(ABORT, 'model usage references must belong to the same project'); END;

CREATE TRIGGER model_usage_ownership_update
BEFORE UPDATE OF project_id, task_id, agent_id, agent_run_id ON model_usage
WHEN (NEW.task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task WHERE id=NEW.task_id AND project_id=NEW.project_id))
  OR (NEW.agent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent WHERE id=NEW.agent_id AND project_id=NEW.project_id))
  OR (NEW.agent_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_run WHERE id=NEW.agent_run_id AND project_id=NEW.project_id))
BEGIN SELECT RAISE(ABORT, 'model usage references must belong to the same project'); END;

CREATE TRIGGER budget_reservation_expiry_required_insert
BEFORE INSERT ON budget_reservation
WHEN NEW.expires_at IS NULL
BEGIN SELECT RAISE(ABORT, 'budget reservation expiry is required'); END;

CREATE TRIGGER budget_reservation_expiry_required_update
BEFORE UPDATE OF expires_at ON budget_reservation
WHEN NEW.expires_at IS NULL
BEGIN SELECT RAISE(ABORT, 'budget reservation expiry is required'); END;

CREATE TRIGGER model_usage_provider_request_unique
BEFORE INSERT ON model_usage
WHEN NEW.provider_request_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM model_usage
  WHERE provider=NEW.provider AND provider_request_id=NEW.provider_request_id
)
BEGIN SELECT RAISE(ABORT, 'duplicate provider usage'); END;
