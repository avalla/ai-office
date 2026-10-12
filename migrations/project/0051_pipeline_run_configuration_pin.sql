-- M16.5 Runtime activation, first slice (ADR-0026): pin pack configuration
-- identity on a pipeline run, additively, alongside its existing manifest
-- pins. Pipeline, stage and role selection are unchanged and stay
-- manifest-driven; these columns only record which pack configuration (if
-- any) was in effect when the run started. NULL means the project had no
-- pack selection when the run started -- true for every run before this
-- migration and for every project until a pack is adopted.
ALTER TABLE pipeline_run ADD COLUMN configuration_digest TEXT
  CHECK (configuration_digest IS NULL OR (
    configuration_digest GLOB 'sha256:*' AND length(configuration_digest) = 71
  ));
ALTER TABLE pipeline_run ADD COLUMN core_contract_version INTEGER
  CHECK (core_contract_version IS NULL OR core_contract_version >= 1);
ALTER TABLE pipeline_run ADD COLUMN binding_revision INTEGER
  CHECK (binding_revision IS NULL OR binding_revision >= 0);
ALTER TABLE pipeline_run ADD COLUMN definition_revision INTEGER
  CHECK (definition_revision IS NULL OR definition_revision >= 0);

-- The four pin columns are set together or omitted together; a run never
-- pins a partial configuration identity.
CREATE TRIGGER pipeline_run_configuration_pin_consistent
BEFORE INSERT ON pipeline_run
WHEN (
  (NEW.configuration_digest IS NULL) <> (NEW.core_contract_version IS NULL)
  OR (NEW.configuration_digest IS NULL) <> (NEW.binding_revision IS NULL)
  OR (NEW.configuration_digest IS NULL) <> (NEW.definition_revision IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'pipeline run configuration pin must be set together or omitted together');
END;

-- Pinned at insert, like every other run identity field; never revised.
CREATE TRIGGER pipeline_run_configuration_pin_immutable
BEFORE UPDATE OF
  configuration_digest, core_contract_version, binding_revision, definition_revision
ON pipeline_run
BEGIN
  SELECT RAISE(ABORT, 'pipeline run configuration pin is immutable');
END;

-- Exact source pack tuples (id, version, manifestDigest) pinned alongside
-- the digest above. One row per pack per relation (selected vs. resolved --
-- these can differ when a dependency pulls in a pack not explicitly
-- selected). Empty when configuration_digest is NULL.
CREATE TABLE pipeline_run_configuration_pack (
  pipeline_run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('selected', 'resolved')),
  pack_id TEXT NOT NULL CHECK (length(pack_id) > 0),
  pack_version TEXT NOT NULL CHECK (length(pack_version) > 0),
  manifest_digest TEXT NOT NULL
    CHECK (manifest_digest GLOB 'sha256:*' AND length(manifest_digest) = 71),
  PRIMARY KEY (pipeline_run_id, relation, pack_id),
  FOREIGN KEY (project_id, pipeline_run_id)
    REFERENCES pipeline_run(project_id, id) ON DELETE CASCADE
);

CREATE INDEX pipeline_run_configuration_pack_idx
ON pipeline_run_configuration_pack(project_id, pipeline_run_id);

CREATE TRIGGER pipeline_run_configuration_pack_prevent_update
BEFORE UPDATE ON pipeline_run_configuration_pack
BEGIN SELECT RAISE(ABORT, 'pipeline run configuration pack pin is immutable'); END;

-- Direct deletion is refused while the pinned run exists. The declared
-- ON DELETE CASCADE removes the tuples only after its parent run is gone, so
-- deleting a run or its project is not blocked.
CREATE TRIGGER pipeline_run_configuration_pack_prevent_delete
BEFORE DELETE ON pipeline_run_configuration_pack
WHEN EXISTS (
  SELECT 1 FROM pipeline_run
  WHERE project_id = OLD.project_id AND id = OLD.pipeline_run_id
)
BEGIN SELECT RAISE(ABORT, 'pipeline run configuration pack pin is append-only'); END;
