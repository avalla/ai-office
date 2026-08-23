CREATE UNIQUE INDEX global_role_key_unique
ON global_role(json_extract(definition_json, '$.key'));

CREATE INDEX global_role_status_name_idx
ON global_role(status, name, id);

CREATE INDEX pattern_status_name_idx
ON pattern(status, name, id, version);

CREATE INDEX lesson_status_title_idx
ON lesson(status, title, id);
