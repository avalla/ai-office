-- Revision IDs are globally unique, while lineage is project-local. Reserve
-- ownership for both materialized revisions and shallow parent/base anchors so
-- an unknown ID cannot later be claimed by another project.
CREATE TEMP TABLE project_state_revision_identity_candidate (
  revision_id TEXT NOT NULL,
  project_id TEXT NOT NULL
);

INSERT INTO project_state_revision_identity_candidate(revision_id, project_id)
SELECT id, project_id FROM project_state_revision
UNION
SELECT parent_revision_id, project_id
FROM project_state_revision
WHERE parent_revision_id IS NOT NULL
UNION
SELECT base_revision_id, project_id
FROM project_state_head
WHERE base_revision_id IS NOT NULL;

CREATE TABLE project_state_revision_identity (
  revision_id TEXT PRIMARY KEY CHECK (length(trim(revision_id)) > 0),
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  UNIQUE(revision_id, project_id)
);

INSERT INTO project_state_revision_identity(revision_id, project_id)
SELECT revision_id, MIN(project_id)
FROM project_state_revision_identity_candidate
GROUP BY revision_id;

CREATE INDEX project_state_revision_identity_project_idx
ON project_state_revision_identity(project_id, revision_id);

CREATE TABLE project_state_revision_owned (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  parent_revision_id TEXT,
  state_checksum TEXT NOT NULL CHECK (
    length(state_checksum) = 64
    AND state_checksum NOT GLOB '*[^0-9a-f]*'
  ),
  origin TEXT NOT NULL CHECK (origin IN ('local_snapshot', 'portable_import')),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, id),
  FOREIGN KEY(id, project_id)
    REFERENCES project_state_revision_identity(revision_id, project_id)
      ON DELETE CASCADE,
  FOREIGN KEY(parent_revision_id, project_id)
    REFERENCES project_state_revision_identity(revision_id, project_id)
      ON DELETE CASCADE
);

INSERT INTO project_state_revision_owned(
  id, project_id, parent_revision_id, state_checksum, origin, created_at
)
SELECT id, project_id, parent_revision_id, state_checksum, origin, created_at
FROM project_state_revision;

CREATE TABLE project_state_head_owned (
  project_id TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL,
  base_revision_id TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id, revision_id)
    REFERENCES project_state_revision_owned(project_id, id)
      ON DELETE CASCADE,
  FOREIGN KEY(base_revision_id, project_id)
    REFERENCES project_state_revision_identity(revision_id, project_id)
      ON DELETE CASCADE
);

INSERT INTO project_state_head_owned(
  project_id, revision_id, base_revision_id, updated_at
)
SELECT project_id, revision_id, base_revision_id, updated_at
FROM project_state_head;

DROP TABLE project_state_head;
DROP TABLE project_state_revision;
ALTER TABLE project_state_revision_owned RENAME TO project_state_revision;
ALTER TABLE project_state_head_owned RENAME TO project_state_head;

CREATE INDEX project_state_revision_project_created_idx
ON project_state_revision(project_id, created_at, id);

-- Reservations happen in the same SQLite statement that introduces a
-- materialized revision or shallow reference. A conflict therefore fails the
-- statement without leaving a partial reservation.
CREATE TRIGGER project_state_revision_reserve_identity
BEFORE INSERT ON project_state_revision
BEGIN
  INSERT INTO project_state_revision_identity(revision_id, project_id)
  SELECT NEW.id, NEW.project_id
  WHERE NOT EXISTS (
    SELECT 1 FROM project_state_revision_identity WHERE revision_id = NEW.id
  );

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM project_state_revision_identity
    WHERE revision_id = NEW.id AND project_id <> NEW.project_id
  ) THEN RAISE(ABORT, 'project state revision identity belongs to another project') END;

  SELECT CASE WHEN NEW.parent_revision_id = NEW.id
    THEN RAISE(ABORT, 'project state revision cannot parent itself') END;

  INSERT INTO project_state_revision_identity(revision_id, project_id)
  SELECT NEW.parent_revision_id, NEW.project_id
  WHERE NEW.parent_revision_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM project_state_revision_identity
      WHERE revision_id = NEW.parent_revision_id
    );

  SELECT CASE WHEN NEW.parent_revision_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM project_state_revision_identity
    WHERE revision_id = NEW.parent_revision_id
      AND project_id <> NEW.project_id
  ) THEN RAISE(ABORT, 'project state parent identity belongs to another project') END;
END;

CREATE TRIGGER project_state_revision_lineage_immutable
BEFORE UPDATE OF id, project_id, parent_revision_id, state_checksum, created_at
ON project_state_revision
BEGIN
  SELECT RAISE(ABORT, 'project state revision lineage is immutable');
END;

CREATE TRIGGER project_state_head_reserve_base_identity_insert
BEFORE INSERT ON project_state_head
WHEN NEW.base_revision_id IS NOT NULL
BEGIN
  INSERT INTO project_state_revision_identity(revision_id, project_id)
  SELECT NEW.base_revision_id, NEW.project_id
  WHERE NOT EXISTS (
    SELECT 1 FROM project_state_revision_identity
    WHERE revision_id = NEW.base_revision_id
  );

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM project_state_revision_identity
    WHERE revision_id = NEW.base_revision_id
      AND project_id <> NEW.project_id
  ) THEN RAISE(ABORT, 'project state base identity belongs to another project') END;
END;

CREATE TRIGGER project_state_head_reserve_base_identity_update
BEFORE UPDATE OF project_id, base_revision_id ON project_state_head
WHEN NEW.base_revision_id IS NOT NULL
BEGIN
  INSERT INTO project_state_revision_identity(revision_id, project_id)
  SELECT NEW.base_revision_id, NEW.project_id
  WHERE NOT EXISTS (
    SELECT 1 FROM project_state_revision_identity
    WHERE revision_id = NEW.base_revision_id
  );

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM project_state_revision_identity
    WHERE revision_id = NEW.base_revision_id
      AND project_id <> NEW.project_id
  ) THEN RAISE(ABORT, 'project state base identity belongs to another project') END;
END;

-- The migration runner records the version in schema_migration in the same
-- transaction after executing this file. Guard that final statement so Bun's
-- multi-statement exec cannot hide an intermediate constraint failure.
CREATE TEMP TRIGGER project_state_revision_identity_migration_guard
BEFORE INSERT ON schema_migration
WHEN NEW.version = '0024_project_revision_identity.sql'
  AND EXISTS (
    SELECT 1
    FROM project_state_revision_identity_candidate
    GROUP BY revision_id
    HAVING COUNT(DISTINCT project_id) <> 1
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'contradictory project state revision identity ownership'
  );
END;

CREATE TEMP TRIGGER project_state_revision_identity_migration_cleanup
AFTER INSERT ON schema_migration
WHEN NEW.version = '0024_project_revision_identity.sql'
BEGIN
  DELETE FROM project_state_revision_identity_candidate;
END;
