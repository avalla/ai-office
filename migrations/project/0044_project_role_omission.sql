-- GP-11 role omission: a project may disable a pack role as well as a prompt.
-- SQLite cannot alter a CHECK, so the table is rebuilt with every row, key and
-- constraint of 0042 preserved; only the operation/kind rule is widened.
CREATE TABLE project_definition_override_new (
  project_id TEXT NOT NULL REFERENCES project_definition_head(project_id) ON DELETE CASCADE,
  pack_id TEXT NOT NULL,
  pack_version TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  kind TEXT NOT NULL,
  local_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('replace','extend','disable')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  actor_id TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, pack_id, pack_version, manifest_digest, kind, local_id),
  CHECK (pack_id GLOB '[a-z]*.[a-z]*' AND pack_id NOT GLOB '*[^a-z0-9.-]*'),
  CHECK (pack_version GLOB '[0-9]*.[0-9]*.[0-9]*'
    AND pack_version NOT GLOB '*[^0-9.]*'
    AND length(pack_version) - length(replace(pack_version, '.', '')) = 2),
  CHECK (manifest_digest GLOB 'sha256:*' AND length(manifest_digest) = 71
    AND substr(manifest_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(local_id) > 0 AND local_id NOT GLOB '*[^A-Za-z0-9._-]*'
    AND substr(local_id, 1, 1) GLOB '[A-Za-z0-9]'),
  CHECK (kind IN ('roles','taskTypes','agents','artifactTypes','evidenceTypes','knowledge','prompts')),
  CHECK ((operation = 'disable' AND kind IN ('prompts','roles') AND payload_json IS NULL)
    OR (operation IN ('replace','extend') AND payload_json IS NOT NULL))
);

INSERT INTO project_definition_override_new(project_id, pack_id, pack_version, manifest_digest, kind, local_id, operation, revision, payload_json, actor_id, changed_at)
SELECT project_id, pack_id, pack_version, manifest_digest, kind, local_id, operation, revision, payload_json, actor_id, changed_at
FROM project_definition_override;

DROP TABLE project_definition_override;
ALTER TABLE project_definition_override_new RENAME TO project_definition_override;
