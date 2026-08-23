DROP INDEX global_role_key_unique;
DROP INDEX global_role_status_name_idx;

CREATE TABLE global_role_v3 (
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  definition_json TEXT NOT NULL
    CHECK(json_valid(definition_json))
    CHECK(typeof(json_extract(definition_json, '$.key')) = 'text')
    CHECK(length(trim(json_extract(definition_json, '$.key'))) > 0),
  status TEXT NOT NULL CHECK(status IN ('active', 'deprecated')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(id, version)
);

INSERT INTO global_role_v3(
  id, name, version, definition_json, status, created_at, updated_at
)
SELECT id, name, version, definition_json, status, created_at, updated_at
FROM global_role;

DROP TABLE global_role;
ALTER TABLE global_role_v3 RENAME TO global_role;

CREATE UNIQUE INDEX global_role_key_version_unique
ON global_role(json_extract(definition_json, '$.key'), version);

CREATE INDEX global_role_latest_key_idx
ON global_role(json_extract(definition_json, '$.key'), version DESC);

CREATE INDEX global_role_status_name_idx
ON global_role(status, name, id, version);

CREATE TRIGGER global_role_identity_insert
BEFORE INSERT ON global_role
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM global_role
      WHERE id = NEW.id
        AND json_extract(definition_json, '$.key')
          <> json_extract(NEW.definition_json, '$.key')
    ) THEN RAISE(ABORT, 'global role id cannot change logical key')
    WHEN EXISTS (
      SELECT 1 FROM global_role
      WHERE json_extract(definition_json, '$.key')
          = json_extract(NEW.definition_json, '$.key')
        AND id <> NEW.id
    ) THEN RAISE(ABORT, 'global role key cannot change logical id')
    WHEN EXISTS (
      SELECT 1 FROM global_role
      WHERE id = NEW.id AND version >= NEW.version
    ) THEN RAISE(ABORT, 'global role version must be newer than history')
  END;
END;

CREATE TRIGGER global_role_revision_update
BEFORE UPDATE ON global_role
WHEN
  NEW.id <> OLD.id
  OR NEW.version <> OLD.version
  OR NEW.name <> OLD.name
  OR NEW.definition_json <> OLD.definition_json
  OR NEW.created_at <> OLD.created_at
  OR NOT (
    (NEW.status = OLD.status AND NEW.updated_at = OLD.updated_at)
    OR (OLD.status = 'active' AND NEW.status = 'deprecated')
  )
BEGIN
  SELECT RAISE(ABORT, 'global role revisions are immutable');
END;

CREATE TRIGGER global_role_revision_delete
BEFORE DELETE ON global_role
BEGIN
  SELECT RAISE(ABORT, 'global role revisions cannot be deleted');
END;
