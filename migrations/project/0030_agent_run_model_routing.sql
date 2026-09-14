-- Immutable model routing snapshot for each AgentRun.
--
-- New runs record either {"status":"unrouted"} (the Runtime had no model
-- routing configured) or {"status":"resolved","selection":{...}} with the
-- non-secret concrete model chosen at scheduling. Runs that existed before this
-- migration keep NULL: their model was never recorded, and it is not
-- reconstructed from current role or host configuration.
ALTER TABLE agent_run ADD COLUMN model_routing_json TEXT
  CHECK (model_routing_json IS NULL OR (
    json_valid(model_routing_json)
    AND json_type(model_routing_json) = 'object'
    AND json_extract(model_routing_json, '$.status') IN ('unrouted', 'resolved')
    AND (json_extract(model_routing_json, '$.status') = 'unrouted')
      = (json_type(model_routing_json, '$.selection') IS NULL)
  ));

-- The routing record is written once, when the run row is inserted. No later
-- lifecycle write, backfill or repair may add, change or remove it.
CREATE TRIGGER agent_run_model_routing_immutable
BEFORE UPDATE OF model_routing_json ON agent_run
WHEN NEW.model_routing_json IS NOT OLD.model_routing_json
BEGIN SELECT RAISE(ABORT, 'agent run model routing is immutable'); END;
