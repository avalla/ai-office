ALTER TABLE role ADD COLUMN guidance_text TEXT NOT NULL DEFAULT ''
  CHECK (length(guidance_text) <= 65536);
ALTER TABLE role ADD COLUMN guidance_version INTEGER NOT NULL DEFAULT 1
  CHECK (guidance_version > 0);

ALTER TABLE agent_run ADD COLUMN role_guidance_json TEXT
  CHECK (role_guidance_json IS NULL OR (
    json_valid(role_guidance_json)
    AND json_type(role_guidance_json) = 'object'
    AND json_type(role_guidance_json, '$.version') = 'integer'
    AND json_type(role_guidance_json, '$.text') = 'text'
    AND json_extract(role_guidance_json, '$.version') > 0
    AND length(json_extract(role_guidance_json, '$.text')) <= 65536
  ));

CREATE TRIGGER agent_run_role_guidance_immutable
BEFORE UPDATE OF role_guidance_json ON agent_run
WHEN NEW.role_guidance_json IS NOT OLD.role_guidance_json
BEGIN SELECT RAISE(ABORT, 'agent run role guidance is immutable'); END;
