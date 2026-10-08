-- Preserve the completed outcome and existing milestone relationships.
ALTER TABLE milestone ADD COLUMN archived_at TEXT
  CHECK (archived_at IS NULL OR status = 'completed');
