ALTER TABLE agent_run ADD COLUMN execution_json TEXT
  CHECK (execution_json IS NULL OR (
    json_valid(execution_json) AND json_type(execution_json) = 'object'
  ));

-- Historical runs remain unknown. A dispatch may establish provenance once;
-- subsequent lifecycle writes preserve that exact evidence.
CREATE TRIGGER agent_run_execution_immutable
BEFORE UPDATE OF execution_json ON agent_run
WHEN OLD.execution_json IS NOT NULL AND NEW.execution_json IS NOT OLD.execution_json
BEGIN SELECT RAISE(ABORT, 'agent run execution provenance is immutable'); END;
