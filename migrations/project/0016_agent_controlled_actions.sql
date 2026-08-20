ALTER TABLE agent_run ADD COLUMN action_intent_json TEXT
CHECK (
  action_intent_json IS NULL OR (
    json_valid(action_intent_json)
    AND json_type(action_intent_json) = 'object'
    AND json_type(action_intent_json, '$.resourceId') = 'text'
    AND length(trim(json_extract(action_intent_json, '$.resourceId'))) > 0
    AND json_type(action_intent_json, '$.operation') = 'text'
    AND length(trim(json_extract(action_intent_json, '$.operation'))) > 0
    AND json_type(action_intent_json, '$.arguments') = 'object'
  )
);

CREATE TRIGGER agent_run_action_intent_immutable
BEFORE UPDATE OF action_intent_json ON agent_run
WHEN NEW.action_intent_json IS NOT OLD.action_intent_json
BEGIN SELECT RAISE(ABORT, 'agent run action intent is immutable'); END;
