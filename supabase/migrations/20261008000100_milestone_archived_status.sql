ALTER TABLE core.milestone ADD COLUMN archived_at timestamptz;
ALTER TABLE core.milestone ADD CONSTRAINT milestone_archived_completed_check
  CHECK (archived_at IS NULL OR status = 'completed');
