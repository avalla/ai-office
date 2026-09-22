CREATE TRIGGER pipeline_run_manifest_revision_tuple_insert
BEFORE INSERT ON pipeline_run
WHEN NOT EXISTS (
  SELECT 1
  FROM office_manifest_revision
  WHERE id = NEW.manifest_revision_id
    AND project_id = NEW.project_id
    AND revision = NEW.manifest_revision
)
BEGIN
  SELECT RAISE(ABORT, 'pipeline run manifest revision tuple is invalid');
END;

CREATE TRIGGER pipeline_run_manifest_revision_tuple_update
BEFORE UPDATE OF project_id, manifest_revision_id, manifest_revision ON pipeline_run
WHEN NOT EXISTS (
  SELECT 1
  FROM office_manifest_revision
  WHERE id = NEW.manifest_revision_id
    AND project_id = NEW.project_id
    AND revision = NEW.manifest_revision
)
BEGIN
  SELECT RAISE(ABORT, 'pipeline run manifest revision tuple is invalid');
END;
