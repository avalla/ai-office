-- GP-05 stores only explicit portable selection. Installed artifacts and their
-- provenance stay in the host-local catalog.
CREATE TABLE project_pack_binding (
  project_id TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  configuration_revision INTEGER NOT NULL DEFAULT 0
    CHECK (configuration_revision >= 0),
  changed_at TEXT
);

CREATE TABLE project_pack_binding_pack (
  project_id TEXT NOT NULL REFERENCES project_pack_binding(project_id) ON DELETE CASCADE,
  pack_id TEXT NOT NULL,
  pack_version TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  PRIMARY KEY (project_id, pack_id),
  CHECK (length(pack_id) > 0 AND length(pack_version) > 0),
  CHECK (manifest_digest GLOB 'sha256:*' AND length(manifest_digest) = 71)
);

INSERT INTO project_pack_binding(project_id, configuration_revision)
SELECT id, 0 FROM project;
