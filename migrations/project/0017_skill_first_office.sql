CREATE TABLE office_manifest_revision (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (
    typeof(revision) = 'integer' AND revision > 0
  ),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  manifest_json TEXT NOT NULL CHECK (
    json_valid(manifest_json)
    AND json_extract(manifest_json, '$.schemaVersion') = schema_version
  ),
  source_host TEXT NOT NULL CHECK (length(trim(source_host)) > 0),
  source_skill TEXT NOT NULL CHECK (source_skill = 'ai-office'),
  source_skill_version TEXT NOT NULL CHECK (
    length(trim(source_skill_version)) > 0
  ),
  applied_at TEXT NOT NULL,
  CHECK (json_extract(manifest_json, '$.provenance.host') = source_host),
  CHECK (json_extract(manifest_json, '$.provenance.skill') = source_skill),
  CHECK (
    json_extract(manifest_json, '$.provenance.skillVersion') =
      source_skill_version
  ),
  UNIQUE(project_id, revision)
);

CREATE INDEX office_manifest_project_revision_idx
ON office_manifest_revision(project_id, revision DESC);

CREATE TRIGGER office_manifest_revision_prevent_update
BEFORE UPDATE ON office_manifest_revision
BEGIN
  SELECT RAISE(ABORT, 'office manifest revisions are immutable');
END;
